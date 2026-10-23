/**
 * Tests for the tool surface: names, schemas, and the limits each description
 * states.
 *
 * The schemas are the only part of the plugin the harness validates, and it
 * validates them at REGISTRATION — a field outside the supported subset throws
 * before a single tool exists, which reads as "the plugin is broken". So every
 * descriptor is compiled and checked against the same two functions the runtime
 * uses, and the name test pins the namespace: these are first-party tools, so
 * the names are bare `ssh_*` rather than an MCP-style `mcp__…` prefix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { assertSupportedJsonSchema, parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';

import { TOOL_NAMES, downloadTool, execTool, listTool, readTool, uploadTool } from '../src/tools.js';

/** Every descriptor, keyed by the role it plays. */
const TOOLS = {
  list: listTool(),
  exec: execTool(),
  read: readTool(),
  upload: uploadTool(),
  download: downloadTool(),
};

test('the five names are bare ssh_* names with no namespace prefix', () => {
  for (const [key, definition] of Object.entries(TOOLS)) {
    assert.equal(definition.name, TOOL_NAMES[key], `name mismatch for ${key}`);
    assert.match(definition.name, /^ssh_[a-z]+$/);
  }
  assert.equal(new Set(Object.values(TOOL_NAMES)).size, 5);
});

test('every output schema is inside the subset the runtime accepts', () => {
  for (const [key, definition] of Object.entries(TOOLS)) {
    const json = valueSchemaSpecToJsonSchema(definition.output.schema);
    assert.doesNotThrow(() => assertSupportedJsonSchema(json), `output schema rejected for ${key}`);
    assert.equal(json.type, 'object', `output root must be an object for ${key}`);
    assert.equal(json.additionalProperties, false, `output must be closed for ${key}`);
  }
});

test('every parameter schema compiles, and only genuinely optional fields are omitted', () => {
  assert.deepEqual(parameterSchemaSpecToJsonSchema(listTool().parameters).required, undefined);
  assert.deepEqual(parameterSchemaSpecToJsonSchema(execTool().parameters).required, ['alias', 'command']);
  assert.deepEqual(parameterSchemaSpecToJsonSchema(uploadTool().parameters).required, ['alias', 'local_path', 'remote_path']);
  assert.deepEqual(parameterSchemaSpecToJsonSchema(downloadTool().parameters).required, ['alias', 'remote_path', 'local_path']);
  for (const [key, definition] of Object.entries(TOOLS)) {
    assert.doesNotThrow(() => parameterSchemaSpecToJsonSchema(definition.parameters), `parameters rejected for ${key}`);
  }
});

test('the host is addressed by alias, never by hostname', () => {
  // The alias is the entire access-control surface: a tool that accepted a
  // hostname would reach a machine the user never configured.
  for (const [key, definition] of Object.entries(TOOLS)) {
    const json = parameterSchemaSpecToJsonSchema(definition.parameters);
    const properties = json.properties ?? {};
    if (key === 'list') {
      assert.deepEqual(properties, {});
      continue;
    }
    assert.equal(properties.alias.type, 'string', `${key} must take alias`);
    assert.ok(json.required.includes('alias'), `${key} must require alias`);
    for (const forbidden of ['host', 'port', 'username', 'password']) {
      assert.equal(properties[forbidden], undefined, `${key} must not take ${forbidden}`);
    }
  }
});

test('a description states the limit the model would otherwise walk into', () => {
  assert.match(execTool().description, /NOT interactive/);
  assert.match(execTool().description, /sudo -n/);
  assert.match(execTool().description, /own connection/);
  assert.match(uploadTool().description, /parent directory must already exist/);
  assert.match(downloadTool().description, /missing remote file is an error/);
  assert.match(listTool().description, /opens no connection/);
  for (const definition of Object.values(TOOLS)) {
    assert.ok(definition.description.length > 80, `${definition.name} description is too thin`);
  }
});

test('the command budget is bounded, and the registry budget exceeds it', () => {
  const exec = execTool();
  assert.equal(exec.timeoutMs, 900_000 + 30_000);
  // A tool-level budget below the per-call maximum would abort a command the
  // plugin is still legitimately waiting on.
  assert.ok(exec.timeoutMs > 900_000);
});

test('rendering an exec result keeps the exit code and both streams', () => {
  const [block] = execTool().output.render(
    { alias: 'nas', command: 'make' },
    {
      host: 'nas',
      address: '10.0.0.2:22',
      command: 'make',
      exit_code: 2,
      stdout: 'compiling\n',
      stderr: 'error: boom\n',
      duration_ms: 1200,
      timeout_budget_seconds: 120,
    },
  );
  assert.equal(block.type, 'text');
  assert.match(block.text, /\$ make/);
  assert.match(block.text, /exit: 2/);
  assert.match(block.text, /compiling/);
  assert.match(block.text, /error: boom/);
});

