/**
 * QueryDefinition validation and binding.
 *
 * authority: the operator table of crates/consema-core/src/query.rs:899-1897
 * (transcribed into go/protocol/query_validate.go, cross-reference); the
 * domain input roles (query.rs:502-523); the syntax-kind and value-kind
 * vocabularies (query.rs:1900-2209). The vectors pin the failure names in
 * conformance/vectors/v1.json (query.reject-role-mismatch) and the
 * protocol-v1.json query round trips. The required capability set of a
 * validated query is always [core.query.ordered-results@1] (query.rs:278-293).
 *
 * Design (TypeScript-idiomatic): the domain/operator table is data (a
 * Map keyed by "domain/operator"); validation is a pure function returning
 * either the output role or a typed QueryFailure carrying the frozen code.
 */

import type { PortableValue } from '../core/value.ts';
import { CapabilitySet } from './registry_descriptor.ts';
import type { CapabilityId } from './registry_descriptor.ts';

/** The closed match-role vocabulary (consema-core query.rs:169-316). */
export type MatchRole =
  | 'Value'
  | 'ObjectEntry'
  | 'EntryMappingEntry'
  | 'JsonValue'
  | 'JsonObjectMember'
  | 'JsonArrayElement'
  | 'TomlItem'
  | 'TomlEntry'
  | 'TomlArrayElement'
  | 'YamlStream'
  | 'YamlDocument'
  | 'YamlNode'
  | 'YamlMappingEntry'
  | 'YamlSequenceElement'
  | 'YamlAnchorDefinition'
  | 'YamlAliasOccurrence'
  | 'JsonSyntaxPiece'
  | 'TomlSyntaxPiece'
  | 'YamlSyntaxPiece'
  | 'IniDocument'
  | 'IniSection'
  | 'IniDefaultSection'
  | 'IniEntry'
  | 'IniPhysicalLine'
  | 'IniLogicalLine'
  | 'IniErrorLine'
  | 'IniSyntaxPiece'
  | 'PropertiesDocument'
  | 'PropertiesNaturalLine'
  | 'PropertiesLogicalLine'
  | 'PropertiesProperty'
  | 'PropertiesComment'
  | 'PropertiesEscape'
  | 'PropertiesErrorLine'
  | 'PropertiesSyntaxPiece'
  | 'GraphNode'
  | 'GraphSequenceElement'
  | 'GraphMappingEntry'
  | 'XmlDocument'
  | 'XmlDeclaration'
  | 'XmlDoctype'
  | 'XmlPrologItem'
  | 'XmlElement'
  | 'XmlContentItem'
  | 'XmlAttribute'
  | 'XmlNamespaceBinding'
  | 'XmlText'
  | 'XmlCdata'
  | 'XmlComment'
  | 'XmlProcessingInstruction'
  | 'XmlReference'
  | 'XmlErrorRegion'
  | 'XmlSyntaxPiece'
  | 'PlistValue'
  | 'PlistDictEntry'
  | 'PlistKey'
  | 'PlistArrayElement'
  | 'PlistSyntaxPiece'
  | 'PlistBinaryStructure'
  | 'PlistBinaryObject'
  | 'PlistBinaryOffset'
  | 'PlistBinaryRef'
  | 'PlistBinaryTrailer'
  | 'HclBody'
  | 'HclAttribute'
  | 'HclBlock'
  | 'HclBlockLabel'
  | 'HclExpression'
  | 'HclTemplatePart'
  | 'HclErrorRegion'
  | 'HclSyntaxPiece';

/** A versioned query domain (consema-core/src/query.rs:12-166). */
export interface QueryDomain {
  readonly id: string;
  readonly version: number;
}

export function newQueryDomain(id: string, version: number): QueryDomain {
  return { id, version };
}

export const domainPortableValueV1 = () => newQueryDomain('core.portable-value-query', 1);
export const domainPortableGraphV1 = () => newQueryDomain('core.portable-graph-query', 1);
export const domainJSONNativeV1 = () => newQueryDomain('json.native-semantic-query', 1);
export const domainJSONNativeV2 = () => newQueryDomain('json.native-semantic-query', 2);
export const domainTOMLNativeV1 = () => newQueryDomain('toml.native-semantic-query', 1);
export const domainYAMLNativeV1 = () => newQueryDomain('yaml.native-semantic-query', 1);
export const domainININativeV1 = () => newQueryDomain('ini.native-semantic-query', 1);
export const domainJavaPropertiesNativeV1 = () => newQueryDomain('java-properties.native-semantic-query', 1);
export const domainXMLNativeV1 = () => newQueryDomain('xml.native-semantic-query', 1);
export const domainJSONLosslessSyntaxV1 = () => newQueryDomain('json.lossless-syntax-query', 1);
export const domainJSONLosslessSyntaxV2 = () => newQueryDomain('json.lossless-syntax-query', 2);
export const domainTOMLLosslessSyntaxV1 = () => newQueryDomain('toml.lossless-syntax-query', 1);
export const domainYAMLLosslessSyntaxV1 = () => newQueryDomain('yaml.lossless-syntax-query', 1);
export const domainINILosslessSyntaxV1 = () => newQueryDomain('ini.lossless-syntax-query', 1);
export const domainJavaPropertiesLosslessSyntaxV1 = () => newQueryDomain('java-properties.lossless-syntax-query', 1);
export const domainXMLLosslessSyntaxV1 = () => newQueryDomain('xml.lossless-syntax-query', 1);
export const domainPlistNativeV1 = () => newQueryDomain('plist.native-semantic-query', 1);
export const domainPlistLosslessSyntaxV1 = () => newQueryDomain('plist.lossless-syntax-query', 1);
export const domainPlistBinaryStructureV1 = () => newQueryDomain('plist.binary-structure-query', 1);
export const domainHCLNativeV1 = () => newQueryDomain('hcl.native-semantic-query', 1);
export const domainHCLLosslessSyntaxV1 = () => newQueryDomain('hcl.lossless-syntax-query', 1);

/** One operator call with its argument map. */
export interface OperatorCall {
  readonly id: string;
  readonly version: number;
  readonly arguments: ReadonlyMap<string, PortableValue>;
}

export function newOperatorCall(id: string, version: number): OperatorCall {
  return { id, version, arguments: new Map() };
}

export function withArgument(operator: OperatorCall, name: string, value: PortableValue): OperatorCall {
  const args = new Map(operator.arguments);
  args.set(name, value);
  return { id: operator.id, version: operator.version, arguments: args };
}

/** The closed query-expression kind. */
export type ExpressionKind = 'Input' | 'Apply' | 'Concat' | 'StructureOrderMerge';

export type QueryExpression =
  | { readonly kind: 'Input' }
  | { readonly kind: 'Apply'; readonly input: QueryExpression; readonly operator: OperatorCall }
  | { readonly kind: 'Concat' | 'StructureOrderMerge'; readonly branches: readonly QueryExpression[] };

/** The five frozen cardinality selections (query.rs:434-447). */
export type QuerySelection = 'All' | 'First' | 'Last' | 'ZeroOrOne' | 'RequireOne';

/** A transferable, not-yet-validated query definition. */
export interface QueryDefinition {
  readonly domain: QueryDomain;
  readonly expression: QueryExpression;
  readonly selection: QuerySelection;
}

export function newQueryDefinition(domain: QueryDomain): QueryDefinition {
  return { domain, expression: { kind: 'Input' }, selection: 'All' };
}

export function withExpression(definition: QueryDefinition, expression: QueryExpression): QueryDefinition {
  return { domain: definition.domain, expression, selection: definition.selection };
}

export function withSelection(definition: QueryDefinition, selection: QuerySelection): QueryDefinition {
  return { domain: definition.domain, expression: definition.expression, selection };
}

