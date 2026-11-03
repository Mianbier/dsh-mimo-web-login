/**
 * 离线测试：不碰网络、不碰真实账号，只验纯逻辑。
 *
 * 跑法：node test/offline.mjs
 */

import assert from 'node:assert/strict'

import { extractToolCalls, buildToolSection, toolProtocolInstructions, CALL_OPEN, CALL_CLOSE } from '../lib/tool-protocol.js'
import { MimoClient, MimoError, randomId, ORIGIN } from '../lib/mimo-client.js'
import { REQUIRED_COOKIES, LOGIN_URL } from '../lib/browser-login.js'
import { normalizeCookieValue } from '../lib/store.js'

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    const result = fn()
    if (result instanceof Promise) throw new Error('测试函数不应返回 Promise')
    passed += 1
  } catch (error) {
    failed += 1
    failures.push(`${name}\n    ${error?.message ?? error}`)
  }
}

async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failed += 1
    failures.push(`${name}\n    ${error?.message ?? error}`)
  }
}

// ── 工具协议解析 ────────────────────────────────────────────────────────

test('解析标准调用块（dsh-tool 围栏 + tool_calls）', () => {
  const raw = '```dsh-tool\n' + '{"tool_calls":[{"name":"read","arguments":{"file_path":"/tmp/a.txt"}}]}' + '\n```'
  const { calls, text } = extractToolCalls(raw)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'read')
  assert.deepEqual(JSON.parse(calls[0].arguments), { file_path: '/tmp/a.txt' })
  assert.equal(text, '')
})

test('一个 tool_calls 数组里放多个调用', () => {
  const raw = '```dsh-tool\n' + '{"tool_calls":[{"name":"a","arguments":{}},{"name":"b","arguments":{"x":1}}]}' + '\n```'
  const { calls } = extractToolCalls(raw)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].name, 'a')
  assert.equal(calls[1].name, 'b')
})

test('调用块外的正文被保留', () => {
  const raw = '我先看一下。\n```dsh-tool\n{"tool_calls":[{"name":"read","arguments":{}}]}\n```\n然后告诉你。'
  const { calls, text } = extractToolCalls(raw)
  assert.equal(calls.length, 1)
  assert.ok(text.includes('我先看一下'))
  assert.ok(text.includes('然后告诉你'))
})

test('容忍忘了写 dsh-tool 的普通围栏', () => {
  const raw = '```json\n{"tool_calls":[{"name":"search","arguments":{"q":"x"}}]}\n```'
  const { calls } = extractToolCalls(raw)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'search')
})

test('容忍裸 JSON（模型无视协议没写围栏）', () => {
  const raw = '好的：\n{"tool_calls":[{"name":"list_files","arguments":{"path":"."}}]}'
  const { calls } = extractToolCalls(raw)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'list_files')
})

test('Windows 路径不被静默破坏（\\n 是合法转义但会吃掉路径）', () => {
  const raw = '```dsh-tool\n' + '{"tool_calls":[{"name":"read","arguments":{"file_path":"C:\\\\Users\\\\me\\\\new.txt"}}]}' + '\n```'
  const { calls } = extractToolCalls(raw)
  assert.equal(calls.length, 1)
  const args = JSON.parse(calls[0].arguments)
  // 关键：\n 不能被解释成换行符，路径必须完整
  assert.equal(args.file_path, 'C:\\Users\\me\\new.txt')
  assert.ok(!args.file_path.includes('\n'))
})

test('非法 JSON 里的单反斜杠被修复', () => {
  // 用 String.raw 构造**真正**的非法 JSON：模型输出的是字面单反斜杠。
  const body = String.raw`{"tool_calls":[{"name":"read","arguments":{"file_path":"C:\Users\me\a.txt"}}]}`
  const raw = '```dsh-tool\n' + body + '\n```'
  const { calls } = extractToolCalls(raw)
  assert.equal(calls.length, 1)
  const args = JSON.parse(calls[0].arguments)
  assert.equal(args.file_path, 'C:\\Users\\me\\a.txt')
})

/**
 * 真实事故（用户截图）：模型把参数**平铺在调用对象上**，而不是放进 `arguments`。
 *
 * ```json
 * {"tool_calls":[{"name":"pwsh","command":"...","workdir":"...","timeoutMs":120000}]}
 * ```
 *
 * 旧解析器只认 `arguments` / `parameters` / `args` 三个键名 ⇒ 参数被丢光，
 * 变成 `pwsh {}` 的空调用，执行失败后整块 JSON 又被当作正文漏给用户。
 */
test('参数平铺在调用对象上也能解析（不是 arguments 嵌套）', () => {
  const body = '{"tool_calls":[{"name":"pwsh","command":"echo hi","workdir":"C:\\\\Users\\\\x","timeoutMs":120000}]}'
  const raw = '```dsh-tool\n' + body + '\n```'
  const { calls } = extractToolCalls(raw)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'pwsh')
  const args = JSON.parse(calls[0].arguments)
  assert.equal(args.command, 'echo hi', `命令不该丢，实际：${calls[0].arguments}`)
  assert.equal(args.workdir, 'C:\\Users\\x')
  assert.equal(args.timeoutMs, 120000)
  // 元信息不该被当成参数混进去
  assert.equal(args.name, undefined)
  assert.equal(args.description, undefined)
})

/**
 * 真实事故：模型自己说"围栏里多了一行字符导致格式坏了" —— 整段 JSON.parse 失败，
 * 于是整个调用被当正文漏出去。这种脏数据要能从里面救出 JSON。
 */
