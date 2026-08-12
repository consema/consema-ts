/**
 * Query-match, query-result, and query-definition wire records.
 *
 * authority: crates/consema-protocol/src/query.rs — NativeMatchLocator
 * (:54-124), ProtocolQueryMatch (:126-144), QueryResultMessage (:146-327);
 * the `core.query-definition@1` codec mirrors consema-core query.rs:532-734
 * (to_protocol_value/from_protocol_value) with the Python
 * QueryDefinitionCodec (consema/protocol/query.py:1202-1340) as the
 * runner-side cross-reference. The value-path/association-location records
 * come from records_value_path.ts (already implemented).
 *
 * Design (TypeScript-idiomatic): plain records with validated static
 * factories; every record self-registers its full decoder with the envelope
 * payload dispatch (payload.rs:145-157).
 */

import type { ObjectValue, PortableValue } from '../core/value.ts';
import { stringValue, integerValue } from '../core/value.ts';
import {
  exactFields,
  schemaFields,
  stringOf,
  sequenceOf,
  unsigned64,
  unsigned32,
  objectOf,
  objectValueFrom,
} from './records.ts';
import { invalid } from './errors.ts';
import { ErrorCodeRegistry } from './error_registry.ts';
import { registerPayloadValidator } from './payload_validators.ts';
import { ValuePath, AssociationLocation } from './records_value_path.ts';
import type { Diagnostic } from './diagnostic.ts';
import { diagnosticFromValue, diagnosticToValue, processLocalError } from './diagnostic.ts';
import type { MatchRole, QueryDefinition, QueryDomain, QuerySelection, QueryExpression, OperatorCall } from './query.ts';
import { newQueryDomain } from './query.ts';
import { Completion } from './records_execution.ts';
import type { NodeRef } from '../document/identity.ts';

/** The match roles published by `core.query-result@1` (query.rs:628-692). */
const V1_ROLES: readonly MatchRole[] = [
  'Value',
  'ObjectEntry',
  'EntryMappingEntry',
  'JsonValue',
  'JsonObjectMember',
  'JsonArrayElement',
  'TomlItem',
  'TomlEntry',
  'TomlArrayElement',
  'JsonSyntaxPiece',
  'TomlSyntaxPiece',
];

/** The native match roles accepted by NativeMatchLocator (query.rs:711-723). */
const NATIVE_ROLES: readonly MatchRole[] = [
  'JsonValue',
  'JsonObjectMember',
  'JsonArrayElement',
  'TomlItem',
  'TomlEntry',
  'TomlArrayElement',
  'JsonSyntaxPiece',
  'TomlSyntaxPiece',
];

/** Parses one canonical match-role spelling published by the v1 record (query.rs:694-709). */
export function parseMatchRole(text: string): MatchRole | undefined {
  return (V1_ROLES as readonly string[]).includes(text) ? (text as MatchRole) : undefined;
}

/** Reports whether the role is published by `core.query-result@1` (query.rs:628-692). */
export function isV1Role(role: MatchRole): boolean {
  return (V1_ROLES as readonly string[]).includes(role);
}

function isNativeRole(role: MatchRole): boolean {
  return (NATIVE_ROLES as readonly string[]).includes(role);
}

/** Caller-externalized locator for a native semantic query match (query.rs:54-63). */
export class NativeMatchLocator {
  readonly sourceId: string;
  readonly nodeLocator: string;
  readonly role: MatchRole;
  readonly ordinal: bigint;

  private constructor(sourceId: string, nodeLocator: string, role: MatchRole, ordinal: bigint) {
    this.sourceId = sourceId;
    this.nodeLocator = nodeLocator;
    this.role = role;
    this.ordinal = ordinal;
  }

  /** Creates a transferable locator for one native match (query.rs:64-90). */
  static new(
    sourceId: string,
    nodeLocator: string,
    role: MatchRole,
    ordinal: bigint,
  ): NativeMatchLocator {
    if (
      sourceId === '' ||
      sourceId.length > 1024 ||
      nodeLocator === '' ||
      nodeLocator.length > 4096 ||
      !isNativeRole(role)
    ) {
      throw invalid('$.native_match', 'invalid source, locator, or native role');
    }
    return new NativeMatchLocator(sourceId, nodeLocator, role, ordinal);
  }

  /** Explicit rejection adapter for raw process-local handles (query.rs:92-99). */
  static fromProcessLocal(_node: NodeRef): never {
    throw processLocalError('$.native_match.node');
  }
}

