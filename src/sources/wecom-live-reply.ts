/**
 * Outbound media for the WeCom long connection.
 *
 * The agent writes one Markdown reply. When a link in that reply points at an
 * absolute local file, the file is uploaded as a temporary WeCom material and
 * sent as a separate image, file or video message; the link itself is removed
 * from the text so the reader never sees a local path. Web links stay untouched.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute } from 'node:path'
import type { LiveBot } from './wecom-live.ts'
import { liveImageType } from './wecom-live-image.ts'

/** Official temporary-material caps: images and videos 10MB, ordinary files 20MB. */
export const MAX_REPLY_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_REPLY_VIDEO_BYTES = 10 * 1024 * 1024
export const MAX_REPLY_FILE_BYTES = 20 * 1024 * 1024
/** Largest attachment any kind may carry, used for the first cheap size check. */
export const MAX_REPLY_MEDIA_BYTES = MAX_REPLY_FILE_BYTES

/** One Markdown link in a reply that points at a local file. */
export interface ReplyMediaLink {
  /** The whole Markdown link, so it can be removed from the text. */
  markdown: string
  /** Link label, used as the video title. */
  label: string
  /** Absolute local path from the link. */
  path: string
}

/** One local file ready to upload as a WeCom media message. */
export interface ReplyMedia {
  kind: 'image' | 'file' | 'video'
  name: string
  data: Buffer
}

/** The reply text without local attachments, and the files to send after it. */
export interface PreparedReply {
  text: string
  media: ReplyMedia[]
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm'])

/** Finds absolute local links (image or plain Markdown) without touching web URLs. */
export function replyMediaLinks(text: string): ReplyMediaLink[] {
  const links: ReplyMediaLink[] = []
  const pattern = /!?\[([^\]]*)\]\(([^)\s]+)\)/g
  for (const match of text.matchAll(pattern)) {
    const path = match[2] ?? ''
    if (!isAbsolute(path) || path.startsWith('//')) continue
    links.push({ markdown: match[0], label: (match[1] ?? '').trim() || basename(path), path })
  }
  return links
}

/** Reads one link as media, or returns undefined when it is not a usable local file. */
async function readReplyMedia(link: ReplyMediaLink): Promise<ReplyMedia | undefined> {
  try {
    const info = await stat(link.path)
    if (!info.isFile() || info.size === 0 || info.size > MAX_REPLY_MEDIA_BYTES) return undefined
    const data = await readFile(link.path)
    if (data.length === 0 || data.length > MAX_REPLY_MEDIA_BYTES) return undefined
    const name = basename(link.path)
    const extension = extname(name).toLowerCase()
    const image = liveImageType(data)
    if (image) {
      return data.length <= MAX_REPLY_IMAGE_BYTES ? { kind: 'image', name: name || `image${image.ext}`, data } : undefined
    }
    if (IMAGE_EXTENSIONS.has(extension)) return undefined
    if (VIDEO_EXTENSIONS.has(extension)) {
      return data.length <= MAX_REPLY_VIDEO_BYTES ? { kind: 'video', name, data } : undefined
    }
    return data.length <= MAX_REPLY_FILE_BYTES ? { kind: 'file', name, data } : undefined
  } catch {
    return undefined
  }
}

/**
 * Splits a reply into sendable text and local attachments.
 *
 * A link that cannot be read as a local file stays in the text, so a stale path
 * is visible instead of silently disappearing. A valid link is removed even when
 * the same file is linked twice; the file is sent once.
 */
export async function prepareReplyMedia(text: string): Promise<PreparedReply> {
  const links = replyMediaLinks(text)
  if (links.length === 0) return { text, media: [] }
  let remaining = text
  const media: ReplyMedia[] = []
  const seen = new Set<string>()
  for (const link of links) {
    const item = await readReplyMedia(link)
    if (!item) continue
    remaining = remaining.split(link.markdown).join('')
    if (seen.has(link.path)) continue
    seen.add(link.path)
    media.push(item)
  }
  return { text: remaining.replace(/[ \t]+\n/g, '\n').trim(), media }
}

/** Uploads and actively sends each attachment; active sends work after the passive reply window too. */
export async function sendReplyMedia(bot: Pick<LiveBot, 'uploadMedia' | 'sendMessage'>, chatId: string,
  chatType: string, media: readonly ReplyMedia[]): Promise<void> {
  const type = chatType === 'group' ? 2 : 1
  for (const item of media) {
    const mediaId = await bot.uploadMedia(item.data, item.kind, item.name)
    const content: Record<string, unknown> = { media_id: mediaId }
    if (item.kind === 'video') content.title = item.name
    await bot.sendMessage(chatId, { msgtype: item.kind, [item.kind]: content, chat_type: type })
  }
}