test('围栏里混入杂行时仍能抢救出调用', () => {
  const raw = [
    '```dsh-tool',
    '下面是要执行的调用：',
    '{"tool_calls":[{"name":"pwsh","command":"echo hi"}]}',
    '注意 workdir 是项目根',
    '```',
  ].join('\n')
  const { calls, text } = extractToolCalls(raw)
  assert.equal(calls.length, 1, `没救出来，正文还剩：${text}`)
  assert.equal(calls[0].name, 'pwsh')
  assert.equal(JSON.parse(calls[0].arguments).command, 'echo hi')
  assert.equal(text, '', '救出来之后不该再漏成正文')
})

test('合法转义 \\n 不会被静默变成换行符', () => {
  // 这一条是真实事故形状：`C:\note.txt` 里的 `\n` 是**合法** JSON 转义，
  // JSON.parse 会成功但把路径吃掉一半 —— 工具于是跑到一个不存在的路径上。
  const body = String.raw`{"tool_calls":[{"name":"read","arguments":{"file_path":"C:\note.txt"}}]}`
  const raw = '```dsh-tool\n' + body + '\n```'
  const { calls } = extractToolCalls(raw)
  const args = JSON.parse(calls[0].arguments)
  assert.equal(args.file_path, 'C:\\note.txt')
  assert.ok(!args.file_path.includes('\n'), '路径里不能有真换行')
})

test('解析失败时正文不被吞掉', () => {
  const raw = '```dsh-tool\n这不是 JSON\n```'
  const { calls, text } = extractToolCalls(raw)
  assert.equal(calls.length, 0)
  assert.ok(text.includes('这不是 JSON'))
})

test('XML 方言兜底', () => {
  const raw = `<invoke name="read_file"><parameter name="file_path">/tmp/x</parameter></invoke>`
  const { calls } = extractToolCalls(raw)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'read_file')
  assert.deepEqual(JSON.parse(calls[0].arguments), { file_path: '/tmp/x' })
})

test('CDATA 被剥掉', () => {
  const raw = `<invoke name="run"><parameter name="cmd"><![CDATA[echo hi]]></parameter></invoke>`
  const { calls } = extractToolCalls(raw)
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(calls[0].arguments).cmd, 'echo hi')
})

/**
 * 真实事故：「他这个没执行就直接发出来了」。
 *
 * 模型无视提示词里的禁令，吐了 Qwen/DeepSeek 系的
 * `<tool_call><function=名字></function></tool_call>` 方言，
 * 而旧解析器只认 `<mimo_tool_call>` / `<invoke>`，于是整段被当正文喷出来。
 * 截图里的原文还带畸形尾巴（`</tool_call>></function></tool_call>`）。
 */
test('<tool_call><function=…> 方言无参数也能识别', () => {
  const raw = `<tool_call><function=digital_life_status></function></tool_call>`
  const { text, calls } = extractToolCalls(raw)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'digital_life_status')
  assert.deepEqual(JSON.parse(calls[0].arguments), {})
  assert.equal(text, '', '不该把调用块留在正文里')
})

test('<tool_call> 畸形尾巴（截图原样）照样识别', () => {
  const raw = `<tool_call><function=digital_life_status></function></tool_call>></function></tool_call>`
  const { text, calls } = extractToolCalls(raw)
  assert.equal(calls.length, 1, `没解析出来，正文还剩：${text}`)
  assert.equal(calls[0].name, 'digital_life_status')
  assert.equal(text, '', `畸形标签残片不该留在正文：${text}`)
})

test('<tool_call> 方言的 parameter 语法', () => {
  const raw = `<tool_call><function=read><parameter=file_path>C:\\note.txt</parameter></function></tool_call>`
  const { calls } = extractToolCalls(raw)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].name, 'read')
  const args = JSON.parse(calls[0].arguments)
  assert.equal(args.file_path, 'C:\\note.txt', `路径不该被吃掉，实际：${JSON.stringify(args.file_path)}`)
})

test('<tool_call> 方言的 JSON 参数体', () => {
  const raw = `<tool_call><function=search>{"q":"hi"}</function></tool_call>`
  const { calls } = extractToolCalls(raw)
  assert.equal(JSON.parse(calls[0].arguments).q, 'hi')
})

test('<tool_call> 夹在正文中间时，正文保留', () => {
  const raw = `正文解释 <tool_call><function=x></function></tool_call> 结束`
  const { text, calls } = extractToolCalls(raw)
  assert.equal(calls.length, 1)
  assert.ok(text.includes('正文解释'), `正文应保留，实际：${text}`)
  assert.ok(!text.includes('tool_call'), `不该残留标签，实际：${text}`)
})

test('空输入安全', () => {
  assert.deepEqual(extractToolCalls(''), { text: '', calls: [] })
  assert.deepEqual(extractToolCalls(null), { text: '', calls: [] })
  assert.deepEqual(extractToolCalls(undefined), { text: '', calls: [] })
})

// ── 工具目录渲染 ────────────────────────────────────────────────────────

test('工具目录为空时返回空串', () => {
  assert.equal(buildToolSection([]), '')
  assert.equal(buildToolSection(null), '')
})

