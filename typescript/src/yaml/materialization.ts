/**
 * Canonical PortableGraph and PortableValue materialization for YAML.
 *
 * authority: crates/consema-yaml/src/materialization.rs
 *  - GraphMaterializationInputLocation :32-60, provenance entries :62-83,
 *    GraphMaterializationFailure :85-151 (codes :143-151)
 *  - materialize_graph :191-205, materialize_graph_complete :207-238
 *    (requested_profile :246-257, requested_style :259-265 —
 *    yaml.canonical-block@1 / yaml.canonical-flow@1, output contract
 *    :267-280 — Utf8/Utf16Le/Utf16Be and Lf/CrLf only, parse limits
 *    :282-290, reparse + graph isomorphism :222-230, provenance :231)
 *  - GraphLayout :292-401 (canonical DFS numbering, per-root document
 *    ownership → CrossDocumentSharing :367-369, anchor names for nodes
 *    with >1 occurrence :392-398), validate_tag_kind :403-428
 *  - GraphWriter :430-717 (stream :465-482 — `---` per root, block/flow
 *    styles; flow_node :484-538; block_after_indicator :540-575;
 *    block_content :577-627; write_properties :669-687 — `&g{n} ` +
 *    `!!suffix`; write_quoted :689-709 — the canonical escaping table;
 *    scalar_presentation :719-728 — `e0` for integer-shaped floats)
 *  - encode_output :775-819 (UTF-16 output always carries the BOM),
 *    collect_graph_provenance :821-1056 (Direct edges, Reencoded aliases)
 *  - materialize_value :1058-1144 (prepare_value :1146-1246,
 *    prepare_mapping :1248-1335 — UniqueStringEntriesToObject is
 *    reportable with core.materialization.mapping-transformed@1 :1276-1295;
 *    value_graph :1337-1354; closure via best-exact projection :1114-1121)
 *  - define_value_node :1356-1490 (Decimal canonical, the three frozen
 *    binary64 spellings :1402-1410, canonical date :1505-1510,
 *    canonical offset date-time :1512-1543, canonical_fraction
 *    :1545-1572, encode_base64 :1574-1609)
 *  - ValueProvenanceBuilder :1611-1824 (Direct/Reencoded/Generated
 *    relations; UniqueStringEntriesToObject marks Reencoded :1638-1652)
 *  - RFC 0007 §11 (:303-353) freezes the styles, anchor numbering, and
 *    exactness surface
 *  - vector-pinned behavior: conformance/vectors/yaml-v1.json
 *    (materialization.graph-cycle-flow :96-99 — `--- &g0 !!seq
 *    [!!str "one", *g0]`, materialization.value-flow :101-104 — `--- !!map
 *    {? !!str "a" : !!seq [!!int "1", !!bool "true"]}`)
 *
 * Design (TypeScript-idiomatic): a bounded writer accumulates exact output
 * bytes; the operation closes only when the output reparses as a Complete
 * document under the requested profile and reprojects to the identical
 * graph or value (RFC 0004 §7). Custom tags fail until a versioned
 * extension constructor contract is selected (RFC 0007 §11:323-325).
 */

import {
  CompleteMaterialization,
  FailedMaterializationAttempt,
  MaterializationProvenanceEntry,
  MaterializationProvenanceMap,
  MaterializationReport,
  MaterializationRequest,
  MaterializedOrigin,
} from '../document/materialization.ts';
import type {
  MaterializationFidelity,
  MaterializationInputLocation,
  MaterializationLimits,
  MaterializationRelation,
  MaterializationResult,
} from '../document/materialization.ts';
import { AssociationLocation, ValuePath } from '../document/portable_locations.ts';
import type { SourceEncoding } from '../document/source.ts';
import { diagnostic } from '../document/diagnostic.ts';
import type { Diagnostic } from '../document/diagnostic.ts';
import { MaterializationFailure } from '../document/errors.ts';
import type { NodeRef, Span } from '../document/identity.ts';
import { Builder, canonicalOrder } from '../graph/graph.ts';
import { GraphError } from '../graph/errors.ts';
import type { Graph, NodeID } from '../graph/graph.ts';
import type { PortableValue } from '../core/value.ts';
import { GraphMaterializationFailure } from './errors.ts';
import type { YamlDocument, YamlNode } from './document.ts';
import type { YamlNodeKind } from './semantic.ts';
import { parse } from './parser.ts';
import {
  encodeBase64,
  TAG_BINARY,
  TAG_BOOL,
  TAG_FLOAT,
  TAG_INT,
  TAG_MAP,
  TAG_MERGE,
  TAG_NULL,
  TAG_OMAP,
  TAG_PAIRS,
  TAG_SEQ,
  TAG_SET,
  TAG_STR,
  TAG_TIMESTAMP,
  TAG_VALUE,
  TAG_YAML,
} from './scalar.ts';
import type { YamlProfile } from './profile.ts';
import { projectGraph, projectValueComplete, ValueProjectionRequest } from './projection.ts';

// ---------------------------------------------------------------------------
// Graph materialization surface
// ---------------------------------------------------------------------------

/** A PortableGraph location consumed by YAML materialization (materialization.rs:32-60). */
export type GraphMaterializationInputLocation =
  | { readonly kind: 'Root'; readonly ordinal: bigint }
  | { readonly kind: 'Node'; readonly node: NodeID }
  | {
      readonly kind: 'SequenceElement';
      readonly parent: NodeID;
      readonly ordinal: bigint;
    }
  | {
      readonly kind: 'MappingKey';
      readonly parent: NodeID;
      readonly ordinal: bigint;
    }
  | {
      readonly kind: 'MappingValue';
      readonly parent: NodeID;
      readonly ordinal: bigint;
    };

/** One graph-input location mapped to one or more generated YAML origins (materialization.rs:62-69). */
export interface GraphMaterializationProvenanceEntry {
  /** Exact input location. */
  readonly input: GraphMaterializationInputLocation;
  /** One or more exact output origins. */
  readonly outputs: readonly MaterializedOrigin[];
}

/** Complete deterministic graph-to-YAML provenance multimap (materialization.rs:71-83). */
export class GraphMaterializationProvenanceMap {
  readonly #entries: readonly GraphMaterializationProvenanceEntry[];

  private constructor(entries: readonly GraphMaterializationProvenanceEntry[]) {
    this.#entries = Object.freeze([...entries]);
  }

  static create(entries: readonly GraphMaterializationProvenanceEntry[]): GraphMaterializationProvenanceMap {
    return new GraphMaterializationProvenanceMap(entries);
  }

  /** Entries in root, canonical-node, and association traversal order (materialization.rs:78-82). */
  entries(): readonly GraphMaterializationProvenanceEntry[] {
    return this.#entries;
  }
}

/** Failed graph attempt without a Document or partial output bytes (materialization.rs:160-167). */
export interface FailedGraphMaterializationAttempt {
  /** Stable failure. */
  readonly failure: GraphMaterializationFailure;
  /** Canonical input nodes analyzed before failure. */
  readonly analyzedInputNodes: readonly NodeID[];
}

