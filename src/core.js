// dsh-resume 核心契约层 —— 零外部依赖
//
// 分层理由：本文件不 import 任何平台包，因此**在任何机器上都能直接测试**，
// 且可被零依赖的 src/index.js 安全复用（避免模块双实例问题）。
import { RESUME_SYSTEM_PROMPT } from './prompt.js'

/** 模型可见的工具名。 */
export const TOOL_NAME = 'rewrite_resume'

/** 交付说明：提示词片段与测试共用一处，避免文案漂移。 */
export const DELIVERY_NOTE =
  '请严格按 instruction 中的系统规则处理 jd 与 resume，输出三部分：' +
  '「优化后简历」/「改动说明」/「待补充清单」。' +
  '铁律：只基于简历真实内容重排强化，禁止编造经历、数据、技能。'

/**
 * canonical 输出契约（**裸 JSON Schema**）。
 *
 * additionalProperties:false 表示平台会拒绝任何多余字段，因此 execute 的返回值
 * 字段必须与此处**严格一一对应**（这是曾经的真实缺陷：返回值带 extra 字段会触发
 * ToolOutputError，工具直接失败）。
 *
 * 注意：`required` 必须是 **object 根级的字符串数组**，不能写在每个 property 内部。
 * 平台校验器（assertSupportedJsonSchema）只接受
 * `type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解，
 * 且 `required` 仅允许出现在 type:"object" 节点上。
 */
export const RESUME_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    instruction: { type: 'string', description: '简历改写指令集（供会话模型据此重写）' },
    jd: { type: 'string', description: '岗位描述原文（透传）' },
    resume: { type: 'string', description: '简历原文（透传，未篡改）' },
    language: { type: 'string', enum: ['zh', 'en'], description: '实际生效的输出语言' },
    note: { type: 'string', description: '三段式交付说明' },
  },
  required: ['instruction', 'jd', 'resume', 'language', 'note'],
}

/**
 * 模型可见的参数契约。
 *
 * 实测（dsh-tools 0.1.5-rc.2）：参数根节点是隐式开放对象，未知参数不会被拦截，
 * 所以不能依赖平台挡住多余字段。防线是：required 校验 + 本模块只读取白名单字段。
 */
export const RESUME_PARAMETERS = {
  jd: { type: 'string', required: true, description: '岗位描述原文（招聘页 JD 全文）' },
  resume: { type: 'string', required: true, description: '候选人简历原文（Markdown 或纯文本）' },
  language: { type: 'string', enum: ['zh', 'en'], description: '输出语言，默认 zh（简体中文）' },
}

/**
 * 参数的裸 JSON Schema 形式。
 *
 * 为什么不用平台的 `defineTool({ parameters })` DSL：那需要 import 平台包，
 * 会在插件侧形成模块双实例，运行时崩溃（见 src/index.js 顶部说明）。
 * 平台注册接受的 parameters 就是标准 JSON Schema 对象。
 */
export const RESUME_PARAMETERS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    jd: { type: 'string', description: '岗位描述原文（招聘页 JD 全文）' },
    resume: { type: 'string', description: '候选人简历原文（Markdown 或纯文本）' },
    language: { type: 'string', enum: ['zh', 'en'], description: '输出语言，默认 zh（简体中文）' },
  },
  required: ['jd', 'resume'],
}

/**
 * 工具参数（模型传入的原始对象）。
 * 平台参数根节点是开放对象，因此这里全部声明为可选，由 buildResumeValue 做严格校验。
 * @typedef {object} ResumeToolArgs
 * @property {string} [jd] 岗位描述原文
 * @property {string} [resume] 简历原文
 * @property {string} [language] 输出语言偏好
 */

/**
 * 工具的 canonical 返回值。字段与 {@link RESUME_VALUE_SCHEMA} 严格一一对应。
 * @typedef {object} ResumeToolValue
 * @property {string} instruction 简历改写指令集
 * @property {string} jd 岗位描述原文（透传）
 * @property {string} resume 简历原文（透传，未篡改）
 * @property {string} language 实际生效的输出语言
 * @property {string} note 三段式交付说明
 */

/** @typedef {'zh' | 'en'} SupportedLanguage */

