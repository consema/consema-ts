/**
 * The immutable namespace-aware XML document and its typed native handles.
 *
 * authority: crates/consema-xml/src/document.rs
 *  - XmlSyntaxKind :17-94 (see syntax.ts)
 *  - QNameFacts :96-120 (prefix/local/span/prefix_span/local_span)
 *  - ReferenceFragment :135-172 (Literal | CharacterReference |
 *    PredefinedEntity | GeneralEntity with resolved facts and spans)
 *  - XmlNamespaceBindingData :174-187, XmlAttributeData :189-211
 *  - XmlTextData :213-222, XmlCdataData :224-235, XmlCommentData :237-248,
 *    XmlPiData :250-263, XmlErrorRegionData :265-272
 *  - XmlElementData :274-296 (index/span/qname/expanded/namespace_error/
 *    scope/namespaces/attributes/children), XmlContent :298-328
 *  - XmlPrologItem :330-345, XmlDeclarationData :347-360,
 *    EntityDeclarationData :362-373, XmlDoctypeData :375-386
 *  - Document :388-568 (formation_status :449-458, source :460-464,
 *    render :466-470, lossless_structural_index :472-476,
 *    lossless_syntax_kinds :478-482, diagnostics :490-494,
 *    declaration :496-500, doctype :502-506, prolog :508-512,
 *    root :520-524, nodes :526-530, snapshot_identity :532-536,
 *    format_family :545-549, profile :551-555, node_ref :557-561,
 *    occurrence_node_ref :563-567)
 *  - XmlElement :611-679 (node_ref :619-625, span :627-631, qname
 *    :633-637, expanded :639-643, namespace_bindings :645-649,
 *    attributes :651-655, children :657-665, is_empty :667-671)
 *  - XmlContentItem :681-763 (node_ref :689-701, span :703-714,
 *    element/text/cdata/comment/processing_instruction accessors)
 *  - text_semantic :765-799 (XML line-end normalization to LF)
 *  - NodeRole spellings used by the xml family: consema-document
 *    lib.rs:120-124 ('XmlDocument', 'XmlDeclaration', 'XmlDoctype',
 *    'XmlElement', 'XmlAttribute', 'XmlNamespaceBinding', 'XmlText',
 *    'XmlCdata', 'XmlComment', 'XmlProcessingInstruction',
 *    'XmlEntityReference', 'XmlErrorRegion', 'XmlSyntaxPiece');
 *    typescript/src/document/identity.ts:150-162
 *
 * Design (TypeScript-idiomatic): the document is an immutable class; typed
 * handles (`XmlElement`/`XmlContentItem`) borrow one document and an arena
 * index. NodeRef ordinals ARE arena indexes for elements and document-wide
 * ordinals for the other occurrence families, exactly like the Rust
 * `node_ref(ordinal, role)` mapping (document.rs:557-567). The `@internal`
 * accessors are consumed only by this family's parser/query/projection/
 * edit modules.
 */

import { DocumentAuthority, NodeRef, Span } from '../document/identity.ts';
import type { NodeRole } from '../document/identity.ts';
import { LosslessStructuralIndex } from '../document/structural.ts';
import { FormatFamilyId, ProfileId } from '../document/profile.ts';
import type { ParseLimits } from '../document/formation.ts';
import { SourceSnapshot } from '../document/source.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { XmlAccessError } from './errors.ts';
import { xmlProfileId } from './profile.ts';
import type { XmlProfile } from './profile.ts';
import type { XmlSyntaxKind } from './syntax.ts';
import type { ExpandedName, NamespaceError, NamespaceScope, QName } from './namespace.ts';
import type { XmlParseLimits } from './profile.ts';

// ---------------------------------------------------------------------------
// Source-derived name and fragment facts
// ---------------------------------------------------------------------------

/** One lexical QName with its source-derived facts (document.rs:96-109). */
export interface QNameFacts {
  /** Original prefix spelling, when present. */
  readonly prefix: string | null;
  /** Local name. */
  readonly local: string;
  /** Complete QName span. */
  readonly span: Span;
  /** Prefix span, when present. */
  readonly prefixSpan: Span | null;
  /** Local-name span. */
  readonly localSpan: Span;
}

