/** WeCom image reads: bridge download validation and attachment commit. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readWecomImage, wecomImageKeys } from '../src/sources/wecom-image.ts'

const ref = { attachmentId: 'image-id', mediaType: 'image/png', bytes: 4, width: 1, height: 1 }
const text = '看这个\n[图片] img_wecom_0'
let agent: Agent
let saveImage: ReturnType<typeof vi.fn>
let resolveModelInfo: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>

function imageResponse(bytes = Buffer.from('data'), contentType = 'image/png', length?: number) {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType, ...length === undefined ? {} : { 'content-length': String(length) } } })
}

beforeEach(() => {
  saveImage = vi.fn().mockResolvedValue(ref)
  resolveModelInfo = vi.fn().mockResolvedValue({ inputModalities: ['text', 'image'] })
  const ctx = new Context()
  ctx.reflect.provide('attachments', { saveImage, imageLimits: { maxImageBytes: 100, maxMessageImageBytes: 100 } })
  ctx.reflect.provide('llm', { resolveModelInfo })
  agent = { ctx, session: { requestHeader: () => ({ config: { provider: 'provider', model: 'model' } }) }, options: {} } as unknown as Agent
  fetchMock = vi.fn().mockResolvedValue(imageResponse())
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

it('extracts image keys and commits the bridge image as an attachment', async () => {
  expect(wecomImageKeys(`${text} img_wecom_1 img_wecom_0`)).toEqual(['img_wecom_0', 'img_wecom_1'])
  await expect(readWecomImage(agent, 'http://bridge', 'm1', text, 'img_wecom_0', new AbortController().signal))
    .resolves.toEqual({ source_message_id: 'm1', image_key: 'img_wecom_0', image: ref })
  const url = fetchMock.mock.calls[0]![0] as URL
  expect(url.toString()).toBe('http://bridge/media?message=m1&key=img_wecom_0')
  expect(resolveModelInfo).toHaveBeenCalledWith('provider', 'model', expect.any(AbortSignal))
  expect(saveImage).toHaveBeenCalledWith({ data: Buffer.from('data'), mediaType: 'image/png', name: 'img_wecom_0.png' })
})

it('refuses arbitrary keys and text-only models before downloading', async () => {
  await expect(readWecomImage(agent, 'http://bridge', 'm1', text, '../img_wecom_9', new AbortController().signal))
    .rejects.toThrow('source message')
  resolveModelInfo.mockResolvedValue({ inputModalities: ['text'] })
  await expect(readWecomImage(agent, 'http://bridge', 'm1', text, 'img_wecom_0', new AbortController().signal))
    .rejects.toThrow('does not support image')
  expect(fetchMock).not.toHaveBeenCalled()
  expect(saveImage).not.toHaveBeenCalled()
})

it('reports missing, failed, oversize and unsupported bridge images', async () => {
  fetchMock.mockResolvedValueOnce(new Response('', { status: 404 }))
  await expect(readWecomImage(agent, 'http://bridge', 'm1', text, 'img_wecom_0', new AbortController().signal))
    .rejects.toThrow('no longer has')
  fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }))
  await expect(readWecomImage(agent, 'http://bridge', 'm1', text, 'img_wecom_0', new AbortController().signal))
    .rejects.toThrow('HTTP 500')
  fetchMock.mockResolvedValueOnce(imageResponse(Buffer.alloc(4), 'image/png', 101))
  await expect(readWecomImage(agent, 'http://bridge', 'm1', text, 'img_wecom_0', new AbortController().signal))
    .rejects.toThrow('byte limit')
  fetchMock.mockResolvedValueOnce(imageResponse(Buffer.from('x'), 'image/svg+xml'))
  await expect(readWecomImage(agent, 'http://bridge', 'm1', text, 'img_wecom_0', new AbortController().signal))
    .rejects.toThrow('unsupported')
  expect(saveImage).not.toHaveBeenCalled()
})
