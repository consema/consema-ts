/**
 * `consema.syntax-query.conformance@1` runner (19 cases; mirror of
 * crates/consema-conformance/src/syntax_query_v1.rs).
 */

import type { VectorCase } from '../helpers.ts';
import { caseField, caseFieldOptional, expectedField, expectedFieldOptional, utf8 } from '../helpers.ts';
import { fail, skip, SkippedCase } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import { parse as parseJson } from '../../json/parser.ts';
import { parseToml } from '../../toml/document.ts';
import { TomlProfile } from '../../toml/profile.ts';
import { DEFAULT_PARSE_LIMITS } from '../../document/formation.ts';
import {
  QueryLimits as JsonQueryLimits,
  CancellationToken as JsonCancellationToken,
  executeJsonSyntaxQuery,
} from '../../json/query.ts';
import { TomlCancellationToken, executeTomlSyntaxQuery } from '../../toml/query.ts';
import type { TomlQueryLimits as TomlQueryLimitsType } from '../../toml/query.ts';
import { QueryExecutionFailure as JsonQueryExecutionFailure } from '../../json/errors.ts';
import { TomlQueryExecutionFailure } from '../../toml/query.ts';
import { validateQuery, bindQuery } from '../../protocol/query.ts';
import type { QueryDefinition, QueryExpression } from '../../protocol/query.ts';
import { domainJSONLosslessSyntaxV1, domainTOMLLosslessSyntaxV1 } from '../../protocol/query.ts';
import { newOperatorCall } from '../../protocol/query.ts';
import type { OperatorCall } from '../../protocol/query.ts';
import { newCapabilityId, CapabilitySet } from '../../protocol/registry_descriptor.ts';
import { stringValue } from '../../core/value.ts';
import { OrderedCursor, CancellationToken } from '../../core/query_execution.ts';

function capabilities(): CapabilitySet {
  const set = new CapabilitySet();
  set.insert(newCapabilityId('core.query.ordered-results', 1));
  return set;
}

/** Builds the syntax definition from the vector filters (the Rust definition helper). */
function definition(
  case_: VectorCase,
  domain: { id: string; version: number },
  format: string,
): { definition: QueryDefinition } | { failure: string } {
  const filters = caseField(case_, 'filters') as { operator: string; argument?: string }[];
  const branches: QueryExpression[] = [];
  for (const filter of filters) {
    let operator;
    switch (filter.operator) {
      case 'kind-is':
        operator = newOperatorCall(`${format}.syntax-kind-is`, 1);
        operator = withArg(operator, 'kind', filter.argument as string);
        break;
      case 'text-equals':
        operator = newOperatorCall(`${format}.syntax-text-equals`, 1);
        operator = withArg(operator, 'text', filter.argument as string);
        break;
      case 'take':
        operator = withArg(newOperatorCall('core.take', 1), 'count', filter.argument as string);
        break;
      case 'distinct-by-identity':
        operator = newOperatorCall('core.distinct-by-identity', 1);
        break;
      default:
        operator = newOperatorCall(filter.operator, 1);
        break;
    }
    branches.push({ kind: 'Apply', input: { kind: 'Input' }, operator });
  }
  const combine = (caseFieldOptional(case_, 'combine') as string | undefined) ?? 'Single';
  let expression: QueryExpression;
  if (combine === 'Single' && branches.length === 0) {
    expression = { kind: 'Input' };
  } else if (combine === 'Single' && branches.length === 1) {
    expression = branches[0];
  } else if (combine === 'StructureOrderMerge') {
    expression = { kind: 'StructureOrderMerge', branches };
  } else if (combine === 'Concat') {
    expression = { kind: 'Concat', branches };
  } else {
    return { failure: 'invalid combine' };
  }
  const selection = (caseFieldOptional(case_, 'selection') as string | undefined) ?? 'All';
  return {
    definition: {
      domain,
      expression,
      selection: selection as 'All' | 'First' | 'Last' | 'ZeroOrOne' | 'RequireOne',
    },
  };
}

