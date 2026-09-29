// dsh-resume 核心契约层 —— 零外部依赖
//
// 分层理由：本文件不 import 任何平台包，因此**在任何机器上都能直接测试**，
// 且可被零依赖的 src/index.js 安全复用（避免模块双实例问题）。
import { RESUME_SYSTEM_PROMPT } from './prompt.js'
import { GUARD_VERSION, verifyRewrite } from './guard.js'

/** 模型可见的工具名。 */
export const TOOL_NAME = 'rewrite_resume'

/** 反虚构校验工具名。 */
export const VERIFY_TOOL_NAME = 'verify_rewrite'

/** 交付说明：提示词片段与测试共用一处，避免文案漂移。 */
export const DELIVERY_NOTE =
  '请严格按 instruction 中的系统规则处理 jd 与 resume，输出四部分：' +
  '「优化后简历」/「改动说明」/「待补充清单」/「校验结果」。' +
  '铁律：只基于简历真实内容重排强化，禁止编造经历、数据、技能；' +
  '改写后必须调用 verify_rewrite 校验，未通过须修正后重新校验。'

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

// ── 反虚构校验工具（verify_rewrite）────────────────────────────────
//
// 【为什么需要这个工具】
// 改写指令集只是"告诉模型别编造"，提示词本身无法提供保证。
// 本工具把校验交给**确定性代码**：模型改写完成后必须调用它，
// 由代码比对原文与改写结果，报告是否存在原文没有的数字/实体。
//
// 【架构差异说明】
// 本插件的改写由宿主会话模型完成，插件无法拦截其输出，
// 因此校验做成独立工具、由模型在改写后主动调用，
// 并在系统提示词中**强制要求**这一步（见 src/prompt.js 的交付流程）。

/** 校验工具的参数契约（裸 JSON Schema）。 */
export const VERIFY_PARAMETERS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    original: { type: 'string', description: '候选人简历原文（改写前的原始内容）' },
    rewritten: { type: 'string', description: '改写后的简历内容（待校验）' },
    claimedKeywords: {
      type: 'array',
      items: { type: 'string' },
      description:
        '可选：你声称已对齐的 JD 关键词。传入后会被回验——' +
        '若某词并未真的出现在改写结果中，将判为未通过（防止虚报覆盖率）。',
    },
  },
  required: ['original', 'rewritten'],
}

/**
 * 校验工具的 canonical 输出契约。
 *
 * findings 用字符串数组而非对象数组，是为了适配平台 schema 白名单
 * （仅允许 type/oneOf/properties/required/additionalProperties/items/enum/const，
 * 嵌套对象数组会触碰校验边界；字符串数组最稳）。
 */
export const VERIFY_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: '是否通过校验（无 error 级问题）' },
    guardVersion: { type: 'string', description: '校验规则版本' },
    summary: { type: 'string', description: '面向模型的结论摘要与处理要求' },
    issues: {
      type: 'array',
      items: { type: 'string' },
      description: '问题清单（每项为一行可读文本；无问题则为空数组）',
    },
    errorCount: { type: 'number', description: 'error 级问题数量' },
    warnCount: { type: 'number', description: 'warn 级问题数量' },
    limitations: {
      type: 'array',
      items: { type: 'string' },
      description: '本校验的已知局限（使用者须知晓边界，避免虚假安全感）',
    },
    verifiedKeywords: {
      type: 'array',
      items: { type: 'string' },
      description: '经回验确实出现在简历中的关键词（空数组表示未传入自报关键词）',
    },
    unverifiedKeywords: {
      type: 'array',
      items: { type: 'string' },
      description: '声称已覆盖但实际未出现的关键词',
    },
  },
  required: [
    'ok',
    'guardVersion',
    'summary',
    'issues',
    'errorCount',
    'warnCount',
    'limitations',
    'verifiedKeywords',
    'unverifiedKeywords',
  ],
}

/**
 * 校验工具的 canonical 返回值。字段与 {@link VERIFY_VALUE_SCHEMA} 严格一一对应。
 * @typedef {object} VerifyToolValue
 * @property {boolean} ok 是否通过校验（无 error 级问题）
 * @property {string} guardVersion 校验规则版本
 * @property {string} summary 面向模型的结论摘要与处理要求
 * @property {string[]} issues 问题清单（每项一行可读文本）
 * @property {number} errorCount error 级问题数量
 * @property {number} warnCount warn 级问题数量
 * @property {string[]} limitations 本校验的已知局限
 * @property {string[]} verifiedKeywords 经回验确实出现的关键词
 * @property {string[]} unverifiedKeywords 声称覆盖但未出现的关键词
 */

/**
 * 纯函数：由原文与改写结果算出校验报告。
 *
 * @param {{ original?: unknown, rewritten?: unknown, claimedKeywords?: string[] }} [args] 校验参数
 * @returns {VerifyToolValue} 严格匹配 VERIFY_VALUE_SCHEMA 的返回值
 * @throws {Error} 参数缺失或为空白时抛错
 */
