/**
 * The stable public diagnostic and failure code registry.
 *
 * authority: the Rust registries (crates/consema-protocol/src/error_registry.rs)
 * are the content authority; the records here are transcribed verbatim from
 * their Go transcription (go/protocol/error_registry.go) and the counts are
 * pinned by the shared vectors and fc-manifest. The v7 registry pins 187
 * codes (55/62/90/92/132/166/187 across v1..v7); every code carries its
 * semantic category, first release, and a human-facing description. The
 * description wording is presentation metadata, never part of control flow.
 */

import type { PortableValue, ObjectValue } from '../core/value.ts';
import { schemaFields, exactFields, stringOf, sequenceOf } from './records.ts';
import { invalid } from './errors.ts';
import { registerPayloadValidator } from './payload_validators.ts';

/** The semantic category of one registered error code. */
export type DiagnosticCategory =
  | 'Lexical'
  | 'Syntax'
  | 'Conformance'
  | 'Semantic'
  | 'Query'
  | 'Projection'
  | 'Materialization'
  | 'Conversion'
  | 'Edit'
  | 'Resource'
  | 'Encoding';

/** The eleven frozen diagnostic categories. */
export const CATEGORIES: readonly DiagnosticCategory[] = [
  'Lexical',
  'Syntax',
  'Conformance',
  'Semantic',
  'Query',
  'Projection',
  'Materialization',
  'Conversion',
  'Edit',
  'Resource',
  'Encoding',
];

/** Parses one canonical category spelling. */
export function parseDiagnosticCategory(name: string): DiagnosticCategory {
  switch (name) {
    case 'Lexical':
    case 'Syntax':
    case 'Conformance':
    case 'Semantic':
    case 'Query':
    case 'Projection':
    case 'Materialization':
    case 'Conversion':
    case 'Edit':
    case 'Resource':
    case 'Encoding':
      return name;
    default:
      throw new Error(`unknown error-code category: ${name}`);
  }
}

/** One stable public code registry record. */
export interface ErrorCodeDescriptor {
  /** The full namespaced code including `@version`. */
  readonly code: string;
  readonly category: DiagnosticCategory;
  /** The first Consema release containing the code. */
  readonly introduced: string;
  /** Human-facing summary; not part of control flow. */
  readonly description: string;
}

/** Selects one frozen semantic-model error registry. */
export type ErrorRegistryVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** A closed, explicitly versioned error-code registry. */
export class ErrorCodeRegistry {
  private readonly version: ErrorRegistryVersion;

  constructor(version: ErrorRegistryVersion) {
    this.version = version;
  }

  versionOf(): ErrorRegistryVersion {
    return this.version;
  }

  /** The sorted immutable descriptors of this version. */
  codes(): ErrorCodeDescriptor[] {
    return [...codesFor(this.version)];
  }

  /** Reports whether an exact full code is registered. */
  contains(candidate: string): boolean {
    return this.descriptor(candidate) !== undefined;
  }

  /** Returns the exact registered descriptor, or undefined. */
  descriptor(candidate: string): ErrorCodeDescriptor | undefined {
    const records = codesFor(this.version);
    let low = 0;
    let high = records.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (records[mid].code < candidate) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    const found = records[low];
    return found !== undefined && found.code === candidate ? found : undefined;
  }

  /** Rejects an unregistered public code (error_registry.rs:1495-1510). */
  validate(candidate: string): void {
    this.validateAt(candidate, '$.code');
  }

  validateAt(candidate: string, path: string): void {
    if (!this.contains(candidate)) {
      throw new Error(`unregistered public code: ${candidate} at ${path}`);
    }
  }
}

function errorCode(
  code: string,
  category: DiagnosticCategory,
  introduced: string,
  description: string,
): ErrorCodeDescriptor {
  return { code, category, introduced, description };
}

/**
 * Merges two strictly sorted code lists into one strictly sorted list,
 * rejecting duplicates (the Rust const-merge builders, error_registry.rs:412-1367).
 */
function mergeErrorCodes(
  old: readonly ErrorCodeDescriptor[],
  added: readonly ErrorCodeDescriptor[],
): ErrorCodeDescriptor[] {
  const merged: ErrorCodeDescriptor[] = [];
  let left = 0;
  let right = 0;
  while (left < old.length && right < added.length) {
    if (old[left].code < added[right].code) {
      merged.push(old[left]);
      left++;
    } else {
      merged.push(added[right]);
      right++;
    }
  }
  for (; left < old.length; left++) {
    merged.push(old[left]);
  }
  for (; right < added.length; right++) {
    merged.push(added[right]);
  }
  return merged;
}

