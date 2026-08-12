/**
 * Consema JSON family (L1, mirror of Go G1.2): lossless
 * `json.strict@1`, `jsonc.bounded@1`, and `json5.standard@1` documents
 * with native/syntax queries, projection, materialization, dialect
 * conversion, structural edits, and the frozen operation registry.
 *
 * authority and scope: docs/multi-language-implementation-plan.md §2 L1
 * (json family, mirror of Go G1.2); RFC 0003/0004/0005/0016; the shared
 * vectors conformance/vectors/json-family-v2.json + v1.json. See each
 * module header for its exact authority citations.
 */

export * from './profile.ts';
export * from './syntax.ts';
export * from './semantic.ts';
export * from './errors.ts';
export * from './document.ts';
export * from './parser.ts';
export * from './query.ts';
export * from './projection.ts';
export * from './materialization.ts';
export * from './edit.ts';
export * from './operation_registry.ts';
