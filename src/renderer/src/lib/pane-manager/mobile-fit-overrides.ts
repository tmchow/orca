// Why: mobile-fit overrides are runtime-owned state that the renderer must
// respect. When a mobile client resizes a PTY to phone dimensions, the desktop
// renderer must not auto-fit that PTY back to desktop size. This module stores
// the override state and provides lookup for safeFit() and transport.resize().

type FitOverride = {
  mode: 'mobile-fit'
  cols: number
  rows: number
}

const overridesByPtyId = new Map<string, FitOverride>()
const ptyIdByPaneId = new Map<number, string>()

// Why: the override maps are plain JS — React components that read them
// (e.g. the desktop mobile-fit banner) have no way to know when entries
// change. This listener set lets TerminalPane subscribe for re-renders
// and trigger safeFit on affected panes.
type OverrideChangeEvent = {
  ptyId: string
  mode: 'mobile-fit' | 'desktop-fit'
  cols: number
  rows: number
}
type OverrideChangeListener = (event: OverrideChangeEvent) => void
const changeListeners = new Set<OverrideChangeListener>()

export function onOverrideChange(listener: OverrideChangeListener): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function notifyChange(event: OverrideChangeEvent): void {
  for (const listener of changeListeners) {
    listener(event)
  }
}

export function setFitOverride(
  ptyId: string,
  mode: 'mobile-fit' | 'desktop-fit',
  cols: number,
  rows: number
): void {
  if (mode === 'mobile-fit') {
    overridesByPtyId.set(ptyId, { mode, cols, rows })
  } else {
    overridesByPtyId.delete(ptyId)
  }
  notifyChange({ ptyId, mode, cols, rows })
}

export function getPaneIdsForPty(ptyId: string): number[] {
  const result: number[] = []
  for (const [paneId, boundPtyId] of ptyIdByPaneId) {
    if (boundPtyId === ptyId) {
      result.push(paneId)
    }
  }
  return result
}

export function getFitOverrideForPty(ptyId: string): FitOverride | null {
  return overridesByPtyId.get(ptyId) ?? null
}

export function getFitOverrideForPane(paneId: number): FitOverride | null {
  const ptyId = ptyIdByPaneId.get(paneId)
  if (!ptyId) {
    return null
  }
  return overridesByPtyId.get(ptyId) ?? null
}

export function bindPanePtyId(paneId: number, ptyId: string | null): void {
  if (ptyId) {
    ptyIdByPaneId.set(paneId, ptyId)
  } else {
    ptyIdByPaneId.delete(paneId)
  }
}

export function unbindPane(paneId: number): void {
  ptyIdByPaneId.delete(paneId)
}

export function hydrateOverrides(
  overrides: { ptyId: string; mode: 'mobile-fit'; cols: number; rows: number }[]
): void {
  overridesByPtyId.clear()
  for (const o of overrides) {
    overridesByPtyId.set(o.ptyId, { mode: o.mode, cols: o.cols, rows: o.rows })
  }
}

export function getAllOverrides(): Map<string, FitOverride> {
  return new Map(overridesByPtyId)
}
