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
 *   2. git checkout --theirs -- <prefix>                      # 冲突条目一律取上游
 *   3. git checkout <pull 前的 HEAD> -- <owned 文件>           # 再恢复我方改造
 *   4. git rm -f --ignore-unmatch <deleted 文件>               # 重删我方删除
 *   5. git commit
 *
 * 第 2 步**只解决冲突条目**：`--theirs`（与 `--ours` 一样）只对**未合并的索引条目**生效，
 * 对 git 干净三方合并的路径是空操作。它**不是**「把整棵子树恢复成上游版本」的手段 ——
 * 那些干净合并的路径本来就是「上游内容 + 我方不相邻的改动」，无需额外处理。因此
 * 「owned 文件必须逐字节等于我方版本」只能由第 3 步按 pull 前的 HEAD 覆盖来保证（见下）。
 *
 * **无冲突时也必须走完 2/3/4**（§7.3 不变量）：git 的自动合并不会重删我们删过的文件，也不会恢复
 * 被上游覆盖的我方改造。第 2 步此时是空操作，但**仍然要执行** —— 跳过它会在有冲突时失去
 * 「冲突条目一律取上游」这一步。
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
 *   权威副本是下方 `USAGE` 常量（`--help` 输出它）。语义要点：
 *
 *   `--list` 列出**全部**发现的 target（§7.1），零写入。
 *   `--dry-run` 只打印计划与清单，零写入；**不执行**它打印的前两步检查（那两步要 fetch 上游）。
 *   `--refresh-policy` 重算并写回该目标的 policy。
 *   无 `--target` 时对**全部**目标串行执行：每个目标从同一基点各开一条分支，跑完回到原分支。
 *   CI 用 matrix 逐目标调用（见 .github/workflows/sync-upstream.yml），不依赖这个全量模式。
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
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
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

/**
 * 当前是否处于「合并进行中」（真冲突）状态。
 *
 * 用于把 `subtree pull` 的**真冲突**与**硬失败**分开：真冲突会留下 MERGE_HEAD 与未合并的
 * 索引条目；`fatal: refusing to merge unrelated histories` 这类硬失败两者皆无（实测）。
 * 混为一谈会让硬失败被当成「冲突已归零」而假成功（见 syncOne 里的注释）。
 */
function isMergeInProgress() {
  // `rev-parse -q --verify` 在 MERGE_HEAD 不存在时退出码 1（不是错误）—— 用 gitAllowStatus1 包住。
  const mergeHead = gitAllowStatus1(['rev-parse', '-q', '--verify', 'MERGE_HEAD']).trim()
  if (mergeHead !== '') return true
  return git(['ls-files', '-u']).trim() !== ''
}

/**
 * 把 git 命令的失败统一成退出码 3（§7.3：「git 命令失败」）。
 *
 * 为什么必须收口：`main()` 只把 `SyncError` 翻译成 `[sync-upstream] ERROR <msg>` + 退出码；
 * 其他异常直接重抛，用户看到的是 node 内部栈（`node:internal/errors`）与退出码 1，
 * 与文档承诺的「git 失败 = 3」不符，也让 CI 无法区分「用法错误(1)」与「环境/网络失败(3)」。
 *
 * @param err  原始异常
 * @param note 失败时的现场说明（是否已建分支、是否已改工作区）
 * @returns never
 */
function gitFailure(err, note) {
  if (err instanceof SyncError) throw err
  process.stderr.write(
    '[sync-upstream] git 命令失败：' + (err instanceof Error ? err.message : String(err)) + '\n',
  )
  if (note !== undefined) process.stderr.write('[sync-upstream] ' + note + '\n')
  fail(3, 'git 命令失败（见上）')
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
 * 排序用 `compareTags`（全序）而非逐段 `Number()` 相减，理由见该函数。
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
  const sorted = [...tags].sort(compareTags)
  return sorted[sorted.length - 1]
}

