/**
 * HCL formation intent tests — golden transcriptions from the shared
 * vector suite, the no-evaluation gate, and the tfvars dialect coverage.
 *
 * These are blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3): they transcribe the language-neutral facts from
 * conformance/vectors/hcl-v1.json and the Rust arbitration
 * (crates/consema-hcl) and run once the toolchain is ready. No gate is
 * claimed before the §7 START GATE.
 *
 * Golden cases cited: hcl-v1.json case ids are named in each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseHcl, profileDefaultEncoding } from './document.ts';
import type { HclDocument } from './document.ts';
import { HclProfile } from './profile.ts';
import { hclParseLimits } from './limits.ts';
import { HclFormationFailure } from './errors.ts';
import { expressionFingerprint } from './expression.ts';
import type { HclExpr } from './expression.ts';

function parse(
  text: string,
  profile: HclProfile = HclProfile.NATIVE_V1,
  overrides: Parameters<typeof hclParseLimits>[0] = {},
): HclDocument {
  return parseHcl(new TextEncoder().encode(text), profile, profileDefaultEncoding(), hclParseLimits(overrides));
}

function hasCode(document: HclDocument, code: string): boolean {
  return document.diagnostics().some((diagnostic) => diagnostic.code === code);
}

/** Parses and expects a fatal limit failure with the frozen code. */
function expectFatal(text: string, code: string, overrides: Parameters<typeof hclParseLimits>[0] = {}): void {
  assert.throws(
    () => parse(text, HclProfile.NATIVE_V1, overrides),
    (error: unknown) => error instanceof HclFormationFailure && error.code === code,
  );
}

// ---------------------------------------------------------------------------
// Golden transcriptions (hcl.native-formation@1)
// ---------------------------------------------------------------------------

test('golden hcl.native-formation.body-basic: body items render byte-exact', () => {
  // conformance/vectors/hcl-v1.json:9-20 (id hcl.native-formation.body-basic;
  // capability hcl.native-formation@1; expected status Complete, render
  // byte-exact).
  const source = 'region = "us-east-1"\n\nserver "web" "1" {\n  port = 8080\n}\n\nplain {\n  x = 1\n}\n\noneline { y = 2 }\n\nshared = 1\nshared "b" {\n  z = 3\n}\n';
  const document = parse(source);
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.render(), new TextEncoder().encode(source));
  assert.equal(document.profile().toString(), 'hcl.native@1');
  assert.equal(document.formatFamily().toString(), 'hcl@1');
  assert.deepEqual(document.diagnostics(), []);
});

test('golden hcl.native-formation.comments: comments and comment-as-newline survive', () => {
  // conformance/vectors/hcl-v1.json:22-32 (id hcl.native-formation.comments;
  // expected status Complete; `d = 4 # comment terminates the attribute`).
  const source = '# leading hash\na = 1 // trailing slash\nb = 2 /* inline */\nc = 3 /* spans\nlines */\nd = 4 # comment terminates the attribute\n';
  const document = parse(source);
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.render(), new TextEncoder().encode(source));
});

test('golden hcl.native-formation.duplicate-attribute: the duplicate is Recovered and never a native attribute', () => {
  // conformance/vectors/hcl-v1.json:34-44 (id hcl.native-formation.duplicate-
  // attribute; expected status Recovered, diagnostic
  // hcl.parse.duplicate-attribute@1).
  const document = parse('a = 1\na = 2\nb = 3\n');
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(hasCode(document, 'hcl.parse.duplicate-attribute@1'));
  // The duplicate occurrence remains an inspectable proven syntax piece,
  // never a native attribute (RFC 0014 §3).
  const attributes = document.root().items().filter((item) => 'name' in item);
  assert.deepEqual(attributes.map((item) => (item as { name(): string }).name()), ['a', 'b']);
});

