#!/usr/bin/env node
// 测试运行器 —— 跨 Node 版本与跨 shell 的自举入口
//
// 为什么需要这个文件（实测得出的结论，2026-09-28）：
//
//   node --test 的文件选择行为在不同 Node 版本间不一致：
//     - Node 20：不展开 glob，`--test "test/node/*.test.js"` 会报
//                "Could not find ...*.test.js"（被当成字面文件名）
//     - Node 24：不把目录路径当扫描目标，`--test test/node/` 会报
//                "Cannot find module .../test/node"
//   而裸 glob（无引号）依赖 shell 展开，Windows cmd 下不展开、POSIX sh 下展开，
//   行为又不一致。
//
//   结论：任何"把路径交给 node --test 去猜"的写法都至少在一个目标环境上会挂。
//   因此本脚本自己用 fs 列出测试文件，再以显式文件列表启动 node:test —
//   不依赖 shell 展开，也不依赖 Node 的路径推断。
//
// 用法：npm test / npm run test:coverage

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_DIR = join(ROOT, 'test', 'node')
const WITH_COVERAGE = process.argv.includes('--coverage')

/** 以确定性顺序收集测试文件。 */
function collectTestFiles() {
  return readdirSync(TEST_DIR)
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => join(TEST_DIR, name))
}

/**
 * 探测当前 Node 是否支持某个 CLI 标志。
 *
 * 存在理由（CI 实测）：`--test-coverage-include` 在 Node 20 上不存在，
 * 直接传入会让 node 以 exit 9 退出（bad option）。本地 Node 24 测不出这个问题。
 * @param {string} flag 待探测的标志
 * @returns {boolean} 是否支持
 */
function supportsFlag(flag) {
  const probe = spawnSync(process.execPath, [flag, '--version'], { encoding: 'utf8' })
  // 不支持的标志会产生非零退出且 stderr 含 "bad option"
  return !(probe.stderr ?? '').includes('bad option')
}

const files = collectTestFiles()
if (files.length === 0) {
  console.error(`❌ 在 ${TEST_DIR} 未找到任何 *.test.js`)
  process.exit(1)
}

const nodeArgs = ['--test']
if (WITH_COVERAGE) {
  nodeArgs.push('--experimental-test-coverage')
  // 覆盖率范围过滤是可选增强：老版本不支持时降级为"不限定范围"，
  // 而不是让整个流程失败。
  if (supportsFlag('--test-coverage-include')) {
    nodeArgs.push('--test-coverage-include=src/**/*.js')
  } else {
    console.log('提示：当前 Node 不支持 --test-coverage-include，覆盖率将覆盖全部已加载文件。')
  }
}
nodeArgs.push(...files)

console.log(`运行 ${files.length} 个测试文件（Node ${process.version}）`)
for (const f of files) console.log(`  ${f.slice(ROOT.length + 1).replace(/\\/g, '/')}`)
console.log('')

const result = spawnSync(process.execPath, nodeArgs, {
  stdio: 'inherit',
  cwd: ROOT,
})

process.exit(result.status ?? 1)
