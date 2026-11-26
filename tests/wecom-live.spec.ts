/** WeCom long connection: Trigger mapping, reply routing, runner lifecycle, and the real SDK adapter. */
import { WebSocketServer, type WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import type { Health } from '../src/sources/host.ts'
import type { OutboundMessage, Trigger } from '../src/core/index.ts'
import type { WecomConfig } from '../src/sources/wecom.ts'
import { WecomConfigSchema } from '../src/sources/wecom.ts'
import {
  LIVE_TRANSPORT, liveMessageText, liveTrigger, sendLiveReply, setLiveBot, sdkLiveBot, startLive,
  type LiveBot, type LiveFrame,
} from '../src/sources/wecom-live.ts'
import { SOURCE, wecomTriggerId } from '../src/sources/wecom-shared.ts'
import { testDeployment } from './fixtures/deployment.ts'

const NOW = 1_764_220_800 // 2026-11-26T08:00:00Z in seconds
const MESSAGE = {
  msgid: 'msg-1', aibotid: 'bot-1', chatid: 'group-1', chattype: 'group' as const,
  from: { userid: 'alice' }, create_time: NOW, msgtype: 'text', text: { content: '修复这个 bug' },
}
const FRAME: LiveFrame = { headers: { req_id: 'req-1' }, body: MESSAGE }
const CONFIG: WecomConfig = WecomConfigSchema.parse({ mode: 'live', botId: 'bot-1', secret: 'secret-1' })

const servers: WebSocketServer[] = []
afterEach(async () => {
  setLiveBot(undefined)
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    for (const client of server.clients) client.terminate()
    server.close(() => resolve())
  })))
})

interface FakeBot extends LiveBot {
  readonly replies: { requestId: string; body: Record<string, unknown> }[]
  readonly sends: { chatId: string; body: Record<string, unknown> }[]
  readonly state: { connected: boolean; connects: number; disconnects: number }
  authenticated(): void
  disconnected(reason?: string): void
  failed(error: unknown): void
  message(frame: LiveFrame): void
}

function fakeBot(): FakeBot {
  let onAuthenticated: (() => void) | undefined
  let onDisconnected: ((reason: string) => void) | undefined
  let onError: ((error: unknown) => void) | undefined
  let onMessage: ((frame: LiveFrame) => void) | undefined
  const state = { connected: false, connects: 0, disconnects: 0 }
  const replies: { requestId: string; body: Record<string, unknown> }[] = []
  const sends: { chatId: string; body: Record<string, unknown> }[] = []
  return {
    get connected() { return state.connected },
    state, replies, sends,
    onAuthenticated(handler) { onAuthenticated = handler },
    onDisconnected(handler) { onDisconnected = handler },
    onError(handler) { onError = handler },
    onMessage(handler) { onMessage = handler },
    connect() { state.connects += 1; state.connected = true },
    disconnect() { state.disconnects += 1; state.connected = false },
    async reply(requestId, body) { replies.push({ requestId, body }) },
    async sendMessage(chatId, body) { sends.push({ chatId, body }) },
    authenticated() { onAuthenticated?.() },
    disconnected(reason = 'network') { state.connected = false; onDisconnected?.(reason) },
    failed(error) { onError?.(error) },
    message(frame) { onMessage?.(frame) },
  }
}

function context(config: WecomConfig = CONFIG): {
  ctx: Parameters<typeof startLive>[0]
  received: Trigger[]
  reports: Health[]
} {
  const received: Trigger[] = []
  const reports: Health[] = []
  const ctx = {
    deployment: testDeployment(),
    commands: {},
    ready: Promise.resolve(),
    configured: () => true,
    config: (kind: string) => kind === SOURCE ? config : undefined,
    receive: async (trigger: Trigger) => { received.push(trigger); return {} as never },
    atomic: <T>(work: () => T): T => work(),
    state: { get: () => undefined, set: () => {}, keys: () => [] },
    threads: { get: () => undefined, subscribed: () => [], describe: () => {}, patch: () => {} },
    tickets: { get: () => undefined, open: () => [], bindThread: () => {}, threadClosed: () => {} },
    triggers: { get: () => undefined, latest: () => undefined },
    notify: () => {},
    report: (_entry: string, value: Health) => { reports.push(value) },
  }
  return { ctx: ctx as never, received, reports }
}

const message = (overrides: Record<string, unknown> = {}): OutboundMessage => ({
  id: 'out-1', kind: 'reply', text: '收到，正在处理',
  channel: {
    source: SOURCE,
    thread: 'wecom:group:group-1',
    address: {
      transport: LIVE_TRANSPORT, chatId: 'group-1', userId: 'alice', reqId: 'req-1',
      msgId: 'msg-1', chatType: 'group',
    },
  },
  ...overrides,
})

