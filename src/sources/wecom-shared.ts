/** Values shared by the WeCom bridge poller and the WeCom long-connection runner. */
import { key } from '../core/index.ts'

export const SOURCE = 'wecom'

/**
 * Stable Trigger id for one WeCom message.
 *
 * The long-connection runner and the bridge both name a Trigger after the WeCom
 * `msgid`, so a message that arrives through the other transport is deduplicated
 * by the Store instead of opening a second Ticket.
 */
export const wecomTriggerId = (messageId: string): string => key(SOURCE, messageId)
