<div align="center">

# dsh-mimo-web-login

**把小米 MiMo AI Studio 网页端接进 DSH：用浏览器登录态（不是 API Key）驱动 agent。**

[![CI](https://github.com/Mianbier/dsh-mimo-web-login/actions/workflows/ci.yml/badge.svg)](https://github.com/Mianbier/dsh-mimo-web-login/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.18%20%7C%7C%20%3E%3D24.11-brightgreen.svg)](package.json)
[![Version](https://img.shields.io/badge/version-1.7.2-blue.svg)](https://github.com/Mianbier/dsh-mimo-web-login/releases)

</div>

---

> ⚠️ **非官方插件。** 它逆向网页端的私有接口，不属于小米官方支持范围。
> 需要生产级稳定性请改用小米官方的 MiMo API（OpenAI 兼容，用 API Key）。
> 详见文末「风险说明」。

## 这是什么

DSH（DeepSeek Harness）通过 `ctx.llm` 的 **provider 适配器**接入模型。本项目实现了 `mimo-web`
这个 provider —— 它不调用小米官方 API，而是复用你**已登录的网页端**：会话、SSE 流式、图片上传、
语音合成/识别，全部走 `aistudio.xiaomimimo.com` 的私有接口。

于是：**在模型选择器里选 `小米 MiMo 网页版`，就能用网页端额度跑 DSH 的 agent。**

```text
DSH agent loop ──▶ ctx.llm ──▶ [mimo-web 适配器] ──▶ aistudio.xiaomimimo.com
                                     │  ├─ Cookie 鉴权（serviceToken / userId / xiaomichatbot_ph）
                                     │  ├─ react/chat（SSE，v3 协议）
                                     │  ├─ resource/genUploadInfo → PUT → parse（图片）
                                     │  ├─ tts/v2/generate + asr/recognize（语音）
                                     │  └─ 提示词工具协议 ⇄ tool-call 块
```

## ✨ 最近更新

### v1.7.2 — 修复工具调用漏成正文（` ```dsh ` 围栏）

**问题**：DSH 里显示一坨原始 JSON，工具一个都没执行；而官网上那段就是普通代码块。

**根因是两个 bug 叠加**：

1. **流式过滤器的围栏正则只认 ` ```dsh-tool `**
   但模型经常写 ` ```dsh `（省掉 `-tool`）、` ```json `、甚至空 ` ``` `。
   模型自己的 reasoning 里都点出来了：
   > "```dsh (not ```dsh-tool). The language tag is **"dsh"** not "dsh-tool"!"

2. **`flush()` 无条件把压住的内容吐出去**
   围栏被识别了、内容也被压住了 —— 但流一结束，`flush()` 又把它全吐出来。
   等于白压。

**修复**：

- 围栏识别放宽到 `dsh-tool` / `dsh` / `tool` / `json` / `tool_calls` / 空
- hold-back 窗口按"半截开栏"判据压住（` ```d ` 和 ` ```dsh-tool ` 前缀相同，无法提前区分）
- **`flush()` 见过围栏就直接丢弃** —— 那属于调用，收尾解析会把它变成真正的 tool-call 块

真机验证：

```
```dsh + JSON → 只流出正文"我先看一下工作区里已有的东西。"，calls=1 ✅
```js 普通代码块 → 正常流出，不被误拦 ✅
```

### v1.7.1 — 修复图片发送

**问题**：发图片时模型总说「我这边没有收到图片」。

**根因**：`resource/parse` 被我当成了"上传的必经一步"，但它其实是 **OCR**——
专门提取图片里的**文字**。一张纯色图/风景照会返回：

```json
{"code": 6002, "msg": "图片中未识别到文字"}
```

于是**所有不含文字的图片全部上传失败**，图片被静默丢弃。

**修复后**：parse 只是可选步骤，失败也照常返回（图片早就上传好了，`resourceUrl` 已拿到）。
真机验证：

```
造了一张 64x64 渐变 PNG
模型回答："这张图是渐变色：左侧偏绿/青，右上为紫红/品红，右下偏粉与暖黄…"
```

耗时也从 14.2s 降到 6.2s（不再对 6002 做无谓重试）。

### v1.7.0 — 明显更快 + 官网实时可见

**速度：首字 8.9s → 3.9s**

| 优化 | 做了什么 |
|---|---|
| **正文流式输出** | 以前正文全攒完才吐（思考哗哗出、正文等着）。现在用 hold-back 窗口边收边吐 —— 实测首字 105ms 就出来了 |
| **增量对话（默认）** | 同一个对话只发新内容。以前每轮重发几万字符（历史+协议），上游得先读完才开口 |
| **节流不再空等** | 以前每轮固定等 1.2~1.6s；现在间隔够就完全不等待 |

**官网实时可见**

- 每轮发消息**之前**都会登记会话（`conversation/save`），左栏那条会跟着刷新
- 所以现在你在官网能实时看到插件发的对话，不用等这轮结束

**两种模式都保留，面板可切**

| 模式 | 首字 | 说明 |
|---|---|---|
| **`chained`（默认）** | **3.9s** | 像官网打字，只发新内容 |
| `full` | 8.9s | 每轮重发全量，稳但慢 |

> 验证过 `chained` 是安全的：第一轮说「暗号是蓝鲸42」，第二轮只发「暗号是什么？」，
> 模型答出「蓝鲸42」—— 服务端确实按 `conversationId` 记着上下文。

### v1.6.x — Firefox 友好 / README 自动化

- **支持 Firefox 的「全部复制」**：存储面板右键复制出来是 TSV 多列，现在能直接解析
- **修掉 `navigator.clipboard` 在 http 远程访问下不可用** → 改成粘贴大文本框
- **README 与代码强制同步**：`scripts/sync-readme.mjs` 接进 `npm test` 与 CI

### v1.5.x — Linux 与远程访问

- **Linux 支持**：浏览器查找先走 `PATH`（apt / snap / flatpak / nix 都能找到）
- **root / 容器自适应**：自动加 `--no-sandbox`、`--disable-dev-shm-usage`
- **内置浏览器登录**：面板里嵌 iframe，在你自己的浏览器里登录（服务器不需要桌面）
- **修掉「手动粘贴 Cookie」点不动**：按钮曾在未登录时被禁用，恰恰那是它唯一该出现的场景

### v1.4.0 — 纯 API 语义

删掉了适配器里一堆"自作聪明"的逻辑（超长自动压缩、prompt 砍半重试、空回复判定、往官网写记录）——
**上下文长度、重试策略、失败判断本来就是 DSH 宿主的职责**。

### v1.3.x — 工具调用大修

- 协议文案、工具目录、转写格式**逐字照搬 `dsh-deepseek-web-login`**
- 改用**花括号配平**提取 JSON（不再被内容里的 ``` 提前截断）
- 修掉围栏名被写成键名（`{"tooldsh-tool`）导致的调用泄漏

## 和 DeepSeek 那个插件的区别（很重要）

`dsh-deepseek-web-login` 的核心工作量在 **PoW 求解**（SHA3 WASM，还要在真实页面里算）。
**MiMo 没有 PoW。** 我把 MiMo 的线上生产 bundle（776KB）扒开逐字核对过：

| 项目 | DeepSeek 网页 | 小米 MiMo 网页 |
|---|---|---|
| 鉴权 | `Authorization: Bearer` + `x-hif-*` 指纹头 | **只有 3 个 Cookie** |
| 反爬 | PoW 挑战 + TLS 指纹 + 请求签名 | **没有**（无 nonce、无签名、无验证码） |
| 端点 | `/api/v0/chat/completion` | `/open-apis/react/chat` |
| 思考流 | `response/fragments` 的 THINK 片段 | SSE 的 `reasoningContent` **字段** |
| 工具调用 | 网页端无原生 function calling | 同样没有 |

所以这个插件**不复用** DeepSeek 的 PoW 代码 —— 那部分在 MiMo 上一行都用不上。
它借用的是骨架：provider 注册方式、流式 chunk 形状、提示词工具协议、设置页。

## 快速开始

```bash
# 1. 装进 DSH 的 desktop profile
dsh plugin --profile desktop add ./dsh-mimo-web-login

# 2. 重启 DSH
# 3. 设置 → MiMo 网页登录 → 点「浏览器窗口登录」，在弹出的窗口里登录一次
# 4. 模型选择器里选「小米 MiMo 网页版」，开始用
```

登录只需一次。凭据存在本机（`~/.dsh/mimo-web/`）。
**登录态能撑多久由服务端决定**（实测常常远超 24 小时），面板只在服务端真的返回 401
时才提示重新登录 —— 不按时间瞎猜。

## 安装

### 从 Release 装（推荐）

```bash
# 下载最新的 tgz，然后
dsh plugin --profile desktop add ./dsh-mimo-web-login-1.7.2.tgz
```

### 从源码目录装

```bash
git clone https://github.com/Mianbier/dsh-mimo-web-login.git
dsh plugin --profile desktop add ./dsh-mimo-web-login
```

装完**重启 DSH**（本插件是 bundle 装配，重启即自动加载）。

> **不需要** `npm install`（没有运行时依赖），也没有构建步骤（源码即产物）。

### 卸载

```bash
dsh plugin --profile desktop remove dsh-mimo-web-login
```

账号数据在 `~/.dsh/mimo-web/`，卸载不会删。要彻底清掉就手动删那个目录。

## 登录方式（按你的环境选）

面板提供了**三条路**，按能力自动选或手动挑：

### A. 浏览器窗口登录（推荐，全自动）

用 `--remote-debugging-port` 拉起一个**独立 profile** 的浏览器，你正常登录，
插件通过 CDP 的 `Storage.getCookies` 把三个 Cookie 读回来。

- **Windows / macOS**：找 Edge 或 Chrome
- **Linux**：先查 `PATH`（`google-chrome` / `chromium` / `microsoft-edge` / `brave-browser`…），
  再用 `/usr/bin`、`/snap/bin`、flatpak 路径兜底
- 以 root 运行时自动加 `--no-sandbox`；`/dev/shm` 太小自动加 `--disable-dev-shm-usage`

### B. 内置浏览器登录（无桌面环境）

面板里嵌一个 `iframe` 直接打开登录页 —— **在你自己的浏览器里渲染**，服务器不需要任何浏览器。

实测 `aistudio.xiaomimimo.com` **没有** `X-Frame-Options`，也没有 CSP `frame-ancestors`，可以直接嵌。

> ⚠️ 跨域 iframe 读不到 cookie（同源策略），所以登录后仍需手动取三个值。

### C. 手动粘贴 Cookie（万能兜底）

任何环境都能用。面板里给了完整三步：

1. **点链接在新标签页打开登录页**
2. **按 F12 取 cookie**
   - **Firefox**：`存储` → Cookie → 点 `https://aistudio.xiaomimimo.com`
   - **Chrome / Edge**：`应用程式`(Application) → Cookie
   - 列表上**右键 → 全部复制**
3. **粘进面板的文本框** —— 自动拆成三个值

支持的粘贴格式：

| 格式 | 例子 | 支持 |
|---|---|---|
| Firefox「全部复制」 | `名称⇥值⇥域⇥路径⇥…`（TSV 多列） | ✅ |
| Firefox 选中几行 | TSV | ✅ |
| `document.cookie` 输出 | `k=v; k2=v2` | ✅ |
| curl `-b` | `k=v; k2=v2` | ✅ |
| JSON | `{"k":"v"}` | ✅ |
| 值带引号 | `k="v"` | ✅ |
| 少了前缀 | `serviceToken=…`（也认） | ✅ |

> ⚠️ `xiaomichatbot_serviceToken` 是 **HttpOnly** —— Console 里 `document.cookie` 看不到它，
> 必须走 DevTools 的存储/应用程式面板。

### 能力对照

| 环境 | 自动读 cookie | 用哪条 |
|---|---|---|
| Windows / macOS 桌面 | ✅ | A |
| Linux 有桌面 + Chromium 系 | ✅ | A |
| Linux 无桌面（服务器） | ❌ | B 或 C |
| 只有 Firefox | ❌（Firefox 不实现 CDP） | B 或 C |
| 纯 SSH | ❌ | 在本机登录后把 cookie 粘过去 |

> **为什么 Firefox 不能自动读？** 因为浏览器登录走 CDP（Chrome DevTools Protocol），
> Firefox 用的是 Marionette / WebDriver BiDi —— 完全是另一套协议，没有兼容层。

## 核心能力

| 能力 | 说明 |
|---|---|
| 🔐 **网页登录（无 API Key）** | 三条登录路径，按环境自动选 |
| 🧩 **多账号** | 账号库、一键切换、只读探活（零额度）、失效标记 |
| 🌊 **流式** | SSE v3：`message` / `reasoningContent` / `usage` / `finish` / `error`，跨 chunk 断行能拼回来 |
| 🧠 **思考流** | `reasoningContent` 直接映射成 DSH 的 reasoning 块，不是靠 `<think>` 标签猜 |
| 🛠 **工具调用** | 网页端没有原生 function calling → ```dsh-tool 围栏 + `tool_calls` JSON（照搬 DeepSeek） |
| 🩹 **容错解析** | 6 路兜底：主围栏 / 普通围栏 / 裸 JSON / antml-XML / `<tool_call>` 方言 / 括号配平抢救 |
| 🖼 **图片输入** | 走 `genUploadInfo → PUT → resource/parse` 三步，文件名后缀强制归一（服务端按后缀判类型） |
| 🔊 **语音（TTS/ASR）** | 面板可选音色，供 Aurabot 的本地接口脚本调用（`mimo-v2.5-tts` / `mimo-v2.5-asr`） |
| 🔍 **连通性测试** | 真发一条最小请求，把 SSE 事件序列回显出来 |
| 🎛 **设置面板** | 五个页签：**账号** / **模型** / **统计** / **参数** / **关于** |
| 📊 **用量台账** | 每次调用落 JSONL（今天 N 次·成功·失败码·工具调用·间隔中位/p90/最短） |
| 🌐 **「网页版」页签** | 主界面顶栏用 DSH 自带 Chromium 真正打开 MiMo 网页（**不参与发消息**） |
| ⚡ **允许并发** | 实测同账号并发可用，默认开启 —— 两个窗口可同时发消息 |

## 模型

模型列表**实时**从 `GET /open-apis/bot/config` 拉（这个接口**不需要登录**）。
实测 2026-11 可用 chat 模型 15 个，旗舰是 `mimo-v2.6-pro`。

`modelConfigListNg` 里带 `redirectTo` 的是**重定向别名**（旧模型名指向新模型），
不会进候选列表 —— 选了等于选新模型，不如直接列新的。

拉不到目录时有一份兜底表（`mimo-v2.6-pro` / `mimo-v2.6-flash`），
避免模型选择器里一片空白让人以为插件坏了。

## 配置

面板上的设置存在 `~/.dsh/mimo-web/settings.json`：

| 字段 | 默认 | 说明 |
|---|---|---|
| `thinking` | `true` | 默认是否开思考。模型选择器里还能按次切 |
| `webSearch` | `disabled` | `disabled` / `auto` / `enabled` |
| `maxImages` | `12` | 一次请求最多带几张图（网页端对条数有上限） |
| `contextWindow` | `1048576` | 声明给 DSH 的上下文窗口（上游 `nToken` 标的就是 1M） |
| `minIntervalMs` | `1200` | 两次请求之间的最小间隔（**风控阀门**，别调太小） |
| `idleTimeoutMs` | `180000` | 流空闲超时 |
| `allowConcurrent` | `true` | 是否允许同账号并发 |
| `probeIntervalMs` | `0` | 只读探活间隔，`0` = 关闭 |
| `contextMode` | `chained` | `chained`（像官网，快）/ `full`（每轮全量，稳但慢） |
| `ttsVoice` | `Chloe` | MiMo TTS 音色（冰糖 / Mia / 茉莉 / Chloe / 苏打 / Milo） |
| `ttsStyle` | 空 | 风格指令（如「轻快上扬，带着压抑不住的激动」） |
| `enabledModels` | `[]` | 模型白名单，空 = 全部 |

### `contextMode` 怎么选（影响速度）

| 模式 | 行为 | 首字实测 | 适合 |
|---|---|---|---|
| **`chained`（默认）** | **同一个对话只发新内容**，靠 `conversationId` 让服务端维护上下文 | **3.9s** | 日常使用（推荐） |
| `full` | 每轮开新会话 + 重发完整历史 + 工具协议 | 8.9s（长历史） | 出问题时排查 |

**为什么 `chained` 快这么多**：官网聊得快，是因为它只发你新说的那句话。
而 `full` 每轮要重发几万字符（历史 + 工具协议），上游得先读完才开口。

**`chained` 是安全的**：真机验证过 —— 第一轮说「暗号是蓝鲸42」，
第二轮只发「暗号是什么？」，模型答出「蓝鲸42」。服务端确实按 `conversationId` 记着上下文。

> 🔴 两条路**必须各自成对**：复用会话就只发增量，发全量就开新会话。
> 「复用会话 + 又发全量」= 服务端存一份、我们再发一份 ⇒ 模型看到两份历史
> ⇒ 吐交叠的损坏 JSON。这个坑真机踩过。

## 数据存在哪

```
~/.dsh/mimo-web/
├── accounts.json       账号库（含 serviceToken 明文）
├── active.json         当前账号
├── settings.json       面板设置
├── browser-profile/    登录用的浏览器 profile（独立，不碰你日常浏览器）
└── usage/              用量台账（每日 JSONL，自动清 7 天前的）
```

**凭据只存在本机。** 导出这个目录等于把账号本身给出去了 —— 别分享、别提交到仓库。

## 踩过的坑（写给以后改这个插件的人）

这些都是真机上打出来的，改代码前请先读。

### 登录与鉴权

1. **cookie 名是 `xiaomichatbot_serviceToken`，不是 `serviceToken`**
   少了前缀，浏览器里根本没这个名字，三件套永远凑不齐 —— 登录窗口只能干等到超时。

2. **cookie 值不能带外层引号**
   CDP 有时返回 `"/vjQ…JU="` 这种被 JSON 序列化过的值。`whoami` 不校验，
   所以看起来"登录成功"；但 `react/chat` 会把 ph 拼进 followup 校验，带引号立刻 401。

3. **「没有权限操作」是限流，不是没权限**
   上游把限速伪装成这句话，照字面理解会让用户反复重登（完全没用）。
   已归类为 `RATE_LIMIT`。

4. **登录态别按时间判过期**
   早期版本写死"捕获超过 24 小时即过期"，真机证明是**错的** —— 账号连续用几天都正常。
   现在只认服务端 401。

### SSE 与协议

5. **`messageType` 是消息角色，不是事件名**
   SSE 每帧是 `event:message` + `{"messageType":"assistant",...}`。早先拿 `messageType`
   覆盖事件名，`event:message` 就变成 `assistant`，被白名单丢掉 ——
   正文和思考全被吞，上层只看到 usage/finish，报"空响应"。**这个 bug 藏得最深。**

6. **`bot/config` 不需要鉴权**
   没登录也要把真实模型目录拉回来，否则只有兜底的 2 个。

7. **上游只认真实模型 id，不认显示名**
   `mimo-v2.6-pro` 能用，`MiMo-V2.6-Pro` 会回 `{"content":"模型名称错误"}`。

8. **`prepareCall(provider, model)` 的 model 才是可信模型来源**
   早先只用于 `resolveModelInfo`，发请求时读 `options.model` —— 那个可能是显示名。

9. **v2 的思考混在正文里，要剥 `<think>`**
   `/fastchat` 走 v2 协议，思考不是独立的 `reasoningContent`，而是 `<think>…</think>`
   混在 `content` 里，还夹 `\u0000` 分隔符。

10. **UltraSpeed 是独立部署，但凭据是同一套**
    用 CDP 抓官网真实请求才钉死的（别照 SPA 字面量猜）：

    ```text
    POST /fastchat/open-apis/bot/chat?xiaomichatbot_ph=<ph>
    cookie：xiaomichatbot_serviceToken / userId / xiaomichatbot_ph
    ```

    两个反直觉点：路径要加 `/fastchat` 且端点是 v2 的 `bot/chat`；
    **查询参数和 cookie 名仍是 `xiaomichatbot_ph`** —— SPA 里那个
    `{ultra: "ultraspeed_ph"}` 只是内部配置字符串，浏览器里没这个 cookie。

### 工具调用（血泪最多的一块）

11. **协议形状别自己发明 —— 照搬 `dsh-deepseek-web-login`**

    我最初自己发明了 XML 标记（`<mimo_tool_call>`），模型直接拒绝：
    *"我没有 mkdir_test 这个工具，不会伪造调用"*。

    正解是抄成熟方案：

    ````text
    ```dsh-tool
    {"tool_calls":[{"name":"<工具名>","arguments":{...}}]}
    ```
    ````

    换过来之后真机一次就通，模型 reasoning 里明说
    *"The tool call format is the dsh-tool fenced JSON block."*

12. **提示词要事先警告模型，而不是事后打补丁**

    DeepSeek 的协议里有 **rule 5b**：
    > (a) 值里的双引号必须转义成 `\"`
    > (b) 值里不能有真换行，要写 `\n`

    我自写的中文版漏了这两条，于是模型反复写坏 JSON，我就在解析器里反复救。
    **治标不治本。** 现在整份协议逐字照搬（见 `lib/ds-protocol.js`）。

13. **历史里的调用块形状必须和协议一致**

    早先历史里渲染成自创 XML，而协议要求 ```dsh-tool 围栏 ——
    **模型从历史学格式，学到的就是错的**。现在照搬 `renderToolCalls`：
    `Assistant: {"tool_calls":[…]}`，且 `arguments` 是**嵌套对象**（不是字符串）。

14. **别用"匹配到闭合围栏"的正则取 JSON**

    模型写 Python 时内容里自带三个反引号（docstring 嵌套 markdown、正则匹配围栏），
    正则会在那里提前截断 ⇒ JSON 残缺 ⇒ 调用漏成正文。

    正解：**按花括号配平**提取（字符串与转义都算进去）。

15. **参数会平铺在调用对象上**

    ```json
    {"tool_calls":[{"name":"pwsh","command":"...","workdir":"..."}]}
    ```
    旧解析器只认 `arguments` 键 ⇒ 参数全丢 ⇒ 变成 `pwsh {}` 空调用。
    现在没有 `arguments` 时，把除元信息外的同级字段整体当参数。

16. **围栏名会被写成键名**

    ```text
    {"tooldsh-tool
    {"tool_calls":[…]}
    ```
    从第一个 `{` 配平会拿到那个坏对象（内含不配平的同级 `{`）⇒ 永远失败。
    正解：先找**真的像调用**的 `{`（后面紧跟 `"tool_calls"`），再配平。

17. **字符串里会有裸双引号**

    ```json
    "content":""""临时诊断""""
    ```
    裸引号把 JSON 字符串提前闭合。正解：按"**真闭合引号后面必跟结构标记**"
    （`,` `}` `]` `:`）的规律，把内容里的裸引号转义掉。

18. **提示词里的禁令拦不住模型换方言，解析器必须兜**
    实测模型会无视禁令吐 `<tool_call><function=…></function></tool_call>`。
    **教训：提示词约束只是"期望"，解析器兼容才是"保证"** —— 两者都要。

### 上下文与续聊

19. **上游会按 `conversationId` 记住上下文**

    ```text
    第1轮: "我叫大明"          → "好的，大明"
    第2轮: 同 convId，只发"我叫什么名字？" → "你叫大明"
    ```

    但**复用会话 + 再发全量** = 服务端存一份、你又发一份 ⇒ 模型看到两份，
    会吐出交叠的损坏 JSON。所以默认**不复用会话**（`detach("new-session")`）。

20. **不要替宿主做压缩/截断**
    DSH 管 `contextWindow` 与预算。适配器截断只会让模型突然失忆，
    而且用户完全不知道发生了什么。超长就照实报错。

### 其他

21. **`ctx.setInterval` 不能碰**
    它是 Cordis 的服务属性 getter，没 `inject` `timer` 时**读取本身就抛**
    （`?.` 拦不住）。在 `ctx.effect()` 里一抛，整个插件条目变成 "did not activate"，
    后面的 `webServer.register` 全不执行 → 面板所有请求 404/405。

22. **模型目录缓存要按实例分桶**
    `mappingCache` 曾是全局单例，多账号场景下 A 的目录会污染 B 的映射。
    现在按 `fetchImpl` 分 `WeakMap` 桶。

23. **测试不要依赖运行环境**
    CI 的 ubuntu runner 自带 `/usr/bin/google-chrome`，会抢在测试塞的假浏览器前面命中。
    测"查找逻辑读 PATH"时，要把 `PATH` **只指向临时目录**。

## 已知限制

- **没有原生 tools**：工具调用靠提示词协议，模型偶发格式漂移已由 6 路解析器兜住，
  但本质是模型行为，无法 100% 保证
- **Firefox 不能自动读 cookie**：它不实现 CDP，只能手动
- **请求太密集会被限流**：实测 ≥1.5s 间隔才稳
- **登录态寿命由服务端决定**：面板只认 401
- **`temperature` / `stop` / `max_tokens`**：网页端无对应字段，会被忽略
- **usage 是估算值**：网页端只在部分响应里返回 token 计数
- **内容风控**：部分提问会回「敏感内容」，这是上游策略，重试无效
- **TTS 需要订阅**：实测普通账号 `mimo-v2.5-tts` 返回 500，但 `mimo-v2.5-asr` 可正常用

## 测试

```bash
npm test                       # 下面三条离线测试，全自动、不碰网络

node test/offline.mjs          # 65 项断言：工具协议 / SSE / 请求体 / 续聊 / 图片 / Linux
node test/assembly.mjs         # 用假 ctx 真的跑一遍 apply()，验证注册 + 全部 HTTP 路由
node test/render.mjs           # 面板五个页签的渲染冒烟（含"未登录时粘贴按钮可点"回归）

node test/probe-live.mjs       # 线上探针：模型目录 + 401 形状，只用免登录接口
node test/login-capability.mjs # 这台机器上哪条登录路线可用
node test/cdp-plumbing.mjs     # CDP 链路（无头）：拉起浏览器 → 连调试端口 → 读 cookie 罐
node test/page-reach.mjs       # 真实页面：打到登录页，确认能渲染、未登录时读不到 cookie
node test/e2e-login.mjs        # 端到端：开窗口→你登录→读凭据→真发一条消息
```

前 8 条全自动。最后一条需要人工登录一次 —— 那是唯一没法自动化的一步。

Windows 上也可以双击 `验证MiMo连接.bat`。

**CI 覆盖**：Ubuntu 22/24 + Windows 22/24，四个组合全绿。

## 发出去给别人装

这个包是自包含的（除 `node:` 与 `electron` 外无运行时依赖）：

```bash
# 从目录装
dsh plugin --profile desktop add <这个目录的绝对路径>

# 或从 tgz 装
npm pack        # 产出 dsh-mimo-web-login-1.7.2.tgz
dsh plugin --profile desktop add ./dsh-mimo-web-login-1.7.2.tgz
```

装完重启 DSH。**不需要** `npm install`（没有依赖），也没有构建步骤（源码即产物）。

## 风险说明

本插件是**非官方**的网页端客户端：它自己构造请求发给 MiMo 的私有接口，不经过任何中间转发。

逆向网页端本身**违反服务条款**，风险是"判罚多严"而不是"会不会被抓到"。
要求稳定性请改用小米官方的 MiMo API（OpenAI 兼容，用 API Key）。

## 许可

Apache-2.0