/** One failure class of query definition validation and binding. */
export type QueryFailureKind =
  | 'DomainMismatch'
  | 'UnknownOperator'
  | 'WrongArgumentType'
  | 'InvalidArgument'
  | 'InvalidOperatorComposition'
  | 'MissingCapability';

/** The typed query failure carrying the frozen registered code. */
export class QueryFailure extends Error {
  readonly kind: QueryFailureKind;
  readonly code: string;
  readonly operator: string;
  readonly version: number;
  readonly argument?: string;
  readonly expectedKind?: string;
  readonly expectedRole?: MatchRole;
  readonly actualRole?: MatchRole;
  readonly domain?: QueryDomain;
  readonly capability?: CapabilityId;

  constructor(options: {
    kind: QueryFailureKind;
    operator: string;
    version?: number;
    argument?: string;
    expectedKind?: string;
    expectedRole?: MatchRole;
    actualRole?: MatchRole;
    domain?: QueryDomain;
    capability?: CapabilityId;
  }) {
    super(queryFailureText(options));
    this.name = 'QueryFailure';
    this.kind = options.kind;
    this.code = queryFailureCode(options.kind);
    this.operator = options.operator;
    this.version = options.version ?? 0;
    if (options.argument !== undefined) {
      this.argument = options.argument;
    }
    if (options.expectedKind !== undefined) {
      this.expectedKind = options.expectedKind;
    }
    if (options.expectedRole !== undefined) {
      this.expectedRole = options.expectedRole;
    }
    if (options.actualRole !== undefined) {
      this.actualRole = options.actualRole;
    }
    if (options.domain !== undefined) {
      this.domain = options.domain;
    }
    if (options.capability !== undefined) {
      this.capability = options.capability;
    }
  }
}

function queryFailureText(options: {
  kind: QueryFailureKind;
  operator: string;
  version?: number;
  argument?: string;
  expectedKind?: string;
  expectedRole?: MatchRole;
  actualRole?: MatchRole;
  domain?: QueryDomain;
  capability?: CapabilityId;
}): string {
  switch (options.kind) {
    case 'DomainMismatch':
      return `protocol: domain mismatch ${options.domain?.id}@${options.domain?.version}`;
    case 'UnknownOperator':
      return `protocol: unknown operator ${options.operator}@${options.version}`;
    case 'WrongArgumentType':
      return `protocol: operator ${options.operator} argument ${options.argument} wants ${options.expectedKind}`;
    case 'InvalidArgument':
      return `protocol: operator ${options.operator} argument ${options.argument} is invalid`;
    case 'InvalidOperatorComposition':
      return `protocol: operator ${options.operator} wants ${options.expectedRole} but input is ${options.actualRole}`;
    case 'MissingCapability':
      return `protocol: missing capability ${options.capability?.namespace}@${options.capability?.version}`;
  }
}

/** The frozen registered codes (RFC 0016 §6). */
export function queryFailureCode(kind: QueryFailureKind): string {
  switch (kind) {
    case 'DomainMismatch':
      return 'core.query.domain-mismatch@1';
    case 'UnknownOperator':
      return 'core.query.unknown-operator@1';
    case 'WrongArgumentType':
      return 'core.query.wrong-argument-type@1';
    case 'InvalidArgument':
      return 'core.query.invalid-argument@1';
    case 'InvalidOperatorComposition':
      return 'core.query.invalid-composition@1';
    case 'MissingCapability':
      return 'core.query.missing-capability@1';
  }
}

/** One operator argument's required value kind name. */
interface ArgSpec {
  readonly name: string;
  readonly kind: string;
}

/** One operator row: expected input role, output role, and argument kinds. */
interface OperatorSpec {
  readonly expected: MatchRole | '';
  readonly output: MatchRole | '';
  readonly arguments: readonly ArgSpec[];
}

/** The table placeholder for input-dependent operator rows. */
const ROLE_ANY = '' as const;

/** The argument value-kind spellings used by the table. */
const KIND_STRING = 'String';
const KIND_BOOLEAN = 'Boolean';
const KIND_INTEGER = 'Integer';
const KIND_BYTES = 'Bytes';

/**
 * The domain/operator validation table (query.rs:899-1897; transcribed into
 * go/protocol/query_validate.go:169-361). The generic rows (core.take,
 * core.distinct-by-identity) are domain-agnostic and resolved separately.
 */
