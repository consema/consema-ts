/**
 * Snapshot-bound plist structural edit (RFC 0013 §11).
 *
 * authority: crates/consema-plist/src/edit.rs
 *  - the six frozen operations :3-12 and operation ids :2153-2159
 *  - EditPathStep/EditPath :76-130 (DictKey with occurrence selector,
 *    ArrayIndex), DictPlacement :132-143, EditValue :145-185 (typed
 *    native facts, never raw markup), EditOperation :187-251,
 *    EditTransaction/Builder :253-374, EditCommit :376-387,
 *    EditFailure :389-455 (codes :442-454)
 *  - commit :457-575 (XML byte-level per operation with reparse;
 *    binary structural with offset-table/trailer regeneration)
 *  - splice machinery :578-746 (apply_step, unmap_in, map_in,
 *    record_edit — later operations may edit content an earlier
 *    operation inserted; the fold keeps the ChangeSet, patch, and
 *    proof self-consistent)
 *  - resolve_path :748-787
 *  - XML layout walk :789-1040 (arena ordinals equal close-tag order;
 *    per-entry key facts and entry starts), prepare_xml_operation
 *    :1042-1223 (set-value replaces the element span; insert-dict-entry
 *    at End/Before/After with self-closing wrap; remove-dict-entry owns
 *    the entry start through the value end; rename-dict-key replaces the
 *    key text or whole self-closing key; insert-array-element at
 *    index/end with self-closing wrap; remove-array-element owns the
 *    span between the neighbors), markup encoders :1225-1399
 *  - binary_step :1402-1568 (set-value rewrites the object's marker and
 *    payload; insert/remove rewrite the owning container's reference
 *    block, regenerate the offset table and trailer; fresh objects
 *    append; ref width grows when needed; shared references are
 *    preserved — rename binds a fresh key object so other dictionaries
 *    sharing the old key keep it byte-exact), binary_plan :1595-1762,
 *    encode_binary_value/string :1789-1851, sized marker :1859-1869
 *  - build_commit :1935-2033 (maximal non-overlapping base runs),
 *    mappings :2037-2108, patch limits :2111-2121, map_fatal :2124-2133,
 *    operation metadata/summaries :2136-2220
 *  - RFC 0013 §11 (:683-714): conflicts cover wrong profile/role/
 *    snapshot, missing or duplicate target, stale anchors, overlapping
 *    source ownership, non-string keys, UID insertion into an XML
 *    Document, unrepresentable values, limit failure, and reparse
 *    failure; success returns the new Document, ChangeSet,
 *    UntouchedByteProof, and a replayable SourcePatch
 *
 * Design (TypeScript-idiomatic): operations apply sequentially against
 * the evolving document state; every splice is recorded against the base
 * snapshot; commit merges the recorded base spans into maximal
 * non-overlapping runs whose replacements are the exact committed bytes.
 */

import {
  ChangeSet,
  EditOperationSummary,
  EditPlan,
  EditPlanSourceId,
  FormatOperationId,
  NodeMapping,
  SourceEdit,
  SourcePatch,
  UntouchedByteProof,
} from '../document/index.ts';
import type { NodeMappingStatus, SourcePatchLimits } from '../document/index.ts';
import { SourceSnapshot } from '../document/source.ts';
import type { SourceEncoding } from '../document/source.ts';
import { EditFailure } from './errors.ts';
import { FatalFormationFailure } from './errors.ts';
import { PlistDocument } from './document.ts';
import type { PlistParseLimits, PlistEncodingSelection } from './profile.ts';
import type { PlistSyntaxKind } from './syntax.ts';
import { parse } from './parser.ts';
import {
  PLIST_EPOCH_OFFSET_UNIX,
  PlistDocument as PlistNativeDocument,
  PlistReal,
  PlistValueRef,
} from './native.ts';
import type { PlistValueKind } from './native.ts';

// ---------------------------------------------------------------------------
// Paths, placements, and values
// ---------------------------------------------------------------------------

/** One root-relative path step (edit.rs:76-90). */
export type EditPathStep =
  | { readonly kind: 'DictKey'; readonly key: string; readonly occurrence: number }
  | { readonly kind: 'ArrayIndex'; readonly index: number };

/** A root-relative path to one value or container (edit.rs:91-130). */
export class EditPath {
  readonly #steps: readonly EditPathStep[];

  private constructor(steps: readonly EditPathStep[]) {
    this.#steps = Object.freeze([...steps]);
  }

  /** Root path. */
  static root(): EditPath {
    return new EditPath([]);
  }

  /** Creates a path from ordered steps. */
  static new(steps: readonly EditPathStep[]): EditPath {
    return new EditPath(steps);
  }

  /** Ordered path steps. */
  segments(): readonly EditPathStep[] {
    return this.#steps;
  }

