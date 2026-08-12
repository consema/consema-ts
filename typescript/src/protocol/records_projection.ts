/**
 * Projection request, report, provenance, and result wire records.
 *
 * authority: crates/consema-protocol/src/projection.rs — ProjectionRequestMessage
 * (:89-230), ProvenanceMapMessage (:313-392), ProjectionReportMessage
 * (:439-515), ProjectionResultMessage (:517-683); the Python transcription
 * (consema/conformance/protocol_records.py) is the runner-side
 * cross-reference. The value-path/association-location records come from
 * records_value_path.ts (already implemented).
 *
 * Design (TypeScript-idiomatic): plain records with validated static
 * factories; every record self-registers its full decoder with the envelope
 * payload dispatch (payload.rs:133-144). The registry descriptor records
 * (capability-declaration / profile-descriptor / registry-manifest) are owned
 * by the frozen registry_descriptor.ts; their dispatch rows (payload.rs:35,
 * 129, 158) are registered here at module load so the common envelope
 * validates descriptor payloads.
 */

import type { ObjectValue, PortableValue } from '../core/value.ts';
import { stringValue, integerValue, booleanValue, nullValue } from '../core/value.ts';
import {
  exactFields,
  schemaFields,
  stringOf,
  sequenceOf,
  unsigned64,
  unsigned32,
  signed32,
  objectOf,
  objectValueFrom,
} from './records.ts';
import { invalid, protocolError } from './errors.ts';
import { ErrorCodeRegistry } from './error_registry.ts';
import { registerPayloadValidator } from './payload_validators.ts';
import { ValuePath, AssociationLocation } from './records_value_path.ts';
import type { SourceLocation, Diagnostic } from './diagnostic.ts';
import { diagnosticFromValue, diagnosticToValue } from './diagnostic.ts';
import type { QueryDefinition } from './query.ts';
import { validateQuery } from './query.ts';
import { queryDefinitionToValue, queryDefinitionFromValue } from './records_query.ts';
import { Completion } from './records_execution.ts';
import { equal as coreEqual } from '../core/equal.ts';
import {
  capabilityDeclarationFromValue,
  profileDescriptorFromValue,
  registryManifestFromValue,
} from './registry_descriptor.ts';

/** A versioned policy contract reference with deterministic arguments (projection.rs:19-47). */
export class ProjectionPolicy {
  readonly contract: { readonly id: string; readonly version: number };
  /** Deterministically sorted arguments; values may be ANY PortableValue kind. */
  readonly arguments: ReadonlyMap<string, PortableValue>;

  constructor(contract: { readonly id: string; readonly version: number }, arguments_: ReadonlyMap<string, PortableValue>) {
    this.contract = contract;
    this.arguments = new Map(arguments_);
  }

  /** Equality over the contract reference and the argument values. */
  equal(other: ProjectionPolicy): boolean {
    if (
      this.contract.id !== other.contract.id ||
      this.contract.version !== other.contract.version ||
      this.arguments.size !== other.arguments.size
    ) {
      return false;
    }
    for (const [name, value] of this.arguments) {
      const that = other.arguments.get(name);
      if (that === undefined || !coreEqual(value, that)) {
        return false;
      }
    }
    return true;
  }

  /** Encodes the `{id, version, arguments}` policy reference (projection.rs:726-741). */
  toValue(): ObjectValue {
    const names = [...this.arguments.keys()].sort();
    return objectValueFrom([
      { key: 'id', value: stringValue(this.contract.id) },
      { key: 'version', value: integerValue(BigInt(this.contract.version)) },
      {
        key: 'arguments',
        value: {
          kind: 'Object',
          entries: names.map((name) => ({ key: name, value: this.arguments.get(name)! })),
        },
      },
    ]);
  }

  /** Strictly decodes one policy reference (projection.rs:743-763; contract.rs:20-30). */
  static fromValue(value: PortableValue, path: string): ProjectionPolicy {
    const fields = exactFields(value, ['id', 'version', 'arguments'], path);
    const id = stringOf(fields[0], `${path}.id`);
    const version = unsigned32(fields[1], `${path}.version`);
    if (version === 0) {
      throw invalid(`${path}.version`, 'version must be non-zero');
    }
    const argumentsValue = objectOf(fields[2], `${path}.arguments`);
    const arguments_ = new Map<string, PortableValue>();
    for (const entry of argumentsValue.entries) {
      arguments_.set(entry.key, entry.value);
    }
    return new ProjectionPolicy({ id, version }, arguments_);
  }
}

/** Transferable projection rule scope (projection.rs:49-74). */
export class ProjectionScope {
  readonly kind: 'Global' | 'ExactNativePath' | 'ResolvedQuery';
  /** Exact caller-defined native path scope source ID. */
  readonly sourceId: string | null;
  /** Format-native path contract string. */
  readonly path: string | null;
  /** Scope resolved by a complete QueryDefinition. */
  readonly query: QueryDefinition | null;