test('工具目录包含名字/描述/参数', () => {
  const section = buildToolSection([
    { name: 'read', description: '读取文件', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
  ])
  assert.ok(section.includes('### read'))
  assert.ok(section.includes('读取文件'))
  assert.ok(section.includes('file_path'))
})

test('超预算时把省略的工具名说出来', () => {
  const tools = []
  for (let i = 0; i < 40; i += 1) {
    tools.push({ name: `tool_${i}`, description: 'x'.repeat(500), parameters: { type: 'object' } })
  }
  const section = buildToolSection(tools, 3000)
  assert.ok(section.includes('没有描述'), '应给出省略提示')
  assert.ok(/tool_\d+/.test(section), '应列出被省略的工具名')
})

/**
 * 协议形状**照搬 dsh-deepseek-web-login**，这里的断言锁住那套形状不被改坏。
 *
 * 为什么用它那套：````dsh-tool` 围栏 + `{"tool_calls":[...]}` 是 OpenAI 原生
 * 字段名，模型对"围栏里放 JSON"这个形状极熟，而且天然不会被理解成
 * "我要假装调用工具"。我自己发明的 XML 标记则会被模型的先验知识顶回来。
 */
test('协议形状与 DeepSeek 插件一致（围栏 + tool_calls）', () => {
  const text = toolProtocolInstructions()
  assert.ok(text.includes('```dsh-tool'), '必须用 dsh-tool 围栏')
  assert.ok(text.includes('"tool_calls"'), '必须用 tool_calls 数组（OpenAI 原生形状）')
  assert.ok(text.includes('arguments'), '必须说明 arguments 字段')
  // 明确劝阻尖括号标记 —— 那会漏进可见正文
  assert.ok(/XML\/HTML|<tool_calls>|invoke/.test(text), '要明确劝阻 XML 方言')
})

// ── HTTP 客户端（假 fetch） ─────────────────────────────────────────────

function fakeFetch(handler) {
  return async (url, init) => handler(url, init)
}

function sseResponse(chunks) {
  const encoder = new TextEncoder()
  let index = 0
  const stream = new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[index]))
      index += 1
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const AUTH = { serviceToken: 'tok-1234567890', userId: '42', xiaomichatbotPh: 'ph-abc' }

await testAsync('Cookie 头包含三个字段（名字与真实站点一致）', async () => {
  const client = new MimoClient(AUTH)
  const cookie = client.cookieHeader()
  // ⚠️ 真实 cookie 名是 xiaomichatbot_serviceToken，不是 serviceToken
  assert.ok(cookie.includes('xiaomichatbot_serviceToken=tok-1234567890'), `实际：${cookie}`)
  assert.ok(cookie.includes('userId=42'))
  assert.ok(cookie.includes('xiaomichatbot_ph=ph-abc'))
  // 反向断言：绝不能发出裸的 serviceToken=，服务端不认这个名字
  assert.ok(!/(^|; )serviceToken=/.test(cookie), '不应该发出裸 serviceToken')
})

/**
 * 这组断言是"用真实浏览器 cookie 库核对出来的契约"，写死在这里当防呆。
 * 事故背景：早先按 serviceToken 去捕获，浏览器里根本没有这个名字，
 * 三个 cookie 永远凑不齐 → 登录窗口干等到超时 → 账号库永远是空的。
 */
await testAsync('REQUIRED_COOKIES 与真实站点的 cookie 名一致', async () => {
  assert.deepEqual(REQUIRED_COOKIES.slice().sort(), ['userId', 'xiaomichatbot_ph', 'xiaomichatbot_serviceToken'].sort())
  assert.ok(REQUIRED_COOKIES.includes('xiaomichatbot_serviceToken'), 'serviceToken 必须带 xiaomichatbot_ 前缀')
  assert.ok(!REQUIRED_COOKIES.includes('serviceToken'), '不能只写裸 serviceToken')
})

await testAsync('登录地址落在对话页 #/c', async () => {
  assert.ok(LOGIN_URL.endsWith('/#/c'), `实际：${LOGIN_URL}`)
  assert.ok(LOGIN_URL.startsWith('https://aistudio.xiaomimimo.com/'), '域名必须是 aistudio.xiaomimimo.com')
})

/**
 * 真实事故：CDP 抓回来的 cookie 值首尾带 ASCII 双引号（`"/vjQ…JU="`）。
 * whoami 不校验，所以看起来"登录成功"；但 react/chat 会把 ph 拼进 followup，
 * 带引号立刻 401。这套断言保证入口统一洗干净。
 */
test('normalizeCookieValue 去掉外层引号', () => {
  assert.equal(normalizeCookieValue('"/vjQa88JU="'), '/vjQa88JU=')
  assert.equal(normalizeCookieValue('"YXprTE+AX1TkzI4SE/35QA=="'), 'YXprTE+AX1TkzI4SE/35QA==')
  assert.equal(normalizeCookieValue('  "abc"  '), 'abc')
  // 没引号的不动
  assert.equal(normalizeCookieValue('abc123'), 'abc123')
  assert.equal(normalizeCookieValue(''), '')
  assert.equal(normalizeCookieValue(undefined), '')
})

test('normalizeCookieValue 处理被 URL 编码过的引号', () => {
  assert.equal(normalizeCookieValue('%22abc%22'), 'abc')
})

await testAsync('MimoClient 发出的 cookie 不带引号', async () => {
  const client = new MimoClient({
    serviceToken: '"/vjQa88JU="',
    userId: '"123456789"',
    xiaomichatbotPh: '"YXprTE+AX1TkzI4SE/35QA=="',
  })
  const cookie = client.cookieHeader()
  assert.ok(!cookie.includes('"'), `cookie 里还有引号：${cookie}`)
  assert.ok(cookie.includes('xiaomichatbot_serviceToken=/vjQa88JU='), `实际：${cookie}`)
  assert.ok(cookie.includes('userId=123456789'))
  assert.ok(cookie.includes('xiaomichatbot_ph=YXprTE+AX1TkzI4SE/35QA=='))
})

await testAsync('URL 上的 ph 查询参数也不带引号', async () => {
  const client = new MimoClient({ serviceToken: 'tok', userId: '1', xiaomichatbotPh: '"YXpr=="' })
  const url = client.url('/open-apis/react/chat')
  assert.ok(!url.includes('%22'), `URL 里还有 %22：${url}`)
  assert.ok(url.includes('xiaomichatbot_ph=YXpr%3D%3D'), `实际：${url}`)
})

await testAsync('URL 带 xiaomichatbot_ph 查询参数', async () => {
  const client = new MimoClient(AUTH)
  const url = client.url('/open-apis/react/chat')
  assert.ok(url.startsWith(ORIGIN))
  assert.ok(url.includes('xiaomichatbot_ph=ph-abc'))
})

