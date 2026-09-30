// dsh-resume 核心契约层 —— 零外部依赖
//
// 分层理由：本文件不 import 任何平台包，因此**在任何机器上都能直接测试**，
// 且可被零依赖的 src/index.js 安全复用（避免模块双实例问题）。
import { RESUME_SYSTEM_PROMPT } from './prompt.js'
import { GUARD_VERSION, detectSelfAttestation, normalizeText, verifyRewrite } from './guard.js'
import { assembleDeliverable, buildDocx, buildText } from './export.js'

/** 模型可见的工具名。 */
export const TOOL_NAME = 'rewrite_resume'

/** 反虚构校验工具名。 */
export const VERIFY_TOOL_NAME = 'verify_rewrite'

/** 简历导出工具名。 */
export const EXPORT_TOOL_NAME = 'export_resume'

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
    // 【为什么也必须按实际 finding 生成（本轮自查发现的真实 bug）】
    // 这里原先写死一句"删除编造数字/机构、把职责动词改回原强度、恢复被改动的日期"。
    // 但 error 级**共有 6 种**，其中两种与这句话毫无关系：
    //   · `NOVEL_CONTENT`（整条新增）→ 该做的是**删掉多出来的那条**，
    //     而不是去改数字或日期；
    //   · `UNVERIFIED_KEYWORD_CLAIM`（关键词虚报）→ 该做的是
    //     **把词写进经历或移入待补充清单**，改数字完全解决不了问题。
    // 模型会**照错方向修正**：改完数字再校验，同一处 error 依旧，
    // 白跑一轮（而 `verify_rewrite` 的修正闭环正是靠这段 summary 驱动的）。
    //
    // 这与 v1.3.0 修的是**同一个 bug**——当时只改了 warn 侧，error 侧漏了。
    // 教训：凡"按 finding 种类输出文案"处，必须**逐 code 覆盖**，
    // 且新增 code 时要同步补；写死的兜底文案必然与实现脱节。
    const errorActions = /** @type {Record<string, string>} */ ({
      FABRICATED_NUMBER: '删除改写的编造数字，恢复原文的真实数值',
      FABRICATED_ENTITY: '删除原文没有的技术名/机构名，或改回原文写法',
      RESPONSIBILITY_INFLATED: '把升格的职责动词改回原强度（如「主导」改回「参与」）',
      FABRICATED_DATE: '把被改动的日期恢复为原文的时间',
      NOVEL_CONTENT: '删除凭空新增的整条内容（原文中找不到出处的经历/职责）',
      UNVERIFIED_KEYWORD_CLAIM:
        '把你声称覆盖的关键词真正写进对应经历，或从声称列表中移除并移入「待补充清单」',
    })
    const errorFindings = report.findings.filter((f) => f.severity === 'error')
    const actions = [
      ...new Set(
        errorFindings.map((f) => errorActions[f.code] ?? `修正该项：${f.code}`),
      ),
    ]
    summary =
      `校验未通过：发现 ${errorCount} 处疑似编造或夸大内容。` +
      '你必须按下列方式修正后重新提交：\n' +
      actions.map((a) => `- ${a}`).join('\n') +
      '\n修正后请再次调用本工具确认通过。绝不允许"保留但说明"。'
  } else if (warnCount > 0) {
    // 【为什么必须按实际 finding 生成，不能写死一句文案（独立审查发现的真实 bug）】
    // 早期这里写的是"原文的部分真实数据在改写后消失"，但那只是**其中一种** warn。
    // 本轮新增了 `AMBIGUOUS_NEW_TERM`（新增了待确认的技术名）与
    // `VANISHED_TECH_TERM`（技术名消失）等 warn 级后，写死的文案会与实际情况不符：
    // 模型被告知"数据丢失"，而真实问题是"新增了技术名"——它会**照错方向修正**，
    // 而 `verify_rewrite` 的修正闭环正是靠这段 summary 驱动的。
    // 故改为按每个 warn finding 的实际 code 归类描述。
    const warnLabels = /** @type {Record<string, string>} */ ({
      LOST_NUMBER: '原文的真实量化数据在改写后消失（若非有意压缩，建议保留）',
      AMBIGUOUS_NEW_TERM: '新增了原文没有的技术名/缩写，需人工确认是否属实',
      VANISHED_TECH_TERM: '原文的技术名消失且无其它技术名接替，需确认是改成中文表述还是删除',
      UNIT_CASE_CHANGED: '容量单位的大小写被改动（b/B 是比特与字节，相差 8 倍），需确认是否误改',
      POSSIBLE_RESPONSIBILITY_INFLATION: '合并条目处疑似抬高了职责，需人工确认',
    })
    const warnFindings = report.findings.filter((f) => f.severity === 'warn')
    const described = [
      ...new Set(
        warnFindings.map((f) => warnLabels[f.code] ?? `需人工确认：${f.code}`),
      ),
    ]
    summary =
      `校验通过（无编造），但有 ${warnCount} 处**待人工确认**：\n` +
      described.map((d) => `- ${d}`).join('\n') +
      '\n这些不影响交付，但请自行确认是否属实。'
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

// ── 简历导出工具（export_resume）──────────────────────────────────
//
// 【为什么需要】
// 此前用户改完简历只能拿到聊天里的 Markdown，要自己复制、排版、另存为 Word。
// 对非技术用户来说这一步就是使用门槛——"改好了但不知道怎么变成能投的文件"。
// 本工具把这条链路补齐：一次调用直接产出可投递的 .docx。
//
// 【设计约束】
// - 只写用户明确指定的路径，不做目录遍历或自动改写既有文件
// - 不覆盖已存在的文件（除非调用方显式要求），避免误毁用户文件
// - 生成内容完全来自传入的文本，不引入任何外部数据

/** 导出工具的参数契约（裸 JSON Schema）。 */
export const EXPORT_PARAMETERS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    resume: { type: 'string', description: '优化后的简历内容（Markdown）' },
    outputPath: {
      type: 'string',
      description: '输出文件的绝对路径，扩展名决定格式（.docx / .md / .txt）',
    },
    original: {
      type: 'string',
      description:
        '简历原文（改写前的那一份）。**必填**：导出前由代码强制执行一次反虚构校验，' +
        '校验不通过则拒绝写出文件。注意它必须是改写前的原文，' +
        '不能把改写结果回填进来（两者相同时校验会退化为自反比对，将被拒绝）。',
    },
    changes: { type: 'string', description: '可选：改动说明，写入导出文件的附页' },
    gaps: { type: 'string', description: '可选：待补充清单，写入导出文件的附页' },
    verification: { type: 'string', description: '可选：校验结果，写入导出文件的附页' },
    includeAppendix: {
      type: 'boolean',
      description:
        '是否把改动说明/待补充/校验结果一并写入（默认 false）。' +
        '投递给 HR 时应为 false，只留简历本体；留档时可设为 true。' +
        '注意：附录属元信息，不参与反虚构校验。',
    },
  },
  required: ['resume', 'outputPath', 'original'],
}

