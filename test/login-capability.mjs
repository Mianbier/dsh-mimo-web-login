/**
 * Login-path probe (ASCII output only, to avoid Windows console codepage issues).
 * Verifies which capture route works on this machine without opening a window.
 */

import { loginCapabilities, browserProfileDir, LOGIN_URL } from '../lib/browser-login.js'
import fs from 'node:fs'

const caps = loginCapabilities()
const lines = []
lines.push(`platform        : ${caps.platform}`)
lines.push(`electron-window : ${caps.electronWindow}`)
lines.push(`system-browser  : ${caps.systemBrowser || '(not found)'}`)
lines.push(`login-url       : ${LOGIN_URL}`)
lines.push(`profile-dir     : ${browserProfileDir()}`)

if (caps.systemBrowser) {
  const stat = fs.statSync(caps.systemBrowser)
  lines.push(`browser-size    : ${stat.size} bytes`)
  lines.push('RESULT          : OK - system browser CDP route available')
} else if (caps.electronWindow) {
  lines.push('RESULT          : OK - electron window route available')
} else {
  lines.push('RESULT          : FAIL - neither route available')
  process.exitCode = 1
}

try {
  fs.mkdirSync(browserProfileDir(), { recursive: true })
  const probe = `${browserProfileDir()}/.write-probe`
  fs.writeFileSync(probe, 'ok')
  fs.rmSync(probe)
  lines.push('profile-writable: yes')
} catch (error) {
  lines.push(`profile-writable: NO (${error.message})`)
  process.exitCode = 1
}

fs.writeFileSync('caps-out.txt', lines.join('\n') + '\n', 'utf8')
console.log(lines.join('\n'))
