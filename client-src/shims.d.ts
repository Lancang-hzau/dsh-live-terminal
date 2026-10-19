/**
 * Ambient declarations for imports that only exist inside the DSH client
 * module loader (served from the platform module table, never installed here).
 */

/** Injected at build time by tools/build-client.mjs from package.json. */
declare const __PLUGIN_VERSION__: string

declare module '*.css' {
  const css: string
  export default css
}

declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType } from 'react'

  export const PluginArtworkTerminal: ComponentType<{ size?: number }>
  const primitives: Record<string, unknown>
  export default primitives
}
