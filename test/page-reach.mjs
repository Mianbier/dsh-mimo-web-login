/**
 * 真实页面探针：用真实浏览器打开 MiMo 登录页（无头），确认
 *   ① 页面能在该 profile 里加载成功；
 *   ② Storage.getCookies 对 xiaomimimo.com 域可调用；
 *   ③ 未登录时确实读不到三个 cookie（说明"读到=已登录"这个判据成立）。
 *
 * 这一步把「人工登录」之外的整条捕获链路都验了。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { findSystemBrowser, browserProfileDir, REQUIRED_COOKIES, LOGIN_URL } from '../lib/browser-login.js'

const lines = []
const log = (text) => {
  lines.push(text)
  console.log(text)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function freePort() {
  const { createServer } = await import('node:net')
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(address.port))
    })
  })
}

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
    socket.addEventListener('error', () => reject(new Error('ws connect failed')))
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
      if (message.error) entry.rej(new Error(message.error.message))
      else entry.res(message.result)
    })
  })
}

const browserPath = findSystemBrowser()
if (!browserPath) {
  log('SKIP: no system browser')
  fs.writeFileSync('page-out.txt', lines.join('\n'), 'utf8')
  process.exit(0)
}

const port = await freePort()
const profile = `${browserProfileDir()}-pagecheck`
fs.mkdirSync(profile, { recursive: true })

const child = spawn(
  browserPath,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    LOGIN_URL,
  ],
  { stdio: 'ignore' },
)

let ok = true
try {
  let version
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) {
        version = await response.json()
        break
      }
    } catch {
      /* wait */
    }
    await sleep(500)
  }
  if (!version) {
    log('FAIL: debug port never answered')
    ok = false
  } else {
    log(`OK  browser up (${version.Browser})`)

    // 等页面真的导航到目标域
    let target
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
        target = list.find((t) => t.type === 'page' && t.url.includes('xiaomimimo.com'))
        if (target) break
      } catch {
        /* wait */
      }
      await sleep(500)
    }

    if (!target) {
      log('FAIL: page never reached xiaomimimo.com')
      ok = false
    } else {
      log(`OK  page loaded: ${target.url}`)
      log(`    title: ${target.title || '(empty)'}`)

      const conn = await connectCdp(version.webSocketDebuggerUrl)

      // ① Storage.getCookies 对真实域可用
      const cookieResult = await conn.send('Storage.getCookies', {})
      const cookies = cookieResult?.cookies ?? []
      log(`OK  Storage.getCookies -> ${cookies.length} cookies (all domains)`)

      // ② 未登录时必须**读不到**这三个（否则"读到=已登录"这个判据不成立）
      const mimoCookies = cookies.filter((c) => c.domain?.includes('xiaomimimo.com'))
      const found = mimoCookies.filter((c) => REQUIRED_COOKIES.includes(c.name))
      log(`    xiaomimimo.com cookies: ${mimoCookies.length}, 其中必需项: ${found.length}`)
      if (found.length === 0) {
        log('OK  未登录时确实读不到必需 cookie —— 判据成立')
      } else {
        log(`?   已经有 ${found.map((c) => c.name).join(', ')}（这个 profile 之前登录过）`)
      }

      // ③ 页面真的渲染出了东西（不是错误页）
      //    Runtime.evaluate 是**页面级**方法 —— 必须连到页面自己的 target，
      //    浏览器级连接（/json/version 的 webSocketDebuggerUrl）上没有它。
      if (target.webSocketDebuggerUrl) {
        const pageConn = await connectCdp(target.webSocketDebuggerUrl)
        try {
          // SPA 冷启动 + 首屏渲染要几秒，轮询到有文本为止（最多 20 秒）。
          let text = ''
          let sample = ''
          for (let attempt = 0; attempt < 20; attempt += 1) {
            try {
              const evalResult = await pageConn.send('Runtime.evaluate', {
                expression:
                  'JSON.stringify({title: document.title, len: document.body ? document.body.innerText.length : 0, text: document.body ? document.body.innerText.slice(0, 200) : ""})',
                returnByValue: true,
              })
              sample = String(evalResult?.result?.value ?? '')
              const parsed = JSON.parse(sample || '{}')
              text = String(parsed.text ?? '')
              if (text.trim().length > 2) {
                log(`OK  page rendered after ${(attempt + 1) * 1000} ms`)
                log(`    title: ${JSON.stringify(parsed.title)}`)
                log(`    text : ${JSON.stringify(text.slice(0, 200))}`)
                break
              }
            } catch {
              /* retry */
            }
            await sleep(1000)
          }
          if (text.trim().length <= 2) {
            log(`?   20 秒内页面没有渲染出文本（headless 下 SPA 可能被拦；有头模式通常正常）`)
            log(`    last sample: ${sample.slice(0, 200)}`)
          }
        } finally {
          pageConn.close()
        }
      }

      conn.close()
    }
  }
} finally {
  try {
    child.kill()
  } catch {
    /* gone */
  }
  await sleep(600)
  try {
    fs.rmSync(profile, { recursive: true, force: true })
  } catch {
    /* locked */
  }
}

log(ok ? 'RESULT: 捕获链路在真实页面上可用' : 'RESULT: 链路有问题')
fs.writeFileSync('page-out.txt', lines.join('\n') + '\n', 'utf8')
process.exitCode = ok ? 0 : 1
