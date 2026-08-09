/**
 * Ambient declaration for `react`, which this plugin resolves from poi at
 * runtime rather than installing.
 *
 * poi adds its own node_modules to the require path, so `react` resolves to
 * poi's copy when the plugin is loaded. Installing react here would put a
 * second copy inside the plugin's own node_modules, which would shadow poi's
 * and break reconciliation in the shared renderer.
 *
 * poi's `views/*` modules are deliberately NOT declared here. This plugin reads
 * poi's `window` globals through src/poi.ts instead, because the named exports
 * those modules provide differ between poi's released and development builds.
 */

declare module 'react' {
  export class Component<P = Record<string, unknown>, S = Record<string, unknown>> {
    constructor(props: P)
    props: P
    state: S
    setState(state: Partial<S>): void
    render(): unknown
  }
  export function createElement(
    type: unknown,
    props?: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown
  const React: {
    Component: typeof Component
    createElement: typeof createElement
  }
  export default React
}
