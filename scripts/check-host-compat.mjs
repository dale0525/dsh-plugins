#!/usr/bin/env node
// 宿主世代兼容检查（只读）。
//
// 回答一个问题：**当前机器上的宿主世代，会让本仓库哪些插件行出问题？**
//
// 这是 2026-10-02 那次宿主 0.2.0-rc.2 升级里最耗 agent 的一步：手工把 14 个包
// 逐个对着宿主的兼容门禁核一遍，再回溯「为什么 patch 行明明没钉版本却被禁用」。
// 那套判断是纯确定性的，交给脚本。
//
// 检查项（每条都指名真实已发生的故障）：
//
//   R1 宿主包写进 dependencies  -> pnpm 另装实体副本 -> 遮蔽宿主软链
//                                  -> 门禁按副本判定 -> **静默禁用该行**
//                                  （实测：dsh-desktop-agent 的 dsh-mcp-client
//                                    令全局 patch 的 mcp-stitch 行被禁用）
//   R2 peer 范围不接受当前宿主 -> 门禁拒绝 -> **静默禁用该行**
//                                  （实测：0.2.0-rc.2 升级时 6 个已发布包的
//                                    旧 manifest 被拒）
//   R4 patch 行 id 重复         -> 宿主启动**硬崩**（duplicate loader entry id）
//                                  AGENTS.md §新增子插件 把它列为「无人自动检查，
//                                  须人工核对」的手工步骤，此处接管。
//
// 判据来源：R2 直接调用**宿主自己的** evaluatePluginCompatibility，不手抄规则，
// 宿主改判据时本脚本自动跟随。
//
// 宿主不是必需的：R1 是纯 manifest 检查、R4 是纯文本检查，两者在无宿主的 CI 上照跑；
// 只有 R2 需要宿主。缺宿主时 R2 明说「未检查」，不假装通过。
//
// 有意排除的两项（附实测理由，避免日后被当成遗漏而补进来）：
//
//   - devDeps 世代滞后：会命中 4 个当前完全正常的包（agy-link / loop-guard /
//     openviking / reasoning-strip），其中 dsh-openviking 的旧世代钉法是被
//     bundle.test.mjs 冻结的**故意策略**。作为报错规则就是一台误报机器。
//   - 发布期构建钩子缺失：那是**发布**关注点（imagegen 2.0.0 空包），
//     与「宿主能否加载这一行」不是同一个问题。

import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')
const AGGREGATE_PATCH = join(PACKAGES_DIR, 'all', 'cordis.patch.yml')

/** 门禁只认 @deepseek-ai/dsh 与 @deepseek-ai/dsh-*，其余一律不看。 */
export function isHostPackage(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

/** R1：dependencies 里的宿主包。返回 [name, range] 列表。 */
export function hostRuntimeDependencies(manifest) {
  return Object.entries(manifest.dependencies || {}).filter(([name]) => isHostPackage(name))
}

/** 读所有子包的 manifest（含 private，由调用方决定是否跳过）。 */
export function readManifests(root = PACKAGES_DIR) {
  const out = []
  for (const dir of readdirSync(root).sort()) {
    const file = join(root, dir, 'package.json')
    if (!existsSync(file)) continue
    out.push({ dir, manifest: JSON.parse(readFileSync(file, 'utf8')) })
  }
  return out
}

/**
 * 从 patch 文本里取出所有**行** id。
 *
 * 判据分两步，与 aggregate.mjs 一致：
 *   1. 先按它的行判据 `/^\s*- id:/` 认行（aggregate.mjs:169 用的就是这条）；
 *   2. 再取值，并剥掉 YAML 允许的引号与行尾注释。
 *
 * 不能只认 `id:` —— 那会把插件 config 里嵌套的 `id` 当成行。
 * 也不能用严格字符类 + 行尾锚定 —— 那样 `- id: "alpha"` 与 `- id: alpha # x`
 * 会被漏掉，而这两种写法经 YAML 解析都是**同一个行 id**，漏掉即漏报重复（假绿）。
 */
export function readRowIds(text) {
  const ids = []
  for (const line of text.split('\n')) {
    if (!/^\s*- id:/.test(line)) continue
    const rest = line.replace(/^\s*- id:\s*/, '')
    let value
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const quote = rest[0]
      const end = rest.indexOf(quote, 1)
      value = end === -1 ? rest.slice(1) : rest.slice(1, end)
    } else {
      value = rest.split('#')[0].trim()
    }
    if (value !== '') ids.push(value)
  }
  return ids
}

/** R4：返回重复的 [id, 次数] 列表。 */
export function duplicateRowIds(ids) {
  const counts = new Map()
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1)
  return [...counts.entries()].filter(([, n]) => n > 1)
}

