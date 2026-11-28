/**
 * Personal WeChat (personal 微信) Source.
 *
 * It speaks the iLink bot protocol used by `@tencent-weixin/openclaw-weixin`:
 * a QR login yields a bot token, `getupdates` long-polls the gateway for direct
 * messages, and `sendmessage` posts replies. A login file keeps the token out of
 * the settings database; the token field remains for deployments that paste it.
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { OutboundMessage, Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import { health, type Health, type SourceContext } from './host.ts'
import { getUpdates, sendText, STALE_TOKEN_ERRCODE, type WeixinCredentials, type WeixinMessage } from './weixin-api.ts'
import { prepareWeixinMedia, readWeixinImage, weixinImageKeys, WeixinAccountFileSchema, type WeixinMediaRef } from './weixin-media.ts'
import { sendWeixinReply } from './weixin-outbound.ts'
import { clearWeixinAcks, scheduleWeixinAck, cancelWeixinAck } from './weixin-ack.ts'
import { clearWeixinQuotes, recallQuote, rememberQuote, weixinAccountKey } from './weixin-quotes.ts'
import { plainWeixinText } from './weixin-text.ts'
import { pause } from './poll.ts'
import { DEFAULT_BASE_URL, SOURCE, weixinThreadId, weixinTriggerId } from './weixin-shared.ts'
import type { ChannelLink, ContextPart, SourceChannel, SourceKind, SourcePolicyPart, ThreadContext, VariableSpec } from './kind.ts'

export { SOURCE, weixinThreadId, weixinTriggerId } from './weixin-shared.ts'
export { DEFAULT_BASE_URL } from './weixin-shared.ts'
export { clearWeixinQuotes, weixinAccountKey } from './weixin-quotes.ts'
export { cancelWeixinAck, clearWeixinAcks, scheduleWeixinAck } from './weixin-ack.ts'
export { STALE_TOKEN_ERRCODE, getUpdates, sendItem, parseWeixinJson, sendText, uploadMedia } from './weixin-api.ts'
export type { WeixinUpload } from './weixin-api.ts'
export { extractWeixinMedia, sendWeixinReply } from './weixin-outbound.ts'
export { plainWeixinText, splitWeixinText } from './weixin-text.ts'
export type { WeixinCredentials, WeixinMessage } from './weixin-api.ts'

/** Opaque long-poll cursor, per account, so a token or account change starts from a fresh gateway buffer. */
export const UPDATES_BUF = family<string, [account: string]>('weixin-updates-buf:')
/** The latest `context_token` per person, required when replying after a restart. */
export const CONTEXT_TOKEN = family<string, [user: string]>('weixin-context-token:')

const Text = 1
const Image = 2
const Voice = 3
const File = 4
const Video = 5
const BotMessage = 2

export const WeixinConfigSchema = z.object({
  /** Credential JSON written by `scripts/weixin-login.mjs`; a relative path is under the Superagent state directory. */
  accountFile: z.string().trim().max(1024).default(''),
  /** Bot token, used when `accountFile` is empty; stored in the 0600 Superagent state database. */
  token: z.string().max(4096).default(''),
  /** Gateway base URL; the public iLink gateway unless a redirect or private deployment says otherwise. */
  baseUrl: z.url().default(DEFAULT_BASE_URL),
  /** Account label used for the poll cursor and shown in health; the login file supplies it when omitted. */
  accountId: z.string().trim().max(128).default(''),
  /** Server-side long-poll hold; the gateway may suggest a different value. */
  pollTimeoutSeconds: z.number().int().min(5).max(120).default(35),
  /** Seconds before a slow reply sends one "received, working" text; 0 disables it. */
  ackDelaySeconds: z.number().int().min(0).max(60).default(4),
}).strict()
export type WeixinConfig = z.infer<typeof WeixinConfigSchema>

const AllowedSchema = z.object({
  allowed: z.array(z.object({
    id: z.string().trim().min(1).max(128),
    name: z.string().trim().max(100).optional(),
  }).strict()).default([]),
}).strict()

