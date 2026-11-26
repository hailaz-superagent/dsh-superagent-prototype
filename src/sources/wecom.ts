/**
 * WeCom (企业微信) AI Bot Source.
 *
 * `mode: 'bridge'` reads the optional loopback wecombridge; `mode: 'live'` holds the
 * official AI Bot SDK WebSocket long connection in this process. Both transports feed
 * the same Trigger, Policy and Channel code.
 */
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import { record } from '../kv.ts'
import { pause } from './poll.ts'
import { health, type Health, type SourceContext } from './host.ts'
import { LIVE_TRANSPORT, sendLiveReply, startLive, type LiveCredentials, type LiveRun } from './wecom-live.ts'
import { SOURCE, wecomTriggerId } from './wecom-shared.ts'
import type { ChannelLink, ContextPart, SourceChannel, SourceKind, SourcePolicyPart, ThreadContext, VariableSpec } from './kind.ts'

export { SOURCE, wecomTriggerId } from './wecom-shared.ts'
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3099'
/** Cursor is the last bridge sequence number delivered or safely skipped. */
export const CURSOR = record<number>('wecom-cursor')

const BridgeEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  id: z.string().min(1),
  reqId: z.string().min(1),
  chatId: z.string(),
  chatType: z.enum(['single', 'group']),
  fromUserId: z.string().min(1),
  text: z.string().min(1),
  at: z.string().min(1),
  addressed: z.enum(['mention', 'direct']),
}).strict()
export type BridgeEvent = z.infer<typeof BridgeEventSchema>

const BridgeEventsSchema = z.object({
  events: z.array(BridgeEventSchema),
  next: z.number().int().nonnegative(),
}).strict()
export type BridgeEvents = z.infer<typeof BridgeEventsSchema>

const BridgeHealthSchema = z.object({ connected: z.boolean() }).loose()
export type BridgeHealth = z.infer<typeof BridgeHealthSchema>

export const WecomConfigSchema = z.object({
  /** Where messages arrive: the optional loopback bridge or the in-process AI Bot long connection. */
  mode: z.enum(['bridge', 'live']).default('bridge'),
  bridgeUrl: z.url().default(DEFAULT_BRIDGE_URL),
  pollSeconds: z.number().int().min(2).max(60).default(3),
  directMessages: z.boolean().default(true),
  /** AI Bot credentials used only by `mode: 'live'`; stored in the 0600 Superagent state database. */
  botId: z.string().trim().max(128).default(''),
  secret: z.string().max(256).default(''),
  /** Private-deployment long-connection address; empty uses the SDK's public default. */
  wsUrl: z.url().or(z.literal('')).default(''),
}).strict()
export type WecomConfig = z.infer<typeof WecomConfigSchema>

const AllowedSchema = z.object({
  allowed: z.array(z.object({
    id: z.string().trim().min(1).max(64),
    name: z.string().trim().max(100).optional(),
  }).strict()).default([]),
}).strict()

const policy: SourcePolicyPart<z.infer<typeof AllowedSchema>> = {
  schema: AllowedSchema,
  fields: [{
    key: 'allowed', type: 'rows', label: { zh: '允许派活的企微 userid', en: 'WeCom userids allowed to ask' },
    hint: {
      zh: '只有名单里的 userid 能通过企业微信发起工作。群里必须 @ 机器人；单聊按 Source 配置决定是否接收。',
      en: 'Only userids on this list may originate work through WeCom. Group messages must mention the bot; direct messages follow the Source configuration.',
    },
    columns: [
      { key: 'id', type: 'text', label: { zh: 'userid', en: 'Userid' } },
      { key: 'name', type: 'text', optional: true, label: { zh: '备注名', en: 'Display name' } },
    ],
  }],
  explicit: {
    zh: '名单里的企微 userid 在群里 @ 机器人，或给机器人发单聊消息。',
    en: 'A WeCom userid on the list mentions the bot in a group, or messages it directly.',
  },
  rows: () => [
    {
      id: 'group', label: { zh: '群聊 @', en: 'Group @' },
      note: { zh: '仅 @ 机器人', en: '@ only' },
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false },
    },
    {
      id: 'direct', label: { zh: '单聊', en: 'Direct message' },
      note: { zh: '接收单聊', en: 'Direct messages received' },
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false },
    },
  ],
}

