/**
 * Consema XML family (L3, mirror of Go G3.1): lossless
 * `xml.1.0-safe@1` documents with native/syntax queries, projection,
 * materialization, structural edits, and the frozen operation registry.
 *
 * authority and scope: docs/multi-language-implementation-plan.md §2 L3
 * (xml family, mirror of Go G3.1); RFC 0012 (XML 1.0 safe Profile v1);
 * RFC 0004 (materialization/edit); the shared vectors
 * conformance/vectors/xml-1-0-safe-v1.json. See each module header for
 * its exact authority citations.
 */

export * from './profile.ts';
export * from './syntax.ts';
export * from './namespace.ts';
export * from './entity.ts';
export * from './errors.ts';
export * from './document.ts';
export * from './parser.ts';
export * from './query.ts';
export * from './projection.ts';
export * from './materialization.ts';
export * from './edit.ts';
export * from './operation_registry.ts';
