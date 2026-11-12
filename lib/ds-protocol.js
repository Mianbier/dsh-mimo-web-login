/**
 * 工具协议（**逐字照搬 `dsh-deepseek-web-login`**）。
 *
 * ## 为什么整份搬过来
 *
 * 之前我自己写了一版中文协议，只写了「反斜杠要转义」，**没有** DeepSeek 那两条
 * 关键警告（值里的引号、值里的真换行）。于是模型反复犯这两类错，我就在解析器里
 * 反复打补丁（平铺参数、裸引号、裸换行、反引号截断……）—— 治标不治本。
 *
 * DeepSeek 的做法是**事先在提示词里警告模型**（rule 5b），让它一开始就别写错。
 * 这份文件就是那份提示词的逐字搬运，外加它的工具目录渲染。
 *
 * ## 来源
 *
 * `dsh-deepseek-web-login/lib/index.js`：
 *   - `TOOL_PROTOCOL_INSTRUCTIONS`（批量版）
 *   - `SERIAL_TOOL_PROTOCOL_INSTRUCTIONS`（串行版，**0.5.0 起的默认**）
 *   - `CORE_TOOLS` / `buildToolSignature` / `buildToolSection`
 *   - `renderToolCalls`
 *
 * ⚠️ 提示词刻意用**英文**（原文注释：`these instructions are English only for
 * precision`）。规则文案（尤其 5b 的转义说明）逐字保留，别顺手翻译 —— 改字就
 * 等于换了一套指令，模型行为会变，而那些文案是真机调出来的。
 *
 * @module lib/ds-protocol
 */

// ── 常量（照搬）────────────────────────────────────────────────────────

/** 工具级描述的截断长度。 */
const MAX_DESCRIPTION_CHARS = 3200
/** 参数级描述的截断长度（签名已含名字/类型/必填性，描述属锦上添花）。 */
const MAX_PARAM_DESC_CHARS = 160
/** 嵌套展开深度上限（异常 schema 不该把目录撑爆）。 */
const MAX_SIGNATURE_DEPTH = 4
/** 长尾工具「一行说明」里那句话的上限。 */
const MAX_TAIL_DESCRIPTION_CHARS = 160
/** 工具目录（一节）的总预算。 */
export const MAX_TOOLS_SECTION_CHARS = 56_000
/** head（system + 协议 + 工具目录）在 prompt 里最多占的比例。 */
export const HEAD_RATIO = 0.62
/** 协议段拼接的固定开销。 */
export const PROTOCOL_SLACK_CHARS = 96

/**
 * 「核心工具」白名单 —— 只有它们值得每轮都带完整描述。
 *
 * 依据（DeepSeek 原文：扫最近 8 个会话的 826 次真实工具调用）：
 *   pwsh 27.8% / run_code 24.9% / edit 16.9% / read 9.7% / write 8.0% / bash 5.6%
 *   ⇒ 覆盖 90% 的调用只需要这几个。
 */
export const CORE_TOOLS = new Set([
  'pwsh',
  'bash',
  'run_code',
  'read',
  'write',
  'edit',
  'grep',
  'glob',
  'ls',
  'todo_write',
  'skill',
  'present',
  'ask_user_question',
])

/** 工具是否属于核心组（决定描述给多长、要不要带参数说明）。 */
export function isCoreTool(name) {
  return CORE_TOOLS.has(String(name ?? ''))
}

// ── 协议指令（逐字）────────────────────────────────────────────────────