describe('WeCom long-connection Trigger', () => {
  it('maps a group mention to the chat thread with a live channel address', () => {
    const trigger = liveTrigger(FRAME)!
    expect(trigger).toMatchObject({
      id: wecomTriggerId('msg-1'), source: SOURCE, human: true, addressed: 'mention',
      at: new Date(NOW * 1000).toISOString(), text: '修复这个 bug',
      actor: { source: SOURCE, id: 'alice' },
      threads: [{ source: SOURCE, id: 'group:group-1' }],
      channel: {
        source: SOURCE, thread: 'wecom:group:group-1',
        address: { transport: 'live', chatId: 'group-1', userId: 'alice', reqId: 'req-1', msgId: 'msg-1', chatType: 'group' },
      },
      meta: { chatId: 'group-1', userId: 'alice', reqId: 'req-1', msgId: 'msg-1', chatType: 'group', transport: 'live' },
    })
  })

  it('uses the sender for a direct chat without a chat id', () => {
    const trigger = liveTrigger({ headers: { req_id: 'req-2' }, body: {
      ...MESSAGE, msgid: 'msg-2', chatid: undefined, chattype: 'single', text: { content: '在吗' },
    } })!
    expect(trigger.addressed).toBe('direct')
    expect(trigger.threads).toEqual([{ source: SOURCE, id: 'direct:alice' }])
    expect(trigger.channel?.address).toMatchObject({ chatId: '', userId: 'alice', reqId: 'req-2', chatType: 'single' })
  })

  it('reads mixed text, voice transcription, and strips mention placeholders', () => {
    const mixed = liveTrigger({ headers: { req_id: 'req-3' }, body: {
      ...MESSAGE, msgid: 'msg-3', msgtype: 'mixed',
      mixed: { msg_item: [
        { msgtype: 'text', text: { content: '${inline_mention:ph_1}\u200b第一行' } },
        { msgtype: 'image', image: { url: 'https://example.invalid/a' } },
        { msgtype: 'text', text: { content: '第二行' } },
      ] },
    } })!
    expect(mixed.text).toBe('第一行\n第二行')
    expect(liveMessageText({
      msgid: 'v', chattype: 'single', from: { userid: 'alice' }, msgtype: 'voice', voice: { content: '语音转写' },
    })).toBe('语音转写')
    expect(liveMessageText({
      msgid: 'i', chattype: 'single', from: { userid: 'alice' }, msgtype: 'image', image: { url: 'x' },
    })).toBeUndefined()
    expect(liveTrigger({ headers: { req_id: 'req-4' }, body: { ...MESSAGE, msgtype: 'image', image: { url: 'x' } } }))
      .toBeUndefined()
  })

  it('refuses a malformed callback instead of creating a Trigger', () => {
    expect(liveTrigger({ headers: { req_id: 'req-5' }, body: { ...MESSAGE, msgid: '' } })).toBeUndefined()
    expect(liveTrigger({ headers: { req_id: 'req-6' }, body: { ...MESSAGE, text: { content: '   ' } } }))
      .toBeUndefined()
    expect(liveTrigger({ headers: { req_id: '' }, body: MESSAGE })).toBeUndefined()
  })
})

describe('WeCom long-connection replies', () => {
  it('answers a fresh callback passively and falls back to an active send later', async () => {
    const bot = fakeBot()
    const { ctx } = context()
    const controller = new AbortController()
    const run = startLive(ctx, CONFIG, controller.signal, () => bot)
    bot.authenticated()
    bot.message(FRAME)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await sendLiveReply(message())).toBe('sent')
    expect(bot.replies).toHaveLength(1)
    expect(bot.replies[0]).toEqual({ requestId: 'req-1', body: { msgtype: 'markdown', markdown: { content: '收到，正在处理' } } })
    expect(bot.sends).toHaveLength(0)

    const late = message({ id: 'out-2', channel: {
      source: SOURCE, thread: 'wecom:group:group-1',
      address: { transport: LIVE_TRANSPORT, chatId: 'group-1', userId: 'alice', reqId: 'req-old', msgId: 'msg-1', chatType: 'group' },
    } })
    expect(await sendLiveReply(late)).toBe('sent')
    expect(bot.sends).toHaveLength(1)
    expect(bot.sends[0]).toEqual({
      chatId: 'group-1', body: { msgtype: 'markdown', markdown: { content: '收到，正在处理' }, chat_type: 2 },
    })
    await run.stop()
  })

  it('uses the userid for an active direct send and reports a missing connection', async () => {
    const bot = fakeBot()
    startLive(context().ctx, CONFIG, new AbortController().signal, () => bot)
    const direct = message({ channel: {
      source: SOURCE, thread: 'wecom:direct:alice',
      address: { transport: LIVE_TRANSPORT, chatId: '', userId: 'alice', reqId: 'req-9', msgId: 'msg-9', chatType: 'single' },
    } })
    expect(await sendLiveReply(direct)).toBe('sent')
    expect(bot.sends[0]).toEqual({
      chatId: 'alice', body: { msgtype: 'markdown', markdown: { content: '收到，正在处理' }, chat_type: 1 },
    })

    setLiveBot(undefined)
    await expect(sendLiveReply(direct)).rejects.toThrow('not ready')
  })

  it('does not send a reply without a chat or user id', async () => {
    const bot = fakeBot()
    startLive(context().ctx, CONFIG, new AbortController().signal, () => bot)
    const nowhere = message({ channel: {
      source: SOURCE, thread: 'wecom:direct:alice',
      address: { transport: LIVE_TRANSPORT, chatId: '', userId: '', reqId: 'req-10', msgId: 'msg-10', chatType: 'single' },
    } })
    expect(await sendLiveReply(nowhere)).toBe('gone')
    expect(bot.sends).toHaveLength(0)
  })
})

