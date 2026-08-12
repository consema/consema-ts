/**
 * Intent documents for XML formation (L3).
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id — plus the entity-deny boundary, namespace resolution, and
 * byte-exact span closure:
 *  - conformance/vectors/xml-1-0-safe-v1.json: xml.formation.basic-complete
 *    (:6-16), xml.formation.default-namespace-on-elements (:18-28),
 *    xml.formation.prefixed-namespace-resolution (:30-40),
 *    xml.formation.predefined-and-character-references (:42-52),
 *    xml.formation.internal-entity-expansion (:54-64),
 *    xml.formation.mixed-content-order (:66-76),
 *    xml.formation.crlf-semantic-normalization (:78-88),
 *    xml.formation.utf16le-with-bom (:90-101),
 *    xml.formation.duplicate-expanded-attribute-recovered (:103-113),
 *    xml.formation.unbound-prefix-recovered (:115-125),
 *    xml.formation.external-subset-recovered (:127-137),
 *    xml.formation.unknown-entity-recovered (:139-149),
 *    xml.formation.missing-root-recovered (:151-161),
 *    xml.formation.dtd-comment-not-excluded-markup (:163-173),
 *    xml.limit.entity-amplification-recovered (:568-579),
 *    xml.limit.mixed-content-diagnostic (:581-592)
 *  - the fine-grained piece transcription below is pinned against the
 *    current Rust crate output (probed at write time; the vector ordinal
 *    field is informational — see parser.ts header)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse, FatalFormationFailure } from '../xml/index.ts';
import { PROFILE_XML_SAFE } from '../xml/index.ts';
import { DEFAULT_XML_PARSE_LIMITS } from '../xml/profile.ts';
import type { XmlParseLimits } from '../xml/profile.ts';
import { textSemantic } from '../xml/index.ts';

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function parseXml(source: string, limits: XmlParseLimits = DEFAULT_XML_PARSE_LIMITS) {
  return parse(bytes(source), PROFILE_XML_SAFE, { kind: 'ProfileDefault' }, limits);
}

/** Encodes text as BOM-prefixed UTF-16LE bytes. */
function utf16LeBytes(source: string): Uint8Array {
  const units: number[] = [];
  for (let index = 0; index < source.length; index++) {
    units.push(source.charCodeAt(index));
  }
  const out = new Uint8Array(2 + units.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let index = 0; index < units.length; index++) {
    out[2 + index * 2] = units[index] & 0xff;
    out[3 + index * 2] = (units[index] >> 8) & 0xff;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/** The kind and raw text of every structural piece, in source order. */
function pieceKinds(document: ReturnType<typeof parseXml>): { kind: string; text: string }[] {
  const index = document.losslessStructuralIndex();
  assert.ok(index !== null, 'structural index exists');
  const source = document.render();
  return index.pieces().map((piece, ordinal) => {
    const span = piece.span();
    return {
      kind: document.losslessSyntaxKinds()[ordinal],
      text: new TextDecoder().decode(source.slice(span.startByte(), span.endByte())),
    };
  });
}

test('xml.formation.basic-complete: byte-exact round trip and Complete status (xml-1-0-safe-v1.json:6-16)', () => {
  const source = '<root a="1"><child>t</child></root>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.diagnostics(), []);
  assert.equal(new TextDecoder().decode(document.render()), source);
  assert.equal(document.profile().toString(), 'xml.1.0-safe@1');
  assert.equal(document.formatFamily().toString(), 'xml@1');
});

test('xml.formation.default-namespace-on-elements: default namespace applies to elements, never attributes (xml-1-0-safe-v1.json:18-28)', () => {
  const source = '<root xmlns="urn:app" version="1"><child/></root>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(new TextDecoder().decode(document.render()), source);
  const root = document.root()!;
  assert.equal(root.expanded()!.namespace, 'urn:app');
  assert.equal(root.expanded()!.local, 'root');
  const attribute = root.attributes()[0];
  assert.equal(attribute.expanded!.namespace, null, 'unprefixed attributes never get the default namespace');
  assert.equal(attribute.normalizedValue, '1');
  const child = root.children()[0].element()!;
  assert.equal(child.expanded()!.namespace, 'urn:app', 'default namespace is inherited by elements');
});

test('xml.formation.prefixed-namespace-resolution: in-scope bindings resolve prefixed names (xml-1-0-safe-v1.json:30-40)', () => {
  const source = '<p:root xmlns:p="urn:one"><p:child xmlns:q="urn:two" q:attr="x"/></p:root>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Complete');
  const root = document.root()!;
  assert.equal(root.expanded()!.namespace, 'urn:one');
  const child = root.children()[0].element()!;
  assert.equal(child.expanded()!.namespace, 'urn:one', 'parent bindings stay in scope');
  assert.equal(child.attributes()[0].expanded!.namespace, 'urn:two');
  assert.equal(root.qname().prefix, 'p');
  assert.equal(root.qname().local, 'root');
});

test('xml.formation.predefined-and-character-references: fragments resolve with provenance (xml-1-0-safe-v1.json:42-52)', () => {
  const source = '<root>a &lt; b &amp; c &#65;</root>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Complete');
  const root = document.root()!;
  const text = root.children()[0].text()!;
  assert.equal(textSemantic(text), 'a < b & c A');
  assert.equal(text.fragments.length, 6);
  assert.equal(text.fragments[1].kind, 'PredefinedEntity');
  assert.equal(text.fragments[5].kind, 'CharacterReference');
});

