/**
 * cache-cleaner 测试：缓存自动清理的保留期 / 白名单边界 / 容错。
 * 使用真实临时目录（node:os tmpdir）+ node:fs 真实读写（与 plugin-cli.fs.test.ts 同模式）。
 * 覆盖：
 *   - tmp：过期 .zip 删、新 .zip 留、非 zip 文件留、dsh-sync-pull-* 目录超期删
 *   - exports：过期导出 zip 删、新导出 zip 留、非 zip 文件留
 *   - 保留期边界（恰好等于保留期 → 不删）、目录不存在 → 不抛错
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  cleanupCaches,
  TMP_RETENTION_DEFAULT_MS,
  EXPORTS_RETENTION_DEFAULT_MS,
} from './cache-cleaner.ts';

/** 建独立临时数据目录，返回 { root, tmpDir, exportsDir, cleanup } */
async function makeDataDir(): Promise<{
  root: string;
  tmpDir: string;
  exportsDir: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-cm-cache-'));
  const tmpDir = path.join(root, 'tmp');
  const exportsDir = path.join(root, 'exports');
  await fs.mkdir(tmpDir, { recursive: true });
  await fs.mkdir(exportsDir, { recursive: true });
  return {
    root,
    tmpDir,
    exportsDir,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

/** 把目标 mtime 拨到指定毫秒（Windows 精度足够，测试用秒级偏移） */
async function touch(p: string, mtimeMs: number): Promise<void> {
  const st = await fs.stat(p);
  await fs.utimes(p, st.atimeMs ? new Date(st.atimeMs) : new Date(), new Date(mtimeMs));
}

test('tmp：过期 .zip 删、新 .zip 留、非 zip 文件留', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const oldZip = path.join(d.tmpDir, 'upload-old.zip');
    const newZip = path.join(d.tmpDir, 'upload-new.zip');
    const txt = path.join(d.tmpDir, 'notes.txt');
    await fs.writeFile(oldZip, Buffer.alloc(10));
    await fs.writeFile(newZip, Buffer.alloc(20));
    await fs.writeFile(txt, 'keep me');
    await touch(oldZip, now - TMP_RETENTION_DEFAULT_MS - 1000); // 超期 1s
    await touch(newZip, now - 1000); // 新

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      now: () => now,
    });

    assert.equal(report.removed, 1, '只删超期 zip');
    assert.equal(report.freedBytes, 10, '释放字节 = 被删文件 size');
    assert.equal(await fs.readFile(newZip).then((b) => b.length), 20, '新 zip 保留');
    assert.equal(await fs.readFile(txt, 'utf8'), 'keep me', '非 zip 文件保留');
    await assert.rejects(() => fs.stat(oldZip), '超期 zip 已删');
    assert.ok(report.detail.some((s) => s.includes('upload-old.zip')), 'detail 含删除记录');
  } finally {
    await d.cleanup();
  }
});

test('tmp：dsh-sync-pull-* 临时目录超期删、新目录留', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const oldDir = path.join(d.tmpDir, 'dsh-sync-pull-abc');
    const newDir = path.join(d.tmpDir, 'dsh-sync-pull-def');
    const otherDir = path.join(d.tmpDir, 'keep-dir');
    await fs.mkdir(path.join(oldDir, 'inner'), { recursive: true });
    await fs.mkdir(path.join(newDir, 'inner'), { recursive: true });
    await fs.mkdir(otherDir, { recursive: true });
    await fs.writeFile(path.join(oldDir, 'inner', 'snapshot.zip'), Buffer.alloc(5));
    await touch(oldDir, now - TMP_RETENTION_DEFAULT_MS - 5000);
    await touch(newDir, now - 1000);

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      now: () => now,
    });

    assert.equal(report.removed, 1, '只删超期 sync 临时目录');
    await assert.rejects(() => fs.stat(oldDir), '超期 sync 目录整棵已删');
    assert.ok(await fs.stat(newDir), '新 sync 目录保留');
    assert.ok(await fs.stat(otherDir), '无关目录保留');
  } finally {
    await d.cleanup();
  }
});

test('exports：过期导出 zip 删、新导出 zip 留、非 zip 文件留', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const oldExport = path.join(d.exportsDir, 'dsh-config-old.zip');
    const newExport = path.join(d.exportsDir, 'dsh-config-new.zip');
    const readme = path.join(d.exportsDir, 'readme.txt');
    await fs.writeFile(oldExport, Buffer.alloc(15));
    await fs.writeFile(newExport, Buffer.alloc(25));
    await fs.writeFile(readme, 'keep');
    await touch(oldExport, now - EXPORTS_RETENTION_DEFAULT_MS - 1000); // 超期 1s
    await touch(newExport, now - 1000); // 新

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      now: () => now,
    });

    assert.equal(report.removed, 1, '只删超期导出 zip');
    assert.equal(report.freedBytes, 15, '释放字节 = 被删文件 size');
    await assert.rejects(() => fs.stat(oldExport), '超期导出 zip 已删');
    assert.ok(await fs.stat(newExport), '新导出 zip 保留');
    assert.equal(await fs.readFile(readme, 'utf8'), 'keep', '非 zip 文件保留');
    assert.ok(report.detail.some((s) => s.includes('exports/')), 'detail 含 exports 删除记录');
  } finally {
    await d.cleanup();
  }
});

test('保留期边界：恰好等于保留期 → 不删（超期判定为严格大于）', async () => {
  const d = await makeDataDir();
  try {
    const now = Date.now();
    const zip = path.join(d.tmpDir, 'upload-boundary.zip');
    await fs.writeFile(zip, Buffer.alloc(3));
    await touch(zip, now - TMP_RETENTION_DEFAULT_MS); // 恰好 = 保留期

    const report = await cleanupCaches({
      tmpDir: d.tmpDir,
      exportsDir: d.exportsDir,
      now: () => now,
    });

    assert.equal(report.removed, 0, '边界文件不删');
    assert.ok(await fs.stat(zip), '边界 zip 保留');
  } finally {
    await d.cleanup();
  }
});

test('容错：目录不存在 → 不抛错、removed=0', async () => {
  const d = await makeDataDir();
  try {
    const report = await cleanupCaches({
      tmpDir: path.join(d.root, 'no-such-tmp'),
      exportsDir: path.join(d.root, 'no-such-exports'),
    });
    assert.equal(report.removed, 0);
    assert.equal(report.errors, 2, '两个缺失目录各记一次尽力而为跳过');
  } finally {
    await d.cleanup();
  }
});
