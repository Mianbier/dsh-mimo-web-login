/**
 * `mimo-web` provider 适配器。
 *
 * 鸭子类型满足 dsh-llm 的 LlmAdapter 契约（不继承基类 —— 那个基类在宿主包里，
 * 插件不该依赖它的可解析性）。必须实现的方法一个都不能少：
 *   providerInfo / providerRetryPolicy / imageRequestPricing /
 *   listModels / resolveModel / prepareCall / stream
 *
 * 其中 `imageRequestPricing` 看着像装饰，实际是**必需的**：dsh-llm 在计量与压缩
 * 路径上无条件转调它，缺了就抛 `is not a function`，压缩会静默失效。
 *
 * @module lib/adapter
 */

import { MimoClient, MimoError, randomId, isFastchatModel } from './mimo-client.js'
import { buildToolSection, buildToolSignature, createStreamFilter, extractToolCalls, renderToolCalls, toolProtocolInstructions } from './tool-protocol.js'

export const PROVIDER = 'mimo-web'
export const PROVIDER_DISPLAY_NAME = '小米 MiMo 网页版'
/**
 * 模型表兜底。
 *
 * 正常情况下从 `GET /open-apis/bot/config` 实时拉（那个接口免登录），
 * 但拉不到时必须有东西可选 —— 空目录会让模型选择器里一片空白，
 * 用户会以为插件坏了。
 */
