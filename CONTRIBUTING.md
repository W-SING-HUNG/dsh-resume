# 贡献指南（CONTRIBUTING）

感谢你愿意为 dsh-resume 出力。本文件说明如何在本项目上做出**能被合并**的改动。

## 项目定位（改动前必读）

这是 DeepSeek Harness (DSH) 的求职简历插件。**唯一功能**是：按岗位 JD 重写简历。

其中有一条不可动摇的产品底线：

> **反虚构铁律：只能重排与强化简历中真实存在的信息，禁止编造任何经历、数据、技能。**

任何削弱这条底线的改动（哪怕"只是让输出更好看一点"）都会被拒绝。理由很直接：编造的经历会让用户在面试中翻车，进而毁掉插件口碑。这条规则由测试与 CI 的 guard 任务双重物理锁定，见 `test/node/core.test.js`。

## 开发环境

```bash
git clone <repo-url>
cd dsh-resume
npm install          # 仅装 devDependencies（TypeScript，用于静态检查）
npm run test:all     # 全量验证：86 项断言
```

**不需要** DSH 运行时即可跑全部测试。`test/node/schema.test.js` 会自动探测本机 DSH 安装目录，
找不到时优雅跳过（不算失败）。也可用 `DSH_TOOLS_URL` 显式指定平台包路径。

## 提交前必做

```bash
npm run test:all
```

必须全绿。CI 会在 Linux / Windows / macOS 三平台、Node 20/22/24 三个版本上重跑同一套命令。

## 代码结构约定

```
src/core.js     零依赖核心。所有业务逻辑与契约常量放这里。
src/index.js    平台装配层。只做注册，不写业务逻辑。
src/prompt.js   核心资产：简历改写引擎 prompt。
test/           测试。按层拆分，见下表。
```

**分层原因**：插件必须保持零平台依赖（见下方"两个硬约束"），而测试需要在无 DSH 环境下也能跑。把逻辑放进 `core.js`、装配放进 `index.js`，两个目标同时满足。

### 硬约束一：插件不可 import 平台包

```js
// ❌ 绝对禁止
import { defineTool } from '@deepseek-ai/dsh-tools'
```

一旦这样写，模块会从插件自身位置解析到一份**独立副本**，与宿主运行时形成双实例，
`TOOL_RUNTIME_SCHEDULER` 这个 Symbol 会分叉，运行时崩溃：

```
Cannot read properties of undefined (reading 'prepare')
```

正确做法是直接用普通对象注册：

```js
ctx.tools.register({
  name: 'my_tool',
  description: '...',
  parameters: { /* 裸 JSON Schema */ },
  output: { schema: {...}, render: (_args, value) => [{ type: 'text', text: '...' }] },
  execute(args) { /* ... */ },
})
```

### 硬约束二：package.json 的 dependencies 必须为空

声明平台包会让 pnpm 在目标 profile 里再装一份，重新制造上述双实例问题。
平台包只放 `devDependencies`（仅供测试）。

生态参照物：本机正常运行的 `dsh-purge` 插件，其 `dependencies` 为空对象。

### schema 写法

平台校验器只接受这个子集：

```
type / oneOf / properties / required / additionalProperties / items / enum / const
+ 注解（description / title / default / examples）
```

且 `required` **只能出现在 `type: "object"` 节点上，且必须是字符串数组**。

```js
// ❌ 这是 defineTool DSL 的写法，不是 JSON Schema，平台会拒绝
{ type: 'object', properties: { text: { type: 'string', required: true } } }

// ✅ 正确
{ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
```

## 测试分层

全部测试使用 **node:test 标准 runner**（Node 20+ 内置），位于 `test/node/`：

| 文件 | 层 | 需要 DSH |
|---|---|---|
| `test/node/core.test.js` | 反虚构铁律、语言规范化、输出契约、3 组真实场景、失败路径 | 否 |
| `test/node/contract.test.js` | 工具定义形态、schema 关键字白名单、真实 execute | 否 |
| `test/node/plugin.test.js` | `apply()` 装载路径、架构硬约束守卫 | 否 |
| `test/node/schema.test.js` | **调用平台自身断言函数**校验 schema（缺失时优雅跳过） | 可选 |

```bash
npm test              # 全部测试
npm run test:coverage # 含覆盖率报告
```

新增功能请补对应层的测试。**不要为了通过测试而在测试里重写一遍实现**——那会造成"测试绿但线上崩"的假绿。
本项目所有测试都直接 import 生产代码。

（CI 额外执行静态守卫：扫描 `src/` 是否出现平台包 import、`dependencies` 是否仍为空、铁律关键词是否完整。）

## Prompt 改动

`src/prompt.js` 是本插件的核心资产。改动它时：

1. 不得削弱三项铁律（只用真实信息 / 保留量化 / 缺项进待补充）
2. 必须同步更新 `src/prompt.js` 顶部记录的 prompt 版本号
3. 在 `CHANGELOG.md` 记录改动理由

`test/node/core.test.js` 会对铁律关键词做断言，CI 的 guard 任务再独立扫描一次，改坏会被拦住。

## 提交信息

使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
feat: 增加导出 PDF 能力
fix: 修正 SSR 关键词匹配遗漏
docs: 补充真机装载说明
test: 补 resume 为空的边界用例
```

## Pull Request

- 一个 PR 只做一件事
- 描述里写清：动机、改了什么、怎么验证的
- 涉及行为变更时，附上验证命令与输出摘要

## 提交前检查清单

- [ ] `npm run verify` 全绿（语法 + 类型 + 96 项测试 + 示例）
- [ ] 未引入任何 `import '@deepseek-ai/*'`
- [ ] `package.json` 的 `dependencies` 仍为空
- [ ] 新增 schema 已通过 `test/node/schema.test.js`（真机校验）
- [ ] 若改了 prompt，已更新 `src/prompt.js` 的 `PROMPT_VERSION` 与 CHANGELOG
- [ ] 若改了行为，`README.md` 与 `CHANGELOG.md` 已同步
