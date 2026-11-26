/**
 * WeCom long-connection media: download and decrypt every callback image, file and
 * video while its five-minute URL is valid, keep it under the Superagent state
 * directory, and (for images) read it later as a model-visible attachment.
 *
 * WeCom sends only the transcription of a voice message, never the audio, so voice
 * has no media here. Files and videos are saved next to the images and their path is
 * put into the message text; the agent can then inspect them with its own tools.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import { wecomImageKeys } from './wecom-image.ts'
import type { SourceContext } from './host.ts'
import type { Trigger } from '../core/index.ts'

/** One media reference from an SDK callback, before its bytes are downloaded. */
export interface LiveMediaRef {
  /** Stable marker key: `img_wecom_N`, `file_wecom_N` or `video_wecom_N`. */
  key: string
  /** Exact text marker in the message, e.g. `[图片] img_wecom_0` or `[引用文件] file_wecom_0`. */
  marker: string
  kind: 'image' | 'file' | 'video'
  url: string
  aeskey?: string
  name?: string
  /** Channel attachments require the cookie returned with the post; ordinary messages do not. */
  cookie?: { name: string; value: string }
}

/** Backwards-compatible alias for the image-only callers. */
export type LiveImageRef = LiveMediaRef

/** One downloaded image kept on disk for later attachment reads. */
export interface LiveImageFile {
  key: string
  file: string
  mediaType: ImageMediaType
  size: number
  name?: string
}

/** One downloaded file or video kept on disk for the agent to inspect. */
export interface LiveStoredMedia {
  key: string
  kind: 'file' | 'video'
  file: string
  size: number
  name?: string
}

/** The download method of the long-connection client, kept separate to avoid a module cycle. */
export interface LiveMediaDownloader {
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>
}

/** Backwards-compatible alias for image-only callers. */
export type LiveImageDownloader = LiveMediaDownloader

const MEDIA_TYPES: Record<string, { mediaType: ImageMediaType; ext: string }> = {
  'image/png': { mediaType: 'image/png', ext: '.png' },
  'image/jpeg': { mediaType: 'image/jpeg', ext: '.jpg' },
  'image/webp': { mediaType: 'image/webp', ext: '.webp' },
  'image/gif': { mediaType: 'image/gif', ext: '.gif' },
}
/** Inbound media cap; the attachment service applies the model's own image limit. */
export const MAX_LIVE_MEDIA_BYTES = 20 * 1024 * 1024
/** Kept for callers that only know about images. */
export const MAX_LIVE_IMAGE_BYTES = MAX_LIVE_MEDIA_BYTES
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

/** Channel attachments are unencrypted but require the cookie that came with the post. */
async function downloadWithCookie(url: string, cookie: { name: string; value: string }, signal: AbortSignal):
  Promise<{ buffer: Buffer; filename?: string }> {
  const response = await fetch(url, { signal, headers: { cookie: `${cookie.name}=${cookie.value}` } })
  if (!response.ok) throw new Error(`channel media download failed with HTTP ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_LIVE_MEDIA_BYTES) throw new Error('media is too large')
  const buffer = Buffer.from(await response.arrayBuffer())
  const disposition = response.headers.get('content-disposition') ?? ''
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)
  return { buffer, ...(match?.[1] ? { filename: decodeURIComponent(match[1].trim()) } : {}) }
}

/** Bounds a download that the SDK does not cancel, so one slow media cannot hold the message chain forever. */
async function withDeadline<T>(work: Promise<T>, signal: AbortSignal, ms = DOWNLOAD_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: (() => void) | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('media download timed out')), ms) })
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

const labelOf = (kind: LiveMediaRef['kind']): string =>
  kind === 'image' ? '图片' : kind === 'video' ? '视频' : '文件'

/** A saved file keeps the original extension when it has a usable one. */
function mediaExtension(...candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    const ext = candidate ? extname(candidate).toLowerCase() : ''
    if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext
  }
  return '.bin'
}

/**
 * Downloads every media reference of a Trigger before the callback URL expires.
 *
 * A failure never drops the message: the marker becomes `[图片不可用]`,
 * `[文件不可用]` or `[视频不可用]`, so the agent knows media existed and can ask
 * the person to resend it. Images are recorded in `meta.images` for attachment
 * reads; files and videos are recorded in `meta.media` and their saved path is put
 * into the message text.
 */
export async function prepareLiveMedia(ctx: Pick<SourceContext, 'deployment'>, bot: LiveMediaDownloader,
  trigger: Trigger, signal: AbortSignal): Promise<void> {
  const refs = trigger.meta.media as LiveMediaRef[] | undefined
  if (!refs?.length) return
  const directory = join(ctx.deployment.stateDir, 'wecom-live-media', safePart(String(trigger.meta.msgId ?? trigger.id)))
  const images: LiveImageFile[] = []
  const stored: LiveStoredMedia[] = []
  for (const ref of refs) {
    if (signal.aborted) break
    const label = labelOf(ref.kind)
    const markerLabel = ref.marker.slice(0, ref.marker.indexOf(']') + 1)
    if (!ref.url) {
      trigger.text = trigger.text.replace(ref.marker, `[${label}不可用]`)
      continue
    }
    try {
      const { buffer, filename } = await withDeadline(ref.cookie
        ? downloadWithCookie(ref.url, ref.cookie, signal)
        : bot.downloadFile(ref.url, ref.aeskey), signal)
      if (buffer.length === 0 || buffer.length > MAX_LIVE_MEDIA_BYTES) throw new Error('media is empty or too large')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if (ref.kind === 'image') {
        const type = liveImageType(buffer)
        if (!type) throw new Error('unsupported image content type')
        const file = join(directory, `${ref.key}${type.ext}`)
        await writeFile(file, buffer, { mode: 0o600 })
        images.push({ key: ref.key, file, mediaType: type.mediaType, size: buffer.length, ...(filename ? { name: filename } : {}) })
      } else {
        const name = ref.name ?? filename
        const file = join(directory, `${ref.key}${mediaExtension(filename, ref.name)}`)
        await writeFile(file, buffer, { mode: 0o600 })
        stored.push({ key: ref.key, kind: ref.kind, file, size: buffer.length, ...(name ? { name } : {}) })
        trigger.text = trigger.text.replace(ref.marker, `${markerLabel} ${name ?? ref.key}（已保存：${file}）`)
      }
    } catch {
      trigger.text = trigger.text.replace(ref.marker, `[${label}不可用]`)
    }
  }
  trigger.meta.images = images.length ? images : undefined
  trigger.meta.media = stored.length ? stored : undefined
}

/** Backwards-compatible name for the image-only callers. */
export const prepareLiveImages = prepareLiveMedia

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