const FALLBACK_MODELS = [
  { id: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro', description: '旗舰，1T 参数，适合工具调用与复杂任务' },
  { id: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash', description: '高性价比日常模型，速度快' },
]

/** 上游把旧模型名重定向到新名字；这些别名不进候选列表（选它等于选新模型）。 */
function isRedirectAlias(model) {
  return typeof model?.redirectTo === 'string' && model.redirectTo.length > 0
}

/**
 * UltraSpeed 是不是独立部署的模型。
 *
 * ⚠️ 实测：`mimo-v2.6-pro-ultraspeed-studio` 虽然在 `bot/config` 里列出来，
 * 但用普通网页端凭据调用必然回 `event:error {"content":"模型名称错误"}`。
 * 原因藏在 SPA 里：ultra 是独立部署，cookie 名是 `ultraspeed_ph`
 * （见 `{production:"xiaomichatbot_ph", ultra:"ultraspeed_ph"}`），
 * 而且走 `/fastchat` 前缀。普通账号拿不到那份凭据，所以这个模型对我们始终不可用。
 *
 * 列出来只会让用户选中后必然失败 —— 所以过滤掉。
 *
 * @param {unknown} modelId
 * @returns {boolean}
 */
function isUltraSpeedOnly(modelId) {
  return /ultraspeed|ultra-speed|studio\b/i.test(String(modelId ?? '')) && /ultraspeed/i.test(String(modelId ?? ''))
}

/**
 * 过滤掉"目录里有、但本插件拿普通网页凭据用不了"的模型。
 *
 * @param {string} modelId
 * @returns {boolean} true = 可用
 */
function isUsableModelId(modelId) {
  return !isUltraSpeedOnly(modelId)
}

/**
 * 把 `nToken`（原始数值）变成给人看的上下文窗口标注。
 *
 * @param {unknown} nToken
 * @returns {string|undefined}
 */
function formatContextTokens(nToken) {
  const value = Number(nToken)
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

/**
 * 从宿主传下来的 `options.model` 里取出**候选 id 字符串**。
 *
 * 宿主在不同路径上可能给字符串、`{ id, name }` 对象、或者别的结构。
 *
 * @param {unknown} model
 * @returns {string}
 */
function normalizeModelId(model) {
  if (typeof model === 'string') return model.trim()
  if (model && typeof model === 'object') {
    for (const key of ['id', 'model', 'name']) {
      const value = model[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
  }
  return ''
}

/**
 * 把候选模型名映射成**上游认识的真实模型 id**。
 *
 * ⚠️ 上游只认 `mimo-v2.6-pro` 这种 id。传显示名 `MiMo-V2.6-Pro` 会直接回
 * `event:error data:{"content":"模型名称错误"}` —— 实测过的真实事故。
 * 所以这里按目录做一次模糊匹配（id → name → 大小写/分隔符归一），
 * 再兜底到目录里的第一个模型，绝不把上游不认识的字符串发出去。
 *
 * @param {object} deps
 * @param {string} requested
 * @returns {Promise<string>}
 */
async function resolveUpstreamModelId(deps, requested) {
  const catalog = await loadCatalogForMapping(deps)
  if (catalog.length === 0) return requested

  const norm = (value) => String(value ?? '').toLowerCase().replace(/[\s_\-.]/g, '')
  const want = norm(requested)

  // ① 精确 id
  const byId = catalog.find((item) => item.id === requested)
  if (byId) return byId.id
  // ② 精确 name
  const byName = catalog.find((item) => item.name === requested)
  if (byName) return byName.id
  // ③ 归一化后比 id 或 name（吃掉大小写/空格/横线差异）
  if (want) {
    const byLoose = catalog.find((item) => norm(item.id) === want || norm(item.name) === want)
    if (byLoose) return byLoose.id
  }
  // ④ 都认不出来 —— 用目录第一个，总比发一个必然报错的字符串强
  deps.logger?.warn?.(`mimo-web: 不认识的模型名 ${JSON.stringify(requested)}，回落到 ${catalog[0].id}`)
  return catalog[0].id
}

/**
 * 给 `resolveUpstreamModelId` 用的一份目录（带进程内缓存，避免每轮都打接口）。
 *
 * ⚠️ 缓存按 `fetchImpl` 分桶：同一个进程里可能有多份 adapter（测试、多账号），
 * 共用一份缓存会让 A 的目录污染 B 的映射 —— 曾经因此把 UltraSpeed 映射成普通模型。
 */
const mappingCaches = new WeakMap()
function mappingCacheFor(deps) {
  const key = deps.fetchImpl ?? null
  if (key === null) {
    // 没有自定义 fetchImpl 时用全局桶
    if (!mappingCaches.global) mappingCaches.global = { at: 0, models: [] }
    return mappingCaches.global
  }
  if (!mappingCaches.has(key)) mappingCaches.set(key, { at: 0, models: [] })
  return mappingCaches.get(key)
}

async function loadCatalogForMapping(deps) {
  const cache = mappingCacheFor(deps)
  const ttl = 10 * 60 * 1000
  if (cache.models.length > 0 && Date.now() - cache.at < ttl) return cache.models
  try {
    // 目录接口不需要鉴权 —— 这里刻意不依赖 auth。
    const client = new MimoClient(deps.getAuth() ?? {}, { fetchImpl: deps.fetchImpl })
    const data = await client.fetchModelConfig()
    const list = Array.isArray(data?.modelConfigList) ? data.modelConfigList : []
    const models = list
      .filter((item) => item?.model && !isRedirectAlias(item))
      .map((item) => ({ id: String(item.model), name: String(item.name ?? item.model) }))
    if (models.length > 0) {
      cache.at = Date.now()
      cache.models = models
    }
    return models
  } catch (error) {
    deps.logger?.warn?.(`mimo-web: 模型名映射拉目录失败：${error?.message ?? error}`)
    return cache.models
  }
}

/**
 * 重试策略。
 *
 * ⚠️ 形状必须**扁平**，不能包一层 `backoff`：dsh-llm 的取法是
 * `adapter.providerRetryPolicy(provider) ?? resolveRetryPolicy(...)` —— 我们一返回对象，
 * 右边那步规范化就不会执行，而运行期消费方读的是扁平字段。写成嵌套会让
 * `maxDelayMs` 变成 undefined，于是"要不要放弃重试"这条判断彻底失效，
 * 并且在没带 provider 延迟时算出 `delayMs: NaN`，把整轮会话事件写坏。
 */
const RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 4,
  retryableCodes: Object.freeze(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE']),
  initialDelayMs: 1500,
  maxDelayMs: 120_000,
  jitterRatio: 0.2,
})

const REASONING_EFFORTS = Object.freeze([
  { id: 'off', name: '快速（不思考）', description: '直接作答，最快、最省额度' },
  { id: 'on', name: '深度思考', description: '先推理再作答，推理过程作为思考块回显' },
])

/**
 * 构造适配器。
 *
 * @param {object} deps
 * @param {() => {serviceToken:string,userId:string,xiaomichatbotPh:string}|undefined} deps.getAuth
 * @param {() => object} deps.getSettings
 * @param {(ref: any, signal?: AbortSignal) => Promise<{data: Uint8Array, mediaType?: string, name?: string}>} [deps.readImage]
 * @param {{info?:Function, warn?:Function, debug?:Function}} [deps.logger]
 */
export function createAdapter(deps) {
  const logger = deps.logger ?? {}
  let catalogCache = { at: 0, models: [] }

  /** 拉模型目录（带内存缓存；失败退回兜底表）。 */
  async function loadCatalog(force = false) {
    const ttl = 10 * 60 * 1000
    if (!force && catalogCache.models.length > 0 && Date.now() - catalogCache.at < ttl) return catalogCache.models
    // ⚠️ `/open-apis/bot/config` **不需要鉴权** —— 没登录也该把真实模型表拉回来，
    // 否则模型选择器里只剩兜底的 2 个，用户会觉得"明明有 15 个却只给我两个"。
    const auth = deps.getAuth()
    try {
      const client = new MimoClient(auth ?? {}, { fetchImpl: deps.fetchImpl })
      const data = await client.fetchModelConfig()
      const list = Array.isArray(data?.modelConfigList) ? data.modelConfigList : []
      const seen = new Set()
      const models = []
      for (const item of list) {
        const id = String(item?.model ?? '').trim()
        if (!id || seen.has(id) || isRedirectAlias(item)) continue
        seen.add(id)
        models.push({
          id,
          name: String(item?.name ?? id),
          description: String(item?.cnIntro ?? item?.enIntro ?? ''),
          thinkingDefaultOn: item?.thinkingDefaultOn !== false,
          contextTokens: formatContextTokens(item?.nToken),
        })
      }
      if (models.length > 0) {
        catalogCache = { at: Date.now(), models }
        return models
      }
    } catch (error) {
      logger.warn?.(`mimo-web: 拉取模型目录失败（用兜底表）：${error?.message ?? error}`)
    }
    return catalogCache.models.length > 0 ? catalogCache.models : FALLBACK_MODELS
  }

  function modelSpec(models, id) {
    return models.find((item) => item.id === id)
  }

  function visibleModels(models) {
    const settings = deps.getSettings()
    const enabled = Array.isArray(settings.enabledModels) ? settings.enabledModels.filter(Boolean) : []
    if (enabled.length === 0) return models
    const filtered = models.filter((item) => enabled.includes(item.id))
    return filtered.length > 0 ? filtered : models
  }

  function modelInfo(provider, spec) {
    return {
      provider,
      id: spec.id,
      name: spec.name,
      ...spec.description ? { description: spec.description } : {},
      inputModalities: ['text', 'image'],
    }
  }

  const adapter = {
    providerInfo(provider) {
      return { id: provider, name: PROVIDER_DISPLAY_NAME }
    },

    providerRetryPolicy() {
      return RETRY_POLICY
    },

    /** 本路由不声明图片计价 —— 返回 undefined 让消费者回落到自己的中性估算。必须同步、无 I/O。 */
    imageRequestPricing() {
      return undefined
    },

    async listModels(provider) {
      const models = await currentModels()
      return models.map((spec) => modelInfo(provider, spec))
    },

    async resolveModel(provider, model) {
      // 网页端是纯文本投喂：中途变化的系统提示/工具集只能靠"重发全量"体现，
      // 所以不声明 systemPromptUpdate / toolUpdate，让 harness 走自己的默认策略。
      return await resolveModelInfo(provider, model)
    },

    async prepareCall(provider, model, signal) {
      // ⚠️ 不能用 `this.resolveModel` —— 宿主可能把方法摘下来单独调用
      // （dsh-llm 的 prepareCall 就是把 adapter 上的方法取出来跑的），
      // 那时 this 不再是适配器对象，this.resolveModel 会 undefined。
      const resolved = await resolveModelInfo(provider, model)
      // ⚠️ `model` 这里是宿主选的模型 id，是本插件**最可信的模型来源**。
      // 早先只把它用于 resolveModelInfo，真正发请求时却去读 `options.model`，
      // 而 `options.model` 在 stream 阶段可能是显示名/别名，于是上游回
      // "模型名称错误"。现在把 model 作为 hint 一路传下去。
      return {
        model: resolved,
        stream: (options) => runStream({ ...options, modelHint: model }, deps),
      }
    },

    stream(options) {
      // 有些宿主直接调 stream()（不走 prepareCall），这时没有 modelHint，
      // 只能靠 options.model —— 归一逻辑会兜住显示名/别名。
      return runStream(options, deps)
    },
  }

  /** listModels / resolveModel 共用的一份"当前模型目录"。 */
  async function currentModels() {
    return visibleModels(await loadCatalog())
  }

  async function resolveModelInfo(provider, model) {
    const models = await currentModels()
    const spec = modelSpec(models, model) ?? { id: model, name: model, description: '' }
    const settings = deps.getSettings()
    return {
      ...modelInfo(provider, spec),
      context: { contextWindow: settings.contextWindow },
      reasoning: {
        efforts: REASONING_EFFORTS,
        defaultEffort: settings.thinking ? 'on' : 'off',
      },
    }
  }

  return adapter
}

// ── 请求节流 ────────────────────────────────────────────────────────────

/** 最近一次请求的时间戳（进程级）。账号维度共用一份：网页端限流就是按账号算的。 */
let lastRequestAt = 0
/** 串行闸门：同一时刻只允许一个请求在飞（网页端通常只允许 1 条生成）。 */
let inflight = Promise.resolve()

/**
 * 等到"距离上一次请求至少 minIntervalMs"再放行。
 *
 * 两点说明：
 *  - 加抖动（0~400ms）：固定间隔在服务端看来很像脚本。
 *  - **并发模式下只做"发起节流"，不排队等前一个结束** —— 实测 MiMo 接受同账号
 *    并发，串行排队会让"两个窗口同时发消息"看起来像坏了。
 *
 * @param {object} deps
 * @param {object} settings
 */
async function throttle(deps, settings) {
  const minIntervalMs = Math.max(0, Number(settings.minIntervalMs) || 0)
  const allowConcurrent = settings.allowConcurrent !== false

  const wait = async () => {
    const elapsed = Date.now() - lastRequestAt
    // ⚠️ 抖动只在上一次请求**很近**时才有意义（防脚本特征）。
    // 早先无条件加 0~400ms，等于每轮白等半天 —— 用户能直接感觉到"首字慢"。
    // 现在：间隔已经够（>2×minInterval）就完全不等待、也不加抖动。
    if (elapsed > Math.max(2_000, minIntervalMs * 2)) {
      lastRequestAt = Date.now()
      return
    }
    const jitter = Math.floor(Math.random() * 400)
    const target = minIntervalMs + jitter
    if (elapsed < target) {
      await new Promise((resolve) => setTimeout(resolve, target - elapsed))
    }
    lastRequestAt = Date.now()
  }

  if (allowConcurrent) {
    // 并发模式：只保证"发起间隔"（避免瞬间连打），不排队等前一个结束。
    await wait()
    return undefined
  }

  // 串行模式（用户显式关掉并发时才走这里）：等前一个请求彻底结束，再等够间隔。
  const previous = inflight
  let release
  inflight = new Promise((resolve) => {
    release = resolve
  })
  try {
    await previous
    await wait()
  } catch {
    /* 前一个失败也要继续 */
  }
  // 释放闸门交给调用方在 finally 里做
  return release
}

// ── 请求执行 ────────────────────────────────────────────────────────────

/**
 * 从历史里找出上一轮 assistant 消息携带的 replay state。
 *
 * DSH 会把每条 assistant 消息的 `source.replayState` 原样带到下一轮的
 * `options.messages` 里 —— 这是跨轮保存"本会话对应哪条上游会话"的正规通道。
 * 只认**我们自己 provider** 的，别把别家适配器的状态当自己的。
 *
 * @param {object} options
 * @returns {{conversationId?: string}|undefined}
 */
function readReplayState(options) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const source = messages[i]?.source
    if (!source || source.provider !== PROVIDER) continue
    const replay = source.replayState
    if (!replay || typeof replay !== 'object') continue
    if (typeof replay.conversationId === 'string' && replay.conversationId) return replay
  }
  return undefined
}

/**
 * 一次 stream 调用。
 *
 * 骨架照抄 DeepSeek 插件的做法（那块代码在真机上跑了几十万轮），
 * 但内容全部按 MiMo 的契约重写：没有 PoW、没有指纹头、思考走 reasoningContent。
 */
async function* runStream(options, deps) {
  const logger = deps.logger ?? {}
  const settings = deps.getSettings()
  const auth = deps.getAuth()
  const startedAt = Date.now()
  if (!auth) {
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message:
            '还没有登录小米 MiMo。请打开「设置 → MiMo 网页登录」，点「浏览器窗口登录」完成一次登录（只需一次，之后会自动复用）。',
          code: 'MISSING_CREDENTIAL',
        },
      },
    }
    return
  }

  const thinkingEnabled = resolveThinking(options, settings)

  // ★★ 上下文投喂方式 —— **两种都保留，由用户选**（`settings.contextMode`）。
  //
  //   `chained`（默认，像在官网对话框里打字）
  //       · **同一个 DSH 会话 → 复用同一个 conversationId → 只发增量**
  //       · 新会话（没有 replayState）→ 新开 conversationId → 首轮发全量（含协议）
  //       · 好处：像官网一样快。官网聊得快就是因为只发你新说的那句话；
  //         每轮重发几万字符会让上游先读完才开口，首字能拖到十几秒。
  //
  //   `full`（旧的稳妥模式，照搬 dsh-deepseek-web-login 的默认）
  //       · 每轮都开**新**会话 + 发**全量**转写
  //       · 好处：模型要的信息永远在最新那条消息里，服务端丢历史也不怕
  //       · 代价：慢、费 token，而且官网上每次都是独立会话
  //
  // 🔴 **两条路必须各自成对**，不能混：
  //      复用会话 + 又发全量 ⇒ 服务端存一份、我们再发一份 ⇒ 模型看到两份历史
  //      ⇒ 吐出交叠的损坏 JSON（`{"tool_calls":…{"tool_calls":…`）。真机踩过。
  const resumeState = readReplayState(options)
  const chained = settings.contextMode !== 'full'
  const isContinuation = chained && Boolean(resumeState?.conversationId)

  let prompt = isContinuation
    ? serializeDelta(options, settings, resumeState)
    : serializePrompt(options, settings)

  // 增量算出来是空的（例如这一轮只补了一条内部消息）—— 不发空请求，
  // 但也**不能退化成全量**（那又变成两份历史了）。
  if (isContinuation && !prompt.trim()) {
    logger.debug?.('mimo-web: 本轮增量为空，跳过发送')
    yield {
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: buildReplayState(options, resumeState.conversationId, settings),
    }
    return
  }
  if (!prompt.trim()) {
    yield {
      type: 'finish',
      reason: { kind: 'error', failure: { message: '本轮请求没有任何内容可发', code: 'EMPTY_RESPONSE' } },
    }
    return
  }

  let images = []
  try {
    images = await uploadImages(options.messages, deps, options.signal)
  } catch (error) {
    if (error?.code === 'ABORTED') throw error
    logger.warn?.(`mimo-web: 图片上传失败（降级为纯文本）：${error?.message ?? error}`)
  }

  // ⚠️ 上游只认真实模型 id（`mimo-v2.6-pro`）。传显示名（`MiMo-V2.6-Pro`）会被
  // 服务端回 `event:error data:{"content":"模型名称错误"}` —— 实测确认过。
  // 归一放在这里，重试时不必重复拉目录。
  // 优先级：prepareCall 传下来的 modelHint（宿主选的那个） > options.model。
  const modelCandidate = normalizeModelId(options.modelHint) || normalizeModelId(options.model)
  const resolvedModelId = await resolveUpstreamModelId(deps, modelCandidate)

  // 会话 id 在这里决定（chained 复用、full 每次新建），再传进执行体。
  const conversationId = isContinuation ? resumeState.conversationId : randomId()

  // ⚠️ 请求节流：网页端接口对"连续快速请求"的惩罚是**返回「没有权限操作」**，
  // 这个文案极具误导性（看起来像服务端拒绝授权，其实只是被限速）。
  // 实测：连发十几个请求后必然进入这个状态；间隔 ≥1.5s 就恢复正常。
  // 所以在真正发请求之前主动等够 minIntervalMs，宁可慢一点也别把账号打进惩罚状态。
  const releaseThrottle = await throttle(deps, settings)
  try {
    // 一次请求发出去，上游回什么就转什么。
    // 不做"文本超长就砍半重试"这类自作聪明的兜底 —— 那会让模型看到半截历史、
    // 悄悄改变语义，而用户完全不知道发生过什么。超长就照实报错。
    for await (const chunk of runStreamInner(options, deps, settings, logger, prompt, thinkingEnabled, images, auth, startedAt, resolvedModelId, conversationId)) {
      yield chunk
    }
  } finally {
    if (typeof releaseThrottle === 'function') releaseThrottle()
  }
}

