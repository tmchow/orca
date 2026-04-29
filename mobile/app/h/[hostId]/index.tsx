import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  Pressable,
  ActivityIndicator,
  TextInput
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  Search,
  X,
  Pin,
  Bell,
  GitPullRequest,
  SlidersHorizontal,
  Layers,
  ChevronDown,
  ChevronRight
} from 'lucide-react-native'
import { connect, type RpcClient } from '../../../src/transport/rpc-client'
import { loadHosts, updateLastConnected, removeHost } from '../../../src/transport/host-store'
import type { ConnectionState, RpcSuccess } from '../../../src/transport/types'
import { StatusDot } from '../../../src/components/StatusDot'
import { AgentSpinner } from '../../../src/components/AgentSpinner'
import { PickerModal, type PickerOption } from '../../../src/components/PickerModal'
import { ActionSheetModal } from '../../../src/components/ActionSheetModal'
import { colors, spacing, typography } from '../../../src/theme/mobile-theme'
import {
  loadPinnedIds,
  savePinnedIds,
  loadPreferences,
  savePreferences
} from '../../../src/storage/preferences'

type Worktree = {
  worktreeId: string
  repo: string
  branch: string
  displayName: string
  liveTerminalCount: number
  hasAttachedPty: boolean
  preview: string
  unread: boolean
  lastOutputAt?: number
  isPinned: boolean
  linkedPR: { number: number; state: string } | null
  status?: 'working' | 'active' | 'permission' | 'done' | 'inactive'
}

type SortMode = 'smart' | 'name' | 'recent'
type FilterMode = 'all' | 'active'
type GroupMode = 'none' | 'repo' | 'prStatus'

const STATUS_LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  handshaking: 'Securing…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  reconnecting: 'Reconnecting…',
  'auth-failed': 'Auth failed'
}

const SORT_OPTIONS: PickerOption<SortMode>[] = [
  { value: 'smart', label: 'Smart', subtitle: 'Unread and active first' },
  { value: 'name', label: 'Name', subtitle: 'Alphabetical by name' },
  { value: 'recent', label: 'Recent', subtitle: 'Most recent output first' }
]

const GROUP_OPTIONS: PickerOption<GroupMode>[] = [
  { value: 'none', label: 'No Grouping' },
  { value: 'repo', label: 'By Repository' },
  { value: 'prStatus', label: 'By PR Status', subtitle: 'Linked PR vs none' }
]

function getWorktreeStatus(w: Worktree): 'working' | 'active' | 'permission' | 'done' | 'inactive' {
  if (w.status) return w.status
  if (w.liveTerminalCount > 0) return 'active'
  return 'inactive'
}

// Why: the previous 10-minute lastOutputAt window was too strict — most
// worktrees with idle terminal prompts had no recent output and were excluded.
// Any worktree with live terminals or unread output counts as "active".
function isWorktreeActive(w: Worktree): boolean {
  if (w.unread) return true
  if (w.status) return w.status !== 'inactive'
  if (w.liveTerminalCount > 0) return true
  return false
}

function sortWorktrees(worktrees: Worktree[], mode: SortMode): Worktree[] {
  return [...worktrees].sort((a, b) => {
    if (mode === 'name') return (a.displayName || a.repo).localeCompare(b.displayName || b.repo)
    if (mode === 'recent') return (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0)
    // 'smart' — attention-first
    if (a.unread !== b.unread) return a.unread ? -1 : 1
    const aStatus = getWorktreeStatus(a)
    const bStatus = getWorktreeStatus(b)
    const statusOrder = { permission: 0, working: 1, done: 2, active: 3, inactive: 4 }
    if (statusOrder[aStatus] !== statusOrder[bStatus])
      return statusOrder[aStatus] - statusOrder[bStatus]
    if ((a.lastOutputAt ?? 0) !== (b.lastOutputAt ?? 0))
      return (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0)
    return (a.displayName || a.repo).localeCompare(b.displayName || b.repo)
  })
}

