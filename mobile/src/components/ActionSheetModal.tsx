import { Modal, View, Text, Pressable, StyleSheet, Platform } from 'react-native'
import { Edit3, Trash2, type LucideIcon } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

export type ActionSheetAction = {
  label: string
  icon?: LucideIcon
  destructive?: boolean
  onPress: () => void
}

type Props = {
  visible: boolean
  title?: string
  message?: string
  actions: ActionSheetAction[]
  onClose: () => void
}

function iconForAction(label: string, destructive?: boolean, icon?: LucideIcon): LucideIcon {
  if (icon) return icon
  if (destructive || /delete|remove/i.test(label)) return Trash2
  return Edit3
}

export function ActionSheetModal({ visible, title, message, actions, onClose }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.drawer}>
          <View style={styles.handle} />

          {(title || message) && (
            <View style={styles.header}>
              {title ? (
                <Text style={styles.title} numberOfLines={1}>
                  {title}
                </Text>
              ) : null}
              {message ? <Text style={styles.message}>{message}</Text> : null}
            </View>
          )}

          <View style={styles.actionGroup}>
            {actions.map((action, i) => {
              const Icon = iconForAction(action.label, action.destructive, action.icon)
              return (
                <View key={action.label}>
                  {i > 0 && <View style={styles.separator} />}
                  <Pressable
                    style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
                    onPress={() => {
                      onClose()
                      action.onPress()
                    }}
                  >
                    <Icon
                      size={16}
                      color={action.destructive ? colors.statusRed : colors.textSecondary}
                    />
                    <Text
                      style={[
                        styles.actionText,
                        action.destructive && styles.actionTextDestructive
                      ]}
                    >
                      {action.label}
                    </Text>
                  </Pressable>
                </View>
              )
            })}
          </View>
        </View>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end'
  },
  drawer: {
    backgroundColor: colors.bgBase,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl + spacing.md,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -2 },
        shadowOpacity: 0.2,
        shadowRadius: 10
      },
      android: { elevation: 8 }
    })
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.textMuted,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    opacity: 0.4
  },
  header: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm
  },
  title: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.textMuted
  },
  message: {
    fontSize: 12,
    color: colors.textMuted,
    marginTop: 2
  },
  actionGroup: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  actionPressed: {
    backgroundColor: colors.bgRaised
  },
  actionText: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  actionTextDestructive: {
    color: colors.statusRed
  }
})
