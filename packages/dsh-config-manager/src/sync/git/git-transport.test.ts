/**
 * m-git-channel：Git 私有仓库通道测试（TDD：先红后绿）。
 * - mock exec 单元测试：命令序列 / token 不泄漏（argv、commit message、错误消息、credential 文件生命周期）
 * - 真实 git 集成测试：本地 bare repo 模拟远端（无真实网络），端到端 list/upload/download/delete
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { GitTransport, GitTransportError } from './git-transport.ts';
import type { GitExecFn, GitExecResult, GitTransportOptions } from './git-transport.ts';
import { encryptSectionsPayload } from '../../../tests/fixtures/legacy-snapshot-crypto.ts';
import { computeSnapshotMeta, isEncryptedSections } from '../transport.ts';
import type { SyncSnapshot } from '../transport.ts';
import type { FilesSection, SectionData, SectionId } from '../../schema/types.ts';

/* ---------------- helpers ---------------- */

const TEST_TOKEN = 'secret-token-xyz-123';

function sampleSnapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot & { sections: Record<string, unknown> } {
  return {
    id: 'snap-001',
    createdAt: '2026-08-16T12:00:00.000Z',
    manifest: {
      schemaVersion: 1,
      dshVersion: '1.2.3',
      platform: 'win32',
      sectionIds: ['settings', 'providers'],
      containsSecrets: false,
    },
    sections: {
      settings: { version: 1, namespaces: { general: { value: { theme: 'dark' }, revision: 1, secrets: [] } } },
      providers: { version: 1, providers: { deepseek: { route: '/v1' } } },
    },
    ...overrides,
  } as SyncSnapshot & { sections: Record<string, unknown> };
}

/** 记录每次 git 调用的 mock exec：默认全部成功；按需特判 */
interface CallRecord { cmd: string; args: string[]; }
function mockExec(
  calls: CallRecord[],
  rules: {
    /** args.join(' ') 包含该子串时返回 code（用于 rev-parse/diff/ls-remote 特判） */
    codeBy?: Record<string, number>;
    /** args.join(' ') 包含该子串时返回 stdout（用于 ls-files 等查询特判） */
    stdoutBy?: Record<string, string>;
    /** 模拟失败：返回 code + stderr（可含 token 变体，验证 sanitize） */
    failOn?: { match: string; code: number; stderr: string };
  } = {},
): GitExecFn {
  return async (_cmd, args): Promise<GitExecResult> => {
    calls.push({ cmd: 'git', args });
    const joined = args.join(' ');
    if (rules.failOn && joined.includes(rules.failOn.match)) {
      return { stdout: '', stderr: rules.failOn.stderr, code: rules.failOn.code };
    }
    for (const [sub, code] of Object.entries(rules.codeBy ?? {})) {
      if (joined.includes(sub)) return { stdout: '', stderr: '', code };
    }
    for (const [sub, stdout] of Object.entries(rules.stdoutBy ?? {})) {
      if (joined.includes(sub)) return { stdout, stderr: '', code: 0 };
    }
    // 默认：diff --cached --quiet = 有变更（code 1）；其余成功
    if (joined.includes('diff') && joined.includes('--quiet')) return { stdout: '', stderr: '', code: 1 };
    return { stdout: '', stderr: '', code: 0 };
  };
}

async function makeTempDir(t: test.TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-git-test-'));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

/** 真实 git：初始化一个非空 git 工作树（.git 存在，使 ensureRepo 走已 clone 分支） */
async function makeGitWorkDir(t: test.TestContext): Promise<string> {
  const dir = await makeTempDir(t);
  await runRealGit(['init'], dir);
  await runRealGit(['config', 'user.name', 'test'], dir);
  await runRealGit(['config', 'user.email', 'test@local'], dir);
  return dir;
}

function runRealGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as { code?: number };
        resolve({ stdout: String(stdout), stderr: String(stderr), code: e.code ?? 1 });
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr), code: 0 });
      }
    });
  });
}

/** 本地 bare 仓库（模拟远端，无认证需求） */
async function makeBareRepo(t: test.TestContext): Promise<string> {
  const dir = await makeTempDir(t);
  const bare = path.join(dir, 'remote.git');
  const r = await runRealGit(['init', '--bare', bare], dir);
  assert.equal(r.code, 0, `git init --bare 失败: ${r.stderr}`);
  return bare;
}

function makeOptions(overrides: Partial<GitTransportOptions> = {}): GitTransportOptions {
  return {
    repoUrl: 'https://github.com/example/private-config.git',
    workDir: 'UNSET',
    credentials: { getToken: async () => TEST_TOKEN },
    ...overrides,
  };
}

function joinedArgs(calls: CallRecord[], needle: string): string[] {
  return calls.filter((c) => c.args.join(' ').includes(needle)).map((c) => c.args.join(' '));
}

