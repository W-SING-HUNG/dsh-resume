// 简历导出 —— 零外部依赖
//
// 【存在理由】
// 此前用户改完简历只能拿到聊天窗口里的 Markdown 文本，要自己复制、
// 自己排版、自己另存为 Word。对非技术用户来说这一步就是使用门槛。
// 本模块把"改完即得到可投递文件"补齐：直接产出 .docx 供投递使用。
//
// 【为什么手写 DOCX 而不是引入依赖】
// 本项目铁律之一是运行时零依赖（`dependencies` 必须为空），
// 原因是插件在 DSH 宿主中会因模块双实例问题崩溃，且零依赖保证任何环境可跑。
// .docx 本质是 ZIP 包 + OOXML 文本，Node 内置 `zlib` 已提供 deflate，
// 因此可以手写生成，不必引入 100KB 级的第三方库。
//
// 【实现范围（明确声明，不夸大）】
// 生成的是**投递可用的基础版式**：标题、小节标题、项目符号段落、段落间距。
// 不含复杂排版（表格、分栏、图片、页眉页脚）——那些需要完整 OOXML 支持。
// 对本项目的用途（ATS 可解析的简历）来说，简洁单栏反而更合适：
// 复杂版式会导致 ATS 解析失败（这是简历领域的已知问题）。

import { deflateRawSync } from 'node:zlib'

// ── ZIP 写入（OOXML 的容器格式）────────────────────────────────

/**
 * CRC32 查找表。ZIP 规范要求每个条目带 CRC32 校验值。
 * 用查表法而非逐位运算，是标准做法（快一个数量级）。
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c
  }
  return table
})()

/**
 * 计算 CRC32。
 * @param {Buffer} buf 输入字节
 * @returns {number} CRC32 值（无符号）
 */
function crc32(buf) {
  let crc = -1
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  }
  return (crc ^ -1) >>> 0
}

/**
 * 把一组文件打包为 ZIP（deflate 压缩）。
 *
 * 结构要点（ZIP 规范）：
 *   - 每个条目 = 本地文件头 + 文件名 + 压缩数据
 *   - 末尾是中央目录（含每条目的偏移与大小）+ 中央目录结束记录
 * 偏移必须精确累加，错一位文件就打不开。
 *
 * @param {Array<{ name: string, content: string | Buffer }>} entries 待打包文件
 * @returns {Buffer} ZIP 字节
 */
export function buildZip(entries) {
  const parts = []
  const centralParts = []
  let offset = 0

  for (const item of entries) {
    const nameBuf = Buffer.from(item.name, 'utf8')
    const data = Buffer.isBuffer(item.content)
      ? item.content
      : Buffer.from(String(item.content), 'utf8')
    const compressed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
    local.writeUInt16LE(20, 4) // 解压所需版本
    local.writeUInt16LE(0, 6) // 通用标志
    local.writeUInt16LE(8, 8) // 压缩方法：deflate
    local.writeUInt16LE(0, 10) // 修改时间
    local.writeUInt16LE(0, 12) // 修改日期
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // 扩展字段长度

    parts.push(local, nameBuf, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // 中央目录签名
    central.writeUInt16LE(20, 4) // 创建版本
    central.writeUInt16LE(20, 6) // 解压所需版本
    central.writeUInt16LE(0, 8) // 通用标志
    central.writeUInt16LE(8, 10) // 压缩方法
    central.writeUInt16LE(0, 12) // 修改时间
    central.writeUInt16LE(0, 14) // 修改日期
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // 扩展字段
    central.writeUInt16LE(0, 32) // 注释
    central.writeUInt16LE(0, 34) // 起始磁盘号
    central.writeUInt16LE(0, 36) // 内部属性
    central.writeUInt32LE(0, 38) // 外部属性
    central.writeUInt32LE(offset, 42) // 本地头偏移
    centralParts.push(central, nameBuf)

    offset += local.length + nameBuf.length + compressed.length
  }

  const centralBuf = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0) // 中央目录结束签名
  end.writeUInt16LE(0, 4) // 当前磁盘号
  end.writeUInt16LE(0, 6) // 中央目录起始磁盘号
  end.writeUInt16LE(entries.length, 8) // 本磁盘条目数
  end.writeUInt16LE(entries.length, 10) // 总条目数
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // 注释长度

  return Buffer.concat([...parts, centralBuf, end])
}

