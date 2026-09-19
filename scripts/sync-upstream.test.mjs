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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
 */
test('计划 §10.3：--refresh-policy 重算后，版本常量文件仍留在 owned（修复不可被回滚）', () => {
  for (const t of discoverTargets(REPO_ROOT)) {
    if (t.id !== 'imagegen') continue
    const lists = computeLists(t, t.baselineCommit)
    assert.ok(
      lists.owned.includes('src/protocol.ts'),
      'imagegen 的 src/protocol.ts 承载 PLUGIN_VERSION，重算 owned 后必须仍被登记（否则上游 bump 版本会静默覆盖我方版本号）',
    )
  }
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
 */
test('计划 §10.3：同步后必须推进 baseline 并按新基线重算清单', () => {
  const t = discoverTargets(REPO_ROOT).find((x) => x.id === 'imagegen')
  const upstreamRef = 'v1.6.0'
  const upstreamCommit = 'ce478fe7cccdcb84ff12169a11ac3b08895e22ae'

  const next = advanceBaseline(t, upstreamRef, upstreamCommit)

  assert.equal(next.target.baseline, upstreamRef, 'baseline 必须推进到本次同步的上游 tag')
  assert.equal(next.target.baselineCommit, upstreamCommit, 'baselineCommit 必须推进到本次同步的上游 commit')

  // 清单必须按**新基线**重算，而不是沿用旧基线的结果
  const fresh = computeLists(t, upstreamCommit)
  assert.deepEqual(next.owned, fresh.owned, 'owned 必须按新基线重算')
  assert.deepEqual(next.deleted, fresh.deleted, 'deleted 必须按新基线重算')
  assert.deepEqual(next.added, fresh.added, 'added 必须按新基线重算')

  // 新基线下仍须保住版本常量文件（§10.3，与 Defect B 同一条契约）
  assert.ok(next.owned.includes('src/protocol.ts'), 'protocol.ts 在新基线下仍须归我方')
  // 上游 v1.6.0 新增、我方不用的文件，按新基线应落入 deleted（§10.4）
  assert.ok(
    next.deleted.includes('src/client/config-entry.tsx'),
    'config-entry.tsx 是上游 v1.6.0 新增、我方未引用的文件，新基线下应列入 deleted',
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
