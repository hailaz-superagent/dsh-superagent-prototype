/**
 * HTTP client for the iLink bot protocol: long-poll `getupdates`, `sendmessage`,
 * and the CDN helpers for encrypted inbound media. It mirrors the wire format of
 * `@tencent-weixin/openclaw-weixin`, so an account connected by that plugin can
 * also be read by this Source when no other process holds the same token.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DEFAULT_BASE_URL, ILINK_APP_ID, ILINK_CLIENT_VERSION } from './weixin-shared.ts'

/** Credentials resolved from the Source settings or its login file. */
export interface WeixinCredentials { baseUrl: string; token: string; accountId?: string }

const MediaSchema = z.object({
  encrypt_query_param: z.string().optional(), aes_key: z.string().optional(), full_url: z.string().optional(),
}).loose()

/** The subset of a quoted message item the mapper renders; a quote never nests another quote. */
const QuotedItemSchema = z.object({
  type: z.number().optional(), msg_id: z.string().optional(),
  text_item: z.object({ text: z.string().optional() }).loose().optional(),
  image_item: z.object({ media: MediaSchema.optional(), aeskey: z.string().optional(), url: z.string().optional() }).loose().optional(),
  voice_item: z.object({ media: MediaSchema.optional(), text: z.string().optional() }).loose().optional(),
  file_item: z.object({ media: MediaSchema.optional(), file_name: z.string().optional() }).loose().optional(),
  video_item: z.object({ media: MediaSchema.optional() }).loose().optional(),
}).loose()

const MessageItemSchema = z.object({
  type: z.number().optional(), msg_id: z.string().optional(), create_time_ms: z.number().optional(),
  ref_msg: z.object({
    title: z.string().optional(), svr_id: z.string().optional(),
    message_item: QuotedItemSchema.optional(),
  }).loose().optional(),
  text_item: z.object({ text: z.string().optional() }).loose().optional(),
  image_item: z.object({ media: MediaSchema.optional(), aeskey: z.string().optional(), url: z.string().optional() }).loose().optional(),
  voice_item: z.object({ media: MediaSchema.optional(), text: z.string().optional(), encode_type: z.number().optional() }).loose().optional(),
  file_item: z.object({ media: MediaSchema.optional(), file_name: z.string().optional(), len: z.string().optional() }).loose().optional(),
  video_item: z.object({ media: MediaSchema.optional(), video_size: z.number().optional(), play_length: z.number().optional() }).loose().optional(),
}).loose()
export type WeixinMessageItem = z.infer<typeof MessageItemSchema>

/** One message returned by `getupdates`; unknown fields are kept for diagnostics. */
export const WeixinMessageSchema = z.object({
  message_id: z.string().optional(), seq: z.number().optional(),
  from_user_id: z.string().optional(), to_user_id: z.string().optional(),
  create_time_ms: z.number().optional(), session_id: z.string().optional(), group_id: z.string().optional(),
  message_type: z.number().optional(), message_state: z.number().optional(),
  item_list: z.array(MessageItemSchema).optional(), context_token: z.string().optional(),
}).loose()
export type WeixinMessage = z.infer<typeof WeixinMessageSchema>

/** A `getupdates` response; `ret`/`errcode` carry the gateway's error code. */
export const GetUpdatesRespSchema = z.object({
  ret: z.number().optional(), errcode: z.number().optional(), errmsg: z.string().optional(),
  msgs: z.array(WeixinMessageSchema).optional(), get_updates_buf: z.string().optional(),
  sync_buf: z.string().optional(), longpolling_timeout_ms: z.number().optional(),
}).loose()
export type GetUpdatesResp = z.infer<typeof GetUpdatesRespSchema>

/** Gateway code for an expired or replaced bot token; the account must log in again. */
export const STALE_TOKEN_ERRCODE = -14
const DEFAULT_LONG_POLL_MS = 35_000
const DEFAULT_TIMEOUT_MS = 20_000

function headers(token?: string): Record<string, string> {
  const common: Record<string, string> = {
    'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
    'iLink-App-Id': ILINK_APP_ID, 'iLink-App-ClientVersion': String(ILINK_CLIENT_VERSION),
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64'),
  }
  if (token?.trim()) common.Authorization = `Bearer ${token.trim()}`
  return common
}

