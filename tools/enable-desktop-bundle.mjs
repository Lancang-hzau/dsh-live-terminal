#!/usr/bin/env node
/**
 * Add dsh-live-terminal to the Desktop profile's `dsh.profile.bundles` list
 * (the CLI package operation only edits dependencies; bundle selection is a
 * separate profile-manager concern).
 *
 * The write is atomic (temp file + rename) so the running Desktop host's HMR
 * manifest watcher never observes a partial document.
 *
 * Usage: node tools/enable-desktop-bundle.mjs [--disable]
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const manifestPath = join(home, 'profiles', 'desktop', 'package.json')
const BUNDLE = 'dsh-live-terminal'
/** Pre-1.0 name of the same plugin; dropped while selecting the new one. */
const LEGACY = 'dsh-terminal-panel'
const disable = process.argv.includes('--disable')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
const bundles = (Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [])
  .filter((name) => name !== LEGACY)
const has = bundles.includes(BUNDLE)
if (disable) {
  manifest.dsh.profile.bundles = bundles.filter((name) => name !== BUNDLE)
} else if (!has) {
  bundles.push(BUNDLE)
  manifest.dsh.profile.bundles = bundles
}
const temp = `${manifestPath}.${process.pid}.tmp`
writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8' })
renameSync(temp, manifestPath)
console.log(`${disable ? 'removed' : 'ensured'} "${BUNDLE}" in ${manifestPath} bundles`)
console.log(manifest.dsh.profile.bundles.join(', '))
