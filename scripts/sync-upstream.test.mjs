// sync-upstream.mjs 的契约：它是**只读**的，且挑 tag / 读 policy 的判据可被独立钉住。

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyConflicts, compareTags, discoverTargets, gitCapture, parseMergeTree, pickLatestTag, syncRef } from './sync-upstream.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'sync-upstream.mjs')

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

function tempRepo(build) {
  const root = mkdtempSync(join(tmpdir(), 'sync-upstream-'))
  mkdirSync(join(root, 'packages'), { recursive: true })
  build(root)
  return root
}

test('compareTags 按语义版本排序，预发布小于同号正式版', () => {
  assert.ok(compareTags('v1.2.3', 'v1.2.4') < 0)
  assert.ok(compareTags('v1.10.0', 'v1.9.9') > 0)
  assert.ok(compareTags('v1.0.0-rc.1', 'v1.0.0') < 0)
  assert.ok(compareTags('v1.0.0-alpha.2', 'v1.0.0-alpha.10') < 0)
  assert.equal(compareTags('v1.0.0', 'v1.0.0'), 0)
})

test('pickLatestTag 取版本号最高的 tag，忽略非版本 tag', () => {
  const lines = [
    'aaaa refs/tags/v1.2.3',
    'bbbb refs/tags/v1.10.0',
    'cccc refs/tags/nightly',
    'dddd refs/tags/v1.10.0^{}',
    'eeee refs/tags/v1.9.9',
  ]
  assert.equal(pickLatestTag(lines), 'v1.10.0')
  assert.equal(pickLatestTag(['aaaa refs/tags/nightly']), null)
  assert.equal(pickLatestTag([]), null)
})