/** One transferable query match (query.rs:126-144). */
export class ProtocolQueryMatch {
  readonly kind: 'Value' | 'ObjectEntry' | 'EntryMappingEntry' | 'Native';
  readonly path: ValuePath | null;
  readonly value: PortableValue | null;
  readonly location: AssociationLocation | null;
  /** ObjectEntry key (a String); EntryMappingEntry key (any PortableValue). */
  readonly key: string | PortableValue | null;
  readonly valuePath: ValuePath | null;
  readonly keyPath: ValuePath | null;
  readonly native: NativeMatchLocator | null;

  constructor(
    options:
      | { readonly kind: 'Value'; readonly path: ValuePath; readonly value: PortableValue }
      | {
          readonly kind: 'ObjectEntry';
          readonly location: AssociationLocation;
          readonly key: string;
          readonly valuePath: ValuePath;
          readonly value: PortableValue;
        }
      | {
          readonly kind: 'EntryMappingEntry';
          readonly location: AssociationLocation;
          readonly keyPath: ValuePath;
          readonly key: PortableValue;
          readonly valuePath: ValuePath;
          readonly value: PortableValue;
        }
      | { readonly kind: 'Native'; readonly native: NativeMatchLocator },
  ) {
    this.kind = options.kind;
    this.path = options.kind === 'Value' ? options.path : null;
    this.value = options.kind === 'Value' ? options.value : options.kind === 'Native' ? null : options.value;
    this.location = options.kind === 'ObjectEntry' || options.kind === 'EntryMappingEntry' ? options.location : null;
    this.key = options.kind === 'ObjectEntry' ? options.key : options.kind === 'EntryMappingEntry' ? options.key : null;
    this.valuePath = options.kind === 'ObjectEntry' || options.kind === 'EntryMappingEntry' ? options.valuePath : null;
    this.keyPath = options.kind === 'EntryMappingEntry' ? options.keyPath : null;
    this.native = options.kind === 'Native' ? options.native : null;
  }

  /** The uniform match role of the record (query.rs:135-143). */
  role(): MatchRole {
    switch (this.kind) {
      case 'Value':
        return 'Value';
      case 'ObjectEntry':
        return 'ObjectEntry';
      case 'EntryMappingEntry':
        return 'EntryMappingEntry';
      case 'Native':
        return this.native!.role;
    }
  }

  /** Encodes one match (query.rs:329-376). */
  toValue(): ObjectValue {
    switch (this.kind) {
      case 'Value':
        return objectValueFrom([
          { key: 'kind', value: stringValue('Value') },
          { key: 'path', value: this.path!.toValue() },
          { key: 'value', value: this.value! },
        ]);
      case 'ObjectEntry':
        return objectValueFrom([
          { key: 'kind', value: stringValue('ObjectEntry') },
          { key: 'location', value: this.location!.toValue() },
          { key: 'key', value: stringValue(this.key as string) },
          { key: 'value_path', value: this.valuePath!.toValue() },
          { key: 'value', value: this.value! },
        ]);
      case 'EntryMappingEntry':
        return objectValueFrom([
          { key: 'kind', value: stringValue('EntryMappingEntry') },
          { key: 'location', value: this.location!.toValue() },
          { key: 'key_path', value: this.keyPath!.toValue() },
          { key: 'key', value: this.key as PortableValue },
          { key: 'value_path', value: this.valuePath!.toValue() },
          { key: 'value', value: this.value! },
        ]);
      case 'Native':
        return objectValueFrom([
          { key: 'kind', value: stringValue('Native') },
          { key: 'role', value: stringValue(this.native!.role) },
          { key: 'source_id', value: stringValue(this.native!.sourceId) },
          { key: 'node_locator', value: stringValue(this.native!.nodeLocator) },
          { key: 'ordinal', value: integerValue(this.native!.ordinal) },
        ]);
    }
  }

