/**
 * Fixture round-trip gate: the production-shaped fixtures under
 * conformance/fixtures (the single-authority tree provisioned from the
 * consema spec repository in CI) must close byte-exactly — parse -> render
 * reproduces the source bytes, formation is Complete, and a reparse of the
 * rendered bytes is byte-stable. The adversarial fixtures pin the
 * transport facts:
 *
 * - ini/windows-cp1252.ini.hex — explicit Windows-1252 bytes under the
 *   Windows profile with an explicit code page (no encoding guess);
 * - ini/legacy-mixed-newline.ini.hex — deliberately mixed LF/CRLF;
 * - properties/utf16-edge.properties — a supplementary scalar and legal
 *   unpaired Java UTF-16 code units through `\uXXXX` escapes (RFC 0010 §4);
 * - properties/latin1-resource.properties.hex — non-UTF-8 Latin-1 bytes;
 * - yaml/*.yaml — the real-project fixtures (kubernetes-workload with two
 *   documents, anchor-heavy with five aliases).
 *
 * Facts (counts) mirror consema-rs/consema-conformance/tests/
 * line_format_fixtures.rs:48-179 and yaml_fixtures.rs:22-51. G68
 * (2026-08-14): a missing fixture is a FAILURE, never a silent skip — the
 * inventory test below asserts the full expected fixture set, and the
 * per-fixture tests throw when their file is absent (a partially
 * provisioned tree must not go green). Fixtures are read-only; tests never
 * modify them.
 */

/** The fixture inventory the gate requires (missing = failure, G68). */
const EXPECTED_FIXTURES: readonly string[] = Object.freeze([
  'ini/windows-cp1252.ini.hex',
  'ini/legacy-mixed-newline.ini.hex',
  'properties/utf16-edge.properties',
  'properties/latin1-resource.properties.hex',
  'yaml/kubernetes-workload.yaml',
  'yaml/github-actions-ci.yaml',
  'yaml/compose-services.yaml',
  'yaml/anchor-heavy.yaml',
]);