await testAsync('SSE 解析：正文 + 思考 + usage + finish', async () => {
  const body = [
    'event: dialogId\ndata: 991\n\n',
    'event: message\ndata: {"reasoningContent":"思考一"}\n\n',
    'event: message\ndata: {"content":"正文一"}\n\n',
    'event: message\ndata: {"content":"正文二"}\n\n',
    'event: usage\ndata: {"promptTokens":10,"completionTokens":5,"totalTokens":15}\n\n',
    'event: finish\ndata: {}\n\n',
  ]
  const client = new MimoClient(AUTH, { fetchImpl: fakeFetch(() => sseResponse(body)) })
  const events = []
  for await (const event of client.chat({ query: 'hi' })) events.push(event)
  const kinds = events.map((event) => event.kind)
  assert.deepEqual(kinds, ['dialog', 'reasoning', 'text', 'text', 'usage', 'finish'])
  assert.equal(events[1].text, '思考一')
  assert.equal(events[2].text, '正文一')
  assert.equal(events[4].usage.total, 15)
})

await testAsync('SSE 解析：data: [DONE] 也能结束', async () => {
  const body = ['event: message\ndata: {"content":"hi"}\n\n', 'data: [DONE]\n\n']
  const client = new MimoClient(AUTH, { fetchImpl: fakeFetch(() => sseResponse(body)) })
  const events = []
  for await (const event of client.chat({ query: 'hi' })) events.push(event)
  assert.deepEqual(events.map((event) => event.kind), ['text'])
  assert.equal(events[0].text, 'hi')
})

await testAsync('SSE 解析：跨 chunk 切断的行能拼回来', async () => {
  const body = ['event: message\ndata: {"cont', 'ent":"拼好了"}\n\n', 'event: finish\ndata: {}\n\n']
  const client = new MimoClient(AUTH, { fetchImpl: fakeFetch(() => sseResponse(body)) })
  const events = []
  for await (const event of client.chat({ query: 'hi' })) events.push(event)
  assert.equal(events[0].text, '拼好了')
})

await testAsync('SSE 解析：error 事件被识别', async () => {
  const body = ['event: error\ndata: {"content":"模型开小差了"}\n\n']
  const client = new MimoClient(AUTH, { fetchImpl: fakeFetch(() => sseResponse(body)) })
  const events = []
  for await (const event of client.chat({ query: 'hi' })) events.push(event)
  assert.equal(events[0].kind, 'error')
  assert.ok(events[0].message.includes('模型开小差'))
})

await testAsync('SSE 解析：未知事件被丢弃', async () => {
  const body = ['event: unknown_thing\ndata: {"content":"x"}\n\n', 'event: finish\ndata: {}\n\n']
  const client = new MimoClient(AUTH, { fetchImpl: fakeFetch(() => sseResponse(body)) })
  const events = []
  for await (const event of client.chat({ query: 'hi' })) events.push(event)
  assert.deepEqual(events.map((event) => event.kind), ['finish'])
})

await testAsync('401 映射成 AUTH 并且带上登录提示', async () => {
  const response = new Response(
    JSON.stringify({ code: 401, loginUrl: 'https://account.xiaomi.com/pass/serviceLogin?x=1' }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  )
  const client = new MimoClient(AUTH, { fetchImpl: fakeFetch(() => response) })
  let caught
  try {
    for await (const _event of client.chat({ query: 'hi' })) {
      /* 不该有事件 */
    }
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof MimoError)
  assert.equal(caught.code, 'AUTH')
  assert.ok(caught.message.includes('401'))
})

await testAsync('429 映射成 RATE_LIMIT 并带 retryAfter', async () => {
  const response = new Response('busy', { status: 429, headers: { 'retry-after': '7' } })
  const client = new MimoClient(AUTH, { fetchImpl: fakeFetch(() => response) })
  let caught
  try {
    for await (const _event of client.chat({ query: 'hi' })) {
      /* 不该有事件 */
    }
  } catch (error) {
    caught = error
  }
  assert.equal(caught.code, 'RATE_LIMIT')
  assert.equal(caught.retryAfterMs, 7000)
})

/**
 * 真实踩过的坑：服务端限流时返回 `event:error data:{"content":"没有权限操作"}`。
 * 照字面理解会以为"登录失效/密钥无效"，用户就会反复重登 —— 完全没用。
 * 必须把它识别成 RATE_LIMIT，让重试策略接手。
 */
await testAsync('「没有权限操作」被识别为 RATE_LIMIT 而不是认证失败', async () => {
  const body = ['event: error\ndata: {"type":"text","content":"没有权限操作"}\n\n']
  const client = new MimoClient(AUTH, { fetchImpl: fakeFetch(() => sseResponse(body)) })
  const events = []
  for await (const event of client.chat({ query: 'hi' })) events.push(event)
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'error')
  assert.equal(events[0].code, 'RATE_LIMIT', '应归类为限流，不是 AUTH')
  // 文案要说明"不是登录失效"，否则用户会去反复重登
  assert.ok(events[0].message.includes('不是登录失效'), `实际文案：${events[0].message}`)
  assert.ok(!events[0].message.includes('登录态已失效'))
})

await testAsync('「服务器繁忙」也归类为 RATE_LIMIT', async () => {
  const body = ['event: error\ndata: {"type":"text","content":"服务器繁忙，请稍后再试"}\n\n']
  const client = new MimoClient(AUTH, { fetchImpl: fakeFetch(() => sseResponse(body)) })
  const events = []
  for await (const event of client.chat({ query: 'hi' })) events.push(event)
  assert.equal(events[0].code, 'RATE_LIMIT')
})

