/**
 * The one model call this plugin makes: ask for the next action.
 *
 * The call goes through the host's own `ctx.llm`, so there is no second API key,
 * no second provider configuration, and nothing for config sync to strip. It is
 * also what makes the channel decision real: the SAME route that will answer is
 * the one the plugin asks about image support before it decides whether to send a
 * screenshot or an element table.
 *
 * @module @logictan/dsh-desktop-agent/ask
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { INSTRUCTION, MAX_TOKENS, decisionPayload } from './request.js';
import { NO_ROUTE_MESSAGE } from './route.js';

/**
 * The producer-owned source kind stamped on every message this plugin sends.
 *
 * Session format v4 refuses the retired `{ kind: 'plugin', plugin }` wrapper at
 * native admission, so the identity rides `kind` itself under the host's
 * documented `plugin:` prefix for a producer that is not a first-party plugin.
 */
export const SOURCE = { kind: 'plugin:dsh-desktop-agent' };

/**
 * Ask the routed model for one decision.
 *
 * @param input - the `ctx.llm` service, the route, the goal, the observation, the
 *   history, and the caller's cancellation signal.
 * @returns the model's raw answer text.
 * @throws {Error} an actionable message when the call failed or produced no text.
 */
export async function ask(input) {
  const { llm, route, goal, observation, history, signal } = input;

  if (route.provider === '' || route.model === '') {
    throw new Error(NO_ROUTE_MESSAGE);
  }

  const assembler = new BlockAssembler();
  const options = {
    provider: route.provider,
    model: route.model,
    messages: [
      createUserMessage({ content: [{ type: 'text', text: INSTRUCTION }], source: SOURCE }),
      createUserMessage({ content: contentOf(observation, decisionPayload({ goal, observation, history })), source: SOURCE }),
    ],
    maxTokens: MAX_TOKENS,
    ...(route.reasoningEffort === '' ? {} : { reasoningEffort: route.reasoningEffort }),
    ...(signal === undefined ? {} : { signal }),
  };

  for await (const chunk of llm.stream(options)) assembler.push(chunk);

  const finish = assembler.finish;
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new Error(`desktop_agent: the decision call failed (${finish.failure.message}).`);
  }

  const text = assembler
    .blocks()
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');

  if (text.trim() === '') throw new Error('desktop_agent: the model returned no decision.');
  return text;
}

/**
 * Build the content blocks of the data message.
 *
 * The screenshot is carried as a durable attachment reference, which is the only
 * shape the harness admits an image in. The bytes are committed through
 * `ctx.attachments` first: an inline base64 block is not a valid request part,
 * and a reference the store never issued would be refused at the provider
 * boundary.
 *
 * @param observation - the observation the decision is made against.
 * @param payload - the serializable data payload.
 * @returns the content blocks, image first.
 */
function contentOf(observation, payload) {
  const text = { type: 'text', text: JSON.stringify(payload) };
  if (observation.channel !== 'vision') return [text];
  return [{ type: 'image', attachment: observation.attachment }, text];
}
