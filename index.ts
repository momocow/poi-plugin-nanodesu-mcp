import { isMainWindow, readAppDataPath, readPortConfig, resolveGetStore } from './src/poi.ts'
import { loadQuestLineDb, withQuestLine } from './src/questline.ts'
import { DEFAULT_PORT, startMcpServer, type ServerHandle } from './src/server.ts'
import { setStatus, StatusPanel } from './src/status.ts'
import { withTimeout } from './src/timeout.ts'

export const PORT_CONFIG_KEY = 'plugin.mcp.port'

/**
 * Startup must either succeed or say why, within a bounded time. Silence is the
 * failure mode that is hardest to diagnose.
 */
export const START_TIMEOUT_MS = 15_000

const LOG_PREFIX = '[poi-plugin-chinjufu-mcp]'

let handle: ServerHandle | undefined

export const reactClass = StatusPanel

export const pluginDidLoad = (): void => {
  const poiWindow = typeof window === 'undefined' ? undefined : window

  // The store exists in plugin windows too, so without this guard a second
  // window would try to bind the same port and fail with EADDRINUSE.
  if (!isMainWindow(poiWindow)) {
    console.log(`${LOG_PREFIX} not the main window; server not started`)
    setStatus({
      state: 'stopped',
      error: 'not the main window — the server runs only in poi’s main window',
      requestCount: 0,
    })
    return
  }

  let getStore
  try {
    getStore = resolveGetStore(poiWindow)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    console.error(`${LOG_PREFIX} cannot reach poi's store:`, e)
    setStatus({ state: 'error', error, requestCount: 0 })
    return
  }

  const port = readPortConfig(poiWindow, PORT_CONFIG_KEY, DEFAULT_PORT)
  console.log(`${LOG_PREFIX} starting on port ${port}…`)

  // Read once at load: the asset is frozen, and a plugin reload re-reads it.
  // Its absence is normal — quest-line simply is not installed — so it is
  // logged and otherwise ignored.
  const questLine = loadQuestLineDb(readAppDataPath(poiWindow))
  if (questLine === undefined) {
    console.log(`${LOG_PREFIX} quest graph unavailable; the 'questline' root is not exposed`)
  }

  withTimeout(
    startMcpServer({
      getStore: () => withQuestLine(getStore(), questLine),
      port,
      onStatus: setStatus,
    }),
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
