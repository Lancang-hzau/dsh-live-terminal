/**
 * xterm theme derived from the DSH design tokens (`--dsw-*` CSS variables).
 *
 * The GUI only guarantees that the tokens exist on some ancestor of the
 * sidebar; values are resolved through one hidden probe element so `var(...)`
 * chains are flattened before they reach xterm (canvas fonts cannot resolve
 * CSS variables). Falls back to a neutral dark palette when the tokens are
 * missing (e.g. while the GUI boots).
 *
 * Both the probe element and the theme MutationObserver are process-wide:
 * every TerminalView instance reads through the same probe and shares one
 * debounced observer instead of creating its own DOM node/observer.
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

/** Coalesce bursts of theme mutations (CSS-variable writes, class flips). */
const THEME_DEBOUNCE_MS = 100

/* ------------------------------------------------------------------ */
/* Shared hidden probe                                                 */
/* ------------------------------------------------------------------ */

/**
 * One hidden probe reused for every token lookup. Appending/removing a probe
 * per color forced a document style recalc each time and churned the DOM; the
 * element is kept attached and re-created only if the body was replaced.
 */
let probeElement: HTMLDivElement | null = null

function ensureProbe(): HTMLDivElement | null {
  if (typeof document === 'undefined' || !document.body) return null
  if (probeElement !== null && probeElement.isConnected) return probeElement
  const element = document.createElement('div')
  element.setAttribute('aria-hidden', 'true')
  element.style.position = 'absolute'
  element.style.top = '-9999px'
  element.style.left = '-9999px'
  element.style.visibility = 'hidden'
  element.style.pointerEvents = 'none'
  element.style.width = '0'
  element.style.height = '0'
  document.body.appendChild(element)
  probeElement = element
  return element
}

function resolveColor(
  variable: string,
  fallback: string,
  target: 'color' | 'backgroundColor' = 'color',
): string {
  const probe = ensureProbe()
  if (!probe) return fallback
  if (target === 'color') probe.style.color = `var(${variable}, ${fallback})`
  else probe.style.backgroundColor = `var(${variable}, ${fallback})`
  const computed = getComputedStyle(probe)
  const value = (target === 'color' ? computed.color : computed.backgroundColor).trim()
  if (value === '') return fallback
  if (target === 'backgroundColor' && isTransparent(value)) return fallback
  return value
}

function resolveFontFamily(variable: string, fallback: string): string {
  const probe = ensureProbe()
  if (!probe) return fallback
  probe.style.fontFamily = `var(${variable}, ${fallback})`
  const value = getComputedStyle(probe).fontFamily.trim()
  return value === '' ? fallback : value
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

/* ------------------------------------------------------------------ */
/* Color math                                                          */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Shared, debounced theme observer                                    */
/* ------------------------------------------------------------------ */

type ThemeListener = () => void

const themeListeners = new Set<ThemeListener>()
let mutationObserver: MutationObserver | null = null
let mediaQueryList: MediaQueryList | null = null
let debounceTimer: number | undefined

function notifyThemeListeners(): void {
  for (const listener of Array.from(themeListeners)) {
    try {
      listener()
    } catch (error) {
      console.warn('[dsh-live-terminal] theme listener failed', error)
    }
  }
}

function scheduleThemeNotify(): void {
  if (typeof window === 'undefined') {
    notifyThemeListeners()
    return
  }
  if (debounceTimer !== undefined) return
  debounceTimer = window.setTimeout(() => {
    debounceTimer = undefined
    notifyThemeListeners()
  }, THEME_DEBOUNCE_MS)
}

function startThemeObservation(): void {
  if (typeof MutationObserver === 'undefined') return
  const observer = new MutationObserver(scheduleThemeNotify)
  const options: MutationObserverInit = {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-ds-dark-theme'],
  }
  if (document.body) observer.observe(document.body, options)
  if (document.documentElement) observer.observe(document.documentElement, options)
  mutationObserver = observer
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mediaQueryList = window.matchMedia('(prefers-color-scheme: dark)')
    mediaQueryList.addEventListener?.('change', scheduleThemeNotify)
  }
}

function stopThemeObservation(): void {
  mutationObserver?.disconnect()
  mutationObserver = null
  mediaQueryList?.removeEventListener?.('change', scheduleThemeNotify)
  mediaQueryList = null
  if (debounceTimer !== undefined && typeof window !== 'undefined') {
    window.clearTimeout(debounceTimer)
    debounceTimer = undefined
  }
}

/**
 * Observe theme flips (`body[data-ds-dark-theme]` and token mutations).
 * Shared by every TerminalView: one observer runs while at least one listener
 * is subscribed and mutations are coalesced by a ~100ms debounce.
 */
export function observeTheme(listener: ThemeListener): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {}
  }
  themeListeners.add(listener)
  if (themeListeners.size === 1) startThemeObservation()
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    themeListeners.delete(listener)
    if (themeListeners.size === 0) stopThemeObservation()
  }
}

/** Light fallback used by tests when the GUI tokens are unavailable. */
export const FALLBACK_THEME_BACKGROUND =
  typeof window === 'undefined' ? DARK_FALLBACK_BACKGROUND : LIGHT_FALLBACK_BACKGROUND
