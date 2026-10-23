/**
 * The five `ssh_*` tools.
 *
 * Names are bare (`ssh_exec`, not `mcp__…`): this is a first-party capability of
 * the plugin, not a proxied MCP server, and the models already read `ssh_` as
 * "run something over SSH".
 *
 * Every tool takes `alias` — the user-facing handle from the host table — and
 * never a raw hostname. That is the whole point of the alias: the model cannot
 * reach a machine the user did not configure, and the user can rename a
 * connection without touching a prompt.
 *
 * The failure each description spells out is the one a model walks into:
 * `ssh_exec` is not interactive (no password prompt, no `sudo` TTY prompt, no
 * editor), so a command that waits for input waits until the timeout.
 *
 * @module @logictan/dsh-ssh/tools
 */
import { DEFAULT_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS } from './connection.js';
import { READ_LIMIT, READ_TRANSFER_MAX_BYTES, formatReadWindow } from './text-window.js';

/** Public tool names, exported so tests and the guidance text cannot drift. */
export const TOOL_NAMES = {
  list: 'ssh_list',
  exec: 'ssh_exec',
  read: 'ssh_read',
  upload: 'ssh_upload',
  download: 'ssh_download',
};

/** Message shape shared by the three operation tools. */
const HOST_RESULT_PROPERTIES = {
  host: { type: 'string', required: true, description: 'Alias of the host this ran on.' },
  address: { type: 'string', required: true, description: 'host:port that was dialled.' },
};

/**
 * Describe `ssh_list`.
 *
 * @returns the tool definition fields, minus `execute`.
 */
export function listTool() {
  return {
    name: TOOL_NAMES.list,
    description:
      'List the SSH hosts configured in this DSH instance. Each entry reports its alias (the handle every other ssh_* tool ' +
      'takes), host, port, username and whether a password is stored for it. ' +
      'Reads local configuration only: it opens no connection, so a host is listed even while it is unreachable.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
          hosts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                alias: { type: 'string', required: true, description: 'Handle used by the other ssh_* tools.' },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true },
                username: { type: 'string', required: true },
                has_password: { type: 'boolean', required: true, description: 'Whether a password is stored in the credential store.' },
              },
            },
          },
          errors: { type: 'array', items: { type: 'string' }, description: 'Configuration rows that were rejected, and why.' },
        },
      },
      render: (_args, value) => {
        const lines = [value.message];
        for (const row of value.hosts) {
          const state = row.has_password ? '密码已设置' : '未设置密码';
          lines.push(`- ${row.alias}  ${row.username}@${row.host}:${row.port}  ${state}`);
        }
        if (value.errors !== undefined && value.errors.length > 0) {
          lines.push('', '--- 配置错误 ---', ...value.errors);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
  };
}

/**
 * Describe `ssh_exec`.
 *
 * @returns the tool definition fields, minus `execute`.
 */