  /** Strictly decodes one match (query.rs:378-439). */
  static fromValue(value: PortableValue, path: string): ProtocolQueryMatch {
    if (value.kind !== 'Object' || value.entries.length === 0) {
      throw invalid(path, 'expected match Object');
    }
    const entries = value.entries;
    if (entries[0].key !== 'kind') {
      throw invalid(path, 'kind must be the first String field');
    }
    const kind = stringOf(entries[0].value, `${path}.kind`);
    switch (kind) {
      case 'Value': {
        const fields = exactFields(value, ['kind', 'path', 'value'], path);
        return new ProtocolQueryMatch({
          kind: 'Value',
          path: ValuePath.fromValue(fields[1]),
          value: fields[2],
        });
      }
      case 'ObjectEntry': {
        const fields = exactFields(value, ['kind', 'location', 'key', 'value_path', 'value'], path);
        return new ProtocolQueryMatch({
          kind: 'ObjectEntry',
          location: AssociationLocation.fromValue(fields[1]),
          key: stringOf(fields[2], `${path}.key`),
          valuePath: ValuePath.fromValue(fields[3]),
          value: fields[4],
        });
      }
      case 'EntryMappingEntry': {
        const fields = exactFields(
          value,
          ['kind', 'location', 'key_path', 'key', 'value_path', 'value'],
          path,
        );
        return new ProtocolQueryMatch({
          kind: 'EntryMappingEntry',
          location: AssociationLocation.fromValue(fields[1]),
          keyPath: ValuePath.fromValue(fields[2]),
          key: fields[3],
          valuePath: ValuePath.fromValue(fields[4]),
          value: fields[5],
        });
      }
      case 'Native': {
        const fields = exactFields(value, ['kind', 'role', 'source_id', 'node_locator', 'ordinal'], path);
        const role = parseMatchRole(stringOf(fields[1], `${path}.role`));
        if (role === undefined) {
          throw invalid(`${path}.role`, 'unknown match role');
        }
        return new ProtocolQueryMatch({
          kind: 'Native',
          native: NativeMatchLocator.new(
            stringOf(fields[2], `${path}.source_id`),
            stringOf(fields[3], `${path}.node_locator`),
            role,
            unsigned64(fields[4], `${path}.ordinal`),
          ),
        });
      }
      default:
        throw invalid(path, 'unknown query match kind');
    }
  }
}

/** The complete or explicitly non-complete `core.query-result@1` record (query.rs:146-155). */
export class QueryResultMessage {
  readonly domain: QueryDomain;
  readonly role: MatchRole;
  readonly matches: readonly ProtocolQueryMatch[];
  readonly completion: Completion;
  readonly diagnostics: readonly Diagnostic[];

  private constructor(
    domain: QueryDomain,
    role: MatchRole,
    matches: readonly ProtocolQueryMatch[],
    completion: Completion,
    diagnostics: readonly Diagnostic[],
  ) {
    this.domain = domain;
    this.role = role;
    this.matches = Object.freeze([...matches]);
    this.completion = completion;
    this.diagnostics = Object.freeze([...diagnostics]);
  }

  /** Validates domain, match roles, ordering ordinals, and completion counts (query.rs:156-200). */
  static new(
    domain: QueryDomain,
    role: MatchRole,
    matches: readonly ProtocolQueryMatch[],
    completion: Completion,
    diagnostics: readonly Diagnostic[],
  ): QueryResultMessage {
    if (!isV1Role(role)) {
      throw invalid('$.role', 'role is not published by core.query-result@1');
    }
    const produced = BigInt(matches.length);
    if (completion.produced !== produced || matches.some((match) => match.role() !== role)) {
      throw invalid('$', 'completion count or match role is inconsistent');
    }
    let previous = 0n;
    let seen = false;
    for (const match of matches) {
      if (match.kind !== 'Native') {
        continue;
      }
      if (seen && match.native!.ordinal <= previous) {
        throw invalid('$.matches', 'native match ordinals must be strictly increasing');
      }
      previous = match.native!.ordinal;
      seen = true;
    }
    return new QueryResultMessage(domain, role, matches, completion, diagnostics);
  }

  /** Converts a completed portable query execution (query.rs:202-223). */
  static fromPortableExecution(
    domain: QueryDomain,
    role: MatchRole,
    matches: readonly ProtocolQueryMatch[],
  ): QueryResultMessage {
    const count = BigInt(matches.length);
    return QueryResultMessage.new(
      domain,
      role,
      matches,
      Completion.new('Success', count, count),
      [],
    );
  }

  /** Encodes `core.query-result@1` (query.rs:256-280). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: stringValue('core.query-result@1') },
      { key: 'domain_id', value: stringValue(this.domain.id) },
      { key: 'domain_version', value: integerValue(BigInt(this.domain.version)) },
      { key: 'role', value: stringValue(this.role) },
      { key: 'matches', value: { kind: 'Sequence', items: this.matches.map((match) => match.toValue()) } },
      { key: 'completion', value: this.completion.toValue() },
      {
        key: 'diagnostics',
        value: { kind: 'Sequence', items: this.diagnostics.map((diagnostic) => diagnosticToValueOf(diagnostic)) },
      },
    ]);
  }

  /** Strictly decodes `core.query-result@1` under the v1 registry (query.rs:282-285). */
  static fromValue(value: PortableValue): QueryResultMessage {
    return QueryResultMessage.fromValueWithRegistry(value, new ErrorCodeRegistry(1));
  }

