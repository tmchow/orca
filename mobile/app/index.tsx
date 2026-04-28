import { useState, useCallback } from 'react'
import { View, Text, StyleSheet, Pressable, FlatList } from 'react-native'
import { useRouter } from 'expo-router'
import { useFocusEffect } from 'expo-router'
import { loadHosts } from '../src/transport/host-store'
import type { HostProfile } from '../src/transport/types'

export default function HomeScreen() {
  const router = useRouter()
  const [hosts, setHosts] = useState<HostProfile[]>([])

  useFocusEffect(
    useCallback(() => {
      void loadHosts().then(setHosts)
    }, [])
  )

  return (
    <View style={styles.container}>
      {hosts.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.title}>Orca Mobile</Text>
          <Text style={styles.subtitle}>No hosts paired yet</Text>
          <Pressable style={styles.button} onPress={() => router.push('/pair-scan')}>
            <Text style={styles.buttonText}>+ Add Host</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <FlatList
            data={hosts}
            keyExtractor={(h) => h.id}
            contentContainerStyle={styles.list}
            renderItem={({ item }) => (
              <Pressable style={styles.hostCard} onPress={() => router.push(`/h/${item.id}`)}>
                <Text style={styles.hostName}>{item.name}</Text>
                <Text style={styles.hostEndpoint}>{item.endpoint}</Text>
                {item.lastConnected > 0 && (
                  <Text style={styles.hostMeta}>
                    Last connected {new Date(item.lastConnected).toLocaleDateString()}
                  </Text>
                )}
              </Pressable>
            )}
          />
          <Pressable style={styles.addButton} onPress={() => router.push('/pair-scan')}>
            <Text style={styles.buttonText}>+ Add Host</Text>
          </Pressable>
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d0d1a'
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#e0e0e0',
    marginBottom: 8
  },
  subtitle: {
    fontSize: 16,
    color: '#888',
    marginBottom: 32
  },
  list: {
    padding: 16
  },
  hostCard: {
    backgroundColor: '#1a1a2e',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12
  },
  hostName: {
    fontSize: 18,
    fontWeight: '600',
    color: '#e0e0e0',
    marginBottom: 4
  },
  hostEndpoint: {
    fontSize: 13,
    color: '#888',
    fontFamily: 'monospace'
  },
  hostMeta: {
    fontSize: 12,
    color: '#666',
    marginTop: 8
  },
  button: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8
  },
  addButton: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    margin: 16,
    alignItems: 'center'
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600'
  }
})
