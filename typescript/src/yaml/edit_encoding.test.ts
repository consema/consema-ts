/**
 * Encoding and line-ending preservation of YAML structural edits
 * (RFC 0007 §12).
 *
 * A UTF-16LE or UTF-16BE source keeps its encoding through the edit: the
 * replacement bytes are encoded in the selected encoding (edit.ts
 * encodeFragment :1790-1822, standaloneSource :1777-1788), the target
 * snapshot keeps the same selected encoding facts, and the rendered bytes
 * decode to the expected text (Kotlin EditTest.kt utf16EditsKeepEncoding
 * :211-234). CRLF line endings survive structural insertions and scalar
 * replacements byte-for-byte, and a structural insertion round-trips back
 * to the exact original source (consema-yaml edit.rs
 * block_insertions_are_style_aware_and_reversible_with_crlf_comments).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parse,
  EditTransactionBuilder,
  commitEdits,
  dryRunEdits,
} from './index.ts';
import { PROFILE_YAML12_CORE } from './index.ts';
import { DEFAULT_PARSE_LIMITS } from '../document/formation.ts';
import { EditPlanSourceId } from '../document/edit_plan.ts';
import { integerValue, stringValue } from '../core/value.ts';
import { utf16LeBytes, utf16LeText } from './test_helpers.ts';

/** Encodes one text as UTF-16BE bytes preceded by the UTF-16BE BOM. */
function utf16BeBytes(text: string): Uint8Array {
  const units: number[] = [0xfe, 0xff];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    units.push(code >> 8, code & 0xff);
  }
  return Uint8Array.from(units);
}

/** Decodes one UTF-16BE byte sequence (BOM optional) back to text. */
function utf16BeText(bytes: Uint8Array): string {
  let offset = bytes[0] === 0xfe && bytes[1] === 0xff ? 2 : 0;
  let text = '';
  while (offset + 1 < bytes.length) {
    text += String.fromCharCode((bytes[offset] << 8) | bytes[offset + 1]);
    offset += 2;
  }
  return text;
}

/** The edit helper: replaces the first root mapping entry's scalar value. */
function editFirstValue(document: ReturnType<typeof parse>, value: unknown): ReturnType<typeof parse> {
  const entry = document.document(0)!.root().mappingEntry(0)!;
  const builder = new EditTransactionBuilder(document);
  builder.semanticScalar(entry.value().nodeRef(), value as never, 'PreserveCompatible');
  return commitEdits(document, builder.build()).document();
}

test('utf16le edit keeps encoding and produces UTF-16LE replacement bytes', () => {
  const bytes = utf16LeBytes('a: 1\n');
  const document = parse(bytes, PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
  assert.equal(document.source().encodingFacts().selected().kind, 'Utf16Le');
  const target = editFirstValue(document, integerValue(2n));
  assert.equal(target.source().encodingFacts().selected().kind, 'Utf16Le');
  const rendered = target.render();
  assert.equal(rendered[0], 0xff);
  assert.equal(rendered[1], 0xfe);
  assert.equal(utf16LeText(rendered.slice(2)), 'a: 2\n');
});

test('utf16be edit keeps encoding and produces UTF-16BE replacement bytes', () => {
  const bytes = utf16BeBytes('a: 1\n');
  const document = parse(bytes, PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
  assert.equal(document.source().encodingFacts().selected().kind, 'Utf16Be');
  const target = editFirstValue(document, integerValue(2n));
  assert.equal(target.source().encodingFacts().selected().kind, 'Utf16Be');
  const rendered = target.render();
  assert.equal(rendered[0], 0xfe);
  assert.equal(rendered[1], 0xff);
  assert.equal(utf16BeText(rendered.slice(2)), 'a: 2\n');
});

test('utf16 edit keeps non-ASCII code units exact', () => {
  const bytes = utf16LeBytes('title: café\n');
  const document = parse(bytes, PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
  const target = editFirstValue(document, stringValue('héllo'));
  assert.equal(target.source().encodingFacts().selected().kind, 'Utf16Le');
  assert.equal(utf16LeText(target.render().slice(2)), 'title: héllo\n');
});

test('utf16bom survives the edit as the leading source bytes', () => {
  // The BOM is source content: the byte-exact render of the committed
  // document starts with the same BOM as the original source.
  const bytes = utf16LeBytes('# keep\na: 1\n');
  const document = parse(bytes, PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
  const target = editFirstValue(document, integerValue(2n));
  assert.deepEqual(
    target.render().slice(0, 2),
    Uint8Array.from([0xff, 0xfe]),
  );
  assert.equal(utf16LeText(target.render().slice(2)), '# keep\na: 2\n');
});

test('crlf scalar edit keeps CRLF line endings byte-for-byte', () => {
  const source = 'a: 1\r\nb: two\r\n';
  const document = parse(new TextEncoder().encode(source), PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
  const target = editFirstValue(document, integerValue(2n));
  assert.deepEqual(target.render(), new TextEncoder().encode('a: 2\r\nb: two\r\n'));
});

test('crlf structural insertion is style-aware and round-trips byte-exact', () => {
  const source =
    'root:\r\n  - one # keep-one\r\n  - two\r\n' +
    'map:\r\n  a: one # keep-a\r\n  b: two\r\n';
  const document = parse(new TextEncoder().encode(source), PROFILE_YAML12_CORE, DEFAULT_PARSE_LIMITS);
  const root = document.document(0)!.root();
  const sequence = root.mappingEntry(0)!.value();
  const builder = new EditTransactionBuilder(document);
  builder.insertSequenceElement(
    sequence.nodeRef(),
    stringValue('inserted'),
    { kind: 'After', anchor: sequence.sequenceItem(0)!.nodeRef() },
  );
  const transaction = builder.build();
  const plan = dryRunEdits(document, transaction, new EditPlanSourceId('crlf.yaml'));
  const commit = commitEdits(document, transaction);
  assert.equal(plan.targetDigest().equals(commit.sourcePatch().targetDigest()), true);
  assert.deepEqual(
    commit.document().render(),
    new TextEncoder().encode(
      'root:\r\n  - one # keep-one\r\n  - !!str "inserted"\r\n  - two\r\n' +
        'map:\r\n  a: one # keep-a\r\n  b: two\r\n',
    ),
  );

  // Removing the inserted element restores the exact original source.
  const committed = commit.document();
  const committedRoot = committed.document(0)!.root();
  const committedSequence = committedRoot.mappingEntry(0)!.value();
  const remove = new EditTransactionBuilder(committed);
  remove.removeSequenceElement(committedSequence.sequenceItem(1)!.nodeRef());
  const restored = commitEdits(committed, remove.build());
  assert.deepEqual(restored.document().render(), new TextEncoder().encode(source));
});
