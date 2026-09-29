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
  RESUME_PARAMETERS_JSON_SCHEMA,
  RESUME_VALUE_SCHEMA,
  VERIFY_PARAMETERS_JSON_SCHEMA,
  VERIFY_VALUE_SCHEMA,
  buildResumeValue,
  buildVerifyValue,
  createToolDefinition,
  createVerifyToolDefinition,
} from './core.js'

export const name = 'resume-studio'
export const inject = ['tools', 'systemPrompt']

export {
  TOOL_NAME,
  VERIFY_TOOL_NAME,
  RESUME_PARAMETERS_JSON_SCHEMA,
  RESUME_VALUE_SCHEMA,
  VERIFY_PARAMETERS_JSON_SCHEMA,
  VERIFY_VALUE_SCHEMA,
  DELIVERY_NOTE,
  buildResumeValue,
  buildVerifyValue,
  normalizeLanguage,
  createToolDefinition,
  createVerifyToolDefinition,
} from './core.js'

export { GUARD_VERSION, verifyRewrite } from './guard.js'

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
    '未通过校验就交付视为违反铁律。'
  )
}

/** 平台已为「其它工具类报告」预留的 section 位次（SECTION_ORDERS.TOOL_REPORT）。 */
const SECTION_ORDER_FALLBACK = 2900

/**
 * 插件装配入口。由 DSH loader 调用。
 *
 * 只做两件事：注入一段系统提示词、注册两个工具。
 * 业务逻辑与契约常量全部在 ./core.js 与 ./guard.js —— 唯一事实来源，避免双份定义漂移。
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
  //    两个工具：改写指令集（rewrite_resume）+ 反虚构校验（verify_rewrite）。
  const disposers = [
    ctx.tools.register(createToolDefinition()),
    ctx.tools.register(createVerifyToolDefinition()),
  ]
  return disposers
}

export default { name, inject, apply }
