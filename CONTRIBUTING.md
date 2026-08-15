# Contributing to consema-ts（Consema TypeScript 实现）

Consema 六仓拆分的 TypeScript 仓：本仓承载 TypeScript 实现（`typescript/`
包）与跨语言差分验证工具；规范权威（RFC / docs / 路线图 / conformance
suites）在[规范仓](https://github.com/consema/consema)。

**社区治理以规范仓主文档为准**：报 bug / 提 feature / RFC 流程 / 提交规范 /
评审规范 / 标签体系 / 发布纪律 / 行为准则，一律参见
[consema/CONTRIBUTING.md](https://github.com/consema/consema/blob/main/CONTRIBUTING.md)。
本文件只列本仓特有内容。

## 开发环境

- Node.js 26（`typescript/` 包要求；CI 使用对应版本）。
- 运行时零依赖（`dependencies` 为空）；`package-lock.json` 锁定 dev 依赖。

## 构建与测试

前置：`npm test` 包含 conformance runner，按仓库相对路径读
`conformance/vectors/`（数据缺失即 ENOENT 失败）。本地运行前在仓库根
provision 数据——数据源必须钉定（波 4 R5/R22，2026-08-15；F2 再锚）：并排检出规范仓
consema 后先 checkout 到本仓 CI 钉定的统一 provision commit（当前
`db821cd`，与 ci-typescript.yml / release.yml 的 `ref:` 一致）再复制：

```powershell
git -C ..\consema checkout db821cdf463d0542fa166d61d7e28cec46812bbc
if (Test-Path .\conformance) { Remove-Item .\conformance -Recurse -Force }
Copy-Item -LiteralPath '..\consema\conformance' -Destination '.\conformance' -Recurse -Force
```

```text
cd typescript
npm ci
npm run check        # tsc --noEmit (strict)
npm test             # node --test "src/**/*.test.ts" (glob form, node 26)
```

## 贡献点

- **TypeScript 实现**：`typescript/` 包（PortableValue / 查询 / 投影 /
  materialization / 结构编辑 + 八格式家族）；完整文档见
  [typescript/README.md](typescript/README.md)。
- **差分 harness**：`scripts/` 跨语言差分验证（byte parity / normalized
  differential / protocol exchange）：
  `ts-verify-byte-parity.ps1`、`ts-verify-normalized-differential.ps1`、
  `ts-verify-protocol-exchange.ps1`。脚本构建 consema-rs 的 Rust emitter
  对拍本实现。
- **Conformance 数据同步**：conformance 数据来自规范仓 checkout（CI 多仓
  模式），权威在规范仓，改动必须回规范仓提交后再同步。

## CI 门禁

`.github/workflows/ci-typescript.yml`：type（`tsc --noEmit` strict）/
单测 / 零依赖门禁、conformance runner 门禁（18 suites / 519 cases）与
TS-Rust 差分门禁（windows-latest 多仓 checkout）。push 到 main 或 PR 均
触发；PR 由 pr-labels.yml 检查 kind 标签（标签见规范仓
.github/LABELS.md；如实注记 2026-08-15：该检查不在分支保护必选之列，
合并阻断以必选聚合门禁 `check (all gates green)` 为准）。

## 发布与安全

- 发布：本仓 [RELEASING.md](RELEASING.md)（npm `@consema/consema`，
  `npm publish --provenance`；tag `v*` 触发 release workflow，不要手动发布）。
- 安全：[SECURITY.md](SECURITY.md)；披露统一走规范仓 SECURITY.md 的渠道。