  private constructor(
    kind: 'Global' | 'ExactNativePath' | 'ResolvedQuery',
    sourceId: string | null,
    path: string | null,
    query: QueryDefinition | null,
  ) {
    this.kind = kind;
    this.sourceId = sourceId;
    this.path = path;
    this.query = query;
  }

  /** The complete-target scope. */
  static global(): ProjectionScope {
    return new ProjectionScope('Global', null, null, null);
  }

  /** An exact caller-defined native path in one stable source. */
  static exactNativePath(sourceId: string, path: string): ProjectionScope {
    return new ProjectionScope('ExactNativePath', sourceId, path, null);
  }

  /** A scope resolved by a complete QueryDefinition. */
  static resolvedQuery(query: QueryDefinition): ProjectionScope {
    return new ProjectionScope('ResolvedQuery', null, null, query);
  }

  /** Encodes the scope (projection.rs:765-783). */
  toValue(): ObjectValue {
    switch (this.kind) {
      case 'Global':
        return objectValueFrom([{ key: 'kind', value: stringValue('Global') }]);
      case 'ExactNativePath':
        return objectValueFrom([
          { key: 'kind', value: stringValue('ExactNativePath') },
          { key: 'source_id', value: stringValue(this.sourceId!) },
          { key: 'path', value: stringValue(this.path!) },
        ]);
      case 'ResolvedQuery':
        return objectValueFrom([
          { key: 'kind', value: stringValue('ResolvedQuery') },
          { key: 'query', value: queryDefinitionToValue(this.query!) },
        ]);
    }
  }

  /** Strictly decodes one scope (projection.rs:785-819). */
  static fromValue(value: PortableValue, path: string): ProjectionScope {
    if (value.kind !== 'Object' || value.entries.length === 0) {
      throw protocolError('WrongType', path, 'expected scope Object');
    }
    const entries = value.entries;
    if (entries[0].key !== 'kind') {
      throw invalid(path, 'scope kind must be first');
    }
    const kind = stringOf(entries[0].value, `${path}.kind`);
    switch (kind) {
      case 'Global':
        exactFields(value, ['kind'], path);
        return ProjectionScope.global();
      case 'ExactNativePath': {
        const fields = exactFields(value, ['kind', 'source_id', 'path'], path);
        return ProjectionScope.exactNativePath(
          stringOf(fields[1], `${path}.source_id`),
          stringOf(fields[2], `${path}.path`),
        );
      }
      case 'ResolvedQuery': {
        const fields = exactFields(value, ['kind', 'query'], path);
        return ProjectionScope.resolvedQuery(queryDefinitionFromValue(fields[1]));
      }
      default:
        throw invalid(path, 'unknown projection scope');
    }
  }
}

/** Equality over one transferable scope (the Rust derived equality). */
export function projectionScopesEqual(left: ProjectionScope, right: ProjectionScope): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case 'Global':
      return true;
    case 'ExactNativePath':
      return left.sourceId === right.sourceId && left.path === right.path;
    case 'ResolvedQuery':
      if (left.query === null || right.query === null) {
        return left.query === right.query;
      }
      return coreEqual(queryDefinitionToValue(left.query), queryDefinitionToValue(right.query));
  }
}

/** One auditable scoped projection policy rule (projection.rs:76-87). */
export class ProjectionRule {
  readonly ruleId: string;
  readonly scope: ProjectionScope;
  readonly priority: number;
  readonly policy: ProjectionPolicy;

  constructor(ruleId: string, scope: ProjectionScope, priority: number, policy: ProjectionPolicy) {
    this.ruleId = ruleId;
    this.scope = scope;
    this.priority = priority;
    this.policy = policy;
  }

  /** Encodes one rule (projection.rs:821-831). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'rule_id', value: stringValue(this.ruleId) },
      { key: 'scope', value: this.scope.toValue() },
      { key: 'priority', value: integerValue(BigInt(this.priority)) },
      { key: 'policy', value: this.policy.toValue() },
    ]);
  }

  /** Strictly decodes one rule (projection.rs:833-841). */
  static fromValue(value: PortableValue, path: string): ProjectionRule {
    const fields = exactFields(value, ['rule_id', 'scope', 'priority', 'policy'], path);
    return new ProjectionRule(
      stringOf(fields[0], `${path}.rule_id`),
      ProjectionScope.fromValue(fields[1], `${path}.scope`),
      signed32(fields[2], `${path}.priority`),
      ProjectionPolicy.fromValue(fields[3], `${path}.policy`),
    );
  }
}

