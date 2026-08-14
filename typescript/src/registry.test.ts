/**
 * L4 root facade tests (mirror of consema-rs/consema/src/lib.rs tests).
 *
 * authority: https://github.com/consema/consema-rs/blob/main/consema/src/lib.rs
 * —— registry 测试与 facade 测试，行号可能漂移，以符号名为锚; the frozen
 * inventory of RFC 0015 §6.2 and
 * https://github.com/consema/consema/blob/main/docs/fc-manifest-0.13.0.json —
 * 键 capability_set（8 families / 16 profiles / 21 query domains / 16
 * operation registries）.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Document,
  FormatMismatch,
  formatFamilies,
  formatOperationRegistry,
  parseDocument,
  profiles,
  queryDomains,
} from './registry.ts';
import { ProfileId } from './document/profile.ts';
import { parse as parseJson } from './json/parser.ts';
import { parseToml } from './toml/document.ts';
import { convertJson, convertToml, convertYaml } from './convert.ts';
import { TomlProfile } from './toml/profile.ts';
import { tomlFormatOperationRegistry } from './toml/operation_registry.ts';
import {
  MaterializationRequest,
  MaterializationStyleId,
} from './document/materialization.ts';
import { ProjectionRequestBuilder } from './json/projection.ts';
import { TomlProjectionRequest } from './toml/projection.ts';
import { ValueProjectionRequest } from './yaml/projection.ts';
import { parse as parseYaml } from './yaml/parser.ts';
import { convertHcl } from './convert.ts';
import { parseHcl, profileDefaultEncoding } from './hcl/document.ts';
import { HclProfile } from './hcl/profile.ts';
import { hclParseLimits } from './hcl/limits.ts';
import { HclProjectionRequest } from './hcl/projection.ts';

const SMALL_LIMITS = {
  maxSourceBytes: 1_000_000,
  maxTokenCount: 1_000_000,
  maxNodeCount: 1_000_000,
  maxNestingDepth: 64,
  maxDiagnostics: 100,
};

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** A minimal valid `plist.binary@1` snapshot: one ASCII string "x" (RFC 0013 §5). */
function binaryPlistBytes(): Uint8Array {
  return hexBytes(
    '62706c6973743030' + // bplist00
      '5f7808' + // ASCII string object with extended length ("x")
      '0000000000000101' + // trailer: unused + sort version, sizes 1/1
      '0000000000000001' + // numObjects = 1
      '0000000000000000' + // topObject = 0
      '000000000000000a', // offsetTableOffset = 10
  );
}

test('registry lists eight families sorted by id', () => {
  const families = formatFamilies();
  assert.equal(families.length, 8);
  for (let i = 1; i < families.length; i++) {
    assert.ok(families[i - 1].id() < families[i].id(), 'families sorted by id');
  }
});

test('registry lists sixteen profiles with the frozen inventory', () => {
  const list = profiles();
  assert.equal(list.length, 16);
  const expected = [
    'hcl.native',
    'hcl.tfvars',
    'ini.portable',
    'ini.python-configparser',
    'ini.windows',
    'java-properties.latin1',
    'java-properties.reader',
    'json.strict',
    'json5.standard',
    'jsonc.bounded',
    'plist.binary',
    'plist.xml',
    'toml.1.0',
    'xml.1.0-safe',
    'yaml.1.1-compat',
    'yaml.1.2-core',
  ];
  assert.deepEqual(
    list.map((entry) => entry.profile().id()),
    expected,
    'profile inventory',
  );
  for (const entry of list) {
    assert.ok(
      formatOperationRegistry(entry.profile()) !== undefined,
      `${entry.profile().id()} must resolve an operation registry`,
    );
  }
});

