/**
 * System-prompt guidance for the `live_terminal_*` tools.
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
  'Use `live_terminal_screenshot` to read the current screen (best for TUI/full-screen programs), `live_terminal_open` for an extra visible interactive terminal, `live_terminal_run` to run a command in the visible terminal, `live_terminal_send` for interactive input (Ctrl-C is "\\u0003"), `live_terminal_read` for recent output, `live_terminal_list` to list terminals and `live_terminal_close` to close one.',
  'Prefer the regular shell tools for ordinary bounded commands; use the terminal tools when the user should watch progress or when the command is interactive or long-running.',
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
      'dsh-terminal-panel: prompt section',
    )
  })
}