const OPERATOR_TABLE = new Map<string, OperatorSpec>([
  // core.portable-value-query@1
  ['core.portable-value-query/core.try-object-entries', { expected: 'Value', output: 'ObjectEntry', arguments: [] }],
  ['core.portable-value-query/core.object-entry-value', { expected: 'ObjectEntry', output: 'Value', arguments: [] }],
  ['core.portable-value-query/core.object-entry-name-equals', { expected: 'ObjectEntry', output: 'ObjectEntry', arguments: [{ name: 'name', kind: KIND_STRING }] }],
  ['core.portable-value-query/core.try-entry-mapping-entries', { expected: 'Value', output: 'EntryMappingEntry', arguments: [] }],
  ['core.portable-value-query/core.entry-key', { expected: 'EntryMappingEntry', output: 'Value', arguments: [] }],
  ['core.portable-value-query/core.entry-value', { expected: 'EntryMappingEntry', output: 'Value', arguments: [] }],
  ['core.portable-value-query/core.try-sequence-elements', { expected: 'Value', output: 'Value', arguments: [] }],
  ['core.portable-value-query/core.where-type', { expected: 'Value', output: 'Value', arguments: [{ name: 'kind', kind: KIND_STRING }] }],
  ['core.portable-value-query/core.require-type', { expected: 'Value', output: 'Value', arguments: [{ name: 'kind', kind: KIND_STRING }] }],

  // json.native-semantic-query@1|2
  ['json.native-semantic-query/json.try-object-members', { expected: 'JsonValue', output: 'JsonObjectMember', arguments: [] }],
  ['json.native-semantic-query/json.member-name-equals', { expected: 'JsonObjectMember', output: 'JsonObjectMember', arguments: [{ name: 'name', kind: KIND_STRING }] }],
  ['json.native-semantic-query/json.member-value', { expected: 'JsonObjectMember', output: 'JsonValue', arguments: [] }],
  ['json.native-semantic-query/json.try-array-elements', { expected: 'JsonValue', output: 'JsonArrayElement', arguments: [] }],
  ['json.native-semantic-query/json.array-element-value', { expected: 'JsonArrayElement', output: 'JsonValue', arguments: [] }],

  // toml.native-semantic-query@1
  ['toml.native-semantic-query/toml.try-table-entries', { expected: 'TomlItem', output: 'TomlEntry', arguments: [] }],
  ['toml.native-semantic-query/toml.entry-name-equals', { expected: 'TomlEntry', output: 'TomlEntry', arguments: [{ name: 'name', kind: KIND_STRING }] }],
  ['toml.native-semantic-query/toml.entry-item', { expected: 'TomlEntry', output: 'TomlItem', arguments: [] }],
  ['toml.native-semantic-query/toml.try-array-elements', { expected: 'TomlItem', output: 'TomlArrayElement', arguments: [] }],
  ['toml.native-semantic-query/toml.array-element-item', { expected: 'TomlArrayElement', output: 'TomlItem', arguments: [] }],

  // yaml.native-semantic-query@1
  ['yaml.native-semantic-query/yaml.documents', { expected: 'YamlStream', output: 'YamlDocument', arguments: [] }],
  ['yaml.native-semantic-query/yaml.document-root', { expected: 'YamlDocument', output: 'YamlNode', arguments: [] }],
  ['yaml.native-semantic-query/yaml.where-node-kind', { expected: 'YamlNode', output: 'YamlNode', arguments: [{ name: 'kind', kind: KIND_STRING }] }],
  ['yaml.native-semantic-query/yaml.where-tag', { expected: 'YamlNode', output: 'YamlNode', arguments: [{ name: 'tag', kind: KIND_STRING }] }],
  ['yaml.native-semantic-query/yaml.scalar-canonical-equals', { expected: 'YamlNode', output: 'YamlNode', arguments: [{ name: 'canonical', kind: KIND_STRING }] }],
  ['yaml.native-semantic-query/yaml.try-sequence-elements', { expected: 'YamlNode', output: 'YamlSequenceElement', arguments: [] }],
  ['yaml.native-semantic-query/yaml.sequence-element-node', { expected: 'YamlSequenceElement', output: 'YamlNode', arguments: [] }],
  ['yaml.native-semantic-query/yaml.try-mapping-entries', { expected: 'YamlNode', output: 'YamlMappingEntry', arguments: [] }],
  ['yaml.native-semantic-query/yaml.mapping-entry-key', { expected: 'YamlMappingEntry', output: 'YamlNode', arguments: [] }],
  ['yaml.native-semantic-query/yaml.mapping-entry-value', { expected: 'YamlMappingEntry', output: 'YamlNode', arguments: [] }],
  ['yaml.native-semantic-query/yaml.anchor-definition', { expected: 'YamlNode', output: 'YamlAnchorDefinition', arguments: [] }],
  ['yaml.native-semantic-query/yaml.anchor-node', { expected: 'YamlAnchorDefinition', output: 'YamlNode', arguments: [] }],
  ['yaml.native-semantic-query/yaml.alias-occurrences', { expected: 'YamlStream', output: 'YamlAliasOccurrence', arguments: [] }],
  ['yaml.native-semantic-query/yaml.alias-target', { expected: 'YamlAliasOccurrence', output: 'YamlNode', arguments: [] }],

  // ini.native-semantic-query@1
  ['ini.native-semantic-query/ini.document-sections', { expected: 'IniDocument', output: 'IniSection', arguments: [] }],
  ['ini.native-semantic-query/ini.section-entries', { expected: 'IniSection', output: 'IniEntry', arguments: [] }],
  ['ini.native-semantic-query/ini.all-entries', { expected: 'IniDocument', output: 'IniEntry', arguments: [] }],
  ['ini.native-semantic-query/ini.entry-section', { expected: 'IniEntry', output: 'IniSection', arguments: [] }],
  ['ini.native-semantic-query/ini.section-name-equals', { expected: 'IniSection', output: 'IniSection', arguments: [{ name: 'name', kind: KIND_STRING }, { name: 'comparison', kind: KIND_STRING }] }],
  ['ini.native-semantic-query/ini.entry-key-equals', { expected: 'IniEntry', output: 'IniEntry', arguments: [{ name: 'key', kind: KIND_STRING }, { name: 'comparison', kind: KIND_STRING }] }],
  ['ini.native-semantic-query/ini.entry-value-state-is', { expected: 'IniEntry', output: 'IniEntry', arguments: [{ name: 'state', kind: KIND_STRING }] }],
  // ini.duplicate-group is the input-dependent row (RoleAny placeholder).
  ['ini.native-semantic-query/ini.duplicate-group', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [] }],
  ['ini.native-semantic-query/ini.physical-lines', { expected: 'IniDocument', output: 'IniPhysicalLine', arguments: [] }],
  ['ini.native-semantic-query/ini.logical-lines', { expected: 'IniDocument', output: 'IniLogicalLine', arguments: [] }],

  // java-properties.native-semantic-query@1
  ['java-properties.native-semantic-query/properties.document-properties', { expected: 'PropertiesDocument', output: 'PropertiesProperty', arguments: [] }],
  ['java-properties.native-semantic-query/properties.natural-lines', { expected: 'PropertiesDocument', output: 'PropertiesNaturalLine', arguments: [] }],
  ['java-properties.native-semantic-query/properties.logical-lines', { expected: 'PropertiesDocument', output: 'PropertiesLogicalLine', arguments: [] }],
  ['java-properties.native-semantic-query/properties.logical-line-natural-lines', { expected: 'PropertiesLogicalLine', output: 'PropertiesNaturalLine', arguments: [] }],
  ['java-properties.native-semantic-query/properties.property-key-equals', { expected: 'PropertiesProperty', output: 'PropertiesProperty', arguments: [{ name: 'key', kind: KIND_BYTES }] }],
  ['java-properties.native-semantic-query/properties.property-value-state-is', { expected: 'PropertiesProperty', output: 'PropertiesProperty', arguments: [{ name: 'state', kind: KIND_STRING }] }],
  ['java-properties.native-semantic-query/properties.property-escapes', { expected: 'PropertiesProperty', output: 'PropertiesEscape', arguments: [] }],
  ['java-properties.native-semantic-query/properties.duplicate-group', { expected: 'PropertiesProperty', output: 'PropertiesProperty', arguments: [] }],

  // json.lossless-syntax-query@1|2
  ['json.lossless-syntax-query/json.syntax-kind-is', { expected: 'JsonSyntaxPiece', output: 'JsonSyntaxPiece', arguments: [{ name: 'kind', kind: KIND_STRING }] }],
  ['json.lossless-syntax-query/json.syntax-text-equals', { expected: 'JsonSyntaxPiece', output: 'JsonSyntaxPiece', arguments: [{ name: 'text', kind: KIND_STRING }] }],

  // toml.lossless-syntax-query@1
  ['toml.lossless-syntax-query/toml.syntax-kind-is', { expected: 'TomlSyntaxPiece', output: 'TomlSyntaxPiece', arguments: [{ name: 'kind', kind: KIND_STRING }] }],
  ['toml.lossless-syntax-query/toml.syntax-text-equals', { expected: 'TomlSyntaxPiece', output: 'TomlSyntaxPiece', arguments: [{ name: 'text', kind: KIND_STRING }] }],

  // yaml.lossless-syntax-query@1
  ['yaml.lossless-syntax-query/yaml.syntax-kind-is', { expected: 'YamlSyntaxPiece', output: 'YamlSyntaxPiece', arguments: [{ name: 'kind', kind: KIND_STRING }] }],
  ['yaml.lossless-syntax-query/yaml.syntax-text-equals', { expected: 'YamlSyntaxPiece', output: 'YamlSyntaxPiece', arguments: [{ name: 'text', kind: KIND_STRING }] }],

  // ini.lossless-syntax-query@1
  ['ini.lossless-syntax-query/ini.syntax-kind-is', { expected: 'IniSyntaxPiece', output: 'IniSyntaxPiece', arguments: [{ name: 'kind', kind: KIND_STRING }] }],
  ['ini.lossless-syntax-query/ini.syntax-text-equals', { expected: 'IniSyntaxPiece', output: 'IniSyntaxPiece', arguments: [{ name: 'text', kind: KIND_STRING }] }],

  // java-properties.lossless-syntax-query@1
  ['java-properties.lossless-syntax-query/properties.syntax-kind-is', { expected: 'PropertiesSyntaxPiece', output: 'PropertiesSyntaxPiece', arguments: [{ name: 'kind', kind: KIND_STRING }] }],
  ['java-properties.lossless-syntax-query/properties.syntax-text-equals', { expected: 'PropertiesSyntaxPiece', output: 'PropertiesSyntaxPiece', arguments: [{ name: 'text', kind: KIND_STRING }] }],
  ['java-properties.lossless-syntax-query/properties.syntax-raw-bytes-equals', { expected: 'PropertiesSyntaxPiece', output: 'PropertiesSyntaxPiece', arguments: [{ name: 'bytes', kind: KIND_BYTES }] }],
  ['java-properties.lossless-syntax-query/properties.syntax-utf16be-equals', { expected: 'PropertiesSyntaxPiece', output: 'PropertiesSyntaxPiece', arguments: [{ name: 'code_units', kind: KIND_BYTES }] }],

  // core.portable-graph-query@1
  ['core.portable-graph-query/graph.reachable-nodes', { expected: 'GraphNode', output: 'GraphNode', arguments: [] }],
  ['core.portable-graph-query/graph.where-kind', { expected: 'GraphNode', output: 'GraphNode', arguments: [{ name: 'kind', kind: KIND_STRING }] }],
  ['core.portable-graph-query/graph.where-tag', { expected: 'GraphNode', output: 'GraphNode', arguments: [{ name: 'tag', kind: KIND_STRING }] }],
  ['core.portable-graph-query/graph.try-sequence-elements', { expected: 'GraphNode', output: 'GraphSequenceElement', arguments: [] }],
  ['core.portable-graph-query/graph.sequence-element-node', { expected: 'GraphSequenceElement', output: 'GraphNode', arguments: [] }],
  ['core.portable-graph-query/graph.try-mapping-entries', { expected: 'GraphNode', output: 'GraphMappingEntry', arguments: [] }],
  ['core.portable-graph-query/graph.mapping-entry-key', { expected: 'GraphMappingEntry', output: 'GraphNode', arguments: [] }],
  ['core.portable-graph-query/graph.mapping-entry-value', { expected: 'GraphMappingEntry', output: 'GraphNode', arguments: [] }],

  // xml.native-semantic-query@1
  ['xml.native-semantic-query/xml.document-root', { expected: 'XmlDocument', output: 'XmlElement', arguments: [] }],
  ['xml.native-semantic-query/xml.document-declaration', { expected: 'XmlDocument', output: 'XmlDeclaration', arguments: [] }],
  ['xml.native-semantic-query/xml.document-doctype', { expected: 'XmlDocument', output: 'XmlDoctype', arguments: [] }],
  ['xml.native-semantic-query/xml.document-prolog', { expected: 'XmlDocument', output: 'XmlPrologItem', arguments: [] }],
  ['xml.native-semantic-query/xml.document-epilog', { expected: 'XmlDocument', output: 'XmlPrologItem', arguments: [] }],
  ['xml.native-semantic-query/xml.element-children', { expected: 'XmlElement', output: 'XmlContentItem', arguments: [] }],
  ['xml.native-semantic-query/xml.element-child-elements', { expected: 'XmlElement', output: 'XmlElement', arguments: [] }],
  ['xml.native-semantic-query/xml.element-descendants', { expected: 'XmlElement', output: 'XmlElement', arguments: [] }],
  ['xml.native-semantic-query/xml.element-child-text', { expected: 'XmlElement', output: 'XmlText', arguments: [] }],
  ['xml.native-semantic-query/xml.element-child-cdata', { expected: 'XmlElement', output: 'XmlCdata', arguments: [] }],
  ['xml.native-semantic-query/xml.element-child-comments', { expected: 'XmlElement', output: 'XmlComment', arguments: [] }],
  ['xml.native-semantic-query/xml.element-child-pi', { expected: 'XmlElement', output: 'XmlProcessingInstruction', arguments: [] }],
  ['xml.native-semantic-query/xml.element-attributes', { expected: 'XmlElement', output: 'XmlAttribute', arguments: [] }],
  ['xml.native-semantic-query/xml.element-namespace-bindings', { expected: 'XmlElement', output: 'XmlNamespaceBinding', arguments: [] }],
  ['xml.native-semantic-query/xml.element-in-scope-namespaces', { expected: 'XmlElement', output: 'XmlNamespaceBinding', arguments: [] }],
  ['xml.native-semantic-query/xml.text-references', { expected: 'XmlText', output: 'XmlReference', arguments: [] }],
  ['xml.native-semantic-query/xml.content-parent', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [] }],
  ['xml.native-semantic-query/xml.attribute-element', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [] }],
  ['xml.native-semantic-query/xml.reference-text', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [] }],
  ['xml.native-semantic-query/xml.name-equals', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [{ name: 'prefix', kind: KIND_STRING }, { name: 'local', kind: KIND_STRING }, { name: 'namespace', kind: KIND_STRING }, { name: 'comparison', kind: KIND_STRING }] }],
  ['xml.native-semantic-query/xml.attribute-value-equals', { expected: 'XmlAttribute', output: 'XmlAttribute', arguments: [{ name: 'value', kind: KIND_STRING }] }],
  ['xml.native-semantic-query/xml.pi-target-equals', { expected: 'XmlProcessingInstruction', output: 'XmlProcessingInstruction', arguments: [{ name: 'target', kind: KIND_STRING }] }],
  ['xml.native-semantic-query/xml.reference-kind-is', { expected: 'XmlReference', output: 'XmlReference', arguments: [{ name: 'kind', kind: KIND_STRING }] }],
  ['xml.native-semantic-query/xml.reference-name-equals', { expected: 'XmlReference', output: 'XmlReference', arguments: [{ name: 'name', kind: KIND_STRING }] }],
  ['xml.native-semantic-query/xml.node-kind-is', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [{ name: 'kind', kind: KIND_STRING }] }],

  // xml.lossless-syntax-query@1
  ['xml.lossless-syntax-query/xml.syntax-kind-is', { expected: 'XmlSyntaxPiece', output: 'XmlSyntaxPiece', arguments: [{ name: 'kind', kind: KIND_STRING }] }],
  ['xml.lossless-syntax-query/xml.syntax-text-equals', { expected: 'XmlSyntaxPiece', output: 'XmlSyntaxPiece', arguments: [{ name: 'text', kind: KIND_STRING }] }],

  // plist.native-semantic-query@1
  ['plist.native-semantic-query/plist.document-root', { expected: 'PlistValue', output: 'PlistValue', arguments: [] }],
  ['plist.native-semantic-query/plist.dict-entries', { expected: 'PlistValue', output: 'PlistDictEntry', arguments: [] }],
  ['plist.native-semantic-query/plist.dict-entry-key', { expected: 'PlistDictEntry', output: 'PlistKey', arguments: [] }],
  ['plist.native-semantic-query/plist.dict-entry-value', { expected: 'PlistDictEntry', output: 'PlistValue', arguments: [] }],
  ['plist.native-semantic-query/plist.dict-key-equals', { expected: 'PlistDictEntry', output: 'PlistDictEntry', arguments: [{ name: 'key', kind: KIND_STRING }] }],
  ['plist.native-semantic-query/plist.duplicate-key-group', { expected: 'PlistDictEntry', output: 'PlistDictEntry', arguments: [] }],
  ['plist.native-semantic-query/plist.array-elements', { expected: 'PlistValue', output: 'PlistArrayElement', arguments: [] }],
  ['plist.native-semantic-query/plist.value-type-is', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [{ name: 'kind', kind: KIND_STRING }] }],
  ['plist.native-semantic-query/plist.value-as-integer', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [] }],
  ['plist.native-semantic-query/plist.value-as-real', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [] }],
  ['plist.native-semantic-query/plist.value-as-string', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [] }],
  ['plist.native-semantic-query/plist.value-as-data', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [] }],
  ['plist.native-semantic-query/plist.value-as-date', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [] }],
  ['plist.native-semantic-query/plist.value-as-uid', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [] }],
  ['plist.native-semantic-query/plist.value-as-boolean-is', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [{ name: 'value', kind: KIND_BOOLEAN }] }],

  // plist.lossless-syntax-query@1
  ['plist.lossless-syntax-query/plist.syntax-kind-is', { expected: 'PlistSyntaxPiece', output: 'PlistSyntaxPiece', arguments: [{ name: 'kind', kind: KIND_STRING }] }],
  ['plist.lossless-syntax-query/plist.syntax-text-equals', { expected: 'PlistSyntaxPiece', output: 'PlistSyntaxPiece', arguments: [{ name: 'text', kind: KIND_STRING }] }],

  // plist.binary-structure-query@1
  ['plist.binary-structure-query/plist.object-table', { expected: ROLE_ANY, output: 'PlistBinaryObject', arguments: [] }],
  ['plist.binary-structure-query/plist.object-offset', { expected: ROLE_ANY, output: 'PlistBinaryOffset', arguments: [] }],
  ['plist.binary-structure-query/plist.object-refs', { expected: ROLE_ANY, output: 'PlistBinaryRef', arguments: [] }],
  ['plist.binary-structure-query/plist.offset-table', { expected: ROLE_ANY, output: 'PlistBinaryOffset', arguments: [] }],
  ['plist.binary-structure-query/plist.trailer-facts', { expected: ROLE_ANY, output: 'PlistBinaryTrailer', arguments: [] }],
  ['plist.binary-structure-query/plist.top-object', { expected: ROLE_ANY, output: 'PlistBinaryObject', arguments: [] }],

  // hcl.native-semantic-query@1
  ['hcl.native-semantic-query/hcl.document-body', { expected: 'HclBody', output: 'HclBody', arguments: [] }],
  ['hcl.native-semantic-query/hcl.body-items', { expected: 'HclBody', output: 'HclAttribute', arguments: [] }],
  ['hcl.native-semantic-query/hcl.body-attributes', { expected: 'HclBody', output: 'HclAttribute', arguments: [] }],
  ['hcl.native-semantic-query/hcl.body-blocks', { expected: 'HclBody', output: 'HclBlock', arguments: [] }],
  ['hcl.native-semantic-query/hcl.body-block-type-equals', { expected: 'HclBody', output: 'HclBlock', arguments: [{ name: 'type', kind: KIND_STRING }] }],
  ['hcl.native-semantic-query/hcl.attribute-name', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [] }],
  ['hcl.native-semantic-query/hcl.attribute-name-equals', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [{ name: 'name', kind: KIND_STRING }] }],
  ['hcl.native-semantic-query/hcl.attribute-expression', { expected: ROLE_ANY, output: 'HclExpression', arguments: [] }],
  ['hcl.native-semantic-query/hcl.attribute-literal-value', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [{ name: 'accessor', kind: KIND_STRING }] }],
  ['hcl.native-semantic-query/hcl.block-type', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [] }],
  ['hcl.native-semantic-query/hcl.block-type-equals', { expected: ROLE_ANY, output: ROLE_ANY, arguments: [{ name: 'type', kind: KIND_STRING }] }],
  ['hcl.native-semantic-query/hcl.block-labels', { expected: ROLE_ANY, output: 'HclBlockLabel', arguments: [] }],
  ['hcl.native-semantic-query/hcl.block-nested-body', { expected: ROLE_ANY, output: 'HclBody', arguments: [] }],
  ['hcl.native-semantic-query/hcl.block-label-equals', { expected: 'HclBlockLabel', output: 'HclBlockLabel', arguments: [{ name: 'label', kind: KIND_STRING }] }],
  ['hcl.native-semantic-query/hcl.expression-kind-is', { expected: 'HclExpression', output: 'HclExpression', arguments: [{ name: 'kind', kind: KIND_STRING }] }],
  ['hcl.native-semantic-query/hcl.expression-is-literal', { expected: 'HclExpression', output: 'HclExpression', arguments: [] }],
  ['hcl.native-semantic-query/hcl.expression-text', { expected: 'HclExpression', output: 'HclExpression', arguments: [] }],
  ['hcl.native-semantic-query/hcl.expression-children', { expected: 'HclExpression', output: 'HclExpression', arguments: [] }],
  ['hcl.native-semantic-query/hcl.template-parts', { expected: 'HclExpression', output: 'HclTemplatePart', arguments: [] }],
  ['hcl.native-semantic-query/hcl.tuple-elements', { expected: 'HclExpression', output: 'HclExpression', arguments: [] }],
  ['hcl.native-semantic-query/hcl.object-entries', { expected: 'HclExpression', output: 'HclExpression', arguments: [] }],
  ['hcl.native-semantic-query/hcl.error-regions', { expected: ROLE_ANY, output: 'HclErrorRegion', arguments: [] }],

  // hcl.lossless-syntax-query@1
  ['hcl.lossless-syntax-query/hcl.syntax-kind-is', { expected: 'HclSyntaxPiece', output: 'HclSyntaxPiece', arguments: [{ name: 'kind', kind: KIND_STRING }] }],
  ['hcl.lossless-syntax-query/hcl.syntax-text-equals', { expected: 'HclSyntaxPiece', output: 'HclSyntaxPiece', arguments: [{ name: 'text', kind: KIND_STRING }] }],
]);

