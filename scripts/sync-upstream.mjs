#!/usr/bin/env node
/**
 * sync-upstream.mjs — 把各上游仓库的新版本合进本仓库对应的 fork 子包。
 *
 * 每个 fork 子包自带一份 `packages/<pkg>/sync-policy.json`，描述它的上游身份
 * （`target`）与我方改造清单（`owned` / `deleted` / `added`）。目标由
 * glob `packages/<pkg>/sync-policy.json` 发现，`id` 取 `target.id`。
 *
 * ## 顺序铁律（实测：顺序反了会让我们的改造被上游覆盖）
 *
 *   1. git subtree pull --prefix=<prefix> <upstream> <ref>    # 会产生冲突
 *   2. git checkout --theirs -- <prefix>                      # 先全取上游
 *   3. git checkout <pull 前的 HEAD> -- <owned 文件>           # 再恢复我方改造
 *   4. git rm -f --ignore-unmatch <deleted 文件>               # 重删我方删除
 *   5. git commit
 *
 * 第 2 步是「全取上游」的关键：`git checkout --theirs -- <dir>` 把整棵子树恢复成上游版本；
 * 随后第 3 步只把 policy.owned 里的文件恢复成我方版本。若把 2/3 调换，上游会覆盖我们的改造。
 * **无冲突时也必须走完 2/3/4**：git 的自动合并不会重删我们删过的文件，也不会恢复被上游
 * 覆盖的我方改造。
 *
 * 第 3 步**不能**写 `git checkout --ours`：`--ours/--theirs` 只对**未合并的索引条目**生效，
 * 而 git 对「双方都改、改在不同区域」的文件会干净三方合并（无冲突标记、无 stage 1/2/3），
 * 此时 `--ours` 是空操作，我方版本被上游静默污染。以 pull **之前**的 HEAD 为唯一真源才对
 * 冲突与非冲突路径一视同仁。实现见 `restoreOwned()`。
 *
 * ## 两个静默故障的显式检查（真实执行时进行，dry-run 不做）
 *
 *   - **`added` 冲突**：`added` 是我方独有文件。若上游本次出现了同名路径，
 *     `--theirs` 会用上游版本覆盖它，而第 3 步只恢复 `owned` —— 我方模块被静默替换。
 *     检出即 fail(2)，交人工裁定（不能静默取任一方）。
 *   - **依赖差异**：各包 `package.json` 在 `owned` 里（要改 name/repository），
 *     因此上游**新增**的运行时依赖不会被我方带入 —— 源码同步成上游版本但依赖缺失，
 *     症状是构建失败或运行时 `Cannot find module`。检出即 fail(2) 并列出要补的键。
 *
 * ## 用法
 *
 *   node scripts/sync-upstream.mjs --list                      # 列出全部 target（零写入）
 *   node scripts/sync-upstream.mjs --dry-run [--target <id>]    # 只打印计划（零写入）
 *   node scripts/sync-upstream.mjs [--target <id>]              # 真实执行（在临时分支上）
 *   node scripts/sync-upstream.mjs --refresh-policy [--target <id>] [--baseline <commit>]
 *   node scripts/sync-upstream.mjs [--target <id>] --ref <tag|branch|commit>
 *
 * 无 `--target` 时对**全部**目标串行执行：每个目标从同一基点各开一条分支，跑完回到原分支。
 * CI 用 matrix 逐目标调用（见 .github/workflows/sync-upstream.yml），不依赖这个全量模式。
 *
 * ## 退出码
 *   0 成功；1 参数/环境错误；2 需人工裁定（冲突未按 policy 归零 / added 冲突 / 上游新增依赖）；3 git 失败
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')

/** 需要人工裁定的失败（与「git 命令炸了」区分开，后者退出码 3）。 */
class SyncError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function fail(code, message) {
  throw new SyncError(code, message)
}

function log(line) {
  process.stdout.write(line + '\n')
}

/** 在 REPO_ROOT（或 opts.cwd）跑 git；失败即抛（调用方决定退出码）。 */
function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: opts.cwd ?? REPO_ROOT,
    encoding: opts.encoding ?? 'utf8',
    input: opts.input,
    stdio: opts.stdio ?? 'pipe',
  })
}

/** 按行切分并丢掉空行（git 的多数输出用 \n 分隔）。 */
const splitLines = (out) => String(out).split('\n').filter((s) => s !== '')

/**
 * 跑一个**用退出码 1 表示「无匹配」**的 git 子命令（如 `check-ignore`），
 * 把「无匹配」与「真错误」分开：前者返回空输出，后者照常抛。
 */
