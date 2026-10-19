import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ByteTail, tailByBytes, utf8ByteLength } from '../lib/host/ring.js'

test('utf8ByteLength counts UTF-8 bytes, not code units', () => {
  assert.equal(utf8ByteLength('abc'), 3)
  assert.equal(utf8ByteLength('你'), 3)
  assert.equal(utf8ByteLength('😀'), 4)
})

test('tailByBytes keeps the tail and reports truncation', () => {
  assert.deepEqual(tailByBytes('hello', 3), { text: 'llo', truncated: true })
  assert.deepEqual(tailByBytes('hello', 10), { text: 'hello', truncated: false })
})

test('tailByBytes never splits a multi-byte code point', () => {
  const result = tailByBytes('你你你你', 4)
  assert.equal(result.truncated, true)
  assert.equal(result.text, '你')
  assert.equal(utf8ByteLength(result.text), 3)
  assert.ok(!result.text.includes('\uFFFD'))
})

test('tailByBytes handles surrogate pairs', () => {
  const result = tailByBytes('ab😀', 2)
  assert.equal(result.truncated, true)
  assert.equal(result.text, '')
  assert.ok(!result.text.includes('\uFFFD'))
})

test('ByteTail keeps text under the byte bound', () => {
  const tail = new ByteTail(10)
  tail.append('hello')
  assert.equal(tail.text(), 'hello')
  assert.equal(tail.byteLength, 5)
  tail.append(' world')
  assert.equal(tail.byteLength, 10)
  assert.equal(tail.text(), 'ello world')
})

test('ByteTail drops whole chunks from the head', () => {
  const tail = new ByteTail(4)
  tail.append('abc')
  tail.append('def')
  assert.equal(tail.text(), 'cdef')
  assert.equal(tail.byteLength, 4)
})

test('ByteTail trims a single oversized append at a UTF-8 boundary', () => {
  const tail = new ByteTail(4)
  tail.append('你你你你')
  assert.equal(tail.byteLength, 3)
  assert.equal(tail.text(), '你')
  assert.ok(!tail.text().includes('\uFFFD'))
})

test('ByteTail reset and clear discard previous output', () => {
  const tail = new ByteTail(8)
  tail.append('abcdef')
  tail.reset('xy')
  assert.equal(tail.text(), 'xy')
  tail.clear()
  assert.equal(tail.text(), '')
  assert.equal(tail.byteLength, 0)
})

test('ByteTail rejects an invalid byte bound', () => {
  assert.throws(() => new ByteTail(0), TypeError)
  assert.throws(() => new ByteTail(1.5), TypeError)
})