test('registry query domains are sorted and unique (21)', () => {
  const domains = queryDomains();
  assert.equal(domains.length, 21);
  for (let i = 1; i < domains.length; i++) {
    const left = domains[i - 1];
    const right = domains[i];
    assert.ok(
      left.id < right.id || (left.id === right.id && left.version < right.version),
      'domains sorted by (id, version)',
    );
  }
  const ids = domains.map((domain) => `${domain.id}@${domain.version}`);
  assert.ok(ids.includes('core.portable-value-query@1'));
  assert.ok(ids.includes('hcl.native-semantic-query@1'));
  assert.ok(ids.includes('plist.binary-structure-query@1'));
});

test('parseDocument round trips every profile', () => {
  const cases: [string, Uint8Array][] = [
    ['ini.portable', utf8('[section]\nvalue=1\n')],
    ['ini.windows', utf8('[section]\nvalue=1\r\n')],
    ['ini.python-configparser', utf8('[section]\nvalue=1\n')],
    ['java-properties.reader', utf8('name=api\n')],
    ['java-properties.latin1', utf8('name=api\n')],
    ['json.strict', utf8('{"a":1}')],
    ['jsonc.bounded', utf8('{"a":1,}')],
    ['json5.standard', utf8('{a:1,}')],
    ['toml.1.0', utf8('value = 1\n')],
    ['yaml.1.2-core', utf8('value: 1\n')],
    ['yaml.1.1-compat', utf8('value: 1\n')],
    ['xml.1.0-safe', utf8('<service><name>catalog</name></service>')],
    ['plist.xml', utf8('<plist version="1.0"><string>x</string></plist>')],
    ['plist.binary', binaryPlistBytes()],
    ['hcl.native', utf8('a = 1\n')],
    ['hcl.tfvars', utf8('a = 1\n')],
  ];
  for (const [id, bytes] of cases) {
    const document = parseDocument(bytes, new ProfileId(id, 1));
    assert.equal(document.profile().id(), id, `${id} profile round trip`);
  }
  assert.throws(
    () => parseDocument(utf8('x'), new ProfileId('example.unknown', 1)),
    (error: unknown) => {
      // W4-15 (R1): an unknown profile id fails with the frozen
      // core.materialization.unsupported-profile@1 (the requested profile
      // is unavailable), not the encoding-facts-conflict code.
      const failure = error as { diagnostics?: () => readonly { code: string }[] };
      return failure.diagnostics?.()[0]?.code === 'core.materialization.unsupported-profile@1';
    },
    'unknown profile id fails with the unsupported-profile code',
  );
});

test('common document facade is opaque and typed', () => {
  const json = Document.parseJson(utf8('{"a":1}'), 'JsonStrict', SMALL_LIMITS);
  assert.deepEqual(json.render(), utf8('{"a":1}'));
  assert.equal(json.formationStatus(), 'Complete');
  assert.notEqual(json.asJson(), FormatMismatch.Json);
  assert.equal(json.asToml(), FormatMismatch.Toml);
  assert.equal(json.asIni(), FormatMismatch.Ini);

  const toml = Document.parseToml(utf8('value = 1'), TomlProfile.TOML_10_V1, SMALL_LIMITS);
  assert.deepEqual(toml.render(), utf8('value = 1'));
  assert.equal(toml.asJson(), FormatMismatch.Json);
  assert.equal(toml.profile().id(), 'toml.1.0');
  assert.equal(toml.asToml() instanceof Object, true);
});

test('convertJson to TOML composes both stages with an exact report', () => {
  const source = parseJson(utf8('{"service":{"port":8080,"enabled":true}}'), 'JsonStrict', SMALL_LIMITS);
  const projection = new ProjectionRequestBuilder('BestExactCoreV1').build();
  const request = new MaterializationRequest(
    new ProfileId('toml.1.0', 1),
    new MaterializationStyleId('toml.canonical-document', 1),
  )
    .withNewline('Lf')
    .withMappingPolicy('UniqueStringEntriesToObject');
  const result = convertJson(source, projection, request);
  assert.equal(result.kind, 'Complete');
  const complete = result.value;
  assert.deepEqual(
    complete.document().render(),
    utf8('"service" = { "port" = 8080, "enabled" = true }\n'),
  );
  assert.equal(complete.report().overallFidelity(), 'Exact');
  assert.equal(complete.report().sourceProfile().id(), 'json.strict');
  assert.equal(complete.report().targetProfile().id(), 'toml.1.0');
});

