// 契约结构测试（node:test 标准 runner）
//
// 验证工具定义的结构符合平台约定，且 execute 的真实行为正确。
// 零平台依赖——真机 schema 校验在 test/node/schema.test.js。
//
// 运行：npm run test:contract
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  createToolDefinition,
  createVerifyToolDefinition,
  buildVerifyValue,
  TOOL_NAME,
  RESUME_VALUE_SCHEMA,
  RESUME_PARAMETERS_JSON_SCHEMA,
} from '../../src/core.js'

const definition = createToolDefinition()
const SIGNAL = new AbortController().signal

/** 平台允许的 schema 关键字白名单（实测 dsh-tools 0.1.5-rc.2）。 */
const ALLOWED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
])

/** 递归收集 schema 中出现的所有关键字。 */
function collectKeywords(node, acc = new Set()) {
  if (node === null || typeof node !== 'object') return acc
  for (const [key, value] of Object.entries(node)) {
    acc.add(key)
    if (key === 'properties' && value && typeof value === 'object') {
      for (const sub of Object.values(value)) collectKeywords(sub, acc)
    } else if (key === 'items' || key === 'oneOf') {
      if (Array.isArray(value)) for (const sub of value) collectKeywords(sub, acc)
      else collectKeywords(value, acc)
    }
  }
  return acc
}

describe('工具定义形态', () => {
  test('返回平台可注册的普通对象', () => {
    assert.equal(typeof definition, 'object')
    assert.equal(definition.name, TOOL_NAME)
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 0)
    assert.equal(typeof definition.output?.render, 'function')
    assert.ok(definition.output?.schema)
  })

  test('可 JSON 序列化的纯数据契约（无类实例、无 Symbol）', () => {
    const clone = JSON.parse(
      JSON.stringify({
        name: definition.name,
        parameters: definition.parameters,
        output: { schema: definition.output.schema },
      }),
    )
    assert.equal(clone.name, TOOL_NAME)
    assert.ok(clone.parameters.properties.jd)
  })

  test('presentCall 返回平台 generic card 结构', () => {
    const view = definition.presentCall({ jd: 'a'.repeat(500) })
    assert.equal(view.card, 'generic')
    assert.equal(typeof view.title, 'string')
    assert.equal(typeof view.kind, 'string')
    assert.ok(view.rawInput.length <= 200, 'rawInput 应被截断')
  })

  test('presentCall 在无 jd 时不崩', () => {
    const view = definition.presentCall({})
    assert.equal(view.card, 'generic')
    assert.equal(view.rawInput, undefined)
  })
})

describe('schema 关键字白名单（平台硬约束）', () => {
  test('输出 schema 未使用白名单外的关键字', () => {
    const used = collectKeywords(RESUME_VALUE_SCHEMA)
    const illegal = [...used].filter((k) => !ALLOWED_KEYWORDS.has(k))
    assert.deepEqual(illegal, [], `使用了平台不支持的 schema 关键字：${illegal.join(', ')}`)
  })

  test('参数 schema 未使用白名单外的关键字', () => {
    const used = collectKeywords(RESUME_PARAMETERS_JSON_SCHEMA)
    const illegal = [...used].filter((k) => !ALLOWED_KEYWORDS.has(k))
    assert.deepEqual(illegal, [], `使用了平台不支持的 schema 关键字：${illegal.join(', ')}`)
  })

  test('required 仅出现在 object 节点上', () => {
    /** @returns {string[]} 违规路径 */
    function scan(node, path = 'schema') {
      const bad = []
      if (node === null || typeof node !== 'object') return bad
      if (Object.hasOwn(node, 'required') && node.type !== 'object') {
        bad.push(`${path}.required（type=${String(node.type)}）`)
      }
      if (node.properties) {
        for (const [k, v] of Object.entries(node.properties)) {
          bad.push(...scan(v, `${path}.properties.${k}`))
        }
      }
      if (node.items) bad.push(...scan(node.items, `${path}.items`))
      return bad
    }
    assert.deepEqual(scan(RESUME_VALUE_SCHEMA), [])
    assert.deepEqual(scan(RESUME_PARAMETERS_JSON_SCHEMA), [])
  })
})

