/**
 * Intent documents for plist XML and binary formation (L3).
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id — plus binary trailer-limit rejection (no false Complete) and
 * offset/object-ref hardening:
 *  - conformance/vectors/plist-v1.json:
 *    plist.xml-formation.all-value-types (:10-45),
 *    plist.xml-formation.doctype-exact (:47-58),
 *    plist.xml-formation.string-text-facts (:373-388),
 *    plist.xml-formation.integer-matrix (:179-236),
 *    plist.xml-formation.trailing-content (:361-371),
 *    plist.binary-formation.minimal-document (:451-467),
 *    plist.binary-formation.all-types-document (:469-508),
 *    plist.binary-formation.integer-width-matrix (:510-598),
 *    plist.binary-formation.offset-and-reference (:821-859),
 *    plist.binary-formation.header-and-trailer (:775-819),
 *    plist.binary-formation.uid-matrix (:643-683)
 *  - the offset/object-ref hardening and the "no false Complete" rule:
 *    RFC 0013 §5.11 (:425-450) and the Go fuzz finding ① fix recorded in
 *    parser_binary.ts (every offset-table entry in [8, offsetTableOffset),
 *    every reference < numObjects)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDefault,
  FatalFormationFailure,
  PlistDocument,
  PlistReal,
  PlistValueRef,
} from './index.ts';

/** UTF-8 bytes of one source string. */
function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

/** Decodes one vector hex string (conformance/vectors/plist-v1.json spellings). */
function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index++) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function diagnosticCodes(document: PlistDocument): string[] {
  return document.diagnostics().map((item) => item.code);
}

function renderText(document: PlistDocument): string {
  return new TextDecoder().decode(document.render());
}

// ---------------------------------------------------------------------------
// XML formation golden transcriptions
// ---------------------------------------------------------------------------

test('plist.xml-formation.all-value-types: every element kind forms a Complete dict (plist-v1.json:10-45)', () => {
  const source =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    '    <dict>\n' +
    '        <key>name</key><string>Consema</string>\n' +
    '        <key>count</key><integer>0x2A</integer>\n' +
    '        <key>ratio</key><real>1.5e3</real>\n' +
    '        <key>negative</key><integer>-7</integer>\n' +
    '        <key>enabled</key><true/>\n' +
    '        <key>disabled</key><false/>\n' +
    '        <key>payload</key><data>AQID</data>\n' +
    '        <key>born</key><date>2023-01-01T00:00:00Z</date>\n' +
    '        <key>tags</key><array><string>a</string><dict/></array>\n' +
    '        <key>empty</key><string></string>\n' +
    '    </dict>\n' +
    '</plist>\n';
  const document = parseDefault(bytes(source), 'XmlV1');
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.diagnostics(), []);
  // Byte-exact render (the vector's `render` equals the input).
  assert.equal(renderText(document), source);
  const root = document.document()!;
  const node = root.get(root.root())!;
  assert.equal(node.kind, 'Dict');
  const entries = node.entries;
  assert.deepEqual(entries.map((entry) => entry.key), [
    'name',
    'count',
    'ratio',
    'negative',
    'enabled',
    'disabled',
    'payload',
    'born',
    'tags',
    'empty',
  ]);
  const valueAt = (key: string) => root.get(PlistRef(entries.find((e) => e.key === key)!.value))!;
  assert.equal((valueAt('count') as { kind: 'Integer'; value: bigint }).value, 42n);
  assert.equal((valueAt('negative') as { kind: 'Integer'; value: bigint }).value, -7n);
  assert.equal((valueAt('ratio') as { kind: 'Real'; real: PlistReal }).real.asF64(), 1500.0);
  assert.deepEqual(
    [(valueAt('enabled') as { kind: 'Boolean'; value: boolean }).value, (valueAt('disabled') as { kind: 'Boolean'; value: boolean }).value],
    [true, false],
  );
  assert.deepEqual(Array.from((valueAt('payload') as { kind: 'Data'; bytes: Uint8Array }).bytes), [0x01, 0x02, 0x03]);
  assert.equal((valueAt('born') as { kind: 'Date'; seconds: number }).seconds, 694224000.0);
  const tags = valueAt('tags') as { kind: 'Array'; elements: readonly number[] };
  assert.equal(tags.elements.length, 2);
  assert.equal((root.get(PlistRef(tags.elements[0])) as { kind: 'String'; text: string }).text, 'a');
  assert.equal((root.get(PlistRef(tags.elements[1])) as { kind: 'Dict'; entries: readonly { key: string; value: number }[] }).kind, 'Dict');
  assert.equal((valueAt('empty') as { kind: 'String'; text: string }).text, '');
});

