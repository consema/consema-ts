/**
 * HCL structural edit transactions with atomic commit (RFC 0014 §10).
 *
 * authority: crates/consema-hcl/src/edit.rs —
 *  - BodyPathStep :93-138 (block type + exact label sequence + 0-based
 *    occurrence), BodyPath :140-174, NodeRef :176-212 (attribute by
 *    body+name; block by body+type+labels+occurrence), BodyPlacement
 *    :214-226 (First/Last/After), EditValue :228-308 (typed
 *    literal-complete values; the Expression variant is refused by every
 *    commit with `hcl.edit.unrepresentable@1`), EditKey :310-325 (the
 *    bare identifier/number/string forms; an identifier key spelled `for`
 *    is refused), EditOperation :327-397, EditTransaction/Builder
 *    :399-533, EditCommit :536-545, EditFailure :547-612 (codes
 *    :599-611), commit/dry_run :614-637, commit_impl :641-660 (WrongSnapshot,
 *    IncompleteTarget, report-events)
 *  - the sequential model (:18-32): operations apply in order against the
 *    evolving document state; spans inside earlier replacements fold and
 *    overlapping base spans merge at commit (OverlappingOwnership has no
 *    emission path); conflict validation covers wrong
 *    profile/role/snapshot, missing or duplicate target, stale anchors,
 *    duplicate-attribute creation, tfvars block insertion, unrepresentable
 *    values, limit failure, and reparse failure
 *  - the frozen operation ids (:6-11): set-attribute-value /
 *    insert-attribute / remove-attribute / rename-attribute /
 *    insert-block / remove-block; the tfvars profile does not publish the
 *    block operations (RFC 0014 §5, §10)
 *  - summaries and metadata (:2037-2126): `operation.{index}` metadata
 *    keys must match the SourcePatch metadata exactly
 *
 * Design (TypeScript-idiomatic): an immutable transaction built through a
 * builder; `commitHclEdits` validates and plans every operation before
 * publishing anything. Operations resolve sequentially against a working
 * source that is reparsed after each step; every prepared edit is
 * converted to base coordinates, folded, and merged, so the committed
 * ChangeSet, SourcePatch, and untouched-byte proof are exact. Success
 * returns the new Document, ChangeSet, UntouchedByteProof, and a replayable
 * SourcePatch; failure returns none (RFC 0014 §10, hard gate 4).
 */

import { Span } from '../document/identity.ts';
import type { SnapshotIdentity } from '../document/identity.ts';
import { ChangeSet, NodeMapping, SourceEdit } from '../document/change_set.ts';
import { SourcePatch, DEFAULT_SOURCE_PATCH_LIMITS } from '../document/source_patch.ts';
import type { SourcePatchLimits } from '../document/source_patch.ts';
import { UntouchedByteProof } from '../document/untouched_proof.ts';
import { EditPlan, EditOperationSummary, EditPlanSourceId } from '../document/edit_plan.ts';
import { FormatOperationId } from '../document/operation.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { HclDocument, parseHcl } from './document.ts';
import { profileDefaultEncoding } from './document.ts';
import { HclProfile } from './profile.ts';
import { HclEditFailure } from './errors.ts';
import type { HclParseLimits } from './limits.ts';
import { canonicalRealFromNumber } from './materialization.ts';

// ---------------------------------------------------------------------------
// Addresses, placements, and values (edit.rs:93-325)
// ---------------------------------------------------------------------------

/** One root-relative body path step (edit.rs:93-138). */
export class HclBodyPathStep {
  readonly #blockType: string;
  readonly #labels: readonly string[];
  readonly #occurrence: number;

  constructor(blockType: string, labels: readonly string[], occurrence: number) {
    this.#blockType = blockType;
    this.#labels = Object.freeze([...labels]);
    this.#occurrence = occurrence;
  }

  /** Exact block type of the step. */
  blockType(): string {
    return this.#blockType;
  }

  /** Exact label sequence of the step. */
  labels(): readonly string[] {
    return this.#labels;
  }

  /** 0-based source position among the blocks with the same type and labels. */
  occurrence(): number {
    return this.#occurrence;
  }
}

/** A root-relative path to one body; the empty path denotes the root body (edit.rs:140-174). */
export class HclBodyPath {
  readonly #steps: readonly HclBodyPathStep[];

  private constructor(steps: readonly HclBodyPathStep[]) {
    this.#steps = Object.freeze([...steps]);
  }

  /** Root body path. */
  static root(): HclBodyPath {
    return new HclBodyPath([]);
  }

  /** Creates a path from ordered steps. */
  static of(steps: readonly HclBodyPathStep[]): HclBodyPath {
    return new HclBodyPath(steps);
  }

