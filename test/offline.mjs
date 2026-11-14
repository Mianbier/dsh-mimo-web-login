/**
 * 离线测试：不碰网络、不碰真实账号，只验纯逻辑。
 *
 * 跑法：node test/offline.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'

import { extractToolCalls, buildToolSection, buildToolSignature, toolProtocolInstructions, CALL_OPEN, CALL_CLOSE } from '../lib/tool-protocol.js'
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

/**
 * 真实事故（用户报的）：模型写 Python 文件时**文件内容里自带三个反引号**
 * （docstring 里嵌 markdown 代码块、正则里匹配围栏）。
 *
 * 旧解析器用「非贪婪匹配到闭合围栏」的正则 ⇒ 会在**内容里那个 ```** 处提前收尾，
 * JSON 被截断、解析失败，于是整个调用被当正文漏出去，模型还以为"工具调用失败"。
 *
 * 正解是照 dsh-deepseek-web-login 的做法：按**花括号配平**取 JSON，
 * 内容里的反引号只是普通字符。
 */
test('文件内容里含三个反引号时，调用仍能完整解析（配平提取）', () => {
  const pyLines = [
    '"""',
    '用法：',
    '```python',
    'client.chat("你好")',
    '```',
    '"""',
    'import re',
    'PATTERN = re.compile(r"^\\s*```(\\w*)\\s*$")',
  ]
  const content = pyLines.join('\n')
  const json = JSON.stringify({
    tool_calls: [{ name: 'write', arguments: { file_path: 'C:\\x\\mimo_client.py', content } }],
  })

  for (const wrap of [
    `\`\`\`dsh-tool\n${json}\n\`\`\``,
    `\`\`\`\n${json}\n\`\`\``,
    `\`\`\`json\n${json}\n\`\`\``,
    json,
  ]) {
    const { calls } = extractToolCalls(wrap)
    assert.equal(calls.length, 1, `没解析出来：${wrap.slice(0, 60)}`)
    const args = JSON.parse(calls[0].arguments)
    assert.ok(args.content.includes('```python'), '内容里的反引号被截断了')
    assert.ok(args.content.includes('strip' ) || args.content.includes('PATTERN'), '内容尾部丢了')
    assert.equal(args.file_path, 'C:\\x\\mimo_client.py')
  }
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

/**
 * 真实事故（用户截图）：模型想用 `edit` 把**字面 `\n`** 换成**真换行**，
 * 但它在 `new_string` 的值里直接敲了个回车：
 *
 * ```json
 * "new_string":"
 * "
 * ```
 *
 * JSON 不允许字符串里有裸换行 ⇒ 解析失败 ⇒ 整个调用被当正文漏出来，
 * 用户看到的就是一段原始 JSON，而模型还在解释"这是我在调用编辑工具"。
 */
test('字符串里敲了裸换行也能解析，且语义是「真换行」', () => {
  const NL = '\n'
  const body =
    '{"tool_calls":[{"name":"edit","arguments":{"file_path":"a.py",' +
    '"old_string":"\\\\n","new_string":"' + NL + '","replace_all":true}}]}'
  const raw = '```dsh-tool\n' + body + '\n```'
  const { calls, text } = extractToolCalls(raw)
  assert.equal(calls.length, 1, `没解析出来，正文=${text.slice(0, 60)}`)
  const args = JSON.parse(calls[0].arguments)
  // 模型的本意是"换成换行"，所以必须解析成**真换行**（1 字符），
  // 不能变成字面反斜杠+n（2 字符）—— 否则等于把 \n 换成 \n，改动无效。
  assert.equal(args.new_string, NL, `new_string 应是真换行，实际 ${JSON.stringify(args.new_string)}`)
  assert.equal(args.old_string, '\\n', 'old_string 应保持字面反斜杠n')
})

/**
 * 真机事故（用户截图，2026-11-04）：模型写 Python 时把 docstring 的
 * `"""` 三对引号**没转义**就塞进 JSON 字符串：
 *
 *     "content":"# -*- coding: utf-8 -*-
 *     """临时诊断"""        ← 这几个裸引号把 JSON 字符串提前闭合了
 *     nc = Cradle()"}}]}
 *
 * 结果整块 `dsh-tool` 被当正文漏出去，用户看到的是一坨原始 JSON。
 *
 * 前面几层（转义换行、括号配平）都救不了这种 —— 它们不碰引号配对。
 * 这一层按"真闭合引号后面必跟结构标记"的规律把裸引号转义掉。
 */
test('字符串里含未转义的裸双引号（docstring 的 """）也能解析', () => {
  const NL = '\n'
  const barePy = '"# -*- coding: utf-8 -*-' + NL +
    '"""临时诊断"""' + NL +
    'nc = Cradle()"'
  const body = '{"tool_calls":[{"name":"write","arguments":{"file_path":"_diag.py","content":' + barePy + '}}]}'
  const raw = '```dsh-tool\n' + body + '\n```'

  const { calls, text } = extractToolCalls(raw)
  assert.equal(calls.length, 1, `没解析出来，正文=${text.slice(0, 80)}`)
  const args = JSON.parse(calls[0].arguments)
  assert.equal(args.file_path, '_diag.py')
  assert.equal(args.content.split(NL).length, 3, `应有三行，实际 ${JSON.stringify(args.content)}`)
  assert.ok(args.content.includes('"""'), '内容里的 """ 必须完整保留')
})

test('同一块里两个调用 + 裸引号都能解析', () => {
  const NL = '\n'
  const barePy = '"# docstring' + NL + '"""说明"""' + NL + 'x = 1"'
  const body =
    '{"tool_calls":[{"name":"write","arguments":{"file_path":"a.py","content":' + barePy + '}},'
    + '{"name":"bash","arguments":{"command":"python a.py"}}]}'
  const { calls } = extractToolCalls('```dsh-tool\n' + body + '\n```')
  assert.equal(calls.length, 2, '两个调用都要解析出来')
  assert.equal(calls[0].name, 'write')
  assert.equal(calls[1].name, 'bash')
})

test('正常 JSON 里的转义引号不会被引号修复改坏', () => {
  const body = JSON.stringify({
    tool_calls: [{ name: 'write', arguments: { file_path: 'a.py', content: 'x = "hello"' } }],
  })
  const { calls } = extractToolCalls('```dsh-tool\n' + body + '\n```')
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(calls[0].arguments).content, 'x = "hello"', '内容必须原样')
})

/**
 * 真机事故（用户截图 2026-11-05）：模型把围栏名写成了**键名**，粘成这样：
 *
 *     {"tooldsh-tool
 *     {"tool_calls":[{"name":"pwsh",…}]}
 *
 * 从第一个 `{` 配平会拿到那个坏对象（内含不配平的同级 `{`），于是解析永远失败，
 * 整块漏成正文。用户看到的就是一坨 `{"tooldsh-tool`。
 *
 * 对策：先找**真正像调用**的 `{`（后面紧跟 `"tool_calls"`），再配平。
 */
test('围栏名被写成键名（{"tooldsh-tool）也能解析', () => {
  const raw = '代码块\n{"tooldsh-tool\n{"tool_calls":[{"name":"pwsh","arguments":{"command":"where.exe python"}}]}'
  const { calls, text } = extractToolCalls(raw)
  assert.equal(calls.length, 1, `没解析出来，残留=${text.slice(0, 80)}`)
  assert.equal(calls[0].name, 'pwsh')
  assert.equal(JSON.parse(calls[0].arguments).command, 'where.exe python')
  assert.ok(!text.includes('tooldsh-tool'), `残渣要清掉，实际残留：${JSON.stringify(text)}`)
})

/**
 * 与上一条配套的**反例**：正文里"提到"围栏时不能被误判成调用，
 * 否则模型一解释协议就被吃掉半句话。
 */
test('正文提到围栏与 tool_calls 时不误判为调用', () => {
  const raw = '它用 ``dsh-tool` 围栏 + {"tool_calls":[...]} 这种写法。'
  const { calls, text } = extractToolCalls(raw)
  assert.equal(calls.length, 0, '不该误判')
  assert.ok(text.includes('dsh-tool'), '正文应完整保留')
  assert.ok(text.includes('这种写法'), '正文应完整保留')
})

/**
 * 与上一条配套：**多行文件内容**里的真换行必须原样保留。
 *
 * 早期版本"扫全对象找控制字符就修"会把这里的换行全变成字面 `\n`，
 * 写出来的 Python 文件全是"反斜杠n"，等于把文件写坏。
 */
test('写多行文件时 content 里的真换行不被改写', () => {
  const NL = '\n'
  const content = 'import os' + NL + 'def f():' + NL + '    pass'
  const body = '{"tool_calls":[{"name":"write","arguments":{"file_path":"a.py","content":' + JSON.stringify(content) + '}}]}'
  const raw = '```dsh-tool\n' + body + '\n```'
  const { calls } = extractToolCalls(raw)
  const args = JSON.parse(calls[0].arguments)
  assert.ok(args.content.includes(NL), `content 里的真换行丢了：${JSON.stringify(args.content)}`)
  assert.equal(args.content.split(NL).length, 3, '应有三行')
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
  // 文案照搬 DeepSeek（英文）；关键是**必须把省略的工具名列出来**，
  // 否则模型连"还有哪些工具存在"都不知道，只能瞎猜名字和参数。
  assert.ok(/omitted for length|NOT described/.test(section), '应给出省略提示')
  assert.ok(/tool_\d+/.test(section), '应列出被省略的工具名')
  assert.ok(/do NOT guess/.test(section), '应明确要求别猜参数')
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
await testAsync('超长 prompt 原样发出，适配器不做压缩/截断', async () => {
  const { createAdapter } = await import('../lib/adapter.js')
  let capturedQuery
  const adapter = createAdapter({
    getAuth: () => ({ serviceToken: 'tok', userId: '1', xiaomichatbotPh: 'ph' }),
    getSettings: () => ({ thinking: false, webSearch: 'disabled', maxImages: 0, maxPromptChars: 20_000, minIntervalMs: 0, idleTimeoutMs: 60000, allowConcurrent: false }),
    logger: {},
    fetchImpl: async (url, init) => {
      const href = String(url)
      if (href.includes('/bot/config')) {
        return new Response(JSON.stringify({ code: 0, data: { modelConfigList: [{ model: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      capturedQuery = JSON.parse(init.body).query
      return sseResponse(['event: message\ndata: {"messageType":"assistant","content":"ok"}\n\n', 'event: finish\ndata: {}\n\n'])
    },
  })

  // 造一段远超 maxPromptChars 的历史
  const messages = [{ role: 'user', content: [{ type: 'text', text: '【关键任务】请记住代号 ALPHA-7' }] }]
  for (let i = 0; i < 60; i += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `噪声第 ${i} 段：${'填充'.repeat(200)}` }] })
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `回答 ${i}：${'内容'.repeat(150)}` }] })
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: '【当前问题】刚才的任务代号是什么？' }] })

  const prepared = await adapter.prepareCall('mimo-web', 'mimo-v2.6-pro')
  for await (const _c of prepared.stream({ model: 'mimo-v2.6-pro', system: '你是助手。', messages, tools: [] })) { /* 消耗 */ }

  assert.ok(capturedQuery, '应该发出请求')
  // 🔴 新设计：适配器**不加工**上下文。长度是宿主（DSH）的职责。
  // 截断会让模型突然失忆，而且用户完全不知道发生了什么 —— 超长就照实报错。
  assert.ok(capturedQuery.length > 20_000, `适配器不该压缩，实际只有 ${capturedQuery.length} 字符`)
  assert.ok(capturedQuery.includes('【关键任务】'), '最早的任务必须原样保留')
  assert.ok(capturedQuery.includes('【当前问题】'), '最近的提问必须原样保留')
  assert.ok(capturedQuery.includes('你是助手。'), '系统提示必须原样保留')
  assert.ok(!/压缩省略|中间省略/.test(capturedQuery), '不该插入任何"已省略"的说明')
})

