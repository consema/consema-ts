/**
 * Intent documents for XML structural edit (L3).
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id — plus the atomic-commit algebra (RFC 0004 §13): wrong
 * snapshot, root removal, duplicate expanded attributes, dry-run
 * replacement-set equality, and the untouched-byte proof.
 *  - conformance/vectors/xml-1-0-safe-v1.json: xml.edit.set-attribute-
 *    value (:437-453), xml.edit.insert-and-remove-element (:455-475),
 *    xml.edit.rename-element-both-tags (:477-493),
 *    xml.edit.insert-attribute-end (:495-513), xml.edit.remove-attribute
 *    (:515-530), xml.edit.replace-text-occurrence (:532-548),
 *    xml.edit.rename-attribute (:550-566)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse, PROFILE_XML_SAFE } from '../xml/index.ts';
import { commit, dryRun, EditTransactionBuilder, NameFacts } from '../xml/index.ts';
import { EditFailure } from '../xml/index.ts';
import { DEFAULT_XML_PARSE_LIMITS } from '../xml/profile.ts';
import { EditPlanSourceId } from '../document/edit_plan.ts';

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function parseXml(source: string) {
  return parse(bytes(source), PROFILE_XML_SAFE, { kind: 'ProfileDefault' }, DEFAULT_XML_PARSE_LIMITS);
}

function render(document: ReturnType<typeof parseXml>): string {
  return new TextDecoder().decode(document.render());
}

function textNodes(document: ReturnType<typeof parseXml>) {
  const out: { ordinal: number; span: { startByte(): number; endByte(): number } }[] = [];
  for (const node of document.nodes()) {
    if (node.kind === 'Text') {
      out.push({ ordinal: node.data.ordinal, span: node.data.span });
    }
  }
  return out;
}

test('xml.edit.set-attribute-value: replaces the semantic value in place (xml-1-0-safe-v1.json:437-453)', () => {
  const document = parseXml('<root a="1"/>');
  const attribute = document.root()!.attributes()[0];
  const transaction = new EditTransactionBuilder(document)
    .setAttributeValue(document.occurrenceNodeRef(attribute.ordinal, 'XmlAttribute'), '2')
    .build();
  const committed = commit(document, transaction);
  assert.equal(render(committed.document()), '<root a="2"/>');
  assert.equal(committed.changeSet().nodeMappings().length, 1);
  // Attribute associations are not content nodes; find_node_by_span scans
  // the content arena only, so the mapping is Unmapped exactly like the
  // Rust (edit.rs:1310-1336).
  assert.equal(committed.changeSet().nodeMappings()[0].status(), 'Unmapped');
});

test('xml.edit.insert-and-remove-element: two operations in one atomic transaction (xml-1-0-safe-v1.json:455-475)', () => {
  const document = parseXml('<root><a/></root>');
  const root = document.root()!;
  const rootNode = document.nodeAt(root.rawIndex());
  assert.equal(rootNode.kind, 'Element');
  const childIndex = rootNode.data.children[0];
  const transaction = new EditTransactionBuilder(document)
    .insertElement(root.nodeRef(), new NameFacts(null, 'x', null), 'c', { kind: 'End' })
    .removeElement(document.nodeRefFor(childIndex, 'XmlElement'))
    .build();
  const committed = commit(document, transaction);
  assert.equal(render(committed.document()), '<root><x>c</x></root>');
});

test('xml.edit.rename-element-both-tags: both start and end tags are renamed (xml-1-0-safe-v1.json:477-493)', () => {
  const document = parseXml('<old><child>t</child></old>');
  const transaction = new EditTransactionBuilder(document)
    .renameElement(document.root()!.nodeRef(), new NameFacts(null, 'new', null))
    .build();
  const committed = commit(document, transaction);
  assert.equal(render(committed.document()), '<new><child>t</child></new>');
});

test('xml.edit.insert-attribute-end: appends before the tag close (xml-1-0-safe-v1.json:495-513)', () => {
  const document = parseXml('<root a="1"/>');
  const transaction = new EditTransactionBuilder(document)
    .insertAttribute(document.root()!.nodeRef(), new NameFacts(null, 'b', null), '2', { kind: 'End' })
    .build();
  const committed = commit(document, transaction);
  assert.equal(render(committed.document()), '<root a="1" b="2"/>');
});

test('xml.edit.remove-attribute: removes the association with its leading whitespace (xml-1-0-safe-v1.json:515-530)', () => {
  const document = parseXml('<root a="1" b="2"/>');
  const attribute = document.root()!.attributes()[1];
  const transaction = new EditTransactionBuilder(document)
    .removeAttribute(document.occurrenceNodeRef(attribute.ordinal, 'XmlAttribute'))
    .build();
  const committed = commit(document, transaction);
  assert.equal(render(committed.document()), '<root a="1"/>');
  assert.equal(committed.changeSet().nodeMappings()[0].status(), 'Deleted');
});

test('xml.edit.replace-text-occurrence: targets one exact text occurrence (xml-1-0-safe-v1.json:532-548)', () => {
  const document = parseXml('<root><a>one</a><b>two</b></root>');
  const texts = textNodes(document);
  assert.equal(texts.length, 2);
  const transaction = new EditTransactionBuilder(document)
    .replaceText(document.occurrenceNodeRef(texts[1].ordinal, 'XmlText'), 'TWO')
    .build();
  const committed = commit(document, transaction);
  assert.equal(render(committed.document()), '<root><a>one</a><b>TWO</b></root>');
});

test('xml.edit.rename-attribute: renames the name and preserves the value (xml-1-0-safe-v1.json:550-566)', () => {
  const document = parseXml('<root a="1"/>');
  const attribute = document.root()!.attributes()[0];
  const transaction = new EditTransactionBuilder(document)
    .renameAttribute(
      document.occurrenceNodeRef(attribute.ordinal, 'XmlAttribute'),
      new NameFacts(null, 'renamed', null),
    )
    .build();
  const committed = commit(document, transaction);
  assert.equal(render(committed.document()), '<root renamed="1"/>');
});

// ---------------------------------------------------------------------------
// Transaction algebra (RFC 0004 §13-15)
// ---------------------------------------------------------------------------

test('edit: new literal content is XML-escaped, never interpolated as markup', () => {
  const document = parseXml('<root><a>one</a></root>');
  const texts = textNodes(document);
  const transaction = new EditTransactionBuilder(document)
    .replaceText(document.occurrenceNodeRef(texts[0].ordinal, 'XmlText'), 'a < b & c')
    .build();
  const committed = commit(document, transaction);
  assert.equal(render(committed.document()), '<root><a>a &lt; b &amp; c</a></root>');
});

test('edit: the document root cannot be removed (edit.rs:1009-1030)', () => {
  const document = parseXml('<root/>');
  const transaction = new EditTransactionBuilder(document)
    .removeElement(document.root()!.nodeRef())
    .build();
  assert.throws(
    () => commit(document, transaction),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'CannotRemoveRoot');
      assert.equal(error.code, 'core.edit.cannot-remove-root@1');
      return true;
    },
  );
});

test('edit: a duplicate expanded attribute is rejected before commit (edit.rs:1290-1306)', () => {
  const document = parseXml('<p:root xmlns:p="urn:p" p:a="1"/>');
  const transaction = new EditTransactionBuilder(document)
    .insertAttribute(document.root()!.nodeRef(), new NameFacts('p', 'a', 'urn:p'), '2', { kind: 'End' })
    .build();
  assert.throws(
    () => commit(document, transaction),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'DuplicateExpandedAttribute');
      assert.equal(error.code, 'core.edit.duplicate-expanded-attribute@1');
      return true;
    },
  );
});

test('edit: an unprefixed duplicate without a namespace fails the reparse closure, like the Rust (edit.rs:1294-1296)', () => {
  // reject_duplicate_attribute can only prove duplicates for resolvable
  // expanded names; an unprefixed duplicate fails at the reparse closure
  // with NewDocumentFormationFailed exactly like the Rust crate.
  const document = parseXml('<root a="1"/>');
  const transaction = new EditTransactionBuilder(document)
    .insertAttribute(document.root()!.nodeRef(), new NameFacts(null, 'a', null), '2', { kind: 'End' })
    .build();
  assert.throws(
    () => commit(document, transaction),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'NewDocumentFormationFailed');
      assert.equal(error.code, 'core.edit.formation-failed@1');
      return true;
    },
  );
});

test('edit: a stale transaction is rejected with core.edit.wrong-snapshot@1 (edit.rs:414-416)', () => {
  const document = parseXml('<root a="1"/>');
  const transaction = new EditTransactionBuilder(document)
    .setAttributeValue(document.occurrenceNodeRef(document.root()!.attributes()[0].ordinal, 'XmlAttribute'), '2')
    .build();
  const committed = commit(document, transaction);
  const stale = new EditTransactionBuilder(committed.document())
    .setAttributeValue(document.occurrenceNodeRef(document.root()!.attributes()[0].ordinal, 'XmlAttribute'), '3')
    .build();
  assert.throws(
    () => commit(document, stale),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'WrongSnapshot');
      assert.equal(error.code, 'core.edit.wrong-snapshot@1');
      return true;
    },
  );
});

test('edit: conflicting edits on one target fail before commit (edit.rs:597-641)', () => {
  const document = parseXml('<root a="1"/>');
  const attribute = document.root()!.attributes()[0];
  const attributeRef = document.occurrenceNodeRef(attribute.ordinal, 'XmlAttribute');
  const transaction = new EditTransactionBuilder(document)
    .setAttributeValue(attributeRef, '2')
    .renameAttribute(attributeRef, new NameFacts(null, 'b', null))
    .build();
  assert.throws(
    () => commit(document, transaction),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'ConflictingEdits');
      assert.equal(error.code, 'core.edit.conflicting-edits@1');
      return true;
    },
  );
});

test('edit: dry-run and commit produce identical replacement sets and target digest (RFC 0004 §14)', () => {
  const document = parseXml('<root a="1"/>');
  const attribute = document.root()!.attributes()[0];
  const transaction = new EditTransactionBuilder(document)
    .setAttributeValue(document.occurrenceNodeRef(attribute.ordinal, 'XmlAttribute'), '2')
    .build();
  const committed = commit(document, transaction);
  const plan = dryRun(document, transaction, new EditPlanSourceId('intent.xml'));
  assert.equal(plan.targetDigest().equals(committed.sourcePatch().targetDigest()), true);
  assert.equal(plan.replacements().length, committed.sourcePatch().replacements().length);
  for (let index = 0; index < plan.replacements().length; index++) {
    assert.equal(
      plan.replacements()[index].original().length,
      committed.sourcePatch().replacements()[index].original().length,
    );
  }
});

test('edit: the untouched-byte proof verifies for the committed transition (RFC 0004 §15)', () => {
  const document = parseXml('<root a="1"/>');
  const attribute = document.root()!.attributes()[0];
  const transaction = new EditTransactionBuilder(document)
    .setAttributeValue(document.occurrenceNodeRef(attribute.ordinal, 'XmlAttribute'), '2')
    .build();
  const committed = commit(document, transaction);
  committed.untouchedProof().verify(
    document.source(),
    committed.document().source(),
    committed.sourcePatch().replacements(),
  );
});

test('edit: a Recovered document cannot be edited (edit.rs:417-419)', () => {
  const document = parseXml('<root>&unknown;</root>');
  const transaction = new EditTransactionBuilder(document).build();
  assert.throws(
    () => commit(document, transaction),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'IncompleteTarget');
      assert.equal(error.code, 'core.edit.incomplete-target@1');
      return true;
    },
  );
});

test('edit: an unbound prefix in name facts is rejected (edit.rs:1189-1255)', () => {
  const document = parseXml('<root/>');
  const transaction = new EditTransactionBuilder(document)
    .insertAttribute(document.root()!.nodeRef(), new NameFacts('p', 'a', 'urn:unbound'), '1', { kind: 'End' })
    .build();
  assert.throws(
    () => commit(document, transaction),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'UnboundPrefix');
      assert.equal(error.code, 'core.edit.unbound-prefix@1');
      return true;
    },
  );
});

test('edit: a prefixed name requires its promised binding in scope', () => {
  const document = parseXml('<p:root xmlns:p="urn:p"/>');
  const transaction = new EditTransactionBuilder(document)
    .insertAttribute(document.root()!.nodeRef(), new NameFacts('p', 'a', 'urn:p'), '1', { kind: 'End' })
    .build();
  const committed = commit(document, transaction);
  assert.equal(render(committed.document()), '<p:root xmlns:p="urn:p" p:a="1"/>');
  const wrong = new EditTransactionBuilder(document)
    .insertAttribute(document.root()!.nodeRef(), new NameFacts('p', 'b', 'urn:other'), '1', { kind: 'End' })
    .build();
  assert.throws(
    () => commit(document, wrong),
    (error: unknown) => {
      assert.ok(error instanceof EditFailure);
      assert.equal(error.kind, 'UnboundPrefix');
      return true;
    },
  );
});