/** One ordered text or attribute-value fragment (document.rs:135-172). */
export type ReferenceFragment =
  | {
      readonly kind: 'Literal';
      /** Exact source span. */
      readonly span: Span;
      /** Decoded literal text. */
      readonly text: string;
    }
  | {
      readonly kind: 'CharacterReference';
      /** Exact source span of `&#…;`. */
      readonly span: Span;
      /** Resolved legal XML character. */
      readonly resolved: string;
    }
  | {
      readonly kind: 'PredefinedEntity';
      /** Exact source span of `&…;`. */
      readonly span: Span;
      /** Entity name. */
      readonly name: string;
      /** Replacement character data. */
      readonly resolved: string;
    }
  | {
      readonly kind: 'GeneralEntity';
      /** Exact source span of `&…;`. */
      readonly span: Span;
      /** Entity name. */
      readonly name: string;
      /** Fully resolved replacement text. */
      readonly resolved: string;
      /** Span of the declaring `<!ENTITY …>`. */
      readonly declarationSpan: Span;
    };

/** Exact source span of one fragment (document.rs:122-133). */
export function referenceFragmentSpan(fragment: ReferenceFragment): Span {
  return fragment.span;
}

// ---------------------------------------------------------------------------
// Native occurrence data
// ---------------------------------------------------------------------------

/** One XML namespace declaration association (document.rs:174-187). */
export interface XmlNamespaceBindingData {
  /** Document-wide binding ordinal for stable identity. */
  readonly ordinal: number;
  /** `xmlns="…"` or `xmlns:p="…"` span. */
  readonly span: Span;
  /** Bound prefix; `null` is the default namespace. */
  readonly prefix: string | null;
  /** Namespace URI value span. */
  readonly uriSpan: Span;
  /** Namespace URI. */
  readonly uri: string;
}

/** One XML attribute association (document.rs:189-211). */
export interface XmlAttributeData {
  /** Document-wide attribute ordinal for stable identity. */
  readonly ordinal: number;
  /** Whole attribute span. */
  readonly span: Span;
  /** Lexical QName facts. */
  readonly qname: QNameFacts;
  /** Resolved expanded name; `null` when a namespace error kept the name unprovable. */
  readonly expanded: ExpandedName | null;
  /** The namespace resolution failure, when the name could not be proven. */
  readonly namespaceError: NamespaceError | null;
  /** Whether the value used single or double quotes. */
  readonly singleQuote: boolean;
  /** Exact value span between the quotes; empty for an empty value. */
  readonly valueSpan: Span;
  /** Ordered raw value fragments. */
  readonly fragments: readonly ReferenceFragment[];
  /** XML 1.0 CDATA-normalized semantic value. */
  readonly normalizedValue: string;
}

/** One text occurrence with ordered fragments (document.rs:213-222). */
export interface XmlTextData {
  /** Document-wide text ordinal for stable identity. */
  readonly ordinal: number;
  /** Exact source span. */
  readonly span: Span;
  /** Ordered fragments; adjacent literals are not merged across markup. */
  readonly fragments: readonly ReferenceFragment[];
}

/** One CDATA occurrence (document.rs:224-235). */
export interface XmlCdataData {
  /** Document-wide ordinal for stable identity. */
  readonly ordinal: number;
  /** `![CDATA[…]]>` span. */
  readonly span: Span;
  /** Content text span. */
  readonly textSpan: Span;
  /** Content text; never entity-expanded. */
  readonly text: string;
}

/** One comment occurrence (document.rs:237-248). */
export interface XmlCommentData {
  /** Document-wide ordinal for stable identity. */
  readonly ordinal: number;
  /** `<!--…-->` span. */
  readonly span: Span;
  /** Content text span. */
  readonly textSpan: Span;
  /** Content text; never entity-expanded. */
  readonly text: string;
}

/** One processing instruction (document.rs:250-263). */
export interface XmlPiData {
  /** Document-wide ordinal for stable identity. */
  readonly ordinal: number;
  /** `<?…?>` span. */
  readonly span: Span;
  /** Target span. */
  readonly targetSpan: Span;
  /** Target; cannot compare case-insensitively equal to `xml`. */
  readonly target: string;
  /** Content span and text, when present; never entity-expanded. */
  readonly content: { readonly span: Span; readonly text: string } | null;
}