/** Complete exact PortableGraph-to-YAML materialization (materialization.rs:169-180). */
export interface CompleteGraphMaterialization {
  /** Newly formed immutable YAML stream. */
  readonly document: YamlDocument;
  /** Always Exact for the published graph contract. */
  readonly fidelity: MaterializationFidelity;
  /** Complete structured report. */
  readonly report: MaterializationReport;
  /** Complete graph-input-to-YAML provenance. */
  readonly provenance: GraphMaterializationProvenanceMap;
}

/** Closed graph materialization completion algebra (materialization.rs:182-189). */
export type GraphMaterializationResult =
  | { readonly kind: 'Complete'; readonly value: CompleteGraphMaterialization }
  | { readonly kind: 'Failed'; readonly value: FailedGraphMaterializationAttempt };

/** Materializes one complete PortableGraph as a canonical YAML stream (materialization.rs:191-205). */
export function materializeGraph(
  graph: Graph,
  request: MaterializationRequest,
): GraphMaterializationResult {
  const analyzed: NodeID[] = [];
  try {
    const complete = materializeGraphComplete(graph, request, analyzed);
    return { kind: 'Complete', value: complete };
  } catch (error) {
    if (error instanceof GraphMaterializationFailure) {
      return { kind: 'Failed', value: { failure: error, analyzedInputNodes: analyzed } };
    }
    throw error;
  }
}

function materializeGraphComplete(
  graph: Graph,
  request: MaterializationRequest,
  analyzed: NodeID[],
): CompleteGraphMaterialization {
  const profile = requestedProfile(request);
  const style = requestedStyle(request);
  requestedOutputContract(request);
  const layout = GraphLayout.analyze(graph, request.limits());
  const writer = new GraphWriter(graph, layout, style, request, analyzed);
  const text = writer.stream();
  const raw = encodeOutput(text, request.encoding(), request.limits().maxOutputBytes);
  let document: YamlDocument;
  try {
    document = parse(raw, profile, parseLimitsFor(request.limits()));
  } catch {
    throw new GraphMaterializationFailure('Materialization', {
      failure: new MaterializationFailure('FormationFailed'),
    });
  }
  let reparsed: Graph;
  try {
    reparsed = projectGraph(document);
  } catch {
    // Any graph-projection failure on the generated bytes is a closure
    // mismatch (materialization.rs:225-227 maps the error away).
    throw new GraphMaterializationFailure('RoundTripMismatch');
  }
  if (!graphsEqual(reparsed, graph)) {
    throw new GraphMaterializationFailure('RoundTripMismatch');
  }
  const provenance = collectGraphProvenance(graph, document, request.limits());
  return {
    document,
    fidelity: 'Exact',
    report: new MaterializationReport([], request.limits()),
    provenance,
  };
}

// ---------------------------------------------------------------------------
// Graph materialization internals
// ---------------------------------------------------------------------------

type YamlStyle = 'Block' | 'Flow';

function requestedProfile(request: MaterializationRequest): YamlProfile {
  const profile = request.targetProfile();
  if (profile.id() === 'yaml.1.2-core' && profile.version() === 1) {
    return 'Yaml12CoreV1';
  }
  if (profile.id() === 'yaml.1.1-compat' && profile.version() === 1) {
    return 'Yaml11CompatV1';
  }
  throw new GraphMaterializationFailure('Materialization', {
    failure: new MaterializationFailure('UnsupportedProfile'),
  });
}

function requestedStyle(request: MaterializationRequest): YamlStyle {
  const style = request.style();
  if (style.id() === 'yaml.canonical-block' && style.version() === 1) {
    return 'Block';
  }
  if (style.id() === 'yaml.canonical-flow' && style.version() === 1) {
    return 'Flow';
  }
  throw new GraphMaterializationFailure('Materialization', {
    failure: new MaterializationFailure('UnsupportedStyle'),
  });
}

function requestedOutputContract(request: MaterializationRequest): void {
  const encoding = request.encoding();
  if (encoding.kind !== 'Utf8' && encoding.kind !== 'Utf16Le' && encoding.kind !== 'Utf16Be') {
    throw new GraphMaterializationFailure('Materialization', {
      failure: new MaterializationFailure('UnsupportedEncoding'),
    });
  }
  if (request.newline() === 'None') {
    throw new GraphMaterializationFailure('Materialization', {
      failure: new MaterializationFailure('UnsupportedNewline'),
    });
  }
}

function parseLimitsFor(limits: MaterializationLimits) {
  return {
    maxSourceBytes: limits.maxOutputBytes,
    maxNestingDepth: limits.maxDepth,
    maxTokenCount: limits.maxOutputBytes,
    maxNodeCount: limits.maxInputNodes * 4,
    maxDiagnostics: limits.maxReportEntries,
  };
}

class GraphLayout {
  readonly #anchorNames = new Map<string, number>();

  private constructor(anchorNames: Map<string, number>) {
    this.#anchorNames = anchorNames;
  }

  static analyze(graph: Graph, limits: MaterializationLimits): GraphLayout {
    const canonical: NodeID[] = [];
    const canonicalIds = new Map<string, number>();
    const stack: { id: NodeID; depth: number }[] = [];
    for (let index = graph.roots.length - 1; index >= 0; index--) {
      stack.push({ id: graph.roots[index], depth: 0 });
    }
    while (stack.length > 0) {
      const top = stack.pop()!;
      if (canonicalIds.has(nodeKey(top.id))) {
        continue;
      }
      if (top.depth > limits.maxDepth) {
        throw new GraphMaterializationFailure('Materialization', {
          failure: new MaterializationFailure('ResourceLimit', { reason: 'input-depth' }),
        });
      }
      if (canonical.length >= limits.maxInputNodes) {
        throw new GraphMaterializationFailure('Materialization', {
          failure: new MaterializationFailure('ResourceLimit', { reason: 'input-nodes' }),
        });
      }
      const node = graphNode(graph, top.id);
      validateTagKind(top.id, node.tag, node.kind);
      canonicalIds.set(nodeKey(top.id), canonical.length);
      canonical.push(top.id);
      const childDepth = top.depth + 1;
      switch (node.kind) {
        case 'Scalar':
          break;
        case 'Sequence':
          for (let index = node.items.length - 1; index >= 0; index--) {
            stack.push({ id: node.items[index], depth: childDepth });
          }
          break;
        case 'Mapping':
          for (let index = node.entries.length - 1; index >= 0; index--) {
            stack.push({ id: node.entries[index].value, depth: childDepth });
            stack.push({ id: node.entries[index].key, depth: childDepth });
          }
          break;
      }
    }

    const documentOwner = new Map<string, number>();
    const occurrences = new Map<string, number>();
    for (let rootOrdinal = 0; rootOrdinal < graph.roots.length; rootOrdinal++) {
      const root = graph.roots[rootOrdinal];
      const seen = new Set<string>();
      const pending: NodeID[] = [root];
      occurrences.set(nodeKey(root), (occurrences.get(nodeKey(root)) ?? 0) + 1);
      while (pending.length > 0) {
        const id = pending.pop()!;
        const key = nodeKey(id);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        if (documentOwner.has(key) && documentOwner.get(key) !== rootOrdinal) {
          throw new GraphMaterializationFailure('CrossDocumentSharing', { node: id });
        }
        documentOwner.set(key, rootOrdinal);
        const node = graphNode(graph, id);
        switch (node.kind) {
          case 'Scalar':
            break;
          case 'Sequence':
            for (const child of node.items) {
              occurrences.set(nodeKey(child), (occurrences.get(nodeKey(child)) ?? 0) + 1);
              pending.push(child);
            }
            break;
          case 'Mapping':
            for (const entry of node.entries) {
              for (const child of [entry.key, entry.value]) {
                occurrences.set(nodeKey(child), (occurrences.get(nodeKey(child)) ?? 0) + 1);
                pending.push(child);
              }
            }
            break;
        }
      }
    }
    const anchorNames = new Map<string, number>();
    let anchor = 0;
    for (const id of canonical) {
      if ((occurrences.get(nodeKey(id)) ?? 0) > 1) {
        anchorNames.set(nodeKey(id), anchor);
        anchor += 1;
      }
    }
    return new GraphLayout(anchorNames);
  }

