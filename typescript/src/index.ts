/**
 * @consema/consema — the TypeScript implementation of the language-neutral
 * Consema contracts (RFC 0016; docs/multi-language-implementation-plan.md).
 *
 * Zero third-party runtime dependencies. Domain layout mirrors the Go
 * implementation's package domains:
 *  - core: the closed fifteen-kind PortableValue model, strict
 *    equality/hash, and the PVCE/1 codec
 *  - graph: PortableGraph and the PGCE/1 codec
 *  - protocol: the contract/error registries, canonical tagged JSON
 *    transport, diagnostics, registry descriptors, query validation,
 *    exit classes, and the CLI machine records
 *
 * Both the core and graph domains export `equal`/`hash` (value-level and
 * graph-level strict equality); the aliases below disambiguate them at the
 * package root.
 */

export * from './core/value.ts';
export * from './core/errors.ts';
export * from './core/pvce.ts';
export { fnv1a64, FNV64_OFFSET_BASIS, FNV64_PRIME, equal as coreEqual, hash as coreHash } from './core/equal.ts';

export * from './graph/errors.ts';
export * from './graph/graph.ts';
export * from './graph/pgce.ts';
export { equal as graphEqual, hash as graphHash } from './graph/equal.ts';

export * from './protocol/errors.ts';
export * from './protocol/limits.ts';
export * from './protocol/registry_types.ts';
export * from './protocol/contract.ts';
export * from './protocol/error_registry.ts';
export * from './protocol/canonical.ts';
export * from './protocol/records.ts';
export * from './protocol/string_map.ts';
export * from './protocol/diagnostic.ts';
export * from './protocol/registry_descriptor.ts';
export * from './protocol/query.ts';
export * from './protocol/exit_class.ts';
export * from './protocol/cli.ts';

// L4 root facade: the unified format-surface registry, the common opaque
// document union, and the two-stage projection→materialization conversions
// (mirror of crates/consema root + go/ root; RFC 0015 §6.2; RFC 0004).
export * from './registry.ts';
export * from './convert.ts';