test('golden hcl.native-formation.expression-matrix: the full expression grammar forms', () => {
  // conformance/vectors/hcl-v1.json:46-56 (id hcl.native-formation.expression-
  // matrix; every expression family forms completely).
  const source =
    'int = 42\nreal = 1.5\nexp = 1e3\nneg = -7\nyes = true\nno = false\nnil = null\nstr = "hello"\nescaped = "line\\nbreak"\ninterp = "value: ${name}"\ncall = max(1, 2, 3)\nv = my_var\nbin = 1 + 2 * 3\ncmp = a == b\nlogic = a && b || !c\ncond = x ? "yes" : "no"\ntup = [1, "two", true]\nobj = {key = 1, "quoted" = 2}\nparen = (1 + 2) * 3\n';
  const document = parse(source);
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.render(), new TextEncoder().encode(source));
});

test('golden hcl.native-formation.heredoc: heredoc modes, marker rules, and TrimSpace closing lines', () => {
  // conformance/vectors/hcl-v1.json:58-68 (id hcl.native-formation.heredoc;
  // <<, <<-, marker-with-content lines, and trailing whitespace after the
  // closing marker).
  const source = 'plain = <<EOT\nalpha\nbeta\nEOT\nindented = <<-EOT\n    one\n      two\n    EOT\nnotclosing = <<EOT\nEOT has content\nEOT\ntrimmed = <<EOT\ntail\nEOT  \n';
  const document = parse(source);
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.render(), new TextEncoder().encode(source));
});

test('golden hcl.native-formation.templates: escapes, interpolations, directives, and $${/%%{ literals', () => {
  // conformance/vectors/hcl-v1.json:70-80 (id hcl.native-formation.templates;
  // \u0041 \U0001F600, ${~ x ~} strip markers, if/for directives).
  const source = 'a = "plain"\nb = "esc: \\n \\t \\" \\\\"\nc = "uni: \\u0041 \\U0001F600"\nd = "interp: ${x}"\ne = "strips: ${~ x ~}"\nf = "if: %{ if x }yes%{ endif }"\ng = "for2: %{ for k, v in m }${k}%{ endfor }"\nh = "for1: %{ for x in list }${x}%{ endfor }"\ni = "lit: $${x} %%{y}"\n';
  const document = parse(source);
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.render(), new TextEncoder().encode(source));
});

test('golden hcl.native-formation.number-matrix: canonical decimals and number rejections', () => {
  // conformance/vectors/hcl-v1.json:82-169 (id hcl.native-formation.number-
  // matrix; expected statuses and canonical_values per sample).
  const samples: [string, string, number | null][] = [
    ['a = 0\n', 'Complete', 0],
    ['a = 42\n', 'Complete', 42],
    ['a = 1.50\n', 'Complete', 1.5],
    ['a = 1e3\n', 'Complete', 1000],
    ['a = 15e-1\n', 'Complete', 1.5],
    ['a = 1E+2\n', 'Complete', 100],
    ['a = 0.5\n', 'Complete', 0.5],
    ['a = 1e\n', 'Recovered', null],
    ['a = 1.\n', 'Recovered', null],
    ['a = 1.e3\n', 'Recovered', null],
    ['a = 0x1F\n', 'Recovered', null],
    ['a = 1_000\n', 'Recovered', null],
  ];
  for (const [text, status] of samples) {
    const document = parse(text);
    assert.equal(document.formationStatus(), status, text);
    if (status === 'Recovered') {
      assert.ok(
        hasCode(document, 'hcl.parse.invalid-number@1') || hasCode(document, 'hcl.parse.newline@1'),
        text,
      );
    }
  }
});

