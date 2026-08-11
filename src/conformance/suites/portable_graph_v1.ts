/**
 * `consema.portable-graph.conformance@1` runner (10 cases; mirror of
 * crates/consema-conformance/src/portable_graph_v1.rs).
 */

import { Builder, defaultLimits } from '../../graph/graph.ts';
import type { Graph, NodeID } from '../../graph/graph.ts';
import { equal as graphEqual, hash as graphHash } from '../../graph/equal.ts';
import { decodePGCE, encodePGCE, encodePGCERecords, defaultPgceLimits } from '../../graph/pgce.ts';
import type { PgceLimits } from '../../graph/pgce.ts';
import { PGCEError } from '../../graph/errors.ts';
import {
  executeGraph,
  CancellationToken,
  defaultQueryExecutionLimits,
} from '../../core/query_execution.ts';
import { domainPortableGraphV1 } from '../../protocol/query.ts';
import type { QueryDefinition } from '../../protocol/query.ts';
import { pipelineExpression, validateAndBind } from './query_pipeline.ts';
import type { VectorCase } from '../helpers.ts';
import { caseField, expectedField, expectedFieldOptional, hexToBytes, toHex } from '../helpers.ts';
import { fail, skip, SkippedCase } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';

/** One vector graph descriptor → built Graph. */
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

/** The `core.pgce.full@1` handler. */
function pgceFull(case_: VectorCase): void {
  switch (case_.id) {
    case 'pgce.empty-vector': {
      const graph = graphFromInput(caseField(case_, 'graph'));
      const expected = expectedField(case_, 'hex') as string;
      const observed = toHex(encodePGCE(graph));
      if (observed !== expected) {
        fail(`pgce hex: expected ${expected}, observed ${observed}`);
      }
      return;
    }
    case 'pgce.scalar-vector': {
      const graph = graphFromInput(caseField(case_, 'graph'));
      const expected = expectedField(case_, 'hex') as string;
      const observed = toHex(encodePGCE(graph));
      if (observed !== expected) {
        fail(`pgce hex: expected ${expected}, observed ${observed}`);
      }
      return;
    }
    case 'pgce.cycle-roundtrip': {
      const graph = graphFromInput(caseField(case_, 'graph'));
      const encoded = encodePGCE(graph);
      const decoded = decodePGCE(encoded, defaultPgceLimits());
      if (!graphEqual(graph, decoded)) {
        fail('cycle round trip must be strictly equal');
      }
      if (toHex(encodePGCE(decoded)) !== toHex(encoded)) {
        fail('cycle encoding must be byte stable');
      }
      return;
    }
    case 'pgce.reject-nonminimal-varint': {
      const bytes = hexToBytes(caseField(case_, 'hex') as string);
      try {
        decodePGCE(bytes, defaultPgceLimits());
      } catch (error) {
        if (error instanceof PGCEError && error.kind === 'NonMinimalVarint') {
          return;
        }
        fail(`expected NonMinimalVarint, observed ${String(error)}`);
      }
      fail('expected a NonMinimalVarint failure');
      return;
    }
    case 'pgce.reject-noncanonical-node-order': {
      const bytes = hexToBytes(caseField(case_, 'hex') as string);
      try {
        decodePGCE(bytes, defaultPgceLimits());
      } catch (error) {
        if (error instanceof PGCEError && error.kind === 'NonCanonicalNodeOrder') {
          return;
        }
        fail(`expected NonCanonicalNodeOrder, observed ${String(error)}`);
      }
      fail('expected a NonCanonicalNodeOrder failure');
      return;
    }
    case 'resource.pgce-stream-limit': {
      const graph = graphFromInput(caseField(case_, 'graph'));
      const maxStreamBytes = caseField(case_, 'max_stream_bytes') as number;
      const limits: PgceLimits = { ...defaultPgceLimits(), maxStreamBytes };
      try {
        encodePGCERecords(graph, limits);
      } catch (error) {
        if (error instanceof PGCEError && error.kind === 'ResourceLimit') {
          if (expectedFieldOptional(case_, 'partial_bytes') === false) {
            return;
          }
        }
        fail(`expected a stream-bytes resource limit, observed ${String(error)}`);
      }
      fail('expected a resource-limit failure');
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** The `core.portable-graph.strict-equality@1` handler. */
function strictEquality(case_: VectorCase): void {
  const left = graphFromInput(caseField(case_, 'left'));
  const right = graphFromInput(caseField(case_, 'right'));
  const strictEqual = expectedField(case_, 'strict_equal') as boolean;
  if (graphEqual(left, right) !== strictEqual) {
    fail(`strict_equal: expected ${strictEqual}`);
  }
  const hashEqual = expectedFieldOptional(case_, 'strict_hash_equal');
  if (hashEqual !== undefined && (graphHash(left) === graphHash(right)) !== hashEqual) {
    fail(`strict_hash_equal: expected ${String(hashEqual)}`);
  }
  const pgceEqual = expectedFieldOptional(case_, 'pgce_equal');
  if (pgceEqual !== undefined) {
    const leftBytes = encodePGCE(left);
    const rightBytes = encodePGCE(right);
    const same =
      leftBytes.length === rightBytes.length &&
      leftBytes.every((octet, index) => octet === rightBytes[index]);
    if (same !== pgceEqual) {
      fail(`pgce_equal: expected ${String(pgceEqual)}`);
    }
  }
}

/** The `core.portable-graph-query@1` handler (portable_graph_v1.rs:184-219;
 * the Rust graph executor, crates/consema-graph/src/query.rs). */
function graphQuery(case_: VectorCase): void {
  switch (case_.id) {
    case 'query.reachable-canonical-order':
    case 'query.distinct-shared-identity': {
      const graph = graphFromInput(caseField(case_, 'graph'));
      const pipeline = caseField(case_, 'pipeline') as unknown[];
      const definition: QueryDefinition = {
        domain: domainPortableGraphV1(),
        expression: pipelineExpression(pipeline),
        selection: 'All',
      };
      const executable = validateAndBind(definition);
      const matches = executeGraph(
        graph,
        executable.validated.definition.expression,
        defaultQueryExecutionLimits(),
        new CancellationToken(),
      );
      const expectedIds = expectedField(case_, 'builder_node_ids') as number[];
      const expectedCount = expectedField(case_, 'count') as number;
      if (matches.length !== expectedCount) {
        fail(`count: expected ${expectedCount}, observed ${matches.length}`);
      }
      const ids = matches.map((match) => {
        if (match.kind !== 'GraphNode') {
          fail('query result was not a node');
        }
        return match.node.index;
      });
      if (
        ids.length !== expectedIds.length ||
        ids.some((id, index) => id !== expectedIds[index])
      ) {
        fail(`builder_node_ids: expected ${JSON.stringify(expectedIds)}, observed ${JSON.stringify(ids)}`);
      }
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

export const runPortableGraphV1: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.capability) {
      case 'core.pgce.full@1':
        pgceFull(case_);
        return;
      case 'core.portable-graph.strict-equality@1':
        strictEquality(case_);
        return;
      case 'core.portable-graph-query@1':
        graphQuery(case_);
        return;
      default:
        return skip(
          case_.capability ?? 'unknown',
          `runner does not recognize published case ${case_.id}`,
        );
    }
  },
};
