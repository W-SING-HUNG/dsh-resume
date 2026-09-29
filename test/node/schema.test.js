// 真机 schema 校验（node:test 标准 runner）
//
// 调用**平台自身的断言函数**验证我们的 schema，而不是自己写"看起来对"的断言。
// 这是本项目最有价值的一层测试：真机曾因 schema 写法错误而加载失败。
//
// 平台包位置探测：DSH_TOOLS_URL 环境变量 → 本机 DSH 安装目录 → 本地 node_modules。
// 全部找不到时优雅跳过（纯离线环境可接受）。
//
// 运行：npm run test:schema
import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { RESUME_VALUE_SCHEMA, RESUME_PARAMETERS_JSON_SCHEMA } from '../../src/core.js'

/** 候选平台包入口，按可能性排序。 */
function candidateSpecifiers() {
  const list = []
  if (process.env.DSH_TOOLS_URL) list.push(process.env.DSH_TOOLS_URL)

  const hostRoots = [
    process.env.DSH_INSTALL_ROOT,
    'D:/Tools/dsh-app',
    process.env.APPDATA ? join(process.env.APPDATA, 'npm/node_modules/dsh') : undefined,
  ].filter(Boolean)

  for (const root of hostRoots) {
    const entry = join(root, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js')
    if (existsSync(entry)) list.push(pathToFileURL(entry).href)
  }

  list.push('@deepseek-ai/dsh-tools')
  return list
}

let platform = null
let resolvedFrom = null
const resolveErrors = []

for (const spec of candidateSpecifiers()) {
  try {
    platform = await import(spec)
    resolvedFrom = spec
    break
  } catch (error) {
    resolveErrors.push(`${spec}: ${error.code ?? error.message}`)
  }
}

if (platform === null) {
  describe('真机 schema 校验（已跳过）', () => {
    test('未找到平台包，跳过但不算失败', () => {
      console.log('⚠️  未解析到 @deepseek-ai/dsh-tools，跳过真机 schema 校验。')
      for (const e of resolveErrors) console.log(`   - ${e}`)
      console.log('   提示：设置 DSH_TOOLS_URL 指向 dsh-tools 的 lib/index.js')
      assert.ok(true)
    })
  })
} else {
  describe(`真机 schema 校验（平台断言函数，来源 ${resolvedFrom}）`, () => {
    const { assertSupportedJsonSchema, assertObjectJsonSchema } = platform

    test('输出 schema 通过 assertSupportedJsonSchema', () => {
      assert.doesNotThrow(() => assertSupportedJsonSchema(RESUME_VALUE_SCHEMA))
    })

    test('输出 schema 通过 assertObjectJsonSchema（object 根）', () => {
      assert.doesNotThrow(() => assertObjectJsonSchema(RESUME_VALUE_SCHEMA))
    })

    test('参数 schema 通过 assertSupportedJsonSchema', () => {
      assert.doesNotThrow(() => assertSupportedJsonSchema(RESUME_PARAMETERS_JSON_SCHEMA))
    })

    test('参数 schema 通过 assertObjectJsonSchema（object 根）', () => {
      assert.doesNotThrow(() => assertObjectJsonSchema(RESUME_PARAMETERS_JSON_SCHEMA))
    })

    // ---- 反向验证：确认校验器不是摆设 ----
    test('反向：property 内 required:true 会被平台拒绝（历史缺陷）', () => {
      const bad = {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      }
      assert.throws(
        () => assertSupportedJsonSchema(bad),
        /required is not supported on type "string"/,
      )
    })

    test('反向：缺少 type 的 schema 会被拒绝', () => {
      assert.throws(() => assertSupportedJsonSchema({ properties: {} }))
    })

    test('反向：不在白名单的关键字会被拒绝', () => {
      const bad = {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', minLength: 3 } },
      }
      assert.throws(() => assertSupportedJsonSchema(bad))
    })
  })
}
