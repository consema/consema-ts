/**
 * The immutable HCL document snapshot, its native entity model, and its
 * formation surface (RFC 0014 §1, §3, §5, §6).
 *
 * authority:
 *  - profile layer: crates/consema-hcl/src/document.rs:50-116 — the tfvars
 *    gate (:95-108, one `hcl.tfvars.block-not-allowed@1` per top-level block,
 *    primary = block span; the rejected block remains a native item),
 *    deterministic diagnostic merge (:109), the Document facts (:118-260:
 *    status, source, render, diagnostics, snapshot identity, format family,
 *    profile, error regions, lossless index, syntax kinds, parse limits,
 *    native handles)
 *  - encoding selection: crates/consema-hcl/src/lib.rs:120-162 (the
 *    UTF-8-only contract; a non-UTF-8 explicit selection fails fatally
 *    with `hcl.parse.encoding@1` before any byte is read, lib.rs:290-310)
 *  - native model: crates/consema-hcl/src/native.rs:28-291 (HclDocument,
 *    HclBody, HclBodyItem, HclAttribute, HclBlock, HclBlockLabel,
 *    HclErrorRegion)
 *  - roles: crates/consema-document/src/lib.rs:229-250 (HclDocument,
 *    HclBody, HclAttribute, HclBlock, HclBlockLabel, HclExpression,
 *    HclTemplatePart, HclErrorRegion, HclSyntaxPiece — pinned in
 *    typescript/src/document/identity.ts:171-179)
 *
 * Design (TypeScript-idiomatic): formation produces an immutable class over
 * a flat entity array; every native node (body, item, attribute, block,
 * label, expression, template part, error region) is one pre-order entity
 * with a snapshot-bound handle. The pre-order walk follows the documented
 * ordinal scheme of projection.rs:124-130: the root body first, then each
 * item in source order; an attribute consumes one ordinal for itself and
 * then every node of its expression subtree; a block consumes one ordinal
 * for itself, one per label, and then its nested body's items. Expression
 * AST children are direct nested references; the document keeps the
 * node-to-entity map so every child resolves to a stable NodeRef.
 */

import { DocumentAuthority } from '../document/identity.ts';
import type { NodeRef, NodeRole, SnapshotIdentity, Span } from '../document/identity.ts';
import { FormatFamilyId, ProfileId } from '../document/profile.ts';
import type { FormationStatus } from '../document/formation.ts';
import { LosslessStructuralIndex } from '../document/structural.ts';
import { SourceSnapshot } from '../document/source.ts';
import type { SourceEncoding } from '../document/source.ts';
import { SourceError } from '../document/errors.ts';
import { diagnostic as makeDiagnostic, sortDiagnostics } from '../document/diagnostic.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { HclAccessError, HclFormationFailure, codeHclParseInvalidUtf8, codeHclParseEncoding, codeHclTfvarsBlockNotAllowed } from './errors.ts';
import type { HclParseLimits } from './limits.ts';
import { HclProfile } from './profile.ts';
import type { HclSyntaxKind } from './tokenizer.ts';
import type { HclExpr, HclTemplatePart } from './expression.ts';
import { parseHclTokens } from './parser.ts';
import type { ParsedBody, ParsedFormed, ParsedItem } from './parser.ts';

// ---------------------------------------------------------------------------
// Encoding selection (lib.rs:120-162)
// ---------------------------------------------------------------------------

/**
 * Explicit source-encoding selection for the UTF-8-only HCL source contract
 * (RFC 0014 §2). Only UTF-8 is consistent with the profile; any other
 * explicit encoding is a source-contract conflict at formation.
 */
export type HclEncodingSelection =
  | { readonly kind: 'ProfileDefault' }
  | { readonly kind: 'Explicit'; readonly encoding: SourceEncoding };

/** The frozen profile default: UTF-8. */
export function profileDefaultEncoding(): HclEncodingSelection {
  return { kind: 'ProfileDefault' };
}