/** Maps a domain to its root match role (query.rs:502-523). */
export function domainInputRole(id: string, version: number): MatchRole | undefined {
  switch (true) {
    case id === 'core.portable-value-query' && version === 1:
      return 'Value';
    case id === 'core.portable-graph-query' && version === 1:
      return 'GraphNode';
    case id === 'json.native-semantic-query' && (version === 1 || version === 2):
      return 'JsonValue';
    case id === 'toml.native-semantic-query' && version === 1:
      return 'TomlItem';
    case id === 'yaml.native-semantic-query' && version === 1:
      return 'YamlStream';
    case id === 'ini.native-semantic-query' && version === 1:
      return 'IniDocument';
    case id === 'java-properties.native-semantic-query' && version === 1:
      return 'PropertiesDocument';
    case id === 'xml.native-semantic-query' && version === 1:
      return 'XmlDocument';
    case id === 'json.lossless-syntax-query' && (version === 1 || version === 2):
      return 'JsonSyntaxPiece';
    case id === 'toml.lossless-syntax-query' && version === 1:
      return 'TomlSyntaxPiece';
    case id === 'yaml.lossless-syntax-query' && version === 1:
      return 'YamlSyntaxPiece';
    case id === 'ini.lossless-syntax-query' && version === 1:
      return 'IniSyntaxPiece';
    case id === 'java-properties.lossless-syntax-query' && version === 1:
      return 'PropertiesSyntaxPiece';
    case id === 'xml.lossless-syntax-query' && version === 1:
      return 'XmlSyntaxPiece';
    case id === 'plist.native-semantic-query' && version === 1:
      return 'PlistValue';
    case id === 'plist.lossless-syntax-query' && version === 1:
      return 'PlistSyntaxPiece';
    case id === 'plist.binary-structure-query' && version === 1:
      return 'PlistBinaryStructure';
    case id === 'hcl.native-semantic-query' && version === 1:
      return 'HclBody';
    case id === 'hcl.lossless-syntax-query' && version === 1:
      return 'HclSyntaxPiece';
    default:
      return undefined;
  }
}

