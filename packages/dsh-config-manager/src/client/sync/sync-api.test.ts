/**
 * m-sync-ui：SyncApi（/api/dsh-config-manager/sync/*）请求契约测试。
 * 用全局 fetch mock 验证 status/push/pull 的路径/方法/请求体与响应解析（含 4xx 错误映射）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ConfigManagerApiError } from '../api.ts';
import { SYNC_API, SYNC_WEBDAV_CREDENTIAL_REF, SyncApi } from './sync-api.ts';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function installFetchMock(handler: (call: FetchCall) => Response): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    return handler({ url: String(input), init });
  }) as typeof fetch;
  test.after(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('S-01 api.status()：GET 到 /sync/status，解析配置/凭据/上次同步', async () => {
  const body = {
    ok: true, configured: true, repoUrl: 'https://github.com/u/r.git',
    credentialConfigured: true, credentialWritable: true,
    lastSyncAt: '2026-08-16T10:30:00.000Z', sectionCount: 3,
    transport: { type: 'git', ref: 'main' },
  };
  let called: FetchCall | null = null;
  installFetchMock((call) => {
    called = call;
    return jsonResponse(200, body);
  });
  // 经读取函数解除闭包赋值导致的 CFA 窄化（called 在回调内赋值，外部保持 null 窄化）
  const lastCall = (): FetchCall | null => called;

  const api = new SyncApi();
  const result = await api.status();
  assert.equal(result.configured, true);
  assert.equal(result.repoUrl, 'https://github.com/u/r.git');
  assert.equal(result.credentialConfigured, true);
  assert.equal(lastCall()?.url, SYNC_API.status);
  assert.equal(lastCall()?.init?.method, undefined, 'GET 不设 method');
});

test('S-02 api.push()：POST /sync/push，请求体携带 repoUrl/token', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, snapshotId: 'sync-1', sections: ['settings'], warnings: [] });
  });

  const api = new SyncApi();
  const result = await api.push({ repoUrl: 'https://github.com/u/r.git', token: 'ghp_secret' });
  assert.equal(result.ok, true);
  assert.equal(result.snapshotId, 'sync-1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, SYNC_API.push);
  assert.equal(calls[0]?.init?.method, 'POST');
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['repoUrl'], 'https://github.com/u/r.git');
  assert.equal(sent['token'], 'ghp_secret');
  assert.equal(sent['gitBin'], undefined);
});

test('S-03 api.pull()：POST /sync/pull（恒 replace 直接覆盖本地），响应含写入分区与回滚入口', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, {
      ok: true, snapshotId: 'sync-9',
      applied: ['settings'],
      changes: [{ id: 'a', adapter: 'settings', kind: 'Update', description: '更新', severity: 'info' }],
      restoreId: 'rest-9',
      rolledBack: false,
      warnings: [],
      failed: [],
      needsRestart: false,
    });
  });

  const api = new SyncApi();
  const result = await api.pull({ repoUrl: 'https://github.com/u/r.git' });
  assert.deepEqual(result.applied, ['settings']);
  assert.equal(result.restoreId, 'rest-9');
  assert.equal(result.changes[0]?.kind, 'Update');
  assert.equal(calls[0]?.url, SYNC_API.pull);
  // 不再有差异确认参数：请求体只带通道配置
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['strategy'], undefined);
});

test('S-04 错误映射：4xx 携带 error → ConfigManagerApiError', async () => {
  installFetchMock(() => jsonResponse(400, { error: 'repoUrl is required' }));
  const api = new SyncApi();
  await assert.rejects(api.push({ repoUrl: '' }), (err: unknown) => {
    assert.ok(err instanceof ConfigManagerApiError);
    assert.match(err.message, /repoUrl is required/);
    return true;
  });
});

test('S-05 服务未挂载：404（非 JSON 体）→ ConfigManagerApiError 提示插件未加载', async () => {
  // 路由不存在时宿主返回 404 但无 JSON error → readJson 兜底为「插件未挂载」提示
  installFetchMock(() => new Response('Not Found', { status: 404 }));
  const api = new SyncApi();
  await assert.rejects(api.status(), (err: unknown) => {
    assert.ok(err instanceof ConfigManagerApiError);
    assert.match(err.message, /未挂载/);
    return true;
  });
});

/* ------------------------------------------------ GitHub OAuth device flow 契约 */

test('S-06 api.githubStart()：POST /sync/github/start，解析 flowId/userCode/授权页', async () => {
  const body = {
    flowId: 'flow-1', userCode: 'ABCD-EFGH',
    verificationUri: 'https://github.com/login/device', expiresIn: 900, interval: 5,
  };
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, body);
  });

  const api = new SyncApi();
  const result = await api.githubStart();
  assert.equal(result.flowId, 'flow-1');
  assert.equal(result.userCode, 'ABCD-EFGH');
  assert.equal(result.verificationUri, 'https://github.com/login/device');
  assert.equal(calls[0]?.url, SYNC_API.githubStart);
  assert.equal(calls[0]?.init?.method, 'POST');
});