/** One caller-selected encoding; only UTF-8 is consistent with the profile. */
export function explicitEncoding(encoding: SourceEncoding): HclEncodingSelection {
  return { kind: 'Explicit', encoding };
}

/** Validates the selection against the UTF-8-only source contract (lib.rs:145-151). */
export function validateHclEncodingSelection(selection: HclEncodingSelection): boolean {
  switch (selection.kind) {
    case 'ProfileDefault':
      return true;
    case 'Explicit':
      return selection.encoding.kind === 'Utf8';
  }
}

// ---------------------------------------------------------------------------
// The native entity model (RFC 0014 §6)
// ---------------------------------------------------------------------------

/** One flat entity of the document's pre-order arena. */
export type HclEntity =
  | { readonly role: 'Body'; readonly span: Span; readonly items: readonly number[] }
  | { readonly role: 'Attribute'; readonly span: Span; readonly name: string; readonly nameSpan: Span; readonly equalsSpan: Span; readonly expression: number }
  | { readonly role: 'Block'; readonly span: Span; readonly type: string; readonly labels: readonly number[]; readonly body: number }
  | { readonly role: 'BlockLabel'; readonly span: Span; readonly text: string; readonly quoted: boolean }
  | { readonly role: 'Expression'; readonly span: Span; readonly kind: HclExpr }
  | { readonly role: 'TemplatePart'; readonly span: Span; readonly part: HclTemplatePart }
  | { readonly role: 'ErrorRegion'; readonly span: Span; readonly code: string };

/** One error region fact (native.rs:293-325). */
export interface HclErrorRegionFact {
  readonly span: Span;
  readonly code: string;
}

/** One recovered error region with its stable code (RFC 0014 §3, §7.1). */
export class HclErrorRegion {
  readonly #document: HclDocument;
  readonly #index: number;

  constructor(document: HclDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Exact region identity (NodeRole::HclErrorRegion). */
  nodeRef(): NodeRef {
    return this.#document.nodeRef(this.#index, 'HclErrorRegion');
  }

  /** Exact recovered region span. */
  span(): Span {
    return this.#document.errorRegionEntity(this.#index).span;
  }

  /** Stable `hcl.parse.*@1` diagnostic code of the region. */
  code(): string {
    return this.#document.errorRegionEntity(this.#index).code;
  }

  /** @internal */
  index(): number {
    return this.#index;
  }
}

/**
 * Forms one `hcl.native@1` or `hcl.tfvars@1` document from raw bytes
 * (lib.rs:290-310; RFC 0014 §1, §3, §5). Throws HclFormationFailure on any
 * fatal condition; a truncated success never exists.
 */
export function parseHcl(
  sourceBytes: Uint8Array,
  profile: HclProfile,
  selection: HclEncodingSelection,
  limits: HclParseLimits,
): HclDocument {
  if (!validateHclEncodingSelection(selection)) {
    throw new HclFormationFailure('Encoding', { parserReason: codeHclParseEncoding });
  }
  if (sourceBytes.length > limits.common.maxSourceBytes) {
    throw new HclFormationFailure('ResourceLimit', {
      limitName: 'source_bytes',
      observed: sourceBytes.length,
      limit: limits.common.maxSourceBytes,
    });
  }
  let source: SourceSnapshot;
  try {
    source = SourceSnapshot.fromUtf8(sourceBytes);
  } catch (error) {
    if (error instanceof SourceError && error.kind === 'InvalidUtf8') {
      throw new HclFormationFailure('Source', { parserReason: codeHclParseInvalidUtf8 });
    }
    throw error;
  }
  const decoded = source.decodedText()!;
  const decodedUtf8Bytes = new TextEncoder().encode(decoded).length;
  if (decodedUtf8Bytes > limits.maxDecodedUtf8Bytes) {
    throw new HclFormationFailure('ResourceLimit', {
      limitName: 'decoded-utf8-bytes',
      observed: decodedUtf8Bytes,
      limit: limits.maxDecodedUtf8Bytes,
    });
  }
  let scalars = 0;
  for (const _ of decoded) {
    scalars += 1;
  }
  if (scalars > limits.maxDecodedScalars) {
    throw new HclFormationFailure('ResourceLimit', {
      limitName: 'decoded-scalars',
      observed: scalars,
      limit: limits.maxDecodedScalars,
    });
  }
  const authority = DocumentAuthority.fresh();
  const formed = parseHclTokens(sourceBytes, decoded, authority, limits);
  return HclDocument.fromFormed(authority, source, profile, formed, limits);
}

/** The immutable HCL document snapshot (document.rs:57-67; RFC 0014 §6). */
export class HclDocument {
  readonly #authority: DocumentAuthority;
  readonly #source: SourceSnapshot;
  readonly #profile: HclProfile;
  readonly #formed: ParsedFormed;
  readonly #parseLimits: HclParseLimits;
  readonly #entities: readonly HclEntity[];
  readonly #rootBody: number;
  readonly #structuralIndex: LosslessStructuralIndex;
  readonly #status: FormationStatus;
  readonly #diagnostics: readonly Diagnostic[];
  readonly #nodeMap: ReadonlyMap<object, number>;

