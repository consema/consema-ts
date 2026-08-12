/**
 * Intent documents for JSON/JSONC/JSON5 formation (L1).
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id — plus formation closure and resource-limit behavior:
 *  - conformance/vectors/json-family-v2.json: json5.parse.full-surface
 *    (:6-10), json5.parse.identifiers (:12-16), json5.parse.string-
 *    extensions (:18-22), json5.parse.extended-whitespace-comments
 *    (:24-28), json5.parse.unescaped-separator-warning (:30-34),
 *    json5.reject.invalid-escaped-identifier (:36-40),
 *    json5.reject.leading-zero-decimal (:42-46),
 *    json5.reject.empty-hex (:48-52), json5.reject.decimal-string-escape
 *    (:54-58), json5.reject.isolated-surrogate (:60-64),
 *    json5.reject.unterminated-comment (:66-70),
 *    json.strict.reject-json5-surface (:72-76),
 *    jsonc.complete-shared-surface (:78-82),
 *    json5.complete-jsonc-surface (:84-88),
 *    json5.number.positive-infinity (:90-94),
 *    json5.number.negative-nan (:96-100), json5.number.huge-hex-exact
 *    (:102-106), json5.number.leading-trailing-exact (:108-112),
 *    json5.security.depth-limit (:198-202)
 *  - conformance/vectors/v1.json: parse.strict-exact-roundtrip (:41-45),
 *    parse.jsonc-comments-trailing-comma (:47-51),
 *    parse.recovery-missing-close (:53-57), parse.duplicate-members
 *    (:59-63), parse.lossless-byte-coverage (:65-69),
 *    resource.parse-token-limit (:179-183)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse, FatalFormationFailure } from '../json/index.ts';
import { PROFILE_JSON5_STANDARD, PROFILE_JSONC_BOUNDED, PROFILE_JSON_STRICT } from '../json/index.ts';
import type { SemanticAvailability } from '../json/index.ts';
import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import type { ParseLimits } from '../document/formation.ts';

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function parse5(source: string): ReturnType<typeof parse> {
  return parse(bytes(source), PROFILE_JSON5_STANDARD, DEFAULT_PARSE_LIMITS);
}

function parseStrict(source: string): ReturnType<typeof parse> {
  return parse(bytes(source), PROFILE_JSON_STRICT, DEFAULT_PARSE_LIMITS);
}

function parseJsonc(source: string): ReturnType<typeof parse> {
  return parse(bytes(source), PROFILE_JSONC_BOUNDED, DEFAULT_PARSE_LIMITS);
}

/** Unwraps an available semantic value or fails the test. */
function availableValue<T>(result: SemanticAvailability<T>): T {
  if (result.kind !== 'Available') {
    throw new Error(`expected an available semantic value, got ${result.kind}`);
  }
  return result.value;
}

test('json5.parse.full-surface: BOM, comments, identifiers, numbers, non-finite (json-family-v2.json:6-10)', () => {
  const document = parse5(
    '\uFEFF{ // lead\nunquoted:\'value\',\\u0061:.5,hex:+0X10,trail:1.,exp:1.e+2,truth:true,nil:null,inf:-Infinity,nan:+NaN,}',
  );
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(availableValue(document.root().kind()), 'Object');
  const members = availableValue(document.root().objectMembers());
  const names = members!.map((member) => availableValue(member.name()));
  assert.deepEqual(names, ['unquoted', 'a', 'hex', 'trail', 'exp', 'truth', 'nil', 'inf', 'nan']);
  const kinds = members!.map((member) => availableValue(member.value().kind()));
  assert.deepEqual(kinds, [
    'String',
    'Decimal',
    'Integer',
    'Decimal',
    'Decimal',
    'Boolean',
    'Null',
    'BinaryFloat64',
    'BinaryFloat64',
  ]);
  const syntaxKinds = document.losslessSyntaxKinds();
  assert.ok(syntaxKinds.includes('Bom'));
  assert.ok(syntaxKinds.includes('LineComment'));
  assert.ok(syntaxKinds.includes('Identifier'));
});

test('json5.parse.identifiers: reserved words and escaped identifiers are member names (json-family-v2.json:12-16)', () => {
  const document = parse5('{$_:1,while:2,true:3,\u03C0:4,\\u0061:5,a\u200C:6,a\u200D:7}');
  assert.equal(document.formationStatus(), 'Complete');
  const members = availableValue(document.root().objectMembers());
  const names = members!.map((member) => availableValue(member.name()));
  assert.deepEqual(names, ['$_', 'while', 'true', '\u03C0', 'a', 'a\u200C', 'a\u200D']);
});

test('json5.parse.string-extensions: quote/escape surface and line continuation (json-family-v2.json:18-22)', () => {
  const document = parse5(
    "['single','\\x41','\\v','\\0','\\q','line\\\nnext','\\uD83D\\uDE00']",
  );
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(availableValue(document.root().kind()), 'Array');
  const elements = availableValue(document.root().arrayElements());
  const strings = elements!.map((element) => availableValue(element.value().asString()));
  assert.deepEqual(strings, ['single', 'A', '\u000b', '\u0000', 'q', 'linenext', '\u{1F600}']);
});