test('S-07 api.githubPoll()：POST /sync/github/poll 携带 flowId；pending 透传 pollDelayMs', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { status: 'pending', pollDelayMs: 5000 });
  });

  const api = new SyncApi();
  const result = await api.githubPoll('flow-1');
  assert.equal(result.status, 'pending');
  assert.equal(result.pollDelayMs, 5000);
  assert.equal(calls[0]?.url, SYNC_API.githubPoll);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['flowId'], 'flow-1');
});

test('S-08 api.githubPoll() 成功 → 响应只含状态，token 永不回传', async () => {
  installFetchMock(() => jsonResponse(200, { status: 'success', credentialConfigured: true }));
  const api = new SyncApi();
  const result = await api.githubPoll('flow-1');
  assert.equal(result.status, 'success');
  assert.equal(result.credentialConfigured, true);
  assert.equal('accessToken' in result, false, '响应契约不得携带 access token 字段');
  assert.equal('token' in result, false);
});

test('S-09 api.githubCancel()：POST /sync/github/cancel 携带 flowId', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true });
  });
  const api = new SyncApi();
  const result = await api.githubCancel('flow-1');
  assert.equal(result.ok, true);
  assert.equal(calls[0]?.url, SYNC_API.githubCancel);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['flowId'], 'flow-1');
});
/* ------------------------------------------------ WebDAV 通道契约 */

test('S-17 WebDAV 密码凭据引用名常量存在', () => {
  assert.equal(SYNC_WEBDAV_CREDENTIAL_REF, 'DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD');
});

test('S-18 api.status()：webdav 通道 → 解析 webdav 配置状态（url/username/usernameConfigured/passwordConfigured，无 secret 值）', async () => {
  const body = {
    ok: true, configured: true, credentialConfigured: false, credentialWritable: true,
    webdav: {
      url: 'https://dav.example.com/dav/config', username: 'alice', usernameConfigured: true, passwordConfigured: true,
    },
    lastSyncAt: '2026-08-16T10:30:00.000Z', sectionCount: 2,
    transport: { type: 'webdav', ref: 'https://dav.example.com/dav/config' },
  };
  let called: FetchCall | null = null;
  installFetchMock((call) => {
    called = call;
    return jsonResponse(200, body);
  });
  const lastCall = (): FetchCall | null => called;
  const api = new SyncApi();
  const result = await api.status();
  assert.equal(result.webdav?.url, 'https://dav.example.com/dav/config');
  assert.equal(result.webdav?.username, 'alice', 'status 可回传 username 值（非敏感，供表单回填）');
  assert.equal(result.webdav?.usernameConfigured, true);
  assert.equal(result.webdav?.passwordConfigured, true);
  assert.equal('password' in (result.webdav ?? {}), false, 'status 契约不得携带 webdav 密码值');
  assert.equal(lastCall()?.url, SYNC_API.status);
});

test('S-19 api.push()：transport=webdav → 请求体携带顶层扁平 url/username/password（不携带 git 字段）', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, snapshotId: 'sync-w1', sections: [], warnings: [] });
  });
  const api = new SyncApi();
  const result = await api.push({
    transport: 'webdav',
    url: 'https://dav.example.com/dav/config', username: 'alice', password: 'secret-pass',
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, SYNC_API.push);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['transport'], 'webdav');
  assert.equal(sent['url'], 'https://dav.example.com/dav/config', 'webdav url 应处于请求体顶层（flat）');
  assert.equal(sent['username'], 'alice', 'webdav username 应处于请求体顶层（flat）');
  assert.equal(sent['password'], 'secret-pass', 'webdav password 应处于请求体顶层（flat）');
  assert.equal(sent['webdav'], undefined, '不应再嵌套 webdav 对象');
  assert.equal(sent['repoUrl'], undefined, 'webdav 通道不应携带 git repoUrl');
});

test('S-20 api.pull()：transport=webdav 请求体透传扁平 webdav 配置', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, {
      ok: true, snapshotId: 'sync-w1', applied: [], changes: [], restoreId: '', rolledBack: false,
      warnings: [], failed: [], needsRestart: false,
    });
  });
  const api = new SyncApi();
  await api.pull({ transport: 'webdav', url: 'https://dav.example.com/dav/config', username: 'alice', password: 'secret-pass' });
  assert.equal(calls[0]?.url, SYNC_API.pull);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['transport'], 'webdav');
  assert.equal(sent['url'], 'https://dav.example.com/dav/config');
  assert.equal(sent['webdav'], undefined, '不应再嵌套 webdav 对象');
});

test('S-21 git 通道缺省：不带 transport → 请求体仍只含 git 字段（向后兼容）', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, snapshotId: 'sync-1', sections: [], warnings: [] });
  });
  const api = new SyncApi();
  await api.push({ repoUrl: 'https://github.com/u/r.git', token: 't' });
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['transport'], undefined, '缺省不声明 transport（Host 视为 git）');
  assert.equal(sent['repoUrl'], 'https://github.com/u/r.git');
  assert.equal(sent['webdav'], undefined);
});

