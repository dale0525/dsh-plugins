# 逐条判据与实测数据

只在遇到下列具体情形时读对应条目，不必整篇读。四条门禁命令见 `AGENTS.md` 的「✅ 验证命令」。

> **`pnpm test` 在本地会因为「完整克隆」而红，而 CI 的浅克隆反而绿**：`scripts/sync-upstream.test.mjs`
> 的 `--preflight 对已同步的目标如实报告` 用例先判输出里有没有「浅克隆」，有就只要求
> `fetch --unshallow`，没有才要求 `/已同步/`。CI 的 checkout 默认 `fetch-depth: 1`，走的是浅克隆分支；
> 本地是完整克隆，于是真的去算共同祖先，一旦某个 fork 落后上游就报「落后：共同祖先 …」，
> 断言失败。**这不是回归**：判据是 `node scripts/sync-upstream.mjs --preflight <id>` 的输出
> ——状态是「落后」即属预期，只有它报「已同步」而测试仍红才是真问题。让该 fork 追上上游
> 或把本地克隆变浅才能消掉这条红，两者都不该为「让测试绿」而做。

> **`--workspace-concurrency=2` 不是性能旋钮，别调大**：`node --test` 与 vitest 各自按
> CPU 数开 worker，pnpm 再并发跑多个包，两个乘数叠起来会在 10 核机器上拉起 ~30 个测试进程，
> 把 `dsh-better-reasoning-effort` 的 jsdom 用例饿到撞 5000ms 默认超时（实测：默认并发
> 峰值净增 30 进程，本机三次运行均失败；限到 2 后净增 15 进程、通过且更快）。它是为了给 jsdom 留 CPU，
> 不是省时间。
>
> **增删子插件会改变并行配对，可能让「与本次改动无关」的包测试失败——别当成自己改坏了。**
> `--workspace-concurrency=2` 每次挑两个包同时跑，挑谁取决于工作区里有哪些包。删掉一个轻包后队列前移，
> `dsh-better-reasoning-effort` 可能改与 `dsh-config-manager`（1184 个测试）配对而被饿到超时
> （实测：删掉 `dsh-agy-link` 后本机 5/5 失败，失败用例名每次都不同，报 `Test timed out in 5000ms`；
> 把并发限到 1 即全绿，单独只跑这两个包稳定复现，换成轻包搭伴稳定通过）。该包源码可**逐字节未改**，
> 属调度副作用而非回归。判据：先 `git diff <base> -- <该包>/` 确认未改，再看并发限 1 是否转绿。

> **偶发失败的归属只能靠「改动前后同次数对比」判定，不能靠单次复跑**：一条测试时红时绿，
> 跑一次通过说明不了任何事——它本来就有失败概率。判据是把改动 stash 掉，在干净 HEAD 上以**同样的次数**
> 重复跑同一文件，比较两边的失败次数：相等即既有问题（本次实测 `dsh-ssh` 的
> `recordHostKey` 写文件与断言之间的竞态、`utils.parseKey(...).getPublicSSH` 的偶发失败，
> 改动前后各 12 次/20 次，失败次数分别为 3/3、1/1）。次数不同才可能是回归，再去查机制。
> 直接读代码猜「我是不是引入了竞态」不可靠：这两处的写盘本来就是 fire-and-forget，
> 竞态在改动前就存在，只看代码会误判成自己刚写坏。
>
> **两个根因已定位并修掉（2026-10-29）**，修法本身就是判据：①`dsh-ssh` 的测试助手用
> `utils.parseKey(hostKey).getPublicSSH()` 取公钥，而 `ssh2` 的 `generateKeyPairSync('ed25519')`
> 偶发产出**自己 `parseKey` 都拒绝**的密钥对（3000 次中 4 次，公私两半同时坏、同一密钥稳定失败），
> 且 `parseKey` 是**返回** `Error` 对象而非抛出，于是报成 `getPublicSSH is not a function`；
> 修法是循环重新生成直到 `parseKey` 成功。②`recordHostKey` 的写盘是 `void writeKnownHosts(...)`
> （刻意 fire-and-forget：内存里的信任决定要同步生效，连接不能等磁盘往返），测试在 `exec()` 返回后
> 立刻读文件必然偶发 `ENOENT`；修法是轮询等文件出现，**不能**把生产代码改成 `await`。
> 通用规律：**`parseKey` 这类「返回 Error 而非抛出」的 API，调用点必须显式判 `instanceof Error`**；
> **测试读一个刻意异步落盘的产物时必须轮询**。

