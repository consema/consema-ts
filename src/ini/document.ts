/**
 * The immutable INI document snapshot and its native accessors.
 *
 * authority:
 *  - document surface: crates/consema-ini/src/lib.rs:489-661 — snapshot
 *    identity (:508-513), source (:514-519), render (:521-525), format
 *    family "ini"@1 (:527-531), profile (:533-537), root node (:539-543),
 *    formation status (:545-549), diagnostics (:551-555), structural index
 *    and syntax kinds (:557-567), ordered physical lines (:569-575),
 *    logical lines (:577-581), sections (:583-587), entries (:589-593),
 *    error lines (:595-599), parse limits (:601-604), and the snapshot-
 *    bound handle resolvers (:606-660)
 *  - handle roles: RFC 0009 §8 (:273-283) — IniDocument, IniPhysicalLine,
 *    IniLogicalLine, IniSection, IniDefaultSection, IniEntry, IniErrorLine;
 *    the NodeRole spellings are pinned in document/identity.ts:131-139
 *  - parse entry point: lib.rs:663-671 (parse) and parser.rs:16-35
 *    (encoding request, profile encoding validation, then the scanner)
 *
 * Design (TypeScript-idiomatic): the document is an immutable class whose
 * accessors return snapshot-bound handle objects. Formation never returns
 * a partial document: parseIniDocument throws IniFormationFailure. The
 * entity list produced by the parser is frozen here; handle classes are
 * thin views over one entity index.
 */

import {
  DocumentAuthority,
  type NodeRef,
  type NodeRole,
  SnapshotIdentity,
  Span,
} from '../document/identity.ts';
import { FormatFamilyId, ProfileId } from '../document/profile.ts';
import type { FormationStatus } from '../document/formation.ts';
import { LosslessStructuralIndex } from '../document/structural.ts';
import { SourceSnapshot } from '../document/source.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import {
  IniProfile,
  type IniEncodingSelection,
  type IniLogicalLineKind,
  type IniParseLimits,
  type IniQuoteStyle,
  type IniSyntaxKind,
  type IniValueState,
} from './profile.ts';
import { IniAccessError } from './errors.ts';
import { parseIni, type IniEntity, type IniParseOutput } from './parser.ts';

/**
 * Parses one complete immutable INI document snapshot (lib.rs:663-671).
 * Throws IniFormationFailure on any failure — a truncated success never
 * exists (RFC 0009 §4).
 */
export function parseIniDocument(
  sourceBytes: Uint8Array,
  profile: IniProfile,
  selection: IniEncodingSelection,
  limits: IniParseLimits,
): IniDocument {
  const output = parseIni(sourceBytes, profile, selection, limits);
  return new IniDocument(output);
}

/** Opaque immutable INI document snapshot (lib.rs:489-506). */
export class IniDocument {
  readonly #output: IniParseOutput;
  readonly #authority: DocumentAuthority;
  readonly #source: SourceSnapshot;
  readonly #profile: IniProfile;
  readonly #limits: IniParseLimits;
  readonly #entities: readonly IniEntity[];
  readonly #structuralIndex: LosslessStructuralIndex;

  /** @internal — formed via `parseIniDocument`. */
  constructor(output: IniParseOutput) {
    this.#output = output;
    this.#authority = output.authority;
    this.#source = output.source;
    this.#profile = output.profile;
    this.#limits = output.limits;
    this.#entities = Object.freeze([...output.entities]);
    this.#structuralIndex = output.structuralIndex;
  }

  /** Snapshot identity to which every native handle and span belongs (lib.rs:508-513). */
  snapshotIdentity(): SnapshotIdentity {
    return this.#authority.identity();
  }

  /** Exact immutable source (lib.rs:514-519). */
  source(): SourceSnapshot {
    return this.#source;
  }

  /** Default rendering is byte-for-byte identical to the source (lib.rs:521-525). */
  render(): Uint8Array {
    return this.#source.bytes();
  }

  /** INI format family contract (lib.rs:527-531). */
  formatFamily(): FormatFamilyId {
    return new FormatFamilyId('ini', 1);
  }

  /** Exact selected profile (lib.rs:533-537). */
  profile(): ProfileId {
    return this.#profile.id();
  }

