/**
 * Scalar and structural edit operations over one immutable snapshot.
 *
 * authority: crates/consema-json/src/edit.rs
 *  - RepresentationPolicy :17-28, ScalarReplacement :30-57, EditOperation
 *    :59-108, EditTransaction/Builder :110-243, EditCommit :245-256,
 *    EditFailure :258-299
 *  - Document::commit :301-451 (RecoveredDocument gate :304-306,
 *    WrongSnapshot :307-309, validate_dependencies :310, prepared-edit
 *    ordering and overlap conflicts :319-335, target length and
 *    allocation :336-346, render and reparse :347-359, source edits and
 *    node mappings :361-422, ChangeSet :423-429, SourcePatch.derive
 *    :430-439, UntouchedByteProof :440-444), Document::dry_run :453-469
 *  - prepare_* :471-1023 (resolve_target :874-887, resolve_anchor
 *    :889-900, fragment :902-923, parent_object/parent_array :925-955,
 *    removal_comma :957-987, delimiter/syntax_between :989-1022)
 *  - validate_dependencies :1025-1078, source_patch_limits :1095-1108,
 *    operation_metadata :1110-1133, operation_summaries :1135-1229,
 *    placement/policy/kind names :1231-1267
 *  - scalar preservation engine :1346-1862 (semantic_literal :1346-1386,
 *    lexical styles :1388-1440, analyze_lexical_style :1442-1504,
 *    analyze_string_style :1506-1579, render_preserving_style
 *    :1581-1613, render_integer_style :1615-1651, render_decimal_style
 *    :1653-1702, render_non_finite_style :1711-1725,
 *    decimal_fixed_text :1727-1739, render_string_style :1741-1753,
 *    portable_json_kind :1755-1767, canonical_literal :1769-1795,
 *    encode_json_string :1797-1805, push_json_string_char :1807-1829,
 *    validate_literal :1831-1862, find_value_by_literal_span :1864-1882)
 *  - frozen codes: crates/consema-protocol/src/error_registry.rs:213
 *    (json.edit.representation-fallback@1), :262-276 (core.edit.*),
 *    kind→code mapping edit.rs:1299-1323
 *  - operation ids (EXACT registry, do not guess):
 *    crates/consema-json/src/operation_registry.rs:19-78 and
 *    edit.rs:1110-1133 ("json.edit.replace-scalar-semantic@1",
 *    "json.edit.replace-scalar-literal@1", "json.edit.insert-member@1",
 *    "json.edit.remove-member@1", "json.edit.move-member@1",
 *    "json.edit.rename-member@1", "json.edit.insert-array-element@1",
 *    "json.edit.remove-array-element@1")
 *  - vector-pinned behavior: conformance/vectors/json-family-v2.json
 *    (json5.edit.move-member, json5.edit.move-cross-object-rejected,
 *    json5.edit.preserve-scalars), conformance/vectors/v1.json
 *    (edit.scalar-minimal, edit.preserve-decimal-scale,
 *    edit.preserve-exponent-style, edit.canonical-for-profile,
 *    edit.preserve-else-canonical, edit.preserve-incompatible-rejected,
 *    edit.wrong-snapshot)
 *
 * Design (TypeScript-idiomatic): one immutable transaction binds one base
 * snapshot; every operation is fully validated before any output is
 * published. Validation, source-edit preparation, output allocation,
 * reparse, mapping, untouched proof, and SourcePatch derivation form one
 * atomic commit — a failure returns none of the successful artifacts
 * (RFC 0004 §13).
 */

import { NodeRef, SnapshotIdentity, Span } from '../document/identity.ts';
import type { AssociationPlacement, NodeRole } from '../document/identity.ts';
import { ChangeSet, NodeMapping, SourceEdit } from '../document/change_set.ts';
import type { NodeMappingStatus } from '../document/change_set.ts';
import { diagnostic } from '../document/diagnostic.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { EditOperationSummary, EditPlan, EditPlanSourceId } from '../document/edit_plan.ts';
import { FormatOperationId } from '../document/operation.ts';
import type { ParseLimits } from '../document/formation.ts';
import type { MaterializationLimits } from '../document/materialization.ts';
import { MaterializationFailure } from '../document/errors.ts';
import type { SourceLimits } from '../document/source.ts';
import { SourcePatch } from '../document/source_patch.ts';
import type { SourcePatchLimits } from '../document/source_patch.ts';
import { UntouchedByteProof } from '../document/untouched_proof.ts';
import { stringValue } from '../core/value.ts';
import type { Kind, PortableValue } from '../core/value.ts';
import { EditFailure } from './errors.ts';
import { JsonDocument } from './document.ts';
import type { InternalValueKind, JsonValueKind } from './document.ts';
import { isJson5 } from './profile.ts';
import type { JsonProfile } from './profile.ts';
import type { JsonSyntaxKind } from './syntax.ts';
import { parse } from './parser.ts';
import { canonicalFragment } from './materialization.ts';

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Explicit semantic scalar representation policy (edit.rs:17-28). */
export type RepresentationPolicy =
  | 'ExactLiteral'
  | 'PreserveCompatible'
  | 'CanonicalForProfile'
  | 'PreserveElseCanonical';

/** One scalar operation bound to the transaction's base snapshot (edit.rs:30-49). */
export type ScalarReplacement =
  | {
      readonly kind: 'Semantic';
      /** Exact target NodeRef. */
      readonly target: NodeRef;
      /** New complete core scalar. */
      readonly value: PortableValue;
      /** Representation contract. */
      readonly policy: RepresentationPolicy;
    }
  | {
      readonly kind: 'Literal';
      readonly target: NodeRef;
      /** Exact candidate literal bytes. */
      readonly literal: Uint8Array;
    };

/** One typed JSON edit operation bound to an immutable base snapshot (edit.rs:59-108). */
export type EditOperation =
  | { readonly kind: 'ReplaceScalar'; readonly operation: ScalarReplacement }
  | {
      readonly kind: 'InsertMember';
      readonly object: NodeRef;
      readonly name: string;
      readonly value: PortableValue;
      readonly placement: AssociationPlacement;
    }
  | { readonly kind: 'RemoveMember'; readonly target: NodeRef }
  | {
      readonly kind: 'MoveMember';
      readonly target: NodeRef;
      readonly placement: AssociationPlacement;
    }
  | { readonly kind: 'RenameMember'; readonly target: NodeRef; readonly name: string }
  | {
      readonly kind: 'InsertArrayElement';
      readonly array: NodeRef;
      readonly value: PortableValue;
      readonly placement: AssociationPlacement;
    }
  | { readonly kind: 'RemoveArrayElement'; readonly target: NodeRef };

/** Immutable transaction; every operation resolves against one base snapshot (edit.rs:110-129). */
export class EditTransaction {
  readonly #base: SnapshotIdentity;
  readonly #operations: readonly EditOperation[];

  constructor(base: SnapshotIdentity, operations: readonly EditOperation[]) {
    this.#base = base;
    this.#operations = Object.freeze([...operations]);
  }

  /** Base snapshot identity (edit.rs:118-122). */
  baseSnapshot(): SnapshotIdentity {
    return this.#base;
  }

  /** Ordered declared operations (edit.rs:123-128). */
  operations(): readonly EditOperation[] {
    return this.#operations;
  }
}

