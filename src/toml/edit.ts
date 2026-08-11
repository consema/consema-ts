/**
 * TOML scalar and structural edit transactions with atomic commit.
 *
 * authority:
 *  - representation policies: crates/consema-toml/src/edit.rs:15-26
 *  - operation vocabulary: edit.rs:28-99 (ScalarReplacement/EditOperation),
 *    the registry ids (operation_registry.rs:18-73; RFC 0004 §10
 *    :256-261), and the target roles toml.table-item@1 / toml.entry@1 /
 *    toml.array-item@1 / toml.array-element@1 / toml.scalar-item@1
 *  - commit algebra: edit.rs:281-430 (atomicity, conflict checks,
 *    source-edit preparation, reparse, mapping, ChangeSet)
 *  - preparation rules: edit.rs:449-1062 (scalar, entry/array insertion
 *    with comma ownership, removal, rename, line helpers, newline
 *    preservation, removal comma)
 *  - dependency validation: edit.rs:1064-1100 (DuplicateTarget,
 *    PlacementAnchorRemoved)
 *  - canonical literal spellings: edit.rs:1472-1616 (string escaping,
 *    float canonical form, date/time/offset forms)
 *  - exact literal validation: edit.rs:1379-1413 (one complete scalar,
 *    span-exact)
 *  - semantic boundaries: edit.rs:1415-1456 (policy algebra; the
 *    representation-fallback diagnostic carries toml.edit.representation-
 *    fallback@1, error_registry.rs:339)
 *  - summaries and metadata: edit.rs:1132-1278 (operation.{index}
 *    metadata keys must match the SourcePatch metadata exactly; the
 *    EditPlan constructor enforces it, document/edit_plan.ts:101-110)
 *  - failure mapping: edit.rs:1308-1331 (core.edit.* codes, RFC 0004 §17)
 *
 * Design (TypeScript-idiomatic): an immutable transaction built through a
 * builder; `commit` validates and plans every operation before publishing
 * anything — a failure never changes the base snapshot. The prepared
 * source edits are byte-exact replacements; the commit returns the new
 * Document, ChangeSet, derived SourcePatch, and untouched-byte proof.
 */

import { NodeRef, SnapshotIdentity, Span } from '../document/identity.ts';
import type { AssociationPlacement } from '../document/identity.ts';
import { ChangeSet, NodeMapping, SourceEdit } from '../document/change_set.ts';
import { SourcePatch } from '../document/source_patch.ts';
import type { SourcePatchLimits } from '../document/source_patch.ts';
import { UntouchedByteProof } from '../document/untouched_proof.ts';
import { EditPlan, EditOperationSummary, EditPlanSourceId } from '../document/edit_plan.ts';
import { FormatOperationId } from '../document/operation.ts';
import { diagnostic as makeDiagnostic } from '../document/diagnostic.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import type { MaterializationLimits } from '../document/materialization.ts';
import type { PortableValue } from '../core/value.ts';
import { TomlDocument, parseToml, itemKindOf } from './document.ts';
import { TomlFormationFailure, TomlEditFailure, valueKindName } from './errors.ts';
import { MaterializationFailure } from '../document/errors.ts';
import { canonicalTomlFragment } from './materialization.ts';
import { floatFromBits } from './parser.ts';
import type { TomlSyntaxKind } from './tokenizer.ts';
import { TomlProfile } from './profile.ts';

// ---------------------------------------------------------------------------
// Representation policy and operations (edit.rs:15-99)
// ---------------------------------------------------------------------------

/** Explicit semantic scalar representation policy (edit.rs:16-26). */
export type TomlRepresentationPolicy =
  | 'ExactLiteral'
  | 'PreserveCompatible'
  | 'CanonicalForProfile'
  | 'PreserveElseCanonical';

/** One scalar operation bound to a transaction base snapshot (edit.rs:28-47). */
export type TomlScalarReplacement =
  | {
      readonly kind: 'Semantic';
      readonly target: NodeRef;
      readonly value: PortableValue;
      readonly policy: TomlRepresentationPolicy;
    }
  | {
      readonly kind: 'Literal';
      readonly target: NodeRef;
      readonly literal: Uint8Array;
    };

/** One typed TOML edit operation bound to an immutable base snapshot (edit.rs:57-99). */
export type TomlEditOperation =
  | { readonly kind: 'ReplaceScalar'; readonly replacement: TomlScalarReplacement }
  | {
      readonly kind: 'InsertEntry';
      readonly table: NodeRef;
      readonly key: string;
      readonly value: PortableValue;
      readonly placement: AssociationPlacement;
    }
  | { readonly kind: 'RemoveEntry'; readonly target: NodeRef }
  | { readonly kind: 'RenameEntry'; readonly target: NodeRef; readonly key: string }
  | {
      readonly kind: 'InsertArrayElement';
      readonly array: NodeRef;
      readonly value: PortableValue;
      readonly placement: AssociationPlacement;
    }
  | { readonly kind: 'RemoveArrayElement'; readonly target: NodeRef };

/** Immutable transaction; every operation resolves against one base snapshot (edit.rs:101-120). */
export class TomlEditTransaction {
  readonly #base: SnapshotIdentity;
  readonly #operations: readonly TomlEditOperation[];

  /** @internal — built via TomlEditTransactionBuilder. */
  constructor(base: SnapshotIdentity, operations: readonly TomlEditOperation[]) {
    this.#base = base;
    this.#operations = Object.freeze([...operations]);
  }

  /** Base snapshot identity (edit.rs:109-112). */
  baseSnapshot(): SnapshotIdentity {
    return this.#base;
  }

  /** Ordered declared operations (edit.rs:114-119). */
  operations(): readonly TomlEditOperation[] {
    return this.#operations;
  }
}

/** Builder that is not a committed edit (edit.rs:122-227). */
export class TomlEditTransactionBuilder {
  readonly #base: SnapshotIdentity;
  readonly #operations: TomlEditOperation[] = [];

  /** Binds a new transaction to one immutable base document (edit.rs:130-137). */
  constructor(document: TomlDocument) {
    this.#base = document.snapshotIdentity();
  }

