/** Personal WeChat Source: message mapping, Policy/scope, credentials, protocol and media. */
import { createCipheriv } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { getUpdates, parseWeixinJson, sendText, type WeixinMessage } from '../src/sources/weixin-api.ts'
import { downloadWeixinMedia, parseWeixinAesKey, prepareWeixinMedia, weixinImageType, type WeixinMediaRef } from '../src/sources/weixin-media.ts'
import {
  CONTEXT_TOKEN, UPDATES_BUF, WeixinConfigSchema, cancelWeixinAck, clearWeixinAcks, clearWeixinQuotes, extractWeixinMedia, plainWeixinText, pollWeixinOnce, sendWeixinReply, setWeixinSession, weixinAccountKey,
  scheduleWeixinAck, weixinCredentials, weixinKind, weixinMessageParts, weixinThreadId, weixinTrigger, weixinTriggerId,
} from '../src/sources/weixin.ts'
import { testDeployment } from './fixtures/deployment.ts'

const servers: ReturnType<typeof createServer>[] = []
const directories: string[] = []
afterEach(async () => {
  clearWeixinQuotes()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => { if (error) reject(error); else resolve() })
  })))
})

async function serve(respond: (request: IncomingMessage, response: ServerResponse, body: string) => void): Promise<string> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => respond(request, response, Buffer.concat(chunks).toString('utf8')))
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
function encrypted(data: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', KEY, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}

const MESSAGE: WeixinMessage = {
  message_id: '9007199254740993', from_user_id: 'wx_alice', to_user_id: 'bot', create_time_ms: 1_800_000_000_000,
  message_type: 1, context_token: 'ctx-1',
  item_list: [
    { type: 1, text_item: { text: '修一下这个 bug' } },
    { type: 2, image_item: { media: { encrypt_query_param: 'image-param', aes_key: KEY.toString('base64') } } },
  ],
}

describe('Weixin message mapping', () => {
  it('renders text, media markers and an inline quote in message order', () => {
    const parts = weixinMessageParts({
      from_user_id: 'wx_alice',
      item_list: [
        { type: 1, text_item: { text: '看看这张' }, ref_msg: { title: '昨天的图', message_item: { type: 1, text_item: { text: '旧消息' } } } },
        { type: 2, image_item: { media: { encrypt_query_param: 'p1', aes_key: 'k1' } } },
        { type: 3, voice_item: { text: '语音转写' } },
        { type: 4, file_item: { media: { encrypt_query_param: 'p2', aes_key: 'k2' }, file_name: '报告.pdf' } },
        { type: 5, video_item: { media: { encrypt_query_param: 'p3', aes_key: 'k3' } } },
      ],
    }, 'acct', 'wx_alice')
    expect(parts.text).toBe('[引用] 昨天的图 | 旧消息\n看看这张\n[图片] img_weixin_0\n语音转写\n[文件] file_weixin_1\n[视频] video_weixin_2')
    expect(parts.refs.map(ref => [ref.key, ref.kind, ref.name])).toEqual([
      ['img_weixin_0', 'image', undefined],
      ['file_weixin_1', 'file', '报告.pdf'],
      ['video_weixin_2', 'video', undefined],
    ])
    expect(parts.refs[0]).toMatchObject({ query: 'p1', aeskey: 'k1', keyEncoding: 'base64' })
  })

  it('resolves an ID-only quote from the in-process cache', () => {
    const first = weixinTrigger({ ...MESSAGE, message_id: '100', item_list: [{ type: 1, text_item: { text: '原文' } }] }, 'acct')
    expect(first?.text).toBe('原文')
    const reply = weixinTrigger({
      ...MESSAGE, message_id: '101',
      item_list: [{ type: 1, text_item: { text: '引用它' }, ref_msg: { svr_id: '100' } }],
    }, 'acct')
    expect(reply?.text).toBe('[引用] 原文\n引用它')
  })

  it('maps a direct message to a conversation Trigger and skips bot messages', () => {
    const trigger = weixinTrigger(MESSAGE, 'acct')!
    expect(trigger).toMatchObject({
      id: weixinTriggerId('9007199254740993'), source: 'weixin', human: true, addressed: 'direct',
      actor: { source: 'weixin', id: 'wx_alice' }, threads: [{ source: 'weixin', id: weixinThreadId('wx_alice') }],
      channel: { source: 'weixin', thread: 'weixin:direct:wx_alice', address: {
        userId: 'wx_alice', msgId: '9007199254740993', accountId: 'acct', contextToken: 'ctx-1',
      } },
    })
    expect(trigger.text).toContain('修一下这个 bug')
    expect(trigger.text).toContain('[图片] img_weixin_0')
    expect(weixinTrigger({ ...MESSAGE, message_type: 2 }, 'acct')).toBeUndefined()
    expect(weixinTrigger({ ...MESSAGE, from_user_id: undefined }, 'acct')).toBeUndefined()
  })
})

describe('Weixin Policy, scope and environment', () => {
  const config = WeixinConfigSchema.parse({})
  it('listens to direct messages with the direct admission row', () => {
    expect(weixinKind.scope?.({ meta: {} }, config)).toEqual({ listened: true, observed: false, row: 'direct' })
    const rows = weixinKind.policy?.rows?.(config) ?? []
    expect(rows.map(row => row.id)).toEqual(['direct'])
    expect(rows[0]?.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false })
    expect(weixinKind.policy?.explicit.zh).toContain('单聊')
  })

  it('exposes Weixin environment variables only for Weixin tickets', () => {
    const trigger = weixinTrigger(MESSAGE, 'acct')!
    expect(weixinKind.environment?.values({ deployment: testDeployment(), config, trigger })).toEqual({
      DSH_SUPERAGENT_WEIXIN_CHAT: 'wx_alice', DSH_SUPERAGENT_WEIXIN_ACCOUNT: 'wx_alice',
    })
    expect(weixinKind.environment?.values({ deployment: testDeployment(), config })).toEqual({
      DSH_SUPERAGENT_WEIXIN_CHAT: '', DSH_SUPERAGENT_WEIXIN_ACCOUNT: '',
    })
  })

  it('returns the triggering message as thread context', async () => {
    const trigger = weixinTrigger(MESSAGE, 'acct')!
    await expect(weixinKind.threadContext?.read({} as never, trigger, 'thread', undefined, config)).resolves.toEqual({
      messages: [{ id: '9007199254740993', from: 'wx_alice', at: new Date(1_800_000_000_000).toISOString(), text: trigger.text }],
      body: { messages: [{ id: '9007199254740993', from: 'wx_alice', at: trigger.at, text: trigger.text }] },
    })
    expect(weixinKind.threadContext?.messageId(trigger)).toBe('9007199254740993')
    expect(weixinKind.threadContext?.images?.(trigger.text)).toEqual(['img_weixin_0'])
  })
})

