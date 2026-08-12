/**
 * Scalar and structural YAML edit operations over one immutable snapshot.
 *
 * authority: crates/consema-yaml/src/edit.rs
 *  - RepresentationPolicy :21-32, ScalarReplacement :34-61, EditOperation
 *    :63-114, EditTransaction/Builder :116-258, EditCommit :260-271,
 *    EditFailure :273-314, edit_failure_code :316-343
 *  - Document::commit :401-551 (validate_dependencies :407, prepared-edit
 *    ordering and ownership conflicts :416-417, target length :418-428,
 *    render and reparse :429-442, source edits and node mappings :444-523,
 *    ChangeSet :524-530, SourcePatch.derive :531-538, UntouchedByteProof
 *    :539-544), Document::dry_run :553-568
 *  - prepare_scalar :603-675 (ExactLiteral :630-632, PreserveCompatible
 *    :645-654, CanonicalForProfile :656-658, PreserveElseCanonical
 *    :659-670 with yaml.edit.canonical-fallback@1 :2469-2489),
 *    canonical_scalar_edits :677-706, prepare_anchor_rename :708-740
 *    (updates every dependent alias in one transaction),
 *    prepare_mapping_insertion :742-775 (flow fragment `? key : value`),
 *    prepare_sequence_insertion :777-807, prepare_alias_insertion
 *    :809-852 (validate_visible_anchor :1346-1396 — the last visible
 *    definition of the name before the insertion point),
 *    prepare_mapping_removal :854-889, prepare_sequence_removal :891-920,
 *    collection_insertion_point :1078-1106, prepare_collection_insertion_at
 *    :1108-1158, collection_removal_span :1160-1200, block_owned_span
 *    :1226-1238, empty_block_replacement :1324-1344
 *  - validate_removal_dependencies :1398-1418 + collect_owned_nodes
 *    :1420-1442 — ONLY the deleted subtree is collected for validation
 *    (alias edges are never traversed; an alias outside the removed span
 *    targeting an owned removed node fails with yaml.edit.anchor-
 *    dependency@1 — the e420ad7 fixed behavior)
 *  - validate_dependencies :1974-2014 (DuplicateTarget,
 *    StructuralContainerConflict — at most one structural mutation per
 *    base container, RFC 0007 §12:380-382)
 *  - validate_candidate :1682-1764 and validate_structural_candidate
 *    :1766-1947 (the cycle-safe representation-graph isomorphism via
 *    ValidationModel :2024-2317), canonical_scalar_fragment :1569-1614,
 *    canonical_value_fragment :1616-1644, validate_literal :1536-1567,
 *    validate_anchor_name :1646-1672, preserved_literal :2326-2362
 *  - operation ids (EXACT registry, do not guess):
 *    crates/consema-yaml/src/operation_registry.rs:16-83 and
 *    edit.rs:2577-2604 (yaml.edit.replace-scalar-semantic@1,
 *    yaml.edit.replace-scalar-literal@1, yaml.edit.rename-anchor@1,
 *    yaml.edit.insert-mapping-entry@1, yaml.edit.remove-mapping-entry@1,
 *    yaml.edit.insert-sequence-element@1, yaml.edit.remove-sequence-element@1,
 *    yaml.edit.insert-alias@1)
 *  - vector-pinned behavior: conformance/vectors/yaml-v1.json
 *    (edit.scalar-atomic :106-109, edit.anchor-rename :111-114,
 *    edit.structural-insert :116-119, edit.anchor-dependency :121-124)
 *
 * Design (TypeScript-idiomatic): one immutable transaction binds one base
 * snapshot; every operation is fully validated before any output is
 * published. Validation, source-edit preparation, output allocation,
 * reparse, mapping, untouched proof, and SourcePatch derivation form one
 * atomic commit — a failure returns none of the successful artifacts
 * (RFC 0004 §13).
 */

import type {
  AssociationPlacement,
  NodeRef,
  NodeRole,
  SnapshotIdentity,
  Span,
} from '../document/identity.ts';
import { ChangeSet, NodeMapping, SourceEdit } from '../document/change_set.ts';
import type { NodeMappingStatus } from '../document/change_set.ts';
import { diagnostic } from '../document/diagnostic.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { EditOperationSummary, EditPlan, EditPlanSourceId } from '../document/edit_plan.ts';
import { FormatOperationId } from '../document/operation.ts';
import type { ParseLimits } from '../document/formation.ts';
import { MaterializationFailure } from '../document/errors.ts';
import {
  MaterializationRequest,
  MaterializationStyleId,
} from '../document/materialization.ts';
import type { MaterializationLimits } from '../document/materialization.ts';
import type { SourceEncoding, SourceLimits } from '../document/source.ts';
import { SourcePatch } from '../document/source_patch.ts';
import type { SourcePatchLimits } from '../document/source_patch.ts';
import { UntouchedByteProof } from '../document/untouched_proof.ts';
import type { Kind, PortableValue } from '../core/value.ts';
import { EditFailure } from './errors.ts';
import type { YamlDocument } from './document.ts';
import type { YamlScalarKind, YamlScalarStyle } from './semantic.ts';
import type { YamlSyntaxKind } from './syntax.ts';
import { parse } from './parser.ts';
import { materializeValue } from './materialization.ts';
import { TAG_BINARY, TAG_BOOL, TAG_FLOAT, TAG_INT, TAG_NULL, TAG_STR, TAG_TIMESTAMP } from './scalar.ts';
import type { YamlProfile } from './profile.ts';

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Explicit semantic scalar representation policy (edit.rs:21-32). */
export type RepresentationPolicy =
  | 'ExactLiteral'
  | 'PreserveCompatible'
  | 'CanonicalForProfile'
  | 'PreserveElseCanonical';

/** One scalar operation bound to the transaction's base snapshot (edit.rs:34-53). */
export type ScalarReplacement =
  | {
      readonly kind: 'Semantic';
      /** Exact YAML representation-node target. */
      readonly target: NodeRef;
      /** New complete core scalar. */
      readonly value: PortableValue;
      /** Representation contract. */
      readonly policy: RepresentationPolicy;
    }
  | {
      readonly kind: 'Literal';
      readonly target: NodeRef;
      /** Candidate bytes in the base document's selected encoding. */
      readonly literal: Uint8Array;
    };

/** One typed YAML edit operation bound to an immutable base snapshot (edit.rs:63-114). */
export type EditOperation =
  | { readonly kind: 'ReplaceScalar'; readonly operation: ScalarReplacement }
  | {
      readonly kind: 'RenameAnchor';
      readonly target: NodeRef;
      readonly name: string;
    }
  | {
      readonly kind: 'InsertMappingEntry';
      readonly mapping: NodeRef;
      readonly key: PortableValue;
      readonly value: PortableValue;
      readonly placement: AssociationPlacement;
    }
  | { readonly kind: 'RemoveMappingEntry'; readonly target: NodeRef }
  | {
      readonly kind: 'InsertSequenceElement';
      readonly sequence: NodeRef;
      readonly value: PortableValue;
      readonly placement: AssociationPlacement;
    }
  | { readonly kind: 'RemoveSequenceElement'; readonly target: NodeRef }
  | {
      readonly kind: 'InsertAlias';
      readonly sequence: NodeRef;
      readonly anchor: NodeRef;
      readonly placement: AssociationPlacement;
    };

/** Immutable transaction; every operation resolves against one base snapshot (edit.rs:116-135). */
export class EditTransaction {
  readonly #base: SnapshotIdentity;
  readonly #operations: readonly EditOperation[];

  constructor(base: SnapshotIdentity, operations: readonly EditOperation[]) {
    this.#base = base;
    this.#operations = Object.freeze([...operations]);
  }

  /** Base snapshot identity (edit.rs:124-127). */
  baseSnapshot(): SnapshotIdentity {
    return this.#base;
  }

  /** Ordered declared operations (edit.rs:129-134). */
  operations(): readonly EditOperation[] {
    return this.#operations;
  }
}

/** Builder that is not a committed edit (edit.rs:137-258). */
export class EditTransactionBuilder {
  readonly #base: SnapshotIdentity;
  readonly #operations: EditOperation[] = [];

  /** Binds a new transaction to one immutable base document (edit.rs:145-152). */
  constructor(document: YamlDocument) {
    this.#base = document.snapshotIdentity();
  }

  /** Adds one semantic scalar replacement (edit.rs:154-168). */
  semanticScalar(target: NodeRef, value: PortableValue, policy: RepresentationPolicy): EditTransactionBuilder {
    this.#operations.push({ kind: 'ReplaceScalar', operation: { kind: 'Semantic', target, value, policy } });
    return this;
  }

  /** Adds one exact scalar-literal replacement (edit.rs:169-178). */
  literalScalar(target: NodeRef, literal: Uint8Array): EditTransactionBuilder {
    this.#operations.push({ kind: 'ReplaceScalar', operation: { kind: 'Literal', target, literal } });
    return this;
  }

  /** Adds one anchor rename that also updates every dependent alias (edit.rs:180-188). */
  renameAnchor(target: NodeRef, name: string): EditTransactionBuilder {
    this.#operations.push({ kind: 'RenameAnchor', target, name });
    return this;
  }

  /** Adds one arbitrary-key mapping association insertion (edit.rs:190-204). */
  insertMappingEntry(
    mapping: NodeRef,
    key: PortableValue,
    value: PortableValue,
    placement: AssociationPlacement,
  ): EditTransactionBuilder {
    this.#operations.push({ kind: 'InsertMappingEntry', mapping, key, value, placement });
    return this;
  }

  /** Adds one exact mapping-association removal (edit.rs:206-211). */
  removeMappingEntry(target: NodeRef): EditTransactionBuilder {
    this.#operations.push({ kind: 'RemoveMappingEntry', target });
    return this;
  }