/** 批量版协议指令。 */
export const TOOL_PROTOCOL_INSTRUCTIONS = `# Tool Calling Protocol

You can call tools to complete the user's task. When you need a tool, output a single JSON object inside a fenced code block, with no other text before or after it:

\`\`\`dsh-tool
{"tool_calls":[{"name":"<tool-name>","arguments":{<json-arguments>}}]}
\`\`\`

Rules:
1. Put every tool you want to run in the "tool_calls" array (usually exactly one; a batch is allowed).
2. Stop immediately after the closing fence. The runner executes the call(s) and returns the results to you as the next message.
3. Never fabricate, guess, or simulate tool output — always wait for the real result.
4. When no tool is needed, answer normally in plain text and do NOT emit that JSON.
5. "arguments" must be valid JSON (double-quoted strings, no trailing commas). When a value is a Windows path, escape backslashes as \\\\ (e.g. "C:\\\\Users\\\\me"); an unescaped single backslash makes the whole object unparsable. Close every brace: the call object and its "arguments" object each need their OWN closing "}" — one missing "}" makes the whole batch unparsable and the call will be discarded.
5b. Two things break the JSON most often — check them before you emit:
   (a) QUOTES INSIDE A VALUE. A shell/PowerShell command very often contains double quotes, e.g. Get-ChildItem "$env:USERPROFILE\\.dsh". Every such inner double quote MUST be escaped as \\" inside the JSON string. An unescaped one ends the string early and discards the whole call.
   (b) LINE BREAKS INSIDE A VALUE. Never put a real line break inside a string; write \\n instead. When a command needs several statements, join them with ";" on ONE line, or use \\n escapes — do not paste them as actual newlines. Prefer single quotes inside commands to reduce escaping.
6. Always wrap the JSON in a \`\`\`dsh-tool fence (see the example above). Do NOT use XML/HTML-like markup instead: no angle-bracket wrapper tags (no <tool_calls>, <invoke>, <parameter>), nor the private delimiter-prefixed variants some DeepSeek surfaces use. An unfenced object or any such markup leaks into the visible transcript and into the web conversation.
7. Always answer in the same language the user writes in (these instructions are English only for precision; the JSON itself is language-neutral).
8. NEVER reproduce the transcript. Do not restate previous turns, "[Tool Result …]" blocks, tool output, or the current prompt. Emit ONLY the calls you want to run right now. A payload that replays earlier calls or embeds tool results is discarded and costs a retry.
9. Keep each batch SMALL — at most 3 calls, and prefer exactly 1. If you need more, send them in successive steps. Long payloads are the ones that most often come out malformed.
10. Each call must be able to run on its own: no shared shell variables across calls, no dependence on another call in the same batch.`

/**
 * 「一次只调用一个工具」版 —— **默认用这份**。
 *
 * 只有 rule 1 / 2 / 9 / 10 与批量版不同；rule 3~8 **必须逐字相同**（那是 JSON
 * 正确性的防线：转义、换行、不许复述转写），改一处忘另一处就会丢掉防线。
 */
export const SERIAL_TOOL_PROTOCOL_INSTRUCTIONS = `# Tool Calling Protocol

You can call tools to complete the user's task. When you need a tool, output a single JSON object inside a fenced code block, with no other text before or after it:

\`\`\`dsh-tool
{"tool_calls":[{"name":"<tool-name>","arguments":{<json-arguments>}}]}
\`\`\`

Rules:
1. Put exactly ONE tool in the "tool_calls" array — one call per message, never a batch.
2. Stop immediately after the closing fence. The runner executes the call and returns the result to you as the next message.
3. Never fabricate, guess, or simulate tool output — always wait for the real result.
4. When no tool is needed, answer normally in plain text and do NOT emit that JSON.
5. "arguments" must be valid JSON (double-quoted strings, no trailing commas). When a value is a Windows path, escape backslashes as \\\\ (e.g. "C:\\\\Users\\\\me"); an unescaped single backslash makes the whole object unparsable. Close every brace: the call object and its "arguments" object each need their OWN closing "}" — one missing "}" makes the whole batch unparsable and the call will be discarded.
5b. Two things break the JSON most often — check them before you emit:
   (a) QUOTES INSIDE A VALUE. A shell/PowerShell command very often contains double quotes, e.g. Get-ChildItem "$env:USERPROFILE\\.dsh". Every such inner double quote MUST be escaped as \\" inside the JSON string. An unescaped one ends the string early and discards the whole call.
   (b) LINE BREAKS INSIDE A VALUE. Never put a real line break inside a string; write \\n instead. When a command needs several statements, join them with ";" on ONE line, or use \\n escapes — do not paste them as actual newlines. Prefer single quotes inside commands to reduce escaping.
6. Always wrap the JSON in a \`\`\`dsh-tool fence (see the example above). Do NOT use XML/HTML-like markup instead: no angle-bracket wrapper tags (no <tool_calls>, <invoke>, <parameter>), nor the private delimiter-prefixed variants some DeepSeek surfaces use. An unfenced object or any such markup leaks into the visible transcript and into the web conversation.
7. Always answer in the same language the user writes in (these instructions are English only for precision; the JSON itself is language-neutral).
8. NEVER reproduce the transcript. Do not restate previous turns, "[Tool Result …]" blocks, tool output, or the current prompt. Emit ONLY the calls you want to run right now. A payload that replays earlier calls or embeds tool results is discarded and costs a retry.
9. Do NOT batch. Emit one call, stop, and wait for its real result before you decide the next step. Needing several tools means several successive messages, one call each — the user has turned batching off for this session, so a multi-call array works against them.
10. Unlike a batch, a call here MAY build on the previous step's result — read what came back and use it. That is the point of one-at-a-time. But never invent a result you have not received.`

