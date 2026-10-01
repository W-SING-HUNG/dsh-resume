// 【端到端验收】按 DSH 真实装载方式驱动插件：
//   1. 用 mock ctx 调 apply() —— 与平台调用**同一入口**，拿到真正注册的工具
//   2. 从注册结果里取工具（不直接 import 定义函数，避免"测的不是线上那份"）
//   3. 走完整闭环：改写 → 校验 → 导出，并校验落盘文件的**真实字节**
//
// 与单元测试的分工：单元测试验证判据正确性（两侧锁定）；
// 本文件验证"用户拿到的东西是否真能用"——工具契约、文件格式、安全边界、
// 以及"缺 original 时如实降级"这类只有端到端才暴露的行为。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { apply } from '../../src/index.js'

/** mock 平台 ctx：形状与真实 ctx 一致，记录注册内容。 */
function loadPlugin() {
  const tools = []
  const sections = []
  const ctx = {
    tools: { register: (d) => (tools.push(d), () => {}) },
    systemPrompt: { getSectionOrder: () => 2900, section: (s) => sections.push(s) },
  }
  apply(ctx)
  return { tools, sections, byName: Object.fromEntries(tools.map((t) => [t.name, t])) }
}

/** 从内存 ZIP 取条目（零依赖解 docx）。 */
function zipEntry(buffer, entryName) {
  let i = 0
  while (i < buffer.length - 30) {
    if (buffer.readUInt32LE(i) !== 0x04034b50) {
      i += 1
      continue
    }
    const method = buffer.readUInt16LE(i + 8)
    const compSize = buffer.readUInt32LE(i + 18)
    const nameLen = buffer.readUInt16LE(i + 26)
    const extraLen = buffer.readUInt16LE(i + 28)
    const nm = buffer.slice(i + 30, i + 30 + nameLen).toString('utf8')
    const dataStart = i + 30 + nameLen + extraLen
    if (nm === entryName) {
      const data = buffer.slice(dataStart, dataStart + compSize)
      if (method === 0) return data.toString('utf8')
      if (method === 8) return inflateRawSync(data).toString('utf8')
      return null
    }
    i = dataStart + compSize
  }
  return null
}
const docxXml = (p) => zipEntry(readFileSync(p), 'word/document.xml') ?? ''
const docxText = (p) => docxXml(p).replace(/<[^>]*>/g, '')

const ORIGINAL = `# 李明
电话：138-0000-0000 | 邮箱：liming@example.com

## 专业技能
- 熟悉 Java / Spring Boot / MySQL / Redis 的使用
- 熟悉 Vue2、Webpack 前端技术栈

## 项目经历
- 使用 Spring Boot 开发订单核心模块，QPS 从 800 提升到 2400；
- 使用 Redis 缓存热点数据，响应时间从 320ms 降到 80ms；
- 参与订单超时关单功能设计，负责定时任务部分。
`
// 只做排版规范化 + ATS 对齐，不新增任何主张
const REWRITTEN = `# 李明
电话：138-0000-0000 | 邮箱：liming@example.com

## 专业技能（Skills）
- 熟悉 Java / Spring Boot / MySQL / Redis 的使用
- 熟悉 Vue2、Webpack 前端技术栈

## 项目经历（Projects）
- 使用 Spring Boot 开发订单核心模块，**QPS 从 800 提升到 2400**；
- 使用 Redis 缓存热点数据，响应时间从 320ms 降到 80ms；
- 参与订单超时关单功能设计，负责定时任务部分。
`

describe('端到端：插件装载与工具契约', () => {
  test('apply 注册 3 个工具并注入 1 个 section', () => {
    const { tools, sections, byName } = loadPlugin()
    assert.equal(tools.length, 3)
    assert.equal(sections.length, 1)
    assert.ok(sections[0].name && sections[0].order !== undefined && sections[0].text)
    assert.ok(byName.rewrite_resume && byName.verify_rewrite && byName.export_resume)
  })

  test('每个工具都有完整的平台执行契约', () => {
    const { tools } = loadPlugin()
    for (const t of tools) {
      assert.ok(typeof t.description === 'string' && t.description.length > 10, `${t.name} description`)
      assert.equal(t.parameters.type, 'object', `${t.name} parameters`)
      assert.equal(t.parameters.additionalProperties, false, `${t.name} additionalProperties`)
      assert.ok(t.output?.schema && typeof t.output.render === 'function', `${t.name} output`)
      assert.equal(typeof t.execute, 'function', `${t.name} execute`)
    }
  })

  test('可重复装载，不共享可变状态', () => {
    const a = loadPlugin()
    const b = loadPlugin()
    assert.equal(a.tools.length, 3)
    assert.equal(b.tools.length, 3)
    assert.notEqual(a.tools[0], b.tools[0])
  })
})