function gitAllowStatus1(args, input) {
  try {
    return git(args, { input })
  } catch (err) {
    if (err !== null && typeof err === 'object' && err.status === 1) return ''
    throw err
  }
}

/* ------------------------------------------------------------ 纯函数（可测） */

/**
 * 从 `git ls-remote --tags` 的原始行里挑出语义版本最大的 tag。
 *
 * 剥掉 peeled 引用（`refs/tags/vX^{}`）：它们是同一个 tag 的注解对象指针，
 * 不剥会得到重复项，且 `^{}` 会让数字段解析成 NaN，使比较器失去全序性
 * （实测会把 v0.1.9 当成「最新」）。
 *
 * @returns tag 名（如 `v1.6.0`），无 `v*` tag 时返回 undefined
 */
export function pickLatestTag(refLines) {
  const tags = new Set()
  for (const raw of refLines) {
    const line = String(raw).trim()
    if (line === '') continue
    const ref = line.split(/\s+/)[1] ?? line
    if (!ref.startsWith('refs/tags/')) continue
    if (ref.endsWith('^{}')) continue
    const name = ref.slice('refs/tags/'.length)
    if (!name.startsWith('v')) continue
    tags.add(name)
  }
  const sorted = [...tags].sort((a, b) => {
    const pa = a.replace(/^v/, '').split('.').map(Number)
    const pb = b.replace(/^v/, '').split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0)
      if (d !== 0) return d
    }
    return 0
  })
  return sorted[sorted.length - 1]
}

/** 上游本次出现、且在我方 `added` 清单里的路径（包相对）。 */
export function addedConflicts(added, upstreamPaths) {
  const upstream = new Set(upstreamPaths)
  return added.filter((f) => upstream.has(f)).sort()
}

/**
 * 上游**本次新增**、而我方 `dependencies`/`peerDependencies` 里没有的键。
 *
 * 只报 `next - base - ours` 而不是 `next - ours`：后者会把「基线时就存在、我方有意去掉」
 * 的依赖永久报成新增，训练人忽略这条告警。
 *
 * @returns [{ field, name }]，按 field 再按 name 排序
 */
export function missingDependencies(next, base, ours) {
  const fields = ['dependencies', 'peerDependencies']
  const out = []
  for (const field of fields) {
    const nextKeys = Object.keys(next?.[field] ?? {})
    const baseKeys = new Set(Object.keys(base?.[field] ?? {}))
    const ourKeys = new Set(Object.keys(ours?.[field] ?? {}))
    for (const name of nextKeys) {
      if (baseKeys.has(name)) continue
      if (ourKeys.has(name)) continue
      out.push({ field, name })
    }
  }
  return out.sort((a, b) => (a.field === b.field ? a.name.localeCompare(b.name) : a.field.localeCompare(b.field)))
}

/* ------------------------------------------------------------ 目标发现 */
/**
 * glob `packages/<pkg>/sync-policy.json`，读出每个 target。
 *
 * @param root 仓库根（默认本仓库；测试可传别处）
 * @returns [{ id, url, prefix, baseline, baselineCommit, owned, deleted, added, dir, policyPath }]
 */
export function discoverTargets(root = REPO_ROOT) {
  const packagesDir = join(root, 'packages')
  if (!existsSync(packagesDir)) fail(1, 'packages/ not found at ' + packagesDir)
  const targets = []
  for (const entry of readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue
    const policyPath = join(packagesDir, entry.name, 'sync-policy.json')
    if (!existsSync(policyPath)) continue
    let policy
    try {
      policy = JSON.parse(readFileSync(policyPath, 'utf8'))
    } catch (err) {
      fail(1, policyPath + ' is not valid JSON: ' + err.message)
    }
    const t = policy.target ?? {}
    for (const key of ['id', 'url', 'prefix', 'baseline', 'baselineCommit']) {
      if (typeof t[key] !== 'string' || t[key].trim() === '') {
        fail(1, policyPath + ': target.' + key + ' must be a non-empty string')
      }
    }
    if (!t.prefix.startsWith('packages/')) {
      fail(1, policyPath + ': target.prefix must be under packages/ (got ' + t.prefix + ')')
    }
    if (t.prefix !== 'packages/' + entry.name) {
      fail(1, policyPath + ': target.prefix must be ' + 'packages/' + entry.name + ' (got ' + t.prefix + ')')
    }
    targets.push({
      id: t.id,
      url: t.url,
      prefix: t.prefix,
      baseline: t.baseline,
      baselineCommit: t.baselineCommit,
      owned: Array.isArray(policy.owned) ? policy.owned : [],
      deleted: Array.isArray(policy.deleted) ? policy.deleted : [],
      added: Array.isArray(policy.added) ? policy.added : [],
      dir: join(packagesDir, entry.name),
      policyPath,
      policy,
    })
  }
  if (targets.length === 0) fail(1, 'no packages/<pkg>/sync-policy.json found under ' + packagesDir)
  const seen = new Map()
  for (const t of targets) {
    if (seen.has(t.id)) fail(1, 'duplicate target.id ' + t.id + ': ' + seen.get(t.id) + ' and ' + t.policyPath)
    seen.set(t.id, t.policyPath)
  }
  return targets
}