  anchorName(id: NodeID): number | undefined {
    return this.#anchorNames.get(nodeKey(id));
  }
}

function validateTagKind(id: NodeID, tag: string, kind: 'Scalar' | 'Sequence' | 'Mapping'): void {
  let compatible: boolean;
  switch (tag) {
    case TAG_NULL:
    case TAG_BOOL:
    case TAG_INT:
    case TAG_FLOAT:
    case TAG_STR:
    case TAG_TIMESTAMP:
    case TAG_BINARY:
    case TAG_MERGE:
    case TAG_VALUE:
    case TAG_YAML:
      compatible = kind === 'Scalar';
      break;
    case TAG_SEQ:
    case TAG_OMAP:
    case TAG_PAIRS:
      compatible = kind === 'Sequence';
      break;
    case TAG_MAP:
    case TAG_SET:
      compatible = kind === 'Mapping';
      break;
    default:
      throw new GraphMaterializationFailure('UnsupportedTag', { node: id, tag });
  }
  if (!compatible) {
    throw new GraphMaterializationFailure('TagKindMismatch', { node: id, tag });
  }
}

class BoundedText {
  #text = '';
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  pushStr(value: string): void {
    const length = this.#text.length + value.length;
    if (length > this.#max) {
      throw new GraphMaterializationFailure('Materialization', {
        failure: new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' }),
      });
    }
    this.#text += value;
  }

  pushChar(value: string): void {
    this.pushStr(value);
  }

  finish(): string {
    return this.#text;
  }
}

class GraphWriter {
  readonly #graph: Graph;
  readonly #layout: GraphLayout;
  readonly #style: YamlStyle;
  readonly #newline: string;
  readonly #limits: MaterializationLimits;
  readonly #output: BoundedText;
  readonly #emitted = new Set<string>();
  readonly #analyzed: NodeID[];

  constructor(
    graph: Graph,
    layout: GraphLayout,
    style: YamlStyle,
    request: MaterializationRequest,
    analyzed: NodeID[],
  ) {
    this.#graph = graph;
    this.#layout = layout;
    this.#style = style;
    this.#newline = request.newline() === 'CrLf' ? '\r\n' : '\n';
    this.#limits = request.limits();
    this.#output = new BoundedText(request.limits().maxOutputBytes);
    this.#analyzed = analyzed;
  }

  stream(): string {
    for (let ordinal = 0; ordinal < this.#graph.roots.length; ordinal++) {
      if (ordinal !== 0) {
        this.#output.pushStr(this.#newline);
      }
      this.#emitted.clear();
      this.#output.pushStr('---');
      const root = this.#graph.roots[ordinal];
      if (this.#style === 'Block') {
        this.#blockAfterIndicator(root, 0, 0);
      } else {
        this.#output.pushChar(' ');
        this.#flowNode(root, 0);
      }
      this.#output.pushStr(this.#newline);
    }
    return this.#output.finish();
  }

  #flowNode(id: NodeID, depth: number): void {
    if (this.#writeAliasIfEmitted(id)) {
      return;
    }
    this.#beginDefinition(id, depth);
    this.#writeProperties(id);
    const node = graphNode(this.#graph, id);
    switch (node.kind) {
      case 'Scalar':
        this.#output.pushChar(' ');
        this.#writeQuoted(scalarPresentation(node.tag, node.content));
        break;
      case 'Sequence': {
        this.#output.pushStr(' [');
        for (let index = 0; index < node.items.length; index++) {
          if (index !== 0) {
            this.#output.pushStr(', ');
          }
          this.#flowNode(node.items[index], depth + 1);
        }
        this.#output.pushChar(']');
        break;
      }
      case 'Mapping': {
        this.#output.pushStr(' {');
        for (let index = 0; index < node.entries.length; index++) {
          if (index !== 0) {
            this.#output.pushStr(', ');
          }
          this.#output.pushStr('? ');
          this.#flowNode(node.entries[index].key, depth + 1);
          this.#output.pushStr(' : ');
          this.#flowNode(node.entries[index].value, depth + 1);
        }
        this.#output.pushChar('}');
        break;
      }
    }
  }

  #blockAfterIndicator(id: NodeID, childIndent: number, depth: number): void {
    if (this.#emitted.has(nodeKey(id))) {
      this.#output.pushChar(' ');
      this.#writeAlias(id);
      return;
    }
    const node = graphNode(this.#graph, id);
    const block =
      node.kind === 'Sequence'
        ? node.items.length > 0
        : node.kind === 'Mapping'
          ? node.entries.length > 0
          : false;
    this.#beginDefinition(id, depth);
    this.#output.pushChar(' ');
    this.#writeProperties(id);
    if (block) {
      this.#output.pushStr(this.#newline);
      this.#blockContent(id, childIndent, depth);
    } else {
      switch (node.kind) {
        case 'Scalar':
          this.#output.pushChar(' ');
          this.#writeQuoted(scalarPresentation(node.tag, node.content));
          break;
        case 'Sequence':
          this.#output.pushStr(' []');
          break;
        case 'Mapping':
          this.#output.pushStr(' {}');
          break;
      }
    }
  }

  #blockContent(id: NodeID, indent: number, depth: number): void {
    const node = graphNode(this.#graph, id);
    switch (node.kind) {
      case 'Scalar':
        throw new GraphMaterializationFailure('RoundTripMismatch');
      case 'Sequence': {
        for (let index = 0; index < node.items.length; index++) {
          if (index !== 0) {
            this.#output.pushStr(this.#newline);
          }
          this.#indent(indent);
          this.#output.pushChar('-');
          this.#blockAfterIndicator(node.items[index], indent + 2, depth + 1);
        }
        break;
      }
      case 'Mapping': {
        for (let index = 0; index < node.entries.length; index++) {
          if (index !== 0) {
            this.#output.pushStr(this.#newline);
          }
          this.#indent(indent);
          this.#output.pushChar('?');
          this.#blockAfterIndicator(node.entries[index].key, indent + 2, depth + 1);
          this.#output.pushStr(this.#newline);
          this.#indent(indent);
          this.#output.pushChar(':');
          this.#blockAfterIndicator(node.entries[index].value, indent + 2, depth + 1);
        }
        break;
      }
    }
  }