/** The frozen records of one semantic-model version (55/62/90/92/132/166/187). */
function codesFor(version: ErrorRegistryVersion): readonly ErrorCodeDescriptor[] {
  switch (version) {
    case 1:
      return ERROR_CODES_V1;
    case 2:
      return mergeErrorCodes(ERROR_CODES_V1, NEW_CODES_V2);
    case 3:
      return mergeErrorCodes(codesFor(2), NEW_CODES_V3);
    case 4:
      return mergeErrorCodes(codesFor(3), NEW_CODES_V4);
    case 5:
      return mergeErrorCodes(codesFor(4), NEW_CODES_V5);
    case 6:
      return mergeErrorCodes(codesFor(5), NEW_CODES_V6);
    case 7:
      return mergeErrorCodes(codesFor(6), NEW_CODES_V7);
  }
}

/** The semantic-model v1 records (55 codes, ERROR_CODES_V1). */
const ERROR_CODES_V1: readonly ErrorCodeDescriptor[] = [
  errorCode('core.diagnostic.truncated@1', 'Resource', '0.1.0', 'Diagnostic limit truncated a sequence'),
  errorCode('core.parse.resource-limit@1', 'Resource', '0.1.0', 'Parser resource limit was reached'),
  errorCode('core.projection.conflicting-policy@1', 'Projection', '0.1.0', 'Projection policy rules conflict'),
  errorCode('core.projection.invalid-policy-target@1', 'Projection', '0.1.0', 'Projection policy target is invalid'),
  errorCode('core.projection.resource-limit@1', 'Resource', '0.1.0', 'Projection resource limit was reached'),
  errorCode('core.projection.target-not-applicable@1', 'Projection', '0.1.0', 'Projection target does not apply'),
  errorCode('core.projection.wrong-snapshot-policy@1', 'Projection', '0.1.0', 'Projection policy uses another snapshot'),
  errorCode('core.protocol.invalid-json@1', 'Encoding', '0.3.0', 'Protocol JSON is invalid'),
  errorCode('core.protocol.invalid-pvce@1', 'Encoding', '0.3.0', 'Protocol PVCE is invalid'),
  errorCode('core.protocol.invalid-value@1', 'Encoding', '0.3.0', 'Protocol field value violates its invariant'),
  errorCode('core.protocol.missing-field@1', 'Encoding', '0.3.0', 'Required protocol field is absent'),
  errorCode('core.protocol.non-canonical-json@1', 'Encoding', '0.3.0', 'Protocol JSON is not canonical'),
  errorCode('core.protocol.process-local-handle@1', 'Encoding', '0.3.0', 'Process-local handle cannot cross the wire'),
  errorCode('core.protocol.resource-limit@1', 'Resource', '0.3.0', 'Protocol resource limit was reached'),
  errorCode('core.protocol.schema-mismatch@1', 'Encoding', '0.3.0', 'Protocol schema or field order does not match'),
  errorCode('core.protocol.unknown-contract@1', 'Encoding', '0.3.0', 'Protocol contract ID or version is unknown'),
  errorCode('core.protocol.unknown-field@1', 'Encoding', '0.3.0', 'Fixed protocol schema contains an unknown field'),
  errorCode('core.protocol.wrong-type@1', 'Encoding', '0.3.0', 'Protocol field has the wrong value type'),
  errorCode('core.query.cancelled@1', 'Query', '0.3.0', 'Query execution was cancelled'),
  errorCode('core.query.cardinality-violation@1', 'Query', '0.3.0', 'Query selection cardinality was violated'),
  errorCode('core.query.domain-mismatch@1', 'Query', '0.3.0', 'Query domain is unknown or mismatched'),
  errorCode('core.query.invalid-argument@1', 'Query', '0.3.0', 'Query operator argument is invalid'),
  errorCode('core.query.invalid-composition@1', 'Query', '0.3.0', 'Query operator roles cannot be composed'),
  errorCode('core.query.missing-capability@1', 'Query', '0.3.0', 'Query implementation lacks a required capability'),
  errorCode('core.query.required-type-mismatch@1', 'Query', '0.3.0', 'Required query value type did not match'),
  errorCode('core.query.resource-limit@1', 'Resource', '0.3.0', 'Query resource limit was reached'),
  errorCode('core.query.target-unavailable@1', 'Query', '0.3.0', 'Target native semantics are unavailable'),
  errorCode('core.query.unknown-operator@1', 'Query', '0.3.0', 'Query operator ID or version is unknown'),
  errorCode('core.query.wrong-argument-type@1', 'Query', '0.3.0', 'Query operator argument has the wrong type'),
  errorCode('core.source.invalid-utf8@1', 'Lexical', '0.1.0', 'Source bytes are not valid UTF-8'),
  errorCode('json.edit.representation-fallback@1', 'Edit', '0.1.0', 'JSON edit used an authorized canonical fallback'),
  errorCode('json.object.duplicate-member@1', 'Semantic', '0.1.0', 'JSON object contains duplicate member names'),
  errorCode('json.projection.duplicate-keys@1', 'Projection', '0.1.0', 'JSON projection encountered duplicate keys'),
  errorCode('json.projection.semantic-unavailable@1', 'Projection', '0.1.0', 'Recovered JSON region lacks native semantics'),
  errorCode('json.strict.comment-not-allowed@1', 'Conformance', '0.1.0', 'Strict JSON profile rejects comments'),
  errorCode('json.strict.leading-bom@1', 'Conformance', '0.1.0', 'Strict JSON source has a leading BOM'),
  errorCode('json.strict.trailing-comma@1', 'Conformance', '0.1.0', 'Strict JSON profile rejects trailing commas'),
  errorCode('json.syntax.expected-object-key@1', 'Syntax', '0.1.0', 'JSON object key was expected'),
  errorCode('json.syntax.expected-value@1', 'Syntax', '0.1.0', 'JSON value was expected'),
  errorCode('json.syntax.invalid-number@1', 'Syntax', '0.1.0', 'JSON number syntax is invalid'),
  errorCode('json.syntax.invalid-string-escape@1', 'Syntax', '0.1.0', 'JSON string escape is invalid'),
  errorCode('json.syntax.missing-array-close@1', 'Syntax', '0.1.0', 'JSON array close delimiter is missing'),
  errorCode('json.syntax.missing-colon@1', 'Syntax', '0.1.0', 'JSON member colon is missing'),
  errorCode('json.syntax.missing-comma@1', 'Syntax', '0.1.0', 'JSON container comma is missing'),
  errorCode('json.syntax.missing-object-close@1', 'Syntax', '0.1.0', 'JSON object close delimiter is missing'),
  errorCode('json.syntax.missing-value@1', 'Syntax', '0.1.0', 'JSON value is missing'),
  errorCode('json.syntax.trailing-content@1', 'Syntax', '0.1.0', 'JSON has trailing content'),
  errorCode('json.syntax.unexpected-character@1', 'Syntax', '0.1.0', 'JSON has an unexpected character'),
  errorCode('json.syntax.unexpected-word@1', 'Syntax', '0.1.0', 'JSON has an unexpected word'),
  errorCode('json.syntax.unterminated-block-comment@1', 'Syntax', '0.1.0', 'JSONC block comment is unterminated'),
  errorCode('json.syntax.unterminated-string@1', 'Syntax', '0.1.0', 'JSON string is unterminated'),
  errorCode('toml.edit.representation-fallback@1', 'Edit', '0.2.0', 'TOML edit used an authorized canonical fallback'),
  errorCode('toml.parse.syntax@1', 'Syntax', '0.2.0', 'TOML syntax is invalid'),
  errorCode('toml.projection.core-invariant@1', 'Projection', '0.2.0', 'TOML projection hit a core invariant'),
  errorCode('toml.projection.unrepresentable-datetime@1', 'Projection', '0.2.0', 'TOML temporal value is not exactly representable'),
];