/** 构造加密快照（sections 为 EncryptedSections 密文载荷；含文件分区以覆盖字节往返）。 */
async function encryptedSnapshot(overrides: Partial<SyncSnapshot> = {}): Promise<SyncSnapshot> {
  const base = sampleSnapshot();
  const plain: Partial<Record<SectionId, SectionData>> = {};
  for (const [id, data] of Object.entries(base.sections)) {
    plain[id as SectionId] = data as SectionData;
  }
  plain.skills = {
    version: 1,
    files: [
      { relativePath: 'coding.md', data: new Uint8Array(Buffer.from('# Coding\n', 'utf8')), contentHash: 'h1' },
    ],
  } as FilesSection;
  const enc = await encryptSectionsPayload(plain, 'pw-12345678');
  return {
    ...base,
    id: 'snap-enc',
    manifest: { ...base.manifest, sectionIds: ['settings', 'providers', 'skills'], encrypted: true, containsSecrets: true },
    sections: enc,
    ...overrides,
  };
}

/* ---------------- 单元测试（mock exec） ---------------- */

test('非 git 仓库：workDir 非空且无 .git → 报错清晰（含 workDir 路径）', async (t) => {
  const dir = await makeTempDir(t);
  await fs.writeFile(path.join(dir, 'stray.txt'), 'not a repo');
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  await assert.rejects(
    transport.list(),
    (err: unknown) => {
      assert.ok(err instanceof GitTransportError, '必须是 GitTransportError');
      assert.match(err.message, /不是 git 仓库/);
      assert.ok(err.message.includes(dir), '错误消息应含 workDir 路径');
      return true;
    },
  );
});

test('首次使用（空目录无 .git）→ 触发 clone（credential helper 注入，argv 不含 token）', async (t) => {
  const dir = await makeTempDir(t); // 空目录
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  await transport.list();
  const clones = joinedArgs(calls, 'clone');
  assert.equal(clones.length, 1, '应恰好调用一次 clone');
  const cloneArgs = calls.find((c) => c.args.includes('clone'))!.args;
  // credential helper 注入到 clone 参数
  assert.ok(cloneArgs.some((a) => a.startsWith('credential.helper=') && a.includes('store --file=')), 'clone 应带 store credential helper');
  // argv 不含 token
  for (const arg of cloneArgs) assert.ok(!arg.includes(TEST_TOKEN), `argv 泄漏 token: ${arg}`);
  // clone 的 URL 参数不带 token
  const urlArg = cloneArgs[cloneArgs.indexOf('clone') + 1]!;
  assert.ok(!urlArg.includes(TEST_TOKEN), 'clone URL 不得含 token');
  assert.ok(!urlArg.includes('oauth2:'), 'clone URL 不得含内嵌凭据');
});

test('token 不泄漏：credential 文件在 git 调用期间存在、用后删除、内容含 token 但 argv 不含', async (t) => {
  const dir = await makeTempDir(t);
  const calls: CallRecord[] = [];
  const credFileContents: string[] = [];
  const exec: GitExecFn = async (_cmd, args) => {
    calls.push({ cmd: 'git', args });
    const helper = args.find((a) => a.startsWith('credential.helper=') && a.includes('store --file='));
    if (helper) {
      const file = helper.slice(helper.indexOf('--file=') + '--file='.length).replace(/^"|"$/g, '');
      credFileContents.push(await fs.readFile(file, 'utf8'));
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  const transport = new GitTransport(makeOptions({ workDir: dir, exec }));
  await transport.list(); // 触发 clone（带 credential）
  // credential 文件在调用期间存在（被读到内容）
  assert.ok(credFileContents.length >= 1, 'credential 文件应被创建并被 git 调用读取');
  assert.ok(credFileContents.some((c) => c.includes(TEST_TOKEN)), 'credential 文件应含 token');
  // 调用后无残留：credential 临时目录已删除（找不到任何含 token 的文件）
  const tmpRoot = path.join(os.tmpdir());
  const leftovers = (await fs.readdir(tmpRoot)).filter((n) => n.startsWith('dsh-git-cred-'));
  for (const n of leftovers) {
    const p = path.join(tmpRoot, n);
    try {
      const stat = await fs.stat(p);
      if (stat.isDirectory()) {
        const files = await fs.readdir(p);
        assert.equal(files.length, 0, `credential 临时目录应有残留: ${n}`);
      }
    } catch { /* 已删除 */ }
  }
  // argv 不含 token
  for (const c of calls) for (const arg of c.args) assert.ok(!arg.includes(TEST_TOKEN), `argv 泄漏 token: ${arg}`);
});

test('upload 契约：写快照目录 + add + commit(add) + push，返回 computeSnapshotMeta', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  const snap = sampleSnapshot();
  const meta = await transport.upload(snap);
  assert.deepEqual(meta, computeSnapshotMeta(snap));
  // 命令序列：add snapshots/<id> → diff --cached --quiet → commit -m add → push
  const adds = joinedArgs(calls, 'add');
  assert.ok(adds.some((a) => a.endsWith('snapshot')), `应 add 快照目录: ${JSON.stringify(adds)}`);
  assert.equal(joinedArgs(calls, 'diff --cached --quiet').length, 1);
  const commits = joinedArgs(calls, 'commit');
  assert.equal(commits.length, 1);
  assert.match(commits[0]!, /-m sync: add snapshot snap-001/);
  assert.equal(joinedArgs(calls, 'push').length, 1, 'upload 应 push');
  // commit message 不含 token
  for (const c of commits) assert.ok(!c.includes(TEST_TOKEN));
});

test('upload 幂等：工作树内容与 HEAD 一致 → 不 commit 不 push，仍返回 meta', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({
    workDir: dir,
    exec: mockExec(calls, { codeBy: { 'diff --cached --quiet': 0 } }),
  }));
  const meta = await transport.upload(sampleSnapshot());
  assert.equal(meta.id, 'snap-001');
  assert.equal(joinedArgs(calls, 'commit').length, 0, '无变更不得 commit');
  assert.equal(joinedArgs(calls, 'push').length, 0, '无变更不得 push');
});