  #beginDefinition(id: NodeID, depth: number): void {
    if (depth > this.#limits.maxDepth) {
      throw new GraphMaterializationFailure('Materialization', {
        failure: new MaterializationFailure('ResourceLimit', { reason: 'input-depth' }),
      });
    }
    const key = nodeKey(id);
    if (this.#emitted.has(key)) {
      throw new GraphMaterializationFailure('RoundTripMismatch');
    }
    this.#emitted.add(key);
    if (this.#analyzed.length >= this.#limits.maxInputNodes) {
      throw new GraphMaterializationFailure('Materialization', {
        failure: new MaterializationFailure('ResourceLimit', { reason: 'input-nodes' }),
      });
    }
    this.#analyzed.push(id);
  }

  #writeAliasIfEmitted(id: NodeID): boolean {
    if (this.#emitted.has(nodeKey(id))) {
      this.#writeAlias(id);
      return true;
    }
    return false;
  }

  #writeAlias(id: NodeID): void {
    const anchor = this.#layout.anchorName(id);
    if (anchor === undefined) {
      throw new GraphMaterializationFailure('RoundTripMismatch');
    }
    this.#output.pushStr(`*g${anchor}`);
  }

  #writeProperties(id: NodeID): void {
    const anchor = this.#layout.anchorName(id);
    if (anchor !== undefined) {
      this.#output.pushStr(`&g${anchor} `);
    }
    const tag = graphNode(this.#graph, id).tag;
    if (!tag.startsWith('tag:yaml.org,2002:')) {
      throw new GraphMaterializationFailure('UnsupportedTag', { node: id, tag });
    }
    this.#output.pushStr(`!!${tag.slice('tag:yaml.org,2002:'.length)}`);
  }

  #writeQuoted(value: string): void {
    this.#output.pushChar('"');
    for (const character of value) {
      switch (character) {
        case '"':
          this.#output.pushStr('\\"');
          break;
        case '\\':
          this.#output.pushStr('\\\\');
          break;
        case '\b':
          this.#output.pushStr('\\b');
          break;
        case '\t':
          this.#output.pushStr('\\t');
          break;
        case '\n':
          this.#output.pushStr('\\n');
          break;
        case '\f':
          this.#output.pushStr('\\f');
          break;
        case '\r':
          this.#output.pushStr('\\r');
          break;
        default: {
          const code = character.codePointAt(0)!;
          if ((code >= 0x0000 && code <= 0x001f) || code === 0x007f) {
            this.#output.pushStr(`\\u${code.toString(16).padStart(4, '0')}`);
          } else {
            this.#output.pushChar(character);
          }
          break;
        }
      }
    }
    this.#output.pushChar('"');
  }

  #indent(spaces: number): void {
    for (let index = 0; index < spaces; index++) {
      this.#output.pushChar(' ');
    }
  }
}

/** scalar_presentation (materialization.rs:719-728). */
function scalarPresentation(tag: string, canonical: string): string {
  if (
    tag === TAG_FLOAT &&
    canonical !== '.inf' &&
    canonical !== '-.inf' &&
    canonical !== '.nan' &&
    !canonical.includes('.') &&
    !canonical.includes('e') &&
    !canonical.includes('E')
  ) {
    return `${canonical}e0`;
  }
  return canonical;
}

