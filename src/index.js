// dsh-resume — 求职简历工坊（DSH Host bundle 插件入口）
//
// 【关键设计：零平台依赖】
// 本文件**不 import 任何 @deepseek-ai/* 包**，全部只 import Node 内置模块与相对路径。
//
// 为什么（2026-09-28 真机验证得出的硬结论）：
//   插件代码若 `import { defineTool } from '@deepseek-ai/dsh-tools'`，会从插件自身位置
//   解析到一份**独立的 dsh-tools 副本**。而宿主运行时（dsh-app）用的是另一份。
//   两份模块里 `TOOL_RUNTIME_SCHEDULER` 是不同的 Symbol，于是宿主执行工具时
//   `registry[TOOL_RUNTIME_SCHEDULER]` 取到 undefined，报
//   `Cannot read properties of undefined (reading 'prepare')`。
//   实测：同样的代码，从 profile 内路径 import 能加载成功，但运行时调用必崩。
//
//   生态通行做法（对照已正常运行于本机的第三方插件 dsh-purge）：直接
//   `ctx.tools.register({ ...普通对象 })`，把参数/输出 schema 用**裸 JSON Schema** 写，
//   完全不碰平台包。平台会自行校验并规范化。
//
// 契约常量与业务逻辑仍在 ./core.js（同样零依赖），测试可离线覆盖真实生产代码。
import {
  TOOL_NAME,
  VERIFY_TOOL_NAME,
  EXPORT_TOOL_NAME,
  RESUME_PARAMETERS_JSON_SCHEMA,
  RESUME_VALUE_SCHEMA,
  VERIFY_PARAMETERS_JSON_SCHEMA,
  VERIFY_VALUE_SCHEMA,
  EXPORT_PARAMETERS_JSON_SCHEMA,
  EXPORT_VALUE_SCHEMA,
  buildResumeValue,
  buildVerifyValue,
  buildExportPayload,
  detectExportFormat,
  createToolDefinition,
  createVerifyToolDefinition,
  createExportToolDefinition,
} from './core.js'

export const name = 'resume-studio'
export const inject = ['tools', 'systemPrompt']

export {
  TOOL_NAME,
  VERIFY_TOOL_NAME,
  EXPORT_TOOL_NAME,
  RESUME_PARAMETERS_JSON_SCHEMA,
  RESUME_VALUE_SCHEMA,
  VERIFY_PARAMETERS_JSON_SCHEMA,
  VERIFY_VALUE_SCHEMA,
  EXPORT_PARAMETERS_JSON_SCHEMA,
  EXPORT_VALUE_SCHEMA,
  DELIVERY_NOTE,
  buildResumeValue,
  buildVerifyValue,
  buildExportPayload,
  detectExportFormat,
  normalizeLanguage,
  createToolDefinition,
  createVerifyToolDefinition,
  createExportToolDefinition,
} from './core.js'

export { GUARD_VERSION, verifyRewrite } from './guard.js'
export { buildDocx, buildZip, parseResumeMarkdown, assembleDeliverable } from './export.js'

// ── 文件写入实现（装配层职责：IO 只在这里出现）──────────────────
//
// 为什么写入实现放在装配层而不是契约层：
// 契约层（core.js）必须保持零 IO、纯函数，这样它可以在任何环境离线测试，
// 也不会因引入 node:fs 而绑定运行时。IO 属于平台装配，归本文件负责。
//
// 安全边界（四条，都是防止毁坏用户文件或把文件写到意外位置）：
//   1. 拒绝目录路径（必须以文件扩展名结尾，且不能是已存在的目录）
//   2. 拒绝覆盖已存在的文件——用户已有的简历文件不该被静默替换
//   3. 父目录必须已存在，不自动创建（避免在意外位置生成文件树）
//   4. 可选根目录约束（环境变量 DSH_RESUME_EXPORT_ROOT）——见下

/**
 * 读取可选的导出根目录约束。
 *
 * 【存在理由（经独立验证发现）】
 * `SECURITY.md` 把会话模型定为"不受信任输出源"，而 `outputPath` 是
 * **模型传入的参数**。夹带在 JD 里的提示词注入可诱导模型在任意**
 * 已存在**的目录里创建文件。写盘前把路径限制在用户声明的范围内，
 * 可把这个攻击面收窄。
 *
 * 为什么不默认限制：默认值必须让插件开箱可用，而不能要求用户先配路径。
 * 未设定时不限制，但仍受边界 1-3 约束（尤其"绝不覆盖已有文件"）。
 *
 * @returns {string | null} 解析后的绝对根目录；未设定或非法时返回 null（不限制）
 */