  /** Ordered path steps. */
  segments(): readonly HclBodyPathStep[] {
    return this.#steps;
  }
}

/** One exact body item address (edit.rs:176-212). */
export type HclEditNodeRef =
  | { readonly kind: 'Attribute'; readonly body: HclBodyPath; readonly name: string }
  | {
      readonly kind: 'Block';
      readonly body: HclBodyPath;
      readonly blockType: string;
      readonly labels: readonly string[];
      readonly occurrence: number;
    };

/** Attribute insertion placement inside one body (edit.rs:214-226). */
export type HclBodyPlacement =
  | { readonly kind: 'First' }
  | { readonly kind: 'Last' }
  | { readonly kind: 'After'; readonly anchor: HclEditNodeRef };

/** One typed literal-complete HCL value supplied to an edit (edit.rs:228-308). */
export type HclEditValue =
  | { readonly kind: 'Integer'; readonly value: bigint }
  | { readonly kind: 'Real'; readonly value: number }
  | { readonly kind: 'String'; readonly value: string }
  | { readonly kind: 'Boolean'; readonly value: boolean }
  | { readonly kind: 'Null' }
  | { readonly kind: 'Tuple'; readonly elements: readonly HclEditValue[] }
  | { readonly kind: 'Object'; readonly entries: readonly (readonly [HclEditKey, HclEditValue])[] }
  | {
      readonly kind: 'Expression';
      readonly kindName: string;
      readonly text: string;
    };

/** One object-constructor literal key (edit.rs:310-325). */
export type HclEditKey =
  | { readonly kind: 'Identifier'; readonly name: string }
  | { readonly kind: 'Number'; readonly value: bigint }
  | { readonly kind: 'String'; readonly value: string };

/** Stable value-kind spelling for summaries (edit.rs:266-280). */
export function hclEditValueKindName(value: HclEditValue): string {
  switch (value.kind) {
    case 'Integer':
      return 'integer';
    case 'Real':
      return 'real';
    case 'String':
      return 'string';
    case 'Boolean':
      return 'boolean';
    case 'Null':
      return 'null';
    case 'Tuple':
      return 'tuple';
    case 'Object':
      return 'object';
    case 'Expression':
      return 'expression';
  }
}

/** One snapshot-bound HCL structural operation (edit.rs:327-397). */
export type HclEditOperation =
  | {
      readonly kind: 'SetAttributeValue';
      readonly body: HclBodyPath;
      readonly attribute: string;
      readonly value: HclEditValue;
    }
  | {
      readonly kind: 'InsertAttribute';
      readonly body: HclBodyPath;
      readonly name: string;
      readonly value: HclEditValue;
      readonly placement: HclBodyPlacement;
    }
  | { readonly kind: 'RemoveAttribute'; readonly body: HclBodyPath; readonly attribute: string }
  | { readonly kind: 'RenameAttribute'; readonly body: HclBodyPath; readonly attribute: string; readonly name: string }
  | {
      readonly kind: 'InsertBlock';
      readonly body: HclBodyPath;
      readonly blockType: string;
      readonly labels: readonly string[];
      readonly attributes: readonly (readonly [string, HclEditValue])[];
      readonly placement: HclBodyPlacement;
    }
  | {
      readonly kind: 'RemoveBlock';
      readonly body: HclBodyPath;
      readonly blockType: string;
      readonly labels: readonly string[];
      readonly occurrence: number;
    };

/** Immutable snapshot-bound transaction (edit.rs:399-418). */
export class HclEditTransaction {
  readonly #base: SnapshotIdentity;
  readonly #operations: readonly HclEditOperation[];

  /** @internal — built via HclEditTransactionBuilder. */
  constructor(base: SnapshotIdentity, operations: readonly HclEditOperation[]) {
    this.#base = base;
    this.#operations = Object.freeze([...operations]);
  }

  /** Base snapshot identity. */
  baseSnapshot(): SnapshotIdentity {
    return this.#base;
  }

  /** Ordered declared operations. */
  operations(): readonly HclEditOperation[] {
    return this.#operations;
  }
}

/** Builder that is not a committed edit (edit.rs:420-533). */
export class HclEditTransactionBuilder {
  readonly #base: SnapshotIdentity;
  readonly #operations: HclEditOperation[] = [];

  /** Binds a new transaction to one immutable base document. */
  constructor(document: HclDocument) {
    this.#base = document.snapshotIdentity();
  }

  /** Replaces one attribute value. */
  setAttributeValue(body: HclBodyPath, attribute: string, value: HclEditValue): HclEditTransactionBuilder {
    this.#operations.push({ kind: 'SetAttributeValue', body, attribute, value });
    return this;
  }