/**
 * 本次该用哪一份协议。
 *
 * 与 DeepSeek 一致：**默认串行**（`serialToolCalls !== false`）。
 */
export function toolProtocolInstructions(serialToolCalls = true) {
  return serialToolCalls === false ? TOOL_PROTOCOL_INSTRUCTIONS : SERIAL_TOOL_PROTOCOL_INSTRUCTIONS
}

// ── 工具目录渲染（照搬）───────────────────────────────────────────────

function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max - 3)}...`
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

const SCHEMA_TOP_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'description',
  'title',
  'default',
  'examples',
  '$schema',
  'definitions',
  '$defs',
])

function isWrappedSchema(node) {
  const properties = asRecord(node.properties)
  if (!properties || Object.keys(properties).length === 0) return false
  if (!Object.values(properties).every((value) => asRecord(value) !== null)) return false
  return Object.keys(node).every((key) => SCHEMA_TOP_KEYS.has(key))
}

function isRequiredParam(def) {
  return asRecord(def)?.required === true
}

function paramDescription(schema) {
  const description = asRecord(schema)?.description
  return typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : ''
}

function renderParamMap(map, requiredList, depth) {
  const fromList = new Set(requiredList)
  return Object.entries(map).map(([name, def]) => {
    return `${name}${fromList.has(name) || isRequiredParam(def) ? '' : '?'}: ${renderParamType(def, depth)}`
  })
}

function renderParamType(schema, depth) {
  const node = asRecord(schema)
  if (!node) return 'any'
  if (depth > MAX_SIGNATURE_DEPTH) return 'any'
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    return node.enum.map((value) => JSON.stringify(value)).join(' | ')
  }
  const variants = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null
  if (variants && variants.length > 0) {
    const rendered = variants.map((item) => renderParamType(item, depth + 1))
    return [...new Set(rendered)].join(' | ')
  }
  const declared = typeof node.type === 'string' ? node.type : ''
  if (declared === 'array' || (!declared && node.items !== undefined)) {
    const item = renderParamType(node.items, depth + 1)
    const base = item.includes('|') ? `(${item})[]` : `${item}[]`
    // 🔴 **必须把长度约束渲染出来**。
    //
    // 真机事故（2026-11-12）：`web_search` 的 `queries` 有 `maxItems: 4`，
    // 但签名只渲染成 `queries: string[]` —— 模型不知道有上限，一口气发了 **8 个**，
    // 工具直接报 `queries must contain at most 4 queries`，搜索全部失败。
    //
    // 模型不是"不听话"，是**它根本没被告知**这条限制。
    const limits = []
    if (Number.isFinite(node.maxItems)) limits.push(`max ${node.maxItems}`)
    if (Number.isFinite(node.minItems) && node.minItems > 0) limits.push(`min ${node.minItems}`)
    return limits.length > 0 ? `${base} (${limits.join(', ')})` : base
  }
  const properties = asRecord(node.properties)
  if (declared === 'object' || properties) {
    const inner = properties ? renderParamMap(properties, [], depth + 1) : []
    const extra = asRecord(node.additionalProperties)
    if (extra) inner.push(`[key: string]: ${renderParamType(extra, depth + 1)}`)
    if (inner.length === 0) return 'object'
    return `{${inner.join(', ')}}`
  }
  return declared || 'any'
}

/**
 * 紧凑签名：
 *
 *     read(file_path: string, offset?: number, limit?: number)
 *       file_path: Path to read, resolved by the filesystem backend.
 *
 * 返回 `null` = 这份 parameters 不敢降级，调用方必须回退到原始 JSON。
 */
export function buildToolSignature(tool, withParamDocs = true) {
  try {
    const node = asRecord(tool.parameters)
    if (!node) return `${tool.name}()`
    const wrapped = isWrappedSchema(node)
    const map = wrapped ? asRecord(node.properties) : node
    const args = renderParamMap(
      map,
      wrapped && Array.isArray(node.required) ? node.required.filter((key) => typeof key === 'string') : [],
      1,
    )
    if (args.length === 0) return Object.keys(node).length === 0 ? `${tool.name}()` : null
    const lines = [`${tool.name}(${args.join(', ')})`]
    if (withParamDocs) {
      for (const [name, def] of Object.entries(map)) {
        const description = paramDescription(def)
        if (description) lines.push(`  ${name}: ${truncate(description, MAX_PARAM_DESC_CHARS)}`)
      }
    }
    return lines.join('\n')
  } catch {
    return null
  }
}

/** 取描述的首句（到第一个句末点），再按上限截断。 */
function tailSentence(text) {
  const flat = text.replace(/\s+/g, ' ').trim()
  const stop = flat.search(/\.(\s|$)/)
  return truncate(stop >= 0 ? flat.slice(0, stop + 1) : flat, MAX_TAIL_DESCRIPTION_CHARS)
}

/** 长尾工具的一行形式：`` `name(签名)` — 首句 ``。 */
export function formatTailTool(tool) {
  const sentence = tailSentence(String(tool.description ?? ''))
  const signature = buildToolSignature(tool, false)
  if (signature === null) return `\`${tool.name}\` — ${sentence}`
  return `\`${signature.replace(/\s+/g, ' ').trim()}\` — ${sentence}`
}