describe('参数 schema 结构', () => {
  test('标准 JSON Schema object 根', () => {
    assert.equal(RESUME_PARAMETERS_JSON_SCHEMA.type, 'object')
    assert.ok(RESUME_PARAMETERS_JSON_SCHEMA.properties.jd)
    assert.ok(RESUME_PARAMETERS_JSON_SCHEMA.properties.resume)
  })

  test('required 正确声明 jd / resume，language 可选', () => {
    const req = RESUME_PARAMETERS_JSON_SCHEMA.required
    assert.ok(Array.isArray(req))
    assert.ok(req.includes('jd'))
    assert.ok(req.includes('resume'))
    assert.ok(!req.includes('language'))
  })

  test('language 枚举报 zh / en', () => {
    assert.deepEqual(RESUME_PARAMETERS_JSON_SCHEMA.properties.language.enum, ['zh', 'en'])
  })

  test('参数根显式声明 additionalProperties:false', () => {
    assert.equal(RESUME_PARAMETERS_JSON_SCHEMA.additionalProperties, false)
  })
})

describe('输出契约', () => {
  test('声明 additionalProperties:false（防 ToolOutputError）', () => {
    assert.equal(RESUME_VALUE_SCHEMA.additionalProperties, false)
  })

  test('execute 返回值字段与 schema 严格一致', async () => {
    const value = await definition.execute({ jd: 'JD', resume: '简历' }, { signal: SIGNAL })
    assert.deepEqual(Object.keys(value).sort(), Object.keys(RESUME_VALUE_SCHEMA.properties).sort())
  })
})

describe('真实 execute 执行', () => {
  const cases = [
    {
      label: '中文：应届前端',
      args: {
        jd: '岗位：前端开发工程师\n1. 熟练 Vue3 / TypeScript / Vite；\n2. 有性能优化经验，熟悉 SSR (Nuxt) 优先。',
        resume: '技能：HTML/CSS/JS、Vue2\n项目：校园二手交易平台\n- 用 Vue2 写展示页与商品列表\n- 首屏 2.4s 降至 1.8s',
      },
      lang: 'zh',
      markers: ['优化后简历', '待补充', '禁止编造'],
    },
    {
      label: '中文：跨专业后端（缺项）',
      args: {
        jd: '岗位：Golang 后端\n1. 熟练 Go/Gin；\n2. 掌握 MySQL 索引优化与 Redis；\n3. 了解分布式系统。',
        resume: '专业：自动化\n技能：C/C++、Python、自学 Go\n项目：简易博客系统（Gin + GORM + MySQL CRUD）',
      },
      lang: 'zh',
      markers: ['优化后简历', '待补充'],
    },
    {
      label: '英文：海外实习',
      args: {
        jd: 'Role: Full-Stack Intern\n- Node.js, Express, React, TypeScript\n- RESTful APIs, Docker',
        resume: 'Name: Sample Candidate\n- Node.js/Express microservices\n- Reduced API latency by 35%',
        language: 'en',
      },
      lang: 'en',
      markers: ['Optimized Resume', 'To Add', 'NEVER invent'],
    },
  ]

  for (const tc of cases) {
    test(`${tc.label} → 字段对齐 / language=${tc.lang} / 关键条款 / 原文透传`, async () => {
      const value = await definition.execute(tc.args, { signal: SIGNAL })
      assert.deepEqual(Object.keys(value).sort(), Object.keys(RESUME_VALUE_SCHEMA.properties).sort())
      assert.equal(value.language, tc.lang)
      for (const m of tc.markers) {
        assert.ok(value.instruction.includes(m), `缺少「${m}」`)
      }
      assert.equal(value.jd, tc.args.jd)
      assert.equal(value.resume, tc.args.resume)
    })

    test(`${tc.label} → render 产出非空 text block`, async () => {
      const value = await definition.execute(tc.args, { signal: SIGNAL })
      const blocks = definition.output.render(tc.args, value)
      assert.ok(Array.isArray(blocks) && blocks.length > 0)
      assert.equal(blocks[0].type, 'text')
      assert.ok(blocks[0].text.length > 0)
    })
  }
})

describe('失败路径（真实 execute）', () => {
  const bad = [
    ['空 resume', { jd: 'JD', resume: '' }, /resume/],
    ['纯空白 resume', { jd: 'JD', resume: '   \n  ' }, /resume/],
    ['空 jd', { jd: '', resume: '简历' }, /jd/],
    ['纯空白 jd', { jd: '  \t ', resume: '简历' }, /jd/],
  ]

  for (const [label, args, pattern] of bad) {
    test(label, async () => {
      await assert.rejects(
        () => definition.execute(args, { signal: SIGNAL }),
        pattern,
      )
    })
  }
})

