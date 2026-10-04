#!/usr/bin/env node
// 上游同步的**只读**工具。
//
// 同步本身是手工的：`git subtree pull` + 逐处裁定冲突，配方见 AGENTS.md §🔀 上游同步。
// 本脚本不 pull、不 checkout、不 rm、不 commit —— 它只回答三个问题（--preflight 会**打印** git rm 命令供人执行，自己不执行）：
//
//   --list            每个 fork 的上游是谁、上游最新到哪、我们现在是什么状态
//   --changed <id>    上游从**真正的同步点**到最新 tag 之间改了什么
//   --preflight <id>  预演这次同步会撞哪些冲突，并按「机械可裁定 / 需人工」分好类
//
// 「真正的同步点」是 merge-base(HEAD, 上游 tag)，不是 subtree trailer。手工同步的合并提交
// 不带 `git-subtree-split:` trailer（trailer 只存在于收养提交里），拿它当同步点会把**收养点**
// 当成上次同步点，于是 --changed 把已经合并进来的全部历史再报一遍。
//
// 预演用 `git merge-tree -X subtree=<prefix>` 复现 `git subtree pull` 的三方合并。实测：
// bre v0.5.0→v0.5.2 的真 pull 撞 4 处冲突，预演同样报那 4 处（不带 -X subtree 会多报 3 处假冲突）。
// merge-tree 只往对象库写不可达的树/块对象，不动 refs、索引与工作区。
//
// 为什么不再自动应用 owned / deleted / added：那套清单把「可三方合并」压成「整文件二选一」，
// 上游与我们改在同一文件的不同区域时会被静默覆盖。手工 `subtree pull` 让 git 自己三方合并：
// 改在不同区域的自动合并，改在同一区域的留下可见冲突。预演只**报告**，不代为裁定。

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

/** 浅克隆里没有共同祖先不是「基线坏了」，而是历史根本没拉下来 —— 两者的修法不同。 */
export function isShallowClone() {
  return git(['rev-parse', '--is-shallow-repository'], { allowFail: true }).trim() === 'true'
}

/** 同 git()，但**失败时也把 stdout/stderr 交回来**。`merge-tree` 用退出码 1 表示「有冲突」，
 *  冲突清单就在 stdout 里 —— 用 git() 的 allowFail 会把它丢成空串。 */
export function gitCapture(args, options = {}) {
  const { cwd = REPO_ROOT } = options
  try {
    const stdout = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
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

/** 该 fork 的 fetch 落点。**绝不复用上游 tag 名**：直接 `git fetch <url> tag v1.2.3` 会去改写
 *  本地同名 ref，而本仓的发布 tag 也叫 v0.5.2，撞车即 `! [rejected] would clobber existing tag`。 */
export function syncRef(id) {
  return 'refs/dsh-sync/' + id
}

/** 读上游 tag 列表。读不到时把 git 的**原话**带回去，不要把「不可达」误报成「没有版本 tag」。 */
function latestTag(target) {
  const out = gitCapture(['ls-remote', '--tags', '--refs', target.url])
  if (out.code !== 0) {
    const detail = (out.stderr + out.stdout).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('error:') || l.startsWith('fatal:'))
    return { tag: null, error: detail[0] ?? ('git ls-remote 退出码 ' + out.code) }
  }
  return { tag: pickLatestTag(out.stdout.split('\n')), error: null }
}

/** 把上游 tag 取到本仓自己的 ref 命名空间。取不到时把 git 的**原话**带回去 —— */
/** 实测踩过：refs/dsh-sync/<id> 已被同名子 ref 占住时 fetch 会失败，报「离线」是误诊。 */
function fetchTag(target, tag) {
  const ref = syncRef(target.id)
  const out = gitCapture(['fetch', '--no-tags', '--force', target.url, '+refs/tags/' + tag + ':' + ref])
  if (out.code !== 0) {
    const detail = (out.stderr + out.stdout).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('error:') || l.startsWith('fatal:'))
    return { sha: null, error: detail[0] ?? ('git fetch 退出码 ' + out.code) }
  }
  return { sha: git(['rev-parse', ref]).trim(), error: null }
}

/** 状态由 merge-base(HEAD, 上游 tag) 判定，不用 subtree trailer（见文件头）。
 *  current = tag 已是 HEAD 的祖先；behind = 有共同祖先但 tag 还没并进来；
 *  blocked = 连共同祖先都没有，`git subtree pull` 会以 unrelated histories 直接拒绝。 */
export function resolveState(target) {
  const listed = latestTag(target)
  if (listed.tag === null) {
    return { state: listed.error === null ? 'no-tag' : 'unreachable', tag: null, sha: null, base: null, error: listed.error }
  }
  const tag = listed.tag
  const fetched = fetchTag(target, tag)
  if (fetched.sha === null) return { state: 'unreachable', tag, sha: null, base: null, error: fetched.error }
  const sha = fetched.sha
  const base = git(['merge-base', 'HEAD', sha], { allowFail: true }).trim()
  if (base === '') return { state: 'blocked', tag, sha, base: null }
  if (base === sha) return { state: 'current', tag, sha, base }
  return { state: 'behind', tag, sha, base }
}

