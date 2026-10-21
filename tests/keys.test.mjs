import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bracketPaste, isKnownKeys, keySequence, resolveKeys } from '../lib/host/keys.js'

test('keySequence resolves named keys, ctrl chords and single characters', () => {
  assert.equal(keySequence('Enter'), '\r')
  assert.equal(keySequence('return'), '\r')
  assert.equal(keySequence('Tab'), '\t')
  assert.equal(keySequence('Shift+Tab'), '\x1b[Z')
  assert.equal(keySequence('Esc'), '\x1b')
  assert.equal(keySequence('Up'), '\x1b[A')
  assert.equal(keySequence('PageDown'), '\x1b[6~')
  assert.equal(keySequence('F12'), '\x1b[24~')
  assert.equal(keySequence('C-c'), '\x03')
  assert.equal(keySequence('ctrl-a'), '\x01')
  assert.equal(keySequence('c-z'), '\x1a')
  assert.equal(keySequence('q'), 'q')
  assert.equal(keySequence('Space'), ' ')
  assert.equal(keySequence(' '), undefined, 'whitespace-only names are trimmed away')
})

test('keySequence rejects unknown multi-character names and empty strings', () => {
  assert.equal(keySequence('NotAKey'), undefined)
  assert.equal(keySequence(''), undefined)
  assert.equal(keySequence('  '), undefined)
  assert.equal(keySequence(undefined), undefined)
})

test('resolveKeys concatenates keys and reports the allowed vocabulary', () => {
  assert.equal(resolveKeys(['Up', 'Enter']), '\x1b[A\r')
  assert.equal(resolveKeys([]), '')
  assert.throws(() => resolveKeys(['Nope']), /unknown key name/u)
  assert.throws(() => resolveKeys('Up'), /must be an array/u)
  assert.equal(isKnownKeys(['Up', 'C-c']), true)
  assert.equal(isKnownKeys(['Up', 'Nope']), false)
})

test('bracketPaste wraps text in DECSET 2004 markers', () => {
  assert.equal(bracketPaste('a\nb'), '\x1b[200~a\nb\x1b[201~')
  assert.equal(bracketPaste(''), '\x1b[200~\x1b[201~')
})
