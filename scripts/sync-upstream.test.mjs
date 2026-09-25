// sync-upstream.mjs 的契约：它是**只读**的，且挑 tag / 读 policy 的判据可被独立钉住。

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compareTags, discoverTargets, pickLatestTag } from './sync-upstream.mjs'

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
  // lastSynced() 里就有 'git-subtree-dir: ' 这个**grep 模式**，它不写任何东西。
  for (const forbidden of ['pull', 'checkout', 'rm', 'commit', 'merge', 'add', 'reset', 'subtree']) {
    assert.equal(source.includes("['" + forbidden + "'"), false, '脚本不应调用 git ' + forbidden)
  }
})
