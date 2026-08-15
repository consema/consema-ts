# @consema/consema

The TypeScript implementation of the language-neutral Consema
configuration-processing contracts (RFC 0002/0003/0004/0006 contract
family; authoritative specs in the consema spec repository
[docs/rfcs/](https://github.com/consema/consema/tree/main/docs/rfcs/);
equal footing with Rust/Go/Python/Kotlin per the 2026-08-11 owner
decision). Dependency-free at runtime — no third-party imports, and it
never imports or calls the Rust, Go, Python or Kotlin implementations.

Parses, queries, projects, edits, materializes and converts documents in
eight format families (JSON / TOML / YAML / INI / Java Properties / XML /
Property List / HCL), with lossless byte-for-byte rendering (W3-37:
consumer-facing package README; development workflow lives in the
repository-root README "构建与测试" section).

## Install

```bash
npm install @consema/consema
```

- Node `>= 26` (`engines`).
- The package ships compiled JS + d.ts (`dist/`); no tsconfig
  prerequisite for consumers.
- The d.ts files are self-contained and do not reference Node types —
  no `@types/node` needed at consumption time.
- Release candidates publish to the `rc` dist-tag:
  `npm install @consema/consema@rc` (GA goes to `latest`).

## Quick start

```ts
import { parseDocument, profiles, formatFamilies } from '@consema/consema';

// Profile instances come from profiles() (the ProfileId class is not
// exported at the package root).
const jsonStrict = profiles().find((p) => p.profile().id() === 'json.strict')?.profile();
if (jsonStrict === undefined) throw new Error('no json.strict profile');

const source = new TextEncoder().encode('{"a":1}');
const document = parseDocument(source, jsonStrict); // lossless parse
const json = document.asJson();
if (typeof json === 'string') throw new Error('not JSON');
console.log(new TextDecoder().decode(document.render())); // prints {"a":1}
```

A full chain example (parse → operator-style native query → best-exact
projection → structural edit → canonical materialization → cross-format
conversion to TOML):
[`examples/sdk_chain.ts`](https://github.com/consema/consema-ts/blob/main/typescript/examples/sdk_chain.ts).

## API summary

Package-root imports (`@consema/consema`):

| Operation | Entry point |
| --- | --- |
| parse | `parseDocument(source: Uint8Array, profile) -> Document` — `Document` is the common opaque union; typed access via the `asJson()` / `asToml()` / ... adapters; `render()` is byte-for-byte identical to the source |
| registry | `formatFamilies()` / `profiles()` / `queryDomains()` / `formatOperationRegistry(profile)` (8 families / 16 profiles / 21 query domains / 16 per-profile operation registries) |
| convert | `convertJson(source, projectionRequest, materializationRequest) -> ConversionResult` (plus `convertToml` / `convertYaml` / `convertIni` / `convertProperties` / `convertXml` / `convertPlist` / `convertHcl`, same shape) |
| core | `coreEqual` / `coreHash`, the closed fifteen-kind value model, the PVCE/1 codec (`encode` / `decode` / ...) |
| graph | `graphEqual` / `graphHash`, the PGCE/1 codec (`encodePGCE` / `decodePGCE` / ...) |
| protocol | diagnostics, contract registry, records, exit classes, CLI records |

Module-internal entry points (`typescript/src/<family>/...`; the package
root does not re-export them at 1.0.0-rc): query (`executeJsonQuery` and
the per-family `execute*Query`), projection (`project` / `project*`),
materialization (`materialize` / `materialize*`), edit
(`EditTransactionBuilder` + `commitEdits`), and the per-family `parse*`
typed adapters. Those modules and the types in their signatures
(`ProfileId`, `JsonDocument`, `ProjectionRequest`,
`MaterializationRequest`, `JsonQueryResult`, ...) are **not importable
from the package**: the `exports` map exposes only the package root and
the tarball ships `dist/` + LICENSE (plus `package.json` and this README,
which npm always includes; no `.ts` sources), so a
module-internal import (e.g. `@consema/consema/dist/document/profile.js`)
throws ERR_PACKAGE_PATH_NOT_EXPORTED (R23, 2026-08-15). For annotations,
import the package-root re-exported types instead — `ConversionResult`,
`ConsemaDocument`, `FormatMismatch`, `ConversionFidelity`,
`CapabilitySet`, `ContractRegistry`, `ErrorCodeRegistry`, `RecordState`,
`ProfileDescriptor`, `Diagnostic`, the core/graph/protocol domain types,
... (the root re-exports them via `index.ts` `export *`). Instances of
the module-local concepts are obtained through the package-root entries
(`profiles()` returns `FormatProfile[]`, whose `.profile()` yields the
`ProfileId` instance; `parseDocument` returns `Document`). A typedoc API
reference is planned at release time (RELEASING.md §5); it is not wired
yet.

## Compatibility

- Semantic versioning; the language-neutral contracts are the single
  authority in the consema spec repository
  (https://github.com/consema/consema).
- Cross-language consistency is enforced by the 18 suites / 519 cases
  conformance gate and the TS-Rust differential gates. Known documented
  fork: the multi-byte Windows code pages CP936/CP949/CP950 are
  recognized but not decoded — any input under one of these pages fails
  parsing with `core.source.invalid-sequence@1` at byte 0 (not just
  invalid sequences), while the Rust reference decodes them
  (encoding_rs). The fork is recorded in the source comment at
  `typescript/src/document/source.ts` — this disclosure ships here
  because that comment does not ship in the package (R28, 2026-08-15).
- Compatibility and support policy: RFC 0020.

## License

MIT — the LICENSE text ships inside the package.