/**
 * tag 的**全序**比较器（`Array#sort` 的比较器必须是全序，否则结果取决于输入顺序）。
 *
 * 为什么不能只 `Number()` 各段相减：带后缀的 tag（`v2.3.1-final`、`v1.14.0-beta.1`）
 * 会被 `Number('1-final')` 解析成 `NaN`，`NaN` 参与减法返回 `NaN` —— 比较器失去全序性，
 * 排序结果随 `git ls-remote` 的返回顺序变化。实测：`['v2.3.1','v2.3.1-final']` 选出
 * `v2.3.1-final`，而把输入反序就变成 `v2.3.1`。上游确实同时存在这类 tag
 * （easyrewrite 有 `v2.3.1` / `v2.3.1-final`，market 有 `v1.14.0` / `v1.14.0-beta.1`），
 * 所以这不是理论问题：选错 tag 会同步到一个非正式发布。
 *
 * 规则：先比数字核心（缺失段按 0，故 `v1.2.3.1 > v1.2.3`）；核心相同时**正式版优先于任何
 * 带后缀的版本**（预发布/补丁命名不应盖过正式发布）；后缀之间按字典序定序。最后**仍相等时
 * 按原始 tag 名做字典序兜底**：数字核心相等但段数不同的别名（`v1.2.3` vs `v1.2.3.0`、
 * `v1` vs `v1.0.0`）在「缺失段按 0」的规则下数值相同，若不兜底，两个**不同的名字**会判等
 * （返回 0），`sort` 稳定排序下结果又回到依赖输入顺序 —— 正是本函数要消除的失效模式。
 */
