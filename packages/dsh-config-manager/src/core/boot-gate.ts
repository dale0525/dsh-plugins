/**
 * 启动前离线校验门禁（拉取的安全网）。
 *
 * 背景（真实故障）：换机同步时用户先 `dsh plugin add …@latest` 再拉配置。插件被换到新版本后，
 * 配置里的 patch 行可能已不被该版本接受；而拉取本身是「先写文件、再让宿主热重载」——
 * 于是写下去的那一份在**下一次启动**才炸，用户看到的是「dsh 起不来了」，
 * 而配置管理器只能在能启动的宿主里打开，形成死锁（只能手改文件）。
 *
 * 因此拉取必须在**事务内**回答一个问题：按刚落盘的这份 patch 层与刚装上的这组插件，
 * 下一次启动会不会被宿主的启动门禁拒掉？
 *  - 事务内：此时外层快照已存在，判定失败可以真正回滚（文件回到导入前）；
 *  - 子进程：profile 里挂的是第三方 bundle，在宿主进程内 import 它们可能挂死宿主；
 *    子进程可以超时 kill，失败也不影响宿主。
 *
 * 判定口径与宿主一致，不自创规则（见 `scripts/boot-gate-child.mjs` 文件头）。
 *
 * 分层：core 只依赖 node:* 与 ../utils，不 import 任何 `@deepseek-ai/*` ——
 * 因此真正的校验跑在包内的 `scripts/boot-gate-child.mjs` 里（运行时用 createRequire 从目标
 * profile 解析宿主的 app-boot），这里只负责拉起它并把 JSON 结果转成类型。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** 单条被判为「下一次启动会有问题」的行。 */
export interface GateBadRow {
  id: string
  /** 该行 config 不被宿主的 schema 接受（宿主的致命行集合里只有这类会阻断启动） */
  kind: 'invalid'
  /** 英文诊断（进日志与失败文案的 detail，不直接当用户文案） */
  message: string
}

/** 一轮校验的结果。 */
export interface GateReport {
  bad: GateBadRow[]
  /** 非阻断告警（如重复 loader entry id：宿主后写覆盖前写，不会崩） */
  warnings: string[]
  /** 实际做过 schema 校验的致命行数 */
  checked: number
  /** 致命行存在但宿主没有暴露可用 schema（无法判定，保守跳过） */
  skipped: number
  /** 组合后的条目总数（诊断用） */
  rows: number
  /**
   * 宿主的 `generateConfigSchema` 是否产出了完整结果。
   * `false` 表示这份 schema 自己就不完整（部分结果），逐行校验的结论不可信。
   */
  schemaComplete: boolean
  /** schema 不完整时的宿主诊断（最多 5 条，进日志） */
  schemaErrors: string[]
}

export interface BootGateInput {
  homeDir: string
  profile: string
}

/**
 * 校验钩子的返回。
 *
 * - `{kind:'report'}` 正常判定结果
 * - `{kind:'broken-config'}` 配置本身已坏（patch 文件读不了）：宿主下次启动同样读不了它，
 *   调用方必须按硬失败处理，**不能**当成「无法校验」放行
 * - `null` 无法校验（宿主版本不支持 / 子进程失败）：调用方降级为告警，不阻断
 */
export type BootGateResult =
  | { kind: 'report'; report: GateReport }
  | { kind: 'broken-config'; detail: string }
  | { kind: 'child-failed'; detail: string }

/** 校验钩子：返回 null = 无法执行（宿主版本不支持 / 子进程失败），调用方按「跳过并告警」处理。 */
export type BootGateHook = (input: BootGateInput) => Promise<BootGateResult | null>

/** 关闭门禁的环境变量（逃生阀：判定口径若在某个宿主版本上误报，用户不必等发版）。 */
export const BOOT_GATE_OFF_ENV = 'DSH_CONFIG_MANAGER_BOOT_GATE'

/**
 * 宿主 `requiredStartupEntryIds`（`@deepseek-ai/dsh-app-boot` 未导出该常量，两侧各留一份）。
 *
 * 语义：**缺失**的 id 不影响启动，**存在但 config 不合法**的行会让启动失败。
 * 子进程用这份清单决定「哪些行必须校验到」。门禁本身**不写盘、不删行**：
 * 判定失败一律交给引擎整体回滚。所以这里不是「可丢弃白名单」——
 * 那种按清单丢行的设计已删除（宿主的必修行恰恰不许丢：丢掉 `connection` 行
 * 等于关掉局域网信任围栏，那是比「启动失败」更糟的静默降级）。
 *
 * `scripts/boot-gate-child.mjs` 里有一份同样的清单（.mjs 无法 import 本模块），
 * 由 `boot-gate.test.ts` 钉住两份一致。
 */