/** 导出工具的 canonical 输出契约。 */
export const EXPORT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: '是否成功写出文件' },
    path: { type: 'string', description: '实际写入的文件路径' },
    format: { type: 'string', enum: ['docx', 'md', 'txt'], description: '导出格式' },
    bytes: { type: 'number', description: '文件字节数' },
    verified: {
      type: 'boolean',
      description:
        '本次导出是否经过反虚构校验。true = 已对照传入的 original 校验通过；' +
        'false = 调用方未提供原文，无法校验（投递前请补做校验）。' +
        '注意：true 表示"结果与传入的原文一致"，不表示"传入的原文必定是用户的真实原文"——' +
        'original 由调用方提供，代码只能校验两者之间的关系。',
    },
    summary: { type: 'string', description: '面向模型的结论摘要' },
  },
  required: ['ok', 'path', 'format', 'bytes', 'verified', 'summary'],
}

/**
 * 根据扩展名判定导出格式。
 *
 * 注意：必须先 trim 再判定。`exportResume` 写盘前会对路径做 trim，
 * 若这里不 trim，`" a.docx "` 会被判为"不支持的格式"而报错，
 * 与"同一条路径稍后却能正常写入"自相矛盾（判定与写入基准必须一致）。
 *
 * @param {string} filePath 输出路径
 * @returns {'docx' | 'md' | 'txt' | null} 格式；不支持的扩展名返回 null
 */
export function detectExportFormat(filePath) {
  const lower = String(filePath ?? '').trim().toLowerCase()
  if (lower.endsWith('.docx')) return 'docx'
  if (lower.endsWith('.md')) return 'md'
  if (lower.endsWith('.txt')) return 'txt'
  return null
}