/** One recovered error region (document.rs:265-272). */
export interface XmlErrorRegionData {
  /** Document-wide ordinal for stable identity. */
  readonly ordinal: number;
  /** Recovered error span. */
  readonly span: Span;
}

/** One element occurrence (document.rs:274-296). */
export interface XmlElementData {
  /** Arena index for stable identity. */
  readonly index: number;
  /** Full start-tag span, or the whole empty-element span. */
  readonly span: Span;
  /** Lexical QName facts. */
  readonly qname: QNameFacts;
  /** Resolved expanded name; `null` when a namespace error kept the name unprovable. */
  readonly expanded: ExpandedName | null;
  /** The namespace resolution failure, when the name could not be proven. */
  readonly namespaceError: NamespaceError | null;
  /** Immutable ancestry-derived in-scope namespace chain. */
  readonly scope: NamespaceScope;
  /** Ordered namespace declarations on this element. */
  readonly namespaces: readonly XmlNamespaceBindingData[];
  /** Ordered attributes, excluding namespace declarations. */
  readonly attributes: readonly XmlAttributeData[];
  /** Ordered child content arena indices; never sorted by type. */
  readonly children: readonly number[];
}

/** One child content occurrence (document.rs:298-313). */
export type XmlContent =
  | { readonly kind: 'Element'; readonly data: XmlElementData }
  | { readonly kind: 'Text'; readonly data: XmlTextData }
  | { readonly kind: 'Cdata'; readonly data: XmlCdataData }
  | { readonly kind: 'Comment'; readonly data: XmlCommentData }
  | { readonly kind: 'ProcessingInstruction'; readonly data: XmlPiData }
  | { readonly kind: 'ErrorRegion'; readonly data: XmlErrorRegionData };

/** Exact source span of one occurrence (document.rs:315-328). */
export function xmlContentSpan(content: XmlContent): Span {
  return content.data.span;
}

/** One prolog or epilog occurrence (document.rs:330-345). */
export type XmlPrologItem =
  | { readonly kind: 'Declaration'; readonly data: XmlDeclarationData }
  | { readonly kind: 'Doctype'; readonly data: XmlDoctypeData }
  | { readonly kind: 'ProcessingInstruction'; readonly data: XmlPiData }
  | { readonly kind: 'Comment'; readonly data: XmlCommentData }
  | { readonly kind: 'Bom'; readonly span: Span }
  | { readonly kind: 'Whitespace'; readonly span: Span };

/** XML declaration facts (document.rs:347-360). */
export interface XmlDeclarationData {
  /** `<?xml …?>` span. */
  readonly span: Span;
  /** Version pseudo-attribute span. */
  readonly versionSpan: Span;
  /** Version; exactly `1.0`. */
  readonly version: string;
  /** Optional encoding pseudo-attribute span and value. */
  readonly encoding: { readonly span: Span; readonly value: string } | null;
  /** Optional standalone pseudo-attribute span and value. */
  readonly standalone: { readonly span: Span; readonly value: boolean } | null;
}

/** One admitted internal general entity declaration (document.rs:362-373). */
export interface EntityDeclarationData {
  /** `<!ENTITY …>` span. */
  readonly span: Span;
  /** Entity name. */
  readonly name: string;
  /** Replacement value span. */
  readonly replacementSpan: Span;
  /** Raw replacement text. */
  readonly replacement: string;
}

/** DOCTYPE facts (document.rs:375-386). */
export interface XmlDoctypeData {
  /** `<!DOCTYPE …>` span. */
  readonly span: Span;
  /** Root-name QName facts. */
  readonly name: QNameFacts;
  /** Ordered admitted internal general entity declarations. */
  readonly entities: readonly EntityDeclarationData[];
  /** Whether an excluded external/validation construct forced recovery. */
  readonly recovered: boolean;
}

// ---------------------------------------------------------------------------
// Internal entity arena
// ---------------------------------------------------------------------------

