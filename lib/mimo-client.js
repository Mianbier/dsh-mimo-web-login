/**
 * MiMo AI Studio 网页端私有接口客户端。
 *
 * 契约来源：直接反编译线上 SPA bundle（main.*.chunk.js）逐字核对，不是抄第三方 README。
 * 关键结论（都有证据）：
 *   - 端点 POST /open-apis/react/chat?xiaomichatbot_ph=<ph>，纯 SSE；
 *   - 鉴权只有 3 个 Cookie：serviceToken / userId / xiaomichatbot_ph；
 *   - 没有 PoW、没有请求签名、没有 nonce、没有验证码；
 *   - 思考内容是 SSE 里的 reasoningContent 字段，不是 <think> 标签；
 *   - 未登录一律 401 + loginUrl，且鉴权在路由之前（乱写路径也 401）。
 *
 * @module lib/mimo-client
 */

/** 站点根（生产环境没有 /fastchat 前缀 —— bundle 里 `v = isProduction ? '' : '/fastchat'`）。 */
export const ORIGIN = 'https://aistudio.xiaomimimo.com'

const CHAT_PATH = '/open-apis/react/chat'
const CONFIG_PATH = '/open-apis/bot/config'
const CONVERSATION_SAVE = '/open-apis/chat/conversation/save'
const CONVERSATION_DELETE = '/open-apis/chat/conversation/delete'
const UPLOAD_INFO = '/open-apis/resource/genUploadInfo'
const RESOURCE_PARSE = '/open-apis/resource/parse'
const USER_INFO = '/open-apis/user/mi/get'

/**
 * UltraSpeed 的独立部署。
 *
 * ⚠️ 这段是**用 CDP 抓真实请求核对过的**，别照 SPA 里的字面量猜：
 *   实际请求：`POST /fastchat/open-apis/bot/chat?xiaomichatbot_ph=<ph>`
 *   实际 cookie：`xiaomichatbot_serviceToken` / `userId` / `xiaomichatbot_ph`
 *
 * 反直觉的两点：
 *   ① 路径要加 `/fastchat` 前缀，端点是 v2 的 `bot/chat`
 *      （`/fastchat/open-apis/react/chat` 是 404）。
 *   ② **查询参数和 cookie 名仍是 `xiaomichatbot_ph`** —— SPA 源码里那个
 *      `{ultra: "ultraspeed_ph"}` 只是内部配置字符串，浏览器里根本没有
 *      `ultraspeed_ph` 这个 cookie。照字面量去用必然 401。
 */
const FASTCHAT_PREFIX = '/fastchat'
const FASTCHAT_CHAT_PATH = `${FASTCHAT_PREFIX}/open-apis/bot/chat`

/** 这个模型是不是必须走 fastchat（UltraSpeed）。 */
export function isFastchatModel(model) {
  return /ultraspeed/i.test(String(model ?? ''))
}

/** 浏览器会带上的头。UA 刻意不用 Node 默认值 —— 站点按 UA 判"是不是浏览器"。 */
const BASE_HEADERS = {
  accept: '*/*',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  origin: ORIGIN,
  referer: ORIGIN + '/',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
  'x-timezone': 'Asia/Shanghai',
}

/** 32 位十六进制 id —— 与 SPA 生成的 conversationId / msgId 同形。 */
export function randomId() {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 本插件的错误类型。
 *
 * `code` 是给 DSH 重试策略路由用的稳定分类，不要靠 message 文本判断：
 * AUTH / RATE_LIMIT / QUOTA / TIMEOUT / TRANSPORT / MALFORMED_RESPONSE /
 * CONTEXT_WINDOW_EXCEEDED / ABORTED / PROVIDER_ERROR
 */
export class MimoError extends Error {
  constructor(message, code, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MimoError'
    this.code = code
    if (options.status !== undefined) this.status = options.status
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
  }
}

/** 把 HTTP 状态映射成错误码。 */
function codeForStatus(status) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 451 || status === 461) return 'AUTH'
  if (status === 404) return 'PROVIDER_ERROR'
  if (status >= 500) return 'SERVER'
  return 'PROVIDER_ERROR'
}

