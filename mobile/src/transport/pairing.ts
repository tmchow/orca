import { PairingOfferV1, type PairingOffer } from './types'

export function decodePairingUrl(url: string): PairingOffer | null {
  try {
    const hashIndex = url.indexOf('#')
    if (!url.startsWith('orca://pair') || hashIndex === -1) return null

    const base64url = url.slice(hashIndex + 1)
    const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
    const json = atob(base64)
    const parsed = JSON.parse(json)
    return PairingOfferV1.parse(parsed)
  } catch {
    return null
  }
}