/** The `core.projection-request@1` record (projection.rs:89-97). */
export class ProjectionRequestMessage {
  readonly target: { readonly id: string; readonly version: number };
  readonly defaultPolicy: ProjectionPolicy;
  readonly rules: readonly ProjectionRule[];
  readonly limits: ReadonlyMap<string, bigint>;

  private constructor(
    target: { readonly id: string; readonly version: number },
    defaultPolicy: ProjectionPolicy,
    rules: readonly ProjectionRule[],
    limits: ReadonlyMap<string, bigint>,
  ) {
    this.target = target;
    this.defaultPolicy = defaultPolicy;
    this.rules = Object.freeze([...rules]);
    this.limits = new Map(limits);
  }

  /** Validates rule IDs, portable scopes, and semantic conflicts (projection.rs:98-148). */
  static new(
    target: { readonly id: string; readonly version: number },
    defaultPolicy: ProjectionPolicy,
    rules: readonly ProjectionRule[],
    limits: ReadonlyMap<string, bigint>,
  ): ProjectionRequestMessage {
    const ruleIds = new Set<string>();
    for (const rule of rules) {
      if (rule.ruleId === '' || rule.ruleId.length > 255 || ruleIds.has(rule.ruleId)) {
        throw invalid('$.rules', 'rule IDs must be non-empty and unique');
      }
      ruleIds.add(rule.ruleId);
      validateScope(rule.scope);
    }
    for (let index = 0; index < rules.length; index++) {
      for (let other = index + 1; other < rules.length; other++) {
        if (
          rules[index].priority === rules[other].priority &&
          projectionScopesEqual(rules[index].scope, rules[other].scope) &&
          !rules[index].policy.equal(rules[other].policy)
        ) {
          throw invalid('$.rules', 'same-scope same-priority policies conflict');
        }
      }
    }
    for (const name of limits.keys()) {
      if (!validLimitName(name)) {
        throw invalid('$.limits', 'limit names must be stable lowercase identifiers');
      }
    }
    return new ProjectionRequestMessage(target, defaultPolicy, rules, limits);
  }

  /** Encodes `core.projection-request@1` (projection.rs:175-194). */
  toValue(): ObjectValue {
    const names = [...this.limits.keys()].sort();
    return objectValueFrom([
      { key: 'schema', value: stringValue('core.projection-request@1') },
      { key: 'target', value: referenceValue(this.target) },
      { key: 'default_policy', value: this.defaultPolicy.toValue() },
      { key: 'rules', value: { kind: 'Sequence', items: this.rules.map((rule) => rule.toValue()) } },
      {
        key: 'limits',
        value: {
          kind: 'Object',
          entries: names.map((name) => ({ key: name, value: integerValue(this.limits.get(name)!) })),
        },
      },
    ]);
  }

  /** Strictly decodes `core.projection-request@1` (projection.rs:197-229). */
  static fromValue(value: PortableValue): ProjectionRequestMessage {
    const fields = schemaFields(
      value,
      'core.projection-request@1',
      ['target', 'default_policy', 'rules', 'limits'],
      '$',
    );
    const rules = sequenceOf(fields[2], '$.rules').map((item, index) =>
      ProjectionRule.fromValue(item, `$.rules[${index}]`),
    );
    const limitsValue = objectOf(fields[3], '$.limits');
    const limits = new Map<string, bigint>();
    for (const entry of limitsValue.entries) {
      limits.set(entry.key, unsigned64(entry.value, `$.limits.${entry.key}`));
    }
    return ProjectionRequestMessage.new(
      parseReference(fields[0], '$.target'),
      ProjectionPolicy.fromValue(fields[1], '$.default_policy'),
      rules,
      limits,
    );
  }
}

/** Validates one portable rule scope (projection.rs:685-706). */
function validateScope(scope: ProjectionScope): void {
  switch (scope.kind) {
    case 'Global':
      return;
    case 'ExactNativePath':
      if (
        scope.sourceId === null ||
        scope.sourceId === '' ||
        scope.sourceId.length > 1024 ||
        scope.path === null ||
        scope.path === '' ||
        scope.path.length > 4096
      ) {
        throw invalid('$.scope', 'invalid exact native path scope');
      }
      return;
    case 'ResolvedQuery':
      if (scope.query === null || 'failure' in validateQuery(scope.query)) {
        throw invalid('$.scope.query', 'invalid query scope');
      }
      return;
  }
}

/** The provenance relationship from source fact to projected fact (projection.rs:241-254). */
export type ProvenanceRelation = 'Direct' | 'Derived' | 'Expanded' | 'Merged' | 'Generated';

/** Transferable source origin with stable external identities (projection.rs:256-269). */
export class SourceOriginMessage {
  readonly sourceId: string;
  readonly nodeLocator: string | null;
  readonly startByte: bigint;
  readonly endByte: bigint;
  readonly relation: ProvenanceRelation;