const variables: readonly VariableSpec[] = [
  { key: 'DSH_SUPERAGENT_WECOM_CHAT', description: { zh: '触发工单的企微会话 ID；不是来自企业微信时为空', en: 'The WeCom chat that started the ticket; empty when the ticket did not start on WeCom' } },
  { key: 'DSH_SUPERAGENT_WECOM_ACCOUNT', description: { zh: '触发工单的企微 userid', en: 'The WeCom userid that started the ticket' } },
]

/** Maps one bridge event to a Trigger. The thread is the message itself in the bridge MVP. */
export function wecomTrigger(event: BridgeEvent, bridgeUrl = DEFAULT_BRIDGE_URL): Trigger {
  const chat = event.chatId || event.fromUserId
  const channel = {
    source: SOURCE,
    thread: `wecom:${chat}`,
    address: {
      bridgeUrl, chatId: event.chatId, reqId: event.reqId, msgId: event.id, chatType: event.chatType,
    },
  }
  return {
    id: wecomTriggerId(event.id),
    source: SOURCE,
    threads: [{ source: SOURCE, id: event.id }],
    actor: { source: SOURCE, id: event.fromUserId },
    human: true,
    addressed: event.addressed,
    at: event.at,
    text: event.text,
    channel,
    meta: {
      chatId: event.chatId, reqId: event.reqId, msgId: event.id, chatType: event.chatType,
    },
  }
}

function chatType(meta: Record<string, unknown>): 'group' | 'direct' | undefined {
  if (meta.chatType === 'group') return 'group'
  if (meta.chatType === 'single') return 'direct'
  return undefined
}

const threadContext: ThreadContext<WecomConfig> = {
  messageId: trigger => String(trigger.meta.msgId ?? ''),
  async read(_commands, trigger, _part, cursor): Promise<ContextPart> {
    if (cursor !== undefined) return { messages: [], body: { messages: [] } }
    const message = { id: String(trigger.meta.msgId ?? ''), from: trigger.actor.id, at: trigger.at, text: trigger.text }
    return { messages: [message], body: { messages: [message] } }
  },
}

