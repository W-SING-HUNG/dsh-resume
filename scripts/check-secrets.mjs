#!/usr/bin/env node
// 推送前发布检查（pre-push publish audit）
//
// 分两层，各自独立可验证：
//
//   ┌─ 公开层（随仓库分发，任何人 clone 后都能跑出真实结果）───────────┐
//   │  A. 凭据类：密钥、令牌、私钥、硬编码口令                        │
//   │  B. 内部资料引用：公开文件里出现内部文档路径即为泄漏信号        │
//   │  C. 自检探针：确认检查逻辑本身有效                              │
//   └──────────────────────────────────────────────────────────────────┘
//
//   ┌─ 本地层（规则文件在 .git/info/，永不入库，缺失时静默降级）───────┐
//   │  D. 私密内容词：项目专属的屏蔽词（规则本身是敏感的）            │
//   │  E. 内部路径拦截：内部资料文件被误提交进版本库                  │
//   └──────────────────────────────────────────────────────────────────┘
//
// 为什么 E 层也在本地：内部文档的**文件名**本身就是不该公开的信息
// （外人看到 `GOAL.md` 这些名字即知项目有内部决策与商业文档）。
// 而在 clone 环境里内部文件根本不存在，因此 E 层天然不需要——
// 它只在开发机上生效，正是它该在的地方。
//
// 为什么分层：本地层规则不能公开（规则内容即敏感信息），
// 但公开层必须对任何 clone 者都有效——否则外人看到的是
// "扫描 31 个文件、检查 0 条规则"，那会让人以为审计形同虚设。
//
// 运行：npm run check:secrets

import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TEXT_EXT = /\.(js|mjs|cjs|json|md|yml|yaml|txt|html|ps1|sh|env|toml|ini)$/

/** 本地（不入库）规则文件路径。 */
const LOCAL_TERMS = join(ROOT, '.git', 'info', 'private-terms.txt')
const LOCAL_EXCLUDE = join(ROOT, '.git', 'info', 'exclude')

/**
 * 只扫描**将被推送的文件**（git 跟踪的）。
 *
 * 为什么：本地开发资料存在但不进入公开仓库。若扫描全部磁盘文件，
 * 这些正当的内部文件会产生大量误报，而误报会导致检查被忽略——比没有更糟。
 */
function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: ROOT })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && TEXT_EXT.test(l))
}

/** A. 凭据类规则（公开层）。通用模式，公开无妨。 */
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
 * B. 内部资料引用规则（公开层）。
 *
 * 只检查"公开文件里有没有引用本地专属文档"这一件事——不涉及任何私密词，
 * 因此规则本身可以公开。这条对任何 clone 者都有意义：
 * 它保证仓库不会出现指向不存在文件的坏链接。
 */
const DANGLING_INTERNAL_REF_RULES = [
  // 指向本地专属文档的路径引用（这些文件被 .git/info/exclude 排除，不随 clone 分发）
  [/docs\/HANDOFF\.md|docs\/GOAL\.md|docs\/LOAD-TEST[^\s)`,。]*\.md/g, '引用了本地专属文档路径'],
]

/**
 * 读取本地私密词规则（D 层，不入库）。
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
      console.error(`⚠  private-terms.txt 中的规则无法解析：${line}`)
    }
  }
  return rules
}

/**
 * 读取本地排除名单（.git/info/exclude），取出其中的内部资料路径。
 * 用于 E 层路径级拦截：开发机上若把内部资料误加进索引，立即拦下。
 *
 * 跳过注释与否定行（`!` 开头是显式放行，不是内部资料）。
 * @returns {string[]} 内部资料路径模式
 */
function loadInternalPaths() {
  if (!existsSync(LOCAL_EXCLUDE)) return []
  return readFileSync(LOCAL_EXCLUDE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('!'))
    .filter((l) => !l.startsWith('node_modules') && !l.startsWith('coverage'))
    .map((l) => l.replace(/\/$/, ''))
}

/**
 * 判断一个被跟踪路径是否属于内部资料（E 层）。
 *
 * 判定方式：**直接问 git**，而不是自己解析名单。
 *
 * 为什么（真实事故，2026-09-28）：
 * 原先的实现是"读 .git/info/exclude 的条目，逐个前缀比对"。
 * 但有人新增了一份内部文档却忘了登记到名单里，
 * 于是检查放行、文件被提交进公开仓库——**枚举式名单必然滞后**。
 * 改为让 git 自己回答"这个文件是否被忽略"之后，
 * 名单里有没有登记都不影响判定：只要 git 认为它该被忽略，就是内部资料。
 *
 * 注：对已被跟踪的文件用 `git check-ignore` 会因 --no-index 需要而特殊处理；
 * 这里用 `git check-ignore --no-index` 查询路径规则本身。
 *
 * @param {string} rel 仓库相对路径
 * @returns {boolean} 是否被本地排除规则命中
 */
function isIgnoredByGit(rel) {
  try {
    // --no-index：即使文件已被跟踪也照常评估排除规则
    execFileSync('git', ['check-ignore', '--no-index', '-q', rel], { cwd: ROOT, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/** 兼容旧调用：路径是否属于内部资料（供使用模式列表的场景）。 */
function isInternalPath(rel, internalPaths) {
  const p = rel.replace(/\\/g, '/')
  if (internalPaths.some((prefix) => p === prefix || p.startsWith(prefix + '/'))) return true
  return false
}

/** 允许的例外：正当的示例值与经确认的用途。 */
const ALLOWLIST = [
  /138-0000-0000/, // 示例手机号
  /candidate@example\.com/,
  /example\.com/,
  /0{4,}/,
  // 本文件自身的规则定义里当然会出现这些词
  /CREDENTIAL_RULES|ALLOWLIST|DANGLING_INTERNAL_REF_RULES/,
  // 自检探针
  /SELF_TEST/,
]

const privateRules = loadPrivateRules()
const internalPaths = loadInternalPaths()
const findings = []
let scanned = 0

for (const rel of listTrackedFiles()) {
  // 跳过本文件自身：它的规则定义里当然会出现这些关键词
  if (rel === 'scripts/check-secrets.mjs') continue

  // E 层：内部路径级拦截。
  //
  // 判定由 git 给出（check-ignore），不看我们自己维护的名单 ——
  // 因为"名单忘了登记"正是上一版漏掉一份内部文档的原因。
  // 只要本地排除规则认为它该被忽略，而它却被跟踪了，就是事故。
  if (isIgnoredByGit(rel) || isInternalPath(rel, internalPaths)) {
    findings.push({
      file: rel,
      line: 0,
      category: '内部资料（路径级）',
      label: '内部资料文件被纳入版本库',
      preview: '该路径命中本地排除规则，不应被跟踪；请从索引移除（git rm --cached）',
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

  const layers = [
    [CREDENTIAL_RULES, '凭据'],
    [DANGLING_INTERNAL_REF_RULES, '内部资料引用'],
    [privateRules, '私密内容'],
  ]

  for (const [rules, category] of layers) {
    for (const [re, label] of rules) {
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
  const publicCount = CREDENTIAL_RULES.length + DANGLING_INTERNAL_REF_RULES.length
  const localNote =
    privateRules.length > 0
      ? `公开层规则 ${publicCount} 条 + 本地层规则 ${privateRules.length} 条`
      : `公开层规则 ${publicCount} 条（本地专属规则未加载，属正常：规则文件不随 clone 分发）`
  console.log(`✅ 发布检查通过（扫描 ${scanned} 个文件；${localNote}）`)
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
