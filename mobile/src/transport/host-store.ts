import AsyncStorage from '@react-native-async-storage/async-storage'
import type { HostProfile } from './types'

const STORAGE_KEY = 'orca:hosts'

export async function loadHosts(): Promise<HostProfile[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY)
  if (!raw) return []
  try {
    return JSON.parse(raw) as HostProfile[]
  } catch {
    return []
  }
}

export async function saveHost(host: HostProfile): Promise<void> {
  const hosts = await loadHosts()
  const index = hosts.findIndex((h) => h.id === host.id)
  if (index >= 0) {
    hosts[index] = host
  } else {
    hosts.push(host)
  }
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(hosts))
}

export async function removeHost(hostId: string): Promise<void> {
  const hosts = await loadHosts()
  const filtered = hosts.filter((h) => h.id !== hostId)
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(filtered))
}

export async function updateLastConnected(hostId: string): Promise<void> {
  const hosts = await loadHosts()
  const host = hosts.find((h) => h.id === hostId)
  if (host) {
    host.lastConnected = Date.now()
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(hosts))
  }
}
