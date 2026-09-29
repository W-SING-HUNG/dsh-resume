# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed

- **发布审计的规则改由本地文件驱动**：审计脚本原先把"哪些内容不应发布"的规则
  硬编码在自身源码里，而该脚本是公开文件——规则本身成了敏感信息的载体。
  现改为从 `.git/info/private-terms.txt` 与 `.git/info/exclude`（git 的本地目录，
  永不进入版本库）读取私密规则与内部文件名单，脚本只保留通用凭据模式。
  本地文件缺失时自动降级为仅检查凭据，并打印提示。
- **审计覆盖范围补齐**：原先只做内容关键词匹配，属枚举式，新增文件容易漏过。
  现增加路径级拦截（被跟踪文件命中内部名单即判失败，与内容无关），
  并新增自检探针，防止例外规则过宽导致审计永远通过。

### Added

- `test/node/publish-audit.test.js`：把审计的边界校验锁进测试套件，
  规则文件与脚本行为漂移会让 `npm test` 立即失败。
  该测试不依赖内部文件在磁盘上存在，因此在 CI 的干净克隆中同样有效。
- `examples/fixtures/` 与测试用例改用中性示例数据，不含可对应到真实个人的信息。

### Planned

- 独立双栏 UI 面板（client half）
- 导出 PDF / Word
- 多版本管理（每个 JD 一版简历）

## [0.1.0] - 2026-09-28

首个发布版本。

### Added

- `rewrite_resume` 工具：输入 JD 与简历原文，输出针对该岗位的简历改写指令集
- 系统提示词注入：会话内自动识别求职意图并引导调用工具
- 简历改写引擎 prompt（中英双语），含三项铁律：
  只用真实信息 / 保留原始量化数据 / 缺项进「待补充清单」
- 中英双语输出（`language: 'zh' | 'en'`）
- 完整测试套件（92 项）与跨平台 CI（Linux / Windows / macOS × Node 20 / 22 / 24）

### Security

- 简历内容全程本地会话处理，不上传任何第三方服务
- 插件运行时零网络请求、零文件系统写入

[Unreleased]: https://github.com/W-SING-HUNG/dsh-resume/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/W-SING-HUNG/dsh-resume/releases/tag/v0.1.0
