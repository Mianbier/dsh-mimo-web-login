/**
 * 装配测试：用一个假 ctx 把插件真的跑起来。
 *
 * 这不是"语法检查"，而是照着 DSH 实际调用 apply(ctx, config) 的形状，
 * 验证：适配器注册成功、webServer 前缀挂上、HTTP 各路由真的能应答。
 */

import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 用一个临时 DSH_HOME，别碰用户真实数据
const home = mkdtempSync(join(tmpdir(), 'mimo-test-'))
process.env.DSH_HOME = home
// 自动化里绝不真的拉起浏览器窗口 —— 那会弹窗、抢焦点、还可能挂满 5 分钟。
process.env.DSH_MIMO_LOGIN_DISABLED = '1'

const { apply, name, inject } = await import('../index.js')

const results = []
const log = (text) => {
  results.push(text)
  console.log(text)
}

const cleanups = []
const registered = { adapters: [], routes: [] }

/**
 * 假 ctx —— 刻意"抠门"，只给 inject 声明过的服务。
 *
 * ⚠️ 这个教训是真实事故换来的：之前这里大方地提供了 `setInterval`，
 * 于是插件里 `ctx.setInterval?.(...)` 在测试里跑得好好的，装到真 DSH 上却
 * 直接抛 "cannot get property timer without inject" —— Cordis 的服务属性
 * 是 **getter**，未 inject 时读取本身就抛，`?.` 根本拦不住，
 * `ctx.effect()` 里一抛，整个插件条目就 "did not activate"，后面的
 * `webServer.register` 全不执行 → 面板请求落到 SPA fallback → 405。
 *
 * 所以这里用 Proxy 模拟 Cordis 的严格语义：访问未声明的服务名直接抛错。
 * 插件必须靠 `inject` 声明的服务干活，多要一个都得先声明。
 */
const INJECTED = new Set(['llm', 'webServer'])
const ctxBase = {
  logger: {
    info: () => {},
    warn: () => {},
    debug: () => {},
  },
  effect(fn, label) {
    const dispose = typeof fn === 'function' ? fn() : undefined
    if (typeof dispose === 'function') cleanups.push(dispose)
    return () => {}
  },
  llm: {
    registerAdapter(providers, adapter) {
      registered.adapters.push({ providers, adapter })
      return () => {}
    },
    // 宿主可能没有 listProviders —— 面板要能优雅降级
    listProviders() {
      return registered.adapters.flatMap((item) => item.providers)
    },
  },
  webServer: {
    register(route) {
      registered.routes.push(route)
      return () => {}
    },
  },
  get(name) {
    // 惰性服务查询；未声明的一律拿不到（真实宿主也是这个行为）
    return INJECTED.has(name) ? ctxBase[name] : undefined
  },
}

/** Cordis 里不在 inject 列表中的服务名 —— 访问即抛。 */
const FORBIDDEN_SERVICES = new Set(['setInterval', 'setTimeout', 'timer', 'attachments', 'slots'])

const ctx = new Proxy(ctxBase, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && FORBIDDEN_SERVICES.has(prop) && !INJECTED.has(prop)) {
      // 模拟 Cordis：未 inject 的服务属性是 getter，读取即抛
      throw new Error(`cannot get property "${prop}" without inject`)
    }
    return Reflect.get(target, prop, receiver)
  },
})

// 拦截 unhandled rejection —— 插件的定时探活不该在无账号时炸
process.on('unhandledRejection', (error) => {
  log(`✗ 未捕获的 rejection：${error?.message ?? error}`)
  process.exitCode = 1
})

apply(ctx, {})

// ① 注册形状
log(`name = ${name}`)
log(`inject = ${JSON.stringify(inject)}`)
assert.deepEqual(inject, ['llm', 'webServer'], 'inject 必须声明 llm 与 webServer')

assert.equal(registered.adapters.length, 1, '必须注册一个适配器')
const { providers, adapter } = registered.adapters[0]
assert.deepEqual(providers, ['mimo-web'], 'provider 路由名必须是 mimo-web')
log(`✓ 适配器已注册 provider=${providers.join(',')}`)

// ② 适配器契约
for (const method of ['providerInfo', 'providerRetryPolicy', 'imageRequestPricing', 'listModels', 'resolveModel', 'prepareCall', 'stream']) {
  assert.equal(typeof adapter[method], 'function', `适配器缺方法 ${method}`)
}
log('✓ 七个契约方法齐全')

