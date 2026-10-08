/**
 * Tests for the Stitch → ToolRuntime adaptation seam.
 *
 * This file pins the two facts that decide whether the plugin works at all,
 * both measured against the live `tools/list`:
 *
 *  - the 15 public names are `mcp__stitch__<rawName>` VERBATIM, because they are
 *    the model's existing vocabulary from the retired `mcp-stitch` patch row;
 *  - `parameters` must be the raw upstream schema. Stitch's schemas carry
 *    `$defs` / `$ref` / `x-google-*`, which `assertSupportedJsonSchema` rejects
 *    (11 of 15 input schemas, 13 of 15 output schemas). Routing them through
 *    `defineTool` — which validates `parameters` at construction — throws; only
 *    `tools.register` accepts them, and only because it validates `output`
 *    alone. The "rejected schema still registers" cases below are that
 *    difference, not a boundary test: they are the exact shapes Stitch sends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createOutput,
  createToolDefinition,
  extractText,
  publicToolName,
  supportedOutputSchema,
} from '../src/tools.js';

/** Every tool name Stitch's `tools/list` returns, as of 2026-10-08. */
const STITCH_TOOL_NAMES = [
  'create_project',
  'get_project',
  'delete_project',
  'list_projects',
  'list_screens',
  'get_screen',
  'generate_screen_from_text',
  'edit_screens',
  'generate_variants',
  'upload_design_md',
  'create_design_system',
  'create_design_system_from_design_md',
  'update_design_system',
  'list_design_systems',
  'apply_design_system',
];

test('publicToolName reproduces the retired row vocabulary verbatim', () => {
  for (const rawName of STITCH_TOOL_NAMES) {
    const publicName = publicToolName('stitch', rawName);
    assert.equal(publicName, `mcp__stitch__${rawName}`);
    assert.ok(publicName.length <= 64, `${publicName} exceeds the 64-char limit`);
    assert.equal(publicName.replace(/[^A-Za-z0-9_-]/g, '_'), publicName);
  }
});

test('publicToolName disambiguates only when normalization loses information', () => {
  // A name needing replacement gets the identity hash appended, so two distinct
  // upstream tools can never collapse onto one public name.
  const dotted = publicToolName('stitch', 'a.b');
  assert.notEqual(dotted, 'mcp__stitch__a.b');
  assert.match(dotted, /^mcp__stitch__a_b_[0-9a-f]{12}$/);
  assert.equal(dotted, publicToolName('stitch', 'a.b'));

  const long = publicToolName('stitch', 'x'.repeat(80));
  assert.equal(long.length, 64);
  assert.match(long, /_[0-9a-f]{12}$/);
});

test('supportedOutputSchema keeps what the runtime accepts and drops the rest', () => {
  assert.deepEqual(supportedOutputSchema({ type: 'object', properties: { a: { type: 'string' } } }), {
    type: 'object',
    properties: { a: { type: 'string' } },
  });
  assert.equal(supportedOutputSchema(undefined), undefined);

  // The three shapes Stitch actually sends that the subset rejects.
  assert.equal(supportedOutputSchema({ $defs: { S: { type: 'object' } }, type: 'object' }), undefined);
  assert.equal(
    supportedOutputSchema({ type: 'object', properties: { n: { type: 'string', 'x-google-identifier': true } } }),
    undefined,
  );
  assert.equal(supportedOutputSchema({ type: 'object', properties: { d: { type: 'string', not: {} } } }), undefined);
});

test('a raw upstream input schema registers even when the subset rejects it', () => {
  // `create_design_system`'s real shape: `$defs` at the root. `defineTool` would
  // throw here; the definition below is what `tools.register` is handed.
  const definition = createToolDefinition({
    name: publicToolName('stitch', 'create_design_system'),
    description: 'Creates a design system.',
    inputSchema: {
      $defs: { Typography: { type: 'object' } },
      type: 'object',
      properties: { projectId: { type: 'string', 'x-google-identifier': true } },
      required: ['projectId'],
    },
    outputSchema: { $defs: { X: {} }, type: 'object' },
  });

  assert.equal(definition.parameters.$defs.Typography.type, 'object');
  assert.equal(definition.parameters.properties.projectId['x-google-identifier'], true);
  // The unsupported output schema degraded to the loose envelope rather than
  // reaching the runtime, where `assertSupportedJsonSchema` would reject it.
  assert.equal(definition.output.schema.properties.structuredContent.type, undefined);
  assert.deepEqual(definition.output.schema.required, ['content']);
});

test('createOutput requires structuredContent exactly when a schema was kept', () => {
  const withSchema = createOutput({ type: 'object', properties: {} });
  assert.deepEqual(withSchema.schema.required, ['content', 'structuredContent']);
  assert.equal(withSchema.schema.additionalProperties, false);

  const withoutSchema = createOutput(undefined);
  assert.deepEqual(withoutSchema.schema.required, ['content']);
  assert.equal(withoutSchema.schema.additionalProperties, false);
});

test('render projects the text blocks the model actually reads', () => {
  const output = createOutput(undefined);
  const blocks = output.render({}, { content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }] });
  assert.deepEqual(blocks, [{ type: 'text', text: 'first\nsecond' }]);
});

test('extractText reports a non-text block instead of dropping it silently', () => {
  assert.equal(extractText([{ type: 'text', text: 'a' }, { type: 'image', data: 'x' }]), 'a\n[image content is not projected to text]');
  assert.equal(extractText(undefined), '');
});

test('execute surfaces a Stitch tool error as a thrown Error carrying its text', async () => {
  const definition = createToolDefinition({
    name: 'mcp__stitch__get_project',
    description: '',
    inputSchema: { type: 'object' },
    call: async () => ({ isError: true, content: [{ type: 'text', text: 'project not found' }] }),
  });
  await assert.rejects(() => definition.execute({ name: 'projects/1' }, {}), /project not found/);
});

test('execute passes structured content through only when Stitch sent it', async () => {
  const base = { name: 'mcp__stitch__list_projects', description: '', inputSchema: { type: 'object' } };

  const withStructured = createToolDefinition({
    ...base,
    call: async () => ({ content: [{ type: 'text', text: 'ok' }], structuredContent: { projects: [] } }),
  });
  assert.deepEqual(await withStructured.execute({}, {}), {
    content: [{ type: 'text', text: 'ok' }],
    structuredContent: { projects: [] },
  });

  const withoutStructured = createToolDefinition({
    ...base,
    call: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  });
  // Absent, not `undefined`-valued: `createSuccessResult` validates the value
  // against a schema that forbids `structuredContent` when no schema was kept.
  assert.deepEqual(Object.keys(await withoutStructured.execute({}, {})), ['content']);
});
