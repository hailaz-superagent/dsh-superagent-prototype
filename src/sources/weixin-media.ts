/**
 * Personal WeChat media: keep encrypted inbound images, files and videos before
 * their CDN link expires, decrypt them with AES-128-ECB, and expose images as
 * model-visible attachments. Voice keeps only the server transcription the
 * gateway sends; the SILK audio itself is not transcoded here.
 */
import { createDecipheriv } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type { Trigger } from '../core/index.ts'
import { z } from 'zod'
import { DEFAULT_CDN_URL } from './weixin-shared.ts'
import type { SourceContext } from './host.ts'

/** One media reference before its bytes are downloaded, with the marker it puts in the message. */
export interface WeixinMediaRef {
  key: string
  marker: string
  kind: 'image' | 'file' | 'video'
  /** Encrypted CDN query parameter; empty when the gateway sent no media. */
  query: string
  /** Complete CDN URL when the gateway supplied one. */
  url?: string
  /** AES key exactly as the message JSON carried it: hex on `image_item.aeskey`, base64 on `media.aes_key`. */
  aeskey?: string
  /** The key's encoding, which differs between image items and file items. */
  keyEncoding?: 'hex' | 'base64'
  name?: string
}

/** One downloaded image kept on disk for an attachment read. */
export interface WeixinImageFile { key: string; file: string; mediaType: ImageMediaType; size: number; name?: string }
/** One downloaded file or video whose path is put into the message text. */
export interface WeixinStoredMedia { key: string; kind: 'file' | 'video'; file: string; size: number; name?: string }

export const MAX_WEIXIN_MEDIA_BYTES = 20 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 30_000
const MEDIA_TYPES: Record<string, { mediaType: ImageMediaType; ext: string }> = {
  'image/png': { mediaType: 'image/png', ext: '.png' },
  'image/jpeg': { mediaType: 'image/jpeg', ext: '.jpg' },
  'image/webp': { mediaType: 'image/webp', ext: '.webp' },
  'image/gif': { mediaType: 'image/gif', ext: '.gif' },
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Detects an image by magic bytes, never by a URL or a filename. */
export function weixinImageType(data: Buffer): { mediaType: ImageMediaType; ext: string } | undefined {
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG)) return MEDIA_TYPES['image/png']!
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return MEDIA_TYPES['image/jpeg']!
  if (data.length >= 6 && data.subarray(0, 6).toString('ascii').startsWith('GIF8')) return MEDIA_TYPES['image/gif']!
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return MEDIA_TYPES['image/webp']!
  return undefined
}

/** Image keys a message text carries, in message order. */
export function weixinImageKeys(text: string): string[] {
  return [...new Set(text.match(/\bimg_weixin_\d+\b/g) ?? [])]
}

/** Decodes an AES key in either shape the gateway uses: 16 raw bytes, or a hex string kept as base64. */
export function parseWeixinAesKey(raw: string, encoding: 'hex' | 'base64'): Buffer {
  const decoded = encoding === 'hex' ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64')
  if (decoded.length === 16) return decoded
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString('ascii'))) return Buffer.from(decoded.toString('ascii'), 'hex')
  throw new Error(`Weixin media AES key has an unexpected length (${decoded.length} bytes)`)
}

function decrypt(data: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

async function withDeadline<T>(work: Promise<T>, signal: AbortSignal, ms = DOWNLOAD_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: (() => void) | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('media download timed out')), ms) })
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason)
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  try { return await Promise.race([work, timeout, aborted]) } finally {
    if (timer) clearTimeout(timer)
    if (stop) signal.removeEventListener('abort', stop)
  }
}