/** The semantic-model v2 additions (7 codes). */
const NEW_CODES_V2: readonly ErrorCodeDescriptor[] = [
  errorCode('core.source.encoding-conflict@1', 'Encoding', '0.4.0', 'Source encoding facts conflict'),
  errorCode('core.source.invalid-sequence@1', 'Lexical', '0.4.0', 'Source bytes are invalid for the selected encoding'),
  errorCode('core.source.patch-base-mismatch@1', 'Edit', '0.4.0', 'SourcePatch base digest does not match'),
  errorCode('core.source.patch-original-mismatch@1', 'Edit', '0.4.0', 'SourcePatch original-byte precondition does not match'),
  errorCode('core.source.patch-target-mismatch@1', 'Edit', '0.4.0', 'SourcePatch target digest does not match'),
  errorCode('core.source.resource-limit@1', 'Resource', '0.4.0', 'Source construction or patch limit was reached'),
  errorCode('core.source.unsupported-bom@1', 'Encoding', '0.4.0', 'Source begins with an unsupported byte-order mark'),
];

/** The semantic-model v3 additions (28 codes). */
const NEW_CODES_V3: readonly ErrorCodeDescriptor[] = [
  errorCode('core.conversion.materialization-failed@1', 'Conversion', '0.5.0', 'Conversion target materialization failed'),
  errorCode('core.conversion.projection-failed@1', 'Conversion', '0.5.0', 'Conversion source projection failed'),
  errorCode('core.conversion.unauthorized-loss@1', 'Conversion', '0.5.0', 'Conversion encountered loss without explicit authorization'),
  errorCode('core.edit.conflicting-edits@1', 'Edit', '0.5.0', 'Edit operations have conflicting source ownership'),
  errorCode('core.edit.duplicate-key@1', 'Edit', '0.5.0', 'Edit would create a duplicate key'),
  errorCode('core.edit.exact-literal-requires-literal@1', 'Edit', '0.5.0', 'Exact literal policy requires a literal operation'),
  errorCode('core.edit.formation-failed@1', 'Edit', '0.5.0', 'Edited bytes did not form the required target document'),
  errorCode('core.edit.incomplete-target@1', 'Edit', '0.5.0', 'Edit target is not a complete syntax node'),
  errorCode('core.edit.invalid-literal@1', 'Edit', '0.5.0', 'Edit literal is invalid for the target profile'),
  errorCode('core.edit.operation-unsupported@1', 'Edit', '0.5.0', 'Edit operation is not supported for the target'),
  errorCode('core.edit.precondition-failed@1', 'Edit', '0.5.0', 'Edit original-byte or digest precondition failed'),
  errorCode('core.edit.representation-incompatible@1', 'Edit', '0.5.0', 'Edit representation policy cannot preserve the target category'),
  errorCode('core.edit.resource-limit@1', 'Resource', '0.5.0', 'Edit planning or commit resource limit was reached'),
  errorCode('core.edit.semantic-unavailable@1', 'Edit', '0.5.0', 'Edit target native semantics are unavailable'),
  errorCode('core.edit.target-not-found@1', 'Edit', '0.5.0', 'Edit target or placement anchor was not found'),
  errorCode('core.edit.unsupported-value@1', 'Edit', '0.5.0', 'Edit value is not representable by the target profile'),
  errorCode('core.edit.wrong-role@1', 'Edit', '0.5.0', 'Edit target has the wrong structural role'),
  errorCode('core.edit.wrong-snapshot@1', 'Edit', '0.5.0', 'Edit target belongs to another snapshot'),
  errorCode('core.materialization.formation-failed@1', 'Materialization', '0.5.0', 'Generated bytes did not form the target profile'),
  errorCode('core.materialization.invalid-request@1', 'Materialization', '0.5.0', 'Materialization request fields are contradictory'),
  errorCode('core.materialization.mapping-transformed@1', 'Materialization', '0.5.0', 'Ordered mapping was explicitly transformed into an object'),
  errorCode('core.materialization.resource-limit@1', 'Resource', '0.5.0', 'Materialization resource limit was reached'),
  errorCode('core.materialization.unrepresentable@1', 'Materialization', '0.5.0', 'Portable input cannot be represented by the target profile'),
  errorCode('core.materialization.unsupported-encoding@1', 'Encoding', '0.5.0', 'Target profile does not support the requested encoding'),
  errorCode('core.materialization.unsupported-newline@1', 'Materialization', '0.5.0', 'Target style does not support the requested newline policy'),
  errorCode('core.materialization.unsupported-profile@1', 'Materialization', '0.5.0', 'Requested materialization profile is unavailable'),
  errorCode('core.materialization.unsupported-style@1', 'Materialization', '0.5.0', 'Requested materialization style is unavailable'),
  errorCode('json.projection.structure-reencoded@1', 'Projection', '0.5.0', 'JSON object structure was reversibly represented as an entry mapping'),
];