test('json5.parse.extended-whitespace-comments: exact whitespace union (json-family-v2.json:24-28)', () => {
  const document = parse5('\u00A0\u1680// line\u2028[1,/* block */2,]\u3000');
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(availableValue(document.root().kind()), 'Array');
  const kinds = document.losslessSyntaxKinds();
  assert.ok(kinds.includes('Whitespace'));
  assert.ok(kinds.includes('LineComment'));
  assert.ok(kinds.includes('BlockComment'));
});

test('json5.parse.unescaped-separator-warning: unescaped U+2028 warns but completes (json-family-v2.json:30-34)', () => {
  const document = parse5('\'a\u2028b\'');
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(availableValue(document.root().kind()), 'String');
  const codes = document.diagnostics().map((item) => item.code);
  assert.ok(codes.includes('json5.string.unescaped-line-separator@1'));
});

test('json5.reject.invalid-escaped-identifier: escaped digit cannot start an identifier (json-family-v2.json:36-40)', () => {
  const document = parse5('{\\u0030bad:1}');
  assert.equal(document.formationStatus(), 'Recovered');
  const codes = document.diagnostics().map((item) => item.code);
  assert.ok(codes.includes('json5.syntax.invalid-identifier@1'));
});

test('json5.reject.leading-zero-decimal (json-family-v2.json:42-46)', () => {
  const document = parse5('01');
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(document.diagnostics().some((item) => item.code === 'json.syntax.invalid-number@1'));
});

test('json5.reject.empty-hex (json-family-v2.json:48-52)', () => {
  const document = parse5('0x');
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(document.diagnostics().some((item) => item.code === 'json.syntax.invalid-number@1'));
});

test('json5.reject.decimal-string-escape (json-family-v2.json:54-58)', () => {
  const document = parse5('\'\\1\'');
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(document.diagnostics().some((item) => item.code === 'json.syntax.invalid-string-escape@1'));
});

test('json5.reject.isolated-surrogate (json-family-v2.json:60-64)', () => {
  const document = parse5('\'\\uD800\'');
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(document.diagnostics().some((item) => item.code === 'json.syntax.invalid-string-escape@1'));
});

test('json5.reject.unterminated-comment (json-family-v2.json:66-70)', () => {
  const document = parse5('1/* open');
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(
    document.diagnostics().some((item) => item.code === 'json.syntax.unterminated-block-comment@1'),
  );
});

test('json.strict.reject-json5-surface: comments and trailing commas are recovery (json-family-v2.json:72-76)', () => {
  const document = parseStrict('// note\n{"a":1,}');
  assert.equal(document.formationStatus(), 'Recovered');
  assert.equal(availableValue(document.root().kind()), 'Object');
  const codes = document.diagnostics().map((item) => item.code);
  assert.ok(codes.includes('json.strict.comment-not-allowed@1'));
  assert.ok(codes.includes('json.strict.trailing-comma@1'));
});

test('jsonc.complete-shared-surface (json-family-v2.json:78-82)', () => {
  const document = parseJsonc('// note\n{"a":1,}');
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(availableValue(document.root().kind()), 'Object');
});

test('json5.complete-jsonc-surface (json-family-v2.json:84-88)', () => {
  const document = parse5('// note\n{"a":1,}');
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(availableValue(document.root().kind()), 'Object');
});

test('json5.number.positive-infinity: frozen bit pattern (json-family-v2.json:90-94)', () => {
  const document = parse5('+Infinity');
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(availableValue(document.root().kind()), 'BinaryFloat64');
  assert.equal(availableValue(document.root().asBinaryFloat64()), 0x7ff0000000000000n);
});

test('json5.number.negative-nan: frozen bit pattern (json-family-v2.json:96-100)', () => {
  const document = parse5('-NaN');
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(availableValue(document.root().asBinaryFloat64()), 0xfff8000000000000n);
});

test('json5.number.huge-hex-exact: arbitrary precision without float rounding (json-family-v2.json:102-106)', () => {
  const document = parse5('0xFFFFFFFFFFFFFFFFFFFFFFFF');
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(availableValue(document.root().kind()), 'Integer');
  assert.equal(availableValue(document.root().asInteger()), 79228162514264337593543950335n);
});

test('json5.number.leading-trailing-exact: normalized decimals (json-family-v2.json:108-112)', () => {
  const document = parse5('[.5,1.,1.e2]');
  assert.equal(document.formationStatus(), 'Complete');
  const elements = availableValue(document.root().arrayElements());
  const decimals = elements!.map((element) => {
    const value = availableValue(element.value().asDecimal());
    return value === null ? null : [value.coefficient.toString(), value.exponent.toString()];
  });
  assert.deepEqual(decimals, [
    ['5', '-1'],
    ['1', '0'],
    ['1', '2'],
  ]);
});

