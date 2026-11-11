/**
 * 发版前的 README 一致性检查 + 自动补版本号。
 *
 * 用法：
 *   node scripts/sync-readme.mjs          # 只检查，报错退出
 *   node scripts/sync-readme.mjs --write  # 把 README 里的旧版本号改成 package.json 的
 *
 * 为什么要有这个脚本：用户明确要求"每次版本更新都要更新 GitHub 介绍界面"。
 * 手动改容易忘，所以把它变成发版流程的一步。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const readmePath = path.join(root, 'README.md')
let readme = fs.readFileSync(readmePath, 'utf8')

const write = process.argv.includes('--write')
const problems = []
// ── 1. 版本号 ──────────────────────────────────────────────────────────
//
// ⚠️ **不能全文替换**：`## ✨ 最近更新` 里那些 `### v1.5.x — …` 是**历史记录**，
// 改了就把"哪个版本做了什么"抹掉了。只更新这几处真正的"当前版本"位置：
//   · badge 的 version-x.y.z
//   · `dsh-mimo-web-login-x.y.z.tgz` 文件名
//   · `最新版本` 之类的行内说明
const version = pkg.version

const currentVersionPatterns = [
  /(badge\/version-)(\d+\.\d+\.\d+)/g,
  /(dsh-mimo-web-login-)(\d+\.\d+\.\d+)(\.tgz)/g,
]
const staleSet = new Set()
for (const re of currentVersionPatterns) {
  for (const m of readme.matchAll(re)) {
    if (m[2] !== version) staleSet.add(m[2])
  }
}
const stale = [...staleSet]

if (stale.length > 0) {
  if (write) {
    for (const [re, repl] of [
      [/(badge\/version-)\d+\.\d+\.\d+/g, `$1${version}`],
      [/(dsh-mimo-web-login-)\d+\.\d+\.\d+(\.tgz)/g, `$1${version}$2`],
    ]) {
      readme = readme.replace(re, repl)
    }
    fs.writeFileSync(readmePath, readme, 'utf8')
    console.log(`✓ 已把 README 里的当前版本号 ${stale.join(', ')} 更新为 ${version}`)
  } else {
    problems.push(`README 里有旧版本号 ${stale.join(', ')}，当前 package.json 是 ${version}（加 --write 自动改）`)
  }
} else {
  console.log(`✓ 版本号一致：${version}`)
}

// 「最近更新」章节的第一条应该是当前版本
const firstRelease = readme.match(/### v(\d+\.\d+\.\d+) —/)
if (firstRelease && firstRelease[1] !== version) {
  problems.push(
    `「最近更新」的第一条是 v${firstRelease[1]}，但当前版本是 ${version} —— 发版时要在最前面加一条`,
  )
}

// ── 2. 测试数量 ────────────────────────────────────────────────────────
try {
  const testSrc = fs.readFileSync(path.join(root, 'test/offline.mjs'), 'utf8')
  const count = (testSrc.match(/^(await )?test(Async)?\('/gm) ?? []).length
  const claimed = readme.match(/\*\*(\d+) 项\*\*|(\d+) 项断言/)
  const said = claimed ? Number(claimed[1] ?? claimed[2]) : null
  if (said !== null && said !== count) {
    problems.push(`README 写「${said} 项断言」，但 offline.mjs 实际有 ${count} 个测试`)
  } else if (said !== null) {
    console.log(`✓ 测试数量一致：${count} 项`)
  }
} catch {
  problems.push('读不到 test/offline.mjs')
}

// ── 3. 默认配置值 ──────────────────────────────────────────────────────
try {
  const store = fs.readFileSync(path.join(root, 'lib/store.js'), 'utf8')
  const defaults = {}
  for (const m of store.matchAll(/^\s{2}(\w+):\s*([^,\n]+),/gm)) {
    defaults[m[1]] = m[2].trim()
  }
  // README 配置表里形如 `| `key` | `value` |`
  for (const m of readme.matchAll(/^\| `(\w+)` \| `([^`]+)` \|/gm)) {
    const [, key, claimed] = m
    if (!(key in defaults)) continue
    const actual = defaults[key].replace(/_/g, '_')
    const claim = claimed.replace(/`/g, '')
    // 数字容忍下划线写法差异
    const norm = (s) => String(s).replace(/[`'"_\s]/g, '')
    if (norm(actual) !== norm(claim)) {
      problems.push(`配置表 \`${key}\` 写的是 ${claimed}，代码默认是 ${actual}`)
    }
  }
  if (problems.length === 0) console.log('✓ 配置表默认值与代码一致')
} catch {
  problems.push('读不到 lib/store.js')
}

// ── 4. 必备章节 ────────────────────────────────────────────────────────
const required = ['## 这是什么', '## 快速开始', '## 安装', '## 核心能力', '## 已知限制', '## 测试']
const missing = required.filter((h) => !readme.includes(h))
if (missing.length > 0) problems.push(`README 缺章节：${missing.join(', ')}`)

// ── 汇总 ────────────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.error('\nREADME 与代码不一致：')
  for (const p of problems) console.error('  ✗ ' + p)
  process.exit(1)
}
console.log('\nREADME 检查通过 ✓')