/* ------------------------------------------------------------ preflight */

/** 工作区必须干净：同步过程会 checkout / rm，脏工作区会把用户改动卷进来。 */
function assertCleanWorktree() {
  const dirty = git(['status', '--porcelain']).trim()
  if (dirty !== '') {
    fail(1, 'working tree is dirty; commit or stash first:\n' + dirty)
  }
}

/** 解析要同步的上游 ref：显式 --ref 优先，否则取上游最新 tag。 */
function resolveRef(target, ref) {
  if (typeof ref === 'string' && ref !== '') return ref
  const latest = pickLatestTag(git(['ls-remote', '--tags', target.url]).split('\n'))
  if (latest === undefined) fail(3, 'no v* tags found at ' + target.url)
  return latest
}

/* ------------------------------------------------------------ policy 重算 */

/** 把 policy 里的包相对路径拼成仓库内完整路径。 */
const full = (target, rel) => target.prefix + '/' + rel

/**
 * 找出承载「我方版本常量」的文件（计划 §10.3：`PLUGIN_VERSION` 必须等于 package.json 的 version，
 * 且同步**不得**把它改成上游版本 —— 我们发布的是 `@logictan/*`，版本留在自己的版本线上）。
 *
 * 为什么不能只靠「与基线内容不同」来判定 owned：我方 fork 的版本常量往往**恰好等于基线**
 * （上游 bump 了、我们的版本线没动）。此时该文件既不在 owned、也不在 deleted/added ——
 * 属于**未分类**，上游一旦 bump 版本就被 `--theirs` 静默覆盖：冲突为零、门禁全绿，
 * 但 updater 的 `CURRENT_VERSION` 永久失真（拿错版本去比 release）。
 * 所以判据是「该文件承载了我方不可被上游覆盖的常量」，与它当前是否等于基线无关。
 */
function versionConstantFiles(target, listFork) {
  const pkgJsonPath = join(target.dir, 'package.json')
  if (!existsSync(pkgJsonPath)) return []
  let version
  try {
    version = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version
  } catch {
    return []
  }
  if (typeof version !== 'string' || version === '') return []
  const pattern = new RegExp('VERSION\\w*\\s*[:=]\\s*[\'"]' + version.replace(/\./g, '\\.') + '[\'"]')
  return listFork.filter((f) => {
    try {
      return pattern.test(readFileSync(join(target.dir, f), 'utf8'))
    } catch {
      return false
    }
  })
}

/**
 * 按**当前 fork 状态**重算 owned / deleted / added。
 *
 * 为什么必须有：deleted 清单漏项时，上游同步会静默复活我们删掉的代码
 * （第 2 步 --theirs 把上游全部取回，第 4 步按 deleted 重删 —— 名单漏了就不删）。
 * 因此凡是改动过 fork 文件集的提交，都应重跑本函数。
 */
