import { z } from 'zod'

export type RpcRequest = {
  id: string
  deviceToken: string
  method: string
  params?: unknown
}

export type RpcSuccess = {
  id: string
  ok: true
  result: unknown
  streaming?: true
  _meta: { runtimeId: string }
}

export type RpcFailure = {
  id: string
  ok: false
  error: { code: string; message: string; data?: unknown }
  _meta: { runtimeId: string }
}

export type RpcResponse = RpcSuccess | RpcFailure

export const PAIRING_OFFER_VERSION = 1

export const PairingOfferV1 = z.object({
  v: z.literal(PAIRING_OFFER_VERSION),
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  certFingerprint: z.string().startsWith('sha256:')
})

export type PairingOffer = z.infer<typeof PairingOfferV1>

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting'

export type HostProfile = {
  id: string
  name: string
  endpoint: string
  deviceToken: string
  certFingerprint: string
  lastConnected: number
}