  /** Adds a semantic scalar replacement (edit.rs:140-153). */
  semanticScalar(
    target: NodeRef,
    value: PortableValue,
    policy: TomlRepresentationPolicy,
  ): TomlEditTransactionBuilder {
    this.#operations.push({
      kind: 'ReplaceScalar',
      replacement: { kind: 'Semantic', target, value, policy },
    });
    return this;
  }

  /** Adds an exact TOML scalar literal replacement (edit.rs:155-163). */
  literalScalar(target: NodeRef, literal: Uint8Array): TomlEditTransactionBuilder {
    this.#operations.push({
      kind: 'ReplaceScalar',
      replacement: { kind: 'Literal', target, literal },
    });
    return this;
  }

  /** Adds one direct TOML table entry insertion (edit.rs:165-180). */
  insertEntry(
    table: NodeRef,
    key: string,
    value: PortableValue,
    placement: AssociationPlacement,
  ): TomlEditTransactionBuilder {
    this.#operations.push({ kind: 'InsertEntry', table, key, value, placement });
    return this;
  }

  /** Adds one exact TOML table entry removal (edit.rs:182-186). */
  removeEntry(target: NodeRef): TomlEditTransactionBuilder {
    this.#operations.push({ kind: 'RemoveEntry', target });
    return this;
  }

  /** Adds one exact TOML direct key rename (edit.rs:188-195). */
  renameEntry(target: NodeRef, key: string): TomlEditTransactionBuilder {
    this.#operations.push({ kind: 'RenameEntry', target, key });
    return this;
  }

  /** Adds one TOML array element insertion (edit.rs:197-209). */
  insertArrayElement(
    array: NodeRef,
    value: PortableValue,
    placement: AssociationPlacement,
  ): TomlEditTransactionBuilder {
    this.#operations.push({ kind: 'InsertArrayElement', array, value, placement });
    return this;
  }

  /** Adds one exact TOML array element removal (edit.rs:211-217). */
  removeArrayElement(target: NodeRef): TomlEditTransactionBuilder {
    this.#operations.push({ kind: 'RemoveArrayElement', target });
    return this;
  }

  /** Completes the immutable request; target validation occurs atomically at commit (edit.rs:219-227). */
  build(): TomlEditTransaction {
    return new TomlEditTransaction(this.#base, this.#operations);
  }
}

/** Atomic edit success (edit.rs:229-240). */
export class TomlEditCommit {
  readonly #document: TomlDocument;
  readonly #changeSet: ChangeSet;
  readonly #sourcePatch: SourcePatch;
  readonly #untouchedProof: UntouchedByteProof;

  constructor(
    document: TomlDocument,
    changeSet: ChangeSet,
    sourcePatch: SourcePatch,
    untouchedProof: UntouchedByteProof,
  ) {
    this.#document = document;
    this.#changeSet = changeSet;
    this.#sourcePatch = sourcePatch;
    this.#untouchedProof = untouchedProof;
  }

  /** New immutable document (edit.rs:231-233). */
  document(): TomlDocument {
    return this.#document;
  }

  /** Complete old-to-new change facts (edit.rs:234-236). */
  changeSet(): ChangeSet {
    return this.#changeSet;
  }

  /** Portable exact raw-byte application fact (edit.rs:237-239). */
  sourcePatch(): SourcePatch {
    return this.#sourcePatch;
  }

  /** Verifiable evidence for every byte outside the replacement set (edit.rs:240-242). */
  untouchedProof(): UntouchedByteProof {
    return this.#untouchedProof;
  }
}

// ---------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------

type MappingPlan =
  | { readonly kind: 'ReplacedLiteral' }
  | { readonly kind: 'Deleted' }
  | { readonly kind: 'Unmapped'; readonly reason: string };

interface PreparedEdit {
  readonly oldSpan: Span;
  readonly replacement: Uint8Array;
  readonly mapping: { readonly old: NodeRef; readonly plan: MappingPlan } | null;
}

interface DelimitedSyntax {
  readonly anchorRole: 'TomlEntry' | 'TomlArrayElement';
  readonly open: TomlSyntaxKind;
  readonly close: TomlSyntaxKind;
}

