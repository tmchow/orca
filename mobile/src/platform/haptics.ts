import * as Haptics from 'expo-haptics'

export function triggerMediumImpact(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {
    // Why: Expo haptics can be unavailable on some Android builds/emulators.
  })
}
