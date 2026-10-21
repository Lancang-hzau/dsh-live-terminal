/**
 * Stylesheet for the terminal panel (1.2.1 compact chrome).
 *
 * Kept as a plain string (no CSS modules) because the bundle is a single file;
 * `index.tsx` injects it together with xterm's own CSS into one idempotent
 * `<style data-plugin="dsh-live-terminal">` tag. Colors follow the `--dsw-*`
 * design tokens with graceful fallbacks, so both light and dark themes are
 * driven by the shell's tokens (no hard-coded light/dark colors).
 *
 * Layout contract: one 32px chrome row (new / session tabs / follow / more),
 * one optional non-blocking banner, the terminal screen with symmetric 8px
 * padding, an optional toast anchored at the bottom of the body, and a status
 * bar that is hidden in the normal state (`data-visible="false"`).
 */

export const styles = String.raw`
/* ------------------------------------------------------------------ */
/* Root                                                                */
/* ------------------------------------------------------------------ */

.dshtp-root {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
  box-sizing: border-box;
  container-type: inline-size;
  container-name: dshtp;
  font-size: 13px;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary, inherit);
  background: transparent;
}

/* The hidden-by-default text labels inside compact buttons. */
.dshtp-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dshtp-root a {
  color: var(--dsw-alias-link, var(--dsw-alias-label-primary, inherit));
  text-decoration: underline;
  text-underline-offset: 2px;
}

.dshtp-root [hidden] {
  display: none !important;
}

/* ------------------------------------------------------------------ */
/* Chrome: exactly one 32px row and exactly one 0.5px hairline         */
/* ------------------------------------------------------------------ */

.dshtp-chrome {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  box-sizing: border-box;
  height: 32px;
  min-height: 32px;
  padding: 0 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
}

/* Shared compact icon button (24x24 minimum hit area). */
.dshtp-new,
.dshtp-more,
.dshtp-follow,
.dshtp-tab-keep,
.dshtp-tab-close,
.dshtp-dialog-close,
.dshtp-search-close,
.dshtp-search-action,
.dshtp-banner-close,
.dshtp-toast-close,
.dshtp-global-toast-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  box-sizing: border-box;
  width: 24px;
  height: 24px;
  min-width: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  transition:
    background-color var(--ds-transition-duration-fast, 0.1s) ease,
    color var(--ds-transition-duration-fast, 0.1s) ease;
}

.dshtp-new:hover:not(:disabled),
.dshtp-more:hover:not(:disabled),
.dshtp-follow:hover:not(:disabled),
.dshtp-tab-keep:hover:not(:disabled),
.dshtp-tab-close:hover:not(:disabled),
.dshtp-dialog-close:hover:not(:disabled),
.dshtp-search-close:hover:not(:disabled),
.dshtp-search-action:hover:not(:disabled),
.dshtp-banner-close:hover:not(:disabled),
.dshtp-toast-close:hover:not(:disabled),
.dshtp-global-toast-close:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-primary, inherit);
}

.dshtp-new:disabled,
.dshtp-more:disabled,
.dshtp-follow:disabled,
.dshtp-tab-keep:disabled,
.dshtp-tab-close:disabled,
.dshtp-search-action:disabled,
.dshtp-banner-close:disabled,
.dshtp-toast-close:disabled {
  opacity: 0.45;
  cursor: default;
  pointer-events: none;
}

.dshtp-new svg,
.dshtp-more svg,
.dshtp-follow svg {
  width: 14px;
  height: 14px;
}

/* New terminal: the single filled affordance in the chrome. */
.dshtp-new {
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4d6bfe));
  color: var(--dsw-alias-label-primary-foreground, inherit);
}

.dshtp-new:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #4d6bfe));
  color: var(--dsw-alias-label-primary-foreground, inherit);
}

.dshtp-more {
  font-size: 14px;
  letter-spacing: 0.5px;
}

.dshtp-follow[data-follow='true'] {
  background: var(--dsw-alias-interactive-bg-active, rgba(127, 127, 127, 0.14));
  color: var(--dsw-alias-label-primary, inherit);
}

/* ------------------------------------------------------------------ */
/* Session strip + tabs                                                */
/* ------------------------------------------------------------------ */

.dshtp-session-strip {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-inline: contain;
  scroll-behavior: smooth;
  scroll-padding-inline: 4px;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2, rgba(127, 127, 127, 0.3)) transparent;
  mask-image: linear-gradient(to right, transparent 0, #000 6px, #000 calc(100% - 6px), transparent 100%);
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 6px, #000 calc(100% - 6px), transparent 100%);
}

.dshtp-session-strip::-webkit-scrollbar {
  height: 8px;
}

.dshtp-session-strip::-webkit-scrollbar-track {
  background: transparent;
}

.dshtp-session-strip::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2, rgba(127, 127, 127, 0.3));
  border-radius: 999px;
}

.dshtp-session-strip:hover::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-hover-l2, var(--dsw-alias-scrollbar-bg-l2, rgba(127, 127, 127, 0.4)));
}

.dshtp-tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  box-sizing: border-box;
  height: 24px;
  max-width: 220px;
  min-width: 0;
  margin: 0;
  padding: 0 4px 0 8px;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  transition:
    background-color var(--ds-transition-duration-fast, 0.1s) ease,
    border-color var(--ds-transition-duration-fast, 0.1s) ease,
    color var(--ds-transition-duration-fast, 0.1s) ease;
}

.dshtp-tab:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}

.dshtp-tab[data-active='true'],
.dshtp-tab[data-active]:not([data-active='false']) {
  background: var(--dsw-alias-interactive-bg-active, rgba(127, 127, 127, 0.14));
  border-color: var(--dsw-alias-border-l3, rgba(127, 127, 127, 0.24));
  color: var(--dsw-alias-label-primary, inherit);
}

/* Two-pixel accent so the active tab never relies on the hairline alone. */
.dshtp-tab::before {
  content: '';
  position: absolute;
  inset-inline-start: 0;
  top: 4px;
  bottom: 4px;
  width: 2px;
  border-radius: 2px;
  background: transparent;
}

.dshtp-tab[data-active='true']::before,
.dshtp-tab[data-active]:not([data-active='false'])::before {
  background: var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary, currentColor));
}

.dshtp-tab-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 1.2;
}

.dshtp-tab[data-active='true'] .dshtp-tab-title,
.dshtp-tab[data-active]:not([data-active='false']) .dshtp-tab-title {
  font-weight: 500;
}

/* 8px dot + 12px badge text: state is never color-only. */
.dshtp-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));
}

.dshtp-tab[data-state='running'] .dshtp-dot,
.dshtp-dot[data-state='running'] {
  background: var(--dsw-alias-state-success-primary, #2fbf71);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-success-primary, #2fbf71) 25%, transparent);
}

.dshtp-tab[data-state='starting'] .dshtp-dot,
.dshtp-dot[data-state='starting'] {
  background: var(--dsw-alias-state-warn-primary, #d98700);
  animation: dshtp-pulse 1.4s ease-in-out infinite;
}

.dshtp-tab[data-state='exited'] .dshtp-dot,
.dshtp-dot[data-state='exited'] {
  background: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));
}

.dshtp-tab[data-state='failed'] .dshtp-dot,
.dshtp-dot[data-state='failed'] {
  background: var(--dsw-alias-state-error-primary, #e5484d);
}

.dshtp-tab-badge {
  display: inline-flex;
  align-items: center;
  flex: none;
  box-sizing: border-box;
  height: 18px;
  max-width: 76px;
  padding: 0 4px;
  overflow: hidden;
  border-radius: 4px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #000) 8%, transparent);
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.dshtp-tab-badge[data-kind='countdown'],
.dshtp-tab-badge[data-kind='unread'] {
  color: var(--dsw-alias-label-primary, inherit);
}

.dshtp-tab-badge[data-kind='running'] {
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 14%, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}

.dshtp-tab-badge[data-kind='error'] {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 14%, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}

.dshtp-tab-badge[data-kind='sandbox'] {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d98700) 16%, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}

/* Pin: hidden until hover/active/pinned, but its box is reserved so the tab
   does not resize (visibility also keeps it out of the tab order). */
.dshtp-tab-keep {
  visibility: hidden;
  pointer-events: none;
}

.dshtp-tab:hover .dshtp-tab-keep,
.dshtp-tab[data-active='true'] .dshtp-tab-keep,
.dshtp-tab[data-active]:not([data-active='false']) .dshtp-tab-keep,
.dshtp-tab[data-pinned='true'] .dshtp-tab-keep,
.dshtp-tab:focus-within .dshtp-tab-keep {
  visibility: visible;
  pointer-events: auto;
}

.dshtp-tab[data-pinned='true'] .dshtp-tab-keep {
  color: var(--dsw-alias-label-primary, inherit);
}

.dshtp-tab[data-pinned='true'] .dshtp-tab-keep svg {
  fill: currentColor;
}

.dshtp-tab-keep svg,
.dshtp-tab-close svg {
  width: 12px;
  height: 12px;
}

.dshtp-tab-close:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(220, 60, 60, 0.14));
  color: var(--dsw-alias-state-error-primary, #e5484d);
}

/* ------------------------------------------------------------------ */
/* Body / terminal screen                                              */
/* ------------------------------------------------------------------ */

.dshtp-body {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.dshtp-screen {
  position: relative;
  display: flex;
  flex: 1;
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
  padding: 8px;
  background: var(--dsw-alias-bg-base, transparent);
  overflow: hidden;
}

.dshtp-screen .xterm {
  width: 100%;
  height: 100%;
}

.dshtp-screen .xterm-viewport {
  background: transparent !important;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2, rgba(127, 127, 127, 0.3)) transparent;
}

.dshtp-screen .xterm-viewport::-webkit-scrollbar {
  width: 8px;
}

.dshtp-screen .xterm-viewport::-webkit-scrollbar-track {
  background: transparent;
}

.dshtp-screen .xterm-viewport::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2, rgba(127, 127, 127, 0.3));
  border-radius: 999px;
}

.dshtp-screen .xterm-viewport:hover::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-hover-l2, var(--dsw-alias-scrollbar-bg-l2, rgba(127, 127, 127, 0.4)));
}

/* Visible keyboard focus for the emulator (xterm itself draws no ring). */
.dshtp-screen:focus-within {
  outline: var(--dsw-focus-ring-width, 2px) solid
    var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));
  outline-offset: -2px;
  border-radius: var(--dsw-radius-sm, 8px);
}

/* Connecting skeleton/spinner shown before the first snapshot. */
.dshtp-connecting {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  box-sizing: border-box;
  padding: 16px;
  background: var(--dsw-alias-bg-base, transparent);
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  pointer-events: none;
}

.dshtp-connecting-spinner {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--dsw-alias-label-primary, #000) 18%, transparent);
  border-top-color: var(--dsw-alias-label-secondary, inherit);
  animation: dshtp-spin 0.8s linear infinite;
}

.dshtp-connecting-text {
  max-width: 32ch;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1.5;
}

.dshtp-skeleton {
  position: relative;
  width: 100%;
  height: 12px;
  overflow: hidden;
  border-radius: 6px;
  background: var(--dsw-alias-bg-skeleton, rgba(127, 127, 127, 0.14));
}

.dshtp-skeleton + .dshtp-skeleton {
  margin-top: 8px;
}

.dshtp-skeleton[data-size='title'] {
  width: 38%;
  height: 16px;
}

.dshtp-skeleton[data-size='block'] {
  height: 72px;
}

.dshtp-skeleton::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--dsw-alias-label-primary, #000) 8%, transparent),
    transparent
  );
  transform: translateX(-100%);
  animation: dshtp-shimmer 1.4s ease-in-out infinite;
}

.dshtp-skeleton[data-size='block'] {
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: auto;
  min-height: 72px;
  padding: 8px;
  overflow: visible;
  background: transparent;
}

.dshtp-skeleton[data-size='block']::after {
  display: none;
}

.dshtp-skeleton[data-size='line'] {
  height: 12px;
}

/* ------------------------------------------------------------------ */
/* Non-blocking banner (error / warn / readonly)                      */
/* ------------------------------------------------------------------ */

.dshtp-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex: none;
  box-sizing: border-box;
  margin: 8px 8px 0;
  padding: 6px 8px;
  border-inline-start: 2px solid transparent;
  border-radius: var(--dsw-radius-sm, 8px);
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #000) 6%, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 12px;
  line-height: 1.5;
}

.dshtp-banner:last-child {
  margin-bottom: 8px;
}

.dshtp-banner[data-kind='error'] {
  border-inline-start-color: var(--dsw-alias-state-error-primary, #e5484d);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5484d) 10%, transparent);
}

.dshtp-banner[data-kind='warn'] {
  border-inline-start-color: var(--dsw-alias-state-warn-primary, #d98700);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d98700) 12%, transparent);
}

.dshtp-banner[data-kind='readonly'] {
  border-inline-start-color: var(--dsw-alias-state-business-primary, #4d6bfe);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 10%, transparent);
}

.dshtp-banner-text {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.dshtp-banner-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  flex-wrap: wrap;
  justify-content: flex-end;
}

/* ------------------------------------------------------------------ */
/* In-panel toast (bottom of the body, never the first line)          */
/* ------------------------------------------------------------------ */

.dshtp-toast {
  position: absolute;
  inset-inline: 8px;
  inset-block-end: 8px;
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  max-width: min(560px, 100%);
  margin-inline: auto;
  padding: 6px 6px 6px 10px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-toast-bg, rgba(30, 32, 38, 0.94));
  color: var(--dsw-alias-toast-label, #f4f4f5);
  font-size: 12px;
  line-height: 1.5;
  box-shadow: var(--dsw-elevation-soft, 0 2px 8px rgba(0, 0, 0, 0.25));
}

.dshtp-toast-text {
  flex: 1;
  min-width: 0;
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.dshtp-toast-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.dshtp-toast-close {
  color: inherit;
}

/* Action buttons inside the dark in-panel toast must not use the page label
   color: they inherit the toast label and sit on translucent toast surfaces. */
.dshtp-toast .dshtp-action {
  color: inherit;
  background: color-mix(in srgb, var(--dsw-alias-toast-label, #f4f4f5) 12%, transparent);
  box-shadow: none;
}

.dshtp-toast .dshtp-action:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-toast-label, #f4f4f5) 22%, transparent);
}

.dshtp-toast .dshtp-action[data-variant='primary'] {
  background: var(--dsw-alias-toast-label, #f4f4f5);
  color: var(--dsw-alias-toast-bg, #1e2026);
}

.dshtp-toast-close:hover:not(:disabled) {
  color: var(--dsw-alias-toast-label, #f4f4f5);
  background: color-mix(in srgb, var(--dsw-alias-toast-label, #f4f4f5) 16%, transparent);
}

/* ------------------------------------------------------------------ */
/* Status bar (hidden unless abnormal/hover)                          */
/* ------------------------------------------------------------------ */

.dshtp-statusbar {
  position: absolute;
  inset-inline: 0;
  inset-block-end: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  box-sizing: border-box;
  height: 24px;
  min-height: 24px;
  padding: 0 8px;
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, transparent));
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
}

/* The status bar overlays the body instead of taking layout space: hovering
   the panel must not shrink the xterm grid (and post a PTY resize) on every
   mouse enter. Keep the transient toast above the bar when both are visible. */
.dshtp-root:has(.dshtp-statusbar[data-visible='true']) .dshtp-toast {
  inset-block-end: 32px;
}

.dshtp-statusbar[data-visible='false'] {
  display: none;
}

.dshtp-statusbar .dshtp-dot {
  width: 8px;
  height: 8px;
}

.dshtp-status-item {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}

.dshtp-status-spacer {
  flex: 1;
  min-width: 8px;
}

.dshtp-statusbar .dshtp-sandbox-badge,
.dshtp-statusbar .dshtp-readonly-badge {
  height: 18px;
}

/* ------------------------------------------------------------------ */
/* Popup menu / context menu                                           */
/* ------------------------------------------------------------------ */

.dshtp-menu,
.dshtp-context-menu {
  position: absolute;
  z-index: 30;
  box-sizing: border-box;
  min-width: 184px;
  max-width: min(280px, calc(100% - 16px));
  max-height: min(60vh, 360px);
  padding: 4px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2, rgba(127, 127, 127, 0.3)) transparent;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, transparent));
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 12px;
  line-height: 1.4;
  box-shadow: var(--dsw-elevation-panel, 0 8px 24px rgba(0, 0, 0, 0.18));
}

.dshtp-menu {
  inset-block-start: 36px;
  inset-inline-end: 8px;
}

.dshtp-context-menu {
  position: fixed;
  z-index: 1150;
  inset-block-start: 0;
  inset-inline-start: 0;
}

.dshtp-menu[hidden],
.dshtp-context-menu[hidden] {
  display: none;
}

.dshtp-menu-item,
.dshtp-context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  min-height: 28px;
  margin: 0;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  text-align: start;
  white-space: nowrap;
  cursor: pointer;
}

.dshtp-menu-item:hover:not(:disabled),
.dshtp-context-menu-item:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}

.dshtp-menu-item[data-danger='true'],
.dshtp-context-menu-item[data-danger='true'] {
  color: var(--dsw-alias-state-error-primary, #e5484d);
}

.dshtp-menu-item:disabled,
.dshtp-context-menu-item:disabled {
  opacity: 0.45;
  cursor: default;
  pointer-events: none;
}

.dshtp-menu-item svg,
.dshtp-context-menu-item svg {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--dsw-alias-label-secondary, inherit);
}

.dshtp-menu-item[data-danger='true'] svg {
  color: var(--dsw-alias-state-error-primary, #e5484d);
}

.dshtp-menu-sep {
  height: 1px;
  margin: 4px 2px;
  background: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
}

/* Shortcut caps inside menus / dialogs / help. */
.dshtp-root kbd,
.dshtp-global-toast kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  box-sizing: border-box;
  height: 18px;
  padding: 0 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #000) 8%, transparent);
  color: var(--dsw-alias-label-secondary, inherit);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1;
}

.dshtp-menu-item kbd,
.dshtp-context-menu-item kbd,
.dshtp-dialog kbd {
  margin-inline-start: auto;
}

/* ------------------------------------------------------------------ */
/* Shared compact action buttons (dialog / banner / status / toast)    */
/* ------------------------------------------------------------------ */

.dshtp-action,
.dshtp-dialog-action,
.dshtp-banner-action,
.dshtp-status-action,
.dshtp-toast-action,
.dshtp-empty-action,
.dshtp-error-action,
.dshtp-global-toast-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  flex: none;
  box-sizing: border-box;
  min-height: 24px;
  margin: 0;
  padding: 0 8px;
  border: 0;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
}

.dshtp-action:hover:not(:disabled),
.dshtp-dialog-action:hover,
.dshtp-banner-action:hover,
.dshtp-status-action:hover,
.dshtp-toast-action:hover,
.dshtp-empty-action:hover,
.dshtp-error-action:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}

.dshtp-action:disabled,
.dshtp-dialog-action:disabled,
.dshtp-banner-action:disabled,
.dshtp-status-action:disabled,
.dshtp-toast-action:disabled,
.dshtp-empty-action:disabled,
.dshtp-error-action:disabled {
  opacity: 0.45;
  cursor: default;
  pointer-events: none;
}

.dshtp-action[data-variant='ghost'],
.dshtp-dialog-action[data-variant='ghost'],
.dshtp-banner-action[data-variant='ghost'],
.dshtp-status-action[data-variant='ghost'] {
  box-shadow: none;
  background: transparent;
}

.dshtp-action[data-variant='ghost']:hover:not(:disabled),
.dshtp-dialog-action[data-variant='ghost']:hover:not(:disabled),
.dshtp-banner-action[data-variant='ghost']:hover:not(:disabled),
.dshtp-status-action[data-variant='ghost']:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}

.dshtp-action[data-variant='primary'],
.dshtp-dialog-action[data-variant='primary'],
.dshtp-empty-action[data-variant='primary'],
.dshtp-error-action[data-variant='primary'] {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4d6bfe));
  color: var(--dsw-alias-label-primary-foreground, inherit);
  box-shadow: none;
}

.dshtp-action[data-variant='primary']:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #4d6bfe));
}

.dshtp-action[data-variant='danger'],
.dshtp-dialog-action[data-variant='danger'],
.dshtp-error-action[data-variant='danger'] {
  color: var(--dsw-alias-state-error-primary, #e5484d);
}

.dshtp-global-toast-action {
  min-height: 24px;
  background: color-mix(in srgb, var(--dsw-alias-toast-label, #f4f4f5) 14%, transparent);
  color: inherit;
  box-shadow: none;
}

.dshtp-global-toast-action:hover {
  background: color-mix(in srgb, var(--dsw-alias-toast-label, #f4f4f5) 24%, transparent);
}

/* ------------------------------------------------------------------ */
/* Dialog (config / history / shortcuts help)                         */
/* ------------------------------------------------------------------ */

.dshtp-dialog {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 12px;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24));
}

.dshtp-dialog-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 520px;
  max-height: calc(100% - 8px);
  box-sizing: border-box;
  overflow: hidden;
  border-radius: var(--dsw-radius-md, 12px);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, transparent));
  color: var(--dsw-alias-label-primary, inherit);
  box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, 0.24));
}

.dshtp-dialog-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 8px 8px 8px 12px;
}

.dshtp-dialog-title {
  margin: 0;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dshtp-dialog-body {
  flex: 1;
  min-height: 0;
  padding: 0 12px 12px;
  overflow: auto;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1.6;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2, rgba(127, 127, 127, 0.3)) transparent;
}

.dshtp-dialog-body::-webkit-scrollbar {
  width: 8px;
}

.dshtp-dialog-body::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2, rgba(127, 127, 127, 0.3));
  border-radius: 999px;
}

.dshtp-dialog-hint {
  margin: 0 0 8px;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1.6;
}

.dshtp-dialog-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}

.dshtp-dialog-field label {
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1.4;
}

.dshtp-dialog-input,
.dshtp-dialog-select {
  box-sizing: border-box;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--dsw-radius-xs, 4px);
  background: var(--dsw-alias-bg-layer-1, transparent);
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
}

.dshtp-dialog-input::placeholder {
  color: var(--dsw-alias-label-secondary, inherit);
}

.dshtp-dialog-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: none;
  flex-wrap: wrap;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #000) 4%, transparent);
}

.dshtp-dialog-footer .dshtp-dialog-hint {
  flex: 1;
  min-width: 0;
  margin: 0;
}

.dshtp-dialog-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

/* ------------------------------------------------------------------ */
/* Search bar                                                          */
/* ------------------------------------------------------------------ */

.dshtp-search-bar {
  position: absolute;
  inset-inline: 8px;
  inset-block-start: 8px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 2px;
  box-sizing: border-box;
  height: 32px;
  padding: 4px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base, transparent));
  box-shadow: var(--dsw-elevation-panel, 0 8px 24px rgba(0, 0, 0, 0.18));
}

.dshtp-search-bar[hidden] {
  display: none;
}

.dshtp-search-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--dsw-radius-xs, 4px);
  background: transparent;
  color: var(--dsw-alias-label-primary, inherit);
  font: inherit;
  font-size: 12px;
  line-height: 1;
}

.dshtp-search-input::placeholder {
  color: var(--dsw-alias-label-secondary, inherit);
}

.dshtp-search-count {
  flex: none;
  min-width: 52px;
  padding: 0 4px;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.dshtp-search-count[data-empty='true'] {
  color: var(--dsw-alias-state-error-primary, #e5484d);
}

/* ------------------------------------------------------------------ */
/* History list                                                        */
/* ------------------------------------------------------------------ */

.dshtp-history-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--dsw-alias-scrollbar-bg-l2, rgba(127, 127, 127, 0.3)) transparent;
}

/* Full-body read-only history view (not the dialog list). */
.dshtp-history-view {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
  padding: 8px 8px 0;
}

.dshtp-history-view > .dshtp-banner {
  margin: 0;
}

.dshtp-history-view > .dshtp-history-preview {
  flex: 1;
  min-height: 0;
  max-height: none;
  margin: 0;
  padding: 8px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-bg-layer-1, transparent);
}

.dshtp-body > .dshtp-history-list {
  flex: 1;
  padding: 8px;
}

.dshtp-history-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 8px);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.dshtp-history-item:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}

.dshtp-history-item[data-active='true'] {
  background: var(--dsw-alias-interactive-bg-active, rgba(127, 127, 127, 0.14));
}

.dshtp-history-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 12px;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dshtp-history-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}

.dshtp-history-cwd {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dshtp-history-preview {
  margin: 4px 0 0;
  max-height: 84px;
  overflow: auto;
  color: var(--dsw-alias-label-secondary, inherit);
  font-family: var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 12px;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.dshtp-history-badge {
  display: inline-flex;
  align-items: center;
  flex: none;
  box-sizing: border-box;
  height: 18px;
  padding: 0 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #000) 8%, transparent);
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.dshtp-history-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
  flex: none;
  flex-wrap: wrap;
}

.dshtp-history-count {
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}

.dshtp-history-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1;
  min-height: 120px;
  padding: 16px;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}

/* ------------------------------------------------------------------ */
/* Sandbox / read-only badges                                          */
/* ------------------------------------------------------------------ */

.dshtp-sandbox-badge,
.dshtp-readonly-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  box-sizing: border-box;
  height: 18px;
  padding: 0 6px;
  border-radius: var(--dsw-radius-xs, 4px);
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #000) 8%, transparent);
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
}

.dshtp-readonly-badge {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 12%, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}

.dshtp-sandbox-badge[data-required='true'],
.dshtp-sandbox-badge[data-mode='read-only'],
.dshtp-sandbox-badge[data-mode='workspace-write'] {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d98700) 16%, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}

.dshtp-sandbox-badge svg,
.dshtp-readonly-badge svg {
  width: 12px;
  height: 12px;
}

/* ------------------------------------------------------------------ */
/* Empty / error / loading states                                     */
/* ------------------------------------------------------------------ */

.dshtp-empty,
.dshtp-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  flex: 1;
  min-height: 0;
  box-sizing: border-box;
  padding: 24px 16px;
  overflow: auto;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1.6;
  text-align: center;
}

.dshtp-empty-icon,
.dshtp-error-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  color: var(--dsw-alias-label-secondary, inherit);
}

.dshtp-error-icon {
  color: var(--dsw-alias-state-error-primary, #e5484d);
}

.dshtp-empty-title,
.dshtp-error-title {
  margin: 0;
  max-width: 30ch;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.dshtp-error-title {
  color: var(--dsw-alias-state-error-primary, #e5484d);
}

.dshtp-empty-hint,
.dshtp-error-detail {
  margin: 0;
  max-width: 42ch;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.dshtp-empty-actions,
.dshtp-error-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 4px;
}

/* ------------------------------------------------------------------ */
/* Global notice toast (rendered from index.tsx shell.overlay)         */
/* ------------------------------------------------------------------ */

/* Optional stack wrapper: keeps a welcome card and several failure toasts
   from overlapping at the same fixed corner. */
.dshtp-global-toast-stack {
  position: fixed;
  inset-block-end: 24px;
  inset-inline-end: 24px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  max-width: min(380px, calc(100vw - 32px));
  pointer-events: none;
}

.dshtp-global-toast-stack .dshtp-global-toast {
  position: relative;
  inset: auto;
  z-index: auto;
  width: 100%;
  pointer-events: auto;
}

.dshtp-global-toast {
  position: fixed;
  inset-block-end: 24px;
  inset-inline-end: 24px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 6px;
  box-sizing: border-box;
  width: min(380px, calc(100vw - 32px));
  padding: 10px 32px 10px 12px;
  border-radius: var(--dsw-radius-sm, 8px);
  background: var(--dsw-alias-toast-bg, rgba(30, 32, 38, 0.94));
  color: var(--dsw-alias-toast-label, #f4f4f5);
  font-size: 12px;
  line-height: 1.5;
  box-shadow: var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, 0.28));
}

.dshtp-global-toast[data-kind='error'] {
  box-shadow:
    var(--dsw-elevation-prominent, 0 12px 32px rgba(0, 0, 0, 0.28)),
    inset 2px 0 0 var(--dsw-alias-state-error-secondary, #e5484d);
}

.dshtp-global-toast-title {
  color: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1.4;
}

.dshtp-global-toast-body {
  display: -webkit-box;
  overflow: hidden;
  overflow-wrap: anywhere;
  opacity: 0.92;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.dshtp-global-toast-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 2px;
}

.dshtp-global-toast-close {
  position: absolute;
  inset-block-start: 6px;
  inset-inline-end: 6px;
  color: inherit;
}

.dshtp-global-toast-close:hover:not(:disabled) {
  color: var(--dsw-alias-toast-label, #f4f4f5);
  background: color-mix(in srgb, var(--dsw-alias-toast-label, #f4f4f5) 16%, transparent);
}

.dshtp-global-toast .dshtp-action {
  color: inherit;
  background: color-mix(in srgb, var(--dsw-alias-toast-label, #f4f4f5) 14%, transparent);
  box-shadow: none;
}

.dshtp-global-toast .dshtp-action:hover:not(:disabled) {
  background: color-mix(in srgb, var(--dsw-alias-toast-label, #f4f4f5) 24%, transparent);
}

.dshtp-global-toast .dshtp-action[data-variant='primary'] {
  background: var(--dsw-alias-toast-label, #f4f4f5);
  color: var(--dsw-alias-toast-bg, #1e2026);
}

/* ------------------------------------------------------------------ */
/* Focus visibility                                                    */
/* ------------------------------------------------------------------ */

.dshtp-root :is(
  .dshtp-new,
  .dshtp-more,
  .dshtp-follow,
  .dshtp-tab,
  .dshtp-tab-keep,
  .dshtp-tab-close,
  .dshtp-menu-item,
  .dshtp-context-menu-item,
  .dshtp-dialog-close,
  .dshtp-dialog-input,
  .dshtp-dialog-select,
  .dshtp-search-input,
  .dshtp-search-action,
  .dshtp-search-close,
  .dshtp-history-item,
  .dshtp-action,
  .dshtp-dialog-action,
  .dshtp-banner-action,
  .dshtp-status-action,
  .dshtp-toast-action,
  .dshtp-empty-action,
  .dshtp-error-action
):focus-visible,
.dshtp-global-toast button:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid
    var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4d6bfe));
  outline-offset: 2px;
}

.dshtp-tab-keep:focus-visible,
.dshtp-tab-close:focus-visible,
.dshtp-statusbar .dshtp-action:focus-visible,
.dshtp-menu-item:focus-visible,
.dshtp-context-menu-item:focus-visible,
.dshtp-toast .dshtp-action:focus-visible {
  outline-offset: -2px;
}

/* ------------------------------------------------------------------ */
/* Narrow pane: only optional labels/controls give way                 */
/* ------------------------------------------------------------------ */

@container dshtp (max-width: 340px) {
  .dshtp-label {
    display: none !important;
  }

  .dshtp-chrome {
    gap: 2px;
    padding-inline: 4px;
  }

  .dshtp-tab {
    max-width: 160px;
    padding-inline: 6px 2px;
  }

  .dshtp-tab-keep {
    display: none;
  }

  .dshtp-tab[data-pinned='true'] .dshtp-tab-keep {
    display: inline-flex;
  }

  .dshtp-session-strip {
    mask-image: none;
    -webkit-mask-image: none;
  }

  .dshtp-status-spacer + .dshtp-status-optional,
  .dshtp-statusbar .dshtp-status-optional {
    display: none;
  }

  .dshtp-search-count {
    min-width: 40px;
  }

  .dshtp-history-preview {
    max-height: 56px;
  }

  .dshtp-dialog {
    padding: 8px;
  }
}

/* ------------------------------------------------------------------ */
/* Reduced motion                                                     */
/* ------------------------------------------------------------------ */

@media (prefers-reduced-motion: reduce) {
  .dshtp-root *,
  .dshtp-global-toast * {
    transition: none !important;
    animation: none !important;
    scroll-behavior: auto !important;
  }
}

/* ------------------------------------------------------------------ */
/* Keyframes                                                          */
/* ------------------------------------------------------------------ */

@keyframes dshtp-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes dshtp-shimmer {
  to {
    transform: translateX(100%);
  }
}

@keyframes dshtp-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
`