function PlistRef(index: number): PlistValueRef {
  return PlistValueRef.fromIndex(index);
}

test('plist.xml-formation.doctype-exact: the Apple DOCTYPE forms Complete (plist-v1.json:47-58)', () => {
  const source =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0"><string>ok</string></plist>\n';
  const document = parseDefault(bytes(source), 'XmlV1');
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(renderText(document), source);
  const root = document.document()!;
  assert.equal((root.get(root.root()) as { kind: 'String'; text: string }).text, 'ok');
});

test('plist.xml-formation.doctype-violations: wrong name, internal subset, and SYSTEM-only DOCTYPE (plist-v1.json:60-88)', () => {
  const samples = [
    '<!DOCTYPE wrong PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><string>ok</string></plist>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd" [<!ENTITY x "y">]>\n<plist version="1.0"><string>ok</string></plist>',
    '<!DOCTYPE plist SYSTEM "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><string>ok</string></plist>',
  ];
  const expected = ['plist.parse.doctype@1', 'plist.parse.doctype-subset@1', 'plist.parse.doctype@1'];
  for (let index = 0; index < samples.length; index++) {
    const document = parseDefault(bytes(samples[index]), 'XmlV1');
    assert.equal(document.formationStatus(), 'Recovered', `sample ${index}`);
    assert.ok(diagnosticCodes(document).includes(expected[index]), `sample ${index}`);
  }
});

test('plist.xml-formation.integer-matrix: decimal/hex grammar and the signed 64-bit bound (plist-v1.json:179-236)', () => {
  const samples = ['-42', '0x2A', '+ 7', '007', '12a', '9223372036854775808', '-9223372036854775809'];
  const expectedStatuses = ['Complete', 'Complete', 'Complete', 'Complete', 'Recovered', 'Recovered', 'Recovered'];
  const expectedIntegers = [BigInt(-42), BigInt(42), BigInt(7), BigInt(7), null, null, null];
  for (let index = 0; index < samples.length; index++) {
    const document = parseDefault(bytes(`<plist version="1.0"><integer>${samples[index]}</integer></plist>`), 'XmlV1');
    assert.equal(document.formationStatus(), expectedStatuses[index], `sample ${index}`);
    const root = document.document();
    const value = root === null ? null : root.get(root.root());
    if (expectedIntegers[index] === null) {
      assert.ok(diagnosticCodes(document).includes('plist.parse.integer@1'), `sample ${index}`);
    } else {
      assert.equal((value as { kind: 'Integer'; value: bigint }).value, expectedIntegers[index]);
    }
  }
});

test('plist.xml-formation.real-special-values: nan/-inf/+infinity are admitted (plist-v1.json:238-252)', () => {
  const document = parseDefault(
    bytes('<plist version="1.0"><array><real>nan</real><real>-inf</real><real>+infinity</real><real>1.5e3</real></array></plist>'),
    'XmlV1',
  );
  assert.equal(document.formationStatus(), 'Complete');
  const root = document.document()!;
  const array = root.get(root.root()) as { kind: 'Array'; elements: readonly number[] };
  const values = array.elements.map((element) => (root.get(PlistRef(element)) as { kind: 'Real'; real: PlistReal }).real.asF64());
  assert.equal(values.length, 4);
  assert.ok(Number.isNaN(values[0]));
  assert.equal(values[1], -Infinity);
  assert.equal(values[2], Infinity);
  assert.equal(values[3], 1500.0);
});

test('plist.xml-formation.date-matrix: calendar validation (plist-v1.json:254-293)', () => {
  const samples = [
    '<plist version="1.0"><date>2023-01-01T00:00:00Z</date></plist>',
    '<plist version="1.0"><date>2023-01-01T00:00:00.5Z</date></plist>',
    '<plist version="1.0"><date>2024-02-30T00:00:00Z</date></plist>',
    '<plist version="1.0"><date>2023-01-01T00:00:00</date></plist>',
  ];
  const expectedStatuses = ['Complete', 'Recovered', 'Recovered', 'Recovered'];
  for (let index = 0; index < samples.length; index++) {
    const document = parseDefault(bytes(samples[index]), 'XmlV1');
    assert.equal(document.formationStatus(), expectedStatuses[index], `sample ${index}`);
    if (expectedStatuses[index] === 'Complete') {
      const root = document.document()!;
      assert.equal((root.get(root.root()) as { kind: 'Date'; seconds: number }).seconds, 694224000.0);
    } else {
      assert.ok(diagnosticCodes(document).includes('plist.parse.date@1'), `sample ${index}`);
    }
  }
});