  /** Inserts one attribute into a body. */
  insertAttribute(
    body: HclBodyPath,
    name: string,
    value: HclEditValue,
    placement: HclBodyPlacement,
  ): HclEditTransactionBuilder {
    this.#operations.push({ kind: 'InsertAttribute', body, name, value, placement });
    return this;
  }

  /** Removes one attribute. */
  removeAttribute(body: HclBodyPath, attribute: string): HclEditTransactionBuilder {
    this.#operations.push({ kind: 'RemoveAttribute', body, attribute });
    return this;
  }

  /** Renames one attribute. */
  renameAttribute(body: HclBodyPath, attribute: string, name: string): HclEditTransactionBuilder {
    this.#operations.push({ kind: 'RenameAttribute', body, attribute, name });
    return this;
  }

  /** Inserts one block into a body. */
  insertBlock(
    body: HclBodyPath,
    blockType: string,
    labels: readonly string[],
    attributes: readonly (readonly [string, HclEditValue])[],
    placement: HclBodyPlacement,
  ): HclEditTransactionBuilder {
    this.#operations.push({ kind: 'InsertBlock', body, blockType, labels, attributes, placement });
    return this;
  }

  /** Removes one block by exact type, labels, and occurrence. */
  removeBlock(
    body: HclBodyPath,
    blockType: string,
    labels: readonly string[],
    occurrence: number,
  ): HclEditTransactionBuilder {
    this.#operations.push({ kind: 'RemoveBlock', body, blockType, labels, occurrence });
    return this;
  }

  /** Completes the immutable request; target validation occurs atomically at commit. */
  build(): HclEditTransaction {
    return new HclEditTransaction(this.#base, this.#operations);
  }
}

/** Atomic edit success (edit.rs:536-545). */
export class HclEditCommit {
  readonly #document: HclDocument;
  readonly #changeSet: ChangeSet;
  readonly #sourcePatch: SourcePatch;
  readonly #untouchedProof: UntouchedByteProof;

  constructor(document: HclDocument, changeSet: ChangeSet, sourcePatch: SourcePatch, untouchedProof: UntouchedByteProof) {
    this.#document = document;
    this.#changeSet = changeSet;
    this.#sourcePatch = sourcePatch;
    this.#untouchedProof = untouchedProof;
  }