export function computeLists(target, baselineCommit) {
  // 批量取哈希（各一次 git 调用）：5 个包 × 数百个文件时，逐文件 spawn 会跑到分钟级。
  // 用 -z 分隔，避免文件名里的特殊字符被 git 转义成带引号的形式。
  const splitZ = (out) => out.split('\0').filter((s) => s !== '')
  const upstreamRows = splitZ(git(['ls-tree', '-r', '-z', baselineCommit])).map((row) => {
    const tab = row.indexOf('\t')
    return { hash: row.slice(0, tab).split(/\s+/)[2], path: row.slice(tab + 1) }
  })
  const upHash = new Map(upstreamRows.map((r) => [r.path, r.hash]))
  // policy 自己是**同步元数据**，不是 fork 内容：它必然不在上游树里，若算进 added 会变成
  // 自我指涉的噪声，并让 §6.2 的 added 冲突检测盯上一个永不可能被上游覆盖的路径。
  // policy 恒在包根（见 discoverTargets），故相对路径就是文件名。
  const POLICY_REL = 'sync-policy.json'
  const listFork = splitZ(git(['ls-files', '-z', target.prefix]))
    .map((f) => f.slice(target.prefix.length + 1))
    .filter((f) => f !== POLICY_REL)
  const forkSet = new Set(listFork)

  const deleted = upstreamRows.map((r) => r.path).filter((f) => !forkSet.has(f)).sort()
  const added = listFork.filter((f) => !upHash.has(f)).sort()

  // 只对「上游也有、且磁盘上真实存在」的文件比内容；磁盘缺失（未构建/已删未提交）→ 跳过。
  const present = listFork.filter((f) => upHash.has(f) && existsSync(join(target.dir, f))).sort()
  let forkHashes = []
  if (present.length > 0) {
    const out = execFileSync('git', ['hash-object', '--stdin-paths'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      input: present.map((f) => full(target, f)).join('\n') + '\n',
    })
    forkHashes = out.trim() === '' ? [] : out.trim().split('\n')
  }
  const owned = present.filter((f, i) => upHash.get(f) !== forkHashes[i])
  // 版本常量文件即使与基线逐字节相同也必须归我方（见 versionConstantFiles 的注释）。
  const pinned = versionConstantFiles(target, listFork).filter(
    (f) => upHash.has(f) && !owned.includes(f),
  )
  return { owned: [...owned, ...pinned].sort(), deleted, added }
}

/**
 * 按新基线重算清单并推进 `baseline` / `baselineCommit`。
 *
 * 为什么必须推进：`baseline` 是「已同步到哪个上游版本」的**唯一记录**（计划 §10.3）。
 * 不推进它，下一次 `--refresh-policy` 就会拿**旧基线**去比 —— 上游在新版本里合法改动的
 * 文件，与我方那份过时副本一比就「内容不同」，于是被误判成 `owned`：我方过时副本被永久
 * 钉住，上游在这些文件里的 bug 修复再也进不来。实测 imagegen 同步到 v1.6.0 后若基线仍是
 * v1.5.13，`owned` 会从 12 虚增到 19。
 *
 * @returns 新的 policy 对象（纯函数，不落盘）
 */
export function advanceBaseline(target, baseline, baselineCommit) {
  const lists = computeLists(target, baselineCommit)
  return {
    ...target.policy,
    target: { ...target.policy.target, baseline, baselineCommit },
    owned: lists.owned,
    deleted: lists.deleted,
    added: lists.added,
  }
}

/** 把 policy 写回它自己的文件（只碰这一个文件）。 */
function writePolicy(target, policy) {
  writeFileSync(target.policyPath, JSON.stringify(policy, null, 2) + '\n')
}

/** 重算并写回该 target 自己的 policy 文件（只碰这一个文件）。 */
function refreshPolicy(target, baselineCommit) {
  const next = advanceBaseline(target, target.baseline, baselineCommit)
  writePolicy(target, next)
  log('[sync-upstream] policy 已重算并写回 ' + target.policyPath)
  log('[sync-upstream]   owned=' + next.owned.length + ' deleted=' + next.deleted.length + ' added=' + next.added.length)
}

/* ------------------------------------------------------------ 单个目标 */

function printPlan(target, targetRef, refSource) {
  log('[sync-upstream] prefix   : ' + target.prefix)
  log('[sync-upstream] upstream : ' + target.url)
  log('[sync-upstream] baseline : ' + target.baseline + ' (' + target.baselineCommit.slice(0, 12) + ')')
  log('[sync-upstream] owned    : ' + target.owned.length + ' file(s)')
  log('[sync-upstream] deleted  : ' + target.deleted.length + ' file(s)')
  log('[sync-upstream] added    : ' + target.added.length + ' file(s)')
  log('[sync-upstream] target   : ' + targetRef + ' (' + refSource + ')')
}