/** 冲突消息里 sha 后可能紧跟句号（`... but deleted in <sha>.`），去掉它再比较。 */
function trimSha(value) {
  return value.replace(/\.$/, '')
}

/** merge-tree `--name-only` 的输出：首行是结果树，随后是冲突路径，空行之后是消息。
 *  只从**消息**里取冲突（消息带类型）；路径清单会多报 git 认为「可能该移动」的文件。 */
export function parseMergeTree(output) {
  const lines = String(output).split('\n')
  const blank = lines.findIndex((line, i) => i > 0 && line.trim() === '')
  const messages = blank < 0 ? [] : lines.slice(blank + 1)
  const conflicts = []
  for (const line of messages) {
    const head = /^CONFLICT \(([^)]+)\): (.*)$/.exec(line)
    if (head === null) continue
    const kind = head[1]
    const rest = head[2]
    const md = /^(.*) deleted in (\S+) and modified in (\S+)/.exec(rest)
    if (md !== null) { conflicts.push({ kind, path: md[1], deletedBy: trimSha(md[2]) }); continue }
    const rd = /^(.*) renamed to (.*) in (\S+), but deleted in (\S+)/.exec(rest)
    if (rd !== null) { conflicts.push({ kind, path: rd[2], deletedBy: trimSha(rd[4]) }); continue }
    const content = /^Merge conflict in (.*)$/.exec(rest)
    if (content !== null) { conflicts.push({ kind, path: content[1], deletedBy: null }); continue }
    conflicts.push({ kind, path: rest, deletedBy: null })
  }
  return conflicts
}

/** 我方**故意**删掉的文件（构建产物、锁文件）在上游继续改它时，会以 modify/delete 或
 *  rename/delete 出现：裁定就是维持删除（git rm）。其余（content 冲突、上游删的文件）要人看。 */
export function classifyConflicts(conflicts, ourSha) {
  // 同一路径可能同时以 modify/delete 与 rename/delete 出现（上游改名后我们又删了目标名）。
  // 按路径去重，机械判定优先 —— 否则会把同一处冲突报两遍，还把它算进「需人工」。
  const byPath = new Map()
  for (const c of conflicts) {
    const ourDeletion = c.deletedBy === ourSha && (c.kind === 'modify/delete' || c.kind === 'rename/delete')
    const prev = byPath.get(c.path)
    if (prev === undefined || (ourDeletion && !prev.ourDeletion)) byPath.set(c.path, { ...c, ourDeletion })
  }
  const mechanical = []
  const judgment = []
  for (const c of byPath.values()) (c.ourDeletion ? mechanical : judgment).push(c)
  return { mechanical, judgment }
}

/** 用 merge-tree 复现 `git subtree pull` 的三方合并，只报告不落地。 */
export function predictConflicts(target, base, sha, ourSha) {
  const out = gitCapture(['merge-tree', '--write-tree', '--name-only', '-X', 'subtree=' + target.prefix, '--merge-base=' + base, ourSha, sha])
  if (out.code === 0) return { conflicts: [], error: null }
  if (out.code === 1) return { conflicts: parseMergeTree(out.stdout), error: null }
  const fatal = /^fatal: (.*)$/m.exec(out.stdout + out.stderr)
  return { conflicts: [], error: fatal === null ? 'merge-tree 退出码 ' + out.code : fatal[1] }
}

const USAGE = [
  '用法：',
  '  node scripts/sync-upstream.mjs --list',
  '  node scripts/sync-upstream.mjs --changed <id>',
  '  node scripts/sync-upstream.mjs --preflight <id>',
  '',
  '--list            每个 fork 的上游身份、上游最新 tag、我们相对它的状态',
  '--changed <id>    上游从真正的同步点到最新 tag 的改动（fetch 到 refs/dsh-sync/*，不动工作区）',
  '--preflight <id>  预演这次同步会撞哪些冲突，并分成「机械可裁定 / 需人工裁定」',
  '',
  '本脚本是只读的：不 pull、不 checkout、不 rm、不 commit。同步手工做，配方见 AGENTS.md §🔀 上游同步。',
].join('\n')

function describeState(state) {
  if (state.state === 'no-tag') return '上游没有版本 tag'
  if (state.state === 'unreachable') return '读不到上游：' + state.error
  if (state.state === 'blocked') return isShallowClone() ? '读不到共同祖先：浅克隆，先 git fetch --unshallow' : '阻塞：与上游无共同祖先，subtree pull 会拒绝'
  if (state.state === 'current') return '已同步到 ' + state.tag
  return '落后：共同祖先 ' + state.base.slice(0, 12) + '，待并入 ' + state.tag
}

