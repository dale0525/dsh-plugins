/**
 * m-git-channel：Git 私有仓库通道（SyncTransport 的 git 实现）。
 *
 * 设计：
 * - 明文快照以「散文件目录」提交到 git 仓库：工作副本 <workDir>/snapshot/ 即 t2 layout 布局
 *   （manifest.json + 平铺 JSON 分区 + 文件类分区目录），每次 sync 一次 commit + push。
 *   **固定路径是增量的前提**：路径不变，git 才只传内容有差异的文件；每次新建 snapshots/<id>/
 *   会让 git 看到「整棵树删除 + 整棵树新增」而全量重传（见 SNAPSHOT_ACTIVE_REL 注释）。
 *   旧布局 <workDir>/snapshots/<id>/ 只读兼容，首次 upload 时清理；
 * - 加密快照（EncryptedSections 密文载荷，无法平铺为明文 JSON 分区）走「密文单文件」布局：
 *   整个快照 JSON 提交到 <workDir>/snapshots-encrypted/<id>.json（远端已存密文；
 *   本地工作副本即远端镜像，不产生额外明文审计副本）。
 * - 命令执行走 node:child_process execFile（promise 封装，数组参数无 shell 注入），
 *   始终使用系统 PATH 中的 git（固定命令 'git'），可注入 exec 便于测试。
 * - Windows 长路径：快照里的 plugin-files 分区会带出 deep 嵌套的插件配置路径，
 *   $DSH_HOME/dsh-config-manager/sync/work/snapshots/<id>/… 很快超过 MAX_PATH(260)，
 *   git 报 "error: cannot stat '<path>': Filename too long"。win32 下每条 git 命令注入
 *   -c core.longpaths=true（不改用户全局配置），git 内部改用 \\?\ 前缀路径。
 * - 认证：token 仅从注入的 credentials provider 读取（每次网络操作时 getToken()），
 *   经 git credential helper（store --file=<临时文件>）传给 git —— token 不进入 argv、
 *   不进入 repoUrl、不写入任何同步内容/commit message/日志；临时凭据文件用后即删。
 * - 私有仓库判定：checkIsPrivate() 先匿名 ls-remote（成功=公开），失败再用凭据探测
 *   （成功=私有），isPrivateHint 缓存最近结果供 UI 提示（私有仓库为推荐使用场景）。
 * - 契约：同 id 重复 upload = 覆盖（幂等友好：内容无变化时不产生 commit）；download 不存在抛错；
 *   delete 不存在视为成功。
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { createSnapshotFs, joinFs } from '../fs.ts';
import type { SnapshotFs } from '../fs.ts';
import { readSnapshotFromDir, SNAPSHOT_MANIFEST_FILE, writeSnapshotToDir } from '../layout.ts';
import type { SnapshotDirManifest } from '../layout.ts';
import { deserializeSnapshot, serializeSnapshot } from '../snapshot-json.ts';
import { computeSnapshotMeta, isEncryptedSections } from '../transport.ts';
import type { SyncSnapshot, SyncSnapshotMeta, SyncTransport } from '../transport.ts';
import { parseJsonSafe } from '../../utils/json.ts';
import { atomicWriteFile } from '../../utils/atomic-write.ts';
import { zhMsg } from '../../core/messages.ts';
import type { MsgFunc } from '../../core/messages.ts';

const execFileAsync = promisify(execFile);

/** git 命令执行结果（code ≠ 0 = git 命令失败/退出非零） */
export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** 可注入的 git 执行器（测试 mock 用）；默认实现 = child_process.execFile promise 封装 */
export type GitExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<GitExecResult>;

/** 凭据提供者：token 只从这里读取，绝不在任何地方持久化 */
export interface GitCredentialProvider {
  getToken(): Promise<string>;
}

export interface GitAuthor { name: string; email: string; }