describe('Weixin credentials', () => {
  it('prefers a login file and keeps a stable cursor namespace', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weixin-')); directories.push(directory)
    writeFileSync(join(directory, 'login.json'), JSON.stringify({ token: 'file-token', accountId: 'acct-1', baseUrl: 'https://example.test' }))
    const config = WeixinConfigSchema.parse({ token: 'pasted', accountFile: 'login.json' })
    expect(weixinCredentials(config, directory)).toEqual({ token: 'file-token', accountId: 'acct-1', baseUrl: 'https://example.test' })
    expect(weixinCredentials(WeixinConfigSchema.parse({ token: 'pasted' }), directory)).toEqual({ token: 'pasted', baseUrl: 'https://ilinkai.weixin.qq.com' })
    expect(weixinCredentials(WeixinConfigSchema.parse({}), directory)).toBeUndefined()
    expect(weixinAccountKey({ token: 'pasted', baseUrl: '' })).toHaveLength(16)
  })
})

describe('Weixin protocol', () => {
  it('parses uint64 ids without rounding', () => {
    expect(parseWeixinJson('{"message_id":9007199254740993,"msg_id":12,"n":1}')).toEqual({
      message_id: '9007199254740993', msg_id: '12', n: 1,
    })
  })

  it('long-polls, sends text with its context token, and posts the required headers', async () => {
    let updates: Record<string, unknown> | undefined
    let sent: Record<string, unknown> | undefined
    let auth: string | undefined
    const url = await serve((request, response, body) => {
      const parsed = JSON.parse(body) as Record<string, unknown>
      if (request.url?.endsWith('/ilink/bot/getupdates')) { updates = parsed; auth = request.headers.authorization
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ret":0,"msgs":[{"message_id":9007199254740993,"from_user_id":"wx_alice","message_type":1,"item_list":[{"type":1,"text_item":{"text":"hi"}}]}],"get_updates_buf":"buf-2"}')
      } else if (request.url?.endsWith('/ilink/bot/sendmessage')) { sent = parsed; json(response, { ret: 0, message_id: '9007199254740994' }) }
      else { response.writeHead(404); response.end() }
    })
    const credentials = { baseUrl: url, token: 'secret' }
    const page = await getUpdates(credentials, 'buf-1', undefined, 1000)
    expect(updates).toMatchObject({ get_updates_buf: 'buf-1', base_info: { channel_version: '0.1.0' } })
    expect(auth).toBe('Bearer secret')
    expect(page.msgs?.[0]?.message_id).toBe('9007199254740993')
    await expect(sendText(credentials, { to: 'wx_alice', text: '回复', contextToken: 'ctx-1' })).resolves.toBe('9007199254740994')
    expect(sent).toMatchObject({ msg: { to_user_id: 'wx_alice', context_token: 'ctx-1', message_type: 2, item_list: [{ type: 1, text_item: { text: '回复' } }] } })
  })

  it('extracts local image, file and MEDIA paths and leaves URLs alone', () => {
    const directory = mkdtempSync(join(tmpdir(), 'weixin-')); directories.push(directory)
    const image = join(directory, 'chart.png'); writeFileSync(image, IMAGE)
    const file = join(directory, 'report.pdf'); writeFileSync(file, Buffer.from('%PDF-1.4'))
    const parts = extractWeixinMedia(`看图 ![图表](${image})\nMEDIA: ${file}\n[链接](https://example.test)`)
    expect(parts.text).toContain('[链接](https://example.test)')
    expect(parts.media.map(item => [item.kind, item.name])).toEqual([['image', 'chart.png'], ['file', 'report.pdf']])
    expect(extractWeixinMedia('![x](https://example.test/a.png)').media).toEqual([])
  })

  it('uploads a local image and sends it after the caption', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weixin-')); directories.push(directory)
    const image = join(directory, 'chart.png'); writeFileSync(image, IMAGE)
    const sent: Record<string, unknown>[] = []
    const url = await serve((request, response, body) => {
      if (request.url?.endsWith('/ilink/bot/getuploadurl')) { json(response, { ret: 0, upload_full_url: `${url}/upload` }); return }
      if (request.url === '/upload') { response.writeHead(200, { 'x-encrypted-param': 'download-param' }); response.end(); return }
      if (request.url?.endsWith('/ilink/bot/sendmessage')) { sent.push(JSON.parse(body) as Record<string, unknown>); json(response, { ret: 0 }); return }
      response.writeHead(404); response.end()
    })
    setWeixinSession({ baseUrl: url, token: 'secret' })
    try {
      await expect(weixinKind.channel?.send({} as never, {
        id: 'reply-image', kind: 'reply', text: `看图 ![图表](${image})`,
        channel: { source: 'weixin', thread: 'weixin:direct:wx_alice', address: { userId: 'wx_alice', contextToken: 'ctx-1' } },
      })).resolves.toBe('sent')
    } finally { setWeixinSession(undefined) }
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({ msg: { item_list: [{ type: 1, text_item: { text: '看图' } }] } })
    expect(sent[1]).toMatchObject({ msg: { item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'download-param', encrypt_type: 1 }, mid_size: 16 } }] } })
  })

  it('renders Markdown replies as plain WeChat text', () => {
    expect(plainWeixinText('**完成**：见 [PR #1](https://example.test/1)')).toBe('完成：见 PR #1 https://example.test/1')
    expect(plainWeixinText('## 标题\n`code`')).toBe('标题\ncode')
  })

  it('caches an outbound reply so quoting it later shows its text', async () => {
    const url = await serve((_request, response) => json(response, { ret: 0, message_id: '9007199254740995' }))
    const credentials = { baseUrl: url, token: 'secret', accountId: 'acct' }
    await sendWeixinReply(credentials, { messageId: 'reply-quote', to: 'wx_alice', text: '这是要引用的回复' })
    const trigger = weixinTrigger({
      ...MESSAGE, message_id: '102', item_list: [{ type: 1, text_item: { text: '引用它' }, ref_msg: { svr_id: '9007199254740995' } }],
    }, 'acct')
    expect(trigger?.text).toBe('[引用] 这是要引用的回复\n引用它')
  })

  it('sends a Channel reply through the active credentials', async () => {
    let sent: Record<string, unknown> | undefined
    const url = await serve((_request, response, body) => { sent = JSON.parse(body) as Record<string, unknown>; json(response, { ret: 0 }) })
    setWeixinSession({ baseUrl: url, token: 'secret' })
    try {
      await expect(weixinKind.channel?.send({} as never, {
        id: 'reply-1', kind: 'reply', text: '好的',
        channel: { source: 'weixin', thread: 'weixin:direct:wx_alice', address: { userId: 'wx_alice', contextToken: 'ctx-1' } },
      })).resolves.toBe('sent')
    } finally { setWeixinSession(undefined) }
    expect(sent).toMatchObject({ msg: { to_user_id: 'wx_alice', context_token: 'ctx-1', item_list: [{ type: 1, text_item: { text: '好的' } }] } })
  })

  it('receives each message once, saves the cursor and context token, and stores media', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'weixin-')); directories.push(directory)
    const media = await serve((request, response) => {
      if (request.url?.startsWith('/download')) { response.writeHead(200); response.end(encrypted(IMAGE)) }
      else { response.writeHead(404); response.end() }
    })
    const api = await serve((_request, response) => json(response, {
      ret: 0, msgs: [{ ...MESSAGE, item_list: [{ ...MESSAGE.item_list![0] }, { type: 2, image_item: { media: { full_url: `${media}/download?x=1`, aes_key: KEY.toString('base64') } } }] }],
      get_updates_buf: 'buf-2',
    }))
    const received: Trigger[] = []
    const state = new Map<string, unknown>()
    const ctx = {
      deployment: testDeployment({ stateDir: directory }),
      state: {
        get: (key: string) => state.get(key) as never,
        set: (key: string, value: unknown) => { state.set(key, value) },
        keys: () => [],
      },
      receive: async (trigger: Trigger) => { received.push(trigger); return {} as never },
    }
    const result = await pollWeixinOnce(ctx, { baseUrl: api, token: 'secret', accountId: 'acct' }, WeixinConfigSchema.parse({}), AbortSignal.timeout(5000))
    expect(result.received).toBe(1)
    expect(received[0]?.text).toContain('[图片] img_weixin_0')
    expect(received[0]?.meta.media).toBeUndefined()
    expect((received[0]?.meta.images as { file: string }[])[0]?.file).toContain(join(directory, 'weixin-media'))
    expect(readFileSync((received[0]?.meta.images as { file: string }[])[0]!.file)).toEqual(IMAGE)
    expect(state.get(UPDATES_BUF('acct'))).toBe('buf-2')
    expect(state.get(CONTEXT_TOKEN('wx_alice'))).toBe('ctx-1')
  })
})

