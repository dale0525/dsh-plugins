/**
 * publish 计划解析测试：scripts/publish.mjs 的 resolvePublishPlan 契约。
 *
 * 发布顺序是硬约束：聚合包依赖子插件，子插件必须先上线，否则聚合包安装时
 * 解析不到依赖版本。顺序由 package.json 的 dependencies 边推导，不写死包名 ——
 * 后续新增子插件/聚合包时无需改本脚本。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolvePublishPlan, REPO_ROOT } from './publish.mjs'

/** 造一棵最小 packages/ 树：{ '<dir>': { name, version, dependencies?, private? } } */
async function fixture(spec) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-publish-plan-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'root', version: '0.0.0', private: true }))
  for (const [dir, pkg] of Object.entries(spec)) {
    const abs = join(root, 'packages', dir)
    await mkdir(abs, { recursive: true })
    await writeFile(join(abs, 'package.json'), JSON.stringify(pkg))
  }
  return root
}

test('真实仓库：子插件先于聚合包发布', () => {
  const plan = resolvePublishPlan(REPO_ROOT)
  const names = plan.map((p) => p.name)
  assert.deepEqual(
    names,
    ['@logictan/dsh-config-manager', '@logictan/dsh-plugins-all'],
    '聚合包依赖子插件，顺序必须是 子插件 → 聚合包',
  )
  for (const p of plan) {
    assert.ok(p.version.length > 0, p.name + ' 必须有 version')
    assert.ok(p.dir.startsWith(join(REPO_ROOT, 'packages')), p.dir + ' 必须在 packages/ 下')
    assert.ok(existsSync(join(p.dir, 'package.json')), p.dir + ' 必须有 package.json')
  }
})

test('private 包被排除（根包与任何 private 成员）', async () => {
  const root = await fixture({
    child: { name: '@x/child', version: '1.0.0' },
    hidden: { name: '@x/hidden', version: '1.0.0', private: true },
  })
  try {
    const names = resolvePublishPlan(root).map((p) => p.name)
    assert.deepEqual(names, ['@x/child'], 'private:true 不得进入发布计划')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('按依赖拓扑排序，而非目录名/字母序', async () => {
  // 目录名 aaa 是聚合包、依赖 zzz 子插件：字母序会先发 aaa（错），拓扑必须 zzz 先
  const root = await fixture({
    aaa: { name: '@x/agg', version: '1.0.0', dependencies: { '@x/leaf': '^1.0.0' } },
    zzz: { name: '@x/leaf', version: '1.0.0' },
  })
  try {
    const names = resolvePublishPlan(root).map((p) => p.name)
    assert.deepEqual(names, ['@x/leaf', '@x/agg'], '依赖方必须排在被依赖方之后')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('多层依赖链按序；无依赖关系时按包名稳定排序', async () => {
  const root = await fixture({
    c: { name: '@x/c', version: '1.0.0' },
    a: { name: '@x/a', version: '1.0.0' },
    b: { name: '@x/b', version: '1.0.0', dependencies: { '@x/a': '^1.0.0' } },
  })
  try {
    const names = resolvePublishPlan(root).map((p) => p.name)
    assert.deepEqual(names, ['@x/a', '@x/b', '@x/c'], 'a 先于 b；a/b 与 c 之间按名排序')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('外部依赖（非本仓库包）不构成顺序约束', async () => {
  const root = await fixture({
    one: { name: '@x/one', version: '1.0.0', dependencies: { lodash: '^4.0.0', 'js-yaml': '^5.0.0' } },
    two: { name: '@x/two', version: '1.0.0' },
  })
  try {
    const names = resolvePublishPlan(root).map((p) => p.name)
    assert.deepEqual(names, ['@x/one', '@x/two'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('循环依赖 → 抛错（不得静默给出错误顺序）', async () => {
  const root = await fixture({
    x: { name: '@x/x', version: '1.0.0', dependencies: { '@x/y': '^1.0.0' } },
    y: { name: '@x/y', version: '1.0.0', dependencies: { '@x/x': '^1.0.0' } },
  })
  try {
    assert.throws(() => resolvePublishPlan(root), /circular|cycle|循环/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('缺 name/version 的 package.json → 报错而非静默跳过', async () => {
  const root = await fixture({ broken: { description: 'no name or version' } })
  try {
    assert.throws(() => resolvePublishPlan(root), /name|version/i)
  } finally { await rm(root, { recursive: true, force: true }) }
})
