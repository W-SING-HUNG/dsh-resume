# AGENTS.md

本项目遵循 [AGENTS.md 开放格式](https://agents.md/)（由 Linux 基金会 Agentic AI Foundation 托管）。
本文件面向在此仓库工作的 AI 编码工具，说明构建、测试与代码约定。

**人类贡献者请先读 [CONTRIBUTING.md](./CONTRIBUTING.md)。**

---

## 项目结构

```
src/core.js       零依赖核心：业务逻辑 + 契约常量（唯一事实来源）
src/index.js      平台装配：section 注入 + 工具注册
src/prompt.js     核心资产：简历改写引擎 prompt（含 PROMPT_VERSION）
test/node/        测试套件（node:test 标准 runner）
examples/         可运行示例 + fixtures
scripts/          验证工具
.githooks/        pre-commit + pre-push 钩子
```

## 环境准备

```bash
npm install          # 仅装 devDependencies（运行时零依赖）
```

无需构建步骤——本插件是纯 ESM，由 DSH 直接加载。

## 常用命令

```bash
npm test                 # 测试（98 项）
npm run test:coverage    # 测试 + 覆盖率
npm run lint             # 语法检查
npm run typecheck        # JSDoc + checkJs 严格类型检查
npm run check:docs       # 文档引用的路径与 script 是否真实存在
npm run check:secrets    # 发布审计：凭据 + 内部资料引用
npm run check:placeholders  # 占位符残留审计
npm run verify           # 以上全部 + 可运行示例（提交前必跑）
```

**提交前必须 `npm run verify` 全绿。**

## 代码约定

- **ESM only**，`"type": "module"`
- **运行时零依赖**：`dependencies` 必须保持为空对象
- **JSDoc 类型注解 + `checkJs` 严格模式**，类型检查必须通过
- 注释解释**为什么**，不复述代码在做什么
- 中文注释与文档是本项目的既有约定，请保持一致

## 三条硬约束（违反会导致真机崩溃或测试失败）

### 1. `src/` 不得 import 任何 `@deepseek-ai/*` 包

插件从自身位置解析平台包会得到**独立副本**，与宿主形成模块双实例，
`TOOL_RUNTIME_SCHEDULER` Symbol 分叉，运行时崩溃：
`Cannot read properties of undefined (reading 'prepare')`。

正确做法：`ctx.tools.register({ ...普通对象 })`，schema 用**裸 JSON Schema**。

### 2. `package.json` 的 `dependencies` 必须为空

非空会让包管理器在目标 profile 装出第二份平台包，重新制造双实例问题。
平台包只能放 `devDependencies`。

### 3. 反虚构铁律不可削弱

`src/prompt.js` 中的反虚构约束是本项目的存在理由（详见 README）。
测试与 CI guard 会对关键词做断言，任何削弱都会让流水线失败。

## 提交与 PR

- 提交信息使用 `type: subject` 格式（`feat` / `fix` / `docs` / `chore` / `refactor` / `test`）
- 涉及 `src/prompt.js` 的改动必须递增 `PROMPT_VERSION` 并记入 `CHANGELOG.md`
- CI 在 Linux / Windows / macOS × Node 20 / 22 / 24 共 9 个组合上重跑同一套命令

## 开发方式说明

本项目由维护者独立主导：定义问题、设计架构、设定质量标准、逐项验收。
AI 编码工具用于加速实现与测试，**所有代码维护者都能解释其设计取舍**，
关键行为由测试与 CI 锁定。

若你是在此仓库工作的 AI 工具：请把以上硬约束当作不可协商的前提。
遇到需要改变架构决策的情况（例如某约束阻碍了任务），**停下来报告**，
不要自行绕过——这些约束都有真实事故作为依据。
