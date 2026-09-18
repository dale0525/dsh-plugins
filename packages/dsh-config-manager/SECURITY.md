# 安全策略 / Security Policy

## 受支持版本 / Supported Versions

本插件随 `dsh-plugins` monorepo 滚动发布，建议始终使用最新版本。
只对**最新发布版本**提供安全修复；历史版本请升级后再反馈。

This plugin ships as part of the `dsh-plugins` monorepo with rolling releases.
Security fixes are provided for the **latest published version** only.

| 版本 / Version | 支持状态 / Support |
| --- | --- |
| 最新 / Latest | ✅ 支持 / Supported |
| 历史版本 / Older | ❌ 不受支持 / Not supported |

## 安全设计不变量 / Security Invariants

本插件在安全上有一组硬约束，改动时不得破坏（详见 `DEVELOPERS.md`）：

- **通道凭据不回传**：token / WebDAV 口令只写入 DSH credentials 槽位，响应里只出现 `configured` 布尔
- **凭据不可回读**：DSH 凭据槽位永不回读值，只做文件级读取
- **日志全程脱敏**：`redactValue` 掩码所有敏感值；UI 渲染前所有错误/报告文本再过 `redact()` 兜底
- **ZIP 视为不可信输入**：zip bomb 条目数上限、checksum 校验、Zip Slip 拒绝
- **导入前强制快照**：应用前落回滚快照，任一失败整体回滚

### ⚠️ 同步快照是明文（刻意的产品选择）

同步通道是**用户自有的私有通道**：勾选即同步，**不加密、不脱敏**。
因此快照会携带真实凭据值（provider 密钥等），`manifest.security.containsSecrets` 按实际内容如实标注。

**这意味着：同步渠道必须指向你自有的私有仓库。**
把通道指向公开仓库等同于公开你的全部凭据 —— 本插件不会、也无法阻止这种配置。

This plugin enforces hard security invariants: channel credentials are never
read back or returned to the browser, all logs are redacted, and ZIP archives
are treated as untrusted input.

**Sync snapshots are plaintext by design** — the sync channel is your own
private channel, so snapshots carry real credential values. Never point the
channel at a public repository.

## 漏洞报告 / Reporting a Vulnerability

请 **不要** 在公开 issue 中提交安全漏洞细节（尤其是 PoC 与样本数据）。

Please **do not** post vulnerability details (especially PoCs and sample data)
in public issues.

### 方式一（推荐）/ Preferred: GitHub 私有漏洞报告

使用 GitHub 的 **Security → Report a vulnerability**（私有漏洞报告）功能：

1. 打开 <https://github.com/dale0525/dsh-plugins/security/advisories>
2. 点击 **New draft security advisory** 提交报告
3. 报告将仅对维护者可见，我们会尽快处理并在修复后公开致谢

Use the private security advisory flow at
<https://github.com/dale0525/dsh-plugins/security/advisories> —
reports stay private until a fix is released.

### 方式二 / Alternative: 直接联系

如果私有报告不可用，可发邮件至仓库维护者（GitHub 主页可见邮箱），
主题请以 `[SECURITY]` 开头。

If private reporting is unavailable, email the maintainer (address visible on
the GitHub profile) with subject prefix `[SECURITY]`.

## 处理时限 / Disclosure Timeline

| 阶段 / Stage | 时限 / Timeline |
| --- | --- |
| 初步确认 / Initial triage | 3 个工作日 / 3 business days |
| 修复发布 / Fix release | 按严重程度而定，通常 ≤ 14 天 / varies, typically ≤ 14 days |
