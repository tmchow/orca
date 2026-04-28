import { useState, useRef, useCallback } from 'react'
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRouter } from 'expo-router'
import { decodePairingUrl } from '../src/transport/pairing'
import { connect } from '../src/transport/rpc-client'
import { saveHost, getNextHostName } from '../src/transport/host-store'
import type { PairingOffer } from '../src/transport/types'
import { colors, spacing, radii, typography } from '../src/theme/mobile-theme'

export default function PairScanScreen() {
  const router = useRouter()
  const [permission, requestPermission] = useCameraPermissions()
  const [status, setStatus] = useState<'scanning' | 'connecting' | 'error'>('scanning')
  const [errorMessage, setErrorMessage] = useState('')
  const processingRef = useRef(false)

  const handleBarCodeScanned = useCallback(
    ({ data }: { data: string }) => {
      if (processingRef.current) return
      processingRef.current = true

      const offer = decodePairingUrl(data)
      if (!offer) {
        setStatus('error')
        setErrorMessage('Not a valid Orca QR code')
        processingRef.current = false
        return
      }

      void testAndSave(offer)
    },
    [router]
  )

  async function testAndSave(offer: PairingOffer) {
    setStatus('connecting')

    const client = connect(offer.endpoint, offer.deviceToken)

    try {
      const response = await client.sendRequest('status.get')
      client.close()

      if (!response.ok) {
        if (response.error.code === 'unauthorized') {
          setStatus('error')
          setErrorMessage('Authentication failed — token may be expired')
          processingRef.current = false
          return
        }
        setStatus('error')
        setErrorMessage(`Server error: ${response.error.message}`)
        processingRef.current = false
        return
      }

      const hostId = `host-${Date.now()}`
      const hostName = await getNextHostName()

      await saveHost({
        id: hostId,
        name: hostName,
        endpoint: offer.endpoint,
        deviceToken: offer.deviceToken,
        certFingerprint: offer.certFingerprint,
        lastConnected: Date.now()
      })

      router.replace(`/h/${hostId}`)
    } catch {
      setStatus('error')
      setErrorMessage('Cannot connect — check that your computer is on the same network')
      processingRef.current = false
    }
  }

  function retry() {
    setStatus('scanning')
    setErrorMessage('')
    processingRef.current = false
  }

  if (!permission) {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <View style={styles.centered}>
          <Text style={styles.title}>Camera Permission</Text>
          <Text style={styles.subtitle}>
            Orca needs camera access to scan the pairing QR code from your desktop.
          </Text>
          <Pressable style={styles.primaryButton} onPress={requestPermission}>
            <Text style={styles.primaryButtonText}>Grant Camera Access</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <Text style={styles.instruction}>
        Open Orca on your computer, go to Settings → Mobile, and scan the QR code shown there.
      </Text>

      {status === 'scanning' && (
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarCodeScanned}
        />
      )}

      {status === 'connecting' && (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.textSecondary} />
          <Text style={styles.connectingText}>Connecting…</Text>
        </View>
      )}

      {status === 'error' && (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{errorMessage}</Text>
          <Pressable style={styles.primaryButton} onPress={retry}>
            <Text style={styles.primaryButtonText}>Try Again</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    padding: spacing.lg
  },
  instruction: {
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: spacing.lg,
    lineHeight: 18
  },
  camera: {
    flex: 1,
    borderRadius: radii.camera,
    overflow: 'hidden'
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  title: {
    fontSize: typography.titleSize,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.sm
  },
  subtitle: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: spacing.xl,
    lineHeight: 20
  },
  connectingText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    marginTop: spacing.lg
  },
  errorText: {
    color: colors.statusRed,
    fontSize: typography.bodySize,
    textAlign: 'center',
    marginBottom: spacing.xl,
    lineHeight: 20
  },
  primaryButton: {
    backgroundColor: colors.accentBlue,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.button
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
})
