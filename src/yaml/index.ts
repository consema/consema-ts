/**
 * Consema YAML family (L2, mirror of Go G2.1): lossless
 * `yaml.1.2-core@1` and `yaml.1.1-compat@1` documents with native/syntax
 * queries, graph/value projection, canonical materialization, structural
 * edits, and the frozen operation registry.
 *
 * authority and scope: docs/multi-language-implementation-plan.md §2 L2
 * (yaml family, mirror of Go G2.1); RFC 0007 (the yaml contract),
 * RFC 0004 (materialization/edit), RFC 0016 §5.1 F10 (formation);
 * the shared vectors conformance/vectors/yaml-v1.json. See each module
 * header for its exact authority citations.
 */

export * from './profile.ts';
export * from './syntax.ts';
export * from './semantic.ts';
export * from './errors.ts';
export * from './scalar.ts';
export * from './document.ts';
export * from './parser.ts';
export * from './scanner.ts';
export * from './query.ts';
export * from './projection.ts';
export * from './materialization.ts';
export * from './edit.ts';
export * from './operation_registry.ts';
