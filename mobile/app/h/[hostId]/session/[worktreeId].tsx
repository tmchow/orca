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
import { ArrowUp, ChevronLeft, Plus } from 'lucide-react-native'
import { connect, type RpcClient } from '../../../../src/transport/rpc-client'
import { loadHosts } from '../../../../src/transport/host-store'
import type { ConnectionState, RpcSuccess } from '../../../../src/transport/types'
import {
  TerminalWebView,
  type TerminalWebViewHandle
} from '../../../../src/terminal/TerminalWebView'
import { StatusDot } from '../../../../src/components/StatusDot'
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

const STATUS_LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting',
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
  const termRef = useRef<TerminalWebViewHandle>(null)
  const unsubRef = useRef<(() => void) | null>(null)
  const activeHandleRef = useRef<string | null>(null)
  const subscribeSeqRef = useRef(0)

  const canSend = connState === 'connected' && activeHandle != null

  useEffect(() => {
    let rpcClient: RpcClient | null = null

    void (async () => {
      const hosts = await loadHosts()
      const host = hosts.find((h) => h.id === hostId)
      if (!host) return

      rpcClient = connect(host.endpoint, host.deviceToken, setConnState)
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

  const writeLines = useCallback((lines: string[] | string | undefined) => {
    const text = Array.isArray(lines) ? lines.join('\r\n') : (lines ?? '')
    if (text) {
      termRef.current?.write(text)
      if (Array.isArray(lines)) {
        termRef.current?.write('\r\n')
      }
    }
  }, [])

  const subscribeToTerminal = useCallback(
    (handle: string) => {
      unsubRef.current?.()
      if (!client) return

      termRef.current?.clear()
      const seq = subscribeSeqRef.current + 1
      subscribeSeqRef.current = seq

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
                >
                  <Text
                    style={[styles.tabText, t.handle === activeHandle && styles.tabTextActive]}
                    numberOfLines={1}
                  >
                    {t.title || 'Terminal'}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
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
    paddingRight: spacing.xs
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
    borderLeftWidth: 1,
    borderLeftColor: colors.borderSubtle
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
