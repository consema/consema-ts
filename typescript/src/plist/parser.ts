/**
 * Plist formation entry: profile dispatch over the two representations.
 *
 * authority: crates/consema-plist/src/lib.rs:207-300
 *  - `parse` :214-221 dispatches by profile; the profile is selected by
 *    the caller before formation — the `bplist00` magic number never
 *    selects semantics (RFC 0013 §1)
 *  - encoding selections inconsistent with the profile are source-contract
 *    conflicts: `plist.binary.encoding@1` :251 and `plist.xml.encoding@1`
 *    :291 (RFC 0013 §2)
 *
 * Design (TypeScript-idiomatic): one dispatch function over the closed
 * profile union; the source snapshot is constructed here with the frozen
 * RFC 0013 §2 source contract (bounded SourceSnapshot, BOM detection for
 * the XML profile, opaque binary snapshot for the binary profile).
 */

import { SourceSnapshot, EncodingRequest, utf8Encoding, binaryEncoding } from '../document/source.ts';
import { diagnostic } from '../document/diagnostic.ts';
import { FatalFormationFailure } from './errors.ts';
import { PlistDocument } from './document.ts';
import { DEFAULT_PLIST_PARSE_LIMITS } from './profile.ts';
import type { PlistEncodingSelection, PlistParseLimits, PlistProfile } from './profile.ts';
import { parseXml } from './parser_xml.ts';
import { parseBinary } from './parser_binary.ts';

/** Source limits for plist formation (RFC 0013 §2, §12). */
function sourceLimits(limits: PlistParseLimits) {
  return {
    maxRawBytes: limits.common.maxSourceBytes,
    maxDecodedUtf8Bytes: limits.maxDecodedUtf8Bytes,
    maxDecodedScalars: limits.maxDecodedScalars,
  };
}

/** Validates the encoding selection against the frozen source contract (RFC 0013 §2.1). */
function xmlSource(bytes: Uint8Array, selection: PlistEncodingSelection, limits: PlistParseLimits): SourceSnapshot {
  let request = EncodingRequest.create(utf8Encoding());
  switch (selection.kind) {
    case 'ProfileDefault':
      break;
    case 'Explicit':
      // The admitted document-entity encodings are UTF-8, UTF-16LE, and
      // UTF-16BE (RFC 0013 §2.1).
      if (selection.encoding.kind !== 'Utf8' && selection.encoding.kind !== 'Utf16Le' && selection.encoding.kind !== 'Utf16Be') {
        throw FatalFormationFailure.fromDiagnostic(
          diagnostic('plist.xml.encoding@1', 'Encoding', 'Error', null, 0n),
        );
      }
      request = request.withCallerOverride(selection.encoding);
      break;
  }
  return SourceSnapshot.fromRaw(bytes, request, sourceLimits(limits));
}

/** Validates the encoding selection against the binary source contract (RFC 0013 §2.2). */
function binarySource(bytes: Uint8Array, selection: PlistEncodingSelection, limits: PlistParseLimits): SourceSnapshot {
  switch (selection.kind) {
    case 'ProfileDefault':
      break;
    case 'Explicit':
      if (selection.encoding.kind !== 'Binary') {
        throw FatalFormationFailure.fromDiagnostic(
          diagnostic('plist.binary.encoding@1', 'Encoding', 'Error', null, 0n),
        );
      }
      break;
  }
  return SourceSnapshot.fromRaw(bytes, EncodingRequest.create(binaryEncoding()), sourceLimits(limits));
}

/**
 * Forms one `plist.xml@1` or `plist.binary@1` document from raw bytes
 * (RFC 0013 §1, §3). The profile selects the representation; the encoding
 * selection follows the RFC 0013 §2 source contract.
 */
export function parse(
  bytes: Uint8Array,
  profile: PlistProfile,
  selection: PlistEncodingSelection,
  limits: PlistParseLimits,
): PlistDocument {
  switch (profile) {
    case 'XmlV1':
      return parseXml(xmlSource(bytes, selection, limits), limits);
    case 'BinaryV1':
      return parseBinary(binarySource(bytes, selection, limits), limits);
  }
}

/** Convenience: forms one document under the frozen default limits and selection. */
export function parseDefault(bytes: Uint8Array, profile: PlistProfile): PlistDocument {
  return parse(bytes, profile, { kind: 'ProfileDefault' }, DEFAULT_PLIST_PARSE_LIMITS);
}