function filterWorktrees(worktrees: Worktree[], filter: FilterMode, search: string): Worktree[] {
  let result = worktrees
  if (filter === 'active') {
    result = result.filter(isWorktreeActive)
  }
  if (search.trim()) {
    const q = search.toLowerCase()
    result = result.filter(
      (w) =>
        (w.displayName || w.repo).toLowerCase().includes(q) ||
        w.branch.toLowerCase().includes(q) ||
        w.repo.toLowerCase().includes(q)
    )
  }
  return result
}

type Section = { title: string; icon?: 'pin'; data: Worktree[] }

// Why: matches desktop's PR_GROUP_META naming from worktree-list-groups.ts.
// no PR/draft/unknown → "In Progress", open → "In Review", merged → "Done", closed → "Closed"
type PRGroupKey = 'done' | 'in-review' | 'in-progress' | 'closed'

const PR_GROUP_LABELS: Record<PRGroupKey, string> = {
  done: 'Done',
  'in-review': 'In Review',
  'in-progress': 'In Progress',
  closed: 'Closed'
}

const PR_GROUP_ORDER: PRGroupKey[] = ['done', 'in-review', 'in-progress', 'closed']

function getPRGroupKey(w: Worktree): PRGroupKey {
  if (!w.linkedPR) return 'in-progress'
  const s = w.linkedPR.state.toLowerCase()
  if (s === 'merged') return 'done'
  if (s === 'closed') return 'closed'
  if (s === 'draft') return 'in-progress'
  return 'in-review'
}

function isWorktreePinned(w: Worktree, localPins: Set<string>): boolean {
  return w.isPinned || localPins.has(w.worktreeId)
}

function buildSections(
  worktrees: Worktree[],
  sortMode: SortMode,
  filterMode: FilterMode,
  search: string,
  groupMode: GroupMode,
  pinnedIds: Set<string>
): Section[] {
  const filtered = filterWorktrees(worktrees, filterMode, search)
  const sorted = sortWorktrees(filtered, sortMode)

  const pinned = sorted.filter((w) => isWorktreePinned(w, pinnedIds))
  const unpinned = sorted.filter((w) => !isWorktreePinned(w, pinnedIds))
  const active = unpinned.filter(isWorktreeActive)
  const inactive = unpinned.filter((w) => !isWorktreeActive(w))

  const sections: Section[] = []
  if (pinned.length > 0) {
    sections.push({ title: 'Pinned', icon: 'pin', data: pinned })
  }

  if (groupMode === 'none') {
    if (active.length > 0) {
      // Why: without explicit grouping, mobile's primary workflow is jumping
      // back into running sessions before browsing the full worktree archive.
      sections.push({ title: 'Active', data: active })
    }
    if (inactive.length > 0) {
      sections.push({ title: pinned.length > 0 || active.length > 0 ? 'All' : '', data: inactive })
    }
  } else if (groupMode === 'repo') {
    const byRepo = new Map<string, Worktree[]>()
    for (const w of unpinned) {
      const key = w.repo || 'Unknown'
      const list = byRepo.get(key)
      if (list) list.push(w)
      else byRepo.set(key, [w])
    }
    for (const [repo, items] of byRepo) {
      sections.push({ title: repo, data: items })
    }
  } else if (groupMode === 'prStatus') {
    const byGroup = new Map<PRGroupKey, Worktree[]>()
    for (const w of unpinned) {
      const key = getPRGroupKey(w)
      const list = byGroup.get(key)
      if (list) list.push(w)
      else byGroup.set(key, [w])
    }
    for (const groupKey of PR_GROUP_ORDER) {
      const items = byGroup.get(groupKey)
      if (items && items.length > 0) {
        sections.push({ title: PR_GROUP_LABELS[groupKey], data: items })
      }
    }
  }

  return sections
}

