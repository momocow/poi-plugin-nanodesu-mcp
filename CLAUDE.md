# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm test                                          # run the whole suite (node:test + tsx)
node --import tsx --test test/paths.test.ts       # run a single test file
node --import tsx --test --test-name-pattern="collision" test/*.test.ts   # filter by test name
npm run typecheck                                 # tsc --noEmit
```

There is no build step and no lint config. Source ships as raw TypeScript;
poi transpiles `.ts` on `require()` at load time (see Architecture).

To exercise the server against a real, running poi instance (not just the unit
tests, which use `test/fixtures/store.json`):

```sh
ln -s "$(pwd)" "$HOME/Library/Application Support/poi/plugins/node_modules/poi-plugin-nanodesu-mcp"
# reload the plugin in poi, then:
node --import tsx scripts/live-check.ts
```

## Architecture

This is a poi plugin (a KanColle browser-game companion app) that runs an MCP
server inside poi's Electron renderer, exposing poi's live redux store —
ship/fleet/resource state, master data — to MCP clients (e.g. Claude Code) as
tools. Reading is the whole of it bar one deliberate exception: `poi_hensei_save`
writes a fleet record into poi-plugin-hensei-nikki (see `src/hensei.ts`), and is
registered only when it can actually write. See `docs/superpowers/specs/2026-08-09-poi-plugin-chinjufu-mcp-design.md`
for the full design rationale; the essentials:

- **`index.ts`** is the poi plugin entry point (`pluginDidLoad`/`pluginWillUnload`).
  It only starts the server in poi's *main* window (`src/poi.ts#isMainWindow`) —
  poi also loads the plugin in secondary windows, and a second instance binding
  the same port would fail with `EADDRINUSE`.
- **`src/server.ts`** builds a stateless Streamable HTTP MCP server
  (`SERVER_NAME`, `DEFAULT_PORT` 12450, `/mcp` and `/health`). Stateless by
  design: a fresh `McpServer`/transport per request, since every tool call reads
  `getStore()` live and there's no session state worth keeping. It publishes its
  bound port to `~/.poi-nanodesu-mcp/port` for clients that need to discover it
  (deliberately not `~/.poi-mcp/port`, which belongs to the unrelated
  `poi-plugin-mcp` package — both can run side by side).
- **`src/tools.ts`** defines the tools: `poi_get` (query a store path),
  `poi_lookup` (resolve master-data ids via `LOOKUP_KINDS`, e.g. ship/equip
  names), `poi_battle` (read a saved battle record by id), `poi_describe`
  (introspect a path's shape before querying it), and `poi_hensei_save` — the
  one tool that writes, see `src/hensei.ts`.
- **`src/hensei.ts`** is the write boundary. poi shares one redux store across
  every plugin and publishes `window.dispatch`, so this plugin can dispatch
  another plugin's action; `poi_hensei_save` does exactly one — hensei-nikki's
  `@@HENSEI_SAVE_DATA`, the same action its own Add button sends. Deliberately
  narrow: adding a record only, never delete or rename, and an existing title
  is refused unless `overwrite: true`, because that plugin's reducer replaces
  `data[title]` outright with no way back. Persistence is *not* ours — its
  `pluginDidLoad` installs a redux-observers observer that writes
  `<APPDATA>/hensei-nikki/<memberId>.json` on every change, so a dispatch lands
  on disk by itself, and writing that file here would mean owning a second copy
  of their format and racing their FileWriter. The `poi-h-v1` conversion is
  loaded from their installed package (`utils/calc.js`) rather than
  reimplemented, for the same reason `src/questline.ts` reads their asset. Two
  preconditions are checked before any dispatch, because both failures
  otherwise look like success: the package must be loadable, and the plugin
  must have state in the store — a dispatch with their reducer unmounted is
  silently discarded. Absent either, `src/server.ts` never registers the tool,
  so a read-only server is the default rather than a setting.
- **`src/paths.ts`** is the security boundary: `ALLOWED_ROOTS` allowlists which
  top-level store branches (`info`, `const`, `fcd`, `wctf`, `battle`, `sortie`,
  `timers`, `misc`) can be read at all; `DENIED_ROOTS` documents *why* the rest
  (`layout`, `plugins`, `ext`, `config`, `ui`) are refused — mostly
  non-serializable or sensitive poi-internal state, not game data. Extending
  what's readable means touching this allowlist deliberately, not just adding a
  path. `ext` is the one root with a second, narrower gate: it can never be read
  whole (its contents are whatever plugins happen to store), but
  `ALLOWED_EXT_PLUGINS` names individual plugins — keyed by the poi package name
  poi's `extendReducer(plugin.packageName, ...)` mounts them under — whose state
  has been read and found plain and serializable. Mind the extra level: poi
  wraps each plugin reducer in `combineReducers({ _: reducer })` to isolate a
  throwing one, so the plugin's own state starts at `ext.<packageName>._`
  (e.g. the Logbook sortie log is
  `ext.poi-plugin-akashic-records._.attack.data`). `readableRoots` is what
  `poi_describe` reports for the root listing, so allowlisted plugin state is
  discoverable only when the running poi actually has it.
- **`src/query.ts`** is a small pure query engine over a resolved store value: a
  hand-written lexer/parser for the `where` expression grammar (`and`/`or`/`not`,
  comparisons, `in`/`contains`/`exists`), plus `select` projection and `limit`.
  `isCollection` is the rule that decides whether a value is treated as a
  keyed/array collection or a single record (all-integer-like keys ⇒ collection).
- **`src/serialize.ts`** makes any store value JSON-safe (drops functions/cycles,
  caps depth) and enforces the `maxBytes` response cap, binary-searching the
  largest prefix of a collection that fits rather than erroring outright.
- **`src/request-log.ts`** turns each incoming JSON-RPC message into a status
  panel entry (time, method, tool, one telling argument) and keeps a bounded
  newest-first log. Entries are not attributed to a client: MCP carries the
  caller's identity only in `initialize`'s `clientInfo`, and this server is
  stateless with no session id, so nothing ties that identity to the tool calls
  that follow. `DEFAULT_RECENT_LIMIT` (100) is only a default; `recentRequests`
  in poi's config picks any number ≥ 1 (`index.ts`, via `readIntConfig`).
- **`src/config.ts`** owns the keys this plugin writes into poi's config, all
  under `plugin.<poiPlugin.id>.*`. poi's config is one shared tree with no
  per-plugin isolation, so the namespace has to be the plugin's own identity —
  not `plugin.mcp.*`, where a second MCP plugin would collide.
- **`src/settings.ts`** is the `settingsClass` poi's settings page renders
  (port, and how many requests the log keeps). poi derives no UI from config
  keys: without this component the settings exist only in `config.cson`.
- **`src/validator.ts`** replaces the MCP SDK's Ajv-based schema validator with
  a passthrough. Necessary because poi puts its own `node_modules` (with Ajv 6)
  ahead of the SDK's bundled Ajv 8 on the require path, and the version
  mismatch crashes `McpServer` construction. Safe only because this server never
  elicits — if that changes, this needs to become a real validator.
- **`src/poi.ts`** reads poi's `window.getStore`/`window.isMain`/`window.config`
  globals rather than importing poi's `views/*` modules — those export
  different things (or nothing, as side-effecting modules) between poi's
  development tree and its released build. Same idea in `src/i18n.ts` for
  `window.i18n`, and in `src/poi-modules.d.ts`'s comment for why `react` is an
  ambient declaration instead of an installed dependency (poi's own copy must
  be the one that resolves, or reconciliation breaks in the shared renderer).
- **`src/server.ts`'s SDK loading** (`loadSdk`) tries `require()` before
  falling back to dynamic `import()`. This is load-bearing, not stylistic: a
  native `import()` never settles inside poi's `file://` renderer under its
  script-src CSP — it doesn't reject, so nothing is logged and the plugin just
  sits at "stopped" forever. `require()` resolves the SDK's CJS build and works.
- **`src/timeout.ts`** (`withTimeout`) exists for the same class of problem —
  turning a promise that might never settle into a bounded failure with a
  message, since a silent hang is otherwise indistinguishable from a slow start.
- **`src/status.ts`** is the poi status-panel `reactClass`, built with
  `React.createElement` (not JSX/hooks) so it works regardless of which React
  version poi supplies. Its user-facing strings route through `src/i18n.ts`'s
  `t()`, which reads poi's `window.i18n[NAMESPACE]` translator (`NAMESPACE` must
  match `poiPlugin.id` in `package.json`) and falls back to the English string
  untranslated. Locale files live in `i18n/<locale>.json` at the repo root —
  see the "poi's plugin i18n" section of the design doc for how poi discovers
  and loads them.

### Data flow for a tool call

`poi_get`/`poi_lookup` → `resolveStorePath` (paths.ts, enforces the allowlist)
→ `applyQuery` (query.ts, where/select/limit) → `fitToBytes` (serialize.ts,
json-safe + byte cap) → MCP tool result. `poiDescribe` skips the query step and
reports shape (kind, key/element counts, sample fields) instead.

`poi_hensei_save` runs the other way: `readHenseiTitles` (hensei.ts, via the
same `resolveStorePath` gate — it doubles as the check that the target plugin's
reducer is mounted) → title/source validation → hensei-nikki's own
`getHenseiDataByApi`/`getHenseiDataByCode` → `buildSaveAction` →
`window.dispatch`. Nothing is serialized back; the result reports only what was
saved.
