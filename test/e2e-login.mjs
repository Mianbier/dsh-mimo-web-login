/**
 * 手动端到端验证：真的走一遍「开浏览器 → 你登录 → 读凭据 → 发消息」。
 *
 * 跑法：
 *     node test/e2e-login.mjs
 *
 * 它会：
 *   1. 用独立 profile 拉起 Edge/Chrome，打开 MiMo 登录页；
 *   2. 等你在窗口里完成登录（最多 5 分钟）；
 *   3. 读到三个 Cookie 后打一条最小的对话请求，把 SSE 事件序列打出来；
 *   4. 凭据只写进**临时目录**，跑完就删 —— 不动你的真实账号库。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'mimo-e2e-'))
process.env.DSH_HOME = home
process.env.DSH_MIMO_LOGIN_TIMEOUT_MS = '300000'

const { captureLogin } = await import('../lib/browser-login.js')
const { MimoClient } = await import('../lib/mimo-client.js')

const stamp = () => new Date().toISOString().slice(11, 19)
const log = (text) => console.log(`[${stamp()}] ${text}`)

log('准备打开登录窗口 …')
log('👉 请在弹出的浏览器里登录小米账号，登录成功后窗口会自动关闭。')

let captured
try {
  captured = await captureLogin({
    timeoutMs: 5 * 60 * 1000,
    onProgress: (message) => log(message),
  })
} catch (error) {
  log(`✗ 捕获失败：${error?.message ?? error}`)
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

log(`✓ 已读到凭据（via=${captured.via}）`)
log(`  serviceToken 长度 ${captured.serviceToken.length}，userId=${captured.userId}`)

// ① 只读探活
const client = new MimoClient(captured, { idleTimeoutMs: 120000 })
const who = await client.whoami()
log(who.ok ? '✓ 探活通过' : `✗ 探活失败：${who.error?.message ?? who.error?.code}`)

if (!who.ok) {
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

// ② 真发一条消息
const model = process.argv[2] || 'mimo-v2.6-flash'
log(`发起对话：model=${model}`)
const started = Date.now()
let text = ''
let reasoning = ''
let usage
let failure
const kinds = []

try {
  for await (const event of client.chat({
    msgId: Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32),
    conversationId: Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32),
    query: '用一句话回答：你好，请回复"收到"两个字。',
    isEditedQuery: false,
    modelConfig: { enableThinking: false, webSearchStatus: 'disabled', model },
    multiMedias: [],
  })) {
    kinds.push(event.kind)
    if (event.kind === 'text') text += event.text
    if (event.kind === 'reasoning') reasoning += event.text
    if (event.kind === 'usage') usage = event.usage
    if (event.kind === 'error') failure = event.message
    if (kinds.length > 500) break
  }
} catch (error) {
  log(`✗ 对话失败：${error?.message ?? error}（code=${error?.code}）`)
  rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

log(`事件序列：${kinds.join(' → ')}`)
log(`耗时 ${Date.now() - started} ms`)
if (reasoning) log(`思考内容（前 200 字）：${reasoning.slice(0, 200)}`)
if (failure) log(`✗ 上游报错：${failure}`)
else log(`✓ 正文：${JSON.stringify(text.slice(0, 300))}`)
if (usage) log(`usage：${JSON.stringify(usage)}`)

rmSync(home, { recursive: true, force: true })
log(text && !failure ? '\n端到端验证通过 ✓' : '\n端到端验证未拿到正文 ✗')
process.exitCode = text && !failure ? 0 : 1