  private constructor(
    authority: DocumentAuthority,
    source: SourceSnapshot,
    profile: HclProfile,
    formed: ParsedFormed,
    limits: HclParseLimits,
    entities: readonly HclEntity[],
    rootBody: number,
    nodeMap: ReadonlyMap<object, number>,
  ) {
    this.#authority = authority;
    this.#source = source;
    this.#profile = profile;
    this.#formed = formed;
    this.#parseLimits = limits;
    this.#entities = Object.freeze([...entities]);
    this.#rootBody = rootBody;
    this.#nodeMap = nodeMap;
    this.#structuralIndex = LosslessStructuralIndex.create(authority.identity(), source.len(), formed.pieces ?? []);
    const tfvarsBlock = profile.isTfvars() && hasTopLevelBlock(formed.body.items);
    this.#status = formed.recovered || tfvarsBlock ? 'Recovered' : 'Complete';
    const diagnostics = [...formed.diagnostics];
    if (tfvarsBlock) {
      for (const item of formed.body.items) {
        if (item.kind === 'block') {
          diagnostics.push(
            makeDiagnostic(codeHclTfvarsBlockNotAllowed, 'Syntax', 'Error', item.block.span.diagnosticLocation(), 0n),
          );
        }
      }
    }
    this.#diagnostics = Object.freeze(sortDiagnostics(diagnostics));
  }

  /** @internal — assembles the entity arena from one parsed body tree. */
  static fromFormed(
    authority: DocumentAuthority,
    source: SourceSnapshot,
    profile: HclProfile,
    formed: ParsedFormed,
    limits: HclParseLimits,
  ): HclDocument {
    const entities: HclEntity[] = [];
    const nodeMap = new Map<object, number>();
    const rootBody = buildEntities(formed.body, entities, nodeMap);
    for (const region of formed.errorRegions) {
      const index = entities.length;
      entities.push({ role: 'ErrorRegion', span: region.span, code: region.code });
      nodeMap.set(region, index);
    }
    return new HclDocument(authority, source, profile, formed, limits, entities, rootBody, nodeMap);
  }

  /** Snapshot identity to which every handle and span belongs (document.rs:149-153). */
  snapshotIdentity(): SnapshotIdentity {
    return this.#authority.identity();
  }

  /** Exact immutable UTF-8 source (document.rs:130-134). */
  source(): SourceSnapshot {
    return this.#source;
  }

  /** Default rendering is byte-for-byte identical to the source (document.rs:136-140). */
  render(): Uint8Array {
    return this.#source.bytes();
  }

