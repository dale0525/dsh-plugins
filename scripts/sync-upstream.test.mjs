/**
 * sync-upstream 多目标契约测试：scripts/sync-upstream.mjs 的目标发现、
 * `added` 冲突检测（计划 §6.2）与依赖差异检查（计划 §10.2）。
 *
 * 这些不是「防御性」测试，而是三处**静默故障**的验收契约：
 *  - 目标发现错了 → 某个包永远不会被同步（无声）；
 *  - `added` 路径被上游同名文件覆盖 → 我方模块被静默替换（无声）；
 *  - 上游新增依赖没被带入（package.json 在 owned 里）→ 构建/运行期才炸。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  REPO_ROOT,
  discoverTargets,
  pickLatestTag,
  addedConflicts,
  missingDependencies,
  restoreOwned,
  computeLists,
  advanceBaseline,
} from './sync-upstream.mjs'

const EXPECTED_IDS = ['config-manager', 'easyrewrite', 'imagegen', 'market', 'workbuddy']

/** 递归列出包内源文件；跳过 node_modules 与构建产物目录（产物里到处是版本字符串，会误报）。 */
function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else out.push(full)
  }
  return out
}

/**
 * imagegen 的**合成上游树**夹具（可复现：固定 ident 与时间）。
 *
 * 三个条目各自钉一条分类规则：
 *   1. `src/protocol.ts` 与我方逐字节相同 → 只能靠「承载版本常量」进 owned（Defect B）
 *   2. `package.json` 与我方不同 → 靠「内容不同」进 owned
 *   3. `src/client/config-entry.tsx` 我方没有 → 进 deleted（§10.4）
 *
 * 为什么必须合成而不是引用真实上游 commit：见下方 §10.3 基线测试的注释 ——
 * 真实上游对象不在 main 的历史里，任何克隆（尤其是 depth=1 的 CI）都取不到。
 */
function imagegenUpstreamFixture(t) {
  return makeFixtureCommit([
    { path: 'src/protocol.ts', fromHead: t.prefix + '/src/protocol.ts' },
    {
      path: 'package.json',
      content: readFileSync(join(REPO_ROOT, t.prefix, 'package.json'), 'utf8') + '\n',
    },
    { path: 'src/client/config-entry.tsx', content: 'export const ConfigEntry = () => null\n' },
  ])
}

/**
 * 在仓库对象库里合成一个「上游 commit」，只留 dangling 对象、不动任何 ref、不碰工作区。
 *
 * 为什么用 plumbing 而不是在临时仓库里 commit：`computeLists` / `advanceBaseline` 读的是
 * **REPO_ROOT 的对象库**（`git ls-tree -r -z <commit>` 在 REPO_ROOT 下跑），临时仓库里的
 * commit 在这里取不到。`GIT_INDEX_FILE` 指向临时索引即可，不必碰工作区或共享索引
 * （本仓库有并发写入者，动共享索引会互相破坏）。
 *
 * @param entries `[{ path, content }]` 或 `[{ path, fromHead }]` —— `fromHead` 是仓库内已有
 *        路径，用来复用我方 blob，从而造出「上游内容与我方逐字节相同」这条路径。
 * @returns 合成的 commit sha
 */
