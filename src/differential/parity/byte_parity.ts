/**
 * Cross-language PVCE/PGCE byte-parity harness — TypeScript side (design:
 * docs/five-language-ci-design.md §3.2; Go precedent:
 * go/conformance/differential/differential_test.go).
 *
 * The shared case set (go/conformance/differential/cases.json, 68 cases: 51
 * PVCE + 17 PGCE) is encoded by both sides. The Rust encoder's bytes
 * (crates/consema-conformance/examples/emit_parity_bytes.rs, provisioned by
 * scripts/ts-verify-byte-parity.ps1 into the directory named by
 * CONSEMA_DIFFERENTIAL_RUST_DIR) are the byte authority: this module encodes
 * every case with the TS codecs and compares byte for byte, then checks the
 * bidirectional direction (Rust bytes -> TS decode -> TS re-encode).
 *
 * Without the environment variable the test skips (documented skip, never
 * silent); the driver script asserts the test RUN, never SKIP.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PortableValue } from '../../core/value.ts';
import { DecodeJSON } from '../../protocol/canonical.ts';
import { defaultProtocolLimits } from '../../protocol/limits.ts';
import { encode as encodePVCE, decode as decodePVCE, defaultDecodeLimits } from '../../core/pvce.ts';
import { Builder, defaultLimits } from '../../graph/graph.ts';
import type { Graph, NodeID } from '../../graph/graph.ts';
import { encodePGCE, decodePGCE, defaultPgceLimits } from '../../graph/pgce.ts';

/** The frozen manifest id of the differential input set. */
export const CASE_FILE_MANIFEST = 'consema.differential.byte-parity@1';

/** The task's lower bound for the input set ("至少 40 个 case"). */
export const MIN_CASE_COUNT = 40;

/** The closed fifteen-kind vocabulary of the case file's "kinds" metadata. */
export const ALL_KIND_NAMES: readonly string[] = Object.freeze([
  'Null', 'Boolean', 'String', 'Integer', 'Decimal',
  'BinaryFloat32', 'BinaryFloat64', 'Bytes', 'Date', 'Time',
  'LocalDateTime', 'OffsetDateTime', 'Array', 'Object', 'EntryMapping',
]);

/** One entry of cases.json (the neutral descriptor shape of both runners). */
export interface FileCase {
  readonly id: string;
  readonly codec: 'pvce' | 'pgce';
  readonly value?: string;
  readonly graph?: GraphDesc;
  readonly kinds: readonly string[];
}

/** The neutral PortableGraph descriptor of cases.json. */
export interface GraphDesc {
  readonly roots: readonly number[];
  readonly nodes: readonly NodeDesc[];
}

interface NodeDesc {
  readonly kind: 'Scalar' | 'Sequence' | 'Mapping';
  readonly tag: string;
  readonly content?: string;
  readonly items?: readonly number[];
  readonly entries?: readonly MappingDesc[];
}

interface MappingDesc {
  readonly key: number;
  readonly value: number;
}

/** The repository root directory (resolved from this file). */
export function repoRootDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return `${here}../../../../`;
}

/** The checked-in differential case file. */
export function defaultCasesFile(): string {
  return `${repoRootDir()}go/conformance/differential/cases.json`;
}

/**
 * Loads and validates the checked-in case set: manifest id, case count
 * lower bound, unique ids, known codecs, decodable PVCE values, buildable
 * PGCE graphs, and fifteen-kind coverage.
 */
export function loadCaseFile(file: string): FileCase[] {
  const parsed = JSON.parse(new TextDecoder('utf-8').decode(readFileSync(file))) as {
    manifest?: unknown;
    cases?: unknown;
  };
  if (parsed.manifest !== CASE_FILE_MANIFEST) {
    throw new Error(`cases.json manifest = ${JSON.stringify(parsed.manifest)}, want ${CASE_FILE_MANIFEST}`);
  }
  if (!Array.isArray(parsed.cases)) {
    throw new Error('cases.json: cases must be a sequence');
  }
  if (parsed.cases.length < MIN_CASE_COUNT) {
    throw new Error(`cases.json has ${parsed.cases.length} cases, want >= ${MIN_CASE_COUNT}`);
  }
  const seen = new Set<string>();
  const kinds = new Set<string>();
  const cases: FileCase[] = [];
  for (const raw of parsed.cases) {
    const c = raw as {
      id?: unknown; codec?: unknown; value?: unknown; graph?: unknown; kinds?: unknown;
    };
    if (typeof c.id !== 'string' || c.id === '') {
      throw new Error('case with an empty id');
    }
    if (seen.has(c.id)) {
      throw new Error(`duplicate case id ${JSON.stringify(c.id)}`);
    }
    seen.add(c.id);
    let case_: FileCase;
    switch (c.codec) {
      case 'pvce':
        if (typeof c.value !== 'string' || c.value === '') {
          throw new Error(`case ${c.id}: pvce case without a value`);
        }
        // The strict canonicality check (parse + re-encode) keeps the
        // file's transport JSON honest; the Rust side must accept the same
        // text.
        DecodeJSON(new TextEncoder().encode(c.value), defaultProtocolLimits());
        case_ = { id: c.id, codec: 'pvce', value: c.value, kinds: kindsOf(c.kinds) };
        break;
      case 'pgce': {
        const graph = c.graph as GraphDesc | undefined;
        if (graph === undefined || typeof graph !== 'object' || graph === null) {
          throw new Error(`case ${c.id}: pgce case without a graph`);
        }
        buildGraph(graph);
        case_ = { id: c.id, codec: 'pgce', graph, kinds: kindsOf(c.kinds) };
        break;
      }
      default:
        throw new Error(`case ${c.id}: unknown codec ${JSON.stringify(c.codec)}`);
    }
    for (const kind of case_.kinds) {
      kinds.add(kind);
    }
    cases.push(case_);
  }
  for (const kind of ALL_KIND_NAMES) {
    if (!kinds.has(kind)) {
      throw new Error(`case set does not cover kind ${kind} (kinds metadata)`);
    }
  }
  return cases;
}