  /** Adds one sequence value insertion (edit.rs:213-226). */
  insertSequenceElement(
    sequence: NodeRef,
    value: PortableValue,
    placement: AssociationPlacement,
  ): EditTransactionBuilder {
    this.#operations.push({ kind: 'InsertSequenceElement', sequence, value, placement });
    return this;
  }

  /** Adds one exact sequence-association removal (edit.rs:228-233). */
  removeSequenceElement(target: NodeRef): EditTransactionBuilder {
    this.#operations.push({ kind: 'RemoveSequenceElement', target });
    return this;
  }

  /** Adds one sequence alias insertion to an earlier visible anchor (edit.rs:235-248). */
  insertAlias(
    sequence: NodeRef,
    anchor: NodeRef,
    placement: AssociationPlacement,
  ): EditTransactionBuilder {
    this.#operations.push({ kind: 'InsertAlias', sequence, anchor, placement });
    return this;
  }

  /** Completes the immutable request; validation happens atomically at commit (edit.rs:250-257). */
  build(): EditTransaction {
    return new EditTransaction(this.#base, this.#operations);
  }
}

// ---------------------------------------------------------------------------
// Commit records
// ---------------------------------------------------------------------------

/** Atomic edit success (edit.rs:260-271). */
export class EditCommit {
  readonly #document: YamlDocument;
  readonly #changeSet: ChangeSet;
  readonly #sourcePatch: SourcePatch;
  readonly #untouchedProof: UntouchedByteProof;

  constructor(
    document: YamlDocument,
    changeSet: ChangeSet,
    sourcePatch: SourcePatch,
    untouchedProof: UntouchedByteProof,
  ) {
    this.#document = document;
    this.#changeSet = changeSet;
    this.#sourcePatch = sourcePatch;
    this.#untouchedProof = untouchedProof;
  }

  /** New immutable document (edit.rs:263-265). */
  document(): YamlDocument {
    return this.#document;
  }

  /** Complete old-to-new change facts (edit.rs:266-268). */
  changeSet(): ChangeSet {
    return this.#changeSet;
  }

  /** Portable exact raw-byte application fact (edit.rs:269-271). */
  sourcePatch(): SourcePatch {
    return this.#sourcePatch;
  }