/** One internal arena entity: an element, a content occurrence, or orphaned content. */
export type Entity =
  | {
      readonly kind: 'Element';
      readonly index: number;
      readonly data: XmlElementData;
    }
  | {
      readonly kind: 'Content';
      readonly index: number;
      readonly data: XmlContent;
    };

// ---------------------------------------------------------------------------
// XmlDocument
// ---------------------------------------------------------------------------

/** Opaque immutable XML-family document snapshot (document.rs:388-407). */
export class XmlDocument {
  readonly #authority: DocumentAuthority;
  readonly #source: SourceSnapshot;
  readonly #profile: XmlProfile;
  readonly #status: 'Complete' | 'Recovered';
  readonly #declaration: XmlDeclarationData | null;
  readonly #doctype: XmlDoctypeData | null;
  readonly #prolog: readonly XmlPrologItem[];
  readonly #epilog: readonly XmlPrologItem[];
  readonly #root: number | null;
  readonly #structuralIndex: LosslessStructuralIndex | null;
  readonly #syntaxKinds: readonly XmlSyntaxKind[];
  readonly #diagnostics: readonly Diagnostic[];
  readonly #nodes: readonly XmlContent[];
  readonly #parentOf: readonly (number | null)[];
  readonly #parseLimits: XmlParseLimits;

  /**
   * @internal — construction is only via `parse` (parser.ts); the
   * `@internal` accessors below are consumed by this family's
   * query/projection/edit modules.
   */
  constructor(
    authority: DocumentAuthority,
    source: SourceSnapshot,
    profile: XmlProfile,
    status: 'Complete' | 'Recovered',
    declaration: XmlDeclarationData | null,
    doctype: XmlDoctypeData | null,
    prolog: readonly XmlPrologItem[],
    epilog: readonly XmlPrologItem[],
    root: number | null,
    structuralIndex: LosslessStructuralIndex | null,
    syntaxKinds: readonly XmlSyntaxKind[],
    diagnostics: readonly Diagnostic[],
    nodes: readonly XmlContent[],
    parentOf: readonly (number | null)[],
    parseLimits: XmlParseLimits,
  ) {
    this.#authority = authority;
    this.#source = source;
    this.#profile = profile;
    this.#status = status;
    this.#declaration = declaration;
    this.#doctype = doctype;
    this.#prolog = Object.freeze([...prolog]);
    this.#epilog = Object.freeze([...epilog]);
    this.#root = root;
    this.#structuralIndex = structuralIndex;
    this.#syntaxKinds = Object.freeze([...syntaxKinds]);
    this.#diagnostics = Object.freeze([...diagnostics]);
    this.#nodes = Object.freeze([...nodes]);
    this.#parentOf = Object.freeze([...parentOf]);
    this.#parseLimits = parseLimits;
  }

  /** Snapshot identity to which every NodeRef and Span belongs (document.rs:532-536). */
  snapshotIdentity() {
    return this.#authority.identity();
  }

  /** Immutable raw source (document.rs:460-464). */
  source(): SourceSnapshot {
    return this.#source;
  }

  /** Exact original bytes; unmodified rendering is byte-exact (document.rs:466-470). */
  render(): Uint8Array {
    return this.#source.bytes();
  }

  /** XML format family contract (document.rs:545-549). */
  formatFamily(): FormatFamilyId {
    return new FormatFamilyId('xml', 1);
  }

