import { ipcMain } from 'electron'
import QRCode from 'qrcode'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'

// Why: the mobile IPC handlers provide the renderer with QR code pairing data,
// device management, and WebSocket readiness status. They depend on the
// OrcaRuntimeRpcServer because it owns the device registry and TLS state.

export function registerMobileHandlers(rpcServer: OrcaRuntimeRpcServer): void {
  ipcMain.handle('mobile:getPairingQR', async () => {
    const endpoint = rpcServer.getWebSocketEndpoint()
    const fingerprint = rpcServer.getTlsFingerprint()
    const registry = rpcServer.getDeviceRegistry()
    if (!endpoint || !fingerprint || !registry) {
      return { available: false as const }
    }

    const device = registry.addDevice(`Mobile ${new Date().toLocaleDateString()}`)

    const url = encodePairingOffer({
      v: PAIRING_OFFER_VERSION,
      endpoint,
      deviceToken: device.token,
      certFingerprint: fingerprint
    })

    const qrDataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 256
    })

    return {
      available: true as const,
      qrDataUrl,
      endpoint,
      deviceId: device.deviceId
    }
  })

  ipcMain.handle('mobile:listDevices', () => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { devices: [] }
    }
    return {
      devices: registry.listDevices().map((d) => ({
        deviceId: d.deviceId,
        name: d.name,
        pairedAt: d.pairedAt,
        lastSeenAt: d.lastSeenAt
      }))
    }
  })

  ipcMain.handle('mobile:revokeDevice', (_event, args: { deviceId: string }) => {
    const registry = rpcServer.getDeviceRegistry()
    if (!registry) {
      return { revoked: false }
    }
    return { revoked: registry.removeDevice(args.deviceId) }
  })

  ipcMain.handle('mobile:isWebSocketReady', () => {
    return {
      ready: rpcServer.getWebSocketEndpoint() !== null,
      endpoint: rpcServer.getWebSocketEndpoint()
    }
  })
}
