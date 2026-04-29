// Why: this is the single security boundary for the bundled CLI. It owns
// auth-token enforcement, bootstrap-metadata publication, and transport
// orchestration so a running runtime is always discoverable via exactly
// one on-disk file. Method handling lives in `rpc/` and transport specifics
// live in `rpc/unix-socket-transport.ts` and `rpc/ws-transport.ts`.
import { randomBytes } from 'crypto'
import { join } from 'path'
import type { RuntimeMetadata, RuntimeTransportMetadata } from '../../shared/runtime-bootstrap'
import type { OrcaRuntimeService } from './orca-runtime'
import { writeRuntimeMetadata } from './runtime-metadata'
import { RpcDispatcher } from './rpc/dispatcher'
import type { RpcRequest, RpcResponse } from './rpc/core'
import { errorResponse } from './rpc/errors'
import type { RpcTransport } from './rpc/transport'
import { UnixSocketTransport } from './rpc/unix-socket-transport'
import { WebSocketTransport } from './rpc/ws-transport'
import type { WebSocket } from 'ws'
import { DeviceRegistry } from './device-registry'
import { loadOrCreateE2EEKeypair, type E2EEKeypair } from './e2ee-keypair'
import { E2EEChannel } from './rpc/e2ee-channel'

const DEFAULT_WS_PORT = 6768

type OrcaRuntimeRpcServerOptions = {
  runtime: OrcaRuntimeService
  userDataPath: string
  pid?: number
  platform?: NodeJS.Platform
  enableWebSocket?: boolean
  wsPort?: number
}

export class OrcaRuntimeRpcServer {
  private readonly runtime: OrcaRuntimeService
  private readonly dispatcher: RpcDispatcher
  private readonly userDataPath: string
  private readonly pid: number
  private readonly platform: NodeJS.Platform
  private readonly enableWebSocket: boolean
  private readonly wsPort: number
  private readonly authToken = randomBytes(24).toString('hex')
  private deviceRegistry: DeviceRegistry | null = null
  private e2eeKeypair: E2EEKeypair | null = null
  private tlsFingerprint: string | null = null
  private activeTransports: RpcTransport[] = []
  private transports: RuntimeTransportMetadata[] = []
  // Why: each WebSocket connection has its own E2EE channel that manages the
  // handshake and encrypt/decrypt lifecycle. Keyed by WebSocket instance.
  private e2eeChannels = new Map<WebSocket, E2EEChannel>()

  constructor({
    runtime,
    userDataPath,
    pid = process.pid,
    platform = process.platform,
    enableWebSocket = false,
    wsPort = DEFAULT_WS_PORT
  }: OrcaRuntimeRpcServerOptions) {
    this.runtime = runtime
    this.dispatcher = new RpcDispatcher({ runtime })
    this.userDataPath = userDataPath
    this.pid = pid
    this.platform = platform
    this.enableWebSocket = enableWebSocket
    this.wsPort = wsPort
  }

  getDeviceRegistry(): DeviceRegistry | null {
    return this.deviceRegistry
  }

  getTlsFingerprint(): string | null {
    return this.tlsFingerprint
  }

  getE2EEPublicKey(): string | null {
    return this.e2eeKeypair?.publicKeyB64 ?? null
  }

  getE2EEKeypair(): E2EEKeypair | null {
    return this.e2eeKeypair
  }

  getWebSocketEndpoint(): string | null {
    const ws = this.transports.find((t) => t.kind === 'websocket')
    return ws?.endpoint ?? null
  }

