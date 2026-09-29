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
  '数字按 token 比对，不做语义判断：把「提升 40%」改成「提升四成」不会被发现。',
  '职责升格检测基于中文动词词表，措辞避开词表的同义升格（如「深度参与」→「全权负责」以外的变体）可能漏检。',
  '整条新增检测按字级相似度判定（阈值校准为 0.25）：与原文任何条目都无重合的内容会被报出；但"把原有经历改写得面目全非"可能被误报为新增，需人工确认。',
  '本校验只做文本特征比对，不判断内容是否真实。它拦得住"与原文对不上"的编造，拦不住"原文本身就写了假的"。',
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

/**
 * 提取时间点 token（年份、年月）。
 *
 * 用途：起止日期属于"绝不可改写"的事实字段。改写若动了年份，
 * 会与背调信息不符——这类错误比编数字更冤枉（数字可能是表述问题，
 * 日期错了就是硬伤）。
 *
 * 提取形态：
 *   - 四位年份：2019、2024
 *   - 年月：2019.06、2019-06、2019年6月
 *
 * @param {string} text 待提取文本
 * @returns {Set<string>} 归一化时间点集合（统一为 `YYYY` 或 `YYYY-MM`）
 */
export function extractDateTokens(text) {
  const out = new Set()
  const src = normalizeText(text)
  if (src === '') return out

  // 先处理"年月"形态，避免被下面的裸年份规则重复计入
  const consumed = []
  const ymPatterns = [
    /(\d{4})\s*[年.\-/]\s*(\d{1,2})\s*月?/g, // 2019年6月 / 2019.06 / 2019-6
  ]
  let masked = src
  for (const re of ymPatterns) {
    for (const m of masked.matchAll(re)) {
      const year = m[1]
      const month = String(Number(m[2])).padStart(2, '0')
      const token = `${year}-${month}`
      out.add(token)
      consumed.push(m[0])
    }
  }
  // 把已消费的年月片段替换掉，避免裸年份规则再抓一次
  for (const frag of consumed) {
    masked = masked.replace(frag, ' ')
  }

  // 裸年份（合理范围，避免把金额/百分比误当年份）
  for (const m of masked.matchAll(/\b(19|20)\d{2}\b/g)) {
    out.add(m[0])
  }
  return out
}

/**
 * 回验"声称覆盖的关键词"是否真的出现在改写结果里。
 *
 * 【为什么需要】
 * 改写流程中，模型可能自报"JD 要求的关键词我都对齐了"。
 * 这是模型的自述，不是事实——它可能虚报，或记错了自己写了什么。
 * 若不加回验，用户会拿到一份"看起来覆盖了关键词、实际没有"的简历，
 * 在 ATS 筛选阶段被静默淘汰，且无从发现。
 *
 * 同类项目中有一个（`NI3singh/AI-Resume-Updater`）做了这件事：
 * 把模型自报的 covered_keywords 拿去最终文本里逐一查找，查不到就不计入。
 * 本项目独立实现同样的思路。
 *
 * @param {string} rewritten 改写后的文本（最终产出）
 * @param {string[]} claimedKeywords 模型声称已覆盖的关键词
 * @returns {{ verified: string[], unverified: string[] }}
 *   `verified` 为确实出现的词；`unverified` 为声称了但查无实据的词
 */
export function verifyKeywordCoverage(rewritten, claimedKeywords) {
  const text = normalizeText(rewritten).toLowerCase()
  const verified = []
  const unverified = []
  for (const raw of Array.isArray(claimedKeywords) ? claimedKeywords : []) {
    const keyword = String(raw ?? '').trim()
    if (keyword === '') continue
    if (text.includes(keyword.toLowerCase())) {
      verified.push(keyword)
    } else {
      unverified.push(keyword)
    }
  }
  return { verified, unverified }
}

/**
 * 把文本切分为"内容单元"（bullet 行 / 短段落）。
 *
 * 用途：逐条比对改写结果与原文，发现**整条新增**的内容。
 *
 * 为什么需要（这是本项目此前明确的局限）：
 * 数字与机构名比对只能抓住"往已有经历里塞假数据"，
 * 抓不住"凭空多出一条没做过的经历"。而后者是更严重的造假——
 * 面试官照着简历问"这个项目你负责哪部分"，候选人答不上来即穿。
 *
 * 切分规则：按行切，去掉 Markdown 标记与列表符号；
 * 过短的行（标题、姓名等）不参与比对，避免误判。
 *
 * @param {string} text 待切分文本
 * @returns {string[]} 内容单元（已去标记、去空白，保留原始可读文本）
 */
