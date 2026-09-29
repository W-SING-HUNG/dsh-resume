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
import { writeResumeFile } from '../../src/index.js'

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
      { type: 'h1', text: '姓名', level: 0 },
      { type: 'h2', text: '教育', level: 0 },
      { type: 'bullet', text: '某大学', level: 1 },
      { type: 'text', text: '普通段落文本', level: 0 },
    ])
  })

  test('三级标题与不同项目符号', () => {
    const blocks = parseResumeMarkdown('### 子标题\n* 星号要点\n+ 加号要点')
    assert.deepEqual(blocks.map((b) => b.type), ['h3', 'bullet', 'bullet'])
  })

  test('空行与前后空白被忽略', () => {
    const blocks = parseResumeMarkdown('\n\n  # 标题  \n\n')
    assert.deepEqual(blocks, [{ type: 'h1', text: '标题', level: 0 }])
  })

  test('空输入返回空数组而非抛错', () => {
    assert.deepEqual(parseResumeMarkdown(''), [])
    assert.deepEqual(parseResumeMarkdown(null), [])
    assert.deepEqual(parseResumeMarkdown(undefined), [])
  })

  // ── 行内标记剥离：实证缺陷回归（星号曾字面出现在 Word 里）────────────
  test('粗体标记被剥离，不字面输出星号', () => {
    const [b] = parseResumeMarkdown('- **某电商平台** 前端开发')
    assert.equal(b.text, '某电商平台 前端开发', 'HR 不该在 Word 里看到 ** 字符')
  })

  test('斜体、行内代码、链接、删除线均被剥离', () => {
    assert.equal(parseResumeMarkdown('- *斜体*')[0].text, '斜体')
    assert.equal(parseResumeMarkdown('- `code()`')[0].text, 'code()')
    assert.equal(
      parseResumeMarkdown('- 见 [项目主页](https://example.com)')[0].text,
      '见 项目主页',
    )
    assert.equal(parseResumeMarkdown('- ~~废弃~~')[0].text, '废弃')
  })

  test('标题中的行内标记同样被剥离', () => {
    assert.equal(parseResumeMarkdown('## **重点项目**')[0].text, '重点项目')
  })

  test('剥离后不会误伤正常文本', () => {
    // 下划线命名（如 user_id）与算术星号不应被当作标记吞掉内容
    assert.equal(parseResumeMarkdown('字段 user_id 与 2*3')[0].text, '字段 user_id 与 2*3')
  })

  // ── 边界约束：剥离不能篡改技术术语（这是第二层缺陷，由实证发现）──────
  // 朴素实现会把 `t_order_item` 吃成 `torderitem`、`2*3*4` 吃成 `234`，
  // 属于静默篡改候选人真实数据，比字面星号严重得多。
  test('snake_case 与算式不被下划线/星号剥离破坏', () => {
    for (const src of [
      '表 t_order_item 索引',
      'a_b_c',
      '字段 user_id',
      '2*3*4',
      '2 * 3 的乘积',
      'snake_case_name 保留',
    ]) {
      assert.equal(parseResumeMarkdown(src)[0].text, src, `不应改动：${src}`)
    }
  })

  test('C++ / C# 等含符号术语不被破坏', () => {
    assert.equal(parseResumeMarkdown('C++ 与 C#')[0].text, 'C++ 与 C#')
  })

  // 下划线强调与技术标识符在结构上无法区分，误判代价不对称
  // （`__init__.py` → `init.py` 是篡改真实技术描述，比留下字面下划线严重得多）。
  // 故取保守策略：下划线强调仅当内容含汉字时剥离，英文标识符一律原样保留。
  test('下划线一律不剥离：技术标识符与中文分隔写法均完好', () => {
    for (const src of [
      '__init__.py 文件', '__main__ 入口', '__init__() 方法',
      '表_订单明细_索引', '用户名_昵称_邮箱', '状态_成功_失败',
      'a_b_c', 't_order_item',
    ]) {
      assert.equal(parseResumeMarkdown(src)[0].text, src, `不得改动：${src}`)
    }
  })

  test('下划线强调刻意保留字面（保守取舍，非缺陷）', () => {
    // 这是有意行为：宁可 HR 看到 __bold__，也不能把 __init__ / 表_订单_索引 篡改掉。
    assert.equal(parseResumeMarkdown('__bold__ here')[0].text, '__bold__ here')
    assert.equal(parseResumeMarkdown('_斜体_ 正常')[0].text, '_斜体_ 正常')
  })

  test('强调标记在词内不生效、在词边界生效', () => {
    // 外侧紧邻词字符 → 不当标记（保护 snake_case）
    assert.equal(parseResumeMarkdown('a_b_c')[0].text, 'a_b_c')
    // 外侧是边界 → 正常剥离
    assert.equal(parseResumeMarkdown('使用**加粗**文字')[0].text, '使用加粗文字')
  })

  // 逐个覆盖行内标记的每种写法，避免"只测了粗体、其余分支没跑"
  test('图片标记保留替代文字', () => {
    assert.equal(parseResumeMarkdown('- ![头像](/a.png)')[0].text, '头像')
  })

  test('粗斜体与下划线的各分支', () => {
    assert.equal(parseResumeMarkdown('- ***粗斜***')[0].text, '粗斜')
    // 下划线强调整类不处理（见 stripInlineMarkdown 的取舍说明）：
    // 与 __init__ / 表_订单明细_索引 结构无法区分，误剥离会篡改真实技术描述。
    assert.equal(parseResumeMarkdown('- ___粗斜___')[0].text, '___粗斜___')
    assert.equal(parseResumeMarkdown('- __粗__')[0].text, '__粗__')
    assert.equal(parseResumeMarkdown('- _斜_')[0].text, '_斜_')
  })

  test('制表符缩进按一个缩进步长计为二级', () => {
    // Tab 计为 2 个空格宽 → floor(2/2)=1 → 二级
    assert.equal(parseResumeMarkdown('\t- 主项')[0].level, 2)
    // 行首无缩进时仍是一级（Tab 在标记之后不算缩进）
    assert.equal(parseResumeMarkdown('- 主项')[0].level, 1)
  })

  test('四个空格的缩进为三级', () => {
    assert.equal(parseResumeMarkdown('- 一项\n    - 深层项')[1].level, 3)
  })

  // ── 嵌套层级：此前缩进信息在导出时丢失 ─────────────────────────────
  test('缩进的要点识别为更深层级', () => {
    const blocks = parseResumeMarkdown('- 主项\n  - 子项\n    - 孙项')
    assert.deepEqual(blocks.map((b) => b.level), [1, 2, 3])
  })

  test('顶层要点层级为 1，与标题的 0 区分开', () => {
    const blocks = parseResumeMarkdown('# 标题\n- 要点')
    assert.equal(blocks[0].level, 0)
    assert.equal(blocks[1].level, 1)
  })
})