// ── Markdown 解析 ─────────────────────────────────────────────

/**
 * 简历段落。
 * @typedef {object} ResumeBlock
 * @property {'h1' | 'h2' | 'h3' | 'bullet' | 'text'} type 段落类型
 * @property {string} text 段落文本（已剥离 Markdown 行内标记）
 * @property {number} level 嵌套层级：正文/标题为 0，顶级要点为 1，逐级递增
 */

/** 制表位宽度（twip）。嵌套要点按此步进缩进。 */
const INDENT_STEP = 360

/**
 * 剥离行内 Markdown 标记，保留纯文本。
 *
 * 【存在理由（实证缺陷，2026-09-28）】
 * 此前 `**加粗**` 会被原样当作文本，导出成 Word 后 HR 看到的是
 * `· **某电商平台** 前端开发`——字面星号。而加粗是 AI 改写简历时
 * 最常用的强调写法，等于最常见的输出直接翻车。
 *
 * 【边界约束（第二层缺陷，同样由实证发现）】
 * 朴素的 `_([^_]+)_` 会**静默吃掉技术术语里的下划线和乘号**：
 *   `t_order_item` → `torderitem`、`2*3*4` → `234`
 * 这比字面星号严重得多——它在篡改候选人的真实数据，
 * 直接违反本项目「保留原始量化数据」的铁律。
 * 因此强调标记一律要求**外侧边界**（行首/空白/标点，不能紧邻字母数字），
 * 使 `user_id`、`t_order_item`、`2*3*4` 这类写法原样保留。
 *
 * @param {string} text 原始行内文本
 * @returns {string} 去除标记后的文本
 */
