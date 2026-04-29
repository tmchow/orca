// Why: the E2EE channel sits between the WebSocket transport and the RPC handler.
// It owns the handshake state machine and transparent encrypt/decrypt so the RPC
// handler only sees plaintext JSON, identical to the Unix socket path.
import type { WebSocket } from 'ws'
import { deriveSharedKey, encrypt, decrypt } from './e2ee-crypto'

type ChannelState = 'awaiting_hello' | 'ready'

const HANDSHAKE_TIMEOUT_MS = 10_000
const MAX_CONSECUTIVE_DECRYPT_FAILURES = 5

type E2EEHello = {
  type: 'e2ee_hello'
  publicKeyB64: string
  deviceToken: string
}

export type E2EEChannelOptions = {
  serverSecretKey: Uint8Array
  validateToken: (token: string) => boolean
  onReady: (channel: E2EEChannel) => void
  onError: (code: number, reason: string) => void
}

export class E2EEChannel {
  private state: ChannelState = 'awaiting_hello'
  private sharedKey: Uint8Array | null = null
  private consecutiveFailures = 0
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private readonly ws: WebSocket
  private readonly serverSecretKey: Uint8Array
  private readonly validateToken: (token: string) => boolean
  private readonly onReady: (channel: E2EEChannel) => void
  private readonly onError: (code: number, reason: string) => void
  // Why: the RPC handler is set after the channel is ready, so the channel
  // can forward decrypted messages. Kept as a callback rather than constructor
  // param because the handler needs the encrypt function for replies.
  private messageHandler:
    | ((plaintext: string, encryptedReply: (response: string) => void) => void)
    | null = null

  deviceToken: string | null = null

  constructor(ws: WebSocket, options: E2EEChannelOptions) {
    this.ws = ws
    this.serverSecretKey = options.serverSecretKey
    this.validateToken = options.validateToken
    this.onReady = options.onReady
    this.onError = options.onError

    this.handshakeTimer = setTimeout(() => {
      this.onError(4002, 'E2EE handshake timeout')
    }, HANDSHAKE_TIMEOUT_MS)
  }

  onMessage(
    handler: (plaintext: string, encryptedReply: (response: string) => void) => void
  ): void {
    this.messageHandler = handler
  }

  handleRawMessage(raw: string): void {
    if (this.state === 'awaiting_hello') {
      this.handleHello(raw)
      return
    }

    if (!this.sharedKey) {
      return
    }

    const plaintext = decrypt(raw, this.sharedKey)
    if (plaintext === null) {
      this.consecutiveFailures++
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_DECRYPT_FAILURES) {
        this.onError(4003, 'Too many decryption failures')
      }
      return
    }

    this.consecutiveFailures = 0
    const encryptedReply = (response: string) => {
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(encrypt(response, this.sharedKey!))
      }
    }
    this.messageHandler?.(plaintext, encryptedReply)
  }

  private handleHello(raw: string): void {
    let hello: E2EEHello
    try {
      hello = JSON.parse(raw) as E2EEHello
    } catch {
      this.onError(4001, 'Invalid handshake message')
      return
    }

    if (hello.type !== 'e2ee_hello' || !hello.publicKeyB64 || !hello.deviceToken) {
      this.onError(4001, 'Invalid e2ee_hello')
      return
    }

    if (!this.validateToken(hello.deviceToken)) {
      this.onError(4001, 'Unauthorized')
      return
    }

    this.deviceToken = hello.deviceToken

    // Why: derive the shared key from our secret + client's public key.
    // Both sides compute the same shared secret via ECDH.
    const clientPublicKey = Uint8Array.from(Buffer.from(hello.publicKeyB64, 'base64'))
    if (clientPublicKey.length !== 32) {
      this.onError(4001, 'Invalid public key')
      return
    }

    this.sharedKey = deriveSharedKey(this.serverSecretKey, clientPublicKey)
    this.state = 'ready'

    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }

    // Why: send e2ee_ready as plaintext — the client needs it to know the
    // handshake succeeded before it starts encrypting. The first actual
    // encrypted message from the server will implicitly prove key possession.
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify({ type: 'e2ee_ready' }))
    }

    this.onReady(this)
  }

  destroy(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    this.sharedKey = null
    this.messageHandler = null
  }
}
