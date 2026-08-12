/**
 * `consema.semantic-model-v5.conformance@1` runner (22 cases; mirror of
 * crates/consema-conformance/src/semantic_model_v5.rs).
 *
 * The graph, provenance, projection, and YAML query-result cases exercise
 * the v5 wire records (src/protocol/records_graph.ts + records_execution.ts)
 * through the v5 envelope closure exactly like the Rust runner.
 */

import type { VectorCase } from '../helpers.ts';
import { bytesEqual, caseField, caseFieldOptional, expectedFieldOptional, sha256Hex, toHex } from '../helpers.ts';
import { expectedCode, fail, skip } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import { ContractRegistry, ProtocolMessage, newContractId } from '../../protocol/contract.ts';
import type { ContractId } from '../../protocol/contract.ts';
import { ErrorCodeRegistry } from '../../protocol/error_registry.ts';
import { ProtocolError } from '../../protocol/errors.ts';
import { defaultProtocolLimits } from '../../protocol/limits.ts';
import { EncodeJSON } from '../../protocol/canonical.ts';
import { PVCEError } from '../../core/errors.ts';
import type { PortableValue, ObjectValue } from '../../core/value.ts';
import { nullValue, stringValue } from '../../core/value.ts';
import { objectValueFrom } from '../../protocol/records.ts';
import { Completion } from '../../protocol/records_execution.ts';
import {
  GraphProjectedLocationMessage,
  GraphProjectionResultMessage,
  GraphProvenanceMapMessage,
  GraphQueryMatchMessage,
  GraphQueryResultMessage,
  GraphSourceOriginMessage,
  PortableGraphMessage,
  YamlMatchLocator,
  YamlQueryResultMessage,
} from '../../protocol/records_graph.ts';
import { defaultPgceLimits } from '../../graph/pgce.ts';
import type { PgceLimits } from '../../graph/pgce.ts';
import { Builder, defaultLimits } from '../../graph/graph.ts';
import type { Graph, NodeID } from '../../graph/graph.ts';
import { DocumentAuthority } from '../../document/identity.ts';
import type { NodeRole } from '../../document/identity.ts';
import {
  domainPortableGraphV1,
  domainYAMLLosslessSyntaxV1,
  domainYAMLNativeV1,
} from '../../protocol/query.ts';
import type { QueryDomain } from '../../protocol/query.ts';

const LIMITS = defaultProtocolLimits();
const V5 = new ContractRegistry(5);

/** Asserts one operation rejects with the exact frozen code. */
function expectRejected(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    const observed = error instanceof ProtocolError ? error.code : (error as { code?: unknown } | null)?.code;
    if (observed !== code) {
      fail(`code: expected ${code}, observed ${JSON.stringify(observed)} (${String(error)})`);
    }
    return;
  }
  fail(`expected rejection with code ${code}`);
}

/** Asserts the observed error carries the vector's pinned code, when one is pinned. */
function expectCodeOf(error: unknown, case_: VectorCase): void {
  const pinned = expectedCode(case_);
  if (pinned === undefined || pinned === '') {
    return;
  }
  const observed = error instanceof ProtocolError ? error.code : (error as { code?: unknown } | null)?.code;
  if (observed !== pinned) {
    fail(`code: expected ${pinned}, observed ${JSON.stringify(observed)} (${String(error)})`);
  }
}

/**
 * Accepts an envelope-level PVCE rejection: the TS envelope surfaces codec
 * failures as the typed PVCEError, whose protocol-level spelling is the
 * frozen invalid-pvce code (contract.rs from_pvce maps every codec failure);
 * a ProtocolError carrying the pinned code also closes the case.
 */
function expectPvceRejected(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof PVCEError) {
      return;
    }
    const observed = error instanceof ProtocolError ? error.code : (error as { code?: unknown } | null)?.code;
    if (observed !== code) {
      fail(`code: expected ${code}, observed ${JSON.stringify(observed)} (${String(error)})`);
    }
    return;
  }
  fail(`expected rejection with code ${code}`);
}

/** Deep PortableValue equality through the canonical tagged-JSON closure. */
function payloadsEqual(left: PortableValue, right: PortableValue): boolean {
  return bytesEqual(EncodeJSON(left, LIMITS), EncodeJSON(right, LIMITS));
}