function stripInlineMarkdown(text) {
  // 强调标记的外侧边界：不能紧邻词字符（字母/数字/下划线），
  // 否则 snake_case 与算式中的符号会被误当标记吃掉。
  const OPEN = '(?<![\\w_])'
  const CLOSE = '(?![\\w_])'
  return String(text)
    // 图片：保留替代文字（图片本身无法在基础版式里嵌入）
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // 链接：保留链接文字
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // 行内代码：去掉反引号（反引号不会出现在正常词内，无边界风险）
    .replace(/`([^`]+)`/g, '$1')
    // 删除线
    .replace(/~~([^~]+)~~/g, '$1')
    // 粗斜体（三星）→ 粗体 → 斜体；顺序不可颠倒，否则 `***x***` 会被拆错
    .replace(new RegExp(`${OPEN}\\*\\*\\*(?=\\S)([\\s\\S]*?\\S)\\*\\*\\*${CLOSE}`, 'g'), '$1')
    .replace(new RegExp(`${OPEN}\\*\\*(?=\\S)([\\s\\S]*?\\S)\\*\\*${CLOSE}`, 'g'), '$1')
    .replace(new RegExp(`${OPEN}\\*(?=\\S)([^*\\s][^*]*?)\\*${CLOSE}`, 'g'), '$1')
    .trim()
}

// ── 为什么不处理下划线强调（`_斜体_` / `__粗体__`）────────────────────
//
// 【结论：整类移除，不是遗漏】
// 下划线强调与技术标识符在结构上**完全无法区分**：
//   `__bold__` 与 `__init__`、`_斜体_` 与 `表_订单明细_索引` 的正则形态一模一样。
// 而两者的误判代价严重不对称：
//   - 漏剥离 → HR 看到字面下划线，难看，但内容 100% 正确；
//   - 误剥离 → `__init__.py` 变 `init.py`、`表_订单明细_索引` 变 `表订单明细索引`，
//     属于**静默篡改候选人的真实技术描述**，违反「保留原始内容」铁律。
//
// 实测过的三次尝试（都失败，留作记录）：
//   1. 朴素 `_([^_]+)_` → 吃掉 `t_order_item`、`2*3*4`
//   2. 加词边界 `(?<![\w_])…(?![\w_])` → 仍吃掉 `__init__.py`、`__main__`
//   3. 限定"内容含汉字才剥离" → 仍吃掉 `表_订单明细_索引`、`用户名_昵称_邮箱`
//      （中文技术文档用下划线做分隔正是常见写法）
//
// 取舍依据：本项目原则是「宁可漏报不可误报」。中文简历的强调几乎都用星号，
// `_斜体_` 属罕见写法；用"罕见写法能正确渲染"去换"常见技术术语被静默篡改"
// 是不划算的交易。星号强调无此冲突（`**` 不可能出现在合法标识符中），全场景生效。

/**
 * 将简历 Markdown 解析为结构化段落。
 *
 * 支持的语法（刻意保持精简——只处理简历里真实会出现的写法）：
 *   - `# 标题` … `###### 标题`（1–6 级都识别；4 级及以上统一按三级样式渲染，
 *     因为简历的视觉层次到三级已足够，更多层级只会让版式变乱）
 *   - `- 要点` / `* 要点` / `+ 要点`（项目符号，支持缩进嵌套）
 *   - 普通段落
 *
 * 行内标记（`**粗体**`、`` `代码` ``、`[文字](链接)`）会被剥离为纯文本；
 * 见 {@link stripInlineMarkdown} 的存在理由。
 *
 * 【明确不支持的写法（要求把边界写在可读处，而非只写在注释里）】
 *   - 标题必须带空格（`# 标题`）。`###标题` 不是合法 ATX 标题，按普通段落处理
 *   - **未闭合**的强调标记（`**半截粗体`）不会被剥离，字样原样保留
 *   - HTML 实体（`&nbsp;`）不做解码，按字面文本输出
 *   - 表格（`| a | b |`）不做解析，管道符按字面文本输出
 * 这些都是刻意的取舍：简历导出只需要"文字正确落进 Word"，
 * 而多余的处理会增加篡改真实文本的风险（参见下划线强调的取舍说明）。
 *
 * @param {string} markdown 简历 Markdown 文本
 * @returns {ResumeBlock[]} 段落序列
 */
export function parseResumeMarkdown(markdown) {
  /** @type {ResumeBlock[]} */
  const out = []
  const src = String(markdown ?? '').replace(/\r\n?/g, '\n')
  for (const rawLine of src.split('\n')) {
    if (rawLine.trim() === '') continue

    // 缩进在剥离前测量：Markdown 的层级信息只存在于缩进里。
    // 制表符按一个缩进步长计（简历里 Tab 通常就是一级缩进）。
    const indentWidth = (/^[\t ]*/.exec(rawLine)?.[0] ?? '').replace(/\t/g, '  ').length
    const line = rawLine.trim()

    // 1–6 级都识别（此前只到 3 级，四级标题会退化成普通段落、丢失加粗）
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      // 4 级及以上按 h3 渲染：简历视觉层次到三级已足够
      /** @type {'h1' | 'h2' | 'h3'} */
      const type = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3'
      out.push({ type, text: stripInlineMarkdown(heading[2]), level: 0 })
      continue
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      // 每 2 个空格算一层嵌套（Markdown 的常见约定），最少 1 层。
      out.push({
        type: 'bullet',
        text: stripInlineMarkdown(bullet[1]),
        level: 1 + Math.floor(indentWidth / 2),
      })
      continue
    }

    out.push({ type: 'text', text: stripInlineMarkdown(line), level: 0 })
  }
  return out
}

