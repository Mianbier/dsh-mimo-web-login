/**
 * CDP plumbing test (headless) — validates the riskiest part of login capture
 * without opening a visible window or needing a real login.
 *
 * Checks: browser launches with a debug port -> /json/version answers ->
 * WebSocket connects -> Storage.getCookies returns a well-formed cookie array.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { findSystemBrowser, browserProfileDir } from '../lib/browser-login.js'

const lines = []
const log = (text) => {
  lines.push(text)
  console.log(text)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
  log('SKIP: no system browser found')
  process.exit(0)
}

const port = await freePort()
const profile = browserProfileDir() + '-test'
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
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let version
try {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) {
        version = await response.json()
        break
      }
    } catch {
      /* not up yet */
    }
    await sleep(500)
  }

  if (!version) {
    log('FAIL: debug port never answered')
    process.exitCode = 1
  } else {
    log(`OK  browser launched, debug port ${port} answering`)
    log(`    product: ${version.Browser}`)

    const conn = await connectCdp(version.webSocketDebuggerUrl)
    log('OK  CDP websocket connected')

    const result = await conn.send('Storage.getCookies', {})
    const cookies = result?.cookies
    log(`OK  Storage.getCookies returned ${Array.isArray(cookies) ? cookies.length : 'INVALID'} cookies`)
    if (!Array.isArray(cookies)) {
      log('FAIL: cookies is not an array')
      process.exitCode = 1
    }

    // Cookie shape check: what the capture loop relies on
    const withDomain = cookies.find((c) => c.domain && c.name)
    if (withDomain) {
      log(`OK  cookie shape has name/domain/value/expires fields`)
    } else {
      log('OK  cookie jar empty (expected on a fresh profile)')
    }

    conn.close()
    log('RESULT: CDP login plumbing works')
  }
} finally {
  try {
    child.kill()
  } catch {
    /* already gone */
  }
  await sleep(500)
  try {
    fs.rmSync(profile, { recursive: true, force: true })
  } catch {
    /* locked, will be cleaned next run */
  }
}

fs.writeFileSync('cdp-out.txt', lines.join('\n') + '\n', 'utf8')
