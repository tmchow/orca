import { Modal, View, Text, Pressable, StyleSheet, Platform } from 'react-native'
import { Edit3, Trash2, X, type LucideIcon } from 'lucide-react-native'
import { colors, spacing, radii, typography } from '../theme/mobile-theme'

export type ActionSheetAction = {
  label: string
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

function iconForAction(label: string, destructive?: boolean): LucideIcon {
  if (destructive || /delete|remove/i.test(label)) return Trash2
  return Edit3
}

export function ActionSheetModal({ visible, title, message, actions, onClose }: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.handle} />
          <View style={styles.header}>
            <View style={styles.headerText}>
              {title ? <Text style={styles.title}>{title}</Text> : null}
              {message ? <Text style={styles.message}>{message}</Text> : null}
            </View>
            <Pressable
              style={({ pressed }) => [styles.closeButton, pressed && styles.rowPressed]}
              onPress={onClose}
              accessibilityLabel="Close"
            >
              <X size={18} color={colors.textSecondary} />
            </Pressable>
          </View>

          <View style={styles.actions}>
            {actions.map((action) => {
              const Icon = iconForAction(action.label, action.destructive)
              return (
                <Pressable
                  key={action.label}
                  style={({ pressed }) => [styles.action, pressed && styles.rowPressed]}
                  onPress={() => {
                    onClose()
                    action.onPress()
                  }}
                >
                  <View
                    style={[styles.actionIcon, action.destructive && styles.actionIconDestructive]}
                  >
                    <Icon
                      size={18}
                      color={action.destructive ? colors.statusRed : colors.textSecondary}
                    />
                  </View>
                  <Text
                    style={[styles.actionText, action.destructive && styles.actionTextDestructive]}
                  >
                    {action.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'transparent',
    justifyContent: 'flex-end',
    paddingHorizontal: spacing.sm
  },
  sheet: {
    width: '100%',
    backgroundColor: colors.bgPanel,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.35,
        shadowRadius: 18
      },
      android: { elevation: 12 }
    })
  },
  handle: {
    alignSelf: 'center',
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderSubtle,
    marginBottom: spacing.md
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingBottom: spacing.md
  },
  headerText: {
    flex: 1,
    minWidth: 0,
    paddingRight: spacing.md
  },
  title: {
    fontSize: typography.titleSize,
    fontWeight: '700',
    color: colors.textPrimary,
    marginBottom: spacing.xs
  },
  message: {
    fontSize: 13,
    color: colors.textSecondary,
    lineHeight: 18
  },
  closeButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  actions: {
    gap: spacing.sm
  },
  action: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    borderRadius: radii.row,
    backgroundColor: colors.bgBase,
    overflow: 'hidden'
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  actionIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    marginRight: spacing.md
  },
  actionIconDestructive: {
    backgroundColor: colors.statusRed + '18'
  },
  actionText: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  actionTextDestructive: {
    color: colors.statusRed
  }
})
