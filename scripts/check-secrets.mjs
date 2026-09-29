#!/usr/bin/env node
// 推送前发布检查（pre-push publish audit）
//
// 扫描三类风险：
//   A. 凭据类：密钥、令牌、私钥、硬编码口令（规则公开——这些是通用模式）
//   B. 私密内容类：规则从 .git/info/private-terms.txt 读取（见下）
//   C. 内部路径类：内部资料文件被纳入版本库，名单从 .git/info/exclude 读取
//
// ── 为什么规则来源分成两处 ────────────────────────────────────────────
// 本脚本是**公开文件**，会被任何人读到。而"什么内容算私密"这个定义本身
// 就是私密的：如果把具体的屏蔽词表写在这里，防护规则就变成了泄漏源——
// 读代码的人直接看到这些词。因此 B/C 两类规则的名单放在 .git/info/ 下
// （git 的本地目录，永不进入版本库、永不上传），本脚本运行时读取它。
// 忽略行为与 .gitignore 完全等价（两者同为 git 的排除来源），
// 但公开仓库里看不到任何名单。
//
// 本地文件缺失时（如 CI 的干净克隆）自动降级：仍执行 A 类与通用检查，
// 并给出提示。这是可接受的——干净克隆里本来就没有内部文件。
//
// 跳过方式：不要跳过。若确有正当内容命中，调窄规则或加入 ALLOWLIST 并说明理由。
//
// 运行：npm run check:secrets

import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TEXT_EXT = /\.(js|mjs|cjs|json|md|yml|yaml|txt|html|ps1|sh|env|toml|ini)$/

/** 本地（不入库）文件的路径。 */
const LOCAL_EXCLUDE = join(ROOT, '.git', 'info', 'exclude')
const LOCAL_TERMS = join(ROOT, '.git', 'info', 'private-terms.txt')

/**
 * 只扫描**将被推送的文件**（git 跟踪的），不扫磁盘上的全部文件。
 *
 * 为什么：内部资料在本地磁盘上是存在的，用于开发流程，但被排除、不会进入
 * 公开仓库。若扫描全部磁盘文件，这些正当的内部文件会产生大量误报，
 * 而误报会导致这个检查被忽略——那就等于没有检查。
 */
function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: ROOT })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && TEXT_EXT.test(l))
}

/** A. 凭据类规则。通用模式，公开无妨。 */
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
 * 读取本地的私密词规则（不入库）。
 * 格式：每行 `正则` 或 `正则|标签`；空行与 # 开头行忽略。
 * @returns {Array<[RegExp, string]>} 规则数组；文件缺失时为空数组
 */
function loadPrivateRules() {
  if (!existsSync(LOCAL_TERMS)) return []
  const rules = []
  for (const raw of readFileSync(LOCAL_TERMS, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const idx = line.lastIndexOf('|')
    const pattern = idx > 0 ? line.slice(0, idx).trim() : line
    const label = idx > 0 ? line.slice(idx + 1).trim() : '私密内容'
    if (pattern === '') continue
    try {
      rules.push([new RegExp(pattern, 'g'), label])
    } catch {
      // 规则写错了不该让检查崩掉，但要让人看见
      console.error(`⚠  private-terms.txt 中的规则无法解析：${line}`)
    }
  }
  return rules
}

/**
 * 读取本地排除名单（.git/info/exclude），取出其中的内部资料路径。
 * 跳过注释与通配符行，只保留具体的文件/目录条目。
 * @returns {string[]} 内部资料路径
 */
function loadInternalPaths() {
  if (!existsSync(LOCAL_EXCLUDE)) return []
  return readFileSync(LOCAL_EXCLUDE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('!'))
    .filter((l) => !l.includes('*')) // 通配条目无法做精确路径比对，跳过
    .map((l) => l.replace(/\/$/, ''))
}

/** 判断一个被跟踪路径是否属于内部资料。 */
function isInternalPath(rel, internalPaths) {
  const p = rel.replace(/\\/g, '/')
  return internalPaths.some((prefix) => p === prefix || p.startsWith(prefix + '/'))
}

/** 允许的例外：正当的示例值与经确认的用途。 */
const ALLOWLIST = [
  /138-0000-0000/, // 示例手机号
  /candidate@example\.com/,
  /example\.com/,
  /0{4,}/,
  // 本文件自身的规则定义里当然会出现这些词
  /CREDENTIAL_RULES|ALLOWLIST/,
  // 自检探针
  /SELF_TEST/,
]

const internalPaths = loadInternalPaths()
const privateRules = loadPrivateRules()
const findings = []
let scanned = 0

if (internalPaths.length === 0 && privateRules.length === 0) {
  console.log(
    'ℹ 未找到本地规则文件（.git/info/private-terms.txt、.git/info/exclude 的内部条目）。',
  )
  console.log('  仅执行凭据检查。若这是你的开发机，请确认本地规则文件存在。')
}

for (const rel of listTrackedFiles()) {
  // 跳过本文件自身：它的规则定义里当然会出现这些关键词
  if (rel === 'scripts/check-secrets.mjs') continue

  // C 类：内部路径级拦截（与内容无关，文件名即证据）
  if (isInternalPath(rel, internalPaths)) {
    findings.push({
      file: rel,
      line: 0,
      category: '内部资料（路径级）',
      label: '内部资料文件被纳入版本库',
      preview: '该文件在本地排除名单中，不应被跟踪；请从索引移除（git rm --cached）',
    })
    continue
  }

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
    [privateRules, '私密内容'],
  ]) {
    for (const [re, label] of rules) {
      // 逐行匹配：规则来自本地文件，无法保证带 g 标志，故按行处理
      for (let i = 0; i < lines.length; i += 1) {
        const lineText = lines[i]
        const probe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
        probe.lastIndex = 0
        if (!probe.test(lineText)) continue
        if (ALLOWLIST.some((a) => a.test(lineText))) continue
        findings.push({
          file: rel,
          line: i + 1,
          category,
          label,
          preview: lineText.trim().slice(0, 70),
        })
      }
    }
  }
}

// ── 自检：确认检查逻辑本身有效（防止 ALLOWLIST 过宽导致永远通过）───
const SELF_TEST = 'see https://github.com/OWNER/repo with sk-ABCDEFGHIJKLMNOPQRSTUVWX'
const selfTestCaught = CREDENTIAL_RULES.some(([re, label]) => {
  if (label !== 'OpenAI 风格 API 密钥') return false
  const probe = new RegExp(re.source, 'g')
  return probe.test(SELF_TEST) && !ALLOWLIST.some((a) => a.test(SELF_TEST))
})
if (!selfTestCaught) {
  console.error('❌ 自检失败：检查逻辑无法识别明显的凭据，ALLOWLIST 可能过宽。')
  process.exit(1)
}

if (findings.length === 0) {
  console.log(
    `✅ 发布检查通过（扫描 ${scanned} 个待推送文件；` +
      `凭据规则 ${CREDENTIAL_RULES.length} 条、本地私密规则 ${privateRules.length} 条、` +
      `内部路径 ${internalPaths.length} 条）`,
  )
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
    console.error(f.line > 0 ? `   ${f.file}:${f.line}  [${f.label}]` : `   ${f.file}  [${f.label}]`)
    console.error(`     ${f.preview}`)
  }
  console.error('')
}
console.error('推送前必须处理。凭据与内部资料一旦进入远端历史极难清除。')
process.exit(1)
