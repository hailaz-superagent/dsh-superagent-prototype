/** WeCom Source: trigger mapping, policy/scope, bridge validation, and cursor polling. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { key, type Trigger } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import {
  CURSOR, WecomConfigSchema, pollWecomOnce, readBridgeEvents, readBridgeHealth, wecomKind, wecomTrigger,
} from '../src/sources/wecom.ts'
import { testDeployment } from './fixtures/deployment.ts'

const EVENT = {
  seq: 1, id: 'msg-1', reqId: 'req-1', chatId: 'chat-1', chatType: 'group' as const,
  fromUserId: 'alice', text: 'fix the bug', at: '2026-11-26T08:00:00Z', addressed: 'mention' as const,
}
const CONFIG = WecomConfigSchema.parse({})

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error) reject(error); else resolve() })
  })))
})

async function localBridge(respond: (url: URL, response: ServerResponse) => void): Promise<string> {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    respond(new URL(request.url ?? '/', 'http://bridge.invalid'), response)
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function fakeContext(received: Trigger[], state = new Map<string, unknown>()): Pick<SourceContext, 'state' | 'receive'> {
  return {
    state: {
      get: (key: string) => state.get(key) as never,
      set: (key: string, value: unknown) => { state.set(key, value) },
      keys: () => [],
    },
    receive: async (trigger: Trigger) => { received.push(trigger); return {} as never },
  }
}

describe('WeCom trigger', () => {
  it('maps a group mention to a per-message Trigger and channel address', () => {
    const trigger = wecomTrigger(EVENT, 'http://127.0.0.1:3099')
    expect(trigger).toMatchObject({
      source: 'wecom', human: true, addressed: 'mention', at: EVENT.at, text: EVENT.text,
      actor: { source: 'wecom', id: 'alice' },
      threads: [{ source: 'wecom', id: 'msg-1' }],
      channel: { source: 'wecom', thread: 'wecom:chat-1', address: {
        bridgeUrl: 'http://127.0.0.1:3099', chatId: 'chat-1', reqId: 'req-1', msgId: 'msg-1', chatType: 'group',
      } },
      meta: { chatId: 'chat-1', reqId: 'req-1', msgId: 'msg-1', chatType: 'group' },
    })
  })

  it('uses the sender as the chat for a direct message without a chat id', () => {
    const trigger = wecomTrigger({ ...EVENT, id: 'msg-2', chatId: '', chatType: 'single', addressed: 'direct' }, 'http://127.0.0.1:3099')
    expect(trigger.addressed).toBe('direct')
    expect(trigger.channel?.thread).toBe('wecom:alice')
    expect(trigger.channel?.address).toMatchObject({ chatId: '', reqId: 'req-1', msgId: 'msg-2' })
  })
})

describe('WeCom policy and scope', () => {
  it('listens to group @ and configurable direct messages with matching admission rows', () => {
    expect(wecomKind.scope?.({ meta: { chatType: 'group' } }, CONFIG)).toEqual({ listened: true, observed: false, row: 'group' })
    expect(wecomKind.scope?.({ meta: { chatType: 'single' } }, CONFIG)).toEqual({ listened: true, observed: false, row: 'direct' })
    expect(wecomKind.scope?.({ meta: { chatType: 'single' } }, WecomConfigSchema.parse({ directMessages: false })))
      .toEqual({ listened: false, reason: 'wecom_direct_messages_off' })
    expect(wecomKind.scope?.({ meta: { chatType: 'blackboard' } }, CONFIG)).toEqual({ listened: false, reason: 'wecom_unsupported_chat' })

    const rows = wecomKind.policy?.rows?.(CONFIG) ?? []
    expect(rows.map(row => row.id)).toEqual(['group', 'direct'])
    for (const row of rows) {
      expect(row.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false })
    }
    expect(wecomKind.policy?.explicit.zh).toContain('@')
    expect(wecomKind.channel?.allowed?.({ chatType: 'direct' }, WecomConfigSchema.parse({ directMessages: false }))).toBe(false)
    expect(wecomKind.channel?.allowed?.({ chatType: 'group' }, WecomConfigSchema.parse({ directMessages: false }))).toBe(true)
  })

  it('exposes WeCom environment variables only for WeCom tickets', () => {
    const values = wecomKind.environment?.values({
      deployment: testDeployment(), config: CONFIG, trigger: wecomTrigger(EVENT),
    })
    expect(values).toEqual({ DSH_SUPERAGENT_WECOM_CHAT: 'chat-1', DSH_SUPERAGENT_WECOM_ACCOUNT: 'alice' })
    expect(wecomKind.environment?.values({ deployment: testDeployment(), config: CONFIG })).toEqual({
      DSH_SUPERAGENT_WECOM_CHAT: '', DSH_SUPERAGENT_WECOM_ACCOUNT: '',
    })
  })

  it('returns only the triggering message as thread context', async () => {
    const trigger = wecomTrigger(EVENT)
    const context = wecomKind.threadContext
    expect(context).toBeDefined()
    expect(context?.messageId(trigger)).toBe('msg-1')
    await expect(context?.read({} as never, trigger, 'thread', undefined, CONFIG)).resolves.toEqual({
      messages: [{ id: 'msg-1', from: 'alice', at: EVENT.at, text: EVENT.text }],
      body: { messages: [{ id: 'msg-1', from: 'alice', at: EVENT.at, text: EVENT.text }] },
    })
    await expect(context?.read({} as never, trigger, 'thread', 'next', CONFIG)).resolves.toEqual({ messages: [], body: { messages: [] } })
  })
})

describe('WeCom bridge validation and polling', () => {
  it('reads a valid event page and health document', async () => {
    const url = await localBridge((request, response) => {
      if (request.pathname === '/health') json(response, { ok: true, connected: true })
      else json(response, { events: [EVENT], next: 1 })
    })
    await expect(readBridgeHealth(url)).resolves.toMatchObject({ connected: true })
    await expect(readBridgeEvents(url, 0)).resolves.toEqual({ events: [EVENT], next: 1 })
  })

  it('rejects a malformed event instead of ingesting it', async () => {
    const url = await localBridge((_request, response) => {
      json(response, { events: [{ ...EVENT, reqId: undefined }], next: 1 })
    })
    await expect(readBridgeEvents(url, 0)).rejects.toThrow()
  })

  it('receives each new event once and persists the cursor after the batch', async () => {
    const url = await localBridge((request, response) => {
      if (request.pathname === '/health') json(response, { ok: true, connected: true })
      else json(response, { events: [EVENT], next: 1 })
    })
    const received: Trigger[] = []
    const state = new Map<string, unknown>()
    const context = fakeContext(received, state)
    await expect(pollWecomOnce(context, WecomConfigSchema.parse({ bridgeUrl: url }))).resolves.toEqual({ connected: true, received: 1 })
    expect(received.map(trigger => trigger.id)).toEqual([key('wecom', 'msg-1')])
    expect(state.get(CURSOR)).toBe(1)
  })

  it('refuses a bridge cursor that moves backwards', async () => {
    const url = await localBridge((request, response) => {
      if (request.pathname === '/health') json(response, { ok: true, connected: true })
      else json(response, { events: [], next: 0 })
    })
    const state = new Map<string, unknown>([[CURSOR, 3]])
    await expect(pollWecomOnce(fakeContext([], state), WecomConfigSchema.parse({ bridgeUrl: url }))).rejects.toThrow('moved backwards')
  })
})