/** Builder that is not a committed edit (edit.rs:131-243). */
export class EditTransactionBuilder {
  readonly #base: SnapshotIdentity;
  readonly #operations: EditOperation[] = [];

  /** Binds a new transaction to one immutable base document (edit.rs:139-146). */
  constructor(document: JsonDocument) {
    this.#base = document.snapshotIdentity();
  }

  /** Adds semantic scalar replacement (edit.rs:148-162). */
  semanticScalar(target: NodeRef, value: PortableValue, policy: RepresentationPolicy): EditTransactionBuilder {
    this.#operations.push({
      kind: 'ReplaceScalar',
      operation: { kind: 'Semantic', target, value, policy },
    });
    return this;
  }

  /** Adds exact literal scalar replacement (edit.rs:163-172). */
  literalScalar(target: NodeRef, literal: Uint8Array): EditTransactionBuilder {
    this.#operations.push({
      kind: 'ReplaceScalar',
      operation: { kind: 'Literal', target, literal },
    });
    return this;
  }

  /** Adds one JSON Object member insertion (edit.rs:174-189). */
  insertMember(
    object: NodeRef,
    name: string,
    value: PortableValue,
    placement: AssociationPlacement,
  ): EditTransactionBuilder {
    this.#operations.push({ kind: 'InsertMember', object, name, value, placement });
    return this;
  }

  /** Adds one exact JSON Object member removal (edit.rs:191-195). */
  removeMember(target: NodeRef): EditTransactionBuilder {
    this.#operations.push({ kind: 'RemoveMember', target });
    return this;
  }

  /** Adds one exact same-Object member move (edit.rs:197-202). */
  moveMember(target: NodeRef, placement: AssociationPlacement): EditTransactionBuilder {
    this.#operations.push({ kind: 'MoveMember', target, placement });
    return this;
  }

  /** Adds one exact JSON Object member rename (edit.rs:204-211). */
  renameMember(target: NodeRef, name: string): EditTransactionBuilder {
    this.#operations.push({ kind: 'RenameMember', target, name });
    return this;
  }

  /** Adds one JSON Array element insertion (edit.rs:213-227). */
  insertArrayElement(
    array: NodeRef,
    value: PortableValue,
    placement: AssociationPlacement,
  ): EditTransactionBuilder {
    this.#operations.push({ kind: 'InsertArrayElement', array, value, placement });
    return this;
  }

  /** Adds one exact JSON Array element removal (edit.rs:229-235). */
  removeArrayElement(target: NodeRef): EditTransactionBuilder {
    this.#operations.push({ kind: 'RemoveArrayElement', target });
    return this;
  }

  /** Completes the immutable request; target validation happens atomically at commit (edit.rs:236-242). */
  build(): EditTransaction {
    return new EditTransaction(this.#base, this.#operations);
  }
}

// ---------------------------------------------------------------------------
// Commit records
// ---------------------------------------------------------------------------

/** Atomic edit success (edit.rs:245-256). */
export class EditCommit {
  readonly #document: JsonDocument;
  readonly #changeSet: ChangeSet;
  readonly #sourcePatch: SourcePatch;
  readonly #untouchedProof: UntouchedByteProof;

  constructor(
    document: JsonDocument,
    changeSet: ChangeSet,
    sourcePatch: SourcePatch,
    untouchedProof: UntouchedByteProof,
  ) {
    this.#document = document;
    this.#changeSet = changeSet;
    this.#sourcePatch = sourcePatch;
    this.#untouchedProof = untouchedProof;
  }

  /** New immutable document (edit.rs:248-250). */
  document(): JsonDocument {
    return this.#document;
  }

  /** Complete old-to-new change facts (edit.rs:251-253). */
  changeSet(): ChangeSet {
    return this.#changeSet;
  }

  /** Portable exact raw-byte application fact (edit.rs:254-256). */
  sourcePatch(): SourcePatch {
    return this.#sourcePatch;
  }

  /** Verifiable evidence for every byte outside the replacement set (edit.rs:257-259). */
  untouchedProof(): UntouchedByteProof {
    return this.#untouchedProof;
  }
}

// ---------------------------------------------------------------------------
// Prepared edits
// ---------------------------------------------------------------------------

interface PreparedEdit {
  readonly oldSpan: Span;
  readonly replacement: Uint8Array;
  /** Mutable during move preparation (edit.rs:764-768 replaces the target mapping). */
  mapping: { readonly old: NodeRef; readonly plan: MappingPlan } | null;
}

type MappingPlan =
  | { readonly kind: 'ReplacedLiteral'; readonly role: NodeRole }
  | { readonly kind: 'Deleted' }
  | { readonly kind: 'Unmapped'; readonly reason: string };

