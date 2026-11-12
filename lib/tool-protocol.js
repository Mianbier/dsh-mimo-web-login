/**
 * 提示词工具协议。
 *
 * MiMo 网页端**没有** native function calling（bundle 里没有任何 tools/tool_calls
 * 的请求字段），所以只能靠提示词把工具目录写进 system，再解析模型的输出。
 *
 * 格式选择：MiMo 自己的原生工具走 `antml:invoke` 方言，但**不能用** —— 上游会把它
 * 当成内置工具拦截，未知工具名直接报错并陷入循环。所以这里用一套自定义围栏标记。
 *
 * 解析器要能容忍的漂移（都是实测过的模型行为）：
 *   - 用 ``` 围栏包住调用块；
 *   - 标签大小写不一致、有空格；
 *   - 参数值里带换行、带反斜杠（Windows 路径）、带引号；
 *   - 一次输出多个调用；
 *   - 漂移成 JSON 或 XML 形状。
 *
 * @module lib/tool-protocol
 */

/**
 * 工具调用协议（**照搬 dsh-deepseek-web-login 的方案**）。
 *
 * 为什么不用自定义 XML 标记：DeepSeek 插件那套已经在真机上跑了很久，
 * 它选的形状（围栏代码块 + `{"tool_calls":[...]}` JSON）是被验证过的：
 *
 *   ① 模型对"围栏代码块里放 JSON"这个形状非常熟（训练里到处都是），
 *      而且它天然不会被误解为"我要假装调用工具"；
 *   ② `tool_calls` 是 OpenAI 的原生字段名，模型的先验知识支持它；
 *   ③ 围栏让"正文"和"调用"界限清楚，流式时容易做 hold-back 扫描。
 *
 * ⚠️ 我曾自己发明过 `<mimo_tool_call>` XML 标记，结果模型拿"调用工具"这个
 * 框架去理解时直接拒绝（"我没有 mkdir_test 这个工具"）。照搬成熟方案更省事。
 */
export const CALL_FENCE = 'dsh-tool'
export const CALL_OPEN = '```' + CALL_FENCE
export const CALL_CLOSE = '```'

/**
 * 协议指令与工具目录渲染 —— **全部来自 `lib/ds-protocol.js`**（照搬 DeepSeek）。
 *
 * 这里只做转发，不再自己写中文版：自写版漏掉了 DeepSeek 的 rule 5b
 * （值里的引号、值里的真换行必须转义），那正是模型反复写坏 JSON 的根因。
 */
export {
  TOOL_PROTOCOL_INSTRUCTIONS,
  SERIAL_TOOL_PROTOCOL_INSTRUCTIONS,
  buildToolSection,
  buildToolSignature,
  renderToolCalls,
  isCoreTool,
  CORE_TOOLS,
} from './ds-protocol.js'

import { toolProtocolInstructions as dsToolProtocolInstructions } from './ds-protocol.js'

/** 系统提示里追加的协议说明（默认串行版，与 DeepSeek 一致）。 */
export function toolProtocolInstructions(serialToolCalls = true) {
  return dsToolProtocolInstructions(serialToolCalls)
}


/**
 * 从模型的输出里抽工具调用。
 *
 * 返回 `{text, calls}`：`text` 是剥掉调用块之后的正文，`calls` 是解析出来的调用。
 * 解析不出来的块会被**保留在正文里**（绝不静默吞掉内容 —— 用户至少能看到模型写了什么）。
 */