/**
 * 节流闸门放行之后的真正执行体。
 *
 * 拆出来是为了让 `runStream` 能用 try/finally 保证闸门一定被释放 ——
 * 生成器里如果用 `yield*` 包住整段，天真的写法很容易漏掉 abort 路径。
 */
async function* runStreamInner(options, deps, settings, logger, prompt, thinkingEnabled, images, auth, startedAt, resolvedModelId, conversationId) {
  // ⚠️ 上游只认真实模型 id（`mimo-v2.6-pro`）。传显示名（`MiMo-V2.6-Pro`）会被
  // 服务端回 `event:error data:{"content":"模型名称错误"}` —— 实测确认过。
  // 归一工作已经在 runStream 里做过（重试时不必重做），这里只兜底一次。
  const modelId = resolvedModelId || (await resolveUpstreamModelId(deps, normalizeModelId(options.model)))

  const body = {
    msgId: randomId(),
    conversationId,
    query: prompt,
    isEditedQuery: false,
    modelConfig: {
      enableThinking: thinkingEnabled,
      webSearchStatus: settings.webSearch ?? 'disabled',
      model: modelId,
    },
    multiMedias: images,
  }

  const client = new MimoClient(auth, { signal: options.signal, idleTimeoutMs: settings.idleTimeoutMs, fetchImpl: deps.fetchImpl })

  // ★★ 「像在官网对话框里打字一样」—— 这是本插件的核心语义。
  //
  // 官网做三件事，我们也做这三件：
  //   ① **先登记会话**：`conversation/save` 让左栏出现这条对话（带标题）。
  //      官网点"新对话"时就会打这一枪；不打的话消息能通、但历史栏里没有。
  //   ② **只发这次输入的文字**：不重发历史、不重发协议（协议只在首轮发）。
  //   ③ **边收边吐**：SSE 来一帧吐一帧，而不是攒完再给。
  //
  // ① 必须**在发 chat 之前**、并且**每轮都打**：同 id 重复打是幂等的，
  // 服务端只更新 title 与 updateTime ⇒ 官网列表里那条会话会一直刷到最新。
  //
  // ⚠️ 它不能挡住首字，所以给 2 秒超时且失败静默（见 touchConversation）。
  try {
    await client.touchConversation({ conversationId, title: conversationTitle(prompt) })
  } catch {
    /* 静默：官网可见性不该影响对话本身 */
  }

  let textBlock
  let reasoningBlock
  let nextIndex = 0
  let rawText = ''
  let rawReasoning = ''
  let usage
  let failure

  const openText = () => {
    if (!textBlock) textBlock = { index: nextIndex++, text: '' }
    return textBlock
  }
  const openReasoning = () => {
    if (!reasoningBlock) reasoningBlock = { index: nextIndex++, text: '' }
    return reasoningBlock
  }

  let textStarted = false
  let reasoningStarted = false

  /**
   * 记一笔台账。
   *
   * 每个结束点都要调（成功/失败/取消都算一次真实调用）——
   * 只记成功的台账会把"一直在失败"这种最该被看见的状态藏起来。
   */
  const note = (ok, code, extra = {}) => {
    deps.noteCall?.({
      ok,
      code,
      purpose: options?.purpose ?? 'chat',
      ms: Date.now() - startedAt,
      model: String(options.model ?? ''),
      thinking: thinkingEnabled,
      ...extra,
    })
  }

  // ★ 正文走**流式**（hold-back 扫描）。
  //
  // 早先的实现把正文全攒在 rawText 里，等流结束再一次性吐 —— 用户看到
  // 思考哗哗出、正文却要等整段生成完，观感上就是"比官网慢很多"。
  // 官网是逐字出的，我们也该逐字出。
  //
  // 但直接边收边吐会漏出半截围栏标记（```ds…），所以用一个几十字符的
  // hold-back 窗口压住尾巴，窗口之外立刻放行。
  //
  // ⚠️ 必须声明在 try 外面：收尾阶段还要 flush 它。
  const filter = createStreamFilter()

  try {
    for await (const event of client.chat(body)) {
      if (event.kind === 'reasoning') {
        const block = openReasoning()
        if (!reasoningStarted) {
          reasoningStarted = true
          yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
        }
        block.text += event.text
        rawReasoning += event.text
        yield { type: 'reasoning-delta', index: block.index, text: event.text }
        continue
      }
      if (event.kind === 'text') {
        rawText += event.text
        const safe = filter.push(event.text)
        if (safe) {
          const block = openText()
          if (!textStarted) {
            textStarted = true
            yield { type: 'block-start', index: block.index, blockType: 'text' }
          }
          block.text += safe
          yield { type: 'text-delta', index: block.index, text: safe }
        }
        continue
      }
      if (event.kind === 'usage') {
        usage = event.usage
        continue
      }
      if (event.kind === 'error') {
        failure = event
        continue
      }
      if (event.kind === 'native-tool-calls') {
        // 本插件不用上游内置工具（webSearch 等），出现就记一笔。
        logger.debug?.(`mimo-web: 上游返回了 ${event.calls.length} 个原生工具调用（已忽略）`)
        continue
      }
      if (event.kind === 'tip') {
        if (event.truncate) logger.warn?.('mimo-web: 服务端提示本轮回答被截断（tip_truncate）')
        continue
      }
      if (event.kind === 'finish') break
    }
  } catch (error) {
    if (error?.code === 'ABORTED' || options.signal?.aborted) {
      note(false, 'ABORTED')
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'MiMo 请求已被取消', code: 'ABORTED' } },
      }
      return
    }
    const mimoError = error instanceof MimoError ? error : new MimoError(String(error?.message ?? error), 'TRANSPORT')
    note(false, mimoError.code)
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: `MiMo 网页端返回错误：${mimoError.message}`,
          code: mimoError.code,
          ...mimoError.retryAfterMs !== undefined ? { retryAfterMs: mimoError.retryAfterMs } : {},
        },
      },
    }
    return
  }

  if (failure) {
    note(false, failure.code ?? 'PROVIDER_ERROR')
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { message: `MiMo 网页端返回错误：${failure.message}`, code: failure.code ?? 'PROVIDER_ERROR' },
      },
    }
    return
  }

  // 流结束了：把 hold-back 窗口里剩下的正文也放出去。
  // ⚠️ 这一步必须在解析工具调用**之前**做 —— flush 出来的可能是正文尾巴。
  const tailText = filter.flush()

  // ⚠️ v2 协议（`/fastchat/open-apis/bot/chat`，UltraSpeed 走的那个）不像 v3
  // 那样把思考放在独立的 `reasoningContent` 字段，而是把 `<think>…</think>`
  // 直接混在正文里，而且用 \u0000 当分隔符。不剥掉的话这些会原样喷给用户。
  const unwrapped = unwrapThinkTags(rawText)
  const finalText = unwrapped.text
  if (unwrapped.reasoning) rawReasoning += unwrapped.reasoning

  // 完整解析一次拿到工具调用（流式阶段只放行正文，不解析调用）。
  const { text: visibleText, calls } = extractToolCalls(finalText)

  // v2 路径的思考是"事后"从 <think> 里解出来的，这时还没发过 reasoning 块，
  // 必须在这里补出去 —— 否则用户看不到思考，但 content 里又带着它的痕迹。
  if (rawReasoning && !reasoningBlock) {
    const block = openReasoning()
    yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
    block.text += rawReasoning
    yield { type: 'reasoning-delta', index: block.index, text: rawReasoning }
  }

  /**
   * 收尾时该补发的正文 = **完整可见正文** 减去 **流式阶段已经吐出去的**。
   *
   * 三种情况：
   *   ① 流式过滤器**什么都没放行**（`streamedText` 为空）
   *   ② 流式吐的就是正文前缀 ⇒ 补发剩余尾巴
   *   ③ 两边对不齐（v2 think 混入等）⇒ 不补，宁可少也不重复
   */
  const streamedText = textBlock?.text ?? ''
  let remainder = ''

  // 🔴 真机事故（2026-11-14）：模型输出 `{"tool_callsdsh-tool\n{"tool_calls":[…]}`。
  //
  // 流式过滤器正确地把整段压住了（`streamedText` 为空），收尾也抽出了调用，
  // 但正文里还漏出了一段原始 JSON。**根因是空串陷阱**：
  //
  //     if (visibleText.startsWith(streamedText))   // streamedText === '' 时恒为 true
  //       remainder = visibleText.slice(0)          // ⇒ 把整段 JSON 当正文补发
  //
  // 所以要**先**把 `streamedText === ''` 这一种单独处理掉。
  //
  // 关键判据是 `tailText`（flush 放出来的东西）：
  //   · 非空 ⇒ 那是被 hold-back 压住的**正文**（短回答整段都在窗口里），要补发
  //   · 为空 ⇒ 过滤器把调用整段吞了，此时的 visibleText 只能是解析残渣，不能补发
  if (!streamedText) {
    remainder = tailText
  } else if (visibleText.startsWith(streamedText)) {
    remainder = visibleText.slice(streamedText.length)
  } else {
    // 对不齐（v2 think 混入等）：整段重发会让用户看到重复，宁可少一点也不重复。
    remainder = ''
  }

  if (remainder) {
    const block = openText()
    if (!textStarted) {
      textStarted = true
      yield { type: 'block-start', index: block.index, blockType: 'text' }
    }
    block.text += remainder
    yield { type: 'text-delta', index: block.index, text: remainder }
  }

  for (const call of calls) {
    const index = nextIndex++
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments }
    yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments } }
  }

  if (reasoningBlock) {
    yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningBlock.text } }
  }
  if (textBlock) {
    yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: textBlock.text } }
  }

  const outputChars = (textBlock?.text?.length ?? 0) + (reasoningBlock?.text?.length ?? 0)
  const estimatedOutput = Math.ceil(outputChars / 2.2)
  const promptTokens = estimateTokens(prompt)
  yield {
    type: 'usage',
    usage: {
      inputTokens: usage?.prompt > 0 ? usage.prompt : promptTokens,
      outputTokens: usage?.completion > 0 ? usage.completion : estimatedOutput,
      serverTotal: Boolean(usage && usage.prompt > 0),
      ...reasoningBlock?.text ? { reasoningTokens: Math.ceil(reasoningBlock.text.length / 2.2) } : {},
    },
  }

  // ⚠️ 顺序很重要：`finish` **必须**在所有内容块之后、任何 I/O 之前发出。
  // 曾经这里先 await 了一次 `saveConversation`（网络请求）再 yield finish ——
  // 工具调用那一轮正文为空，await 期间宿主已经在等 finish，表现就是
  // "工具调用失败，请重新判断"。**绝不能在 yield finish 之前做网络 I/O。**
  if (calls.length > 0) {
    note(true, undefined, {
      inputTokens: usage?.prompt > 0 ? usage.prompt : promptTokens,
      outputTokens: usage?.completion > 0 ? usage.completion : estimatedOutput,
      toolCalls: calls.length,
    })
    yield {
      type: 'finish',
      reason: { kind: 'tool-calls' },
      // 把"这条网页端会话 + 已经推进到哪条消息"带回宿主，下一轮据此续聊。
      replayState: buildReplayState(options, conversationId, settings),
    }
    return
  }

  // 上游没有工具调用 ⇒ 就是普通回答。
  // 空不空由宿主判断（DSH 自己会处理空回复），适配器不越权替它决定什么是"失败"。
  note(true, undefined, {
    inputTokens: usage?.prompt > 0 ? usage.prompt : promptTokens,
    outputTokens: usage?.completion > 0 ? usage.completion : estimatedOutput,
  })
  yield {
    type: 'finish',
    reason: { kind: 'stop' },
    replayState: buildReplayState(options, conversationId, settings),
  }
}

