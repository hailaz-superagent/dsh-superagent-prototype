/**
 * WeCom long-connection images: download and decrypt each callback image while its
 * five-minute URL is valid, keep it under the Superagent state directory, and read
 * it later as a model-visible attachment.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import { wecomImageKeys } from './wecom-image.ts'
import type { SourceContext } from './host.ts'
import type { Trigger } from '../core/index.ts'

/** One image reference from an SDK callback, before its bytes are downloaded. */
export interface LiveImageRef {
  key: string
  url: string
  aeskey?: string
}

/** One downloaded image kept on disk for later attachment reads. */
export interface LiveImageFile {
  key: string
  file: string
  mediaType: ImageMediaType
  size: number
  name?: string
}

/** The download method of the long-connection client, kept separate to avoid a module cycle. */
export interface LiveImageDownloader {
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>
}

const MEDIA_TYPES: Record<string, { mediaType: ImageMediaType; ext: string }> = {
  'image/png': { mediaType: 'image/png', ext: '.png' },
  'image/jpeg': { mediaType: 'image/jpeg', ext: '.jpg' },
  'image/webp': { mediaType: 'image/webp', ext: '.webp' },
  'image/gif': { mediaType: 'image/gif', ext: '.gif' },
}
/** Bridge media cap; the attachment service applies the model's own limit when the image is read. */
export const MAX_LIVE_IMAGE_BYTES = 20 * 1024 * 1024
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Detects the image type from its magic bytes, never from the URL or a filename. */
export function liveImageType(data: Buffer): { mediaType: ImageMediaType; ext: string } | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG)) return MEDIA_TYPES['image/png']!
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return MEDIA_TYPES['image/jpeg']!
  if (data.length >= 6 && data.subarray(0, 6).toString('ascii').startsWith('GIF8')) return MEDIA_TYPES['image/gif']!
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return MEDIA_TYPES['image/webp']!
  return undefined
}

const safePart = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_')
const DOWNLOAD_TIMEOUT_MS = 30_000

/** Bounds a download that the SDK does not cancel, so one slow image cannot hold the message chain forever. */
async function withDeadline<T>(work: Promise<T>, signal: AbortSignal, ms = DOWNLOAD_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: (() => void) | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('image download timed out')), ms) })
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason)
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  try {
    return await Promise.race([work, timeout, aborted])
  } finally {
    if (timer) clearTimeout(timer)
    if (stop) signal.removeEventListener('abort', stop)
  }
}

/**
 * Downloads every image reference of a Trigger before the callback URL expires.
 *
 * A failure never drops the message: its `[图片]` marker becomes `[图片不可用]`,
 * so the agent knows an image existed and can ask the person to resend it. The
 * Trigger's `meta.images` becomes files only for images that were kept.
 */
export async function prepareLiveImages(ctx: Pick<SourceContext, 'deployment'>, bot: LiveImageDownloader,
  trigger: Trigger, signal: AbortSignal): Promise<void> {
  const refs = trigger.meta.images as LiveImageRef[] | undefined
  if (!refs?.length) return
  const directory = join(ctx.deployment.stateDir, 'wecom-live-media', safePart(String(trigger.meta.msgId ?? trigger.id)))
  const saved: LiveImageFile[] = []
  for (const ref of refs) {
    if (signal.aborted) break
    try {
      const { buffer, filename } = await withDeadline(bot.downloadFile(ref.url, ref.aeskey), signal)
      if (buffer.length === 0 || buffer.length > MAX_LIVE_IMAGE_BYTES) throw new Error('image is empty or too large')
      const type = liveImageType(buffer)
      if (!type) throw new Error('unsupported image content type')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const file = join(directory, `${ref.key}${type.ext}`)
      await writeFile(file, buffer, { mode: 0o600 })
      saved.push({ key: ref.key, file, mediaType: type.mediaType, size: buffer.length, ...(filename ? { name: filename } : {}) })
    } catch {
      trigger.text = trigger.text.replace(`[图片] ${ref.key}`, '[图片不可用]')
    }
  }
  trigger.meta.images = saved.length ? saved : undefined
}

/**
 * Reads one downloaded image named by the message text and commits it as an
 * attachment for the assessing model. The same model-modality guard as the bridge
 * path applies, so a text-only model can never claim to have seen the image.
 */
export async function readLiveWecomImage(agent: Agent, stateDir: string, trigger: Trigger,
  message: { id: string; text: string }, key: string, signal: AbortSignal):
  Promise<{ source_message_id: string; image_key: string; image: ImageAttachmentRef }> {
  if (!wecomImageKeys(message.text).includes(key)) throw new Error('Choose an image key from this source message')
  const images = (trigger.meta.images as LiveImageFile[] | undefined) ?? []
  const found = images.find(image => image.key === key)
  if (!found) throw new Error('The image is no longer available; it was not downloaded')
  const root = resolve(stateDir, 'wecom-live-media')
  const file = resolve(found.file)
  if (file !== root && !file.startsWith(root + sep)) throw new Error('The image path is outside the WeCom media directory')
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
  const data = await readFile(file)
  const max = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)
  if (data.length === 0 || data.length > max) throw new Error('The image is empty or exceeds the deployment byte limit')
  const type = MEDIA_TYPES[found.mediaType]
  if (!type) throw new Error('The stored image has an unsupported content type')
  signal.throwIfAborted()
  const image = await attachments.saveImage({ data, mediaType: type.mediaType, name: `${key}${type.ext}` })
  signal.throwIfAborted()
  return { source_message_id: message.id, image_key: key, image }
}