test('plist.xml-formation.string-text-facts: entities, character references, CDATA, line ends (plist-v1.json:373-388)', () => {
  const source = '<plist version="1.0"><dict><key>text</key><string>a &lt; b &amp; c &#65; <![CDATA[raw]]></string><key>lines</key><string>cr\r\nlf</string></dict></plist>';
  const document = parseDefault(bytes(source), 'XmlV1');
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(renderText(document), source);
  const root = document.document()!;
  const dict = root.get(root.root()) as { kind: 'Dict'; entries: readonly { key: string; value: number }[] };
  const text = root.get(PlistRef(dict.entries[0].value)) as { kind: 'String'; text: string };
  const lines = root.get(PlistRef(dict.entries[1].value)) as { kind: 'String'; text: string };
  assert.equal(text.text, 'a < b & c A raw');
  assert.equal(lines.text, 'cr\nlf');
});

test('plist.xml-formation.trailing-content: non-whitespace epilog is a well-formedness violation (plist-v1.json:361-371)', () => {
  const document = parseDefault(bytes('<plist version="1.0"><string>ok</string></plist> trailing'), 'XmlV1');
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(diagnosticCodes(document).includes('plist.parse.well-formedness@1'));
});

test('plist.xml-formation.key-pair: missing value and value-in-key-position (plist-v1.json:336-359)', () => {
  const missing = parseDefault(bytes('<plist version="1.0"><dict><key>a</key></dict></plist>'), 'XmlV1');
  assert.equal(missing.formationStatus(), 'Recovered');
  assert.ok(diagnosticCodes(missing).includes('plist.parse.dict-missing-value@1'));
  const keyPosition = parseDefault(bytes('<plist version="1.0"><dict><string>x</string><string>y</string></dict></plist>'), 'XmlV1');
  assert.equal(keyPosition.formationStatus(), 'Recovered');
  assert.ok(diagnosticCodes(keyPosition).includes('plist.parse.dict-key@1'));
});

test('plist.xml-formation.empty-value-matrix: empty scalars except data/string (plist-v1.json:390-435)', () => {
  const samples = [
    '<plist version="1.0"><date/></plist>',
    '<plist version="1.0"><integer/></plist>',
    '<plist version="1.0"><data/></plist>',
    '<plist version="1.0"><data></data></plist>',
    '<plist version="1.0"><string/></plist>',
  ];
  const expected = ['Recovered', 'Recovered', 'Recovered', 'Complete', 'Complete'];
  for (let index = 0; index < samples.length; index++) {
    const document = parseDefault(bytes(samples[index]), 'XmlV1');
    assert.equal(document.formationStatus(), expected[index], `sample ${index}`);
    if (expected[index] === 'Recovered') {
      assert.ok(diagnosticCodes(document).includes('plist.parse.empty-value@1'), `sample ${index}`);
    } else {
      const root = document.document()!;
      const value = root.get(root.root())!;
      // `<data></data>` forms an empty Data node; `<string/>` an empty
      // String (vector values: `""` for both).
      assert.equal(value.kind, index === 3 ? 'Data' : 'String');
      if (value.kind === 'Data') {
        assert.equal(value.bytes.length, 0);
      } else {
        assert.equal(value.text, '');
      }
    }
  }
});

test('plist.xml-formation.duplicate-keys: ordered duplicate associations are Complete (plist-v1.json:155-177)', () => {
  const document = parseDefault(
    bytes('<plist version="1.0"><dict><key>a</key><integer>1</integer><key>a</key><integer>2</integer><key>b</key><string>three</string></dict></plist>'),
    'XmlV1',
  );
  assert.equal(document.formationStatus(), 'Complete');
  const root = document.document()!;
  const dict = root.get(root.root()) as { kind: 'Dict'; entries: readonly { key: string; value: number }[] };
  assert.deepEqual(dict.entries.map((entry) => entry.key), ['a', 'a', 'b']);
  assert.equal(dict.entries.length, 3);
  assert.equal((root.get(PlistRef(dict.entries[0].value)) as { kind: 'Integer'; value: bigint }).value, 1n);
  assert.equal((root.get(PlistRef(dict.entries[1].value)) as { kind: 'Integer'; value: bigint }).value, 2n);
  assert.equal((root.get(PlistRef(dict.entries[2].value)) as { kind: 'String'; text: string }).text, 'three');
});