test('golden hcl.native-formation.identifiers-keywords: keyword spellings are valid names; `_foo` is not', () => {
  // conformance/vectors/hcl-v1.json:171-224 (id hcl.native-formation.
  // identifiers-keywords; true/false/null as attribute names and block
  // types are Complete; `_foo = 1` and `a = _bar` are Recovered with
  // hcl.parse.identifier@1).
  for (const text of ['foo-bar = 1\n', '变量 = 2\n', 'true = 1\n', 'false = 2\n', 'null = 3\n', 'true { x = 1 }\n']) {
    const document = parse(text);
    assert.equal(document.formationStatus(), 'Complete', text);
  }
  const underscoreAttribute = parse('_foo = 1\n');
  assert.equal(underscoreAttribute.formationStatus(), 'Recovered');
  assert.ok(hasCode(underscoreAttribute, 'hcl.parse.identifier@1'));
  const underscoreReference = parse('a = _bar\n');
  assert.equal(underscoreReference.formationStatus(), 'Recovered');
  assert.ok(hasCode(underscoreReference, 'hcl.parse.identifier@1'));
});

test('golden hcl.native-formation.unary-compound and operators-precedence', () => {
  // conformance/vectors/hcl-v1.json:226-349 (ids hcl.native-formation.unary-
  // compound and hcl.native-formation.operators-precedence). Unary binds at
  // the term layer: `-1 + 2`, `2 * -1`, `-1 * 2`, `!!x`, `- (1 + 2)`, `-x`
  // form; `+1`, `2 ** 3`, `foo.0`, and `foo::bar()` are Recovered.
  for (const text of [
    'a = -1 + 2\n',
    'a = 2 * -1\n',
    'a = -1 * 2\n',
    'a = !!x\n',
    'a = !true\n',
    'a = - (1 + 2)\n',
    'a = -x\n',
    'a = 1 + 2 * 3\n',
    'a = (1 + 2) * 3\n',
    'a = 2 > 1 && 3 <= 3\n',
    'a = x ? y : z\n',
    'a = -a == b\n',
    'a = (\n  1 +\n  2\n)\n',
    'a = myfunc(1, 2,)\n',
    'a = merge(m1, m2...)\n',
  ]) {
    const document = parse(text);
    assert.equal(document.formationStatus(), 'Complete', text);
  }
  for (const [text, code] of [
    ['a = +1\n', 'hcl.parse.expression@1'],
    ['a = 2 ** 3\n', 'hcl.parse.expression@1'],
    ['a = foo.0\n', 'hcl.parse.expression@1'],
    ['a = foo::bar()\n', 'hcl.parse.invalid-character@1'],
  ] as [string, string][]) {
    const document = parse(text);
    assert.equal(document.formationStatus(), 'Recovered', text);
    assert.ok(hasCode(document, code), text);
  }
});

test('golden hcl.native-formation.constructors, for-expressions, traversals-splats', () => {
  // conformance/vectors/hcl-v1.json:351-385 (ids hcl.native-formation.
  // constructors, for-expressions, traversals-splats; all Complete).
  const sources = [
    'nlsep = [\n  1,\n  2,\n]\nobj = {\n  a = 1\n  b = 2\n}\ndups = { a = 1, a = 2 }\nnumkey = { 1 = "one" }\ncolon = { "k" : 3 }\nforkey = { "for" = 1 }\nparenkey = { (x) = 2 }\n',
    'ftuple = [for x in list : x * 2]\nfobj = {for k, v in map : k => v if v != null}\nfgroup = {for k, v in map : k => v...}\nfcond = [for x in list : x if x > 0]\n',
    'v = foo\nattr = foo.bar\nidx = foo[0]\nsplat1 = foo.*.bar\nsplat2 = foo[*].bar\nchain = foo[0].bar[*].baz\nkwroot = true.bar\nexpridx = foo[1 + 1]\n',
  ];
  for (const source of sources) {
    const document = parse(source);
    assert.equal(document.formationStatus(), 'Complete');
    assert.deepEqual(document.render(), new TextEncoder().encode(source));
  }
});

