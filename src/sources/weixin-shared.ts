/** Values shared by the personal WeChat (iLink bot) Source and its message mapper. */
import { key } from '../core/index.ts'

/** Source kind ID, also the prefix of every Thread and Trigger id this Source creates. */
export const SOURCE = 'weixin'
/** Public iLink bot gateway used by the official OpenClaw Weixin plugin and this Source. */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
/** Weixin CDN that serves encrypted inbound media and receives outbound uploads. */
export const DEFAULT_CDN_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
/** iLink app identity sent on every request, as the official plugin does. */
export const ILINK_APP_ID = 'bot'
/** `0x0002040A`, the client version shape the gateway expects (2.4.10). */
export const ILINK_CLIENT_VERSION = 131082

/** Stable Trigger id for one Weixin message; the Store deduplicates a redelivered message by it. */
export const weixinTriggerId = (messageId: string): string => key(SOURCE, messageId)
/** One direct conversation, keyed by the person's Weixin user id. */
export const weixinThreadId = (userId: string): string => `direct:${userId}`