test('plist.xml-formation.root-contracts: version and root value count rules (plist-v1.json:90-128)', () => {
  const samples = [
    '<plist><string>ok</string></plist>',
    '<plist version="2.0"><string>ok</string></plist>',
    '<plist version="1.0" extra="1"><string>ok</string></plist>',
    '<plist version="1.0"></plist>',
    '<plist version="1.0"><string>a</string><string>b</string></plist>',
  ];
  const expected = [
    'plist.parse.root-version@1',
    'plist.parse.root-version@1',
    'plist.parse.root-attribute@1',
    'plist.parse.root-value-count@1',
    'plist.parse.root-value-count@1',
  ];
  for (let index = 0; index < samples.length; index++) {
    const document = parseDefault(bytes(samples[index]), 'XmlV1');
    assert.equal(document.formationStatus(), 'Recovered', `sample ${index}`);
    assert.ok(diagnosticCodes(document).includes(expected[index]), `sample ${index}: ${diagnosticCodes(document)}`);
  }
});

// ---------------------------------------------------------------------------
// Binary formation golden transcriptions
// ---------------------------------------------------------------------------

test('plist.binary-formation.minimal-document: the 42-byte minimum forms Complete (plist-v1.json:451-467)', () => {
  const document = parseDefault(hexBytes('62706c697374303050080000000000000101000000000000000100000000000000000000000000000009'), 'BinaryV1');
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.diagnostics(), []);
  const root = document.document()!;
  assert.equal(root.nodeCount(), 1);
  assert.equal(root.root().index(), 0);
  assert.equal((root.get(root.root()) as { kind: 'String'; text: string }).text, '');
  const facts = document.binaryFacts()!;
  assert.equal(facts.trailer().numObjects(), 1n);
  assert.equal(facts.trailer().topObject(), 0n);
  assert.equal(facts.trailer().offsetIntSize(), 1);
  assert.equal(facts.trailer().objectRefSize(), 1);
  assert.equal(facts.trailer().offsetTableOffset(), 9n);
  assert.equal(facts.trailer().sortVersion(), 0);
});

test('plist.binary-formation.all-types-document: the shared native model across every marker (plist-v1.json:469-508)', () => {
  const document = parseDefault(
    hexBytes('62706c6973743030d90102030405060708090a0d0e0f101112131455617272617954626f6f6c54646174615464617465536633325a6672616374696f6e616c53696e74547265616c53737472a20b0c100110020943010203330000000000000000223f000000333ff8000000000000102a233ff8000000000000526869081b21262b30343f43484c4f5153545861666f717a000000000000010100000000000000150000000000000000000000000000007d'),
    'BinaryV1',
  );
  assert.equal(document.formationStatus(), 'Complete');
  const root = document.document()!;
  assert.equal(root.nodeCount(), 21);
  const dict = root.get(root.root()) as { kind: 'Dict'; entries: readonly { key: string; value: number }[] };
  assert.deepEqual(dict.entries.map((entry) => entry.key), ['array', 'bool', 'data', 'date', 'f32', 'fractional', 'int', 'real', 'str']);
  const valueAt = (key: string) => root.get(PlistRef(dict.entries.find((e) => e.key === key)!.value))!;
  assert.equal((valueAt('int') as { kind: 'Integer'; value: bigint }).value, 42n);
  assert.equal((valueAt('real') as { kind: 'Real'; real: PlistReal }).real.asF64(), 1.5);
  assert.equal((valueAt('f32') as { kind: 'Real'; real: PlistReal }).real.width(), 'Float32');
  assert.equal((valueAt('f32') as { kind: 'Real'; real: PlistReal }).real.asF64(), 0.5);
  assert.deepEqual(Array.from((valueAt('data') as { kind: 'Data'; bytes: Uint8Array }).bytes), [0x01, 0x02, 0x03]);
  assert.equal((valueAt('date') as { kind: 'Date'; seconds: number }).seconds, 0.0);
  assert.equal((valueAt('fractional') as { kind: 'Date'; seconds: number }).seconds, 1.5);
  assert.equal((valueAt('bool') as { kind: 'Boolean'; value: boolean }).value, true);
  assert.equal((valueAt('str') as { kind: 'String'; text: string }).text, 'hi');
  const array = valueAt('array') as { kind: 'Array'; elements: readonly number[] };
  assert.deepEqual(array.elements.map((element) => (root.get(PlistRef(element)) as { kind: 'Integer'; value: bigint }).value), [1n, 2n]);
  const facts = document.binaryFacts()!;
  assert.equal(facts.trailer().numObjects(), 21n);
  assert.equal(facts.trailer().offsetTableOffset(), 125n);
});