  private constructor(
    sourceId: string,
    nodeLocator: string | null,
    startByte: bigint,
    endByte: bigint,
    relation: ProvenanceRelation,
  ) {
    this.sourceId = sourceId;
    this.nodeLocator = nodeLocator;
    this.startByte = startByte;
    this.endByte = endByte;
    this.relation = relation;
  }

  /** Validates a transferable source origin (projection.rs:271-300). */
  static new(
    sourceId: string,
    nodeLocator: string | null,
    startByte: bigint,
    endByte: bigint,
    relation: ProvenanceRelation,
  ): SourceOriginMessage {
    if (
      sourceId === '' ||
      sourceId.length > 1024 ||
      startByte > endByte ||
      (nodeLocator !== null && (nodeLocator === '' || nodeLocator.length > 4096))
    ) {
      throw invalid('$.origin', 'invalid source identity, locator, or range');
    }
    return new SourceOriginMessage(sourceId, nodeLocator, startByte, endByte, relation);
  }

  /** Encodes one origin (projection.rs:871-888). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'source_id', value: stringValue(this.sourceId) },
      { key: 'node_locator', value: nullableStringValue(this.nodeLocator) },
      { key: 'start_byte', value: integerValue(this.startByte) },
      { key: 'end_byte', value: integerValue(this.endByte) },
      { key: 'relation', value: stringValue(this.relation) },
    ]);
  }

  /** Strictly decodes one origin (projection.rs:890-909). */
  static fromValue(value: PortableValue, path: string): SourceOriginMessage {
    const fields = exactFields(
      value,
      ['source_id', 'node_locator', 'start_byte', 'end_byte', 'relation'],
      path,
    );
    return SourceOriginMessage.new(
      stringOf(fields[0], `${path}.source_id`),
      nullableStringOfValue(fields[1], `${path}.node_locator`),
      unsigned64(fields[2], `${path}.start_byte`),
      unsigned64(fields[3], `${path}.end_byte`),
      parseRelation(stringOf(fields[4], `${path}.relation`), `${path}.relation`),
    );
  }
}

/** A projected value or association location (projection.rs:232-239). */
export class ProjectedLocationMessage {
  readonly kind: 'ValuePath' | 'AssociationLocation';
  readonly path: ValuePath | null;
  readonly association: AssociationLocation | null;

  constructor(
    kind: 'ValuePath' | 'AssociationLocation',
    path: ValuePath | null,
    association: AssociationLocation | null,
  ) {
    this.kind = kind;
    this.path = path;
    this.association = association;
  }

  /** The canonical ordering of the record (kind, then location). */
  less(other: ProjectedLocationMessage): boolean {
    if (this.kind !== other.kind) {
      return this.kind < other.kind;
    }
    if (this.kind === 'AssociationLocation') {
      return this.association!.less(other.association!);
    }
    return this.path!.less(other.path!);
  }

  /** Ordered equality. */
  equal(other: ProjectedLocationMessage): boolean {
    if (this.kind !== other.kind) {
      return false;
    }
    if (this.kind === 'AssociationLocation') {
      return this.association!.equal(other.association!);
    }
    return this.path!.equal(other.path!);
  }

  /** Encodes the kind-first location record (projection.rs:843-854). */
  toValue(): ObjectValue {
    if (this.kind === 'ValuePath') {
      return objectValueFrom([
        { key: 'kind', value: stringValue('ValuePath') },
        { key: 'value', value: this.path!.toValue() },
      ]);
    }
    return objectValueFrom([
      { key: 'kind', value: stringValue('AssociationLocation') },
      { key: 'value', value: this.association!.toValue() },
    ]);
  }

  /** Strictly decodes one projected location (projection.rs:856-869). */
  static fromValue(value: PortableValue, path: string): ProjectedLocationMessage {
    const fields = exactFields(value, ['kind', 'value'], path);
    const kind = stringOf(fields[0], `${path}.kind`);
    switch (kind) {
      case 'ValuePath':
        return new ProjectedLocationMessage('ValuePath', ValuePath.fromValue(fields[1]), null);
      case 'AssociationLocation':
        return new ProjectedLocationMessage('AssociationLocation', null, AssociationLocation.fromValue(fields[1]));
      default:
        throw invalid(path, 'unknown projected location');
    }
  }
}

/** One projected location and all of its source origins (projection.rs:312-319). */
export class ProvenanceEntryMessage {
  readonly projected: ProjectedLocationMessage;
  readonly origins: readonly SourceOriginMessage[];

  constructor(projected: ProjectedLocationMessage, origins: readonly SourceOriginMessage[]) {
    this.projected = projected;
    this.origins = Object.freeze([...origins]);
  }
}

