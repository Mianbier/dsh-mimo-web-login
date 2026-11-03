/**
 * 凭据库：多账号并存、当前账号指针、登录态寿命记录。
 *
 * 落盘位置：`${DSH_HOME:-~/.dsh}/mimo-web/`
 *   accounts.json   账号库（含 serviceToken 明文 —— 与 DeepSeek 插件一致，只在本机）
 *   active.json     当前账号 id
 *   settings.json   面板设置
 *
 * 为什么不做加密：加密就要管密钥，而密钥同样躺在这台机器的同一个目录里，
 * 只是多一层"看起来安全"的包装。真要防，防的是磁盘，不是文件本身。
 *
 * @module lib/store
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** MiMo 的 serviceToken 寿命实测约 24 小时，这里按"抓到后多久开始提示过期"来用。 */
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

export function dshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

export function storeDir() {
  return join(dshHome(), 'mimo-web')
}

function ensureDir() {
  const dir = storeDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** 先写临时文件再 rename —— 写到一半断电不会把账号库写成半截 JSON。 */
function writeJson(file, value) {
  ensureDir()
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

function accountsFile() {
  return join(storeDir(), 'accounts.json')
}
function activeFile() {
  return join(storeDir(), 'active.json')
}
function settingsFile() {
  return join(storeDir(), 'settings.json')
}

/**
 * 一条账号记录。
 * @typedef {object} AccountRecord
 * @property {string} id            本地 id（随机，不用 userId —— 换号后同一个 userId 会有多份）
 * @property {string} serviceToken
 * @property {string} userId
 * @property {string} xiaomichatbotPh
 * @property {string} [displayName] 网页端返回的昵称（掩码后的）
 * @property {string} [capturedAt]  ISO 时间
 * @property {string} [verifiedAt]  最近一次探活通过的时间
 * @property {{at: string, message: string}} [lastError] 最近一次失效原因
 * @property {string} [note]
 */

export function listAccounts() {
  const raw = readJson(accountsFile(), { accounts: [] })
  const list = Array.isArray(raw) ? raw : raw?.accounts
  if (!Array.isArray(list)) return []
  return list.filter((item) => item && typeof item.id === 'string' && item.serviceToken)
}

export function readAccount(id) {
  if (!id) return undefined
  return listAccounts().find((item) => item.id === id)
}

export function writeAccounts(accounts) {
  writeJson(accountsFile(), { version: 1, accounts })
}

export function activeAccountId() {
  const raw = readJson(activeFile(), {})
  return typeof raw?.id === 'string' ? raw.id : ''
}

export function setActiveAccountId(id) {
  if (!id) {
    try {
      rmSync(activeFile(), { force: true })
    } catch {
      /* ignore */
    }
    return ''
  }
  writeJson(activeFile(), { id })
  return id
}

/**
 * 当前生效的账号：优先 active.json 指的那个；它没了就退到库里第一个。
 * 库里空着就返回 undefined（适配器据此报 MISSING_CREDENTIAL）。
 */
export function currentAccount() {
  const accounts = listAccounts()
  if (accounts.length === 0) return undefined
  const id = activeAccountId()
  return accounts.find((item) => item.id === id) ?? accounts[0]
}

/**
 * 清掉凭据值外面多包的一层引号。
 *
 * 事故背景：CDP 的 `Storage.getCookies` 偶尔返回被 JSON 序列化过的值
 * （`"/vjQa88…JU="` 首尾带 ASCII 双引号）。`whoami` 不校验这个，
 * 但 `react/chat` 会把它拼进 followup 校验 —— 带着引号就是 401，
 * 去掉引号立刻 200。所以在**入口**统一洗，而不是指望每个调用点都记得洗。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeCookieValue(value) {
  let text = String(value ?? '').trim()
  // 可能被 encode 过一层（%22 / %2522），先把明显的转义还原
  for (let round = 0; round < 2; round += 1) {
    if (/%22/i.test(text) && !/"/.test(text)) {
      try {
        text = decodeURIComponent(text)
      } catch {
        /* 解不开就保持原样 */
      }
    }
    if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
      text = text.slice(1, -1)
      continue
    }
    break
  }
  return text.trim()
}

