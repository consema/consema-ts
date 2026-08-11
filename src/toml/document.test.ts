/**
 * TOML formation intent tests — golden transcriptions from the shared
 * vector suite and formation closure.
 *
 * These are blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3): they transcribe the language-neutral facts from
 * conformance/vectors/toml-v1.json and the Rust arbitration
 * (crates/consema-toml/src/parser.rs) and run once the toolchain is ready.
 * No gate is claimed before the §7 START GATE.
 *
 * Golden cases cited: toml-v1.json case ids are named in each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import { parseToml, TomlDocument, TomlEntry } from './document.ts';
import { TomlProfile, capabilityTomlDocumentComplete, capabilityTomlDocumentLosslessSyntax } from './profile.ts';
import { TomlFormationFailure } from './errors.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../conformance/fixtures/toml');

function fixture(name: string): Uint8Array {
  // readFileSync returns a Buffer; strict deepEqual compares prototypes, so
  // detach a plain Uint8Array copy for render comparisons.
  return new Uint8Array(readFileSync(resolve(FIXTURES, name)));
}

function parseSource(source: string, limits = DEFAULT_PARSE_LIMITS): TomlDocument {
  return parseToml(new TextEncoder().encode(source), TomlProfile.TOML_10_V1, limits);
}

/** Finds one root entry by name. */
function rootEntry(document: TomlDocument, name: string): TomlEntry {
  const entries = document.root().tableEntries()!;
  const found = entries.find((entry) => entry.name() === name);
  assert.ok(found !== undefined, `root entry ${name} exists`);
  return found;
}

// ---------------------------------------------------------------------------
// Golden transcriptions
// ---------------------------------------------------------------------------

test('golden toml.parse.exact-roundtrip: all-values.toml renders byte-exact', () => {
  // conformance/vectors/toml-v1.json:5-10 (id toml.parse.exact-roundtrip;
  // capability toml.document.complete@1).
  const bytes = fixture('all-values.toml');
  const document = parseToml(bytes, TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.render(), bytes);
  assert.equal(document.profile().toString(), 'toml.1.0@1');
  assert.equal(document.formatFamily().toString(), 'toml@1');
  assert.deepEqual(document.diagnostics(), []);
});

