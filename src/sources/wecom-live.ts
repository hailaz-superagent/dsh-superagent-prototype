/**
 * WeCom AI Bot long connection: the SDK adapter, message mapping, reply sender and runner.
 *
 * Unlike the optional loopback bridge, this transport holds the WeCom WebSocket
 * connection inside the dsh-superagent process. The SDK performs authentication,
 * heartbeats and exponential-backoff reconnects, so no separate process, public
 * callback URL or polling is involved.
 */
import { WSClient, generateReqId, type WsFrame } from '@wecom/aibot-node-sdk'
import { z } from 'zod'
import type { OutboundMessage, Trigger } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import { health, type SourceContext } from './host.ts'
import { prepareLiveMedia, type LiveMediaRef } from './wecom-live-image.ts'
import { prepareReplyMedia, sendReplyMedia } from './wecom-live-reply.ts'
import { SOURCE, wecomTriggerId } from './wecom-shared.ts'
import { LIVE_TOPIC_TRANSPORT, TOPIC_EVENT_CALLBACK, liveTopicTrigger, topicTarget, type TopicContent, type TopicTarget } from './wecom-live-topic.ts'
import type { WecomConfig } from './wecom.ts'

/** Address marker that routes a reply through the in-process long connection. */
export const LIVE_TRANSPORT = 'live'
/** A passive reply must reuse the callback request id; WeCom accepts it only for a short window. */
export const PASSIVE_WINDOW_MS = 4_000
/** Drop cached callback ids that can no longer be used for a passive reply. */
const CALLBACK_TTL_MS = 5 * 60_000

const LiveMediaSchema = z.object({
  url: z.string().min(1).optional(),
  aeskey: z.string().optional(),
  name: z.string().optional(),
}).loose()

const LiveMixedItemSchema = z.object({
  msgtype: z.string(),
  text: z.object({ content: z.string() }).loose().optional(),
  image: LiveMediaSchema.optional(),
}).loose()

const LiveTextSchema = z.object({ content: z.string() }).loose()
const LiveVoiceSchema = z.object({ content: z.string().optional() }).loose()

const LiveQuoteSchema = z.object({
  msgtype: z.string(),
  text: LiveTextSchema.optional(),
  image: LiveMediaSchema.optional(),
  mixed: z.object({ msg_item: z.array(LiveMixedItemSchema) }).loose().optional(),
  voice: LiveVoiceSchema.optional(),
  file: LiveMediaSchema.optional(),
  video: LiveMediaSchema.optional(),
}).loose()

const LiveMessageSchema = z.object({
  msgid: z.string().min(1),
  chatid: z.string().optional(),
  chattype: z.enum(['single', 'group']),
  from: z.object({ userid: z.string().min(1) }).loose(),
  create_time: z.number().optional(),
  msgtype: z.string(),
  text: LiveTextSchema.optional(),
  image: LiveMediaSchema.optional(),
  mixed: z.object({ msg_item: z.array(LiveMixedItemSchema) }).loose().optional(),
  voice: LiveVoiceSchema.optional(),
  file: LiveMediaSchema.optional(),
  video: LiveMediaSchema.optional(),
  quote: LiveQuoteSchema.optional(),
}).loose()
export type LiveMessage = z.infer<typeof LiveMessageSchema>

/** The subset of a WeCom callback frame this Source reads. */
export interface LiveFrame {
  headers: { req_id: string; [key: string]: unknown }
  body: unknown
  [key: string]: unknown
}

/** Minimal long-connection client used by the runner; the SDK adapter and tests implement it. */
export interface LiveBot {
  readonly connected: boolean
  onAuthenticated(handler: () => void): void
  onDisconnected(handler: (reason: string) => void): void
  onError(handler: (error: unknown) => void): void
  onMessage(handler: (frame: LiveFrame) => void): void
  onTopic(handler: (frame: LiveFrame) => void): void
  connect(): void
  disconnect(): void
  reply(requestId: string, body: Record<string, unknown>): Promise<void>
  sendMessage(chatId: string, body: Record<string, unknown>): Promise<void>
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>
  uploadMedia(data: Buffer, type: 'image' | 'file' | 'video', filename: string): Promise<string>
  topicPost(topicId: string, postId: string): Promise<TopicContent | undefined>
  topicReplyContent(topicId: string, postId: string, replyId: string): Promise<TopicContent | undefined>
  sendTopicReply(target: TopicTarget, content: string): Promise<void>
}

