/**
 * Consema SDK chain example (TypeScript): one JSON document through the full
 * SDK surface — parse, native semantic query, best-exact projection,
 * structural edit, canonical materialization, and cross-format conversion to
 * TOML.
 *
 * Scenario: read `{"a":1,"b":{"c":2}}` under `json.strict`, query `b.c`
 * (`json.native-semantic-query@1`), project
 * `json.projection.best-exact-core@1`, edit `a` to `42` (semantic scalar
 * replacement, `CanonicalForProfile` representation), materialize the edited
 * value as canonical compact JSON, and convert the edited document to TOML
 * (`toml.canonical-document`).
 *
 * Run: `cd typescript && node examples/sdk_chain.ts` (node 26 runs .ts
 * natively; no build step).
 *
 * Language-neutral contract reference (consema spec repository):
 *   - https://github.com/consema/consema/blob/main/docs/cookbook.md — the CLI recipes for the same operations
 *   - https://github.com/consema/consema/blob/main/docs/multi-language-implementation-plan.md — the five-language SDK design
 */
import { integerValue, stringValue } from '../src/core/value.ts';
import { MaterializationRequest, MaterializationStyleId } from '../src/document/materialization.ts';
import { ProfileId } from '../src/document/profile.ts';
import { convertJson } from '../src/convert.ts';
import { JsonValue } from '../src/json/document.ts';
import { EditTransactionBuilder, commitEdits } from '../src/json/edit.ts';
import { materialize } from '../src/json/materialization.ts';
import { ProjectionRequestBuilder, project } from '../src/json/projection.ts';
import { CancellationToken, QueryLimits, executeJsonQuery } from '../src/json/query.ts';
import {
  bindQuery,
  domainJSONNativeV1,
  newOperatorCall,
  newQueryDefinition,
  validateQuery,
  withArgument,
  withExpression,
  withSelection,
} from '../src/protocol/query.ts';
import { CapabilitySet, newCapabilityId } from '../src/protocol/registry_descriptor.ts';
import { Document, parseDocument } from '../src/registry.ts';

/** Applies one operator to an expression (the Rust `then` builder). */
function apply(
  input: import('../src/protocol/query.ts').QueryExpression,
  operator: import('../src/protocol/query.ts').OperatorCall,
): import('../src/protocol/query.ts').QueryExpression {
  return { kind: 'Apply', input, operator };
}

/** Returns the value of one object member by decoded name, walking
 * `objectMembers()` with an explicit SemanticAvailability pattern match. */
function memberValueRef(value: JsonValue, name: string): JsonValue {
  const availability = value.objectMembers();
  if (availability.kind !== 'Available' || availability.value === null) {
    throw new Error(`object member walk failed for '${name}' (${availability.kind})`);
  }
  const member = availability.value.find((candidate) => {
    const candidateName = candidate.name();
    return candidateName.kind === 'Available' && candidateName.value === name;
  });
  if (member === undefined) {
    throw new Error(`member '${name}' not found`);
  }
  return member.value();
}

/** Projects one JSON document and renders its value as canonical compact
 * JSON bytes. */
function projectToJson(
  jsonDocument: import('../src/json/document.ts').JsonDocument,
  projectionRequest: import('../src/json/projection.ts').ProjectionRequest,
  compactRequest: MaterializationRequest,
): Uint8Array {
  const result = project(jsonDocument, projectionRequest);
  if (result.kind === 'Failed') {
    throw new Error(`projection failed: ${result.value.diagnostics()}`);
  }
  const materialized = materialize(result.value.value(), compactRequest);
  if (materialized.kind === 'Failed') {
    throw new Error(`materialization failed: ${materialized.value.failure().code}`);
  }
  return materialized.value.document().render();
}

const source = new TextEncoder().encode('{"a":1,"b":{"c":2}}');
const profile = new ProfileId('json.strict', 1);

