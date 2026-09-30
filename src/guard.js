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
  '只检测带强后缀的机构名（某某公司/大学/银行…）与拉丁专名；无后缀的机构名（如「字节跳动」）无法可靠识别，需人工确认。',
  '数字按 token 比对，不做语义判断：把「提升 40%」改成「提升四成」不会被发现。',
  '职责升格按「改写单元 ↔ 原文单元」配对逐对比较，且基于中文动词词表：措辞避开词表的同义升格（如「深度参与」→「全权负责」以外的变体）可能漏检。与原文任何单元都配不上的改写行不参与这一项（整条新增由第 7 项负责，仅当它同时主张了主导层职责时才补充报出）。',
  '整条新增检测按字级相似度判定（阈值校准为 0.25）：与原文任何条目都无重合的内容会被报出；但"把原有经历改写得面目全非"可能被误报为新增，需人工确认。',
  '逐条比对只覆盖长度 ≥ 8 字的内容单元，标题与姓名等短行不参与（短行相似度噪声大，会制造误报）。',
  '拉丁专名的识别依赖"行内位置 + 大小写 + 该行是否含汉字"三者：英文句子的行首词与全小写词不识别（无法与句首大写、普通英文词区分）；纯拉丁的**技术名列表行**（`HTML / CSS / JavaScript`）行首词会被识别；中文行里的全小写技术名（redis / mysql / kafka）可以识别，并用一份常见英文词表过滤误报。词表之外的普通英文词（如混合写法里的 review、mock）可能被误报，需人工确认。',
  '拉丁专名按 **token 边界**精确比对（大小写不敏感），不做裸子串包含；中文机构名因无词边界仍用包含判定。',
  '**新出现的技术名/机构名按结构性判据分级**（不靠枚举名单——"中文术语↔英文缩写"是开放集合，枚举必然滞后）：原有实体在改写后**消失**（`Vue2 → React`、`某互联网公司 → 字节跳动公司`）判"必须修正"；处于**括号/斜杠并列注记位**（`超文本传输协议（HTTP）`）判"建议检查"（ATS 关键词对齐的常规动作）；中文字数**显著增长**、用**连接词并进列表**（`使用 Vue2 与 Kotlin`）、出现在**无法对齐的短行**里、或原文该句本就无中文却多出技术名，均判"必须修正"。残留边界：若模型把编造写得与原文几乎同长且不加连接词、不替换任何原有词，则只能降级为"建议检查"——这类在纯文本层面确实无法与等价写法区分。',
  '把已有技术名"截断换名"（`JavaScript` → `Java`、`PostgreSQL` → `Postgres`）会被抓住；但若截断结果恰好落在普通英文词表内（如 `TypeScript` → `Script`），只降级为"建议检查"——把 `script` 这类词移出词表会误伤"自动化脚本"等正常写法，代价不划算。',
  '**原文技术名消失且无其它技术名接替**（`CSS` → `层叠样式表`、或直接删掉 `CSS`）报"建议检查"而非"必须修正"——因为这类改动**没有凭空增加主张**（只是换成中文表述或精简），与编造性质不同；判 error 会拦下合法改写造成死锁。但它**不会被静默放过**（这一点曾是实现缺陷：早期该路径完全无告警）。"消失"按**全文**判定，故折行/拆分/跨行搬移不会误报。',
  '容量单位的大小写变化（`2MB` ↔ `2Mb`）报"建议检查"：`b` 与 `B` 分别是比特与字节、相差 8 倍，而 `KB/kb`、`MB/mb` 是同一含义的常见混写——纯文本无法判定作者本意，故只提示不阻断。',
  '**新增技能按结构判据分级**：处于括号/斜杠注记位的英文（`超文本传输协议（HTTP）`）与"中文换缩写"的收缩写法（`熟悉超文本传输协议；` → `熟悉 HTTP；`）判"建议检查"；而"原文有一条中文显著更多的句子**仍原封不动地保留着**、本行却多出原文全篇都没有的技术名"判"必须修正"（即凭空多加一项技能）。**代价**：在原文句保留的前提下**另起一行**只写缩写（`- 熟悉 HTTP；`）也会被判"必须修正"——因为该写法与编造技能（`- 熟悉 Redis；`）在文本上无法区分。此时请把缩写并入原句（`- 熟悉超文本传输协议（HTTP）…`），那是被放行的。',
  '**多词英文注记只认"全大写缩写 + 其展开"**：`JVM（Java Virtual Machine）`、`GPA（Grade Point Average）`、`HTTP（HyperText Transfer Protocol）` 会被放行（判"建议检查"）——它们只是把**已有缩写**写成全称，没有新增技能主张。而 `Java（Just Another Vague Abbreviation）`、`数据库（Redis Cluster）` 会被拦：前者括号前是**普通单词而非缩写**（`Java` 带小写字母），后者括号内是**原文没有的技能**。**代价（已知误报）**：括号前是**中文**时无法做这种校验（中文没有首字母），因此 `超文本传输协议（HyperText Transfer Protocol）` 与 `## 专业技能（Skills）` 这类"中文术语 + 英文全称/对照"会被拦下。**建议写法**：用缩写形式 `超文本传输协议（HTTP）`（被放行），或干脆不加英文对照。此处刻意选择"宁可误拦、不放行编造"——因为同形的 `## 项目经历（用户增长系统）` 是典型的编造，纯文本无法区分二者。',
  '本校验只做文本特征比对，不判断内容是否真实。它拦得住"与原文对不上"的编造，拦不住"原文本身就写了假的"。',
]

/** 守卫版本。判定规则变化时递增，便于回溯误报/漏报。 */
// 1.2.0：本轮判定规则发生多处实质变更，必须递增以便回溯——
//   · 专名识别：按"是否含汉字"分流（原来只认首字母大写 → 真实中文简历上近乎空转）
//   · 实体比对：token 边界精确匹配（原来用裸子串 → 截断换名漏报）
//   · 编造实体：改结构性判据（原来靠枚举名单 → 20 个 ATS 动作被误拒 13 个）
//   · 新增技能：按"下降量 + 原句是否被别处保留"判定（四次修正后的收敛形态）
//   · 技术名消失：按配对组判定，且新增 VANISHED_TECH_TERM（原来完全静默）
//   · 容量单位大小写：新增 UNIT_CASE_CHANGED（原来完全静默）
//   · 职责升格：下推到内容单元级（原来按全文 min/max，双向都错）
//   · 自证清白：拆为 equal/contains 两档并分别处理（原来会误伤合法改写）
export const GUARD_VERSION = '1.2.0'

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
 *   4. 只认后缀会漏掉无后缀机构（`字节跳动`、`腾讯`）。
 *      **本项目不做无后缀专名提取**——实测会产生海量误报（见下方说明），
 *      该局限已写入 {@link GUARD_LIMITATIONS}，由用户人工确认。
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
      // ⚠️ 名字里**不得含数字**——否则日期会粘进机构名（实测抓出的假告警）：
      //   `- 2022.09 - 2026.06 某大学；` → 提取到 `06 某大学`
      //   `- 2022年9月 - 2026年6月 某大学；` → 提取到 `2026年6月 某大学`
      // 于是日期格式规范化（`2022.09` → `2022年9月`）会连带改变这个"机构名"，
      // 被判为 **`技术名被替换：06 某大学 → 2026年6月 某大学`** 并**拒绝导出**。
      // 而 `某大学` 前后都在、`06` 只是日期残片——报文与事实不符（假告警），
      // 且它是**日期区间**这一常见写法特有的（单日期不会触发，故既有用例未覆盖）。
      // 机构名不含数字是安全的假设：中文机构名里出现数字极罕见。
      if (/\d/.test(name)) continue
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
 */

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
    // 【补齐常见"简历栏目名"（真实简历实测抓出的分类不一致）】
    // 词表里原本有 `skills`/`education`/`projects`/`internship`/`awards`，
    // 却漏了下面这些**同样常见且同为纯栏目名**的词。后果是分类不一致：
    //   `## 专业技能（Skills）` 放行，而 `## 校园经历（Campus）` **拒绝导出**。
    // 实测 11 个常见栏目名被误判为"专有技术名"（error 级），
    // 每个都会阻断交付——属"用户拿不到文件"的死锁。
    // 这些词都是**普通英文名词**，不含任何技术栈主张，
    // 归入通用词表（warn 级）与 `skills` 等既有条目保持一致。
    'objective',
    'campus',
    'volunteer',
    'activities',
    'activity',
    'interests',
    'languages',
    'coursework',
    'overview',
    'background',
    'qualification',
    'qualifications',
    'accomplishments',
    // 【计量单位不是技术名（实测抓出的死锁）】
    // `2GB` 与 `2 GB` 是同一数值的两种写法（中间加空格纯属排版），
    // 但加空格后 `GB` 变成**独立 token**，于是被当成"新增的技术名"
    // → 判 FABRICATED_ENTITY → **拒绝导出**。
    // 实测数字侧本来已做归一化（两者都得 `size:2147483648`），
    // 只有专名侧漏了，故在此补上。
    // 安全性：单位词本身不含技术栈主张；真正被改动的数值仍由数字检查拦下
    // （实测 `2 GB` → `4 GB` 依然判 FABRICATED_NUMBER）。
    'kb',
    'mb',
    'gb',
    'tb',
    'pb',
    'ms',
    'sec',
    'secs',
    'min',
    'mins',
    'hr',
    'hrs',
    'byte',
    'bytes',
    'bit',
    'bits',
    // 【普通英文名词/形容词/动词（真实简历实测抓出的误报）】
    // 中文术语并列英文写法时，括号内是**英文翻译**：
    //   `断点续传（Resumable Upload）`、`超文本传输协议（Hyper Text Transfer Protocol）`、
    //   `负载均衡（Load Balancing）`、`面向对象（Object Oriented）`
    // 而这些常见英文词原本不在词表里 → 被判为"专有技术名" → **拒绝导出**。
    // 与"常见简历栏目名漏收"是同一类问题：词表覆盖不全导致分类不一致。
    // 判据：它们都是**普通英文词**（任何词典都有），不含技术栈主张。
    // 注意**不收** `Redis`/`Kubernetes` 这类专有技术名（那才是要拦的编造）。
    'resumable',
    'upload',
    'download',
    'hyper',
    'text',
    'transfer',
    'protocol',
    'load',
    'balancing',
    'balance',
    'continuous',
    'integration',
    'object',
    'oriented',
    'agile',
    'development',
    'develop',
    'unit',
    'testing',
    'test',
    'version',
    'control',
    'control',
    'concurrent',
    'concurrency',
    'parallel',
    'distributed',
    'distribute',
    'virtual',
    'machine',
    'grade',
    'point',
    'average',
    'layer',
    'simple',
    'query',
    'queries',
    'structured',
    'language',
    'framework',
    'frameworks',
    'service',
    'services',
    'model',
    'models',
    'pattern',
    'patterns',
    'system',
    'systems',
    'platform',
    'platforms',
    'solution',
    'solutions',
    'module',
    'modules',
    'component',
    'components',
    'function',
    'functions',
    'feature',
    'features',
    'process',
    'processes',
    'workflow',
    'pipeline',
    // 「技术名（英文全称）」里的通用词——与 Java Virtual Machine 同类。
    //
    // ⚠️ **只收"几乎不可能单独构成技术栈主张"的描述性词**。
    // 实测教训：我第一版把 `cluster`/`cache`/`server`/`queue`/`stream` 等
    // 一并收进来，结果 `数据库（Redis Cluster）` 从"拦住"变成"放行"——
    // 因为 `Cluster` 变泛指后，括号内只剩 `Redis` 一个专名，
    // 而它被"中文术语并列英文"规则放行了（**净亏损，已移除这批词**）。
    // 保留的是只在"英文全称"语境出现的词（`Java Virtual Machine`、
    // `Remote Dictionary Server`），它们不会让某个技术名单独漏过。
    'remote',
    'dictionary',
    'virtual',
    'machine',
    // 职位/职能类普通英文词（`求职意向：数据分析师（Data Analyst）`）
    // —— 与 `Engineering`/`Development` 同类，是**职能描述**而非技术栈主张。
    'analyst',
    'analysis',
    'analytics',
    'engineer',
    'engineering',
    'designer',
    'developer',
    'specialist',
    'consultant',
    'manager',
    'director',
    'intern',
    'assistant',
    'associate',
    'scientist',
    'researcher',
    'architect',
    'administrator',
    // 【"英文翻译"里的普通名词（真实简历实测抓出的误报）】
    // 中文术语/项目名/学科名并列英文写法时，括号内是**英文翻译**：
    //   `Verilog Hardware Description Language`、
    //   `电子信息工程（Electronic Information Engineering）`、
    //   `智能小车控制系统（Smart Car Control System）`
    // 这些词都是普通英文名词，不含技术栈主张。
    // ⚠️ 刻意**不收** `Verilog`——它是真正的技术名（硬件描述语言），
    // 必须留在 error 级（否则"新增 Verilog 技能"会被放过）。
    'hardware',
    'software',
    'description',
    'description', // 去重：Set 会合并，保留可读性
    'electronic',
    'information',
    'smart',
    'car',
    'control',
    'processing',
    'application',
    'applications',
    'technology',
    'technologies',
    'science',
    'computer',
    'computing',
    'system',
    'systems',
    'design',
    'analysis',
    'analytics',
    'intelligence',
    'artificial',
    'learning',
    'vision',
    'communication',
    'communications',
    'signal',
    'signals',
    'image',
    'images',
    'speech',
    'natural',
    'logic',
    'digital',
    'analog',
    'circuit',
    'circuits',
    'device',
    'devices',
    'sensor',
    'sensors',
    'robotics',
    'automation',
    'mechanical',
    'electrical',
    'civil',
    'materials',
    'physics',
    'mathematics',
    'statistics',
    'economics',
    'finance',
    'marketing',
    'business',
    'administration',
    // 【英文月份缩写（英文简历实测抓出的误报）】
    // `2022.09 - 2026.06` → `Sep 2022 - Jun 2026` 是**日期格式统一**，
    // 但 `Sep`/`Jun` 被判为"新增技术名"→ FABRICATED_ENTITY → **拒绝导出**。
    // 英文简历里月份缩写极常见，且不可能构成技术栈主张。
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'sept',
    'oct',
    'nov',
    'dec',
    'january',
    'february',
    'march',
    'april',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ].map((w) => w.toLowerCase()),
)

/**
 * 中文行内识别技术专名时的排除词（普通英文词表）。
 *
 * 【为什么需要这份词表（外部审查发现 S1-2）】
 * 中文简历里技术名大量**全小写**（redis / mysql / kafka / vite），
 * 而早期实现只认"首字母大写"，于是 `Vue2 → React` 这类**技术栈替换**
 * 零告警——项目自己的 demo 输出 `originalEntities: 0` 就是佐证：
 * 这道检查在真实中文简历上是空转的。
 *
 * 修法不能只删掉大小写约束：中文行里 `使用 Vue2 编写` 这类写法下，
 * 拉丁词的**行内位置**已经无法区分专名与普通词（中文没有词边界），
 * 因此改用"词表判断"——把普通英文词挡掉，其余视为疑似专名。
 *
 * 词表偏保守（宁可漏报不可误报）：只收简历里高频出现的普通动词/名词/形容词。
 * 词表之外的普通词仍可能被误报，这条边界已写入 {@link GUARD_LIMITATIONS}。
 */
