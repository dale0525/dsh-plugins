#!/usr/bin/env node
/**
 * 启动前离线校验门禁 —— 子进程实现。
 *
 * 为什么不放在插件进程里：本包 `src/core/**` 不允许 import 任何 `@deepseek-ai/*`
 * （`tests/architecture-boundaries.test.ts` 的硬门禁），而校验必须用宿主自己的
 * `@deepseek-ai/dsh-app-boot` 才有意义。另外 profile 里挂的是第三方 bundle，
 * 在宿主进程内 import 它们可能挂死宿主；子进程可以超时 kill。
 *
 * 协议：stdin 一个 JSON（`{home, profile}`），stdout 一个 JSON
 * （`{bad, checked, skipped, rows}`）。任何异常 → 非零退出 + stderr，
 * 调用方据此判定「无法校验」并按跳过处理（不阻断拉取）。
 *
 * 判定口径全部来自宿主，不自创规则：
 *  - 致命行集合 = 宿主 `requiredStartupEntryIds`（`auditStartupEntries` 消费的那个集合）。
 *    宿主语义：**缺失**的 id 不影响启动，**存在但 config 不合法**的必修行会让启动失败
 *    （`auditStartupEntries` 只在 required 命中时抛 StartupError，其余只 warn）。
 *    故这里只判「存在的必修行」，非必修行 config 非法不阻断启动。
 *  - 每行 config 用宿主导出的 `generateConfigSchema` 产出的 JSON Schema 校验。
 *  - schema 自身不完整（`x-cordis.complete === false` 或有 level=error 的 diagnostics）时，
 *    校验结论不可信，如实上报而不是当作通过。
 *  - loader entry id 重复**不会**让宿主崩溃（loader 是 `store[id] ??= new Entry(...)`，
 *    后写覆盖前写），只会静默丢掉先写那份的 config，故只作告警、不阻断。
 *
 * patch 层取自**磁盘现状**：门禁在 plugins 分区的项全部写完之后才跑，此时两个 patch 文件
 * 已经是本次拉取的结果，而宿主下次启动读的也正是它们。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

/** 宿主 `requiredStartupEntryIds` 的逐字副本（该常量未导出，见文件头注释）。 */
const REQUIRED_STARTUP_ENTRY_IDS = new Set([
  'agent-loop',
  'webserver',
  'web-runtime',
  'modules',
  'connection',
  'headless-runner',
  'acp',
  'sdk-jsonrpc-server',
])

function fail(message) {
  process.stderr.write(`boot-gate: ${message}\n`)
  process.exit(1)
}

/**
 * 「配置已坏」而非「无法校验」：以独立退出码上报，让调用方把它当硬失败而不是跳过。
 *
 * 与 `fail`（宿主模块缺失、版本不支持 → 调用方 fail-open）的区别在于：
 * 这类故障是**本次拉取写坏的 patch 文件**导致的，而宿主下次启动同样读不了它
 * （`loadOptionalPatches` 对非 ENOENT 的解析错误直接 throw → `plugin tree failed to load`）。
 * 此时放行等于把用户送进「起不来、又只能在能启动的宿主里开配置管理器」的死锁。
 */
function failBrokenConfig(message) {
  process.stderr.write(`boot-gate: ${message}\n`)
  process.exit(EXIT_BROKEN_CONFIG)
}

/** 解析错误码：2 = 配置本身已坏（硬失败）；1 = 无法校验（调用方降级）。 */
const EXIT_BROKEN_CONFIG = 2

let cfg
try {
  cfg = JSON.parse(readFileSync(0, 'utf8'))
} catch (error) {
  fail(`cannot read config from stdin: ${String(error)}`)
}
if (cfg === null || typeof cfg !== 'object' || typeof cfg.home !== 'string' || typeof cfg.profile !== 'string') {
  fail('config must be {home, profile}')
}

const profileDir = join(cfg.home, 'profiles', cfg.profile)
const profileRequire = createRequire(join(profileDir, 'package.json'))

