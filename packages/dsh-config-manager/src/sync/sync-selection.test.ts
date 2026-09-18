/**
 * sync-selection 测试：sync-selection.json 读写往返、缺省值、损坏 JSON 回退缺省、
 * 非字符串 sections 过滤、effectiveSections（高级模式 → 勾选分区；其余 → undefined）、
 * 按通道独立（git/webdav 互不干扰）、v1（顶层单通道）迁移为 git。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  defaultSyncSelection, effectiveSections, readSyncSelection, writeSyncSelection,
  readAllSyncSelections, SYNC_SELECTION_FILE, SYNC_SELECTION_SCHEMA_VERSION,
} from './sync-selection.ts';

test('writeSyncSelection + readSyncSelection：advanced 模式写入 → 读回字段一致（git 通道）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-rt-'));
  try {
    await writeSyncSelection(dir, 'git', { schemaVersion: SYNC_SELECTION_SCHEMA_VERSION, mode: 'advanced', sections: ['settings', 'skills'] });
    const sel = await readSyncSelection(dir, 'git');
    assert.equal(sel.mode, 'advanced');
    assert.deepEqual(sel.sections, ['settings', 'skills']);
    // 原始文件校验（v2 按通道）
    const raw = JSON.parse(await fs.readFile(path.join(dir, SYNC_SELECTION_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, SYNC_SELECTION_SCHEMA_VERSION);
    assert.equal(raw.channels.git.mode, 'advanced');
    assert.deepEqual(raw.channels.git.sections, ['settings', 'skills']);
    assert.equal(raw.channels.webdav.mode, 'default', '未配置的 webdav 通道落盘为缺省');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncSelection：文件不存在 → 返回缺省（default 模式 + 空 sections）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-default-'));
  try {
    const sel = await readSyncSelection(dir, 'git');
    assert.equal(sel.mode, 'default');
    assert.deepEqual(sel.sections, []);
    const webdav = await readSyncSelection(dir, 'webdav');
    assert.equal(webdav.mode, 'default');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncSelection：损坏 JSON → 回退缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-corrupt-'));
  try {
    await fs.writeFile(path.join(dir, SYNC_SELECTION_FILE), '{not-json', 'utf8');
    const sel = await readSyncSelection(dir, 'git');
    assert.equal(sel.mode, 'default');
    assert.deepEqual(sel.sections, []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncSelection：不支持的 schemaVersion → 回退缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-schema-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_SELECTION_FILE),
      JSON.stringify({ schemaVersion: 99, mode: 'advanced', sections: ['settings'] }),
      'utf8',
    );
    const sel = await readSyncSelection(dir, 'git');
    assert.equal(sel.mode, 'default');
    assert.deepEqual(sel.sections, []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncSelection：非法 mode / 非字符串 sections 元素 → 过滤回退', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-filter-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_SELECTION_FILE),
      JSON.stringify({ schemaVersion: 1, channels: { git: { mode: 'bogus', sections: ['settings', 42, '', 'skills'] } } }),
      'utf8',
    );
    const sel = await readSyncSelection(dir, 'git');
    assert.equal(sel.mode, 'default', '非法 mode 回退 default');
    assert.deepEqual(sel.sections, ['settings', 'skills'], '非字符串/空串元素被过滤');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('effectiveSections：advanced + 非空 → 勾选分区；default / advanced 空勾选 → undefined（全量）', () => {
  assert.deepEqual(
    effectiveSections({ schemaVersion: SYNC_SELECTION_SCHEMA_VERSION, mode: 'advanced', sections: ['settings', 'skills'] }),
    ['settings', 'skills'],
  );
  assert.equal(effectiveSections(defaultSyncSelection()), undefined, 'default 模式 = 全量推荐分区');
  assert.equal(
    effectiveSections({ schemaVersion: SYNC_SELECTION_SCHEMA_VERSION, mode: 'advanced', sections: [] }),
    undefined,
    'advanced 但未勾选 → 回退全量（避免自动同步卡死）',
  );
});

test('readSyncSelection：旧字段（encrypt/includeSecrets）被忽略，只读 mode + sections', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-safe-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_SELECTION_FILE),
      JSON.stringify({ schemaVersion: 1, channels: { git: { mode: 'advanced', sections: ['settings'], encrypt: true, includeSecrets: true } } }),
      'utf8',
    );
    const sel = await readSyncSelection(dir, 'git');
    assert.equal(sel.mode, 'advanced');
    assert.deepEqual(sel.sections, ['settings']);
    assert.equal('encrypt' in sel, false, '旧字段不再出现在读取结果');
    assert.equal('includeSecrets' in sel, false);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncSelection：升级路径 —— 上游 v2 文件（含 encrypt/includeSecrets）→ 保留用户勾选', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-upstream-v2-'));
  try {
    // 逐字取自上游 dsh-config-manager@0.1.60 实际落盘的文件形状：
    // 同一 channels 信封，多出 encrypt / includeSecrets 两个已废弃字段。
    await fs.writeFile(
      path.join(dir, SYNC_SELECTION_FILE),
      JSON.stringify({
        schemaVersion: 2,
        channels: {
          git: { mode: 'advanced', sections: ['settings', 'providers', 'prompts'], encrypt: true, includeSecrets: true },
          webdav: { mode: 'advanced', sections: ['settings', 'skills'], encrypt: true, includeSecrets: true },
        },
      }),
      'utf8',
    );
    const git = await readSyncSelection(dir, 'git');
    assert.equal(git.mode, 'advanced', '上游 v2 的 git 勾选必须被保留，不得回退缺省');
    assert.deepEqual(git.sections, ['settings', 'providers', 'prompts']);
    assert.equal('encrypt' in git, false, '已废弃字段不进入读取结果');
    assert.equal('includeSecrets' in git, false);
    const webdav = await readSyncSelection(dir, 'webdav');
    assert.equal(webdav.mode, 'advanced', '上游 v2 的 webdav 勾选必须被保留');
    assert.deepEqual(webdav.sections, ['settings', 'skills']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('按通道独立：写 webdav 不影响 git，反之亦然', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-perchannel-'));
  try {
    await writeSyncSelection(dir, 'git', { schemaVersion: SYNC_SELECTION_SCHEMA_VERSION, mode: 'default', sections: [] });
    await writeSyncSelection(dir, 'webdav', { schemaVersion: SYNC_SELECTION_SCHEMA_VERSION, mode: 'advanced', sections: ['settings', 'skills'] });
    const git = await readSyncSelection(dir, 'git');
    assert.equal(git.mode, 'default', 'git 通道保持 default');
    const webdav = await readSyncSelection(dir, 'webdav');
    assert.equal(webdav.mode, 'advanced');
    assert.deepEqual(webdav.sections, ['settings', 'skills']);
    // 全量读取视图
    const all = await readAllSyncSelections(dir);
    assert.equal(all.git.mode, 'default');
    assert.equal(all.webdav.mode, 'advanced');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readSyncSelection：上游 v1 顶层单通道形状 → 归 git 通道，webdav 缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-upstream-v1-'));
  try {
    // 上游 v1：整个文件就是一个通道配置，没有 channels 信封。
    await fs.writeFile(
      path.join(dir, SYNC_SELECTION_FILE),
      JSON.stringify({ schemaVersion: 1, mode: 'advanced', sections: ['settings', 'mcp'] }),
      'utf8',
    );
    const git = await readSyncSelection(dir, 'git');
    assert.equal(git.mode, 'advanced');
    assert.deepEqual(git.sections, ['settings', 'mcp']);
    const webdav = await readSyncSelection(dir, 'webdav');
    assert.equal(webdav.mode, 'default', 'v1 无 webdav 信息 → 缺省');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('非 channels 形状（顶层单通道）→ 回退缺省（schemaVersion 不匹配）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-sync-selection-v1-'));
  try {
    await fs.writeFile(
      path.join(dir, SYNC_SELECTION_FILE),
      JSON.stringify({ schemaVersion: 0, mode: 'advanced', sections: ['settings'] }),
      'utf8',
    );
    const git = await readSyncSelection(dir, 'git');
    assert.equal(git.mode, 'default', '不支持 schema → 回退缺省');
    assert.deepEqual(git.sections, []);
    const webdav = await readSyncSelection(dir, 'webdav');
    assert.equal(webdav.mode, 'default', 'webdav 通道回退缺省');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
