# Changelog

Consema 遵循 Semantic Versioning。本仓变更记录以规范仓 CHANGELOG 为权威；完整历史与跨语言时间线见 github.com/consema/consema 的 CHANGELOG.md。

## 1.0.0-rc.1（2026-08-12）

六仓拆分落地：本仓自规范仓（github.com/consema/consema）拆分独立（2026-08-12），承载 TypeScript 实现（node 26，`tsc --noEmit` strict，运行时零依赖，version 0.14.0）。

- L0-L4 落地（2026-08-12 · 5cf680b）：core / graph / protocol / document + 8 格式家族 + root facade + conformance runner；
- L5 差分 harness（2026-08-12 · 2f981df）：byte-parity / normalized differential / protocol-exchange 跨语言差分 + 五语言 CI workflow；差分发现的 wire-codec 缺陷随本 commit 修复；
- conformance 519/519（18 套 / 聚合 digest cfd6e296 共钉）+ capability parity；
- CI（ci-typescript.yml）：fmt/type + 单测 + 零依赖门禁、conformance runner 门禁（18 suites / 519 cases）、TS-Rust 差分门禁；
- 完整历史与跨语言时间线见规范仓 CHANGELOG。