const info = adapter.providerInfo('mimo-web')
assert.equal(info.id, 'mimo-web')
log(`✓ providerInfo → ${info.name}`)

const policy = adapter.providerRetryPolicy('mimo-web')
assert.ok(policy, '必须有重试策略')
for (const key of ['mode', 'maxRetries', 'retryableCodes', 'initialDelayMs', 'maxDelayMs', 'jitterRatio']) {
  assert.ok(key in policy, `重试策略缺扁平字段 ${key}`)
}
assert.equal(policy.backoff, undefined, '重试策略不能包一层 backoff（会让 maxDelayMs 变 undefined）')
assert.ok(Array.isArray(policy.retryableCodes))
log(`✓ 重试策略扁平且完整（maxRetries=${policy.maxRetries}, maxDelayMs=${policy.maxDelayMs}）`)

assert.equal(adapter.imageRequestPricing('mimo-web', 'x'), undefined, 'imageRequestPricing 必须同步返回 undefined')
log('✓ imageRequestPricing 同步返回 undefined')

// ③ 未登录时的行为
const models = await adapter.listModels('mimo-web')
assert.ok(Array.isArray(models) && models.length > 0, '未登录也要有兜底模型，否则模型选择器一片空白')
for (const model of models) {
  assert.equal(model.provider, 'mimo-web')
  assert.ok(typeof model.id === 'string' && model.id.length > 0)
  assert.ok(typeof model.name === 'string' && model.name.length > 0)
}
log(`✓ 未登录时 listModels 返回 ${models.length} 个兜底模型：${models.map((m) => m.id).join(', ')}`)

const resolved = await adapter.resolveModel('mimo-web', 'mimo-v2.6-pro')
assert.equal(resolved.id, 'mimo-v2.6-pro')
assert.equal(resolved.provider, 'mimo-web')
assert.ok(resolved.context.contextWindow > 0, '必须声明 contextWindow')
assert.ok(Array.isArray(resolved.reasoning.efforts) && resolved.reasoning.efforts.length > 0)
log(`✓ resolveModel → contextWindow=${resolved.context.contextWindow}, efforts=${resolved.reasoning.efforts.map((e) => e.id).join('/')}`)

// ⚠️ 宿主的真实调用方式是**把方法摘下来单独跑**（dsh-llm: `registration.adapter.prepareCall(...)`），
// 所以适配器内部不能依赖 `this`。这一条专门守它。
const detachedPrepareCall = adapter.prepareCall.bind(undefined)
const prepared = await detachedPrepareCall('mimo-web', 'mimo-v2.6-flash')
assert.ok(prepared.model, 'prepareCall 必须返回 model')
assert.equal(prepared.model.id, 'mimo-v2.6-flash')
assert.equal(typeof prepared.stream, 'function', 'prepareCall 必须返回 stream')
log('✓ prepareCall 在 this 为 undefined 时也能工作（宿主就是这么调的）')

// prepareCall 返回的 stream 也要能用
const preparedChunks = []
for await (const chunk of prepared.stream({
  model: 'mimo-v2.6-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  system: 'sys',
  tools: [],
})) {
  preparedChunks.push(chunk)
}
assert.ok(preparedChunks.some((chunk) => chunk.type === 'finish'), 'prepared.stream 必须能跑到 finish')
log('✓ prepareCall().stream 可正常执行')

// 未登录时 stream 必须给出可读的 MISSING_CREDENTIAL，而不是抛异常
const chunks = []
for await (const chunk of adapter.stream({ model: 'mimo-v2.6-pro', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], system: 'sys', tools: [] })) {
  chunks.push(chunk)
}
const finish = chunks.find((chunk) => chunk.type === 'finish')
assert.ok(finish, '必须有 finish')
assert.equal(finish.reason.kind, 'error')
assert.equal(finish.reason.failure.code, 'MISSING_CREDENTIAL')
assert.ok(finish.reason.failure.message.includes('设置'), '提示里要告诉用户去哪里登录')
log(`✓ 未登录 stream → ${finish.reason.failure.code}（提示可读）`)

// ④ HTTP 路由
assert.equal(registered.routes.length, 1, '必须挂一个 webServer 路由')
const route = registered.routes[0]
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/mimo-web-login/api')
log(`✓ webServer 路由 ${route.path}`)

