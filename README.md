# poi-plugin-chinjufu-mcp

A [poi](https://github.com/poooi/poi) plugin that exposes poi's live KanColle
game state to MCP clients — Claude Code, or any other MCP-speaking agent — as
read-only tools. No polling poi's cache files, no staleness: every call reads
the redux store the game is actually running.

## Why

poi already holds the complete game state (ships, fleets, resources, master
data...) in memory, live, the moment it's fetched from the game API. This
plugin puts an MCP server in front of that store so an agent can query it
directly, instead of scraping poi's on-disk cache or re-deriving state from
raw `kcsapi` traffic. It is read-only by design: no dispatching actions, no
driving the game webview, no writing anything back.

## Install

Symlink this repo into poi's plugin directory (there is no published npm
package):

```sh
ln -s /path/to/poi-plugin-chinjufu-mcp \
  "$HOME/Library/Application Support/poi/plugins/node_modules/poi-plugin-chinjufu-mcp"
```

Then reload plugins in poi (or restart it). Ships as raw TypeScript with no
build step — poi transpiles `.ts` on `require()`, so edits take effect on the
next plugin reload.

The plugin only starts its server in poi's main window, and only once poi has
given it a working `getStore()`. Its status — listening/stopped/error, the
endpoint URL, and a request counter — is shown in poi's plugin panel.

## Connect an agent

Once the plugin is listening (default `http://127.0.0.1:12450/mcp`):

```sh
claude mcp add poi --transport http http://127.0.0.1:12450/mcp
```

The bound port is also published to `~/.poi-chinjufu-mcp/port` for anything
that needs to discover it programmatically.

## Tools

### `poi_get`

Read a dot path into the redux store, e.g. `info.ships`, `info.fleets`,
`info.basic`, `info.resources`. Readable roots: `info`, `const`, `fcd`, `wctf`,
`battle`, `sortie`, `timers`, `misc`. Allowlisted plugin state is readable one
plugin at a time under `ext`, e.g. the Logbook sortie log at
`ext.poi-plugin-akashic-records._.attack.data` (the `_` is poi's own wrapper
around every plugin reducer); `ext` as a whole is not readable. Plugins are
matched by their exact poi package name, so a fork is a separate entry — the
Logbook EX fork is `ext.poi-plugin-akashic-records-ex`.

Collections (arrays, or objects keyed by id) support:

- **`where`** — a filter expression: `<field> <op> <value|field>`, combined
  with `and`/`or`/`not` and parentheses. Ops: `= == != < <= > >= in contains
  exists`. `contains` is array membership, or a substring test when both sides
  are strings. Fields may be nested or indexed (`api_exp[0]`), and a row that is
  itself an array is addressed by position (`[0]`, `[1]`).
  Examples: `"api_nowhp < api_maxhp"`, `"api_lv >= 99 and api_locked = 1"`,
  `"api_ship_id in [487, 213]"`, `"api_sally_area exists"`,
  `"[2] contains \"Boss\""`.
- **`select`** — fieldpaths to project, e.g. `["api_ship_id", "api_nowhp"]`.
- **`limit`** — max elements returned (default 200).

Single records support `select` only. `maxBytes` caps the serialized response
size (default 65536, hard max 262144); collections are truncated to fit, a
single oversized record is an error instead.

### `poi_lookup`

Resolve master-data ids to their records — turn `api_ship_id` into a ship
name, `api_slotitem_id` into an equipment name, etc. `kind` selects the table
(`ships`, `equips`, `shipTypes`, `equipTypes`, `maps`, `mapareas`, `missions`,
`useitems`, `shipUpgrades`, `shipgraph`, `graphs`, `exslotEquips`,
`exslotEquipShips`); `ids` is required (max 200 per call — these tables are
large, e.g. `const.$ships` alone is ~1.6 MB, so nothing is ever dumped whole).

### `poi_describe`

Discover what's at a store path before querying it: kind, element count,
keys, and the field names of a sample element. Call with no path to list the
readable store roots.

The plugin does no name resolution or derived fields itself — everything
returned is raw `kcsapi` data; joining ids to names is `poi_lookup`'s job, and
interpreting the result is the agent's.

## Development

```sh
npm test           # node:test, via test/*.test.ts
npm run typecheck  # tsc --noEmit
```

`scripts/live-check.ts` exercises the tools against a real running poi
instance rather than the test fixtures:

```sh
node --import tsx scripts/live-check.ts
```

See `CLAUDE.md` for the source layout and the non-obvious constraints of
running inside poi's renderer, and
`docs/superpowers/specs/2026-08-09-poi-plugin-chinjufu-mcp-design.md` for the
full design writeup.

## Translations

The plugin's UI strings (title, description, status panel) are translatable
through poi's own i18n mechanism — see `i18n/*.json`. Traditional Chinese
(`zh-TW`) is included; other poi locales (`en-US`, `ja-JP`, `zh-CN`, `ko-KR`)
fall back to the English source text until translated.

## License

MIT
