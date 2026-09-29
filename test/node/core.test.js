// 核心业务逻辑与反虚构铁律测试（node:test 标准 runner）
//
// 直接测试 src/core.js —— 真实生产代码，不是仿制品。
// 零外部依赖：任何装有 Node 20+ 的机器都能跑。
//
// 运行：npm test
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { RESUME_SYSTEM_PROMPT, PROMPT_VERSION, SUPPORTED_LANGUAGES } from '../../src/prompt.js'
import {
  buildResumeValue,
  normalizeLanguage,
  declaredValueKeys,
  RESUME_VALUE_SCHEMA,
  RESUME_PARAMETERS,
  RESUME_PARAMETERS_JSON_SCHEMA,
  TOOL_NAME,
} from '../../src/core.js'

// ═══════════════════════════════════════════════════════════════════
// 反虚构铁律：本插件的核心资产，不可削弱
// ═══════════════════════════════════════════════════════════════════

describe('反虚构铁律（核心资产）', () => {
  test('中文提示词含禁止编造铁律', () => {
    assert.ok(RESUME_SYSTEM_PROMPT('zh').includes('禁止编造'))
  })

  test('中文提示词要求保留原始量化数据且不得夸大', () => {
    const p = RESUME_SYSTEM_PROMPT('zh')
    assert.ok(p.includes('量化'), '必须提及量化数据')
    assert.ok(p.includes('不得夸大'), '必须写明不得夸大')
  })

  test('中文提示词含待补充清单机制', () => {
    assert.ok(RESUME_SYSTEM_PROMPT('zh').includes('待补充'))
  })

  test('中文提示词含 ATS 关键词对齐策略', () => {
    assert.ok(RESUME_SYSTEM_PROMPT('zh').includes('ATS'))
  })

  test('英文提示词含 NEVER invent 铁律', () => {
    assert.ok(RESUME_SYSTEM_PROMPT('en').includes('NEVER invent'))
  })

  test('英文提示词含 To Add 缺项清单', () => {
    assert.ok(RESUME_SYSTEM_PROMPT('en').includes('To Add'))
  })

  test('未知语言参数回退为中文（默认值语义）', () => {
    assert.equal(RESUME_SYSTEM_PROMPT('fr'), RESUME_SYSTEM_PROMPT('zh'))
  })

  test('prompt 版本号存在且为语义化版本', () => {
    assert.match(PROMPT_VERSION, /^\d+\.\d+\.\d+$/)
  })
})

describe('语言规范化', () => {
  test('仅 en 走英文，其余一律 zh', () => {
    assert.equal(normalizeLanguage('en'), 'en')
    assert.equal(normalizeLanguage('zh'), 'zh')
    assert.equal(normalizeLanguage(undefined), 'zh')
    assert.equal(normalizeLanguage('EN'), 'zh')
    assert.equal(normalizeLanguage(123), 'zh')
    assert.equal(normalizeLanguage(null), 'zh')
  })

  test('SUPPORTED_LANGUAGES 与工具参数 enum 一致', () => {
    assert.deepEqual([...SUPPORTED_LANGUAGES], RESUME_PARAMETERS.language.enum)
  })
})

// ═══════════════════════════════════════════════════════════════════
// 输出契约：防 ToolOutputError
// ═══════════════════════════════════════════════════════════════════

describe('输出契约一致性', () => {
  test('additionalProperties:false —— 平台会拒绝多余字段', () => {
    assert.equal(RESUME_VALUE_SCHEMA.additionalProperties, false)
  })

  test('buildResumeValue 字段与 schema 严格一一对应', () => {
    const value = buildResumeValue({ jd: 'JD', resume: '简历' })
    assert.deepEqual(Object.keys(value).sort(), declaredValueKeys())
  })

  test('所有 canonical 字段均为字符串', () => {
    const value = buildResumeValue({ jd: 'JD', resume: '简历' })
    for (const key of declaredValueKeys()) {
      assert.equal(typeof value[key], 'string', `${key} 必须是 string`)
    }
  })

  test('required 数组覆盖全部声明字段（防漏字段）', () => {
    assert.deepEqual(
      [...RESUME_VALUE_SCHEMA.required].sort(),
      declaredValueKeys(),
    )
  })

  test('工具名常量稳定（改动即破坏用户既有提示词）', () => {
    assert.equal(TOOL_NAME, 'rewrite_resume')
  })
})

describe('参数契约', () => {
  test('jd / resume 必填，language 可选枚举', () => {
    assert.equal(RESUME_PARAMETERS.jd.required, true)
    assert.equal(RESUME_PARAMETERS.resume.required, true)
    assert.deepEqual(RESUME_PARAMETERS.language.enum, ['zh', 'en'])
    assert.equal(RESUME_PARAMETERS.language.required, undefined, 'language 必须可选')
  })

  test('裸 JSON Schema 的 required 是根级数组（平台硬要求）', () => {
    assert.deepEqual(RESUME_PARAMETERS_JSON_SCHEMA.required, ['jd', 'resume'])
  })

  test('裸 JSON Schema 的 property 内不含 required 键（那是 defineTool DSL，平台会拒绝）', () => {
    for (const [name, prop] of Object.entries(RESUME_PARAMETERS_JSON_SCHEMA.properties)) {
      assert.equal(
        Object.hasOwn(prop, 'required'),
        false,
        `property "${name}" 内不得出现 required`,
      )
    }
  })
})

