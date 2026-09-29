// 插件装配路径测试（node:test 标准 runner）
//
// 用 spy ctx 真实调用 apply()，验证它确实按平台契约完成了注册。
// 不依赖宿主 GUI，但完整走 apply() 的真实代码路径。
//
// 运行：npm run test:plugin
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  apply,
  name,
  inject,
  TOOL_NAME,
  SECTION_NAME,
  sectionText,
} from '../../src/index.js'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../src')

/** 构造记录型 ctx：只实现插件真正会触碰的接口。 */
function createSpyCtx({ withGetSectionOrder = true } = {}) {
  const calls = { sections: [], tools: [] }
  const ctx = {
    systemPrompt: {
      ...(withGetSectionOrder
        ? {
            getSectionOrder(sectionName) {
              assert.equal(typeof sectionName, 'string')
              return 2900 // SECTION_ORDERS.TOOL_REPORT
            },
          }
        : {}),
      section(section) {
        calls.sections.push(section)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        calls.tools.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, calls }
}

/** 去掉注释行，避免把注释里的示例代码误判为真实 import。 */
function codeLines(src) {
  return src
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
}

describe('架构硬约束', () => {
  test('源码不 import 任何 @deepseek-ai 平台包（避免模块双实例）', () => {
    for (const file of ['index.js', 'core.js', 'prompt.js']) {
      const src = readFileSync(join(SRC_DIR, file), 'utf8')
      const offenders = codeLines(src).filter((line) =>
        /^\s*(import|export)\b[^;]*from\s+['"]@deepseek-ai/.test(line),
      )
      assert.deepEqual(offenders, [], `${file} 不得 import 平台包，实际：${offenders.join(' | ')}`)
    }
  })

  test('源码只 import Node 内置模块与相对路径', () => {
    for (const file of ['index.js', 'core.js', 'prompt.js']) {
      const src = codeLines(readFileSync(join(SRC_DIR, file), 'utf8')).join('\n')
      const specifiers = [...src.matchAll(/(?:^|\s)from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
      for (const spec of specifiers) {
        const ok = spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('node:')
        assert.ok(ok, `${file} 出现非内置、非相对的外部依赖：${spec}`)
      }
    }
  })
})

describe('插件导出契约', () => {
  test('name / inject / apply 齐备且类型正确', () => {
    assert.equal(typeof name, 'string')
    assert.ok(name.length > 0)
    assert.ok(Array.isArray(inject))
    assert.ok(inject.includes('tools'))
    assert.ok(inject.includes('systemPrompt'))
    assert.equal(typeof apply, 'function')
  })

  test('name 符合包名规范（小写 + 连字符）', () => {
    assert.match(name, /^[a-z][a-z0-9-]*$/)
  })
})

describe('apply(ctx) 装载路径', () => {
  test('不抛错且完成注册', () => {
    const { ctx } = createSpyCtx()
    const result = apply(ctx)
    assert.ok(result === undefined || typeof result === 'function')
  })

  test('恰好注册 1 个系统提示词 section', () => {
    const { ctx, calls } = createSpyCtx()
    apply(ctx)
    assert.equal(calls.sections.length, 1)
  })

  test('section 结构符合约定（name/order/text）', () => {
    const { ctx, calls } = createSpyCtx()
    apply(ctx)
    const section = calls.sections[0]
    assert.equal(section.name, SECTION_NAME)
    assert.equal(typeof section.order, 'number')
    assert.equal(section.order, 2900, 'order 应取自 getSectionOrder(TOOL_REPORT)')
    assert.ok(typeof section.text === 'string' || typeof section.text === 'function')
  })

  test('section.text 含工具名与反虚构铁律', () => {
    const { ctx, calls } = createSpyCtx()
    apply(ctx)
    const section = calls.sections[0]
    const text = typeof section.text === 'function' ? section.text() : section.text
    assert.equal(text, sectionText())
    assert.ok(text.includes(TOOL_NAME))
    assert.ok(text.includes('禁止编造'))
    assert.ok(text.includes('待补充清单'))
  })

  test('平台缺 getSectionOrder 时降级不崩', () => {
    const { ctx, calls } = createSpyCtx({ withGetSectionOrder: false })
    apply(ctx)
    assert.equal(calls.sections.length, 1)
    assert.equal(calls.sections[0].order, 2900)
  })

  test('恰好注册 1 个工具，名称与常量一致', () => {
    const { ctx, calls } = createSpyCtx()
    apply(ctx)
    assert.equal(calls.tools.length, 1)
    assert.equal(calls.tools[0].name, TOOL_NAME)
  })

  test('注册的工具带完整执行契约', () => {
    const { ctx, calls } = createSpyCtx()
    apply(ctx)
    const tool = calls.tools[0]
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output?.render, 'function')
    assert.ok(tool.output?.schema)
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 0)
  })

  test('注册的工具是纯对象字面量（平台自行校验，不需 defineTool）', () => {
    const { ctx, calls } = createSpyCtx()
    apply(ctx)
    assert.equal(Object.getPrototypeOf(calls.tools[0]), Object.prototype)
  })

  test('apply 与测试使用同一份定义来源（无重复实现）', async () => {
    const { ctx, calls } = createSpyCtx()
    apply(ctx)
    const { createToolDefinition } = await import('../../src/core.js')
    const fromCore = createToolDefinition()
    assert.equal(calls.tools[0].name, fromCore.name)
    assert.equal(calls.tools[0].description, fromCore.description)
    assert.deepEqual(calls.tools[0].parameters, fromCore.parameters)
  })

  test('可重复装载，不共享可变状态', () => {
    const a = createSpyCtx()
    const b = createSpyCtx()
    apply(a.ctx)
    apply(b.ctx)
    assert.equal(a.calls.tools.length, 1)
    assert.equal(b.calls.tools.length, 1)
    assert.notEqual(a.calls.tools[0], b.calls.tools[0])
    assert.equal(a.calls.tools[0].name, b.calls.tools[0].name)
  })
})