export function extractToolCalls(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { text: '', calls: [] }
  const calls = []
  let text = raw

  // ① 主格式（协议里约定的那个）：```dsh-tool 围栏 + {"tool_calls":[...]}
  //
  // ⚠️ 这里**不能**用「非贪婪匹配到闭合围栏」的正则。真机上撞过：
  //    模型写 Python 文件时，文件内容里自带三个反引号（markdown 文档串），
  //    正则会在内容里那个 ``` 处提前收尾 ⇒ JSON 被截断 ⇒ 解析失败 ⇒
  //    整个调用被当成正文漏出去，模型还以为"工具调用失败"。
  //
  // 所以照 dsh-deepseek-web-login 的做法：从围栏开栏之后**按花括号配平**
  // 取 JSON（字符串与转义都算进去），内容里的反引号/花括号只是普通字符。
  {
    const r = consumeFencedCalls(text, (info) => info === 'dsh-tool')
    if (r.calls.length > 0) {
      calls.push(...r.calls)
      text = r.text
    }
  }

  // ② 容错：模型写错 info string —— 这是**真机最常见**的一种漂移。
  //
  //    实测模型会写：```dsh（省掉 "-tool"）、```json、```tool_calls、甚至空 ```
  //    只认 `dsh-tool` 的话，这些全都解析不出来、整段漏成正文。
  //    （收尾解析器认了也没用：流式阶段早就把它当正文吐给用户了。）
  if (calls.length === 0) {
    const r = consumeFencedCalls(text, (info) =>
      info === '' ||
      info === 'json' ||
      info === 'json5' ||
      info === 'dsh' ||
      info === 'tool' ||
      info === 'tool_calls' ||
      info === 'tool-call',
    )
    if (r.calls.length > 0) {
      calls.push(...r.calls)
      text = r.text
    }
  }

  // ③ 容错：裸 JSON（没有围栏）。必须带 tool_calls 键，否则不认 ——
  //    免得把正文里恰好提到的 JSON 当成调用。
  if (calls.length === 0) {
    const r = consumeBareCalls(text)
    if (r.calls.length > 0) {
      calls.push(...r.calls)
      text = r.text
    }
  }

  // ④ 兼容：老的自定义 XML 标记（`<mimo_tool_call>{...}</mimo_tool_call>`）。
  //    早期版本用这个形状，模型偶尔还会吐，认一下不亏。
  if (calls.length === 0) {
    const legacyRe = /<mimo_tool_call>\s*([\s\S]*?)\s*<\/mimo_tool_call>/gi
    text = text.replace(legacyRe, (whole, body) => {
      const parsed = parseToolCallsJson(body) ?? (() => {
        const single = parseCallBody(body)
        return single ? [single] : undefined
      })()
      if (!parsed || parsed.length === 0) return whole
      calls.push(...parsed)
      return ''
    })
  }

  // ④ 容错：XML / antml 方言（模型从别的提示词里学来的形状）。
  //    这一路必须单独扫原文 —— 上面的路径都是"先找到块再解析块"，
  //    而 XML 方言本身没有我们的块标记，只能直接匹配。
  if (calls.length === 0) {
    const invokeRe = /<(?:antml:)?invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?invoke>/gi
    text = text.replace(invokeRe, (whole, toolName, inner) => {
      const params = {}
      const paramRe = /<(?:antml:)?(?:parameter|param)\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?(?:parameter|param)>/gi
      let match
      while ((match = paramRe.exec(inner)) !== null) {
        params[match[1]] = stripCdata(match[2]).trim()
      }
      // 参数体也可能是 JSON（`<invoke name="x">{"a":1}</invoke>`）。
      if (Object.keys(params).length === 0) {
        const json = tryJson(inner.trim()) ?? tryJson(repairJson(inner.trim()))
        if (json && typeof json === 'object') Object.assign(params, json)
      }
      if (Object.keys(params).length === 0 && !inner.trim()) {
        calls.push({ id: callId(), name: toolName, arguments: '{}' })
        return ''
      }
      if (Object.keys(params).length === 0) return whole
      calls.push({ id: callId(), name: toolName, arguments: JSON.stringify(params) })
      return ''
    })
  }

  // ⑤ 容错：`<tool_call><function=名字>...</function></tool_call>` 方言。
  //    Qwen / DeepSeek 系的模型常在被要求"用工具"时吐这个形状，
  //    哪怕提示词里明确禁止了 `<tool_call>`（实测真的会无视）。
  //    参数可能在 `<parameter=名>值</parameter>`、`{"a":1}` 或纯文本里。
  if (calls.length === 0) {
    const fnRe = /<tool_call>\s*(?:>?\s*)<function\s*=\s*([A-Za-z0-9_.:-]+)\s*>([\s\S]*?)<\/function>/gi
    text = text.replace(fnRe, (whole, toolName, inner) => {
      const params = {}
      const paramRe = /<parameter\s*=\s*([A-Za-z0-9_.:-]+)\s*>([\s\S]*?)<\/parameter>/gi
      let match
      while ((match = paramRe.exec(inner)) !== null) {
        params[match[1]] = stripCdata(match[2]).trim()
      }
      if (Object.keys(params).length === 0) {
        const json = tryJson(inner.trim()) ?? tryJson(repairJson(inner.trim()))
        if (json && typeof json === 'object' && !Array.isArray(json)) Object.assign(params, json)
      }
      // 允许无参数工具：`<function=x></function>` 就是 CALL("x", {})
      calls.push({ id: callId(), name: toolName, arguments: JSON.stringify(params) })
      return ''
    })
    // 兜底：`<tool_call>` 里只有个名字、连 `<function=…>` 都没写对
    if (calls.length === 0) {
      const looseRe = /<tool_call>\s*<function\s*=\s*([A-Za-z0-9_.:-]+)[^>]*>[\s\S]*?<\/tool_call>/gi
      text = text.replace(looseRe, (whole, toolName) => {
        calls.push({ id: callId(), name: toolName, arguments: '{}' })
        return ''
      })
    }
    // 再兜一层：残留的 `<tool_call>` 残片（模型常常写成 `</tool_call>>` 这种畸形）
    if (calls.length === 0) {
      const bracketRe = /<tool_call>\s*<function\s*=\s*([A-Za-z0-9_.:-]+)\s*[>]?[\s\S]*?/gi
      text = text.replace(bracketRe, (whole, toolName) => {
        calls.push({ id: callId(), name: toolName, arguments: '{}' })
        return ''
      })
    }
  }

  // ⑥ 收尾清洗：调用已经解析出来了，就别把围栏残留当正文喷给用户。
  if (calls.length > 0) {
    text = text
      .replace(/<\s*\/?\s*tool_call\s*>\s*>/gi, '')
      .replace(/<\s*\/?\s*tool_call\s*>/gi, '')
      .replace(/<\s*\/?\s*function[^>]*>/gi, '')
      .replace(/<\s*\/?\s*parameter[^>]*>/gi, '')
      // 模型把围栏名写坏粘在 JSON 前面（`{"tooldsh-tool`）——调用已经拿到，残渣清掉
      .replace(/\{\s*"?(?:tool)?dsh-tool\s*\n?/gi, '')
      .replace(/```[ \t]*(?:dsh-tool)?[ \t]*\r?\n?/g, '')
      .trim()
  }

  return { text: text.trim(), calls }
}

/**
 * 从一段混杂文本里抢救出一个 JSON 对象（`extractBalancedObject` 的薄封装）。
 *
 * 用于"围栏里多了杂行、整段 parse 失败"的情况 —— 宁可从脏数据里救出来，
 * 也不要让整个调用漏成正文。
 *
 * @param {string} text
 * @returns {string|undefined}
 */
function salvageJsonObject(text) {
  return extractBalancedObject(text, 0)?.json
}

/**
 * 把 **JSON 字符串字面量内部**的裸控制字符转成合法的转义序列。
 *
 * 只处理 `"…"` 内部：结构里的换行/缩进本来就是合法的，动了会把整个 JSON 弄坏。
 *
 * ⚠️ 一个重要的语义判断：裸换行该转成 `\n` 还是保留成真换行？
 *
 * 模型把**真换行**敲进字符串里，通常是想表达"这里要换行"（比如用 edit 把字面
 * `\n` 换成真换行）。如果机械地转成 `"\\n"`（字面反斜杠+n），含义就丢了 ——
 * 用户会看到 "把 \n 换成 \n"，等于没改。
 *
 * 所以这里优先保留**语义**：裸换行 ⇒ 解析成真换行（JSON 里就是 `\n` 转义，
 * 解析后是 U+000A）。字样上的 `"\\n"` 保持原样不动 —— 那本来就是模型写的字面量。
 *
 * @param {string} text
 * @returns {string}
 */
function escapeRawControlCharsInStrings(text) {
  const source = String(text ?? '')
  let out = ''
  let inString = false
  let escaped = false
  let changed = false

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) {
        escaped = false
        out += ch
        continue
      }
      if (ch === '\\') {
        escaped = true
        out += ch
        continue
      }
      if (ch === '"') {
        inString = false
        out += ch
        continue
      }
      // 裸控制字符：转成 JSON 合法转义，解析后仍是真换行/制表符（语义保住）
      if (ch === '\n') { out += '\\n'; changed = true; continue }
      if (ch === '\r') { out += '\\r'; changed = true; continue }
      if (ch === '\t') { out += '\\t'; changed = true; continue }
      // 其余 C0 控制字符（含 MiMo SSE 里偶发的 \u0000）JSON 一律不许出现，
      // 一律转成 \uXXXX。不转的话 JSON.parse 必失败，整个调用就漏成正文。
      const code = ch.charCodeAt(0)
      if (code < 0x20 || code === 0x7f) {
        out += '\\u' + code.toString(16).padStart(4, '0')
        changed = true
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') inString = true
    // 字符串**外部**的 C0 控制字符也是非法 JSON（除空白），一并转义 ——
    // 但只转那些不可能出现在合法 JSON 结构里的（\n \r \t 在结构里是合法空白，保留）
    if (ch.charCodeAt(0) === 0x00) {
      out += ' '
      changed = true
      continue
    }
    out += ch
  }

  return changed ? out : source
}

/**
 * 更狠的一层修复：**字符串内容里有未转义的裸双引号**。
 *
 * 🔴 这是真机事故的真凶。模型写 Python 时，docstring 的
 * `"""临时诊断"""` 三对引号**没转义**就塞进 JSON 字符串里：
 *
 *     "content":"# -*- coding: utf-8 -*-
 *     """临时诊断"""        ← 这几个 " 把 JSON 字符串提前闭合了
 *     nc = Cradle()"}}]}
 *
 * 光靠字符扫描没法判断哪个 `"` 是真闭合（`"""` 里每个都长得一样）。
 * 但 JSON 结构是确定的：**真闭合引号之后必然紧跟** `,` `}` `]` `:` 或空白收尾。
 *
 * 所以换个思路重扫：遇到 `"` 先看它后面第一个非空白字符——
 *   · 是 `,` `}` `]` `:` ⇒ 真闭合，收尾；
 *   · 否则 ⇒ 内容里的裸引号，转义成 `\"` 留在字符串里。
 *
 * @param {string} text
 * @returns {string}
 */
function repairUnescapedQuotesInStrings(text) {
  const source = String(text ?? '')
  let out = ''
  let inString = false
  let escaped = false
  let changed = false

  /** 从 i+1 起跳过空白，看第一个非空白字符是不是结构标记。 */
  const followedByStructure = (i) => {
    for (let j = i + 1; j < source.length; j += 1) {
      const c = source[j]
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') continue
      return c === ':' || c === ',' || c === '}' || c === ']'
    }
    return true // 到结尾也算
  }

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) { escaped = false; out += ch; continue }
      if (ch === '\\') { escaped = true; out += ch; continue }
      if (ch === '"') {
        if (followedByStructure(i)) {
          inString = false
          out += ch
          continue
        }
        // 内容里的裸引号 —— 转义它，别让它闭合字符串
        out += '\\"'
        changed = true
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') inString = true
    out += ch
  }

  return changed ? out : source
}

/**
 * 从 `from` 起找到第一个 `{`，并**按花括号配平**取出一个完整的 JSON 对象。
 *
 * 字符串状态与反斜杠转义都算进去，所以对象里的反引号、单边花括号、引号
 * 都不会干扰配平。这是 DeepSeek 插件 `extractBalancedJson` 的同类做法。
 *
 * @param {string} text
 * @param {number} from
 * @returns {{json: string, end: number}|undefined} end = 闭合 `}` 之后的下标
 */
function extractBalancedObject(text, from = 0) {
  const source = String(text ?? '')
  const start = source.indexOf('{', from)
  if (start < 0) return undefined

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return { json: source.slice(start, i + 1), end: i + 1 }
    }
  }
  return undefined
}

