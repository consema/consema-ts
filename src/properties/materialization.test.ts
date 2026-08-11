/**
 * Intent documents for Java Properties materialization.
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id:
 *  - conformance/vectors/java-properties-v1.json:
 *    materialization.canonical-styles-encodings-and-closure (:91-99),
 *    materialization.atomic-failures-and-limits (:101-104)
 *  - RFC 0010 §12 (:351-381) freezes the canonical styles
 *  - RFC 0004 §3/§7/§8 for the common request/result contracts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_PROPERTIES_PARSE_LIMITS } from '../properties/parse_limits.ts';
import { materialize } from '../properties/materialization.ts';
import { parseReader } from '../properties/parser.ts';
import { project, ProjectionRequest } from '../properties/projection.ts';
import { MaterializationRequest, MaterializationStyleId } from '../document/materialization.ts';
import { ProfileId } from '../document/profile.ts';
import {
  latin1Encoding,
  utf8Encoding,
  utf16BeEncoding,
  windowsCodePageEncoding,
  WindowsCodePage,
} from '../document/source.ts';
import { entryMappingValue, stringValue } from '../core/value.ts';
import type { PortableValue } from '../core/value.ts';

function mapping(entries: readonly (readonly [string, string])[]): PortableValue {
  return entryMappingValue(
    entries.map(([key, value]) => ({ key: stringValue(key), value: stringValue(value) })),
  );
}

function readerRequest(): MaterializationRequest {
  return new MaterializationRequest(
    new ProfileId('java-properties.reader', 1),
    new MaterializationStyleId('java-properties.reader-canonical', 1),
  );
}

function latin1Request(): MaterializationRequest {
  return new MaterializationRequest(
    new ProfileId('java-properties.latin1', 1),
    new MaterializationStyleId('java-properties.latin1-canonical', 1),
  ).withEncoding(latin1Encoding());
}

function render(document: { render(): Uint8Array }): string {
  return new TextDecoder().decode(document.render());
}

function hex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, '0');
  }
  return output;
}

test('materialization.canonical-styles-encodings-and-closure: golden bytes (java-properties-v1.json:91-99)', () => {
  // Reader canonical: escaped key spaces/#, leading value spaces, :=!\\,
  // named tab,  for backspace, direct 值.
  const reader = materialize(mapping([[' a#', '  v:=!\\\t\b值']]), readerRequest());
  assert.equal(reader.kind, 'Complete');
  if (reader.kind !== 'Complete') return;
  assert.equal(render(reader.value.document()), '\\ a\\#=\\ \\ v\\:\\=\\!\\\\\\t\\u0008值\n');
  assert.equal(reader.value.fidelity(), 'Exact');

  // Latin-1 canonical: surrogate-pair escapes, \uXXXX above U+007E, CRLF.
  const latin = materialize(
    mapping([['emoji😀', 'café']]),
    latin1Request().withNewline('CrLf'),
  );
  assert.equal(latin.kind, 'Complete');
  if (latin.kind !== 'Complete') return;
  assert.equal(render(latin.value.document()), 'emoji\\uD83D\\uDE00=caf\\u00E9\\u007F\r\n');
  assert.equal(latin.value.document().source().encodingFacts().selected().kind, 'Latin1');
  assert.equal(latin.value.document().source().encodingFacts().bom(), null);

  // UTF-16BE Reader: BOM prefix, decoded text closes exactly.
  const utf16 = materialize(
    mapping([['名', '值']]),
    readerRequest().withEncoding(utf16BeEncoding()).withNewline('CrLf'),
  );
  assert.equal(utf16.kind, 'Complete');
  if (utf16.kind !== 'Complete') return;
  assert.deepEqual(Array.from(utf16.value.document().render().slice(0, 2)), [0xfe, 0xff]);
  // The vector expectation carries the leading BOM character (vector file :98).
  assert.equal(utf16.value.document().source().decodedText(), '\uFEFF' + '名=值\r\n');
  assert.equal(utf16.value.document().source().encodingFacts().selected().kind, 'Utf16Be');

  // cp1252 Reader: é encodes as 0xE9.
  const cp = materialize(
    mapping([['name', 'café']]),
    readerRequest().withEncoding(windowsCodePageEncoding(WindowsCodePage.fromNumber(1252)!)),
  );
  assert.equal(cp.kind, 'Complete');
  if (cp.kind !== 'Complete') return;
  assert.equal(hex(cp.value.document().render()), '6e616d653d636166e90a');

  // Closure: every result reprojects to the exact input (RFC 0010 §12).
  const inputs = [
    mapping([[' a#', '  v:=!\\\t\b值']]),
    mapping([['emoji😀', 'café']]),
    mapping([['名', '值']]),
    mapping([['name', 'café']]),
  ];
  const results = [reader, latin, utf16, cp];
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    assert.equal(result.kind, 'Complete');
    if (result.kind !== 'Complete') continue;
    const projected = project(result.value.document(), ProjectionRequest.bestExactEntryMapping());
    assert.equal(projected.kind, 'Complete');
    if (projected.kind !== 'Complete') continue;
    assert.deepEqual(projected.value.value(), inputs[index]);
  }
});

test('materialization.atomic-failures-and-limits: exact failure codes (java-properties-v1.json:101-104)', () => {
  // A scalar input cannot become a flat mapping.
  const scalar = materialize(stringValue('scalar'), readerRequest());
  assert.equal(scalar.kind, 'Failed');
  if (scalar.kind === 'Failed') {
    assert.equal(scalar.value.failure().code, 'core.materialization.unrepresentable@1');
  }

  const value = mapping([['key', 'value']]);
  const encodingFailure = materialize(
    value,
    latin1Request().withEncoding(utf8Encoding()),
  );
  assert.equal(encodingFailure.kind, 'Failed');
  if (encodingFailure.kind === 'Failed') {
    assert.equal(encodingFailure.value.failure().code, 'core.materialization.unsupported-encoding@1');
  }

  const limitCases: readonly { name: string; limits: { maxInputNodes: number; maxOutputBytes: number; maxDepth: number; maxReportEntries: number; maxProvenanceEntries: number }; expected: string }[] = [
    { name: 'max_input_nodes', limits: { maxInputNodes: 1, maxOutputBytes: 64 * 1024 * 1024, maxDepth: 256, maxReportEntries: 100_000, maxProvenanceEntries: 2_000_000 }, expected: 'Failed' },
    { name: 'max_output_bytes', limits: { maxInputNodes: 1_000_000, maxOutputBytes: 2, maxDepth: 256, maxReportEntries: 100_000, maxProvenanceEntries: 2_000_000 }, expected: 'Failed' },
    { name: 'max_depth', limits: { maxInputNodes: 1_000_000, maxOutputBytes: 64 * 1024 * 1024, maxDepth: 0, maxReportEntries: 100_000, maxProvenanceEntries: 2_000_000 }, expected: 'Failed' },
    { name: 'max_report_entries', limits: { maxInputNodes: 1_000_000, maxOutputBytes: 64 * 1024 * 1024, maxDepth: 256, maxReportEntries: 0, maxProvenanceEntries: 2_000_000 }, expected: 'Complete' },
    { name: 'max_provenance_entries', limits: { maxInputNodes: 1_000_000, maxOutputBytes: 64 * 1024 * 1024, maxDepth: 256, maxReportEntries: 100_000, maxProvenanceEntries: 1 }, expected: 'Failed' },
  ];
  const outcomes: string[] = [];
  for (const descriptor of limitCases) {
    const result = materialize(value, readerRequest().withLimits(descriptor.limits));
    assert.equal(result.kind, descriptor.expected === 'Complete' ? 'Complete' : 'Failed', descriptor.name);
    outcomes.push(result.kind === 'Complete' ? 'Complete' : 'Failed');
    if (result.kind === 'Failed') {
      assert.equal(result.value.failure().code, 'core.materialization.resource-limit@1', descriptor.name);
    }
  }
  assert.deepEqual(outcomes, ['Failed', 'Failed', 'Failed', 'Complete', 'Failed']);
});

test('materialization produces a reparseable duplicate-preserving document (RFC 0010 §12)', () => {
  const result = materialize(
    mapping([['a', 'first'], ['a', 'last']]),
    readerRequest(),
  );
  assert.equal(result.kind, 'Complete');
  if (result.kind !== 'Complete') return;
  // The document reparses under the exact target profile (closure invariant).
  const reparsed = parseReader(
    result.value.document().render(),
    utf8Encoding(),
    DEFAULT_PROPERTIES_PARSE_LIMITS,
  );
  assert.equal(reparsed.formationStatus(), 'Complete');
  assert.equal(reparsed.properties().length, 2);
});