/**
 * 本轮最隐蔽的 bug：`messageType` 是消息**角色**（"assistant"），不是事件名。
 * 早先拿它覆盖 eventName，于是每一帧 `event:message` 都变成 `assistant`，
 * 被白名单判定丢弃 —— 正文与思考全被吞，上层只看到 usage/finish，
 * 表现成"空响应"，让人误以为是限流或上下文截断。
 */
await testAsync('messageType=assistant 的 message 帧不能被丢弃（正文要能出来）', async () => {
  const body = [
    'event: message\ndata: {"messageType":"assistant","reasoningContent":"思考"}\n\n',
    'event: message\ndata: {"messageType":"assistant","content":"正文"}\n\n',
    'event: finish\ndata: {"content":"[DONE]"}\n\n',
  ]
  const client = new MimoClient(AUTH, { fetchImpl: fakeFetch(() => sseResponse(body)) })
  const events = []
  for await (const event of client.chat({ query: 'hi' })) events.push(event)
  assert.deepEqual(
    events.map((e) => e.kind),
    ['reasoning', 'text', 'finish'],
    `实际：${JSON.stringify(events.map((e) => e.kind))}`,
  )
  assert.equal(events[0].text, '思考')
  assert.equal(events[1].text, '正文')
})

await testAsync('请求体形状符合 SPA 的 payload builder', async () => {
  let captured
  const body = ['event: finish\ndata: {}\n\n']
  const client = new MimoClient(AUTH, {
    fetchImpl: fakeFetch((url, init) => {
      captured = { url, body: JSON.parse(init.body), headers: init.headers }
      return sseResponse(body)
    }),
  })
  const request = {
    msgId: randomId(),
    conversationId: randomId(),
    query: '你好',
    isEditedQuery: false,
    modelConfig: { enableThinking: true, webSearchStatus: 'disabled', model: 'mimo-v2.6-pro' },
    multiMedias: [],
  }
  for await (const _event of client.chat(request)) {
    /* 消耗流 */
  }
  assert.equal(captured.body.query, '你好')
  assert.equal(captured.body.modelConfig.model, 'mimo-v2.6-pro')
  assert.equal(captured.body.isEditedQuery, false)
  assert.equal(captured.body.msgId.length, 32)
  assert.equal(captured.body.conversationId.length, 32)
  assert.ok(Array.isArray(captured.body.multiMedias))
  assert.ok(captured.headers.cookie.includes('xiaomichatbot_serviceToken='), `实际：${captured.headers.cookie}`)
  // 不能有这些（SPA 从不发）
  assert.equal(captured.body.attachments, undefined)
  assert.equal(captured.body.modelConfig.reasoning_effort, undefined)
})

await testAsync('randomId 生成 32 位十六进制', async () => {
  const id = randomId()
  assert.equal(id.length, 32)
  assert.match(id, /^[0-9a-f]{32}$/)
  assert.notEqual(randomId(), randomId())
})

/**
 * 用户报的真实问题：「明明有 15 个模型，列表里只给我两个」。
 *
 * 根因是 `loadCatalog` 里写了「没有 auth 就直接退回兜底表」，
 * 但 `bot/config` 这个接口**根本不需要登录**。这里用一个无 auth 的假 fetch 锁住行为。
 */
await testAsync('未登录也要把真实模型目录拉回来（不只兜底 2 个）', async () => {
  const { createAdapter } = await import('../lib/adapter.js')
  const catalog = {
    code: 0,
    data: {
      modelConfigList: [
        { model: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash', nToken: 1048576 },
        { model: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro', nToken: 1048576 },
        { model: 'mimo-v2.5-pro', name: 'mimo-v2.5-pro', nToken: 262144 },
        // 重定向别名不该进列表
        { model: 'mimo-v2', name: 'old', redirectTo: 'mimo-v2.6-pro' },
      ],
    },
  }
  const adapter = createAdapter({
    // ⚠️ 故意不给 auth —— 这正是"没登录"的场景
    getAuth: () => undefined,
    getSettings: () => ({ enabledModels: [], thinking: true }),
    fetchImpl: fakeFetch(() => new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } })),
    logger: {},
  })
  const models = await adapter.listModels('mimo-web')
  assert.equal(models.length, 3, `应该是 3 个真实模型，实际 ${models.length}：${models.map((m) => m.id).join(',')}`)
  assert.ok(models.some((m) => m.id === 'mimo-v2.6-flash'))
  assert.ok(models.some((m) => m.id === 'mimo-v2.5-pro'))
  assert.ok(!models.some((m) => m.id === 'mimo-v2'), '重定向别名不该出现')
})

/**
 * 真实事故：宿主把**显示名**（MiMo-V2.6-Pro）传下来，上游只认真实 id
 * （mimo-v2.6-pro），于是回 `event:error {"content":"模型名称错误"}`。
 * 这个测试锁住"显示名必须被映射回真实 id"。
 */
