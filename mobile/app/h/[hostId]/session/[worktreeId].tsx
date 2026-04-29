import { useState, useEffect, useRef, useCallback } from 'react'
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ArrowUp, ChevronLeft, Monitor, Plus, Smartphone } from 'lucide-react-native'
import { connect, type RpcClient } from '../../../../src/transport/rpc-client'
import { loadHosts } from '../../../../src/transport/host-store'
import type { ConnectionState, RpcSuccess } from '../../../../src/transport/types'
import { triggerMediumImpact } from '../../../../src/platform/haptics'
import {
  TerminalWebView,
  type TerminalWebViewHandle
} from '../../../../src/terminal/TerminalWebView'
import { StatusDot } from '../../../../src/components/StatusDot'
import { ActionSheetModal } from '../../../../src/components/ActionSheetModal'
import { TextInputModal } from '../../../../src/components/TextInputModal'
import { colors, spacing, radii, typography } from '../../../../src/theme/mobile-theme'

type Terminal = {
  handle: string
  title: string
  isActive: boolean
}

type TerminalCreateResult = {
  terminal: {
    handle: string
    title: string | null
  }
}

type AccessoryKey = { label: string; bytes: string; accessibilityLabel?: string }

const ACCESSORY_KEYS: AccessoryKey[] = [
  { label: 'Esc', bytes: '\x1b' },
  { label: 'Tab', bytes: '\t' },
  { label: '↑', bytes: '\x1b[A' },
  { label: '↓', bytes: '\x1b[B' },
  { label: '←', bytes: '\x1b[D' },
  { label: '→', bytes: '\x1b[C' },
  { label: 'Ctrl+C', bytes: '\x03', accessibilityLabel: 'Interrupt terminal' },
  { label: 'Ctrl+D', bytes: '\x04', accessibilityLabel: 'Send EOF' }
]

// Why: persists fitted-handle sets across component remounts (e.g. navigating
// away and back). React state resets on unmount, but we need to remember which
// terminals were phone-fitted so we can auto-refit them on return.
const persistedFittedHandles = new Map<string, Set<string>>()

const STATUS_LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  handshaking: 'Securing',
  connected: 'Connected',
  disconnected: 'Disconnected',
  reconnecting: 'Reconnecting',
  'auth-failed': 'Auth failed'
}

function TerminalPaneView({
  handle,
  active,
  onRef
}: {
  handle: string
  active: boolean
  onRef: (handle: string, ref: TerminalWebViewHandle | null) => void
}) {
  const setRef = useCallback(
    (ref: TerminalWebViewHandle | null) => {
      onRef(handle, ref)
    },
    [handle, onRef]
  )

  return (
    <View
      pointerEvents={active ? 'auto' : 'none'}
      style={[styles.terminalPane, !active && styles.terminalPaneHidden]}
    >
      <TerminalWebView ref={setRef} style={styles.terminalWebView} />
    </View>
  )
}

