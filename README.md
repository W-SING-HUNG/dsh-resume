# dsh-resume · Resume Studio

> 粘贴 JD，AI 按岗位重写你的简历 —— 只基于真实经历，绝不编造。

[![CI](https://github.com/W-SING-HUNG/dsh-resume/actions/workflows/ci.yml/badge.svg)](https://github.com/W-SING-HUNG/dsh-resume/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/W-SING-HUNG/dsh-resume)](https://github.com/W-SING-HUNG/dsh-resume/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](#)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 插件。
在会话里粘贴岗位描述与简历原文，模型会调用 `rewrite_resume` 工具，按岗位定制简历。

---

## 目录

- [为什么需要它](#为什么需要它)
- [快速开始](#快速开始)
- [核心特性](#核心特性)
- [反虚构铁律](#反虚构铁律)
- [工作原理](#工作原理)
- [开发与验证](#开发与验证)
- [架构与硬约束](#架构与硬约束)
- [常见问题](#常见问题)
- [贡献](#贡献)
- [License](#license)

---

## 为什么需要它

投递时每个岗位都要微调简历：对齐 JD 关键词、调整经历顺序、强化表述。
人工做这件事，一个岗位要花 20-30 分钟；不改，又会在 ATS（简历筛选系统）里沉底。

现有网页版简历工具的问题：

- 简历要上传到第三方服务器
- 切换平台，割裂工作流
- 无法保证"不编造"——很多工具会主动替用户加经历

本插件把这件事放进你已有的 AI 工作流，且**从机制上不可能编造**。

## 快速开始

### 安装

```bash
# 1. 放入 DSH 插件目录（$DSH_HOME 默认 ~/.dsh）
#    把 dsh-resume 放到 $DSH_HOME/plugins/dsh-resume

# 2. 装进目标 profile（pnpm 语义）
dsh plugin --profile web add "file:///$DSH_HOME/plugins/dsh-resume"

# 3. 在 profile 的 package.json 中把插件加入 bundles
#    $DSH_HOME/profiles/web/package.json → dsh.profile.bundles 追加 "dsh-resume"

# 4. 重启
dsh web
```

仅装依赖不够——必须出现在 `dsh.profile.bundles` 里，加载器才会应用它的 patch。

### 使用

插件装载后自动注册 `rewrite_resume` 工具，并向系统提示词注入求职意图感知。
直接在会话里说：

> 帮我根据这个岗位要求优化一下简历。
>
> **【JD】** …岗位描述原文…
>
> **【我的简历】** …简历原文…

模型会自动调用工具，交付三部分：**优化后简历 / 改动说明 / 待补充清单**。

### 先看看它长什么样

无需安装 DSH 即可运行示例：

```bash
npm install
npm run example
```
## 核心特性

| 特性 | 状态 | 说明 |
|---|---|---|
| JD × 简历 → 定制简历 | ✅ | ATS 关键词对齐、经历权重重排 |
| **反虚构代码守卫** | ✅ | **确定性校验，不依赖模型自觉**，见下节 |
| 改动说明 | ✅ | 每处改动对应 JD 哪条要求，5 条以内 |
| 待补充清单 | ✅ | JD 要求但简历缺失的能力，**明示而非编造** |
| 会话内工具调用 | ✅ | agent 可自动识别意图并调用 |
| 中英双语 | ✅ | `language: 'zh' \| 'en'` |
| 独立双栏 UI 面板 | 计划中 | client half |
| 导出 PDF / Word | 计划中 | 排版件生成 |
| 多版本管理 | 计划中 | 每个 JD 一版 |

## 反虚构：从"提示词约束"到"代码校验"

> **只能重排与强化简历中真实存在的信息。禁止编造任何新经历、新数据、新技能。**

这不是一句宣传语，而是本项目的存在理由。编造的经历会在面试第一轮就被问穿，
用户因此丢掉 offer，插件也因此被差评——**编造等于项目自杀**。

### 为什么提示词不够

把铁律写进提示词，只能表达**意图**，无法提供**保证**：模型一旦违反，
没有任何机制能发现，用户会拿着编造的内容去面试。
因此本项目把反虚构做成**确定性代码校验**——判定由代码执行，不依赖模型的态度。

### 守卫检查什么

改写完成后，`verify_rewrite` 工具会逐项比对你的简历原稿与改写结果：

| 检查项 | 级别 | 说明 |
|---|---|---|
| 出现原文没有的**数字** | 必须修正 | 简历里风险最高的编造类型（"提升 40%"、"服务 8 万用户"） |
| 出现原文没有的**机构/专名** | 必须修正 | 换了公司名、加了没做过的项目 |
| **职责强度被升格** | 必须修正 | 把"参与"写成"主导"、"协助"写成"负责"——比编数字更隐蔽，面试追问时才暴露 |
| **时间点被改动** | 必须修正 | 起止日期属事实字段，改动会与背调不符 |
| **整条内容凭空新增** | 必须修正 | 与原文任何一条都对不上的表述（如凭空多出一段没做过的经历） |
| **关键词覆盖虚报** | 必须修正 | 声称已对齐 JD 关键词，但该词并未真的写进简历 |
| 原文数字在改写后**丢失** | 建议检查 | 真实量化结果被无意删掉 |

**为什么专门检测"职责升格"**：简历造假最常见、也最隐蔽的形态不是编数字，
而是悄悄抬高职责——"参与"变"主导"、"协助"变"负责"。
数字编造容易被追问（"这 40% 怎么算的"），职责升格往往能蒙混过关，
直到面试官问"你是怎么主导的"才露馅，对用户的伤害更大。
许多工具在文档里写了这条纪律，但只作为给模型的提示；**本项目把它做成了代码检查。**

**强制闭环**：模型改写后必须调用守卫自检；返回不通过时**必须修正后重新校验**，
直到通过才能交付。未通过校验就交付视为违反铁律。

### 已知边界（不夸大能力）

守卫明确声明它能做什么、不能做什么——**使用者知道边界在哪，才不会被虚假的安全感误导**：

- 只检测**带强后缀**的机构名（某某公司/大学/银行…）；无后缀的机构名（如"字节跳动"）无法可靠识别，需人工确认
- 数字按 token 比对，不做语义判断：把"提升 40%"改成"提升四成"不会被发现
- 职责升格检测基于中文动词词表，措辞避开词表的同义升格可能漏检
- 整条新增检测按字级相似度判定："把原有经历改写得面目全非"可能被误报为新增，需人工确认
- **本校验只做文本特征比对，不判断内容是否真实**——它拦得住"与原文对不上"的编造，拦不住"原文本身就写了假的"

> **设计取舍**：宁可漏报少数无后缀机构，也不制造大量误报。
> 一个频繁误报的守卫会被使用者直接忽略——那比没有守卫更糟。

### 三重保障

**第一重：提示词层**
`src/prompt.js` 内置三条硬规则，并强制要求改写后调用守卫校验。

**第二重：代码层**
`src/guard.js` 确定性比对（纯函数、零依赖、可离线测试），
`npm run check:guard` 做**行为级**验证——若守卫被改成"永远通过"，脚本立刻失败。

**第三重：测试层**
`npm test` 含守卫测试，其中**反向验证**用例专门确认"编造必须被抓住"，
正向用例确认"合法改写不得误报"。CI 的 guard 任务独立再校验一次。

## 工作原理

```
用户会话
   │  「帮我按这个 JD 优化简历」
   ▼
DSH 会话模型 ──识别求职意图──▶ 调用 rewrite_resume 工具
   │                                    │
   │                          ┌─────────┴──────────┐
   │                          │  src/core.js       │
   │                          │  纯函数，零副作用   │
   │                          │  返回改写指令集     │
   │                          └─────────┬──────────┘
   │                                    │
   ▼                                    ▼
模型按指令集重写 ──▶ 调用 verify_rewrite 校验
                          │
                    ┌─────┴─────┐
                    │           │
                 通过        不通过
                    │           │
                    ▼           ▼
              四段式交付    修正后重新校验
```

**两层设计**：工具不做重写，只产出**改写指令集**；真正的重写由会话模型执行。
这样插件的核心逻辑保持纯函数、可离线测试，且不绑定任何模型实现。
反虚构校验作为独立工具介入，形成"改写 → 校验 → 修正"的闭环。

## 开发与验证

```bash
npm install          # 仅装 devDependencies
npm run verify       # 全量验证：语法 + 类型 + 文档检查 + 发布审计 + 守卫行为 + 120 项测试 + 示例
```

| 命令 | 内容 | 需要 DSH |
|---|---|---|
| `npm run lint` | 语法检查 | 否 |
| `npm run typecheck` | TypeScript 静态类型检查（JSDoc + checkJs） | 否 |
| `npm test` | 120 项测试，node:test 标准 runner | 否 |
| `npm run test:coverage` | 覆盖率报告 | 否 |
| `npm run check:guard` | **守卫行为验证**（编造必须被拦、合法必须放行） | 否 |
| `npm run check:docs` | 文档一致性检查 | 否 |
| `npm run check:secrets` | 敏感信息扫描 | 否 |
| `npm run example` | 可运行示例（含守卫演示） | 否 |
| `npm run verify` | 以上全部 | 否 |

测试分五组（`test/node/`）：

- `guard.test.js` — **反虚构守卫**：token 提取、反向验证（编造必须被抓住）、
  正向路径（合法改写必须放行）、防误报、已知局限声明
- `core.test.js` — 语言规范化、输出契约、真实场景、失败路径
- `contract.test.js` — 工具定义形态、schema 关键字白名单、真实 execute
- `plugin.test.js` — `apply(ctx)` 装载路径、架构硬约束守卫
- `schema.test.js` — 调用平台自身的断言函数校验 schema（探测不到 DSH 时优雅跳过）
- `publish-audit.test.js` — 发布审计元测试

CI 在 Linux / Windows / macOS × Node 20 / 22 / 24 共 9 个组合上重跑同一套命令。

## 架构与硬约束

```
src/guard.js    反虚构守卫：确定性校验（零依赖纯函数，可离线测试）
src/core.js     零依赖核心：业务逻辑 + 契约常量（唯一事实来源）
src/index.js    平台装配：section 注入 + 工具注册（零平台依赖）
src/prompt.js   核心资产：简历改写引擎 prompt（含版本号）
test/node/      测试套件
examples/       可运行示例与 fixtures
scripts/        验证工具（文档一致性 / 发布审计 / 守卫行为 / 测试运行器）
```

### 两条不容违反的硬约束

这两条都是端到端验证踩坑得出的，纯离线测试发现不了：

**1. 插件不可 `import` 任何 `@deepseek-ai/*` 包**

```js
// ❌ 会让运行时崩溃
import { defineTool } from '@deepseek-ai/dsh-tools'
```

原因：插件从自身位置会解析到一份**独立的 dsh-tools 副本**，与宿主运行时形成模块双实例。
两份模块里的 `TOOL_RUNTIME_SCHEDULER` 是不同的 Symbol，宿主执行工具时取到 `undefined`，
报 `Cannot read properties of undefined (reading 'prepare')`。

**2. `package.json` 的 `dependencies` 必须为空**

声明平台包会让 pnpm 在目标 profile 里再装一份，重新制造上述双实例问题。
平台包只放 `devDependencies`（仅供测试）。

### 其他契约要点

- **schema 关键字白名单**：平台只接受 `type/oneOf/properties/required/additionalProperties/items/enum/const` + 注解
- **`required` 位置**：必须是 object 根级的字符串数组，不能写在 property 内部
- **输出 schema 的 `additionalProperties:false`**：`execute` 返回值字段必须与其严格一致，多一字段即 `ToolOutputError`
- **参数根节点是开放对象**：平台不拦截未知参数，防线是 `required` 校验 + 白名单解构

## 常见问题

**简历内容会被上传到第三方吗？**

不会。插件自身零网络请求、零文件写入。简历只在你的本地会话中流转。

**它会不会替我编造经历？**

不会。见[反虚构铁律](#反虚构铁律)——三重机制的保障，且有测试物理锁定。

**支持哪些语言？**

工具支持中英双语输出（`language: 'zh' | 'en'`）。

**需要什么版本的 DSH？**

针对 `@deepseek-ai/dsh-tools@0.1.5-rc.2` 与 cordis `4.0.2` 验证。Node 需 20 以上。

**有独立界面吗？**

当前是会话驱动形态（工具 + 提示词注入），没有独立图形界面。双栏 UI 面板在路线图中。

**为什么工具返回的是"指令集"而不是直接改写好的简历？**

因为重写需要理解语义，交给会话模型做质量更高，且让插件核心保持纯函数、可离线测试。
这是刻意的架构选择，不是功能缺失。

## 贡献

欢迎 PR。动手前请读 [CONTRIBUTING.md](CONTRIBUTING.md)——里面有两条会直接导致运行崩溃的硬约束，
以及反虚构铁律的不可违反说明。

```bash
npm run verify   # 提交前必须全绿
```

## License

[MIT](LICENSE)