function dryRunOne(target, ref) {
  const explicit = typeof ref === 'string' && ref !== ''
  const targetRef = resolveRef(target, ref)
  printPlan(target, targetRef, explicit ? '--ref' : '上游最新 v* tag')
  log('')
  log('[sync-upstream] --dry-run：以下是将执行的步骤（不改分支、不碰工作区）')
  log('  0. git fetch ' + target.url + ' ' + targetRef + '   # 取上游树，用于下面两项检查')
  log('  1. 检查 added 冲突 / 上游新增依赖（检出即退出码 2）')
  log('  2. git subtree pull --prefix=' + target.prefix + ' ' + target.url + ' ' + targetRef)
  log('  3. git checkout --theirs -- ' + target.prefix)
  log('  4. git checkout <pull 前的 HEAD> -- <' + target.owned.length + ' owned 文件>   # 非 --ours，见文件头')
  log('  5. git rm -f --ignore-unmatch <' + target.deleted.length + ' deleted 文件>')
  log('  6. git commit（分支 sync-upstream/' + target.id + '-' + targetRef + '-<ts>）')
  log('')
  log('[sync-upstream] owned 清单：')
  for (const f of target.owned) log('  - ' + f)
  log('[sync-upstream] added 清单：')
  for (const f of target.added) log('  - ' + f)
  log('[sync-upstream] deleted 清单（前 20 条）：')
  for (const f of target.deleted.slice(0, 20)) log('  - ' + f)
  if (target.deleted.length > 20) log('  … 其余 ' + (target.deleted.length - 20) + ' 条')
}

/**
 * 冲突文件分两类打印，让人一眼看出要审什么：
 *  - B 类机械：policy.deleted 里的文件（上游改了我们删掉的，重删即可）
 *  - A 类真冲突：其余（上游与我们同时改了，需人工裁定）
 */
function classifyConflicts(target, paths) {
  const deletedSet = new Set(target.deleted.map((f) => full(target, f)))
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
function filesWithConflictMarkers(prefix) {
  try {
    const out = git(['grep', '-l', '-E', '^(<<<<<<<|>>>>>>>)', '--', prefix])
    return out.trim() === '' ? [] : out.trim().split('\n')
  } catch (err) {
    // git grep 无命中时退出码为 1（不是错误）——那正是我们想要的「零冲突」。
    if (err !== null && typeof err === 'object' && err.status === 1) return []
    throw err
  }
}

/**
 * 第 4 步「重删我方删除」，按**忽略状态**分两类处理。
 *
 * 背景（实测的静默数据丢失）：上游里有 `lib/`、`assets/*.png` 这类**被上游跟踪、
 * 被我方 `.gitignore` 忽略**的路径。`git merge` 会把它们写进索引与工作区 ——
 * 我们磁盘上那份**构建产物 / README 引用的图片**被上游内容原地覆盖。
 * 此时若直接 `git rm -f`，那份被覆盖的文件还会被从磁盘删除。
 *
 * 所以：
 *   - **未忽略**的 deleted 路径 = 我方有意不跟踪的上游专有文件 → `git rm -f` 正常重删；
 *   - **被忽略**的 deleted 路径 = 我方磁盘上留着自己那份 → 只 `git rm --cached` 退出索引，
 *     并把 pull **之前**快照下来的磁盘内容还原回去（`lib/` 是构建/运行输入，
 *     `assets/*.png` 被 README 渲染，都不能丢）。
 *
 * 快照必须取 pull **之前**的内容：merge 一旦落地，工作区与 HEAD 都已是上游版本。
 */
function removeDeleted(target, ignoredSnapshot) {
  const paths = target.deleted.map((f) => full(target, f))
  const kept = paths.filter((p) => ignoredSnapshot.ignored.has(p))
  const plain = paths.filter((p) => !ignoredSnapshot.ignored.has(p))

  if (plain.length > 0) git(['rm', '-f', '--ignore-unmatch', '--', ...plain])
  if (kept.length === 0) return

  git(['rm', '--cached', '-f', '--ignore-unmatch', '--', ...kept])
  let restored = 0
  let dropped = 0
  for (const p of kept) {
    const abs = join(REPO_ROOT, p)
    if (ignoredSnapshot.present.has(p)) {
      mkdirSync(dirname(abs), { recursive: true })
      copyFileSync(join(ignoredSnapshot.dir, encodeURIComponent(p)), abs)
      restored++
    } else {
      // pull 前我方磁盘上就没有它 —— 那是上游 merge 新造出来的，清掉。
      rmSync(abs, { force: true })
      dropped++
    }
  }
  log(
    '[sync-upstream]   ' + kept.length + ' 个被忽略的 deleted 路径：只退出索引（' +
      restored + ' 个还原我方磁盘内容' + (dropped > 0 ? '，' + dropped + ' 个清除上游新造文件' : '') + '）',
  )
}

/**
 * 在 pull **之前**判定并快照「被忽略的 deleted 路径」。
 *
 * @returns { dir, ignored:Set, present:Set } —— present 有备份可还原；ignored 里不在 present 的
 *          说明我方磁盘上本就没有（pull 后若出现即上游新造，应清除）
 */
function snapshotIgnoredDeleted(target) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-upstream-keep-'))
  const paths = target.deleted.map((f) => full(target, f))
  const ignored = new Set(
    paths.length === 0 ? [] : splitLines(gitAllowStatus1(['check-ignore', '--stdin'], paths.join('\n') + '\n')),
  )
  const present = new Set()
  for (const p of ignored) {
    const abs = join(REPO_ROOT, p)
    if (!existsSync(abs)) continue
    copyFileSync(abs, join(dir, encodeURIComponent(p)))
    present.add(p)
  }
  return { dir, ignored, present }
}