/** Options accepted by the real SDK adapter. */
export type LiveCredentials = Pick<WecomConfig, 'botId' | 'secret' | 'wsUrl'>

/** The active connection, used by `channel.send` after the outbox releases a reply. */
let activeBot: LiveBot | undefined
/** Callback ids whose passive reply window may still be open, with their arrival time. */
const callbacks = new Map<string, number>()

export function setLiveBot(bot: LiveBot | undefined): void {
  if (activeBot !== bot) callbacks.clear()
  activeBot = bot
  pruneCallbacks()
}

export function liveBot(): LiveBot | undefined {
  return activeBot
}

function pruneCallbacks(now = Date.now()): void {
  for (const [requestId, at] of callbacks) {
    if (now - at > CALLBACK_TTL_MS) callbacks.delete(requestId)
  }
}

const silentLogger = {
  debug: (): void => {},
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
}

/** The SDK rejects an unsuccessful ack with the raw frame; turn it into an error the outbox can log. */
function ackError(action: string, error: unknown): Error {
  if (error instanceof Error) return error
  const frame = error as { errcode?: number; errmsg?: string } | undefined
  return new Error(`${action} failed: ${frame?.errmsg ?? String(error)}${frame?.errcode === undefined ? '' : ` (code ${frame.errcode})`}`)
}

