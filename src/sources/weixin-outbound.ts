/**
 * Personal WeChat outbound media.
 *
 * DSH's outbound message is text, so a reply names a local file with Markdown
 * image/link syntax or a `MEDIA:` line. The channel uploads each existing file
 * to the Weixin CDN (AES-128-ECB), then sends it as an image, video, voice or
 * file item after the remaining text. Files outside this convention stay text.
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute } from 'node:path'
import { checkedImText } from '../infra/text.ts'
import { sendItem, uploadMedia, type WeixinCredentials, type WeixinUpload } from './weixin-api.ts'
import { wavToPcm } from './weixin-audio.ts'
import { rememberQuote, weixinAccountKey } from './weixin-quotes.ts'
import { plainWeixinText, splitWeixinText } from './weixin-text.ts'

/** One local file a reply names, classified by its extension. */
export interface WeixinOutboundMedia { kind: 'image' | 'video' | 'voice' | 'file'; file: string; name: string }
/** A reply split into the remaining caption and the local files to upload. */
export interface WeixinOutboundParts { text: string; media: WeixinOutboundMedia[] }

const MAX_OUTBOUND_BYTES = 20 * 1024 * 1024
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const VIDEO = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi'])
const VOICE = new Set(['.mp3', '.ogg', '.wav', '.silk', '.amr'])
const ENCODE_TYPES: Record<string, number> = { '.mp3': 7, '.ogg': 8, '.wav': 1, '.silk': 6, '.amr': 5 }

/** Resolves a Markdown/file path to a regular local file of an acceptable size, or undefined. */
function localFile(raw: string): string | undefined {
  let value = raw.trim().replace(/^<|>$/g, '')
  if (value.startsWith('file://')) {
    try { value = decodeURIComponent(new URL(value).pathname) } catch { return undefined }
  }
  if (!isAbsolute(value)) return undefined
  try {
    if (!statSync(value).isFile() || statSync(value).size === 0 || statSync(value).size > MAX_OUTBOUND_BYTES) return undefined
    return value
  } catch { return undefined }
}

function kindOf(file: string): WeixinOutboundMedia['kind'] {
  const ext = extname(file).toLowerCase()
  if (IMAGE.has(ext)) return 'image'
  if (VIDEO.has(ext)) return 'video'
  if (VOICE.has(ext)) return 'voice'
  return 'file'
}

/**
 * Extracts local media from a reply. Markdown images, Markdown links and
 * `MEDIA:` lines are accepted; a URL or a missing path is left untouched as text.
 */
export function extractWeixinMedia(input: string): WeixinOutboundParts {
  const media: WeixinOutboundMedia[] = []
  const add = (raw: string): boolean => {
    const file = localFile(raw)
    if (!file) return false
    if (media.some(item => item.file === file)) return true
    media.push({ kind: kindOf(file), file, name: basename(file) })
    return true
  }
  let text = input.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (whole, _alt: string, target: string) => add(target) ? '' : whole)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, _label: string, target: string) => add(target) ? '' : whole)
  text = text.replace(/^[ \t]*MEDIA:[ \t]*(\S+)[ \t]*$/gm, (whole, target: string) => add(target) ? '' : whole)
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), media }
}

/** The message item shape the gateway expects for one uploaded file. */
function mediaItem(media: WeixinOutboundMedia, upload: WeixinUpload, voice?: { encodeType: number; sampleRate: number; playtime: number }): Record<string, unknown> {
  const ref = {
    media: {
      encrypt_query_param: upload.downloadParam,
      // The gateway expects the base64 of the 32-char hex key, as the official plugin sends it.
      aes_key: Buffer.from(upload.aeskey).toString('base64'),
      encrypt_type: 1,
    },
  }
  if (media.kind === 'image') return { type: 2, image_item: { ...ref, mid_size: upload.cipherSize } }
  if (media.kind === 'video') return { type: 5, video_item: { ...ref, video_size: upload.cipherSize } }
  if (media.kind === 'voice') return { type: 3, voice_item: { ...ref, encode_type: voice?.encodeType ?? ENCODE_TYPES[extname(media.file).toLowerCase()] ?? 7, ...voice ? { sample_rate: voice.sampleRate, playtime: voice.playtime } : {} } }
  return { type: 4, file_item: { ...ref, file_name: media.name, len: String(upload.rawSize) } }
}

const mediaType = (kind: WeixinOutboundMedia['kind']): number => kind === 'image' ? 1 : kind === 'video' ? 2 : kind === 'voice' ? 4 : 3

/** Deterministic per-message client id, so a retried reply reuses the same identity. */
function clientId(messageId: string, index: number): string {
  return `dsh-superagent:${createHash('sha256').update(`${messageId}:${index}`).digest('hex').slice(0, 32)}`
}

/** Sends a reply: its text caption first, then every local file it names. */
export async function sendWeixinReply(credentials: WeixinCredentials, input: {
  messageId: string; to: string; text: string; contextToken?: string
}, signal?: AbortSignal): Promise<'sent' | 'gone'> {
  if (!input.to) return 'gone'
  const parts = extractWeixinMedia(input.text)
  const caption = plainWeixinText(parts.text).trim()
  const chunks = caption ? splitWeixinText(caption) : []
  const account = weixinAccountKey(credentials)
  let index = 0
  for (const chunk of chunks) {
    const sent = await sendItem(credentials, {
      to: input.to, item: { type: 1, text_item: { text: chunk } },
      ...input.contextToken ? { contextToken: input.contextToken } : {},
      clientId: clientId(input.messageId, index++), signal,
    })
    if (sent) rememberQuote(account, input.to, sent, chunk)
  }
  for (const media of parts.media) {
    let data: Buffer = readFileSync(media.file)
    let filename = media.name
    let voice: { encodeType: number; sampleRate: number; playtime: number } | undefined
    if (media.kind === 'voice' && extname(media.file).toLowerCase() === '.wav') {
      const parsed = wavToPcm(data)
      if (parsed) { data = parsed.pcm as Buffer; filename = `${media.name.slice(0, -4)}.pcm`; voice = { encodeType: 1, sampleRate: parsed.sampleRate, playtime: parsed.playtime } }
    }
    const upload = await uploadMedia(credentials, {
      data, to: input.to, mediaType: mediaType(media.kind), filename, signal,
    })
    const sent = await sendItem(credentials, {
      to: input.to, item: mediaItem(media, upload, voice), ...input.contextToken ? { contextToken: input.contextToken } : {},
      clientId: clientId(input.messageId, index++), signal,
    })
    if (sent) rememberQuote(account, input.to, sent, media.kind === 'image' ? '[图片]' : `[${media.kind}] ${media.name}`)
  }
  if (!chunks.length && parts.media.length === 0) {
    // A reply that became empty still needs a visible body.
    await sendItem(credentials, {
      to: input.to, item: { type: 1, text_item: { text: checkedImText(plainWeixinText(input.text)) } },
      ...input.contextToken ? { contextToken: input.contextToken } : {},
      clientId: clientId(input.messageId, index), signal,
    })
  }
  return 'sent'
}

/** Exposed for tests that need a filename without reading the file. */
export const outboundMediaType = mediaType
/** Exposed for tests that build the same client id the sender uses. */
export const outboundClientId = clientId