function withArg(operator: OperatorCall, name: string, value: string): OperatorCall {
  return {
    id: operator.id,
    version: operator.version,
    arguments: new Map([...operator.arguments, [name, stringValue(value)]]),
  };
}

function limitsOf(case_: VectorCase): { maxSteps: number; maxResults: number } {
  const maxResults = caseFieldOptional(case_, 'max_results') as number | undefined;
  return { maxSteps: 100_000, maxResults: maxResults ?? 100_000 };
}

function cancellationOf(case_: VectorCase): boolean {
  return caseFieldOptional(case_, 'cancelled') === true;
}

function failureCodeOf(error: unknown): string | undefined {
  return (error as { code?: unknown } | null)?.code as string | undefined;
}

function expectFailure(case_: VectorCase, code: string): void {
  const pinned = expectedFieldOptional(case_, 'code') as string | undefined;
  if (pinned !== undefined && pinned !== code) {
    fail(`code: expected ${pinned}, observed ${code}`);
  }
}

function runJson(case_: VectorCase): void {
  const profile = caseField(case_, 'profile') as string;
  const document = parseJson(
    utf8(caseField(case_, 'source') as string),
    profile === 'jsonc.bounded@1' ? 'JsoncBounded' : 'JsonStrict',
    DEFAULT_PARSE_LIMITS,
  );
  const built = definition(case_, domainJSONLosslessSyntaxV1(), 'json');
  if ('failure' in built) {
    expectFailure(case_, 'core.query.invalid-argument@1');
    return;
  }
  const validated = validateQuery(built.definition);
  if ('failure' in validated) {
    expectFailure(case_, validated.failure.code);
    return;
  }
  const bound = bindQuery(validated.query, capabilities());
  if ('failure' in bound) {
    fail(`binding failed: ${bound.failure.message}`);
  }
  const cancellation = new JsonCancellationToken();
  if (cancellationOf(case_)) {
    cancellation.cancel();
  }
  const limits = limitsOf(case_);
  try {
    const result = executeJsonSyntaxQuery(bound.query, document, new JsonQueryLimits(limits.maxSteps, limits.maxResults), cancellation);
    const matches = result.matches().map((item) => ({
      kind: item.kind(),
      text: new TextDecoder().decode(document.source().bytes().slice(item.span().startByte(), item.span().endByte())),
      ordinal: item.ordinal(),
      role: item.nodeRef().role(),
    }));
    compareMatches(case_, matches);
  } catch (error) {
    const code = error instanceof JsonQueryExecutionFailure ? (error as { code?: string }).code : failureCodeOf(error);
    if (code !== undefined) {
      expectFailure(case_, code);
      return;
    }
    throw error;
  }
}

function runToml(case_: VectorCase): void {
  const document = parseToml(
    utf8(caseField(case_, 'source') as string),
    TomlProfile.TOML_10_V1,
    DEFAULT_PARSE_LIMITS,
  );
  const built = definition(case_, domainTOMLLosslessSyntaxV1(), 'toml');
  if ('failure' in built) {
    expectFailure(case_, 'core.query.invalid-argument@1');
    return;
  }
  const validated = validateQuery(built.definition);
  if ('failure' in validated) {
    expectFailure(case_, validated.failure.code);
    return;
  }
  const bound = bindQuery(validated.query, capabilities());
  if ('failure' in bound) {
    fail(`binding failed: ${bound.failure.message}`);
  }
  const cancellation = new TomlCancellationToken();
  if (cancellationOf(case_)) {
    cancellation.cancel();
  }
  const limits = limitsOf(case_);
  try {
    const result = executeTomlSyntaxQuery(
      bound.query,
      document,
      { maxSteps: limits.maxSteps, maxResults: limits.maxResults } as TomlQueryLimitsType,
      cancellation,
    );
    const matches = result.matches.map((item) => ({
      kind: item.kind(),
      text: new TextDecoder().decode(document.source().bytes().slice(item.span().startByte(), item.span().endByte())),
      ordinal: item.ordinal(),
      role: item.nodeRef().role(),
    }));
    compareMatches(case_, matches);
  } catch (error) {
    const code = error instanceof TomlQueryExecutionFailure ? (error as { code?: string }).code : failureCodeOf(error);
    if (code !== undefined) {
      expectFailure(case_, code);
      return;
    }
    throw error;
  }
}

