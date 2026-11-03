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

/** 调用块的开始标记。刻意选一个模型不会在正文里自然写出来的词。 */
export const CALL_OPEN = '<mimo_tool_call>'
export const CALL_CLOSE = '</mimo_tool_call>'

/** 系统提示里追加的协议说明。 */
export function toolProtocolInstructions() {
  return [
    '## 工具调用协议',
    '',
    '你有一批工具可用。**当且仅当**需要工具时，输出下面这个块，不要用任何其它格式：',
    '',
    CALL_OPEN,
    '{"name": "工具名", "arguments": {"参数名": 值}}',
    CALL_CLOSE,
    '',
    '规则：',
    `1. 一个块里只放一个调用；要调多个就写多个块，每个块独占一行。`,
    `2. \`arguments\` 必须是 JSON 对象，键名严格取自工具定义里的参数名，不要自创。`,
    `3. 不要把这些块放进 markdown 代码围栏（\`\`\`），不要解释你在调用什么。`,
    `4. 如果要调工具，**整条回复只能有调用块**，不要在前面或后面写正文。`,
    `5. 工具执行结果会以「[工具结果 …]」的形式回到对话里；拿到结果后再决定下一步。`,
    `6. 不要使用 \`antml:invoke\`、\`<tool_call>\`、\`TOOL_CALL:\` 这些其它格式 —— 它们不会被识别。`,
    '',
    '示例（读取一个文件）：',
    CALL_OPEN,
    '{"name": "read", "arguments": {"file_path": "C:\\\\Users\\\\me\\\\note.txt"}}',
    CALL_CLOSE,
  ].join('\n')
}

/**
 * 把 DSH 下发的工具定义渲染成提示词段落。
 *
 * 预算控制很重要：DSH 可能下发几十个工具，全量塞进去会把固定头撑爆，
 * 而固定头每轮都要重发。超预算时**必须把被省略的工具名说出来** ——
 * 否则模型连"还有哪些工具存在"都不知道，只能瞎猜名字和参数。
 */
export function buildToolSection(tools, maxChars = 40_000) {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  const parts = ['', '## 可用工具', '']
  let budget = maxChars
  const omitted = []

  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || !tool.name) continue
    const description = String(tool.description ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    const schema = safeSchemaText(tool.parameters)
    const block = [
      `### ${tool.name}`,
      description.length > 600 ? `${description.slice(0, 600)}…` : description,
      `参数（JSON Schema）：${schema}`,
    ].join('\n')

    if (block.length > budget) {
      omitted.push(tool.name)
      continue
    }
    budget -= block.length
    parts.push(block, '')
  }

  if (omitted.length > 0) {
    parts.push(
      `⚠️ 上面没有描述这 ${omitted.length} 个工具（因为长度超预算）：${omitted.join(', ')}。` +
        '如果确实需要其中一个，先问用户要它的准确参数，**不要猜**。',
      '',
    )
  }

  return parts.join('\n')
}

function safeSchemaText(parameters) {
  if (!parameters || typeof parameters !== 'object') return '{}'
  try {
    const text = JSON.stringify(parameters)
    return text.length > 1500 ? `${text.slice(0, 1500)}…` : text
  } catch {
    return '{}'
  }
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

  // ① 主格式：<mimo_tool_call>…</mimo_tool_call>
  const primary = /<mimo_tool_call>\s*([\s\S]*?)\s*<\/mimo_tool_call>/gi
  text = text.replace(primary, (whole, body) => {
    const call = parseCallBody(body)
    if (!call) return whole
    calls.push(call)
    return ''
  })

  // ② 容错：模型把块包进了 ``` 或 ```json 围栏
  if (calls.length === 0) {
    const fenced = /```(?:json|JSON)?\s*\n([\s\S]*?)\n```/g
    text = text.replace(fenced, (whole, body) => {
      const trimmed = body.trim()
      if (!trimmed.startsWith('{')) return whole
      const call = parseCallBody(trimmed)
      if (!call) return whole
      calls.push(call)
      return ''
    })
  }

  // ③ 容错：裸 JSON 对象（模型无视协议直接吐 {"name":…,"arguments":…}）
  if (calls.length === 0) {
    const bare = /\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g
    text = text.replace(bare, (whole) => {
      const call = parseCallBody(whole)
      if (!call) return whole
      calls.push(call)
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

  // ⑥ 收尾清洗：无论解析成没成功，畸形标签残片都不该当正文喷给用户。
  //    （例如 `<tool_call>` 里的标签写坏了、只剩 `</function></tool_call>>`）
  if (calls.length > 0) {
    text = text
      .replace(/<\s*\/?\s*tool_call\s*>\s*>/gi, '')
      .replace(/<\s*\/?\s*tool_call\s*>/gi, '')
      .replace(/<\s*\/?\s*function[^>]*>/gi, '')
      .replace(/<\s*\/?\s*parameter[^>]*>/gi, '')
      .trim()
  }

  return { text: text.trim(), calls }
}

/** 解析一个调用体（JSON / 宽松 JSON / XML 三种形状都试一遍）。 */
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
 * 所以不能只"解析失败才修" —— 解析成功也要看一眼：**参数字符串里出现控制字符**
 * （\n \t \r）在工具参数里几乎只能是路径被吃掉了一半。这时改用"反斜杠全部按字面"
 * 的修复版本重解析，并且只有在修复版**确实不含控制字符**时才采信它。
 */
function parseArgsJson(text) {
  const strict = tryJson(text)
  if (strict === undefined) {
    const repaired = tryJson(repairJson(text))
    return repaired
  }
  if (!hasControlCharsInStrings(strict)) return strict

  const repaired = tryJson(repairJson(text))
  if (repaired !== undefined && !hasControlCharsInStrings(repaired)) return repaired
  return strict
}

/** 递归检查对象里的字符串值有没有控制字符（\n \t \r 之外的不算，那些多半是真内容）。 */
function hasControlCharsInStrings(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return false
  for (const item of Object.values(value)) {
    if (typeof item === 'string') {
      if (/[\n\r\t]/.test(item)) return true
    } else if (item && typeof item === 'object') {
      if (hasControlCharsInStrings(item, depth + 1)) return true
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
