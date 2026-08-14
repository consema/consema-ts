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
typed adapters. The type names in those signatures (`ProfileId`,
`JsonDocument`, `ProjectionRequest`, `MaterializationRequest`,
`JsonQueryResult`, ...) are module declarations: obtain instances through
the package-root entries (`profiles()` returns `FormatProfile[]`, whose
`.profile()` yields the `ProfileId` instance; `parseDocument` returns
`Document`), and import the types from the module sources when you need
annotations. A typedoc API reference is planned at release time
(RELEASING.md §5); it is not wired yet.

## Compatibility

- Semantic versioning; the language-neutral contracts are the single
  authority in the consema spec repository
  (https://github.com/consema/consema).
- Cross-language consistency is enforced by the 18 suites / 519 cases
  conformance gate and the TS-Rust differential gates.
- Compatibility and support policy: RFC 0020.

## License

MIT — the LICENSE text ships inside the package.
