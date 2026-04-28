// Why: the WebSocket transport enables mobile clients to connect to the Orca
// runtime over the local network. It uses wss:// with a self-signed TLS
// certificate to prevent passive sniffing, and per-device tokens (validated
// by the message handler in OrcaRuntimeRpcServer) instead of the shared
// runtime auth token.
import { createServer as createHttpsServer, type Server as HttpsServer } from 'https'
import { WebSocketServer, type WebSocket } from 'ws'
import type { RpcTransport } from './transport'

const MAX_WS_MESSAGE_BYTES = 1024 * 1024
const MAX_WS_CONNECTIONS = 32

export type WebSocketTransportOptions = {
  host: string
  port: number
  tlsCert: string
  tlsKey: string
}

export class WebSocketTransport implements RpcTransport {
  private readonly host: string
  private readonly port: number
  private readonly tlsCert: string
  private readonly tlsKey: string
  private httpsServer: HttpsServer | null = null
  private wss: WebSocketServer | null = null
  private messageHandler: ((msg: string, reply: (response: string) => void) => void) | null = null

  constructor({ host, port, tlsCert, tlsKey }: WebSocketTransportOptions) {
    this.host = host
    this.port = port
    this.tlsCert = tlsCert
    this.tlsKey = tlsKey
  }

  onMessage(handler: (msg: string, reply: (response: string) => void) => void): void {
    this.messageHandler = handler
  }

  async start(): Promise<void> {
    if (this.wss) {
      return
    }

    const httpsServer = createHttpsServer({
      cert: this.tlsCert,
      key: this.tlsKey
    })

    const wss = new WebSocketServer({
      server: httpsServer,
      maxPayload: MAX_WS_MESSAGE_BYTES
    })

    wss.on('connection', (ws) => {
      if (wss.clients.size > MAX_WS_CONNECTIONS) {
        ws.close(1013, 'Maximum connections reached')
        return
      }
      this.handleConnection(ws)
    })

    await new Promise<void>((resolve, reject) => {
      httpsServer.once('error', reject)
      httpsServer.listen(this.port, this.host, () => {
        httpsServer.off('error', reject)
        resolve()
      })
    })

    this.httpsServer = httpsServer
    this.wss = wss
  }

  async stop(): Promise<void> {
    const wss = this.wss
    const httpsServer = this.httpsServer
    this.wss = null
    this.httpsServer = null

    if (wss) {
      for (const client of wss.clients) {
        client.close(1001, 'Server shutting down')
      }
      wss.close()
    }

    if (httpsServer) {
      await new Promise<void>((resolve, reject) => {
        httpsServer.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    }
  }

  // Why: WebSocket connections are long-lived (unlike Unix socket which is
  // one-per-request). Multiple requests can be multiplexed on the same
  // connection via the RPC `id` field. The transport delegates all auth
  // and dispatch logic to the message handler set by OrcaRuntimeRpcServer.
  private handleConnection(ws: WebSocket): void {
    ws.on('message', (data) => {
      const msg = typeof data === 'string' ? data : data.toString('utf-8')
      this.messageHandler?.(msg, (response) => {
        // Why: mobile clients disconnect frequently (backgrounding, network
        // switch, phone locked). Guard writes to avoid errors on dead sockets.
        if (ws.readyState === ws.OPEN) {
          ws.send(response)
        }
      })
    })

    ws.on('error', () => {
      ws.close()
    })
  }
}