test('xml.formation.internal-entity-expansion: admitted internal general entities expand (xml-1-0-safe-v1.json:54-64)', () => {
  const source = '<!DOCTYPE root [<!ENTITY greeting "hello">]><root>&greeting;</root>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Complete');
  const doctype = document.doctype()!;
  assert.equal(doctype.name.local, 'root');
  assert.equal(doctype.entities.length, 1);
  assert.equal(doctype.entities[0].name, 'greeting');
  assert.equal(doctype.entities[0].replacement, 'hello');
  const root = document.root()!;
  const text = root.children()[0].text()!;
  assert.equal(textSemantic(text), 'hello');
  assert.equal(text.fragments[0].kind, 'GeneralEntity');
});

test('xml.formation.mixed-content-order: ordered content never sorted or grouped (xml-1-0-safe-v1.json:66-76)', () => {
  const source = '<root>a<child/>b<![CDATA[c]]><!--d--><?pi e?>f</root>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Complete');
  const root = document.root()!;
  const kinds = root.children().map((item) => item.contentInternal().kind);
  assert.deepEqual(kinds, ['Text', 'Element', 'Text', 'Cdata', 'Comment', 'ProcessingInstruction', 'Text']);
  const texts = root.children().filter((item) => item.text() !== null).map((item) => textSemantic(item.text()!));
  assert.deepEqual(texts, ['a', 'b', 'f']);
});

test('xml.formation.crlf-semantic-normalization: CRLF preserved raw, normalized to LF semantically (xml-1-0-safe-v1.json:78-88)', () => {
  const source = '<root>line1\r\nline2</root>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(new TextDecoder().decode(document.render()), source, 'raw CRLF spelling survives');
  const root = document.root()!;
  assert.equal(textSemantic(root.children()[0].text()!), 'line1\nline2');
});

test('xml.formation.utf16le-with-bom: UTF-16LE byte-exact round trip (xml-1-0-safe-v1.json:90-101)', () => {
  const source = '<root>中文</root>';
  const input = utf16LeBytes(source);
  const document = parse(input, PROFILE_XML_SAFE, { kind: 'ProfileDefault' }, DEFAULT_XML_PARSE_LIMITS);
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(
    toHex(document.render()),
    'fffe3c0072006f006f0074003e002d4e87653c002f0072006f006f0074003e00',
    'render_hex from the vector',
  );
  const root = document.root()!;
  assert.equal(textSemantic(root.children()[0].text()!), '中文');
  // Raw spans stay byte-exact: the text piece covers exactly the UTF-16LE
  // bytes of 中文 (2 + 6*2 = 14 through 2 + 8*2 = 18), with no transcoding
  // drift between decoded and raw coordinates.
  const index = document.losslessStructuralIndex()!;
  const textPiece = index
    .pieces()
    .find((piece, ordinal) => document.losslessSyntaxKinds()[ordinal] === 'text')!;
  assert.equal(textPiece.span().startByte(), 14);
  assert.equal(textPiece.span().endByte(), 18);
});

test('xml.formation.duplicate-expanded-attribute-recovered: expanded-name uniqueness (xml-1-0-safe-v1.json:103-113)', () => {
  const source = '<root xmlns:p="urn:u" xmlns:q="urn:u" p:a="1" q:a="2"/>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(
    document.diagnostics().some((diagnostic) => diagnostic.code === 'xml.namespace.duplicate-attribute@1'),
  );
  assert.equal(new TextDecoder().decode(document.render()), source);
});

test('xml.formation.unbound-prefix-recovered: unbound prefixes are recovered, never fatal (xml-1-0-safe-v1.json:115-125)', () => {
  const source = '<p:root/>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(
    document.diagnostics().some((diagnostic) => diagnostic.code === 'xml.namespace.unbound-prefix@1'),
  );
  assert.equal(new TextDecoder().decode(document.render()), source);
});