function compareTags(a, b) {
  const parse = (tag) => {
    const body = tag.replace(/^v/, '')
    const m = body.match(/^(\d+(?:\.\d+)*)(.*)$/)
    return m === null ? { core: [], suffix: body } : { core: m[1].split('.').map(Number), suffix: m[2] }
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0)
    if (d !== 0) return d
  }
  if (pa.suffix !== pb.suffix) {
    if (pa.suffix === '') return 1
    if (pb.suffix === '') return -1
    return pa.suffix < pb.suffix ? -1 : 1
  }
  // 数值与后缀都相同 → 只剩别名差异（`v1.2.3` vs `v1.2.3.0`、`v1` vs `v1.0.0`）。
  // 先偏好段数少的（`v1.2.3` 比 `v1.2.3.0` 更像正式发布）—— 注意 `pickLatestTag` 取的是
  // 升序排序的**末位**，所以「更受偏好」要返回正值。再按名字定序。
  // 关键是**绝不在 a !== b 时返回 0**：判等会让 sort 的结果回到依赖输入顺序。
  if (a === b) return 0
  if (pa.core.length !== pb.core.length) return pb.core.length - pa.core.length
  return a < b ? -1 : 1
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
    // 上游是 monorepo 时子包所在的子目录（如 examples/dsh-memory-plugin）。缺省 = 上游树根
    // 就是子包本身，走原路径。类型错必须当场报：写成非字符串会静默退化成「按整棵上游树算
    // 清单」，产出一个几千条的 deleted 与错配的 owned（见 computeLists 的 scoped 说明）。
    if (t.subdir !== undefined && (typeof t.subdir !== 'string' || t.subdir.trim() === '')) {
      fail(1, policyPath + ': target.subdir 若存在必须是非空字符串')
    }
    targets.push({
      id: t.id,
      url: t.url,
      prefix: t.prefix,
      subdir: t.subdir,
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
  // `ls-remote` 会因网络/凭据/主机不可达而失败 —— 统一成退出码 3，不要让 node 栈穿透出去。
  let lines
  try {
    lines = git(['ls-remote', '--tags', target.url]).split('\n')
  } catch (err) {
    gitFailure(err, '无法读取 ' + target.url + ' 的 tag 列表。')
  }
  const latest = pickLatestTag(lines)
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
/** 上游树中「本子包」那棵子树的 spec（`<commit>` 或 `<commit>:<subdir>`）。 */
function upstreamTreeSpec(target, commit) {
  return target.subdir === undefined ? commit : commit + ':' + target.subdir
}

/**
 * 上游树里某个**包相对路径**的 spec（`git show` 用）。
 *
 * 与 upstreamTreeSpec 分开：后者是「一棵树」，本函数是「树里的一个文件」。
 *
 * 不能写成 `upstreamTreeSpec(target, commit) + ':' + relPath`：subdir 目标会拼出
 * `<commit>:<subdir>:<relPath>`，而 git **不解析路径段里的第二个冒号**（实测 2.50.1：
 * `fatal: path 'examples/dsh-memory-plugin:package.json' does not exist`）。
 * 调用方 readUpstreamPkg catch 成 `{}`，于是上游新增依赖的预检对 subdir 目标**静默失效** ——
 * 退出码 0、源码同步成上游版本而依赖缺失，症状要到构建/运行期才炸。
 * 两个 OpenViking fork 都是 subdir 目标，故这条路径正是它们唯一的依赖防线。
 */
function upstreamFileSpec(target, commit, relPath) {
  return commit + ':' + (target.subdir === undefined ? '' : target.subdir + '/') + relPath
}

export function computeLists(target, baselineCommit) {
  // 批量取哈希（各一次 git 调用）：5 个包 × 数百个文件时，逐文件 spawn 会跑到分钟级。
  // 用 -z 分隔，避免文件名里的特殊字符被 git 转义成带引号的形式。
  const splitZ = (out) => out.split('\0').filter((s) => s !== '')
  // 上游是 monorepo 时只取 subdir 子树 —— 否则上游整棵树（OpenViking 有几千个文件）
  // 都会被算成「我方删除」，清单当场失真。
  //
  // 用 `<commit>:<subdir>` 而不是 `-r <commit> -- <subdir>`：后者要扫整棵树再过滤。
  // 两者**返回的路径形态不同**（实测）：`<commit>:<subdir>` → `a.txt`（相对该子树），
  // `-r <commit> -- <subdir>` → `<subdir>/a.txt`（相对仓库根）。
  // 这里取的是前者，所以**不做**二次剥前缀 —— 剥了会把 `a.txt` 截成空串，每个文件都对不上；
  // 反过来若照后者的形态做剥前缀，清单会整体错位。
  const upstreamRows = splitZ(git(['ls-tree', '-r', '-z', upstreamTreeSpec(target, baselineCommit)])).map((row) => {
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

/**
 * 把上游 monorepo 的某个子目录拆成一个独立分支，供 `subtree pull` 使用。
 *
 * ## 为什么不能直接 `subtree pull <上游 url> <tag>`
 *
 * 实测（计划 §1.7）：对插件目录直接 pull 上游 v0.4.21 灌入 **4269 个文件、1,191,186 行**，
 * 子包目录被替换成整棵上游仓库根。subtree 的 `--prefix` 只决定「合进哪里」，上游侧永远
 * 按**整棵树**参与三方合并。
 *
 * ## 为什么 split 必须在临时 worktree 里跑
 *
 * `git subtree split` 先要求 `--prefix` **在当前工作区存在**（实测在只 fetch 了对象的仓库里
 * 跑 → `fatal: 'examples/dsh-memory-plugin' does not exist; use 'git subtree add'`）。主仓库的
 * `packages/dsh-openviking` 只有子目录内容、没有 `examples/` 这一层，所以必须把上游树检出到
 * 一个 worktree 里再拆。
 *
 * worktree 与主仓库共享对象库与 `refs/heads` ⇒ split 出来的分支主仓库直接可见，
 * `subtree pull . <branch>` 无需再 fetch。代价是 split 的历史会写进主仓库对象库（实测该上游约
 * 100MB），这与本脚本对既有 fork 的做法一致 —— `subtree pull` 本来就会把上游历史拉进来。
 *
 * @returns { dir, branch } —— 调用方负责在 finally 里 removeSplitBranch
 */
function splitSubdirBranch(target, upstreamCommit) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-upstream-wt-'))
  const branch = 'sync-upstream-split/' + target.id + '-' + Date.now()
  // 失败也要把 worktree 收掉：留着的 detached worktree 会让下一次 `git worktree add`
  // 在同一路径上撞车，也会让 `git status` 多出一堆噪声。
  const bail = (err) => {
    rmSync(dir, { recursive: true, force: true })
    try {
      git(['worktree', 'prune'])
    } catch {
      // prune 失败不影响判定：worktree 目录已删，剩下的只是 .git/worktrees 里的一条元数据。
    }
    gitFailure(
      err,
      '无法把 ' + target.subdir + ' 拆成独立分支 —— 上游结构可能已变（见 sync-policy.json 的 target.subdir）。',
    )
  }
  try {
    git(['worktree', 'add', '-q', '--detach', dir, upstreamCommit], { stdio: 'inherit' })
  } catch (err) {
    bail(err)
  }
  try {
    // -q：split 默认在 stderr 上打每个提交一行进度（该上游 2400+ 行），CI 日志里全是噪声。
    git(['-C', dir, 'subtree', 'split', '-q', '--prefix=' + target.subdir, upstreamCommit, '-b', branch], {
      stdio: 'inherit',
    })
  } catch (err) {
    bail(err)
  }
  return { dir, branch }
}

/** 收掉 splitSubdirBranch 造出的 worktree 与分支（幂等，失败不掩盖真正的错误）。 */
function removeSplitBranch(split) {
  try {
    git(['worktree', 'remove', '--force', split.dir])
  } catch {
    rmSync(split.dir, { recursive: true, force: true })
    git(['worktree', 'prune'])
  }
  git(['branch', '-D', split.branch])
}

function printPlan(target, targetRef, refSource) {
  log('[sync-upstream] prefix   : ' + target.prefix)
  log('[sync-upstream] subdir   : ' + (target.subdir ?? '(上游树根)'))
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
  log('     ↑ 第 0/1 步**在 dry-run 下不执行**（需要访问上游）；真实执行时才会跑。')
  log('       所以 dry-run 不能预演 exit-2 的条件，只预演 policy 应用本身。')
  if (target.subdir === undefined) {
    log('  2. git subtree pull --prefix=' + target.prefix + ' ' + target.url + ' ' + targetRef)
  } else {
    // 上游是 monorepo：不能直接 pull 上游 ref（实测会把整棵上游树灌进子包目录，
    // 4269 文件 / 119 万行）。先在本仓库的临时 worktree 里把 subdir 拆成独立分支，
    // 再 pull 那个分支（见 splitSubdirBranch）。
    log('  2. git worktree add --detach <tmp> ' + targetRef + '   # 上游树')
    log('     git -C <tmp> subtree split --prefix=' + target.subdir + ' <commit> -b <split>')
    log('     git subtree pull --prefix=' + target.prefix + ' . <split>')
  }
  log('  3. git checkout --theirs -- ' + target.prefix + '   # 只对未合并条目生效，干净合并的路径无需处理')
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
 * pull **之前**判定「上游有、我方文件集里没有、且被我方 .gitignore 排除」的路径。
 *
 * 为什么必须单独处理：subtree pull 会把上游新增的文件写进**索引**，而 .gitignore 只拦
 * 未跟踪文件、拦不住已经在索引里的路径。这些路径不在 owned/added 里，也不在按**旧基线**
 * 算出的 deleted 里（旧基线树里根本没有它们）—— 三个清单都够不着，于是上游的构建产物与
 * 宣传图会静默变成我方的跟踪文件。
 *
 * 与 removeDeleted 的分工是**按路径互斥**的：已在 target.deleted 里的路径归 removeDeleted，
 * 这里只收它够不着的那些（上游本次新增），两者不重复处理同一路径。
 *
 * 实测 workbuddy v0.5.4 → v0.6.2：lib/variants-B3Pa4EBr.js 与 assets/{6,7}.png 被带进索引。
 * workbuddy 的构建钩子是 prepack（不是 prepare），CI 里 pnpm test 不重建 lib/，磁盘上只剩
 * 上游那个带 0.6.2 版本常量的 chunk，tests/version.spec.ts 因此报
 * 「no built bundle declares WORKBUDDY_CONNECT_VERSION as 0.5.5」。
 *
 * 语义与 snapshotIgnoredDeleted 一致：我方磁盘上本来就有的，pull 后还原回去；
 * 本来没有的（上游新造），清掉。
 */
function snapshotResurrectedIgnored(target, upstreamPaths) {
  const ours = new Set(
    git(['ls-files', '-z', target.prefix])
      .split('\0')
      .filter((f) => f !== '')
      .map((f) => f.slice(target.prefix.length + 1)),
  )
  const ownedByDeleted = new Set(target.deleted)
  const candidates = upstreamPaths
    .filter((f) => !ours.has(f) && !ownedByDeleted.has(f))
    .map((f) => full(target, f))
  const dir = mkdtempSync(join(tmpdir(), 'sync-upstream-resurrect-'))
  const ignored = new Set(
    candidates.length === 0
      ? []
      : splitLines(gitAllowStatus1(['check-ignore', '--stdin'], candidates.join('\n') + '\n')),
  )
  const present = new Set()
  for (const p of ignored) {
    const abs = join(REPO_ROOT, p)
    if (!existsSync(abs)) continue
    copyFileSync(abs, join(dir, encodeURIComponent(p)))
    present.add(p)
  }
  return { dir, ignored, present, stopAt: join(REPO_ROOT, target.prefix) }
}

/**
 * 删掉目录里最后一个文件后，把随之空掉的目录也逐级清掉（止于包根）。
 *
 * 为什么必须清：空的 `lib/` 目录会让「产物尚未构建」的判据失效。workbuddy 的
 * `tests/version.spec.ts` 用 `if (!existsSync(libDir)) return` 表示「新克隆、还没构建，跳过」；
 * 只删文件不删目录时 `lib/` 仍在，于是走到 `expect(bundles.length).toBeGreaterThan(0)` 并报
 * 「no built bundles in lib/」——把一个已修好的同步问题伪装成构建问题。
 */
function pruneEmptyParents(absPaths, stopAt) {
  const seen = new Set()
  for (const abs of absPaths) {
    let dir = dirname(abs)
    while (dir !== stopAt && dir.startsWith(stopAt + sep) && !seen.has(dir)) {
      seen.add(dir)
      if (!existsSync(dir) || readdirSync(dir).length > 0) break
      rmdirSync(dir)
      dir = dirname(dir)
    }
  }
}

/** 应用 snapshotResurrectedIgnored：把上游新造、我方忽略的路径退出索引并清盘。 */
function removeResurrectedIgnored(snapshot) {
  if (snapshot.ignored.size === 0) return 0
  const paths = [...snapshot.ignored]
  git(['rm', '--cached', '-f', '--ignore-unmatch', '--', ...paths])
  for (const p of paths) {
    const abs = join(REPO_ROOT, p)
    if (snapshot.present.has(p)) {
      mkdirSync(dirname(abs), { recursive: true })
      copyFileSync(join(snapshot.dir, encodeURIComponent(p)), abs)
    } else {
      rmSync(abs, { force: true })
    }
  }
  pruneEmptyParents(
    paths.filter((q) => !snapshot.present.has(q)).map((q) => join(REPO_ROOT, q)),
    snapshot.stopAt,
  )
  return paths.length
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

  const branch = 'sync-upstream/' + target.id + '-' + targetRef + '-' + Date.now()
  let upstreamCommit = ''
  let upstreamPaths = []
  let prePullCommit = ''
  // 预检的 git 调用同样受 §7.3 的退出码契约约束：上游不可达 / tag 不存在 / 网络中断都发生在
  // 这里，漏在 try 之外会让异常穿透到 main()，用户看到的是 node 内部栈、退出码从 3 变成 1
  // （实测：url 指向不可达主机 → EXIT=1 + `node:internal/errors` 栈，零 `[sync-upstream]` 前缀）。
  try {
    // 先取上游树：下面两项检查必须在**动分支之前**做，失败即零副作用退出。
    git(['fetch', target.url, targetRef], { stdio: 'inherit' })
    upstreamCommit = git(['rev-parse', 'FETCH_HEAD^{commit}']).trim()
    // 上游是 monorepo 时只取 subdir 子树，并相对化：added 冲突检测与依赖检查比对的都是
    // **包相对**路径 / 包自己的 package.json，拿上游整棵树比会同时误报与漏报。
    upstreamPaths = git(['ls-tree', '-r', '--name-only', upstreamTreeSpec(target, upstreamCommit)])
      .trim()
      .split('\n')
      .filter(Boolean)
  } catch (err) {
    gitFailure(err, '预检失败：尚未创建分支、未改动工作区。')
  }

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
      return JSON.parse(git(['show', upstreamFileSpec(target, commit, 'package.json')]))
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

  log('[sync-upstream] 创建临时分支 ' + branch)
  // 我方版本的唯一真源：分支建好后、pull 之前的那一刻。git 的自动合并会把
  // 「双方都改、但改在不同区域」的 owned 文件干净地合起来（无冲突标记、无索引 stage），
  // 此时 `checkout --ours` 是**空操作**，我方版本会静默被上游内容污染。
  try {
    prePullCommit = git(['rev-parse', 'HEAD']).trim()
    git(['checkout', '-b', branch])
  } catch (err) {
    gitFailure(err, '创建分支失败：仍在原分支，工作区未改动。')
  }

  // 被忽略的 deleted 路径要在 pull **之前**快照：merge 一落地，磁盘与 HEAD 都已是上游版本。
  const ignoredSnapshot = snapshotIgnoredDeleted(target)
  // 上游新增且被我方 .gitignore 排除的路径同样要在 pull 前快照（见该函数注释）。
  const resurrectedSnapshot = snapshotResurrectedIgnored(target, upstreamPaths)
  // 上游是 monorepo 时的拆分工作区（见 splitSubdirBranch）。非 subdir 目标恒为 null，
  // 走原来「直接 pull 上游 url + ref」的路径。
  let split = null
  try {
    let pullRepo = target.url
    let pullRef = targetRef
    if (target.subdir !== undefined) {
      log('[sync-upstream] 0/4 拆分上游 ' + target.subdir + ' 为独立分支 ...')
      split = splitSubdirBranch(target, upstreamCommit)
      pullRepo = '.'
      pullRef = split.branch
    }
    log('[sync-upstream] 1/4 subtree pull ...')
    // 无冲突也**必须**继续走 2/3/4：git 的自动合并不会重删我们删过的文件，
    // 也不会恢复被上游覆盖的我方改造。提前 return 会让 policy 整段失效。
    //
    // 但**不能**把任何失败都当成「产生冲突」。实测的假成功：目标目录若是「用普通提交导入、
    // 没有 subtree 祖先」的形态，`subtree pull` 以 `fatal: refusing to merge unrelated
    // histories` 失败（EXIT=128）—— 此时脚本若照常往下走，`git add -A` 只会把 policy 的
    // baseline 改动提交上去，产出一个**只含 policy 的提交**，并把 baselineCommit 推进到
    // 那个从未合并进来的上游 commit。表面上退出码 0、PR 正常开出，实际什么都没同步，
    // 且基线已被污染（下一次 `--refresh-policy` 会拿一个假基线去比）。
    //
    // 判据用 MERGE_HEAD：真冲突（`CONFLICT (content)`）一定会留下 MERGE_HEAD 与未合并索引
    // 条目（实测 3 条）；而 unrelated histories 这类硬失败两者皆无（实测 MERGE_HEAD 缺失、
    // `ls-files -u` 为空）。用「索引里有没有未合并条目」而不是「MERGE_HEAD 在不在」更贴近
    // 本脚本真正依赖的性质，故两者取或。
    try {
      git(['subtree', 'pull', '--prefix=' + target.prefix, pullRepo, pullRef], { stdio: 'inherit' })
      log('[sync-upstream] subtree pull 无冲突完成（仍需应用 policy：重删 + 恢复我方改造）')
    } catch (err) {
      if (!isMergeInProgress()) {
        // 硬失败：工作区可能已被 subtree 动过，但既然没有合并进行中，就没有「按 policy 归零」可言。
        gitFailure(err, 'subtree pull 失败且未产生合并冲突 —— 该目标可能尚未被 subtree 收养（见 AGENTS.md「fork 的判据」）。')
      }
      log('[sync-upstream] subtree pull 产生冲突，按 policy 归零 ...')
    }

    log('[sync-upstream] 2/4 冲突条目取上游：git checkout --theirs -- ' + target.prefix)
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

    // 上游新增、被我方 .gitignore 排除的路径：pull 已把它们写进索引，.gitignore 拦不住。
    // 不清掉的话它们会变成我方的跟踪文件（见 snapshotResurrectedIgnored 的实测记录）。
    const resurrected = removeResurrectedIgnored(resurrectedSnapshot)
    if (resurrected > 0) {
      log('[sync-upstream]   上游新造 ' + resurrected + ' 个被我方 .gitignore 排除的路径 → 退出索引并清盘')
    }

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
    log(
      '[sync-upstream] 下一步：推送该分支并开 PR。workflow 的做法是把该分支 squash 回 main 并保持暂存态，' +
        '再由 create-pull-request 建 PR 分支 —— 它只推 PR 分支，绝不推 main。',
    )
  } catch (err) {
    if (err instanceof SyncError) throw err
    gitFailure(err, '当前在分支 ' + branch + '；处理完冲突后手动 commit，或 git checkout - 放弃。')
  } finally {
    rmSync(ignoredSnapshot.dir, { recursive: true, force: true })
    rmSync(resurrectedSnapshot.dir, { recursive: true, force: true })
    if (split !== null) removeSplitBranch(split)
  }
}

/* ------------------------------------------------------------ CLI */

const USAGE = `用法：
  node scripts/sync-upstream.mjs --list
  node scripts/sync-upstream.mjs --dry-run [--target <id>] [--ref <ref>]
  node scripts/sync-upstream.mjs [--target <id>] [--ref <ref>]
  node scripts/sync-upstream.mjs --refresh-policy [--target <id>] [--baseline <commit>]

带取值的 flag（--target / --baseline / --ref）缺值即报错退出码 1，不会静默退化成默认行为。

--list 列出**所有**发现的 target（§7.1）；--target 只作用于会写盘的子命令。

--dry-run 优先于 --refresh-policy：两者同时出现时按 dry-run 处理（零写入）。

--refresh-policy --baseline <commit> 只把 target.baselineCommit 换成该 commit，
target.baseline（tag 名）保持 policy 里的原值不动 —— 它没有反向查 tag 的途径，
想同时更正 tag 名请手改 policy。`

export function runCli(argv) {
  const flag = (name) => argv.includes(name)

  // 带取值的 flag：缺值必须当场报错（退出码 1）。
  // 为什么不能沿用 `argv[i + 1]` 直接取：静默拿到 undefined 会让
  //   `--target`（无值）退化成「作用于全部目标」、
  //   `--baseline`（无值）退回 policy 里的旧 commit —— 实测两者都退出码 0，
  // 用户以为只动了一个目标/用了一个显式基线，实际动了全部目标或用了旧基线。
  //
  // 判据是「值看起来像 flag 吗」，不是「值等于某个**已知** flag 吗」。后者双向失准：
  // 漏挡 —— `--baseline --all` 里 `--all` 不是已知 flag，于是被当作 baseline 传给
  //   `git ls-tree`（`error: unknown option 'all'`，退出码 1 + 裸 node 栈）；
  //   `--ref --bogusflag` 里那个拼错的 flag 被当成 ref 值，未知 flag 一次都没报。
  // 凡以 `--` 开头一律按「缺值」处理即可：本仓库的 target id / tag / commit 都不以 `--`
  // 开头，而拒绝的代价（退出码 1 + 明确提示）远小于把拼错的 flag 当数据用。
  const VALUE_FLAGS = ['--target', '--baseline', '--ref']
  const value = (name) => {
    const i = argv.indexOf(name)
    if (i < 0) return undefined
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) fail(1, name + ' 缺少取值\n' + USAGE)
    return v
  }

  const known = ['--list', '--dry-run', '--refresh-policy', '--target', '--baseline', '--ref', '--help']
  const unknown = argv.filter((a, i) => a.startsWith('--') && !known.includes(a) && !(i > 0 && VALUE_FLAGS.includes(argv[i - 1])))

  // 每个模式**真正消费**哪些带取值的 flag。其余带取值的 flag 一律 fail(1)。
  //
  // 为什么不能只是「不管它」：静默忽略用户**显式给出**的取值，会让他以为命令是按那个值跑的。
  // 实测（`--baseline`）：`--list --baseline <sha>`、`--dry-run --baseline <sha>`、
  // 以及不带 `--refresh-policy` 的同步，三条路径都是退出码 0 而该 sha 一次都不出现；
  // `--refresh-policy --ref <tag>` 同理（该模式不读 --ref）。这是「静默丢掉输入」，
  // 与「缺少取值就报错」是同一类问题的两端，必须一起收口。
  //
  // `--list` 是 §7.1 冻结的例外：它按定义列出**所有** target，`--target` 对它无意义但
  // 也不算错（有人拿它当「我只关心这个」的注释）。不因它报错，见下方 --list 分支。
  const CONSUMED = {
    '--list': [],
    '--dry-run': ['--target', '--ref'],
    '--refresh-policy': ['--target', '--baseline'],
    sync: ['--target', '--ref'],
  }
  const rejectUnconsumed = (mode) => {
    const allowed = mode === '--list' ? ['--target'] : []
    for (const f of VALUE_FLAGS) {
      if (CONSUMED[mode].includes(f) || allowed.includes(f)) continue
      const v = value(f)
      if (v === undefined) continue
      fail(
        1,
        f + ' ' + v + ' 对「' + (mode === 'sync' ? '同步' : mode) + '」无意义 —— 该模式不消费它，' +
          '继续跑会静默丢掉你给的取值。\n' + USAGE,
      )
    }
  }
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
    rejectUnconsumed('--list')
    // 计划 §7.1 把 `--list` 定义为「列出**所有**发现的 target」——它刻意不是 `--target` 的
    // 过滤器（`--target` 的语义是「只同步该目标」，对只读的 --list 不适用）。
    // 不要为了让 `--list --target <id>` 「看起来生效」而改这里：那会改动 §7.1 的冻结语义。
    log('[sync-upstream] ' + all.length + ' target(s)：')
    for (const t of all) {
      log(
        '  ' + t.id.padEnd(18) + t.prefix.padEnd(32) + t.baseline.padEnd(10) +
          'owned=' + t.owned.length + ' deleted=' + t.deleted.length + ' added=' + t.added.length +
          '  ' + t.url,
      )
    }
    return
  }

  // --dry-run 必须**先于** --refresh-policy 判定：dry-run 的契约是「看计划，零写入」，
  // 而 --refresh-policy 会写回 policy 文件。实测 `--refresh-policy --dry-run` 照样重写
  // policy（owned 从 1 变 12），与 USAGE 与 AGENTS.md 对 dry-run 的承诺矛盾。
  if (flag('--dry-run')) {
    const ref = value('--ref')
    // 同时给了 --refresh-policy 时按 dry-run 处理（零写入）。--baseline 由 rejectUnconsumed
    // 直接拒绝（dry-run 不消费它），所以这里不必再解释「被忽略」——它根本不会走到这。
    if (flag('--refresh-policy')) log('[sync-upstream] --dry-run 优先于 --refresh-policy：不写盘。')
    rejectUnconsumed('--dry-run')
    for (const t of selected) dryRunOne(t, ref)
    return
  }

  if (flag('--refresh-policy')) {
    const baseline = value('--baseline')
    rejectUnconsumed('--refresh-policy')
    for (const t of selected) {
      const commit = baseline ?? t.baselineCommit
      if (typeof commit !== 'string' || commit === '') {
        fail(1, '--refresh-policy 需要 --baseline <commit>，或在 policy 里写 target.baselineCommit')
      }
      log('[sync-upstream] ================= ' + t.id + ' =================')
      // computeLists 读 `git ls-tree <commit>`：commit 无效（打错的 sha）或不在本地历史里
      // （**浅克隆**里 policy 的 baselineCommit 就取不到）都会抛。AGENTS.md 把
      // `--refresh-policy` 列为推荐补救命令，所以这条路径必须给退出码 3 而不是裸 node 栈。
      try {
        refreshPolicy(t, commit)
      } catch (err) {
        gitFailure(
          err,
          '无法按 ' + commit + ' 重算 ' + t.prefix + '/sync-policy.json —— ' +
            '该 commit 不在本地对象库里（浅克隆常见）。用 --baseline <commit> 指定一个本地可达的 commit。',
        )
      }
    }
    return
  }

  rejectUnconsumed('sync')
  const ref = value('--ref')

  if (selected.length === 1) {
    syncOne(selected[0], ref)
    return
  }

  // 全部目标：每个从同一基点各开一条分支（互不冲突：各自只碰自己的 prefix），
  // 跑完回到原分支。任一目标失败即停止，分支留在原地供检查。
  //
  // `symbolic-ref -q --short HEAD` 在 **detached HEAD** 上退出码为 1（这是 -q 的语义：
  // 「没有分支名」不是错误）。直接调用会抛，异常穿透 main() 变成裸 node 栈 + 退出码 1，
  // 违反 §7.3 的「git 失败 = 3」。用 gitAllowStatus1 把它当作「无分支名」处理。
  let originalBranch = ''
  let baseCommit = ''
  try {
    originalBranch = gitAllowStatus1(['symbolic-ref', '-q', '--short', 'HEAD']).trim()
    baseCommit = git(['rev-parse', 'HEAD']).trim()
  } catch (err) {
    gitFailure(err, '无法确定当前基点，未改动任何分支。')
  }
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
