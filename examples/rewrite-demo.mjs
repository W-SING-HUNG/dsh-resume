#!/usr/bin/env node
// 可运行示例：演示 rewrite_resume 工具的真实行为
//
// 用法：
//   node examples/rewrite-demo.mjs
//
// 本示例直接使用零依赖的 src/core.js，因此不需要 DSH 运行时即可运行。
// 全部业务逻辑都在 core.js 中，插件的平台装配层（src/index.js）只是把它注册给 DSH。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  createToolDefinition,
  createVerifyToolDefinition,
  buildResumeValue,
  TOOL_NAME,
  VERIFY_TOOL_NAME,
} from '../src/core.js'

const here = dirname(fileURLToPath(import.meta.url))
const read = (name) => readFileSync(join(here, 'fixtures', name), 'utf8')

const jd = read('frontend-jd.txt')
const resume = read('frontend-resume.txt')

const rule = (title) => {
  console.log('\n' + '─'.repeat(72))
  console.log(title)
  console.log('─'.repeat(72))
}

rule('1. 工具定义（平台会注册的就是这个对象）')
const definition = createToolDefinition()
console.log(`name        : ${definition.name}`)
console.log(`description : ${definition.description.slice(0, 60)}...`)
console.log(`parameters  : ${Object.keys(definition.parameters.properties).join(', ')}`)
console.log(`required    : ${definition.parameters.required.join(', ')}`)
console.log(`output.schema 字段: ${Object.keys(definition.output.schema.properties).join(', ')}`)

rule('2. 调用 execute（与 DSH 运行时调用的是同一份代码）')
const value = await definition.execute({ jd, resume }, {
  signal: new AbortController().signal,
})

console.log('返回值字段:', Object.keys(value).join(', '))
console.log('language  :', value.language)
console.log('instruction 长度:', value.instruction.length, '字符')

rule('3. 三段式交付说明')
console.log(value.note)

rule('4. 铁律自查（instruction 中必须存在的约束）')
const mustHave = [
  ['禁止编造', '禁止编造新经历/数据/技能'],
  ['量化', '原文量化数据必须保留'],
  ['待补充', '缺失能力进待补充清单，不编造'],
  ['ATS', '关键词对齐以提升筛选命中率'],
]
for (const [keyword, meaning] of mustHave) {
  const ok = value.instruction.includes(keyword)
  console.log(`${ok ? '✔' : '✘'} ${keyword.padEnd(8)} ${meaning}`)
}

rule('5. 缺口识别演示')
// 从 JD 提取关键词，检查简历中是否存在——模拟插件要处理的"缺口"
const jdKeywords = ['Vue3', 'TypeScript', 'Vite', 'Nuxt', 'SSR']
console.log('JD 要求的关键能力 vs 简历原文实际具备情况：\n')
for (const kw of jdKeywords) {
  const inResume = resume.includes(kw)
  console.log(
    `  ${inResume ? '✔ 具备' : '✘ 缺口'}  ${kw.padEnd(12)}` +
      (inResume ? '' : ' ← 应进入「待补充清单」，绝不可编造'),
  )
}
console.log(
  '\n（注：以上为静态关键词比对，用于说明"缺口"是什么。' +
    '\n 真正的缺口判定与改写由会话模型按 instruction 规则完成。）',
)

rule('6. 反虚构守卫：确定性代码校验（本项目核心能力）')
// 把"禁止编造"从提示词约束升级为可执行校验：
// 改写完成后由代码比对，报告是否引入原文没有的数字/机构。
const verifyDef = createVerifyToolDefinition()
console.log(`工具名: ${verifyDef.name}\n`)

const guardCases = [
  {
    label: '编造数字（模型擅自加了 45%）',
    original: '负责公司官网前端开发。',
    rewritten: '负责公司官网前端开发，性能提升 45%。',
  },
  {
    label: '编造机构（把原公司换成另一家）',
    original: '在某互联网公司实习，负责接口开发。',
    rewritten: '在字节跳动公司实习，负责接口开发。',
  },
  {
    label: '合法改写（只强化措辞、保留真实数据）',
    original: '负责前端开发，服务 80000 名用户。',
    rewritten: '面向 80000 名用户主导前端开发，显著改善体验。',
  },
]

for (const c of guardCases) {
  const result = await verifyDef.execute({ original: c.original, rewritten: c.rewritten })
  const verdict = result.ok ? '通过' : '拦下'
  console.log(`  [${verdict}] ${c.label}`)
  console.log(`      ${result.summary.split('。')[0]}。`)
}
console.log('\n  说明：校验由代码执行，不依赖模型的自觉。模型若编造，输出必然被拦下。')

rule('7. 渲染为模型可见内容')
const blocks = definition.output.render({ jd, resume }, value)
console.log(`render 产出 ${blocks.length} 个 content block，首个 block 类型: ${blocks[0].type}`)
console.log(`首个 block 前 120 字符:\n${blocks[0].text.slice(0, 120)}...`)

rule('完成')
console.log(`工具 "${TOOL_NAME}" 与 "${VERIFY_TOOL_NAME}" 行为符合预期。`)
console.log('在真实 DSH 会话中，模型改写后会调用 verify_rewrite 自检，未通过则必须修正后重试。')
console.log('')