/** Prepares and validates every operation against one snapshot (edit.rs:281-447). */
export function commitTomlEdits(
  document: TomlDocument,
  transaction: TomlEditTransaction,
): TomlEditCommit {
  if (!transaction.baseSnapshot().equals(document.snapshotIdentity())) {
    throw new TomlEditFailure('WrongSnapshot');
  }
  validateDependencies(transaction);

  const diagnostics: Diagnostic[] = [];
  const prepared: PreparedEdit[] = [];
  for (const operation of transaction.operations()) {
    prepared.push(...prepareOperation(document, operation, diagnostics));
  }

  prepared.sort((left, right) => {
    const leftStart = left.oldSpan.startByte();
    const rightStart = right.oldSpan.startByte();
    if (leftStart !== rightStart) return leftStart - rightStart;
    return left.oldSpan.endByte() - right.oldSpan.endByte();
  });
  for (let i = 1; i < prepared.length; i++) {
    const previous = prepared[i - 1].oldSpan;
    const current = prepared[i].oldSpan;
    if (
      !previous.isEmpty() &&
      !current.isEmpty() &&
      (previous.endByte() > current.startByte() || spansEqual(previous, current))
    ) {
      throw new TomlEditFailure('AncestorDescendantConflict');
    }
    if (
      spansEqual(previous, current) ||
      (previous.isEmpty() && current.isEmpty() && previous.startByte() === current.startByte())
    ) {
      throw new TomlEditFailure('OverlappingOwnership');
    }
  }

  const source = document.source().bytes();
  let targetLen = source.length;
  for (const edit of prepared) {
    targetLen = targetLen - edit.oldSpan.len() + edit.replacement.length;
    if (targetLen < 0 || targetLen > document.parseLimits().maxSourceBytes) {
      throw new TomlEditFailure('ResourceLimit', { limitName: 'target-bytes' });
    }
  }

  const rendered: number[] = [];
  let cursor = 0;
  for (const edit of prepared) {
    rendered.push(...source.subarray(cursor, edit.oldSpan.startByte()));
    rendered.push(...edit.replacement);
    cursor = edit.oldSpan.endByte();
  }
  rendered.push(...source.subarray(cursor));
  // prepared spans are base-bound; the re-parse of the rendered bytes below
  // revalidates every fragment before any success artifact is published.

  let newDocument: TomlDocument;
  try {
    newDocument = parseToml(
      Uint8Array.from(rendered),
      TomlProfile.TOML_10_V1,
      document.parseLimits(),
    );
  } catch (error) {
    if (error instanceof TomlFormationFailure) {
      throw new TomlEditFailure('NewDocumentFormationFailed');
    }
    throw error;
  }

  const sourceEdits: SourceEdit[] = [];
  const mappings: NodeMapping[] = [];
  const mappedOld = new Set<NodeRef>();
  let delta = 0;
  for (const edit of prepared) {
    const newStart = edit.oldSpan.startByte() + delta;
    const newEnd = newStart + edit.replacement.length;
    const newSpan = newDocument.authority().span(newStart, newEnd);
    sourceEdits.push(new SourceEdit(edit.oldSpan, newSpan, edit.replacement));
    if (edit.mapping !== null && !mappedOld.has(edit.mapping.old)) {
      mappedOld.add(edit.mapping.old);
      const mapping = edit.mapping;
      if (mapping.plan.kind === 'ReplacedLiteral') {
        const index = findItemBySpan(newDocument, newStart, newEnd);
        mappings.push(
          new NodeMapping(
            mapping.old,
            'Replaced',
            index === null ? null : newDocument.nodeRef(index, 'TomlItem'),
            index === null ? 'reparsed-item-not-uniquely-located' : null,
          ),
        );
      } else if (mapping.plan.kind === 'Deleted') {
        mappings.push(new NodeMapping(mapping.old, 'Deleted', null, null));
      } else {
        mappings.push(new NodeMapping(mapping.old, 'Unmapped', null, mapping.plan.reason));
      }
    }
    delta = delta + edit.replacement.length - edit.oldSpan.len();
  }

  const changeSet = new ChangeSet(
    document.snapshotIdentity(),
    newDocument.snapshotIdentity(),
    sourceEdits,
    mappings,
    diagnostics,
  );
  const patchLimits = sourcePatchLimitsFor(document.parseLimits(), sourceEdits.length);
  let sourcePatch: SourcePatch;
  try {
    sourcePatch = SourcePatch.derive(
      document.source(),
      newDocument.source(),
      changeSet,
      operationMetadata(transaction),
      patchLimits,
    );
  } catch (error) {
    throw new TomlEditFailure('NewDocumentFormationFailed');
  }
  let untouchedProof: UntouchedByteProof;
  try {
    untouchedProof = UntouchedByteProof.create(
      document.source(),
      newDocument.source(),
      sourcePatch.replacements(),
    );
  } catch (error) {
    throw new TomlEditFailure('NewDocumentFormationFailed');
  }
  return new TomlEditCommit(newDocument, changeSet, sourcePatch, untouchedProof);
}

function spansEqual(left: Span, right: Span): boolean {
  return left.startByte() === right.startByte() && left.endByte() === right.endByte();
}

/** Fully validates and plans an edit without returning a new Document (edit.rs:432-447). */
export function dryRunTomlEdits(
  document: TomlDocument,
  transaction: TomlEditTransaction,
  sourceId: EditPlanSourceId,
): EditPlan {
  const commit = commitTomlEdits(document, transaction);
  let plan: EditPlan;
  try {
    plan = new EditPlan(
      sourceId,
      document.profile(),
      operationSummaries(transaction),
      commit.sourcePatch(),
      commit.changeSet().diagnostics(),
    );
  } catch (error) {
    throw new TomlEditFailure('NewDocumentFormationFailed');
  }
  return plan;
}

function prepareOperation(
  document: TomlDocument,
  operation: TomlEditOperation,
  diagnostics: Diagnostic[],
): PreparedEdit[] {
  switch (operation.kind) {
    case 'ReplaceScalar':
      return [prepareScalar(document, operation.replacement, diagnostics)];
    case 'InsertEntry':
      return prepareInsertEntry(document, operation.table, operation.key, operation.value, operation.placement);
    case 'RemoveEntry':
      return prepareRemoveEntry(document, operation.target);
    case 'RenameEntry':
      return [prepareRenameEntry(document, operation.target, operation.key)];
    case 'InsertArrayElement':
      return prepareInsertArrayElement(document, operation.array, operation.value, operation.placement);
    case 'RemoveArrayElement':
      return prepareRemoveArrayElement(document, operation.target);
  }
}

// -- scalar -------------------------------------------------------------------

function prepareScalar(
  document: TomlDocument,
  operation: TomlScalarReplacement,
  diagnostics: Diagnostic[],
): PreparedEdit {
  const target = operation.target;
  const index = resolveTarget(document, target, 'TomlItem');
  const oldKind = itemKindOf(document.itemEntity(index));
  if (!isScalarKind(oldKind)) {
    throw new TomlEditFailure('WrongRole');
  }
  const replacement =
    operation.kind === 'Literal'
      ? validateExactScalar(document, operation.literal)
      : semanticLiteral(document, operation.value, oldKind, operation.policy, document.entity(index).span, diagnostics);
  return {
    oldSpan: document.entity(index).span,
    replacement,
    mapping: { old: target, plan: { kind: 'ReplacedLiteral' } },
  };
}

function semanticLiteral(
  document: TomlDocument,
  value: PortableValue,
  oldKind: string,
  policy: TomlRepresentationPolicy,
  targetSpan: Span,
  diagnostics: Diagnostic[],
): Uint8Array {
  if (policy === 'ExactLiteral') {
    throw new TomlEditFailure('ExactLiteralRequiresLiteralOperation');
  }
  const newKind = portableTomlKind(value);
  if (newKind === null) {
    throw new TomlEditFailure('UnsupportedSemanticValue', { valueKind: value.kind });
  }
  const compatible = oldKind === newKind;
  switch (policy) {
    case 'PreserveCompatible':
      if (!compatible) {
        throw new TomlEditFailure('RepresentationIncompatible');
      }
      break;
    case 'PreserveElseCanonical':
      if (!compatible) {
        const event = makeDiagnostic(
          'toml.edit.representation-fallback@1',
          'Edit',
          'Warning',
          targetSpan.diagnosticLocation(),
          BigInt(diagnostics.length),
          {
            arguments: [
              ['old_kind', oldKind],
              ['new_kind', newKind],
            ],
          },
        );
        diagnostics.push(event);
      }
      break;
    case 'CanonicalForProfile':
      break;
  }
  const literal = canonicalLiteral(value);
  const validatedKind = validateExactScalarKind(document, new TextEncoder().encode(literal));
  if (validatedKind !== newKind) {
    throw new TomlEditFailure('UnsupportedSemanticValue', { valueKind: value.kind });
  }
  return new TextEncoder().encode(literal);
}

