/**
 * Snapshot-bound XML structural edit (RFC 0012 §11).
 *
 * authority: crates/consema-xml/src/edit.rs
 *  - the eight versioned operations :1-29 (frozen by RFC 0012 §11 :375-403):
 *    xml.edit.replace-text@1 | insert-attribute@1 | remove-attribute@1 |
 *    rename-attribute@1 | set-attribute-value@1 | insert-element@1 |
 *    remove-element@1 | rename-element@1
 *  - NameFacts :62-89, AttributePlacement :91-100, ContentPlacement
 *    :102-111, EditOperation :113-176, EditTransaction :178-197,
 *    EditTransactionBuilder :199-304, EditCommit :306-317, EditFailure
 *    :319-360, StableFailure :362-408 (kind→code map :388-408)
 *  - Document::commit :410-570 (WrongSnapshot :414-416, IncompleteTarget
 *    :417-419, validate_dependencies :420, prepare + overlap checks
 *    :425-443, target length :444-454, render + reparse :455-476,
 *    source edits + node mappings :477-540, ChangeSet :541-547,
 *    SourcePatch.derive :548-557, UntouchedByteProof :558-563),
 *    Document::dry_run :572-588
 *  - validate_dependencies :597-641 (duplicate targets and placement
 *    anchors), char_width :643-649, empty_element_tag_close :651-664,
 *    push_encoded_text :666-687, spelling_bytes :696-715, escape_text
 *    :717-728, escape_attribute :730-743
 *  - prepare_* :745-1070 (prepare_replace_text :778-790, insert_attribute
 *    :792-862, remove_attribute :864-876, rename_attribute :878-914,
 *    set_attribute_value :916-928, insert_element :930-1007,
 *    remove_element :1009-1030, rename_element :1032-1070),
 *    element_for :1073-1087, attribute_for :1090-1098, text_for :1101-1108,
 *    content_extent_end :1112-1144, content_span_for :1147-1186,
 *    validate_name_facts :1189-1255, expanded_name_for_facts :1258-1287,
 *    reject_duplicate_attribute :1290-1306
 *  - find_node_by_span :1310-1336, leading_whitespace_start :1338-1344,
 *    source_patch_limits :1346-1356, operation_metadata :1358-1370,
 *    operation_id :1372-1383, operation_summaries :1385-1435,
 *    occurrence iterators :1438-1497
 *  - frozen codes: crates/consema-xml/src/edit.rs:388-408 (the core.edit.*
 *    codes; the XML-specific ones are pinned by this file per RFC 0012 §12)
 *  - the ReplaceText vocabulary boundary: XML ReplaceText excludes CDATA —
 *    `xml.edit.replace-text@1` targets exactly one `xml.text@1` occurrence
 *    (operation_registry.rs:18-23) — a documented boundary of the v1
 *    operation set (RFC 0012 §11 :395-397)
 *  - vector-pinned behavior: conformance/vectors/xml-1-0-safe-v1.json
 *    (all xml.edit.* cases)
 *
 * Design (TypeScript-idiomatic): one immutable transaction binds one base
 * snapshot; every operation is fully validated before any output is
 * published. Validation, source-edit preparation, output allocation,
 * reparse, mapping, untouched proof, and SourcePatch derivation form one
 * atomic commit — a failure returns none of the successful artifacts
 * (RFC 0004 §13).
 */

import type { NodeRef, NodeRole, Span } from '../document/identity.ts';
import { ChangeSet, NodeMapping, SourceEdit } from '../document/change_set.ts';
import type { NodeMappingStatus } from '../document/change_set.ts';
import { EditOperationSummary, EditPlan, EditPlanSourceId } from '../document/edit_plan.ts';
import { FormatOperationId } from '../document/operation.ts';
import type { SourceLimits, SourceEncoding } from '../document/source.ts';
import { SourcePatch } from '../document/source_patch.ts';
import type { SourcePatchLimits } from '../document/source_patch.ts';
import { UntouchedByteProof } from '../document/untouched_proof.ts';
import { EditFailure } from './errors.ts';
import { XmlDocument } from './document.ts';
import type { QNameFacts, XmlAttributeData, XmlContent, XmlElementData, XmlTextData } from './document.ts';
import { XML_NAMESPACE_URI } from './namespace.ts';
import type { ExpandedName } from './namespace.ts';
import type { XmlEncodingSelection, XmlParseLimits } from './profile.ts';
import { parse } from './parser.ts';

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * A validated element or attribute name for structural operations
 * (edit.rs:62-89). The prefix must already be bound to `namespace` in the
 * target's in-scope scope; the edit never guesses or fabricates namespace
 * declarations.
 */
export class NameFacts {
  readonly #prefix: string | null;
  readonly #local: string;
  readonly #namespace: string | null;

  /** Creates name facts from an already validated prefix/local pair (edit.rs:72-81). */
  constructor(prefix: string | null, local: string, namespace: string | null) {
    this.#prefix = prefix;
    this.#local = local;
    this.#namespace = namespace;
  }

  /** Prefix spelling; `null` is an unprefixed name. */
  prefix(): string | null {
    return this.#prefix;
  }

  /** Local name. */
  local(): string {
    return this.#local;
  }

  /** Namespace URI the prefix must resolve to; `null` forbids a prefix. */
  namespace(): string | null {
    return this.#namespace;
  }

  /** Full lexical spelling (edit.rs:83-88). */
  spelling(): string {
    return this.#prefix === null ? this.#local : `${this.#prefix}:${this.#local}`;
  }
}

/** Attribute insertion placement inside one start tag (edit.rs:91-100). */
export type AttributePlacement =
  | { readonly kind: 'Before'; readonly anchor: NodeRef }
  | { readonly kind: 'After'; readonly anchor: NodeRef }
  | { readonly kind: 'End' };

