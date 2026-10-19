/**
 * xterm theme derived from the DSH design tokens (`--dsw-*` CSS variables).
 *
 * The GUI only guarantees that the tokens exist on some ancestor of the
 * sidebar; values are resolved through a hidden probe element so `var(...)`
 * chains are flattened before they reach xterm (canvas fonts cannot resolve
 * CSS variables). Falls back to a neutral dark palette when the tokens are
 * missing (e.g. while the GUI boots).
 */

import type { ITheme } from '@xterm/xterm'

export interface TerminalTheme {
  xterm: ITheme
  fontFamily: string
  fontSize: number
}

const DARK_FALLBACK_BACKGROUND = '#17191d'
const LIGHT_FALLBACK_BACKGROUND = '#ffffff'
const FALLBACK_FOREGROUND = '#e6e6e6'
const FALLBACK_FONT =
  'Consolas, "Cascadia Mono", "SFMono-Regular", Menlo, "Courier New", monospace'

const FONT_SIZE = 12

function probeElement(): HTMLDivElement | null {
  if (typeof document === 'undefined' || !document.body) return null
  const probe = document.createElement('div')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.position = 'absolute'
  probe.style.top = '-9999px'
  probe.style.left = '-9999px'
  probe.style.visibility = 'hidden'
  probe.style.pointerEvents = 'none'
  probe.style.width = '0'
  probe.style.height = '0'
  document.body.appendChild(probe)
  return probe
}

function resolveColor(
  variable: string,
  fallback: string,
  target: 'color' | 'backgroundColor' = 'color',
): string {
  const probe = probeElement()
  if (!probe) return fallback
  try {
    if (target === 'color') probe.style.color = `var(${variable}, ${fallback})`
    else probe.style.backgroundColor = `var(${variable}, ${fallback})`
    const computed = getComputedStyle(probe)
    const value = (target === 'color' ? computed.color : computed.backgroundColor).trim()
    if (value === '') return fallback
    if (target === 'backgroundColor' && isTransparent(value)) return fallback
    return value
  } finally {
    probe.remove()
  }
}

function resolveFontFamily(variable: string, fallback: string): string {
  const probe = probeElement()
  if (!probe) return fallback
  try {
    probe.style.fontFamily = `var(${variable}, ${fallback})`
    const value = getComputedStyle(probe).fontFamily.trim()
    return value === '' ? fallback : value
  } finally {
    probe.remove()
  }
}

/**
 * Read a font list the theme presenter writes inline on `<body>`
 * (`--dsh-font-family-<role>`, see dsh-client-ui-layout "主题呈现").
 * Absent/empty means "use the built-in stack".
 */
function readBodyFontFamily(variable: string): string | undefined {
  if (typeof document === 'undefined' || !document.body) return undefined
  const value = getComputedStyle(document.body).getPropertyValue(variable).trim()
  return value === '' ? undefined : value
}

/** Read a px-valued font size the theme presenter writes on `<body>`. */
function readBodyFontSize(variable: string, fallback: number): number {
  if (typeof document === 'undefined' || !document.body) return fallback
  const raw = getComputedStyle(document.body).getPropertyValue(variable).trim()
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed >= 8 && parsed <= 32 ? parsed : fallback
}

function isTransparent(color: string): boolean {
  const normalized = color.replace(/\s+/gu, '').toLowerCase()
  return (
    normalized === 'transparent' ||
    normalized === 'rgba(0,0,0,0)' ||
    normalized === 'rgb(0,0,0,0)'
  )
}

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