test('golden hcl.native-formation.source-contract: BOM and lone CR are Recovered; invalid UTF-8 is fatal', () => {
  // conformance/vectors/hcl-v1.json:387-430 (id hcl.native-formation.source-
  // contract; statuses [Recovered, Recovered, Recovered, Complete, Complete,
  // FatalFormationFailure]).
  const bom = parse('\uFEFFa = 1\n');
  assert.equal(bom.formationStatus(), 'Recovered');
  assert.ok(hasCode(bom, 'hcl.parse.byte-order-mark@1'));
  const bomMiddle = parse('a = 1\n\uFEFFb = 2\n');
  assert.equal(bomMiddle.formationStatus(), 'Recovered');
  assert.ok(hasCode(bomMiddle, 'hcl.parse.byte-order-mark@1'));
  const loneCr = parse('a = 1\rb = 2\n');
  assert.equal(loneCr.formationStatus(), 'Recovered');
  assert.ok(hasCode(loneCr, 'hcl.parse.lone-cr@1'));
  for (const text of ['a = 1\r\nb = 2\r\n', 'a = 1\nb = 2\n']) {
    assert.equal(parse(text).formationStatus(), 'Complete', text);
  }
  // The hex sample "61203d20310aff0a" is a = 1 then 0a ff 0a: invalid UTF-8
  // byte 0xff is a fatal formation failure (RFC 0014 §2, §12 D-3).
  const invalid = Uint8Array.from([0x61, 0x20, 0x3d, 0x20, 0x31, 0x0a, 0xff, 0x0a]);
  assert.throws(
    () => parseHcl(invalid, HclProfile.NATIVE_V1, profileDefaultEncoding(), hclParseLimits()),
    (error: unknown) => error instanceof HclFormationFailure && error.code === 'hcl.parse.invalid-utf8@1',
  );
});

test('golden hcl.native-formation.recovery-matrix: deterministic recovery boundaries and proven attributes', () => {
  // conformance/vectors/hcl-v1.json:432-492 (id hcl.native-formation.recovery-
  // matrix; the `a = 1 @ 2\nb = 3\n` sample proves both attributes).
  const cases: [string, string][] = [
    ['a = "abc\n', 'hcl.parse.unterminated-string@1'],
    ['a = <<EOT\ncontent\n', 'hcl.parse.unterminated-heredoc@1'],
    ['a = "${ 1 +"\n', 'hcl.parse.unterminated-interpolation@1'],
    ['a = [1, 2\n', 'hcl.parse.expression@1'],
    ['a = 1 @ 2\nb = 3\n', 'hcl.parse.invalid-character@1'],
    ['a = 1 /* one /* two */ still\n', 'hcl.parse.newline@1'],
    ['a = <<"EOT"\ncontent\nEOT\n', 'hcl.parse.expression@1'],
  ];
  for (const [text, code] of cases) {
    const document = parse(text);
    assert.equal(document.formationStatus(), 'Recovered', text);
    assert.ok(hasCode(document, code), text);
  }
  // The proven_attribute_names expectation for the invalid-character sample.
  const proven = parse('a = 1 @ 2\nb = 3\n');
  const names = proven
    .root()
    .items()
    .filter((item) => 'name' in item)
    .map((item) => (item as { name(): string }).name());
  assert.deepEqual(names, ['a', 'b']);
});

test('golden hcl.native-formation.production-shape: Terraform-shaped fixture forms completely', () => {
  // conformance/vectors/hcl-v1.json:494-504 (id hcl.native-formation.
  // production-shape; expected status Complete, render byte-exact).
  const source =
    'terraform {\n  required_version = ">= 1.5"\n}\n\nvariable "region" {\n  type    = string\n  default = "us-east-1"\n}\n\nlocals {\n  common_tags = {\n    Env = "prod"\n  }\n}\n\nresource "aws_instance" "web" {\n  ami           = "ami-0abcdef1234567890"\n  instance_type = "t3.micro"\n  count         = 2\n  tags          = local.common_tags\n}\n\nmodule "vpc" {\n  source  = "./modules/vpc"\n  cidr    = "10.0.0.0/16"\n  enabled = true\n}\n';
  const document = parse(source);
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.render(), new TextEncoder().encode(source));
});

