import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { View, Text, StyleSheet, Pressable, FlatList } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter, useFocusEffect } from 'expo-router'
import {
  Monitor,
  MoreHorizontal,
  QrCode,
  Settings,
  Bot,
  Clock,
  GitPullRequest
} from 'lucide-react-native'
import { loadHosts, removeHost, renameHost } from '../src/transport/host-store'
import { connect, type RpcClient } from '../src/transport/rpc-client'
import { subscribeToDesktopNotifications } from '../src/notifications/mobile-notifications'
import type { ConnectionState, HostProfile } from '../src/transport/types'
import { triggerMediumImpact } from '../src/platform/haptics'
import { OrcaLogo } from '../src/components/OrcaLogo'
import { StatusDot } from '../src/components/StatusDot'
import { TextInputModal } from '../src/components/TextInputModal'
import { ActionSheetModal } from '../src/components/ActionSheetModal'
import { ConfirmModal } from '../src/components/ConfirmModal'
import { colors, spacing, radii, typography } from '../src/theme/mobile-theme'

function endpointLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return `${url.hostname}${url.port ? `:${url.port}` : ''}`
  } catch {
    return endpoint
  }
}

const STATUS_LABELS: Record<ConnectionState, string> = {
  connected: 'Connected',
  connecting: 'Connecting…',
  disconnected: 'Disconnected',
  reconnecting: 'Reconnecting…',
  handshaking: 'Connecting…',
  'auth-failed': 'Auth failed'
}

type StatsSummary = {
  totalAgentsSpawned: number
  totalPRsCreated: number
  totalAgentTimeMs: number
  firstEventAt: number | null
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  const totalHours = Math.floor(totalMinutes / 60)
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  if (days > 0) return `${days}d ${hours}h`
  const minutes = totalMinutes % 60
  if (totalHours > 0) return `${totalHours}h ${minutes}m`
  return `${totalMinutes}m`
}

function fetchStats(client: RpcClient, setStats: (s: StatsSummary) => void) {
  client
    .sendRequest('stats.summary')
    .then((response) => {
      if (response.ok) {
        setStats(response.result as StatsSummary)
      }
    })
    .catch(() => {})
}