function parseColor(color: string): Rgba | null {
  const value = color.trim().toLowerCase()
  const rgbMatch = /^rgba?\(([^)]+)\)$/u.exec(value)
  if (rgbMatch?.[1]) {
    const parts = rgbMatch[1].split(/[,\s/]+/u).filter((part) => part !== '')
    const [r, g, b, a] = parts.map((part) => Number.parseFloat(part))
    if (r !== undefined && g !== undefined && b !== undefined && Number.isFinite(r)) {
      return { r, g, b, a: a === undefined || !Number.isFinite(a) ? 1 : a }
    }
  }
  const hexMatch = /^#([\da-f]{3,8})$/u.exec(value)
  if (hexMatch?.[1]) {
    const hex = hexMatch[1]
    const width = hex.length >= 6 ? 2 : 1
    const channels = [
      hex.slice(0, width),
      hex.slice(width, width * 2),
      hex.slice(width * 2, width * 3),
    ].map((channel) => {
      const valuePerChannel = Number.parseInt(
        width === 1 ? channel + channel : channel,
        16,
      )
      return Number.isFinite(valuePerChannel) ? valuePerChannel : 0
    })
    const alpha =
      hex.length === 4
        ? Number.parseInt(hex[3] + hex[3], 16) / 255
        : hex.length === 8
          ? Number.parseInt(hex.slice(6, 8), 16) / 255
          : 1
    return {
      r: channels[0] ?? 0,
      g: channels[1] ?? 0,
      b: channels[2] ?? 0,
      a: Number.isFinite(alpha) ? alpha : 1,
    }
  }
  return null
}

function withAlpha(color: string, alpha: number): string {
  const parsed = parseColor(color)
  if (!parsed) return color
  const clamp = Math.max(0, Math.min(1, alpha))
  return `rgba(${Math.round(parsed.r)}, ${Math.round(parsed.g)}, ${Math.round(parsed.b)}, ${clamp})`
}

function relativeLuminance(color: string): number {
  const parsed = parseColor(color)
  if (!parsed) return 0
  const channels = [parsed.r, parsed.g, parsed.b].map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0)
}

function resolveBackground(): string {
  // The sidebar sits on the base surface; fall through the layer ladder if the
  // base token is transparent (some themes use layered backgrounds only).
  for (const variable of [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
  ]) {
    const value = resolveColor(variable, '', 'backgroundColor')
    if (value !== '' && !isTransparent(value)) return value
  }
  if (typeof document !== 'undefined' && document.body) {
    const value = getComputedStyle(document.body).backgroundColor
    if (value !== '' && !isTransparent(value)) return value
  }
  return DARK_FALLBACK_BACKGROUND
}

/** Read the current DSH tokens into an xterm-compatible theme. */
export function readTerminalTheme(): TerminalTheme {
  const background = resolveBackground()
  const dark = relativeLuminance(background) < 0.4
  const foreground = resolveColor(
    '--dsw-alias-label-primary',
    dark ? FALLBACK_FOREGROUND : '#1f2328',
  )
  const cursor = foreground
  // The Settings → terminal font family/size are projected onto <body> by the
  // shell's theme presenter; fall back to the code font and the default size.
  const fontFamily =
    readBodyFontFamily('--dsh-font-family-terminal') ??
    readBodyFontFamily('--dsh-font-family-code') ??
    resolveFontFamily(
      '--ds-font-family-code',
      resolveFontFamily('--dsw-font-markdown-code-font-family', FALLBACK_FONT),
    )
  const fontSize = readBodyFontSize('--dsh-terminal-font-size', FONT_SIZE)
  return {
    xterm: {
      background,
      foreground,
      cursor,
      cursorAccent: background,
      selectionBackground: withAlpha(foreground, 0.3),
      selectionInactiveBackground: withAlpha(foreground, 0.18),
      scrollbarSliderBackground: withAlpha(foreground, 0.2),
      scrollbarSliderHoverBackground: withAlpha(foreground, 0.32),
      scrollbarSliderActiveBackground: withAlpha(foreground, 0.4),
    },
    fontFamily,
    fontSize,
  }
}

/** Observe theme flips (`body[data-ds-dark-theme]` and token mutations). */
export function observeTheme(listener: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {}
  }
  const observer = new MutationObserver(() => listener())
  const options: MutationObserverInit = {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-ds-dark-theme'],
  }
  if (document.body) observer.observe(document.body, options)
  if (document.documentElement) observer.observe(document.documentElement, options)
  const media =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : undefined
  const onMediaChange = (): void => listener()
  media?.addEventListener?.('change', onMediaChange)
  return () => {
    observer.disconnect()
    media?.removeEventListener?.('change', onMediaChange)
  }
}

/** Light fallback used by tests when the GUI tokens are unavailable. */
export const FALLBACK_THEME_BACKGROUND =
  typeof window === 'undefined' ? DARK_FALLBACK_BACKGROUND : LIGHT_FALLBACK_BACKGROUND