/** A definition proven structurally valid for its domain. */
export interface ValidatedQuery {
  readonly definition: QueryDefinition;
  readonly outputRole: MatchRole;
  readonly requiredCapabilities: readonly CapabilityId[];
}

/** Validates the domain, argument schemas, composition, and role typing (query.rs:500-530). */
export function validateQuery(definition: QueryDefinition): { query: ValidatedQuery } | { failure: QueryFailure } {
  const inputRole = domainInputRole(definition.domain.id, definition.domain.version);
  if (inputRole === undefined) {
    return { failure: new QueryFailure({ kind: 'DomainMismatch', operator: 'domain', domain: definition.domain }) };
  }
  const expressionResult = validateExpression(definition.domain, definition.expression, inputRole);
  if ('failure' in expressionResult) {
    return { failure: expressionResult.failure };
  }
  const orderedResults = { namespace: 'core.query.ordered-results', version: 1 };
  return {
    query: {
      definition,
      outputRole: expressionResult.outputRole,
      requiredCapabilities: [orderedResults],
    },
  };
}

/** Checks the whole operator tree and returns its output role (query.rs:867-897). */
function validateExpression(
  domain: QueryDomain,
  expression: QueryExpression,
  inputRole: MatchRole,
): { outputRole: MatchRole } | { failure: QueryFailure } {
  switch (expression.kind) {
    case 'Input':
      return { outputRole: inputRole };
    case 'Apply': {
      const input = validateExpression(domain, expression.input, inputRole);
      if ('failure' in input) {
        return input;
      }
      return validateOperator(domain, expression.operator, input.outputRole);
    }
    case 'Concat':
    case 'StructureOrderMerge': {
      let output: MatchRole | undefined;
      for (const branch of expression.branches) {
        const branchResult = validateExpression(domain, branch, inputRole);
        if ('failure' in branchResult) {
          return branchResult;
        }
        if (output !== undefined && output !== branchResult.outputRole) {
          return {
            failure: new QueryFailure({
              kind: 'InvalidOperatorComposition',
              operator: 'composition.concat',
              expectedRole: output,
              actualRole: branchResult.outputRole,
            }),
          };
        }
        output = branchResult.outputRole;
      }
      if (output === undefined) {
        return {
          failure: new QueryFailure({
            kind: 'InvalidArgument',
            operator: 'composition.concat',
            argument: 'branches',
          }),
        };
      }
      return { outputRole: output };
    }
  }
}

