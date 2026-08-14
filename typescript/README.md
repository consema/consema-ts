# Consema TypeScript implementation

The TypeScript implementation of the language-neutral Consema
configuration-processing contracts (RFC 0016; equal footing with
Rust/Go/Python/Kotlin per the 2026-08-11 owner decision). It is
dependency-free at runtime (only `typescript` + `@types/node` as
devDependencies, package.json `devDependencies` 字段——行号可能漂移，以
字段名为准) and never imports or calls the Rust,
Go, Python or Kotlin implementations.

## Verify

Prerequisite: `npm test` includes the conformance runner, which reads
`conformance/vectors/` by repository-relative path (missing data fails the
run with ENOENT — same provision step as the CI workflows). Provision the
data from a checkout of the consema spec repository beside this one (run at
the repository root):

```powershell
if (Test-Path .\conformance) { Remove-Item .\conformance -Recurse -Force }
Copy-Item -LiteralPath '..\consema\conformance' -Destination '.\conformance' -Recurse -Force
```

```
cd typescript
npm ci
npm run check        # tsc --noEmit (strict)
npm test             # node --test "src/**/*.test.ts" (glob form, node 26)
npm run test:differential   # byte parity / normalized / protocol exchange
                            # (byte parity + normalized require the
                            # CONSEMA_DIFFERENTIAL_* golden env vars; protocol
                            # exchange uses CONSEMA_EXCHANGE_*; missing env =
                            # documented skip, never silent)
```

## Compiler line evaluation (TS 6/7, local one-off measurement 2026-08-12)

本地一次性测量记录（2026-08-12，node 26.7.0 / npm 11.19.0）——过程与 CI
ts-compiler-matrix job 的 zod-mode 步骤一致（`npm install -D
typescript@<v>` 后 `npm run check`，即 `tsc --noEmit` strict）；本表不是
CI 验证结果，6.0.x / 7.0.x 不在 CI 矩阵内：

| typescript | line | result |
| --- | --- | --- |
| `@latest` = 7.0.2 | native (Go-based, thin JS launcher + native binary) | pass — exit 0, no diagnostics |
| `@6` = 6.0.3 | JS-based (final JS family, 9.1 MB typescript.js) | pass — exit 0, no diagnostics |

两条编译器线均以零源码改动通过 strict 树检查。CI ts-compiler-matrix
矩阵目前只钉 5.8.3 / 5.9.2 两条腿；钉定的 `~5.9.0` devDependency 仍是
基线，矩阵可扩展至 6.0.x / 7.0.x 而无需改源码。

## Conformance

18 suites / 519 cases / aggregate digest `cfd6e296…` are pinned in the
runner (`src/conformance/runner.ts`, against conformance/vectors/ by
repo-relative path); `runner.test.ts` asserts them, and 519/519 pass in CI
(ci-typescript.yml, ts-conformance job).

## References

- Language plan: [multi-language-implementation-plan.md](https://github.com/consema/consema/blob/main/docs/multi-language-implementation-plan.md) (L0-L5 closed
  for all three new languages, 2026-08-12)
- CI and cross-language verification design: [five-language-ci-design.md](https://github.com/consema/consema/blob/main/docs/five-language-ci-design.md)