/**
 * 把上游那句极具误导性的错误文案翻译成人话。
 *
 * @param {string} message
 * @returns {{ code: string, text: string }|undefined}
 */
function classifyUpstreamMessage(message) {
  const text = String(message ?? '')
  // 「没有权限操作」是**限流**的伪装，不是真的没权限 ——
  // 实测：连发十几个请求后必出现；静置一会儿、加大间隔就自己好了。
  // 如果照字面理解成"密钥无效/登录失效"，用户会去反复重登（完全没用）。
  if (/没有权限操作/.test(text)) {
    return {
      code: 'RATE_LIMIT',
      text: 'MiMo 网页端把这轮请求判为「操作过于频繁」（上游原文：没有权限操作）。这不是登录失效，请等 10~30 秒再发，或把「参数 → 请求最小间隔」调大。',
    }
  }
  if (/请求量超限|服务器繁忙|请稍后再试/.test(text)) {
    return {
      code: 'RATE_LIMIT',
      text: `MiMo 网页端限流（上游原文：${text.slice(0, 40)}），稍后自动重试。`,
    }
  }
  return undefined
}

/** 从 401 响应体里取 loginUrl，用来告诉用户"去哪重新登录"。 */
function loginUrlOf(body) {
  try {
    const parsed = JSON.parse(body)
    return typeof parsed?.loginUrl === 'string' ? parsed.loginUrl : ''
  } catch {
    return ''
  }
}

/**
 * 一个 MiMo 账号的请求上下文。
 *
 * Cookie 里三个字段缺一不可；少任何一个服务端都会清掉 Cookie 并回 401
 * （实测：只带 serviceToken + userId 仍然 401）。
 */