/** Adapts `@wecom/aibot-node-sdk` to the small interface the runner needs. */
export function sdkLiveBot(config: LiveCredentials): LiveBot {
  const client = new WSClient({
    botId: config.botId,
    secret: config.secret,
    ...(config.wsUrl ? { wsUrl: config.wsUrl } : {}),
    maxReconnectAttempts: -1,
    maxAuthFailureAttempts: -1,
    heartbeatInterval: 30_000,
    requestTimeout: 15_000,
    logger: silentLogger,
  })
  let topicHandler: ((frame: LiveFrame) => void) | undefined
  const installTopic = (): void => {
    const manager = (client as unknown as {
      wsManager?: { handleFrame?: (frame: WsFrame) => void; __dshTopicPatched?: boolean }
    }).wsManager
    if (!manager || typeof manager.handleFrame !== 'function') {
      throw new Error('aibot-node-sdk internals changed: wsManager.handleFrame is unavailable')
    }
    if (manager.__dshTopicPatched) return
    const original = manager.handleFrame.bind(manager)
    manager.handleFrame = (frame: WsFrame) => {
      if ((frame as { cmd?: string }).cmd === TOPIC_EVENT_CALLBACK) {
        if (topicHandler) topicHandler(frame as LiveFrame)
        return
      }
      original(frame)
    }
    manager.__dshTopicPatched = true
  }
  return {
    get connected() { return client.isConnected === true },
    onAuthenticated(handler) { client.on('authenticated', handler) },
    onDisconnected(handler) { client.on('disconnected', reason => handler(String(reason ?? ''))) },
    onError(handler) { client.on('error', handler) },
    onMessage(handler) {
      for (const event of ['message.text', 'message.image', 'message.mixed', 'message.voice', 'message.file', 'message.video'] as const) {
        client.on(event, (frame: WsFrame) => handler(frame as LiveFrame))
      }
    },
    onTopic(handler) { topicHandler = handler },
    connect() {
      client.connect()
      if (!topicHandler) return
      try { installTopic() } catch (error) { client.emit('error', error as Error) }
    },
    disconnect() { client.disconnect() },
    async reply(requestId, body) {
      try {
        const ack = await client.reply({ headers: { req_id: requestId } }, body)
        if (ack.errcode !== undefined && ack.errcode !== 0) throw new Error(`WeCom reply failed: ${ack.errmsg ?? 'unknown error'} (code ${ack.errcode})`)
      } catch (error) {
        throw ackError('WeCom reply', error)
      }
    },
    async sendMessage(chatId, body) {
      try {
        const ack = await client.sendMessage(chatId, body as never)
        if (ack.errcode !== undefined && ack.errcode !== 0) throw new Error(`WeCom send failed: ${ack.errmsg ?? 'unknown error'} (code ${ack.errcode})`)
      } catch (error) {
        throw ackError('WeCom send', error)
      }
    },
    downloadFile(url, aesKey) { return client.downloadFile(url, aesKey) },
    async uploadMedia(data, type, filename) {
      try {
        const uploaded = await client.uploadMedia(data, { type, filename })
        if (!uploaded.media_id) throw new Error('WeCom upload returned no media_id')
        return uploaded.media_id
      } catch (error) {
        throw ackError('WeCom media upload', error)
      }
    },
    async topicPost(topicId, postId) {
      const body = await topicCall('aibot_topic_get_post_list', { topic_id: topicId, post_id_list: [postId] })
      return (body?.post_list as TopicContent[] | undefined)?.[0]
    },
    async topicReplyContent(topicId, postId, replyId) {
      const body = await topicCall('aibot_topic_get_reply_list', {
        topic_id: topicId, post_id: postId, reply_id_list: [replyId],
      })
      return (body?.reply_list as TopicContent[] | undefined)?.[0]
    },
    async sendTopicReply(target, content) {
      const body: Record<string, unknown> = { topic_id: target.topicId, post_id: target.postId, content }
      const parent = target.parentReplyId ?? target.replyId
      if (parent) body.parent_reply_id = parent
      await topicCall('aibot_topic_send_reply', body)
    },
  }

  async function topicCall(cmd: string, body: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
    try {
      const ack = await client.reply({ headers: { req_id: generateReqId(cmd) } }, body, cmd)
      if (ack.errcode !== undefined && ack.errcode !== 0) {
        throw new Error(`${cmd} failed: ${ack.errmsg ?? 'unknown error'} (code ${ack.errcode})`)
      }
      return (ack as { body?: Record<string, unknown> }).body
    } catch (error) {
      throw ackError(cmd, error)
    }
  }
}

/** Removes WeCom mention placeholders and the zero-width space that follows them. */
export function cleanLiveText(text: string): string {
  return text.replace(/\$\{inline_mention:[^}]*\}\u200b?/g, '').trim()
}

/** Text and media references extracted from one callback. */
export interface LiveMessageParts { text?: string; images: LiveMediaRef[]; media: LiveMediaRef[] }

const mediaLabel = (kind: LiveMediaRef['kind']): string =>
  kind === 'image' ? '图片' : kind === 'video' ? '视频' : '文件'

function imageRef(image: { url?: string; aeskey?: string } | undefined, index: number,
  label = '[图片]'): LiveMediaRef | undefined {
  if (!image) return undefined
  return {
    key: `img_wecom_${index}`, marker: `${label} img_wecom_${index}`, kind: 'image', url: image.url ?? '',
    ...(image.aeskey ? { aeskey: image.aeskey } : {}),
  }
}

function storedRef(kind: 'file' | 'video', media: { url?: string; aeskey?: string; name?: string } | undefined,
  index: number, label?: string): LiveMediaRef | undefined {
  if (!media) return undefined
  return {
    key: `${kind}_wecom_${index}`, marker: `${label ?? (kind === 'file' ? '[文件]' : '[视频]')} ${kind}_wecom_${index}`,
    kind, url: media.url ?? '',
    ...(media.name ? { name: media.name } : {}),
    ...(media.aeskey ? { aeskey: media.aeskey } : {}),
  }
}

