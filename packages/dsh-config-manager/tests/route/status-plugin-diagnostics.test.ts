/**
 * issue #28 诊断位回归：`/status` 暴露「插件清单实际读的是哪个目录 / 哪个 profile / 看到几个插件」。
 *
 * 背景：报告者正文只有一句「dsh desktop v2.0.5 安装了插件但是备份没识别到？」——缺乏可判定信息，
 * 用户也无从自查。插件清单来自 <homeDir>/profiles/<profile>/package.json 的 dependencies；
 * profile 由 config.profile → --profile → 'web' 逐级解析，homeDir 由 DSH_HOME 决定。
 * 三处任一不匹配都会表现为「装了却识别不到」。
 *
 * 契约（本文件锁定）：
 *  - /status 回 homeDir / profile / profileManifestReadable / installedPluginCount / names / bundles；
 *  - 客户端 aboutStatusRows 把诊断位格式化为可读行（路径分隔符归一化）；
 *  - 宿主未回诊断位（老版本）→ diagnostics 为 null，面板自动隐藏（向后兼容）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { aboutStatusRows } from '../../src/client/about/about-view.ts';

const here = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const base = { pluginVersion: '0.1.56', dshVersion: '0.1.1-rc.2', platform: 'win32', arch: 'x64' };

test('D1 宿主回诊断位 → 渲染诊断行（目录/profile/数量）', () => {
  const rows = aboutStatusRows({
    ...base,
    homeDir: 'C:\\Users\\me\\.dsh',
    profile: 'web',
    profileManifestReadable: true,
    installedPluginCount: 3,
    installedPluginNames: ['a', 'b', 'c'],
    bundles: ['@deepseek-ai/dsh-base'],
  });
  assert.ok(rows.diagnostics !== null, '有 homeDir+profile 即应产出诊断行');
  assert.equal(rows.diagnostics!.profileDir, 'C:/Users/me/.dsh/profiles/web', 'Windows 反斜杠应归一化为 /');
  assert.equal(rows.diagnostics!.profile, 'web');
  assert.equal(rows.diagnostics!.pluginCount, 3);
  assert.equal(rows.diagnostics!.manifestUnreadable, false);
});

test('D2 manifest 不可读 → 显式标记（这是"装了却识别不到"的关键信号）', () => {
  const rows = aboutStatusRows({
    ...base,
    homeDir: '/home/me/.dsh',
    profile: 'desktop',
    profileManifestReadable: false,
    installedPluginCount: 0,
  });
  assert.equal(rows.diagnostics!.manifestUnreadable, true);
  assert.equal(rows.diagnostics!.pluginCount, 0);
  assert.equal(rows.diagnostics!.profile, 'desktop', 'profile 名应原样展示（Desktop 可能不是 web）');
});

test('D3 向后兼容：宿主未回诊断位 → diagnostics=null（面板隐藏该行，不报错）', () => {
  assert.equal(aboutStatusRows({ ...base }).diagnostics, null);
  assert.equal(aboutStatusRows({ ...base, homeDir: '', profile: 'web' }).diagnostics, null, '空 homeDir 视为无诊断');
  assert.equal(aboutStatusRows({ ...base, homeDir: '/x', profile: '' }).diagnostics, null, '空 profile 视为无诊断');
});

test('D4 计数缺省为 0（不产出 undefined 显示）', () => {
  const rows = aboutStatusRows({ ...base, homeDir: '/x', profile: 'web' });
  assert.equal(rows.diagnostics!.pluginCount, 0);
});

test('D5 宿主 /status 必须真的挂上诊断位（源码级守卫，防接线丢失）', async () => {
  const src = await fs.readFile(path.resolve(here, '../../src/index.ts'), 'utf8');
  assert.ok(src.includes('readPluginDiagnostics'), '/status 应调用 readPluginDiagnostics');
  assert.ok(src.includes('...pluginDiag'), '诊断字段应展开进 /status 响应体');
  for (const field of ['homeDir', 'profile', 'profileManifestReadable', 'installedPluginCount', 'installedPluginNames', 'bundles']) {
    assert.ok(src.includes(field), `诊断字段缺失: ${field}`);
  }
  // best-effort：读失败不得拖垮 /status（有 try/catch 降级）
  assert.match(src, /plugin diagnostics unavailable/, '诊断失败应降级为日志而非抛出');
});