/** Validates one operator call against its domain and input role (query.rs:899-1897). */
function validateOperator(
  domain: QueryDomain,
  operator: OperatorCall,
  input: MatchRole,
): { outputRole: MatchRole } | { failure: QueryFailure } {
  if (operator.version !== 1) {
    return {
      failure: new QueryFailure({
        kind: 'UnknownOperator',
        operator: operator.id,
        version: operator.version,
      }),
    };
  }
  let spec = OPERATOR_TABLE.get(`${domain.id}/${operator.id}`);
  if (spec === undefined) {
    // The domain-agnostic generic rows.
    switch (operator.id) {
      case 'core.take':
        spec = { expected: input, output: input, arguments: [{ name: 'count', kind: KIND_INTEGER }] };
        break;
      case 'core.distinct-by-identity':
        spec = { expected: input, output: input, arguments: [] };
        break;
      default:
        return {
          failure: new QueryFailure({ kind: 'UnknownOperator', operator: operator.id, version: operator.version }),
        };
    }
  }
  if (spec.expected !== ROLE_ANY && input !== spec.expected) {
    return {
      failure: new QueryFailure({
        kind: 'InvalidOperatorComposition',
        operator: operator.id,
        expectedRole: spec.expected,
        actualRole: input,
      }),
    };
  }
  const fixed = checkInputDependentRoles(domain.id, operator.id, input, spec);
  if ('failure' in fixed) {
    return fixed;
  }
  if (operator.arguments.size !== spec.arguments.length) {
    return {
      failure: new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'argument-set' }),
    };
  }
  for (const argument of spec.arguments) {
    const value = operator.arguments.get(argument.name);
    if (value === undefined || value.kind !== argument.kind) {
      return {
        failure: new QueryFailure({
          kind: 'WrongArgumentType',
          operator: operator.id,
          argument: argument.name,
          expectedKind: argument.kind,
        }),
      };
    }
  }
  const semantic = checkOperatorArguments(domain, operator);
  if (semantic !== undefined) {
    return { failure: semantic };
  }
  return { outputRole: fixed.outputRole };
}

/** Applies the role-union rows; each handled row also fixes the output role (query.rs:1056-1524). */
function checkInputDependentRoles(
  domainId: string,
  operatorId: string,
  input: MatchRole,
  spec: OperatorSpec,
): { outputRole: MatchRole } | { failure: QueryFailure } {
  switch (true) {
    case domainId === 'ini.native-semantic-query' && operatorId === 'ini.duplicate-group':
      if (input !== 'IniSection' && input !== 'IniEntry') {
        return {
          failure: new QueryFailure({
            kind: 'InvalidOperatorComposition',
            operator: operatorId,
            expectedRole: 'IniSection',
            actualRole: input,
          }),
        };
      }
      return { outputRole: input };
    case domainId === 'xml.native-semantic-query' &&
      (operatorId === 'xml.content-parent' || operatorId === 'xml.attribute-element' || operatorId === 'xml.reference-text'):
      if (!xmlContentInputRoles(input)) {
        return {
          failure: new QueryFailure({
            kind: 'InvalidOperatorComposition',
            operator: operatorId,
            expectedRole: 'XmlContentItem',
            actualRole: input,
          }),
        };
      }
      return { outputRole: 'XmlElement' };
    case domainId === 'xml.native-semantic-query' && operatorId === 'xml.name-equals':
      return { outputRole: input };
    case domainId === 'xml.native-semantic-query' && operatorId === 'xml.node-kind-is':
      if (!xmlNodeKindRoles(input)) {
        return {
          failure: new QueryFailure({
            kind: 'InvalidOperatorComposition',
            operator: operatorId,
            expectedRole: 'XmlDocument',
            actualRole: input,
          }),
        };
      }
      return { outputRole: input };
    case domainId === 'plist.native-semantic-query' &&
      (operatorId === 'plist.value-type-is' ||
        operatorId === 'plist.value-as-integer' ||
        operatorId === 'plist.value-as-real' ||
        operatorId === 'plist.value-as-string' ||
        operatorId === 'plist.value-as-data' ||
        operatorId === 'plist.value-as-date' ||
        operatorId === 'plist.value-as-uid' ||
        operatorId === 'plist.value-as-boolean-is'):
      if (input !== 'PlistValue' && input !== 'PlistArrayElement') {
        return {
          failure: new QueryFailure({
            kind: 'InvalidOperatorComposition',
            operator: operatorId,
            expectedRole: 'PlistValue',
            actualRole: input,
          }),
        };
      }
      return { outputRole: input };
    case domainId === 'plist.binary-structure-query':
      if (!plistBinaryInputRoles(input)) {
        return {
          failure: new QueryFailure({
            kind: 'InvalidOperatorComposition',
            operator: operatorId,
            expectedRole: 'PlistBinaryStructure',
            actualRole: input,
          }),
        };
      }
      // The table row for every plist.binary-structure-query operator pins a
      // concrete output role (never ROLE_ANY), so the sentinel is excluded.
      return { outputRole: spec.output as MatchRole };
    case domainId === 'hcl.native-semantic-query' &&
      (operatorId === 'hcl.attribute-name' ||
        operatorId === 'hcl.attribute-name-equals' ||
        operatorId === 'hcl.block-type' ||
        operatorId === 'hcl.block-type-equals'):
      if (input !== 'HclAttribute' && input !== 'HclBlock') {
        return {
          failure: new QueryFailure({
            kind: 'InvalidOperatorComposition',
            operator: operatorId,
            expectedRole: 'HclAttribute',
            actualRole: input,
          }),
        };
      }
      return { outputRole: input };
    case domainId === 'hcl.native-semantic-query' && operatorId === 'hcl.attribute-literal-value':
      if (input !== 'HclExpression' && input !== 'HclAttribute') {
        return {
          failure: new QueryFailure({
            kind: 'InvalidOperatorComposition',
            operator: operatorId,
            expectedRole: 'HclExpression',
            actualRole: input,
          }),
        };
      }
      return { outputRole: input };
    case domainId === 'hcl.native-semantic-query' &&
      (operatorId === 'hcl.attribute-expression' || operatorId === 'hcl.block-labels' || operatorId === 'hcl.block-nested-body'):
      if (input !== 'HclAttribute' && input !== 'HclBlock') {
        return {
          failure: new QueryFailure({
            kind: 'InvalidOperatorComposition',
            operator: operatorId,
            expectedRole: 'HclAttribute',
            actualRole: input,
          }),
        };
      }
      // The table rows for these hcl operators pin concrete output roles
      // (never ROLE_ANY), so the sentinel is excluded.
      return { outputRole: spec.output as MatchRole };
    case domainId === 'hcl.native-semantic-query' && operatorId === 'hcl.error-regions':
      if (!hclErrorRegionInputRoles(input)) {
        return {
          failure: new QueryFailure({
            kind: 'InvalidOperatorComposition',
            operator: operatorId,
            expectedRole: 'HclBody',
            actualRole: input,
          }),
        };
      }
      return { outputRole: 'HclErrorRegion' };
    default:
      // Every ROLE_ANY row is handled by a case above; rows reaching the
      // default have a concrete output role in the operator table.
      return { outputRole: spec.output as MatchRole };
  }
}