/**
 * 给网页端会话起一个标题。
 *
 * `conversation/save` 的 `title` 是**必填**（空串会 400 `title: must not be empty`）。
 * 优先用本轮用户说的话 —— 那才是用户自己在官网左栏会认出来的东西。
 *
 * @param {string} prompt 序列化后的 prompt（里面最后一条 `User: …` 通常就是本轮问题）
 * @returns {string}
 */
function conversationTitle(prompt) {
  const userLines = String(prompt ?? '')
    .split('\n')
    .filter((line) => line.startsWith('User: '))
  const last = userLines.length > 0 ? userLines[userLines.length - 1].slice(6) : ''
  const cleaned = last
    .replace(/\[图片已附上\]/g, '')
    .replace(/\[Tool Result[^\]]*\]/g, '')
    .replace(/\[工具结果[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return 'DSH 对话'
  return cleaned.length > 24 ? `${cleaned.slice(0, 24)}…` : cleaned
}

/**
 * 构造要带回宿主的 replay state。
 *
 * @param {object} options
 * @param {string} conversationId
 * @returns {{conversationId: string, lastMessageId?: string}}
 */
function buildReplayState(options, conversationId, settings) {
  const messages = Array.isArray(options?.messages) ? options.messages : []
  const last = messages.length > 0 ? messages[messages.length - 1] : undefined
  const lastMessageId = typeof last?.id === 'string' ? last.id : undefined
  return {
    conversationId,
    ...(lastMessageId ? { lastMessageId } : {}),
    // 头部指纹：下一轮据此判断"该不该重发系统提示 + 工具协议"。
    // 上游会话里已经有了就不重发（重复灌协议会让上下文反复叠加、诱发回响）。
    ...(settings ? { headHash: headFingerprint(options, settings) } : {}),
  }
}

/** 头部（system + 协议 + 工具目录）的指纹，用于判断"这一轮要不要重发"。 */
function headFingerprint(options, settings) {
  const { head } = buildHead(options, settings)
  return hashText(head)
}

/**
 * 拼出固定头（system + 协议 + 工具目录）。
 *
 * ⚠️ **必须只有这一处拼接**：`serializeDelta` 与 `headFingerprint` 早先各写了一份，
 * 一份在 protocol 为空时多拼了 `\n\n`、另一份没有 ⇒ 哈希永远不等 ⇒ 每轮都重发协议，
 * "头部没变就不重发"的优化直接失效。抽出来共用是唯一稳妥的写法。
 */
function buildHead(options, settings) {
  const system = String(options?.system ?? '').trim()
  const tools = Array.isArray(options?.tools) ? options.tools : []
  const toolSection = buildToolSection(tools)
  const protocol = toolSection ? `${toolProtocolInstructions()}\n${toolSection}` : ''
  return {
    head: system && protocol ? `${system}\n\n${protocol}` : system || protocol,
    protocol,
  }
}

function resolveThinking(options, settings) {
  const effort = options?.reasoningEffort
  if (effort === 'on') return true
  if (effort === 'off') return false
  return settings.thinking !== false
}

/**
 * 估算 token。
 *
 * 网页端不返回准确计数（usage 有时候有、有时候没有），所以只能估：
 * 中文约 1.6 字符/token，英文约 4 字符/token，混排取中间的 2.2。
 */
function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(String(text).length / 2.2)
}

// ── 提示词序列化 ─────────────────────────────────────────────────────────

/**
 * 只序列化"上次之后新增的那部分消息"。
 *
 * 续聊时上游已经记着前面的对话，所以只需要把**新的一轮**发过去。
 * 判断依据是 replayState 里记下的 `lastMessageId`：从它之后（不含）开始取。
 *
 * ⚠️ 这里的取舍：宁可多发一点也不能漏。所以除了 `lastMessageId` 之后的消息，
 * 还会把最后一条 user 消息里**内嵌的工具结果**一起带上 —— 工具循环那一轮
 * 如果被截掉，模型会对着半截状态瞎猜。
 *
 * @param {object} options
 * @param {object} settings
 * @param {{lastMessageId?: string}} replay
 * @returns {string}
 */
function serializeDelta(options, settings, replay) {
  const messages = Array.isArray(options.messages) ? options.messages : []
  const lastId = typeof replay?.lastMessageId === 'string' ? replay.lastMessageId : ''

  let start = lastId ? messages.findIndex((message) => message?.id === lastId) : -1
  // 找不到锚点（消息被压缩/重排过）→ 整个发一遍最稳妥
  if (start < 0) return serializePrompt(options, settings)
  start += 1

  const fresh = messages.slice(start)
  if (fresh.length === 0) return ''

  const tools = Array.isArray(options.tools) ? options.tools : []
  const { head } = buildHead(options, settings)
  const headHash = hashText(head)
  const headSent = replay?.headHash === headHash

  const lines = []
  const imageMarks = []

  for (const message of fresh) {
    if (!message || typeof message !== 'object') continue
    const blocks = Array.isArray(message.content) ? message.content : []

    if (message.role === 'developer') {
      // 工具增删是**头部变化**的一种，不能当回声剔掉。
      for (const line of renderDeveloperUpdates(blocks, tools)) lines.push(line)
      continue
    }
    if (message.role === 'system') {
      const text = flattenText(blocks).join('')
      if (text.trim()) lines.push(`[System]\n${text}`)
      continue
    }
    if (message.role === 'assistant') {
      // 🔴 **剔除模型回声**（照搬 DeepSeek 的 `isAssistantTranscriptEntry`）。
      //
      // 上游会话里已经有我们上一轮说了什么。再喂回去，模型看到的就是
      // "自己刚说过的话 + 现在的提问"，用户原话：像"把答案喂给它让它复述"。
      // 而且它会诱发规则 8 禁止的"复述转写"行为。
      continue
    }
    if (message.role === 'tool') {
      const body = flattenText(blocks).join('') || '(no output)'
      const errorMark = message.isError === true ? ' [ERROR]' : ''
      lines.push(`[Tool Result${errorMark} for ${String(message.toolCallId ?? '')}]\n${body}`)
      continue
    }

    const embeddedResults = blocks.filter((block) => block?.type === 'tool-result')
    const bodyBlocks = blocks.filter((block) => block?.type !== 'tool-result')
    const text = flattenText(bodyBlocks).join('')
    for (const block of walkBlocks(bodyBlocks)) {
      if (block?.type === 'image') imageMarks.push('[图片已附上]')
    }
    const marks = imageMarks.length > 0 ? `\n${imageMarks.join(' ')}` : ''
    if (text.trim() || marks) lines.push(`User: ${text}${marks}`)
    for (const result of embeddedResults) {
      const body = flattenText(result.content).join('') || '(no output)'
      const errorMark = result.isError ? ' [ERROR]' : ''
      lines.push(`[Tool Result${errorMark} for ${String(result.toolCallId ?? '')}]\n${body}`)
    }
  }

  const transcript = lines.join('\n\n')
  if (!transcript && headSent) return ''

  return headSent || !head ? transcript : `${head}\n\n---\n\n${transcript}`
}

/** 头部指纹（判断"这一轮该不该重发协议"）。 */
function hashText(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `${(h >>> 0).toString(16)}:${text.length}`
}

/**
 * 把 DSH 的消息数组拍成 MiMo 要的一段纯文本。
 *
 * MiMo 的 `query` 没有 role 概念 —— 它就是一整段话。所以这里显式写出角色前缀，
 * 让工具协议出现在固定头里。
 *
 * ⚠️ 续聊（`serializeDelta`）也**必须**重发这份协议头 —— 见那边的注释。
 */
function serializePrompt(options, settings) {
  const system = String(options.system ?? '').trim()
  const tools = Array.isArray(options.tools) ? options.tools : []
  const toolSection = buildToolSection(tools)
  const protocol = toolSection ? `\n\n${toolProtocolInstructions()}\n${toolSection}` : ''

  /**
   * 🔴 把「指令」和「对话」用明显的边界隔开。
   *
   * 真机事故（2026-11-14）：MiMo V2.6 Pro 在深度思考下，把协议里的
   * ` ```dsh-tool {…} ` 格式示例**当成了自己之前发过的调用**，而且因为示例后面
   * 没有对应的结果，它就断定"那些调用都失败了"，于是在 reasoning 里演起了
   * "调一次 → 失败 → 换个格式重试"的独角戏，**真正的调用一次也没发出去**。
   *
   * 它的原话：
   *   "looking at my previous messages, I did use the dsh-tool fence. And they all failed."
   *   "even `working_directory` with no arguments fails"
   *
   * 之前是 `system + 协议` 直接并排、再用 `---` 接对话，模型分不清哪段是"说明"、
   * 哪段是"我说过的话"。现在给两段都套上明确标题，对话段再单独标一次。
   */
  const head = [
    system ? `[SYSTEM INSTRUCTIONS]\n${system}` : '',
    protocol.trim() ? `[TOOL INSTRUCTIONS — reference material, not part of the conversation]\n${protocol.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const lines = []
  const imageMarks = []

  for (const message of options.messages ?? []) {
    if (!message || typeof message !== 'object') continue
    const blocks = Array.isArray(message.content) ? message.content : []

    if (message.role === 'developer') {
      // 工具集增删的增量通知 —— 逐条渲染（照搬 DeepSeek 的 renderDeveloperUpdates）。
      for (const line of renderDeveloperUpdates(blocks, tools)) lines.push(line)
      continue
    }
    if (message.role === 'system') {
      const text = flattenText(blocks).join('')
      if (text.trim()) lines.push(`[System]\n${text}`)
      continue
    }
    if (message.role === 'assistant') {
      // 🔴 历史里的调用块**必须**渲染成协议约定的那个形状（`{"tool_calls":[…]}`），
      // 且 `arguments` 是**嵌套对象**。模型是从历史里学格式的：早先这里用的是
      // 自创的 `<mimo_tool_call>` XML，结果模型照着 XML 写，而协议要求围栏 JSON
      // ⇒ 形状对不上 ⇒ 读写工具反复失败。照搬 DeepSeek 的 renderToolCalls 修掉。
      const renderedCalls = renderToolCalls(blocks)
      const text = flattenText(blocks).join('')
      if (renderedCalls) lines.push(`Assistant: ${renderedCalls}`)
      else if (text.trim()) lines.push(`Assistant: ${text}`)
      continue
    }
    if (message.role === 'tool') {
      const body = flattenText(blocks).join('') || '(no output)'
      const errorMark = message.isError === true ? ' [ERROR]' : ''
      lines.push(`[Tool Result${errorMark} for ${String(message.toolCallId ?? '')}]\n${body}`)
      continue
    }

    // user：正文 + 内嵌工具结果 + 图片占位
    const embeddedResults = blocks.filter((block) => block?.type === 'tool-result')
    const bodyBlocks = blocks.filter((block) => block?.type !== 'tool-result')
    const text = flattenText(bodyBlocks).join('')
    for (const block of walkBlocks(bodyBlocks)) {
      if (block?.type === 'image') imageMarks.push('[图片已附上]')
    }
    const marks = imageMarks.length > 0 ? `\n${imageMarks.join(' ')}` : ''
    if (text.trim() || marks) lines.push(`User: ${text}${marks}`)
    for (const result of embeddedResults) {
      const body = flattenText(result.content).join('') || '(no output)'
      const errorMark = result.isError ? ' [ERROR]' : ''
      lines.push(`[Tool Result${errorMark} for ${String(result.toolCallId ?? '')}]\n${body}`)
    }
  }

  const transcript = lines.join('\n\n')
  /**
   * 结尾这句是**真机事故（2026-11-14）**换来的。
   *
   * MiMo V2.6 Pro 开深度思考时会先把「调工具 → 失败 → 换格式重试」整套流程
   * 在 reasoning 里演一遍，然后认定"我已经试过了，都失败了"，于是要么放弃、
   * 要么无限重试 —— 而真实的调用一次都没发出去。
   *
   * 它在推理里的原话："even `working_directory` with no arguments fails"、
   * "I did use the dsh-tool fence. And they all failed."，全是编的。
   *
   * 提示词里那些"禁止模拟"的规则它读得进但压不住，所以这里再给一条
   * **紧贴发言位置**的事实陈述：此刻你还没调用过任何工具。
   */
  const merged = transcript
    ? `${head}

=== CONVERSATION (everything below is what was actually said; reply to the last User line) ===

${transcript}

[Reminder for this reply: you have NOT called any tool in this step yet — no call of yours has succeeded AND none has failed. Anything that "already failed" in your thinking never actually ran. Decide once, then emit exactly one \`\`\`dsh-tool call as visible output.]`
    : head
  // 不压缩、不截断：DSH 传过来什么就发什么。
  // 上下文长度是宿主自己的职责（它管 contextWindow 与预算），适配器不该二次加工 ——
  // 截断只会让模型突然失忆，而"文本超长"上游会明确报错，照实转达即可。
  return merged
}

/**
 * 渲染 DSH `developer` 消息里的**工具变更块**（照搬 DeepSeek 的 renderDeveloperUpdates）。
 *
 * harness 会为「中途新增 / 移除的工具」写一条 `role:'developer'`，content 形如
 * `[{type:'tool-addition', toolName:'multi_search'}, …]`。只声明 toolUpdate 能力却
 * 不处理这些块，它们会掉进 user 分支被当成用户输入 —— 那会污染对话。
 */
function renderDeveloperUpdates(blocks, tools) {
  const byName = new Map()
  for (const tool of tools ?? []) if (tool && typeof tool.name === 'string') byName.set(tool.name, tool)
  const lines = []
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') {
      const text = String(block.text ?? '').trim()
      if (text) lines.push(text)
      continue
    }
    if (block.type !== 'tool-addition' && block.type !== 'tool-removal') continue
    const name = String(block.toolName ?? block.name ?? '').trim()
    if (!name) continue
    if (block.type === 'tool-removal') {
      lines.push(`[Tool removed: ${name}] — it is no longer available, do not call it.`)
      continue
    }
    const tool = byName.get(name)
    const signature = tool ? buildToolSignature(tool, true) : null
    let parametersText = signature ?? ''
    if (signature === null) {
      let schemaText = '{}'
      try {
        schemaText = JSON.stringify(tool?.parameters ?? {})
      } catch {
        schemaText = '{}'
      }
      parametersText = `Parameters (JSON Schema): ${schemaText}`
    }
    const description = String(tool?.description ?? '').replace(/\s+/g, ' ').trim()
    lines.push([`[Tool added: ${name}]`, description, parametersText].filter(Boolean).join('\n'))
  }
  return lines
}

/** 递归遍历内容块（tool-result 里还可能嵌图片）。 */
function* walkBlocks(blocks) {
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object') continue
    yield block
    if (block.type === 'tool-result' && Array.isArray(block.content)) yield* walkBlocks(block.content)
  }
}

