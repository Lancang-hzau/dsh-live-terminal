import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  commandOutputText,
  normalizeTerminalText,
  stripAnsi,
  trimLineEnds,
} from '../lib/host/ansi.js'

test('stripAnsi removes SGR colour sequences', () => {
  const raw = '\u001B[31mred\u001B[0m and \u001B[1;32mgreen\u001B[22m'
  assert.equal(stripAnsi(raw), 'red and green')
})

test('stripAnsi removes cursor and erase sequences', () => {
  const raw = '\u001B[2J\u001B[H\u001B[?25lhello\u001B[?25h\u001B[10;20H'
  assert.equal(stripAnsi(raw), 'hello')
})

test('stripAnsi removes BEL and ST terminated OSC titles', () => {
  assert.equal(stripAnsi('\u001B]0;window title\u0007content'), 'content')
  assert.equal(stripAnsi('\u001B]2;st title\u001B\\content'), 'content')
})

test('stripAnsi removes DCS strings', () => {
  assert.equal(stripAnsi('\u001BPq#0;payload\u001B\\done'), 'done')
})

test('stripAnsi keeps plain text untouched', () => {
  assert.equal(stripAnsi('普通文本 with emoji 😀'), '普通文本 with emoji 😀')
})

test('stripAnsi tolerates empty and non-string input', () => {
  assert.equal(stripAnsi(''), '')
  assert.equal(stripAnsi(undefined), '')
})

test('normalizeTerminalText collapses CRLF and lone CR to newlines', () => {
  assert.equal(normalizeTerminalText('a\r\nb\rc\nd'), 'a\nb\nc\nd')
})

test('normalizeTerminalText strips ANSI and control characters but keeps tabs', () => {
  assert.equal(normalizeTerminalText('\u001B[32mok\u001B[0m\u0000\u0007\tend'), 'ok\tend')
})

test('trimLineEnds right-trims each line', () => {
  assert.equal(trimLineEnds('a   \nb  '), 'a\nb')
  assert.equal(trimLineEnds(''), '')
})

test('commandOutputText strips ANSI, normalizes newlines and drops trailing blank lines', () => {
  assert.equal(commandOutputText('\u001B[31mone\u001B[0m\r\ntwo\r\n\r\n'), 'one\ntwo')
})