test('golden hcl.native-formation.empty-body-eof-termination: EOF terminates the last item', () => {
  // conformance/vectors/hcl-v1.json:1649-1682 (id hcl.native-formation.empty-
  // body-eof-termination; RFC 0014 §12 D-9).
  for (const text of ['', 'a = 1', 'b {\n}\n', 'oneline { y = 2 }']) {
    const document = parse(text);
    assert.equal(document.formationStatus(), 'Complete', JSON.stringify(text));
    assert.deepEqual(document.diagnostics(), [], JSON.stringify(text));
  }
});

test('golden hcl.native-formation.leading-digit-rejection and invalid-escapes', () => {
  // conformance/vectors/hcl-v1.json:1684-1737 (ids hcl.native-formation.
  // leading-digit-rejection and hcl.native-formation.invalid-escapes).
  assert.ok(hasCode(parse('1abc = 1\n'), 'hcl.parse.invalid-number@1'));
  assert.ok(hasCode(parse('a = 1abc\n'), 'hcl.parse.expression@1'));
  for (const text of ['a = "bad \\q"\n', 'a = "\\u12"\n', 'a = "\\U00110000"\n']) {
    const document = parse(text);
    assert.equal(document.formationStatus(), 'Recovered', text);
    assert.ok(hasCode(document, 'hcl.parse.invalid-escape@1'), text);
  }
});

test('golden hcl.native-formation.directive-strip-markers and for-key-ambiguity', () => {
  // conformance/vectors/hcl-v1.json:1739-1779 (ids hcl.native-formation.
  // directive-strip-markers and hcl.native-formation.for-key-ambiguity).
  const strips = parse('a = "%{~ if x ~}yes%{ endif }"\nb = "%{ for k, v in m ~}${k}%{ endfor }"\n');
  assert.equal(strips.formationStatus(), 'Complete');
  const bareFor = parse('a = { for = 1 }\n');
  assert.equal(bareFor.formationStatus(), 'Recovered');
  assert.ok(hasCode(bareFor, 'hcl.parse.expression@1'));
  for (const text of ['a = { (for) = 1 }\n', 'a = { "for" = 1 }\n']) {
    assert.equal(parse(text).formationStatus(), 'Complete', text);
  }
});

// ---------------------------------------------------------------------------
// hcl.tfvars@1 dialect coverage
// ---------------------------------------------------------------------------

test('golden hcl.tfvars-formation.attributes-only: tfvars renders byte-exact', () => {
  // conformance/vectors/hcl-v1.json:506-516 (id hcl.tfvars-formation.
  // attributes-only; capability hcl.tfvars-formation@1).
  const source = 'region = "us-east-1"\ncount = 3\nratio = 0.5\nenabled = true\ntags = ["a", "b"]\nlabels = {\n  env = "prod"\n}\n';
  const document = parse(source, HclProfile.TFVARS_V1);
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.render(), new TextEncoder().encode(source));
  assert.equal(document.profile().toString(), 'hcl.tfvars@1');
});

test('golden hcl.tfvars-formation.block-rejected: a top-level block makes tfvars Recovered', () => {
  // conformance/vectors/hcl-v1.json:518-528 (id hcl.tfvars-formation.block-
  // rejected; diagnostic hcl.tfvars.block-not-allowed@1).
  const document = parse('region = "us-east-1"\nblock "x" {\n  a = 1\n}\n', HclProfile.TFVARS_V1);
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(hasCode(document, 'hcl.tfvars.block-not-allowed@1'));
  // The rejected block remains a native item of the Recovered document.
  assert.equal(document.root().items().filter((item) => 'type' in item).length, 1);
});

test('golden hcl.tfvars-formation.expression-grammar-full: the full expression grammar inside values', () => {
  // conformance/vectors/hcl-v1.json:530-540 (id hcl.tfvars-formation.
  // expression-grammar-full; Terraform\'s static-only rule is application
  // behavior, never a formation fact — RFC 0014 §5).
  const source = 'computed = max(1, 2)\nref = var.other\njoined = "prefix-${var.suffix}"\n';
  const document = parse(source, HclProfile.TFVARS_V1);
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.render(), new TextEncoder().encode(source));
});