/** The semantic-model v4 additions (2 codes). */
const NEW_CODES_V4: readonly ErrorCodeDescriptor[] = [
  errorCode('json5.string.unescaped-line-separator@1', 'Conformance', '0.6.0', 'JSON5 string contains an unescaped Unicode line separator'),
  errorCode('json5.syntax.invalid-identifier@1', 'Syntax', '0.6.0', 'JSON5 IdentifierName syntax is invalid'),
];

/** The semantic-model v5 additions (40 codes). */
const NEW_CODES_V5: readonly ErrorCodeDescriptor[] = [
  errorCode('core.graph.invalid@1', 'Semantic', '0.7.0', 'PortableGraph construction invariants were violated'),
  errorCode('core.graph.resource-limit@1', 'Resource', '0.7.0', 'PortableGraph construction or traversal limit was reached'),
  errorCode('core.pgce.invalid@1', 'Encoding', '0.7.0', 'PGCE input is structurally invalid'),
  errorCode('core.pgce.non-canonical@1', 'Encoding', '0.7.0', 'PGCE input is valid but not canonical'),
  errorCode('core.pgce.resource-limit@1', 'Resource', '0.7.0', 'PGCE encode or decode limit was reached'),
  errorCode('core.pgce.unsupported-version@1', 'Encoding', '0.7.0', 'PGCE wire version is unsupported'),
  errorCode('yaml.alias.name-mismatch@1', 'Semantic', '0.7.0', 'YAML alias name does not match its resolved anchor'),
  errorCode('yaml.alias.name-unavailable@1', 'Semantic', '0.7.0', 'YAML alias event lacks a usable name'),
  errorCode('yaml.anchor.name-unavailable@1', 'Semantic', '0.7.0', 'YAML anchor event lacks a usable name'),
  errorCode('yaml.anchor.unknown@1', 'Semantic', '0.7.0', 'YAML alias refers to an undefined anchor'),
  errorCode('yaml.edit.anchor-dependency@1', 'Edit', '0.7.0', 'YAML edit would leave a live alias without its anchor'),
  errorCode('yaml.edit.anchor-not-visible@1', 'Edit', '0.7.0', 'YAML alias insertion target is not the visible anchor definition'),
  errorCode('yaml.edit.canonical-fallback@1', 'Edit', '0.7.0', 'YAML edit used an authorized canonical scalar fallback'),
  errorCode('yaml.edit.invalid-anchor-name@1', 'Edit', '0.7.0', 'YAML anchor edit name is invalid'),
  errorCode('yaml.edit.invalid-placement@1', 'Edit', '0.7.0', 'YAML structural edit placement is invalid'),
  errorCode('yaml.edit.structural-container-conflict@1', 'Edit', '0.7.0', 'Multiple structural edits target the same base YAML container'),
  errorCode('yaml.mapping.missing-value@1', 'Semantic', '0.7.0', 'YAML mapping event stream lacks an association value'),
  errorCode('yaml.materialization.cross-document-sharing@1', 'Materialization', '0.7.0', 'YAML cannot preserve graph sharing across document roots'),
  errorCode('yaml.materialization.round-trip-mismatch@1', 'Materialization', '0.7.0', 'Generated YAML did not reproduce the promised input value'),
  errorCode('yaml.materialization.tag-kind-mismatch@1', 'Materialization', '0.7.0', 'YAML tag is incompatible with the graph node kind'),
  errorCode('yaml.materialization.unsupported-tag@1', 'Materialization', '0.7.0', 'YAML materializer has no published constructor for a tag'),
  errorCode('yaml.native.invalid-source-span@1', 'Semantic', '0.7.0', 'YAML native event span is outside the source snapshot'),
  errorCode('yaml.native.trailing-events@1', 'Semantic', '0.7.0', 'YAML native composition left trailing structural events'),
  errorCode('yaml.native.trailing-named-occurrence@1', 'Semantic', '0.7.0', 'YAML native composition left an unmatched anchor or alias occurrence'),
  errorCode('yaml.native.unexpected-end@1', 'Semantic', '0.7.0', 'YAML native event stream ended unexpectedly'),
  errorCode('yaml.native.unexpected-event@1', 'Semantic', '0.7.0', 'YAML native event order is invalid'),
  errorCode('yaml.parse.syntax@1', 'Syntax', '0.7.0', 'YAML source does not satisfy the selected grammar'),
  errorCode('yaml.profile.version-directive@1', 'Conformance', '0.7.0', 'YAML version directive conflicts with the selected profile'),
  errorCode('yaml.projection.cycle@1', 'Projection', '0.7.0', 'YAML representation cycle cannot enter a PortableValue tree'),
  errorCode('yaml.projection.document-cardinality@1', 'Projection', '0.7.0', 'YAML stream cardinality does not satisfy a single-value projection'),
  errorCode('yaml.projection.graph-invalid@1', 'Projection', '0.7.0', 'YAML representation graph could not form a PortableGraph'),
  errorCode('yaml.projection.invalid-canonical-scalar@1', 'Projection', '0.7.0', 'YAML canonical scalar cannot form its promised PortableValue kind'),
  errorCode('yaml.projection.mapping-not-object@1', 'Projection', '0.7.0', 'YAML mapping does not satisfy the requested Object policy'),
  errorCode('yaml.projection.provenance-limit@1', 'Resource', '0.7.0', 'YAML graph projection provenance limit was reached'),
  errorCode('yaml.projection.resource-limit@1', 'Resource', '0.7.0', 'YAML value or graph projection limit was reached'),
  errorCode('yaml.projection.sharing@1', 'Projection', '0.7.0', 'YAML shared identity requires explicit tree-duplication policy'),
  errorCode('yaml.projection.unrepresentable-timestamp@1', 'Projection', '0.7.0', 'YAML timestamp is outside PortableValue temporal categories'),
  errorCode('yaml.projection.unsupported-tag@1', 'Projection', '0.7.0', 'YAML tag has no published target projection semantics'),
  errorCode('yaml.scalar.invalid-explicit-tag@1', 'Semantic', '0.7.0', 'YAML scalar content is invalid for its explicit tag'),
  errorCode('yaml.tag.kind-mismatch@1', 'Semantic', '0.7.0', 'YAML tag is incompatible with the representation node kind'),
];

