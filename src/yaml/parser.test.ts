/**
 * YAML formation tests — golden transcriptions from the shared vectors.
 *
 * authority: conformance/vectors/yaml-v1.json (each test cites its case id);
 * RFC 0007 §3-§8; crates/consema-yaml/src/lib.rs parse :259-320.
 *
 * These tests are intent documents: they transcribe the vector inputs and
 * expected facts byte-for-byte so the blind-written parser can be verified
 * against the frozen contract once the toolchain is ready.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parse } from './parser.ts';
import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import { FatalFormationFailure } from './errors.ts';
import { textToBytes, utf16LeBytes } from './test_helpers.ts';
import { PROFILE_YAML12_CORE, PROFILE_YAML11_COMPAT } from './profile.ts';

function core(source: string) {
  return parse(textToBytes(source), PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
}

test('profile.yaml12-scalars — 1.2 core resolution table (yaml-v1.json:4-9)', () => {
  const document = core('[yes, 017, 0o17, 1:02:03, 2001-12-15]\n');
  const root = document.document(0)!.root();
  assert.equal(root.kind(), 'Sequence');
  const expected: [string, string][] = [
    ['String', 'yes'],
    ['Integer', '17'],
    ['Integer', '15'],
    ['String', '1:02:03'],
    ['String', '2001-12-15'],
  ];
  expected.forEach(([kind, canonical], ordinal) => {
    const scalar = root.sequenceItem(ordinal)!.node().scalar()!;
    assert.equal(scalar.kind(), kind, `element ${ordinal} kind`);
    assert.equal(scalar.canonical(), canonical, `element ${ordinal} canonical`);
  });
});

test('profile.yaml11-scalars — 1.1 compat resolution table (yaml-v1.json:10-14)', () => {
  const document = parse(
    textToBytes('%YAML 1.1\n---\n[yes, 017, 0o17, 1:02:03, 2001-12-15]\n'),
    PROFILE_YAML11_COMPAT,
    DEFAULT_PARSE_LIMITS,
  );
  const root = document.document(0)!.root();
  const expected: [string, string][] = [
    ['Boolean', 'true'],
    ['Integer', '15'],
    ['String', '0o17'],
    ['Integer', '3723'],
    ['Timestamp', '2001-12-15'],
  ];
  expected.forEach(([kind, canonical], ordinal) => {
    const scalar = root.sequenceItem(ordinal)!.node().scalar()!;
    assert.equal(scalar.kind(), kind, `element ${ordinal} kind`);
    assert.equal(scalar.canonical(), canonical, `element ${ordinal} canonical`);
  });
});

test('source.utf16le-bom — UTF-16LE BOM detection (yaml-v1.json:16-19)', () => {
  const bytes = utf16LeBytes('a: 1\n');
  const document = parse(bytes, PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
  assert.equal(document.source().encodingFacts().selected().kind, 'Utf16Le');
  assert.equal(document.documentCount(), 1);
  // Unmodified rendering returns the original raw bytes including the BOM
  // (RFC 0007 §3:66-71).
  assert.deepEqual([...document.render()], [...bytes]);
});

test('stream.empty — no documents, no aliases (yaml-v1.json:21-24)', () => {
  const document = core('');
  assert.equal(document.documentCount(), 0);
  assert.equal(document.aliasCount(), 0);
});

test('stream.multi-document — anchors reset per document (yaml-v1.json:26-29)', () => {
  const document = core('---\n&a [one, *a]\n---\n{k: v}\n');
  assert.equal(document.documentCount(), 2);
  assert.equal(document.aliasCount(), 1);
  // The first document root is the anchored self-referential sequence.
  const root = document.document(0)!.root();
  assert.equal(root.anchor(), 'a');
  assert.equal(root.sequenceLen(), 2);
  assert.equal(root.sequenceItem(1)!.node().nodeRef().equals(root.nodeRef()), true);
});

test('syntax.styles-and-trivia — piece_count 48 (yaml-v1.json:31-34)', () => {
  const source =
    '--- # doc\nplain: text\nsingle: \'x\'\ndouble: "y"\nliteral: |-\n  a\nfolded: >+\n  b\nflow: [one, {k: v}]\n...\n';
  const document = core(source);
  const kinds = document.losslessSyntaxKinds();
  assert.equal(kinds.length, 48, 'exhaustive piece count');
  const required = [
    'DocumentStart',
    'Comment',
    'PlainScalar',
    'SingleQuotedScalar',
    'DoubleQuotedScalar',
    'LiteralBlockHeader',
    'FoldedBlockHeader',
    'BlockScalarContent',
    'FlowSequenceStart',
    'FlowMappingStart',
    'DocumentEnd',
  ];
  for (const kind of required) {
    assert.ok(
      kinds.includes(kind as import('./syntax.ts').YamlSyntaxKind),
      `required kind ${kind}`,
    );
  }
});

test('native.arbitrary-duplicate-mapping — explicit keys and duplicates (yaml-v1.json:36-39)', () => {
  const document = core('? [a, b]\n: one\nk: two\nk: three\n');
  const root = document.document(0)!.root();
  assert.equal(root.mappingLen(), 3);
  assert.equal(root.mappingEntry(0)!.key().kind(), 'Sequence');
  assert.equal(root.mappingEntry(1)!.key().kind(), 'Scalar');
  assert.equal(root.mappingEntry(2)!.key().kind(), 'Scalar');
  assert.equal(root.mappingEntry(0)!.value().scalar()!.decoded(), 'one');
  assert.equal(root.mappingEntry(1)!.value().scalar()!.decoded(), 'two');
  assert.equal(root.mappingEntry(2)!.value().scalar()!.decoded(), 'three');
});

test('formation.undefined-alias — syntax failure, no document (yaml-v1.json:41-44)', () => {
  assert.throws(
    () => core('[*missing]\n'),
    (error: unknown) =>
      error instanceof FatalFormationFailure &&
      error.diagnostics()[0].code === 'yaml.parse.syntax@1',
  );
});

test('graph.shared-cycle — self-alias composes one shared node (yaml-v1.json:46-49)', () => {
  const document = core('&root [one, *root]\n');
  const root = document.document(0)!.root();
  assert.equal(root.anchor(), 'root');
  assert.equal(root.sequenceLen(), 2);
  assert.equal(root.sequenceItem(0)!.node().scalar()!.decoded(), 'one');
  // The alias is one edge referencing the same representation node; no
  // expansion occurs (RFC 0007 §8:209-212).
  assert.equal(document.aliasCount(), 1);
  assert.equal(root.sequenceItem(1)!.node().nodeRef().equals(root.nodeRef()), true);
});

test('resource.parse-source-bytes — source limit is fatal (yaml-v1.json:126-129)', () => {
  assert.throws(
    () =>
      parse(textToBytes('a: 1\n'), PROFILE_YAML12_CORE, {
        ...DEFAULT_PARSE_LIMITS,
        maxSourceBytes: 4,
      }),
    (error: unknown) =>
      error instanceof FatalFormationFailure &&
      error.diagnostics()[0].code === 'core.parse.resource-limit@1' &&
      error.diagnostics()[0].arguments.get('name') === 'source-bytes',
  );
});

test('regression.plain-property-characters — property markers inside plain scalars (yaml-v1.json:136-139)', () => {
  const document = core('---\nk:#foo\n &a !t s\n');
  const scalar = document.document(0)!.root().scalar()!;
  assert.equal(scalar.decoded(), 'k:#foo &a !t s');
  assert.equal(scalar.canonical(), 'k:#foo &a !t s');
  assert.equal(document.aliasCount(), 0);
  assert.ok(!document.losslessSyntaxKinds().includes('Anchor'));
  assert.ok(!document.losslessSyntaxKinds().includes('Tag'));
});

test('alias bomb — aliases are never expanded and stay linear', () => {
  // A wide alias bomb: one anchored node referenced many times. The parse
  // must complete (one edge per occurrence, RFC 0007 §8) and the alias
  // count must be exact; no expansion is performed.
  const aliases = Array.from({ length: 10_000 }, () => '*x').join(', ');
  const document = core(`&x [one, ${aliases}]\n`);
  assert.equal(document.aliasCount(), 10_000);
  assert.equal(document.document(0)!.root().sequenceLen(), 10_001);
});

test('alias bomb — deep alias chain stays within nesting limits', () => {
  // A self-referential chain `&a [&b [*a]]` style nesting is bounded by
  // max_nesting_depth at parse time; a chain that exceeds it fails
  // atomically with the resource-limit code.
  const deep = '['.repeat(300);
  assert.throws(
    () => core(`${deep}x${']'.repeat(300)}\n`),
    (error: unknown) =>
      error instanceof FatalFormationFailure &&
      error.diagnostics()[0].code === 'core.parse.resource-limit@1',
  );
});

test('version directive — profile conflict is fatal (lib.rs:789-831)', () => {
  assert.throws(
    () => core('%YAML 1.1\n---\nyes\n'),
    (error: unknown) =>
      error instanceof FatalFormationFailure &&
      error.diagnostics()[0].code === 'yaml.profile.version-directive@1',
  );
  // The same source is valid under the 1.1-compat profile.
  const document = parse(
    textToBytes('%YAML 1.1\n---\nyes\n'),
    PROFILE_YAML11_COMPAT,
    DEFAULT_PARSE_LIMITS,
  );
  assert.equal(document.documentCount(), 1);
});

test('explicit standard tags are kind and grammar checked (lib.rs:1375-1398)', () => {
  assert.throws(
    () => core('!!int nope\n'),
    (error: unknown) =>
      error instanceof FatalFormationFailure &&
      error.diagnostics()[0].code === 'yaml.scalar.invalid-explicit-tag@1',
  );
  assert.throws(
    () => core('!!seq {a: b}\n'),
    (error: unknown) =>
      error instanceof FatalFormationFailure &&
      error.diagnostics()[0].code === 'yaml.tag.kind-mismatch@1',
  );
});

test('block scalars keep exact content and chomping (lib.rs:1235-1261)', () => {
  const document = core('a: |\n  ~\nb: >\n  null\n');
  const values = [document.document(0)!.root().mappingEntry(0)!.value(), document.document(0)!.root().mappingEntry(1)!.value()];
  assert.equal(values[0].scalar()!.kind(), 'String');
  assert.equal(values[0].scalar()!.decoded(), '~\n');
  assert.equal(values[1].scalar()!.kind(), 'String');
  assert.equal(values[1].scalar()!.decoded(), 'null\n');
});

test('quoted core keywords are exact strings (lib.rs:1049-1083)', () => {
  const keywords = ['', '~', 'null', 'true', 'false', '.inf', '0', '0x1F', '0o17', '1e3', '1.5'];
  for (const keyword of keywords) {
    for (const quote of ['"', "'"]) {
      const scalar = core(`${quote}${keyword}${quote}\n`).document(0)!.root().scalar()!;
      assert.equal(scalar.kind(), 'String', `quoted ${keyword}`);
      assert.equal(scalar.decoded(), keyword, `quoted ${keyword} decoded`);
      assert.equal(scalar.canonical(), keyword, `quoted ${keyword} canonical`);
    }
  }
});
