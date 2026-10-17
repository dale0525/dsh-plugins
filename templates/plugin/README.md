# 新插件模板

把「新增一个自制插件，并让它带着配置项出现在插件页」压成 5 步。全程不需要手写 CSS：控件来自 `@logictan/dsh-plugins-shared-client`，字段来自宿主半边的 `Config` schema。

## 1. 复制模板

```bash
cp -R templates/plugin packages/dsh-<name>
grep -rl '<name>' packages/dsh-<name> | xargs sed -i '' 's/<name>/<你的行 id>/g'
```

行 id 与包名后缀一致（`dsh-todo-goal` → `todo-goal`），四处保持同值：`package.json` 的 `name` 为 `@logictan/dsh-<name>`、`cordis.patch.yml` 的 `id` 与 `name`、`src/index.ts` 的 `export const name`、`src/client.js` 的 `NS`。

## 2. 声明配置项

只改 `src/index.ts` 的 `Config` schema，一个字段一行：

```ts
export const Config = Schema.object({
  maxRetries: Schema.number().min(0).default(3).comment('重试次数').description('超限后放弃').volatile(),
})
```

浏览器半边不用动 —— `ConfigForm` 自己从 describe 镜像取 schema，按节点类型选控件：

| schema 节点 | 控件 |
| --- | --- |
| `boolean` | `Switch` |
| `string` | `TextField` |
| `string` + `role('secret')` | `SecretField`（掩码 + 显隐切换） |
| `number` | `NumberField`（带 `min`/`max`/`step` 步进器） |
| `union([...字面量])` | `Select` |
| `array(string)` | `ListEditor` |

`comment` 是字段标签，`description` 是标签下的一句话；不写 `comment` 就用字段名当标签。每个字段带 `.volatile()`，否则该路径的写入会被宿主拒绝，控件变成只读。

## 3. 登记进聚合包

`packages/all/aggregate.yml` 两节各加一行：

```yaml
patchFrom:
  - ../dsh-<name>
deps:
  - ../dsh-<name>
```

## 4. 生成并跑门禁

```bash
node scripts/aggregate.mjs
node scripts/aggregate.mjs --check
pnpm test && pnpm typecheck && pnpm run check:host
```

## 5. 首发与发布

新包由用户人工 `npm publish` 一次并配好 trusted publisher，之后的更新走 CI；`packages/all/package.json` 的 `version` 也要手工升一格。命令见根 `README.md` 的「发布」。

## 模板为什么长这样

`src/client.js` 是手写的 `.js` 而非 `.tsx`：它已经在客户端模块加载器协议里（不是模块、不 import、顶层调 `window.__ModuleLoader__.load`），`build.mjs` 原样拷进 `lib/client.js`，`tsc` 从不看它 —— 仓库里其余 5 个插件的浏览器半边也是这个形态。

注册槽位时注入的是 `configForm` / `configDescribe` 而不是 `form`：页面自己会传 `form` 属性，而槽位的属性合并顺序让宿主方（owner）最后展开、owner 优先，注入 `form` 会被页面那份冻结的 `{ state, mutate }` 静默盖掉 —— 它没有 `subscribe`，卡片会停在首次渲染的值上。