  /** Verifiable evidence for every byte outside the replacement set (edit.rs:272-274). */
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
  readonly mapping: { readonly old: NodeRef; readonly plan: MappingPlan } | null;
}

type MappingPlan =
  | { readonly kind: 'Node'; readonly index: number }
  | { readonly kind: 'Anchor'; readonly index: number }
  | { readonly kind: 'Alias'; readonly ordinal: number }
  | { readonly kind: 'Removed' };

interface CandidateMap {
  readonly nodes: Map<number, number>;
  readonly aliases: Map<number, number>;
}

interface CanonicalScalar {
  readonly tag: string;
  readonly literal: string;
  readonly canonical: string;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/**
 * Atomically commits validated YAML scalar, collection, anchor, and alias
 * operations (edit.rs:401-551). On failure `self` remains unchanged.
 */
export function commitEdits(document: YamlDocument, transaction: EditTransaction): EditCommit {
  if (!transaction.baseSnapshot().equals(document.snapshotIdentity())) {
    throw new EditFailure('WrongSnapshot');
  }
  validateDependencies(document, transaction);
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
  validatePreparedOwnership(prepared);
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

  let newDocument: YamlDocument;
  try {
    newDocument = parse(rendered, document.profileInternal(), document.parseLimits());
  } catch {
    throw new EditFailure('NewDocumentFormationFailed');
  }

  const candidateMap = validateCandidate(document, newDocument, transaction);

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
        case 'Node': {
          const mapped = candidateMap.nodes.get(mapping.plan.index);
          newRef = mapped === undefined ? null : newDocument.nodeRefFor(mapped, 'YamlNode');
          status = 'Replaced';
          reason = mapped === undefined ? 'reparsed-node-not-uniquely-located' : null;
          break;
        }
        case 'Anchor': {
          const mapped = candidateMap.nodes.get(mapping.plan.index);
          const node = mapped === undefined ? undefined : newDocument.nodeAt(mapped);
          newRef =
            node !== undefined && node.anchor !== null
              ? newDocument.nodeRefFor(mapped!, 'YamlAnchorDefinition')
              : null;
          status = 'Replaced';
          reason = newRef === null ? 'reparsed-node-not-uniquely-located' : null;
          break;
        }
        case 'Alias': {
          const mapped = candidateMap.aliases.get(mapping.plan.ordinal);
          newRef = mapped === undefined ? null : newDocument.alias(mapped)?.nodeRef() ?? null;
          status = 'Replaced';
          reason = newRef === null ? 'reparsed-node-not-uniquely-located' : null;
          break;
        }
        case 'Removed':
          newRef = null;
          status = 'Deleted';
          reason = 'association-removed-by-declared-operation';
          break;
      }
      mappings.push(new NodeMapping(mapping.old, status, newRef, reason));
    }
    delta += edit.replacement.length - edit.oldSpan.len();
  }
  const changeSet = new ChangeSet(
    document.snapshotIdentity(),
    newDocument.snapshotIdentity(),
    sourceEdits,
    mappings,
    diagnostics,
  );
  let sourcePatch: SourcePatch;
  try {
    sourcePatch = SourcePatch.derive(
      document.source(),
      newDocument.source(),
      changeSet,
      operationMetadata(transaction),
      sourcePatchLimits(document.parseLimits(), changeSet.sourceEdits().length),
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

/** Fully validates and plans an edit without returning a new Document (edit.rs:553-568). */
export function dryRunEdits(
  document: YamlDocument,
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
// Operation preparation
// ---------------------------------------------------------------------------

function prepareOperation(
  document: YamlDocument,
  operation: EditOperation,
  diagnostics: Diagnostic[],
): PreparedEdit[] {
  switch (operation.kind) {
    case 'ReplaceScalar':
      return prepareScalar(document, operation.operation, diagnostics);
    case 'RenameAnchor':
      return prepareAnchorRename(document, operation.target, operation.name);
    case 'InsertMappingEntry':
      return prepareMappingInsertion(document, operation.mapping, operation.key, operation.value, operation.placement);
    case 'RemoveMappingEntry':
      return prepareMappingRemoval(document, operation.target);
    case 'InsertSequenceElement':
      return prepareSequenceInsertion(document, operation.sequence, operation.value, operation.placement);
    case 'RemoveSequenceElement':
      return prepareSequenceRemoval(document, operation.target);
    case 'InsertAlias':
      return prepareAliasInsertion(document, operation.sequence, operation.anchor, operation.placement);
  }
}

function prepareScalar(
  document: YamlDocument,
  operation: ScalarReplacement,
  diagnostics: Diagnostic[],
): PreparedEdit[] {
  const index = resolveNode(document, operation.target, 'YamlNode');
  const node = document.nodeAt(index);
  if (node.content.kind !== 'Scalar') {
    throw new EditFailure('WrongRole');
  }
  const scalar = node.content.scalar;
  const literalSpan = scalarLiteralSpan(document, index);
  if (literalSpan === null) {
    throw new EditFailure('IncompleteTarget');
  }
  if (operation.kind === 'Literal') {
    validateLiteral(document, operation.literal);
    return [
      {
        oldSpan: literalSpan,
        replacement: Uint8Array.from(operation.literal),
        mapping: { old: operation.target, plan: { kind: 'Node', index } },
      },
    ];
  }
  if (!isScalarValue(operation.value.kind)) {
    throw new EditFailure('UnsupportedSemanticValue', { valueKind: operation.value.kind });
  }
  if (operation.policy === 'ExactLiteral') {
    throw new EditFailure('ExactLiteralRequiresLiteralOperation');
  }
  const canonical = canonicalScalarFragment(document, operation.value);
  const preserve = (): string | null =>
    preservedLiteral(
      scalar.kind,
      scalar.style,
      node.tag,
      tagSpan(document, index) !== null,
      canonical,
      operation.value.kind,
      document.profileInternal(),
    );
  switch (operation.policy) {
    case 'PreserveCompatible': {
      const text = preserve();
      if (text === null) {
        throw new EditFailure('RepresentationIncompatible');
      }
      return [
        {
          oldSpan: literalSpan,
          replacement: encodeFragment(document, text),
          mapping: { old: operation.target, plan: { kind: 'Node', index } },
        },
      ];
    }
    case 'CanonicalForProfile':
      return canonicalScalarEdits(document, index, operation.target, literalSpan, canonical);
    case 'PreserveElseCanonical': {
      const text = preserve();
      if (text !== null) {
        return [
          {
            oldSpan: literalSpan,
            replacement: encodeFragment(document, text),
            mapping: { old: operation.target, plan: { kind: 'Node', index } },
          },
        ];
      }
      pushFallbackDiagnostic(diagnostics, literalSpan);
      return canonicalScalarEdits(document, index, operation.target, literalSpan, canonical);
    }
    // 'ExactLiteral' was rejected above; the remaining policies are covered.
  }
}

function canonicalScalarEdits(
  document: YamlDocument,
  index: number,
  target: NodeRef,
  literalSpan: Span,
  canonical: CanonicalScalar,
): PreparedEdit[] {
  const encodedLiteral = encodeFragment(document, canonical.literal);
  const tag = tagSpan(document, index);
  if (tag !== null) {
    return [
      {
        oldSpan: tag,
        replacement: encodeFragment(document, canonical.tag),
        mapping: null,
      },
      {
        oldSpan: literalSpan,
        replacement: encodedLiteral,
        mapping: { old: target, plan: { kind: 'Node', index } },
      },
    ];
  }
  return [
    {
      oldSpan: literalSpan,
      replacement: encodeFragment(document, `${canonical.tag} ${canonical.literal}`),
      mapping: { old: target, plan: { kind: 'Node', index } },
    },
  ];
}

function prepareAnchorRename(document: YamlDocument, target: NodeRef, name: string): PreparedEdit[] {
  const index = resolveNode(document, target, 'YamlAnchorDefinition');
  validateAnchorName(document, name);
  const node = document.nodeAt(index);
  const oldName = node.anchor;
  if (oldName === null) {
    throw new EditFailure('WrongRole');
  }
  const definition = node.anchorSpan;
  if (definition === null) {
    throw new EditFailure('IncompleteTarget');
  }
  const edits: PreparedEdit[] = [
    {
      oldSpan: definition,
      replacement: encodeFragment(document, `&${name}`),
      mapping: { old: target, plan: { kind: 'Anchor', index } },
    },
  ];
  const aliases = document.aliasesInternal();
  for (let ordinal = 0; ordinal < aliases.length; ordinal++) {
    const alias = aliases[ordinal];
    if (alias.target === index && alias.name === oldName) {
      edits.push({
        oldSpan: alias.span,
        replacement: encodeFragment(document, `*${name}`),
        mapping: {
          old: document.authorityInternal().nodeRef(alias.identity, 'YamlAlias'),
          plan: { kind: 'Alias', ordinal },
        },
      });
    }
  }
  return edits;
}

function prepareMappingInsertion(
  document: YamlDocument,
  mapping: NodeRef,
  key: PortableValue,
  value: PortableValue,
  placement: AssociationPlacement,
): PreparedEdit[] {
  const index = resolveNode(document, mapping, 'YamlNode');
  const node = document.nodeAt(index);
  if (node.content.kind !== 'Mapping') {
    throw new EditFailure('WrongRole');
  }
  const ordinal = mappingPlacement(document, index, node.content.entries, placement);
  const keyFragment = canonicalValueFragment(document, key);
  const valueFragment = canonicalValueFragment(document, value);
  const fragment = `? ${keyFragment} : ${valueFragment}`;
  const blockLines = [`? ${keyFragment}`, `: ${valueFragment}`];
  const spans = node.content.entries.map((entry) => associationSpan(document, entry.span));
  const [oldSpan, replacement] = prepareCollectionInsertion(
    document,
    index,
    spans,
    ordinal,
    fragment,
    blockLines,
    'FlowMappingStart',
    'FlowMappingEnd',
  );
  return [{ oldSpan, replacement, mapping: { old: mapping, plan: { kind: 'Node', index } } }];
}

function prepareSequenceInsertion(
  document: YamlDocument,
  sequence: NodeRef,
  value: PortableValue,
  placement: AssociationPlacement,
): PreparedEdit[] {
  const index = resolveNode(document, sequence, 'YamlNode');
  const node = document.nodeAt(index);
  if (node.content.kind !== 'Sequence') {
    throw new EditFailure('WrongRole');
  }
  const ordinal = sequencePlacement(document, index, node.content.items, placement);
  const fragment = canonicalValueFragment(document, value);
  const blockLines = [`- ${fragment}`];
  const spans = node.content.items.map((item) => associationSpan(document, item.span));
  const [oldSpan, replacement] = prepareCollectionInsertion(
    document,
    index,
    spans,
    ordinal,
    fragment,
    blockLines,
    'FlowSequenceStart',
    'FlowSequenceEnd',
  );
  return [{ oldSpan, replacement, mapping: { old: sequence, plan: { kind: 'Node', index } } }];
}

function prepareAliasInsertion(
  document: YamlDocument,
  sequence: NodeRef,
  anchor: NodeRef,
  placement: AssociationPlacement,
): PreparedEdit[] {
  const sequenceIndex = resolveNode(document, sequence, 'YamlNode');
  const anchorIndex = resolveNode(document, anchor, 'YamlAnchorDefinition');
  const node = document.nodeAt(sequenceIndex);
  if (node.content.kind !== 'Sequence') {
    throw new EditFailure('WrongRole');
  }
  const ordinal = sequencePlacement(document, sequenceIndex, node.content.items, placement);
  const spans = node.content.items.map((item) => associationSpan(document, item.span));
  const insertion = collectionInsertionPoint(
    document,
    sequenceIndex,
    spans,
    ordinal,
    'FlowSequenceStart',
    'FlowSequenceEnd',
  );
  validateVisibleAnchor(document, sequenceIndex, anchorIndex, insertion);
  const name = document.nodeAt(anchorIndex).anchor;
  if (name === null) {
    throw new EditFailure('WrongRole');
  }
  const [oldSpan, replacement] = prepareCollectionInsertionAt(
    document,
    sequenceIndex,
    spans,
    ordinal,
    `*${name}`,
    [`- *${name}`],
    'FlowSequenceStart',
    'FlowSequenceEnd',
    insertion,
  );
  return [{ oldSpan, replacement, mapping: { old: sequence, plan: { kind: 'Node', index: sequenceIndex } } }];
}

function prepareMappingRemoval(document: YamlDocument, target: NodeRef): PreparedEdit[] {
  const [container, ordinal] = resolveMappingEntry(document, target);
  const node = document.nodeAt(container);
  if (node.content.kind !== 'Mapping') {
    throw new EditFailure('TargetNotFound');
  }
  const spans = node.content.entries.map((entry) => associationSpan(document, entry.span));
  const owned = collectionRemovalSpan(
    document,
    container,
    spans,
    ordinal,
    'FlowMappingStart',
    'FlowMappingEnd',
  );
  const entry = node.content.entries[ordinal];
  validateRemovalDependencies(document, owned, [
    [entry.key, entry.keyAlias],
    [entry.value, entry.valueAlias],
  ]);
  let replacement: Uint8Array = new Uint8Array(0);
  if (
    node.content.entries.length === 1 &&
    !collectionIsFlow(document, container, 'FlowMappingStart')
  ) {
    replacement = emptyBlockReplacement(document, owned, spans[ordinal], '{}');
  }
  return [{ oldSpan: owned, replacement, mapping: { old: target, plan: { kind: 'Removed' } } }];
}

function prepareSequenceRemoval(document: YamlDocument, target: NodeRef): PreparedEdit[] {
  const [container, ordinal] = resolveSequenceItem(document, target);
  const node = document.nodeAt(container);
  if (node.content.kind !== 'Sequence') {
    throw new EditFailure('TargetNotFound');
  }
  const spans = node.content.items.map((item) => associationSpan(document, item.span));
  const owned = collectionRemovalSpan(
    document,
    container,
    spans,
    ordinal,
    'FlowSequenceStart',
    'FlowSequenceEnd',
  );
  const item = node.content.items[ordinal];
  validateRemovalDependencies(document, owned, [[item.node, item.alias]]);
  let replacement: Uint8Array = new Uint8Array(0);
  if (
    node.content.items.length === 1 &&
    !collectionIsFlow(document, container, 'FlowSequenceStart')
  ) {
    replacement = emptyBlockReplacement(document, owned, spans[ordinal], '[]');
  }
  return [{ oldSpan: owned, replacement, mapping: { old: target, plan: { kind: 'Removed' } } }];
}

// ---------------------------------------------------------------------------
// Placement and spans
// ---------------------------------------------------------------------------

function mappingPlacement(
  document: YamlDocument,
  expected: number,
  entries: readonly { identity: bigint }[],
  placement: AssociationPlacement,
): number {
  switch (placement.kind) {
    case 'Start':
      return 0;
    case 'End':
      return entries.length;
    case 'Before':
    case 'After': {
      const [container, ordinal] = resolveMappingEntry(document, placement.anchor);
      if (container !== expected) {
        throw new EditFailure('InvalidPlacement');
      }
      return placement.kind === 'After' ? ordinal + 1 : ordinal;
    }
  }
}

function sequencePlacement(
  document: YamlDocument,
  expected: number,
  items: readonly { identity: bigint }[],
  placement: AssociationPlacement,
): number {
  switch (placement.kind) {
    case 'Start':
      return 0;
    case 'End':
      return items.length;
    case 'Before':
    case 'After': {
      const [container, ordinal] = resolveSequenceItem(document, placement.anchor);
      if (container !== expected) {
        throw new EditFailure('InvalidPlacement');
      }
      return placement.kind === 'After' ? ordinal + 1 : ordinal;
    }
  }
}

function resolveMappingEntry(document: YamlDocument, target: NodeRef): [number, number] {
  if (!target.snapshot().equals(document.snapshotIdentity())) {
    throw new EditFailure('WrongSnapshot');
  }
  if (target.role() !== 'YamlMappingEntry') {
    throw new EditFailure('WrongRole');
  }
  const identity = document.authorityInternal().resolveIndex(target);
  const nodeCount = document.nodeCount();
  for (let container = 0; container < nodeCount; container++) {
    const node = document.nodeAt(container);
    if (node.content.kind !== 'Mapping') {
      continue;
    }
    const position = node.content.entries.findIndex((entry) => entry.identity === identity);
    if (position !== -1) {
      return [container, position];
    }
  }
  throw new EditFailure('TargetNotFound');
}

function resolveSequenceItem(document: YamlDocument, target: NodeRef): [number, number] {
  if (!target.snapshot().equals(document.snapshotIdentity())) {
    throw new EditFailure('WrongSnapshot');
  }
  if (target.role() !== 'YamlSequenceElement') {
    throw new EditFailure('WrongRole');
  }
  const identity = document.authorityInternal().resolveIndex(target);
  const nodeCount = document.nodeCount();
  for (let container = 0; container < nodeCount; container++) {
    const node = document.nodeAt(container);
    if (node.content.kind !== 'Sequence') {
      continue;
    }
    const position = node.content.items.findIndex((item) => item.identity === identity);
    if (position !== -1) {
      return [container, position];
    }
  }
  throw new EditFailure('TargetNotFound');
}

function resolveNode(document: YamlDocument, target: NodeRef, role: NodeRole): number {
  if (!target.snapshot().equals(document.snapshotIdentity())) {
    throw new EditFailure('WrongSnapshot');
  }
  if (target.role() !== role) {
    throw new EditFailure('WrongRole');
  }
  const index = Number(document.authorityInternal().resolveIndex(target));
  if (!Number.isSafeInteger(index) || index >= document.nodeCount()) {
    throw new EditFailure('TargetNotFound');
  }
  if (role === 'YamlAnchorDefinition' && document.nodeAt(index).anchor === null) {
    throw new EditFailure('WrongRole');
  }
  return index;
}

function associationSpan(document: YamlDocument, span: Span): Span {
  const pieces = document.losslessStructuralIndex().pieces();
  let start = span.startByte();
  let found = true;
  while (found) {
    found = false;
    for (let index = pieces.length - 1; index >= 0; index--) {
      const piece = pieces[index];
      if (piece.span().endByte() !== start) {
        continue;
      }
      const kind = document.losslessSyntaxKinds()[index];
      if (kind === 'Tag' || kind === 'Anchor' || kind === 'ExplicitKey') {
        start = piece.span().startByte();
        found = true;
        break;
      }
      if (kind !== 'Whitespace' || index === 0) {
        break;
      }
      const property = index - 1;
      if (
        pieces[property].span().endByte() === piece.span().startByte() &&
        (document.losslessSyntaxKinds()[property] === 'Tag' ||
          document.losslessSyntaxKinds()[property] === 'Anchor' ||
          document.losslessSyntaxKinds()[property] === 'ExplicitKey')
      ) {
        start = pieces[property].span().startByte();
        found = true;
      }
      break;
    }
  }
  try {
    return document.authorityInternal().span(start, span.endByte());
  } catch {
    throw new EditFailure('IncompleteTarget');
  }
}

function collectionInsertionPoint(
  document: YamlDocument,
  container: number,
  spans: readonly Span[],
  ordinal: number,
  flowStart: YamlSyntaxKind,
  flowEnd: YamlSyntaxKind,
): number {
  if (ordinal > spans.length) {
    throw new EditFailure('InvalidPlacement');
  }
  if (collectionIsFlow(document, container, flowStart)) {
    if (ordinal < spans.length) {
      return spans[ordinal].startByte();
    }
    if (spans.length > 0) {
      return spans[spans.length - 1].endByte();
    }
    const close = syntaxWithin(document, document.nodeAt(container).span, flowEnd, true);
    if (close === null) {
      throw new EditFailure('IncompleteTarget');
    }
    return close.startByte();
  }
  if (ordinal < spans.length) {
    return blockOwnedSpan(document, spans[ordinal]).startByte();
  }
  if (spans.length > 0) {
    return blockOwnedSpan(document, spans[spans.length - 1]).endByte();
  }
  throw new EditFailure('IncompleteTarget');
}

function prepareCollectionInsertion(
  document: YamlDocument,
  container: number,
  spans: readonly Span[],
  ordinal: number,
  flowFragment: string,
  blockLines: readonly string[],
  flowStart: YamlSyntaxKind,
  flowEnd: YamlSyntaxKind,
): [Span, Uint8Array] {
  const insertion = collectionInsertionPoint(document, container, spans, ordinal, flowStart, flowEnd);
  return prepareCollectionInsertionAt(
    document,
    container,
    spans,
    ordinal,
    flowFragment,
    blockLines,
    flowStart,
    flowEnd,
    insertion,
  );
}

function prepareCollectionInsertionAt(
  document: YamlDocument,
  container: number,
  spans: readonly Span[],
  ordinal: number,
  flowFragment: string,
  blockLines: readonly string[],
  flowStart: YamlSyntaxKind,
  _flowEnd: YamlSyntaxKind,
  insertion: number,
): [Span, Uint8Array] {
  let span: Span;
  try {
    span = document.authorityInternal().span(insertion, insertion);
  } catch {
    throw new EditFailure('IncompleteTarget');
  }
  if (collectionIsFlow(document, container, flowStart)) {
    let text: string;
    if (spans.length === 0) {
      text = flowFragment;
    } else if (ordinal < spans.length) {
      text = `${flowFragment}, `;
    } else {
      text = `, ${flowFragment}`;
    }
    return [span, encodeFragment(document, text)];
  }
  const reference = ordinal < spans.length ? spans[ordinal] : spans[spans.length - 1];
  const owned = blockOwnedSpan(document, reference);
  const indent = lineIndent(document, owned.startByte());
  const newline = nearestNewline(document, insertion);
  const suffixNewline =
    ordinal < spans.length ||
    rawDecoded(document, owned.startByte(), owned.endByte()).endsWith('\r') ||
    rawDecoded(document, owned.startByte(), owned.endByte()).endsWith('\n');
  let text = '';
  if (ordinal === spans.length && !suffixNewline) {
    text += newline;
  }
  for (let index = 0; index < blockLines.length; index++) {
    text += indent;
    text += blockLines[index];
    if (index + 1 < blockLines.length || suffixNewline) {
      text += newline;
    }
  }
  return [span, encodeFragment(document, text)];
}

function collectionRemovalSpan(
  document: YamlDocument,
  container: number,
  spans: readonly Span[],
  ordinal: number,
  flowStart: YamlSyntaxKind,
  _flowEnd: YamlSyntaxKind,
): Span {
  const target = spans[ordinal];
  if (target === undefined) {
    throw new EditFailure('TargetNotFound');
  }
  if (!collectionIsFlow(document, container, flowStart)) {
    return blockOwnedSpan(document, target);
  }
  if (spans.length === 1) {
    return target;
  }
  try {
    if (ordinal + 1 < spans.length) {
      const comma = syntaxBetween(document, 'FlowEntry', target.endByte(), spans[ordinal + 1].startByte(), false);
      if (comma === null) {
        throw new EditFailure('IncompleteTarget');
      }
      return document.authorityInternal().span(target.startByte(), spans[ordinal + 1].startByte());
    }
    const comma = syntaxBetween(document, 'FlowEntry', spans[ordinal - 1].endByte(), target.startByte(), true);
    if (comma === null) {
      throw new EditFailure('IncompleteTarget');
    }
    return document.authorityInternal().span(comma.startByte(), target.endByte());
  } catch (error) {
    if (error instanceof EditFailure) {
      throw error;
    }
    throw new EditFailure('IncompleteTarget');
  }
}

function collectionIsFlow(document: YamlDocument, container: number, flowStart: YamlSyntaxKind): boolean {
  const node = document.nodeAt(container);
  const pieces = document.losslessStructuralIndex().pieces();
  const kinds = document.losslessSyntaxKinds();
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index];
    if (piece.span().startByte() < node.span.startByte() || piece.span().endByte() > node.span.endByte()) {
      continue;
    }
    const kind = kinds[index];
    if (kind === 'Whitespace' || kind === 'Newline' || kind === 'Comment' || kind === 'Tag' || kind === 'Anchor') {
      continue;
    }
    return kind === flowStart;
  }
  return false;
}

function blockOwnedSpan(document: YamlDocument, occurrence: Span): Span {
  const start = lineStart(document, occurrence.startByte());
  let end: number;
  if (lineStart(document, occurrence.endByte()) === occurrence.endByte() && occurrence.endByte() > start) {
    end = occurrence.endByte();
  } else {
    end = lineEnd(document, occurrence.endByte());
  }
  try {
    return document.authorityInternal().span(start, end);
  } catch {
    throw new EditFailure('IncompleteTarget');
  }
}

function lineStart(document: YamlDocument, raw: number): number {
  const text = document.source().decodedText();
  if (text === null) {
    throw new EditFailure('IncompleteTarget');
  }
  const position = document.source().decodedPosition(raw);
  const prefix = text.slice(0, position.decodedUtf8Byte);
  const start =
    (prefix.lastIndexOf('\r') > prefix.lastIndexOf('\n')
      ? prefix.lastIndexOf('\r')
      : prefix.lastIndexOf('\n')) + 1;
  try {
    return document.source().rawByteAt({ kind: 'Utf8Byte', value: start });
  } catch {
    throw new EditFailure('IncompleteTarget');
  }
}

function lineEnd(document: YamlDocument, raw: number): number {
  const text = document.source().decodedText();
  if (text === null) {
    throw new EditFailure('IncompleteTarget');
  }
  const position = document.source().decodedPosition(raw);
  const suffix = text.slice(position.decodedUtf8Byte);
  let end = suffix.search(/[\r\n]/);
  if (end === -1) {
    end = text.length;
  } else {
    end += position.decodedUtf8Byte;
    if (end < text.length) {
      if (text.charCodeAt(end) === 13 && text.charCodeAt(end + 1) === 10) {
        end += 2;
      } else {
        end += 1;
      }
    }
  }
  try {
    return document.source().rawByteAt({ kind: 'Utf8Byte', value: end });
  } catch {
    throw new EditFailure('IncompleteTarget');
  }
}

function lineIndent(document: YamlDocument, rawLineStart: number): string {
  const end = lineEnd(document, rawLineStart);
  const text = rawDecoded(document, rawLineStart, end);
  let indent = '';
  for (const character of text) {
    if (character !== ' ') {
      break;
    }
    indent += character;
  }
  return indent;
}

function rawDecoded(document: YamlDocument, start: number, end: number): string {
  const text = document.source().decodedText();
  if (text === null) {
    throw new EditFailure('IncompleteTarget');
  }
  let startPosition;
  let endPosition;
  try {
    startPosition = document.source().decodedPosition(start);
    endPosition = document.source().decodedPosition(end);
  } catch {
    throw new EditFailure('IncompleteTarget');
  }
  const slice = text.slice(startPosition.decodedUtf8Byte, endPosition.decodedUtf8Byte);
  if (slice === undefined) {
    throw new EditFailure('IncompleteTarget');
  }
  return slice;
}

function nearestNewline(document: YamlDocument, raw: number): string {
  const pieces = document.losslessStructuralIndex().pieces();
  const kinds = document.losslessSyntaxKinds();
  let best: Span | null = null;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (let index = 0; index < pieces.length; index++) {
    if (kinds[index] !== 'Newline') {
      continue;
    }
    const distance = Math.abs(pieces[index].span().startByte() - raw);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = pieces[index].span();
    }
  }
  if (best === null) {
    return '\n';
  }
  try {
    return rawDecoded(document, best.startByte(), best.endByte());
  } catch {
    return '\n';
  }
}

