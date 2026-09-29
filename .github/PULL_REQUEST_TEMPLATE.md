# Pull Request

## 这个 PR 做了什么

<!-- 一句话说明 -->

## 动机

<!-- 解决了什么问题 / 为什么需要这个改动 -->

## 改动类型

- [ ] Bug 修复
- [ ] 新功能
- [ ] 文档
- [ ] 重构（无行为变更）
- [ ] 测试
- [ ] 其他：

## 验证方式

<!-- 你跑了什么命令，结果如何 -->

```bash
npm run verify
```

## 检查清单

- [ ] `npm run verify` 全绿（语法 + 类型 + 92 项测试 + 示例）
- [ ] 未引入任何 `import '@deepseek-ai/*'`（会导致真机崩溃）
- [ ] `package.json` 的 `dependencies` 仍为空
- [ ] 新增 schema 已通过 `test/node/schema.test.js`（真机校验）
- [ ] 若改了 prompt，已更新 `src/prompt.js` 的 `PROMPT_VERSION` 与 `CHANGELOG.md`
- [ ] 若改了行为，`README.md` 与 `CHANGELOG.md` 已同步
- [ ] 未削弱反虚构铁律

## 关联 Issue

<!-- Closes #123 -->
