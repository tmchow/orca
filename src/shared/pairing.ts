import { z } from 'zod'

export const PAIRING_OFFER_VERSION = 1

export const PairingOfferV1 = z.object({
  v: z.literal(PAIRING_OFFER_VERSION),
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  certFingerprint: z.string().startsWith('sha256:')
})

export type PairingOffer = z.infer<typeof PairingOfferV1>

export function encodePairingOffer(offer: PairingOffer): string {
  const json = JSON.stringify(offer)
  const base64url = Buffer.from(json, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `orca://pair#${base64url}`
}

export function decodePairingOffer(url: string): PairingOffer {
  const hashIndex = url.indexOf('#')
  if (!url.startsWith('orca://pair') || hashIndex === -1) {
    throw new Error('Invalid pairing URL: must start with orca://pair#')
  }
  const base64url = url.slice(hashIndex + 1)
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const json = Buffer.from(base64, 'base64').toString('utf-8')
  return PairingOfferV1.parse(JSON.parse(json))
}