test('fixtures: the expected fixture inventory is provisioned (missing = fail, never skip)', () => {
  const missing = EXPECTED_FIXTURES.filter((name) => !available(name));
  assert.deepEqual(missing, [], `missing shared fixtures: ${missing.join(', ')}`);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fixturesDir } from './runner.ts';
import { toHex } from './helpers.ts';
import { parseIniDocument } from '../ini/document.ts';
import {
  IniProfile,
  DEFAULT_INI_PARSE_LIMITS,
  profileDefaultSelection,
} from '../ini/profile.ts';
import { windowsCodePageEncoding, WindowsCodePage, utf8Encoding } from '../document/source.ts';
import { parseReader, parseLatin1 } from '../properties/parser.ts';
import { DEFAULT_PROPERTIES_PARSE_LIMITS } from '../properties/parse_limits.ts';
import { parse as parseYaml } from '../yaml/parser.ts';
import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';

const FIXTURES = fixturesDir();

function fixtureBytes(name: string): Uint8Array {
  // The .hex files are canonical lowercase-hex byte containers
  // (fixtures/*/README.md); the gate decodes them before parsing.
  const path = `${FIXTURES}${name}`;
  if (!existsSync(path)) {
    throw new Error(`shared fixture not available: ${name}`);
  }
  const raw = readFileSync(path);
  if (name.endsWith('.hex')) {
    const digits = new TextDecoder('utf-8').decode(raw).replace(/\s+/g, '');
    const bytes = new Uint8Array(digits.length / 2);
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }
  return new Uint8Array(raw);
}

function available(name: string): boolean {
  return existsSync(`${FIXTURES}${name}`);
}

function assertByteStableRoundTrip(name: string, parse: (bytes: Uint8Array) => { render(): Uint8Array; formationStatus(): string }) {
  const source = fixtureBytes(name);
  const document = parse(source);
  assert.equal(document.formationStatus(), 'Complete', `${name}: formation must be Complete`);
  const rendered = document.render();
  assert.equal(toHex(rendered), toHex(source), `${name}: parse -> render must be byte-exact`);
  const reparsed = parse(rendered);
  assert.equal(reparsed.formationStatus(), 'Complete', `${name}: reparse must be Complete`);
  assert.equal(toHex(reparsed.render()), toHex(source), `${name}: reparse -> render must be byte-stable`);
}

// ---------------------------------------------------------------------------
// INI fixtures
// ---------------------------------------------------------------------------

const INI_FIXTURES: Record<string, { profile: IniProfile; explicitCp1252: boolean; sections: number; entries: number }> = {
  'ini/windows-cp1252.ini.hex': { profile: IniProfile.WINDOWS_V1, explicitCp1252: true, sections: 1, entries: 3 },
  'ini/legacy-mixed-newline.ini.hex': { profile: IniProfile.PORTABLE_V1, explicitCp1252: false, sections: 2, entries: 3 },
};

for (const [name, facts] of Object.entries(INI_FIXTURES)) {
  test(`fixtures: ini ${name} round-trips byte-exactly`, () => {
    const parse = (bytes: Uint8Array) => {
      const selection = facts.explicitCp1252
        ? { kind: 'Explicit' as const, encoding: windowsCodePageEncoding(WindowsCodePage.fromNumber(1252)!) }
        : profileDefaultSelection();
      return parseIniDocument(bytes, facts.profile, selection, DEFAULT_INI_PARSE_LIMITS);
    };
    assertByteStableRoundTrip(name, parse);
    const document = parse(fixtureBytes(name));
    assert.equal(document.sections().length, facts.sections, `${name}: section count`);
    assert.equal(document.entries().length, facts.entries, `${name}: entry count`);
  });
}

test('fixtures: ini windows-cp1252 keeps its declared transport facts', () => {
  const source = fixtureBytes('ini/windows-cp1252.ini.hex');
  // "Montréal" (é = 0xe9) and "€" (0x80) are not valid UTF-8.
  assert.ok(source.includes(0xe9), 'windows-cp1252.ini.hex must contain the é byte');
  assert.ok(source.includes(0x80), 'windows-cp1252.ini.hex must contain the € byte');
  const document = parseIniDocument(
    source,
    IniProfile.WINDOWS_V1,
    { kind: 'Explicit', encoding: windowsCodePageEncoding(WindowsCodePage.fromNumber(1252)!) },
    DEFAULT_INI_PARSE_LIMITS,
  );
  const values = document.entries().map((entry) => entry.value());
  assert.equal(values[0], 'Montréal', 'the explicit code page decodes é');
  assert.equal(values[1], '€', 'the explicit code page decodes €');
});

// ---------------------------------------------------------------------------
// Java Properties fixtures
// ---------------------------------------------------------------------------

const PROPERTIES_FIXTURES: Record<string, { latin1: boolean; properties: number }> = {
  'properties/utf16-edge.properties': { latin1: false, properties: 3 },
  'properties/latin1-resource.properties.hex': { latin1: true, properties: 3 },
};

for (const [name, facts] of Object.entries(PROPERTIES_FIXTURES)) {
  test(`fixtures: properties ${name} round-trips byte-exactly`, () => {
    const parse = (bytes: Uint8Array) =>
      facts.latin1 ? parseLatin1(bytes, DEFAULT_PROPERTIES_PARSE_LIMITS) : parseReader(bytes, utf8Encoding(), DEFAULT_PROPERTIES_PARSE_LIMITS);
    assertByteStableRoundTrip(name, parse);
    const document = parse(fixtureBytes(name));
    assert.equal(document.properties().length, facts.properties, `${name}: property count`);
  });
}

test('fixtures: properties utf16-edge keeps exact Java units', () => {
  const document = parseReader(fixtureBytes('properties/utf16-edge.properties'), utf8Encoding(), DEFAULT_PROPERTIES_PARSE_LIMITS);
  const byKey = new Map(document.properties().map((property) => [property.key().toUnicode(), property.value()]));
  assert.deepEqual([...byKey.keys()], ['rocket', 'unpaired.high', 'unpaired.low']);
  assert.equal(byKey.get('rocket')!.toUnicode(), '\u{1F680}', 'the supplementary scalar decodes exactly');
  assert.equal(byKey.get('unpaired.high')!.status(), 'UnpairedSurrogate', 'high surrogate stays unpaired');
  assert.equal(byKey.get('unpaired.low')!.status(), 'UnpairedSurrogate', 'low surrogate stays unpaired');
});

test('fixtures: properties latin1-resource decodes Latin-1, not accidental UTF-8', () => {
  const source = fixtureBytes('properties/latin1-resource.properties.hex');
  assert.ok(source.includes(0xe9), 'latin1-resource must contain the é byte');
  assert.ok(source.includes(0xa3), 'latin1-resource must contain the £ byte');
  assert.ok(source.includes(0xef), 'latin1-resource must contain the ï byte');
  const document = parseLatin1(source, DEFAULT_PROPERTIES_PARSE_LIMITS);
  const byKey = new Map(document.properties().map((property) => [property.key().toUnicode(), property.value().toUnicode()]));
  assert.deepEqual(Object.fromEntries(byKey), { title: 'café', currency: '£', author: 'naïve' });
});

// ---------------------------------------------------------------------------
// YAML fixtures
// ---------------------------------------------------------------------------

const YAML_FIXTURES: Record<string, { documents: number; aliases: number }> = {
  'yaml/kubernetes-workload.yaml': { documents: 2, aliases: 0 },
  'yaml/github-actions-ci.yaml': { documents: 1, aliases: 0 },
  'yaml/compose-services.yaml': { documents: 1, aliases: 0 },
  'yaml/anchor-heavy.yaml': { documents: 1, aliases: 5 },
};

for (const [name, facts] of Object.entries(YAML_FIXTURES)) {
  test(`fixtures: yaml ${name} round-trips byte-exactly`, () => {
    const parse = (bytes: Uint8Array) => parseYaml(bytes, 'Yaml12CoreV1', DEFAULT_PARSE_LIMITS);
    assertByteStableRoundTrip(name, parse);
    const document = parse(fixtureBytes(name));
    assert.equal(document.documentCount(), facts.documents, `${name}: document count`);
    assert.equal(document.aliasCount(), facts.aliases, `${name}: alias count`);
  });
}