  /** Strictly decodes terminal facts under one explicit registry (query.rs:288-326). */
  static fromValueWithRegistry(value: PortableValue, registry: ErrorCodeRegistry): QueryResultMessage {
    const fields = schemaFields(
      value,
      'core.query-result@1',
      ['domain_id', 'domain_version', 'role', 'matches', 'completion', 'diagnostics'],
      '$',
    );
    const domain = newQueryDomain(stringOf(fields[0], '$.domain_id'), unsigned32(fields[1], '$.domain_version'));
    const role = parseMatchRole(stringOf(fields[2], '$.role'));
    if (role === undefined) {
      throw invalid('$.role', 'unknown match role');
    }
    const matches = sequenceOf(fields[3], '$.matches').map((item, index) =>
      ProtocolQueryMatch.fromValue(item, `$.matches[${index}]`),
    );
    const diagnostics = sequenceOf(fields[5], '$.diagnostics').map((item) =>
      diagnosticFromValue(item, registry),
    );
    return QueryResultMessage.new(
      domain,
      role,
      matches,
      Completion.fromValueWithRegistry(fields[4], registry),
      diagnostics,
    );
  }
}

/** The `core.query-definition@1` wire schema discriminator. */
export const QUERY_DEFINITION_SCHEMA = 'core.query-definition@1';

/** Encodes `core.query-definition@1` (query.rs:532-559). */
export function queryDefinitionToValue(definition: QueryDefinition): ObjectValue {
  return objectValueFrom([
    { key: 'schema', value: stringValue(QUERY_DEFINITION_SCHEMA) },
    { key: 'domain_id', value: stringValue(definition.domain.id) },
    { key: 'domain_version', value: integerValue(BigInt(definition.domain.version)) },
    { key: 'selection', value: stringValue(definition.selection) },
    { key: 'expression', value: encodeQueryExpression(definition.expression, 0) },
  ]);
}

/** Strictly decodes `core.query-definition@1` (query.rs:561-598). */
export function queryDefinitionFromValue(value: PortableValue): QueryDefinition {
  const fields = exactObjectFields(
    value,
    ['schema', 'domain_id', 'domain_version', 'selection', 'expression'],
    QUERY_DEFINITION_SCHEMA,
  );
  const schema = fields[0];
  if (schema.kind !== 'String' || schema.value !== QUERY_DEFINITION_SCHEMA) {
    throw invalid('$.schema', 'invalid query definition schema');
  }
  if (fields[1].kind !== 'String') {
    throw invalid('$.domain_id', 'invalid query definition domain');
  }
  const domainVersion = queryUnsigned32(fields[2], 'domain_version');
  if (fields[3].kind !== 'String') {
    throw invalid('$.selection', 'invalid query definition selection');
  }
  const selection = parseQuerySelection(fields[3].value);
  const expression = decodeQueryExpression(fields[4], 0);
  return { domain: newQueryDomain(fields[1].value, domainVersion), expression, selection };
}

function encodeQueryExpression(expression: QueryExpression, depth: number): PortableValue {
  if (depth > 256) {
    throw invalid('$.expression', 'query expression nesting exceeds the protocol limit');
  }
  switch (expression.kind) {
    case 'Input':
      return objectValueFrom([{ key: 'kind', value: stringValue('Input') }]);
    case 'Apply':
      return objectValueFrom([
        { key: 'kind', value: stringValue('Apply') },
        { key: 'input', value: encodeQueryExpression(expression.input, depth + 1) },
        { key: 'operator', value: encodeOperator(expression.operator) },
      ]);
    case 'Concat':
    case 'StructureOrderMerge':
      return objectValueFrom([
        { key: 'kind', value: stringValue(expression.kind) },
        {
          key: 'branches',
          value: {
            kind: 'Sequence',
            items: expression.branches.map((branch) => encodeQueryExpression(branch, depth + 1)),
          },
        },
      ]);
  }
}

