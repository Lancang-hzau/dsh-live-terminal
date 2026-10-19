/**
 * Stylesheet for the terminal panel.
 *
 * Kept as a plain string (no CSS modules) because the bundle is a single file;
 * `index.tsx` injects it together with xterm's own CSS into one idempotent
 * `<style data-plugin="dsh-terminal-panel">` tag. Colors follow the `--dsw-*`
 * design tokens with graceful fallbacks.
 */

export const styles = String.raw`
.dshtp-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  min-width: 0;
  box-sizing: border-box;
  font-size: 13px;
  line-height: 1.4;
  color: var(--dsw-alias-label-primary, inherit);
  background: transparent;
}
.dshtp-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
  padding: 5px 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
}
.dshtp-spacer {
  flex: 1;
  min-width: 0;
}
.dshtp-title {
  flex: none;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 12px;
  font-weight: 500;
}
.dshtp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex: none;
  height: 26px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  outline: none;
}
.dshtp-btn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-primary, inherit);
}
.dshtp-btn:focus-visible {
  box-shadow: inset 0 0 0 1px var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4d6bfe));
}
.dshtp-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.dshtp-btn-primary {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4d6bfe));
  color: var(--dsw-alias-label-primary-foreground, #ffffff);
}
.dshtp-btn-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #4d6bfe));
  color: var(--dsw-alias-label-primary-foreground, #ffffff);
}
.dshtp-btn-danger:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(220, 60, 60, 0.14));
  color: var(--dsw-alias-state-error-primary, #e5484d);
}
.dshtp-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 4px 8px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
}
.dshtp-tabs::-webkit-scrollbar {
  height: 4px;
}
.dshtp-tabs::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2, rgba(127, 127, 127, 0.3));
  border-radius: 2px;
}
.dshtp-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  max-width: 220px;
  height: 24px;
  padding: 0 4px 0 8px;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  user-select: none;
  outline: none;
}
.dshtp-tab:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
}
.dshtp-tab[data-active='true'] {
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.14));
  border-color: var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  color: var(--dsw-alias-label-primary, inherit);
}
.dshtp-tab:focus-visible {
  box-shadow: inset 0 0 0 1px var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4d6bfe));
}
.dshtp-tab-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dshtp-tab-meta {
  flex: none;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));
  font-size: 11px;
}
.dshtp-tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 0;
  background: transparent;
  border-radius: 4px;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));
  font: inherit;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  outline: none;
}
.dshtp-tab-close:hover {
  background: var(--dsw-alias-interactive-bg-hover-danger, rgba(220, 60, 60, 0.16));
  color: var(--dsw-alias-state-error-primary, #e5484d);
}
.dshtp-tab-close:focus-visible {
  box-shadow: inset 0 0 0 1px var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4d6bfe));
}
.dshtp-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-success-primary, #2fbf71);
}
.dshtp-dot[data-state='exited'] {
  background: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));
}
.dshtp-dot[data-state='failed'] {
  background: var(--dsw-alias-state-error-primary, #e5484d);
}
.dshtp-dot[data-state='disconnected'] {
  background: var(--dsw-alias-state-warn-primary, #d98700);
}
.dshtp-body {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.dshtp-screen {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  padding: 6px 4px 6px 8px;
  overflow: hidden;
}
.dshtp-screen .xterm {
  height: 100%;
  width: 100%;
}
.dshtp-screen .xterm-viewport {
  background: transparent !important;
  scrollbar-width: thin;
}
.dshtp-screen .xterm-viewport::-webkit-scrollbar {
  width: 6px;
}
.dshtp-screen .xterm-viewport::-webkit-scrollbar-thumb {
  background: var(--dsw-alias-scrollbar-bg-l2, rgba(127, 127, 127, 0.3));
  border-radius: 3px;
}
.dshtp-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  gap: 10px;
  padding: 24px 18px;
  text-align: center;
  color: var(--dsw-alias-label-secondary, inherit);
  overflow: auto;
}
.dshtp-state > svg {
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));
}
.dshtp-state-title {
  margin: 0;
  max-width: 30ch;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.dshtp-state-detail {
  margin: 0;
  max-width: 40ch;
  font-size: 11px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));
  overflow-wrap: anywhere;
}
.dshtp-state-error .dshtp-state-title {
  color: var(--dsw-alias-state-error-primary, #e5484d);
}
.dshtp-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 16px;
  text-align: center;
  background: var(--dsw-alias-bg-base, rgba(23, 25, 29, 0.72));
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
}
.dshtp-overlay .dshtp-state-title {
  color: var(--dsw-alias-label-primary, inherit);
}
.dshtp-toast {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 10;
  max-width: 80%;
  padding: 5px 10px;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-toast-bg, rgba(30, 32, 38, 0.94));
  color: var(--dsw-alias-toast-label, #f4f4f5);
  font-size: 12px;
  line-height: 1.4;
  box-shadow: var(--dsw-elevation-soft, 0 2px 8px rgba(0, 0, 0, 0.25));
  pointer-events: none;
}
.dshtp-statusbar {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 3px 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
  color: var(--dsw-alias-label-tertiary, rgba(127, 127, 127, 0.9));
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
}
.dshtp-status-item {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
`
