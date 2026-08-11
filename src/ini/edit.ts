/**
 * INI value replacement and structural edit transactions with atomic
 * commit.
 *
 * authority:
 *  - representation policies: crates/consema-ini/src/edit.rs:15-26
 *  - operation vocabulary: edit.rs:28-106 (ValueReplacement/EditOperation),
 *    the registry ids (operation_registry.rs:16-80; RFC 0009 §12
 *    :437-472), and the target roles ini.document@1 / ini.section@1 /
 *    ini.entry@1
 *  - commit algebra: edit.rs:305-553 (atomicity, conflict checks,
 *    source-edit preparation, reparse, mapping, ChangeSet)
 *  - preparation rules: edit.rs:572-1516 (value ownership, insertion
 *    placement and newline conventions, removal ownership, rename
 *    validation, Python multiline preservation and canonical forms)
 *  - dependency validation: edit.rs:863-920 (PlacementAnchorRemoved,
 *    AncestorDescendantConflict, DuplicateTarget)
 *  - canonical entry/value spellings: edit.rs:1101-1167, 1261-1430
 *    (windows_value_needs_quotes at materialization.rs:874-888)
 *  - exact literal validation: edit.rs:384-403 (reparse must form one
 *    complete document; literal-only failures map to InvalidLiteral)
 *  - summaries and metadata: edit.rs:1604-1702 (operation.{index}
 *    metadata keys must match the SourcePatch metadata exactly; the
 *    EditPlan constructor enforces it, document/edit_plan.ts:101-110)
 *  - failure mapping: edit.rs:1754-1779 (core.edit.* and ini.edit.* codes,
 *    RFC 0004 §17; RFC 0009 §14)
 *
 * Design (TypeScript-idiomatic): an immutable transaction built through a
 * builder; `commitIniEdits` validates and plans every operation before
 * publishing anything — a failure never changes the base snapshot. The
 * prepared source edits are byte-exact replacements; the commit returns
 * the new Document, ChangeSet, derived SourcePatch, and untouched-byte
 * proof.
 */

import type { AssociationPlacement, NodeRef, SnapshotIdentity, Span } from '../document/identity.ts';
import { ChangeSet, NodeMapping, SourceEdit } from '../document/change_set.ts';
import { SourcePatch, type SourcePatchLimits } from '../document/source_patch.ts';
import { UntouchedByteProof } from '../document/untouched_proof.ts';
import { EditPlan, EditOperationSummary, EditPlanSourceId } from '../document/edit_plan.ts';
import { FormatOperationId } from '../document/operation.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { diagnostic as makeDiagnostic } from '../document/diagnostic.ts';
import { parseIniDocument } from './document.ts';
import type { IniDocument, IniEntry } from './document.ts';
import type { IniEntity, IniEntityKind } from './parser.ts';
import { IniAccessError, IniEditFailure, IniFormationFailure } from './errors.ts';
import { LocationError } from '../document/errors.ts';
import { iniEncodeFragment, iniWindowsValueNeedsQuotes } from './materialization.ts';
import type { IniEncodingSelection, IniParseLimits, IniSyntaxKind } from './profile.ts';
import { optionxform } from './python_case.ts';

// ---------------------------------------------------------------------------
// Representation policy and operations (edit.rs:15-106)
// ---------------------------------------------------------------------------

/** Explicit semantic value representation policy (edit.rs:16-26). */
export type IniRepresentationPolicy =
  | 'ExactLiteral'
  | 'PreserveCompatible'
  | 'CanonicalForProfile'
  | 'PreserveElseCanonical';

/** One INI value replacement bound to a transaction base snapshot (edit.rs:29-55). */
export type IniValueReplacement =
  | {
      readonly kind: 'Semantic';
      readonly target: NodeRef;
      readonly value: string;
      readonly policy: IniRepresentationPolicy;
    }
  | {
      readonly kind: 'Literal';
      readonly target: NodeRef;
      readonly literal: Uint8Array;
    };

/** One typed INI edit operation bound to an immutable base snapshot (edit.rs:57-106). */
export type IniEditOperation =
  | { readonly kind: 'ReplaceValue'; readonly replacement: IniValueReplacement }
  | {
      readonly kind: 'InsertSection';
      readonly document: NodeRef;
      readonly name: string;
      readonly placement: AssociationPlacement;
    }
  | { readonly kind: 'RemoveSection'; readonly target: NodeRef }
  | { readonly kind: 'RenameSection'; readonly target: NodeRef; readonly name: string }
  | {
      readonly kind: 'InsertEntry';
      readonly section: NodeRef;
      readonly key: string;
      readonly value: string;
      readonly placement: AssociationPlacement;
    }
  | { readonly kind: 'RemoveEntry'; readonly target: NodeRef }
  | { readonly kind: 'RenameEntry'; readonly target: NodeRef; readonly key: string };

/** Immutable transaction; every operation resolves against one base snapshot (edit.rs:108-127). */
export class IniEditTransaction {
  readonly #base: SnapshotIdentity;
  readonly #operations: readonly IniEditOperation[];

  /** @internal — built via IniEditTransactionBuilder. */
  constructor(base: SnapshotIdentity, operations: readonly IniEditOperation[]) {
    this.#base = base;
    this.#operations = Object.freeze([...operations]);
  }

  /** Base snapshot identity (edit.rs:116-119). */
  baseSnapshot(): SnapshotIdentity {
    return this.#base;
  }

  /** Ordered declared operations (edit.rs:120-125). */
  operations(): readonly IniEditOperation[] {
    return this.#operations;
  }
}

/** Builder for one immutable edit transaction (edit.rs:129-243). */
export class IniEditTransactionBuilder {
  readonly #base: SnapshotIdentity;
  readonly #operations: IniEditOperation[] = [];

  /** Binds a new transaction to one immutable INI document (edit.rs:137-144). */
  constructor(document: IniDocument) {
    this.#base = document.snapshotIdentity();
  }

