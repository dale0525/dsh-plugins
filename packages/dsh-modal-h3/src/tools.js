/**
 * The six `mcp__modal_h3__*` tools.
 *
 * Two naming decisions are visible here and worth stating once:
 *
 *  - **The public names carry the `mcp__modal_h3__` prefix** even though nothing
 *    here speaks MCP. The prefix is how this harness spells "a tool namespace
 *    owned by one service", and a model that already knows `mcp__stitch__*`
 *    reads the new names the same way. The server segment is `modal_h3`, so the
 *    tools sort next to each other and cannot collide with another provider.
 *
 *  - **`dry_run` is a flag on `generate_video`, not a seventh tool.** A dry run
 *    is the same request with the submission removed: same prompt validation,
 *    same frame quantisation, same reference inspection, same `prompt_media_map`
 *    the prompt's labels have to match. A separate tool would duplicate the
 *    argument surface and let the two drift.
 *
 * Every description states the failure the model would otherwise walk into:
 * the 24fps frame quantisation, the one-generation-per-account limit, and the
 * fact that a submitted call cannot be moved to another account.
 *
 * @module @logictan/dsh-modal-h3/tools
 */

/** Namespace segment in every public tool name. */
export const SERVER_NAME = 'modal_h3';

/**
 * Prefix one raw tool name for the model.
 *
 * @param rawName - the bare name, as this module declares it.
 * @returns the public tool name.
 */
export function publicToolName(rawName) {
  return `mcp__${SERVER_NAME}__${rawName}`;
}

/** Tool names, exported so tests and the guidance text cannot drift. */
export const TOOL_NAMES = {
  generate: publicToolName('generate_video'),
  get: publicToolName('get_generation_task'),
  list: publicToolName('list_generation_tasks'),
  cancel: publicToolName('cancel_generation_task'),
  accountsStatus: publicToolName('accounts_status'),
  accountsSync: publicToolName('accounts_sync'),
};

/**
 * Cooperative budget for one generation call.
 *
 * The worker's own ceiling is 630 s per attempt with at most two attempts, so
 * 1800 s covers the worst legitimate case plus cold start, upload and local
 * postprocessing. Declaring it is a promise that the call forwards `exec.signal`
 * to a killable child — which `src/runner.js` does.
 */
export const GENERATION_TIMEOUT_MS = 1_800_000;

/**
 * Budget for one `accounts_sync` call.
 *
 * A first-time deploy uploads a multi-gigabyte image and then re-verifies the
 * ~59 GB model manifest inside Modal, which is hours of wall clock, not minutes.
 * The operation is idempotent (rolling deploy + sha256-skipping bootstrap), so a
 * caller that hits this ceiling can simply call it again.
 */
export const SYNC_TIMEOUT_MS = 21_600_000;

/** Reference limits, mirroring the contract's admission caps. */
export const REFERENCE_LIMITS = { images: 9, videos: 3, audios: 3, total: 12 };

/**
 * One reference list parameter.
 *
 * @param kind - plural kind used in the message.
 * @param limit - maximum count.
 * @returns the parameter spec.
 */
function referenceParam(kind, limit) {
  return {
    type: 'array',
    items: { type: 'string' },
    description:
      `Absolute paths to ${kind} reference files, in the order the prompt's labels will introduce them. ` +
      `At most ${limit}; all reference kinds together at most ${REFERENCE_LIMITS.total} files. ` +
      'A relative path is resolved against the session working directory.',
  };
}

/**
 * Shared result envelope for the three task tools.
 *
 * `prompt_media_map` and `ffprobe` are typed `json` because their shape is owned
 * by the Python contract: restating it here would be a second copy that silently
 * goes stale the day the contract changes.
 */
export const TASK_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    task_id: { type: 'string', description: 'Handle for get_generation_task, cancel_generation_task and list_generation_tasks.' },
    status: {
      type: 'string',
      required: true,
      description:
        'One of: dry-run, submitted, running, completed, failed, cancelled, expired, unknown. ' +
        'Only completed, failed, cancelled and expired are final.',
    },
    message: { type: 'string', required: true, description: 'Human-readable summary of the current state.' },
    account: { type: 'string', description: 'Modal account that owns the submitted call.' },
    error: { type: 'string', description: 'Failure detail, present when status is failed or unknown.' },
    output_path: { type: 'string', description: 'Delivered MP4, present once status is completed.' },
    report_path: { type: 'string', description: 'The worker\'s report.json beside the video.' },
    effective_duration_seconds: { type: 'number', description: 'Duration after 24fps frame quantisation; the prompt must state this number.' },
    output_frames: { type: 'integer', description: 'Frame count of the delivered video.' },
    generation_frames: { type: 'integer', description: 'Frame count H3 generates before the delivery postprocess.' },
    prompt_media_map: { type: 'json', description: 'Ordered picture/video/audio labels the prompt must reference.' },
    ffprobe: { type: 'json', description: 'ffprobe evidence for the delivered MP4.' },
    elapsed_seconds: { type: 'number', description: 'Worker execution time reported by Modal.' },
    estimated_gpu_cost_usd: { type: 'number', description: 'GPU cost estimate for the worker execution.' },
  },
};

