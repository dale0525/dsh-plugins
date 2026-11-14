/**
 * The two tools this plugin registers.
 *
 * They are NOT named after magpie's own tools (`generate_image`,
 * `generation_result`). The `mcp__magpie__*` prefix is what these tools were
 * first published under, and sessions already name them that way, so renaming
 * them now would break calls that work today. It is also the same vocabulary
 * `@deepseek-ai/dsh-mcp-client` would have produced.
 *
 * Historical note, because the reason changed: the prefix originally existed to
 * avoid colliding with `dsh-imagegen`, which owned the bare `generate_image`,
 * and `dsh-tools`' registry throws on a second registration of one name
 * (`tool "<name>" is already registered`). `dsh-imagegen` was removed on
 * 2026-11-11, so the collision no longer exists — the names stay anyway, for the
 * compatibility reason above.
 *
 * Only the image half of magpie is exposed. `generate_video` is deliberately
 * absent — video is covered by dsh-modal-h3. The poller exists because magpie
 * hands back an id instead of an image when a request exceeds its ~20-second
 * budget.
 *
 * @module @logictan/dsh-magpie-image/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { extractImages, extractText } from './content.js';
import { toReferenceImage } from './reference-image.js';

/** Model-facing namespace; also the `serverName` mcp-client would have used. */
export const SERVER_NAME = 'magpie';

/** Image generation routinely outlasts a default tool budget. */
const GENERATE_TIMEOUT_MS = 300_000;

/**
 * How long `generate_image` keeps polling before handing the task id back.
 *
 * magpie answers within about 20 seconds or returns an id to poll, and a real
 * generation takes a few minutes. Two minutes covers the common case; past that
 * the id is returned so the work is not lost, rather than blocking the tool for
 * the full {@link GENERATE_TIMEOUT_MS}.
 */
const POLL_BUDGET_MS = 120_000;

/** Delay between two `generation_result` calls. */
const POLL_INTERVAL_MS = 3_000;

/**
 * Derive the model-facing public name for one magpie tool.
 *
 * @param rawName - magpie's own tool name.
 * @returns the ToolRuntime name.
 */
export function publicToolName(rawName) {
  return `mcp__${SERVER_NAME}__${rawName}`;
}

/**
 * The attachment reference shape, in `defineTool` spec form.
 *
 * `required: true` on a property is schemastery's spelling; `defineTool`
 * compiles it into standard JSON Schema (`required` as an array on the object
 * node). The same node is reused for the parameter list and the result schema —
 * registering a raw object instead bypassed that compilation, which is what let
 * a scalar `required: true` reach the JSON-Schema assertion and throw.
 *
 * @type {const}
 */
const imageRefSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachment_id: { type: 'string', required: true },
    media_type: { type: 'string', required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
  },
};

/**
 * The canonical result schema shared by both tools, in `defineTool` spec form.
 *
 * `images` carries attachment references, which is what lets a generated image
 * be fed back into `reference_images` unchanged.
 *
 * @returns the `output` field of a `defineTool` definition.
 */
export function createOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', required: true },
        message: { type: 'string', required: true },
        images: { type: 'array', required: true, items: imageRefSchema },
        task_id: { type: 'string' },
      },
    },
    render(_args, value) {
      // Images are presentation output, not model input: keeping the
      // model-facing result textual lets generation work with text-only
      // conversation models while the references stay available for reuse.
      return [{ type: 'text', text: JSON.stringify(value) }];
    },
    /**
     * Persist the image references on the tool result so the Web surface can
     * render them beside the call. Without this the images exist as attachments
     * but the chat shows only the JSON text.
     */
    presentationMeta(_args, value) {
      return { images: value.images };
    },
  };
}

/**
 * Rehydrate the stored image references into image blocks for the call card.
 *
 * The images are already attachments (saved by `projectResult`), so this only
 * restores the reference shape the client renderer expects — the model-facing
 * content above stays text.
 *
 * @param _args - the call arguments (unused; replay must depend on the result).
 * @param result - the completed tool result projection.
 * @returns a generic card carrying image blocks, or `undefined` for no images.
 */
