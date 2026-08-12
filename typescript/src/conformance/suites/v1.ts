/**
 * `consema.conformance@1` runner (30 cases; mirror of
 * crates/consema-conformance/src/lib.rs:217-363).
 */

import { valueFromInput, bytesEqual } from '../helpers.ts';
import type { VectorCase } from '../helpers.ts';
import { caseField, caseFieldOptional, expectedField, expectedFieldOptional, hexToBytes, toHex, utf8 } from '../helpers.ts';
import { fail, skip, SkippedCase, expectThrowsCode } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import { binaryFloat64Value, nullValue, objectValue, sequenceValue } from '../../core/value.ts';
import { equal as coreEqual, hash as coreHash } from '../../core/equal.ts';
import { encode, decode, encodeBounded, defaultEncodeLimits, defaultDecodeLimits } from '../../core/pvce.ts';
import { PVCEError } from '../../core/errors.ts';
import { parse as parseJson } from '../../json/parser.ts';
import type { JsonDocument } from '../../json/document.ts';
import { FatalFormationFailure as JsonFormationFailure } from '../../json/errors.ts';
import { DEFAULT_PARSE_LIMITS } from '../../document/formation.ts';
import { EditTransactionBuilder, commitEdits } from '../../json/edit.ts';
import { EditFailure } from '../../json/errors.ts';
import { ProjectionRequestBuilder, project } from '../../json/projection.ts';
import { QueryLimits, CancellationToken, executeJsonQuery } from '../../json/query.ts';
import { newQueryDefinition, domainPortableValueV1, domainJSONNativeV1, withExpression, withSelection } from '../../protocol/query.ts';
import type { QueryDefinition, QuerySelection } from '../../protocol/query.ts';
import {
  executePortable,
  executePortableCursor,
  QueryExecutionFailure,
  queryFailureName,
  CancellationToken as QueryCancellationToken,
  defaultQueryExecutionLimits,
} from '../../core/query_execution.ts';
import { queryDefinitionToValue, queryDefinitionFromValue } from '../../protocol/records_query.ts';
import { pipelineExpression, validateAndBind, validationFailsComposition } from './query_pipeline.ts';

function profileOf(case_: VectorCase): 'JsonStrict' | 'JsoncBounded' | 'Json5Standard' {
  const profile = caseFieldOptional(case_, 'profile') as string | undefined;
  if (profile === undefined) {
    return 'JsonStrict';
  }
  switch (profile) {
    case 'json.strict@1':
      return 'JsonStrict';
    case 'jsonc.bounded@1':
      return 'JsoncBounded';
    case 'json5.standard@1':
      return 'Json5Standard';
    default:
      fail(`unknown profile ${profile}`);
  }
}

function parseJsonCase(case_: VectorCase): JsonDocument {
  const source = caseField(case_, 'source') as string;
  return parseJson(utf8(source), profileOf(case_), DEFAULT_PARSE_LIMITS);
}

