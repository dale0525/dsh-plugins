/**
 * Tests for the action projection.
 *
 * The projection is where a model's decision becomes a driver call, and the
 * failure it must not have is the silent one. A model that says "click" without a
 * point has made an incomplete decision, not an ambiguous one; defaulting to the
 * window centre would perform an action nobody asked for, in a place nobody chose.
 * Every missing-field case below therefore has to throw.
 *
 * The point bound check is the other half. The driver refuses an out-of-frame
 * point outright, so catching it here means the failure names the decision rather
 * than a bare number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { plan } from '../src/actions.js';

const TARGET = { pid: 42, windowId: 7, app: 'Calculator', title: '' };
const CONTEXT = { target: TARGET, frame: { width: 460, height: 816 }, deliveryMode: 'background' };

test('a click becomes a window-addressed driver call at the same pixel', () => {
  assert.deepEqual(plan({ kind: 'click', x: 176, y: 530 }, CONTEXT), {
    tool: 'cua_driver_native__click',
    args: { pid: 42, window_id: 7, x: 176, y: 530 },
  });
});

test('foreground delivery is passed through only when configured', () => {
  const args = plan({ kind: 'click', x: 10, y: 10 }, { ...CONTEXT, deliveryMode: 'foreground' }).args;
  assert.equal(args.delivery_mode, 'foreground');
  assert.equal(plan({ kind: 'click', x: 10, y: 10 }, CONTEXT).args.delivery_mode, undefined);
});

test('a click without a point throws instead of picking one', () => {
  assert.throws(() => plan({ kind: 'click' }, CONTEXT), /needs numeric x and y/);
});

test('a click on the accessibility channel names the channel instead of the frame', () => {
  // Regression: the AX channel has no screenshot, so its frame is null. Reading
  // through to width/height threw a bare TypeError, which reached the model as
  // "Cannot read properties of null" — a message that says nothing about why the
  // coordinate could not be placed or what to do instead.
  assert.throws(
    () => plan({ kind: 'click', x: 10, y: 10 }, { ...CONTEXT, frame: null }),
    /no screenshot frame is available/,
  );
  assert.throws(() => plan({ kind: 'click', x: 10, y: 10 }, { ...CONTEXT, frame: null }), /set_value with an element token/);
});

test('a point outside the observation frame is rejected with its coordinates', () => {
  assert.throws(() => plan({ kind: 'click', x: 500, y: 10 }, CONTEXT), /lies outside the 460×816 screenshot/);
});

test('a hallucinated coordinate is refused, and the message says how to recover', () => {
  // Measured, not hypothetical: asked for the centre of the largest button in a
  // 1567x894 window screenshot, a live vision model answered (310, 1062) -- the
  // y is past the bottom of the image, because it estimated in the window's own
  // coordinate space. The driver would refuse that point anyway; catching it
  // here is what lets the loop re-decide instead of burning the step.
  const wide = { ...CONTEXT, frame: { width: 1567, height: 894 } };
  assert.throws(() => plan({ kind: 'click', x: 310, y: 1062 }, wide), /lies outside the 1567×894 screenshot/);
  assert.throws(() => plan({ kind: 'click', x: 310, y: 1062 }, wide), /re-read the coordinates/);
  assert.equal(plan({ kind: 'click', x: 310, y: 700 }, wide).args.y, 700);
});

test('coordinates are rounded to whole pixels', () => {
  assert.equal(plan({ kind: 'click', x: 10.4, y: 10.6 }, CONTEXT).args.x, 10);
  assert.equal(plan({ kind: 'click', x: 10.4, y: 10.6 }, CONTEXT).args.y, 11);
});

test('a right click and a double click map to their own tools', () => {
  assert.equal(plan({ kind: 'right_click', x: 1, y: 1 }, CONTEXT).tool, 'cua_driver_native__right_click');
  assert.equal(plan({ kind: 'double_click', x: 1, y: 1 }, CONTEXT).tool, 'cua_driver_native__double_click');
});

test('a modified double click routes through click, which declares a modifier field', () => {
  // Regression: double_click carries a modifier but no count, so a modified
  // double click is expressed through click -- the one pointer tool whose schema
  // carries both fields.
  const planned = plan({ kind: 'double_click', x: 10, y: 20, modifiers: ['cmd'] }, CONTEXT);
  assert.equal(planned.tool, 'cua_driver_native__click');
  assert.equal(planned.args.count, 2);
  assert.deepEqual(planned.args.modifier, ['cmd']);
});

test('an unmodified double click stays on its own tool', () => {
  const planned = plan({ kind: 'double_click', x: 10, y: 20 }, CONTEXT);
  assert.equal(planned.tool, 'cua_driver_native__double_click');
  assert.equal(planned.args.modifier, undefined);
  assert.equal(planned.args.count, undefined);
});

test('a right click carries its modifier, since that schema declares one', () => {
  const planned = plan({ kind: 'right_click', x: 10, y: 20, modifiers: ['ctrl'] }, CONTEXT);
  assert.equal(planned.tool, 'cua_driver_native__right_click');
  assert.deepEqual(planned.args.modifier, ['ctrl']);
});

test('an unsupported kind is refused with the vocabulary', () => {
  assert.throws(() => plan({ kind: 'drag' }, CONTEXT), /"drag" is not an action/);
});

test('done and blocked are terminal and never reach the driver', () => {
  assert.deepEqual(plan({ kind: 'done', summary: 'finished' }, CONTEXT), { terminal: 'done' });
  assert.deepEqual(plan({ kind: 'blocked', reason: 'no' }, CONTEXT), { terminal: 'blocked' });
});

test('hotkey requires a modifier and a key', () => {
  assert.throws(() => plan({ kind: 'hotkey', keys: ['s'] }, CONTEXT), /at least one modifier and one key/);
  assert.deepEqual(plan({ kind: 'hotkey', keys: ['cmd', 's'] }, CONTEXT).args.keys, ['cmd', 's']);
});

test('set_value addresses an element token, never a coordinate', () => {
  const planned = plan({ kind: 'set_value', token: 's00000001:5', value: '12' }, CONTEXT);
  assert.equal(planned.args.element_token, 's00000001:5');
  assert.equal(planned.args.x, undefined);
  assert.throws(() => plan({ kind: 'set_value', value: '12' }, CONTEXT), /needs the element token/);
});

test('type_text carries the text and refuses an empty one', () => {
  assert.equal(plan({ kind: 'type_text', text: 'hello' }, CONTEXT).args.text, 'hello');
  assert.throws(() => plan({ kind: 'type_text', text: '' }, CONTEXT), /needs the text to type/);
});

test('a scroll without a point uses the keyboard path', () => {
  const planned = plan({ kind: 'scroll', direction: 'down' }, CONTEXT);
  assert.equal(planned.args.x, undefined);
  assert.equal(planned.args.direction, 'down');
});

test('a scroll with a point targets the pixel-wheel path', () => {
  const planned = plan({ kind: 'scroll', direction: 'down', x: 100, y: 200 }, CONTEXT);
  assert.equal(planned.args.x, 100);
  assert.equal(planned.args.y, 200);
});

test('a scroll forwards the unit the instruction promises the model', () => {
  // Regression: the instruction offered "amount" and "by" on scroll, but the
  // projection read only direction/amount/x/y, so "by" was accepted and silently
  // dropped -- a wheel notch where the model asked for a page.
  assert.equal(plan({ kind: 'scroll', direction: 'down', by: 'page' }, CONTEXT).args.by, 'page');
  assert.equal(plan({ kind: 'scroll', direction: 'down' }, CONTEXT).args.by, undefined);
  assert.equal(plan({ kind: 'scroll', direction: 'down', by: '' }, CONTEXT).args.by, undefined);
});

test('a wait defaults to one second and refuses a value it cannot honour', () => {
  // Regression: "ms" was passed through unchecked, so a string or a negative
  // number reached setTimeout as NaN -- the step reported "waited NaNms" while
  // the run continued as if it had waited.
  assert.deepEqual(plan({ kind: 'wait' }, CONTEXT), { wait: 1000 });
  assert.deepEqual(plan({ kind: 'wait', ms: 250 }, CONTEXT), { wait: 250 });
  assert.throws(() => plan({ kind: 'wait', ms: 'abc' }, CONTEXT), /non-negative number of milliseconds/);
  assert.throws(() => plan({ kind: 'wait', ms: -1 }, CONTEXT), /non-negative number of milliseconds/);
});

test('launch_app needs an identity and carries no window', () => {
  assert.deepEqual(plan({ kind: 'launch_app', bundleId: 'com.apple.calculator' }, CONTEXT), {
    tool: 'cua_driver_native__launch_app',
    args: { bundle_id: 'com.apple.calculator' },
  });
  assert.throws(() => plan({ kind: 'launch_app' }, CONTEXT), /needs either bundleId or name/);
});
