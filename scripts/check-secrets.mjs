#!/usr/bin/env node
// 推送前发布检查（pre-push publish audit）
//
// 存在理由（真实事故）：2026-09-28 首次发布时把整个本地开发目录推上了公开仓库，
// 导致内部文档（含所有者身份、商业计划、协作分工说明）公开可见。
// 事后清理极其昂贵：dependabot 的 PR ref 被 GitHub 永久冻结，API 无法删除，
// 最终只能把旧仓库改名为私有 + 新建仓库。
//
// 因此本检查在**推送前**扫描两类风险：
//   A. 凭据类：密钥、令牌、私钥、硬编码口令
//   B. 内部资料类：不应公开的协作文档、商业信息、身份信息
//
// 跳过方式：不要跳过。若确有正当内容命中，调窄规则或加入 ALLOWLIST 并说明理由。
//
// 运行：npm run check:secrets

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TEXT_EXT = /\.(js|mjs|cjs|json|md|yml|yaml|txt|html|ps1|sh|env|toml|ini)$/

/**
 * 只扫描**将被推送的文件**（git 跟踪的），不扫磁盘上的全部文件。
 *
 * 为什么：内部资料（AGENTS.md / workflow.md / docs/*）在本地磁盘上是存在的，
 * 用于开发流程，但被 .gitignore 排除、不会进入公开仓库。
 * 若扫描全部磁盘文件，这些正当的内部文件会产生大量误报，
 * 而误报会导致这个检查被忽略——那就等于没有检查。
 */
function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: ROOT })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && TEXT_EXT.test(l))
}

/** A. 凭据类规则。 */
const CREDENTIAL_RULES = [
  [/sk-[A-Za-z0-9]{20,}/g, 'OpenAI 风格 API 密钥'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/g, 'Anthropic API 密钥'],
  [/ghp_[A-Za-z0-9]{20,}/g, 'GitHub personal access token'],
  [/gho_[A-Za-z0-9]{20,}/g, 'GitHub OAuth token'],
  [/ghs_[A-Za-z0-9]{20,}/g, 'GitHub App token'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, 'GitHub fine-grained PAT'],
  [/AKIA[0-9A-Z]{16}/g, 'AWS access key id'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '私钥文件内容'],
  [/(password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"]{8,}['"]/gi, '硬编码凭据'],
  [/\b\d{17,19}\b/g, '疑似长数字 ID（手机号/身份证）'],
]

/**
 * B. 内部资料类规则。
 * 命中即说明有不应公开的内容混入了待推送文件。
 * 注意：全部必须带 g 标志，供 matchAll 使用。
 */
const INTERNAL_RULES = [
  // 这些文件名一旦出现在公开仓库即为事故
  [/^\s*#\s*dsh-resume\s+项目工作规范/mg, '内部协作文档（AGENTS.md 内容）'],
  [/AI\s*助手必读/g, '内部分工表述'],
  [/通过\s*AI\s*完成全部执行|AI\s*产出全部代码|不亲自写代码/g, '内部分工表述'],
  [/所有者(目标|身份|明确|定)/g, '内部称谓'],
  // 商业与个人规划
  [/闲鱼|代充|号池|黑卡/g, '商业计划'],
  [/月入|现金流|副业线|装机量是核心\s*KPI/g, '商业指标'],
  // 内部流程文档名（在公开文件中被引用即为泄漏信号）
  [/docs\/GOAL\.md|docs\/HANDOFF\.md|LOAD-TEST-RESULT\.md/g, '内部文档引用'],
]

/** 允许的例外：正当的示例值与经确认的用途。 */
const ALLOWLIST = [
  /138-0000-0000/, // 示例手机号
  /candidate@example\.com/,
  /example\.com/,
  /0{4,}/,
  // 本文件自身的规则定义里当然会出现这些词
  /INTERNAL_RULES|CREDENTIAL_RULES/,
]

const findings = []
let scanned = 0

for (const rel of listTrackedFiles()) {
  // 跳过本文件自身：它的规则定义里当然会出现这些关键词
  if (rel === 'scripts/check-secrets.mjs') continue

  const full = join(ROOT, rel)
  let content
  try {
    content = readFileSync(full, 'utf8')
  } catch {
    continue // 已从工作区删除但仍在索引中的文件
  }
  scanned += 1
  const lines = content.split('\n')

  for (const [rules, category] of [
    [CREDENTIAL_RULES, '凭据'],
    [INTERNAL_RULES, '内部资料'],
  ]) {
    for (const [re, label] of rules) {
      for (const match of content.matchAll(re)) {
        for (const lineNo of collectLineNumbers(lines, match[0])) {
          const lineText = lines[lineNo - 1] ?? ''
          if (ALLOWLIST.some((a) => a.test(lineText))) continue
          findings.push({
            file: rel,
            line: lineNo,
            category,
            label,
            preview: lineText.trim().slice(0, 70),
          })
        }
      }
    }
  }
}

/** 找出某段文本出现在哪些行（用于精确定位与逐行 allowlist）。 */
function collectLineNumbers(lines, needle) {
  const hits = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(needle)) hits.push(i + 1)
  }
  return hits.length > 0 ? hits : [1]
}

if (findings.length === 0) {
  console.log(`✅ 发布检查通过（扫描 ${scanned} 个待推送文件，无凭据、无内部资料）`)
  process.exit(0)
}

const byCategory = new Map()
for (const f of findings) {
  if (!byCategory.has(f.category)) byCategory.set(f.category, [])
  byCategory.get(f.category).push(f)
}

console.error(`❌ 发现 ${findings.length} 处不应发布的内容：\n`)
for (const [category, items] of byCategory) {
  console.error(`【${category}】`)
  for (const f of items) {
    console.error(`   ${f.file}:${f.line}  [${f.label}]`)
    console.error(`     ${f.preview}`)
  }
  console.error('')
}
console.error('推送前必须处理。凭据泄漏与内部资料泄漏一旦进入远端历史极难清除。')
process.exit(1)
