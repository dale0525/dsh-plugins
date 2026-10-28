/**
 * Configuration surface of the browser search provider.
 *
 * Every field is `volatile()`, the same contract `dsh-settings` uses elsewhere:
 * the Loader then hands `apply` one live `{ get() }` reference per field, so a
 * Plugins-page edit takes effect on the next search without a remount.
 *
 * @module @logictan/dsh-browser-search/config
 */
import z from '@deepseek-ai/schemastery';

/** The loader entry id this plugin's configuration form is keyed by. */
export const ENTRY_ID = 'browser-search';

/** Default CDP endpoint; the same dedicated-profile Chrome browser-agent uses. */
export const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222';

/** Schema of the `browser-search` configuration. */
export const Config = z.object({
  cdpEndpoint: z
    .string()
    .default(DEFAULT_CDP_ENDPOINT)
    .comment('Chrome 调试端口')
    .description('默认 http://127.0.0.1:9222。Chrome 必须用专用 --user-data-dir 启动（见 README）。')
    .volatile(),
  googleEnabled: z
    .boolean()
    .default(true)
    .comment('启用 Google')
    .description('通过 Chrome 搜索 Google。结果质量最好，但需要 Chrome 在调试端口上监听。')
    .volatile(),
  bingEnabled: z
    .boolean()
    .default(true)
    .comment('启用 Bing 兜底')
    .description('Google 失败时用纯 HTTP 请求 Bing，不需要浏览器。')
    .volatile(),
  googleTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .default(15_000)
    .comment('Google 超时(ms)')
    .description('一次 Google 搜索的总预算，含页面加载与结果解析，默认 15000。')
    .volatile(),
  bingTimeoutMs: z
    .number()
    .step(1)
    .min(1000)
    .default(15_000)
    .comment('Bing 超时(ms)')
    .description('一次 Bing 请求的总预算，默认 15000。')
    .volatile(),
  googleMaxResults: z
    .number()
    .step(1)
    .min(1)
    .default(20)
    .comment('Google 抓取条数')
    .description('向 Google 请求多少条结果，默认 20。实际返回条数由工具层的 maxResults 再截断。')
    .volatile(),
  bingMaxResults: z
    .number()
    .step(1)
    .min(1)
    .default(20)
    .comment('Bing 抓取条数')
    .description('向 Bing 请求多少条结果，默认 20。')
    .volatile(),
});

/**
 * Read the live configuration as plain values.
 *
 * @param config - one live reference per {@link Config} field.
 * @returns the resolved settings.
 */
export function readConfig(config) {
  return {
    cdpEndpoint: config.cdpEndpoint.get(),
    googleEnabled: config.googleEnabled.get(),
    bingEnabled: config.bingEnabled.get(),
    googleTimeoutMs: config.googleTimeoutMs.get(),
    bingTimeoutMs: config.bingTimeoutMs.get(),
    googleMaxResults: config.googleMaxResults.get(),
    bingMaxResults: config.bingMaxResults.get(),
  };
}