/**
 * 第 3 步：把 `owned` 清单里的路径**一律**还原成我方版本。
 *
 * 为什么不是 `git checkout --ours -- <paths>`：`--ours/--theirs` 只对**未合并的索引条目**
 * 生效。git 对「双方都改、但改在不同区域」的文件会干净地三方合并 —— 既无冲突标记，
 * 索引里也没有 stage 1/2/3，此时 `--ours` 是**空操作**，我方版本静默被上游内容污染
 * （`package.json` 的版本号、我方改过的 UI 文案都会这样丢）。因此这里直接以
 * pull **之前**的 HEAD 为唯一真源覆盖回去，对冲突与非冲突路径一视同仁。
 *
 * @param prePullCommit pull **之前**的 HEAD —— 我方版本的唯一真源
 * @returns { restored, dropped } —— dropped = 我方本就没有该路径（上游新造的，须退出索引并清盘）
 */
export function restoreOwned(target, prePullCommit, cwd = REPO_ROOT) {
  const paths = target.owned.map((f) => full(target, f))
  if (paths.length === 0) return { restored: 0, dropped: 0 }

  // 「我方有没有这个路径」一次 ls-tree 判定：54 个 owned 逐文件 spawn 会明显变慢。
  const inOurs = new Set(
    splitLines(git(['ls-tree', '-r', '--name-only', prePullCommit, '--', target.prefix], { cwd })),
  )
  const present = paths.filter((p) => inOurs.has(p))
  const absent = paths.filter((p) => !inOurs.has(p))

  if (present.length > 0) git(['checkout', prePullCommit, '--', ...present], { cwd })
  if (absent.length > 0) {
    // owned 里登记了我方并不存在的路径 = 清单写错了。按「我方版本 = 不存在」处理，
    // 与 deleted 同路径：只退出索引，磁盘上上游新造的那份清掉。
    git(['rm', '--cached', '-f', '--ignore-unmatch', '--', ...absent], { cwd })
    for (const p of absent) rmSync(join(cwd, p), { force: true })
  }
  return { restored: present.length, dropped: absent.length }
}