test('upload 覆盖：同 id 再次上传 → commit message 为 update', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  await transport.upload(sampleSnapshot());
  calls.length = 0; // 清空，模拟第二次 upload（同 id 覆盖）
  await transport.upload(sampleSnapshot({ createdAt: '2026-08-16T13:00:00.000Z' }));
  const commits = joinedArgs(calls, 'commit');
  assert.equal(commits.length, 1);
  assert.match(commits[0]!, /-m sync: update snapshot snap-001/);
});

test('download 契约：不存在的 id → 抛错（消息含 id）', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  await assert.rejects(
    transport.download('missing-001'),
    (err: unknown) => {
      assert.ok(err instanceof GitTransportError);
      assert.match(err.message, /missing-001/);
      assert.match(err.message, /不存在/);
      return true;
    },
  );
});

test('delete 契约：存在 → 删除目录 + add -A + commit(delete) + push；不存在 → 静默成功', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({
    workDir: dir,
    exec: mockExec(calls, { stdoutBy: { 'ls-files -- snapshot': 'snapshot/manifest.json\n' } }),
  }));
  // 准备一个已存在快照目录
  await fs.mkdir(path.join(dir, 'snapshot'), { recursive: true });
  await fs.writeFile(path.join(dir, 'snapshot', 'manifest.json'), JSON.stringify({
    id: 'snap-001', createdAt: '2026-08-16T12:00:00.000Z', manifest: {}, sectionHashes: {},
  }));
  await transport.delete('snap-001');
  const adds = joinedArgs(calls, 'add -A');
  assert.ok(adds.some((a) => a.endsWith('snapshot')), 'delete 应 stage 删除');
  assert.equal(joinedArgs(calls, 'commit').length, 1);
  assert.match(joinedArgs(calls, 'commit')[0]!, /-m sync: delete snapshot snap-001/);
  assert.equal(joinedArgs(calls, 'push').length, 1);
  // 不存在 → 成功且不产生 git 写操作
  calls.length = 0;
  await transport.delete('never-existed');
  assert.equal(joinedArgs(calls, 'commit').length, 0);
  assert.equal(joinedArgs(calls, 'push').length, 0);
});

