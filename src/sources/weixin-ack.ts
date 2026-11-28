/**
 * Slow-reply acknowledgement for personal WeChat.
 *
 * A message that the agent cannot answer quickly leaves the person without any
 * sign that it arrived. This schedules one short text acknowledgement per
 * conversation after a delay; a reply through the Channel cancels it first, so a
 * fast answer never produces an extra message.
 */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** Cancels a pending acknowledgement for one conversation. */
export function cancelWeixinAck(key: string): void {
  const timer = timers.get(key)
  if (timer) clearTimeout(timer)
  timers.delete(key)
}

/** Cancels every pending acknowledgement, as a stopped Source must not send later. */
export function clearWeixinAcks(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}

/** Schedules one acknowledgement; a later schedule or a reply replaces it. */
export function scheduleWeixinAck(key: string, send: () => Promise<unknown>, delayMs = 4_000): void {
  cancelWeixinAck(key)
  if (delayMs <= 0) return
  const timer = setTimeout(() => {
    timers.delete(key)
    Promise.resolve(send()).catch(() => {})
  }, delayMs)
  timer.unref?.()
  timers.set(key, timer)
}