test('xml.formation.external-subset-recovered: SYSTEM/PUBLIC external subsets are denied (xml-1-0-safe-v1.json:127-137)', () => {
  const source = '<!DOCTYPE root SYSTEM "http://evil.example/x.dtd"><root/>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(
    document.diagnostics().some((diagnostic) => diagnostic.code === 'xml.dtd.external-subset@1'),
  );
});

test('xml.formation.unknown-entity-recovered: unknown references never fabricate text (xml-1-0-safe-v1.json:139-149)', () => {
  const source = '<root>&unknown;</root>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(document.diagnostics().some((diagnostic) => diagnostic.code === 'xml.entity.unknown@1'));
  const root = document.root()!;
  assert.equal(textSemantic(root.children()[0].text()!), '');
});

test('xml.formation.missing-root-recovered: no root is recovered with a stable diagnostic (xml-1-0-safe-v1.json:151-161)', () => {
  const source = '<?xml version="1.0"?><!-- nothing -->';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(document.diagnostics().some((diagnostic) => diagnostic.code === 'xml.tree.missing-root@1'));
  assert.equal(document.root(), null);
});

test('xml.formation.dtd-comment-not-excluded-markup: comment text is character data (xml-1-0-safe-v1.json:163-173)', () => {
  const source = '<!DOCTYPE root [<!-- <!ELEMENT not-a-decl> -->]><root/>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.diagnostics(), []);
});

test('xml.limit.entity-amplification-recovered: amplification ratio bounds expansion (xml-1-0-safe-v1.json:568-579)', () => {
  const source = '<!DOCTYPE root [<!ENTITY a "xxxxxxxxxxxxxxxxxxxx">]><root>&a;&a;&a;&a;&a;&a;</root>';
  const limits: XmlParseLimits = { ...DEFAULT_XML_PARSE_LIMITS, maxEntityAmplificationRatio: 2 };
  const document = parseXml(source, limits);
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(
    document.diagnostics().some((diagnostic) => diagnostic.code === 'xml.entity.amplification@1'),
  );
  const root = document.root()!;
  const text = root.children()[0].text()!;
  // Two references succeed; the rest are bounded by the ratio.
  assert.equal(text.fragments.length, 2);
});

test('xml.limit.mixed-content-diagnostic: the mixed-content budget publishes a diagnostic for every drop (xml-1-0-safe-v1.json:581-592)', () => {
  const source = '<root>a<child/></root>';
  const limits: XmlParseLimits = { ...DEFAULT_XML_PARSE_LIMITS, maxMixedContentItems: 1 };
  const document = parseXml(source, limits);
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(document.diagnostics().some((diagnostic) => diagnostic.code === 'xml.limit.mixed-content@1'));
  const root = document.root()!;
  assert.equal(root.children().length, 1, 'the second content item is dropped under the budget');
});

// ---------------------------------------------------------------------------
// Entity deny boundary (RFC 0012 §3)
// ---------------------------------------------------------------------------

test('entity deny: parameter entities, external entities, and markup-generating values are Recovered', () => {
  const parameter = '<!DOCTYPE root [<!ENTITY % p "x">]><root/>';
  const document = parseXml(parameter);
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(document.diagnostics().some((diagnostic) => diagnostic.code === 'xml.dtd.parameter-entity@1'));

  const external = '<!DOCTYPE root [<!ENTITY ext SYSTEM "file:///etc/passwd">]><root/>&ext;</root>';
  const document2 = parseXml(external);
  assert.equal(document2.formationStatus(), 'Recovered');
  assert.ok(document2.diagnostics().some((diagnostic) => diagnostic.code === 'xml.dtd.external-entity@1'));

  const markup = '<!DOCTYPE root [<!ENTITY bad "<b>">]><root/>';
  const document3 = parseXml(markup);
  assert.equal(document3.formationStatus(), 'Recovered');
  assert.ok(document3.diagnostics().some((diagnostic) => diagnostic.code === 'xml.entity.markup@1'));
});

test('entity deny: reserved and duplicate names never override predefined entities', () => {
  const reserved = '<!DOCTYPE root [<!ENTITY lt "x">]><root>&lt;</root>';
  const document = parseXml(reserved);
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(document.diagnostics().some((diagnostic) => diagnostic.code === 'xml.entity.reserved-name@1'));
  const root = document.root()!;
  assert.equal(textSemantic(root.children()[0].text()!), '<', 'predefined meaning wins');

  const duplicate = '<!DOCTYPE root [<!ENTITY a "1"><!ENTITY a "2">]><root>&a;</root>';
  const document2 = parseXml(duplicate);
  assert.equal(document2.formationStatus(), 'Recovered');
  assert.ok(document2.diagnostics().some((diagnostic) => diagnostic.code === 'xml.entity.duplicate@1'));
  assert.equal(textSemantic(document2.root()!.children()[0].text()!), '1', 'the first declaration wins');
});

