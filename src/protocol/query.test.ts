/**
 * Query validation intent tests.
 *
 * These pin the domain/operator table facts of
 * crates/consema-core/src/query.rs:899-1897 and the vector failure names of
 * conformance/vectors/v1.json (query.reject-role-mismatch). They run once
 * the toolchain is ready; no gate is claimed before that (§7 START GATE).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newQueryDefinition,
  domainPortableValueV1,
  domainJSONNativeV1,
  domainYAMLNativeV1,
  domainPortableGraphV1,
  domainHCLNativeV1,
  domainPlistNativeV1,
  newOperatorCall,
  withArgument,
  validateQuery,
  QueryFailure,
} from './query.ts';
import type { QueryExpression } from './query.ts';
import { CapabilitySet, newCapabilityId } from './registry_descriptor.ts';
import { bindQuery } from './query.ts';
import { integerValue, stringValue, bytesValue } from '../core/value.ts';

function apply(operatorId: string, ...argumentPairs: [string, unknown][]): QueryExpression {
  let operator = newOperatorCall(operatorId, 1);
  for (const [name, value] of argumentPairs) {
    operator = withArgument(operator, name, value as never);
  }
  return { kind: 'Apply', input: { kind: 'Input' }, operator };
}

test('vector query.reject-role-mismatch: object-entry-value on a value input fails', () => {
  // conformance/vectors/v1.json expects InvalidOperatorComposition.
  const definition = newQueryDefinition(domainPortableValueV1());
  const expression = apply('core.object-entry-value');
  const result = validateQuery({ ...definition, expression });
  assert.ok('failure' in result);
  assert.equal(result.failure.kind, 'InvalidOperatorComposition');
  assert.equal(result.failure.code, 'core.query.invalid-composition@1');
});

test('a valid pipeline validates with the domain input role', () => {
  const definition = newQueryDefinition(domainPortableValueV1());
  const expression = apply('core.try-sequence-elements');
  const result = validateQuery({ ...definition, expression });
  assert.ok('query' in result);
  assert.equal(result.query.outputRole, 'Value');
  // The required capability is always core.query.ordered-results@1.
  assert.equal(result.query.requiredCapabilities[0].namespace, 'core.query.ordered-results');
  assert.equal(result.query.requiredCapabilities[0].version, 1);
});

test('unknown operators and versions fail with the frozen codes', () => {
  const definition = newQueryDefinition(domainPortableValueV1());
  const expression: QueryExpression = { kind: 'Apply', input: { kind: 'Input' }, operator: newOperatorCall('core.nonexistent', 1) };
  const result = validateQuery({ ...definition, expression });
  assert.ok('failure' in result);
  assert.equal(result.failure.kind, 'UnknownOperator');
  assert.equal(result.failure.code, 'core.query.unknown-operator@1');

  const badVersion: QueryExpression = { kind: 'Apply', input: { kind: 'Input' }, operator: newOperatorCall('core.try-sequence-elements', 2) };
  const result2 = validateQuery({ ...definition, expression: badVersion });
  assert.ok('failure' in result2);
  assert.equal(result2.failure.kind, 'UnknownOperator');
});

test('domain mismatch fails for unknown domains', () => {
  const definition = newQueryDefinition({ id: 'core.unknown-query', version: 1 });
  const result = validateQuery(definition);
  assert.ok('failure' in result);
  assert.equal(result.failure.kind, 'DomainMismatch');
  assert.equal(result.failure.code, 'core.query.domain-mismatch@1');
});

test('argument kinds are checked against the table', () => {
  // where-type wants a String "kind" argument.
  const definition = newQueryDefinition(domainPortableValueV1());
  const wrongKind = apply('core.where-type', ['kind', integerValue(1n)]);
  const result = validateQuery({ ...definition, expression: wrongKind });
  assert.ok('failure' in result);
  assert.equal(result.failure.kind, 'WrongArgumentType');
  assert.equal(result.failure.code, 'core.query.wrong-argument-type@1');

  // Missing the argument entirely is an invalid-argument failure.
  const missing = apply('core.where-type');
  const result2 = validateQuery({ ...definition, expression: missing });
  assert.ok('failure' in result2);
  assert.equal(result2.failure.kind, 'InvalidArgument');
});

test('semantic argument checks: value-kind vocabulary and state sets', () => {
  const definition = newQueryDefinition(domainPortableValueV1());
  const badKind = apply('core.require-type', ['kind', stringValue('NotAKind')]);
  const result = validateQuery({ ...definition, expression: badKind });
  assert.ok('failure' in result);
  assert.equal(result.failure.kind, 'InvalidArgument');
  assert.equal(result.failure.code, 'core.query.invalid-argument@1');

  // ini.entry-value-state-is expects an IniEntry input; compose the entry
  // path (IniDocument -> IniSection -> IniEntry) so the role check passes and
  // the state vocabulary check runs. The Rust authority checks roles before
  // arguments (consema-core/src/query.rs:1612-1618), so a bare apply with the
  // IniDocument input correctly fails as InvalidOperatorComposition instead.
  const iniDefinition = newQueryDefinition({ id: 'ini.native-semantic-query', version: 1 });
  const iniEntry: QueryExpression = {
    kind: 'Apply',
    input: { kind: 'Apply', input: { kind: 'Input' }, operator: newOperatorCall('ini.document-sections', 1) },
    operator: newOperatorCall('ini.section-entries', 1),
  };
  const badState: QueryExpression = {
    kind: 'Apply',
    input: iniEntry,
    operator: withArgument(newOperatorCall('ini.entry-value-state-is', 1), 'state', stringValue('PresentButWrong')),
  };
  const result2 = validateQuery({ ...iniDefinition, expression: badState });
  assert.ok('failure' in result2);
  assert.equal(result2.failure.kind, 'InvalidArgument');
});

test('generic rows: core.take validates a non-negative integer count', () => {
  const definition = newQueryDefinition(domainPortableValueV1());
  const ok = apply('core.take', ['count', integerValue(2n)]);
  const result = validateQuery({ ...definition, expression: ok });
  assert.ok('query' in result);
  const negative = apply('core.take', ['count', integerValue(-1n)]);
  const result2 = validateQuery({ ...definition, expression: negative });
  assert.ok('failure' in result2);
  assert.equal(result2.failure.kind, 'InvalidArgument');
});

test('properties UTF-16 code-unit arguments must be even-length Bytes', () => {
  const definition = newQueryDefinition({ id: 'java-properties.lossless-syntax-query', version: 1 });
  const odd = apply('properties.syntax-utf16be-equals', ['code_units', bytesValue(Uint8Array.of(0))]);
  const result = validateQuery({ ...definition, expression: odd });
  assert.ok('failure' in result);
  assert.equal(result.failure.kind, 'InvalidArgument');
});

test('input-dependent role rows: ini.duplicate-group and the HCL unions', () => {
  // ini.duplicate-group accepts IniSection or IniEntry.
  const iniDefinition = newQueryDefinition({ id: 'ini.native-semantic-query', version: 1 });
  const entryInput: QueryExpression = {
    kind: 'Apply',
    input: { kind: 'Apply', input: { kind: 'Input' }, operator: newOperatorCall('ini.document-sections', 1) },
    operator: newOperatorCall('ini.section-entries', 1),
  };
  const result = validateQuery({ ...iniDefinition, expression: entryInput });
  assert.ok('query' in result);
  const duplicateGroup: QueryExpression = {
    kind: 'Apply',
    input: entryInput,
    operator: newOperatorCall('ini.duplicate-group', 1),
  };
  const result2 = validateQuery({ ...iniDefinition, expression: duplicateGroup });
  assert.ok('query' in result2);

  // hcl.attribute-expression accepts HclAttribute or HclBlock.
  const hclDefinition = newQueryDefinition(domainHCLNativeV1());
  const bodyItems: QueryExpression = {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: newOperatorCall('hcl.body-items', 1),
  };
  const result3 = validateQuery({ ...hclDefinition, expression: bodyItems });
  assert.ok('query' in result3);
  const attributeExpression: QueryExpression = {
    kind: 'Apply',
    input: bodyItems,
    operator: newOperatorCall('hcl.attribute-expression', 1),
  };
  const result4 = validateQuery({ ...hclDefinition, expression: attributeExpression });
  assert.ok('query' in result4);
});

test('binding requires the ordered-results capability', () => {
  const definition = newQueryDefinition(domainPortableGraphV1());
  const expression = apply('graph.reachable-nodes');
  const result = validateQuery({ ...definition, expression });
  assert.ok('query' in result);
  const empty = new CapabilitySet();
  const bound = bindQuery(result.query, empty);
  assert.ok('failure' in bound);
  assert.equal(bound.failure.kind, 'MissingCapability');
  assert.equal(bound.failure.code, 'core.query.missing-capability@1');
  const ready = new CapabilitySet();
  ready.insert(newCapabilityId('core.query.ordered-results', 1));
  const bound2 = bindQuery(result.query, ready);
  assert.ok('query' in bound2);
});

test('the operator table is closed per domain (spot checks)', () => {
  const jsonDefinition = newQueryDefinition(domainJSONNativeV1());
  const jsonOp = apply('json.try-object-members');
  const result = validateQuery({ ...jsonDefinition, expression: jsonOp });
  assert.ok('query' in result);
  assert.equal(result.query.outputRole, 'JsonObjectMember');

  const yamlDefinition = newQueryDefinition(domainYAMLNativeV1());
  const yamlOp = apply('yaml.documents');
  const result2 = validateQuery({ ...yamlDefinition, expression: yamlOp });
  assert.ok('query' in result2);
  assert.equal(result2.query.outputRole, 'YamlDocument');

  const plistDefinition = newQueryDefinition(domainPlistNativeV1());
  const plistOp = apply('plist.value-as-uid');
  const result3 = validateQuery({ ...plistDefinition, expression: plistOp });
  assert.ok('query' in result3);
});

test('QueryFailure carries the frozen codes', () => {
  const failure = new QueryFailure({ kind: 'UnknownOperator', operator: 'core.x', version: 1 });
  assert.equal(failure.code, 'core.query.unknown-operator@1');
  assert.ok(failure instanceof Error);
});
