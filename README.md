# Consema TypeScript implementation

The TypeScript implementation of the language-neutral Consema
configuration-processing contracts (RFC 0016; equal footing with
Rust/Go/Python/Kotlin per the 2026-08-11 owner decision). It is
dependency-free at runtime (only `typescript` + `@types/node` as dev
dependencies, package.json:29-32) and never imports or calls the Rust,
Go, Python or Kotlin implementations.

## Verify

```
cd typescript
npm ci
npm run check        # tsc --noEmit (strict)
npm test             # node --test src/
npm run test:differential   # byte parity / normalized / protocol exchange
                            # (require CONSEMA_DIFFERENTIAL_* golden env vars;
                            # missing env = documented skip, never silent)
```

## Conformance

18 suites / 508 cases / aggregate digest `35bebc8d…` are pinned inside the
runner test (`src/conformance/runner.test.ts`, against
conformance/vectors/ by repo-relative path); 508/508 pass in CI
(ci-typescript.yml, ts-conformance job).

## References

- Language plan: `docs/multi-language-implementation-plan.md` (L0-L5 closed
  for all three new languages, 2026-08-12)
- CI and cross-language verification design: `docs/five-language-ci-design.md`
