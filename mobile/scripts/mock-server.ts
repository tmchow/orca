#!/usr/bin/env npx tsx
// Why: standalone mock WebSocket server for developing the mobile app without
// a running Orca desktop instance. Responds to the same RPC methods the real
// runtime exposes, with realistic fake data.
import { WebSocketServer, type WebSocket } from 'ws'

const PORT = Number(process.env.PORT) || 6768
const AUTH_TOKEN = 'mock-device-token'

const FAKE_WORKTREES = [
  {
    worktreeId: 'repo-1::/home/user/projects/acme-api',
    repoId: 'repo-1',
    repo: 'acme-api',
    path: '/home/user/projects/acme-api',
    branch: 'feature/auth-refactor',
    linkedIssue: 42,
    unread: true,
    liveTerminalCount: 2,
    hasAttachedPty: true,
    lastOutputAt: Date.now() - 5000,
    preview: '$ claude "refactor the auth module"'
  },
  {
    worktreeId: 'repo-1::/home/user/projects/acme-web',
    repoId: 'repo-1',
    repo: 'acme-web',
    path: '/home/user/projects/acme-web',
    branch: 'main',
    linkedIssue: null,
    unread: false,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    lastOutputAt: Date.now() - 60000,
    preview: '$ npm test\nAll tests passed.'
  }
]

const FAKE_TERMINALS = [
  {
    handle: 'term-1',
    worktreeId: 'repo-1::/home/user/projects/acme-api',
    title: 'Claude — auth refactor',
    isActive: true,
    hasRunningProcess: true
  },
  {
    handle: 'term-2',
    worktreeId: 'repo-1::/home/user/projects/acme-api',
    title: 'zsh',
    isActive: false,
    hasRunningProcess: false
  }
]

const FAKE_SCROLLBACK = [
  '$ claude "refactor the auth module to use JWT tokens"',
  '',
  '⏳ Working on it...',
  '',
  "I'll refactor the auth module. Here's my plan:",
  '1. Replace session-based auth with JWT',
  '2. Add token refresh endpoint',
  '3. Update middleware',
  '',
  'Let me start by reading the current auth module...',
  ''
].join('\n')

const STREAMING_CHUNKS = [
  'Reading src/auth/middleware.ts...\n',
  'Reading src/auth/session.ts...\n',
  '\nI see the current implementation uses express-session.\n',
  "I'll replace it with jsonwebtoken.\n",
  '\nUpdating src/auth/middleware.ts...\n'
]

type RpcRequest = {
  id: string
  method: string
  deviceToken?: string
  params?: Record<string, unknown>
}

type RpcResponse = {
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
  streaming?: true
  _meta: { runtimeId: string }
}

function success(id: string, result: unknown, streaming?: boolean): RpcResponse {
  const resp: RpcResponse = { id, ok: true, result, _meta: { runtimeId: 'mock-runtime' } }
  if (streaming) {
    resp.streaming = true
  }
  return resp
}

function error(id: string, code: string, message: string): RpcResponse {
  return { id, ok: false, error: { code, message }, _meta: { runtimeId: 'mock-runtime' } }
}

function handleRequest(request: RpcRequest, ws: WebSocket): void {
  if (request.deviceToken !== AUTH_TOKEN) {
    ws.send(JSON.stringify(error(request.id, 'unauthorized', 'Invalid device token')))
    return
  }

  switch (request.method) {
    case 'status.get':
      ws.send(
        JSON.stringify(
          success(request.id, {
            runtimeId: 'mock-runtime',
            graphStatus: 'ready',
            windowCount: 1,
            tabCount: 2,
            terminalCount: 2
          })
        )
      )
      break

    case 'worktree.ps':
      ws.send(
        JSON.stringify(
          success(request.id, {
            worktrees: FAKE_WORKTREES,
            totalCount: FAKE_WORKTREES.length,
            truncated: false
          })
        )
      )
      break

    case 'terminal.list':
      ws.send(
        JSON.stringify(
          success(request.id, {
            terminals: FAKE_TERMINALS,
            totalCount: FAKE_TERMINALS.length,
            truncated: false
          })
        )
      )
      break

    case 'terminal.subscribe': {
      ws.send(
        JSON.stringify(
          success(request.id, { type: 'scrollback', lines: FAKE_SCROLLBACK, truncated: false })
        )
      )

      let chunkIndex = 0
      const interval = setInterval(() => {
        if (chunkIndex >= STREAMING_CHUNKS.length || ws.readyState !== ws.OPEN) {
          clearInterval(interval)
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(success(request.id, { type: 'end' })))
          }
          return
        }
        ws.send(
          JSON.stringify(
            success(request.id, { type: 'data', chunk: STREAMING_CHUNKS[chunkIndex] }, true)
          )
        )
        chunkIndex++
      }, 500)
      break
    }

    case 'terminal.send':
      ws.send(JSON.stringify(success(request.id, { send: { handle: 'term-1', ok: true } })))
      break

    case 'terminal.unsubscribe':
      ws.send(JSON.stringify(success(request.id, { unsubscribed: true })))
      break

    default:
      ws.send(
        JSON.stringify(error(request.id, 'method_not_found', `Unknown method: ${request.method}`))
      )
  }
}

const wss = new WebSocketServer({ port: PORT })

wss.on('connection', (ws) => {
  console.log('[mock] Client connected')

  ws.on('message', (data) => {
    const msg = typeof data === 'string' ? data : data.toString('utf-8')
    let request: RpcRequest
    try {
      request = JSON.parse(msg) as RpcRequest
    } catch {
      ws.send(JSON.stringify(error('unknown', 'bad_request', 'Invalid JSON')))
      return
    }

    console.log(`[mock] ${request.method} (id: ${request.id})`)
    handleRequest(request, ws)
  })

  ws.on('close', () => {
    console.log('[mock] Client disconnected')
  })

  ws.on('error', () => {
    ws.close()
  })
})

console.log(`[mock] Orca mock server listening on ws://localhost:${PORT}`)
console.log(`[mock] Auth token: ${AUTH_TOKEN}`)
console.log(`[mock] Try: npx wscat -c ws://localhost:${PORT}`)
console.log(`[mock] Then send: {"id":"1","deviceToken":"${AUTH_TOKEN}","method":"status.get"}`)
