#!/usr/bin/env node
/**
 * dev-watch.mjs — 源 → 产物自动重建（改插件源码即时生效的客户端半边）。
 *
 * 背景（实测结论，勿凭印象改动）：
 *  - 宿主的 **配置/补丁热重载** 无条件生效：`@deepseek-ai/dsh-hmr` 监听
 *    `<profile>/cordis.patch.yml` 与 `$DSH_HOME/cordis.patch.yml`，改完即时 reconcile。
 *    实测：改 MCP 行的 toolCallTimeoutMs 后不重启即对新调用生效。
 *  - 但 **插件源码的 module watch 默认关闭**：`dsh-base/cordis.patch.yml` 的 hmr 行是
 *    `config.root: []`。所以改 src/ 不会自动重建 lib/。
 *  - 客户端半边另有一条产物级热重载：`@deepseek-ai/dsh-client-hmr` 每 500ms
 *    stat-poll 各插件 client bundle 的 mtime/size，变化即推 SSE 让浏览器原位替换 fiber。
 *
 * 因此本脚本只做一件事：**监听源码，防抖后重建产物**。产物一变，上面那条
 * client HMR 链路自然把新 UI 送进浏览器（无需刷新页面）。
 *
 * 用法：
 *   node scripts/dev-watch.mjs                 # 监听 src/client/**，重建 lib/client.js
 *   node scripts/dev-watch.mjs --host          # 同时监听宿主半边（src/** 非 client），
 *                                              # 触发 tsc -p tsconfig.build.json（宿主侧
 *                                              # 模块替换仍需 profile patch 里开 root watch）
 *
 * 硬约束：
 *  - **绝不监听 lib/**（产物目录）：否则「重建 → 触发 → 重建」自激成死循环；
 *  - 防抖窗口内合并多次写入（编辑器保存会连发多个事件）；
 *  - 子进程串行化：上一次构建没结束就不再起新的。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync, watch } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolve(SCRIPT_DIR, '..')
const SRC_DIR = join(PKG_DIR, 'src')
const CLIENT_DIR = join(SRC_DIR, 'client')

/** 防抖窗口（ms）：编辑器保存常连发多个事件，合并成一次构建。 */
const DEBOUNCE_MS = 200

/** 忽略的路径片段：产物、依赖、VCS —— 监听它们会自激或空转。 */
const IGNORED = [`${'lib'}${'/'}`, 'node_modules/', '.git/', 'dist/']

const watchHost = process.argv.includes('--host')

/** 递归收集目录下所有文件（只用于首次打印统计；监听用 fs.watch recursive）。 */
function countFiles(dir) {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (IGNORED.some((frag) => p.includes(frag))) continue
    if (entry.isDirectory()) n += countFiles(p)
    else n += 1
  }
  return n
}

/** 起一次构建；串行化（构建中再来事件则排队合并）。 */
function makeRunner(label, command, args) {
  let running = false
  let queued = false
  const run = () => {
    if (running) {
      queued = true
      return
    }
    running = true
    const started = Date.now()
    const child = spawn(command, args, { cwd: PKG_DIR, stdio: 'inherit' })
    child.on('close', (code) => {
      running = false
      const ms = Date.now() - started
      if (code === 0) console.log(`[dev-watch] ${label} 重建完成（${ms}ms）`)
      else console.error(`[dev-watch] ${label} 重建失败（exit ${code}）`)
      if (queued) {
        queued = false
        run()
      }
    })
  }
  return run
}

const buildClient = makeRunner('client bundle', 'npx', ['tsdown'])
const buildHost = makeRunner('host lib', 'npx', ['tsc', '-p', 'tsconfig.build.json'])

let timer = null
const schedule = (fn, why) => {
  if (timer !== null) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    console.log(`[dev-watch] 源码变化（${why}）→ 重建`)
    fn()
  }, DEBOUNCE_MS)
}

const watchTree = (dir, fn, why) => {
  if (!existsSync(dir)) {
    console.error(`[dev-watch] 目录不存在，跳过监听: ${dir}`)
    return
  }
  watch(dir, { recursive: true }, (_event, filename) => {
    if (filename === null) return
    const rel = relative(PKG_DIR, join(dir, String(filename))).split('\\').join('/')
    if (IGNORED.some((frag) => rel.includes(frag))) return
    schedule(fn, rel)
  })
  console.log(`[dev-watch] 监听 ${relative(PKG_DIR, dir)}（${countFiles(dir)} 个文件）`)
}

watchTree(CLIENT_DIR, buildClient, 'client')
if (watchHost) watchTree(SRC_DIR, buildHost, 'host')

console.log('[dev-watch] 已就绪。改 src/client/** 即重建 lib/client.js；')
console.log('           宿主 `dsh-client-hmr` 每 500ms 轮询产物 mtime/size，变化即推 SSE 原位替换。')
console.log('           配置/补丁（cordis.patch.yml、settings.yaml）由宿主自行热重载，与本脚本无关。')
if (!watchHost) console.log('           提示：宿主半边（src/ 非 client）改动加 --host 才会重建。')