// -- structural ---------------------------------------------------------------

function prepareInsertEntry(
  document: TomlDocument,
  table: NodeRef,
  key: string,
  value: PortableValue,
  placement: AssociationPlacement,
): PreparedEdit[] {
  const tableIndex = resolveTarget(document, table, 'TomlItem');
  const item = document.itemEntity(tableIndex);
  const entries = item.kind === 'Table' || item.kind === 'InlineTable' ? item.entries : null;
  if (entries === null) {
    throw new TomlEditFailure('WrongRole');
  }
  const kind = itemKindOf(item);
  if (kind !== 'RootTable' && kind !== 'StandardTable' && kind !== 'InlineTable') {
    throw new TomlEditFailure('UnsupportedOperation');
  }
  if (entries.some((entry) => entryNameOf(document, entry) === key)) {
    throw new TomlEditFailure('DuplicateKey');
  }
  const keyBytes = new TextEncoder().encode(canonicalString(key));
  const valueBytes = canonicalFragment(document, value);
  if (keyBytes.length + 3 + valueBytes.length > document.parseLimits().maxSourceBytes) {
    throw new TomlEditFailure('ResourceLimit', { limitName: 'insert-fragment' });
  }
  const fragment = new Uint8Array(keyBytes.length + 3 + valueBytes.length);
  fragment.set(keyBytes, 0);
  fragment.set(Uint8Array.of(0x20, 0x3d, 0x20), keyBytes.length); // " = "
  fragment.set(valueBytes, keyBytes.length + 3);
  if (kind === 'InlineTable') {
    return prepareDelimitedInsertion(
      document,
      table,
      document.entity(tableIndex).span,
      entries,
      { anchorRole: 'TomlEntry', open: 'LeftBrace', close: 'RightBrace' },
      placement,
      fragment,
    );
  }
  return prepareTableLineInsertion(document, table, tableIndex, entries, placement, fragment);
}

function prepareInsertArrayElement(
  document: TomlDocument,
  array: NodeRef,
  value: PortableValue,
  placement: AssociationPlacement,
): PreparedEdit[] {
  const index = resolveTarget(document, array, 'TomlItem');
  const item = document.itemEntity(index);
  if (item.kind !== 'Array') {
    throw new TomlEditFailure('WrongRole');
  }
  return prepareDelimitedInsertion(
    document,
    array,
    document.entity(index).span,
    item.elements,
    { anchorRole: 'TomlArrayElement', open: 'LeftBracket', close: 'RightBracket' },
    placement,
    canonicalFragment(document, value),
  );
}

function prepareDelimitedInsertion(
  document: TomlDocument,
  container: NodeRef,
  containerSpan: Span,
  associations: readonly number[],
  syntax: DelimitedSyntax,
  placement: AssociationPlacement,
  fragment: Uint8Array,
): PreparedEdit[] {
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
        throw new TomlEditFailure('TargetNotFound');
    }
  } else {
    switch (placement.kind) {
      case 'Start': {
        position = document.entity(associations[0]).span.startByte();
        suffixComma = true;
        break;
      }
      case 'End': {
        position = document.entity(associations[associations.length - 1]).span.endByte();
        prefixComma = true;
        break;
      }
      case 'Before': {
        const anchor = resolveAnchor(document, placement.anchor, syntax.anchorRole, associations);
        position = document.entity(anchor).span.startByte();
        suffixComma = true;
        break;
      }
      case 'After': {
        const anchor = resolveAnchor(document, placement.anchor, syntax.anchorRole, associations);
        position = document.entity(anchor).span.endByte();
        prefixComma = true;
        break;
      }
    }
  }
  const parts: number[] = [];
  if (prefixComma) parts.push(0x2c);
  parts.push(...fragment);
  if (suffixComma) parts.push(0x2c);
  return [
    {
      oldSpan: zeroSpan(document, position, position),
      replacement: Uint8Array.from(parts),
      mapping: { old: container, plan: { kind: 'Unmapped', reason: 'container-reparsed-after-structural-insertion' } },
    },
  ];
}

function prepareTableLineInsertion(
  document: TomlDocument,
  table: NodeRef,
  tableIndex: number,
  entries: readonly number[],
  placement: AssociationPlacement,
  fragment: Uint8Array,
): PreparedEdit[] {
  const kind = itemKindOf(document.itemEntity(tableIndex));
  let position: number;
  switch (placement.kind) {
    case 'Start':
      position = kind === 'RootTable' ? 0 : firstLineAfterHeader(document, document.entity(tableIndex).span);
      break;
    case 'End':
      position = tableEndInsertion(document, entries, tableIndex);
      break;
    case 'Before': {
      const anchor = resolveAnchor(document, placement.anchor, 'TomlEntry', entries);
      position = lineStart(document, document.entity(anchor).span.startByte());
      break;
    }
    case 'After': {
      const anchor = resolveAnchor(document, placement.anchor, 'TomlEntry', entries);
      if (isTableKind(itemKindOf(document.itemEntity(entryItemIndexOf(document, anchor))))) {
        throw new TomlEditFailure('UnsupportedOperation');
      }
      position = lineAfter(document, document.entity(anchor).span.endByte());
      break;
    }
  }
  return [
    {
      oldSpan: zeroSpan(document, position, position),
      replacement: lineFragment(document, position, fragment),
      mapping: { old: table, plan: { kind: 'Unmapped', reason: 'table-reparsed-after-entry-insertion' } },
    },
  ];
}

function prepareRemoveEntry(document: TomlDocument, target: NodeRef): PreparedEdit[] {
  const index = resolveTarget(document, target, 'TomlEntry');
  if (isTableKind(itemKindOf(document.itemEntity(entryItemIndexOf(document, index))))) {
    throw new TomlEditFailure('UnsupportedOperation');
  }
  const parent = parentTable(document, index);
  if (parent === null) {
    throw new TomlEditFailure('TargetNotFound');
  }
  const containerKind = itemKindOf(document.itemEntity(parent.container));
  if (containerKind === 'InlineTable') {
    return prepareDelimitedRemoval(
      document,
      target,
      index,
      parent.entries,
      parent.ordinal,
      document.entity(parent.container).span.endByte(),
    );
  }
  if (containerKind === 'RootTable' || containerKind === 'StandardTable') {
    return [
      {
        oldSpan: document.entity(index).span,
        replacement: new Uint8Array(0),
        mapping: { old: target, plan: { kind: 'Deleted' } },
      },
    ];
  }
  throw new TomlEditFailure('UnsupportedOperation');
}

