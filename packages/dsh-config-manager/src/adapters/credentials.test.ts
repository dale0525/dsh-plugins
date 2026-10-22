/**
 * credentials adapter 测试：状态导出（永不泄值）、ref 收集、MissingSecret 由引擎兜底、
 * applyItem 经 secretInputs/decryptedCredentials 补录（仅内存）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CredentialsAdapter, defaultCredentialRefs } from './credentials.ts';
import { makeContext, makeImportContext } from './test-helpers.ts';
import type { PlanItem } from '../core/types.ts';

const NS = ['llm-deepseek', 'llm-pi-ai'];

test('credentials: 状态导出（configured/source/hasValue=false，值绝不含）', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  ctx.settings.ns.set('llm-deepseek', {
    value: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    revision: 5,
    secrets: [{ path: ['apiKey'], set: true }],
  });
  ctx.settings.ns.set('llm-pi-ai', {
    value: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } },
    revision: 2,
    secrets: [],
  });
  ctx.credentials.values.set('DEEPSEEK_API_KEY', 'sk-super-secret-123');

  const adapter = new CredentialsAdapter({ namespaces: NS });
  const out = await adapter.export(ctx, { includeSecrets: false });
  const refs = out.data.credentials.map((c) => c.ref).sort();
  assert.deepEqual(refs, ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'], '从 apiKeyEnv + secrets 标记收集');
  const dk = out.data.credentials.find((c) => c.ref === 'DEEPSEEK_API_KEY');
  assert.equal(dk?.configured, true);
  assert.equal(dk?.hasValue, false, '值未导出（安全不变量）');
  const ok = out.data.credentials.find((c) => c.ref === 'OPENAI_API_KEY');
  assert.equal(ok?.configured, false);
  // 序列化后的导出数据不得包含秘密值
  const serialized = JSON.stringify(out.data);
  assert.ok(!serialized.includes('sk-super-secret-123'), '凭据值不得进入导出数据');

  const v = await adapter.validate(out.data);
  assert.equal(v.valid, true);
});

test('credentials: defaultCredentialRefs 从 settings 收集', async () => {
  const ctx = makeContext('win32', 'C:\\Users\\alice');
  // 顶层 apiKeyEnv + secrets 引用类字段（apiKeyEnv）的值 = 凭据 ref
  ctx.settings.ns.set('llm-deepseek', { value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, revision: 1, secrets: [{ path: ['apiKeyEnv'], set: true }] });
  const refs = await defaultCredentialRefs(NS)(ctx);
  assert.ok(refs.includes('DEEPSEEK_API_KEY'));
  // secrets[].path[0] 若为非引用类字段（如 apiKey 字段路径），不收集为 ref
  const ctx2 = makeContext('win32', 'C:\\Users\\alice');
  ctx2.settings.ns.set('llm-deepseek', { value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, revision: 1, secrets: [{ path: ['apiKey'], set: true }] });
  const refs2 = await defaultCredentialRefs(NS)(ctx2);
  assert.ok(!refs2.includes('apiKey'), '字段路径不是凭据 ref');
});

test('credentials: applyItem 用 secretInputs / decryptedCredentials 补录（仅内存，不落盘值）', async () => {
  const src = makeContext('win32', 'C:\\Users\\alice');
  src.settings.ns.set('llm-deepseek', { value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, revision: 1, secrets: [] });
  const adapter = new CredentialsAdapter({ namespaces: NS });
  const exported = await adapter.export(src, { includeSecrets: false });
  const sections = new Map([['credentialsStatus', exported.data]]);

  const dst = makeContext('linux', '/home/bob');
  const ictx = makeImportContext(dst, sections, { secretInputs: { DEEPSEEK_API_KEY: 'sk-from-user-input' } });
  const item: PlanItem = {
    id: 'secret:DEEPSEEK_API_KEY', kind: 'MissingSecret', adapter: 'credentialsStatus',
    description: '凭据补录', severity: 'warning', target: { adapter: 'credentialsStatus', ref: 'DEEPSEEK_API_KEY' },
  };
  const r = await adapter.applyItem(item, ictx);
  assert.equal(r.ok, true);
  assert.equal(dst.credentials.values.get('DEEPSEEK_API_KEY'), 'sk-from-user-input');

  // 解密通道（加密备份）
  const dst2 = makeContext('linux', '/home/bob');
  const dec = new Map<string, string>([['DEEPSEEK_API_KEY', 'sk-decrypted']]);
  const r2 = await adapter.applyItem(item, makeImportContext(dst2, sections, { decryptedCredentials: dec }));
  assert.equal(r2.ok, true);
  assert.equal(dst2.credentials.values.get('DEEPSEEK_API_KEY'), 'sk-decrypted');

  // 无值 → 失败（引擎在 MissingSecret 无值时先跳过，这里兜底）
  const r3 = await adapter.applyItem(item, makeImportContext(dst2, sections));
  assert.equal(r3.ok, false);
});

test('credentials: includeSecrets=true 携带明文值（含仅存在于 .credentials.yaml 的 ref）', async () => {
  const ctx = makeContext('win32', 'C:\\\\Users\\\\alice');
  ctx.settings.ns.set('llm-deepseek', { value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, revision: 1, secrets: [] });
  ctx.credentials.values.set('DEEPSEEK_API_KEY', 'sk-super-secret-123');
  await ctx.fs.writeFile('.credentials.yaml', Buffer.from(
    'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-super-secret-123\n  DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD: hunter2\n',
  ));

  const adapter = new CredentialsAdapter({ namespaces: NS });
  const out = await adapter.export(ctx, { includeSecrets: true });
  const byRef = new Map(out.data.credentials.map((c) => [c.ref, c]));
  assert.equal(byRef.get('DEEPSEEK_API_KEY')?.value, 'sk-super-secret-123');
  assert.equal(byRef.get('DEEPSEEK_API_KEY')?.hasValue, true);
  assert.equal(byRef.get('DSH_CONFIG_MANAGER_SYNC_WEBDAV_PASSWORD')?.value, 'hunter2', '仅存在于凭据文件的 ref 也随导出');
  const v = await adapter.validate(out.data);
  assert.equal(v.valid, true);
});

test('credentials: 一个 ref 里装着 JSON 账号池时，额度字段原样往返（不拆、不改写）', async () => {
  // MODAL_H3_ACCOUNTS 是单个 ref，值是整份账号池 JSON（含每个账号的
  // monthly_credit_usd）。同步只搬 ref 的字符串值，所以额度能跟着走的前提是
  // adapter 绝不解析、绝不重写这个值——一旦它开始按 JSON 处理，额度字段就可能
  // 在往返中被丢掉，而没有任何测试会发现。
  const pool = JSON.stringify({
    tokens: [
      { name: 'acc1', token_id: 'ak-1', token_secret: 's1', monthly_credit_usd: 30 },
      { name: 'acc2', token_id: 'ak-2', token_secret: 's2', monthly_credit_usd: 12.5 },
    ],
  });
  const src = makeContext('win32', 'C:\\Users\\alice');
  await src.fs.writeFile('.credentials.yaml', Buffer.from(
    `version: 1\nrefs:\n  MODAL_H3_ACCOUNTS: ${JSON.stringify(pool)}\n`,
  ));
  const adapter = new CredentialsAdapter({ namespaces: [] });

  const out = await adapter.export(src, { includeSecrets: true });
  const item = out.data.credentials.find((c) => c.ref === 'MODAL_H3_ACCOUNTS');
  assert.equal(item?.value, pool, '值必须逐字等于写入的那份 JSON');
  assert.deepEqual(
    JSON.parse(item!.value!).tokens.map((t: { monthly_credit_usd: number }) => t.monthly_credit_usd),
    [30, 12.5],
    '额度字段随值一起走，未被拆解或丢弃',
  );

  // 写回端：快照里带的明文值原样落盘。
  const dst = makeContext('linux', '/home/bob');
  const dstAdapter = new CredentialsAdapter({ namespaces: [] });
  const sections = new Map<string, unknown>([['credentialsStatus', out.data]]);
  const items = await dstAdapter.analyzeImport(out.data, makeImportContext(dst, sections));
  for (const item of items) await dstAdapter.applyItem(item, makeImportContext(dst, sections));
  const written = dst.credentials.values.get('MODAL_H3_ACCOUNTS');
  assert.equal(written, pool, '写回的值必须与源逐字相同');
  assert.deepEqual(
    JSON.parse(written!).tokens.map((t: { monthly_credit_usd: number }) => t.monthly_credit_usd),
    [30, 12.5],
    '额度字段没有在写回时丢失',
  );
});

test('credentials: includeSecrets=false 时凭据文件存在也不带值（普通备份不变）', async () => {
  const ctx = makeContext('win32', 'C:\\\\Users\\\\alice');
  ctx.settings.ns.set('llm-deepseek', { value: { apiKeyEnv: 'DEEPSEEK_API_KEY' }, revision: 1, secrets: [] });
  await ctx.fs.writeFile('.credentials.yaml', Buffer.from('version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-super-secret-123\n'));

  const adapter = new CredentialsAdapter({ namespaces: NS });
  const out = await adapter.export(ctx, { includeSecrets: false });
  assert.equal(out.data.credentials[0]?.hasValue, false);
  assert.equal(out.data.credentials[0]?.value, undefined);
  assert.ok(!JSON.stringify(out.data).includes('sk-super-secret-123'));
});

test('credentials: applyItem 直接用快照携带的明文值写回（无需补录）', async () => {
  const dst = makeContext('linux', '/home/bob');
  const adapter = new CredentialsAdapter({ namespaces: NS });
  const sections = new Map([['credentialsStatus', {
    version: 1,
    credentials: [{ ref: 'DSH_CONFIG_MANAGER_SYNC_TOKEN', required: true, configured: true, hasValue: true, value: 'ghp_from_snapshot' }],
  }]]);
  const item: PlanItem = {
    id: 'cred:DSH_CONFIG_MANAGER_SYNC_TOKEN', kind: 'Update', adapter: 'credentialsStatus',
    description: '凭据写回', severity: 'info', target: { adapter: 'credentialsStatus', ref: 'DSH_CONFIG_MANAGER_SYNC_TOKEN' },
  };
  const r = await adapter.applyItem(item, makeImportContext(dst, sections));
  assert.equal(r.ok, true);
  assert.equal(dst.credentials.values.get('DSH_CONFIG_MANAGER_SYNC_TOKEN'), 'ghp_from_snapshot');

  const dst2 = makeContext('linux', '/home/bob');
  const r2 = await adapter.applyItem(item, makeImportContext(dst2, sections, { secretInputs: { DSH_CONFIG_MANAGER_SYNC_TOKEN: 'ghp_typed_by_user' } }));
  assert.equal(r2.ok, true);
  assert.equal(dst2.credentials.values.get('DSH_CONFIG_MANAGER_SYNC_TOKEN'), 'ghp_typed_by_user', '用户补录优先于快照值');
});

test('credentials: validate 校验 hasValue 与 value 必须一致', async () => {
  const adapter = new CredentialsAdapter();
  const missing = await adapter.validate({ version: 1, credentials: [{ ref: 'X', required: true, configured: true, hasValue: true } as never] });
  assert.equal(missing.valid, false, 'hasValue=true 但缺 value → 非法');
  const stray = await adapter.validate({ version: 1, credentials: [{ ref: 'X', required: true, configured: true, hasValue: false, value: 'sk-1' } as never] });
  assert.equal(stray.valid, false, '带 value 但 hasValue≠true → 非法');
  const good = await adapter.validate({ version: 1, credentials: [{ ref: 'X', required: true, configured: true, hasValue: true, value: 'sk-1' } as never] });
  assert.equal(good.valid, true);
});
