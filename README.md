<div align="center">

# dsh-mimo-web-login

**把小米 MiMo AI Studio 网页端接进 DSH：用浏览器登录态（不是 API Key）驱动 agent。**

[![CI](https://github.com/Mianbier/dsh-mimo-web-login/actions/workflows/ci.yml/badge.svg)](https://github.com/Mianbier/dsh-mimo-web-login/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.18%20%7C%7C%20%3E%3D24.11-brightgreen.svg)](package.json)

</div>

---

> ⚠️ **非官方插件。** 它逆向网页端的私有接口，不属于小米官方支持范围。
> 需要生产级稳定性请改用小米官方的 MiMo API（OpenAI 兼容，用 API Key）。
> 详见文末「风险说明」。

## 这是什么

DSH（DeepSeek Harness）通过 `ctx.llm` 的 **provider 适配器**接入模型。本项目实现了 `mimo-web`
这个 provider —— 它不调用小米官方 API，而是复用你**已登录的网页端**：会话、SSE 流式、图片上传，
全部走 `aistudio.xiaomimimo.com` 的私有接口。

于是：**在模型选择器里选 `小米 MiMo 网页版`，就能用网页端额度跑 DSH 的 agent。**


```text
DSH agent loop ──▶ ctx.llm ──▶ [mimo-web 适配器] ──▶ aistudio.xiaomimimo.com
                                     │  ├─ Cookie 鉴权（serviceToken / userId / xiaomichatbot_ph）
                                     │  ├─ react/chat（SSE，v3 协议）
                                     │  ├─ resource/genUploadInfo → PUT → parse（图片）
                                     │  └─ 提示词工具协议 ⇄ tool-call 块
```

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
dsh plugin --profile desktop add ./dsh-mimo-web-login    # 本地目录
# 或：dsh plugin --profile desktop add ./dsh-mimo-web-login-1.0.0.tgz

# 2. 重启 DSH
# 3. 设置 → MiMo 网页登录 → 点「浏览器窗口登录」，在弹出的窗口里登录一次
# 4. 模型选择器里选「小米 MiMo 网页版」，开始用
```

登录只需一次。凭据存在本机（`~/.dsh/mimo-web/`），`serviceToken` 约 24 小时过期，
面板会按时间标「可能已过期」，过期后重新点一次登录即可。

## 登录是怎么捕获的

两条路，按能力自动选：

**A. Electron 主进程**（DSH 以主进程身份加载插件时）
自开 `BrowserWindow` + 独立 partition，用 `webRequest.onBeforeSendHeaders` 旁路读 Cookie。

**B. 系统 Edge / Chrome + CDP**（默认路径 —— 桌面端插件实际跑在 utility 进程里，
`require('electron')` 拿不到 `BrowserWindow`）
用 `--remote-debugging-port` 拉起一个**独立 profile** 的浏览器，你正常登录，
登录完成后插件通过 `Storage.getCookies` 把三个 Cookie 读回来。

两条路都：

- **不碰你日常浏览器的 cookie 与历史**（独立 profile / 独立分区）；
- **不改写任何业务请求**，只在登录那一刻读一次；
- 登录完成后关掉窗口，插件照样跑。

> ⚠️ 拿不到浏览器（纯 web profile、容器、无 GUI 环境）时，用面板里的
> **手动粘贴 Cookie** 通道。

## 安装

```bash
# 从本地目录装（本仓库 checkout 之后）
dsh plugin --profile desktop add ./dsh-mimo-web-login
```

装完**重启 DSH**（本插件是 bundle 装配，重启即自动加载）。

## 第一次使用

1. **设置 → MiMo 网页登录 → 浏览器窗口登录**
2. 在弹出的窗口里正常登录（小米账号 / 扫码都行）
3. 看到对话界面后，窗口会在 1~2 秒内自动关闭，面板显示**已登录**
4. 模型选择器 → provider **`小米 MiMo 网页版`** → 选一个模型

`serviceToken` 约 **24 小时**过期。过期后重新点一次「登录新账号」即可 ——
**会原地更新那条记录**，不会在账号库里堆出一串同名账号。

## 核心能力

| 能力 | 说明 |
|---|---|
| 🔐 **网页登录（无 API Key）** | 独立 profile 的浏览器窗口，登录后旁路读取三个 Cookie |
| 🧩 **多账号** | 账号库、一键切换、只读探活（零额度）、失效标记 |
| 🌊 **流式** | SSE v3：`message` / `reasoningContent` / `usage` / `finish` / `error`，跨 chunk 断行能拼回来 |
| 🧠 **思考流** | `reasoningContent` 直接映射成 DSH 的 reasoning 块，不是靠 `<think>` 标签猜 |
| 🛠 **工具调用** | 网页端没有原生 function calling → 提示词 JSON 协议 + 4 路容错解析 |
| 🩹 **路径保护** | Windows 路径里的 `\n` 是**合法** JSON 转义，会把 `C:\note.txt` 静默吃成两行 —— 这里有专门判据 |
| 🖼 **图片输入** | 走 `genUploadInfo → PUT → resource/parse` 三步，文件名后缀强制归一（服务端按后缀判类型） |
| 🔍 **连通性测试** | 真发一条最小请求，把 SSE 事件序列回显出来（只读探活查不出"能登录但发不出消息"） |
| 🎛 **设置面板** | 五个页签：**账号** / **模型** / **统计** / **参数** / **关于**，登录状态卡片带整排诊断行 |
| 📊 **用量台账** | 每次调用落一份 JSONL（今天 N 次·成功·失败码·工具调用·相邻间隔中位/p90/最短），面板「统计」页可视化 |

## 模型

模型列表**实时**从 `GET /open-apis/bot/config` 拉（这个接口**不需要登录**）。
实测 2026-11 可用 chat 模型 15 个，旗舰是 `mimo-v2.6-pro`。

`modelConfigListNg` 里带 `redirectTo` 的是**重定向别名**（旧模型名指向新模型），
不会进候选列表 —— 选了等于选新模型，不如直接列新的。

拉不到目录时有一份兜底表（`mimo-v2.6-pro` / `mimo-v2.6-flash`），
避免模型选择器里一片空白让人以为插件坏了。

## 配置

面板上的设置存在 `~/.dsh/mimo-web/settings.json`，也可以写进插件 entry config：

| 字段 | 默认 | 说明 |
|---|---|---|
| `thinking` | `true` | 默认是否开思考。模型选择器里还能按次切 |
| `webSearch` | `disabled` | `disabled` / `auto` / `enabled` |
| `maxImages` | `12` | 一次请求最多带几张图（网页端对条数有上限，超了整轮被拒） |
| `maxPromptChars` | `240000` | 单次 prompt 字符上限。**这个值也是风控阀门** |
| `contextWindow` | `262144` | 声明给 DSH 的上下文窗口 |
| `minIntervalMs` | `1200` | 两次请求之间的最小间隔 |
| `idleTimeoutMs` | `180000` | 流空闲超时 |
| `allowConcurrent` | `false` | 是否允许同账号并发（网页端通常只允许一条） |
| `probeIntervalMs` | `1800000` | 只读探活间隔，`0` = 关闭 |
| `enabledModels` | `[]` | 模型白名单，空 = 全部 |

> ⚠️ **`maxPromptChars` 是风控阀门，不是「越大越好」。**
> 网页端是**无状态**的：每一轮都要把整段对话重新发一遍，这个上限直接决定单次请求体量。
> 真要长上下文，更稳的做法是别把天花板抬高，而是接受 DSH 的压缩。

## 数据存在哪

```
~/.dsh/mimo-web/
├── accounts.json       账号库（含 serviceToken 明文）
├── active.json         当前账号
├── settings.json       面板设置
├── browser-profile/    登录用的浏览器 profile（登录完就清）
└── usage/              用量台账（每日 JSONL，自动清 7 天前的）
```

**凭据只存在本机。** 导出这个目录等于把账号本身给出去了 —— 别分享、别提交到仓库。

## 踩过的坑（写给以后改这个插件的人）

这几条都是真机上打出来的，改代码前请先读：

1. **cookie 名是 `xiaomichatbot_serviceToken`，不是 `serviceToken`**
   少了前缀，浏览器里根本没这个名字，三件套永远凑不齐 —— 登录窗口只能干等到超时。

2. **cookie 值不能带外层引号**
   CDP 有时返回 `"/vjQ…JU="` 这种被 JSON 序列化过的值。`whoami` 不校验，
   所以看起来"登录成功"；但 `react/chat` 会把 ph 拼进 followup 校验，带引号立刻 401。
   现在入口统一用 `normalizeCookieValue` 洗。

3. **「没有权限操作」是限流，不是没权限**
   上游把限速伪装成这句话，照字面理解会让用户反复重登（完全没用）。
   已归类为 `RATE_LIMIT` 交给重试策略，文案也改成"不是登录失效"。

4. **`messageType` 是消息角色，不是事件名**
   SSE 每帧是 `event:message` + `{"messageType":"assistant",...}`。早先拿 `messageType`
   覆盖事件名，`event:message` 就变成 `assistant`，被白名单丢掉 ——
   正文和思考全被吞，上层只看到 usage/finish，报"空响应"。这个 bug 藏得最深。

5. **`bot/config` 不需要鉴权**
   没登录也要把真实模型目录拉回来，否则模型选择器里只剩兜底的 2 个，
   用户会觉得"明明有 15 个却只给我两个"。

6. **上游只认真实模型 id，不认显示名**
   `mimo-v2.6-pro` 能用，`MiMo-V2.6-Pro` 会回 `{"content":"模型名称错误"}`。
   宿主可能把显示名传下来，现在 `resolveUpstreamModelId` 按目录做模糊匹配归一。

7. **「文本超长」是硬限制，要自动重试**
   DSH 每轮发全量历史，长会话必然撞上。撞上就折半 prompt 重试（最多 3 次），
   而不是把错误直接甩给用户。

8. **`ctx.setInterval` 不能碰**
   它是 Cordis 的服务属性 getter，没 `inject` `timer` 时**读取本身就抛**
   （`?.` 拦不住）。在 `ctx.effect()` 里一抛，整个插件条目变成 "did not activate"，
   后面的 `webServer.register` 全不执行 → 面板所有请求 404/405。

9. **想让人在官网看到记录，必须补一枪 `conversation/save`**
   只发 `react/chat` 消息能正常回复，但 `chat/conversation/list`（网页端左侧
   历史栏的数据源）里**不会建行** —— 用户会以为插件根本没工作。
   而且 `title` 是必填，空串直接 `400 title: must not be empty`。
   现在默认开（`saveConversationHistory`），可在「参数」页关掉。

10. **`prepareCall(provider, model)` 的 model 才是可信模型来源**
    早先只把它用于 `resolveModelInfo`，发请求时却读 `options.model` ——
    stream 阶段那个值可能是显示名/别名，于是上游回「模型名称错误」。
    现在 model 作为 hint 一路传到 `runStream`。

11. **UltraSpeed 是独立部署，但凭据是同一套**
    这条踩了好几轮，最后是**用 CDP 抓官网真实请求**才钉死的（别照 SPA 字面量猜）：

    ```text
    实测请求：POST /fastchat/open-apis/bot/chat?xiaomichatbot_ph=<ph>
    实测 cookie：xiaomichatbot_serviceToken / userId / xiaomichatbot_ph
    ```

    两个反直觉点：

    - 路径要加 `/fastchat`，端点是 v2 的 `bot/chat`
      （`/fastchat/open-apis/react/chat` 是 404）
    - **查询参数和 cookie 名仍是 `xiaomichatbot_ph`**。SPA 源码里那个
      `{ultra: "ultraspeed_ph"}` 只是内部配置字符串，浏览器里根本没有
      `ultraspeed_ph` 这个 cookie —— 照字面量去用必然 401

12. **v2 的思考混在正文里，要剥 `<think>`**
    `/fastchat` 走的是 v2 协议，思考不是独立的 `reasoningContent` 字段，
    而是 `<think>…</think>` 直接混在 `content` 里，还夹 `\u0000` 分隔符。
    不剥的话用户会看到 `<think>` 字面量（`unwrapThinkTags` 负责这件事）。

13. **模型目录缓存要按实例分桶**
    `mappingCache` 曾经是全局单例，多账号/多 adapter 场景下 A 的目录会污染 B 的
    映射，把 UltraSpeed 悄悄映射成普通模型。现在按 `fetchImpl` 分 `WeakMap` 桶。

14. **超长 prompt 要压缩，不是截断**
    `truncateMiddle` 砍中间的字会让模型突然失忆。`compressPrompt` 保住
    系统头 + 首轮任务 + 最近 N 轮 + 工具结果关键行，只收掉中间已完成的回合，
    并显式注明"前面 N 段已压缩省略"，让模型知道自己漏了背景。

15. **同一个会话要续在同一条网页端对话上（只发增量）**
    实测：服务端**真会按 `conversationId` 记住上下文**——

    ```text
    第1轮: "我叫大明"          → "好的，大明，我记住了"
    第2轮: 同 convId，只发"我叫什么名字？"（零历史）
                               → "你叫大明"
    ```

    所以复用会话 + 只发增量既省 token，也还原了网页端本来的连续对话，
    用户去官网还能看到一条完整会话。

    跨轮携带靠 DSH 的正规通道 `replayState`：finish chunk 带上
    `{conversationId, lastMessageId}`，宿主挂到 assistant 消息的
    `source.replayState`，下一轮原样带回来。找不到锚点就自动退回全量。

16. **「敏感内容」是上游风控，重试没用**
    `sensitive_query` 事件要归类成 `SENSITIVE`（**不在** `retryableCodes` 里），
    并给用户可照做的说法：换措辞、去掉争议片段、把问题拆小。

17. **提示词里的禁令拦不住模型换方言，解析器必须兜**
    实测：模型会无视「不要用 `<tool_call>`」的禁令，吐出 Qwen/DeepSeek 系的

    ```text
    <tool_call><function=digital_life_status></function></tool_call>
    ```

    旧解析器只认 `<mimo_tool_call>` / `<invoke>`，于是整段被当正文喷出来，
    用户看到的是原文而不是工具执行结果。
    现在 `extractToolCalls` 增加了第 ⑤ 路（含 `<parameter=…>`、JSON 参数体、
    无参数调用），并能清理畸形残片（截图原文其实是
    `<tool_call>…</tool_call>></function></tool_call>` 这种坏标签）。

    **教训：提示词约束只是"期望"，解析器兼容才是"保证"** —— 两者都要。

18. **提示词里的「工具」框架会和网页端自带的系统提示打架**
    这条是最反直觉的坑，值得单独说。真机实测同一个内容，只换叙述框架：

    | 提示词说法 | 模型反应 |
    |---|---|
    | "你要调用工具 mkdir_test" | **拒绝**："我没有 mkdir_test 这个工具，不会伪造调用" |
    | "把这段内容原样复述一遍" | ✅ 照做，输出调用块 |

    原因：MiMo 网页端自己有一套系统提示，告诉模型"你有 search / scrape 工具"。
    当你的说法是"工具授权"时，模型的先验知识会跟它冲突，于是它选择**拒绝**；
    而"格式约定 / 按格式输出"这套框架不触发那层判断，它就照做了。

    所以 `toolProtocolInstructions()` 现在刻意写成**格式约定**口吻：
    用"动作指令"而不是"工具调用"，并明确写「不要写我做不到」。

    顺带的另一条经验：**协议说明越短越好**。规则写太多时，模型会把 token
    耗在反复念条款上，思考被截断、正文一个字都没产出（上层表现为"空响应"）。

## 已知限制

- **没有原生 tools**：工具调用靠提示词协议，模型偶发格式漂移已被 5 路解析器兜住（主格式 / 代码围栏 / 裸 JSON / antml-XML / `<tool_call>` 方言），但本质是模型行为，无法 100% 保证
- **同账号并发**：网页端通常只允许一条生成，并发会被拒；`allowConcurrent` 默认关
- **请求太密集会被限流**：「参数 → 请求最小间隔」别调太小，实测 ≥1.5s 才稳
- **`serviceToken` 约 24 小时过期**：过期后普通对话可能还能用、但多模态会静默失效 —— 面板会按 24 小时标「可能已过期」
- **`temperature` / `stop` / `max_tokens`**：网页端无对应字段，会被忽略
- **usage 是估算值**：网页端只在部分响应里返回 token 计数
- **内容风控**：网页端会对部分提问回「敏感内容」，这是上游策略，不是插件故障（重试无效）
- **续聊依赖 `replayState`**：同一个 DSH 会话会续在同一条网页端对话上（只发增量）。
  如果宿主某次没把 replayState 带回来，会自动退回"新开会话 + 发全量"，功能不受影响

## 测试

```bash
npm test                       # = 下面三条离线测试，全自动、不碰网络

node test/offline.mjs          # 49 项断言：工具协议解析 / SSE / 请求体形状 / 续聊增量
node test/assembly.mjs         # 用假 ctx 真的跑一遍 apply()，验证注册 + 全部 HTTP 路由
node test/render.mjs           # 面板五个页签的渲染冒烟（抓运行时错误）

node test/probe-live.mjs       # 线上探针：模型目录 + 401 形状，只用免登录接口
node test/login-capability.mjs # 这台机器上哪条登录路线可用（浏览器路径 / 目录可写）
node test/cdp-plumbing.mjs     # CDP 链路（无头）：拉起浏览器 → 连调试端口 → 读 cookie 罐
node test/page-reach.mjs       # 真实页面：打到 MiMo 登录页，确认能渲染、未登录时读不到 cookie
node test/e2e-login.mjs        # 端到端：开窗口→你登录→读凭据→真发一条消息（需人工登录）
```

前 8 条全自动。最后一条需要你在弹出的窗口里登录一次 —— 那是唯一没法自动化的一步。

Windows 上也可以双击 `验证MiMo连接.bat`，它做的就是 `e2e-login.mjs`。

### 实测记录（2026-11，Edge 157 / Windows）

- `bot/config` 免登录返回 15 个 chat 模型 ✓
- 假凭据 → `HTTP 401` + `code=AUTH` ✓
- CDP：浏览器启动、调试端口、`Storage.getCookies`、cookie 数组形状 ✓
- 真实页面：3 秒内渲染出 `Xiaomi MiMo Studio`，未登录时三个必需 cookie **确实读不到** ✓
- 续聊：同一个 `conversationId` 第二轮只发增量，服务端仍记得第一轮内容 ✓
- UltraSpeed：`/fastchat/open-apis/bot/chat`（v2）正常出正文 + 思考 ✓

## 发出去给别人装

这个包是自包含的（除 `node:` 与 `electron` 外无运行时依赖），别人拿到目录后：

```bash
dsh plugin --profile desktop add <这个目录的绝对路径>
```

也可以打包成 tgz 分发：

```bash
npm pack        # 产出 dsh-mimo-web-login-1.0.0.tgz
dsh plugin --profile desktop add ./dsh-mimo-web-login-1.0.0.tgz
```

装完重启 DSH。**不需要** `npm install`（没有依赖），也没有构建步骤（源码即产物）。

## 免责声明

本插件是**非官方**的网页端客户端：它自己构造请求发给 MiMo 的私有接口，不经过任何中间转发。

逆向网页端本身**违反服务条款**，风险是"判罚多严"而不是"会不会被抓到"。
要求稳定性请改用小米官方的 MiMo API（OpenAI 兼容，用 API Key）。

## 许可

Apache-2.0
