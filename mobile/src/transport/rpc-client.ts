import type { RpcRequest, RpcResponse, RpcSuccess, ConnectionState } from './types'

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
}

type StreamingListener = (result: unknown) => void

export type RpcClient = {
  sendRequest: (method: string, params?: unknown) => Promise<RpcResponse>
  subscribe: (method: string, params: unknown, onData: StreamingListener) => () => void
  getState: () => ConnectionState
  onStateChange: (listener: (state: ConnectionState) => void) => () => void
  close: () => void
}

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000]
const REQUEST_TIMEOUT_MS = 30_000

export function connect(
  endpoint: string,
  deviceToken: string,
  onStateChange?: (state: ConnectionState) => void
): RpcClient {
  let ws: WebSocket | null = null
  let state: ConnectionState = 'disconnected'
  let requestCounter = 0
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let intentionallyClosed = false

  const pending = new Map<string, PendingRequest>()
  const streamListeners = new Map<string, StreamingListener>()
  const stateListeners = new Set<(state: ConnectionState) => void>()
  // Callers that are waiting for the socket to reach 'connected' state
  const connectWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = []

  if (onStateChange) {
    stateListeners.add(onStateChange)
  }

  function setState(next: ConnectionState) {
    if (state === next) return
    state = next
    if (next === 'connected') {
      for (const w of connectWaiters.splice(0)) w.resolve()
    } else if (next === 'disconnected') {
      for (const w of connectWaiters.splice(0)) w.reject(new Error('Connection closed'))
    }
    for (const listener of stateListeners) {
      listener(next)
    }
  }

  function waitForConnected(): Promise<void> {
    if (state === 'connected') return Promise.resolve()
    if (intentionallyClosed) return Promise.reject(new Error('Client closed'))
    return new Promise((resolve, reject) => {
      connectWaiters.push({ resolve, reject })
    })
  }

  function nextId(): string {
    return `rpc-${++requestCounter}-${Date.now()}`
  }

  function openConnection() {
    if (intentionallyClosed) return

    setState('connecting')

    ws = new WebSocket(endpoint)

    ws.onopen = () => {
      reconnectAttempt = 0
      setState('connected')
    }

    ws.onmessage = (event) => {
      let response: RpcResponse
      try {
        response = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }

      const isStreaming = response.ok && (response as RpcSuccess).streaming === true

      if (isStreaming) {
        const listener = streamListeners.get(response.id)
        if (listener && response.ok) {
          listener((response as RpcSuccess).result)
        }
        return
      }

      // Non-streaming: check if it's a final streaming message (type: 'end')
      // or a one-shot response
      if (response.ok) {
        const result = (response as RpcSuccess).result as Record<string, unknown> | null
        if (result && result.type === 'end') {
          const listener = streamListeners.get(response.id)
          if (listener) {
            listener(result)
            streamListeners.delete(response.id)
            return
          }
        }
        // Scrollback (first message from terminal.subscribe) also goes to stream listener
        if (result && result.type === 'scrollback') {
          const listener = streamListeners.get(response.id)
          if (listener) {
            listener(result)
            return
          }
        }
      }

      const req = pending.get(response.id)
      if (req) {
        pending.delete(response.id)
        req.resolve(response)
      }
    }

    ws.onclose = () => {
      ws = null
      if (intentionallyClosed) {
        setState('disconnected')
        rejectAllPending('Connection closed')
        return
      }
      setState('reconnecting')
      scheduleReconnect()
    }

    ws.onerror = () => {
      // onclose will fire after this
    }
  }

  function scheduleReconnect() {
    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempt, RECONNECT_DELAYS.length - 1)]!
    reconnectAttempt++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      openConnection()
    }, delay)
  }

  function rejectAllPending(reason: string) {
    for (const [id, req] of pending) {
      req.reject(new Error(reason))
      pending.delete(id)
    }
  }

  function sendRaw(request: RpcRequest) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(request))
    }
  }

  openConnection()

  return {
    async sendRequest(method: string, params?: unknown): Promise<RpcResponse> {
      await waitForConnected()

      return new Promise((resolve, reject) => {
        const id = nextId()
        const timeout = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Request timed out: ${method}`))
        }, REQUEST_TIMEOUT_MS)

        pending.set(id, {
          resolve: (response) => {
            clearTimeout(timeout)
            resolve(response)
          },
          reject: (error) => {
            clearTimeout(timeout)
            reject(error)
          }
        })

        sendRaw({ id, deviceToken, method, params })
      })
    },

    subscribe(method: string, params: unknown, onData: StreamingListener): () => void {
      const id = nextId()
      streamListeners.set(id, onData)
      sendRaw({ id, deviceToken, method, params })

      return () => {
        streamListeners.delete(id)
        sendRaw({
          id: nextId(),
          deviceToken,
          method: 'terminal.unsubscribe',
          params: { subscriptionId: id }
        })
      }
    },

    getState(): ConnectionState {
      return state
    },

    onStateChange(listener: (state: ConnectionState) => void): () => void {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },

    close() {
      intentionallyClosed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (ws) {
        ws.close()
        ws = null
      }
      setState('disconnected')
      rejectAllPending('Client closed')
    }
  }
}