/** Content insertion placement inside one element (edit.rs:102-111). */
export type ContentPlacement =
  | { readonly kind: 'Before'; readonly anchor: NodeRef }
  | { readonly kind: 'After'; readonly anchor: NodeRef }
  | { readonly kind: 'End' };

/** One snapshot-bound XML structural operation (edit.rs:113-176). */
export type EditOperation =
  | {
      readonly kind: 'ReplaceText';
      /** Text occurrence. */
      readonly target: NodeRef;
      /** New literal character data. */
      readonly text: string;
    }
  | {
      readonly kind: 'InsertAttribute';
      /** Owning element. */
      readonly target: NodeRef;
      /** Validated name facts. */
      readonly name: NameFacts;
      /** Semantic attribute value. */
      readonly value: string;
      /** Explicit placement. */
      readonly placement: AttributePlacement;
    }
  | {
      readonly kind: 'RemoveAttribute';
      /** Attribute association. */
      readonly target: NodeRef;
    }
  | {
      readonly kind: 'RenameAttribute';
      /** Attribute association. */
      readonly target: NodeRef;
      /** New validated name facts. */
      readonly name: NameFacts;
    }
  | {
      readonly kind: 'SetAttributeValue';
      /** Attribute association. */
      readonly target: NodeRef;
      /** New semantic value. */
      readonly value: string;
    }
  | {
      readonly kind: 'InsertElement';
      /** Owning element. */
      readonly target: NodeRef;
      /** Validated element name facts. */
      readonly name: NameFacts;
      /** Optional literal text content; `null` writes an empty element. */
      readonly content: string | null;
      /** Explicit placement. */
      readonly placement: ContentPlacement;
    }
  | {
      readonly kind: 'RemoveElement';
      /** Element occurrence. */
      readonly target: NodeRef;
    }
  | {
      readonly kind: 'RenameElement';
      /** Element occurrence. */
      readonly target: NodeRef;
      /** New validated name facts. */
      readonly name: NameFacts;
    };

/** Immutable snapshot-bound transaction (edit.rs:178-197). */
export class EditTransaction {
  readonly #base: bigint;
  readonly #operations: readonly EditOperation[];

  /** @internal — construction is via `EditTransactionBuilder.build`. */
  constructor(base: bigint, operations: readonly EditOperation[]) {
    this.#base = base;
    this.#operations = Object.freeze([...operations]);
  }

  /** Base snapshot identity (edit.rs:183-187). */
  baseSnapshot(): bigint {
    return this.#base;
  }

  /** Ordered operations (edit.rs:189-193). */
  operations(): readonly EditOperation[] {
    return this.#operations;
  }
}

/** Builds one transaction against one immutable snapshot (edit.rs:199-204). */
export class EditTransactionBuilder {
  readonly #base: bigint;
  readonly #operations: EditOperation[] = [];

  /** Creates a builder bound to one snapshot (edit.rs:206-214). */
  constructor(document: XmlDocument) {
    this.#base = document.snapshotIdentity().asBigInt();
  }

  /** Replaces one text occurrence with new literal content (edit.rs:215-223). */
  replaceText(target: NodeRef, text: string): EditTransactionBuilder {
    this.#operations.push({ kind: 'ReplaceText', target, text });
    return this;
  }

  /** Inserts one attribute with explicit placement (edit.rs:224-240). */
  insertAttribute(
    target: NodeRef,
    name: NameFacts,
    value: string,
    placement: AttributePlacement,
  ): EditTransactionBuilder {
    this.#operations.push({ kind: 'InsertAttribute', target, name, value, placement });
    return this;
  }

  /** Removes one attribute association (edit.rs:241-247). */
  removeAttribute(target: NodeRef): EditTransactionBuilder {
    this.#operations.push({ kind: 'RemoveAttribute', target });
    return this;
  }

  /** Renames one attribute (edit.rs:248-254). */
  renameAttribute(target: NodeRef, name: NameFacts): EditTransactionBuilder {
    this.#operations.push({ kind: 'RenameAttribute', target, name });
    return this;
  }

  /** Replaces one attribute value (edit.rs:255-263). */
  setAttributeValue(target: NodeRef, value: string): EditTransactionBuilder {
    this.#operations.push({ kind: 'SetAttributeValue', target, value });
    return this;
  }

  /** Inserts one element into a parent's mixed content (edit.rs:264-280). */
  insertElement(
    target: NodeRef,
    name: NameFacts,
    content: string | null,
    placement: ContentPlacement,
  ): EditTransactionBuilder {
    this.#operations.push({ kind: 'InsertElement', target, name, content, placement });
    return this;
  }

  /** Removes one element subtree (edit.rs:281-287). */
  removeElement(target: NodeRef): EditTransactionBuilder {
    this.#operations.push({ kind: 'RemoveElement', target });
    return this;
  }

  /** Renames one element (edit.rs:288-294). */
  renameElement(target: NodeRef, name: NameFacts): EditTransactionBuilder {
    this.#operations.push({ kind: 'RenameElement', target, name });
    return this;
  }

  /** Closes the transaction (edit.rs:296-304). */
  build(): EditTransaction {
    return new EditTransaction(this.#base, this.#operations);
  }
}

/** One complete committed edit (edit.rs:306-317). */
export class EditCommit {
  readonly #document: XmlDocument;
  readonly #changeSet: ChangeSet;
  readonly #sourcePatch: SourcePatch;
  readonly #untouchedProof: UntouchedByteProof;

  constructor(
    document: XmlDocument,
    changeSet: ChangeSet,
    sourcePatch: SourcePatch,
    untouchedProof: UntouchedByteProof,
  ) {
    this.#document = document;
    this.#changeSet = changeSet;
    this.#sourcePatch = sourcePatch;
    this.#untouchedProof = untouchedProof;
  }

  /** New immutable document. */
  document(): XmlDocument {
    return this.#document;
  }