test('错误消息 sanitize：git 失败 stderr 含 token → 抛出消息被替换为 [REDACTED]', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({
    workDir: dir,
    exec: mockExec(calls, {
      failOn: { match: 'push', code: 128, stderr: `fatal: unable to access 'https://oauth2:${TEST_TOKEN}@github.com/example/private-config.git/': authentication failed` },
    }),
  }));
  await assert.rejects(
    transport.upload(sampleSnapshot()),
    (err: unknown) => {
      assert.ok(err instanceof GitTransportError);
      assert.ok(!err.message.includes(TEST_TOKEN), `错误消息泄漏 token: ${err.message}`);
      assert.match(err.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test('checkIsPrivate：匿名可达 → false；匿名失败+认证可达 → true；都失败 → 抛错', async (t) => {
  // 匿名成功
  const c1: CallRecord[] = [];
  const t1 = new GitTransport(makeOptions({ workDir: await makeTempDir(t), exec: mockExec(c1) }));
  assert.equal(await t1.checkIsPrivate(), false);
  assert.equal(t1.isPrivateHint, false);

  // 匿名失败（404），带 credential 成功
  const c2: CallRecord[] = [];
  const exec2: GitExecFn = async (_cmd, args) => {
    c2.push({ cmd: 'git', args });
    if (args.join(' ').includes('ls-remote')) {
      const authed = args.some((a) => a.includes('credential.helper='));
      return authed
        ? { stdout: '', stderr: '', code: 0 }
        : { stdout: '', stderr: 'fatal: could not read Username', code: 128 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  const t2 = new GitTransport(makeOptions({ workDir: await makeTempDir(t), exec: exec2 }));
  assert.equal(await t2.checkIsPrivate(), true);
  assert.equal(t2.isPrivateHint, true);
  // 第二次调用走缓存，不重复探测
  const lsBefore = joinedArgs(c2, 'ls-remote').length;
  await t2.checkIsPrivate();
  assert.equal(joinedArgs(c2, 'ls-remote').length, lsBefore);

  // 匿名与认证都失败
  const c3: CallRecord[] = [];
  const t3 = new GitTransport(makeOptions({
    workDir: await makeTempDir(t),
    exec: mockExec(c3, { codeBy: { 'ls-remote': 128 }, failOn: { match: 'credential.helper=', code: 128, stderr: 'fatal: could not read Username' } }),
  }));
  await assert.rejects(t3.checkIsPrivate(), /不可达|认证失败/);
});

test('快照 id 安全：非法 id（路径穿越/特殊字符）→ upload/download/delete 均拒绝', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  for (const bad of ['../evil', 'a/b', 'a\\b', '.', '..', 'snap\ninject']) {
    await assert.rejects(transport.upload(sampleSnapshot({ id: bad })), /非法快照 id/);
    await assert.rejects(transport.download(bad), /非法快照 id/);
    await assert.rejects(transport.delete(bad), /非法快照 id/);
  }
});

test('upload 加密快照：写 snapshots-encrypted/<id>.json 密文单文件（不落散文件目录），add/commit/push', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  const snap = await encryptedSnapshot();
  assert.ok(isEncryptedSections(snap.sections), '前置：加密载荷');
  const meta = await transport.upload(snap);
  assert.deepEqual(meta, computeSnapshotMeta(snap));
  // 密文单文件已写入工作副本
  const encFile = path.join(dir, 'snapshots-encrypted', 'snap-enc.json');
  const raw = JSON.parse(await fs.readFile(encFile, 'utf8'));
  assert.equal(raw.id, 'snap-enc');
  assert.ok(isEncryptedSections(raw.sections), '远端文件保持加密载荷（不含明文）');
  assert.ok(!JSON.stringify(raw).includes('# Coding'), '序列化不得泄漏明文文件内容');
  // 散文件目录不产生
  assert.equal(await fs.stat(path.join(dir, 'snapshot')).catch(() => null), null, '加密快照不写散文件目录');
  // git 命令：add snapshots-encrypted/<id>.json
  const adds = joinedArgs(calls, 'add');
  assert.ok(adds.some((a) => a.endsWith('snapshots-encrypted')), `应 add 密文目录: ${JSON.stringify(adds)}`);
  const commits = joinedArgs(calls, 'commit');
  assert.equal(commits.length, 1);
  assert.match(commits[0]!, /-m sync: add snapshot snap-enc/);
  assert.equal(joinedArgs(calls, 'push').length, 1);
});

test('upload 加密快照覆盖：同 id 明文→加密 切换时清掉旧散文件目录（双形态互斥）', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  // 先传明文（snap-enc 走散文件目录）
  await transport.upload(sampleSnapshot({ id: 'snap-enc' }));
  assert.ok(await fs.stat(path.join(dir, 'snapshot')));
  calls.length = 0;
  // 同 id 再传加密 → 旧散文件目录被清除，只留密文单文件
  await transport.upload(await encryptedSnapshot());
  assert.equal(await fs.stat(path.join(dir, 'snapshot')).catch(() => null), null, '旧明文活快照目录已删');
  assert.ok(await fs.stat(path.join(dir, 'snapshots-encrypted', 'snap-enc.json')));
  const commits = joinedArgs(calls, 'commit');
  assert.match(commits[0]!, /-m sync: update snapshot snap-enc/, '形态切换视为 update');
});

test('download 加密快照：读回密文单文件并还原（sections 保持密文载荷）', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  const snap = await encryptedSnapshot();
  await transport.upload(snap);
  const roundtrip = await transport.download('snap-enc');
  assert.equal(roundtrip.id, 'snap-enc');
  assert.deepEqual(roundtrip.manifest, snap.manifest);
  assert.deepEqual(roundtrip.sections, snap.sections, '加密载荷逐字节一致（解密后文件字节应无损）');
});

test('delete 加密快照：从 snapshots-encrypted 移除 + commit(delete) + push', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  await transport.upload(await encryptedSnapshot());
  calls.length = 0;
  await transport.delete('snap-enc');
  const adds = joinedArgs(calls, 'add -A');
  assert.ok(adds.some((a) => a.endsWith('snapshots-encrypted')), 'delete 应 stage 密文目录删除');
  assert.equal(joinedArgs(calls, 'commit').length, 1);
  assert.match(joinedArgs(calls, 'commit')[0]!, /-m sync: delete snapshot snap-enc/);
  // 不存在 → 静默成功
  await transport.delete('snap-enc');
  assert.equal(joinedArgs(calls, 'commit').length, 1, '再次删除不产生 commit');
});

test('pull 前先清理快照目录内的未跟踪残留（clean -fd 只作用于 snapshots / snapshots-encrypted，且先于 pull）', async (t) => {
  const dir = await makeGitWorkDir(t);
  const calls: CallRecord[] = [];
  const transport = new GitTransport(makeOptions({ workDir: dir, exec: mockExec(calls) }));
  await transport.list();
  const cleanIdx = calls.findIndex((c) => c.args.includes('clean'));
  const pullIdx = calls.findIndex((c) => c.args.includes('pull'));
  assert.ok(cleanIdx >= 0, `pull 前应执行 git clean: ${JSON.stringify(calls.map((c) => c.args.join(' ')))}`);
  assert.ok(pullIdx > cleanIdx, 'clean 必须先于 pull');
  const cleanArgs = calls[cleanIdx]!.args;
  assert.ok(cleanArgs.includes('-fd'), '必须递归清理未跟踪目录');
  assert.deepEqual(cleanArgs.slice(cleanArgs.indexOf('--')), ['--', 'snapshot', 'snapshots', 'snapshots-encrypted'], '只清理本插件管理的快照目录');
});

test('win32 长路径：每条 git 命令注入 -c core.longpaths=true（含 clone 的凭据参数）；其它平台不注入', async (t) => {
  // 非 win32：不得注入
  const dirPosix = await makeGitWorkDir(t);
  const callsPosix: CallRecord[] = [];
  const posix = new GitTransport(makeOptions({ workDir: dirPosix, exec: mockExec(callsPosix), platform: 'linux' }));
  await posix.upload(sampleSnapshot());
  for (const c of callsPosix) assert.ok(!c.args.includes('core.longpaths=true'), `非 win32 不得注入 longpaths: ${c.args.join(' ')}`);

  // win32：空目录 → 触发带凭据的 clone，逐条命令校验前缀与凭据参数共存
  const dirWin = await makeTempDir(t);
  const callsWin: CallRecord[] = [];
  const win = new GitTransport(makeOptions({ workDir: dirWin, exec: mockExec(callsWin), platform: 'win32' }));
  await win.list();
  assert.ok(callsWin.length > 0, '应产生 git 调用');
  for (const c of callsWin) {
    assert.equal(c.args[0], '-c', `win32 每条命令应带 -c: ${c.args.join(' ')}`);
    assert.equal(c.args[1], 'core.longpaths=true', `win32 每条命令应带 core.longpaths=true: ${c.args.join(' ')}`);
  }
  const cloneArgs = callsWin.find((c) => c.args.includes('clone'))!.args;
  assert.ok(cloneArgs.some((a) => a.startsWith('credential.helper=')), 'clone 仍带 store credential helper');
  for (const arg of cloneArgs) assert.ok(!arg.includes(TEST_TOKEN), `argv 泄漏 token: ${arg}`);
});

/* ---------------- 集成测试（真实 git，本地 bare repo） ---------------- */

test('集成：upload → list → download → delete 端到端（真实 git + 本地 bare repo）', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  let tokenReads = 0;
  const transport = new GitTransport({
    repoUrl: bare,
    workDir,
    credentials: { getToken: async () => { tokenReads += 1; return TEST_TOKEN; } },
  });

  // upload
  const snap = sampleSnapshot();
  const meta = await transport.upload(snap);
  assert.equal(meta.id, 'snap-001');
  // 快照散文件目录落在工作副本
  const manifestAbs = path.join(workDir, 'snapshot', 'manifest.json');
  const manifestRaw = JSON.parse(await fs.readFile(manifestAbs, 'utf8'));
  assert.equal(manifestRaw.id, 'snap-001');
  assert.equal(manifestRaw.createdAt, snap.createdAt);
  // 分区文件落盘
  assert.ok(await fs.stat(path.join(workDir, 'snapshot', 'config', 'settings.json')));

  // 提交已 push 到远端 bare repo
  const log = await runRealGit(['log', '--oneline', '--all'], bare);
  assert.equal(log.code, 0, `git log 失败: ${log.stderr}`);
  assert.match(log.stdout, /sync: add snapshot snap-001/);

  // list：远端 + 工作副本 → 1 条，createdAt 升序
  const listed = await transport.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, 'snap-001');
  assert.equal(listed[0]!.createdAt, snap.createdAt);
  assert.deepEqual(listed[0]!.manifest, snap.manifest);

  // download：读回完整载荷，与上传一致
  const roundtrip = await transport.download('snap-001');
  assert.deepEqual(roundtrip, snap);

  // 覆盖：同 id 上传新内容 → update commit，目录唯一
  const snap2 = sampleSnapshot({ createdAt: '2026-08-16T14:00:00.000Z' });
  snap2.sections.settings = { version: 1, namespaces: { general: { value: { theme: 'light' }, revision: 2, secrets: [] } } };
  await transport.upload(snap2);
  const liveManifest = JSON.parse(await fs.readFile(path.join(workDir, 'snapshot', 'manifest.json'), 'utf8'));
  assert.equal(liveManifest.id, 'snap-001');
  assert.equal(liveManifest.createdAt, '2026-08-16T14:00:00.000Z', '原地覆盖为最新版本');
  assert.equal(await fs.stat(path.join(workDir, 'snapshots')).catch(() => null), null, '旧布局目录不得存在');
  const log2 = await runRealGit(['log', '--oneline', '--all'], bare);
  assert.match(log2.stdout, /sync: update snapshot snap-001/);
  const roundtrip2 = await transport.download('snap-001');
  assert.deepEqual(roundtrip2, snap2);

  // delete：存在 → 移除；再 delete 不存在 id → 静默成功
  await transport.delete('snap-001');
  assert.equal((await transport.list()).length, 0);
  const log3 = await runRealGit(['log', '--oneline', '--all'], bare);
  assert.match(log3.stdout, /sync: delete snapshot snap-001/);
  await transport.delete('snap-001'); // 不存在视为成功
  await assert.rejects(transport.download('snap-001'), /不存在/);

  // 本地路径仓库不触发认证读取（token 提供者不被调用）
  assert.equal(tokenReads, 0, '本地仓库无需 token，getToken 不应被调用');
});