/**
 * 纯函数：把输入参数整理为「待写入的字节」。
 * 与文件系统解耦，便于离线测试（写盘由 execute 负责）。
 *
 * @param {{
 *   resume?: unknown,
 *   outputPath?: unknown,
 *   changes?: unknown,
 *   gaps?: unknown,
 *   verification?: unknown,
 *   includeAppendix?: unknown,
 * }} [args] 导出参数
 * @returns {{ format: 'docx' | 'md' | 'txt', data: Buffer, content: string }}
 *   格式、字节、以及用于展示的文本内容
 * @throws {Error} 参数非法时抛错
 */
export function buildExportPayload({
  resume,
  outputPath,
  changes,
  gaps,
  verification,
  includeAppendix,
} = {}) {
  if (typeof resume !== 'string' || resume.trim() === '') {
    throw new Error('resume 为必填参数，且不能为空或纯空白')
  }
  if (typeof outputPath !== 'string' || outputPath.trim() === '') {
    throw new Error('outputPath 为必填参数，且不能为空或纯空白')
  }
  const format = detectExportFormat(outputPath)
  if (format === null) {
    throw new Error(
      `不支持的输出格式：${outputPath}。支持的扩展名：.docx / .md / .txt`,
    )
  }

  // 是否附带说明性内容。默认不附带——投递给 HR 的版本应只有简历本体。
  const withAppendix = includeAppendix === true
  const asText = (/** @type {unknown} */ v) => (typeof v === 'string' ? v : '')
  const content = withAppendix
    ? assembleDeliverable({
        resume,
        changes: asText(changes),
        gaps: asText(gaps),
        verification: asText(verification),
      })
    : String(resume).trim()

  if (format === 'docx') {
    return { format, data: buildDocx(content), content }
  }
  return { format, data: buildText(content), content }
}

/**
 * 把简历导出为可投递文件。
 *
 * 注意：本函数需要文件系统写入能力，因此**依赖调用方注入的 writeFile**，
 * 而不是直接 import node:fs。这样：
 *   1. 契约层保持可离线测试（测试注入假写入函数）
 *   2. 装配层（index.js）负责真正的 IO，职责分明
 *
 * 【交付关：反虚构校验由代码强制执行】
 * 此前校验只发生在 verify_rewrite，模型若跳过它直接调 export_resume，
 * 用户就会拿到未经校验、可能含编造内容的简历——等于把铁律交回给"模型自觉"，
 * 正是本项目存在理由所要消除的东西。现在只要调用方提供了原文，
 * 导出前一律先跑确定性校验；不通过则**拒绝写出文件**，并指明问题。
 *
 * 未提供原文时无法校验（没有比对基准），此时允许导出以便用户留档，
 * 但返回值 `verified: false` 并附明确提醒——不制造"已校验"的假象。
 *
 * @param {{
 *   resume?: unknown,
 *   outputPath?: unknown,
 *   original?: unknown,
 *   changes?: unknown,
 *   gaps?: unknown,
 *   verification?: unknown,
 *   includeAppendix?: unknown,
 * }} args 导出参数
 * @param {(path: string, data: Buffer) => Promise<string | void>} writeFile 写入实现
 *   （可返回实际落盘的绝对路径；返回时以它为准向用户回执）
 * @returns {Promise<object>} 严格匹配 EXPORT_VALUE_SCHEMA 的返回值
 * @throws {Error} 提供了原文且校验不通过时抛错（不写出任何文件）
 */