const LATIN_IDENTIFIER_STOPWORDS = new Set(
  [
    // 招聘/简历里的普通英文词（非技术专名）
    'remote',
    'full',
    'part',
    'time',
    'team',
    'teams',
    'user',
    'users',
    'data',
    'design',
    'develop',
    'development',
    'management',
    'communication',
    'leadership',
    'english',
    'chinese',
    'office',
    'word',
    'excel',
    'powerpoint',
    'level',
    'good',
    'strong',
    'familiar',
    'proficient',
    'skills',
    'ability',
    'responsible',
    'participated',
    'assisted',
    'completed',
    'optimized',
    'refactored',
    'maintained',
    'supported',
    'created',
    'developed',
    'designed',
    'implemented',
    'built',
    'led',
    'managed',
    'improved',
    'used',
    'using',
    'and',
    'the',
    'for',
    'with',
    'from',
    'this',
    'that',
    'review',
    'mock',
    'test',
    'tests',
    'testing',
    'system',
    'systems',
    'platform',
    'module',
    'modules',
    'interface',
    'performance',
    // ── 对抗性审查实测补充（S1-2 误报侧）───────────────────────────
    //
    // 【为什么必须补这一批】
    // 外部对抗审查在真实简历上实测：ATS 关键词对齐的核心动作被误拒——
    //   熟悉持续集成与自动化部署流程 → 熟悉 CI/CD 流程与自动化部署  → 拒绝
    //   熟悉网络协议与数据传输机制   → 熟悉 TCP/IP 与数据传输机制    → 拒绝
    //   使用接口调试工具完成联调     → 使用 RESTful API 调试工具联调 → 拒绝
    // 这些是**等价术语替换**（中文 ↔ 英文缩写），不是编造，但守卫无从判断等价性。
    // 而"用户拿不到文件"的代价高于"漏掉一个缩写"（本项目原则：误报比漏报更糟）。
    'unit',
    'code',
    'coding',
    'agile',
    'scrum',
    'waterfall',
    'restful',
    'devops',
    'server',
    'client',
    'frontend',
    'backend',
    'fullstack',
    'database',
    'cache',
    'queue',
    'cloud',
    'container',
    'deploy',
    'deployment',
    'integration',
    'automation',
    'monitoring',
    'logging',
    'security',
    'network',
    'protocol',
    'version',
    'control',
    'source',
    'build',
    'release',
    'bug',
    'issue',
    'task',
    'sprint',
    'feature',
    'requirement',
    'document',
    'report',
    'analysis',
    'research',
    'marketing',
    'sales',
    'finance',
    'accounting',
    'training',
    'recruiting',
    'operation',
    'operations',
    'customer',
    'service',
    'quality',
    'process',
    'workflow',
    'pipeline',
    'framework',
    'library',
    'package',
    'script',
    'config',
    'setting',
    'setting',
    'account',
    'admin',
    'dashboard',
    'mobile',
    'desktop',
    'browser',
    'engineer',
    'engineering',
    'intern',
    'senior',
    'junior',
    'basic',
    'advanced',
  ].map((w) => w.toLowerCase()),
)

/** 文本是否含汉字。用于判断"这一行是中文行还是英文行"。 */
function containsHan(/** @type {string} */ text) {
  return /[\u4e00-\u9fa5]/.test(text)
}

/**
 * 常见"通用概念型"短缩写——降为 warn 级（不阻断导出）。
 *
 * 【为什么需要一份白名单，而不是"所有短大写缩写一律降级"（实测修正）】
 * 第一版写成"长度 ≤ 4 的全大写缩写一律不进 error 级"，结果**修过头**：
 *   `CSS → SCSS`、`SQL → NoSQL`、凭空加 `Kotlin` 全部变成 `ok=true`，
 *   等于放行"把没学过的技术写进简历"。实测确认后改为白名单。
 *
 * 【收录判据：只收"泛指概念"，不收"具体平台/具体技术"】
 * 这些词指的是**通用角色或模型**（接口、理念、岗位概念），
 * 在简历里常是中文术语的**等价写法**（"接口对接" ↔ API、"持续集成" ↔ CI/CD），
 * 判 error 会让用户拿不到文件；但它们本身**不构成一项可验证的技能主张**。
 *
 * 刻意**不收**（它们是可验证的实体主张，凭空出现即为编造，仍判 error）：
 *   - 具体云平台：`AWS`、`GCP`、`Azure`
 *   - 具体运行时/技术：`JVM`、`JSON`、`YAML`、`SSD`、`GPU`…
 *   - 具体技术栈：`CSS`、`SCSS`、`SQL`、`HTML`、`Kotlin`…
 * 收录与排除的边界已写入 {@link GUARD_LIMITATIONS}。
 */
const AMBIGUOUS_SHORT_ACRONYMS = new Set(
  [
    // 通用接口/角色概念
    'api', 'apis', 'sdk', 'sdks', 'ui', 'ux', 'cli', 'ide', 'os', 'db',
    // 通用工程理念
    'orm', 'mvc', 'crud', 'oop', 'aop', 'ioc', 'rest',
    // 通用业务/运营概念
    'seo', 'kpi', 'okr', 'ppt', 'erp', 'crm', 'cdn', 'dns',
    // 通用交付模型
    'saas', 'paas', 'iaas',
    // 通用工程实践/流程（本轮死锁扫描补充：`持续集成（CI）` 曾被判编造）
    'ci', 'cd', 'cicd', 'tdd', 'bdd', 'ddd', 'solid', 'dry', 'kiss', 'yagni',
    'devops', 'agile', 'scrum', 'kanban', 'waterfall',
    // 通用岗位/职能缩写
    'po', 'pm', 'hr', 'qa', 'it', 'sre',
  ].map((w) => w.toLowerCase()),
)

/**
 * 该拉丁 token 是否值得当作"疑似专名"参与新增比对（**error 级**）。
 * @param {string} w 已剥离尾部标点的 token
 * @returns {boolean} 是否保留
 */
function isLatinIdentifierCandidate(w) {
  // 必须以字母开头，且至少含 2 个字母。
  //
  // 为什么不是"含字母即可"（实测噪声）：中文简历里 `2.4s`、`1.8s`
  // 这类"数字 + 单位"的 token 也含字母，若一并收进来，
  // 合法的单位换算（`2.4s` → `2400ms`）会触发 FABRICATED_ENTITY 误报。
  // 而要求"以字母开头"只损失 `C++` 这类单词缩写，代价可接受。
  if (!/^[A-Za-z]/.test(w)) return false
  if ((w.match(/[A-Za-z]/g) ?? []).length < 2) return false
  // 记号型 token（`CI/CD`、`TCP/IP`、`A/B`）不进 error 级：
  // 中文术语 ↔ 英文记号属**等价替换**，纯文本无法判定，判 error 会造成死锁。
  // 它们降级进 warn 级（见 extractAmbiguousLatinTokens），信息不丢、不阻断导出。
  if (/[^A-Za-z0-9]/.test(w)) return false
  // 受限白名单内的通用短缩写同样降级（见 AMBIGUOUS_SHORT_ACRONYMS）。
  // 注意：**不是所有短缩写都降级**——`CSS`/`SCSS`/`SQL` 是可验证的技术栈主张。
  if (AMBIGUOUS_SHORT_ACRONYMS.has(w.toLowerCase())) return false
  const key = w.toLowerCase()
  return !EN_STOPWORDS.has(key) && !LATIN_IDENTIFIER_STOPWORDS.has(key)
}

/**
 * 该 token 是否是一个"值得提示、但不足以判 error"的拉丁标识符。
 *
 * 【设计理由（对抗性审查发现的两侧问题，这里取中间解）】
 * 审查实测出两种相反的错误：
 *   - **误报侧**：`CI/CD`、`TCP/IP`、`RESTful API`、`unit test` 被判编造并
 *     **拒绝导出**——而它们多是"中文说法 ↔ 英文形式"的等价术语替换，
 *     属 ATS 对齐的核心动作。用户因此拿不到文件（比漏报更糟）。
 *   - **漏报侧**：把这类词整表排除后，编造 `Excel` / `team` / `data`
 *     将完全无告警——而"熟练使用 Excel"是实打实的事实性主张。
 *
 * 两者都不可接受，故不再二选一，而是**按严重级分流**：
 * 高置信专名（`React`、`Kubernetes`、`Excel`）→ error（阻断交付，必须修正）；
 * 歧义标识符（记号、短缩写、普通英文词）→ **warn（只提示，不阻断导出）**。
 * 这样既不会造成投递死锁，也不会留下无声的编造面。
 *
 * @param {string} w 已剥离尾部标点的 token
 * @returns {boolean} 是否作为 warn 级提示
 */
function isAmbiguousLatinToken(w) {
  if (!/^[A-Za-z]/.test(w)) return false
  if ((w.match(/[A-Za-z]/g) ?? []).length < 2) return false
  // 已是 error 级的就不再重复提示
  return !isLatinIdentifierCandidate(w)
}

/**
 * 提取"歧义标识符"（记号、短缩写、普通英文词）——warn 级，不阻断导出。
 *
 * 与 {@link extractLatinProperNouns} 的候选集**互斥**（后者是 error 级）。
 *
 * @param {string} text 待提取文本
 * @returns {Set<string>} 歧义标识符集合
 */
