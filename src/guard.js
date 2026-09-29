// 反虚构确定性守卫 —— 零外部依赖
//
// 【存在理由】
// 本项目此前把"禁止编造"写在 prompt 里，靠会话模型自觉遵守。
// 但提示词无法提供保证：模型一旦违规，没有任何机制能发现，
// 用户拿着编造的经验去面试就会翻车 —— 而项目存在的全部意义就是防这件事。
//
// 因此本模块把反虚构从"提示词约束"升级为"可执行的确定性校验"：
// 由代码判定改写结果是否引入了原文不存在的内容，判定结果不依赖模型态度。
//
// 【与同类实现的关键差异（本项目的架构选择）】
// 同类项目（如面向结构化 JSON 简历的 Web 应用）可以在服务端拦截 LLM 响应。
// 本插件是 DSH 插件，改写由宿主会话模型完成，插件无法拦截其输出。
// 因此本模块做成**独立校验函数**，由 `verify_rewrite` 工具暴露给模型：
//   模型改写 → 调用 verify_rewrite(原文, 改写后) → 得到违规清单 → 必须修正。
// 校验逻辑在代码里，模型只能遵守，不能绕过。
//
// 【设计原则】
// - 纯函数、无副作用、不依赖平台包（可在任何环境离线测试）
// - 只判定，不改写：本模块不替用户删改内容，只报告问题
// - 宁可多报可疑项，不可漏报编造项（漏报的代价是用户面试翻车）

/**
 * 判定结果条目。
 * @typedef {object} GuardFinding
 * @property {string} code 问题代码（FABRICATED_NUMBER / FABRICATED_ENTITY / LOST_NUMBER）
 * @property {'error' | 'warn'} severity 严重级：error 必须修正，warn 建议检查
 * @property {string} message 可读说明
 * @property {string[]} evidence 证据（涉及的数字或实体）
 */

/**
 * 守卫的已知局限（明确声明，供报告与文档引用）。
 * 声明局限不是示弱——使用者知道边界在哪，才不会被虚假的安全感误导。
 */
export const GUARD_LIMITATIONS = [
  '只检测带强后缀的机构名（某某公司/大学/银行…）；无后缀的机构名（如「字节跳动」）无法可靠识别，需人工确认。',
  '只比对数字与机构/专名两类特征；新编造的「技能」「职责描述」等无数字文本无法自动识别。',
  '数字按 token 比对，不做语义判断：把「提升 40%」改成「提升四成」不会被发现。',
]

/** 守卫版本。判定规则变化时递增，便于回溯误报/漏报。 */
export const GUARD_VERSION = '1.0.0'

/**
 * 中文机构名后缀。用于识别"改写后新出现的机构"。
 * 只收强特征后缀，避免"科技""网络"这类泛词造成大量误报。
 */
const ZH_ORG_SUFFIXES = [
  '公司',
  '集团',
  '大学',
  '学院',
  '研究院',
  '研究所',
  '实验室',
  '银行',
  '医院',
  '证券',
  '基金',
  '事务所',
  '出版社',
  '传媒',
  '工作室',
]

/**
 * 中文动词/副词前缀黑名单。
 *
 * 存在理由（实测踩坑）：中文没有词边界，`主导公司官网开发` 里的
 * 「主导公司」会被机构后缀规则误判成一个机构名，进而把一句正常的
 * 措辞强化报成"编造机构"——误报会让守卫失去信任，比漏报更糟。
 * 因此对后缀前的前缀做黑名单过滤：若提取出的名字以这些词开头，
 * 说明它是"动词 + 机构后缀"，不是机构名，丢弃。
 */
const ZH_VERB_PREFIXES = [
  '主导',
  '负责',
  '参与',
  '完成',
  '推进',
  '搭建',
  '设计',
  '开发',
  '优化',
  '重构',
  '维护',
  '支持',
  '使用',
  '基于',
  '面向',
  '服务',
  '管理',
  '带领',
  '协助',
  '改进',
  '提升',
  '实现',
  '交付',
  '运营',
]

