/**
 * Read-only overlay of poi-plugin-quest-line's static quest graph.
 *
 * That plugin's *live* state — which quests the game has actually offered — is
 * reachable through `ext.poi-plugin-quest-line` like any other allowlisted
 * plugin. This is the other half: the frozen catalogue of every quest and the
 * prerequisite edges between them, which the plugin ships as an asset and loads
 * with `require()` into a module-local variable. It never reaches poi's store,
 * so no amount of store reading can find it.
 *
 * It is exposed as a store root rather than a fourth tool so the existing
 * where/select/limit machinery applies unchanged. That makes the root a
 * deliberate fiction: `questline` is not a branch of poi's redux store, it is
 * this file. The tradeoff is taken knowingly — a tool of its own would have to
 * restate the whole query surface to read one static table.
 *
 * Nothing here derives anything. The plugin's own UI computes an "available"
 * count by walking this graph against live progress and inferring completion
 * from ancestors; that inference is the plugin's, and reproducing it here would
 * mean owning a second copy of someone else's heuristic. The agent joins this
 * graph to live state itself — see "Name resolution in the plugin" and
 * "Logging or archiving" in the design doc's Non-goals.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The poi package whose asset this reads. */
export const QUEST_LINE_PACKAGE = 'poi-plugin-quest-line'

/** The synthetic store root the graph is published under. */
export const QUEST_LINE_ROOT = 'questline'

export type QuestLineDb = {
  meta?: unknown
  quests: Record<string, unknown>
}

/**
 * Where the asset sits, relative to poi's data directory.
 *
 * poi installs plugins as npm packages under `plugins/node_modules`, so this is
 * the same path poi itself would resolve the package from.
 */
export const questLineAssetPath = (appDataPath: string): string =>
  join(appDataPath, 'plugins', 'node_modules', QUEST_LINE_PACKAGE, 'assets', 'quests.json')

const isQuestLineDb = (value: unknown): value is QuestLineDb =>
  value !== null &&
  typeof value === 'object' &&
  (value as QuestLineDb).quests !== null &&
  typeof (value as QuestLineDb).quests === 'object'

/**
 * Load the quest graph, or return `undefined` if it cannot be had.
 *
 * Every failure is the same non-event: the plugin is not installed, the asset
 * moved in a later version, the file is corrupt. None of them is a reason to
 * fail startup or to take a tool call down, so the root simply does not appear
 * and `poi_describe` stops advertising it.
 */
export function loadQuestLineDb(
  appDataPath: string | undefined,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): QuestLineDb | undefined {
  if (appDataPath === undefined || appDataPath.length === 0) {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFile(questLineAssetPath(appDataPath)))
  } catch {
    return undefined
  }

  return isQuestLineDb(parsed) ? parsed : undefined
}

/**
 * Publish the graph as a root alongside poi's own.
 *
 * A shallow copy per call, so the overlay can never write into poi's state.
 * poi's store object has a couple of dozen keys, which is nothing next to the
 * work of serializing a response.
 */
export function withQuestLine(store: unknown, db: QuestLineDb | undefined): unknown {
  if (db === undefined || store === null || typeof store !== 'object') {
    return store
  }
  return { ...(store as Record<string, unknown>), [QUEST_LINE_ROOT]: db }
}