  async start(): Promise<void> {
    if (this.activeTransports.length > 0) {
      return
    }

    const transportMeta = createRuntimeTransportMetadata(
      this.userDataPath,
      this.pid,
      this.platform,
      this.runtime.getRuntimeId()
    )

    const socketTransport = new UnixSocketTransport({
      endpoint: transportMeta.endpoint,
      kind: transportMeta.kind as 'unix' | 'named-pipe'
    })

    // Why: Unix socket transport uses the shared runtime auth token. This is
    // the existing security model for CLI connections — the token lives in a
    // 0o600-permissioned file on disk.
    socketTransport.onMessage((msg, reply) => {
      void this.handleMessage(msg).then((response) => {
        reply(JSON.stringify(response))
      })
    })

    await socketTransport.start()

    const activeTransports: RpcTransport[] = [socketTransport]
    const transportsMeta: RuntimeTransportMetadata[] = [transportMeta]

    // Why: WebSocket transport is opt-in and starts alongside the Unix socket.
    // It uses per-device tokens and E2EE (application-layer encryption via
    // tweetnacl) rather than TLS, since React Native can't pin self-signed certs.
    if (this.enableWebSocket) {
      try {
        this.deviceRegistry = new DeviceRegistry(this.userDataPath)
        this.e2eeKeypair = loadOrCreateE2EEKeypair(this.userDataPath)

        const wsTransport = new WebSocketTransport({
          host: '0.0.0.0',
          port: this.wsPort
        })

        // Why: each WebSocket connection gets an E2EE channel that handles the
        // handshake before any RPC messages are processed. The channel decrypts
        // inbound messages and encrypts outbound replies transparently.
        wsTransport.onMessage((msg, _reply, ws) => {
          let channel = this.e2eeChannels.get(ws)
          if (!channel) {
            channel = new E2EEChannel(ws, {
              serverSecretKey: this.e2eeKeypair!.secretKey,
              validateToken: (token) => this.deviceRegistry?.validateToken(token) != null,
              onReady: (ch) => {
                if (ch.deviceToken) {
                  wsTransport.setClientId(ws, ch.deviceToken)
                }
              },
              onError: (code, reason) => {
                this.e2eeChannels.get(ws)?.destroy()
                this.e2eeChannels.delete(ws)
                ws.close(code, reason)
              }
            })
            channel.onMessage((plaintext, encryptedReply) => {
              void this.handleWebSocketMessage(plaintext, encryptedReply, wsTransport, ws)
            })
            this.e2eeChannels.set(ws, channel)
          }
          channel.handleRawMessage(msg)
        })

        // Why: when a mobile client disconnects, the runtime must clean up
        // connection-scoped state like mobile-fit overrides and the E2EE
        // channel to prevent orphaned state.
        wsTransport.onConnectionClose((clientId) => {
          for (const [ws, channel] of this.e2eeChannels) {
            if (channel.deviceToken === clientId) {
              channel.destroy()
              this.e2eeChannels.delete(ws)
              break
            }
          }
          this.runtime.onClientDisconnected(clientId)
        })

        await wsTransport.start()
        activeTransports.push(wsTransport)
        transportsMeta.push({
          kind: 'websocket',
          endpoint: `ws://0.0.0.0:${wsTransport.resolvedPort}`
        })
      } catch (error) {
        // Why: WebSocket transport is supplementary — the runtime must still
        // function if it fails to start (e.g., port in use). Log and continue
        // with Unix socket only.
        console.error('[runtime] Failed to start WebSocket transport:', error)
      }
    }

    // Why: publish the transport into in-memory state before writing metadata
    // so the bootstrap file always contains the real endpoint/token pair. The
    // CLI only discovers the runtime through that file.
    this.activeTransports = activeTransports
    this.transports = transportsMeta

    try {
      this.writeMetadata()
    } catch (error) {
      // Why: a runtime that cannot publish bootstrap metadata is invisible to
      // the `orca` CLI. Close all transports immediately instead of leaving
      // behind a live but undiscoverable control plane.
      this.activeTransports = []
      this.transports = []
      await Promise.all(activeTransports.map((t) => t.stop().catch(() => {}))).catch(() => {})
      throw error
    }
  }

  async stop(): Promise<void> {
    const transports = this.activeTransports
    this.activeTransports = []
    this.transports = []
    if (transports.length === 0) {
      return
    }
    await Promise.all(transports.map((t) => t.stop()))
    // Why: we intentionally leave the last metadata file behind instead of
    // deleting it on shutdown. Shared userData paths can briefly host multiple
    // Orca processes during restarts, updates, or development, and stale
    // metadata is safer than letting one process erase another live runtime's
    // bootstrap file.
  }

