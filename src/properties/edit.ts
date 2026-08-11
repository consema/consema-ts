/**
 * Java Properties structural edit operations over one immutable snapshot.
 *
 * authority: crates/consema-properties/src/edit.rs
 *  - EditOperation :16-56, EditTransaction/Builder :70-163, EditCommit
 *    :165-176, EditFailure :178-253
 *  - Document::commit :270-442 (RecoveredDocument gate :273-275,
 *    WrongSnapshot :276-278, edit count :279-281,
 *    validate_removed_anchors :282, DuplicateTarget :306-310,
 *    preserve-or-canonical semantic replacement :312-328, literal
 *    validation :329-341, insertion boundaries :342-371, removal ownership
 *    :372-379, rename ownership :380-387, ordering and overlap :390-391,
 *    target length and allocation :398-405, render and reparse :405-409,
 *    expected verification :409, source edits and literal ownership
 *    :411-412, node mappings :413, ChangeSet :414-420, SourcePatch.derive
 *    :421-429, UntouchedByteProof :430-435), Document::dry_run :444-459
 *  - property_ordinal :461-472, validate_document_target :474-485,
 *    validate_removed_anchors :487-505, insertion_location :507-541,
 *    record_ownership :543-560, key/value_ownership :562-576,
 *    preserve_direct_value :578-599, canonical_fragment :601-614,
 *    canonical_record :616-663, newline_convention :665-683,
 *    is_line_boundary :685-692, validate_literal :694-720,
 *    canonical_fallback_diagnostic :722-730, apply_prepared :732-761
 *  - fragment_ownership :763-777, validate_non_overlapping :779-792,
 *    assemble_expected :794-808, verify_expected :810-833,
 *    build_source_edits :835-870, verify_literal_ownership :872-892,
 *    build_node_mappings :894-923, canonical_java_string :925-990,
 *    source_patch_limits :1062-1075, operation_metadata :1077-1089,
 *    operation_summaries :1091-1138, operation ids :1140-1148,
 *    placement names :1150-1157
 *  - RFC 0010 §13 (:383-413) freezes the five operations and the
 *    transaction/conflict algebra
 *  - frozen codes: crates/consema-protocol/src/error_registry.rs:1099-1109
 *    (java-properties.edit.canonical-fallback@1, invalid-placement@1);
 *    :262-276/556-604 (core.edit.*@1)
 *  - vector-pinned behavior: conformance/vectors/java-properties-v1.json
 *    (edit.all-five-operations, edit.dry-run-patch-proof-conflict-atomicity,
 *    registry.frozen-five-operation-surface)
 *
 * Design (TypeScript-idiomatic): one immutable transaction binds one base
 * snapshot; every operation is fully validated before any output is
 * published. Validation, source-edit preparation, output allocation,
 * reparse, mapping, untouched proof, and SourcePatch derivation form one
 * atomic commit — a failure returns none of the successful artifacts
 * (RFC 0004 §13).
 */

import { NodeRef, SnapshotIdentity, Span } from '../document/identity.ts';
import type { AssociationPlacement } from '../document/identity.ts';
import { ChangeSet, NodeMapping, SourceEdit } from '../document/change_set.ts';
import type { NodeMappingStatus } from '../document/change_set.ts';
import { diagnostic } from '../document/diagnostic.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { EditOperationSummary, EditPlan, EditPlanSourceId } from '../document/edit_plan.ts';
import { FormatOperationId } from '../document/operation.ts';
import { EncodingRequest, SourceSnapshot } from '../document/source.ts';
import type { BomPolicy, SourceLimits } from '../document/source.ts';
import { SourcePatch } from '../document/source_patch.ts';
import type { SourcePatchLimits } from '../document/source_patch.ts';
import { UntouchedByteProof } from '../document/untouched_proof.ts';
import { EditFailure } from './errors.ts';
import { JavaString, JavaStringConversionError } from './java_string.ts';
import { PropertiesDocument, Property } from './document.ts';
import type { PropertiesProfile } from './profile.ts';
import type { PropertiesParseLimits } from './parse_limits.ts';
import { parseLatin1, parseReader } from './parser.ts';
import { encodeFragment } from './materialization.ts';

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** One typed Java Properties structural edit operation (edit.rs:16-56). */
export type EditOperation =
  | {
      readonly kind: 'ReplaceSemanticValue';
      /** Exact property target. */
      readonly target: NodeRef;
      /** Exact replacement Java string. */
      readonly value: JavaString;
    }
  | {
      readonly kind: 'ReplaceLiteralValue';
      /** Exact property target. */
      readonly target: NodeRef;
      /** Raw bytes in the base document's selected source encoding. */
      readonly literal: Uint8Array;
    }
  | {
      readonly kind: 'InsertProperty';
      /** Exact Properties document target. */
      readonly document: NodeRef;
      /** Exact Java UTF-16 key. */
      readonly key: JavaString;
      /** Exact Java UTF-16 value. */
      readonly value: JavaString;
      /** Placement among property occurrences. */
      readonly placement: AssociationPlacement;
    }
  | {
      readonly kind: 'RemoveProperty';
      /** Exact property target. */
      readonly target: NodeRef;
    }
  | {
      readonly kind: 'RenameProperty';
      /** Exact property target. */
      readonly target: NodeRef;
      /** Exact replacement key. */
      readonly key: JavaString;
    };