const policy: SourcePolicyPart<z.infer<typeof AllowedSchema>> = {
  schema: AllowedSchema,
  fields: [{
    key: 'allowed', type: 'rows', label: { zh: '允许派活的微信用户', en: 'Weixin users allowed to ask' },
    hint: {
      zh: '只有名单里的微信用户能给这个个人号发消息派活。个人微信只接收单聊消息。',
      en: 'Only Weixin users on this list may ask this personal account for work. Personal WeChat delivers direct messages only.',
    },
    columns: [
      { key: 'id', type: 'text', label: { zh: '微信用户 id', en: 'Weixin user id' } },
      { key: 'name', type: 'text', optional: true, label: { zh: '备注名', en: 'Display name' } },
    ],
  }],
  explicit: {
    zh: '名单里的微信用户给这个个人号发单聊消息。',
    en: 'A Weixin user on the list sends this personal account a direct message.',
  },
  rows: () => [{
    id: 'direct', label: { zh: '单聊', en: 'Direct message' },
    note: { zh: '个人微信只收单聊', en: 'Personal WeChat receives direct messages only' },
    cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false },
  }],
}

const variables: readonly VariableSpec[] = [
  { key: 'DSH_SUPERAGENT_WEIXIN_CHAT', description: { zh: '触发工单的微信用户 id；不是来自个人微信时为空', en: 'The Weixin user that started the ticket; empty when the ticket did not start on personal WeChat' } },
  { key: 'DSH_SUPERAGENT_WEIXIN_ACCOUNT', description: { zh: '触发工单的微信用户 id', en: 'The Weixin user that started the ticket' } },
]

interface Parts { text?: string; refs: WeixinMediaRef[] }

function mediaRef(item: { media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string } }, kind: WeixinMediaRef['kind'],
  index: number, markerLabel?: string): WeixinMediaRef {
  const key = kind === 'image' ? `img_weixin_${index}` : `${kind}_weixin_${index}`
  const marker = `${markerLabel ?? (kind === 'image' ? '[图片]' : kind === 'video' ? '[视频]' : '[文件]')} ${key}`
  return {
    key, marker, kind, query: item.media?.encrypt_query_param ?? '',
    ...item.media?.full_url ? { url: item.media.full_url } : {},
    ...item.media?.aes_key ? { aeskey: item.media.aes_key, keyEncoding: 'base64' as const } : {},
  }
}

function imageRef(item: { media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string }; aeskey?: string; url?: string },
  index: number, markerLabel?: string): WeixinMediaRef {
  const ref = mediaRef(item, 'image', index, markerLabel)
  const withUrl = !ref.url && item.url ? { ...ref, url: item.url } : ref
  if (item.aeskey) return { ...withUrl, aeskey: item.aeskey, keyEncoding: 'hex' }
  return withUrl
}

function itemText(item: NonNullable<WeixinMessage['item_list']>[number]): string | undefined {
  if (item.type === Text) return item.text_item?.text?.trim() || undefined
  if (item.type === Voice) return item.voice_item?.text?.trim() || '[语音消息，微信未提供转写文本]'
  return undefined
}

function quotedParts(item: NonNullable<WeixinMessage['item_list']>[number], refs: WeixinMediaRef[],
  account: string, chat: string): string | undefined {
  const ref = item.ref_msg
  if (!ref) return undefined
  const pieces: string[] = []
  const title = ref.title?.trim()
  if (title) pieces.push(title)
  const quoted = ref.message_item
  if (quoted) {
    const text = itemText(quoted)
    if (text) pieces.push(text)
    if (quoted.image_item) {
      const media = imageRef(quoted.image_item, refs.length, '[引用图片]')
      if (media.query || media.url) { refs.push(media); pieces.push(media.marker) }
    } else if (quoted.file_item?.media) {
      const media = mediaRef({ media: quoted.file_item.media }, 'file', refs.length, '[引用文件]')
      refs.push(media); pieces.push(media.marker)
    } else if (quoted.video_item?.media) {
      const media = mediaRef({ media: quoted.video_item.media }, 'video', refs.length, '[引用视频]')
      refs.push(media); pieces.push(media.marker)
    }
  }
  if (!pieces.length && ref.svr_id) {
    const cached = recallQuote(account, chat, ref.svr_id)
    pieces.push(cached ?? '[引用消息内容未缓存]')
  }
  return pieces.length ? `[引用] ${pieces.join(' | ')}` : undefined
}

