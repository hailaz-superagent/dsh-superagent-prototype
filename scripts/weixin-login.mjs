#!/usr/bin/env node
/**
 * Personal WeChat QR login for the dsh-superagent weixin Source.
 *
 * It performs the same iLink bot login as the official OpenClaw Weixin plugin,
 * writes the token to a 0600 JSON file, and prints where that file is. Point the
 * Source's "login file" field at it (a relative path is under the Superagent
 * state directory), then enable the Source.
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

const FIXED_BASE = 'https://ilinkai.weixin.qq.com'
const BOT_TYPE = '3'
const ILINK_APP_ID = 'bot'
const ILINK_CLIENT_VERSION = '131082'
const POLL_TIMEOUT_MS = 35_000
const MAX_REFRESH = 3

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}
const base = arg('base', FIXED_BASE)
const botType = arg('bot-type', BOT_TYPE)
const timeoutMs = Number(arg('timeout', '480')) * 1000
const out = arg('out', join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'state', 'superagent', 'weixin-account.json'))
const printToken = process.argv.includes('--print-token')

function uin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString('base64')
}
function headers() {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': ILINK_CLIENT_VERSION,
    'X-WECHAT-UIN': uin(),
  }
}
function apiBase(value) {
  const text = String(value || FIXED_BASE).trim()
  return /^https?:\/\//.test(text) ? text.replace(/\/+$/, '') : `https://${text.replace(/\/+$/, '')}`
}
async function post(url, body) {
  const response = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body) })
  const text = await response.text()
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}
async function get(url, timeout = POLL_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, { headers: headers(), signal: controller.signal })
    const text = await response.text()
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 200)}`)
    return JSON.parse(text)
  } finally { clearTimeout(timer) }
}

async function fetchQr() {
  const result = await post(`${apiBase(base)}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, { local_token_list: [] })
  if (!result.qrcode || !result.qrcode_img_content) throw new Error('The gateway returned no QR code')
  return result
}
async function showQr(qr) {
  try {
    const { default: qrcode } = await import('qrcode-terminal')
    qrcode.generate(qr.qrcode_img_content, { small: true })
  } catch {
    console.log('(qrcode-terminal is not installed; open or encode this link yourself)')
  }
  console.log(`二维码链接 / QR link: ${qr.qrcode_img_content}`)
}

const rl = createInterface({ input: stdin, output: stdout })
let qr = await fetchQr()
let pollingBase = apiBase(base)
let refreshCount = 0
let scanned = false
let verifyCode = ''
const deadline = Date.now() + timeoutMs
console.log('用手机微信扫描二维码，确认登录个人微信。/ Scan this QR code with WeChat.')
console.log(`登录状态将写入 / The login will be written to: ${out}`)
await showQr(qr)

while (Date.now() < deadline) {
  let status
  try {
    const verify = verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ''
    status = await get(`${pollingBase}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qr.qrcode)}${verify}`)
  } catch (error) {
    if (error?.name === 'AbortError') { await new Promise(resolve => setTimeout(resolve, 1000)); continue }
    console.error(`轮询登录状态失败，继续重试 / Login status poll failed, retrying: ${String(error)}`)
    await new Promise(resolve => setTimeout(resolve, 2000))
    continue
  }
  switch (status.status) {
    case 'wait':
      break
    case 'scaned':
      verifyCode = ''
      if (!scanned) { console.log('已扫码，在手机上确认 / Scanned; confirm on your phone.'); scanned = true }
      break
    case 'scaned_but_redirect':
      if (status.redirect_host) pollingBase = apiBase(status.redirect_host)
      break
    case 'need_verifycode': {
      verifyCode = (await rl.question('输入手机微信显示的数字，以继续连接 / Enter the number shown in WeChat: ')).trim()
      console.log('已提交验证码，继续等待 / Verify code submitted, waiting.')
      break
    }
    case 'expired': {
      refreshCount += 1
      if (refreshCount > MAX_REFRESH) { console.error('二维码多次失效，请重新运行 / QR expired too many times; run again.'); process.exit(1) }
      qr = await fetchQr()
      await showQr(qr)
      console.log(`二维码已刷新 (${refreshCount}/${MAX_REFRESH}) / QR refreshed.`)
      break
    }
    case 'verify_code_blocked': {
      refreshCount += 1
      if (refreshCount > MAX_REFRESH) { console.error('验证码多次错误，请稍后再试 / Too many wrong codes; try later.'); process.exit(1) }
      qr = await fetchQr()
      await showQr(qr)
      console.log('验证码多次错误，二维码已刷新 / Code blocked; QR refreshed.')
      break
    }
    case 'binded_redirect':
      console.error('这个微信已经绑定过 OpenClaw；没有签发新 token。请使用已有的登录凭证，或先在 OpenClaw 侧解绑。')
      console.error('This Weixin account is already bound to an OpenClaw instance; no new token was issued.')
      process.exit(2)
      break
    case 'confirmed': {
      if (!status.bot_token || !status.ilink_bot_id) {
        console.error('登录已确认，但网关没有返回 token 或账号 id / Confirmed without a token or account id.')
        process.exit(1)
      }
      mkdirSync(dirname(out), { recursive: true, mode: 0o700 })
      const data = {
        token: status.bot_token,
        baseUrl: apiBase(status.baseurl || pollingBase),
        accountId: status.ilink_bot_id,
        ...status.ilink_user_id ? { userId: status.ilink_user_id } : {},
        savedAt: new Date().toISOString(),
      }
      writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
      chmodSync(out, 0o600)
      console.log(`\n✅ 登录成功 / Logged in as ${status.ilink_bot_id}`)
      console.log(`凭证文件 / Login file: ${out}`)
      console.log('在 Source 设置里把「登录凭证文件」填成这个路径，然后启用个人微信 Source。')
      console.log('Set the Source\'s login-file field to this path, then enable the personal WeChat Source.')
      if (printToken) console.log(`token: ${status.bot_token}`)
      rl.close()
      process.exit(0)
    }
    default:
      console.log(`未识别的登录状态 / Unknown login status: ${String(status.status)}`)
  }
  await new Promise(resolve => setTimeout(resolve, 1000))
}
console.error('登录超时，请重新运行 / Login timed out; run again.')
process.exit(1)