function encodeOutput(
  text: string,
  encoding: SourceEncoding,
  max: number,
): Uint8Array {
  if (encoding.kind === 'Utf8') {
    if (text.length > max) {
      throw new GraphMaterializationFailure('Materialization', {
        failure: new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' }),
      });
    }
    return new TextEncoder().encode(text);
  }
  if (encoding.kind === 'Utf16Le' || encoding.kind === 'Utf16Be') {
    const units = text.length;
    const length = units * 2 + 2;
    if (length > max) {
      throw new GraphMaterializationFailure('Materialization', {
        failure: new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' }),
      });
    }
    const output: number[] = encoding.kind === 'Utf16Le' ? [0xff, 0xfe] : [0xfe, 0xff];
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
  throw new GraphMaterializationFailure('Materialization', {
    failure: new MaterializationFailure('UnsupportedEncoding'),
  });
}

function collectGraphProvenance(
  graph: Graph,
  document: YamlDocument,
  limits: MaterializationLimits,
): GraphMaterializationProvenanceMap {
  if (graph.roots.length !== document.documentCount()) {
    throw new GraphMaterializationFailure('RoundTripMismatch');
  }
  const builder = new GraphProvenanceBuilder(document, limits);
  for (let index = 0; index < graph.roots.length; index++) {
    const inputRoot = graph.roots[index];
    const outputDocument = document.document(index);
    if (outputDocument === null) {
      throw new GraphMaterializationFailure('RoundTripMismatch');
    }
    builder.push(
      { kind: 'Root', ordinal: BigInt(index) },
      new MaterializedOrigin(
        document.snapshotIdentity(),
        outputDocument.nodeRef(),
        outputDocument.span(),
        'Generated',
      ),
    );
    builder.collectNode(graph, inputRoot, outputDocument.root());
  }
  return GraphMaterializationProvenanceMap.create(builder.entries());
}

class GraphProvenanceBuilder {
  readonly #document: YamlDocument;
  readonly #limits: MaterializationLimits;
  #units = 0;
  #entries: GraphMaterializationProvenanceEntry[] = [];
  readonly #seen = new Set<string>();
  readonly #index = new Map<string, number>();

  constructor(document: YamlDocument, limits: MaterializationLimits) {
    this.#document = document;
    this.#limits = limits;
  }

  entries(): readonly GraphMaterializationProvenanceEntry[] {
    return this.#entries;
  }

  collectNode(graph: Graph, input: NodeID, output: YamlNode): void {
    const key = nodeKey(input);
    if (this.#seen.has(key)) {
      return;
    }
    this.#seen.add(key);
    const node = graphNode(graph, input);
    const expectedKind: YamlNodeKind =
      node.kind === 'Scalar' ? 'Scalar' : node.kind === 'Sequence' ? 'Sequence' : 'Mapping';
    if (output.kind() !== expectedKind || output.tag() !== node.tag) {
      throw new GraphMaterializationFailure('RoundTripMismatch');
    }
    if (
      node.kind === 'Scalar' &&
      output.scalar() !== null &&
      output.scalar()!.canonical() !== node.content
    ) {
      throw new GraphMaterializationFailure('RoundTripMismatch');
    }
    this.push(
      { kind: 'Node', node: input },
      this.#origin(output.nodeRef(), output.span(), 'Direct'),
    );
    switch (node.kind) {
      case 'Scalar':
        break;
      case 'Sequence': {
        if (output.sequenceLen() !== node.items.length) {
          throw new GraphMaterializationFailure('RoundTripMismatch');
        }
        for (let index = 0; index < node.items.length; index++) {
          const edge = output.sequenceItem(index);
          if (edge === null) {
            throw new GraphMaterializationFailure('RoundTripMismatch');
          }
          const location: GraphMaterializationInputLocation = {
            kind: 'SequenceElement',
            parent: input,
            ordinal: BigInt(index),
          };
          this.push(location, this.#origin(edge.nodeRef(), edge.span(), 'Direct'));
          const alias = edge.alias();
          if (alias !== null) {
            this.add(location, this.#origin(alias.nodeRef(), alias.span(), 'Reencoded'));
          }
          this.collectNode(graph, node.items[index], edge.node());
        }
        break;
      }
      case 'Mapping': {
        if (output.mappingLen() !== node.entries.length) {
          throw new GraphMaterializationFailure('RoundTripMismatch');
        }
        for (let index = 0; index < node.entries.length; index++) {
          const outputEntry = output.mappingEntry(index);
          if (outputEntry === null) {
            throw new GraphMaterializationFailure('RoundTripMismatch');
          }
          const ordinal = BigInt(index);
          const pairs: [GraphMaterializationInputLocation, import('./document.ts').YamlAlias | null][] = [
            [{ kind: 'MappingKey', parent: input, ordinal }, outputEntry.keyAlias()],
            [{ kind: 'MappingValue', parent: input, ordinal }, outputEntry.valueAlias()],
          ];
          for (const [location, alias] of pairs) {
            this.push(location, this.#origin(outputEntry.nodeRef(), outputEntry.span(), 'Direct'));
            if (alias !== null) {
              this.add(location, this.#origin(alias.nodeRef(), alias.span(), 'Reencoded'));
            }
          }
          this.collectNode(graph, node.entries[index].key, outputEntry.key());
          this.collectNode(graph, node.entries[index].value, outputEntry.value());
        }
        break;
      }
    }
  }

  #origin(node: NodeRef, span: Span, relation: MaterializationRelation): MaterializedOrigin {
    return new MaterializedOrigin(this.#document.snapshotIdentity(), node, span, relation);
  }

  /** Registers one new provenance entry (materialization.rs:821-836). */
  push(input: GraphMaterializationInputLocation, output: MaterializedOrigin): void {
    this.#units += 2;
    if (this.#units > this.#limits.maxProvenanceEntries) {
      throw new GraphMaterializationFailure('Materialization', {
        failure: new MaterializationFailure('ResourceLimit', { reason: 'provenance-entries' }),
      });
    }
    const key = graphInputKey(input);
    this.#index.set(key, this.#entries.length);
    this.#entries.push({ input, outputs: [output] });
  }

  /** Appends one alias origin to an existing entry (materialization.rs:837-843). */
  add(input: GraphMaterializationInputLocation, output: MaterializedOrigin): void {
    this.#units += 1;
    if (this.#units > this.#limits.maxProvenanceEntries) {
      throw new GraphMaterializationFailure('Materialization', {
        failure: new MaterializationFailure('ResourceLimit', { reason: 'provenance-entries' }),
      });
    }
    const position = this.#index.get(graphInputKey(input));
    if (position === undefined) {
      throw new GraphMaterializationFailure('RoundTripMismatch');
    }
    const prior = this.#entries[position];
    this.#entries[position] = { input: prior.input, outputs: [...prior.outputs, output] };
  }
}

// ---------------------------------------------------------------------------
// Value materialization
// ---------------------------------------------------------------------------

/** Materializes one complete PortableValue into a canonical YAML document (materialization.rs:1058-1078). */
export function materializeValue(
  value: PortableValue,
  request: MaterializationRequest,
): MaterializationResult<YamlDocument> {
  const attempt: ValueAttempt = { analyzed: [], events: [], inputNodes: 0 };
  try {
    return { kind: 'Complete', value: materializeValueComplete(value, request, attempt) };
  } catch (error) {
    const failure =
      error instanceof MaterializationFailure
        ? error
        : error instanceof GraphMaterializationFailure && error.failure !== undefined
          ? error.failure
          : null;
    if (failure !== null) {
      return {
        kind: 'Failed',
        value: new FailedMaterializationAttempt(
          failure,
          new MaterializationReport(attempt.events, request.limits()),
          attempt.analyzed,
        ),
      };
    }
    throw error;
  }
}

interface ValueAttempt {
  readonly analyzed: ValuePath[];
  readonly events: Diagnostic[];
  inputNodes: number;
}

function materializeValueComplete(
  value: PortableValue,
  request: MaterializationRequest,
  attempt: ValueAttempt,
): CompleteMaterialization<YamlDocument> {
  requestedProfile(request);
  requestedStyle(request);
  requestedOutputContract(request);
  const prepared = prepareValue(value, ValuePath.root(), 0, request, attempt);
  const graph = valueGraph(prepared, request.limits());
  const graphLimits: MaterializationLimits = {
    ...request.limits(),
    maxInputNodes: request.limits().maxInputNodes * 2 + 1,
  };
  const graphRequest = request.withLimits(graphLimits);
  const graphAnalyzed: NodeID[] = [];
  let graphComplete: CompleteGraphMaterialization;
  try {
    graphComplete = materializeGraphComplete(graph, graphRequest, graphAnalyzed);
  } catch (error) {
    if (error instanceof GraphMaterializationFailure) {
      if (error.kind === 'Materialization' && error.failure !== undefined) {
        throw error.failure;
      }
      throw new MaterializationFailure('FormationFailed');
    }
    throw error;
  }
  const document = graphComplete.document;
  const projected = projectValueComplete(document, ValueProjectionRequest.bestExactV1());
  if (projected.kind !== 'Complete' || projected.complete.fidelity !== 'Exact') {
    throw new MaterializationFailure('FormationFailed');
  }
  if (!valuesEqual(projected.complete.value, prepared)) {
    throw new MaterializationFailure('FormationFailed');
  }
  const provenanceBuilder = new ValueProvenanceBuilder(document, request);
  provenanceBuilder.collect(value, ValuePath.root(), document.document(0)!.root());
  const provenance = MaterializationProvenanceMap.create(
    provenanceBuilder.entries(),
    document.snapshotIdentity(),
    request.limits(),
  );
  const report = new MaterializationReport(attempt.events, request.limits());
  return new CompleteMaterialization(
    document,
    report.events().length === 0 ? 'Exact' : 'Transformed',
    report,
    provenance,
  );
}

function prepareValue(
  value: PortableValue,
  path: ValuePath,
  depth: number,
  request: MaterializationRequest,
  attempt: ValueAttempt,
): PortableValue {
  if (depth > request.limits().maxDepth) {
    throw new MaterializationFailure('ResourceLimit', { reason: 'input-depth' });
  }
  attempt.inputNodes += 1;
  if (attempt.inputNodes > request.limits().maxInputNodes) {
    throw new MaterializationFailure('ResourceLimit', { reason: 'input-nodes' });
  }
  attempt.analyzed.push(path);
  const childDepth = depth + 1;
  switch (value.kind) {
    case 'Null':
    case 'Boolean':
    case 'Integer':
    case 'Decimal':
    case 'String':
    case 'Bytes':
      return value;
    case 'BinaryFloat64': {
      const bits = value.bits;
      if (bits === 0x7ff0000000000000n || bits === 0xfff0000000000000n || bits === 0x7ff8000000000000n) {
        return value;
      }
      break;
    }
    case 'Date': {
      if (!dateInRange(value.year)) {
        break;
      }
      return value;
    }
    case 'OffsetDateTime': {
      const seconds = value.offsetSeconds;
      if (!dateInRange(value.local.date.year) || seconds % 60 !== 0) {
        break;
      }
      return value;
    }
    case 'Sequence': {
      const items: PortableValue[] = [];
      for (let index = 0; index < value.items.length; index++) {
        items.push(
          prepareValue(
            value.items[index],
            path.child({ kind: 'SequenceElement', index: BigInt(index) }),
            childDepth,
            request,
            attempt,
          ),
        );
      }
      return { kind: 'Sequence', items };
    }
    case 'Object': {
      const entries: { key: string; value: PortableValue }[] = [];
      for (const entry of value.entries) {
        entries.push({
          key: entry.key,
          value: prepareValue(
            entry.value,
            path.child({ kind: 'ObjectValue', name: entry.key }),
            childDepth,
            request,
            attempt,
          ),
        });
      }
      return { kind: 'Object', entries };
    }
    case 'EntryMapping':
      return prepareMapping(value.entries, path, childDepth, request, attempt);
    case 'BinaryFloat32':
    case 'Time':
    case 'LocalDateTime':
      break;
  }
  throw new MaterializationFailure('Unrepresentable', { path, valueKind: value.kind });
}

function prepareMapping(
  entries: readonly { key: PortableValue; value: PortableValue }[],
  path: ValuePath,
  childDepth: number,
  request: MaterializationRequest,
  attempt: ValueAttempt,
): PortableValue {
  const names = new Set<string>();
  let object = true;
  for (const entry of entries) {
    if (entry.key.kind !== 'String' || names.has(entry.key.value)) {
      object = false;
      break;
    }
    names.add(entry.key.value);
  }
  if (object) {
    if (request.mappingPolicy() !== 'UniqueStringEntriesToObject') {
      throw new MaterializationFailure('Unrepresentable', {
        path,
        valueKind: 'EntryMapping',
      });
    }
    const observed = attempt.events.length + 1;
    if (observed > request.limits().maxReportEntries) {
      throw new MaterializationFailure('ResourceLimit', { reason: 'report-entries' });
    }
    attempt.events.push(
      diagnostic(
        'core.materialization.mapping-transformed@1',
        'Materialization',
        'Info',
        null,
        BigInt(attempt.events.length),
        {
          arguments: [
            ['from', 'EntryMapping'],
            ['policy', 'UniqueStringEntriesToObject'],
            ['to', 'Object'],
            ['path', pathKeyForDiagnostic(path)],
          ],
        },
      ),
    );
  }
  const prepared: { key: PortableValue; value: PortableValue }[] = [];
  for (let index = 0; index < entries.length; index++) {
    const key = prepareValue(
      entries[index].key,
      path.child({ kind: 'EntryKey', index: BigInt(index) }),
      childDepth,
      request,
      attempt,
    );
    const value = prepareValue(
      entries[index].value,
      path.child({ kind: 'EntryValue', index: BigInt(index) }),
      childDepth,
      request,
      attempt,
    );
    prepared.push({ key, value });
  }
  if (object) {
    const output: { key: string; value: PortableValue }[] = [];
    for (const { key, value } of prepared) {
      if (key.kind !== 'String') {
        throw new MaterializationFailure('FormationFailed');
      }
      output.push({ key: key.value, value });
    }
    return { kind: 'Object', entries: output };
  }
  return { kind: 'EntryMapping', entries: prepared };
}

function valueGraph(value: PortableValue, limits: MaterializationLimits): Graph {
  const maxNodes = limits.maxInputNodes * 2 + 1;
  const builder = new Builder({
    maxRoots: 1,
    maxNodes,
    maxEdges: maxNodes * 2,
    maxContainerEntries: limits.maxInputNodes,
    maxTagBytes: 64,
    maxScalarBytes: limits.maxOutputBytes,
    maxTraversalDepth: limits.maxDepth,
  });
  try {
    const root = defineValueNode(builder, value, limits.maxOutputBytes);
    builder.pushRoot(root);
    return builder.build();
  } catch (error) {
    // graph_build_failure (materialization.rs:1492-1503): limits map to
    // ResourceLimit; structural violations are formation failures.
    if (error instanceof GraphError) {
      if (error.kind === 'ResourceLimit') {
        throw new MaterializationFailure('ResourceLimit', { reason: error.field ?? 'graph-size' });
      }
      if (error.kind === 'SizeOverflow') {
        throw new MaterializationFailure('ResourceLimit', { reason: 'graph-size' });
      }
      throw new MaterializationFailure('FormationFailed');
    }
    throw error;
  }
}

function defineValueNode(builder: Builder, value: PortableValue, maxOutputBytes: number): NodeID {
  const id = builder.reserveNode();
  switch (value.kind) {
    case 'Null':
      builder.defineScalar(id, TAG_NULL, '');
      break;
    case 'Boolean':
      builder.defineScalar(id, TAG_BOOL, value.value ? 'true' : 'false');
      break;
    case 'Integer':
      builder.defineScalar(id, TAG_INT, value.value.toString());
      break;
    case 'Decimal': {
      const canonical =
        value.exponent === 0n
          ? value.coefficient.toString()
          : `${value.coefficient}e${value.exponent}`;
      builder.defineScalar(id, TAG_FLOAT, canonical);
      break;
    }
    case 'BinaryFloat64': {
      let canonical: string;
      switch (value.bits) {
        case 0x7ff0000000000000n:
          canonical = '.inf';
          break;
        case 0xfff0000000000000n:
          canonical = '-.inf';
          break;
        case 0x7ff8000000000000n:
          canonical = '.nan';
          break;
        default:
          throw new MaterializationFailure('FormationFailed');
      }
      builder.defineScalar(id, TAG_FLOAT, canonical);
      break;
    }
    case 'String':
      builder.defineScalar(id, TAG_STR, value.value);
      break;
    case 'Bytes':
      builder.defineScalar(id, TAG_BINARY, encodeBase64(value.value));
      break;
    case 'Date': {
      const canonical = canonicalDate(value);
      if (canonical === null) {
        throw new MaterializationFailure('FormationFailed');
      }
      builder.defineScalar(id, TAG_TIMESTAMP, canonical);
      break;
    }
    case 'OffsetDateTime': {
      const canonical = canonicalOffsetDateTime(value, maxOutputBytes);
      if (canonical === null) {
        throw new MaterializationFailure('FormationFailed');
      }
      builder.defineScalar(id, TAG_TIMESTAMP, canonical);
      break;
    }
    case 'Sequence': {
      const children: NodeID[] = [];
      for (const child of value.items) {
        children.push(defineValueNode(builder, child, maxOutputBytes));
      }
      builder.defineSequence(id, TAG_SEQ, children);
      break;
    }
    case 'Object': {
      const entries: { key: NodeID; value: NodeID }[] = [];
      for (const entry of value.entries) {
        const key = builder.reserveNode();
        builder.defineScalar(key, TAG_STR, entry.key);
        const child = defineValueNode(builder, entry.value, maxOutputBytes);
        entries.push({ key, value: child });
      }
      builder.defineMapping(id, TAG_MAP, entries);
      break;
    }
    case 'EntryMapping': {
      const entries: { key: NodeID; value: NodeID }[] = [];
      for (const entry of value.entries) {
        const key = defineValueNode(builder, entry.key, maxOutputBytes);
        const child = defineValueNode(builder, entry.value, maxOutputBytes);
        entries.push({ key, value: child });
      }
      builder.defineMapping(id, TAG_MAP, entries);
      break;
    }
    case 'BinaryFloat32':
    case 'Time':
    case 'LocalDateTime':
      throw new MaterializationFailure('FormationFailed');
  }
  return id;
}

function canonicalDate(value: { year: bigint; month: number; day: number }): string | null {
  if (!dateInRange(value.year)) {
    return null;
  }
  const year = value.year < 0n ? -value.year : value.year;
  return `${year.toString().padStart(4, '0')}-${value.month.toString().padStart(2, '0')}-${value.day
    .toString()
    .padStart(2, '0')}`;
}

function dateInRange(year: bigint): boolean {
  return year >= 0n && year <= 9999n;
}

function canonicalOffsetDateTime(
  value: { local: { date: { year: bigint; month: number; day: number }; time: { hour: number; minute: number; second: number; fraction: { kind: 'Decimal'; coefficient: bigint; exponent: bigint } } }; offsetSeconds: number },
  maxOutputBytes: number,
): string | null {
  const date = canonicalDate(value.local.date);
  if (date === null) {
    return null;
  }
  const fraction = canonicalFraction(value.local.time.fraction, maxOutputBytes);
  if (fraction === null) {
    return null;
  }
  const seconds = value.offsetSeconds;
  if (seconds % 60 !== 0) {
    return null;
  }
  let zone: string;
  if (seconds === 0) {
    zone = 'Z';
  } else {
    const sign = seconds < 0 ? '-' : '+';
    const absolute = Math.abs(seconds);
    zone = `${sign}${Math.floor(absolute / 3600)
      .toString()
      .padStart(2, '0')}:${Math.floor((absolute % 3600) / 60)
      .toString()
      .padStart(2, '0')}`;
  }
  const output = `${date}T${value.local.time.hour
    .toString()
    .padStart(2, '0')}:${value.local.time.minute
    .toString()
    .padStart(2, '0')}:${value.local.time.second
    .toString()
    .padStart(2, '0')}${fraction}${zone}`;
  if (output.length > maxOutputBytes) {
    throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
  }
  return output;
}

function canonicalFraction(
  value: { kind: 'Decimal'; coefficient: bigint; exponent: bigint },
  max: number,
): string | null {
  if (value.coefficient === 0n) {
    return '';
  }
  if (value.coefficient < 0n) {
    throw new MaterializationFailure('FormationFailed');
  }
  const exponent = value.exponent;
  if (exponent > Number.MAX_SAFE_INTEGER || exponent < Number.MIN_SAFE_INTEGER) {
    throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
  }
  const places = -Number(exponent);
  if (places < 0) {
    throw new MaterializationFailure('FormationFailed');
  }
  const digits = value.coefficient.toString();
  if (exponent >= 0n || digits.length > places) {
    throw new MaterializationFailure('FormationFailed');
  }
  if (places + 1 > max) {
    throw new MaterializationFailure('ResourceLimit', { reason: 'output-bytes' });
  }
  return `.${'0'.repeat(places - digits.length)}${digits}`;
}

class ValueProvenanceBuilder {
  readonly #document: YamlDocument;
  readonly #request: MaterializationRequest;
  #units = 0;
  #entries: MaterializationProvenanceEntry[] = [];
  readonly #index = new Map<string, number>();

  constructor(document: YamlDocument, request: MaterializationRequest) {
    this.#document = document;
    this.#request = request;
  }

  entries(): readonly MaterializationProvenanceEntry[] {
    return this.#entries;
  }

  collect(input: PortableValue, path: ValuePath, output: YamlNode): void {
    const transformed =
      input.kind === 'EntryMapping' && mappingHasUniqueStringKeys(input.entries);
    this.#push(
      { kind: 'Value', path },
      this.#origin(output.nodeRef(), output.span(), transformed ? 'Reencoded' : 'Direct'),
    );
    switch (input.kind) {
      case 'Sequence': {
        if (output.sequenceLen() !== input.items.length) {
          throw new MaterializationFailure('FormationFailed');
        }
        for (let index = 0; index < input.items.length; index++) {
          const item = output.sequenceItem(index);
          if (item === null) {
            throw new MaterializationFailure('FormationFailed');
          }
          const childPath = path.child({ kind: 'SequenceElement', index: BigInt(index) });
          this.collect(input.items[index], childPath, item.node());
          this.#add(
            { kind: 'Value', path: childPath },
            this.#origin(item.nodeRef(), item.span(), 'Generated'),
          );
        }
        break;
      }
      case 'Object': {
        if (output.mappingLen() !== input.entries.length) {
          throw new MaterializationFailure('FormationFailed');
        }
        for (let index = 0; index < input.entries.length; index++) {
          const value = input.entries[index];
          const entry = output.mappingEntry(index);
          if (entry === null) {
            throw new MaterializationFailure('FormationFailed');
          }
          const keyScalar = entry.key().scalar();
          if (keyScalar === null || keyScalar.canonical() !== value.key) {
            throw new MaterializationFailure('FormationFailed');
          }
          const ordinal = BigInt(index);
          this.#push(
            {
              kind: 'Association',
              location: new AssociationLocation(path, ordinal, 'ObjectEntry'),
            },
            this.#origin(entry.nodeRef(), entry.span(), 'Direct'),
          );
          this.#push(
            {
              kind: 'Association',
              location: new AssociationLocation(path, ordinal, 'ObjectKey'),
            },
            this.#origin(entry.key().nodeRef(), entry.key().span(), 'Direct'),
          );
          this.collect(
            value.value,
            path.child({ kind: 'ObjectValue', name: value.key }),
            entry.value(),
          );
        }
        break;
      }
      case 'EntryMapping': {
        if (output.mappingLen() !== input.entries.length) {
          throw new MaterializationFailure('FormationFailed');
        }
        for (let index = 0; index < input.entries.length; index++) {
          const value = input.entries[index];
          const entry = output.mappingEntry(index);
          if (entry === null) {
            throw new MaterializationFailure('FormationFailed');
          }
          const ordinal = BigInt(index);
          this.#push(
            {
              kind: 'Association',
              location: new AssociationLocation(path, ordinal, 'EntryMappingEntry'),
            },
            this.#origin(entry.nodeRef(), entry.span(), transformed ? 'Reencoded' : 'Direct'),
          );
          this.collect(
            value.key,
            path.child({ kind: 'EntryKey', index: ordinal }),
            entry.key(),
          );
          this.collect(
            value.value,
            path.child({ kind: 'EntryValue', index: ordinal }),
            entry.value(),
          );
        }
        break;
      }
      default:
        break;
    }
  }

  #origin(node: NodeRef, span: Span, relation: MaterializationRelation): MaterializedOrigin {
    return new MaterializedOrigin(this.#document.snapshotIdentity(), node, span, relation);
  }

  #push(input: MaterializationInputLocation, output: MaterializedOrigin): void {
    this.#units += 2;
    if (this.#units > this.#request.limits().maxProvenanceEntries) {
      throw new MaterializationFailure('ResourceLimit', { reason: 'provenance-entries' });
    }
    const key = materializationInputKey(input);
    this.#index.set(key, this.#entries.length);
    this.#entries.push(new MaterializationProvenanceEntry(input, [output]));
  }

  #add(input: MaterializationInputLocation, output: MaterializedOrigin): void {
    this.#units += 1;
    if (this.#units > this.#request.limits().maxProvenanceEntries) {
      throw new MaterializationFailure('ResourceLimit', { reason: 'provenance-entries' });
    }
    const position = this.#index.get(materializationInputKey(input));
    if (position === undefined) {
      throw new MaterializationFailure('FormationFailed');
    }
    const prior = this.#entries[position];
    this.#entries[position] = new MaterializationProvenanceEntry(prior.input(), [...prior.outputs(), output]);
  }
}