export default function HostScreen() {
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  const router = useRouter()
  const [client, setClient] = useState<RpcClient | null>(null)
  const [connState, setConnState] = useState<ConnectionState>('disconnected')
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const [worktreesLoaded, setWorktreesLoaded] = useState(false)
  const [hostName, setHostName] = useState('')
  const [error, setError] = useState('')
  const [lastKnownWorktrees, setLastKnownWorktrees] = useState<Worktree[]>([])
  const [search, setSearch] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [sortMode, setSortMode] = useState<SortMode>('smart')
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const [groupMode, setGroupMode] = useState<GroupMode>('none')

  // Modals
  const [showSortPicker, setShowSortPicker] = useState(false)
  const [showGroupPicker, setShowGroupPicker] = useState(false)
  const [actionTarget, setActionTarget] = useState<Worktree | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Worktree | null>(null)
  const [confirmRemoveHost, setConfirmRemoveHost] = useState(false)

  // Persisted pin state
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set())
  const [_prefsLoaded, setPrefsLoaded] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  // Load persisted pins and preferences
  useEffect(() => {
    if (!hostId) return
    void (async () => {
      const [pins, prefs] = await Promise.all([loadPinnedIds(hostId), loadPreferences(hostId)])
      setPinnedIds(pins)
      setSortMode(prefs.sortMode as SortMode)
      setFilterMode(prefs.filterMode as FilterMode)
      setGroupMode(prefs.groupMode as GroupMode)
      setCollapsedGroups(new Set(prefs.collapsedGroups))
      setPrefsLoaded(true)
    })()
  }, [hostId])

  useEffect(() => {
    let rpcClient: RpcClient | null = null
    setWorktreesLoaded(false)
    setWorktrees([])

    void (async () => {
      const hosts = await loadHosts()
      const host = hosts.find((h) => h.id === hostId)
      if (!host) {
        setError('Host not found')
        return
      }

      setHostName(host.name)
      rpcClient = connect(host.endpoint, host.deviceToken, host.publicKeyB64, setConnState)
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
        setLastKnownWorktrees(result.worktrees)
        setWorktreesLoaded(true)
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

  useEffect(() => {
    if (connState !== 'connected') return
    const interval = setInterval(() => {
      void fetchWorktrees()
    }, 3000)
    return () => clearInterval(interval)
  }, [connState, fetchWorktrees])

  const togglePin = useCallback(
    (worktreeId: string) => {
      setPinnedIds((prev) => {
        const next = new Set(prev)
        if (next.has(worktreeId)) next.delete(worktreeId)
        else next.add(worktreeId)
        if (hostId) void savePinnedIds(hostId, next)
        return next
      })
      setWorktrees((prev) =>
        prev.map((w) => (w.worktreeId === worktreeId ? { ...w, isPinned: !w.isPinned } : w))
      )
      setLastKnownWorktrees((prev) =>
        prev.map((w) => (w.worktreeId === worktreeId ? { ...w, isPinned: !w.isPinned } : w))
      )
    },
    [hostId]
  )

  const handleDeleteWorktree = useCallback(
    async (item: Worktree) => {
      if (!client) return
      try {
        await client.sendRequest('worktree.remove', {
          worktree: `id:${item.worktreeId}`
        })
        void fetchWorktrees()
      } catch {
        // Deletion failed — will be visible when list doesn't change
      }
    },
    [client, fetchWorktrees]
  )

  const handleRemoveHost = useCallback(async () => {
    if (!hostId) return
    await removeHost(hostId)
    router.back()
  }, [hostId, router])

  const openWorktreeSession = useCallback(
    (item: Worktree) => {
      if (client && connState === 'connected') {
        void client.sendRequest('worktree.activate', {
          worktree: `id:${item.worktreeId}`
        })
      }
      router.push(
        `/h/${hostId}/session/${encodeURIComponent(item.worktreeId)}?name=${encodeURIComponent(item.displayName || item.repo)}`
      )
    },
    [client, connState, hostId, router]
  )

  const handleSortChange = useCallback(
    (value: SortMode) => {
      setSortMode(value)
      if (hostId) void savePreferences(hostId, { sortMode: value })
    },
    [hostId]
  )

  const handleFilterToggle = useCallback(() => {
    setFilterMode((prev) => {
      const next: FilterMode = prev === 'all' ? 'active' : 'all'
      if (hostId) void savePreferences(hostId, { filterMode: next })
      return next
    })
  }, [hostId])

  const handleGroupChange = useCallback(
    (value: GroupMode) => {
      setGroupMode(value)
      if (hostId) void savePreferences(hostId, { groupMode: value })
    },
    [hostId]
  )

  const displayWorktrees =
    connState === 'disconnected' || connState === 'reconnecting' || connState === 'auth-failed'
      ? lastKnownWorktrees
      : worktrees

  const toggleCollapsed = useCallback(
    (title: string) => {
      setCollapsedGroups((prev) => {
        const next = new Set(prev)
        if (next.has(title)) next.delete(title)
        else next.add(title)
        if (hostId) void savePreferences(hostId, { collapsedGroups: [...next] })
        return next
      })
    },
    [hostId]
  )

  const rawSections = useMemo(
    () => buildSections(displayWorktrees, sortMode, filterMode, search, groupMode, pinnedIds),
    [displayWorktrees, sortMode, filterMode, search, groupMode, pinnedIds]
  )

  const sections = useMemo(
    () =>
      rawSections.map((s) => ({
        ...s,
        data: collapsedGroups.has(s.title) ? [] : s.data
      })),
    [rawSections, collapsedGroups]
  )

  const isReadOnly = connState === 'auth-failed'

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    )
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.topChrome}>
        <View style={styles.statusBar}>
          <View style={styles.hostIdentity}>
            <StatusDot state={connState} />
            <Text style={styles.hostNameText} numberOfLines={1}>
              {hostName || 'Host'}
            </Text>
          </View>
          <Text style={styles.statusText}>{STATUS_LABELS[connState]}</Text>
        </View>

        {/* Filter/sort/group toolbar */}
        <View style={styles.toolbar}>
          <Pressable
            style={[styles.filterChip, filterMode === 'active' && styles.filterChipActive]}
            onPress={handleFilterToggle}
          >
            <Text
              style={[
                styles.filterChipText,
                filterMode === 'active' && styles.filterChipTextActive
              ]}
            >
              Active
            </Text>
          </Pressable>

          <Pressable style={styles.sortButton} onPress={() => setShowSortPicker(true)}>
            <SlidersHorizontal size={14} color={colors.textSecondary} />
            <Text style={styles.sortLabel}>
              {sortMode === 'smart' ? 'Smart' : sortMode === 'name' ? 'Name' : 'Recent'}
            </Text>
          </Pressable>

          <Pressable style={styles.groupButton} onPress={() => setShowGroupPicker(true)}>
            <Layers size={14} color={colors.textSecondary} />
            <Text style={styles.sortLabel}>
              {groupMode === 'none' ? 'Group' : groupMode === 'repo' ? 'Repo' : 'PR'}
            </Text>
          </Pressable>

          <View style={styles.toolbarSpacer} />

          <Pressable style={styles.searchToggle} onPress={() => setShowSearch((s) => !s)}>
            {showSearch ? (
              <X size={16} color={colors.textSecondary} />
            ) : (
              <Search size={16} color={colors.textSecondary} />
            )}
          </Pressable>
        </View>
      </View>

      {/* Auth failed banner */}
      {connState === 'auth-failed' && (
        <View style={styles.authBanner}>
          <Text style={styles.authBannerText}>
            Pairing rejected — re-pair from desktop or remove this host.
          </Text>
          <View style={styles.authActions}>
            <Pressable style={styles.authAction} onPress={() => router.push('/pair-scan')}>
              <Text style={styles.authActionText}>Re-pair</Text>
            </Pressable>
            <Pressable style={styles.authAction} onPress={() => setConfirmRemoveHost(true)}>
              <Text style={[styles.authActionText, { color: colors.statusRed }]}>Remove</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* Search bar */}
      {showSearch && (
        <View style={styles.searchBar}>
          <Search size={14} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            value={search}
            onChangeText={setSearch}
            placeholder="Search worktrees…"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch('')}>
              <X size={14} color={colors.textSecondary} />
            </Pressable>
          )}
        </View>
      )}

      {/* Loading state */}
      {((connState === 'connecting' || connState === 'reconnecting') &&
        displayWorktrees.length === 0) ||
      (connState === 'connected' && !worktreesLoaded && displayWorktrees.length === 0) ? (
        <View style={styles.centered}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      ) : null}

      {/* Empty state */}
      {connState === 'connected' && worktreesLoaded && sections.length === 0 && (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>
            {search
              ? 'No matching worktrees'
              : filterMode === 'active'
                ? 'No active worktrees'
                : 'No worktrees'}
          </Text>
        </View>
      )}

      {/* Worktree list */}
      {sections.length > 0 && (
        <SectionList
          sections={sections}
          keyExtractor={(w) => w.worktreeId}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={styles.list}
          renderSectionHeader={({ section }) => {
            if (!section.title) return null
            const isCollapsed = collapsedGroups.has(section.title)
            const rawSection = rawSections.find((s) => s.title === section.title)
            const count = rawSection?.data.length ?? 0
            return (
              <Pressable
                style={styles.sectionHeader}
                onPress={() => toggleCollapsed(section.title)}
              >
                {isCollapsed ? (
                  <ChevronRight size={12} color={colors.textMuted} style={styles.sectionIcon} />
                ) : (
                  <ChevronDown size={12} color={colors.textMuted} style={styles.sectionIcon} />
                )}
                {section.icon === 'pin' && (
                  <Pin size={12} color={colors.textMuted} style={styles.sectionIcon} />
                )}
                <Text style={styles.sectionTitle}>{section.title}</Text>
                <Text style={styles.sectionCount}>{count}</Text>
              </Pressable>
            )
          }}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.worktreeRow, pressed && styles.worktreeRowPressed]}
              disabled={isReadOnly}
              onPress={() => openWorktreeSession(item)}
              onLongPress={() => setActionTarget(item)}
              delayLongPress={400}
            >
              {/* Left indicator */}
              <View style={styles.indicatorCol}>
                <AgentSpinner status={getWorktreeStatus(item)} />
                {item.unread && (
                  <Bell
                    size={10}
                    color={colors.statusAmber}
                    fill={colors.statusAmber}
                    style={styles.unreadBell}
                  />
                )}
              </View>

              {/* Main content */}
              <View style={styles.worktreeMain}>
                <View style={styles.worktreeNameRow}>
                  <Text
                    style={[styles.worktreeName, isReadOnly && styles.textReadOnly]}
                    numberOfLines={1}
                  >
                    {item.displayName || item.repo}
                  </Text>
                  {item.linkedPR && (
                    <View style={styles.prBadge}>
                      <GitPullRequest size={10} color={colors.textSecondary} />
                      <Text style={styles.prNumber}>#{item.linkedPR.number}</Text>
                    </View>
                  )}
                </View>
                <View style={styles.worktreeMetaRow}>
                  <View style={[styles.repoDot, { backgroundColor: repoColor(item.repo) }]} />
                  <Text style={styles.repoName} numberOfLines={1}>
                    {item.repo}
                  </Text>
                  <Text style={styles.branchName} numberOfLines={1}>
                    {item.branch}
                  </Text>
                </View>
                {item.preview ? (
                  <Text style={styles.worktreePreview} numberOfLines={1}>
                    {item.preview}
                  </Text>
                ) : null}
              </View>

              {/* Terminal count */}
              {item.liveTerminalCount > 0 && (
                <Text style={styles.terminalCount}>{item.liveTerminalCount}</Text>
              )}
            </Pressable>
          )}
        />
      )}

      {/* Sort picker modal */}
      <PickerModal
        visible={showSortPicker}
        title="Sort By"
        options={SORT_OPTIONS}
        selected={sortMode}
        onSelect={handleSortChange}
        onClose={() => setShowSortPicker(false)}
      />

      {/* Group picker modal */}
      <PickerModal
        visible={showGroupPicker}
        title="Group By"
        options={GROUP_OPTIONS}
        selected={groupMode}
        onSelect={handleGroupChange}
        onClose={() => setShowGroupPicker(false)}
      />

      {/* Worktree long-press action sheet */}
      <ActionSheetModal
        visible={actionTarget != null}
        title={actionTarget ? actionTarget.displayName || actionTarget.repo : undefined}
        message={actionTarget?.branch}
        actions={
          actionTarget
            ? [
                {
                  label: pinnedIds.has(actionTarget.worktreeId) ? 'Unpin' : 'Pin',
                  onPress: () => togglePin(actionTarget.worktreeId)
                },
                {
                  label: 'Delete',
                  destructive: true,
                  onPress: () => setConfirmDelete(actionTarget)
                }
              ]
            : []
        }
        onClose={() => setActionTarget(null)}
      />

      {/* Worktree delete confirmation */}
      <ActionSheetModal
        visible={confirmDelete != null}
        title="Delete Worktree"
        message={
          confirmDelete
            ? `Delete "${confirmDelete.displayName || confirmDelete.repo}" (${confirmDelete.branch})?`
            : undefined
        }
        actions={
          confirmDelete
            ? [
                {
                  label: 'Delete',
                  destructive: true,
                  onPress: () => {
                    void handleDeleteWorktree(confirmDelete)
                    setConfirmDelete(null)
                  }
                }
              ]
            : []
        }
        onClose={() => setConfirmDelete(null)}
      />

      {/* Host remove confirmation */}
      <ActionSheetModal
        visible={confirmRemoveHost}
        title="Remove Host"
        message={`Remove "${hostName}"? You can re-pair later.`}
        actions={[
          {
            label: 'Remove',
            destructive: true,
            onPress: () => void handleRemoveHost()
          }
        ]}
        onClose={() => setConfirmRemoveHost(false)}
      />
    </SafeAreaView>
  )
}