describe('WeCom long-connection runner', () => {
  it('reports authentication, ingests messages once, and disconnects on stop', async () => {
    const bot = fakeBot()
    const { ctx, received, reports } = context()
    const controller = new AbortController()
    const run = startLive(ctx, CONFIG, controller.signal, () => bot)
    expect(bot.state.connects).toBe(1)
    expect(reports.at(-1)).toMatchObject({ state: 'starting' })
    bot.authenticated()
    expect(reports.at(-1)).toMatchObject({ state: 'ready' })
    bot.message(FRAME)
    bot.message(FRAME)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(received.map(trigger => trigger.id)).toEqual([wecomTriggerId('msg-1')])
    await run.stop()
    expect(bot.state.disconnects).toBe(1)
  })

  it('pauses without credentials and sends nothing', () => {
    const bot = fakeBot()
    const { ctx, reports } = context()
    startLive(ctx, WecomConfigSchema.parse({ mode: 'live' }), new AbortController().signal, () => bot)
    expect(bot.state.connects).toBe(0)
    expect(reports.at(-1)).toMatchObject({ state: 'paused' })
  })

  it('reports an SDK error as Source health', async () => {
    const bot = fakeBot()
    const { ctx, reports } = context()
    startLive(ctx, CONFIG, new AbortController().signal, () => bot)
    bot.failed(new Error('socket closed'))
    expect(reports.at(-1)).toMatchObject({ state: 'error' })
  })
})

/** Minimal WeCom long-connection peer for exercising the real SDK adapter. */
async function fakeWecom(): Promise<{
  url: string
  frames: Record<string, unknown>[]
  push(frame: unknown): void
  waitFor(predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>
  close(): Promise<void>
}> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(server)
  await new Promise<void>(resolve => server.once('listening', resolve))
  const sockets: WebSocket[] = []
  const frames: Record<string, unknown>[] = []
  server.on('connection', socket => {
    sockets.push(socket)
    socket.on('message', data => {
      const frame = JSON.parse(data.toString()) as Record<string, any>
      const respond = (body?: Record<string, unknown>): void => {
        socket.send(JSON.stringify({ errcode: 0, errmsg: 'ok', headers: { req_id: frame.headers.req_id }, ...(body ? { body } : {}) }))
      }
      if (frame.cmd === 'aibot_subscribe') { respond(); return }
      frames.push(frame)
      respond()
    })
  })
  return {
    url: `ws://127.0.0.1:${(server.address() as { port: number }).port}`,
    frames,
    push(frame) { sockets[0]?.send(JSON.stringify(frame)) },
    async waitFor(predicate) {
      const started = Date.now()
      for (;;) {
        const found = frames.find(predicate)
        if (found) return found
        if (Date.now() - started > 5000) throw new Error(`timed out waiting for frame: ${JSON.stringify(frames)}`)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    },
    close: () => new Promise(resolve => { for (const socket of sockets) socket.terminate(); server.close(() => resolve()) }),
  }
}

describe('WeCom SDK adapter', () => {
  it('authenticates over a real WebSocket, receives a message and delivers a passive reply', async () => {
    const fake = await fakeWecom()
    const config = WecomConfigSchema.parse({ mode: 'live', botId: 'bot-1', secret: 'secret-1', wsUrl: fake.url })
    const { ctx, received, reports } = context(config)
    const controller = new AbortController()
    const run = startLive(ctx, config, controller.signal, sdkLiveBot)
    try {
      const ready = Date.now() + 5000
      while (reports.at(-1)?.state !== 'ready') {
        if (Date.now() > ready) throw new Error(`SDK did not authenticate: ${JSON.stringify(reports)}`)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      fake.push({ cmd: 'aibot_msg_callback', headers: { req_id: 'req-1' }, body: MESSAGE })
      const began = Date.now()
      while (received.length === 0) {
        if (Date.now() - began > 5000) throw new Error('SDK did not deliver the message')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(received[0]?.id).toBe(wecomTriggerId('msg-1'))
      expect(await sendLiveReply(message())).toBe('sent')
      const sent = await fake.waitFor(frame => frame.cmd === 'aibot_respond_msg')
      expect(sent.headers).toEqual({ req_id: 'req-1' })
      expect(sent.body).toEqual({ msgtype: 'markdown', markdown: { content: '收到，正在处理' } })
    } finally {
      await run.stop()
      await fake.close()
    }
  })

  it('rejects an invalid bot instead of hanging forever', async () => {
    const fake = await fakeWecom()
    const config = WecomConfigSchema.parse({ mode: 'live', botId: '', secret: '', wsUrl: fake.url })
    const { ctx, reports } = context(config)
    startLive(ctx, config, new AbortController().signal, sdkLiveBot)
    expect(reports.at(-1)).toMatchObject({ state: 'paused' })
    await fake.close()
  })
})
