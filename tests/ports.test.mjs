import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractPorts } from '../lib/host/ports.js'

test('extractPorts finds loopback URLs with and without schemes', () => {
  const ports = extractPorts('ready at http://localhost:5173/ and also 127.0.0.1:8080\nsee https://[::1]:3000/app')
  const urls = ports.map((port) => port.url)
  assert.ok(urls.includes('http://localhost:5173/'))
  assert.ok(urls.includes('http://127.0.0.1:8080'))
  assert.ok(urls.some((url) => url.startsWith('https://[::1]:3000')))
  assert.equal(ports.find((port) => port.port === 5173)?.host, 'localhost')
})

test('extractPorts ignores external hosts and invalid ports', () => {
  const ports = extractPorts('https://example.com:443 and localhost:99999 and localhost:0 and 10.0.0.1:3000')
  assert.deepEqual(ports, [])
})

test('extractPorts de-duplicates by host:port and defaults scheme ports', () => {
  const ports = extractPorts('http://localhost:3000/a then http://localhost:3000/b then http://localhost')
  assert.equal(ports.length, 2)
  assert.equal(ports[0].port, 3000)
  assert.equal(ports[1].port, 80)
  assert.ok(ports.every((port) => typeof port.firstSeenAt === 'number' && typeof port.lastSeenAt === 'number'))
})

test('extractPorts strips ANSI sequences', () => {
  const ports = extractPorts('\x1b[32mhttp://localhost:4321/\x1b[0m')
  assert.equal(ports.length, 1)
  assert.equal(ports[0].url, 'http://localhost:4321/')
})
