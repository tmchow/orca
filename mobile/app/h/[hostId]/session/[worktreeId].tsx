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

export default function SessionScreen() {
  const {
    hostId,
    worktreeId,
    name: worktreeName
  } = useLocalSearchParams<{
    hostId: string
    worktreeId: string
    name?: string
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
  // Why: only auto-fit terminals created during this mobile session.
  // Existing desktop terminals should keep their desktop dimensions until
  // the user explicitly chooses "Fit to Phone".
  const mobileCreatedHandlesRef = useRef<Set<string>>(new Set())
  const termRef = useRef<TerminalWebViewHandle>(null)
  const unsubRef = useRef<(() => void) | null>(null)
  const activeHandleRef = useRef<string | null>(null)
  const subscribeSeqRef = useRef(0)

  const canSend = connState === 'connected' && activeHandle != null

  const writeLines = useCallback((lines: string[] | string | undefined) => {
    const text = Array.isArray(lines) ? lines.join('\r\n') : (lines ?? '')
    if (text) {
      termRef.current?.write(text)
      if (Array.isArray(lines)) {
        termRef.current?.write('\r\n')
      }
    }
  }, [])

  // Why: after a fit/restore resize the PTY grid changes, so we must
  // resubscribe to get a fresh scrollback snapshot at the new geometry.
  // We skip terminal.focus to avoid a race where the desktop renderer
  // auto-fits the pane back to desktop dimensions before the override
  // takes effect.
  const resubscribeWithoutFocus = useCallback(
    (handle: string) => {
      unsubRef.current?.()
      if (!client) return

      termRef.current?.clear()
      const seq = subscribeSeqRef.current + 1
      subscribeSeqRef.current = seq

      void (async () => {
        if (subscribeSeqRef.current !== seq || activeHandleRef.current !== handle) {
          return
        }

        const unsub = client.subscribe('terminal.subscribe', { terminal: handle }, (result) => {
          if (subscribeSeqRef.current !== seq || activeHandleRef.current !== handle) {
            return
          }
          const data = result as Record<string, unknown>
          if (data.type === 'scrollback') {
            const cols = (data.cols as number) || 80
            const rows = (data.rows as number) || 24
            termRef.current?.init(cols, rows)
            if (typeof data.serialized === 'string' && data.serialized.length > 0) {
              termRef.current?.write(data.serialized)
            } else {
              writeLines(data.lines as string[] | string | undefined)
            }
          } else if (data.type === 'data') {
            termRef.current?.write(data.chunk as string)
          }
        })

        if (subscribeSeqRef.current === seq && activeHandleRef.current === handle) {
          unsubRef.current = unsub
        } else {
          unsub()
        }
      })()
    },
    [client, writeLines]
  )

  // Why: extracted so both manual "Fit to Phone" and auto-fit-on-subscribe
  // can share the same measure → resize → resubscribe logic. Takes explicit
  // handle/rpcClient to avoid stale closure issues from subscribe callbacks.
  const fitToPhoneCore = useCallback(
    async (handle: string, rpcClient: RpcClient) => {
      const clientId = deviceTokenRef.current
      if (!clientId) return

      const dims = await termRef.current?.measureFitDimensions()
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
      setTimeout(() => termRef.current?.resetZoom(), 500)
    },
    [resubscribeWithoutFocus, updateFittedHandles]
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
      setTimeout(() => termRef.current?.resetZoom(), 500)
    } catch {
      // Restore failed — keep current state.
    }
  }, [client, activeHandle, resubscribeWithoutFocus, updateFittedHandles])

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
      unsubRef.current?.()
      rpcClient?.close()
    }
  }, [hostId])

  useEffect(() => {
    unsubRef.current?.()
    unsubRef.current = null
    activeHandleRef.current = null
    setActiveHandle(null)
    setTerminals([])
    termRef.current?.clear()
  }, [worktreeId])

  const subscribeToTerminal = useCallback(
    (handle: string) => {
      unsubRef.current?.()
      if (!client) return

      termRef.current?.clear()
      const seq = subscribeSeqRef.current + 1
      subscribeSeqRef.current = seq
      const rpcClient = client

      void (async () => {
        try {
          // Why: hidden/new desktop panes can still be at their 80x24 spawn
          // geometry. Focusing first lets the desktop renderer fit xterm,
          // resize the PTY, and register a serializer before mobile subscribes.
          await client.sendRequest('terminal.focus', { terminal: handle })
          await new Promise((resolve) => setTimeout(resolve, 150))
        } catch {
          // Continue with best-effort streaming if desktop focus is unavailable.
        }

        if (subscribeSeqRef.current !== seq || activeHandleRef.current !== handle) {
          return
        }

        const unsub = client.subscribe('terminal.subscribe', { terminal: handle }, (result) => {
          if (subscribeSeqRef.current !== seq || activeHandleRef.current !== handle) {
            return
          }
          const data = result as Record<string, unknown>
          if (data.type === 'scrollback') {
            const cols = (data.cols as number) || 80
            const rows = (data.rows as number) || 24
            termRef.current?.init(cols, rows)
            if (typeof data.serialized === 'string' && data.serialized.length > 0) {
              termRef.current?.write(data.serialized)
            } else {
              writeLines(data.lines as string[] | string | undefined)
            }
            // Why: auto-fit terminals that (a) were created during this
            // mobile session, or (b) the user previously fitted to phone
            // and didn't manually restore. Case (b) handles the scenario
            // where navigating away disconnects the WebSocket (triggering
            // auto-restore on desktop) and coming back should re-apply
            // the phone fit so the user doesn't lose their aspect ratio.
            if (
              !manuallyRestoredRef.current.has(handle) &&
              (mobileCreatedHandlesRef.current.has(handle) ||
                fittedHandlesRef.current.has(handle)) &&
              !fitPendingRef.current
            ) {
              setTimeout(() => {
                if (activeHandleRef.current === handle && subscribeSeqRef.current === seq) {
                  void fitToPhoneCore(handle, rpcClient)
                }
              }, 600)
            }
          } else if (data.type === 'data') {
            termRef.current?.write(data.chunk as string)
          }
        })

        if (subscribeSeqRef.current === seq && activeHandleRef.current === handle) {
          unsubRef.current = unsub
        } else {
          unsub()
        }
      })()
    },
    [client, writeLines, fitToPhoneCore]
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
              unsubRef.current?.()
              unsubRef.current = null
              activeHandleRef.current = null
              setActiveHandle(null)
              termRef.current?.clear()
            }
          }
        }
      } catch {
        // Failed to list terminals
      }
    },
    [client, worktreeId, subscribeToTerminal]
  )

  useEffect(() => {
    if (connState === 'connected') {
      setTerminalsLoaded(false)
      void (async () => {
        if (client) {
          await client
            .sendRequest('worktree.activate', {
              worktree: `id:${worktreeId}`
            })
            .catch(() => null)
        }
        await fetchTerminals({ allowEmptyLoaded: false })
        setTimeout(() => void fetchTerminals({ allowEmptyLoaded: false }), 750)
        setTimeout(() => void fetchTerminals({ allowEmptyLoaded: true }), 1500)
      })()
    }
  }, [client, connState, fetchTerminals, worktreeId])

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
      subscribeToTerminal(handle)
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
        mobileCreatedHandlesRef.current.add(created.handle)
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
        const next = terminals.filter((terminal) => terminal.handle !== target.handle)
        setTerminals(next)
        if (activeHandleRef.current === target.handle) {
          const replacement = next[0] ?? null
          activeHandleRef.current = replacement?.handle ?? null
          setActiveHandle(replacement?.handle ?? null)
          if (replacement) {
            subscribeToTerminal(replacement.handle)
          } else {
            unsubRef.current?.()
            unsubRef.current = null
            termRef.current?.clear()
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
                  onLongPress={() => setActionTarget(t)}
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
          <TerminalWebView ref={termRef} />
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
          <ArrowUp size={18} color="#fff" strokeWidth={2.5} />
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
    overflow: 'hidden'
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
    backgroundColor: colors.accentBlue,
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