function xmlContentInputRoles(input: MatchRole): boolean {
  switch (input) {
    case 'XmlContentItem':
    case 'XmlAttribute':
    case 'XmlNamespaceBinding':
    case 'XmlReference':
    case 'XmlElement':
    case 'XmlText':
    case 'XmlCdata':
    case 'XmlComment':
    case 'XmlProcessingInstruction':
      return true;
    default:
      return false;
  }
}

function xmlNodeKindRoles(input: MatchRole): boolean {
  switch (input) {
    case 'XmlDocument':
    case 'XmlDeclaration':
    case 'XmlDoctype':
    case 'XmlPrologItem':
    case 'XmlElement':
    case 'XmlContentItem':
    case 'XmlAttribute':
    case 'XmlNamespaceBinding':
    case 'XmlText':
    case 'XmlCdata':
    case 'XmlComment':
    case 'XmlProcessingInstruction':
    case 'XmlReference':
    case 'XmlErrorRegion':
      return true;
    default:
      return false;
  }
}

function plistBinaryInputRoles(input: MatchRole): boolean {
  switch (input) {
    case 'PlistBinaryStructure':
    case 'PlistBinaryObject':
    case 'PlistBinaryOffset':
    case 'PlistBinaryRef':
    case 'PlistBinaryTrailer':
      return true;
    default:
      return false;
  }
}

function hclErrorRegionInputRoles(input: MatchRole): boolean {
  switch (input) {
    case 'HclBody':
    case 'HclAttribute':
    case 'HclBlock':
    case 'HclBlockLabel':
    case 'HclExpression':
    case 'HclTemplatePart':
    case 'HclErrorRegion':
      return true;
    default:
      return false;
  }
}