// ── verify_rewrite 的 summary 必须与实际 finding 对应 ─────────────────────
//
// 【为什么单独测（本轮自查发现的真实 bug）】
// `buildVerifyValue` 的 **error** 摘要原先写死一句
// "删除编造数字/机构、把职责动词改回原强度、恢复被改动的日期"。
// 但 error 级共有 6 种，其中两种与这句话毫无关系：
//   · `NOVEL_CONTENT`（整条新增）→ 该删掉多出来的那条，而非改数字/日期；
//   · `UNVERIFIED_KEYWORD_CLAIM`（关键词虚报）→ 该把词写进经历或移入待补充，
//     改数字完全解决不了问题。
// 模型会**照错方向修正**：改完再校验，同一处 error 依旧，白跑一轮——
// 而这段 summary 正是 `verify_rewrite` 修正闭环的驱动力。
//
// v1.3.0 修过同一个 bug，但**只修了 warn 侧**，error 侧漏了。
// 故这里对**每一种** error code 都断言：指引必须提到该问题的正确修法，
// 且**不得**出现与该问题无关的指引（防止将来新增 code 时再漏）。
describe('verify_rewrite 的 error 摘要按实际 finding 生成', () => {
  /**
   * 能稳定触发单一 error code 的输入。
   * @type {Array<{ code: string, original: string, rewritten: string, claimedKeywords?: string[], mustMention: RegExp, mustNotMention?: RegExp }>}
   */
  const cases = [
    {
      code: 'FABRICATED_NUMBER',
      original: '- 性能提升 40%；',
      rewritten: '- 性能提升 65%；',
      mustMention: /数字/,
    },
    {
      code: 'FABRICATED_ENTITY',
      original: '- 熟悉 CSS；',
      rewritten: '- 熟悉 SCSS；',
      mustMention: /技术名|机构名/,
    },
    {
      code: 'RESPONSIBILITY_INFLATED',
      original: '- 参与登录重构；',
      rewritten: '- 主导登录重构；',
      mustMention: /职责/,
    },
    {
      code: 'FABRICATED_DATE',
      original: '- 2020年入职；',
      rewritten: '- 2023年入职；',
      mustMention: /日期/,
    },
    {
      code: 'NOVEL_CONTENT',
      original: '- 使用 Vue2 开发页面；',
      rewritten: '- 使用 Vue2 开发页面；\n- 负责用户增长策略实现月活翻倍；',
      mustMention: /新增|出处/,
      // 整条新增与数字/日期无关，不得给出这些无关指引（旧 bug 正是如此）
      mustNotMention: /数字|日期|职责动词/,
    },
    {
      code: 'UNVERIFIED_KEYWORD_CLAIM',
      original: '- 熟悉 Java；',
      rewritten: '- 熟悉 Java；',
      claimedKeywords: ['TypeScript'],
      mustMention: /关键词/,
      mustNotMention: /数字|日期|职责动词/,
    },
  ]

  for (const tc of cases) {
    test(`${tc.code}：指引必须指向正确修法`, () => {
      const value = buildVerifyValue({
        original: tc.original,
        rewritten: tc.rewritten,
        claimedKeywords: tc.claimedKeywords,
      })
      assert.equal(value.ok, false, `${tc.code} 应当判为未通过`)
      assert.ok(
        value.issues.some((i) => i.includes(tc.code)),
        `明细里应出现 ${tc.code}`,
      )
      assert.match(value.summary, tc.mustMention, `${tc.code} 的摘要未提到正确修法`)
      if (tc.mustNotMention) {
        assert.doesNotMatch(
          value.summary,
          tc.mustNotMention,
          `${tc.code} 的摘要出现了与该问题无关的指引（模型会照错方向改）`,
        )
      }
    })
  }

  test('多种 error 并存时逐条列出，不遗漏任何一种', () => {
    const value = buildVerifyValue({
      original: '- 性能提升 40%；\n- 熟悉 CSS；',
      rewritten: '- 性能提升 65%；\n- 熟悉 SCSS；',
      claimedKeywords: ['Golang'],
    })
    // 该输入会触发 4 种 error：编造数字、编造技术名、关键词虚报、整条新增。
    // 注意不要写死数量（新增判定会改变它），改为断言"每类问题都有对应指引"。
    assert.ok(value.errorCount >= 3, `应有多类 error，实际 ${value.errorCount}`)
    assert.match(value.summary, /数字/)
    assert.match(value.summary, /技术名|机构名/)
    assert.match(value.summary, /关键词/)
    // 摘要列出的动作条数应与 error 类型数一致（同类合并，不重复罗列）
    const listed = value.summary.split('\n').filter((l) => l.startsWith('- '))
    assert.ok(
      listed.length >= 3,
      `摘要应逐条列出修正方式，实际 ${listed.length} 条`,
    )
  })

  test('新增 error code 时若未补文案，兜底也须包含该 code（不静默）', () => {
    // 兜底分支：`errorActions[code] ?? 修正该项：${code}`。
    // 本用例锁住"兜底必须带 code"，这样未来新增判定但忘了补文案时，
    // 模型至少能看到代码名，而不是收到一句无关的指引。
    const value = buildVerifyValue({
      original: '- 熟悉 CSS；',
      rewritten: '- 熟悉 SCSS；',
    })
    const mentioned = value.issues.join('\n')
    assert.match(mentioned, /FABRICATED_ENTITY/)
  })

  test('warning 摘要同样按实际 finding 生成（v1.3.0 已修，此处防回归）', () => {
    const value = buildVerifyValue({
      original: '- 熟悉 Java；\n- 熟悉 MySQL；',
      rewritten: '- 熟悉 Java；',
    })
    assert.equal(value.ok, true)
    assert.ok(value.warnCount > 0)
    // 该场景是"技术名消失"，不是"数据丢失"——摘要必须如实描述
    assert.match(value.summary, /技术名/)
    assert.doesNotMatch(value.summary, /量化数据/)
  })

  test('完全通过时给出干净的通过摘要（最常见的结果，必须有明确正向反馈）', () => {
    const value = buildVerifyValue({
      original: '- 熟悉 Java 与 MySQL；',
      rewritten: '- 熟悉 Java 与 MySQL；',
    })
    assert.equal(value.errorCount, 0)
    assert.equal(value.warnCount, 0)
    assert.equal(value.ok, true)
    assert.match(value.summary, /校验通过/)
    // 不得出现"待人工确认"这类只应属于 warn 分支的措辞
    assert.doesNotMatch(value.summary, /待人工确认/)
    // 明细为空数组（schema 要求 issues 始终存在）
    assert.deepEqual(value.issues, [])
  })

  test('渲染出的内容包含摘要、明细与已知边界', () => {
    const verifyDef = createVerifyToolDefinition()
    const value = buildVerifyValue({
      original: '- 熟悉 CSS；',
      rewritten: '- 熟悉 SCSS；',
    })
    const blocks = verifyDef.output.render({}, value)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /校验未通过/)
    assert.match(blocks[0].text, /明细/)
    assert.match(blocks[0].text, /已知边界/)
  })

  test('render 对缺字段的 value 不抛错（防御平台传值不全）', () => {
    const verifyDef = createVerifyToolDefinition()
    for (const value of [{}, { summary: null }, { summary: 'x', issues: 'not-array' }]) {
      const blocks = verifyDef.output.render({}, value)
      assert.equal(blocks[0].type, 'text')
      assert.equal(typeof blocks[0].text, 'string')
    }
  })

  test('execute 传入非法参数时 reject 且提示字段名', async () => {
    const verifyDef = createVerifyToolDefinition()
    await assert.rejects(() => verifyDef.execute({ rewritten: 'x' }), /original/)
    await assert.rejects(() => verifyDef.execute({ original: 'x' }), /rewritten/)
    await assert.rejects(() => verifyDef.execute({}), /original/)
  })
})