test('S-22 api.push()：请求体恒不携带 sections（同步范围由 Host 固定）', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, snapshotId: 'sync-def', sections: ['settings'], warnings: [] });
  });
  const api = new SyncApi();
  await api.push({ repoUrl: 'https://github.com/u/r.git' });
  assert.equal(calls.length, 1);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['sections'], undefined, '分区选择已取消：请求体不得携带 sections');
});

test('S-26 api.push()：明文同步 → 请求体只带通道，不带任何加密字段', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, snapshotId: 'sync-plain', sections: ['settings'], warnings: [] });
  });
  const api = new SyncApi();
  await api.push({ repoUrl: 'https://github.com/u/r.git' });
  assert.equal(calls.length, 1);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal('encrypt' in sent, false, '明文同步不携带 encrypt');
  assert.equal('includeSecrets' in sent, false);
  assert.equal('encryptPassword' in sent, false);
});

test('S-27 api.pull()：请求体只带通道配置（恒取远端最新，无解密密码字段）', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, {
      ok: true, snapshotId: 'sync-1', applied: ['settings'], changes: [], restoreId: 'r-1',
      rolledBack: false, warnings: [], failed: [], needsRestart: false,
    });
  });
  const api = new SyncApi();
  await api.pull({ repoUrl: 'https://github.com/u/r.git' });
  assert.equal(calls[0]?.url, SYNC_API.pull);
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['repoUrl'], 'https://github.com/u/r.git');
  assert.equal('decryptPassword' in sent, false, '明文同步不携带 decryptPassword');
});

test('S-29 api.saveUiPrefs()：POST /sync/ui-prefs 携带 lastSyncChannel（磁盘持久化）', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, lastSyncChannel: 'webdav' });
  });
  const api = new SyncApi();
  const result = await api.saveUiPrefs({ lastSyncChannel: 'webdav' });
  assert.equal(result.lastSyncChannel, 'webdav');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, SYNC_API.uiPrefs);
  assert.equal(calls[0]?.init?.method, 'POST');
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['lastSyncChannel'], 'webdav');
});

test('S-30 api.status()：lastSyncChannel 回填（磁盘 ui-prefs；UI 通道回填权威来源）', async () => {
  const body = {
    ok: true, configured: true, credentialConfigured: true, credentialWritable: true, sectionCount: 2,
    lastSyncChannel: 'webdav',
  };
  installFetchMock(() => jsonResponse(200, body));
  const api = new SyncApi();
  const result = await api.status();
  assert.equal(result.lastSyncChannel, 'webdav');
});


test('S-31 api.rollback()：POST /sync/rollback 携带 restoreId，解析 ok/full（撤销本次覆盖）', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, full: false });
  });
  const api = new SyncApi();
  const result = await api.rollback({ restoreId: 'restore-42' });
  assert.equal(result.ok, true);
  assert.equal(result.full, false, '部分恢复时 full=false 必须如实透传');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, SYNC_API.rollback);
  assert.equal(calls[0]?.init?.method, 'POST');
  const sent = JSON.parse(String(calls[0]?.init?.body ?? '{}')) as Record<string, unknown>;
  assert.equal(sent['restoreId'], 'restore-42');
});

test('S-32 api.recoverStaleLock()：POST /sync/lock/recover（无请求体），解析 ok/removed/state', async () => {
  const calls: FetchCall[] = [];
  installFetchMock((call) => {
    calls.push(call);
    return jsonResponse(200, { ok: true, removed: true, state: 'FREE' });
  });
  const api = new SyncApi();
  const result = await api.recoverStaleLock();
  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  assert.equal(result.state, 'FREE');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, SYNC_API.lockRecover);
  assert.equal(calls[0]?.init?.method, 'POST');
});

test('S-33 api.recoverStaleLock()：Host 拒绝回收（ok=false）→ 如实透传，不谎称成功', async () => {
  // 拒绝不带原因串：底层 detail 含 op/pid/路径（内部诊断，只进宿主日志）。
  installFetchMock(() => jsonResponse(200, { ok: false, removed: false, state: 'LOCKED' }));
  const api = new SyncApi();
  const result = await api.recoverStaleLock();
  assert.equal(result.ok, false, '拒绝是正常结果，UI 必须据此提示而非报成功');
  assert.equal(result.removed, false);
  assert.equal(result.state, 'LOCKED');
  assert.equal('reason' in result, false, '内部诊断绝不回传响应体');
});

test('S-34 api.status()：解析 lock 摘要（残留锁入口的状态徽章数据源）', async () => {
  const body = {
    ok: true, configured: true, credentialConfigured: true, credentialWritable: true, sectionCount: 2,
    lock: { state: 'STALE_LOCK_DETECTED', attention: true },
  };
  installFetchMock(() => jsonResponse(200, body));
  const api = new SyncApi();
  const result = await api.status();
  assert.deepEqual(result.lock, { state: 'STALE_LOCK_DETECTED', attention: true });
});