export interface GitTransportOptions {
  /** 远端私有仓库地址（https/ssh/本地路径）；token 绝不拼入此 URL */
  repoUrl: string;
  /** 本地 git 工作副本目录（不存在则创建；已 clone 则复用） */
  workDir: string;
  /** token 提供者（http(s) 远端必填；本地/ssh 远端不会被调用） */
  credentials: GitCredentialProvider;
  /** 单条 git 命令超时 ms，默认 60000 */
  timeoutMs?: number;
  /** 注入 exec（测试 mock 用）；缺省 = execFile 封装 */
  exec?: GitExecFn;
  /** 提交作者（写入远端历史），默认 DSH Config Sync <sync@dsh.local> */
  author?: GitAuthor;
  /** credential 用户名（GitHub PAT 用 oauth2），默认 'oauth2' */
  credentialUsername?: string;
  /** 消息翻译器（缺省 zh） */
  msg?: MsgFunc;
  /** 平台（仅用于长路径开关判定；缺省 process.platform，测试可注入以覆盖 win32 语义） */
  platform?: NodeJS.Platform;
}

export class GitTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitTransportError';
  }
}

const SNAPSHOTS_REL = 'snapshots';
/** 加密快照的「密文单文件」目录：整个快照 JSON（含密文载荷）以 <id>.json 提交。
 *  加密快照不写散文件目录（密文无法平铺为明文 JSON 分区；远端已存密文）。 */
const SNAPSHOTS_ENCRYPTED_REL = 'snapshots-encrypted';
/**
 * 活快照的**固定路径**：远端恒只有这一份快照，每次同步原地覆盖。
 *
 * 为什么必须是固定路径（而不是每次新建 `snapshots/<id>/`）：git 的增量以**路径**为单位。
 * 每次换新目录名时，git 看到的是「2162 个文件删除 + 2162 个文件新增」，而不是「改了 51 个文件」，
 * 于是整棵快照树被重新打包传输 —— 实测推送 5.02 MiB / 拉取 5.05 MiB，改为固定路径后同一改动
 * 只需推送 1.71 MiB / 拉取 2.08 MiB；只改一个 6.9KB 小文件时从 4.86 MiB 降到几百字节。
 *
 * `snapshots/` 保留为**只读的旧布局**（升级前推送的快照）：list/download 仍能读到，
 * 首次 upload 时清理掉它们完成迁移。
 */
const SNAPSHOT_ACTIVE_REL = 'snapshot';
/** 本插件管理的全部快照目录（pull 前的残留复位只作用于这些路径） */
const SNAPSHOT_DIRS: readonly string[] = [SNAPSHOT_ACTIVE_REL, SNAPSHOTS_REL, SNAPSHOTS_ENCRYPTED_REL];
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_AUTHOR: GitAuthor = { name: 'DSH Config Sync', email: 'sync@dsh.local' };
const DEFAULT_CREDENTIAL_USERNAME = 'oauth2';
/** 快照 id 安全字符集：字母数字开头，仅 . _ -；防路径穿越与 commit message 注入 */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * win32 长路径开关：git 在 Windows 上默认受 MAX_PATH(260) 限制，快照里 plugin-files 分区
 * 会带出深层嵌套的插件配置路径（实测单条相对路径已 211 字符，加上 <DSH_HOME>/…/work/ 前缀即超限）。
 * 每条命令带 -c core.longpaths=true（命令行 -c 优先于仓库/全局配置，不改用户环境）。
 */
const LONG_PATHS_ARGS: readonly string[] = ['-c', 'core.longpaths=true'];

const defaultExec: GitExecFn = async (cmd, args, opts) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
    });
    return { stdout: String(stdout), stderr: String(stderr), code: 0 };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      stdout: String(e.stdout ?? ''),
      stderr: String(e.stderr ?? (err instanceof Error ? err.message : String(err))),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
};

