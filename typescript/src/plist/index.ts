/**
 * Consema plist family (L3, mirror of Go G3.2): lossless
 * `plist.xml@1` and `plist.binary@1` documents with native/syntax/binary
 * structure queries, projection, canonical materialization, structural
 * edits, and the frozen operation registry.
 *
 * authority and scope: docs/multi-language-implementation-plan.md §2 L3
 * (plist family, mirror of Go G3.2); RFC 0013 (the plist contract) and
 * RFC 0004 (materialization/edit); the shared vectors
 * conformance/vectors/plist-v1.json. See each module header for its
 * exact authority citations.
 */

export * from './profile.ts';
export * from './syntax.ts';
export * from './native.ts';
export * from './errors.ts';
// Both `native.ts` and `document.ts` export `PlistDocument`; the public
// name resolves to the document wrapper, and the arena document is
// re-exported under its native name (RFC 0013 §3 vs §6).
export { PlistDocument } from './document.ts';
export { PlistDocument as PlistNativeDocument } from './native.ts';
export * from './document.ts';
export * from './parser.ts';
export * from './parser_xml.ts';
export * from './parser_binary.ts';
export * from './query.ts';
export * from './projection.ts';
export * from './materialization.ts';
export * from './edit.ts';
export * from './operation_registry.ts';
