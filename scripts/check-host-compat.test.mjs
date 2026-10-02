// check-host-compat.mjs 的契约：只读、判据与宿主门禁逐字一致、能挡住真实故障。

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { duplicateRowIds, hostRuntimeDependencies, isHostPackage, readManifests, readRowIds } from './check-host-compat.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SCRIPT = join(HERE, 'check-host-compat.mjs')

/** 本机有没有宿主。R2 只在有宿主时才能被验证；没有时如实跳过，不假装通过。 */
const HAS_HOST = (() => {
  try {
    return execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim() !== ''
  } catch {
    return false
  }
})()

function runAt(script, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
  }
}

const run = (args = []) => runAt(SCRIPT, args)

/** 搭一个临时仓库（只含脚本与给定的 packages/），用来注入故障。 */
function withTempRepo(packages, body) {
  const root = mkdtempSync(join(tmpdir(), 'host-compat-'))
  try {
    mkdirSync(join(root, 'scripts'), { recursive: true })
    copyFileSync(SCRIPT, join(root, 'scripts', 'check-host-compat.mjs'))
    for (const [dir, manifest] of Object.entries(packages)) {
      mkdirSync(join(root, 'packages', dir), { recursive: true })
      writeFileSync(join(root, 'packages', dir, 'package.json'), JSON.stringify(manifest))
    }
    return body(join(root, 'scripts', 'check-host-compat.mjs'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('isHostPackage 只认宿主命名空间，不误伤第三方', () => {
  assert.equal(isHostPackage('@deepseek-ai/dsh'), true)
  assert.equal(isHostPackage('@deepseek-ai/dsh-mcp-client'), true)
  assert.equal(isHostPackage('@deepseek-ai/schemastery'), false)
  assert.equal(isHostPackage('@logictan/dsh-plugins-all'), false)
  assert.equal(isHostPackage('dsh-utils'), false)
})

test('hostRuntimeDependencies 只挑 dependencies 里的宿主包', () => {
  const m = {
    dependencies: { '@deepseek-ai/dsh-mcp-client': '^0.1.6-alpha.2', '@trycua/cua-driver': '0.28.0' },
    peerDependencies: { '@deepseek-ai/dsh-llm': '^0.2.0-rc.2' },
    devDependencies: { '@deepseek-ai/dsh-tools': '0.1.2-alpha.2' },
  }
  assert.deepEqual(hostRuntimeDependencies(m), [['@deepseek-ai/dsh-mcp-client', '^0.1.6-alpha.2']])
})

test('hostRuntimeDependencies 对无 dependencies 的 manifest 返回空', () => {
  assert.deepEqual(hostRuntimeDependencies({}), [])
  assert.deepEqual(hostRuntimeDependencies({ dependencies: {} }), [])
})

test('readRowIds 只认 "- id:" 行，忽略 config 里嵌套的 id 与注释掉的行', () => {
  const patch = [
    'plugins:',
    '  - id: alpha',
    "    name: '@logictan/alpha'",
    '    config:',
    '      id: nested-not-a-row',
    '#   - id: commented-out',
    '  - id: beta',
    "    name: '@logictan/beta'",
  ].join('\n')
  assert.deepEqual(readRowIds(patch), ['alpha', 'beta'])
})

test('readRowIds 容忍不同缩进（真实聚合 patch 里既有 0 缩进也有 4 缩进的行）', () => {
  const patch = ['- id: flush-left', '    - id: indented'].join('\n')
  assert.deepEqual(readRowIds(patch), ['flush-left', 'indented'])
})

test('readRowIds 剥掉 YAML 引号与行尾注释 —— 漏掉它们就是漏报重复（假绿）', () => {
  // 这几种写法经宿主自己的 YAML 解析都是同一个行 id：只认裸字符类会把重复漏成 OK。
  const patch = ['- id: "alpha"', "- id: 'alpha'", '- id: alpha # note'].join('\n')
  assert.deepEqual(readRowIds(patch), ['alpha', 'alpha', 'alpha'])
})

test('duplicateRowIds 报出重复项与次数，唯一时为空', () => {
  assert.deepEqual(duplicateRowIds(['a', 'b', 'c']), [])
  assert.deepEqual(duplicateRowIds(['a', 'b', 'a']), [['a', 2]])
})

test('readManifests 读遍 packages/*/package.json，跳过没有 manifest 的目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-compat-'))
  try {
    mkdirSync(join(root, 'one'))
    mkdirSync(join(root, 'two'))
    mkdirSync(join(root, 'no-manifest'))
    writeFileSync(join(root, 'one', 'package.json'), JSON.stringify({ name: 'one', version: '1.0.0' }))
    writeFileSync(join(root, 'two', 'package.json'), JSON.stringify({ name: 'two', version: '2.0.0' }))
    const found = readManifests(root)
    assert.deepEqual(found.map((m) => m.dir), ['one', 'two'])
    assert.equal(found[0].manifest.name, 'one')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('回归：dsh-desktop-agent 曾把 dsh-mcp-client 写进 dependencies，令 mcp-stitch 被禁用', () => {
  // 用内联 fixture 而不是 `git show <rev>`：CI 的 actions/checkout 默认 fetch-depth: 1，
  // 浅克隆里读不到历史提交，那种写法会在 CI 直接失败。
  // 下面这份 manifest 逐字取自修复前（提交 29460a295 的父提交）的 dependencies。
  const before = {
    name: '@logictan/dsh-desktop-agent',
    version: '0.1.3',
    dependencies: { '@deepseek-ai/dsh-mcp-client': '^0.1.6-alpha.2', '@trycua/cua-driver': '0.28.0' },
  }
  assert.deepEqual(hostRuntimeDependencies(before), [['@deepseek-ai/dsh-mcp-client', '^0.1.6-alpha.2']])

  // 修复后必须干净——这正是那次改动的验收判据。
  const after = JSON.parse(readFileSync(join(REPO, 'packages', 'dsh-desktop-agent', 'package.json'), 'utf8'))
  assert.deepEqual(hostRuntimeDependencies(after), [])
})

test('聚合 patch 的行 id 等于各子插件自己 patch 的行 id 顺次拼接，且无重复', () => {
  // 不写死行数：行数随子插件增减而变，写死会逼出与改动无关的编辑。
  // 真正的不变量是「聚合 patch 逐字拼接各子插件的行」。
  const aggregateYml = readFileSync(join(REPO, 'packages', 'all', 'aggregate.yml'), 'utf8')
  const expected = []
  let inPatchFrom = false
  for (const line of aggregateYml.split('\n')) {
    if (line.startsWith('patchFrom:')) {
      inPatchFrom = true
      continue
    }
    if (line.length > 0 && line[0] !== ' ' && line[0] !== '\t') {
      inPatchFrom = false
      continue
    }
    if (!inPatchFrom) continue
    const entry = line.trim()
    if (!entry.startsWith('- ../')) continue
    const pkg = entry.slice(5)
    expected.push(...readRowIds(readFileSync(join(REPO, 'packages', pkg, 'cordis.patch.yml'), 'utf8')))
  }
  assert.ok(expected.length > 0, 'aggregate.yml 的 patchFrom 不应为空')

  const actual = readRowIds(readFileSync(join(REPO, 'packages', 'all', 'cordis.patch.yml'), 'utf8'))
  assert.deepEqual(actual, expected)
  assert.deepEqual(duplicateRowIds(actual), [])
})

test('R1 不需要宿主：无宿主的 CI 上也会报出宿主包误写 dependencies', () => {
  withTempRepo({ bad: { name: 'bad', version: '1.0.0', dependencies: { '@deepseek-ai/dsh-mcp-client': '^0.1.6-alpha.2' } } }, (script) => {
    const result = runAt(script)
    assert.equal(result.code, 1)
    assert.ok(result.stdout.includes('R1 宿主包误写 dependencies：1 处'), result.stdout)
    assert.ok(result.stdout.includes('bad'), result.stdout)
  })
})

test('R2 会拒绝 peer 范围不接受当前宿主的包', { skip: HAS_HOST ? false : '本机无宿主，R2 无法验证' }, () => {
  withTempRepo({ stale: { name: 'stale', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-llm': '^0.0.1' } } }, (script) => {
    const result = runAt(script)
    assert.equal(result.code, 1)
    assert.ok(result.stdout.includes('R2 peer 不接受当前宿主：1 处'), result.stdout)
    assert.ok(result.stdout.includes('stale'), result.stdout)
  })
})

test('R2 遇到门禁抛异常的畸形 manifest 时，仍把其余包查完', () => {
  // 宿主门禁对 peer 值非字符串会抛；不接住它，整轮扫描中断、已查出的问题一个字都打不出来。
  withTempRepo({
    'aaa-good': { name: 'aaa-good', version: '1.0.0', dependencies: { '@deepseek-ai/dsh-mcp-client': '^0.1.6-alpha.2' } },
    'zzz-bad': { name: 'zzz-bad', version: '1.0.0', peerDependencies: { '@deepseek-ai/dsh-llm': null } },
  }, (script) => {
    const result = runAt(script)
    assert.equal(result.code, 1)
    assert.ok(result.stdout.includes('aaa-good'), 'aaa-good 的结论被异常吞掉了：' + result.stdout)
    assert.ok(result.stdout.includes('R1 宿主包误写 dependencies：1 处'), result.stdout)
  })
})

test('健康仓库上的实际运行以退出码 0 通过', () => {
  const result = run()
  assert.equal(result.code, 0, '本仓库当前应无兼容问题：' + result.stdout + result.stderr)
  // 不写死行数：行数随子插件增减而变，写死会逼出与改动无关的编辑。
  const r4 = /R4 聚合 patch 行 id：(\d+) 行，(\d+) 唯一，重复 0/.exec(result.stdout)
  assert.ok(r4 !== null, result.stdout)
  assert.equal(r4[1], r4[2], '行数应等于唯一数（无重复）')
  assert.match(result.stdout, /R1 宿主包误写 dependencies：0 处/)
  if (HAS_HOST) {
    assert.match(result.stdout, /R2 peer 不接受当前宿主：0 处/)
  } else {
    assert.ok(result.stdout.includes('R2 跳过'), result.stdout)
    assert.ok(result.stdout.includes('未检查'), result.stdout)
  }
})

test('脚本是只读的：只 import 只读的 fs API，且跑完不改变工作区与历史', () => {
  // 白名单而非黑名单：黑名单只对字面量敏感，一个用双引号调用 git、或改用
  // appendFileSync 的脚本能原样通过「不含 writeFileSync」这类断言。
  const source = readFileSync(SCRIPT, 'utf8')
  const bindings = []
  for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs'/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim()
      if (name !== '') bindings.push(name)
    }
  }
  assert.deepEqual(bindings, ['existsSync', 'readFileSync', 'readdirSync', 'realpathSync'])

  // 行为断言：跑一次，工作区 / HEAD / stash 都不能变。
  const snapshot = () => ({
    status: execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }),
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }),
    stashes: execFileSync('git', ['stash', 'list'], { cwd: REPO, encoding: 'utf8' }),
  })
  const before = snapshot()
  run()
  assert.deepEqual(snapshot(), before)
})