export async function exportResume(args, writeFile) {
  const payload = buildExportPayload(args)
  const path = String(/** @type {{ outputPath: string }} */ (args).outputPath).trim()
  const a = /** @type {{ original?: unknown, resume?: unknown, includeAppendix?: unknown }} */ (args)

  // ── 交付关 ──────────────────────────────────────────────────────
  //
  // 【为什么必须防"自证清白"】
  // `original` 是模型自己传的参数，不是可信源。若模型把编造内容同时写进
  // original 与 resume，verifyRewrite 就退化成自反比对——原文等于"改写"，
  // 任何编造都"有据可依"，而返回值还会宣称"校验已通过"。
  // 那比不做这道关更糟：它把"没有校验"伪装成"校验通过"。
  //
  // 【为什么判定逻辑放在 guard.js（外部审查发现 S1-3）】
  // 内联的第一版只做 `trim 后相等` 判定，于是**加任意一行即可绕过**：
  //   `original = 编造版 + "以上为我的原始简历内容"` → 导出成功且 verified=true。
  // 现在判定由 {@link detectSelfAttestation} 统一负责（纯函数、有独立测试），
  // 它是"两处判定必须一致"的唯一事实来源。
  //
  // 【两档判据必须区别对待——这是本轮实测抓出的、我自己第一版的缺陷】
  // 第一版把 `equal` 与 `contains` 都直接拒绝导出，于是**误伤了合法改写**：
  //   original `- A\n- B` → resume `- A`（模型只是删掉一条经历，一字未改）
  //   → 被判为"副本"并拒绝 → 用户永久拿不到文件，
  //     正是 S1-1 那一类**投递死锁**（用户视角：改好了却导不出）。
  //
  // 纯文本层面**无法区分**"尾部加了装饰"与"删掉了一条经历"——
  // 两者都表现为"original = resume + 一小段"。任何阈值只是把误判挪个位置。
  // 因此按代价不对称处理：
  //   - `equal`    → **硬拒绝**。两份完全相同必定是传错参数，无歧义，
  //                  且提示后能立刻改正，不构成死锁。
  //   - `contains` → **不拒绝**，而是降级为 `verified: false` 并说明原因。
  //                  既不谎称"已校验"，也不让用户拿不到文件。
  //                  `original` 本就是不可信输入，既然不存在可靠保证，
  //                  就不该用一个会误伤的判据去假装有保证。
  const original = a.original
  const resumeText = typeof a.resume === 'string' ? a.resume : ''
  const hasOriginal = typeof original === 'string' && original.trim() !== ''
  let verified = false
  /** 自证清白的降级说明（`contains` 档），随 summary 一并返回 */
  let selfAttestNote = ''
  /** 校验通过但存在 warn 级待确认项（不阻断交付，但回执不得宣称"完全通过"） */
  /** @type {Array<{ code: string, message: string }>} */
  let warnFindings = []

  if (hasOriginal) {
    const selfAttest = detectSelfAttestation(original, resumeText)
    if (selfAttest.reason === 'equal') {
      throw new Error(
        '导出已中止：original 与 resume 实质相同，无法构成有效校验。\n' +
          '反虚构校验需要"改写前的原文"作为比对基准；两者相同时校验会退化为自反比对，' +
          '任何编造都查不出来。\n' +
          '请传入真实的简历原文（改写前的那一份），而不是把改写结果回填进去。',
      )
    }

    const report = verifyRewrite({ original, rewritten: resumeText })
    if (!report.ok) {
      const errors = report.findings.filter((f) => f.severity === 'error')
      throw new Error(
        `导出已中止：反虚构校验未通过（${errors.length} 项）。\n` +
          errors.map((f) => `- ${f.message}`).join('\n') +
          // 给出出路，否则用户会陷入"改好了却导不出"的死锁。
          // 最常见的情形是补全联系方式：电话/邮箱是事实信息，
          // 模型无从知道用户真实号码，只能由用户提供。
          '\n处理方式：\n' +
          '1) 若是编造内容 → 删除，或改回原文的表述；\n' +
          '2) 若是你补充的真实信息（如联系方式、真实时间）→ ' +
          '把它同时写进简历原文（original），让校验有据可依，然后重新导出。\n' +
          '编造的经历会在面试中被问穿，因此这道关不能跳过。',
      )
    }
    if (selfAttest.reason === 'contains') {
      // 校验本身通过，但 original 看起来就是 resume 的副本（仅多出少量文字）。
      // 无法确定是"伪造的原文"还是"模型删掉了一条经历"，
      // 因此不宣称"已校验"，也不阻断导出（阻断会造成投递死锁）。
      selfAttestNote =
        '注意：传入的 original 与 resume 高度重合（original 仅比 resume 多出少量文字），' +
        '无法确认它是否真的是改写前的原文——**本次不视为已通过反虚构校验**。' +
        '若你的原文确实包含被删掉的内容，可忽略此提示；' +
        '但请自行确认简历中没有编造的数字/经历。'
    } else {
      // 【为什么要把 warn 一并带出来（独立审查发现 #3）】
      // 只触发 warn 时，回执若写"反虚构校验已通过"，而同一份文件里其实
      // 有一条"请人工确认这些词是否属实"——等于把"有疑点"呈现为"已通过"，
      // 与本项目"不制造虚假安全感"的原则冲突。
      // 因此 warn 存在时，把措辞降级为"通过，但有 N 处待人工确认"。
      verified = true
      warnFindings = report.findings.filter((f) => f.severity === 'warn')
    }
  }

  // 写入实现返回**实际落盘的绝对路径**（装配层负责 resolve）。
  //
  // 【存在理由（外部审查发现 S3-5）】
  // 此前返回值直接回显用户传入的 `outputPath`：参数文档声称它是"绝对路径"，
  // 但代码既不校验也不解析，于是传入相对路径时，用户拿到的回执
  // 与文件真实位置不一致——按回执去找文件会找不到。
  // 现在以写入实现返回的路径为准；未返回时（测试注入的假写入函数）
  // 回退为 trim 后的入参，不破坏既有契约。
  const writeResult = await writeFile(path, payload.data)
  const actualPath = typeof writeResult === 'string' && writeResult !== '' ? writeResult : path

  // 附录（改动说明/待补充清单/校验结果）是**元信息**，不参与反虚构校验——
  // 待补充清单列出 JD 要求但简历缺失的技能（如 Vue3、TypeScript）本就是设计意图，
  // 拿去校验必然误报。但也不能因此让用户以为整份文件都被校验过，故明确声明范围。
  const withAppendix = a.includeAppendix === true
  return {
    ok: true,
    path: actualPath,
    format: payload.format,
    bytes: payload.data.length,
    verified,
    summary:
      `已导出 ${payload.format.toUpperCase()} 文件（${payload.data.length} 字节）到 ${actualPath}。` +
      (payload.format === 'docx'
        ? '该文件可直接用于投递；版式为单栏 A4，ATS 可正常解析。'
        : '') +
      (verified
        ? warnFindings.length > 0
          ? // 有 warn 时**不得**笼统说"已通过"——那会把"有疑点"呈现为"已通过"。
            `反虚构校验通过（guard ${GUARD_VERSION}；对照传入的原文比对），` +
            `但有 ${warnFindings.length} 处**待人工确认**：\n` +
            warnFindings.map((f) => `- [${f.code}] ${f.message}`).join('\n')
          : `反虚构校验已通过（guard ${GUARD_VERSION}；对照传入的原文比对）` +
            (withAppendix
              ? '；**校验范围仅限简历本体**，附录（改动说明/待补充/校验结果）属元信息，不参与校验。'
              : '。')
        : selfAttestNote !== ''
          ? selfAttestNote
          : '注意：本次未提供简历原文，因此**未做反虚构校验**——' +
            '投递前请用 verify_rewrite 补做一次，确认没有编造的数字/机构/职责升格。'),
  }
}