  /** Exact language profile (document.rs:551-555). */
  profile(): ProfileId {
    return xmlProfileId(this.#profile);
  }

  /** Whether recovery structure was required (document.rs:449-458). */
  formationStatus(): 'Complete' | 'Recovered' {
    return this.#status;
  }

  /** Ordered diagnostics from formation (document.rs:490-494). */
  diagnostics(): readonly Diagnostic[] {
    return this.#diagnostics;
  }

  /** Exhaustive ordered lossless syntax coverage (document.rs:472-476). */
  losslessStructuralIndex(): LosslessStructuralIndex | null {
    return this.#structuralIndex;
  }

  /** Format-owned syntax kind for every structural piece, in the same source order (document.rs:478-482). */
  losslessSyntaxKinds(): readonly XmlSyntaxKind[] {
    return this.#syntaxKinds;
  }

  /** The XML declaration, when present (document.rs:496-500). */
  declaration(): XmlDeclarationData | null {
    return this.#declaration;
  }

  /** The DOCTYPE occurrence, when present (document.rs:502-506). */
  doctype(): XmlDoctypeData | null {
    return this.#doctype;
  }

  /** Ordered prolog items before the document element (document.rs:508-512). */
  prolog(): readonly XmlPrologItem[] {
    return this.#prolog;
  }

  /** Ordered epilog items after the document element (document.rs:514-518). */
  epilog(): readonly XmlPrologItem[] {
    return this.#epilog;
  }

  /** The one document element, when formation proved it (document.rs:520-524). */
  root(): XmlElement | null {
    return this.#root === null ? null : new XmlElement(this, this.#root);
  }

  /** All arena nodes; child content of every element is reachable here (document.rs:526-530). */
  nodes(): readonly XmlContent[] {
    return this.#nodes;
  }

  /** Parse limits under which the document was formed (document.rs:406). */
  parseLimits(): XmlParseLimits {
    return this.#parseLimits;
  }

  /** Snapshot-bound document handle (document.rs:557-561). */
  nodeRef(): NodeRef {
    return this.#authority.nodeRef(0n, 'XmlDocument');
  }

  /** Snapshot-bound identity of one ordinal-scoped occurrence (document.rs:563-567). */
  occurrenceNodeRef(ordinal: number, role: NodeRole): NodeRef {
    return this.#authority.nodeRef(BigInt(ordinal), role);
  }

  /** @internal */ authorityInternal(): DocumentAuthority {
    return this.#authority;
  }

  /** @internal */ profileInternal(): XmlProfile {
    return this.#profile;
  }

  /** @internal */ nodeAt(index: number): XmlContent {
    return this.#nodes[index];
  }

  /** @internal */ parentOfInternal(index: number): number | null {
    return this.#parentOf[index] ?? null;
  }

  /** @internal */ spanOf(index: number): Span {
    return this.#nodes[index].data.span;
  }

  /** @internal */ nodeRefFor(index: number, role: NodeRole): NodeRef {
    return this.#authority.nodeRef(BigInt(index), role);
  }

  /**
   * @internal — resolves one NodeRef to its entity index
   * (the validate_ref pattern, lib.rs:268-285).
   */
  resolveEntityIndex(node: NodeRef, roles: readonly NodeRole[]): number {
    try {
      this.#authority.verify(node);
    } catch {
      throw new XmlAccessError('WrongSnapshot');
    }
    if (!roles.includes(node.role())) {
      throw new XmlAccessError('WrongRole');
    }
    const index = this.#authority.resolveIndex(node);
    if (index > BigInt(Number.MAX_SAFE_INTEGER) || index >= BigInt(this.#nodes.length)) {
      throw new XmlAccessError('UnknownNode');
    }
    return Number(index);
  }
}

// ---------------------------------------------------------------------------
// Typed native handles
// ---------------------------------------------------------------------------

/** Snapshot-bound element handle (document.rs:611-617). */
export class XmlElement {
  readonly #document: XmlDocument;
  readonly #index: number;

  constructor(document: XmlDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Snapshot-bound stable identity (document.rs:619-625). */
  nodeRef(): NodeRef {
    return this.#document.nodeRefFor(this.#index, 'XmlElement');
  }

  /** Full start-tag or empty-element span (document.rs:627-631). */
  span(): Span {
    return this.#elementData().span;
  }

  /** Lexical QName facts (document.rs:633-637). */
  qname(): QNameFacts {
    return this.#elementData().qname;
  }

  /** Resolved expanded name, when the namespace binding could be proven (document.rs:639-643). */
  expanded(): ExpandedName | null {
    return this.#elementData().expanded;
  }

  /** Ordered namespace declarations on this element (document.rs:645-649). */
  namespaceBindings(): readonly XmlNamespaceBindingData[] {
    return this.#elementData().namespaces;
  }

  /** Ordered attributes, excluding namespace declarations (document.rs:651-655). */
  attributes(): readonly XmlAttributeData[] {
    return this.#elementData().attributes;
  }

  /** Ordered child content occurrences; mixed-content order is retained (document.rs:657-665). */
  children(): readonly XmlContentItem[] {
    return this.#elementData().children.map((index) => new XmlContentItem(this.#document, index));
  }

  /** Whether the element has no child content (document.rs:667-671). */
  isEmpty(): boolean {
    return this.#elementData().children.length === 0;
  }

  /** @internal */ rawIndex(): number {
    return this.#index;
  }

  /** @internal */ documentInternal(): XmlDocument {
    return this.#document;
  }

  #elementData(): XmlElementData {
    const node = this.#document.nodeAt(this.#index);
    if (node.kind !== 'Element') {
      throw new XmlAccessError('WrongRole');
    }
    return node.data;
  }
}

/** One borrowed child content occurrence (document.rs:681-687). */
export class XmlContentItem {
  readonly #document: XmlDocument;
  readonly #index: number;

  constructor(document: XmlDocument, index: number) {
    this.#document = document;
    this.#index = index;
  }

  /** Snapshot-bound stable identity (document.rs:689-701). */
  nodeRef(): NodeRef {
    const role = contentRole(this.#document.nodeAt(this.#index));
    return this.#document.nodeRefFor(this.#index, role);
  }

  /** Exact source span (document.rs:703-714). */
  span(): Span {
    return xmlContentSpan(this.#document.nodeAt(this.#index));
  }

  /** Element content, when this is an element occurrence (document.rs:716-726). */
  element(): XmlElement | null {
    const node = this.#document.nodeAt(this.#index);
    return node.kind === 'Element' ? new XmlElement(this.#document, this.#index) : null;
  }

  /** Text occurrence data, when this is a text occurrence (document.rs:728-735). */
  text(): XmlTextData | null {
    const node = this.#document.nodeAt(this.#index);
    return node.kind === 'Text' ? node.data : null;
  }

  /** CDATA occurrence data, when present (document.rs:737-744). */
  cdata(): XmlCdataData | null {
    const node = this.#document.nodeAt(this.#index);
    return node.kind === 'Cdata' ? node.data : null;
  }

  /** Comment occurrence data, when present (document.rs:746-753). */
  comment(): XmlCommentData | null {
    const node = this.#document.nodeAt(this.#index);
    return node.kind === 'Comment' ? node.data : null;
  }

  /** Processing-instruction data, when present (document.rs:755-762). */
  processingInstruction(): XmlPiData | null {
    const node = this.#document.nodeAt(this.#index);
    return node.kind === 'ProcessingInstruction' ? node.data : null;
  }

  /** @internal */ rawIndex(): number {
    return this.#index;
  }

  /** @internal */ contentInternal(): XmlContent {
    return this.#document.nodeAt(this.#index);
  }
}

/** Node role of one content occurrence (document.rs:689-701). */
export function contentRole(content: XmlContent): NodeRole {
  switch (content.kind) {
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

/**
 * Semantic concatenation of one text occurrence after XML line-end
 * normalization to LF (document.rs:765-799).
 */
export function textSemantic(text: XmlTextData): string {
  let out = '';
  for (const fragment of text.fragments) {
    switch (fragment.kind) {
      case 'Literal':
        out += pushNormalized(fragment.text);
        break;
      case 'CharacterReference':
        out += fragment.resolved;
        break;
      case 'PredefinedEntity':
      case 'GeneralEntity':
        out += pushNormalized(fragment.resolved);
        break;
    }
  }
  return out;
}

function pushNormalized(text: string): string {
  let out = '';
  const chars = [...text];
  for (let index = 0; index < chars.length; index++) {
    const character = chars[index];
    if (character === '\r') {
      // XML 1.0 line-end normalization: CRLF and CR become LF.
      out += '\n';
      if (chars[index + 1] === '\n') {
        index += 1;
      }
    } else {
      out += character;
    }
  }
  return out;
}

/** Semantic text of one literal under XML line-end normalization (helper for value fragments). */
export function normalizeLineEnds(text: string): string {
  return pushNormalized(text);
}