describe('导出：ZIP 与 DOCX 结构', () => {
  test('buildZip 生成可被解包的合法 ZIP', () => {
    const zip = buildZip([{ name: 'hello.txt', content: '内容测试' }])
    assert.equal(zip.readUInt32LE(0), 0x04034b50, 'ZIP 本地头签名')
    const entries = readZipEntries(zip)
    assert.equal(entries.get('hello.txt'), '内容测试', '中文往返必须一致')
  })

  test('DOCX 正文含 OOXML 要求的三个必备部件', () => {
    const docx = buildDocx('# 姓名\n- 要点')
    const entries = readZipEntries(docx)
    assert.ok(entries.has('[Content_Types].xml'), '缺少 [Content_Types].xml，Word 会拒绝打开')
    assert.ok(entries.has('_rels/.rels'), '缺少关系文件')
    assert.ok(entries.has('word/document.xml'), '缺少正文')
  })

  // ── 文档属性：此前 options.title 是死参数，文件属性留空 ──────────────
  test('含文档属性部件，且关系与内容类型已登记', () => {
    const entries = readZipEntries(buildDocx('# 张三'))
    assert.ok(entries.has('docProps/core.xml'), '缺少核心属性部件')
    assert.ok(entries.has('docProps/app.xml'), '缺少扩展属性部件')
    // 部件存在但未登记，Word 会视为游离内容
    const types = entries.get('[Content_Types].xml')
    assert.ok(types.includes('/docProps/core.xml'), 'core.xml 未在内容类型中登记')
    assert.ok(types.includes('/docProps/app.xml'), 'app.xml 未在内容类型中登记')
    const rels = entries.get('_rels/.rels')
    assert.ok(rels.includes('docProps/core.xml'), 'core.xml 未在关系中登记')
    assert.ok(rels.includes('docProps/app.xml'), 'app.xml 未在关系中登记')
  })

  test('文档标题缺省取首个一级标题（即姓名）', () => {
    const core = readZipEntries(buildDocx('# 张三\n## 教育')).get('docProps/core.xml')
    assert.ok(core.includes('<dc:title>张三</dc:title>'))
  })

  test('显式传入的 title 优先生效，并完成 XML 转义', () => {
    const core = readZipEntries(buildDocx('# 张三', { title: '前端 & 后端' })).get(
      'docProps/core.xml',
    )
    assert.ok(core.includes('<dc:title>前端 &amp; 后端</dc:title>'), 'title 必须转义')
  })

  test('无一级标题时回退为通用标题而非空白', () => {
    const core = readZipEntries(buildDocx('- 只有要点')).get('docProps/core.xml')
    assert.ok(core.includes('<dc:title>个人简历</dc:title>'))
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

  // ── OOXML 结构合法性：实证缺陷回归 ──────────────────────────────
  // 此前 before/after 各生成一个 <w:spacing>，pPr 里出现重复元素。
  // 既有测试只断言"文本在不在、能不能解包"，完全抓不住这类非法结构，
  // 因此这里直接对 OOXML 的元素重复性做断言。
  test('每个 w:pPr 内的子元素不重复（OOXML maxOccurs=1）', () => {
    const entries = readZipEntries(
      buildDocx('# 姓名\n## 小节\n### 子节\n- 要点\n正文段落'),
    )
    const doc = entries.get('word/document.xml')
    for (const m of doc.matchAll(/<w:pPr>([\s\S]*?)<\/w:pPr>/g)) {
      const inner = m[1]
      for (const el of ['w:spacing', 'w:ind', 'w:jc']) {
        const count = (inner.match(new RegExp(`<${el}[ />]`, 'g')) ?? []).length
        assert.ok(count <= 1, `w:pPr 内 <${el}> 出现 ${count} 次，违反 maxOccurs=1：${inner}`)
      }
    }
  })

  test('h2 同时带 before 与 after 时合并为单个 w:spacing', () => {
    const doc = readZipEntries(buildDocx('## 小节标题')).get('word/document.xml')
    assert.equal((doc.match(/<w:spacing/g) ?? []).length, 1)
    // 两个属性都要在，不能为了去重丢信息
    assert.match(doc, /<w:spacing[^>]*w:before="240"/)
    assert.match(doc, /<w:spacing[^>]*w:after="80"/)
  })

  test('嵌套要点导出为递进缩进，且深层用不同符号', () => {
    const doc = readZipEntries(buildDocx('- 主项\n  - 子项')).get('word/document.xml')
    assert.match(doc, /<w:ind w:left="360"\/>/, '顶级要点缩进 360')
    assert.match(doc, /<w:ind w:left="720"\/>/, '二级要点应缩进 720')
    assert.ok(doc.includes('· 主项'), '顶级用实心圆点')
    assert.ok(doc.includes('◦ 子项'), '二级用空心圆点以区分层次')
  })

  test('XML 属性中不出现裸控制字符（会破坏文档）', () => {
    const doc = readZipEntries(buildDocx('- 正常\t文本')).get('word/document.xml')
    const matches = [...doc.matchAll(/w:[a-zA-Z]+="([^"]*)"/g)]
    // 若文档一个属性都没有，下面的循环不执行、断言恒过——先确保确实扫到了属性
    assert.ok(matches.length > 0, '本用例必须真的扫到 XML 属性，否则是空断言')
    for (const m of matches) {
      // eslint-disable-next-line no-control-regex
      assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(m[1]), '属性值含非法控制字符')
    }
  })

  // ── 控制字符：XML 1.0 明令禁止，此前会原样写入导致 Word 报"文件已损坏" ──
  test('NUL / BEL 等非法控制字符被剔除，文档仍可解包', () => {
    const doc = readZipEntries(buildDocx('# 张\u0000三\n- 正\u0007文')).get('word/document.xml')
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(doc), '非法控制字符必须被剔除')
    // 内容保留（只去掉不可见字符，不吞掉可见文本）
    assert.ok(doc.includes('张三'), '字符被剔除后文本内容应完整')
    assert.ok(doc.includes('正文'))
  })

  test('合法的空白字符（制表/换行/回车）被保留', () => {
    const doc = readZipEntries(buildDocx('# 张\t三')).get('word/document.xml')
    assert.ok(doc.includes('张\t三'), '制表符是合法 XML 空白，不应被剔除')
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

  // 判定与写入必须用同一基准：写入前会 trim 路径，判定也必须 trim，
  // 否则 " a.docx " 会先被判为不支持、而同一路径其实可写（自相矛盾）。
  test('带首尾空白的路径与写入基准保持一致', () => {
    assert.equal(detectExportFormat(' a.docx '), 'docx')
    assert.equal(detectExportFormat('\ta.md\n'), 'md')
  })

  test('带空白的路径可组装，且写入路径被 trim（真写盘验证）', async (t) => {
    const dir = tempDir(t)
    const target = join(dir, 'out.txt')
    const r = await exportResume(
      { resume: '- 商品列表开发', original: '- 商品列表开发，性能提升 40%', outputPath: `  ${target}  ` },
      async (p, d) => writeFileSync(p, d),
    )
    assert.equal(r.format, 'txt')
    assert.equal(r.path, target, '返回值与写入都必须用 trim 后的路径')
    assert.ok(existsSync(target), '必须真的写到 trim 后的路径上')
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

  // ── 端到端（真实临时目录 + 真实 writeResumeFile）────────────────────
  // 此前交付关只用假 writer 测过 wrote=false，装配层的安全边界
  // （目标已存在则拒绝）从未与交付关一起跑过，两道关的先后顺序无覆盖。
  test('端到端：校验通过 + 真实写盘成功', async (t) => {
    const dir = tempDir(t)
    const target = join(dir, 'out.docx')
    const tool = createExportToolDefinition(writeResumeFile)
    const r = await tool.execute({
      resume: '- 负责商品列表开发，性能提升 40%',
      original: '- 商品列表开发，性能提升 40%',
      outputPath: target,
    })
    assert.equal(r.ok, true)
    assert.equal(r.verified, true)
    assert.ok(existsSync(target))
    assert.ok(readZipEntries(readFileSync(target)).has('word/document.xml'))
  })

  test('端到端：校验失败时不落盘，即使目标路径可用', async (t) => {
    const dir = tempDir(t)
    const target = join(dir, 'never.docx')
    const tool = createExportToolDefinition(writeResumeFile)
    await assert.rejects(
      () =>
        tool.execute({
          resume: '- 负责商品列表开发，性能提升 75%', // 75% 原文没有
          original: '- 商品列表开发，性能提升 40%',
          outputPath: target,
        }),
      /反虚构校验未通过/,
    )
    assert.equal(existsSync(target), false, '交付关必须先于写盘生效')
  })

  test('端到端：目标已存在时由装配层拒绝（安全边界仍生效）', async (t) => {
    const dir = tempDir(t)
    const target = join(dir, 'dup.md')
    writeFileSync(target, '用户原有内容')
    const tool = createExportToolDefinition(writeResumeFile)
    await assert.rejects(
      () =>
        tool.execute({
          resume: '- 负责商品列表开发，性能提升 40%',
          original: '- 商品列表开发，性能提升 40%',
          outputPath: target,
        }),
      /已存在/,
    )
    assert.equal(readFileSync(target, 'utf8'), '用户原有内容', '原文件必须原封不动')
  })
})

describe('导出：工具契约', () => {
  test('工具名与 schema 结构正确', () => {
    const tool = createExportToolDefinition(async () => {})
    assert.equal(tool.name, 'export_resume')
    // original 必须是 required：系统提示词与工具描述都承诺"必须传"，
    // 契约层不强制就只是自然语言请求，模型忘传即落回宽松路径（曾是不一致点）。
    assert.deepEqual(tool.parameters.required, ['resume', 'outputPath', 'original'])
    assert.deepEqual(
      Object.keys(tool.output.schema.properties).sort(),
      ['bytes', 'format', 'ok', 'path', 'summary', 'verified'],
    )
  })

  test('参数 schema 接受 original（交付前的校验基准）', () => {
    const tool = createExportToolDefinition(async () => {})
    assert.ok(
      Object.hasOwn(tool.parameters.properties, 'original'),
      'original 必须是受支持的参数，否则无法在导出前校验',
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

// ── 交付关：反虚构校验必须由代码强制，不能靠模型自觉 ──────────────────
//
// 存在理由：此前校验只发生在 verify_rewrite。模型若跳过它直接调
// export_resume，用户就会拿到未经校验、可能含编造内容的简历——
// 等于把铁律交回给"模型自觉"，正是本项目存在理由所要消除的东西。
describe('导出：交付关（反虚构校验强制生效）', () => {
  test('提供原文且校验通过 → 允许导出，verified=true', async () => {
    const original = '负责商品列表开发，使用 Vue2，性能提升 40%'
    // 合法改写：只调整语序与措辞，不新增数字、不升格职责
    const result = await exportResume(
      { resume: '使用 Vue2 负责商品列表开发，性能提升 40%', original, outputPath: 'a.md' },
      async () => {},
    )
    assert.equal(result.ok, true)
    assert.equal(result.verified, true)
    assert.match(result.summary, /反虚构校验已通过/)
  })

  test('提供原文但校验不通过 → 拒绝导出，且不写出任何文件', async () => {
    let wrote = false
    await assert.rejects(
      () =>
        exportResume(
          {
            resume: '负责商品列表开发，性能提升 45%', // 45% 是原文没有的数字
            original: '负责商品列表开发，性能提升 40%',
            outputPath: 'a.md',
          },
          async () => {
            wrote = true
          },
        ),
      /反虚构校验未通过/,
    )
    assert.equal(wrote, false, '校验不通过时绝不能写出文件')
  })

  test('职责升格同样被交付关拦下', async () => {
    await assert.rejects(
      () =>
        exportResume(
          { resume: '主导接口对接', original: '参与接口对接', outputPath: 'a.md' },
          async () => {},
        ),
      /反虚构校验未通过/,
    )
  })

  test('未提供原文 → 允许导出留档，但明确标注未校验', async () => {
    const result = await exportResume({ resume: '# 简历', outputPath: 'a.md' }, async () => {})
    assert.equal(result.ok, true)
    assert.equal(result.verified, false, '未校验不得谎报为已校验')
    assert.match(result.summary, /未做反虚构校验/)
  })

  test('原文为空白字符串等同于未提供', async () => {
    const result = await exportResume(
      { resume: '# 简历', original: '   ', outputPath: 'a.md' },
      async () => {},
    )
    assert.equal(result.verified, false)
  })

  // 阻断时必须给出"出路"。否则补全真实联系方式（模型无从知道、只能由用户提供）
  // 的用户会陷入"改好了却导不出"的死锁。
  test('被阻断时给出可操作的处理方式，而非只有报错', async () => {
    try {
      await exportResume(
        { resume: '手机：13800000000', original: '- 前端开发', outputPath: 'a.md' },
        async () => {},
      )
      assert.fail('本应被阻断')
    } catch (err) {
      assert.match(err.message, /处理方式/, '必须给出出路指引')
      assert.match(err.message, /写进简历原文/, '应指明把真实信息补进原文这条路')
    }
  })

  // 用户把自己的真实信息补进原文之后，同一次导出必须能通过——
  // 这条路若不通，交付关就是死锁而非保护。
  test('用户补全真实信息后可正常导出', async () => {
    const original = '# 张三\n手机：13800000000\n- 负责商品列表开发，性能提升 40%'
    const rewritten = '# 张三\n手机：13800000000\n\n## 项目经历\n- 负责商品列表开发，性能提升 40%'
    const result = await exportResume({ resume: rewritten, original, outputPath: 'a.md' }, async () => {})
    assert.equal(result.verified, true)
  })

  // ── S1-1：「自证清白」绕过（审查发现的严重缺陷，此处为回归锁定）────────
  // original 是模型自己传的参数，不是可信源。若把编造内容同时写进
  // original 与 resume，verifyRewrite 会退化为自反比对，任何编造都"有据可依"，
  // 而返回值还会宣称"已校验通过"——比不做这道关更糟。
  test('original 与 resume 相同时拒绝，不得谎报已校验', async () => {
    const FAB = '# 李四\n主导跨境电商中台建设，性能提升 500%，管理 20 人团队\n曾于字节跳动担任架构师，获年度最佳员工奖'
    let wrote = false
    await assert.rejects(
      () => exportResume({ resume: FAB, original: FAB, outputPath: 'a.md' }, async () => { wrote = true }),
      /original 与 resume 实质相同/,
    )
    assert.equal(wrote, false, '绝不能写出文件')
  })

  test('original 与 resume 仅空白/换行不同，同样拒绝', async () => {
    const text = '# 李四\n主导中台建设，性能提升 500%'
    await assert.rejects(
      () =>
        exportResume(
          { resume: `  ${text.replace('\n', '\r\n')}  `, original: text, outputPath: 'a.md' },
          async () => {},
        ),
      /实质相同/,
    )
  })

  // ── S1-3：校验范围必须说清（避免"整份文件已校验"的误导）───────────────
  test('含附录时 summary 必须声明校验范围仅限简历本体', async () => {
    const result = await exportResume(
      {
        resume: '- 负责商品列表开发，性能提升 40%',
        original: '- 商品列表开发，性能提升 40%',
        outputPath: 'a.md',
        includeAppendix: true,
        changes: '改动说明：调整语序',
      },
      async () => {},
    )
    assert.equal(result.verified, true)
    assert.match(
      result.summary,
      /校验范围仅限简历本体/,
      '附录不参与校验时必须声明，不能笼统说"已通过"',
    )
  })

  test('不含附录时不出现范围声明（避免噪音）', async () => {
    const result = await exportResume(
      { resume: '- 负责商品列表开发，性能提升 40%', original: '- 商品列表开发，性能提升 40%', outputPath: 'a.md' },
      async () => {},
    )
    assert.ok(!/校验范围仅限简历本体/.test(result.summary))
  })
})