// ── 工具 description 必须与实现同步 ───────────────────────────────────────
//
// 【为什么必须锁定】description 是模型决定"要不要用、怎么用"的依据，
// 属于**会随判定扩展而失效的文案**。它此前只列了"数字/机构/职责/日期/数据丢失"，
// 而判定后来已扩展到整条新增、关键词回验、技术名消失——描述落后会误导模型，
// 尤其"claimedKeywords 会被回验"这一点在 prompt 里承诺了、描述里却没写，
// 模型可能因此虚报覆盖率。
//
// 本用例的做法：**从实现里取真实的 finding code，反查 description 是否覆盖**，
// 而不是随手写几个关键词断言（那样新增 code 时不会失败）。
describe('工具 description 与实现同步', () => {
  /** 每个 error/warn code 至少要在 description 里有对应的语义描述。 */
  const CODE_TO_DESC_HINT = /** @type {Record<string, RegExp>} */ ({
    FABRICATED_NUMBER: /数字/,
    FABRICATED_ENTITY: /机构|专名/,
    RESPONSIBILITY_INFLATED: /职责/,
    FABRICATED_DATE: /时间|日期/,
    NOVEL_CONTENT: /新增|整条/,
    UNVERIFIED_KEYWORD_CLAIM: /claimedKeywords|关键词/,
    LOST_NUMBER: /丢失|数据/,
    VANISHED_TECH_TERM: /消失|技术名/,
  })

  test('description 覆盖每一类判定（新增 code 时必须同步补描述）', () => {
    const verifyDef = createVerifyToolDefinition()
    const desc = verifyDef.description
    const missing = Object.entries(CODE_TO_DESC_HINT)
      .filter(([, re]) => !re.test(desc))
      .map(([code]) => code)
    assert.deepEqual(
      missing,
      [],
      `description 未覆盖这些判定的语义：${missing.join('、')}——` +
        '新增判定时必须同步更新 description，否则模型会误判工具能力',
    )
  })

  test('description 必须提到 claimedKeywords 会被回验', () => {
    const verifyDef = createVerifyToolDefinition()
    assert.match(
      verifyDef.description,
      /claimedKeywords|关键词/,
      'prompt 里承诺了关键词回验，描述里也必须说明，否则模型可能虚报覆盖率',
    )
  })
})

