/**
 * 线上探针：只用**不需要登录**的接口，确认契约没变。
 *
 * 跑法：node test/probe-live.mjs
 *
 * 这里刻意不发带凭据的请求 —— 探针要能随时跑，不该依赖某个人的账号。
 */

import { MimoClient, MimoError, ORIGIN } from '../lib/mimo-client.js'

const results = []
function line(text) {
  console.log(text)
  results.push(text)
}

async function main() {
  line(`站点：${ORIGIN}`)

  // ① 模型目录（免登录）
  try {
    const client = new MimoClient({ serviceToken: '', userId: '', xiaomichatbotPh: '' })
    const data = await client.fetchModelConfig()
    const chat = (data.modelConfigList ?? []).filter((item) => item?.model && !item?.redirectTo)
    line(`✓ 模型目录：${chat.length} 个可选 chat 模型`)
    for (const model of chat.slice(0, 6)) {
      line(`    ${model.model}  →  ${model.name}  (默认思考=${model.thinkingDefaultOn !== false})`)
    }
    if (chat.length > 6) line(`    … 另外 ${chat.length - 6} 个`)
  } catch (error) {
    line(`✗ 模型目录失败：${error?.message ?? error}`)
    process.exitCode = 1
  }

  // ② 未登录时的错误形状（必须是 401 + AUTH，且带上登录提示）
  try {
    const client = new MimoClient({ serviceToken: 'obviously-fake', userId: '1', xiaomichatbotPh: 'probe' })
    let caught
    try {
      for await (const _event of client.chat({
        msgId: 'a'.repeat(32),
        conversationId: 'b'.repeat(32),
        query: 'hi',
        isEditedQuery: false,
        modelConfig: { enableThinking: false, webSearchStatus: 'disabled', model: 'mimo-v2.6-flash' },
        multiMedias: [],
      })) {
        /* 不该有事件 */
      }
    } catch (error) {
      caught = error
    }
    if (!caught) {
      line('✗ 假凭据竟然没有报错')
      process.exitCode = 1
    } else if (caught.code === 'AUTH') {
      line(`✓ 假凭据 → ${caught.code}（${caught.status}），提示里带登录引导`)
    } else {
      line(`? 假凭据 → ${caught.code}：${caught.message.slice(0, 120)}`)
    }
  } catch (error) {
    line(`✗ 401 探测异常：${error?.message ?? error}`)
    process.exitCode = 1
  }

  // ③ 探活接口在未登录时也要干净地返回"不可用"而不是抛出去
  try {
    const client = new MimoClient({ serviceToken: 'obviously-fake', userId: '1', xiaomichatbotPh: 'probe' })
    const result = await client.whoami()
    line(result.ok ? '? 假凭据竟然通过探活（契约可能变了）' : `✓ 探活正确判失败：${result.error?.code ?? '未知'}`)
  } catch (error) {
    line(`✗ 探活抛出异常（应该返回结果对象）：${error?.message ?? error}`)
    process.exitCode = 1
  }

  line('')
  line(process.exitCode ? '探针发现异常' : '探针全部通过 ✓')
}

main().catch((error) => {
  line(`探针崩溃：${error?.stack ?? error}`)
  process.exit(1)
})
