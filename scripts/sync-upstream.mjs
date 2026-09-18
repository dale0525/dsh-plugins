#!/usr/bin/env node
/**
 * sync-upstream.mjs — 把上游 dsh-config-manager 的新版本合进本仓库的 fork。
 *
 * 上游仓库：见 sync-policy.json 的 upstream.url；本 fork 位于 upstream.prefix
 * （git subtree，保留上游历史）。
 *
 * ## 顺序铁律（实测：顺序反了会让我们的改造被上游覆盖）
 *
 *   1. git subtree pull --prefix=<prefix> <upstream> <ref>    # 会产生冲突
 *   2. git checkout --theirs -- <prefix>                      # 先全取上游
 *   3. git checkout --ours  -- <owned 文件>                    # 再恢复我方改造
 *   4. git rm -f --ignore-unmatch <deleted 文件>               # 重删我方删除
 *   5. git commit
 *
 * 第 2 步是「全取上游」的关键：`git checkout --theirs -- <dir>` 把整棵子树恢复成上游版本；
 * 随后第 3 步只把 policy.owned 里的文件恢复成我方版本。若把 2/3 调换，上游会覆盖我们的改造。
 *
 * ## 用法
 *
 *   node scripts/sync-upstream.mjs --dry-run            # 只打印计划（零写入）
 *   node scripts/sync-upstream.mjs --ref v0.1.61        # 指定上游 ref（缺省 = 最新 tag）
 *   node scripts/sync-upstream.mjs                      # 真实执行（在临时分支上）
 *
 * ## 退出码
 *   0 成功；1 参数/环境错误；2 冲突未按 policy 归零；3 git 命令失败
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const POLICY_PATH = join(REPO_ROOT, 'sync-policy.json')

const argv = process.argv.slice(2)
const DRY_RUN = argv.includes('--dry-run')
const refIndex = argv.indexOf('--ref')
const REF = refIndex >= 0 ? argv[refIndex + 1] : undefined

/** 在 REPO_ROOT 跑 git；失败即抛（调用方决定退出码）。 */
function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: opts.stdio ?? 'pipe' })
}

/** 打印一行并立即冲刷（CI 日志实时可见）。 */
function log(line) {
  process.stdout.write(line + '\n')
}

function fail(code, message) {
  process.stderr.write('[sync-upstream] ERROR ' + message + '\n')
  process.exit(code)
}

/* ---------------------------------------------------------------- policy */

if (!existsSync(POLICY_PATH)) fail(1, 'sync-policy.json not found at ' + POLICY_PATH)
let policy
try {
  policy = JSON.parse(readFileSync(POLICY_PATH, 'utf8'))
} catch (err) {
  fail(1, 'sync-policy.json is not valid JSON: ' + err.message)
}

const upstream = policy.upstream ?? {}
const PREFIX = upstream.prefix
const URL = upstream.url
const OWNED = Array.isArray(policy.owned) ? policy.owned : []
const DELETED = Array.isArray(policy.deleted) ? policy.deleted : []
if (typeof PREFIX !== 'string' || PREFIX === '') fail(1, 'sync-policy.json: upstream.prefix must be a non-empty string')
if (typeof URL !== 'string' || URL === '') fail(1, 'sync-policy.json: upstream.url must be a non-empty string')

/** 把 policy 里的仓库相对路径拼成仓库内完整路径。 */
const full = (rel) => PREFIX + '/' + rel

/* ---------------------------------------------------------------- preflight */

/** 工作区必须干净：同步过程会 checkout / rm，脏工作区会把用户改动卷进来。 */
function assertCleanWorktree() {
  const dirty = git(['status', '--porcelain']).trim()
  if (dirty !== '') {
    fail(1, 'working tree is dirty; commit or stash first:\n' + dirty)
  }
}

/** 语义化版本排序键：v0.1.9 → [0,1,9]（非数字段按 0 处理，保证比较器全序）。 */
function versionKey(tag) {
  return tag.replace(/^v/, '').split('.').map((part) => {
    const n = Number(part)
    return Number.isFinite(n) ? n : 0
  })
}

/** 解析要同步的上游 ref：显式 --ref 优先，否则取上游最新 tag。 */
function resolveRef() {
  if (REF !== undefined) return REF
  // 关键：剥掉 peeled 引用（`refs/tags/vX^{}`）——它们是同一个 tag 的注解对象指针，
  // 不剥掉会得到重复项，且 `vX^{}` 的数字段含 `^{}` 会解析成 NaN，
  // 使比较器失去全序性（实测会把 v0.1.9 当成「最新」）。
  const tags = git(['ls-remote', '--tags', URL])
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[1] ?? '')
    .filter((t) => t.startsWith('refs/tags/v') && !t.endsWith('^{}'))
    .map((t) => t.replace('refs/tags/', ''))
  if (tags.length === 0) fail(3, 'no v* tags found at ' + URL)
  tags.sort((a, b) => {
    const pa = versionKey(a)
    const pb = versionKey(b)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0)
      if (d !== 0) return d
    }
    return 0
  })
  return tags[tags.length - 1]
}

/* ---------------------------------------------------------------- plan */

log('[sync-upstream] prefix   : ' + PREFIX)
log('[sync-upstream] upstream : ' + URL)
log('[sync-upstream] baseline : ' + (upstream.baseline ?? '(unset)'))
log('[sync-upstream] owned    : ' + OWNED.length + ' file(s)')
log('[sync-upstream] deleted  : ' + DELETED.length + ' file(s)')

const targetRef = resolveRef()
log('[sync-upstream] target   : ' + targetRef)