/** The sorted unique `core.provenance-map@1` record (projection.rs:321-326). */
export class ProvenanceMapMessage {
  readonly entries: readonly ProvenanceEntryMessage[];

  private constructor(entries: readonly ProvenanceEntryMessage[]) {
    this.entries = Object.freeze([...entries]);
  }

  /** The empty provenance map. */
  static default(): ProvenanceMapMessage {
    return new ProvenanceMapMessage([]);
  }

  /** Validates sorted unique projected locations and non-empty origins (projection.rs:327-341). */
  static new(entries: readonly ProvenanceEntryMessage[]): ProvenanceMapMessage {
    for (const entry of entries) {
      if (entry.origins.length === 0) {
        throw invalid('$.entries', 'provenance locations must be sorted, unique, and have origins');
      }
    }
    for (let index = 1; index < entries.length; index++) {
      if (!entries[index - 1].projected.less(entries[index].projected)) {
        throw invalid('$.entries', 'provenance locations must be sorted, unique, and have origins');
      }
    }
    return new ProvenanceMapMessage(entries);
  }

  /** Encodes `core.provenance-map@1` (projection.rs:350-367). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: stringValue('core.provenance-map@1') },
      {
        key: 'entries',
        value: {
          kind: 'Sequence',
          items: this.entries.map((entry) =>
            objectValueFrom([
              { key: 'projected', value: entry.projected.toValue() },
              {
                key: 'origins',
                value: { kind: 'Sequence', items: entry.origins.map((origin) => origin.toValue()) },
              },
            ]),
          ),
        },
      },
    ]);
  }

  /** Strictly decodes `core.provenance-map@1` (projection.rs:370-391). */
  static fromValue(value: PortableValue): ProvenanceMapMessage {
    const fields = schemaFields(value, 'core.provenance-map@1', ['entries'], '$');
    const entries = sequenceOf(fields[0], '$.entries').map((entryValue, index) => {
      const path = `$.entries[${index}]`;
      const entryFields = exactFields(entryValue, ['projected', 'origins'], path);
      const projected = ProjectedLocationMessage.fromValue(entryFields[0], `${path}.projected`);
      const origins = sequenceOf(entryFields[1], `${path}.origins`).map((origin, originIndex) =>
        SourceOriginMessage.fromValue(origin, `${path}.origins[${originIndex}]`),
      );
      return new ProvenanceEntryMessage(projected, origins);
    });
    return ProvenanceMapMessage.new(entries);
  }
}

/** Event loss classification independent from reversibility (projection.rs:405-414). */
export type LossClassification = 'None' | 'Reversible' | 'Lossy';

/** One machine-readable projection report event (projection.rs:416-437). */
export class ProjectionEventMessage {
  readonly code: string;
  readonly policyRuleId: string | null;
  readonly sourceLocations: readonly SourceLocation[];
  readonly projectedLocation: ProjectedLocationMessage | null;
  readonly oldCategory: string | null;
  readonly newCategory: string | null;
  readonly reversible: boolean;
  readonly lossClassification: LossClassification;
  readonly arguments: ReadonlyMap<string, string>;

  constructor(options: {
    code: string;
    policyRuleId?: string | null;
    sourceLocations?: readonly SourceLocation[];
    projectedLocation?: ProjectedLocationMessage | null;
    oldCategory?: string | null;
    newCategory?: string | null;
    reversible?: boolean;
    lossClassification?: LossClassification;
    arguments?: ReadonlyMap<string, string> | null;
  }) {
    this.code = options.code;
    this.policyRuleId = options.policyRuleId ?? null;
    this.sourceLocations = Object.freeze([...(options.sourceLocations ?? [])]);
    this.projectedLocation = options.projectedLocation ?? null;
    this.oldCategory = options.oldCategory ?? null;
    this.newCategory = options.newCategory ?? null;
    this.reversible = options.reversible ?? false;
    this.lossClassification = options.lossClassification ?? 'None';
    this.arguments = new Map(options.arguments ?? []);
  }

  /** Encodes one event (projection.rs:911-955). */
  toValue(): ObjectValue {
    const names = [...this.arguments.keys()].sort();
    return objectValueFrom([
      { key: 'code', value: stringValue(this.code) },
      { key: 'policy_rule_id', value: nullableStringValue(this.policyRuleId) },
      {
        key: 'source_locations',
        value: {
          kind: 'Sequence',
          items: this.sourceLocations.map((location) =>
            objectValueFrom([
              { key: 'source_id', value: stringValue(location.sourceId) },
              { key: 'start_byte', value: integerValue(location.startByte) },
              { key: 'end_byte', value: integerValue(location.endByte) },
            ]),
          ),
        },
      },
      {
        key: 'projected_location',
        value: this.projectedLocation === null ? nullValue() : this.projectedLocation.toValue(),
      },
      { key: 'old_category', value: nullableStringValue(this.oldCategory) },
      { key: 'new_category', value: nullableStringValue(this.newCategory) },
      { key: 'reversible', value: booleanValue(this.reversible) },
      { key: 'loss_classification', value: stringValue(this.lossClassification) },
      {
        key: 'arguments',
        value: {
          kind: 'Object',
          entries: names.map((name) => ({ key: name, value: stringValue(this.arguments.get(name)!) })),
        },
      },
    ]);
  }

