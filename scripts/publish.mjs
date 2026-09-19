#!/usr/bin/env node
/**
 * Publish plan resolver for the dsh-plugins monorepo.
 *
 * The aggregate package depends on its child plugins, so a child MUST be on the
 * registry before the aggregate that names it -- otherwise installing the
 * aggregate fails to resolve its dependency. The order is therefore derived
 * from the packages' own dependencies edges (topological sort), never from a
 * hardcoded package list: adding a child plugin or a second aggregate needs no
 * change here.
 *
 * Usage:
 *   node scripts/publish.mjs              # print plan: dir<TAB>name<TAB>version per line
 *   node scripts/publish.mjs --json       # machine-readable plan
 *
 * Deliberately does NOT publish: the workflow runs `npm publish` per entry so
 * OIDC trusted publishing and per-package failure handling stay in CI.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolvePath(SCRIPT_DIR, '..')

/** Every publishable workspace package: packages/<dir>/package.json, skipping private ones. */
export function readPackages(root = REPO_ROOT) {
  const base = join(root, 'packages')
  if (!existsSync(base)) return []
  const out = []
  for (const dir of readdirSync(base).sort()) {
    const abs = join(base, dir)
    let isDir = false
    try { isDir = statSync(abs).isDirectory() } catch { isDir = false }
    if (!isDir) continue
    const manifestPath = join(abs, 'package.json')
    if (!existsSync(manifestPath)) continue
    let pkg
    try {
      pkg = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      throw new Error(manifestPath + ': invalid JSON (' + error.message + ')')
    }
    if (pkg.private === true) continue
    if (typeof pkg.name !== 'string' || pkg.name === '') {
      throw new Error(manifestPath + ': missing "name"')
    }
    if (typeof pkg.version !== 'string' || pkg.version === '') {
      throw new Error(manifestPath + ': missing "version"')
    }
    out.push({ dir: abs, name: pkg.name, version: pkg.version, dependencies: pkg.dependencies ?? {} })
  }
  return out
}

/**
 * Topologically sort packages so every dependency is published before its
 * dependent. Ties (no relationship) break on name so the plan is deterministic
 * across machines and runs.
 */
export function resolvePublishPlan(root = REPO_ROOT) {
  const packages = readPackages(root)
  const byName = new Map(packages.map((p) => [p.name, p]))
  const emitted = new Set()
  const plan = []

  const visit = (pkg, chain) => {
    if (emitted.has(pkg.name)) return
    if (chain.includes(pkg.name)) {
      throw new Error('circular dependency among workspace packages: ' + [...chain, pkg.name].join(' -> '))
    }
    const nextChain = [...chain, pkg.name]
    // Only workspace-internal dependencies constrain the order.
    const internal = Object.keys(pkg.dependencies).filter((dep) => byName.has(dep)).sort()
    for (const dep of internal) visit(byName.get(dep), nextChain)
    emitted.add(pkg.name)
    plan.push({ dir: pkg.dir, name: pkg.name, version: pkg.version })
  }

  for (const pkg of [...packages].sort((a, b) => a.name.localeCompare(b.name))) visit(pkg, [])
  return plan
}

function main(argv) {
  let plan
  try {
    plan = resolvePublishPlan()
  } catch (error) {
    console.error('[publish] ERROR ' + error.message)
    process.exit(1)
  }
  if (plan.length === 0) {
    console.error('[publish] ERROR no publishable packages found under packages/')
    process.exit(1)
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(plan, null, 2))
    return
  }
  for (const entry of plan) console.log(entry.dir + '\t' + entry.name + '\t' + entry.version)
}

if (process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2))
}
