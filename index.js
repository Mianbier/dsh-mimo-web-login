/**
 * dsh-mimo-web-login — 插件入口（Host 半身）。
 *
 * 做三件事：
 *  1) 把 `mimo-web` 适配器注册进 ctx.llm（注册即绑定本插件 fiber，热重载即净）；
 *  2) 挂 webServer 前缀 `/mimo-web-login/api/*`（设置面板消费）；
 *  3) 定时只读探活，在任务跑到一半之前发现登录态过期。
 *
 * 打包约束：除 `node:` 与 `electron` 外全部自包含，不 import 任何 @deepseek-ai/*
 * 运行时模块 —— 这样任何装配路径（bundle / patch / 注入）都能加载。
 */

import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

import { createAdapter, PROVIDER, isUsableModelId } from './lib/adapter.js'
import { REQUIRED_COOKIES, captureLogin, clearBrowserProfile, electronWindowAvailable, loginCapabilities, openInDefaultBrowser } from './lib/browser-login.js'
import { MimoClient, MimoError } from './lib/mimo-client.js'
import { noteCall, resetUsage, summarize } from './lib/usage.js'
import {
  DEFAULT_SETTINGS,
  TOKEN_TTL_MS,
  TTS_VOICES,
  activeAccountId,
  currentAccount,
  describeAccount,
  listAccounts,
  readAccount,
  readSettings,
  removeAccount,
  normalizeCookieValue,
  setActiveAccountId,
  storeDir,
  tokenAgeMs,
  updateAccount,
  upsertAccount,
  writeSettings,
} from './lib/store.js'

export const name = 'dsh-mimo-web-login'
export const inject = ['llm', 'webServer']

/** 面板「关于」页显示的版本 —— 与 package.json 保持一致。 */
const VERSION = '1.0.0'

const API_PREFIX = '/mimo-web-login/api'
const BODY_LIMIT_BYTES = 1024 * 1024

class BodyError extends Error {}

