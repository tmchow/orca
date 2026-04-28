import { describe, expect, it } from 'vitest'
import { encodePairingOffer, decodePairingOffer, type PairingOffer } from './pairing'

describe('pairing offer', () => {
  const offer: PairingOffer = {
    v: 1,
    endpoint: 'wss://192.168.1.10:6768',
    deviceToken: 'abcdef1234567890abcdef1234567890abcdef1234567890',
    certFingerprint: 'sha256:deadbeef'
  }

  it('encode then decode round-trips correctly', () => {
    const url = encodePairingOffer(offer)
    expect(url).toMatch(/^orca:\/\/pair#/)

    const decoded = decodePairingOffer(url)
    expect(decoded).toEqual(offer)
  })

  it('encoded URL uses base64url (no +, /, or = characters)', () => {
    const url = encodePairingOffer(offer)
    const fragment = url.split('#')[1]!
    expect(fragment).not.toMatch(/[+/=]/)
  })

  it('rejects URLs with wrong scheme', () => {
    expect(() => decodePairingOffer('https://example.com#abc')).toThrow('Invalid pairing URL')
  })

  it('rejects URLs without fragment', () => {
    expect(() => decodePairingOffer('orca://pair')).toThrow('Invalid pairing URL')
  })

  it('rejects payloads with missing fields', () => {
    const partial = { v: 1, endpoint: 'wss://host:1234' }
    const base64 = Buffer.from(JSON.stringify(partial)).toString('base64')
    expect(() => decodePairingOffer(`orca://pair#${base64}`)).toThrow()
  })

  it('rejects payloads with wrong version', () => {
    const wrong = { ...offer, v: 2 }
    const base64 = Buffer.from(JSON.stringify(wrong)).toString('base64')
    expect(() => decodePairingOffer(`orca://pair#${base64}`)).toThrow()
  })

  it('rejects payloads with invalid fingerprint prefix', () => {
    const wrong = { ...offer, certFingerprint: 'md5:abc' }
    const base64 = Buffer.from(JSON.stringify(wrong)).toString('base64')
    expect(() => decodePairingOffer(`orca://pair#${base64}`)).toThrow()
  })
})