function prepareRemoveArrayElement(document: TomlDocument, target: NodeRef): PreparedEdit[] {
  const index = resolveTarget(document, target, 'TomlArrayElement');
  const parent = parentArray(document, index);
  if (parent === null) {
    throw new TomlEditFailure('TargetNotFound');
  }
  return prepareDelimitedRemoval(
    document,
    target,
    index,
    parent.entries,
    parent.ordinal,
    document.entity(parent.container).span.endByte(),
  );
}

function prepareDelimitedRemoval(
  document: TomlDocument,
  target: NodeRef,
  index: number,
  associations: readonly number[],
  ordinal: number,
  containerEnd: number,
): PreparedEdit[] {
  const targetSpan = document.entity(index).span;
  const comma = removalComma(document, associations, ordinal, containerEnd);
  if (comma !== null) {
    if (comma.endByte() === targetSpan.startByte() || comma.startByte() === targetSpan.endByte()) {
      return [
        {
          oldSpan: unionSpan(document, comma, targetSpan),
          replacement: new Uint8Array(0),
          mapping: { old: target, plan: { kind: 'Deleted' } },
        },
      ];
    }
    return [
      {
        oldSpan: targetSpan,
        replacement: new Uint8Array(0),
        mapping: { old: target, plan: { kind: 'Deleted' } },
      },
      {
        oldSpan: comma,
        replacement: new Uint8Array(0),
        mapping: null,
      },
    ];
  }
  return [
    {
      oldSpan: targetSpan,
      replacement: new Uint8Array(0),
      mapping: { old: target, plan: { kind: 'Deleted' } },
    },
  ];
}

function prepareRenameEntry(document: TomlDocument, target: NodeRef, key: string): PreparedEdit {
  const index = resolveTarget(document, target, 'TomlEntry');
  if (isTableKind(itemKindOf(document.itemEntity(entryItemIndexOf(document, index))))) {
    throw new TomlEditFailure('UnsupportedOperation');
  }
  const parent = parentTable(document, index);
  if (parent === null) {
    throw new TomlEditFailure('TargetNotFound');
  }
  const containerKind = itemKindOf(document.itemEntity(parent.container));
  if (containerKind !== 'RootTable' && containerKind !== 'StandardTable' && containerKind !== 'InlineTable') {
    throw new TomlEditFailure('UnsupportedOperation');
  }
  if (parent.entries.some((candidate) => candidate !== index && entryNameOf(document, candidate) === key)) {
    throw new TomlEditFailure('DuplicateKey');
  }
  return {
    oldSpan: document.entity(entryKeyIndexOf(document, index)).span,
    replacement: new TextEncoder().encode(canonicalString(key)),
    mapping: { old: target, plan: { kind: 'Unmapped', reason: 'entry-reparsed-after-key-rename' } },
  };
}

// -- line and delimiter helpers ---------------------------------------------------------

function firstLineAfterHeader(document: TomlDocument, headerSpan: Span): number {
  return lineAfter(document, headerSpan.startByte());
}

function tableEndInsertion(document: TomlDocument, entries: readonly number[], tableIndex: number): number {
  for (const entry of entries) {
    if (isTableKind(itemKindOf(document.itemEntity(entryItemIndexOf(document, entry))))) {
      return lineStart(document, document.entity(entry).span.startByte());
    }
  }
  if (entries.length > 0) {
    return lineAfter(document, document.entity(entries[entries.length - 1]).span.endByte());
  }
  if (itemKindOf(document.itemEntity(tableIndex)) === 'StandardTable') {
    return firstLineAfterHeader(document, document.entity(tableIndex).span);
  }
  return document.entity(tableIndex).span.endByte();
}

function lineStart(document: TomlDocument, position: number): number {
  const bytes = document.source().bytes();
  for (let i = position - 1; i >= 0; i--) {
    if (bytes[i] === 0x0a) return i + 1;
  }
  return 0;
}

function lineAfter(document: TomlDocument, position: number): number {
  const bytes = document.source().bytes();
  for (let i = position; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) return i + 1;
  }
  return bytes.length;
}

function lineFragment(document: TomlDocument, position: number, fragment: Uint8Array): Uint8Array {
  const newline = newlineBytesOf(document);
  const bytes = document.source().bytes();
  const needsPrefix = position > 0 && bytes[position - 1] !== 0x0a;
  const needsSuffix = position < bytes.length;
  const extra = newline.length * (needsPrefix ? 1 : 0) + newline.length * (needsSuffix ? 1 : 0);
  const out = new Uint8Array(fragment.length + extra);
  let offset = 0;
  if (needsPrefix) {
    out.set(newline, offset);
    offset += newline.length;
  }
  out.set(fragment, offset);
  offset += fragment.length;
  if (needsSuffix) {
    out.set(newline, offset);
  }
  return out;
}

/** The document's newline bytes: the first Newline piece, or LF (edit.rs:985-994). */
function newlineBytesOf(document: TomlDocument): Uint8Array {
  const pieces = document.losslessStructuralIndex().pieces();
  const kinds = document.losslessSyntaxKinds();
  const bytes = document.source().bytes();
  for (let i = 0; i < pieces.length; i++) {
    if (kinds[i] === 'Newline') {
      const span = pieces[i].span();
      return bytes.slice(span.startByte(), span.endByte());
    }
  }
  return Uint8Array.of(0x0a);
}

function removalComma(
  document: TomlDocument,
  associations: readonly number[],
  ordinal: number,
  containerEnd: number,
): Span | null {
  const current = document.entity(associations[ordinal]).span;
  const followingEnd =
    ordinal + 1 < associations.length
      ? document.entity(associations[ordinal + 1]).span.startByte()
      : containerEnd;
  const following = syntaxBetween(document, 'Comma', current.endByte(), followingEnd, false);
  if (following !== null) {
    return following;
  }
  if (ordinal === 0) {
    return null;
  }
  const previous = document.entity(associations[ordinal - 1]).span;
  const preceding = syntaxBetween(document, 'Comma', previous.endByte(), current.startByte(), true);
  if (preceding === null) {
    throw new TomlEditFailure('TargetNotFound');
  }
  return preceding;
}