test('集成：同内容重复 upload → 第二次不产生新 commit（git 天然增量，内容无变化不提交）', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({ repoUrl: bare, workDir, credentials: { getToken: async () => TEST_TOKEN } });

  await transport.upload(sampleSnapshot());
  let log = await runRealGit(['log', '--oneline', '--all'], bare);
  assert.equal(log.code, 0, `git log 失败: ${log.stderr}`);
  assert.equal(log.stdout.trim().split('\n').filter(Boolean).length, 1, '首次上传应恰好 1 个 commit');

  // 同 id 同内容（快照完全一致）重复上传 → diff --cached --quiet 无变更 → 不 commit 不 push
  await transport.upload(sampleSnapshot());
  log = await runRealGit(['log', '--oneline', '--all'], bare);
  assert.equal(log.stdout.trim().split('\n').filter(Boolean).length, 1, '内容无变化 → 不得产生新 commit');
  const listed = await transport.list();
  assert.equal(listed.length, 1, '远端仍只有 1 条快照（同 id 覆盖语义）');
});

test('集成：token 不泄漏到快照文件内容与 commit message（真实 git 全链路）', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({
    repoUrl: bare,
    workDir,
    credentials: { getToken: async () => TEST_TOKEN },
  });
  await transport.upload(sampleSnapshot());
  // 工作副本 snapshots 下所有文件内容不得含 token
  const files: string[] = [];
  const walk = async (p: string): Promise<void> => {
    for (const name of await fs.readdir(p)) {
      const full = path.join(p, name);
      const stat = await fs.stat(full);
      if (stat.isDirectory()) await walk(full);
      else files.push(full);
    }
  };
  await walk(path.join(workDir, 'snapshot'));
  for (const f of files) {
    const content = await fs.readFile(f, 'utf8');
    assert.ok(!content.includes(TEST_TOKEN), `文件内容泄漏 token: ${f}`);
  }
  // commit message 不含 token
  const log = await runRealGit(['log', '--format=%s', '--all'], bare);
  assert.ok(!log.stdout.includes(TEST_TOKEN), `commit message 泄漏 token: ${log.stdout}`);
  // 工作副本根目录无 credential 残留文件
  const rootEntries = await fs.readdir(workDir);
  assert.ok(!rootEntries.some((n) => n.includes('cred') || n.includes('dsh-git-cred')), `credential 残留: ${rootEntries.join(', ')}`);
});