function emptyBlockReplacement(
  document: YamlDocument,
  owned: Span,
  occurrence: Span,
  empty: string,
): Uint8Array {
  const indent = lineIndent(document, owned.startByte());
  const whole = rawDecoded(document, owned.startByte(), owned.endByte());
  let tail: string;
  if (occurrence.endByte() < owned.endByte()) {
    tail = rawDecoded(document, occurrence.endByte(), owned.endByte());
  } else if (whole.endsWith('\r\n')) {
    tail = '\r\n';
  } else if (whole.endsWith('\n')) {
    tail = '\n';
  } else if (whole.endsWith('\r')) {
    tail = '\r';
  } else {
    tail = '';
  }
  return encodeFragment(document, `${indent}${empty}${tail}`);
}

function scalarLiteralSpan(document: YamlDocument, index: number): Span | null {
  const node = document.nodeAt(index);
  if (node.content.kind !== 'Scalar') {
    return null;
  }
  const expected: YamlSyntaxKind = node.content.scalar.style === 'Plain'
    ? 'PlainScalar'
    : node.content.scalar.style === 'SingleQuoted'
      ? 'SingleQuotedScalar'
      : node.content.scalar.style === 'DoubleQuoted'
        ? 'DoubleQuotedScalar'
        : node.content.scalar.style === 'Literal'
          ? 'LiteralBlockHeader'
          : 'FoldedBlockHeader';
  const header = syntaxWithin(document, node.span, expected, false);
  if (header === null) {
    return null;
  }
  if (node.content.scalar.style === 'Literal' || node.content.scalar.style === 'Folded') {
    const end = syntaxBetween(document, 'BlockScalarContent', header.endByte(), node.span.endByte(), true);
    const endByte = end === null ? header.endByte() : end.endByte();
    try {
      return document.authorityInternal().span(header.startByte(), endByte);
    } catch {
      return null;
    }
  }
  return header;
}