/**
 * 规范化语言：仅 'en' 走英文，其余一律 zh（默认值语义）。
 * @param {unknown} [language] 任意模型输入
 * @returns {SupportedLanguage} 'en' 或 'zh'
 */
export function normalizeLanguage(language) {
  return language === 'en' ? 'en' : 'zh'
}

/**
 * 纯函数核心：由参数算出唯一的 canonical value。
 * 无副作用、不依赖平台，离线测试直接断言此函数即可覆盖生产路径。
 * @param {ResumeToolArgs} [args] 模型传入的参数
 * @returns {ResumeToolValue} 严格匹配输出 schema 的返回值
 * @throws {Error} jd 或 resume 缺失/纯空白时抛错（平台会将其规范化为失败结果）。
 */
export function buildResumeValue({ jd, resume, language } = {}) {
  if (typeof jd !== 'string' || jd.trim() === '') {
    throw new Error('jd 为必填参数，且不能为空或纯空白')
  }
  if (typeof resume !== 'string' || resume.trim() === '') {
    throw new Error('resume 为必填参数，且不能为空或纯空白')
  }
  const lang = normalizeLanguage(language)
  return {
    instruction: RESUME_SYSTEM_PROMPT(lang),
    jd,
    resume,
    language: lang,
    note: DELIVERY_NOTE,
  }
}

/**
 * canonical value 的字段名集合（供一致性断言复用）。
 * @returns {string[]} 已排序的字段名
 */
export function declaredValueKeys() {
  return Object.keys(RESUME_VALUE_SCHEMA.properties).sort()
}

/**
 * 工具定义（普通对象，零平台依赖）。src/index.js 与测试共用此唯一来源。
 *
 * 形状按平台 `ctx.tools.register` 的契约手写：
 * - `parameters` 是裸 JSON Schema
 * - `output.schema` 是 canonical 值契约，`render` 把它投影为模型可见内容
 * - 不 import 平台包，避免模块双实例（见 src/index.js 顶部说明）
 *
 * @returns {{
 *   name: string,
 *   description: string,
 *   parameters: object,
 *   output: { schema: object, render: (args: unknown, value: ResumeToolValue) => Array<{ type: string, text: string }> },
 *   execute: (args: unknown) => Promise<ResumeToolValue>,
 *   presentCall: (args: ResumeToolArgs) => object,
 * }}
 */
export function createToolDefinition() {
  return {
    name: TOOL_NAME,
    description:
      '根据岗位描述(JD)重写求职简历。输入 jd 与 resume 原文，返回针对该岗位优化的简历改写指令集' +
      '（含反虚构铁律、ATS 关键词对齐、待补充清单机制）。只基于真实内容重排强化，绝不编造。',
    parameters: RESUME_PARAMETERS_JSON_SCHEMA,
    output: {
      schema: RESUME_VALUE_SCHEMA,
      /**
       * 把 canonical 值投影为模型可见内容：只暴露指令集。
       * @param {unknown} _args 原始参数（平台契约要求签名包含，此处未使用）
       * @param {ResumeToolValue} value 已校验的 canonical 值
       * @returns {Array<{ type: string, text: string }>} 内容块数组
       */
      render: (_args, value) => [{ type: 'text', text: String(value?.instruction ?? '') }],
    },
    /**
     * 执行入口。白名单解构：平台参数根节点开放，多余字段一律忽略。
     *
     * 声明为 async 是有意的：平台契约要求 execute 返回 Promise，
     * 而 buildResumeValue 对非法输入同步抛错。async 包装把同步异常统一
     * 转为 rejected promise，使失败路径与平台契约一致（不会穿透成同步异常）。
     *
     * @param {unknown} args 模型传入的参数
     * @returns {Promise<ResumeToolValue>} 非法输入时 reject
     */
    async execute(args) {
      const { jd, resume, language } = /** @type {ResumeToolArgs} */ (args || {})
      return buildResumeValue({ jd, resume, language })
    },
    /**
     * 待执行状态的界面呈现意图。
     * @param {ResumeToolArgs} args 模型传入的参数
     * @returns {object} 平台 generic card 描述
     */
    presentCall: (args) => ({
      card: 'generic',
      title: '按 JD 重写简历',
      kind: 'other',
      ...(args?.jd === undefined ? {} : { rawInput: String(args.jd).slice(0, 200) }),
    }),
  }
}
