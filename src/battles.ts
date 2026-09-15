/**
 * Read-only access to the battle records poi-plugin-battle-detail saves.
 *
 * That plugin writes one gzipped JSON file per battle into poi's data
 * directory, and keeps only a flat index of them in redux. The index says a
 * battle happened — map, route, rank, and the id that names its file — while
 * everything that makes a battle worth looking back at (the fleet that sortied,
 * each ship's level and equipment, the enemy, the result) is in the file.
 *
 * Read one at a time by id, not mounted as a store overlay like the quest
 * graph: there are ~2000 of these, ~8.7 MB compressed and several times that
 * expanded, and a generic read of the branch would pull all of them. A single
 * battle is ~22 KB, which fits a response comfortably.
 *
 * Nothing is derived or summarized here — the raw record is returned and the
 * caller projects what it wants out of it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

/** The poi package whose records these are. */
export const BATTLE_DETAIL_PACKAGE = 'poi-plugin-battle-detail'

export type ReadBattle = (id: number) => unknown

/** Where that plugin keeps its records, relative to poi's data directory. */
export const battleDir = (appDataPath: string): string => join(appDataPath, 'battle-detail')

export const battleFile = (appDataPath: string, id: number): string =>
  join(battleDir(appDataPath), `${id}.json.gz`)

/**
 * Build a reader, or `undefined` when there is nowhere to read from.
 *
 * The absence of a data directory is the one condition knowable up front; a
 * missing or corrupt individual file is not, and surfaces per id instead.
 */
export function makeBattleReader(
  appDataPath: string | undefined,
  readFile: (path: string) => Buffer = (path) => readFileSync(path),
): ReadBattle | undefined {
  if (appDataPath === undefined || appDataPath.length === 0) {
    return undefined
  }

  return (id: number): unknown => {
    const raw = readFile(battleFile(appDataPath, id))
    return JSON.parse(gunzipSync(raw).toString('utf8'))
  }
}
