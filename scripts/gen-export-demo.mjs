// 端到端交付演示：从简历原文 → 校验 → 导出真实可投递文件
// 运行：node scripts/gen-export-demo.mjs
//
// 注意：本脚本使用**装配层的真实写入实现**（writeResumeFile），
// 而不是自定义的假写入函数——否则安全边界（不覆盖已有文件等）
// 不会被验证到，演示会与生产行为不一致。
import { writeFileSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { verifyRewrite } from '../src/guard.js'
import { createExportToolDefinition } from '../src/core.js'
import { writeResumeFile } from '../src/index.js'

const OUT = join(process.cwd(), 'demo-output')
if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const ORIGINAL = `## 项目经历
校园二手交易平台（前端负责人）
- 使用 Vue2 编写主要展示页面和商品列表模块
- 对接后端 REST 接口，完成登录与购物车功能
- 通过懒加载商品图片与合并请求，将首屏加载时间从 2.4s 缩短至 1.8s`

// 合法改写（只强化措辞）
const REWRITTEN = `# 示例候选人

求职意向：前端开发工程师

## 项目经历
### 校园二手交易平台（前端负责人）
- 负责使用 Vue2 完成主要展示页面与商品列表模块的开发
- 完成与后端 REST 接口的对接，实现登录与购物车功能
- 通过商品图片懒加载与请求合并，将首屏加载时间从 2.4s 缩短至 1.8s`

console.log('=== 第 1 步：反虚构校验 ===')
const report = verifyRewrite({ original: ORIGINAL, rewritten: REWRITTEN })
console.log('ok =', report.ok, '| error 数 =', report.findings.filter((f) => f.severity === 'error').length)
if (!report.ok) {
  console.log('校验未通过，流程应中止：')
  report.findings.forEach((f) => console.log('  -', f.code))
  process.exit(1)
}

console.log('\n=== 第 2 步：导出可投递文件 ===')
const tool = createExportToolDefinition(writeResumeFile)

const docxPath = join(OUT, '投递版简历.docx')
const r1 = await tool.execute({ resume: REWRITTEN, outputPath: docxPath })
console.log('DOCX:', r1.summary)

const mdPath = join(OUT, '投递版简历.md')
const r2 = await tool.execute({ resume: REWRITTEN, outputPath: mdPath })
console.log('MD  :', r2.bytes, '字节')

console.log('\n=== 第 3 步：留档版（带附录）===')
const archivePath = join(OUT, '留档版.md')
const r3 = await tool.execute({
  resume: REWRITTEN,
  outputPath: archivePath,
  changes: '1. 补全姓名与求职意向\n2. 措辞由"使用"改为"负责使用"，保持同层职责',
  gaps: 'Vue3 / TypeScript / Vite（JD 要求但简历缺失，未编造）',
  verification: `ok=true，规则版本 ${report.guardVersion}`,
  includeAppendix: true,
})
console.log('留档:', r3.bytes, '字节')

console.log('\n=== 第 4 步：安全边界验证 ===')
try {
  await tool.execute({ resume: REWRITTEN, outputPath: docxPath })
  console.log('!! 不应成功——已存在的文件被覆盖了')
} catch (err) {
  console.log('✓ 重复导出被拒绝:', err.message.split('\n')[0].slice(0, 50))
}

console.log('\n生成的文件：')
for (const f of ['投递版简历.docx', '投递版简历.md', '留档版.md']) {
  const p = join(OUT, f)
  if (existsSync(p)) {
    const { statSync } = await import('node:fs')
    console.log(`  ${f}  ${statSync(p).size} 字节`)
  }
}
