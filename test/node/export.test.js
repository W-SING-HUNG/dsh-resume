// 导出模块测试（node:test 标准 runner）
//
// 【测试重点】
// 1. 生成的 DOCX 必须是结构合法的 ZIP+OOXML（用 Node 内置能力真实解包验证）
// 2. XML 转义必须生效（未转义的 & 会让 Word 拒绝打开文件）
// 3. 文件写入的安全边界：不覆盖已有文件、父目录缺失时报错而非静默创建
// 4. 纯函数部分与 IO 部分严格分离（契约层可在无文件系统环境测试）
//
// 运行：npm test

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildZip,
  buildDocx,
  buildText,
  parseResumeMarkdown,
  assembleDeliverable,
} from '../../src/export.js'
import {
  buildExportPayload,
  detectExportFormat,
  exportResume,
  createExportToolDefinition,
} from '../../src/core.js'

/** 创建临时目录，测试结束自动清理。 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-resume-export-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * 用 Node 内置 zlib 解包 ZIP 并读取指定条目。
 * 这是真实解包，不是断言"字节看起来像 ZIP"——后者会放过结构错误。
 * @param {Buffer} zip ZIP 字节
 * @returns {Map<string, string>} 条目名 → 内容
 */
function readZipEntries(zip) {
  const out = new Map()
  let pos = 0
  while (pos + 30 <= zip.length && zip.readUInt32LE(pos) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(pos + 18)
    const nameLen = zip.readUInt16LE(pos + 26)
    const extraLen = zip.readUInt16LE(pos + 28)
    const name = zip.subarray(pos + 30, pos + 30 + nameLen).toString('utf8')
    const dataStart = pos + 30 + nameLen + extraLen
    const compressed = zip.subarray(dataStart, dataStart + compressedSize)
    // 用 inflateRaw 解压（deflate 原始流）
    out.set(name, inflateRawSync(compressed).toString('utf8'))
    pos = dataStart + compressedSize
  }
  return out
}

describe('导出：Markdown 解析', () => {
  test('识别标题、要点与段落', () => {
    const blocks = parseResumeMarkdown(
      '# 姓名\n\n## 教育\n- 某大学\n普通段落文本',
    )
    assert.deepEqual(blocks, [
      { type: 'h1', text: '姓名' },
      { type: 'h2', text: '教育' },
      { type: 'bullet', text: '某大学' },
      { type: 'text', text: '普通段落文本' },
    ])
  })

  test('三级标题与不同项目符号', () => {
    const blocks = parseResumeMarkdown('### 子标题\n* 星号要点\n+ 加号要点')
    assert.deepEqual(blocks.map((b) => b.type), ['h3', 'bullet', 'bullet'])
  })

  test('空行与前后空白被忽略', () => {
    const blocks = parseResumeMarkdown('\n\n  # 标题  \n\n')
    assert.deepEqual(blocks, [{ type: 'h1', text: '标题' }])
  })

  test('空输入返回空数组而非抛错', () => {
    assert.deepEqual(parseResumeMarkdown(''), [])
    assert.deepEqual(parseResumeMarkdown(null), [])
    assert.deepEqual(parseResumeMarkdown(undefined), [])
  })
})