export function execTool() {
  return {
    name: TOOL_NAMES.exec,
    description:
      'Run one shell command on a configured SSH host and return its exit code, stdout and stderr. ' +
      'The command runs through the server login shell, so pipes, redirection and `&&` work. ' +
      'Pass `workdir` instead of prefixing `cd /x && …`, the same way the local bash tool takes `workdir`. ' +
      'It is NOT interactive: a command that waits for input (an editor, a `sudo` password prompt, `read`) blocks until the timeout and is then aborted. ' +
      'Use non-interactive forms (`sudo -n`, `apt-get -y`, `GIT_TERMINAL_PROMPT=0`) instead. ' +
      'Each call opens its own connection; stdout and stderr keep their head and tail and are cut in the middle if very long. ' +
      'To read a remote text file, use ssh_read rather than `cat`.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Alias of a configured host, as reported by ssh_list.' },
      command: { type: 'string', required: true, description: 'The shell command to run on the remote host.' },
      workdir: {
        type: 'string',
        description: 'Remote directory to run in. Omit to use the login shell\'s default directory.',
      },
      timeout_seconds: {
        type: 'integer',
        description: `Budget for the command in seconds. Defaults to ${DEFAULT_COMMAND_TIMEOUT_MS / 1000}; at most ${MAX_COMMAND_TIMEOUT_MS / 1000}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...HOST_RESULT_PROPERTIES,
          command: { type: 'string', required: true, description: 'The command as it was sent.' },
          workdir: { type: 'string', description: 'Remote directory the command ran in, when one was given.' },
          exit_code: { type: 'integer', required: true, description: 'Exit status reported by the remote process; -1 when the connection ended without one.' },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          duration_ms: { type: 'integer', required: true },
          timeout_budget_seconds: { type: 'integer', required: true, description: 'The budget the call was allowed, whether or not it was used.' },
          host_key: { type: 'string', description: 'SHA256 fingerprint of the host key that was accepted.' },
        },
      },
      render: (_args, value) => {
        // The command is echoed for correlation, not for reading back: a heredoc
        // pasted into `command` would otherwise put a whole script between the
        // caller and the output it asked for.
        const firstLine = value.command.split('\n', 1)[0];
        const extra = value.command.includes('\n') ? `  … (${value.command.split('\n').length} lines)` : '';
        const where = value.workdir === undefined ? '' : `  in ${value.workdir}`;
        // Every budget fact sits in the header. A `timeout: 300s` line after
        // stderr reads as "this command timed out", which is the one thing it
        // does not mean.
        const lines = [
          `$ ${firstLine}${extra}`,
          `host: ${value.host} (${value.address})${where}`,
          `exit: ${value.exit_code}  ·  ${value.duration_ms} ms  ·  timeout_budget: ${value.timeout_budget_seconds}s`,
        ];
        if (value.stdout !== '') lines.push('', '--- stdout ---', value.stdout.replace(/\n$/, ''));
        if (value.stderr !== '') lines.push('', '--- stderr ---', value.stderr.replace(/\n$/, ''));
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    // The registry budget must exceed the largest per-call budget, or the tool
    // layer would abort a command the plugin is still legitimately waiting on.
    timeoutMs: MAX_COMMAND_TIMEOUT_MS + 30_000,
  };
}

/**
 * Describe `ssh_read`.
 *
 * @returns the tool definition fields, minus `execute`.
 */
export function readTool() {
  return {
    name: TOOL_NAMES.read,
    description:
      'Read a UTF-8 text file on a configured SSH host, with line numbers, the same way the local read tool does. ' +
      'Use this instead of `cat` through ssh_exec. `offset` and `limit` select a line window exactly like the local read tool. ' +
      'Only the head of the file is transferred (a 512 KiB read cap), so for a large file the footer says the later lines were not scanned — ' +
      'narrow the range with ssh_exec (sed/awk/tail) or copy the file with ssh_download.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Alias of a configured host, as reported by ssh_list.' },
      path: { type: 'string', required: true, description: 'Remote file path to read.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${READ_LIMIT}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...HOST_RESULT_PROPERTIES,
          path: { type: 'string', required: true, description: 'The remote path as it was read.' },
          offset: { type: 'integer', required: true },
          lines: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                number: { type: 'integer', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          total_lines: { type: 'integer', required: true, description: 'Lines scanned; a prefix of the file when capped.' },
          file_bytes: { type: 'integer', required: true },
          capped: { type: 'boolean', required: true, description: 'Whether the file was larger than the read cap.' },
          truncated_by_bytes: { type: 'boolean', required: true, description: 'Whether this window was cut by the byte cap.' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: formatReadWindow({
            path: `${value.host}:${value.path}`,
            offset: value.offset,
            lines: value.lines,
            totalLines: value.total_lines,
            truncatedByBytes: value.truncated_by_bytes,
            capped: value.capped,
            fileBytes: value.file_bytes,
            scannedBytes: READ_TRANSFER_MAX_BYTES,
          }),
        },
      ],
    },
    timeoutMs: MAX_COMMAND_TIMEOUT_MS,
  };
}

/**
 * Describe `ssh_upload`.
 *
 * @returns the tool definition fields, minus `execute`.
 */
export function uploadTool() {
  return {
    name: TOOL_NAMES.upload,
    description:
      'Copy one local file to a configured SSH host over SFTP. Both paths are absolute on their own side: ' +
      '`local_path` on this machine, `remote_path` on the host. ' +
      'A relative `local_path` is resolved against the session working directory. ' +
      'The remote parent directory must already exist — this does not create directories.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Alias of a configured host, as reported by ssh_list.' },
      local_path: { type: 'string', required: true, description: 'File to read on this machine.' },
      remote_path: { type: 'string', required: true, description: 'Destination path on the host.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...HOST_RESULT_PROPERTIES,
          local_path: { type: 'string', required: true },
          remote_path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true, description: 'Bytes written on the host.' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `uploaded ${value.bytes} bytes\n  from ${value.local_path}\n  to   ${value.host}:${value.remote_path}`,
        },
      ],
    },
    timeoutMs: MAX_COMMAND_TIMEOUT_MS,
  };
}

/**
 * Describe `ssh_download`.
 *
 * @returns the tool definition fields, minus `execute`.
 */
export function downloadTool() {
  return {
    name: TOOL_NAMES.download,
    description:
      'Copy one file from a configured SSH host to this machine over SFTP. Both paths are absolute on their own side: ' +
      '`remote_path` on the host, `local_path` on this machine. ' +
      'The local parent directory must already exist, and the remote file must exist — a missing remote file is an error ' +
      'rather than an empty local file.',
    parameters: {
      alias: { type: 'string', required: true, description: 'Alias of a configured host, as reported by ssh_list.' },
      remote_path: { type: 'string', required: true, description: 'File to read on the host.' },
      local_path: { type: 'string', required: true, description: 'Destination path on this machine.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...HOST_RESULT_PROPERTIES,
          local_path: { type: 'string', required: true },
          remote_path: { type: 'string', required: true },
          bytes: { type: 'integer', required: true, description: 'Bytes written locally.' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `downloaded ${value.bytes} bytes\n  from ${value.host}:${value.remote_path}\n  to   ${value.local_path}`,
        },
      ],
    },
    timeoutMs: MAX_COMMAND_TIMEOUT_MS,
  };
}
