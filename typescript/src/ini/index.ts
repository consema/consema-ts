/**
 * The `ini` family of the TypeScript Consema implementation (L2,
 * mirror of Go G2.2).
 *
 * authority: docs/multi-language-implementation-plan.md §2 L2 (:74);
 * RFC 0009 (the language-neutral INI family contract — three profiles);
 * the shared vector suite conformance/vectors/ini-v1.json;
 * crates/consema-ini for byte/registry arbitration only.
 *
 * Modules:
 *  - errors: frozen ini-family codes and typed failures
 *  - profile: IniProfile (Portable/Windows/Python ConfigParser),
 *    encoding selection, parse limits, syntax kinds, capabilities,
 *    query domains, materialization styles
 *  - python_case: pinned Python 3.14 / Unicode 16.0 optionxform
 *  - parser: scanner and formation parser to the lossless native model
 *  - document: the immutable snapshot and native accessors
 *  - query: ini.native-semantic-query@1 and ini.lossless-syntax-query@1
 *    execution
 *  - projection: ini.projection.best-exact-entry-mapping@1 and explicit
 *    RequireObject collapse with fidelity/report/provenance
 *  - materialization: the three canonical styles
 *  - edit: value replacement and structural edit transactions with
 *    atomic commit
 *  - operation_registry: the eight frozen INI operation descriptors
 */

export * from './errors.ts';
export * from './profile.ts';
export * from './python_case.ts';
export * from './parser.ts';
export * from './document.ts';
export * from './query.ts';
export * from './projection.ts';
export * from './materialization.ts';
export * from './edit.ts';
export * from './operation_registry.ts';
