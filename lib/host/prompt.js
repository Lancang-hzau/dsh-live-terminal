/**
 * System-prompt guidance for the `live_terminal_*` tools (v1.2.1).
 *
 * The section is registered at the PET/PTY tool order, next to the official
 * persistent-terminal guidance, and kept short because it ships with every
 * request.
 */

/** Stable prompt section name. */
export const PROMPT_SECTION_NAME = 'tool:terminal-panel'

/** Guidance text shown to the model. */
export const PROMPT_TEXT = [
  'Shell commands run through the built-in `pwsh`/`bash` tools are mirrored live into the user\'s visible terminal panel; do not open a terminal just to show a command.',
  'Short commands may be hidden by default (they do not create a tab), while long commands and `live_terminal_run` command terminals stay visible and auto-close a few seconds after they finish. Pass `keepOpen:true` to `live_terminal_run` when the user should inspect the final screen; the user can also keep a terminal open from the panel.',
  'Use `live_terminal_screenshot` to read the current screen (text, or `format:"png"` when the user should see an image); `live_terminal_open` for an extra visible interactive terminal; `live_terminal_run` to run a command in a visible command terminal; `live_terminal_send` for interactive input (Ctrl-C is "\\u0003", or pass `keys:["C-c"]`); `live_terminal_wait` to wait for exit or a pattern without killing the process; `live_terminal_signal` to interrupt a running terminal; `live_terminal_resize` before capturing a TUI; `live_terminal_read`/`live_terminal_search` for bounded output; `live_terminal_exec` to run a command in an existing interactive terminal (keeps cwd/env); `live_terminal_history` for recently closed command output; `live_terminal_list` to list terminals; `live_terminal_close` to close one.',
  'Prefer the regular shell tools for ordinary bounded commands; use the terminal tools when the user should watch progress, when the command is interactive or long-running, or when you need the visible screen.',
  'Command terminals (built-in `pwsh`/`bash` calls and `live_terminal_run`) auto-close after 8s on success and 30s on failure unless the user pins them or you pass `keepOpen:true`. Failed commands produce a user notification even after the terminal closes, and their output is kept in `live_terminal_history`.',
  'Agent-created terminals run with the system user\'s permissions and do not use the DSH file sandbox; the panel marks them as unsandboxed. If the deployment requires confinement (`requireSandbox`), the plugin falls back to the built-in sandboxed tools instead of intercepting.',
].join(' ')

/**
 * Register the prompt section once the systemPrompt service exists.
 * @param {any} ctx plugin context.
 * @returns {void}
 */
export function registerPrompt(ctx) {
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: PROMPT_SECTION_NAME,
          order: promptCtx.systemPrompt.getSectionOrder('TOOL_PTY'),
          text: PROMPT_TEXT,
        }),
      'dsh-live-terminal: prompt section',
    )
  })
}
