/**
 * Intent documents for XML native and lossless-syntax query execution (L3).
 *
 * Golden transcriptions from the shared vectors — each test cites its
 * case id — plus domain gating and selection semantics:
 *  - conformance/vectors/xml-1-0-safe-v1.json: xml.syntax-query.kind-and-
 *    text-filter (:175-202), xml.syntax-query.entity-reference-kind
 *    (:204-226), xml.syntax-query.attribute-value-kind (:228-250),
 *    xml.native-query.attributes-and-values (:252-276),
 *    xml.native-query.descendants-order (:278-308)
 *  - the vector's ordinal field is informational (the conformance runner
 *    checks kind and text only, crates/consema-conformance/src/xml_v1.rs:
 *    297-325); the end-tag local-name ordinal here follows the current
 *    Rust crate (11), see parser.ts header
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse, PROFILE_XML_SAFE } from '../xml/index.ts';
import { executeXmlQuery, executeXmlSyntaxQuery, QueryLimits, CancellationToken } from '../xml/index.ts';
import { QueryExecutionFailure } from '../xml/index.ts';
import { DEFAULT_XML_PARSE_LIMITS } from '../xml/profile.ts';
import {
  domainXMLNativeV1,
  domainXMLLosslessSyntaxV1,
  newOperatorCall,
  newQueryDefinition,
  validateQuery,
  bindQuery,
  withArgument,
  withExpression,
  withSelection,
} from '../protocol/query.ts';
import type { QueryExpression } from '../protocol/query.ts';
import { CapabilitySet } from '../protocol/registry_descriptor.ts';
import { stringValue } from '../core/value.ts';

function bytes(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

function parseXml(source: string) {
  return parse(bytes(source), PROFILE_XML_SAFE, { kind: 'ProfileDefault' }, DEFAULT_XML_PARSE_LIMITS);
}

function capabilities(): CapabilitySet {
  const set = new CapabilitySet();
  set.insert({ namespace: 'core.query.ordered-results', version: 1 });
  return set;
}

function executable(domain: { id: string; version: number }, expression: QueryExpression) {
  const definition = withExpression(newQueryDefinition(domain), expression);
  const validated = validateQuery(definition);
  assert.ok('query' in validated, 'query must validate');
  const bound = bindQuery(validated.query, capabilities());
  assert.ok('query' in bound, 'query must bind');
  return bound.query;
}

function native(expression: QueryExpression, document: ReturnType<typeof parseXml>) {
  return executeXmlQuery(
    executable(domainXMLNativeV1(), expression),
    document,
    QueryLimits.defaults(),
    new CancellationToken(),
  ).matches();
}

function syntax(expression: QueryExpression, document: ReturnType<typeof parseXml>) {
  return executeXmlSyntaxQuery(
    executable(domainXMLLosslessSyntaxV1(), expression),
    document,
    QueryLimits.defaults(),
    new CancellationToken(),
  ).matches();
}

function syntaxText(match: { span(): { startByte(): number; endByte(): number } }, document: ReturnType<typeof parseXml>): string {
  const span = match.span();
  return new TextDecoder().decode(document.render().slice(span.startByte(), span.endByte()));
}

test('xml.syntax-query.kind-and-text-filter: local-name pieces in source order (xml-1-0-safe-v1.json:175-202)', () => {
  const document = parseXml('<root a="1">t</root>');
  const matches = syntax(
    {
      kind: 'Apply',
      input: { kind: 'Input' },
      operator: withArgument(newOperatorCall('xml.syntax-kind-is', 1), 'kind', stringValue('local-name')),
    },
    document,
  );
  assert.equal(matches.length, 2);
  assert.deepEqual(matches.map((match) => syntaxText(match, document)), ['root', 'root']);
  // Vector ordinals 1 and 10 are informational; the current Rust crate
  // emits the end-tag local-name at ordinal 11 (see parser.ts header).
  assert.deepEqual(matches.map((match) => match.ordinal()), [1, 11]);
});

test('xml.syntax-query.entity-reference-kind: the reference piece covers the whole `&…;` (xml-1-0-safe-v1.json:204-226)', () => {
  const document = parseXml('<root>&lt;</root>');
  const matches = syntax(
    {
      kind: 'Apply',
      input: { kind: 'Input' },
      operator: withArgument(newOperatorCall('xml.syntax-kind-is', 1), 'kind', stringValue('entity-reference')),
    },
    document,
  );
  assert.equal(matches.length, 1);
  assert.equal(syntaxText(matches[0], document), '&lt;');
  assert.equal(matches[0].ordinal(), 3);
});

test('xml.syntax-query.attribute-value-kind: the value piece excludes the quotes (xml-1-0-safe-v1.json:228-250)', () => {
  const document = parseXml('<root a="1"/>');
  const matches = syntax(
    {
      kind: 'Apply',
      input: { kind: 'Input' },
      operator: withArgument(newOperatorCall('xml.syntax-kind-is', 1), 'kind', stringValue('attribute-value')),
    },
    document,
  );
  assert.equal(matches.length, 1);
  assert.equal(syntaxText(matches[0], document), '1');
  assert.equal(matches[0].ordinal(), 6);
});

test('xml.syntax-query: syntax-text-equals filters exact raw piece text', () => {
  const document = parseXml('<root a="1">t</root>');
  const matches = syntax(
    {
      kind: 'Apply',
      input: { kind: 'Input' },
      operator: withArgument(newOperatorCall('xml.syntax-text-equals', 1), 'text', stringValue('t')),
    },
    document,
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind(), 'text');
});

test('xml.native-query.attributes-and-values: ordered attributes with normalized values (xml-1-0-safe-v1.json:252-276)', () => {
  const document = parseXml('<root a="1"/>');
  const matches = native(
    {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: { kind: 'Input' },
        operator: newOperatorCall('xml.document-root', 1),
      },
      operator: newOperatorCall('xml.element-attributes', 1),
    },
    document,
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].kind, 'Attribute');
  const attribute = attributeMatch(matches[0]);
  assert.equal(attribute.local, 'a');
  assert.equal(attribute.value, '1');
  assert.equal(attribute.namespace, null);
});

/** One narrowed attribute match. */
function attributeMatch(match: { kind: string; local?: string; value?: string; namespace?: string | null }) {
  assert.equal(match.kind, 'Attribute');
  assert.ok(match.local !== undefined);
  assert.ok(match.value !== undefined);
  assert.ok(match.namespace !== undefined);
  return { local: match.local, value: match.value, namespace: match.namespace };
}