function exportRoot() {
  const raw = process.env.DSH_RESUME_EXPORT_ROOT
  if (typeof raw !== 'string' || raw.trim() === '') return null
  return raw.trim()
}

/**
 * 把字节写入用户指定的路径。
 * @param {string} path 目标路径
 * @param {Buffer} data 文件字节
 * @returns {Promise<string>} 实际落盘的绝对路径（供调用方据实回执）
 * @throws {Error} 路径非法、越界、已存在或父目录缺失时抛错
 */
export async function writeResumeFile(path, data) {
  const fs = await import('node:fs/promises')
  const nodePath = await import('node:path')

  const target = nodePath.resolve(path)
  const parent = nodePath.dirname(target)

  // 边界 4：可选的根目录约束（未设定时不限制）
  const root = exportRoot()
  if (root !== null) {
    const resolvedRoot = nodePath.resolve(root)
    // 判定分两步，缺一不可：
    //
    //   1) 词法判定（path.relative）——挡住 `..` 穿越、绝对越界、
    //      兄弟目录（`<root>-evil`）。这些在路径字符串层面就能定论。
    //   2) **经由链接的判定（realpath）**——`path.relative` 是纯字符串计算，
    //      不解析 symbolic link / Windows junction，因此
    //      "根内的 junction 指向根外" 能绕过第 1 步写出根外
    //      （对抗性审查实测：`mklink /J` 普通用户即可创建，非理论攻击）。
    //      故再对**已存在的父目录**求 realpath 后复判一次。
    //
    // 注意 `rel.startsWith('..')` 的经典陷阱：它会把根内合法文件名
    // `..hidden.docx` 误判为父目录穿越。必须按路径分隔符精确判定。
    const escapes = (/** @type {string} */ from, /** @type {string} */ to) => {
      const rel = nodePath.relative(from, to)
      return rel === '..' || rel.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(rel)
    }
    if (escapes(resolvedRoot, target)) {
      throw new Error(
        `导出已中止：目标路径不在允许的导出目录内。\n` +
          `允许的目录（DSH_RESUME_EXPORT_ROOT）：${resolvedRoot}\n` +
          `你要写入的位置：${target}\n` +
          '请改用允许目录内的路径，或调整 DSH_RESUME_EXPORT_ROOT。',
      )
    }
    // 第 2 步：解析已存在祖先目录的真实位置（父目录可能尚不存在，
    // 故向上找到第一个存在的祖先再 realpath）。
    let existing = parent
    for (;;) {
      try {
        existing = await fs.realpath(existing)
        break
      } catch {
        const up = nodePath.dirname(existing)
        if (up === existing) break // 已到根
        existing = up
      }
    }
    let realRoot = resolvedRoot
    try {
      realRoot = await fs.realpath(resolvedRoot)
    } catch {
      realRoot = resolvedRoot
    }
    if (escapes(realRoot, existing)) {
      throw new Error(
        `导出已中止：目标路径经由链接指向了允许目录之外。\n` +
          `允许的目录（DSH_RESUME_EXPORT_ROOT）：${realRoot}\n` +
          `该方法解析到的真实位置：${existing}\n` +
          '符号链接/junction 不能被用来绕过导出目录限制。',
      )
    }
  }

  // 边界 1：不能是已存在的目录
  try {
    const stat = await fs.stat(target)
    if (stat.isDirectory()) {
      throw new Error(`目标路径是一个目录，不是文件：${target}`)
    }
    // 边界 2：不覆盖已存在文件
    throw new Error(
      `目标文件已存在，为避免覆盖你的文件，导出已中止：${target}\n` +
        '请换一个文件名，或先移走原文件。',
    )
  } catch (err) {
    const code = /** @type {{ code?: string }} */ (err).code
    // ENOENT = 文件不存在，正是我们期望的情况
    if (code === 'ENOENT') {
      // 继续
    } else if (code === undefined) {
      throw err // 上面主动抛出的错误（目录 / 已存在）
    } else {
      throw err
    }
  }

  // 边界 3：父目录必须已存在
  try {
    const parentStat = await fs.stat(parent)
    if (!parentStat.isDirectory()) {
      throw new Error(`父路径不是目录：${parent}`)
    }
  } catch (/** @type {unknown} */ err) {
    if (/** @type {{ code?: string }} */ (err).code === 'ENOENT') {
      throw new Error(`目标目录不存在：${parent}\n请先创建该目录，或改用已存在的目录。`)
    }
    throw err
  }

  await fs.writeFile(target, data)
  // 返回**实际落盘的绝对路径**：调用方据此向用户回执唯一可信的位置。
  // 若回显入参，用户传入相对路径时回执会与文件真实位置不一致。
  return target
}

