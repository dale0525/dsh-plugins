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

import { TOOL_NAMES, downloadTool, execTool, listTool, uploadTool } from '../src/tools.js';

/** Every descriptor, keyed by the role it plays. */
const TOOLS = {
  list: listTool(),
  exec: execTool(),
  upload: uploadTool(),
  download: downloadTool(),
};

test('the four names are bare ssh_* names with no namespace prefix', () => {
  for (const [key, definition] of Object.entries(TOOLS)) {
    assert.equal(definition.name, TOOL_NAMES[key], `name mismatch for ${key}`);
    assert.match(definition.name, /^ssh_[a-z]+$/);
  }
  assert.equal(new Set(Object.values(TOOL_NAMES)).size, 4);
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
    },
  );
  assert.equal(block.type, 'text');
  assert.match(block.text, /\$ make/);
  assert.match(block.text, /exit: 2/);
  assert.match(block.text, /compiling/);
  assert.match(block.text, /error: boom/);
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