function presentImages(_args, result) {
  if (result.isError) return undefined;
  const images = result.meta?.images;
  if (!Array.isArray(images) || images.length === 0) return undefined;
  const content = images.flatMap((image) => {
    if (typeof image?.attachment_id !== 'string'
      || typeof image.media_type !== 'string'
      || !Number.isInteger(image.bytes)
      || !Number.isInteger(image.width)
      || !Number.isInteger(image.height)) return [];
    return [{ type: 'image', attachment: restoreRef(image) }];
  });
  return content.length === 0 ? undefined : { card: 'generic', content };
}

/** The sentence magpie uses when a request outlives its ~20-second budget. */
const PENDING_PATTERN = /generation_result with id "([A-Za-z0-9_-]+)"/;

/**
 * Extract the task id from magpie's still-running sentence.
 *
 * The id is NOT a bare string: magpie answers with prose (measured 2026-11-07),
 * so a caller that assumed `content[0].text` was the id would never poll — the
 * request would look pending forever.
 *
 * @param text - the joined text of one magpie result.
 * @returns the id, or `undefined` when the result is not a still-running one.
 */
export function pendingTaskId(text) {
  return PENDING_PATTERN.exec(text)?.[1];
}

/**
 * Narrow one attachment reference back to its branded shape.
 *
 * @param value - the reference as it arrived over the wire.
 * @returns the reference the attachment store accepts.
 */
function restoreRef(value) {
  if (value === null || typeof value !== 'object'
    || typeof value.attachment_id !== 'string'
    || typeof value.media_type !== 'string'
    || !Number.isInteger(value.bytes)
    || !Number.isInteger(value.width)
    || !Number.isInteger(value.height)) {
    throw new Error('reference_images entries must be the image objects a previous result returned, unchanged');
  }
  return {
    attachmentId: value.attachment_id,
    mediaType: value.media_type,
    bytes: value.bytes,
    width: value.width,
    height: value.height,
  };
}

/**
 * Poll `generation_result` until the image arrives or the budget runs out.
 *
 * This polling lives here rather than in the model's hands, and that is the
 * whole point of the function. magpie's two-step protocol — answer with an id,
 * then be asked again for the result — was previously exposed as two tools, so
 * the model had to remember a `task_id` and pick `generation_result` by name for
 * the second step. Measured on 2026-11-14 in the session that exposed this: the
 * model named that tool in prose twenty times, called it zero times, and spent
 * the turns calling an unrelated memory tool instead. A second step the caller
 * can perform itself should not be a second decision.
 *
 * A pending answer carries the id in prose and nothing else, so the id is
 * carried forward on every retry. When the budget expires the last pending
 * result is returned unchanged: it still holds the id, which is what makes a
 * long generation collectable instead of lost.
 *
 * @param ctx - the plugin context carrying the attachment store.
 * @param magpie - the client from {@link createMagpieClient}.
 * @param initial - the `projectResult` value from `generate_image`.
 * @param exec - the tool execution context, whose signal is honoured.
 * @returns a completed result, or the last pending one with its id.
 */
async function pollUntilReady(ctx, magpie, initial, exec, poll = {}) {
  const budgetMs = poll.budgetMs ?? POLL_BUDGET_MS;
  const intervalMs = poll.intervalMs ?? POLL_INTERVAL_MS;
  const sleep = poll.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let current = initial;
  const deadline = Date.now() + budgetMs;
  while (current.status === 'pending' && Date.now() < deadline) {
    if (exec?.signal?.aborted === true) break;
    await sleep(intervalMs);
    if (exec?.signal?.aborted === true) break;
    const result = await magpie.callTool('generation_result', { id: current.task_id }, exec);
    current = await projectResult(ctx, result);
  }
  return current;
}

/**
 * Turn one magpie result into attachment-backed image references.
 *
 * The attachment store is what makes the images durable: magpie keeps them at a
 * URL for one hour only, so a result that is not saved here stops rendering.
 *
 * @param ctx - the plugin context carrying the attachment store.
 * @param result - the raw MCP result.
 * @returns the canonical tool result value.
 */