  /** Complete old-to-new change facts. */
  changeSet(): ChangeSet {
    return this.#changeSet;
  }

  /** Portable exact raw-byte application fact. */
  sourcePatch(): SourcePatch {
    return this.#sourcePatch;
  }

  /** Verifiable evidence for every byte outside the replacement set. */
  untouchedProof(): UntouchedByteProof {
    return this.#untouchedProof;
  }
}

// ---------------------------------------------------------------------------
// Prepared edits
// ---------------------------------------------------------------------------

/** One prepared raw-byte edit owned by the transaction (edit.rs:44-50). */
interface PreparedEdit {
  readonly oldSpan: Span;
  readonly replacement: Uint8Array;
  readonly mapping: { readonly target: NodeRef; readonly plan: MappingPlan } | null;
}

type MappingPlan = 'Replaced' | 'Deleted';

/** Cross-operation dependency checks before any span is computed (edit.rs:597-641). */
function validateDependencies(transaction: EditTransaction): void {
  const targets = new Set<string>();
  for (const operation of transaction.operations()) {
    let target: NodeRef;
    let anchor: NodeRef | null = null;
    switch (operation.kind) {
      case 'ReplaceText':
      case 'RemoveAttribute':
      case 'SetAttributeValue':
      case 'RemoveElement':
      case 'RenameAttribute':
      case 'RenameElement':
        target = operation.target;
        break;
      case 'InsertAttribute':
        target = operation.target;
        if (operation.placement.kind === 'Before' || operation.placement.kind === 'After') {
          anchor = operation.placement.anchor;
        }
        break;
      case 'InsertElement':
        target = operation.target;
        if (operation.placement.kind === 'Before' || operation.placement.kind === 'After') {
          anchor = operation.placement.anchor;
        }
        break;
    }
    const key = `${target.role()}:${target.index()}`;
    if (targets.has(key)) {
      throw new EditFailure('ConflictingEdits');
    }
    targets.add(key);
    if (anchor !== null) {
      const anchorKey = `${anchor.role()}:${anchor.index()}`;
      if (targets.has(anchorKey)) {
        throw new EditFailure('PlacementAnchorModified');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/** Commits structural operations atomically; `document` remains unchanged on failure (edit.rs:410-570). */
export function commit(
  document: XmlDocument,
  transaction: EditTransaction,
): EditCommit {
  if (transaction.baseSnapshot() !== document.snapshotIdentity().asBigInt()) {
    throw new EditFailure('WrongSnapshot');
  }
  if (document.formationStatus() !== 'Complete') {
    throw new EditFailure('IncompleteTarget');
  }
  validateDependencies(transaction);
  const prepared: PreparedEdit[] = [];
  for (const operation of transaction.operations()) {
    prepared.push(...prepareOperation(document, operation));
  }
  prepared.sort((left, right) => {
    const byStart = left.oldSpan.startByte() - right.oldSpan.startByte();
    if (byStart !== 0) {
      return byStart;
    }
    return left.oldSpan.endByte() - right.oldSpan.endByte();
  });
  for (let index = 0; index + 1 < prepared.length; index++) {
    const left = prepared[index];
    const right = prepared[index + 1];
    if (
      spansEqual(left.oldSpan, right.oldSpan) ||
      (left.oldSpan.isEmpty() && right.oldSpan.isEmpty() && left.oldSpan.startByte() === right.oldSpan.startByte())
    ) {
      throw new EditFailure('OverlappingOwnership');
    }
    if (!left.oldSpan.isEmpty() && !right.oldSpan.isEmpty() && left.oldSpan.endByte() > right.oldSpan.startByte()) {
      throw new EditFailure('OverlappingOwnership');
    }
  }
  const sourceBytes = document.source().bytes();
  let targetLength = sourceBytes.length;
  for (const edit of prepared) {
    targetLength = targetLength - edit.oldSpan.len() + edit.replacement.length;
    if (targetLength < 0 || targetLength > document.parseLimits().common.maxSourceBytes) {
      throw new EditFailure('ResourceLimit', { limitName: 'target-bytes' });
    }
  }
  const rendered = new Uint8Array(targetLength);
  let cursor = 0;
  let renderedOffset = 0;
  for (const edit of prepared) {
    rendered.set(sourceBytes.subarray(cursor, edit.oldSpan.startByte()), renderedOffset);
    renderedOffset += edit.oldSpan.startByte() - cursor;
    rendered.set(edit.replacement, renderedOffset);
    renderedOffset += edit.replacement.length;
    cursor = edit.oldSpan.endByte();
  }
  rendered.set(sourceBytes.subarray(cursor), renderedOffset);
  let newDocument: XmlDocument;
  try {
    newDocument = parse(
      rendered,
      'SafeV1',
      { kind: 'ProfileDefault' } satisfies XmlEncodingSelection,
      document.parseLimits(),
    );
  } catch {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  if (newDocument.formationStatus() !== 'Complete') {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  let delta = 0;
  const sourceEdits: SourceEdit[] = [];
  const mappings: NodeMapping[] = [];
  const mappedOld = new Set<string>();
  for (const edit of prepared) {
    const replacementLength = edit.replacement.length;
    const newStart = edit.oldSpan.startByte() + delta;
    const newEnd = newStart + replacementLength;
    const newSpan = newDocument.authorityInternal().span(newStart, newEnd);
    sourceEdits.push(
      new SourceEdit(edit.oldSpan, newSpan, edit.replacement),
    );
    if (edit.mapping !== null) {
      const oldKey = `${edit.mapping.target.role()}:${edit.mapping.target.index()}`;
      if (!mappedOld.has(oldKey)) {
        mappedOld.add(oldKey);
        if (edit.mapping.plan === 'Replaced') {
          const found = findNodeBySpan(newDocument, newStart, newEnd);
          mappings.push(
            new NodeMapping(
              edit.mapping.target,
              found === null ? 'Unmapped' : 'Replaced',
              found,
              found === null ? 'reparsed-node-not-uniquely-located' : null,
            ),
          );
        } else {
          mappings.push(new NodeMapping(edit.mapping.target, 'Deleted', null, null));
        }
      }
    }
    delta += replacementLength - edit.oldSpan.len();
  }
  const changeSet = new ChangeSet(
    document.snapshotIdentity(),
    newDocument.snapshotIdentity(),
    sourceEdits,
    mappings,
    [],
  );
  const patchLimits = sourcePatchLimits(document.parseLimits(), prepared.length);
  let sourcePatch: SourcePatch;
  try {
    sourcePatch = SourcePatch.derive(
      document.source(),
      newDocument.source(),
      changeSet,
      operationMetadata(transaction),
      patchLimits,
    );
  } catch {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  let untouchedProof: UntouchedByteProof;
  try {
    untouchedProof = UntouchedByteProof.create(
      document.source(),
      newDocument.source(),
      sourcePatch.replacements(),
    );
  } catch {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  return new EditCommit(newDocument, changeSet, sourcePatch, untouchedProof);
}

/** Fully validates and plans a transaction without returning a new Document (edit.rs:572-588). */
export function dryRun(
  document: XmlDocument,
  transaction: EditTransaction,
  sourceId: EditPlanSourceId,
): EditPlan {
  const committed = commit(document, transaction);
  try {
    return new EditPlan(
      sourceId,
      document.profile(),
      operationSummaries(transaction),
      committed.sourcePatch(),
      committed.changeSet().diagnostics(),
    );
  } catch {
    throw new EditFailure('NewDocumentFormationFailed');
  }
}

// ---------------------------------------------------------------------------
// Preparation (edit.rs:745-1070)
// ---------------------------------------------------------------------------

function prepareOperation(document: XmlDocument, operation: EditOperation): PreparedEdit[] {
  switch (operation.kind) {
    case 'ReplaceText':
      return prepareReplaceText(document, operation.target, operation.text);
    case 'InsertAttribute':
      return prepareInsertAttribute(document, operation.target, operation.name, operation.value, operation.placement);
    case 'RemoveAttribute':
      return prepareRemoveAttribute(document, operation.target);
    case 'RenameAttribute':
      return prepareRenameAttribute(document, operation.target, operation.name);
    case 'SetAttributeValue':
      return prepareSetAttributeValue(document, operation.target, operation.value);
    case 'InsertElement':
      return prepareInsertElement(document, operation.target, operation.name, operation.content, operation.placement);
    case 'RemoveElement':
      return prepareRemoveElement(document, operation.target);
    case 'RenameElement':
      return prepareRenameElement(document, operation.target, operation.name);
  }
}

function prepareReplaceText(document: XmlDocument, target: NodeRef, text: string): PreparedEdit[] {
  const textData = textFor(document, target);
  const encoding = document.source().encodingFacts().selected();
  return [
    {
      oldSpan: textData.span,
      replacement: escapeText(text, encoding),
      mapping: { target, plan: 'Replaced' },
    },
  ];
}

function prepareInsertAttribute(
  document: XmlDocument,
  target: NodeRef,
  name: NameFacts,
  value: string,
  placement: AttributePlacement,
): PreparedEdit[] {
  const element = elementFor(document, target);
  validateNameFacts(name, element, true);
  rejectDuplicateAttribute(element, name);
  const encoding = document.source().encodingFacts().selected();
  let insertAt: number;
  let replacement: Uint8Array;
  switch (placement.kind) {
    case 'Before': {
      const anchorData = attributeFor(document, placement.anchor);
      insertAt = anchorData.span.startByte();
      replacement = concatBytes([
        spellingBytes(name, encoding),
        encodeText('=', encoding),
        encodeText('"', encoding),
        escapeAttribute(value, encoding),
        encodeText('"', encoding),
        encodeText(' ', encoding),
      ]);
      break;
    }
    case 'After': {
      const anchorData = attributeFor(document, placement.anchor);
      insertAt = anchorData.span.endByte();
      replacement = concatBytes([
        encodeText(' ', encoding),
        spellingBytes(name, encoding),
        encodeText('=', encoding),
        encodeText('"', encoding),
        escapeAttribute(value, encoding),
        encodeText('"', encoding),
      ]);
      break;
    }
    case 'End': {
      const emptyElement = emptyElementTagClose(
        document.source().bytes(),
        element.span.endByte(),
        encoding,
      );
      const width = charWidth(encoding);
      insertAt = element.span.endByte() - (emptyElement ? 2 * width : width);
      replacement = concatBytes([
        encodeText(' ', encoding),
        spellingBytes(name, encoding),
        encodeText('=', encoding),
        encodeText('"', encoding),
        escapeAttribute(value, encoding),
        encodeText('"', encoding),
      ]);
      break;
    }
  }
  return [
    {
      oldSpan: document.authorityInternal().span(insertAt, insertAt),
      replacement,
      mapping: null,
    },
  ];
}

function prepareRemoveAttribute(document: XmlDocument, target: NodeRef): PreparedEdit[] {
  const attribute = attributeFor(document, target);
  const start = leadingWhitespaceStart(document.source().bytes(), attribute.span.startByte());
  return [
    {
      oldSpan: document.authorityInternal().span(start, attribute.span.endByte()),
      replacement: new Uint8Array(0),
      mapping: { target, plan: 'Deleted' },
    },
  ];
}

function prepareRenameAttribute(
  document: XmlDocument,
  target: NodeRef,
  name: NameFacts,
): PreparedEdit[] {
  const attribute = attributeFor(document, target);
  const element = elementsOf(document).find((data) => {
    return data.attributes.some((candidate) => candidate.ordinal === attribute.ordinal);
  });
  if (element === undefined) {
    throw new EditFailure('TargetNotFound');
  }
  validateNameFacts(name, element, true);
  const remaining = element.attributes.filter((candidate) => candidate.ordinal !== attribute.ordinal);
  const promised = expandedNameForFacts(name, element);
  if (promised !== null) {
    if (remaining.some((candidate) => candidate.expanded !== null && expandedEquals(candidate.expanded, promised))) {
      throw new EditFailure('DuplicateExpandedAttribute');
    }
  }
  const encoding = document.source().encodingFacts().selected();
  return [
    {
      oldSpan: attribute.qname.span,
      replacement: spellingBytes(name, encoding),
      mapping: { target, plan: 'Replaced' },
    },
  ];
}

function prepareSetAttributeValue(
  document: XmlDocument,
  target: NodeRef,
  value: string,
): PreparedEdit[] {
  const attribute = attributeFor(document, target);
  const encoding = document.source().encodingFacts().selected();
  return [
    {
      oldSpan: attribute.valueSpan,
      replacement: escapeAttribute(value, encoding),
      mapping: { target, plan: 'Replaced' },
    },
  ];
}

function prepareInsertElement(
  document: XmlDocument,
  target: NodeRef,
  name: NameFacts,
  content: string | null,
  placement: ContentPlacement,
): PreparedEdit[] {
  const element = elementFor(document, target);
  validateNameFacts(name, element, false);
  const encoding = document.source().encodingFacts().selected();
  const spelling = spellingBytes(name, encoding);
  const markup = concatBytes([
    encodeText('<', encoding),
    spelling,
    content === null
      ? encodeText('/>', encoding)
      : concatBytes([
          encodeText('>', encoding),
          escapeText(content, encoding),
          encodeText('</', encoding),
          spelling,
          encodeText('>', encoding),
        ]),
  ]);
  let start: number;
  let end: number;
  let replacement = markup;
  switch (placement.kind) {
    case 'Before': {
      const { span } = contentSpanFor(document, placement.anchor);
      if (!isChildOf(document, element, span)) {
        throw new EditFailure('TargetNotFound');
      }
      start = span.startByte();
      end = span.startByte();
      break;
    }
    case 'After': {
      const { span } = contentSpanFor(document, placement.anchor);
      if (!isChildOf(document, element, span)) {
        throw new EditFailure('TargetNotFound');
      }
      start = span.endByte();
      end = span.endByte();
      break;
    }
    case 'End': {
      const lastChild = element.children[element.children.length - 1];
      if (lastChild !== undefined) {
        const at = contentExtentEnd(document, lastChild);
        start = at;
        end = at;
      } else {
        const elementEnd = element.span.endByte();
        if (emptyElementTagClose(document.source().bytes(), elementEnd, encoding)) {
          // `<root/>`: replace the `/>` close with `>` plus the new element
          // plus a fresh `</parent-name>` close (edit.rs:977-989).
          const wrapped = concatBytes([
            encodeText('>', encoding),
            markup,
            encodeText('</', encoding),
            qnameSpellingBytes(element.qname, encoding),
            encodeText('>', encoding),
          ]);
          start = elementEnd - 2 * charWidth(encoding);
          end = elementEnd;
          replacement = wrapped;
        } else {
          start = elementEnd;
          end = elementEnd;
        }
      }
      break;
    }
  }
  return [
    {
      oldSpan: document.authorityInternal().span(start, end),
      replacement,
      mapping: null,
    },
  ];
}

function prepareRemoveElement(document: XmlDocument, target: NodeRef): PreparedEdit[] {
  const element = elementFor(document, target);
  const root = document.root();
  if (root !== null && root.rawIndex() === element.index) {
    throw new EditFailure('CannotRemoveRoot');
  }
  const start = leadingWhitespaceStart(document.source().bytes(), element.span.startByte());
  const end = contentExtentEnd(document, element.index);
  return [
    {
      oldSpan: document.authorityInternal().span(start, end),
      replacement: new Uint8Array(0),
      mapping: { target, plan: 'Deleted' },
    },
  ];
}

function prepareRenameElement(
  document: XmlDocument,
  target: NodeRef,
  name: NameFacts,
): PreparedEdit[] {
  const element = elementFor(document, target);
  validateNameFacts(name, element, false);
  const encoding = document.source().encodingFacts().selected();
  const spelling = spellingBytes(name, encoding);
  const edits: PreparedEdit[] = [
    {
      oldSpan: element.qname.span,
      replacement: spelling,
      mapping: { target, plan: 'Replaced' },
    },
  ];
  const emptyElement = emptyElementTagClose(
    document.source().bytes(),
    element.span.endByte(),
    encoding,
  );
  if (!emptyElement) {
    const lastChildEnd = element.children.length === 0
      ? element.span.endByte()
      : contentExtentEnd(document, element.children[element.children.length - 1]);
    const width = charWidth(encoding);
    const nameStart = lastChildEnd + 2 * width;
    const endName = document
      .authorityInternal()
      .span(nameStart, nameStart + element.qname.span.len());
    edits.push({
      oldSpan: endName,
      replacement: spelling,
      mapping: null,
    });
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Target resolution (edit.rs:1073-1186)
// ---------------------------------------------------------------------------

/** Resolves one element occurrence by arena index (edit.rs:1073-1087). */
function elementFor(document: XmlDocument, target: NodeRef): XmlElementData {
  if (target.snapshot().asBigInt() !== document.snapshotIdentity().asBigInt() || target.role() !== 'XmlElement') {
    throw new EditFailure('WrongSnapshot');
  }
  const index = Number(target.index());
  if (!Number.isSafeInteger(index) || index >= document.nodes().length) {
    throw new EditFailure('TargetNotFound');
  }
  const node = document.nodeAt(index);
  if (node.kind !== 'Element') {
    throw new EditFailure('WrongRole');
  }
  if (node.data.index !== index) {
    throw new EditFailure('WrongRole');
  }
  return node.data;
}

/** Resolves one attribute association by ordinal (edit.rs:1090-1098). */
function attributeFor(document: XmlDocument, target: NodeRef): XmlAttributeData {
  if (target.snapshot().asBigInt() !== document.snapshotIdentity().asBigInt() || target.role() !== 'XmlAttribute') {
    throw new EditFailure('WrongSnapshot');
  }
  const ordinal = target.index();
  for (const node of document.nodes()) {
    if (node.kind === 'Element') {
      const found = node.data.attributes.find((candidate) => BigInt(candidate.ordinal) === ordinal);
      if (found !== undefined) {
        return found;
      }
    }
  }
  throw new EditFailure('TargetNotFound');
}

/** Resolves one text occurrence by ordinal (edit.rs:1101-1108). */
function textFor(document: XmlDocument, target: NodeRef): XmlTextData {
  if (target.snapshot().asBigInt() !== document.snapshotIdentity().asBigInt() || target.role() !== 'XmlText') {
    throw new EditFailure('WrongSnapshot');
  }
  const ordinal = target.index();
  for (const node of document.nodes()) {
    if (node.kind === 'Text' && BigInt(node.data.ordinal) === ordinal) {
      return node.data;
    }
  }
  throw new EditFailure('TargetNotFound');
}

/** The exact end of one content item's full extent (edit.rs:1112-1144). */
function contentExtentEnd(document: XmlDocument, index: number): number {
  const node = document.nodeAt(index);
  if (node.kind !== 'Element') {
    return node.data.span.endByte();
  }
  const data = node.data;
  const encoding = document.source().encodingFacts().selected();
  const width = charWidth(encoding);
  if (data.children.length === 0) {
    if (emptyElementTagClose(document.source().bytes(), data.span.endByte(), encoding)) {
      return data.span.endByte();
    }
    return data.span.endByte() + 2 * width + data.qname.span.len() + width;
  }
  const lastChildEnd = contentExtentEnd(document, data.children[data.children.length - 1]);
  return lastChildEnd + 2 * width + data.qname.span.len() + width;
}

/** Resolves one content item span by role (edit.rs:1147-1186). */
function contentSpanFor(
  document: XmlDocument,
  target: NodeRef,
): { role: NodeRole; span: Span } {
  if (target.snapshot().asBigInt() !== document.snapshotIdentity().asBigInt()) {
    throw new EditFailure('WrongSnapshot');
  }
  const ordinal = target.index();
  switch (target.role()) {
    case 'XmlElement':
      return { role: 'XmlElement', span: elementFor(document, target).span };
    case 'XmlText':
      return { role: 'XmlText', span: textFor(document, target).span };
    case 'XmlCdata': {
      const found = findOccurrence(document, ordinal, 'Cdata');
      if (found === null) {
        throw new EditFailure('TargetNotFound');
      }
      return { role: 'XmlCdata', span: found.data.span };
    }
    case 'XmlComment': {
      const found = findOccurrence(document, ordinal, 'Comment');
      if (found === null) {
        throw new EditFailure('TargetNotFound');
      }
      return { role: 'XmlComment', span: found.data.span };
    }
    case 'XmlProcessingInstruction': {
      const found = findOccurrence(document, ordinal, 'ProcessingInstruction');
      if (found === null) {
        throw new EditFailure('TargetNotFound');
      }
      return { role: 'XmlProcessingInstruction', span: found.data.span };
    }
    default:
      throw new EditFailure('WrongRole');
  }
}

function findOccurrence(
  document: XmlDocument,
  ordinal: bigint,
  kind: 'Cdata' | 'Comment' | 'ProcessingInstruction',
): XmlContent | null {
  for (const node of document.nodes()) {
    if (node.kind === kind && BigInt(node.data.ordinal) === ordinal) {
      return node;
    }
  }
  return null;
}

/** Whether the anchor content item is a direct child of the element (edit.rs:956-959, 964-967). */
function isChildOf(document: XmlDocument, element: XmlElementData, span: Span): boolean {
  return element.children.some((child) => {
    const node = document.nodeAt(child);
    return node.data.span.startByte() === span.startByte() && node.data.span.endByte() === span.endByte();
  });
}

// ---------------------------------------------------------------------------
// Name validation (edit.rs:1189-1306)
// ---------------------------------------------------------------------------

/** Validates name facts against one element's in-scope scope (edit.rs:1189-1255). */
function validateNameFacts(name: NameFacts, element: XmlElementData, attribute: boolean): void {
  if (
    name.local().length === 0 ||
    name.local().includes(':') ||
    isAsciiDigit(name.local().charCodeAt(0)) ||
    name.local().charCodeAt(0) === 0x2d
  ) {
    throw new EditFailure('InvalidQName');
  }
  const prefix = name.prefix();
  const namespace = name.namespace();
  if (prefix === null && namespace !== null) {
    if (attribute) {
      // An unprefixed attribute never carries a namespace.
      throw new EditFailure('UnboundPrefix', { prefix: '' });
    }
    const defaultNamespace = lastBinding(element.scope.bindings(), (binding) => binding.prefix === null);
    if ((defaultNamespace?.uri ?? null) !== namespace) {
      throw new EditFailure('UnboundPrefix', { prefix: '' });
    }
    return;
  }
  if (prefix !== null && namespace === null) {
    throw new EditFailure('UnboundPrefix', { prefix });
  }
  if (prefix === null && namespace === null) {
    return;
  }
  if (prefix !== null && namespace !== null) {
    if (prefix === 'xmlns') {
      throw new EditFailure('ReservedPrefix', { prefix });
    }
    if (prefix === 'xml' && namespace !== XML_NAMESPACE_URI) {
      throw new EditFailure('UnboundPrefix', { prefix });
    }
    const bound = lastBinding(element.scope.bindings(), (binding) => binding.prefix === prefix);
    if ((bound?.uri ?? null) !== namespace) {
      throw new EditFailure('UnboundPrefix', { prefix });
    }
  }
}

/** The most recent binding satisfying one predicate (namespace.rs:181-218). */
function lastBinding(
  bindings: readonly { readonly prefix: string | null; readonly uri: string }[],
  predicate: (binding: { readonly prefix: string | null; readonly uri: string }) => boolean,
): { readonly prefix: string | null; readonly uri: string } | null {
  for (let index = bindings.length - 1; index >= 0; index--) {
    if (predicate(bindings[index])) {
      return bindings[index];
    }
  }
  return null;
}

/** The expanded name promised by name facts, when resolvable (edit.rs:1258-1287). */
function expandedNameForFacts(name: NameFacts, element: XmlElementData): ExpandedName | null {
  const namespace = name.namespace();
  if (namespace === null) {
    return null;
  }
  if (name.prefix() === 'xml') {
    return { namespace: XML_NAMESPACE_URI, local: name.local() };
  }
  const bound = lastBinding(
    element.scope.bindings(),
    (binding) => binding.prefix === (name.prefix() ?? ''),
  );
  if ((bound?.uri ?? null) !== namespace) {
    throw new EditFailure('UnboundPrefix', { prefix: name.prefix() ?? '' });
  }
  return { namespace, local: name.local() };
}

/** Rejects an attribute whose expanded name already exists on the element (edit.rs:1290-1306). */
function rejectDuplicateAttribute(element: XmlElementData, name: NameFacts): void {
  const promised = expandedNameForFacts(name, element);
  if (promised === null) {
    return;
  }
  if (
    element.attributes.some(
      (candidate) => candidate.expanded !== null && expandedEquals(candidate.expanded, promised),
    )
  ) {
    throw new EditFailure('DuplicateExpandedAttribute');
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers (edit.rs:643-743)
// ---------------------------------------------------------------------------

/** Raw bytes per decoded character under the source encoding (edit.rs:643-649). */
function charWidth(encoding: { readonly kind: string }): number {
  return encoding.kind === 'Utf16Le' || encoding.kind === 'Utf16Be' ? 2 : 1;
}

/** Whether the element tag ending at `spanEnd` is written with a `/>` close (edit.rs:651-664). */
function emptyElementTagClose(source: Uint8Array, spanEnd: number, encoding: { readonly kind: string }): boolean {
  const offset = spanEnd - 2 * charWidth(encoding);
  if (offset < 0) {
    return false;
  }
  const slash = encoding.kind === 'Utf16Be' ? offset + 1 : offset;
  return source[slash] === 0x2f;
}

/** Appends literal text to a replacement buffer under the source encoding (edit.rs:666-687). */
function encodeText(text: string, encoding: { readonly kind: string }): Uint8Array {
  const units: number[] = [];
  for (let index = 0; index < text.length; index++) {
    units.push(text.charCodeAt(index));
  }
  if (encoding.kind === 'Utf16Le' || encoding.kind === 'Utf16Be') {
    const out = new Uint8Array(units.length * 2);
    for (let index = 0; index < units.length; index++) {
      const unit = units[index];
      if (encoding.kind === 'Utf16Le') {
        out[index * 2] = unit & 0xff;
        out[index * 2 + 1] = (unit >> 8) & 0xff;
      } else {
        out[index * 2] = (unit >> 8) & 0xff;
        out[index * 2 + 1] = unit & 0xff;
      }
    }
    return out;
  }
  return utf8BytesOf(text);
}

/** Encodes one name spelling under the source encoding (edit.rs:696-715). */
function spellingBytes(name: NameFacts, encoding: { readonly kind: string }): Uint8Array {
  const parts: Uint8Array[] = [];
  if (name.prefix() !== null) {
    parts.push(encodeText(name.prefix()!, encoding));
    parts.push(encodeText(':', encoding));
  }
  parts.push(encodeText(name.local(), encoding));
  return concatBytes(parts);
}

/** Encodes one source QName spelling under the source encoding (edit.rs:707-715). */
function qnameSpellingBytes(qname: QNameFacts, encoding: { readonly kind: string }): Uint8Array {
  const parts: Uint8Array[] = [];
  if (qname.prefix !== null) {
    parts.push(encodeText(qname.prefix, encoding));
    parts.push(encodeText(':', encoding));
  }
  parts.push(encodeText(qname.local, encoding));
  return concatBytes(parts);
}

/** Escapes literal character data for text content under the source encoding (edit.rs:717-728). */
function escapeText(text: string, encoding: { readonly kind: string }): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const character of text) {
    switch (character) {
      case '&':
        parts.push(encodeText('&amp;', encoding));
        break;
      case '<':
        parts.push(encodeText('&lt;', encoding));
        break;
      default:
        parts.push(encodeText(character, encoding));
        break;
    }
  }
  return concatBytes(parts);
}

/** Escapes literal text for double-quoted attribute values under the source encoding (edit.rs:730-743). */
function escapeAttribute(text: string, encoding: { readonly kind: string }): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const character of text) {
    switch (character) {
      case '&':
        parts.push(encodeText('&amp;', encoding));
        break;
      case '<':
        parts.push(encodeText('&lt;', encoding));
        break;
      case '"':
        parts.push(encodeText('&quot;', encoding));
        break;
      default:
        parts.push(encodeText(character, encoding));
        break;
    }
  }
  return concatBytes(parts);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function utf8BytesOf(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function expandedEquals(left: ExpandedName, right: ExpandedName): boolean {
  return left.namespace === right.namespace && left.local === right.local;
}

function spansEqual(left: Span, right: Span): boolean {
  return left.startByte() === right.startByte() && left.endByte() === right.endByte();
}

/** All element data in document order (edit.rs:1477-1485). */
function elementsOf(document: XmlDocument): XmlElementData[] {
  const out: XmlElementData[] = [];
  for (const node of document.nodes()) {
    if (node.kind === 'Element') {
      out.push(node.data);
    }
  }
  return out;
}

/** Finds a node by its exact reparse span (edit.rs:1310-1336). */
function findNodeBySpan(document: XmlDocument, start: number, end: number): NodeRef | null {
  for (let index = 0; index < document.nodes().length; index++) {
    const node = document.nodes()[index];
    const span = node.data.span;
    if (span.startByte() === start && span.endByte() === end) {
      const ordinal = node.kind === 'Element' ? index : node.data.ordinal;
      return document.nodeRefFor(ordinal, contentRoleOf(node));
    }
  }
  return null;
}

function contentRoleOf(node: XmlContent): NodeRole {
  switch (node.kind) {
    case 'Element':
      return 'XmlElement';
    case 'Text':
      return 'XmlText';
    case 'Cdata':
      return 'XmlCdata';
    case 'Comment':
      return 'XmlComment';
    case 'ProcessingInstruction':
      return 'XmlProcessingInstruction';
    case 'ErrorRegion':
      return 'XmlErrorRegion';
  }
}

/** The start of the whitespace run immediately before `start` (edit.rs:1338-1344). */
function leadingWhitespaceStart(source: Uint8Array, start: number): number {
  let cursor = start;
  while (cursor > 0 && isSourceWhitespace(source[cursor - 1])) {
    cursor -= 1;
  }
  return cursor;
}

function isSourceWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
}

// ---------------------------------------------------------------------------
// Plan metadata (edit.rs:1346-1435)
// ---------------------------------------------------------------------------

function sourcePatchLimits(limits: XmlParseLimits, operationCount: number): SourcePatchLimits {
  const source: SourceLimits = {
    maxRawBytes: limits.common.maxSourceBytes,
    maxDecodedUtf8Bytes: limits.maxDecodedUtf8Bytes,
    maxDecodedScalars: limits.maxDecodedScalars,
  };
  return {
    source,
    maxReplacements: Math.max(operationCount, 1),
    maxPatchBytes: limits.common.maxSourceBytes * 2,
  };
}

function operationMetadata(transaction: EditTransaction): Map<string, string> {
  const metadata = new Map<string, string>();
  transaction.operations().forEach((operation, index) => {
    metadata.set(`operation.${index}`, operationId(operation));
  });
  return metadata;
}

function operationId(operation: EditOperation): string {
  switch (operation.kind) {
    case 'ReplaceText':
      return 'xml.edit.replace-text@1';
    case 'InsertAttribute':
      return 'xml.edit.insert-attribute@1';
    case 'RemoveAttribute':
      return 'xml.edit.remove-attribute@1';
    case 'RenameAttribute':
      return 'xml.edit.rename-attribute@1';
    case 'SetAttributeValue':
      return 'xml.edit.set-attribute-value@1';
    case 'InsertElement':
      return 'xml.edit.insert-element@1';
    case 'RemoveElement':
      return 'xml.edit.remove-element@1';
    case 'RenameElement':
      return 'xml.edit.rename-element@1';
  }
}

function operationSummaries(transaction: EditTransaction): EditOperationSummary[] {
  return transaction.operations().map((operation) => {
    const summary = operationSummary(operation);
    try {
      return new EditOperationSummary(
        new FormatOperationId(summary.id, 1),
        new Map([...summary.arguments, ['target_role', summary.targetRole]]),
      );
    } catch {
      throw new EditFailure('NewDocumentFormationFailed');
    }
  });
}

function operationSummary(operation: EditOperation): {
  id: string;
  targetRole: string;
  arguments: Map<string, string>;
} {
  switch (operation.kind) {
    case 'ReplaceText':
      return {
        id: 'xml.edit.replace-text',
        targetRole: 'xml.text@1',
        arguments: new Map([['text_bytes', String(utf8Length(operation.text))]]),
      };
    case 'InsertAttribute':
      return {
        id: 'xml.edit.insert-attribute',
        targetRole: 'xml.element@1',
        arguments: new Map([
          ['name_bytes', String(utf8Length(operation.name.spelling()))],
          ['value_bytes', String(utf8Length(operation.value))],
          ['placement', placementName(operation.placement)],
        ]),
      };
    case 'RemoveAttribute':
      return { id: 'xml.edit.remove-attribute', targetRole: 'xml.attribute@1', arguments: new Map() };
    case 'RenameAttribute':
      return {
        id: 'xml.edit.rename-attribute',
        targetRole: 'xml.attribute@1',
        arguments: new Map([['name_bytes', String(utf8Length(operation.name.spelling()))]]),
      };
    case 'SetAttributeValue':
      return {
        id: 'xml.edit.set-attribute-value',
        targetRole: 'xml.attribute@1',
        arguments: new Map([['value_bytes', String(utf8Length(operation.value))]]),
      };
    case 'InsertElement':
      return {
        id: 'xml.edit.insert-element',
        targetRole: 'xml.element@1',
        arguments: new Map([
          ['name_bytes', String(utf8Length(operation.name.spelling()))],
          ['content_bytes', String(utf8Length(operation.content ?? ''))],
          ['placement', placementName(operation.placement)],
        ]),
      };
    case 'RemoveElement':
      return { id: 'xml.edit.remove-element', targetRole: 'xml.element@1', arguments: new Map() };
    case 'RenameElement':
      return {
        id: 'xml.edit.rename-element',
        targetRole: 'xml.element@1',
        arguments: new Map([['name_bytes', String(utf8Length(operation.name.spelling()))]]),
      };
  }
}

function placementName(placement: AttributePlacement | ContentPlacement): string {
  switch (placement.kind) {
    case 'Before':
      return 'Before';
    case 'After':
      return 'After';
    case 'End':
      return 'End';
  }
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code < 0x10000) {
      bytes += 3;
    } else {
      bytes += 4;
    }
  }
  return bytes;
}
