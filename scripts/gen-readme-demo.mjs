// 生成 README 用的真实演示输出
// 用途：README 中的示例必须与代码实际行为一致，不能是手写的"理想输出"。
// 运行：node scripts/gen-readme-demo.mjs
import { verifyRewrite } from '../src/guard.js'

const ORIGINAL = `## 项目经历
校园二手交易平台（前端负责人）
- 使用 Vue2 编写主要展示页面和商品列表模块
- 对接后端 REST 接口，完成登录与购物车功能
- 通过懒加载商品图片与合并请求，将首屏加载时间从 2.4s 缩短至 1.8s`

console.log('=========== 场景 1：模型偷偷加数据 ===========')
const attempt1 = `## 项目经历
校园二手交易平台（前端负责人）
- 使用 Vue2 编写主要展示页面和商品列表模块
- 对接后端 REST 接口，完成登录与购物车功能，接口响应时间优化 60%
- 通过懒加载商品图片与合并请求，将首屏加载时间从 2.4s 缩短至 1.8s`
const r1 = verifyRewrite({ original: ORIGINAL, rewritten: attempt1 })
console.log('verify_rewrite 返回：ok =', r1.ok)
console.log(JSON.stringify(r1.findings.map((f) => ({ code: f.code, evidence: f.evidence })), null, 1))

console.log('\n=========== 场景 2：模型把"参与"写成"主导" ===========')
const attempt2 = ORIGINAL.replace(
  '- 使用 Vue2 编写主要展示页面和商品列表模块',
  '- 主导使用 Vue2 编写主要展示页面和商品列表模块的架构设计',
)
const r2 = verifyRewrite({ original: ORIGINAL, rewritten: attempt2 })
console.log('verify_rewrite 返回：ok =', r2.ok)
console.log(JSON.stringify(r2.findings.map((f) => ({ code: f.code, evidence: f.evidence })), null, 1))

console.log('\n=========== 场景 3：凭空多出一条经历 ===========')
const attempt3 =
  ORIGINAL + '\n- 负责用户增长策略，主导社群运营体系搭建，实现月活翻倍'
const r3 = verifyRewrite({ original: ORIGINAL, rewritten: attempt3 })
console.log('verify_rewrite 返回：ok =', r3.ok)
console.log(JSON.stringify(r3.findings.map((f) => ({ code: f.code })), null, 1))

console.log('\n=========== 场景 4：合法改写（只强化措辞、保留全部事实）===========')
const legit = `## 项目经历
校园二手交易平台（前端负责人）
- 负责使用 Vue2 完成主要展示页面与商品列表模块的开发
- 完成与后端 REST 接口的对接，实现登录与购物车功能
- 通过商品图片懒加载与请求合并，将首屏加载时间从 2.4s 缩短至 1.8s`
const r4 = verifyRewrite({ original: ORIGINAL, rewritten: legit })
console.log('verify_rewrite 返回：ok =', r4.ok)
console.log('findings 数量：', r4.findings.length)
console.log('原文数字统计：', JSON.stringify(r4.stats))
