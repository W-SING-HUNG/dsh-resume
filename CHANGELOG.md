# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