/**
 * 用户报的真实问题：「为什么我在 mimo 官网看不到聊天记录」。
 *
 * 结论：只发 `react/chat` 时消息能正常对话，但 `chat/conversation/list`
 * （网页端左栏的数据源）里**不会出现**这条会话 —— 用户在官网完全看不到，
 * 于是会以为插件没工作。
 *
 * 所以要**在发 chat 之前**打一枪 `conversation/save` 登记这条会话。
 * 同一个 id 重复打是幂等的（只更新 title 与 updateTime），于是官网里的
 * 那条会话会跟着刷新 —— 看起来就是"实时同步"。
 */
await testAsync('发消息前会登记会话，让官网左栏能实时看到', async () => {
  const { createAdapter } = await import('../lib/adapter.js')
  const urls = []
  let saveBody
  const adapter = createAdapter({
    getAuth: () => ({ serviceToken: 'tok', userId: '1', xiaomichatbotPh: 'ph' }),
    getSettings: () => ({ thinking: false, webSearch: 'disabled', maxImages: 0, minIntervalMs: 0, idleTimeoutMs: 60000, allowConcurrent: false }),
    logger: {},
    fetchImpl: async (url, init) => {
      const href = String(url)
      urls.push(href)
      if (href.includes('/bot/config')) {
        return new Response(JSON.stringify({ code: 0, data: { modelConfigList: [{ model: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (href.includes('/conversation/save')) {
        saveBody = JSON.parse(init.body)
        return new Response(JSON.stringify({ code: 0, msg: '成功', data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return sseResponse(['event: message\ndata: {"messageType":"assistant","content":"ok"}\n\n', 'event: finish\ndata: {}\n\n'])
    },
  })

  const prepared = await adapter.prepareCall('mimo-web', 'mimo-v2.6-pro')
  for await (const _c of prepared.stream({ model: 'mimo-v2.6-pro', system: 's', messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: '帮我看下这个报错' }] }], tools: [] })) { /* 消耗 */ }

  assert.ok(urls.some((u) => /react\/chat|bot\/chat/.test(u)), '应该发出对话请求')
  assert.ok(urls.some((u) => u.includes('/conversation/save')), `应在发消息前登记会话，实际请求：${urls.join(', ')}`)

  // 登记必须在 chat 之前 —— 否则用户刷新官网时可能先看到空列表
  const saveIdx = urls.findIndex((u) => u.includes('/conversation/save'))
  const chatIdx = urls.findIndex((u) => /react\/chat|bot\/chat/.test(u))
  assert.ok(saveIdx >= 0 && saveIdx < chatIdx, `conversation/save 必须在 chat 之前（实际 save@${saveIdx} chat@${chatIdx}）`)

  assert.ok(saveBody?.conversationId, 'save 必须带 conversationId')
  assert.equal(saveBody.type, 'chat')
  assert.ok(typeof saveBody.title === 'string' && saveBody.title.length > 0, 'title 不能为空（空串会 400）')
  assert.ok(saveBody.title.includes('报错'), `标题应取自用户的话，实际：${saveBody.title}`)
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
/**
 * 两种模式都要在，用户可切（`settings.contextMode`）。
 *
 *   `chained`（默认）：同会话复用 conversationId + 只发增量 ⇒ 像官网一样快
 *   `full`：每条请求新会话 + 发全量 ⇒ 稳妥但慢
 *
 * 🔴 两条路必须各自成对：复用会话 + 又发全量 = 服务端存一份、我们再发一份
 *    ⇒ 模型看到两份历史 ⇒ 吐交叠的损坏 JSON（真机事故）。
 */
await testAsync('full 模式：每条请求换新会话 + 发全量', async () => {
  const { createAdapter } = await import('../lib/adapter.js')
  const calls = []
  const adapter = createAdapter({
    getAuth: () => ({ serviceToken: 'tok', userId: '1', xiaomichatbotPh: 'ph' }),
    getSettings: () => ({ thinking: false, webSearch: 'disabled', maxImages: 0, contextMode: 'full', minIntervalMs: 0, idleTimeoutMs: 60000, allowConcurrent: false }),
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
  const firstConvId = calls[0].conversationId

  const messages2 = [
    { id: 'm1', role: 'user', content: [{ type: 'text', text: '第一句话：我叫大明' }] },
    { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'mimo-web', model: 'mimo-v2.6-pro', replayState: replay1 }, content: [{ type: 'text', text: '收到' }] },
    { id: 'm2', role: 'user', content: [{ type: 'text', text: '第二句话：我叫什么名字？' }] },
  ]
  const p2 = await adapter.prepareCall('mimo-web', 'mimo-v2.6-pro')
  for await (const chunk of p2.stream({ model: 'mimo-v2.6-pro', system: '你是一个助手。', messages: messages2, tools: [] })) { /* drain */ }

  const second = calls[calls.length - 1]
  assert.notEqual(second.conversationId, firstConvId, 'full 模式：每条请求应换新会话')
  assert.ok(second.query.includes('你是一个助手。'), 'full 模式必须带系统提示')
  assert.ok(second.query.includes('我叫大明'), 'full 模式应重发完整历史')
  assert.ok(second.query.includes('我叫什么名字'), '应包含新问题')
})

/**
 * 默认（chained）：同会话复用 conversationId + **只发增量**。
 * 这是"像在官网对话框里打字"的语义，也是速度的关键。
 */
await testAsync('默认 chained：复用会话 + 只发增量（像官网）', async () => {
  const { createAdapter } = await import('../lib/adapter.js')
  const calls = []
  const saves = []
  const adapter = createAdapter({
    getAuth: () => ({ serviceToken: 'tok', userId: '1', xiaomichatbotPh: 'ph' }),
    getSettings: () => ({ thinking: false, webSearch: 'disabled', maxImages: 0, minIntervalMs: 0, idleTimeoutMs: 60000, allowConcurrent: false }),
    logger: {},
    fetchImpl: async (url, init) => {
      const href = String(url)
      if (href.includes('/bot/config')) {
        return new Response(JSON.stringify({ code: 0, data: { modelConfigList: [{ model: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (href.includes('/conversation/save')) {
        saves.push(JSON.parse(init.body))
        return new Response(JSON.stringify({ code: 0, msg: '成功', data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      calls.push(JSON.parse(init.body))
      return sseResponse(['event: message\ndata: {"messageType":"assistant","content":"收到"}\n\n', 'event: finish\ndata: {}\n\n'])
    },
  })

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
  const firstConvId = calls[0].conversationId

  const messages2 = [
    { id: 'm1', role: 'user', content: [{ type: 'text', text: '第一句话：我叫大明' }] },
    { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'mimo-web', model: 'mimo-v2.6-pro', replayState: replay1 }, content: [{ type: 'text', text: '收到' }] },
    { id: 'm2', role: 'user', content: [{ type: 'text', text: '第二句话：我叫什么名字？' }] },
  ]
  const p2 = await adapter.prepareCall('mimo-web', 'mimo-v2.6-pro')
  for await (const chunk of p2.stream({ model: 'mimo-v2.6-pro', system: '你是一个助手。', messages: messages2, tools: [] })) { /* drain */ }

  const second = calls[calls.length - 1]
  assert.equal(second.conversationId, firstConvId, 'chained 模式：应复用同一个 conversationId')
  assert.ok(!second.query.includes('我叫大明'), `chained 不该重发旧历史，实际：${second.query}`)
  assert.ok(second.query.includes('我叫什么名字'), '应包含新问题')
  assert.ok(second.query.length < 500, `chained 的请求应该很短，实际 ${second.query.length} 字符`)

  // 官网上要能看见：每轮都打 conversation/save（幂等刷新）
  assert.ok(saves.length >= 2, `每轮都应同步会话到官网，实际 ${saves.length} 次`)
  assert.ok(saves.every((s) => s.conversationId === firstConvId), '同步的应是同一个会话')
  assert.ok(saves.every((s) => typeof s.title === 'string' && s.title.length > 0), 'title 不能为空（空串会 400）')
})

/**
 * chained 模式（显式打开）：只发增量，且**剔除模型回声**、**头部没变就不重发协议**。
 * 这两条是照搬 DeepSeek 的核心优化；默认不开是因为它的代价（协议只活在链首）太大。
 */
await testAsync('chained 模式只发增量、剔回声、不重发未变的头部', async () => {
  const { createAdapter } = await import('../lib/adapter.js')
  const calls = []
  const adapter = createAdapter({
    getAuth: () => ({ serviceToken: 'tok', userId: '1', xiaomichatbotPh: 'ph' }),
    getSettings: () => ({ thinking: false, webSearch: 'disabled', maxImages: 0, maxPromptChars: 240000, minIntervalMs: 0, idleTimeoutMs: 60000, allowConcurrent: false, saveConversationHistory: false, contextMode: 'chained' }),
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

  const messages2 = [
    { id: 'm1', role: 'user', content: [{ type: 'text', text: '第一句话：我叫大明' }] },
    { id: 'a1', role: 'assistant', source: { kind: 'model', provider: 'mimo-web', model: 'mimo-v2.6-pro', replayState: replay1 }, content: [{ type: 'text', text: '收到' }] },
    { id: 'm2', role: 'user', content: [{ type: 'text', text: '第二句话：我叫什么名字？' }] },
  ]
  const p2 = await adapter.prepareCall('mimo-web', 'mimo-v2.6-pro')
  for await (const chunk of p2.stream({ model: 'mimo-v2.6-pro', system: '你是一个助手。', messages: messages2, tools: [] })) { /* drain */ }

  const second = calls[calls.length - 1]
  assert.ok(!second.query.includes('你是一个助手。'), `chained 不该重发未变的系统提示，实际：${second.query}`)
  assert.ok(!second.query.includes('我叫大明'), 'chained 不该重发旧历史')
  assert.ok(second.query.includes('我叫什么名字'), '应包含新问题')
  assert.ok(!/Assistant:/.test(second.query), `chained 应剔除模型回声，实际：${second.query}`)
})

/**
 * 上游回什么就转什么 —— 适配器不替宿主判断"空回复算不算失败"。
 *
 * 早先这里有一层 `EMPTY_RESPONSE` 判定（还把空白 trim 之后当空）。那是我自作主张：
 * 空回复要不要报错、要不要重试，是 **DSH 宿主**的职责（它有自己的策略与 UI）；
 * 适配器多判一层，只会让宿主的重试逻辑失效、错误文案重复。
 */
await testAsync('上游返回什么就转什么，不擅自改写 finish 语义', async () => {
  const { createAdapter } = await import('../lib/adapter.js')

  const runCase = async (sseLines) => {
    const adapter = createAdapter({
      getAuth: () => ({ serviceToken: 't', userId: '1', xiaomichatbotPh: 'p' }),
      getSettings: () => ({ thinking: true, webSearch: 'disabled', maxImages: 0, maxPromptChars: 240000, minIntervalMs: 0, idleTimeoutMs: 5000, allowConcurrent: true }),
      logger: { warn: () => {}, debug: () => {} },
      fetchImpl: async (url) => {
        const href = String(url)
        if (href.includes('/bot/config')) return new Response(JSON.stringify({ code: 0, data: { modelConfigList: [{ model: 'mimo-v2.6-pro', name: 'MiMo-V2.6-Pro' }] } }), { status: 200, headers: { 'content-type': 'application/json' } })
        return sseResponse(sseLines)
      },
    })
    const prep = await adapter.prepareCall('mimo-web', 'mimo-v2.6-pro')
    let finish
    const textBlocks = []
    for await (const c of prep.stream({ model: 'mimo-v2.6-pro', system: 's', messages: [{ id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] })) {
      if (c.type === 'block-end' && c.block?.type === 'text') textBlocks.push(c.block)
      if (c.type === 'finish') finish = c.reason
    }
    return { finish, textBlocks }
  }

  // 正常应答：照实转成 stop，文本块正常
  const normal = await runCase(['event: message\ndata: {"messageType":"assistant","content":"你好呀"}\n\n', 'event: finish\ndata: {}\n\n'])
  assert.equal(normal.finish?.kind, 'stop', '正常应答应 stop')
  assert.equal(normal.textBlocks.length, 1, '正常应答应有一个文本块')
  assert.equal(normal.textBlocks[0].text, '你好呀', '正文应原样透传')

  // 工具调用：照实转成 tool-calls
  const tool = await runCase(['event: message\ndata: {"messageType":"assistant","content":"```dsh-tool\\n{\\"tool_calls\\":[{\\"name\\":\\"pwsh\\",\\"arguments\\":{\\"command\\":\\"ls\\"}}]}\\n```"}\n\n', 'event: finish\ndata: {}\n\n'])
  assert.equal(tool.finish?.kind, 'tool-calls', `工具调用应 tool-calls，实际 ${JSON.stringify(tool.finish)}`)

  // 上游明确报错：照实转成 error（这条必须保留 —— 那是上游的语义，不是我们加的）
  const upstreamError = await runCase(['event: error\ndata: {"content":"没有权限操作"}\n\n'])
  assert.equal(upstreamError.finish?.kind, 'error', '上游报错必须照实转成 error')
})

/**
 * Linux 支持：浏览器查找不能只列 `/usr/bin`，而且要识别"没有图形环境"。
 *
 * Linux 上浏览器装在哪完全取决于发行版与安装方式（apt / snap / flatpak / nix…），
 * 固定路径表永远列不全 ⇒ 必须先查 `PATH`。而纯 SSH 服务器上 `DISPLAY` 为空，
 * 登录窗口根本开不出来 ⇒ 面板该直接引导用户走「手动粘贴 Cookie」。
 *
 * ⚠️ **不要在这条测试里真的去启动浏览器**：GitHub 的 ubuntu runner 自带
 * chromium，`captureLogin` 会真的把它拉起来然后等超时 —— 在 CI 上白白花 30 秒
 * 甚至挂住。所以这里只断言"能力探测"这一层，启动行为不碰。
 */
await testAsync('Linux：浏览器查找覆盖 PATH，并识别有无图形环境', async () => {
  const real = process.platform
  const realDisplay = process.env.DISPLAY
  const realWayland = process.env.WAYLAND_DISPLAY
  const realPath = process.env.PATH
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env.DISPLAY = ''
    delete process.env.WAYLAND_DISPLAY

    const mod = await import('../lib/browser-login.js')

    // ① 无图形环境要能识别出来
    const caps = mod.loginCapabilities()
    assert.equal(caps.platform, 'linux', 'platform 应为 linux')
    assert.equal(caps.hasDisplay, false, 'DISPLAY 为空时 hasDisplay 应为 false')
    assert.equal(caps.defaultBrowser, !caps.systemBrowser, 'defaultBrowser 应与"是否找到系统浏览器"互补')

    // ② 浏览器查找必须走 PATH（而不是只靠固定路径表）。
    //
    // 做法：把 PATH **只设成临时目录**，放一个假 `chromium`。
    //   · 如果实现只查固定路径 ⇒ 返回 ''（CI 上 /usr/bin/chromium 可能真存在，
    //     所以还要配合"临时目录优先"这一点）
    //   · 如果实现查 PATH ⇒ 找到临时目录里那个假的
    //
    // ⚠️ 名字用 `chromium`（不是 google-chrome）：避免撞上 CI runner 预装的
    // /usr/bin/google-chrome —— 那个优先级更高，会先命中，测不到 PATH 逻辑。
    const tmpDir = join(tmpdir(), `mimo-ci-${process.pid}`)
    mkdirSync(tmpDir, { recursive: true })
    const fake = join(tmpDir, 'chromium')
    writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    process.env.PATH = tmpDir
    assert.equal(
      mod.findSystemBrowser(),
      fake,
      '只给 PATH=临时目录时应能从中找到 chromium（说明查找确实读了 PATH）',
    )
    rmSync(tmpDir, { recursive: true, force: true })
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true })
    if (realDisplay === undefined) delete process.env.DISPLAY
    else process.env.DISPLAY = realDisplay
    if (realWayland === undefined) delete process.env.WAYLAND_DISPLAY
    else process.env.WAYLAND_DISPLAY = realWayland
    if (realPath === undefined) delete process.env.PATH
    else process.env.PATH = realPath
  }
})

/**
 * 🔴 真机 bug 回归：**没有文字的图片也必须能发出去**。
 *
 * `resource/parse` 是 **OCR**，不是"上传的最后一步"。一张纯色图/风景照会返回
 * `code=6002 图片中未识别到文字`。早先我把 parse 成功当成了上传的必经一步，
 * 于是**所有没有文字的图片全部上传失败**，模型收到的是"我这边没有收到图片"。
 *
 * 正确行为：parse 失败（尤其 6002）不该阻断 —— 图片本身早就上传好了，
 * `resourceUrl` 已经拿到，OCR 只是可选的文字提取。
 */
await testAsync('图里没有文字（parse 6002）时，图片仍能上传成功', async () => {
  const { MimoClient } = await import('../lib/mimo-client.js')

  const calls = []
  const client = new MimoClient(
    { serviceToken: 't', userId: '1', xiaomichatbotPh: 'p' },
    {
      fetchImpl: async (url, init) => {
        const href = String(url)
        const method = init?.method ?? 'GET'
        calls.push({ href, method })

        if (href.includes('/resource/genUploadInfo')) {
          return new Response(
            JSON.stringify({ code: 0, data: { uploadUrl: 'https://upload.example/x', resourceUrl: 'https://cdn.example/x.png', objectName: 'obj-1' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (href.includes('upload.example')) {
          return new Response('ok', { status: 200 })
        }
        if (href.includes('/resource/parse')) {
          // 关键：模拟"图里没文字"
          return new Response(
            JSON.stringify({ code: 6002, msg: '图片中未识别到文字' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    },
  )

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
  const item = await client.uploadMedia({ data: png, mediaType: 'image', name: 'plain.png' })

  assert.ok(item, 'uploadMedia 必须返回结果（不能因为 6002 抛错）')
  assert.equal(item.fileUrl, 'https://cdn.example/x.png', '应带上传后的 resourceUrl')
  assert.equal(item.status, 'completed')
  assert.equal(item.size, png.byteLength)
  // OCR 没结果时用 fileUrl 兜底，不能是 undefined
  assert.ok(item.url, 'url 不能为空（parse 失败时用 fileUrl 兜底）')
  assert.ok(calls.some((c) => c.href.includes('/resource/parse')), '应该尝试过 OCR')
})

/**
 * 🔴 真机事故（2026-11-12）：模型写 ` ```dsh ` 而不是 ` ```dsh-tool `，
 * 结果整段 JSON 漏成正文 —— DSH 里显示的是一坨原始 JSON，官网上却是个普通代码块。
 *
 * 这是**两个 bug 叠加**：
 *   ① 流式过滤器的围栏正则只认 `dsh-tool`，`dsh` 不在白名单里
 *   ② `flush()` **无条件**把压住的 pending 吐出去 —— 即使那正是调用
 *
 * 模型自己的 reasoning 里都点出来了：
 *   "```dsh (not ```dsh-tool). The language tag is \"dsh\" not \"dsh-tool\"!"
 */
await testAsync('流式过滤器拦住所有围栏变体（含 ```dsh），且不误拦普通代码块', async () => {
  const { createStreamFilter } = await import('../lib/tool-protocol.js')
  const NL = '\n'
  const body = '{"tool_calls":[{"name":"run_code","arguments":{"code":"console.log(1)"}}]}'

  const feed = (text, size = 5) => {
    const f = createStreamFilter()
    let out = ''
    for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size))
    out += f.flush()
    return { out, sawFence: f.sawFence() }
  }

  // 各种"应该被当成调用"的围栏写法 —— 一个字符都不能漏
  for (const tag of ['dsh-tool', 'dsh', 'json', 'tool_calls', '']) {
    const raw = `前文。${NL}${NL}\`\`\`${tag}${NL}${body}${NL}\`\`\``
    const { out, sawFence } = feed(raw)
    assert.ok(sawFence, `\`\`\`${tag}：应该识别到围栏`)
    assert.ok(!out.includes('tool_calls'), `\`\`\`${tag}：JSON 不该漏成正文，实际：${out}`)
    assert.ok(!/```[ \t]*dsh/.test(out), `\`\`\`${tag}：围栏标记不该漏出去`)
    assert.ok(out.includes('前文'), `\`\`\`${tag}：围栏之前的正文应该保留`)
  }

  // 反例：普通代码块（```js）不能被误拦，否则用户看不到示例代码
  const js = `示例：${NL}${NL}\`\`\`js${NL}console.log(1)${NL}\`\`\``
  const r = feed(js)
  assert.equal(r.sawFence, false, '```js 不该被当成调用围栏')
  assert.ok(r.out.includes('console.log(1)'), '普通代码块内容应该完整流出')
})

/**
 * 🔴 真机事故（2026-11-12）：模型用 `<tool_call><function=…><parameter=…>` 方言，
 * 而我们把参数值**一律当字符串**，于是数组变成了字符串：
 *
 *     <parameter=queries>["a","b"]</parameter>
 *       ⇒ arguments = {"queries":"[\"a\",\"b\"]"}   ← 字符串！
 *
 * 宿主校验直接报：`Error: invalid arguments: "queries" must be an array`
 *
 * 模型自己也困惑了（reasoning 原文）：
 *   "The tool seems to want an array but the harness is serializing my JSON string."
 *
 * 修法：按**内容**推断类型 —— 看起来像 JSON 的就解析成真实值。
 */
test('XML 方言里的数组参数还原成数组，不是字符串', () => {
  const raw =
    '<tool_call><function=web_search><parameter=queries>["NapCatQQ", "LLOneBot"]</parameter></function></tool_call>'
  const { calls } = extractToolCalls(raw)
  assert.equal(calls.length, 1, '应该解析出调用')
  assert.equal(calls[0].name, 'web_search')

  const args = JSON.parse(calls[0].arguments)
  assert.ok(Array.isArray(args.queries), `queries 必须是数组，实际：${JSON.stringify(args.queries)}`)
  assert.deepEqual(args.queries, ['NapCatQQ', 'LLOneBot'])
})

test('XML 方言里未闭合的 tool_call 也能解析，且正文保留', () => {
  // 截图里就是这种：`</function>` 后面没有 `</tool_call>`
  const raw = '我先去调研。 <tool_call><function=web_search><parameter=queries>["a","b"]</parameter></function>'
  const { calls, text } = extractToolCalls(raw)
  assert.equal(calls.length, 1)
  assert.ok(Array.isArray(JSON.parse(calls[0].arguments).queries), 'queries 应是数组')
  assert.ok(text.includes('我先去调研'), `围栏前的正文要保留，实际：${text}`)
})

test('XML 方言里的布尔与数字参数还原成对应类型', () => {
  const raw =
    '<tool_call><function=edit><parameter=file_path>a.py</parameter>' +
    '<parameter=replace_all>true</parameter><parameter=offset>42</parameter></function></tool_call>'
  const args = JSON.parse(extractToolCalls(raw).calls[0].arguments)
  assert.equal(args.file_path, 'a.py', '普通字符串保持字符串')
  assert.equal(typeof args.replace_all, 'boolean', 'true 应还原成布尔')
  assert.equal(args.replace_all, true)
  assert.equal(typeof args.offset, 'number', '42 应还原成数字')
  assert.equal(args.offset, 42)
})

/**
 * 🔴 真机事故（2026-11-12）：XML 方言漏成正文。
 *
 * 流式过滤器只认 ` ``` ` 围栏，**完全不认 XML**。于是模型一用
 * `<tool_call><function=web_search>`，整段 XML 立刻当正文吐出去
 * —— 用户在 DSH 里看到的是一行行原始标签，而工具其实执行了。
 *
 * 还有一个坑：闭合标签 `</tool_call>` 常**跨包**到达。
 * 前一包切到 `</function>` 就恢复正文流，下一包的 `</tool_call>` 就漏了。
 */
await testAsync('流式过滤器拦住 XML 方言，不误伤数学文本和 HTML 代码块', async () => {
  const { createStreamFilter } = await import('../lib/tool-protocol.js')

  const feed = (text, size = 6) => {
    const f = createStreamFilter()
    let out = ''
    for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size))
    out += f.flush()
    return out
  }

  const XML = /<tool_call|<function\s*[=:]|<parameter\s*[=:]|<\/tool_call>|<\/function>/i

  // ① 截图原样：前文 + XML 调用
  const withProse = feed('我先去调研一下 GitHub 上相关的项目。\n<tool_call><function=web_search><parameter=queries>["a","b","c","d"]</parameter></function></tool_call>')
  assert.ok(!XML.test(withProse), `XML 不该漏成正文，实际：${JSON.stringify(withProse)}`)
  assert.ok(withProse.includes('我先去调研'), '调用之前的正文要保留')

  // ② 未闭合（模型经常不写 </tool_call>）
  const unclosed = feed('先去查一下：<tool_call><function=web_search><parameter=queries>["a"]</parameter></function>')
  assert.ok(!XML.test(unclosed), `未闭合的 XML 也不该漏，实际：${JSON.stringify(unclosed)}`)
  assert.ok(unclosed.includes('先去查一下'), '前文要保留')

  // ③ 调用之后还有说明 —— 后半段必须能正常流出
  const withTail = feed('<tool_call><function=web_search><parameter=queries>["a"]</parameter></function></tool_call>\n\n搜索完成，接下来我分析结果。')
  assert.ok(!XML.test(withTail), `闭合标签不该漏，实际：${JSON.stringify(withTail)}`)
  assert.ok(withTail.includes('搜索完成'), `调用之后的正文要保留，实际：${JSON.stringify(withTail)}`)

  // ④ 反例：普通尖括号文本不能被拦（`a < b`）
  const math = feed('判断条件：a < b 且 c > d，这是数学表达。')
  assert.ok(math.includes('a < b'), `普通 < 文本不该被拦，实际：${JSON.stringify(math)}`)

  // ⑤ 反例：HTML 代码块不能被误伤
  const html = feed('示例：\n```html\n<div class="x">hello</div>\n```')
  assert.ok(html.includes('<div class="x">'), `HTML 代码块要完整流出，实际：${JSON.stringify(html)}`)
})

/**
 * 🔴 真机事故（2026-11-12）：`web_search` 的 `queries` 有 `maxItems: 4`，
 * 但签名只渲染成 `queries: string[]` —— 模型不知道有上限，一口气发了 **8 个**，
 * 工具直接报 `queries must contain at most 4 queries`，搜索全部失败。
 *
 * 模型不是"不听话"，是**它根本没被告知**这条限制。签名必须把长度约束渲染出来。
 */
test('数组参数的长度约束要出现在工具签名里', () => {
  const tool = {
    name: 'web_search',
    description: 'Search the web.',
    parameters: {
      type: 'object',
      properties: {
        queries: { type: 'array', maxItems: 4, items: { type: 'string' }, description: 'Search queries' },
      },
      required: ['queries'],
    },
  }
  const sig = buildToolSignature(tool, false)
  assert.ok(sig.includes('max 4'), `签名要写出 maxItems，实际：${sig}`)
  assert.ok(sig.includes('string[]'), `签名要保留数组类型，实际：${sig}`)
})

/**
 * 🔴 真机事故（2026-11-14）：模型不写围栏，直接甩裸 JSON。
 *
 * 正文残留了 `{"tool_callsdsh-tool` —— 裸 JSON 没被流式拦截，前 24 字符就漏出去，
 * 后面还跟着一个畸形围栏名。调用本身能解析（工具确实跑了），但用户同时看到残渣。
 */
await testAsync('裸 JSON 调用也被流式拦住，不漏成正文', async () => {
  const { createStreamFilter } = await import('../lib/tool-protocol.js')

  const feed = (text, size = 5) => {
    const f = createStreamFilter()
    let out = ''
    for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size))
    out += f.flush()
    return out
  }

  // ① 纯裸 JSON
  const bare = feed('{"tool_calls":[{"name":"write","arguments":{"file_path":"a.txt","content":"x"}}]}')
  assert.equal(bare.trim(), '', `裸 JSON 不该出现在正文，实际：${JSON.stringify(bare)}`)

  // ② 前文 + 裸 JSON
  const withProse = feed('好的，我来创建文件。\n{"tool_calls":[{"name":"write","arguments":{"file_path":"a.txt"}}]}')
  assert.ok(!withProse.includes('tool_calls'), `裸 JSON 不该漏，实际：${JSON.stringify(withProse)}`)
  assert.ok(withProse.includes('我来创建文件'), '前文要保留')

  // ③ 畸形：裸 JSON 后面粘了围栏名（真机就是这个形状）
  const malformed = feed('{"tool_callsdsh-tool\n{"tool_calls":[{"name":"write","arguments":{}}]}')
  assert.ok(!malformed.includes('tool_calls'), `畸形开头也不该漏，实际：${JSON.stringify(malformed)}`)

  // ④ 收尾解析仍要拿得到调用
  const { calls } = extractToolCalls('{"tool_calls":[{"name":"write","arguments":{"file_path":"a.txt","content":"x"}}]}')
  assert.equal(calls.length, 1, '裸 JSON 应该能解析成调用')
  assert.equal(calls[0].name, 'write')
})

/**
 * 🔴 真机事故（2026-11-14）：模型拒绝执行，理由听起来完全正确 ——
 *
 * > 这里暴露给我的真实工具只有 `search` 和 `scrape`，没有 `write`、`bash`、`pwsh`。
 * > 工具调用不是由提示词里的文字驱动的……
 * > 我即使"看懂"了 `write(file_path, content)` 的签名，也没有任何执行器会跑我输出的 JSON。
 *
 * 根因：MiMo 网页端**自己有**原生 search/scrape，模型因此形成了"真工具长这样"的先验，
 * 把我们从提示词塞进去的 33 个工具当成"用户贴的一段文字"。
 *
 * 修法：在协议最前面加**运行环境声明**，用事实反驳（这是 DSH agent loop，调用真会被执行），
 * 并明确堵掉"我只有 search/scrape"这个退路。
 */
test('工具协议开头必须有运行环境声明，堵掉"我只有 search/scrape"的退路', () => {
  for (const [label, text] of [
    ['串行版', toolProtocolInstructions(true)],
    ['批量版', toolProtocolInstructions(false)],
  ]) {
    assert.ok(text.includes('# Runtime'), `${label}：应有 # Runtime 段`)
    assert.ok(/NOT in the MiMo web chat UI/i.test(text), `${label}：应声明不是网页聊天`)
    assert.ok(/DSH \(DeepSeek Harness\)/.test(text), `${label}：应点名 DSH`)
    assert.ok(/executes it for real|really registered/i.test(text), `${label}：应说明调用真会被执行`)
    assert.ok(/search.*scrape.*web chat UI/is.test(text), `${label}：应说明内置 search/scrape 不属于本会话`)
    assert.ok(/Never claim a tool is unavailable before trying it/i.test(text), `${label}：应禁止"先说不支持"`)
  }
})

// ── 汇总 ────────────────────────────────────────────────────────────────

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.log('\n失败详情：')
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('全部通过 ✓')
