/**
 * dsh-terminal-panel — host half (skeleton).
 *
 * A Cordis plugin. In the final version this half owns PTY terminal sessions,
 * streams their output to the browser over HTTP/SSE, and registers the
 * model-facing terminal tools (run + screenshot).
 */

export const name = 'dsh-terminal-panel'

/** Services that must exist before this plugin activates. */
export const inject = ['tools']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  console.log('[dsh-terminal-panel] host half loaded')

  // Register a tiny probe tool so we can verify tool registration end-to-end.
  ctx.tools.register({
    name: 'terminal_panel_ping',
    description: 'Health probe for the dsh-terminal-panel plugin. Returns "pong".',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      return 'pong'
    },
  })

  // Custom HTTP surface. Every route authenticates through the DSH connection
  // service (same signed cookie the Web GUI uses).
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const webserver = webCtx.webServer
    const connection = webCtx.connection

    const authorize = (req, res) => {
      const admission = connection?.admit?.(req)
      if (admission === undefined || 'rejection' in admission) {
        res.writeHead(admission?.rejection ?? 401)
        res.end(admission?.rejection === 403 ? 'forbidden' : 'unauthorized')
        return undefined
      }
      return admission.peer
    }

    ctx.effect(() => webserver.register({
      kind: 'exact',
      path: '/dsh-terminal-panel/ping',
      handler: (req, res) => {
        if (authorize(req, res) === undefined) return
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, plugin: 'dsh-terminal-panel' }))
      },
    }), 'dsh-terminal-panel: ping route')

    console.log('[dsh-terminal-panel] routes registered')
  })
}
