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
        resume: 'Name: Alex Chen\n- Node.js/Express microservices\n- Reduced API latency by 35%',
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