  /** @internal — the frozen profile singleton that formed this snapshot. */
  iniProfile(): IniProfile {
    return this.#profile;
  }

  /** @internal — closed profile tag used by the family modules. */
  profileTag(): 'PortableV1' | 'WindowsV1' | 'PythonConfigParserV1' {
    return this.#profile.tag();
  }

  /** Root INI document identity (lib.rs:539-543). */
  nodeRef(): NodeRef {
    return this.#authority.nodeRef(0n, 'IniDocument');
  }

  /** Complete or explicitly recovered formation state (lib.rs:545-549). */
  formationStatus(): FormationStatus {
    return this.#output.recovered ? 'Recovered' : 'Complete';
  }

  /** Stable ordered diagnostics (lib.rs:551-555). */
  diagnostics(): readonly Diagnostic[] {
    return this.#output.diagnostics;
  }

  /** Exhaustive ordered source coverage (lib.rs:557-559). */
  losslessStructuralIndex(): LosslessStructuralIndex {
    return this.#structuralIndex;
  }

  /** Format kind aligned with each structural piece (lib.rs:563-567). */
  losslessSyntaxKinds(): readonly IniSyntaxKind[] {
    return this.#output.syntaxKinds;
  }

  /** Ordered physical source lines (lib.rs:569-575). */
  physicalLines(): IniPhysicalLine[] {
    return this.#output.physicalLines.map((index) => new IniPhysicalLine(this, index));
  }

  /** Ordered logical records (lib.rs:577-581). */
  logicalLines(): IniLogicalLine[] {
    return this.#output.logicalLines.map((index) => new IniLogicalLine(this, index));
  }

  /** Ordered distinct section occurrences (lib.rs:583-587). */
  sections(): IniSection[] {
    return this.#output.sections.map((index) => new IniSection(this, index));
  }

  /** Ordered distinct entry occurrences (lib.rs:589-593). */
  entries(): IniEntry[] {
    return this.#output.entries.map((index) => new IniEntry(this, index));
  }

  /** Ordered recovered error records (lib.rs:595-599). */
  errorLines(): IniErrorLine[] {
    return this.#output.errorLines.map((index) => new IniErrorLine(this, index));
  }

  /** Resource contract used to form this snapshot (lib.rs:601-604). */
  parseLimits(): IniParseLimits {
    return this.#limits;
  }

  /** Resolves one physical-line handle only within this snapshot (lib.rs:606-618). */
  physicalLine(node: NodeRef): IniPhysicalLine {
    const index = this.validateRef(node, 'IniPhysicalLine');
    return new IniPhysicalLine(this, index);
  }

  /** Resolves one logical-line handle only within this snapshot (lib.rs:620-633). */
  logicalLine(node: NodeRef): IniLogicalLine {
    const index = this.validateRef(node, 'IniLogicalLine');
    return new IniLogicalLine(this, index);
  }

  /** Resolves one section/default-section handle only within this snapshot (lib.rs:635-648). */
  section(node: NodeRef): IniSection {
    const index = this.validateSectionRef(node);
    return new IniSection(this, index);
  }

  /** Resolves one entry handle only within this snapshot (lib.rs:650-660). */
  entry(node: NodeRef): IniEntry {
    const index = this.validateRef(node, 'IniEntry');
    return new IniEntry(this, index);
  }

  // -- internal accessors (documented integration surface for this family) --

  /** @internal */
  authority(): DocumentAuthority {
    return this.#authority;
  }

  /** @internal */
  entity(index: number): IniEntity {
    return this.#entities[index];
  }