describe('端到端：完整交付闭环（改写 → 校验 → 导出）', () => {
  test('rewrite_resume 返回可执行的指令集', async () => {
    const { byName } = loadPlugin()
    const out = await byName.rewrite_resume.execute({ jd: '后端工程师，熟悉 Java', resume: ORIGINAL })
    const text = out.instruction
    assert.ok(typeof text === 'string' && text.length > 200)
    assert.match(text, /禁止编造|不得编造/)
    assert.match(text, /verify_rewrite/)
    assert.match(text, /export_resume/)
    assert.match(text, /待补充/)
    assert.ok(Array.isArray(byName.rewrite_resume.output.render({}, out)))
  })

  test('verify_rewrite 通过合法改写，并如实返回边界声明', async () => {
    const { byName } = loadPlugin()
    const ok = await byName.verify_rewrite.execute({
      original: ORIGINAL,
      rewritten: REWRITTEN,
      claimedKeywords: ['Java', 'Spring Boot', 'Redis'],
    })
    assert.equal(ok.ok, true, JSON.stringify(ok.issues))
    assert.equal(ok.errorCount, 0)
    assert.equal(typeof ok.guardVersion, 'string')
    assert.ok(Array.isArray(ok.limitations) && ok.limitations.length > 0, '必须如实声明边界')
    assert.equal(ok.unverifiedKeywords.length, 0)
    assert.ok(Array.isArray(byName.verify_rewrite.output.render({}, ok)))
  })

  test('verify_rewrite 拦住编造，且给出可执行的修正指引', async () => {
    const { byName } = loadPlugin()
    const bad = await byName.verify_rewrite.execute({
      original: ORIGINAL,
      rewritten: REWRITTEN.replace('2400', '9999'),
    })
    assert.equal(bad.ok, false)
    assert.ok(bad.errorCount > 0)
    assert.ok(bad.issues.length > 0)
    assert.match(bad.issues.join(''), /删除|修正|改回/)
    assert.match(bad.summary, /修正|删除/)
  })

  test('verify_rewrite 抓住虚报的关键词覆盖', async () => {
    const { byName } = loadPlugin()
    const r = await byName.verify_rewrite.execute({
      original: ORIGINAL,
      rewritten: REWRITTEN,
      claimedKeywords: ['Kubernetes'],
    })
    assert.equal(r.ok, false)
    assert.ok(r.unverifiedKeywords.includes('Kubernetes'))
  })

  test('export_resume 写出可投递的 .docx（校验真实字节）', async () => {
    const { byName } = loadPlugin()
    const dir = mkdtempSync(join(tmpdir(), 'e2e-docx-'))
    const p = join(dir, 'out.docx')
    try {
      const res = await byName.export_resume.execute({
        resume: REWRITTEN,
        original: ORIGINAL,
        outputPath: p,
      })
      assert.equal(res.verified, true)
      assert.ok(res.bytes > 0)
      assert.equal(res.path, p, '回执必须是实际落盘的绝对路径')
      assert.ok(existsSync(p))
      const buf = readFileSync(p)
      assert.equal(buf[0], 0x50, 'docx 必须是 ZIP')
      assert.equal(buf[1], 0x4b)
      assert.equal(buf.length, res.bytes, '回执字节数必须与文件一致')
      const xml = docxXml(p)
      assert.ok(xml.length > 0, '必须能解出 word/document.xml')
      assert.match(xml, /专业技能/)
      assert.match(xml, /Skills/)
      assert.match(xml, /2400/)
      assert.match(xml, /<w:b\/>|<w:b /, '加粗必须被渲染')
      assert.ok(Array.isArray(byName.export_resume.output.render({}, res)))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('export_resume 拒绝让编造落盘', async () => {
    const { byName } = loadPlugin()
    const dir = mkdtempSync(join(tmpdir(), 'e2e-bad-'))
    const p = join(dir, 'bad.docx')
    try {
      await assert.rejects(
        byName.export_resume.execute({
          resume: REWRITTEN.replace('2400', '9999'),
          original: ORIGINAL,
          outputPath: p,
        }),
      )
      assert.equal(existsSync(p), false, '被拒时不得留下文件')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('端到端：文件与路径安全边界', () => {
  test('绝不覆盖已存在的文件', async () => {
    const { byName } = loadPlugin()
    const dir = mkdtempSync(join(tmpdir(), 'e2e-ovw-'))
    const p = join(dir, 'exists.docx')
    writeFileSync(p, 'x')
    try {
      await assert.rejects(
        byName.export_resume.execute({ resume: REWRITTEN, original: ORIGINAL, outputPath: p }),
      )
      assert.equal(readFileSync(p, 'utf8'), 'x', '原文件必须原封不动')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('父目录不存在 / 目标是目录 / 无扩展名 → 一律拒绝', async () => {
    const { byName } = loadPlugin()
    const dir = mkdtempSync(join(tmpdir(), 'e2e-path-'))
    try {
      for (const p of [join(dir, 'nope', 'a.docx'), dir, join(dir, 'noext')]) {
        await assert.rejects(
          byName.export_resume.execute({ resume: REWRITTEN, original: ORIGINAL, outputPath: p }),
          `应拒绝：${p}`,
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('md / txt 格式可用', async () => {
    const { byName } = loadPlugin()
    const dir = mkdtempSync(join(tmpdir(), 'e2e-fmt-'))
    try {
      for (const [ext, want] of [
        ['.md', /## 专业技能/],
        ['.txt', /专业技能/],
      ]) {
        const p = join(dir, `o${ext}`)
        const r = await byName.export_resume.execute({
          resume: REWRITTEN,
          original: ORIGINAL,
          outputPath: p,
        })
        assert.ok(r.bytes > 0)
        assert.match(readFileSync(p, 'utf8'), want)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('拒绝自反比对（把改写结果当原文传）', async () => {
    const { byName } = loadPlugin()
    const dir = mkdtempSync(join(tmpdir(), 'e2e-self-'))
    try {
      await assert.rejects(
        byName.export_resume.execute({
          resume: REWRITTEN,
          original: REWRITTEN,
          outputPath: join(dir, 'self.docx'),
        }),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('端到端：附录与如实降级', () => {
  test('includeAppendix 真的写入附录，默认不写', async () => {
    const { byName } = loadPlugin()
    const dir = mkdtempSync(join(tmpdir(), 'e2e-app-'))
    try {
      const withApp = join(dir, 'app.docx')
      await byName.export_resume.execute({
        resume: REWRITTEN,
        original: ORIGINAL,
        outputPath: withApp,
        includeAppendix: true,
        changes: '- 技能区标题补英文对照，便于 ATS 匹配',
        gaps: '- 缺少 Kubernetes 经验（JD 要求）',
        verification: 'verify_rewrite: ok=true, guard 1.2.0',
      })
      const txt = docxText(withApp)
      assert.match(txt, /技能区标题补英文对照/, '附录应有改动说明')
      assert.match(txt, /Kubernetes/, '附录应有待补充')
      assert.match(txt, /guard 1\.2\.0/, '附录应有校验结果')
      assert.match(txt, /专业技能/, '简历本体仍在')

      const noApp = join(dir, 'noapp.docx')
      await byName.export_resume.execute({ resume: REWRITTEN, original: ORIGINAL, outputPath: noApp })
      assert.doesNotMatch(docxText(noApp), /技能区标题补英文对照/, '默认不得写附录')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('缺 original 时如实降级（导出但 verified=false 并说明未校验）', async () => {
    const { byName } = loadPlugin()
    const dir = mkdtempSync(join(tmpdir(), 'e2e-noorig-'))
    try {
      const r = await byName.export_resume.execute({
        resume: REWRITTEN,
        outputPath: join(dir, 'noorig.docx'),
      })
      assert.equal(r.verified, false, '未校验就不得声称已校验')
      assert.match(r.summary, /未做反虚构校验/, '必须显式说明未校验')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('纯排版差异不得降级 verified（加粗/缩进/有序列表/页码）', async () => {
    // 【端到端抓出的真实缺陷】只加 markdown 标记（如加粗）时，
    // 扁平化后两侧完全相同 → 曾误判 `contains` 档 → verified 被降级为 false，
    // 回执谎称"无法确认 original 是否真实"。内容一字未增，那是误报。
    const { byName } = loadPlugin()
    const dir = mkdtempSync(join(tmpdir(), 'e2e-fmt2-'))
    try {
      const cases = [
        ['加粗', REWRITTEN],
        ['页码', `${REWRITTEN}\n\n第 1 页 / 共 1 页\n`],
      ]
      for (const [label, resume] of cases) {
        const r = await byName.export_resume.execute({
          resume,
          original: ORIGINAL,
          outputPath: join(dir, `${label}.docx`),
        })
        assert.equal(r.verified, true, `${label}：纯排版差异不得降级 verified`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('端到端：英文简历', () => {
  const EN_ORIG = `# Li Ming
Phone: 138-0000-0000 | Email: liming@example.com

## Skills
- Java / Spring Boot / MySQL / Redis

## Projects
- Built order core module with Spring Boot, QPS from 800 to 2400;
- Cached hot data with Redis, latency from 320ms to 80ms.
`
  const EN_REW = EN_ORIG.replace(
    '- Built order core module with Spring Boot, QPS from 800 to 2400;',
    '- Built order core module with Spring Boot, **QPS from 800 to 2400**;',
  )

  test('英文合法改写通过并成功导出', async () => {
    const { byName } = loadPlugin()
    const dir = mkdtempSync(join(tmpdir(), 'e2e-en-'))
    try {
      const v = await byName.verify_rewrite.execute({ original: EN_ORIG, rewritten: EN_REW })
      assert.equal(v.ok, true, JSON.stringify(v.issues))
      const p = join(dir, 'en.docx')
      const r = await byName.export_resume.execute({ resume: EN_REW, original: EN_ORIG, outputPath: p })
      assert.equal(r.verified, true)
      assert.match(docxText(p), /Spring Boot/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('英文编造被拦住且不落盘', async () => {
    const { byName } = loadPlugin()
    const dir = mkdtempSync(join(tmpdir(), 'e2e-enbad-'))
    const p = join(dir, 'enbad.docx')
    try {
      const v = await byName.verify_rewrite.execute({
        original: EN_ORIG,
        rewritten: EN_REW.replace('2400', '9999'),
      })
      assert.equal(v.ok, false)
      assert.ok(v.errorCount > 0)
      await assert.rejects(
        byName.export_resume.execute({
          resume: EN_REW.replace('2400', '9999'),
          original: EN_ORIG,
          outputPath: p,
        }),
      )
      assert.equal(existsSync(p), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('端到端：非法输入不崩且有明确报错', () => {
  test('export_resume 缺必填 / 类型错误 → 报错而非静默成功', async () => {
    const { byName } = loadPlugin()
    const dir = mkdtempSync(join(tmpdir(), 'e2e-inv-'))
    try {
      for (const args of [
        { original: ORIGINAL, outputPath: join(dir, 'a.docx') },
        { resume: REWRITTEN, original: ORIGINAL },
        { resume: REWRITTEN, original: ORIGINAL, outputPath: 123 },
        { resume: 1, original: ORIGINAL, outputPath: join(dir, 'b.docx') },
      ]) {
        await assert.rejects(byName.export_resume.execute(args))
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('verify_rewrite 缺参时明确报错（不得静默返回 ok）', async () => {
    const { byName } = loadPlugin()
    // 抛错比"返回一个含糊结果"更好：调用方立刻知道参数不对，
    // 不会误以为"校验跑过了、没问题"。
    for (const args of [{ original: ORIGINAL }, {}]) {
      await assert.rejects(byName.verify_rewrite.execute(args))
    }
  })
})