export class MimoClient {
  constructor(auth, options = {}) {
    this.auth = auth
    this.signal = options.signal
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args))
    this.idleTimeoutMs = options.idleTimeoutMs ?? 180_000
  }

  /**
   * 组装 Cookie 头。
   *
   * fastchat（UltraSpeed）用的 cookie 名**和普通模型完全一样** ——
   * 实测抓包确认，浏览器里只有那三个 cookie，没有 `ultraspeed_ph`。
   * 所以这里不需要按路径分叉，留着参数只是为了调用点读起来清楚。
   *
   * @param {{fastchat?: boolean}} [options]
   * @returns {string}
   */
  cookieHeader({ fastchat = false } = {}) {
    void fastchat
    const parts = []
    // ⚠️ 站点真实 cookie 名是 xiaomichatbot_serviceToken（带前缀），不是 serviceToken。
    // 发错名字服务端就当没登录，直接 401。
    // 另外值里不能带外层引号：老数据可能残留 `"/vjQ…="`，那样拼进 followup 必然 401。
    const clean = (value) => String(value ?? '').trim().replace(/^"+/, '').replace(/"+$/, '')
    const token = clean(this.auth.serviceToken)
    const ph = clean(this.auth.xiaomichatbotPh)
    if (token) parts.push(`xiaomichatbot_serviceToken=${token}`)
    if (this.auth.userId) parts.push(`userId=${clean(this.auth.userId)}`)
    if (ph) parts.push(`xiaomichatbot_ph=${ph}`)
    return parts.join('; ')
  }

  /**
   * 带 ph 查询参数的地址（服务端两处都要）。
   *
   * @param {string} path
   * @param {object} [extraParams]
   * @param {{fastchat?: boolean}} [options]
   * @returns {string}
   */
  url(path, extraParams, { fastchat = false } = {}) {
    void fastchat
    const u = new URL(path, ORIGIN)
    // ph 是拼进 URL 的，带着引号会变成 %22…%22，服务端校验直接不过。
    const ph = String(this.auth.xiaomichatbotPh ?? '').trim().replace(/^"+/, '').replace(/"+$/, '')
    if (ph) u.searchParams.set('xiaomichatbot_ph', ph)
    for (const [k, v] of Object.entries(extraParams ?? {})) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
    }
    return u.toString()
  }

  headers(extra = {}, { fastchat = false } = {}) {
    return { ...BASE_HEADERS, cookie: this.cookieHeader({ fastchat }), ...extra }
  }

  /** 发一个普通 JSON 请求，非 2xx 抛 MimoError。 */
  async json(path, { method = 'POST', body, params, timeoutMs = 30_000 } = {}) {
    const signal = this.signal
      ? AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs)
    let response
    try {
      response = await this.fetchImpl(this.url(path, params), {
        method,
        headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      })
    } catch (error) {
      if (this.signal?.aborted) throw new MimoError('MiMo 请求已被取消', 'ABORTED', { cause: error })
      if (error?.name === 'TimeoutError') throw new MimoError('MiMo 请求超时', 'TIMEOUT', { cause: error })
      throw new MimoError(`MiMo 请求失败：${error?.message ?? error}`, 'TRANSPORT', { cause: error })
    }
    const text = await response.text()
    if (!response.ok) {
      const loginUrl = loginUrlOf(text)
      throw new MimoError(
        response.status === 401
          ? 'MiMo 登录态已失效（服务端返回 401）—— 请在「设置 → MiMo 网页登录」重新用浏览器窗口登录' +
            (loginUrl ? `。登录地址：${loginUrl}` : '')
          : `MiMo 接口返回 HTTP ${response.status}：${text.slice(0, 200)}`,
        codeForStatus(response.status),
        { status: response.status },
      )
    }
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new MimoError(`MiMo 返回了非 JSON 响应：${text.slice(0, 200)}`, 'MALFORMED_RESPONSE', { cause: error })
    }
  }

  /**
   * 读模型目录。
   *
   * ⚠️ 这个接口**不需要登录**（实测 200），所以它既能用来发现模型，
   * 也能在登录态失效时依然给出模型列表（但发消息还是会 401）。
   */
  async fetchModelConfig(timeoutMs = 20_000) {
    const payload = await this.json(CONFIG_PATH, { method: 'GET', timeoutMs })
    if (payload?.code !== 0 || !payload?.data) {
      throw new MimoError(`MiMo 模型目录返回异常：${JSON.stringify(payload).slice(0, 200)}`, 'MALFORMED_RESPONSE')
    }
    return payload.data
  }

  /** 只读探活：确认 serviceToken 还有效（零额度）。 */
  async whoami(timeoutMs = 20_000) {
    try {
      const payload = await this.json(USER_INFO, { method: 'GET', timeoutMs })
      return { ok: true, data: payload?.data ?? payload }
    } catch (error) {
      return { ok: false, error: error instanceof MimoError ? error : new MimoError(String(error), 'TRANSPORT') }
    }
  }

  /**
   * 建会话记录。
   *
   * SPA 每次新对话都会先 save 一条（`{conversationId,title:'新对话',type:'chat'}`），
   * 失败最多重试 3 次。
   *
   * ⚠️ 实测结论（很重要）：只发 `react/chat` 不打这个接口的话，消息**能正常对话**，
   * 但 `chat/conversation/list`（网页端左侧历史栏的数据源）里**不会出现**这条会话 ——
   * 用户在官网完全看不到插件发过的内容。所以想要"官网可见"，必须打这一枪。
   *
   * 另外 `title` 是**必填**：空串会返回 `400 {"msg":"title: must not be empty"}`。
   *
   * @param {{conversationId: string, title?: string, timeoutMs?: number}} params
   * @returns {Promise<boolean>} 成功与否（失败不该影响本轮对话）
   */
  async saveConversation({ conversationId, title, timeoutMs = 15_000 }) {
    const safeTitle = String(title ?? '').trim() || '新对话'
    try {
      await this.json(CONVERSATION_SAVE, {
        body: { conversationId, title: safeTitle, type: 'chat' },
        timeoutMs,
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * 删除会话记录。
   *
   * @param {string} conversationId
   * @param {number} [timeoutMs]
   * @returns {Promise<boolean>}
   */
  async deleteConversation(conversationId, timeoutMs = 15_000) {
    try {
      await this.json(CONVERSATION_DELETE, { body: [conversationId], timeoutMs })
      return true
    } catch {
      return false
    }
  }

  /**
   * 三步上传：genUploadInfo → PUT → resource/parse。
   *
   * 返回可直接放进 `multiMedias[]` 的条目；失败抛错（由调用方决定降级成文本标记）。
   */
  async uploadMedia({ data, mediaType, name, model, timeoutMs = 120_000 }) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const digest = await md5Hex(bytes)
    const info = await this.json(UPLOAD_INFO, {
      body: { fileName: name, fileContentMd5: digest },
      timeoutMs,
    })
    const uploadUrl = info?.data?.uploadUrl
    const resourceUrl = info?.data?.resourceUrl
    const objectName = info?.data?.objectName
    if (info?.code !== 0 || !uploadUrl || !resourceUrl) {
      throw new MimoError(`MiMo 上传预签名失败：${JSON.stringify(info).slice(0, 200)}`, 'PROVIDER_ERROR')
    }

    const putSignal = this.signal
      ? AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs)
    const put = await this.fetchImpl(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', 'content-md5': digest },
      body: bytes,
      signal: putSignal,
    })
    if (!put.ok) {
      throw new MimoError(`MiMo 对象上传失败（HTTP ${put.status}）`, codeForStatus(put.status), { status: put.status })
    }

    // parse 是异步的：刚上传完可能还没解析完，重试几次。
    let parsed
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const result = await this.json(RESOURCE_PARSE, {
          body: {},
          params: { fileUrl: resourceUrl, objectName, model },
          timeoutMs,
        })
        if (result?.code === 0 && result?.data?.id) {
          parsed = result
          break
        }
      } catch (error) {
        if (error?.code === 'AUTH') throw error
      }
      await sleep(1500)
    }
    if (!parsed) throw new MimoError('MiMo 资源解析超时（resource/parse 连续失败）', 'PROVIDER_ERROR')

    return {
      mediaType,
      fileUrl: resourceUrl,
      compressedVideoUrl: '',
      audioTrackUrl: '',
      name,
      size: bytes.byteLength,
      status: 'completed',
      objectName,
      tokenUsage: parsed.data?.tokenUsage ?? 0,
      url: parsed.data.id,
    }
  }

  /**
   * 发起一次流式对话，逐个 yield 规范化后的事件。
   *
   * 产出的事件（内部词表，与 MimoClient 之外无关）：
   *   {kind:'dialog', id}         服务端分配的对话行 id（本轮用不到，留给续接）
   *   {kind:'reasoning', text}    思考增量（SSE 的 reasoningContent 字段）
   *   {kind:'text', text}         正文增量
   *   {kind:'usage', usage}       token 用量
   *   {kind:'tip', ratio|truncate|quota}  服务端的提示信号
   *   {kind:'error', message}     上游报错
   *   {kind:'finish'}             正常结束
   */
  async *chat(body) {
    const timeoutMs = this.idleTimeoutMs
    const controller = new AbortController()
    const abort = () => controller.abort()
    this.signal?.addEventListener('abort', abort, { once: true })

    // UltraSpeed 走另一套部署：`/fastchat/open-apis/bot/chat`（v2），
    // 带上它自己的 `ultraspeed_ph`。普通模型仍走 `react/chat`（v3）。
    const fastchat = isFastchatModel(body?.modelConfig?.model)
    const path = fastchat ? FASTCHAT_CHAT_PATH : CHAT_PATH

    let response
    try {
      response = await this.fetchImpl(this.url(path, undefined, { fastchat }), {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json', accept: 'text/event-stream' }, { fastchat }),
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      this.signal?.removeEventListener?.('abort', abort)
      if (this.signal?.aborted) throw new MimoError('MiMo 请求已被取消', 'ABORTED', { cause: error })
      throw new MimoError(`MiMo 对话请求失败：${error?.message ?? error}`, 'TRANSPORT', { cause: error })
    }

    try {
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        if (response.status === 429) {
          const retryAfter = Number(response.headers.get('retry-after')) * 1000
          throw new MimoError(
            'MiMo 网页端限流：同一账号同时只能生成一条消息，稍后自动重试',
            'RATE_LIMIT',
            { status: 429, retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined },
          )
        }
        const loginUrl = loginUrlOf(text)
        throw new MimoError(
          response.status === 401
            ? 'MiMo 登录态已失效（401）—— 请在「设置 → MiMo 网页登录」重新登录' + (loginUrl ? `：${loginUrl}` : '')
            : `MiMo 对话接口 HTTP ${response.status}：${text.slice(0, 200)}`,
          codeForStatus(response.status),
          { status: response.status },
        )
      }
      if (!response.body) throw new MimoError('MiMo 对话接口没有返回流', 'EMPTY_RESPONSE')

      for await (const event of parseSse(response.body, controller, timeoutMs)) {
        yield event
      }
    } finally {
      this.signal?.removeEventListener?.('abort', abort)
      try {
        controller.abort()
      } catch {
        /* 已经结束了 */
      }
    }
  }
}