function flattenText(blocks, out = []) {
  for (const block of blocks ?? []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') out.push(block.text)
    else if (block.type === 'tool-result' && Array.isArray(block.content)) flattenText(block.content, out)
  }
  return out
}

/**
 * 从正文里剥掉 `<think>…</think>`，把思考内容挪到 reasoning。
 *
 * v2 协议（UltraSpeed 走的 `/fastchat/open-apis/bot/chat`）会把思考直接混进
 * 正文，标签外面还可能夹着 `\u0000` 分隔符。不处理的话用户会看到
 * `<think>` 字面量，思考也进不了思考区。
 *
 * @param {string} text
 * @returns {{ text: string, reasoning: string }}
 */
function unwrapThinkTags(text) {
  const source = String(text ?? '')
  if (!/<think/i.test(source)) {
    // 没有标签也要把裸的 \u0000 分隔符清掉
    return { text: source.replace(/\u0000/g, ''), reasoning: '' }
  }
  const reasoningParts = []
  const kept = source
    .replace(/<think[^>]*>([\s\S]*?)<\/think>/gi, (_, inner) => {
      reasoningParts.push(inner)
      return ''
    })
    // 只有开标签没有闭合（被截断）时，把剩下的部分整段当思考
    .replace(/<think[^>]*>([\s\S]*)$/i, (_, inner) => {
      reasoningParts.push(inner)
      return ''
    })
    .replace(/\u0000/g, '')
  return {
    text: kept.trim(),
    reasoning: reasoningParts.join('').replace(/\u0000/g, '').trim(),
  }
}