export function extractContentUnits(text) {
  const src = normalizeText(text)
  if (src === '') return []
  const units = []
  for (const rawLine of src.split('\n')) {
    // 去掉标题标记与列表符号，保留正文
    const line = rawLine
      .replace(/^\s*#{1,6}\s*/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/\*\*/g, '')
      .trim()
    if (line === '') continue
    // 过短的行多为标题/姓名（"张三"、"教育背景"、"技能"），不参与比对。
    //
    // 阈值取 8（实测校准）：初版取 12，结果把「参与了登录模块的重构。」
    // 这类 11 字的正常经历行也过滤掉了，使对应的改写行被判为"凭空新增"——
    // 属误报。简历中的经历行通常远超 8 字，而标题/姓名通常短于 8 字，
    // 8 是能把两类分开的位置。
    if (line.length < 8) continue
    units.push(line)
  }
  return units
}

/**
 * 归一化用于相似度比对的文本：去掉所有空白与标点，只留字词。
 *
 * 为什么不用 `\p{P}`：Unicode 属性类需要正则 `u` 标志才生效，
 * 本项目已因此踩过一次静默失效的坑（见发布审计的同类问题），
 * 故此处显式列出标点区间。
 *
 * @param {string} s 待归一化文本
 * @returns {string} 归一化结果
 */
function normalizeForSimilarity(s) {
  return String(s)
    .replace(/[\s\u3000]+/g, '')
    .replace(
      /[，。；：、！？（）()【】\[\]{}<>,.;:!?"'“”‘’`~～—\-_/\\|*#@$%^&+=]+/g,
      '',
    )
}

/**
 * 生成字符二元组集合（中文无词边界，用字级 bigram 更稳）。
 * @param {string} s 已归一化的文本
 * @returns {Set<string>} 二元组集合
 */
function charBigrams(s) {
  const out = new Set()
  if (s.length === 1) {
    out.add(s)
    return out
  }
  for (let i = 0; i + 1 < s.length; i += 1) {
    out.add(s.slice(i, i + 2))
  }
  return out
}

/**
 * 计算两个单元的重合度（包含式相似度）。
 *
 * 用「交集 / 较短者」而非 Jaccard：改写常伴随扩写，
 * 短文本被长文本包含时仍应判为同一件事，Jaccard 会因长度差而低估。
 *
 * @param {Set<string>} a 单元 A 的二元组
 * @param {Set<string>} b 单元 B 的二元组
 * @returns {number} 0-1 之间的相似度
 */
function containment(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const g of small) {
    if (big.has(g)) inter += 1
  }
  return inter / small.size
}

/**
 * 相似度阈值：低于此值视为"与原文任何一条都无关"。
 *
 * 校准依据（用真实简历改写样本反复测试）：
 * - 0.35：能抓住"整条新增"，但对"同一件事彻底换说法"偶有误报
 * - 0.25：误报显著减少，仍能抓住凭空新增的经历条目
 * 取 0.25 —— 宁可漏掉极少数极限改写，也不制造误报
 * （误报会让守卫被忽略，比漏报更糟；这条原则已写入文件头）。
 */
const NOVEL_UNIT_THRESHOLD = 0.25

/**
 * 检测改写结果中"与原文任何一条都对不上"的内容单元。
 *
 * @param {string} original 原文
 * @param {string} rewritten 改写后文本
 * @param {number} [threshold] 相似度阈值，默认 {@link NOVEL_UNIT_THRESHOLD}
 * @returns {{ novel: string[], unitCount: number }} 疑似整条新增的单元
 */
export function detectNovelUnits(original, rewritten, threshold = NOVEL_UNIT_THRESHOLD) {
  const originalUnits = extractContentUnits(original)
  const rewrittenUnits = extractContentUnits(rewritten)
  if (originalUnits.length === 0 || rewrittenUnits.length === 0) {
    return { novel: [], unitCount: rewrittenUnits.length }
  }
  const originalBigrams = originalUnits.map((u) => charBigrams(normalizeForSimilarity(u)))
  const novel = []
  for (const unit of rewrittenUnits) {
    const grams = charBigrams(normalizeForSimilarity(unit))
    let best = 0
    for (const og of originalBigrams) {
      const score = containment(grams, og)
      if (score > best) best = score
      if (best >= threshold) break
    }
    if (best < threshold) novel.push(unit)
  }
  return { novel, unitCount: rewrittenUnits.length }
}

/** 全角数字转半角。 */
const FULLWIDTH_DIGITS = '０１２３４５６７８９'

/**
 * 职责强度阶梯。
 *
 * 【为什么做这件事】
 * 简历造假最常见、也最隐蔽的形态不是编数字，而是**悄悄升格职责**：
 * 「参与」→「主导」、「协助」→「负责」、「了解」→「精通」。
 * 数字编造容易被追问（"这 40% 怎么算的"），而职责升格往往能蒙混过关，
 * 直到面试官让候选人讲"你是怎么主导的"才露馅——对用户是更致命的伤害。
 *
 * 同类项目在文档里写了这条纪律（"防止 contributed to 悄悄变成 built"），
 * 但只作为给模型的提示词要求。本项目把它做成**确定性代码检查**：
 * 逐级比对原文与改写用的职责动词，升格即报告。
 *
 * 分级依据：对工作成果的**所有权强度**，而非修辞强弱。
 */
const RESPONSIBILITY_LEVELS = [
  { level: 1, label: '认知层', words: ['了解', '熟悉', '接触', '学习', '入门'] },
  { level: 2, label: '辅助层', words: ['参与', '协助', '配合', '支持', '跟随'] },
  { level: 3, label: '负责层', words: ['负责', '承担', '完成', '执行', '独立开发'] },
  { level: 4, label: '主导层', words: ['主导', '牵头', '独立完成', '主持', '主责'] },
  { level: 5, label: '决策层', words: ['统筹', '决策', '拍板', '制定战略', '定方向'] },
]

/**
 * 提取文本中的职责强度证据。
 *
 * ⚠️ 关键设计（实测教训）：
 * 早期实现取「全文最高层级」比对，会产生漏报——
 * `协助完成接口对接` 同时含「协助」（辅助层）与「完成」（负责层），
 * 全文最高层被抬到 3；而 `负责接口对接` 也是 3，于是"协助→负责"
 * 的升格被判为无变化。
 *
 * 正确做法：**取全文最低层级作为基准**。
 * 因为简历描述一件事时，最低强度的动词才代表真实参与程度
 * （"协助完成"的真实含义是"协助"，"完成"只是补语）。
 * 改写若把最低层抬高了，就是职责升格。
 *
 * @param {string} text 待分析文本
 * @returns {{ minLevel: number, maxLevel: number, hits: Array<{ level: number, label: string, word: string }> }}
 *   最弱/最强层级与全部命中词
 */
export function extractResponsibilityLevel(text) {
  const src = normalizeText(text)
  /** @type {Array<{ level: number, label: string, word: string }>} */
  const hits = []
  if (src === '') return { minLevel: 0, maxLevel: 0, hits }
  for (const tier of RESPONSIBILITY_LEVELS) {
    for (const word of tier.words) {
      if (src.includes(word)) {
        hits.push({ level: tier.level, label: tier.label, word })
      }
    }
  }
  if (hits.length === 0) return { minLevel: 0, maxLevel: 0, hits }
  const levels = hits.map((h) => h.level)
  return {
    minLevel: Math.min(...levels),
    maxLevel: Math.max(...levels),
    hits,
  }
}

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
 * ⚠️ 调用方注意：本函数会**把日期也当成数字**（`2019.06`）。
 * 日期有专门的检查项（{@link extractDateTokens}），因此
 * `verifyRewrite` 在比对数字时会先剔除日期 token，避免同一问题被报两次。
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
 * 从数字 token 集合中剔除日期成分。
 *
 * 存在理由（实测）：`2019年6月` 改写成 `2019.06` 时，
 * 数字检查会把 `2019.06` 当成"新出现的数字"而误报。
 * 日期本该由专门的日期检查负责，数字检查必须让路。
 *
 * 剔除规则：
 *   - 形如 `YYYY.MM` / `YYYY.MM.DD` 的复合 token
 *   - 与任一日期 token 的年份部分相同的纯年份 token（如 `2019`）
 *
 * @param {Set<string>} numbers 数字 token 集合
 * @param {Set<string>} dates 日期 token 集合（形如 `YYYY-MM` 或 `YYYY`）
 * @returns {Set<string>} 剔除日期后的数字集合
 */
export function subtractDateTokens(numbers, dates) {
  const out = new Set()
  const dateYears = new Set([...dates].map((d) => d.slice(0, 4)))
  for (const n of numbers) {
    // 复合日期 token（2019.06 / 2019.06.01）
    if (/^(19|20)\d{2}\.\d{1,2}(\.\d{1,2})?$/.test(n)) continue
    // 与已知日期同年的裸年份
    if (/^(19|20)\d{2}$/.test(n) && dateYears.has(n)) continue
    out.add(n)
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
 * @property {{ verified: string[], unverified: string[] } | null} coverage
 *   关键词覆盖回验结果；未提供自报关键词时为 null
 * @property {{ originalNumbers: number, rewrittenNumbers: number, originalEntities: number, rewrittenEntities: number }} stats 统计
 */

/**
 * 确定性校验：改写结果是否引入了原文不存在的内容。
 *
 * 检查项：
 *   1. `FABRICATED_NUMBER`（error）— 改写后出现原文没有的数字
 *   2. `FABRICATED_ENTITY`（error）— 改写后出现原文没有的机构/专名
 *   3. `RESPONSIBILITY_INFLATED`（error）— 职责强度被升格
 *   4. `FABRICATED_DATE`（error）— 时间点被改动
 *   5. `LOST_NUMBER`（warn）— 原文的数字在改写后消失
 *   6. `UNVERIFIED_KEYWORD_CLAIM`（error）— 自报覆盖的关键词实际未出现
 *
 * 判定结果为纯数据，不含任何模型判断。
 *
 * @param {{ original?: unknown, rewritten?: unknown, claimedKeywords?: string[] }} [args]
 *   原文、改写后文本，以及可选的"模型自报已覆盖的关键词"
 * @returns {GuardReport} 校验报告；`ok` 为 true 表示无 error 级问题
 */
export function verifyRewrite({ original, rewritten, claimedKeywords } = {}) {
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
  //
  // 先剔除日期成分：年份与日期有专门检查（第 4 项），
  // 若在此重复报出，同一问题会出现两条，稀释报告可用性。
  const originalDates = extractDateTokens(originalText)
  const rewrittenDates = extractDateTokens(rewrittenText)
  const originalNumbersOnly = subtractDateTokens(originalNumbers, originalDates)
  const rewrittenNumbersOnly = subtractDateTokens(rewrittenNumbers, rewrittenDates)

  const fabricatedNumbers = [...rewrittenNumbersOnly]
    .filter((n) => !originalNumbersOnly.has(n))
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

  // ── 3. 职责升格（比编数字更隐蔽的造假）─────────────────────────
  //
  // 逐条比对职责动词强度。改写若把「参与」升格为「主导」，
  // 属于事实性夸大——面试官追问"你怎么主导的"时会立刻暴露。
  //
  // 【判据的设计（两轮实测才定对）】
  // 简历里有两类升格，必须分别用两个方向去抓：
  //
  //   类型 A「弱表述被抬高」：原文「协助完成接口」→ 改写「负责接口」。
  //     minLevel 从 2 升到 3。若只看 maxLevel 会漏报
  //     （原文 max=3 因含"完成"，改写 max 也是 3）。
  //
  //   类型 B「新增更强主张」：原文「负责开发」→ 改写「主导开发」。
  //     maxLevel 从 3 升到 4。若只看 minLevel 会漏报
  //     （两边 min 都是 3）。
  //
  // 因此判据是 **minLevel 或 maxLevel 任一上升即报**。
  // 但这会让"原文无任何职责动词、改写用『负责』规整表述"被误报，
  // 故对原文 level 为 0 的情况设门槛：改写须达到主导层（4）才报。
  const originalResp = extractResponsibilityLevel(originalText)
  const rewrittenResp = extractResponsibilityLevel(rewrittenText)
  const LEADERSHIP_LEVEL = 4
  const isInflation =
    originalResp.maxLevel === 0
      ? rewrittenResp.maxLevel >= LEADERSHIP_LEVEL
      : rewrittenResp.minLevel > originalResp.minLevel ||
        rewrittenResp.maxLevel > originalResp.maxLevel

  if (isInflation) {
    const from = RESPONSIBILITY_LEVELS.find((t) => t.level === originalResp.maxLevel)
    const to = RESPONSIBILITY_LEVELS.find((t) => t.level === rewrittenResp.maxLevel)
    const originalWeakest = originalResp.hits
      .filter((h) => h.level === originalResp.minLevel)
      .map((h) => h.word)
    const rewrittenWeakest = rewrittenResp.hits
      .filter((h) => h.level === rewrittenResp.minLevel)
      .map((h) => h.word)
    findings.push({
      code: 'RESPONSIBILITY_INFLATED',
      severity: 'error',
      message:
        (originalResp.maxLevel === 0
          ? `原文未主张任何职责强度，改写后却出现「${to?.label ?? '未知'}」表述` +
            `（${rewrittenWeakest.join('、')}）。`
          : `职责描述被升格：原文最强为「${from?.label ?? '未知'}」` +
            `（最弱为「${originalWeakest.join('、')}」），改写后最强为` +
            `「${to?.label ?? '未知'}」（最弱为「${rewrittenWeakest.join('、')}」）。`) +
        '职责强度必须与原文一致，不得把"协助"写成"负责"或把"参与"写成"主导"。',
      evidence: rewrittenWeakest,
    })
  }

  // ── 4. 时间线一致性（日期被改动即事实错误）─────────────────────
  //
  // 起止日期属于"绝不可改写"的事实字段。改写若动了年份/月份，
  // 会导致与背调信息不符。
  if (originalDates.size > 0) {
    const originalYears = new Set([...originalDates].map((d) => d.slice(0, 4)))
    const changedDates = [...rewrittenDates].filter((d) => {
      if (originalDates.has(d)) return false
      // 原文只写了年份、改写补了同一年月份 → 不算改动
      const year = d.slice(0, 4)
      return !originalYears.has(year)
    })
    if (changedDates.length > 0) {
      findings.push({
        code: 'FABRICATED_DATE',
        severity: 'error',
        message:
          `改写后出现原文没有的时间点：${changedDates.join('、')}。` +
          '起止日期属于事实字段，不得改动。',
        evidence: changedDates,
      })
    }
  }

  // ── 5. 真实数据丢失（非编造，但会削弱简历）─────────────────────
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

  // ── 6. 关键词覆盖回验（可选的模型自报项）───────────────────────
  //
  // 模型可能自报"JD 关键词都已对齐"。这是自述而非事实，
  // 必须拿去最终文本里查证；查不到就不予采信，
  // 否则用户会拿到"声称覆盖、实际没有"的简历，在 ATS 阶段被静默淘汰。
  const coverage =
    claimedKeywords === undefined
      ? null
      : verifyKeywordCoverage(rewrittenText, claimedKeywords)
  if (coverage && coverage.unverified.length > 0) {
    findings.push({
      code: 'UNVERIFIED_KEYWORD_CLAIM',
      severity: 'error',
      message:
        `声称已覆盖但实际未出现在简历中的关键词：${coverage.unverified.join('、')}。` +
        '关键词对齐必须以真实出现为准；这些词要么写进对应经历，要么移入待补充清单。',
      evidence: coverage.unverified,
    })
  }

  // ── 7. 整条新增（凭空多出一条没做过的经历）─────────────────────
  //
  // 前六项检查都依赖"数字/机构/动词/日期"等特征。
  // 若模型凭空加一条不含这些特征的经历（"负责用户增长，主导社群运营"），
  // 特征比对抓不住——而这是更严重的造假：面试官照着问就会穿。
  // 因此这里做逐条内容比对：与原文任何一条都对不上的，报为疑似新增。
  const novelCheck = detectNovelUnits(originalText, rewrittenText)
  if (novelCheck.novel.length > 0) {
    const preview = novelCheck.novel
      .slice(0, 3)
      .map((u) => (u.length > 40 ? `${u.slice(0, 40)}…` : u))
    findings.push({
      code: 'NOVEL_CONTENT',
      severity: 'error',
      message:
        `发现 ${novelCheck.novel.length} 条与原文任何内容都对不上的表述，疑似凭空新增：\n  ` +
        preview.join('\n  ') +
        '\n每一条改写都必须能追溯到原文的某条经历；新增内容需确认真实，否则删除。',
      evidence: novelCheck.novel,
    })
  }

  const hasError = findings.some((f) => f.severity === 'error')

  return {
    ok: !hasError,
    guardVersion: GUARD_VERSION,
    findings,
    limitations: GUARD_LIMITATIONS,
    coverage,
    stats: {
      originalNumbers: originalNumbers.size,
      rewrittenNumbers: rewrittenNumbers.size,
      originalEntities: originalEntities.size,
      rewrittenEntities: rewrittenEntities.size,
    },
  }
}