  /** Adds one semantic stored-value replacement (edit.rs:146-158). */
  semanticValue(
    target: NodeRef,
    value: string,
    policy: IniRepresentationPolicy,
  ): IniEditTransactionBuilder {
    this.#operations.push({
      kind: 'ReplaceValue',
      replacement: { kind: 'Semantic', target, value, policy },
    });
    return this;
  }

  /** Adds one exact raw value-representation replacement (edit.rs:159-170). */
  literalValue(target: NodeRef, literal: Uint8Array): IniEditTransactionBuilder {
    this.#operations.push({
      kind: 'ReplaceValue',
      replacement: { kind: 'Literal', target, literal },
    });
    return this;
  }

  /** Adds one canonical section insertion (edit.rs:171-181). */
  insertSection(
    document: NodeRef,
    name: string,
    placement: AssociationPlacement,
  ): IniEditTransactionBuilder {
    this.#operations.push({ kind: 'InsertSection', document, name, placement });
    return this;
  }

  /** Adds one exact section removal, including that occurrence's owned entries (edit.rs:183-192). */
  removeSection(target: NodeRef): IniEditTransactionBuilder {
    this.#operations.push({ kind: 'RemoveSection', target });
    return this;
  }

  /** Adds one exact section-name replacement (edit.rs:194-202). */
  renameSection(target: NodeRef, name: string): IniEditTransactionBuilder {
    this.#operations.push({ kind: 'RenameSection', target, name });
    return this;
  }

  /** Adds one canonical entry insertion (edit.rs:204-218). */
  insertEntry(
    section: NodeRef,
    key: string,
    value: string,
    placement: AssociationPlacement,
  ): IniEditTransactionBuilder {
    this.#operations.push({ kind: 'InsertEntry', section, key, value, placement });
    return this;
  }

  /** Adds one exact entry removal (edit.rs:220-224). */
  removeEntry(target: NodeRef): IniEditTransactionBuilder {
    this.#operations.push({ kind: 'RemoveEntry', target });
    return this;
  }

  /** Adds one exact entry-key replacement (edit.rs:226-232). */
  renameEntry(target: NodeRef, key: string): IniEditTransactionBuilder {
    this.#operations.push({ kind: 'RenameEntry', target, key });
    return this;
  }

  /** Completes the immutable request; target validation occurs atomically at commit (edit.rs:234-242). */
  build(): IniEditTransaction {
    return new IniEditTransaction(this.#base, this.#operations);
  }
}

/** Atomic edit success (edit.rs:245-256). */
export class IniEditCommit {
  readonly #document: IniDocument;
  readonly #changeSet: ChangeSet;
  readonly #sourcePatch: SourcePatch;
  readonly #untouchedProof: UntouchedByteProof;

