import { BrowserWindow, ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStatus, RuntimeSyncWindowGraph } from '../../shared/runtime-types'

export function registerRuntimeHandlers(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler('runtime:syncWindowGraph')
  ipcMain.removeHandler('runtime:getStatus')

  ipcMain.handle(
    'runtime:syncWindowGraph',
    (event, graph: RuntimeSyncWindowGraph): RuntimeStatus => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) {
        throw new Error('Runtime graph sync must originate from a BrowserWindow')
      }
      return runtime.syncWindowGraph(window.id, graph)
    }
  )

  ipcMain.handle('runtime:getStatus', (): RuntimeStatus => {
    return runtime.getStatus()
  })

  ipcMain.removeHandler('runtime:getTerminalFitOverrides')
  ipcMain.handle(
    'runtime:getTerminalFitOverrides',
    (): { ptyId: string; mode: 'mobile-fit'; cols: number; rows: number }[] => {
      const overrides = runtime.getAllTerminalFitOverrides()
      return Array.from(overrides.entries()).map(([ptyId, override]) => ({
        ptyId,
        ...override
      }))
    }
  )

  // Why: the desktop "Restore" button needs to clear a mobile-fit override
  // without going through the mobile RPC path. Any clientId is accepted
  // because the desktop user has physical access to the machine.
  ipcMain.removeHandler('runtime:restoreTerminalFit')
  ipcMain.handle('runtime:restoreTerminalFit', (_event, args: { ptyId: string }) => {
    const override = runtime.getTerminalFitOverride(args.ptyId)
    if (!override) {
      return { restored: false }
    }
    try {
      runtime.resizeForClient(args.ptyId, 'restore', override.clientId)
      return { restored: true }
    } catch {
      return { restored: false }
    }
  })
}