/**
 * 导出工具的完整定义（普通对象，零平台依赖）。
 * @param {(path: string, data: Buffer) => Promise<string | void>} writeFile 写入实现（由装配层注入）
 * @returns {object} 平台工具定义
 */
export function createExportToolDefinition(writeFile) {
  return {
    name: EXPORT_TOOL_NAME,
    description:
      '把优化后的简历导出为可投递文件。支持 .docx（推荐，可直接投递）、.md、.txt。' +
      '默认只输出简历本体；设 includeAppendix=true 会把改动说明/待补充清单/校验结果一并附加' +
      '（适合自己留档，不适合发给 HR）。不会覆盖已存在的文件。' +
      '**必须传 original（简历原文）**：导出前会由代码强制执行一次反虚构校验，' +
      '校验不通过将拒绝写出文件，从机制上杜绝"编造的简历被投递出去"。',
    parameters: EXPORT_PARAMETERS_JSON_SCHEMA,
    output: {
      schema: EXPORT_VALUE_SCHEMA,
      /**
       * @param {unknown} _args 原始参数
       * @param {{ summary?: string }} value 已校验的值
       * @returns {Array<{ type: string, text: string }>} 内容块
       */
      render: (_args, value) => [{ type: 'text', text: String(value?.summary ?? '') }],
    },
    /**
     * @param {unknown} rawArgs 模型传入的参数
     * @returns {Promise<object>} 非法输入时 reject
     */
    async execute(rawArgs) {
      if (typeof writeFile !== 'function') {
        throw new Error('导出功能未装配写入实现（插件装配层错误）')
      }
      const args = /** @type {object} */ (rawArgs || {})
      return exportResume(args, writeFile)
    },
    /**
     * @param {unknown} rawArgs 模型传入的参数
     * @returns {object} 平台 generic card 描述
     */
    presentCall: (rawArgs) => {
      const a = /** @type {{ outputPath?: string }} */ (rawArgs || {})
      return {
        card: 'generic',
        title: '导出简历文件',
        kind: 'other',
        ...(typeof a.outputPath === 'string' ? { rawInput: a.outputPath } : {}),
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