  constructor(
    document: IniDocument,
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
  document(): IniDocument {
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
// Preparation
// ---------------------------------------------------------------------------

type MappingPlan =
  | { readonly kind: 'ReplacedValue'; readonly expectedKey: string; readonly literal: boolean }
  | { readonly kind: 'ReplacedSection'; readonly expectedName: string }
  | { readonly kind: 'ReplacedEntry'; readonly expectedKey: string }
  | { readonly kind: 'SectionAfterEntryInsertion'; readonly expectedKey: string; readonly expectedValue: string }
  | { readonly kind: 'Deleted' }
  | { readonly kind: 'Unmapped'; readonly reason: string };

interface PlannedMapping {
  readonly old: NodeRef;
  readonly plan: MappingPlan;
}

interface PreparedEdit {
  readonly oldSpan: Span;
  readonly replacement: Uint8Array;
  readonly mappings: readonly PlannedMapping[];
  readonly mergeableDeletion: boolean;
}

/** Prepares and validates every operation against one snapshot (edit.rs:305-553). */
export function commitIniEdits(
  document: IniDocument,
  transaction: IniEditTransaction,
): IniEditCommit {
  if (document.formationStatus() !== 'Complete') {
    throw new IniEditFailure('RecoveredDocument');
  }
  if (!transaction.baseSnapshot().equals(document.snapshotIdentity())) {
    throw new IniEditFailure('WrongSnapshot');
  }
  if (transaction.operations().length > document.parseLimits().common.maxNodeCount) {
    throw new IniEditFailure('ResourceLimit', { limitName: 'edit-operations' });
  }
  validateDependencies(document, transaction);

  const diagnostics: Diagnostic[] = [];
  const prepared: PreparedEdit[] = [];
  const targets = new Set<string>();
  for (const operation of transaction.operations()) {
    const destructive = destructiveTarget(operation);
    if (destructive !== null) {
      const key = nodeKey(destructive);
      if (targets.has(key)) {
        throw new IniEditFailure('DuplicateTarget');
      }
      targets.add(key);
    }
    prepared.push(...prepareOperation(document, operation, diagnostics));
  }

  prepared.sort((left, right) => {
    const leftStart = left.oldSpan.startByte();
    const rightStart = right.oldSpan.startByte();
    if (leftStart !== rightStart) return leftStart - rightStart;
    return left.oldSpan.endByte() - right.oldSpan.endByte();
  });
  const coalesced = coalesceAdjacentDeletions(document, prepared);
  for (let i = 1; i < coalesced.length; i++) {
    const previous = coalesced[i - 1].oldSpan;
    const current = coalesced[i].oldSpan;
    if (previous.equals(current)) {
      throw new IniEditFailure('OverlappingOwnership');
    }
    if (previous.endByte() > current.startByte()) {
      throw new IniEditFailure('AncestorDescendantConflict');
    }
  }

  const literalOnly =
    transaction.operations().length > 0 &&
    transaction.operations().every(
      (operation) =>
        operation.kind === 'ReplaceValue' && operation.replacement.kind === 'Literal',
    );

  const source = document.source().bytes();
  let targetLen = source.length;
  for (const edit of coalesced) {
    targetLen = targetLen - edit.oldSpan.len() + edit.replacement.length;
    if (targetLen > document.parseLimits().common.maxSourceBytes) {
      throw new IniEditFailure('ResourceLimit', { limitName: 'target-bytes' });
    }
  }

  const rendered: number[] = [];
  let cursor = 0;
  for (const edit of coalesced) {
    rendered.push(...source.subarray(cursor, edit.oldSpan.startByte()));
    rendered.push(...edit.replacement);
    cursor = edit.oldSpan.endByte();
  }
  rendered.push(...source.subarray(cursor));

  let newDocument: IniDocument;
  try {
    newDocument = parseIniDocument(
      Uint8Array.from(rendered),
      document.iniProfile(),
      originalEncodingSelection(document),
      document.parseLimits(),
    );
  } catch (error) {
    if (error instanceof IniFormationFailure) {
      throw new IniEditFailure(literalOnly ? 'InvalidLiteral' : 'NewDocumentFormationFailed');
    }
    throw error;
  }
  if (newDocument.formationStatus() !== 'Complete') {
    throw new IniEditFailure(literalOnly ? 'InvalidLiteral' : 'NewDocumentFormationFailed');
  }

  const sourceEdits: SourceEdit[] = [];
  const mappings: NodeMapping[] = [];
  const mappedOld = new Set<string>();
  let delta = 0;
  for (const edit of coalesced) {
    const newStart = edit.oldSpan.startByte() + delta;
    const newEnd = newStart + edit.replacement.length;
    const newSpan = newDocument.authority().span(newStart, newEnd);
    sourceEdits.push(new SourceEdit(edit.oldSpan, newSpan, edit.replacement));
    for (const mapping of edit.mappings) {
      const key = nodeKey(mapping.old);
      if (mappedOld.has(key)) {
        continue;
      }
      mappedOld.add(key);
      switch (mapping.plan.kind) {
        case 'ReplacedValue': {
          const found = findEntryByOwnership(newDocument, mapping.plan.expectedKey, newSpan);
          if (found === null) {
            throw new IniEditFailure(mapping.plan.literal ? 'InvalidLiteral' : 'NewDocumentFormationFailed');
          }
          mappings.push(new NodeMapping(mapping.old, 'Replaced', found, null));
          break;
        }
        case 'ReplacedSection': {
          const found = findSectionByNameSpan(newDocument, mapping.plan.expectedName, newSpan);
          if (found === null) {
            throw new IniEditFailure('NewDocumentFormationFailed');
          }
          mappings.push(new NodeMapping(mapping.old, 'Replaced', found, null));
          break;
        }
        case 'ReplacedEntry': {
          const found = findEntryByKeySpan(newDocument, mapping.plan.expectedKey, newSpan);
          if (found === null) {
            throw new IniEditFailure('NewDocumentFormationFailed');
          }
          mappings.push(new NodeMapping(mapping.old, 'Replaced', found, null));
          break;
        }
        case 'SectionAfterEntryInsertion': {
          const inserted = hasInsertedEntry(
            newDocument,
            mapping.plan.expectedKey,
            mapping.plan.expectedValue,
            newSpan,
          );
          if (!inserted) {
            throw new IniEditFailure('NewDocumentFormationFailed');
          }
          mappings.push(
            new NodeMapping(mapping.old, 'Unmapped', null, 'section-reparsed-after-entry-insertion'),
          );
          break;
        }
        case 'Deleted':
          mappings.push(new NodeMapping(mapping.old, 'Deleted', null, null));
          break;
        case 'Unmapped':
          mappings.push(new NodeMapping(mapping.old, 'Unmapped', null, mapping.plan.reason));
          break;
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
  } catch {
    throw new IniEditFailure('NewDocumentFormationFailed');
  }
  let untouchedProof: UntouchedByteProof;
  try {
    untouchedProof = UntouchedByteProof.create(
      document.source(),
      newDocument.source(),
      sourcePatch.replacements(),
    );
  } catch {
    throw new IniEditFailure('NewDocumentFormationFailed');
  }
  return new IniEditCommit(newDocument, changeSet, sourcePatch, untouchedProof);
}

/** Fully validates and plans an edit without returning a new Document (edit.rs:555-570). */
export function dryRunIniEdits(
  document: IniDocument,
  transaction: IniEditTransaction,
  sourceId: EditPlanSourceId,
): EditPlan {
  const commit = commitIniEdits(document, transaction);
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
    throw new IniEditFailure('NewDocumentFormationFailed');
  }
  return plan;
}

function prepareOperation(
  document: IniDocument,
  operation: IniEditOperation,
  diagnostics: Diagnostic[],
): PreparedEdit[] {
  switch (operation.kind) {
    case 'ReplaceValue':
      return [prepareValue(document, operation.replacement, diagnostics)];
    case 'InsertSection':
      return [prepareInsertSection(document, operation.document, operation.name, operation.placement)];
    case 'RemoveSection':
      return prepareRemoveSection(document, operation.target);
    case 'RenameSection':
      return [prepareRenameSection(document, operation.target, operation.name)];
    case 'InsertEntry':
      return [prepareInsertEntry(document, operation.section, operation.key, operation.value, operation.placement)];
    case 'RemoveEntry':
      return prepareRemoveEntry(document, operation.target);
    case 'RenameEntry':
      return [prepareRenameEntry(document, operation.target, operation.key)];
  }
}

// -- value replacement (edit.rs:572-615) -------------------------------------

function prepareValue(
  document: IniDocument,
  operation: IniValueReplacement,
  diagnostics: Diagnostic[],
): PreparedEdit {
  const target = operation.target;
  const entryIndex = resolveEntryOf(document, target);
  const entry = document.entries()[entryOrdinalOf(document, entryIndex)];
  const oldSpan = valueOwnership(document, entry);
  let replacement: Uint8Array;
  let literal = false;
  if (operation.kind === 'Literal') {
    if (operation.literal.length > document.parseLimits().common.maxSourceBytes) {
      throw new IniEditFailure('ResourceLimit', { limitName: 'replacement-bytes' });
    }
    replacement = operation.literal;
    literal = true;
  } else {
    replacement = semanticValue(document, entry, operation.value, operation.policy, diagnostics);
  }
  return {
    oldSpan,
    replacement,
    mappings: [
      {
        old: target,
        plan: { kind: 'ReplacedValue', expectedKey: entry.key(), literal },
      },
    ],
    mergeableDeletion: false,
  };
}

/** The value ownership span of one entry (edit.rs:1445-1475). */
function valueOwnership(document: IniDocument, entry: IniEntry): Span {
  const profileTag = document.profileTag();
  if (profileTag === 'PortableV1') {
    return entry.valueSpan();
  }
  if (profileTag === 'WindowsV1') {
    const delimiter = syntaxSpan(document, 'Delimiter', entry.span());
    if (delimiter === null) {
      throw new IniEditFailure('NewDocumentFormationFailed');
    }
    return document.authority().span(delimiter.endByte(), entry.span().endByte());
  }
  const logical = logicalEntityOf(document, entry.index());
  const last = logical.kind.physicalLines[logical.kind.physicalLines.length - 1];
  const physical = document.entity(last);
  if (physical.kind.role !== 'PhysicalLine') {
    throw new Error('internal: ini physical-line entity expected');
  }
  return document.authority().span(entry.valueSpan().startByte(), physical.kind.contentSpan.endByte());
}

function semanticValue(
  document: IniDocument,
  entry: IniEntry,
  value: string,
  policy: IniRepresentationPolicy,
  diagnostics: Diagnostic[],
): Uint8Array {
  if (policy === 'ExactLiteral') {
    throw new IniEditFailure('ExactLiteralRequiresLiteralOperation');
  }
  validateSemanticValue(document.profileTag(), value);
  const preserve = () => preservedValue(document, entry, value);
  switch (policy) {
    case 'PreserveCompatible':
      return preserve();
    case 'PreserveElseCanonical': {
      try {
        return preserve();
      } catch (failure) {
        if (!(failure instanceof IniEditFailure) || failure.kind !== 'RepresentationIncompatible') {
          throw failure;
        }
        diagnostics.push(
          makeDiagnostic(
            'ini.edit.canonical-fallback@1',
            'Edit',
            'Warning',
            entry.valueSpan().diagnosticLocation(),
            BigInt(diagnostics.length),
          ),
        );
        return canonicalValue(document, entry, value);
      }
    }
    case 'CanonicalForProfile':
      return canonicalValue(document, entry, value);
  }
}

function preservedValue(document: IniDocument, entry: IniEntry, value: string): Uint8Array {
  switch (document.profileTag()) {
    case 'PortableV1':
      return encodeValue(document, value);
    case 'WindowsV1': {
      const quoteStyle = entry.quoteStyle();
      if (quoteStyle === 'Single' || quoteStyle === 'Double') {
        const quote = quoteStyle === 'Single' ? '\'' : '"';
        return encodeValue(document, `${quote}${value}${quote}`);
      }
      if (!iniWindowsValueNeedsQuotes(value)) {
        return encodeValue(document, value);
      }
      throw new IniEditFailure('RepresentationIncompatible');
    }
    case 'PythonConfigParserV1':
      return preservedPythonValue(document, entry, value);
  }
}

function canonicalValue(document: IniDocument, entry: IniEntry, value: string): Uint8Array {
  switch (document.profileTag()) {
    case 'PortableV1':
      return encodeValue(document, value);
    case 'WindowsV1':
      if (iniWindowsValueNeedsQuotes(value)) {
        const quote = value.startsWith('"') && value.endsWith('"') ? '\'' : '"';
        return encodeValue(document, `${quote}${value}${quote}`);
      }
      return encodeValue(document, value);
    case 'PythonConfigParserV1':
      return canonicalPythonValue(document, entry, value);
  }
}

/** Per-line Python value preservation (edit.rs:1305-1385). */
function preservedPythonValue(document: IniDocument, entry: IniEntry, value: string): Uint8Array {
  const logical = logicalEntityOf(document, entry.index());
  const physicalLines = logical.kind.physicalLines;
  const newLines = value.split('\n');
  const oldLines = entry.value().split('\n');
  if (physicalLines.length !== newLines.length || oldLines.length !== newLines.length) {
    throw new IniEditFailure('RepresentationIncompatible');
  }
  const output: number[] = [];
  appendBytes(output, encodeValue(document, newLines[0]), document);
  const first = document.entity(physicalLines[0]);
  if (first.kind.role !== 'PhysicalLine') {
    throw new Error('internal: ini physical-line entity expected');
  }
  appendBytes(output, rawBytes(document, entry.valueSpan().endByte(), first.kind.contentSpan.endByte()), document);
  for (let index = 1; index < physicalLines.length; index++) {
    const previous = document.entity(physicalLines[index - 1]);
    if (previous.kind.role !== 'PhysicalLine') {
      throw new Error('internal: ini physical-line entity expected');
    }
    const lineBreak = previous.kind.lineBreakSpan;
    if (lineBreak === null) {
      throw new IniEditFailure('RepresentationIncompatible');
    }
    appendBytes(output, rawBytes(document, lineBreak.startByte(), lineBreak.endByte()), document);
    const line = document.entity(physicalLines[index]);
    if (line.kind.role !== 'PhysicalLine') {
      throw new Error('internal: ini physical-line entity expected');
    }
    if (oldLines[index].length === 0 !== (newLines[index].length === 0)) {
      throw new IniEditFailure('RepresentationIncompatible');
    }
    if (newLines[index].length === 0) {
      appendBytes(
        output,
        rawBytes(document, line.kind.contentSpan.startByte(), line.kind.contentSpan.endByte()),
        document,
      );
      continue;
    }
    const valuePiece = syntaxSpan(document, 'EntryValue', line.kind.contentSpan);
    if (valuePiece === null) {
      throw new IniEditFailure('RepresentationIncompatible');
    }
    appendBytes(
      output,
      rawBytes(document, line.kind.contentSpan.startByte(), valuePiece.startByte()),
      document,
    );
    appendBytes(output, encodeValue(document, newLines[index]), document);
    appendBytes(
      output,
      rawBytes(document, valuePiece.endByte(), line.kind.contentSpan.endByte()),
      document,
    );
  }
  return Uint8Array.from(output);
}

/** Canonical Python multiline form (edit.rs:1387-1430). */
function canonicalPythonValue(document: IniDocument, entry: IniEntry, value: string): Uint8Array {
  const logical = logicalEntityOf(document, entry.index());
  const first = document.entity(logical.kind.physicalLines[0]);
  if (first.kind.role !== 'PhysicalLine') {
    throw new Error('internal: ini physical-line entity expected');
  }
  const baseIndent = rawBytes(document, first.kind.contentSpan.startByte(), entry.keySpan().startByte());
  const output: number[] = [];
  const lines = value.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (index > 0) {
      appendBytes(output, encodeValue(document, '\n'), document);
      appendBytes(output, baseIndent, document);
      if (lines[index].length > 0) {
        appendBytes(output, encodeValue(document, '    '), document);
      }
    }
    appendBytes(output, encodeValue(document, lines[index]), document);
  }
  return Uint8Array.from(output);
}

function encodeValue(document: IniDocument, value: string): Uint8Array {
  try {
    return iniEncodeFragment(
      value,
      document.source().encodingFacts().selected(),
      document.parseLimits().common.maxSourceBytes,
    );
  } catch (failure) {
    if (!(failure instanceof Error) || (failure as { name?: string }).name !== 'MaterializationFailure') {
      throw failure;
    }
    const kind = (failure as { kind?: string }).kind;
    if (kind === 'ResourceLimit') {
      throw new IniEditFailure('ResourceLimit', { limitName: (failure as { reason?: string }).reason });
    }
    if (kind === 'UnsupportedEncoding') {
      throw new IniEditFailure('EncodingUnrepresentable');
    }
    throw new IniEditFailure('UnrepresentableValue');
  }
}

// -- structural operations (edit.rs:652-861) -----------------------------------

function prepareInsertSection(
  document: IniDocument,
  target: NodeRef,
  name: string,
  placement: AssociationPlacement,
): PreparedEdit {
  resolveDocumentOf(document, target);
  validateSectionName(document, name);
  validateSectionCollision(document, name, null);
  const sections = document.sections();
  let position: number;
  switch (placement.kind) {
    case 'Start':
      // The Go implementation guards an empty section list (go/ini/edit.go:
      // 906-913: position = source.Len()); the Rust authority indexes
      // sections()[0] unconditionally. The guard is adopted here.
      position = sections.length === 0 ? 0 : sectionLineStart(document, sections[0].index());
      break;
    case 'End':
      position = document.source().len();
      break;
    case 'Before': {
      const section = resolveSectionOf(document, placement.anchor);
      position = sectionLineStart(document, section);
      break;
    }
    case 'After': {
      const anchor = resolveSectionOf(document, placement.anchor);
      const ordinal = sections.findIndex((candidate) => candidate.index() === anchor);
      position =
        ordinal + 1 < sections.length
          ? sectionLineStart(document, sections[ordinal + 1].index())
          : document.source().len();
      break;
    }
  }
  let text = '';
  const decoded = document.source().decodedText();
  if (
    position === document.source().len() &&
    (decoded === null || !(decoded.endsWith('\n') || decoded.endsWith('\r')))
  ) {
    text += profileNewline(document);
  }
  text += `[${name}]`;
  text += profileNewline(document);
  return {
    oldSpan: document.authority().span(position, position),
    replacement: encodeValue(document, text),
    mappings: [{ old: target, plan: { kind: 'Unmapped', reason: 'document-reparsed-after-section-insertion' } }],
    mergeableDeletion: false,
  };
}

function prepareRemoveSection(document: IniDocument, target: NodeRef): PreparedEdit[] {
  const sectionIndex = resolveSectionOf(document, target);
  const sectionKind = sectionEntity(document, sectionIndex).kind;
  if (sectionKind.role !== 'Section' && sectionKind.role !== 'DefaultSection') {
    throw new Error('internal: ini section entity expected');
  }
  const edits: PreparedEdit[] = [];
  const headerSpans = logicalPhysicalSpans(document, sectionKind.logicalLine);
  headerSpans.forEach((span, index) => {
    edits.push(deletionEdit(span, index === 0 ? target : null));
  });
  for (const entry of document.entries()) {
    const kind = document.entity(entry.index()).kind;
    if (kind.role !== 'Entry' || kind.section !== sectionIndex) {
      continue;
    }
    logicalPhysicalSpans(document, kind.logicalLine).forEach((span, index) => {
      edits.push(deletionEdit(span, index === 0 ? entry.nodeRef() : null));
    });
  }
  return edits;
}

function prepareRenameSection(document: IniDocument, target: NodeRef, name: string): PreparedEdit {
  const sectionIndex = resolveSectionOf(document, target);
  validateSectionName(document, name);
  validateSectionCollision(document, name, target);
  const section = document.sections()[sectionOrdinalOf(document, sectionIndex)];
  return {
    oldSpan: section.nameSpan(),
    replacement: encodeValue(document, name),
    mappings: [{ old: target, plan: { kind: 'ReplacedSection', expectedName: name } }],
    mergeableDeletion: false,
  };
}

function prepareInsertEntry(
  document: IniDocument,
  sectionTarget: NodeRef,
  key: string,
  value: string,
  placement: AssociationPlacement,
): PreparedEdit {
  const sectionIndex = resolveSectionOf(document, sectionTarget);
  validateEntryKey(document, key);
  validateEntryCollision(document, sectionIndex, key, null);
  validateSemanticValue(document.profileTag(), value);
  const entries = entriesOfSection(document, sectionIndex);
  let position: number;
  switch (placement.kind) {
    case 'Start':
      position =
        entries.length === 0
          ? sectionContentEnd(document, sectionIndex)
          : entryLineStart(document, entries[0].index());
      break;
    case 'End':
      position = sectionContentEnd(document, sectionIndex);
      break;
    case 'Before': {
      const anchor = resolveEntryInSection(document, placement.anchor, sectionIndex, entries);
      position = entryLineStart(document, anchor);
      break;
    }
    case 'After': {
      const anchor = resolveEntryInSection(document, placement.anchor, sectionIndex, entries);
      position = entryLineEnd(document, anchor);
      break;
    }
  }
  let text = '';
  const decoded = document.source().decodedText();
  if (
    position === document.source().len() &&
    (decoded === null || !(decoded.endsWith('\n') || decoded.endsWith('\r')))
  ) {
    text += profileNewline(document);
  }
  text += canonicalEntryText(document, key, value);
  return {
    oldSpan: document.authority().span(position, position),
    replacement: encodeValue(document, text),
    mappings: [
      {
        old: sectionTarget,
        plan: { kind: 'SectionAfterEntryInsertion', expectedKey: key, expectedValue: value },
      },
    ],
    mergeableDeletion: false,
  };
}

function prepareRemoveEntry(document: IniDocument, target: NodeRef): PreparedEdit[] {
  const entryIndex = resolveEntryOf(document, target);
  const kind = document.entity(entryIndex).kind;
  if (kind.role !== 'Entry') {
    throw new Error('internal: ini entry entity expected');
  }
  const spans = logicalPhysicalSpans(document, kind.logicalLine);
  return spans.map((span, index) => deletionEdit(span, index === 0 ? target : null));
}

function prepareRenameEntry(document: IniDocument, target: NodeRef, key: string): PreparedEdit {
  const entryIndex = resolveEntryOf(document, target);
  const kind = document.entity(entryIndex).kind;
  if (kind.role !== 'Entry') {
    throw new Error('internal: ini entry entity expected');
  }
  validateEntryKey(document, key);
  validateEntryCollision(document, kind.section, key, target);
  const entry = document.entries()[entryOrdinalOf(document, entryIndex)];
  return {
    oldSpan: entry.keySpan(),
    replacement: encodeValue(document, key),
    mappings: [{ old: target, plan: { kind: 'ReplacedEntry', expectedKey: key } }],
    mergeableDeletion: false,
  };
}

/** Canonical inserted entry text (edit.rs:1101-1167). */
function canonicalEntryText(document: IniDocument, key: string, value: string): string {
  let text = '';
  switch (document.profileTag()) {
    case 'PortableV1':
      text = `${key}=${value}`;
      break;
    case 'WindowsV1':
      if (iniWindowsValueNeedsQuotes(value)) {
        const quote = value.startsWith('"') && value.endsWith('"') ? '\'' : '"';
        text = `${key}=${quote}${value}${quote}`;
      } else {
        text = `${key}=${value}`;
      }
      break;
    case 'PythonConfigParserV1':
      text = `${key} =`;
      value.split('\n').forEach((line, index) => {
        if (index === 0) {
          if (line.length > 0) {
            text += ' ';
          }
        } else {
          text += '\n';
          if (line.length > 0) {
            text += '    ';
          }
        }
        text += line;
      });
      break;
  }
  text += profileNewline(document);
  return text;
}

// -- dependency validation (edit.rs:863-920) ----------------------------------

function validateDependencies(document: IniDocument, transaction: IniEditTransaction): void {
  const removedSections = new Set<number>();
  const removedEntries = new Set<number>();
  for (const operation of transaction.operations()) {
    if (operation.kind === 'RemoveSection') {
      removedSections.add(resolveSectionOf(document, operation.target));
    }
    if (operation.kind === 'RemoveEntry') {
      removedEntries.add(resolveEntryOf(document, operation.target));
    }
  }
  for (const operation of transaction.operations()) {
    switch (operation.kind) {
      case 'InsertSection':
        if (
          (operation.placement.kind === 'Before' || operation.placement.kind === 'After') &&
          removedSections.has(resolveSectionOf(document, operation.placement.anchor))
        ) {
          throw new IniEditFailure('PlacementAnchorRemoved');
        }
        break;
      case 'InsertEntry': {
        if (
          (operation.placement.kind === 'Before' || operation.placement.kind === 'After') &&
          removedEntries.has(resolveEntryOf(document, operation.placement.anchor))
        ) {
          throw new IniEditFailure('PlacementAnchorRemoved');
        }
        if (removedSections.has(resolveSectionOf(document, operation.section))) {
          throw new IniEditFailure('AncestorDescendantConflict');
        }
        break;
      }
      case 'ReplaceValue': {
        const entryIndex = resolveEntryOf(document, operation.replacement.target);
        const kind = document.entity(entryIndex).kind;
        if (kind.role === 'Entry' && removedSections.has(kind.section)) {
          throw new IniEditFailure('AncestorDescendantConflict');
        }
        break;
      }
      case 'RemoveEntry':
      case 'RenameEntry': {
        const entryIndex = resolveEntryOf(document, operation.target);
        const kind = document.entity(entryIndex).kind;
        if (kind.role === 'Entry' && removedSections.has(kind.section)) {
          throw new IniEditFailure('AncestorDescendantConflict');
        }
        break;
      }
      case 'RemoveSection':
      case 'RenameSection':
        break;
    }
  }
}

// -- target resolution and validation (edit.rs:922-1069) ----------------------

function resolveDocumentOf(document: IniDocument, target: NodeRef): void {
  try {
    document.validateRef(target, 'IniDocument');
  } catch (error) {
    throw editAccessFailure(error);
  }
}

function resolveSectionOf(document: IniDocument, target: NodeRef): number {
  try {
    return document.validateSectionRef(target);
  } catch (error) {
    throw editAccessFailure(error);
  }
}

function resolveEntryOf(document: IniDocument, target: NodeRef): number {
  try {
    return document.validateRef(target, 'IniEntry');
  } catch (error) {
    throw editAccessFailure(error);
  }
}

function editAccessFailure(error: unknown): IniEditFailure {
  if (error instanceof IniAccessError) {
    switch (error.kind) {
      case 'WrongSnapshot':
        return new IniEditFailure('WrongSnapshot');
      case 'WrongRole':
        return new IniEditFailure('WrongRole');
      case 'UnknownNode':
        return new IniEditFailure('TargetNotFound');
    }
  }
  // DocumentAuthority.verify throws LocationError for foreign-snapshot refs
  // (edit.rs:922-931 resolves the snapshot before the role).
  if (error instanceof LocationError && error.kind === 'WrongSnapshot') {
    return new IniEditFailure('WrongSnapshot');
  }
  throw error;
}

function resolveEntryInSection(
  document: IniDocument,
  target: NodeRef,
  sectionIndex: number,
  entries: readonly IniEntry[],
): number {
  const entryIndex = resolveEntryOf(document, target);
  const found = entries.some((entry) => entry.index() === entryIndex);
  if (!found) {
    throw new IniEditFailure('InvalidPlacement');
  }
  return entryIndex;
}

function validateSectionName(document: IniDocument, name: string): void {
  const valid =
    document.profileTag() === 'PortableV1'
      ? name.length > 0 && allBytes(name, isPortableName)
      : document.profileTag() === 'WindowsV1'
        ? name.length > 0 && allBytes(name, isWindowsName)
        : name.length > 0 && !name.includes('\0') && !name.includes('\r') && !name.includes('\n');
  if (!valid) {
    throw new IniEditFailure('InvalidName');
  }
}

function validateSectionCollision(
  document: IniDocument,
  name: string,
  except: NodeRef | null,
): void {
  if (document.profileTag() === 'WindowsV1') {
    return;
  }
  const collision = document.sections().some((section) => {
    if (except !== null && section.nodeRef().equals(except)) {
      return false;
    }
    return section.name() === name;
  });
  if (collision) {
    throw new IniEditFailure('NameCollision');
  }
}

function validateEntryKey(document: IniDocument, key: string): void {
  const valid =
    document.profileTag() === 'PortableV1'
      ? key.length > 0 && allBytes(key, isPortableName)
      : document.profileTag() === 'WindowsV1'
        ? key.length > 0 && key.trim() === key && allBytes(key, isWindowsName)
        : key.length > 0 &&
          key.trim() === key &&
          !key.includes('\0') &&
          !key.includes('\r') &&
          !key.includes('\n') &&
          !key.includes('=') &&
          !key.includes(':') &&
          key.charCodeAt(0) !== 0x23 &&
          key.charCodeAt(0) !== 0x3b;
  if (!valid) {
    throw new IniEditFailure('InvalidKey');
  }
}

function validateEntryCollision(
  document: IniDocument,
  sectionIndex: number,
  key: string,
  except: NodeRef | null,
): void {
  if (document.profileTag() === 'WindowsV1') {
    return;
  }
  const comparison = document.profileTag() === 'PythonConfigParserV1' ? optionxform(key) : key;
  for (const entry of document.entries()) {
    const kind = document.entity(entry.index()).kind;
    if (kind.role !== 'Entry' || kind.section !== sectionIndex) {
      continue;
    }
    if (except !== null && entry.nodeRef().equals(except)) {
      continue;
    }
    if (entry.comparisonKey() === comparison) {
      throw new IniEditFailure(entry.key() === key ? 'DuplicateKey' : 'KeyCollision');
    }
  }
}

function validateSemanticValue(profileTag: string, value: string): void {
  const valid =
    profileTag === 'PortableV1'
      ? allBytes(value, isPortableValue)
      : profileTag === 'WindowsV1'
        ? !value.includes('\0') && !value.includes('\r') && !value.includes('\n')
        : !value.includes('\0') &&
          !value.includes('\r') &&
          !value.endsWith('\n') &&
          value.split('\n').every((line, index) => {
            return (
              line.trim() === line &&
              (index === 0 || (line.charCodeAt(0) !== 0x23 && line.charCodeAt(0) !== 0x3b))
            );
          });
  if (!valid) {
    throw new IniEditFailure('UnrepresentableValue');
  }
}

// -- line and span helpers (edit.rs:1071-1226) ---------------------------------

function sectionLineStart(document: IniDocument, sectionIndex: number): number {
  const kind = document.entity(sectionIndex).kind;
  if (kind.role !== 'Section' && kind.role !== 'DefaultSection') {
    throw new Error('internal: ini section entity expected');
  }
  return logicalFirstLineStart(document, kind.logicalLine);
}

function entryLineStart(document: IniDocument, entryIndex: number): number {
  const kind = document.entity(entryIndex).kind;
  if (kind.role !== 'Entry') {
    throw new Error('internal: ini entry entity expected');
  }
  return logicalFirstLineStart(document, kind.logicalLine);
}

function entryLineEnd(document: IniDocument, entryIndex: number): number {
  const kind = document.entity(entryIndex).kind;
  if (kind.role !== 'Entry') {
    throw new Error('internal: ini entry entity expected');
  }
  const logical = document.entity(kind.logicalLine);
  if (logical.kind.role !== 'LogicalLine') {
    throw new Error('internal: ini logical-line entity expected');
  }
  const last = document.entity(logical.kind.physicalLines[logical.kind.physicalLines.length - 1]);
  if (last.kind.role !== 'PhysicalLine') {
    throw new Error('internal: ini physical-line entity expected');
  }
  return last.span.endByte();
}

function logicalFirstLineStart(document: IniDocument, logicalIndex: number): number {
  const logical = document.entity(logicalIndex);
  if (logical.kind.role !== 'LogicalLine') {
    throw new Error('internal: ini logical-line entity expected');
  }
  const first = document.entity(logical.kind.physicalLines[0]);
  if (first.kind.role !== 'PhysicalLine') {
    throw new Error('internal: ini physical-line entity expected');
  }
  return first.span.startByte();
}

function logicalPhysicalSpans(document: IniDocument, logicalIndex: number): Span[] {
  const logical = document.entity(logicalIndex);
  if (logical.kind.role !== 'LogicalLine') {
    throw new Error('internal: ini logical-line entity expected');
  }
  return logical.kind.physicalLines.map((physical) => document.entity(physical).span);
}

function sectionContentEnd(document: IniDocument, sectionIndex: number): number {
  const sections = document.sections();
  const ordinal = sections.findIndex((section) => section.index() === sectionIndex);
  if (ordinal < 0) {
    throw new IniEditFailure('TargetNotFound');
  }
  if (ordinal + 1 < sections.length) {
    return sectionLineStart(document, sections[ordinal + 1].index());
  }
  return document.source().len();
}

function coalesceAdjacentDeletions(document: IniDocument, edits: readonly PreparedEdit[]): PreparedEdit[] {
  const merged: PreparedEdit[] = [];
  for (const edit of edits) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      previous.mergeableDeletion &&
      edit.mergeableDeletion &&
      previous.oldSpan.endByte() === edit.oldSpan.startByte()
    ) {
      merged[merged.length - 1] = {
        oldSpan: document.authority().span(previous.oldSpan.startByte(), edit.oldSpan.endByte()),
        replacement: previous.replacement,
        mappings: [...previous.mappings, ...edit.mappings],
        mergeableDeletion: true,
      };
    } else {
      merged.push(edit);
    }
  }
  return merged;
}

function deletionEdit(span: Span, target: NodeRef | null): PreparedEdit {
  return {
    oldSpan: span,
    replacement: new Uint8Array(0),
    mappings:
      target === null
        ? []
        : [{ old: target, plan: { kind: 'Deleted' } }],
    mergeableDeletion: true,
  };
}

function syntaxSpan(document: IniDocument, kind: IniSyntaxKind, within: Span): Span | null {
  const pieces = document.losslessStructuralIndex().pieces();
  const kinds = document.losslessSyntaxKinds();
  for (let index = 0; index < pieces.length; index++) {
    if (kinds[index] !== kind) {
      continue;
    }
    const span = pieces[index].span();
    if (span.startByte() >= within.startByte() && span.endByte() <= within.endByte()) {
      return span;
    }
  }
  return null;
}

function rawBytes(document: IniDocument, start: number, end: number): Uint8Array {
  const bytes = document.source().bytes();
  const slice = bytes.subarray(start, end);
  if (slice.length !== end - start) {
    throw new IniEditFailure('NewDocumentFormationFailed');
  }
  return slice;
}

function appendBytes(output: number[], bytes: Uint8Array, document: IniDocument): void {
  const length = output.length + bytes.length;
  if (length > document.parseLimits().common.maxSourceBytes) {
    throw new IniEditFailure('ResourceLimit', { limitName: 'replacement-bytes' });
  }
  for (const byte of bytes) {
    output.push(byte);
  }
}

function profileNewline(document: IniDocument): string {
  return document.profileTag() === 'WindowsV1' ? '\r\n' : '\n';
}

// -- mapping resolution helpers (edit.rs:426-524) ------------------------------

function findEntryByOwnership(document: IniDocument, expectedKey: string, newSpan: Span): NodeRef | null {
  for (const entry of document.entries()) {
    if (entry.key() !== expectedKey) {
      continue;
    }
    if (valueOwnership(document, entry).equals(newSpan)) {
      return entry.nodeRef();
    }
  }
  return null;
}

function findSectionByNameSpan(document: IniDocument, expectedName: string, newSpan: Span): NodeRef | null {
  for (const section of document.sections()) {
    if (section.name() === expectedName && section.nameSpan().equals(newSpan)) {
      return section.nodeRef();
    }
  }
  return null;
}

function findEntryByKeySpan(document: IniDocument, expectedKey: string, newSpan: Span): NodeRef | null {
  for (const entry of document.entries()) {
    if (entry.key() === expectedKey && entry.keySpan().equals(newSpan)) {
      return entry.nodeRef();
    }
  }
  return null;
}

function hasInsertedEntry(
  document: IniDocument,
  expectedKey: string,
  expectedValue: string,
  newSpan: Span,
): boolean {
  for (const entry of document.entries()) {
    if (entry.key() !== expectedKey || entry.value() !== expectedValue) {
      continue;
    }
    const span = entryRecordSpan(document, entry);
    if (span !== null && span.startByte() >= newSpan.startByte() && span.endByte() === newSpan.endByte()) {
      return true;
    }
  }
  return false;
}

function entryRecordSpan(document: IniDocument, entry: IniEntry): Span | null {
  const kind = document.entity(entry.index()).kind;
  if (kind.role !== 'Entry') {
    throw new Error('internal: ini entry entity expected');
  }
  const logical = document.entity(kind.logicalLine);
  if (logical.kind.role !== 'LogicalLine') {
    throw new Error('internal: ini logical-line entity expected');
  }
  const first = document.entity(logical.kind.physicalLines[0]);
  const last = document.entity(logical.kind.physicalLines[logical.kind.physicalLines.length - 1]);
  if (first.kind.role !== 'PhysicalLine' || last.kind.role !== 'PhysicalLine') {
    throw new Error('internal: ini physical-line entity expected');
  }
  return document.authority().span(first.span.startByte(), last.span.endByte());
}

// -- entity helpers --------------------------------------------------------------

function sectionEntity(document: IniDocument, index: number) {
  return document.entity(index);
}

function sectionOrdinalOf(document: IniDocument, sectionIndex: number): number {
  return document.sections().findIndex((section) => section.index() === sectionIndex);
}

function entryOrdinalOf(document: IniDocument, entryIndex: number): number {
  return document.entries().findIndex((entry) => entry.index() === entryIndex);
}

function entriesOfSection(document: IniDocument, sectionIndex: number): IniEntry[] {
  return document.entries().filter((entry) => {
    const kind = document.entity(entry.index()).kind;
    return kind.role === 'Entry' && kind.section === sectionIndex;
  });
}

function logicalEntityOf(
  document: IniDocument,
  entryIndex: number,
): IniEntity & { kind: Extract<IniEntityKind, { role: 'LogicalLine' }> } {
  const kind = document.entity(entryIndex).kind;
  if (kind.role !== 'Entry') {
    throw new Error('internal: ini entry entity expected');
  }
  const logical = document.entity(kind.logicalLine);
  if (logical.kind.role !== 'LogicalLine') {
    throw new Error('internal: ini logical-line entity expected');
  }
  return logical as IniEntity & { kind: Extract<IniEntityKind, { role: 'LogicalLine' }> };
}

function destructiveTarget(operation: IniEditOperation): NodeRef | null {
  switch (operation.kind) {
    case 'ReplaceValue':
      return operation.replacement.target;
    case 'RemoveSection':
    case 'RenameSection':
    case 'RemoveEntry':
    case 'RenameEntry':
      return operation.target;
    case 'InsertSection':
    case 'InsertEntry':
      return null;
  }
}

function nodeKey(node: NodeRef): string {
  return `${node.snapshot().asBigInt()}:${node.index()}:${node.role()}`;
}

// ---------------------------------------------------------------------------
// Encoding selection, metadata, and summaries (edit.rs:1570-1720)
// ---------------------------------------------------------------------------

function originalEncodingSelection(document: IniDocument): IniEncodingSelection {
  const override = document.source().encodingFacts().callerOverride();
  return override === null ? { kind: 'ProfileDefault' } : { kind: 'Explicit', encoding: override };
}

function operationMetadata(transaction: IniEditTransaction): Map<string, string> {
  const metadata = new Map<string, string>();
  transaction.operations().forEach((operation, index) => {
    metadata.set(`operation.${index}`, `${operationId(operation)}@1`);
  });
  return metadata;
}

function operationId(operation: IniEditOperation): string {
  switch (operation.kind) {
    case 'ReplaceValue':
      return operation.replacement.kind === 'Semantic'
        ? 'ini.edit.replace-semantic-value'
        : 'ini.edit.replace-literal-value';
    case 'InsertSection':
      return 'ini.edit.insert-section';
    case 'RemoveSection':
      return 'ini.edit.remove-section';
    case 'RenameSection':
      return 'ini.edit.rename-section';
    case 'InsertEntry':
      return 'ini.edit.insert-entry';
    case 'RemoveEntry':
      return 'ini.edit.remove-entry';
    case 'RenameEntry':
      return 'ini.edit.rename-entry';
  }
}

function operationSummaries(transaction: IniEditTransaction): EditOperationSummary[] {
  return transaction.operations().map((operation) => {
    const id = operationId(operation);
    const arguments_ = new Map<string, string>();
    switch (operation.kind) {
      case 'ReplaceValue': {
        const replacement = operation.replacement;
        if (replacement.kind === 'Semantic') {
          arguments_.set('representation_policy', policyName(replacement.policy));
          arguments_.set('value_scalars', String([...replacement.value].length));
        } else {
          arguments_.set('literal_bytes', String(replacement.literal.length));
        }
        break;
      }
      case 'InsertSection':
        arguments_.set('name_scalars', String([...operation.name].length));
        arguments_.set('placement', placementName(operation.placement));
        break;
      case 'RenameSection':
        arguments_.set('name_scalars', String([...operation.name].length));
        break;
      case 'InsertEntry':
        arguments_.set('key_scalars', String([...operation.key].length));
        arguments_.set('placement', placementName(operation.placement));
        arguments_.set('value_scalars', String([...operation.value].length));
        break;
      case 'RenameEntry':
        arguments_.set('key_scalars', String([...operation.key].length));
        break;
      case 'RemoveSection':
      case 'RemoveEntry':
        break;
    }
    return new EditOperationSummary(new FormatOperationId(id, 1), arguments_);
  });
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

function policyName(policy: IniRepresentationPolicy): string {
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

function sourcePatchLimitsFor(limits: IniParseLimits, operationCount: number): SourcePatchLimits {
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

// ---------------------------------------------------------------------------
// Character classes (edit.rs:1518-1568)
// ---------------------------------------------------------------------------

function allBytes(value: string, predicate: (byte: number) => boolean): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 0x7f || !predicate(code)) {
      return false;
    }
  }
  return true;
}

function isPortableName(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x5f ||
    byte === 0x2d ||
    byte === 0x2e
  );
}

function isPortableValue(byte: number): boolean {
  return (
    (byte >= 0x21 && byte <= 0x7e &&
      byte !== 0x27 && byte !== 0x22 && byte !== 0x5c && byte !== 0x3a && byte !== 0x23 && byte !== 0x3b) ||
    byte === 0x20
  );
}

function isWindowsName(byte: number): boolean {
  return (
    (byte >= 0x21 && byte <= 0x7e) || byte === 0x20
  ) && !(byte === 0x5b || byte === 0x5d || byte === 0x3d);
}