/**
 * 解析 SSE 流。
 *
 * 三种结束方式都要认（缺一个就会挂死或误判截断）：
 *   ① `event: finish` —— SPA 走这条；
 *   ② `data: [DONE]` —— OpenAI 风格的哨兵；
 *   ③ 流自然 EOF。
 *
 * 另有一个空闲看门狗：浏览器/服务端都可能在半路静默，靠 `read()` 返回值判断不了。
 */
async function* parseSse(stream, controller, idleTimeoutMs) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = 'message'
  let finished = false
  let idleTimer
  const bumpIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      try {
        controller.abort(new MimoError('MiMo 流式响应空闲超时', 'TIMEOUT'))
      } catch {
        /* 已结束 */
      }
    }, idleTimeoutMs)
  }

  try {
    bumpIdle()
    for (;;) {
      let chunk
      try {
        chunk = await reader.read()
      } catch (error) {
        if (controller.signal.aborted) {
          const reason = controller.signal.reason
          if (reason instanceof MimoError) throw reason
          throw new MimoError('MiMo 流式响应被中断', 'ABORTED', { cause: error })
        }
        throw new MimoError(`MiMo 流式读取失败：${error?.message ?? error}`, 'TRANSPORT', { cause: error })
      }
      if (chunk.done) break
      bumpIdle()
      buffer += decoder.decode(chunk.value, { stream: true })

      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        const line = rawLine.replace(/\r$/, '')

        if (line === '') {
          eventName = 'message'
          continue
        }
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim()
          continue
        }
        if (!line.startsWith('data:')) continue

        const raw = line.slice(5).trim()
        if (!raw) continue
        if (raw === '[DONE]') {
          finished = true
          break
        }

        let payload
        try {
          payload = JSON.parse(raw)
        } catch {
          // 非 JSON 的 data 只可能是纯文本正文，按正文处理。
          if (raw) yield { kind: 'text', text: raw }
          continue
        }

        for (const event of normalizeEvent(eventName, payload)) {
          yield event
          if (event.kind === 'finish') finished = true
        }
        if (finished) break
      }
      if (finished) break
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    try {
      await reader.cancel()
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * 把一条 SSE 事件翻译成内部事件。
 *
 * 事件名白名单来自 SPA 的 `new Set(["dialogId","message","usage","finish","error",
 * "sensitive_query","sensitive_title","tip_ratio","tip_truncate","quota_alert"])`
 * —— 名单外的事件 SPA 直接丢弃，我们跟着丢。
 */
const KNOWN_EVENTS = new Set([
  'dialogId',
  'message',
  'usage',
  'finish',
  'error',
  'sensitive_query',
  'sensitive_title',
  'tip_ratio',
  'tip_truncate',
  'quota_alert',
])

function normalizeEvent(eventName, payload) {
  const events = []
  const isObject = payload !== null && typeof payload === 'object'
  // data 既可能是 {"content":"…"} 也可能是裸标量（`data: 991`）。两种都要认：
  // 后者在 dialogId 上真的出现过，按对象处理会把 id 当成正文喷出去。
  const content = isObject
    ? typeof payload.content === 'string'
      ? payload.content
      : ''
    : payload === null || payload === undefined
      ? ''
      : String(payload)
  if (!isObject) payload = {}
  const messageType = typeof payload.messageType === 'string' ? payload.messageType : ''
  // ⚠️ `messageType` 是**消息角色**（"assistant"/"user"），不是事件名。
  // 早先写成 `const name = messageType || eventName`，于是 `event:message` 的帧
  // 变成 `name = 'assistant'`，白名单判定把它丢掉 —— 结果正文和思考全被吞，
  // 上层只能看到 usage/finish，报"空响应"。这是本轮最隐蔽的一个 bug。
  // 只有当 messageType 真的是一个已知的**控制类事件名**时，才允许它覆盖事件名。
  const name = messageType && KNOWN_EVENTS.has(messageType) && messageType !== 'message' ? messageType : eventName

  // 名单外的事件丢——但 `message` 与裸标量例外（裸标量没有事件名，只能是正文）。
  if (!KNOWN_EVENTS.has(name) && name !== 'message') {
    return events
  }

  if (name === 'dialogId') {
    events.push({ kind: 'dialog', id: Number(content) || 0 })
    return events
  }
  if (name === 'finish') {
    events.push({ kind: 'finish' })
    return events
  }
  if (name === 'usage') {
    events.push({ kind: 'usage', usage: normalizeUsage(payload) })
    return events
  }
  if (name === 'error') {
    const raw = content || 'MiMo 上游返回错误'
    const classified = classifyUpstreamMessage(raw)
    if (classified) {
      events.push({ kind: 'error', message: classified.text, code: classified.code, upstream: raw })
      return events
    }
    events.push({ kind: 'error', message: raw })
    return events
  }
  if (name === 'sensitive_query' || name === 'sensitive_title') {
    // 上游的内容风控挡了这条消息。这不是"插件坏了"，重试也没用，
    // 所以给一个**能照做**的说法：换措辞、去掉敏感片段、或换个话题。
    events.push({
      kind: 'error',
      message:
        'MiMo 网页端的内容风控拦了这条消息（不是插件故障，重试也不会变）。' +
        '可以试试：换一种说法、去掉可能有争议的片段，或者先把问题拆小再问。',
      code: 'SENSITIVE',
      sensitive: true,
    })
    return events
  }
  if (name === 'quota_alert') {
    events.push({ kind: 'tip', quota: true })
    events.push({ kind: 'error', message: 'MiMo 账号额度已用尽', code: 'QUOTA' })
    return events
  }
  if (name === 'tip_ratio') {
    events.push({ kind: 'tip', ratio: Number.parseFloat(content) || 0 })
    return events
  }
  if (name === 'tip_truncate') {
    events.push({ kind: 'tip', truncate: true })
    return events
  }

  // 原生工具（webSearch / getTime / …）与 toolCalls / responses：本插件不用上游工具，
  // 但 toolCalls 万一出现也要能让上层知道。
  if (Array.isArray(payload.toolCalls) && payload.toolCalls.length > 0) {
    events.push({ kind: 'native-tool-calls', calls: payload.toolCalls })
    return events
  }

  if (typeof payload.reasoningContent === 'string' && payload.reasoningContent) {
    events.push({ kind: 'reasoning', text: payload.reasoningContent })
  }
  if (content) events.push({ kind: 'text', text: content })
  return events
}

function normalizeUsage(payload) {
  const prompt = Number(payload.promptTokens) || 0
  const completion = Number(payload.completionTokens) || 0
  const total = Number(payload.totalTokens) || prompt + completion
  const native = payload.nativeUsage ?? {}
  const reasoning = Number(native?.completion_tokens_details?.reasoning_tokens) || 0
  return { prompt, completion, total, reasoning }
}

/** 计算 MD5（上传要 `fileContentMd5`；Node 与浏览器都要能用）。 */
async function md5Hex(bytes) {
  const subtle = globalThis.crypto?.subtle
  // WebCrypto 没有 MD5，只能用 Node 的 crypto 模块。
  const { createHash } = await import('node:crypto')
  return createHash('md5').update(bytes).digest('hex')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export { CONVERSATION_SAVE, USER_INFO }
