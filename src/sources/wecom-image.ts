/** Downloads images the WeCom bridge kept for a message and commits them as model-visible attachments. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'

const MEDIA_TYPES: Record<string, { mediaType: ImageMediaType; ext: string }> = {
  'image/png': { mediaType: 'image/png', ext: '.png' },
  'image/jpeg': { mediaType: 'image/jpeg', ext: '.jpg' },
  'image/webp': { mediaType: 'image/webp', ext: '.webp' },
  'image/gif': { mediaType: 'image/gif', ext: '.gif' },
}

/** Reads one image named by the message text from the loopback bridge as an attachment for `agent`. */
export async function readWecomImage(agent: Agent, bridgeUrl: string, messageId: string, text: string,
  key: string, signal: AbortSignal): Promise<{ source_message_id: string; image_key: string; image: ImageAttachmentRef }> {
  if (!wecomImageKeys(text).includes(key)) throw new Error('Choose an image key from this source message')
  const attachments = agent.ctx.get('attachments')
  if (!attachments) throw new Error('Image reading is unavailable: no attachment service is mounted')
  const route = agent.session.requestHeader()?.config
  const provider = route?.provider ?? agent.options.provider
  const model = route?.model ?? agent.options.model
  const llm = agent.ctx.get('llm')
  if (!llm || !provider || !model) throw new Error('Image reading is unavailable: the current model route is unresolved')
  const info = await llm.resolveModelInfo(provider, model, signal)
  if (!info.inputModalities?.includes('image')) throw new Error(`Model ${model} does not support image input; the image has not been inspected`)
  signal.throwIfAborted()
  if (!bridgeUrl) throw new Error('The WeCom Source has no bridge URL')
  const url = new URL('/media', bridgeUrl)
  url.searchParams.set('message', messageId)
  url.searchParams.set('key', key)
  const response = await fetch(url, { signal, headers: { accept: 'image/png,image/jpeg,image/webp,image/gif' } })
  if (response.status === 404) throw new Error('The WeCom bridge no longer has this image')
  if (!response.ok) throw new Error(`WeCom bridge image download failed with HTTP ${response.status}`)
  const type = MEDIA_TYPES[(response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()]
  if (!type) throw new Error('The bridge returned an unsupported image content type')
  const length = Number(response.headers.get('content-length') ?? 0)
  const max = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
  if (length > max) throw new Error('The image exceeds the deployment byte limit')
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length === 0 || data.length > max) throw new Error('The image is empty or exceeds the deployment byte limit')
  signal.throwIfAborted()
  const image = await attachments.saveImage({ data, mediaType: type.mediaType, name: `${key}${type.ext}` })
  signal.throwIfAborted()
  return { source_message_id: messageId, image_key: key, image }
}

/** Image keys the bridge embeds in a message's text, in message order. */
export function wecomImageKeys(text: string): string[] {
  return [...new Set(text.match(/\bimg_wecom_\d+\b/g) ?? [])]
}
