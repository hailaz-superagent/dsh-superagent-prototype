/**
 * In-process quote cache for personal WeChat.
 *
 * Newer WeChat clients may send only the server id of a quoted message, not its
 * body. Keeping recent inbound and outbound text by that id lets a later quote
 * render its content instead of `[引用消息内容未缓存]`. The cache is bounded per
 * conversation and lives only for this process.
 */
import { createHash } from 'node:crypto'

const quotes = new Map<string, Map<string, string>>()
const QUOTE_LIMIT = 500

/** Cache one message's text under its server id. */
export function rememberQuote(account: string, chat: string, id: string, text: string): void {
  const bucket = `${account}:${chat}`
  let entries = quotes.get(bucket)
  if (!entries) { entries = new Map(); quotes.set(bucket, entries) }
  entries.set(id, text)
  if (entries.size > QUOTE_LIMIT) entries.delete(entries.keys().next().value as string)
}

/** Read cached text for a quoted message id, if this process still has it. */
export function recallQuote(account: string, chat: string, id: string): string | undefined {
  return quotes.get(`${account}:${chat}`)?.get(id)
}

/** Clears the cache; tests use it so one case cannot see another's messages. */
export function clearWeixinQuotes(): void { quotes.clear() }

/** Stable account namespace for cache entries when no account id is configured. */
export function weixinAccountKey(credentials: { accountId?: string; token: string; baseUrl?: string }): string {
  if (credentials.accountId) return credentials.accountId
  return createHash('sha256').update(credentials.token).digest('hex').slice(0, 16)
}