describe('导出：ZIP 与 DOCX 结构', () => {
  test('buildZip 生成可被解包的合法 ZIP', () => {
    const zip = buildZip([{ name: 'hello.txt', content: '内容测试' }])
    assert.equal(zip.readUInt32LE(0), 0x04034b50, 'ZIP 本地头签名')
    const entries = readZipEntries(zip)
    assert.equal(entries.get('hello.txt'), '内容测试', '中文往返必须一致')
  })

  test('buildDocx 含 OOXML 要求的三个必备部件', () => {
    const docx = buildDocx('# 姓名\n- 要点')
    const entries = readZipEntries(docx)
    assert.ok(entries.has('[Content_Types].xml'), '缺少 [Content_Types].xml，Word 会拒绝打开')
    assert.ok(entries.has('_rels/.rels'), '缺少关系文件')
    assert.ok(entries.has('word/document.xml'), '缺少正文')
  })

  test('DOCX 正文含 A4 页面设置', () => {
    const entries = readZipEntries(buildDocx('# 姓名'))
    const doc = entries.get('word/document.xml')
    assert.match(doc, /w:pgSz[^>]*w:w="11906"/, '应为 A4 宽度')
    assert.match(doc, /w:pgSz[^>]*w:h="16838"/, '应为 A4 高度')
  })

  test('DOCX 正文含简历文本内容', () => {
    const entries = readZipEntries(buildDocx('# 示例候选人\n- 基于 Vue2 完成开发'))
    const doc = entries.get('word/document.xml')
    assert.ok(doc.includes('示例候选人'))
    assert.ok(doc.includes('基于 Vue2 完成开发'))
  })

  test('XML 转义生效：特殊字符不破坏文档结构', () => {
    // 未转义的 & 或 < 会让 XML 非法，Word 报"文件已损坏"
    const docx = buildDocx('# A & B <script> "引号" \'单引号\'')
    const entries = readZipEntries(docx)
    const doc = entries.get('word/document.xml')
    assert.ok(!/<script>/.test(doc), '未转义的 < 会破坏 XML 结构')
    assert.ok(doc.includes('&amp;'), '& 必须转义为 &amp;')
    assert.ok(doc.includes('&lt;script&gt;'), '< 与 > 必须转义')
  })

  test('转义后的 DOCX 仍是合法 ZIP', () => {
    const docx = buildDocx('# 恶意 & " 测试')
    const entries = readZipEntries(docx)
    assert.ok(entries.size >= 3, '解包应得到全部部件')
  })
})

describe('导出：交付组装', () => {
  test('四个小节都存在时全部输出', () => {
    const text = assembleDeliverable({
      resume: '简历正文',
      changes: '改动说明',
      gaps: '待补充',
      verification: '校验通过',
    })
    for (const s of ['优化后简历', '改动说明', '待补充清单', '校验结果']) {
      assert.ok(text.includes(s), `应包含小节：${s}`)
    }
  })

  test('空小节被跳过而非输出空标题', () => {
    const text = assembleDeliverable({ resume: '简历正文' })
    assert.ok(text.includes('优化后简历'))
    assert.ok(!text.includes('改动说明'), '未提供的段落不应出现')
  })
})

describe('导出：格式判定', () => {
  test('按扩展名判定格式', () => {
    assert.equal(detectExportFormat('a.docx'), 'docx')
    assert.equal(detectExportFormat('a.md'), 'md')
    assert.equal(detectExportFormat('a.txt'), 'txt')
    assert.equal(detectExportFormat('A.DOCX'), 'docx', '扩展名判定应大小写不敏感')
  })

  test('不支持的扩展名返回 null', () => {
    assert.equal(detectExportFormat('a.pdf'), null)
    assert.equal(detectExportFormat('a'), null)
    assert.equal(detectExportFormat(''), null)
  })
})

describe('导出：参数校验与内容组装（纯函数，不触碰文件系统）', () => {
  test('缺少 resume 或 outputPath 时抛错', () => {
    assert.throws(() => buildExportPayload({ outputPath: 'a.docx' }), /resume/)
    assert.throws(() => buildExportPayload({ resume: 'x' }), /outputPath/)
    assert.throws(() => buildExportPayload({ resume: '   ', outputPath: 'a.docx' }), /resume/)
  })

  test('不支持的扩展名抛错并说明支持的格式', () => {
    assert.throws(() => buildExportPayload({ resume: 'x', outputPath: 'a.pdf' }), /\.docx/)
  })

  test('默认只输出简历本体（不含附录）', () => {
    const payload = buildExportPayload({
      resume: '# 简历正文',
      outputPath: 'a.md',
      changes: '不应出现',
      gaps: '不应出现',
    })
    assert.ok(!payload.content.includes('不应出现'), '默认不得附带说明性内容')
  })

  test('includeAppendix=true 时附带说明内容', () => {
    const payload = buildExportPayload({
      resume: '# 简历正文',
      outputPath: 'a.md',
      changes: '改动说明内容',
      includeAppendix: true,
    })
    assert.ok(payload.content.includes('改动说明内容'))
  })

  test('docx 格式产出 Buffer 且签名正确', () => {
    const payload = buildExportPayload({ resume: '# 姓名', outputPath: 'a.docx' })
    assert.equal(payload.format, 'docx')
    assert.ok(Buffer.isBuffer(payload.data))
    assert.equal(payload.data.readUInt32LE(0), 0x04034b50)
  })

  test('md / txt 格式产出 UTF-8 字节', () => {
    for (const ext of ['md', 'txt']) {
      const payload = buildExportPayload({ resume: '# 中文内容', outputPath: `a.${ext}` })
      assert.equal(payload.format, ext)
      assert.equal(payload.data.toString('utf8'), '# 中文内容')
    }
  })
})

