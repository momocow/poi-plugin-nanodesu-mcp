import { getStore } from 'views/create-store'
import { config, isMain } from 'views/env'

import { DEFAULT_PORT, startMcpServer, type ServerHandle } from './src/server.ts'
import { setStatus, StatusPanel } from './src/status.ts'
import { withTimeout } from './src/timeout.ts'

export const PORT_CONFIG_KEY = 'plugin.mcp.port'

/**
 * Startup must either succeed or say why, within a bounded time. An earlier
 * version could hang here forever with the panel reading "stopped" and nothing
 * in the console — the failure mode that is hardest to diagnose.
 */
export const START_TIMEOUT_MS = 15_000

const LOG_PREFIX = '[poi-plugin-game-mcp]'

let handle: ServerHandle | undefined

export const reactClass = StatusPanel

export const pluginDidLoad = (): void => {
  // The store exists in plugin windows too, so without this guard a second
  // window would try to bind the same port and fail with EADDRINUSE.
  if (!isMain) {
    console.log(`${LOG_PREFIX} not the main window (isMain=${String(isMain)}); server not started`)
    setStatus({
      state: 'stopped',
      error: 'not the main window — the server runs only in poi’s main window',
      requestCount: 0,
    })
    return
  }

  let port: number
  try {
    port = config.get(PORT_CONFIG_KEY, DEFAULT_PORT)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error(`${LOG_PREFIX} could not read ${PORT_CONFIG_KEY}:`, e)
    setStatus({ state: 'error', error: `could not read config: ${error}`, requestCount: 0 })
    return
  }

  console.log(`${LOG_PREFIX} starting on port ${port}…`)

  withTimeout(
    startMcpServer({ getStore: () => getStore(), port, onStatus: setStatus }),
    START_TIMEOUT_MS,
    `startup did not finish within ${START_TIMEOUT_MS} ms`,
  )
    .then((started) => {
      handle = started
      console.log(`${LOG_PREFIX} listening on http://127.0.0.1:${started.port}/mcp`)
    })
    .catch((e: unknown) => {
      // Surfaced in the status panel and left down. Deliberately not retried on
      // a fallback port: that would silently change the URL and break an
      // agent's config while appearing to work.
      const error = e instanceof Error ? e.message : String(e)
      setStatus({ state: 'error', error, requestCount: 0 })
      console.error(`${LOG_PREFIX} failed to start:`, e)
    })
}

export const pluginWillUnload = (): void => {
  const started = handle
  handle = undefined
  if (!started) {
    return
  }
  started.close().catch((e: unknown) => {
    console.error(`${LOG_PREFIX} failed to stop cleanly:`, e)
  })
  setStatus({ state: 'stopped', requestCount: 0 })
}