/**
 * Extracts the readable parts of a WeCom message.
 *
 * Images become numbered `[图片] img_wecom_N` markers, files and videos become
 * `[文件]/[视频] *_wecom_N` markers; the runner downloads all of them before the
 * callback URL expires. A quoted message is prefixed as `[引用] …` and its media is
 * downloaded too. A voice message without a transcription keeps a marker because
 * WeCom sends only the converted text, never the audio. Nothing is dropped silently.
 */
export function liveMessageParts(body: LiveMessage): LiveMessageParts {
  const images: LiveMediaRef[] = []
  const media: LiveMediaRef[] = []
  const lines: string[] = []

  const quote = body.quote
  if (quote) {
    const quoted: string[] = []
    const quoteText = cleanLiveText(quote.text?.content ?? '')
    if (quoteText) quoted.push(quoteText)
    if (quote.msgtype === 'voice') {
      const voice = cleanLiveText(quote.voice?.content ?? '')
      quoted.push(voice ? `[引用语音] ${voice}` : '[引用语音]（未提供转写文本）')
    }
    for (const item of quote.mixed?.msg_item ?? []) {
      if (item.msgtype === 'text') {
        const text = cleanLiveText(item.text?.content ?? '')
        if (text) quoted.push(text)
      } else if (item.msgtype === 'image') {
        const ref = imageRef(item.image, images.length, '[引用图片]')
        if (ref) { images.push(ref); quoted.push(ref.marker) }
      }
    }
    const quoteImage = imageRef(quote.image, images.length, '[引用图片]')
    if (quoteImage) { images.push(quoteImage); quoted.push(quoteImage.marker) }
    for (const kind of ['file', 'video'] as const) {
      const ref = storedRef(kind, kind === 'file' ? quote.file : quote.video, media.length, `[引用${mediaLabel(kind)}]`)
      if (ref) { media.push(ref); quoted.push(ref.marker) }
    }
    if (quoted.length) lines.push(`[引用] ${quoted.join('\n')}`)
  }

  if (body.msgtype === 'text') {
    const text = cleanLiveText(body.text?.content ?? '')
    if (text) lines.push(text)
  } else if (body.msgtype === 'voice') {
    const text = cleanLiveText(body.voice?.content ?? '')
    lines.push(text || '[语音消息，企业微信未提供转写文本]')
  } else if (body.msgtype === 'image') {
    const ref = imageRef(body.image, images.length)
    if (ref) { images.push(ref); lines.push(ref.marker) }
  } else if (body.msgtype === 'file' || body.msgtype === 'video') {
    const ref = storedRef(body.msgtype, body.msgtype === 'file' ? body.file : body.video, media.length)
    if (ref) { media.push(ref); lines.push(ref.marker) }
  } else if (body.msgtype === 'mixed') {
    for (const item of body.mixed?.msg_item ?? []) {
      if (item.msgtype === 'text') {
        const text = cleanLiveText(item.text?.content ?? '')
        if (text) lines.push(text)
      } else if (item.msgtype === 'image') {
        const ref = imageRef(item.image, images.length)
        if (ref) { images.push(ref); lines.push(ref.marker) }
      }
    }
  }
  return { text: lines.length ? lines.join('\n') : undefined, images, media }
}

/** Extracts only the human-readable text; media is handled by `liveMessageParts`. */
export function liveMessageText(body: LiveMessage): string | undefined {
  return liveMessageParts(body).text
}

function liveTime(body: LiveMessage): string {
  const raw = body.create_time
  if (!raw || !Number.isFinite(raw)) return new Date().toISOString()
  // WeCom sends seconds; tolerate an implementation that sends milliseconds.
  const millis = raw > 1e12 ? raw : raw * 1000
  return new Date(millis).toISOString()
}

/**
 * Maps one SDK callback to a Trigger, or returns undefined for a message this Source does not read.
 *
 * The Thread is the chat, not the message, so follow-ups in the same group or direct
 * chat reach the Ticket that already owns that conversation.
 */
