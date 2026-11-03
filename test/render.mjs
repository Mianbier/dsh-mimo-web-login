/**
 * 渲染冒烟测试。
 *
 * client.js 通过 `slots.register(..., () => h(Panel))` 注册面板，
 * 真实 DSH 渲染时按当前 tab state 分发到 5 个业务组件。
 * 这里不能用「传 initialTab」驱动其它页签 —— register 的包装函数不转发 props，
 * Panel 会回落到默认 account 页（这正是真实行为）。
 *
 * 所以本测试分两段：
 *  1. 渲染完整 Panel（默认 account 页），验证账号页签 + 诊断行 + tabs 骨架。
 *  2. 直接实例化 4 个业务组件（ModelTab / UsageTab / SettingsTab / AboutTab），
 *     注入真实数据，逐页签验证 JSX 求值不抛错、关键文案进到输出。
 *     这一步等价于"用户点进该页签"。
 *
 * 替身要点：hook 按整棵树单调递增对齐真实 React。
 */

import fs from 'node:fs'
import assert from 'node:assert/strict'

const results = []
const log = (text) => {
  results.push(text)
  console.log(text)
}

let hookArr = []
let hookIdx = 0
let effects = []
let disposers = []

function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
}

const React = {
  createElement,
  Fragment: Symbol('fragment'),
  useState(initial) {
    const i = hookIdx++
    if (!(i in hookArr)) hookArr[i] = typeof initial === 'function' ? initial() : initial
    return [hookArr[i], (next) => { hookArr[i] = typeof next === 'function' ? next(hookArr[i]) : next }]
  },
  useEffect(fn) { effects.push({ fn, i: hookIdx++ }) },
  useCallback(fn) { hookIdx += 1; return fn },
  useMemo(fn) { const i = hookIdx++; if (!(i in hookArr)) hookArr[i] = fn(); return hookArr[i] },
  useRef(initial) { const i = hookIdx++; if (!(i in hookArr)) hookArr[i] = { current: initial }; return hookArr[i] },
}

function render(element, depth = 0) {
  if (depth > 90) return ''
  if (element === null || element === undefined || element === false || element === true) return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map((c) => render(c, depth)).filter(Boolean).join('')
  if (typeof element.type === 'function') {
    let out
    try {
      out = element.type(element.props)
    } catch (error) {
      const name = element.type.name || 'anonymous'
      throw new Error(`组件 ${name} 渲染抛错：${error?.message ?? error}`)
    }
    return render(out, depth + 1)
  }
  return render(element.children, depth + 1)
}

// ── 宿主替身，注册插件 ─────────────────────────────────────────────────
let registered = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) { registered = { id, mod: factory((name) => (name === 'react' ? React : {})) } },
  },
}
globalThis.document = {
  head: { appendChild() {} },
  createElement: () => ({ setAttribute() {}, style: {}, remove() {}, textContent: '' }),
}