test('strict JSON with a leading BOM forms Complete with a warning (parser.rs:193-214)', () => {
  const document = parseStrict('\uFEFF{"a":1}');
  assert.equal(document.formationStatus(), 'Complete');
  assert.ok(document.diagnostics().some((item) => item.code === 'json.strict.leading-bom@1'));
});

test('parse.strict-exact-roundtrip: lossless bytes (v1.json:41-45)', () => {
  const source = ' {\n  "a" : [1, 2]\n} ';
  const document = parseStrict(source);
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(new TextDecoder().decode(document.render()), source);
});

test('parse.jsonc-comments-trailing-comma: lossless bytes (v1.json:47-51)', () => {
  const source = '{/*x*/"a":1,}';
  const document = parseJsonc(source);
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(new TextDecoder().decode(document.render()), source);
});

test('parse.recovery-missing-close (v1.json:53-57)', () => {
  const document = parseStrict('{"a":1');
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(document.diagnostics().some((item) => item.code === 'json.syntax.missing-object-close@1'));
});

test('parse.duplicate-members: distinct identity preserved (v1.json:59-63)', () => {
  const document = parseStrict('{"a":1,"a":2}');
  const members = availableValue(document.root().objectMembers());
  const names = members!.map((member) => availableValue(member.name()));
  assert.deepEqual(names, ['a', 'a']);
  assert.ok(!members![0].nodeRef().equals(members![1].nodeRef()));
  assert.ok(document.diagnostics().some((item) => item.code === 'json.object.duplicate-member@1'));
});

test('parse.lossless-byte-coverage: exhaustive no-gap/no-overlap pieces (v1.json:65-69)', () => {
  const source = ' \n// c\n[1,] ';
  const document = parseJsonc(source);
  const pieces = document.losslessStructuralIndex().pieces();
  let covered = 0;
  let previousEnd = 0;
  for (const piece of pieces) {
    assert.equal(piece.span().startByte(), previousEnd, 'no gap and no overlap');
    covered += piece.span().len();
    previousEnd = piece.span().endByte();
  }
  assert.equal(covered, 12);
  assert.equal(document.source().len(), 12);
  assert.equal(document.losslessSyntaxKinds().length, pieces.length);
});

test('formation closure: every Complete document reparses to identical bytes and status', () => {
  const sources = [
    ['{\n  "a" : [1, 2]\n}', PROFILE_JSON_STRICT],
    ['{/*x*/"a":1,}', PROFILE_JSONC_BOUNDED],
    ['{unquoted:\'value\',hex:+0X10,truth:true,nil:null,inf:-Infinity,}', PROFILE_JSON5_STANDARD],
    ['[.5,1.,1.e2]', PROFILE_JSON5_STANDARD],
    ['\uFEFF// c\n{"a":1,}', PROFILE_JSONC_BOUNDED],
  ] as const;
  for (const [source, profile] of sources) {
    const first = parse(bytes(source), profile, DEFAULT_PARSE_LIMITS);
    assert.equal(first.formationStatus(), 'Complete');
    const second = parse(first.render(), profile, DEFAULT_PARSE_LIMITS);
    assert.equal(second.formationStatus(), 'Complete');
    // TextDecoder strips a leading BOM by default; keep it to compare bytes.
    assert.equal(new TextDecoder('utf-8', { ignoreBOM: true }).decode(second.render()), source);
    assert.deepEqual(
      second.diagnostics().map((item) => item.code),
      first.diagnostics().map((item) => item.code),
    );
  }
});

test('json5.security.depth-limit: exceeding max depth is fatal (json-family-v2.json:198-202)', () => {
  const limits: ParseLimits = { ...DEFAULT_PARSE_LIMITS, maxNestingDepth: 2 };
  assert.throws(
    () => parse(bytes('[[[[0]]]]'), PROFILE_JSON5_STANDARD, limits),
    (error: unknown) => {
      assert.ok(error instanceof FatalFormationFailure);
      const diagnostics = error.diagnostics();
      assert.equal(diagnostics[0].code, 'core.parse.resource-limit@1');
      assert.equal(diagnostics[0].arguments.get('name'), 'nesting-depth');
      return true;
    },
  );
});

test('resource.parse-token-limit: exceeding max token count is fatal (v1.json:179-183)', () => {
  const limits: ParseLimits = { ...DEFAULT_PARSE_LIMITS, maxTokenCount: 2 };
  assert.throws(
    () => parse(bytes('[1,2]'), PROFILE_JSON_STRICT, limits),
    (error: unknown) => {
      assert.ok(error instanceof FatalFormationFailure);
      const diagnostics = error.diagnostics();
      assert.equal(diagnostics[0].code, 'core.parse.resource-limit@1');
      assert.equal(diagnostics[0].arguments.get('name'), 'token-count');
      return true;
    },
  );
});
