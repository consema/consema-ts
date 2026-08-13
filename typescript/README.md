# Consema TypeScript implementation

The TypeScript implementation of the language-neutral Consema
configuration-processing contracts (RFC 0016; equal footing with
Rust/Go/Python/Kotlin per the 2026-08-11 owner decision). It is
dependency-free at runtime (only `typescript` + `@types/node` as dev
dependencies, package.json:38-41) and never imports or calls the Rust,
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

## Compiler line evaluation (TS 6/7, 2026-08-12)

Native-line compatibility measured on node 26.7.0 / npm 11.19.0 with the
exact zod-mode procedure of the CI ts-compiler-matrix job (`npm install -D
typescript@<v>` then `npm run check`, i.e. `tsc --noEmit` strict):

| typescript | line | result |
| --- | --- | --- |
| `@latest` = 7.0.2 | native (Go-based, thin JS launcher + native binary) | pass — exit 0, no diagnostics |
| `@6` = 6.0.3 | JS-based (final JS family, 9.1 MB typescript.js) | pass — exit 0, no diagnostics |

Both compiler lines compile the strict tree clean with zero source changes.
The pinned `~5.9.0` devDependency stays the baseline; the
ts-compiler-matrix legs (currently the exact versions 5.8.3 / 5.9.2) can
be extended to 6.0.x / 7.0.x without code changes.

## Conformance

18 suites / 519 cases / aggregate digest `cfd6e296…` are pinned inside the
runner test (`src/conformance/runner.test.ts`, against
conformance/vectors/ by repo-relative path); 519/519 pass in CI
(ci-typescript.yml, ts-conformance job).

## References

- Language plan: [multi-language-implementation-plan.md](https://github.com/consema/consema/blob/main/docs/multi-language-implementation-plan.md) (L0-L5 closed
  for all three new languages, 2026-08-12)
- CI and cross-language verification design: [five-language-ci-design.md](https://github.com/consema/consema/blob/main/docs/five-language-ci-design.md)
