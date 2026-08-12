/**
 * The `hcl` family of the TypeScript Consema implementation (L3, mirror of
 * Go G4.1).
 *
 * authority: docs/multi-language-implementation-plan.md §2 L3 (:75);
 * RFC 0014 (the language-neutral HCL contract — native/tfvars profiles,
 * formation, query, projection, materialization, edit); RFC 0004
 * (materialization and structural-edit contracts); the shared vector suite
 * conformance/vectors/hcl-v1.json; crates/consema-hcl for byte/registry
 * arbitration only; go/hcl only as cross-reference.
 *
 * Modules:
 *  - limits: the frozen HclParseLimits (RFC 0014 §11)
 *  - errors: frozen hcl-family codes and typed failures
 *  - profile: HclProfile, capabilities, query domains, materialization
 *    style
 *  - tokenizer: the self-owned lexer, the frozen 30-kind lossless piece
 *    assembly, and the `hcl.parse.*@1` lexical recovery
 *  - expression: the closed expression AST, canonical decimal,
 *    literal-completeness, structural equality, and the fingerprint
 *  - parser: the body/expression grammar with deterministic recovery
 *  - document: formation, the immutable snapshot, and native handles
 *  - query: hcl.native-semantic-query@1 and hcl.lossless-syntax-query@1
 *  - projection: hcl.projection.body@1 with the ProjectExpression policy
 *  - materialization: hcl.canonical-document@1 with reparse closure
 *  - edit: the six snapshot-bound structural operations with atomic commit
 *  - operation_registry: the frozen per-profile operation descriptors
 *
 * HCL is never evaluated: parse, query, projection, materialization, and
 * edit carry syntax facts only (RFC 0014 §1, hard gate 1; SECURITY.md:36).
 */

export * from './limits.ts';
export * from './errors.ts';
export * from './profile.ts';
export * from './tokenizer.ts';
export * from './expression.ts';
export * from './parser.ts';
export * from './document.ts';
export * from './query.ts';
export * from './projection.ts';
export * from './materialization.ts';
export * from './edit.ts';
export * from './operation_registry.ts';