function hclSource(text: string) {
  return parseHcl(utf8(text), HclProfile.NATIVE_V1, profileDefaultEncoding(), hclParseLimits());
}

function hclConversionRequest() {
  return new MaterializationRequest(
    new ProfileId('hcl.native', 1),
    new MaterializationStyleId('hcl.canonical-document', 1),
  ).withNewline('Lf');
}

test('W4-17/R42: convertHcl converts a decimal by single-round rounding (7.038531e-26)', () => {
  // The HCL body projection carries decimals through the record conversion
  // (portableToHclRecord); the old two-step conversion double-rounded
  // 7038531e-32 to 7.038530999999999e-26 (1 ULP off). The single-pass
  // conversion must spell the correctly-rounded 7.038531e-26.
  const result = convertHcl(hclSource('ratio = 7.038531e-26\n'), new HclProjectionRequest(), hclConversionRequest());
  assert.equal(result.kind, 'Complete');
  const rendered = new TextDecoder('utf-8').decode(result.value.document().render());
  assert.ok(rendered.includes('0.00000000000000000000000007038531'), `spelling ${JSON.stringify(rendered)}`);
  assert.ok(!rendered.includes('7.038530999999999'), 'the double-rounded spelling must not appear');
});

test('W4-17/R42: convertHcl refuses decimals the double cannot represent', () => {
  // |exponent| > 308 and a coefficient outside the safe-integer range fail
  // atomically (Unrepresentable) instead of silently rounding.
  for (const source of ['a = 1e-1000\n', 'a = 9007199254740992.5\n', 'a = 100000000000000000.5\n']) {
    const result = convertHcl(hclSource(source), new HclProjectionRequest(), hclConversionRequest());
    assert.equal(result.kind, 'Failed', `${source.trim()} must fail atomically`);
    assert.equal(result.value.kind, 'MaterializationFailed', `${source.trim()} failure class`);
    assert.equal(result.value.materialization?.kind, 'Unrepresentable', `${source.trim()} failure kind`);
  }
});

test('convertToml to JSON is exact', () => {
  assert.equal(tomlFormatOperationRegistry(TomlProfile.TOML_10_V1).operations().length, 7);
  const source = parseToml(utf8('name = "api"\nports = [80, 443]\n'), TomlProfile.TOML_10_V1, SMALL_LIMITS);
  const request = new MaterializationRequest(
    new ProfileId('json.strict', 1),
    new MaterializationStyleId('json.canonical-compact', 1),
  ).withNewline('None');
  const result = convertToml(source, tomlProjectionRequest(), request);
  assert.equal(result.kind, 'Complete');
  assert.deepEqual(result.value.document().render(), utf8('{"name":"api","ports":[80,443]}'));
  assert.equal(result.value.report().overallFidelity(), 'Exact');
});

test('convertYaml to JSON is exact through the facade', () => {
  const source = parseYaml(utf8('name: api\nports: [80, 443]\n'), 'Yaml12CoreV1', SMALL_LIMITS);
  const request = new MaterializationRequest(
    new ProfileId('json.strict', 1),
    new MaterializationStyleId('json.canonical-compact', 1),
  ).withNewline('None');
  const result = convertYaml(source, ValueProjectionRequest.bestExactV1(), request);
  assert.equal(result.kind, 'Complete');
  assert.deepEqual(
    result.value.document().render(),
    utf8('{"name":"api","ports":[80,443]}'),
  );
});

function tomlProjectionRequest(): TomlProjectionRequest {
  return new TomlProjectionRequest('BestExactCoreV1', {
    maxValueNodes: 1_000_000,
    maxReportEntries: 100_000,
    maxProvenanceEntries: 2_000_000,
    maxDepth: 256,
  });
}
