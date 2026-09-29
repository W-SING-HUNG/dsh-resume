#!/usr/bin/env node
// 文档-代码一致性自检（docs consistency linter）
//
// 存在理由：第九轮迁移测试结构时留下 17 处指向已删除文件的失效引用。
// 靠人记住同步不可靠，因此把"文档里提到的仓库路径必须存在"变成可执行检查。
//
// 设计原则：宁可漏报，不可误报。乱叫的 linter 会被忽略，等于没有。
//   - 路径解析三级回退：文档所在目录 → 仓库根 → 全仓 basename 搜索
//   - 显式允许"故意不存在"的文件（如按惯例不提交的锁文件）
//   - 显式允许指向 DSH 安装目录的外部路径（本项目不包含那些文件）
//
// 检查项：
//   1. Markdown 中引用的仓库内相对路径必须真实存在
//   2. 文档中出现的 npm script 名必须在 package.json 中定义
//   3. CI 工作流中调用的 npm script 必须存在
//
// 运行：npm run check:docs

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const definedScripts = new Set(Object.keys(pkg.scripts ?? {}))

/** 按项目惯例故意不提交的文件（在文档中提及是合理的）。 */
const INTENTIONALLY_ABSENT = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
])

/** 指向 DSH 安装目录（不在本仓库）的路径前缀，仅作说明用途。 */
const EXTERNAL_PREFIXES = [
  'dsh-base/',
  'dsh-app-boot/',
  'dsh-tools/',
  'dsh-system-prompt/',
  'dsh-tool-goal/',
  'dsh-agent-instructions/',
  'dsh-package-manifest/',
  'lib/',
]

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', '.pnpm-store'])

/**
 * 内部资料目录/文件（不对外发布，见 .gitignore）。
 * 这些文件里的引用不需要检查——它们不进入公开仓库。
 * 不排除它们会产生误报，而误报会让检查失去意义。
 */
const INTERNAL_PREFIXES = [
  'AGENTS.md',
  'workflow.md',
  'docs/',
]

/** 判断文件是否属于内部资料。 */
function isInternal(relPath) {
  const p = relPath.replace(/\\/g, '/')
  return INTERNAL_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix))
}

/** 递归收集待检查文件（跳过内部资料）。 */
function collectFiles(dir, acc = [], base = ROOT) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const rel = relative(base, full)
    if (isInternal(rel)) continue
    if (statSync(full).isDirectory()) collectFiles(full, acc, base)
    else if (/\.(md|yml|yaml)$/.test(entry)) acc.push(full)
  }
  return acc
}

/** 全仓 basename → 路径集合，用于解析裸文件名引用（跳过内部资料）。 */
function buildBasenameIndex() {
  const index = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue
      const full = join(dir, entry)
      if (isInternal(relative(ROOT, full))) continue
      if (statSync(full).isDirectory()) walk(full)
      else if (!index.has(entry)) index.set(entry, full)
    }
  }
  walk(ROOT)
  return index
}

/**
 * 判断一个引用是否指向仓库内真实存在的文件。
 * @param {string} ref 文档中的路径引用
 * @param {string} docDir 该文档所在目录
 * @param {Map<string, string>} basenameIndex 全仓 basename 索引
 * @returns {boolean} 是否解析成功
 */
function refExists(ref, docDir, basenameIndex) {
  const clean = ref.replace(/^\.\//, '')
  if (INTENTIONALLY_ABSENT.has(clean)) return true
  if (EXTERNAL_PREFIXES.some((p) => clean.startsWith(p))) return true

  // 一级：文档所在目录
  if (existsSync(resolve(docDir, clean))) return true
  // 二级：仓库根
  if (existsSync(join(ROOT, clean))) return true
  // 三级：全仓 basename 搜索（处理文档内用简写引用的情形）
  const name = ref.split('/').pop()
  if (name && basenameIndex.has(name)) return true

  return false
}

const problems = []
const files = collectFiles(ROOT)
const basenameIndex = buildBasenameIndex()

// ── 1. Markdown 中引用的仓库路径 ────────────────────────────────────
for (const file of files) {
  if (!file.endsWith('.md')) continue
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const docDir = dirname(file)
  const content = readFileSync(file, 'utf8')

  const candidates = new Set()
  // [文本](路径) 链接
  for (const m of content.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) candidates.add(m[1])
  // 行内代码中的文件路径（含扩展名）
  for (const m of content.matchAll(/`([A-Za-z0-9_][A-Za-z0-9_./-]*\.(?:js|mjs|json|yml|yaml|md|txt|html))`/g)) {
    candidates.add(m[1])
  }
  // 行内代码中的目录路径
  for (const m of content.matchAll(/`((?:src|test|docs|examples|scripts|\.github)\/[A-Za-z0-9_./-]+)`/g)) {
    candidates.add(m[1])
  }

  for (const ref of candidates) {
    if (/^[a-z]+:/i.test(ref)) continue // 协议开头（http: mailto: 等）
    if (!refExists(ref, docDir, basenameIndex)) {
      problems.push(`${rel}: 引用了不存在的路径 \`${ref}\``)
    }
  }
}

// ── 2. 文档中提到的 npm script ──────────────────────────────────────
for (const file of files) {
  if (!file.endsWith('.md')) continue
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const content = readFileSync(file, 'utf8')
  for (const m of content.matchAll(/npm run ([a-z][a-z0-9:_-]*)/g)) {
    if (!definedScripts.has(m[1])) {
      problems.push(`${rel}: 提到了未定义的 npm script \`npm run ${m[1]}\``)
    }
  }
}

// ── 3. CI 工作流调用的 script ───────────────────────────────────────
const wfDir = join(ROOT, '.github', 'workflows')
if (existsSync(wfDir)) {
  for (const wf of readdirSync(wfDir)) {
    const content = readFileSync(join(wfDir, wf), 'utf8')
    for (const m of content.matchAll(/npm run ([a-z][a-z0-9:_-]*)/g)) {
      if (!definedScripts.has(m[1])) {
        problems.push(`.github/workflows/${wf}: 调用了未定义的 npm script \`${m[1]}\``)
      }
    }
  }
}

// ── 输出 ────────────────────────────────────────────────────────────
if (problems.length === 0) {
  console.log(`✅ 文档一致性检查通过（扫描 ${files.length} 个文件）`)
  process.exit(0)
}

console.error(`❌ 发现 ${problems.length} 处文档不一致：\n`)
for (const p of problems) console.error(`   - ${p}`)
console.error('\n修复后再提交。这类问题会让协作者读到失效指引。')
process.exit(1)