> **`waitFor` 的墙钟预算要和并发配对一起算**：`dsh-better-reasoning-effort` 的 jsdom 用例
> 用 `waitFor(cond, 2000)` 轮询 DOM，而 `pnpm test` 的 `--workspace-concurrency=2` 会让它和
> 一个跑 30s 的包配对。CPU 被抢时轮询拿不到调度，2s 墙钟先到点，条件其实已成立 → 假红。
> 实测那条「`Test timed out in 5000ms`」的用例在人为负载下只需 **1565ms**。
> 修法是把预算按争用后的耗时定（`waitFor` → 30s、vitest `testTimeout`/`hookTimeout` → 30s），
> 不是删断言、也不是把并发调大。

> **时钟取样的断言必须注入 `now`，否则它按机器速度决定红绿**：`saveConfigSnapshot` 的
> `createdAt` 取自真实时钟（`opts.now ?? () => new Date()`），而
> `listConfigSnapshots` 按 `createdAt` 倒序、并列时退回 `id` 降序。同一测试里连着保存两次、
> 又断言「先存的排在后面」时，只要两次落在**同一毫秒**，比较器就按 id 裁决，`old` 会排到
> `new` 前面。实测两次连续写完成于同一毫秒的概率约 **27%**（200 次里 54 次），所以这条
> 断言在快机器上大概率红、在慢机器上大概率绿——本地 12 次全绿而 CI 红，正是这个方向。
> 判据是「这个测试有没有注入 `now`」，不是「本地跑几遍」：需要断言顺序就传
> `now: () => new Date('...')`，或者只比较集合（`.map(id).sort()`）。

> **测试的 TMPDIR 陷阱（macOS，仅 `dsh-config-manager`）**：该包的符号链接类测试
> （`packages/dsh-config-manager/src/**/*.test.ts`，如 `utils/recursive-walk.test.ts`、
> `utils/atomic-write.test.ts`）建真实符号链接，而 macOS 的 `/var/folders/...` 是
> `/private/var/...` 的符号链接 —— `realpath` 会把 home 解析到 `/private/...`，
> 导致「home 内」判定失败。跑该包测试前先 `mkdir -p /private/tmp/realhome` 并带
> `TMPDIR=/private/tmp/realhome/`。其余子包不受影响。

> **平台专属路径只在 CI 覆盖**：`packages/dsh-config-manager/src/utils/env-lock.ts` 的进程身份探测**只有 Linux 真正实现**
> （读 `/proc/<pid>/stat` 的 starttime）；darwin / win32 的默认 probe 返回 `null`（不校验 PID 复用，
> 留待宿主注入）。**Linux 分支在 macOS 上完全不走**，本地全绿不代表它正确。改到该文件或任何
> 平台分支代码后，必须让 CI 在 ubuntu 上跑过一次再判定通过。

> **不要用 `/proc/...` 当「不可写路径」**：`/proc` 只存在于 Linux。macOS 上该路径仅是不存在
> （快速失败，测试为错误的原因通过），Linux 上 `mkdir` 不返回，整个测试套件挂死并撞 CI 的
> `timeout-minutes`。用「父路径是普通文件」的可移植写法：`mkdir` / `writeFile` 在三个平台都
> 稳定抛 `ENOTDIR` / `EEXIST`。

> **不要用哈希比对「本机构建产物」与「安装下来的产物」**：`dsh-config-manager` 与 `dsh-imagegen`
> 的 client 半边用 lightningcss 编译 CSS Modules，而它的类名哈希由**文件绝对路径**派生
> （`tsdown.config.ts` 把 `resolve(base, source)` 当 `filename` 传给 `transform`）—— 同一份 CSS
> 在 CI（`/home/runner/work/...`）与本机（如 `/Volumes/LogicExt/...`）构建出的 `lib/client.js`
> 必然不同。实测同一份 `config-manager.module.css`：本机得到 `Wcetya_*`，CI 得到 `A55DgG_*`；
> 两侧产物屏蔽掉类名哈希与内嵌路径后**逐字节相同**。所以「发布后本地安装」核验时看到
> `lib/client.js` 哈希不一致，是构建环境的必然差异，**不是装错版本**；要逐字节比对就先抹掉
> 类名哈希与路径，或改比 `lib/index.js`（宿主半边由 `tsc` 产出，不含哈希）。

- **根测试用 `pnpm test`，不用 `pnpm -r run test`**：`-r` 只覆盖 workspace 子项目，
  会跳过根包自己的 `scripts/*.test.mjs`。
