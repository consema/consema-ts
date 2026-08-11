/**
 * Query pipeline construction and family execution (mirror of the Rust
 * runner's `pipeline` helper, lib.rs:560-582, and the family executors).
 *
 * A pipeline is a sequence of `name@version` operator descriptors applied
 * to `Input`; the empty pipeline is the bare `Input` expression. A
 * descriptor is either `"name@version"` or `["name@version", arguments]`
 * where arguments is an object of `{name: value}` PortableValue
 * descriptors (the Rust `with_argument` spelling). The built definition is
 * validated and bound, then executed by the family executor
 * (JSON/TOML/YAML/INI/properties/XML/plist/HCL).
 */

import type { QueryExpression, QueryDefinition, ExecutableQuery } from '../../protocol/query.ts';
import { newOperatorCall, validateQuery, bindQuery } from '../../protocol/query.ts';
import { newCapabilityId, CapabilitySet } from '../../protocol/registry_descriptor.ts';
import { valueFromInput } from '../helpers.ts';
import { fail } from './common.ts';

/** Builds the expression from pipeline descriptors. */
export function pipelineExpression(descriptors: readonly unknown[]): QueryExpression {
  let expression: QueryExpression = { kind: 'Input' };
  for (const descriptor of descriptors) {
    let text: string;
    let arguments_: Record<string, unknown> | undefined;
    if (typeof descriptor === 'string') {
      text = descriptor;
    } else if (Array.isArray(descriptor) && typeof descriptor[0] === 'string') {
      text = descriptor[0];
      const args = descriptor[1];
      if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
        arguments_ = args as Record<string, unknown>;
      }
    } else {
      fail(`invalid pipeline descriptor ${JSON.stringify(descriptor)}`);
    }
    const at = text.indexOf('@');
    if (at < 0) {
      fail(`pipeline descriptor lacks version: ${text}`);
    }
    const name = text.slice(0, at);
    const version = Number(text.slice(at + 1));
    let operator = newOperatorCall(name, version);
    if (arguments_ !== undefined) {
      for (const key of Object.keys(arguments_)) {
        operator = {
          id: operator.id,
          version: operator.version,
          arguments: new Map([...operator.arguments, [key, valueFromInput(arguments_[key])]]),
        };
      }
    }
    expression = {
      kind: 'Apply',
      input: expression,
      operator,
    };
  }
  return expression;
}

/** Applies one descriptor to an existing expression (for incremental pipelines). */
export function applyDescriptor(expression: QueryExpression, descriptor: unknown): QueryExpression {
  let text: string;
  let arguments_: Record<string, unknown> | undefined;
  if (typeof descriptor === 'string') {
    text = descriptor;
  } else if (Array.isArray(descriptor) && typeof descriptor[0] === 'string') {
    text = descriptor[0];
    const args = descriptor[1];
    if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
      arguments_ = args as Record<string, unknown>;
    }
  } else {
    fail(`invalid pipeline descriptor ${JSON.stringify(descriptor)}`);
  }
  const at = text.indexOf('@');
  if (at < 0) {
    fail(`pipeline descriptor lacks version: ${text}`);
  }
  let operator = newOperatorCall(text.slice(0, at), Number(text.slice(at + 1)));
  if (arguments_ !== undefined) {
    for (const key of Object.keys(arguments_)) {
      operator = {
        id: operator.id,
        version: operator.version,
        arguments: new Map([...operator.arguments, [key, valueFromInput(arguments_[key])]]),
      };
    }
  }
  return { kind: 'Apply', input: expression, operator };
}

/** Validates and binds a definition under the ordered-results capability. */
export function validateAndBind(definition: QueryDefinition): ExecutableQuery {
  const validated = validateQuery(definition);
  if ('failure' in validated) {
    fail(`query validation failed: ${validated.failure.message}`);
  }
  const bound = bindQuery(validated.query, orderedResultsCapabilities());
  if ('failure' in bound) {
    fail(`query binding failed: ${bound.failure.message}`);
  }
  return bound.query;
}

/** The capability set every validated query requires (lib.rs:554-558). */
export function orderedResultsCapabilities(): CapabilitySet {
  const capabilities = new CapabilitySet();
  capabilities.insert(newCapabilityId('core.query.ordered-results', 1));
  return capabilities;
}

/** Reports whether validation fails with InvalidOperatorComposition. */
export function validationFailsComposition(definition: QueryDefinition): boolean {
  const validated = validateQuery(definition);
  return 'failure' in validated && validated.failure.kind === 'InvalidOperatorComposition';
}
