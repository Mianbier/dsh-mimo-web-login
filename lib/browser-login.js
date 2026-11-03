/**
 * 浏览器登录捕获。
 *
 * ## 为什么不是"点开一个窗口就完事"
 *
 * DSH 桌面端把插件跑在 Electron 的 **utility 进程**里，`require('electron')` 只暴露
 * `net` 与 `systemPreferences` —— `BrowserWindow` / `session` 是主进程专属 API，拿不到。
 * （DeepSeek 插件踩过这个坑：早期用 `session.fromPartition` 直接炸。）
 *
 * 所以这里准备了两条路，按能力探测自动选：
 *
 *   A. **Electron 主进程**（DSH 以主进程身份加载插件时）：自己开 BrowserWindow，
 *      用 `session.webRequest.onBeforeSendHeaders` 旁路读 Cookie。
 *   B. **系统 Edge / Chrome + CDP**（默认路径，也是桌面端的实际路径）：
 *      用 `--remote-debugging-port` 拉起一个**独立 profile** 的浏览器，
 *      用户在里面正常登录，登录完成后通过 CDP 的 `Storage.getCookies` 把
 *      serviceToken / userId / xiaomichatbot_ph 读回来。
 *
 * 两条路都**不碰用户日常浏览器的 cookie**（独立 profile / 独立分区），
 * 且都不改写业务请求 —— 只在登录那一刻读一次。
 *
 * @module lib/browser-login
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { storeDir } from './store.js'

// 直接落到对话页（#/c）—— 用户一进来就看见聊天界面，登录完成就是可用状态，
// 不会停在首页还要自己再点。MiMo 的 SPA 路由就是 hash 路由。
export const LOGIN_URL = 'https://aistudio.xiaomimimo.com/#/c'

/**
 * UltraSpeed 的独立入口。
 *
 * ultra 是另一个部署（`/fastchat` 前缀 + `ultraspeed_ph` cookie）。
 * 只打开 `#/c` 的话，浏览器永远不会种下 `ultraspeed_ph`，UltraSpeed 就用不了。
 */
export const ULTRA_LOGIN_URL = 'https://aistudio.xiaomimimo.com/#/ultra'
const ORIGIN = 'https://aistudio.xiaomimimo.com'

/**
 * 会话里必须凑齐的三个 cookie（少一个服务端就 401）。
 *
 * ⚠️ 名字是**从真实浏览器的 cookie 库里核对过的**，别想当然：
 *   .xiaomimimo.com  xiaomichatbot_serviceToken   ← 注意有 xiaomichatbot_ 前缀
 *   .xiaomimimo.com  userId
 *   .xiaomimimo.com  xiaomichatbot_ph
 * 早先按 `serviceToken` 去找，永远凑不齐，登录窗口只能干等到超时。
 */
export const REQUIRED_COOKIES = ['xiaomichatbot_serviceToken', 'userId', 'xiaomichatbot_ph']

/**
 * UltraSpeed 是**独立部署**，用自己的一套 `ph`。
 *
 * 从 SPA 源码里读出来的对应关系：
 *   `{production: "xiaomichatbot_ph", ultra: "ultraspeed_ph", "ultra-production": "ultraspeed_ph"}`
 * 它的接口前缀是 `/fastchat`，只提供 `bot/chat`（v2 协议）；
 * 用普通凭据去打会回「模型名称错误」或 401。
 *
 * 这是**可选**凭据：抓不到不影响普通模型，抓到了就能用 UltraSpeed。
 */
export const OPTIONAL_COOKIES = ['ultraspeed_ph']

/** 老版本/别的入口可能留下的别名，读到就归一成 REQUIRED_COOKIES 里的名字。 */
const COOKIE_ALIASES = {
  xiaomichatbot_serviceToken: ['serviceToken', 'mimo_serviceToken'],
}

/** 登录窗口的独立 profile —— 绝不碰用户日常浏览器的数据。 */
export function browserProfileDir() {
  return join(storeDir(), 'browser-profile')
}

function ensureProfile() {
  const dir = browserProfileDir()
  mkdirSync(dir, { recursive: true })
  return dir
}

const require_ = createRequire(import.meta.url)

