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
| 改动说明 | ✅ | 每处改动对应 JD 哪条要求，5 条以内 |
| 待补充清单 | ✅ | JD 要求但简历缺失的能力，**明示而非编造** |
| 反虚构铁律 | ✅ | 三重机制保障，见下节 |
| 会话内工具调用 | ✅ | agent 可自动识别意图并调用 |
| 中英双语 | ✅ | `language: 'zh' \| 'en'` |
| 独立双栏 UI 面板 | 计划中 | client half |
| 导出 PDF / Word | 计划中 | 排版件生成 |
| 多版本管理 | 计划中 | 每个 JD 一版 |

## 反虚构铁律

> **只能重排与强化简历中真实存在的信息。禁止编造任何新经历、新数据、新技能。**

这不是一句宣传语，而是本项目的存在理由。编造的经历会在面试第一轮就被问穿，
用户因此丢掉 offer，插件也因此被差评——**编造等于项目自杀**。

### 三重保障机制

**第一重：提示词层**

`src/prompt.js` 内置三条硬规则：只用真实信息 / 保留原文量化数据不夸大 / 缺失能力进待补充清单。

**第二重：测试层**

`npm test` 对铁律关键词做断言，CI 的 guard 任务再独立校验一次。任何削弱都会导致流水线失败。

**第三重：端到端实证**

真实会话中测试"JD 要求 Vue3/TS/Vite/Nuxt 但简历只有 Vue2"的场景，模型输出：

> **未对 Vue3 / TypeScript / Vite / Nuxt/SSR 做任何改写或暗示**：这些是 JD 要求但简历中不存在的能力，
> 按铁律不编造，统一放入下方待补充清单。

并且主动警示用户：

> 不要在简历里把 Vue2 写成 Vue3，这属于造假且面试一问即穿。

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
用户得到三段式交付 ◀── 模型按指令集严格重写 ◀── instruction
```

**两层设计**：工具不做重写，只产出**改写指令集**；真正的重写由会话模型执行。
这样插件的核心逻辑保持纯函数、可离线测试，且不绑定任何模型实现。

## 开发与验证

```bash
npm install          # 仅装 devDependencies
npm run verify       # 全量验证：语法 + 类型 + 文档检查 + 96 项测试 + 示例
```

| 命令 | 内容 | 需要 DSH |
|---|---|---|
| `npm run lint` | 语法检查 | 否 |
| `npm run typecheck` | TypeScript 静态类型检查（JSDoc + checkJs） | 否 |
| `npm test` | 96 项测试，node:test 标准 runner | 否 |
| `npm run test:coverage` | 覆盖率报告 | 否 |
| `npm run check:docs` | 文档一致性检查 | 否 |
| `npm run check:secrets` | 敏感信息扫描 | 否 |
| `npm run example` | 可运行示例 | 否 |
| `npm run verify` | 以上全部 | 否 |

**测试覆盖**：行覆盖率 100%，分支覆盖率 93.75%。

测试分四组（`test/node/`）：

- `core.test.js` — 反虚构铁律、语言规范化、输出契约、3 组真实场景、失败路径
- `contract.test.js` — 工具定义形态、schema 关键字白名单、真实 execute
- `plugin.test.js` — `apply(ctx)` 装载路径、架构硬约束守卫
- `schema.test.js` — 调用平台自身的断言函数校验 schema（探测不到 DSH 时优雅跳过）
- `publish-audit.test.js` — 发布审计元测试：内部资料名单与 `.gitignore` 必须双向一致（防边界被削弱）

CI 在 Linux / Windows / macOS × Node 20 / 22 / 24 共 9 个组合上重跑同一套命令。

## 架构与硬约束

```
src/core.js     零依赖核心：业务逻辑 + 契约常量（唯一事实来源）
src/index.js    平台装配：section 注入 + 工具注册（零平台依赖）
src/prompt.js   核心资产：简历改写引擎 prompt（含版本号）
test/node/      测试套件
examples/       可运行示例与 fixtures
scripts/        验证工具（文档一致性 / 密钥扫描 / 测试运行器）
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