/** The semantic-model v6 additions (34 codes). */
const NEW_CODES_V6: readonly ErrorCodeDescriptor[] = [
  errorCode('core.source.code-page-required@1', 'Encoding', '0.8.0', 'The selected source profile requires an explicit Windows code page'),
  errorCode('core.source.unsupported-code-page@1', 'Encoding', '0.8.0', 'The requested Windows code page is not in the portable registry'),
  errorCode('ini.edit.canonical-fallback@1', 'Edit', '0.8.0', 'INI editing used an authorized canonical representation fallback'),
  errorCode('ini.edit.case-collision@1', 'Edit', '0.8.0', 'INI editing would create a profile-equivalent name collision'),
  errorCode('ini.edit.invalid-name@1', 'Edit', '0.8.0', 'INI section or entry name is invalid for the selected profile'),
  errorCode('ini.edit.invalid-placement@1', 'Edit', '0.8.0', 'INI structural edit placement is invalid'),
  errorCode('ini.formation.case-collision@1', 'Semantic', '0.8.0', 'INI formation found profile-equivalent names with different spelling'),
  errorCode('ini.formation.duplicate-entry@1', 'Semantic', '0.8.0', 'INI formation found a duplicate entry'),
  errorCode('ini.formation.duplicate-section@1', 'Semantic', '0.8.0', 'INI formation found a duplicate section'),
  errorCode('ini.materialization.round-trip-mismatch@1', 'Materialization', '0.8.0', 'Generated INI did not reproduce the promised input value'),
  errorCode('ini.parse.invalid-character@1', 'Syntax', '0.8.0', 'INI source contains a character forbidden by the selected profile'),
  errorCode('ini.parse.invalid-continuation@1', 'Syntax', '0.8.0', 'INI continuation syntax is invalid'),
  errorCode('ini.parse.malformed-line@1', 'Syntax', '0.8.0', 'INI source line is malformed'),
  errorCode('ini.parse.malformed-section@1', 'Syntax', '0.8.0', 'INI section header is malformed'),
  errorCode('ini.parse.missing-delimiter@1', 'Syntax', '0.8.0', 'INI entry is missing a required key/value delimiter'),
  errorCode('ini.parse.missing-section@1', 'Conformance', '0.8.0', 'INI entry appears where the selected profile requires a section'),
  errorCode('ini.profile.encoding@1', 'Encoding', '0.8.0', 'INI source encoding conflicts with the selected profile'),
  errorCode('ini.profile.mismatch@1', 'Conformance', '0.8.0', 'INI operation profile does not match the document profile'),
  errorCode('ini.projection.collision@1', 'Projection', '0.8.0', 'INI projection encountered a rejected key or section collision'),
  errorCode('ini.projection.duplicate-collapsed@1', 'Projection', '0.8.0', 'INI projection collapsed a duplicate under explicit policy'),
  errorCode('ini.projection.incomplete-document@1', 'Projection', '0.8.0', 'Recovered INI syntax cannot enter a complete semantic projection'),
  errorCode('ini.query.invalid-name-mode@1', 'Query', '0.8.0', 'INI query name comparison mode is invalid'),
  errorCode('java-properties.edit.canonical-fallback@1', 'Edit', '0.8.0', 'Properties editing used an authorized canonical representation fallback'),
  errorCode('java-properties.edit.invalid-placement@1', 'Edit', '0.8.0', 'Properties structural edit placement is invalid'),
  errorCode('java-properties.java-string.invalid-wire@1', 'Encoding', '0.8.0', 'Exact Java UTF-16 string wire content is invalid'),
  errorCode('java-properties.java-string.non-canonical-wire@1', 'Encoding', '0.8.0', 'Exact Java UTF-16 string wire content is not canonical'),
  errorCode('java-properties.materialization.round-trip-mismatch@1', 'Materialization', '0.8.0', 'Generated Properties text did not reproduce the promised input value'),
  errorCode('java-properties.parse.malformed-unicode-escape@1', 'Syntax', '0.8.0', 'Properties Unicode escape is malformed'),
  errorCode('java-properties.profile.mismatch@1', 'Conformance', '0.8.0', 'Properties operation profile does not match the document profile'),
  errorCode('java-properties.projection.duplicate-collapsed@1', 'Projection', '0.8.0', 'Properties projection collapsed a duplicate under explicit policy'),
  errorCode('java-properties.projection.incomplete-document@1', 'Projection', '0.8.0', 'Recovered Properties syntax cannot enter a complete semantic projection'),
  errorCode('java-properties.projection.unpaired-surrogate@1', 'Projection', '0.8.0', 'Properties content with an unpaired surrogate cannot become a PortableValue String'),
  errorCode('java-properties.query.invalid-code-unit-filter@1', 'Query', '0.8.0', 'Properties query UTF-16 code-unit filter is invalid'),
  errorCode('java-properties.source.profile-encoding@1', 'Encoding', '0.8.0', 'Properties source encoding conflicts with the selected profile'),
];