function destructiveTarget(operation: EditOperation): NodeRef | null {
  switch (operation.kind) {
    case 'ReplaceSemanticValue':
    case 'ReplaceLiteralValue':
    case 'RemoveProperty':
    case 'RenameProperty':
      return operation.target;
    case 'InsertProperty':
      return null;
  }
}

/** Immutable edit transaction; every operation resolves against one base snapshot (edit.rs:70-89). */
export class EditTransaction {
  readonly #base: SnapshotIdentity;
  readonly #operations: readonly EditOperation[];

  constructor(base: SnapshotIdentity, operations: readonly EditOperation[]) {
    this.#base = base;
    this.#operations = Object.freeze([...operations]);
  }

  /** Base snapshot identity (edit.rs:78-81). */
  baseSnapshot(): SnapshotIdentity {
    return this.#base;
  }

  /** Ordered declared operations (edit.rs:83-87). */
  operations(): readonly EditOperation[] {
    return this.#operations;
  }
}

/** Builder for one immutable Properties edit transaction (edit.rs:92-163). */
export class EditTransactionBuilder {
  readonly #base: SnapshotIdentity;
  readonly #operations: EditOperation[] = [];

  /** Binds a new transaction to one immutable Properties document (edit.rs:99-105). */
  constructor(document: PropertiesDocument) {
    this.#base = document.snapshotIdentity();
  }

  /** Adds one semantic Java-string value replacement (edit.rs:107-112). */
  semanticValue(target: NodeRef, value: JavaString): EditTransactionBuilder {
    this.#operations.push({ kind: 'ReplaceSemanticValue', target, value });
    return this;
  }

  /** Adds one exact raw value-literal replacement (edit.rs:114-120). */
  literalValue(target: NodeRef, literal: Uint8Array): EditTransactionBuilder {
    this.#operations.push({ kind: 'ReplaceLiteralValue', target, literal: Uint8Array.from(literal) });
    return this;
  }

  /** Adds one canonical property insertion (edit.rs:122-132). */
  insertProperty(
    document: NodeRef,
    key: JavaString,
    value: JavaString,
    placement: AssociationPlacement,
  ): EditTransactionBuilder {
    this.#operations.push({ kind: 'InsertProperty', document, key, value, placement });
    return this;
  }

  /** Adds one exact property removal (edit.rs:134-139). */
  removeProperty(target: NodeRef): EditTransactionBuilder {
    this.#operations.push({ kind: 'RemoveProperty', target });
    return this;
  }

  /** Adds one semantic Java-string property rename (edit.rs:141-149). */
  renameProperty(target: NodeRef, key: JavaString): EditTransactionBuilder {
    this.#operations.push({ kind: 'RenameProperty', target, key });
    return this;
  }

  /** Completes the request; validation remains atomic at dry-run or commit (edit.rs:151-158). */
  build(): EditTransaction {
    return new EditTransaction(this.#base, this.#operations);
  }
}

// ---------------------------------------------------------------------------
// Commit and dry-run
// ---------------------------------------------------------------------------

/** Atomic edit success (edit.rs:165-176). */
export class EditCommit {
  readonly #document: PropertiesDocument;
  readonly #changeSet: ChangeSet;
  readonly #sourcePatch: SourcePatch;
  readonly #untouchedProof: UntouchedByteProof;

  constructor(
    document: PropertiesDocument,
    changeSet: ChangeSet,
    sourcePatch: SourcePatch,
    untouchedProof: UntouchedByteProof,
  ) {
    this.#document = document;
    this.#changeSet = changeSet;
    this.#sourcePatch = sourcePatch;
    this.#untouchedProof = untouchedProof;
  }

