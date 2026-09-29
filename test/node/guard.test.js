// 反虚构守卫测试（node:test 标准 runner）
//
// 【为什么这组测试是项目的核心资产】
// 守卫的价值在于"能不能真拦住编造"。若测试只验证"正常输入返回 ok"，
// 那么一个永远返回 ok 的空实现也能通过——守卫等于不存在。
// 因此本文件以**反向验证**为主：每一类编造都必须被抓住。
//
// 运行：npm test

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  GUARD_VERSION,
  normalizeText,
  extractNumericTokens,
  extractChineseOrgNames,
  extractLatinProperNouns,
  verifyRewrite,
} from '../../src/guard.js'

describe('守卫：文本与 token 提取', () => {
  test('normalizeText 统一换行，非字符串输入返回空串', () => {
    assert.equal(normalizeText('a\r\nb\rc'), 'a\nb\nc')
    assert.equal(normalizeText(undefined), '')
    assert.equal(normalizeText(123), '')
    assert.equal(normalizeText(null), '')
  })

  test('extractNumericTokens 提取并归一化数字', () => {
    const tokens = extractNumericTokens('提升 40%，服务 12,000 用户，指标 1,200.')
    assert.ok(tokens.has('40'))
    assert.ok(tokens.has('12000'), '千分位逗号应被去掉')
    assert.ok(tokens.has('1200'), '尾部小数点应被去掉')
  })

  test('extractNumericTokens 处理全角数字', () => {
    const tokens = extractNumericTokens('提升４０％')
    assert.ok(tokens.has('40'), '全角数字应转为半角后提取')
  })

  test('extractChineseOrgNames 识别机构名', () => {
    const names = extractChineseOrgNames('在某某科技有限公司与清华大学实习')
    assert.ok([...names].some((n) => n.endsWith('公司')))
    assert.ok([...names].some((n) => n.endsWith('大学')))
  })

  test('extractLatinProperNouns 不把行首词与通用词当专名', () => {
    const names = extractLatinProperNouns('Developed features using React and PostgreSQL')
    assert.ok(!names.has('Developed'), '行首词不应计入（无法区分句首大写）')
    assert.ok(!names.has('using'), '通用词不应计入')
    assert.ok(names.has('React'), '技术专名应计入')
  })
})

describe('守卫：反向验证 —— 各类编造必须被抓住', () => {
  test('编造数字 → error', () => {
    const report = verifyRewrite({
      original: '负责前端开发，优化了页面加载速度。',
      rewritten: '负责前端开发，优化了页面加载速度，性能提升 40%。',
    })
    assert.equal(report.ok, false, '凭空出现的 40% 必须被判为不通过')
    const finding = report.findings.find((f) => f.code === 'FABRICATED_NUMBER')
    assert.ok(finding, '必须产出 FABRICATED_NUMBER')
    assert.equal(finding.severity, 'error')
    assert.deepEqual(finding.evidence, ['40'])
  })

  test('编造机构 → error', () => {
    const report = verifyRewrite({
      original: '在 ABC 公司实习，负责后端接口开发。',
      rewritten: '在 ByteDance 公司实习，负责后端接口开发。',
    })
    assert.equal(report.ok, false, '替换成原文没有的机构名必须被判为不通过')
    assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
  })

  test('编造英文专名 → error', () => {
    const report = verifyRewrite({
      original: 'Built tooling with Python.',
      rewritten: 'Built tooling with Python and Kubernetes.',
    })
    assert.equal(report.ok, false)
    const finding = report.findings.find((f) => f.code === 'FABRICATED_ENTITY')
    assert.ok(finding)
    assert.ok(finding.evidence.includes('Kubernetes'))
  })

  test('守卫自身不能因为改写为空而放行（空输入不等于通过）', () => {
    const report = verifyRewrite({ original: '负责开发，提升效率 30%。', rewritten: '' })
    assert.equal(report.ok, true, '空改写无编造，但会触发 LOST_NUMBER 警告')
    assert.ok(
      report.findings.some((f) => f.code === 'LOST_NUMBER'),
      '原文数字全部消失必须报警告',
    )
  })
})