// ═══════════════════════════════════════════════════════════════════
// 三组真实求职场景
// ═══════════════════════════════════════════════════════════════════

const SCENARIOS = [
  {
    label: '应届前端开发（技术对齐 + 缺项识别）',
    args: {
      jd: '岗位：前端开发工程师（校招/实习）\n职责：\n1. 负责核心 Web 产品业务组件开发与性能优化；\n2. 熟练掌握 Vue3 / TypeScript / Vite；\n3. 有大型项目性能优化经验者、熟悉 SSR (Nuxt) 优先。',
      resume: '姓名：示例候选人\n学校：某大学 计算机相关专业 (本科在读)\n技能：HTML, CSS, JavaScript, Vue2, React 基础\n项目经历：\n- 校园二手交易平台（前端负责人）\n  - 使用 Vue2 编写主要展示页面和商品列表；\n  - 对接后端接口，完成了登录与购物车功能；\n  - 页面首屏加载时间从 2.4s 缩短至 1.8s。',
    },
    lang: 'zh',
    markers: ['禁止编造', '待补充', 'ATS'],
    mustPreserve: ['2.4s', '1.8s'],
  },
  {
    label: '跨专业转型后端（项目单薄，严防编造）',
    args: {
      jd: '岗位：Golang 后端开发\n要求：\n1. 具备扎实数据结构基础，熟练使用 Go/Gin 进行 Web 开发；\n2. 熟练掌握 MySQL 索引优化与 Redis 缓存设计；\n3. 了解分布式系统与高并发架构。',
      resume: '姓名：示例候选人 A\n专业：自动化专业 (应届)\n技能：C/C++, Python 脚本, 自学 Go 语法与 Gin\n项目：\n- 简易博客系统 (个人练习)\n  - 用 Gin 写了增删改查接口；\n  - 用 GORM 连 MySQL 存储文章。',
    },
    lang: 'zh',
    markers: ['禁止编造', '待补充'],
    mustPreserve: ['Gin', 'GORM'],
  },
  {
    label: '海外全栈实习（英文输出 + 量化保留）',
    args: {
      jd: 'Role: Full-Stack Software Engineer Intern\nRequirements:\n- Strong Node.js, Express, React, TypeScript skills.\n- Experience with RESTful APIs, Docker containerization.\n- Excellent communication skills.',
      resume: 'Name: Sample Candidate\nEducation: B.S. in Software Engineering (Junior)\nExperience:\n- E-commerce Platform Project\n  - Implemented Node.js / Express backend microservices.\n  - Reduced API response latency by 35%.\n  - Configured local environment.',
      language: 'en',
    },
    lang: 'en',
    markers: ['NEVER invent', 'To Add'],
    mustPreserve: ['35%'],
  },
]

describe('三组真实求职场景', () => {
  for (const sc of SCENARIOS) {
    describe(sc.label, () => {
      test('字段严格对齐 schema', () => {
        const value = buildResumeValue(sc.args)
        assert.deepEqual(Object.keys(value).sort(), declaredValueKeys())
      })

      test(`language 解析为 ${sc.lang}`, () => {
        assert.equal(buildResumeValue(sc.args).language, sc.lang)
      })

      test('指令集含关键条款', () => {
        const { instruction } = buildResumeValue(sc.args)
        for (const m of sc.markers) {
          assert.ok(instruction.includes(m), `instruction 缺少「${m}」`)
        }
      })

      test('jd 原文透传未篡改', () => {
        assert.equal(buildResumeValue(sc.args).jd, sc.args.jd)
      })

      test('resume 原文透传，量化数据不得被改写', () => {
        const { resume } = buildResumeValue(sc.args)
        assert.equal(resume, sc.args.resume)
        for (const token of sc.mustPreserve) {
          assert.ok(resume.includes(token), `简历原文必须保留「${token}」`)
        }
      })

      test('note 明示三段式交付', () => {
        const { note } = buildResumeValue(sc.args)
        assert.ok(note.includes('优化后简历') || note.includes('instruction'))
      })
    })
  }
})

// ═══════════════════════════════════════════════════════════════════
// 失败路径
// ═══════════════════════════════════════════════════════════════════

describe('非法输入必须显式抛错', () => {
  const cases = [
    ['缺 jd', { resume: '简历' }, /jd/],
    ['空字符串 jd', { jd: '', resume: '简历' }, /jd/],
    ['纯空白 jd', { jd: '  \t\n ', resume: '简历' }, /jd/],
    ['缺 resume', { jd: 'JD' }, /resume/],
    ['空字符串 resume', { jd: 'JD', resume: '' }, /resume/],
    ['纯空白 resume', { jd: 'JD', resume: '   \n  ' }, /resume/],
    ['完全空参数', {}, /jd/],
    ['非字符串 jd', { jd: 123, resume: '简历' }, /jd/],
    ['非字符串 resume', { jd: 'JD', resume: ['a'] }, /resume/],
    ['null jd', { jd: null, resume: '简历' }, /jd/],
  ]

  for (const [label, args, pattern] of cases) {
    test(label, () => {
      assert.throws(() => buildResumeValue(args), pattern)
    })
  }

  test('undefined 入参不崩溃，按缺字段处理', () => {
    assert.throws(() => buildResumeValue(undefined), /jd/)
  })

  test('无参调用不崩溃', () => {
    assert.throws(() => buildResumeValue(), /jd/)
  })
})