  /** Strictly decodes one event (projection.rs:957-1029). */
  static fromValue(value: PortableValue, path: string): ProjectionEventMessage {
    const fields = exactFields(
      value,
      [
        'code',
        'policy_rule_id',
        'source_locations',
        'projected_location',
        'old_category',
        'new_category',
        'reversible',
        'loss_classification',
        'arguments',
      ],
      path,
    );
    const sourceLocations = sequenceOf(fields[2], `${path}.source_locations`).map((item, index) => {
      const locationPath = `${path}.source_locations[${index}]`;
      const locationFields = exactFields(item, ['source_id', 'start_byte', 'end_byte'], locationPath);
      return {
        sourceId: stringOf(locationFields[0], `${locationPath}.source_id`),
        startByte: unsigned64(locationFields[1], `${locationPath}.start_byte`),
        endByte: unsigned64(locationFields[2], `${locationPath}.end_byte`),
      };
    });
    const projectedLocation =
      fields[3].kind === 'Null'
        ? null
        : ProjectedLocationMessage.fromValue(fields[3], `${path}.projected_location`);
    const argumentsObject = objectOf(fields[8], `${path}.arguments`);
    const arguments_ = new Map<string, string>();
    for (const entry of argumentsObject.entries) {
      arguments_.set(entry.key, stringOf(entry.value, `${path}.arguments.${entry.key}`));
    }
    return new ProjectionEventMessage({
      code: stringOf(fields[0], `${path}.code`),
      policyRuleId: nullableStringOfValue(fields[1], `${path}.policy_rule_id`),
      sourceLocations,
      projectedLocation,
      oldCategory: nullableStringOfValue(fields[4], `${path}.old_category`),
      newCategory: nullableStringOfValue(fields[5], `${path}.new_category`),
      reversible: booleanOfValue(fields[6], `${path}.reversible`),
      lossClassification: parseLoss(stringOf(fields[7], `${path}.loss_classification`), `${path}.loss_classification`),
      arguments: arguments_,
    });
  }
}

/** The ordered `core.projection-report@1` record (projection.rs:439-444). */
export class ProjectionReportMessage {
  readonly events: readonly ProjectionEventMessage[];

  private constructor(events: readonly ProjectionEventMessage[]) {
    this.events = Object.freeze([...events]);
  }

  /** The empty report. */
  static default(): ProjectionReportMessage {
    return new ProjectionReportMessage([]);
  }

  /** Validates event cross-field invariants against the v1 registry (projection.rs:445-449). */
  static new(events: readonly ProjectionEventMessage[]): ProjectionReportMessage {
    return ProjectionReportMessage.newWithRegistry(events, new ErrorCodeRegistry(1));
  }

  /** Validates events under one explicit semantic-model error registry (projection.rs:451-471). */
  static newWithRegistry(
    events: readonly ProjectionEventMessage[],
    registry: ErrorCodeRegistry,
  ): ProjectionReportMessage {
    for (const event of events) {
      validateRegisteredCode(registry, event.code, '$.events.code');
    }
    for (const event of events) {
      if (
        event.code === '' ||
        (event.lossClassification === 'Lossy' && event.reversible) ||
        (event.lossClassification === 'Reversible' && !event.reversible)
      ) {
        throw invalid('$.events', 'projection event fields are contradictory');
      }
    }
    return new ProjectionReportMessage(events);
  }

  /** Encodes `core.projection-report@1` (projection.rs:479-490). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: stringValue('core.projection-report@1') },
      { key: 'events', value: { kind: 'Sequence', items: this.events.map((event) => event.toValue()) } },
    ]);
  }

  /** Strictly decodes `core.projection-report@1` under the v1 registry (projection.rs:492-495). */
  static fromValue(value: PortableValue): ProjectionReportMessage {
    return ProjectionReportMessage.fromValueWithRegistry(value, new ErrorCodeRegistry(1));
  }

  /** Strictly decodes a report under one explicit registry (projection.rs:498-514). */
  static fromValueWithRegistry(value: PortableValue, registry: ErrorCodeRegistry): ProjectionReportMessage {
    const fields = schemaFields(value, 'core.projection-report@1', ['events'], '$');
    const events = sequenceOf(fields[0], '$.events').map((item, index) =>
      ProjectionEventMessage.fromValue(item, `$.events[${index}]`),
    );
    return ProjectionReportMessage.newWithRegistry(events, registry);
  }
}