test('golden hcl.tfvars-formation.duplicate-attribute: the tfvars profile keeps the per-body rule', () => {
  // conformance/vectors/hcl-v1.json:542-552 (id hcl.tfvars-formation.
  // duplicate-attribute; diagnostic hcl.parse.duplicate-attribute@1).
  const document = parse('a = 1\na = 2\n', HclProfile.TFVARS_V1);
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(hasCode(document, 'hcl.parse.duplicate-attribute@1'));
});

test('golden hcl.tfvars-formation.production-shape: a Terraform-shaped terraform.tfvars fixture', () => {
  // conformance/vectors/hcl-v1.json:554-564 (id hcl.tfvars-formation.
  // production-shape).
  const source =
    '# Production-shaped terraform.tfvars fixture\nregion = "us-east-1"\ninstance_type = "t3.micro"\nami = "ami-0abcdef1234567890"\ncount = 2\nmonitoring = true\ntags = {\n  Name = "web-server"\n  Env  = "prod"\n}\nsecurity_groups = [\n  "sg-0123456789abcdef0",\n  "sg-1123456789abcdef0",\n]\nlaunch_template = {\n  id      = "lt-0123456789abcdef0"\n  version = 1\n}\n';
  const document = parse(source, HclProfile.TFVARS_V1);
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.render(), new TextEncoder().encode(source));
});

// ---------------------------------------------------------------------------
// The no-evaluation gate (RFC 0014 §1, hard gate 1; SECURITY.md:36)
// ---------------------------------------------------------------------------

test('no-evaluation: parse/query/project/edit never evaluate anything', () => {
  // RFC 0014 §1 (:45-54) and §14: variables, function calls, template
  // interpolation, directives, and for-expressions are native content with
  // exact source identity; no evaluator exists anywhere. The native model
  // carries syntax facts only: the exact source text of every derived
  // expression is the span-derived spelling, never a computed value.
  const source = 'joined = "prefix-${var.suffix}"\ncomputed = max(1, 2)\nref = var.other\nitems = [for x in list : x]\n';
  const document = parse(source);
  assert.equal(document.formationStatus(), 'Complete');
  const attributes = document.root().items().filter((item) => 'name' in item) as { name(): string; expression(): { text(): string } }[];
  const byName = new Map(attributes.map((attribute) => [attribute.name(), attribute]));
  // The interpolation template keeps its exact source text.
  assert.equal(byName.get('joined')!.expression().text(), '"prefix-${var.suffix}"');
  // Function calls and variable references keep their exact spellings.
  assert.equal(byName.get('computed')!.expression().text(), 'max(1, 2)');
  assert.equal(byName.get('ref')!.expression().text(), 'var.other');
  // For-expressions keep their source shape.
  assert.equal(byName.get('items')!.expression().text(), '[for x in list : x]');
});

test('expression syntax-only: `hcl.expression@1` carries only syntax facts', () => {
  // RFC 0014 §8.2: hcl.expression@1 carries the expression kind, its exact
  // source text, and its structural fingerprint — syntax facts only. The
  // fingerprint of `1 + 2` and `2 + 1` differ (operator order is a syntax
  // fact), while `1.50` and `1.5` fingerprint identically (number equality
  // is canonical-decimal equality, RFC 0014 §6).
  const document = parse('a = 1 + 2\nb = 2 + 1\nc = 1.50\nd = 1.5\n');
  const attributes = document.root().items().filter((item) => 'name' in item) as { name(): string; expression(): { node(): HclExpr } }[];
  const byName = new Map(attributes.map((attribute) => [attribute.name(), attribute]));
  const a = byName.get('a')!.expression().node();
  const b = byName.get('b')!.expression().node();
  const c = byName.get('c')!.expression().node();
  const d = byName.get('d')!.expression().node();
  assert.notEqual(expressionFingerprint(a).toString(), expressionFingerprint(b).toString());
  assert.equal(expressionFingerprint(c).toString(), expressionFingerprint(d).toString());
});