function compareMatches(case_: VectorCase, matches: { kind: string; text: string; ordinal: number; role: string }[]): void {
  const pinned = expectedFieldOptional(case_, 'matches') as
    | { kind: string; text: string; ordinal: number; role: string }[]
    | undefined;
  if (pinned !== undefined) {
    if (matches.length !== pinned.length) {
      fail(`matches: expected ${pinned.length}, observed ${matches.length}`);
    }
    pinned.forEach((expected, index) => {
      const observed = matches[index];
      if (observed.kind !== expected.kind || observed.ordinal !== expected.ordinal || observed.role !== expected.role) {
        fail(
          `match ${index}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(observed)}`,
        );
      }
      if (observed.text !== expected.text) {
        fail(`match ${index} text: expected ${JSON.stringify(expected.text)}, observed ${JSON.stringify(observed.text)}`);
      }
    });
  }
  const terminal = expectedFieldOptional(case_, 'terminal') as string | undefined;
  if (terminal !== undefined && terminal !== 'Completed') {
    fail(`terminal: expected ${terminal}, observed Completed`);
  }
}

/** The ordered cursor terminal face (syntax_query_v1.rs:318-366; the Rust
 * OrderedQueryCursor, query.rs:3047-3110). */
function runCursor(case_: VectorCase): void {
  const values = caseField(case_, 'values') as number[];
  const mode = caseField(case_, 'mode') as string;
  let yielded = 0;
  let terminal: string | undefined;
  if (mode === 'Completed') {
    const cursor = new OrderedCursor<number>(values, 'Completed');
    while (cursor.next() !== null) {
      if (cursor.terminalState() !== undefined) {
        fail('terminal state set before exhaustion');
      }
      yielded += 1;
    }
    terminal = cursor.terminalState();
  } else if (mode === 'Cancelled') {
    const token = new CancellationToken();
    const cursor = new OrderedCursor<number>(values, 'Completed', token);
    if (cursor.next() !== null) {
      if (cursor.terminalState() !== undefined) {
        fail('terminal state set before cancellation');
      }
      yielded += 1;
    }
    token.cancel();
    if (cursor.next() !== null) {
      fail('cancelled cursor must stop yielding');
    }
    terminal = cursor.terminalState();
  } else if (mode === 'Failed') {
    const cursor = new OrderedCursor<number>(values, 'Failed');
    while (cursor.next() !== null) {
      if (cursor.terminalState() !== undefined) {
        fail('terminal state set before exhaustion');
      }
      yielded += 1;
    }
    terminal = cursor.terminalState();
  } else {
    fail(`unknown cursor mode ${mode}`);
  }
  const expectedYielded = expectedField(case_, 'yielded') as number;
  if (yielded !== expectedYielded) {
    fail(`yielded: expected ${expectedYielded}, observed ${yielded}`);
  }
  const expectedTerminal = expectedField(case_, 'terminal') as string;
  if (terminal !== expectedTerminal) {
    fail(`terminal: expected ${expectedTerminal}, observed ${String(terminal)}`);
  }
}

export const runSyntaxQueryV1: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    if (case_.id.startsWith('syntax.json.')) {
      runJson(case_);
      return;
    }
    if (case_.id.startsWith('syntax.toml.')) {
      runToml(case_);
      return;
    }
    if (case_.id.startsWith('syntax.cursor.')) {
      runCursor(case_);
      return;
    }
    return skip(
      case_.capability ?? 'unknown',
      `runner does not recognize published case ${case_.id}`,
    );
  },
};
