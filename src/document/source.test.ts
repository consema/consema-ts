/**
 * Intent documents for the raw-source surface, transcribed from the
 * language-neutral vector suite `consema.source.conformance@1`
 * (conformance/vectors/source-v1.json). Every case below cites the case id
 * it transcribes; the runner authority is
 * crates/consema-conformance/src/source_v1.rs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SourceSnapshot, EncodingRequest, WindowsCodePage, encodingAsStr } from './source.ts';
import {
  binaryEncoding,
  latin1Encoding,
  utf8Encoding,
  utf16LeEncoding,
  utf16BeEncoding,
  windowsCodePageEncoding,
} from './source.ts';
import { ContentDigest } from './sha256.ts';
import { DEFAULT_SOURCE_LIMITS } from './source.ts';
import {
  LocationError,
  SourceError,
  codeSourceEncodingConflict,
  codeSourceInvalidSequence,
  codeSourceResourceLimit,
  codeSourceUnsupportedBom,
} from './errors.ts';
import { DocumentAuthority } from './identity.ts';
import { BinaryRegion, BinaryStructuralIndex } from './structural.ts';
import { decodeHex, encodeHex } from './hex.ts';

function source(bytesHex: string, encoding: 'binary' | 'utf-8' | 'utf-16le' | 'utf-16be' | 'latin-1'): SourceSnapshot {
  const request = EncodingRequest.create(parseEncoding(encoding));
  return SourceSnapshot.fromRaw(decodeHex(bytesHex), request, DEFAULT_SOURCE_LIMITS);
}

function parseEncoding(encoding: string) {
  switch (encoding) {
    case 'binary':
      return binaryEncoding();
    case 'utf-8':
      return utf8Encoding();
    case 'utf-16le':
      return utf16LeEncoding();
    case 'utf-16be':
      return utf16BeEncoding();
    case 'latin-1':
      return latin1Encoding();
    default:
      throw new RangeError(`unknown encoding ${encoding}`);
  }
}

// ---------------------------------------------------------------------------
// Golden digests — vector cases source.digest.sha256-empty /
// source.digest.sha256-abc (source-v1.json:6-16)
// ---------------------------------------------------------------------------

test('source.digest.sha256-empty: SHA-256 of empty raw bytes is the frozen digest', () => {
  const digest = ContentDigest.of(new Uint8Array(0));
  assert.equal(digest.algorithm(), 'sha256');
  assert.equal(digest.toHex(), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(digest.bytes().length, 32);
});

test('source.digest.sha256-abc: SHA-256 of "abc" is the frozen digest', () => {
  const digest = ContentDigest.of(decodeHex('616263'));
  assert.equal(digest.toHex(), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// ---------------------------------------------------------------------------
// Encoding round-trips — vector cases source.encoding.*-roundtrip
// (source-v1.json:24-52): raw bytes are retained byte-exactly, the frozen
// priority rule selects the encoding, and the decoded text matches.
// ---------------------------------------------------------------------------

test('source.encoding.utf8-roundtrip: raw bytes retained, BOM kept as decoded U+FEFF', () => {
  const snapshot = source('efbbbf41f09f9880', 'utf-8');
  assert.equal(encodeHex(snapshot.bytes()), 'efbbbf41f09f9880');
  assert.equal(encodingAsStr(snapshot.encodingFacts().selected()), 'utf-8');
  assert.equal(encodeHex(new TextEncoder().encode(snapshot.decodedText()!)), 'efbbbf41f09f9880');
  assert.equal(snapshot.encodingFacts().bom(), 'Utf8');
});

test('source.encoding.utf16le-roundtrip: UTF-16LE decodes to the UTF-8 view', () => {
  const snapshot = source('fffe41003dd800de', 'utf-16le');
  assert.equal(encodeHex(snapshot.bytes()), 'fffe41003dd800de');
  assert.equal(encodingAsStr(snapshot.encodingFacts().selected()), 'utf-16le');
  assert.equal(encodeHex(new TextEncoder().encode(snapshot.decodedText()!)), 'efbbbf41f09f9880');
});

test('source.encoding.utf16be-roundtrip: UTF-16BE decodes to the UTF-8 view', () => {
  const snapshot = source('feff0041d83dde00', 'utf-16be');
  assert.equal(encodeHex(snapshot.bytes()), 'feff0041d83dde00');
  assert.equal(encodingAsStr(snapshot.encodingFacts().selected()), 'utf-16be');
  assert.equal(encodeHex(new TextEncoder().encode(snapshot.decodedText()!)), 'efbbbf41f09f9880');
});

test('source.encoding.latin1-roundtrip: Latin-1 is ISO-8859-1, not Windows-1252', () => {
  const snapshot = source('41e9ff', 'latin-1');
  assert.equal(encodeHex(snapshot.bytes()), '41e9ff');
  assert.equal(encodingAsStr(snapshot.encodingFacts().selected()), 'latin-1');
  assert.equal(encodeHex(new TextEncoder().encode(snapshot.decodedText()!)), '41c3a9c3bf');
});

test('source.encoding.binary-roundtrip: binary has no decoded text', () => {
  const snapshot = source('fffe0000', 'binary');
  assert.equal(encodeHex(snapshot.bytes()), 'fffe0000');
  assert.equal(encodingAsStr(snapshot.encodingFacts().selected()), 'binary');
  assert.equal(snapshot.decodedText(), null);
});

// ---------------------------------------------------------------------------
// Conflict and rejection cases — vector cases source.encoding.*-conflict /
// reject-* (source-v1.json:54-82)
// ---------------------------------------------------------------------------

test('source.encoding.bom-declaration-conflict: BOM and declaration disagree', () => {
  const request = EncodingRequest.create(utf8Encoding()).withDeclaration(utf16LeEncoding());
  assert.throws(
    () => SourceSnapshot.fromRaw(decodeHex('efbbbf41'), request, DEFAULT_SOURCE_LIMITS),
    (error: unknown) => {
      assert.ok(error instanceof SourceError);
      assert.equal(error.kind, 'EncodingConflict');
      assert.equal(error.code, codeSourceEncodingConflict);
      assert.equal(error.bom, 'utf-8');
      assert.equal(error.declaration, 'utf-16le');
      return true;
    },
  );
});

test('source.encoding.declaration-caller-conflict: declaration and caller override disagree', () => {
  const request = EncodingRequest.create(utf8Encoding())
    .withDeclaration(utf8Encoding())
    .withCallerOverride(latin1Encoding());
  assert.throws(
    () => SourceSnapshot.fromRaw(decodeHex('41'), request, DEFAULT_SOURCE_LIMITS),
    (error: unknown) => error instanceof SourceError && error.code === codeSourceEncodingConflict,
  );
});

test('source.encoding.reject-utf32-bom: UTF-32 markers are recognized but unsupported', () => {
  assert.throws(
    () => source('fffe0000', 'utf-8'),
    (error: unknown) => {
      assert.ok(error instanceof SourceError);
      assert.equal(error.kind, 'UnsupportedBom');
      assert.equal(error.code, codeSourceUnsupportedBom);
      assert.equal(error.unsupportedBom, 'Utf32Le');
      return true;
    },
  );
  assert.throws(
    () => source('0000feff', 'utf-8'),
    (error: unknown) => error instanceof SourceError && error.unsupportedBom === 'Utf32Be',
  );
});

test('source.encoding.reject-utf16-odd: odd-length UTF-16 is an invalid sequence', () => {
  assert.throws(
    () => source('4100ff', 'utf-16le'),
    (error: unknown) => {
      assert.ok(error instanceof SourceError);
      assert.equal(error.kind, 'InvalidSequence');
      assert.equal(error.code, codeSourceInvalidSequence);
      assert.equal(error.byteOffset, 2); // bytes.length - 1
      return true;
    },
  );
});

test('source.encoding.reject-utf16-surrogate: isolated high surrogate is an invalid sequence', () => {
  assert.throws(
    () => source('3dd84100', 'utf-16le'),
    (error: unknown) => {
      assert.ok(error instanceof SourceError);
      assert.equal(error.kind, 'InvalidSequence');
      assert.equal(error.code, codeSourceInvalidSequence);
      assert.equal(error.byteOffset, 0);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Decoded locations — vector cases source.location.* (source-v1.json:84-100)
// ---------------------------------------------------------------------------

test('source.location.utf8-boundaries: raw/scalar/UTF-16 coordinates at exact boundaries', () => {
  const snapshot = source('41f09f988042', 'utf-8');
  const position = snapshot.decodedPosition(5);
  assert.equal(position.decodedUtf8Byte, 5);
  assert.equal(position.unicodeScalarOffset, 2);
  assert.equal(position.utf16CodeUnitOffset, 3);
  // Reverse conversions return the same raw byte.
  assert.equal(snapshot.rawByteAt({ kind: 'Utf8Byte', value: 5 }), 5);
  assert.equal(snapshot.rawByteAt({ kind: 'UnicodeScalar', value: 2 }), 5);
  assert.equal(snapshot.rawByteAt({ kind: 'Utf16CodeUnit', value: 3 }), 5);
  // Offsets inside a scalar are rejected, never rounded.
  assert.throws(
    () => snapshot.decodedPosition(2),
    (error: unknown) => error instanceof LocationError && error.name === 'NotDecodedBoundary',
  );
  assert.throws(
    () => snapshot.rawByteAt({ kind: 'Utf16CodeUnit', value: 2 }),
    (error: unknown) => error instanceof LocationError && error.name === 'DecodedOffsetNotBoundary',
  );
});

test('source.location.utf16-boundaries: surrogate pairs count as two UTF-16 units', () => {
  const snapshot = source('41003dd800de4200', 'utf-16le');
  const position = snapshot.decodedPosition(6);
  assert.equal(position.decodedUtf8Byte, 5);
  assert.equal(position.unicodeScalarOffset, 2);
  assert.equal(position.utf16CodeUnitOffset, 3);
  assert.throws(
    () => snapshot.decodedPosition(4),
    (error: unknown) => error instanceof LocationError && error.name === 'NotDecodedBoundary',
  );
  assert.equal(snapshot.rawByteAt({ kind: 'Utf16CodeUnit', value: 3 }), 6);
});

test('source.location.binary-no-text: binary sources have no decoded coordinates', () => {
  const snapshot = source('00ff', 'binary');
  assert.throws(
    () => snapshot.decodedPosition(0),
    (error: unknown) => error instanceof LocationError && error.name === 'NoDecodedText',
  );
});

// ---------------------------------------------------------------------------
// Binary structural coverage — vector cases source.binary.*
// (source-v1.json:102-118)
// ---------------------------------------------------------------------------

test('source.binary.empty-coverage: empty source has an empty valid index', () => {
  const authority = DocumentAuthority.fresh();
  const index = BinaryStructuralIndex.create(authority.identity(), 0, []);
  assert.equal(index.regions().length, 0);
});

test('source.binary.region-coverage: ordered regions cover every byte once', () => {
  const authority = DocumentAuthority.fresh();
  const regions = [
    new BinaryRegion(authority.nodeRef(0n, 'BinaryRegion'), authority.span(0, 1), 'header'),
    new BinaryRegion(authority.nodeRef(1n, 'BinaryRegion'), authority.span(1, 4), 'payload'),
  ];
  const index = BinaryStructuralIndex.create(authority.identity(), 4, regions);
  assert.equal(index.regions().length, 2);
  assert.equal(index.regions()[1].span().endByte(), 4);
  assert.equal(index.regions()[0].nodeRef().role(), 'BinaryRegion');
});

test('source.binary.reject-gap: a gap in coverage is IncompleteStructuralCoverage', () => {
  const authority = DocumentAuthority.fresh();
  const regions = [
    new BinaryRegion(authority.nodeRef(0n, 'BinaryRegion'), authority.span(0, 1), 'header'),
    new BinaryRegion(authority.nodeRef(1n, 'BinaryRegion'), authority.span(2, 4), 'payload'),
  ];
  assert.throws(
    () => BinaryStructuralIndex.create(authority.identity(), 4, regions),
    (error: unknown) => error instanceof LocationError && error.name === 'IncompleteStructuralCoverage',
  );
});

test('binary regions reject wrong roles, empty kinds, and duplicate identities', () => {
  const authority = DocumentAuthority.fresh();
  const wrongRole = new BinaryRegion(authority.nodeRef(0n, 'Token'), authority.span(0, 1), 'x');
  assert.throws(
    () => BinaryStructuralIndex.create(authority.identity(), 1, [wrongRole]),
    (error: unknown) => error instanceof LocationError && error.name === 'WrongRole',
  );
  const emptyKind = new BinaryRegion(authority.nodeRef(0n, 'BinaryRegion'), authority.span(0, 1), '');
  assert.throws(
    () => BinaryStructuralIndex.create(authority.identity(), 1, [emptyKind]),
    (error: unknown) => error instanceof LocationError && error.name === 'InvalidBinaryRegionKind',
  );
  const duplicate = [
    new BinaryRegion(authority.nodeRef(0n, 'BinaryRegion'), authority.span(0, 1), 'a'),
    new BinaryRegion(authority.nodeRef(0n, 'BinaryRegion'), authority.span(1, 2), 'b'),
  ];
  assert.throws(
    () => BinaryStructuralIndex.create(authority.identity(), 2, duplicate),
    (error: unknown) => error instanceof LocationError && error.name === 'DuplicateStructuralIdentity',
  );
});

// ---------------------------------------------------------------------------
// Resource limits — vector cases source.resource.* (source-v1.json:156-166)
// ---------------------------------------------------------------------------

test('source.resource.raw-limit: raw bytes over the limit fail before decoding', () => {
  const limits = { ...DEFAULT_SOURCE_LIMITS, maxRawBytes: 1 };
  assert.throws(
    () => SourceSnapshot.fromRaw(decodeHex('6162'), EncodingRequest.create(utf8Encoding()), limits),
    (error: unknown) => {
      assert.ok(error instanceof SourceError);
      assert.equal(error.code, codeSourceResourceLimit);
      assert.equal(error.limitName, 'raw-bytes');
      assert.equal(error.observed, 2);
      assert.equal(error.limit, 1);
      return true;
    },
  );
});

test('source.resource.decoded-limit: decoded UTF-8 bytes over the limit fail', () => {
  const limits = { ...DEFAULT_SOURCE_LIMITS, maxDecodedUtf8Bytes: 1 };
  assert.throws(
    () => SourceSnapshot.fromRaw(decodeHex('e9'), EncodingRequest.create(latin1Encoding()), limits),
    (error: unknown) => {
      assert.ok(error instanceof SourceError);
      assert.equal(error.code, codeSourceResourceLimit);
      assert.equal(error.limitName, 'decoded-utf8-bytes');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Identity — vector case source.identity.equal-bytes-distinct-snapshots
// (source-v1.json:18-22): equal raw bytes produce equal digests but
// distinct snapshot identities (RFC 0003 §3).
// ---------------------------------------------------------------------------

test('source.identity.equal-bytes-distinct-snapshots: equal digests, distinct snapshots', () => {
  const first = source('5b5d', 'utf-8');
  const second = source('5b5d', 'utf-8');
  assert.equal(first.digest().toHex(), second.digest().toHex());
  const authorityFirst = DocumentAuthority.fresh();
  const authoritySecond = DocumentAuthority.fresh();
  assert.notEqual(authorityFirst.identity().asBigInt(), authoritySecond.identity().asBigInt());
});

// ---------------------------------------------------------------------------
// Windows code pages (source contract v2 surface; not exercised by the
// shared vectors — go/document/wcp_authority_test.go is the Go authority
// test, validated against encoding_rs 0.8.35)
// ---------------------------------------------------------------------------

test('source v2 publishes only the frozen Windows code pages', () => {
  const published = [874, 932, 936, 949, 950, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258, 65001];
  for (const number of published) {
    const page = WindowsCodePage.fromNumber(number);
    assert.ok(page !== null, `code page ${number} must be published`);
    assert.equal(page!.number(), number);
    assert.equal(page!.name(), `windows-${number}`);
  }
  for (const number of [0, 873, 875, 931, 951, 1249, 1259, 65000, 65535]) {
    assert.equal(WindowsCodePage.fromNumber(number), null, `code page ${number} must be unpublished`);
  }
});

test('cp1252 decodes 0x80 as U+20AC and rejects the malformed sentinel', () => {
  const page = windowsCodePageEncoding(WindowsCodePage.fromNumber(1252)!);
  const snapshot = SourceSnapshot.fromRaw(
    decodeHex('80' + '41'),
    EncodingRequest.create(page),
    DEFAULT_SOURCE_LIMITS,
  );
  assert.equal(snapshot.decodedText(), '€A');
  const position = snapshot.decodedPosition(1);
  assert.equal(position.decodedUtf8Byte, 3);
  assert.equal(position.unicodeScalarOffset, 1);
  // cp1253 0xAA is the malformed sentinel in encoding_rs 0.8.35.
  const malformed = windowsCodePageEncoding(WindowsCodePage.fromNumber(1253)!);
  assert.throws(
    () => SourceSnapshot.fromRaw(decodeHex('aa'), EncodingRequest.create(malformed), DEFAULT_SOURCE_LIMITS),
    (error: unknown) => {
      assert.ok(error instanceof SourceError);
      assert.equal(error.kind, 'InvalidSequence');
      assert.equal(error.byteOffset, 0);
      return true;
    },
  );
});

test('cp65001 decodes as strict UTF-8', () => {
  const page = windowsCodePageEncoding(WindowsCodePage.fromNumber(65001)!);
  const snapshot = SourceSnapshot.fromRaw(
    decodeHex('f09f9880'),
    EncodingRequest.create(page).withBomPolicy('TreatAsContent'),
    DEFAULT_SOURCE_LIMITS,
  );
  assert.equal(snapshot.decodedText(), '\u{1f600}');
  assert.equal(encodingAsStr(snapshot.encodingFacts().selected()), 'windows-65001');
});

test('cp1252 C1 control positions decode to their U+00xx scalars', () => {
  // Intent: a code-page source decodes under the code page, never under a
  // Unicode encoding, so arbitrary byte values are content or malformed
  // sentinels — never re-interpreted. cp1252 0x81 maps to U+0081 (C1
  // control, go/document/cp1252_table.go:15) and stays one scalar.
  const page = windowsCodePageEncoding(WindowsCodePage.fromNumber(1252)!);
  const snapshot = SourceSnapshot.fromRaw(
    decodeHex('81'),
    EncodingRequest.create(page).withBomPolicy('TreatAsContent'),
    DEFAULT_SOURCE_LIMITS,
  );
  assert.equal(snapshot.decodedText(), '\u0081');
});
