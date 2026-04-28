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
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.title}>{title}</Text>
          <View style={styles.options}>
            {options.map((opt) => {
              const isSelected = opt.value === selected
              return (
                <Pressable
                  key={opt.value}
                  style={[styles.option, isSelected && styles.optionSelected]}
                  onPress={() => {
                    onSelect(opt.value)
                    onClose()
                  }}
                >
                  <View style={styles.optionContent}>
                    <Text style={[styles.optionLabel, isSelected && styles.optionLabelSelected]}>
                      {opt.label}
                    </Text>
                    {opt.subtitle ? (
                      <Text style={styles.optionSubtitle}>{opt.subtitle}</Text>
                    ) : null}
                  </View>
                  {isSelected && <Check size={16} color={colors.textPrimary} />}
                </Pressable>
              )
            })}
          </View>
          <Pressable style={styles.closeButton} onPress={onClose}>
            <Text style={styles.closeText}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xl
  },
  card: {
    width: '100%',
    maxWidth: 320,
    backgroundColor: colors.bgPanel,
    borderRadius: 14,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 12
      },
      android: { elevation: 8 }
    })
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm
  },
  options: {
    paddingBottom: spacing.xs
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg
  },
  optionSelected: {
    backgroundColor: colors.bgRaised
  },
  optionContent: {
    flex: 1
  },
  optionLabel: {
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  optionLabelSelected: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  optionSubtitle: {
    fontSize: 11,
    color: colors.textMuted,
    marginTop: 1
  },
  closeButton: {
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    marginTop: spacing.xs
  },
  closeText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  }
})
