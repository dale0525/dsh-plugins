/**
 * dsh-ssh — host half.
 *
 * Lets the agent run commands and move files on hosts the user configured, as
 * five `ssh_*` tools. It replaces the `secret-safe-ssh` skill, which spawned the
 * real `ssh` binary with `SSH_ASKPASS` and a Python helper to feed the password:
 * that route needs OpenSSH, python and a POSIX shell on the DSH host, so it never
 * worked on Windows, and every call re-derived host facts from a YAML inventory
 * instead of from the plugin's own configuration.
 *
 * Four decisions are load-bearing:
 *
 *  - **Passwords live in the credential store, never in configuration.** A
 *    `role('secret')` config field is redacted from settings *reads*, but its
 *    plaintext still sits in the profile's `cordis.patch.yml`, which
 *    `dsh-config-manager` exports verbatim into every config-sync snapshot. So
 *    the host table carries only alias / host / port / username, and each host's
 *    password is the credential `SSH_PASSWORD_<ALIAS>`.
 *
 *  - **`ssh2` instead of the `ssh` binary.** Pure JavaScript, so the same code
 *    runs on macOS, Linux and Windows, and no password ever reaches a command
 *    line, an environment variable or a temporary file.
 *
 *  - **The host key is verified.** ssh2 accepts any host key by default, which
 *    with password authentication means handing the password to whoever answers.
 *    `known-hosts.js` records the first key and refuses a changed one.
 *
 *  - **The password is resolved per call.** It can be set, replaced or cleared
 *    from the Plugins page while the process runs, and a captured value would
 *    keep using a revoked password until the next restart.
 *
 * @module @logictan/dsh-ssh
 */
import { isAbsolute, resolve } from 'node:path';

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { Config, findHost, normalizeHosts } from './config.js';
import {
  connect,
  downloadFile,
  readRemotePrefix,
  runCommand,
  shellQuote,
  uploadFile,
  DEFAULT_COMMAND_TIMEOUT_MS,
  MAX_COMMAND_TIMEOUT_MS,
} from './connection.js';
import { SECTION_NAME, SECTION_ORDER, SSH_GUIDANCE } from './guidance.js';
import { knownHostsPath, readKnownHosts, writeKnownHosts } from './known-hosts.js';
import { buildLineWindow, READ_LIMIT, READ_TRANSFER_MAX_BYTES } from './text-window.js';
import { TOOL_NAMES, downloadTool, execTool, listTool, readTool, uploadTool } from './tools.js';

export { Config };
export { PASSWORD_REF_PREFIX, passwordRef } from './config.js';

/** Plugin row id; must equal the row id in `cordis.patch.yml`. */
export const name = 'dsh-ssh';

/**
 * Mount the five tools and announce the route's contract.
 *
 * @param ctx - the plugin context.
 * @param config - live reference over {@link Config}, when the loader supplies one.
 */
