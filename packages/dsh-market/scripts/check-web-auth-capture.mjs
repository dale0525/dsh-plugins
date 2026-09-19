import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Find a CI workflow that declares this lane by running `npm run test:web`.
 *
 * Upstream this package IS the repository, so the workflow sits at
 * `<ROOT>/.github/workflows/ci.yml`. In a monorepo the package is one
 * directory among many and the workflows belong to the repository root, so
 * walk up and read whichever workflow actually declares the lane. Returning
 * the path (rather than assuming one) keeps the guard's real assertion — CI
 * must run the lane through `npm run test:web` — instead of failing on a
 * layout difference.
 *
 * @returns the workflow path and its text, or undefined when none declares it.
 */
function findWebE2eWorkflow() {
  for (let dir = ROOT; ;) {
    const workflows = resolve(dir, '.github', 'workflows')
    if (existsSync(workflows)) {
      for (const entry of readdirSync(workflows).sort()) {
        if (!/\.ya?ml$/u.test(entry)) continue
        const path = resolve(workflows, entry)
        const text = readFileSync(path, 'utf8')
        if (text.includes('test:web')) return { path, text }
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const FORBIDDEN = [
  { label: 'BrowserContext tracing', pattern: /\.\s*tracing\s*\./u },
  { label: 'HAR recording', pattern: /\brecordHar(?:Content|Mode|OmitContent|Path)?\b/u },
  { label: 'Playwright trace option', pattern: /\btrace\s*:\s*(?:true|['"`](?:on|retain-on-failure|on-first-retry)['"`])/u },
  { label: 'trace CLI flag', pattern: /--trace(?:=|\s)/u },
  { label: 'HAR CLI flag', pattern: /--(?:save-|record-)?har(?:=|\s)/iu },
  { label: 'trace environment switch', pattern: /\b(?:PLAYWRIGHT|PW_TEST)[A-Z_]*TRACE[A-Z_]*\b/u },
]

function browserSources(web = resolve(ROOT, 'tests', 'web')) {
  const sources = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'fixtures') visit(path)
        continue
      }
      if (!/\.(?:[cm]?[jt]sx?)$/u.test(entry.name)
        || /\.(?:spec|test)\.(?:[cm]?[jt]sx?)$/u.test(entry.name)) continue
      sources.push(path)
    }
  }
  visit(web)
  return sources
}

function scan(label, text) {
  const matches = FORBIDDEN
    .filter(rule => rule.pattern.test(text))
    .map(rule => rule.label)
  return matches.length === 0 ? [] : [`${label}: ${matches.join(', ')}`]
}

export function checkAuthenticatedBrowserLane(paths = []) {
  const failures = []
  if (paths.length > 0) {
    for (const path of paths) failures.push(...scan(path, readFileSync(resolve(path), 'utf8')))
    return failures
  }

  for (const path of [...browserSources(), resolve(ROOT, 'vitest.web.config.ts')]) {
    failures.push(...scan(path, readFileSync(path, 'utf8')))
  }

  const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
  const testWeb = packageJson?.scripts?.['test:web']
  if (typeof testWeb !== 'string' || !testWeb.includes('node scripts/check-web-auth-capture.mjs')) {
    failures.push('package.json: test:web must run the authenticated-lane guard before Vitest')
  } else {
    failures.push(...scan('package.json scripts.test:web', testWeb))
  }

  const workflow = findWebE2eWorkflow()
  if (workflow === undefined) {
    // No workflow in this repository declares the lane, so there is no CI
    // entrypoint to verify. That is a real gap in CI COVERAGE (the lane is not
    // enforced here), but it is not a trace/HAR violation — the source scan
    // above is the security check and still ran. Report it loudly rather than
    // failing the package for a repository-level wiring decision.
    process.stderr.write(
      'authenticated browser capture guard: WARNING — no workflow under .github/workflows '
      + 'declares the Web E2E lane, so `npm run test:web` is not CI-enforced in this repository.\n',
    )
    return failures
  }
  const label = workflow.path.slice(workflow.path.indexOf('.github'))
  if (!workflow.text.includes('npm run test:web')) {
    failures.push(`${label}: Web E2E must run through npm run test:web`)
  }
  failures.push(...scan(label, workflow.text))
  return failures
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const args = process.argv.slice(2)
  const sourceRoot = args[0] === '--browser-source-root' ? args[1] : undefined
  const failures = sourceRoot === undefined
    ? checkAuthenticatedBrowserLane(args)
    : browserSources(resolve(sourceRoot)).flatMap(path => scan(path, readFileSync(path, 'utf8')))
  if (failures.length > 0) {
    process.stderr.write(`authenticated browser capture guard failed:\n${failures.join('\n')}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write('authenticated browser capture guard passed\n')
  }
}