/** Projection fidelity classification (projection.rs:394-403). */
export type ProjectionFidelity = 'Exact' | 'Transformed' | 'Lossy';

/** The complete or explicitly failed `core.projection-result@1` record (projection.rs:517-527). */
export class ProjectionResultMessage {
  readonly completion: Completion;
  readonly value: PortableValue | null;
  readonly hasValue: boolean;
  readonly fidelity: ProjectionFidelity | null;
  readonly report: ProjectionReportMessage;
  readonly provenance: ProvenanceMapMessage;
  readonly diagnostics: readonly Diagnostic[];

  private constructor(
    completion: Completion,
    value: PortableValue | null,
    hasValue: boolean,
    fidelity: ProjectionFidelity | null,
    report: ProjectionReportMessage,
    provenance: ProvenanceMapMessage,
    diagnostics: readonly Diagnostic[],
  ) {
    this.completion = completion;
    this.value = value;
    this.hasValue = hasValue;
    this.fidelity = fidelity;
    this.report = report;
    this.provenance = provenance;
    this.diagnostics = Object.freeze([...diagnostics]);
  }

  /** Validates success/value/fidelity and loss-report invariants (projection.rs:528-570). */
  static new(
    completion: Completion,
    value: PortableValue | null,
    hasValue: boolean,
    fidelity: ProjectionFidelity | null,
    report: ProjectionReportMessage,
    provenance: ProvenanceMapMessage,
    diagnostics: readonly Diagnostic[],
  ): ProjectionResultMessage {
    const success = completion.status === 'Success';
    if (success !== hasValue || (success && fidelity === null) || (!success && fidelity !== null)) {
      throw invalid('$', 'only successful projection may carry value and fidelity');
    }
    if (fidelity === 'Lossy' && !report.events.some((event) => event.lossClassification === 'Lossy')) {
      throw invalid('$.report', 'Lossy fidelity requires an explicit lossy event');
    }
    if (!success && provenance.entries.length > 0) {
      throw invalid('$.provenance', 'failed projection cannot claim completed provenance');
    }
    return new ProjectionResultMessage(completion, value, hasValue, fidelity, report, provenance, diagnostics);
  }

  /** Encodes `core.projection-result@1` (projection.rs:609-636). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: stringValue('core.projection-result@1') },
      { key: 'completion', value: this.completion.toValue() },
      {
        key: 'value',
        value: this.hasValue
          ? objectValueFrom([{ key: 'portable_value', value: this.value! }])
          : nullValue(),
      },
      { key: 'fidelity', value: this.fidelity === null ? nullValue() : stringValue(this.fidelity) },
      { key: 'report', value: this.report.toValue() },
      { key: 'provenance', value: this.provenance.toValue() },
      {
        key: 'diagnostics',
        value: { kind: 'Sequence', items: this.diagnostics.map((diagnostic) => diagnosticToValueOf(diagnostic)) },
      },
    ]);
  }

  /** Strictly decodes `core.projection-result@1` under the v1 registry (projection.rs:638-641). */
  static fromValue(value: PortableValue): ProjectionResultMessage {
    return ProjectionResultMessage.fromValueWithRegistry(value, new ErrorCodeRegistry(1));
  }

  /** Strictly decodes terminal facts under one explicit registry (projection.rs:644-682). */
  static fromValueWithRegistry(value: PortableValue, registry: ErrorCodeRegistry): ProjectionResultMessage {
    const fields = schemaFields(
      value,
      'core.projection-result@1',
      ['completion', 'value', 'fidelity', 'report', 'provenance', 'diagnostics'],
      '$',
    );
    let projected: PortableValue | null = null;
    let hasValue = false;
    if (fields[1].kind !== 'Null') {
      projected = exactFields(fields[1], ['portable_value'], '$.value')[0];
      hasValue = true;
    }
    let fidelity: ProjectionFidelity | null = null;
    if (fields[2].kind !== 'Null') {
      fidelity = parseFidelity(stringOf(fields[2], '$.fidelity'));
    }
    const diagnostics = sequenceOf(fields[5], '$.diagnostics').map((item) =>
      diagnosticFromValue(item, registry),
    );
    return ProjectionResultMessage.new(
      Completion.fromValueWithRegistry(fields[0], registry),
      projected,
      hasValue,
      fidelity,
      ProjectionReportMessage.fromValueWithRegistry(fields[3], registry),
      ProvenanceMapMessage.fromValue(fields[4]),
      diagnostics,
    );
  }
}