/** Envelope equality is contract + payload (the Rust ProtocolMessage Eq). */
function messageEqual(left: ProtocolMessage, right: ProtocolMessage): boolean {
  return (
    left.contract.id === right.contract.id &&
    left.contract.version === right.contract.version &&
    payloadsEqual(left.payload, right.payload)
  );
}

/** Proves JSON/PVCE transport identity of one payload under the v5 registry (dual_roundtrip, semantic_model_v5.rs:502-515). */
function dualRoundtrip(contract: ContractId, payload: PortableValue): void {
  const message = new ProtocolMessage(contract, payload, V5);
  const json = message.toJSON(LIMITS);
  const pvce = message.toPVCE(LIMITS);
  const fromJson = ProtocolMessage.fromJSON(json, LIMITS, V5);
  const fromPvce = ProtocolMessage.fromPVCE(pvce, LIMITS, V5);
  if (!messageEqual(fromJson, message)) {
    fail('JSON transport did not close');
  }
  if (!messageEqual(fromPvce, message)) {
    fail('PVCE transport did not close');
  }
}

/** Replaces one existing field of an Object with a forged replacement. */
function replaceObjectField(
  value: PortableValue,
  name: string,
  replacement: PortableValue,
): ObjectValue {
  if (value.kind !== 'Object') {
    throw new Error('value must be Object');
  }
  let found = false;
  const entries = value.entries.map((entry) => {
    if (entry.key === name) {
      found = true;
      return { key: entry.key, value: replacement };
    }
    return entry;
  });
  if (!found) {
    throw new Error(`field ${name} is absent`);
  }
  return objectValueFrom(entries);
}

/** Appends one new trailing field of an Object. */
function appendObjectField(value: PortableValue, name: string, appended: PortableValue): ObjectValue {
  if (value.kind !== 'Object') {
    throw new Error('value must be Object');
  }
  return objectValueFrom([...value.entries, { key: name, value: appended }]);
}

/** One vector graph descriptor → built Graph (the portable_graph_v1.rs builder path). */
function graphFromInput(input: unknown): Graph {
  const record = input as { roots?: unknown; nodes?: unknown };
  if (typeof record !== 'object' || record === null) {
    throw new Error('missing graph descriptor');
  }
  const roots = record.roots as number[];
  const nodes = record.nodes as unknown[];
  const builder = new Builder(defaultLimits());
  const ids: NodeID[] = [];
  for (let index = 0; index < nodes.length; index++) {
    ids.push(builder.reserveNode());
  }
  nodes.forEach((node, index) => {
    const record = node as { kind?: string; tag?: string; content?: unknown; items?: unknown; entries?: unknown };
    switch (record.kind) {
      case 'Scalar':
        builder.defineScalar(ids[index], record.tag as string, record.content as string);
        break;
      case 'Sequence':
        builder.defineSequence(
          ids[index],
          record.tag as string,
          (record.items as number[]).map((item) => ids[item]),
        );
        break;
      case 'Mapping':
        builder.defineMapping(
          ids[index],
          record.tag as string,
          (record.entries as { key: number; value: number }[]).map((entry) => ({
            key: ids[entry.key],
            value: ids[entry.value],
          })),
        );
        break;
      default:
        throw new Error(`unknown graph node kind ${record.kind}`);
    }
  });
  for (const root of roots) {
    builder.pushRoot(ids[root]);
  }
  return builder.build();
}

/** One input graph role spelling → the closed graph match role (parse_role, semantic_model_v5.rs:681-696). */
function parseGraphRole(text: string): 'GraphNode' | 'GraphSequenceElement' | 'GraphMappingEntry' {
  switch (text) {
    case 'GraphNode':
    case 'GraphSequenceElement':
    case 'GraphMappingEntry':
      return text;
    default:
      fail(`unknown graph match role ${text}`);
  }
}

/** One input YAML role spelling → the closed YAML match role (parse_role, semantic_model_v5.rs:681-696). */
function parseYamlRole(text: string): string {
  switch (text) {
    case 'YamlStream':
    case 'YamlDocument':
    case 'YamlNode':
    case 'YamlMappingEntry':
    case 'YamlSequenceElement':
    case 'YamlAnchorDefinition':
    case 'YamlAliasOccurrence':
    case 'YamlSyntaxPiece':
      return text;
    default:
      fail(`unknown YAML match role ${text}`);
  }
}