test('entity expansion never performs external I/O: nested internal references resolve deterministically', () => {
  const source = '<!DOCTYPE root [<!ENTITY name "world"><!ENTITY greeting "hello &name;">]><root>&greeting;</root>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Complete');
  const root = document.root()!;
  assert.equal(textSemantic(root.children()[0].text()!), 'hello world');
  const fragment = root.children()[0].text()!.fragments[0];
  assert.equal(fragment.kind, 'GeneralEntity');
  assert.ok(!fragment.declarationSpan.isEmpty(), 'declaration provenance span is recorded');
});

// ---------------------------------------------------------------------------
// Namespace constraints (RFC 0012 §5)
// ---------------------------------------------------------------------------

test('namespace: xml is permanently bound, xmlns is reserved, and the default cannot be the xmlns URI', () => {
  const xmlPrefix = '<root xml:lang="en"/>';
  const document = parseXml(xmlPrefix);
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(document.root()!.attributes()[0].expanded!.namespace, 'http://www.w3.org/XML/1998/namespace');

  const rebound = '<root xmlns:xml="urn:wrong"/>';
  const document2 = parseXml(rebound);
  assert.equal(document2.formationStatus(), 'Recovered');
  assert.ok(document2.diagnostics().some((diagnostic) => diagnostic.code === 'xml.namespace.xml-rebinding@1'));

  const defaultXmlns = '<root xmlns="http://www.w3.org/2000/xmlns/"/>';
  const document3 = parseXml(defaultXmlns);
  assert.equal(document3.formationStatus(), 'Recovered');
  assert.ok(document3.diagnostics().some((diagnostic) => diagnostic.code === 'xml.namespace.default-xmlns@1'));

  const reserved = '<root xmlns:x="urn:u" xmlns:xmlns="urn:u"/>';
  const document4 = parseXml(reserved);
  assert.equal(document4.formationStatus(), 'Recovered');
  assert.ok(document4.diagnostics().some((diagnostic) => diagnostic.code === 'xml.namespace.reserved-prefix@1'));
});

test('namespace: declarations apply to the whole element regardless of attribute order', () => {
  const source = '<p:root p:a="1" xmlns:p="urn:late"/>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Complete', 'the declaration on the element applies to every attribute');
  assert.equal(document.root()!.expanded()!.namespace, 'urn:late');
  assert.equal(document.root()!.attributes()[0].expanded!.namespace, 'urn:late');
});

// ---------------------------------------------------------------------------
// Byte-exact span closure
// ---------------------------------------------------------------------------

test('byte-exact spans: exhaustive ordered piece coverage with no holes (Rust probe, parser.rs:2412-2435)', () => {
  const source = '<?xml version="1.0" standalone="yes"?>\n<!DOCTYPE p:root [<!ENTITY e "x"><!-- <!ELEMENT nope> --><?pi dtd?>]>\n<p:root xmlns:p="urn:p" p:a="v &amp; w">t &lt; u &#65;<b/>\n  <![CDATA[c]]><!--h--><?tail after?></p:root>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Complete');
  assert.deepEqual(document.diagnostics(), []);
  const index = document.losslessStructuralIndex()!;
  const pieces = index.pieces();
  assert.equal(pieces[0].span().startByte(), 0);
  assert.equal(pieces[pieces.length - 1].span().endByte(), source.length);
  let next = 0;
  for (const piece of pieces) {
    assert.equal(piece.span().startByte(), next, 'no holes in piece coverage');
    next = piece.span().endByte();
  }
  assert.equal(next, source.length);
  assert.equal(document.losslessSyntaxKinds().length, pieces.length);
});