/** The canonical `{id, version}` reference record (projection.rs:708-716). */
function referenceValue(contract: { readonly id: string; readonly version: number }): ObjectValue {
  return objectValueFrom([
    { key: 'id', value: stringValue(contract.id) },
    { key: 'version', value: integerValue(BigInt(contract.version)) },
  ]);
}

/** Parses a `{id, version}` reference record (projection.rs:718-724; contract.rs:20-30). */
function parseReference(
  value: PortableValue,
  path: string,
): { readonly id: string; readonly version: number } {
  const fields = exactFields(value, ['id', 'version'], path);
  const id = stringOf(fields[0], `${path}.id`);
  const version = unsigned32(fields[1], `${path}.version`);
  if (version === 0) {
    throw invalid(`${path}.version`, 'version must be non-zero');
  }
  return { id, version };
}

/** Parses one provenance relation spelling (projection.rs:1041-1053). */
function parseRelation(text: string, path: string): ProvenanceRelation {
  switch (text) {
    case 'Direct':
    case 'Derived':
    case 'Expanded':
    case 'Merged':
    case 'Generated':
      return text;
    default:
      throw invalid(path, 'unknown provenance relation');
  }
}

/** Parses one loss-classification spelling (projection.rs:1083-1093). */
function parseLoss(text: string, path: string): LossClassification {
  switch (text) {
    case 'None':
    case 'Reversible':
    case 'Lossy':
      return text;
    default:
      throw invalid(path, 'unknown loss classification');
  }
}

/** Parses one fidelity spelling (projection.rs:1063-1073). */
function parseFidelity(text: string): ProjectionFidelity {
  switch (text) {
    case 'Exact':
    case 'Transformed':
    case 'Lossy':
      return text;
    default:
      throw invalid('$.fidelity', 'unknown projection fidelity');
  }
}

/** The stable lowercase limit-name rule (projection.rs:1095-1101). */
function validLimitName(name: string): boolean {
  if (name === '' || name.length > 255) {
    return false;
  }
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    const lower = code >= 0x61 && code <= 0x7a;
    const digit = code >= 0x30 && code <= 0x39;
    if (!lower && !digit && code !== 0x5f && code !== 0x2d) {
      return false;
    }
  }
  return true;
}

/**
 * Rejects an unregistered public code with the frozen InvalidValue rejection
 * (error_registry.rs:1500-1510; the registry helper itself throws a plain
 * Error, so the record boundary converts it).
 */
function validateRegisteredCode(registry: ErrorCodeRegistry, code: string, path: string): void {
  try {
    registry.validateAt(code, path);
  } catch {
    throw invalid(path, `unregistered public code: ${code}`);
  }
}

/** The Null singleton or a String leaf of an optional string field. */
function nullableStringValue(value: string | null): PortableValue {
  return value === null ? nullValue() : stringValue(value);
}

/** Strictly reads an optional string field. */
function nullableStringOfValue(value: PortableValue, path: string): string | null {
  return value.kind === 'Null' ? null : stringOf(value, path);
}

/** Strictly reads a Boolean field. */
function booleanOfValue(value: PortableValue, path: string): boolean {
  if (value.kind !== 'Boolean') {
    throw protocolError('WrongType', path, 'expected Boolean');
  }
  return value.value;
}

/** Encodes one protocol diagnostic in the result diagnostics sequence (diagnostic.ts:135-165). */
function diagnosticToValueOf(diagnostic: Diagnostic): PortableValue {
  return diagnosticToValue(diagnostic);
}

// Envelope payload dispatch (payload.rs:133-144): every projection and
// provenance payload validates through its record decoder at module load.
registerPayloadValidator('core.projection-request', 1, (payload) => {
  ProjectionRequestMessage.fromValue(payload);
});

registerPayloadValidator('core.projection-report', 1, (payload, registry) => {
  ProjectionReportMessage.fromValueWithRegistry(payload, new ErrorCodeRegistry(registry.versionOf()));
});

registerPayloadValidator('core.projection-result', 1, (payload, registry) => {
  ProjectionResultMessage.fromValueWithRegistry(payload, new ErrorCodeRegistry(registry.versionOf()));
});

registerPayloadValidator('core.provenance-map', 1, (payload) => {
  ProvenanceMapMessage.fromValue(payload);
});

// The registry descriptor dispatch rows (payload.rs:35, 129, 158). The
// descriptor decoders live in the frozen registry_descriptor.ts; their
// envelope registration lives here so the common envelope validates
// descriptor payloads exactly like the Rust dispatch.
registerPayloadValidator('core.capability-declaration', 1, (payload) => {
  capabilityDeclarationFromValue(payload);
});

registerPayloadValidator('core.profile-descriptor', 1, (payload) => {
  profileDescriptorFromValue(payload);
});

registerPayloadValidator('core.registry-manifest', 1, (payload) => {
  registryManifestFromValue(payload);
});