/** The semantic-model v7 additions (21 codes: the RFC 0015 CLI family of 20 plus json.projection.incomplete-document@1). */
const NEW_CODES_V7: readonly ErrorCodeDescriptor[] = [
  errorCode('cli.data.invalid-request@1', 'Encoding', '0.12.0', 'Request or plan file failed strict decoding'),
  errorCode('cli.data.io@1', 'Encoding', '0.12.0', 'Input file could not be read'),
  errorCode('cli.detection.ambiguous@1', 'Semantic', '0.12.0', 'Candidate profiles are ambiguous and no profile was selected'),
  errorCode('cli.internal.unclassified@1', 'Semantic', '0.12.0', 'Unclassified internal CLI error'),
  errorCode('cli.interrupted.signal@1', 'Semantic', '0.12.0', 'CLI execution was interrupted by a signal'),
  errorCode('cli.limit.batch-count@1', 'Resource', '0.12.0', 'Batch file count exceeded the configured limit'),
  errorCode('cli.limit.file-size@1', 'Resource', '0.12.0', 'Input file exceeded the CLI file-size limit'),
  errorCode('cli.limit.manifest-size@1', 'Resource', '0.12.0', 'Manifest or request input exceeded the size limit'),
  errorCode('cli.usage.invalid-argument@1', 'Syntax', '0.12.0', 'Known argument received an invalid value'),
  errorCode('cli.usage.invalid-format@1', 'Syntax', '0.12.0', '--format is missing or invalid'),
  errorCode('cli.usage.missing-plan@1', 'Syntax', '0.12.0', '--apply requires a prior plan'),
  errorCode('cli.usage.missing-required@1', 'Syntax', '0.12.0', 'A required argument such as --profile is missing'),
  errorCode('cli.usage.redaction-pattern@1', 'Syntax', '0.12.0', '--redact-keys pattern is invalid'),
  errorCode('cli.usage.unknown-argument@1', 'Syntax', '0.12.0', 'Unknown argument or rejected abbreviation'),
  errorCode('cli.usage.unknown-command@1', 'Syntax', '0.12.0', 'Unknown command'),
  errorCode('cli.write.io@1', 'Edit', '0.12.0', 'Write I/O failure such as a full disk'),
  errorCode('cli.write.permission@1', 'Edit', '0.12.0', 'Permission denied while writing the target'),
  errorCode('cli.write.read-only@1', 'Edit', '0.12.0', 'Target file is read-only'),
  errorCode('cli.write.symlink-policy@1', 'Edit', '0.12.0', 'Write path rejected by the symlink policy'),
  errorCode('cli.write.target-is-directory@1', 'Edit', '0.12.0', 'Write target is a directory'),
  // Registered in 0.13.0 (audit finding F3): the json Recovered-document
  // gate emits this code and the CLI's failed projection record requires it
  // to be registry-validated.
  errorCode('json.projection.incomplete-document@1', 'Projection', '0.13.0', 'Recovered JSON syntax cannot enter a complete semantic projection'),
];