export const REQUIRED_STARTUP_ENTRY_IDS: ReadonlySet<string> = new Set([
  'agent-loop',
  'webserver',
  'web-runtime',
  'modules',
  'connection',
  'headless-runner',
  'acp',
  'sdk-jsonrpc-server',
])

/** 门禁是否被显式关闭（`off` / `0` / `false` / `no`，大小写不敏感）。 */
export function bootGateDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[BOOT_GATE_OFF_ENV]
  if (raw === undefined) return false
  const value = raw.trim().toLowerCase()
  return value === 'off' || value === '0' || value === 'false' || value === 'no'
}

/**
 * 子进程预算。实测单次 6–10 秒（首次要 import 整个宿主依赖图）。
 *
 * 取 60 秒是给「门禁最多跑两轮 + 插件安装」留出路由预算（`ROUTE_TIMEOUT_MS` = 5 分钟）：
 * 两轮都撞满 60 秒仍在预算内，不会让拉取在写盘中途被路由超时打断。
 */
export const BOOT_GATE_TIMEOUT_MS = 60_000

/**
 * 校验子进程脚本路径。
 *
 * `src/core/` 与 `lib/core/` 到包根都是两级，所以开发（node --test 直跑 .ts）
 * 与发布（tsc 产出 lib/）用同一个相对路径，不需要分支。
 */
export function bootGateChildPath(): string {
  return fileURLToPath(new URL('../../scripts/boot-gate-child.mjs', import.meta.url))
}

/** 子进程输出 → 报告；形状不符返回 null（当作「无法执行」，不猜）。 */
function parseReport(stdout: string): GateReport | null {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj['bad'])) return null
  const bad: GateBadRow[] = []
  for (const item of obj['bad']) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (typeof row['id'] !== 'string') continue
    bad.push({
      id: row['id'],
      kind: 'invalid',
      message: typeof row['message'] === 'string' ? row['message'] : '',
    })
  }
  const strList = (key: string): string[] =>
    Array.isArray(obj[key]) ? (obj[key] as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const num = (key: string): number => (typeof obj[key] === 'number' ? (obj[key] as number) : 0)
  return {
    bad,
    warnings: strList('warnings'),
    checked: num('checked'),
    skipped: num('skipped'),
    rows: num('rows'),
    // 缺字段按「完整」处理：老版本子进程不报这两项，不能因此把所有校验都判成不可信
    schemaComplete: obj['schemaComplete'] !== false,
    schemaErrors: strList('schemaErrors'),
  }
}

/** 子进程退出码：2 = 配置本身已坏（硬失败）；其余非零 = 无法校验（降级）。 */
const EXIT_BROKEN_CONFIG = 2

/** 拉起子进程跑一轮校验；任何失败（非零退出 / 超时 / 输出不可解析 / spawn 失败）→ null。 */
function runChild(
  nodePath: string,
  scriptPath: string,
  payload: string,
  timeoutMs: number,
): Promise<BootGateResult | null> {
  return new Promise((resolve) => {
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (value: BootGateResult | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(nodePath, [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      finish(null)
      return
    }
    const chunks: string[] = []
    let stderr = ''
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
      finish(null)
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => chunks.push(chunk))
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < 8192) stderr += chunk
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      if (code === EXIT_BROKEN_CONFIG) {
        // 配置本身已坏：必须硬失败，不能与「无法校验」一起降级
        finish({ kind: 'broken-config', detail: stderr.trim().replace(/^boot-gate:\s*/, '') })
        return
      }
      if (code !== 0) {
        // 不直接写 process.stderr：那条出口绕过插件的日志脱敏与级别控制。
        // 把子进程 stderr 交给调用方，由它经 ctx.onLog 统一输出。
        finish({ kind: 'child-failed', detail: stderr.trim() })
        return
      }
      const report = parseReport(chunks.join(''))
      finish(report === null ? null : { kind: 'report', report })
    })
    // stdin 写入失败（子进程早退）由 close 事件兜底，这里吞掉以免未处理的 'error' 事件
    child.stdin?.on('error', () => { /* 见 close */ })
    child.stdin?.end(payload)
  })
}

/**
 * 构造门禁钩子。选项只为测试可注入（脚本路径 / 超时 / node 路径），生产用默认值。
 */
export function createBootGate(
  options: { scriptPath?: string; timeoutMs?: number; nodePath?: string } = {},
): BootGateHook {
  const scriptPath = options.scriptPath ?? bootGateChildPath()
  const timeoutMs = options.timeoutMs ?? BOOT_GATE_TIMEOUT_MS
  const nodePath = options.nodePath ?? process.execPath
  return async (input) => {
    const payload = JSON.stringify({ home: input.homeDir, profile: input.profile })
    return runChild(nodePath, scriptPath, payload, timeoutMs)
  }
}