/**
 * 渲染工具目录。
 *
 *     ## Available tools   ← 核心工具：一段一个（`### 名字` / 描述 / 签名 / 参数说明）
 *     ## Other tools       ← 长尾工具：**一行一个**
 *
 * 预算用尽时**必须把剩下的工具名说出来**，并明确要求别猜参数。
 */
export function buildToolSection(tools, maxChars = MAX_TOOLS_SECTION_CHARS) {
  if (!tools || tools.length === 0) return ''
  const immediate = tools.filter((tool) => tool?.deferLoading !== true)
  const usable = immediate.length > 0 ? immediate : tools
  const parts = ['', '## Available tools']
  let budget = Math.max(0, Math.min(MAX_TOOLS_SECTION_CHARS, maxChars))
  const coreTools = usable.filter((tool) => isCoreTool(tool?.name))
  const tailTools = usable.filter((tool) => !isCoreTool(tool?.name))

  const omittedNotice = (rest) => {
    const names = rest.map((item) => String(item?.name ?? '')).filter(Boolean)
    return `\n(⚠️ The following ${names.length} tools are NOT described above (omitted for length): ${names.join(', ')}. If you need one of them, ask the user for its exact parameters — do NOT guess them.)`
  }

  for (let index = 0; index < coreTools.length; index += 1) {
    const tool = coreTools[index]
    const signature = buildToolSignature(tool, true)
    let parametersText = signature ?? ''
    if (signature === null) {
      let schemaText = ''
      try {
        schemaText = JSON.stringify(tool.parameters ?? {})
      } catch {
        schemaText = '{}'
      }
      parametersText = `Parameters (JSON Schema): ${schemaText}`
    }
    const block = [
      '',
      `### ${tool.name}`,
      truncate(String(tool.description ?? '').replace(/\s+/g, ' ').trim(), MAX_DESCRIPTION_CHARS),
      parametersText,
    ].join('\n')
    if (budget - block.length < 0) {
      parts.push(omittedNotice([...coreTools.slice(index), ...tailTools]))
      return parts.join('\n')
    }
    budget -= block.length
    parts.push(block)
  }

  if (tailTools.length > 0) {
    const header = [
      '',
      '## Other tools',
      '',
      'Call these the same way. Parameter names and types are in the parentheses.',
    ].join('\n')
    if (budget - header.length < 0) {
      parts.push(omittedNotice(tailTools))
      return parts.join('\n')
    }
    budget -= header.length
    parts.push(header)
    for (let index = 0; index < tailTools.length; index += 1) {
      const line = `- ${formatTailTool(tailTools[index])}`
      if (budget - line.length < 0) {
        parts.push(omittedNotice(tailTools.slice(index)))
        break
      }
      budget -= line.length
      parts.push(line)
    }
  }

  return parts.join('\n')
}

// ── 历史里的调用回放（照搬）───────────────────────────────────────────

/**
 * 把一条 assistant 消息里的 tool-call 块渲染回协议 JSON（供模型学习格式）。
 *
 * ⚠️ `arguments` 渲染成**嵌套对象**（不是字符串）—— 这点必须与协议示例一致，
 * 否则模型学到的是错形状。
 */
export function renderToolCalls(blocks) {
  const calls = (blocks ?? []).filter((block) => block?.type === 'tool-call')
  if (calls.length === 0) return null
  const payload = {
    tool_calls: calls.map((call) => {
      let args = {}
      try {
        const raw = call.arguments
        args = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {}
      } catch {
        args = { _raw: String(call.arguments ?? '') }
      }
      return {
        name: String(call.name ?? ''),
        arguments: args,
      }
    }),
  }
  return JSON.stringify(payload)
}