/**
 * 能力探测：本进程能不能直接开 Electron 窗口。
 *
 * 三条缺一不可（只查 `process.versions.electron` 会假阳性 —— utility 进程里它也有值）：
 * ① 是 Electron 运行时；② 进程类型是主进程；③ `electron` 模块真的带 BrowserWindow/session。
 */
export function electronWindowAvailable() {
  if (!process.versions?.electron) return false
  if (process.type && process.type !== 'browser') return false
  try {
    const electron = require_('electron')
    if (!electron || typeof electron === 'string') return false
    return Boolean(electron.session && electron.BrowserWindow)
  } catch {
    return false
  }
}

/** 找系统里的 Edge / Chrome 可执行文件。 */
export function findSystemBrowser() {
  const candidates = []
  const env = process.env
  const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const localAppData = env['LOCALAPPDATA'] ?? ''

  if (process.platform === 'win32') {
    candidates.push(
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    )
    if (localAppData) {
      candidates.push(
        join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      )
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge')
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      /* 权限问题，继续找下一个 */
    }
  }
  return ''
}

/** 一个空闲的本地端口 —— 避免和用户已经开着的调试端口撞车。 */
async function freePort() {
  const { createServer } = await import('node:net')
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 统一的"用户取消了登录"错误。 */
function abortError() {
  const error = new Error('登录已被取消')
  error.name = 'AbortError'
  return error
}

/** 用最小 WebSocket 客户端连 CDP（Node 22+ 有全局 WebSocket）。 */
function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const pending = new Map()
    let nextId = 0
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = ++nextId
        pending.set(id, { res, rej })
        socket.send(JSON.stringify({ id, method, params }))
      })
    socket.addEventListener('open', () => resolve({ send, close: () => socket.close() }))
    socket.addEventListener('error', () => reject(new Error('无法连接浏览器的调试端口')))
    socket.addEventListener('message', (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      const entry = message.id !== undefined ? pending.get(message.id) : undefined
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.rej(new Error(message.error.message ?? 'CDP 调用失败'))
      else entry.res(message.result)
    })
  })
}

async function cdpHttp(port, path, init) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init)
  if (!response.ok) throw new Error(`CDP HTTP ${path} → ${response.status}`)
  return response.json()
}

/**
 * 路径 B：系统浏览器 + CDP。
 *
 * 流程：拉起带独立 profile 的浏览器 → 等调试端口起来 → 找到页面 target →
 * 轮询 `Storage.getCookies`，直到三个 cookie 都出现或超时。
 */