let boot
let Ajv
let anchor
try {
  boot = await import(pathToFileURL(profileRequire.resolve('@deepseek-ai/dsh-app-boot')).href)
  anchor = profileRequire.resolve('@deepseek-ai/dsh/package.json')
  const bootRequire = createRequire(profileRequire.resolve('@deepseek-ai/dsh-app-boot'))
  Ajv = (await import(pathToFileURL(bootRequire.resolve('ajv/dist/2020.js')).href)).default
} catch (error) {
  fail(`cannot load host modules from ${profileDir}: ${String(error)}`)
}

let profile
let layers
try {
  profile = boot.loadProfile('dsh', cfg.profile, anchor, cfg.home)
  // 宿主 `loadProfileDirectory` 的层顺序：各 bundle 的 patch → profile 自己的 patch → home patch
  const homePatches = boot.loadOptionalPatches('dsh', join(cfg.home, 'cordis.patch.yml')) ?? []
  layers = [...profile.layers.map((layer) => layer.patches), profile.patches, homePatches]
} catch (error) {
  const text = String(error)
  // patch 文件解析/读取失败 = 配置本身已坏：宿主下次启动同样读不了它（loadOptionalPatches
  // 对非 ENOENT 直接 throw → boot() 报 plugin tree failed to load）。这类必须硬失败，
  // 不能与「宿主模块缺失/版本不支持」一起降级成跳过。
  if (/failed to parse overlay|failed to read patches|YAMLException/.test(text)) {
    failBrokenConfig(`patch file is unreadable: ${text}`)
  }
  fail(`cannot load profile ${cfg.profile}: ${text}`)
}

function describe(validator) {
  return (validator.errors ?? [])
    .slice(0, 2)
    .map((error) => `${error.instancePath || '$'} ${error.message}`)
    .join('; ')
}

let report
try {
  const schema = await boot.generateConfigSchema(profile, layers, anchor)
  const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false, addUsedSchema: false })
  ajv.addSchema(schema, 'root')
  const entries = new Map((schema['x-cordis']?.entries ?? []).map((entry) => [entry.id, entry]))
  const rows = boot.composeEntries(layers)

  // schema 自身不完整时，逐行校验的结论不可信 —— 如实上报，由调用方决定怎么办。
  // 宿主在 x-cordis.complete=false 或有 level=error 的 diagnostics 时明确表示这份产出是「部分结果」。
  const xcordis = schema['x-cordis'] ?? {}
  const schemaErrors = (xcordis.diagnostics ?? [])
    .filter((d) => d?.level === 'error')
    .map((d) => `${d.path ?? '$'} ${d.message ?? ''}`.trim())
  const schemaComplete = xcordis.complete !== false && schemaErrors.length === 0

  // 重复 id：宿主不会崩，只是后写覆盖前写。只作告警（warnings），不进 bad。
  const counts = new Map()
  for (const row of rows) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  const warnings = []
  for (const [id, count] of counts) {
    if (count > 1) warnings.push(`${id}: duplicate loader entry id (${count} entries; the later one wins)`)
  }

  const compiled = new Map()
  let checked = 0
  let skipped = 0
  const bad = []
  for (const row of rows) {
    if (!REQUIRED_STARTUP_ENTRY_IDS.has(row.id)) continue
    const entry = entries.get(row.id)
    if (
      entry === undefined ||
      entry.status === 'absent' ||
      entry.status === 'error' ||
      entry.configRef === '#/$defs/unknownConfig'
    ) {
      // 宿主没给出可用 schema（该插件没有 schemastery 配置，或解析失败）→ 无法判定，保守跳过
      skipped += 1
      continue
    }
    let validator = compiled.get(entry.configRef)
    if (validator === undefined) {
      validator = ajv.compile({ $ref: `root${entry.configRef}` })
      compiled.set(entry.configRef, validator)
    }
    checked += 1
    if (!validator(row.config ?? null)) {
      bad.push({ id: row.id, kind: 'invalid', message: `${row.id}: ${describe(validator) || 'config rejected'}` })
    }
  }
  report = {
    bad,
    warnings,
    checked,
    skipped,
    rows: rows.length,
    schemaComplete,
    schemaErrors: schemaErrors.slice(0, 5),
  }
} catch (error) {
  fail(`validation failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
}

process.stdout.write(JSON.stringify(report))