function delimiter(document: TomlDocument, kind: TomlSyntaxKind, container: Span, last: boolean): Span {
  const found = syntaxBetween(document, kind, container.startByte(), container.endByte(), last);
  if (found === null) {
    throw new TomlEditFailure('TargetNotFound');
  }
  return found;
}

function syntaxBetween(
  document: TomlDocument,
  kind: TomlSyntaxKind,
  start: number,
  end: number,
  last: boolean,
): Span | null {
  const pieces = document.losslessStructuralIndex().pieces();
  const kinds = document.losslessSyntaxKinds();
  const matches: Span[] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (kinds[i] !== kind) continue;
    const span = pieces[i].span();
    if (span.startByte() >= start && span.endByte() <= end) {
      matches.push(span);
    }
  }
  return matches.length === 0 ? null : last ? matches[matches.length - 1] : matches[0];
}

// -- targets and parents ------------------------------------------------------------

function resolveTarget(
  document: TomlDocument,
  target: NodeRef,
  role: 'TomlItem' | 'TomlEntry' | 'TomlArrayElement',
): number {
  try {
    return document.validateRef(target, role);
  } catch (error) {
    const kind = (error as { kind?: string }).kind;
    if (kind === 'WrongSnapshot') throw new TomlEditFailure('WrongSnapshot');
    if (kind === 'WrongRole') throw new TomlEditFailure('WrongRole');
    throw new TomlEditFailure('TargetNotFound');
  }
}

function resolveAnchor(
  document: TomlDocument,
  anchor: NodeRef,
  role: 'TomlEntry' | 'TomlArrayElement',
  associations: readonly number[],
): number {
  const index = resolveTarget(document, anchor, role);
  if (!associations.includes(index)) {
    throw new TomlEditFailure('TargetNotFound');
  }
  return index;
}

function parentTable(
  document: TomlDocument,
  entryIndex: number,
): { container: number; entries: readonly number[]; ordinal: number } | null {
  for (let index = 0; index < entityCount(document); index++) {
    const kind = document.itemEntityOrNull(index);
    if (kind === null) continue;
    if (kind.kind === 'Table' || kind.kind === 'InlineTable') {
      const ordinal = kind.entries.indexOf(entryIndex);
      if (ordinal !== -1) {
        return { container: index, entries: kind.entries, ordinal };
      }
    }
  }
  return null;
}

function parentArray(
  document: TomlDocument,
  elementIndex: number,
): { container: number; entries: readonly number[]; ordinal: number } | null {
  for (let index = 0; index < entityCount(document); index++) {
    const kind = document.itemEntityOrNull(index);
    if (kind === null) continue;
    if (kind.kind === 'Array') {
      const ordinal = kind.elements.indexOf(elementIndex);
      if (ordinal !== -1) {
        return { container: index, entries: kind.elements, ordinal };
      }
    }
  }
  return null;
}

function entityCount(document: TomlDocument): number {
  return document.entityCount();
}

function entryNameOf(document: TomlDocument, entryIndex: number): string {
  const entry = document.entity(entryIndex).kind;
  if (entry.role !== 'Entry') {
    throw new Error('internal: toml entry entity expected');
  }
  const key = document.entity(entry.key).kind;
  if (key.role !== 'Key') {
    throw new Error('internal: toml key entity expected');
  }
  return key.name;
}

function entryItemIndexOf(document: TomlDocument, entryIndex: number): number {
  const entry = document.entity(entryIndex).kind;
  if (entry.role !== 'Entry') {
    throw new Error('internal: toml entry entity expected');
  }
  return entry.item;
}

function entryKeyIndexOf(document: TomlDocument, entryIndex: number): number {
  const entry = document.entity(entryIndex).kind;
  if (entry.role !== 'Entry') {
    throw new Error('internal: toml entry entity expected');
  }
  return entry.key;
}

function findItemBySpan(document: TomlDocument, start: number, end: number): number | null {
  let found: number | null = null;
  for (let index = 0; index < entityCount(document); index++) {
    if (!document.isItemEntity(index)) continue;
    const span = document.entity(index).span;
    if (span.startByte() === start && span.endByte() === end) {
      if (found !== null) return null;
      found = index;
    }
  }
  return found;
}

function zeroSpan(document: TomlDocument, start: number, end: number): Span {
  return document.authority().span(start, end);
}

function unionSpan(document: TomlDocument, left: Span, right: Span): Span {
  return document.authority().span(
    Math.min(left.startByte(), right.startByte()),
    Math.max(left.endByte(), right.endByte()),
  );
}

// -- scalar kind helpers -----------------------------------------------------------

function isScalarKind(kind: string): boolean {
  switch (kind) {
    case 'String':
    case 'Integer':
    case 'Float':
    case 'Boolean':
    case 'OffsetDateTime':
    case 'LocalDateTime':
    case 'LocalDate':
    case 'LocalTime':
      return true;
    default:
      return false;
  }
}

function isTableKind(kind: string): boolean {
  switch (kind) {
    case 'RootTable':
    case 'StandardTable':
    case 'ImplicitTable':
    case 'DottedTable':
    case 'ArrayOfTables':
      return true;
    default:
      return false;
  }
}

function portableTomlKind(value: PortableValue): string | null {
  switch (value.kind) {
    case 'String':
      return 'String';
    case 'Integer':
      return 'Integer';
    case 'BinaryFloat64':
      return 'Float';
    case 'Boolean':
      return 'Boolean';
    case 'Date':
      return 'LocalDate';
    case 'Time':
      return 'LocalTime';
    case 'LocalDateTime':
      return 'LocalDateTime';
    case 'OffsetDateTime':
      return 'OffsetDateTime';
    default:
      return null;
  }
}

/** Exact-literal validation: `_ = {literal}` must parse to exactly one scalar spanning the literal bytes (edit.rs:1379-1413). */
function validateExactScalar(document: TomlDocument, literal: Uint8Array): Uint8Array {
  validateExactScalarKind(document, literal);
  return literal;
}