/** Renders the readable text of one message and collects its downloadable media in order. */
export function weixinMessageParts(message: WeixinMessage, account = '', chat = ''): Parts {
  const refs: WeixinMediaRef[] = []
  const lines: string[] = []
  for (const item of message.item_list ?? []) {
    const quote = quotedParts(item, refs, account, chat)
    if (quote) lines.push(quote)
    const text = itemText(item)
    if (text) { lines.push(text); continue }
    if (item.type === Image) {
      const media = imageRef(item.image_item ?? {}, refs.length)
      refs.push(media); lines.push(media.marker)
    } else if (item.type === File && item.file_item) {
      const media = { ...mediaRef(item.file_item, 'file', refs.length), ...item.file_item.file_name ? { name: item.file_item.file_name } : {} }
      refs.push(media); lines.push(media.marker)
    } else if (item.type === Video) {
      const media = mediaRef(item.video_item ?? {}, 'video', refs.length)
      refs.push(media); lines.push(media.marker)
    }
  }
  return { text: lines.length ? lines.join('\n') : undefined, refs }
}

function messageId(message: WeixinMessage): string | undefined {
  return message.message_id?.trim() || message.item_list?.find(item => item.msg_id?.trim())?.msg_id?.trim() || undefined
}

function messageTime(message: WeixinMessage): string {
  const millis = message.create_time_ms
  return millis && Number.isFinite(millis) ? new Date(millis).toISOString() : new Date().toISOString()
}

/**
 * Maps one `getupdates` message to a Trigger. The Thread is the conversation, not
 * the message, so later messages from the same person reach the Ticket already
 * open there. Bot messages and empty payloads produce no Trigger.
 */
export function weixinTrigger(message: WeixinMessage, account = ''): Trigger | undefined {
  const id = messageId(message)
  const userId = message.from_user_id?.trim()
  if (!id || !userId || message.message_type === BotMessage) return undefined
  const parts = weixinMessageParts(message, account, userId)
  if (!parts.text) return undefined
  rememberQuote(account, userId, id, parts.text)
  return {
    id: weixinTriggerId(id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: weixinThreadId(userId) }],
    actor: { source: SOURCE, id: userId },
    human: true,
    addressed: 'direct',
    at: messageTime(message),
    text: parts.text,
    channel: {
      source: SOURCE,
      thread: `${SOURCE}:${weixinThreadId(userId)}`,
      address: {
        userId, msgId: id, accountId: account,
        ...message.context_token ? { contextToken: message.context_token } : {},
      },
    },
    meta: {
      userId, msgId: id, accountId: account,
      ...message.context_token ? { contextToken: message.context_token } : {},
      ...parts.refs.length ? { media: parts.refs } : {},
    },
  }
}

const threadContext: ThreadContext<WeixinConfig> = {
  messageId: trigger => String(trigger.meta.msgId ?? ''),
  async read(_commands, trigger, _part, cursor): Promise<ContextPart> {
    if (cursor !== undefined) return { messages: [], body: { messages: [] } }
    const message = { id: String(trigger.meta.msgId ?? ''), from: trigger.actor.id, at: trigger.at, text: trigger.text }
    return { messages: [message], body: { messages: [message] } }
  },
  images: weixinImageKeys,
  image: (agent, _commands, trigger, message, key, stateDir, signal) =>
    readWeixinImage(agent, stateDir, trigger, message, key, signal),
}

/** Credentials of the running watcher, used by `channel.send` after the outbox releases a reply. */
let active: WeixinCredentials | undefined
export function setWeixinSession(credentials: WeixinCredentials | undefined): void { active = credentials }

const channel: SourceChannel<WeixinConfig> = {
  async send(_host, message: OutboundMessage) {
    if (!active) throw new Error('The Weixin Source is not connected')
    const { userId, contextToken } = message.channel.address
    if (!userId) return 'gone'
    cancelWeixinAck(`${weixinAccountKey(active)}:${userId}`)
    return sendWeixinReply(active, {
      messageId: message.id, to: userId, text: message.text,
      ...contextToken ? { contextToken } : {},
    })
  },
  link(address: Record<string, string>): ChannelLink {
    return {
      url: '', label: { zh: '微信消息', en: 'Weixin message' },
      ...address.msgId ? { triggerId: weixinTriggerId(address.msgId) } : {},
    }
  },
}