test('discoverTargets 只认 packages/<dir>/upstream.json，并校验 id/url/prefix', () => {
  const root = tempRepo((r) => {
    mkdirSync(join(r, 'packages', 'demo'))
    writeFileSync(join(r, 'packages', 'demo', 'upstream.json'), JSON.stringify({ id: 'demo', url: 'https://example.test/demo.git', prefix: 'packages/demo' }))
    mkdirSync(join(r, 'packages', 'plain'))
    writeFileSync(join(r, 'packages', 'plain', 'package.json'), '{}')
  })
  try {
    assert.deepEqual(discoverTargets(root), [{ id: 'demo', url: 'https://example.test/demo.git', prefix: 'packages/demo', dir: 'demo' }])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('discoverTargets 拒绝 prefix 与目录不符的 policy', () => {
  const root = tempRepo((r) => {
    mkdirSync(join(r, 'packages', 'demo'))
    writeFileSync(join(r, 'packages', 'demo', 'upstream.json'), JSON.stringify({ id: 'demo', url: 'u', prefix: 'packages/other' }))
  })
  try { assert.throws(() => discoverTargets(root), /prefix/) } finally { rmSync(root, { recursive: true, force: true }) }
})

test('--changed 缺 id / 未知 id / 未知 flag 都以退出码 1 失败', () => {
  assert.equal(run(['--changed']).code, 1)
  assert.equal(run(['--changed', '--list']).code, 1)
  assert.equal(run(['--changed', 'no-such-target']).code, 1)
  assert.equal(run(['--bogus']).code, 1)
})

test('--help 打印用法并退出码 0', () => {
  const result = run(['--help'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /--changed <id>/)
})

test('脚本是只读的：不存在任何写工作区或写历史的 git 调用', () => {
  const source = readFileSync(SCRIPT, 'utf8')
  // 判据是「参数数组的第一个元素」，不是「源码里出现过这个词」——
  // 文件头注释里就有 'git subtree pull' 这句话，它不执行任何东西。
  for (const forbidden of ['pull', 'checkout', 'rm', 'commit', 'merge', 'add', 'reset', 'subtree']) {
    assert.equal(source.includes("['" + forbidden + "'"), false, '脚本不应调用 git ' + forbidden)
  }
})

// 下面几条钉住 --preflight 的判据。输入逐字取自**真实**的 merge-tree 输出
// （bre v0.5.2 与 workbuddy v0.7.1 两次真同步），不是构造的样本。

test('parseMergeTree 从消息区取冲突，只认带类型的行，不把「可能该移动」的路径算成冲突', () => {
  const out = [
    'a8f9e80180981c777e54087c6174b34ee840a9ad',
    '    packages/dsh-better-reasoning-effort/README.md',
    '    packages/dsh-better-reasoning-effort/tests/metadata.spec.ts',
    '',
    'CONFLICT (content): Merge conflict in packages/dsh-better-reasoning-effort/README.md',
    'CONFLICT (modify/delete): packages/dsh-better-reasoning-effort/package-lock.json deleted in 48a3a80a790937332038ede8c3e75fd6e467a32c and modified in 52b584ce5946c8762f16dc77178eb76356130acf.  Version 52b584ce5946c8762f16dc77178eb76356130acf of packages/dsh-better-reasoning-effort/package-lock.json left in tree.',
    'CONFLICT (rename/delete): lib/host-heartbeat-D9DvyLWz.js renamed to lib/host-heartbeat-L93zSVB5.js in 390582e04da4e8e8bf746d71997440e4b716ec47, but deleted in 08d8edaf5c644ff236e64c4989a8af710cae8117.',
  ].join('\n')
  const parsed = parseMergeTree(out)
  assert.deepEqual(parsed, [
    { kind: 'content', path: 'packages/dsh-better-reasoning-effort/README.md', deletedBy: null },
    { kind: 'modify/delete', path: 'packages/dsh-better-reasoning-effort/package-lock.json', deletedBy: '48a3a80a790937332038ede8c3e75fd6e467a32c' },
    { kind: 'rename/delete', path: 'lib/host-heartbeat-L93zSVB5.js', deletedBy: '08d8edaf5c644ff236e64c4989a8af710cae8117' },
  ])
  assert.equal(parsed.some((c) => c.path.endsWith('metadata.spec.ts')), false)
})

test('classifyConflicts 按路径去重，把我方故意删除的归为机械、其余归为需人工', () => {
  const ours = 'a'.repeat(40)
  const split = classifyConflicts([
    { kind: 'content', path: 'README.md', deletedBy: null },
    { kind: 'modify/delete', path: 'package-lock.json', deletedBy: ours },
    // 上游先改名、我们又删了目标名：同一路径会以两种形态出现，不能报两遍。
    { kind: 'rename/delete', path: 'package-lock.json', deletedBy: ours },
    // 上游删、我们改 —— 不是我方删除，仍需人工。
    { kind: 'modify/delete', path: 'src/index.ts', deletedBy: 'b'.repeat(40) },
  ], ours)
  assert.deepEqual(split.mechanical.map((c) => c.path), ['package-lock.json'])
  assert.deepEqual(split.judgment.map((c) => c.path).sort(), ['README.md', 'src/index.ts'])
})

test('predictConflicts 带 -X subtree：不把「前缀错位」误报成冲突', () => {
  // 这是本次改动里唯一**载荷性**的 git 参数。实测（bre v0.5.2）：不带它会把
  // 前缀错位造成的 rename/delete 误报成 3 处假冲突。所以必须用一个真会区分两者的仓库钉住它。
  //
  // 造法：上游 v1 时把文件放在**仓库根**，我们 subtree add 后改的是**前缀下**的副本；
  // 以上游 v1 为 merge-base 时，naive 合并会以为「我们删了根的 src/a.ts」而报 modify/delete，
  // -X subtree=<prefix> 则正确地把根的路径重定位到前缀下，只报真正的内容冲突。
  const repo = mkdtempSync(join(tmpdir(), 'dsh-subtree-'))
  const up = join(repo, 'up')
  const main = join(repo, 'main')
  mkdirSync(join(up, 'src'), { recursive: true })
  mkdirSync(main, { recursive: true })
  const g = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    g(up, ['init', '-q', '-b', 'main', '.'])
    g(up, ['config', 'user.email', 't@t'])
    g(up, ['config', 'user.name', 't'])
    writeFileSync(join(up, 'src', 'a.ts'), 'v1\n')
    writeFileSync(join(up, 'README.md'), 'v1\n')
    g(up, ['add', '-A'])
    g(up, ['commit', '-qm', 'v1'])
    const up1 = g(up, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(up, 'src', 'a.ts'), 'v2\n')
    writeFileSync(join(up, 'README.md'), 'v2\n')
    g(up, ['commit', '-qam', 'v2'])
    const up2 = g(up, ['rev-parse', 'HEAD']).trim()

    g(main, ['init', '-q', '-b', 'main', '.'])
    g(main, ['config', 'user.email', 't@t'])
    g(main, ['config', 'user.name', 't'])
    writeFileSync(join(main, 'host.ts'), 'host\n')
    g(main, ['add', '-A'])
    g(main, ['commit', '-qm', 'host'])
    g(main, ['remote', 'add', 'up', up])
    g(main, ['fetch', '-q', '--no-tags', 'up', '+refs/heads/main:refs/remotes/up/main'])
    g(main, ['subtree', 'add', '--prefix=packages/p', 'up/main', '-m', 'adopt'])
    writeFileSync(join(main, 'packages', 'p', 'src', 'a.ts'), 'ours\n')
    g(main, ['commit', '-qam', 'ours edit'])
    const ours = g(main, ['rev-parse', 'HEAD']).trim()

    const runMergeTree = (extra) => {
      const out = gitCapture(['merge-tree', '--write-tree', '--name-only', ...extra, '--merge-base=' + up1, ours, up2], { cwd: main })
      return parseMergeTree(out.stdout).map((c) => c.path)
    }
    const naive = runMergeTree([])
    const scoped = runMergeTree(['-X', 'subtree=packages/p'])

    // 不带 -X subtree：前缀错位制造假冲突（根的 src/a.ts / README.md 被当成「我方删除」）。
    assert.equal(naive.includes('src/a.ts'), true, 'naive 合并应因前缀错位而误报 src/a.ts')
    assert.equal(naive.includes('README.md'), true, 'naive 合并应因前缀错位而误报 README.md')
    // 带 -X subtree：只剩真正的内容冲突，且路径落在前缀下。
    assert.deepEqual(scoped, ['packages/p/src/a.ts'])
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('syncRef 不复用上游 tag 名（本仓发布 tag 也叫 v0.5.2，复用即 clobber 失败）', () => {
  const ref = syncRef('better-reasoning-effort')
  assert.equal(ref, 'refs/dsh-sync/better-reasoning-effort')
  assert.equal(ref.includes('v0.5.2'), false)
})

test('--preflight 缺 id / 未知 id 都以退出码 1 失败', () => {
  assert.equal(run(['--preflight']).code, 1)
  assert.equal(run(['--preflight', '--list']).code, 1)
  assert.equal(run(['--preflight', 'no-such-target']).code, 1)
})

test('--preflight 对已同步的目标如实报告，不臆造冲突', () => {
  const result = run(['--preflight', 'better-reasoning-effort'])
  assert.equal(result.code, 0)
  // CI 的 checkout 是浅克隆（fetch-depth 默认 1），此时读不到共同祖先。正确行为是
  // **如实说读不到**并指向 --unshallow，而不是把「历史没拉下来」当成冲突报出来。
  if (result.stdout.includes('浅克隆')) {
    assert.match(result.stdout, /fetch --unshallow/)
    assert.equal(result.stdout.includes('需人工裁定'), false, '浅克隆不得臆造冲突')
    return
  }
  assert.match(result.stdout, /已同步/)
})
