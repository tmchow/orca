import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Maximize2, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import type { SettingsSearchEntry } from './settings-search'

export const MOBILE_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Mobile Pairing',
    description: 'Pair a mobile device by scanning a QR code.',
    keywords: ['mobile', 'qr', 'code', 'pair', 'phone', 'scan']
  },
  {
    title: 'Connected Devices',
    description: 'Manage paired mobile devices.',
    keywords: ['mobile', 'devices', 'revoke', 'paired', 'connected']
  }
]

type PairedDevice = {
  deviceId: string
  name: string
  pairedAt: number
  lastSeenAt: number
}

export function MobilePane(): React.JSX.Element {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [endpoint, setEndpoint] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [devices, setDevices] = useState<PairedDevice[]>([])
  const [qrEnlarged, setQrEnlarged] = useState(false)

  const loadDevices = useCallback(async () => {
    try {
      const result = await window.api.mobile.listDevices()
      setDevices(result.devices)
    } catch {
      // Silently fail — device list is non-critical
    }
  }, [])

  const generateQR = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.mobile.getPairingQR()
      if (result.available) {
        setQrDataUrl(result.qrDataUrl)
        setEndpoint(result.endpoint)
        void loadDevices()
      } else {
        toast.error('WebSocket transport is not running')
      }
    } catch {
      toast.error('Failed to generate QR code')
    } finally {
      setLoading(false)
    }
  }, [loadDevices])

  useEffect(() => {
    void loadDevices()
  }, [loadDevices])

  async function revokeDevice(deviceId: string) {
    try {
      await window.api.mobile.revokeDevice({ deviceId })
      setDevices((prev) => prev.filter((d) => d.deviceId !== deviceId))
      toast.success('Device revoked')
    } catch {
      toast.error('Failed to revoke device')
    }
  }

  return (
    <div className="space-y-6">
      {qrDataUrl ? (
        <div className="flex items-start gap-8">
          <div className="flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={() => setQrEnlarged(true)}
              className="group relative cursor-pointer rounded-lg border border-border/60 bg-white p-3"
            >
              <img src={qrDataUrl} alt="QR Code for mobile pairing" className="size-48" />
              <Maximize2 className="absolute top-1.5 right-1.5 size-3 text-black/30 opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => void generateQR()}
                disabled={loading}
                size="sm"
                className="gap-1.5"
              >
                <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
                Regenerate
              </Button>
            </div>
            {endpoint && (
              <span className="text-muted-foreground font-mono text-xs">{endpoint}</span>
            )}
          </div>

          <div className="flex-1 pt-0.5">
            <h3 className="mb-2 text-sm font-medium">Paired Devices</h3>
            {devices.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No devices paired yet. Scan the QR code with the Orca mobile app.
              </p>
            ) : (
              <div className="space-y-2">
                {devices.map((device) => (
                  <div
                    key={device.deviceId}
                    className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2"
                  >
                    <div>
                      <div className="text-sm font-medium">{device.name}</div>
                      <div className="text-muted-foreground text-xs">
                        Paired {new Date(device.pairedAt).toLocaleDateString()}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void revokeDevice(device.deviceId)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-muted-foreground mt-4 text-xs">
              Each QR code creates a unique device token. Revoking a device disconnects it
              immediately.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-border/60 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Pair a new device</p>
              <p className="text-muted-foreground text-xs">
                Generate a QR code and scan it with the Orca mobile app to connect.
              </p>
            </div>
            <Button
              onClick={() => void generateQR()}
              disabled={loading}
              size="sm"
              className="gap-1.5"
            >
              <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
              Generate QR Code
            </Button>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium">Paired Devices</h3>
            {devices.length === 0 ? (
              <p className="text-muted-foreground text-sm">No devices paired yet.</p>
            ) : (
              <div className="space-y-2">
                {devices.map((device) => (
                  <div
                    key={device.deviceId}
                    className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2"
                  >
                    <div>
                      <div className="text-sm font-medium">{device.name}</div>
                      <div className="text-muted-foreground text-xs">
                        Paired {new Date(device.pairedAt).toLocaleDateString()}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void revokeDevice(device.deviceId)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <Dialog open={qrEnlarged} onOpenChange={setQrEnlarged}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Scan with Orca Mobile</DialogTitle>
          </DialogHeader>
          {qrDataUrl && (
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-lg bg-white p-4">
                <img src={qrDataUrl} alt="QR Code for mobile pairing" className="size-72" />
              </div>
              {endpoint && (
                <span className="text-muted-foreground font-mono text-xs">{endpoint}</span>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
