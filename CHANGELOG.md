# Changelog

Consema 遵循 Semantic Versioning。本仓变更记录以规范仓 CHANGELOG 为权威；完整历史与跨语言时间线见 github.com/consema/consema 的 CHANGELOG.md。

## 1.0.0-rc.1（2026-08-10 权威日期——本仓版本推进 commit 66ec3fd 于 2026-08-13 落地；版本日期以规范仓 CHANGELOG 的 2026-08-10 记录为权威，六仓统一，G063 对抗审计 2026-08-14）

六仓拆分落地：本仓自规范仓（github.com/consema/consema）拆分独立（2026-08-12），承载 TypeScript 实现（node 26，`tsc --noEmit` strict，运行时零依赖；拆分时点版本为 0.14.0——本仓拆分装配提交 1faa03f 携带的 typescript/package.json version 为 "0.14.0"，2026-08-13 经 66ec3fd bump 至 1.0.0-rc.1，commit subject 明言「package version 0.14.0->1.0.0-rc.1」）。

- L0-L4 落地（2026-08-12 · [5cf680b](https://github.com/consema/consema/commit/5cf680b716bd4fbd60d03e86c869ce89683573f6)，母仓 consema commit；commit 主题为 fuzz 证据积累，TS/Python/Kotlin 的 L0-L4 实现随该 commit 进入母仓历史——归因勘误见母仓 [cd26af3](https://github.com/consema/consema/commit/cd26af32f43f4012d2c9fd07314f6d78f77eb447)）：core / graph / protocol / document + 8 格式家族 + root facade + conformance runner；
- L5 差分 harness（2026-08-12 · 2f981df，母仓 consema commit）：byte-parity / normalized differential / protocol-exchange 跨语言差分 + 五语言 CI workflow；差分发现的 wire-codec 缺陷随本 commit 修复；
- conformance 519/519（18 套 / 聚合 digest cfd6e296 共钉；capability parity 四测试为 documented skip——provision 步骤刻意不复制 fc-manifest，断言在 runner.ts 对 provisioned manifest 存在时执行，缺失即 skip，见 ci-typescript.yml provision 注记与 R10/W4-13）；
- CI（ci-typescript.yml）：type + 单测 + 零依赖门禁、conformance runner 门禁（18 suites / 519 cases）、TS-Rust 差分门禁；
- 完整历史与跨语言时间线见规范仓 CHANGELOG。
