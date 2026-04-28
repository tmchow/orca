import { ipcMain } from 'electron'
import { networkInterfaces } from 'os'
import QRCode from 'qrcode'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'

// Why: the WebSocket transport advertises 0.0.0.0 as its endpoint, which isn't
// connectable from a mobile device. We resolve the first non-internal IPv4
// address so the QR code contains a reachable LAN IP.
function getLanAddress(): string | null {
  const interfaces = networkInterfaces()
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) {
      continue
    }
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address
      }
    }
  }
  return null
}

// Why: the mobile IPC handlers provide the renderer with QR code pairing data,
// device management, and WebSocket readiness status. They depend on the
// OrcaRuntimeRpcServer because it owns the device registry and TLS state.

export function registerMobileHandlers(rpcServer: OrcaRuntimeRpcServer): void {
  ipcMain.handle('mobile:getPairingQR', async () => {
    const rawEndpoint = rpcServer.getWebSocketEndpoint()
    const registry = rpcServer.getDeviceRegistry()
    if (!rawEndpoint || !registry) {
      return { available: false as const }
    }

    const lanIp = getLanAddress()
    if (!lanIp) {
      return { available: false as const }
    }
    const endpoint = rawEndpoint.replace('0.0.0.0', lanIp)

    const device = registry.addDevice(`Mobile ${new Date().toLocaleDateString()}`)

    // Why: certFingerprint is 'sha256:pending' when TLS is disabled (Phase 1
    // will add cert pinning on mobile). The mobile app stores it but doesn't
    // enforce it until TLS is re-enabled.
    const fingerprint = rpcServer.getTlsFingerprint() ?? 'sha256:pending'

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