/**
 * Render one task result as the model-visible text block.
 *
 * @param value - a value matching {@link TASK_RESULT_SCHEMA}.
 * @returns the content blocks.
 */
export function renderTaskResult(value) {
  const lines = [value.message];
  if (value.account !== undefined) lines.push(`Account: ${value.account}`);
  if (value.effective_duration_seconds !== undefined) {
    // The prompt has to state this exact number, so it belongs in the text the
    // model reads — not only in the structured value it may not look at.
    lines.push(`Effective duration: ${value.effective_duration_seconds} seconds (state this in summary)`);
  }
  if (value.output_frames !== undefined) {
    lines.push(`Output frames: ${value.output_frames}${value.generation_frames === undefined ? '' : ` (from ${value.generation_frames} generated)`}`);
  }
  if (value.output_path !== undefined) lines.push(`Output: ${value.output_path}`);
  if (value.report_path !== undefined) lines.push(`Report: ${value.report_path}`);
  if (value.error !== undefined) lines.push(`Error: ${value.error}`);
  if (value.prompt_media_map !== undefined) {
    lines.push(`Prompt media map: ${JSON.stringify(value.prompt_media_map)}`);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Describe `generate_video`.
 *
 * @returns the tool definition fields, minus `execute`.
 */
export function generateVideoTool() {
  return {
    name: TOOL_NAMES.generate,
    description:
      'Generate a 4-15 second video with MiniMax H3 Ref2VA on Modal: 1344x768, 24fps, native stereo audio. ' +
      'Ref2VA only - it needs at least one image, video or audio reference, and it cannot do text-only, exact first-frame or exact last-frame generation. ' +
      'The prompt must contain the six required sections in order and must state the effective duration that dry_run reports. ' +
      'By default this call stays pending until the video is delivered; set wait_for_completion to false to submit and return immediately, then poll with get_generation_task. ' +
      'Each account runs one generation at a time, so submitting without waiting is how to run several in parallel across the pool. ' +
      'Set dry_run to true to validate the prompt and see the frame contract without spending anything.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description:
          'The Ref2VA prompt: six sections (subject_definitions, summary, retention_analysis, detailed_description, ' +
          'overall_soundscape, non_diegetic_music) in that order, each introduced by a line holding only `name:`.',
      },
      duration_seconds: {
        type: 'number',
        description:
          'Requested duration, 4 to 15 seconds. Defaults to 4. Rounded to the nearest 24fps frame and then snapped ' +
          'up to the generation grid, so the delivered video may be slightly longer; dry_run reports the exact value.',
      },
      reference_images: referenceParam('image', REFERENCE_LIMITS.images),
      reference_videos: referenceParam('video', REFERENCE_LIMITS.videos),
      reference_audios: referenceParam('audio', REFERENCE_LIMITS.audios),
      dry_run: {
        type: 'boolean',
        description:
          'Validate only: run the local admission checks and return the frame contract and prompt media map. ' +
          'No network, no credential use, no files written, no cost.',
      },
      wait_for_completion: {
        type: 'boolean',
        description:
          'Wait for the delivered video in this call. Defaults to true; set false to submit in the background.',
      },
      account: {
        type: 'string',
        description:
          'Pooled account name to use. Omit to let the plugin pick the least busy account, which is almost always what you want.',
      },
      out_dir: {
        type: 'string',
        description:
          'Directory to copy the delivered video and report into. Defaults to the task directory under the harness home.',
      },
    },
    output: { schema: TASK_RESULT_SCHEMA, render: (_args, value) => renderTaskResult(value) },
    timeoutMs: GENERATION_TIMEOUT_MS,
  };
}

/**
 * Describe `get_generation_task`.
 *
 * @returns the tool definition fields, minus `execute`.
 */
