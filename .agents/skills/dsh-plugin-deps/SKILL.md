---
name: dsh-plugin-deps
description: 改子插件 `package.json` 的 dependencies / peerDependencies / devDependencies，或遇到 typecheck 报 `does not satisfy the constraint never`、插件行被静默禁用、插件整行不激活、两个包声明同一个 patch 行 id 时加载。
---

# 依赖声明如何决定插件能否加载

这些规则的共同点是**违反后不报错**：编译通过、运行看似正常，功能却无声消失。

## 五条硬门禁

- **宿主包一律写 `peerDependencies`，绝不写 `dependencies`**：范围一旦不被当前宿主满足，pnpm 会另装一份副本，patch 行按副本的 peer 被兼容门禁拒绝——**静默禁用该行**。
- **`@deepseek-ai/dsh-client-ui-slots` 版本必须全仓库一致**：不同版本各留一份，声明合并落进另一份，`keyof SlotMap` 塌成 `never`——typecheck 报错而运行时完全正常。
- **devDependencies 的世代滞后会制造假绿**：`tsc` 校验的是旧 API 表面，全绿但校验了错的对象。
- **不要引入 require Node 内置模块的第三方 CJS 运行时依赖**：插件会**根本加载不起来**，报错完全看不出是依赖引起的。
- **换包一律先删再加，不要并存**：两个包声明同一个 patch 行 `id`，全新启动即硬崩。

## 按需细则

每条的机制、实测症状与判据（含「插件行不激活」的 provider 探针）见 `references/pitfalls.md`——只在真的改某一类依赖、或撞上对应症状时读。