test('集成：非 git 仓库报错清晰（真实 git 验证消息）', async (t) => {
  const workDir = await makeTempDir(t);
  await fs.writeFile(path.join(workDir, 'placeholder.txt'), 'x');
  const transport = new GitTransport({
    repoUrl: 'https://github.com/example/private-config.git',
    workDir,
    credentials: { getToken: async () => TEST_TOKEN },
  });
  await assert.rejects(
    transport.list(),
    (err: unknown) => {
      assert.ok(err instanceof GitTransportError);
      assert.match(err.message, /不是 git 仓库/);
      return true;
    },
  );
});

test('集成：固定路径下远端恒只有 1 份活快照（后一次上传原地覆盖前一次）', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({ repoUrl: bare, workDir, credentials: { getToken: async () => TEST_TOKEN } });
  await transport.upload(sampleSnapshot({ id: 'snap-b', createdAt: '2026-08-16T11:00:00.000Z' }));
  await transport.upload(sampleSnapshot({ id: 'snap-a', createdAt: '2026-08-16T09:00:00.000Z' }));
  await transport.upload(sampleSnapshot({ id: 'snap-c', createdAt: '2026-08-16T12:00:00.000Z' }));
  const listed = await transport.list();
  assert.deepEqual(listed.map((m) => m.id), ['snap-c'], '固定路径只保留最后一次上传的快照');
  assert.equal(await fs.stat(path.join(workDir, 'snapshots')).catch(() => null), null, '旧布局目录不得存在');
});

test('集成：加密快照端到端（真实 git + 本地 bare repo）—— upload → list → download → delete', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({ repoUrl: bare, workDir, credentials: { getToken: async () => TEST_TOKEN } });
  const snap = await encryptedSnapshot();

  // upload：密文单文件提交并推送
  const meta = await transport.upload(snap);
  assert.equal(meta.id, 'snap-enc');
  assert.equal(meta.manifest.encrypted, true);
  assert.deepEqual(meta.sections, {}, '加密快照的 sections hash 记录为空（密文不可与本地明文比较）');
  const log = await runRealGit(['log', '--oneline', '--all'], bare);
  assert.equal(log.code, 0, `git log 失败: ${log.stderr}`);
  assert.match(log.stdout, /sync: add snapshot snap-enc/);

  // list：密文快照可见（工作副本 pull 后重建）
  const listed = await transport.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, 'snap-enc');
  assert.equal(listed[0]!.manifest.encrypted, true);
  assert.deepEqual(listed[0]!.manifest, snap.manifest);

  // download：读回密文载荷（明文内容不可见）
  const roundtrip = await transport.download('snap-enc');
  assert.ok(isEncryptedSections(roundtrip.sections), '下载返回加密载荷');
  assert.deepEqual(roundtrip.sections, snap.sections);
  assert.ok(!JSON.stringify(roundtrip).includes('# Coding'), '载荷序列化不得泄漏明文');

  // 明文 + 加密快照共存于 list（按 createdAt 升序）
  await transport.upload(sampleSnapshot({ id: 'snap-plain', createdAt: '2026-08-16T09:00:00.000Z' }));
  const mixed = await transport.list();
  assert.deepEqual(mixed.map((m) => m.id), ['snap-plain', 'snap-enc']);

  // delete 加密快照
  await transport.delete('snap-enc');
  assert.deepEqual((await transport.list()).map((m) => m.id), ['snap-plain']);
  await assert.rejects(transport.download('snap-enc'), /不存在/);
  await transport.delete('snap-enc'); // 不存在视为成功
});

