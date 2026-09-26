/**
 * Shared host-side generation runtime. Both the browser routes and Agent tools
 * submit to this one queue so cancellation semantics stay identical regardless
 * of where a request originated.
 *
 * Requests carry a channel id (host-filled by the route/tool resolution); the
 * runtime picks that channel's upstream credentials, otherwise the default
 * channel.
 */

import { generateImage, ImageGenError, type UpstreamConfig } from './engine.ts'
import { detectImageMime } from './image-format.ts'
import { vendorOf, type SubscriptionManager, type SubscriptionReferenceImage } from './subscription/manager.ts'
import { GenerationTaskQueue } from './task-queue.ts'
import type { ChannelConfig, GeneratedImage, GenerateRequest, GenerateResult, SubscriptionProvider } from './protocol.ts'

/** A channel with its resolved API key (the settings doc holds the key
 *  separately so redacted reads never expose it). */
export interface RuntimeChannel extends ChannelConfig {
  apiKey: string
}

/** The resolved channels view the runtime picks upstream credentials from. */
export interface ChannelsView {
  channels: RuntimeChannel[]
  defaultChannelId: string
}

export class ImageGenerationRuntime {
  readonly queue: GenerationTaskQueue

  constructor(
    private readonly resolve: () => ChannelsView,
    private readonly subscriptions?: SubscriptionManager,
  ) {
    // Every task runs in parallel up to this small host-wide limit.
    this.queue = new GenerationTaskQueue((request, signal) => this.run(request, signal), 4)
  }

  async run(request: GenerateRequest, signal?: AbortSignal): Promise<GenerateResult> {
    const view = this.resolve()
    const channel = view.channels.find(candidate => candidate.id === request.channelId)
      ?? view.channels.find(candidate => candidate.id === view.defaultChannelId)
      ?? view.channels[0]
    if (channel === undefined) {
      throw new ImageGenError('尚未配置任何渠道：请先打开「设置 → 生图配置」添加渠道并填写 API 地址与密钥', 'no-channels')
    }
    return channel.auth === 'subscription' && channel.subscription !== undefined
      ? { images: await this.generateSubscription(channel.subscription, request, signal) }
      : await generateImage({ apiUrl: channel.apiUrl, apiKey: channel.apiKey, apiUrlFull: channel.apiUrlFull, protocol: channel.protocol } satisfies UpstreamConfig, request, { signal })
  }

  /** Generate images through one logged-in subscription account. */
  private async generateSubscription(provider: SubscriptionProvider, request: GenerateRequest, signal?: AbortSignal): Promise<GeneratedImage[]> {
    if (this.subscriptions === undefined) {
      throw new ImageGenError('当前部署未挂载 DSH Credentials，订阅账号不可用', 'subscription-unavailable')
    }
    const references = subscriptionReferences(request)
    const count = Math.max(1, Math.min(4, Math.trunc(request.n) || 1))
    const batches = await Promise.all(Array.from({ length: count }, async () => await this.subscriptions!.generate({
      vendor: vendorOf(provider),
      prompt: request.prompt,
      size: request.size,
      quality: request.quality,
      ...(references.length > 0 ? { referenceImages: references } : {}),
      ...(signal === undefined ? {} : { signal }),
    })))
    return batches.flatMap(batch => batch.flatMap(row => {
      const bytes = Buffer.from(row.b64_json, 'base64')
      const mime = detectImageMime(bytes)
      if (mime === undefined) throw new ImageGenError('订阅图像返回了无法识别的图片格式', 'subscription-invalid-image')
      return [{ b64: row.b64_json, mime, ...row.revisedPrompt === undefined ? {} : { revisedPrompt: row.revisedPrompt } }]
    }))
  }
}

/** Decode the request's data-URL references into subscription wire images. */
function subscriptionReferences(request: GenerateRequest): SubscriptionReferenceImage[] {
  return [request.image, ...(request.images ?? [])]
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .slice(0, 5)
    .map(value => {
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/su.exec(value)
      if (match === null || match[1] === undefined || match[2] === undefined) {
        throw new ImageGenError('订阅图生图收到无法解码的参考图片', 'subscription-invalid-reference')
      }
      return { data: Buffer.from(match[2], 'base64'), mediaType: match[1] }
    })
}
