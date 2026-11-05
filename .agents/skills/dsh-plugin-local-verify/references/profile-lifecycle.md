# 临时 profile：建档、装本地包、隔离启动、核验、删除

只在真的要建临时 profile 做本地验证时读。变量与路径按实际包名、端口替换；`<WT>` 是 worktree 根，`<PKG>` 是子包绝对路径。

宿主没有 `dsh profile create` / `dsh profile delete` 子命令（`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js:105,116-117,211-249`）。建档靠 `--from-default-profile` 复制 shipped 模板，删除靠移除隔离 `DSH_HOME` 目录。

## 变量与前置核对

```
P=frtest
H=/tmp/dsh-verify-home          # 隔离 home，绝不指向 ~/.dsh
PORT=10099                      # 避开 3080（宿主默认）、10000（lan-access）、9222/9223（Chrome CDP）
PKG=<WT>/packages/<name>
```

先跑只读核对，不动线上：

```bash
ls -l "$PKG/lib/index.js" "$PKG/cordis.patch.yml"
/usr/sbin/lsof -nP -iTCP:3080 -sTCP:LISTEN
/usr/sbin/lsof -nP -iTCP:10000 -sTCP:LISTEN
/usr/sbin/lsof -nP -iTCP:$PORT -sTCP:LISTEN   # 应无 owner
dsh-web status                               # 只读；记下 Job PID，全程不用 stop/restart
```

`lsof` 在 `/usr/sbin`，PATH 缺它时会误报 NOT LISTENING（`dsh-plugin-runtime/references/verify.md:19-22`）。

## 1. 建空白 web 模板 profile（建而不启）

```bash
DSH_HOME=$H dsh --profile $P --from-default-profile web --dump-config
```

`--from-default-profile web` 只复制模板的 bundle 列表（`base` + `web-app`），不读本机 web 配置、不带现有插件（`profile-boot-C14i-8IN.js:129-135`）；`--dump-config` 不 boot（不评估 `!!js`）。目标名不能与 shipped 名 `acp/web/headless/sdk/sdk-minimal` 撞。

验证：`$H/profiles/$P/package.json` 的 `dsh.profile.bundles == [@deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app]`、`dependencies == {}`；`$H/profiles/$P/cordis.patch.yml == []`；`$H/profiles/web` 不存在。

另一条「首次 add 自动建」路径只给 `dsh-base`、不带 `web-app`，不能直接当 GUI 用，别用。

## 2. 构建本地产物

```bash
( cd "$PKG" && node build.mjs )
shasum -a 256 "$PKG/lib/index.js"
```

按 `AGENTS.md`「构建产物不入版本控制」：用产物前先查该子包 `package.json` 的 `scripts` 哪个钩子会构建，别假设 `pnpm install` 已建好。

## 3. 装本地包（只装目标子包，不装聚合包）

```bash
DSH_HOME=$H dsh plugin --profile $P add file:$PKG
```

- 绝对路径必须写全；相对 `./` 会被锚定到调用 cwd（`dsh-plugin-manager/lib/index.js:300-304`）。
- `link:$PKG` 同样被接受（`plugin-manager/lib/index.js:135-143`），是软链、直接读工作树 `lib/`；`file:` 是实体副本、安装时触发 `prepare` 重建产物。两者都行，仓库明文记载的是 `file:`。
- `add` 同时写 `package.json` 的 `dependencies` 与 `dsh.profile.bundles`、`pnpm-lock.yaml`、`node_modules/<pkg>/`；是否写 `cordis.patch.yml` 未见 CLI 写入证据，按实际文件核对。
- **独立纯 host-half 子包必须保留 `dsh.profile.bundles`**：它的 `- id: <id>` patch 行是唯一挂载来源，靠 bundles 列表加载。`dsh-plugin-release/references/ci-failures.md:76-95` 那条「摘掉 bundles」针对的是「已由聚合包 patch 挂载、又单独 add 一次」的相反场景，别照搬。
- **不要再装 `@logictan/dsh-plugins-all`**：聚合 patch 已含该子包，两个 `- id` 并存会 `duplicate loader entry id` 硬崩（仓库 `AGENTS.md`）。
- 若 pnpm 10 的 `allowBuilds` 拦下本地包，看 `<profile>/.plugin-manager/logs/operation-*/pnpm.log`。

验证（不需重启）：

```bash
node -e "const m=require('$H/profiles/$P/package.json'); console.log(m.dependencies, m.dsh.profile.bundles)"
ls -l "$H/profiles/$P/node_modules/@logictan/<name>"     # 看是副本还是软链
shasum -a 256 "$H/profiles/$P/node_modules/@logictan/<name>/lib/index.js" "$PKG/lib/index.js"   # 应一致
DSH_HOME=$H dsh --profile $P --dump-config | grep -A2 '<id>'    # 应见 - id / name 行
```

**实测修正（2026-11-05，隔离 `file:` 安装 `@logictan/dsh-force-rules`）**：`createRuntimeResolution(...).entries.some(e => e.name === '<pkg>')` 对独立 `file:` 包返回 `false`，保留与摘掉 `dsh.profile.bundles` 两种形态都是 `false`，但保留 bundles 时 `--dump-config` 有 `- id: force-rules`、摘掉后该行消失，且服务能启动、会话里规则注入生效。所以这里**不要**拿 `ci-failures.md:90-95` 的解析表结果判独立包是否挂载；判据改用 `--dump-config` 的 patch 行 + `lib/` 校验和 + 运行时证据。解析表那条只适用于它记录的「已由聚合包 patch 挂载、又单独 add」场景。