if (DRY_RUN) {
  log('')
  log('[sync-upstream] --dry-run：以下是将执行的步骤（零写入）')
  log('  1. git subtree pull --prefix=' + PREFIX + ' ' + URL + ' ' + targetRef)
  log('  2. git checkout --theirs -- ' + PREFIX)
  log('  3. git checkout --ours -- <' + OWNED.length + ' owned 文件>')
  log('  4. git rm -f --ignore-unmatch <' + DELETED.length + ' deleted 文件>')
  log('  5. git commit')
  log('')
  log('[sync-upstream] owned 清单：')
  for (const f of OWNED) log('  - ' + f)
  log('[sync-upstream] deleted 清单（前 20 条）：')
  for (const f of DELETED.slice(0, 20)) log('  - ' + f)
  if (DELETED.length > 20) log('  … 其余 ' + (DELETED.length - 20) + ' 条')
  process.exit(0)
}

/* ---------------------------------------------------------------- apply */

assertCleanWorktree()

/**
 * 冲突文件分两类打印，让人一眼看出要审什么：
 *  - B 类机械：policy.deleted 里的文件（上游改了我们删掉的，重删即可）
 *  - A 类真冲突：其余（上游与我们同时改了，需人工裁定）
 */
function classifyConflicts(paths) {
  const deletedSet = new Set(DELETED.map(full))
  const real = []
  const mechanical = []
  for (const f of paths) {
    if (deletedSet.has(f)) mechanical.push(f)
    else real.push(f)
  }
  return { real, mechanical }
}

/**
 * 工作区里仍带冲突标记的文件。
 *
 * 为什么不能只看 `git diff --diff-filter=U`：`git checkout --ours/--theirs` 只改工作区内容，
 * **索引仍处于 unmerged 状态**，直到 `git add` 才收敛。所以「按 policy 归零」的判据必须是
 * 「工作区无冲突标记」+（add 之后）「索引无 unmerged 条目」，而不是 checkout 之后的 diff 状态。
 */
function filesWithConflictMarkers() {
  try {
    const out = git(['grep', '-l', '-E', '^(<<<<<<<|>>>>>>>)', '--', PREFIX])
    return out.trim() === '' ? [] : out.trim().split('\n')
  } catch (err) {
    // git grep 无命中时退出码为 1（不是错误）——那正是我们想要的「零冲突」。
    if (err !== null && typeof err === 'object' && err.status === 1) return []
    throw err
  }
}

const branch = 'sync-upstream/' + targetRef + '-' + Date.now()
log('[sync-upstream] 创建临时分支 ' + branch)
git(['checkout', '-b', branch])

try {
  log('[sync-upstream] 1/4 subtree pull ...')
  // 无冲突也**必须**继续走 2/3/4：git 的自动合并不会重删我们删过的文件，
  // 也不会恢复被上游覆盖的我方改造。提前 return 会让 policy 整段失效。
  let pulled = true
  try {
    git(['subtree', 'pull', '--prefix=' + PREFIX, URL, targetRef], { stdio: 'inherit' })
    log('[sync-upstream] subtree pull 无冲突完成（仍需应用 policy：重删 + 恢复我方改造）')
  } catch {
    pulled = false
    log('[sync-upstream] subtree pull 产生冲突，按 policy 归零 ...')
  }
  if (!pulled) log('[sync-upstream] （冲突已记录，下方 policy 步骤会统一收敛）')

  log('[sync-upstream] 2/4 全取上游：git checkout --theirs -- ' + PREFIX)
  git(['checkout', '--theirs', '--', PREFIX])

  log('[sync-upstream] 3/4 恢复我方改造：' + OWNED.length + ' 个 owned 文件')
  if (OWNED.length > 0) git(['checkout', '--ours', '--', ...OWNED.map(full)])

  log('[sync-upstream] 4/4 重删我方删除：' + DELETED.length + ' 个文件')
  if (DELETED.length > 0) git(['rm', '-f', '--ignore-unmatch', '--', ...DELETED.map(full)])

  // 归零判据（见 filesWithConflictMarkers 注释）：checkout 只改工作区，索引要 git add 才收敛。
  const conflicted = filesWithConflictMarkers()
  if (conflicted.length > 0) {
    const { real, mechanical } = classifyConflicts(conflicted)
    process.stderr.write('[sync-upstream] A 类真冲突（需人工裁定）：\n')
    for (const f of real) process.stderr.write('  - ' + f + '\n')
    process.stderr.write('[sync-upstream] B 类机械重删：\n')
    for (const f of mechanical) process.stderr.write('  - ' + f + '\n')
    fail(2, conflicted.length + ' file(s) still carry conflict markers after applying the policy')
  }

  git(['add', '-A'])
  const unmerged = git(['ls-files', '-u']).trim()
  if (unmerged !== '') {
    fail(2, 'index still has unmerged entries after git add:\n' + unmerged)
  }
  git(['commit', '-m', 'chore: sync upstream ' + targetRef + '\n\n按 sync-policy.json 应用 owned/deleted 清单（theirs → ours → 重删）。'], { stdio: 'inherit' })
  log('[sync-upstream] 完成。当前分支：' + branch)
  log('[sync-upstream] 下一步：推送该分支并开 PR（workflow 只开 PR，绝不直接推 main）。')
} catch (err) {
  process.stderr.write('[sync-upstream] git 命令失败：' + (err instanceof Error ? err.message : String(err)) + '\n')
  process.stderr.write('[sync-upstream] 当前在分支 ' + branch + '；处理完冲突后手动 commit，或 git checkout - 放弃。\n')
  process.exit(3)
}
