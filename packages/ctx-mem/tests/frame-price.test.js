/**
 * Pins the test-side pricing mirror in `tests/frame-price.js` against the host's
 * own estimator.
 *
 * Every budget assertion in `render.test.js` is only meaningful if the mirrored
 * arithmetic prices content the way the host does. The host's `estimateMessage`
 * is not exported from the package root, so it is reached by absolute path
 * (resolved through the exported `package.json`, which sidesteps the exports
 * map). When that module cannot be resolved the test SKIPS rather than passing
 * silently — a skip is visible, a green tick over an unverified mirror is not.
 *
 * The frame constants and the block sequence are pinned the same way, but
 * against the host's `lib/index.js` source text: pricing the host's frame
 * through both estimators only proves they agree with each other, so a mutated
 * `SUMMARY_OPEN_TAG` or preamble would keep that comparison green. Decoding the
 * literals out of the host's own source is what makes the mirror's constants
 * checkable at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { estimateMessage as mirror, framePrice as mirrorFrame } from './frame-price.js';
import {
  CHECKPOINT_PREAMBLE,
  SUMMARY_CLOSE_TAG,
  SUMMARY_OPEN_TAG,
  frameCheckpointMessage,
} from '../src/frame.js';

/** Resolve the host estimator module by absolute path, or `undefined`. */
async function loadHostEstimator() {
  let manifest;
  try {
    manifest = import.meta.resolve('@deepseek-ai/dsh-token-meter/package.json');
  } catch {
    return undefined;
  }
  const path = join(dirname(new URL(manifest).pathname), 'lib/types/estimate.js');
  try {
    readFileSync(path);
  } catch {
    return undefined;
  }
  return import(pathToFileURL(path).href);
}

/** Resolve the host frame source by absolute path, or `undefined`. */
function loadHostFrameSource() {
  let manifest;
  try {
    manifest = import.meta.resolve('@deepseek-ai/dsh-compaction-basic/package.json');
  } catch {
    return undefined;
  }
  const path = join(dirname(new URL(manifest).pathname), 'lib/index.js');
  try {
    return { path, text: readFileSync(path, 'utf8') };
  } catch {
    return undefined;
  }
}

/**
 * Pull one `const NAME = "<literal>";` declaration out of the host's built
 * source and decode the literal, or `undefined` when it is not declared there.
 *
 * The declaration is anchored to a whole line and the literal is decoded with
 * `JSON.parse`, so the comparison is against the host's actual string value
 * rather than against a re-typed copy of it.
 */
function hostLiteral(source, name) {
  const declaration = new RegExp(`^const ${name} = ("(?:[^"\\\\]|\\\\.)*");$`, 'm');
  const match = declaration.exec(source);
  return match === null ? undefined : JSON.parse(match[1]);
}

/** The host's `frameSummary` body, or `undefined` when it is not defined there. */
function hostFrameSummaryBody(source) {
  const match = /^function frameSummary\(summary\) \{([\s\S]*?)^\}/m.exec(source);
  return match === null ? undefined : match[1];
}

const host = await loadHostEstimator();
const hostFrame = loadHostFrameSource();

test('the pricing mirror matches the host estimator exactly', { skip: host === undefined ? 'host estimator module not resolvable' : false }, () => {
  const bodies = ['', 'x', 'x'.repeat(100), 'x'.repeat(1000), 'x'.repeat(10000)];
  for (const body of bodies) {
    // Price the same frame through BOTH estimators and compare.
    const framed = frameCheckpointMessage(body);
    assert.equal(
      mirror(framed),
      host.estimateMessage(framed),
      `frame with a ${body.length}-char body must price identically`,
    );
    assert.equal(mirrorFrame(body), mirror(framed), 'framePrice must agree with estimateMessage');
  }
})

test('the mirror prices every content-block arm like the host', { skip: host === undefined ? 'host estimator module not resolvable' : false }, () => {
  const messages = [
    { role: 'user', content: [] },
    { role: 'user', content: [{ type: 'text', text: 'hello world' }] },
    { role: 'user', content: [{ type: 'reasoning', text: 'thinking hard' }] },
    { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'b' }] },
    { role: 'assistant', content: [{ type: 'tool-call', name: 'bash', arguments: '{"command":"ls"}' }] },
    {
      role: 'user',
      content: [{ type: 'tool-result', content: [{ type: 'text', text: 'output here' }] }],
    },
    { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] },
    { role: 'system', content: [] },
    { role: 'system', content: [{ type: 'text', text: 'you are a helpful assistant' }] },
  ];
  for (const message of messages) {
    assert.equal(
      mirror(message),
      host.estimateMessage(message),
      `message ${JSON.stringify(message).slice(0, 60)} must price identically`,
    );
  }
})

// The two tests above compare the mirror against the host using frames that
// `src/frame.js` itself produced. That is a tautology for the constants: mutating
// SUMMARY_OPEN_TAG or the preamble in `src/frame.js` changes BOTH sides at once,
// so the arithmetic still agrees and the suite stays green. The tests below break
// the tautology by decoding the literals out of the host's own source text, so
// the mirrored constants are checked against something external to the mirror.

test('the mirrored frame constants are the host\'s own literals', { skip: hostFrame === undefined ? 'host frame module not resolvable' : false }, () => {
  const mirrored = [
    ['CHECKPOINT_PREAMBLE', CHECKPOINT_PREAMBLE],
    ['SUMMARY_OPEN_TAG', SUMMARY_OPEN_TAG],
    ['SUMMARY_CLOSE_TAG', SUMMARY_CLOSE_TAG],
  ];
  for (const [name, value] of mirrored) {
    const fromHost = hostLiteral(hostFrame.text, name);
    assert.notEqual(fromHost, undefined, `the host must declare ${name}`);
    assert.equal(value, fromHost, `${name} in src/frame.js must be the host's ${name} verbatim`);
  }
})

test('the mirrored frame builds the host\'s block sequence', { skip: hostFrame === undefined ? 'host frame module not resolvable' : false }, () => {
  // The host's own frameSummary is read as source, so the shape asserted below
  // cannot be re-derived from a mutated `src/frame.js`.
  const hostBody = hostFrameSummaryBody(hostFrame.text);
  assert.notEqual(hostBody, undefined, 'the host must define frameSummary');
  assert.ok(
    hostBody.includes('`${CHECKPOINT_PREAMBLE}\\n\\n${SUMMARY_OPEN_TAG}`'),
    'the host must open with the preamble, a blank line, and the open tag',
  );
  assert.ok(hostBody.includes('...summary'), 'the host must spread the summary blocks verbatim');
  assert.ok(hostBody.includes('text: SUMMARY_CLOSE_TAG'), 'the host must close with the close tag');

  const preamble = hostLiteral(hostFrame.text, 'CHECKPOINT_PREAMBLE');
  const openTag = hostLiteral(hostFrame.text, 'SUMMARY_OPEN_TAG');
  const closeTag = hostLiteral(hostFrame.text, 'SUMMARY_CLOSE_TAG');
  const body = '## Primary Request and Intent\n- do the thing\n\n## Next Step\n- verify';
  assert.deepEqual(frameCheckpointMessage(body), {
    role: 'user',
    content: [
      { type: 'text', text: `${preamble}\n\n${openTag}` },
      { type: 'text', text: body },
      { type: 'text', text: closeTag },
    ],
  });
})