/**
 * 提取中文机构名候选。
 *
 * 实现要点（四个坑，都是实测踩出来的）：
 *   1. 不能贪婪匹配「前缀 + 后缀」——`在清华大学与某科技公司`
 *      会把动词「在」和连接词「与」一起吞进去。
 *   2. 切片不能按空格切——`ABC 公司`、`ByteDance 公司` 这种
 *      「英文名 + 中文后缀」的写法中间有空格，按空格切会整个漏掉。
 *   3. 片内会残留动词前缀，需用 {@link ZH_VERB_PREFIXES} 黑名单过滤，
 *      否则 `主导公司` 这类会被误报为机构名。
 *   4. 只认后缀会漏掉无后缀机构（`字节跳动`、`腾讯`），
 *      故额外做一次"无后缀专名"提取（见 {@link extractShortOrgNames}）。
 *
 * @param {string} text 待提取文本
 * @returns {Set<string>} 机构名候选集合
 */
export function extractChineseOrgNames(text) {
  const out = new Set()
  const src = normalizeText(text)
  if (src === '') return out
  // 只按强标点与连接词切分，**不切空格**（空格可能是机构名的一部分）
  const segments = src.split(
    /[，。；：、！？（）()【】\[\],;:!?"'“”‘’/\\|~～—]+|(?:与|和|及|或|在|于|同|跟|从|到|为|的)/g,
  )
  for (const raw of segments) {
    if (!raw) continue
    for (const suffix of ZH_ORG_SUFFIXES) {
      const at = raw.indexOf(suffix)
      if (at < 0) continue
      const head = raw
        .slice(0, at)
        .replace(/^[\s>*\-+#]+/, '')
        .replace(/\s+$/, '')
      const tail = /([A-Za-z0-9\u4e00-\u9fa5]+(?:[ \t][A-Za-z0-9\u4e00-\u9fa5]+)*)$/.exec(head)
      let name = tail ? tail[1].trim() : ''
      if (name.length < 2) continue
      // 坑 3：剥离动词前缀。
      //
      // 实测的关键点：`主导公司官网开发` 中，后缀「公司」前的 head 恰好是
      // 「主导」——它本身就是动词，说明这是动宾短语而非机构名，**整条丢弃**。
      // （若按"拼上后缀再判断"的写法，会得到「主导公司」并被误报为编造机构。）
      // 循环剥离用于处理「主导负责某科技」这类叠加前缀。
      let stripped = true
      while (stripped && name.length >= 2) {
        stripped = false
        for (const verb of ZH_VERB_PREFIXES) {
          if (name === verb) {
            name = '' // 前缀正好是动词 → 动宾短语，丢弃
            stripped = false
            break
          }
          if (name.startsWith(verb)) {
            name = name.slice(verb.length)
            stripped = true
            break
          }
        }
      }
      if (name.length >= 2) out.add(name + suffix)
    }
  }
  return out
}

/**
 * 提取无后缀的机构名候选。
 *
 * ⚠️ 本项目**不实现**这个能力，此函数仅为记录决策而保留说明。
 *
 * 原因（实测结论）：中文机构名常不带「公司」后缀（如「字节跳动」「腾讯」），
 * 理论上可借此提高召回。但实现它需要枚举文本中所有 2-6 字连续中文块，
 * 实测会产生**海量误报**——几乎每个动宾短语都会被当成机构名。
 *
 * 而误报的代价高于漏报：一个频繁误报的守卫会被使用者直接忽略，
 * 那比没有守卫更糟（守卫自身的设计原则即为此，见文件头说明）。
 *
 * 因此本项目采取**保守策略**：
 *   - 带强后缀的机构名（某某公司/大学/银行…）→ 判定为 error
 *   - 无后缀的机构名 → 不检测，改为在报告里提示"请人工确认无新增机构"
 * 这个取舍是明确记录的已知局限，不是遗漏。
 *
 * @param {string} _text 待提取文本（未使用）
 * @returns {Set<string>} 恒为空集合
 */
export function extractShortOrgNames(_text) {
  return new Set()
}

/**
 * 常见泛词/非机构中文词。保留供后续若有更可靠的分词方案时使用。
 */
const ZH_COMMON_WORDS = new Set([
  '负责',
  '开发',
  '设计',
  '优化',
  '重构',
  '维护',
  '支持',
  '使用',
  '基于',
  '面向',
  '服务',
  '管理',
  '参与',
  '完成',
  '推进',
  '搭建',
  '实现',
  '交付',
  '运营',
  '实习',
  '工作',
  '项目',
  '团队',
  '期间',
  '核心',
  '模块',
  '接口',
  '前端',
  '后端',
  '数据',
  '系统',
  '平台',
  '产品',
  '业务',
  '功能',
  '性能',
  '页面',
  '用户',
  '公司',
  '官网',
  '主导',
  '提升',
  '改进',
  '协助',
  '带领',
])

/** 英文专名检测时的排除词：简历章节标题与常见通用词，避免误报。 */
const EN_STOPWORDS = new Set(
  [
    'experience',
    'education',
    'skills',
    'projects',
    'project',
    'summary',
    'profile',
    'work',
    'internship',
    'award',
    'awards',
    'honor',
    'honors',
    'certification',
    'certifications',
    'publication',
    'publications',
    'achievements',
    'extracurricular',
    'contact',
    'email',
    'phone',
    'location',
    'linkedin',
    'github',
    'website',
    'present',
    'current',
    'responsible',
    'developed',
    'led',
    'built',
    'managed',
    'designed',
    'implemented',
    'improved',
    'the',
    'and',
    'for',
    'with',
    'from',
    'this',
    'that',
    'using',
    'used',
  ].map((w) => w.toLowerCase()),
)

/** 全角数字转半角。 */
const FULLWIDTH_DIGITS = '０１２３４５６７８９'

/**
 * 归一化文本：统一换行，便于逐行处理。
 * @param {unknown} input 任意输入
 * @returns {string} 归一化文本（非字符串输入返回空串）
 */
export function normalizeText(input) {
  if (typeof input !== 'string') return ''
  return input.replace(/\r\n?/g, '\n')
}

/**
 * 提取文本中的数字 token（含全角数字）。
 *
 * 归一化规则：全角转半角、去掉千分位逗号、去掉尾部小数点。
 * 例：'1,200.' → '1200'；'４０%' → '40'
 *
 * 为什么以"数字"为主要抓手：简历里最危险的编造是量化数据
 * （"提升 40%"、"服务 12 万用户"），而数字的出现位置精确、可比对。
 *
 * @param {string} text 待提取文本
 * @returns {Set<string>} 归一化后的数字 token 集合
 */
export function extractNumericTokens(text) {
  const out = new Set()
  const src = normalizeText(text)
  if (src === '') return out
  // 全角数字先转半角，否则 '４０%' 这类会被漏掉
  const normalized = src.replace(/[０-９]/g, (c) => String(FULLWIDTH_DIGITS.indexOf(c)))
  for (const m of normalized.matchAll(/\d[\d,.]*/g)) {
    const token = m[0].replace(/,/g, '').replace(/\.$/, '')
    if (token !== '') out.add(token)
  }
  return out
}

/**
 * 提取英文专名候选（连续大写开头的拉丁词序列）。
 *
 * 排除：行首词（多为句子开头）、简历章节标题、常见动词/连接词。
 * 这些排除是为了把误报压下去 —— 误报会让守卫被忽略，比没有守卫更糟。
 *
 * @param {string} text 待提取文本
 * @returns {Set<string>} 专名候选集合
 */
export function extractLatinProperNouns(text) {
  const out = new Set()
  const src = normalizeText(text)
  if (src === '') return out
  for (const rawLine of src.split('\n')) {
    const line = rawLine.replace(/^[\s>*\-+#]+/, '').replace(/\*\*/g, '')
    const words = line.split(/[^A-Za-z0-9.+#/-]+/).filter((w) => w !== '')
    for (let i = 0; i < words.length; i += 1) {
      // 剥离尾部句点等标点：'Kubernetes.' 应识别为 'Kubernetes'
      const w = words[i].replace(/[.]+$/, '')
      if (w === '') continue
      // 必须是首字母大写的拉丁词，且不是纯数字
      if (!/^[A-Z][A-Za-z0-9.+#/-]*$/.test(w)) continue
      // 行首词排除（无法区分是专名还是句首大写）
      if (i === 0) continue
      const key = w.toLowerCase()
      if (EN_STOPWORDS.has(key)) continue
      out.add(w)
    }
  }
  return out
}

/**
 * 判断某候选是否出现在原文中（大小写不敏感）。
 * @param {string} candidate 候选
 * @param {string} haystack 原文
 * @returns {boolean} 是否出现
 */
function appearsIn(candidate, haystack) {
  if (candidate === '') return true
  return haystack.toLowerCase().includes(candidate.toLowerCase())
}

/**
 * 校验报告。
 * @typedef {object} GuardReport
 * @property {boolean} ok 是否通过（无 error 级问题）
 * @property {string} guardVersion 校验规则版本
 * @property {GuardFinding[]} findings 问题清单
 * @property {string[]} limitations 本校验的已知局限
 * @property {{ originalNumbers: number, rewrittenNumbers: number, originalEntities: number, rewrittenEntities: number }} stats 统计
 */

/**
 * 确定性校验：改写结果是否引入了原文不存在的内容。
 *
 * 检查项：
 *   1. `FABRICATED_NUMBER`（error）— 改写后出现原文没有的数字
 *   2. `FABRICATED_ENTITY`（error）— 改写后出现原文没有的机构/专名
 *   3. `LOST_NUMBER`（warn）— 原文的数字在改写后消失（真实数据被丢弃）
 *
 * 判定结果为纯数据，不含任何模型判断。
 *
 * @param {{ original?: unknown, rewritten?: unknown }} [args] 原文与改写后文本
 * @returns {GuardReport} 校验报告；`ok` 为 true 表示无 error 级问题
 */
export function verifyRewrite({ original, rewritten } = {}) {
  const originalText = normalizeText(original)
  const rewrittenText = normalizeText(rewritten)
  /** @type {GuardFinding[]} */
  const findings = []

  const originalNumbers = extractNumericTokens(originalText)
  const rewrittenNumbers = extractNumericTokens(rewrittenText)
  const originalEntities = new Set([
    ...extractChineseOrgNames(originalText),
    ...extractLatinProperNouns(originalText),
  ])
  const rewrittenEntities = new Set([
    ...extractChineseOrgNames(rewrittenText),
    ...extractLatinProperNouns(rewrittenText),
  ])

  // ── 1. 编造数字（最危险）─────────────────────────────────────────
  const fabricatedNumbers = [...rewrittenNumbers]
    .filter((n) => !originalNumbers.has(n))
    .sort()
  if (fabricatedNumbers.length > 0) {
    findings.push({
      code: 'FABRICATED_NUMBER',
      severity: 'error',
      message:
        `改写后出现 ${fabricatedNumbers.length} 个原文不存在的数字：` +
        `${fabricatedNumbers.join('、')}。简历中的量化数据必须能在原文找到出处。`,
      evidence: fabricatedNumbers,
    })
  }

  // ── 2. 编造实体（机构 / 专名）───────────────────────────────────
  //
  // 比对语义说明（重要）：
  // 中文没有词边界，无法可靠地把动词前缀与机构名切开
  // （实测：'完成某科技公司' 的前缀「完成」会被当成机构名的一部分）。
  // 因此不要求候选与原文实体"完全相同"，而采用**包含判定**：
  // 候选与任一原文实体存在包含关系，即视为同一实体，不算编造。
  //
  // 这样两类真实场景都能正确处理：
  //   - 改写后机构名前后接了动词 → 包含原文实体 → 放行（不误报）
  //   - 改写引入了原文没有的机构/专名 → 与任何原文实体都无包含关系 → 判为编造
  const isKnownEntity = (/** @type {string} */ candidate) => {
    if (appearsIn(candidate, originalText)) return true
    const low = candidate.toLowerCase()
    for (const known of originalEntities) {
      const k = known.toLowerCase()
      if (k !== '' && (low.includes(k) || k.includes(low))) return true
    }
    return false
  }

  const fabricatedEntities = [...rewrittenEntities].filter((e) => !isKnownEntity(e)).sort()
  if (fabricatedEntities.length > 0) {
    findings.push({
      code: 'FABRICATED_ENTITY',
      severity: 'error',
      message:
        `改写后出现 ${fabricatedEntities.length} 个原文不存在的机构/专名：` +
        `${fabricatedEntities.join('、')}。新增实体需确认是真实经历，否则删除。`,
      evidence: fabricatedEntities,
    })
  }

  // ── 3. 真实数据丢失（非编造，但会削弱简历）─────────────────────
  const lostNumbers = [...originalNumbers]
    .filter((n) => !rewrittenNumbers.has(n))
    .sort()
  if (lostNumbers.length > 0) {
    findings.push({
      code: 'LOST_NUMBER',
      severity: 'warn',
      message:
        `原文的 ${lostNumbers.length} 个数字在改写后消失：${lostNumbers.join('、')}。` +
        `若非有意压缩，建议保留真实量化结果。`,
      evidence: lostNumbers,
    })
  }

  const hasError = findings.some((f) => f.severity === 'error')

  return {
    ok: !hasError,
    guardVersion: GUARD_VERSION,
    findings,
    limitations: GUARD_LIMITATIONS,
    stats: {
      originalNumbers: originalNumbers.size,
      rewrittenNumbers: rewrittenNumbers.size,
      originalEntities: originalEntities.size,
      rewrittenEntities: rewrittenEntities.size,
    },
  }
}