describe('Weixin slow-reply acknowledgement', () => {
  afterEach(() => vi.useRealTimers())
  it('sends after the delay and is cancelled by a reply', async () => {
    vi.useFakeTimers()
    const sent = vi.fn(async () => 'ok')
    scheduleWeixinAck('acct:user', sent, 4000)
    await vi.advanceTimersByTimeAsync(4000)
    expect(sent).toHaveBeenCalledTimes(1)
    const cancelled = vi.fn(async () => 'ok')
    scheduleWeixinAck('acct:user', cancelled, 4000)
    cancelWeixinAck('acct:user')
    await vi.advanceTimersByTimeAsync(4000)
    expect(cancelled).not.toHaveBeenCalled()
    clearWeixinAcks()
  })
})

describe('Weixin media', () => {
  it('decrypts the gateway AES key shapes and detects image types', () => {
    expect(parseWeixinAesKey(KEY.toString('hex'), 'hex')).toEqual(KEY)
    expect(parseWeixinAesKey(Buffer.from(KEY.toString('hex')).toString('base64'), 'base64')).toEqual(KEY)
    expect(parseWeixinAesKey(KEY.toString('base64'), 'base64')).toEqual(KEY)
    expect(() => parseWeixinAesKey('short', 'base64')).toThrow('unexpected length')
    expect(weixinImageType(IMAGE)?.mediaType).toBe('image/png')
    expect(weixinImageType(Buffer.from('nope'))).toBeUndefined()
  })

  it('downloads and decrypts an image, then marks an unavailable file instead of dropping the message', async () => {
    const url = await serve((request, response) => {
      if (request.url?.startsWith('/image')) { response.writeHead(200); response.end(encrypted(IMAGE)) }
      else { response.writeHead(500); response.end('no') }
    })
    const refs: WeixinMediaRef[] = [
      { key: 'img_weixin_0', marker: '[图片] img_weixin_0', kind: 'image', query: '', url: `${url}/image`, aeskey: KEY.toString('hex'), keyEncoding: 'hex' },
      { key: 'file_weixin_1', marker: '[文件] file_weixin_1', kind: 'file', query: '', url: `${url}/missing`, aeskey: KEY.toString('hex'), keyEncoding: 'hex', name: 'a.pdf' },
    ]
    const trigger = { ...weixinTrigger({ ...MESSAGE, item_list: [{ type: 1, text_item: { text: '两个附件' }, ref_msg: undefined }] }, 'acct')!, meta: { media: refs } }
    trigger.text = '两个附件\n[图片] img_weixin_0\n[文件] file_weixin_1'
    const directory = mkdtempSync(join(tmpdir(), 'weixin-')); directories.push(directory)
    await prepareWeixinMedia({ deployment: testDeployment({ stateDir: directory }) }, trigger, AbortSignal.timeout(5000))
    expect(trigger.text).toContain('[文件不可用]')
    const images = (trigger.meta as unknown as { images: { file: string }[] }).images
    expect(readFileSync(images[0]!.file)).toEqual(IMAGE)
    await expect(downloadWeixinMedia({ key: 'x', marker: '', kind: 'image', query: '' }, AbortSignal.timeout(1000))).rejects.toThrow()
  })
})