function repoColor(name: string): string {
  const palette = ['#f97316', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16', '#f59e0b', '#6366f1']
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return palette[Math.abs(hash) % palette.length]!
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  topChrome: {
    backgroundColor: colors.bgPanel,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 34,
    paddingTop: spacing.xs,
    paddingHorizontal: spacing.lg
  },
  hostIdentity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    marginRight: spacing.md
  },
  hostNameText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  statusText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  authBanner: {
    backgroundColor: colors.bgPanel,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  authBannerText: {
    color: colors.statusRed,
    fontSize: 13,
    marginBottom: spacing.sm
  },
  authActions: {
    flexDirection: 'row',
    gap: spacing.lg
  },
  authAction: {
    paddingVertical: spacing.xs
  },
  authActionText: {
    color: colors.accentBlue,
    fontSize: 13,
    fontWeight: '600'
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle
  },
  filterChip: {
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  filterChipActive: {
    borderColor: colors.textSecondary,
    backgroundColor: colors.bgRaised
  },
  filterChipText: {
    fontSize: 12,
    color: colors.textSecondary
  },
  filterChipTextActive: {
    color: colors.textPrimary
  },
  sortButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  groupButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  sortLabel: {
    fontSize: 12,
    color: colors.textSecondary
  },
  toolbarSpacer: {
    flex: 1
  },
  searchToggle: {
    padding: spacing.xs
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  searchInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 13,
    paddingVertical: 2
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize
  },
  list: {
    paddingBottom: spacing.lg
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs
  },
  sectionIcon: {
    marginRight: spacing.xs
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  sectionCount: {
    fontSize: 11,
    color: colors.textMuted,
    marginLeft: spacing.xs
  },
  separator: {
    height: 1,
    backgroundColor: colors.borderSubtle,
    marginLeft: spacing.lg + 24,
    marginRight: spacing.lg
  },
  worktreeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg
  },
  worktreeRowPressed: {
    backgroundColor: colors.bgRaised
  },
  indicatorCol: {
    width: 20,
    alignItems: 'center',
    paddingTop: 3,
    marginRight: spacing.sm,
    gap: 4
  },
  unreadBell: {
    marginTop: 2
  },
  worktreeMain: {
    flex: 1,
    marginRight: spacing.sm
  },
  worktreeNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  worktreeName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    flexShrink: 1
  },
  textReadOnly: {
    opacity: 0.5
  },
  prBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4
  },
  prNumber: {
    fontSize: 10,
    color: colors.textSecondary
  },
  worktreeMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
    gap: spacing.xs
  },
  repoDot: {
    width: 6,
    height: 6,
    borderRadius: 3
  },
  repoName: {
    fontSize: 11,
    color: colors.textSecondary,
    maxWidth: 100
  },
  branchName: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    flexShrink: 1
  },
  worktreePreview: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    marginTop: 2
  },
  terminalCount: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    minWidth: 16,
    textAlign: 'right',
    paddingTop: 3
  }
})
