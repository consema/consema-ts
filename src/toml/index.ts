/**
 * The `toml` family of the TypeScript Consema implementation (L1,
 * mirror of Go G1.3).
 *
 * authority: docs/multi-language-implementation-plan.md §2 L1 (:73);
 * RFC 0001 (the language-neutral TOML contract); the shared vector suite
 * conformance/vectors/toml-v1.json; crates/consema-toml for byte/registry
 * arbitration only.
 *
 * Modules:
 *  - errors: frozen toml-family codes and typed failures
 *  - profile: TomlProfile, capabilities, query domains, materialization
 *    style
 *  - tokenizer: lossless token/trivia pieces and syntax kinds
 *  - parser: TOML 1.0 grammar to the native entity model
 *  - document: the immutable snapshot and native accessors
 *  - query: toml.native-semantic-query@1 and toml.lossless-syntax-query@1
 *    execution
 *  - projection: explicit toml.best-exact-core@1 projection with
 *    fidelity/report/provenance
 *  - materialization: toml.canonical-document@1 canonical materialization
 *  - edit: scalar and structural edit transactions with atomic commit
 *  - operation_registry: the seven frozen TOML operation descriptors
 */

export * from './errors.ts';
export * from './profile.ts';
export * from './tokenizer.ts';
export * from './parser.ts';
export * from './document.ts';
export * from './query.ts';
export * from './projection.ts';
export * from './materialization.ts';
export * from './edit.ts';
export * from './operation_registry.ts';