## 4. 复制登录态（浏览器验证前必须做）

空白隔离 home 没有模型凭据与配置块；不复制会让 GUI 停在登录/模型配置。复制完整凭据与最小配置块后，隔离服务本身**不需要 DeepSeek 账号登录**。CDP 目标列表里的 `platform.deepseek.com/sign_in` 可能是复制凭据前遗留的旧标签，不代表当前页面状态；判断当前状态要看本次打开的隔离 URL、带 cookie 的 curl 返回和页面 DOM。

1. 若隔离服务已启动，先停它：`kill "$(cat /tmp/dsh-$P.pid)"`，确认 `$PORT` 无 owner。**不要**用 `dsh-web stop`。首次尚未启动服务时跳过本步。
2. 复制凭据文件，保持 600：`cp ~/.dsh/.credentials.yaml "$H/.credentials.yaml"; chmod 600 "$H/.credentials.yaml"`。只列文件名，不把内容打进日志或对话。
3. 从 `~/.dsh/profiles/web/cordis.patch.yml` **按 `- id:` 精确切块**复制最小配置到 `$H/profiles/$P/cordis.patch.yml`：`llm-pi-ai`（模型与 provider）、`agent-default-model`、`permission`、`agent-preset-registry`、`subagent`（含 `maxDepth: 2`）。用脚本按 id 切块，不整份拷贝 web patch——整份会带进 lan-access、本地脚本等无关配置，且可能与独立子包 patch id 撞车。
4. 目标 patch 文件里宿主自写的 `ui-settings-general` 等行保留，复制块追加在后面；先 `cp` 一份 `$DST.before` 做回滚。空白模板的 `cordis.patch.yml` 是 `[]`，追加的是列表项而不是第二份 YAML 标量；复制后用 `--dump-config` 确认语法可解析。
5. 验证：`DSH_HOME=$H dsh --profile $P --dump-config` 里能看到上述 id，且仍有目标子包的 `- id: <id>`；`--dump-config` 不 boot，不需重启。
6. 启动或重启隔离服务（第 5 节命令），取**新** token URL 并重新告知用户；旧 token 失效。凭据只留在 `$H`，第 6 节删 `$H` 时一并清除。
7. 浏览器验证前用带 cookie 的 `curl -sS -c <jar> -b <jar> -L '<完整 token URL>'` 确认页面可进入：token URL 会先 303 设置认证 cookie 再跳到 `/`，不带 cookie 重放会误得 401，不能据此判定需要登录。

`llm-pi-ai` 的 `apiKeyEnv` 指向 `.credentials.yaml` 里的键，两者必须一起复制；模型回复能否成功以隔离会话日志 `assistant/message` 为准，不以 browser agent 的 `done` 为准。

## 5. 在 web profile 之外启动（后台、隔离 home、独立端口）

```bash
DSH_HOME=$H dsh --profile $P --no-open --port $PORT > /tmp/dsh-$P.log 2> /tmp/dsh-$P.err &
echo $! > /tmp/dsh-$P.pid
```

`--port` 是 web app 参数（`dsh-web-app/lib/startup.js:25,29`），`--no-open` 免自动开浏览器。stdout 打印 `dsh web: <authenticatedUrl>`（`dsh-web-app/lib/index.js:162`），URL 自带 `?token=<launchToken>`（每进程一枚，`dsh-client-connection/lib/index.js:440-443`）。**不要用 `:10000` 或 `:3080` 的 token**。

验证：

```bash
grep 'dsh web:' /tmp/dsh-$P.log                       # 取完整 token URL
/usr/sbin/lsof -nP -iTCP:$PORT -sTCP:LISTEN
curl -s -o /dev/null -w '%{http_code}' '<完整 token URL>'   # 2xx/3xx
ps -ww -p "$(cat /tmp/dsh-$P.pid)" -o command=      # 应含 --profile $P --port $PORT
dsh-web status                                      # 仍 Verdict: OK，Job PID 未变
```

**先把完整 token URL 原文告知用户，再进浏览器验证**（见 `browser-verification.md`）。

本包为纯 host-half 时，`/plugins/??<pkg>/client.js&rev=` 判据不适用（无 client surface）；`request/header` 要读最后一条、工具清单在 `data.header.tools`，但本包不注册工具，能验的是系统提示/规则文本与运行期行为。这些属 `dsh-plugin-runtime` 技能，按需加载。

## 6. 删除（仅在浏览器验证通过后）

```bash
kill "$(cat /tmp/dsh-$P.pid)"                        # 停自己起的进程，不用 dsh-web stop
/usr/sbin/lsof -nP -iTCP:$PORT -sTCP:LISTEN          # 应无输出
ls -ld "$H" "$H/profiles/$P" /Users/logictan/.dsh/profiles/web "$PKG"   # 展开核对绝对路径
rm -rf "$H"                                         # 只删隔离 home；绝不带 ~/.dsh/profiles/web
dsh-web status                                      # Verdict: OK、Job PID 未变
```

删除前确认：`$H` 解析后不是 `/Users/logictan/.dsh`、`$P` 不是 `web` 也不是当前运行 profile；`$PKG` 是源目录、不在待删路径内。`dsh-web stop` 会 bootout 线上 launchd job 并回收 :10000，绝不能用。

复制过登录态时，删除 `$H` 同时清掉 `/tmp/dsh-frtest-package.json.bak`、`/tmp/dsh-frtest-cordis.before.yml` 之类备份；它们含凭据或可反推本机配置，不留到验证结束。

验证不通过时保留 `$H` 供排查，不删除、不发版（SKILL.md 停止条件）。