// 1. Parse under the exact profile through the single facade parse entry.
const document: Document = parseDocument(source, profile);
if (document.formationStatus() !== 'Complete') {
  throw new Error(`expected a Complete document, got ${document.formationStatus()}`);
}
const renderText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
console.log(
  `parse: profile=${document.profile().id()} status=${document.formationStatus()} render=${renderText(document.render())}`,
);
const jsonDocument = document.asJson();
if (typeof jsonDocument === 'string') {
  throw new Error('source is not a JSON document');
}

// 2. Query `b.c` through the JSON native semantic domain.
let chain: import('../src/protocol/query.ts').QueryExpression = { kind: 'Input' };
chain = apply(chain, newOperatorCall('json.try-object-members', 1));
chain = apply(chain, withArgument(newOperatorCall('json.member-name-equals', 1), 'name', stringValue('b')));
chain = apply(chain, newOperatorCall('json.member-value', 1));
chain = apply(chain, newOperatorCall('json.try-object-members', 1));
chain = apply(chain, withArgument(newOperatorCall('json.member-name-equals', 1), 'name', stringValue('c')));
chain = apply(chain, newOperatorCall('json.member-value', 1));
const definition = withSelection(
  withExpression(newQueryDefinition(domainJSONNativeV1()), chain),
  'RequireOne',
);
const validated = validateQuery(definition);
if ('failure' in validated) {
  throw new Error(`query validation failed: ${validated.failure.code}`);
}
const capabilities = new CapabilitySet();
capabilities.insert(newCapabilityId('core.query.ordered-results', 1));
const bound = bindQuery(validated.query, capabilities);
if ('failure' in bound) {
  throw new Error(`query binding failed: ${bound.failure.code}`);
}
const execution = executeJsonQuery(
  bound.query,
  jsonDocument,
  new QueryLimits(1_000_000, 10_000_000),
  new CancellationToken(),
);
// Render the matched value through the semantic tree API (the same walk the
// edit target below uses).
const bValue = memberValueRef(jsonDocument.root(), 'b');
const cValue = memberValueRef(bValue, 'c');
const kindAvailability = cValue.kind();
const kind = kindAvailability.kind === 'Available' ? kindAvailability.value : '?';
const integerAvailability = cValue.asInteger();
const value =
  integerAvailability.kind === 'Available' && integerAvailability.value !== null
    ? integerAvailability.value.toString()
    : '?';
console.log(`query b.c: matches=${execution.matches().length} value=${value} kind=${kind}`);

// 3. Project the document with the conservative best-exact core target.
const projectionRequest = new ProjectionRequestBuilder('BestExactCoreV1').build();
const compactRequest = new MaterializationRequest(
  new ProfileId('json.strict', 1),
  new MaterializationStyleId('json.canonical-compact', 1),
).withNewline('None');
console.log(
  `project json.projection.best-exact-core@1: fidelity=Exact value=${renderText(projectToJson(jsonDocument, projectionRequest, compactRequest))}`,
);

// 4. Edit `a` to 42 with a semantic scalar replacement under the
//    profile-canonical representation policy.
const aValue = memberValueRef(jsonDocument.root(), 'a');
const transaction = new EditTransactionBuilder(jsonDocument)
  .semanticScalar(aValue.nodeRef(), integerValue(42n), 'CanonicalForProfile')
  .build();
const commit = commitEdits(jsonDocument, transaction);
const edited = commit.document();
console.log(`edit a->42 semantic_scalar CanonicalForProfile: render=${renderText(edited.render())}`);

// 5. Materialize the edited value as canonical compact JSON.
console.log(
  `materialize json.canonical-compact: ${renderText(projectToJson(edited, projectionRequest, compactRequest))}`,
);

// 6. Convert the edited JSON document to TOML (two-stage composition).
const tomlRequest = new MaterializationRequest(
  new ProfileId('toml.1.0', 1),
  new MaterializationStyleId('toml.canonical-document', 1),
).withMappingPolicy('UniqueStringEntriesToObject');
const conversion = convertJson(edited, projectionRequest, tomlRequest);
if (conversion.kind === 'Failed') {
  throw new Error(`conversion failed: ${conversion.value.code}`);
}
console.log('convert to toml.canonical-document:');
process.stdout.write(renderText(conversion.value.document().render()));