interface InsertionSyntax {
  readonly anchorRole: NodeRole;
  readonly open: JsonSyntaxKind;
  readonly close: JsonSyntaxKind;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/**
 * Atomically commits scalar and structural operations. On failure `self`
 * remains unchanged (edit.rs:301-451).
 */
export function commitEdits(
  document: JsonDocument,
  transaction: EditTransaction,
): EditCommit {
  if (document.formationStatus() !== 'Complete') {
    throw new EditFailure('RecoveredDocument');
  }
  if (!transaction.baseSnapshot().equals(document.snapshotIdentity())) {
    throw new EditFailure('WrongSnapshot');
  }
  validateDependencies(transaction);
  const diagnostics: Diagnostic[] = [];
  const prepared: PreparedEdit[] = [];
  for (const operation of transaction.operations()) {
    prepared.push(...prepareOperation(document, operation, diagnostics));
  }
  prepared.sort((left, right) => {
    if (left.oldSpan.startByte() !== right.oldSpan.startByte()) {
      return left.oldSpan.startByte() - right.oldSpan.startByte();
    }
    return left.oldSpan.endByte() - right.oldSpan.endByte();
  });
  for (let index = 1; index < prepared.length; index++) {
    const previous = prepared[index - 1];
    const current = prepared[index];
    if (
      !previous.oldSpan.isEmpty() &&
      !current.oldSpan.isEmpty() &&
      (previous.oldSpan.endByte() > current.oldSpan.startByte() ||
        previous.oldSpan.equals(current.oldSpan))
    ) {
      throw new EditFailure('AncestorDescendantConflict');
    }
    if (
      previous.oldSpan.equals(current.oldSpan) ||
      (previous.oldSpan.isEmpty() &&
        current.oldSpan.isEmpty() &&
        previous.oldSpan.startByte() === current.oldSpan.startByte())
    ) {
      throw new EditFailure('OverlappingOwnership');
    }
  }
  let targetLength = document.source().len();
  for (const edit of prepared) {
    targetLength = targetLength - edit.oldSpan.len() + edit.replacement.length;
    if (targetLength < 0 || !Number.isSafeInteger(targetLength)) {
      throw new EditFailure('ResourceLimit', { limitName: 'target-bytes' });
    }
  }
  if (targetLength > document.parseLimits().maxSourceBytes) {
    throw new EditFailure('ResourceLimit', { limitName: 'target-bytes' });
  }
  const rendered = new Uint8Array(targetLength);
  let cursor = 0;
  let out = 0;
  const sourceBytes = document.source().bytes();
  for (const edit of prepared) {
    const oldStart = edit.oldSpan.startByte();
    const oldEnd = edit.oldSpan.endByte();
    rendered.set(sourceBytes.subarray(cursor, oldStart), out);
    out += oldStart - cursor;
    rendered.set(edit.replacement, out);
    out += edit.replacement.length;
    cursor = oldEnd;
  }
  rendered.set(sourceBytes.subarray(cursor), out);

  let newDocument: JsonDocument;
  try {
    newDocument = parse(rendered, document.profileInternal(), document.parseLimits());
  } catch {
    throw new EditFailure('NewDocumentFormationFailed');
  }

  let delta = 0;
  const sourceEdits: SourceEdit[] = [];
  const mappings: NodeMapping[] = [];
  const mappedOld = new Set<string>();
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
    const mapping = edit.mapping;
    if (mapping !== null && !mappedOld.has(nodeKey(mapping.old))) {
      mappedOld.add(nodeKey(mapping.old));
      let newRef: NodeRef | null;
      let status: NodeMappingStatus;
      let reason: string | null;
      switch (mapping.plan.kind) {
        case 'ReplacedLiteral': {
          const found = findValueByLiteralSpan(newDocument, newStart, newEnd);
          newRef = found === null ? null : newDocument.nodeRefFor(found, mapping.plan.role);
          status = 'Replaced';
          reason = found === null ? 'reparsed-node-not-uniquely-located' : null;
          break;
        }
        case 'Deleted':
          newRef = null;
          status = 'Deleted';
          reason = null;
          break;
        case 'Unmapped':
          newRef = null;
          status = 'Unmapped';
          reason = mapping.plan.reason;
          break;
      }
      mappings.push(new NodeMapping(mapping.old, status, newRef, reason));
    }
    delta = delta + (edit.replacement.length - edit.oldSpan.len());
  }
  const changeSet = new ChangeSet(
    document.snapshotIdentity(),
    newDocument.snapshotIdentity(),
    sourceEdits,
    mappings,
    diagnostics,
  );
  const patchLimits = sourcePatchLimits(document.parseLimits(), changeSet.sourceEdits().length);
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

/**
 * Fully validates and plans an edit without returning a new Document
 * (edit.rs:453-469; RFC 0004 §14).
 */
export function dryRunEdits(
  document: JsonDocument,
  transaction: EditTransaction,
  sourceId: EditPlanSourceId,
): EditPlan {
  const commit = commitEdits(document, transaction);
  let plan: EditPlan;
  try {
    plan = new EditPlan(
      sourceId,
      document.profile(),
      operationSummaries(transaction),
      commit.sourcePatch(),
      commit.changeSet().diagnostics(),
    );
  } catch {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Operation preparation
// ---------------------------------------------------------------------------

function prepareOperation(
  document: JsonDocument,
  operation: EditOperation,
  diagnostics: Diagnostic[],
): PreparedEdit[] {
  switch (operation.kind) {
    case 'ReplaceScalar':
      return [prepareScalar(document, operation.operation, diagnostics)];
    case 'InsertMember':
      return prepareInsertMember(document, operation.object, operation.name, operation.value, operation.placement);
    case 'RemoveMember':
      return prepareRemoveMember(document, operation.target);
    case 'MoveMember':
      return prepareMoveMember(document, operation.target, operation.placement);
    case 'RenameMember':
      return [prepareRenameMember(document, operation.target, operation.name)];
    case 'InsertArrayElement':
      return prepareInsertArrayElement(document, operation.array, operation.value, operation.placement);
    case 'RemoveArrayElement':
      return prepareRemoveArrayElement(document, operation.target);
  }
}

function prepareScalar(
  document: JsonDocument,
  operation: ScalarReplacement,
  diagnostics: Diagnostic[],
): PreparedEdit {
  const target = operation.target;
  const index = resolveTarget(document, target, ['Value', 'ObjectKey']);
  const entity = document.valueEntityAt(index);
  const literalSpan = entity.literalSpan;
  if (!entity.complete || literalSpan === null) {
    throw new EditFailure('IncompleteTarget');
  }
  if (entity.value.kind === 'Unavailable') {
    throw new EditFailure('SemanticUnavailable');
  }
  if (entity.value.kind === 'Array' || entity.value.kind === 'Object') {
    throw new EditFailure('WrongRole');
  }
  let replacement: Uint8Array;
  if (operation.kind === 'Literal') {
    const literalKind = validateLiteral(operation.literal, document.profileInternal(), document.parseLimits());
    if (target.role() === 'ObjectKey' && literalKind !== 'String') {
      throw new EditFailure('InvalidLiteral');
    }
    replacement = Uint8Array.from(operation.literal);
  } else {
    const value = operation.value;
    const policy = operation.policy;
    if (target.role() === 'ObjectKey' && value.kind !== 'String') {
      throw new EditFailure('UnsupportedSemanticValue', { valueKind: value.kind });
    }
    const oldLiteral = decodeUtf8Slice(document.source().bytes(), literalSpan.startByte(), literalSpan.endByte());
    replacement = semanticLiteral(
      value,
      entity.value,
      oldLiteral,
      document.profileInternal(),
      policy,
      literalSpan,
      diagnostics,
    );
  }
  return {
    oldSpan: literalSpan,
    replacement,
    mapping: { old: target, plan: { kind: 'ReplacedLiteral', role: target.role() } },
  };
}

function prepareInsertMember(
  document: JsonDocument,
  object: NodeRef,
  name: string,
  value: PortableValue,
  placement: AssociationPlacement,
): PreparedEdit[] {
  const index = resolveTarget(document, object, ['Value']);
  const entity = document.valueEntityAt(index);
  if (!entity.complete) {
    throw new EditFailure('IncompleteTarget');
  }
  if (entity.value.kind !== 'Object') {
    throw new EditFailure('WrongRole');
  }
  const members = entity.value.members;
  let memberFragment = fragment(document, stringValue(name));
  memberFragment = appendBytes(memberFragment, new Uint8Array([0x3a]), document.parseLimits().maxSourceBytes); // ':'
  memberFragment = appendBytes(memberFragment, fragment(document, value), document.parseLimits().maxSourceBytes);
  return [
    prepareInsertion(
      document,
      object,
      entity.span,
      members,
      { anchorRole: 'ObjectMember', open: 'LeftBrace', close: 'RightBrace' },
      placement,
      memberFragment,
    ),
  ];
}

function prepareInsertArrayElement(
  document: JsonDocument,
  array: NodeRef,
  value: PortableValue,
  placement: AssociationPlacement,
): PreparedEdit[] {
  const index = resolveTarget(document, array, ['Value']);
  const entity = document.valueEntityAt(index);
  if (!entity.complete) {
    throw new EditFailure('IncompleteTarget');
  }
  if (entity.value.kind !== 'Array') {
    throw new EditFailure('WrongRole');
  }
  return [
    prepareInsertion(
      document,
      array,
      entity.span,
      entity.value.elements,
      { anchorRole: 'ArrayElement', open: 'LeftBracket', close: 'RightBracket' },
      placement,
      fragment(document, value),
    ),
  ];
}

function prepareInsertion(
  document: JsonDocument,
  container: NodeRef,
  containerSpan: Span,
  associations: readonly number[],
  syntax: InsertionSyntax,
  placement: AssociationPlacement,
  fragment: Uint8Array,
): PreparedEdit {
  let position: number;
  let prefixComma = false;
  let suffixComma = false;
  if (associations.length === 0) {
    switch (placement.kind) {
      case 'Start':
        position = delimiter(document, syntax.open, containerSpan, false).endByte();
        break;
      case 'End':
        position = delimiter(document, syntax.close, containerSpan, true).startByte();
        break;
      case 'Before':
      case 'After':
        throw new EditFailure('TargetNotFound');
    }
  } else {
    switch (placement.kind) {
      case 'Start':
        position = document.spanOf(associations[0]).startByte();
        suffixComma = true;
        break;
      case 'End':
        position = document.spanOf(associations[associations.length - 1]).endByte();
        prefixComma = true;
        break;
      case 'Before': {
        const anchor = resolveAnchor(document, placement.anchor, syntax.anchorRole, associations);
        position = document.spanOf(anchor).startByte();
        suffixComma = true;
        break;
      }
      case 'After': {
        const anchor = resolveAnchor(document, placement.anchor, syntax.anchorRole, associations);
        position = document.spanOf(anchor).endByte();
        prefixComma = true;
        break;
      }
    }
  }
  const pieces: Uint8Array[] = [];
  if (prefixComma) {
    pieces.push(new Uint8Array([0x2c])); // ','
  }
  pieces.push(fragment);
  if (suffixComma) {
    pieces.push(new Uint8Array([0x2c])); // ','
  }
  const replacement = concatBytes(pieces);
  return {
    oldSpan: document.authorityInternal().span(position, position),
    replacement,
    mapping: {
      old: container,
      plan: { kind: 'Unmapped', reason: 'container-reparsed-after-structural-insertion' },
    },
  };
}

function prepareRemoveMember(document: JsonDocument, target: NodeRef): PreparedEdit[] {
  const index = resolveTarget(document, target, ['ObjectMember']);
  const parent = parentObject(document, index);
  if (parent === null) {
    throw new EditFailure('TargetNotFound');
  }
  return prepareRemoval(
    document,
    target,
    index,
    parent.members,
    parent.ordinal,
    document.spanOf(parent.container).endByte(),
  );
}

function prepareMoveMember(
  document: JsonDocument,
  target: NodeRef,
  placement: AssociationPlacement,
): PreparedEdit[] {
  const index = resolveTarget(document, target, ['ObjectMember']);
  const parent = parentObject(document, index);
  if (parent === null) {
    throw new EditFailure('TargetNotFound');
  }
  const remaining = parent.members.filter((member) => member !== index);
  let destination: number;
  if (placement.kind === 'Start') {
    destination = 0;
  } else if (placement.kind === 'End') {
    destination = remaining.length;
  } else {
    if (placement.anchor.equals(target)) {
      throw new EditFailure('PlacementAnchorModified');
    }
    const anchor = resolveAnchor(document, placement.anchor, 'ObjectMember', remaining);
    let position = remaining.indexOf(anchor);
    if (placement.kind === 'After') {
      position += 1;
    }
    destination = position;
  }
  if (destination === parent.ordinal) {
    return [];
  }
  const targetSpan = document.spanOf(index);
  const sourceBytes = document.source().bytes();
  // Typed-array views cannot be frozen in V8; slice detaches a fresh copy.
  const fragment = sourceBytes.slice(targetSpan.startByte(), targetSpan.endByte());
  const containerRef = document.nodeRefFor(parent.container, 'Value');
  const edits = prepareRemoval(
    document,
    target,
    index,
    parent.members,
    parent.ordinal,
    document.spanOf(parent.container).endByte(),
  );
  for (const edit of edits) {
    if (edit.mapping !== null && edit.mapping.old.equals(target)) {
      edit.mapping = { old: target, plan: { kind: 'Unmapped', reason: 'member-reparsed-after-move' } };
    }
  }
  edits.push(
    prepareInsertion(
      document,
      containerRef,
      document.spanOf(parent.container),
      remaining,
      { anchorRole: 'ObjectMember', open: 'LeftBrace', close: 'RightBrace' },
      placement,
      fragment,
    ),
  );
  return edits;
}

function prepareRemoveArrayElement(document: JsonDocument, target: NodeRef): PreparedEdit[] {
  const index = resolveTarget(document, target, ['ArrayElement']);
  const parent = parentArray(document, index);
  if (parent === null) {
    throw new EditFailure('TargetNotFound');
  }
  return prepareRemoval(
    document,
    target,
    index,
    parent.elements,
    parent.ordinal,
    document.spanOf(parent.container).endByte(),
  );
}

function prepareRemoval(
  document: JsonDocument,
  target: NodeRef,
  index: number,
  associations: readonly number[],
  ordinal: number,
  containerEnd: number,
): PreparedEdit[] {
  const targetSpan = document.spanOf(index);
  const edits: PreparedEdit[] = [];
  const comma = removalComma(document, associations, ordinal, containerEnd);
  if (comma !== null) {
    if (
      comma.endByte() === targetSpan.startByte() ||
      comma.startByte() === targetSpan.endByte()
    ) {
      edits.push({
        oldSpan: document
          .authorityInternal()
          .span(
            Math.min(comma.startByte(), targetSpan.startByte()),
            Math.max(comma.endByte(), targetSpan.endByte()),
          ),
        replacement: new Uint8Array(0),
        mapping: { old: target, plan: { kind: 'Deleted' } },
      });
      return edits;
    }
    edits.push({
      oldSpan: targetSpan,
      replacement: new Uint8Array(0),
      mapping: { old: target, plan: { kind: 'Deleted' } },
    });
    edits.push({
      oldSpan: comma,
      replacement: new Uint8Array(0),
      mapping: null,
    });
  } else {
    edits.push({
      oldSpan: targetSpan,
      replacement: new Uint8Array(0),
      mapping: { old: target, plan: { kind: 'Deleted' } },
    });
  }
  return edits;
}

function prepareRenameMember(document: JsonDocument, target: NodeRef, name: string): PreparedEdit {
  const index = resolveTarget(document, target, ['ObjectMember']);
  if (parentObject(document, index) === null) {
    throw new EditFailure('TargetNotFound');
  }
  const entity = document.entityAt(index);
  if (entity.kind !== 'Member') {
    throw new EditFailure('WrongRole');
  }
  const key = document.valueEntityAt(entity.key);
  const oldSpan = key.literalSpan;
  if (oldSpan === null) {
    throw new EditFailure('IncompleteTarget');
  }
  return {
    oldSpan,
    replacement: fragment(document, stringValue(name)),
    mapping: { old: target, plan: { kind: 'Unmapped', reason: 'member-reparsed-after-key-rename' } },
  };
}

function resolveTarget(
  document: JsonDocument,
  target: NodeRef,
  roles: readonly NodeRole[],
): number {
  if (!target.snapshot().equals(document.snapshotIdentity())) {
    throw new EditFailure('WrongSnapshot');
  }
  if (!roles.includes(target.role())) {
    throw new EditFailure('WrongRole');
  }
  try {
    return document.resolveEntityIndex(target, roles);
  } catch {
    throw new EditFailure('TargetNotFound');
  }
}

function resolveAnchor(
  document: JsonDocument,
  anchor: NodeRef,
  role: NodeRole,
  associations: readonly number[],
): number {
  const index = resolveTarget(document, anchor, [role]);
  if (!associations.includes(index)) {
    throw new EditFailure('TargetNotFound');
  }
  return index;
}

function fragment(document: JsonDocument, value: PortableValue): Uint8Array {
  const limits: MaterializationLimits = {
    maxInputNodes: document.parseLimits().maxNodeCount,
    maxOutputBytes: document.parseLimits().maxSourceBytes,
    maxDepth: document.parseLimits().maxNestingDepth,
    maxReportEntries: document.parseLimits().maxDiagnostics,
    maxProvenanceEntries: document.parseLimits().maxNodeCount * 4,
  };
  try {
    return canonicalFragment(value, document.profileInternal(), limits);
  } catch (error) {
    if (error instanceof MaterializationFailure) {
      if (error.kind === 'Unrepresentable') {
        throw new EditFailure('UnrepresentableValue', { valueKind: error.valueKind });
      }
      if (error.kind === 'ResourceLimit') {
        throw new EditFailure('ResourceLimit', { limitName: error.reason });
      }
    }
    throw new EditFailure('NewDocumentFormationFailed');
  }
}

function parentObject(
  document: JsonDocument,
  member: number,
): { container: number; members: readonly number[]; ordinal: number } | null {
  for (let index = 0; index < document.entityCount(); index++) {
    const entity = document.entityAt(index);
    if (entity.kind === 'Value' && entity.value.kind === 'Object') {
      const ordinal = entity.value.members.indexOf(member);
      if (ordinal !== -1) {
        return { container: index, members: entity.value.members, ordinal };
      }
    }
  }
  return null;
}

function parentArray(
  document: JsonDocument,
  element: number,
): { container: number; elements: readonly number[]; ordinal: number } | null {
  for (let index = 0; index < document.entityCount(); index++) {
    const entity = document.entityAt(index);
    if (entity.kind === 'Value' && entity.value.kind === 'Array') {
      const ordinal = entity.value.elements.indexOf(element);
      if (ordinal !== -1) {
        return { container: index, elements: entity.value.elements, ordinal };
      }
    }
  }
  return null;
}

function removalComma(
  document: JsonDocument,
  associations: readonly number[],
  ordinal: number,
  containerEnd: number,
): Span | null {
  const current = document.spanOf(associations[ordinal]);
  const followingEnd =
    ordinal + 1 < associations.length
      ? document.spanOf(associations[ordinal + 1]).startByte()
      : containerEnd;
  const after = syntaxBetween(document, 'Comma', current.endByte(), followingEnd, false);
  if (after !== null) {
    return after;
  }
  if (ordinal === 0) {
    return null;
  }
  const previous = document.spanOf(associations[ordinal - 1]);
  const before = syntaxBetween(document, 'Comma', previous.endByte(), current.startByte(), true);
  if (before === null) {
    throw new EditFailure('IncompleteTarget');
  }
  return before;
}

function delimiter(
  document: JsonDocument,
  kind: JsonSyntaxKind,
  container: Span,
  last: boolean,
): Span {
  const found = syntaxBetween(document, kind, container.startByte(), container.endByte(), last);
  if (found === null) {
    throw new EditFailure('IncompleteTarget');
  }
  return found;
}

function syntaxBetween(
  document: JsonDocument,
  kind: JsonSyntaxKind,
  start: number,
  end: number,
  last: boolean,
): Span | null {
  const pieces = document.losslessStructuralIndex().pieces();
  const kinds = document.losslessSyntaxKinds();
  const matches: Span[] = [];
  for (let index = 0; index < pieces.length; index++) {
    if (kinds[index] !== kind) {
      continue;
    }
    const span = pieces[index].span();
    if (span.startByte() >= start && span.endByte() <= end) {
      matches.push(span);
    }
  }
  if (matches.length === 0) {
    return null;
  }
  return last ? matches[matches.length - 1] : matches[0];
}

function validateDependencies(transaction: EditTransaction): void {
  const destructive = new Set<string>();
  const removed = new Set<string>();
  const anchors: NodeRef[] = [];
  const moved = new Set<string>();
  const moveAnchors: NodeRef[] = [];
  for (const operation of transaction.operations()) {
    switch (operation.kind) {
      case 'ReplaceScalar':
        if (destructive.has(nodeKey(operation.operation.target))) {
          throw new EditFailure('DuplicateTarget');
        }
        destructive.add(nodeKey(operation.operation.target));
        break;
      case 'RemoveMember':
      case 'MoveMember':
      case 'RenameMember':
      case 'RemoveArrayElement':
        if (destructive.has(nodeKey(operation.target))) {
          throw new EditFailure('DuplicateTarget');
        }
        destructive.add(nodeKey(operation.target));
        break;
      case 'InsertMember':
      case 'InsertArrayElement':
        break;
    }
    switch (operation.kind) {
      case 'RemoveMember':
      case 'RemoveArrayElement':
        removed.add(nodeKey(operation.target));
        break;
      case 'InsertMember':
        collectAnchor(operation.placement, false);
        break;
      case 'InsertArrayElement':
        collectAnchor(operation.placement, false);
        break;
      case 'MoveMember':
        collectAnchor(operation.placement, true);
        moved.add(nodeKey(operation.target));
        break;
      case 'ReplaceScalar':
      case 'RenameMember':
        break;
    }
  }
  function collectAnchor(placement: AssociationPlacement, isMove: boolean): void {
    if (placement.kind === 'Before' || placement.kind === 'After') {
      anchors.push(placement.anchor);
      if (isMove) {
        moveAnchors.push(placement.anchor);
      }
    }
  }
  if (anchors.some((anchor) => removed.has(nodeKey(anchor)))) {
    throw new EditFailure('PlacementAnchorRemoved');
  }
  if (
    anchors.some((anchor) => moved.has(nodeKey(anchor))) ||
    moveAnchors.some((anchor) => destructive.has(nodeKey(anchor)))
  ) {
    throw new EditFailure('PlacementAnchorModified');
  }
}

/** Value-identity key of one NodeRef (snapshot:index:role). */
function nodeKey(node: NodeRef): string {
  return `${node.snapshot().asBigInt().toString()}:${node.index().toString()}:${node.role()}`;
}

// ---------------------------------------------------------------------------
// Scalar preservation engine (edit.rs:1346-1862)
// ---------------------------------------------------------------------------

/** Maximum digits a preserved fixed-fraction rendering may produce (edit.rs:1388-1390). */
const MAX_PRESERVED_FRACTION_DIGITS = 1_000_000;

function semanticLiteral(
  value: PortableValue,
  old: InternalValueKind,
  oldLiteral: string,
  profile: JsonProfile,
  policy: RepresentationPolicy,
  targetSpan: Span,
  diagnostics: Diagnostic[],
): Uint8Array {
  if (policy === 'ExactLiteral') {
    throw new EditFailure('ExactLiteralRequiresLiteralOperation');
  }
  if (portableJsonKind(value, profile) === null) {
    throw new EditFailure('UnsupportedSemanticValue', { valueKind: value.kind });
  }
  const style = analyzeLexicalStyle(oldLiteral, old);
  const preserved = style === null ? null : renderPreservingStyle(value, style);
  switch (policy) {
    case 'PreserveCompatible':
      if (preserved === null) {
        throw new EditFailure('RepresentationIncompatible');
      }
      return preserved;
    case 'CanonicalForProfile':
      return canonicalLiteral(value, profile);
    case 'PreserveElseCanonical':
      if (preserved !== null) {
        return preserved;
      }
      diagnostics.push(
        diagnostic(
          'json.edit.representation-fallback@1',
          'Edit',
          'Warning',
          targetSpan.diagnosticLocation(),
          BigInt(diagnostics.length),
        ),
      );
      return canonicalLiteral(value, profile);
  }
}

/** Bounded lexical style retained by `PreserveCompatible` edits (edit.rs:1391-1440). */
type JsonScalarLexicalStyle =
  | { readonly kind: 'Null' }
  | { readonly kind: 'Boolean' }
  | { readonly kind: 'Integer'; readonly style: IntegerLexicalStyle }
  | { readonly kind: 'Decimal'; readonly style: DecimalLexicalStyle }
  | { readonly kind: 'NonFinite'; readonly style: NonFiniteLexicalStyle }
  | { readonly kind: 'String'; readonly style: StringLexicalStyle };

interface IntegerLexicalStyle {
  readonly radix:
    | { readonly kind: 'Decimal' }
    | { readonly kind: 'Hex'; readonly uppercasePrefix: boolean; readonly uppercaseDigits: boolean };
  readonly explicitPlus: boolean;
}

interface DecimalLexicalStyle {
  readonly fractionScale: number | null;
  readonly exponentMarker: string | null;
  readonly exponentPlus: boolean;
  readonly leadingPlus: boolean;
  readonly leadingPoint: boolean;
}

interface NonFiniteLexicalStyle {
  readonly explicitPlus: boolean;
}

interface StringLexicalStyle {
  readonly quote: string;
  readonly escapes: ReadonlyMap<string, string>;
}

function analyzeLexicalStyle(
  literal: string,
  old: InternalValueKind,
): JsonScalarLexicalStyle | null {
  switch (old.kind) {
    case 'Null':
      return { kind: 'Null' };
    case 'Boolean':
      return { kind: 'Boolean' };
    case 'Integer': {
      const unsigned = literal.startsWith('+') || literal.startsWith('-') ? literal.slice(1) : literal;
      const radix = (() => {
        if (unsigned.startsWith('0x') || unsigned.startsWith('0X')) {
          const hex = unsigned.slice(2);
          return {
            kind: 'Hex' as const,
            uppercasePrefix: unsigned.startsWith('0X'),
            uppercaseDigits: /[A-F]/.test(hex),
          };
        }
        return { kind: 'Decimal' as const };
      })();
      return { kind: 'Integer', style: { radix, explicitPlus: literal.startsWith('+') } };
    }
    case 'Decimal': {
      const unsigned = literal.startsWith('+') || literal.startsWith('-') ? literal.slice(1) : literal;
      const exponentIndex = unsigned.search(/[eE]/);
      const mantissa = exponentIndex === -1 ? unsigned : unsigned.slice(0, exponentIndex);
      const fractionScale = mantissa.includes('.')
        ? mantissa.length - mantissa.indexOf('.') - 1
        : null;
      let exponentMarker: string | null = null;
      let exponentPlus = false;
      if (exponentIndex !== -1) {
        exponentMarker = unsigned[exponentIndex];
        exponentPlus = unsigned[exponentIndex + 1] === '+';
      }
      return {
        kind: 'Decimal',
        style: {
          fractionScale,
          exponentMarker,
          exponentPlus,
          leadingPlus: literal.startsWith('+'),
          leadingPoint: mantissa.startsWith('.'),
        },
      };
    }
    case 'BinaryFloat64':
      return { kind: 'NonFinite', style: { explicitPlus: literal.startsWith('+') } };
    case 'String': {
      const style = analyzeStringStyle(literal);
      return style === null ? null : { kind: 'String', style };
    }
    case 'Array':
    case 'Object':
    case 'Unavailable':
      return null;
  }
}

function analyzeStringStyle(literal: string): StringLexicalStyle | null {
  const quote = literal[0];
  if ((quote !== "'" && quote !== '"') || !literal.endsWith(quote)) {
    return null;
  }
  const escapes = new Map<string, string>();
  const inner = literal.slice(1, literal.length - 1);
  let index = 0;
  while (index < inner.length) {
    const character = charAtCodePoint(inner, index);
    if (character !== '\\') {
      index += character.length;
      continue;
    }
    const escapeStart = index;
    index += 1;
    const escaped = charAtCodePoint(inner, index);
    index += escaped.length;
    let decoded: string | null;
    let advance = 0;
    switch (escaped) {
      case '"':
        decoded = '"';
        break;
      case "'":
        decoded = "'";
        break;
      case '\\':
        decoded = '\\';
        break;
      case '/':
        decoded = '/';
        break;
      case 'b':
        decoded = '\b';
        break;
      case 'f':
        decoded = '\f';
        break;
      case 'n':
        decoded = '\n';
        break;
      case 'r':
        decoded = '\r';
        break;
      case 't':
        decoded = '\t';
        break;
      case 'v':
        decoded = '\v';
        break;
      case '0':
        decoded = '\0';
        break;
      case 'x': {
        const hex = inner.slice(index, index + 2);
        if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
          return null;
        }
        advance = 2;
        decoded = String.fromCodePoint(Number.parseInt(hex, 16));
        break;
      }
      case 'u': {
        const first = readHexQuad(inner, index);
        if (first === null) {
          return null;
        }
        if (first >= 0xd800 && first <= 0xdbff) {
          if (inner.slice(index + 4, index + 6) !== '\\u') {
            return null;
          }
          const second = readHexQuad(inner, index + 6);
          if (second === null || !(second >= 0xdc00 && second <= 0xdfff)) {
            return null;
          }
          advance = 10;
          decoded = String.fromCodePoint(0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00));
        } else if (first >= 0xdc00 && first <= 0xdfff) {
          return null;
        } else {
          advance = 4;
          decoded = String.fromCodePoint(first);
        }
        break;
      }
      case '\r':
        if (charAtCodePoint(inner, index) === '\n') {
          index += 1;
        }
        decoded = null;
        break;
      case '\n':
      case '\u2028':
      case '\u2029':
        decoded = null;
        break;
      default:
        decoded = escaped;
        break;
    }
    if (decoded !== null) {
      escapes.set(decoded, inner.slice(escapeStart, index + advance));
    }
    index += advance;
  }
  return { quote, escapes };
}

function renderPreservingStyle(
  value: PortableValue,
  style: JsonScalarLexicalStyle,
): Uint8Array | null {
  switch (style.kind) {
    case 'Null':
      return value.kind === 'Null' ? encodeText('null') : null;
    case 'Boolean':
      return value.kind === 'Boolean'
        ? encodeText(value.value ? 'true' : 'false')
        : null;
    case 'Integer':
      return value.kind === 'Integer' ? renderIntegerStyle(value.value, style.style) : null;
    case 'Decimal':
      return value.kind === 'Decimal' || value.kind === 'Integer'
        ? renderDecimalStyle(value, style.style)
        : null;
    case 'NonFinite':
      return value.kind === 'BinaryFloat64'
        ? renderNonFiniteStyle(value.bits, style.style)
        : null;
    case 'String':
      return value.kind === 'String'
        ? encodeText(renderStringStyle(value.value, style.style))
        : null;
  }
}

function renderIntegerStyle(value: bigint, style: IntegerLexicalStyle): Uint8Array | null {
  let output = '';
  if (value < 0n) {
    output += '-';
  } else if (style.explicitPlus) {
    output += '+';
  }
  const magnitude = value < 0n ? -value : value;
  switch (style.radix.kind) {
    case 'Decimal':
      output += magnitude.toString();
      break;
    case 'Hex': {
      output += style.radix.uppercasePrefix ? '0X' : '0x';
      let digits = magnitude.toString(16);
      if (style.radix.uppercaseDigits) {
        digits = digits.toUpperCase();
      }
      output += digits;
      break;
    }
  }
  return encodeText(output);
}

function renderDecimalStyle(
  value: PortableValue,
  style: DecimalLexicalStyle,
): Uint8Array | null {
  const coefficient = value.kind === 'Decimal' ? value.coefficient : value.kind === 'Integer' ? value.value : null;
  const exponent = value.kind === 'Decimal' ? value.exponent : value.kind === 'Integer' ? 0n : null;
  if (coefficient === null || exponent === null) {
    return null;
  }
  let output: string;
  if (style.exponentMarker !== null) {
    const scale = style.fractionScale ?? 0;
    let mantissa = style.fractionScale !== null ? decimalFixedText(coefficient, scale) : coefficient.toString();
    if (style.leadingPoint) {
      const stripped = removeLeadingZero(mantissa);
      if (stripped === null) {
        return null;
      }
      mantissa = stripped;
    }
    const exponentValue = bigintToI64(exponent);
    if (exponentValue === null) {
      return null;
    }
    const combined = exponentValue + scale;
    mantissa += style.exponentMarker;
    if (combined >= 0 && style.exponentPlus) {
      mantissa += '+';
    }
    mantissa += String(combined);
    output = mantissa;
  } else {
    const scale = style.fractionScale;
    if (scale === null) {
      return null;
    }
    const exponentValue = bigintToI64(exponent);
    if (exponentValue === null) {
      return null;
    }
    let shift: number;
    if (exponentValue >= 0) {
      shift = exponentValue + scale;
    } else {
      const magnitude = -exponentValue;
      if (magnitude > scale) {
        return null;
      }
      shift = scale - magnitude;
    }
    if (shift > MAX_PRESERVED_FRACTION_DIGITS) {
      return null;
    }
    const mantissa = coefficient * 10n ** BigInt(shift);
    output = decimalFixedText(mantissa, scale);
    if (style.leadingPoint) {
      const stripped = removeLeadingZero(output);
      if (stripped === null) {
        return null;
      }
      output = stripped;
    }
  }
  if (style.leadingPlus && !output.startsWith('-')) {
    output = '+' + output;
  }
  return encodeText(output);
}

/** Strips the leading zero of a leading-point decimal ("-0.5" → "-.5", "0.5" → ".5"); null when not leading-point (edit.rs:1704-1709). */
function removeLeadingZero(text: string): string | null {
  const zero = text.startsWith('-0.') ? 1 : 0;
  if (text.slice(zero, zero + 2) !== '0.') {
    return null;
  }
  return text.slice(0, zero) + text.slice(zero + 1);
}

function renderNonFiniteStyle(bits: bigint, style: NonFiniteLexicalStyle): Uint8Array | null {
  let text: string | null;
  switch (bits) {
    case 0x7ff0000000000000n:
      text = style.explicitPlus ? '+Infinity' : 'Infinity';
      break;
    case 0xfff0000000000000n:
      text = '-Infinity';
      break;
    case 0x7ff8000000000000n:
      text = style.explicitPlus ? '+NaN' : 'NaN';
      break;
    case 0xfff8000000000000n:
      text = '-NaN';
      break;
    default:
      return null;
  }
  return encodeText(text);
}

function decimalFixedText(mantissa: bigint, scale: number): string {
  const text = mantissa.toString();
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  if (digits.length <= scale) {
    return `${negative ? '-' : ''}0.${'0'.repeat(scale - digits.length)}${digits}`;
  }
  const split = digits.length - scale;
  return `${negative ? '-' : ''}${digits.slice(0, split)}.${digits.slice(split)}`;
}

function renderStringStyle(value: string, style: StringLexicalStyle): string {
  let output = style.quote;
  for (const character of value) {
    const escape = style.escapes.get(character);
    if (escape !== undefined) {
      output += escape;
    } else {
      output += pushJsonStringChar(character, style.quote, false);
    }
  }
  output += style.quote;
  return output;
}

function portableJsonKind(value: PortableValue, profile: JsonProfile): JsonValueKind | null {
  switch (value.kind) {
    case 'Null':
      return 'Null';
    case 'Boolean':
      return 'Boolean';
    case 'Integer':
      return 'Integer';
    case 'Decimal':
      return 'Decimal';
    case 'BinaryFloat64':
      return isJson5(profile) ? 'BinaryFloat64' : null;
    case 'String':
      return 'String';
    default:
      return null;
  }
}

function canonicalLiteral(value: PortableValue, profile: JsonProfile): Uint8Array {
  let text: string;
  switch (value.kind) {
    case 'Null':
      text = 'null';
      break;
    case 'Boolean':
      text = value.value ? 'true' : 'false';
      break;
    case 'Integer':
      text = value.value.toString();
      break;
    case 'Decimal':
      text = `${value.coefficient}e${value.exponent}`;
      break;
    case 'BinaryFloat64': {
      if (!isJson5(profile)) {
        throw new EditFailure('UnsupportedSemanticValue', { valueKind: value.kind });
      }
      const rendered = renderNonFiniteStyle(value.bits, { explicitPlus: false });
      if (rendered === null) {
        throw new EditFailure('UnsupportedSemanticValue', { valueKind: value.kind });
      }
      return rendered;
    }
    case 'String':
      text = encodeJsonString(value.value, isJson5(profile));
      break;
    default:
      throw new EditFailure('UnsupportedSemanticValue', { valueKind: value.kind });
  }
  return encodeText(text);
}

function encodeJsonString(value: string, json5: boolean): string {
  let output = '"';
  for (const character of value) {
    output += pushJsonStringChar(character, '"', json5);
  }
  output += '"';
  return output;
}

function pushJsonStringChar(character: string, quote: string, canonicalJson5: boolean): string {
  const codePoint = character.codePointAt(0)!;
  if (character === quote) {
    return `\\${character}`;
  }
  switch (character) {
    case '\\':
      return '\\\\';
    case '\b':
      return '\\b';
    case '\f':
      return '\\f';
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    default:
      if (codePoint <= 0x1f) {
        return `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
      }
      if ((codePoint === 0x2028 || codePoint === 0x2029) && canonicalJson5) {
        return `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
      }
      return character;
  }
}

function validateLiteral(
  literal: Uint8Array,
  profile: JsonProfile,
  limits: ParseLimits,
): JsonValueKind {
  if (literal.length === 0) {
    throw new EditFailure('InvalidLiteral');
  }
  let document: JsonDocument;
  try {
    document = parse(literal, profile, limits);
  } catch {
    throw new EditFailure('InvalidLiteral');
  }
  const kind = document.root().kind();
  const span = document.root().span();
  if (
    document.formationStatus() !== 'Complete' ||
    span.startByte() !== 0 ||
    span.endByte() !== literal.length ||
    kind.kind !== 'Available' ||
    !(
      kind.value === 'Null' ||
      kind.value === 'Boolean' ||
      kind.value === 'Integer' ||
      kind.value === 'Decimal' ||
      kind.value === 'BinaryFloat64' ||
      kind.value === 'String'
    )
  ) {
    throw new EditFailure('InvalidLiteral');
  }
  return kind.value;
}

function findValueByLiteralSpan(
  document: JsonDocument,
  start: number,
  end: number,
): number | null {
  let found: number | null = null;
  for (let index = 0; index < document.entityCount(); index++) {
    const entity = document.entityAt(index);
    if (entity.kind !== 'Value' || entity.literalSpan === null) {
      continue;
    }
    if (entity.literalSpan.startByte() === start && entity.literalSpan.endByte() === end) {
      if (found !== null) {
        return null;
      }
      found = index;
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Plan metadata (edit.rs:1095-1267)
// ---------------------------------------------------------------------------

function sourcePatchLimits(parseLimits: ParseLimits, operationCount: number): SourcePatchLimits {
  const source: SourceLimits = {
    maxRawBytes: parseLimits.maxSourceBytes,
    maxDecodedUtf8Bytes: parseLimits.maxSourceBytes,
    maxDecodedScalars: parseLimits.maxSourceBytes,
  };
  return {
    source,
    maxReplacements: operationCount,
    maxPatchBytes: parseLimits.maxSourceBytes * 2,
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
    case 'ReplaceScalar':
      return operation.operation.kind === 'Semantic'
        ? 'json.edit.replace-scalar-semantic@1'
        : 'json.edit.replace-scalar-literal@1';
    case 'InsertMember':
      return 'json.edit.insert-member@1';
    case 'RemoveMember':
      return 'json.edit.remove-member@1';
    case 'MoveMember':
      return 'json.edit.move-member@1';
    case 'RenameMember':
      return 'json.edit.rename-member@1';
    case 'InsertArrayElement':
      return 'json.edit.insert-array-element@1';
    case 'RemoveArrayElement':
      return 'json.edit.remove-array-element@1';
  }
}

function operationSummaries(transaction: EditTransaction): EditOperationSummary[] {
  return transaction.operations().map((operation) => {
    const { id, targetRole, arguments: summary } = operationSummary(operation);
    const all = new Map([...summary, ['target_role', targetRole]]);
    try {
      return new EditOperationSummary(new FormatOperationId(id, 1), all);
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
    case 'ReplaceScalar':
      if (operation.operation.kind === 'Semantic') {
        return {
          id: 'json.edit.replace-scalar-semantic',
          targetRole: 'json.scalar@1',
          arguments: new Map([
            ['representation_policy', policyName(operation.operation.policy)],
            ['value_kind', valueKindName(operation.operation.value.kind)],
          ]),
        };
      }
      return {
        id: 'json.edit.replace-scalar-literal',
        targetRole: 'json.scalar@1',
        arguments: new Map([['literal_bytes', String(operation.operation.literal.length)]]),
      };
    case 'InsertMember':
      return {
        id: 'json.edit.insert-member',
        targetRole: 'json.object@1',
        arguments: new Map([
          ['name_bytes', String(utf8ByteLength(operation.name))],
          ['placement', placementName(operation.placement)],
          ['value_kind', valueKindName(operation.value.kind)],
        ]),
      };
    case 'RemoveMember':
      return { id: 'json.edit.remove-member', targetRole: 'json.object-member@1', arguments: new Map() };
    case 'MoveMember':
      return {
        id: 'json.edit.move-member',
        targetRole: 'json.object-member@1',
        arguments: new Map([['placement', placementName(operation.placement)]]),
      };
    case 'RenameMember':
      return {
        id: 'json.edit.rename-member',
        targetRole: 'json.object-member@1',
        arguments: new Map([['name_bytes', String(utf8ByteLength(operation.name))]]),
      };
    case 'InsertArrayElement':
      return {
        id: 'json.edit.insert-array-element',
        targetRole: 'json.array@1',
        arguments: new Map([
          ['placement', placementName(operation.placement)],
          ['value_kind', valueKindName(operation.value.kind)],
        ]),
      };
    case 'RemoveArrayElement':
      return { id: 'json.edit.remove-array-element', targetRole: 'json.array-element@1', arguments: new Map() };
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

function policyName(policy: RepresentationPolicy): string {
  switch (policy) {
    case 'ExactLiteral':
      return 'exact-literal';
    case 'PreserveCompatible':
      return 'preserve-compatible';
    case 'CanonicalForProfile':
      return 'canonical-for-profile';
    case 'PreserveElseCanonical':
      return 'preserve-else-canonical';
  }
}

function valueKindName(kind: Kind): string {
  switch (kind) {
    case 'Null':
      return 'null';
    case 'Boolean':
      return 'boolean';
    case 'Integer':
      return 'integer';
    case 'Decimal':
      return 'decimal';
    case 'BinaryFloat32':
      return 'binary-float32';
    case 'BinaryFloat64':
      return 'binary-float64';
    case 'String':
      return 'string';
    case 'Bytes':
      return 'bytes';
    case 'Date':
      return 'date';
    case 'Time':
      return 'time';
    case 'LocalDateTime':
      return 'local-date-time';
    case 'OffsetDateTime':
      return 'offset-date-time';
    case 'Sequence':
      return 'sequence';
    case 'Object':
      return 'object';
    case 'EntryMapping':
      return 'entry-mapping';
  }
}

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decodeUtf8Slice(bytes: Uint8Array, start: number, end: number): string {
  return new TextDecoder().decode(bytes.subarray(start, end));
}

function appendBytes(target: Uint8Array, fragment: Uint8Array, max: number): Uint8Array {
  if (target.length + fragment.length > max) {
    throw new EditFailure('ResourceLimit', { limitName: 'insert-fragment' });
  }
  const combined = new Uint8Array(target.length + fragment.length);
  combined.set(target);
  combined.set(fragment, target.length);
  return combined;
}

function concatBytes(pieces: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const piece of pieces) {
    length += piece.length;
  }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) {
    combined.set(piece, offset);
    offset += piece.length;
  }
  return combined;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function bigintToI64(value: bigint): number | null {
  if (value < -9223372036854775808n || value > 9223372036854775807n) {
    return null;
  }
  return Number(value);
}

/**
 * Reads the code point at a code-unit index (JS strings are UTF-16
 * indexed). Past the end, a NUL sentinel is returned: NUL can never be a
 * real continuation character of any checked escape form, so the call
 * sites behave like the Rust `chars().peek()` at end-of-input (None).
 */
function charAtCodePoint(text: string, index: number): string {
  if (index >= text.length) {
    return '\0';
  }
  return String.fromCodePoint(text.codePointAt(index)!);
}

/** Reads four hexadecimal digits as a UTF-16 code unit (edit.rs:1546-1547). */
function readHexQuad(text: string, index: number): number | null {
  const digits = text.slice(index, index + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
    return null;
  }
  return Number.parseInt(digits, 16);
}