  // Why: Unix socket messages use one-shot dispatch (single response per
  // request) and the shared runtime auth token from the 0o600 metadata file.
  private async handleMessage(rawMessage: string): Promise<RpcResponse> {
    // Why: empty messages are sent by the Unix socket transport layer when a
    // client exceeds the max message size. The transport closes the connection
    // after this response.
    if (!rawMessage) {
      return this.buildError('unknown', 'request_too_large', 'RPC request exceeds the maximum size')
    }

    let request: RpcRequest
    try {
      request = JSON.parse(rawMessage) as RpcRequest
    } catch {
      return this.buildError('unknown', 'bad_request', 'Invalid JSON request')
    }

    if (typeof request.id !== 'string' || request.id.length === 0) {
      return this.buildError('unknown', 'bad_request', 'Missing request id')
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      return this.buildError(request.id, 'bad_request', 'Missing RPC method')
    }
    if (typeof request.authToken !== 'string' || request.authToken.length === 0) {
      return this.buildError(request.id, 'unauthorized', 'Missing auth token')
    }
    if (request.authToken !== this.authToken) {
      return this.buildError(request.id, 'unauthorized', 'Invalid auth token')
    }

    return this.dispatcher.dispatch(request)
  }

  // Why: WebSocket messages go through streaming dispatch which can emit
  // multiple responses. Auth uses per-device tokens from the device registry.
  private async handleWebSocketMessage(
    rawMessage: string,
    reply: (response: string) => void,
    wsTransport?: WebSocketTransport,
    ws?: WebSocket
  ): Promise<void> {
    let request: RpcRequest
    try {
      request = JSON.parse(rawMessage) as RpcRequest
    } catch {
      reply(JSON.stringify(this.buildError('unknown', 'bad_request', 'Invalid JSON request')))
      return
    }

    if (typeof request.id !== 'string' || request.id.length === 0) {
      reply(JSON.stringify(this.buildError('unknown', 'bad_request', 'Missing request id')))
      return
    }
    if (typeof request.method !== 'string' || request.method.length === 0) {
      reply(JSON.stringify(this.buildError(request.id, 'bad_request', 'Missing RPC method')))
      return
    }

    const token =
      typeof (request as Record<string, unknown>).deviceToken === 'string'
        ? ((request as Record<string, unknown>).deviceToken as string)
        : null
    if (!token) {
      reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Missing device token')))
      return
    }
    if (!this.deviceRegistry?.validateToken(token)) {
      reply(JSON.stringify(this.buildError(request.id, 'unauthorized', 'Invalid device token')))
      return
    }

    // Why: associate the deviceToken with this WebSocket so ws.on('close')
    // can notify the runtime which mobile client disconnected.
    if (wsTransport && ws) {
      wsTransport.setClientId(ws, token)
    }

    await this.dispatcher.dispatchStreaming(request, reply)
  }

  private buildError(id: string, code: string, message: string): RpcResponse {
    return errorResponse(id, { runtimeId: this.runtime.getRuntimeId() }, code, message)
  }

  private writeMetadata(): void {
    const metadata: RuntimeMetadata = {
      runtimeId: this.runtime.getRuntimeId(),
      pid: this.pid,
      transports: this.transports,
      authToken: this.authToken,
      startedAt: this.runtime.getStartedAt()
    }
    writeRuntimeMetadata(this.userDataPath, metadata)
  }
}

export function createRuntimeTransportMetadata(
  userDataPath: string,
  pid: number,
  platform: NodeJS.Platform,
  runtimeId = 'runtime'
): RuntimeTransportMetadata {
  const endpointSuffix = runtimeId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 4) || 'rt'
  if (platform === 'win32') {
    return {
      kind: 'named-pipe',
      // Why: Windows named pipes do not get the same chmod hardening path as
      // Unix sockets, so include a per-runtime suffix to avoid exposing a
      // stable, guessable control endpoint name across launches.
      endpoint: `\\\\.\\pipe\\orca-${pid}-${endpointSuffix}`
    }
  }
  return {
    kind: 'unix',
    endpoint: join(userDataPath, `o-${pid}-${endpointSuffix}.sock`)
  }
}