function kindsOf(kinds: unknown): readonly string[] {
  if (!Array.isArray(kinds) || kinds.some((kind) => typeof kind !== 'string')) {
    throw new Error('case kinds must be a string sequence');
  }
  return kinds as string[];
}

/** Builds the graph of one neutral descriptor (graph_from_value mirror). */
export function buildGraph(desc: GraphDesc): Graph {
  const builder = new Builder(defaultLimits());
  const ids: NodeID[] = desc.nodes.map(() => builder.reserveNode());
  const ref = (index: number): NodeID => {
    if (index < 0 || index >= ids.length) {
      throw new Error(`node reference ${index} out of range (0..${ids.length - 1})`);
    }
    return ids[index];
  };
  desc.nodes.forEach((node, index) => {
    switch (node.kind) {
      case 'Scalar':
        builder.defineScalar(ids[index], node.tag, node.content ?? '');
        break;
      case 'Sequence':
        builder.defineSequence(ids[index], node.tag, (node.items ?? []).map(ref));
        break;
      case 'Mapping':
        builder.defineMapping(
          ids[index],
          node.tag,
          (node.entries ?? []).map((entry) => ({ key: ref(entry.key), value: ref(entry.value) })),
        );
        break;
      default:
        throw new Error(`unknown node kind ${JSON.stringify(node.kind)}`);
    }
  });
  for (const root of desc.roots) {
    builder.pushRoot(ref(root));
  }
  return builder.build();
}

/** The per-case outcome of one direction. */
export interface CaseComparison {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface ByteParityResult {
  readonly passed: number;
  readonly pvceCount: number;
  readonly pgceCount: number;
  readonly failures: readonly CaseComparison[];
}

function firstDiff(id: string, direction: string, left: Uint8Array, right: Uint8Array): string {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index++;
  }
  return (
    `case ${id} (${direction}): TS ${left.length} bytes, Rust ${right.length} bytes, ` +
    `first difference at offset ${index}\n  TS:   ${hex(left)}\n  Rust: ${hex(right)}`
  );
}

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const octet of bytes) {
    out += octet.toString(16).padStart(2, '0');
  }
  return out;
}

/** Reads one Rust byte file and decodes its hex. */
export function readHexFile(dir: string, id: string): Uint8Array {
  const text = readFileSync(`${dir}/${id}.hex`, 'utf-8');
  const decoded = /^[0-9a-f]*$/.exec(text.trim());
  if (decoded === null || decoded[0].length % 2 !== 0) {
    throw new Error(`case ${id}: Rust byte file is not valid hex`);
  }
  const bytes = new Uint8Array(decoded[0].length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(decoded[0].slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
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

/**
 * Runs the byte-parity comparison over the whole input set: TS encode bytes
 * vs the Rust golden bytes, then the bidirectional direction (Rust bytes ->
 * TS decode -> TS re-encode byte-identically).
 */
export function runByteParity(casesFile: string, rustDir: string): ByteParityResult {
  const cases = loadCaseFile(casesFile);
  const knownIDs = new Set(cases.map((c) => c.id));
  for (const entry of readdirSync(rustDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      continue;
    }
    const id = entry.name.endsWith('.hex') ? entry.name.slice(0, -'.hex'.length) : entry.name;
    if (!knownIDs.has(id)) {
      throw new Error(`rust byte file ${JSON.stringify(entry.name)} does not correspond to any case (case file drift?)`);
    }
  }
  const failures: CaseComparison[] = [];
  let passed = 0;
  let pvceCount = 0;
  let pgceCount = 0;
  for (const c of cases) {
    const rustBytes = readHexFile(rustDir, c.id);
    if (c.codec === 'pvce') {
      pvceCount++;
      const value = DecodeJSON(new TextEncoder().encode(c.value!), defaultProtocolLimits());
      const tsBytes = encodePVCE(value);
      if (!equalBytes(tsBytes, rustBytes)) {
        failures.push({ id: c.id, ok: false, detail: firstDiff(c.id, 'pvce', tsBytes, rustBytes) });
        continue;
      }
      const decoded = decodePVCE(rustBytes, defaultDecodeLimits());
      const reEncoded = encodePVCE(decoded);
      if (!equalBytes(reEncoded, rustBytes)) {
        failures.push({
          id: c.id,
          ok: false,
          detail: firstDiff(c.id, 'pvce-rust->ts->re-encode', reEncoded, rustBytes),
        });
        continue;
      }
      passed++;
    } else {
      pgceCount++;
      const tsBytes = encodePGCE(buildGraph(c.graph!));
      if (!equalBytes(tsBytes, rustBytes)) {
        failures.push({ id: c.id, ok: false, detail: firstDiff(c.id, 'pgce', tsBytes, rustBytes) });
        continue;
      }
      const decoded = decodePGCE(rustBytes, defaultPgceLimits());
      const reEncoded = encodePGCE(decoded);
      if (!equalBytes(reEncoded, rustBytes)) {
        failures.push({
          id: c.id,
          ok: false,
          detail: firstDiff(c.id, 'pgce-rust->ts->re-encode', reEncoded, rustBytes),
        });
        continue;
      }
      passed++;
    }
  }
  return { passed, pvceCount, pgceCount, failures };
}
