# 参与开发

## 先读这个

插件是**直接跑在 DSH 宿主里**的，所以它对宿主 API 的假设一旦错了，表现往往很隐蔽
（整个插件静默不激活、面板空白、请求 404）。改代码前请先读 `README.md` 里的
「踩过的坑」—— 那 17 条全是真机上打出来的，每条都对应一个曾经让人排查很久的现象。

## 开发环境

- Node ≥ 22.18（或用 DSH 自带的）
- 一个已登录的 MiMo 账号（`test/e2e-login.mjs` 需要人工登录一次）
- Windows 上需要 Edge 或 Chrome（浏览器登录走 CDP）

## 跑测试

```bash
npm test                 # 离线 + 装配 + 渲染（全自动，不碰网络）
node test/probe-live.mjs # 线上探针（只用免登录接口）
```

`test/offline.mjs` 里有两类断言值得注意：

1. **抓包事实**：比如 UltraSpeed 必须走 `/fastchat/open-apis/bot/chat`，
   但 ph 参数名仍是 `xiaomichatbot_ph`（浏览器里没有 `ultraspeed_ph` 这个 cookie）。
   这些值是用 CDP 抓真实请求核对出来的，**不要照 SPA 源码字面量改**。
2. **防回归**：每个踩过的坑都有一条断言钉住。加功能时如果动了相关逻辑，
   请同步更新断言，而不是删掉它。

## 改代码时请守住这几条

- **宿主可能把 adapter 方法摘下来单独调用**（`registration.adapter.prepareCall(...)`），
  所以 adapter 里的方法**不能依赖 `this`**。
- **`ctx.setInterval` 这类服务属性访问器**，没 `inject` 时读取本身就会抛，
  `?.` 拦不住。要用 `globalThis.setInterval`。
- **重试策略必须扁平**，不能包 `backoff` 嵌套 —— 否则 `maxDelayMs` 变 undefined，
  整轮会话事件会被写坏。
- **面板请求要能被真实宿主路由到**：`webServer.register` 的 `kind: 'prefix'` +
  路径前缀，请求落到 SPA fallback 的表现就是 405。
- **别把凭据写进仓库**：`accounts.json` / `browser-profile/` 已在 `.gitignore` 里。

## 提 PR

- 一个小 PR 解决一件事，说明**现象 → 根因 → 怎么验证的**。
- 如果修的是一个隐蔽 bug，请补一条对应断言，并在注释里写清"为什么这样改"。
  （现有代码里这类注释很多，请沿用同样的风格。）
