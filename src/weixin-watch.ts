/** Cordis plugin entry for the personal WeChat Source: registers the kind and runs its long poller. */
import type { Context } from '@deepseek-ai/cordis'
import { sourceContext } from './sources/host.ts'
import { watchWeixin, weixinKind } from './sources/weixin.ts'

export {
  CONTEXT_TOKEN, DEFAULT_BASE_URL, SOURCE, STALE_TOKEN_ERRCODE, UPDATES_BUF, WeixinConfigSchema,
  cancelWeixinAck, clearWeixinAcks, clearWeixinQuotes, extractWeixinMedia, getUpdates, parseWeixinJson, plainWeixinText, pollWeixinOnce, splitWeixinText, sendItem, sendText, sendWeixinReply, setWeixinSession, uploadMedia, watchWeixin, weixinAccountKey,
  scheduleWeixinAck, weixinCredentials, weixinKind, weixinMessageParts, weixinThreadId, weixinTrigger, weixinTriggerId,
} from './sources/weixin.ts'
export type { PollContext, WeixinConfig, WeixinCredentials, WeixinMessage, WeixinUpload } from './sources/weixin.ts'
export {
  MAX_WEIXIN_MEDIA_BYTES, WeixinAccountFileSchema, downloadWeixinMedia, parseWeixinAesKey, prepareWeixinMedia,
  readWeixinImage, weixinImageKeys, weixinImageType,
} from './sources/weixin-media.ts'
export type { WeixinImageFile, WeixinMediaRef, WeixinStoredMedia } from './sources/weixin-media.ts'

export const name = 'dsh-superagent-weixin'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(weixinKind), 'weixin: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, weixinKind)
    const controller = new AbortController()
    // An unhandled rejection would terminate the DSH process; surface it as Source health.
    const running = watchWeixin(source, controller.signal)
      .catch((error: unknown) => { source.report('weixin', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