/** Fetches one CDN object, decrypting it when the message carried a key. */
export async function downloadWeixinMedia(ref: WeixinMediaRef, signal: AbortSignal): Promise<Buffer> {
  const url = ref.url || (ref.query ? `${DEFAULT_CDN_URL}/download?encrypted_query_param=${encodeURIComponent(ref.query)}` : '')
  if (!url) throw new Error('the message has no media URL')
  const response = await withDeadline(fetch(url, { signal }), signal)
  if (!response.ok) throw new Error(`CDN download returned HTTP ${response.status}`)
  const data = Buffer.from(await response.arrayBuffer())
  if (data.length === 0 || data.length > MAX_WEIXIN_MEDIA_BYTES) throw new Error('media is empty or exceeds 20 MB')
  if (!ref.aeskey) return data
  return decrypt(data, parseWeixinAesKey(ref.aeskey, ref.keyEncoding ?? 'base64'))
}

const safePart = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, '_')
const labelOf = (kind: WeixinMediaRef['kind']): string => kind === 'image' ? '图片' : kind === 'video' ? '视频' : '文件'
function extension(...candidates: (string | undefined)[]): string {
  for (const candidate of candidates) {
    const ext = candidate ? extname(candidate).toLowerCase() : ''
    if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext
  }
  return '.bin'
}

/**
 * Downloads every media reference before its URL expires. A failure never drops
 * the message: the marker becomes `[图片不可用]` / `[文件不可用]` / `[视频不可用]`.
 */
export async function prepareWeixinMedia(ctx: Pick<SourceContext, 'deployment'>, trigger: Trigger, signal: AbortSignal): Promise<void> {
  const refs = trigger.meta.media as WeixinMediaRef[] | undefined
  if (!refs?.length) return
  const directory = join(ctx.deployment.stateDir, 'weixin-media', safePart(String(trigger.meta.msgId ?? trigger.id)))
  const images: WeixinImageFile[] = []
  const stored: WeixinStoredMedia[] = []
  for (const ref of refs) {
    if (signal.aborted) break
    const label = labelOf(ref.kind)
    try {
      const buffer = await downloadWeixinMedia(ref, signal)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      if (ref.kind === 'image') {
        const type = weixinImageType(buffer)
        if (!type) throw new Error('unsupported image content type')
        const file = join(directory, `${ref.key}${type.ext}`)
        await writeFile(file, buffer, { mode: 0o600 })
        images.push({ key: ref.key, file, mediaType: type.mediaType, size: buffer.length, ...ref.name ? { name: ref.name } : {} })
      } else {
        const file = join(directory, `${ref.key}${extension(ref.name)}`)
        await writeFile(file, buffer, { mode: 0o600 })
        stored.push({ key: ref.key, kind: ref.kind, file, size: buffer.length, ...ref.name ? { name: ref.name } : {} })
        const markerLabel = ref.marker.slice(0, ref.marker.indexOf(']') + 1)
        trigger.text = trigger.text.replace(ref.marker, `${markerLabel} ${ref.name ?? ref.key}（已保存：${file}）`)
      }
    } catch {
      trigger.text = trigger.text.replace(ref.marker, `[${label}不可用]`)
    }
  }
  trigger.meta.images = images.length ? images : undefined
  trigger.meta.media = stored.length ? stored : undefined
}

/**
 * Reads one downloaded image as an attachment for the assessing model, with the
 * same modality guard as the other Sources: a text-only model never claims to
 * have seen it.
 */
export async function readWeixinImage(agent: Agent, stateDir: string, trigger: Trigger,
  message: { id: string; text: string }, key: string, signal: AbortSignal):
  Promise<{ source_message_id: string; image_key: string; image: ImageAttachmentRef }> {
  if (!weixinImageKeys(message.text).includes(key)) throw new Error('Choose an image key from this source message')
  const images = (trigger.meta.images as WeixinImageFile[] | undefined) ?? []
  const found = images.find(image => image.key === key)
  if (!found) throw new Error('The image is no longer available; it was not downloaded')
  const root = resolve(stateDir, 'weixin-media')
  const file = resolve(found.file)
  if (file !== root && !file.startsWith(root + sep)) throw new Error('The image path is outside the Weixin media directory')
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

/** Validates one stored credential file written by `scripts/weixin-login.mjs`. */
export const WeixinAccountFileSchema = z.object({
  token: z.string().min(1), baseUrl: z.string().optional(), accountId: z.string().optional(), userId: z.string().optional(),
  savedAt: z.string().optional(),
}).loose()
