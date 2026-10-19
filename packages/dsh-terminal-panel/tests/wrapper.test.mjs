import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  commandTitle,
  createMarkers,
  parseWrappedOutput,
  partialWrappedOutput,
  quoteForPwsh,
  wrapPwshCommand,
} from '../lib/host/wrapper.js'

const marker = createMarkers('test-nonce')

/**
 * Build a pseudo PTY transcript: prompt + echoed wrapper, the START marker,
 * output lines and the END marker with its exit status.
 * @param {{ marker: { start: string, end: string }, wrapper: string, output: string[], exitCode: number, trailing?: string }} options transcript inputs.
 * @returns {string} plain transcript.
 */
function transcript({ marker: pair, wrapper, output, exitCode, trailing = 'PS C:\\Users\\user> ' }) {
  return [
    `PS C:\\Users\\user> ${wrapper}`,
    pair.start,
    ...output,
    `${pair.end}${exitCode}`,
    trailing,
  ].join('\r\n')
}

test('createMarkers creates a matching START/END pair from a nonce', () => {
  assert.match(marker.start, /^__DSH_TERMINAL_PANEL_START_testnonce__$/)
  assert.match(marker.end, /^__DSH_TERMINAL_PANEL_END_testnonce:$/)
})

test('createMarkers defaults to a random nonce', () => {
  const first = createMarkers()
  const second = createMarkers()
  assert.notEqual(first.start, second.start)
})

test('quoteForPwsh escapes backtick, quote, dollar, CR, LF and ESC', () => {
  assert.equal(quoteForPwsh('a`b'), 'a``b')
  assert.equal(quoteForPwsh('say "hi"'), 'say `"hi`"')
  assert.equal(quoteForPwsh('$env:PATH'), '`$env:PATH')
  assert.equal(quoteForPwsh('a\r\nb'), 'a`nb')
  assert.equal(quoteForPwsh('a\u001Bb'), 'a`eb')
})

test('wrapPwshCommand contains both markers and the escaped body', () => {
  const wrapper = wrapPwshCommand('Get-ChildItem | Select-Object -First 2', marker)
  assert.ok(wrapper.includes(`Write-Output '${marker.start}'`))
  assert.ok(wrapper.includes(`'${marker.end}' + $__s`))
  assert.ok(wrapper.includes('Invoke-Expression "Get-ChildItem | Select-Object -First 2"'))
  assert.ok(wrapper.includes('$LASTEXITCODE'))
  // Interactive PowerShell 5.1 reports $? = True for non-terminating errors;
  // the wrapper still has to detect the error to mirror built-in exit codes.
  assert.ok(wrapper.includes('$__e0 = $Error.Count'))
  assert.ok(wrapper.includes('$Error.Count -eq $__e0'))
})

test('parseWrappedOutput extracts output and exit code, ignoring the echoed wrapper', () => {
  const wrapper = wrapPwshCommand('Write-Output "hello"', marker)
  const text = transcript({ marker, wrapper, output: ['hello'], exitCode: 0 })
  assert.deepEqual(parseWrappedOutput(text, marker, wrapper), {
    output: 'hello',
    exitCode: 0,
    incomplete: false,
  })
})

test('parseWrappedOutput keeps multi-line output and reports non-zero exit codes', () => {
  const wrapper = wrapPwshCommand('bad-command', marker)
  const text = transcript({
    marker,
    wrapper,
    output: ['line one', 'line two', '', 'last line'],
    exitCode: 7,
  })
  const parsed = parseWrappedOutput(text, marker, wrapper)
  assert.equal(parsed.exitCode, 7)
  assert.equal(parsed.output, 'line one\nline two\n\nlast line')
})

test('parseWrappedOutput removes an echoed line that landed inside the captured region', () => {
  const echoed = 'PS C:\\work> redirected echo fragment'
  const text = [marker.start, 'before', echoed, '1', `${marker.end}0`].join('\r\n')
  const parsed = parseWrappedOutput(text, marker, echoed)
  // Removing an interior echoed line leaves its line break, exactly like the
  // reference persistent-pwsh parser.
  assert.equal(parsed.output, 'before\n\n1')
  assert.equal(parsed.exitCode, 0)
})

test('parseWrappedOutput picks the LAST marker pair when two commands ran', () => {
  const firstMarker = createMarkers('first')
  const secondMarker = createMarkers('second')
  const firstWrapper = wrapPwshCommand('Write-Output "first"', firstMarker)
  const secondWrapper = wrapPwshCommand('Write-Output "second"', secondMarker)
  const text = [
    `PS C:\\> ${firstWrapper}`,
    firstMarker.start,
    'first',
    `${firstMarker.end}0`,
    'PS C:\\> ',
    `PS C:\\> ${secondWrapper}`,
    secondMarker.start,
    'second',
    `${secondMarker.end}3`,
    'PS C:\\> ',
  ].join('\r\n')
  const parsed = parseWrappedOutput(text, secondMarker, secondWrapper)
  assert.equal(parsed.output, 'second')
  assert.equal(parsed.exitCode, 3)
  assert.equal(parsed.incomplete, false)
})

test('parseWrappedOutput strips ANSI colour codes from the captured output', () => {
  const wrapper = wrapPwshCommand('Write-Output "red"', marker)
  const text = [marker.start, '\u001B[31mred\u001B[0m', `${marker.end}0`].join('\r\n')
  assert.equal(parseWrappedOutput(text, marker, wrapper).output, 'red')
})

test('parseWrappedOutput returns undefined until the END status is complete', () => {
  const wrapper = wrapPwshCommand('sleep 1', marker)
  assert.equal(parseWrappedOutput(`${marker.start}\r\nstill running`, marker, wrapper), undefined)
  assert.equal(parseWrappedOutput(`${marker.start}\r\nout\r\n${marker.end}`, marker, wrapper), undefined)
})

test('parseWrappedOutput flags a missing START marker as incomplete', () => {
  const wrapper = wrapPwshCommand('cmd', marker)
  const text = ['partial output', `${marker.end}0`].join('\r\n')
  const parsed = parseWrappedOutput(text, marker, wrapper)
  assert.equal(parsed.output, 'partial output')
  assert.equal(parsed.exitCode, 0)
  assert.equal(parsed.incomplete, true)
})

test('partialWrappedOutput captures output after the START marker', () => {
  const wrapper = wrapPwshCommand('cmd', marker)
  const text = [marker.start, 'partial one', 'partial two'].join('\r\n')
  assert.deepEqual(partialWrappedOutput(text, marker, wrapper), {
    output: 'partial one\npartial two',
    incomplete: false,
  })
})

test('partialWrappedOutput falls back to the retained text when START was lost', () => {
  const wrapper = wrapPwshCommand('cmd', marker)
  assert.deepEqual(partialWrappedOutput('tail only', marker, wrapper, 'older tail only'), {
    output: 'older tail only',
    incomplete: true,
  })
})

test('commandTitle uses the first line and bounds its length', () => {
  assert.equal(commandTitle('Get-ChildItem\nWrite-Output x'), 'Get-ChildItem')
  assert.equal(commandTitle(''), 'command')
  assert.equal(commandTitle('   '), 'command')
  const long = commandTitle('x'.repeat(200))
  assert.equal(long.length, 80)
  assert.ok(long.endsWith('…'))
})
