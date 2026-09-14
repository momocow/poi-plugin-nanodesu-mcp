# poi-plugin-chinjufu-mcp — Design

**Date:** 2026-08-09
**Status:** Approved, ready for implementation planning

## Problem

poi holds the complete live KanColle game state in a redux store inside its
Electron renderer. An agent has no access to it.

The state is also cached to disk — `views/redux/create-store.ts:30` mirrors the
`const`, `info`, `fcd`, and `wctf` branches into `localStorage._storeCache`,
which Electron persists to LevelDB under
`~/Library/Application Support/poi/Local Storage/leveldb/`. That cache is
readable, and reading it proved the data is all there, but it is written on a
5-second debounce and requires copying an 8 MB database out from under a running
process and parsing it. It is a snapshot, not a live view.

This plugin gives agents live, on-demand reads of the running store.

## Goals

- Read current game state from the running poi instance, with no staleness.
- Speak MCP, so an agent gets typed tools rather than an HTTP API to hand-roll.
- Return raw store data. Agents map ids to human-readable names themselves.
- Keep every response small enough to sit in an agent's context.
- Never destabilise poi.

## Non-goals

These were considered and explicitly cut:

- **Pushing events.** No notifications on battle end, docking completion, or
  quest progress. Consumption is pull-based.
- **Writing or acting.** No dispatching redux actions, no driving the game
  webview. Read-only.
- **Logging or archiving.** No snapshot history, no API traffic capture.
- **Name resolution in the plugin.** No joining `api_ship_id` to `api_name`, no
  derived fields, no human-readable views. The agent does this.
- **MCP resource subscriptions.** `resources/subscribe` and
  `notifications/resources/updated` exist in the protocol, but server-initiated
  messages need a stateful session and a GET SSE stream, and a notification only
  tells a client a resource is stale — it cannot start an agent turn. Since
  every tool call already reads the store live, that invalidation buys nothing.
  Ruled out deliberately; see "Transport" for the stateless choice it implies.

## Architecture

```
poi renderer (main window only)
  └─ poi-plugin-chinjufu-mcp
       ├─ pluginDidLoad     → start server
       ├─ pluginWillUnload  → close server
       └─ MCP / Streamable HTTP on 127.0.0.1:12450/mcp
              ↑
        Claude Code  (claude mcp add --transport http)
```

The plugin runs inside poi's renderer, where the store lives. `app.ts:285` sets
`nodeIntegration: true` and `contextIsolation: false` for the main window, so
the plugin can open a socket directly. Every tool call reads `getStore()`
synchronously at request time; nothing is cached.

### Placement and build

Developed at `~/kancolle/poi-plugin-chinjufu-mcp`, symlinked into poi's plugin
directory:

```sh
ln -s ~/kancolle/poi-plugin-chinjufu-mcp \
  "$HOME/Library/Application Support/poi/plugins/node_modules/poi-plugin-chinjufu-mcp"
```

poi globs plugins from `PLUGIN_PATH/node_modules/poi-plugin-*`
(`views/services/plugin-manager/index.ts:47`), so a symlink is picked up like an
installed package.

Ships raw TypeScript with no build step. poi's babel hook transpiles `.es`,
`.ts`, and `.tsx` on require and deliberately does not skip `node_modules`
(`babel-register.config.js`, and the `ignoreNodeModules: false` comment in
`babel-hook.js:52`). Edits take effect on a plugin reload.

### Repo layout

```
poi-plugin-chinjufu-mcp/
  package.json          main: index.ts, poiPlugin metadata
  tsconfig.json
  index.ts              poi plugin contract
  src/
    server.ts           http + MCP wiring, lifecycle
    tools.ts            tool definitions and handlers
    query.ts            where parser, select, limit    (pure)
    serialize.ts        json-safe serializer, byte cap (pure)
    paths.ts            allowlist and path resolution  (pure)
    status.tsx          status panel reactClass
  test/
    query.test.ts
    serialize.test.ts
    paths.test.ts
    tools.test.ts
    fixtures/store.json trimmed real store snapshot
```

`package.json` declares plugin metadata under `poiPlugin` (`title`,
`description`, `icon`, `priority`), matching the convention in
`views/services/plugin-manager/types.ts`.

### Lifecycle

`pluginDidLoad` starts the server; `pluginWillUnload` closes it and drops
in-flight requests.

**The server starts only when `isMain` is true.** The store also exists in
plugin windows — `create-store.ts` branches on `isMain` throughout — so without
this guard a second window would try to bind the same port and fail with
`EADDRINUSE`. `isMain` comes from `views/env-parts/const`.

