/**
 * ui-prefs 测试：ui-prefs.json 读写往返、缺省值、损坏 JSON 回退缺省、非法通道值忽略、
 * updateUiPrefs 局部原子更新不覆盖未提交的字段。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  defaultUiPrefs, readUiPrefs, writeUiPrefs, updateUiPrefs,
  UI_PREFS_FILE, UI_PREFS_SCHEMA_VERSION,
} from './ui-prefs.ts';

test('writeUiPrefs + readUiPrefs：写入通道 → 读回一致 + 原始文件校验', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-rt-'));
  try {
    await writeUiPrefs(dir, { schemaVersion: 1, lastSyncChannel: 'webdav' });
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.lastSyncChannel, 'webdav');
    const raw = JSON.parse(await fs.readFile(path.join(dir, UI_PREFS_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, UI_PREFS_SCHEMA_VERSION);
    assert.equal(raw.lastSyncChannel, 'webdav');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('writeUiPrefs：无通道 → 文件不写 lastSyncChannel 字段', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-none-'));
  try {
    await writeUiPrefs(dir, defaultUiPrefs());
    const raw = JSON.parse(await fs.readFile(path.join(dir, UI_PREFS_FILE), 'utf8'));
    assert.equal(raw.schemaVersion, UI_PREFS_SCHEMA_VERSION);
    assert.equal('lastSyncChannel' in raw, false, '未配置通道不落字段');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readUiPrefs：文件不存在 → 缺省（无通道）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-default-'));
  try {
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.lastSyncChannel, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readUiPrefs：损坏 JSON → 回退缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-corrupt-'));
  try {
    await fs.writeFile(path.join(dir, UI_PREFS_FILE), '{not-json', 'utf8');
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.lastSyncChannel, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readUiPrefs：不支持的 schemaVersion → 回退缺省', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-schema-'));
  try {
    await fs.writeFile(
      path.join(dir, UI_PREFS_FILE),
      JSON.stringify({ schemaVersion: 99, lastSyncChannel: 'git' }),
      'utf8',
    );
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.lastSyncChannel, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('readUiPrefs：非法通道值 → 忽略（回退缺省）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-bad-'));
  try {
    await fs.writeFile(
      path.join(dir, UI_PREFS_FILE),
      JSON.stringify({ schemaVersion: 1, lastSyncChannel: 'ftp' }),
      'utf8',
    );
    const prefs = await readUiPrefs(dir);
    assert.equal(prefs.lastSyncChannel, undefined, '非 git/webdav 值被忽略');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('updateUiPrefs：局部补丁合并，不覆盖未提交的字段', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ui-prefs-upd-'));
  try {
    await writeUiPrefs(dir, { schemaVersion: 1, lastSyncChannel: 'webdav' });
    // 空补丁：磁盘现值必须原样保留（read → merge → write 不得丢字段）
    const unchanged = await updateUiPrefs(dir, {});
    assert.equal(unchanged.lastSyncChannel, 'webdav', '未提交的字段保留磁盘现值');
    // 提交字段：按补丁更新
    const next = await updateUiPrefs(dir, { lastSyncChannel: 'git' });
    assert.equal(next.lastSyncChannel, 'git');
    // 磁盘最终态
    const raw = JSON.parse(await fs.readFile(path.join(dir, UI_PREFS_FILE), 'utf8'));
    assert.equal(raw.lastSyncChannel, 'git');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