/** One input graph match descriptor → GraphQueryMatchMessage (parse_graph_match, semantic_model_v5.rs:608-627). */
function graphMatchFromInput(input: unknown): GraphQueryMatchMessage {
  const record = input as {
    kind?: string;
    node?: number;
    parent?: number;
    ordinal?: number;
    key?: number;
    value?: number;
  };
  switch (record.kind) {
    case 'Node':
      return GraphQueryMatchMessage.node(BigInt(record.node!));
    case 'SequenceElement':
      return GraphQueryMatchMessage.sequenceElement(BigInt(record.parent!), BigInt(record.ordinal!), BigInt(record.node!));
    case 'MappingEntry':
      return GraphQueryMatchMessage.mappingEntry(
        BigInt(record.parent!),
        BigInt(record.ordinal!),
        BigInt(record.key!),
        BigInt(record.value!),
      );
    default:
      fail(`unknown graph match kind ${record.kind}`);
  }
}

/** One input projected location descriptor → GraphProjectedLocationMessage (parse_location, semantic_model_v5.rs:656-679). */
function projectedLocationFromInput(input: unknown): GraphProjectedLocationMessage {
  const record = input as { kind?: string; node?: number; parent?: number; ordinal?: number };
  switch (record.kind) {
    case 'Root':
      return GraphProjectedLocationMessage.root(BigInt(record.ordinal!));
    case 'Node':
      return GraphProjectedLocationMessage.node(BigInt(record.node!));
    case 'SequenceElement':
      return GraphProjectedLocationMessage.sequenceElement(BigInt(record.parent!), BigInt(record.ordinal!));
    case 'MappingKey':
      return GraphProjectedLocationMessage.mappingKey(BigInt(record.parent!), BigInt(record.ordinal!));
    case 'MappingValue':
      return GraphProjectedLocationMessage.mappingValue(BigInt(record.parent!), BigInt(record.ordinal!));
    default:
      fail(`unknown projected location ${record.kind}`);
  }
}

/** One entry per input location with the shared origin facts (provenance_entries, semantic_model_v5.rs:629-654). */
function provenanceEntriesFromCase(
  case_: VectorCase,
): { projected: GraphProjectedLocationMessage; origins: readonly GraphSourceOriginMessage[] }[] {
  const locations = caseField(case_, 'locations') as unknown[];
  const sourceId = caseField(case_, 'source_id') as string;
  const nodeLocator = (caseFieldOptional(case_, 'node_locator') as string | undefined) ?? null;
  const startByte = BigInt(caseField(case_, 'start_byte') as number);
  const endByte = BigInt(caseField(case_, 'end_byte') as number);
  const relation = caseField(case_, 'relation') as 'Direct' | 'Reference';
  return locations.map((location) => ({
    projected: projectedLocationFromInput(location),
    origins: [GraphSourceOriginMessage.new(sourceId, nodeLocator, startByte, endByte, relation)],
  }));
}

