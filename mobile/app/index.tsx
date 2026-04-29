import { useState, useCallback, useEffect, useMemo } from 'react'
import { View, Text, StyleSheet, Pressable, FlatList } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter, useFocusEffect } from 'expo-router'
import { MoreHorizontal, QrCode, Server } from 'lucide-react-native'
import { loadHosts, removeHost, renameHost } from '../src/transport/host-store'
import { connect } from '../src/transport/rpc-client'
import type { ConnectionState, HostProfile } from '../src/transport/types'
import { triggerMediumImpact } from '../src/platform/haptics'
import { OrcaLogo } from '../src/components/OrcaLogo'
import { StatusDot } from '../src/components/StatusDot'
import { TextInputModal } from '../src/components/TextInputModal'
import { ActionSheetModal } from '../src/components/ActionSheetModal'
import { colors, spacing, radii, typography } from '../src/theme/mobile-theme'

function endpointLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return `${url.hostname}${url.port ? `:${url.port}` : ''}`
  } catch {
    return endpoint
  }
}

export default function HomeScreen() {
  const router = useRouter()
  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [actionTarget, setActionTarget] = useState<HostProfile | null>(null)
  const [renameTarget, setRenameTarget] = useState<HostProfile | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<HostProfile | null>(null)
  const [hostStates, setHostStates] = useState<Record<string, ConnectionState>>({})

  useFocusEffect(
    useCallback(() => {
      void loadHosts().then(setHosts)
    }, [])
  )

  const sortedHosts = useMemo(
    () => [...hosts].sort((a, b) => b.lastConnected - a.lastConnected),
    [hosts]
  )

  useEffect(() => {
    let disposed = false
    const clients = hosts.map((host) => {
      setHostStates((prev) => ({
        ...prev,
        [host.id]: prev[host.id] ?? 'connecting'
      }))
      return connect(host.endpoint, host.deviceToken, host.publicKeyB64, (state) => {
        if (disposed) return
        setHostStates((prev) => ({ ...prev, [host.id]: state }))
      })
    })

    return () => {
      disposed = true
      for (const client of clients) {
        client.close()
      }
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
            <View style={styles.hero}>
              <Text style={styles.heroTitle}>Desktops</Text>
              <Text style={styles.heroSubtitle}>Continue where your agents are running.</Text>
            </View>
          }
          ItemSeparatorComponent={() => <View style={styles.cardGap} />}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.hostCard, pressed && styles.hostCardPressed]}
              onPress={() => router.push(`/h/${item.id}`)}
              onLongPress={() => {
                triggerMediumImpact()
                setActionTarget(item)
              }}
              delayLongPress={400}
            >
              <View style={styles.hostIcon}>
                <Server size={18} color={colors.textPrimary} />
              </View>
              <View style={styles.hostMain}>
                <View style={styles.hostTitleRow}>
                  <StatusDot state={hostStates[item.id] ?? 'connecting'} />
                  <Text style={styles.hostName} numberOfLines={1}>
                    {item.name}
                  </Text>
                </View>
                <Text style={styles.hostEndpoint} numberOfLines={1}>
                  {endpointLabel(item.endpoint)}
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
                <QrCode size={18} color={colors.accentBlue} />
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

      <ActionSheetModal
        visible={confirmRemove != null}
        title="Remove Host"
        message={`Remove "${confirmRemove?.name}"? You can re-pair later.`}
        actions={[
          {
            label: 'Remove',
            destructive: true,
            onPress: () => void handleRemove()
          }
        ]}
        onClose={() => setConfirmRemove(null)}
      />
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
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
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
    fontSize: 28,
    fontWeight: '800'
  },
  heroSubtitle: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 20,
    marginTop: spacing.xs,
    maxWidth: 320
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
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle
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
  hostEndpoint: {
    color: colors.textSecondary,
    fontSize: 13,
    fontFamily: typography.monoFamily,
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
    backgroundColor: colors.bgBase,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  pairIcon: {
    width: 44,
    height: 44,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentBlue + '18',
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
  }
})
