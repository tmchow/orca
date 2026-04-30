// Why: module-level cache lets the home screen pre-populate worktree data
// so the host detail page can render instantly on navigation instead of
// waiting for a fresh RPC connection + fetch cycle.

type CachedWorktrees = {
  worktrees: unknown[]
  at: number
}

const cache = new Map<string, CachedWorktrees>()

const MAX_AGE_MS = 30_000

export function setCachedWorktrees(hostId: string, worktrees: unknown[]): void {
  cache.set(hostId, { worktrees, at: Date.now() })
}

export function getCachedWorktrees(hostId: string): unknown[] | null {
  const entry = cache.get(hostId)
  if (!entry) return null
  if (Date.now() - entry.at > MAX_AGE_MS) {
    cache.delete(hostId)
    return null
  }
  return entry.worktrees
}
