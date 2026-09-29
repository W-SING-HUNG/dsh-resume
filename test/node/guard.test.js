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
  extractContentUnits,
  extractResponsibilityLevel,
  extractDateTokens,
  verifyKeywordCoverage,
  detectNovelUnits,
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
      rewritten: '负责前端开发，通过重构关键渲染路径显著提升了页面加载速度。\n参与了登录模块的架构重构工作。',
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
      'coverage',
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

describe('守卫：职责升格检测（比编数字更隐蔽的造假）', () => {
  test('参与 → 主导：必须判为升格', () => {
    const report = verifyRewrite({
      original: '参与了登录模块开发。',
      rewritten: '主导登录模块开发。',
    })
    assert.equal(report.ok, false, '把"参与"写成"主导"是事实性夸大')
    const finding = report.findings.find((f) => f.code === 'RESPONSIBILITY_INFLATED')
    assert.ok(finding, '必须产出 RESPONSIBILITY_INFLATED')
    assert.equal(finding.severity, 'error')
  })

  test('协助 → 负责：必须判为升格（含补语干扰项）', () => {
    // 关键回归用例 1：`协助完成` 同时含「协助」(2) 与「完成」(3)，
    // 若只看 maxLevel 会漏报，必须同时看 minLevel。
    const report = verifyRewrite({
      original: '协助完成接口对接。',
      rewritten: '负责接口对接。',
    })
    assert.equal(report.ok, false, '「协助完成」的真实强度是"协助"，不得被"完成"抬高层级')
  })

  test('负责 → 主导：必须判为升格（minLevel 未变的情形）', () => {
    // 关键回归用例 2（真实漏报，由 README 演示脚本发现）：
    // 原文含「负责」(3)，改写加了「主导」(4)。
    // 两边 minLevel 都是 3，若只看 minLevel 会漏报，必须同时看 maxLevel。
    const report = verifyRewrite({
      original: '负责使用 Vue2 编写主要展示页面。',
      rewritten: '主导使用 Vue2 编写主要展示页面。',
    })
    assert.equal(report.ok, false, '「负责」升格为「主导」必须被抓，不得因 minLevel 未变而放行')
  })

  test('原文无职责主张 → 改写声称主导：必须判为升格', () => {
    const report = verifyRewrite({
      original: '使用 Vue2 编写展示页面。',
      rewritten: '主导使用 Vue2 编写展示页面。',
    })
    assert.equal(report.ok, false, '原文未主张领导权，改写不得凭空加上')
  })

  test('原文无职责主张 → 改写用"负责"规整表述：不得误报', () => {
    // 这是简历中正常的表述规整（用户确实做了这件事），报出来是误报。
    // 因此对"原文 level 为 0"的情况设了主导层（4）门槛。
    const report = verifyRewrite({
      original: '使用 Vue2 编写展示页面。',
      rewritten: '负责使用 Vue2 完成展示页面的编写工作。',
    })
    assert.equal(report.ok, true, '把动作规整为"负责"属正常改写，不得误报')
  })

  test('同一强度的措辞强化：不得误报', () => {
    const report = verifyRewrite({
      original: '负责前端开发。',
      rewritten: '负责并持续推进前端开发工作。',
    })
    assert.equal(report.ok, true, '同层动词的修辞强化不得误报')
  })

  test('压缩表述但保持最弱动词：不得误报', () => {
    const report = verifyRewrite({
      original: '参与需求评审，协助完成接口联调。',
      rewritten: '参与需求评审并协助接口联调工作。',
    })
    assert.equal(report.ok, true, '最弱动词仍是"参与/协助"，属同层压缩')
  })

  test('原文无职责动词时不做过度判定（避免误报）', () => {
    const report = verifyRewrite({
      original: '完成登录页面。',
      rewritten: '完成登录页面开发工作。',
    })
    assert.equal(report.ok, true, '原文强度为 0 且改写未达主导层时不判定升格')
  })
})

describe('守卫：时间线一致性（日期属事实字段）', () => {
  test('年份被改动：必须判为错误', () => {
    const report = verifyRewrite({
      original: '2019.06 - 2021.08 在某公司实习。',
      rewritten: '2020.06 - 2021.08 在某公司实习。',
    })
    assert.equal(report.ok, false, '起止日期被改动必须报错')
    assert.ok(report.findings.some((f) => f.code === 'FABRICATED_DATE'))
  })

  test('日期格式变化（年月 → 点号）：不得误报', () => {
    const report = verifyRewrite({
      original: '2019年6月入职。',
      rewritten: '2019.06 入职。',
    })
    assert.equal(report.ok, true, '同一时间点的不同写法不得误报')
  })

  test('原文只有年份、改写补月份：不得误报', () => {
    const report = verifyRewrite({
      original: '2019 年入职。',
      rewritten: '2019.06 入职。',
    })
    assert.equal(report.ok, true, '同一年内补充月份不构成事实改动')
  })

  test('日期不得被数字检查重复报告', () => {
    const report = verifyRewrite({
      original: '2019.06 入职。',
      rewritten: '2020.06 入职。',
    })
    const codes = report.findings.map((f) => f.code)
    assert.ok(codes.includes('FABRICATED_DATE'), '日期问题应由日期检查报告')
    assert.ok(
      !codes.includes('FABRICATED_NUMBER'),
      '日期不应同时被数字检查报告（重复报告会稀释报告可用性）',
    )
  })
})

