/**
 * Intent documents for Java Properties formation.
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id:
 *  - conformance/vectors/java-properties-v1.json:
 *    formation.reader-lines-escapes-duplicates (:5-9),
 *    formation.empty-blank-comment-empty-key (:11-14),
 *    formation.mixed-line-terminators (:16-19),
 *    formation.continuation-and-backslash-parity (:21-29),
 *    formation.escape-and-java-utf16-matrix (:31-34),
 *    formation.malformed-unicode-recovery-matrix (:36-39),
 *    formation.reader-explicit-encodings (:41-49),
 *    formation.latin1-byte-and-bom-content (:51-54),
 *    formation.recovery-never-publishes-partial-operation (:56-59),
 *    resource.formation-limit-matrix (:116-140)
 *  - RFC 0010 §5-§8 for the line/escape/formation rules
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PROPERTIES_PARSE_LIMITS } from '../properties/parse_limits.ts';
import { parse, parseLatin1, parseReader } from '../properties/parser.ts';
import { PROFILE_LATIN1_V1, PROFILE_READER_V1 } from '../properties/profile.ts';
import { FatalFormationFailure } from '../properties/errors.ts';
import {
  utf8Encoding,
  utf16LeEncoding,
  utf16BeEncoding,
  windowsCodePageEncoding,
  WindowsCodePage,
} from '../document/source.ts';
import type { SourceEncoding } from '../document/source.ts';

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function hex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, '0');
  }
  return output;
}

function exactCoverage(document: ReturnType<typeof parseReader>): boolean {
  const pieces = document.losslessStructuralIndex().pieces();
  if (document.source().isEmpty()) {
    return pieces.length === 0;
  }
  return (
    pieces.length === document.losslessSyntaxKinds().length &&
    pieces[0].span().startByte() === 0 &&
    pieces[pieces.length - 1].span().endByte() === document.source().len() &&
    pieces.slice(1).every((piece, index) => pieces[index].span().endByte() === piece.span().startByte())
  );
}

test('formation.reader-lines-escapes-duplicates: golden formation facts (java-properties-v1.json:5-9)', () => {
  const document = parseReader(
    bytes('  # retained comment\\\r\nkey\\ with\\ spaces : first\\\r\n \tsecond\\u0021\ndup=first\rdup:last\nempty\nexplicit='),
    utf8Encoding(),
    DEFAULT_PROPERTIES_PARSE_LIMITS,
  );
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(document.naturalLines().length, 7);
  assert.equal(document.logicalLines().length, 5);
  assert.equal(document.comments().length, 1);
  assert.equal(document.properties().length, 5);
  assert.equal(document.escapes().length, 3);
  assert.deepEqual(
    document.properties().map((property) => property.key().toUnicode()),
    ['key with spaces', 'dup', 'dup', 'empty', 'explicit'],
  );
  assert.deepEqual(
    document.properties().map((property) => property.value().toUnicode()),
    ['firstsecond!', 'first', 'last', '', ''],
  );
  assert.deepEqual(
    document.properties().map((property) => property.valueState()),
    ['Present', 'Present', 'Present', 'ImplicitEmpty', 'ExplicitEmpty'],
  );
  assert.equal(
    document.properties()[1].duplicateGroup() !== null &&
      document.properties()[1].duplicateGroup() === document.properties()[2].duplicateGroup(),
    true,
  );
  assert.equal(exactCoverage(document), true);
  // The first value spans two natural lines: fragment and escape facts.
  assert.equal(document.properties()[0].valueFragments().length, 2);
  assert.equal(document.properties()[0].escapes().length, 3);
});

test('formation.empty-blank-comment-empty-key: sample matrix (java-properties-v1.json:11-14)', () => {
  const samples = ['', '\n', '# comment\n', '! comment\r', 'implicit', 'explicit=', '=value', 'a=1\nb=2\n'];
  const formations = ['Complete', 'Complete', 'Complete', 'Complete', 'Complete', 'Complete', 'Complete', 'Complete'];
  const properties = [0, 0, 0, 0, 1, 1, 1, 2];
  const comments = [0, 0, 1, 1, 0, 0, 0, 0];
  for (let index = 0; index < samples.length; index++) {
    const document = parseReader(bytes(samples[index]), utf8Encoding(), DEFAULT_PROPERTIES_PARSE_LIMITS);
    assert.equal(document.formationStatus(), formations[index], samples[index]);
    assert.equal(document.properties().length, properties[index], samples[index]);
    assert.equal(document.comments().length, comments[index], samples[index]);
    assert.equal(exactCoverage(document), true, samples[index]);
  }
});

test('formation.mixed-line-terminators: LF/CR/CRLF/EOF (java-properties-v1.json:16-19)', () => {
  const document = parseReader(
    bytes('a=1\nb=2\rc=3\r\nd=4'),
    utf8Encoding(),
    DEFAULT_PROPERTIES_PARSE_LIMITS,
  );
  assert.equal(document.naturalLines().length, 4);
  assert.equal(document.logicalLines().length, 4);
  assert.equal(document.properties().length, 4);
  const terminators = document.naturalLines().map((line) => {
    const span = line.lineBreakSpan();
    if (span === null) {
      return 'Eof';
    }
    const slice = document.render().slice(span.startByte(), span.endByte());
    if (slice[0] === 0x0a) return 'Lf';
    if (slice[0] === 0x0d) return slice.length === 2 ? 'CrLf' : 'Cr';
    return 'Other';
  });
  assert.deepEqual(terminators, ['Lf', 'Cr', 'CrLf', 'Eof']);
  assert.equal(exactCoverage(document), true);
});

test('formation.continuation-and-backslash-parity: odd/even runs and EOF backslash (java-properties-v1.json:21-29)', () => {
  const samples: readonly { source: string; valueHex: string; naturalLines: number; logicalLines: number }[] = [
    { source: 'key=value\\', valueHex: '00760061006c00750065', naturalLines: 1, logicalLines: 1 },
    { source: 'key=value\\\\', valueHex: '00760061006c00750065005c', naturalLines: 1, logicalLines: 1 },
    { source: 'key=first\\\n  second', valueHex: '00660069007200730074007300650063006f006e0064', naturalLines: 2, logicalLines: 1 },
    { source: 'key=\\u00\\\n 41', valueHex: '0041', naturalLines: 2, logicalLines: 1 },
  ];
  for (const sample of samples) {
    const document = parseReader(bytes(sample.source), utf8Encoding(), DEFAULT_PROPERTIES_PARSE_LIMITS);
    assert.equal(document.formationStatus(), 'Complete', sample.source);
    assert.equal(document.properties()[0].value().utf16beHex(), sample.valueHex, sample.source);
    assert.equal(document.naturalLines().length, sample.naturalLines, sample.source);
    assert.equal(document.logicalLines().length, sample.logicalLines, sample.source);
    assert.equal(exactCoverage(document), true, sample.source);
  }
});

test('formation.escape-and-java-utf16-matrix: escapes and escape kinds (java-properties-v1.json:31-34)', () => {
  const document = parseReader(
    bytes('named=\\t\\n\\r\\f\nslash=\\\\\ndropped=\\q\nnonrecursive=\\u005Cu0041\npair=\\uD83D\\uDE00\nhigh=\\uD800\nlow=\\uDC00\nhigh-before=\\uD800A\nlow-after=A\\uDC00\n'),
    utf8Encoding(),
    DEFAULT_PROPERTIES_PARSE_LIMITS,
  );
  assert.deepEqual(
    document.properties().map((property) => property.value().utf16beHex()),
    ['0009000a000d000c', '005c', '0071', '005c00750030003000340031', 'd83dde00', 'd800', 'dc00', 'd8000041', '0041dc00'],
  );
  assert.deepEqual(
    document.properties().map((property) => property.value().status()),
    ['WellFormedUnicode', 'WellFormedUnicode', 'WellFormedUnicode', 'WellFormedUnicode', 'WellFormedUnicode', 'UnpairedSurrogate', 'UnpairedSurrogate', 'UnpairedSurrogate', 'UnpairedSurrogate'],
  );
  assert.deepEqual(
    document.escapes().map((escape) => escape.kind()),
    ['Named', 'Named', 'Named', 'Named', 'Backslash', 'DroppedBackslash', 'Unicode', 'Unicode', 'Unicode', 'Unicode', 'Unicode', 'Unicode', 'Unicode'],
  );
});

test('formation.malformed-unicode-recovery-matrix: Recovered with no partial property (java-properties-v1.json:36-39)', () => {
  const samples = ['a=\\u', 'a=\\u1', 'a=\\u12', 'a=\\u123', 'a=\\u12G4', 'a=\\U0041'];
  const formations = ['Recovered', 'Recovered', 'Recovered', 'Recovered', 'Recovered', 'Complete'];
  const propertyCounts = [0, 0, 0, 0, 0, 1];
  const errorCounts = [1, 1, 1, 1, 1, 0];
  for (let index = 0; index < samples.length; index++) {
    const document = parseReader(bytes(samples[index]), utf8Encoding(), DEFAULT_PROPERTIES_PARSE_LIMITS);
    assert.equal(document.formationStatus(), formations[index], samples[index]);
    assert.equal(document.properties().length, propertyCounts[index], samples[index]);
    assert.equal(document.errorLines().length, errorCounts[index], samples[index]);
    if (document.errorLines().length > 0) {
      assert.equal(document.errorLines()[0].code(), 'java-properties.parse.malformed-unicode-escape@1');
    }
  }
  // Uppercase U is not an escape: the value is the literal text "U0041".
  const uppercase = parseReader(bytes('a=\\U0041'), utf8Encoding(), DEFAULT_PROPERTIES_PARSE_LIMITS);
  assert.equal(uppercase.properties()[0].value().toUnicode(), 'U0041');
});

test('formation.reader-explicit-encodings: UTF-8, UTF-16, and code pages (java-properties-v1.json:41-49)', () => {
  const samples: readonly { encoding: SourceEncoding; hex: string; key: string; value: string; bom: string }[] = [
    { encoding: utf8Encoding(), hex: 'e5908d3de580bc0a', key: '名', value: '值', bom: 'None' },
    { encoding: utf16LeEncoding(), hex: 'fffe6b003d007600', key: 'k', value: 'v', bom: 'Some(Utf16Le)' },
    { encoding: utf16BeEncoding(), hex: 'feff006b003d0076', key: 'k', value: 'v', bom: 'Some(Utf16Be)' },
    { encoding: windowsCodePageEncoding(WindowsCodePage.fromNumber(1252)!), hex: '6e616d653d636166e90a', key: 'name', value: 'café', bom: 'None' },
  ];
  for (const sample of samples) {
    const raw = Uint8Array.from(decodeHex(sample.hex));
    const document = parseReader(raw, sample.encoding, DEFAULT_PROPERTIES_PARSE_LIMITS);
    assert.equal(document.formationStatus(), 'Complete', sample.hex);
    assert.equal(hex(document.render()), sample.hex);
    assert.equal(document.properties()[0].key().toUnicode(), sample.key);
    assert.equal(document.properties()[0].value().toUnicode(), sample.value);
    assert.equal(bomName(document.source().encodingFacts().bom()), sample.bom);
    assert.equal(exactCoverage(document), true);
  }
});

test('formation.latin1-byte-and-bom-content: BOM bytes are ordinary Latin-1 data (java-properties-v1.json:51-54)', () => {
  const document = parseLatin1(Uint8Array.from(decodeHex('efbbbf6b3dff')), DEFAULT_PROPERTIES_PARSE_LIMITS);
  assert.equal(document.properties()[0].key().utf16beHex(), '00ef00bb00bf006b');
  assert.equal(document.properties()[0].value().utf16beHex(), '00ff');
  assert.equal(document.source().encodingFacts().bom(), null);
  assert.equal(document.losslessSyntaxKinds().includes('Bom'), false);
  assert.equal(exactCoverage(document), true);
});

test('formation.recovery-never-publishes-partial-operation: Recovered is atomic (java-properties-v1.json:56-59)', () => {
  const document = parseReader(
    bytes('good=ok\nbad=\\u12G4\nafter=yes'),
    utf8Encoding(),
    DEFAULT_PROPERTIES_PARSE_LIMITS,
  );
  assert.equal(document.formationStatus(), 'Recovered');
  assert.deepEqual(
    document.properties().map((property) => property.key().toUnicode()),
    ['good', 'after'],
  );
  assert.equal(document.errorLines().length, 1);
  assert.equal(document.errorLines()[0].code(), 'java-properties.parse.malformed-unicode-escape@1');
  assert.equal(document.diagnostics()[0].code, 'java-properties.parse.malformed-unicode-escape@1');
  // A Recovered document has no partial projection or edit (RFC 0010 §8).
  assert.equal(document.losslessStructuralIndex().pieces().some((piece) => piece.kind() === 'ErrorRegion'), true);
});

test('profile and encoding selection must match (lib.rs:991-1004)', () => {
  assert.throws(
    () =>
      parse(
        bytes('k=v'),
        PROFILE_LATIN1_V1,
        { kind: 'Reader', encoding: utf8Encoding() },
        DEFAULT_PROPERTIES_PARSE_LIMITS,
      ),
    (error: unknown) => {
      assert.ok(error instanceof FatalFormationFailure);
      assert.equal(error.diagnostics()[0].code, 'java-properties.source.profile-encoding@1');
      return true;
    },
  );
  assert.throws(
    () =>
      parse(
        bytes('k=v'),
        PROFILE_READER_V1,
        { kind: 'Latin1' },
        DEFAULT_PROPERTIES_PARSE_LIMITS,
      ),
    (error: unknown) => {
      assert.ok(error instanceof FatalFormationFailure);
      assert.equal(error.diagnostics()[0].code, 'java-properties.source.profile-encoding@1');
      return true;
    },
  );
});

test('resource.formation-limit-matrix: every limit is fatal with no partial document (java-properties-v1.json:116-140)', () => {
  const limits: readonly { name: string; source: string; value: number }[] = [
    { name: 'max_source_bytes', source: 'a=1\n', value: 2 },
    { name: 'max_token_count', source: 'a=1\n', value: 1 },
    { name: 'max_node_count', source: 'a=1\n', value: 1 },
    { name: 'max_diagnostics', source: 'a=\\u\nb=\\u\n', value: 0 },
    { name: 'max_decoded_utf8_bytes', source: 'a=1\n', value: 1 },
    { name: 'max_decoded_scalars', source: 'a=1\n', value: 1 },
    { name: 'max_natural_lines', source: 'a=1\nb=2\n', value: 1 },
    { name: 'max_natural_line_bytes', source: 'long=value\n', value: 3 },
    { name: 'max_natural_line_scalars', source: 'long=value\n', value: 3 },
    { name: 'max_logical_lines', source: 'a=1\nb=2\n', value: 1 },
    { name: 'max_logical_line_natural_lines', source: 'a=one\\\n two\n', value: 1 },
    { name: 'max_logical_line_scalars', source: 'a=one\\\n two\n', value: 3 },
    { name: 'max_properties', source: 'a=1\nb=2\n', value: 1 },
    { name: 'max_comments', source: '# a\n# b\n', value: 1 },
    { name: 'max_escapes', source: 'a=\\t\\n\n', value: 1 },
    { name: 'max_unicode_escapes', source: 'a=\\u0041\\u0042\n', value: 1 },
    { name: 'max_java_code_units_per_string', source: 'long=value\n', value: 3 },
    { name: 'max_total_java_code_units', source: 'a=1\nb=2\n', value: 3 },
    { name: 'max_duplicate_group_members', source: 'a=1\na=2\n', value: 1 },
    { name: 'max_recovery_regions', source: 'a=\\u\nb=\\u\n', value: 1 },
  ];
  let fatal = 0;
  for (const descriptor of limits) {
    const bounded = { ...DEFAULT_PROPERTIES_PARSE_LIMITS };
    const common = { ...bounded.common };
    applyLimit(bounded, common, descriptor.name, descriptor.value);
    let failed = false;
    try {
      parseReader(bytes(descriptor.source), utf8Encoding(), bounded);
    } catch (error) {
      assert.ok(error instanceof FatalFormationFailure, `${descriptor.name}: ${String(error)}`);
      failed = true;
    }
    if (failed) {
      fatal += 1;
    }
  }
  assert.equal(fatal, 20);
});

function applyLimit(
  limits: { [key: string]: unknown },
  common: { [key: string]: unknown },
  name: string,
  value: number,
): void {
  switch (name) {
    case 'max_source_bytes':
      common.maxSourceBytes = value;
      limits.common = common;
      break;
    case 'max_token_count':
      common.maxTokenCount = value;
      limits.common = common;
      break;
    case 'max_node_count':
      common.maxNodeCount = value;
      limits.common = common;
      break;
    case 'max_diagnostics':
      common.maxDiagnostics = value;
      limits.common = common;
      break;
    case 'max_decoded_utf8_bytes':
      limits.maxDecodedUtf8Bytes = value;
      break;
    case 'max_decoded_scalars':
      limits.maxDecodedScalars = value;
      break;
    case 'max_natural_lines':
      limits.maxNaturalLines = value;
      break;
    case 'max_natural_line_bytes':
      limits.maxNaturalLineBytes = value;
      break;
    case 'max_natural_line_scalars':
      limits.maxNaturalLineScalars = value;
      break;
    case 'max_logical_lines':
      limits.maxLogicalLines = value;
      break;
    case 'max_logical_line_natural_lines':
      limits.maxLogicalLineNaturalLines = value;
      break;
    case 'max_logical_line_scalars':
      limits.maxLogicalLineScalars = value;
      break;
    case 'max_properties':
      limits.maxProperties = value;
      break;
    case 'max_comments':
      limits.maxComments = value;
      break;
    case 'max_escapes':
      limits.maxEscapes = value;
      break;
    case 'max_unicode_escapes':
      limits.maxUnicodeEscapes = value;
      break;
    case 'max_java_code_units_per_string':
      limits.maxJavaCodeUnitsPerString = value;
      break;
    case 'max_total_java_code_units':
      limits.maxTotalJavaCodeUnits = value;
      break;
    case 'max_duplicate_group_members':
      limits.maxDuplicateGroupMembers = value;
      break;
    case 'max_recovery_regions':
      limits.maxRecoveryRegions = value;
      break;
    default:
      throw new Error(`unknown limit ${name}`);
  }
}

function bomName(bom: string | null): string {
  return bom === null ? 'None' : `Some(${bom})`;
}

function decodeHex(value: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 2) {
    bytes.push(Number.parseInt(value.slice(index, index + 2), 16));
  }
  return bytes;
}