/**
 * 新增或更新一条账号。
 *
 * 去重键是 `(userId, serviceToken 前 16 位)`：同一个账号重复登录（token 换了）
 * 应该**原地更新**那条记录，而不是堆出一串同名账号；但同一个 userId 的不同 token
 * 有可能是用户的两个号（极少见），所以不拿 userId 单独当键。
 */
export function upsertAccount(auth, patch = {}) {
  const accounts = listAccounts()
  // 入库前统一洗掉外层引号 —— 带着引号的 token 发出去必然 401。
  const clean = {
    serviceToken: normalizeCookieValue(auth.serviceToken),
    userId: normalizeCookieValue(auth.userId),
    xiaomichatbotPh: normalizeCookieValue(auth.xiaomichatbotPh),
    // UltraSpeed 的独立 ph（可选）—— 有它就能用 ultra 模型。
    ...auth.ultraspeedPh ? { ultraspeedPh: normalizeCookieValue(auth.ultraspeedPh) } : {},
  }
  const prefix = clean.serviceToken.slice(0, 16)
  const existing =
    accounts.find((item) => item.userId === clean.userId && item.serviceToken.startsWith(prefix)) ??
    accounts.find((item) => item.userId === clean.userId)

  const now = new Date().toISOString()
  if (existing) {
    const next = {
      ...existing,
      ...clean,
      capturedAt: now,
      lastError: undefined,
      ...patch,
    }
    writeAccounts(accounts.map((item) => (item.id === existing.id ? next : item)))
    return next
  }

  const record = {
    id: randomUUID(),
    ...clean,
    capturedAt: now,
    ...patch,
  }
  writeAccounts([...accounts, record])
  return record
}

export function updateAccount(id, patch) {
  const accounts = listAccounts()
  const index = accounts.findIndex((item) => item.id === id)
  if (index < 0) return undefined
  const next = { ...accounts[index], ...patch }
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
  const updated = accounts.slice()
  updated[index] = next
  writeAccounts(updated)
  return next
}

export function removeAccount(id) {
  const accounts = listAccounts()
  const kept = accounts.filter((item) => item.id !== id)
  writeAccounts(kept)
  if (activeAccountId() === id) {
    if (kept[0]) setActiveAccountId(kept[0].id)
    else setActiveAccountId('')
  }
  return kept.length !== accounts.length
}

/** 登录态已经用了多久（毫秒）；没记录捕获时间就返回 undefined。 */
export function tokenAgeMs(record) {
  if (!record?.capturedAt) return undefined
  const at = Date.parse(record.capturedAt)
  if (!Number.isFinite(at)) return undefined
  return Date.now() - at
}

/**
 * 面板上显示的一句话状态。
 *
 * ⚠️ **不再按"捕获超过 24 小时"推断过期**。
 *
 * 曾经这里写着 `stale = age > 24h`，依据是"serviceToken 通常 24 小时过期"。
 * 但真机上是**错的**：账号连续用几天都好好的，Cookie 实际寿命由服务端决定，
 * 客户端猜不准。结果是面板天天红着喊「可能已过期」，用户被迫反复重登 ——
 * 而重登根本没解决问题（本来就没坏）。
 *
 * 现在的判定只有一条：**只有真实请求返回 401 才标记失效**
 * （由适配器在收到 AUTH 错误时写 `lastError`）。面板只展示"用了多久"，纯信息。
 */
export function describeAccount(record) {
  if (!record) return { loggedIn: false }
  const age = tokenAgeMs(record)
  return {
    loggedIn: true,
    id: record.id,
    displayName: record.displayName ?? `id:${String(record.userId).slice(0, 4)}***`,
    userId: record.userId,
    capturedAt: record.capturedAt,
    verifiedAt: record.verifiedAt,
    note: record.note,
    tokenLength: record.serviceToken.length,
    ageMs: age,
    /** 恒为 false：过期只由服务端 401 判定（见 `lastError`）。字段保留是为了面板兼容。 */
    stale: false,
    lastError: record.lastError,
  }
}