// 起个真服务，把 handler 当普通中间件用
const server = createServer((req, res) => {
  route.handler(req, res).catch((error) => {
    res.writeHead(500)
    res.end(String(error?.message ?? error))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}/mimo-web-login/api`

async function call(path, init) {
  const response = await fetch(base + path, init)
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text }
}

const status = await call('/status')
assert.equal(status.status, 200, `/status 应 200，实际 ${status.status}: ${status.text.slice(0, 200)}`)
assert.equal(status.json.provider, 'mimo-web')
assert.equal(status.json.loggedIn, false, '新目录下不应有登录态')
assert.ok(Array.isArray(status.json.accounts))
assert.ok(status.json.dataDir.startsWith(home), '数据目录应在测试用 DSH_HOME 下')
assert.ok(status.json.capabilities, '要报告登录能力（哪条路可用）')
log(`✓ GET /status → loggedIn=${status.json.loggedIn}, 浏览器=${status.json.capabilities.systemBrowser ? '有' : '无'}, Electron窗口=${status.json.capabilities.electronWindow}`)

// 面板诊断所需的字段一个都不能少
const diag = status.json.diagnostics
assert.ok(diag, '/status 必须带 diagnostics')
for (const key of ['tokenTtlMs', 'hasServiceToken', 'hasUserId', 'hasPh', 'tokenLength', 'transport']) {
  assert.ok(key in diag, `diagnostics 缺字段 ${key}`)
}
assert.equal(diag.tokenTtlMs, 24 * 60 * 60 * 1000)
assert.ok(status.json.usage, '/status 必须带 usage 汇总')
for (const key of ['today', 'recent', 'byDay', 'total']) {
  assert.ok(key in status.json.usage, `usage 缺字段 ${key}`)
}
assert.ok(status.json.defaults, '/status 必须带 defaults 供「恢复默认」用')
assert.ok(status.json.version, '/status 必须带 version 供「关于」页显示')
assert.equal(status.json.capabilities.route, 'mimo-web')
log(`✓ diagnostics/usage/defaults/version 字段齐全（version=${status.json.version}，ttl=24h）`)

const modelsRoute = await call('/models')
assert.equal(modelsRoute.status, 200)
assert.ok(Array.isArray(modelsRoute.json.models))
log(`✓ GET /models → ${modelsRoute.json.models.length} 个模型${modelsRoute.json.error ? `（${modelsRoute.json.error}）` : ''}`)

const settingsRoute = await call('/settings')
assert.equal(settingsRoute.status, 200)
assert.ok(settingsRoute.json.settings, '要返回当前设置')
assert.ok(settingsRoute.json.defaults, '要返回默认值供面板渲染')
log(`✓ GET /settings → thinking=${settingsRoute.json.settings.thinking}, maxImages=${settingsRoute.json.settings.maxImages}`)

const saveSettings = await call('/settings', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ thinking: false, maxImages: 3 }),
})
assert.equal(saveSettings.status, 200)
assert.equal(saveSettings.json.settings.thinking, false)
assert.equal(saveSettings.json.settings.maxImages, 3)
log('✓ POST /settings 保存生效')

const badSettings = await call('/settings', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ thinking: 'yes' }),
})
assert.equal(badSettings.status, 400, '类型不对要拒绝')
log(`✓ POST /settings 类型校验生效（${badSettings.json.error}）`)

const verify = await call('/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
assert.equal(verify.status, 404, '没有账号时校验应 404')
log(`✓ POST /verify 无账号 → 404（${verify.json.error}）`)

const tokenMissing = await call('/token', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ serviceToken: 'abc' }),
})
assert.equal(tokenMissing.status, 400)
assert.ok(tokenMissing.json.error.includes('userId'))
log(`✓ POST /token 缺字段 → 400（${tokenMissing.json.error}）`)

const unknown = await call('/nope')
assert.equal(unknown.status, 404)
log('✓ 未知路由 → 404')

// ⑤ 手动凭据落库（不发网络请求：给一个必然失败的 token，只验落盘与去重）
const before = await call('/status')
const tokenSave = await call('/token', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ serviceToken: 'x'.repeat(40), userId: '99999', xiaomichatbotPh: 'ph' }),
})
assert.equal(tokenSave.status, 200)
assert.equal(tokenSave.json.ok, true)
log(`✓ POST /token 落库成功（verified=${tokenSave.json.verified}）`)

const after = await call('/status')
assert.equal(after.json.accounts.length, before.json.accounts.length + 1, '账号库应多一条')
assert.equal(after.json.loggedIn, true)
log(`✓ 账号库 → ${after.json.accounts.length} 条，当前=${after.json.account.displayName}`)

// 同一个 userId 再存一次必须原地更新，不能堆记录
await call('/token', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ serviceToken: 'y'.repeat(40), userId: '99999', xiaomichatbotPh: 'ph2' }),
})
const dedup = await call('/status')
assert.equal(dedup.json.accounts.length, after.json.accounts.length, '同 userId 必须原地更新，不能堆记录')
log(`✓ 同 userId 重复保存 → 仍是 ${dedup.json.accounts.length} 条（原地更新）`)

const logout = await call('/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
assert.equal(logout.status, 200)
const loggedOut = await call('/status')
assert.equal(loggedOut.json.loggedIn, false)
log('✓ POST /logout 清除凭据')

// ⑥ 登录必须是异步的：不能把 HTTP 请求挂 5 分钟
//    这里只验"立刻返回"这一条 —— 真的开窗口要人操作，不在自动化里跑。
const loginStart = Date.now()
const loginCall = await call('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
const loginElapsed = Date.now() - loginStart
assert.equal(loginCall.status, 202, `登录接口应立刻回 202，实际 ${loginCall.status}`)
assert.equal(loginCall.json.started, true)
log(`✓ POST /login 立刻返回 202（${loginElapsed} ms），不阻塞`)

// 第二个并发登录必须被挡住（两个窗口会抢同一个 profile）
const secondLogin = await call('/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
assert.ok(secondLogin.status === 409 || secondLogin.status === 202, `并发登录应 409，实际 ${secondLogin.status}`)
log(`✓ 并发登录保护 → ${secondLogin.status}`)

// 让后台登录任务收尾（它会因为找不到可交互浏览器而失败，这是预期的）
await new Promise((resolve) => setTimeout(resolve, 2500))
const afterLogin = await call('/status')
assert.equal(afterLogin.json.login.running, false, '登录任务应已收尾')
log(`✓ 登录任务已收尾（result.ok=${afterLogin.json.login.result?.ok ?? 'undefined'}）`)

// ⑦ 用量台账：直接调 noteCall 落几笔，再看汇总能不能读出来
const { noteCall, summarize, resetUsage } = await import('../lib/usage.js')
noteCall({ ok: true, purpose: 'chat', ms: 1234, model: 'mimo-v2.6-flash', inputTokens: 100, outputTokens: 50, toolCalls: 2 })
// 隔一点时间再记一笔 —— 间隔统计要求 gap > 0（同一毫秒的两条会被正确地忽略）
await new Promise((resolve) => setTimeout(resolve, 120))
noteCall({ ok: false, purpose: 'chat', ms: 800, model: 'mimo-v2.6-flash', code: 'RATE_LIMIT' })

const summary = summarize()
assert.equal(summary.today.calls, 2, `今天应有 2 次调用，实际 ${summary.today.calls}`)
assert.equal(summary.today.ok, 1)
assert.equal(summary.today.inputTokens, 100)
assert.equal(summary.today.outputTokens, 50)
assert.equal(summary.total.toolCalls, 2)
assert.equal(summary.total.failureByCode.RATE_LIMIT, 1, '失败分类要记到码上')
assert.ok(summary.total.minGapMs > 0, `相邻间隔要算得出来，实际 ${summary.total.minGapMs}`)
log(`✓ 台账记录 → 今天 ${summary.today.calls} 次 / 成功 ${summary.today.ok} / 失败码 ${JSON.stringify(summary.total.failureByCode)} / 最短间隔 ${summary.total.minGapMs}ms`)

// 台账不能让 /status 崩（数字必须是有限值，DSH 拒收 NaN）
const withUsage = await call('/status')
assert.equal(withUsage.status, 200)
assert.equal(withUsage.json.usage.today.calls, 2)
assert.ok(Number.isFinite(withUsage.json.usage.total.medianGapMs), 'medianGapMs 必须是有限数')
log('✓ /status 带出台账，数值全部有限')

const resetCall = await call('/usage/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
assert.equal(resetCall.status, 200)
assert.equal(resetCall.json.ok, true)
assert.equal(summarize().today.calls, 0, '清空后台账应为空')
log('✓ POST /usage/reset 清空台账')

server.close()
for (const dispose of cleanups) {
  try {
    dispose()
  } catch {
    /* 已释放 */
  }
}

log('')
log(process.exitCode ? '装配测试发现异常' : '装配测试全部通过 ✓')