/** The semantic argument-value checks of the Rust validator (query.rs:1634-1897). */
function checkOperatorArguments(domain: QueryDomain, operator: OperatorCall): QueryFailure | undefined {
  const stringArg = (name: string): string | undefined => {
    const value = operator.arguments.get(name);
    return value !== undefined && value.kind === 'String' ? value.value : undefined;
  };
  switch (operator.id) {
    case 'core.take': {
      const number = operator.arguments.get('count');
      if (number === undefined || number.kind !== 'Integer' || number.value < 0n) {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'count' });
      }
      return undefined;
    }
    case 'core.where-type':
    case 'core.require-type': {
      const kind = stringArg('kind');
      if (!isValueKindName(kind)) {
        return new QueryFailure({ kind: 'InvalidArgument', operator: 'value-kind', argument: kind ?? '' });
      }
      return undefined;
    }
    case 'json.syntax-kind-is': {
      const kind = stringArg('kind');
      if (!isJSONSyntaxKind(domain.version, kind)) {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'kind' });
      }
      return undefined;
    }
    case 'toml.syntax-kind-is': {
      const kind = stringArg('kind');
      if (!isTOMLSyntaxKind(kind)) {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'kind' });
      }
      return undefined;
    }
    case 'yaml.syntax-kind-is': {
      const kind = stringArg('kind');
      if (!isYAMLSyntaxKind(kind)) {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'kind' });
      }
      return undefined;
    }
    case 'ini.syntax-kind-is': {
      const kind = stringArg('kind');
      if (!isINISyntaxKind(kind)) {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'kind' });
      }
      return undefined;
    }
    case 'properties.syntax-kind-is': {
      const kind = stringArg('kind');
      if (!isPropertiesSyntaxKind(kind)) {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'kind' });
      }
      return undefined;
    }
    case 'xml.syntax-kind-is': {
      const kind = stringArg('kind');
      if (!isXMLSyntaxKind(kind)) {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'kind' });
      }
      return undefined;
    }
    case 'plist.value-type-is': {
      const kind = stringArg('kind');
      if (!isPlistValueKind(kind)) {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'kind' });
      }
      return undefined;
    }
    case 'plist.syntax-kind-is': {
      const kind = stringArg('kind');
      if (!isPlistSyntaxKind(kind)) {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'kind' });
      }
      return undefined;
    }
    case 'hcl.expression-kind-is': {
      const kind = stringArg('kind');
      if (!isHCLExpressionKind(kind)) {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'kind' });
      }
      return undefined;
    }
    case 'hcl.syntax-kind-is': {
      const kind = stringArg('kind');
      if (!isHCLSyntaxKind(kind)) {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'kind' });
      }
      return undefined;
    }
    case 'hcl.attribute-literal-value': {
      const accessor = stringArg('accessor');
      if (!isHCLLiteralAccessor(accessor)) {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'accessor' });
      }
      return undefined;
    }
    case 'properties.property-key-equals':
    case 'properties.syntax-utf16be-equals': {
      const name = operator.id === 'properties.syntax-utf16be-equals' ? 'code_units' : 'key';
      const value = operator.arguments.get(name);
      // The Bytes-typed arguments must carry a whole number of UTF-16 code
      // units (the Rust UTF16BE/1 even-length rule).
      if (value === undefined || value.kind !== 'Bytes' || value.value.length % 2 !== 0) {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: name });
      }
      return undefined;
    }
    case 'properties.property-value-state-is': {
      const state = stringArg('state');
      if (state !== 'ImplicitEmpty' && state !== 'ExplicitEmpty' && state !== 'Present') {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'state' });
      }
      return undefined;
    }
    case 'ini.section-name-equals':
    case 'ini.entry-key-equals': {
      const comparison = stringArg('comparison');
      if (comparison !== 'OriginalExact' && comparison !== 'ProfileEquivalent') {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'comparison' });
      }
      return undefined;
    }
    case 'ini.entry-value-state-is': {
      const state = stringArg('state');
      if (state !== 'Missing' && state !== 'Empty' && state !== 'Present') {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'state' });
      }
      return undefined;
    }
    case 'yaml.where-node-kind':
    case 'graph.where-kind': {
      const kind = stringArg('kind');
      if (kind !== 'Scalar' && kind !== 'Sequence' && kind !== 'Mapping') {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'kind' });
      }
      return undefined;
    }
    case 'yaml.where-tag':
    case 'graph.where-tag': {
      const tag = stringArg('tag');
      if (tag === '') {
        return new QueryFailure({ kind: 'InvalidArgument', operator: operator.id, argument: 'tag' });
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The frozen fifteen-kind vocabulary of the value-kind arguments (query.rs:2187-2209). */
function isValueKindName(kind: string | undefined): boolean {
  switch (kind) {
    case 'Null':
    case 'Boolean':
    case 'Integer':
    case 'Decimal':
    case 'BinaryFloat32':
    case 'BinaryFloat64':
    case 'String':
    case 'Bytes':
    case 'Date':
    case 'Time':
    case 'LocalDateTime':
    case 'OffsetDateTime':
    case 'Sequence':
    case 'Object':
    case 'EntryMapping':
      return true;
    default:
      return false;
  }
}

/** The frozen syntax-kind vocabularies (query.rs:1900-2185); spellings are byte-exact. */
function isJSONSyntaxKind(domainVersion: number, kind: string | undefined): boolean {
  switch (kind) {
    case 'Bom':
    case 'Whitespace':
    case 'LineComment':
    case 'BlockComment':
    case 'LeftBrace':
    case 'RightBrace':
    case 'LeftBracket':
    case 'RightBracket':
    case 'Colon':
    case 'Comma':
    case 'String':
    case 'Number':
    case 'True':
    case 'False':
    case 'Null':
    case 'ErrorRegion':
      return true;
    default:
      return domainVersion === 2 && kind === 'Identifier';
  }
}

function isTOMLSyntaxKind(kind: string | undefined): boolean {
  switch (kind) {
    case 'Whitespace':
    case 'Newline':
    case 'Comment':
    case 'String':
    case 'Bare':
    case 'Equals':
    case 'LeftBracket':
    case 'RightBracket':
    case 'LeftBrace':
    case 'RightBrace':
    case 'Comma':
    case 'Dot':
      return true;
    default:
      return false;
  }
}

function isYAMLSyntaxKind(kind: string | undefined): boolean {
  switch (kind) {
    case 'Bom':
    case 'Whitespace':
    case 'Newline':
    case 'Comment':
    case 'Directive':
    case 'DocumentStart':
    case 'DocumentEnd':
    case 'FlowSequenceStart':
    case 'FlowSequenceEnd':
    case 'FlowMappingStart':
    case 'FlowMappingEnd':
    case 'FlowEntry':
    case 'SequenceEntry':
    case 'ExplicitKey':
    case 'MappingValue':
    case 'Anchor':
    case 'Alias':
    case 'Tag':
    case 'PlainScalar':
    case 'SingleQuotedScalar':
    case 'DoubleQuotedScalar':
    case 'LiteralBlockHeader':
    case 'FoldedBlockHeader':
    case 'BlockScalarContent':
    case 'ErrorRegion':
      return true;
    default:
      return false;
  }
}

function isINISyntaxKind(kind: string | undefined): boolean {
  switch (kind) {
    case 'Bom':
    case 'Whitespace':
    case 'LineBreak':
    case 'CommentMarker':
    case 'CommentText':
    case 'SectionOpen':
    case 'SectionName':
    case 'SectionClose':
    case 'EntryKey':
    case 'Delimiter':
    case 'Quote':
    case 'EntryValue':
    case 'ContinuationMarker':
    case 'ErrorRegion':
      return true;
    default:
      return false;
  }
}

function isPropertiesSyntaxKind(kind: string | undefined): boolean {
  switch (kind) {
    case 'Bom':
    case 'Whitespace':
    case 'LineBreak':
    case 'CommentMarker':
    case 'CommentText':
    case 'Key':
    case 'Separator':
    case 'Value':
    case 'EscapeMarker':
    case 'EscapeBody':
    case 'ContinuationMarker':
    case 'ErrorRegion':
      return true;
    default:
      return false;
  }
}

function isXMLSyntaxKind(kind: string | undefined): boolean {
  switch (kind) {
    case 'bom':
    case 'whitespace':
    case 'line-break':
    case 'declaration-open':
    case 'declaration-name':
    case 'declaration-value':
    case 'declaration-close':
    case 'doctype-open':
    case 'doctype-name':
    case 'dtd-markup':
    case 'doctype-close':
    case 'tag-open':
    case 'tag-close':
    case 'empty-element-close':
    case 'end-tag-open':
    case 'prefix':
    case 'local-name':
    case 'colon':
    case 'attribute-name':
    case 'equals':
    case 'quote':
    case 'attribute-value':
    case 'namespace-declaration':
    case 'text':
    case 'entity-reference':
    case 'character-reference':
    case 'cdata-open':
    case 'cdata-text':
    case 'cdata-close':
    case 'comment-open':
    case 'comment-text':
    case 'comment-close':
    case 'processing-instruction-open':
    case 'processing-instruction-target':
    case 'processing-instruction-content':
    case 'processing-instruction-close':
    case 'error-region':
      return true;
    default:
      return false;
  }
}

function isPlistValueKind(kind: string | undefined): boolean {
  switch (kind) {
    case 'dict':
    case 'array':
    case 'string':
    case 'integer':
    case 'real':
    case 'boolean':
    case 'date':
    case 'data':
    case 'uid':
      return true;
    default:
      return false;
  }
}

function isPlistSyntaxKind(kind: string | undefined): boolean {
  switch (kind) {
    case 'bom':
    case 'whitespace':
    case 'line-break':
    case 'declaration-open':
    case 'declaration-name':
    case 'declaration-value':
    case 'declaration-close':
    case 'doctype-open':
    case 'doctype-body':
    case 'doctype-close':
    case 'plist-open':
    case 'plist-version-name':
    case 'plist-version-value':
    case 'plist-close':
    case 'dict-open':
    case 'dict-close':
    case 'key-open':
    case 'key-close':
    case 'array-open':
    case 'array-close':
    case 'string-open':
    case 'string-close':
    case 'integer-open':
    case 'integer-close':
    case 'real-open':
    case 'real-close':
    case 'date-open':
    case 'date-close':
    case 'data-open':
    case 'data-close':
    case 'true':
    case 'false':
    case 'text':
    case 'entity-reference':
    case 'character-reference':
    case 'cdata-open':
    case 'cdata-text':
    case 'cdata-close':
    case 'comment-open':
    case 'comment-text':
    case 'comment-close':
    case 'processing-instruction-open':
    case 'processing-instruction-target':
    case 'processing-instruction-content':
    case 'processing-instruction-close':
    case 'error-region':
      return true;
    default:
      return false;
  }
}

function isHCLExpressionKind(kind: string | undefined): boolean {
  switch (kind) {
    case 'number':
    case 'boolean':
    case 'null':
    case 'template':
    case 'function-call':
    case 'variable-ref':
    case 'traversal':
    case 'unary':
    case 'binary':
    case 'conditional':
    case 'for-tuple':
    case 'for-object':
    case 'tuple':
    case 'object':
    case 'parenthesized':
      return true;
    default:
      return false;
  }
}

function isHCLSyntaxKind(kind: string | undefined): boolean {
  switch (kind) {
    case 'Whitespace':
    case 'LineBreak':
    case 'LineComment':
    case 'InlineComment':
    case 'Identifier':
    case 'Equals':
    case 'Number':
    case 'StringOpen':
    case 'StringContent':
    case 'StringClose':
    case 'InterpolationOpen':
    case 'InterpolationContent':
    case 'InterpolationClose':
    case 'DirectiveOpen':
    case 'DirectiveContent':
    case 'DirectiveClose':
    case 'HeredocOpen':
    case 'HeredocContent':
    case 'HeredocClose':
    case 'BraceOpen':
    case 'BraceClose':
    case 'BracketOpen':
    case 'BracketClose':
    case 'ParenOpen':
    case 'ParenClose':
    case 'Comma':
    case 'Colon':
    case 'QuestionMark':
    case 'Operator':
    case 'ErrorRegion':
      return true;
    default:
      return false;
  }
}

function isHCLLiteralAccessor(accessor: string | undefined): boolean {
  switch (accessor) {
    case 'as-string':
    case 'as-integer':
    case 'as-real':
    case 'as-boolean-is':
    case 'as-null-is':
      return true;
    default:
      return false;
  }
}

/** An executable query bound against a capability set. */
export interface ExecutableQuery {
  readonly validated: ValidatedQuery;
}

/** Binds a validated query to the capabilities available to the operation. */
export function bindQuery(
  validated: ValidatedQuery,
  capabilities: CapabilitySet,
): { query: ExecutableQuery } | { failure: QueryFailure } {
  for (const required of validated.requiredCapabilities) {
    if (!capabilities.contains(required)) {
      return {
        failure: new QueryFailure({
          kind: 'MissingCapability',
          operator: 'capabilities',
          capability: required,
        }),
      };
    }
  }
  return { query: { validated } };
}