  /** New immutable document. */
  document(): HclDocument {
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
// Canonical value rendering (edit.rs:1472-1616; RFC 0014 §10)
// ---------------------------------------------------------------------------

/** Renders one typed literal-complete value as canonical HCL source. */
export function canonicalHclFragment(value: HclEditValue): string {
  return renderEditValue(value, 0);
}

function renderEditValue(value: HclEditValue, depth: number): string {
  switch (value.kind) {
    case 'Integer':
      return value.value.toString();
    case 'Real': {
      if (!Number.isFinite(value.value)) {
        throw new HclEditFailure('UnrepresentableValue', { fact: 'non-finite-real' });
      }
      return canonicalRealFromNumber(value.value);
    }
    case 'String':
      return quoteFragment(value.value);
    case 'Boolean':
      return value.value ? 'true' : 'false';
    case 'Null':
      return 'null';
    case 'Tuple': {
      if (value.elements.length === 0) {
        return '[]';
      }
      let out = '[\n';
      const last = value.elements.length - 1;
      for (let index = 0; index < value.elements.length; index++) {
        out += indent(depth + 1) + renderEditValue(value.elements[index], depth + 1);
        out += index === last ? '\n' : ',\n';
      }
      out += indent(depth) + ']';
      return out;
    }
    case 'Object': {
      if (value.entries.length === 0) {
        return '{}';
      }
      let out = '{\n';
      const last = value.entries.length - 1;
      for (let index = 0; index < value.entries.length; index++) {
        const [key, entryValue] = value.entries[index];
        out += indent(depth + 1) + renderEditKey(key) + ' = ' + renderEditValue(entryValue, depth + 1);
        out += index === last ? '\n' : ',\n';
      }
      out += indent(depth) + '}';
      return out;
    }
    case 'Expression':
      // The Expression variant is refused by every commit; no commit ever
      // renders it (RFC 0014 §10, §14).
      throw new HclEditFailure('UnrepresentableValue', { fact: 'expression' });
  }
}

function renderEditKey(key: HclEditKey): string {
  switch (key.kind) {
    case 'Identifier':
      if (key.name === 'for') {
        // The for-expression interpretation has priority (RFC 0014 §4.6).
        throw new HclEditFailure('UnrepresentableValue', { fact: 'for-key' });
      }
      return key.name;
    case 'Number':
      return key.value.toString();
    case 'String':
      return quoteFragment(key.value);
  }
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}

/** Double-quotes one string with the minimal deterministic escapes (RFC 0014 §9). */
function quoteFragment(text: string): string {
  return `"${escapeFragment(text)}"`;
}

function escapeFragment(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const byte = text.charCodeAt(index);
    if (byte === 0x24 || byte === 0x25) {
      let run = 1;
      while (index + run < text.length && text.charCodeAt(index + run) === byte) {
        run += 1;
      }
      const doubled = index + run < text.length && text.charCodeAt(index + run) === 0x7b;
      for (let i = 0; i < run + (doubled ? 1 : 0); i++) {
        out += String.fromCharCode(byte);
      }
      index += run;
    } else {
      const character = text[index];
      switch (character) {
        case '"':
          out += '\\"';
          break;
        case '\\':
          out += '\\\\';
          break;
        case '\n':
          out += '\\n';
          break;
        case '\r':
          out += '\\r';
          break;
        case '\t':
          out += '\\t';
          break;
        default: {
          const codePoint = text.codePointAt(index)!;
          if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
            out += `\\u${codePoint.toString(16).padStart(4, '0')}`;
          } else {
            out += character;
          }
          break;
        }
      }
      index += character.length;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Base-coordinate patch bookkeeping
// ---------------------------------------------------------------------------

interface BaseEdit {
  readonly oldStart: number;
  readonly oldEnd: number;
  readonly replacement: string;
  /** The operation ordinal that produced this edit. */
  readonly opIndex: number;
}

/** Maps working-source offsets back to base-source offsets (edit.rs:449-1062). */
class PatchMap {
  readonly #baseLen: number;
  readonly #edits: BaseEdit[] = [];

  constructor(baseLen: number) {
    this.#baseLen = baseLen;
  }

  /** Applies one working-coordinate edit and records its base-coordinate span. */
  apply(workingStart: number, workingEnd: number, replacement: string, opIndex: number): BaseEdit {
    const oldStart = this.workToBase(workingStart);
    const oldEnd = this.workToBase(workingEnd);
    const edit: BaseEdit = { oldStart, oldEnd, replacement, opIndex };
    this.#edits.push(edit);
    return edit;
  }

  /** The working offset of one base offset. */
  baseToWork(base: number): number {
    let b = 0;
    let w = 0;
    for (const edit of this.#sorted()) {
      if (base < edit.oldStart) {
        return w + (base - b);
      }
      if (base <= edit.oldEnd) {
        return w + (edit.oldStart - b) + edit.replacement.length;
      }
      w += edit.oldStart - b + edit.replacement.length;
      b = edit.oldEnd;
    }
    return w + (base - b);
  }

  /** The base offset of one working offset. */
  workToBase(working: number): number {
    let b = 0;
    let w = 0;
    for (const edit of this.#sorted()) {
      const before = edit.oldStart - b;
      if (working < w + before) {
        return b + (working - w);
      }
      w += before;
      b = edit.oldStart;
      if (working < w + edit.replacement.length) {
        return edit.oldEnd;
      }
      w += edit.replacement.length;
      b = edit.oldEnd;
    }
    return b + (working - w);
  }

  /** The edits in deterministic base order for the piecewise mapping. */
  #sorted(): BaseEdit[] {
    return [...this.#edits].sort((left, right) => left.oldStart - right.oldStart);
  }

  /** The current working source derived from the base bytes. */
  workingBytes(base: Uint8Array): Uint8Array {
    let out = '';
    let cursor = 0;
    for (const edit of [...this.#edits].sort((left, right) => left.oldStart - right.oldStart)) {
      out += new TextDecoder().decode(base.slice(cursor, edit.oldStart));
      out += edit.replacement;
      cursor = edit.oldEnd;
    }
    out += new TextDecoder().decode(base.slice(cursor));
    return new TextEncoder().encode(out);
  }

  /** The folded, merged, ordered base edits for the ChangeSet. */
  folded(): BaseEdit[] {
    const sorted = [...this.#edits].sort((left, right) => {
      if (left.oldStart !== right.oldStart) {
        return left.oldStart - right.oldStart;
      }
      // The covering span comes first so the merge below subsumes it.
      return right.oldEnd - left.oldEnd;
    });
    const merged: BaseEdit[] = [];
    for (const edit of sorted) {
      const last = merged[merged.length - 1];
      if (last !== undefined && edit.oldStart < last.oldEnd) {
        // Merge overlapping base spans: a later edit whose span covers the
        // earlier one subsumes it (its replacement region is inside the
        // covered span); insertions at one point concatenate; partial
        // overlaps concatenate in base order.
        const combinedOldEnd = Math.max(last.oldEnd, edit.oldEnd);
        let replacement: string;
        if (edit.oldStart <= last.oldStart && edit.oldEnd >= last.oldEnd) {
          // `edit` covers `last`; a zero-length insertion by `last` inside
          // the covered span still contributes its text at its base offset.
          if (last.oldStart === last.oldEnd) {
            const at = last.oldStart - edit.oldStart;
            replacement = edit.replacement.slice(0, at) + last.replacement + edit.replacement.slice(at);
          } else {
            replacement = edit.replacement;
          }
        } else if (edit.oldStart >= last.oldStart && edit.oldEnd <= last.oldEnd) {
          // `last` covers `edit`; a zero-length insertion by `edit` inside
          // the covered span splices into the covering replacement.
          if (edit.oldStart === edit.oldEnd) {
            const at = edit.oldStart - last.oldStart;
            replacement = last.replacement.slice(0, at) + edit.replacement + last.replacement.slice(at);
          } else {
            replacement = last.replacement;
          }
        } else {
          replacement = last.replacement + edit.replacement;
        }
        merged[merged.length - 1] = {
          oldStart: Math.min(last.oldStart, edit.oldStart),
          oldEnd: combinedOldEnd,
          replacement,
          opIndex: last.opIndex,
        };
      } else {
        merged.push(edit);
      }
    }
    return merged;
  }

  /** Base source length. */
  baseLength(): number {
    return this.#baseLen;
  }
}

// ---------------------------------------------------------------------------
// Target resolution against one working document
// ---------------------------------------------------------------------------

/** Resolves one body path to a body entity index, or null (role failure → WrongRole). */
function resolveBody(document: HclDocument, path: HclBodyPath): number | null {
  let bodyIndex = document.root().index();
  for (const step of path.segments()) {
    const body = document.bodyEntity(bodyIndex);
    let matches = 0;
    let found: number | null = null;
    for (const itemIndex of body.items) {
      const entity = document.entity(itemIndex);
      if (entity.role !== 'Block') {
        return null; // A path step meets an attribute instead of a block.
      }
      if (
        entity.type === step.blockType() &&
        labelsEqual(entity.labels.map((label) => document.blockLabelEntity(label).text), step.labels())
      ) {
        if (matches === step.occurrence()) {
          found = itemIndex;
        }
        matches += 1;
      }
    }
    if (found === null) {
      return null;
    }
    bodyIndex = document.blockEntity(found).body;
  }
  return bodyIndex;
}

function labelsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

interface ResolvedAttribute {
  readonly entityIndex: number;
  readonly bodyIndex: number;
}

function resolveAttribute(document: HclDocument, body: HclBodyPath, name: string): ResolvedAttribute | null {
  const bodyIndex = resolveBody(document, body);
  if (bodyIndex === null) {
    return null;
  }
  for (const itemIndex of document.bodyEntity(bodyIndex).items) {
    const entity = document.entity(itemIndex);
    if (entity.role === 'Attribute' && entity.name === name) {
      return { entityIndex: itemIndex, bodyIndex };
    }
  }
  return null;
}

interface ResolvedBlock {
  readonly entityIndex: number;
  readonly bodyIndex: number;
}

function resolveBlock(
  document: HclDocument,
  body: HclBodyPath,
  blockType: string,
  labels: readonly string[],
  occurrence: number,
): ResolvedBlock | null {
  const bodyIndex = resolveBody(document, body);
  if (bodyIndex === null) {
    return null;
  }
  let matches = 0;
  for (const itemIndex of document.bodyEntity(bodyIndex).items) {
    const entity = document.entity(itemIndex);
    if (entity.role !== 'Block') {
      continue;
    }
    if (entity.type === blockType && labelsEqual(entity.labels.map((label) => document.blockLabelEntity(label).text), labels)) {
      if (matches === occurrence) {
        return { entityIndex: itemIndex, bodyIndex };
      }
      matches += 1;
    }
  }
  return null;
}

/** The end of one item's terminating line (after its newline, or at EOF). */
function itemLineEnd(document: HclDocument, span: Span): number {
  const pieces = document.losslessStructuralIndex().pieces();
  for (const piece of pieces) {
    const pieceSpan = piece.span();
    if (pieceSpan.startByte() >= span.endByte() && pieceSpan.startByte() <= document.source().len()) {
      if (piece.kind() === 'Trivia' && isNewlinePiece(document, pieceSpan)) {
        return pieceSpan.endByte();
      }
      return span.endByte();
    }
  }
  return span.endByte();
}

function isNewlinePiece(document: HclDocument, span: Span): boolean {
  const decoded = document.source().decodedText() ?? '';
  const text = decoded.slice(
    document.source().decodedPosition(span.startByte()).utf16CodeUnitOffset,
    document.source().decodedPosition(span.endByte()).utf16CodeUnitOffset,
  );
  return /^[\r\n]+$/.test(text);
}

/** The content start of one body (first item start, or the closing-brace position for an empty body). */
function bodyContentStart(document: HclDocument, bodyIndex: number): number {
  const body = document.bodyEntity(bodyIndex);
  if (body.items.length === 0) {
    // The body content end of an empty body: the closing brace position.
    const pieces = document.losslessStructuralIndex().pieces();
    for (const piece of pieces) {
      const pieceSpan = piece.span();
      if (pieceSpan.startByte() >= body.span.endByte()) {
        break;
      }
    }
    return body.span.endByte();
  }
  return document.entity(body.items[0]).span.startByte();
}

/** The insertion offset for one placement inside one body of the working document. */
function placementOffset(
  document: HclDocument,
  bodyIndex: number,
  placement: HclBodyPlacement,
): number {
  const body = document.bodyEntity(bodyIndex);
  switch (placement.kind) {
    case 'First':
      return bodyContentStart(document, bodyIndex);
    case 'Last': {
      if (body.items.length === 0) {
        return bodyContentStart(document, bodyIndex);
      }
      const lastIndex = body.items[body.items.length - 1];
      return itemLineEnd(document, document.entity(lastIndex).span);
    }
    case 'After': {
      const anchor = placement.anchor;
      if (anchor.kind === 'Attribute') {
        const resolved = resolveAttribute(document, anchor.body, anchor.name);
        if (resolved === null) {
          throw new HclEditFailure('IncompleteTarget');
        }
        return itemLineEnd(document, document.entity(resolved.entityIndex).span);
      }
      const resolved = resolveBlock(document, anchor.body, anchor.blockType, anchor.labels, anchor.occurrence);
      if (resolved === null) {
        throw new HclEditFailure('IncompleteTarget');
      }
      return itemLineEnd(document, document.entity(resolved.entityIndex).span);
    }
  }
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/** Atomically commits structural operations (edit.rs:641-660). */
export function commitHclEdits(
  document: HclDocument,
  transaction: HclEditTransaction,
  sourcePatchLimits: SourcePatchLimits = DEFAULT_SOURCE_PATCH_LIMITS,
): HclEditCommit {
  if (!transaction.baseSnapshot().equals(document.snapshotIdentity())) {
    throw new HclEditFailure('WrongSnapshot');
  }
  if (document.formationStatus() !== 'Complete') {
    throw new HclEditFailure('IncompleteTarget');
  }
  const profile = document.selector();
  const limits = document.parseLimits();
  if (transaction.operations().length > limits.maxReportEvents) {
    throw new HclEditFailure('ResourceLimit', { limitName: 'report-events' });
  }
  const baseBytes = document.render();
  const patchMap = new PatchMap(baseBytes.length);
  const diagnostics: Diagnostic[] = [];
  const mappings: NodeMapping[] = [];
  let working = baseBytes;

  for (let opIndex = 0; opIndex < transaction.operations().length; opIndex++) {
    const operation = transaction.operations()[opIndex];
    const workingDocument = parseWorking(working, document, limits);
    const prepared = prepareOperation(workingDocument, operation, profile, opIndex);
    if (prepared === null) {
      continue;
    }
    // The prepared spans are working-source coordinates; the patch map
    // converts them to base coordinates and folds overlaps.
    if (prepared.base.oldStart === prepared.base.oldEnd && prepared.base.replacement === '') {
      continue;
    }
    patchMap.apply(prepared.base.oldStart, prepared.base.oldEnd, prepared.base.replacement, opIndex);
    working = patchMap.workingBytes(baseBytes);
  }

  const folded = patchMap.folded();
  if (folded.length > sourcePatchLimits.maxReplacements) {
    throw new HclEditFailure('ResourceLimit', { limitName: 'patch-replacements' });
  }

  // Form the target document and verify the promised semantics (edit.rs:
  // "The replacement document could not be formed under the original
  // limits, or the reparsed target does not carry the promised semantics").
  let target: HclDocument;
  try {
    target = parseHcl(working, profile, profileDefaultEncoding(), limits);
  } catch {
    throw new HclEditFailure('NewDocumentFormationFailed');
  }
  if (target.formationStatus() !== 'Complete') {
    throw new HclEditFailure('NewDocumentFormationFailed');
  }

  // Build the ChangeSet with exact base- and target-coordinate spans. The
  // target span of each folded edit starts at the previous target end plus
  // the unchanged base gap between the two old spans.
  const sourceEdits: SourceEdit[] = [];
  let newCursor = 0;
  let previousOldEnd = 0;
  for (const edit of folded) {
    const newStart = newCursor + (edit.oldStart - previousOldEnd);
    const newEnd = newStart + edit.replacement.length;
    const oldSpan = new Span(document.snapshotIdentity(), edit.oldStart, edit.oldEnd);
    const newSpan = new Span(target.snapshotIdentity(), newStart, newEnd);
    sourceEdits.push(new SourceEdit(oldSpan, newSpan, new TextEncoder().encode(edit.replacement)));
    newCursor = newEnd;
    previousOldEnd = edit.oldEnd;
  }
  const changeSet = new ChangeSet(document.snapshotIdentity(), target.snapshotIdentity(), sourceEdits, mappings, diagnostics);
  const patch = SourcePatch.derive(document.source(), target.source(), changeSet, editMetadata(transaction), sourcePatchLimits);
  const untouchedProof = UntouchedByteProof.create(document.source(), target.source(), patch.replacements());
  return new HclEditCommit(target, changeSet, patch, untouchedProof);
}

/** Reparses the working bytes under the base profile and limits. */
function parseWorking(working: Uint8Array, base: HclDocument, limits: HclParseLimits): HclDocument {
  try {
    return parseHcl(working, base.selector(), profileDefaultEncoding(), limits);
  } catch {
    throw new HclEditFailure('NewDocumentFormationFailed');
  }
}

/** The `operation.{index}` metadata keys (edit.rs:2037-2126). */
function editMetadata(transaction: HclEditTransaction): ReadonlyMap<string, string> {
  const metadata = new Map<string, string>();
  transaction.operations().forEach((operation, index) => {
    metadata.set(`operation.${index}`, operationId(operation).toString());
  });
  return metadata;
}

/** The frozen operation id of one operation (edit.rs:2037-2042). */
export function operationId(operation: HclEditOperation): FormatOperationId {
  switch (operation.kind) {
    case 'SetAttributeValue':
      return new FormatOperationId('hcl.edit.set-attribute-value', 1);
    case 'InsertAttribute':
      return new FormatOperationId('hcl.edit.insert-attribute', 1);
    case 'RemoveAttribute':
      return new FormatOperationId('hcl.edit.remove-attribute', 1);
    case 'RenameAttribute':
      return new FormatOperationId('hcl.edit.rename-attribute', 1);
    case 'InsertBlock':
      return new FormatOperationId('hcl.edit.insert-block', 1);
    case 'RemoveBlock':
      return new FormatOperationId('hcl.edit.remove-block', 1);
  }
}

/** Prepares one operation against one working document (edit.rs:449-1062). */
function prepareOperation(
  document: HclDocument,
  operation: HclEditOperation,
  profile: HclProfile,
  opIndex: number,
): { base: { oldStart: number; oldEnd: number; replacement: string } } | null {
  void opIndex;
  const bodyIndex = (body: HclBodyPath): number => {
    const index = resolveBody(document, body);
    if (index === null) {
      throw new HclEditFailure('WrongRole');
    }
    return index;
  };
  switch (operation.kind) {
    case 'SetAttributeValue': {
      const resolved = resolveAttribute(document, operation.body, operation.attribute);
      if (resolved === null) {
        throw new HclEditFailure('IncompleteTarget');
      }
      const expressionIndex = document.attributeEntity(resolved.entityIndex).expression;
      const span = document.expressionEntity(expressionIndex).span;
      return {
        base: { oldStart: span.startByte(), oldEnd: span.endByte(), replacement: canonicalHclFragment(operation.value) },
      };
    }
    case 'InsertAttribute': {
      const targetBody = bodyIndex(operation.body);
      const body = document.bodyEntity(targetBody);
      if (body.items.some((itemIndex) => {
        const entity = document.entity(itemIndex);
        return entity.role === 'Attribute' && entity.name === operation.name;
      })) {
        throw new HclEditFailure('DuplicateAttribute');
      }
      const offset = placementOffset(document, targetBody, operation.placement);
      const replacement = `${operation.name} = ${canonicalHclFragment(operation.value)}\n`;
      return { base: { oldStart: offset, oldEnd: offset, replacement } };
    }
    case 'RemoveAttribute': {
      const resolved = resolveAttribute(document, operation.body, operation.attribute);
      if (resolved === null) {
        throw new HclEditFailure('IncompleteTarget');
      }
      const body = document.bodyEntity(resolved.bodyIndex);
      const ordinal = body.items.indexOf(resolved.entityIndex);
      const span = document.entity(resolved.entityIndex).span;
      // Remove the attribute's name, equals, expression, and owned trivia:
      // from the start of its line (or the previous line end) through its
      // terminating newline.
      const lineStart = previousLineStart(document, span.startByte());
      const lineEnd = itemLineEnd(document, span);
      void ordinal;
      return { base: { oldStart: lineStart, oldEnd: lineEnd, replacement: '' } };
    }
    case 'RenameAttribute': {
      const resolved = resolveAttribute(document, operation.body, operation.attribute);
      if (resolved === null) {
        throw new HclEditFailure('IncompleteTarget');
      }
      const body = document.bodyEntity(resolved.bodyIndex);
      if (body.items.some((itemIndex) => {
        const entity = document.entity(itemIndex);
        return itemIndex !== resolved.entityIndex && entity.role === 'Attribute' && entity.name === operation.name;
      })) {
        throw new HclEditFailure('DuplicateAttribute');
      }
      const nameSpan = document.attributeEntity(resolved.entityIndex).nameSpan;
      return { base: { oldStart: nameSpan.startByte(), oldEnd: nameSpan.endByte(), replacement: operation.name } };
    }
    case 'InsertBlock': {
      if (profile.isTfvars()) {
        throw new HclEditFailure('BlockInTfvars');
      }
      const targetBody = bodyIndex(operation.body);
      const offset = placementOffset(document, targetBody, operation.placement);
      let replacement = `${operation.blockType}`;
      for (const label of operation.labels) {
        replacement += ` ${quoteFragment(label)}`;
      }
      replacement += ' {\n';
      for (const [name, value] of operation.attributes) {
        replacement += `  ${name} = ${canonicalHclFragment(value)}\n`;
      }
      replacement += '}\n';
      return { base: { oldStart: offset, oldEnd: offset, replacement } };
    }
    case 'RemoveBlock': {
      const resolved = resolveBlock(document, operation.body, operation.blockType, operation.labels, operation.occurrence);
      if (resolved === null) {
        throw new HclEditFailure('IncompleteTarget');
      }
      const span = document.entity(resolved.entityIndex).span;
      const lineStart = previousLineStart(document, span.startByte());
      const lineEnd = itemLineEnd(document, span);
      return { base: { oldStart: lineStart, oldEnd: lineEnd, replacement: '' } };
    }
  }
}

/** The start of the line containing one byte offset (owned leading trivia). */
function previousLineStart(document: HclDocument, offset: number): number {
  const pieces = document.losslessStructuralIndex().pieces();
  let lineStart = 0;
  for (const piece of pieces) {
    const pieceSpan = piece.span();
    if (pieceSpan.endByte() > offset) {
      break;
    }
    if (piece.kind() === 'Trivia') {
      const decoded = document.source().decodedText() ?? '';
      const text = decoded.slice(
        document.source().decodedPosition(pieceSpan.startByte()).utf16CodeUnitOffset,
        document.source().decodedPosition(pieceSpan.endByte()).utf16CodeUnitOffset,
      );
      if (/[\r\n]/.test(text)) {
        lineStart = pieceSpan.endByte();
      }
    }
  }
  return lineStart;
}

// ---------------------------------------------------------------------------
// Dry-run EditPlan (RFC 0004 §14)
// ---------------------------------------------------------------------------

/** Fully validates and plans a transaction without returning a new Document (edit.rs:621-637). */
export function dryRunHclEdits(
  document: HclDocument,
  transaction: HclEditTransaction,
  sourceId: EditPlanSourceId,
): EditPlan {
  const commit = commitHclEdits(document, transaction);
  const summaries = transaction.operations().map((operation) => operationSummary(operation));
  return new EditPlan(
    sourceId,
    document.profile(),
    summaries,
    commit.sourcePatch(),
    commit.changeSet().diagnostics(),
  );
}

/** One safe, content-free summary of a declared edit operation (edit.rs:2046-2126). */
function operationSummary(operation: HclEditOperation): EditOperationSummary {
  const arguments_ = new Map<string, string>();
  switch (operation.kind) {
    case 'SetAttributeValue':
      arguments_.set('attribute', operation.attribute);
      arguments_.set('value_kind', hclEditValueKindName(operation.value));
      break;
    case 'InsertAttribute':
      arguments_.set('name', operation.name);
      arguments_.set('value_kind', hclEditValueKindName(operation.value));
      arguments_.set('placement', placementName(operation.placement));
      break;
    case 'RemoveAttribute':
      arguments_.set('attribute', operation.attribute);
      break;
    case 'RenameAttribute':
      arguments_.set('attribute', operation.attribute);
      arguments_.set('name', operation.name);
      break;
    case 'InsertBlock':
      arguments_.set('type', operation.blockType);
      arguments_.set('labels', String(operation.labels.length));
      arguments_.set('placement', placementName(operation.placement));
      break;
    case 'RemoveBlock':
      arguments_.set('type', operation.blockType);
      arguments_.set('labels', String(operation.labels.length));
      arguments_.set('occurrence', String(operation.occurrence));
      break;
  }
  return new EditOperationSummary(operationId(operation), arguments_);
}

function placementName(placement: HclBodyPlacement): string {
  switch (placement.kind) {
    case 'First':
      return 'First';
    case 'Last':
      return 'Last';
    case 'After':
      return 'After';
  }
}

// The placeholder below is replaced by a direct SourceReplacement import;
// see the note at the top of the source-patch construction in commitHclEdits.