export function liveTrigger(frame: LiveFrame): Trigger | undefined {
  const parsed = LiveMessageSchema.safeParse(frame.body)
  if (!parsed.success) return undefined
  const body = parsed.data
  const parts = liveMessageParts(body)
  if (!parts.text) return undefined
  const requestId = frame.headers.req_id
  if (!requestId) return undefined
  const chatId = body.chatid ?? ''
  const userId = body.from.userid
  const threadId = body.chattype === 'group' ? `group:${chatId || userId}` : `direct:${userId}`
  return {
    id: wecomTriggerId(body.msgid),
    source: SOURCE,
    threads: [{ source: SOURCE, id: threadId }],
    actor: { source: SOURCE, id: userId },
    human: true,
    addressed: body.chattype === 'group' ? 'mention' : 'direct',
    at: liveTime(body),
    text: parts.text,
    channel: {
      source: SOURCE,
      thread: `wecom:${threadId}`,
      address: { transport: LIVE_TRANSPORT, chatId, userId, reqId: requestId, msgId: body.msgid, chatType: body.chattype },
    },
    meta: {
      chatId, userId, reqId: requestId, msgId: body.msgid, chatType: body.chattype, transport: LIVE_TRANSPORT,
      ...(parts.images.length || parts.media.length ? { media: [...parts.images, ...parts.media] } : {}),
    },
  }
}

/** The markdown body WeCom accepts for passive replies and active sends. */
const markdownBody = (content: string): Record<string, unknown> => ({ msgtype: 'markdown', markdown: { content } })

/**
 * Sends one reply through the live connection.
 *
 * A fresh callback id is answered passively, which keeps quick acknowledgements in
 * the original message; a late result (or a reply after a restart) uses an active
 * `aibot_send_msg` to the chat instead. Absolute local Markdown links become
 * image, file or video messages sent after the text; channel Topic replies stay
 * text-only because the topic API has no media message.
 */
export async function sendLiveReply(message: OutboundMessage): Promise<'sent' | 'gone'> {
  const bot = activeBot
  if (!bot) throw new Error('The WeCom long connection is not ready')
  const {
    reqId = '', chatId = '', userId = '', chatType = '', transport = '',
    topicId = '', postId = '', parentReplyId = '',
  } = message.channel.address
  if (transport === LIVE_TOPIC_TRANSPORT) {
    if (!topicId || !postId) return 'gone'
    const text = checkedImText(message.text)
    await bot.sendTopicReply({ topicId, postId, ...(parentReplyId ? { parentReplyId } : {}) }, text)
    return 'sent'
  }
  const target = chatId || userId
  if (!target) return 'gone'
  const prepared = await prepareReplyMedia(message.text)
  const text = checkedImText(prepared.text)
  let sent = false
  if (text) {
    pruneCallbacks()
    const receivedAt = callbacks.get(reqId)
    if (reqId && receivedAt !== undefined && Date.now() - receivedAt <= PASSIVE_WINDOW_MS) {
      try {
        await bot.reply(reqId, markdownBody(text))
        callbacks.delete(reqId)
        sent = true
      } catch {
        // The passive window may have closed while the outbox queued the reply; fall back to an active send.
      }
    }
    if (!sent) {
      await bot.sendMessage(target, { ...markdownBody(text), chat_type: chatType === 'group' ? 2 : 1 })
      sent = true
    }
  }
  if (prepared.media.length) {
    await sendReplyMedia(bot, target, chatType, prepared.media)
    sent = true
  }
  return sent ? 'sent' : 'gone'
}

/** One running long connection and its configuration, so the watcher can restart it when settings change. */
export interface LiveRun {
  readonly credentials: LiveCredentials
  stop(): Promise<void>
}

/** Reports the connection state the panel shows; dynamic details stay in English like the other health details. */
function report(ctx: SourceContext, state: 'starting' | 'ready' | 'paused' | 'error', detail: string): void {
  ctx.report('wecom', { state, detail })
}

/**
 * Starts the SDK connection and feeds its messages into the Source context.
 *
 * The SDK reconnects on its own; this function only reports health, maps messages
 * and disconnects on abort. `onMessage` is serialized so assessments see messages
 * in arrival order, as the bridge poller did.
 */
