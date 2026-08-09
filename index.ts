import { getStore } from 'views/create-store'
import { config, isMain } from 'views/env'

import { DEFAULT_PORT, startMcpServer, type ServerHandle } from './src/server.ts'
import { setStatus, StatusPanel } from './src/status.ts'

export const PORT_CONFIG_KEY = 'plugin.mcp.port'

let handle: ServerHandle | undefined

export const reactClass = StatusPanel

export const pluginDidLoad = (): void => {
  // The store exists in plugin windows too, so without this guard a second
  // window would try to bind the same port and fail with EADDRINUSE.
  if (!isMain) {
    return
  }

  const port = config.get(PORT_CONFIG_KEY, DEFAULT_PORT)

  startMcpServer({
    getStore: () => getStore(),
    port,
    onStatus: setStatus,
  })
    .then((started) => {
      handle = started
    })
    .catch((e: unknown) => {
      // Surfaced in the status panel and left down. Deliberately not retried on
      // a fallback port: that would silently change the URL and break an
      // agent's config while appearing to work.
      const error = e instanceof Error ? e.message : String(e)
      setStatus({ state: 'error', error, requestCount: 0 })
      console.error('[poi-plugin-game-mcp] failed to start:', e)
    })
}

export const pluginWillUnload = (): void => {
  const started = handle
  handle = undefined
  if (!started) {
    return
  }
  started.close().catch((e: unknown) => {
    console.error('[poi-plugin-game-mcp] failed to stop cleanly:', e)
  })
  setStatus({ state: 'stopped', requestCount: 0 })
}
