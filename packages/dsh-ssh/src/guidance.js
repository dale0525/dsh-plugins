/**
 * What the model is told about this route, as a system-prompt section.
 *
 * Three facts here are the ones a tool description cannot carry usefully,
 * because they are about *addressing* rather than about one call:
 *
 *  - hosts are named by alias, and the alias list is the only set of machines
 *    reachable — a hostname that is not in the table is not a typo to guess at;
 *  - the password is never the model's to handle, so it must not be asked for,
 *    echoed, or put in a command;
 *  - the shell is non-interactive, which is the difference between a command
 *    that returns and one that hangs for the whole timeout.
 *
 * @module @logictan/dsh-ssh/guidance
 */

/** Section name in the system prompt; unique across plugins. */
export const SECTION_NAME = 'plugin:dsh-ssh';

/** Order within the tool-guidance band. */
export const SECTION_ORDER = 170;

/**
 * The route's contract, in the form a model needs before it runs a command.
 */
export const SSH_GUIDANCE = [
  '本机已安装 dsh-ssh 插件：让 Agent 在用户预配置的 SSH 主机上执行命令、读文本文件、上传下载文件。工具名 `ssh_list`、`ssh_exec`、`ssh_read`、`ssh_upload`、`ssh_download`。',
  '',
  '主机用 alias 指代。先用 `ssh_list` 看有哪些 alias、各自是否有密码；不要自己猜主机名或 IP——表里没有的机器就是访问不到，需要用户先在「设置 → 插件 → dsh-ssh」里添加。',
  '',
  '密码由插件从凭据库读取，既不在工具参数里，也不会返回给你。因此：不要向用户索要密码，不要把它写进命令、环境变量或任何文件，也不要在回复里复述。用户若在对话里贴出密码，提醒他改用插件设置页填写。',
  '',
  '`ssh_exec` 不是交互式会话：没有 TTY，等输入的命令（编辑器、`sudo` 密码提示、`read`、分页器）会一直挂到超时。改用非交互写法（`sudo -n`、`apt-get -y`、`systemctl --no-pager`、`GIT_TERMINAL_PROMPT=0`）。',
  '',
  '读远端文本文件用 `ssh_read`，不要用 `cat`——它返回与本地 `read` 工具相同的带行号窗口，同样接受 `offset` / `limit`。只在需要 shell 计算（`sed`、`awk`、`tail -f`、管道）时才用 `ssh_exec`。',
  '',
  '`ssh_exec` 的 `workdir` 取代 `cd /x && …` 前缀，语义与本地 bash 工具的 `workdir` 相同；目录不存在时直接失败，不会退到别的目录去跑。',
  '',
  '每次调用都新建一条连接，用完即关，不要在调用之间假设有状态（当前目录、环境变量、后台任务都不会保留）。要连续操作就把命令串在一条里。',
  '',
  '主机密钥按首次使用信任、之后变更即拒绝的策略校验。报「主机密钥校验失败」时不要绕过：先让用户确认那台机器是否重装过，再由用户决定是否清理 `$DSH_HOME/dsh-ssh/known-hosts.json` 里的对应条目。',
].join('\n');
