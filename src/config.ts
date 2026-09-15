/**
 * The keys this plugin owns in poi's config.
 *
 * poi's config is a single shared tree with no per-plugin isolation — unlike
 * the store, where poi mounts each plugin's state under its package name — so
 * the namespace is the plugin's own `poiPlugin.id`, the same identity i18n's
 * NAMESPACE uses.
 *
 * Deliberately not `plugin.mcp.*`, which the port key used to be: "mcp" names
 * the protocol rather than this plugin, so any second MCP plugin would reach
 * for the same key and the two would silently share a value.
 */
export const CONFIG_PREFIX = 'plugin.poi_nanodesu_mcp'

export const PORT_CONFIG_KEY = `${CONFIG_PREFIX}.port`

/** How many recent requests the status panel keeps. At least 1, no ceiling. */
export const RECENT_CONFIG_KEY = `${CONFIG_PREFIX}.recentRequests`

/** The `claude mcp add` scope the panel last had selected. */
export const SCOPE_CONFIG_KEY = `${CONFIG_PREFIX}.scope`
