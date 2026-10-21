import { readFileSync } from 'node:fs'

const files = ['Panel.tsx', 'TerminalView.tsx', 'index.tsx']
const used = new Set()
for (const f of files) {
  const s = readFileSync(`client-src/${f}`, 'utf8')
  for (const m of s.matchAll(/\bt\(\s*['"]([A-Za-z0-9_.-]+)['"]/g)) used.add(m[1])
}
const loc = readFileSync('client-src/locale.ts', 'utf8')
const zhBlock = loc.match(/export const zh: LocaleTable = \{([\s\S]*?)\n\}/)[1]
const defined = new Set([...zhBlock.matchAll(/^\s*['"]?([A-Za-z0-9_.-]+)['"]?:/gm)].map((m) => m[1]))
const missing = [...used].filter((k) => !defined.has(k)).sort()
const unused = [...defined].filter((k) => !used.has(k)).sort()
console.log('used', used.size, 'defined', defined.size)
console.log('MISSING:', missing.join(', ') || '(none)')
console.log('UNUSED:', unused.join(', ') || '(none)')

const panel = readFileSync('client-src/Panel.tsx', 'utf8')
const styles = readFileSync('client-src/styles.ts', 'utf8')
const classes = [...new Set([...panel.matchAll(/className="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)))].filter((c) => c.startsWith('dshtp'))
const missingStyles = classes.filter((c) => !styles.includes(`.${c}`))
console.log('classes used', classes.length)
console.log('MISSING STYLES:', missingStyles.join(', ') || '(none)')
const styled = [...new Set([...styles.matchAll(/\.(dshtp-[A-Za-z0-9_-]+)/g)].map((m) => m[1]))]
console.log('styled classes', styled.length)
const unusedStyles = styled.filter((c) => !panel.includes(c) && !readFileSync('client-src/TerminalView.tsx', 'utf8').includes(c) && !readFileSync('client-src/index.tsx', 'utf8').includes(c))
console.log('STYLED BUT NOT USED:', unusedStyles.join(', ') || '(none)')
