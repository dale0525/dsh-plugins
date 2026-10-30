import { readFileSync } from 'node:fs'
import { digestSource, buildSections, renderDigest } from './lib/index.js'
const raw = readFileSync('/tmp/big.jsonl','utf8').split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.type!=='session')
const session = { snapshotEvents: () => raw }
const source = digestSource(session, new Set())
const sections = buildSections(source)
let userChars=0, asstChars=0, asstTurns=0
for (const s of sections) for (const t of s.turns) {
  userChars += t.user.join('').length
  const a = t.assistant.join('')
  asstChars += a.length
  if (a.length>0) asstTurns++
}
console.log('sections:', sections.length)
console.log('user 字符:', userChars)
console.log('assistant 字符:', asstChars, '| 有正文的 turn:', asstTurns)
const out = renderDigest(source, 196752)
console.log('digest 字符:', out.length)