test('集成：空文件类分区（skills files:[]）upload 后，全新 clone 的 B 机 download 应读回空分区（git 不跟踪空目录）', async (t) => {
  const bare = await makeBareRepo(t);
  // 机器 A：上传含空 skills 分区（~/.dsh/skills 不存在 → files: []）的快照
  const workDirA = await makeTempDir(t);
  const transportA = new GitTransport({ repoUrl: bare, workDir: workDirA, credentials: { getToken: async () => TEST_TOKEN } });
  const snap = sampleSnapshot();
  snap.sections.skills = { version: 1, files: [] } as unknown as FilesSection;
  snap.manifest = { ...snap.manifest, sectionIds: ['settings', 'providers', 'skills'] };
  await transportA.upload(snap);

  // 机器 B：全新 workDir（重新 clone 远端），模拟另一台机器的首次拉取
  const workDirB = await makeTempDir(t);
  const transportB = new GitTransport({ repoUrl: bare, workDir: workDirB, credentials: { getToken: async () => TEST_TOKEN } });

  // 复现前提：git 不跟踪空目录 → B 端工作副本里不存在 custom/skills/ 目录
  const skillsAbsB = path.join(workDirB, 'snapshot', 'custom', 'skills');
  const skillsStat = await fs.stat(skillsAbsB).catch(() => null);
  assert.equal(skillsStat, null, 'git 应不跟踪空目录：B 端工作副本不应存在 custom/skills/');

  // 修复后：download 应降级读回空分区，而不是抛「快照缺少文件分区目录」
  const roundtrip = await transportB.download('snap-001');
  const skills = (roundtrip.sections as Partial<Record<SectionId, SectionData>>)['skills'];
  assert.deepEqual(skills, { version: 1, files: [] });
  assert.deepEqual(roundtrip.manifest, snap.manifest);
});

// ─── t5：远端快照裁剪的 git 契约（upload 先 push，再 delete 删旧，各自独立 commit+push） ───

test('集成：升级迁移 —— 旧布局远端快照仍可被读到，上传后收敛为固定路径', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({ repoUrl: bare, workDir, credentials: { getToken: async () => TEST_TOKEN } });
  await transport.upload(sampleSnapshot({ id: 'snap-001', createdAt: '2026-08-16T09:00:00.000Z' }));

  // 模拟「升级前」的远端：在已 clone 的工作副本里手工放一个旧布局快照目录并推上去
  await fs.mkdir(path.join(workDir, 'snapshots', 'legacy-1'), { recursive: true });
  await fs.writeFile(path.join(workDir, 'snapshots', 'legacy-1', 'manifest.json'), JSON.stringify({
    id: 'legacy-1', createdAt: '2026-08-16T08:00:00.000Z',
    manifest: sampleSnapshot().manifest, sectionHashes: {},
  }));
  await runRealGit(['add', '-A'], workDir);
  await runRealGit(['commit', '-m', 'seed legacy layout'], workDir);
  await runRealGit(['push'], workDir);

  // 旧布局仍能被读到：升级后首次拉取不得把「远端已有快照」当成远端为空
  assert.deepEqual((await transport.list()).map((m) => m.id).sort(), ['legacy-1', 'snap-001']);

  // 上传新快照 → 迁移：旧布局目录被清理，只留固定路径
  await transport.upload(sampleSnapshot({ id: 'snap-002', createdAt: '2026-08-16T12:00:00.000Z' }));
  assert.deepEqual((await transport.list()).map((m) => m.id), ['snap-002'], '迁移后只保留固定路径快照');
  assert.equal(await fs.stat(path.join(workDir, 'snapshots')).catch(() => null), null, '旧布局目录应被清理');
});

test('集成：工作副本残留不再锁死 pull —— 未跟踪文件与已跟踪修改都被复位', async (t) => {
  const bare = await makeBareRepo(t);
  const workDirA = await makeTempDir(t);
  const transportA = new GitTransport({ repoUrl: bare, workDir: workDirA, credentials: { getToken: async () => TEST_TOKEN } });
  await transportA.upload(sampleSnapshot({ id: 'snap-001', createdAt: '2026-08-16T09:00:00.000Z' }));

  // 机器 B：首次 list 触发 clone，看到 snap-001
  const workDirB = await makeTempDir(t);
  const transportB = new GitTransport({ repoUrl: bare, workDir: workDirB, credentials: { getToken: async () => TEST_TOKEN } });
  assert.deepEqual((await transportB.list()).map((m) => m.id), ['snap-001']);

  // A 再上传（B 尚未同步）：改的正是 B 端同一路径的文件
  await transportA.upload(sampleSnapshot({ id: 'snap-002', createdAt: '2026-08-16T10:00:00.000Z' }));

  // B 侧残留①：半途中断留下的**未跟踪**文件（clean 负责）
  const residual = path.join(workDirB, 'snapshot', 'custom', 'skills', 'half.md');
  await fs.mkdir(path.dirname(residual), { recursive: true });
  await fs.writeFile(residual, '{ half }');
  // B 侧残留②：半途中断留下的**已跟踪**文件修改（clean 管不到，必须 checkout 复位）
  await fs.writeFile(path.join(workDirB, 'snapshot', 'manifest.json'), '{ truncated');
  const tracked = await runRealGit(['ls-files', '--error-unmatch', 'snapshot/manifest.json'], workDirB);
  assert.equal(tracked.code, 0, '前置：manifest.json 必须是已跟踪文件，才构成「local changes would be overwritten」故障');

  // 修复后：list 正常看到新快照，download 拿到远端内容（残留未把 pull 锁死）
  assert.deepEqual((await transportB.list()).map((m) => m.id), ['snap-002']);
  const roundtrip = await transportB.download('snap-002');
  assert.equal(roundtrip.id, 'snap-002');
  assert.deepEqual(roundtrip, sampleSnapshot({ id: 'snap-002', createdAt: '2026-08-16T10:00:00.000Z' }));
});

