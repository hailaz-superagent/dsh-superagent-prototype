/** Minimal WAV reader for outbound voice: personal WeChat expects voice payloads without a RIFF container. */
export interface WeixinPcm { pcm: Buffer; sampleRate: number; playtime: number }

export function wavToPcm(data: Buffer): WeixinPcm | undefined {
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') return undefined
  let offset = 12
  let format: { audioFormat: number; channels: number; sampleRate: number; bits: number } | undefined
  let payload: Buffer | undefined
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4)
    const size = data.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && size >= 16 && body + 16 <= data.length) {
      format = { audioFormat: data.readUInt16LE(body), channels: data.readUInt16LE(body + 2), sampleRate: data.readUInt32LE(body + 4), bits: data.readUInt16LE(body + 14) }
    } else if (id === 'data') {
      payload = data.subarray(body, Math.min(body + size, data.length))
    }
    offset = body + size + (size % 2)
  }
  if (!format || !payload || format.audioFormat !== 1 || format.bits !== 16 || ![1, 2].includes(format.channels)) return undefined
  let pcm = payload
  if (format.channels === 2) {
    const frames = Math.floor(payload.length / 4)
    const mono = Buffer.alloc(frames * 2)
    for (let i = 0; i < frames; i++) mono.writeInt16LE(Math.round((payload.readInt16LE(i * 4) + payload.readInt16LE(i * 4 + 2)) / 2), i * 2)
    pcm = mono
  }
  const playtime = Math.round((pcm.length / 2 / format.sampleRate) * 1000)
  return { pcm, sampleRate: format.sampleRate, playtime }
}
