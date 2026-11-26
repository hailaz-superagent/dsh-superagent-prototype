/**
 * WeCom AI Bot long connection: the SDK adapter, message mapping, reply sender and runner.
 *
 * Unlike the optional loopback bridge, this transport holds the WeCom WebSocket
 * connection inside the dsh-superagent process. The SDK performs authentication,
 * heartbeats and exponential-backoff reconnects, so no separate process, public
 * callback URL or polling is involved.
 */
import { WSClient, type WsFrame } from '@wecom/aibot-node-sdk'
import { z } from 'zod'
import type { OutboundMessage, Trigger } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import { health, type SourceContext } from './host.ts'
import { prepareLiveImages, type LiveImageRef } from './wecom-live-image.ts'
import { SOURCE, wecomTriggerId } from './wecom-shared.ts'
import type { WecomConfig } from './wecom.ts'

/** Address marker that routes a reply through the in-process long connection. */
export const LIVE_TRANSPORT = 'live'
/** A passive reply must reuse the callback request id; WeCom accepts it only for a short window. */
export const PASSIVE_WINDOW_MS = 4_000
/** Drop cached callback ids that can no longer be used for a passive reply. */
const CALLBACK_TTL_MS = 5 * 60_000

const LiveImageSchema = z.object({
  url: z.string().min(1),
  aeskey: z.string().optional(),
}).loose()

const LiveMessageSchema = z.object({
  msgid: z.string().min(1),
  chatid: z.string().optional(),
  chattype: z.enum(['single', 'group']),
  from: z.object({ userid: z.string().min(1) }).loose(),
  create_time: z.number().optional(),
  msgtype: z.string(),
  text: z.object({ content: z.string() }).loose().optional(),
  image: LiveImageSchema.optional(),
  mixed: z.object({
    msg_item: z.array(z.object({
      msgtype: z.string(),
      text: z.object({ content: z.string() }).loose().optional(),
      image: LiveImageSchema.optional(),
    }).loose()),
  }).loose().optional(),
  voice: z.object({ content: z.string() }).loose().optional(),
  file: z.object({ name: z.string().optional() }).loose().optional(),
  video: z.object({ name: z.string().optional() }).loose().optional(),
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
  connect(): void
  disconnect(): void
  reply(requestId: string, body: Record<string, unknown>): Promise<void>
  sendMessage(chatId: string, body: Record<string, unknown>): Promise<void>
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Buffer; filename?: string }>
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
    connect() { client.connect() },
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
  }
}

/** Removes WeCom mention placeholders and the zero-width space that follows them. */
export function cleanLiveText(text: string): string {
  return text.replace(/\$\{inline_mention:[^}]*\}\u200b?/g, '').trim()
}

/** Text and image references extracted from one callback. */
export interface LiveMessageParts { text?: string; images: LiveImageRef[] }

/**
 * Extracts the readable parts of a WeCom message.
 *
 * Images become numbered `[图片] img_wecom_N` markers with a reference the runner
 * downloads before the callback URL expires. Files and videos have no readable
 * content here; they become a marker so the agent can ask the person to resend or
 * describe them instead of silently losing the message.
 */
export function liveMessageParts(body: LiveMessage): LiveMessageParts {
  const images: LiveImageRef[] = []
  if (body.msgtype === 'text') return { text: cleanLiveText(body.text?.content ?? '') || undefined, images }
  if (body.msgtype === 'voice') return { text: cleanLiveText(body.voice?.content ?? '') || undefined, images }
  if (body.msgtype === 'image') {
    if (!body.image) return { images }
    const key = 'img_wecom_0'
    images.push({ key, url: body.image.url, ...(body.image.aeskey ? { aeskey: body.image.aeskey } : {}) })
    return { text: `[图片] ${key}`, images }
  }
  if (body.msgtype === 'file') return { text: body.file?.name ? `[文件] ${body.file.name}` : '[文件]', images }
  if (body.msgtype === 'video') return { text: body.video?.name ? `[视频] ${body.video.name}` : '[视频]', images }
  if (body.msgtype === 'mixed') {
    const lines: string[] = []
    for (const item of body.mixed?.msg_item ?? []) {
      if (item.msgtype === 'text') {
        const text = cleanLiveText(item.text?.content ?? '')
        if (text) lines.push(text)
      } else if (item.msgtype === 'image' && item.image) {
        const key = `img_wecom_${images.length}`
        images.push({ key, url: item.image.url, ...(item.image.aeskey ? { aeskey: item.image.aeskey } : {}) })
        lines.push(`[图片] ${key}`)
      }
    }
    return { text: lines.length ? lines.join('\n') : undefined, images }
  }
  return { images }
}

/** Extracts only the human-readable text; images are handled by `liveMessageParts`. */
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
      ...(parts.images.length ? { images: parts.images } : {}),
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
 * `aibot_send_msg` to the chat instead.
 */
export async function sendLiveReply(message: OutboundMessage): Promise<'sent' | 'gone'> {
  const bot = activeBot
  if (!bot) throw new Error('The WeCom long connection is not ready')
  const { reqId = '', chatId = '', userId = '', chatType = '' } = message.channel.address
  const text = checkedImText(message.text)
  const target = chatId || userId
  if (!target) return 'gone'
  pruneCallbacks()
  const receivedAt = callbacks.get(reqId)
  if (reqId && receivedAt !== undefined && Date.now() - receivedAt <= PASSIVE_WINDOW_MS) {
    try {
      await bot.reply(reqId, markdownBody(text))
      callbacks.delete(reqId)
      return 'sent'
    } catch {
      // The passive window may have closed while the outbox queued the reply; fall back to an active send.
    }
  }
  await bot.sendMessage(target, { ...markdownBody(text), chat_type: chatType === 'group' ? 2 : 1 })
  return 'sent'
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
  current.onMessage((frame: LiveFrame) => {
    chain = chain.then(async () => {
      if (running.signal.aborted) return
      if (ctx.config<WecomConfig>(SOURCE)?.mode !== 'live') return
      const trigger = liveTrigger(frame)
      if (!trigger || seen.has(trigger.id)) return
      callbacks.set(String(trigger.meta.reqId ?? ''), Date.now())
      pruneCallbacks()
      // WeCom image URLs expire in five minutes, so keep the bytes before the Trigger is queued.
      await prepareLiveImages(ctx, current, trigger, running.signal)
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