/** 同步一个 target。`ref` 为空则取该上游的最新 v* tag。 */
function syncOne(target, ref) {  log('')
  log('[sync-upstream] ================= ' + target.id + ' =================')
  const explicit = typeof ref === 'string' && ref !== ''
  const targetRef = resolveRef(target, ref)
  printPlan(target, targetRef, explicit ? '--ref' : '上游最新 v* tag')

  assertCleanWorktree()

  // 先取上游树：下面两项检查必须在**动分支之前**做，失败即零副作用退出。
  git(['fetch', target.url, targetRef], { stdio: 'inherit' })
  const upstreamCommit = git(['rev-parse', 'FETCH_HEAD^{commit}']).trim()
  const upstreamPaths = git(['ls-tree', '-r', '--name-only', upstreamCommit]).trim().split('\n').filter(Boolean)

  // §6.2：added 是我方独有文件，上游出现同名路径会被 --theirs 静默覆盖。
  const clashes = addedConflicts(target.added, upstreamPaths)
  if (clashes.length > 0) {
    const detail = clashes.map((f) => '  - ' + full(target, f)).join('\n')
    fail(
      2,
      '上游 ' + targetRef + ' 出现了我方 added 清单里的路径 —— ' +
        '`git checkout --theirs` 会用上游版本覆盖它们，而第 3 步只恢复 owned。\n' +
        '必须人工裁定：采用上游实现（把该路径从 added 移入 owned/deleted），' +
        '或保留我方实现（改名或在上游侧接受冲突）。\n' + detail,
    )
  }

  // §10.2：package.json 在 owned 里，上游新增依赖不会被我方带入。
  const readUpstreamPkg = (commit) => {
    try {
      return JSON.parse(git(['show', commit + ':package.json']))
    } catch {
      return {}
    }
  }
  let ourPkg = {}
  try {
    ourPkg = JSON.parse(readFileSync(join(target.dir, 'package.json'), 'utf8'))
  } catch {
    ourPkg = {}
  }
  const missing = missingDependencies(readUpstreamPkg(upstreamCommit), readUpstreamPkg(target.baselineCommit), ourPkg)
  if (missing.length > 0) {
    const detail = missing.map((m) => '  - ' + m.name + '  (' + m.field + ')').join('\n')
    fail(
      2,
      '上游 ' + targetRef + ' 新增了我方 ' + target.prefix + '/package.json 里没有的依赖。\n' +
        '该文件的 name/repository 被我方改造过，所以在 owned 里 —— 同步不会把上游新增的依赖带进来，' +
        '源码会同步成上游版本而依赖缺失（构建失败 / 运行时 Cannot find module）。\n' +
        '请把这几个键补进 ' + target.prefix + '/package.json 后重跑。\n' + detail,
    )
  }

  const branch = 'sync-upstream/' + target.id + '-' + targetRef + '-' + Date.now()
  log('[sync-upstream] 创建临时分支 ' + branch)
  // 我方版本的唯一真源：分支建好后、pull 之前的那一刻。git 的自动合并会把
  // 「双方都改、但改在不同区域」的 owned 文件干净地合起来（无冲突标记、无索引 stage），
  // 此时 `checkout --ours` 是**空操作**，我方版本会静默被上游内容污染。
  const prePullCommit = git(['rev-parse', 'HEAD']).trim()
  git(['checkout', '-b', branch])

  // 被忽略的 deleted 路径要在 pull **之前**快照：merge 一落地，磁盘与 HEAD 都已是上游版本。
  const ignoredSnapshot = snapshotIgnoredDeleted(target)
  try {
    log('[sync-upstream] 1/4 subtree pull ...')
    // 无冲突也**必须**继续走 2/3/4：git 的自动合并不会重删我们删过的文件，
    // 也不会恢复被上游覆盖的我方改造。提前 return 会让 policy 整段失效。
    try {
      git(['subtree', 'pull', '--prefix=' + target.prefix, target.url, targetRef], { stdio: 'inherit' })
      log('[sync-upstream] subtree pull 无冲突完成（仍需应用 policy：重删 + 恢复我方改造）')
    } catch {
      log('[sync-upstream] subtree pull 产生冲突，按 policy 归零 ...')
    }

    log('[sync-upstream] 2/4 全取上游：git checkout --theirs -- ' + target.prefix)
    git(['checkout', '--theirs', '--', target.prefix])

    log('[sync-upstream] 3/4 恢复我方改造：' + target.owned.length + ' 个 owned 文件')
    const ownedResult = restoreOwned(target, prePullCommit)
    log(
      '[sync-upstream]   owned 一律取 ' + prePullCommit.slice(0, 7) + ' 版本（' +
        ownedResult.restored + ' 个）' +
        (ownedResult.dropped > 0 ? '，' + ownedResult.dropped + ' 个我方本就没有 → 退出索引并清盘' : ''),
    )

    log('[sync-upstream] 4/4 重删我方删除：' + target.deleted.length + ' 个文件')
    if (target.deleted.length > 0) removeDeleted(target, ignoredSnapshot)

    // 归零判据（见 filesWithConflictMarkers 注释）：checkout 只改工作区，索引要 git add 才收敛。
    const conflicted = filesWithConflictMarkers(target.prefix)
    if (conflicted.length > 0) {
      const { real, mechanical } = classifyConflicts(target, conflicted)
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

    // §10.3：把基线推进到本次同步的上游版本，并按**新基线**重算清单。
    // 必须在 `git add -A` 之后：computeLists 读的是索引（`ls-files`），索引与工作区
    // 未收敛时算出来的清单是错的（checkout --theirs 只改工作区）。
    const advanced = advanceBaseline(target, targetRef, upstreamCommit)
    writePolicy(target, advanced)
    git(['add', '--', target.policyPath])
    log(
      '[sync-upstream] policy 基线推进：' + target.baseline + ' → ' + targetRef +
        '（owned=' + advanced.owned.length + ' deleted=' + advanced.deleted.length +
        ' added=' + advanced.added.length + '）',
    )

    // 已在上游基线上时，pull 与 policy 三步都是 no-op —— 不制造空提交。
    let changed = true
    try {
      git(['diff', '--cached', '--quiet', 'HEAD'])
      changed = false
    } catch {
      changed = true
    }
    if (!changed) {
      log('[sync-upstream] 该目标已在上游 ' + targetRef + ' 上，无改动 —— 跳过提交。')
      return
    }

    git(
      ['commit', '-m', 'chore: sync upstream ' + target.id + ' ' + targetRef + '\n\n按 ' +
        target.prefix + '/sync-policy.json 应用 owned/deleted 清单（theirs → 按 pre-pull commit 恢复 owned → 重删）。'],
      { stdio: 'inherit' },
    )
    log('[sync-upstream] 完成。当前分支：' + branch)
    log('[sync-upstream] 下一步：推送该分支并开 PR（workflow 只开 PR，绝不直接推 main）。')
  } catch (err) {
    if (err instanceof SyncError) throw err
    process.stderr.write('[sync-upstream] git 命令失败：' + (err instanceof Error ? err.message : String(err)) + '\n')
    process.stderr.write('[sync-upstream] 当前在分支 ' + branch + '；处理完冲突后手动 commit，或 git checkout - 放弃。\n')
    fail(3, 'git 命令失败（见上）')
  } finally {
    rmSync(ignoredSnapshot.dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------ CLI */

const USAGE = `用法：
  node scripts/sync-upstream.mjs --list
  node scripts/sync-upstream.mjs --dry-run [--target <id>] [--ref <ref>]
  node scripts/sync-upstream.mjs [--target <id>] [--ref <ref>]
  node scripts/sync-upstream.mjs --refresh-policy [--target <id>] [--baseline <commit>]`

export function runCli(argv) {
  const flag = (name) => argv.includes(name)
  const value = (name) => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }

  const known = ['--list', '--dry-run', '--refresh-policy', '--target', '--baseline', '--ref', '--help']
  const unknown = argv.filter((a, i) => a.startsWith('--') && !known.includes(a) && !(i > 0 && ['--target', '--baseline', '--ref'].includes(argv[i - 1])))
  if (unknown.length > 0) fail(1, 'unknown flag(s): ' + unknown.join(', ') + '\n' + USAGE)
  if (flag('--help')) {
    log(USAGE)
    return
  }

  const all = discoverTargets()
  const onlyId = value('--target')
  const selected = onlyId === undefined ? all : all.filter((t) => t.id === onlyId)
  if (onlyId !== undefined && selected.length === 0) {
    fail(1, 'unknown --target ' + onlyId + '; known: ' + all.map((t) => t.id).join(', '))
  }

  if (flag('--list')) {
    log('[sync-upstream] ' + all.length + ' target(s)：')
    for (const t of all) {
      log(
        '  ' + t.id.padEnd(16) + t.prefix.padEnd(32) + t.baseline.padEnd(10) +
          'owned=' + t.owned.length + ' deleted=' + t.deleted.length + ' added=' + t.added.length +
          '  ' + t.url,
      )
    }
    return
  }

  if (flag('--refresh-policy')) {
    const baseline = value('--baseline')
    for (const t of selected) {
      const commit = baseline ?? t.baselineCommit
      if (typeof commit !== 'string' || commit === '') {
        fail(1, '--refresh-policy 需要 --baseline <commit>，或在 policy 里写 target.baselineCommit')
      }
      log('[sync-upstream] ================= ' + t.id + ' =================')
      refreshPolicy(t, commit)
    }
    return
  }

  const ref = value('--ref')
  if (flag('--dry-run')) {
    for (const t of selected) dryRunOne(t, ref)
    return
  }

  if (selected.length === 1) {
    syncOne(selected[0], ref)
    return
  }

  // 全部目标：每个从同一基点各开一条分支（互不冲突：各自只碰自己的 prefix），
  // 跑完回到原分支。任一目标失败即停止，分支留在原地供检查。
  const originalBranch = git(['symbolic-ref', '-q', '--short', 'HEAD']).trim()
  const baseCommit = git(['rev-parse', 'HEAD']).trim()
  if (originalBranch !== '') {
    const restore = () => {
      try {
        git(['checkout', '-q', originalBranch])
      } catch {
        process.stderr.write('[sync-upstream] 无法切回 ' + originalBranch + '，请手动检查当前分支。\n')
      }
    }
    process.on('exit', restore)
  }
  for (const t of selected) {
    git(['checkout', '-q', baseCommit])
    syncOne(t, ref)
  }
  if (originalBranch !== '') git(['checkout', '-q', originalBranch])
}

function main() {
  try {
    runCli(process.argv.slice(2))
  } catch (err) {
    if (err instanceof SyncError) {
      process.stderr.write('[sync-upstream] ERROR ' + err.message + '\n')
      process.exit(err.code)
    }
    throw err
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main()
}