function baseInfo(): Record<string, string> {
  return { channel_version: '0.1.0', bot_agent: 'dsh-superagent/0.1.0' }
}

/**
 * Quotes uint64 identifier fields before `JSON.parse` sees them.
 *
 * The gateway writes `message_id`, `msg_id` and `svr_id` as JSON numbers, which
 * JavaScript would round above 2^53; they are the only fields this client needs
 * losslessly, so they are rewritten as strings first.
 */
export function parseWeixinJson<T>(raw: string): T {
  const fields = new Set(['message_id', 'msg_id', 'svr_id'])
  let output = ''
  let index = 0
  while (index < raw.length) {
    if (raw[index] !== '"') { output += raw[index++]!; continue }
    const start = index++
    let escaped = false
    while (index < raw.length) {
      const char = raw[index++]!
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') break
    }
    const token = raw.slice(start, index)
    output += token
    let cursor = index
    while (/\s/.test(raw[cursor] ?? '')) cursor++
    if (raw[cursor] !== ':') continue
    let name: unknown
    try { name = JSON.parse(token) } catch { continue }
    if (typeof name !== 'string' || !fields.has(name)) continue
    output += raw.slice(index, cursor + 1)
    cursor++
    while (/\s/.test(raw[cursor] ?? '')) output += raw[cursor++]!
    const numberStart = cursor
    if (raw[cursor] === '-') cursor++
    while (/\d/.test(raw[cursor] ?? '')) cursor++
    if (cursor > numberStart && raw.slice(numberStart, cursor) !== '-') {
      output += `"${raw.slice(numberStart, cursor)}"`
      index = cursor
    } else { index = numberStart }
  }
  return JSON.parse(output) as T
}

/** Combines the caller's abort signal with a request deadline. */
function deadline(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('request timeout')), ms)
  const abort = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    done: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort) },
  }
}

async function post(cred: WeixinCredentials, endpoint: string, body: unknown, signal: AbortSignal | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  const url = new URL(endpoint, cred.baseUrl.endsWith('/') ? cred.baseUrl : `${cred.baseUrl}/`)
  const wait = deadline(signal, timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST', headers: headers(cred.token), body: JSON.stringify({ ...(body as object), base_info: baseInfo() }),
      signal: wait.signal,
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}: ${text.slice(0, 200)}`)
    return text
  } finally { wait.done() }
}

/** One long poll. A client-side timeout or a stop returns an empty page, as the server would. */
export async function getUpdates(cred: WeixinCredentials, buffer: string, signal: AbortSignal | undefined,
  timeoutMs = DEFAULT_LONG_POLL_MS): Promise<GetUpdatesResp> {
  try {
    const text = await post(cred, 'ilink/bot/getupdates', { get_updates_buf: buffer }, signal, timeoutMs)
    return GetUpdatesRespSchema.parse(parseWeixinJson(text))
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError' || error.message === 'request timeout')) {
      return { ret: 0, msgs: [], get_updates_buf: buffer }
    }
    throw error
  }
}

/** Sends one plain text message to `to`, echoing the conversation's latest `context_token`. */
export async function sendText(cred: WeixinCredentials, input: { to: string; text: string; contextToken?: string },
  signal?: AbortSignal): Promise<string | undefined> {
  const text = await post(cred, 'ilink/bot/sendmessage', {
    msg: {
      from_user_id: '', to_user_id: input.to, client_id: `dsh-superagent:${Date.now()}-${randomUUID().slice(0, 8)}`,
      message_type: 2, message_state: 2,
      item_list: [{ type: 1, text_item: { text: input.text } }],
      ...input.contextToken ? { context_token: input.contextToken } : {},
    },
  }, signal)
  const response = z.object({ ret: z.number().optional(), errmsg: z.string().optional(), message_id: z.string().optional() }).loose()
    .parse(parseWeixinJson(text))
  if (response.ret !== undefined && response.ret !== 0) throw new Error(`sendmessage ret=${response.ret} ${response.errmsg ?? ''}`.trim())
  return response.message_id
}

/** Re-exports for tests that build a credential literal without repeating the default. */
export const publicBaseUrl = DEFAULT_BASE_URL