async function captureViaSystemBrowser({ onProgress, timeoutMs, keepOpen, signal }) {
  const browserPath = findSystemBrowser()
  if (!browserPath) {
    throw new Error(
      '找不到 Edge / Chrome。请安装 Microsoft Edge 或 Google Chrome 后再试，' +
        '或者用「手动粘贴 Cookie」那条路。',
    )
  }
  onProgress?.(`正在启动 ${browserPath.split(/[\\/]/).pop()} …`)

  const port = await freePort()
  const profile = ensureProfile()
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--new-window',
    LOGIN_URL,
    // 同时打开 UltraSpeed 页 —— 它用独立的 `ultraspeed_ph`，只有真访问过
    // `#/ultra` 浏览器才会种下那个 cookie。多开一个标签页就能一次登录拿全两套凭据。
    ULTRA_LOGIN_URL,
  ]
  const child = spawn(browserPath, args, { detached: false, stdio: 'ignore' })

  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    if (!keepOpen) {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
    }
  }
  child.once('exit', () => {
    closed = true
  })

  try {
    // 等调试端口活过来（浏览器冷启动可能要几秒）。
    let version
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        version = await cdpHttp(port, '/json/version')
        break
      } catch {
        await sleep(500)
      }
    }
    if (!version) throw new Error('浏览器启动了，但调试端口一直没响应（可能被安全软件拦了）')
    onProgress?.('浏览器已启动，请在窗口里完成登录 …')

    // 连到 browser 级别的 target 才能调 Storage.getCookies。
    const browserWs = version.webSocketDebuggerUrl
    if (!browserWs) throw new Error('浏览器没有提供调试 WebSocket 地址')
    const conn = await connectCdp(browserWs)

    const deadline = Date.now() + timeoutMs
    try {
      while (Date.now() < deadline) {
        // 用户可以中途取消（面板上点「取消登录」，或插件被卸载）。
        if (signal?.aborted) throw abortError()
        let result
        try {
          result = await conn.send('Storage.getCookies', { browserContextId: undefined })
        } catch {
          result = undefined
        }
        const cookies = result?.cookies ?? []
        const found = {}
        for (const cookie of cookies) {
          if (!cookie?.name) continue
          if (!cookie.domain?.includes('xiaomimimo.com')) continue
          // 可选凭据（ultraspeed_ph）也一起收 —— 抓不到不影响普通模型。
          if (OPTIONAL_COOKIES.includes(cookie.name)) {
            if (!found[cookie.name]) found[cookie.name] = cookie
            continue
          }
          // 主名优先；旧别名只在主名缺失时补位。
          if (REQUIRED_COOKIES.includes(cookie.name)) {
            if (!found[cookie.name]) found[cookie.name] = cookie
            continue
          }
          for (const canonical of REQUIRED_COOKIES) {
            const aliases = COOKIE_ALIASES[canonical] ?? []
            if (aliases.includes(cookie.name) && !found[canonical]) found[canonical] = cookie
          }
        }
        const complete = REQUIRED_COOKIES.every((name) => {
          const value = found[name]?.value
          return typeof value === 'string' && value.length > 0
        })
        if (complete) {
          return {
            serviceToken: found.xiaomichatbot_serviceToken.value,
            userId: found.userId.value,
            xiaomichatbotPh: found.xiaomichatbot_ph.value,
            // UltraSpeed 的独立凭据（可选，抓到就能用 ultra 模型）
            ...found.ultraspeed_ph?.value ? { ultraspeedPh: found.ultraspeed_ph.value } : {},
            via: 'system-browser',
            browser: browserPath,
            cookieMeta: [...REQUIRED_COOKIES, ...OPTIONAL_COOKIES]
              .filter((name) => found[name])
              .map((name) => ({
                name,
                session: found[name].session === true,
                expires: found[name].expires ?? -1,
              })),
          }
        }
        await sleep(1000)
      }
      throw new Error(
        `等了 ${Math.round(timeoutMs / 1000)} 秒还没读到登录态。` +
          '请确认窗口里已经**登录成功并看到了对话界面**（不是停在扫码/登录页）。',
      )
    } finally {
      conn.close()
    }
  } finally {
    cleanup()
    // 登录成功后把 profile 里的会话数据清掉 —— 只保留我们抓到的凭据，
    // 免得这台机器上留一份"永远登录着"的浏览器数据。
    if (!keepOpen) {
      try {
        rmSync(join(profile, 'Default', 'Cookies'), { force: true })
      } catch {
        /* 文件可能被占用，忽略 */
      }
    }
  }
}

/**
 * 路径 A：Electron 主进程自开窗口。
 *
 * 用 `webRequest.onBeforeSendHeaders` 读请求头里的 Cookie —— 与 DeepSeek 插件同一套做法，
 * 是在真实页面上下文里拿到"页面自己发出去的凭据"，比事后读 cookie 罐更接近授权真相。
 */