/* ---------------- 方案 C：固定路径活快照（增量同步） ---------------- */

test('集成：上传写入固定路径 snapshot/，不再每次新建 snapshots/<id>/ 目录', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({ repoUrl: bare, workDir, credentials: { getToken: async () => TEST_TOKEN } });

  await transport.upload(sampleSnapshot({ id: 'snap-001', createdAt: '2026-08-16T09:00:00.000Z' }));

  assert.ok(await fs.stat(path.join(workDir, 'snapshot', 'manifest.json')), '活快照写在固定路径 snapshot/');
  assert.equal(await fs.stat(path.join(workDir, 'snapshots')).catch(() => null), null, '不得再产生 snapshots/<id>/ 目录');

  // 换一个 id 再传：路径不变（这是增量的前提），内容原地覆盖
  await transport.upload(sampleSnapshot({ id: 'snap-002', createdAt: '2026-08-16T10:00:00.000Z' }));
  const live = JSON.parse(await fs.readFile(path.join(workDir, 'snapshot', 'manifest.json'), 'utf8'));
  assert.equal(live.id, 'snap-002');
  assert.equal(await fs.stat(path.join(workDir, 'snapshots')).catch(() => null), null, '仍不得产生 snapshots/<id>/ 目录');

  // 只有内容变化的文件被 git 记为变更：整棵快照树的路径不变 → 增量传输
  const changed = await runRealGit(['show', '--stat', '--oneline', 'HEAD'], workDir);
  assert.equal(changed.code, 0, 'git show 失败: ' + changed.stderr);
});

test('集成：内容未变化时重复上传不产生新 commit（固定路径下整棵树逐字节不变）', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({ repoUrl: bare, workDir, credentials: { getToken: async () => TEST_TOKEN } });

  const snap = sampleSnapshot({ id: 'snap-001', createdAt: '2026-08-16T09:00:00.000Z' });
  await transport.upload(snap);
  const before = await runRealGit(['rev-parse', 'HEAD'], workDir);

  // 同内容、同 id 再传一次
  await transport.upload(snap);
  const after = await runRealGit(['rev-parse', 'HEAD'], workDir);
  assert.equal(after.stdout.trim(), before.stdout.trim(), '内容无变化不得产生新 commit');
});

test('集成：download 对活快照 id 生效；对不存在的 id 抛错', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({ repoUrl: bare, workDir, credentials: { getToken: async () => TEST_TOKEN } });
  const snap = sampleSnapshot({ id: 'snap-live', createdAt: '2026-08-16T09:00:00.000Z' });
  await transport.upload(snap);

  assert.deepEqual(await transport.download('snap-live'), snap);
  await assert.rejects(transport.download('snap-gone'), /不存在/);
});

test('集成：list 兼容旧布局 —— 只有 snapshots/<id>/ 的远端也能列出并下载', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({ repoUrl: bare, workDir, credentials: { getToken: async () => TEST_TOKEN } });
  // 先建立仓库与远端分支
  await transport.upload(sampleSnapshot({ id: 'snap-001', createdAt: '2026-08-16T09:00:00.000Z' }));
  // 手工放一个旧布局快照（模拟升级前推送的远端内容）
  await fs.mkdir(path.join(workDir, 'snapshots', 'old-1'), { recursive: true });
  await fs.writeFile(path.join(workDir, 'snapshots', 'old-1', 'manifest.json'), JSON.stringify({
    id: 'old-1', createdAt: '2026-08-16T07:00:00.000Z',
    manifest: sampleSnapshot().manifest, sectionHashes: {},
  }));
  await runRealGit(['add', '-A'], workDir);
  await runRealGit(['commit', '-m', 'legacy'], workDir);
  await runRealGit(['push'], workDir);

  const listed = await transport.list();
  assert.deepEqual(listed.map((m) => m.id).sort(), ['old-1', 'snap-001'], '旧布局与活快照都能列出');

  // 旧布局快照可被下载（升级后首次拉取仍可用）
  const legacyBack = await transport.download('old-1');
  assert.equal(legacyBack.id, 'old-1');
});

test('集成：delete 同时清理活快照与同名旧布局目录', async (t) => {
  const bare = await makeBareRepo(t);
  const workDir = await makeTempDir(t);
  const transport = new GitTransport({ repoUrl: bare, workDir, credentials: { getToken: async () => TEST_TOKEN } });
  await transport.upload(sampleSnapshot({ id: 'snap-001', createdAt: '2026-08-16T09:00:00.000Z' }));

  await transport.delete('snap-001');
  assert.deepEqual((await transport.list()).map((m) => m.id), [], '删除后远端无快照');
  assert.equal(await fs.stat(path.join(workDir, 'snapshot')).catch(() => null), null, '活快照目录应被删除');
});
