import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  commandArgv,
  executableName,
  interactiveArgv,
  resolveShell,
  shellCandidates,
  shellKind,
} from '../lib/host/shell.js'

test('executableName strips directories and the .exe suffix', () => {
  assert.equal(executableName('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'pwsh')
  assert.equal(executableName('/usr/bin/bash'), 'bash')
  assert.equal(executableName('powershell'), 'powershell')
})

test('shellKind classifies supported shells', () => {
  assert.equal(shellKind('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'powershell')
  assert.equal(shellKind('/usr/bin/pwsh'), 'pwsh')
  assert.equal(shellKind('cmd.exe'), 'cmd')
  assert.equal(shellKind('/bin/bash'), 'bash')
  assert.equal(shellKind('/usr/bin/zsh'), 'zsh')
  assert.equal(shellKind('/usr/bin/fish'), 'other')
})

test('interactiveArgv keeps the profile and asks for no logo', () => {
  assert.deepEqual(interactiveArgv({ path: 'C:\\pwsh.exe', kind: 'pwsh' }), ['C:\\pwsh.exe', '-NoLogo'])
  assert.deepEqual(interactiveArgv({ path: 'C:\\powershell.exe', kind: 'powershell' }), ['C:\\powershell.exe', '-NoLogo'])
  assert.deepEqual(interactiveArgv({ path: '/bin/bash', kind: 'bash' }), ['/bin/bash', '-i'])
  assert.deepEqual(interactiveArgv({ path: 'cmd.exe', kind: 'cmd' }), ['cmd.exe'])
})

test('commandArgv matches the built-in pwsh executor semantics', () => {
  assert.deepEqual(commandArgv({ path: 'C:\\pwsh.exe', kind: 'pwsh' }, 'Get-ChildItem'), [
    'C:\\pwsh.exe',
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-ChildItem',
  ])
  assert.deepEqual(commandArgv({ path: '/bin/bash', kind: 'bash' }, 'ls'), ['/bin/bash', '-c', 'ls'])
})

test('shellCandidates prefers pwsh, then powershell, then the provider default', () => {
  assert.deepEqual(shellCandidates('windows', undefined, 'C:\\Windows\\System32\\cmd.exe'), [
    'pwsh',
    'powershell',
    'C:\\Windows\\System32\\cmd.exe',
    'cmd.exe',
  ])
  assert.deepEqual(shellCandidates('windows', 'C:\\custom\\pwsh.exe'), ['C:\\custom\\pwsh.exe'])
  assert.deepEqual(shellCandidates('posix', undefined, '/bin/zsh'), ['bash', '/bin/zsh'])
})

/**
 * @param {string[]} available executable names the fake provider resolves.
 * @returns {any} fake subprocess service.
 */
function fakeSubprocess(available) {
  return {
    async terminalEnvironment() {
      return { platform: 'windows', defaultShell: 'C:\\Windows\\System32\\cmd.exe' }
    },
    async resolveExecutable(name) {
      if (available.includes(name)) return `C:\\resolved\\${name}.exe`
      const error = new Error(`${name} not found`)
      error.name = 'SubprocessExecutableNotFoundError'
      throw error
    },
  }
}

test('resolveShell falls back from pwsh to powershell', async () => {
  const shell = await resolveShell({ subprocess: fakeSubprocess(['powershell']) })
  assert.equal(shell.kind, 'powershell')
  assert.equal(shell.path, 'C:\\resolved\\powershell.exe')
})

test('resolveShell honours a configured shellPath and rejects when missing', async () => {
  const shell = await resolveShell({ subprocess: fakeSubprocess(['pwsh']), shellPath: 'pwsh' })
  assert.equal(shell.kind, 'pwsh')
  await assert.rejects(
    () => resolveShell({ subprocess: fakeSubprocess(['pwsh']), shellPath: 'missing-shell' }),
    /could not be resolved/,
  )
})

test('resolveShell rejects when no candidate resolves', async () => {
  await assert.rejects(() => resolveShell({ subprocess: fakeSubprocess([]) }), /no usable shell found/)
})

test('shellCandidates tries hint-specific executables first', () => {
  assert.deepEqual(shellCandidates('windows', undefined, 'C:\\Windows\\System32\\cmd.exe', 'bash'), [
    'bash',
    'pwsh',
    'powershell',
    'C:\\Windows\\System32\\cmd.exe',
    'cmd.exe',
  ])
  assert.deepEqual(shellCandidates('windows', undefined, undefined, 'pwsh'), ['pwsh', 'powershell', 'cmd.exe'])
  assert.deepEqual(shellCandidates('posix', undefined, '/bin/zsh', 'bash'), ['bash', '/bin/zsh'])
  // A configured shellPath stays authoritative; the hint only validates it later.
  assert.deepEqual(shellCandidates('windows', 'C:\\custom\\bash.exe', undefined, 'bash'), ['C:\\custom\\bash.exe'])
})

test('resolveShell with a bash hint never returns a PowerShell/cmd shell', async () => {
  await assert.rejects(
    () => resolveShell({ subprocess: fakeSubprocess(['pwsh', 'powershell']), kindHint: 'bash' }),
    /no usable shell found for shell kind bash/,
  )
})

test('resolveShell with a bash hint succeeds when bash is available', async () => {
  const shell = await resolveShell({ subprocess: fakeSubprocess(['bash']), kindHint: 'bash' })
  assert.equal(shell.kind, 'bash')
  assert.equal(shell.path, 'C:\\resolved\\bash.exe')
})

test('resolveShell with a pwsh hint accepts Windows PowerShell', async () => {
  const shell = await resolveShell({ subprocess: fakeSubprocess(['powershell']), kindHint: 'pwsh' })
  assert.equal(shell.kind, 'powershell')
})

test('resolveShell validates a configured shellPath against the hint', async () => {
  await assert.rejects(
    () => resolveShell({ subprocess: fakeSubprocess(['pwsh']), shellPath: 'pwsh', kindHint: 'bash' }),
    /could not be resolved for shell kind bash/,
  )
})

test('resolveShell rejects without a subprocess service', async () => {
  await assert.rejects(() => resolveShell({ subprocess: undefined }), /subprocess service is unavailable/)
})