function validateExactScalarKind(document: TomlDocument, literal: Uint8Array): string {
  const prefix = new TextEncoder().encode('_ = ');
  const source = new Uint8Array(prefix.length + literal.length);
  source.set(prefix, 0);
  source.set(literal, prefix.length);
  let parsed: TomlDocument;
  try {
    parsed = parseToml(source, TomlProfile.TOML_10_V1, document.parseLimits());
  } catch (error) {
    if (error instanceof TomlFormationFailure) {
      throw new TomlEditFailure('InvalidLiteral');
    }
    throw error;
  }
  const entries = parsed.root().tableEntries();
  if (entries === null || entries.length !== 1) {
    throw new TomlEditFailure('InvalidLiteral');
  }
  const item = entries[0].item();
  const span = item.span();
  const prefixLen = prefix.length;
  if (span.startByte() !== prefixLen || span.endByte() !== prefixLen + literal.length) {
    throw new TomlEditFailure('InvalidLiteral');
  }
  const kind = item.kind();
  if (!isScalarKind(kind)) {
    throw new TomlEditFailure('InvalidLiteral');
  }
  return kind;
}

// -- canonical literals (edit.rs:1472-1616) ---------------------------------------------

function canonicalLiteral(value: PortableValue): string {
  switch (value.kind) {
    case 'String':
      return canonicalString(value.value);
    case 'Integer':
      if (value.value < -9223372036854775808n || value.value > 9223372036854775807n) {
        throw new TomlEditFailure('UnsupportedSemanticValue', { valueKind: 'Integer' });
      }
      return value.value.toString();
    case 'BinaryFloat64': {
      const canonical = canonicalFloat(value.bits);
      if (canonical === null) {
        throw new TomlEditFailure('UnsupportedSemanticValue', { valueKind: 'BinaryFloat64' });
      }
      return canonical;
    }
    case 'Boolean':
      return value.value ? 'true' : 'false';
    case 'Date': {
      const canonical = canonicalDate(value.year, value.month, value.day);
      if (canonical === null) {
        throw new TomlEditFailure('UnsupportedSemanticValue', { valueKind: 'Date' });
      }
      return canonical;
    }
    case 'Time': {
      const canonical = canonicalTime(value.hour, value.minute, value.second, value.fraction);
      if (canonical === null) {
        throw new TomlEditFailure('UnsupportedSemanticValue', { valueKind: 'Time' });
      }
      return canonical;
    }
    case 'LocalDateTime': {
      const date = canonicalDate(value.date.year, value.date.month, value.date.day);
      const time = canonicalTime(value.time.hour, value.time.minute, value.time.second, value.time.fraction);
      if (date === null || time === null) {
        throw new TomlEditFailure('UnsupportedSemanticValue', { valueKind: 'LocalDateTime' });
      }
      return `${date}T${time}`;
    }
    case 'OffsetDateTime': {
      const date = canonicalDate(value.local.date.year, value.local.date.month, value.local.date.day);
      const time = canonicalTime(
        value.local.time.hour,
        value.local.time.minute,
        value.local.time.second,
        value.local.time.fraction,
      );
      if (date === null || time === null) {
        throw new TomlEditFailure('UnsupportedSemanticValue', { valueKind: 'OffsetDateTime' });
      }
      const offset = canonicalOffset(value.offsetSeconds);
      if (offset === null) {
        throw new TomlEditFailure('UnsupportedSemanticValue', { valueKind: 'OffsetDateTime' });
      }
      return `${date}T${time}${offset}`;
    }
    default:
      throw new TomlEditFailure('UnsupportedSemanticValue', { valueKind: value.kind });
  }
}

