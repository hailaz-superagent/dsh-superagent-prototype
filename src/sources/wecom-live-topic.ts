/**
 * WeCom channel (Topic) events for the long connection.
 *
 * SDK 1.0.7 does not dispatch `aibot_topic_event_callback`; the adapter intercepts
 * it at the connection manager and this module maps it to a Trigger. The post or
 * reply body is fetched explicitly (`aibot_topic_get_post_list` / `..._reply_list`)
 * because the @ event carries ids only.
 */
import type { Trigger } from '../core/index.ts'
import type { LiveMediaRef } from './wecom-live-image.ts'
import { SOURCE, wecomTriggerId } from './wecom-shared.ts'
import type { LiveFrame } from './wecom-live.ts'

/** Address marker that routes a reply through `aibot_topic_send_reply`. */
export const LIVE_TOPIC_TRANSPORT = 'live-topic'
/** Protocol command for a channel @ event; absent from the SDK's command enum. */
export const TOPIC_EVENT_CALLBACK = 'aibot_topic_event_callback'

/** The topic post or reply a callback points at. */
export interface TopicTarget {
  topicId: string
  postId: string
  replyId?: string
  /** Set when replying to a comment; `replyId` is the protocol id. */
  parentReplyId?: string
}

/** One attachment of a post or comment; it carries a download URL and a cookie, not a media id. */
export interface TopicMedia {
  download_url?: string
  /** Older or bridge-shaped payloads may use `url`. */
  url?: string
  file_name?: string
  name?: string
  cookie_name?: string
  cookie_value?: string
}

/** The subset of a fetched post/reply this Source reads. */
export interface TopicContent {
  post_id?: string
  reply_id?: string
  content?: string
  create_time?: number
  is_recalled?: boolean
  creator?: { userid?: string; type?: number } | null
  creator_info?: { userid?: string; type?: number } | null
  /** Images attached to a post or comment. */
  image_list?: TopicMedia[]
  /** Files attached to a post or comment. */
  inline_file_list?: TopicMedia[]
}

const MENTION = /\$\{inline_mention:[^}]*\}\u200b?/g

/** Removes WeCom mention placeholders and zero-width spaces from fetched content. */
export function cleanTopicText(content: unknown): string {
  return String(content ?? '').replace(MENTION, '').replace(/\u200b/g, '').trim()
}

/** Reads the topic, post and reply ids from an `aibot_topic_event_callback` frame. */
export function topicTarget(frame: LiveFrame): TopicTarget | undefined {
  const body = frame.body as {
    topic_id?: string
    event?: { topic_at_bot?: { post_id?: string; reply_id?: string } }
  } | undefined
  const at = body?.event?.topic_at_bot
  if (!body?.topic_id || !at?.post_id) return undefined
  return { topicId: body.topic_id, postId: at.post_id, ...(at.reply_id ? { replyId: at.reply_id } : {}) }
}

/** `creator` and `creator_info` disagree across protocol docs; accept either. */
function creatorOf(content: TopicContent): { userid?: string; type?: number } | undefined {
  const named = content.creator
  if (named && (named.userid || (named.type !== undefined && named.type !== 0))) return named
  return content.creator_info ?? named ?? undefined
}

/** Numbered media markers for a post or comment, downloaded by the runner before ingest. */
export function topicMedia(content: TopicContent): LiveMediaRef[] {
  const media: LiveMediaRef[] = []
  const cookie = (item: TopicMedia): { name: string; value: string } | undefined =>
    item.cookie_name ? { name: item.cookie_name, value: item.cookie_value ?? '' } : undefined
  for (const image of content.image_list ?? []) {
    const url = image.download_url ?? image.url
    if (!url) continue
    media.push({
      key: `img_wecom_${media.length}`, marker: `[图片] img_wecom_${media.length}`, kind: 'image', url,
      ...(cookie(image) ? { cookie: cookie(image) } : {}),
    })
  }
  let files = 0
  for (const file of content.inline_file_list ?? []) {
    const url = file.download_url ?? file.url
    if (!url) continue
    const name = file.file_name ?? file.name
    media.push({
      key: `file_wecom_${files}`, marker: `[文件] file_wecom_${files}`, kind: 'file', url,
      ...(name ? { name } : {}), ...(cookie(file) ? { cookie: cookie(file) } : {}),
    })
    files += 1
  }
  return media
}

/** Maps an @-in-channel event plus its fetched content to a Trigger. */
export function liveTopicTrigger(frame: LiveFrame, target: TopicTarget, content: TopicContent | undefined): Trigger | undefined {
  if (!content || content.is_recalled) return undefined
  const creator = creatorOf(content)
  if (creator?.type === 1) return undefined
  const media = topicMedia(content)
  const text = [cleanTopicText(content.content), ...media.map(item => item.marker)].filter(Boolean).join('\n')
  if (!text) return undefined
  const body = frame.body as { msgid?: string; from?: { userid?: string }; create_time?: number } | undefined
  const userId = creator?.userid || body?.from?.userid || ''
  if (!userId) return undefined
  const key = body?.msgid || `topic|${target.topicId}|${target.postId}|${target.replyId ?? ''}`
  const raw = content.create_time || body?.create_time
  const at = raw ? new Date((raw > 1e12 ? raw : raw * 1000)).toISOString() : new Date().toISOString()
  return {
    id: wecomTriggerId(key),
    source: SOURCE,
    threads: [{ source: SOURCE, id: `topic:${target.topicId}` }],
    actor: { source: SOURCE, id: userId },
    human: true,
    addressed: 'mention',
    at,
    text,
    channel: {
      source: SOURCE,
      thread: `wecom:topic:${target.topicId}`,
      address: {
        transport: LIVE_TOPIC_TRANSPORT, topicId: target.topicId, postId: target.postId,
        ...(target.replyId ? { parentReplyId: target.replyId } : {}), msgId: key,
      },
    },
    meta: {
      topicId: target.topicId, postId: target.postId,
      ...(target.replyId ? { parentReplyId: target.replyId } : {}), msgId: key, transport: LIVE_TOPIC_TRANSPORT,
      ...(media.length ? { media } : {}),
    },
  }
}