export function extractAmbiguousLatinTokens(text) {
  const out = new Set()
  const src = normalizeText(text)
  if (src === '') return out
  for (const rawLine of src.split('\n')) {
    const line = rawLine.replace(/^[\s>*\-+#]+/, '').replace(/\*\*/g, '')
    for (const raw of line.split(/[^A-Za-z0-9.+#/-]+/)) {
      const w = raw.replace(/[.]+$/, '')
      if (w === '') continue
      if (isAmbiguousLatinToken(w)) out.add(w)
    }
  }
  return out
}

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
 *   - **英文年月**：Sep 2022、September 2022、2022 Sep（插件支持 language: 'en'）
 *
 * @param {string} text 待提取文本
 * @returns {Set<string>} 归一化时间点集合（统一为 `YYYY` 或 `YYYY-MM`）
 */
export function extractDateTokens(text) {
  const out = new Set()
  const src = normalizeText(text)
  if (src === '') return out

  // 先处理"年月"形态，避免被下面的裸年份规则重复计入
  //
  // 【为什么月份必须有 1-12 约束、且末尾要加 (?!\d)】
  // 早期实现写的是 `(\d{1,2})`，无合法域也不设右界，于是它会把
  // **根本不是日期的东西**啃成日期：
  //   `2019 - 2021`   → `2019-20`（月份 20，不存在的日期）
  //   `138-0000-0000` → `0000-00`
  // 后果不只是"多一个假日期"——日期集合是与数字集合做差集比对的，
  // 假日期会把真实的年份挤出 `dateYears`，使合法改写被误判为编造。
  // 实测（修复前）：`8万 → 80000`、`2026.03 → 2026年3月`、
  // `12000 → 1.2万` 全部被拒，用户永久拿不到文件。
  //
  // `(?!\d)` 用来堵回溯：`2019-2021` 里 `20` 因 >12 失败后，
  // 正则会退而匹配单个 `2`——那会得到 `2019-02`，同样错误。
  const consumed = []
  /** 英文月份名/缩写 → 月份数字（插件支持 language: 'en'） */
  const MONTHS_EN = /** @type {Record<string, number>} */ ({
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12,
  })
  const ymPatterns = [
    /((?:19|20)\d{2})\s*[年.\-/]\s*(0?[1-9]|1[0-2])(?!\d)\s*月?/g,
    // 英文年月：`Sep 2022` / `September 2022`（月份在前）
    /\b([A-Za-z]{3,9})\.?\s+((?:19|20)\d{2})\b/g,
    // 英文年月：`2022 Sep` / `2022 September`（年份在前）
    /\b((?:19|20)\d{2})\s+([A-Za-z]{3,9})\.?\b/g,
  ]
  let masked = src
  for (const re of ymPatterns) {
    for (const m of masked.matchAll(re)) {
      // 三种形态统一处理，**按"哪个 capture 是数字月份"分流**，不按顺序猜：
      //   ① 中文/数字年月：`2022年9月`、`2022.09`、`2022-09` → m[1]=年, m[2]=数字月
      //   ② 英文月在前：  `Sep 2022`                        → m[1]=月名, m[2]=年
      //   ③ 英文年在先：  `2022 Sep`                        → m[1]=年, m[2]=月名
      const a = m[1]
      const b = m[2]
      const aIsYear = /^(?:19|20)\d{2}$/.test(a)
      const bIsYear = /^(?:19|20)\d{2}$/.test(b)
      if (aIsYear && /^\d{1,2}$/.test(b)) {
        // ① 数字月份
        out.add(`${a}-${String(Number(b)).padStart(2, '0')}`)
        consumed.push(m[0])
      } else if (aIsYear && !bIsYear) {
        // ③ 年在前、月名在后
        const month = MONTHS_EN[b.toLowerCase()]
        if (month === undefined) continue
        out.add(`${a}-${String(month).padStart(2, '0')}`)
        consumed.push(m[0])
      } else if (bIsYear && !aIsYear) {
        // ② 月名在前、年在后
        const month = MONTHS_EN[a.toLowerCase()]
        if (month === undefined) continue
        out.add(`${b}-${String(month).padStart(2, '0')}`)
        consumed.push(m[0])
      }
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
 * 结构性信息行的特征：姓名、求职意向、联系方式等简历头部内容。
 *
 * 【为什么需要排除（真实产品缺陷）】
 * 实测发现：改写流程中补全简历头部（姓名、求职意向、联系方式）是
 * **正常且必需**的操作——用户原文往往只有经历部分，头部由改写补上。
 * 若不排除，这些行会被"整条新增检测"报为编造，导致守卫误报、
 * 用户无法通过校验，反而用不了。
 *
 * 判据：以常见头部字段名开头（冒号前后皆可），或为纯联系方式行。
 * 只作用于"整条新增检测"，数字/机构等其它检查仍全量生效——
 * 头部里的电话真被改了，仍会被数字检查抓住。
 */
const STRUCTURAL_LINE_PATTERNS = [
  /^(姓名|名字|求职意向|意向岗位|目标岗位|期望职位|联系方式|电话|手机|邮箱|email|e-?mail|地址|现居|所在地|个人网站|博客|github|linkedin|微信|政治面貌|籍贯|出生|年龄|性别)\s*[:：]/i,
  // 纯联系方式行：邮箱或手机号单独成行
  /^[\w.+-]+@[\w.-]+\.\w+$/,
  /^1[3-9]\d{9}$/,
  // 含联系方式的头部行（含手机/座机的常见分隔写法）
  //
  // 【为什么必须单独加这条（外部审查发现）】
  // 简历头部的实际写法常常没有字段标签，而是「职位 | 电话 | 邮箱」这种
  // 竖线分隔行——实测 `前端开发工程师 | 138-0000-0000 | xxx@example.com`
  // 不匹配上面任何一条，于是被"整条新增检测"报为凭空新增。
  // 它只会多报（同一件事既进数字检查又进新增检查），
  // 对用户表现为提示混乱，且错误信息会诱导模型删掉真实联系方式。
  //
  // 边界：本规则只豁免"整条新增检测"；该行里的数字/机构
  // 仍由各自检查全量比对，编造的联系方式一样会被抓住。
  /(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}/,
  /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/,
]

/**
 * 判断一行是否属于简历结构性信息（头部），不参与"整条新增"判定。
 * @param {string} line 已去除标记的行
 * @returns {boolean} 是否属于结构性信息
 */
function isStructuralLine(line) {
  return STRUCTURAL_LINE_PATTERNS.some((re) => re.test(line))
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
 * 切分规则：按行切，去掉 Markdown 标记与列表符号，跳过结构性头部行；
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
    // 结构性头部（姓名/求职意向/联系方式）不参与"整条新增"比对：
    // 改写补全头部是正常操作，报为编造会造成误报
    if (isStructuralLine(line)) continue
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
 * 把改写单元与原文单元配对。
 *
 * 【存在理由（外部审查发现 S2-1）】
 * 职责升格此前按**全文 min/max** 比对，双向都坏：
 *   - 真升格漏报：单条「参与 → 负责」，但文中另有它行含「参与」，
 *     全文 min 不变 → 漏报
 *   - 合法压缩误报：仅删掉一行弱动词行，全文 min 抬高 → 误报并拒绝导出
 * 正确做法是**下推到内容单元级**：先把改写行与其最佳匹配的原文行配对，
 * 再逐对比较职责强度。文档级聚合只作兜底（见 verifyRewrite 第 3 项）。
 *
 * 【为什么必须遍历全部候选取"真正最优"，不能提前 break（严重回归，实测抓出）】
 * 第一版写成"一旦 score ≥ threshold 就 break"，于是取到的是**第一个够格的**，
 * 而不是**最相似的**。两条原文同属一个模块、共享大量 bigram 时（如
 * 「参与登录模块的重构工作；」与「负责登录模块的性能优化工作；」），
 * 第二条改写会先撞上第一条（相似度 ~0.58 ≥ 0.25）就停下，
 * 于是被拿去与**错误的那一条**逐对比较 → 报出"参与 → 负责"的假升格。
 *
 * 后果是**恒等改写（original === rewritten，一个字都没改）也会被判为升格**
 * 并拒绝导出——没有改写就不可能升格，这类误报是必然发生的，属最坏的一类：
 * 用户连"原样导出"都做不到（投递死锁）。因此必须取全局最优。
 *
 * 【单调约束（为什么加）】
 * 简历改写会重排、合并、拆分条目。若允许任意重配，同一原文条会被多条改写
 * 重复选中（"一条原文被多条改写抢用"），产生跨单元的假配对。
 * 这里按改写顺序做**单调**分配：每条改写只在"上一条已用位置之后"的原文里找
 * 最优（允许并列/回退到同一位置，以支持合并）。这能消除乱序抢用，
 * 又不会误伤重排（重排是改写顺序变化，单调仍能各自找到精确匹配）。
 *
 * 【已知边界（如实声明）】
 * 多条原文**合并**为一条改写时，只有最佳匹配的那条原文参与逐对比较，
 * 其余原文条不被比较 → 合并过程中若抬高了职责，可能漏报。
 * 这是为消除"必然误报"而接受的取舍（本项目原则：误报比漏报更糟）。
 *
 * @param {string} original 原文
 * @param {string} rewritten 改写后文本
 * @param {number} [threshold] 相似度阈值
 * @returns {Array<{ rewritten: string, original: string | null, score: number }>}
 *   每条改写单元的配对结果；原文无单元时为原始行与 null 配对
 */
export function matchUnitsToOriginal(original, rewritten, threshold = NOVEL_UNIT_THRESHOLD) {
  const originalUnits = extractContentUnits(original)
  const rewrittenUnits = extractContentUnits(rewritten)
  if (originalUnits.length === 0 || rewrittenUnits.length === 0) {
    return rewrittenUnits.map((unit) => ({ rewritten: unit, original: null, score: 0 }))
  }
  const originalBigrams = originalUnits.map((u) => charBigrams(normalizeForSimilarity(u)))
  let floor = 0
  return rewrittenUnits.map((unit) => {
    const grams = charBigrams(normalizeForSimilarity(unit))
    let best = 0
    let bestIndex = -1
    // 遍历全部候选，取真正最优（**不可提前 break**，见上方回归说明）
    for (let i = floor; i < originalBigrams.length; i += 1) {
      const score = containment(grams, originalBigrams[i])
      if (score > best) {
        best = score
        bestIndex = i
      }
    }
    if (bestIndex >= 0 && best >= threshold) {
      floor = bestIndex // 单调推进，避免同一原文条被后续条目抢用
      return { rewritten: unit, original: originalUnits[bestIndex], score: best }
    }
    return { rewritten: unit, original: null, score: best }
  })
}

/**
 * 反向配对：为**每条原文单元**找出最相似的改写单元。
 *
 * 【为什么需要这个方向（对抗性审查实测的漏报）】
 * 正向配对（改写 → 原文）只做一对一，**合并**场景会漏：
 * ```
 *   原文：- 参与登录模块的重构工作；
 *         - 负责商品列表的开发工作；
 *   改写：- 负责登录模块的重构与商品列表的开发工作；
 * ```
 * 合并行与"负责商品列表…"相似度 0.9，于是配对到它（同为负责层，无变化）；
 * 而"参与登录模块的重构工作"**从未被比较** → 「参与 → 负责」的真升格被漏掉。
 * 合并/拆条正是本插件宣称的常态化写能力。
 *
 * 【⚠️ 但结果只作 warn，不得作 error（代价不对称）】
 * 纯文本层面**无法区分**「合并导致升格」与「合法删掉了一行弱表述」：
 * ```
 *   原文：- 参与用户登录模块的重构工作；   ← 弱
 *         - 负责用户登录模块的性能优化工作；
 *   改写：- 负责用户登录模块的性能优化工作；  ← 弱那条被删（合法精简）
 * ```
 * 此例中反向配对也会把"参与…"配到"负责…"（相似度 0.58 ≥ 阈值）并看到
 * 层级上升——若据此判 error，就重新制造了"合法精简被拒绝导出"的投递死锁，
 * 即本轮刚修掉的那类缺陷。既然判据无法区分，就不能用它阻断交付
 *（本项目原则：误报比漏报更糟），故降为 warn：信息给到人与模型，不阻断。
 *
 * @param {string} original 原文
 * @param {string} rewritten 改写后文本
 * @param {number} [threshold] 相似度阈值
 * @returns {Array<{ original: string, rewritten: string | null, score: number }>}
 */
export function matchOriginalToUnits(original, rewritten, threshold = NOVEL_UNIT_THRESHOLD) {
  const originalUnits = extractContentUnits(original)
  const rewrittenUnits = extractContentUnits(rewritten)
  if (originalUnits.length === 0 || rewrittenUnits.length === 0) return []
  const rewrittenBigrams = rewrittenUnits.map((u) => charBigrams(normalizeForSimilarity(u)))
  return originalUnits.map((unit) => {
    const grams = charBigrams(normalizeForSimilarity(unit))
    let best = 0
    let bestIndex = -1
    for (let i = 0; i < rewrittenBigrams.length; i += 1) {
      const score = containment(grams, rewrittenBigrams[i])
      if (score > best) {
        best = score
        bestIndex = i
      }
    }
    return {
      original: unit,
      rewritten: bestIndex >= 0 && best >= threshold ? rewrittenUnits[bestIndex] : null,
      score: best,
    }
  })
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

/**
 * 判定 `original` 是否只是改写结果的副本（"自证清白"）。
 *
 * 【为什么需要（外部审查发现 S1-3）】
 * 交付关把 `original` 当作"改写前的原文"来比对，但它是**模型传入的参数**，
 * 并非可信源。若模型把改写结果回填进 `original`，校验就退化为自反比对，
 * 任何编造都"有据可依"，而返回值还会宣称"校验已通过"。
 * 早期实现只防"两者完全相等"，于是**加任意一行即可绕过**：
 *   `original = 编造版 + "以上为我的原始简历内容"` → 导出成功且 verified=true。
 * 这比不做校验更坏：它把"没有校验"伪装成"校验通过"。
 *
 * 【判据（两档，都是确定性的）】
 *   1. `equal`    —— 归一化后完全相等（含仅空白/换行差异）
 *   2. `contains` —— 归一化后 original 逐字包含整个 resume，且多出的部分很少
 *      （"副本 + 装饰"形态）
 *
 * 【为什么两档在调用方要区别对待（实测教训，我自己的第一版就错在这里）】
 * 第一版把两档都当作"拒绝导出"，随后实测发现 **`contains` 会误伤合法改写**：
 *   original `- A\n- B` → resume `- A`（模型只是**删掉**了一条经历，
 *   一字未改）。此时 original 逐字包含 resume，多出部分很少 → 被拒绝导出，
 *   用户永久拿不到文件——**正是 S1-1 那一类投递死锁**。
 *
 * 根因是纯文本层面**无法区分**"尾部加了装饰"与"删掉了一条经历"：
 * 两者都表现为"original = resume + 一小段"。任何阈值都只是把误判挪个位置，
 * 不可能消除。
 *
 * 因此调用方必须按不对称代价处理（见 core.js 的交付关）：
 *   - `equal`    → **硬拒绝**：两份文本完全相同必定是调用方传错，无歧义，
 *                  且提示后模型/用户能立刻改正，不构成死锁。
 *   - `contains` → **不拒绝**，而是把 `verified` 降级为 false 并说明原因。
 *                  这样既不会谎称"已校验"，也不会让用户拿不到文件。
 *                  （对 `original` 这种不可信输入，本来就不存在可靠保证——
 *                  既然如此就不该用一个会误伤的判据去假装有保证。）
 *
 * 【为什么不用"逐条内容单元都比对得上"作判据】
 * 那会误伤**只调整顺序、未改措辞**的合法改写（内容单元集合完全相同），
 * 而"重排经历权重"正是本插件宣称的能力之一。逐字包含只看序列，
 * 重排后序列不同，天然放行。
 *
 * 【残留边界（必须对外声明，不得声称"已堵死"）】
 * 若模型刻意伪造一份**措辞不同但含同样数字**的 original（例如把编造的
 * "服务 8 万用户"改写成"曾服务约 8 万名用户"再塞进 original），
 * 纯文本层面无法识别。因此 `verified=true` 的准确语义是
 * 「已对照**传入的** original 校验通过」，而非「original 必为用户的真实原文」。
 *
 * @param {unknown} original 调用方传入的"原文"
 * @param {unknown} rewritten 改写结果
 * @returns {{ selfAttested: boolean, reason: 'equal' | 'contains' | '' }}
 *   是否属自证清白，以及命中的判据
 */
export function detectSelfAttestation(original, rewritten) {
  const o = normalizeText(original).trim()
  const r = normalizeText(rewritten).trim()
  if (o === '' || r === '') return { selfAttested: false, reason: '' }
  if (o === r) return { selfAttested: true, reason: 'equal' }
  const flatOriginal = normalizeForSimilarity(o)
  const flatRewritten = normalizeForSimilarity(r)
  // 过短的结果（< 8 字）在任何原文里都可能作为片段出现，
  // 用它判定"副本"必然误报，因此不做这一档判定。
  if (flatRewritten.length < 8) return { selfAttested: false, reason: '' }

  // 判据：**逐字包含**（original = resume + 少量装饰）。
  //
  // 【为什么不加"按序近同一"这第二档（实测否决）】
  // 对抗性审查指出本判据可被绕过：把装饰插到中间、或改中间一个字符
  // （`60%` → `60％`）都会让包含关系不成立 → 返回 false →
  // 调用方把 verified 置 true，编造落盘。
  //
  // 我按此实现了"按序对齐 + 高相似度阈值"的第二档，但**测试立刻否决了它**：
  // 它把"原文 `- 商品列表开发，性能提升 40%` → 改写 `- 负责商品列表开发…`"
  // 这类**只加了一个动词的正常改写**也判成副本，导致正常导出被降级甚至拒绝。
  // 这与"删掉一行弱表述"属同一类：改动越小，越难与"副本 + 装饰"区分，
  // 任何阈值都只是把误判挪个位置。
  //
  // 按本项目原则（误报比漏报更糟；用户拿不到文件是最坏结果）保持保守：
  // 只认无歧义的"逐字包含"，并**如实声明**防护范围有限
  //（见 README 与工具描述：verified=true 仅表示"对照传入的 original 校验通过"）。
  // 这不是"假装堵死"——对外措辞已如实降级。
  if (flatRewritten.length < 8) return { selfAttested: false, reason: '' }
  if (!flatOriginal.includes(flatRewritten)) return { selfAttested: false, reason: '' }
  const extra = flatOriginal.length - flatRewritten.length
  // 装饰文字的容忍量**必须按语言缩放**（英文实测抓出的不对称）。
  //
  // 同一句装饰（"以上为我的原始简历内容" vs "Above is my original resume"）
  // 在扁平化后长度差很大：中文 12 字、英文 26 字符。
  // 固定下限 20 于是让**中文命中 contains、英文漏掉**：
  //   `original = resume + 一行装饰` 这种 S1-3 原始绕过，
  //   中文能识别，英文却返回 false → 调用方会把 verified 置 true。
  // 英文单词更长、且 markdown 记号（`#`/`*`）更多，故按"字符数"给阈值
  // 必然偏向中文。现改为**按语言取不同下限**：英文用 40（约两倍），
  // 并保留 10% 的比例档（长文本按比例放宽）。
  const hasHan = /[\u4e00-\u9fa5]/.test(flatRewritten)
  const floor = hasHan ? 20 : 40
  const tolerance = Math.max(floor, Math.floor(flatRewritten.length * 0.1))
  if (extra > tolerance) return { selfAttested: false, reason: '' }
  return { selfAttested: true, reason: 'contains' }
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
  {
    level: 1,
    label: '认知层',
    words: ['了解', '熟悉', '接触', '学习', '入门'],
    // 英文对应（插件支持 language: 'en'，见 SUPPORTED_LANGUAGES）
    enWords: ['learned', 'learning', 'familiar', 'exposed', 'introduced', 'aware'],
  },
  {
    level: 2,
    label: '辅助层',
    words: ['参与', '协助', '配合', '支持', '跟随'],
    enWords: [
      'participated',
      'participate',
      'assisted',
      'assist',
      'supported',
      'support',
      'contributed',
      'contribute',
      'helped',
      'help',
      'involved',
      'collaborated',
    ],
  },
  {
    level: 3,
    label: '负责层',
    words: ['负责', '承担', '完成', '执行', '独立开发'],
    enWords: [
      'responsible',
      'completed',
      'complete',
      'executed',
      'implemented',
      'developed',
      'built',
      'delivered',
      'owned',
      'managed',
    ],
  },
  {
    level: 4,
    label: '主导层',
    words: ['主导', '牵头', '独立完成', '主持', '主责'],
    enWords: [
      'led',
      'leading',
      'spearheaded',
      'drove',
      'initiated',
      'directed',
      'architected',
      'established',
    ],
  },
  {
    level: 5,
    label: '决策层',
    words: ['统筹', '决策', '拍板', '制定战略', '定方向'],
    enWords: [
      'decided',
      'strategized',
      'defined',
      'set direction',
      'prioritized',
      'orchestrated',
    ],
  },
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
  const lower = src.toLowerCase()
  for (const tier of RESPONSIBILITY_LEVELS) {
    for (const word of tier.words) {
      if (src.includes(word)) {
        hits.push({ level: tier.level, label: tier.label, word })
      }
    }
    // 英文职责动词（插件支持 language: 'en'）。
    //
    // 【为什么必须补（英文简历实测抓出的真实漏报）】
    // 职责词表原本只有中文，于是英文简历上这道检查**完全空转**：
    //   `Participated in database optimization`（辅助层）
    //   → `Led database optimization`（主导层）
    //   实测 ok=true、零告警——"参与"写成"主导"这类最典型的事实夸大一放到底。
    // 用**词边界**匹配（`\b`），避免 `led` 命中 `enabled`、
    // `owned` 命中 `downed` 之类的子串误报。
    for (const word of tier.enWords ?? []) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`(?<![a-z])${escaped}(?![a-z])`, 'i').test(lower)) {
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
/**
 * 剥离 markdown **排版语法**，只保留文字内容。
 *
 * 【存在理由（真实简历实测抓出的一批死锁）】
 * 下列都是**纯排版动作**，却会把 markdown 语法本身当成"原文没有的内容"：
 *   · 加引用块 `> 说明`         → `> 以下为在校期间荣誉` 被判"凭空新增"
 *   · 加链接 `[文字](url)`      → 整条被判新增（`https`、`com` 等成了"新专名"）
 *   · 表格化 `| a | b |`        → `| 类别 | 内容 |` 与分隔行 `|---|---|` 被判新增
 *   · 加水平线 `---`、斜体说明 `*…*`
 * 实测这批动作让真实简历的误报率达到 25%，全部是"用户拿不到文件"。
 *
 * 【为什么单独一个函数，而不是塞进 `normalizeText`】
 * `normalizeText` 被**所有**检查共用，包括"某技术名是否仍出现在原文里"
 * 这类**存在性**判定。在那里剥离语法有风险（若剥离不当会把技术名一起删掉，
 * 反而误判"技术名消失"）。而这个函数只用于**内容单元比对**
 * （判断"某条改写是否与原文任何内容都对不上"），
 * 剥离语法后只会让比对更准确，不会造成"内容凭空消失"的误判。
 *
 * @param {string} input 原始文本
 * @returns {string} 去除 markdown 排版语法后的纯文字
 */
export function stripMarkdownSyntax(input) {
  if (typeof input !== 'string') return ''
  return input
    .split('\n')
    .map((line) => {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return '' // 表格分隔行
      if (/^\s*\|/.test(line)) {
        // 表格数据行 → 拍平成单元格文字
        return line
          .replace(/^\s*\||\|\s*$/g, '')
          .split('|')
          .map((c) => c.trim())
          .filter(Boolean)
          .join(' ')
      }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return '' // 水平线
      if (/^\s*>\s?/.test(line)) return line.replace(/^\s*>\s?/, '') // 引用块
      return line
    })
    .join('\n')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接 → 链接文字
    .replace(/`([^`]*)`/g, '$1') // 行内代码 → 内容
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1') // 粗体/斜体 → 文字
    .replace(/_{1,3}([^_\n]+)_{1,3}/g, '$1')
}

/**
 * 归一化文本：统一换行，便于逐行处理。
 * @param {unknown} input 任意输入
 * @returns {string} 归一化文本（非字符串输入返回空串）
 */
export function normalizeText(input) {
  if (typeof input !== 'string') return ''
  return (
    input
      .replace(/\r\n?/g, '\n')
      // ── 剥离 markdown **有序列表序号**（实测抓出的死锁）──────────────
      //
      // 【为什么（真实简历实测）】把无序列表改成有序列表是最常见的排版动作：
      //   `- 熟悉 Java\n- 熟悉 MySQL` → `1. 熟悉 Java\n2. 熟悉 MySQL`
      // 而 `1`/`2`/`3` 会被当作"改写后新增的数字"→ 判 `FABRICATED_NUMBER`
      // → **拒绝导出**（用户拿不到文件）。
      // 但它们是**排版序号**，不是简历里的量化结果，不含任何事实主张。
      //
      // 这里在**归一化的最前面**就剥掉序号（连同其后一个空格/Tab），
      // 使所有下游检查（数字、日期、实体、单元比对）都看不到它们——
      // 而不是只在数字检查里特判（那样其它检查仍可能被序号干扰）。
      //
      // 只在**行首**匹配（`^\s{0,3}\d{1,3}[.)]\s`），因此不会误伤行内数字：
      //   `服务 8 万用户` 里的 `8` 不在行首，不受影响；
      //   `2026.06 入职` 虽在行首，但 `2026` 是 4 位数、且 `.` 后紧跟数字
      //   （正则需要 `.` 后有空白），故也不会被剥。
      .replace(/^([ \t]{0,3})\d{1,3}[.)][ \t]+/gm, '$1')
      // ── 剥离页码/页脚行（实测抓出的死锁）────────────────────────────
      // `第 1 页 / 共 1 页`、`Page 1 of 2` 是**纯排版**，但其中的 `1`
      // 会被判为"改写后新增的数字"→ FABRICATED_NUMBER → 拒绝导出。
      // 这里同样在归一化最前面剥掉（`stripMarkdownSyntax` 里也剥，
      // 但那条只用于内容单元比对，数字检查走的是本函数）。
      .replace(
        /^[ \t]*(?:第\s*\d+\s*页(?:\s*[／/|]\s*共\s*\d+\s*页)?|page\s*\d+\s*(?:of|\/)\s*\d+)[ \t]*$/gim,
        '',
      )
  )
}

/**
 * 中文数量级词 → 倍率。
 *
 * 【存在理由（实测）】
 * 同一个数值在中文简历里有多种等价写法，早期实现把它们当成不同数字，
 * 于是"把 8 万写成 80000"这类**纯格式改写**被判为编造并拒绝导出。
 * 实测（修复前）：`服务 8 万用户 → 服务 80000 用户` 与
 * `商品列表 12000 个 → 商品列表 1.2 万个` 均被拒。
 * 这类改写是模型对齐 ATS 时的常规动作，封死它等于封死主链路。
 *
 * 注意这只统一**写法**，不放宽判定：`8 万 → 80 万` 仍会被抓，
 * 因为归一化后一个是 80000、一个是 800000，仍然不同。
 */
const CN_MAGNITUDES = /** @type {const} */ ([
  ['亿', 1e8],
  ['万', 1e4],
  ['千', 1e3],
])

/**
 * 英文数量级后缀 → 倍率。
 *
 * 【为什么需要（英文简历实测抓出的死锁，与中文数量级同源）】
 * `8K` 与 `8000`、`1.5M` 与 `1500000` 是同一数值的两种写法，
 * 但英文简历实测：
 *   `Handled 8K requests` → `Handled 8000 requests`   → 判 FABRICATED_NUMBER ✘
 *   `1.5M users` → `1500000 users`                     → 判 FABRICATED_NUMBER ✘
 * 反向（`8000` → `8K`）同样被拒。这与 `8 万 → 80000` 是**完全同类**的问题
 * （中文侧早已修好，英文侧漏了）。
 *
 * 只收无歧义的后缀：`K`/`M`/`B`（千/百万/十亿）。
 * **不**收裸 `k`（可能是千克）——那由单位表处理。
 */
const EN_MAGNITUDES = /** @type {const} */ ([
  ['B', 1e9],
  ['M', 1e6],
  ['K', 1e3],
])

/**
 * 把带中文数量级的数字归一化为纯数字串（`1.2万` → `12000`）。
 * @param {string} digits 数字部分（如 `1.2`）
 * @param {string} unit 数量级词（如 `万`）
 * @returns {string} 归一化后的数字串；无法精确表示时退回原写法
 */
function applyMagnitude(digits, unit) {
  const magnitude = CN_MAGNITUDES.find(([u]) => u === unit)?.[1]
  if (magnitude === undefined) return `${digits}${unit}`
  const value = Number(digits) * magnitude
  // 只接受有限、非负、且能用十进制精确表示的乘积；
  // 否则（如浮点误差）退回原写法，宁可保守也不制造假等价。
  if (!Number.isFinite(value) || value < 0) return `${digits}${unit}`
  return String(value)
}

/**
 * 提取文本中的数字 token（含全角数字）。
 *
 * 归一化规则：全角转半角、去掉千分位逗号、去掉尾部小数点、
 * **统一中文数量级写法**（`1.2万` → `12000`）。
 * 例：'1,200.' → '1200'；'４０%' → '40'；'8 万' → '80000'
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

  // ── 先抽取"联系方式数字"（手机/座机），整体归一化后再参与比对 ──
  //
  // 【存在理由（实测）】`13800000000` 与 `138-0000-0000` 是同一个号码的
  // 两种写法。早期实现按组分段抽取（`138`、`0000`），于是
  // "给电话加连字符"这种纯排版动作会被判成"多出数字 0000、138"，
  // 合法改写被拒。号码是事实字段，写法差异不该算编造。
  // 用占位符替换掉，避免后面被当普通数字重复抽取。
  //
  // 【国际区号也属"写法"（实测抓出的死锁）】
  // `136-0000-0000` → `+86-136-0000-0000` 时，`86` 被判为"新增数字"。
  // 但区号是号码的**国际写法**，号码本体一字未变。故允许可选的 `+NN` 前缀，
  // 且归一化时**只记号码本体**（10 位），使两种写法比对相等。
  // 放宽是安全的：号码本体若被改动（如 136 → 138），比对仍会不同。
  const contactRe = /(?:\+\d{1,3}[-\s]?)?(?<!\d)(1[3-9]\d)[-\s]?(\d{4})[-\s]?(\d{4})(?!\d)/g
  const masked = normalized.replace(contactRe, (_full, a, b, c) => {
    out.add(`${a}${b}${c}`)
    return ' '
  })

  // ── 先归一化"数值 + 计量单位"（S1-1 同族残留，实测抓出）──────────
  //
  // 【存在理由】
  // `2.4s` 与 `2400ms` 是同一个时长的两种写法。早期只归一化中文数量级词
  // （亿/万/千），未处理**计量单位换算**，于是"把秒写成毫秒"这种纯格式动作
  // 被判成"多出数字 2400、丢掉 2.4"并**拒绝导出**——与 S1-1 同一类死锁
  // （用户拿不到文件），而它同样是模型做 ATS/可读性对齐时的常规动作。
  //
  // 只统一**写法**，不放宽判定：`2.4s` → `3.6s` 归一化后仍不同，照样抓。
  // 单位表刻意保守：只收无歧义的常见单位（跳过裸 `m`，它可能是米/分钟）。
  /** @type {Array<[RegExp, string, number]>} */
  const UNIT_FAMILIES = [
    [/^(?:ms|毫秒)$/i, 'time', 0.001],
    [/^(?:s|sec|secs|秒)$/i, 'time', 1],
    [/^(?:min|mins|分钟)$/i, 'time', 60],
    [/^(?:h|hr|hrs|小时)$/i, 'time', 3600],
    [/^(?:b|byte|bytes|字节)$/i, 'size', 1],
    [/^(?:kb|千字节)$/i, 'size', 1024],
    [/^(?:mb|兆字节)$/i, 'size', 1024 ** 2],
    [/^(?:gb|吉字节)$/i, 'size', 1024 ** 3],
  ]
  const unitConsumed = []
  // ⚠️ 交替顺序有关：`ms` 必须在 `s` 之前、`mb` 在 `b` 之前，
  // 否则 `2400ms` 会被 `s`... 之类的短分支截断。
  // 另外裸 `s` / `b` / `h` 必须列出（实测漏掉裸 `s` 导致 `2.4s` 完全不被归一化）。
  const unitRe =
    /(\d[\d,]*(?:\.\d+)?)\s*(ms|毫秒|secs?|秒|mins?|分钟|hrs?|小时|bytes?|字节|kb|mb|gb|s|h|b)(?![\w])/gi
  for (const m of masked.matchAll(unitRe)) {
    const family = UNIT_FAMILIES.find(([re]) => re.test(m[2]))
    if (family === undefined) continue
    const value = Number(m[1].replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    const [, name, factor] = family
    // 以族内基准单位表示（时间→秒，容量→字节）。
    // 用 toPrecision(12) 消除浮点噪声（如 2.4*1 → 2.4000000000000004），
    // 再用 Number 去掉多余的尾零，保证 `2.4s` 与 `2400ms` 得到同一字符串。
    const base = Number((value * factor).toPrecision(12))
    out.add(`${name}:${base}`)
    unitConsumed.push(m[0])
  }
  let maskedUnits = masked
  for (const frag of unitConsumed) {
    maskedUnits = maskedUnits.replace(frag, ' ')
  }

  // 数字主体：允许小数与千分位；其后可紧跟数量级词。
  // 中文数量级（亿/万/千）与**英文数量级**（K/M/B，见 EN_MAGNITUDES）都归一化。
  // 英文后缀要求**紧跟数字且后接非字母**（避免 `8KB` 里的 K 被误当数量级——
  // `8KB` 走的是单位表，`8K users` 才是数量级）。
  for (const m of maskedUnits.matchAll(/(\d[\d,.]*)\s*(亿|万|千|[KMB])?(?![A-Za-z])/g)) {
    const raw = m[1]
    const unit = m[2]
    const token = raw.replace(/,/g, '').replace(/\.$/, '')
    if (token === '') continue
    if (unit === undefined) {
      out.add(token)
      continue
    }
    // 带数量级词时归一化为纯数字（`1.2万` → `12000`、`8K` → `8000`）
    const enMagnitude = EN_MAGNITUDES.find(([u]) => u === unit)?.[1]
    if (enMagnitude !== undefined) {
      const value = Number(token) * enMagnitude
      out.add(
        Number.isFinite(value) && value >= 0 ? String(value) : `${token}${unit}`,
      )
      continue
    }
    out.add(applyMagnitude(token, unit))
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
 * 【为什么还要剔除"年份分量 + 月份分量"】（第二层缺陷，实测）
 * 仅剔复合 token 不够。`2026年3月` 抽出的数字是 `2026` 与 `3`
 * （两个独立 token），而 `2026.03` 抽出的是复合 token `2026.03`——
 * 两者形态不同，于是 `2026.03 → 2026年3月` 这类**纯格式规范化**
 * 会被判成"多出一个数字 3"，合法改写被拒。
 * 因此凡是与某个日期同年/同月的裸数字，一律视为日期成分一并剔除。
 * 这不会放过编造：日期本身由 FABRICATED_DATE 检查负责。
 *
 * @param {Set<string>} numbers 数字 token 集合
 * @param {Set<string>} dates 日期 token 集合（形如 `YYYY-MM` 或 `YYYY`）
 * @returns {Set<string>} 剔除日期后的数字集合
 */
export function subtractDateTokens(numbers, dates) {
  const out = new Set()
  // 日期涉及的年份与月份分量（`2026-03` → 年份 2026、月份 03/3）
  const dateYears = new Set()
  const dateMonths = new Set()
  for (const d of dates) {
    dateYears.add(d.slice(0, 4))
    if (d.length === 7) {
      const month = d.slice(5)
      dateMonths.add(month)
      // 月份同时收纳去零形态，覆盖 `3` 与 `03` 两种写法
      dateMonths.add(String(Number(month)))
    }
  }
  for (const n of numbers) {
    // 复合日期 token（2019.06 / 2019.06.01）
    if (/^(19|20)\d{2}\.\d{1,2}(\.\d{1,2})?$/.test(n)) continue
    // 与已知日期同年的裸年份
    if (/^(19|20)\d{2}$/.test(n) && dateYears.has(n)) continue
    // 与已知日期同月的裸月份（`2026年3月` 里的 `3`）
    if (/^\d{1,2}$/.test(n) && dateMonths.has(n)) continue
    out.add(n)
  }
  return out
}

/**
 * 提取英文/技术专名候选。
 *
 * 【两套规则，按"这一行是中文行还是英文行"分流】
 * 外部审查发现（S1-2）：早期实现只有一套规则——"首字母大写 + 跳过行首词"——
 * 导致真实中文简历上的检查**完全空转**（demo 输出 `originalEntities: 0`）：
 *   - `Vue2 → React` 这类技术栈替换零告警（React 虽大写，但 Vue2 在行首被跳过）
 *   - `redis / mysql / kafka` 全小写技术名一个都不认
 * 根因是中文没有词边界，**行内位置**在中文行里根本说明不了问题，
 * 而大小写在中文行里也不可靠（技术名常全小写）。
 *
 * 因此改为：
 *   - **含汉字的行**：收集全部拉丁 token（不论位置、不论大小写），
 *     用普通英文词表 {@link LATIN_IDENTIFIER_STOPWORDS} 过滤误报。
 *     `使用 Vue2 编写`、`使用 redis 缓存` 都能识别。
 *   - **不含汉字的行**（纯英文简历）：保持原保守规则（首字母大写、跳过行首），
 *     因为英文有词边界与句首大写惯例，贸然全收会制造大量误报。
 *
 * 排除：简历章节标题、常见动词/连接词、普通英文词。
 * 误报会让守卫被忽略，比漏报更糟——这条原则贯穿本文件。
 *
 * @param {string} text 待提取文本
 * @returns {Set<string>} 专名候选集合
 */
export function extractLatinProperNouns(text) {
  const out = new Set()
  const src = normalizeText(text)
  if (src === '') return out
  // ── 先剥离 URL / 邮箱（实测抓出的误报）──────────────────────────────
  //
  // 【为什么】URL 与邮箱地址不是技术栈主张，但会被当成专名：
  //   `博客：https://blog.example.com/posts` → 提取到 `https`
  //   `邮箱：liuyang@example.com`            → 提取到 `liuyang`
  // 后果：把 `github.com/liuyang` 加上链接语法（
  // `[github.com/liuyang](https://github.com/liuyang)`）这种**纯排版动作**
  // 会因新增 `https` 而被判 `FABRICATED_ENTITY` 并**拒绝导出**。
  // 剥离是安全的：URL 里的真实技术信息（如 `github.com`）本就不是技能主张；
  // 而"新增了一个没做过的项目仓库"由 URL 文本本身的比对负责（仍会报 warn）。
  // ⚠️ **顺序有关**：必须先剥**邮箱**，再剥带协议的 URL，最后剥裸域名。
  // 反例（实测踩到）：若先跑"裸域名"规则，`liuyang@example.com` 中的
  // `example.com` 会先被吃掉，剩下 `liuyang@`，于是邮箱规则再也匹配不上，
  // `liuyang` 反而被当成专名提取出来。
  const withoutUrls = src
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, ' ') // ① 邮箱（先）
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s)\]<>"'，。；、）】]+/g, ' ') // ② 带协议的 URL
    .replace(/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|cn|org|net|io|dev|co|edu|gov|me|info|xyz|top)\b(?:\/[^\s)\]<>"'，。；、）】]*)?/gi, ' ') // ③ 裸域名
  for (const rawLine of withoutUrls.split('\n')) {
    const line = rawLine.replace(/^[\s>*\-+#]+/, '').replace(/\*\*/g, '')
    const words = line.split(/[^A-Za-z0-9.+#/-]+/).filter((w) => w !== '')
    const cjkLine = containsHan(line)
    // 该行是否像"英文句子"（含小写起头的普通单词）。
    //
    // 【为什么要区分（本轮实测抓出的漏报）】
    // 纯拉丁**列表行**（`HTML / CSS / JavaScript`）的行首词也是技术名，
    // 却被"跳过行首"规则吃掉——实测 `- SQL / HTML / CSS` 里 `SQL` 完全没被提取，
    // 于是"行首新增一个技术名"漏报。
    // 而真正的英文句子（`Developed features using React`）行首词确实无法区分
    // 专名与句首大写，必须跳过。
    // 判据：该行若含"小写起头的词"，视为句子；否则视为技术名列表。
    const looksLikeSentence = words.some((w) => /^[a-z]/.test(w) && w.length >= 3)
    for (let i = 0; i < words.length; i += 1) {
      // 剥离尾部句点等标点：'Kubernetes.' 应识别为 'Kubernetes'
      const w = words[i].replace(/[.]+$/, '')
      if (w === '') continue
      // 必须是拉丁词（含字母），且不是纯数字/纯符号
      if (!/^[A-Za-z0-9.+#/-]*[A-Za-z][A-Za-z0-9.+#/-]*$/.test(w)) continue
      if (cjkLine) {
        // 中文行：位置与大小写都不可靠，全部交给词表过滤
        if (isLatinIdentifierCandidate(w)) out.add(w)
        continue
      }
      // 英文行：首字母大写才算候选
      if (!/^[A-Z][A-Za-z0-9.+#/-]*$/.test(w)) continue
      // 仅对"英文句子"跳过行首词；技术名列表行的行首同样是技术名
      if (i === 0 && looksLikeSentence) continue
      if (!isLatinIdentifierCandidate(w)) continue
      out.add(w)
    }
  }
  return out
}

/**
 * 判断某候选是否作为**完整 token** 出现在原文中（大小写不敏感）。
 *
 * 【为什么必须按词边界匹配，不能用裸子串（独立审查抓出，属"改了一半"）】
 * 早期实现是 `haystack.toLowerCase().includes(candidate.toLowerCase())`，
 * 即**整篇原文的裸子串判定**。我后来把"与实体集合比对"改成精确匹配，
 * 却漏掉了这条短路，于是**从已有技术名里截掉一段**仍被放行：
 * ```
 *   JavaScript → Java      （'javascript'.includes('java') 为真）
 *   TypeScript → Script
 *   PostgreSQL → Postgres
 *   MongoDB   → Mongo
 *   ReactNative → React
 * ```
 * 这类"截断替换"把候选的技术栈降级/换名，同样是与事实不符的编造。
 * 修复后判定改为**带 token 边界**的匹配：候选前后不得紧邻词字符，
 * 这样 `Java` 不再匹配 `JavaScript`，而 `redis` 仍能匹配原文的 `Redis`
 * （大小写不敏感），真正做到与注释一致的"精确比对"。
 *
 * @param {string} candidate 候选
 * @param {string} haystack 原文
 * @returns {boolean} 是否作为完整 token 出现
 */
function appearsIn(candidate, haystack) {
  if (candidate === '') return true
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 边界字符集：字母、数字、下划线视为"词内字符"
  const re = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i')
  return re.test(haystack)
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
  // 因此对**中文机构名**不要求"完全相同"，而采用**包含判定**：
  // 候选与任一原文实体存在包含关系，即视为同一实体，不算编造。
  //
  // 这样两类真实场景都能正确处理：
  //   - 改写后机构名前后接了动词 → 包含原文实体 → 放行（不误报）
  //   - 改写引入了原文没有的机构/专名 → 与任何原文实体都无包含关系 → 判为编造
  //
  // 【⚠️ 但包含判定**不得用于拉丁专名**（本轮实测抓出的真实漏报）】
  // 拉丁技术名是**完整 token**，不存在"被动词拼接"的问题，
  // 而子串包含会制造严重漏报：
  //   `CSS` → `SCSS`（技术栈替换）被判为"已知实体"而放行，
  //   因为 `'scss'.includes('css')` 为真。
  //   —— 等于放行"把没学过的技术写进简历"。
  //
  // 【⚠️ 这里的判定分两层，缺一不可（独立审查抓出"只改了一半"）】
  //   第 1 层：`appearsIn` 必须是**带 token 边界**的匹配。
  //     早期它是整篇原文的裸子串判定，我最初只改了第 2 层，
  //     导致 `JavaScript → Java`、`PostgreSQL → Postgres` 这类**截断换名**
  //     仍被放行（`'javascript'.includes('java')` 为真）。
  //   第 2 层：与 `originalEntities` 集合比对时用精确相等（下面这段）。
  //   两层都到位后，"拉丁专名精确比对"这句话才与实现一致。
  const isHanCandidate = (/** @type {string} */ s) => /[\u4e00-\u9fa5]/.test(s)
  const isKnownEntity = (/** @type {string} */ candidate) => {
    // 第 1 层：作为独立 token 出现在原文中即可（含大小写变化）
    if (appearsIn(candidate, originalText)) return true
    const low = candidate.toLowerCase()
    // 第 2 层：与某个已知拉丁实体完全相同
    if (!isHanCandidate(candidate)) {
      for (const known of originalEntities) {
        if (isHanCandidate(known)) continue
        if (known.toLowerCase() === low) return true
      }
      return false
    }
    // 中文机构名：保留包含判定（无词边界，必须容忍前后缀）
    for (const known of originalEntities) {
      const k = known.toLowerCase()
      if (k !== '' && (low.includes(k) || k.includes(low))) return true
    }
    return false
  }

  // ── 2. 编造实体（机构 / 专名）───────────────────────────────────
  //
  // 【为什么最终用"结构性判据"而非枚举名单（独立审查推动的第三次修正）】
  // 前两版都靠**枚举**决定某个拉丁词该判 error 还是 warn
  // （"具体技术"进 error、"通用概念"进白名单）。审查实测证明这条路走不通：
  // 20 个最典型的"中文术语 → 英文缩写"ATS 对齐动作里 **13 个仍被拒绝导出**
  // （`超文本传输协议` → `HTTP`、`结构化查询语言` → `SQL`、`云服务平台` → `AWS`…），
  // 因为"中文术语 ↔ 英文缩写"是**开放集合**，枚举必然滞后。
  // —— 与本项目 `check-secrets` 早已吸取的教训同构（那里也改成让 git 回答，
  //    而不是维护名单）。
  //
  // 【三个结构信号，按"改写单元 ↔ 原文单元"逐对比较】
  // 只看客观事实，不看词表：
  //   ① **原有实体消失** → 技术名被替换（`Vue2 → React`、`CSS → SCSS`）
  //      → 技术栈变了，是事实性改动 → **error**
  //   ② **中文字数显著增长** → 该词是靠"多写了一句主张"引入的
  //      （`使用原生 JS 实现列表渲染` → `TypeScript 工程化改造，使用原生 JS…`）
  //      → 这是在增加技能主张 → **error**
  //   ③ **原有实体仍在、中文字数未增长** → 只是把中文术语并列成英文写法
  //      （`超文本传输协议（HTTP）`、`结构化查询语言` → `SQL`）
  //      → ATS 对齐的常规动作 → **warn**（提示不阻断）
  //
  // 三条实测覆盖 13/13 个真实样例（见 `test/node/guard.test.js` 的对应用例）。
  // 残留边界：纯编造若"不增字数也不替换"（如原文 `- 熟悉 HTML 与 CSS；`
  // 写成 `- 熟悉 HTML 与 CSS，熟悉 SQL；` 之中文字数确实增长，故仍被 ② 拦下），
  // 反之如果模型把编造写得与原文几乎同长，则只能降级为 warn——已写入
  // {@link GUARD_LIMITATIONS}。
  const hanCount = (/** @type {string} */ s) => (s.match(/[\u4e00-\u9fa5]/g) ?? []).length
  /**
   * 两句之间**最长连续汉字公共子串**的长度。
   *
   * 用途：判断某条原文句的中文内容是否被**另一条改写句**成段保留
   * （用于区分"收缩写法"与"纯增量"——见 `verifyRewrite` 第 2 项的说明）。
   *
   * 为什么用"连续汉字段"而不是整句相似度：套话（`熟悉…的使用；`）会让
   * 相似度虚高，而连续汉字段能反映"实义内容是否被复述"。
   *
   * @param {string} a 文本 A
   * @param {string} b 文本 B
   * @returns {number} 最长连续汉字公共子串长度
   */
  const longestSharedHanRun = (a, b) => {
    const runs = (/** @type {string} */ s) => s.match(/[\u4e00-\u9fa5]{2,}/g) ?? []
    let best = 0
    for (const ra of runs(a)) {
      for (const rb of runs(b)) {
        for (let i = 0; i < ra.length; i += 1) {
          for (let j = i + best + 1; j <= ra.length; j += 1) {
            if (rb.includes(ra.slice(i, j))) best = j - i
          }
        }
      }
    }
    return best
  }
  /**
   * 在句子中按 **token 边界**定位实体，返回其起始下标；找不到返回 -1。
   *
   * 【为什么不能用 `indexOf`（独立审查抓出的真实误报）】
   * `unit.indexOf('SQL')` 在 `熟悉 MySQL / 结构化查询语言（SQL）` 里
   * 命中的是 **`MySQL` 内部的 `sql`**，于是注记位判断取到了 `" My"` 而非 `"（"`,
   * 结果把合法的 `（SQL）` 注记判成"新增技能"并**拒绝导出**。
   * `MySQL` 与 `SQL` 同现恰是简历里最常见的组合，故这不是边角案例。
   * 现改为带边界的正则定位，与 {@link appearsIn} 的判据保持一致。
   *
   * @param {string} unit 句子
   * @param {string} entity 实体
   * @returns {number} 实体作为完整 token 出现的下标；未出现为 -1
   */
  const indexOfToken = (unit, entity) => {
    if (entity === '') return -1
    const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i').exec(unit)
    return m === null ? -1 : m.index
  }
  /**
   * 判断实体是否处于"中文术语旁的并列注记位"（`（HTTP）`、`/ CI`）。
   *
   * 这类形态是把中文说法与英文写法并列——ATS 关键词对齐的常规动作。
   *
   * 【只认括号与斜杠，**不认冒号/顿号**（实测抓出的绕过）】
   * `技能含：Redis`、`掌握、Kafka` 这类是"引出新一项"，不是并列注记；
   * 若把 `：`、`、` 计入注记位，就会把"新增技能"误放行。
   * 判据收紧为：紧邻的必须是**左括号**或**斜杠**。
   *
   * 【多词注记：只认"全大写缩写 + 它的展开"】
   *
   * 两类多词括号内容在**是否新增技能主张**上有本质差别，必须分开对待：
   *   · 展开已有缩写：`JVM（Java Virtual Machine）`、`GPA（Grade Point Average）`
   *     —— 括号里是**已有缩写**的全称，没有声称任何新技能。
   *   · 借括号夹带新技能：`数据库（Redis Cluster）`、`Java（Just Another …）`
   *     —— 括号里是**原文没有的技能**，属真正的编造。
   *
   * 判据：括号前必须是**全大写缩写**（至少两个大写字母），
   * 且括号内各词首字母拼起来等于它。
   *
   * 【为什么要求"全大写"是必要的（实测抓出的泄漏）】
   * 只看"首字母匹配"不够——`Java` 的首字母拼写恰好也是 `JAVA`，于是：
   *   `Java（Just Another Vague Abbreviation）` → 首字母 JAVA 匹配 `Java` → 被放行
   *   `Java（Java Application Virtual Architecture）` → 同样被放行
   * 而 `Java` 本身已是**完整词**、不是缩写，给它"展开全称"只可能是编造。
   * 真正的展开对象都是缩写（`JVM`/`GPA`/`HTTP`），故要求括号前为全大写形式
   * （允许带点号，如 `J.V.M`）。这条同时挡住了上面两例。
   *
   * 括号前是**中文**时无法做这种校验（中文无首字母），
   * 故一律按"新增主张"处理（严格侧）——这类是真正的夹带通道，
   * 代价是 `超文本传输协议（HyperText Transfer Protocol）` 会被误拦（已知误报）。
   *
   * @param {string} unit 句子
   * @param {string} entity 实体
   * @returns {boolean} 是否处于并列注记位
   */
  const isInlineAnnotation = (unit, entity) => {
    const at = indexOfToken(unit, entity)
    if (at < 0) return false
    // ① 紧邻左括号或斜杠：**中文术语并列英文写法**的常见形态。
    //
    // 【为什么要求"括号前是中文"（对抗性自测抓出的既有不一致）】
    // 早期只看"紧邻左括号"就放行，于是同一件事的判定取决于括号里写了几个词：
    //   `- 熟悉 Java；` → `- 熟悉 Java（Redis）的使用；`          ← 放行
    //   `- 熟悉 Java；` → `- 熟悉 Java（Redis Cluster）的使用；`   ← 拦住
    // 两者都声称了原文没有的 Redis，只因多写一个词就一放一拦。
    // 且前者（括号前是拉丁词 `Java`）根本不是"中文术语并列英文"形态。
    // 现要求括号前是**中文术语**（`超文本传输协议（HTTP）`），
    // 这才是真正的 ATS 并列动作；括号前是拉丁词时改由规则 ② 处理
    // （要求全大写缩写 + 其展开，`Redis` 不满足）。
    const before = unit.slice(Math.max(0, at - 3), at)
    if (/[（(【\[/]\s*$/.test(before)) {
      const beforeBracket = unit.slice(0, Math.max(0, at - 1))
      const lastToken = /([\u4e00-\u9fa5A-Za-z0-9.+#-]+)\s*$/.exec(beforeBracket)
      // 括号前是中文 → 中文↔英文并列，放行
      if (lastToken !== null && /[\u4e00-\u9fa5]/.test(lastToken[1])) return true
      // 斜杠并列（`持续集成 / CI`）仍算注记位
      if (/[/]\s*$/.test(before)) return true
      // 括号前是拉丁词 → 交给规则 ② 判断（多为编造，如 `Java（Redis）`）
    }
    // ② 多词注记：仅当括号内容是"括号前那个**全大写缩写**的展开"时才认
    const end = at + entity.length
    for (const m of unit.matchAll(/[（(【\[]([^）)】\]]*)[）)】\]]/g)) {
      const spanStart = m.index
      const spanEnd = spanStart + m[0].length
      if (at < spanStart || end > spanEnd) continue
      const inner = m[1]
      const words = inner.match(/[A-Za-z]+/g) ?? []
      if (words.length < 2) continue
      // **要跳过数字**：`GPA 3.6/4.0（Grade Point Average）` 里
      // 紧跟括号的是数值，缩写 `GPA` 在更前面（实测踩到）。
      let beforeSpan = unit.slice(0, spanStart)
      let prev
      do {
        prev = beforeSpan
        beforeSpan = beforeSpan.replace(/[\s\d.,%/]+\s*$/, '')
      } while (beforeSpan !== prev)
      const outer = /([A-Za-z][A-Za-z0-9.+#-]*)\s*$/.exec(beforeSpan)
      if (outer === null) continue // 括号前不是拉丁词 → 严格处理
      const acronym = outer[1]
      // 必须是**全大写缩写**（≥2 个大写字母、无小写字母）。
      // 这挡住 `Java（Just Another …）` 这类：Java 不是缩写，不该有"全称"。
      if (!/^[A-Z][A-Z0-9.]*$/.test(acronym) || acronym.replace(/\./g, '').length < 2) {
        continue
      }
      // 取括号内**所有大写字母**（而非每个词的首字母）——
      // 因为 `HyperText Transfer Protocol` 的缩写是 `HTTP`（HyperText 贡献 H 与 T），
      // 只取首字母会得到 HTP 而误判。用"所有大写字母"对两类都成立：
      //   `Grade Point Average` → GPA ✅、`HyperText Transfer Protocol` → HTTP ✅、
      //   `Just Another Vague Abbreviation` → JAVA（与 `HTTP` 不符，正确拦下）✅
      const capsInInner = (inner.match(/[A-Z]/g) ?? []).join('')
      if (capsInInner === acronym.replace(/\./g, '')) return true
    }
    return false
  }
  const fabricatedEntities = [...rewrittenEntities].filter((e) => !isKnownEntity(e)).sort()

  // 全部改写行（含**未达内容单元阈值**的短行）——用于"保留检查"。
  // 短行也必须纳入：编造常常就发生在短行里（`- 熟悉 SQL；`）。
  const allRewrittenLines = normalizeText(rewrittenText)
    .split('\n')
    .map((l) => l.replace(/^\s*[-*+]\s+/, '').trim())
    .filter((l) => l !== '')

  /**
   * 判定"中文换成缩写"（收缩写法）所需的最小汉字下降量。
   * 真正的缩写收缩会少 5~7 个汉字；而"另起一行新增技能"因共享套话只少 0~1 个。
   */
  const HAN_DROP_MIN = 4

  /**
   * 判断某改写行是否为"**收缩写法**"（把原文的中文术语换成英文缩写）。
   * 依据是**与配对无关的结构事实**：
   *   ① 原文存在一条中文显著更多的句子（下降 ≥ {@link HAN_DROP_MIN}）；且
   *   ② 那条原文句的中文**没有被任何其它改写行成段保留**
   *      （说明它就是被本行替换掉的，而不是"原文照旧 + 多出一句"）。
   *
   * 【为什么必须加条件 ②（独立审查抓出的两次绕过）】
   * 只看 ① 会被绕：编造行因共享套话（`熟悉…；`）配到一条长中文原句，
   * "比它短"就被当成收缩，凭空多写的技能照旧投递出去。
   * 条件 ② 才抓住本质——"收缩"只能解释"原有内容变短了"，
   * **不能解释"原文内容仍原封不动、同时又多出一句"**。
   *
   * 本函数被三处共用（短行分支、未配对分支、收缩分支），
   * 各写一份会导致行为漂移（这一处已经因此改过四次）。
   *
   * @param {string} line 改写行（原始行文本）
   * @returns {boolean} 是否为收缩写法
   */
  const isContractionLine = (line) => {
    const lineHan = hanCount(line)
    const originalUnitsLocal = extractContentUnits(originalText)
    const flatLine = normalizeForSimilarity(line)
    return originalUnitsLocal.some((ou) => {
      if (hanCount(ou) - lineHan < HAN_DROP_MIN) return false
      const flatOrig = normalizeForSimilarity(ou)
      const retainedElsewhere = allRewrittenLines.some((other) => {
        if (other === line) return false
        const flatOther = normalizeForSimilarity(other)
        // 用**整行**比较，而不是只看连续汉字段。
        //
        // 【为什么不能用"最长连续汉字段"（实测踩到）】
        // 拉丁词会把中文切成短段：
        //   `熟悉 Java 与 MySQL 的使用；` → 连续汉字段只有 `熟悉`（2）与 `的使用`（3）
        // 于是**原句被逐字保留**时，最长共享汉字段也只有 3，
        // 低于阈值 4 → 保留检查失灵 → 编造行被误判为收缩。
        // 故改为对**整行（含拉丁词）**做比对：
        //   · 其它行与原文句高度相似（含完全相同）→ 原句被保留 → 本行是纯增量
        //   · 否则原句确实被本行替换掉了 → 收缩
        if (flatOther === flatOrig) return true
        const shared = longestSharedHanRun(other, ou)
        if (shared >= HAN_DROP_MIN) return true
        return containment(charBigrams(flatOther), charBigrams(flatOrig)) >= 0.9
      })
      return !retainedElsewhere
    })
  }

  if (fabricatedEntities.length > 0) {
    const rewrittenUnits = extractContentUnits(rewrittenText)
    const originalUnits = extractContentUnits(originalText)
    /** @type {string[]} */
    const replacedList = []
    /** @type {string[]} */
    const inflationList = []
    /** @type {string[]} */
    const noteList = []

    for (const entity of fabricatedEntities) {
      const newUnit = rewrittenUnits.find((u) => appearsIn(entity, u))
      if (newUnit === undefined) {
        // 该技术名只出现在**无法成为内容单元的短行**里（长度 < 8 字，
        // 如 `- 熟悉 SQL；`）。这类短行不参与逐条比对，故拿不到配对原句。
        //
        // 【为什么不能一律判 error（独立审查抓出的真实死锁）】
        // "技能区短行里的中文术语换成英文缩写"是最核心的 ATS 对齐动作：
        //   `- 熟悉超文本传输协议；` → `- 熟悉 HTTP；`
        //   `- 熟悉统一资源定位符；` → `- 熟悉 URL；`
        // 若一律判 error，20 个常见 ATS 术语里有 **16 个被拒绝导出**——
        // 用户视角是"把技能名换成英文写法后导不出来"，与 S1-1 同类死锁。
        //
        // 【为什么也不能一律放行（同一位审查抓出的对称缺陷）】
        // 凭空多写的一行也常常是短行（`- 熟悉 SQL；`），
        // 它与"合法收缩"的文本**完全一样**。故必须用结构事实区分：
        //   · 收缩：原文那条中文句**已被本行替换**（别处不再出现）→ warn
        //   · 新增：原文那条中文句**仍原封不动**（本行是纯增量）→ error
        // 这正是 {@link isContractionLine} 的判据。
        const rawShortLine = allRewrittenLines.find((l) => appearsIn(entity, l))
        if (rawShortLine !== undefined && isContractionLine(rawShortLine)) {
          noteList.push(entity)
        } else {
          inflationList.push(entity)
        }
        continue
      }
      // 找这条改写单元的原文对应句（最相似者）
      let bestUnit = ''
      let best = 0
      for (const ou of originalUnits) {
        const score = containment(
          charBigrams(normalizeForSimilarity(newUnit)),
          charBigrams(normalizeForSimilarity(ou)),
        )
        if (score > best) {
          best = score
          bestUnit = ou
        }
      }
      const aligned = best >= NOVEL_UNIT_THRESHOLD && bestUnit !== ''
      // ⓪ 「新增技能」判定：该技术名在**原文全篇**都不存在，
      //    且它所在的改写句**无法归因**到任何原文句（那条原文句里既没有该词，
      //    也没有它的中文等价说法可对齐）。
      //
      // 【为什么必须最先判、且必须压过下面的字数启发式（独立审查抓出的真实绕过）】
      // 早期把"新增技能"的严重级交给了**中文字数增长比**这个代理信号，
      // 于是严重级**随折行形状漂移**，同一份编造换个排版就从"拒绝"变"放行"：
      //   原文 `- 熟悉 Java 与 MySQL 的使用；`
      //   · `- 熟悉 Java 与 MySQL 与 Redis 的使用；` → 增长比 0.20 > 0.1 → error ✅
      //   · `- 熟悉 Java 与 MySQL 的使用；` + `- 熟悉 Redis 的使用；`
      //     → 新行仅有 5 个汉字、比值 0.000 → **warn → 可导出** ❌
      // 而"多加一行技能"恰恰是本项目最该拦的编造类型。
      // 判据改为**结构性归因**：只要该词在原文全篇找不到出处，
      // 且它出现的改写句没有可归因的原文句（说明这一行是新增的），
      // 就是"新增技能"→ error。这样严重级不再取决于连接词或排版。
      const existsInOriginal = appearsIn(entity, originalText)
      if (!existsInOriginal && !aligned) {
        // 【为什么还要问"是否像收缩"（独立审查抓出的真实死锁）】
        // 仅凭"未能配对"就判 error，会误伤**技能区短行把中文换成缩写**——
        // 这是最核心的 ATS 对齐动作，但短行（如 `- 熟悉 HTTP；` 仅 8 字、
        // `- 熟悉 SQL；` 仅 6 字）常因信息量太少而配不上对，于是被判成新增技能：
        //   `- 熟悉超文本传输协议；` → `- 熟悉 HTTP；`  ✘ 被拒绝导出
        // 实测 20 个常见 ATS 术语里 **16 个被拒**，用户视角是
        // "把技能名换成英文写法后导不出来"——与 S1-1 同类死锁。
        //
        // 故先查证**原文是否存在一条可收缩的中文长句**（结构事实，与配对无关）：
        // 若存在且其中文显著多于本行、且该原文句未被别处保留 → 收缩 → warn；
        // 否则才是真正的凭空新增 → error。
        if (!isContractionLine(newUnit)) {
          inflationList.push(entity)
          continue
        }
        // 落到这里说明像是收缩写法：继续走下面的注记/收缩判定（最终报 warn）。
      }
      // ① 替换：对齐到的原文句里有实体在**这批改写句**里消失了。
      //
      // ⚠️ 三点都必须注意（全部由实测/独立审查抓出）：
      //   a) 必须同时检查**中文机构名**，不能只看拉丁专名——
      //      `在某互联网公司实习` → `在字节跳动公司实习` 只有中文机构名变化，
      //      只看拉丁专名会把这类最典型的编造降级成 warn（`check:guard` 抓出）。
      //   b) 必须用**全部拉丁 token**（含被降级为 warn 的那些）来判"消失"，
      //      不能只用 error 级候选集——`REST → GraphQL` 里 `REST` 属降级词，
      //      若只在 error 候选集里比，就看不到 `REST` 消失，替换被判成"新增"。
      //   c) 判"是否消失"的范围既不能是本句、也不能是全篇，而应是
      //      **所有对齐到同一原文句的改写句之并集**。三者的区别很关键：
      //        · 本句级（`newUnit`）：**折行**时会把折到兄弟行的词误报为"被替换"
      //          ——实测 `- 熟悉 Java / MySQL；` + `- 熟悉 MySQL 与 Redis；`
      //          会报「Java → Redis」并**拒绝导出**（与 ATS 注记叠加即死锁）。
      //        · 全篇级（`rewrittenText`）：会把"在某一行偷偷换掉技术名、
      //          但技能区恰好还留着旧名"的替换**漏掉**——实测 fixture 上
      //          `Vue2 → React` 因技能区仍有 `Vue2` 而被放行（回归测试抓出）。
      //        · 配对组级（本实现）：折行属"同一句话被分散到多行"，
      //          词仍在组内 → 不算替换；而句内换成别的词 → 组内确实没了 → 判替换。
      const allLatinTokens = (/** @type {string} */ s) => {
        const out = new Set()
        for (const raw of s.split(/[^A-Za-z0-9.+#/-]+/)) {
          const w = raw.replace(/[.]+$/, '')
          if (w === '' || !/[A-Za-z]/.test(w)) continue
          // 排除纯数字/数字开头的单位写法（`2.4s`）
          if (!/^[A-Za-z]/.test(w)) continue
          out.add(w)
        }
        return out
      }
      /** 所有最佳对齐到 `bestUnit` 的改写句（含折行产生的兄弟句）。 */
      const siblingUnits = rewrittenUnits.filter((u) => {
        let b = 0
        let bi = ''
        for (const ou of originalUnits) {
          const s = containment(
            charBigrams(normalizeForSimilarity(u)),
            charBigrams(normalizeForSimilarity(ou)),
          )
          if (s > b) {
            b = s
            bi = ou
          }
        }
        return bi === bestUnit && b >= NOVEL_UNIT_THRESHOLD
      })
      const groupText = siblingUnits.length > 0 ? siblingUnits.join('\n') : newUnit
      const lostHere = aligned
        ? [
            ...new Set([
              ...allLatinTokens(bestUnit),
              ...extractChineseOrgNames(bestUnit),
            ]),
          ].filter((e) => {
            // 中文机构名带后缀（`某互联网公司`），用包含判定比较更稳
            if (containsHan(e)) {
              return !groupText.toLowerCase().includes(e.toLowerCase())
            }
            return !appearsIn(e, groupText)
          })
        : []
      if (lostHere.length > 0) {
        replacedList.push(`${lostHere.join('、')} → ${entity}`)
        continue
      }
      const origHasHan = hanCount(bestUnit) > 0
      const newHan = hanCount(newUnit)
      const oldHan = hanCount(bestUnit)

      // ② ATS 注记形态：新增词紧贴在**括号/斜杠**注记位里。
      //    例：`超文本传输协议（HTTP）`、`持续集成 / CI`、`结构化查询语言（SQL）`。
      //    这是"中文术语并列英文写法"，关键词对齐的常规动作 → 放行（warn）。
      //    必须先判这条：注记不改变中文字数，下面的收缩判据覆盖不到它。
      if (aligned && isInlineAnnotation(newUnit, entity)) {
        noteList.push(entity)
        continue
      }
      // ③ 收缩写法：中文字数**绝对下降显著**，且**配对原句的内容没有被别处保留**
      //    → 是把原有中文术语换成了缩写
      //    （`熟悉超文本传输协议，负责接口开发工作；` → `熟悉 HTTP，负责接口开发工作；`）
      //    → 等价写法，放行（warn）。这一侧只可能"少写了内容"，不含新增主张。
      //
      // 【判据演进（四次绕过后的最终定论，务必连注释一起读）】
      // 先是用"下降比例 > 10%"，再是"绝对下降量 ≥ 4"——**两者都被绕过了**，
      // 因为下降量是**相对配对句**算的，而共享套话（`熟悉…的使用；`）会把编造行
      // 配到一条**更长的中文原句**上，于是"比它短 7 个汉字"被误当成收缩：
      // ```
      //   原文：- 熟悉结构化查询语言 的使用；        （汉字 12）
      //   改写：- 熟悉结构化查询语言 的使用；        （原句逐字保留）
      //         - 熟悉 Redis 的使用；                （汉字 5，下降 7 ≥ 4）
      // ```
      // → 只报 warn → **`exportResume` 导出成功且 `verified=true`**，
      // 凭空多写的技能被投递出去。真实简历的技能区正是这种长中文句，
      // 故触发面很广（实测 6 种长中文句 × 4 个技术名全部可绕过）。
      //
      // **根本约束**："收缩"只能解释"原有的内容变短了"，
      // **不能解释"原文的内容仍原封不动、同时又多出一句"**。
      // 因此先检查配对原句的中文内容是否已被**其它改写行**成段保留：
      //   · 已被保留（上例第一行与原句共享 9 个连续汉字）→ 本行是**纯增量** → error
      //   · 未被保留（真收缩时原句被本行替换掉了，其它行与它共享 0 字）→ 收缩 → warn
      // 实测该信号在两类场景上区分度充分（保留 9 vs 保留 0）。
      const hanDrop = oldHan - newHan
      // 注意：这里**不要求 `aligned`**。
      //
      // 短行（如 `- 熟悉 HTTP；`、`- 熟悉 SQL；`）常因信息量太少而配不上对
      // （相似度低于阈值 0.25），若要求配对成功才允许按"收缩"放行，
      // 这些**最核心的 ATS 对齐动作**就会落进下面的 error 兜底——
      // 实测 20 个常见术语里 16 个被拒绝导出（与 S1-1 同类死锁）。
      // 而"收缩"是**与配对无关的结构事实**，判据统一收敛到
      // {@link isContractionLine}（含"原文句未被别处保留"这一必要条件），
      // 三处分支共用同一函数，避免各写一份导致行为漂移。
      if (origHasHan && hanDrop >= HAN_DROP_MIN && isContractionLine(newUnit)) {
        noteList.push(entity)
        continue
      }
      // ④ 其余一律判为**新增技能/技术主张** → error。
      //    走到这里的前提是：该词在**原文全篇都不存在**（`fabricatedEntities` 的定义），
      //    且既不在括号/斜杠注记位、也不是"中文显著换成缩写"的收缩写法。
      //    此时它只能是凭空多写的一项技能——这正是本项目最该拦的编造。
      //    这样严重级不再取决于连接词、折行方式或行文措辞。
      inflationList.push(entity)
      continue
    }

    if (replacedList.length > 0) {
      findings.push({
        code: 'FABRICATED_ENTITY',
        severity: 'error',
        message:
          `改写后技术名被替换：${replacedList.join('、')}。` +
          '技术栈属于事实字段——替换等于声称掌握了别的技术，面试会被问穿。',
        evidence: replacedList,
      })
    }
    if (inflationList.length > 0) {
      findings.push({
        code: 'FABRICATED_ENTITY',
        severity: 'error',
        message:
          `改写后新增了原文没有的技术名/专名：${inflationList.join('、')}，` +
          '且对应表述明显变长（是在增加技能主张，而非把中文术语并列成英文写法）。' +
          '新增技能需能在原文找到出处，否则删除。',
        evidence: inflationList,
      })
    }
    if (noteList.length > 0) {
      findings.push({
        code: 'AMBIGUOUS_NEW_TERM',
        severity: 'warn',
        message:
          `改写后出现 ${noteList.length} 个原文没有的机构/专名：${noteList.join('、')}。` +
          '原文对应的技术名都仍在、表述长度也未明显增加，因此这**通常**是"中文术语并列英文写法"的 ' +
          'ATS 对齐动作；但也可能是新增技能。**请人工确认**是否属实。',
        evidence: noteList,
      })
    }
  }

  // ── 2d. 容量单位大小写变化（warn 级：bit / byte 语义不同）─────────────
  //
  // 【为什么单列一项（独立审查发现）】
  // 单位归一化表用了 `/^(?:mb|兆字节)$/i` 之类的大小写不敏感正则，
  // 于是 `2MB`（2 兆字节）与 `2Mb`（2 兆比特）被归一为同一数值——
  // 但两者相差 **8 倍**。实测 `2MB → 2Mb` 此前 `ok=true`、`findings=[]`，
  // **完全静默**，比 `HTML → 标记语言`（至少 warn）还宽松，标准不一致。
  //
  // 为什么取 warn 而非 error：`KB/kb`、`MB/mb` 这类大小写混写在简历里很常见，
  // 多数人写的就是同一个意思；判 error 会造成误报死锁（本项目最坏的缺陷类型）。
  // 但 `b` 与 `B`（bit vs byte）确实相差 8 倍，属"用户不会注意、事实已变"，
  // 必须给出提示——目标是**消除静默**，而不是阻断交付。
  {
    /**
     * 抽取"数字 + 单位"对，**保留单位原始大小写**。
     *
     * 注意不能写成 `\d\s*mb`——`2Mb` 的 `M` 夹在数字与 `b` 之间，那样永远匹配不到。
     * 必须先吃掉完整单位 token，再比较大小写写法。
     * @param {string} s 文本
     * @returns {string[]} 形如 `2MB`、`1024kb` 的片段
     */
    const numberUnitPairs = (s) => {
      const out = []
      // 用**大小写不敏感**的字符类吃下整个单位 token（`MB`/`Mb`/`mb` 都要能匹配），
      // 大小写的差异留到后面比较时再判断。
      for (const m of s.matchAll(
        /(\d[\d,]*(?:\.\d+)?)\s*(bytes?|[kmg]b|b)(?![A-Za-z])/gi,
      )) {
        out.push(`${m[1]}${m[2]}`)
      }
      return out
    }
    const origPairs = numberUnitPairs(originalText)
    const newPairs = numberUnitPairs(rewrittenText)
    /** @type {string[]} */
    const caseChanged = []
    for (const op of origPairs) {
      const om = /^([\d,.]+)(.*)$/.exec(op)
      if (om === null) continue
      const [, oNum, oUnit] = om
      // 找同一数值 + 同一单位字母、但大小写不同的改写片段
      for (const np of newPairs) {
        const nm = /^([\d,.]+)(.*)$/.exec(np)
        if (nm === null) continue
        const [, nNum, nUnit] = nm
        if (oNum !== nNum) continue
        if (oUnit === nUnit) continue
        if (oUnit.toLowerCase() !== nUnit.toLowerCase()) continue
        const label = `${oNum}${oUnit} → ${nNum}${nUnit}`
        if (!caseChanged.includes(label)) caseChanged.push(label)
      }
    }
    const uniqueCase = [...new Set(caseChanged)]
    if (uniqueCase.length > 0) {
      findings.push({
        code: 'UNIT_CASE_CHANGED',
        severity: 'warn',
        message:
          `容量单位的大小写被改动：${uniqueCase.join('、')}。` +
          '`b` 与 `B` 分别表示比特与字节，二者**相差 8 倍**；' +
          '`KB/kb`、`MB/mb` 等则是同一含义的常见混写。' +
          '**请人工确认**是否为误改（尤其是 bit 与 byte 之间）。',
        evidence: uniqueCase,
      })
    }
  }

  // ── 2c. 技术名「被改写为中文表述 / 被删除」（独立于新增实体的检测）──────
  //
  // 【为什么必须单独一遍（独立审查抓出的结构性缺口，最严重的一条）】
  // 上面第 2 项的替换检测**包在 `fabricatedEntities` 循环里**，
  // 因此只有当改写"新增了某个拉丁实体"时才会执行。
  // 若消失的拉丁技术名被换成**纯中文表述**、且没有引入任何新拉丁词，
  // `fabricatedEntities` 为空 → 整个替换检测一次都不跑 → **完全静默**：
  //   `CSS` → `层叠要素表`、`Vuex` → `状态管理库`、`REST` → `表述性状态转移`
  // 这三例实测 `ok=true`、`findings=[]`。
  //
  // 而同样语义的 `CSS → SCSS`、`Vue2 → React` 判 error——行为不一致，
  // 且 `GUARD_LIMITATIONS` 并未声明"改成中文会静默"这一边界。
  // 对比审查还指出：既有测试全是"拉丁→拉丁"替换，**没有一条英文→中文用例**，
  // 所以 316 项全绿与这个缺口并存（本项目"流水线全绿而产品不可用"的同类教训）。
  //
  // 【严重级为什么取 warn 而不是 error（刻意的产品判断）】
  // "拉丁技术名消失且无新拉丁词接替"有两种含义，纯文本无法区分：
  //   a) 换成中文等义表述（`CSS` → `层叠要素表`）——用户会的技术没变，只是写法模糊
  //   b) 直接删掉这个技能（`HTML / CSS / JavaScript` → `HTML / JavaScript`）——精简
  // 两者都**没有凭空增加主张**，与"编造"性质不同；
  // 若判 error，会拦下"把技术名概括成中文"和"删掉不需要的技能"这类合法改写，
  // 造成用户拿不到文件（本项目最严重的一类缺陷）。
  // 故报 warn：消除静默（审查的核心诉求），但不阻断交付。
  {
    const replacedFromEntities = new Set(
      findings
        .filter((f) => f.code === 'FABRICATED_ENTITY')
        .flatMap((f) => f.evidence)
        .flatMap((e) => String(e).split(/[\s、→]+/))
        .filter((x) => x !== ''),
    )
    const latinTokensOf = (/** @type {string} */ s) => {
      const out = new Set()
      for (const raw of s.split(/[^A-Za-z0-9.+#/-]+/)) {
        const w = raw.replace(/[.]+$/, '')
        if (w === '' || !/^[A-Za-z]/.test(w)) continue
        if ((w.match(/[A-Za-z]/g) ?? []).length < 2) continue
        out.add(w)
      }
      return out
    }
    /** @type {string[]} */
    const vanished = []
    const rewrittenUnits = extractContentUnits(rewrittenText)
    const originalUnits = extractContentUnits(originalText)
    for (const newUnit of rewrittenUnits) {
      // 找该改写单元的原文对应句
      let bestUnit = ''
      let best = 0
      for (const ou of originalUnits) {
        const score = containment(
          charBigrams(normalizeForSimilarity(newUnit)),
          charBigrams(normalizeForSimilarity(ou)),
        )
        if (score > best) {
          best = score
          bestUnit = ou
        }
      }
      if (best < NOVEL_UNIT_THRESHOLD || bestUnit === '') continue
      const oldTokens = latinTokensOf(bestUnit)
      const newTokens = latinTokensOf(newUnit)
      // 原文该句有、**整篇改写结果**里都没有的拉丁技术名。
      //
      // 【⚠️ "消失"必须是全文级概念，不能用单元级（独立审查抓出的系统性误报）】
      // 最初写的是 `!appearsIn(t, newUnit)`——即"本句里没有"。于是**折行/拆分**
      // 这类最常规的改写会误报：
      //   原文：`- 熟悉 Java / Spring Boot / MySQL / Redis / Kafka 的使用；`
      //   改写：`- 熟悉 Java / Spring Boot / MySQL；`
      //         `- 熟悉 Redis / Kafka 的使用；`
      //   6 个词**全部仍在**（只是折到兄弟行），却被断言"6 个技术名消失"。
      // 这是**事实错误的告警**——用户会去"补回"一个从未消失的技术名，
      // 与本项目"不制造虚假安全感"的原则直接冲突。
      // 故改为在 `rewrittenText`（全文）里查证。
      const lost = [...oldTokens].filter((t) => !appearsIn(t, rewrittenText))
      if (lost.length === 0) continue
      // 该单元里是否有**新的**拉丁词接替（那就属于第 2 项已处理的替换，不重复报）。
      // 这一条保持**单元级**：它问的是"这句话是不是被换成了别的技术名"。
      const fresh = [...newTokens].filter((t) => !appearsIn(t, bestUnit))
      if (fresh.length > 0) continue
      // 已被第 2 项报过的不再重复
      for (const t of lost) {
        if (!replacedFromEntities.has(t)) vanished.push(t)
      }
    }

    // 【兜底：全文级扫描（本轮自查抓出的残留静默）】
    // 上面的循环只走**内容单元**（长度 ≥ 8 字），因此短行里的技术名不在覆盖内：
    //   `- CSS；` → `- 层叠样式表；`   ← 实测 `ok=true`、`findings=[]`（真静默）
    // `- 熟悉 CSS；` → `- 熟悉层叠样式表；` 同样静默。
    // 技术名列表与"技能：CSS"这类短行正是简历里最常见的形态，不能漏。
    // 故再做一次**全文级**扫描：原文出现、改写全文都没有的拉丁技术名，逐一报出。
    {
      const originalAllTokens = latinTokensOf(originalText)
      for (const t of originalAllTokens) {
        if (appearsIn(t, rewrittenText)) continue
        if (replacedFromEntities.has(t)) continue
        if (vanished.includes(t)) continue
        // 若该词在改写里被其它拉丁词接替（第 2 项已判 error），不重复报
        vanished.push(t)
      }
    }
    const uniqueVanished = [...new Set(vanished)]
    if (uniqueVanished.length > 0) {
      findings.push({
        code: 'VANISHED_TECH_TERM',
        severity: 'warn',
        message:
          `原文的 ${uniqueVanished.length} 个技术名在改写后消失，且该处没有出现其它技术名：` +
          `${uniqueVanished.join('、')}。` +
          '这可能是把它们改成了中文等义表述，也可能是删掉了这些技能——' +
          '两者都不算编造，故不阻断导出；但**请人工确认**是否是有意为之。' +
          '（若是为了规避检查而把技术名换成模糊的中文表述，请改回原文写法。）',
        evidence: uniqueVanished,
      })
    }
  }

  // ── 2b. 歧义标识符（warn 级：提示但不阻断交付）─────────────────
  //
  // 【为什么单独设一档（对抗性审查实测，两侧都是真实缺陷）】
  // 记号（`CI/CD`）、短缩写（`SDK`、`UX`）、普通英文词（`Excel`、`team`）
  // 在中文简历里既可能是**等价术语替换**（"持续集成" → "CI/CD"，
  // ATS 对齐的核心动作，判 error 会让用户拿不到文件），
  // 也可能是**凭空编造**（原文没有的技能硬写上去）。
  // 纯文本无法判定，故既不判 error（会死锁）也不静默放行（会留盲区），
  // 而是报 warn：信息给到人和模型，是否属实由人确认。
  //
  // 注意：第 2 项已把"机构/专名类"候选分派完毕（error 或 warn）。
  // 这里只处理**剩下那些**——泛指缩写/普通英文词，避免同一个词被报两次。
  const alreadyHandled = new Set(fabricatedEntities)
  const ambiguous = [...extractAmbiguousLatinTokens(rewrittenText)]
    .filter((e) => !appearsIn(e, originalText))
    .filter((e) => !alreadyHandled.has(e))
    .sort()
  if (ambiguous.length > 0) {
    findings.push({
      code: 'AMBIGUOUS_NEW_TERM',
      severity: 'warn',
      message:
        `改写后出现 ${ambiguous.length} 个原文没有的技术缩写/通用英文词：` +
        `${ambiguous.join('、')}。这类词常是中文术语的等价写法（如"持续集成" ↔ CI/CD），` +
        '可能是合法的 ATS 关键词对齐，也可能是新增技能，**请人工确认**是否属实。',
      evidence: ambiguous,
    })
  }

  // ── 3. 职责升格（比编数字更隐蔽的造假）─────────────────────────
  //
  // 逐条比对职责动词强度。改写若把「参与」升格为「主导」，
  // 属于事实性夸大——面试官追问"你怎么主导的"时会立刻暴露。
  //
  // 【判据的设计（三轮实测才定对）】
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
  //
  // 【为什么必须下推到内容单元级（外部审查发现 S2-1）】
  // 早期实现把上述判据作用在**全文**上，双向都会出错：
  //   - 漏报：改写把单条「参与」升格为「负责」，但文中另一行仍有「参与」，
  //     全文 minLevel 毫无变化 → 真升格被放过。
  //   - 误报：改写只是**删掉**一行含弱动词的行（合法压缩），
  //     全文 minLevel 被抬高 → 报升格并拒绝导出，报文还会自证矛盾
  //     （"原文最强为负责层，改写后最强为负责层"）。
  // 因此改为：先做「改写单元 ↔ 原文单元」配对，**逐对**比较；
  // 文档级聚合只在无法配对（无内容单元）时兜底。
  const LEADERSHIP_LEVEL = 4

  /**
   * 判断一对（原文单元 → 改写单元）是否构成职责升格。
   * @param {number} origMin 原文单元最弱层级
   * @param {number} origMax 原文单元最强层级
   * @param {number} newMin 改写单元最弱层级
   * @param {number} newMax 改写单元最强层级
   * @returns {boolean} 是否升格
   */
  const isPairInflation = (origMin, origMax, newMin, newMax) =>
    origMax === 0 ? newMax >= LEADERSHIP_LEVEL : newMin > origMin || newMax > origMax

  /** @type {Array<{ from: string, to: string, originalWeakest: string[], rewrittenWeakest: string[], fromLevel: number, toLevel: number }>} */
  const inflatedPairs = []
  /** 改写后新出现的职责主张（原文无对应单元） */
  /** @type {Array<{ to: string, rewrittenWeakest: string[] }>} */
  const inflatedNovel = []

  const pairings = matchUnitsToOriginal(originalText, rewrittenText)
  // 原文**全篇**出现过的职责动词。用于：
  //   ① 把报文里的层级说准（见下）；
  //   ② 判断"新出现的更强动词"是否为**新增主张**。
  //
  // 【为什么需要（真实简历实测抓出的两处问题）】
  // 问题一：报文自相矛盾。报文原先用 `originalWeakest`/`rewrittenWeakest`
  //   （**最弱层**的词）去查层级标签，但触发条件可能是 **maxLevel** 变化：
  //     `参与…完成 5 个接口` → `参与…独立完成 5 个接口`
  //   两侧最弱层都是「参与」（辅助层）→ 打印「辅助层 → 辅助层」，
  //   一边声称"被升格"、一边显示两层相同 —— **事实错误的断言**。
  // 问题二：合并导致误报（**拒绝导出**）。模型把两条原文并成一条时，
  //   配对只匹配到其中一条：
  //     原文：`- 校学生会宣传部干事，参与组织校级活动 5 场；`
  //           `- 担任班级团支书，负责班级日常事务协调。`
  //     改写：`- 校学生会宣传部干事、班级团支书，参与组织校级活动 5 场并负责班级日常事务。`
  //   合并句配对到**第一条**，其中的「负责」（负责层）被当成"新出现的强动词"
  //   → 判升格 → 拒绝导出。但「负责」在原文本就存在（第二条），
  //   这次合并**没有抬升任何主张**。
  const originalResponsibilityWords = new Set(
    extractResponsibilityLevel(originalText).hits.map((h) => h.word),
  )
  /**
   * 改写句里"层级高于原文最高层、且原文全篇从未出现过"的职责词。
   * @param {{ level: number, word: string }[]} rewrittenHits
   * @param {number} originalMaxLevel
   * @returns {boolean}
   */
  const hasGenuinelyNewStrongerWord = (rewrittenHits, originalMaxLevel) =>
    rewrittenHits.some(
      (h) => h.level > originalMaxLevel && !originalResponsibilityWords.has(h.word),
    )

  for (const pair of pairings) {
    const newResp = extractResponsibilityLevel(pair.rewritten)
    if (newResp.maxLevel === 0) continue
    const rewrittenWeakest = newResp.hits
      .filter((h) => h.level === newResp.minLevel)
      .map((h) => h.word)
    if (pair.original === null) {
      // 与原文任何单元都对不上：整条内容的新增由第 7 项报告，
      // 此处只在该行同时主张了原文没有的领导职责时补充报出，
      // 因为"凭空加一条含主导层动词的经历"是更严重的事实夸大。
      if (newResp.maxLevel >= LEADERSHIP_LEVEL) {
        inflatedNovel.push({ to: pair.rewritten, rewrittenWeakest })
      }
      continue
    }
    const oldResp = extractResponsibilityLevel(pair.original)
    // 判定分三种情形（不放松既有检测）：
    //   A) 原文该句**无任何职责动词**（maxLevel === 0）：
    //      只写到"负责层"→ 放行（`商品列表开发` → `负责商品列表开发`
    //      是把动作规整成简历惯用表述，既有用例锁定）；
    //      出现"主导层及以上"→ 判升格（凭空声称主导是更严重的夸大）。
    //   B) 最弱层被抬高（`参与` → `负责`）→ 判升格。
    //   C) 仅最强层被抬高 → **必须**是"原文全篇没出现过的更强动词"才算，
    //      否则只是把被合并那条原文里**本就存在**的强动词搬了过来。
    const shouldFlag =
      oldResp.maxLevel === 0
        ? newResp.maxLevel >= LEADERSHIP_LEVEL
        : newResp.minLevel > oldResp.minLevel ||
          (newResp.maxLevel > oldResp.maxLevel &&
            hasGenuinelyNewStrongerWord(newResp.hits, oldResp.maxLevel))
    if (shouldFlag) {
      // 报文用的层级：取改写句中"原文全篇未出现过"的最强职责词；
      // 若全部出现过（说明改的是位置而非强度），退回 maxLevel。
      const freshHits = newResp.hits.filter(
        (h) => !originalResponsibilityWords.has(h.word),
      )
      const reportedTo =
        freshHits.length > 0
          ? Math.max(...freshHits.map((h) => h.level))
          : newResp.maxLevel
      inflatedPairs.push({
        from: pair.original,
        to: pair.rewritten,
        originalWeakest: oldResp.hits
          .filter((h) => h.level === oldResp.minLevel)
          .map((h) => h.word),
        rewrittenWeakest,
        // 保证 from < to，报文不会自相矛盾
        fromLevel: Math.min(oldResp.maxLevel, reportedTo - 1),
        toLevel: reportedTo,
      })
    }
  }

  // 文档级兜底：仅在"内容单元不足以逐对比较"时使用。
  //
  // 为什么保留：标题、姓名、短行（< 8 字）不参与单元比对，
  // 若这些位置被塞进「主导」，逐对逻辑看不到。此时退回文档级判据
  // （仍是老的两方向判据），保证不出现"两套逻辑都覆盖不到"的空档。
  const unitCoverage = pairings.length > 0
  const originalResp = extractResponsibilityLevel(originalText)
  const rewrittenResp = extractResponsibilityLevel(rewrittenText)
  const docLevelInflation =
    !unitCoverage &&
    (originalResp.maxLevel === 0
      ? rewrittenResp.maxLevel >= LEADERSHIP_LEVEL
      : rewrittenResp.minLevel > originalResp.minLevel ||
        rewrittenResp.maxLevel > originalResp.maxLevel)

  // ── 3b. 合并导致的疑似升格（**warn 级，不阻断交付**）──────────────
  //
  // 见 {@link matchOriginalToUnits} 的说明：合并/拆条会让正向配对漏掉
  // 被合并掉的那条原文。反向配对能发现它，但**无法区分**"合并抬高职责"
  // 与"合法删掉了一行弱表述"——后者若判 error 就是投递死锁。
  // 故只报 warn：把可疑点交给人与模型确认，不阻断落盘。
  const mergeWatch = []
  const forwardMatched = new Set()
  for (const p of pairings) {
    if (p.original !== null) forwardMatched.add(p.original)
  }
  for (const p of matchOriginalToUnits(originalText, rewrittenText)) {
    // 正向已经逐对比较过的，不再重复提示
    if (forwardMatched.has(p.original) || p.rewritten === null) continue
    const oldResp = extractResponsibilityLevel(p.original)
    const newResp = extractResponsibilityLevel(p.rewritten)
    if (oldResp.maxLevel === 0 && newResp.maxLevel < LEADERSHIP_LEVEL) continue
    if (newResp.minLevel > oldResp.minLevel || newResp.maxLevel > oldResp.maxLevel) {
      mergeWatch.push({ from: p.original, to: p.rewritten })
    }
  }
  if (mergeWatch.length > 0) {
    findings.push({
      code: 'POSSIBLE_RESPONSIBILITY_INFLATION',
      severity: 'warn',
      message:
        `原文有 ${mergeWatch.length} 条内容在改写后找不到独立对应项，且其被并入的` +
        '表述职责更强：\n  ' +
        mergeWatch.map((m) => `「${m.from}」→「${m.to}」`).join('\n  ') +
        '\n**请确认**：这是"合并条目时抬高了职责"（须改回），' +
        '还是"删掉了较弱的表述"（合法精简）？代码无法区分这两者，故不阻断导出。',
      evidence: mergeWatch.map((m) => m.from),
    })
  }

  if (inflatedPairs.length > 0 || inflatedNovel.length > 0 || docLevelInflation) {
    /** @type {string[]} */
    const details = []
    /** @type {string[]} */
    const evidence = []
    for (const p of inflatedPairs) {
      // 【报文必须说清"哪一层被抬高"（自查抓出的自相矛盾断言）】
      // 早期这里用 `originalWeakest` / `rewrittenWeakest`（**最弱层**的词）
      // 去查层级标签，但触发条件可能是 **maxLevel** 变化：
      //   `参与…完成 5 个接口` → `参与…独立完成 5 个接口`
      //   两侧最弱层都是「参与」（辅助层）→ 报文打印「辅助层 → 辅助层」，
      //   一边声称"被升格"、一边显示两层相同 —— **事实错误的断言**（本项目最忌）。
      // 现改用记录下来的 fromLevel / toLevel（真正发生变化的层级）。
      const from = RESPONSIBILITY_LEVELS.find((t) => t.level === p.fromLevel)
      const to = RESPONSIBILITY_LEVELS.find((t) => t.level === p.toLevel)
      details.push(
        `「${p.from}」→「${p.to}」` +
          `（原职责为${from?.label ?? '未知'}，改写后为${to?.label ?? '未知'}）`,
      )
      evidence.push(...p.rewrittenWeakest)
    }
    for (const n of inflatedNovel) {
      details.push(`新增主张「${n.rewrittenWeakest.join('、')}」：${n.to}`)
      evidence.push(...n.rewrittenWeakest)
    }
    if (docLevelInflation) {
      const from = RESPONSIBILITY_LEVELS.find((t) => t.level === originalResp.maxLevel)
      const to = RESPONSIBILITY_LEVELS.find((t) => t.level === rewrittenResp.maxLevel)
      const originalWeakest = originalResp.hits
        .filter((h) => h.level === originalResp.minLevel)
        .map((h) => h.word)
      const rewrittenWeakest = rewrittenResp.hits
        .filter((h) => h.level === rewrittenResp.minLevel)
        .map((h) => h.word)
      details.push(
        originalResp.maxLevel === 0
          ? `原文未主张任何职责强度，改写后却出现「${to?.label ?? '未知'}」表述` +
              `（${rewrittenWeakest.join('、')}）`
          : `全文职责强度被抬升：原文最强为「${from?.label ?? '未知'}」` +
              `（最弱为「${originalWeakest.join('、')}」），改写后最强为` +
              `「${to?.label ?? '未知'}」（最弱为「${rewrittenWeakest.join('、')}」）`,
      )
      evidence.push(...rewrittenWeakest)
    }
    findings.push({
      code: 'RESPONSIBILITY_INFLATED',
      severity: 'error',
      message:
        `职责描述被升格（${details.length} 处）：\n  ` +
        details.join('\n  ') +
        '\n职责强度必须与原文一致，不得把"协助"写成"负责"或把"参与"写成"主导"。' +
        '注意：删掉原来较弱的表述不算升格，但把同一条工作内容的职责动词换强是。',
      evidence,
    })
  }

  // ── 4. 时间线一致性（日期被改动即事实错误）─────────────────────
  //
  // 起止日期属于"绝不可改写"的事实字段。改写若动了年份/月份，
  // 会导致与背调信息不符。
  if (originalDates.size > 0) {
    // 原文涉及的年份，以及**已有具体月份**的年份。
    const originalYears = new Set([...originalDates].map((d) => d.slice(0, 4)))
    const yearsWithMonth = new Set(
      [...originalDates].filter((d) => d.length > 4).map((d) => d.slice(0, 4)),
    )
    const changedDates = [...rewrittenDates].filter((d) => {
      if (originalDates.has(d)) return false
      const year = d.slice(0, 4)
      // 年份原文没出现过 → 改动（新时间点）
      if (!originalYears.has(year)) return true
      // 【⚠️ 同一年内的**月份改动**必须抓（实测抓出的漏报）】
      //
      // 早期逻辑是"年份出现过就放行"，动机是容忍"补全月份"
      //（`2022` → `2022年9月`）。但那样实现太粗，连带放过了真改动：
      //   `- 2022年9月入职；` → `- 2022年10月入职；`
      //   实测零告警 —— 而"起止日期改动"正是最该拦的事实错误之一。
      //
      // 正确区分：
      //   · 原文该年**只有年份、没有月份** → 补全月份属写法完善 → 放行
      //   · 原文该年**已有具体月份**、改写换成别的月份 → 真改动 → 拦住
      if (d.length > 4 && yearsWithMonth.has(year)) return true
      return false
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
  //
  // 【但"整条新增"不得把"短行里中文换缩写"误伤（独立审查抓出的真实死锁）】
  // 技能区的短行是最典型的 ATS 对齐形态，而它们信息量太少、
  // 与原文的字级相似度天然偏低，于是被判为"与原文任何一条都对不上"：
  //   `- 熟悉超文本传输协议；` → `- 熟悉 HTTP；`   ✘ 被拒
  // 实测 20 个常见术语里 **16 个被拒**，用户视角是"把技能名换成英文后导不出来"。
  //
  // 判据与第 2 项保持一致（**结构事实**，与相似度无关）：
  // 若某条"疑似新增"的单元，其**最佳原文对应句**的中文显著更多，
  // 且该原文句的中文**没有被其它改写行成段保留**（原句确实被它替换掉了），
  // 则它是**收缩写法**（中文换缩写），不是新增 → 不计入。
  const CONTRACTION_HAN_DROP = 4
  // 先用**剥离 markdown 排版语法**的文本做单元比对——
  // 否则 `> 说明`、`| 表格 |`、`[链接](url)`、`---`、`*斜体*` 这些
  // 纯排版产物会被当成"原文没有的新内容"（真实简历实测误报率 25%）。
  // 注意：只在这一处（内容单元比对）剥离；存在性判定仍用原文，
  // 避免剥离不当反而误判"技术名消失"。
  const originalForUnits = stripMarkdownSyntax(originalText)
  const rewrittenForUnits = stripMarkdownSyntax(rewrittenText)
  const novelCheck = detectNovelUnits(originalForUnits, rewrittenForUnits)
  const originalUnitsForNovel = extractContentUnits(originalForUnits)
  const rewrittenUnitsForNovel = extractContentUnits(rewrittenForUnits)
  const survivors = novelCheck.novel.filter((unit) => {
    // ⓪ "标题 + 通用英文词注记"不是新增内容。
    //
    // 【为什么（真实简历实测抓出的误报，且此前无解）】
    // 标题加英文对照会把标题"撑"进内容单元（原标题不足 8 字、本不是单元）：
    //   `## 专业技能` → `## 专业技能（Skills）`
    // 于是它与原文任何单元都对不上 → 判 NOVEL_CONTENT → **拒绝导出**。
    //
    // 【为什么这次能安全修好，而上一轮"剥括号"方案被判净亏损回退】
    // 上一轮的做法是"剥掉任意括号再看原文有没有"——那会放过
    // `## 项目经历（用户增长系统）`（剥掉得 `项目经历`，原文确实有）。
    // 本轮的判据多了一个**必要的限定**：括号内容必须是
    // **一个通用英文词**（`Skills`/`Education`/`Projects`），
    // 即守卫**已判定为"泛指、非专名"**的那一类（{@link extractAmbiguousLatinTokens}）。
    //   · `（Skills）` → 通用英文词 → 是"标题的英文对照" → 放行 ✅
    //   · `（Redis）` → 专有技术名 → 可能是夹带技能 → 照常拦 ✅
    //   · `（2024）` → 含数字 → 不是英文对照 → 照常拦 ✅
    //   · `（用户增长系统）` → 含汉字 → 不是英文对照 → 照常拦 ✅
    //   · `（Random Keyspace）` → 多词专名 → 照常拦 ✅
    // 实测这三类"该拦"的用例全部仍然拦住（见 guard.test.js 的成对用例）。
    const annotations = [...unit.matchAll(/[（(【\[]([^）)】\]]*)[）)】\]]/g)]
    if (annotations.length > 0) {
      const strippedUnit = unit.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '').replace(/\s+/g, '')
      const onlyGenericEnglishAnnotations = annotations.every((m) => {
        const inner = m[1].trim()
        // 必须是**单个通用英文词**：不含汉字、不含数字、无空格/分隔符
        if (/[\u4e00-\u9fa5]/.test(inner)) return false
        if (/\d/.test(inner)) return false
        if (!/^[A-Za-z][A-Za-z-]*$/.test(inner)) return false
        // 且守卫把它判为"泛指词"（而非专有技术名）
        return extractAmbiguousLatinTokens(inner).has(inner)
      })
      if (
        strippedUnit !== '' &&
        onlyGenericEnglishAnnotations &&
        normalizeForSimilarity(originalText).includes(normalizeForSimilarity(strippedUnit))
      ) {
        return false
      }
    }
    const grams = charBigrams(normalizeForSimilarity(unit))
    let bestUnit = ''
    let bestScore = 0
    for (const ou of originalUnitsForNovel) {
      const score = containment(grams, charBigrams(normalizeForSimilarity(ou)))
      if (score > bestScore) {
        bestScore = score
        bestUnit = ou
      }
    }
    if (bestUnit === '') return true
    // 中文显著下降？
    if (hanCount(bestUnit) - hanCount(unit) < CONTRACTION_HAN_DROP) return true
    // 该原文句的中文是否被**其它**改写行成段保留？（保留了 → 本行是纯增量 → 仍算新增）
    const retainedElsewhere = rewrittenUnitsForNovel.some(
      (u) => u !== unit && longestSharedHanRun(u, bestUnit) >= CONTRACTION_HAN_DROP,
    )
    return retainedElsewhere
  })

  // ── 分级：新增内容**是否含事实主张** ────────────────────────────────
  //
  // 【为什么必须分级（真实简历实测抓出的一批误报）】
  // 一类是**真正的编造**：凭空多一条"负责用户增长策略实现月活翻倍"——
  // 含职责动词与数字，是事实性主张，必须判 error。
  // 另一类是**无主张的说明性文字**：
  //   `> 以下为在校期间荣誉`、`*本简历由本人独立撰写*`
  // 它们确实是原文没有的内容，但不含任何可被面试追问的事实
  // （没有数字、没有机构/技术名、没有职责动词）。
  // 判 error 只会让用户拿不到文件，收益为零。
  // 故：含事实主张 → error；否则 → warn（提示但不阻断交付）。
  //
  // 【判据用**结构性信号**，不维护虚词清单】
  // 说明性文字（落款、章节导语、注释）都出现在**正文**；
  // 而编造章节/项目名出现在**标题行**（`## 项目经历（用户增长系统）`）。
  // 标题行的新增意味着"多了一个章节/项目"——那是硬性事实主张，必须拦。
  /** 该单元是否出现在标题行（`#` 开头） */
  const isOnHeadingLine = (/** @type {string} */ unit) =>
    rewrittenText
      .split('\n')
      .some((line) => /^\s*#{1,6}\s/.test(line) && line.includes(unit.replace(/^#+\s*/, '').trim()))
  const claimsFacts = (/** @type {string} */ unit) => {
    if (isOnHeadingLine(unit)) return true // 标题行新增 = 多了一个章节/项目
    if (/\d/.test(unit)) return true // 含数字（量化结果/日期）
    if (extractChineseOrgNames(unit).size > 0) return true // 含机构名
    if (extractLatinProperNouns(unit).size > 0) return true // 含拉丁专名
    if (extractResponsibilityLevel(unit).maxLevel > 0) return true // 含职责动词
    return false
  }
  const blockingSurvivors = survivors.filter(claimsFacts)
  const softSurvivors = survivors.filter((u) => !claimsFacts(u))

  if (blockingSurvivors.length > 0) {
    const preview = blockingSurvivors
      .slice(0, 3)
      .map((u) => (u.length > 40 ? `${u.slice(0, 40)}…` : u))
    findings.push({
      code: 'NOVEL_CONTENT',
      severity: 'error',
      message:
        `发现 ${blockingSurvivors.length} 条与原文任何内容都对不上的表述，疑似凭空新增：\n  ` +
        preview.join('\n  ') +
        '\n每一条改写都必须能追溯到原文的某条经历；新增内容需确认真实，否则删除。',
      evidence: blockingSurvivors,
    })
  }

  if (softSurvivors.length > 0) {
    const preview = softSurvivors
      .slice(0, 3)
      .map((u) => (u.length > 40 ? `${u.slice(0, 40)}…` : u))
    findings.push({
      code: 'NOVEL_CONTENT',
      severity: 'warn',
      message:
        `发现 ${softSurvivors.length} 条原文没有的说明性文字（不含数字/机构/技术名/职责主张）：\n  ` +
        preview.join('\n  ') +
        '\n它们不构成事实性主张，故不阻断交付；但**请确认**是否确有必要新增（如落款、章节导语）。',
      evidence: softSurvivors,
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
