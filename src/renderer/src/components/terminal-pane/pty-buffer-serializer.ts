// Why: mobile terminal streaming needs the exact screen state from the
// desktop's xterm.js instance. This module maintains a global registry of
// serialize functions keyed by ptyId, and handles IPC requests from the
// main process to serialize a specific terminal's buffer.

type SerializeFn = () => { data: string; cols: number; rows: number } | null

const serializersByPtyId = new Map<string, SerializeFn>()
let listenerAttached = false

export function registerPtySerializer(ptyId: string, serialize: SerializeFn): () => void {
  serializersByPtyId.set(ptyId, serialize)
  ensureSerializerListener()
  return () => {
    serializersByPtyId.delete(ptyId)
  }
}

function ensureSerializerListener(): void {
  if (listenerAttached) {
    return
  }
  listenerAttached = true

  window.api.pty.onSerializeBufferRequest((request) => {
    const serializer = serializersByPtyId.get(request.ptyId)
    const result = serializer?.()
    window.api.pty.sendSerializedBuffer(request.requestId, result?.data ?? null)
  })
}