export default function SessionScreen() {
  const {
    hostId,
    worktreeId,
    name: worktreeName,
    created
  } = useLocalSearchParams<{
    hostId: string
    worktreeId: string
    name?: string
    created?: string
  }>()
  const router = useRouter()
  const [client, setClient] = useState<RpcClient | null>(null)
  const [connState, setConnState] = useState<ConnectionState>('disconnected')
  const [terminals, setTerminals] = useState<Terminal[]>([])
  const [terminalsLoaded, setTerminalsLoaded] = useState(false)
  const [input, setInput] = useState('')
  const [activeHandle, setActiveHandle] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [actionTarget, setActionTarget] = useState<Terminal | null>(null)
  const [renameTarget, setRenameTarget] = useState<Terminal | null>(null)
  const [fittedHandles, setFittedHandles] = useState<Set<string>>(
    () => persistedFittedHandles.get(worktreeId!) ?? new Set()
  )
  const [fitPending, setFitPending] = useState(false)
  const deviceTokenRef = useRef<string | null>(null)
  const fittedHandlesRef = useRef<Set<string>>(fittedHandles)
  fittedHandlesRef.current = fittedHandles
  // Why: wraps setFittedHandles to also persist to the module-level map,
  // so fitted state survives component remount when navigating away and back.
  const updateFittedHandles = useCallback(
    (updater: (prev: Set<string>) => Set<string>) => {
      setFittedHandles((prev) => {
        const next = updater(prev)
        persistedFittedHandles.set(worktreeId!, next)
        return next
      })
    },
    [worktreeId]
  )
  // Why: the subscribe callback captures fitPending via closure, but needs
  // the current value to avoid re-fitting while a fit is already in progress.
  const fitPendingRef = useRef(false)
  fitPendingRef.current = fitPending
  // Why: tracks terminals the user explicitly restored to desktop size.
  // Without this, switching away and back would auto-fit them again.
  const manuallyRestoredRef = useRef<Set<string>>(new Set())
  const terminalRefs = useRef<Map<string, TerminalWebViewHandle>>(new Map())
  const terminalUnsubsRef = useRef<Map<string, () => void>>(new Map())
  const subscribingHandlesRef = useRef<Set<string>>(new Set())
  const initializedHandlesRef = useRef<Set<string>>(new Set())
  const locallyCreatedHandlesRef = useRef<Set<string>>(new Set())
  const activeHandleRef = useRef<string | null>(null)
  const subscribeSeqRef = useRef<Map<string, number>>(new Map())

  const canSend = connState === 'connected' && activeHandle != null

  const getTerminalRef = useCallback((handle: string | null) => {
    return handle ? terminalRefs.current.get(handle) : undefined
  }, [])

  const unsubscribeTerminal = useCallback((handle: string) => {
    terminalUnsubsRef.current.get(handle)?.()
    terminalUnsubsRef.current.delete(handle)
    subscribingHandlesRef.current.delete(handle)
    subscribeSeqRef.current.set(handle, (subscribeSeqRef.current.get(handle) ?? 0) + 1)
  }, [])

  const clearTerminalCache = useCallback(() => {
    for (const unsub of terminalUnsubsRef.current.values()) {
      unsub()
    }
    terminalUnsubsRef.current.clear()
    subscribingHandlesRef.current.clear()
    initializedHandlesRef.current.clear()
    locallyCreatedHandlesRef.current.clear()
    subscribeSeqRef.current.clear()
    for (const term of terminalRefs.current.values()) {
      term.clear()
    }
  }, [])

  // Why: after a fit/restore resize the PTY grid changes, so we must
  // resubscribe to get a fresh scrollback snapshot at the new geometry.
  // We skip terminal.focus to avoid a race where the desktop renderer
  // auto-fits the pane back to desktop dimensions before the override
  // takes effect.
  const resubscribeWithoutFocus = useCallback(
    (handle: string) => {
      unsubscribeTerminal(handle)
      if (!client) return

      const term = getTerminalRef(handle)
      term?.clear()
      initializedHandlesRef.current.delete(handle)
      subscribingHandlesRef.current.add(handle)
      const seq = (subscribeSeqRef.current.get(handle) ?? 0) + 1
      subscribeSeqRef.current.set(handle, seq)

      void (async () => {
        if (subscribeSeqRef.current.get(handle) !== seq) {
          subscribingHandlesRef.current.delete(handle)
          return
        }

        const unsub = client.subscribe('terminal.subscribe', { terminal: handle }, (result) => {
          if (subscribeSeqRef.current.get(handle) !== seq) {
            return
          }
          const data = result as Record<string, unknown>
          if (data.type === 'scrollback') {
            const cols = (data.cols as number) || 80
            const rows = (data.rows as number) || 24
            const initialData =
              typeof data.serialized === 'string' && data.serialized.length > 0
                ? data.serialized
                : ''
            getTerminalRef(handle)?.init(cols, rows, initialData)
            initializedHandlesRef.current.add(handle)
          } else if (data.type === 'data') {
            const chunk = data.chunk as string
            getTerminalRef(handle)?.write(chunk)
          }
        })

        if (subscribeSeqRef.current.get(handle) === seq) {
          terminalUnsubsRef.current.set(handle, unsub)
        } else {
          unsub()
        }
        subscribingHandlesRef.current.delete(handle)
      })()
    },
    [client, getTerminalRef, unsubscribeTerminal]
  )

  // Why: extracted so both manual "Fit to Phone" and auto-fit-on-subscribe
  // can share the same measure → resize → resubscribe logic. Takes explicit
  // handle/rpcClient to avoid stale closure issues from subscribe callbacks.
  const fitToPhoneCore = useCallback(
    async (handle: string, rpcClient: RpcClient) => {
      const clientId = deviceTokenRef.current
      if (!clientId) return

      const dims = await getTerminalRef(handle)?.measureFitDimensions()
      if (!dims) return

      const response = await rpcClient.sendRequest('terminal.resizeForClient', {
        terminal: handle,
        mode: 'mobile-fit',
        cols: dims.cols,
        rows: dims.rows,
        clientId
      })
      if (!response.ok) return

      updateFittedHandles((prev) => new Set(prev).add(handle))
      resubscribeWithoutFocus(handle)
      setTimeout(() => getTerminalRef(handle)?.resetZoom(), 500)
    },
    [getTerminalRef, resubscribeWithoutFocus, updateFittedHandles]
  )

  const handleFitToPhone = useCallback(async () => {
    if (!client || !activeHandle || fitPending) return

    manuallyRestoredRef.current.delete(activeHandle)
    setFitPending(true)
    try {
      await fitToPhoneCore(activeHandle, client)
    } finally {
      setFitPending(false)
    }
  }, [client, activeHandle, fitPending, fitToPhoneCore])

  const handleRestoreDesktopSize = useCallback(async () => {
    if (!client || !activeHandle) return
    const handle = activeHandle
    const clientId = deviceTokenRef.current
    if (!clientId) return

    try {
      const response = await client.sendRequest('terminal.resizeForClient', {
        terminal: handle,
        mode: 'restore',
        clientId
      })
      if (!response.ok) return

      manuallyRestoredRef.current.add(handle)
      updateFittedHandles((prev) => {
        const next = new Set(prev)
        next.delete(handle)
        return next
      })
      resubscribeWithoutFocus(handle)
      setTimeout(() => getTerminalRef(handle)?.resetZoom(), 500)
    } catch {
      // Restore failed — keep current state.
    }
  }, [client, activeHandle, getTerminalRef, resubscribeWithoutFocus, updateFittedHandles])

  useEffect(() => {
    let rpcClient: RpcClient | null = null

    void (async () => {
      const hosts = await loadHosts()
      const host = hosts.find((h) => h.id === hostId)
      if (!host) return

      deviceTokenRef.current = host.deviceToken
      rpcClient = connect(host.endpoint, host.deviceToken, host.publicKeyB64, setConnState)
      setClient(rpcClient)
    })()

    return () => {
      clearTerminalCache()
      rpcClient?.close()
    }
  }, [clearTerminalCache, hostId])

  useEffect(() => {
    clearTerminalCache()
    activeHandleRef.current = null
    setActiveHandle(null)
    setTerminals([])
  }, [clearTerminalCache, worktreeId])

  const subscribeToTerminal = useCallback(
    (handle: string) => {
      if (!client) {
        return
      }
      if (terminalUnsubsRef.current.has(handle)) {
        return
      }
      if (subscribingHandlesRef.current.has(handle)) {
        return
      }
      if (!getTerminalRef(handle)) {
        return
      }

      subscribingHandlesRef.current.add(handle)
      const seq = (subscribeSeqRef.current.get(handle) ?? 0) + 1
      subscribeSeqRef.current.set(handle, seq)
      const rpcClient = client

      // Why: phone-fitted terminals skip terminal.focus (which would cause
      // the desktop to auto-resize back to desktop dimensions). Instead we
      // subscribe directly and compare the scrollback geometry against the
      // phone dimensions. If they match, the content is already correct and
      // we avoid a resize→SIGWINCH→redraw cycle that strips TUI colors.
      // If they don't match (desktop auto-restored while we were away),
      // we refit — but only then.
      const shouldAutoFit =
        !manuallyRestoredRef.current.has(handle) && fittedHandlesRef.current.has(handle)

      void (async () => {
        if (
          !shouldAutoFit &&
          activeHandleRef.current === handle &&
          !locallyCreatedHandlesRef.current.has(handle)
        ) {
          try {
            await client.sendRequest('terminal.focus', { terminal: handle })
            await new Promise((resolve) => setTimeout(resolve, 150))
          } catch {
            // Continue with best-effort streaming if desktop focus is unavailable.
          }
        }

        if (subscribeSeqRef.current.get(handle) !== seq) {
          subscribingHandlesRef.current.delete(handle)
          return
        }

        const unsub = client.subscribe('terminal.subscribe', { terminal: handle }, (result) => {
          if (subscribeSeqRef.current.get(handle) !== seq) {
            return
          }
          const data = result as Record<string, unknown>
          if (data.type === 'scrollback') {
            if (initializedHandlesRef.current.has(handle)) {
              return
            }
            const cols = (data.cols as number) || 80
            const rows = (data.rows as number) || 24
            const initialData =
              typeof data.serialized === 'string' && data.serialized.length > 0
                ? data.serialized
                : ''
            getTerminalRef(handle)?.init(cols, rows, initialData)
            initializedHandlesRef.current.add(handle)
            locallyCreatedHandlesRef.current.delete(handle)
            // Why: only refit if the scrollback geometry doesn't match
            // the phone WebView dimensions. This avoids unnecessary
            // resize→SIGWINCH cycles on tab switches when the terminal
            // is already at the correct phone size.
            if (shouldAutoFit && !fitPendingRef.current) {
              void (async () => {
                const dims = await getTerminalRef(handle)?.measureFitDimensions()
                if (!dims) return
                if (cols !== dims.cols || rows !== dims.rows) {
                  if (
                    activeHandleRef.current === handle &&
                    subscribeSeqRef.current.get(handle) === seq
                  ) {
                    void fitToPhoneCore(handle, rpcClient)
                  }
                }
              })()
            }
          } else if (data.type === 'data') {
            const chunk = data.chunk as string
            getTerminalRef(handle)?.write(chunk)
          }
        })

        if (subscribeSeqRef.current.get(handle) === seq) {
          terminalUnsubsRef.current.set(handle, unsub)
        } else {
          unsub()
        }
        subscribingHandlesRef.current.delete(handle)
      })()
    },
    [client, fitToPhoneCore, getTerminalRef]
  )

  const fetchTerminals = useCallback(
    async (opts: { allowEmptyLoaded?: boolean } = {}) => {
      if (!client) return
      const allowEmptyLoaded = opts.allowEmptyLoaded ?? true

      try {
        const response = await client.sendRequest('terminal.list', {
          worktree: `id:${worktreeId}`
        })
        if (response.ok) {
          const result = (response as RpcSuccess).result as { terminals: Terminal[] }
          const liveHandles = new Set(result.terminals.map((terminal) => terminal.handle))
          for (const handle of Array.from(terminalUnsubsRef.current.keys())) {
            if (!liveHandles.has(handle)) {
              unsubscribeTerminal(handle)
              terminalRefs.current.delete(handle)
              initializedHandlesRef.current.delete(handle)
            }
          }
          const current = activeHandleRef.current
          if (current && result.terminals.length === 0) {
            return
          }
          if (result.terminals.length === 0 && !allowEmptyLoaded) {
            setTerminals([])
            return
          }

          setTerminals(result.terminals)
          setTerminalsLoaded(true)

          if (!current || !result.terminals.some((t) => t.handle === current)) {
            const active = result.terminals.find((t) => t.isActive) ?? result.terminals[0]
            if (active) {
              activeHandleRef.current = active.handle
              setActiveHandle(active.handle)
              subscribeToTerminal(active.handle)
            } else {
              activeHandleRef.current = null
              setActiveHandle(null)
            }
          }
        }
      } catch {
        // Failed to list terminals
      }
    },
    [client, worktreeId, subscribeToTerminal, unsubscribeTerminal]
  )

  useEffect(() => {
    if (connState === 'connected') {
      setTerminalsLoaded(false)
      void (async () => {
        // Why: worktree.create already asks the desktop renderer to activate
        // with startup/setup payloads. A second plain activation can race ahead
        // and create a blank first terminal before those payloads are applied.
        if (client && created !== '1') {
          await client
            .sendRequest('worktree.activate', {
              worktree: `id:${worktreeId}`
            })
            .catch(() => null)
        }
        await fetchTerminals({ allowEmptyLoaded: false })
        setTimeout(() => void fetchTerminals({ allowEmptyLoaded: false }), 750)
        setTimeout(() => void fetchTerminals({ allowEmptyLoaded: true }), 1500)
        if (client && created === '1') {
          setTimeout(() => {
            if (activeHandleRef.current) return
            void (async () => {
              await client
                .sendRequest('worktree.activate', {
                  worktree: `id:${worktreeId}`
                })
                .catch(() => null)
              await fetchTerminals({ allowEmptyLoaded: true })
              setTimeout(() => void fetchTerminals({ allowEmptyLoaded: true }), 750)
            })()
          }, 1800)
        }
      })()
    }
  }, [client, connState, created, fetchTerminals, worktreeId])

  useEffect(() => {
    if (connState !== 'connected') return
    const interval = setInterval(() => {
      void fetchTerminals()
    }, 2000)
    return () => clearInterval(interval)
  }, [connState, fetchTerminals])

  const switchTab = useCallback(
    (handle: string) => {
      activeHandleRef.current = handle
      setActiveHandle(handle)
      if (!fittedHandlesRef.current.has(handle)) {
        void client?.sendRequest('terminal.focus', { terminal: handle }).catch(() => null)
      }
      subscribeToTerminal(handle)
    },
    [client, subscribeToTerminal]
  )

  const setTerminalWebViewRef = useCallback(
    (handle: string, ref: TerminalWebViewHandle | null) => {
      if (ref) {
        terminalRefs.current.set(handle, ref)
        subscribeToTerminal(handle)
      } else {
        terminalRefs.current.delete(handle)
      }
    },
    [subscribeToTerminal]
  )

  async function handleSend() {
    if (!client || !activeHandle || !input.trim()) return

    const text = input
    setInput('')

    try {
      await client.sendRequest('terminal.send', {
        terminal: activeHandle,
        text,
        enter: true
      })
    } catch {
      setInput(text)
    }
  }

  async function handleAccessoryKey(bytes: string) {
    if (!client || !activeHandle || !canSend) return

    try {
      await client.sendRequest('terminal.send', {
        terminal: activeHandle,
        text: bytes,
        enter: false
      })
    } catch {
      // Transient failure
    }
  }

  async function handleCreateTerminal() {
    if (!client || creating) return

    setCreating(true)
    setCreateError('')

    try {
      const response = await client.sendRequest('terminal.create', {
        worktree: `id:${worktreeId}`
      })
      if (response.ok) {
        const result = (response as RpcSuccess).result as TerminalCreateResult
        const created = result.terminal
        locallyCreatedHandlesRef.current.add(created.handle)
        activeHandleRef.current = created.handle
        setActiveHandle(created.handle)
        setTerminals((prev) => [
          ...prev,
          { handle: created.handle, title: created.title || 'Terminal', isActive: true }
        ])
        subscribeToTerminal(created.handle)
        setTimeout(() => void fetchTerminals(), 500)
      } else {
        setCreateError('Failed to create terminal')
      }
    } catch {
      setCreateError('Failed to create terminal')
    } finally {
      setCreating(false)
    }
  }

  async function handleRenameTerminal(value: string) {
    if (!client || !renameTarget) return
    const target = renameTarget
    setRenameTarget(null)

    try {
      const title = value.trim()
      const response = await client.sendRequest('terminal.rename', {
        terminal: target.handle,
        title
      })
      if (response.ok) {
        setTerminals((prev) =>
          prev.map((terminal) =>
            terminal.handle === target.handle
              ? { ...terminal, title: title || 'Terminal' }
              : terminal
          )
        )
        setTimeout(() => void fetchTerminals(), 300)
      }
    } catch {
      // Rename failed — refresh will restore the server title.
    }
  }

  async function handleCloseTerminal(target: Terminal) {
    if (!client) return

    try {
      const response = await client.sendRequest('terminal.close', {
        terminal: target.handle
      })
      if (response.ok) {
        unsubscribeTerminal(target.handle)
        terminalRefs.current.delete(target.handle)
        initializedHandlesRef.current.delete(target.handle)
        locallyCreatedHandlesRef.current.delete(target.handle)
        const next = terminals.filter((terminal) => terminal.handle !== target.handle)
        setTerminals(next)
        if (activeHandleRef.current === target.handle) {
          const replacement = next[0] ?? null
          activeHandleRef.current = replacement?.handle ?? null
          setActiveHandle(replacement?.handle ?? null)
          if (replacement) {
            subscribeToTerminal(replacement.handle)
          }
        }
        setTimeout(() => void fetchTerminals(), 300)
      }
    } catch {
      // Close failed — keep the local tab list unchanged.
    }
  }

  const showLoadingState = connState === 'connected' && !terminalsLoaded
  const showEmptyState =
    connState === 'connected' && terminalsLoaded && terminals.length === 0 && !activeHandle
  const terminalSummary =
    connState === 'connected'
      ? !terminalsLoaded
        ? 'Loading terminals'
        : terminals.length === 1
          ? '1 terminal'
          : `${terminals.length} terminals`
      : STATUS_LABELS[connState]

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={0}
    >
      <SafeAreaView style={styles.sessionChrome} edges={['top']}>
        <View style={styles.sessionTopBar}>
          <Pressable
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
            onPress={() => router.back()}
            hitSlop={8}
            accessibilityLabel="Back to worktrees"
          >
            <ChevronLeft size={22} color={colors.textSecondary} strokeWidth={2.2} />
          </Pressable>

          <View style={styles.sessionTitleBlock}>
            <Text style={styles.sessionTitle} numberOfLines={1}>
              {worktreeName || 'Terminal'}
            </Text>
            <View style={styles.sessionMetaRow}>
              <StatusDot state={connState} />
              <Text style={styles.sessionMetaText} numberOfLines={1}>
                {terminalSummary}
              </Text>
            </View>
          </View>
        </View>

        {terminals.length > 0 && (
          <View style={styles.tabBar}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.tabScroll}
              contentContainerStyle={styles.tabContent}
            >
              {terminals.map((t) => (
                <Pressable
                  key={t.handle}
                  style={[styles.tab, t.handle === activeHandle && styles.tabActive]}
                  onPress={() => switchTab(t.handle)}
                  onLongPress={() => {
                    triggerMediumImpact()
                    setActionTarget(t)
                  }}
                  delayLongPress={400}
                >
                  <Text
                    style={[styles.tabText, t.handle === activeHandle && styles.tabTextActive]}
                    numberOfLines={1}
                  >
                    {t.title || 'Terminal'}
                  </Text>
                </Pressable>
              ))}
              <Pressable
                style={({ pressed }) => [
                  styles.newTerminalButton,
                  pressed && styles.newTerminalButtonPressed,
                  (creating || connState !== 'connected') && styles.newTerminalButtonDisabled
                ]}
                disabled={creating || connState !== 'connected'}
                onPress={() => void handleCreateTerminal()}
                accessibilityLabel="New terminal"
              >
                <Plus size={16} color={colors.textSecondary} strokeWidth={2.2} />
              </Pressable>
            </ScrollView>
          </View>
        )}
      </SafeAreaView>

      {showLoadingState ? (
        <View style={styles.emptyState}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      ) : showEmptyState ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyText}>No terminals in this session</Text>
          {createError ? <Text style={styles.createError}>{createError}</Text> : null}
          <Pressable
            style={[styles.createButton, creating && styles.createButtonDisabled]}
            disabled={creating}
            onPress={() => void handleCreateTerminal()}
          >
            <Text style={styles.createButtonText}>
              {creating ? 'Creating…' : 'Create Terminal'}
            </Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.terminalFrame}>
          {terminals.map((terminal) => (
            <TerminalPaneView
              key={terminal.handle}
              handle={terminal.handle}
              active={terminal.handle === activeHandle}
              onRef={setTerminalWebViewRef}
            />
          ))}
        </View>
      )}

      {/* Accessory keys */}
      <View style={styles.accessoryBar}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.accessoryContent}
        >
          {ACCESSORY_KEYS.map((key) => (
            <Pressable
              key={key.label}
              style={({ pressed }) => [
                styles.accessoryKey,
                pressed && styles.accessoryKeyPressed,
                !canSend && styles.accessoryKeyDisabled
              ]}
              disabled={!canSend}
              onPress={() => void handleAccessoryKey(key.bytes)}
              accessibilityLabel={key.accessibilityLabel ?? `Send ${key.label}`}
            >
              <Text style={[styles.accessoryKeyText, !canSend && styles.accessoryKeyTextDisabled]}>
                {key.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* Input bar */}
      <View style={styles.inputBar}>
        <TextInput
          style={styles.textInput}
          value={input}
          onChangeText={setInput}
          placeholder="Type a command…"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          editable={canSend}
          onSubmitEditing={() => void handleSend()}
        />
        <Pressable
          style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
          disabled={!canSend}
          onPress={() => void handleSend()}
          accessibilityLabel="Send command"
        >
          <ArrowUp size={18} color={colors.textSecondary} strokeWidth={2.5} />
        </Pressable>
      </View>

      <ActionSheetModal
        visible={actionTarget != null}
        title={actionTarget?.title || 'Terminal'}
        actions={[
          ...(actionTarget && fittedHandles.has(actionTarget.handle)
            ? [
                {
                  label: 'Restore Desktop Size',
                  icon: Monitor,
                  onPress: () => {
                    setActionTarget(null)
                    void handleRestoreDesktopSize()
                  }
                }
              ]
            : [
                {
                  label: fitPending ? 'Fitting…' : 'Fit to Phone',
                  icon: Smartphone,
                  onPress: () => {
                    setActionTarget(null)
                    void handleFitToPhone()
                  }
                }
              ]),
          {
            label: 'Rename',
            onPress: () => {
              const target = actionTarget
              setActionTarget(null)
              if (target) {
                setRenameTarget(target)
              }
            }
          },
          {
            label: 'Close',
            destructive: true,
            onPress: () => {
              const target = actionTarget
              setActionTarget(null)
              if (target) {
                void handleCloseTerminal(target)
              }
            }
          }
        ]}
        onClose={() => setActionTarget(null)}
      />
      <TextInputModal
        visible={renameTarget != null}
        title="Rename Terminal"
        defaultValue={renameTarget?.title || 'Terminal'}
        placeholder="Terminal name"
        onSubmit={(value) => void handleRenameTerminal(value)}
        onCancel={() => setRenameTarget(null)}
      />
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  sessionChrome: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  sessionTopBar: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.xs
  },
  backButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  sessionTitleBlock: {
    flex: 1,
    minWidth: 0
  },
  sessionTitle: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: '600'
  },
  sessionMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2
  },
  sessionMetaText: {
    flexShrink: 1,
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  tabBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  tabScroll: {
    flex: 1,
    maxHeight: 36
  },
  tabContent: {
    paddingLeft: spacing.sm,
    paddingRight: spacing.sm
  },
  tab: {
    width: 128,
    maxWidth: 128,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  tabActive: {
    borderBottomColor: colors.accentBlue
  },
  tabText: {
    maxWidth: '100%',
    color: colors.textSecondary,
    fontSize: 13
  },
  tabTextActive: {
    color: colors.textPrimary
  },
  newTerminalButton: {
    width: 40,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  newTerminalButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  newTerminalButtonDisabled: {
    opacity: 0.45
  },
  terminalFrame: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
    overflow: 'hidden'
  },
  terminalPane: {
    ...StyleSheet.absoluteFillObject
  },
  terminalPaneHidden: {
    opacity: 0
  },
  terminalWebView: {
    flex: 1
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    marginBottom: spacing.lg
  },
  createError: {
    color: colors.statusRed,
    fontSize: 13,
    marginBottom: spacing.sm
  },
  createButton: {
    backgroundColor: colors.accentBlue,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button
  },
  createButtonDisabled: {
    opacity: 0.5
  },
  createButtonText: {
    color: '#fff',
    fontSize: typography.bodySize,
    fontWeight: '600'
  },
  accessoryBar: {
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  accessoryContent: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: spacing.xs
  },
  accessoryKey: {
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: radii.button,
    minWidth: 36,
    alignItems: 'center'
  },
  accessoryKeyPressed: {
    backgroundColor: colors.borderSubtle
  },
  accessoryKeyDisabled: {
    opacity: 0.35
  },
  accessoryKeyText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontFamily: typography.monoFamily
  },
  accessoryKeyTextDisabled: {
    color: colors.textMuted
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  textInput: {
    flex: 1,
    backgroundColor: colors.bgRaised,
    color: colors.textPrimary,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: 14,
    fontFamily: typography.monoFamily,
    marginRight: spacing.sm
  },
  sendButton: {
    backgroundColor: colors.bgRaised,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center'
  },
  sendButtonDisabled: {
    opacity: 0.35
  }
})
