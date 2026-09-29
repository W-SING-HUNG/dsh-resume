#!/usr/bin/env node
// 反虚构守卫的行为验证（guard behavior self-test）
//
// 【为什么需要这个文件】
// 守卫的价值在于"能不能真拦住编造"。若 CI 只做静态关键词检查
// （例如确认 prompt.js 里还写着"禁止编造"），那么一个被改成
// `return { ok: true }` 的守卫实现依然会让流水线全绿——检查形同虚设。
//
// 因此本脚本做**行为级验证**：真实调用守卫，断言
//   - 编造内容 → 必须被拦住（ok=false）
//   - 合法改写 → 必须被放行（ok=true，不误报）
// 两类都必须正确，任一不符即退出码 1。
//
// 本地运行：npm run check:guard
// CI：在 Architecture guards 任务中调用

import { verifyRewrite, GUARD_VERSION } from '../src/guard.js'

/**
 * 验证用例。
 * expectOk = false 表示「必须判定为不通过」（拦住编造）
 * expectOk = true  表示「必须判定为通过」（不得误报）
 */
const CASES = [
  {
    name: '编造数字',
    original: '负责公司官网前端开发。',
    rewritten: '负责公司官网前端开发，性能提升 45%。',
    expectOk: false,
  },
  {
    name: '编造数字-服务人数',
    original: '负责接口开发。',
    rewritten: '负责接口开发，累计服务 8 万用户。',
    expectOk: false,
  },
  {
    name: '编造机构',
    original: '在某互联网公司实习，负责接口开发。',
    rewritten: '在字节跳动公司实习，负责接口开发。',
    expectOk: false,
  },
  {
    name: '编造英文专名',
    original: 'Built tooling with Python.',
    rewritten: 'Built tooling with Python and Kubernetes.',
    expectOk: false,
  },
  {
    // 职责升格：比编数字更隐蔽，面试追问时才暴露
    name: '职责升格：参与 → 主导',
    original: '参与了登录模块开发。',
    rewritten: '主导登录模块开发。',
    expectOk: false,
  },
  {
    // 关键回归：`协助完成` 含「协助」(辅助) 与「完成」(负责) 两个动词，
    // 若按"全文最高层"判定会漏报，必须按"最低层"判定
    name: '职责升格：协助 → 负责（含补语干扰）',
    original: '协助完成接口对接。',
    rewritten: '负责接口对接。',
    expectOk: false,
  },
  {
    name: '日期被改动：年份',
    original: '2019.06 - 2021.08 在某公司实习。',
    rewritten: '2020.06 - 2021.08 在某公司实习。',
    expectOk: false,
  },
  {
    // 特征比对抓不住：新条目不含新数字/新机构，靠逐条内容比对发现
    name: '整条新增：凭空多出一条经历',
    original: '- 使用 Vue2 完成商品列表模块开发；\n- 对接后端 REST 接口，完成登录功能；',
    rewritten:
      '- 使用 Vue2 完成商品列表模块开发；\n- 对接后端 REST 接口，完成登录功能；\n- 负责用户增长策略，主导社群运营体系搭建。',
    expectOk: false,
  },
  {
    name: '关键词虚报：声称覆盖但未写入',
    original: '负责前端开发，使用 Vue2。',
    rewritten: '负责前端开发，使用 Vue2。',
    claimedKeywords: ['Vue2', 'TypeScript'],
    expectOk: false,
  },
  {
    name: '合法改写：纯措辞强化（保持同层职责动词）',
    original: '负责前端开发，优化页面加载速度。',
    rewritten: '负责前端开发，通过重构关键渲染路径显著提升页面加载速度。',
    expectOk: true,
  },
  {
    name: '合法改写：保留原数字',
    original: '提升页面加载速度 40%，服务 12000 名用户。',
    rewritten: '面向 12000 名用户，将页面加载速度提升 40%。',
    expectOk: true,
  },
  {
    name: '合法改写：数字千分位写法变化',
    original: '服务 12000 名用户。',
    rewritten: '服务 12,000 名用户。',
    expectOk: true,
  },
  {
    name: '合法改写：日期格式变化但时间点不变',
    original: '2019年6月入职。',
    rewritten: '2019.06 入职。',
    expectOk: true,
  },
  {
    // 回归用例：中文无词边界，「主导公司」曾是误报。
    // 注意改写须保持同层职责动词，否则会触发职责升格（那是另一个检查项）
    name: '不得误报：动词 + 机构后缀',
    original: '负责公司官网前端开发，使用了 Vue2。',
    rewritten: '负责公司官网前端开发工作，基于 Vue2 完成核心模块重构。',
    expectOk: true,
  },
  {
    name: '不得误报：同一机构名修饰语变化',
    original: '在清华大学参与课题研究。',
    rewritten: '在清华大学深度参与课题研究并产出成果。',
    expectOk: true,
  },
  {
    name: '不得误报：同层职责动词的修辞强化',
    original: '负责前端开发。',
    rewritten: '负责并持续推进前端开发工作。',
    expectOk: true,
  },
]

let failed = 0
for (const testCase of CASES) {
  const report = verifyRewrite({
    original: testCase.original,
    rewritten: testCase.rewritten,
    claimedKeywords: testCase.claimedKeywords,
  })
  if (report.ok !== testCase.expectOk) {
    console.error(
      `✗ 守卫行为错误 [${testCase.name}]：期望 ok=${testCase.expectOk}，实际 ok=${report.ok}`,
    )
    for (const f of report.findings) {
      console.error(`    ${f.code}（${f.severity}）：${f.message}`)
    }
    failed += 1
  } else {
    console.log(`✓ ${testCase.name}（ok=${report.ok}）`)
  }
}

if (failed > 0) {
  console.error(`\n守卫行为验证失败：${failed}/${CASES.length} 个用例不符预期。`)
  console.error('反虚构是本项目的存在理由，守卫失效等于项目失效。')
  process.exit(1)
}

console.log(
  `\n✅ 守卫行为验证通过（${CASES.length} 个用例，规则版本 ${GUARD_VERSION}）：编造被拦、合法放行。`,
)