/**
 * 扫描所有 ``` 围栏，把「info string 符合条件 + 内容是合法 tool_calls JSON」
 * 的块吃掉，返回剩下的正文与解析出的调用。
 *
 * @param {string} text
 * @param {(info: string) => boolean} acceptInfo
 * @returns {{text: string, calls: Array<object>}}
 */
function consumeFencedCalls(text, acceptInfo) {
  const source = String(text ?? '')
  const openRe = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n/g
  const calls = []
  let out = ''
  let cursor = 0
  let m

  while ((m = openRe.exec(source)) !== null) {
    const info = String(m[1] ?? '').toLowerCase()
    if (!acceptInfo(info)) continue

    const bodyStart = m.index + m[0].length
    const balanced = extractBalancedObject(source, bodyStart)
    if (!balanced) continue

    const parsed = parseToolCallsJson(balanced.json)
    if (!parsed || parsed.length === 0) continue

    // 闭合围栏：配平结束之后找**下一个行首 ```**，并把它之间的一切都吃掉。
    //
    // 为什么要吞到闭合围栏而不是只吞 JSON：模型常在 JSON 前后夹带说明行
    // （"下面是要执行的调用：" / "注意 workdir 是项目根"）。那些行属于这个
    // 调用块，留在正文里就是噪声。配平已经把 JSON 边界钉死了，所以"吞到
    // 闭合围栏"是安全的，不会误伤块外的正文。
    const rest = source.slice(balanced.end)
    const close = /(?:^|\n)[ \t]*```[ \t]*/.exec(rest)
    const removeEnd = close ? balanced.end + close.index + close[0].length : balanced.end

    out += source.slice(cursor, m.index)
    cursor = removeEnd
    calls.push(...parsed)
    openRe.lastIndex = removeEnd
  }

  if (calls.length === 0) return { text: source, calls }
  out += source.slice(cursor)
  return { text: out, calls }
}

/**
 * 吃掉正文里的裸 `{"tool_calls":[...]}`（没有围栏）。
 *
 * 用配平提取，并**要求顶层出现 tool_calls / tool_call 键**才认 ——
 * 免得把正文里恰好提到的普通 JSON 当调用。
 *
 * @param {string} text
 * @returns {{text: string, calls: Array<object>}}
 */
function consumeBareCalls(text) {
  const source = String(text ?? '')
  const calls = []
  let out = ''
  let cursor = 0
  let from = 0

  for (;;) {
    // 🔴 真机事故（用户截图）：模型把围栏名写成了**键名**，粘成
    //     {"tooldsh-tool
    //     {"tool_calls":[{"name":"pwsh",…}]}
    // 直接从第一个 `{` 配平会拿到那个坏对象（内含不配平的同级 `{`），
    // 于是永远解析失败、整块漏成正文。
    //
    // 对策：先找**真正像调用**的 `{` —— 后面紧跟 `"tool_calls"` / `"tool_call"`
    // （允许中间有空白与引号）。找不到才退回"从任意 `{` 配平 + 含键判定"。
    const markerRe = /\{\s*"?tool_calls?"?\s*:/
    const marker = markerRe.exec(source.slice(from))
    let at = -1
    if (marker) {
      at = from + marker.index
    } else {
      at = source.indexOf('{', from)
    }
    if (at < 0) break

    const balanced = extractBalancedObject(source, at)
    if (!balanced) {
      from = at + 1
      continue
    }

    const parsed = parseToolCallsJson(balanced.json)
    if (parsed && parsed.length > 0) {
      out += source.slice(cursor, at)
      cursor = balanced.end
      calls.push(...parsed)
      from = balanced.end
      continue
    }
    from = balanced.end
  }

  if (calls.length === 0) return { text: source, calls }
  out += source.slice(cursor)
  return { text: out, calls }
}

/** 解析一个调用体（JSON / 宽松 JSON / XML 三种形状都试一遍）。 */
/**
 * 解析 `{"tool_calls":[{name, arguments}]}` 形状（协议里约定的主格式）。
 *
 * 宽容度对齐 dsh-deepseek-web-login 的 `parseToolCallJson`：模型实际会写成
 * 各种变形，这里都认 ——
 *   - `"tool_calls"`（数组）或 `"tool_call"`（单数对象）
 *   - 参数键名 `arguments` / `parameters` / `args`
 *   - **参数平铺在调用对象上**（`{"name":"pwsh","command":"...","workdir":"..."}`）——
 *     模型很爱这么写，真机上淹过一次：当时只认 arguments 键，于是参数被丢光、
 *     变成 `pwsh {}` 的空调用，然后整块当成正文漏出来。
 *   - 参数是 JSON 字符串时再解一层；解不开就原样包进 `_raw`（别丢内容）
 *   - `arguments` 被写成只有一个元素的数组（`[{...}]`）也认
 *
 * @param {string} raw
 * @returns {Array<{id:string,name:string,arguments:string}>|undefined}
 */
function parseToolCallsJson(raw) {
  let parsed = parseArgsJson(String(raw ?? '').trim())

  // ★ 关键兜底：**字符串字面量里的裸换行/制表符**。
  //
  // JSON 不允许字符串里出现真换行。但模型写代码时很自然会这样：
  //     "new_string":"
  //     "
  // 真机实测（用户截图）：模型想用 edit 把「字面 \n」换成真换行，值里直接敲了回车，
  // JSON 解析必然失败 ⇒ 整个调用被当正文漏出来。这占 "工具调用失败" 的大头。
  //
  // 所以解析失败时，扫一遍把**字符串内部**的裸控制字符转成转义序列再试。
  // 只动字符串内部，不动结构 —— 结构里的换行本来就是合法的。
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const fixed = escapeRawControlCharsInStrings(String(raw ?? ''))
    if (fixed !== raw) parsed = parseArgsJson(fixed)
  }

  // ★ 兜底：围栏里混进杂行（注释、解释、半个标签）时整段 JSON.parse 会失败。
  //   真机上模型自己都说过"围栏里多了一行字符导致格式坏了" —— 这种不该把
  //   整个调用丢掉当正文。从第一个 `{` 起按括号配平截出最长的候选再试。
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const salvaged = salvageJsonObject(String(raw ?? ''))
    if (salvaged) parsed = parseArgsJson(escapeRawControlCharsInStrings(salvaged))
  }

  // ★★ 最狠一层：**字符串里未转义的裸双引号**。
  //
  // 真机事故（用户截图）：模型写 Python 的 `"""docstring"""`，三对引号没转义
  // 就塞进 JSON 字符串 ⇒ 字符串提前闭合 ⇒ 解析失败 ⇒ 整个调用漏成正文。
  //
  // 前面几层都救不了这种（它们只处理换行/杂行，不碰引号配对）。
  // 这一层按"闭合引号后面必跟结构标记"的规律重扫，把内容里的裸引号转义掉。
  //
  // ⚠️ 必须放在最后：它是**改写性**最强的一步，正常 JSON 绝不该走到这里。
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const source = String(raw ?? '')
    const rebuilt = repairUnescapedQuotesInStrings(escapeRawControlCharsInStrings(source))
    if (rebuilt !== source) {
      const candidates = [rebuilt, salvageJsonObject(rebuilt)].filter(Boolean)
      for (const cand of candidates) {
        const attempt = parseArgsJson(cand)
        if (attempt && typeof attempt === 'object' && !Array.isArray(attempt)) {
          parsed = attempt
          break
        }
      }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined

  const list = Array.isArray(parsed.tool_calls)
    ? parsed.tool_calls
    : parsed.tool_call && typeof parsed.tool_call === 'object'
      ? [parsed.tool_call]
      : undefined
  if (!Array.isArray(list)) return undefined

  const calls = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const name = typeof entry.name === 'string' ? entry.name : typeof entry.tool === 'string' ? entry.tool : ''
    if (!name) continue

    let args = entry.arguments ?? entry.parameters ?? entry.args ?? entry.input
    // 模型有时把参数包成单元素数组
    if (Array.isArray(args) && args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      args = args[0]
    }
    // ★ 没有 arguments 键时，把**除元信息之外的同级字段**整体当参数。
    //   元信息 = name/tool/description/type/id 等结构性键，它们不是工具参数。
    if (args === undefined || args === null) {
      const meta = new Set(['name', 'tool', 'tool_name', 'description', 'type', 'id', 'arguments', 'parameters', 'args', 'input'])
      const flat = {}
      for (const [k, v] of Object.entries(entry)) {
        if (meta.has(k)) continue
        flat[k] = v
      }
      args = flat
    }
    let serialized
    if (typeof args === 'string') {
      // 参数本身也可能是 JSON 字符串，解一层再定
      const inner = parseArgsJson(args)
      serialized = inner !== undefined && inner !== null && typeof inner === 'object'
        ? JSON.stringify(inner)
        : JSON.stringify({ _raw: args })
    } else {
      try {
        serialized = JSON.stringify(args ?? {})
      } catch {
        serialized = '{}'
      }
    }
    calls.push({ id: callId(), name, arguments: serialized })
  }
  return calls.length > 0 ? calls : undefined
}

function parseCallBody(body) {
  const trimmed = String(body ?? '').trim()
  if (!trimmed) return undefined

  const json = parseArgsJson(trimmed)
  if (json) {
    const name = json.name ?? json.tool ?? json.tool_name
    if (typeof name === 'string' && name) {
      const args = json.arguments ?? json.args ?? json.parameters ?? json.input ?? {}
      return { id: callId(), name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
    }
  }

  // XML 兜底：<invoke name="x"><parameter name="k">v</parameter></invoke>
  const nameMatch = /(?:name|tool)\s*=\s*"([^"]+)"/i.exec(trimmed)
  if (nameMatch) {
    const params = {}
    const paramRe = /<(?:parameter|param)\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/(?:parameter|param)>/gi
    let match
    while ((match = paramRe.exec(trimmed)) !== null) {
      params[match[1]] = stripCdata(match[2]).trim()
    }
    if (Object.keys(params).length > 0) {
      return { id: callId(), name: nameMatch[1], arguments: JSON.stringify(params) }
    }
  }

  return undefined
}

/**
 * 解析参数 JSON —— 带一条"路径保护"判据。
 *
 * ⚠️ 这是这里最容易写错的一处：`"C:\note.txt"` 里 `\n` 是**合法** JSON 转义，
 * 于是 `JSON.parse` 会**成功**，但把路径悄悄变成 `C:` + 换行 + `ote.txt`。
 * 工具于是跑到一个根本不存在的路径上，而错误信息看起来会像是"文件不存在"。
 *
 * 所以不能只"解析失败才修" —— 解析成功也要看一眼。但**只看路径类字段**
 * （见 `hasControlCharsInPathFields` 的注释：扫全对象会把多行文件内容写坏）。
 */
function parseArgsJson(text) {
  const strict = tryJson(text)
  if (strict === undefined) {
    const repaired = tryJson(repairJson(text))
    return repaired
  }
  if (!hasControlCharsInPathFields(strict)) return strict

  const repaired = tryJson(repairJson(text))
  if (repaired !== undefined && !hasControlCharsInPathFields(repaired)) return repaired
  return strict
}

/**
 * 只看**路径类字段**里有没有控制字符。
 *
 * ⚠️ 早期版本是"整个对象扫一遍，发现控制字符就用反斜杠字面版重解析"。
 * 那会误伤 `content` / `new_string` —— 模型写文件时那里**本来就该有换行**
 * （多行 Python 源码）。一刀切会把真换行全变成字面 `\n`，写出来的文件全是
 * "反斜杠 n"，等于把文件写坏。真机验证时就栽在这上面。
 *
 * 现在只查路径类字段：那种地方出现换行只可能是 `C:\note.txt` 被 `\n`
 * 转义吃成了两行，正是要防的那个事故。
 */
const PATH_LIKE_KEYS = /^(file_?path|path|cwd|dir|directory|filename|new_path|old_path|target|url)$/i

function hasControlCharsInPathFields(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return false
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') {
      if (PATH_LIKE_KEYS.test(key) && /[\n\r\t]/.test(item)) return true
    } else if (item && typeof item === 'object') {
      if (hasControlCharsInPathFields(item, depth + 1)) return true
    }
  }
  return false
}

function stripCdata(value) {
  const text = String(value ?? '')
  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(text)
  return cdata ? cdata[1] : text
}

function tryJson(text) {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 修常见的非法 JSON。
 *
 * 最要命的一类是 Windows 路径：`"C:\Users\me\new.txt"` 里 `\U` 是非法转义（解析失败），
 * 而 `\n` **是合法转义**，于是 `\note.txt` 会被静默变成换行 —— 路径悄悄坏掉，
 * 工具跑到一个不存在的路径上。所以合法转义也要当成字面反斜杠处理，
 * 只在明确是 `\\` 时保留。
 */
function repairJson(text) {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"' && text[i - 1] !== '\\') {
      inString = !inString
      out += ch
      continue
    }
    if (inString && ch === '\\') {
      const next = text[i + 1]
      if (next === '\\' || next === '"') {
        out += ch + next
        i += 1
        continue
      }
      // 其它情况一律按字面反斜杠转义，避免 \n \t \r 被静默解释。
      out += '\\\\'
      continue
    }
    out += ch
  }
  // 去掉对象/数组尾部的多余逗号。
  return out.replace(/,\s*([}\]])/g, '$1')
}

let callSeq = 0
function callId() {
  callSeq += 1
  return `call_${Date.now().toString(36)}_${callSeq}`
}

// ── 流式过滤器（hold-back 扫描）─────────────────────────────────────────

/**
 * 需要"先压住、等更多字再决定"的尾巴长度上限。
 *
 * 为什么要压：工具调用是 ```dsh-tool + JSON，跨 SSE 包时半截的 ` ```ds `
 * 如果立刻吐出去，用户会看到残缺标记；而一旦吐出去就收不回来了。
 *
 * 24 足够覆盖 ```` ```dsh-tool ````（12 字符）+ 一点点 JSON 前缀，
 * 比它更长的尾巴必然是正文，可以放心放行。
 */
const HOLD_BACK_CHARS = 24

/**
 * 围栏开栏（允许行首空白）。
 *
 * 🔴 模型会写**各种** info string，不能只认 `dsh-tool`：
 *
 *      ```dsh-tool   ← 协议里约定的
 *      ```dsh        ← 真机最常见（模型把 "-tool" 省了）
 *      ```json       ← 有时这么写
 *      ```           ← 直接省略
 *
 * 早先正则写死 `dsh-tool`，于是模型一写 ` ```dsh `，**流式阶段立刻把整段
 * JSON 当正文吐出去**（收不回来了），用户在 DSH 里看到的是一坨原始 JSON，
 * 而官网上却是一段普通代码块。收尾解析器虽然有 fallback 能认 `dsh`，
 * 但那时内容已经流出去 -- 必须在这里就把它们都算作"可能的调用开栏"。
 */
const FENCE_TAG_RE = String.raw`dsh-tool|dsh|tool|json|json5|tool_calls|tool-call`

/** 开栏正则：三个反引号 + 上面那些 tag（或空）。 */
const FENCE_OPEN_RE = new RegExp('```[ \\t]*(?:' + FENCE_TAG_RE + ')?[ \\t]*\\r?\\n', 'i')

/**
 * 这个尾巴**有没有可能**正在形成围栏/JSON 起点？
 *
 * 判据只看尾巴的最后几十个字符：如果它们是某个开栏的前缀，
 * 或者刚开了 `{` 但还没配平，就先压住。
 *
 * @returns {number} 应该从尾部压住的字符数（0 = 可以全放）
 */
function holdBackLength(pending) {
  // ① 尾巴是**任意**开栏的前缀（`、``、```、```d、```dsh、```dsh-t …）
  //
  // 判据放宽到"以反引号开头、且还没超过一个完整开栏的长度"：
  // 因为 ```` ```dsh ```` 和 ```` ```dsh-tool ```` 的前缀完全一样，
  // 在只收到 ```dsh 时**无法判断**它会不会继续长成 dsh-tool。
  // 所以只要尾巴看起来像"半截开栏"就先压住 —— 代价是几十毫秒的延迟，
  // 收益是绝不会把调用漏成正文。
  for (let len = Math.min(HOLD_BACK_CHARS, pending.length); len > 0; len -= 1) {
    const tail = pending.slice(pending.length - len)
    if (!tail.startsWith('`')) continue
    const t = tail.replace(/\s+$/, '')
    // 全是反引号（`、``、```）或者 ``` + 一个 tag 的前缀
    if (/^`{1,3}$/.test(t)) return len
    const m = /^```[ \t]*([A-Za-z0-9_:-]*)$/.exec(t)
    if (m) {
      const tag = m[1].toLowerCase()
      if (!tag) return len // ``` 后面还没写字
      // tag 是某个已知开栏的前缀（或已经完整）
      for (const known of ['dsh-tool', 'dsh', 'tool', 'json', 'json5', 'tool_calls', 'tool-call']) {
        if (known.startsWith(tag) || tag === known) return len
      }
      // 不认识的 tag（比如 ```js）—— 它是普通代码块，不该压
      continue
    }
  }

  // ② 已经开了围栏、JSON 还没配平 ⇒ 整段都压住（等它收尾）
  const fence = FENCE_OPEN_RE.exec(pending)
  if (fence) {
    const after = pending.slice(fence.index + fence[0].length)
    if (extractBalancedObject(after, 0) === undefined) {
      // JSON 还没闭合：压住从围栏起的所有内容
      return pending.length - fence.index
    }
  }

  // ③ 尾巴是 `{"tool_calls":` 这类裸 JSON 的开头
  const bare = /\{\s*"?tool_calls?"?\s*:?\s*$/.exec(pending)
  if (bare) return pending.length - bare.index

  return 0
}

/**
 * 流式过滤器：边收边判断"这段能不能当正文吐出去"。
 *
 * ## 为什么需要它
 *
 * 早先的实现是"正文全部攒完再解析工具调用"，于是**正文一个字都不流式** ——
 * 用户看到思考哗哗出，正文却要等整段生成完才出现。观感上就是"很慢"，
 * 而官网是逐字出的。
 *
 * 但直接边收边吐也不行：工具调用块跨包时会漏出半截 ` ```ds `。
 *
 * 所以照搬 `dsh-deepseek-web-login` 的 `ToolCallStreamFilter`：
 * **用一个几十字符的 hold-back 窗口压住尾巴**，窗口之外的正文立刻吐出去。
 *
 * @returns {{push: (delta: string) => string, flush: () => string, sawFence: () => boolean}}
 */
export function createStreamFilter() {
  let pending = ''
  let sawFence = false
  // v2 协议（`/fastchat`）把思考用 `<think>…</think>` 混在正文里。
  // 流式阶段必须**在这里就剥掉**，否则用户会看到 `<think>` 字面量 ——
  // 早先的实现在收尾时才剥，但那时已经流出去收不回来了。
  let insideThink = false

  /**
   * 把一段文本里的 `<think>` 段剥出来。
   * 返回 `{ out, thinking }` —— thinking 由调用方决定丢不丢（我们直接丢，
   * 因为适配器外层还会用 `unwrapThinkTags` 从 rawText 里再提一次）。
   */
  const stripThink = (text) => {
    let out = ''
    let i = 0
    while (i < text.length) {
      if (insideThink) {
        const close = text.toLowerCase().indexOf('</think', i)
        if (close < 0) return { out: out + '', thinking: true }
        const gt = text.indexOf('>', close)
        i = gt < 0 ? text.length : gt + 1
        insideThink = false
        continue
      }
      const open = text.toLowerCase().indexOf('<think', i)
      if (open < 0) {
        out += text.slice(i)
        break
      }
      out += text.slice(i, open)
      const gt = text.indexOf('>', open)
      if (gt < 0) {
        // 开标签还没收完 —— 先把已确定是正文的部分交出去，剩下的等下一包
        return { out, thinking: false, holdFrom: open }
      }
      i = gt + 1
      insideThink = true
    }
    return { out, thinking: false }
  }

  const emit = (raw) => {
    // NUL 是 v2 的分隔符，绝不能出现在正文里
    let text = String(raw ?? '').replace(/\u0000/g, '')
    if (!text) return ''
    const { out } = stripThink(text)
    return out
  }

  return {
    /** 喂一段增量，返回**现在就能安全吐出去**的正文。 */
    push(delta) {
      pending += String(delta ?? '')

      // 一旦看见围栏，从这里往后就全部压住 —— 后面是调用，不该当正文。
      const fence = FENCE_OPEN_RE.exec(pending)
      if (fence) {
        sawFence = true
        const head = pending.slice(0, fence.index)
        pending = pending.slice(fence.index)
        return emit(head)
      }

      if (pending.length <= HOLD_BACK_CHARS) return ''

      const hold = holdBackLength(pending)
      if (hold >= pending.length) return ''
      const out = pending.slice(0, pending.length - hold)
      pending = pending.slice(pending.length - hold)
      return emit(out)
    },

    /**
     * 流结束时把**还没判断完的尾巴**放出去。
     *
     * 🔴 关键：**见过围栏之后不能再吐**。
     *
     * 早先这里无条件 `return pending`，于是压住的围栏 + 整个 JSON 全被
     * 当正文吐了出去 —— 用户在 DSH 里看到的是一坨原始 JSON，
     * 而工具调用一个都没执行。（2026-11-12 真机事故：模型写 ` ```dsh `
     * 而不是 ` ```dsh-tool `，围栏被识别、内容被压住，最后 flush 又全吐了出来。）
     *
     * 现在：见过围栏 ⇒ pending 属于调用，**丢弃**（收尾解析会把它变成真正的
     * tool-call 块，不需要从正文里补）。没见过围栏 ⇒ 那只是普通正文尾巴，照常吐。
     */
    flush() {
      if (sawFence) {
        pending = ''
        return ''
      }
      const out = pending
      pending = ''
      return emit(out)
    },

    /** 这一轮见过围栏吗（收尾时用来决定 finish 类型）。 */
    sawFence() {
      return sawFence
    },

    /** 压住但还没吐的内容（调试用）。 */
    pendingText() {
      return pending
    },
  }
}

