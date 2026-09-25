#!/usr/bin/env node
// 上游同步的**只读**工具。
//
// 同步本身是手工的：`git subtree pull` + 逐处裁定冲突，配方见 AGENTS.md §🔀 上游同步。
// 本脚本不 pull、不 checkout、不 rm、不 commit —— 它只回答两个问题：
//
//   --list            每个 fork 的上游是谁、上游最新到哪、我们上次同步到哪
//   --changed <id>    上游从「上次同步点」到最新 tag 之间改了什么
//
// 为什么不再自动应用 owned / deleted / added：那套清单把「可三方合并」压成「整文件二选一」，
// 上游与我们改在同一文件的不同区域时会被静默覆盖。手工 `subtree pull` 让 git 自己三方合并：
// 改在不同区域的自动合并，改在同一区域的留下可见冲突。

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')
const POLICY_FILE = 'upstream.json'

function bail(message) {
  throw new Error(message)
}

export function git(args, options = {}) {
  const { allowFail = false, cwd = REPO_ROOT } = options
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (allowFail) return ''
    const detail = String(error.stderr ?? error.message).trim()
    bail('git ' + args.join(' ') + ' 失败：' + detail)
  }
}

/** 解析 semver 三段 + 预发布段；不是版本 tag 时返回 null。 */
function parseTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(tag)
  if (m === null) return null
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] === undefined ? null : m[4].split('.') }
}

export function compareTags(a, b) {
  const pa = parseTag(a)
  const pb = parseTag(b)
  if (pa === null || pb === null) return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch
  if (pa.pre === null && pb.pre === null) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i += 1) {
    const x = pa.pre[i]
    const y = pb.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) { if (+x !== +y) return +x - +y; continue }
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 从 `git ls-remote --tags` 的输出里挑出语义版本最高的 tag 名；无版本 tag 时返回 null。 */
export function pickLatestTag(refLines) {
  const tags = []
  for (const line of refLines) {
    const m = /refs\/tags\/(.+?)(\^\{\})?$/.exec(String(line).trim())
    if (m !== null) tags.push(m[1])
  }
  const versioned = tags.filter((t) => parseTag(t) !== null)
  if (versioned.length === 0) return null
  let best = versioned[0]
  for (const t of versioned) if (compareTags(t, best) > 0) best = t
  return best
}

/** 每个 fork 的 packages/<dir>/upstream.json 只声明它的上游身份。 */
export function discoverTargets(root = REPO_ROOT) {
  const dir = root === REPO_ROOT ? PACKAGES_DIR : join(root, 'packages')
  const targets = []
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, POLICY_FILE)
    let raw
    try { raw = readFileSync(file, 'utf8') } catch { continue }
    let parsed
    try { parsed = JSON.parse(raw) } catch { bail(POLICY_FILE + ' 不是合法 JSON：' + file) }
    for (const key of ['id', 'url', 'prefix']) {
      if (typeof parsed[key] !== 'string' || parsed[key] === '') bail(file + ' 缺 ' + key)
    }
    if (parsed.prefix !== 'packages/' + name) bail(file + ' 的 prefix 与目录不符：' + parsed.prefix)
    targets.push({ id: parsed.id, url: parsed.url, prefix: parsed.prefix, dir: name })
  }
  return targets
}

/** 最近一次 subtree 同步带入的上游 commit（git-subtree-split）；无祖先时 null。 */
export function lastSynced(target) {
  const log = git(['log', '--format=%B%x00', '--grep=git-subtree-dir: ' + target.prefix, '--', target.prefix], { allowFail: true })
  for (const block of log.split('\u0000')) {
    const m = /git-subtree-split:\s*([0-9a-f]{40})/.exec(block)
    if (m !== null) return m[1]
  }
  return null
}

function latestTag(target) {
  const out = git(['ls-remote', '--tags', '--refs', target.url], { allowFail: true })
  if (out.trim() === '') return null
  return pickLatestTag(out.split('\n'))
}

const USAGE = [
  '用法：',
  '  node scripts/sync-upstream.mjs --list',
  '  node scripts/sync-upstream.mjs --changed <id>',
  '',
  '--list            每个 fork 的上游身份、上次同步点、上游最新 tag',
  '--changed <id>    上游从上次同步点到最新 tag 的改动（fetch 到 FETCH_HEAD，不动工作区）',
  '',
  '本脚本是只读的：不 pull、不 checkout、不 rm、不 commit。同步手工做，配方见 AGENTS.md §🔀 上游同步。',
].join('\n')

function showList(targets, log) {
  if (targets.length === 0) {
    log('没有发现任何 fork（packages/*/' + POLICY_FILE + ' 一个都没有）')
    return 0
  }
  for (const target of targets) {
    const split = lastSynced(target)
    const tag = latestTag(target)
    log(target.id + '  ' + target.prefix)
    log('  上游      ' + target.url)
    log('  上次同步  ' + (split === null ? '从未（无 subtree 祖先）' : split.slice(0, 12)))
    log('  上游最新  ' + (tag === null ? '（读不到 tag）' : tag))
    log('')
  }
  log('要看某个目标的具体改动：node scripts/sync-upstream.mjs --changed <id>')
  return 0
}

function showChanged(target, log) {
  const split = lastSynced(target)
  if (split === null) bail(target.id + ' 没有 subtree 祖先，无法计算改动')
  const tag = latestTag(target)
  if (tag === null) bail(target.id + ' 的上游读不到版本 tag')
  git(['fetch', '--no-tags', target.url, 'tag', tag], { allowFail: false })
  const stat = git(['diff', '--stat', split, 'FETCH_HEAD'], { allowFail: true })
  if (stat.trim() === '') {
    log(target.id + ' 已同步到 ' + tag + '（无改动）')
    return 0
  }
  log(target.id + '  ' + split.slice(0, 12) + ' -> ' + tag)
  log('')
  log(stat.trimEnd())
  return 0
}

export function runCli(argv, options = {}) {
  const { log = console.log } = options
  if (argv.includes('--help') || argv.includes('-h')) { log(USAGE); return 0 }
  const targets = discoverTargets()
  const i = argv.indexOf('--changed')
  if (i >= 0) {
    const id = argv[i + 1]
    if (id === undefined || id.startsWith('--')) bail('--changed 需要一个 target id')
    const target = targets.find((t) => t.id === id)
    if (target === undefined) bail('未知 target：' + id + '（可选：' + targets.map((t) => t.id).join(', ') + '）')
    return showChanged(target, log)
  }
  if (argv.length > 0 && !argv.includes('--list')) bail('未知参数：' + argv.join(' ') + '\n\n' + USAGE)
  return showList(targets, log)
}

function main() {
  try {
    process.exitCode = runCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write('error: ' + error.message + '\n')
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
