// Test-time TypeScript loader: full transform, not strip-only.
//
// Node 26 removed --experimental-transform-types (present through Node 24), so
// the test runner can no longer get full-transform semantics from a flag — and
// type stripping alone rejects parameter properties, which src/host/*.ts uses.
// A load hook backed by tsc's transpileModule keeps one test command working on
// both Node 24 (CI) and Node 26 (local), with no new dependency.
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context)
    const file = fileURLToPath(url)
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true,
      },
    })
    return { format: 'module', source: outputText, shortCircuit: true }
  },
})