// ── OOXML 生成 ───────────────────────────────────────────────

/** XML 特殊字符转义。未转义的 & 或 < 会让 Word 拒绝打开文件。 */
const XML_ESCAPES = /** @type {const} */ ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
})

/**
 * XML 1.0 允许的字符之外的控制字符。
 *
 * 【存在理由（实证缺陷，2026-09-28）】
 * XML 1.0 规范禁止 NUL、BEL 等控制字符出现在文档中（连转义都不允许）。
 * 此前这些字符会被原样写进 document.xml，Word 打开时报"文件已损坏"。
 * 简历文本来自模型输出与用户粘贴，带上不可见控制字符是常见情况
 * （尤其从网页/终端复制时）。制表、换行、回车是合法空白，予以保留。
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffe\uffff]/g

/**
 * 转义 XML 特殊字符，并剔除 XML 1.0 非法的控制字符。
 *
 * @param {string} text 待处理文本
 * @returns {string} 可安全嵌入 XML 的文本
 */
function escapeXml(text) {
  return String(text)
    .replace(ILLEGAL_XML_CHARS, '')
    .replace(/[&<>"']/g, (c) => XML_ESCAPES[/** @type {keyof typeof XML_ESCAPES} */ (c)])
}

/** 字体与字号（半磅为单位：24 半磅 = 12pt）。 */
const STYLE = /** @type {const} */ ({
  h1: { size: 32, bold: true, spaceAfter: 120 },
  h2: { size: 26, bold: true, spaceBefore: 240, spaceAfter: 80 },
  h3: { size: 24, bold: true, spaceBefore: 120, spaceAfter: 60 },
  text: { size: 21, spaceAfter: 60 },
  bullet: { size: 21, spaceAfter: 40 },
})

/**
 * 生成一个 OOXML 段落。
 *
 * 【为什么 before/after 必须合并进同一个 w:spacing】
 * OOXML 的 `w:pPr` 里各子元素有出现次数上限，`w:spacing` 是 maxOccurs=1。
 * 早期实现对 before 与 after 各写一个 `<w:spacing>`，凡同时带两者的样式
 * （h2/h3）都会产出重复元素——Word 会提示"文件需要修复"，
 * 严格的 ATS 解析器可能直接判定文档非法。
 *
 * @param {string} text 段落文本
 * @param {{ size: number, bold?: boolean, spaceBefore?: number, spaceAfter?: number, indent?: number }} [style] 样式
 * @returns {string} `<w:p>` 片段
 */
function paragraph(text, style = STYLE.text) {
  // before / after 合成单个元素；两者皆无时不生成 pPr。
  const spacingAttrs = [
    style.spaceBefore ? ` w:before="${style.spaceBefore}"` : '',
    style.spaceAfter ? ` w:after="${style.spaceAfter}"` : '',
  ].join('')
  const pPr = [
    spacingAttrs ? `<w:spacing${spacingAttrs}/>` : '',
    style.indent ? `<w:ind w:left="${style.indent}"/>` : '',
  ].join('')
  const rPr = [
    style.bold ? '<w:b/>' : '',
    `<w:sz w:val="${style.size}"/><w:szCs w:val="${style.size}"/>`,
  ].join('')
  return (
    `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}` +
    `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}` +
    `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
  )
}
/** OOXML 必备的包声明文件（缺任一个 Word 都拒绝打开）。 */
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`

/**
 * 文档核心属性。不写这部分 Word 也能打开，但文件属性会是空白，
 * 且"最近使用的文档"列表里显示为无标题——投递级文件应当带有身份。
 * @param {string} title 文档标题（通常取简历姓名）
 * @returns {string} core.xml 全文
 */
function buildCoreProps(title) {
  const safe = escapeXml(title)
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${safe}</dc:title>
<dc:creator>dsh-resume</dc:creator>
<cp:lastModifiedBy>dsh-resume</cp:lastModifiedBy>
</cp:coreProperties>`
}

/** 扩展属性（应用名）。Word 会读取，缺失时同样留空。 */
const APP_PROPS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>dsh-resume</Application>
</Properties>`

/**
 * 解析文档标题：优先用调用方显式传入的 title，否则取简历里的首个标题，
 * 再退化为"个人简历"。
 *
 * 为什么需要：投递级 .docx 在 HR 打开时，文件属性与"最近文档"应显示候选人身份，
 * 而不是空白或"文档1"。此前 `options.title` 被 `void options` 丢弃，是死参数。
 *
 * @param {ResumeBlock[]} blocks 已解析的段落
 * @param {{ title?: string }} [options] 调用方参数
 * @returns {string} 文档标题
 */
function resolveDocTitle(blocks, options = {}) {
  const explicit = typeof options.title === 'string' ? options.title.trim() : ''
  if (explicit !== '') return explicit
  const heading = blocks.find((b) => b.type === 'h1')
  return heading !== undefined && heading.text !== '' ? heading.text : '个人简历'
}

/**
 * 生成 DOCX 文件字节。
 *
 * @param {string} markdown 简历 Markdown
 * @param {{ title?: string }} [options] 可选参数；title 写入文档属性（缺省取首个一级标题）
 * @returns {Buffer} .docx 字节
 */
export function buildDocx(markdown, options = {}) {
  const blocks = parseResumeMarkdown(markdown)
  const body = blocks
    .map((b) => {
      if (b.type === 'h1') return paragraph(b.text, STYLE.h1)
      if (b.type === 'h2') return paragraph(b.text, STYLE.h2)
      if (b.type === 'h3') return paragraph(b.text, STYLE.h3)
      if (b.type === 'bullet') {
        // 嵌套层级按步长递进缩进，让"主项 + 子项"的层次在 Word 里保留下来。
        // 此前所有要点都缩进 360，层级信息在导出时丢失，长简历会糊成一片。
        const indent = INDENT_STEP * Math.max(1, b.level)
        // 二级及更深的要点用空心圆点，与主项在视觉上区分。
        const marker = b.level >= 2 ? '◦' : '·'
        return paragraph(`${marker} ${b.text}`, { ...STYLE.bullet, indent })
      }
      return paragraph(b.text, STYLE.text)
    })
    .join('')

  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    // 页边距按 A4 常规投递设置（单位 twip：1440 twip = 1 英寸）
    `<w:body>${body}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>` +
    `</w:body></w:document>`

  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: ROOT_RELS },
    { name: 'word/document.xml', content: document },
    { name: 'docProps/core.xml', content: buildCoreProps(resolveDocTitle(blocks, options)) },
    { name: 'docProps/app.xml', content: APP_PROPS },
  ])
}

// ── 交付文本组装 ──────────────────────────────────────────────

/**
 * 把四段式交付内容组装为可导出的 Markdown 全文。
 *
 * @param {{ resume?: string, changes?: string, gaps?: string, verification?: string }} parts
 *   各段内容（可只传其中几段）
 * @returns {string} 完整 Markdown
 */
export function assembleDeliverable(parts = {}) {
  const sections = [
    ['优化后简历', parts.resume],
    ['改动说明', parts.changes],
    ['待补充清单', parts.gaps],
    ['校验结果', parts.verification],
  ]
  const out = []
  for (const [heading, content] of sections) {
    const text = String(content ?? '').trim()
    if (text === '') continue
    out.push(`# ${heading}`, '', text, '')
  }
  return out.join('\n').trimEnd()
}

/**
 * 把纯文本转为 UTF-8 字节（供 .txt 导出）。
 * @param {string} text 文本
 * @returns {Buffer} 字节
 */
export function buildText(text) {
  return Buffer.from(String(text ?? ''), 'utf8')
}