test('golden toml.parse.lossless-byte-coverage: trivia-and-strings.toml covers every byte once', () => {
  // conformance/vectors/toml-v1.json:11-16 (id toml.parse.lossless-byte-
  // coverage; expected gap_count 0, overlap_count 0).
  const bytes = fixture('trivia-and-strings.toml');
  const document = parseToml(bytes, TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
  const pieces = document.losslessStructuralIndex().pieces();
  let next = 0;
  for (const piece of pieces) {
    assert.equal(piece.span().startByte(), next, 'no gap and no overlap');
    next = piece.span().endByte();
  }
  assert.equal(next, bytes.length, 'pieces cover the whole source');
  assert.deepEqual(document.render(), bytes);
});

test('golden toml.native.table-flavors: application.toml flavors are Dotted/Standard/Implicit', () => {
  // conformance/vectors/toml-v1.json:23-28 (expected service DottedTable,
  // database StandardTable, observability ImplicitTable).
  const document = parseToml(fixture('application.toml'), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
  assert.equal(rootEntry(document, 'service').item().kind(), 'DottedTable');
  assert.equal(rootEntry(document, 'database').item().kind(), 'StandardTable');
  assert.equal(rootEntry(document, 'observability').item().kind(), 'ImplicitTable');
  assert.equal(document.root().kind(), 'RootTable');
});

test('golden toml.native.array-aot-distinct: timeouts is Array, upstreams is ArrayOfTables', () => {
  // conformance/vectors/toml-v1.json:29-34 (expected timeouts Array,
  // upstreams ArrayOfTables, upstream_count 2).
  const document = parseToml(fixture('application.toml'), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
  // timeouts lives in [database].
  const database = rootEntry(document, 'database').item();
  const timeoutsItem = database.tableEntries()!.find((entry) => entry.name() === 'timeouts')!.item();
  assert.equal(timeoutsItem.kind(), 'Array');
  const upstreams = rootEntry(document, 'upstreams').item();
  assert.equal(upstreams.kind(), 'ArrayOfTables');
  const elements = upstreams.arrayElements()!;
  assert.equal(elements.length, 2);
  assert.deepEqual(
    elements.map((element) => element.item().tableEntries()![0].name()),
    ['name', 'name'],
  );
});

test('golden toml.native.dotted-segments: alpha.beta.gamma keeps three segment levels', () => {
  // conformance/vectors/toml-v1.json:17-22 (expected segments
  // ["alpha","beta","gamma"], leaf_kind Integer).
  const document = parseSource('alpha.beta.gamma = 1\n');
  const alpha = rootEntry(document, 'alpha');
  assert.equal(alpha.name(), 'alpha');
  assert.equal(alpha.item().kind(), 'DottedTable');
  const beta = alpha.item().tableEntries()![0];
  assert.equal(beta.name(), 'beta');
  assert.equal(beta.item().kind(), 'DottedTable');
  const gamma = beta.item().tableEntries()![0];
  assert.equal(gamma.name(), 'gamma');
  assert.equal(gamma.item().kind(), 'Integer');
  // Each direct key segment keeps its own source span (RFC 0001 §2.1).
  assert.deepEqual(
    [alpha.key().span().startByte(), beta.key().span().startByte(), gamma.key().span().startByte()],
    [0, 6, 11],
  );
});

test('golden toml.native.float-signed-zero: 0.0 and -0.0 keep their exact bit patterns', () => {
  // conformance/vectors/toml-v1.json:35-40 (expected positive_bits
  // 0000000000000000, negative_bits 8000000000000000).
  const document = parseSource('positive = 0.0\nnegative = -0.0\n');
  const positive = rootEntry(document, 'positive').item();
  const negative = rootEntry(document, 'negative').item();
  assert.equal(positive.kind(), 'Float');
  assert.equal(negative.kind(), 'Float');
  assert.equal(positive.asFloatBits()!.toString(16).padStart(16, '0'), '0000000000000000');
  assert.equal(negative.asFloatBits()!.toString(16).padStart(16, '0'), '8000000000000000');
});

test('formation closure: every valid document family shape forms Complete', () => {
  // Closure over the native item categories (RFC 0001 §2: strings,
  // integers, floats, booleans, four temporals, arrays, inline tables,
  // tables of all flavors, arrays-of-tables).
  const document = parseSource(
    [
      'string = "a\\nb"',
      "literal = 'C:\\path'",
      'integer = -42',
      'hex = 0xDEAD_BEEF',
      'oct = 0o755',
      'bin = 0b1010_1010',
      'float = 6.626e-34',
      'inf = +inf',
      'neg_inf = -inf',
      'nan = nan',
      'neg_nan = -nan',
      'enabled = true',
      'disabled = false',
      'date = 1979-05-27',
      'time = 07:32:00.123456789',
      'local = 1979-05-27T07:32:00',
      'offset = 1979-05-27 07:32:00-07:00',
      'offset_z = 1979-05-27t07:32:00z',
      'array = [1, 2, 3,]',
      'inline = { x = 1, y = { z = "w" } }',
      'dotted.a.b = 1',
      '[standard]',
      'value = 1',
      '[standard.nested]',
      'deep = true',
      '[[items]]',
      'name = "one"',
      '[[items]]',
      'name = "two"',
      '',
    ].join('\n'),
  );
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(
    document.root().tableEntries()!.map((entry) => entry.name()),
    ['string', 'literal', 'integer', 'hex', 'oct', 'bin', 'float', 'inf', 'neg_inf', 'nan',
     'neg_nan', 'enabled', 'disabled', 'date', 'time', 'local', 'offset', 'offset_z',
     'array', 'inline', 'dotted', 'standard', 'items'],
  );
  assert.equal(rootEntry(document, 'string').item().asString(), 'a\nb');
  assert.equal(rootEntry(document, 'literal').item().asString(), 'C:\\path');
  assert.equal(rootEntry(document, 'hex').item().asInteger(), 0xdead_beefn);
  assert.equal(rootEntry(document, 'oct').item().asInteger(), 0o755n);
  assert.equal(rootEntry(document, 'bin').item().asInteger(), 0b10101010n);
  assert.equal(rootEntry(document, 'float').item().asFloatBits(), f64Bits(6.626e-34));
  assert.equal(rootEntry(document, 'inf').item().asFloatBits(), 0x7ff0000000000000n);
  assert.equal(rootEntry(document, 'neg_inf').item().asFloatBits(), 0xfff0000000000000n);
  assert.equal(rootEntry(document, 'nan').item().asFloatBits(), 0x7ff8000000000000n);
  assert.equal(rootEntry(document, 'neg_nan').item().asFloatBits(), 0xfff8000000000000n);
  assert.equal(rootEntry(document, 'enabled').item().asBoolean(), true);
  assert.equal(rootEntry(document, 'disabled').item().asBoolean(), false);
  const dateTime = rootEntry(document, 'local').item().asDateTime()!;
  assert.equal(dateTime.date!.year, 1979);
  assert.equal(dateTime.date!.month, 5);
  assert.equal(dateTime.date!.day, 27);
  assert.equal(dateTime.time!.hour, 7);
  assert.equal(dateTime.time!.nanosecond, 0);
  const offset = rootEntry(document, 'offset').item().asDateTime()!;
  assert.equal(offset.offset!.kind === 'CustomMinutes' ? offset.offset!.minutes : 0, -420);
  const offsetZ = rootEntry(document, 'offset_z').item().asDateTime()!;
  assert.deepEqual(offsetZ.offset, { kind: 'Z' });
  const time = rootEntry(document, 'time').item().asDateTime()!;
  assert.equal(time.time!.nanosecond, 123456789);
  const inline = rootEntry(document, 'inline').item();
  assert.equal(inline.kind(), 'InlineTable');
  assert.deepEqual(
    inline.tableEntries()!.map((entry) => entry.name()),
    ['x', 'y'],
  );
  const items = rootEntry(document, 'items').item();
  assert.equal(items.kind(), 'ArrayOfTables');
  assert.equal(items.arrayElements()!.length, 2);
  // Quoted keys and dotted keys in a standard table.
  const standard = rootEntry(document, 'standard').item();
  assert.equal(standard.kind(), 'StandardTable');
  assert.deepEqual(
    standard.tableEntries()!.map((entry) => entry.name()),
    ['value', 'nested'],
  );
  assert.equal(standard.tableEntries()![1].item().kind(), 'StandardTable');
});

test('parse rejects invalid documents with toml.parse.syntax@1 (golden toml.parse.reject-invalid)', () => {
  // conformance/vectors/toml-v1.json:83-88 (fixture invalid-duplicate.toml;
  // expected status FatalFormationFailure, diagnostic toml.parse.syntax@1).
  const bytes = fixture('invalid-duplicate.toml');
  assert.throws(
    () => parseToml(bytes, TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS),
    (failure: TomlFormationFailure) => {
      assert.equal(failure.kind, 'FatalFormationFailure');
      assert.equal(failure.code, 'toml.parse.syntax@1');
      assert.equal(failure.diagnostics.length, 1);
      assert.equal(failure.diagnostics[0].code, 'toml.parse.syntax@1');
      assert.equal(failure.diagnostics[0].category, 'Syntax');
      return true;
    },
  );
});

test('duplicate keys, table redefinition, and closed inline tables are syntax errors', () => {
  for (const source of [
    'a.b = 1\na.b = 2\n', // duplicate leaf
    'a.b = 1\na.b.c = 2\n', // dotted key extends a value
    '[a]\n[a]\n', // double header
    '[a.b]\n[a]\n', // header over implicit table
    'a.b = 1\n[a]\n', // header over dotted-defined table
    'a = { }\n[a]\n', // header over inline table
    // NOTE: "[a]\na = { }\n" is valid TOML — keys inside [a] are relative
    // (defines a.a); only root-level "a = { }\n[a]\n" above is a conflict.
    '[[a]]\n[a]\n', // header over array-of-tables
    '[a]\n[[a]]\n', // array-of-tables over header
  ]) {
    assert.throws(
      () => parseSource(source),
      (failure: TomlFormationFailure) => failure.code === 'toml.parse.syntax@1',
      `syntax failure expected for ${JSON.stringify(source)}`,
    );
  }
});

test('keys inside a table are relative: [a] then "a.b = 1" defines a.a.b', () => {
  // TOML 1.0.0 §4.4 — dotted keys are relative to the current table, so
  // inside [a] the key "a.b" defines a NEW nested table a.a (valid).
  const document = parseSource('[a]\na.b = 1\n');
  const a = rootEntry(document, 'a').item();
  assert.equal(a.kind(), 'StandardTable');
  const nested = a.tableEntries()![0];
  assert.equal(nested.name(), 'a');
  assert.equal(nested.item().kind(), 'DottedTable');
  assert.equal(nested.item().tableEntries()![0].name(), 'b');
});

test('array-of-tables elements are isolated from each other', () => {
  const document = parseSource(
    [
      '[[a]]',
      '[a.b]',
      'x = 1',
      '[[a]]',
      '[a.b]',
      'y = 2',
      '',
    ].join('\n'),
  );
  const a = rootEntry(document, 'a').item();
  const elements = a.arrayElements()!;
  assert.equal(elements.length, 2);
  assert.deepEqual(
    elements[0].item().tableEntries()![0].item().tableEntries()!.map((e) => e.name()),
    ['x'],
  );
  assert.deepEqual(
    elements[1].item().tableEntries()![0].item().tableEntries()!.map((e) => e.name()),
    ['y'],
  );
});

test('dotted keys extend the most recent array-of-tables element', () => {
  const document = parseSource(
    [
      '[[upstreams]]',
      'name = "first"',
      'upstreams.port = 1',
      '[[upstreams]]',
      'name = "second"',
      'upstreams.port = 2',
      '',
    ].join('\n'),
  );
  const upstreams = rootEntry(document, 'upstreams').item();
  const elements = upstreams.arrayElements()!;
  assert.deepEqual(
    elements[0].item().tableEntries()!.map((entry) => entry.name()),
    ['name', 'port'],
  );
  assert.equal(elements[0].item().tableEntries()![1].item().asInteger(), 1n);
  assert.equal(elements[1].item().tableEntries()![1].item().asInteger(), 2n);
});

test('leap seconds parse (projection rejects them later; toml-v1.json:66-70)', () => {
  const document = parseSource('time = 23:59:60\n');
  assert.equal(document.formationStatus(), 'Complete');
  const time = rootEntry(document, 'time').item().asDateTime()!;
  assert.equal(time.time!.second, 60);
});

test('resource limits fail with core.parse.resource-limit@1 (golden toml.resource.token-limit)', () => {
  // conformance/vectors/toml-v1.json:89-94 (max_token_count 3 on
  // "values = [1, 2, 3]"; truncated_success must be false).
  const limits = { ...DEFAULT_PARSE_LIMITS, maxTokenCount: 3 };
  assert.throws(
    () => parseSource('values = [1, 2, 3]', limits),
    (failure: TomlFormationFailure) => {
      assert.equal(failure.kind, 'FatalFormationFailure');
      assert.equal(failure.code, 'core.parse.resource-limit@1');
      assert.equal(failure.limitName, 'token_count');
      assert.equal(failure.observed, 4);
      assert.equal(failure.limit, 3);
      assert.equal(failure.diagnostics[0].arguments.get('name'), 'token_count');
      return true;
    },
  );
});

test('node and depth limits fail with core.parse.resource-limit@1 (golden toml.resource.node-depth-limits)', () => {
  // conformance/vectors/toml-v1.json:95-100 (max_node_count 3 and
  // max_nesting_depth 2 on "value = [[[[1]]]]"; truncated_success false).
  const limits = { ...DEFAULT_PARSE_LIMITS, maxNodeCount: 3, maxNestingDepth: 2 };
  assert.throws(
    () => parseSource('value = [[[[1]]]]', limits),
    (failure: TomlFormationFailure) => {
      assert.equal(failure.kind, 'FatalFormationFailure');
      assert.equal(failure.code, 'core.parse.resource-limit@1');
      return true;
    },
  );
});

test('invalid UTF-8 fails formation with the source code', () => {
  assert.throws(
    () => parseToml(Uint8Array.of(0x61, 0x3d, 0xff, 0x0a), TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS),
    (failure: TomlFormationFailure) => {
      assert.equal(failure.kind, 'FatalFormationFailure');
      assert.equal(failure.code, 'core.source.invalid-utf8@1');
      return true;
    },
  );
});

test('toml.corpus.cargo-manifest and pyproject parse completely and render byte-exact', () => {
  // conformance/vectors/toml-v1.json:101-112 (both cases expect formation
  // Complete, render_equals_source true, projection Complete).
  for (const name of ['pyproject.toml']) {
    const bytes = fixture(name);
    const document = parseToml(bytes, TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
    assert.equal(document.formationStatus(), 'Complete');
    assert.deepEqual(document.render(), bytes);
  }
  const cargo = new Uint8Array(readFileSync(resolve(HERE, '../../../Cargo.toml')));
  const document = parseToml(cargo, TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.render(), cargo);
});

test('capability declarations match the vector suite capability field', () => {
  assert.equal(capabilityTomlDocumentComplete().namespace, 'toml.document.complete');
  assert.equal(capabilityTomlDocumentComplete().version, 1);
  assert.equal(capabilityTomlDocumentLosslessSyntax().namespace, 'toml.document.lossless-syntax');
});

function f64Bits(value: number): bigint {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}