test('byte-exact spans: the fine-grained kind sequence matches the Rust crate (probed at write time)', () => {
  const source = '<?xml version="1.0" standalone="yes"?>\n<!DOCTYPE p:root [<!ENTITY e "x"><!-- <!ELEMENT nope> --><?pi dtd?>]>\n<p:root xmlns:p="urn:p" p:a="v &amp; w">t &lt; u &#65;<b/>\n  <![CDATA[c]]><!--h--><?tail after?></p:root>';
  const document = parseXml(source);
  const kinds = pieceKinds(document).map((piece) => `${piece.kind}:${JSON.stringify(piece.text)}`);
  const expected = [
    'declaration-open:"<?xml"',
    'whitespace:" "',
    'declaration-name:"version"',
    'whitespace:"=\\""',
    'declaration-value:"1.0"',
    'whitespace:"\\" "',
    'declaration-name:"standalone"',
    'whitespace:"=\\""',
    'declaration-value:"yes"',
    'whitespace:"\\""',
    'declaration-close:"?>"',
    'whitespace:"\\n"',
    'doctype-open:"<!DOCTYPE"',
    'whitespace:" "',
    'doctype-name:"p:root"',
    'whitespace:" ["',
    'dtd-markup:"<!ENTITY e \\"x\\">"',
    'dtd-markup:"<!-- <!ELEMENT nope> -->"',
    'dtd-markup:"<?pi dtd?>"',
    'doctype-close:"]>"',
    'whitespace:"\\n"',
    'tag-open:"<"',
    'prefix:"p"',
    'colon:":"',
    'local-name:"root"',
    'whitespace:" "',
    'namespace-declaration:"xmlns:p"',
    'equals:"="',
    'quote:"\\""',
    'attribute-value:"urn:p"',
    'quote:"\\""',
    'whitespace:" "',
    'attribute-name:"p:a"',
    'equals:"="',
    'quote:"\\""',
    'attribute-value:"v "',
    'entity-reference:"&amp;"',
    'attribute-value:" w"',
    'quote:"\\""',
    'tag-close:">"',
    'text:"t "',
    'entity-reference:"&lt;"',
    'text:" u "',
    'character-reference:"&#65;"',
    'tag-open:"<"',
    'local-name:"b"',
    'empty-element-close:"/>"',
    'line-break:"\\n"',
    'whitespace:"  "',
    'cdata-open:"<![CDATA["',
    'cdata-text:"c"',
    'cdata-close:"]]>"',
    'comment-open:"<!--"',
    'comment-text:"h"',
    'comment-close:"-->"',
    'processing-instruction-open:"<?"',
    'processing-instruction-target:"tail"',
    'whitespace:" "',
    'processing-instruction-content:"after"',
    'processing-instruction-close:"?>"',
    'end-tag-open:"</"',
    'prefix:"p"',
    'colon:":"',
    'local-name:"root"',
    'tag-close:">"',
  ];
  assert.deepEqual(kinds, expected);
});

test('byte-exact spans: a tokenizer-level failure recovers at the final byte and stops (parser.rs:255-269)', () => {
  const source = '<root/></root>';
  const document = parseXml(source);
  assert.equal(document.formationStatus(), 'Recovered');
  assert.ok(document.diagnostics().some((diagnostic) => diagnostic.code === 'xml.syntax.well-formedness@1'));
  const kinds = pieceKinds(document);
  assert.deepEqual(
    kinds.map((piece) => piece.kind),
    ['tag-open', 'local-name', 'empty-element-close', 'error-region', 'error-region'],
  );
  assert.deepEqual(kinds.slice(3).map((piece) => piece.text), ['</root', '>']);
});

test('fatal: UTF-16 without a BOM is rejected even with explicit endianness (RFC 0012 §2 :63-64)', () => {
  const text = '<root/>';
  const units: number[] = [];
  for (let index = 0; index < text.length; index++) {
    units.push(text.charCodeAt(index));
  }
  const input = new Uint8Array(units.length * 2);
  for (let index = 0; index < units.length; index++) {
    input[index * 2] = units[index] & 0xff;
    input[index * 2 + 1] = (units[index] >> 8) & 0xff;
  }
  assert.throws(
    () => parse(input, PROFILE_XML_SAFE, { kind: 'Explicit', encoding: { kind: 'Utf16Le' } }, DEFAULT_XML_PARSE_LIMITS),
    (error: unknown) => {
      assert.ok(error instanceof FatalFormationFailure);
      assert.equal(error.diagnostics()[0].code, 'xml.profile.encoding@1');
      return true;
    },
  );
});

test('fatal: excluded encodings are profile violations, not recoveries (RFC 0012 §2 :65-67)', () => {
  assert.throws(
    () => parse(bytes('<root/>'), PROFILE_XML_SAFE, { kind: 'Explicit', encoding: { kind: 'Latin1' } }, DEFAULT_XML_PARSE_LIMITS),
    (error: unknown) => {
      assert.ok(error instanceof FatalFormationFailure);
      assert.equal(error.diagnostics()[0].code, 'xml.profile.encoding@1');
      return true;
    },
  );
});