// ── 设置 ────────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS = Object.freeze({
  /** 思考模式默认开还是关（模型本身另有 thinkingDefaultOn，这里只是初始档）。 */
  thinking: true,
  /** 网页搜索：disabled / auto / enabled */
  webSearch: 'disabled',
  /** 一次请求最多带多少张图（网页端对 multiMedias 有条数上限）。 */
  maxImages: 12,
  /**
   * 单次请求 prompt 字符上限 —— 兼作风控阀门。
   *
   * 与 `contextWindow` 匹配：1M token 大约是 200 万~400 万字符，
   * 取 800K 字符既能装下长上下文，又不会把单次请求撑到服务端直接拒。
   */
  maxPromptChars: 800_000,
  /**
   * 上游声明给 DSH 的上下文窗口。
   *
   * 1M：拿真机核对过 —— `bot/config` 里 chat 模型的 `nToken` 就是 `"1M"`。
   */
  contextWindow: 1_048_576,
  /** 两次请求之间的最小间隔（毫秒），0 = 不等待。 */
  minIntervalMs: 1200,
  /** 流空闲超时。 */
  idleTimeoutMs: 180_000,
  /**
   * 是否允许同一账号并发。
   *
   * **默认开启**：真机实测 MiMo 网页端接受同账号并发（同时发两条，两条都
   * 正常返回、无报错、总耗时 ≈ 单条，不是串行累加）。关掉会导致
   * "两个窗口不能同时发消息" —— 那是我们自己排的队，不是服务端限制。
   */
  allowConcurrent: true,
  /**
   * 登录态探活间隔（毫秒），0 = 关闭。
   *
   * 默认关闭：探活会周期性打 whoami，对"能不能用"没帮助，却增加了被风控注意的
   * 请求量。设置页可以随时打开。
   */
  probeIntervalMs: 0,
  /**
   * 是否在网页端留下会话记录（默认开）。
   *
   * 只发 `react/chat` 不打 `conversation/save` 的话，消息能正常对话，
   * 但网页端左侧历史栏里**看不到**这条会话 —— 用户会以为插件没工作。
   * 打开这个开关才能在官网上翻到记录；不想要污染历史就关掉。
   */
  saveConversationHistory: true,
  /** 模型白名单（空 = 全部）。 */
  enabledModels: [],

  // ── 语音（给 Aurabot 的本地接口脚本读）────────────────────────────────
  //
  // 这两个字段是**跨插件**的设置：dsh-mimo-web-login 负责存，Aurabot 的
  // `local/tts.mjs` 通过读本设置文件拿到音色。这样音色能在面板里选，
  // 不用手改脚本（手改的坏处是换台机器/重装就丢）。
  /** MiMo TTS 音色 id。见 `TTS_VOICES`。 */
  ttsVoice: 'Chloe',
  /** 风格指令（对应请求里的 content.messages[0]），空 = 用脚本内置默认。 */
  ttsStyle: '',
})

/**
 * MiMo 官方音色清单（来自 `bot/config` 的 `ttsVoices`，8 个）。
 *
 * `id` 是**发给服务端的值**（英文直接给英文名，中文直接给中文名 —— 都验证过）；
 * `desc` 是官网原文描述。
 */
export const TTS_VOICES = Object.freeze([
  { id: 'Chloe', label: 'Chloe', desc: 'Sweet Dreamy · 甜美梦幻' },
  { id: '冰糖', label: '冰糖', desc: '活泼少女' },
  { id: '茉莉', label: '茉莉', desc: '知性女声' },
  { id: 'Mia', label: 'Mia', desc: 'Lively girl · 活泼女孩' },
  { id: '苏打', label: '苏打', desc: '阳光少年' },
  { id: 'Milo', label: 'Milo', desc: 'Sunny boy · 阳光男孩' },
])

export function readSettings() {
  const raw = readJson(settingsFile(), {})
  const merged = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (raw && raw[key] !== undefined && typeof raw[key] === typeof DEFAULT_SETTINGS[key]) merged[key] = raw[key]
  }
  if (Array.isArray(raw?.enabledModels)) merged.enabledModels = raw.enabledModels.filter((x) => typeof x === 'string')
  return merged
}

export function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }
  writeJson(settingsFile(), next)
  return next
}

/** 数据目录里有哪些文件（面板「数据位置」用）。 */
export function storeListing() {
  try {
    const dir = storeDir()
    return readdirSync(dir).map((name) => ({ name, path: join(dir, name) }))
  } catch {
    return []
  }
}
