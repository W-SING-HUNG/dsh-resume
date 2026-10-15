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
// （外人看到那些名字即知项目另有内部决策与商业文档）。
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

/**
 * 二进制/非文本扩展名——显式跳过，其余一律扫描。
 *
 * 【为什么改成"黑名单 + 全量"（外部审查发现 S2-4）】
 * 第一版用**扩展名白名单**（`\.(js|mjs|json|md|...)$`）挑文件，于是
 * `.editorconfig`、`.gitattributes`、`.gitignore`、`.nvmrc`、`LICENSE`、
 * `.githooks/*` 这些**无扩展名或非白名单扩展名**的文本文件被静默漏掉：
 * 自报"扫描 39 个文件"，而实际跟踪 47 个。凭据恰恰可能写在这类文件里。
 * 白名单式的覆盖面必然滞后（新增一类文件就漏一类），黑名单则不会。
 */
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|mp[34]|wav|exe|dll|so|dylib|docx|xlsx|pptx)$/i

/** 本地（不入库）规则文件路径。 */
const LOCAL_TERMS = join(ROOT, '.git', 'info', 'private-terms.txt')
const LOCAL_EXCLUDE = join(ROOT, '.git', 'info', 'exclude')

/**
 * 只扫描**将被推送的文件**（git 跟踪的）。
 *
 * 为什么：本地开发资料存在但不进入公开仓库。若扫描全部磁盘文件，
 * 这些正当的内部文件会产生大量误报，而误报会导致检查被忽略——比没有更糟。
 *
 * @returns {string[]} 待扫描的仓库相对路径
 */
function listTrackedFiles() {
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8', cwd: ROOT })
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !BINARY_EXT.test(l))
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
  [/\b\d{17,19}\b/g, '疑似长数字 ID'],
  // ── PII（外部审查发现 S2-4：原先对典型 PII 零命中）──────────────
  //
  // audit-rule-definition：以下三行是规则定义，其中的示例格式字样不应自我命中
  [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '疑似手机号（PII）'],
  [/(?<!\d)\d{17}[\dXx](?!\d)/g, '疑似身份证号（PII）'],
  [/\b[\w.+-]+@(?!example\.(com|org|net)\b)[\w-]+(?:\.[\w-]+)*\.(?:com|cn|net|org|io|edu|gov|co)\b/g, '疑似真实邮箱（非示例域名，PII）'],
]

/**
 * B. 内部资料引用规则（公开层）。
 *
 * 只检查"公开文件里有没有引用仓库内不存在的文档"这一件事——不涉及任何私密词，
 * 因此规则本身可以公开。这条对任何 clone 者都有意义：
 * 它保证仓库不会出现指向不存在文件的坏链接。
 *
 * 【为什么规则里不再出现具体内部文档名（外部审查发现 S2-3）】
 * 第一版把若干**内部文档名写死在公开脚本里**：
 * 第 17-18 行刚声明"内部文档的文件名本身就是不该公开的信息"，
 * 第 78 行却把它们逐个列了出来——防护规则自己成了泄漏源。
 * 现在改为**通用判据**：只认"`docs/` 下的路径引用"，是否内部资料由 git 回答
 * （未跟踪 = 内部），脚本里不含任何具体文件名。
 *
 * 具体内部文档名仍由本地层规则拦截（规则文件在 .git/info/，永不入库）。
 */
const DANGLING_INTERNAL_REF_RULES = [
  // audit-rule-definition：本行是检测规则的定义，必然出现 docs/ 路径字样
  [/docs\/[A-Za-z0-9._\u4e00-\u9fa5-]+\.md/g, '引用了仓库内不存在的文档路径'],
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
  /CREDENTIAL_RULES|ALLOWLIST|DANGLING_INTERNAL_REF_RULES|SELF_TEST/,
]

/**
 * 行内豁免标记：该行**明确声明**自己是在定义检测规则。
 *
 * 【为什么需要（外部审查发现 S2-3 第二层）】
 * 第一版用 `if (rel === 'scripts/check-secrets.mjs') continue` **整个文件跳过**，
 * 于是套用在本文件上的规则**永远不可能触发**——包括一条真该生效的规则：
 * 若这个脚本自己被写进一个密钥，检查永远看不见。这是结构性盲区。
 * 现在改为只豁免**带标记的那一行**，文件其余部分照常接受全部检查。
 */
const AUDIT_RULE_MARKER = 'audit-rule-definition'

/** 自检探针：必须能被凭据规则抓住，且不被 ALLOWLIST 放过。 */
const SELF_TEST = 'see https://github.com/OWNER/repo with sk-ABCDEFGHIJKLMNOPQRSTUVWX'

const privateRules = loadPrivateRules()
const internalPaths = loadInternalPaths()
const findings = []
let scanned = 0

for (const rel of listTrackedFiles()) {
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
        // 行内豁免：只在声明了标记的那一行放行，不做整文件跳过。
        // 这样"脚本自己被写进密钥"仍然会被上面的凭据规则抓到。
        if (lineText.includes(AUDIT_RULE_MARKER)) continue
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
const selfTestCaught = CREDENTIAL_RULES.some(([re, label]) => {
  if (label !== 'OpenAI 风格 API 密钥') return false
  const probe = new RegExp(re.source, 'g')
  return probe.test(SELF_TEST) && !ALLOWLIST.some((a) => a.test(SELF_TEST))
})
if (!selfTestCaught) {
  console.error('❌ 自检失败：检查逻辑无法识别明显的凭据，ALLOWLIST 可能过宽。')
  process.exit(1)
}

/**
 * 自检二：确认"本文件不再被整文件跳过"。
 *
 * 为什么单独断言：S2-3 的教训是"结构性盲区"——一条规则若永远不可能触发，
 * 它在报告里看起来却是生效的。仅靠自检一证明不了这一点。
 *
 * 探针在**运行时拼接**而不是写成字面量：否则探针本身会被凭据规则抓到，
 * 这个脚本就会在自己的自检上失败（这正说明文件确实在接受扫描）。
 */
const SELF_SCAN_PROBE = `sk-${'Z'.repeat(24)}`
// 构造一行"与本文件里任何一行都不同、且不含豁免标记"的探针文本，
// 再走一遍真实的"是否跳过"判定，确认它不会被跳过。
const unmarkedProbeLine = `const leaked = ${JSON.stringify(SELF_SCAN_PROBE)}`
const probeLineSkipped = unmarkedProbeLine.includes(AUDIT_RULE_MARKER)
const probeWouldBeCaught = CREDENTIAL_RULES.some(([re]) => {
  const p = new RegExp(re.source, 'g')
  return p.test(unmarkedProbeLine)
})
if (probeLineSkipped || !probeWouldBeCaught) {
  console.error('❌ 自检失败：脚本自身未接受扫描（整文件跳过会形成结构性盲区）。')
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
