/** Cordis plugin entry for the WeCom Source: registers the kind and runs its bridge poller or long connection. */
import type { Context } from '@deepseek-ai/cordis'
import { sourceContext } from './sources/host.ts'
import { watchWecom, wecomKind } from './sources/wecom.ts'

export {
  CURSOR, DEFAULT_BRIDGE_URL, SOURCE, WecomConfigSchema, pollWecomOnce, readBridgeEvents, readBridgeHealth,
  wecomKind, wecomTrigger, wecomTriggerId, watchWecom,
} from './sources/wecom.ts'
export type { BridgeEvent, BridgeEvents, BridgeHealth, WecomConfig } from './sources/wecom.ts'
export {
  LIVE_TRANSPORT, PASSIVE_WINDOW_MS, liveBot, liveMessageParts, liveMessageText, liveTrigger, sendLiveReply, setLiveBot, startLive,
} from './sources/wecom-live.ts'
export type { LiveBot, LiveCredentials, LiveFrame, LiveMessage, LiveMessageParts, LiveRun } from './sources/wecom-live.ts'
export { MAX_LIVE_IMAGE_BYTES, liveImageType, prepareLiveImages, readLiveWecomImage } from './sources/wecom-live-image.ts'
export type { LiveImageDownloader, LiveImageFile, LiveImageRef } from './sources/wecom-live-image.ts'

export const name = 'dsh-superagent-wecom'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(wecomKind), 'wecom: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, wecomKind)
    const controller = new AbortController()
    // An unhandled rejection would terminate the DSH process; surface it as Source health.
    const running = watchWecom(source, controller.signal)
      .catch((error: unknown) => { source.report('wecom', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