function tagSpan(document: YamlDocument, index: number): Span | null {
  const node = document.nodeAt(index);
  return syntaxWithin(document, node.span, 'Tag', false);
}

function syntaxWithin(document: YamlDocument, span: Span, kind: YamlSyntaxKind, last: boolean): Span | null {
  return syntaxBetween(document, kind, span.startByte(), span.endByte(), last);
}

function syntaxBetween(
  document: YamlDocument,
  kind: YamlSyntaxKind,
  start: number,
  end: number,
  last: boolean,
): Span | null {
  const pieces = document.losslessStructuralIndex().pieces();
  const kinds = document.losslessSyntaxKinds();
  const matches: Span[] = [];
  for (let index = 0; index < pieces.length; index++) {
    if (
      kinds[index] === kind &&
      pieces[index].span().startByte() >= start &&
      pieces[index].span().endByte() <= end
    ) {
      matches.push(pieces[index].span());
    }
  }
  return last ? (matches.length > 0 ? matches[matches.length - 1] : null) : matches[0] ?? null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** validate_dependencies (edit.rs:1974-2014): duplicate targets and one structural mutation per container. */
function validateDependencies(document: YamlDocument, transaction: EditTransaction): void {
  const targets = new Set<string>();
  const structuralContainers = new Set<number>();
  for (const operation of transaction.operations()) {
    let target: NodeRef;
    switch (operation.kind) {
      case 'ReplaceScalar':
        target = operation.operation.target;
        break;
      case 'RenameAnchor':
      case 'RemoveMappingEntry':
      case 'RemoveSequenceElement':
        target = operation.target;
        break;
      case 'InsertMappingEntry':
        target = operation.mapping;
        break;
      case 'InsertSequenceElement':
      case 'InsertAlias':
        target = operation.sequence;
        break;
    }
    if (targets.has(nodeKey(target))) {
      throw new EditFailure('DuplicateTarget');
    }
    targets.add(nodeKey(target));
    let structuralContainer: number | null;
    switch (operation.kind) {
      case 'InsertMappingEntry':
        structuralContainer = resolveNode(document, operation.mapping, 'YamlNode');
        break;
      case 'RemoveMappingEntry':
        structuralContainer = resolveMappingEntry(document, operation.target)[0];
        break;
      case 'InsertSequenceElement':
      case 'InsertAlias':
        structuralContainer = resolveNode(document, operation.sequence, 'YamlNode');
        break;
      case 'RemoveSequenceElement':
        structuralContainer = resolveSequenceItem(document, operation.target)[0];
        break;
      case 'ReplaceScalar':
      case 'RenameAnchor':
        structuralContainer = null;
        break;
    }
    if (structuralContainer !== null) {
      if (structuralContainers.has(structuralContainer)) {
        throw new EditFailure('StructuralContainerConflict');
      }
      structuralContainers.add(structuralContainer);
    }
  }
}

/** validate_removal_dependencies (edit.rs:1398-1418) + collect_owned_nodes (:1420-1442). */
function validateRemovalDependencies(
  document: YamlDocument,
  owned: Span,
  roots: readonly [number, number | null][],
): void {
  const removed = new Set<number>();
  for (const [node, alias] of roots) {
    if (alias === null) {
      collectOwnedNodes(document, node, removed);
    }
  }
  for (const alias of document.aliasesInternal()) {
    if (
      removed.has(alias.target) &&
      !(alias.span.startByte() >= owned.startByte() && alias.span.endByte() <= owned.endByte())
    ) {
      throw new EditFailure('AnchorDependency');
    }
  }
}

function collectOwnedNodes(document: YamlDocument, node: number, output: Set<number>): void {
  if (output.has(node)) {
    return;
  }
  output.add(node);
  const content = document.nodeAt(node).content;
  switch (content.kind) {
    case 'Scalar':
      break;
    case 'Sequence':
      for (const item of content.items) {
        if (item.alias === null) {
          collectOwnedNodes(document, item.node, output);
        }
      }
      break;
    case 'Mapping':
      for (const entry of content.entries) {
        if (entry.keyAlias === null) {
          collectOwnedNodes(document, entry.key, output);
        }
        if (entry.valueAlias === null) {
          collectOwnedNodes(document, entry.value, output);
        }
      }
      break;
  }
}

/** validate_visible_anchor (edit.rs:1346-1396): the last visible definition of the name before the insertion. */
function validateVisibleAnchor(
  document: YamlDocument,
  sequence: number,
  anchor: number,
  insertion: number,
): void {
  const anchorSpan = document.nodeAt(anchor).anchorSpan;
  if (anchorSpan === null) {
    throw new EditFailure('WrongRole');
  }
  const sequenceSpan = document.nodeAt(sequence).span;
  const found = document.documentsInternal().find((document_) => {
    return document_.span.startByte() <= sequenceSpan.startByte() && sequenceSpan.endByte() <= document_.span.endByte();
  });
  if (found === undefined) {
    throw new EditFailure('AnchorNotVisible');
  }
  if (
    anchorSpan.endByte() > insertion ||
    anchorSpan.startByte() < found.span.startByte() ||
    anchorSpan.endByte() > found.span.endByte()
  ) {
    throw new EditFailure('AnchorNotVisible');
  }
  const name = document.nodeAt(anchor).anchor;
  if (name === null) {
    throw new EditFailure('WrongRole');
  }
  let visible: number | null = null;
  let visibleEnd = -1;
  const nodeCount = document.nodeCount();
  for (let index = 0; index < nodeCount; index++) {
    const node = document.nodeAt(index);
    const span = node.anchorSpan;
    if (
      node.anchor === name &&
      span !== null &&
      span.startByte() >= found.span.startByte() &&
      span.endByte() <= insertion
    ) {
      if (span.endByte() > visibleEnd) {
        visibleEnd = span.endByte();
        visible = index;
      }
    }
  }
  if (visible !== anchor) {
    throw new EditFailure('AnchorNotVisible');
  }
}

function validatePreparedOwnership(prepared: readonly PreparedEdit[]): void {
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
}

// ---------------------------------------------------------------------------
// Literal and fragment validation
// ---------------------------------------------------------------------------

function validateLiteral(document: YamlDocument, literal: Uint8Array): void {
  if (literal.length === 0) {
    throw new EditFailure('InvalidLiteral');
  }
  const source = standaloneSource(literal, document.source().encodingFacts().selected());
  let candidate: YamlDocument;
  try {
    candidate = parse(source, document.profileInternal(), document.parseLimits());
  } catch {
    throw new EditFailure('InvalidLiteral');
  }
  if (candidate.documentCount() !== 1) {
    throw new EditFailure('InvalidLiteral');
  }
  const root = candidate.document(0)!.root();
  if (root.kind() !== 'Scalar') {
    throw new EditFailure('InvalidLiteral');
  }
  if (
    root.anchor() !== null ||
    candidate.losslessSyntaxKinds().some((kind) => {
      return (
        kind === 'Tag' ||
        kind === 'Anchor' ||
        kind === 'Alias' ||
        kind === 'Directive' ||
        kind === 'DocumentStart' ||
        kind === 'DocumentEnd' ||
        kind === 'Comment' ||
        kind === 'ErrorRegion'
      );
    })
  ) {
    throw new EditFailure('InvalidLiteral');
  }
}

function validateAnchorName(document: YamlDocument, name: string): void {
  if (name.length === 0 || name.length > document.parseLimits().maxSourceBytes) {
    throw new EditFailure('InvalidAnchorName');
  }
  const source = new TextEncoder().encode(`--- &${name} !!str "x"\n`);
  let candidate: YamlDocument;
  try {
    candidate = parse(
      source,
      document.profileInternal(),
      {
        maxSourceBytes: document.parseLimits().maxSourceBytes,
        maxNestingDepth: 2,
        maxTokenCount: 32,
        maxNodeCount: 8,
        maxDiagnostics: document.parseLimits().maxDiagnostics,
      },
    );
  } catch {
    throw new EditFailure('InvalidAnchorName');
  }
  if (candidate.document(0)?.root().anchor() !== name) {
    throw new EditFailure('InvalidAnchorName');
  }
}

function canonicalScalarFragment(document: YamlDocument, value: PortableValue): CanonicalScalar {
  const request = new MaterializationRequest(
    document.profile(),
    new MaterializationStyleId('yaml.canonical-flow', 1),
  ).withLimits(editMaterializationLimits(document.parseLimits()));
  const result = materializeValue(value, request);
  if (result.kind === 'Failed') {
    const failure = result.value.failure();
    if (failure.kind === 'Unrepresentable') {
      throw new EditFailure('UnsupportedSemanticValue', { valueKind: failure.valueKind });
    }
    if (failure.kind === 'ResourceLimit') {
      throw new EditFailure('ResourceLimit', { limitName: failure.reason });
    }
    throw new EditFailure('NewDocumentFormationFailed');
  }
  const text = result.value.document().source().decodedText();
  if (text === null) {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  const fragment = stripCanonicalDocument(text);
  if (fragment === null) {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  const space = fragment.indexOf(' ');
  if (space === -1) {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  const scalar = result.value.document().document(0)!.root().scalar();
  if (scalar === null) {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  return {
    tag: fragment.slice(0, space),
    literal: fragment.slice(space + 1),
    canonical: scalar.canonical(),
  };
}

function canonicalValueFragment(document: YamlDocument, value: PortableValue): string {
  const request = new MaterializationRequest(
    document.profile(),
    new MaterializationStyleId('yaml.canonical-flow', 1),
  ).withLimits(editMaterializationLimits(document.parseLimits()));
  const result = materializeValue(value, request);
  if (result.kind === 'Failed') {
    const failure = result.value.failure();
    if (failure.kind === 'Unrepresentable') {
      throw new EditFailure('UnsupportedInsertedValue', { valueKind: failure.valueKind });
    }
    if (failure.kind === 'ResourceLimit') {
      throw new EditFailure('ResourceLimit', { limitName: failure.reason });
    }
    throw new EditFailure('NewDocumentFormationFailed');
  }
  const text = result.value.document().source().decodedText();
  if (text === null) {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  const fragment = stripCanonicalDocument(text);
  if (fragment === null) {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  return fragment;
}

function stripCanonicalDocument(text: string): string | null {
  if (!text.startsWith('--- ')) {
    return null;
  }
  const withoutStart = text.slice(4);
  if (!withoutStart.endsWith('\n')) {
    return null;
  }
  return withoutStart.slice(0, -1);
}

function preservedLiteral(
  oldKind: YamlScalarKind,
  oldStyle: YamlScalarStyle,
  oldTag: string,
  explicitTag: boolean,
  canonical: CanonicalScalar,
  valueKind: Kind,
  profile: YamlProfile,
): string | null {
  if (oldKind !== yamlKind(valueKind) || oldTag !== shorthandTagUri(canonical.tag)) {
    return null;
  }
  const decoded = decodeCanonicalLiteral(canonical.literal);
  if (decoded === null) {
    return null;
  }
  switch (oldStyle) {
    case 'DoubleQuoted':
      return canonical.literal;
    case 'SingleQuoted':
      if (!decoded.includes('\n') && !decoded.includes('\r')) {
        return `'${decoded.replace(/'/g, "''")}'`;
      }
      return null;
    case 'Plain': {
      const source = explicitTag ? `${canonical.tag} ${decoded}` : decoded;
      let candidate: YamlDocument;
      try {
        candidate = parse(new TextEncoder().encode(source), profile, defaultParseLimits());
      } catch {
        return null;
      }
      const scalar = candidate.document(0)?.root().scalar() ?? null;
      if (scalar === null) {
        return null;
      }
      return scalar.kind() === oldKind && scalar.canonical() === canonical.canonical
        ? decoded
        : null;
    }
    case 'Literal':
    case 'Folded':
      return null;
  }
}

function decodeCanonicalLiteral(literal: string): string | null {
  let candidate: YamlDocument;
  try {
    candidate = parse(new TextEncoder().encode(literal), 'Yaml12CoreV1', defaultParseLimits());
  } catch {
    return null;
  }
  const scalar = candidate.document(0)?.root().scalar() ?? null;
  return scalar === null ? null : scalar.decoded();
}

function shorthandTagUri(tag: string): string | null {
  switch (tag) {
    case '!!null':
      return TAG_NULL;
    case '!!bool':
      return TAG_BOOL;
    case '!!int':
      return TAG_INT;
    case '!!float':
      return TAG_FLOAT;
    case '!!str':
      return TAG_STR;
    case '!!timestamp':
      return TAG_TIMESTAMP;
    case '!!binary':
      return TAG_BINARY;
    default:
      return null;
  }
}

function yamlKind(kind: Kind): YamlScalarKind {
  switch (kind) {
    case 'Null':
      return 'Null';
    case 'Boolean':
      return 'Boolean';
    case 'Integer':
      return 'Integer';
    case 'Decimal':
    case 'BinaryFloat64':
      return 'Float';
    case 'String':
      return 'String';
    case 'Bytes':
      return 'Binary';
    case 'Date':
    case 'OffsetDateTime':
      return 'Timestamp';
    default:
      return 'Custom';
  }
}

function isScalarValue(kind: Kind): boolean {
  return kind !== 'Sequence' && kind !== 'Object' && kind !== 'EntryMapping';
}

function pushFallbackDiagnostic(diagnostics: Diagnostic[], span: Span): void {
  diagnostics.push(
    diagnostic(
      'yaml.edit.canonical-fallback@1',
      'Edit',
      'Info',
      span.diagnosticLocation(),
      BigInt(diagnostics.length),
    ),
  );
}

function standaloneSource(fragment: Uint8Array, encoding: SourceEncoding): Uint8Array {
  switch (encoding.kind) {
    case 'Utf8':
      return Uint8Array.from(fragment);
    case 'Utf16Le':
      return Uint8Array.from([0xff, 0xfe, ...fragment]);
    case 'Utf16Be':
      return Uint8Array.from([0xfe, 0xff, ...fragment]);
    default:
      throw new EditFailure('InvalidLiteral');
  }
}

function encodeFragment(document: YamlDocument, text: string): Uint8Array {
  const encoding = document.source().encodingFacts().selected();
  const max = document.parseLimits().maxSourceBytes;
  switch (encoding.kind) {
    case 'Utf8': {
      const bytes = new TextEncoder().encode(text);
      if (bytes.length > max) {
        throw new EditFailure('ResourceLimit', { limitName: 'replacement-bytes' });
      }
      return bytes;
    }
    case 'Utf16Le':
    case 'Utf16Be': {
      const units = text.length;
      const length = units * 2;
      if (length > max) {
        throw new EditFailure('ResourceLimit', { limitName: 'replacement-bytes' });
      }
      const output: number[] = [];
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (encoding.kind === 'Utf16Le') {
          output.push(code & 0xff, code >> 8);
        } else {
          output.push(code >> 8, code & 0xff);
        }
      }
      return Uint8Array.from(output);
    }
    default:
      throw new EditFailure('InvalidLiteral');
  }
}

function editMaterializationLimits(limits: ParseLimits): MaterializationLimits {
  return {
    maxInputNodes: limits.maxNodeCount,
    maxOutputBytes: limits.maxSourceBytes,
    maxDepth: limits.maxNestingDepth,
    maxReportEntries: limits.maxDiagnostics,
    maxProvenanceEntries: limits.maxNodeCount * 4,
  };
}

function sourcePatchLimits(limits: ParseLimits, operationCount: number): SourcePatchLimits {
  return {
    source: {
      maxRawBytes: limits.maxSourceBytes,
      maxDecodedUtf8Bytes: limits.maxSourceBytes * 2,
      maxDecodedScalars: limits.maxSourceBytes,
    },
    maxReplacements: operationCount,
    maxPatchBytes: limits.maxSourceBytes * 2,
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
        ? 'yaml.edit.replace-scalar-semantic@1'
        : 'yaml.edit.replace-scalar-literal@1';
    case 'RenameAnchor':
      return 'yaml.edit.rename-anchor@1';
    case 'InsertMappingEntry':
      return 'yaml.edit.insert-mapping-entry@1';
    case 'RemoveMappingEntry':
      return 'yaml.edit.remove-mapping-entry@1';
    case 'InsertSequenceElement':
      return 'yaml.edit.insert-sequence-element@1';
    case 'RemoveSequenceElement':
      return 'yaml.edit.remove-sequence-element@1';
    case 'InsertAlias':
      return 'yaml.edit.insert-alias@1';
  }
}

function operationSummaries(transaction: EditTransaction): EditOperationSummary[] {
  return transaction.operations().map((operation) => {
    let id: string;
    let role: string;
    const arguments_ = new Map<string, string>();
    switch (operation.kind) {
      case 'ReplaceScalar':
        if (operation.operation.kind === 'Semantic') {
          id = 'yaml.edit.replace-scalar-semantic';
          role = 'yaml.scalar@1';
          arguments_.set('policy', policyName(operation.operation.policy));
          arguments_.set('value_kind', operation.operation.value.kind);
        } else {
          id = 'yaml.edit.replace-scalar-literal';
          role = 'yaml.scalar@1';
          arguments_.set('literal_bytes', String(operation.operation.literal.length));
        }
        break;
      case 'RenameAnchor':
        id = 'yaml.edit.rename-anchor';
        role = 'yaml.anchor-definition@1';
        arguments_.set('name_bytes', String(operation.name.length));
        break;
      case 'InsertMappingEntry':
        id = 'yaml.edit.insert-mapping-entry';
        role = 'yaml.mapping@1';
        arguments_.set('key_kind', operation.key.kind);
        arguments_.set('value_kind', operation.value.kind);
        arguments_.set('placement', placementName(operation.placement));
        break;
      case 'RemoveMappingEntry':
        id = 'yaml.edit.remove-mapping-entry';
        role = 'yaml.mapping-entry@1';
        break;
      case 'InsertSequenceElement':
        id = 'yaml.edit.insert-sequence-element';
        role = 'yaml.sequence@1';
        arguments_.set('value_kind', operation.value.kind);
        arguments_.set('placement', placementName(operation.placement));
        break;
      case 'RemoveSequenceElement':
        id = 'yaml.edit.remove-sequence-element';
        role = 'yaml.sequence-element@1';
        break;
      case 'InsertAlias':
        id = 'yaml.edit.insert-alias';
        role = 'yaml.sequence@1';
        arguments_.set('placement', placementName(operation.placement));
        break;
    }
    arguments_.set('target_role', role);
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

// ---------------------------------------------------------------------------
// Candidate validation (the cycle-safe representation-graph isomorphism)
// ---------------------------------------------------------------------------

function validateCandidate(
  document: YamlDocument,
  candidate: YamlDocument,
  transaction: EditTransaction,
): CandidateMap {
  if (transaction.operations().some(isStructuralOperation)) {
    return validateStructuralCandidate(document, candidate, transaction);
  }
  const scalarTargets = new Set<number>();
  const renames = new Map<number, string>();
  for (const operation of transaction.operations()) {
    switch (operation.kind) {
      case 'ReplaceScalar':
        scalarTargets.add(resolveNode(document, operation.operation.target, 'YamlNode'));
        break;
      case 'RenameAnchor':
        renames.set(resolveNode(document, operation.target, 'YamlAnchorDefinition'), operation.name);
        break;
      case 'InsertMappingEntry':
      case 'RemoveMappingEntry':
      case 'InsertSequenceElement':
      case 'RemoveSequenceElement':
      case 'InsertAlias':
        throw new Error('internal: structural transactions use structural validation');
    }
  }
  if (
    document.documentsInternal().length !== candidate.documentsInternal().length ||
    document.nodeCount() !== candidate.nodeCount() ||
    document.aliasesInternal().length !== candidate.aliasesInternal().length
  ) {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  const documents = document.documentsInternal();
  const candidateDocuments = candidate.documentsInternal();
  for (let index = 0; index < documents.length; index++) {
    if (documents[index].root !== candidateDocuments[index].root) {
      throw new EditFailure('NewDocumentFormationFailed');
    }
  }
  for (let index = 0; index < document.nodeCount(); index++) {
    const oldNode = document.nodeAt(index);
    const newNode = candidate.nodeAt(index);
    const expectedAnchor = renames.get(index) ?? oldNode.anchor;
    if (
      newNode.anchor !== expectedAnchor ||
      !sameTopology(oldNode.content, newNode.content) ||
      (!scalarTargets.has(index) &&
        (oldNode.tag !== newNode.tag || !sameScalarSemantics(oldNode.content, newNode.content)))
    ) {
      throw new EditFailure('NewDocumentFormationFailed');
    }
  }
  const oldAliases = document.aliasesInternal();
  const newAliases = candidate.aliasesInternal();
  for (let index = 0; index < oldAliases.length; index++) {
    const expectedName = renames.get(oldAliases[index].target) ?? oldAliases[index].name;
    if (oldAliases[index].target !== newAliases[index].target || newAliases[index].name !== expectedName) {
      throw new EditFailure('NewDocumentFormationFailed');
    }
  }
  const nodes = new Map<number, number>();
  for (let index = 0; index < document.nodeCount(); index++) {
    nodes.set(index, index);
  }
  const aliases = new Map<number, number>();
  for (let index = 0; index < oldAliases.length; index++) {
    aliases.set(index, index);
  }
  return { nodes, aliases };
}

function isStructuralOperation(operation: EditOperation): boolean {
  return (
    operation.kind === 'InsertMappingEntry' ||
    operation.kind === 'RemoveMappingEntry' ||
    operation.kind === 'InsertSequenceElement' ||
    operation.kind === 'RemoveSequenceElement' ||
    operation.kind === 'InsertAlias'
  );
}

function validateStructuralCandidate(
  document: YamlDocument,
  candidate: YamlDocument,
  transaction: EditTransaction,
): CandidateMap {
  if (document.documentsInternal().length !== candidate.documentsInternal().length) {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  const expected = ValidationModel.fromDocument(document, true);
  for (const operation of transaction.operations()) {
    switch (operation.kind) {
      case 'ReplaceScalar': {
        if (operation.operation.kind !== 'Semantic') {
          const target = resolveNode(document, operation.operation.target, 'YamlNode');
          if (expected.nodes[target].content.kind !== 'Scalar') {
            throw new EditFailure('WrongRole');
          }
          expected.nodes[target].scalarWildcard = true;
          break;
        }
        const target = resolveNode(document, operation.operation.target, 'YamlNode');
        if (expected.nodes[target].content.kind !== 'Scalar') {
          throw new EditFailure('WrongRole');
        }
        const imported = expected.appendRoot(validationModelForValue(document, operation.operation.value));
        const replacement = expected.nodes[imported];
        expected.nodes[target].tag = replacement.tag;
        expected.nodes[target].content = replacement.content;
        expected.nodes[target].scalarWildcard = false;
        break;
      }
      case 'RenameAnchor': {
        const target = resolveNode(document, operation.target, 'YamlAnchorDefinition');
        const oldName = expected.nodes[target].anchor;
        if (oldName === null) {
          throw new EditFailure('WrongRole');
        }
        expected.nodes[target].anchor = operation.name;
        for (const node of expected.nodes) {
          switch (node.content.kind) {
            case 'Scalar':
              break;
            case 'Sequence':
              for (const edge of node.content.items) {
                if (edge.target === target && edge.alias !== null && edge.alias.name === oldName) {
                  edge.alias.name = operation.name;
                }
              }
              break;
            case 'Mapping':
              for (const entry of node.content.entries) {
                for (const edge of [entry.key, entry.value]) {
                  if (edge.target === target && edge.alias !== null && edge.alias.name === oldName) {
                    edge.alias.name = operation.name;
                  }
                }
              }
              break;
          }
        }
        break;
      }
      case 'InsertMappingEntry': {
        const container = resolveNode(document, operation.mapping, 'YamlNode');
        const base = document.nodeAt(container).content;
        if (base.kind !== 'Mapping') {
          throw new EditFailure('WrongRole');
        }
        const ordinal = mappingPlacement(document, container, base.entries, operation.placement);
        const key = expected.appendRoot(validationModelForValue(document, operation.key));
        const value = expected.appendRoot(validationModelForValue(document, operation.value));
        const entries = expected.nodes[container].content;
        if (entries.kind !== 'Mapping') {
          throw new EditFailure('NewDocumentFormationFailed');
        }
        entries.entries.splice(ordinal, 0, {
          key: { target: key, alias: null },
          value: { target: value, alias: null },
        });
        break;
      }
      case 'RemoveMappingEntry': {
        const [container, ordinal] = resolveMappingEntry(document, operation.target);
        const entries = expected.nodes[container].content;
        if (entries.kind !== 'Mapping') {
          throw new EditFailure('NewDocumentFormationFailed');
        }
        entries.entries.splice(ordinal, 1);
        break;
      }
      case 'InsertSequenceElement': {
        const container = resolveNode(document, operation.sequence, 'YamlNode');
        const base = document.nodeAt(container).content;
        if (base.kind !== 'Sequence') {
          throw new EditFailure('WrongRole');
        }
        const ordinal = sequencePlacement(document, container, base.items, operation.placement);
        const target = expected.appendRoot(validationModelForValue(document, operation.value));
        const items = expected.nodes[container].content;
        if (items.kind !== 'Sequence') {
          throw new EditFailure('NewDocumentFormationFailed');
        }
        items.items.splice(ordinal, 0, { target, alias: null });
        break;
      }
      case 'RemoveSequenceElement': {
        const [container, ordinal] = resolveSequenceItem(document, operation.target);
        const items = expected.nodes[container].content;
        if (items.kind !== 'Sequence') {
          throw new EditFailure('NewDocumentFormationFailed');
        }
        items.items.splice(ordinal, 1);
        break;
      }
      case 'InsertAlias': {
        const container = resolveNode(document, operation.sequence, 'YamlNode');
        const target = resolveNode(document, operation.anchor, 'YamlAnchorDefinition');
        const base = document.nodeAt(container).content;
        if (base.kind !== 'Sequence') {
          throw new EditFailure('WrongRole');
        }
        const ordinal = sequencePlacement(document, container, base.items, operation.placement);
        const name = document.nodeAt(target).anchor;
        if (name === null) {
          throw new EditFailure('WrongRole');
        }
        const items = expected.nodes[container].content;
        if (items.kind !== 'Sequence') {
          throw new EditFailure('NewDocumentFormationFailed');
        }
        items.items.splice(ordinal, 0, {
          target,
          alias: { name, sourceAlias: null },
        });
        break;
      }
    }
  }
  const result = expected.compare(ValidationModel.fromDocument(candidate, true));
  if (result === null) {
    throw new EditFailure('NewDocumentFormationFailed');
  }
  return result;
}

function validationModelForValue(document: YamlDocument, value: PortableValue): ValidationModel {
  const request = new MaterializationRequest(
    document.profile(),
    new MaterializationStyleId('yaml.canonical-flow', 1),
  ).withLimits(editMaterializationLimits(document.parseLimits()));
  const result = materializeValue(value, request);
  if (result.kind === 'Failed') {
    const failure = result.value.failure();
    if (failure.kind === 'Unrepresentable') {
      throw new EditFailure('UnsupportedInsertedValue', { valueKind: failure.valueKind });
    }
    if (failure.kind === 'ResourceLimit') {
      throw new EditFailure('ResourceLimit', { limitName: failure.reason });
    }
    throw new EditFailure('NewDocumentFormationFailed');
  }
  return ValidationModel.fromDocument(result.value.document(), false);
}

// ---------------------------------------------------------------------------
// Validation model (edit.rs:2024-2317)
// ---------------------------------------------------------------------------

interface ValidationNode {
  tag: string;
  anchor: string | null;
  content: ValidationContent;
  sourceNode: number | null;
  scalarWildcard: boolean;
}

type ValidationContent =
  | { readonly kind: 'Scalar'; readonly scalarKind: YamlScalarKind; readonly canonical: string }
  | { readonly kind: 'Sequence'; readonly items: ValidationEdge[] }
  | { readonly kind: 'Mapping'; readonly entries: ValidationMappingEntry[] };

interface ValidationEdge {
  target: number;
  alias: ValidationAlias | null;
}

interface ValidationAlias {
  name: string;
  sourceAlias: number | null;
}

interface ValidationMappingEntry {
  key: ValidationEdge;
  value: ValidationEdge;
}

class ValidationModel {
  readonly #roots: number[];
  // Not `#private`: the structural validation loop mutates expected nodes
  // (scalar wildcards, renamed anchors, inserted edges) from outside the
  // class; the class is private to this module.
  readonly nodes: ValidationNode[];

  private constructor(roots: number[], nodes: ValidationNode[]) {
    this.#roots = roots;
    this.nodes = nodes;
  }

  static fromDocument(document: YamlDocument, retainSource: boolean): ValidationModel {
    const nodes: ValidationNode[] = [];
    const nodeCount = document.nodeCount();
    for (let index = 0; index < nodeCount; index++) {
      const node = document.nodeAt(index);
      let content: ValidationContent;
      switch (node.content.kind) {
        case 'Scalar':
          content = {
            kind: 'Scalar',
            scalarKind: node.content.scalar.kind,
            canonical: node.content.scalar.canonical,
          };
          break;
        case 'Sequence':
          content = {
            kind: 'Sequence',
            items: node.content.items.map((item) => ({
              target: item.node,
              alias:
                item.alias === null
                  ? null
                  : {
                      name: document.aliasesInternal()[item.alias].name,
                      sourceAlias: retainSource ? item.alias : null,
                    },
            })),
          };
          break;
        case 'Mapping':
          content = {
            kind: 'Mapping',
            entries: node.content.entries.map((entry) => ({
              key: {
                target: entry.key,
                alias:
                  entry.keyAlias === null
                    ? null
                    : {
                        name: document.aliasesInternal()[entry.keyAlias].name,
                        sourceAlias: retainSource ? entry.keyAlias : null,
                      },
              },
              value: {
                target: entry.value,
                alias:
                  entry.valueAlias === null
                    ? null
                    : {
                        name: document.aliasesInternal()[entry.valueAlias].name,
                        sourceAlias: retainSource ? entry.valueAlias : null,
                      },
              },
            })),
          };
          break;
      }
      nodes.push({
        tag: node.tag,
        anchor: node.anchor,
        content,
        sourceNode: retainSource ? index : null,
        scalarWildcard: false,
      });
    }
    return new ValidationModel(
      document.documentsInternal().map((document_) => document_.root),
      nodes,
    );
  }

  appendRoot(imported: ValidationModel): number {
    if (imported.#roots.length !== 1) {
      throw new EditFailure('NewDocumentFormationFailed');
    }
    const offset = this.nodes.length;
    for (const node of imported.nodes) {
      node.sourceNode = null;
      switch (node.content.kind) {
        case 'Scalar':
          break;
        case 'Sequence':
          for (const edge of node.content.items) {
            edge.target += offset;
            if (edge.alias !== null) {
              edge.alias.sourceAlias = null;
            }
          }
          break;
        case 'Mapping':
          for (const entry of node.content.entries) {
            for (const edge of [entry.key, entry.value]) {
              edge.target += offset;
              if (edge.alias !== null) {
                edge.alias.sourceAlias = null;
              }
            }
          }
          break;
      }
    }
    this.nodes.push(...imported.nodes);
    return imported.#roots[0] + offset;
  }

  compare(candidate: ValidationModel): CandidateMap | null {
    if (this.#roots.length !== candidate.#roots.length) {
      return null;
    }
    const nodePairs = new Map<number, number>();
    const actualNodes = new Set<number>();
    const output: CandidateMap = { nodes: new Map(), aliases: new Map() };
    for (let index = 0; index < this.#roots.length; index++) {
      if (!this.#compareNode(candidate, this.#roots[index], candidate.#roots[index], nodePairs, actualNodes, output)) {
        return null;
      }
    }
    if (nodePairs.size !== this.#reachableCount() || actualNodes.size !== candidate.#reachableCount()) {
      return null;
    }
    return output;
  }

  #compareNode(
    candidate: ValidationModel,
    expected: number,
    actual: number,
    nodePairs: Map<number, number>,
    actualNodes: Set<number>,
    output: CandidateMap,
  ): boolean {
    const mapped = nodePairs.get(expected);
    if (mapped !== undefined) {
      return mapped === actual;
    }
    if (actualNodes.has(actual)) {
      return false;
    }
    actualNodes.add(actual);
    const expectedNode = this.nodes[expected];
    const actualNode = candidate.nodes[actual];
    if (expectedNode === undefined || actualNode === undefined) {
      return false;
    }
    nodePairs.set(expected, actual);
    if (expectedNode.sourceNode !== null) {
      output.nodes.set(expectedNode.sourceNode, actual);
    }
    if (expectedNode.anchor !== actualNode.anchor) {
      return false;
    }
    if (expectedNode.scalarWildcard) {
      return (
        expectedNode.content.kind === 'Scalar' && actualNode.content.kind === 'Scalar'
      );
    }
    if (expectedNode.tag !== actualNode.tag) {
      return false;
    }
    const left = expectedNode.content;
    const right = actualNode.content;
    if (
      left.kind === 'Scalar' &&
      right.kind === 'Scalar' &&
      left.scalarKind === right.scalarKind &&
      left.canonical === right.canonical
    ) {
      return true;
    }
    if (left.kind === 'Sequence' && right.kind === 'Sequence' && left.items.length === right.items.length) {
      for (let index = 0; index < left.items.length; index++) {
        if (!this.#compareEdge(candidate, left.items[index], right.items[index], nodePairs, actualNodes, output)) {
          return false;
        }
      }
      return true;
    }
    if (left.kind === 'Mapping' && right.kind === 'Mapping' && left.entries.length === right.entries.length) {
      for (let index = 0; index < left.entries.length; index++) {
        if (
          !this.#compareEdge(candidate, left.entries[index].key, right.entries[index].key, nodePairs, actualNodes, output) ||
          !this.#compareEdge(candidate, left.entries[index].value, right.entries[index].value, nodePairs, actualNodes, output)
        ) {
          return false;
        }
      }
      return true;
    }
    return false;
  }

  #compareEdge(
    candidate: ValidationModel,
    expected: ValidationEdge,
    actual: ValidationEdge,
    nodePairs: Map<number, number>,
    actualNodes: Set<number>,
    output: CandidateMap,
  ): boolean {
    if (expected.alias === null || actual.alias === null) {
      if (expected.alias !== actual.alias) {
        return false;
      }
    } else if (expected.alias.name !== actual.alias.name) {
      return false;
    } else if (expected.alias.sourceAlias !== null && actual.alias.sourceAlias !== null) {
      output.aliases.set(expected.alias.sourceAlias, actual.alias.sourceAlias);
    }
    return this.#compareNode(candidate, expected.target, actual.target, nodePairs, actualNodes, output);
  }

  #reachableCount(): number {
    const reached = new Set<number>();
    const pending = [...this.#roots];
    while (pending.length > 0) {
      const index = pending.pop()!;
      if (reached.has(index)) {
        continue;
      }
      reached.add(index);
      const node = this.nodes[index];
      if (node === undefined) {
        continue;
      }
      switch (node.content.kind) {
        case 'Scalar':
          break;
        case 'Sequence':
          pending.push(...node.content.items.map((item) => item.target));
          break;
        case 'Mapping':
          for (const entry of node.content.entries) {
            pending.push(entry.key.target, entry.value.target);
          }
          break;
      }
    }
    return reached.size;
  }
}

function sameTopology(
  old: import('./document.ts').InternalContent,
  new_: import('./document.ts').InternalContent,
): boolean {
  if (old.kind === 'Scalar' && new_.kind === 'Scalar') {
    return true;
  }
  if (old.kind === 'Sequence' && new_.kind === 'Sequence') {
    if (old.items.length !== new_.items.length) {
      return false;
    }
    for (let index = 0; index < old.items.length; index++) {
      if (
        old.items[index].node !== new_.items[index].node ||
        (old.items[index].alias === null) !== (new_.items[index].alias === null)
      ) {
        return false;
      }
    }
    return true;
  }
  if (old.kind === 'Mapping' && new_.kind === 'Mapping') {
    if (old.entries.length !== new_.entries.length) {
      return false;
    }
    for (let index = 0; index < old.entries.length; index++) {
      const a = old.entries[index];
      const b = new_.entries[index];
      if (
        a.key !== b.key ||
        a.value !== b.value ||
        (a.keyAlias === null) !== (b.keyAlias === null) ||
        (a.valueAlias === null) !== (b.valueAlias === null)
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function sameScalarSemantics(
  old: import('./document.ts').InternalContent,
  new_: import('./document.ts').InternalContent,
): boolean {
  if (old.kind === 'Scalar' && new_.kind === 'Scalar') {
    return old.scalar.canonical === new_.scalar.canonical && old.scalar.kind === new_.scalar.kind;
  }
  return true;
}

function nodeKey(node: NodeRef): string {
  return `${node.snapshot().asBigInt().toString()}:${node.index().toString()}:${node.role()}`;
}

function defaultParseLimits(): ParseLimits {
  return {
    maxSourceBytes: 64 * 1024 * 1024,
    maxNestingDepth: 256,
    maxTokenCount: 2_000_000,
    maxNodeCount: 1_000_000,
    maxDiagnostics: 10_000,
  };
}
