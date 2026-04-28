import { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../schemas'

const TerminalHandle = z.object({
  terminal: requiredString('Missing terminal handle')
})

const TerminalListParams = z.object({
  worktree: OptionalString,
  limit: OptionalFiniteNumber
})

const TerminalResolveActive = z.object({
  worktree: OptionalString
})

const TerminalRead = TerminalHandle.extend({
  cursor: z
    .unknown()
    .transform((value) => {
      if (value === undefined) {
        return undefined
      }
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        return Number.NaN
      }
      return value
    })
    .pipe(
      z
        .number()
        .optional()
        .refine((v) => v === undefined || Number.isFinite(v), {
          message: 'Cursor must be a non-negative integer'
        })
    )
})

// Why: the legacy handler allowed `title: string | null` and rejected every
// other shape (including `undefined`) with a specific message, which is how
// the CLI signals an intentional "reset". Preserve that distinction exactly.
const TerminalRename = TerminalHandle.extend({
  title: z.custom<string | null>((value) => value === null || typeof value === 'string', {
    message: 'Missing --title (pass empty string or null to reset)'
  })
})

const TerminalSend = TerminalHandle.extend({
  text: OptionalString,
  enter: z.unknown().optional(),
  interrupt: z.unknown().optional()
})

const TerminalWait = TerminalHandle.extend({
  for: z.custom<'exit' | 'tui-idle'>((value) => value === 'exit' || value === 'tui-idle', {
    message: 'Invalid --for value. Supported: exit, tui-idle'
  }),
  timeoutMs: OptionalFiniteNumber
})

const TerminalCreateParams = z.object({
  worktree: OptionalString,
  command: OptionalString,
  title: OptionalString
})

const TerminalSplit = TerminalHandle.extend({
  direction: z
    .unknown()
    .transform((v) => (v === 'vertical' || v === 'horizontal' ? v : undefined))
    .pipe(z.enum(['vertical', 'horizontal']).optional()),
  command: OptionalString
})

const TerminalStop = z.object({
  worktree: requiredString('Missing worktree selector')
})

const TerminalSubscribe = TerminalHandle.extend({})

const TerminalUnsubscribe = z.object({
  subscriptionId: requiredString('Missing subscription ID')
})

export const TERMINAL_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'terminal.list',
    params: TerminalListParams,
    handler: async (params, { runtime }) => runtime.listTerminals(params.worktree, params.limit)
  }),
  defineMethod({
    name: 'terminal.resolveActive',
    params: TerminalResolveActive,
    handler: async (params, { runtime }) => ({
      handle: await runtime.resolveActiveTerminal(params.worktree)
    })
  }),
  defineMethod({
    name: 'terminal.show',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      terminal: await runtime.showTerminal(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.read',
    params: TerminalRead,
    handler: async (params, { runtime }) => ({
      terminal: await runtime.readTerminal(params.terminal, { cursor: params.cursor })
    })
  }),
  defineMethod({
    name: 'terminal.rename',
    params: TerminalRename,
    handler: async (params, { runtime }) => ({
      rename: await runtime.renameTerminal(params.terminal, params.title || null)
    })
  }),
  defineMethod({
    name: 'terminal.send',
    params: TerminalSend,
    handler: async (params, { runtime }) => ({
      send: await runtime.sendTerminal(params.terminal, {
        text: params.text,
        enter: params.enter === true,
        interrupt: params.interrupt === true
      })
    })
  }),
  defineMethod({
    name: 'terminal.wait',
    params: TerminalWait,
    handler: async (params, { runtime }) => ({
      wait: await runtime.waitForTerminal(params.terminal, {
        condition: params.for,
        timeoutMs: params.timeoutMs
      })
    })
  }),
  defineMethod({
    name: 'terminal.create',
    params: TerminalCreateParams,
    handler: async (params, { runtime }) => ({
      terminal: await runtime.createTerminal(params.worktree, {
        command: params.command,
        title: params.title
      })
    })
  }),
  defineMethod({
    name: 'terminal.split',
    params: TerminalSplit,
    handler: async (params, { runtime }) => ({
      split: await runtime.splitTerminal(params.terminal, {
        direction: params.direction,
        command: params.command
      })
    })
  }),
  defineMethod({
    name: 'terminal.stop',
    params: TerminalStop,
    handler: async (params, { runtime }) => runtime.stopTerminalsForWorktree(params.worktree)
  }),
  defineMethod({
    name: 'terminal.focus',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      focus: await runtime.focusTerminal(params.terminal)
    })
  }),
  defineMethod({
    name: 'terminal.close',
    params: TerminalHandle,
    handler: async (params, { runtime }) => ({
      close: await runtime.closeTerminal(params.terminal)
    })
  }),
  // Why: terminal.subscribe streams live terminal output over WebSocket.
  // It sends initial scrollback, then live data chunks as they arrive.
  // Only works over streaming-capable transports (WebSocket, not Unix socket).
  defineStreamingMethod({
    name: 'terminal.subscribe',
    params: TerminalSubscribe,
    handler: async (params, { runtime }, emit) => {
      const read = await runtime.readTerminal(params.terminal)
      const leaf = runtime.resolveLeafForHandle(params.terminal)
      const serialized = leaf?.ptyId ? await runtime.serializeTerminalBuffer(leaf.ptyId) : null
      const size = leaf?.ptyId ? runtime.getTerminalSize(leaf.ptyId) : null
      emit({
        type: 'scrollback',
        lines: read.tail,
        truncated: read.truncated,
        serialized: serialized?.data,
        cols: serialized?.cols ?? size?.cols,
        rows: serialized?.rows ?? size?.rows
      })

      if (!leaf?.ptyId) {
        emit({ type: 'end' })
        return
      }

      // Why: the handler returns a Promise that never resolves (until
      // unsubscribe or disconnect). The emit callback pushes data chunks
      // as they arrive. Cleanup happens via the unsubscribe mechanism or
      // connection-scoped cleanup in the transport layer.
      await new Promise<void>((resolve) => {
        const unsubscribe = runtime.subscribeToTerminalData(leaf.ptyId!, (data) => {
          emit({ type: 'data', chunk: data })
        })

        // Why: store the cleanup function so terminal.unsubscribe and
        // connection-close cleanup can call it.
        const subscriptionId = params.terminal
        runtime.registerSubscriptionCleanup(subscriptionId, () => {
          unsubscribe()
          emit({ type: 'end' })
          resolve()
        })
      })
    }
  }),
  defineMethod({
    name: 'terminal.unsubscribe',
    params: TerminalUnsubscribe,
    handler: async (params, { runtime }) => {
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