### Transport

Streamable HTTP, `POST /mcp`, bound to `127.0.0.1`. Default port 12450,
overridable via poi config key `plugin.mcp.port`. The bind host is fixed and not
configurable.

**Stateless mode** (`sessionIdGenerator: undefined`). The tools are read-only
with no subscriptions, so there is no session state worth keeping, and nothing
to leak across a plugin reload. No SSE stream is needed.

DNS-rebinding protection is enabled, with `Host` and `Origin` validated against
`127.0.0.1:<port>` and `localhost:<port>`.

**The SDK is loaded with `require`,** falling back to dynamic `import()`.

This reverses the original design, which had it backwards on two counts. The
SDK is not ESM-only — 1.30 is dual-published with a `require` condition — and
the native `import()` chosen "for robustness" is precisely what fails in poi:
on a `file://` page under a `script-src` CSP, it never settles. Not rejects,
*never settles*, so nothing is logged and no `.catch` can fire.

The observed symptom was the plugin sitting at "stopped" with a completely
clean console. `require` is also the natural call in poi, whose plugin system
is CJS throughout. The `import()` fallback remains for a future ESM-only SDK.

### Startup must not fail silently

Two guards, both added after the hang above:

- **Startup is bounded** by `START_TIMEOUT_MS` (15 s). A promise that never
  settles becomes a visible error instead of indefinite silence.
- **Every early return reports itself.** The `isMain` skip and a config-read
  failure now set an explanatory status and log, rather than returning quietly
  and leaving the panel indistinguishable from "never started".

### Health endpoint

`GET /health` returns 200 with the server identity, the live port, and whether
the store has game data yet:

```json
{ "status": "ok", "name": "poi-chinjufu-mcp", "version": "0.1.0",
  "port": 12450, "storeReady": true }
```

`storeReady` is false before login — it reports whether the store has an `info`
branch, and returns false rather than throwing if reading the store fails. The
endpoint stays `ok` either way: it answers "is the bridge up", not "is the game
loaded".

No CORS headers are sent, here or anywhere else. That is deliberate: without
them a web page cannot read these responses cross-origin, which matters because
the server is reachable from any process on the machine.

### Port file

The listening port is published to `~/.poi-chinjufu-mcp/port` (directory `0700`,
file `0600`), and the file is removed on close. This is what makes discovery
possible when the port has been changed from the default.

The path deliberately differs from the unrelated `poi-plugin-mcp` package's
`~/.poi-mcp/port`, so both plugins can run at once without overwriting each
other.

Writing the file is a convenience and never a reason to fail startup: if the
write fails the server logs a warning and carries on listening. `portFile: null`
disables it, which is what the tests use so they never touch the real path.

### Status panel

The plugin's `reactClass` renders a minimal panel: port, bind state, last
request timestamp, and the bind error if there was one. Without it a failed bind
is invisible.

## Tools

### `poi_get(path, where?, select?, limit?, maxBytes?, treatAs?)`

Reads live state.

| Param | Type | Default | Notes |
|---|---|---|---|
| `path` | string | required | Dot path into the redux root, e.g. `info.ships` |
| `where` | string | none | Filter expression, grammar below |
| `select` | string[] | all fields | Fieldpaths to keep |
| `limit` | number | 200 | Max elements returned |
| `maxBytes` | number | 65536 | Serialized cap, hard maximum 262144 |
| `treatAs` | `"collection"` \| `"value"` | inferred | Overrides the collection heuristic |

How `where`, `select`, and `limit` apply depends on whether the value at `path`
is a collection or a value — see "Collection vs value" below.

### `poi_lookup(kind, ids, select?)`

Reads master data. `ids` is **required** — this tool exists so the master tables
can never be dumped whole by accident. `const.$ships` alone is ~1.6 MB of the
8 MB store.

Maximum 200 ids per call.

| `kind` | Store path |
|---|---|
| `ships` | `const.$ships` |
| `equips` | `const.$equips` |
| `shipTypes` | `const.$shipTypes` |
| `equipTypes` | `const.$equipTypes` |
| `maps` | `const.$maps` |
| `mapareas` | `const.$mapareas` |
| `missions` | `const.$missions` |
| `useitems` | `const.$useitems` |
| `shipUpgrades` | `const.$shipUpgrades` |
| `shipgraph` | `const.$shipgraph` |
| `graphs` | `const.$graphs` |
| `exslotEquips` | `const.$exslotEquips` |
| `exslotEquipShips` | `const.$exslotEquipShips` |