async function projectResult(ctx, result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = extractText(content);
  if (result?.isError === true) throw new Error(text);

  const images = extractImages(content);
  // A still-running request answers with no image and a prose sentence that
  // carries the id, measured 2026-11-07:
  //   The image is still being made (20 s so far; it can take a few minutes).
  //   Don't ask for it again: call generation_result with id "img_26a8544..." to wait for it and get it.
  // It is reported as `pending` rather than as a failure so the caller polls
  // instead of redrawing.
  if (images.length === 0) {
    const taskId = pendingTaskId(text);
    // No id means magpie answered without either an image or a poll handle, so
    // there is nothing the caller could do next. Surfacing the sentence as an
    // error keeps it from reading as a successful empty result.
    if (taskId === undefined) throw new Error(`magpie returned neither an image nor a task id: ${text}`);
    return { status: 'pending', message: text, images: [], task_id: taskId };
  }

  const refs = await ctx.attachments.saveImages(images);
  return {
    status: 'completed',
    message: text,
    images: refs.map((ref) => ({
      attachment_id: String(ref.attachmentId),
      media_type: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
    })),
  };
}

/**
 * Registration list for the `mcp__magpie__*` tools.
 *
 * `generate_image` doubles as the edit path: when `reference_images` is present
 * the prompt is read as an instruction about those images, which is how magpie
 * documents it — one tool rather than two keeps the reference conversion in one
 * place.
 *
 * @param ctx - the plugin context.
 * @param magpie - the client from {@link createMagpieClient}.
 * @param poll - test seam for the internal polling: `budgetMs`, `intervalMs` and
 *   `sleep`. Production passes nothing and gets the measured defaults.
 * @returns definitions, unregistered; the caller owns their lifetime.
 */
export function createToolDefinitions(ctx, magpie, poll = {}) {
  return [
    defineTool({
      name: publicToolName('generate_image'),
      description:
        'Generate an image with the magpie image MCP (its configured model, now linux-hub/gpt-image-2), or edit/combine images by passing reference_images. The image is saved as an attachment and shown beside this tool call; pass an image object from a previous result back in reference_images to build on it. Nothing is written into the project directory — save it there yourself if a file is needed.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'What to draw, or how to change the reference images.' },
        reference_images: {
          type: 'array',
          items: imageRefSchema,
          description: 'Images to edit or draw from, taken unchanged from a previous result. Omit for text-to-image.',
        },
        model: {
          type: 'string',
          description: 'provider/model override, for example linux-hub/gpt-image-2. Omit to use the model set in magpie.',
        },
        size: {
          type: 'string',
          description: 'WIDTHxHEIGHT such as 1024x1024, or an aspect ratio such as 16:9. Omit for the model default.',
        },
        quality: { type: 'string', description: 'low, medium, high, xhigh, max or auto, for models that take it.' },
        count: { type: 'integer', description: 'How many images, 1 to 4. Defaults to 1.' },
        background: { type: 'string', description: 'transparent, opaque or auto, for models that take it.' },
      },
      output: createOutput(),
      presentResult: presentImages,
      timeoutMs: GENERATE_TIMEOUT_MS,
      async execute(args, exec) {
        const references = Array.isArray(args.reference_images) ? args.reference_images : [];
        const referenceImages = [];
        for (const reference of references) {
          const image = await ctx.attachments.readImage(restoreRef(reference), exec.signal);
          referenceImages.push(toReferenceImage(image.data, image.ref.mediaType));
        }
        const result = await magpie.callTool('generate_image', {
          prompt: args.prompt,
          ...(referenceImages.length > 0 ? { reference_images: referenceImages } : {}),
          ...(args.model === undefined ? {} : { model: args.model }),
          ...(args.size === undefined ? {} : { size: args.size }),
          ...(args.quality === undefined ? {} : { quality: args.quality }),
          ...(args.count === undefined ? {} : { n: args.count }),
          ...(args.background === undefined ? {} : { background: args.background }),
        }, exec);
        return pollUntilReady(ctx, magpie, await projectResult(ctx, result), exec, poll);
      },
    }),
    defineTool({
      name: publicToolName('generation_result'),
      description:
        'Fetch a magpie image that mcp__magpie__generate_image said was still being made, by the task_id it answered with. Call it again with the same id if it is still not ready — do not generate the image again.',
      parameters: {
        task_id: { type: 'string', required: true, description: 'The task_id mcp__magpie__generate_image answered with.' },
      },
      output: createOutput(),
      presentResult: presentImages,
      timeoutMs: GENERATE_TIMEOUT_MS,
      async execute(args, exec) {
        const result = await magpie.callTool('generation_result', { id: args.task_id }, exec);
        return projectResult(ctx, result);
      },
    }),
  ];
}