function showList(targets, log) {
  if (targets.length === 0) {
    log('没有发现任何 fork（packages/*/' + POLICY_FILE + ' 一个都没有）')
    return 0
  }
  for (const target of targets) {
    const state = resolveState(target)
    log(target.id + '  ' + target.prefix)
    log('  上游      ' + target.url)
    log('  上游最新  ' + (state.tag === null ? '（未知）' : state.tag))
    log('  状态      ' + describeState(state))
    log('')
  }
  log('要看改动：  node scripts/sync-upstream.mjs --changed <id>')
  log('要预演冲突：node scripts/sync-upstream.mjs --preflight <id>')
  return 0
}

function showChanged(target, log) {
  const state = resolveState(target)
  if (state.state === 'no-tag') bail(target.id + ' 的上游没有版本 tag')
  if (state.state === 'unreachable') bail(target.id + ' 的上游读不到：' + state.error)
  if (state.state === 'blocked') {
    bail(target.id + (isShallowClone()
      ? ' 的仓库是浅克隆，读不到共同祖先，无法计算改动（先 git fetch --unshallow）'
      : ' 与上游没有共同祖先，无法计算改动（先修 subtree 基线）'))
  }
  if (state.state === 'current') {
    log(target.id + ' 已同步到 ' + state.tag + '（无改动）')
    return 0
  }
  const stat = git(['diff', '--stat', state.base, state.sha], { allowFail: true })
  if (stat.trim() === '') {
    log(target.id + ' 已同步到 ' + state.tag + '（无改动）')
    return 0
  }
  log(target.id + '  ' + state.base.slice(0, 12) + ' -> ' + state.tag)
  log('')
  log(stat.trimEnd())
  return 0
}

function showPreflight(target, log) {
  const state = resolveState(target)
  log(target.id + '  ' + target.prefix)
  log('  上游      ' + target.url)
  if (state.state === 'no-tag' || state.state === 'unreachable') {
    log('  状态      ' + describeState(state) + '，无法预检')
    return 0
  }
  log('  上游最新  ' + state.tag + '  (' + state.sha.slice(0, 12) + ')')
  if (state.state === 'blocked') {
    if (isShallowClone()) {
      log('  状态      读不到共同祖先：这是浅克隆，上游历史不在本地')
      log('            不是基线坏了 —— 先 `git fetch --unshallow` 再预检。')
      return 0
    }
    log('  状态      阻塞：上游历史与本地不连通')
    log('            本地与 ' + state.sha.slice(0, 12) + ' 没有共同祖先，`git subtree pull` 会直接以')
    log('            `fatal: refusing to merge unrelated histories` 失败 —— 先修基线，再谈同步。')
    return 0
  }
  if (state.state === 'current') {
    log('  状态      已同步（' + state.tag + ' 已在本地历史里），无需动作')
    return 0
  }
  log('  状态      落后：共同祖先 ' + state.base.slice(0, 12))
  const ourSha = git(['rev-parse', 'HEAD']).trim()
  const predicted = predictConflicts(target, state.base, state.sha, ourSha)
  if (predicted.error !== null) {
    log('  预检      失败：' + predicted.error)
    return 0
  }
  if (predicted.conflicts.length === 0) {
    log('  冲突      无（`git subtree pull` 会干净自动合并）')
    return 0
  }
  const split = classifyConflicts(predicted.conflicts, ourSha)
  log('  冲突      ' + (split.mechanical.length + split.judgment.length) + ' 处（预演三方合并，未动工作区）')
  log('')
  if (split.mechanical.length > 0) {
    log('  ── 机械可裁定（' + split.mechanical.length + '）：我方已故意删除，维持删除即可')
    for (const c of split.mechanical) log('     git rm ' + c.path)
    log('')
  }
  log('  ── 需人工裁定（' + split.judgment.length + '）')
  for (const c of split.judgment) log('     [' + c.kind + '] ' + c.path)
  log('')
  log('  预检到此为止：不改工作区、不替你裁定。真同步仍是 `git subtree pull` + 逐处裁定（AGENTS.md §🔀 上游同步）。')
  return 0
}

export function runCli(argv, options = {}) {
  const { log = console.log } = options
  if (argv.includes('--help') || argv.includes('-h')) { log(USAGE); return 0 }
  const targets = discoverTargets()
  for (const [flag, handler] of [['--changed', showChanged], ['--preflight', showPreflight]]) {
    const i = argv.indexOf(flag)
    if (i < 0) continue
    const id = argv[i + 1]
    if (id === undefined || id.startsWith('--')) bail(flag + ' 需要一个 target id')
    const target = targets.find((t) => t.id === id)
    if (target === undefined) bail('未知 target：' + id + '（可选：' + targets.map((t) => t.id).join(', ') + '）')
    return handler(target, log)
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