export function buildVerifyValue({ original, rewritten, claimedKeywords } = {}) {
  if (typeof original !== 'string' || original.trim() === '') {
    throw new Error('original 为必填参数，且不能为空或纯空白')
  }
  if (typeof rewritten !== 'string' || rewritten.trim() === '') {
    throw new Error('rewritten 为必填参数，且不能为空或纯空白')
  }

  const report = verifyRewrite({ original, rewritten, claimedKeywords })
  const issues = report.findings.map(
    (f) => `[${f.severity === 'error' ? '必须修正' : '建议检查'}] ${f.code}：${f.message}`,
  )
  const errorCount = report.findings.filter((f) => f.severity === 'error').length
  const warnCount = report.findings.filter((f) => f.severity === 'warn').length

  let summary
  if (errorCount > 0) {
    summary =
      `校验未通过：发现 ${errorCount} 处疑似编造或夸大内容。` +
      '你必须修正这些问题后重新提交 —— 删除改写的编造数字/机构，' +
      '把升格的职责动词改回原强度，恢复被改动的日期。' +
      '修正后请再次调用本工具确认通过。'
  } else if (warnCount > 0) {
    summary =
      `校验通过（无编造），但有 ${warnCount} 处提醒：原文的部分真实数据在改写后消失。` +
      '若非有意压缩，建议保留这些真实量化结果。'
  } else {
    summary = '校验通过：改写未引入原文不存在的数字或机构，且原文数据均被保留。'
  }

  return {
    ok: report.ok,
    guardVersion: report.guardVersion,
    summary,
    issues,
    errorCount,
    warnCount,
    limitations: report.limitations,
    verifiedKeywords: report.coverage?.verified ?? [],
    unverifiedKeywords: report.coverage?.unverified ?? [],
  }
}

/**
 * 校验工具的完整定义（普通对象，零平台依赖）。
 * @returns {object} 平台工具定义
 */
export function createVerifyToolDefinition() {
  return {
    name: VERIFY_TOOL_NAME,
    description:
      '反虚构校验（确定性代码执行，非模型判断）。传入简历原文与改写后内容，' +
      '逐项比对改写是否引入了原文不存在的内容：数字、机构/专名、' +
      '职责强度升格（把「参与」写成「主导」）、时间点改动，' +
      '并报告原文数据的丢失情况。' +
      '改写简历后必须调用本工具；返回 ok=false 时必须先修正再交付。',
    parameters: VERIFY_PARAMETERS_JSON_SCHEMA,
    output: {
      schema: VERIFY_VALUE_SCHEMA,
      /**
       * 把校验结果投影为模型可见内容：摘要 + 逐条明细。
       * @param {unknown} _args 原始参数（平台契约要求签名包含，此处未使用）
       * @param {VerifyToolValue} value 已校验的 canonical 值
       * @returns {Array<{ type: string, text: string }>} 内容块数组
       */
      render: (_args, value) => {
        const lines = [String(value?.summary ?? '')]
        const issues = Array.isArray(value?.issues) ? value.issues : []
        if (issues.length > 0) {
          lines.push('', '明细：')
          for (const item of issues) lines.push(`- ${item}`)
        }
        const unverified = Array.isArray(value?.unverifiedKeywords) ? value.unverifiedKeywords : []
        const verified = Array.isArray(value?.verifiedKeywords) ? value.verifiedKeywords : []
        if (verified.length > 0 || unverified.length > 0) {
          lines.push('', '关键词回验（自报 ≠ 事实）：')
          if (verified.length > 0) lines.push(`- 已证实出现在简历中：${verified.join('、')}`)
          if (unverified.length > 0) lines.push(`- 声称覆盖但未出现：${unverified.join('、')}`)
        }
        const limits = Array.isArray(value?.limitations) ? value.limitations : []
        if (limits.length > 0) {
          lines.push('', '本校验的已知边界（须自行确认）：')
          for (const item of limits) lines.push(`- ${item}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    /**
     * @param {unknown} args 模型传入的参数
     * @returns {Promise<object>} 非法输入时 reject
     */
    async execute(args) {
      const { original, rewritten, claimedKeywords } =
        /** @type {{ original?: string, rewritten?: string, claimedKeywords?: string[] }} */ (
          args || {}
        )
      return buildVerifyValue({ original, rewritten, claimedKeywords })
    },
    /**
     * 待执行状态的界面呈现意图。
     * @param {unknown} args 模型传入的参数
     * @returns {object} 平台 generic card 描述
     */
    presentCall: (args) => {
      const a = /** @type {{ rewritten?: string }} */ (args || {})
      return {
        card: 'generic',
        title: '反虚构校验',
        kind: 'other',
        ...(typeof a.rewritten === 'string' ? { rawInput: a.rewritten.slice(0, 200) } : {}),
      }
    },
  }
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
