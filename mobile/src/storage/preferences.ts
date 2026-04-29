import AsyncStorage from '@react-native-async-storage/async-storage'

const PINS_PREFIX = 'orca:pins:'
const PREFS_PREFIX = 'orca:prefs:'
const NOTIF_KEY = 'orca:pushNotificationsEnabled'

export async function loadPushNotificationsEnabled(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(NOTIF_KEY)
    if (raw === null) return true
    return raw === 'true'
  } catch {
    return true
  }
}

export async function savePushNotificationsEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(NOTIF_KEY, String(enabled))
}

export type HostPreferences = {
  sortMode: string
  filterMode: string
  groupMode: string
  collapsedGroups: string[]
  selectedRepos: string[]
}

const DEFAULT_PREFS: HostPreferences = {
  sortMode: 'smart',
  filterMode: 'all',
  groupMode: 'none',
  collapsedGroups: [],
  selectedRepos: []
}

export async function loadPinnedIds(hostId: string): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(PINS_PREFIX + hostId)
    if (!raw) return new Set()
    return new Set(JSON.parse(raw) as string[])
  } catch {
    return new Set()
  }
}

export async function savePinnedIds(hostId: string, ids: Set<string>): Promise<void> {
  await AsyncStorage.setItem(PINS_PREFIX + hostId, JSON.stringify([...ids]))
}

export async function loadPreferences(hostId: string): Promise<HostPreferences> {
  try {
    const raw = await AsyncStorage.getItem(PREFS_PREFIX + hostId)
    if (!raw) return DEFAULT_PREFS
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<HostPreferences>) }
  } catch {
    return DEFAULT_PREFS
  }
}

export async function savePreferences(
  hostId: string,
  prefs: Partial<HostPreferences>
): Promise<void> {
  const current = await loadPreferences(hostId)
  const merged = { ...current, ...prefs }
  await AsyncStorage.setItem(PREFS_PREFIX + hostId, JSON.stringify(merged))
}