/**
 * 系统提示词片段。定义在插件侧，apply 时注入。
 * 不依赖任何平台类型：text 是纯字符串（平台同时接受 string 与 provider 函数）。
 */
export const SECTION_NAME = 'tool:resume-studio'

/** @returns {string} 注入系统提示词的工具使用引导文本 */
export function sectionText() {
  return (
    '## 求职简历工坊\n' +
    '当用户要求「按岗位定制简历 / 根据 JD 优化简历 / 针对该招聘要求改简历」时，调用 `' +
    TOOL_NAME +
    '`：传入 `jd`（岗位描述原文）与 `resume`（简历原文）。\n' +
    '工具返回简历改写指令集，你必须严格按其中的规则产出四部分：' +
    '优化后简历 / 改动说明 / 待补充清单 / 校验结果。\n' +
    '铁律：只基于简历中真实存在的信息重排与强化，禁止编造任何新经历、新数据、新技能。\n' +
    '\n' +
    '**反虚构校验是强制步骤**：改写完成后必须调用 `' +
    VERIFY_TOOL_NAME +
    '`（传入 original = 简历原文、rewritten = 改写后全文），' +
    '由确定性代码比对是否引入原文没有的数字或机构名。\n' +
    '若返回 ok=false，必须修正后重新校验，直到通过才能交付；' +
    '未通过校验就交付视为违反铁律。\n' +
    '\n' +
    '**交付文件**：校验通过后，调用 `' +
    EXPORT_TOOL_NAME +
    '` 把简历导出为可投递文件（.docx / .md / .txt）。\n' +
    '导出路径由用户指定；默认只输出简历本体，' +
    '需要自己留档时把 includeAppendix 设为 true 以附带改动说明与校验结果。\n' +
    '必须同时传入 original = 简历原文（**改写前的那一份**，不能把改写结果回填进去，' +
    '否则校验会退化为自反比对并被拒绝）——导出前会由代码再执行一次反虚构校验，' +
    '未通过将拒绝写出文件（这是交付前的最后一道关，不是可选项）。\n' +
    '若导出被拒是因为你补了原文没有的事实信息（最常见的是联系方式：电话/邮箱），' +
    '**不要反复重试同一个调用**：应请用户提供真实的原文补充，把它并入 original 后再导出。\n' +
    '该工具不会覆盖已存在的文件——若用户要覆盖，请提示其先确认。'
  )
}

/** 平台已为「其它工具类报告」预留的 section 位次（SECTION_ORDERS.TOOL_REPORT）。 */
const SECTION_ORDER_FALLBACK = 2900

/**
 * 插件装配入口。由 DSH loader 调用。
 *
 * 只做两件事：注入一段系统提示词、注册三个工具。
 * 业务逻辑与契约常量全部在 ./core.js 与 ./guard.js —— 唯一事实来源，避免双份定义漂移。
 * 文件 IO 只在这里出现（装配层职责），契约层保持纯函数可离线测试。
 *
 * @param {any} ctx cordis 上下文，需提供 systemPrompt 与 tools 两个服务
 * @returns {void | Array<() => void>} 工具注册的 disposer 列表（由平台托管）
 */
export function apply(ctx) {
  // 1) 系统提示词注入（对平台位次 API 做防御性降级）
  const order =
    typeof ctx.systemPrompt?.getSectionOrder === 'function'
      ? ctx.systemPrompt.getSectionOrder('TOOL_REPORT')
      : SECTION_ORDER_FALLBACK
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order,
    text: sectionText(),
  })

  // 2) 工具注册：普通对象 + 裸 JSON Schema，零平台依赖。
  //    定义来源与测试所测的是同一个函数，杜绝"测试绿但线上崩"。
  //    三个工具：改写指令集 / 反虚构校验 / 文件导出。
  const disposers = [
    ctx.tools.register(createToolDefinition()),
    ctx.tools.register(createVerifyToolDefinition()),
    ctx.tools.register(createExportToolDefinition(writeResumeFile)),
  ]
  return disposers
}

export default { name, inject, apply }
