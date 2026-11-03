/**
 * 调用台账：按天记录每次调用的元信息（不含任何对话内容与凭据）。
 *
 * 为什么要它：面板上「最近一次调用 / 今天几次 / token 用量 / 失败分类」这些数字，
 * 只能靠真实调用累计出来，没法从服务端查（网页端不返回准确计数）。
 *
 * 只留近 7 天，只记元信息。
 *
 * @module lib/usage
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { storeDir } from './store.js'

const KEEP_DAYS = 7

function usageDir() {
  return join(storeDir(), 'usage')
}

function dayFile(date = new Date()) {
  const stamp = date.toISOString().slice(0, 10)
  return join(usageDir(), `${stamp}.jsonl`)
}

/** 记一次调用。字段刻意保持扁平、可 JSON 化（DSH 会话事件拒收 NaN/undefined）。 */
export function noteCall(entry) {
  try {
    mkdirSync(usageDir(), { recursive: true })
    const record = {
      at: Date.now(),
      ok: entry.ok === true,
      purpose: String(entry.purpose ?? 'chat'),
      ms: Number.isFinite(entry.ms) ? Math.round(entry.ms) : 0,
      model: String(entry.model ?? ''),
      ...(Number.isFinite(entry.inputTokens) ? { inputTokens: Math.round(entry.inputTokens) } : {}),
      ...(Number.isFinite(entry.outputTokens) ? { outputTokens: Math.round(entry.outputTokens) } : {}),
      ...(entry.code ? { code: String(entry.code) } : {}),
      ...(entry.thinking === true ? { thinking: true } : {}),
      ...(entry.toolCalls > 0 ? { toolCalls: entry.toolCalls } : {}),
    }
    appendFileSync(dayFile(), JSON.stringify(record) + '\n', 'utf8')
    pruneOldDays()
  } catch {
    /* 记账失败不该影响请求本身 */
  }
}

function pruneOldDays() {
  try {
    const dir = usageDir()
    if (!existsSync(dir)) return
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400 * 1000).toISOString().slice(0, 10)
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      if (name.slice(0, 10) < cutoff) {
        try {
          rmSync(join(dir, name), { force: true })
        } catch {
          /* 占着就下次 */
        }
      }
    }
  } catch {
    /* ignore */
  }
}

function readDay(date) {
  const file = dayFile(date)
  if (!existsSync(file)) return []
  const out = []
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line)
        if (record && typeof record === 'object') out.push(record)
      } catch {
        /* 跳过坏行 */
      }
    }
  } catch {
    /* ignore */
  }
  return out
}

/** 清空全部台账（面板「清空台账」按钮）。 */
export function resetUsage() {
  try {
    const dir = usageDir()
    if (!existsSync(dir)) return true
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      try {
        rmSync(join(dir, name), { force: true })
      } catch {
        /* 占着就跳过 */
      }
    }
    return true
  } catch {
    return false
  }
}

/**
 * 汇总面板要显示的数字。
 *
 * @returns {{today: object, recent: object[], byDay: object[], total: object}}
 */
export function summarize() {
  const today = new Date()
  const records = []
  const byDay = []
  for (let offset = 0; offset < KEEP_DAYS; offset += 1) {
    const date = new Date(today.getTime() - offset * 86400 * 1000)
    const dayRecords = readDay(date)
    records.push(...dayRecords)
    byDay.push({
      date: date.toISOString().slice(0, 10),
      calls: dayRecords.length,
      ok: dayRecords.filter((item) => item.ok).length,
      inputTokens: dayRecords.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0),
      outputTokens: dayRecords.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0),
    })
  }

  const todayRecords = byDay[0] ? readDay(today) : []
  const failures = records.filter((item) => !item.ok)
  const failureByCode = {}
  for (const item of failures) {
    const code = item.code ?? 'UNKNOWN'
    failureByCode[code] = (failureByCode[code] ?? 0) + 1
  }

  // 相邻对话间隔（只统计 chat，辅助调用会污染分布）
  const chatCalls = records.filter((item) => item.purpose === 'chat').sort((a, b) => a.at - b.at)
  const gaps = []
  for (let index = 1; index < chatCalls.length; index += 1) {
    const gap = chatCalls[index].at - chatCalls[index - 1].at
    if (gap > 0 && gap < 3600 * 1000) gaps.push(gap)
  }
  gaps.sort((a, b) => a - b)
  const percentile = (list, ratio) =>
    list.length === 0 ? 0 : list[Math.min(list.length - 1, Math.floor(list.length * ratio))]

  return {
    today: {
      calls: todayRecords.length,
      ok: todayRecords.filter((item) => item.ok).length,
      inputTokens: todayRecords.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0),
      outputTokens: todayRecords.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0),
    },
    recent: records.sort((a, b) => b.at - a.at).slice(0, 20),
    byDay: byDay.filter((day) => day.calls > 0),
    total: {
      calls: records.length,
      ok: records.filter((item) => item.ok).length,
      failures: failures.length,
      failureByCode,
      medianGapMs: percentile(gaps, 0.5),
      p90GapMs: percentile(gaps, 0.9),
      minGapMs: gaps.length > 0 ? gaps[0] : 0,
      toolCalls: records.reduce((sum, item) => sum + (item.toolCalls ?? 0), 0),
    },
  }
}
