import assert from 'node:assert/strict'
import { test } from 'node:test'

import { registerTools } from '../lib/host/tools.js'
import { resolveConfig } from '../lib/index.js'
import { validateValue } from './helpers/schema.mjs'

const agent = { id: 'agent-1', session: { id: 'session-1' } }

/** Minimal fake session matching the tools' screenshot surface. */
function fakeSession() {
  const info = {
    id: 'terminal-1',
    title: 'build',
    kind: 'command',
    owner: 'agent',
    agentId: 'agent-1',
    cwd: 'C:\\work',
    cols: 80,
    rows: 24,
    state: 'exited',
    exitCode: 0,
    signal: null,
    startedAt: 1000,
    endedAt: 1500,
    durationMs: 500,
    shellKind: 'pwsh',
    ports: [],
    sandbox: { mode: 'danger-full-access', confined: false, required: false },
    autoCloseAt: null,
    autoClosePaused: false,
    pinned: false,
    createdAt: 1000,
    updatedAt: 1500,
  }
  return {
    id: info.id,
    title: info.title,
    kind: info.kind,
    owner: info.owner,
    agentId: info.agentId,
    info,
    state: info.state,
    cols: info.cols,
    rows: info.rows,
    sandbox: info.sandbox,
    async requestCapture() {
      return { buffer: Buffer.from('fake-png'), width: 640, height: 480 }
    },
    snapshot() {
      return { info, screen: '', text: 'screen', cursor: { x: 1, y: 2 }, seq: 1 }
    },
    visibleText() {
      return 'screen'
    },
    fullText() {
      return 'scrollback\nscreen'
    },
    serialize() {
      return 'ansi-screen'
    },
  }
}

/** Registry double for the screenshot tool. */
function fakeRegistry(session) {
  return {
    lookup: (id) => (id === session.id ? session : undefined),
    history: { size: 0, get: () => undefined },
    historyList: () => [],
    resolveRecentForAgent: () => session,
    resolveForAgent: () => session,
    sandboxFor: () => session.sandbox,
  }
}

/** Register the tools into a tiny fake plugin context. */
function setup({ attachments } = {}) {
  const definitions = new Map()
  const ctx = {
    effect: (callback) => callback(),
    tools: {
      register: (definition) => {
        definitions.set(definition.name, definition)
      },
    },
  }
  const session = fakeSession()
  const plugin = {
    config: resolveConfig({ historyPath: '' }),
    registry: fakeRegistry(session),
    getAttachments: () => attachments,
  }
  registerTools(ctx, plugin)
  return { definitions, session, plugin }
}

/** Invoke one tool and validate its value against the output schema. */
async function runTool(definitions, name, args, exec = { agent }) {
  const definition = definitions.get(name)
  assert.ok(definition, `tool ${name} is registered`)
  const value = await definition.execute(args, exec)
  const errors = validateValue(value, definition.output.schema)
  assert.deepEqual(errors, [], `output schema errors: ${errors.join('; ')}`)
  return { value, render: definition.output.render(args, value), definition }
}

test('live_terminal_screenshot format:png saves a browser capture as an attachment', async () => {
  let saved
  const attachments = {
    async saveImage(input) {
      saved = input
      return {
        attachmentId: 'attachment-1',
        mediaType: 'image/png',
        bytes: input.data.byteLength,
        width: 640,
        height: 480,
        name: input.name,
      }
    },
  }
  const { definitions } = setup({ attachments })
  const { value, render } = await runTool(definitions, 'live_terminal_screenshot', {
    terminalId: 'terminal-1',
    format: 'png',
  })
  assert.equal(saved.mediaType, 'image/png')
  assert.equal(saved.name, 'terminal-terminal-1.png')
  assert.equal(value.image.attachmentId, 'attachment-1')
  assert.equal(value.image.width, 640)
  assert.equal(value.image.height, 480)
  assert.ok(Array.isArray(render))
  assert.equal(render[0].type, 'text')
  assert.equal(render[1].type, 'image')
  assert.equal(render[1].attachment.attachmentId, 'attachment-1')
})

test('live_terminal_screenshot format:png falls back to text with a warning when no browser is attached', async () => {
  const { definitions, session } = setup({ attachments: undefined })
  session.requestCapture = async () => {
    throw Object.assign(new Error('no browser attached'), { code: 'CAPTURE_TIMEOUT' })
  }
  const { value, render } = await runTool(definitions, 'live_terminal_screenshot', {
    terminalId: 'terminal-1',
    format: 'png',
  })
  assert.equal(value.image, undefined)
  assert.ok(value.warnings.some((warning) => /png capture unavailable/u.test(warning)))
  assert.equal(render.length, 1)
  assert.match(render[0].text, /warnings:/u)
})

test('live_terminal_screenshot format:png falls back when the attachment service is missing', async () => {
  const { definitions } = setup({ attachments: undefined })
  const { value } = await runTool(definitions, 'live_terminal_screenshot', {
    terminalId: 'terminal-1',
    format: 'png',
  })
  assert.equal(value.image, undefined)
  assert.ok(value.warnings.some((warning) => /attachment service is unavailable/u.test(warning)))
})
