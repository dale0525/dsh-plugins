/**
 * test-host-seams.mjs — 宿主接缝收敛专项测试。
 *
 * 本包原先自带九条 `/bubble/*` 路由，每条都在重做宿主已有的能力。收敛到官方接缝后，
 * 用静态断言钉住「不该再出现的东西」，防止它们在后续改动里悄悄长回来。
 * 运行方式：node tests/test-host-seams.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostCode = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf-8');
const clientCode = fs.readFileSync(path.resolve(__dirname, '../src/client.src.js'), 'utf-8');

console.log('--- 开始测试：宿主接缝收敛专项验证 ---');

// =========================================================================
// [Test 1] 死代码：ctx.settings.register 不存在
// =========================================================================
console.log('[Test 1] 死代码消除验证...');
assert.ok(
  !hostCode.includes('settings.register'),
  'ctx.settings.register 在宿主上不存在（SettingsForms 原型无 register），该分支必须是死代码且已删除'
);
assert.ok(!hostCode.includes('settingsNamespace'), 'settingsNamespace 只服务于上面的死分支，应一并删除');
assert.ok(!hostCode.includes('NAMESPACE_PATTERN'), 'NAMESPACE_PATTERN 只服务于 settingsNamespace，应一并删除');
assert.ok(!hostCode.includes('settings namespace 已注册'), '死分支里的日志文案不应残留');
console.log('✓ 死分支与孤儿助手函数已清除');

// =========================================================================
// [Test 2] 九条自造路由已全部删除（能力改走宿主官方接缝）
// =========================================================================
console.log('[Test 2] 自造路由清除验证...');
const goneRoutes = ['/bubble/log', '/bubble/backup', '/bubble/unarchive', '/bubble/recall', '/bubble/clean-ghost'];
for (const route of goneRoutes) {
  assert.ok(!hostCode.includes(`path: '${route}'`), `宿主不应再注册 ${route}（对应能力已有官方接缝）`);
  assert.ok(!clientCode.includes(`fetch("${route}"`), `客户端不应再调用 ${route}`);
}
// 宿主日志器（落盘批处理）随 /bubble/log 一并删除；客户端 console 已由 runner 打标
assert.ok(!hostCode.includes('flushLogBuffer'), '宿主批量落盘日志器应已删除');
assert.ok(!hostCode.includes('writeLog'), '宿主 writeLog 应已删除');
console.log('✓ 九条自造路由与配套宿主日志器已清除');

// =========================================================================
// [Test 3] 剩余路由不再自写访问校验，改用 connection.requestRejection
// =========================================================================
console.log('[Test 3] 访问校验改走宿主接缝验证...');
assert.ok(!hostCode.includes('function requestFromSameOrigin'), '不得自写同源校验（应使用 connection.requestRejection）');
assert.ok(!hostCode.includes('function isJsonContentType'), '不得自写 Content-Type 校验');
assert.ok(!hostCode.includes('SESSION_ID_PATTERN'), '不得自写会话 id 白名单');
console.log('✓ 剩余路由的访问校验已改走 connection.requestRejection');

// =========================================================================
// [Test 4] 文件拖放交给宿主，插件只接管气泡 dropzone
// =========================================================================
console.log('[Test 4] 拖放职责边界验证...');
// 宿主的 installDocumentDropEvents 已在 document 上实现完整拖放（遮罩 + onAddFiles）。
// 插件若在捕获阶段无条件 stopPropagation，宿主的计数式遮罩会收不到 dragleave/drop 而卡死。
assert.ok(clientCode.includes('function overBubble('), '必须有「落点是否在气泡 dropzone 内」的判据');
for (const fn of ['onDragEnter', 'onDragOver', 'onDrop']) {
  const at = clientCode.indexOf(`function ${fn}(e)`);
  assert.ok(at > 0, `${fn} 应存在`);
  const head = clientCode.slice(at, at + 400);
  assert.ok(head.includes('overBubble(e)'), `${fn} 必须先判 overBubble，非气泡目标完全不碰事件`);
}
// 插件不再自建底部暂存：蒙层、命中判定、暂存 id 列表都已删除
for (const dead of ['data-easyrewrite-bottom-dz', 'isPointInBottomDz', 'isTargetInComposerInput', 'stagedBottomImageIdsRef', 'getComposerToolbar']) {
  assert.ok(!clientCode.includes(dead), `${dead} 属于已删除的底部暂存实现，不应残留`);
}
console.log('✓ 拖放只接管气泡 dropzone，底部交还宿主');

// =========================================================================
// [Test 5] 宿主版本探测不得引用未导入的模块
// =========================================================================
console.log('[Test 5] 宿主版本探测可执行性验证...');
// readDshVersion 里曾用裸 path.dirname，而本文件没有 import path，
// 抛出的 ReferenceError 被外层 try 吞掉 → 该探测恒返回 null，且完全无声。
assert.ok(!/\bpath\./.test(hostCode), 'index.js 未 import path，不得使用 path.*（会被 try 吞掉、静默失效）');
assert.ok(/import \{[^}]*\bdirname\b[^}]*\} from 'node:path'/.test(hostCode), '应直接从 node:path 导入 dirname');
// 第二层：/opt/homebrew/bin/dsh 是指向 lib/node_modules/@deepseek-ai/dsh/lib/bin.js 的符号链接，
// dirname 不解析符号链接，于是上探 6 层全是 /opt/homebrew 一带，一个宿主 package.json 都碰不到。
assert.ok(/await realpath\(/.test(hostCode), '上探进程入口前必须 realpath 解析符号链接，否则宿主版本恒为 null');
assert.ok(/import \{[^}]*\brealpath\b[^}]*\} from 'node:fs\/promises'/.test(hostCode), '应导入 realpath');
console.log('✓ 宿主版本探测不再引用未导入的模块');

// 实测：修复后能从符号链接入口解析出宿主版本
{
  const src = hostCode.slice(hostCode.indexOf('async function readDshVersion'), hostCode.indexOf('\nasync function fetchLatestVersion'));
  const fn = new Function('readFile', 'realpath', 'join', 'dirname', 'process', src + '\nreturn readDshVersion;');
  const { readFile, realpath } = await import('node:fs/promises');
  const { join, dirname } = await import('node:path');
  const probe = { argv: ['node', '/opt/homebrew/bin/dsh', '--profile', 'web'] };
  const v = await fn(readFile, realpath, join, dirname, probe)();
  assert.equal(v, '0.2.1-rc.2', `符号链接入口应解析出宿主版本，实际得到 ${v}`);
  console.log(`✓ 实测符号链接入口解析出宿主版本：${v}`);
}

// =========================================================================
// [Test 6] 更新路由必须认得「经聚合包间接安装」与「多个 profile」
// =========================================================================
console.log('[Test 6] 更新路由的安装形态识别验证...');
// 本插件由聚合包 @logictan/dsh-plugins-all 间接装入，profile 的 package.json 里
// 并没有本包名 —— 只按本包名匹配会一个 profile 都找不到，更新接口恒返回 profile-not-found。
assert.ok(hostCode.includes('@logictan/dsh-plugins-all'), '更新路由必须认聚合包（本插件的实际安装形态）');
assert.ok(/findPluginHomeDir[\s\S]{0,2000}?target:/.test(hostCode), '应一并返回「该 up 哪个包」，而不是硬编码本包名');
assert.ok(!/'pnpm', \['up', '@logictan\/dsh-easyrewrite'\]/.test(hostCode),
  '不得把本包名硬编码进 pnpm up（会把间接依赖变成 profile 直接依赖）');
// 多个 profile 都装了聚合包时必须认进程自己的 --profile，否则会去升级另一个 profile
assert.ok(hostCode.includes("indexOf('--profile')"), '必须优先认进程的 --profile，否则会升级错 profile');
console.log('✓ 更新路由能定位到实际安装形态与当前 profile');

// =========================================================================
// [Test 7] 图标与按钮样式跟随 macOS 主题
// =========================================================================
console.log('[Test 7] 图标与按钮的主题一致性验证...');
// 旧实现是白底不透明 PNG + filter:invert(1)：反色会把白底变黑底，与任何面板底色都对不上，
// 且 1080px 位图缩到 14px 再反色，边缘必糊。主题自己的图标是 16px 网格、currentColor 上色的
// 内联 SVG，这里必须同款。
assert.ok(!/data:image\/png/.test(clientCode), '不得再内联 PNG 图标（白底位图无法随主题上色）');
assert.ok(!/\.dbe-icon-img\s*\{[^}]*filter\s*:\s*invert/.test(clientCode), '不得用 filter:invert 反色图标');
assert.ok(clientCode.includes('function iconSvg('), '图标应走内联 SVG');
assert.ok(/stroke:\s*"currentColor"/.test(clientCode), '图标描边必须是 currentColor，才能随按钮换色');
assert.ok(/viewBox:\s*"0 0 16 16"/.test(clientCode), '图标应画在主题的 16px 网格上');
// 按钮颜色必须优先取主题 role 变量（--dsh-theme-*），并保留原值作 fallback。
// 注意 radius 是具名阶梯（-xs/-sm/-md/-lg），主题里**没有**裸 `--dsh-theme-radius`；
// 写成裸名会被 includes 前缀误碰而空过，所以这里逐个校验真实阶梯名。
for (const role of ['--dsh-theme-accent', '--dsh-theme-ink-2', '--dsh-theme-hover']) {
  assert.ok(clientCode.includes(role), `按钮样式应读主题 role 变量 ${role}`);
}
assert.ok(!/--dsh-theme-radius\s*[,)]/.test(clientCode), '主题没有裸 --dsh-theme-radius，只能用 -xs/-sm/-md/-lg 阶梯');
for (const step of ['--dsh-theme-radius-xs', '--dsh-theme-radius-sm', '--dsh-theme-radius-md']) {
  assert.ok(clientCode.includes(step), `圆角应取主题 radius 阶梯 ${step}`);
}
// 圆角不得再用 999px 药丸——主题的按钮是圆角矩形（radius 阶梯 md=10px）
const btnBlock = clientCode.slice(clientCode.indexOf('var primaryBtnStyle'), clientCode.indexOf('// 编辑态：图片缩略图保持在编辑框上方'));
assert.ok(!/borderRadius:\s*"999px"/.test(btnBlock), '编辑态按钮不得再用 999px 药丸圆角');
assert.ok(/borderRadius:\s*"var\(--dsh-theme-radius-md/.test(btnBlock), '按钮圆角应取主题 radius 阶梯');
// 撤回条标签同理：字号跟主题正文、圆角跟主题阶梯
const labelLine = clientCode.split('\n').find((l) => l.includes('label.style.cssText'));
assert.ok(labelLine.includes('--dsh-chat-font-size'), '撤回条标签字号应跟主题正文');
assert.ok(labelLine.includes('--dsh-theme-radius-xs'), '撤回条标签圆角应取主题阶梯');
assert.ok(!labelLine.includes('999px'), '撤回条标签不得再用 999px 药丸');
// 撤回确认胶囊同样不得硬编码浅色：`#ffffff` 底 + `#000000` 字在暗色下是一块白斑
const capsule = clientCode.slice(clientCode.indexOf('function ConfirmCapsule'), clientCode.indexOf('// ---------- 设置卡片'));
assert.ok(!/background:\s*"#ffffff"/.test(capsule), '确认胶囊按钮不得写死 #ffffff 底色');
assert.ok(!/color:\s*"#000000"/.test(capsule), '确认胶囊按钮不得写死 #000000 字色');
assert.ok(capsule.includes('--dsh-theme-surface-1'), '确认胶囊按钮底色应取主题 surface');
assert.ok(capsule.includes('--dsh-theme-radius-md'), '确认胶囊圆角应取主题 radius 阶梯');
// 编辑框字号必须与聊天正文/官方输入框同一套 token。主题下 --dsh-content-font-size 是 17px，
// 而正文与输入框都读 --dsh-chat-font-size（13px）——编辑框读前者会大 4px（实测 17/25 vs 13/22.1）。
const taBlock = clientCode.slice(clientCode.indexOf('var taStyle = {'), clientCode.indexOf('var btnRowStyle'));
// 只看真实的样式声明（`fontSize: "…"` / `lineHeight: "…"`），注释里提到旧 token 名不算违规
const taFont = (taBlock.match(/fontSize:\s*"([^"]+)"/) || [])[1] || '';
const taLine = (taBlock.match(/lineHeight:\s*"([^"]+)"/) || [])[1] || '';
assert.ok(!taFont.includes('--dsh-content-font-size'), `编辑框字号不得读 --dsh-content-font-size（主题下 17px，比正文大 4px），实际：${taFont}`);
assert.ok(!taLine.includes('--dsh-content-font-delta'), `编辑框行高不得再叠 delta，实际：${taLine}`);
assert.ok(taFont.includes('--dsh-chat-font-size'), `编辑框字号应取 --dsh-chat-font-size，实际：${taFont}`);
assert.ok(taLine.includes('--dsh-chat-line-height'), `编辑框行高应取 --dsh-chat-line-height，实际：${taLine}`);
console.log('✓ 图标与按钮样式已统一到 macOS 主题语言');
console.log('✓ 编辑框字号与聊天正文同源');

// 两处用户气泡（正常 / 撤回待定灰气泡）也必须与正文同源：主题下 --dsh-content-font-size 是 17px
const bubbleDecls = (clientCode.match(/fontSize:\s*"var\(--dsh-content-font-size[^"]*"/g) || []);
assert.strictEqual(bubbleDecls.length, 0, `气泡/编辑框不得再读 --dsh-content-font-size（主题下 17px），实际命中 ${bubbleDecls.length} 处：${bubbleDecls.join(', ')}`);
const deltaDecls = (clientCode.match(/lineHeight:\s*"calc\(22px \+ var\(--dsh-content-font-delta/g) || []);
assert.strictEqual(deltaDecls.length, 0, `行高不得再叠 --dsh-content-font-delta，实际命中 ${deltaDecls.length} 处`);

// 编辑框宽度上限必须与普通气泡同一条规则，不得写死 360px
// （实测 360px 在 695px 消息行里只占 52%，右侧空出 335px）
// 这里必须**真正执行** editWidthFor 取值，不能只对源码做子串匹配：
// 曾经只断言 `includes('min(80%')`，结果紧凑档写成 max(base, cap) 恒等于上限、
// 把紧凑档变成恒满宽（实测 556px/80%），断言照样绿灯。
const wfnSrc = clientCode.slice(clientCode.indexOf('function editWidthFor'), clientCode.indexOf('/** 编辑宽度档位'));
const editWidthFor = new Function('editWidthCustom', wfnSrc + '; return editWidthFor;')(() => '300px');
// 标准档：贴合内容，短文本不得被撑满
assert.strictEqual(editWidthFor('standard', 'hi', 200), 'min(44px, min(80%, var(--dsh-chat-content-width, 748px)))',
  '标准档短文本应贴合内容宽，不得写死宽度');
// 紧凑档：必须带上内容宽（随打字扩大），且不能退化成恒等于 80% 上限
const compactOut = editWidthFor('compact', 'hi', 200);
assert.ok(compactOut.includes('max(200px, 44px)'), `紧凑档应以气泡原宽起步，实际：${compactOut}`);
assert.ok(compactOut.startsWith('min('), `紧凑档必须整体收在 80% 上限内（min 包裹），实际：${compactOut}`);
assert.ok(!/^max\(/.test(compactOut), `紧凑档不得写成 max(base, cap)——那会恒等于上限，实际：${compactOut}`);
// 长文本仍要收在上限内，不能溢出
assert.ok(editWidthFor('standard', '中'.repeat(200), 200).includes('min(80%'), '长文本必须收在 80% 上限内');

console.log('\n======================================');
console.log('✔ 宿主接缝收敛专项测试全部通过！');
console.log('======================================\n');