### `poi_describe(path)`

Discovery. Returns the type at `path`, the element count, the first 50 keys, and
the field names of a sample element. Without it an agent guesses at paths and
field names and burns calls on errors.

```
poi_describe("info")
→ { path:"info", kind:"object",
    keys:["basic","ships","fleets","equips","repairs","constructions",
          "resources","maps","quests","airbase","presets","server","useitems"] }

poi_describe("info.ships")
→ { path:"info.ships", kind:"object-map", total:381,
    sampleKeys:["38761","43830", ...],
    sampleFields:["api_id","api_ship_id","api_lv","api_exp","api_nowhp",
                  "api_maxhp","api_cond","api_slot","api_slot_ex", ...] }
```

### Example flow

```
poi_get("info.ships", where:"api_nowhp < api_maxhp",
        select:["api_id","api_ship_id","api_nowhp","api_maxhp"])
→ { path:"info.ships", kind:"object-map", total:381, returned:3,
    truncated:false,
    items:{ "38761":{api_id:38761,api_ship_id:487,api_nowhp:18,api_maxhp:31},
            ... } }

poi_lookup("ships", [487], select:["api_name","api_stype"])
→ { "487": { api_name:"長鯨", api_stype:22 } }
```

## Query semantics

### `where` grammar

Recursive-descent parser, hand-written. **No `eval`.**

```
expr       := term (('and' | 'or') term)*
term       := 'not' term | '(' expr ')' | comparison
comparison := fieldpath op operand
op         := '=' | '==' | '!=' | '<' | '<=' | '>' | '>='
            | 'in' | 'contains' | 'exists'
operand    := number | string | boolean | null | array | fieldpath
fieldpath  := ident ('.' ident | '[' int ']')*
```

Precedence, tightest first: `not`, comparison, `and`, `or`. Parentheses
override.

`exists` is a unary postfix operator and takes no operand.

Comparing a field to another field is the reason this grammar exists rather than
a structured filter object:

```
api_nowhp < api_maxhp
api_lv >= 99 and api_locked = 1
api_ship_id in [487, 213]
api_sally_area exists
not (api_cond < 40) and api_lv > 1
```

### Evaluation rules

- **Any comparison involving an undefined operand is false.** No three-valued
  logic. A typo'd field name matches nothing rather than erroring or matching
  everything; `poi_describe` is how you find the right name.
- `exists` returns false for undefined, true otherwise. `not x exists` is the
  way to test absence.
- Numbers compare numerically, strings lexicographically. A comparison between
  mismatched types is false.
- `in` tests membership of the left value in a right-hand array.
- `contains` tests that a left-hand array contains the right value, or — when
  both sides are strings — that the left string contains the right as a
  substring. Types are never coerced across the two forms: `api_slot contains
  "12043"` is false for a numeric slot list, and `api_name contains 2` is false
  rather than matching a stringified name.
- A row that is itself an array is addressed by position: `[0] > 1`. `[0]` is
  ambiguous in isolation — it is also a valid one-element array literal — so the
  lexer resolves it by the preceding token: a field can only follow the start of
  the expression, `and`/`or`/`not`, or `(`, while a value can only follow an
  operator, `in`, `contains`, or a comma. This is what lets
  `[3] in ["出撃", "進撃"]` mean the obvious thing on both sides.

### `select`

Accepts the same fieldpath syntax as `where`, including nested and indexed
paths. The path string is used verbatim as the output key, so
`select:["api_exp[0]"]` yields `{"api_exp[0]": 109619}`.

### Collection vs value

`info.ships` (a map of 381 ships) and `info.basic` (one record) are both plain
JavaScript objects, so the plugin needs an explicit rule for which is which.

**A value is a collection if it is an array, or an object whose keys are all
integer-like strings.** Everything else is a value.

This holds throughout the store: `info.ships` and `const.$ships` are keyed by
id, while `info.basic` is keyed by `api_member_id`, `api_nickname`, and so on.

- **Collections:** `where` and `limit` filter elements; `select` picks fields
  from each element.
- **Values:** `where` and `limit` are ignored; `select` picks fields from the
  object itself. On a scalar, `select` is ignored too.

The `treatAs: "collection" | "value"` parameter overrides the rule when the
heuristic guesses wrong. It is the escape hatch, not the primary mechanism.

### Return envelope

```
{ path, kind, total, returned, truncated, items | value }
```

`kind` is one of `object-map`, `array`, `object`, `scalar`.

- **Object-maps keep their keys.** `items` is an object. This preserves identity
  when a `select` omits the id field.