/** Deterministic string escaping (edit.rs:1516-1537). */
export function canonicalString(value: string): string {
  let out = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    switch (codePoint) {
      case 0x08:
        out += '\\b';
        break;
      case 0x09:
        out += '\\t';
        break;
      case 0x0a:
        out += '\\n';
        break;
      case 0x0c:
        out += '\\f';
        break;
      case 0x0d:
        out += '\\r';
        break;
      case 0x22:
        out += '\\"';
        break;
      case 0x5c:
        out += '\\\\';
        break;
      default:
        if (codePoint <= 0x1f || codePoint === 0x7f) {
          out += `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
        } else {
          out += character;
        }
    }
  }
  out += '"';
  return out;
}

/** Canonical float spelling; only canonical NaN payloads are representable (edit.rs:1539-1560). */
export function canonicalFloat(bits: bigint): string | null {
  const float = floatFromBits(bits);
  if (Number.isNaN(float)) {
    if (bits === 0x7ff8000000000000n) return 'nan';
    if (bits === 0xfff8000000000000n) return '-nan';
    return null;
  }
  if (float === Infinity) return 'inf';
  if (float === -Infinity) return '-inf';
  if (Object.is(float, -0)) return '-0.0';
  let text = float.toString();
  if (!text.includes('.') && !text.includes('e') && !text.includes('E')) {
    text += '.0';
  }
  return text;
}

function canonicalDate(year: bigint, month: number, day: number): string | null {
  if (year < 0n || year > 9999n) return null;
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function canonicalTime(hour: number, minute: number, second: number, fraction: { coefficient: bigint; exponent: bigint }): string | null {
  const nanoseconds = exactNanosecondsOf(fraction);
  if (nanoseconds === null) return null;
  let out = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:${second.toString().padStart(2, '0')}`;
  if (nanoseconds !== 0) {
    let fractionText = nanoseconds.toString().padStart(9, '0');
    while (fractionText.endsWith('0')) {
      fractionText = fractionText.slice(0, -1);
    }
    out += `.${fractionText}`;
  }
  return out;
}

function canonicalOffset(offsetSeconds: number): string | null {
  if (offsetSeconds === 0) return 'Z';
  if (offsetSeconds % 60 !== 0) return null;
  const minutes = offsetSeconds / 60;
  if (Math.abs(minutes) >= 24 * 60) return null;
  const sign = minutes < 0 ? '-' : '+';
  const magnitude = Math.abs(minutes);
  return `${sign}${Math.floor(magnitude / 60).toString().padStart(2, '0')}:${(magnitude % 60).toString().padStart(2, '0')}`;
}

function exactNanosecondsOf(fraction: { coefficient: bigint; exponent: bigint }): number | null {
  const coefficient = fraction.coefficient;
  if (coefficient === 0n) return 0;
  const exponent = Number(fraction.exponent);
  if (exponent < -9 || exponent >= 0) return null;
  const value = Number(coefficient);
  if (value < 0) return null;
  const nanoseconds = value * 10 ** (exponent + 9);
  if (!Number.isSafeInteger(nanoseconds) || nanoseconds >= 1_000_000_000) return null;
  return nanoseconds;
}

// -- dependencies (edit.rs:1064-1100) -----------------------------------------------------

function validateDependencies(transaction: TomlEditTransaction): void {
  const destructive = new Set<string>();
  const removed = new Set<string>();
  const anchors: string[] = [];
  for (const operation of transaction.operations()) {
    let target: NodeRef | null = null;
    switch (operation.kind) {
      case 'ReplaceScalar':
        target = operation.replacement.target;
        break;
      case 'RemoveEntry':
      case 'RenameEntry':
      case 'RemoveArrayElement':
        target = operation.target;
        break;
      case 'InsertEntry':
      case 'InsertArrayElement':
        break;
    }
    if (target !== null) {
      const key = nodeKey(target);
      if (destructive.has(key)) {
        throw new TomlEditFailure('DuplicateTarget');
      }
      destructive.add(key);
    }
    switch (operation.kind) {
      case 'RemoveEntry':
      case 'RemoveArrayElement':
        removed.add(nodeKey(operation.target));
        break;
      case 'InsertEntry':
        if (operation.placement.kind === 'Before' || operation.placement.kind === 'After') {
          anchors.push(nodeKey(operation.placement.anchor));
        }
        break;
      case 'InsertArrayElement':
        if (operation.placement.kind === 'Before' || operation.placement.kind === 'After') {
          anchors.push(nodeKey(operation.placement.anchor));
        }
        break;
      case 'ReplaceScalar':
      case 'RenameEntry':
        break;
    }
  }
  if (anchors.some((anchor) => removed.has(anchor))) {
    throw new TomlEditFailure('PlacementAnchorRemoved');
  }
}

/** Value-identity key of one NodeRef (snapshot:index:role). */
function nodeKey(node: NodeRef): string {
  return `${node.snapshot().asBigInt().toString()}:${node.index().toString()}:${node.role()}`;
}

// -- metadata and summaries (edit.rs:1132-1278) ---------------------------------------------

function operationMetadata(transaction: TomlEditTransaction): Map<string, string> {
  const metadata = new Map<string, string>();
  transaction.operations().forEach((operation, index) => {
    metadata.set(`operation.${index}`, `${operationId(operation)}@1`);
  });
  return metadata;
}

function operationId(operation: TomlEditOperation): string {
  switch (operation.kind) {
    case 'ReplaceScalar':
      return operation.replacement.kind === 'Semantic'
        ? 'toml.edit.replace-scalar-semantic'
        : 'toml.edit.replace-scalar-literal';
    case 'InsertEntry':
      return 'toml.edit.insert-entry';
    case 'RemoveEntry':
      return 'toml.edit.remove-entry';
    case 'RenameEntry':
      return 'toml.edit.rename-entry';
    case 'InsertArrayElement':
      return 'toml.edit.insert-array-element';
    case 'RemoveArrayElement':
      return 'toml.edit.remove-array-element';
  }
}

function operationSummaries(transaction: TomlEditTransaction): EditOperationSummary[] {
  return transaction.operations().map((operation) => {
    const id = operationId(operation);
    const targetRole = operationTargetRole(operation);
    const arguments_ = new Map<string, string>();
    switch (operation.kind) {
      case 'ReplaceScalar': {
        const replacement = operation.replacement;
        if (replacement.kind === 'Semantic') {
          arguments_.set('representation_policy', policyName(replacement.policy));
          arguments_.set('value_kind', valueKindName(replacement.value.kind));
        } else {
          arguments_.set('literal_bytes', String(replacement.literal.length));
        }
        break;
      }
      case 'InsertEntry':
        arguments_.set('key_bytes', String(operation.key.length));
        arguments_.set('placement', placementName(operation.placement));
        arguments_.set('value_kind', valueKindName(operation.value.kind));
        break;
      case 'RenameEntry':
        arguments_.set('key_bytes', String(operation.key.length));
        break;
      case 'InsertArrayElement':
        arguments_.set('placement', placementName(operation.placement));
        arguments_.set('value_kind', valueKindName(operation.value.kind));
        break;
      case 'RemoveEntry':
      case 'RemoveArrayElement':
        break;
    }
    arguments_.set('target_role', targetRole);
    return new EditOperationSummary(new FormatOperationId(id, 1), arguments_);
  });
}

function operationTargetRole(operation: TomlEditOperation): string {
  switch (operation.kind) {
    case 'ReplaceScalar':
      return 'toml.scalar-item@1';
    case 'InsertEntry':
      return 'toml.table-item@1';
    case 'RemoveEntry':
    case 'RenameEntry':
      return 'toml.entry@1';
    case 'InsertArrayElement':
      return 'toml.array-item@1';
    case 'RemoveArrayElement':
      return 'toml.array-element@1';
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

function policyName(policy: TomlRepresentationPolicy): string {
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

/** Renders one canonical value fragment, mapping materialization failures to edit failures (edit.rs:1734-1749). */
function canonicalFragment(document: TomlDocument, value: PortableValue): Uint8Array {
  try {
    return canonicalTomlFragment(value, fragmentLimits(document));
  } catch (error) {
    if (error instanceof MaterializationFailure) {
      if (error.kind === 'Unrepresentable') {
        throw new TomlEditFailure('UnrepresentableValue', { valueKind: error.valueKind ?? value.kind });
      }
      if (error.kind === 'ResourceLimit') {
        throw new TomlEditFailure('ResourceLimit', { limitName: error.reason });
      }
    }
    throw new TomlEditFailure('NewDocumentFormationFailed');
  }
}

function fragmentLimits(document: TomlDocument): MaterializationLimits {
  const limits = document.parseLimits();
  return {
    maxInputNodes: limits.maxNodeCount,
    maxOutputBytes: limits.maxSourceBytes,
    maxDepth: limits.maxNestingDepth,
    maxReportEntries: limits.maxDiagnostics,
    maxProvenanceEntries: limits.maxNodeCount * 4,
  };
}

function sourcePatchLimitsFor(parseLimits: { maxSourceBytes: number }, operationCount: number): SourcePatchLimits {
  return {
    source: {
      maxRawBytes: parseLimits.maxSourceBytes,
      maxDecodedUtf8Bytes: parseLimits.maxSourceBytes,
      maxDecodedScalars: parseLimits.maxSourceBytes,
    },
    maxReplacements: operationCount,
    maxPatchBytes: parseLimits.maxSourceBytes * 2,
  };
}