  /** @internal — entity index of one snapshot-bound node handle. */
  resolveIndex(node: NodeRef): number {
    this.#authority.verify(node);
    return Number(this.#authority.resolveIndex(node));
  }

  /** @internal — entity index of one exact-role node handle. */
  validateRef(node: NodeRef, role: NodeRole): number {
    this.#authority.verify(node);
    if (node.role() !== role) {
      throw new IniAccessError('WrongRole');
    }
    const index = Number(this.#authority.resolveIndex(node));
    if (index >= this.#entities.length) {
      throw new IniAccessError('UnknownNode');
    }
    return index;
  }

  /** @internal — section resolver accepting both section roles. */
  validateSectionRef(node: NodeRef): number {
    this.#authority.verify(node);
    if (node.role() !== 'IniSection' && node.role() !== 'IniDefaultSection') {
      throw new IniAccessError('WrongRole');
    }
    const index = Number(this.#authority.resolveIndex(node));
    if (index >= this.#entities.length) {
      throw new IniAccessError('UnknownNode');
    }
    return index;
  }

  /** @internal — total entity count (edit preparation scans parents). */
  entityCount(): number {
    return this.#entities.length;
  }
}

// ---------------------------------------------------------------------------
// Snapshot-bound handles
// ---------------------------------------------------------------------------

/** One exact physical source line (lib.rs:230-263). */
export class IniPhysicalLine {
  readonly #document: IniDocument;
  readonly #index: number;

  constructor(document: IniDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Snapshot-bound physical-line identity. */
  nodeRef(): NodeRef {
    return this.#document.authority().nodeRef(BigInt(this.#index), 'IniPhysicalLine');
  }

  /** Complete raw line including its line break. */
  span(): Span {
    return this.#document.entity(this.#index).span;
  }

  /** Raw line content excluding its line break. */
  contentSpan(): Span {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'PhysicalLine') {
      throw new Error('internal: ini physical-line entity expected');
    }
    return kind.contentSpan;
  }

  /** Exact LF or CRLF range, absent at EOF. */
  lineBreakSpan(): Span | null {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'PhysicalLine') {
      throw new Error('internal: ini physical-line entity expected');
    }
    return kind.lineBreakSpan;
  }

  /** @internal */
  index(): number {
    return this.#index;
  }
}

/** One logical record and its ordered physical constituents (lib.rs:265-291). */
export class IniLogicalLine {
  readonly #document: IniDocument;
  readonly #index: number;

  constructor(document: IniDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Snapshot-bound logical-line identity. */
  nodeRef(): NodeRef {
    return this.#document.authority().nodeRef(BigInt(this.#index), 'IniLogicalLine');
  }

  /** Logical record kind. */
  kind(): IniLogicalLineKind {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'LogicalLine') {
      throw new Error('internal: ini logical-line entity expected');
    }
    return kind.kind;
  }

  /** Ordered physical-line identities. */
  physicalLines(): IniPhysicalLine[] {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'LogicalLine') {
      throw new Error('internal: ini logical-line entity expected');
    }
    return kind.physicalLines.map((physical) => new IniPhysicalLine(this.#document, physical));
  }

  /** @internal */
  index(): number {
    return this.#index;
  }
}

/** One distinct section-header occurrence (lib.rs:293-354). */
export class IniSection {
  readonly #document: IniDocument;
  readonly #index: number;

  constructor(document: IniDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Snapshot-bound section occurrence identity. */
  nodeRef(): NodeRef {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Section' && kind.role !== 'DefaultSection') {
      throw new Error('internal: ini section entity expected');
    }
    return this.#document
      .authority()
      .nodeRef(BigInt(this.#index), kind.role === 'DefaultSection' ? 'IniDefaultSection' : 'IniSection');
  }

  /** Owning logical-line identity. */
  logicalLine(): NodeRef {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Section' && kind.role !== 'DefaultSection') {
      throw new Error('internal: ini section entity expected');
    }
    return this.#document.authority().nodeRef(BigInt(kind.logicalLine), 'IniLogicalLine');
  }

  /** Complete header content span, excluding the line break. */
  span(): Span {
    return this.#document.entity(this.#index).span;
  }

  /** Exact section-name span. */
  nameSpan(): Span {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Section' && kind.role !== 'DefaultSection') {
      throw new Error('internal: ini section entity expected');
    }
    return kind.nameSpan;
  }

  /** Original decoded name spelling. */
  name(): string {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Section' && kind.role !== 'DefaultSection') {
      throw new Error('internal: ini section entity expected');
    }
    return kind.name;
  }

  /** Profile-specific comparison name. */
  comparisonName(): string {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Section' && kind.role !== 'DefaultSection') {
      throw new Error('internal: ini section entity expected');
    }
    return kind.comparisonName;
  }

  /** Whether this is Python's exact `DEFAULT` section. */
  isDefault(): boolean {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Section' && kind.role !== 'DefaultSection') {
      throw new Error('internal: ini section entity expected');
    }
    return kind.isDefault;
  }