// ---------------------------------------------------------------------------
// hcl.limit@1 (fatal formation failures, hcl-v1.json:1781-1970)
// ---------------------------------------------------------------------------

test('golden hcl.limit.expression-depth: deep parens and binary chains are fatal', () => {
  // conformance/vectors/hcl-v1.json:1781-1809 (ids hcl.limit.expression-depth
  // and hcl.limit.binary-chain-depth; limits max_expression_depth 3).
  expectFatal('a = (((1)))\n', 'hcl.limit.expression-depth@1', { maxExpressionDepth: 3 });
  expectFatal('a = 1 + 1 + 1 + 1 + 1\n', 'hcl.limit.expression-depth@1', { maxExpressionDepth: 3 });
});

test('golden hcl.limit.body-nesting: deep blocks are fatal', () => {
  // conformance/vectors/hcl-v1.json:1811-1824 (id hcl.limit.body-nesting;
  // limits max_body_depth 2).
  expectFatal('a = 1\nb {\nc {\nd = 1\n}\n}\n', 'hcl.limit.body-depth@1', { maxBodyDepth: 2 });
});

test('golden hcl.limit.number-digits: exponent folding is bounded before any padding', () => {
  // conformance/vectors/hcl-v1.json:1826-1851 (ids hcl.limit.number-digits
  // and hcl.limit.arithmetic-overflow; limits max_number_digits 5).
  expectFatal('a = 1e10\n', 'hcl.limit.number-digits@1', { maxNumberDigits: 5 });
  expectFatal('a = 1e99999999999999999999\n', 'hcl.limit.number-digits@1', { maxNumberDigits: 5 });
});

test('golden hcl.limit.attribute-count, block-count, body-item-count, label-count', () => {
  // conformance/vectors/hcl-v1.json:1853-1911 (ids hcl.limit.attribute-count,
  // hcl.limit.block-count, hcl.limit.body-item-count, hcl.limit.label-count).
  expectFatal('a = 1\nb = 2\nc = 3\n', 'hcl.limit.attribute-count@1', { maxAttributeCount: 2 });
  expectFatal('a {\n}\nb {\n}\n', 'hcl.limit.block-count@1', { maxBlockCount: 1 });
  expectFatal('a = 1\nb = 2\nc = 3\n', 'hcl.limit.body-item-count@1', { maxBodyItemCount: 2 });
  expectFatal('b "x" "y" {\n}\n', 'hcl.limit.label-count@1', { maxLabelCount: 1 });
});

test('golden hcl.limit.template-len, heredoc-bytes, tuple-elements, object-entries', () => {
  // conformance/vectors/hcl-v1.json:1913-1971 (ids hcl.limit.template-size,
  // hcl.limit.heredoc-size, hcl.limit.tuple-elements, hcl.limit.object-entries).
  expectFatal('a = "xxxxxxxxxxxxxxxxxxxxxxxxxx"\n', 'hcl.limit.template-len@1', { maxTemplateLen: 8 });
  expectFatal('h = <<E\none\ntwo\nthree\nE\n', 'hcl.limit.heredoc-bytes@1', { maxHeredocBytes: 12 });
  expectFatal('a = [1, 2, 3]\n', 'hcl.limit.tuple-elements@1', { maxTupleElements: 2 });
  expectFatal('a = {x = 1, y = 2, z = 3}\n', 'hcl.limit.object-entries@1', { maxObjectEntries: 2 });
});

test('fatal formation failures never masquerade as Recovered documents', () => {
  // RFC 0014 §11, hard gate 4: a limit failure is a fatal formation
  // failure, never an empty body, truncated expression, or partial target.
  expectFatal('a = (((1)))\n', 'hcl.limit.expression-depth@1', { maxExpressionDepth: 1 });
});
