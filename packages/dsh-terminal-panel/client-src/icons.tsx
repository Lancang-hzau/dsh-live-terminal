/**
 * Small inline SVG icons for the panel toolbar and empty/error states.
 *
 * They intentionally use `currentColor` so the DSH theme tokens drive them.
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