export function startLive(ctx: SourceContext, config: WecomConfig, signal: AbortSignal,
  create: (credentials: LiveCredentials) => LiveBot = sdkLiveBot): LiveRun {
  const credentials: LiveCredentials = { botId: config.botId, secret: config.secret, wsUrl: config.wsUrl }
  if (!credentials.botId || !credentials.secret) {
    report(ctx, 'paused', 'The WeCom bot ID or secret is not set')
    return { credentials, stop: async () => {} }
  }
  let bot: LiveBot | undefined
  try {
    bot = create(credentials)
  } catch (error) {
    report(ctx, 'error', `Could not create the WeCom connection: ${String(error)}`)
    return { credentials, stop: async () => {} }
  }
  const running = new AbortController()
  const stop = (): void => running.abort(signal.reason)
  signal.addEventListener('abort', stop, { once: true })
  let stopped = false
  let chain = Promise.resolve()
  // The Store deduplicates Triggers by id too; this keeps a redelivered callback from doing the work twice.
  const seen = new Set<string>()
  const current = bot
  setLiveBot(current)
  current.onAuthenticated(() => { if (!running.signal.aborted) report(ctx, 'ready', 'Connected to WeCom') })
  current.onDisconnected(() => { if (!running.signal.aborted) report(ctx, 'starting', 'The WeCom connection closed; reconnecting') })
  current.onError((error: unknown) => {
    if (running.signal.aborted) return
    const detail = String(error).slice(0, 500)
    report(ctx, 'error', detail)
  })
  try {
    current.onTopic((frame: LiveFrame) => {
      chain = chain.then(async () => {
        if (running.signal.aborted) return
        if (ctx.config<WecomConfig>(SOURCE)?.mode !== 'live') return
        const target = topicTarget(frame)
        if (!target) return
        const content = target.replyId
          ? await current.topicReplyContent(target.topicId, target.postId, target.replyId)
          : await current.topicPost(target.topicId, target.postId)
        const trigger = liveTopicTrigger(frame, target, content)
        if (!trigger || seen.has(trigger.id)) return
        // Topic image and file URLs also expire, so keep their bytes before ingest.
        await prepareLiveMedia(ctx, current, trigger, running.signal)
        if (running.signal.aborted) return
        await ctx.receive(trigger)
        seen.add(trigger.id)
        if (seen.size > 1000) seen.delete(seen.values().next().value as string)
      }).catch((error: unknown) => {
        if (!running.signal.aborted) report(ctx, 'error', String(error).slice(0, 500))
      })
    })
  } catch (error) {
    // A changed SDK internal only loses channel events; ordinary messages keep working.
    report(ctx, 'error', String(error).slice(0, 500))
  }
  current.onMessage((frame: LiveFrame) => {
    chain = chain.then(async () => {
      if (running.signal.aborted) return
      if (ctx.config<WecomConfig>(SOURCE)?.mode !== 'live') return
      const trigger = liveTrigger(frame)
      if (!trigger || seen.has(trigger.id)) return
      callbacks.set(String(trigger.meta.reqId ?? ''), Date.now())
      pruneCallbacks()
      // WeCom media URLs expire in five minutes, so keep the bytes before the Trigger is queued.
      await prepareLiveMedia(ctx, current, trigger, running.signal)
      if (running.signal.aborted) return
      await ctx.receive(trigger)
      seen.add(trigger.id)
      if (seen.size > 1000) seen.delete(seen.values().next().value as string)
    }).catch((error: unknown) => {
      if (!running.signal.aborted) report(ctx, 'error', String(error).slice(0, 500))
    })
  })
  report(ctx, 'starting', 'Connecting to WeCom')
  current.connect()
  return {
    credentials,
    async stop() {
      if (stopped) return
      stopped = true
      running.abort()
      signal.removeEventListener('abort', stop)
      try { current.disconnect() } catch { /* A close of an already closed socket needs no further handling. */ }
      await chain
      if (liveBot() === current) setLiveBot(undefined)
    },
  }
}