export function getTaskTool() {
  return {
    name: TOOL_NAMES.get,
    description:
      'Check one video generation task. Polls Modal once, and on completion performs the delivery postprocess ' +
      '(96 frames at 24fps, H.264 1344x768, AAC stereo) plus the ffprobe verification, so the returned output_path ' +
      'is already the deliverable. Safe to call repeatedly: a finished task returns its recorded result without re-polling.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by generate_video.' },
    },
    output: { schema: TASK_RESULT_SCHEMA, render: (_args, value) => renderTaskResult(value) },
    timeoutMs: 600_000,
  };
}

/**
 * Describe `list_generation_tasks`.
 *
 * @returns the tool definition fields, minus `execute`.
 */
export function listTasksTool() {
  return {
    name: TOOL_NAMES.list,
    description:
      'List recorded video generation tasks, newest first. Reads local state only; it never contacts Modal, so a ' +
      'running task may have finished since its record was written - use get_generation_task for the live state.',
    parameters: {
      limit: { type: 'integer', description: 'Maximum records to return. Defaults to 20.' },
      status: {
        type: 'string',
        description: 'Keep only records with this status, for example running or completed.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: { type: 'array', required: true, items: TASK_RESULT_SCHEMA },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
  };
}

/**
 * Describe `cancel_generation_task`.
 *
 * @returns the tool definition fields, minus `execute`.
 */
export function cancelTaskTool() {
  return {
    name: TOOL_NAMES.cancel,
    description:
      'Cancel a submitted video generation. Cancelling does not refund the GPU time already spent, and a task that ' +
      'already reached a final state is reported as-is instead of being cancelled again.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task id returned by generate_video.' },
    },
    output: { schema: TASK_RESULT_SCHEMA, render: (_args, value) => renderTaskResult(value) },
    timeoutMs: 300_000,
  };
}

/**
 * Describe `accounts_status`.
 *
 * @returns the tool definition fields, minus `execute`.
 */
export function accountsStatusTool() {
  return {
    name: TOOL_NAMES.accountsStatus,
    description:
      'Report the Modal account pool: which accounts exist, whether each one has the App deployed, how many ' +
      'generations each is running, and how many pooled tasks are waiting. ' +
      'Set live to true to probe Modal for every account, which costs one request per account and is the only way ' +
      'to learn that a deployment was deleted elsewhere. Without live it reports the last recorded probe.',
    parameters: {
      live: {
        type: 'boolean',
        description: 'Probe Modal for each account instead of reporting the last recorded probe result.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
          accounts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                deployed: { type: 'string', required: true, description: 'deployed, not-deployed, auth-failed or unknown.' },
                detail: { type: 'string' },
                in_flight: { type: 'integer', description: 'Generations currently running on this account.' },
                refusing: {
                  type: 'boolean',
                  description: 'The last submission to this account failed outright; it is skipped until a submit or sync succeeds.',
                },
                refusal: { type: 'string', description: "Modal's message from that failed submission." },
                monthly_credit_usd: { type: 'number' },
                probed_at: { type: 'string', description: 'ISO timestamp of the probe this row reflects.' },
              },
            },
          },
          pool_errors: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs: 600_000,
  };
}

/**
 * Describe `accounts_sync`.
 *
 * @returns the tool definition fields, minus `execute`.
 */
export function accountsSyncTool() {
  return {
    name: TOOL_NAMES.accountsSync,
    description:
      'Deploy the Modal App for a pooled account: create the model and state volumes when missing, run a rolling ' +
      'deploy of this package\'s own App, verify the pinned model manifest, then probe the result. ' +
      'Needed once per new Modal account; an account whose App already exists on another device needs nothing. ' +
      'Every step is idempotent, so re-running after a partial failure only redoes what did not finish. ' +
      'This uploads a multi-gigabyte image and verifies tens of gigabytes of weights - expect tens of minutes, and ' +
      'call it again rather than assuming a timeout means it failed. ' +
      'Set dry_run to true to list what would be synced without touching Modal.',
    parameters: {
      account: {
        type: 'string',
        description: 'Pooled account name to sync. Omit to sync every account that is not currently deployed.',
      },
      dry_run: {
        type: 'boolean',
        description: 'Report the plan without deploying or probing anything.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message: { type: 'string', required: true },
          synced: { type: 'array', required: true, items: { type: 'string' } },
          failed: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                error: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    timeoutMs: SYNC_TIMEOUT_MS,
  };
}