/** Posts a reply to the original WeCom request through the transport recorded in its address. */
async function sendWecom(message: Parameters<SourceChannel<WecomConfig>['send']>[1]): Promise<'sent' | 'gone'> {
  if (message.channel.address.transport === LIVE_TRANSPORT) return sendLiveReply(message)
  const { reqId, chatId, bridgeUrl } = message.channel.address
  if (!reqId) throw new Error('Missing WeCom reply reqId')
  const text = checkedImText(message.text)
  const response = await fetch(new URL('/reply', bridgeUrl || DEFAULT_BRIDGE_URL), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ reqId, chatId: chatId ?? '', text }),
    signal: AbortSignal.timeout(20_000),
  })
  if (response.status === 404 || response.status === 410) return 'gone'
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`WeCom bridge reply failed with HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
  }
  return 'sent'
}

const channel: SourceChannel<WecomConfig> = {
  allowed(address, config) {
    return address.chatType !== 'direct' || config.directMessages
  },
  async send(_host, message) {
    return sendWecom(message)
  },
  link(address: Record<string, string>): ChannelLink {
    return {
      url: '', label: { zh: '企业微信消息', en: 'WeCom message' },
      ...address.msgId ? { triggerId: wecomTriggerId(address.msgId) } : {},
    }
  },
}

export const wecomKind: SourceKind<WecomConfig> = {
  kind: SOURCE,
  title: { zh: '企业微信', en: 'WeCom' },
  description: {
    zh: '接收群聊中 @ 智能机器人的消息和机器人单聊消息。可用官方 AI Bot SDK 长连接直连，也可通过本机 wecombridge 轮询。',
    en: 'Receives group @-mentions and direct messages to the AI Bot, either through the official AI Bot SDK long connection or through the local wecombridge poller.',
  },
  schema: WecomConfigSchema,
  fields: [
    {
      key: 'mode', type: 'select',
      options: [
        { value: 'bridge', label: { zh: '本机 bridge 轮询', en: 'Local bridge polling' } },
        { value: 'live', label: { zh: 'AI Bot 长连接（推荐）', en: 'AI Bot long connection (recommended)' } },
      ],
      label: { zh: '接入方式', en: 'Transport' },
      hint: {
        zh: '长连接由 dsh-superagent 进程直接连企业微信，无需 bridge、轮询或公网回调；切换前必须先停止占用的 wecombridge，同一个机器人只能有一条长连接。',
        en: 'The long connection is held by dsh-superagent itself: no bridge, polling or public callback. Stop any running wecombridge first; one bot supports only one connection.',
      },
    },
    {
      key: 'botId', type: 'text', label: { zh: '机器人 BotID', en: 'Bot ID' },
      hint: {
        zh: '企业微信智能机器人的 BotID，仅长连接方式使用。Secret 保存在本机 0600 的 Superagent 状态库中，不要写进仓库或聊天记录。',
        en: 'Bot ID of the WeCom AI Bot, used by the long connection only. The secret is stored in the local 0600 Superagent state database; never commit or paste it.',
      },
    },
    {
      key: 'secret', type: 'text', label: { zh: '机器人 Secret', en: 'Bot secret' },
      hint: {
        zh: '企业微信智能机器人的 Secret，仅长连接方式使用。留空表示不连接；修改后最长约 3 秒生效。',
        en: 'Secret of the WeCom AI Bot, used by the long connection only. Empty means no connection; a change takes effect within about 3 seconds.',
      },
    },
    {
      key: 'wsUrl', type: 'text', advanced: true, label: { zh: '长连接地址', en: 'Long-connection URL' },
      hint: {
        zh: '私有部署企业的长连接地址；留空使用 wss://openws.work.weixin.qq.com。',
        en: 'Long-connection address for a private deployment; empty uses wss://openws.work.weixin.qq.com.',
      },
    },
    {
      key: 'bridgeUrl', type: 'text', advanced: true, label: { zh: 'Bridge 地址', en: 'Bridge URL' },
      hint: {
        zh: '本机 wecombridge 的 HTTP 地址；默认 http://127.0.0.1:3099，仅监听回环地址，仅 bridge 方式使用。',
        en: 'HTTP address of the local wecombridge; defaults to http://127.0.0.1:3099 and listens on loopback only. Used by the bridge transport.',
      },
    },
    {
      key: 'pollSeconds', type: 'number', advanced: true, min: 2, max: 60,
      label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: '轮询 wecombridge 的间隔；默认 3 秒，仅 bridge 方式使用。', en: 'How often to poll wecombridge; defaults to 3 seconds. Used by the bridge transport.' },
    },
    {
      key: 'directMessages', type: 'switch',
      label: { zh: '接收单聊', en: 'Receive direct messages' },
      hint: { zh: '关闭后只接收群里 @ 机器人的消息。', en: 'When off, only group @-mentions are received.' },
    },
  ],
  health: ['wecom'],
  scope({ meta }, config) {
    const type = chatType(meta)
    if (type === 'group') return { listened: true, observed: false, row: 'group' }
    if (type === 'direct') return config.directMessages
      ? { listened: true, observed: false, row: 'direct' }
      : { listened: false, reason: 'wecom_direct_messages_off' }
    return { listened: false, reason: 'wecom_unsupported_chat' }
  },
  channel,
  threadContext,
  policy,
  environment: {
    variables,
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_WECOM_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '',
      DSH_SUPERAGENT_WECOM_ACCOUNT: trigger?.source === SOURCE ? trigger.actor.id : '',
    }),
  },
}

/** Reads the bridge health document, validating only the field this Source uses. */
export async function readBridgeHealth(bridgeUrl: string, signal?: AbortSignal): Promise<BridgeHealth> {
  const response = await fetch(new URL('/health', bridgeUrl), { signal, headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`WeCom bridge /health returned HTTP ${response.status}`)
  return BridgeHealthSchema.parse(await response.json())
}

/** Reads one page of bridge events and validates its complete shape. */
export async function readBridgeEvents(bridgeUrl: string, after: number, signal?: AbortSignal): Promise<BridgeEvents> {
  const url = new URL('/events', bridgeUrl)
  url.searchParams.set('after', String(after))
  const response = await fetch(url, { signal, headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`WeCom bridge /events returned HTTP ${response.status}`)
  return BridgeEventsSchema.parse(await response.json())
}

/** One poll: validate the bridge, ingest every new event, then advance the cursor once. */
export async function pollWecomOnce(ctx: Pick<SourceContext, 'state' | 'receive'>, config: WecomConfig,
  signal?: AbortSignal): Promise<{ connected: boolean; received: number }> {
  const after = ctx.state.get(CURSOR) ?? 0
  const [bridge, page] = await Promise.all([
    readBridgeHealth(config.bridgeUrl, signal),
    readBridgeEvents(config.bridgeUrl, after, signal),
  ])
  if (page.next < after) throw new Error(`WeCom bridge cursor moved backwards: ${after} -> ${page.next}`)
  let received = 0
  for (const event of page.events) {
    if (event.seq <= after) continue
    await ctx.receive(wecomTrigger(event, config.bridgeUrl))
    received += 1
  }
  if (page.next !== after) ctx.state.set(CURSOR, page.next)
  return { connected: bridge.connected, received }
}

const sameLive = (credentials: LiveCredentials, config: WecomConfig): boolean =>
  credentials.botId === config.botId && credentials.secret === config.secret && credentials.wsUrl === config.wsUrl

/**
 * Runs the configured transport until aborted.
 *
 * Bridge mode polls each tick; live mode keeps the SDK connection open and only
 * checks the settings, so a mode or credential change reconnects within a tick.
 */
export async function watchWecom(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  let live: LiveRun | undefined
  const stopLive = async (): Promise<void> => {
    const running = live
    live = undefined
    await running?.stop()
  }
  await ctx.ready
  // Setup restarts Superagent once accounts resolve; until then no Source transport runs.
  if (!ctx.configured()) {
    ctx.report('wecom', health('paused', 'setupPending'))
    return
  }
  try {
    while (!signal.aborted) {
      const config = ctx.config<WecomConfig>(SOURCE)
      if (config === undefined) {
        await stopLive()
        ctx.report('wecom', health('paused', 'sourceOff'))
        failures = 0
      } else if (config.mode === 'live') {
        if (!live || !sameLive(live.credentials, config)) {
          await stopLive()
          live = startLive(ctx, config, signal)
        }
      } else {
        await stopLive()
        try {
          const result = await pollWecomOnce(ctx, config, signal)
          failures = 0
          ctx.report('wecom', result.connected
            ? { state: 'ready', detail: 'Connected to the WeCom bridge' }
            : { state: 'starting', detail: 'Waiting for the WeCom bot connection' })
        } catch (error) {
          failures += 1
          const failed: Health = health('starting', 'pollFailures', { count: String(failures), error: String(error) })
          if (!signal.aborted) ctx.report('wecom', failures >= 3 ? { ...failed, state: 'error' } : failed)
        }
      }
      await pause((config?.pollSeconds ?? 3) * 1000, signal)
    }
  } finally {
    await stopLive()
  }
}