describe('守卫：关键词覆盖回验（模型自报不等于事实）', () => {
  test('声称覆盖但未出现的词：必须报错', () => {
    const report = verifyRewrite({
      original: '负责前端开发。',
      rewritten: '负责前端开发，使用 Vue2 与 Webpack。',
      claimedKeywords: ['Vue2', 'Webpack', 'TypeScript'],
    })
    const finding = report.findings.find((f) => f.code === 'UNVERIFIED_KEYWORD_CLAIM')
    assert.ok(finding, '声称覆盖 TypeScript 但文本里没有，必须报错')
    assert.equal(finding.severity, 'error')
    assert.deepEqual(finding.evidence, ['TypeScript'])
  })

  test('关键词确实出现（大小写不敏感）：不予报告', () => {
    const report = verifyRewrite({
      original: '负责前端开发。',
      rewritten: '使用 vue2 与 Webpack 完成前端开发。',
      claimedKeywords: ['Vue2', 'Webpack'],
    })
    assert.ok(
      !report.findings.some((f) => f.code === 'UNVERIFIED_KEYWORD_CLAIM'),
      '大小写不同但确实出现，不得报错',
    )
    assert.deepEqual(report.coverage.unverified, [])
  })

  test('回验结果区分已证实与未证实', () => {
    const report = verifyRewrite({
      original: '负责前端开发。',
      rewritten: '使用 Vue2 开发。',
      claimedKeywords: ['Vue2', 'TypeScript'],
    })
    assert.deepEqual(report.coverage.verified, ['Vue2'])
    assert.deepEqual(report.coverage.unverified, ['TypeScript'])
  })

  test('不传自报关键词时为 null（向后兼容）', () => {
    const report = verifyRewrite({ original: 'a', rewritten: 'a' })
    assert.equal(report.coverage, null)
  })

  test('空关键词与非法输入被忽略', () => {
    const report = verifyRewrite({
      original: 'a',
      rewritten: 'a',
      claimedKeywords: ['', '   ', null, undefined, 'A'],
    })
    assert.deepEqual(report.coverage.unverified, [], '空项不得产生误报')
  })
})

describe('守卫：整条新增检测（特征比对抓不住的造假）', () => {
  test('内容单元切分：去掉标记与过短行', () => {
    const units = extractContentUnits(
      '# 姓名\n- 使用 Vue2 完成商品列表模块的开发工作；\n**加粗的要点内容在这里呈现**\n短',
    )
    assert.ok(units.includes('使用 Vue2 完成商品列表模块的开发工作；'))
    assert.ok(units.includes('加粗的要点内容在这里呈现'))
    assert.ok(!units.includes('姓名'), '过短行（标题/姓名）不参与比对')
    assert.ok(!units.includes('短'), '过短行不参与比对')
  })

  test('凭空新增一整个条目：必须抓住', () => {
    const original = '- 使用 Vue2 完成商品列表模块开发；\n- 对接后端 REST 接口，完成登录功能；'
    const rewritten =
      original + '\n- 负责用户增长策略，主导社群运营体系搭建，实现月活翻倍。'
    const report = verifyRewrite({ original, rewritten })
    assert.equal(report.ok, false)
    const finding = report.findings.find((f) => f.code === 'NOVEL_CONTENT')
    assert.ok(finding, '与原文任何一条都对不上的内容必须报出')
    assert.equal(finding.severity, 'error')
  })

  test('彻底重写同一件事（换说法）：不得误报', () => {
    // 误报风险最高的场景：同一件事的措辞完全不同
    const original = '- 使用 Vue2 编写主要展示页面和商品列表模块；\n- 使用 Vuex 管理用户登录态与购物车数据；'
    const rewritten =
      '- 基于 Vue2 完成商品展示页与列表模块的开发；\n- 借助 Vuex 统一维护登录态与购物车状态；'
    const report = verifyRewrite({ original, rewritten })
    assert.equal(report.ok, true, '同一件事换说法不得误报')
  })

  test('扩写（在原文基础上增加细节）：不得误报', () => {
    const original = '- 对接后端 REST 接口。'
    const rewritten =
      '- 对接后端 REST 接口，完成登录与购物车功能，并处理异常状态的兜底逻辑。'
    const report = verifyRewrite({ original, rewritten })
    assert.equal(report.ok, true, '在原文条目上扩写细节不得误报')
  })

  test('原文为空时不做新增判定（避免误报）', () => {
    const report = verifyRewrite({ original: '', rewritten: '- 任意内容单元测试文本；' })
    assert.ok(
      !report.findings.some((f) => f.code === 'NOVEL_CONTENT'),
      '无原文可比时不得判定新增',
    )
  })
})

describe('守卫：防误报（误报会让守卫被忽略，比漏报更糟）', () => {
  test('动词 + 机构后缀 不得被当成机构名', () => {
    // 注意改写须保持同层职责动词，否则会触发职责升格（另一个检查项）
    const report = verifyRewrite({
      original: '负责公司官网前端开发，使用了 Vue2。',
      rewritten: '负责公司官网前端开发工作，基于 Vue2 完成核心模块重构。',
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