function mappingHasUniqueStringKeys(
  entries: readonly { key: PortableValue; value: PortableValue }[],
): boolean {
  const names = new Set<string>();
  return entries.every((entry) => entry.key.kind === 'String' && !names.has(entry.key.value) && (names.add(entry.key.value), true));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function graphNode(graph: Graph, id: NodeID): import('../graph/graph.ts').Node {
  if (id.graph !== graph.identity || id.index < 0 || id.index >= graph.nodes.length) {
    throw new GraphMaterializationFailure('Materialization', {
      failure: new MaterializationFailure('InvalidRequest', { reason: 'foreign graph node' }),
    });
  }
  return graph.nodes[id.index];
}

function nodeKey(id: NodeID): string {
  return `${id.graph}:${id.index}`;
}

function graphInputKey(location: GraphMaterializationInputLocation): string {
  switch (location.kind) {
    case 'Root':
      return `root:${location.ordinal}`;
    case 'Node':
      return `node:${nodeKey(location.node)}`;
    case 'SequenceElement':
      return `seq:${nodeKey(location.parent)}:${location.ordinal}`;
    case 'MappingKey':
      return `key:${nodeKey(location.parent)}:${location.ordinal}`;
    case 'MappingValue':
      return `val:${nodeKey(location.parent)}:${location.ordinal}`;
  }
}

function materializationInputKey(location: MaterializationInputLocation): string {
  switch (location.kind) {
    case 'Value':
      return `value:${pathKeyForDiagnostic(location.path)}`;
    case 'Association':
      return `assoc:${pathKeyForDiagnostic(location.location.container())}:${location.location.ordinal()}:${location.location.role()}`;
  }
}

function pathKeyForDiagnostic(path: ValuePath): string {
  return path
    .segments()
    .map((segment) => {
      switch (segment.kind) {
        case 'ObjectValue':
          return `o:${segment.name}`;
        case 'SequenceElement':
          return `s:${segment.index}`;
        case 'EntryKey':
          return `k:${segment.index}`;
        case 'EntryValue':
          return `v:${segment.index}`;
      }
    })
    .join('/');
}

/**
 * Structural graph equality for the reparse closure (materialization.rs:222-230).
 * Nodes are compared in canonical first-visit order (RFC 0006 §4): the
 * TS Graph stores reservation order, so the canonical ID mapping of
 * graph.ts canonicalOrder is applied to both sides.
 */
export function graphsEqual(left: Graph, right: Graph): boolean {
  if (left.roots.length !== right.roots.length || left.nodes.length !== right.nodes.length) {
    return false;
  }
  const leftOrder = canonicalOrder(left.nodes, left.roots, -1).order;
  const rightOrder = canonicalOrder(right.nodes, right.roots, -1).order;
  const leftPosition = new Map<number, number>();
  const rightPosition = new Map<number, number>();
  leftOrder.forEach((index, position) => leftPosition.set(index, position));
  rightOrder.forEach((index, position) => rightPosition.set(index, position));
  for (let position = 0; position < leftOrder.length; position++) {
    const a = left.nodes[leftOrder[position]];
    const b = right.nodes[rightOrder[position]];
    if (a === undefined || b === undefined || a.kind !== b.kind || a.tag !== b.tag) {
      return false;
    }
    switch (a.kind) {
      case 'Scalar':
        if (a.content !== (b as { content: string }).content) {
          return false;
        }
        break;
      case 'Sequence': {
        const bItems = (b as { items: readonly NodeID[] }).items;
        if (a.items.length !== bItems.length) {
          return false;
        }
        for (let index = 0; index < a.items.length; index++) {
          if (leftPosition.get(a.items[index].index) !== rightPosition.get(bItems[index].index)) {
            return false;
          }
        }
        break;
      }
      case 'Mapping': {
        const bEntries = (b as { entries: readonly { key: NodeID; value: NodeID }[] }).entries;
        if (a.entries.length !== bEntries.length) {
          return false;
        }
        for (let index = 0; index < a.entries.length; index++) {
          if (
            leftPosition.get(a.entries[index].key.index) !== rightPosition.get(bEntries[index].key.index) ||
            leftPosition.get(a.entries[index].value.index) !== rightPosition.get(bEntries[index].value.index)
          ) {
            return false;
          }
        }
        break;
      }
    }
  }
  return true;
}

/** Strict value equality over the fifteen-kind model. */
export function valuesEqual(left: PortableValue, right: PortableValue): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case 'Null':
      return true;
    case 'Boolean':
      return left.value === (right as { value: boolean }).value;
    case 'Integer':
      return left.value === (right as { value: bigint }).value;
    case 'Decimal':
      return (
        left.coefficient === (right as { coefficient: bigint }).coefficient &&
        left.exponent === (right as { exponent: bigint }).exponent
      );
    case 'BinaryFloat32':
      return left.bits === (right as { bits: number }).bits;
    case 'BinaryFloat64':
      return left.bits === (right as { bits: bigint }).bits;
    case 'String':
      return left.value === (right as { value: string }).value;
    case 'Bytes': {
      const a = left.value;
      const b = (right as { value: Uint8Array }).value;
      if (a.length !== b.length) {
        return false;
      }
      for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) {
          return false;
        }
      }
      return true;
    }
    case 'Date':
      return (
        left.year === (right as { year: bigint }).year &&
        left.month === (right as { month: number }).month &&
        left.day === (right as { day: number }).day
      );
    case 'Time':
      return (
        left.hour === (right as { hour: number }).hour &&
        left.minute === (right as { minute: number }).minute &&
        left.second === (right as { second: number }).second &&
        valuesEqual(left.fraction, (right as { fraction: PortableValue }).fraction)
      );
    case 'LocalDateTime':
      return (
        valuesEqual(left.date, (right as { date: PortableValue }).date) &&
        valuesEqual(left.time, (right as { time: PortableValue }).time)
      );
    case 'OffsetDateTime':
      return (
        valuesEqual(left.local, (right as { local: PortableValue }).local) &&
        left.offsetSeconds === (right as { offsetSeconds: number }).offsetSeconds
      );
    case 'Sequence':
      return listValuesEqual(
        left.items,
        (right as { items: readonly PortableValue[] }).items,
      );
    case 'Object': {
      const a = left.entries;
      const b = (right as { entries: readonly { key: string; value: PortableValue }[] }).entries;
      if (a.length !== b.length) {
        return false;
      }
      for (let index = 0; index < a.length; index++) {
        if (a[index].key !== b[index].key || !valuesEqual(a[index].value, b[index].value)) {
          return false;
        }
      }
      return true;
    }
    case 'EntryMapping': {
      const a = left.entries;
      const b = (right as { entries: readonly { key: PortableValue; value: PortableValue }[] }).entries;
      if (a.length !== b.length) {
        return false;
      }
      for (let index = 0; index < a.length; index++) {
        if (!valuesEqual(a[index].key, b[index].key) || !valuesEqual(a[index].value, b[index].value)) {
          return false;
        }
      }
      return true;
    }
  }
}

function listValuesEqual(left: readonly PortableValue[], right: readonly PortableValue[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (!valuesEqual(left[index], right[index])) {
      return false;
    }
  }
  return true;
}

