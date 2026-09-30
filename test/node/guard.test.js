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
  detectSelfAttestation,
  matchUnitsToOriginal,
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

  // ── 等价写法归一化（外部审查发现的投递死锁，回归锁定）───────────────
  //
  // 背景：早期实现把"同一数值的不同写法"当成不同数字，于是模型做
  // ATS 对齐时最常见的三类动作——中文数量级换算、日期格式规范化、
  // 联系方式加分隔符——全部被判为编造并**拒绝导出**，用户永久拿不到文件。
  // 更糟的是错误指令要求"删除编造内容"，模型照做会删掉用户真实电话。
  test('中文数量级写法归一化为同一数值（8万 = 80000）', () => {
    assert.deepEqual([...extractNumericTokens('服务 8 万用户')], ['80000'])
    assert.deepEqual([...extractNumericTokens('服务 80000 用户')], ['80000'])
    assert.deepEqual([...extractNumericTokens('商品 1.2 万个')], ['12000'])
    assert.deepEqual([...extractNumericTokens('商品 12000 个')], ['12000'])
    assert.deepEqual([...extractNumericTokens('服务 8 亿')], ['800000000'])
  })

  test('联系方式的分隔符写法归一化为同一号码', () => {
    assert.deepEqual([...extractNumericTokens('手机 138-0000-0000')], ['13800000000'])
    assert.deepEqual([...extractNumericTokens('手机 13800000000')], ['13800000000'])
    assert.deepEqual([...extractNumericTokens('手机 138 0000 0000')], ['13800000000'])
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

  // ── 中文行里的技术专名（外部审查发现的 S1-2，回归锁定）─────────────
  //
  // 缺陷背景：早期实现只认"首字母大写 + 跳过行首词"，于是真实中文简历上
  // 这道检查**完全空转**（项目自己 demo 的 originalEntities 为 0）：
  //   - `Vue2 → React` 技术栈替换零告警（React 大写，但 Vue2 落在行首被跳过）
  //   - `redis / mysql / kafka` 全小写技术名一个都不认
  // 而中文简历里这两种形态都是主流写法。
  test('中文行：行首与小写技术名都必须被识别', () => {
    const names = extractLatinProperNouns('- 使用 Vue2 编写展示页面，配合 redis 与 mysql 存储数据')
    assert.ok(names.has('Vue2'), '行首的拉丁技术名必须被识别（中文行没有句首大写问题）')
    assert.ok(names.has('redis'), '全小写技术名必须被识别')
    assert.ok(names.has('mysql'), '全小写技术名必须被识别')
  })

  test('中文行：普通英文词不得被误报为专名', () => {
    const names = extractLatinProperNouns('- 负责 team 的 design review，参加 remote 会议')
    for (const w of ['team', 'design', 'review', 'remote']) {
      assert.ok(!names.has(w), `普通英文词 ${w} 不应被当作专名（误报会让守卫被忽略）`)
    }
  })

  test('数字加单位的写法不得被误报为专名（实测噪声）', () => {
    // `2.4s` / `1.8s` 这类 token 也含字母，第一版修复曾把它们收进来，
    // 导致合法的"秒 → 毫秒"换算触发 FABRICATED_ENTITY 误报。
    const names = extractLatinProperNouns('- 将首屏加载从 2.4s 缩短至 1.8s，内存降至 512MB')
    assert.ok(!names.has('2.4s'), '数字开头的单位写法不是专名')
    assert.ok(!names.has('1.8s'), '数字开头的单位写法不是专名')
    assert.ok(!names.has('512MB'), '数字开头的单位写法不是专名')
  })

  test('英文行仍保持保守规则（不因中文行的放宽而引入误报）', () => {
    const names = extractLatinProperNouns('Developed features using React and PostgreSQL')
    assert.ok(!names.has('Developed'), '英文行的行首词仍应跳过')
    assert.ok(names.has('React'))
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

  test('补全简历头部（姓名/求职意向/联系方式）：不得误报为新增', () => {
    // 关键回归用例（真实缺陷，由端到端演示发现）：
    // 改写流程中补全头部是正常且必需的操作——用户原文常常只有经历部分。
    // 早期实现把「求职意向：前端开发工程师」报为凭空新增，导致无法通过校验。
    const original = '- 使用 Vue2 完成商品列表模块开发；'
    const rewritten =
      '# 示例候选人\n\n求职意向：前端开发工程师\n\n' +
      '联系方式：candidate@example.com\n\n' +
      '- 负责使用 Vue2 完成商品列表模块的开发；'
    const report = verifyRewrite({ original, rewritten })
    assert.ok(
      !report.findings.some((f) => f.code === 'NOVEL_CONTENT'),
      '结构性头部不应被判为编造',
    )
  })

  test('头部字段被改动时，数字检查仍生效', () => {
    // 排除头部只作用于"整条新增"判定，其它检查必须全量生效
    const report = verifyRewrite({
      original: '联系方式：138-0000-0000\n- 负责前端开发工作；',
      rewritten: '联系方式：139-1111-2222\n- 负责前端开发工作；',
    })
    assert.equal(report.ok, false, '改掉电话号必须被数字检查抓住')
    assert.ok(report.findings.some((f) => f.code === 'FABRICATED_NUMBER'))
  })
})

// ── 投递主链路不得死锁（外部审查发现的 S1，回归锁定）──────────────────
//
// 这组用例针对的是一个**流水线全绿但产品不可用**的缺陷：
// 既有测试全部使用单行文本，因此"日期/数值/联系方式的等价写法被误判"
// 这条主链路问题从未被覆盖，而它会让用户永久拿不到导出文件。
// 教训：守卫的测试必须用**真实长度的简历文本**，单行样本测不出这类问题。
describe('守卫：等价写法不得被误判为编造（投递链路）', () => {
  const allow = [
    ['日期格式规范化', '实习 2026.03 开始', '实习 2026年3月开始'],
    ['反向日期规范化', '2026年3月入职', '2026.03 入职'],
    ['中文数量级换算', '服务 8 万用户', '服务 80000 用户'],
    ['小数数量级换算', '商品列表 12000 个', '商品列表 1.2 万个'],
    ['年份区间被误当月份', '在职 2019 - 2021', '在职 2019.06 - 2021.08'],
    ['联系方式加分隔符', '手机 13800000000', '手机 138-0000-0000'],
  ]
  for (const [name, original, rewritten] of allow) {
    test(`合法改写必须放行：${name}`, () => {
      const report = verifyRewrite({ original, rewritten })
      const errors = report.findings.filter((f) => f.severity === 'error')
      assert.deepEqual(
        errors.map((f) => f.code),
        [],
        `等价写法不得报错，否则用户无法导出：${name}`,
      )
    })
  }

  test('补全简历头部（联系方式源自原文）必须放行', () => {
    // 真实场景：用户原文里已有电话与邮箱（格式可能不规范），
    // 改写把它们规整进头部。这些是**原文已有的事实**，不得判为编造。
    //
    // 注意：不能反过来要求"原文没有电话也必须放行"——模型无从知道
    // 用户真实号码，凭空补一个正是本项目要拦的编造（HR 打过去是空号）。
    // 原文确实缺联系方式时，正确做法是让用户提供后并入原文
    // （core.js 的拒绝信息里给了这条出路）。
    const report = verifyRewrite({
      original: '138-0000-0000 candidate@example.com\n- 负责商品列表开发，性能提升 40%',
      rewritten:
        '# 张三\n前端开发工程师 | 13800000000 | candidate@example.com\n\n' +
        '## 项目经历\n- 负责商品列表开发，性能提升 40%',
    })
    assert.deepEqual(
      report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
      [],
      '原文已有的联系方式被规整进头部，不得报错',
    )
  })

  test('无标签的「职位 | 电话 | 邮箱」头部行不触发整条新增检测', () => {
    // 实测缺陷：这类头部行不匹配任何字段名规则，曾被报为凭空新增，
    // 与数字检查重复报告同一件事，还会诱导模型删掉真实联系方式。
    const report = verifyRewrite({
      original: '13800000000 前端开发\n- 负责商品列表开发',
      rewritten: '前端开发工程师 | 13800000000 | a@example.com\n- 负责商品列表开发',
    })
    assert.ok(
      !report.findings.some((f) => f.code === 'NOVEL_CONTENT'),
      '含联系方式的头部行不应被判为凭空新增',
    )
  })

  // 反向：归一化不得放宽判定
  const block = [
    ['数值真的被改', '提升 40%', '提升 65%'],
    ['数量级被放大', '服务 8 万用户', '服务 80 万用户'],
    ['换了手机号', '手机 13800000000', '手机 13911112222'],
    ['日期真的被改', '2020年入职', '2023年入职'],
  ]
  for (const [name, original, rewritten] of block) {
    test(`真实编造必须拦下：${name}`, () => {
      const report = verifyRewrite({ original, rewritten })
      assert.equal(report.ok, false, `归一化不得放过真实改动：${name}`)
    })
  }
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

// ── 外部验收发现的 S1-2 / S2-1，回归锁定 ────────────────────────────
//
// 【为什么这组用例必须用"真实长度的简历文本"】
// 第二十七轮的教训已固化：既有守卫用例**全部是单行文本**，
// 因此真实简历上的问题从未被覆盖——流水线全绿而产品不可用。
// S1-2 与 S2-1 都是"单行测不出、真实简历上成立"的缺陷，
// 所以这组用例刻意使用多行、含多项经历的简历文本。
describe('守卫：真实简历文本上的专名与技术栈检查（S1-2）', () => {
  /** 真实形态的中文简历（含小写技术名与行首技术名）。 */
  const RESUME = [
    '姓名：示例候选人',
    '联系方式：138-0000-0000 | candidate@example.com',
    '',
    '专业技能：',
    '- HTML / CSS / JavaScript（ES6）',
    '- Vue2（组件化开发、Vuex 状态管理）',
    '',
    '项目经历：',
    '校园二手交易平台（前端负责人，2026.03 - 2026.06）',
    '- 使用 Vue2 编写主要展示页面和商品列表模块；',
    '- 对接后端 REST 接口，完成登录与购物车功能；',
    '- 使用 Vuex 管理用户登录态与购物车数据；',
    '- 通过懒加载商品图片与合并请求，将首屏加载时间从 2.4s 缩短至 1.8s。',
  ].join('\n')

  test('这道检查在真实简历上不得空转（曾产出 originalEntities: 0）', () => {
    const report = verifyRewrite({ original: RESUME, rewritten: RESUME })
    assert.ok(
      report.stats.originalEntities > 0,
      '真实中文简历必须能提取出技术专名，否则该检查等于不存在',
    )
    assert.ok(
      extractLatinProperNouns(RESUME).has('Vue2'),
      '行首的 Vue2 必须被识别',
    )
  })

  test('技术栈替换必须被抓住：Vue2 → React', () => {
    const rewritten = RESUME.replace('使用 Vue2 编写', '使用 React 编写')
    const report = verifyRewrite({ original: RESUME, rewritten })
    assert.equal(report.ok, false, '换掉技术栈是事实性改动，必须报错')
    assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
  })

  test('小写技术名被编造必须被抓住：redis / mysql', () => {
    const rewritten = RESUME.replace(
      '- 使用 Vuex 管理用户登录态与购物车数据；',
      '- 使用 redis 与 mysql 管理用户登录态与购物车数据；',
    )
    const report = verifyRewrite({ original: RESUME, rewritten })
    assert.equal(report.ok, false, '原文没有的技术名不得凭空出现')
    assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
  })

  test('行首补一个原文没有的技术名必须被抓住：TypeScript', () => {
    const rewritten =
      '- TypeScript 工程化改造，' + RESUME.split('\n').slice(4).join('\n')
    const report = verifyRewrite({ original: RESUME, rewritten })
    assert.equal(
      report.ok,
      false,
      '行首插入的技术名（中文语序下拉丁词天然在行首）必须被抓住',
    )
  })

  // ── 短技术栈缩写的替换/编造必须被抓住（本轮实测抓出的真实漏报）────────
  //
  // 【为什么专门测这一组】
  // 为消除 `CI/CD` 类误报，我曾把"长度 ≤ 4 的全大写缩写"一律降级为 warn，
  // 结果**修过头**：`CSS → SCSS`、凭空加 `SQL`/`Kotlin` 都变成 ok=true，
  // 等于放行"把没学过的技术写进简历"。现改为受限白名单（只降级
  // `API`/`SDK`/`UX` 这类泛指缩写），可验证的技术栈仍判 error。
  //
  // 另有一个更隐蔽的根因：`isKnownEntity` 的双向**包含判定**把
  // `SCSS` 当成"已知实体"（因为 `'scss'.includes('css')`）。
  // 拉丁专名是完整 token，必须精确比对——这组用例同时锁定这一点。
  test('短技术栈缩写替换必须被抓住：CSS → SCSS（含子串陷阱）', () => {
    const rewritten = RESUME.replace('CSS', 'SCSS')
    const report = verifyRewrite({ original: RESUME, rewritten })
    assert.equal(
      report.ok,
      false,
      'CSS → SCSS 是技术栈替换；不得因 SCSS 含子串 CSS 而被判为"已知实体"',
    )
    assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
  })

  test('短技术栈缩写编造必须被抓住：凭空加 SQL / Kotlin', () => {
    for (const tech of ['SQL', 'Kotlin', 'Redis']) {
      const rewritten = RESUME.replace(
        '- 使用 Vuex 管理用户登录态与购物车数据；',
        `- 熟悉 ${tech}；\n- 使用 Vuex 管理用户登录态与购物车数据；`,
      )
      const report = verifyRewrite({ original: RESUME, rewritten })
      assert.equal(report.ok, false, `凭空加 ${tech} 必须被判为编造`)
    }
  })

  test('真正的泛指缩写仍降级为 warn（不得因收紧而重新造成死锁）', () => {
    // 反向锁定：收紧"短缩写"不得把 SDK/UX/API 这类等价写法重新判成 error。
    //
    // 注意用例构造：必须把缩写**写进既有条目**（等价术语替换的典型形态），
    // 而不是新加一整条经历——后者会（正确地）触发 NOVEL_CONTENT，
    // 那是另一个检查项，会把本用例要验证的点掩盖掉。
    for (const term of ['SDK', 'API', 'UX']) {
      const rewritten = RESUME.replace(
        '- HTML / CSS / JavaScript（ES6）',
        `- HTML / CSS / JavaScript（ES6），熟悉 ${term} 相关流程`,
      )
      const report = verifyRewrite({ original: RESUME, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `${term} 是泛指缩写，不得阻断交付`,
      )
      assert.ok(
        report.findings.some((f) => f.code === 'AMBIGUOUS_NEW_TERM'),
        `${term} 必须留下 warn 提示，不能静默放行`,
      )
    }
  })

  test('具体平台/技术即使短也仍是 error（白名单不得过宽）', () => {
    // 白名单只收"通用概念"，不收"具体平台与具体技术"。
    // 这些词凭空出现就是实打实的编造——写进简历会被面试官问穿。
    //
    // 注意：不能拿 `CSS` 当反例——它**本来就在 fixture 原文里**
    // （`HTML / CSS / JavaScript`），凭空出现的是别的技术名。
    for (const tech of ['AWS', 'GCP', 'JVM', 'SSD', 'GPU', 'SQL', 'Kotlin']) {
      const rewritten = RESUME.replace(
        '- HTML / CSS / JavaScript（ES6）',
        `- HTML / CSS / JavaScript（ES6），熟悉 ${tech}`,
      )
      const report = verifyRewrite({ original: RESUME, rewritten })
      assert.equal(report.ok, false, `${tech} 是可验证的具体技术/平台，不得降级放行`)
      assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
    }
  })

  test('拉丁专名精确比对：原文已有的技术名加修饰语不得误拦', () => {
    // 反向保障：把包含判定从拉丁专名上移除后，
    // "给已有技术名加修饰/后缀"这类合法改写仍须放行（否则是新死锁）。
    const original = '- 熟悉 Redis 缓存与 MySQL 数据库的使用；\n- 使用 Vue2 编写主要展示页面；'
    for (const [from, to] of [
      ['- 熟悉 Redis 缓存与 MySQL 数据库的使用；', '- 熟悉 Redis 集群与 MySQL 数据库的使用；'],
      ['- 使用 Vue2 编写主要展示页面；', '- 使用 Vue2 组件化开发主要展示页面；'],
      ['- 熟悉 Redis 缓存与 MySQL 数据库的使用；', '- 熟练使用 redis 缓存并掌握 MySQL 数据库；'],
    ]) {
      const report = verifyRewrite({ original, rewritten: original.replace(from, to) })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `已有技术名加修饰是合法改写：${to}`,
      )
    }
  })

  // ── 「截断替换」必须被抓住（独立审查抓出：我的精确比对只做了一半）────────
  //
  // 根因：`appearsIn` 用的是**整篇原文的裸子串判定**
  // （`haystack.toLowerCase().includes(candidate.toLowerCase())`）。
  // 我把"与实体集合比对"改成精确匹配时**漏掉了这条短路**，
  // 于是从已有技术名里截掉一段仍被放行：
  //   `JavaScript` → `Java`（`'javascript'.includes('java')` 为真）
  // 现已改为带 token 边界的匹配。这组用例锁定该修复。
  test('从已有技术名截断的替换必须被抓住', () => {
    for (const [tech, truncated] of [
      ['JavaScript', 'Java'],
      ['PostgreSQL', 'Postgres'],
      ['MongoDB', 'Mongo'],
      ['ReactNative', 'React'],
    ]) {
      const report = verifyRewrite({
        original: `- 使用 ${tech} 实现核心功能；`,
        rewritten: `- 使用 ${truncated} 实现核心功能；`,
      })
      assert.equal(
        report.ok,
        false,
        `${tech} → ${truncated} 是截断换名（技术栈已不同），不得因裸子串包含而放行`,
      )
    }
  })

  test('截断到"普通英文词"时至少留 warn，不得静默放行（已声明的边界）', () => {
    // `Script` 命中普通英文词表（'script'），故只降级为 warn 而非 error。
    // 这是刻意的取舍：把 `script` 移出词表会误伤"自动化脚本"这类正常写法，
    // 而误报会让用户拿不到文件（本项目最严重的一类缺陷）。
    // 该边界已写入 GUARD_LIMITATIONS——此处锁定"至少有提示"。
    const report = verifyRewrite({
      original: '- 熟悉 TypeScript 开发；',
      rewritten: '- 熟悉 Script 开发；',
    })
    assert.ok(
      report.findings.length > 0,
      '即使不判 error，也必须留下提示，不能静默放行',
    )
  })

  test('通用工程/岗位缩写不得阻断交付（死锁扫描抓出：CI 曾被判编造）', () => {
    // 真实场景：把"持续集成"写成"持续集成（CI）"是 ATS 对齐的常见动作。
    // 早期实现把 `CI` 判为 FABRICATED_ENTITY 并**拒绝导出**——
    // 与 `CI/CD` 记号形态属同一类等价术语替换，只是写法不同。
    const original = '- 负责持续集成与自动化部署流程的搭建；\n- 负责接口开发工作；'
    for (const term of ['CI', 'CD', 'TDD', 'QA', 'PM', 'DevOps']) {
      const rewritten = original.replace(
        '- 负责持续集成与自动化部署流程的搭建；',
        `- 负责${term}（持续集成）与自动化部署流程的搭建；`,
      )
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `${term} 是通用工程缩写，等价术语替换不得阻断交付`,
      )
    }
  })

  test('原文已有的技术名重复出现不得误报（防止检查变成噪声源）', () => {
    const rewritten = RESUME.replace(
      '- 使用 Vuex 管理用户登录态与购物车数据；',
      '- 使用 Vuex 管理用户登录态与购物车数据，并沉淀 Vuex 模块化经验；',
    )
    const report = verifyRewrite({ original: RESUME, rewritten })
    assert.deepEqual(
      report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
      [],
      '原文已有的技术名不得被报为新增',
    )
  })

  test('单位换算不得被误报为新增专名（2.4s → 2400ms）', () => {
    const rewritten = RESUME.replace('2.4s 缩短至 1.8s', '2400ms 缩短至 1800ms')
    const report = verifyRewrite({ original: RESUME, rewritten })
    assert.ok(
      !report.findings.some((f) => f.code === 'FABRICATED_ENTITY'),
      '带单位的时间数值不是专名，不得误报',
    )
  })
})

// ── 结构性判据：区分"ATS 等价注记"与"新增技能主张" ───────────────────
//
// 【为什么这组用例是本轮最重要的回归】
// 前几版靠**枚举名单**决定某个拉丁词判 error 还是 warn。独立审查实测证明
// 这条路走不通：20 个最典型的"中文术语 → 英文缩写"ATS 对齐动作里
// **13 个仍被拒绝导出**（`超文本传输协议` → `HTTP`、`结构化查询语言` → `SQL`…），
// 因为该组合是**开放集合**，枚举必然滞后
//（与本项目 check-secrets 早已吸取的教训同构：那里也改成让 git 回答）。
//
// 现改为**结构性判据**（逐对比较改写单元与原文单元）：
//   ① 原有技术名消失            → 替换      → error
//   ② 处于括号/斜杠并列注记位    → ATS 等价  → warn（放行）
//   ③ 中文字数显著增长          → 新增主张  → error
//   ④ 原文该句无中文却多出技术名 → 新增主张  → error
//   ⑤ 用连接词并进列表          → 新增主张  → error
//   ⑥ 只出现在无法对齐的短行里   → 新增主张  → error
// 这组用例把两侧都钉住：**既不许死锁，也不许放掉编造**。
describe('守卫：ATS 等价注记必须放行（不得死锁）', () => {
  /** 最典型的 20 个「中文术语 → 英文缩写」对齐动作。 */
  const ATS_ALIGNMENTS = [
    ['超文本传输协议', 'HTTP'],
    ['超文本传输安全协议', 'HTTPS'],
    ['统一资源定位符', 'URL'],
    ['安全套接层协议', 'SSL'],
    ['可扩展标记语言', 'XML'],
    ['令牌校验机制', 'JWT'],
    ['接口数据格式', 'JSON'],
    ['配置文件格式', 'YAML'],
    ['接口设计规范', 'API'],
    ['软件开发工具包', 'SDK'],
    ['持续集成流程', 'CI/CD'],
    ['网络传输协议', 'TCP/IP'],
    ['表征状态转移架构', 'REST'],
    ['用户界面设计', 'UI'],
    ['关键绩效指标', 'KPI'],
    ['结构化查询语言', 'SQL'],
    ['层叠样式表', 'CSS'],
    ['超文本标记语言', 'HTML'],
    ['云服务平台', 'AWS'],
    ['容器编排平台', 'Kubernetes'],
  ]

  for (const [zh, en] of ATS_ALIGNMENTS) {
    test(`中文术语并列英文写法不得被拒：${zh}（${en}）`, () => {
      // 独立审查实测：这 20 个动作里曾有 13 个被拒绝导出 = 投递死锁
      const report = verifyRewrite({
        original: `- 熟悉${zh}，负责接口开发工作；`,
        rewritten: `- 熟悉${zh}（${en}），负责接口开发工作；`,
      })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `${zh} → ${en} 是 ATS 关键词对齐的常规动作，不得阻断导出`,
      )
    })
  }

  test('直接替换中文术语为缩写也要放行（中文数减少 = 等价写法）', () => {
    for (const [zh, en] of [
      ['超文本传输协议', 'HTTP'],
      ['结构化查询语言', 'SQL'],
      ['云服务平台', 'AWS'],
    ]) {
      const report = verifyRewrite({
        original: `- 熟悉${zh}，负责接口开发工作；`,
        rewritten: `- 熟悉 ${en}，负责接口开发工作；`,
      })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `${zh} → ${en} 属等价写法`,
      )
    }
  })
})

describe('守卫：结构性判据不得放掉真编造（另一侧锁定）', () => {
  test('技术名替换仍是 error（原有技术名消失）', () => {
    for (const [tech, other] of [
      ['Vue2', 'React'],
      ['CSS', 'SCSS'],
      ['JavaScript', 'Java'],
      ['PostgreSQL', 'Postgres'],
    ]) {
      const report = verifyRewrite({
        original: `- 使用 ${tech} 实现核心功能；`,
        rewritten: `- 使用 ${other} 实现核心功能；`,
      })
      assert.equal(report.ok, false, `${tech} → ${other} 是技术栈替换，必须拦`)
      assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
    }
  })

  test('新增技能主张仍是 error（中文字数增长 / 连接词并入 / 纯拉丁行）', () => {
    const cases = [
      ['中文字数增长', '- 熟悉 HTML 与 CSS；', '- 熟悉 HTML 与 CSS，熟悉 SQL；'],
      ['连接词并进列表', '- 使用 Vue2 编写页面；', '- 使用 Vue2 与 Kotlin 编写页面；'],
      ['高置信专名并入', '- 使用 Vue2 编写主要展示页面和商品列表模块；', '- 使用 Vue2 与 Kubernetes 编写主要展示页面和商品列表模块；'],
      ['纯拉丁行新增', '- HTML / CSS / JavaScript（ES6）', '- SQL / HTML / CSS / JavaScript（ES6）'],
    ]
    for (const [name, original, rewritten] of cases) {
      const report = verifyRewrite({ original, rewritten })
      assert.equal(report.ok, false, `${name} 属新增技能主张，必须拦下`)
    }
  })

  test('出现在无法对齐的短行里的新技术名仍是 error', () => {
    // `- 熟悉 SQL；` 短于内容单元阈值，无法与原文对齐——
    // ATS 注记必须发生在可对齐的内容行上，故这是新增主张。
    const report = verifyRewrite({
      original: '- 使用 Vuex 管理用户登录态与购物车数据；',
      rewritten: '- 熟悉 SQL；\n- 使用 Vuex 管理用户登录态与购物车数据；',
    })
    assert.equal(report.ok, false)
    assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
  })

  test('中文机构名替换仍是 error（结构性判据不得只看拉丁专名）', () => {
    // 这条由 `npm run check:guard` 抓出：结构性判据最初只比较**拉丁专名**的消失，
    // 于是"换了一家公司"这类最典型的编造被降级成 warn。
    // 中文机构名必须一并纳入"消失即替换"的判定。
    const report = verifyRewrite({
      original: '- 在某互联网公司实习，负责接口开发工作。',
      rewritten: '- 在字节跳动公司实习，负责接口开发工作。',
    })
    assert.equal(report.ok, false, '换公司名是编造，必须拦下')
    assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
  })

  test('替换"降级词"也必须算替换：REST → GraphQL', () => {
    // 【为什么专门测这一条（本轮自查抓出的真实漏报）】
    // `REST` 属被降级为 warn 的词，不在 error 级候选集里。
    // 替换检测若只在 error 候选集里比"谁消失了"，就看不到 `REST` 消失，
    // 于是 `REST → GraphQL` 这类**技术栈替换**被误判成"新增一个词"而降级为 warn。
    // 现改为用**全部拉丁 token**判消失。
    for (const [from, to] of [
      ['REST', 'GraphQL'],
      ['API', 'gRPC'],
      ['UI', 'WebGL'],
    ]) {
      const report = verifyRewrite({
        original: `- 对接后端 ${from} 接口，完成登录与购物车功能；`,
        rewritten: `- 对接后端 ${to} 接口，完成登录与购物车功能；`,
      })
      assert.equal(
        report.ok,
        false,
        `${from} → ${to} 是技术栈替换，不得因 ${from} 是降级词而漏掉`,
      )
      assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
    }
  })

  test('冒号/顿号引出新技能不得被当作"并列注记"放行', () => {
    // 【为什么专门测这一条（本轮自查抓出的绕过）】
    // "并列注记位"只认**括号与斜杠**（`（HTTP）`、`/ CI`）。
    // 若把 `：`、`、` 也算作注记位，`技能含：Redis` 这类"引出新一项"
    // 就会被误放行。
    for (const rewritten of [
      '- 使用 Vuex 管理用户登录态与购物车数据，技能含：Redis；',
      '- 使用 Vuex 管理用户登录态与购物车数据，掌握、Kafka；',
      '- 使用 Vuex 管理用户登录态与购物车数据，另掌握 Redis 缓存。',
    ]) {
      const report = verifyRewrite({
        original: '- 使用 Vuex 管理用户登录态与购物车数据；',
        rewritten,
      })
      assert.equal(report.ok, false, `引出新技能必须拦下：${rewritten}`)
    }
  })

  // ── 英文→中文的技术名替换不得静默（独立审查抓出的结构性缺口）──────────
  //
  // 【为什么这组用例至关重要】
  // 替换检测原先**包在 `fabricatedEntities` 循环里**，因此只在"新增了某个拉丁实体"
  // 时才执行。若消失的拉丁技术名被换成**纯中文表述**且没引入新拉丁词，
  // 整段逻辑一次都不跑 → **完全静默**（实测 `ok=true`、`findings=[]`）。
  // 而同一语义的 `CSS → SCSS` 却判 error，行为不一致。
  //
  // 严重级取 **warn 而非 error**：这类改动（换成中文表述 / 删掉技能）
  // **没有凭空增加主张**，与"编造"性质不同；判 error 会拦下合法改写造成死锁。
  test('英文技术名被改成中文表述：必须至少留 warn，不得静默', () => {
    for (const [tech, chinese] of [
      ['CSS', '层叠样式表'],
      ['Vuex', '状态管理库'],
      ['REST', '表述性状态转移'],
    ]) {
      const report = verifyRewrite({
        original: `- 熟悉 ${tech} 的使用，负责接口开发工作；`,
        rewritten: `- 熟悉${chinese}的使用，负责接口开发工作；`,
      })
      assert.ok(
        report.findings.some((f) => f.code === 'VANISHED_TECH_TERM'),
        `${tech} → ${chinese} 必须报 VANISHED_TECH_TERM，不得静默放行`,
      )
      assert.equal(report.ok, true, '这类改动不含凭空新增主张，不应阻断交付')
    }
  })

  test('删掉技能也必须留下提示（同一路径，不得静默）', () => {
    const report = verifyRewrite({
      original: '- 熟悉 HTML / CSS / JavaScript 的使用；',
      rewritten: '- 熟悉 HTML / JavaScript 的使用；',
    })
    assert.ok(
      report.findings.some((f) => f.code === 'VANISHED_TECH_TERM'),
      '删掉 CSS 应留下提示',
    )
  })

  test('有新技术名接替时仍判 error（不得退化成静默 warn）', () => {
    // 反向锁定：`VANISHED_TECH_TERM` 只负责"没有接替者"的情形；
    // 一旦有新技术名接替，仍属技术栈替换 → error。
    const report = verifyRewrite({
      original: '- 熟悉 CSS 的使用，负责页面开发工作；',
      rewritten: '- 熟悉 SCSS 的使用，负责页面开发工作；',
    })
    assert.equal(report.ok, false)
    assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
  })

  // ── "消失"必须是全文级，不得按句判定（独立审查抓出的假告警）────────────
  //
  // 【为什么这组用例至关重要】
  // 最初 `lost` 用的是 `!appearsIn(t, newUnit)`——即"**本句**里没有"。
  // 于是**折行/拆分**（最常规的改写）会误报：
  //   原文 `- 熟悉 Java / Spring Boot / MySQL / Redis / Kafka 的使用；`
  //   改写 `- 熟悉 Java / Spring Boot / MySQL；` + `- 熟悉 Redis / Kafka 的使用；`
  //   6 个词**全部仍在**（只是折到兄弟行），却被断言"6 个技术名在改写后消失"。
  //
  // 这是**事实错误的告警**：用户会去"补回"一个从未消失的技术名，
  // 与本项目"不制造虚假安全感"的原则直接冲突。
  test('技术列表折行：词仍在兄弟行，不得报"消失"（假告警）', () => {
    const report = verifyRewrite({
      original: '- 熟悉 Java / Spring Boot / MySQL / Redis / Kafka 的使用与调优；',
      rewritten:
        '- 熟悉 Java / Spring Boot / MySQL；\n- 熟悉 Redis / Kafka 的使用与调优；',
    })
    const vt = report.findings.find((f) => f.code === 'VANISHED_TECH_TERM')
    assert.equal(vt, undefined, '所有技术名都仍在，不得报"消失"')
    assert.deepEqual(
      report.findings.filter((f) => f.severity === 'error'),
      [],
      '折行是合法改写，不得产生任何 error',
    )
  })

  test('拆分/跨行搬移/合并都不得误报"技术名消失"', () => {
    for (const [original, rewritten] of [
      ['- 熟悉 Vue2 与 Vuex 的使用；', '- 熟悉 Vue2 的使用；\n- 熟悉 Vuex 的使用；'],
      ['- 熟悉 Redis 缓存；\n- 熟悉 MySQL 数据库；', '- 熟悉 MySQL 数据库；\n- 熟悉 Redis 缓存；'],
      ['- 熟悉 Redis 缓存；\n- 熟悉 MySQL 数据库；', '- 熟悉 Redis 缓存与 MySQL 数据库；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.ok(
        !report.findings.some((f) => f.code === 'VANISHED_TECH_TERM'),
        `词都还在，不得报消失：${rewritten}`,
      )
    }
  })

  // ── "消失"的判定范围：既不能是本句，也不能是全篇，而是**配对组** ──────────
  //
  // 【为什么这组用例是本轮最关键的一条】
  // 判"某技术名是否消失"的范围有三档，各错一边（都被实测/审查抓出）：
  //   · 本句级：**折行**时把折到兄弟行的词误报为"被替换"，
  //     与 ATS 注记叠加即**拒绝导出**（S1-1 同类死锁）。
  //   · 全篇级：把"某行偷偷换掉技术名、而技能区恰好还留着旧名"的替换**漏掉**
  //     —— `Vue2 → React` 因技能区仍有 `Vue2` 而被放行。
  //   · 配对组级（当前实现）：折行 = 同一句话分散到多行，词仍在组内 → 放行；
  //     句内换成别的词 → 组内确实没了 → 判替换。
  test('折行 + 新增技术名不得被误判为"替换"（本句级会误报并拒绝导出）', () => {
    const report = verifyRewrite({
      original: '- 熟悉 Java / MySQL 的使用；',
      rewritten: '- 熟悉 Java；\n- 熟悉 MySQL 与 Redis 的使用；',
    })
    // 真正的编造是"多了 Redis"，但绝不能断言"Java 被替换掉了"
    const fe = report.findings.find((f) => f.code === 'FABRICATED_ENTITY')
    assert.ok(
      fe === undefined || !/Java/.test(String(fe.message)),
      'Java 仍在改写结果中，不得被断言为"被替换"',
    )
  })

  test('折行 + ATS 注记必须可导出（与不折行的行为一致）', () => {
    const original = '- 熟悉 Java / MySQL / 超文本传输协议 的使用；'
    const notWrapped = '- 熟悉 Java / MySQL / 超文本传输协议（HTTP）的使用；'
    const wrapped = '- 熟悉 Java / MySQL 的使用；\n- 熟悉超文本传输协议（HTTP）的使用；'
    for (const rewritten of [notWrapped, wrapped]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `ATS 注记是合法改写，折行与否都不得拒绝导出：${rewritten}`,
      )
    }
  })

  test('同一技术名在多处出现时，句中换词仍须判替换（全篇级会漏报）', () => {
    // 技能区保留 Vue2、项目行悄悄换成 React —— 简历自相矛盾，属编造。
    const report = verifyRewrite({
      original: '- 技能：\n- Vue2\n\n项目：\n- 使用 Vue2 编写主要展示页面；',
      rewritten: '- 技能：\n- Vue2\n\n项目：\n- 使用 React 编写主要展示页面；',
    })
    assert.equal(
      report.ok,
      false,
      '技能区留着 Vue2、项目行换成 React，必须拦下（不得因全文仍有 Vue2 而放行）',
    )
    assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
  })

  // ── 「追加一整行编造技能」必须拦下，不得随句式/排版漂移 ────────────────
  //
  // 【为什么这组用例至关重要（独立审查抓出、对任意词成立的绕过）】
  // 新增技能的严重级原借用"中文字数增长比"作代理信号，于是**随排版漂移**：
  // ```
  //   原文：- 熟悉 Java 与 MySQL 的使用；
  //   改写：- 熟悉 Java 与 MySQL 的使用；
  //         - 熟悉 Redis 的使用；        ← 凭空多写的一项技能
  // ```
  // 新行汉字 5、配对原句汉字 6 → 增长比 −0.167 → 落进"中文换缩写"的等价档
  // → 只报 warn → **`exportResume` 实测导出成功且 `verified=true`**。
  // 固定句式只换技术名，**6/6 全部可绕过**。
  // 而"多加一行技能"正是本项目最该拦的编造类型。
  //
  // 现改为**结构性判据**（归属关系）：配对原句的内容已被一个几乎逐字相同的
  // 兄弟句完整保留，而本句多出原文全篇都没有的技术名 → 本句是纯增量 → error。
  test('追加一整行编造技能必须拦下（最短句式也不得放行）', () => {
    for (const tech of ['Redis', 'Docker', 'Golang', 'Kotlin', 'Consul', 'Kafka']) {
      const report = verifyRewrite({
        original: '专业技能：\n- 熟悉 Java 与 MySQL 的使用；',
        rewritten: `专业技能：\n- 熟悉 Java 与 MySQL 的使用；\n- 熟悉 ${tech} 的使用；`,
      })
      assert.equal(
        report.ok,
        false,
        `凭空多写一行「熟悉 ${tech}」必须拦下（不得因句式短而放行）`,
      )
      assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
    }
  })

  test('编造技能不得因排版形状不同而漂移（同一语义应在所有形状下都拦）', () => {
    const shapes = [
      '- 熟悉 Java 与 MySQL 与 Redis 的使用；',
      '- 熟悉 Java 与 MySQL 的使用；\n- 熟悉 Redis；',
      '- 熟悉 Java 与 MySQL 的使用；\n- 熟悉 Redis 的使用；',
      '- 熟悉 Java 与 MySQL 的使用；\n- 熟悉 Redis 缓存的使用；',
      '- 熟悉 Java 与 MySQL 的使用；\n- 熟练掌握 Redis 的使用；',
    ]
    for (const body of shapes) {
      const report = verifyRewrite({
        original: '专业技能：\n- 熟悉 Java 与 MySQL 的使用；',
        rewritten: `专业技能：\n${body}`,
      })
      assert.equal(report.ok, false, `新增 Redis 在任何排版下都必须拦：${body}`)
    }
  })

  test('而合法的 ATS 注记/缩写收缩任何形状下都必须放行', () => {
    const original = '专业技能：\n- 熟悉超文本传输协议，负责接口开发工作；'
    // 合法形态：① 括号注记 ② 句中直接换成缩写（收缩写法）。
    // 注意**不包含**"另起一行只写 `- 熟悉 HTTP；`"——那一形态与
    // "另起一行只写 `- 熟悉 Redis；`"在文本上完全相同（都是"独立新行 + 无注记位"），
    // 而后者是本项目最该拦的编造。纯文本无法知道 `HTTP` 与前者同义，
    // 故该形态一律判 error（宁可让用户把缩写写进原句，也不放行编造）。
    for (const body of [
      '- 熟悉超文本传输协议（HTTP），负责接口开发工作；',
      '- 熟悉 HTTP，负责接口开发工作；',
      '- 熟悉超文本传输协议 / HTTP，负责接口开发工作；',
    ]) {
      const report = verifyRewrite({
        original,
        rewritten: `专业技能：\n${body}`,
      })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `ATS 等价写法不得阻断交付：${body}`,
      )
    }
  })

  test('独立的"只写缩写"新行按新增技能处理（与编造无法区分，故拦截）', () => {
    // 已知取舍：`- 熟悉 HTTP；` 单起一行会被判 error，因为它在文本上与
    // `- 熟悉 Redis；`（编造）完全无法区分。此时正确做法是把缩写并入原句
    // （写成 `- 熟悉超文本传输协议（HTTP）…`），那是被放行的。
    const report = verifyRewrite({
      original: '专业技能：\n- 熟悉超文本传输协议，负责接口开发工作；',
      rewritten: '专业技能：\n- 熟悉超文本传输协议，负责接口开发工作；\n- 熟悉 HTTP；',
    })
    assert.equal(
      report.ok,
      false,
      '与编造形态不可区分的写法必须拦截（宁可要求并入原句）',
    )
  })

  // ── 注记位定位必须按 token 边界（独立审查抓出的真实误报/死锁）──────────
  //
  // 【缺陷背景】`isInlineAnnotation` 原用 `unit.indexOf(entity)` 定位新词。
  // 当 `entity` 是句中已出现词的**子串**时会定位到错误位置：
  // `熟悉 MySQL / 结构化查询语言（SQL）` 里 `indexOf('sql')` 命中 **`MySQL` 内部**，
  // 于是取到前文 `" My"` 而非 `"（"` → 合法的 `（SQL）` 注记被判"新增技能"
  // 并**拒绝导出**。`MySQL` 与 `SQL` 同现恰是简历最常见的组合。
  test('已出现词的子串不得干扰注记位定位：MySQL + （SQL）', () => {
    for (const [original, rewritten] of [
      ['- 熟悉 MySQL / 结构化查询语言 的使用；', '- 熟悉 MySQL / 结构化查询语言（SQL）的使用；'],
      ['- 熟悉 NoSQL / 结构化查询语言 的使用；', '- 熟悉 NoSQL / 结构化查询语言（SQL）的使用；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `合法的（SQL）注记不得被拒（子串碰撞）：${rewritten}`,
      )
    }
  })

  test('注记位判据对全部常见 ATS 词一致生效', () => {
    for (const [zh, en] of [
      ['结构化查询语言', 'SQL'],
      ['超文本传输协议', 'HTTP'],
      ['持续集成流程', 'CI'],
      ['接口设计规范', 'API'],
      ['云服务平台', 'AWS'],
    ]) {
      const report = verifyRewrite({
        original: `- 熟悉 MySQL / ${zh} 的使用；`,
        rewritten: `- 熟悉 MySQL / ${zh}（${en}）的使用；`,
      })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `${en} 的括号注记不得被拒`,
      )
    }
  })

  // ── 括号注记：宽松化的尝试被回退，此处锁定"严格版"行为 ──────────────
  //
  // 【为什么不放宽（一次失败尝试的完整记录，务必读）】
  // 真实简历实测发现两处误报：
  //   ① 多词英文全称 `GPA 3.6/4.0（Grade Point Average）` 被拒；
  //   ② 标题加英文对照 `## 专业技能（Skills）` 被判"凭空新增整条"。
  // 我于是放宽注记判据（"落在括号跨度内即算注记""剥掉纯拉丁注记后再比对原文"），
  // 两处误报确实修好了——**但独立审查逐条对比后抓出 4 处新泄漏**：
  //   `数据库（Random Keyspace）`、`数据库（Redis Cluster）`、
  //   `数据库（redis cluster）`、`## 项目经历（2024）`，全部从"拦住"变成"可导出"。
  // 即"修好 2 个误报，放过 4 个编造"——**净亏损**，已整体回退。
  //
  // 结论：**编造无法投递**的优先级高于"少拦几次"。括号注记保持严格：
  // 只有"紧邻左括号/斜杠 **且括号前是中文术语**"才放行（中文↔英文的 ATS 并列），
  // 其余一切括号内容都按新增主张处理。
  test('括号不得成为夹带编造技能的通道（严格版锁定）', () => {
    for (const [original, rewritten] of [
      // 中文在前的编造：必须拦
      ['- 熟悉数据库的使用；', '- 熟悉数据库（Random Keyspace）的使用；'],
      ['- 熟悉数据库的使用；', '- 熟悉数据库（Redis Cluster）的使用；'],
      ['- 熟悉数据库的使用；', '- 熟悉数据库（redis cluster）的使用；'],
      // 拉丁在前的编造（同一件事，不得因括号里词少就放行）
      ['- 熟悉 Java；', '- 熟悉 Java（Redis）的使用；'],
      ['- 熟悉 Java；', '- 熟悉 Java（Redis Cluster）的使用；'],
      ['- 熟悉 Java；', '- 熟悉 Java（Redis、Kafka）的使用；'],
      // 标题里夹带（中文括号内容）
      ['# 张伟\n## 项目经历\n- 熟悉 Java；', '# 张伟\n## 项目经历（2024）\n- 熟悉 Java；'],
      ['# 张伟\n## 项目经历\n- 熟悉 Java；', '# 张伟\n## 项目经历（用户增长系统）\n- 熟悉 Java；'],
      ['# 张伟\n## 项目经历\n- 熟悉 Java；', '# 张伟\n## 项目经历（Redis）\n- 熟悉 Java；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.equal(
        report.ok,
        false,
        `借括号夹带原文没有的内容必须拦下：${rewritten}`,
      )
    }
  })

  test('同一件事不得因括号里的词数不同而一放一拦（判定一致性）', () => {
    // 【实测抓出的既有不一致】同样声称原文没有的 Redis：
    //   `- 熟悉 Java（Redis）的使用；`        → 曾放行
    //   `- 熟悉 Java（Redis Cluster）的使用；` → 曾拦住
    // 只因多写一个词。根因是"紧邻左括号即放行"没要求括号前是中文。
    // 现统一：括号前是拉丁词时必须满足"全大写缩写 + 其展开"，否则拦住。
    for (const annotated of ['（Redis）', '（Redis Cluster）', '（Redis 缓存与消息队列）']) {
      const report = verifyRewrite({
        original: '- 熟悉 Java；',
        rewritten: `- 熟悉 Java${annotated}的使用；`,
      })
      assert.equal(report.ok, false, `声称原文没有的 Redis 必须拦下：${annotated}`)
    }
  })

  test('残余泄漏已收口：中文在后、拉丁短语在括号内现在会被拦', () => {
    // 这一形态**曾经只报 warn**（可导出），属已声明的残余风险：
    //   `- 熟悉 Java；` → `- 熟悉 Java（Redis 缓存与消息队列）的使用；`
    // 根因是"紧邻左括号即算注记位"没要求括号前是**中文**。
    // 现要求括号前为中文术语，故该形态被正确拦下（与 `（Redis）` 判定一致）。
    const report = verifyRewrite({
      original: '- 熟悉 Java；',
      rewritten: '- 熟悉 Java（Redis 缓存与消息队列）的使用；',
    })
    assert.equal(report.ok, false, '声称原文没有的 Redis 必须拦下')
    assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
  })

  test('合法的中文↔英文并列注记必须放行', () => {
    // 这是严格版仍然支持的形态：**括号前是中文术语**。
    for (const [original, rewritten] of [
      ['- 熟悉超文本传输协议的使用；', '- 熟悉超文本传输协议（HTTP）的使用；'],
      ['- 熟悉结构化查询语言的使用；', '- 熟悉结构化查询语言（SQL）的使用；'],
      ['- 熟悉接口设计规范的使用；', '- 熟悉接口设计规范（API）的使用；'],
      ['- 熟悉持续集成流程的使用；', '- 熟悉持续集成流程 / CI 的使用；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `中文术语并列英文写法是 ATS 常规动作，不得拒绝导出：${rewritten}`,
      )
    }
  })

  // ── 多词拉丁注记：只认"缩写 + 其全称" ────────────────────────────────
  //
  // 【判据来源】两类多词括号内容在**是否新增技能主张**上本质不同：
  //   · 展开已有缩写 `JVM（Java Virtual Machine）` → 未声称新技能 → 应放行；
  //   · 借括号夹带 `数据库（Redis Cluster）` → 真正的编造 → 必须拦。
  // 故对"括号前是拉丁词"的情形，要求括号内各词首字母拼起来等于该词。
  // 这只是必要条件（`SQL（Simple Query Layer）` 也能满足），
  // 但它展开的是**已有**技能，未新增技能主张，危害有限。
  test('缩写展开为全称必须放行（未新增技能主张）', () => {
    for (const [original, rewritten] of [
      ['- 精通 JVM 调优；', '- 精通 JVM（Java Virtual Machine）调优；'],
      ['GPA 3.6/4.0，专业排名前 15%', 'GPA 3.6/4.0（Grade Point Average），专业排名前 15%'],
      // camelCase 全称：HTTP = HyperText Transfer Protocol
      // （取"所有大写字母"而非"每词首字母"，否则会得到 HTP 而误判）
      ['- 熟悉 HTTP 协议；', '- 熟悉 HTTP（HyperText Transfer Protocol）协议；'],
      ['- 熟悉 SQL 查询；', '- 熟悉 SQL（Structured Query Language）查询；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `把已有缩写展开成全称是合法写法，不得拒绝导出：${rewritten}`,
      )
    }
  })

  test('首字母/大小写对不上的括号内容仍按新增主张拦下', () => {
    for (const [original, rewritten] of [
      // Java 不是缩写（带小写字母），给它挂"全称"只可能是编造
      ['- 熟悉 Java；', '- 熟悉 Java（Just Another Vague Abbreviation）；'],
      ['- 熟悉 Java；', '- 熟悉 Java（Java Application Virtual Architecture）；'],
      // 括号内是原文没有的技能
      ['- 熟悉数据库的使用；', '- 熟悉数据库（Random Keyspace）的使用；'],
      ['- 熟悉数据库的使用；', '- 熟悉数据库（Redis Cluster）的使用；'],
      ['- 熟悉数据库的使用；', '- 熟悉数据库（Very Fast Cache）的使用；'],
      ['- 熟悉数据库的使用；', '- 熟悉数据库（redis cluster）的使用；'],
      ['- 熟悉 Java；', '- 熟悉 Java（Redis、Kafka）的使用；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.equal(report.ok, false, `借括号夹带原文没有的内容必须拦下：${rewritten}`)
    }
  })

  test('「已有技术名 + 英文全称」降为 warn（歧义档，不阻断但必须提示）', () => {
    // 【为什么这一条不是 error】它既不像 `Java（Redis）` 那样**明确夹带新技术**
    // （括号内全是英文描述词，未点名别的技术名），
    // 也不像 `Java（Just Another …）` 那样首字母对不上。
    // 文本上无法区分"给已有技术名补全称"与"顺手多写个相关词"，
    // 故按歧义档处理：**报 warn 让人确认，但不阻断交付**
    //（若判 error，模型做 ATS 对齐时写 `Java（Java Virtual Machine）`
    // 就会拿不到文件）。
    for (const [original, rewritten] of [
      ['- 熟悉 Java；', '- 熟悉 Java（Java Virtual Machine）的使用；'],
      ['- 熟悉 Redis；', '- 熟悉 Redis（Remote Dictionary Server）的使用；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.equal(report.ok, true, `此类全称展开不应阻断交付：${rewritten}`)
      assert.ok(
        report.findings.some((f) => f.code === 'AMBIGUOUS_NEW_TERM'),
        '必须报出待确认，不得静默放过',
      )
    }
  })

  // ── 中文术语 + 英文全称展开（误报已修）───────────────────────────────
  //
  // 此前这是一条**已知误报**：括号前是中文时"无法做首字母校验"，
  // 于是 `超文本传输协议（HyperText Transfer Protocol）` 被拒。
  // 现已修好——判据改为"括号前是**中文术语**即视为 ATS 并列"（规则 ①），
  // 不再要求括号内满足"全大写缩写 + 展开"（那是对拉丁前缀的要求）。
  test('中文术语 + 英文全称展开必须放行', () => {
    for (const [original, rewritten] of [
      ['- 熟悉超文本传输协议的使用；', '- 熟悉超文本传输协议（HyperText Transfer Protocol）的使用；'],
      ['- 实现断点续传；', '- 实现断点续传（Resumable Upload）；'],
      ['- 熟悉负载均衡的使用；', '- 熟悉负载均衡（Load Balancing）的使用；'],
      ['- 熟悉面向对象的使用；', '- 熟悉面向对象（Object Oriented）的使用；'],
      ['- 熟悉结构化查询语言的使用；', '- 熟悉结构化查询语言（Structured Query Language）的使用；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `中文术语并列英文全称是 ATS 常规动作，不得拒绝导出：${rewritten}`,
      )
    }
  })

  // ── 标题 + 通用英文词注记（误报已修，且不得借此夹带）──────────────────
  //
  // 【为什么这类特判是安全的，而上一轮"剥括号"方案被判净亏损回退】
  // 上一轮是"剥掉任意括号再看原文有没有"——会放过 `## 项目经历（用户增长系统）`
  // （剥掉得 `项目经历`，原文确实有）。
  // 本轮的判据多了两条**必要限定**：
  //   ① 括号内容必须是**单个通用英文词**（守卫已判为"泛指、非专名"，
  //      即 `extractAmbiguousLatinTokens` 收录的那类：Skills/Education/Projects）；
  //   ② 剥掉括号后的标题须在原文里出现过。
  // 于是 `（Redis）`（专名）、`（2024）`（数字）、`（用户增长系统）`（汉字）、
  // `（Random Keyspace）`（多词）**全部仍被拦**（下方成对用例锁定）。
  test('标题加通用英文词对照必须放行（标题被撑成内容单元的误报）', () => {
    for (const [title, annotated] of [
      ['专业技能', '专业技能（Skills）'],
      ['教育背景', '教育背景（Education）'],
      ['项目经历', '项目经历（Projects）'],
      ['实习经历', '实习经历（Internship）'],
    ]) {
      const report = verifyRewrite({
        original: `# 张伟\n## ${title}\n- 熟悉 Java；`,
        rewritten: `# 张伟\n## ${annotated}\n- 熟悉 Java；`,
      })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `标题并列英文对照是 ATS 常见写法，不得拒绝导出：${annotated}`,
      )
    }
  })

  test('但括号里是专名/数字/中文/多词时仍按新增内容拦下', () => {
    for (const [title, annotated] of [
      ['项目经历', '项目经历（Redis）'], // 专有技术名
      ['项目经历', '项目经历（2024）'], // 数字（凭空加年份）
      ['项目经历', '项目经历（用户增长系统）'], // 汉字（编造项目名）
      ['项目经历', '项目经历（Random Keyspace）'], // 多词专名
      ['项目经历', '项目经历（Very Fast Cache）'], // 多词
    ]) {
      const report = verifyRewrite({
        original: `# 张伟\n## ${title}\n- 熟悉 Java；`,
        rewritten: `# 张伟\n## ${annotated}\n- 熟悉 Java；`,
      })
      assert.equal(
        report.ok,
        false,
        `借标题括号夹带原文没有的内容必须拦下：${annotated}`,
      )
    }
  })

  test('常见简历栏目的英文名不得被误判为专有技术名', () => {
    // 【真实简历实测抓出的分类不一致】
    // `EN_STOPWORDS` 里原本有 skills/education/projects/internship/awards，
    // 却漏了同样常见的 objective/campus/volunteer/activities/interests/
    // languages/coursework/overview/background/qualification/accomplishments。
    // 后果：`## 专业技能（Skills）` 放行，而 `## 校园经历（Campus）` **拒绝导出**。
    for (const heading of [
      'Summary', 'Objective', 'Profile', 'Experience', 'Education', 'Skills',
      'Projects', 'Internship', 'Campus', 'Awards', 'Certifications',
      'Publications', 'Volunteer', 'Activities', 'Interests', 'Languages',
      'Training', 'Achievements', 'Honors', 'Coursework', 'Research',
      'Leadership', 'Overview', 'Background', 'Qualification', 'Accomplishments',
    ]) {
      const report = verifyRewrite({
        original: `# 张伟\n## 中文栏目\n- 熟悉 Java；`,
        rewritten: `# 张伟\n## 中文栏目（${heading}）\n- 熟悉 Java；`,
      })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `栏目名「${heading}」是普通英文名词，不得阻断交付`,
      )
    }
  })

  test('但具体技术名仍必须判为专名（补词表不得误伤）', () => {
    // 反向锁定：上一用例给词表补了栏目名，不能因此把技术名也放进通用词表。
    for (const tech of ['Redis', 'Kubernetes', 'Kafka', 'Docker', 'MySQL', 'React', 'SCSS', 'Golang']) {
      const report = verifyRewrite({
        original: '- 熟悉 Java；',
        rewritten: `- 熟悉 Java；\n- 熟悉 ${tech}；`,
      })
      assert.equal(report.ok, false, `具体技术名「${tech}」必须仍被拦下`)
    }
  })

  // ── markdown 有序列表序号不是"编造数字"（真实简历实测抓出的死锁）──────
  //
  // 【为什么（实测）】把无序列表改成有序列表是最常见的排版动作：
  //   `- 熟悉 Java\n- 熟悉 MySQL` → `1. 熟悉 Java\n2. 熟悉 MySQL`
  // 而 `1`/`2`/`3` 会被当作"改写后新增的数字"→ 判 FABRICATED_NUMBER
  // → **拒绝导出**。但它们是**排版序号**，不含任何事实主张。
  // 修法是在 normalizeText 最前面就剥掉行首序号，使所有下游检查都看不到它们。
  test('把无序列表改成有序列表不得被判为编造数字', () => {
    for (const [original, rewritten] of [
      [
        '## 专业技能\n- 熟悉 Java\n- 熟悉 MySQL\n- 了解 Docker\n',
        '## 专业技能\n1. 熟悉 Java\n2. 熟悉 MySQL\n3. 了解 Docker\n',
      ],
      ['- 提升 40%；', '1. 提升 40%；'], // 序号 + 真实数字保留
      ['- 熟悉 Java', '1) 熟悉 Java'], // 另一种序号写法
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `列表序号是排版，不得当成编造数字：${rewritten}`,
      )
    }
  })

  test('但序号化不能掩盖真实的编造数字', () => {
    // 反向锁定：剥掉序号的同时，被改动的真实数值必须仍被抓。
    for (const [original, rewritten] of [
      ['- 提升 40%；', '1. 提升 65%；'],
      ['- 服务 8 万用户；', '1. 服务 80 万用户；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.equal(report.ok, false, `序号化不得掩护编造数字：${rewritten}`)
      assert.ok(report.findings.some((f) => f.code === 'FABRICATED_NUMBER'))
    }
  })

  // ── markdown 排版语法不是"新增内容"（真实简历实测抓出的一批死锁）──────
  //
  // 【为什么】下列都是**纯排版动作**，却会把 markdown 语法本身当成新内容：
  //   · 加链接 `[文字](url)` → `https` 被当成新增技术名 → 拒绝导出
  //   · 表格化 `| a | b |`   → `| 类别 | 内容 |` 被判"凭空新增"
  //   · 加水平线 `---`、斜体说明 `*…*`
  // 实测这批动作让真实简历误报率达 25%。修法：内容单元比对前用
  // `stripMarkdownSyntax` 剥离语法（只在这一处，避免影响"技术名是否存在"判定）。
  test('markdown 排版语法（链接/表格/水平线/斜体）不得被判为新增内容', () => {
    for (const [original, rewritten] of [
      ['GitHub：github.com/liuyang', 'GitHub：[github.com/liuyang](https://github.com/liuyang)'],
      ['- 熟悉 Java\n- 熟悉 MySQL', '| 类别 | 内容 |\n|---|---|\n| 后端 | Java |\n| 数据 | MySQL |'],
      ['# 张伟\n- 熟悉 Java；', '# 张伟\n\n---\n\n- 熟悉 Java；'],
      ['- 熟悉 Java；', '- **熟悉 Java**；'],
      ['- 熟悉 Java；', '- `熟悉 Java`；'],
      ['- 熟悉 Java；', '  - 熟悉 Java；'],
      ['- 支持 2GB 大文件；', '- 支持 2 GB 大文件；'],
      ['- 电话：136-0000-0000', '- 电话：+86-136-0000-0000'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `纯排版动作不得拒绝导出：${rewritten}`,
      )
    }
  })

  test('但标题行新增仍按事实主张拦下（排版豁免不得掩护编造章节）', () => {
    // 反向锁定：`stripMarkdownSyntax` 会剥掉 `##`，但"标题行多了一个章节/项目"
    // 是硬性事实主张，必须仍判 error（成对用例）。
    for (const annotated of ['用户增长系统', '2024', 'Redis']) {
      const report = verifyRewrite({
        original: '# 张伟\n## 项目经历\n- 熟悉 Java；',
        rewritten: `# 张伟\n## 项目经历（${annotated}）\n- 熟悉 Java；`,
      })
      assert.equal(report.ok, false, `标题行新增「${annotated}」必须拦下`)
    }
  })

  test('页码/页脚与职能类英文词不得造成误报', () => {
    for (const [original, rewritten] of [
      // 页码是纯排版；不剥离则 `1` 被当成编造数字
      ['## 项目经历\n- 使用 SQL 与 Python 清洗 200 万条行为数据；',
        '## 项目经历\n- 使用 SQL 与 Python 清洗 200 万条行为数据；\n\n---\n\n第 1 页 / 共 1 页\n'],
      ['Page 1 of 1', 'Page 1 of 1'],
      // 职能类普通英文词（`数据分分析师（Data Analyst）`）
      ['- 求职意向：数据分析师', '- 求职意向：数据分析师（Data Analyst）'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `不得拒绝导出：${rewritten}`,
      )
    }
  })

  test('但新增技能条目仍必须拦下（职能词补表不得掩护技能主张）', () => {
    // 反向锁定：给词表补了 analyst/engineer 等职能词，不能因此放过"新增技能"。
    for (const [original, rewritten] of [
      ['- 熟悉 Tableau；', '- 熟悉 Tableau；\n- 熟悉 Excel 数据透视与函数；'],
      ['- 熟悉 SQL；', '- 熟悉 SQL；\n- 熟悉 Python pandas；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.equal(report.ok, false, `新增技能条目必须拦下：${rewritten}`)
    }
  })

  // ── "英文翻译"不得被判为新增技术名 ──────────────────────────────────
  //
  // 【为什么】中文术语/学科名/项目名并列英文写法时，括号内是**英文翻译**：
  //   `Verilog Hardware Description Language`、
  //   `电子信息工程（Electronic Information Engineering）`、
  //   `智能小车控制系统（Smart Car Control System）`
  // 其中 Hardware/Description/Electronic/Information/Smart/Car 等是普通英文名词，
  // 但它们原本不在词表里 → 被判"新增技术名" → **拒绝导出**。
  // 与"常见简历栏目名漏收""英文全称里的通用词漏收"是同一类问题。
  test('中文名并列英文翻译必须放行', () => {
    for (const [original, rewritten] of [
      ['- 熟悉 Verilog HDL 硬件描述语言', '- 熟悉 Verilog Hardware Description Language'],
      ['- 电子信息工程', '- 电子信息工程（Electronic Information Engineering）'],
      ['- 智能小车控制系统', '- 智能小车控制系统（Smart Car Control System）'],
      ['- 熟悉 PID 调速', '- 熟悉 PID（比例-积分-微分）调速'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `英文翻译是等价写法，不得拒绝导出：${rewritten}`,
      )
    }
  })

  test('但真实技术名仍必须判为专名（翻译词补表不得误伤）', () => {
    // 反向锁定：`Verilog` 是真正的技术名（硬件描述语言），必须在 error 级；
    // 若被一并收进通用词表，"新增 Verilog 技能"就会被放过。
    for (const tech of ['Verilog', 'MATLAB', 'STM32', 'Redis', 'Kubernetes', 'Python', 'Docker']) {
      const report = verifyRewrite({
        original: '- 熟悉 C++；',
        rewritten: `- 熟悉 C++；\n- 熟悉 ${tech}；`,
      })
      assert.equal(report.ok, false, `新增技术名「${tech}」必须仍被拦下`)
    }
  })

  test('补充的技术细节（型号/版本/百分位）仍按事实主张拦下', () => {
    // 这些不是"等价写法"，而是**新增的事实信息**，必须拦：
    //   STM32 → STM32F103（换了芯片型号）
    //   Python → Python 3.x（加了版本）
    //   546 分 → 546 分（前 12%）（加了排名主张）
    for (const [original, rewritten] of [
      ['- 使用 STM32 开发控制模块；', '- 使用 STM32F103 开发控制模块；'],
      ['- 熟悉 Python 与 MATLAB；', '- 熟悉 Python 3.x 与 MATLAB R2023b；'],
      ['- CET-6 546 分；', '- CET-6 546 分（前 12%）；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.equal(report.ok, false, `新增技术细节必须拦下：${rewritten}`)
    }
  })

  // ── 英文简历（插件支持 language: 'en'，此前测试全是中文）────────────────
  //
  // 【实测抓出的两处真问题】
  // ① 职责词表原本只有中文 → 英文简历上这道检查**完全空转**：
  //      `Participated in database optimization`（辅助层）
  //      → `Led database optimization`（主导层）
  //    零告警 —— "参与写成主导"这类最典型的事实夸大被一放到底。
  // ② 英文月份缩写被判为新增技术名：
  //      `2022.09 - 2026.06` → `Sep 2022 - Jun 2026` 是日期格式统一，
  //      但 `Sep`/`Jun` 被判 FABRICATED_ENTITY → 拒绝导出。
  test('英文职责升格必须被抓住（词表原本只有中文，此检查在英文简历上曾空转）', () => {
    for (const [original, rewritten] of [
      [
        '- Participated in database optimization, improving query performance',
        '- Led database optimization, improving query performance',
      ],
      ['- Assisted with API development', '- Owned API development'],
      ['- Contributed to the payment module', '- Spearheaded the payment module'],
      ['- Helped build the admin panel', '- Architected the admin panel'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.equal(report.ok, false, `英文职责升格必须拦下：${rewritten}`)
      assert.ok(
        report.findings.some((f) => f.code === 'RESPONSIBILITY_INFLATED'),
        '必须报出 RESPONSIBILITY_INFLATED',
      )
    }
  })

  test('英文职责等强度改写不得误报', () => {
    for (const [original, rewritten] of [
      ['- Participated in database optimization', '- Participated in the optimization of the database'],
      ['- Developed 12 REST APIs', '- Built 12 REST APIs'],
      ['- Familiar with React', '- Familiar with the React framework'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `等强度英文改写不得拒绝导出：${rewritten}`,
      )
    }
  })

  test('英文月份缩写（日期格式统一）不得被判为新增技术名', () => {
    for (const [original, rewritten] of [
      ['Computer Science, 2022.09 - 2026.06', 'Computer Science, Sep 2022 - Jun 2026'],
      ['2021.01 - 2021.12', 'Jan 2021 - Dec 2021'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `日期格式统一不得拒绝导出：${rewritten}`,
      )
    }
  })

  // ── 英文"缩写 ⇄ 全称"（英文简历里的直接替换，中文侧是括号注记）──────
  //
  // 【实测】中文里这类形态是**括号注记**（`超文本传输协议（HTTP）`），早已放行；
  // 英文简历没有括号，缩写与全称是**直接替换**，于是走了"技术名替换"→ 拦住：
  //   `Familiar with JVM` → `Familiar with Java Virtual Machine`
  //   → 报「技术名被替换：JVM → Java」，拒绝导出。
  test('英文缩写展开为全称必须放行', () => {
    // 说明：只覆盖"逐词首字母"型缩写（1 字母/词），这也是最常见形态。
    // `REST` = **R**epresentational State Transfer（E 取自词内）属
    // "词内取字母"型，与 `Java`（普通单词、首字母拼写恰好=JAVA）在文本上
    // 无法区分，故**不纳入豁免**——详见 GUARD_LIMITATIONS。
    // 宁可让 `REST → 全称` 这类少量合法改写被拦，也不放过
    // `Java → Java Virtual Machine`（那确实新增了 JVM 主张）。
    for (const [original, rewritten] of [
      ['- Familiar with JVM', '- Familiar with Java Virtual Machine'],
      ['- Knows SQL well', '- Knows Structured Query Language well'],
      ['- Used HTTP protocol', '- Used HyperText Transfer Protocol'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `英文缩写展开不得拒绝导出：${rewritten}`,
      )
    }
  })

  test('数字式缩写（K8s / i18n）的缩写表达式必须放行', () => {
    // 判据可验证：全称长度须等于 数字+2，且首尾字母相符。
    // 因此不会像"首字母拼写"那样被普通单词蹭到（见下方反向用例）。
    for (const [original, rewritten] of [
      ['- Deployed on K8s', '- Deployed on Kubernetes'],
      ['- Added i18n support', '- Added internationalization support'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `数字式缩写的全称改写不得拒绝导出：${rewritten}`,
      )
    }
  })

  test('但数字式缩写不得成为编造技术的通道', () => {
    // 反向锁定：`K8s → Kafka` 首尾虽是 K/s，但长度 5 ≠ 8+2，必须拦。
    for (const [original, rewritten] of [
      ['- Deployed on K8s', '- Deployed on Kafka'],
      ['- Deployed on Docker', '- Deployed on Docker and Kubernetes'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      const blocked = !report.ok || report.findings.some((f) => f.code === 'FABRICATED_ENTITY')
      assert.ok(blocked, `不得借数字式缩写放过编造：${rewritten}`)
    }
  })

  test('但缩写豁免不得被"字面缩写"蹭到（实测抓出的严重漏报）', () => {    // 判据若写成"短语的大写字母拼起来等于缩写"，会出现这种错配：
    //   原文有 `REST`；改写 `- 使用 REST ... redis ... mysql ...`
    //   取 4 词窗口 `["REST","redis","mysql","s"]`，其大写字母正好是 REST
    //   → `redis`/`mysql` 被当成"REST 的展开"而放行。
    // 实测后果：凭空新增技术名从 error 降为 warn。
    const base = [
      '技能：',
      '- 对接后端 REST 接口，完成登录与购物车功能；',
      '- 使用 Vuex 管理用户登录态与购物车数据；',
    ].join('\n')
    const rewritten = base.replace(
      '- 使用 Vuex 管理用户登录态与购物车数据；',
      '- 使用 REST 与 redis 管理用户登录态与购物车数据；',
    )
    const report = verifyRewrite({ original: base, rewritten })
    assert.equal(report.ok, false, '凭空新增 redis 必须被拦下（不得被 REST 蹭掉）')
    assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
  })

  // ── 英文数量级（K/M/B）——与中文数量级同源，英文侧曾漏做 ────────────────
  //
  // 【实测】`Handled 8K requests` → `Handled 8000 requests` 被判
  // FABRICATED_NUMBER 并拒绝导出；反向（`8000` → `8K`）同样被拒；
  // `1.5M` ↔ `1500000` 同理。这与早就修好的 `8 万` ↔ `80000`
  // 是**完全同类**的问题——中文侧修了，英文侧漏了。
  // 只统一**写法**，不放宽判定：`8K → 80K` 仍会被抓。
  test('英文数量级 K/M/B 的等价写法必须放行', () => {
    for (const [original, rewritten] of [
      ['- Handled 8K requests daily', '- Handled 8000 requests daily'],
      ['- Handled 8000 requests daily', '- Handled 8K requests daily'],
      ['- 12K records processed', '- 12000 records processed'],
      ['- 1.5M users', '- 1500000 users'],
      ['- 1500000 users', '- 1.5M users'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `数量级写法差异不得拒绝导出：${rewritten}`,
      )
    }
  })

  test('但英文数量级的真实改动仍必须抓（K/M/B 归一化不得放宽判定）', () => {
    for (const [original, rewritten] of [
      ['- Handled 8K requests daily', '- Handled 80K requests daily'],
      ['- 1.5M users', '- 2.5M users'],
      ['- 12K records', '- 120K records'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.equal(report.ok, false, `数量真的变了必须拦：${rewritten}`)
      assert.ok(report.findings.some((f) => f.code === 'FABRICATED_NUMBER'))
    }
  })

  test('容量/时间单位不得被误当数量级（8KB 与 8K 是两回事）', () => {
    // `8KB` 走单位表（size），`8K users` 走数量级（8000）。
    // 若把 `K` 无差别当数量级，`8KB` 会被错算成 8192，与 `8 KB` 不等价。
    for (const [original, rewritten] of [
      ['- 支持 8KB 文件；', '- 支持 8 KB 文件；'],
      ['- 耗时 2.4s；', '- 耗时 2400ms；'],
      ['- 缓存 100MB；', '- 缓存 100 MB；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `单位换算不得拒绝导出：${rewritten}`,
      )
    }
  })

  // ── 日期：英文年月 + 同一年内的月份改动 ─────────────────────────────
  //
  // 【实测抓出的两处真问题】
  // ① 英文年月无法解析：`Sep 2022` 只抽到年份 `2022`（月份丢失），
  //    于是英文简历上"月份被改动"完全查不出来。
  // ② **中文侧也有漏报**：`- 2022年9月入职；` → `- 2022年10月入职；`
  //    日期 token 确实不同（`2022-09` vs `2022-10`），但判定逻辑里
  //    "年份出现过就放行"把**同年内的月份改动**一并放过了。
  test('英文年月（Sep 2022 / 2022 Sep）必须能被解析', () => {
    for (const [input, expected] of [
      ['Sep 2022 - Jun 2026', ['2022-09', '2026-06']],
      ['September 2022', ['2022-09']],
      ['2022 Sep', ['2022-09']],
      ['Jan 2021 - Dec 2021', ['2021-01', '2021-12']],
    ]) {
      const got = [...extractDateTokens(input)].sort()
      assert.deepEqual(got, expected.slice().sort(), `${input} 的年月解析不正确`)
    }
  })

  test('中文年月解析不得因新增英文规则而退化', () => {
    // 反向锁定：加英文月份解析时，我一度让 `2022年9月` 只抽出 `2022`
    // （分支判断按 capture 顺序猜，把数字月份走进了英文分支）。
    // 这条用例确保中文主路径不受影响。
    for (const [input, expected] of [
      ['2022年9月入职', ['2022-09']],
      ['2022.09', ['2022-09']],
      ['2022-09', ['2022-09']],
      ['2019 - 2021', ['2019', '2021']],
    ]) {
      const got = [...extractDateTokens(input)].sort()
      assert.deepEqual(got, expected.slice().sort(), `${input} 的中文年月解析不正确`)
    }
  })

  test('月份改动（中文与英文）都必须判为日期改动', () => {
    for (const [original, rewritten] of [
      ['- 2022年9月入职；', '- 2022年10月入职；'], // 中文，同年内换月
      ['- Sep 2022 - Jun 2026', '- Oct 2022 - Jun 2026'], // 英文缩写
      ['- September 2022', '- October 2022'], // 英文全称
      ['- Sep 2022', '- Sep 2021'], // 年份改动
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.equal(report.ok, false, `日期改动必须拦下：${rewritten}`)
      assert.ok(
        report.findings.some((f) => f.code === 'FABRICATED_DATE'),
        `必须报出 FABRICATED_DATE：${rewritten}`,
      )
    }
  })

  test('但"原文只有年份、改写补全月份"不算日期改动', () => {
    // 反向锁定：`2022` → `2022年9月` 是写法完善，不是改动，
    // 不得因此拒绝导出（这是当年加"年份放行"的原始动机，必须保住）。
    for (const [original, rewritten] of [
      ['- 2022 年毕业；', '- 2022年9月毕业；'],
      ['- 2022', '- Sep 2022'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.code === 'FABRICATED_DATE').map((f) => f.code),
        [],
        `补全月份不得判为日期改动：${rewritten}`,
      )
    }
  })

  test('正文里的说明性文字降为 warn（不含事实主张，不阻断交付）', () => {
    // 落款、章节导语这类新增文字不含数字/机构/技术名/职责主张，
    // 判 error 只会让用户拿不到文件。降为 warn：提示但不阻断。
    // 注意：文本需 ≥ 8 字才会成为"内容单元"（短行本就不参与逐条比对，
    // 因此也不会报出）——这里用足够长的落款与导语。
    for (const [original, rewritten] of [
      [
        '## 项目经历\n- 使用 Java 开发订单系统，负责核心模块设计与实现；',
        '## 项目经历\n- 使用 Java 开发订单系统，负责核心模块设计与实现；\n\n*本简历内容均由本人独立撰写，真实有效。*',
      ],
      [
        '## 项目经历\n- 使用 Java 开发订单系统，负责核心模块设计与实现；',
        '## 项目经历\n> 以下经历按时间倒序排列，均可提供证明材料。\n- 使用 Java 开发订单系统，负责核心模块设计与实现；',
      ],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.equal(report.ok, true, `说明性文字不应阻断交付：${rewritten}`)
      assert.ok(
        report.findings.some((f) => f.code === 'NOVEL_CONTENT' && f.severity === 'warn'),
        '必须报出 warn，不得静默',
      )
    }
  })

  // ── "收缩写法"不得成为"另起一行新增技能"的挡箭牌（第四次绕过后的根本约束）──
  //
  // 【为什么这组用例至关重要】
  // "中文字数下降"是**相对配对句**算的，而共享套话（`熟悉…的使用；`）会把编造行
  // 配到一条**更长的中文原句**上，于是"比它短 7 个汉字"被误当成"中文换缩写"：
  // ```
  //   原文：- 熟悉结构化查询语言 的使用；      （汉字 12）
  //   改写：- 熟悉结构化查询语言 的使用；      （原句逐字保留）
  //         - 熟悉 Redis 的使用；              （汉字 5，下降 7 ≥ 阈值 4）
  // ```
  // → 只报 warn → **`exportResume` 导出成功且 `verified=true`**。
  // 真实简历技能区正是这种长中文句，故触发面很广（6 种长句 × 4 技术名全部可绕过）。
  //
  // **根本约束**："收缩"只能解释"原有内容变短了"，
  // **不能解释"原文内容仍原封不动、同时又多出一句"**。
  // 故要求：只有配对原句的中文**没有被其它改写行成段保留**时，
  // 才允许按"收缩"放行。
  test('长中文原句 + 另起一行编造技能，必须拦下（收缩不得成为挡箭牌）', () => {
    for (const zh of [
      '结构化查询语言',
      '超文本传输协议',
      '关系型数据库',
      '容器编排平台',
      '持续集成部署流程',
    ]) {
      for (const tech of ['Redis', 'Kafka', 'Docker', 'Nginx']) {
        const report = verifyRewrite({
          original: `- 熟悉${zh} 的使用；`,
          rewritten: `- 熟悉${zh} 的使用；\n- 熟悉 ${tech} 的使用；`,
        })
        assert.equal(
          report.ok,
          false,
          `原句仍在、另起一行新增 ${tech} 必须是 error（不得因"比原句短"而放行）`,
        )
        assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
      }
    }
  })

  test('真正的收缩写法（中文换缩写）仍须放行', () => {
    // 反向锁定：加了"保留检查"后，真收缩（原句被本行替换掉）必须仍放行。
    for (const [original, rewritten] of [
      ['- 熟悉超文本传输协议，负责接口开发工作；', '- 熟悉 HTTP，负责接口开发工作；'],
      ['- 熟悉结构化查询语言，负责接口开发工作；', '- 熟悉 SQL，负责接口开发工作；'],
      ['- 熟悉云服务平台，负责接口开发工作；', '- 熟悉 AWS，负责接口开发工作；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `真收缩不得阻断交付：${rewritten}`,
      )
    }
  })


  // ── 容量单位大小写（bit vs byte 相差 8 倍）────────────────────────────
  //
  // 【为什么单列（独立审查发现）】单位归一化表用了大小写不敏感的正则，
  // 于是 `2MB`（兆字节）与 `2Mb`（兆比特）被归一为同一数值——但二者相差 **8 倍**。
  // 实测此前 `2MB → 2Mb` 是 `ok=true`、`findings=[]`（**完全静默**），
  // 比 `HTML → 标记语言`（至少 warn）还宽松，标准不一致。
  //
  // 取 warn 而非 error：`KB/kb`、`MB/mb` 混写在简历里很常见、多半同义，
  // 判 error 会误报死锁；但 bit/byte 确实语义不同，必须提示。
  test('短行里的技术名替换也不得静默（< 8 字单元不在逐条比对范围）', () => {
    // 【为什么专门测（本轮自查抓出的残留静默）】
    // "技术名消失"的逐条比对只走**内容单元**（长度 ≥ 8 字），
    // 于是短行里的替换完全无告警：
    //   `- CSS；` → `- 层叠样式表；`   实测 `ok=true`、`findings=[]`
    // `- 熟悉 CSS；` → `- 熟悉层叠样式表；` 同样静默。
    // 而"技能：CSS"这类短行正是简历里最常见的形态。
    // 现已补全文级兜底扫描。
    for (const [original, rewritten] of [
      ['- CSS；', '- 层叠样式表；'],
      ['- 熟悉 CSS；', '- 熟悉层叠样式表；'],
      ['- CSS / HTML；', '- 层叠样式表 / HTML；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.ok(
        report.findings.length > 0,
        `短行技术名替换不得静默：${original} → ${rewritten}`,
      )
    }
  })

  // ── 短行：同一个分支的两侧（最易"修一边漏一边"，本轮最后一次收敛）────
  //
  // 【为什么必须成对测】
  // 内容单元阈值（≥ 8 字）会把短行过滤掉，使 `- 熟悉 SQL；`（6 字）拿不到配对原句。
  // 这个兜底分支两侧都不能一刀切：
  //   · 一律判 error → 短行把中文换成缩写（最核心的 ATS 动作）被拒，
  //     实测 20 个常见术语里 **16 个导不出** = 死锁；
  //   · 一律放行 → 短行里的编造（`- 熟悉 Redis；`）被投递出去 = 严重绕过。
  // 而这两者在**文本上完全相同**（都是 `- 熟悉 X；`），
  // 区别只在**原文侧**：原句是否已被本行替换掉。
  test('短行「中文术语 → 英文缩写」必须放行（20 个常见 ATS 术语）', () => {
    const ATS_PAIRS = [
      ['超文本传输协议', 'HTTP'],
      ['超文本安全传输协议', 'HTTPS'],
      ['统一资源定位符', 'URL'],
      ['安全套接层协议', 'SSL'],
      ['可扩展标记语言', 'XML'],
      ['令牌校验机制', 'JWT'],
      ['接口数据格式', 'JSON'],
      ['配置文件格式', 'YAML'],
      ['持续集成流程', 'CI/CD'],
      ['网络传输协议', 'TCP/IP'],
      ['表征状态转移架构', 'REST'],
      ['结构化查询语言', 'SQL'],
      ['层叠样式表', 'CSS'],
      ['超文本标记语言', 'HTML'],
      ['云服务平台', 'AWS'],
      ['容器编排平台', 'Kubernetes'],
      ['接口设计规范', 'API'],
      ['软件开发工具包', 'SDK'],
      ['用户界面设计', 'UI'],
      ['关键绩效指标', 'KPI'],
    ]
    for (const [zh, en] of ATS_PAIRS) {
      const report = verifyRewrite({
        original: `- 熟悉${zh}；`,
        rewritten: `- 熟悉 ${en}；`,
      })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `短行里把「${zh}」换成「${en}」是 ATS 对齐，不得拒绝导出`,
      )
    }
  })

  test('短行里的凭空新增技能必须拦下（与收缩写法文本相同，靠原文侧区分）', () => {
    for (const tech of ['Redis', 'Kafka', 'Docker', 'Nginx']) {
      // 原句与新增行都保留 → 原文句仍在 → 纯增量
      const report = verifyRewrite({
        original: '- 熟悉 Java 与 MySQL 的使用；',
        rewritten: `- 熟悉 Java 与 MySQL 的使用；\n- 熟悉 ${tech}；`,
      })
      assert.equal(
        report.ok,
        false,
        `原句仍保留时，另起一行新增 ${tech} 必须是 error`,
      )
      // 原文只有一条无关经历 → 更明显的编造
      const report2 = verifyRewrite({
        original: '- 使用 Vuex 管理用户登录态与购物车数据；',
        rewritten: `- 熟悉 ${tech}；\n- 使用 Vuex 管理用户登录态与购物车数据；`,
      })
      assert.equal(report2.ok, false, `无法归属的短行技术名必须是 error：${tech}`)
    }
  })

  test('收缩判定不得被"拉丁词切碎中文"骗过（保留检查须按整行比对）', () => {
    // 【实测陷阱】"原句是否被别处保留"若用"最长连续汉字段"判断，
    // 会被拉丁词骗过：`熟悉 Java 与 MySQL 的使用；` 的连续汉字段只有
    // `熟悉`(2) 与 `的使用`(3)，于是**原句被逐字保留**时最长共享也只有 3，
    // 低于阈值 4 → 保留检查失灵 → 短行编造又被放行。
    // 现按**整行（含拉丁词）**比较（完全相同 / 相似度 ≥ 0.9 / 共享汉字段 ≥ 4）。
    const report = verifyRewrite({
      original: '- 熟悉 Java 与 MySQL 的使用；',
      rewritten: '- 熟悉 Java 与 MySQL 的使用；\n- 熟悉 Redis；',
    })
    assert.equal(report.ok, false, '原句逐字保留时，短行新增 Redis 必须拦下')
  })

  test('容量单位大小写被改动时至少留 warn（bit/byte 相差 8 倍）', () => {
    for (const [original, rewritten] of [
      ['- 包体积 2MB；', '- 包体积 2Mb；'],
      ['- 带宽 2Mb；', '- 带宽 2MB；'],
      ['- 内存 8Gb；', '- 内存 8GB；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.ok(
        report.findings.some((f) => f.code === 'UNIT_CASE_CHANGED'),
        `单位大小写变化必须提示：${original} → ${rewritten}`,
      )
    }
  })

  test('单位归一化不得因大小写检查而放宽真实数值改动', () => {
    for (const [original, rewritten] of [
      ['- 体积 2MB；', '- 体积 4MB；'],
      ['- 体积 2MB；', '- 体积 2000KB；'],
    ]) {
      const report = verifyRewrite({ original, rewritten })
      assert.equal(report.ok, false, `数值真的变了必须拦：${original} → ${rewritten}`)
    }
  })
})

describe('守卫：职责升格必须逐条比对（S2-1）', () => {
  /** 多条经历行，其中同时存在弱动词行与强动词行。 */
  const RESUME = [
    '项目经历：',
    '校园二手交易平台',
    '- 参与登录模块的重构工作；',
    '- 负责商品列表页面的开发；',
    '- 协助完成与后端接口的联调。',
  ].join('\n')

  test('单条「参与 → 负责」必须抓住，不得被其它行的"参与"稀释', () => {
    // 缺陷背景：早期按**全文 min/max** 比对。此处文中另有「协助」(2)，
    // 全文 min 保持 2 不变，于是这条真升格被漏报。
    const rewritten = RESUME.replace('- 参与登录模块的重构工作；', '- 负责登录模块的重构工作；')
    const report = verifyRewrite({ original: RESUME, rewritten })
    assert.equal(report.ok, false, '单条职责升格不得因全文聚合而漏报')
    const finding = report.findings.find((f) => f.code === 'RESPONSIBILITY_INFLATED')
    assert.ok(finding)
    assert.ok(
      finding.message.includes('登录模块'),
      '报文必须定位到具体那一条，而不是只给全文统计',
    )
  })

  test('单条「参与 → 主导」必须抓住', () => {
    const rewritten = RESUME.replace('- 参与登录模块的重构工作；', '- 主导登录模块的重构工作；')
    assert.equal(verifyRewrite({ original: RESUME, rewritten }).ok, false)
  })

  test('同一单元内删掉弱化动词也算升格（协助完成 → 完成）', () => {
    // 这不是"压缩表述"，而是**丢掉了弱化限定**：
    // 「协助完成」的真实强度是"协助"，改成「完成」即把参与程度抬到负责层。
    // 与"删掉一整行弱动词行"不同——后者是精简，前者是抬高。
    // 这条锁定该区分，防止后续为"减少误报"而把它一并放宽。
    const report = verifyRewrite({
      original: '项目经历：\n- 协助完成与后端接口的联调工作。',
      rewritten: '项目经历：\n- 完成与后端接口的联调工作。',
    })
    assert.equal(report.ok, false, '丢掉"协助"这个弱化限定属于升格，必须抓住')
  })

  test('合法压缩：删掉一行弱动词经历不得被误报为升格', () => {
    // 缺陷背景：同一处判据的反方向——删掉弱动词行会抬高**全文** min，
    // 早期实现据此报升格并拒绝导出，报文还自证矛盾
    //（"原文最强为负责层，改写后最强为负责层"）。
    const rewritten = RESUME.replace('- 协助完成与后端接口的联调。\n', '').replace(
      '- 协助完成与后端接口的联调。',
      '',
    )
    const report = verifyRewrite({ original: RESUME, rewritten })
    assert.ok(
      !report.findings.some((f) => f.code === 'RESPONSIBILITY_INFLATED'),
      '删掉弱表述是精简，不是抬高职责，不得误报',
    )
  })

  test('只调整顺序不得被误报为升格', () => {
    const rewritten = [
      '项目经历：',
      '校园二手交易平台',
      '- 协助完成与后端接口的联调。',
      '- 负责商品列表页面的开发；',
      '- 参与登录模块的重构工作；',
    ].join('\n')
    const report = verifyRewrite({ original: RESUME, rewritten })
    assert.ok(
      !report.findings.some((f) => f.code === 'RESPONSIBILITY_INFLATED'),
      '重排经历权重是本插件宣称的能力，不得因重排而报升格',
    )
  })

  test('凭空新增一条含"主导"的经历：升格与新增必须同时报出', () => {
    const rewritten = RESUME + '\n- 主导用户增长策略与社群运营体系搭建。'
    const report = verifyRewrite({ original: RESUME, rewritten })
    const codes = report.findings.map((f) => f.code)
    assert.ok(codes.includes('NOVEL_CONTENT'), '整条新增必须报出')
    assert.ok(
      codes.includes('RESPONSIBILITY_INFLATED'),
      '凭空主张领导职责也必须报出（两个检查互为兜底）',
    )
  })

  test('配对函数对每条改写都给出原文归属', () => {
    const pairs = matchUnitsToOriginal(RESUME, RESUME)
    assert.ok(pairs.length > 0)
    for (const p of pairs) {
      assert.equal(typeof p.rewritten, 'string')
      assert.ok(p.original !== null, '原样文本的每条都应配到原文')
    }
  })
})

describe('守卫：对抗性审查发现的回归（恒等改写 / 误报面 / 配对约束）', () => {
  // ── 最严重：恒等改写不得报任何 error ────────────────────────────────
  //
  // 对抗性审查实测抓出：第一版 `matchUnitsToOriginal` 在"一旦 score ≥ 阈值
  // 就 break"，取到的是**第一个够格的**而非**最相似的**。两条原文同属一个模块、
  // 共享大量 bigram 时（同模块的"参与…"与"负责…"），第二条改写会先撞上第一条
  // （相似度 ~0.58 ≥ 0.25）就停下，被拿去与**错误的那一条**比较，
  // 从而报出跨行的假升格。
  //
  // 后果：`verifyRewrite({original: X, rewritten: X})` → ok=false 并拒绝导出。
  // **没有改写就不可能升格**，所以这类误报是必然发生的，属最坏一类
  //（用户连"原样导出"都做不到），本组用例专门锁定它。
  const IDENTITY_SAMPLES = [
    ['同模块弱强双条', '项目经历：\n- 参与用户登录模块的重构工作；\n- 负责用户登录模块的性能优化工作；'],
    ['三条同主题', '项目经历：\n- 参与登录模块重构的相关工作；\n- 负责登录模块性能优化的工作；\n- 协助登录模块接口联调的工作；'],
    ['实习+项目同主题', '实习经历：\n- 参与订单系统的开发与维护工作；\n- 负责订单系统的性能调优工作；'],
  ]
  for (const [name, text] of IDENTITY_SAMPLES) {
    test(`恒等改写不得误报为升格：${name}`, () => {
      const report = verifyRewrite({ original: text, rewritten: text })
      assert.equal(report.ok, true, '没有任何改写就不可能出现职责升格')
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error'),
        [],
        '恒等改写不得产生任何 error（否则用户无法原样导出）',
      )
    })
  }

  test('配对必须取全局最优，而不是第一个够格的（根因锁定）', () => {
    const original = '- 参与用户登录模块的重构工作；\n- 负责用户登录模块的性能优化工作；'
    const pairs = matchUnitsToOriginal(original, original)
    for (const p of pairs) {
      assert.equal(p.original, p.rewritten, '恒等输入时每条都应精确配到自身')
      assert.equal(p.score, 1, '自身配对的相似度必须是 1')
    }
  })

  test('只扩写一条、动词原样保留 → 不得误报', () => {
    const original = '- 参与用户登录模块的重构工作；\n- 负责用户登录模块的性能优化工作；'
    const rewritten =
      '- 参与用户登录模块的重构工作；\n- 负责用户登录模块的性能优化与监控体系建设工作；'
    assert.equal(verifyRewrite({ original, rewritten }).ok, true)
  })

  test('真升格（跨行合并 参与+负责 → 负责）必须被提示', async () => {
    // 合并条目是常态化写动作。旧实现能报、新实现第一版漏报——
    // 这条锁定"修复误报时不得把真升格一起放掉"。
    //
    // 但注意严重级是 **warn 而非 error**：纯文本无法区分
    // "合并抬高职责"与"合法删掉了一行弱表述"，判 error 会重新制造
    // 投递死锁（正是本轮刚修掉的那类缺陷）。故要求"必须提示、不得阻断"。
    const original = '项目经历：\n- 参与登录模块的重构工作；\n- 负责商品列表的开发工作；'
    const rewritten = '项目经历：\n- 负责登录模块的重构与商品列表的开发工作；'
    const report = verifyRewrite({ original, rewritten })
    const warn = report.findings.find((f) => f.code === 'POSSIBLE_RESPONSIBILITY_INFLATION')
    assert.ok(warn, '合并掩盖的升格必须被提示出来')
    assert.equal(warn.severity, 'warn')
    assert.equal(report.ok, true, 'warn 不得阻断导出（否则合并就会死锁）')
  })

  test('合法删掉一行弱表述不得被报 error（反向代价锁定）', () => {
    // 反向配对会把这个场景也看成"层级上升"，若判 error 就是投递死锁。
    const original = '项目经历：\n- 参与用户登录模块的重构工作；\n- 负责用户登录模块的性能优化工作；'
    const rewritten = '项目经历：\n- 负责用户登录模块的性能优化工作；'
    const report = verifyRewrite({ original, rewritten })
    assert.deepEqual(
      report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
      [],
      '删掉弱表述是合法精简，不得判 error',
    )
  })

  // ── S1-2 误报面：等价术语替换不得阻断导出 ───────────────────────────
  //
  // 对抗性审查实测：`CI/CD`、`TCP/IP`、`RESTful API`、`unit test`、`code review`
  // 等中文术语的英文等价写法被判 FABRICATED_ENTITY（error）并**拒绝导出**，
  // 而这正是 ATS 关键词对齐的核心动作 —— 属投递死锁。
  const TERM_EQUIVALENTS = [
    ['持续集成 → CI/CD', '熟悉持续集成与自动化部署流程，负责接口开发工作。', '熟悉 CI/CD 流程与自动化部署，负责接口开发工作。'],
    ['网络协议 → TCP/IP', '熟悉网络协议与数据传输机制，负责接口开发工作。', '熟悉 TCP/IP 与数据传输机制，负责接口开发工作。'],
    ['接口工具 → RESTful API', '使用接口调试工具完成联调，负责接口开发工作。', '使用 RESTful API 调试工具完成联调，负责接口开发工作。'],
    ['软件物料 → SDK', '完成软件物料接入工作，负责接口开发工作。', '完成 SDK 接入工作，负责接口开发工作。'],
  ]
  for (const [name, original, rewritten] of TERM_EQUIVALENTS) {
    test(`等价术语替换不得判 error（否则用户拿不到文件）：${name}`, () => {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        '中文术语 ↔ 英文缩写的等价性无法由代码判定，不得阻断交付',
      )
    })
  }

  test('歧义标识符降级为 warn（不阻断，但也不静默放行）', () => {
    // 两侧都不能犯：判 error 会死锁，静默放过会留编造盲区。
    const report = verifyRewrite({
      original: '熟悉持续集成流程，负责接口开发工作。',
      rewritten: '熟悉 CI/CD 流程，负责接口开发工作。',
    })
    assert.equal(report.ok, true, 'warn 不得让校验失败')
    const warn = report.findings.find((f) => f.code === 'AMBIGUOUS_NEW_TERM')
    assert.ok(warn, '必须提示，不能静默放行')
    assert.equal(warn.severity, 'warn')
  })

  test('原文已有 D 标记的歧义词不重复提示', () => {
    const report = verifyRewrite({
      original: '熟悉 CI/CD 流程，负责接口开发工作。',
      rewritten: '熟悉 CI/CD 流程，深度参与接口开发工作。',
    })
    assert.ok(!report.findings.some((f) => f.code === 'AMBIGUOUS_NEW_TERM'))
  })

  test('高置信专名仍然是 error（不得因放宽而放掉真编造）', () => {
    // 反向锁定：放宽歧义词不得把"真的编造技术栈"一起放过
    const report = verifyRewrite({
      original: '使用 Vue2 编写主要展示页面和商品列表模块；',
      rewritten: '使用 Vue2 与 Kubernetes 编写主要展示页面和商品列表模块；',
    })
    assert.equal(report.ok, false, '高置信专名编造必须仍判 error')
    assert.ok(report.findings.some((f) => f.code === 'FABRICATED_ENTITY'))
  })

  // ── 计量单位换算（S1-1 同族残留，本轮 sweep 实测抓出）────────────────
  //
  // `2.4s` 与 `2400ms` 是同一时长的两种写法。早期只归一化中文数量级词
  // （亿/万/千），未处理计量单位，于是"秒写成毫秒"被判编造并**拒绝导出**——
  // 与 S1-1 同一类投递死锁，而它同样是模型做可读性对齐时的常规动作。
  test('计量单位换算必须放行（秒 ↔ 毫秒 / 分钟 ↔ 秒 / MB ↔ KB）', () => {
    const allow = [
      ['从 2.4s 缩短至 1.8s', '从 2400ms 缩短至 1800ms'],
      ['耗时 1.5 分钟', '耗时 90 秒'],
      ['体积 2MB', '体积 2048KB'],
      ['耗时 2 小时', '耗时 120 分钟'],
    ]
    for (const [original, rewritten] of allow) {
      const report = verifyRewrite({ original, rewritten })
      assert.deepEqual(
        report.findings.filter((f) => f.severity === 'error').map((f) => f.code),
        [],
        `单位换算不得误判为编造：${original} -> ${rewritten}`,
      )
    }
  })

  test('单位归一化不得放宽判定：数值真的变了照样抓', () => {
    const report = verifyRewrite({
      original: '从 2.4s 缩短至 1.8s',
      rewritten: '从 3.6s 缩短至 1.8s',
    })
    assert.equal(report.ok, false, '单位相同时数值被改必须仍判编造')
    assert.ok(report.findings.some((f) => f.code === 'FABRICATED_NUMBER'))
  })
})

describe('守卫：自证清白判定（S1-3，交付关依赖它）', () => {
  const ORIGINAL = [
    '项目经历：',
    '- 使用 Vue2 编写主要展示页面和商品列表模块；',
    '- 对接后端 REST 接口，完成登录与购物车功能；',
  ].join('\n')
  const WITH_FABRICATION = ORIGINAL.replace(
    '- 对接后端 REST 接口，完成登录与购物车功能；',
    '- 对接后端 REST 接口，完成登录与购物车功能，接口响应时间优化 60%；',
  )

  test('完全相同 → 判为自证清白', () => {
    assert.equal(detectSelfAttestation(ORIGINAL, ORIGINAL).selfAttested, true)
  })

  test('仅空白/换行不同 → 仍判为自证清白', () => {
    assert.equal(detectSelfAttestation(`${ORIGINAL}  `, ORIGINAL).selfAttested, true)
    assert.equal(detectSelfAttestation(ORIGINAL.replace(/\n/g, '\r\n'), ORIGINAL).selfAttested, true)
  })

  test('副本 + 一行装饰性文字 → 命中 contains 档（这是 S1-3 的原始绕过）', () => {
    // 缺陷背景：早期只防"字节相等"，于是加任意一行即可绕过，
    // 编造内容原样落盘，返回值还宣称 verified=true。
    // 注意：contains 档**由调用方降级处理而非硬拒绝**——因为纯文本无法区分
    // "尾部加了装饰"与"删掉了一条经历"，硬拒绝会误伤合法改写（见 export.test.js）。
    const r = detectSelfAttestation(`${WITH_FABRICATION}\n以上为我的原始简历内容`, WITH_FABRICATION)
    assert.equal(r.selfAttested, true, '加一行说明不得被当作有效校验基准')
    assert.equal(r.reason, 'contains')
  })

  test('副本 + 装饰加在前面 → 同样命中 contains 档', () => {
    const r = detectSelfAttestation(`说明：以下是我的简历\n${WITH_FABRICATION}`, WITH_FABRICATION)
    assert.equal(r.selfAttested, true)
    assert.equal(r.reason, 'contains')
  })

  test('删掉一条经历（一字未改）→ 也命中 contains 档（故调用方不得硬拒绝）', () => {
    // 这条用例**证明**该判据无法区分"装饰"与"删除"，因此调用方必须降级而非拒绝。
    // 它是对"为什么不在这里抛错"的记录，不是期望行为。
    const original = '- 负责商品列表页面的开发工作\n- 参与登录模块的重构工作'
    const resume = '- 负责商品列表页面的开发工作'
    assert.equal(detectSelfAttestation(original, resume).reason, 'contains')
  })

  test('真实的"改写前原文"（措辞不同）→ 不得判为自证清白', () => {
    // 反向保障：判据过宽会把正常导出也拦死，制造新的投递死锁（S1-1 同类问题）
    const r = detectSelfAttestation(
      '- 使用 Vue2 完成主要展示页面与商品列表模块的开发；\n- 完成后端 REST 接口对接与购物车功能；',
      ORIGINAL,
    )
    assert.equal(r.selfAttested, false, '正常改写不是自证清白')
  })

  test('英文简历的自证清白判定必须与中文一致（容忍量需按语言缩放）', () => {    // 【实测抓出的不对称】同一句装饰扁平化后长度差很大
    //（中文 12 字 vs 英文 26 字符），而容忍量下限是固定的 20，
    // 于是**中文命中 contains、英文漏掉**：
    //   `original = resume + 一行装饰` 这个 S1-3 原始绕过，
    //   中文能识别、英文返回 false → 调用方把 verified 置 true。
    // 现按语言取不同下限（英文 40）。这条用例锁定两侧一致。
    const enResume = '- Built pages with Vue2;\n- Led user growth strategy doubling MAU;'
    for (const [label, original] of [
      ['装饰在后', `${enResume}\nAbove is my original resume`],
      ['装饰在前', `Note: my resume below\n${enResume}`],
    ]) {
      const r = detectSelfAttestation(original, enResume)
      assert.equal(r.selfAttested, true, `英文「${label}」是自证清白，必须识别`)
      assert.equal(r.reason, 'contains')
    }
    // 反向：英文真实改写不得判为副本
    assert.equal(
      detectSelfAttestation(
        '- Participated in database optimization work;\n- Collaborated with 5 engineers;',
        '- Led database optimization efforts and coordinated a team of five.',
      ).selfAttested,
      false,
      '英文正常改写不是自证清白',
    )
  })

  test('模型精简掉整段经历（原文比结果长得多）→ 不得判为自证清白', () => {
    // 边界：original 逐字包含 resume，但多出的是一整段被删掉的经历，
    // 属合法压缩，不能拦——否则用户又拿不到文件。
    const long = `${ORIGINAL}\n- 使用 Vuex 管理用户登录态与购物车数据；\n- 通过懒加载商品图片与请求合并优化首屏性能。`
    const r = detectSelfAttestation(long, ORIGINAL)
    assert.equal(r.selfAttested, false, '精简掉成段内容是合法改写，不得判为自证清白')
  })

  test('过短的结果不做"包含"判定（避免误报）', () => {
    assert.equal(detectSelfAttestation('很长很长的原文内容在这里', '短文本').selfAttested, false)
  })

  test('空输入不判为自证清白（由调用方按"未提供原文"处理）', () => {
    assert.equal(detectSelfAttestation('', ORIGINAL).selfAttested, false)
    assert.equal(detectSelfAttestation(ORIGINAL, '').selfAttested, false)
  })
})