test('plist.binary-formation.integer-width-matrix: sign rules per width (plist-v1.json:510-598)', () => {
  const samples = [
    '62706c6973743030100008000000000000010100000000000000010000000000000000000000000000000a',
    '62706c6973743030100108000000000000010100000000000000010000000000000000000000000000000a',
    '62706c697374303010ff08000000000000010100000000000000010000000000000000000000000000000a',
    '62706c697374303011010008000000000000010100000000000000010000000000000000000000000000000b',
    '62706c697374303011ffff08000000000000010100000000000000010000000000000000000000000000000b',
    '62706c6973743030120001000008000000000000010100000000000000010000000000000000000000000000000d',
    '62706c697374303012ffffffff08000000000000010100000000000000010000000000000000000000000000000d',
    '62706c6973743030130000000000000005080000000000000101000000000000000100000000000000000000000000000011',
    '62706c697374303013ffffffffffffffff080000000000000101000000000000000100000000000000000000000000000011',
    '62706c697374303013ffffffffffffffd6080000000000000101000000000000000100000000000000000000000000000011',
    '62706c6973743030137fffffffffffffff080000000000000101000000000000000100000000000000000000000000000011',
    '62706c6973743030138000000000000000080000000000000101000000000000000100000000000000000000000000000011',
  ];
  const expected = [
    0n, 1n, 255n, 256n, 65535n, 65536n, 4294967295n, 5n, -1n, -42n, 9223372036854775807n, -9223372036854775808n,
  ];
  for (let index = 0; index < samples.length; index++) {
    const document = parseDefault(hexBytes(samples[index]), 'BinaryV1');
    assert.equal(document.formationStatus(), 'Complete', `sample ${index}`);
    const root = document.document()!;
    const value = root.get(root.root()) as { kind: 'Integer'; value: bigint };
    assert.equal(value.value, expected[index], `sample ${index}`);
  }
});

test('plist.binary-formation.strings-matrix: ASCII/UTF-16 strings and the high-bit rule (plist-v1.json:600-641)', () => {
  const samples = [
    '62706c69737430305548656c6c6f08000000000000010100000000000000010000000000000000000000000000000e',
    '62706c6973743030624e16754c08000000000000010100000000000000010000000000000000000000000000000d',
    '62706c697374303051e908000000000000010100000000000000010000000000000000000000000000000a',
    '62706c697374303062d800004108000000000000010100000000000000010000000000000000000000000000000d',
  ];
  const expectedStatuses = ['Complete', 'Complete', 'Recovered', 'Complete'];
  for (let index = 0; index < samples.length; index++) {
    const document = parseDefault(hexBytes(samples[index]), 'BinaryV1');
    assert.equal(document.formationStatus(), expectedStatuses[index], `sample ${index}`);
    if (expectedStatuses[index] === 'Recovered') {
      assert.ok(diagnosticCodes(document).includes('plist.binary.string@1'), `sample ${index}`);
    }
  }
  const hello = parseDefault(hexBytes(samples[0]), 'BinaryV1');
  const root = hello.document()!;
  assert.equal((root.get(root.root()) as { kind: 'String'; text: string }).text, 'Hello');
  const world = parseDefault(hexBytes(samples[1]), 'BinaryV1');
  const worldRoot = world.document()!;
  assert.equal((worldRoot.get(worldRoot.root()) as { kind: 'String'; text: string }).text, '世界');
  const unpaired = parseDefault(hexBytes(samples[3]), 'BinaryV1');
  const unpairedRoot = unpaired.document()!;
  assert.equal(
    (unpairedRoot.get(unpairedRoot.root()) as { kind: 'String'; status: 'WellFormedUnicode' | 'UnpairedSurrogate' }).status,
    'UnpairedSurrogate',
  );
});