const now = Date.now()
const statusPayload = {
  provider: 'mimo-web',
  loggedIn: true,
  account: { id: 'acc-1', displayName: '138****8888', userId: '12345678', capturedAt: new Date(now - 3 * 3600 * 1000).toISOString(), verifiedAt: new Date(now - 3600 * 1000).toISOString(), stale: false },
  accounts: [
    { id: 'acc-1', displayName: '138****8888', current: true, capturedAt: new Date(now - 3 * 3600 * 1000).toISOString(), verifiedAt: new Date(now - 3600 * 1000).toISOString(), token: 'abcd…1234', stale: false },
    { id: 'acc-2', displayName: 'lidi****@gmail.com', current: false, capturedAt: new Date(now - 30 * 3600 * 1000).toISOString(), token: 'efgh…5678', stale: true, lastError: { at: new Date().toISOString(), message: '登录态已失效（401）' } },
  ],
  settings: { thinking: true, webSearch: 'disabled', maxImages: 12, maxPromptChars: 240000, contextWindow: 262144, minIntervalMs: 1200, idleTimeoutMs: 180000, allowConcurrent: false, probeIntervalMs: 1800000, enabledModels: [] },
  defaults: { thinking: true, maxImages: 12, maxPromptChars: 240000, contextWindow: 262144, minIntervalMs: 1200, idleTimeoutMs: 180000, allowConcurrent: false, probeIntervalMs: 1800000, enabledModels: [] },
  capabilities: { systemBrowser: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', electronWindow: false, adapterRegistered: true, route: 'mimo-web' },
  diagnostics: { tokenAgeMs: 3 * 3600 * 1000, tokenTtlMs: 24 * 3600 * 1000, hasServiceToken: true, hasUserId: true, hasPh: true, tokenLength: 64, transport: 'node-fetch', thinking: true, webSearch: 'disabled' },
  usage: {
    today: { calls: 12, ok: 11, inputTokens: 45678, outputTokens: 12345 },
    recent: [
      { at: now, ok: true, model: 'mimo-v2.6-pro', ms: 3200, inputTokens: 1000, outputTokens: 300 },
      { at: now - 60000, ok: false, model: 'mimo-v2.6-flash', ms: 800, code: 'RATE_LIMIT' },
    ],
    byDay: [
      { date: new Date().toISOString().slice(0, 10), calls: 12, ok: 11, inputTokens: 45678, outputTokens: 12345 },
      { date: new Date(now - 86400000).toISOString().slice(0, 10), calls: 5, ok: 5, inputTokens: 1000, outputTokens: 200 },
    ],
    total: { calls: 17, ok: 16, failures: 1, failureByCode: { RATE_LIMIT: 1 }, medianGapMs: 4200, p90GapMs: 12000, minGapMs: 1500, toolCalls: 7 },
  },
  login: { running: false, messages: [], startedAt: 0 },
  dataDir: 'C:\\Users\\me\\.dsh\\mimo-web',
  tokenTtlMs: 24 * 3600 * 1000,
  version: '1.0.0',
}
const modelsPayload = { models: [{ id: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', description: '旗舰', thinkingDefaultOn: true }, { id: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash', description: '高性价比', thinkingDefaultOn: true }], enabled: [] }
globalThis.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes('/models') ? modelsPayload : statusPayload) })

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
new Function(source)()
assert.ok(registered, '客户端模块没有注册到 __ModuleLoader__')
log(`✓ 模块已注册：id=${registered.id}`)

let panelComp = null
const business = {}
const businessNames = ['AccountTab', 'ModelTab', 'UsageTab', 'SettingsTab', 'AboutTab']
registered.mod.apply({
  effect(fn) { const c = fn(); if (typeof c === 'function') disposers.push(c) },
  slots: {
    inject(name, register) { register() },
    register(options, component) {
      if (options.id === 'mimo-web-login') panelComp = component
      return () => {}
    },
  },
})
assert.ok(panelComp, '没有注册 settings.section 面板')
log('✓ apply() 注册了 settings.section 面板')

// ── 段 1：完整 Panel（默认 account 页签） ──────────────────────────────
async function mountPanel() {
  hookArr = []; hookIdx = 0; effects = []
  let tree = render(createElement(panelComp))
  for (const e of effects) { const c = e.fn(); if (typeof c === 'function') disposers.push(c) }
  await new Promise((resolve) => setTimeout(resolve, 5))
  hookIdx = 0; effects = []
  tree = render(createElement(panelComp))
  return tree
}

const panelTree = await mountPanel()
for (const text of ['MiMo 网页登录', '账号', '模型', '统计', '参数', '关于', '登录状态', '适配器注册', '凭据来源', '登录新账号', '138****8888', '数据位置']) {
  assert.ok(panelTree.includes(text), `Panel 缺内容：${text}`)
}
log(`✓ 完整 Panel 渲染正常（${panelTree.length} 字符，含 5 页签骨架 + 账号页诊断行）`)

// ── 段 2：逐业务组件渲染（等价用户切页签） ─────────────────────────────
function renderComponent(renderFn, displayName) {
  hookArr = []; hookIdx = 0; effects = []
  let out
  try {
    out = renderFn()
  } catch (error) {
    throw new Error(`组件 ${displayName} 渲染抛错：${error?.message ?? error}`)
  }
  return out
}