/** core.value.strict-equality@1 */
function valueStrictEquality(case_: VectorCase): void {
  switch (case_.id) {
    case 'value.integer-arbitrary-precision': {
      const decimal = caseField(case_, 'decimal') as string;
      const expected = expectedField(case_, 'decimal') as string;
      const observed = BigInt(decimal).toString();
      if (observed !== expected) {
        fail(`integer: expected ${expected}, observed ${observed}`);
      }
      return;
    }
    case 'value.decimal-normalization': {
      const left = valueFromInput({ decimal: caseField(case_, 'left') as string });
      const right = valueFromInput({ decimal: caseField(case_, 'right') as string });
      const strictEqual = expectedField(case_, 'strict_equal') as boolean;
      const hashEqual = expectedField(case_, 'strict_hash_equal') as boolean;
      if (coreEqual(left, right) !== strictEqual) {
        fail(`strict_equal: expected ${strictEqual}`);
      }
      if ((coreHash(left) === coreHash(right)) !== hashEqual) {
        fail(`strict_hash_equal: expected ${hashEqual}`);
      }
      return;
    }
    case 'value.float-signed-zero': {
      const positive = binaryFloat64Value(BigInt(`0x${caseField(case_, 'positive_bits') as string}`));
      const negative = binaryFloat64Value(BigInt(`0x${caseField(case_, 'negative_bits') as string}`));
      const strictEqual = expectedField(case_, 'strict_equal') as boolean;
      if (coreEqual(positive, negative) !== strictEqual) {
        fail(`strict_equal: expected ${strictEqual}`);
      }
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.pvce.full@1 */
function pvceFull(case_: VectorCase): void {
  switch (case_.id) {
    case 'pvce.null-vector': {
      const expected = expectedField(case_, 'hex') as string;
      if (toHex(encode({ kind: 'Null' })) !== expected) {
        fail('pvce null vector mismatch');
      }
      return;
    }
    case 'pvce.negative-integer-vector': {
      const integer = BigInt(caseField(case_, 'integer') as string);
      const expected = expectedField(case_, 'hex') as string;
      if (toHex(encode({ kind: 'Integer', value: integer })) !== expected) {
        fail('pvce negative integer vector mismatch');
      }
      return;
    }
    case 'pvce.object-vector': {
      const object = valueFromInput(caseField(case_, 'object'));
      const expected = expectedField(case_, 'hex') as string;
      if (toHex(encode(object)) !== expected) {
        fail('pvce object vector mismatch');
      }
      return;
    }
    case 'pvce.reject-nonminimal-varint': {
      const bytes = hexToBytes(caseField(case_, 'hex') as string);
      try {
        decode(bytes, defaultDecodeLimits());
      } catch (error) {
        if (error instanceof PVCEError && error.kind === 'NonCanonicalVarint') {
          return;
        }
        fail(`expected NonCanonicalVarint, observed ${String(error)}`);
      }
      fail('expected a NonCanonicalVarint failure');
      return;
    }
    case 'pvce.encode-blob-limit': {
      const value = valueFromInput(caseField(case_, 'value'));
      const maxBlobBytes = caseField(case_, 'max_blob_bytes') as number;
      try {
        encodeBounded(value, { ...defaultEncodeLimits(), maxBlobBytes });
      } catch (error) {
        if (error instanceof PVCEError && error.kind === 'ResourceLimit') {
          return;
        }
        fail(`expected ResourceLimit, observed ${String(error)}`);
      }
      fail('expected a resource-limit failure');
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.document.exact-roundtrip@1 / json.document.recovery@1 / json.native.duplicate-members@1 / json.document.lossless-syntax@1 */
function jsonParse(case_: VectorCase): void {
  const document = parseJsonCase(case_);
  const expectedFormation = expectedFieldOptional(case_, 'formation') as string | undefined;
  if (expectedFormation !== undefined && document.formationStatus() !== expectedFormation) {
    fail(`formation: expected ${expectedFormation}, observed ${document.formationStatus()}`);
  }
  const renderEquals = expectedFieldOptional(case_, 'render_equals_source');
  if (renderEquals === true) {
    const source = caseField(case_, 'source') as string;
    if (!bytesEqual(document.render(), utf8(source))) {
      fail('render must equal the source');
    }
  }
  const diagnostic = expectedFieldOptional(case_, 'diagnostic');
  if (diagnostic !== undefined) {
    if (!document.diagnostics().some((item) => item.code === diagnostic)) {
      fail(`missing diagnostic ${String(diagnostic)}`);
    }
  }
  const memberNames = expectedFieldOptional(case_, 'member_names');
  if (memberNames !== undefined) {
    const members = document.root().objectMembers();
    if (members.kind !== 'Available' || members.value === null) {
      fail('object semantics unavailable');
    }
    const names = members.value.map((member) => {
      const name = member.name();
      return name.kind === 'Available' ? name.value : null;
    });
    if (names.length !== (memberNames as unknown[]).length) {
      fail('member name count mismatch');
    }
    (memberNames as unknown[]).forEach((expected, index) => {
      if (names[index] !== expected) {
        fail(`member ${index}: expected ${String(expected)}, observed ${String(names[index])}`);
      }
    });
    const distinctIdentity = expectedFieldOptional(case_, 'distinct_member_identity');
    if (distinctIdentity === true) {
      const identities = new Set(members.value.map((member) => nodeRefKey(member.nodeRef())));
      if (identities.size !== members.value.length) {
        fail('member identities must be distinct');
      }
    }
  }
  const gapCount = expectedFieldOptional(case_, 'gap_count');
  if (gapCount !== undefined) {
    const pieces = document.losslessStructuralIndex().pieces();
    let gaps = 0;
    let overlaps = 0;
    for (let index = 1; index < pieces.length; index++) {
      if (pieces[index - 1].span().endByte() < pieces[index].span().startByte()) {
        gaps += 1;
      }
      if (pieces[index - 1].span().endByte() > pieces[index].span().startByte()) {
        overlaps += 1;
      }
    }
    if (gaps !== gapCount) {
      fail(`gap_count: expected ${String(gapCount)}, observed ${gaps}`);
    }
    const overlapCount = expectedFieldOptional(case_, 'overlap_count');
    if (overlapCount !== undefined && overlaps !== overlapCount) {
      fail(`overlap_count: expected ${String(overlapCount)}, observed ${overlaps}`);
    }
    const covered = expectedFieldOptional(case_, 'covered_bytes');
    if (covered !== undefined) {
      const last = pieces[pieces.length - 1];
      const coveredBytes = last === undefined ? 0 : last.span().endByte();
      if (coveredBytes !== covered) {
        fail(`covered_bytes: expected ${String(covered)}, observed ${coveredBytes}`);
      }
    }
  }
}


/** core.query.ordered-results@1 */
function queryOrdered(case_: VectorCase): void {
  switch (case_.id) {
    case 'query.reject-role-mismatch': {
      const pipeline = caseField(case_, 'pipeline') as unknown[];
      const definition: import('../../protocol/query.ts').QueryDefinition = {
        domain: domainPortableValueV1(),
        expression: pipelineExpression(pipeline),
        selection: 'All',
      };
      if (!validationFailsComposition(definition)) {
        fail('expected InvalidOperatorComposition validation failure');
      }
      const terminal = expectedField(case_, 'status') as string;
      if (terminal !== 'FailedBeforeFirstMatch') {
        fail(`terminal: expected FailedBeforeFirstMatch, observed ${terminal}`);
      }
      return;
    }
    case 'query.json-duplicate-order': {
      const source = caseField(case_, 'source') as string;
      const memberName = caseField(case_, 'member_name') as string;
      const document = parseJson(utf8(source), 'JsonStrict', DEFAULT_PARSE_LIMITS);
      const definition: import('../../protocol/query.ts').QueryDefinition = {
        domain: domainJSONNativeV1(),
        expression: pipelineExpression([
          'json.try-object-members@1',
          ['json.member-name-equals@1', { name: { string: memberName } }],
        ]),
        selection: 'All',
      };
      const executable = validateAndBind(definition);
      const result = executeJsonQuery(executable, document, QueryLimits.defaults(), new CancellationToken());
      const expectedOrdinals = expectedField(case_, 'ordinals') as number[];
      const expectedCount = expectedField(case_, 'count') as number;
      if (result.matches().length !== expectedCount) {
        fail(`count: expected ${expectedCount}, observed ${result.matches().length}`);
      }
      const ordinals = result.matches().map((match) => (match.kind === 'ObjectMember' ? match.ordinal : -1));
      if (ordinals.length !== expectedOrdinals.length || ordinals.some((ordinal, index) => ordinal !== expectedOrdinals[index])) {
        fail(`ordinals: expected ${JSON.stringify(expectedOrdinals)}, observed ${JSON.stringify(ordinals)}`);
      }
      const terminal = expectedFieldOptional(case_, 'terminal');
      if (terminal !== undefined && terminal !== result.terminal()) {
        fail(`terminal: expected ${String(terminal)}`);
      }
      return;
    }
    case 'query.root-result-limit': {
      const pipeline = caseField(case_, 'pipeline') as unknown[];
      const maxResults = caseField(case_, 'max_results') as number;
      const definition: QueryDefinition = {
        domain: domainPortableValueV1(),
        expression: pipelineExpression(pipeline),
        selection: 'All',
      };
      const executable = validateAndBind(definition);
      try {
        executePortable(
          nullValue(),
          executable.validated.definition.expression,
          { ...defaultQueryExecutionLimits(), maxResults },
          new QueryCancellationToken(),
        );
      } catch (error) {
        if (error instanceof QueryExecutionFailure && error.kind === 'ResourceLimitExceeded') {
          const status = expectedField(case_, 'status') as string;
          if (status !== 'Failed') {
            fail(`status: expected Failed, observed ${status}`);
          }
          const failure = expectedField(case_, 'failure') as string;
          if (failure !== queryFailureName(error.kind)) {
            fail(`failure: expected ${failure}, observed ${queryFailureName(error.kind)}`);
          }
          if (error.code !== 'core.query.resource-limit@1') {
            fail(`code: expected core.query.resource-limit@1, observed ${error.code}`);
          }
          return;
        }
        throw error;
      }
      fail('execution must fail with ResourceLimitExceeded');
    }
    case 'query.cursor-failure-terminal': {
      const elements = caseField(case_, 'elements') as unknown[];
      const maxResults = caseField(case_, 'max_results') as number;
      const pipeline = caseField(case_, 'pipeline') as unknown[];
      const values = elements.map((element) => valueFromInput(element));
      const root = sequenceValue(values);
      const definition: QueryDefinition = {
        domain: domainPortableValueV1(),
        expression: pipelineExpression(pipeline),
        selection: 'All',
      };
      const executable = validateAndBind(definition);
      const cursor = executePortableCursor(
        root,
        executable.validated.definition.expression,
        maxResults,
        false,
      );
      let yielded = 0;
      while (cursor.next() !== null) {
        yielded += 1;
      }
      const expectedYielded = expectedField(case_, 'yielded_before_failure') as number;
      if (yielded !== expectedYielded) {
        fail(`yielded_before_failure: expected ${expectedYielded}, observed ${yielded}`);
      }
      const expectedTerminal = expectedField(case_, 'terminal') as string;
      if (cursor.terminalState() !== expectedTerminal) {
        fail(`terminal: expected ${expectedTerminal}, observed ${cursor.terminalState()}`);
      }
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.query.protocol@1 */
function queryProtocol(case_: VectorCase): void {
  switch (case_.id) {
    case 'query.protocol-roundtrip': {
      const domain = caseField(case_, 'domain') as string;
      const operator = caseField(case_, 'operator') as string;
      const selection = caseField(case_, 'selection') as string;
      if (domain !== 'core.portable-value-query@1') {
        fail(`domain: expected core.portable-value-query@1, observed ${domain}`);
      }
      if (operator !== 'core.try-sequence-elements@1') {
        fail(`operator: expected core.try-sequence-elements@1, observed ${operator}`);
      }
      if (selection !== 'All' && selection !== 'First' && selection !== 'Last' && selection !== 'ZeroOrOne' && selection !== 'RequireOne') {
        fail(`unknown selection ${selection}`);
      }
      if (expectedField(case_, 'roundtrip_equal') !== true) {
        fail('expected.roundtrip_equal must be true');
      }
      if (expectedField(case_, 'unknown_field') !== 'Reject') {
        fail('expected.unknown_field must be Reject');
      }
      let definition = newQueryDefinition(domainPortableValueV1());
      definition = withExpression(definition, pipelineExpression([operator]));
      definition = withSelection(definition, selection as QuerySelection);
      const wire = queryDefinitionToValue(definition);
      const decoded = queryDefinitionFromValue(wire);
      if (!coreEqual(wire, queryDefinitionToValue(decoded))) {
        fail('definition round trip must be strictly equal');
      }
      const invalid = objectValue([...wire.entries, { key: 'unknown', value: nullValue() }]);
      try {
        queryDefinitionFromValue(invalid);
      } catch {
        return;
      }
      fail('an unknown field in the wire value must be rejected');
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** json.projection.best-exact-core@1 / json.projection.project-as-object@1 */
function jsonProjection(case_: VectorCase): void {
  const document = parseJsonCase(case_);
  const target = caseField(case_, 'target') as string;
  const duplicates = caseFieldOptional(case_, 'duplicates') as string | undefined;
  let builder = new ProjectionRequestBuilder(
    target === 'ProjectAsObject@1' ? 'ProjectAsObjectV1' : target === 'ProjectAsEntryMapping@1' ? 'ProjectAsEntryMappingV1' : 'BestExactCoreV1',
  );
  if (duplicates !== undefined) {
    builder = builder.withGlobalDuplicatePolicy(duplicates as 'Reject' | 'FirstWins' | 'LastWins');
  }
  const result = project(document, builder.build());
  const status = expectedFieldOptional(case_, 'status') as string | undefined;
  if (status === 'Failed') {
    if (result.kind !== 'Failed') {
      fail('projection should have failed');
    }
    // A failed projection carries no partial value by construction.
    return;
  }
  if (result.kind === 'Failed') {
    fail('projection failed unexpectedly');
  }
  const projection = result.value;
  const fidelity = expectedFieldOptional(case_, 'fidelity');
  if (fidelity !== undefined && projection.fidelity() !== fidelity) {
    fail(`fidelity: expected ${String(fidelity)}, observed ${projection.fidelity()}`);
  }
  const kind = expectedFieldOptional(case_, 'kind');
  if (kind !== undefined) {
    const value = projection.value();
    const observedKind = value.kind === 'EntryMapping' ? 'EntryMapping' : value.kind === 'Object' ? 'Object' : 'Other';
    if (observedKind !== kind) {
      fail(`kind: expected ${String(kind)}, observed ${observedKind}`);
    }
  }
  const events = expectedFieldOptional(case_, 'events') as unknown[] | undefined;
  if (events !== undefined) {
    const observed = projection.report().events().map((event) => event.kind());
    if (observed.length !== events.length || observed.some((kind_, index) => kind_ !== events[index])) {
      fail(`events: expected ${JSON.stringify(events)}, observed ${JSON.stringify(observed)}`);
    }
  }
  const associationOrigins = expectedFieldOptional(case_, 'association_origins');
  if (associationOrigins !== undefined) {
    const count = projection
      .provenance()
      .entries()
      .filter((entry) => entry.projected().kind === 'Association').length;
    if (count !== associationOrigins) {
      fail(`association_origins: expected ${String(associationOrigins)}, observed ${count}`);
    }
  }
  const keyOrigins = expectedFieldOptional(case_, 'key_association_origins');
  const entryOrigins = expectedFieldOptional(case_, 'entry_association_origins');
  if (keyOrigins !== undefined || entryOrigins !== undefined) {
    let keys = 0;
    let entries = 0;
    for (const entry of projection.provenance().entries()) {
      const projected = entry.projected();
      if (projected.kind !== 'Association') {
        continue;
      }
      switch (projected.location.role()) {
        case 'ObjectKey':
          keys += 1;
          break;
        case 'ObjectEntry':
          entries += 1;
          break;
        default:
          break;
      }
    }
    if (keyOrigins !== undefined && keys !== keyOrigins) {
      fail(`key_association_origins: expected ${String(keyOrigins)}, observed ${keys}`);
    }
    if (entryOrigins !== undefined && entries !== entryOrigins) {
      fail(`entry_association_origins: expected ${String(entryOrigins)}, observed ${entries}`);
    }
  }
}

/** json.edit.scalar-replace@1 */
function jsonEditScalar(case_: VectorCase): void {
  const document = parseJsonCase(case_);
  const members = document.root().objectMembers();
  if (members.kind !== 'Available' || members.value === null || members.value.length === 0) {
    fail('member unavailable');
  }
  const member = members.value[0];
  const policy = caseField(case_, 'policy') as string;
  const newValue = valueFromInput(caseField(case_, 'new_value'));
  const builder = new EditTransactionBuilder(document);
  builder.semanticScalar(member.valueNodeRef(), newValue, policy as 'PreserveCompatible' | 'CanonicalForProfile' | 'PreserveElseCanonical');
  const transaction = builder.build();
  let commit;
  try {
    commit = commitEdits(document, transaction);
  } catch (error) {
    if (error instanceof EditFailure) {
      const status = expectedFieldOptional(case_, 'status') as string | undefined;
      const failure = expectedFieldOptional(case_, 'failure') as string | undefined;
      if (status === 'Failed') {
        const expectedKind = failure === 'RepresentationIncompatible' ? 'RepresentationIncompatible' : undefined;
        if (expectedKind !== undefined && error.kind !== expectedKind) {
          fail(`failure: expected ${failure}, observed ${error.kind}`);
        }
        return;
      }
    }
    throw error;
  }
  const expectedSource = expectedField(case_, 'source') as string;
  if (!bytesEqual(commit.document().render(), utf8(expectedSource))) {
    fail(
      `source: expected ${JSON.stringify(expectedSource)}, observed ${JSON.stringify(new TextDecoder().decode(commit.document().render()))}`,
    );
  }
  const editCount = expectedFieldOptional(case_, 'source_edit_count');
  if (editCount !== undefined && commit.changeSet().sourceEdits().length !== editCount) {
    fail(`source_edit_count: expected ${String(editCount)}, observed ${commit.changeSet().sourceEdits().length}`);
  }
  const fallback = expectedFieldOptional(case_, 'fallback_diagnostics');
  if (fallback !== undefined) {
    const count = commit
      .changeSet()
      .diagnostics()
      .filter((item) => item.code === 'json.edit.representation-fallback@1').length;
    if (count !== fallback) {
      fail(`fallback_diagnostics: expected ${String(fallback)}, observed ${count}`);
    }
  }
}

/** json.edit.scalar-replace@1 — incompatible and wrong-snapshot failures. */
function jsonEditFailure(case_: VectorCase): void {
  if (case_.id === 'edit.preserve-incompatible-rejected') {
    const document = parseJsonCase(case_);
    const members = document.root().objectMembers();
    if (members.kind !== 'Available' || members.value === null) {
      fail('member unavailable');
    }
    const policy = caseField(case_, 'policy') as string;
    const newValue = valueFromInput(caseField(case_, 'new_value'));
    const builder = new EditTransactionBuilder(document);
    builder.semanticScalar(members.value[0].valueNodeRef(), newValue, policy as 'PreserveCompatible');
    const error = expectThrowsCode(
      () => commitEdits(document, builder.build()),
      'core.edit.representation-incompatible@1',
    );
    if (error instanceof EditFailure && error.kind !== 'RepresentationIncompatible') {
      fail(`expected RepresentationIncompatible, observed ${error.kind}`);
    }
    return;
  }
  if (case_.id === 'edit.wrong-snapshot') {
    const first = parseJson(utf8(caseField(case_, 'first') as string), 'JsonStrict', DEFAULT_PARSE_LIMITS);
    const second = parseJson(utf8(caseField(case_, 'second') as string), 'JsonStrict', DEFAULT_PARSE_LIMITS);
    const literal = utf8(caseField(case_, 'literal') as string);
    const builder = new EditTransactionBuilder(second);
    builder.literalScalar(first.root().nodeRef(), literal);
    expectThrowsCode(() => commitEdits(second, builder.build()), 'core.edit.wrong-snapshot@1');
    return;
  }
  fail(`runner does not recognize published case ${case_.id}`);
}

/** core.parse.resource-limits@1 */
function parseResourceLimits(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const maxTokenCount = caseField(case_, 'max_token_count') as number;
  const limits = { ...DEFAULT_PARSE_LIMITS, maxTokenCount };
  try {
    parseJson(utf8(source), 'JsonStrict', limits);
  } catch (error) {
    if (error instanceof JsonFormationFailure) {
      return;
    }
    throw error;
  }
  fail('expected a parse resource-limit failure');
}

/** One stable identity key for a NodeRef (snapshot + role + index). */
function nodeRefKey(node: import('../../document/identity.ts').NodeRef): string {
  return `${node.snapshot().asBigInt()}:${node.role()}:${node.index()}`;
}

export const runV1: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.capability) {
      case 'core.value.strict-equality@1':
        valueStrictEquality(case_);
        return;
      case 'core.pvce.full@1':
        pvceFull(case_);
        return;
      case 'core.document.exact-roundtrip@1':
      case 'json.document.recovery@1':
      case 'json.native.duplicate-members@1':
      case 'json.document.lossless-syntax@1':
        jsonParse(case_);
        return;
      case 'core.query.ordered-results@1':
        queryOrdered(case_);
        return;
      case 'core.query.protocol@1':
        queryProtocol(case_);
        return;
      case 'json.projection.best-exact-core@1':
      case 'json.projection.project-as-object@1':
        jsonProjection(case_);
        return;
      case 'json.edit.scalar-replace@1':
        if (case_.id === 'edit.preserve-incompatible-rejected' || case_.id === 'edit.wrong-snapshot') {
          jsonEditFailure(case_);
          return;
        }
        jsonEditScalar(case_);
        return;
      case 'core.parse.resource-limits@1':
        parseResourceLimits(case_);
        return;
      default:
        return skip(
          case_.capability ?? 'unknown',
          `runner does not recognize published case ${case_.id}`,
        );
    }
  },
};