test('plist.binary-formation.uid-matrix: widths, leading zeros, and the 32-bit bound (plist-v1.json:643-683)', () => {
  const samples = [
    '62706c6973743030800508000000000000010100000000000000010000000000000000000000000000000a',
    '62706c6973743030830102030408000000000000010100000000000000010000000000000000000000000000000d',
    '62706c69737430308500000000000508000000000000010100000000000000010000000000000000000000000000000f',
    '62706c697374303084010000000008000000000000010100000000000000010000000000000000000000000000000e',
  ];
  const expected = ['Complete', 'Complete', 'Complete', 'Recovered'];
  const expectedUids = [5, 16909060, 5, null];
  for (let index = 0; index < samples.length; index++) {
    const document = parseDefault(hexBytes(samples[index]), 'BinaryV1');
    assert.equal(document.formationStatus(), expected[index], `sample ${index}`);
    if (expected[index] === 'Recovered') {
      assert.ok(diagnosticCodes(document).includes('plist.binary.uid@1'), `sample ${index}`);
    } else {
      const root = document.document()!;
      assert.equal((root.get(root.root()) as { kind: 'Uid'; value: number }).value, expectedUids[index], `sample ${index}`);
    }
  }
});

test('plist.binary-formation.shared-reference: one source object with multiple owners (plist-v1.json:685-702)', () => {
  const document = parseDefault(
    hexBytes('62706c6973743030a3010102d103045178516b5176080c0f11130000000000000101000000000000000500000000000000000000000000000015'),
    'BinaryV1',
  );
  assert.equal(document.formationStatus(), 'Complete');
  const root = document.document()!;
  assert.equal(root.nodeCount(), 5);
  const array = root.get(root.root()) as { kind: 'Array'; elements: readonly number[] };
  assert.deepEqual(array.elements, [1, 1, 2]);
  // The same arena node is referenced twice: shared identity is preserved.
  assert.equal(array.elements[0], array.elements[1]);
  const facts = document.binaryFacts()!;
  // The array contributes three refs ([1, 1, 2]) and the dict contributes
  // two (key 3 and value 4): five proven references total (vector
  // shared_ref_count 1, refs_of_top [1, 1, 2]).
  assert.equal(facts.refs().length, 5);
  const topRefs = facts.refs().filter((reference) => reference.owner() === 0).map((reference) => reference.target());
  assert.deepEqual(topRefs, [1, 1, 2]);
});

test('plist.binary-formation.duplicate-keys: ordered duplicate associations (plist-v1.json:704-723)', () => {
  const document = parseDefault(
    hexBytes('62706c6973743030d201010203516b10011002080d0f110000000000000101000000000000000400000000000000000000000000000013'),
    'BinaryV1',
  );
  assert.equal(document.formationStatus(), 'Complete');
  const root = document.document()!;
  const dict = root.get(root.root()) as { kind: 'Dict'; entries: readonly { key: string; value: number }[] };
  assert.deepEqual(dict.entries.map((entry) => entry.key), ['k', 'k']);
  assert.equal((root.get(PlistRef(dict.entries[0].value)) as { kind: 'Integer'; value: bigint }).value, 1n);
  assert.equal((root.get(PlistRef(dict.entries[1].value)) as { kind: 'Integer'; value: bigint }).value, 2n);
});

// ---------------------------------------------------------------------------
// Trailer limits and offset/reference hardening — no false Complete
// ---------------------------------------------------------------------------

test('plist.binary-formation.header-and-trailer: version, widths, and total length (plist-v1.json:775-819)', () => {
  const samples = [
    // bplist01 header
    '62706c697374303150080000000000000101000000000000000100000000000000000000000000000009',
    // offsetIntSize = 1, numObjects = 1, total length exact -> Complete
    '62706c697374303050080000000000010101000000000000000100000000000000000000000000000009',
    // sortVersion = 1
    '62706c697374303050080100000000000101000000000000000100000000000000000000000000000009',
    // numObjects = 0
    '62706c697374303050080000000000000101000000000000000000000000000000000000000000000009',
    // offsetTableOffset beyond the trailer window
    '62706c697374303050080000000000000101000000000000000100000000000000010000000000000009',
    // objectRefSize = 0
    '62706c6973743030514100000000000000080000000000000001000000000000000100000000000000000000000000000009',
  ];
  const expectedStatuses = ['Recovered', 'Complete', 'Recovered', 'Recovered', 'Recovered', 'Recovered'];
  const expectedCodes = [
    'plist.binary.header@1',
    null,
    'plist.binary.trailer@1',
    'plist.binary.trailer@1',
    'plist.binary.trailer@1',
    'plist.binary.trailer@1',
  ];
  for (let index = 0; index < samples.length; index++) {
    const document = parseDefault(hexBytes(samples[index]), 'BinaryV1');
    assert.equal(document.formationStatus(), expectedStatuses[index], `sample ${index}`);
    const expectedCode = expectedCodes[index];
    if (expectedCode !== null) {
      assert.ok(diagnosticCodes(document).includes(expectedCode), `sample ${index}`);
    }
  }
});