// ── 图片 ────────────────────────────────────────────────────────────────

/**
 * 把消息里的图片上传到 MiMo，返回 `multiMedias[]`。
 *
 * 网页端对一次请求的图片条数有上限，超了整轮被拒。所以只带最近的 N 张，
 * 更早的在正文里已经标了 `[图片已附上]` —— 这里不再区分（早于上限的图
 * 本来就不该出现在最近几轮）。
 */
async function uploadImages(messages, deps, signal) {
  if (!deps.readImage) return []
  const settings = deps.getSettings()
  const maxImages = Number(settings.maxImages) || 0
  if (maxImages <= 0) return []

  const refs = []
  for (const message of messages ?? []) {
    if (!message || typeof message !== 'object') continue
    for (const block of walkBlocks(Array.isArray(message.content) ? message.content : [])) {
      if (block?.type === 'image' && block.attachment) refs.push(block.attachment)
    }
  }
  if (refs.length === 0) return []

  const seen = new Set()
  const unique = []
  for (const ref of refs) {
    const key = String(ref?.attachmentId ?? '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(ref)
  }
  const kept = unique.slice(-maxImages)
  if (unique.length > kept.length) {
    deps.logger?.info?.(`mimo-web: 本轮共 ${unique.length} 张图，超过上限 ${maxImages}，只发最近 ${kept.length} 张`)
  }

  const auth = deps.getAuth()
  if (!auth) return []
  const client = new MimoClient(auth, { signal, fetchImpl: deps.fetchImpl })
  const out = []
  for (const ref of kept) {
    signal?.throwIfAborted()
    try {
      const stored = await deps.readImage(ref, signal)
      const mediaType = stored.mediaType || 'image/png'
      const name = imageFileName(stored.name, mediaType)
      const item = await client.uploadMedia({ data: stored.data, mediaType: 'image', name, model: undefined })
      out.push(item)
    } catch (error) {
      if (signal?.aborted) throw new MimoError('图片上传被取消', 'ABORTED', { cause: error })
      deps.logger?.warn?.(`mimo-web: 图片上传失败（跳过这张）：${error?.message ?? error}`)
    }
  }
  return out
}

/**
 * 上传用的文件名后缀。
 *
 * 服务端按**文件名后缀**判类型（不看 multipart 的 content-type），
 * 而宿主给工具结果的 `name` 往往是纯 sha256、没有后缀 —— 必须归一化，
 * 否则整张图会被以「不支持的文件类型」拒掉。
 */
function imageFileName(name, mediaType) {
  const ext =
    { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[
      String(mediaType).toLowerCase()
    ] ?? 'png'
  const base = String(name ?? '').trim()
  if (base && new RegExp(`\\.${ext}$`, 'i').test(base)) return base
  if (base && /\.(png|jpe?g|webp|gif)$/i.test(base)) return base
  return `image.${ext}`
}

export { isUsableModelId, isUltraSpeedOnly, isFastchatModel }