/** Encodes the `core.error-code-registry@1` payload of one registry version. */
export function errorCodeManifestValue(registry: ErrorCodeRegistry): ObjectValue {
  const items: PortableValue[] = registry.codes().map((descriptor) => {
    return {
      kind: 'Object' as const,
      entries: [
        { key: 'code', value: { kind: 'String' as const, value: descriptor.code } },
        { key: 'category', value: { kind: 'String' as const, value: descriptor.category } },
        { key: 'introduced', value: { kind: 'String' as const, value: descriptor.introduced } },
        { key: 'stability', value: { kind: 'String' as const, value: 'Stable' } },
        { key: 'description', value: { kind: 'String' as const, value: descriptor.description } },
      ],
    };
  });
  return {
    kind: 'Object',
    entries: [
      { key: 'schema', value: { kind: 'String', value: 'core.error-code-registry@1' } },
      { key: 'error_codes', value: { kind: 'Sequence', items } },
    ],
  };
}

/** The v7 error-code manifest payload. */
export function errorCodeManifestValueV7(): ObjectValue {
  return errorCodeManifestValue(new ErrorCodeRegistry(7));
}

/**
 * Strictly validates one transferable `core.error-code-registry@1` value
 * (error_registry.rs:1596-1645). Identity, ordering, category, and stability
 * are normative; the descriptions are presentation metadata.
 */
