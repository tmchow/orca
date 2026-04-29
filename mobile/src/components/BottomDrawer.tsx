import { type ReactNode, useCallback, useEffect } from 'react'
import { Modal, View, Pressable, StyleSheet, Platform, useWindowDimensions } from 'react-native'
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation
} from 'react-native-reanimated'
import { colors, spacing } from '../theme/mobile-theme'

const DISMISS_THRESHOLD = 80
const SPRING_CONFIG = { damping: 20, stiffness: 300 }
// Why: negative translateY (pulling up) is damped with a rubber-band factor
// so the drawer resists upward dragging — a subtle polish touch that signals
// the drawer cannot expand further.
const RUBBER_BAND_FACTOR = 0.25

type Props = {
  visible: boolean
  onClose: () => void
  children: ReactNode
}

export function BottomDrawer({ visible, onClose, children }: Props) {
  const translateY = useSharedValue(0)
  const backdropOpacity = useSharedValue(0)
  const { height: screenHeight } = useWindowDimensions()

  useEffect(() => {
    if (visible) {
      translateY.value = 0
      backdropOpacity.value = withTiming(1, { duration: 200 })
    }
  }, [visible])

  const dismiss = useCallback(() => {
    onClose()
  }, [onClose])

  const panGesture = Gesture.Pan()
    .onUpdate((e) => {
      if (e.translationY > 0) {
        translateY.value = e.translationY
      } else {
        translateY.value = e.translationY * RUBBER_BAND_FACTOR
      }
    })
    .onEnd((e) => {
      if (e.translationY > DISMISS_THRESHOLD || e.velocityY > 500) {
        translateY.value = withTiming(screenHeight, { duration: 200 })
        backdropOpacity.value = withTiming(0, { duration: 200 })
        runOnJS(dismiss)()
      } else {
        translateY.value = withSpring(0, SPRING_CONFIG)
      }
    })

  const drawerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }]
  }))

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: interpolate(translateY.value, [0, 300], [1, 0], Extrapolation.CLAMP)
  }))

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <GestureHandlerRootView style={styles.root}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} />
        </Animated.View>

        <View style={styles.anchor} pointerEvents="box-none">
          <GestureDetector gesture={panGesture}>
            <Animated.View style={[styles.drawer, drawerStyle]}>
              <View style={styles.handle} />
              {children}
            </Animated.View>
          </GestureDetector>
        </View>
      </GestureHandlerRootView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)'
  },
  anchor: {
    flex: 1,
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
  }
})