  /** Deterministic duplicate/case-equivalence group identity. */
  duplicateGroup(): number | null {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Section' && kind.role !== 'DefaultSection') {
      throw new Error('internal: ini section entity expected');
    }
    return kind.duplicateGroup;
  }

  /** @internal */
  index(): number {
    return this.#index;
  }
}

/** One distinct key/value occurrence (lib.rs:356-445). */
export class IniEntry {
  readonly #document: IniDocument;
  readonly #index: number;

  constructor(document: IniDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Snapshot-bound entry occurrence identity. */
  nodeRef(): NodeRef {
    return this.#document.authority().nodeRef(BigInt(this.#index), 'IniEntry');
  }

  /** Owning logical-line identity. */
  logicalLine(): NodeRef {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: ini entry entity expected');
    }
    return this.#document.authority().nodeRef(BigInt(kind.logicalLine), 'IniLogicalLine');
  }

  /** Owning section occurrence. */
  section(): NodeRef {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: ini entry entity expected');
    }
    return this.#document.authority().nodeRef(BigInt(kind.section), this.sectionRole(kind.section));
  }

  /** Complete first physical-line content span. */
  span(): Span {
    return this.#document.entity(this.#index).span;
  }

  /** Exact original key span. */
  keySpan(): Span {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: ini entry entity expected');
    }
    return kind.keySpan;
  }

  /** Exact first-line semantic value span. */
  valueSpan(): Span {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: ini entry entity expected');
    }
    return kind.valueSpan;
  }

  /** Original decoded key spelling. */
  key(): string {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: ini entry entity expected');
    }
    return kind.key;
  }

  /** Profile-specific comparison key. */
  comparisonKey(): string {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: ini entry entity expected');
    }
    return kind.comparisonKey;
  }

  /** Stored semantic string, including deterministic continuation joins. */
  value(): string {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: ini entry entity expected');
    }
    return kind.value;
  }

  /** Missing, empty, or present value fact. */
  valueState(): IniValueState {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: ini entry entity expected');
    }
    return kind.state;
  }

  /** Profile-recognized outer quote style. */
  quoteStyle(): IniQuoteStyle {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: ini entry entity expected');
    }
    return kind.quoteStyle;
  }

  /** Deterministic duplicate/case-equivalence group identity. */
  duplicateGroup(): number | null {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'Entry') {
      throw new Error('internal: ini entry entity expected');
    }
    return kind.duplicateGroup;
  }

  /** @internal */
  index(): number {
    return this.#index;
  }

  private sectionRole(sectionIndex: number): NodeRole {
    const kind = this.#document.entity(sectionIndex).kind;
    return kind.role === 'DefaultSection' ? 'IniDefaultSection' : 'IniSection';
  }
}

/** One recovered physical error record (lib.rs:447-487). */
export class IniErrorLine {
  readonly #document: IniDocument;
  readonly #index: number;

  constructor(document: IniDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Snapshot-bound error identity. */
  nodeRef(): NodeRef {
    return this.#document.authority().nodeRef(BigInt(this.#index), 'IniErrorLine');
  }

  /** Owning logical-line identity. */
  logicalLine(): NodeRef {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'ErrorLine') {
      throw new Error('internal: ini error-line entity expected');
    }
    return this.#document.authority().nodeRef(BigInt(kind.logicalLine), 'IniLogicalLine');
  }

  /** Physical line retained by recovery. */
  physicalLine(): NodeRef {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'ErrorLine') {
      throw new Error('internal: ini error-line entity expected');
    }
    return this.#document.authority().nodeRef(BigInt(kind.physicalLine), 'IniPhysicalLine');
  }

  /** Exact malformed content span. */
  span(): Span {
    return this.#document.entity(this.#index).span;
  }

  /** Stable diagnostic code. */
  code(): string {
    const kind = this.#document.entity(this.#index).kind;
    if (kind.role !== 'ErrorLine') {
      throw new Error('internal: ini error-line entity expected');
    }
    return kind.code;
  }

  /** @internal */
  index(): number {
    return this.#index;
  }
}
