#!/usr/bin/env node
// 占位符残留检查（placeholder audit）
//
// 存在理由：发布前必须确保没有 OWNER / YOUR_USERNAME 之类的占位符遗留在
// 实际生效的文件里（README、package.json、工作流），否则用户点到坏链接。
//
// 关键设计：区分「活跃占位符」与「历史记录中的引用」。
//   - 活跃：README / package.json / .github/ 等面向用户的文件里出现 OWNER
//   - 历史：变更记录类文档里描述"曾修复过 OWNER 占位符"是正当的
// 不做区分会产生误报，而误报会导致这个检查被忽略（比没有更糟）。
// 因此本检查只扫描 ACTIVE_FILES 清单内的文件，不扫全仓。
//
// 运行：npm run check:placeholders

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 面向用户、必须无占位符的文件。 */
const ACTIVE_FILES = [
  'README.md',
  'package.json',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  'cordis.patch.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/ISSUE_TEMPLATE/bug_report.md',
  '.github/ISSUE_TEMPLATE/feature_request.md',
  '.github/dependabot.yml',
]

/** 占位符模式。 */
const PATTERNS = [
  [/\bOWNER\b/g, 'OWNER'],
  [/<your[-_ ]?(username|user|name)>/gi, 'your-username'],
  [/\bYOUR_USERNAME\b/g, 'YOUR_USERNAME'],
  [/example\.com\/YOUR/gi, 'example.com/YOUR'],
  [/\bTODO\b/g, 'TODO'],
  [/\bFIXME\b/g, 'FIXME'],
  [/\bPLACEHOLDER\b/g, 'PLACEHOLDER'],
  [/\bXXX\b/g, 'XXX'],
]

/** 允许的例外。元素必须是 RegExp 本身，供 .test() 直接调用。 */
const ALLOWLIST = [
  // 本脚本自身的模式定义里当然会出现这些词
  /placeholder/i,
  // 中文文档里说明"不要写占位符"的句子
  /占位符/,
]

const problems = []
let checked = 0

for (const rel of ACTIVE_FILES) {
  const full = resolve(ROOT, rel)
  if (!existsSync(full)) {
    problems.push(`${rel}: 文件不存在（此清单需同步更新）`)
    continue
  }
  checked += 1
  const content = readFileSync(full, 'utf8')
  const lines = content.split('\n')

  for (const [re, label] of PATTERNS) {
    for (const match of content.matchAll(re)) {
      const lineNo = content.slice(0, match.index).split('\n').length
      const lineText = lines[lineNo - 1] ?? ''
      if (ALLOWLIST.some((a) => a.test(lineText))) continue
      problems.push(`${rel}:${lineNo}  发现占位符 ${label}`)
      problems.push(`    ${lineText.trim().slice(0, 100)}`)
    }
  }
}

// 反向验证：确认检查逻辑本身有效（防止 ALLOWLIST 过宽导致永远通过）
const SELF_TEST = 'see https://github.com/OWNER/repo'
const selfTestCaught = PATTERNS.some(([re]) => re.test(SELF_TEST)) &&
  !ALLOWLIST.some((a) => a.test(SELF_TEST))

if (!selfTestCaught) {
  console.error('❌ 自检失败：检查逻辑无法识别明显的占位符，ALLOWLIST 可能过宽。')
  process.exit(1)
}

if (problems.length === 0) {
  console.log(`✅ 占位符检查通过（检查 ${checked} 个面向用户的文件，自检有效）`)
  process.exit(0)
}

console.error(`❌ 发现 ${problems.length} 处占位符残留：\n`)
for (const p of problems) console.error(`   ${p}`)
console.error('\n这些会渲染成坏链接或无效配置，发布前必须替换为真实值。')
process.exit(1)