async function readJsonBody(req, limit = BODY_LIMIT_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new BodyError('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new BodyError('请求体不是合法 JSON')
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 掩码：面板上永远不显示完整 token。 */
function maskToken(token) {
  if (typeof token !== 'string' || token.length === 0) return ''
  if (token.length <= 22) return '***'
  return `${token.slice(0, 8)}…${token.slice(-4)}`
}

function normalizeLogger(logger) {
  if (!logger) return {}
  return {
    info: typeof logger.info === 'function' ? (message) => logger.info(String(message)) : undefined,
    warn: typeof logger.warn === 'function' ? (message) => logger.warn(String(message)) : undefined,
    debug: typeof logger.debug === 'function' ? (message) => logger.debug(String(message)) : undefined,
  }
}

/**
 * 登录窗口最长等多久。
 *
 * 默认 5 分钟（够走完扫码 + 二次验证）。`DSH_MIMO_LOGIN_TIMEOUT_MS` 可以改，
 * 自动化测试把它设小 —— 否则一个没人管的窗口会让测试挂满 5 分钟。
 */
function loginTimeoutMs() {
  const raw = Number(process.env.DSH_MIMO_LOGIN_TIMEOUT_MS)
  if (Number.isFinite(raw) && raw >= 1000) return Math.min(raw, 10 * 60 * 1000)
  return 5 * 60 * 1000
}

/** 自动化测试用：设了它就完全不拉起浏览器，直接给一个"不可用"的结果。 */
function loginDisabledByEnv() {
  return process.env.DSH_MIMO_LOGIN_DISABLED === '1'
}

export function apply(ctx, config = {}) {
  const logger = normalizeLogger(ctx.logger)
  let settings = readSettings()
  const getSettings = () => settings
  const getAuth = () => {
    const account = currentAccount()
    if (!account) return undefined
    return {
      serviceToken: account.serviceToken,
      userId: account.userId,
      xiaomichatbotPh: account.xiaomichatbotPh,
    }
  }

  /** 正在进行的登录（同一时刻只允许一个，否则两个窗口抢同一个 profile）。 */
  let pendingLogin
  /** 取消正在进行的登录 —— 用户可能改了主意，或窗口被关掉后任务还在轮询。 */
  let loginAbort
  /** 最近一次登录进度，面板轮询显示。 */
  let loginProgress = { running: false, messages: [], startedAt: 0 }
  const pushProgress = (message) => {
    loginProgress.messages.push({ at: new Date().toISOString(), message: String(message) })
    if (loginProgress.messages.length > 40) loginProgress.messages.shift()
    logger.info?.(`mimo-web: ${message}`)
  }

  const adapter = createAdapter({
    getAuth,
    getSettings,
    noteCall,
    logger,
    readImage: async (ref, signal) => {
      // ctx.get 是惰性求值，但未 inject 的服务也可能抛 —— 包一层，别让它把整轮打挂。
      let attachments
      try {
        attachments = ctx.get?.('attachments')
      } catch {
        attachments = undefined
      }
      if (!attachments || typeof attachments.readImage !== 'function') {
        throw new Error('宿主的附件服务不可用（ctx.attachments）')
      }
      const stored = await attachments.readImage(ref, signal)
      return {
        data: stored.data,
        ...(stored.ref?.mediaType ? { mediaType: String(stored.ref.mediaType) } : {}),
        ...(stored.ref?.name ? { name: String(stored.ref.name) } : {}),
      }
    },
  })

  ctx.llm.registerAdapter([PROVIDER], adapter)
  logger.info?.(`mimo-web: 已注册 provider "${PROVIDER}"`)

  /**
   * 探测适配器是否真的挂到了 llm 上。
   *
   * @returns {boolean|undefined} `true` 已注册、`false` 查到了但没有、`undefined` 宿主不提供查询。
   */
  function probeAdapterRegistered() {
    try {
      const llm = ctx.llm
      if (typeof llm?.listProviders !== 'function') return undefined
      const list = llm.listProviders() ?? []
      const found = list.some((item) => {
        const id = typeof item === 'string' ? item : item?.id ?? item?.provider
        return String(id ?? '') === PROVIDER
      })
      return found
    } catch {
      return undefined
    }
  }

  // ── 探活 ──────────────────────────────────────────────────────────────
  const probeOnce = async (account) => {
    if (!account) return { ok: false, error: '没有已保存的账号' }
    const client = new MimoClient({
      serviceToken: account.serviceToken,
      userId: account.userId,
      xiaomichatbotPh: account.xiaomichatbotPh,
    })
    const result = await client.whoami()
    if (result.ok) {
      updateAccount(account.id, { verifiedAt: new Date().toISOString(), lastError: undefined })
      return { ok: true }
    }
    const message = result.error?.message ?? '探活失败'
    // 只有明确的授权失败才标记失效；断网/超时/5xx 不标记（凭证其实是好的）。
    if (result.error?.code === 'AUTH') {
      updateAccount(account.id, { lastError: { at: new Date().toISOString(), message } })
    }
    return { ok: false, error: message, code: result.error?.code }
  }

  const probeInterval = Number(settings.probeIntervalMs) || 0
  if (probeInterval > 0) {
    // ⚠️ 不能用 `ctx.setInterval`：它是 Cordis 的服务属性访问器，未 inject `timer`
    // 时读取本身就会抛 "cannot get property timer without inject"，`?.` 拦不住
    // （异常发生在属性 getter 里，不是调用返回值上）。用宿主全局定时器就好。
    ctx.effect(() => {
      const handle = globalThis.setInterval(() => {
        const account = currentAccount()
        if (!account) return
        probeOnce(account).catch((error) => {
          logger.debug?.(`mimo-web: 探活失败（忽略）：${error?.message ?? error}`)
        })
      }, probeInterval)
      handle?.unref?.()
      return () => globalThis.clearInterval(handle)
    }, 'mimo-web-login: probe-interval')
  }

  // ── HTTP API ──────────────────────────────────────────────────────────
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
        const route = url.pathname.slice(API_PREFIX.length) || '/'
        try {
          if (req.method === 'GET' && route === '/status') {
            const account = currentAccount()
            const accounts = listAccounts()
            const caps = loginCapabilities()
            const usageSummary = summarize()
            // 登录态年龄 —— 面板要显示"距上次捕获多久"与是否临近 24 小时过期。
            const ageMs = account ? tokenAgeMs(account) : undefined
            sendJson(res, 200, {
              provider: PROVIDER,
              loggedIn: Boolean(account),
              account: describeAccount(account),
              accounts: accounts.map((item) => ({
                ...describeAccount(item),
                current: item.id === (activeAccountId() || account?.id),
                token: maskToken(item.serviceToken),
              })),
              settings,
              defaults: DEFAULT_SETTINGS,
              // 音色清单：面板下拉用。放服务端是为了只维护一份（lib/store.js）。
              ttsVoices: TTS_VOICES,
              capabilities: {
                ...caps,
                // 适配器是否真的挂到了 llm 上（和 DeepSeek 面板那行「适配器注册」对齐）。
                // 宿主不提供查询时返回 null，面板据此显示"已注册（无法二次确认）"而不是"未注册"。
                adapterRegistered: probeAdapterRegistered(),
                route: PROVIDER,
              },
              diagnostics: {
                tokenAgeMs: ageMs,
                tokenTtlMs: TOKEN_TTL_MS,
                capturedAt: account?.capturedAt,
                verifiedAt: account?.verifiedAt,
                lastError: account?.lastError,
                hasServiceToken: Boolean(account?.serviceToken),
                hasUserId: Boolean(account?.userId),
                hasPh: Boolean(account?.xiaomichatbotPh),
                // UltraSpeed 的独立凭据 —— 有它 ultra 模型才可用。
                hasUltraPh: Boolean(account?.ultraspeedPh),
                tokenLength: account?.serviceToken?.length ?? 0,
                transport: 'node-fetch',
                thinking: settings.thinking !== false,
                webSearch: settings.webSearch,
              },
              usage: usageSummary,
              login: loginProgress,
              dataDir: storeDir(),
              tokenTtlMs: TOKEN_TTL_MS,
              version: VERSION,
            })
            return
          }

          // 「用系统默认浏览器打开登录页」—— 没有 Chromium 系浏览器时的兜底。
          //
          // 这条**不读 cookie**：只是把登录页丢给用户的默认浏览器（Linux 上可能是
          // Firefox/Epiphany，路径没法穷举）。用户登完自己从 DevTools 复制三个
          // cookie 粘回面板 —— 面板本来就有这个入口。
          if (req.method === 'POST' && route === '/login/open-browser') {
            const result = await openInDefaultBrowser()
            sendJson(res, result.ok ? 200 : 500, {
              ...result,
              cookies: REQUIRED_COOKIES,
            })
            return
          }

          if (req.method === 'POST' && route === '/login') {
            if (pendingLogin) {
              sendJson(res, 409, { ok: false, error: '已经有一个登录窗口在进行了，请先完成或等它超时。' })
              return
            }
            // 「登录新账号」必须先把旧登录态清干净，否则窗口一打开就是上一个账号。
            clearBrowserProfile()
            loginProgress = { running: true, messages: [], startedAt: Date.now(), result: undefined }
            const abortController = new AbortController()
            loginAbort = abortController
            // ⚠️ 登录要等人操作（可能几分钟），不能在这里 await 完再回响应 ——
            // 那样 HTTP 请求会挂 5 分钟，前端和中间层都可能先超时。
            // 所以立刻回 202，结果写进 loginProgress 由前端轮询 /status 取。
            pendingLogin = (async () => {
              try {
                if (loginDisabledByEnv()) {
                  throw new Error('登录窗口已被环境变量禁用（DSH_MIMO_LOGIN_DISABLED=1）')
                }
                pushProgress('正在准备登录窗口 …')
                const captured = await captureLogin({
                  onProgress: pushProgress,
                  signal: abortController.signal,
                  timeoutMs: loginTimeoutMs(),
                })
                pushProgress('已读到登录凭据，正在校验 …')
                const client = new MimoClient(captured)
                const verified = await client.whoami()
                const record = upsertAccount(captured, {
                  ...(verified.ok ? { verifiedAt: new Date().toISOString() } : {}),
                  ...(verified.ok ? {} : { lastError: { at: new Date().toISOString(), message: '登录成功但探活未通过' } }),
                })
                setActiveAccountId(record.id)
                pushProgress(verified.ok ? '登录成功，已切换到这个账号。' : '已保存凭据，但服务端校验没通过。')
                return { ok: true, verified: verified.ok, account: describeAccount(record) }
              } catch (error) {
                const aborted = error?.name === 'AbortError' || abortController.signal.aborted
                pushProgress(aborted ? '登录已取消。' : `登录失败：${error?.message ?? error}`)
                return { ok: false, cancelled: aborted, error: String(error?.message ?? error) }
              } finally {
                loginProgress = { ...loginProgress, running: false }
                pendingLogin = undefined
                loginAbort = undefined
              }
            })()
            pendingLogin.then((outcome) => {
              loginProgress = { ...loginProgress, running: false, result: outcome }
            })
            sendJson(res, 202, { ok: true, started: true, message: '登录窗口已开始打开，请完成登录后回到面板。' })
            return
          }

          if (req.method === 'POST' && route === '/login/cancel') {
            if (!loginAbort) {
              sendJson(res, 200, { ok: true, running: false })
              return
            }
            loginAbort.abort()
            pushProgress('已请求取消登录 …')
            sendJson(res, 200, { ok: true, running: true })
            return
          }

          if (req.method === 'POST' && route === '/usage/reset') {
            const ok = resetUsage()
            sendJson(res, ok ? 200 : 500, { ok, ...(ok ? {} : { error: '清空失败（文件可能被占用）' }) })
            return
          }

          if (req.method === 'POST' && route === '/token') {
            // 手动粘贴：给拿不到浏览器（纯 web profile、容器）的环境留的出口。
            const body = await readJsonBody(req)
            const serviceToken = String(body?.serviceToken ?? '').trim()
            const userId = String(body?.userId ?? '').trim()
            const xiaomichatbotPh = String(body?.xiaomichatbotPh ?? '').trim()
            const missing = [
              !serviceToken && 'xiaomichatbot_serviceToken',
              !userId && 'userId',
              !xiaomichatbotPh && 'xiaomichatbot_ph',
            ].filter(Boolean)
            if (missing.length > 0) {
              sendJson(res, 400, { ok: false, error: `缺少：${missing.join(' / ')}` })
              return
            }
            const client = new MimoClient({
              serviceToken: normalizeCookieValue(body?.serviceToken),
              userId: normalizeCookieValue(body?.userId),
              xiaomichatbotPh: normalizeCookieValue(body?.xiaomichatbotPh),
            })
            const verified = await client.whoami()
            const record = upsertAccount(
              { serviceToken, userId, xiaomichatbotPh },
              verified.ok
                ? { verifiedAt: new Date().toISOString() }
                : { lastError: { at: new Date().toISOString(), message: verified.error?.message ?? '校验未通过' } },
            )
            setActiveAccountId(record.id)
            sendJson(res, 200, {
              ok: true,
              verified: verified.ok,
              ...(verified.ok ? {} : { warning: verified.error?.message ?? '服务端校验未通过' }),
              account: describeAccount(record),
            })
            return
          }

          if (req.method === 'POST' && route === '/switch') {
            const body = await readJsonBody(req)
            const id = String(body?.id ?? '')
            if (!readAccount(id)) {
              sendJson(res, 404, { ok: false, error: '没有这个账号' })
              return
            }
            setActiveAccountId(id)
            sendJson(res, 200, { ok: true, account: describeAccount(readAccount(id)) })
            return
          }

          if (req.method === 'POST' && route === '/remove') {
            const body = await readJsonBody(req)
            const id = String(body?.id ?? '')
            const removed = removeAccount(id)
            sendJson(res, removed ? 200 : 404, { ok: removed })
            return
          }

          if (req.method === 'POST' && route === '/verify') {
            const body = await readJsonBody(req)
            const id = String(body?.id ?? '')
            const account = id ? readAccount(id) : currentAccount()
            if (!account) {
              sendJson(res, 404, { ok: false, error: '没有可校验的账号' })
              return
            }
            const result = await probeOnce(account)
            sendJson(res, 200, { ok: result.ok, ...(result.error ? { error: result.error } : {}), account: describeAccount(readAccount(account.id)) })
            return
          }

          if (req.method === 'POST' && route === '/logout') {
            const account = currentAccount()
            if (account) removeAccount(account.id)
            clearBrowserProfile()
            sendJson(res, 200, { ok: true })
            return
          }

          if (req.method === 'GET' && route === '/models') {
            // ⚠️ 这个接口不需要鉴权 —— 没登录也把真实目录给出去，
            // 否则面板/模型选择器里只剩兜底的 2 个。
            try {
              const client = new MimoClient(getAuth() ?? {})
              const data = await client.fetchModelConfig()
              const list = (data?.modelConfigList ?? [])
                .filter((item) => item?.model && !item?.redirectTo)
                .map((item) => ({
                  id: String(item.model),
                  name: String(item.name ?? item.model),
                  description: String(item.cnIntro ?? ''),
                  thinkingDefaultOn: item.thinkingDefaultOn !== false,
                  contextTokens: item.nToken ?? '',
                  params: item.nParam ?? '',
                }))
              sendJson(res, 200, {
                models: list,
                enabled: settings.enabledModels,
              })
            } catch (error) {
              sendJson(res, 502, { models: [], error: String(error?.message ?? error) })
            }
            return
          }

          if (req.method === 'POST' && route === '/settings') {
            const body = await readJsonBody(req)
            if (!body || typeof body !== 'object') {
              sendJson(res, 400, { ok: false, error: '需要 JSON 对象' })
              return
            }
            const patch = {}
            for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
              if (body[key] === undefined) continue
              if (Array.isArray(fallback)) {
                if (Array.isArray(body[key])) patch[key] = body[key].filter((item) => typeof item === 'string')
                continue
              }
              if (typeof body[key] !== typeof fallback) {
                sendJson(res, 400, { ok: false, error: `${key} 类型不对（应为 ${typeof fallback}）` })
                return
              }
              patch[key] = body[key]
            }
            settings = writeSettings(patch)
            sendJson(res, 200, { ok: true, settings })
            return
          }

          if (req.method === 'GET' && route === '/settings') {
            sendJson(res, 200, { settings, defaults: DEFAULT_SETTINGS })
            return
          }

          /**
           * 冒烟测试：真的发一条最小请求，把原始 SSE 帧回显出来。
           * 面板上的「测试连通性」用它 —— 只读探活查不出"能登录但发不出消息"。
           */
          if (req.method === 'POST' && route === '/test') {
            const auth = getAuth()
            if (!auth) {
              sendJson(res, 400, { ok: false, error: '尚未登录' })
              return
            }
            const body = await readJsonBody(req)
            const model = String(body?.model ?? '').trim() || 'mimo-v2.6-flash'
            const prompt = String(body?.prompt ?? '').trim() || '用一句话回答：你好'
            const started = Date.now()
            const events = []
            let text = ''
            let reasoning = ''
            let usage
            let failure
            try {
              const client = new MimoClient(auth, { idleTimeoutMs: 120_000 })
              for await (const event of client.chat({
                msgId: Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32),
                conversationId: Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32),
                query: prompt,
                isEditedQuery: false,
                modelConfig: { enableThinking: settings.thinking !== false, webSearchStatus: 'disabled', model },
                multiMedias: [],
              })) {
                events.push(event.kind)
                if (event.kind === 'text') text += event.text
                if (event.kind === 'reasoning') reasoning += event.text
                if (event.kind === 'usage') usage = event.usage
                if (event.kind === 'error') failure = event.message
                if (events.length > 400) break
              }
            } catch (error) {
              noteCall({
                ok: false,
                purpose: 'test',
                ms: Date.now() - started,
                model,
                code: error?.code ?? 'TRANSPORT',
              })
              sendJson(res, 200, {
                ok: false,
                ms: Date.now() - started,
                error: String(error?.message ?? error),
                code: error?.code,
                events,
              })
              return
            }
            noteCall({
              ok: !failure && text.length > 0,
              purpose: 'test',
              ms: Date.now() - started,
              model,
              ...(usage?.prompt > 0 ? { inputTokens: usage.prompt } : {}),
              ...(usage?.completion > 0 ? { outputTokens: usage.completion } : {}),
              ...(failure ? { code: 'PROVIDER_ERROR' } : {}),
            })
            sendJson(res, 200, {
              ok: !failure && text.length > 0,
              ms: Date.now() - started,
              model,
              text: text.slice(0, 2000),
              reasoning: reasoning.slice(0, 1000),
              usage,
              ...(failure ? { error: failure } : {}),
              events: events.slice(0, 60),
            })
            return
          }

          sendJson(res, 404, { ok: false, error: `未知接口：${req.method} ${route}` })
        } catch (error) {
          if (error instanceof BodyError) {
            sendJson(res, 400, { ok: false, error: error.message })
            return
          }
          logger.warn?.(`mimo-web: 面板接口出错：${error?.message ?? error}`)
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }),
  )

  // ── 清理 ──────────────────────────────────────────────────────────────
  ctx.effect(
    () => () => {
      try {
        if (pendingLogin) {
          // 插件被卸载时别把浏览器窗口留在后台。
          loginProgress = { running: false, messages: [], startedAt: 0 }
        }
      } catch {
        /* 忽略 */
      }
    },
    'mimo-web-login: teardown',
  )
}

export { BodyError, readJsonBody }
