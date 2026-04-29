import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { WebSocket } from 'ws'
import { E2EEChannel } from './e2ee-channel'
import { generateKeyPair, deriveSharedKey, encrypt, decrypt } from './e2ee-crypto'

// Why: this test simulates the full mobile → desktop E2EE flow without a real
// WebSocket. The "mobile" side generates an ephemeral keypair, sends e2ee_hello,
// the E2EEChannel (desktop) derives the shared key, and then both sides can
// exchange encrypted RPC messages. This validates that the handshake protocol
// and crypto are end-to-end compatible.

function publicKeyToBase64(key: Uint8Array): string {
  return Buffer.from(key).toString('base64')
}

describe('E2EE integration (simulated mobile ↔ desktop)', () => {
  let serverKeys: ReturnType<typeof generateKeyPair>
  let mobileEphemeralKeys: ReturnType<typeof generateKeyPair>
  let wsSent: string[]
  let mockWs: {
    OPEN: 1
    readyState: number
    send: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
  let channel: E2EEChannel
  let onReady: (channel: E2EEChannel) => void
  let onError: (code: number, reason: string) => void

  beforeEach(() => {
    vi.useFakeTimers()

    serverKeys = generateKeyPair()
    mobileEphemeralKeys = generateKeyPair()
    wsSent = []
    mockWs = {
      OPEN: 1,
      readyState: 1,
      send: vi.fn((data: string) => wsSent.push(data)),
      close: vi.fn()
    }
    onReady = vi.fn() as unknown as (channel: E2EEChannel) => void
    onError = vi.fn() as unknown as (code: number, reason: string) => void

    channel = new E2EEChannel(mockWs as unknown as WebSocket, {
      serverSecretKey: serverKeys.secretKey,
      validateToken: (token) => token === 'device-abc',
      onReady,
      onError
    })
  })

  afterEach(() => {
    channel.destroy()
    vi.useRealTimers()
  })

  it('full handshake → encrypted RPC round-trip', () => {
    // Mobile sends e2ee_hello (plaintext)
    const hello = JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: publicKeyToBase64(mobileEphemeralKeys.publicKey),
      deviceToken: 'device-abc'
    })
    channel.handleRawMessage(hello)

    // Desktop should respond with e2ee_ready
    expect(onReady).toHaveBeenCalled()
    expect(wsSent).toHaveLength(1)
    expect(JSON.parse(wsSent[0]!)).toEqual({ type: 'e2ee_ready' })

    // Both sides derive the same shared key
    const mobileShared = deriveSharedKey(mobileEphemeralKeys.secretKey, serverKeys.publicKey)

    // Set up the desktop message handler
    const desktopReceived: string[] = []
    channel.onMessage((plaintext, encryptedReply) => {
      desktopReceived.push(plaintext)
      encryptedReply(JSON.stringify({ id: 'rpc-1', ok: true, result: { status: 'ready' } }))
    })

    // Mobile sends encrypted RPC request
    const request = JSON.stringify({ id: 'rpc-1', method: 'status.get' })
    channel.handleRawMessage(encrypt(request, mobileShared))

    // Desktop received the plaintext
    expect(desktopReceived).toEqual([request])

    // Desktop's encrypted reply (wsSent[1]) is decryptable by mobile
    expect(wsSent).toHaveLength(2)
    const replyPlain = decrypt(wsSent[1]!, mobileShared)
    expect(JSON.parse(replyPlain!)).toEqual({
      id: 'rpc-1',
      ok: true,
      result: { status: 'ready' }
    })
  })

  it('mobile reconnects with fresh ephemeral key', () => {
    // First connection
    channel.handleRawMessage(
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: publicKeyToBase64(mobileEphemeralKeys.publicKey),
        deviceToken: 'device-abc'
      })
    )
    expect(onReady).toHaveBeenCalledTimes(1)

    const firstShared = deriveSharedKey(mobileEphemeralKeys.secretKey, serverKeys.publicKey)

    // Simulate disconnect + reconnect with new ephemeral key
    channel.destroy()
    wsSent.length = 0

    const newMobileKeys = generateKeyPair()
    const newChannel = new E2EEChannel(mockWs as unknown as WebSocket, {
      serverSecretKey: serverKeys.secretKey,
      validateToken: (token) => token === 'device-abc',
      onReady,
      onError
    })

    newChannel.handleRawMessage(
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: publicKeyToBase64(newMobileKeys.publicKey),
        deviceToken: 'device-abc'
      })
    )

    expect(onReady).toHaveBeenCalledTimes(2)

    const secondShared = deriveSharedKey(newMobileKeys.secretKey, serverKeys.publicKey)

    // Keys from different sessions must not be interchangeable
    expect(Buffer.from(firstShared).toString('hex')).not.toBe(
      Buffer.from(secondShared).toString('hex')
    )

    // Verify new session works
    const received: string[] = []
    newChannel.onMessage((plaintext) => received.push(plaintext))
    newChannel.handleRawMessage(encrypt('{"id":"2","method":"test"}', secondShared))
    expect(received).toEqual(['{"id":"2","method":"test"}'])

    newChannel.destroy()
  })

  it('streaming messages work through E2EE', () => {
    channel.handleRawMessage(
      JSON.stringify({
        type: 'e2ee_hello',
        publicKeyB64: publicKeyToBase64(mobileEphemeralKeys.publicKey),
        deviceToken: 'device-abc'
      })
    )

    const mobileShared = deriveSharedKey(mobileEphemeralKeys.secretKey, serverKeys.publicKey)
    const received: string[] = []

    channel.onMessage((plaintext, encryptedReply) => {
      received.push(plaintext)
      // Simulate streaming: send multiple encrypted responses
      for (let i = 0; i < 3; i++) {
        encryptedReply(
          JSON.stringify({
            id: 'stream-1',
            ok: true,
            streaming: true,
            result: { type: 'data', chunk: `line ${i}\n` }
          })
        )
      }
    })

    channel.handleRawMessage(
      encrypt(JSON.stringify({ id: 'stream-1', method: 'terminal.subscribe' }), mobileShared)
    )

    // 1 e2ee_ready + 3 streaming responses
    expect(wsSent).toHaveLength(4)

    for (let i = 1; i < 4; i++) {
      const plain = decrypt(wsSent[i]!, mobileShared)
      const parsed = JSON.parse(plain!)
      expect(parsed.streaming).toBe(true)
      expect(parsed.result.chunk).toBe(`line ${i - 1}\n`)
    }
  })
})
