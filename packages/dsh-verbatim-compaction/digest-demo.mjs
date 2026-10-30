import { readFileSync } from 'node:fs'
import { digestSource, buildSections, renderDigest } from './lib/index.js'
const raw = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const events = raw.filter(e => e.type !== 'session')
const session = { snapshotEvents: () => events }
const source = digestSource(session, new Set())
console.log('source events:', source.length)
const sections = buildSections(source)
console.log('sections:', sections.length)
const out = renderDigest(source, 196752)
console.log('digest chars:', out.length)
console.log(out.slice(0, 1600))
