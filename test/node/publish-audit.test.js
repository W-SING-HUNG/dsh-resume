// 发布审计的元测试（node:test 标准 runner）
//
// 存在理由：审计脚本是发布物边界的唯一执行者。若它的规则来源被削弱、
// 或私密规则文件与脚本的读取契约漂移，审计会静默失效——那比没有审计更糟
// （会给人"已经检查过了"的错觉）。
//
// ⚠️ 关键设计：本文件**不写入任何私密词的字面量**。
// 早期版本为了断言"脚本里没有私密规则"而把词表抄进本文件，结果测试自身
// 成了泄漏源——验证手段变成了被验证的问题。现改为动态读取
// .git/info/private-terms.txt，用其中的规则反过来检查公开脚本。
//
// 本测试在两种环境下都有效：
//   - 开发机：读得到本地规则文件，执行完整的方向性断言
//   - CI 干净克隆：规则文件不存在，相关断言跳过（仓库本来就没有敏感内容）
//
// 运行：npm test

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const AUDIT_SCRIPT = join(ROOT, 'scripts', 'check-secrets.mjs')
const LOCAL_TERMS = join(ROOT, '.git', 'info', 'private-terms.txt')

/** 审计脚本源码。 */
function readAuditScript() {
  return readFileSync(AUDIT_SCRIPT, 'utf8')
}

/** 读取本地私密规则的正则源串（文件缺失时返回 null）。 */
function readLocalRuleSources() {
  if (!existsSync(LOCAL_TERMS)) return null
  return readFileSync(LOCAL_TERMS, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((l) => {
      const idx = l.lastIndexOf('|')
      return idx > 0 ? l.slice(0, idx).trim() : l
    })
    .filter((p) => p.length > 0)
}

describe('发布审计：规则来源与自检', () => {
  test('脚本确实从本地文件读取私密规则与内部路径名单', () => {
    const src = readAuditScript()
    assert.match(
      src,
      /LOCAL_TERMS\s*=\s*join\(ROOT,\s*'\.git',\s*'info',\s*'private-terms\.txt'\)/,
      '应定义指向 .git/info/private-terms.txt 的常量',
    )
    assert.match(
      src,
      /LOCAL_EXCLUDE\s*=\s*join\(ROOT,\s*'\.git',\s*'info',\s*'exclude'\)/,
      '应定义指向 .git/info/exclude 的常量',
    )
    assert.match(src, /loadPrivateRules\(\)/, '应调用 loadPrivateRules 读取私密规则')
    assert.match(src, /loadInternalPaths\(\)/, '应调用 loadInternalPaths 读取内部路径名单')
  })

  test('公开脚本中不含本地规则的字面量', () => {
    const ruleSources = readLocalRuleSources()
    if (ruleSources === null) {
      // CI 干净克隆：没有本地规则文件，也就没有可比对的私密词
      assert.ok(true, '无本地规则文件，跳过（CI 环境预期行为）')
      return
    }
    const src = readAuditScript()
    // 把每条本地规则的完整正则源串拿去公开脚本里找；命中即为规则内容泄漏
    const leaked = ruleSources.filter((pattern) => src.includes(pattern))
    assert.deepEqual(
      leaked,
      [],
      `审计脚本中出现了本地私密规则的字面量，规则应只存在于 .git/info/private-terms.txt：${leaked.join('、')}`,
    )
  })

  test('保留通用凭据检查，且自带自检探针', () => {
    const src = readAuditScript()
    assert.match(src, /CREDENTIAL_RULES/, '通用凭据规则应保留（公开无妨）')
    assert.match(src, /SELF_TEST/, '应保留自检探针，防止例外规则过宽导致永远通过')
    assert.match(src, /自检失败/, '自检失败时必须显式报错退出（否则审计形同虚设）')
  })

  test('本地规则文件缺失时降级而非崩溃', () => {
    const src = readAuditScript()
    assert.match(src, /existsSync\(LOCAL_TERMS\)/, '读取私密规则前应检查文件存在')
    assert.match(src, /existsSync\(LOCAL_EXCLUDE\)/, '读取排除名单前应检查文件存在')
    assert.match(src, /仅执行凭据检查/, '缺失时应打印降级提示')
  })

  test('内部路径匹配按目录边界，不用裸前缀', () => {
    const src = readAuditScript()
    // 裸 startsWith 会把同前缀的无关文件误判（例如内部文档名后接 .bak 的备份），
    // 也会让目录条目匹配到同名兄弟目录。
    assert.match(
      src,
      /p\s*===\s*prefix\s*\|\|\s*p\.startsWith\(prefix\s*\+\s*'\/'\)/,
      '路径匹配应精确相等或以 prefix + "/" 开头，避免前缀误伤',
    )
  })
})

describe('发布审计：本地规则文件格式', () => {
  test('规则文件若存在，每行都能被解析为有效正则', () => {
    const ruleSources = readLocalRuleSources()
    if (ruleSources === null) {
      assert.ok(true, '无本地规则文件，跳过（CI 环境预期行为）')
      return
    }
    const invalid = ruleSources.filter((p) => {
      try {
        new RegExp(p)
        return false
      } catch {
        return true
      }
    })
    assert.deepEqual(invalid, [], `以下规则无法编译为正则：${invalid.join('、')}`)
  })
})