/** git config 值里的路径转义：含空白/引号时用引号包裹（Windows 路径转正斜杠） */
function quoteGitValue(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/** 实现 SyncTransport 的 git 通道。所有操作前 ensureRepo() 保证工作副本就绪，网络命令带凭据。 */
export class GitTransport implements SyncTransport {
  readonly type = 'git';

  private readonly o: GitTransportOptions & {
    gitBin: string;
    timeoutMs: number;
    author: GitAuthor;
    credentialUsername: string;
    exec: GitExecFn;
    longPaths: boolean;
  };
  private repoReady = false;
  private privateHint: boolean | null = null;
  /** gc 已在后台跑（并发触发无意义且会互相争抢仓库锁） */
  private gcRunning = false;
  private readonly msg: MsgFunc;

  constructor(options: GitTransportOptions) {
    if (typeof options.repoUrl !== 'string' || options.repoUrl.length === 0) {
      throw new GitTransportError(zhMsg('sync.git.repoUrlRequired'));
    }
    if (typeof options.workDir !== 'string' || options.workDir.length === 0) {
      throw new GitTransportError(zhMsg('sync.git.workDirRequired'));
    }
    if (options.credentials === null || typeof options.credentials !== 'object'
      || typeof options.credentials.getToken !== 'function') {
      throw new GitTransportError(zhMsg('sync.git.credentialsRequired'));
    }
    this.msg = options.msg ?? zhMsg;
    this.o = {
      repoUrl: options.repoUrl,
      workDir: options.workDir,
      credentials: options.credentials,
      gitBin: 'git',
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      exec: options.exec ?? defaultExec,
      author: options.author ?? DEFAULT_AUTHOR,
      credentialUsername: options.credentialUsername ?? DEFAULT_CREDENTIAL_USERNAME,
      longPaths: (options.platform ?? process.platform) === 'win32',
    };
  }

  /** 最近一次 checkIsPrivate() 的结果；null = 尚未检查 */
  get isPrivateHint(): boolean | null {
    return this.privateHint;
  }

  /** 列出远端已有快照（按 createdAt 升序）：固定路径活快照 + 旧布局 `snapshots/<id>/` + 密文单文件。
   *  旧布局只读兼容 —— 升级前的远端仍需可拉取；首次 upload 后它们被清理，收敛为固定路径一份。 */
  async list(): Promise<SyncSnapshotMeta[]> {
    await this.ensureRepo();
    await this.pullFromRemote();
    const fsx = createSnapshotFs();
    const byId = new Map<string, SyncSnapshotMeta>();

    // ① 固定路径活快照
    const active = await this.readDirManifest(this.activeSnapshotDir());
    if (active !== null) byId.set(active.id, { id: active.id, createdAt: active.createdAt, sections: active.sectionHashes, manifest: active.manifest });

    // ② 旧布局散文件目录（升级前推送的快照）
    const snapsAbs = this.snapshotsDir();
    if (await fsx.isDir(snapsAbs)) {
      for (const name of await fsx.readdir(snapsAbs)) {
        if (!SAFE_ID_RE.test(name)) continue;
        const dir = joinFs(snapsAbs, name);
        if (!(await fsx.isDir(dir))) continue;
        const m = await this.readDirManifest(dir);
        if (m !== null && !byId.has(m.id)) byId.set(m.id, { id: m.id, createdAt: m.createdAt, sections: m.sectionHashes, manifest: m.manifest });
      }
    }

    // ③ 密文单文件（历史遗留布局）
    const encAbs = this.encryptedSnapshotsDir();
    if (await fsx.isDir(encAbs)) {
      for (const name of await fsx.readdir(encAbs)) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -'.json'.length);
        if (!SAFE_ID_RE.test(id) || byId.has(id)) continue;
        const snap = await this.readEncryptedSnapshotFile(joinFs(encAbs, name));
        if (snap === null) continue;
        byId.set(id, computeSnapshotMeta(snap));
      }
    }

    return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  /**
   * 上传快照：写散文件目录（明文）或密文单文件（加密）→ add → commit → push；
   * 同 id 覆盖；内容无变化时幂等（不产生 commit）。
   * 双形态互斥：同 id 从一种形态切到另一种时先清掉旧形态残留，保证工作副本/远端布局自洽。
   */
  async upload(snapshot: SyncSnapshot): Promise<SyncSnapshotMeta> {
    this.assertSafeId(snapshot.id);
    await this.ensureRepo();
    await this.pullFromRemote();
    const fsx = createSnapshotFs();
    const encrypted = isEncryptedSections(snapshot.sections);
    const activeDir = this.activeSnapshotDir();
    // 覆盖判定：活快照目录 / 旧布局同 id 目录 / 同 id 密文单文件任一存在 → update
    const existed = await fsx.exists(activeDir)
      || await fsx.exists(this.snapshotDir(snapshot.id))
      || await fsx.exists(this.encryptedSnapshotFile(snapshot.id));
    const rels: string[] = [];
    if (encrypted) {
      // 密文单文件：整个快照 JSON（sections 为 EncryptedSections，纯字符串 JSON 安全）
      const file = this.encryptedSnapshotFile(snapshot.id);
      await fsx.remove(file); // 覆盖语义：先删旧文件
      await fsx.mkdir(this.encryptedSnapshotsDir());
      await fsx.writeFile(file, new TextEncoder().encode(serializeSnapshot(snapshot)));
      // 同 id 旧明文残留 → 一并清理（形态切换不残留）
      await fsx.remove(activeDir);
      await fsx.remove(this.snapshotDir(snapshot.id));
      rels.push(SNAPSHOTS_ENCRYPTED_REL, SNAPSHOT_ACTIVE_REL, SNAPSHOTS_REL);
    } else {
      // 原地覆盖固定路径：内容未变化的文件不重写、旧快照遗留的文件被清理 —— 这是增量的前提
      // （重写会让 git 失去 stat 缓存而重算全部文件；不清理则旧文件永久残留并进入提交）
      await writeSnapshotToDir(snapshot, activeDir, fsx, { inPlace: true });
      // 同 id 旧密文单文件残留 → 一并清理（形态切换不残留）
      await fsx.remove(this.encryptedSnapshotFile(snapshot.id));
      // 迁移：旧布局 snapshots/<id>/ 整体清理，远端收敛为固定路径一份（与 MAX_REMOTE_SNAPSHOTS=1 一致）
      const legacyRoot = this.snapshotsDir();
      if (await fsx.isDir(legacyRoot)) {
        for (const name of await fsx.readdir(legacyRoot)) {
          if (name === '' || name === '.' || name === '..') continue;
          await fsx.remove(joinFs(legacyRoot, name));
        }
      }
      rels.push(SNAPSHOT_ACTIVE_REL, SNAPSHOTS_REL, SNAPSHOTS_ENCRYPTED_REL);
    }
    await this.stageSnapshotPaths(rels);
    const diff = await this.runGit(['diff', '--cached', '--quiet'], { allowNonZero: true });
    if (diff.code !== 0) {
      const verb = existed ? 'update' : 'add';
      await this.runGit(['commit', '-m', `sync: ${verb} snapshot ${snapshot.id}`]);
      await this.runGit(['push', '-u', 'origin', 'HEAD'], { withCredential: true });
    }
    this.scheduleGc();
    return computeSnapshotMeta(snapshot);
  }

  /** 下载快照完整载荷。明文 → 读回散文件目录（固定路径活快照，其次旧布局）；加密 → 读回密文单文件。
   *  不存在的 id 必须抛错（契约）。 */
  async download(id: string): Promise<SyncSnapshot> {
    this.assertSafeId(id);
    await this.ensureRepo();
    await this.pullFromRemote();
    const fsx = createSnapshotFs();
    // 优先固定路径活快照；其次旧布局 snapshots/<id>/；再次密文单文件
    // missingFileDir='empty'：git 不跟踪空目录 → 目录缺失 = 空文件分区（非损坏；
    // 提交原子性保证非空目录不会缺失），兼容旧版插件上传的无占位快照
    if (await this.readActiveSnapshotId() === id) {
      return readSnapshotFromDir(this.activeSnapshotDir(), fsx, { missingFileDir: 'empty' });
    }
    const legacyDir = this.snapshotDir(id);
    if (await fsx.isDir(legacyDir)) {
      return readSnapshotFromDir(legacyDir, fsx, { missingFileDir: 'empty' });
    }
    const encFile = this.encryptedSnapshotFile(id);
    if (await fsx.exists(encFile)) {
      const raw = Buffer.from(await fsx.readFile(encFile)).toString('utf8');
      try {
        return deserializeSnapshot(raw);
      } catch (err) {
        throw new GitTransportError(this.msg('sync.git.snapshotCorrupt', {
          id, dir: encFile, err: this.mask(String((err as Error)?.message ?? ''), null),
        }));
      }
    }
    throw new GitTransportError(this.msg('sync.git.snapshotMissing', { id, dir: this.activeSnapshotDir() }));
  }

  /** 删除远端快照（固定路径活快照 / 旧布局目录 / 密文单文件；不存在视为成功，契约）。 */
  async delete(id: string): Promise<void> {
    this.assertSafeId(id);
    await this.ensureRepo();
    await this.pullFromRemote();
    const fsx = createSnapshotFs();
    const rels: string[] = [];
    if (await this.readActiveSnapshotId() === id) {
      await fsx.remove(this.activeSnapshotDir());
      rels.push(SNAPSHOT_ACTIVE_REL);
    }
    const legacyDir = this.snapshotDir(id);
    if (await fsx.exists(legacyDir)) {
      await fsx.remove(legacyDir);
      rels.push(SNAPSHOTS_REL);
    }
    const encFile = this.encryptedSnapshotFile(id);
    if (await fsx.exists(encFile)) {
      await fsx.remove(encFile);
      rels.push(SNAPSHOTS_ENCRYPTED_REL);
    }
    if (rels.length === 0) return; // 不存在视为成功
    await this.stageSnapshotPaths(rels);
    const diff = await this.runGit(['diff', '--cached', '--quiet'], { allowNonZero: true });
    if (diff.code !== 0) {
      await this.runGit(['commit', '-m', `sync: delete snapshot ${id}`]);
      await this.runGit(['push', '-u', 'origin', 'HEAD'], { withCredential: true });
    }
    this.scheduleGc();
  }

  /**
   * 后台触发 `git gc --auto`：**绝不在请求路径上等它**。
   *
   * 每次 upload 都会新建一棵 2000+ 文件的快照树并提交，git 因此持续产生松散对象 ——
   * 实测工作副本 .git 累积到 216MB / 20644 个松散对象，而 gc 从未跑过（仓库与全局都没设
   * gc.auto，git 默认的 auto 阈值（6700 松散对象）在我们的提交模式下也没被触发）。
   * 手动 `git gc --quiet` 要 64s 才把 .git 压回 137MB —— 放在同步请求里等于让用户多等一分钟。
   *
   * 因此：非阻塞 spawn + 单飞标志。gc 只在**网络与落盘都已成功**后触发。
   */
  private scheduleGc(): void {
    if (this.gcRunning) return;
    this.gcRunning = true;
    // detached：不占住本进程的事件循环，宿主退出也不因此挂住
    const child = spawn(this.o.gitBin, ['gc', '--auto', '--quiet'], {
      cwd: this.o.workDir,
      detached: true,
      stdio: 'ignore',
    });
    // 失败不额外上报：gc 是机会性维护，清不掉松散对象不影响任何已完成的同步；
    // git 自己会把 gc 失败写进 <workDir>/.git/gc.log，真需要排查时那里有原始记录。
    child.on('error', () => { this.gcRunning = false; });
    child.on('exit', () => { this.gcRunning = false; });
    child.unref();
  }

  /**
   * 私有仓库可见性探测（结果缓存于 isPrivateHint）：
   * 匿名 ls-remote 成功 → 公开；匿名失败 + 凭据探测成功 → 私有；两者都失败 → 抛错。
   * UI 层可用 isPrivateHint 提示「私有仓库推荐」；公开仓库也可用（内容需自行评估）。
   */
  async checkIsPrivate(): Promise<boolean> {
    if (this.privateHint !== null) return this.privateHint;
    const anon = await this.runGit(['ls-remote', this.o.repoUrl], { allowNonZero: true, cwd: undefined });
    if (anon.code === 0) {
      this.privateHint = false;
      return false;
    }
    const authed = await this.runGit(['ls-remote', this.o.repoUrl], { allowNonZero: true, cwd: undefined, withCredential: true });
    if (authed.code === 0) {
      this.privateHint = true;
      return true;
    }
    throw new GitTransportError(this.msg('sync.git.repoUnreachable', { url: this.mask(this.o.repoUrl, null) }));
  }

  /* ---------------- 内部实现 ---------------- */

  private async ensureRepo(): Promise<void> {
    if (this.repoReady) return;
    const fsx = createSnapshotFs();
    await fsx.mkdir(this.o.workDir); // 不存在则创建
    if (await fsx.exists(path.join(this.o.workDir, '.git'))) {
      this.repoReady = true;
      return;
    }
    const entries = await fsx.readdir(this.o.workDir);
    if (entries.length > 0) {
      throw new GitTransportError(this.msg('sync.git.workDirNotRepo', { dir: this.o.workDir }));
    }
    await this.runGit(['clone', this.o.repoUrl, '.'], { cwd: this.o.workDir, withCredential: true });
    // 仓库级提交身份（写入远端历史，可经 author 选项覆盖；不改全局配置）
    await this.runGit(['config', 'user.name', this.o.author.name]);
    await this.runGit(['config', 'user.email', this.o.author.email]);
    this.repoReady = true;
  }

  /**
   * pull --ff-only 同步远端；无本地提交（全新仓库）或无 upstream 时静默跳过。
   *
   * 拉取前先**复位快照目录**（见 resetSnapshotDirs）：固定路径原地更新后，半途中断留下的是
   * **已跟踪文件的修改**（旧布局只会留下未跟踪的新目录），git 会因「local changes would be
   * overwritten by merge」永久拒绝 pull —— 该拒绝与快照 id 无关，一旦发生通道就彻底锁死。
   */
  private async pullFromRemote(): Promise<void> {
    const head = await this.runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowNonZero: true });
    if (head.code !== 0) return; // 无本地提交 → 无可 pull
    await this.resetSnapshotDirs();
    const res = await this.runGit(['pull', '--ff-only'], { withCredential: true, allowNonZero: true });
    if (res.code === 0) return;
    if (/no tracking information/i.test(res.stderr)) return; // 无 upstream（初始状态）→ 跳过
    throw new GitTransportError(this.msg('sync.git.pullFailed', { err: this.mask(res.stderr, await this.readTokenOnce()) }));
  }

  /**
   * 复位本插件管理的快照目录：已跟踪修改（checkout）+ 未跟踪残留（clean）。
   * 只动这三个目录，不碰工作副本里的其它路径。
   *
   * 逐路径 checkout 而非一次传多个：实测多路径里只要有一个不在 HEAD，git 会整体拒绝
   * （`pathspec did not match any file(s) known to git`），连存在的那条也不恢复。
   */
  private async resetSnapshotDirs(): Promise<void> {
    for (const rel of SNAPSHOT_DIRS) {
      const tracked = await this.runGit(['ls-files', '--', rel], { allowNonZero: true });
      if (tracked.stdout.trim() === '') continue; // 该布局在 HEAD 里不存在 → 无可恢复
      await this.runGit(['checkout', '--', rel]);
    }
    const res = await this.runGit(['clean', '-fd', '--', ...SNAPSHOT_DIRS], { allowNonZero: true });
    if (res.code !== 0) {
      throw new GitTransportError(this.msg('sync.git.cleanFailed', { err: this.mask(res.stderr, await this.readTokenOnce()) }));
    }
  }

  /** 执行 git 命令；withCredential=true 时注入 credential helper（token 不进 argv），失败时错误消息脱敏 */
  private async runGit(
    args: string[],
    opts: { cwd?: string; withCredential?: boolean; allowNonZero?: boolean } = {},
  ): Promise<GitExecResult> {
    const cwd = opts.cwd === undefined ? this.o.workDir : opts.cwd;
    let extra: string[] = this.o.longPaths ? [...LONG_PATHS_ARGS] : [];
    let token: string | null = null;
    let cleanup: (() => Promise<void>) | null = null;
    if (opts.withCredential) {
      const cred = await this.buildCredentialArgs();
      extra = [...extra, ...cred.extraArgs];
      token = cred.token;
      cleanup = cred.cleanup;
    }
    try {
      const result = await this.o.exec(this.o.gitBin, [...extra, ...args], { cwd, timeoutMs: this.o.timeoutMs });
      if (result.code !== 0 && !opts.allowNonZero) {
        throw new GitTransportError(
          this.msg('sync.git.cmdFailed', { args: args.join(' '), code: String(result.code), err: this.mask(result.stderr, token) }),
        );
      }
      return result;
    } finally {
      if (cleanup) await cleanup();
    }
  }

  /**
   * 为网络命令构造 credential helper 参数：
   * 仅 http(s) 远端需要 token；本地路径 / ssh 走 git 原生认证（密钥），不调用 provider。
   * token 写入 os.tmpdir() 下临时 store 文件（权限 0600），命令后立即删除 —— 永不落工作副本/远端。
   */
  private async buildCredentialArgs(): Promise<{ extraArgs: string[]; token: string; cleanup: () => Promise<void> }> {
    if (!/^https?:\/\//i.test(this.o.repoUrl)) {
      return { extraArgs: [], token: '', cleanup: async () => {} };
    }
    const token = await this.o.credentials.getToken();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-git-cred-'));
    const credFile = path.join(tmpDir, 'credential');
    const host = this.repoHost();
    const fileArg = quoteGitValue(credFile.replace(/\\/g, '/'));
    await atomicWriteFile(credFile, `https://${this.o.credentialUsername}:${token}@${host}\n`, { mode: 0o600, symlink: 'reject' });
    return {
      extraArgs: ['-c', 'credential.helper=', '-c', `credential.helper=store --file=${fileArg}`],
      token,
      cleanup: async () => { await fs.rm(tmpDir, { recursive: true, force: true }); },
    };
  }

  /** 从 repoUrl 提取 credential 匹配用的 host[:port] */
  private repoHost(): string {
    try {
      const u = new URL(this.o.repoUrl);
      return u.port ? `${u.hostname}:${u.port}` : u.hostname;
    } catch {
      throw new GitTransportError(this.msg('sync.git.repoUrlInvalid', { url: this.o.repoUrl }));
    }
  }

  /** 读取一次 token（错误消息脱敏用）；非 http(s) 场景返回空 */
  private async readTokenOnce(): Promise<string | null> {
    if (!/^https?:\/\//i.test(this.o.repoUrl)) return null;
    try { return await this.o.credentials.getToken(); } catch { return null; }
  }

  /** 错误/日志脱敏：token（原文与 URL 编码两种形态）与 repoUrl 一律替换 */
  private mask(text: string, token: string | null): string {
    let out = text.split(this.o.repoUrl).join('[REPO_URL]');
    if (token && token.length >= 4) {
      out = out.split(token).join('[REDACTED]').split(encodeURIComponent(token)).join('[REDACTED]');
    }
    return out;
  }

  private assertSafeId(id: string): void {
    if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) {
      throw new GitTransportError(this.msg('sync.git.invalidSnapshotId', { id: JSON.stringify(id) }));
    }
  }

  private snapshotDir(id: string): string {
    return joinFs(this.snapshotsDir(), id);
  }

  /** 固定路径活快照目录（<workDir>/snapshot/） */
  private activeSnapshotDir(): string {
    return joinFs(this.o.workDir, SNAPSHOT_ACTIVE_REL);
  }

  /** 活快照的 id（manifest.json 缺失/损坏 → null） */
  private async readActiveSnapshotId(): Promise<string | null> {
    const m = await this.readDirManifest(this.activeSnapshotDir());
    return m === null ? null : m.id;
  }

  /**
   * stage 指定快照路径（含删除）。
   *
   * 只传 git 认得的路径：`git add -A -- <path>` 对「不存在且从未被跟踪」的路径会以
   * `pathspec did not match any files` 失败（实测），而某个布局目录是否存在取决于上一次同步
   * 的形态（明文/加密）与版本（固定路径/旧布局），故先按存在性或索引跟踪状态过滤。
   */
  private async stageSnapshotPaths(rels: string[]): Promise<void> {
    const fsx = createSnapshotFs();
    const stageable: string[] = [];
    for (const rel of rels) {
      if (await fsx.exists(joinFs(this.o.workDir, rel))) { stageable.push(rel); continue; }
      const tracked = await this.runGit(['ls-files', '--', rel], { allowNonZero: true });
      if (tracked.stdout.trim() !== '') stageable.push(rel);
    }
    if (stageable.length === 0) return;
    await this.runGit(['add', '-A', '--', ...stageable]);
  }

  private snapshotsDir(): string {
    return joinFs(this.o.workDir, SNAPSHOTS_REL);
  }

  /** 加密快照密文单文件目录（<workDir>/snapshots-encrypted/） */
  private encryptedSnapshotsDir(): string {
    return joinFs(this.o.workDir, SNAPSHOTS_ENCRYPTED_REL);
  }

  /** 加密快照密文单文件路径（<id>.json） */
  private encryptedSnapshotFile(id: string): string {
    return joinFs(this.encryptedSnapshotsDir(), `${id}.json`);
  }

  /** 读密文单文件快照（解析失败 → null，调用方跳过，不静默失败整体 list）。 */
  private async readEncryptedSnapshotFile(file: string): Promise<SyncSnapshot | null> {
    try {
      const raw = Buffer.from(await createSnapshotFs().readFile(file)).toString('utf8');
      return deserializeSnapshot(raw);
    } catch {
      return null;
    }
  }

  /** 读快照目录 manifest.json（结构不合法 → null，调用方跳过） */
  private async readDirManifest(dir: string): Promise<SnapshotDirManifest | null> {
    const fsx: SnapshotFs = createSnapshotFs();
    try {
      const abs = joinFs(dir, SNAPSHOT_MANIFEST_FILE);
      if (!(await fsx.exists(abs))) return null;
      const raw = Buffer.from(await fsx.readFile(abs)).toString('utf8');
      const parsed = parseJsonSafe(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      const m = parsed as Record<string, unknown>;
      if (typeof m['id'] !== 'string' || typeof m['createdAt'] !== 'string'
        || m['manifest'] === null || typeof m['manifest'] !== 'object'
        || m['sectionHashes'] === null || typeof m['sectionHashes'] !== 'object') {
        return null;
      }
      return parsed as SnapshotDirManifest;
    } catch {
      return null;
    }
  }
}
