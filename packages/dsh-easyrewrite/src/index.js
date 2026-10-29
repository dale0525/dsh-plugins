/**
 * dsh-easyrewrite — node half。
 *
 * 只剩两条自更新路由（宿主没有对应的客户端可调用接缝）：
 *  - POST /bubble/check-update  → 读本包当前版本、npm 最新版本、宿主版本
 *  - POST /bubble/update-plugin → 在 profile 目录执行 pnpm up（写操作，客户端需用户确认）
 *
 * 撤回/归档/草稿备份/日志上报原先各有自造路由，现已全部改走宿主官方接缝：
 * fork(atSeq) 由客户端算边界、archive/unarchive 用 workspaces 服务、草稿由
 * conversation 的 defineStore 自动持久化、日志走 ctx.logger。
 *
 * 依赖服务：webServer（路由）。
 */
import { readFile, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-easyrewrite'
// inject 是「必需」语义：缺任一项整个插件静默不激活。sessions/agents 随自造路由一起删掉了；
// connection 是路由访问校验的唯一来源（requestRejection），缺它就必须显式停用而不是放行。
export const inject = ['webServer', 'connection']

/** 读取 JSON 请求体（带大小上限保护）。 */
function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // 超限：停止收集并继续消费 body（不 destroy——避免连接重置，handler 回 413）
        req.removeAllListeners('data');
        req.resume();
        reject(new Error('body-too-large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

// ---------- 插件自更新（精简版：检测 + 手动更新；自动检测默认关） ----------
async function readOwnVersion() {
  try {
    const here = fileURLToPath(import.meta.url);
    const pkgPath = join(dirname(here), '..', 'package.json');
    const raw = await readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch (e) { return '0.0.0'; }
}
/** 读取 dsh 宿主自身版本（从进程入口向上逐级找 @deepseek-ai/dsh 的 package.json）。
 *
 * 必须先 realpath：`/opt/homebrew/bin/dsh` 是指向 `lib/node_modules/@deepseek-ai/dsh/lib/bin.js`
 * 的符号链接，而 dirname 不解析符号链接。直接上探会在 `/opt/homebrew/bin` 一带打转，
 * 6 层之内一个 package.json 都碰不到宿主，于是本函数恒返回 null（实测 dshVersion: null）。
 */
async function readDshVersion() {
  const candidates = [];
  // 路径1：进程入口解析符号链接后向上逐级找
  try {
    let entry = process.argv[1] || "";
    try { entry = await realpath(entry); } catch (e) { /* 非真实路径时按原样上探 */ }
    let dir = dirname(entry);
    for (let i = 0; i < 6; i++) { candidates.push(join(dir, "package.json")); const up = dirname(dir); if (up === dir) break; dir = up; }
  } catch (e) { /* ignore */ }
  // 路径2：Windows npm 全局前缀兜底（rc.1 实测 argv 上探失败时）
  try { const gp = process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "package.json") : null; if (gp) candidates.push(gp); } catch (e) { /* ignore */ }
  for (const c of candidates) {
    try {
      const p = JSON.parse(await readFile(c, "utf8"));
      if (p.name === "@deepseek-ai/dsh" && typeof p.version === "string") return p.version;
    } catch (e) { /* 下一个候选 */ }
  }
  return null;
}

async function fetchLatestVersion() {
  try {
    const resp = await fetch('https://registry.npmjs.org/@logictan%2Fdsh-easyrewrite/latest', {
      headers: { 'user-agent': '@logictan/dsh-easyrewrite-update-check', accept: 'application/json' }
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return typeof data.version === 'string' ? data.version : null;
  } catch (e) { return null; }
}
/** 定位安装本插件的运行目录，并给出该升级哪个包。
 *
 * 本插件通常不是 profile 的直接依赖，而是经聚合包 `@logictan/dsh-plugins-all` 间接安装
 * （聚合包的 patch 行负责挂载、`dependencies` 负责装包）。只按本包名匹配会一个都找不到，
 * 于是更新接口恒返回 profile-not-found；即便匹配到，`pnpm up @logictan/dsh-easyrewrite`
 * 也会把它变成 profile 的直接依赖（改变安装形态）。所以这里同时认聚合包，
 * 并把「该 up 哪个包」一并返回：聚合包在就用聚合包，否则才用本包。
 *
 * 多个 profile 可能都装了聚合包（本机 lgtest 与 web 都是），所以必须先认进程自己的
 * `--profile <name>`：否则会去升级另一个 profile，用户看到的「已更新」是假的。
 */
async function findPluginHomeDir() {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh');
    const profilesRoot = join(home, 'profiles');
    // 当前进程的 profile 名（dsh --profile <name> …）
    let current = null;
    try {
      const i = process.argv.indexOf('--profile');
      if (i >= 0 && typeof process.argv[i + 1] === 'string') current = process.argv[i + 1];
    } catch (e) { /* ignore */ }
    const resolveIn = async (name) => {
      if (typeof name !== 'string' || !name) return null;
      const dir = join(profilesRoot, name);
      let raw;
      try { raw = await readFile(join(dir, 'package.json'), 'utf8'); } catch (e) { return null; }
      if (raw.includes('@logictan/dsh-plugins-all')) return { dir, target: '@logictan/dsh-plugins-all' };
      if (raw.includes('@logictan/dsh-easyrewrite')) return { dir, target: '@logictan/dsh-easyrewrite' };
      return null;
    };
    const own = await resolveIn(current);
    if (own) return own;
    for (const name of await readdirSafe(profilesRoot)) {
      const found = await resolveIn(name);
      if (found) return found;
    }
  } catch (e) { /* ignore */ }
  return null;
}
async function readdirSafe(dir) {
  try { return await readdir(dir); } catch (e) { return []; }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function apply(ctx) {
  const disposers = [];
  // 插件自更新：检查 npm 最新版本（只读）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/bubble/check-update',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        const rejection = ctx.get('connection').requestRejection(req);
        if (rejection !== undefined) { sendJson(res, rejection, { ok: false, error: 'rejected' }); return; }
        const body = await readJsonBody(req, 16 * 1024);
        const current = await readOwnVersion();
        const latest = await fetchLatestVersion();
        const dshVersion = await readDshVersion();
        sendJson(res, 200, { ok: true, current, latest, dshVersion });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    }
  }));
  // 插件自更新：执行 pnpm up（写操作——client 端必须用户显式确认后调用）
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: '/bubble/update-plugin',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method-not-allowed' }); return; }
        const rejection = ctx.get('connection').requestRejection(req);
        if (rejection !== undefined) { sendJson(res, rejection, { ok: false, error: 'rejected' }); return; }
        const body = await readJsonBody(req, 16 * 1024);
        const home = await findPluginHomeDir();
        if (!home) { sendJson(res, 200, { ok: false, error: 'profile-not-found' }); return; }
        const output = await new Promise((resolve) => {
          execFile('pnpm', ['up', home.target], { cwd: home.dir, timeout: 90000, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ err: err ? String(err.message || err) : null, stdout: String(stdout || '').slice(-1500), stderr: String(stderr || '').slice(-1500) });
          });
        });
        const ok = !output.err || output.stdout.includes('up to date') || output.stdout.includes('Done');
        // 升级成功后进程内的仍是旧代码（模块缓存），由客户端提示用户重启
        sendJson(res, 200, { ok, target: home.target, restartRequired: ok, output: output.stdout.slice(-800) });
      } catch (err) {
        sendJson(res, 500, { ok: false, error: 'internal' });
      }
    }
  }));
  return () => {
    for (const d of disposers) { try { d(); } catch (e) { /* ignore */ } }
  };
}
