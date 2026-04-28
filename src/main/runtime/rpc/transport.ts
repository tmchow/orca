// Why: the transport interface decouples the RPC server from a specific
// transport mechanism (Unix socket, WebSocket, named pipe). Each transport
// owns its own connection lifecycle — the RPC server just binds message
// handling to whatever transports are registered.
export type RpcTransport = {
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: (msg: string, reply: (response: string) => void) => void): void
}
