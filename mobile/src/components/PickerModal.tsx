import { Modal, View, Text, Pressable, StyleSheet, Platform } from 'react-native'
import { Check } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'

export type PickerOption<T extends string = string> = {
  value: T
  label: string
  subtitle?: string
}

type Props<T extends string = string> = {
  visible: boolean
  title: string
  options: PickerOption<T>[]
  selected: T
  onSelect: (value: T) => void
  onClose: () => void
}

export function PickerModal<T extends string = string>({
  visible,
  title,
  options,
  selected,
  onSelect,
  onClose
}: Props<T>) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.drawer}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
          </View>

          <View style={styles.group}>
            {options.map((opt, i) => {
              const isSelected = opt.value === selected
              return (
                <View key={opt.value}>
                  {i > 0 && <View style={styles.separator} />}
                  <Pressable
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                    onPress={() => {
                      onSelect(opt.value)
                      onClose()
                    }}
                  >
                    <View style={styles.rowContent}>
                      <Text style={[styles.rowLabel, isSelected && styles.rowLabelSelected]}>
                        {opt.label}
                      </Text>
                      {opt.subtitle ? <Text style={styles.rowSubtitle}>{opt.subtitle}</Text> : null}
                    </View>
                    {isSelected && <Check size={16} color={colors.textPrimary} />}
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
  group: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden'
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  rowContent: {
    flex: 1
  },
  rowLabel: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  rowLabelSelected: {
    fontWeight: '600'
  },
  rowSubtitle: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1
  }
})