export function validateErrorCodeManifestValue(value: PortableValue): void {
  const fields = schemaFields(value, 'core.error-code-registry@1', ['error_codes'], '$');
  let previous: string | undefined;
  for (const [index, item] of sequenceOf(fields[0], '$.error_codes').entries()) {
    const path = `$.error_codes[${index}]`;
    const record = exactFields(
      item,
      ['code', 'category', 'introduced', 'stability', 'description'],
      path,
    );
    const code = stringOf(record[0], `${path}.code`);
    validateVersionedCode(code, `${path}.code`);
    validateManifestCategory(record[1], `${path}.category`);
    if (
      stringOf(record[2], `${path}.introduced`) === '' ||
      stringOf(record[4], `${path}.description`) === ''
    ) {
      throw invalid(path, 'introduced and description must be non-empty');
    }
    if (stringOf(record[3], `${path}.stability`) !== 'Stable') {
      throw invalid(`${path}.stability`, 'unknown error-code stability');
    }
    if (previous !== undefined && previous >= code) {
      throw invalid('$.error_codes', 'error codes must be sorted and unique');
    }
    previous = code;
  }
}

/** Requires one canonical category spelling (error_registry.rs:1673-1683). */
function validateManifestCategory(value: PortableValue, path: string): void {
  const category = stringOf(value, path);
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    throw invalid(path, 'unknown error-code category');
  }
}

/** Validates one `id@version` code spelling (error_registry.rs:1647-1655). */
function validateVersionedCode(code: string, path: string): void {
  const at = code.lastIndexOf('@');
  const idPart = at < 0 ? '' : code.slice(0, at);
  const versionText = at < 0 ? '' : code.slice(at + 1);
  if (at < 0 || versionText === '') {
    throw invalid(path, 'code lacks @version suffix');
  }
  if (!/^[0-9]+$/.test(versionText)) {
    throw invalid(path, 'code version is invalid');
  }
  const version = BigInt(versionText);
  if (version === 0n || version > 0xffffffffn) {
    throw invalid(path, 'code version is invalid');
  }
  validateManifestIdentifier(idPart, path);
}

/** The strict dotted identifier rule of the error-code manifest (contract.rs:559-578). */
function validateManifestIdentifier(identifier: string, path: string): void {
  if (identifier.length > 255 || !identifier.includes('.')) {
    throw invalid(path, 'identifier must contain multiple segments and be at most 255 bytes');
  }
  for (const segment of identifier.split('.')) {
    if (segment === '' || !isManifestLower(segment.charCodeAt(0))) {
      throw invalid(path, 'identifier contains an invalid segment');
    }
    for (let offset = 1; offset < segment.length; offset++) {
      const code = segment.charCodeAt(offset);
      if (!isManifestLower(code) && (code < 0x30 || code > 0x39) && code !== 0x2d) {
        throw invalid(path, 'identifier contains an invalid segment');
      }
    }
  }
}

function isManifestLower(code: number): boolean {
  return code >= 0x61 && code <= 0x7a;
}

// The error-code-registry payload dispatch (payload.rs:60): the envelope
// validates every core.error-code-registry@1 payload through the strict
// manifest validator at module load.
registerPayloadValidator('core.error-code-registry', 1, (payload) => {
  validateErrorCodeManifestValue(payload);
});