test('xml.native-query.descendants-order: bounded pre-order traversal (xml-1-0-safe-v1.json:278-308)', () => {
  const document = parseXml('<root><a/><b/><c/></root>');
  const matches = native(
    {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: { kind: 'Input' },
        operator: newOperatorCall('xml.document-root', 1),
      },
      operator: newOperatorCall('xml.element-descendants', 1),
    },
    document,
  );
  assert.deepEqual(
    matches.map((match) => ({ kind: match.kind, local: elementLocal(match) })),
    [
      { kind: 'Element', local: 'a' },
      { kind: 'Element', local: 'b' },
      { kind: 'Element', local: 'c' },
    ],
  );
});

/** The local name of one element match. */
function elementLocal(match: { kind: string; local?: string }): string {
  assert.equal(match.kind, 'Element');
  assert.ok(match.local !== undefined);
  return match.local;
}

test('xml.native-query: mixed content keeps its source order across kinds', () => {
  const document = parseXml('<root>a<b/>c</root>');
  const matches = native(
    {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: { kind: 'Input' },
        operator: newOperatorCall('xml.document-root', 1),
      },
      operator: newOperatorCall('xml.element-children', 1),
    },
    document,
  );
  assert.deepEqual(
    matches.map((match) => match.kind),
    ['Text', 'Element', 'Text'],
  );
});

