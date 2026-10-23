/**
 * Tests for the remote read window.
 *
 * The window is what stands between a remote file and the context, so its
 * boundaries are the thing worth pinning: an off-by-one in `offset` shows the
 * wrong line, a missing cap floods the context, and a byte cut in the middle of
 * a UTF-8 sequence ends the text with a glyph that is not in the file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { READ_LIMIT, READ_MAX_BYTES, buildLineWindow, formatReadWindow, splitLines } from '../src/text-window.js';

test('a trailing newline ends the last line rather than starting an empty one', () => {
  assert.deepEqual(splitLines('a\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('a\nb'), ['a', 'b']);
  assert.deepEqual(splitLines(''), []);
  // A blank line inside the file is still a line.
  assert.deepEqual(splitLines('a\n\nb\n'), ['a', '', 'b']);
});

test('CRLF is read as LF, so no line carries a stray carriage return', () => {
  assert.deepEqual(splitLines('a\r\nb\r\n'), ['a', 'b']);
});

test('offset is 1-based and limit bounds the window', () => {
  const window = buildLineWindow('one\ntwo\nthree\nfour\n', { offset: 2, limit: 2 });
  assert.deepEqual(window.lines, [
    { number: 2, text: 'two' },
    { number: 3, text: 'three' },
  ]);
  assert.equal(window.totalLines, 4);
  assert.equal(window.truncatedByBytes, false);
});

test('an offset past the end is an error, except offset 1 on an empty file', () => {
  assert.throws(() => buildLineWindow('a\n', { offset: 5 }), /offset 5 超出文件范围/);
  // An empty file has no line 1 to be out of range of, so paging into it once
  // must not fail — the caller asked for "the first line" and there is none.
  assert.deepEqual(buildLineWindow('', { offset: 1 }).lines, []);
});

test('a capped scan says the offset ran past what was scanned, not past the file', () => {
  assert.throws(
    () => buildLineWindow('a\nb\n', { offset: 9, capped: true }),
    /超出已读取范围.*文件大于读取上限/,
  );
});

test('the byte cap cuts the window and reports it', () => {
  // One line well under the per-line cap, repeated until the byte cap stops it.
  const line = `${'x'.repeat(99)}\n`;
  const window = buildLineWindow(line.repeat(Math.ceil(READ_MAX_BYTES / 100) + 50));
  assert.equal(window.truncatedByBytes, true);
  assert.ok(window.lines.length < window.totalLines, 'the window must stop short of the whole text');
  // The cap is on bytes emitted, not on lines: everything shown fits.
  const shown = window.lines.map((entry) => entry.text).join('\n');
  assert.ok(Buffer.byteLength(shown, 'utf8') <= READ_MAX_BYTES);
});

test('the line cap bounds the window even when the bytes would allow more', () => {
  const window = buildLineWindow('a\n'.repeat(READ_LIMIT + 10), { limit: READ_LIMIT });
  assert.equal(window.lines.length, READ_LIMIT);
  assert.equal(window.truncatedByBytes, false);
});

test('an over-long line is truncated with a note instead of being passed through', () => {
  const window = buildLineWindow(`${'y'.repeat(5_000)}\n`);
  assert.equal(window.lines[0].text.length, 2_000 + '... (line truncated to 2000 chars)'.length);
  assert.match(window.lines[0].text, /line truncated to 2000 chars/);
});

test('the rendered envelope matches the local read tool, footer included', () => {
  const window = buildLineWindow('one\ntwo\n', { offset: 1, limit: 1 });
  const text = formatReadWindow({
    path: 'nas:/srv/a.txt',
    offset: window.offset,
    lines: window.lines,
    totalLines: window.totalLines,
    truncatedByBytes: window.truncatedByBytes,
    capped: window.capped,
  });
  assert.equal(
    text,
    '<path>nas:/srv/a.txt</path>\n<type>file</type>\n<content>\n1: one\n\n(Showing lines 1-1 of 2. Use offset=2 to continue.)\n</content>',
  );
});

test('the end-of-file footer states the total, and an empty file shows only the footer', () => {
  const window = buildLineWindow('only\n');
  const text = formatReadWindow({
    path: 'nas:/srv/a.txt',
    offset: 1,
    lines: window.lines,
    totalLines: window.totalLines,
    truncatedByBytes: false,
    capped: false,
  });
  assert.match(text, /\(End of file - total 1 lines\)/);

  const empty = formatReadWindow({
    path: 'nas:/srv/empty.txt',
    offset: 1,
    lines: [],
    totalLines: 0,
    truncatedByBytes: false,
    capped: false,
  });
  assert.match(empty, /<content>\n\(End of file - total 0 lines\)\n<\/content>/);
});

test('a capped file footer points at the two ways to see the rest', () => {
  const text = formatReadWindow({
    path: 'nas:/var/log/app.log',
    offset: 1,
    lines: [{ number: 1, text: 'first' }],
    totalLines: 1,
    truncatedByBytes: false,
    capped: true,
    fileBytes: 9_000_000,
    scannedBytes: 524_288,
  });
  assert.match(text, /the file is 9000000 bytes, larger than the 524288-byte read cap/);
  assert.match(text, /ssh_download/);
  // Never claim the file ended.
  assert.equal(text.includes('End of file'), false);
});