  /** Creates a child path without modifying this path. */
  child(step: EditPathStep): EditPath {
    return new EditPath([...this.#steps, step]);
  }
}

/** Dictionary entry insertion placement inside one dictionary (edit.rs:132-143). */
export type DictPlacement =
  | { readonly kind: 'End' }
  | { readonly kind: 'Before'; readonly index: number }
  | { readonly kind: 'After'; readonly index: number };

/** One typed native plist value supplied to an edit (edit.rs:145-185). */
export type EditValue =
  | { readonly kind: 'String'; readonly text: string }
  | { readonly kind: 'Integer'; readonly value: bigint }
  | { readonly kind: 'Real'; readonly real: PlistReal }
  | { readonly kind: 'Boolean'; readonly value: boolean }
  | { readonly kind: 'Date'; readonly seconds: number }
  | { readonly kind: 'Data'; readonly bytes: Uint8Array }
  | { readonly kind: 'Uid'; readonly value: number };

/** Closed native kind of one edit value (edit.rs:171-185). */
export function editValueKind(value: EditValue): PlistValueKind {
  switch (value.kind) {
    case 'String':
      return 'String';
    case 'Integer':
      return 'Integer';
    case 'Real':
      return 'Real';
    case 'Boolean':
      return 'Boolean';
    case 'Date':
      return 'Date';
    case 'Data':
      return 'Data';
    case 'Uid':
      return 'Uid';
  }
}

/** One snapshot-bound plist structural operation (edit.rs:187-251). */
export type EditOperation =
  | { readonly op: 'SetValue'; readonly path: EditPath; readonly value: EditValue }
  | {
      readonly op: 'InsertDictEntry';
      readonly path: EditPath;
      readonly key: string;
      readonly value: EditValue;
      readonly placement: DictPlacement;
    }
  | {
      readonly op: 'RemoveDictEntry';
      readonly path: EditPath;
      readonly key: string;
      readonly occurrence: number;
    }
  | {
      readonly op: 'RenameDictKey';
      readonly path: EditPath;
      readonly from: string;
      readonly occurrence: number;
      readonly to: string;
    }
  | {
      readonly op: 'InsertArrayElement';
      readonly path: EditPath;
      readonly index: number;
      readonly value: EditValue;
    }
  | { readonly op: 'RemoveArrayElement'; readonly path: EditPath; readonly index: number };

/** Stable operation identifier of one operation (edit.rs:2151-2160). */
export function editOperationId(operation: EditOperation): string {
  switch (operation.op) {
    case 'SetValue':
      return 'plist.edit.set-value@1';
    case 'InsertDictEntry':
      return 'plist.edit.insert-dict-entry@1';
    case 'RemoveDictEntry':
      return 'plist.edit.remove-dict-entry@1';
    case 'RenameDictKey':
      return 'plist.edit.rename-dict-key@1';
    case 'InsertArrayElement':
      return 'plist.edit.insert-array-element@1';
    case 'RemoveArrayElement':
      return 'plist.edit.remove-array-element@1';
  }
}

/** Immutable snapshot-bound transaction (edit.rs:253-272). */
export class EditTransaction {
  readonly #base: ReturnType<PlistDocument['snapshotIdentity']>;
  readonly #operations: readonly EditOperation[];

  /** @internal — construction is via `EditTransactionBuilder.build`. */
  constructor(base: ReturnType<PlistDocument['snapshotIdentity']>, operations: readonly EditOperation[]) {
    this.#base = base;
    this.#operations = Object.freeze([...operations]);
  }

  /** Base snapshot identity. */
  baseSnapshot() {
    return this.#base;
  }

  /** Ordered operations. */
  operations(): readonly EditOperation[] {
    return this.#operations;
  }
}

/** Builds one transaction against one immutable snapshot (edit.rs:274-374). */
export class EditTransactionBuilder {
  readonly #base: ReturnType<PlistDocument['snapshotIdentity']>;
  readonly #operations: EditOperation[] = [];

  /** Creates a builder bound to one snapshot. */
  constructor(document: PlistDocument) {
    this.#base = document.snapshotIdentity();
  }

  /** Replaces one value. */
  setValue(path: EditPath, value: EditValue): EditTransactionBuilder {
    this.#operations.push({ op: 'SetValue', path, value });
    return this;
  }

  /** Inserts one dictionary association. */
  insertDictEntry(path: EditPath, key: string, value: EditValue, placement: DictPlacement): EditTransactionBuilder {
    this.#operations.push({ op: 'InsertDictEntry', path, key, value, placement });
    return this;
  }

  /** Removes one dictionary association. */
  removeDictEntry(path: EditPath, key: string, occurrence: number): EditTransactionBuilder {
    this.#operations.push({ op: 'RemoveDictEntry', path, key, occurrence });
    return this;
  }

  /** Renames one dictionary key, preserving its association value. */
  renameDictKey(path: EditPath, from: string, occurrence: number, to: string): EditTransactionBuilder {
    this.#operations.push({ op: 'RenameDictKey', path, from, occurrence, to });
    return this;
  }

  /** Inserts one array element before the current element at the index. */
  insertArrayElement(path: EditPath, index: number, value: EditValue): EditTransactionBuilder {
    this.#operations.push({ op: 'InsertArrayElement', path, index, value });
    return this;
  }

  /** Removes the array element at the given 0-based position. */
  removeArrayElement(path: EditPath, index: number): EditTransactionBuilder {
    this.#operations.push({ op: 'RemoveArrayElement', path, index });
    return this;
  }

  /** Closes the transaction. */
  build(): EditTransaction {
    return new EditTransaction(this.#base, this.#operations);
  }
}

/** One complete committed edit (edit.rs:376-387). */
export class EditCommit {
  readonly #document: PlistDocument;
  readonly #changeSet: ChangeSet;
  readonly #sourcePatch: SourcePatch;
  readonly #untouchedProof: UntouchedByteProof;

  constructor(document: PlistDocument, changeSet: ChangeSet, sourcePatch: SourcePatch, untouchedProof: UntouchedByteProof) {
    this.#document = document;
    this.#changeSet = changeSet;
    this.#sourcePatch = sourcePatch;
    this.#untouchedProof = untouchedProof;
  }

  /** New immutable document. */
  document(): PlistDocument {
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
// Splice machinery (edit.rs:578-746)
// ---------------------------------------------------------------------------

/** One applied raw-byte splice, recorded for base-coordinate translation. */
interface AppliedEdit {
  readonly preStart: number;
  readonly preLen: number;
  readonly replacement: Uint8Array;
  readonly structural: boolean;
}

function splice(preStart: number, preLen: number, replacement: Uint8Array): AppliedEdit {
  return { preStart, preLen, replacement, structural: false };
}

function structuralSplice(preStart: number, preLen: number, replacement: Uint8Array): AppliedEdit {
  return { preStart, preLen, replacement, structural: true };
}

/** Maps one position from the final state back to the base snapshot (edit.rs:627-644). */
function unmapIn(edits: readonly AppliedEdit[], pos: number): number {
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index];
    if (pos <= edit.preStart) {
      continue;
    }
    if (pos < edit.preStart + edit.replacement.length) {
      const baseStart = unmapIn(edits.slice(0, index), edit.preStart);
      return baseStart + (pos - edit.preStart);
    }
    pos = pos - edit.replacement.length + edit.preLen;
  }
  return pos;
}

/** Maps one position from one pre-state to the final state (edit.rs:648-659). */
function mapIn(edits: readonly AppliedEdit[], pos: number): number {
  for (const edit of edits) {
    if (pos <= edit.preStart) {
      continue;
    }
    if (pos < edit.preStart + edit.preLen) {
      throw new EditFailure('OverlappingOwnership');
    }
    pos = pos + edit.replacement.length - edit.preLen;
  }
  return pos;
}

/** Records one splice and rejects duplicate-target insertions (edit.rs:668-728). */
function recordEdit(edits: AppliedEdit[], preStart: number, preLen: number, replacement: Uint8Array, structural: boolean): void {
  if (preLen === 0 && replacement.length === 0) {
    return;
  }
  for (let index = edits.length - 1; index >= 0; index--) {
    if (edits[index].structural) {
      continue;
    }
    const regionStart = mapIn(edits.slice(index + 1), edits[index].preStart);
    const regionEnd = regionStart + edits[index].replacement.length;
    if (
      preStart >= regionStart &&
      preStart + preLen <= regionEnd &&
      !(preLen === 0 && preStart === regionEnd)
    ) {
      const offset = preStart - regionStart;
      const merged = new Uint8Array(edits[index].replacement.length - preLen + replacement.length);
      merged.set(edits[index].replacement.slice(0, offset), 0);
      merged.set(replacement, offset);
      merged.set(edits[index].replacement.slice(offset + preLen), offset + replacement.length);
      const delta = merged.length - edits[index].replacement.length;
      const targetStart = edits[index].preStart;
      for (let later = index + 1; later < edits.length; later++) {
        if (edits[later].preStart > targetStart) {
          edits[later] = { ...edits[later], preStart: shifted(edits[later].preStart, delta) };
        }
      }
      edits[index] = { ...edits[index], replacement: merged };
      return;
    }
  }
  const baseStart = unmapIn(edits, preStart);
  const baseEnd = unmapIn(edits, preStart + preLen);
  for (let index = 0; index < edits.length; index++) {
    const previous = edits[index];
    if (previous.preLen === 0 && baseStart === baseEnd) {
      const previousBase = unmapIn(edits.slice(0, index), previous.preStart);
      if (previousBase === baseStart) {
        throw new EditFailure('ConflictingEdits');
      }
    }
  }
  edits.push({ preStart, preLen, replacement, structural });
}

function shifted(base: number, delta: number): number {
  const result = delta >= 0 ? base + delta : base - Math.abs(delta);
  if (result < 0) {
    throw new EditFailure('ResourceLimit', { limitName: 'target-bytes' });
  }
  return result;
}

function addLengthDelta(delta: number, newLen: number, oldLen: number): number {
  const result = delta + (newLen - oldLen);
  if (!Number.isSafeInteger(result)) {
    throw new EditFailure('ResourceLimit', { limitName: 'target-bytes' });
  }
  return result;
}

/** Applies one step's splices against the working bytes (edit.rs:581-607). */
function applyStep(edits: AppliedEdit[], bytes: Uint8Array, limits: PlistParseLimits, splices: readonly AppliedEdit[]): Uint8Array {
  let targetLen = bytes.length;
  for (const item of splices) {
    targetLen = targetLen - item.preLen + item.replacement.length;
    if (!Number.isSafeInteger(targetLen) || targetLen < 0) {
      throw new EditFailure('ResourceLimit', { limitName: 'target-bytes' });
    }
  }
  if (targetLen > limits.common.maxSourceBytes) {
    throw new EditFailure('ResourceLimit', { limitName: 'target-bytes' });
  }
  for (const item of splices) {
    recordEdit(edits, item.preStart, item.preLen, item.replacement, item.structural);
  }
  let working = bytes;
  for (const item of splices) {
    const end = item.preStart + item.preLen;
    if (end > working.length) {
      throw new EditFailure('NewDocumentFormationFailed');
    }
    const next = new Uint8Array(working.length - item.preLen + item.replacement.length);
    next.set(working.slice(0, item.preStart), 0);
    next.set(item.replacement, item.preStart);
    next.set(working.slice(end), item.preStart + item.replacement.length);
    working = next;
  }
  return working;
}

// ---------------------------------------------------------------------------
// Path resolution (edit.rs:748-787)
// ---------------------------------------------------------------------------

/** Resolves one path against one native arena; the empty path is the root. */
function resolvePath(native: PlistNativeDocument, path: EditPath): PlistValueRef {
  let current = native.root();
  for (const step of path.segments()) {
    const node = native.get(current);
    if (node === null) {
      throw new EditFailure('TargetNotFound');
    }
    switch (step.kind) {
      case 'DictKey': {
        if (node.kind !== 'Dict') {
          throw new EditFailure('WrongRole');
        }
        const position = nthKeyPosition(node.entries, step.key, step.occurrence);
        current = PlistValueRef.fromIndex(node.entries[position].value);
        break;
      }
      case 'ArrayIndex': {
        if (node.kind !== 'Array') {
          throw new EditFailure('WrongRole');
        }
        if (step.index >= node.elements.length) {
          throw new EditFailure('TargetNotFound');
        }
        current = PlistValueRef.fromIndex(node.elements[step.index]);
        break;
      }
    }
  }
  return current;
}

/** Source position of the occurrence-th association with the given key. */
function nthKeyPosition(entries: readonly { readonly key: string; readonly value: number }[], key: string, occurrence: number): number {
  let seen = 0;
  for (let position = 0; position < entries.length; position++) {
    if (entries[position].key === key) {
      if (seen === occurrence) {
        return position;
      }
      seen += 1;
    }
  }
  throw new EditFailure('TargetNotFound');
}

// ---------------------------------------------------------------------------
// XML byte-level layout (edit.rs:789-1040)
// ---------------------------------------------------------------------------

/** One value element's byte facts, indexed by native arena ordinal. */
interface XmlNodeLayout {
  readonly span: { readonly start: number; readonly end: number };
  readonly selfClosing: boolean;
  readonly openEnd: number;
  readonly closeStart: number;
  readonly children: readonly number[];
  readonly keyText: readonly XmlKeyLayout[];
  readonly entryStarts: readonly number[];
}

/** One key element's byte facts of a dictionary entry. */
interface XmlKeyLayout {
  readonly text: { readonly start: number; readonly end: number };
  readonly element: { readonly start: number; readonly end: number };
  readonly selfClosing: boolean;
}

interface XmlFrame {
  readonly kind: PlistSyntaxKind;
  readonly openStart: number;
  openEnd: number;
  readonly children: number[];
  readonly keyText: XmlKeyLayout[];
  readonly entryStarts: number[];
  prevValueEnd: number;
  pendingKey: XmlKeyLayout | null;
}

/** Walks the lossless pieces and assigns every value element its byte span in arena ordinal order. */
function xmlLayout(document: PlistDocument): XmlNodeLayout[] {
  const pieces = document.losslessStructuralIndex()?.pieces();
  const kinds = document.losslessSyntaxKinds();
  if (pieces === undefined || kinds === null) {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  const source = document.source();
  const layouts: XmlNodeLayout[] = [];
  const stack: XmlFrame[] = [];
  let pendingKeyOpen: { readonly start: number; readonly end: number } | null = null;
  for (let index = 0; index < pieces.length; index++) {
    const start = pieces[index].span().startByte();
    const end = pieces[index].span().endByte();
    const kind = kinds[index];
    switch (kind) {
      case 'key-open': {
        if (pieceText(source, start, end) === '>') {
          if (pendingKeyOpen !== null) {
            pendingKeyOpen = { start: pendingKeyOpen.start, end };
          }
        } else {
          pendingKeyOpen = { start, end };
        }
        break;
      }
      case 'key-close': {
        const text = pieceText(source, start, end);
        const key: XmlKeyLayout = text.endsWith('/>')
          ? pendingKeyOpen !== null
            ? { text: { start: pendingKeyOpen.start, end }, element: { start: pendingKeyOpen.start, end }, selfClosing: true }
            : { text: { start, end }, element: { start, end }, selfClosing: true }
          : pendingKeyOpen !== null
            ? { text: { start: pendingKeyOpen.end, end: start }, element: { start: pendingKeyOpen.start, end }, selfClosing: false }
            : { text: { start, end }, element: { start, end }, selfClosing: true };
        pendingKeyOpen = null;
        const frame = stack[stack.length - 1];
        if (frame !== undefined) {
          frame.pendingKey = key;
        }
        break;
      }
      case 'dict-open':
      case 'array-open':
      case 'string-open':
      case 'integer-open':
      case 'real-open':
      case 'date-open':
      case 'data-open': {
        if (pieceText(source, start, end) === '>') {
          const frame = stack[stack.length - 1];
          if (frame !== undefined) {
            frame.openEnd = end;
            frame.prevValueEnd = end;
          }
        } else {
          stack.push({
            kind,
            openStart: start,
            openEnd: end,
            children: [],
            keyText: [],
            entryStarts: [],
            prevValueEnd: end,
            pendingKey: null,
          });
        }
        break;
      }
      case 'dict-close':
      case 'array-close':
      case 'string-close':
      case 'integer-close':
      case 'real-close':
      case 'date-close':
      case 'data-close': {
        const text = pieceText(source, start, end);
        if (text.endsWith('/>')) {
          const frame = stack.pop();
          if (frame === undefined) {
            throw new EditFailure('NewDocumentFormationFailed');
          }
          finalizeXmlFrame(stack, layouts, frame, end, end, true);
        } else if (stack.length > 0 && stack[stack.length - 1].kind === openKindFor(kind)) {
          const frame = stack.pop()!;
          finalizeXmlFrame(stack, layouts, frame, start, end, false);
        } else {
          throw new EditFailure('NewDocumentFormationFailed');
        }
        break;
      }
      case 'true':
      case 'false': {
        const text = pieceText(source, start, end);
        if (text === '>') {
          const frame = stack[stack.length - 1];
          if (frame !== undefined) {
            frame.openEnd = end;
            frame.prevValueEnd = end;
          }
        } else if (text.startsWith('</')) {
          const frame = stack.pop();
          if (frame === undefined) {
            throw new EditFailure('NewDocumentFormationFailed');
          }
          finalizeXmlFrame(stack, layouts, frame, start, end, false);
        } else if (text.endsWith('/>')) {
          const frame = stack.pop();
          if (frame === undefined) {
            throw new EditFailure('NewDocumentFormationFailed');
          }
          finalizeXmlFrame(stack, layouts, frame, end, end, true);
        } else {
          stack.push({
            kind,
            openStart: start,
            openEnd: end,
            children: [],
            keyText: [],
            entryStarts: [],
            prevValueEnd: end,
            pendingKey: null,
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return layouts;
}

function openKindFor(close: PlistSyntaxKind): PlistSyntaxKind {
  switch (close) {
    case 'dict-close':
      return 'dict-open';
    case 'array-close':
      return 'array-open';
    case 'string-close':
      return 'string-open';
    case 'integer-close':
      return 'integer-open';
    case 'real-close':
      return 'real-open';
    case 'date-close':
      return 'date-open';
    case 'data-close':
      return 'data-open';
    default:
      return 'error-region';
  }
}

/** Assigns the next arena ordinal to one closed frame and updates its parent dictionary. */
function finalizeXmlFrame(
  stack: XmlFrame[],
  layouts: XmlNodeLayout[],
  frame: XmlFrame,
  closeStart: number,
  closeEnd: number,
  selfClosing: boolean,
): void {
  const ordinal = layouts.length;
  const parent = stack[stack.length - 1];
  if (parent !== undefined) {
    if (parent.kind === 'dict-open') {
      const key = parent.pendingKey;
      if (key !== null) {
        parent.keyText.push(key);
        parent.entryStarts.push(parent.prevValueEnd);
      }
      parent.pendingKey = null;
    }
    parent.children.push(ordinal);
    parent.prevValueEnd = closeEnd;
  }
  layouts.push({
    span: { start: frame.openStart, end: closeEnd },
    selfClosing,
    openEnd: frame.openEnd,
    closeStart,
    children: frame.children,
    keyText: frame.keyText,
    entryStarts: frame.entryStarts,
  });
}

/** Decoded text of one piece span. */
function pieceText(source: SourceSnapshot, start: number, end: number): string {
  const text = source.decodedText();
  if (text === null) {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  const startDecoded = source.decodedPosition(start).decodedUtf8Byte;
  const endDecoded = source.decodedPosition(end).decodedUtf8Byte;
  return new TextDecoder().decode(new TextEncoder().encode(text).slice(startDecoded, endDecoded));
}

// ---------------------------------------------------------------------------
// XML markup encoders (edit.rs:1225-1399)
// ---------------------------------------------------------------------------

/** Encodes one decoded string under the source encoding. */
function encodeText(text: string, encoding: SourceEncoding): Uint8Array {
  switch (encoding.kind) {
    case 'Utf16Le': {
      const bytes = new Uint8Array(text.length * 2);
      for (let index = 0; index < text.length; index++) {
        bytes[index * 2] = text.charCodeAt(index) & 0xff;
        bytes[index * 2 + 1] = text.charCodeAt(index) >> 8;
      }
      return bytes;
    }
    case 'Utf16Be': {
      const bytes = new Uint8Array(text.length * 2);
      for (let index = 0; index < text.length; index++) {
        bytes[index * 2] = text.charCodeAt(index) >> 8;
        bytes[index * 2 + 1] = text.charCodeAt(index) & 0xff;
      }
      return bytes;
    }
    default:
      return new TextEncoder().encode(text);
  }
}

/** Escapes XML text content (RFC 0013 §4.9). */
function escapeXmlText(text: string): string {
  let out = '';
  for (const character of text) {
    switch (character) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '\r':
        out += '&#13;';
        break;
      default:
        out += character;
        break;
    }
  }
  return out;
}

/** One value element written as markup (edit.rs:1257-1308). */
function encodeXmlElement(value: EditValue, encoding: SourceEncoding): Uint8Array {
  let text = '';
  switch (value.kind) {
    case 'String':
      text += '<string>';
      text += escapeXmlText(value.text);
      text += '</string>';
      break;
    case 'Integer':
      text += `<integer>${value.value}</integer>`;
      break;
    case 'Real':
      text += `<real>${renderReal(value.real)}</real>`;
      break;
    case 'Boolean':
      text += value.value ? '<true/>' : '<false/>';
      break;
    case 'Date': {
      const fields = wholeSecondDate(value.seconds);
      if (fields === null) {
        throw new EditFailure('UnrepresentableValue', { reason: 'fractional-seconds' });
      }
      text += `<date>${renderDate(fields)}</date>`;
      break;
    }
    case 'Data':
      text += '<data>';
      text += encodeBase64(value.bytes);
      text += '</data>';
      break;
    case 'Uid':
      throw new EditFailure('UidInXml');
  }
  return encodeText(text, encoding);
}

/** One key element written as markup (edit.rs:1310-1321). */
function encodeXmlKey(key: string, encoding: SourceEncoding): Uint8Array {
  return encodeText(`<key>${escapeXmlText(key)}</key>`, encoding);
}

/** Escaped key content only (edit.rs:1323-1333). */
function encodeKeyText(key: string, encoding: SourceEncoding): Uint8Array {
  return encodeText(escapeXmlText(key), encoding);
}

/** `<key>..</key>` plus one value element (edit.rs:1246-1255). */
function entryMarkup(key: string, value: EditValue, encoding: SourceEncoding): Uint8Array {
  const keyBytes = encodeXmlKey(key, encoding);
  const valueBytes = encodeXmlElement(value, encoding);
  const out = new Uint8Array(keyBytes.length + valueBytes.length);
  out.set(keyBytes, 0);
  out.set(valueBytes, keyBytes.length);
  return out;
}

/** Validates one typed value for the XML representation (edit.rs:1352-1377). */
function checkXmlValue(value: EditValue): void {
  switch (value.kind) {
    case 'String':
      if (classifySurrogates(value.text) === 'UnpairedSurrogate' || !isXmlText(value.text)) {
        throw new EditFailure('UnrepresentableValue', { reason: 'unpaired-surrogate' });
      }
      break;
    case 'Real':
      if (value.real.width() === 'Float32') {
        throw new EditFailure('UnrepresentableValue', { reason: 'float32-width' });
      }
      if (!realExpressible(value.real)) {
        throw new EditFailure('UnrepresentableValue', { reason: 'real-nan-payload' });
      }
      break;
    case 'Date':
      if (wholeSecondDate(value.seconds) === null) {
        throw new EditFailure('UnrepresentableValue', { reason: 'fractional-seconds' });
      }
      break;
    case 'Uid':
      throw new EditFailure('UidInXml');
    default:
      break;
  }
}

/** Validates one key content for the XML representation (edit.rs:1379-1388). */
function checkXmlKey(key: string): void {
  if (classifySurrogates(key) === 'UnpairedSurrogate' || !isXmlText(key)) {
    throw new EditFailure('UnrepresentableValue', { reason: 'unpaired-surrogate' });
  }
}

function classifySurrogates(text: string): 'WellFormedUnicode' | 'UnpairedSurrogate' {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        index += 1;
      } else {
        return 'UnpairedSurrogate';
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return 'UnpairedSurrogate';
    }
  }
  return 'WellFormedUnicode';
}

function isXmlText(text: string): boolean {
  return classifySurrogates(text) === 'WellFormedUnicode' && [...text].every((c) => isXmlCharCode(c.codePointAt(0)!));
}

function isXmlCharCode(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

function renderReal(real: PlistReal): string {
  const value = real.asF64();
  if (Number.isNaN(value)) {
    return 'nan';
  }
  if (!Number.isFinite(value)) {
    return Object.is(value, -Infinity) ? '-inf' : 'inf';
  }
  return String(value);
}

function realExpressible(real: PlistReal): boolean {
  const value = real.asF64();
  if (Number.isNaN(value)) {
    return bitsOfFloat64(value) === bitsOfFloat64(Number.NaN);
  }
  if (!Number.isFinite(value)) {
    return true;
  }
  return bitsOfFloat64(Number(value.toString())) === bitsOfFloat64(value);
}

/** Whole-second decomposition; `null` when the value cannot be expressed by the XML calendar grammar. */
function wholeSecondDate(seconds: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
  if (seconds % 1 !== 0) {
    return null;
  }
  const unix = seconds + PLIST_EPOCH_OFFSET_UNIX;
  if (Math.abs(unix) >= 9_007_199_254_740_992) {
    return null;
  }
  const unixInt = Math.trunc(unix);
  const days = Math.floor(unixInt / 86400);
  const secondsOfDay = unixInt % 86400;
  const civil = civilFromDays(days);
  if (Math.abs(civil.year) > 0xffffffff) {
    return null;
  }
  return {
    year: civil.year,
    month: civil.month,
    day: civil.day,
    hour: Math.floor(secondsOfDay / 3600),
    minute: Math.floor((secondsOfDay % 3600) / 60),
    second: secondsOfDay % 60,
  };
}

function civilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = z >= 0 ? z : z - 146096;
  const eraFloor = Math.floor(era / 146097);
  const dayOfEra = z - eraFloor * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  let year = yearOfEra + eraFloor * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  year = month <= 2 ? year + 1 : year;
  return { year, month, day };
}

function renderDate(fields: { year: number; month: number; day: number; hour: number; minute: number; second: number }): string {
  const sign = fields.year < 0 ? '-' : '';
  const year = Math.abs(fields.year).toString().padStart(4, '0');
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${sign}${year}-${pad(fields.month)}-${pad(fields.day)}T${pad(fields.hour)}:${pad(fields.minute)}:${pad(fields.second)}Z`;
}

/** Unwrapped standard-alphabet base64 with exact `=` padding (edit.rs:1298-1302). */
function encodeBase64(bytes: Uint8Array): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let at = 0; at < bytes.length; at += 3) {
    const first = bytes[at];
    const second = at + 1 < bytes.length ? bytes[at + 1] : 0;
    const third = at + 2 < bytes.length ? bytes[at + 2] : 0;
    out += ALPHABET[first >> 2];
    out += ALPHABET[((first & 0x03) << 4) | (second >> 4)];
    out += at + 1 < bytes.length ? ALPHABET[((second & 0x0f) << 2) | (third >> 6)] : '=';
    out += at + 2 < bytes.length ? ALPHABET[third & 0x3f] : '=';
  }
  return out;
}

function bitsOfFloat64(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}

// ---------------------------------------------------------------------------
// XML operations (edit.rs:1042-1223)
// ---------------------------------------------------------------------------

/** Prepares one XML operation's splices against the current formed state. */
function prepareXmlOperation(
  document: PlistDocument,
  native: PlistNativeDocument,
  layout: readonly XmlNodeLayout[],
  operation: EditOperation,
  encoding: SourceEncoding,
): AppliedEdit[] {
  switch (operation.op) {
    case 'SetValue': {
      checkXmlValue(operation.value);
      const node = resolvePath(native, operation.path);
      const nodeLayout = layout[node.index()];
      return [
        splice(
          nodeLayout.span.start,
          nodeLayout.span.end - nodeLayout.span.start,
          encodeXmlElement(operation.value, encoding),
        ),
      ];
    }
    case 'InsertDictEntry': {
      checkXmlKey(operation.key);
      checkXmlValue(operation.value);
      const dict = resolvePath(native, operation.path);
      const dictNode = native.get(dict);
      if (dictNode?.kind !== 'Dict') {
        throw new EditFailure('WrongRole');
      }
      const dictLayout = layout[dict.index()];
      const count = dictLayout.children.length;
      let insertAt: number;
      let oldLen: number;
      let markup: Uint8Array;
      if (operation.placement.kind === 'End') {
        if (dictLayout.selfClosing) {
          const entry = entryMarkup(operation.key, operation.value, encoding);
          const replacement = concatBytes(new TextEncoder().encode('<dict>'), entry, new TextEncoder().encode('</dict>'));
          insertAt = dictLayout.span.start;
          oldLen = dictLayout.span.end - dictLayout.span.start;
          markup = replacement;
        } else {
          insertAt = dictLayout.closeStart;
          oldLen = 0;
          markup = entryMarkup(operation.key, operation.value, encoding);
        }
      } else if (operation.placement.kind === 'Before') {
        if (operation.placement.index >= count) {
          throw new EditFailure('TargetNotFound');
        }
        insertAt = dictLayout.entryStarts[operation.placement.index];
        oldLen = 0;
        markup = entryMarkup(operation.key, operation.value, encoding);
      } else {
        if (operation.placement.index >= count) {
          throw new EditFailure('TargetNotFound');
        }
        insertAt = layout[dictLayout.children[operation.placement.index]].span.end;
        oldLen = 0;
        markup = entryMarkup(operation.key, operation.value, encoding);
      }
      return [splice(insertAt, oldLen, markup)];
    }
    case 'RemoveDictEntry': {
      const dict = resolvePath(native, operation.path);
      const dictNode = native.get(dict);
      if (dictNode?.kind !== 'Dict') {
        throw new EditFailure('WrongRole');
      }
      const dictLayout = layout[dict.index()];
      const position = nthKeyPosition(dictNode.entries, operation.key, operation.occurrence);
      const spanStart = dictLayout.entryStarts[position];
      const spanEnd = layout[dictLayout.children[position]].span.end;
      return [splice(spanStart, spanEnd - spanStart, new Uint8Array(0))];
    }
    case 'RenameDictKey': {
      checkXmlKey(operation.to);
      const dict = resolvePath(native, operation.path);
      const dictNode = native.get(dict);
      if (dictNode?.kind !== 'Dict') {
        throw new EditFailure('WrongRole');
      }
      const dictLayout = layout[dict.index()];
      const position = nthKeyPosition(dictNode.entries, operation.from, operation.occurrence);
      const keyLayout = dictLayout.keyText[position];
      const oldStart = keyLayout.selfClosing ? keyLayout.element.start : keyLayout.text.start;
      const oldLen = keyLayout.selfClosing
        ? keyLayout.element.end - keyLayout.element.start
        : keyLayout.text.end - keyLayout.text.start;
      const replacement = keyLayout.selfClosing
        ? encodeXmlKey(operation.to, encoding)
        : encodeKeyText(operation.to, encoding);
      return [splice(oldStart, oldLen, replacement)];
    }
    case 'InsertArrayElement': {
      checkXmlValue(operation.value);
      const array = resolvePath(native, operation.path);
      const arrayNode = native.get(array);
      if (arrayNode?.kind !== 'Array') {
        throw new EditFailure('WrongRole');
      }
      const arrayLayout = layout[array.index()];
      const count = arrayLayout.children.length;
      if (operation.index > count) {
        throw new EditFailure('TargetNotFound');
      }
      const markup = encodeXmlElement(operation.value, encoding);
      let insertAt: number;
      let oldLen: number;
      let replacement: Uint8Array;
      if (operation.index === count) {
        if (arrayLayout.selfClosing) {
          replacement = concatBytes(new TextEncoder().encode('<array>'), markup, new TextEncoder().encode('</array>'));
          insertAt = arrayLayout.span.start;
          oldLen = arrayLayout.span.end - arrayLayout.span.start;
        } else {
          insertAt = arrayLayout.closeStart;
          oldLen = 0;
          replacement = markup;
        }
      } else if (operation.index === 0) {
        insertAt = arrayLayout.openEnd;
        oldLen = 0;
        replacement = markup;
      } else {
        insertAt = layout[arrayLayout.children[operation.index]].span.start;
        oldLen = 0;
        replacement = markup;
      }
      return [splice(insertAt, oldLen, replacement)];
    }
    case 'RemoveArrayElement': {
      const array = resolvePath(native, operation.path);
      const arrayNode = native.get(array);
      if (arrayNode?.kind !== 'Array') {
        throw new EditFailure('WrongRole');
      }
      const arrayLayout = layout[array.index()];
      const count = arrayLayout.children.length;
      if (operation.index >= count) {
        throw new EditFailure('TargetNotFound');
      }
      const spanStart =
        operation.index === 0
          ? arrayLayout.openEnd
          : layout[arrayLayout.children[operation.index - 1]].span.end;
      const spanEnd = layout[arrayLayout.children[operation.index]].span.end;
      return [splice(spanStart, spanEnd - spanStart, new Uint8Array(0))];
    }
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Binary structural operations (edit.rs:1402-1927)
// ---------------------------------------------------------------------------

interface BinaryPlan {
  readonly refs: Array<number[]>;
  readonly appended: Uint8Array[];
  readonly scalarReplaces: Map<number, Uint8Array>;
  readonly containerTouched: number[];
}

/** Computes one binary operation's structural changes against the current formed state. */
function binaryPlan(native: PlistNativeDocument, facts: NonNullable<ReturnType<PlistDocument['binaryFacts']>>, operation: EditOperation): BinaryPlan {
  const nodeCount = native.nodeCount();
  const dictCounts: number[] = [];
  for (let index = 0; index < nodeCount; index++) {
    const node = native.get(PlistValueRef.fromIndex(index));
    dictCounts.push(node?.kind === 'Dict' ? node.entries.length : 0);
  }
  const keyRefs: Array<number[]> = Array.from({ length: nodeCount }, () => []);
  for (const reference of facts.refs()) {
    if (reference.position() < dictCounts[reference.owner()]) {
      keyRefs[reference.owner()].push(reference.target());
    }
  }
  const refs: Array<number[]> = Array.from({ length: nodeCount }, () => []);
  for (let index = 0; index < nodeCount; index++) {
    const node = native.get(PlistValueRef.fromIndex(index));
    if (node?.kind === 'Dict') {
      refs[index] = [...keyRefs[index]];
      for (const entry of node.entries) {
        refs[index].push(entry.value);
      }
    } else if (node?.kind === 'Array') {
      refs[index] = [...node.elements];
    }
  }
  switch (operation.op) {
    case 'SetValue': {
      const target = resolvePath(native, operation.path);
      const scalarReplaces = new Map<number, Uint8Array>();
      scalarReplaces.set(target.index(), encodeBinaryValue(operation.value));
      return { refs, appended: [], scalarReplaces, containerTouched: [] };
    }
    case 'InsertDictEntry': {
      const dict = resolvePath(native, operation.path);
      const dictNode = native.get(dict);
      if (dictNode?.kind !== 'Dict') {
        throw new EditFailure('WrongRole');
      }
      const count = dictNode.entries.length;
      let position: number;
      if (operation.placement.kind === 'End') {
        position = count;
      } else if (operation.placement.kind === 'Before' && operation.placement.index < count) {
        position = operation.placement.index;
      } else if (operation.placement.kind === 'After' && operation.placement.index < count) {
        position = operation.placement.index + 1;
      } else {
        throw new EditFailure('TargetNotFound');
      }
      const keyBytes = encodeBinaryString(operation.key);
      const valueBytes = encodeBinaryValue(operation.value);
      const keyIndex = nodeCount;
      const valueIndex = nodeCount + 1;
      const dictRefs = refs[dict.index()];
      dictRefs.splice(position, 0, keyIndex);
      dictRefs.splice(count + 1 + position, 0, valueIndex);
      return { refs, appended: [keyBytes, valueBytes], scalarReplaces: new Map(), containerTouched: [dict.index()] };
    }
    case 'RemoveDictEntry': {
      const dict = resolvePath(native, operation.path);
      const dictNode = native.get(dict);
      if (dictNode?.kind !== 'Dict') {
        throw new EditFailure('WrongRole');
      }
      const position = nthKeyPosition(dictNode.entries, operation.key, operation.occurrence);
      const count = dictNode.entries.length;
      const dictRefs = refs[dict.index()];
      dictRefs.splice(position, 1);
      dictRefs.splice(count - 1 + position, 1);
      return { refs, appended: [], scalarReplaces: new Map(), containerTouched: [dict.index()] };
    }
    case 'RenameDictKey': {
      const dict = resolvePath(native, operation.path);
      const dictNode = native.get(dict);
      if (dictNode?.kind !== 'Dict') {
        throw new EditFailure('WrongRole');
      }
      const position = nthKeyPosition(dictNode.entries, operation.from, operation.occurrence);
      const newKeyIndex = nodeCount;
      refs[dict.index()][position] = newKeyIndex;
      return { refs, appended: [encodeBinaryString(operation.to)], scalarReplaces: new Map(), containerTouched: [dict.index()] };
    }
    case 'InsertArrayElement': {
      const array = resolvePath(native, operation.path);
      const arrayNode = native.get(array);
      if (arrayNode?.kind !== 'Array') {
        throw new EditFailure('WrongRole');
      }
      const count = arrayNode.elements.length;
      if (operation.index > count) {
        throw new EditFailure('TargetNotFound');
      }
      const valueIndex = nodeCount;
      refs[array.index()].splice(operation.index, 0, valueIndex);
      return { refs, appended: [encodeBinaryValue(operation.value)], scalarReplaces: new Map(), containerTouched: [array.index()] };
    }
    case 'RemoveArrayElement': {
      const array = resolvePath(native, operation.path);
      const arrayNode = native.get(array);
      if (arrayNode?.kind !== 'Array') {
        throw new EditFailure('WrongRole');
      }
      const count = arrayNode.elements.length;
      if (operation.index >= count) {
        throw new EditFailure('TargetNotFound');
      }
      refs[array.index()].splice(operation.index, 1);
      return { refs, appended: [], scalarReplaces: new Map(), containerTouched: [array.index()] };
    }
  }
}

function containerIsDict(native: PlistNativeDocument, index: number): boolean {
  return native.get(PlistValueRef.fromIndex(index))?.kind === 'Dict';
}

/** Encodes one container object (edit.rs:1772-1787). */
function encodeContainer(refs: readonly number[], isDict: boolean, refSize: number): Uint8Array {
  const count = isDict ? refs.length / 2 : refs.length;
  const parts: Uint8Array[] = [sizedMarkerBytes(isDict ? 0xd0 : 0xa0, count)];
  for (const target of refs) {
    parts.push(beBytes(BigInt(target), refSize));
  }
  return concatBytes(...parts);
}

/** Encodes one typed value as a binary object (edit.rs:1789-1832). */
function encodeBinaryValue(value: EditValue): Uint8Array {
  switch (value.kind) {
    case 'String':
      return encodeBinaryString(value.text);
    case 'Integer': {
      const width = integerWidth(value.value);
      const parts: Uint8Array[] = [new Uint8Array([0x10 | widthTrailingZeros(width)])];
      parts.push(beBytes(value.value & 0xffffffffffffffffn, width));
      return concatBytes(...parts);
    }
    case 'Real': {
      if (value.real.width() === 'Float64') {
        return concatBytes(new Uint8Array([0x23]), beBytes(value.real.bits(), 8));
      }
      return concatBytes(new Uint8Array([0x22]), beBytes(value.real.bits(), 4));
    }
    case 'Boolean':
      return new Uint8Array([value.value ? 0x09 : 0x08]);
    case 'Date':
      return concatBytes(new Uint8Array([0x33]), beBytes(bitsOfFloat64(value.seconds), 8));
    case 'Data':
      return concatBytes(sizedMarkerBytes(0x40, value.bytes.length), value.bytes);
    case 'Uid': {
      const width = uidWidth(value.value);
      return concatBytes(new Uint8Array([0x80 | (width - 1)]), beBytes(BigInt(value.value), width));
    }
  }
}

/** Encodes one string object (edit.rs:1836-1851). */
function encodeBinaryString(text: string): Uint8Array {
  const ascii = [...text].every((c) => c.charCodeAt(0) < 0x80);
  const parts: Uint8Array[] = [sizedMarkerBytes(ascii ? 0x50 : 0x60, text.length)];
  if (ascii) {
    parts.push(new TextEncoder().encode(text));
  } else {
    const bytes = new Uint8Array(text.length * 2);
    for (let index = 0; index < text.length; index++) {
      bytes[index * 2] = text.charCodeAt(index) >> 8;
      bytes[index * 2 + 1] = text.charCodeAt(index) & 0xff;
    }
    parts.push(bytes);
  }
  return concatBytes(...parts);
}

function sizedMarkerBytes(marker: number, count: number): Uint8Array {
  if (count < 0x0f) {
    return new Uint8Array([marker | count]);
  }
  const width = unsignedWidth(BigInt(count));
  return concatBytes(new Uint8Array([marker | 0x0f, 0x10 | widthTrailingZeros(width)]), beBytes(BigInt(count), width));
}

function beBytes(value: bigint, width: number): Uint8Array {
  const bytes = new Uint8Array(width);
  for (let shift = 0; shift < width; shift++) {
    bytes[width - 1 - shift] = Number((value >> BigInt(8 * shift)) & 0xffn);
  }
  return bytes;
}

function refWidthFor(maxIndex: number): number {
  let size = 1;
  let capacity = 256;
  while (maxIndex >= capacity && size < 8) {
    size += 1;
    capacity *= 256;
  }
  return size;
}

function integerWidth(value: bigint): number {
  return value >= 0n ? unsignedWidth(value) : 8;
}

function unsignedWidth(value: bigint): number {
  if (value <= 0xffn) return 1;
  if (value <= 0xffffn) return 2;
  if (value <= 0xffffffffn) return 4;
  return 8;
}

function uidWidth(value: number): number {
  if (value <= 0xff) return 1;
  if (value <= 0xffff) return 2;
  if (value <= 0xffffff) return 3;
  return 4;
}

function widthTrailingZeros(width: number): number {
  switch (width) {
    case 1:
      return 0;
    case 2:
      return 1;
    case 4:
      return 2;
    default:
      return 3;
  }
}

/** Computes one binary operation's structural splices (edit.rs:1422-1568). */
function binaryStep(
  document: PlistDocument,
  native: PlistNativeDocument,
  facts: NonNullable<ReturnType<PlistDocument['binaryFacts']>>,
  operation: EditOperation,
  limits: PlistParseLimits,
): AppliedEdit[] {
  const plan = binaryPlan(native, facts, operation);
  const nodeCount = native.nodeCount();
  const newObjectCount = nodeCount + plan.appended.length;
  if (newObjectCount > limits.maxObjectCount) {
    throw new EditFailure('ResourceLimit', { limitName: 'object-count' });
  }
  const currentRefSize = facts.trailer().objectRefSize();
  const newRefSize = refWidthFor(newObjectCount);
  if (newRefSize > limits.maxObjectRefSize) {
    throw new EditFailure('ResourceLimit', { limitName: 'object-ref-size' });
  }
  const replacements = new Map<number, Uint8Array>(plan.scalarReplaces);
  for (const index of plan.containerTouched) {
    replacements.set(index, encodeContainer(plan.refs[index], containerIsDict(native, index), newRefSize));
  }
  if (newRefSize !== currentRefSize) {
    for (let index = 0; index < nodeCount; index++) {
      if (containerIsDict(native, index) || native.get(PlistValueRef.fromIndex(index))?.kind === 'Array') {
        replacements.set(index, encodeContainer(plan.refs[index], containerIsDict(native, index), newRefSize));
      }
    }
  }

  const newLens: number[] = [];
  for (let index = 0; index < nodeCount; index++) {
    newLens.push(facts.objects()[index].span().len());
  }
  const splices: AppliedEdit[] = [];
  let delta = 0;
  const sortedReplacements = [...replacements.entries()].sort(([left], [right]) => left - right);
  for (const [index, bytes] of sortedReplacements) {
    const span = facts.objects()[index].span();
    newLens[index] = bytes.length;
    const preStart = shifted(span.startByte(), delta);
    splices.push(splice(preStart, span.len(), bytes));
    delta = addLengthDelta(delta, bytes.length, span.len());
  }
  const objectAreaEnd = Number(facts.trailer().offsetTableOffset());
  let appendedBytes: Uint8Array = new Uint8Array(0);
  for (const bytes of plan.appended) {
    appendedBytes = concatBytes(appendedBytes, bytes);
  }
  if (appendedBytes.length > 0) {
    const preStart = shifted(objectAreaEnd, delta);
    splices.push(splice(preStart, 0, appendedBytes));
    delta = addLengthDelta(delta, appendedBytes.length, 0);
  }

  const newOffsets: number[] = [];
  let cursor = 8;
  for (const length of newLens) {
    newOffsets.push(cursor);
    cursor += length;
  }
  for (const bytes of plan.appended) {
    newOffsets.push(cursor);
    cursor += bytes.length;
  }
  const newTableOffset = cursor;

  const oldTableStart = shifted(objectAreaEnd, delta);
  const oldTableBytes = Number(facts.trailer().numObjects()) * facts.trailer().offsetIntSize();
  const offsetIntSize = refWidthFor(newTableOffset);
  if (offsetIntSize > limits.maxOffsetIntSize) {
    throw new EditFailure('ResourceLimit', { limitName: 'offset-int-size' });
  }
  const tableBytes = newObjectCount * offsetIntSize;
  if (tableBytes > limits.maxOffsetTableBytes) {
    throw new EditFailure('ResourceLimit', { limitName: 'offset-table-bytes' });
  }
  const targetLen = newTableOffset + tableBytes + 32;
  if (targetLen > limits.common.maxSourceBytes) {
    throw new EditFailure('ResourceLimit', { limitName: 'target-bytes' });
  }
  const table = new Uint8Array(tableBytes);
  for (let index = 0; index < newOffsets.length; index++) {
    writeBe(table, index * offsetIntSize, BigInt(newOffsets[index]), offsetIntSize);
  }
  splices.push(structuralSplice(oldTableStart, oldTableBytes, table));
  delta = addLengthDelta(delta, table.length, oldTableBytes);

  const oldLen = document.render().length;
  const trailer = new Uint8Array(32);
  trailer[5] = 0; // sortVersion
  trailer[6] = offsetIntSize;
  trailer[7] = newRefSize;
  writeBe(trailer, 8, BigInt(newObjectCount), 8); // numObjects
  writeBe(trailer, 16, BigInt(native.root().index()), 8); // topObject
  writeBe(trailer, 24, BigInt(newTableOffset), 8); // offsetTableOffset
  const trailerStart = shifted(oldLen, delta) - 32;
  if (trailerStart < 0) {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  splices.push(structuralSplice(trailerStart, 32, trailer));
  return splices;
}

function writeBe(bytes: Uint8Array, offset: number, value: bigint, width: number): void {
  for (let shift = 0; shift < width; shift++) {
    bytes[offset + width - 1 - shift] = Number((value >> BigInt(8 * shift)) & 0xffn);
  }
}

// ---------------------------------------------------------------------------
// Commit assembly (edit.rs:1935-2160)
// ---------------------------------------------------------------------------

/** Maps one fatal target formation failure to a stable edit failure (edit.rs:2124-2133). */
function mapFatal(fatal: FatalFormationFailure): EditFailure {
  if (
    fatal
      .diagnostics()
      .some((item) => item.code.startsWith('plist.limit.') || item.code === 'core.source.resource-limit@1')
  ) {
    return new EditFailure('ResourceLimit', { limitName: 'formation' });
  }
  return new EditFailure('NewDocumentFormationFailed');
}

/** Builds the commit facts: ChangeSet, replayable SourcePatch, and the untouched-byte proof (edit.rs:1935-2033). */
function buildCommit(
  base: PlistDocument,
  transaction: EditTransaction,
  finalDocument: PlistDocument,
  edits: AppliedEdit[],
): EditCommit {
  const limits = base.parseLimits();
  if (edits.length > limits.maxReportEvents) {
    throw new EditFailure('ResourceLimit', { limitName: 'report-events' });
  }
  const oldAuthority = base.authorityInternal();
  const newAuthority = finalDocument.authorityInternal();
  const spans: Array<{ readonly start: number; readonly end: number; readonly delta: number }> = [];
  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index];
    const oldStart = unmapIn(edits.slice(0, index), edit.preStart);
    const oldEnd = unmapIn(edits.slice(0, index), edit.preStart + edit.preLen);
    const delta = edit.replacement.length - edit.preLen;
    spans.push({ start: oldStart, end: oldEnd, delta });
  }
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  const runs: Array<{ start: number; end: number; delta: number }> = [];
  for (const span of spans) {
    const last = runs[runs.length - 1];
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      last.delta += span.delta;
      continue;
    }
    runs.push({ start: span.start, end: span.end, delta: span.delta });
  }
  let beforeDelta = 0;
  const targetBytes = finalDocument.render();
  const sourceEdits: SourceEdit[] = [];
  for (const run of runs) {
    const targetStart = shifted(run.start, beforeDelta);
    const runLen = (run.end - run.start) + run.delta;
    if (runLen < 0) {
      throw new EditFailure('ResourceLimit', { limitName: 'target-bytes' });
    }
    const targetEnd = targetStart + runLen;
    if (targetEnd > targetBytes.length) {
      throw new EditFailure('NewDocumentFormationFailed');
    }
    sourceEdits.push(
      new SourceEdit(
        oldAuthority.span(run.start, run.end),
        newAuthority.span(targetStart, targetEnd),
        targetBytes.slice(targetStart, targetEnd),
      ),
    );
    beforeDelta += run.delta;
  }
  const changeSet = new ChangeSet(
    base.snapshotIdentity(),
    finalDocument.snapshotIdentity(),
    sourceEdits,
    buildMappings(base, transaction, finalDocument),
    [],
  );
  let sourcePatch: SourcePatch;
  try {
    sourcePatch = SourcePatch.derive(
      base.source(),
      finalDocument.source(),
      changeSet,
      operationMetadata(transaction),
      sourcePatchLimits(limits),
    );
  } catch {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  let untouchedProof: UntouchedByteProof;
  try {
    untouchedProof = UntouchedByteProof.create(base.source(), finalDocument.source(), sourcePatch.replacements());
  } catch {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  return new EditCommit(finalDocument, changeSet, sourcePatch, untouchedProof);
}

/** One old-to-new mapping per operation whose target resolves in the base snapshot (edit.rs:2037-2108). */
function buildMappings(base: PlistDocument, transaction: EditTransaction, finalDocument: PlistDocument): NodeMapping[] {
  const baseNative = base.document();
  const finalNative = finalDocument.document();
  if (baseNative === null || finalNative === null) {
    return [];
  }
  const oldAuthority = base.authorityInternal();
  const newAuthority = finalDocument.authorityInternal();
  const mappings: NodeMapping[] = [];
  for (const operation of transaction.operations()) {
    const mapping = mappingFor(operation, baseNative, finalNative, oldAuthority, newAuthority);
    if (mapping !== null) {
      mappings.push(mapping);
    }
  }
  return mappings;
}

function mappingFor(
  operation: EditOperation,
  baseNative: PlistNativeDocument,
  finalNative: PlistNativeDocument,
  oldAuthority: ReturnType<PlistDocument['authorityInternal']>,
  newAuthority: ReturnType<PlistDocument['authorityInternal']>,
): NodeMapping | null {
  let old: PlistValueRef | null = null;
  let new_: PlistValueRef | null = null;
  let status: NodeMappingStatus = 'Preserved';
  switch (operation.op) {
    case 'SetValue':
    case 'RenameDictKey': {
      let resolved: PlistValueRef;
      try {
        resolved = resolvePath(baseNative, operation.path);
      } catch {
        return null;
      }
      old = resolved;
      try {
        new_ = resolvePath(finalNative, operation.path);
      } catch {
        new_ = null;
      }
      status = new_ !== null ? 'Replaced' : 'Unmapped';
      break;
    }
    case 'RemoveDictEntry': {
      let container: PlistValueRef;
      try {
        container = resolvePath(baseNative, operation.path);
      } catch {
        return null;
      }
      const node = baseNative.get(container);
      if (node?.kind !== 'Dict') {
        return null;
      }
      let position: number;
      try {
        position = nthKeyPosition(node.entries, operation.key, operation.occurrence);
      } catch {
        return null;
      }
      old = PlistValueRef.fromIndex(node.entries[position].value);
      status = 'Deleted';
      break;
    }
    case 'RemoveArrayElement': {
      let container: PlistValueRef;
      try {
        container = resolvePath(baseNative, operation.path);
      } catch {
        return null;
      }
      const node = baseNative.get(container);
      if (node?.kind !== 'Array') {
        return null;
      }
      if (operation.index >= node.elements.length) {
        return null;
      }
      old = PlistValueRef.fromIndex(node.elements[operation.index]);
      status = 'Deleted';
      break;
    }
    case 'InsertDictEntry':
    case 'InsertArrayElement':
      return null;
  }
  return new NodeMapping(
    oldAuthority.nodeRef(BigInt(old!.index()), 'PlistValue'),
    status,
    new_ !== null ? newAuthority.nodeRef(BigInt(new_.index()), 'PlistValue') : null,
    status === 'Unmapped' ? 'reparsed-node-not-uniquely-located' : null,
  );
}

/** Patch construction bounds derived from the parse limits (edit.rs:2111-2121). */
function sourcePatchLimits(limits: PlistParseLimits): SourcePatchLimits {
  return {
    source: {
      maxRawBytes: limits.common.maxSourceBytes,
      maxDecodedUtf8Bytes: limits.maxDecodedUtf8Bytes,
      maxDecodedScalars: limits.maxDecodedScalars,
    },
    maxReplacements: Math.max(limits.maxReportEvents, 1),
    maxPatchBytes: limits.common.maxSourceBytes * 2,
  };
}

/** Deterministic patch metadata: one operation id per declared operation (edit.rs:2136-2148). */
function operationMetadata(transaction: EditTransaction): ReadonlyMap<string, string> {
  const metadata = new Map<string, string>();
  transaction.operations().forEach((operation, index) => {
    metadata.set(`operation.${index}`, editOperationId(operation));
  });
  return metadata;
}

/** Content-free operation summaries for the dry-run plan (edit.rs:2163-2220). */
function operationSummaries(transaction: EditTransaction): EditOperationSummary[] {
  return transaction.operations().map((operation) => {
    const id = editOperationId(operation);
    const arguments_ = new Map<string, string>();
    switch (operation.op) {
      case 'SetValue':
        arguments_.set('value_kind', editValueKind(operation.value));
        break;
      case 'InsertDictEntry':
        arguments_.set('key_units', String(operation.key.length));
        arguments_.set('value_kind', editValueKind(operation.value));
        arguments_.set('placement', placementName(operation.placement));
        break;
      case 'RemoveDictEntry':
        arguments_.set('key_units', String(operation.key.length));
        arguments_.set('occurrence', String(operation.occurrence));
        break;
      case 'RenameDictKey':
        arguments_.set('from_units', String(operation.from.length));
        arguments_.set('to_units', String(operation.to.length));
        arguments_.set('occurrence', String(operation.occurrence));
        break;
      case 'InsertArrayElement':
        arguments_.set('index', String(operation.index));
        arguments_.set('value_kind', editValueKind(operation.value));
        break;
      case 'RemoveArrayElement':
        arguments_.set('index', String(operation.index));
        break;
    }
    const parts = id.split('@');
    return new EditOperationSummary(new FormatOperationId(parts[0], Number(parts[1])), arguments_);
  });
}

function placementName(placement: DictPlacement): string {
  switch (placement.kind) {
    case 'End':
      return 'End';
    case 'Before':
      return 'Before';
    case 'After':
      return 'After';
  }
}

// ---------------------------------------------------------------------------
// PlistDocument edit surface
// ---------------------------------------------------------------------------

/** Atomically commits structural operations. On failure the base stays unchanged (edit.rs:457-575). */
export function commitEdits(
  base: PlistDocument,
  transaction: EditTransaction,
  limits: PlistParseLimits,
): EditCommit {
  if (!transaction.baseSnapshot().equals(base.snapshotIdentity())) {
    throw new EditFailure('WrongSnapshot');
  }
  if (base.formationStatus() !== 'Complete' || base.document() === null) {
    throw new EditFailure('IncompleteTarget');
  }
  if (transaction.operations().length > limits.maxReportEvents) {
    throw new EditFailure('ResourceLimit', { limitName: 'report-events' });
  }
  const profile = base.profileInternal();
  const edits: AppliedEdit[] = [];
  let bytes = base.render();
  if (profile === 'XmlV1') {
    const selection: PlistEncodingSelection = base.source().encodingFacts().callerOverride() !== null
      ? { kind: 'Explicit', encoding: base.source().encodingFacts().callerOverride()! }
      : { kind: 'ProfileDefault' };
    const encoding = base.source().encodingFacts().selected();
    for (const operation of transaction.operations()) {
      const formed = parseXmlFromBytes(bytes, selection, limits);
      const native = formed.document();
      if (formed.formationStatus() !== 'Complete' || native === null) {
        throw new EditFailure('NewDocumentFormationFailed');
      }
      const layout = xmlLayout(formed);
      const splices = prepareXmlOperation(formed, native, layout, operation, encoding);
      bytes = applyStep(edits, bytes, limits, splices);
    }
    const finalDocument = parse(bytes, 'XmlV1', selection, limits);
    if (finalDocument.formationStatus() !== 'Complete') {
      throw new EditFailure('NewDocumentFormationFailed');
    }
    return buildCommit(base, transaction, finalDocument, edits);
  }
  for (const operation of transaction.operations()) {
    const formed = parseBinaryFromBytes(bytes, limits);
    const native = formed.document();
    if (formed.formationStatus() !== 'Complete' || native === null) {
      throw new EditFailure('NewDocumentFormationFailed');
    }
    const facts = formed.binaryFacts();
    if (facts === null) {
      throw new EditFailure('NewDocumentFormationFailed');
    }
    const splices = binaryStep(formed, native, facts, operation, limits);
    bytes = applyStep(edits, bytes, limits, splices);
  }
  const finalDocument = parse(bytes, 'BinaryV1', { kind: 'ProfileDefault' }, limits);
  if (finalDocument.formationStatus() !== 'Complete') {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  return buildCommit(base, transaction, finalDocument, edits);
}

/** Fully validates and plans a transaction without returning a new Document (edit.rs:466-480). */
export function dryRunEdits(
  base: PlistDocument,
  transaction: EditTransaction,
  sourceId: EditPlanSourceId,
  limits: PlistParseLimits,
): EditPlan {
  const commit = commitEdits(base, transaction, limits);
  try {
    return new EditPlan(
      sourceId,
      base.profile(),
      operationSummaries(transaction),
      commit.sourcePatch(),
      commit.changeSet().diagnostics(),
    );
  } catch {
    throw new EditFailure('NewDocumentFormationFailed');
  }
}

/** Reparses one XML snapshot state during an edit transaction. */
function parseXmlFromBytes(bytes: Uint8Array, selection: PlistEncodingSelection, limits: PlistParseLimits): PlistDocument {
  try {
    return parse(bytes, 'XmlV1', selection, limits);
  } catch (error) {
    if (error instanceof FatalFormationFailure) {
      throw mapFatal(error);
    }
    throw error;
  }
}

/** Reparses one binary snapshot state during an edit transaction. */
function parseBinaryFromBytes(bytes: Uint8Array, limits: PlistParseLimits): PlistDocument {
  try {
    return parse(bytes, 'BinaryV1', { kind: 'ProfileDefault' }, limits);
  } catch (error) {
    if (error instanceof FatalFormationFailure) {
      throw mapFatal(error);
    }
    throw error;
  }
}