function encodeOperator(operator: OperatorCall): ObjectValue {
  const names = [...operator.arguments.keys()].sort();
  return objectValueFrom([
    { key: 'id', value: stringValue(operator.id) },
    { key: 'version', value: integerValue(BigInt(operator.version)) },
    {
      key: 'arguments',
      value: {
        kind: 'Object',
        entries: names.map((name) => ({ key: name, value: operator.arguments.get(name)! })),
      },
    },
  ]);
}

function decodeQueryExpression(value: PortableValue, depth: number): QueryExpression {
  if (depth > 256) {
    throw invalid('$.expression', 'query expression nesting exceeds the protocol limit');
  }
  if (value.kind !== 'Object') {
    throw invalid('$.expression', 'invalid query definition expression');
  }
  const entries = value.entries;
  const kind =
    entries[0]?.key === 'kind' && entries[0].value.kind === 'String'
      ? entries[0].value.value
      : undefined;
  if (kind === undefined) {
    throw invalid('$.expression.kind', 'invalid query definition expression');
  }
  switch (kind) {
    case 'Input':
      if (entries.length !== 1) {
        throw invalid('$.expression', 'invalid query definition expression');
      }
      return { kind: 'Input' };
    case 'Apply': {
      const fields = exactObjectFields(value, ['kind', 'input', 'operator'], 'Apply');
      return {
        kind: 'Apply',
        input: decodeQueryExpression(fields[1], depth + 1),
        operator: decodeOperator(fields[2]),
      };
    }
    case 'Concat':
    case 'StructureOrderMerge': {
      const fields = exactObjectFields(value, ['kind', 'branches'], kind);
      if (fields[1].kind !== 'Sequence') {
        throw invalid('$.expression.branches', 'invalid query definition expression');
      }
      return {
        kind,
        branches: fields[1].items.map((branch) => decodeQueryExpression(branch, depth + 1)),
      };
    }
    default:
      throw invalid('$.expression.kind', 'invalid query definition expression');
  }
}

function decodeOperator(value: PortableValue): OperatorCall {
  const fields = exactObjectFields(value, ['id', 'version', 'arguments'], 'operator');
  if (fields[0].kind !== 'String') {
    throw invalid('$.operator.id', 'invalid query definition operator');
  }
  const version = queryUnsigned32(fields[1], 'operator.version');
  const argumentsValue = objectOf(fields[2], '$.operator.arguments');
  const arguments_ = new Map<string, PortableValue>();
  for (const entry of argumentsValue.entries) {
    arguments_.set(entry.key, entry.value);
  }
  return { id: fields[0].value, version, arguments: arguments_ };
}

/** Strictly reads an Object with exactly the named fields in order. */
function exactObjectFields(
  value: PortableValue,
  names: readonly string[],
  context: string,
): PortableValue[] {
  if (value.kind !== 'Object') {
    throw invalid('$', `invalid query definition (${context})`);
  }
  const entries = value.entries;
  if (entries.length !== names.length) {
    throw invalid('$', `invalid query definition (${context})`);
  }
  for (let index = 0; index < names.length; index++) {
    if (entries[index].key !== names[index]) {
      throw invalid('$', `invalid query definition (${context})`);
    }
  }
  return entries.map((entry) => entry.value);
}

/** Requires an Integer field fitting uint32. */
function queryUnsigned32(value: PortableValue, name: string): number {
  if (value.kind !== 'Integer') {
    throw invalid(`$.${name}`, 'invalid query definition field');
  }
  const number = value.value;
  if (number < 0n || number > 0xffffffffn) {
    throw invalid(`$.${name}`, 'invalid query definition field');
  }
  return Number(number);
}

/** Parses one cardinality selection spelling (query.rs:600-608). */
function parseQuerySelection(text: string): QuerySelection {
  switch (text) {
    case 'All':
    case 'First':
    case 'Last':
    case 'ZeroOrOne':
    case 'RequireOne':
      return text;
    default:
      throw invalid('$.selection', 'invalid query definition selection');
  }
}

/** Encodes one protocol diagnostic in the result diagnostics sequence (diagnostic.ts:135-165). */
function diagnosticToValueOf(diagnostic: Diagnostic): PortableValue {
  return diagnosticToValue(diagnostic);
}

// Envelope payload dispatch (payload.rs:145-157): every query payload
// validates through its record decoder at module load.
registerPayloadValidator('core.query-result', 1, (payload, registry) => {
  QueryResultMessage.fromValueWithRegistry(payload, new ErrorCodeRegistry(registry.versionOf()));
});

registerPayloadValidator('core.query-definition', 1, (payload) => {
  queryDefinitionFromValue(payload);
});
