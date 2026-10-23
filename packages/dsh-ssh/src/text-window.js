/**
 * Turn decoded remote text into the same bounded, line-numbered window the
 * host's own `read` tool returns.
 *
 * The point is not decoration: the agent already knows how to read that shape
 * (1-based numbering, `offset`/`limit`, a footer saying how to continue), and a
 * remote file that came back in a different shape would force it to hold two
 * mental models for "read a text file". The caps are the host's caps for the
 * same reason — a remote file must not become the one path that can flood the
 * context.
 *
 * @module @logictan/dsh-ssh/text-window
 */

/** Per-line character ceiling, matching the host read tool's default. */
export const READ_MAX_LINE_LENGTH = 2_000;

/** Byte ceiling for one window, matching the host read tool's default. */
export const READ_MAX_BYTES = 50 * 1024;

/** Default and maximum number of lines one call returns. */
export const READ_LIMIT = 2_000;

/**
 * How many bytes of the file are transferred at most.
 *
 * Larger than one window's byte cap on purpose: `offset` has to be able to walk
 * past the first window, so a window cap used as the transfer cap would make
 * every line after it unreachable. Still bounded, because the file lives on the
 * far side of a network and the caller only ever sees a window.
 */
export const READ_TRANSFER_MAX_BYTES = 512 * 1024;

/**
 * Truncate one over-long line, saying so where it was cut.
 *
 * @param line - the line text.
 * @returns the line, possibly shortened.
 */
function truncateLine(line) {
  return line.length > READ_MAX_LINE_LENGTH
    ? `${line.slice(0, READ_MAX_LINE_LENGTH)}... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`
    : line;
}

/**
 * Split text into lines the way a file's line count is normally understood.
 *
 * A trailing newline ends the last line rather than starting an empty one, and a
 * CRLF file reads as if it were LF — otherwise every line of a file written on
 * Windows would carry a stray `\r` into the model's view of it.
 *
 * @param text - decoded file text.
 * @returns the lines.
 */
export function splitLines(text) {
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Build one window over decoded text.
 *
 * @param text - decoded text; for a file larger than the read cap this is only
 *   the scanned prefix, which `capped` records.
 * @param options.offset - 1-based first line.
 * @param options.limit - maximum lines to return.
 * @param options.capped - whether the text is a prefix of a larger file.
 * @returns `{offset, lines, totalLines, truncatedByBytes, capped}`.
 * @throws when `offset` is past the end of what was read.
 */
export function buildLineWindow(text, { offset = 1, limit = READ_LIMIT, capped = false } = {}) {
  const lines = splitLines(text);
  const totalLines = lines.length;
  // An empty file is the one case where offset 1 is legal past the end: there is
  // no line 1 for it to be out of range of.
  if (offset > totalLines && !(totalLines === 0 && offset === 1)) {
    throw new Error(
      capped
        ? `offset ${offset} 超出已读取范围（已扫描 ${totalLines} 行；文件大于读取上限，后面的行没有被扫描到）`
        : `offset ${offset} 超出文件范围（共 ${totalLines} 行）`,
    );
  }
  const window = [];
  let bytes = 0;
  let truncatedByBytes = false;
  for (let index = offset - 1; index < totalLines && window.length < limit; index += 1) {
    const line = truncateLine(lines[index]);
    const size = Buffer.byteLength(line, 'utf8') + (window.length > 0 ? 1 : 0);
    if (bytes + size > READ_MAX_BYTES) {
      truncatedByBytes = true;
      break;
    }
    bytes += size;
    window.push({ number: index + 1, text: line });
  }
  return { offset, lines: window, totalLines, truncatedByBytes, capped };
}

/**
 * Render a window in the host read tool's envelope.
 *
 * @param value - `{path, offset, lines, totalLines, truncatedByBytes, capped, fileBytes, scannedBytes}`.
 * @returns the model-facing text block.
 */
export function formatReadWindow(value) {
  const endLine = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1);
  const shown = `Showing lines ${value.offset}-${endLine}`;
  let footer;
  if (value.capped === true) {
    // Not "of N lines": N counts only the scanned prefix, and saying otherwise
    // would read as a complete file that happens to be short.
    footer =
      `${shown} of the first ${value.totalLines} lines — the file is ${value.fileBytes} bytes, ` +
      `larger than the ${value.scannedBytes}-byte read cap, so later lines were not scanned. ` +
      'Narrow the range with ssh_exec (sed/awk/tail) or pull the file with ssh_download.';
  } else if (value.truncatedByBytes === true) {
    footer = `(Output capped. ${shown}. Use offset=${endLine + 1} to continue.)`;
  } else if (endLine < value.totalLines) {
    footer = `(${shown} of ${value.totalLines}. Use offset=${endLine + 1} to continue.)`;
  } else {
    footer = `(End of file - total ${value.totalLines} lines)`;
  }
  const body =
    value.lines.length > 0 ? `${value.lines.map((line) => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}` : footer;
  return `<path>${value.path}</path>\n<type>file</type>\n<content>\n${body}\n</content>`;
}