export default function HomeScreen() {
  const router = useRouter()
  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [actionTarget, setActionTarget] = useState<HostProfile | null>(null)
  const [renameTarget, setRenameTarget] = useState<HostProfile | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<HostProfile | null>(null)
  const [hostStates, setHostStates] = useState<Record<string, ConnectionState>>({})
  const [stats, setStats] = useState<StatsSummary | null>(null)
  const clientsRef = useRef<RpcClient[]>([])

  useFocusEffect(
    useCallback(() => {
      void loadHosts().then(setHosts)
      // Refetch stats from any connected client when the screen regains focus
      for (const client of clientsRef.current) {
        if (client.getState() === 'connected') {
          fetchStats(client, setStats)
          break
        }
      }
    }, [])
  )

  const sortedHosts = useMemo(
    () => [...hosts].sort((a, b) => b.lastConnected - a.lastConnected),
    [hosts]
  )

  useEffect(() => {
    let disposed = false
    const notifCleanups: Array<() => void> = []
    const clients = hosts.flatMap((host) => {
      if (!host.publicKeyB64 || !host.deviceToken) {
        setHostStates((prev) => ({ ...prev, [host.id]: 'auth-failed' }))
        return []
      }
      setHostStates((prev) => ({
        ...prev,
        [host.id]: prev[host.id] ?? 'connecting'
      }))
      let client: ReturnType<typeof connect>
      try {
        client = connect(host.endpoint, host.deviceToken, host.publicKeyB64, (state) => {
          if (disposed) return
          setHostStates((prev) => ({ ...prev, [host.id]: state }))
        })
      } catch {
        setHostStates((prev) => ({ ...prev, [host.id]: 'auth-failed' }))
        return []
      }

      let unsubNotif: (() => void) | null = null
      let statsFetched = false
      const unsubState = client.onStateChange((state) => {
        if (state === 'connected') {
          if (!unsubNotif) {
            unsubNotif = subscribeToDesktopNotifications(client)
          }
          if (!statsFetched) {
            statsFetched = true
            fetchStats(client, setStats)
          }
        } else if (unsubNotif) {
          unsubNotif()
          unsubNotif = null
        }
      })
      notifCleanups.push(() => {
        unsubState()
        unsubNotif?.()
      })

      return [client]
    })

    clientsRef.current = clients

    return () => {
      disposed = true
      clientsRef.current = []
      for (const cleanup of notifCleanups) cleanup()
      for (const client of clients) client.close()
    }
  }, [hosts])

  async function handleRename(newName: string) {
    if (!renameTarget) return
    await renameHost(renameTarget.id, newName)
    setRenameTarget(null)
    setHosts(await loadHosts())
  }

  async function handleRemove() {
    if (!confirmRemove) return
    await removeHost(confirmRemove.id)
    setConfirmRemove(null)
    setHosts(await loadHosts())
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.topBar}>
        <View style={styles.brandLockup}>
          <View style={styles.logoMark}>
            <OrcaLogo size={18} />
          </View>
          <Text style={styles.brandName}>Orca</Text>
        </View>
      </View>

      {hosts.length === 0 ? (
        <View style={styles.emptyContent}>
          <Text style={styles.emptyTitle}>Pair your first desktop</Text>
          <Text style={styles.emptySubtitle}>
            Scan the QR code from Orca desktop to see live worktrees, terminals, and agent output
            from your phone.
          </Text>
          <Pressable style={styles.primaryButton} onPress={() => router.push('/pair-scan')}>
            <QrCode size={17} color={colors.bgBase} />
            <Text style={styles.primaryButtonText}>Scan Pairing Code</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={sortedHosts}
          keyExtractor={(h) => h.id}
          contentContainerStyle={styles.list}
          ListHeaderComponent={
            <View>
              <View style={styles.hero}>
                <Text style={styles.heroTitle}>Welcome back</Text>
              </View>

              {stats && (
                <View style={styles.statsRow}>
                  <View style={styles.statCard}>
                    <Bot size={14} color={colors.textMuted} />
                    <Text style={styles.statValue}>
                      {stats.totalAgentsSpawned.toLocaleString()}
                    </Text>
                    <Text style={styles.statLabel}>Agents</Text>
                  </View>
                  <View style={styles.statCard}>
                    <Clock size={14} color={colors.textMuted} />
                    <Text style={styles.statValue}>{formatDuration(stats.totalAgentTimeMs)}</Text>
                    <Text style={styles.statLabel}>Agent time</Text>
                  </View>
                  <View style={styles.statCard}>
                    <GitPullRequest size={14} color={colors.textMuted} />
                    <Text style={styles.statValue}>{stats.totalPRsCreated.toLocaleString()}</Text>
                    <Text style={styles.statLabel}>PRs</Text>
                  </View>
                </View>
              )}

              <Text style={styles.sectionHeading}>Desktops</Text>
            </View>
          }
          ItemSeparatorComponent={() => <View style={styles.cardGap} />}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.hostCard, pressed && styles.hostCardPressed]}
              disabled={hostStates[item.id] === 'auth-failed'}
              onPress={() => router.push(`/h/${item.id}`)}
              onLongPress={() => {
                triggerMediumImpact()
                setActionTarget(item)
              }}
              delayLongPress={400}
            >
              <View style={styles.hostIcon}>
                <Monitor size={18} color={colors.textPrimary} />
              </View>
              <View style={styles.hostMain}>
                <View style={styles.hostTitleRow}>
                  <StatusDot state={hostStates[item.id] ?? 'connecting'} />
                  <Text style={styles.hostName} numberOfLines={1}>
                    {item.name}
                  </Text>
                </View>
                <Text style={styles.hostStatus} numberOfLines={1}>
                  {STATUS_LABELS[hostStates[item.id] ?? 'connecting']}
                </Text>
              </View>
              <Pressable
                style={({ pressed }) => [styles.moreButton, pressed && styles.iconButtonPressed]}
                onPress={() => setActionTarget(item)}
                accessibilityLabel={`Manage ${item.name}`}
              >
                <MoreHorizontal size={18} color={colors.textSecondary} />
              </Pressable>
            </Pressable>
          )}
          ListFooterComponent={
            <Pressable style={styles.pairCard} onPress={() => router.push('/pair-scan')}>
              <View style={styles.pairIcon}>
                <QrCode size={18} color={colors.textSecondary} />
              </View>
              <View style={styles.pairTextBlock}>
                <Text style={styles.pairTitle}>Pair another desktop</Text>
                <Text style={styles.pairSubtitle}>Scan a QR code from Orca desktop</Text>
              </View>
            </Pressable>
          }
        />
      )}

      <ActionSheetModal
        visible={actionTarget != null}
        title={actionTarget?.name}
        message={actionTarget ? endpointLabel(actionTarget.endpoint) : undefined}
        actions={[
          {
            label: 'Rename',
            onPress: () => {
              const host = actionTarget
              setActionTarget(null)
              if (host) setRenameTarget(host)
            }
          },
          {
            label: 'Remove',
            destructive: true,
            onPress: () => {
              const host = actionTarget
              setActionTarget(null)
              if (host) setConfirmRemove(host)
            }
          }
        ]}
        onClose={() => setActionTarget(null)}
      />

      <TextInputModal
        visible={renameTarget != null}
        title="Rename Host"
        message="Enter a new name for this host."
        defaultValue={renameTarget?.name ?? ''}
        placeholder="Host name"
        onSubmit={(name) => void handleRename(name)}
        onCancel={() => setRenameTarget(null)}
      />

      <ConfirmModal
        visible={confirmRemove != null}
        title="Remove Host"
        message={`Remove "${confirmRemove?.name}"? You can re-pair later.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => void handleRemove()}
        onCancel={() => setConfirmRemove(null)}
      />

      <Pressable style={styles.settingsButton} onPress={() => router.push('/settings')}>
        <Settings size={16} color={colors.textMuted} />
        <Text style={styles.settingsText}>Settings</Text>
      </Pressable>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md
  },
  brandLockup: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0
  },
  logoMark: {
    marginRight: spacing.sm
  },
  brandName: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: '700'
  },
  iconButtonPressed: {
    backgroundColor: colors.bgRaised
  },
  emptyContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl
  },
  emptyTitle: {
    fontSize: 23,
    fontWeight: '700',
    color: colors.textPrimary,
    textAlign: 'center'
  },
  emptySubtitle: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
    marginTop: spacing.sm,
    marginBottom: spacing.xl
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.button
  },
  primaryButtonText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  list: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xl
  },
  hero: {
    paddingTop: spacing.md,
    paddingBottom: spacing.lg
  },
  heroTitle: {
    color: colors.textPrimary,
    fontSize: 24,
    fontWeight: '800'
  },
  statsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.xl
  },
  statCard: {
    flex: 1,
    backgroundColor: colors.bgPanel,
    borderRadius: 10,
    padding: spacing.md,
    gap: spacing.xs
  },
  statValue: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: '700'
  },
  statLabel: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  sectionHeading: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs
  },
  cardGap: {
    height: spacing.sm
  },
  hostCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 70,
    borderRadius: radii.row,
    backgroundColor: colors.bgPanel
  },
  hostCardPressed: {
    backgroundColor: colors.bgRaised
  },
  hostIcon: {
    width: 44,
    height: 44,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    marginRight: spacing.md
  },
  hostMain: {
    flex: 1,
    minWidth: 0,
    marginRight: spacing.sm
  },
  hostTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0
  },
  hostName: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '700'
  },
  moreButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.xs
  },
  hostStatus: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: spacing.xs
  },
  pairCard: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 70,
    marginTop: spacing.md,
    paddingLeft: spacing.md,
    paddingRight: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.row,
    backgroundColor: colors.bgPanel
  },
  pairIcon: {
    width: 44,
    height: 44,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    marginRight: spacing.md
  },
  pairTextBlock: {
    flex: 1,
    minWidth: 0
  },
  pairTitle: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '700'
  },
  pairSubtitle: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: 2
  },
  settingsButton: {
    flexDirection: 'row',
    alignSelf: 'center',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.xl
  },
  settingsText: {
    fontSize: 13,
    color: colors.textMuted,
    fontWeight: '500'
  }
})
