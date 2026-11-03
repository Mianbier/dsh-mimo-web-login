window.__ModuleLoader__.load({
  id: 'dsh-mimo-web-login',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useMemo } = React

    const API = '/mimo-web-login/api'

    const CSS = `
[data-mw]{display:flex;flex-direction:column;gap:12px;max-width:760px;padding:2px 2px 10px;font-size:13px;}
[data-mw-h]{font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-mw-note]{font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-mw-tabs]{display:flex;gap:4px;flex-wrap:wrap;padding:4px;border-radius:9px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.10));}
[data-mw-tab]{padding:6px 12px;border-radius:7px;font-size:12px;cursor:pointer;font-family:inherit;
  border:none;background:transparent;color:inherit;opacity:.72;}
[data-mw-tab]:hover{opacity:1;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));}
[data-mw-tab][data-on]{background:var(--dsw-alias-bg-base,rgba(255,255,255,.12));opacity:1;font-weight:600;}
[data-mw-card]{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:10px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.10));
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.10));}
[data-mw-card-title]{font-size:12px;font-weight:600;margin-bottom:2px;}
[data-mw-row]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-mw-kv]{display:flex;align-items:center;gap:8px;font-size:12px;line-height:20px;}
[data-mw-k]{flex:none;min-width:112px;color:var(--dsw-alias-label-secondary,#b6bcc4);font-size:11px;}
[data-mw-v]{flex:1;min-width:0;word-break:break-all;}
[data-mw-ok]{color:#34d399;flex:none;}
[data-mw-no]{color:#f87171;flex:none;}
[data-mw-mute]{color:var(--dsw-alias-label-tertiary,#9aa0a6);flex:none;}
[data-mw-btn]{padding:6px 13px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:transparent;color:inherit;}
[data-mw-btn]:hover{background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.18));}
[data-mw-btn][disabled]{opacity:.45;cursor:default;}
[data-mw-btn][data-primary]{background:#ff6900;border-color:#ff6900;color:#fff;}
[data-mw-btn][data-primary]:hover{background:#e85f00;}
[data-mw-btn][data-danger]{color:#f87171;border-color:rgba(248,113,113,.35);}
[data-mw-btn][data-sm]{padding:4px 9px;font-size:11px;}
[data-mw-input]{flex:1;min-width:0;padding:7px 9px;border-radius:8px;font-size:12px;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;}
[data-mw-pill]{font-size:10px;padding:2px 7px;border-radius:999px;border:1px solid currentColor;flex:none;}
[data-mw-pill][data-good]{color:#34d399;}
[data-mw-pill][data-warn]{color:#fbbf24;}
[data-mw-pill][data-bad]{color:#f87171;}
[data-mw-msg]{font-size:11px;line-height:17px;padding:8px 10px;border-radius:8px;white-space:pre-wrap;
  word-break:break-word;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));}
[data-mw-msg][data-good]{color:#34d399;}
[data-mw-msg][data-warn]{color:#fbbf24;}
[data-mw-msg][data-bad]{color:#f87171;}
[data-mw-log]{font-size:11px;line-height:16px;max-height:170px;overflow:auto;padding:8px;border-radius:8px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;
  background:rgba(0,0,0,.22);color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-mw-acc]{display:flex;flex-direction:column;gap:5px;padding:9px 11px;border-radius:9px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.08));border:1px solid transparent;}
[data-mw-acc][data-current]{border-color:rgba(255,105,0,.55);}
[data-mw-model]{display:flex;flex-direction:column;gap:2px;padding:7px 9px;border-radius:7px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.07));}
[data-mw-mono]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;}
[data-mw-grid]{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:8px;}
[data-mw-stat]{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border-radius:8px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.08));}
[data-mw-stat-n]{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums;}
[data-mw-stat-l]{font-size:10px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-mw-table]{display:flex;flex-direction:column;gap:3px;font-size:11px;}
[data-mw-tr]{display:grid;grid-template-columns:64px 1fr 64px 54px;gap:8px;padding:4px 6px;border-radius:6px;}
[data-mw-tr][data-head]{color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:10px;font-weight:600;}
[data-mw-tr]:not([data-head]):nth-child(even){background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));}
[data-mw-bar]{height:4px;border-radius:2px;background:rgba(255,105,0,.7);}
[data-mw-warnbox]{display:flex;gap:8px;padding:9px 11px;border-radius:9px;font-size:11px;line-height:17px;
  background:rgba(251,191,36,.10);border:1px solid rgba(251,191,36,.32);color:#fbbf24;}
[data-mw-riskbox]{display:flex;gap:8px;padding:9px 11px;border-radius:9px;font-size:11px;line-height:17px;
  background:rgba(248,113,113,.09);border:1px solid rgba(248,113,113,.30);color:#fca5a5;}
`

    const jfetch = async (path, init) => {
      const res = await fetch(API + path, init)
      let data
      try {
        data = await res.json()
      } catch {
        data = { ok: false, error: `HTTP ${res.status}` }
      }
      return data
    }
    const jget = (path) => jfetch(path)
    const jpost = (path, body) =>
      jfetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })

    const fmtTime = (iso) => {
      if (!iso) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      const diff = Date.now() - date.getTime()
      const mins = Math.floor(diff / 60000)
      if (mins < 1) return '刚刚'
      if (mins < 60) return `${mins} 分钟前`
      const hours = Math.floor(mins / 60)
      if (hours < 24) return `${hours} 小时前`
      const days = Math.floor(hours / 24)
      return days < 30 ? `${days} 天前` : date.toLocaleDateString()
    }

    const fmtDuration = (ms) => {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      const hours = Math.floor(ms / 3600000)
      const mins = Math.floor((ms % 3600000) / 60000)
      if (hours >= 24) return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`
      if (hours > 0) return `${hours} 小时 ${mins} 分`
      return `${mins} 分钟`
    }

    const fmtNum = (n) => {
      if (!Number.isFinite(n) || n <= 0) return '0'
      if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`
      if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`
      return String(Math.round(n))
    }

    /** 一行「✓ 某状态」——DeepSeek 面板那种诊断行的样式。 */
    function Check({ ok, label, value, tone }) {
      const mark = ok === true ? '✓' : ok === false ? '✗' : '·'
      const attr = ok === true ? { 'data-mw-ok': '' } : ok === false ? { 'data-mw-no': '' } : { 'data-mw-mute': '' }
      return h(
        'div',
        { 'data-mw-kv': '' },
        h('span', { ...attr, style: { width: 12, display: 'inline-block' } }, mark),
        h('span', { 'data-mw-k': '' }, label),
        h('span', { 'data-mw-v': '', ...(tone ? { style: { color: tone } } : {}) }, value),
      )
    }

    function Stat({ n, l }) {
      return h('div', { 'data-mw-stat': '' }, h('div', { 'data-mw-stat-n': '' }, n), h('div', { 'data-mw-stat-l': '' }, l))
    }

    function Pill({ tone, children }) {
      return h('span', { 'data-mw-pill': '', ...(tone ? { [`data-${tone}`]: '' } : {}) }, children)
    }

    // ── 页签：账号 ──────────────────────────────────────────────────────
    function AccountTab({ status, models, busy, act, reload }) {
      const [showToken, setShowToken] = useState(false)
      const [form, setForm] = useState({ serviceToken: '', userId: '', xiaomichatbotPh: '' })
      const loginRunning = Boolean(status.login?.running)
      const account = status.account
      const loggedIn = Boolean(status.loggedIn)
      const d = status.diagnostics ?? {}
      const ageText = Number.isFinite(d.tokenAgeMs) ? fmtDuration(d.tokenAgeMs) : '—'

      const doLogin = () =>
        act('login', async () => {
          const data = await jpost('/login')
          if (data?.started) {
            await reload()
            return { text: '登录窗口已打开 —— 请在里面完成登录，面板会自动更新。', tone: '' }
          }
          await reload()
          return data?.ok
            ? { text: '登录成功。', tone: 'good' }
            : { text: `登录失败：${data?.error ?? '未知原因'}`, tone: 'bad' }
        })

      const doCancel = () =>
        act('cancel', async () => {
          await jpost('/login/cancel')
          await reload()
          return { text: '已取消登录。', tone: '' }
        })

      const doVerify = () =>
        act('verify', async () => {
          const data = await jpost('/verify', {})
          await reload()
          return data?.ok
            ? { text: '校验通过，登录态有效。', tone: 'good' }
            : { text: `校验失败：${data?.error ?? '未知原因'}`, tone: 'bad' }
        })

      const doSwitch = (id) =>
        act('switch', async () => {
          await jpost('/switch', { id })
          await reload()
          return { text: '已切换账号，下一次请求就用它。', tone: 'good' }
        })

      const doRemove = (id) =>
        act('remove', async () => {
          await jpost('/remove', { id })
          await reload()
          return { text: '已移除。', tone: '' }
        })

      const doLogout = () =>
        act('logout', async () => {
          await jpost('/logout', {})
          await reload()
          return { text: '已退出并清除本地凭据。', tone: '' }
        })

      const doToken = () =>
        act('token', async () => {
          const data = await jpost('/token', form)
          await reload()
          if (data?.ok) {
            setForm({ serviceToken: '', userId: '', xiaomichatbotPh: '' })
            setShowToken(false)
            return data.verified
              ? { text: '已保存并校验通过。', tone: 'good' }
              : { text: `已保存，但校验未通过：${data.warning ?? ''}`, tone: 'warn' }
          }
          return { text: `保存失败：${data?.error ?? '未知原因'}`, tone: 'bad' }
        })

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },

        h(
          'div',
          { 'data-mw-card': '' },
          h('div', { 'data-mw-card-title': '' }, '登录状态', loggedIn ? h(Pill, { tone: 'good' }, '已登录') : h(Pill, { tone: 'bad' }, '未登录')),

          h(Check, { ok: loggedIn, label: '登录状态', value: loggedIn ? (account.displayName ?? '已登录') : '未登录' }),
          h(Check, {
            ok: typeof status.capabilities?.adapterRegistered === 'boolean' ? status.capabilities.adapterRegistered : undefined,
            label: '适配器注册',
            value:
              status.capabilities?.adapterRegistered === true
                ? `${status.capabilities?.route ?? 'mimo-web'} 已注册到 llm`
                : status.capabilities?.adapterRegistered === false
                  ? '未注册 —— 重启 DSH 试试'
                  : `${status.capabilities?.route ?? 'mimo-web'}（已载入，宿主无查询接口）`,
          }),
          h(Check, { ok: d.hasServiceToken, label: '凭据来源', value: loggedIn ? '浏览器登录捕获' : '（无）' }),
          h(Check, { ok: d.hasServiceToken, label: 'xiaomichatbot_serviceToken', value: loggedIn ? `已捕获（${d.tokenLength} 字符）` : '未捕获' }),
          h(Check, { ok: d.hasUserId, label: 'userId', value: loggedIn ? account.userId ?? '已捕获' : '未捕获' }),
          h(Check, { ok: d.hasPh, label: 'xiaomichatbot_ph', value: d.hasPh ? '已捕获' : '未捕获' }),
          h(Check, {
            ok: loggedIn,
            label: 'UltraSpeed',
            value: loggedIn ? '可用（独立部署 /fastchat，凭据同一套）' : '未登录',
          }),
          h(Check, {
            ok: account?.verifiedAt ? true : loggedIn ? undefined : false,
            label: '服务端校验',
            value: account?.verifiedAt ? `通过（${fmtTime(account.verifiedAt)}）` : loggedIn ? '尚未校验' : '未登录',
          }),
          h(Check, {
            ok: loggedIn ? !account?.stale : false,
            label: '捕获时间',
            value: loggedIn ? `${fmtTime(account.capturedAt)}（距今 ${ageText}）` : '—',
          }),
          h(Check, {
            ok: account?.stale ? false : loggedIn ? true : undefined,
            label: '登录态寿命',
            value: loggedIn
              ? account?.stale
                ? `已超过 24 小时（serviceToken 通常约 24 小时过期，建议重新登录）`
                : `约 24 小时，还剩 ${fmtDuration(Math.max(0, (d.tokenTtlMs ?? 0) - (d.tokenAgeMs ?? 0)))}`
              : '—',
          }),
          account?.lastError
            ? h('div', { 'data-mw-warnbox': '' }, h('span', {}, '⚠'), h('span', {}, `最近一次失败：${account.lastError.message}`))
            : null,

          h(
            'div',
            { 'data-mw-row': '', style: { marginTop: 4 } },
            h(
              'button',
              { 'data-mw-btn': '', 'data-primary': '', type: 'button', disabled: busy || loginRunning, onClick: doLogin },
              loggedIn ? '登录新账号' : '浏览器窗口登录',
            ),
            loginRunning
              ? h('button', { 'data-mw-btn': '', type: 'button', disabled: busy, onClick: doCancel }, '取消登录')
              : null,
            h('button', { 'data-mw-btn': '', type: 'button', disabled: busy || loginRunning, onClick: doVerify }, '校验登录态'),
            h('button', { 'data-mw-btn': '', type: 'button', disabled: busy || loggedIn === false, onClick: () => setShowToken((v) => !v) }, '手动粘贴 Cookie'),
            loggedIn ? h('button', { 'data-mw-btn': '', 'data-danger': '', type: 'button', disabled: busy, onClick: doLogout }, '退出当前账号') : null,
          ),

          h(
            'div',
            { 'data-mw-note': '' },
            status.capabilities?.systemBrowser
              ? `登录窗口使用：${status.capabilities.systemBrowser}`
              : status.capabilities?.electronWindow
                ? '登录窗口使用：Electron 内置浏览器'
                : '⚠️ 这台机器上没找到 Edge / Chrome，只能用「手动粘贴 Cookie」。',
          ),
          h('div', { 'data-mw-note': '' }, '宿主进程：node（无窗口 API）→ 拉起真实浏览器；凭据只在登录那一刻读一次。'),
        ),

        loginRunning && status.login?.messages?.length
          ? h(
              'div',
              { 'data-mw-card': '' },
              h('div', { 'data-mw-card-title': '' }, '登录进度'),
              h(
                'div',
                { 'data-mw-log': '' },
                status.login.messages.map((m) => `${String(m.at).slice(11, 19)}  ${m.message}`).join('\n'),
              ),
            )
          : null,

        showToken
          ? h(
              'div',
              { 'data-mw-card': '' },
              h('div', { 'data-mw-card-title': '' }, '手动粘贴 Cookie'),
              h('div', { 'data-mw-note': '' }, '登录 aistudio.xiaomimimo.com 后按 F12 → Application → Cookies，复制这三个值（注意第一个名字带 xiaomichatbot_ 前缀）。'),
              h('input', { 'data-mw-input': '', placeholder: 'xiaomichatbot_serviceToken', value: form.serviceToken, onChange: (e) => setForm((p) => ({ ...p, serviceToken: e.target.value })) }),
              h('input', { 'data-mw-input': '', placeholder: 'userId（纯数字）', value: form.userId, onChange: (e) => setForm((p) => ({ ...p, userId: e.target.value })) }),
              h('input', { 'data-mw-input': '', placeholder: 'xiaomichatbot_ph', value: form.xiaomichatbotPh, onChange: (e) => setForm((p) => ({ ...p, xiaomichatbotPh: e.target.value })) }),
              h(
                'div',
                { 'data-mw-row': '' },
                h(
                  'button',
                  { 'data-mw-btn': '', 'data-primary': '', type: 'button', disabled: busy || !form.serviceToken || !form.userId || !form.xiaomichatbotPh, onClick: doToken },
                  '保存并校验',
                ),
              ),
            )
          : null,

        status.accounts?.length
          ? h(
              'div',
              { 'data-mw-card': '' },
              h('div', { 'data-mw-card-title': '' }, `账号库（${status.accounts.length}）`),
              status.accounts.map((acc) =>
                h(
                  'div',
                  { key: acc.id, 'data-mw-acc': '', ...(acc.current ? { 'data-current': '' } : {}) },
                  h(
                    'div',
                    { 'data-mw-row': '' },
                    h('span', { 'data-mw-v': '' }, acc.displayName || acc.id),
                    acc.current ? h(Pill, { tone: 'good' }, '当前') : null,
                    acc.stale ? h(Pill, { tone: 'warn' }, '可能已过期') : null,
                    acc.lastError ? h(Pill, { tone: 'bad' }, '需重新登录') : null,
                  ),
                  h(
                    'div',
                    { 'data-mw-row': '' },
                    h('span', { 'data-mw-note': '' }, `捕获于 ${fmtTime(acc.capturedAt)}`),
                    acc.verifiedAt ? h('span', { 'data-mw-note': '' }, `· 校验于 ${fmtTime(acc.verifiedAt)}`) : null,
                    h('span', { 'data-mw-note': '', 'data-mw-mono': '' }, `· ${acc.token}`),
                  ),
                  acc.lastError ? h('div', { 'data-mw-note': '', style: { color: '#f87171' } }, acc.lastError.message) : null,
                  h(
                    'div',
                    { 'data-mw-row': '' },
                    acc.current ? null : h('button', { 'data-mw-btn': '', 'data-sm': '', type: 'button', disabled: busy, onClick: () => doSwitch(acc.id) }, '切换'),
                    h('button', { 'data-mw-btn': '', 'data-sm': '', 'data-danger': '', type: 'button', disabled: busy, onClick: () => doRemove(acc.id) }, '移除'),
                  ),
                ),
              ),
            )
          : null,

        h(
          'div',
          { 'data-mw-card': '' },
          h('div', { 'data-mw-card-title': '' }, '数据位置'),
          h('div', { 'data-mw-note': '', 'data-mw-mono': '' }, status.dataDir ?? '—'),
          h('div', { 'data-mw-note': '' }, '凭据只存在本机。备份这个目录就能搬走所有账号；把它发给别人等于把账号本身给出去了。'),
        ),
      )
    }

    // ── 页签：模型 ──────────────────────────────────────────────────────
    function ModelTab({ status, models, busy, act, reload, modelsError }) {
      const settings = status.settings ?? {}
      const enabled = settings.enabledModels ?? []
      const allIds = models.map((m) => m.id)
      const isOn = (id) => enabled.length === 0 || enabled.includes(id)

      const toggle = (id) => {
        const current = enabled.length ? [...enabled] : allIds
        const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id]
        return act('settings', async () => {
          const data = await jpost('/settings', { enabledModels: next.length === allIds.length ? [] : next })
          await reload()
          return data?.ok ? { text: '已保存模型选择。', tone: 'good' } : { text: `保存失败：${data?.error ?? ''}`, tone: 'bad' }
        })
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(
          'div',
          { 'data-mw-card': '' },
          h('div', { 'data-mw-card-title': '' }, `可用模型（${models.length}）`),
          h('div', { 'data-mw-note': '' }, '从 MiMo 网页端实时读取（那个接口不需要登录）。全部勾选 = 不限制。'),
          modelsError ? h('div', { 'data-mw-msg': '', 'data-warn': '' }, modelsError) : null,
          models.length === 0 ? h('div', { 'data-mw-note': '' }, '尚未登录，读不到模型列表。') : null,
          models.map((model) =>
            h(
              'label',
              { key: model.id, 'data-mw-model': '', style: { cursor: 'pointer' } },
              h(
                'div',
                { 'data-mw-row': '' },
                h('input', { type: 'checkbox', checked: isOn(model.id), disabled: busy, onChange: () => toggle(model.id) }),
                h('span', { 'data-mw-v': '' }, model.name),
                h('span', { 'data-mw-note': '', 'data-mw-mono': '' }, model.id),
                model.thinkingDefaultOn ? h(Pill, { tone: 'good' }, '默认思考') : null,
                model.contextTokens ? h('span', { 'data-mw-note': '' }, `· ${model.contextTokens}`) : null,
              ),
              model.description ? h('div', { 'data-mw-note': '' }, model.description) : null,
            ),
          ),
        ),
        h(
          'div',
          { 'data-mw-card': '' },
          h('div', { 'data-mw-card-title': '' }, '说明'),
          h('div', { 'data-mw-note': '' }, '网页端没有原生 function calling —— 工具调用靠提示词协议，由本插件解析成标准 tool-call 块。'),
          h('div', { 'data-mw-note': '' }, 'temperature / stop / max_tokens 在网页端没有对应字段，会被忽略；usage 是估算值。'),
        ),
      )
    }

    // ── 页签：用量 ──────────────────────────────────────────────────────
    function UsageTab({ status, busy, act }) {
      const usage = status.usage ?? { today: {}, recent: [], byDay: [], total: {} }
      const [testResult, setTestResult] = useState(null)
      const models = status.__models ?? []
      const total = usage.total ?? {}
      const failureEntries = Object.entries(total.failureByCode ?? {})
      const maxCalls = Math.max(1, ...(usage.byDay ?? []).map((d) => d.calls))

      const doTest = () =>
        act('test', async () => {
          const data = await jpost('/test', { model: models[0]?.id })
          setTestResult(data)
          return {
            text: data?.ok ? `连通正常，耗时 ${data.ms} ms。` : `测试失败：${data?.error ?? '没有返回正文'}`,
            tone: data?.ok ? 'good' : 'bad',
          }
        })

      const doResetUsage = () =>
        act('reset', async () => {
          const data = await jpost('/usage/reset')
          return data?.ok ? { text: '台账已清空。', tone: '' } : { text: `清空失败：${data?.error ?? ''}`, tone: 'bad' }
        })

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(
          'div',
          { 'data-mw-card': '' },
          h('div', { 'data-mw-card-title': '' }, '今天'),
          h(
            'div',
            { 'data-mw-grid': '' },
            h(Stat, { n: usage.today?.calls ?? 0, l: '调用次数' }),
            h(Stat, { n: usage.today?.ok ?? 0, l: '成功' }),
            h(Stat, { n: fmtNum(usage.today?.inputTokens ?? 0), l: '输入 token（估）' }),
            h(Stat, { n: fmtNum(usage.today?.outputTokens ?? 0), l: '输出 token（估）' }),
          ),
        ),
        h(
          'div',
          { 'data-mw-card': '' },
          h('div', { 'data-mw-card-title': '' }, '近 7 天'),
          h(
            'div',
            { 'data-mw-grid': '' },
            h(Stat, { n: total.calls ?? 0, l: '总调用' }),
            h(Stat, { n: total.failures ?? 0, l: '失败' }),
            h(Stat, { n: total.toolCalls ?? 0, l: '工具调用' }),
            h(Stat, { n: Number.isFinite(total.medianGapMs) && total.medianGapMs > 0 ? `${Math.round(total.medianGapMs / 1000)}s` : '—', l: '相邻间隔中位' }),
          ),
          h(
            'div',
            { 'data-mw-note': '' },
            `最短间隔 ${Number.isFinite(total.minGapMs) && total.minGapMs > 0 ? `${Math.round(total.minGapMs / 1000)} 秒` : '—'} · p90 ${Number.isFinite(total.p90GapMs) && total.p90GapMs > 0 ? `${Math.round(total.p90GapMs / 1000)} 秒` : '—'}（只统计对话调用，间隔太短是"脚本味"的主要来源）`,
          ),
          failureEntries.length > 0
            ? h('div', { 'data-mw-note': '' }, `失败分类：${failureEntries.map(([code, count]) => `${code}×${count}`).join(' · ')}`)
            : null,
          usage.byDay?.length
            ? h(
                'div',
                { 'data-mw-table': '', style: { marginTop: 4 } },
                h('div', { 'data-mw-tr': '', 'data-head': '' }, h('span', {}, '日期'), h('span', {}, '调用'), h('span', {}, '成功'), h('span', {}, 'token')),
                ...usage.byDay.map((day) =>
                  h(
                    'div',
                    { key: day.date, 'data-mw-tr': '' },
                    h('span', {}, day.date.slice(5)),
                    h('span', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                      h('span', { 'data-mw-bar': '', style: { width: `${Math.round((day.calls / maxCalls) * 56)}px` } }),
                      h('span', {}, String(day.calls)),
                    ),
                    h('span', {}, String(day.ok)),
                    h('span', {}, fmtNum(day.inputTokens + day.outputTokens)),
                  ),
                ),
              )
            : h('div', { 'data-mw-note': '' }, '还没有调用记录。'),
        ),
        h(
          'div',
          { 'data-mw-card': '' },
          h('div', { 'data-mw-card-title': '' }, '最近调用'),
          usage.recent?.length
            ? h(
                'div',
                { 'data-mw-table': '' },
                h('div', { 'data-mw-tr': '', 'data-head': '' }, h('span', {}, '时间'), h('span', {}, '模型 / 结果'), h('span', {}, '耗时'), h('span', {}, 'token')),
                ...usage.recent.slice(0, 12).map((item, index) =>
                  h(
                    'div',
                    { key: `${item.at}-${index}`, 'data-mw-tr': '' },
                    h('span', {}, new Date(item.at).toLocaleTimeString()),
                    h('span', { style: { color: item.ok ? undefined : '#f87171' } },
                      `${item.model || '—'}${item.ok ? '' : ` · ${item.code ?? '失败'}`}`),
                    h('span', {}, item.ms ? `${(item.ms / 1000).toFixed(1)}s` : '—'),
                    h('span', {}, fmtNum((item.inputTokens ?? 0) + (item.outputTokens ?? 0))),
                  ),
                ),
              )
            : h('div', { 'data-mw-note': '' }, '还没有调用记录。'),
        ),
        h(
          'div',
          { 'data-mw-card': '' },
          h('div', { 'data-mw-card-title': '' }, '连通性测试'),
          h('div', { 'data-mw-note': '' }, '真发一条最小请求，把 SSE 事件序列回显出来。只读探活查不出"能登录但发不出消息"。'),
          h(
            'div',
            { 'data-mw-row': '' },
            h('button', { 'data-mw-btn': '', 'data-primary': '', type: 'button', disabled: busy || !status.loggedIn, onClick: doTest }, '发送测试'),
            h('button', { 'data-mw-btn': '', 'data-sm': '', type: 'button', disabled: busy, onClick: doResetUsage }, '清空台账'),
          ),
          testResult
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
                h('div', { 'data-mw-note': '' }, `模型 ${testResult.model ?? '—'} · 耗时 ${testResult.ms ?? '—'} ms`),
                h('div', { 'data-mw-msg': '', ...(testResult.ok ? { 'data-good': '' } : { 'data-bad': '' }) },
                  testResult.text || testResult.error || '没有返回正文'),
                testResult.reasoning
                  ? h('details', {}, h('summary', { 'data-mw-note': '' }, '思考内容'), h('div', { 'data-mw-msg': '' }, testResult.reasoning))
                  : null,
                testResult.events?.length
                  ? h('div', { 'data-mw-note': '', 'data-mw-mono': '' }, `SSE：${testResult.events.join(' → ')}`)
                  : null,
              )
            : null,
        ),
      )
    }

    // ── 页签：参数 ──────────────────────────────────────────────────────
    function SettingsTab({ status, busy, act, reload }) {
      const settings = status.settings ?? {}
      const save = (patch) =>
        act('settings', async () => {
          const data = await jpost('/settings', patch)
          await reload()
          return data?.ok ? { text: '已保存，下一轮请求生效。', tone: 'good' } : { text: `保存失败：${data?.error ?? ''}`, tone: 'bad' }
        })

      const num = (key, label, min, max, step, note) =>
        h(
          'div',
          { 'data-mw-row': '' },
          h('span', { 'data-mw-k': '' }, label),
          h('input', {
            'data-mw-input': '',
            type: 'number',
            min,
            max,
            step,
            defaultValue: settings[key] ?? 0,
            disabled: busy,
            onBlur: (event) => {
              const value = Number(event.target.value)
              if (Number.isFinite(value) && value !== settings[key]) save({ [key]: value })
            },
          }),
          note ? h('span', { 'data-mw-note': '' }, note) : null,
        )

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(
          'div',
          { 'data-mw-card': '' },
          h('div', { 'data-mw-card-title': '' }, '生成'),
          h(
            'div',
            { 'data-mw-row': '' },
            h('span', { 'data-mw-k': '' }, '默认思考'),
            h('input', {
              type: 'checkbox',
              checked: settings.thinking !== false,
              disabled: busy,
              onChange: (e) => save({ thinking: e.target.checked }),
            }),
            h('span', { 'data-mw-note': '' }, '关掉后默认直接作答；模型选择器里还能按次切。'),
          ),
          h(
            'div',
            { 'data-mw-row': '' },
            h('span', { 'data-mw-k': '' }, '网页搜索'),
            h(
              'select',
              {
                'data-mw-input': '',
                value: settings.webSearch ?? 'disabled',
                disabled: busy,
                onChange: (e) => save({ webSearch: e.target.value }),
              },
              h('option', { value: 'disabled' }, '关闭'),
              h('option', { value: 'auto' }, '自动（模型决定）'),
              h('option', { value: 'enabled' }, '总是开启'),
            ),
          ),
          num('maxImages', '单轮最多图片', 0, 40, 1, '网页端对条数有上限，超了整轮被拒'),
        ),
        h(
          'div',
          { 'data-mw-card': '' },
          h('div', { 'data-mw-card-title': '' }, '上下文与节流'),
          num('maxPromptChars', 'prompt 字符上限', 20000, 1200000, 10000, '每轮重发全量历史，这个值也是风控阀门'),
          num('contextWindow', '上下文窗口', 32768, 4194304, 1024, '声明给 DSH 的窗口（上游模型多标 1M）'),
          num('minIntervalMs', '请求最小间隔', 0, 30000, 100, '毫秒；固定间隔比随机间隔更像脚本'),
          num('idleTimeoutMs', '流空闲超时', 30000, 600000, 5000, '毫秒'),
          h(
            'div',
            { 'data-mw-row': '' },
            h('span', { 'data-mw-k': '' }, '允许并发'),
            h('input', {
              type: 'checkbox',
              checked: settings.allowConcurrent === true,
              disabled: busy,
              onChange: (e) => save({ allowConcurrent: e.target.checked }),
            }),
            h('span', { 'data-mw-note': '' }, '网页端通常只允许一条生成，开了容易被拒'),
          ),
          num('probeIntervalMs', '探活间隔', 0, 86400000, 60000, '毫秒；0 = 关闭（只读、零额度）'),
          h(
            'div',
            { 'data-mw-row': '' },
            h('span', { 'data-mw-k': '' }, '官网留记录'),
            h('input', {
              type: 'checkbox',
              checked: settings.saveConversationHistory !== false,
              disabled: busy,
              onChange: (e) => save({ saveConversationHistory: e.target.checked }),
            }),
            h('span', { 'data-mw-note': '' }, '关掉后官网左侧历史栏看不到插件发过的对话'),
          ),
        ),
        h(
          'div',
          { 'data-mw-card': '' },
          h('div', { 'data-mw-card-title': '' }, '恢复默认'),
          h(
            'div',
            { 'data-mw-row': '' },
            h(
              'button',
              {
                'data-mw-btn': '',
                type: 'button',
                disabled: busy,
                onClick: () => save({ ...status.defaults }),
              },
              '全部恢复默认',
            ),
          ),
        ),
      )
    }

    // ── 页签：关于 ──────────────────────────────────────────────────────
    function AboutTab({ status, models }) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(
          'div',
          { 'data-mw-card': '' },
          h('div', { 'data-mw-card-title': '' }, '关于'),
          h(Check, { ok: true, label: '版本', value: status.version ?? '—' }),
          h(Check, { ok: true, label: 'provider', value: status.provider ?? 'mimo-web' }),
          h(Check, { ok: true, label: '传输层', value: 'Node fetch（直连，无代理层）' }),
          h(Check, { ok: true, label: '模型数量', value: String(models.length) }),
          h(Check, { ok: Boolean(status.capabilities?.systemBrowser), label: '登录浏览器', value: status.capabilities?.systemBrowser || '未找到' }),
          h('div', { 'data-mw-note': '', 'data-mw-mono': '' }, `数据目录：${status.dataDir ?? '—'}`),
        ),
        h(
          'div',
          { 'data-mw-card': '' },
          h('div', { 'data-mw-card-title': '' }, '它是怎么工作的'),
          h('div', { 'data-mw-note': '' }, '本插件是一个「网页端私有接口的非官方客户端」：它自己构造请求发给 aistudio.xiaomimimo.com，中间没有转发层、也不需要额外跑服务。'),
          h('div', { 'data-mw-note': '' }, '登录只在第一次发生：开一个独立 profile 的浏览器窗口，读一次 Cookie，然后关掉 —— 之后插件自己发请求，浏览器不用一直开着。'),
          h('div', { 'data-mw-note': '' }, 'MiMo 没有 PoW、没有请求签名、没有验证码；鉴权就是那三个 Cookie。'),
        ),
        h(
          'div',
          { 'data-mw-card': '' },
          h('div', { 'data-mw-card-title': '' }, '风险说明'),
          h(
            'div',
            { 'data-mw-riskbox': '' },
            h('span', {}, '⚠'),
            h(
              'span',
              {},
              '非官方插件。逆向网页端本身违反服务条款，风险是"判罚多严"而不是"会不会被抓到"。' +
                '要求稳定性请改用小米官方的 MiMo API（OpenAI 兼容，用 API Key）。',
            ),
          ),
          h('div', { 'data-mw-note': '' }, 'serviceToken 约 24 小时过期；过期后普通对话可能还能用，但多模态会静默失效 —— 面板会按 24 小时标「可能已过期」。'),
        ),
      )
    }

    const TABS = [
      { id: 'account', label: '账号' },
      { id: 'models', label: '模型' },
      { id: 'usage', label: '统计' },
      { id: 'settings', label: '参数' },
      { id: 'about', label: '关于' },
    ]

    function Panel({ initialTab } = {}) {
      const [status, setStatus] = useState(null)
      const [models, setModels] = useState([])
      const [modelsError, setModelsError] = useState('')
      const [tab, setTab] = useState(initialTab && TABS.some((t) => t.id === initialTab) ? initialTab : 'account')
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState({ text: '', tone: '' })
      const pollRef = useRef(null)

      const loadStatus = useCallback(async () => {
        try {
          const data = await jget('/status')
          setStatus(data)
          return data
        } catch (error) {
          setMsg({ text: `读不到插件状态：${error?.message ?? error}`, tone: 'bad' })
          return null
        }
      }, [])

      const loadModels = useCallback(async () => {
        const data = await jget('/models')
        setModels(Array.isArray(data?.models) ? data.models : [])
        setModelsError(data?.error && data.error !== '尚未登录' ? String(data.error) : '')
      }, [])

      const reload = useCallback(async () => {
        await loadStatus()
        await loadModels()
      }, [loadStatus, loadModels])

      useEffect(() => {
        let alive = true
        ;(async () => {
          await loadStatus()
          if (alive) await loadModels()
        })()
        return () => {
          alive = false
          if (pollRef.current) clearInterval(pollRef.current)
        }
      }, [loadStatus, loadModels])

      // 登录窗口开着时轮询进度；关掉后拉一次完整状态。
      useEffect(() => {
        const running = Boolean(status?.login?.running)
        if (running && !pollRef.current) {
          pollRef.current = setInterval(async () => {
            const data = await loadStatus()
            if (!data?.login?.running && pollRef.current) {
              clearInterval(pollRef.current)
              pollRef.current = null
              await reload()
              const result = data?.login?.result
              if (result) {
                setMsg(
                  result.ok
                    ? { text: result.verified ? '登录成功。' : '已保存凭据，但服务端校验未通过。', tone: result.verified ? 'good' : 'warn' }
                    : { text: `登录失败：${result.error ?? '未知原因'}`, tone: 'bad' },
                )
              }
            }
          }, 2000)
        }
        if (!running && pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      }, [status?.login?.running, loadStatus, reload])

      const act = useCallback(async (label, fn) => {
        setBusy(label)
        setMsg({ text: '', tone: '' })
        try {
          const feedback = await fn()
          if (feedback) setMsg(feedback)
          return feedback
        } catch (error) {
          setMsg({ text: `操作失败：${error?.message ?? error}`, tone: 'bad' })
          return undefined
        } finally {
          setBusy('')
        }
      }, [])

      if (!status) return h('div', { 'data-mw': '' }, h('div', { 'data-mw-note': '' }, '正在读取插件状态 …'))

      const busyAny = Boolean(busy)
      const enriched = { ...status, __models: models }

      let body
      if (tab === 'account') body = h(AccountTab, { status, models, busy: busyAny, act, reload })
      else if (tab === 'models') body = h(ModelTab, { status, models, busy: busyAny, act, reload, modelsError })
      else if (tab === 'usage') body = h(UsageTab, { status: enriched, busy: busyAny, act })
      else if (tab === 'settings') body = h(SettingsTab, { status, busy: busyAny, act, reload })
      else body = h(AboutTab, { status, models })

      return h(
        'div',
        { 'data-mw': '' },
        h(
          'div',
          { 'data-mw-h': '' },
          'MiMo 网页登录',
          h(Pill, { tone: status.loggedIn ? 'good' : 'bad' }, status.loggedIn ? '已登录' : '未登录'),
          status.account?.stale ? h(Pill, { tone: 'warn' }, '可能已过期') : null,
          busy ? h('span', { 'data-mw-note': '' }, busy === 'login' ? '登录进行中…' : '处理中…') : null,
        ),
        h('div', { 'data-mw-note': '' }, '用 aistudio.xiaomimimo.com 网页端的登录态驱动 DSH agent，不需要 API Key。'),
        msg.text
          ? h('div', { 'data-mw-msg': '', ...(msg.tone ? { [`data-${msg.tone}`]: '' } : {}) }, msg.text)
          : null,
        h(
          'div',
          { 'data-mw-tabs': '' },
          TABS.map((item) =>
            h(
              'button',
              {
                key: item.id,
                'data-mw-tab': '',
                ...(tab === item.id ? { 'data-on': '' } : {}),
                type: 'button',
                onClick: () => setTab(item.id),
              },
              item.label,
            ),
          ),
        ),
        body,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-mimo-web-login')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'mimo-web-login: style')

        const slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
        if (!slots) return
        slots.inject('settings.section', () =>
          slots.register({ name: 'settings.section', id: 'mimo-web-login', order: 40, label: 'MiMo 网页登录' }, () =>
            h(Panel),
          ),
        )
      },
    }
  },
})
