import { cp, mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const libDir = join(root, 'lib')

await rm(libDir, { recursive: true, force: true })
await mkdir(libDir, { recursive: true })

execFileSync(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc')], {
  cwd: root,
  stdio: 'inherit',
})

console.log(`[dsh-reasoning-strip] built: ${libDir}`)
