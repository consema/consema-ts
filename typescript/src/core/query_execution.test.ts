/**
 * Query-execution limits tests (W4-19/R12): max_steps is enforced as a
 * per-emitted-match step budget (the eager analog of the Rust per-pull
 * counter, query.rs LazyContext::step), over-limit fails with
 * ResourceLimitExceeded.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CancellationToken,
  QueryExecutionFailure,
  defaultQueryExecutionLimits,
  executeGraph,
  executePortable,
  executePortableCursor,
} from './query_execution.ts';
import { sequenceValue, stringValue } from './value.ts';
import { newOperatorCall } from '../protocol/query.ts';
import type { QueryExpression } from '../protocol/query.ts';
import { Builder, defaultLimits } from '../graph/graph.ts';
import type { Graph } from '../graph/graph.ts';

const token = (): CancellationToken => new CancellationToken();

/** A 10-element string sequence. */
function tenStrings(): ReturnType<typeof sequenceValue> {
  return sequenceValue(Array.from({ length: 10 }, (_, index) => stringValue(`s${index}`)));
}

/** An Apply(core.try-sequence-elements, Input) expression. */
function sequenceElements(): QueryExpression {
  return {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: newOperatorCall('core.try-sequence-elements', 1),
  };
}

function resourceLimit(error: unknown): boolean {
  return error instanceof QueryExecutionFailure && error.kind === 'ResourceLimitExceeded';
}

test('W4-19/R12: portable-value execution charges max_steps per emitted match', () => {
  const value = tenStrings();
  const expression = sequenceElements();
  // Evaluation: Input emits 1 match, the operator emits 10 -> 11 steps.
  // maxSteps 11 passes; maxSteps 10 fails with ResourceLimitExceeded.
  const ok = executePortable(
    value,
    expression,
    { maxSteps: 11, maxResults: 100 },
    token(),
  );
  assert.equal(ok.length, 10, 'the operator output is the full stream');
  assert.throws(
    () => executePortable(value, expression, { maxSteps: 10, maxResults: 100 }, token()),
    resourceLimit,
    'one step over the budget fails with ResourceLimitExceeded',
  );
});

test('W4-19/R12: a degenerate maxSteps bound fails immediately', () => {
  assert.throws(
    () => executePortable(tenStrings(), { kind: 'Input' }, { maxSteps: 0, maxResults: 100 }, token()),
    resourceLimit,
    'maxSteps < 1 fails with ResourceLimitExceeded',
  );
});

test('W4-19/R12: the default budget keeps every published-vector-shaped query running', () => {
  const value = tenStrings();
  const cursor = executePortableCursor(value, sequenceElements(), 100);
  const pulled: unknown[] = [];
  let next = cursor.next();
  while (next !== null) {
    pulled.push(next);
    next = cursor.next();
  }
  assert.equal(pulled.length, 10, 'cursor over the default budget yields the full stream');
  assert.equal(cursor.terminalState(), 'Completed');
  // The full default-budget path stays within defaultQueryExecutionLimits.
  assert.equal(defaultQueryExecutionLimits().maxSteps, 100_000);
});

function graphWithRoots(count: number): Graph {
  const builder = new Builder(defaultLimits());
  const nodes = Array.from({ length: count }, () => builder.reserveNode());
  nodes.forEach((node, index) => builder.defineScalar(node, 'string', `n${index}`));
  for (const node of nodes) {
    builder.pushRoot(node);
  }
  return builder.build();
}

test('W4-19/R12: portable-graph execution charges max_steps per emitted match', () => {
  const graph = graphWithRoots(10);
  const withKind: QueryExpression = {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: {
      id: 'graph.where-kind',
      version: 1,
      arguments: new Map([['kind', stringValue('Scalar')]]),
    },
  };
  // Evaluation: Input emits 10 root matches, where-kind emits 10 -> 20
  // steps. maxSteps 20 passes; maxSteps 19 fails.
  const ok = executeGraph(graph, withKind, { maxSteps: 20, maxResults: 100 }, token());
  assert.equal(ok.length, 10, 'all ten roots match the kind filter');
  assert.throws(
    () => executeGraph(graph, withKind, { maxSteps: 19, maxResults: 100 }, token()),
    resourceLimit,
    'one step over the graph budget fails with ResourceLimitExceeded',
  );
});