await testAsync('显示名会被映射成上游真实模型 id', async () => {
  const { createAdapter } = await import('../lib/adapter.js')
  const catalog = {
    code: 0,
    data: {
      modelConfigList: [
        { model: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash' },
        { model: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' },
      ],
    },
  }
  let capturedModel
  let chatRequests = 0
  const adapter = createAdapter({
    getAuth: () => ({ serviceToken: 'tok', userId: '1', xiaomichatbotPh: 'ph' }),
    getSettings: () => ({ thinking: false, webSearch: 'disabled', maxImages: 0, maxPromptChars: 240000, minIntervalMs: 0, idleTimeoutMs: 60000, allowConcurrent: false }),
    logger: {},
    fetchImpl: async (url, init) => {
      const href = String(url)
      if (href.includes('/bot/config')) {
        return new Response(JSON.stringify(catalog), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (href.includes('/conversation/save')) {
        return new Response(JSON.stringify({ code: 0, msg: '成功', data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      chatRequests += 1
      capturedModel = JSON.parse(init.body).modelConfig.model
      return sseResponse(['event: message\ndata: {"messageType":"assistant","content":"ok"}\n\n', 'event: finish\ndata: {}\n\n'])
    },
  })

  const prepared = await adapter.prepareCall('mimo-web', 'MiMo-V2.6-Pro')
  for await (const _chunk of prepared.stream({
    model: 'MiMo-V2.6-Pro',
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    tools: [],
  })) {
    /* 消耗 */
  }
  assert.ok(chatRequests > 0, '应该有真的对话请求发出去')
  assert.equal(capturedModel, 'mimo-v2.6-pro', `发出去的 model 应是真实 id，实际 ${capturedModel}`)
})

/**
 * 压缩超长 prompt。
 *
 * 用户要的「文本超限就压缩」：不能简单砍中间（那会让模型突然失忆），
 * 要保住 ① 系统头 ② 最近几轮 ③ 首轮任务，只收掉中间已完成的回合。
 */
await testAsync('超长 prompt 会被压缩而不是砍掉最近对话', async () => {
  const { createAdapter } = await import('../lib/adapter.js')
  const adapter = createAdapter({
    getAuth: () => ({ serviceToken: 'tok', userId: '1', xiaomichatbotPh: 'ph' }),
    getSettings: () => ({ thinking: false, webSearch: 'disabled', maxImages: 0, maxPromptChars: 20_000, minIntervalMs: 0, idleTimeoutMs: 60000, allowConcurrent: false }),
    logger: {},
    fetchImpl: async (url, init) => {
      const href = String(url)
      if (href.includes('/bot/config')) {
        return new Response(JSON.stringify({ code: 0, data: { modelConfigList: [{ model: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // 会话记录保存是额外的一枪（为了让官网可见），这里不该抢走 chat 的抓取
      if (href.includes('/conversation/save')) {
        return new Response(JSON.stringify({ code: 0, msg: '成功', data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      capturedQuery = JSON.parse(init.body).query
      return sseResponse(['event: message\ndata: {"messageType":"assistant","content":"ok"}\n\n', 'event: finish\ndata: {}\n\n'])
    },
  })

  let capturedQuery
  // 造一段远超上限的历史：第一条带关键信息，中间一堆噪声，最后一条是当前提问
  const messages = [{ role: 'user', content: [{ type: 'text', text: '【关键任务】请记住代号 ALPHA-7' }] }]
  for (let i = 0; i < 60; i += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `噪声第 ${i} 段：${'填充'.repeat(200)}` }] })
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `回答 ${i}：${'内容'.repeat(150)}` }] })
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: '【当前问题】刚才的任务代号是什么？' }] })

  const prepared = await adapter.prepareCall('mimo-web', 'mimo-v2.6-pro')
  for await (const _c of prepared.stream({
    model: 'mimo-v2.6-pro',
    system: '你是助手。',
    messages,
    tools: [],
  })) {
    /* 消耗 */
  }

  assert.ok(capturedQuery, '应该发出请求')
  assert.ok(capturedQuery.length <= 20_000, `压缩后仍有 ${capturedQuery.length} 字符，超过上限`)
  // 最近的提问必须还在（不能砍尾巴）
  assert.ok(capturedQuery.includes('【当前问题】'), '最近的提问被砍掉了 —— 模型会失忆')
  // 系统头必须还在
  assert.ok(capturedQuery.includes('你是助手。'), '系统提示被砍掉了')
  // 应该有压缩说明
  assert.ok(/压缩省略/.test(capturedQuery), '应该有"已压缩省略"的说明，让模型知道自己漏了背景')
})

/**
 * 用户报的真实问题：「为什么我在 mimo 官网看不到聊天记录」。
 *
 * 实测结论：只发 `react/chat` 不打 `conversation/save`，消息能正常对话，
 * 但 `conversation/list`（网页端左栏数据源）里不会出现这条会话。
 * 这个测试锁住"聊天后必须补一枪 save"，并且 title 不能为空（空串会 400）。
 */
await testAsync('聊天结束后会保存会话记录（否则官网看不到历史）', async () => {
  const { createAdapter } = await import('../lib/adapter.js')
  let saveCalled = false
  let savedBody
  const adapter = createAdapter({
    getAuth: () => ({ serviceToken: 'tok', userId: '1', xiaomichatbotPh: 'ph' }),
    getSettings: () => ({ thinking: false, webSearch: 'disabled', maxImages: 0, maxPromptChars: 240000, minIntervalMs: 0, idleTimeoutMs: 60000, allowConcurrent: false, saveConversationHistory: true }),
    logger: {},
    fetchImpl: async (url, init) => {
      const href = String(url)
      if (href.includes('/bot/config')) {
        return new Response(JSON.stringify({ code: 0, data: { modelConfigList: [{ model: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (href.includes('/conversation/save')) {
        saveCalled = true
        savedBody = JSON.parse(init.body)
        return new Response(JSON.stringify({ code: 0, msg: '成功', data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return sseResponse(['event: message\ndata: {"messageType":"assistant","content":"我是 MiMo"}\n\n', 'event: finish\ndata: {}\n\n'])
    },
  })

  const prepared = await adapter.prepareCall('mimo-web', 'mimo-v2.6-pro')
  for await (const _c of prepared.stream({
    model: 'mimo-v2.6-pro',
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你叫什么名字？' }] }],
    tools: [],
  })) {
    /* 消耗 */
  }

  assert.equal(saveCalled, true, '聊天结束后必须调用 conversation/save，否则官网看不到记录')
  assert.ok(savedBody?.conversationId, 'save 必须带 conversationId')
  assert.ok(typeof savedBody?.title === 'string' && savedBody.title.length > 0, 'title 不能为空（空串会 400）')
  assert.equal(savedBody.type, 'chat')
})

/**
 * UltraSpeed 是**独立部署**。
 *
 * ⚠️ 断言值是用 CDP 抓真实请求核对过的（2026-11 实测）：
 *   `POST /fastchat/open-apis/bot/chat?xiaomichatbot_ph=<ph>`
 *   cookie 还是那三个：xiaomichatbot_serviceToken / userId / xiaomichatbot_ph
 *
 * 反直觉的点：SPA 源码里虽然写着 `{ultra: "ultraspeed_ph"}`，但浏览器里
 * **没有** `ultraspeed_ph` 这个 cookie，查询参数也仍叫 `xiaomichatbot_ph`。
 * 早先照字面量去用，结果必然 401。这个测试就是锁住"抓包事实"。
 */
await testAsync('UltraSpeed 模型走 /fastchat 路径，但 ph 仍用 xiaomichatbot_ph', async () => {
  const { createAdapter, isFastchatModel } = await import('../lib/adapter.js')
  assert.equal(isFastchatModel('mimo-v2.6-pro-ultraspeed-studio'), true)
  assert.equal(isFastchatModel('mimo-v2.6-pro'), false)

  let capturedUrl
  let capturedCookie
  const adapter = createAdapter({
    getAuth: () => ({ serviceToken: 'tok', userId: '1', xiaomichatbotPh: 'ph-normal' }),
    getSettings: () => ({ thinking: false, webSearch: 'disabled', maxImages: 0, maxPromptChars: 240000, minIntervalMs: 0, idleTimeoutMs: 60000, allowConcurrent: false, saveConversationHistory: false }),
    logger: {},
    fetchImpl: async (url, init) => {
      const href = String(url)
      // ⚠️ `/bot/config` 是免鉴权的目录接口（模型名映射也会打它），别当成 chat 请求
      if (href.includes('/bot/config')) {
        return new Response(JSON.stringify({ code: 0, data: { modelConfigList: [{ model: 'mimo-v2.6-pro-ultraspeed-studio', name: 'MiMo-V2.6-Pro-UltraSpeed' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (href.includes('/conversation/save')) {
        return new Response(JSON.stringify({ code: 0, msg: '成功', data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      capturedUrl = href
      capturedCookie = init.headers.cookie
      return sseResponse(['event: message\ndata: {"messageType":"assistant","content":"ok"}\n\n', 'event: finish\ndata: {}\n\n'])
    },
  })

  const prepared = await adapter.prepareCall('mimo-web', 'mimo-v2.6-pro-ultraspeed-studio')
  for await (const _c of prepared.stream({
    model: 'mimo-v2.6-pro-ultraspeed-studio',
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    tools: [],
  })) {
    /* 消耗 */
  }

  assert.ok(capturedUrl.includes('/fastchat/open-apis/bot/chat'), `UltraSpeed 应走 fastchat 的 v2 端点，实际 ${capturedUrl}`)
  assert.ok(!capturedUrl.includes('/fastchat/open-apis/react/chat'), 'fastchat 下没有 react/chat（那条是 404）')
  // 抓包事实：ph 参数名没变
  assert.ok(capturedUrl.includes('xiaomichatbot_ph=ph-normal'), `ph 参数名应仍是 xiaomichatbot_ph，实际 ${capturedUrl}`)
  assert.ok(!capturedUrl.includes('ultraspeed_ph'), '不该用 ultraspeed_ph（浏览器里没这个 cookie）')
  assert.ok(capturedCookie.includes('xiaomichatbot_ph=ph-normal'), `cookie 应带 xiaomichatbot_ph，实际 ${capturedCookie}`)
  assert.ok(!capturedCookie.includes('ultraspeed_ph'), '不该发 ultraspeed_ph')
})

await testAsync('普通模型仍走 react/chat（别被 ultra 的路径带偏）', async () => {
  const { createAdapter } = await import('../lib/adapter.js')
  let capturedUrl
  const adapter = createAdapter({
    getAuth: () => ({ serviceToken: 'tok', userId: '1', xiaomichatbotPh: 'ph-normal' }),
    getSettings: () => ({ thinking: false, webSearch: 'disabled', maxImages: 0, maxPromptChars: 240000, minIntervalMs: 0, idleTimeoutMs: 60000, allowConcurrent: false, saveConversationHistory: false }),
    logger: {},
    fetchImpl: async (url) => {
      const href = String(url)
      if (href.includes('/bot/config')) {
        return new Response(JSON.stringify({ code: 0, data: { modelConfigList: [{ model: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (href.includes('/conversation/save')) {
        return new Response(JSON.stringify({ code: 0, msg: '成功', data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      capturedUrl = href
      return sseResponse(['event: message\ndata: {"messageType":"assistant","content":"ok"}\n\n', 'event: finish\ndata: {}\n\n'])
    },
  })

  const prepared = await adapter.prepareCall('mimo-web', 'mimo-v2.6-pro')
  for await (const _c of prepared.stream({
    model: 'mimo-v2.6-pro',
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    tools: [],
  })) {
    /* 消耗 */
  }
  assert.ok(capturedUrl.includes('/open-apis/react/chat'), `普通模型应走 react/chat，实际 ${capturedUrl}`)
  assert.ok(!capturedUrl.includes('/fastchat'), '普通模型不该带 fastchat 前缀')
})

/**
 * v2 协议（UltraSpeed）把思考混在正文里，用 `<think>` 包住，还夹 \u0000 分隔符。
 * 不剥的话用户会看到 `<think>` 字面量。这个测试锁住剥离行为。
 */
await testAsync('v2 的 <think> 标签会被剥离到思考区', async () => {
  const { createAdapter } = await import('../lib/adapter.js')
  const adapter = createAdapter({
    getAuth: () => ({ serviceToken: 'tok', userId: '1', xiaomichatbotPh: 'ph' }),
    getSettings: () => ({ thinking: false, webSearch: 'disabled', maxImages: 0, maxPromptChars: 240000, minIntervalMs: 0, idleTimeoutMs: 60000, allowConcurrent: false, saveConversationHistory: false }),
    logger: {},
    fetchImpl: async (url) => {
      const href = String(url)
      if (href.includes('/bot/config')) {
        return new Response(JSON.stringify({ code: 0, data: { modelConfigList: [{ model: 'mimo-v2.6-pro-ultraspeed-studio', name: 'Ultra' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (href.includes('/conversation/save')) {
        return new Response(JSON.stringify({ code: 0, msg: '成功', data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      // 模拟 v2：正文里混着 <think> 和 \u0000
      return sseResponse([
        'event: message\ndata: {"messageType":"assistant","content":"\\u003cthink\\u003e\\u0000The user wants a self-intro.\\u003c/think\\u003e\\u0000我是 MiMo。"}\n\n',
        'event: finish\ndata: {}\n\n',
      ])
    },
  })

  const prepared = await adapter.prepareCall('mimo-web', 'mimo-v2.6-pro-ultraspeed-studio')
  let text = ''
  let reasoning = ''
  for await (const chunk of prepared.stream({
    model: 'mimo-v2.6-pro-ultraspeed-studio',
    system: '',
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
    tools: [],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'reasoning-delta') reasoning += chunk.text
  }

  assert.ok(!text.includes('<think'), `正文不该有 <think 字面量，实际：${text}`)
  assert.ok(!text.includes('\u0000'), `正文不该有 NUL 字符，实际：${JSON.stringify(text)}`)
  assert.ok(text.includes('我是 MiMo'), `正文应保留真实内容，实际：${text}`)
  assert.ok(reasoning.includes('self-intro'), `思考应被挪到 reasoning，实际：${reasoning}`)
})

/**
 * 用户需求：同一个 DSH 会话应当续在同一条网页端对话里，而不是每轮新开一条
 * 并把全量历史重喂一遍。
 *
 * 机制：finish chunk 带 `replayState.conversationId`，宿主会把它挂到 assistant
 * 消息的 `source.replayState` 上带回来；下一轮据此复用会话、只发增量。
 */
await testAsync('续聊复用同一个 conversationId，并且只发增量', async () => {
  const { createAdapter } = await import('../lib/adapter.js')
  const calls = []
  const adapter = createAdapter({
    getAuth: () => ({ serviceToken: 'tok', userId: '1', xiaomichatbotPh: 'ph' }),
    getSettings: () => ({ thinking: false, webSearch: 'disabled', maxImages: 0, maxPromptChars: 240000, minIntervalMs: 0, idleTimeoutMs: 60000, allowConcurrent: false, saveConversationHistory: false }),
    logger: {},
    fetchImpl: async (url, init) => {
      const href = String(url)
      if (href.includes('/bot/config')) {
        return new Response(JSON.stringify({ code: 0, data: { modelConfigList: [{ model: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (href.includes('/conversation/save')) {
        return new Response(JSON.stringify({ code: 0, msg: '成功', data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      calls.push(JSON.parse(init.body))
      return sseResponse(['event: message\ndata: {"messageType":"assistant","content":"收到"}\n\n', 'event: finish\ndata: {}\n\n'])
    },
  })

  // 第一轮
  const p1 = await adapter.prepareCall('mimo-web', 'mimo-v2.6-pro')
  let replay1
  for await (const chunk of p1.stream({
    model: 'mimo-v2.6-pro',
    system: '你是一个助手。',
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '第一句话：我叫大明' }] }],
    tools: [],
  })) {
    if (chunk.type === 'finish') replay1 = chunk.replayState
  }
  assert.ok(replay1?.conversationId, '第一轮 finish 必须带 replayState.conversationId')
  assert.equal(replay1.lastMessageId, 'm1')
  const firstConvId = calls[0].conversationId

  // 第二轮：把 replayState 挂到上一条 assistant 消息的 source 上带回来
  const messages2 = [
    { id: 'm1', role: 'user', content: [{ type: 'text', text: '第一句话：我叫大明' }] },
    {
      id: 'a1',
      role: 'assistant',
      source: { kind: 'model', provider: 'mimo-web', model: 'mimo-v2.6-pro', replayState: replay1 },
      content: [{ type: 'text', text: '收到' }],
    },
    { id: 'm2', role: 'user', content: [{ type: 'text', text: '第二句话：我叫什么名字？' }] },
  ]
  const p2 = await adapter.prepareCall('mimo-web', 'mimo-v2.6-pro')
  let replay2
  for await (const chunk of p2.stream({
    model: 'mimo-v2.6-pro',
    system: '你是一个助手。',
    messages: messages2,
    tools: [],
  })) {
    if (chunk.type === 'finish') replay2 = chunk.replayState
  }

  const second = calls[calls.length - 1]
  assert.equal(second.conversationId, firstConvId, `第二轮应复用同一个 conversationId，实际 ${second.conversationId} vs ${firstConvId}`)
  // 增量：不应再包含第一句话，也不该重复系统提示
  assert.ok(!second.query.includes('我叫大明'), `第二轮不该重发旧历史，实际：${second.query}`)
  assert.ok(second.query.includes('我叫什么名字'), `第二轮应包含新问题，实际：${second.query}`)
  assert.ok(!second.query.includes('你是一个助手。'), '增量不该重复系统提示')
  assert.equal(replay2.lastMessageId, 'm2')
})

// ── 汇总 ────────────────────────────────────────────────────────────────

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('\n失败详情：')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('全部通过 ✓')