- **Arrays keep index order.** `items` is an array.
- **Values** (objects and scalars) return `value` instead of `items`, with
  `total`, `returned`, and `truncated` omitted.

### Size backstop

After `where`, `select`, and `limit` are applied, the result is serialized and
capped at `maxBytes`. Over the cap, elements are dropped until it fits. This is
what makes a generic tool safe to hand an agent: no query can blow up the
context by accident.

`truncated: true` means elements were dropped, **whether by `limit` or by
`maxBytes`** — `total` against `returned` shows how many were lost, and the
response carries a hint to narrow the query.

A **value** that exceeds `maxBytes` has no elements to drop, so it is an error
naming the serialized size and suggesting a narrower path or a `select`. It is
never silently cut.

`const` is an allowed root, so `poi_get("const.$ships")` is reachable and would
trip this cap. That is intended: `poi_lookup` is a convenience that makes the
cheap path obvious, not a wall. The size backstop is the actual protection.

## Path allowlist

A correctness requirement, not only hygiene.

**Allowed roots:** `info`, `const`, `fcd`, `wctf`, `battle`, `sortie`, `timers`,
`misc`.

**Denied roots:**

| Root | Reason |
|---|---|
| `layout` | Holds `layout.webview.ref`, a live DOM element. `JSON.stringify` throws on its circular references. |
| `plugins` | Holds React component classes. |
| `ext` | Arbitrary plugin state (`reducer-factory.ts:42`), no serialization guarantees. |
| `config` | poi's proxy settings can carry credentials. |
| `ui` | UI-local state, no game data. |

A path whose root is not on the allowlist is rejected before any traversal.

### Serialization

`src/serialize.ts` is the second line of defence, independent of the allowlist:
functions are dropped, circular references replaced with `"[Circular]"`, and
depth capped. The allowlist should make this unnecessary; it exists because
"should" is not a guarantee.

## Error handling

Errors are shaped so a wrong guess costs one call, not a debugging session.

| Case | Behaviour |
|---|---|
| Unknown path | Error listing sibling keys at the nearest valid parent. |
| Denied path | Error naming the denied root explicitly, plus the allowed roots. |
| Valid path, empty branch | **Not an error.** `{ total: 0, items: {}, hint: "branch is empty — poi may not have loaded the game yet" }`. Distinguishes "asked wrong" from "asked before login". |
| `where` parse error | Offending token, its position, and a one-line grammar summary. |
| `ids` over 200 in `poi_lookup` | Error stating the cap. |
| Value exceeds `maxBytes` | Error naming the serialized size, suggesting a narrower path or a `select`. Values are never silently cut; only collections are truncated. |
| Bind failure (`EADDRINUSE`) | Surfaced in the status panel, server left down. **Not** retried on a fallback port — that would silently change the URL and break the agent's config while appearing to work. |
| Any handler throw | Caught, returned as an MCP error. **Nothing rethrows into the renderer.** The plugin must never be able to take poi down. |

## Testing

- **`src/query.ts` gets real unit tests.** Pure functions: parser, precedence,
  undefined handling, select fieldpaths, limit, truncation, and the
  collection-vs-value heuristic including the `treatAs` override. This is where
  the bugs will be.
- **`src/serialize.ts`** — circular references, functions, depth cap.
- **`src/paths.ts`** — allowlist enforcement, sibling-key suggestions.
- **`test/fixtures/store.json`** — a trimmed snapshot of real store data (a few
  dozen ships, two fleets, the matching `const` entries), so tools are tested
  against real field names with no poi running.
- **Integration smoke test** — manual, once: start poi, `claude mcp add
  --transport http`, call each of the three tools.

Runner: `node:test` with `tsx`. Standalone repo; no reason to pull in jest.

## Installation

```sh
ln -s ~/kancolle/poi-plugin-chinjufu-mcp \
  "$HOME/Library/Application Support/poi/plugins/node_modules/poi-plugin-chinjufu-mcp"

# enable the plugin in poi, then check it is up:
curl -s http://127.0.0.1:12450/health

# if the port was changed, read it from the port file:
claude mcp add poi --transport http \
  "http://127.0.0.1:$(cat ~/.poi-chinjufu-mcp/port)/mcp"
```

## Naming

The name `poi-plugin-mcp` is already taken on npm by an unrelated plugin (a
broader bridge that also does screenshots and authenticated input). This package
is `poi-plugin-chinjufu-mcp`, with poi plugin id `poi_chinjufu_mcp` and MCP server name
`poi-chinjufu-mcp`, so the two can be installed side by side.