test('xml.native-query: name-equals filters by expanded name, never by prefix spelling', () => {
  const document = parseXml('<p:root xmlns:p="urn:one"><q:item xmlns:q="urn:one"/></p:root>');
  const matches = native(
    {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: {
          kind: 'Apply',
          input: { kind: 'Input' },
          operator: newOperatorCall('xml.document-root', 1),
        },
        operator: newOperatorCall('xml.element-descendants', 1),
      },
      operator: withArgument(
        withArgument(
          withArgument(
            withArgument(newOperatorCall('xml.name-equals', 1), 'prefix', stringValue('')),
            'local',
            stringValue('item'),
          ),
          'namespace',
          stringValue('urn:one'),
        ),
        'comparison',
        stringValue('Expanded'),
      ),
    },
    document,
  );
  assert.equal(matches.length, 1);
  assert.equal(elementLocal(matches[0]), 'item');
});

test('xml.native-query: text-references expose kind, name, and resolved character data', () => {
  const document = parseXml('<root>a &lt; &#65; &name;</root>');
  const matches = native(
    {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: {
          kind: 'Apply',
          input: { kind: 'Input' },
          operator: newOperatorCall('xml.document-root', 1),
        },
        operator: newOperatorCall('xml.element-child-text', 1),
      },
      operator: newOperatorCall('xml.text-references', 1),
    },
    document,
  );
  assert.equal(matches.length, 2, 'the unknown general entity reference is not proven');
  assert.deepEqual(
    matches.map((match) => {
      assert.equal(match.kind, 'Reference');
      const reference = match as { kind: 'Reference'; kindName: string; name: string; resolved: string };
      return { kind: reference.kindName, name: reference.name, resolved: reference.resolved };
    }),
    [
      { kind: 'Predefined', name: 'lt', resolved: '<' },
      { kind: 'Character', name: '&#x41;', resolved: 'A' },
    ],
  );
});

test('query gating: a foreign operator is rejected at validation, before execution', () => {
  const definition = withExpression(newQueryDefinition(domainXMLNativeV1()), {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: newOperatorCall('ini.all-entries', 1),
  });
  const validated = validateQuery(definition);
  assert.ok('failure' in validated, 'the ini operator is not part of the xml domain');
});

test('query gating: cardinality selection is enforced (RequireOne)', () => {
  const document = parseXml('<root><a/><b/></root>');
  const definition = withSelection(
    withExpression(newQueryDefinition(domainXMLNativeV1()), {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: { kind: 'Input' },
        operator: newOperatorCall('xml.document-root', 1),
      },
      operator: newOperatorCall('xml.element-child-elements', 1),
    }),
    'RequireOne',
  );
  const validated = validateQuery(definition);
  assert.ok('query' in validated, 'query must validate');
  const bound = bindQuery(validated.query, capabilities());
  assert.ok('query' in bound, 'query must bind');
  assert.throws(
    () =>
      executeXmlQuery(bound.query, document, QueryLimits.defaults(), new CancellationToken()),
    (error: unknown) => {
      assert.ok(error instanceof QueryExecutionFailure);
      assert.equal(error.kind, 'CardinalityViolation');
      assert.equal(error.code, 'core.query.cardinality-violation@1');
      return true;
    },
  );
});

test('query gating: cancellation fails with core.query.cancelled@1', () => {
  const document = parseXml('<root><a/><b/></root>');
  const cancellation = new CancellationToken();
  cancellation.cancel();
  assert.throws(
    () =>
      executeXmlQuery(
        executable(domainXMLNativeV1(), { kind: 'Input' }),
        document,
        QueryLimits.defaults(),
        cancellation,
      ),
    (error: unknown) => {
      assert.ok(error instanceof QueryExecutionFailure);
      assert.equal(error.kind, 'Cancelled');
      assert.equal(error.code, 'core.query.cancelled@1');
      return true;
    },
  );
});