/** Resolves credentials from the Source token or its login file; undefined when neither has a token. */
export function weixinCredentials(config: WeixinConfig, stateDir: string): WeixinCredentials | undefined {
  let file: z.infer<typeof WeixinAccountFileSchema> | undefined
  if (config.accountFile) {
    const path = isAbsolute(config.accountFile) ? config.accountFile : join(stateDir, config.accountFile)
    file = WeixinAccountFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  }
  const token = (file?.token ?? config.token).trim()
  if (!token) return undefined
  const base = (file?.baseUrl?.trim() || config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  return {
    token,
    baseUrl: /^https?:\/\//.test(base) ? base : `https://${base}`,
    ...config.accountId || file?.accountId ? { accountId: config.accountId || file?.accountId } : {},
  }
}

export async function pollWeixinOnce(ctx: PollContext, credentials: WeixinCredentials, config: WeixinConfig,
  signal: AbortSignal, timeoutMs = config.pollTimeoutSeconds * 1000): Promise<{ received: number; timeoutMs?: number }> {
  const account = weixinAccountKey(credentials)
  const buffer = ctx.state.get(UPDATES_BUF(account)) ?? ''
  const response = await getUpdates(credentials, buffer, signal, timeoutMs)
  if (response.errcode === STALE_TOKEN_ERRCODE || response.ret === STALE_TOKEN_ERRCODE) {
    throw new StaleTokenError()
  }
  if (response.ret !== undefined && response.ret !== 0) throw new Error(`getupdates ret=${response.ret} ${response.errmsg ?? ''}`.trim())
  if (response.errcode !== undefined && response.errcode !== 0) throw new Error(`getupdates errcode=${response.errcode} ${response.errmsg ?? ''}`.trim())
  let received = 0
  for (const message of response.msgs ?? []) {
    const trigger = weixinTrigger(message, account)
    if (!trigger) continue
    if (message.context_token) ctx.state.set(CONTEXT_TOKEN(trigger.actor.id), message.context_token)
    await prepareWeixinMedia(ctx, trigger, signal)
    if (signal.aborted) return { received }
    // Schedule before receive: receive can wait for an Eval, and the person should hear something meanwhile.
    if (config.ackDelaySeconds > 0) scheduleWeixinAck(`${account}:${trigger.actor.id}`, () => sendText(credentials, {
      to: trigger.actor.id, text: '收到，正在处理…', ...message.context_token ? { contextToken: message.context_token } : {},
    }), config.ackDelaySeconds * 1000)
    await ctx.receive(trigger)
    received += 1
  }
  // Advance only after every message is ingested; a failed receive is redelivered by the gateway.
  if (response.get_updates_buf && response.get_updates_buf !== buffer) ctx.state.set(UPDATES_BUF(account), response.get_updates_buf)
  return { received, ...response.longpolling_timeout_ms ? { timeoutMs: response.longpolling_timeout_ms } : {} }
}

/** The parts of `SourceContext` one poll writes: cursor, context tokens and Triggers. */
export type PollContext = Pick<SourceContext, 'state' | 'receive' | 'deployment'>

/** A stale token needs a new QR login; the watcher stops polling and says so instead of hammering the gateway. */
class StaleTokenError extends Error {
  constructor() { super('The Weixin login expired; run scripts/weixin-login.mjs to connect again') }
}

/**
 * Long-polls the gateway until aborted. The token, base URL and account label are
 * reread each turn, so replacing the login file takes effect without a restart.
 */
export async function watchWeixin(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  let suggested: number | undefined
  let configuredTimeout: number | undefined
  await ctx.ready
  if (!ctx.configured()) {
    ctx.report('weixin', health('paused', 'setupPending'))
    return
  }
  try {
    while (!signal.aborted) {
      const config = ctx.config<WeixinConfig>(SOURCE)
      if (config === undefined) {
        setWeixinSession(undefined)
        ctx.report('weixin', health('paused', 'sourceOff'))
        failures = 0
        await pause(3_000, signal)
        continue
      }
      let credentials: WeixinCredentials | undefined
      try { credentials = weixinCredentials(config, ctx.deployment.stateDir) }
      catch (error) {
        ctx.report('weixin', { state: 'error', detail: `Could not read the Weixin login file: ${String(error)}` })
        await pause(30_000, signal)
        continue
      }
      if (!credentials) {
        setWeixinSession(undefined)
        ctx.report('weixin', { state: 'paused', detail: 'The Weixin token is not set; run `node scripts/weixin-login.mjs` and point the Source at its file' })
        await pause(5_000, signal)
        continue
      }
      setWeixinSession(credentials)
      if (config.pollTimeoutSeconds !== configuredTimeout) { configuredTimeout = config.pollTimeoutSeconds; suggested = undefined }
      try {
        const result = await pollWeixinOnce(ctx, credentials, config, signal, suggested)
        if (result.timeoutMs && result.timeoutMs >= 5_000 && result.timeoutMs <= 120_000) suggested = result.timeoutMs
        failures = 0
        const label = credentials.accountId ?? weixinAccountKey(credentials).slice(0, 8)
        ctx.report('weixin', { state: 'ready', detail: `Connected to Weixin as ${label}${result.received ? `; received ${result.received} message(s)` : ''}` })
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof StaleTokenError) {
          ctx.report('weixin', { state: 'error', detail: error.message })
          await pause(60_000, signal)
          continue
        }
        failures += 1
        const failed: Health = health('starting', 'pollFailures', { count: String(failures), error: String(error) })
        ctx.report('weixin', failures >= 3 ? { ...failed, state: 'error' } : failed)
        await pause(failures >= 3 ? 30_000 : 2_000, signal)
      }
    }
  } finally {
    clearWeixinAcks()
    setWeixinSession(undefined)
  }
}

