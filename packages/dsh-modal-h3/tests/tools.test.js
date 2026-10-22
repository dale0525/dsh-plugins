/**
 * Tests for the tool surface: names, descriptions and schema acceptability.
 *
 * The schemas here are the only part of the plugin the harness validates, and it
 * validates them in a way that fails at REGISTRATION — a schema outside the
 * supported subset throws before a single tool exists, which reads as "the
 * plugin is broken" rather than "one field is wrong". So every descriptor is
 * compiled and asserted against the same two functions the runtime uses:
 * `valueSchemaSpecToJsonSchema` for the output, and `assertSupportedJsonSchema`
 * for the result.
 *
 * The name test pins the namespace, not the individual names: `mcp__modal_h3__`
 * is how this harness spells a service-owned tool namespace, and the model's
 * existing `mcp__stitch__*` habit is what makes the new names legible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { assertSupportedJsonSchema, parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools';

import {
  GENERATION_TIMEOUT_MS,
  SERVER_NAME,
  SYNC_TIMEOUT_MS,
  TOOL_NAMES,
  accountsStatusTool,
  accountsSyncTool,
  cancelTaskTool,
  generateVideoTool,
  getTaskTool,
  listTasksTool,
  publicToolName,
  renderTaskResult,
} from '../src/tools.js';

/** Every descriptor, with the key it is registered under. */
const TOOLS = {
  generate: generateVideoTool(),
  get: getTaskTool(),
  list: listTasksTool(),
  cancel: cancelTaskTool(),
  accountsStatus: accountsStatusTool(),
  accountsSync: accountsSyncTool(),
};

test('the namespace is modal_h3 and every name carries it once', () => {
  assert.equal(SERVER_NAME, 'modal_h3');
  assert.equal(publicToolName('generate_video'), 'mcp__modal_h3__generate_video');
  for (const [key, definition] of Object.entries(TOOLS)) {
    assert.equal(definition.name, TOOL_NAMES[key], `name mismatch for ${key}`);
    assert.match(definition.name, /^mcp__modal_h3__[a-z_]+$/);
  }
  assert.equal(new Set(Object.values(TOOL_NAMES)).size, 6);
});

test('every output schema is inside the subset the runtime accepts', () => {
  for (const [key, definition] of Object.entries(TOOLS)) {
    const json = valueSchemaSpecToJsonSchema(definition.output.schema);
    assert.doesNotThrow(() => assertSupportedJsonSchema(json), `output schema rejected for ${key}`);
    assert.equal(json.type, 'object', `output root must be an object for ${key}`);
    assert.equal(json.additionalProperties, false, `output must be closed for ${key}`);
  }
});

test('every parameter schema compiles, and only genuinely optional fields are omitted from required', () => {
  const generate = parameterSchemaSpecToJsonSchema(generateVideoTool().parameters);
  assert.deepEqual(generate.required, ['prompt']);
  for (const [key, definition] of Object.entries(TOOLS)) {
    assert.doesNotThrow(() => parameterSchemaSpecToJsonSchema(definition.parameters), `parameters rejected for ${key}`);
  }
  assert.deepEqual(parameterSchemaSpecToJsonSchema(getTaskTool().parameters).required, ['task_id']);
  assert.equal(parameterSchemaSpecToJsonSchema(accountsSyncTool().parameters).required, undefined);
});

test('dry_run is a flag on generate_video rather than a seventh tool', () => {
  const properties = parameterSchemaSpecToJsonSchema(generateVideoTool().parameters).properties;
  assert.equal(properties.dry_run.type, 'boolean');
  assert.equal(TOOL_NAMES.dryRun, undefined);
});

test('reference lists declare their caps in the description, matching the contract', () => {
  const properties = parameterSchemaSpecToJsonSchema(generateVideoTool().parameters).properties;
  assert.match(properties.reference_images.description, /At most 9/);
  assert.match(properties.reference_videos.description, /At most 3/);
  assert.match(properties.reference_audios.description, /At most 3/);
  assert.match(properties.reference_images.description, /at most 12 files/);
});

test('the generation budget covers two attempts of the worker ceiling, and sync is measured in hours', () => {
  assert.equal(GENERATION_TIMEOUT_MS, 1_800_000);
  assert.equal(SYNC_TIMEOUT_MS, 21_600_000);
  assert.equal(generateVideoTool().timeoutMs, GENERATION_TIMEOUT_MS);
  assert.equal(accountsSyncTool().timeoutMs, SYNC_TIMEOUT_MS);
  // The worker allows 630s per attempt with at most two attempts.
  assert.ok(GENERATION_TIMEOUT_MS > 2 * 630_000);
});

test('every description states the limit the model would otherwise walk into', () => {
  assert.match(generateVideoTool().description, /1344x768/);
  assert.match(generateVideoTool().description, /4-15 second/);
  assert.match(generateVideoTool().description, /one generation at a time/);
  assert.match(getTaskTool().description, /ffprobe/);
  assert.match(accountsStatusTool().description, /live/);
  assert.match(accountsSyncTool().description, /idempotent/);
  assert.match(listTasksTool().description, /never contacts Modal/);
});

test('rendering a task result keeps the actionable lines and never prints a bare status', () => {
  const blocks = renderTaskResult({
    task_id: 'h3-1',
    status: 'completed',
    message: 'Generation completed.',
    account: 'acc1',
    output_path: '/tmp/output.mp4',
    report_path: '/tmp/report.json',
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  const text = blocks[0].text;
  assert.match(text, /Generation completed/);
  assert.match(text, /Account: acc1/);
  assert.match(text, /Output: \/tmp\/output\.mp4/);
  assert.match(text, /Report: \/tmp\/report\.json/);
});

test('the rendered text carries the two numbers the prompt has to quote', () => {
  // The guidance tells the model to write `effective duration of N seconds` and
  // to match the media map's label count. Both numbers are in the structured
  // value, but a model reading only the text block would have to guess — and a
  // wrong N is rejected by the prompt gate after the reference files were read.
  const [block] = renderTaskResult({
    status: 'dry-run',
    message: 'Dry run passed.',
    effective_duration_seconds: 4,
    output_frames: 96,
    generation_frames: 107,
  });
  assert.match(block.text, /Effective duration: 4 seconds/);
  assert.match(block.text, /Output frames: 96 \(from 107 generated\)/);
});