  /** HCL format family contract (document.rs:157-161). */
  formatFamily(): FormatFamilyId {
    return new FormatFamilyId('hcl', 1);
  }

  /** Exact language profile (document.rs:163-167). */
  profile(): ProfileId {
    return this.#profile.id();
  }

  /** Formation status (RFC 0014 §3; document.rs:118-128). */
  formationStatus(): FormationStatus {
    return this.#status;
  }

  /** Alias of formationStatus (document.rs:124-128). */
  status(): FormationStatus {
    return this.#status;
  }

  /** Ordered diagnostics, deterministically sorted; the tfvars gate diagnostics are merged (document.rs:142-147). */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Exhaustive token/trivia byte coverage (document.rs:177-181). */
  losslessStructuralIndex(): LosslessStructuralIndex {
    return this.#structuralIndex;
  }

  /** Format-specific kind for every structural piece, in the same source order (document.rs:183-187). */
  losslessSyntaxKinds(): readonly HclSyntaxKind[] {
    return this.#formed.syntaxKinds;
  }

  /** Resource contract used to form this snapshot and any edit successor (document.rs:189-193). */
  parseLimits(): HclParseLimits {
    return this.#parseLimits;
  }

  /** Recovered error regions in source order, one per `hcl.parse.*@1` code (RFC 0014 §3, §7.1). */
  errorRegions(): readonly HclErrorRegion[] {
    const regions: HclErrorRegion[] = [];
    for (let index = 0; index < this.#entities.length; index++) {
      if (this.#entities[index].role === 'ErrorRegion') {
        regions.push(new HclErrorRegion(this, index));
      }
    }
    return regions;
  }