async function captureViaElectron({ onProgress, timeoutMs, signal }) {
  const electron = require_('electron')
  const { BrowserWindow, session } = electron

  const partition = `mimo-web-login-${Date.now()}`
  const ses = session.fromPartition(partition)
  const found = {}

  const collect = (cookieHeader) => {
    if (!cookieHeader) return
    for (const part of String(cookieHeader).split(';')) {
      const index = part.indexOf('=')
      if (index <= 0) continue
      const name = part.slice(0, index).trim()
      const value = part.slice(index + 1).trim()
      if (!value) continue
      if (REQUIRED_COOKIES.includes(name)) {
        if (!found[name]) found[name] = value
        continue
      }
      for (const canonical of REQUIRED_COOKIES) {
        const aliases = COOKIE_ALIASES[canonical] ?? []
        if (aliases.includes(name) && !found[canonical]) found[canonical] = value
      }
    }
  }

  ses.webRequest.onBeforeSendHeaders({ urls: [`${ORIGIN}/*`] }, (details, callback) => {
    const headers = details.requestHeaders ?? {}
    const cookieKey = Object.keys(headers).find((key) => key.toLowerCase() === 'cookie')
    if (cookieKey) collect(headers[cookieKey])
    // 顺手把 Electron 品牌从 UA 里抹掉 —— 站点会按 UA 判"使用环境异常"。
    const uaKey = Object.keys(headers).find((key) => key.toLowerCase() === 'user-agent')
    if (uaKey && /electron/i.test(String(headers[uaKey]))) {
      headers[uaKey] = String(headers[uaKey]).replace(/\s*Electron\/[\d.]+/i, '')
    }
    callback({ requestHeaders: headers })
  })

  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    title: '登录小米 MiMo（只需一次）',
    autoHideMenuBar: true,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false },
  })
  onProgress?.('窗口已打开，请完成登录 …')
  await win.loadURL(LOGIN_URL)

  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw abortError()
      if (win.isDestroyed()) throw new Error('登录窗口被关闭了')
      // 请求头里没凑齐时，退一步直接读 cookie 罐（同一个分区，拿得到 httpOnly）。
      if (!REQUIRED_COOKIES.every((name) => found[name])) {
        try {
          const jar = await ses.cookies.get({ domain: 'xiaomimimo.com' })
          for (const cookie of jar) {
            if (!cookie?.name || !cookie.value) continue
            if (REQUIRED_COOKIES.includes(cookie.name)) {
              if (!found[cookie.name]) found[cookie.name] = cookie.value
              continue
            }
            for (const canonical of REQUIRED_COOKIES) {
              const aliases = COOKIE_ALIASES[canonical] ?? []
              if (aliases.includes(cookie.name) && !found[canonical]) found[canonical] = cookie.value
            }
          }
        } catch {
          /* 继续轮询 */
        }
      }
      if (REQUIRED_COOKIES.every((name) => found[name])) {
        return {
          serviceToken: found.xiaomichatbot_serviceToken,
          userId: found.userId,
          xiaomichatbotPh: found.xiaomichatbot_ph,
          via: 'electron-window',
        }
      }
      await sleep(800)
    }
    throw new Error(`等了 ${Math.round(timeoutMs / 1000)} 秒还没读到登录态，请确认已经登录成功。`)
  } finally {
    try {
      if (!win.isDestroyed()) win.destroy()
    } catch {
      /* 已经关了 */
    }
    try {
      await ses.clearStorageData()
    } catch {
      /* 无所谓 */
    }
  }
}

/**
 * 打开登录窗口并捕获凭据。
 *
 * @param {object} options
 * @param {(message: string) => void} [options.onProgress]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.keepOpen] 登录成功后是否留着浏览器窗口（调试用）
 * @returns {Promise<{serviceToken: string, userId: string, xiaomichatbotPh: string, via: string}>}
 */
export async function captureLogin(options = {}) {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
  const onProgress = options.onProgress
  const keepOpen = options.keepOpen === true
  const signal = options.signal

  signal?.throwIfAborted()

  if (electronWindowAvailable()) {
    try {
      return await captureViaElectron({ onProgress, timeoutMs, signal })
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted) throw error
      // 主进程路线失败时退到系统浏览器 —— 比直接报错有用。
      onProgress?.(`Electron 窗口登录失败（${error?.message ?? error}），改用系统浏览器 …`)
    }
  }
  return await captureViaSystemBrowser({ onProgress, timeoutMs, keepOpen, signal })
}

/**
 * 清掉登录用的浏览器 profile。
 *
 * 「登录新账号」之前必须先清：否则窗口一打开就带着上一个账号的登录态，
 * 抓回来的还是它（DeepSeek 插件在这里踩过，专门写了注释）。
 */
export function clearBrowserProfile() {
  const dir = browserProfileDir()
  try {
    rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** 诊断信息：给面板显示"这台机器上能用哪条登录路径"。 */
export function loginCapabilities() {
  return {
    electronWindow: electronWindowAvailable(),
    systemBrowser: findSystemBrowser(),
    profileDir: browserProfileDir(),
    platform: process.platform,
  }
}