/** 找到宿主安装根。返回 null 表示本机没有宿主（CI / 干净克隆）。 */
export function discoverHost() {
  let bin
  try {
    bin = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
  if (bin === '') return null
  // <root>/lib/bin.js -> <root>
  const root = realpathSync(bin).replace(/\/lib\/bin\.js$/, '')
  if (!existsSync(join(root, 'package.json'))) return null
  return root
}

/** 载入宿主自己的门禁函数，保证判据与宿主逐字一致。 */
export function loadHostGate(hostRoot) {
  const hostRequire = createRequire(join(hostRoot, 'package.json'))
  const appBootPkg = hostRequire.resolve('@deepseek-ai/dsh-app-boot/package.json')
  const boot = createRequire(appBootPkg)('.')
  return {
    hostVersion: JSON.parse(readFileSync(join(hostRoot, 'package.json'), 'utf8')).version,
    evaluate: boot.evaluatePluginCompatibility,
  }
}

function main() {
  const problems = []
  const manifests = readManifests()

  // ---- R4：不需要宿主 ----
  if (existsSync(AGGREGATE_PATCH)) {
    const ids = readRowIds(readFileSync(AGGREGATE_PATCH, 'utf8'))
    const dups = duplicateRowIds(ids)
    for (const [id, n] of dups) {
      problems.push('R4 聚合 patch 行 id 重复：' + id + ' 出现 ' + n + ' 次 -> 宿主启动会硬崩')
    }
    console.log('R4 聚合 patch 行 id：' + ids.length + ' 行，' + new Set(ids).size + ' 唯一，重复 ' + dups.length)
  } else {
    console.log('R4 跳过：未找到 ' + AGGREGATE_PATCH)
  }

  // ---- R1：纯 manifest 检查，不需要宿主（CI 上照跑）----
  let r1 = 0
  for (const { dir, manifest } of manifests) {
    for (const [name, range] of hostRuntimeDependencies(manifest)) {
      r1++
      problems.push('R1 ' + dir + '：宿主包 ' + name + '@' + range + ' 写在 dependencies -> pnpm 会另装副本遮蔽宿主 -> 该行会被静默禁用')
    }
  }
  console.log('R1 宿主包误写 dependencies：' + r1 + ' 处')

  // ---- R2：需要宿主 ----
  const hostRoot = discoverHost()
  if (hostRoot === null) {
    console.log('R2 跳过：本机未找到 dsh 安装（无宿主可对照）')
    console.log('')
    if (problems.length === 0) {
      console.log('OK：R1/R4 通过。宿主兼容性（R2）**未检查**（本机无宿主）。')
      return 0
    }
    console.log('发现 ' + problems.length + ' 个问题：')
    for (const p of problems) console.log('  - ' + p)
    return 1
  }

  let gate
  try {
    gate = loadHostGate(hostRoot)
  } catch (error) {
    console.log('R2 跳过：宿主安装存在但门禁载入失败（' + error.message + '）')
    console.log('')
    if (problems.length === 0) {
      console.log('OK：R1/R4 通过。宿主兼容性（R2）**未检查**（门禁载入失败）。')
      return 0
    }
    console.log('发现 ' + problems.length + ' 个问题：')
    for (const p of problems) console.log('  - ' + p)
    return 1
  }
  console.log('宿主：' + hostRoot)
  console.log('世代：' + gate.hostVersion)
  let r2 = 0
  for (const { dir, manifest } of manifests) {
    // 宿主门禁对畸形 manifest 会**抛异常**（peer 值非字符串、缺 name/version 等）。
    // 不接住它，整轮扫描会在这一包中断，**已经查出的问题一个字都打不出来** ——
    // 而「缺 version」恰恰会与「peer 不兼容」同时发生，正是本脚本要报的场景。
    let verdict
    try {
      verdict = gate.evaluate(manifest, [], gate.hostVersion)
    } catch (error) {
      r2++
      problems.push('R2 ' + dir + '：门禁无法判定（' + error.message + '）-> 该行可能被静默禁用')
      continue
    }
    if (verdict) {
      r2++
      const peers = Object.entries(verdict.peers || {}).map(([k, v]) => k + '@' + v).join(', ')
      problems.push('R2 ' + dir + '（v' + (manifest.version || '?') + '）：peer 不接受当前宿主 -> 该行会被静默禁用。冲突项：' + peers)
    }
  }
  console.log('R2 peer 不接受当前宿主：' + r2 + ' 处')

  console.log('')
  if (problems.length === 0) {
    console.log('OK：本仓库全部插件行都能被当前宿主（' + gate.hostVersion + '）加载。')
    return 0
  }
  console.log('发现 ' + problems.length + ' 个问题：')
  for (const p of problems) console.log('  - ' + p)
  return 1
}

// 两侧都取 realpath：fileURLToPath 那侧已被 realpath，argv[1] 那侧保留符号链接形态。
// 只比一侧的话，从符号链接路径调用（macOS 的 TMPDIR 就是符号链接）会静默不执行 ——
// 退出码 0 且零输出，是这个脚本最不该有的失败模式（假绿）。
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main()
}