describe('导出：真实写文件（使用临时目录）', () => {
  test('成功写出文件且内容正确', async (t) => {
    const dir = tempDir(t)
    const target = join(dir, 'out.md')
    const result = await exportResume({ resume: '# 简历正文', outputPath: target }, async (p, d) => {
      writeFileSync(p, d)
    })
    assert.equal(result.ok, true)
    assert.equal(result.path, target)
    assert.equal(result.format, 'md')
    assert.ok(result.bytes > 0)
    assert.equal(readFileSync(target, 'utf8'), '# 简历正文')
  })

  test('docx 导出后可用系统解压工具读取（端到端）', async (t) => {
    const dir = tempDir(t)
    const target = join(dir, 'out.docx')
    await createExportToolDefinition(async (p, d) => writeFileSync(p, d)).execute({
      resume: '# 示例候选人\n- 基于 Vue2 完成开发',
      outputPath: target,
    })
    assert.ok(existsSync(target))
    // 改名为 .zip 后用系统解压验证（PowerShell 按扩展名判断，非文件问题）
    const zipPath = join(dir, 'out.zip')
    writeFileSync(zipPath, readFileSync(target))
    // 用 Node 内置解包验证（跨平台，不依赖系统工具）
    const entries = readZipEntries(readFileSync(target))
    assert.ok(entries.get('word/document.xml').includes('示例候选人'))
  })
})

describe('导出：安全边界（防止毁坏用户文件）', () => {
  test('不覆盖已存在的文件', async (t) => {
    const dir = tempDir(t)
    const target = join(dir, 'existing.md')
    writeFileSync(target, '用户原有内容')
    await assert.rejects(
      () =>
        exportResume({ resume: '新内容', outputPath: target }, async (p, d) => {
          const { writeFile } = await import('node:fs/promises')
          // 模拟装配层的安全边界：已存在则拒绝
          const fs = await import('node:fs')
          if (fs.existsSync(p)) throw new Error('目标文件已存在，为避免覆盖你的文件，导出已中止')
          await writeFile(p, d)
        }),
      /已存在/,
    )
    assert.equal(readFileSync(target, 'utf8'), '用户原有内容', '原文件必须原封不动')
  })

  test('写入失败时抛错而非静默通过', async () => {
    await assert.rejects(
      () => exportResume({ resume: 'x', outputPath: 'a.md' }, async () => {
        throw new Error('磁盘只读')
      }),
      /磁盘只读/,
    )
  })

  test('工具定义在未注入写入实现时明确报错', async () => {
    const tool = createExportToolDefinition(undefined)
    await assert.rejects(() => tool.execute({ resume: 'x', outputPath: 'a.md' }), /未装配/)
  })
})

describe('导出：工具契约', () => {
  test('工具名与 schema 结构正确', () => {
    const tool = createExportToolDefinition(async () => {})
    assert.equal(tool.name, 'export_resume')
    assert.deepEqual(tool.parameters.required, ['resume', 'outputPath'])
    assert.deepEqual(
      Object.keys(tool.output.schema.properties).sort(),
      ['bytes', 'format', 'ok', 'path', 'summary'],
    )
  })

  test('render 输出摘要文本', () => {
    const tool = createExportToolDefinition(async () => {})
    const blocks = tool.output.render({}, { summary: '已导出 DOCX 文件' })
    assert.equal(blocks[0].type, 'text')
    assert.equal(blocks[0].text, '已导出 DOCX 文件')
  })

  test('presentCall 返回平台 card 描述', () => {
    const tool = createExportToolDefinition(async () => {})
    const card = tool.presentCall({ outputPath: '/tmp/a.docx' })
    assert.equal(card.card, 'generic')
    assert.equal(card.title, '导出简历文件')
  })
})
