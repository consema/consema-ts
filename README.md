# Consema TypeScript（consema-ts）

![CI](https://img.shields.io/github/actions/workflow/status/consema/consema-ts/ci-typescript.yml?branch=main)
![Version](https://img.shields.io/github/v/tag/consema/consema-ts)
![License](https://img.shields.io/github/license/consema/consema-ts)

Consema 语言中立契约（RFC 0016）的 **TypeScript 实现**仓库。本仓库是 Consema 六仓
拆分中的 TypeScript 仓：规范权威（RFC、docs、路线图、跨语言 conformance suites）在
[github.com/consema/consema](https://github.com/consema/consema)；本仓承载
TypeScript 实现与跨语言差分验证工具。

Version: 0.14.0（`typescript/package.json` version；CI
check-version-consistency job 断言与 README 一致）。

## 布局

- `typescript/`：TypeScript 包（node 26，`tsc --noEmit` strict，运行时零依赖）。
  完整文档见 [typescript/README.md](typescript/README.md)。
- `scripts/`：跨语言差分验证脚本（byte parity / normalized differential /
  protocol exchange）。脚本构建 consema-rs 的 Rust emitter 并对拍 TypeScript 实现；
  Rust 侧来自 consema-rs 仓 checkout（CI 多仓模式），conformance 数据来自规范仓 checkout。
- `.github/workflows/ci-typescript.yml`：TS 门禁（fmt/type + 单测 + 零依赖）、
  conformance runner 门禁（18 suites / 519 cases）与 TS-Rust 差分门禁
  （windows-latest 多仓 checkout）。

## 构建与测试

```text
cd typescript
npm ci
npm run check        # tsc --noEmit (strict)
npm test             # node --test "src/**/*.test.ts" (glob form, node 26)
```

## 链接

- 规范仓（RFC / docs / 路线图）：https://github.com/consema/consema
- Rust 参考实现：https://github.com/consema/consema-rs