export function apply(ctx, config) {
  /**
   * The configured hosts as plain values, right now.
   *
   * Resolved per use: the loader commits a Plugins-page edit into this very
   * reference, so a snapshot taken at activation would keep serving the table
   * the process started with.
   *
   * @returns `{hosts, errors}`.
   */
  const hostsNow = () => normalizeHosts(config?.get()?.hosts);

  /**
   * Resolve one host's password from the credential store.
   *
   * @param host - the normalized host row.
   * @returns the password.
   * @throws when no password is stored, naming the exact reference to set.
   */
  const passwordOf = async (host) => {
    const credentials = ctx.get('credentials');
    if (credentials === undefined || credentials === null) {
      throw new Error('dsh-ssh: 当前部署没有凭据服务，无法读取密码。');
    }
    const resolved = await credentials.resolve(host.passwordRef);
    const value = resolved?.value ?? '';
    if (value === '') {
      throw new Error(
        `dsh-ssh: ${host.alias} 还没有设置密码。请在「设置 → 插件 → dsh-ssh」里为该主机填写密码（凭据引用 ${host.passwordRef}）。`,
      );
    }
    return value;
  };

  /**
   * Open a connection to one host, verifying and recording its host key.
   *
   * The known-host file is read per connection rather than cached: it is edited
   * by hand when a host is rebuilt, and a cached copy would keep refusing the
   * new key until a restart.
   *
   * @param host - the normalized host row.
   * @param signal - caller cancellation.
   * @returns `{client, fingerprint}`.
   */
  const open = async (host, signal) => {
    const path = knownHostsPath(resolveDshHome());
    const knownHosts = await readKnownHosts(path);
    const password = await passwordOf(host);
    return connect({
      host,
      password,
      knownHosts,
      signal,
      recordHostKey: ({ address, fingerprint }) => {
        // The in-memory entry is set synchronously, before the verifier returns:
        // the password is offered immediately after, and a trust decision made
        // only after the write settled would be one the connection already used.
        knownHosts.entries[address] = fingerprint;
        void writeKnownHosts(path, knownHosts.entries).catch((error) => {
          ctx.logger?.warn?.(`dsh-ssh: 记录 ${address} 的主机密钥失败：${String((error && error.message) || error)}`);
        });
      },
    });
  };

  /**
   * Resolve one host by alias, or throw the message a model can act on.
   *
   * @param alias - the alias the caller passed.
   * @returns the normalized host row.
   */
  const requireHost = (alias) => {
    const { hosts, errors } = hostsNow();
    const host = findHost(hosts, alias);
    if (host !== undefined) return host;
    const configured = hosts.map((entry) => entry.alias).join(', ');
    const suffix = configured === '' ? '当前没有任何主机配置。' : `已配置的主机：${configured}。`;
    const detail = errors.length > 0 ? `配置错误：${errors.join('；')}。` : '';
    throw new Error(`dsh-ssh: 没有 alias 为 "${alias}" 的主机。${suffix}${detail}`);
  };

  /**
   * Turn a caller path into an absolute one.
   *
   * @param path - caller-supplied path.
   * @param cwd - the session working directory, when known.
   * @returns the absolute path.
   */
  const absolutePath = (path, cwd) => {
    if (isAbsolute(path)) return path;
    if (cwd === undefined || cwd === '') throw new Error(`dsh-ssh: 路径 "${path}" 是相对路径，但当前会话没有工作目录`);
    return resolve(cwd, path);
  };

  /** Session working directory of the calling agent, when it has one. */
  const sessionCwd = (exec) => {
    const cwd = exec?.agent?.session?.header?.cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
  };

  ctx.inject(['tools', 'credentials'], (toolsCtx) => {
    const tools = toolsCtx.get('tools');

    const definitions = [
      defineTool({
        ...listTool(),
        async execute() {
          const { hosts, errors } = hostsNow();
          const credentials = toolsCtx.get('credentials');
          const rows = [];
          for (const host of hosts) {
            const info = credentials === undefined ? undefined : await credentials.describe(host.passwordRef);
            rows.push({
              alias: host.alias,
              host: host.host,
              port: host.port,
              username: host.username,
              has_password: info?.configured === true,
            });
          }
          const missing = rows.filter((row) => !row.has_password).map((row) => row.alias);
          const head =
            rows.length === 0
              ? '没有配置任何 SSH 主机。请在「设置 → 插件 → dsh-ssh」里添加。'
              : `已配置 ${rows.length} 台主机。` + (missing.length > 0 ? `未设置密码：${missing.join(', ')}。` : '');
          return {
            message: head,
            hosts: rows,
            ...(errors.length > 0 ? { errors } : {}),
          };
        },
      }),
      defineTool({
        ...execTool(),
        async execute(args, exec) {
          const host = requireHost(args.alias);
          const seconds = args.timeout_seconds;
          const timeoutMs =
            seconds === undefined
              ? DEFAULT_COMMAND_TIMEOUT_MS
              : Math.min(Math.max(1, Math.round(seconds)), MAX_COMMAND_TIMEOUT_MS / 1000) * 1000;
          // The SSH `exec` request carries no working directory, so `workdir`
          // becomes a `cd` in the command text. Quoted, and refused rather than
          // silently ignored when the directory does not exist: a command that
          // ran somewhere else and succeeded is worse than one that failed.
          const command =
            args.workdir === undefined
              ? args.command
              : `cd ${shellQuote(args.workdir)} || exit 1\n${args.command}`;
          const started = Date.now();
          const { client, fingerprint } = await open(host, exec?.signal);
          try {
            const result = await runCommand({ client, command, timeoutMs, signal: exec?.signal });
            return {
              host: host.alias,
              address: `${host.host}:${host.port}`,
              command: args.command,
              ...(args.workdir === undefined ? {} : { workdir: args.workdir }),
              exit_code: result.code ?? -1,
              stdout: result.stdout,
              stderr: result.stderr,
              duration_ms: Date.now() - started,
              timeout_budget_seconds: Math.round(timeoutMs / 1000),
              host_key: fingerprint,
            };
          } finally {
            client.end();
          }
        },
      }),
      defineTool({
        ...readTool(),
        async execute(args, exec) {
          const host = requireHost(args.alias);
          const offset = args.offset === undefined ? 1 : Math.max(1, Math.round(args.offset));
          const limit = args.limit === undefined ? READ_LIMIT : Math.max(1, Math.round(args.limit));
          const { client, fingerprint } = await open(host, exec?.signal);
          try {
            const remote = await readRemotePrefix({
              client,
              host: host.alias,
              path: args.path,
              maxBytes: READ_TRANSFER_MAX_BYTES,
              signal: exec?.signal,
            });
            const window = buildLineWindow(remote.text, { offset, limit, capped: remote.capped });
            return {
              host: host.alias,
              address: `${host.host}:${host.port}`,
              path: args.path,
              offset: window.offset,
              lines: window.lines,
              total_lines: window.totalLines,
              file_bytes: remote.fileBytes,
              capped: remote.capped,
              truncated_by_bytes: window.truncatedByBytes,
              host_key: fingerprint,
            };
          } finally {
            client.end();
          }
        },
      }),
      defineTool({
        ...uploadTool(),
        async execute(args, exec) {
          const host = requireHost(args.alias);
          const localPath = absolutePath(args.local_path, sessionCwd(exec));
          const { client } = await open(host, exec?.signal);
          try {
            const { bytes } = await uploadFile({ client, host: host.alias, localPath, remotePath: args.remote_path });
            return {
              host: host.alias,
              address: `${host.host}:${host.port}`,
              local_path: localPath,
              remote_path: args.remote_path,
              bytes,
            };
          } finally {
            client.end();
          }
        },
      }),
      defineTool({
        ...downloadTool(),
        async execute(args, exec) {
          const host = requireHost(args.alias);
          const localPath = absolutePath(args.local_path, sessionCwd(exec));
          const { client } = await open(host, exec?.signal);
          try {
            const { bytes } = await downloadFile({ client, host: host.alias, remotePath: args.remote_path, localPath });
            return {
              host: host.alias,
              address: `${host.host}:${host.port}`,
              local_path: localPath,
              remote_path: args.remote_path,
              bytes,
            };
          } finally {
            client.end();
          }
        },
      }),
    ];

    toolsCtx.effect(() => {
      const disposers = definitions.map((definition) => tools.register(definition));
      toolsCtx.logger.info(`dsh-ssh: registered ${disposers.length} ssh_* tools (${Object.values(TOOL_NAMES).join(', ')})`);
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'dsh-ssh: ssh tools');

    // Inside this block, and read through `get` rather than `inject`: the
    // section tells the model these tools exist, so announcing it when the
    // registration was skipped would be worse than silence — while a declared
    // `systemPrompt` dependency would make a host without one lose the tools.
    const systemPrompt = toolsCtx.get('systemPrompt');
    if (systemPrompt === undefined || systemPrompt === null) {
      toolsCtx.logger.warn('dsh-ssh: the systemPrompt service is unavailable; the route contract was not announced.');
      return;
    }
    toolsCtx.effect(
      () => systemPrompt.section({ name: SECTION_NAME, order: SECTION_ORDER, text: SSH_GUIDANCE }),
      'dsh-ssh: route contract',
    );
  });
}