  /** Root body handle (native.rs:54-58). */
  root(): HclBody {
    return new HclBody(this, this.#rootBody);
  }

  /** Resolves a snapshot-bound HCL body handle (document.rs:195-207). */
  body(node: NodeRef): HclBody {
    return new HclBody(this, this.validateRef(node, 'HclBody'));
  }

  /** Resolves a snapshot-bound HCL attribute handle. */
  attribute(node: NodeRef): HclAttribute {
    return new HclAttribute(this, this.validateRef(node, 'HclAttribute'));
  }

  /** Resolves a snapshot-bound HCL block handle. */
  block(node: NodeRef): HclBlock {
    return new HclBlock(this, this.validateRef(node, 'HclBlock'));
  }

  /** Resolves a snapshot-bound HCL block-label handle. */
  blockLabel(node: NodeRef): HclBlockLabel {
    return new HclBlockLabel(this, this.validateRef(node, 'HclBlockLabel'));
  }

  /** Resolves a snapshot-bound HCL expression handle. */
  expression(node: NodeRef): HclExpressionHandle {
    return new HclExpressionHandle(this, this.validateRef(node, 'HclExpression'));
  }

  /** Resolves a snapshot-bound HCL template-part handle. */
  templatePart(node: NodeRef): HclTemplatePartHandle {
    return new HclTemplatePartHandle(this, this.validateRef(node, 'HclTemplatePart'));
  }

  // -- internal accessors (documented integration surface for this family) --

  /** @internal */
  authority(): DocumentAuthority {
    return this.#authority;
  }

  /** @internal — the profile selector (document.rs:169-173). */
  selector(): HclProfile {
    return this.#profile;
  }

  /** @internal */
  entity(index: number): HclEntity {
    return this.#entities[index];
  }

  /** @internal */
  nodeRef(index: number, role: NodeRole): NodeRef {
    return this.#authority.nodeRef(BigInt(index), role);
  }

  /** @internal — mirror of document.rs:195-207. */
  validateRef(node: NodeRef, role: NodeRole): number {
    this.#authority.verify(node);
    if (node.role() !== role) {
      throw new HclAccessError('WrongRole');
    }
    const index = Number(this.#authority.resolveIndex(node));
    if (index >= this.#entities.length) {
      throw new HclAccessError('UnknownNode');
    }
    return index;
  }

  /** @internal — entity index of one snapshot-bound node handle. */
  resolveIndex(node: NodeRef): number {
    return Number(this.#authority.resolveIndex(node));
  }

  /** @internal — total structural entity count. */
  entityCount(): number {
    return this.#entities.length;
  }

  /** @internal — the entity index of one expression AST node. */
  indexOf(node: object): number {
    const index = this.#nodeMap.get(node);
    if (index === undefined) {
      throw new HclAccessError('UnknownNode');
    }
    return index;
  }

  /** @internal — body entity payload of one index. */
  bodyEntity(index: number): Extract<HclEntity, { role: 'Body' }> {
    const entity = this.#entities[index];
    if (entity.role !== 'Body') {
      throw new Error('internal: hcl body entity expected');
    }
    return entity;
  }

  /** @internal — error-region entity payload of one index. */
  errorRegionEntity(index: number): Extract<HclEntity, { role: 'ErrorRegion' }> {
    const entity = this.#entities[index];
    if (entity.role !== 'ErrorRegion') {
      throw new Error('internal: hcl error-region entity expected');
    }
    return entity;
  }

  /** @internal — attribute entity payload of one index. */
  attributeEntity(index: number): Extract<HclEntity, { role: 'Attribute' }> {
    const entity = this.#entities[index];
    if (entity.role !== 'Attribute') {
      throw new Error('internal: hcl attribute entity expected');
    }
    return entity;
  }

  /** @internal — block entity payload of one index. */
  blockEntity(index: number): Extract<HclEntity, { role: 'Block' }> {
    const entity = this.#entities[index];
    if (entity.role !== 'Block') {
      throw new Error('internal: hcl block entity expected');
    }
    return entity;
  }

  /** @internal — block-label entity payload of one index. */
  blockLabelEntity(index: number): Extract<HclEntity, { role: 'BlockLabel' }> {
    const entity = this.#entities[index];
    if (entity.role !== 'BlockLabel') {
      throw new Error('internal: hcl block-label entity expected');
    }
    return entity;
  }

  /** @internal — expression entity payload of one index. */
  expressionEntity(index: number): Extract<HclEntity, { role: 'Expression' }> {
    const entity = this.#entities[index];
    if (entity.role !== 'Expression') {
      throw new Error('internal: hcl expression entity expected');
    }
    return entity;
  }

  /** @internal — template-part entity payload of one index. */
  templatePartEntity(index: number): Extract<HclEntity, { role: 'TemplatePart' }> {
    const entity = this.#entities[index];
    if (entity.role !== 'TemplatePart') {
      throw new Error('internal: hcl template-part entity expected');
    }
    return entity;
  }
}

function hasTopLevelBlock(items: readonly ParsedItem[]): boolean {
  return items.some((item) => item.kind === 'block');
}

/** Builds one body entity subtree in the documented pre-order (projection.rs:124-130). */
function buildEntities(body: ParsedBody, entities: HclEntity[], nodeMap: Map<object, number>): number {
  const bodyIndex = entities.length;
  entities.push({ role: 'Body', span: body.span, items: [] });
  const itemIndices: number[] = [];
  for (const item of body.items) {
    if (item.kind === 'attribute') {
      itemIndices.push(buildAttribute(item.attribute, entities, nodeMap));
    } else {
      itemIndices.push(buildBlock(item.block, entities, nodeMap));
    }
  }
  entities[bodyIndex] = { role: 'Body', span: body.span, items: itemIndices };
  return bodyIndex;
}

function buildAttribute(
  attribute: import('./parser.ts').ParsedAttribute,
  entities: HclEntity[],
  nodeMap: Map<object, number>,
): number {
  const index = entities.length;
  entities.push({ role: 'Attribute', span: attribute.span, name: attribute.name, nameSpan: attribute.nameSpan, equalsSpan: attribute.equalsSpan, expression: -1 });
  const expressionIndex = buildExpression(attribute.expression, entities, nodeMap);
  entities[index] = { role: 'Attribute', span: attribute.span, name: attribute.name, nameSpan: attribute.nameSpan, equalsSpan: attribute.equalsSpan, expression: expressionIndex };
  return index;
}

function buildBlock(block: import('./parser.ts').ParsedBlock, entities: HclEntity[], nodeMap: Map<object, number>): number {
  const index = entities.length;
  entities.push({ role: 'Block', span: block.span, type: block.type, labels: [], body: -1 });
  const labelIndices: number[] = [];
  for (const label of block.labels) {
    const labelIndex = entities.length;
    entities.push({ role: 'BlockLabel', span: label.span, text: label.text, quoted: label.quoted });
    labelIndices.push(labelIndex);
  }
  const bodyIndex = buildEntities(block.body, entities, nodeMap);
  entities[index] = { role: 'Block', span: block.span, type: block.type, labels: labelIndices, body: bodyIndex };
  return index;
}

/** Builds one expression subtree in pre-order: the node first, then its parts and children. */
function buildExpression(expression: HclExpr, entities: HclEntity[], nodeMap: Map<object, number>): number {
  const index = entities.length;
  entities.push({ role: 'Expression', span: expression.span, kind: expression });
  nodeMap.set(expression, index);
  if (expression.kind === 'Template') {
    const partIndices: number[] = [];
    for (const part of expression.parts) {
      const partIndex = entities.length;
      entities.push({ role: 'TemplatePart', span: part.span, part });
      nodeMap.set(part, partIndex);
      partIndices.push(partIndex);
      if (part.kind === 'Interpolation') {
        buildExpression(part.expression, entities, nodeMap);
      } else if (part.kind === 'Directive') {
        const directive = part.directive;
        if (directive.kind === 'If') {
          buildExpression(directive.condition, entities, nodeMap);
        } else if (directive.kind === 'For') {
          buildExpression(directive.intro.collection, entities, nodeMap);
        }
      }
    }
    return index;
  }
  for (const child of directChildrenOf(expression)) {
    buildExpression(child, entities, nodeMap);
  }
  return index;
}

/** Borrowed native HCL body bound to one document snapshot (native.rs:72-103). */
export class HclBody {
  readonly #document: HclDocument;
  readonly #index: number;

  constructor(document: HclDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Exact body identity (NodeRole::HclBody). */
  nodeRef(): NodeRef {
    return this.#document.nodeRef(this.#index, 'HclBody');
  }

  /** Exact source span of the body content. */
  span(): Span {
    return this.#document.bodyEntity(this.#index).span;
  }

  /** Ordered body items, interleaving attributes and blocks in source order. */
  items(): (HclAttribute | HclBlock)[] {
    const items: (HclAttribute | HclBlock)[] = [];
    for (const itemIndex of this.#document.bodyEntity(this.#index).items) {
      const entity = this.#document.entity(itemIndex);
      if (entity.role === 'Attribute') {
        items.push(new HclAttribute(this.#document, itemIndex));
      } else {
        items.push(new HclBlock(this.#document, itemIndex));
      }
    }
    return items;
  }

  /** Number of body items. */
  len(): number {
    return this.#document.bodyEntity(this.#index).items.length;
  }

  /** Whether the body has no items. */
  isEmpty(): boolean {
    return this.len() === 0;
  }

  /** @internal */
  index(): number {
    return this.#index;
  }
}

/** Borrowed native HCL attribute bound to one document snapshot (native.rs:145-193). */
export class HclAttribute {
  readonly #document: HclDocument;
  readonly #index: number;

  constructor(document: HclDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Exact attribute identity (NodeRole::HclAttribute). */
  nodeRef(): NodeRef {
    return this.#document.nodeRef(this.#index, 'HclAttribute');
  }

  /** Exact source span of the whole attribute. */
  span(): Span {
    return this.#document.attributeEntity(this.#index).span;
  }

  /** Attribute name; keyword spellings such as `true` are valid names (RFC 0014 §4.1). */
  name(): string {
    return this.#document.attributeEntity(this.#index).name;
  }

  /** Exact span of the name identifier. */
  nameSpan(): Span {
    return this.#document.attributeEntity(this.#index).nameSpan;
  }

  /** Exact span of the `=` equals sign. */
  equalsSpan(): Span {
    return this.#document.attributeEntity(this.#index).equalsSpan;
  }

  /** Value expression, unevaluated (RFC 0014 §1). */
  expression(): HclExpressionHandle {
    const entity = this.#document.attributeEntity(this.#index);
    return new HclExpressionHandle(this.#document, entity.expression);
  }

  /** @internal */
  index(): number {
    return this.#index;
  }
}

/** Borrowed native HCL block bound to one document snapshot (native.rs:203-251). */
export class HclBlock {
  readonly #document: HclDocument;
  readonly #index: number;

  constructor(document: HclDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Exact block identity (NodeRole::HclBlock). */
  nodeRef(): NodeRef {
    return this.#document.nodeRef(this.#index, 'HclBlock');
  }

  /** Exact span of the whole block, from the type identifier through the closing brace. */
  span(): Span {
    return this.#document.blockEntity(this.#index).span;
  }

  /** Block type identifier. */
  type(): string {
    return this.#document.blockEntity(this.#index).type;
  }

  /** Ordered labels; each carries its quote/naked fact. */
  labels(): HclBlockLabel[] {
    return this.#document.blockEntity(this.#index).labels.map((labelIndex) => new HclBlockLabel(this.#document, labelIndex));
  }

  /** Nested body. */
  body(): HclBody {
    return new HclBody(this.#document, this.#document.blockEntity(this.#index).body);
  }

  /** @internal */
  index(): number {
    return this.#index;
  }
}

/** Borrowed native HCL block label bound to one document snapshot (native.rs:259-291). */
export class HclBlockLabel {
  readonly #document: HclDocument;
  readonly #index: number;

  constructor(document: HclDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Exact label identity (NodeRole::HclBlockLabel). */
  nodeRef(): NodeRef {
    return this.#document.nodeRef(this.#index, 'HclBlockLabel');
  }

  /** Exact span, including the quote delimiters when quoted. */
  span(): Span {
    return this.#document.blockLabelEntity(this.#index).span;
  }

  /** Label text; for a quoted label this is the content without the quote delimiters. */
  text(): string {
    return this.#document.blockLabelEntity(this.#index).text;
  }

  /** Whether the label is a quoted literal string; `false` for a naked identifier. */
  quoted(): boolean {
    return this.#document.blockLabelEntity(this.#index).quoted;
  }

  /** @internal */
  index(): number {
    return this.#index;
  }
}

/** Borrowed native HCL expression bound to one document snapshot (RFC 0014 §6). */
export class HclExpressionHandle {
  readonly #document: HclDocument;
  readonly #index: number;

  constructor(document: HclDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Exact expression identity (NodeRole::HclExpression). */
  nodeRef(): NodeRef {
    return this.#document.nodeRef(this.#index, 'HclExpression');
  }

  /** Exact source span, including all trivia, operators, and delimiters. */
  span(): Span {
    return this.#document.expressionEntity(this.#index).span;
  }

  /** The expression AST node (RFC 0014 §6 double preservation). */
  node(): HclExpr {
    return this.#document.expressionEntity(this.#index).kind;
  }

  /** Exact source text derived from the span. */
  text(): string {
    const span = this.span();
    const decoded = this.#document.source().decodedText() ?? '';
    return decoded.slice(utf16Index(this.#document, span.startByte()), utf16Index(this.#document, span.endByte()));
  }

  /** Ordered direct child expressions in source order (expression.rs:80-87). */
  children(): HclExpressionHandle[] {
    const node = this.node();
    const children: HclExpressionHandle[] = [];
    for (const child of directChildrenOf(node)) {
      children.push(new HclExpressionHandle(this.#document, this.#document.indexOf(child)));
    }
    return children;
  }

  /** @internal */
  index(): number {
    return this.#index;
  }
}

/** Borrowed native HCL template part bound to one document snapshot. */
export class HclTemplatePartHandle {
  readonly #document: HclDocument;
  readonly #index: number;

  constructor(document: HclDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Exact part identity (NodeRole::HclTemplatePart). */
  nodeRef(): NodeRef {
    return this.#document.nodeRef(this.#index, 'HclTemplatePart');
  }

  /** Exact source span of the part. */
  span(): Span {
    return this.#document.templatePartEntity(this.#index).span;
  }

  /** The part payload. */
  part(): HclTemplatePart {
    return this.#document.templatePartEntity(this.#index).part;
  }

  /** @internal */
  index(): number {
    return this.#index;
  }
}

/** Byte offset to decoded-text index (the source is UTF-8-only, RFC 0014 §2). */
function utf16Index(document: HclDocument, byte: number): number {
  return document.source().decodedPosition(byte).utf16CodeUnitOffset;
}

/** Ordered direct child expressions in source order (expression.rs:80-87). */
export function directChildrenOf(expression: HclExpr): HclExpr[] {
  const children: HclExpr[] = [];
  switch (expression.kind) {
    case 'Number':
    case 'Boolean':
    case 'Null':
    case 'VariableRef':
      break;
    case 'Template':
      for (const part of expression.parts) {
        if (part.kind === 'Interpolation') {
          children.push(part.expression);
        } else if (part.kind === 'Directive') {
          const directive = part.directive;
          if (directive.kind === 'If') {
            children.push(directive.condition);
          } else if (directive.kind === 'For') {
            children.push(directive.intro.collection);
          }
        }
      }
      break;
    case 'FunctionCall':
      for (const argument of expression.args) {
        children.push(argument.expression);
      }
      break;
    case 'Traversal':
      for (const step of expression.steps) {
        if (step.kind === 'Index') {
          children.push(step.key);
        } else if (step.kind === 'AttrSplat' || step.kind === 'FullSplat') {
          for (const inner of step.steps) {
            if (inner.kind === 'Index') {
              children.push(inner.key);
            }
          }
        }
      }
      break;
    case 'Unary':
      children.push(expression.operand);
      break;
    case 'Binary':
      children.push(expression.lhs, expression.rhs);
      break;
    case 'Conditional':
      children.push(expression.condition, expression.then, expression.else_);
      break;
    case 'ForTuple':
      children.push(expression.intro.collection, expression.value);
      if (expression.condition !== null) {
        children.push(expression.condition);
      }
      break;
    case 'ForObject':
      children.push(expression.intro.collection, expression.key, expression.value);
      if (expression.condition !== null) {
        children.push(expression.condition);
      }
      break;
    case 'Tuple':
      for (const element of expression.elements) {
        children.push(element);
      }
      break;
    case 'Object':
      for (const entry of expression.entries) {
        const key = entry.key;
        if (key.kind === 'Paren') {
          children.push(key.inner);
        } else if (key.kind === 'Template') {
          for (const part of key.parts) {
            if (part.kind === 'Interpolation') {
              children.push(part.expression);
            } else if (part.kind === 'Directive') {
              const directive = part.directive;
              if (directive.kind === 'If') {
                children.push(directive.condition);
              } else if (directive.kind === 'For') {
                children.push(directive.intro.collection);
              }
            }
          }
        }
        children.push(entry.value);
      }
      break;
    case 'Paren':
      children.push(expression.inner);
      break;
  }
  return children;
}