test('the timeout budget sits in the header, never after stderr', () => {
  // `timeout: 300s` printed last reads as "this command timed out" — the one
  // thing a completed command's result must not imply. The budget belongs with
  // the other per-call facts, above the output.
  const [block] = execTool().output.render(
    { alias: 'nas', command: 'journalctl -n 20', timeout_seconds: 300 },
    {
      host: 'nas',
      address: '10.0.0.2:22',
      command: 'journalctl -n 20',
      exit_code: 0,
      stdout: 'line\n',
      stderr: 'warning: x\n',
      duration_ms: 40,
      timeout_budget_seconds: 300,
    },
  );
  const lines = block.text.split('\n');
  const budgetLine = lines.findIndex((line) => line.includes('timeout_budget: 300s'));
  const stderrLine = lines.findIndex((line) => line.includes('--- stderr ---'));
  assert.notEqual(budgetLine, -1, 'the budget is not reported at all');
  assert.ok(budgetLine < stderrLine, 'the budget must come before the output');
  assert.equal(lines.at(-1).includes('timeout'), false, 'nothing after the output may mention a timeout');
});

test('a multi-line command is echoed by its first line only', () => {
  // A heredoc pasted into `command` used to be echoed whole, pushing stdout
  // far down the result. The echo is for correlation, not for reading back.
  const command = "bash <<'EOF'\necho one\necho two\necho three\nEOF";
  const [block] = execTool().output.render(
    {},
    {
      host: 'nas',
      address: '10.0.0.2:22',
      command,
      exit_code: 0,
      stdout: 'one\ntwo\nthree\n',
      stderr: '',
      duration_ms: 30,
      timeout_budget_seconds: 120,
    },
  );
  assert.match(block.text, /^\$ bash <<'EOF' {2}… \(5 lines\)/);
  assert.equal(block.text.includes('echo two'), false, 'the script body must not be echoed');
});

test('rendering a workdir names the directory it ran in', () => {
  const [block] = execTool().output.render(
    {},
    {
      host: 'nas',
      address: '10.0.0.2:22',
      command: 'pwd',
      workdir: '/srv/app',
      exit_code: 0,
      stdout: '/srv/app\n',
      stderr: '',
      duration_ms: 12,
      timeout_budget_seconds: 120,
    },
  );
  assert.match(block.text, /host: nas \(10\.0\.0\.2:22\) {2}in \/srv\/app/);
});

test('rendering a read window uses the same envelope as the local read tool', () => {
  const [block] = readTool().output.render(
    {},
    {
      host: 'nas',
      address: '10.0.0.2:22',
      path: '/var/log/app.log',
      offset: 2,
      lines: [
        { number: 2, text: 'second' },
        { number: 3, text: 'third' },
      ],
      total_lines: 9,
      file_bytes: 100,
      capped: false,
      truncated_by_bytes: false,
    },
  );
  assert.equal(block.type, 'text');
  assert.match(block.text, /^<path>nas:\/var\/log\/app\.log<\/path>\n<type>file<\/type>\n<content>\n/);
  assert.match(block.text, /2: second\n3: third/);
  assert.match(block.text, /Showing lines 2-3 of 9\. Use offset=4 to continue\./);
});

test('rendering the host list carries every alias, address and password state', () => {
  // The message alone says how many hosts exist; the model needs the aliases,
  // and those only exist in `hosts`, so a render that forwards `message` alone
  // leaves every ssh_* call to be guessed.
  const [block] = listTool().output.render(
    {},
    {
      message: '已配置 2 台主机。未设置密码：vps。',
      hosts: [
        { alias: 'nas', host: '10.0.0.2', port: 22, username: 'root', has_password: true },
        { alias: 'vps', host: '10.0.0.3', port: 2222, username: 'deploy', has_password: false },
      ],
    },
  );
  assert.equal(block.type, 'text');
  assert.match(block.text, /已配置 2 台主机/);
  for (const expected of ['nas', 'root@10.0.0.2:22', 'vps', 'deploy@10.0.0.3:2222']) {
    assert.ok(block.text.includes(expected), `the rendered list is missing ${expected}`);
  }
  assert.match(block.text, /nas[^\n]*密码已设置/);
  assert.match(block.text, /vps[^\n]*未设置密码/);
});

test('an empty host table renders the message alone', () => {
  const [block] = listTool().output.render({}, { message: '没有配置任何 SSH 主机。', hosts: [] });
  assert.equal(block.text, '没有配置任何 SSH 主机。');
});

test('rendering a transfer reports the byte count and both ends', () => {
  const [uploaded] = uploadTool().output.render(
    {},
    { host: 'nas', address: '10.0.0.2:22', local_path: '/tmp/a', remote_path: '/srv/a', bytes: 12 },
  );
  assert.match(uploaded.text, /12 bytes/);
  assert.match(uploaded.text, /nas:\/srv\/a/);

  const [downloaded] = downloadTool().output.render(
    {},
    { host: 'nas', address: '10.0.0.2:22', local_path: '/tmp/a', remote_path: '/srv/a', bytes: 34 },
  );
  assert.match(downloaded.text, /34 bytes/);
  assert.match(downloaded.text, /\/tmp\/a/);
});