const STATUS_WITH_MODELS = { ...statusPayload, __models: modelsPayload.models }

// 从闭包里拿不到业务组件，需要 client.js 把它们传出来 ——
// 通过 register 的 component 无法直接取。改用：从 client.js 源码里无法动态导出。
// 因此我们直接复用 Panel 内部，用 createElement 模拟用户点进各页签不可行（tab 不上传）。
// 方案：把业务组件通过注入的 react 差异无法拿 —— 我们改为在 client.js 的 Panel
// 分发处不强测，而是通过「临时把组件挂到 window」的 hook 不支持。
// 最务实：这里验证客户端的 4 个业务组件，只能通过让 client.js 暴露。

// 说明：由于 client.js 只在 apply 里通过 slots.register 暴露 Panel，业务组件在闭包内，
// 测试脚本无法直接引用。为了真正测它们，我们在加载前给 client.js 的模块注入一个
// 全局注册点 —— 在源码字符串上做一个受控替换，把所有 `function ModelTab` 等
// 插桩到 window.__mw__ 上。这不会改变生产逻辑，只是测试插桩。
function instrumentedSource(src) {
  const names = ['AccountTab', 'ModelTab', 'UsageTab', 'SettingsTab', 'AboutTab']
  let out = src
  for (const n of names) {
    out = out.replace(
      new RegExp(`function ${n}\\(`),
      (m) => `(globalThis.__mwbiz__ ||= {})['${n}'] = ${n}; function ${n}(`,
    )
  }
  return out
}

// 用插桩源码重新加载
globalThis.__mwbiz__ = {}
new Function(instrumentedSource(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')))()
assert.ok(globalThis.__mwbiz__.AccountTab && globalThis.__mwbiz__.ModelTab, '插桩没拿到业务组件')

const mockApi = {
  act: async (label, fn) => fn(),
  reload: async () => {},
}
const mockAction = { setMsg() {}, setBusy() {} }

// 账号页前提是 Panel 已经测过；这里单独测占位组件不重复。直接测其余 4 个。
const cases = [
  ['ModelTab', globalThis.__mwbiz__.ModelTab,
    () => renderComponent(() => render(createElement(globalThis.__mwbiz__.ModelTab, { status: statusPayload, models: modelsPayload.models, busy: false, act: mockApi.act, reload: mockApi.reload, modelsError: '' })), 'ModelTab'),
    ['可用模型', 'MiMo-V2.6-Pro', 'MiMo-V2.6-Flash']],
  ['UsageTab', globalThis.__mwbiz__.UsageTab,
    () => renderComponent(() => render(createElement(globalThis.__mwbiz__.UsageTab, { status: STATUS_WITH_MODELS, busy: false, act: mockApi.act })), 'UsageTab'),
    ['今天', '连通性测试', '发送测试', '近 7 天']],
  ['SettingsTab', globalThis.__mwbiz__.SettingsTab,
    () => renderComponent(() => render(createElement(globalThis.__mwbiz__.SettingsTab, { status: statusPayload, busy: false, act: mockApi.act, reload: mockApi.reload })), 'SettingsTab'),
    ['默认思考', '网页搜索', '上下文窗口', '单轮最多图片', '恢复默认']],
  ['AboutTab', globalThis.__mwbiz__.AboutTab,
    () => renderComponent(() => render(createElement(globalThis.__mwbiz__.AboutTab, { status: statusPayload, models: modelsPayload.models })), 'AboutTab'),
    ['关于', '版本', 'provider', '传输层', '风险说明']],
]

for (const [label, , renderFn, expected] of cases) {
  const tree = renderFn()
  assert.ok(typeof tree === 'string' && tree.length > 0, `${label} 渲染为空`)
  const missing = expected.filter((text) => !tree.includes(text))
  assert.equal(missing.length, 0, `${label} 缺内容：${missing.join(', ')}`)
  log(`✓ ${label} 页签渲染正常（${tree.length} 字符）`)
}

for (const dispose of disposers) { try { dispose() } catch {} }

log('')
log('渲染冒烟测试通过 ✓')
fs.writeFileSync(new URL('./render-out.txt', import.meta.url), results.join('\n'), 'utf8')