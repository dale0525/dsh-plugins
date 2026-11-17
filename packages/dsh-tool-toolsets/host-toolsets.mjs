/**
 * host-toolsets.mjs — the host's own tools, handed over as on-demand groups.
 *
 * This is the policy half of the retirement of `dsh-tool-surface`. That plugin
 * filtered the assembled list down to a whitelist and moved the withdrawn
 * arguments into prose; the prose was the weak part, because a tool described
 * in one line is not a tool with a schema. An adopted group does strictly
 * better: the tools keep their real definitions in the registry, the model
 * loads the group, and the NEXT request carries those definitions in full.
 *
 * Only the host's own tools live here. A plugin's tools belong to that plugin's
 * `register` call; these are registered by the host before any plugin runs, so
 * nobody can own them — `ctx.toolsets.adopt` claims them instead.
 *
 * The groups are also the policy: a tool named in one of them is withdrawn from
 * every request until an agent loads that group, and a tool named in none stays
 * announced. There is deliberately no separate keep list — with two lists the
 * second one drifts, which is exactly how the announced-but-unusable class of
 * failure happened before.
 *
 * @module @logictan/dsh-tool-toolsets/host-toolsets
 */

/**
 * The host tools grouped by the job they do, in the order the catalog shows.
 *
 * Each `description` is the when-to-use line the model reads in the `get_tools`
 * catalog, so it names the JOB and never a parameter: the parameters arrive with
 * the schemas when the group is loaded, and restating them here would be the
 * prose-instead-of-schema trade this whole arrangement exists to avoid.
 */
export const HOST_TOOLSETS = [
  {
    name: 'ssh_remote',
    description:
      'Work on a machine the user configured in the dsh-ssh plugin: list hosts, run one shell command on a host, '
      + 'read a text file there, upload a local file to it, or download one from it. Use when the task names a remote host.',
    tools: ['ssh_list', 'ssh_read', 'ssh_upload', 'ssh_download'],
  },
  {
    name: 'schedule',
    description:
      'Schedule work to run later without the user present: create a task with exactly one time form '
      + '(after N seconds, at a timestamp, every N seconds, daily, weekly, or a cron expression), '
      + 'list pending tasks, change one, or delete one.',
    tools: ['schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete'],
  },
  {
    name: 'mcp_resources',
    description:
      'Read MCP resources rather than MCP tools: list the resource servers, list the URI templates a server '
      + 'exposes, and read one resource by URI. Use when a server publishes data as resources.',
    tools: ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'],
  },
  {
    name: 'agent_control',
    description:
      'Manage the agents this session started: fork one that inherits this conversation, list the models a '
      + 'sub-agent may run on, or interrupt one that is no longer needed.',
    tools: ['subagent_fork', 'list_subagent_models', 'interrupt_agent'],
  },
  {
    name: 'goals',
    description:
      'Set and steer the session goal (the objective an autonomous run works toward), leave plan mode by '
      + 'presenting the plan, or change the working directory.',
    tools: ['create_goal', 'exit_plan_mode', 'working_directory'],
  },
  {
    name: 'desktop_web',
    description:
      'Drive a real user interface instead of reasoning about it: operate a browser to a URL with a goal, '
      + 'or operate a native desktop app or window. Use when verification needs the actual screen.',
    tools: ['browser_agent', 'desktop_agent'],
  },
  {
    name: 'workflow',
    description:
      'Run one JavaScript script that fans work out across many subagents in phases and returns structured '
      + 'results. Use only when the user asks for a workflow or the work is a large multi-agent fan-out.',
    tools: ['workflow'],
  },
  {
    name: 'config_sync',
    description:
      'Pull or push the configuration snapshot of this DSH installation to its sync channel.',
    tools: ['config_sync_pull', 'config_sync_push'],
  },
  {
    name: 'images',
    description:
      'Generate or edit an image from a prompt, and collect or cancel a generation that was still running, '
      + 'by the task id it returned.',
    tools: ['generate_image', 'edit_image', 'get_image_generation_task', 'cancel_image_generation_task'],
  },
];

/**
 * The groups whose every tool is registered right now.
 *
 * A group is adopted WHOLE or not at all. A partial group would list a toolset
 * whose catalog line promises tools that are not there, and the model would load
 * it and receive fewer tools than the line said — the failure mode is silence
 * again, which is what this arrangement is trying to leave behind.
 *
 * The answer depends on WHEN it is asked: plugins register during their own
 * `apply`, in an order this module does not control, so the caller asks at the
 * first assembly rather than at mount time.
 *
 * @param available - every tool name the registry currently knows.
 * @returns the groups that can be adopted in full.
 */
export function adoptableGroups(available) {
  const names = available instanceof Set ? available : new Set(available);
  return HOST_TOOLSETS.filter((group) => group.tools.every((tool) => names.has(tool)));
}