test('plist.binary-formation.offset-and-reference: entry ranges and reference ranges (plist-v1.json:821-859)', () => {
  const samples = [
    // offset entry below the header (value 5 < 8)
    '62706c697374303050500805000000000000010100000000000000020000000000000000000000000000000a',
    // offset entry above the offset table (value 10 >= offsetTableOffset 10)
    '62706c69737430305050080a000000000000010100000000000000020000000000000000000000000000000a',
    // object reference out of range (target 2 >= numObjects 2)
    '62706c6973743030a10250080a000000000000010100000000000000020000000000000000000000000000000b',
    // extended size object beyond the source
    '62706c69737430305f10fa6161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616108090000000000000101000000000000000200000000000000000000000000000105',
    // offset table overlaps the trailer window
    '62706c6973743030500808080000000000000101000000000000000200000000000000000000000000000009',
  ];
  const expectedCodes = [
    'plist.binary.offset-table@1',
    'plist.binary.offset-table@1',
    'plist.binary.reference@1',
    'plist.binary.trailer@1',
    'plist.binary.trailer@1',
  ];
  for (let index = 0; index < samples.length; index++) {
    const document = parseDefault(hexBytes(samples[index]), 'BinaryV1');
    assert.equal(document.formationStatus(), 'Recovered', `sample ${index}`);
    assert.ok(diagnosticCodes(document).includes(expectedCodes[index]), `sample ${index}: ${diagnosticCodes(document)}`);
    // The native document exists exactly when the top object and its
    // references stay inside the proven prefix (RFC 0013 §5.11): samples 0-1
    // keep an empty-string root proven; samples 2-4 cut the top or the
    // trailer and never yield a native document.
    assert.equal(document.document() !== null, index <= 1, `sample ${index}`);
  }
});

