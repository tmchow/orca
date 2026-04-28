import { useState, useEffect, useRef, useCallback } from 'react'
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform
} from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { connect, type RpcClient } from '../../../../src/transport/rpc-client'
import { loadHosts } from '../../../../src/transport/host-store'
import type { ConnectionState, RpcSuccess } from '../../../../src/transport/types'
import {
  TerminalWebView,
  type TerminalWebViewHandle
} from '../../../../src/terminal/TerminalWebView'

type Terminal = {
  handle: string
  title: string
  isActive: boolean
}

export default function SessionScreen() {
  const { hostId, worktreeId } = useLocalSearchParams<{ hostId: string; worktreeId: string }>()
  const [client, setClient] = useState<RpcClient | null>(null)
  const [connState, setConnState] = useState<ConnectionState>('disconnected')
  const [terminals, setTerminals] = useState<Terminal[]>([])
  const [input, setInput] = useState('')
  const [activeHandle, setActiveHandle] = useState<string | null>(null)
  const termRef = useRef<TerminalWebViewHandle>(null)
  const unsubRef = useRef<(() => void) | null>(null)
  const activeHandleRef = useRef<string | null>(null)
  const subscribeSeqRef = useRef(0)
  const terminalSizeRef = useRef({ cols: 80, rows: 24 })

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
            // Why: init xterm at the desktop's exact cols/rows so escape
            // codes with absolute cursor positioning render correctly.
            // CSS transform: scale() in TerminalWebView shrinks the canvas
            // to fit the phone viewport, producing a 1:1 miniature.
            const cols = (data.cols as number) || 80
            const rows = (data.rows as number) || 24
            terminalSizeRef.current = { cols, rows }
            termRef.current?.init(cols, rows)
            // Why: prefer serialized xterm buffer (ANSI escape string that
            // reconstructs the exact screen state) over line-based tail
            // because TUI apps use absolute cursor positioning that only
            // works at the original terminal dimensions.
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

  const fetchTerminals = useCallback(async () => {
    if (!client) return

    try {
      const response = await client.sendRequest('terminal.list', {
        worktree: `id:${worktreeId}`
      })
      if (response.ok) {
        const result = (response as RpcSuccess).result as { terminals: Terminal[] }
        setTerminals(result.terminals)

        const current = activeHandleRef.current
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
  }, [client, worktreeId, subscribeToTerminal])

  useEffect(() => {
    if (connState === 'connected') {
      void fetchTerminals()
    }
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
      // Failed to send
    }
  }

  const activeTerminal = terminals.find((t) => t.handle === activeHandle)

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}
    >
      <View style={styles.header}>
        <View style={[styles.statusDot, connState === 'connected' && styles.statusConnected]} />
        <Text style={styles.headerTitle} numberOfLines={1}>
          {activeTerminal?.title ?? 'Terminal'}
        </Text>
      </View>

      {terminals.length > 1 && (
        <ScrollView horizontal style={styles.tabBar} showsHorizontalScrollIndicator={false}>
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
      )}

      <View style={styles.terminalFrame}>
        <TerminalWebView ref={termRef} />
      </View>

      <View style={styles.inputBar}>
        <TextInput
          style={styles.textInput}
          value={input}
          onChangeText={setInput}
          placeholder="Type a command..."
          placeholderTextColor="#555"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="send"
          onSubmitEditing={() => void handleSend()}
        />
        <Pressable style={styles.sendButton} onPress={() => void handleSend()}>
          <Text style={styles.sendButtonText}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d0d1a'
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a2e'
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#666',
    marginRight: 8
  },
  statusConnected: {
    backgroundColor: '#22c55e'
  },
  headerTitle: {
    color: '#e0e0e0',
    fontSize: 16,
    fontWeight: '600',
    flex: 1
  },
  tabBar: {
    maxHeight: 44,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a2e'
  },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent'
  },
  tabActive: {
    borderBottomColor: '#3b82f6'
  },
  tabText: {
    color: '#888',
    fontSize: 13
  },
  tabTextActive: {
    color: '#e0e0e0'
  },
  terminalFrame: {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden'
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 8,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: '#1a1a2e',
    backgroundColor: '#111127'
  },
  textInput: {
    flex: 1,
    backgroundColor: '#1a1a2e',
    color: '#e0e0e0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: 'monospace',
    marginRight: 8
  },
  sendButton: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8
  },
  sendButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600'
  }
})
