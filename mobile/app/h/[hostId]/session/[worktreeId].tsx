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
  const [output, setOutput] = useState('')
  const [input, setInput] = useState('')
  const [activeHandle, setActiveHandle] = useState<string | null>(null)
  const scrollRef = useRef<ScrollView>(null)
  const unsubRef = useRef<(() => void) | null>(null)

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

  const fetchTerminals = useCallback(async () => {
    if (!client) return

    try {
      const response = await client.sendRequest('terminal.list', {
        worktree: `id:${worktreeId}`
      })
      if (response.ok) {
        const result = (response as RpcSuccess).result as { terminals: Terminal[] }
        setTerminals(result.terminals)

        const active = result.terminals.find((t) => t.isActive) ?? result.terminals[0]
        if (active && active.handle !== activeHandle) {
          setActiveHandle(active.handle)
          subscribeToTerminal(active.handle)
        }
      }
    } catch {
      // Will retry on reconnect
    }
  }, [client, worktreeId, activeHandle])

  useEffect(() => {
    if (connState === 'connected') {
      void fetchTerminals()
    }
  }, [connState, fetchTerminals])

  function subscribeToTerminal(handle: string) {
    unsubRef.current?.()

    if (!client) return

    setOutput('')

    const unsub = client.subscribe('terminal.subscribe', { terminal: handle }, (result) => {
      const data = result as Record<string, unknown>
      if (data.type === 'scrollback') {
        setOutput(data.lines as string)
        scrollToBottom()
      } else if (data.type === 'data') {
        setOutput((prev) => prev + (data.chunk as string))
        scrollToBottom()
      }
    })

    unsubRef.current = unsub
  }

  function scrollToBottom() {
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true })
    }, 50)
  }

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
              onPress={() => {
                setActiveHandle(t.handle)
                subscribeToTerminal(t.handle)
              }}
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

      <ScrollView
        ref={scrollRef}
        style={styles.outputScroll}
        contentContainerStyle={styles.outputContent}
      >
        <Text style={styles.outputText} selectable>
          {output || 'Waiting for output...'}
        </Text>
      </ScrollView>

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
  outputScroll: {
    flex: 1
  },
  outputContent: {
    padding: 12
  },
  outputText: {
    color: '#d4d4d4',
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 18
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