/** Hand-built `bplist00` fixture writer (the vector minimal-file pattern). */
function binaryFile(objects: Uint8Array[], topObject = 0, offsetIntSize = 1, objectRefSize = 1): Uint8Array {
  const header = new TextEncoder().encode('bplist00');
  let objectArea: Uint8Array = new Uint8Array(0);
  const offsets: number[] = [];
  let cursor = 8;
  for (const object of objects) {
    offsets.push(cursor);
    cursor += object.length;
    objectArea = concat(objectArea, object);
  }
  const table = new Uint8Array(offsets.length * offsetIntSize);
  for (let index = 0; index < offsets.length; index++) {
    writeBe(table, index * offsetIntSize, BigInt(offsets[index]), offsetIntSize);
  }
  const trailer = new Uint8Array(32);
  trailer[5] = 0;
  trailer[6] = offsetIntSize;
  trailer[7] = objectRefSize;
  writeBe(trailer, 8, BigInt(offsets.length), 8);
  writeBe(trailer, 16, BigInt(topObject), 8);
  writeBe(trailer, 24, BigInt(cursor), 8);
  return concat(header, objectArea, table, trailer);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function writeBe(bytes: Uint8Array, offset: number, value: bigint, width: number): void {
  for (let shift = 0; shift < width; shift++) {
    bytes[offset + width - 1 - shift] = Number((value >> BigInt(8 * shift)) & 0xffn);
  }
}

test('hardening: offset entries outside [8, offsetTableOffset) cut the proven prefix (RFC 0013 §5.11; parser_binary.ts)', () => {
  // Two valid string objects, but both offset entries claim value 5
  // (below the header): the first invalid entry cuts the proven prefix
  // and no native document exists — never a false Complete.
  const source = binaryFile([new Uint8Array([0x51, 0x61]), new Uint8Array([0x51, 0x62])]);
  // Objects occupy 8..12, so the two 1-byte offset entries live at 12, 13.
  const patched = Uint8Array.from(source);
  patched[12] = 5;
  patched[13] = 5;
  const document = parseDefault(patched, 'BinaryV1');
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(diagnosticCodes(document).includes('plist.binary.offset-table@1'));
  assert.equal(document.document(), null);
  const facts = document.binaryFacts()!;
  assert.equal(facts.objects().length, 0);
  assert.equal(facts.offsets().length, 0);
});

test('hardening: object references at or beyond numObjects are never Complete (RFC 0013 §5.9)', () => {
  // An array of one element referencing object 1 while numObjects = 1:
  // the reference is out of range and the document cannot exist.
  const source = binaryFile([new Uint8Array([0xa1, 0x01])]);
  const document = parseDefault(source, 'BinaryV1');
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(diagnosticCodes(document).includes('plist.binary.reference@1'));
  assert.equal(document.document(), null);
});

test('hardening: an offset entry at the offset-table boundary is never Complete (RFC 0013 §5.11)', () => {
  // One object at 8..9, table at 9; the entry claims value 9 which is not
  // < offsetTableOffset, so the prefix cuts and no document exists.
  const source = binaryFile([new Uint8Array([0x08])]);
  const patched = Uint8Array.from(source);
  patched[9] = 9; // entry 0 -> 9, at the table boundary
  const document = parseDefault(patched, 'BinaryV1');
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(diagnosticCodes(document).includes('plist.binary.offset-table@1'));
  assert.equal(document.document(), null);
});

test('hardening: out-of-range trailer widths recover with trailer@1, never Complete (RFC 0013 §5.11)', () => {
  // objectRefSize = 9 exceeds the frozen 8-byte maximum.
  const source = hexBytes('62706c697374303050080000000000000109000000000000000100000000000000000000000000000009');
  const document = parseDefault(source, 'BinaryV1');
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(diagnosticCodes(document).includes('plist.binary.trailer@1'));
  assert.equal(document.document(), null);
});

test('hardening: a numObjects claim beyond the object limit is fatal, never a truncated tree (RFC 0013 §12)', () => {
  // numObjects = 2^64 - 1 exceeds max_object_count (1_000_000).
  const source = binaryFile([new Uint8Array([0x08])]);
  const patched = Uint8Array.from(source);
  const trailerStart = patched.length - 32;
  for (let index = 0; index < 8; index++) {
    patched[trailerStart + 8 + index] = 0xff;
  }
  assert.throws(() => {
    parseDefault(patched, 'BinaryV1');
  }, FatalFormationFailure);
});

test('hardening: minimum source size is enforced before any structure (RFC 0013 §2.2)', () => {
  const tooShort = hexBytes('62706c6973743030');
  assert.throws(() => {
    parseDefault(tooShort, 'BinaryV1');
  }, FatalFormationFailure);
  const exact = hexBytes('62706c697374303050080000000000000101000000000000000100000000000000000000000000000009');
  assert.equal(exact.length, 42);
  assert.equal(parseDefault(exact, 'BinaryV1').formationStatus(), 'Complete');
});

// ---------------------------------------------------------------------------
// Cross-representation closure
// ---------------------------------------------------------------------------

test('XML and binary round-trip equivalence: the same native model both ways (RFC 0013 §7)', () => {
  const xml = parseDefault(
    bytes('<plist version="1.0"><dict><key>a</key><integer>1</integer><key>b</key><array><string>x</string><string>y</string></array><key>c</key><date>2023-01-01T00:00:00Z</date></dict></plist>'),
    'XmlV1',
  );
  const binary = parseDefault(
    hexBytes('62706c6973743030d302040601030510015161a2070851623341c4b08240000000516351785179080f111316182123250000000000000101000000000000000900000000000000000000000000000027'),
    'BinaryV1',
  );
  assert.equal(xml.formationStatus(), 'Complete');
  assert.equal(binary.formationStatus(), 'Complete');
  // Both documents expose the same ordered native facts: one dict with two
  // entries, array of one string, and the date seconds.
  const xmlRoot = xml.document()!;
  const binaryRoot = binary.document()!;
  const xmlDict = xmlRoot.get(xmlRoot.root()) as { kind: 'Dict'; entries: readonly { key: string; value: number }[] };
  const binaryDict = binaryRoot.get(binaryRoot.root()) as { kind: 'Dict'; entries: readonly { key: string; value: number }[] };
  assert.deepEqual(xmlDict.entries.map((e) => e.key), binaryDict.entries.map((e) => e.key));
  for (let index = 0; index < xmlDict.entries.length; index++) {
    const left = xmlRoot.get(PlistRef(xmlDict.entries[index].value))!;
    const right = binaryRoot.get(PlistRef(binaryDict.entries[index].value))!;
    assert.equal(left.kind, right.kind);
    if (left.kind === 'Integer') {
      assert.equal((left as { kind: 'Integer'; value: bigint }).value, (right as { kind: 'Integer'; value: bigint }).value);
    } else if (left.kind === 'Date') {
      assert.equal((left as { kind: 'Date'; seconds: number }).seconds, (right as { kind: 'Date'; seconds: number }).seconds);
    }
  }
});