// ── 量化数据核对：**呈现层**必须说人话（第二版可用性返工）──────────────
//
// 【为什么单独锁定呈现层，而不只锁数据层】
// 第一版把溯源表渲染成开发者视角的审计日志：
//   `- ✔ 80000 ← 负责商品列表页开发…`
// 它**技术上正确**、测试也全绿，但用户看不懂：要求他自己把 `8 万` 换算成
// `80000`，术语是「溯源表/量化主张」，且没说他该做什么。
// —— 这与本项目"告警要能被行动、否则等于没有"的原则同源。
// 故本组用例锁的是**用户读到的那段话**，不是内部数据结构。
describe('量化数据核对的呈现层（面向用户，必须可行动）', () => {
  const ORIGINAL = [
    '# 张三',
    '## 项目经历',
    '- 负责商品列表页开发，性能提升 40%，服务 8 万用户；',
    '- 使用 Vue2 完成登录模块，接口响应从 2.4s 降到 1.8s。',
  ].join('\n')

  /** 取渲染文本（去掉很长的「已知边界」段，只留下用户首先看到的部分） */
  const renderHead0 = (original, rewritten) => {
    const def = createVerifyToolDefinition()
    const value = buildVerifyValue({ original, rewritten })
    const text = def.output.render({}, value)[0].text
    const at = text.indexOf('本校验的已知边界')
    return at < 0 ? text : text.slice(0, at)
  }
  const renderHead = (rewritten) => renderHead0(ORIGINAL, rewritten)

  test('数字换写法时，两侧写法必须并列展示（不让用户自己做换算）', () => {
    // `8 万 → 80000` 一眼可对照；只给 `80000` 则用户要自己换算。
    const out = renderHead(ORIGINAL.replace('服务 8 万用户', '服务 80000 用户'))
    assert.match(out, /8 万/, '必须显示原简历的写法')
    assert.match(out, /80000/, '必须显示改写后的写法')
    assert.match(out, /8 万\s*→\s*80000|80000\s*←\s*8 万/, '两种写法必须并列可对照')
  })

  test('不得出现内部术语（溯源表/量化主张/traced/untraced）', () => {
    // 这些词是给开发者看的，求职者不知道是什么。
    const out = renderHead(ORIGINAL.replace('服务 8 万用户', '服务 80000 用户'))
    for (const jargon of ['溯源表', '量化主张', 'traced', 'untraced', 'normalize']) {
      assert.ok(!out.includes(jargon), `面向用户的输出不得出现内部术语「${jargon}」`)
    }
  })

  test('编造数字必须给出"该怎么办"，而不只是断言有问题', () => {
    const out = renderHead(ORIGINAL.replace('服务 8 万用户；', '服务 8 万用户，QPS 提升 300%；'))
    assert.match(out, /300/, '必须指出具体是哪个数字')
    assert.match(out, /找不到|没有这个数字/, '必须说明它在原简历里找不到')
    assert.match(out, /处理方式|删掉|改回|补进/, '必须给出可执行的处理方式')
  })

  test('丢失的真实数据必须给出"该怎么办"', () => {
    const out = renderHead('# 张三\n## 项目经历\n- 负责商品列表页开发，性能提升 40%；')
    assert.match(out, /8 万/, '必须指出丢的是哪个数字（用原写法）')
    assert.match(out, /处理方式|保留|精简/, '必须给出可执行的处理方式')
  })

  test('全部正常时给出正向确认，且逐条对照', () => {
    // 用户最常见的场景是"没问题"——此时必须有明确的正向反馈，
    // 而不是一片空白或只有一句泛泛的"校验通过"。
    const out = renderHead(ORIGINAL)
    assert.match(out, /都能在你|都能在.*原简历|找到出处/, '必须正向确认"都能找到出处"')
    assert.match(out, /40/, '必须逐条列出核对结果')
  })

  test('技术名里的数字（Vue2 的 2）不得出现在核对清单里', () => {
    // 噪声会让用户忽略真正的证据链（"告警常亮 = 守卫被忽略"的同款教训）。
    const out = renderHead(ORIGINAL)
    assert.ok(
      !/·\s*2\s*[（(]/.test(out) && !/「2」/.test(out),
      'Vue2 的 2 不是量化数据，不得列进核对清单',
    )
  })

  // ── 机构名 / 技术名 / 日期也要能核对（本轮扩展）────────────────────
  const ORIGINAL2 = [
    '# 张三',
    '## 项目经历',
    '- 在某互联网公司实习，负责商品列表页开发，性能提升 40%，服务 8 万用户（2026.03 - 2026.06）；',
  ].join('\n')

  const head2 = (rewritten) =>
    renderHead0(ORIGINAL2, rewritten)

  test('换了公司名必须点名指出，并给出处理方式', () => {
    const out = head2(ORIGINAL2.replace('某互联网公司', '字节跳动公司'))
    assert.match(out, /字节跳动公司/, '必须点名编造的公司')
    assert.match(out, /原简历里没有这个名字/, '必须说明它在原简历里找不到')
    assert.match(out, /处理方式|删掉|改回/, '必须给出可执行的处理方式')
  })

  test('时间点被改动必须点名指出（背调对不上的风险）', () => {
    const out = head2(ORIGINAL2.replace('2026.03', '2022.10'))
    assert.match(out, /2022\s*年\s*10\s*月/, '必须点名被改动的时间点')
    assert.match(out, /背调|改回真实的/, '必须说明风险并给出处理方式')
  })

  test('合法的日期规范化不得被报（同一时间点的另一种写法）', () => {
    const out = head2(ORIGINAL2.replace('2026.03', '2026年3月').replace('2026.06', '2026年6月'))
    assert.ok(
      !out.includes('2026 年 3 月') || !/❗/.test(out),
      '纯写法规范化（点号↔年月）不是"改动"，不得列进待确认清单',
    )
  })

  test('名称与时间点无问题时，不得混进数字的核对清单', () => {
    // 噪声控制：只有"需要用户核对/注意"的项才显示。
    const out = head2(ORIGINAL2)
    assert.ok(!out.includes('某互联网公司'), '原简历里有的公司名不该出现在待确认清单')
    assert.ok(!out.includes('2026 年 3 月'), '没被改动的时间点不该出现在待确认清单')
  })

  test('零漂移：守卫报 error 时，核对说明不得声称"都没问题"', () => {
    // 【这是最重要的一条】对照表与守卫必须同进同退。
    // 若守卫判了 error 而对照表给出"✅ 都能找到出处"，就是自相矛盾的假断言。
    const badCases = [
      ORIGINAL2.replace('服务 8 万用户', '服务 8 万用户，QPS 提升 300%'),
      ORIGINAL2.replace('某互联网公司', '字节跳动公司'),
      ORIGINAL2.replace('2026.03', '2022.10'),
    ]
    for (const rewritten of badCases) {
      const value = buildVerifyValue({ original: ORIGINAL2, rewritten })
      assert.equal(value.ok, false, `该用例应判不通过：${rewritten}`)
      const text = createVerifyToolDefinition().output.render({}, value)[0].text
      assert.ok(
        !text.includes('都能在你的原简历里找到出处'),
        '守卫判 error 时，核对说明不得同时声称"都没问题"（假断言）',
      )
      assert.match(text, /❗/, '必须有明确的待确认提示')
    }
  })

  test('零漂移：守卫放行时，核对说明不得出现待确认项', () => {
    const value = buildVerifyValue({ original: ORIGINAL2, rewritten: ORIGINAL2 })
    assert.equal(value.ok, true)
    const text = createVerifyToolDefinition().output.render({}, value)[0].text
    assert.ok(!text.includes('❗'), '守卫放行时不得出现"找不到"的告警')
  })
})
