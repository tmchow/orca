import { useState, useEffect, useCallback } from 'react'
import { View, Text, StyleSheet, FlatList, Pressable, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { connect, type RpcClient } from '../../../src/transport/rpc-client'
import { loadHosts, updateLastConnected } from '../../../src/transport/host-store'
import type { ConnectionState, RpcSuccess } from '../../../src/transport/types'

type Worktree = {
  worktreeId: string
  repo: string
  branch: string
  liveTerminalCount: number
  hasAttachedPty: boolean
  preview: string
  unread: boolean
}

export default function HostScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const router = useRouter()
  const [client, setClient] = useState<RpcClient | null>(null)
  const [connState, setConnState] = useState<ConnectionState>('disconnected')
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let rpcClient: RpcClient | null = null

    void (async () => {
      const hosts = await loadHosts()
      const host = hosts.find((h) => h.id === hostId)
      if (!host) {
        setError('Host not found')
        return
      }

      rpcClient = connect(host.endpoint, host.deviceToken, setConnState)
      setClient(rpcClient)

      await updateLastConnected(host.id)
    })()

    return () => {
      rpcClient?.close()
    }
  }, [hostId])

  const fetchWorktrees = useCallback(async () => {
    if (!client || connState !== 'connected') return

    try {
      const response = await client.sendRequest('worktree.ps')
      if (response.ok) {
        const result = (response as RpcSuccess).result as { worktrees: Worktree[] }
        setWorktrees(result.worktrees)
      }
    } catch {
      // Will retry on reconnect
    }
  }, [client, connState])

  useEffect(() => {
    if (connState === 'connected') {
      void fetchWorktrees()
    }
  }, [connState, fetchWorktrees])

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <View style={styles.statusBar}>
        <View style={[styles.statusDot, connState === 'connected' && styles.statusConnected]} />
        <Text style={styles.statusText}>{connState}</Text>
      </View>

      {connState === 'connecting' && (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#3b82f6" />
          <Text style={styles.connectingText}>Connecting...</Text>
        </View>
      )}

      {connState === 'connected' && worktrees.length === 0 && (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>No active worktrees</Text>
        </View>
      )}

      {worktrees.length > 0 && (
        <FlatList
          data={worktrees}
          keyExtractor={(w) => w.worktreeId}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <Pressable
              style={styles.worktreeCard}
              onPress={() =>
                router.push(`/h/${hostId}/session/${encodeURIComponent(item.worktreeId)}`)
              }
            >
              <View style={styles.worktreeHeader}>
                <Text style={styles.worktreeRepo}>{item.repo}</Text>
                {item.unread && <View style={styles.unreadDot} />}
              </View>
              <Text style={styles.worktreeBranch}>{item.branch}</Text>
              {item.preview ? (
                <Text style={styles.worktreePreview} numberOfLines={2}>
                  {item.preview}
                </Text>
              ) : null}
              <Text style={styles.worktreeMeta}>
                {item.liveTerminalCount} terminal{item.liveTerminalCount !== 1 ? 's' : ''}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d0d1a'
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    paddingHorizontal: 16
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
  statusText: {
    color: '#888',
    fontSize: 13
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  connectingText: {
    color: '#e0e0e0',
    fontSize: 16,
    marginTop: 16
  },
  emptyText: {
    color: '#888',
    fontSize: 16
  },
  errorText: {
    color: '#ef4444',
    fontSize: 16
  },
  list: {
    padding: 16,
    paddingTop: 0
  },
  worktreeCard: {
    backgroundColor: '#1a1a2e',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12
  },
  worktreeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4
  },
  worktreeRepo: {
    fontSize: 18,
    fontWeight: '600',
    color: '#e0e0e0'
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#3b82f6',
    marginLeft: 8
  },
  worktreeBranch: {
    fontSize: 14,
    color: '#3b82f6',
    fontFamily: 'monospace',
    marginBottom: 8
  },
  worktreePreview: {
    fontSize: 13,
    color: '#888',
    fontFamily: 'monospace',
    marginBottom: 8,
    lineHeight: 18
  },
  worktreeMeta: {
    fontSize: 12,
    color: '#666'
  }
})
