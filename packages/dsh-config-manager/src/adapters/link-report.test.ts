/**
 * issue #37：链接目录的告警构造（备份必须能说明「跟随了什么 / 跳过了什么」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { linkWarnings, listFilesDetailed } from './link-report.ts';
import { zhMsg } from '../core/messages.ts';
import type { FileSystemFacade } from '../core/types.ts';
import type { RecursiveListing } from '../utils/recursive-walk.ts';

const clean: RecursiveListing = { paths: ['skills/a.md'], skippedLinks: [], followedLinks: 0, unreadableDirs: [], excludedDirs: [] };
test('linkWarnings：按设计剪枝的运行时目录单独成行，不混入「未进备份」告警', () => {
  const out = linkWarnings(zhMsg, 'Plugin Files', {
    ...clean,
    excludedDirs: ['plugin-config/agy-link/acc_1/.gemini/antigravity-cli/scratch'],
  });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /按设计跳过/);
  assert.match(out[0]!, /scratch/);
  // 剪枝是策略而非缺失：不得复用「未进备份」这类内容缺失的措辞
  assert.doesNotMatch(out[0]!, /未进备份/);
});

test('linkWarnings：未剪枝时不产生任何剪枝告警（不制造噪音）', () => {
  assert.deepEqual(linkWarnings(zhMsg, 'Plugin Files', clean), []);
});

test('linkWarnings：无链接 → 零告警（不制造噪音）', () => {
  assert.deepEqual(linkWarnings(zhMsg, 'Skills', clean), []);
});

test('linkWarnings：跟随的链接必须提示「结构不会重建」', () => {
  const out = linkWarnings(zhMsg, 'Skills', { ...clean, followedLinks: 3 });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /3/);
  assert.match(out[0]!, /链接目录/);
  assert.match(out[0]!, /链接结构不会重建/);
});

test('linkWarnings：跳过项按原因归并，给出数量、原因与路径', () => {
  const out = linkWarnings(zhMsg, 'Skills', {
    paths: [],
    followedLinks: 1,
    unreadableDirs: [],
    excludedDirs: [],
    skippedLinks: [
      { path: 'skills/self', reason: 'loop' },
      { path: 'skills/broken', reason: 'broken' },
      { path: 'skills/outside', reason: 'outside-home' },
      { path: 'skills/fifo', reason: 'unreadable' },
      { path: 'skills/deep', reason: 'too-deep' },
    ],
  });
  assert.equal(out.length, 2, '跟随 + 跳过各一条');
  const skipped = out[1]!;
  assert.match(skipped, /5 个链接被跳过/);
  assert.match(skipped, /自引用\/重复链接/);
  assert.match(skipped, /断链/);
  assert.match(skipped, /目标在 DSH home 之外/);
  assert.match(skipped, /skills\/self/);
  // 未进备份必须说清楚，而不是「已跳过」这类中性的措辞
  assert.match(skipped, /未进备份/);
});

test('linkWarnings：目录读取失败也必须告警（其内容同样未进备份）', () => {
  const out = linkWarnings(zhMsg, 'Skills', {
    paths: [], followedLinks: 0, skippedLinks: [], unreadableDirs: ['skills/locked', 'skills/denied'], excludedDirs: [],
  });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /2 个目录读取失败/);
  assert.match(out[0]!, /未进备份/);
  assert.match(out[0]!, /skills\/locked/);
});

test('listFilesDetailed：宿主未实现 detailed 时回退到 listRecursive（旧行为不变）', async () => {
  const fs = { listRecursive: async () => ['skills/x.md'] } as unknown as FileSystemFacade;
  const listing = await listFilesDetailed(fs, 'skills');
  assert.deepEqual(listing.paths, ['skills/x.md']);
  assert.deepEqual(listing.skippedLinks, []);
  assert.equal(listing.followedLinks, 0);
});