function makeFixtureCommit(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-fixture-'))
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') }
  const g = (...args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', env }).trim()
  try {
    g('read-tree', '--empty')
    for (const e of entries) {
      const blob = e.fromHead === undefined
        ? execFileSync('git', ['hash-object', '-w', '--stdin'], {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            env,
            input: e.content,
          }).trim()
        : g('rev-parse', 'HEAD:' + e.fromHead)
      g('update-index', '--add', '--cacheinfo', '100644,' + blob + ',' + e.path)
    }
    const tree = g('write-tree')
    // 固定 ident 与时间：合成的 commit 必须**可复现**（同一 entries 得到同一 sha），
    // 否则浅克隆里跑两次会得到不同结果，任何基于它的断言都不可靠。
    return execFileSync('git', ['commit-tree', tree, '-m', 'fixture upstream tree'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...env,
        GIT_AUTHOR_NAME: 'sync-upstream fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'sync-upstream fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_DATE: '2001-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z',
      },
    }).trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** 本仓库负责的 5 个 fork。别的会话可能再加包，所以只断言「必须包含」而非集合相等。 */
test('真实仓库：5 个 target 全部被发现，且 policy 跟随自己的包', () => {
  const targets = discoverTargets(REPO_ROOT)
  const ids = targets.map((t) => t.id)
  for (const id of EXPECTED_IDS) assert.ok(ids.includes(id), '必须发现 target ' + id)
  // 自洽性：发现结果必须恰好等于磁盘上的 policy 文件数（别的会话新增包也不会误报）
  const policyFiles = readdirSync(join(REPO_ROOT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(REPO_ROOT, 'packages', e.name, 'sync-policy.json')))
    .map((e) => e.name)
  assert.equal(targets.length, policyFiles.length, '发现数必须等于 packages/*/sync-policy.json 的数量')
  for (const t of targets) {
    assert.match(t.url, /^https:\/\//, t.id + ' 的 target.url')
    assert.ok(t.prefix.startsWith('packages/'), t.id + ' 的 target.prefix 必须在 packages/ 下')
    assert.ok(existsSync(join(REPO_ROOT, t.prefix)), t.id + ' 的 target.prefix 必须真实存在')
    assert.equal(
      t.policyPath,
      join(REPO_ROOT, t.prefix, 'sync-policy.json'),
      t.id + ' 的 policy 必须放在它描述的那个包里',
    )
    assert.ok(t.baseline, t.id + ' 必须有 target.baseline')
    assert.ok(t.baselineCommit, t.id + ' 必须有 target.baselineCommit')
    for (const key of ['owned', 'deleted', 'added']) {
      assert.ok(Array.isArray(t[key]), t.id + ' 的 ' + key + ' 必须是数组')
    }
  }
})

test('单一真源：根 sync-policy.json 已删除', () => {
  assert.ok(
    !existsSync(join(REPO_ROOT, 'sync-policy.json')),
    'policy 已拆成每包一份，根文件必须不存在（否则两套口径并存）',
  )
})

test('pickLatestTag：剥 peeled 引用，按语义版本序而非字典序', () => {
  // 输入形态 = `git ls-remote --tags` 的原始行：<sha>\trefs/tags/<tag>
  const line = (tag) => 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\trefs/tags/' + tag
  assert.equal(pickLatestTag([line('v0.1.9'), line('v0.1.10'), line('v0.1.2')]), 'v0.1.10')
  assert.equal(pickLatestTag([line('v1.0.0'), line('v0.9.9')]), 'v1.0.0')
  // peeled 引用（refs/tags/vX^{}）是同一个 tag 的注解对象指针，必须剥掉：
  // 它的数字段含 `^{}` 会解析成 NaN，使比较器失去全序性。
  assert.equal(pickLatestTag([line('v0.1.10'), line('v0.1.9^{}')]), 'v0.1.10')
  // 非 v* tag 与空输入
  assert.equal(pickLatestTag([line('release-1'), line('v2.0.0')]), 'v2.0.0')
  assert.equal(pickLatestTag([]), undefined)
})

test('addedConflicts：added 路径出现在上游侧即报出（§6.2）', () => {
  const added = ['src/self-names.ts', 'tests/self-names.spec.ts']
  assert.deepEqual(addedConflicts(added, ['src/routes.ts', 'src/self-names.ts']), ['src/self-names.ts'])
  assert.deepEqual(addedConflicts(added, ['src/routes.ts']), [])
})

test('missingDependencies：只报「上游本次新增 且 我方没有」的键（§10.2）', () => {
  const base = { dependencies: { a: '^1.0.0' } }
  const next = { dependencies: { a: '^1.0.0', b: '^2.0.0' }, peerDependencies: { c: '^3.0.0' } }
  const ours = { dependencies: { a: '^1.0.0' } }
  assert.deepEqual(missingDependencies(next, base, ours), [
    { field: 'dependencies', name: 'b' },
    { field: 'peerDependencies', name: 'c' },
  ])
})

test('missingDependencies：基线就有、我方有意去掉的键不算新增（否则永久误报）', () => {
  const base = { dependencies: { dropped: '^1.0.0' } }
  const next = { dependencies: { dropped: '^1.0.0' } }
  const ours = { dependencies: {} }
  assert.deepEqual(missingDependencies(next, base, ours), [])
})

test('missingDependencies：我方已有同名键（即使 range 不同）不算缺失', () => {
  const base = {}
  const next = { dependencies: { a: '^9.9.9' } }
  const ours = { dependencies: { a: '^1.0.0' } }
  assert.deepEqual(missingDependencies(next, base, ours), [])
})

/**
 * 计划 §10.3：`PLUGIN_VERSION` 必须与 `package.json` 的 `version` 一致，且同步**不得**改动它
 * （版本号留在我们自己的版本线上）。
 *
 * 这条契约有一个不直观的失效路径：`owned` 只登记「与基线**内容不同**」的文件，而版本常量在
 * 我方 fork 里往往**恰好等于基线**（我方版本线只是没跟着上游走）。于是它既不在 `owned`、也不在
 * `deleted`/`added`，属于**未分类**；上游一旦 bump 版本常量，它就被静默改成上游版本 —— 冲突为零、
 * 检查全绿，但 `updater` 会拿错误的 `CURRENT_VERSION` 去比较，更新提示永久失真。
 *
 * 所以判据不是「内容是否不同」，而是「该文件承载了我方不可被上游覆盖的常量」：承载版本常量的
 * 文件必须在 `owned` 里。config-manager 的 `src/index.ts` 正是这么登记的，imagegen 曾漏登记。
 */
test('计划 §10.3：承载 PLUGIN_VERSION 的文件必须登记进 owned（否则被上游静默改版本）', () => {
  const targets = discoverTargets(REPO_ROOT)
  const offenders = []
  for (const t of targets) {
    const pkgDir = join(REPO_ROOT, t.prefix)
    const pkgJsonPath = join(pkgDir, 'package.json')
    if (!existsSync(pkgJsonPath)) continue
    const version = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version
    if (typeof version !== 'string' || version === '') continue

    // 在包内找出所有写着 `...VERSION... = '<pkg version>'` 的文件（排除构建产物）
    const pattern = new RegExp('VERSION\\w*\\s*[:=]\\s*[\'"]' + version.replace(/\./g, '\\.') + '[\'"]')
    for (const rel of walkFiles(pkgDir)) {
      if (!pattern.test(readFileSync(rel, 'utf8'))) continue
      const relFromPrefix = rel.slice(pkgDir.length + 1)
      if (!t.owned.includes(relFromPrefix)) {
        offenders.push(`${t.id}: ${relFromPrefix} (version=${version}) 不在 owned 里`)
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    '承载版本常量的文件必须登记进 owned，否则上游 bump 版本时会静默覆盖我方版本号',
  )
})

/**
 * 上一条测试钉的是「磁盘上的 policy 正确」；这一条钉的是**它不会被重算冲掉**。
 *
 * `--refresh-policy` 是 AGENTS.md 明确推荐的补救命令（「改了 fork 的文件集就必须重算清单」）。
 * 若版本常量文件的归属只写在 JSON 里、而重算逻辑仍按「与基线内容不同」判定，那么下一次
 * 有人按文档跑 `--refresh-policy`，`src/protocol.ts` 就会被踢出 owned —— 修复被静默回滚，
 * 上游再 bump 一次版本就重新污染。所以归属必须由 `computeLists` 这个单一真源推导出来。
 *
 * 这里用合成夹具而非真实的 `t.baselineCommit`：上游 commit（v1.5.13 的 `5b492f9c`、
 * v1.6.0 的 `ce478fe7`）**不在 main 的历史里**（subtree 只合树、不搬上游历史），
 * 任何从远端克隆出来的仓库都没有这些对象 —— 实测浅克隆里
 * `computeLists(t, t.baselineCommit)` 直接 `fatal: not a tree object`。
 * 合成夹具的关键性质正好是这个契约要考的那条：树里的 `src/protocol.ts` 与我方**逐字节相同**。
 */
test('计划 §10.3：--refresh-policy 重算后，版本常量文件仍留在 owned（修复不可被回滚）', () => {
  const t = discoverTargets(REPO_ROOT).find((x) => x.id === 'imagegen')
  const lists = computeLists(t, imagegenUpstreamFixture(t))
  assert.ok(
    lists.owned.includes('src/protocol.ts'),
    'imagegen 的 src/protocol.ts 承载 PLUGIN_VERSION，重算 owned 后必须仍被登记（否则上游 bump 版本会静默覆盖我方版本号）',
  )
})

/**
 * 计划 §10.3：`baseline` / `baselineCommit` 是「已同步到哪个上游版本」的**唯一记录**
 * （「上游版本只记录在 policy 的 baseline / baselineCommit 里」）。
 *
 * 不推进它，下一次 `--refresh-policy`（AGENTS.md 要求「改了 fork 的文件集就必须重算清单」）
 * 就会拿**旧基线**去比：上游在新版本里合法改动的文件，与我方那份过时副本一比就「内容不同」，
 * 于是被误判成 `owned` —— 我方过时副本被永久钉住，上游在该文件里的 bug 修复再也进不来。
 * 实测：imagegen 同步到 v1.6.0 后若基线仍是 v1.5.13，`owned` 会从 12 虚增到 19。
 *
 * 同步成功后必须把基线推进到本次同步的上游版本，并按新基线重算清单。
 *
 * ## 为什么自己造一个上游 commit，而不是引用真实的 v1.6.0
 *
 * 本测试原先硬编码 `ce478fe7…`（imagegen 上游 v1.6.0）。该 commit 只在本地存在：
 * 它可达于本地 tag `v1.6.0`，但**不在 main 的历史里**（subtree 只把树合进来，不搬上游历史）。
 * `publish.yml` 的 checkout **没有 fetch-depth**（默认 depth=1），于是 CI 的浅克隆里
 * `git ls-tree -r -z ce478fe7…` 直接报 `fatal: not a tree object` —— 连 baseline 那个
 * commit 也不在。实测：`git clone --depth 1` 后 `is-shallow: true`，`ce478fe7` 与
 * `5b492f9c`（v1.5.13 基线）都取不到，而 `publish.yml` 的 `pnpm test` 会跑本文件 ⇒ 发布流程红。
 *
 * 所以夹具必须**由测试自己在对象库里造出来**（plumbing：hash-object -w / write-tree /
 * commit-tree，只留 dangling 对象，不动任何 ref），才能在任何深度的克隆里成立。
 * 这样钉住的契约反而更强：合成树里 `src/protocol.ts` 与我方**逐字节相同**，
 * 正是「版本常量恰好等于基线」这条最易漏判的路径。
 */
test('计划 §10.3：同步后必须推进 baseline 并按新基线重算清单', () => {
  const t = discoverTargets(REPO_ROOT).find((x) => x.id === 'imagegen')
  const upstreamRef = 'v9.9.9-fixture'
  const upstreamCommit = imagegenUpstreamFixture(t)

  const next = advanceBaseline(t, upstreamRef, upstreamCommit)

  assert.equal(next.target.baseline, upstreamRef, 'baseline 必须推进到本次同步的上游 tag')
  assert.equal(next.target.baselineCommit, upstreamCommit, 'baselineCommit 必须推进到本次同步的上游 commit')

  // 清单必须按**新基线**重算，而不是沿用旧基线的结果
  const fresh = computeLists(t, upstreamCommit)
  assert.deepEqual(next.owned, fresh.owned, 'owned 必须按新基线重算')
  assert.deepEqual(next.deleted, fresh.deleted, 'deleted 必须按新基线重算')
  assert.deepEqual(next.added, fresh.added, 'added 必须按新基线重算')

  // 新基线下仍须保住版本常量文件（§10.3，与 Defect B 同一条契约）
  assert.ok(
    next.owned.includes('src/protocol.ts'),
    'protocol.ts 与上游逐字节相同时仍须归我方 —— 判据是「承载版本常量」，不是「内容不同」',
  )
  assert.ok(next.owned.includes('package.json'), '与我方内容不同的上游文件必须进 owned')
  // 上游新增、我方不用的文件，按新基线应落入 deleted（§10.4）
  assert.ok(
    next.deleted.includes('src/client/config-entry.tsx'),
    'config-entry.tsx 是上游新增、我方未引用的文件，新基线下应列入 deleted',
  )
  // 同步元数据（policy 自己）不是 fork 内容：进了 added 会让 §6.2 误报冲突
  assert.ok(!next.added.includes('sync-policy.json'), 'policy 自身不得出现在 added 里')
})

test('--list 零写入，且列出全部 5 个 target', () => {
  const status = () =>
    execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
  const before = status()
  const out = execFileSync(process.execPath, ['scripts/sync-upstream.mjs', '--list'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  assert.equal(status(), before, '--list 不得改动工作区或索引')
  for (const id of EXPECTED_IDS) assert.ok(out.includes(id), '--list 必须列出 ' + id)
})

test('--dry-run --target 未知 id → 退出码 1', () => {
  assert.throws(
    () =>
      execFileSync(process.execPath, ['scripts/sync-upstream.mjs', '--dry-run', '--target', 'nope'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    (err) => err.status === 1,
  )
})

/** 跑 CLI，返回 { status, stdout, stderr }（不抛）。 */
function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, ['scripts/sync-upstream.mjs', ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    return { status: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
  }
}

/**
 * 带取值的 flag 缺值必须退出码 1，**不得**静默退化成默认行为。
 *
 * 实测的两种静默退化（都是退出码 0）：
 *   - `--dry-run --target`（无值）→ 列出**全部 5 个**目标，用户以为只看了 1 个；
 *   - `--refresh-policy --target workbuddy --baseline`（无值）→ 回退到 policy 里的旧
 *     baselineCommit 并**照常写盘**，用户以为用了自己给的基线。
 * 第二种会真的改文件，属于「看错参数就改错配置」。
 */
test('CLI：--target / --baseline 缺值 → 退出码 1（不静默退化成默认行为）', () => {
  for (const args of [
    ['--list', '--target'],
    ['--dry-run', '--target'],
    ['--dry-run', '--ref'],
    ['--refresh-policy', '--baseline'],
  ]) {
    const r = runCli(args)
    assert.equal(r.status, 1, args.join(' ') + ' 应退出码 1，实际 ' + r.status)
    assert.match(r.stderr, /缺少取值/, args.join(' ') + ' 必须说明是缺值')
  }
})

/**
 * `--list` 必须列出**全部** target（计划 §7.1 的冻结语义），**不**跟随 `--target`。
 *
 * 这条测试的存在理由：修复过程中曾把 `--list` 改成跟随 `--target`（理由是「带了筛选却列出
 * 全部，看起来像筛选没生效」），但 §7.1 把 `--list` 明确定义为「列出所有发现的 target」，
 * `--target` 的语义是「只同步该目标」—— 对只读的 `--list` 不适用。那是改动冻结契约，
 * 不是修缺陷。这条测试钉住「不要因为看着别扭就改它」。
 */
test('CLI：--list 列出全部 target，不跟随 --target（§7.1 冻结语义）', () => {
  const r = runCli(['--list', '--target', 'imagegen'])
  assert.equal(r.status, 0)
  for (const id of EXPECTED_IDS) {
    assert.ok(r.stdout.includes(id), '--list 必须列出全部 target，缺 ' + id)
  }
})

/**
 * `--dry-run` 的契约是**零写入**，它必须优先于 `--refresh-policy`（后者会写回 policy）。
 *
 * 实测（修复前）：`--refresh-policy --dry-run --target <id>` 照样重写 policy 文件
 * （owned 从 1 条被改回 12 条），与 USAGE 与 AGENTS.md 对 dry-run 的承诺矛盾。
 * 这里用「先把 owned 改坏，再断言 dry-run 没把它改回来」来钉，而不是断言退出码 ——
 * 因为 bug 的特征正是「退出码 0 且输出正常，但文件被动过」。
 */
test('CLI：--refresh-policy --dry-run 不得写盘（dry-run 优先）', () => {
  const rel = 'packages/dsh-imagegen/sync-policy.json'
  const abs = join(REPO_ROOT, rel)
  const backup = readFileSync(abs, 'utf8')
  const broken = JSON.parse(backup)
  broken.owned = ['src/protocol.ts'] // 明显不完整：真实是 12 条
  try {
    writeFileSync(abs, JSON.stringify(broken, null, 2) + '\n')
    const r = runCli(['--refresh-policy', '--dry-run', '--target', 'imagegen'])
    assert.equal(r.status, 0, 'dry-run 应当正常退出')
    assert.equal(
      JSON.parse(readFileSync(abs, 'utf8')).owned.length,
      1,
      '--dry-run 必须零写入：policy 不得被 --refresh-policy 重算并覆盖',
    )
  } finally {
    writeFileSync(abs, backup)
  }
})

/**
 * `pickLatestTag` 的比较器必须是**全序**，否则结果取决于输入顺序。
 *
 * 实测（修复前）：逐段 `Number()` 相减时，`Number('1-final')` 是 NaN，比较器返回 NaN，
 * `sort` 失去全序性 —— `['v2.3.1','v2.3.1-final']` 选出 `v2.3.1-final`，反序输入却选出
 * `v2.3.1`。上游真的同时存在这类 tag（easyrewrite 有 v2.3.1 / v2.3.1-final，
 * market 有 v1.14.0 / v1.14.0-beta.1），选错就等于同步到非正式发布。
 */
test('pickLatestTag：带后缀 tag 下仍为全序，且正式版优先', () => {
  const line = (tag) => 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\trefs/tags/' + tag
  const pick = (...tags) => pickLatestTag(tags.map(line))
  const cases = [
    ['v2.3.1', 'v2.3.1-final'],
    ['v1.14.0', 'v1.14.0-beta.1'],
    ['v1.2.3', 'v1.2.3.1'],
    ['v1.0.0', 'v1.0.0', 'v1.0.0-rc.1'],
  ]
  for (const tags of cases) {
    const forward = pick(...tags)
    const reversed = pick(...[...tags].reverse())
    assert.equal(forward, reversed, tags.join(',') + ' 的选择不得依赖输入顺序')
  }
  // 正式版优先于同核心的预发布/后缀版本
  assert.equal(pick('v2.3.1', 'v2.3.1-final'), 'v2.3.1')
  assert.equal(pick('v1.14.0', 'v1.14.0-beta.1'), 'v1.14.0')
  // 多一段数字仍是更高版本（原有行为，不得回归）
  assert.equal(pick('v1.2.3', 'v1.2.3.1'), 'v1.2.3.1')
  // 核心更大时后缀无关紧要
  assert.equal(pick('v1.9.0-beta.1', 'v1.10.0'), 'v1.10.0')
})

/**
 * 上游不可达必须走 §7.3 的退出码 3 + `[sync-upstream] ERROR` 前缀，
 * 而不是让 node 内部栈穿透出去（实测修复前：EXIT=1 + `node:internal/errors` 栈）。
 *
 * 探针在**临时仓库**里跑，并且把脚本本身也复制进去：`REPO_ROOT` 由脚本自己的位置推导
 * （`dirname(fileURLToPath(import.meta.url))/..`），复制后它就指向临时仓库 —— 否则
 * `discoverTargets()` 永远读主仓库，探针里的 target 根本不可见。
 * 不在主工作区跑，是因为那里有并发写入者，`assertCleanWorktree` 会先把它挡掉。
 */
test('CLI：上游不可达 → 退出码 3 + ERROR 前缀（不是 node 内部栈）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-cli-'))
  try {
    const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 'test@example.com')
    g('config', 'user.name', 'Test')
    const prefix = 'packages/foo'
    mkdirSync(join(dir, prefix), { recursive: true })
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    copyFileSync(
      join(REPO_ROOT, 'scripts/sync-upstream.mjs'),
      join(dir, 'scripts/sync-upstream.mjs'),
    )
    writeFileSync(join(dir, prefix, 'index.ts'), 'export const a = 1\n')
    const policy = {
      target: {
        id: 'foo',
        url: 'https://invalid.invalid/nope.git',
        prefix,
        baseline: 'v1.0.0',
        baselineCommit: 'HEAD',
      },
      owned: [],
      deleted: [],
      added: [],
    }
    writeFileSync(join(dir, prefix, 'sync-policy.json'), JSON.stringify(policy, null, 2) + '\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'init')

    let r
    try {
      const stdout = execFileSync(
        process.execPath,
        ['scripts/sync-upstream.mjs', '--target', 'foo'],
        { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      )
      r = { status: 0, stdout, stderr: '' }
    } catch (err) {
      r = { status: err.status, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') }
    }
    assert.equal(r.status, 3, 'git/网络失败必须退出码 3（实际 stderr: ' + r.stderr.slice(0, 300) + '）')
    assert.match(r.stderr, /\[sync-upstream\] ERROR/, '必须带 [sync-upstream] ERROR 前缀')
    assert.ok(
      !r.stderr.includes('node:internal'),
      '不得把 node 内部栈暴露给用户：' + r.stderr.slice(0, 300),
    )
    // 零副作用：预检失败不得留下分支
    assert.equal(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim(),
      'main',
      '预检失败必须仍在原分支',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 同步 workflow 必须跑脚本自己的契约测试。
 *
 * 为什么单独立一条：`.github/workflows/*.yml` 的改动在本地不会被任何东西执行，
 * 最容易「改了以为没事」。实测修复前 sync-upstream.yml 的 Test 步骤只跑包测试，
 * 脚本自身的契约（policy 顺序、owned 覆盖、基线推进）完全没被 CI 覆盖。
 *
 * 同时钉住「policy 校验只有一份真源」：计划 §8 原本要求在 workflow 里内联校验
 * `url`/`prefix`/`baseline` 非空，但那份内联实现与脚本的 discoverTargets 口径不一致 ——
 * 删掉 `baselineCommit` 它照样 PASS，而脚本以退出码 1 拒绝同一份 policy。
 * 改走 discoverTargets 后，两者不可能再漂移。
 */
test('workflow：sync-upstream.yml 跑脚本契约测试，且 policy 校验复用单一真源', () => {
  const yml = readFileSync(join(REPO_ROOT, '.github/workflows/sync-upstream.yml'), 'utf8')
  assert.match(yml, /node --test scripts\/sync-upstream\.test\.mjs/, '必须跑脚本自己的契约测试')
  assert.match(yml, /discoverTargets/, 'policy 校验必须复用脚本的 discoverTargets（单一真源）')
  assert.ok(
    !/const missing = \["url", "prefix", "baseline"\]/.test(yml),
    '不得在 YAML 里重抄一份 policy 字段清单（口径会与脚本漂移）',
  )
})

/**
 * 第 3 步的真正契约：`owned` 是**权威覆盖清单** —— 同步后每个 owned 路径必须与我方
 * 逐字节相同，**与 git 是否把它自动合并干净无关**。
 *
 * 为什么必须专门钉住：git 对「双方都改、但改在不同区域」的文件会干净地三方合并
 * （无冲突标记、索引里没有 stage 1/2/3）。此时 `git checkout --ours -- <path>` 是
 * **空操作**（ours/theirs 只对未合并条目生效），我方版本会静默被上游内容污染。
 * 计划 §11.2 第 3 行要求「我方 11 个 owned 文件保持我方版本」、§10.3 要求
 * `package.json` 版本号同步后仍是 `1.5.13` —— 都落在这条上。
 *
 * 这里用真实 git 复刻该场景，而不是断言实现细节。
 */
test('restoreOwned：被 git 干净合并的 owned 文件也必须还原成我方版本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-owned-'))
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  try {
    g('init', '-q', '-b', 'main')
    g('config', 'user.email', 'test@example.com')
    g('config', 'user.name', 'Test')

    const prefix = 'packages/foo'
    const ownedRel = 'pkg.json'
    const ownedPath = prefix + '/' + ownedRel
    // 第二个 owned 文件：双方改**同一行** → git 无法自动合并，留下真冲突（索引有 stage 1/2/3）。
    // 旧实现（`checkout --ours`）只在这条路径上有效，必须保证改完不回归。
    const conflictPath = prefix + '/conflict.txt'
    mkdirSync(join(dir, prefix), { recursive: true })

    // 基线：40 行，我方与上游将分别改首、尾两处 —— 相距足够远，git 会干净合并。
    const lines = (first, last) => [first, ...Array.from({ length: 38 }, (_, i) => 'line' + (i + 2)), last].join('\n') + '\n'
    const base = lines('BASE-FIRST', 'BASE-LAST')
    writeFileSync(join(dir, ownedPath), base)
    writeFileSync(join(dir, conflictPath), 'SHARED-LINE\n')
    writeFileSync(join(dir, prefix, 'upstream-only.txt'), 'upstream only\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'base')

    // 上游分支：改末行（与我方改的首行不重叠）→ 会干净合并；同时制造一处真冲突
    g('checkout', '-q', '-b', 'upstream')
    writeFileSync(join(dir, ownedPath), lines('BASE-FIRST', 'UPSTREAM-LAST'))
    writeFileSync(join(dir, conflictPath), 'UPSTREAM-CONFLICT\n')
    writeFileSync(join(dir, prefix, 'upstream-only.txt'), 'upstream v2\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'upstream')

    // 我方：改首行与冲突行，并记下这一刻 = prePullCommit
    g('checkout', '-q', 'main')
    const ours = lines('OURS-FIRST', 'BASE-LAST')
    const oursConflict = 'OURS-CONFLICT\n'
    writeFileSync(join(dir, ownedPath), ours)
    writeFileSync(join(dir, conflictPath), oursConflict)
    g('add', '-A')
    g('commit', '-q', '-m', 'ours')
    const prePullCommit = g('rev-parse', 'HEAD').trim()

    // 复刻 `git subtree pull` 的合并效果（同一三方合并语义，不引入 subtree 依赖）
    try {
      g('merge', '--no-edit', 'upstream')
      assert.fail('前置条件：conflict.txt 应当产生真冲突')
    } catch (err) {
      if (err instanceof assert.AssertionError) throw err
      // 预期：MERGE_CONFLICT
    }

    // 前置条件自检：确认这确实是「干净合并」——否则本测试没有钉住目标场景。
    const merged = readFileSync(join(dir, ownedPath), 'utf8')
    assert.ok(merged.includes('UPSTREAM-LAST'), '前置条件：上游改动应被自动合并进来')
    assert.ok(merged.includes('OURS-FIRST'), '前置条件：我方改动应被自动合并保留')
    assert.notEqual(merged, ours, '前置条件：干净合并后文件必须已不等于我方版本')

    const target = { id: 'foo', prefix, owned: [ownedRel, 'conflict.txt'], deleted: [], added: [] }
    restoreOwned(target, prePullCommit, dir)

    assert.equal(
      readFileSync(join(dir, ownedPath), 'utf8'),
      ours,
      'owned 是权威覆盖：干净合并的文件也必须逐字节还原成我方版本',
    )
    assert.equal(
      readFileSync(join(dir, conflictPath), 'utf8'),
      oursConflict,
      'owned 是权威覆盖：冲突文件同样还原成我方版本',
    )
    // 非 owned 的上游改动不受影响（第 2 步 --theirs 的成果要留住）
    assert.equal(readFileSync(join(dir, prefix, 'upstream-only.txt'), 'utf8'), 'upstream v2\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
