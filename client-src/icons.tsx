/**
 * Small inline SVG icons for the terminal panel chrome, menus, dialogs and
 * empty/error states.
 *
 * They intentionally use `currentColor` so the DSH theme tokens drive them.
 * All glyphs share a 16x16 viewBox and the same stroke feel so buttons at
 * 14px/24px read as one family. `IconChevron` points down; rotate it with CSS
 * for the other directions.
 */

import type { ReactNode } from 'react'

interface IconProps {
  size?: number
  className?: string
}

function Glyph({ size = 14, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className={className}
      focusable="false"
    >
      {children}
    </svg>
  )
}

export function IconPlus(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M8 3v10M3 8h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </Glyph>
  )
}

export function IconRefresh(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5V5h-2.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  )
}

export function IconReconnect(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M2.8 8a5.2 5.2 0 0 1 9.3-3.2M13.2 8a5.2 5.2 0 0 1-9.3 3.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M12.6 2.6v2.7h-2.7M3.4 13.4v-2.7h2.7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  )
}

export function IconCamera(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect
        x="1.8"
        y="4.6"
        width="12.4"
        height="8.8"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <circle cx="8" cy="9" r="2.3" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M5.6 4.6l.7-1.4h3.4l.7 1.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  )
}

export function IconClipboard(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect
        x="3.6"
        y="3"
        width="8.8"
        height="10.4"
        rx="1.8"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x="5.9"
        y="1.9"
        width="4.2"
        height="2.2"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M5.9 7.5h4.2M5.9 9.9h4.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </Glyph>
  )
}

export function IconClose(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Glyph>
  )
}

export function IconClear(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M6.4 12.6h7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M3.5 9.3l5-5a1.9 1.9 0 0 1 2.7 0l1.6 1.6a1.9 1.9 0 0 1 0 2.7l-3.5 3.5H6.2L3.5 9.3z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </Glyph>
  )
}

export function IconSearch(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="7.1" cy="7.1" r="4.2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M10.2 10.2l3.3 3.3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Glyph>
  )
}

export function IconChevron(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M4.8 6.4L8 9.6l3.2-3.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  )
}

export function IconPin(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M10.4 1.8l3.8 3.8-1.7.3-1.7 1.7.2 2.1-.8.8-2.6-2.6-2.9 2.9-.7-.7 2.9-2.9L4.3 4.6l.8-.8 2.1.2 1.7-1.7.3-1.7z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  )
}

export function IconHistory(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M2.9 6.1A5.2 5.2 0 1 0 8 2.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M2.6 2.9v3.4h3.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M8 5.4V8l2 1.3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  )
}

export function IconSettings(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.9v1.5M8 12.6v1.5M1.9 8h1.5M12.6 8h1.5M3.7 3.7l1 1M11.3 11.3l1 1M12.3 3.7l-1 1M4.7 11.3l-1 1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </Glyph>
  )
}

export function IconMore(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="3.6" cy="8" r="1.1" fill="currentColor" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" />
      <circle cx="12.4" cy="8" r="1.1" fill="currentColor" />
    </Glyph>
  )
}

export function IconExport(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M9.2 3H13v3.8M13 3L7.6 8.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12.4 9.6v2.9a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1h2.9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  )
}

export function IconPause(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="4.7" y="3.4" width="2.3" height="9.2" rx="1" fill="currentColor" />
      <rect x="9" y="3.4" width="2.3" height="9.2" rx="1" fill="currentColor" />
    </Glyph>
  )
}

export function IconPlay(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M5.3 3.5l6.5 4.5-6.5 4.5V3.5z" fill="currentColor" />
    </Glyph>
  )
}

export function IconMaximize(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  )
}

export function IconMinimize(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M6 2.5v3.5H2.5M10 6V2.5h3.5M13.5 10H10v3.5M6 10H2.5V6.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  )
}

export function IconKeyboard(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect
        x="1.8"
        y="4.2"
        width="12.4"
        height="7.6"
        rx="1.8"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M4.4 6.6h.01M6.4 6.6h.01M8.4 6.6h.01M10.4 6.6h.01M12.2 6.6h.01M5.4 9.4h5.2"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Glyph>
  )
}

export function IconSandbox(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M8 2.2l4.8 1.9v3.2c0 2.9-2 5-4.8 5.9-2.8-.9-4.8-3-4.8-5.9V4.1L8 2.2z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M5.9 7.9l1.5 1.5 2.9-3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  )
}

export function IconLink(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M6.7 9.3l2.6-2.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M5.9 10.4l-1 1a2.4 2.4 0 0 1-3.4-3.4l2.1-2.1a2.4 2.4 0 0 1 3.4 0"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M10.1 5.6l1-1a2.4 2.4 0 0 1 3.4 3.4l-2.1 2.1a2.4 2.4 0 0 1-3.4 0"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </Glyph>
  )
}

export function IconRename(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M10.3 2.7l3 3-6.7 6.7H3.6v-3l6.7-6.7z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M9 4l3 3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M3.2 14.2h9.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </Glyph>
  )
}

export function IconTerminal(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect
        x="1.8"
        y="2.8"
        width="12.4"
        height="10.4"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M4.6 6.4L6.8 8.4L4.6 10.4M8.6 10.6h2.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  )
}

export function IconWarning(props: IconProps) {
  return (
    <Glyph {...props}>
      <path
        d="M8 2.4l6 10.6H2L8 2.4z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M8 6.6v2.6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.3" r="0.8" fill="currentColor" />
    </Glyph>
  )
}
