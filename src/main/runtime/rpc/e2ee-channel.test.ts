import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { WebSocket } from 'ws'
import { E2EEChannel, type E2EEChannelOptions } from './e2ee-channel'
import { generateKeyPair, deriveSharedKey, encrypt, decrypt } from './e2ee-crypto'

function publicKeyToBase64(key: Uint8Array): string {
  return Buffer.from(key).toString('base64')
}

function createMockWs() {
  const sent: string[] = []
  return {
    OPEN: 1 as const,
    readyState: 1,
    send: vi.fn((data: string) => sent.push(data)),
    close: vi.fn(),
    sent
  }
}

function setup(overrides?: Partial<E2EEChannelOptions>) {
  const serverKeys = generateKeyPair()
  const clientKeys = generateKeyPair()
  const ws = createMockWs()
  const onReady = vi.fn()
  const onError = vi.fn()

  const channel = new E2EEChannel(ws as unknown as WebSocket, {
    serverSecretKey: serverKeys.secretKey,
    validateToken: (token) => token === 'valid-token',
    onReady,
    onError,
    ...overrides
  })

  return { channel, ws, serverKeys, clientKeys, onReady, onError }
}

function doHandshake(ctx: ReturnType<typeof setup>) {
  const hello = JSON.stringify({
    type: 'e2ee_hello',
    publicKeyB64: publicKeyToBase64(ctx.clientKeys.publicKey),
    deviceToken: 'valid-token'
  })
  ctx.channel.handleRawMessage(hello)
  return deriveSharedKey(ctx.clientKeys.secretKey, ctx.serverKeys.publicKey)
}

describe('E2EEChannel', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('handshake', () => {
    it('completes handshake with valid hello', () => {
      const ctx = setup()
      doHandshake(ctx)

      expect(ctx.onReady).toHaveBeenCalledWith(ctx.channel)
      expect(ctx.onError).not.toHaveBeenCalled()
      expect(ctx.channel.deviceToken).toBe('valid-token')

      const readyMsg = JSON.parse(ctx.ws.sent[0]!)
      expect(readyMsg).toEqual({ type: 'e2ee_ready' })
    })

    it('rejects invalid token', () => {
      const ctx = setup()
      ctx.channel.handleRawMessage(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: publicKeyToBase64(ctx.clientKeys.publicKey),
          deviceToken: 'bad-token'
        })
      )

      expect(ctx.onError).toHaveBeenCalledWith(4001, 'Unauthorized')
      expect(ctx.onReady).not.toHaveBeenCalled()
    })

    it('rejects malformed JSON', () => {
      const ctx = setup()
      ctx.channel.handleRawMessage('not json')

      expect(ctx.onError).toHaveBeenCalledWith(4001, 'Invalid handshake message')
    })

    it('rejects missing fields', () => {
      const ctx = setup()
      ctx.channel.handleRawMessage(JSON.stringify({ type: 'e2ee_hello' }))

      expect(ctx.onError).toHaveBeenCalledWith(4001, 'Invalid e2ee_hello')
    })

    it('rejects invalid public key length', () => {
      const ctx = setup()
      ctx.channel.handleRawMessage(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: Buffer.from('short').toString('base64'),
          deviceToken: 'valid-token'
        })
      )

      expect(ctx.onError).toHaveBeenCalledWith(4001, 'Invalid public key')
    })

    it('times out if no hello received', () => {
      const ctx = setup()

      vi.advanceTimersByTime(10_001)

      expect(ctx.onError).toHaveBeenCalledWith(4002, 'E2EE handshake timeout')
    })

    it('clears timeout after successful handshake', () => {
      const ctx = setup()
      doHandshake(ctx)

      vi.advanceTimersByTime(10_001)

      expect(ctx.onError).not.toHaveBeenCalled()
    })
  })

  describe('post-handshake messaging', () => {
    it('decrypts and forwards messages', () => {
      const ctx = setup()
      const sharedKey = doHandshake(ctx)
      const received: string[] = []

      ctx.channel.onMessage((plaintext) => {
        received.push(plaintext)
      })

      const request = '{"id":"rpc-1","method":"status.get"}'
      ctx.channel.handleRawMessage(encrypt(request, sharedKey))

      expect(received).toEqual([request])
    })

    it('provides encrypted reply function', () => {
      const ctx = setup()
      const sharedKey = doHandshake(ctx)

      ctx.channel.onMessage((_plaintext, encryptedReply) => {
        encryptedReply('{"id":"rpc-1","ok":true}')
      })

      ctx.channel.handleRawMessage(encrypt('{"id":"rpc-1","method":"status.get"}', sharedKey))

      // The reply (ws.sent[1], after e2ee_ready) should be encrypted
      const replyEncrypted = ctx.ws.sent[1]!
      const replyPlain = decrypt(replyEncrypted, sharedKey)
      expect(replyPlain).toBe('{"id":"rpc-1","ok":true}')
    })

    it('silently drops messages with wrong key', () => {
      const ctx = setup()
      doHandshake(ctx)
      const received: string[] = []

      ctx.channel.onMessage((plaintext) => {
        received.push(plaintext)
      })

      const attackerKey = deriveSharedKey(generateKeyPair().secretKey, generateKeyPair().publicKey)
      ctx.channel.handleRawMessage(encrypt('attack', attackerKey))

      expect(received).toEqual([])
    })

    it('closes after too many consecutive decrypt failures', () => {
      const ctx = setup()
      doHandshake(ctx)
      ctx.channel.onMessage(() => {})

      const badKey = deriveSharedKey(generateKeyPair().secretKey, generateKeyPair().publicKey)

      for (let i = 0; i < 4; i++) {
        ctx.channel.handleRawMessage(encrypt('bad', badKey))
      }
      expect(ctx.onError).not.toHaveBeenCalled()

      ctx.channel.handleRawMessage(encrypt('bad', badKey))
      expect(ctx.onError).toHaveBeenCalledWith(4003, 'Too many decryption failures')
    })

    it('resets failure count on successful decrypt', () => {
      const ctx = setup()
      const sharedKey = doHandshake(ctx)
      ctx.channel.onMessage(() => {})

      const badKey = deriveSharedKey(generateKeyPair().secretKey, generateKeyPair().publicKey)

      for (let i = 0; i < 4; i++) {
        ctx.channel.handleRawMessage(encrypt('bad', badKey))
      }

      // Successful decrypt resets the counter
      ctx.channel.handleRawMessage(encrypt('good', sharedKey))

      for (let i = 0; i < 4; i++) {
        ctx.channel.handleRawMessage(encrypt('bad', badKey))
      }
      expect(ctx.onError).not.toHaveBeenCalled()
    })
  })

  describe('cross-compatibility', () => {
    it('desktop encrypt is decryptable by desktop decrypt (sanity)', () => {
      const a = generateKeyPair()
      const b = generateKeyPair()
      const sharedA = deriveSharedKey(a.secretKey, b.publicKey)
      const sharedB = deriveSharedKey(b.secretKey, a.publicKey)

      const msg = '{"method":"terminal.subscribe","params":{"terminal":"t1"}}'
      const enc = encrypt(msg, sharedA)
      expect(decrypt(enc, sharedB)).toBe(msg)
    })
  })

  describe('destroy', () => {
    it('clears state and stops forwarding', () => {
      const ctx = setup()
      const sharedKey = doHandshake(ctx)
      const received: string[] = []

      ctx.channel.onMessage((plaintext) => {
        received.push(plaintext)
      })

      ctx.channel.destroy()
      ctx.channel.handleRawMessage(encrypt('after destroy', sharedKey))

      expect(received).toEqual([])
    })
  })
})
