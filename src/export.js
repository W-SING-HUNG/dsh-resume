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
 * @property {string} text 段落文本
 */

/**
 * 将简历 Markdown 解析为结构化段落。
 *
 * 支持的语法（刻意保持精简——只处理简历里真实会出现的写法）：
 *   - `# 标题` / `## 小节` / `### 子小节`
 *   - `- 要点` / `* 要点`（项目符号）
 *   - 普通段落
 *
 * @param {string} markdown 简历 Markdown 文本
 * @returns {ResumeBlock[]} 段落序列
 */
export function parseResumeMarkdown(markdown) {
  /** @type {ResumeBlock[]} */
  const out = []
  const src = String(markdown ?? '').replace(/\r\n?/g, '\n')
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue

    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      /** @type {'h1' | 'h2' | 'h3'} */
      const type = level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3'
      out.push({ type, text: heading[2].trim() })
      continue
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      out.push({ type: 'bullet', text: bullet[1].trim() })
      continue
    }

    out.push({ type: 'text', text: line })
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
 * @param {string} text 待转义文本
 * @returns {string} 转义后文本
 */
function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, (c) => XML_ESCAPES[/** @type {keyof typeof XML_ESCAPES} */ (c)])
}

/** 字体与字号（半磅为单位：24 半磅 = 12pt）。 */
const STYLE = /** @type {const} */ ({
  h1: { size: 32, bold: true, spaceAfter: 120 },
  h2: { size: 26, bold: true, spaceBefore: 240, spaceAfter: 80 },
  h3: { size: 24, bold: true, spaceBefore: 120, spaceAfter: 60 },
  text: { size: 21, spaceAfter: 60 },
  bullet: { size: 21, spaceAfter: 40, indent: 360 },
})

/**
 * 生成一个 OOXML 段落。
 * @param {string} text 段落文本
 * @param {{ size: number, bold?: boolean, spaceBefore?: number, spaceAfter?: number, indent?: number }} [style] 样式
 * @returns {string} `<w:p>` 片段
 */
function paragraph(text, style = STYLE.text) {
  const pPr = [
    style.spaceBefore ? `<w:spacing w:before="${style.spaceBefore}"/>` : '',
    style.spaceAfter ? `<w:spacing w:after="${style.spaceAfter}"/>` : '',
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
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

/**
 * 生成 DOCX 文件字节。
 *
 * @param {string} markdown 简历 Markdown
 * @param {{ title?: string }} [options] 可选参数（title 暂用于文档属性占位）
 * @returns {Buffer} .docx 字节
 */
export function buildDocx(markdown, options = {}) {
  void options
  const blocks = parseResumeMarkdown(markdown)
  const body = blocks
    .map((b) => {
      if (b.type === 'h1') return paragraph(b.text, STYLE.h1)
      if (b.type === 'h2') return paragraph(b.text, STYLE.h2)
      if (b.type === 'h3') return paragraph(b.text, STYLE.h3)
      if (b.type === 'bullet') return paragraph(`· ${b.text}`, STYLE.bullet)
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
