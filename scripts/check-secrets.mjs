#!/usr/bin/env node
// 推送前安全检查（pre-push security scan）
//
// 存在理由：开源仓库一旦推送，历史里的密钥几乎无法彻底清除。
// 推送前扫描比事后补救便宜得多。
//
// 运行：npm run check:secrets

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.pnpm-store'])
const TEXT_EXT = /\.(js|mjs|cjs|json|md|yml|yaml|txt|html|ps1|sh|env|toml|ini)$/

/** 扫描规则：正则 + 说明。 */
const RULES = [
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

/** 允许的例外：文档里的示例值与测试夹具。 */
const ALLOWLIST = [
  /138-0000-0000/, // examples 里的示例手机号
  /zhangsan@example\.com/,
  /alex@example\.com/,
  /example\.com/,
  /0{4,}/,
]

const findings = []
let scanned = 0

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full)
      continue
    }
    if (!TEXT_EXT.test(entry)) continue
    scanned += 1
    const content = readFileSync(full, 'utf8')
    for (const [re, label] of RULES) {
      for (const match of content.matchAll(re)) {
        const value = match[0]
        if (ALLOWLIST.some((a) => a.test(value))) continue
        const line = content.slice(0, match.index).split('\n').length
        findings.push({
          file: relative(ROOT, full).replace(/\\/g, '/'),
          line,
          label,
          preview: value.slice(0, 60),
        })
      }
    }
  }
}

walk(ROOT)

if (findings.length === 0) {
  console.log(`✅ 安全检查通过（扫描 ${scanned} 个文本文件，未发现凭据或敏感信息）`)
  process.exit(0)
}

console.error(`❌ 发现 ${findings.length} 处潜在敏感信息：\n`)
for (const f of findings) {
  console.error(`   ${f.file}:${f.line}  [${f.label}]`)
  console.error(`     ${f.preview}`)
}
console.error('\n推送前必须处理：移除真实凭据，或确认是安全的示例值并加入 ALLOWLIST。')
process.exit(1)
