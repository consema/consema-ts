/**
 * Consema Java Properties family (L2, mirror of Go G2.3): lossless
 * `java-properties.reader@1` and `java-properties.latin1@1` documents with
 * native/syntax queries, projection, materialization, structural edits, and
 * the frozen five-operation registry.
 *
 * authority and scope: docs/multi-language-implementation-plan.md §2 L2
 * (properties family, mirror of Go G2.3); RFC 0010 (properties profiles);
 * RFC 0004 (materialization/edit); the shared vectors
 * conformance/vectors/java-properties-v1.json. See each module header for
 * its exact authority citations.
 */

export * from './profile.ts';
export * from './syntax.ts';
export * from './java_string.ts';
export * from './parse_limits.ts';
export * from './errors.ts';
export * from './document.ts';
export * from './parser.ts';
export * from './query.ts';
export * from './projection.ts';
export * from './materialization.ts';
export * from './edit.ts';
export * from './operation_registry.ts';