describe('守卫：正向路径 —— 合法改写必须放行', () => {
  test('纯措辞强化（无新数字/实体）→ ok', () => {
    const report = verifyRewrite({
      original: '负责前端开发，优化了页面加载速度。\n参与了登录模块的重构。',
      rewritten: '主导前端性能优化，通过重构关键渲染路径显著提升页面加载速度。\n深度参与登录模块架构重构。',
    })
    assert.equal(report.ok, true, '只改措辞不得误报')
    assert.deepEqual(
      report.findings.filter((f) => f.severity === 'error'),
      [],
    )
  })

  test('保留原有数字的改写 → ok', () => {
    const report = verifyRewrite({
      original: '提升页面加载速度 40%，服务 12000 名用户。',
      rewritten: '面向 12000 名用户，将页面加载速度提升 40%。',
    })
    assert.equal(report.ok, true, '数字重排不得误报')
  })

  test('原文已有的机构与专名，改写后仍出现 → ok', () => {
    const report = verifyRewrite({
      original: '在清华大学与某科技公司实习，使用 React 开发。',
      rewritten: '使用 React 完成某科技公司核心模块开发，实习期间同时在清华大学参与课题。',
    })
    assert.equal(report.ok, true, '已有实体不应误报')
  })

  test('空原文 + 空改写 → ok 且无发现', () => {
    const report = verifyRewrite({ original: '', rewritten: '' })
    assert.equal(report.ok, true)
    assert.deepEqual(report.findings, [])
  })

  test('非字符串输入不抛异常', () => {
    const report = verifyRewrite({ original: undefined, rewritten: null })
    assert.equal(report.ok, true)
    assert.equal(typeof report.guardVersion, 'string')
  })
})

describe('守卫：契约与元信息', () => {
  test('报告结构稳定（供工具 output schema 使用）', () => {
    const report = verifyRewrite({ original: 'a', rewritten: 'a' })
    assert.deepEqual(Object.keys(report).sort(), [
      'findings',
      'guardVersion',
      'limitations',
      'ok',
      'stats',
    ])
    assert.deepEqual(Object.keys(report.stats).sort(), [
      'originalEntities',
      'originalNumbers',
      'rewrittenEntities',
      'rewrittenNumbers',
    ])
  })

  test('每条 finding 都有 code / severity / message / evidence', () => {
    const report = verifyRewrite({
      original: '原文。',
      rewritten: '新增 99% 提升，在 NewCorp 公司工作。',
    })
    assert.ok(report.findings.length > 0)
    for (const f of report.findings) {
      assert.equal(typeof f.code, 'string')
      assert.ok(['error', 'warn'].includes(f.severity))
      assert.equal(typeof f.message, 'string')
      assert.ok(Array.isArray(f.evidence))
    }
  })

  test('GUARD_VERSION 为语义化版本串', () => {
    assert.match(GUARD_VERSION, /^\d+\.\d+\.\d+$/)
  })

  test('必须声明已知局限（诚实边界，避免虚假安全感）', () => {
    const report = verifyRewrite({ original: 'a', rewritten: 'a' })
    assert.ok(Array.isArray(report.limitations))
    assert.ok(report.limitations.length > 0, '不得声称守卫能覆盖一切')
    assert.ok(
      report.limitations.some((l) => l.includes('无后缀')),
      '必须声明无后缀机构名无法识别这一局限',
    )
  })
})

describe('守卫：防误报（误报会让守卫被忽略，比漏报更糟）', () => {
  test('动词 + 机构后缀 不得被当成机构名', () => {
    const report = verifyRewrite({
      original: '负责公司官网前端开发，使用了 Vue2。',
      rewritten: '主导公司官网前端开发，基于 Vue2 完成核心模块重构。',
    })
    assert.equal(
      report.ok,
      true,
      '「主导公司」是动宾短语，不是机构名，不得误报',
    )
  })

  test('同一机构的修饰语变化不得误报', () => {
    const report = verifyRewrite({
      original: '在清华大学参与课题研究。',
      rewritten: '在清华大学深度参与课题研究并产出成果。',
    })
    assert.equal(report.ok, true, '机构名未变，不得误报')
  })

  test('数字重排与千分位写法不得误报', () => {
    const report = verifyRewrite({
      original: '服务 12000 名用户，提升 40%。',
      rewritten: '提升 40%，累计服务 12,000 名用户。',
    })
    assert.equal(report.ok, true, '同一数字的写法变化不得误报')
  })
})