export const weixinKind: SourceKind<WeixinConfig> = {
  kind: SOURCE,
  title: { zh: '个人微信', en: 'Personal WeChat' },
  description: {
    zh: '通过个人微信扫码登录，接收单聊消息并回复。使用与 @tencent-weixin/openclaw-weixin 相同的 iLink 网关协议，不依赖 OpenClaw 网关进程。',
    en: 'Connects a personal WeChat account by QR login, receives direct messages and replies. It speaks the same iLink gateway protocol as @tencent-weixin/openclaw-weixin and does not require the OpenClaw gateway.',
  },
  schema: WeixinConfigSchema,
  fields: [
    {
      key: 'accountFile', type: 'text', label: { zh: '登录凭证文件', en: 'Login file' },
      hint: {
        zh: '运行 `node scripts/weixin-login.mjs` 扫码后写出的 JSON 文件路径；相对路径在 Superagent 状态目录下。填写后优先于下面的 token。',
        en: 'Path to the JSON file written after running `node scripts/weixin-login.mjs`; a relative path is under the Superagent state directory. It takes precedence over the token field.',
      },
    },
    {
      key: 'token', type: 'text', label: { zh: 'Bot token', en: 'Bot token' },
      hint: {
        zh: '也可以直接粘贴登录脚本输出的 token；保存在本机 0600 的状态数据库中，不要写进仓库或聊天记录。',
        en: 'Alternatively paste the token printed by the login script; it is stored in the local 0600 state database, never commit or chat it.',
      },
    },
    {
      key: 'accountId', type: 'text', advanced: true, label: { zh: '账号标识', en: 'Account label' },
      hint: { zh: '用于区分轮询游标和健康信息；登录文件里有账号 id 时可留空。', en: 'Distinguishes poll cursors and health; leave empty when the login file carries an account id.' },
    },
    {
      key: 'baseUrl', type: 'text', advanced: true, label: { zh: '网关地址', en: 'Gateway URL' },
      hint: { zh: '默认 https://ilinkai.weixin.qq.com；扫码后若发生 IDC 重定向，登录文件会记录新的地址。', en: 'Defaults to https://ilinkai.weixin.qq.com; the login file records a redirected address when the gateway moves the account.' },
    },
    {
      key: 'pollTimeoutSeconds', type: 'number', advanced: true, min: 5, max: 120,
      label: { zh: '长轮询超时 / 秒', en: 'Long-poll timeout / seconds' },
      hint: { zh: '网关可以建议更合适的值；默认 35 秒。', en: 'The gateway may suggest a better value; defaults to 35 seconds.' },
    },
    {
      key: 'ackDelaySeconds', type: 'number', advanced: true, min: 0, max: 60,
      label: { zh: '慢回复回执 / 秒', en: 'Slow-reply acknowledgement / seconds' },
      hint: { zh: '超过这个时间还没有回复时，先发一条“收到，正在处理…”；0 关闭。', en: 'Send one “received, working” text when no reply has gone out after this delay; 0 disables it.' },
    },
  ],
  health: ['weixin'],
  scope: () => ({ listened: true, observed: false, row: 'direct' }),
  channel,
  threadContext,
  policy,
  environment: {
    variables,
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_WEIXIN_CHAT: trigger?.source === SOURCE ? String(trigger.meta.userId ?? trigger.actor.id) : '',
      DSH_SUPERAGENT_WEIXIN_ACCOUNT: trigger?.source === SOURCE ? trigger.actor.id : '',
    }),
  },
}
