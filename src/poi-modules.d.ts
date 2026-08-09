/**
 * Ambient declarations for modules this plugin resolves from poi at runtime.
 *
 * None of these are installed as dependencies on purpose. poi adds its own ROOT
 * and node_modules to the require path, so `views/*` and `react` resolve to
 * poi's copies when the plugin is loaded. Installing react here would put a
 * second copy inside the plugin's own node_modules, which would shadow poi's
 * and break reconciliation in the shared renderer.
 */

declare module 'views/create-store' {
  export function getStore(path?: string): unknown
}

declare module 'views/env' {
  export const isMain: boolean | undefined
  export const config: {
    get<T>(path: string, fallback: T): T
    set(path: string, value: unknown): void
  }
}

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