  /** New immutable document (edit.rs:167-169). */
  document(): PropertiesDocument {
    return this.#document;
  }

  /** Complete old-to-new change facts (edit.rs:170-172). */
  changeSet(): ChangeSet {
    return this.#changeSet;
  }

  /** Replayable exact raw-byte patch (edit.rs:173-175). */
  sourcePatch(): SourcePatch {
    return this.#sourcePatch;
  }

  /** Evidence for every byte outside the replacement set (edit.rs:176-178). */
  untouchedProof(): UntouchedByteProof {
    return this.#untouchedProof;
  }
}

interface ExpectedProperty {
  readonly old: NodeRef | null;
  readonly key: JavaString;
  readonly value: JavaString | null;
  readonly literal: boolean;
  readonly literalOldSpan: Span | null;
  readonly removed: boolean;
}

interface PreparedEdit {
  readonly oldSpan: Span;
  readonly replacement: Uint8Array;
}

/**
 * Atomically commits every declared Properties operation (edit.rs:270-442).
 * On failure the base document remains unchanged.
 */
export function commitEdits(
  document: PropertiesDocument,
  transaction: EditTransaction,
): EditCommit {
  if (document.formationStatus() !== 'Complete') {
    throw new EditFailure('RecoveredDocument');
  }
  if (!transaction.baseSnapshot().equals(document.snapshotIdentity())) {
    throw new EditFailure('WrongSnapshot');
  }
  if (transaction.operations().length > document.parseLimits().common.maxNodeCount) {
    throw new EditFailure('ResourceLimit', { limitName: 'edit-operations' });
  }
  validateRemovedAnchors(transaction);

  const targets = new Set<string>();
  const insertBoundaries = new Set<number>();
  const diagnostics: Diagnostic[] = [];
  const prepared: PreparedEdit[] = [];
  const expected: ExpectedProperty[] = document.properties().map((property) => ({
    old: property.nodeRef(),
    key: property.key(),
    value: property.value(),
    literal: false,
    literalOldSpan: null,
    removed: false,
  }));
  const insertions = new Map<number, ExpectedProperty>();

  for (const operation of transaction.operations()) {
    const target = destructiveTarget(operation);
    if (target !== null) {
      if (targets.has(nodeKey(target))) {
        throw new EditFailure('DuplicateTarget');
      }
      targets.add(nodeKey(target));
    }
    switch (operation.kind) {
      case 'ReplaceSemanticValue': {
        const ordinal = propertyOrdinal(document, operation.target);
        const property = document.properties()[ordinal];
        const oldSpan = valueOwnership(property);
        let replacement: Uint8Array | null = preserveDirectValue(document, property, operation.value);
        if (replacement === null) {
          diagnostics.push(canonicalFallbackDiagnostic(property.span()));
          replacement = canonicalFragment(document, operation.value, false);
        }
        expected[ordinal] = { ...expected[ordinal], value: operation.value };
        prepared.push({ oldSpan, replacement });
        break;
      }
      case 'ReplaceLiteralValue': {
        const ordinal = propertyOrdinal(document, operation.target);
        validateLiteral(document, operation.literal);
        const property = document.properties()[ordinal];
        const oldSpan = valueOwnership(property);
        expected[ordinal] = {
          ...expected[ordinal],
          value: null,
          literal: true,
          literalOldSpan: oldSpan,
        };
        prepared.push({ oldSpan, replacement: operation.literal });
        break;
      }
      case 'InsertProperty': {
        validateDocumentTarget(document, operation.document);
        const location = insertionLocation(document, operation.placement);
        if (insertBoundaries.has(location.boundary)) {
          throw new EditFailure('OverlappingOwnership');
        }
        insertBoundaries.add(location.boundary);
        insertions.set(location.boundary, {
          old: null,
          key: operation.key,
          value: operation.value,
          literal: false,
          literalOldSpan: null,
          removed: false,
        });
        prepared.push({
          oldSpan: document.authorityInternal().span(location.position, location.position),
          replacement: canonicalRecord(document, location.position, operation.key, operation.value),
        });
        break;
      }
      case 'RemoveProperty': {
        const ordinal = propertyOrdinal(document, operation.target);
        expected[ordinal] = { ...expected[ordinal], removed: true };
        prepared.push({
          oldSpan: recordOwnership(document, document.properties()[ordinal]),
          replacement: new Uint8Array(0),
        });
        break;
      }
      case 'RenameProperty': {
        const ordinal = propertyOrdinal(document, operation.target);
        expected[ordinal] = { ...expected[ordinal], key: operation.key };
        prepared.push({
          oldSpan: keyOwnership(document.properties()[ordinal]),
          replacement: canonicalFragment(document, operation.key, true),
        });
        break;
      }
    }
  }
  prepared.sort((left, right) => {
    if (left.oldSpan.startByte() !== right.oldSpan.startByte()) {
      return left.oldSpan.startByte() - right.oldSpan.startByte();
    }
    return left.oldSpan.endByte() - right.oldSpan.endByte();
  });
  validateNonOverlapping(prepared);

  const finalExpected = assembleExpected(expected, insertions);
  const closureFailure = finalExpected.some((property) => property.literal)
    ? new EditFailure('InvalidLiteral')
    : new EditFailure('NewDocumentFormationFailed');
  const rendered = applyPrepared(document, prepared);
  let newDocument: PropertiesDocument;
  try {
    newDocument = reparseForEdit(document, rendered);
  } catch {
    throw closureFailure;
  }
  if (newDocument.formationStatus() !== 'Complete') {
    throw closureFailure;
  }
  verifyExpected(newDocument, finalExpected, closureFailure);

  const sourceEdits = buildSourceEdits(newDocument, prepared);
  verifyLiteralOwnership(newDocument, finalExpected, sourceEdits);
  const mappings = buildNodeMappings(newDocument, finalExpected, transaction);
  const changeSet = new ChangeSet(
    document.snapshotIdentity(),
    newDocument.snapshotIdentity(),
    sourceEdits,
    mappings,
    diagnostics,
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

/** Fully validates and plans an edit without publishing a new document (edit.rs:444-459; RFC 0004 §14). */
export function dryRunEdits(
  document: PropertiesDocument,
  transaction: EditTransaction,
  sourceId: EditPlanSourceId,
): EditPlan {
  const commit = commitEdits(document, transaction);
  try {
    return new EditPlan(
      sourceId,
      document.profile(),
      operationSummaries(transaction),
      commit.sourcePatch(),
      commit.changeSet().diagnostics(),
    );
  } catch {
    throw new EditFailure('NewDocumentFormationFailed');
  }
}

// ---------------------------------------------------------------------------
// Target resolution and ownership
// ---------------------------------------------------------------------------

function propertyOrdinal(document: PropertiesDocument, target: NodeRef): number {
  if (!target.snapshot().equals(document.snapshotIdentity())) {
    throw new EditFailure('WrongSnapshot');
  }
  if (target.role() !== 'PropertiesProperty') {
    throw new EditFailure('WrongRole');
  }
  const ordinal = document
    .properties()
    .findIndex((property) => property.nodeRef().equals(target));
  if (ordinal < 0) {
    throw new EditFailure('TargetNotFound');
  }
  return ordinal;
}

function validateDocumentTarget(document: PropertiesDocument, target: NodeRef): void {
  if (!target.snapshot().equals(document.snapshotIdentity())) {
    throw new EditFailure('WrongSnapshot');
  }
  if (target.role() !== 'PropertiesDocument') {
    throw new EditFailure('WrongRole');
  }
  if (!target.equals(document.nodeRef())) {
    throw new EditFailure('TargetNotFound');
  }
}

function validateRemovedAnchors(transaction: EditTransaction): void {
  const removed = new Set<string>();
  for (const operation of transaction.operations()) {
    if (operation.kind === 'RemoveProperty') {
      removed.add(nodeKey(operation.target));
    }
  }
  for (const operation of transaction.operations()) {
    if (operation.kind !== 'InsertProperty') {
      continue;
    }
    const placement = operation.placement;
    if (
      (placement.kind === 'Before' && removed.has(nodeKey(placement.anchor))) ||
      (placement.kind === 'After' && removed.has(nodeKey(placement.anchor)))
    ) {
      throw new EditFailure('PlacementAnchorRemoved');
    }
  }
}

function insertionLocation(
  document: PropertiesDocument,
  placement: AssociationPlacement,
): { boundary: number; position: number } {
  const properties = document.properties();
  switch (placement.kind) {
    case 'Start':
      return {
        boundary: 0,
        position:
          properties.length === 0
            ? document.source().len()
            : recordOwnership(document, properties[0]).startByte(),
      };
    case 'End':
      return { boundary: properties.length, position: document.source().len() };
    case 'Before': {
      const ordinal = propertyOrdinal(document, placement.anchor);
      return {
        boundary: ordinal,
        position: recordOwnership(document, properties[ordinal]).startByte(),
      };
    }
    case 'After': {
      const ordinal = propertyOrdinal(document, placement.anchor);
      return {
        boundary: ordinal + 1,
        position: recordOwnership(document, properties[ordinal]).endByte(),
      };
    }
  }
}

/** The property's natural-line ownership interval (edit.rs:543-560). */
function recordOwnership(document: PropertiesDocument, property: Property): Span {
  const logical = property.logicalLine();
  const naturals = logical.naturalLines();
  const first = naturals[0];
  const last = naturals[naturals.length - 1];
  if (first === undefined || last === undefined) {
    throw new EditFailure('TargetNotFound');
  }
  return document.authorityInternal().span(first.span().startByte(), last.span().endByte());
}

function keyOwnership(property: Property): Span {
  return fragmentOwnership(property.keyFragments(), property.keyAnchor());
}

function valueOwnership(property: Property): Span {
  return fragmentOwnership(property.valueFragments(), property.valueAnchor());
}

function fragmentOwnership(fragments: readonly Span[], anchor: Span): Span {
  if (fragments.length === 0) {
    return anchor;
  }
  return new Span(
    fragments[0].snapshot(),
    fragments[0].startByte(),
    fragments[fragments.length - 1].endByte(),
  );
}

/** Preserves a direct unescaped single-line value spelling when possible (edit.rs:578-599). */
function preserveDirectValue(
  document: PropertiesDocument,
  property: Property,
  value: JavaString,
): Uint8Array | null {
  const logical = property.logicalLine();
  if (logical.naturalLines().length !== 1) {
    return null;
  }
  if (property.escapes().some((escape) => !escape.inKey())) {
    return null;
  }
  let text: string;
  try {
    text = value.toUnicode();
  } catch (error) {
    if (error instanceof JavaStringConversionError) {
      return null;
    }
    throw error;
  }
  if (text.startsWith(' ') || text.startsWith('\t') || text.startsWith('\u000C')) {
    return null;
  }
  if (text.includes('\\') || text.includes('\r') || text.includes('\n')) {
    return null;
  }
  try {
    return encodeFragment(
      text,
      document.source().encodingFacts().selected(),
      document.parseLimits().common.maxSourceBytes,
    );
  } catch {
    return null;
  }
}

/** Canonical escaped fragment for one Java string (edit.rs:601-614). */
function canonicalFragment(document: PropertiesDocument, value: JavaString, isKey: boolean): Uint8Array {
  const text = canonicalJavaString(
    value,
    document.selectedProfile(),
    isKey,
    document.parseLimits().common.maxSourceBytes,
  );
  try {
    return encodeFragment(
      text,
      document.source().encodingFacts().selected(),
      document.parseLimits().common.maxSourceBytes,
    );
  } catch (error) {
    if (error instanceof EditFailure) {
      throw error;
    }
    throw new EditFailure('EncodingUnrepresentable');
  }
}

/** Canonical full record `key=value<newline>` for one insertion (edit.rs:616-663). */
function canonicalRecord(
  document: PropertiesDocument,
  position: number,
  key: JavaString,
  value: JavaString,
): Uint8Array {
  const newline = newlineConvention(document);
  let text = '';
  if (position > 0 && !isLineBoundary(document, position)) {
    text += newline;
  }
  text += canonicalJavaString(key, document.selectedProfile(), true, document.parseLimits().common.maxSourceBytes);
  text += '=';
  text += canonicalJavaString(value, document.selectedProfile(), false, document.parseLimits().common.maxSourceBytes);
  text += newline;
  if (text.length > document.parseLimits().common.maxSourceBytes) {
    throw new EditFailure('ResourceLimit', { limitName: 'replacement-bytes' });
  }
  try {
    return encodeFragment(
      text,
      document.source().encodingFacts().selected(),
      document.parseLimits().common.maxSourceBytes,
    );
  } catch (error) {
    if (error instanceof EditFailure) {
      throw error;
    }
    throw new EditFailure('EncodingUnrepresentable');
  }
}

/** First line-terminator convention of the decoded source (edit.rs:665-683). */
function newlineConvention(document: PropertiesDocument): string {
  const text = document.source().decodedText();
  if (text === null) {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '\r') {
      return text[index + 1] === '\n' ? '\r\n' : '\r';
    }
    if (character === '\n') {
      return '\n';
    }
  }
  return '\n';
}

/** Whether the raw insertion point is preceded by a line terminator (edit.rs:685-692). */
function isLineBoundary(document: PropertiesDocument, raw: number): boolean {
  const jsIndex = document.rawBoundaryJsIndex(raw);
  const text = document.source().decodedText();
  if (text === null || jsIndex === 0) {
    return false;
  }
  return text[jsIndex - 1] === '\r' || text[jsIndex - 1] === '\n';
}

/** Literal bytes must decode and form exactly one raw value element (edit.rs:694-720). */
function validateLiteral(document: PropertiesDocument, literal: Uint8Array): void {
  if (literal.length > document.parseLimits().common.maxSourceBytes) {
    throw new EditFailure('ResourceLimit', { limitName: 'replacement-bytes' });
  }
  const encoding = document.source().encodingFacts().selected();
  const request = EncodingRequest.create(encoding)
    .withCallerOverride(encoding)
    .withBomPolicy('TreatAsContent');
  let snapshot: SourceSnapshot;
  try {
    snapshot = SourceSnapshot.fromRaw(literal, request, {
      maxRawBytes: document.parseLimits().common.maxSourceBytes,
      maxDecodedUtf8Bytes: document.parseLimits().maxDecodedUtf8Bytes,
      maxDecodedScalars: document.parseLimits().maxDecodedScalars,
    });
  } catch {
    throw new EditFailure('InvalidLiteral');
  }
  const text = snapshot.decodedText();
  if (text === null || text.includes('\r') || text.includes('\n')) {
    throw new EditFailure('InvalidLiteral');
  }
}

function canonicalFallbackDiagnostic(span: Span): Diagnostic {
  return diagnostic(
    'java-properties.edit.canonical-fallback@1',
    'Edit',
    'Warning',
    {
      snapshot: span.snapshot().asBigInt(),
      startByte: BigInt(span.startByte()),
      endByte: BigInt(span.endByte()),
    },
    0n,
  );
}

// ---------------------------------------------------------------------------
// Rendering and verification
// ---------------------------------------------------------------------------

function applyPrepared(document: PropertiesDocument, prepared: readonly PreparedEdit[]): Uint8Array {
  let targetLength = document.source().len();
  for (const edit of prepared) {
    targetLength = targetLength - edit.oldSpan.len() + edit.replacement.length;
    if (!Number.isSafeInteger(targetLength) || targetLength < 0) {
      throw new EditFailure('ResourceLimit', { limitName: 'target-bytes' });
    }
  }
  if (targetLength > document.parseLimits().common.maxSourceBytes) {
    throw new EditFailure('ResourceLimit', { limitName: 'target-bytes' });
  }
  const output = new Uint8Array(targetLength);
  let cursor = 0;
  let out = 0;
  const sourceBytes = document.source().bytes();
  for (const edit of prepared) {
    const oldStart = edit.oldSpan.startByte();
    const oldEnd = edit.oldSpan.endByte();
    output.set(sourceBytes.subarray(cursor, oldStart), out);
    out += oldStart - cursor;
    output.set(edit.replacement, out);
    out += edit.replacement.length;
    cursor = oldEnd;
  }
  output.set(sourceBytes.subarray(cursor), out);
  return output;
}

function reparseForEdit(document: PropertiesDocument, bytes: Uint8Array): PropertiesDocument {
  if (document.selectedProfile() === 'ReaderV1') {
    return parseReader(bytes, document.source().encodingFacts().selected(), document.parseLimits());
  }
  return parseLatin1(bytes, document.parseLimits());
}

function validateNonOverlapping(prepared: readonly PreparedEdit[]): void {
  for (let index = 1; index < prepared.length; index++) {
    const left = prepared[index - 1].oldSpan;
    const right = prepared[index].oldSpan;
    if (
      left.equals(right) ||
      left.endByte() > right.startByte() ||
      (left.isEmpty() && left.startByte() === right.startByte()) ||
      (right.isEmpty() && left.endByte() === right.startByte())
    ) {
      throw new EditFailure('OverlappingOwnership');
    }
  }
}

function assembleExpected(
  old: readonly ExpectedProperty[],
  insertions: ReadonlyMap<number, ExpectedProperty>,
): ExpectedProperty[] {
  const output: ExpectedProperty[] = [];
  for (let boundary = 0; boundary <= old.length; boundary++) {
    const inserted = insertions.get(boundary);
    if (inserted !== undefined) {
      output.push(inserted);
    }
    const property = old[boundary];
    if (property !== undefined && !property.removed) {
      output.push(property);
    }
  }
  return output;
}

function verifyExpected(
  document: PropertiesDocument,
  expected: readonly ExpectedProperty[],
  closureFailure: EditFailure,
): void {
  const properties = document.properties();
  if (properties.length !== expected.length) {
    throw closureFailure;
  }
  for (let index = 0; index < properties.length; index++) {
    const actual = properties[index];
    const wanted = expected[index];
    const valueMatches =
      wanted.value === null ||
      (wanted.value !== null && actual.value().equals(wanted.value));
    if (!actual.key().equals(wanted.key) || !valueMatches) {
      throw closureFailure;
    }
  }
}

function buildSourceEdits(
  newDocument: PropertiesDocument,
  prepared: readonly PreparedEdit[],
): SourceEdit[] {
  let delta = 0;
  const sourceEdits: SourceEdit[] = [];
  for (const edit of prepared) {
    const newStart = edit.oldSpan.startByte() + delta;
    const newEnd = newStart + edit.replacement.length;
    let newSpan: Span;
    try {
      newSpan = newDocument.authorityInternal().span(newStart, newEnd);
    } catch {
      throw new EditFailure('NewDocumentFormationFailed');
    }
    sourceEdits.push(new SourceEdit(edit.oldSpan, newSpan, edit.replacement));
    delta = delta + (edit.replacement.length - edit.oldSpan.len());
  }
  return sourceEdits;
}

function verifyLiteralOwnership(
  document: PropertiesDocument,
  expected: readonly ExpectedProperty[],
  sourceEdits: readonly SourceEdit[],
): void {
  for (let ordinal = 0; ordinal < expected.length; ordinal++) {
    const wanted = expected[ordinal];
    if (!wanted.literal) {
      continue;
    }
    const oldSpan = wanted.literalOldSpan;
    if (oldSpan === null) {
      throw new EditFailure('InvalidLiteral');
    }
    const sourceEdit = sourceEdits.find((edit) => edit.oldSpan().equals(oldSpan));
    if (sourceEdit === undefined) {
      throw new EditFailure('InvalidLiteral');
    }
    const actual = document.properties()[ordinal];
    const ownership = valueOwnership(actual);
    if (!sourceEdit.newSpan().equals(ownership)) {
      throw new EditFailure('InvalidLiteral');
    }
  }
}

function buildNodeMappings(
  document: PropertiesDocument,
  expected: readonly ExpectedProperty[],
  transaction: EditTransaction,
): NodeMapping[] {
  const mappings: NodeMapping[] = [];
  for (const operation of transaction.operations()) {
    switch (operation.kind) {
      case 'RemoveProperty':
        mappings.push(new NodeMapping(operation.target, 'Deleted', null, null));
        break;
      case 'ReplaceSemanticValue':
      case 'ReplaceLiteralValue':
      case 'RenameProperty': {
        const ordinal = expected.findIndex((item) => item.old !== null && item.old.equals(operation.target));
        if (ordinal < 0) {
          continue;
        }
        mappings.push(
          new NodeMapping(operation.target, 'Replaced', document.properties()[ordinal].nodeRef(), null),
        );
        break;
      }
      case 'InsertProperty':
        break;
    }
  }
  return mappings;
}

// ---------------------------------------------------------------------------
// Canonical Java-string escaping (edit.rs:925-990; RFC 0010 §12)
// ---------------------------------------------------------------------------

function canonicalJavaString(
  value: JavaString,
  profile: PropertiesProfile,
  isKey: boolean,
  limit: number,
): string {
  let output = '';
  const units = value.codeUnits();
  let index = 0;
  let leadingValueSpace = !isKey;
  while (index < units.length) {
    const unit = units[index];
    let scalar: string | null;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = units[index + 1];
      if (next !== undefined && next >= 0xdc00 && next <= 0xdfff) {
        const codePoint = 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00);
        scalar = String.fromCodePoint(codePoint);
        index += 2;
      } else {
        scalar = null;
        index += 1;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      scalar = null;
      index += 1;
    } else {
      scalar = String.fromCharCode(unit);
      index += 1;
    }
    if (scalar === null) {
      output += pushUnicodeEscape(output.length, unit, limit);
      leadingValueSpace = false;
      continue;
    }
    const codePoint = scalar.codePointAt(0)!;
    if (scalar === ' ' && (isKey || leadingValueSpace)) {
      output += '\\ ';
    } else if (scalar === '\t') {
      output += '\\t';
    } else if (scalar === '\n') {
      output += '\\n';
    } else if (scalar === '\r') {
      output += '\\r';
    } else if (codePoint === 0x0c) {
      output += '\\f';
    } else if (scalar === '\\') {
      output += '\\\\';
    } else if (scalar === '#' || scalar === '!' || scalar === '=' || scalar === ':') {
      output += '\\' + scalar;
    } else if (isControlCodePoint(codePoint)) {
      for (const escapeUnit of codeUnitsOf(scalar)) {
        output += pushUnicodeEscape(output.length, escapeUnit, limit);
      }
    } else if (profile === 'Latin1V1' && !(codePoint >= 0x20 && codePoint <= 0x7e)) {
      for (const escapeUnit of codeUnitsOf(scalar)) {
        output += pushUnicodeEscape(output.length, escapeUnit, limit);
      }
    } else {
      output += scalar;
    }
    if (scalar !== ' ') {
      leadingValueSpace = false;
    }
  }
  if (output.length > limit) {
    throw new EditFailure('ResourceLimit', { limitName: 'replacement-bytes' });
  }
  return output;
}

function pushUnicodeEscape(currentLength: number, value: number, limit: number): string {
  const digits = value.toString(16).toUpperCase().padStart(4, '0');
  const text = '\\u' + digits;
  if (currentLength + text.length > limit) {
    throw new EditFailure('ResourceLimit', { limitName: 'replacement-bytes' });
  }
  return text;
}

/** Rust `char::is_control()` (edit.rs:968). */
function isControlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function codeUnitsOf(character: string): readonly number[] {
  if (character.length === 1) {
    return [character.charCodeAt(0)];
  }
  return [character.charCodeAt(0), character.charCodeAt(1)];
}

// ---------------------------------------------------------------------------
// Patch limits, metadata, and summaries
// ---------------------------------------------------------------------------

function sourcePatchLimits(limits: PropertiesParseLimits, operationCount: number): SourcePatchLimits {
  return {
    source: {
      maxRawBytes: limits.common.maxSourceBytes,
      maxDecodedUtf8Bytes: limits.maxDecodedUtf8Bytes,
      maxDecodedScalars: limits.maxDecodedScalars,
    },
    maxReplacements: operationCount,
    maxPatchBytes: limits.common.maxSourceBytes * 2,
  };
}

function operationMetadata(transaction: EditTransaction): ReadonlyMap<string, string> {
  const metadata = new Map<string, string>();
  transaction.operations().forEach((operation, index) => {
    metadata.set(`operation.${index}`, `${operationId(operation)}@1`);
  });
  return metadata;
}

function operationSummaries(transaction: EditTransaction): EditOperationSummary[] {
  return transaction.operations().map((operation) => {
    let arguments_: ReadonlyMap<string, string>;
    switch (operation.kind) {
      case 'ReplaceSemanticValue':
        arguments_ = new Map([['value_code_units', String(operation.value.codeUnits().length)]]);
        break;
      case 'ReplaceLiteralValue':
        arguments_ = new Map([['literal_bytes', String(operation.literal.length)]]);
        break;
      case 'InsertProperty':
        arguments_ = new Map([
          ['key_code_units', String(operation.key.codeUnits().length)],
          ['value_code_units', String(operation.value.codeUnits().length)],
          ['placement', placementName(operation.placement)],
        ]);
        break;
      case 'RemoveProperty':
        arguments_ = new Map();
        break;
      case 'RenameProperty':
        arguments_ = new Map([['key_code_units', String(operation.key.codeUnits().length)]]);
        break;
    }
    try {
      return new EditOperationSummary(new FormatOperationId(operationId(operation), 1), arguments_);
    } catch {
      throw new EditFailure('NewDocumentFormationFailed');
    }
  });
}

function operationId(operation: EditOperation): string {
  switch (operation.kind) {
    case 'ReplaceSemanticValue':
      return 'java-properties.edit.replace-semantic-value';
    case 'ReplaceLiteralValue':
      return 'java-properties.edit.replace-literal-value';
    case 'InsertProperty':
      return 'java-properties.edit.insert-property';
    case 'RemoveProperty':
      return 'java-properties.edit.remove-property';
    case 'RenameProperty':
      return 'java-properties.edit.rename-property';
  }
}

function placementName(placement: AssociationPlacement): string {
  switch (placement.kind) {
    case 'Start':
      return 'start';
    case 'End':
      return 'end';
    case 'Before':
      return 'before';
    case 'After':
      return 'after';
  }
}

function nodeKey(node: NodeRef): string {
  return `${node.snapshot().asBigInt().toString()}:${node.index().toString()}:${node.role()}`;
}