/** core.registry-manifest@1 */
function registryManifest(case_: VectorCase): void {
  switch (case_.id) {
    case 'registry.v5-manifest': {
      const contractCount = expectedFieldOptional(case_, 'contract_count') as number | undefined;
      const errorCodeCount = expectedFieldOptional(case_, 'error_code_count') as number | undefined;
      if (contractCount !== undefined && new ContractRegistry(5).contracts().length !== contractCount) {
        fail('v5 contract count mismatch');
      }
      if (errorCodeCount !== undefined && new ErrorCodeRegistry(5).codes().length !== errorCodeCount) {
        fail('v5 error code count mismatch');
      }
      return;
    }
    case 'registry.v1-v4-frozen': {
      const contractCounts = expectedFieldOptional(case_, 'contract_counts') as number[] | undefined;
      const errorCodeCounts = expectedFieldOptional(case_, 'error_code_counts') as number[] | undefined;
      if (contractCounts !== undefined) {
        contractCounts.forEach((expected, index) => {
          if (new ContractRegistry((index + 1) as 1 | 2 | 3 | 4).contracts().length !== expected) {
            fail(`v${index + 1} contract count mismatch`);
          }
        });
      }
      if (errorCodeCounts !== undefined) {
        errorCodeCounts.forEach((expected, index) => {
          if (new ErrorCodeRegistry((index + 1) as 1 | 2 | 3 | 4).codes().length !== expected) {
            fail(`v${index + 1} error code count mismatch`);
          }
        });
      }
      return;
    }
    case 'registry.v5-additive-contracts': {
      const contracts = expectedFieldOptional(case_, 'contracts') as string[] | undefined;
      if (contracts !== undefined) {
        const v5 = new Set(new ContractRegistry(5).contracts().map((descriptor) => `${descriptor.id}@${descriptor.version}`));
        const v4 = new Set(new ContractRegistry(4).contracts().map((descriptor) => `${descriptor.id}@${descriptor.version}`));
        for (const contract of contracts) {
          if (!v5.has(contract)) {
            fail(`v5 must register ${contract}`);
          }
          if (v4.has(contract)) {
            fail(`${contract} must be new in v5`);
          }
        }
      }
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.error-code-registry@1 */
function errorCodes(case_: VectorCase): void {
  const errorCodeCount = expectedFieldOptional(case_, 'error_code_count') as number | undefined;
  const newCodes = expectedFieldOptional(case_, 'new_codes') as string[] | undefined;
  if (errorCodeCount !== undefined && new ErrorCodeRegistry(5).codes().length !== errorCodeCount) {
    fail('v5 error code count mismatch');
  }
  if (newCodes !== undefined) {
    const registry = new ErrorCodeRegistry(5);
    for (const code of newCodes) {
      if (!registry.contains(code)) {
        fail(`v5 must register ${code}`);
      }
    }
  }
}

/** core.portable-graph@1 */
function portableGraphWire(case_: VectorCase): void {
  switch (case_.id) {
    case 'portable-graph.dual-transport': {
      const message = PortableGraphMessage.fromGraph(graphFromInput(caseField(case_, 'graph')), defaultPgceLimits());
      const pgceHex = expectedFieldOptional(case_, 'pgce_hex') as string | undefined;
      const observedPgce = toHex(message.pgce());
      if (pgceHex !== undefined && observedPgce !== pgceHex) {
        fail(`pgce hex: expected ${pgceHex}, observed ${observedPgce}`);
      }
      const envelope = new ProtocolMessage(newContractId('core.portable-graph', 1), message.toValue(), V5);
      const json = envelope.toJSON(LIMITS);
      const pvce = envelope.toPVCE(LIMITS);
      const fromJson = ProtocolMessage.fromJSON(json, LIMITS, V5);
      const fromPvce = ProtocolMessage.fromPVCE(pvce, LIMITS, V5);
      if (!messageEqual(fromJson, envelope)) {
        fail('JSON transport identity differed');
      }
      if (!messageEqual(fromPvce, envelope)) {
        fail('PVCE transport identity differed');
      }
      const jsonSha256 = expectedFieldOptional(case_, 'json_sha256') as string | undefined;
      if (jsonSha256 !== undefined && sha256Hex(json) !== jsonSha256) {
        fail(`json digest: expected ${jsonSha256}, observed ${sha256Hex(json)}`);
      }
      const pvceSha256 = expectedFieldOptional(case_, 'pvce_sha256') as string | undefined;
      if (pvceSha256 !== undefined && sha256Hex(pvce) !== pvceSha256) {
        fail(`pvce digest: expected ${pvceSha256}, observed ${sha256Hex(pvce)}`);
      }
      return;
    }
    case 'portable-graph.reject-disagreement': {
      const message = PortableGraphMessage.fromGraph(graphFromInput(caseField(case_, 'graph')), defaultPgceLimits());
      const value = message.toValue();
      const nodes = value.entries.find((entry) => entry.key === 'nodes')!.value;
      if (nodes.kind !== 'Sequence') {
        fail('nodes must be a Sequence');
      }
      const index = caseField(case_, 'node_index') as number;
      const replacement = caseField(case_, 'replacement') as string;
      const changedNodes = nodes.items.map((node, ordinal) =>
        ordinal === index ? replaceObjectField(node, 'canonical_content', stringValue(replacement)) : node,
      );
      const changed = replaceObjectField(value, 'nodes', { kind: 'Sequence', items: changedNodes });
      expectRejected(
        () => PortableGraphMessage.fromValue(changed, defaultPgceLimits()),
        expectedCode(case_) ?? 'core.protocol.invalid-value@1',
      );
      return;
    }
    case 'portable-graph.reject-node-limit': {
      const message = PortableGraphMessage.fromGraph(graphFromInput(caseField(case_, 'graph')), defaultPgceLimits());
      const limits: PgceLimits = { ...defaultPgceLimits(), maxNodes: caseField(case_, 'max_nodes') as number };
      expectRejected(
        () => PortableGraphMessage.fromValue(message.toValue(), limits),
        expectedCode(case_) ?? 'core.protocol.resource-limit@1',
      );
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.graph-query-result@1 */
function graphQueryResultWire(case_: VectorCase): void {
  const graph = graphFromInput(caseField(case_, 'graph'));
  const role = parseGraphRole(caseField(case_, 'role') as string);
  const match = graphMatchFromInput(caseField(case_, 'match'));
  const completion = Completion.new('Success', 1n, 1n);
  const accepted = expectedFieldOptional(case_, 'accepted') as boolean | undefined;
  try {
    const result = GraphQueryResultMessage.new(domainPortableGraphV1(), role, graph, [match], completion, []);
    if (accepted === false) {
      fail('expected rejection');
    }
    dualRoundtrip(newContractId('core.graph-query-result', 1), result.toValue());
  } catch (error) {
    if (accepted === true) {
      fail(`unexpected rejection: ${String(error)}`);
    }
    expectCodeOf(error, case_);
  }
}

/** core.graph-provenance-map@1 */
function graphProvenanceWire(case_: VectorCase): void {
  switch (case_.id) {
    case 'graph-provenance.reject-order':
      expectRejected(
        () => GraphProvenanceMapMessage.new(provenanceEntriesFromCase(case_)),
        expectedCode(case_) ?? 'core.protocol.invalid-value@1',
      );
      return;
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.graph-projection-result@1 */
function graphProjectionWire(case_: VectorCase): void {
  switch (case_.id) {
    case 'graph-projection.roundtrip':
    case 'graph-projection.reject-out-of-range': {
      const graph = graphFromInput(caseField(case_, 'graph'));
      const provenance = GraphProvenanceMapMessage.new(provenanceEntriesFromCase(case_));
      const completion = Completion.new('Success', 1n, 1n);
      const accepted = expectedFieldOptional(case_, 'accepted') as boolean | undefined;
      try {
        const result = GraphProjectionResultMessage.new(completion, graph, provenance, []);
        if (accepted === false) {
          fail('expected rejection');
        }
        dualRoundtrip(newContractId('core.graph-projection-result', 1), result.toValue());
      } catch (error) {
        if (accepted === true) {
          fail(`unexpected rejection: ${String(error)}`);
        }
        expectCodeOf(error, case_);
      }
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.yaml-query-result@1 */
function yamlQueryResultWire(case_: VectorCase): void {
  switch (case_.id) {
    case 'yaml-query.native-roles':
    case 'yaml-query.syntax-roundtrip': {
      const roles = caseField(case_, 'roles') as string[];
      const sourceId = caseField(case_, 'source_id') as string;
      let count = 0;
      for (let ordinal = 0; ordinal < roles.length; ordinal++) {
        const role = parseYamlRole(roles[ordinal]);
        const domain: QueryDomain =
          role === 'YamlSyntaxPiece' ? domainYAMLLosslessSyntaxV1() : domainYAMLNativeV1();
        const locator = YamlMatchLocator.new(sourceId, `/nodes/${ordinal}`, role, BigInt(ordinal));
        const completion = Completion.new('Success', 1n, 1n);
        const result = YamlQueryResultMessage.new(domain, role, [locator], completion, []);
        dualRoundtrip(newContractId('core.yaml-query-result', 1), result.toValue());
        count++;
      }
      const roleCount = expectedFieldOptional(case_, 'role_count') as number | undefined;
      if (roleCount !== undefined && count !== roleCount) {
        fail(`role count: expected ${roleCount}, observed ${count}`);
      }
      return;
    }
    case 'yaml-query.reject-domain-role': {
      const role = parseYamlRole(caseField(case_, 'role') as string);
      const locator = YamlMatchLocator.new('sha256:source', '/syntax/0', role, 0n);
      const completion = Completion.new('Success', 1n, 1n);
      expectRejected(
        () => YamlQueryResultMessage.new(domainYAMLNativeV1(), role, [locator], completion, []),
        expectedCode(case_) ?? 'core.protocol.invalid-value@1',
      );
      return;
    }
    case 'yaml-query.reject-process-local': {
      const node = DocumentAuthority.fresh().nodeRef(0n, 'YamlNode' as NodeRole);
      expectRejected(
        () => YamlMatchLocator.fromProcessLocal(node),
        expectedCode(case_) ?? 'core.protocol.process-local-handle@1',
      );
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.protocol-message@1 */
function protocolMessage(case_: VectorCase): void {
  switch (case_.id) {
    case 'protocol.v4-reject-v5-contract': {
      const message = PortableGraphMessage.fromGraph(graphFromInput(caseField(case_, 'graph')), defaultPgceLimits());
      expectRejected(
        () => new ProtocolMessage(newContractId('core.portable-graph', 1), message.toValue(), new ContractRegistry(4)),
        expectedCode(case_) ?? 'core.protocol.unknown-contract@1',
      );
      return;
    }
    case 'protocol.v5-nested-error-code': {
      const code = caseField(case_, 'failure_code') as string;
      expectRejected(
        () => Completion.newWithRegistry('Failed', 1n, 0n, null, code, new ErrorCodeRegistry(4)),
        (expectedFieldOptional(case_, 'v4_code') as string | undefined) ?? 'core.protocol.invalid-value@1',
      );
      const completion = Completion.newWithRegistry('Failed', 1n, 0n, null, code, new ErrorCodeRegistry(5));
      const message = new ProtocolMessage(newContractId('core.completion', 1), completion.toValue(), V5);
      const decoded = ProtocolMessage.fromValue(message.toValue(), V5);
      if (!messageEqual(decoded, message)) {
        fail('envelope decode did not close');
      }
      return;
    }
    case 'protocol.reject-truncated-pvce': {
      const message = PortableGraphMessage.fromGraph(graphFromInput(caseField(case_, 'graph')), defaultPgceLimits());
      const envelope = new ProtocolMessage(newContractId('core.portable-graph', 1), message.toValue(), V5);
      const bytes = envelope.toPVCE(LIMITS);
      const truncate = caseField(case_, 'truncate_bytes') as number;
      const cut = Math.max(0, bytes.length - truncate);
      expectPvceRejected(
        () => ProtocolMessage.fromPVCE(bytes.slice(0, cut), LIMITS, V5),
        expectedCode(case_) ?? 'core.protocol.invalid-pvce@1',
      );
      return;
    }
    case 'protocol.reject-unknown-payload-field': {
      const message = PortableGraphMessage.fromGraph(graphFromInput(caseField(case_, 'graph')), defaultPgceLimits());
      const changed = appendObjectField(message.toValue(), 'unknown', nullValue());
      expectRejected(
        () => new ProtocolMessage(newContractId('core.portable-graph', 1), changed, V5),
        expectedCode(case_) ?? 'core.protocol.unknown-field@1',
      );
      return;
    }
    default:
      return skip(
        case_.capability ?? 'unknown',
        `runner does not recognize published case ${case_.id}`,
      );
  }
}

export const runSemanticModelV5: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.capability) {
      case 'core.registry-manifest@1':
        registryManifest(case_);
        return;
      case 'core.error-code-registry@1':
        errorCodes(case_);
        return;
      case 'core.portable-graph@1':
        portableGraphWire(case_);
        return;
      case 'core.graph-query-result@1':
        graphQueryResultWire(case_);
        return;
      case 'core.graph-provenance-map@1':
        graphProvenanceWire(case_);
        return;
      case 'core.graph-projection-result@1':
        graphProjectionWire(case_);
        return;
      case 'core.yaml-query-result@1':
        yamlQueryResultWire(case_);
        return;
      case 'core.protocol-message@1':
        protocolMessage(case_);
        return;
      default:
        return skip(
          case_.capability ?? 'unknown',
          `runner does not recognize published case ${case_.id}`,
        );
    }
  },
};
