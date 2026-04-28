import { useState, useRef, useCallback } from 'react'
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useRouter } from 'expo-router'
import { decodePairingUrl } from '../src/transport/pairing'
import { connect } from '../src/transport/rpc-client'
import { saveHost } from '../src/transport/host-store'
import type { PairingOffer, RpcSuccess } from '../src/transport/types'

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

      const runtimeId = (response as RpcSuccess)._meta.runtimeId
      const hostId = `host-${Date.now()}`

      await saveHost({
        id: hostId,
        name: runtimeId,
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
        <ActivityIndicator color="#3b82f6" />
      </View>
    )
  }

  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Camera Permission</Text>
        <Text style={styles.subtitle}>
          Orca needs camera access to scan the pairing QR code from your desktop.
        </Text>
        <Pressable style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>Grant Camera Access</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Scan QR Code</Text>
      <Text style={styles.subtitle}>
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
          <ActivityIndicator size="large" color="#3b82f6" />
          <Text style={styles.connectingText}>Connecting...</Text>
        </View>
      )}

      {status === 'error' && (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{errorMessage}</Text>
          <Pressable style={styles.button} onPress={retry}>
            <Text style={styles.buttonText}>Try Again</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d0d1a',
    padding: 24
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#e0e0e0',
    marginBottom: 8
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    marginBottom: 24,
    lineHeight: 20
  },
  camera: {
    flex: 1,
    borderRadius: 12,
    overflow: 'hidden'
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  connectingText: {
    color: '#e0e0e0',
    fontSize: 16,
    marginTop: 16
  },
  errorText: {
    color: '#ef4444',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22
  },
  button: {
    backgroundColor: '#3b82f6',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600'
  }
})
