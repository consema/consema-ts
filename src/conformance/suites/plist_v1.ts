/**
 * `consema.plist.conformance@1` runner (45 cases; mirror of
 * crates/consema-conformance/src/plist_v1.rs).
 *
 * The formation cases dispatch through the plist family parsers; the
 * query/projection/materialization/edit/conversion cases dispatch through
 * the family execution modules (src/plist/query.ts, projection.ts,
 * materialization.ts, edit.ts). Cross-representation conversion (RFC 0013
 * §7) composes the value-tree projection with a native-graph serializer
 * and the canonical materialization, mirroring
 * python/src/consema/plist/conversion.py (document.rs:224-593).
 */

import type { VectorCase } from '../helpers.ts';
import { caseField, caseFieldOptional, expectedField, expectedFieldOptional, utf8, hexToBytes, toHex, bytesEqual } from '../helpers.ts';
import { fail, SkippedCase } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import { parse } from '../../plist/parser.ts';
import type { PlistDocument } from '../../plist/document.ts';
import { DEFAULT_PLIST_PARSE_LIMITS, PROFILE_DEFAULT_ENCODING } from '../../plist/profile.ts';
import {
  bindQuery,
  domainPlistBinaryStructureV1,
  domainPlistNativeV1,
  newOperatorCall,
  newQueryDefinition,
  validateQuery,
  withArgument,
  withExpression,
} from '../../protocol/query.ts';
import type { ExecutableQuery, OperatorCall, QueryExpression, QueryDomain } from '../../protocol/query.ts';
import { CapabilitySet, newCapabilityId } from '../../protocol/registry_descriptor.ts';
import {
  CancellationToken,
  QueryLimits,
  executePlistBinaryQuery,
  executePlistNativeQuery,
} from '../../plist/query.ts';
import type { PlistBinaryMatch, PlistMatch, PlistQueryResult } from '../../plist/query.ts';
import { EditFailure, QueryExecutionFailure } from '../../plist/errors.ts';
import { PLIST_EPOCH_OFFSET_UNIX, PlistReal, PlistValueRef } from '../../plist/native.ts';
import type { PlistValue, PlistValueKind } from '../../plist/native.ts';
import { PlistDocument as PlistNativeDocument } from '../../plist/native.ts';
import { ProjectionRequest, project } from '../../plist/projection.ts';
import { materialize, plistMaterializationFailureCode } from '../../plist/materialization.ts';
import { MaterializationRequest, MaterializationStyleId } from '../../document/materialization.ts';
import { ProfileId } from '../../document/profile.ts';
import { binaryFloat64Value, integerValue, nullValue, objectValue, sequenceValue, stringValue } from '../../core/value.ts';
import type { ObjectEntry, PortableValue } from '../../core/value.ts';
import { EditPath, EditTransactionBuilder, commitEdits } from '../../plist/edit.ts';
import type { EditPathStep, EditTransaction, EditValue, EditCommit } from '../../plist/edit.ts';
import { SourceSnapshot } from '../../document/source.ts';
import type { SourcePatchLimits } from '../../document/index.ts';

function parseCase(case_: VectorCase): PlistDocument {
  const profile = caseField(case_, 'profile') as string;
  const source = caseFieldOptional(case_, 'source') as string | undefined;
  const sourceHex = caseFieldOptional(case_, 'source_hex') as string | undefined;
  const hex = caseFieldOptional(case_, 'hex') as string | undefined;
  const bytes =
    sourceHex !== undefined ? hexToBytes(sourceHex) : hex !== undefined ? hexToBytes(hex) : utf8(source ?? '');
  return parse(bytes, profile === 'plist.binary@1' ? 'BinaryV1' : 'XmlV1', PROFILE_DEFAULT_ENCODING, DEFAULT_PLIST_PARSE_LIMITS);
}

/** One plist document from a sample object (the sample profile falls back to the case profile). */
function parseSample(case_: VectorCase, sample: Record<string, unknown>): PlistDocument {
  const profile = (sample['profile'] as string | undefined) ?? (caseField(case_, 'profile') as string);
  const source = sample['source'] as string | undefined;
  const hex = sample['hex'] as string | undefined;
  const bytes = hex !== undefined ? hexToBytes(hex) : utf8(source ?? '');
  return parse(bytes, profile === 'plist.binary@1' ? 'BinaryV1' : 'XmlV1', PROFILE_DEFAULT_ENCODING, DEFAULT_PLIST_PARSE_LIMITS);
}

/** Exact bits of one double. */
function bitsOfFloat64(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false);
}

/** Exact double of one Float64 bit pattern. */
function float64FromBits(bits: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits & 0xffffffffffffffffn, false);
  return view.getFloat64(0, false);
}

/** Exact double of one Float32 bit pattern. */
function float32FromBits(bits: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, bits, false);
  return view.getFloat32(0, false);
}

/** The vector spelling of one native value kind. */
function kindNameOf(kind: PlistValueKind): string {
  switch (kind) {
    case 'String':
      return 'string';
    case 'Integer':
      return 'integer';
    case 'Real':
      return 'real';
    case 'Boolean':
      return 'boolean';
    case 'Date':
      return 'date';
    case 'Data':
      return 'data';
    case 'Uid':
      return 'uid';
    case 'Array':
      return 'array';
    case 'Dict':
      return 'dict';
  }
}

/** plist.xml-formation@1 / plist.binary-formation@1 */
function formationCase(case_: VectorCase): void {
  const samples = caseFieldOptional(case_, 'samples') as { source?: string; hex?: string }[] | undefined;
  const statuses = expectedFieldOptional(case_, 'statuses') as string[] | undefined;
  const diagnostics = expectedFieldOptional(case_, 'diagnostics') as (string | null)[] | undefined;
  const binary = (caseField(case_, 'profile') as string) === 'plist.binary@1';
  if (samples !== undefined) {
    samples.forEach((sample, index) => {
      let document: PlistDocument;
      try {
        const bytes = sample.hex !== undefined ? hexToBytes(sample.hex) : utf8(sample.source ?? '');
        document = parse(bytes, binary ? 'BinaryV1' : 'XmlV1', PROFILE_DEFAULT_ENCODING, DEFAULT_PLIST_PARSE_LIMITS);
      } catch {
        if (statuses !== undefined && statuses[index] === 'FatalFormationFailure') {
          return;
        }
        fail(`sample ${index}: fatal formation failure`);
      }
      if (statuses !== undefined && document.formationStatus() !== statuses[index]) {
        fail(`sample ${index}: expected ${statuses[index]}, observed ${document.formationStatus()}`);
      }
      if (diagnostics !== undefined && diagnostics[index] !== null) {
        const observed = document.diagnostics().map((diagnostic) => diagnostic.code);
        if (!observed.includes(diagnostics[index] as string)) {
          fail(`sample ${index}: missing diagnostic ${diagnostics[index]}`);
        }
      }
    });
    return;
  }
  const document = parseCase(case_);
  const status = expectedFieldOptional(case_, 'status') as string | undefined;
  if (status !== undefined && document.formationStatus() !== status) {
    fail(`status: expected ${status}, observed ${document.formationStatus()}`);
  }
  const render = expectedFieldOptional(case_, 'render') as string | undefined;
  if (render !== undefined && new TextDecoder().decode(document.render()) !== render) {
    fail('render mismatch');
  }
  const expectedDiagnostics = expectedFieldOptional(case_, 'diagnostics') as string[] | undefined;
  if (expectedDiagnostics !== undefined) {
    const observed = document.diagnostics().map((diagnostic) => diagnostic.code);
    for (const code of expectedDiagnostics) {
      if (!observed.includes(code)) {
        fail(`missing diagnostic ${code} (observed ${observed.join(', ')})`);
      }
    }
  }
  const diagnostic = expectedFieldOptional(case_, 'diagnostic') as string | undefined;
  if (diagnostic !== undefined) {
    const observed = document.diagnostics().map((item) => item.code);
    if (!observed.includes(diagnostic)) {
      fail(`missing diagnostic ${diagnostic}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Query (plist.query@1; RFC 0013 §8)
// ---------------------------------------------------------------------------

/** The required capability set of every bound plist query. */
function queryCapabilities(): CapabilitySet {
  const set = new CapabilitySet();
  set.insert(newCapabilityId('core.query.ordered-results', 1));
  return set;
}

/** One bound operator call from a vector filter descriptor. */
function filterCall(filter: { operator: string; argument?: string }): OperatorCall {
  const [id, versionText] = filter.operator.split('@');
  let call = newOperatorCall(id, Number(versionText));
  const argument = filter.argument;
  if (argument !== undefined) {
    if (id === 'plist.dict-key-equals') {
      call = withArgument(call, 'key', stringValue(argument));
    } else if (id === 'plist.value-type-is') {
      call = withArgument(call, 'kind', stringValue(argument));
    } else {
      call = withArgument(call, 'argument', stringValue(argument));
    }
  }
  return call;
}

/** The chained expression of one ordered call list (INPUT.then(call).then(...)). */
function expressionFor(calls: readonly OperatorCall[]): QueryExpression {
  let expression: QueryExpression = { kind: 'Input' };
  for (const call of calls) {
    expression = { kind: 'Apply', input: expression, operator: call };
  }
  return expression;
}

/** Validates and binds one expression under one domain. */
function bindExpression(domain: QueryDomain, expression: QueryExpression): ExecutableQuery {
  const validated = validateQuery(withExpression(newQueryDefinition(domain), expression));
  if ('failure' in validated) {
    fail(`query validation failed: ${validated.failure.message}`);
  }
  const bound = bindQuery(validated.query, queryCapabilities());
  if ('failure' in bound) {
    fail(`query binding failed: ${bound.failure.message}`);
  }
  return bound.query;
}

/** Executes one ordered native-query call chain (plist_v1.py:996-1009). */
function executeNative(document: PlistDocument, calls: readonly OperatorCall[]): PlistQueryResult<PlistMatch> {
  return executePlistNativeQuery(
    bindExpression(domainPlistNativeV1(), expressionFor(calls)),
    document,
    QueryLimits.defaults(),
    new CancellationToken(),
  );
}

/** Executes one ordered binary-structure call chain (plist_v1.py:1179-1191). */
function executeBinaryStructure(document: PlistDocument, calls: readonly OperatorCall[]): PlistQueryResult<PlistBinaryMatch> {
  return executePlistBinaryQuery(
    bindExpression(domainPlistBinaryStructureV1(), expressionFor(calls)),
    document,
    QueryLimits.defaults(),
    new CancellationToken(),
  );
}

/** Ordered dictionary-entry keys of one native match list (plist_v1.py:1011-1016). */
function dictEntryKeys(matches: readonly PlistMatch[]): string[] {
  const keys: string[] = [];
  for (const item of matches) {
    if (item.kind === 'DictEntry') {
      keys.push(item.key);
    }
  }
  return keys;
}

/** Number of duplicate-key groups among the dictionary-entry matches (plist_v1.py:1019-1024). */
function duplicateKeyGroups(matches: readonly PlistMatch[]): number {
  const counts = new Map<string, number>();
  for (const key of dictEntryKeys(matches)) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let groups = 0;
  for (const count of counts.values()) {
    if (count > 1) {
      groups += 1;
    }
  }
  return groups;
}

/** Value payload of one value-bearing match (plist_v1.py:1026-1035). */
function matchPayload(match: PlistMatch): { readonly value: PlistValueRef; readonly kind: PlistValueKind } | null {
  if (match.kind === 'Value' || match.kind === 'DictEntry' || match.kind === 'ArrayElement') {
    return { value: match.value, kind: match.valueKind };
  }
  return null;
}

/** Asserts the typed-accessor matches (plist_v1.py:1037-1064). */
function assertTypedMatches(
  document: PlistDocument,
  matches: readonly PlistMatch[],
  expected: readonly { kind: string; value?: number; seconds?: number }[],
): void {
  if (matches.length !== expected.length) {
    fail('match count differs from expected');
  }
  const native = document.document();
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const expectedMatch = expected[index];
    const payload = matchPayload(match);
    if (payload === null) {
      fail('match without value payload');
    }
    if (kindNameOf(payload.kind) !== expectedMatch.kind) {
      fail('typed match kind mismatch');
    }
    const node = native?.get(payload.value);
    if (expectedMatch.value !== undefined) {
      const integer = node?.kind === 'Integer' ? node.value : undefined;
      if (integer === undefined || integer !== BigInt(expectedMatch.value)) {
        fail('typed match integer mismatch');
      }
    }
    if (expectedMatch.seconds !== undefined) {
      const seconds = node?.kind === 'Date' ? node.seconds : undefined;
      if (seconds === undefined || bitsOfFloat64(seconds) !== bitsOfFloat64(expectedMatch.seconds)) {
        fail('typed match date seconds mismatch');
      }
    }
  }
}

/** plist.query@1 */
function queryCase(case_: VectorCase): void {
  const domain = caseField(case_, 'domain') as string;
  if (domain === 'plist.native-semantic-query@1') {
    nativeQueryCase(case_);
    return;
  }
  if (domain === 'plist.binary-structure-query@1') {
    binaryStructureQueryCase(case_);
    return;
  }
  fail(`unknown query domain ${domain}`);
}

/** plist.native-semantic-query@1 (plist_v1.py:1078-1121). */
function nativeQueryCase(case_: VectorCase): void {
  const document = parseCase(case_);
  if (document.formationStatus() !== 'Complete') {
    fail('native-query input must form completely');
  }
  const samples = caseFieldOptional(case_, 'samples') as { filters: { operator: string; argument?: string }[] }[] | undefined;
  if (samples !== undefined) {
    nativeQuerySamples(case_, document, samples);
    return;
  }
  const filters = caseField(case_, 'filters') as { operator: string; argument?: string }[];
  const calls = filters.map(filterCall);
  const execution = executeNative(document, calls);
  const terminal = expectedField(case_, 'terminal') as string;
  if (terminal !== 'Completed') {
    fail(`terminal ${terminal} != Completed`);
  }
  const keys = expectedFieldOptional(case_, 'keys') as string[] | undefined;
  if (keys !== undefined) {
    const observed = dictEntryKeys(execution.matches());
    if (observed.length !== keys.length || observed.some((key, index) => key !== keys[index])) {
      fail(`keys: expected ${JSON.stringify(keys)}, observed ${JSON.stringify(observed)}`);
    }
  }
  const valueTypes = expectedFieldOptional(case_, 'value_types') as string[] | undefined;
  if (valueTypes !== undefined) {
    const actual = execution
      .matches()
      .filter((item) => item.kind === 'DictEntry')
      .map((item) => (item.kind === 'DictEntry' ? kindNameOf(item.valueKind) : ''));
    if (actual.length !== valueTypes.length || actual.some((kind, index) => kind !== valueTypes[index])) {
      fail(`value_types: expected ${JSON.stringify(valueTypes)}, observed ${JSON.stringify(actual)}`);
    }
  }
  const groups = expectedFieldOptional(case_, 'duplicate_groups') as number | undefined;
  if (groups !== undefined && duplicateKeyGroups(execution.matches()) !== groups) {
    fail('duplicate_groups mismatch');
  }
}

/** plist.native-semantic-query@1 samples (plist_v1.py:1124-1176). */
function nativeQuerySamples(
  case_: VectorCase,
  document: PlistDocument,
  samples: readonly { filters: { operator: string; argument?: string }[] }[],
): void {
  const terminals = expectedField(case_, 'terminals') as string[];
  if (samples.length !== terminals.length) {
    fail('terminal count mismatch');
  }
  const mismatchCode = expectedFieldOptional(case_, 'mismatch_code') as string | undefined;
  const integerMatches = expectedFieldOptional(case_, 'integer_matches') as { kind: string; value?: number; seconds?: number }[] | undefined;
  const dateMatches = expectedFieldOptional(case_, 'date_matches') as { kind: string; value?: number; seconds?: number }[] | undefined;
  for (let index = 0; index < samples.length; index++) {
    const filters = samples[index].filters;
    const calls = filters.map(filterCall);
    const lastOperator = filters.length > 0 ? filters[filters.length - 1].operator : '';
    const terminal = terminals[index];
    if (terminal === 'Completed') {
      const execution = executeNative(document, calls);
      if (lastOperator === 'plist.value-as-integer@1' && integerMatches !== undefined) {
        assertTypedMatches(document, execution.matches(), integerMatches);
      } else if (lastOperator === 'plist.value-as-date@1' && dateMatches !== undefined) {
        assertTypedMatches(document, execution.matches(), dateMatches);
      }
    } else if (terminal === 'Failed') {
      let failure: unknown;
      try {
        executeNative(document, calls);
      } catch (error) {
        failure = error;
      }
      if (!(failure instanceof QueryExecutionFailure)) {
        fail('execution must fail');
      }
      if (failure instanceof QueryExecutionFailure && failure.code !== mismatchCode) {
        fail(`query failure code: expected ${mismatchCode}, observed ${failure.code}`);
      }
    } else {
      fail(`unknown terminal ${terminal}`);
    }
  }
}

/** Asserts one u64 expectation field (plist_v1.py:293-299). */
function assertU64Field(case_: VectorCase, name: string, actual: number): void {
  const expected = expectedFieldOptional(case_, name) as number | undefined;
  if (expected !== undefined && actual !== expected) {
    fail(`${name}: expected ${expected}, observed ${actual}`);
  }
}

/** plist.binary-structure-query@1 (plist_v1.py:1194-1273). */
function binaryStructureQueryCase(case_: VectorCase): void {
  const document = parseCase(case_);
  if (document.formationStatus() !== 'Complete') {
    fail('binary-structure-query input must form completely');
  }
  const filters = caseField(case_, 'filters') as { operator: string }[];
  const calls = filters.map(filterCall);
  const terminal = expectedField(case_, 'terminal') as string;
  // The whole chain must execute without a failure.
  executeBinaryStructure(document, calls);
  if (terminal !== 'Completed') {
    fail(`terminal ${terminal} != Completed`);
  }
  let trailer: PlistBinaryMatch | null = null;
  const objects: { index: number; marker: number }[] = [];
  const offsets: { index: number; offset: number }[] = [];
  let topMarker: number | null = null;
  let topRefs: number[] = [];
  for (const call of calls) {
    const execution = executeBinaryStructure(document, [call]);
    for (const item of execution.matches()) {
      if (item.kind === 'Trailer') {
        trailer = item;
      } else if (item.kind === 'Object') {
        objects.push({ index: item.index, marker: item.marker });
      } else if (item.kind === 'Offset') {
        offsets.push({ index: item.index, offset: item.offset });
      } else if (item.kind === 'TopObject') {
        topMarker = item.marker;
        topRefs = item.refs.map((reference) => reference.target);
      }
    }
  }
  if (trailer === null) {
    fail('missing trailer facts match');
  }
  if (trailer.kind === 'Trailer') {
    for (const [name, actual] of [
      ['num_objects', Number(trailer.numObjects)],
      ['top_object', Number(trailer.topObject)],
      ['offset_int_size', trailer.offsetIntSize],
      ['object_ref_size', trailer.objectRefSize],
      ['sort_version', trailer.sortVersion],
      ['offset_table_offset', Number(trailer.offsetTableOffset)],
    ] as [string, number][]) {
      assertU64Field(case_, name, actual);
    }
  }
  objects.sort((left, right) => left.index - right.index);
  offsets.sort((left, right) => left.index - right.index);
  const objectOffsets = expectedFieldOptional(case_, 'object_offsets') as number[] | undefined;
  if (objectOffsets !== undefined) {
    const actual = offsets.map((item) => item.offset);
    if (actual.length !== objectOffsets.length || actual.some((value, index) => value !== objectOffsets[index])) {
      fail('object_offsets mismatch');
    }
  }
  const markers = expectedFieldOptional(case_, 'markers') as string[] | undefined;
  if (markers !== undefined) {
    const actual = objects.map((item) => item.marker.toString(16).padStart(2, '0'));
    if (actual.length !== markers.length || actual.some((value, index) => value !== markers[index])) {
      fail('markers mismatch');
    }
  }
  const topMarkerExpected = expectedFieldOptional(case_, 'top_marker') as string | undefined;
  if (topMarkerExpected !== undefined && (topMarker === null || topMarker.toString(16).padStart(2, '0') !== topMarkerExpected)) {
    fail('top_marker mismatch');
  }
  const topRefsExpected = expectedFieldOptional(case_, 'top_refs') as number[] | undefined;
  if (topRefsExpected !== undefined) {
    if (topRefs.length !== topRefsExpected.length || topRefs.some((value, index) => value !== topRefsExpected[index])) {
      fail('top_refs mismatch');
    }
  }
}

// ---------------------------------------------------------------------------
// Projection (plist.projection@1; RFC 0013 §9)
// ---------------------------------------------------------------------------

/** The vector spelling of one projected value's kind (plist_v1.py:1281-1304). */
function portableKindName(value: PortableValue): string | null {
  switch (value.kind) {
    case 'Object': {
      const fields = new Map(value.entries.map((entry) => [entry.key, entry.value]));
      if (fields.has('seconds')) {
        return 'date';
      }
      if (fields.has('uid')) {
        return 'uid';
      }
      return 'dict';
    }
    case 'EntryMapping':
      return 'dict';
    case 'Sequence':
      return 'array';
    case 'String':
      return 'string';
    case 'Integer':
      return 'integer';
    case 'BinaryFloat64':
    case 'BinaryFloat32':
      return 'real';
    case 'Boolean':
      return 'boolean';
    case 'Bytes':
      return 'data';
    default:
      return null;
  }
}

/** Ordered (key, value) pairs of one projected dict value (plist_v1.py:1307-1312). */
function mappingEntries(value: PortableValue): [string, PortableValue][] {
  if (value.kind === 'EntryMapping') {
    return value.entries.map((entry) => [entry.key.kind === 'String' ? entry.key.value : '', entry.value]);
  }
  if (value.kind === 'Object') {
    return value.entries.map((entry) => [entry.key, entry.value]);
  }
  return [];
}

/** One object member by key; `undefined` when absent. */
function objectField(value: PortableValue, name: string): PortableValue | undefined {
  if (value.kind !== 'Object') {
    return undefined;
  }
  return value.entries.find((entry) => entry.key === name)?.value;
}

/** The mapping entry value under one key; `undefined` when absent (plist_v1.py:1381-1385). */
function findMappingEntry(value: PortableValue, key: string): PortableValue | undefined {
  for (const [entryKey, item] of mappingEntries(value)) {
    if (entryKey === key) {
      return item;
    }
  }
  return undefined;
}

/** Asserts one projected leaf against its vector descriptor (plist_v1.py:1315-1367). */
function assertLeaf(
  actual: PortableValue,
  expected: { kind: string; text?: string; value?: number | boolean; hex?: string; seconds?: number },
): void {
  const kind = expected.kind;
  const actualKind = portableKindName(actual);
  if (actualKind !== kind) {
    fail(`leaf kind mismatch: expected ${kind}, observed ${actualKind}`);
  }
  switch (kind) {
    case 'string': {
      const text = expected.text;
      if (text === undefined) {
        fail('missing leaf text');
      }
      if (actual.kind !== 'String' || actual.value !== text) {
        fail('leaf text mismatch');
      }
      break;
    }
    case 'integer': {
      const expectedValue = expected.value;
      if (typeof expectedValue !== 'number') {
        fail('missing leaf integer');
      }
      if (actual.kind !== 'Integer' || actual.value !== BigInt(expectedValue)) {
        fail('leaf integer mismatch');
      }
      break;
    }
    case 'real': {
      const expectedValue = expected.value;
      if (typeof expectedValue !== 'number') {
        fail('missing leaf real');
      }
      const actualF64 =
        actual.kind === 'BinaryFloat64'
          ? float64FromBits(actual.bits)
          : actual.kind === 'BinaryFloat32'
            ? float32FromBits(actual.bits)
            : null;
      if (actualF64 === null || bitsOfFloat64(actualF64) !== bitsOfFloat64(expectedValue)) {
        fail('leaf real mismatch');
      }
      break;
    }
    case 'boolean': {
      const expectedValue = expected.value;
      if (typeof expectedValue !== 'boolean') {
        fail('missing leaf boolean');
      }
      if (actual.kind !== 'Boolean' || actual.value !== expectedValue) {
        fail('leaf boolean mismatch');
      }
      break;
    }
    case 'data': {
      const hex = expected.hex;
      if (hex === undefined) {
        fail('missing leaf hex');
      }
      if (actual.kind !== 'Bytes' || toHex(actual.value) !== hex) {
        fail('leaf data hex mismatch');
      }
      break;
    }
    case 'date': {
      const expectedSeconds = expected.seconds;
      if (expectedSeconds === undefined) {
        fail('missing leaf seconds');
      }
      const seconds = objectField(actual, 'seconds');
      if (seconds === undefined) {
        fail('actual leaf date missing');
      }
      const actualSeconds =
        seconds.kind === 'BinaryFloat64' ? float64FromBits(seconds.bits) : seconds.kind === 'BinaryFloat32' ? float32FromBits(seconds.bits) : null;
      if (actualSeconds === null || bitsOfFloat64(actualSeconds) !== bitsOfFloat64(expectedSeconds)) {
        fail('leaf date seconds mismatch');
      }
      break;
    }
    default:
      fail(`unknown leaf kind ${kind}`);
  }
}

/** The projection request of one vector sample (plist_v1.py:1370-1378). */
function projectionRequest(sample: { collision_policy?: string }): ProjectionRequest {
  const collision = sample.collision_policy;
  if (collision === 'Reject') {
    return ProjectionRequest.requireObject('Reject');
  }
  if (collision === 'First') {
    return ProjectionRequest.requireObject('First');
  }
  if (collision === 'Last') {
    return ProjectionRequest.requireObject('Last');
  }
  return ProjectionRequest.valueTree();
}

/** plist.projection@1 */
function projectionCase(case_: VectorCase): void {
  const samples = caseFieldOptional(case_, 'samples') as { source?: string; hex?: string; profile?: string; collision_policy?: string }[] | undefined;
  if (samples !== undefined) {
    projectionSamples(case_, samples);
    return;
  }
  const document = parseCase(case_);
  const result = project(document, ProjectionRequest.valueTree());
  if (result.kind !== 'Complete') {
    fail('projection must complete');
  }
  const value = result.value.value();
  const record = expectedFieldOptional(case_, 'record') as string | undefined;
  if (record !== undefined) {
    const entry = objectField(value, 'record');
    if (entry === undefined || entry.kind !== 'String' || entry.value !== record) {
      fail('record mismatch');
    }
  }
  const root = objectField(value, 'root');
  if (root === undefined) {
    fail('missing root member');
  }
  const rootKind = expectedFieldOptional(case_, 'root_kind') as string | undefined;
  if (rootKind !== undefined && portableKindName(root) !== rootKind) {
    fail(`root_kind: expected ${rootKind}, observed ${portableKindName(root)}`);
  }
  const keys = expectedFieldOptional(case_, 'keys') as string[] | undefined;
  if (keys !== undefined) {
    const actual = mappingEntries(root).map(([key]) => key);
    if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
      fail(`keys: expected ${JSON.stringify(keys)}, observed ${JSON.stringify(actual)}`);
    }
  }
  const leaves = expectedFieldOptional(case_, 'leaves') as Record<
    string,
    { kind: string; text?: string; value?: number | boolean; hex?: string; seconds?: number }
  > | undefined;
  if (leaves !== undefined) {
    for (const [key, leaf] of Object.entries(leaves)) {
      const entry = findMappingEntry(root, key);
      if (entry === undefined) {
        fail(`leaf entry ${key} missing`);
      }
      assertLeaf(entry, leaf);
    }
  }
  const arrayLeaves = expectedFieldOptional(case_, 'array_leaves') as Record<string, string[]> | undefined;
  if (arrayLeaves !== undefined) {
    for (const [key, leaf] of Object.entries(arrayLeaves)) {
      const entry = findMappingEntry(root, key);
      if (entry === undefined) {
        fail(`array leaf entry ${key} missing`);
      }
      if (entry.kind !== 'Sequence') {
        fail('array leaf must be a sequence');
      }
      const elements = entry.items;
      if (elements.length !== leaf.length) {
        fail('array leaf count mismatch');
      }
      for (let index = 0; index < elements.length; index++) {
        const element = elements[index];
        if (element.kind !== 'String' || element.value !== leaf[index]) {
          fail('array leaf element mismatch');
        }
      }
    }
  }
  const preserved = expectedFieldOptional(case_, 'association_order_preserved') as boolean | undefined;
  if (preserved !== undefined && !preserved) {
    fail('association order not preserved');
  }
}

/** plist.projection@1 samples (plist_v1.py:1450-1520). */
function projectionSamples(case_: VectorCase, samples: readonly { source?: string; hex?: string; profile?: string; collision_policy?: string }[]): void {
  const fidelities = expectedFieldOptional(case_, 'fidelities') as string[] | undefined;
  const codes = expectedFieldOptional(case_, 'codes') as (string | null)[] | undefined;
  const eventsAfterFirst = expectedFieldOptional(case_, 'events_after_first') as number | undefined;
  let firstCompletedChecked = false;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const document = parseSample(case_, sample);
    const result = project(document, projectionRequest(sample));
    if (fidelities !== undefined) {
      const expectedFidelity = fidelities[index];
      const fidelityOk =
        (result.kind === 'Failed' && expectedFidelity === 'Failed') ||
        (result.kind === 'Complete' && (expectedFidelity === 'Transformed' || expectedFidelity === 'Exact'));
      if (!fidelityOk) {
        fail('projection fidelity mismatch');
      }
    }
    if (codes !== undefined) {
      const codeValue = codes[index];
      if (codeValue !== null) {
        if (result.kind === 'Complete') {
          fail('projection must fail');
        }
        const diagnostics = result.value.diagnostics();
        if (diagnostics.length === 0 || diagnostics[0].code !== codeValue) {
          fail(`projection code: expected ${codeValue}, observed ${diagnostics[0]?.code}`);
        }
      }
    }
    if (result.kind === 'Complete' && !firstCompletedChecked) {
      firstCompletedChecked = true;
      const firstSample = expectedFieldOptional(case_, 'first_sample') as { keys?: string[]; values?: string[] } | undefined;
      if (firstSample !== undefined) {
        const keys = firstSample.keys;
        const values = firstSample.values;
        if (keys === undefined || values === undefined) {
          fail('missing first_sample keys/values');
        }
        // The require-object projection value is the unique-key object
        // itself (the TS family does not wrap it in the value-tree record).
        const objectValue_ = result.value.value();
        if (portableKindName(objectValue_) !== 'dict') {
          fail('require-object projection must be an object');
        }
        const entries = mappingEntries(objectValue_);
        if (entries.length !== keys.length) {
          fail('first_sample key count mismatch');
        }
        for (let position = 0; position < entries.length; position++) {
          const [entryKey, entryValue] = entries[position];
          if (entryKey !== keys[position] || entryValue.kind !== 'String' || entryValue.value !== values[position]) {
            fail('first_sample mismatch');
          }
        }
      }
      if (eventsAfterFirst !== undefined && eventsAfterFirst > 0) {
        const events = result.value.report().events().filter((event) => event.kind() === 'AssociationDiscarded').length;
        if (events !== eventsAfterFirst) {
          fail(`events_after_first: expected ${eventsAfterFirst}, observed ${events}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Materialization (plist.materialization@1; RFC 0013 §10)
// ---------------------------------------------------------------------------

/** The canonical materialization request of one style (plist_v1.py:1582-1599). */
function materializationRequest(style: string): MaterializationRequest | null {
  if (style === 'plist.xml-canonical@1') {
    return new MaterializationRequest(new ProfileId('plist.xml', 1), new MaterializationStyleId('plist.xml-canonical', 1));
  }
  if (style === 'plist.binary-canonical@1') {
    return new MaterializationRequest(new ProfileId('plist.binary', 1), new MaterializationStyleId('plist.binary-canonical', 1))
      .withEncoding({ kind: 'Binary' })
      .withNewline('None');
  }
  return null;
}

/**
 * Converts one order-preserving decoded JSON structure into a
 * PortableValue, preserving member order (plist_v1.py:1528-1551). The
 * vector records are read with JSON.parse, whose object key order is the
 * file order, so the ordered association facts survive without the
 * re-decoding pass the Python loader needs.
 */
function orderedValue(raw: unknown): PortableValue {
  if (raw === null) {
    return nullValue();
  }
  if (typeof raw === 'boolean') {
    return { kind: 'Boolean', value: raw };
  }
  if (typeof raw === 'string') {
    return stringValue(raw);
  }
  if (typeof raw === 'number') {
    if (Number.isInteger(raw)) {
      return integerValue(BigInt(raw));
    }
    return binaryFloat64Value(bitsOfFloat64(raw));
  }
  if (Array.isArray(raw)) {
    return sequenceValue(raw.map((item) => orderedValue(item)));
  }
  const record = raw as Record<string, unknown>;
  // The date leaf `{epoch, seconds}`: the seconds are an exact double, so
  // they always materialize as a BinaryFloat64 (the loader spellings of
  // `694224000.0` arrive as decimal tokens in Python; the exact double is
  // the same value).
  if (record['epoch'] !== undefined && record['seconds'] !== undefined) {
    const seconds = record['seconds'];
    return objectValue([
      { key: 'epoch', value: stringValue(record['epoch'] as string) },
      { key: 'seconds', value: typeof seconds === 'number' ? binaryFloat64Value(bitsOfFloat64(seconds)) : orderedValue(seconds) },
    ]);
  }
  const entries: ObjectEntry[] = [];
  for (const [key, value] of Object.entries(record)) {
    entries.push({ key, value: orderedValue(value) });
  }
  return objectValue(entries);
}

/** Non-container object count of one binary document (plist_v1.py:302-314). */
function scalarObjects(document: PlistDocument): number {
  const facts = document.binaryFacts();
  if (facts === null) {
    return 0;
  }
  let count = 0;
  for (const object of facts.objects()) {
    const marker = object.marker();
    if (marker >= 0xa0 && marker <= 0xaf) {
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xdf) {
      continue;
    }
    count += 1;
  }
  return count;
}

/** plist.materialization@1 */
function materializationCase(case_: VectorCase): void {
  const samples = caseFieldOptional(case_, 'samples') as unknown[] | undefined;
  if (samples !== undefined) {
    materializationSamples(case_, samples);
    return;
  }
  const style = caseField(case_, 'style') as string;
  const record = caseField(case_, 'record') as Record<string, unknown>;
  const request = materializationRequest(style);
  if (request === null) {
    fail(`unknown materialization style ${style}`);
  }
  const result = materialize(orderedValue(record), request);
  if (result.kind === 'Failed') {
    fail(`materialization failed: ${plistMaterializationFailureCode(result.value.failure())}`);
  }
  const complete = result.value;
  const closure = expectedFieldOptional(case_, 'closure') as boolean | undefined;
  if (closure !== undefined && closure && complete.document().formationStatus() !== 'Complete') {
    fail('materialized document must be complete');
  }
  const render = expectedFieldOptional(case_, 'render') as string | undefined;
  if (render !== undefined && new TextDecoder().decode(complete.document().render()) !== render) {
    fail('render mismatch');
  }
  const renderHex = expectedFieldOptional(case_, 'render_hex') as string | undefined;
  if (renderHex !== undefined && toHex(complete.document().render()) !== renderHex) {
    fail('render_hex mismatch');
  }
}

/** plist.materialization@1 samples (plist_v1.py:1668-1764). */
function materializationSamples(case_: VectorCase, samples: readonly unknown[]): void {
  const canonicalHex = expectedFieldOptional(case_, 'canonical_hex') as string | undefined;
  const conversionRender = expectedFieldOptional(case_, 'conversion_render') as string | undefined;
  const closure = expectedFieldOptional(case_, 'closure') as boolean | undefined;
  const representationChange = expectedFieldOptional(case_, 'representation_change_reported') as boolean | undefined;
  const deduplicated = expectedFieldOptional(case_, 'deduplicated_scalars') as number | undefined;
  const renders = expectedFieldOptional(case_, 'renders') as (string | null)[] | undefined;
  const codes = expectedFieldOptional(case_, 'codes') as (string | null)[] | undefined;
  const truncationEvents = expectedFieldOptional(case_, 'truncation_events') as number | undefined;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index] as Record<string, unknown>;
    let style = sample['style'] as string | undefined;
    if (style === undefined) {
      style = caseFieldOptional(case_, 'style') as string | undefined;
      if (style === undefined) {
        fail('missing sample style');
      }
    }
    const record = sample['record'] as Record<string, unknown> | undefined;
    if (record !== undefined) {
      let recordValue = orderedValue(record);
      const policy = sample['truncate_policy'] as string | undefined;
      if (policy !== undefined) {
        if (recordValue.kind !== 'Object') {
          fail('record must be an object');
        }
        recordValue = objectValue([...recordValue.entries, { key: 'truncate_policy', value: stringValue(policy) }]);
      }
      const request = materializationRequest(style);
      if (request === null) {
        fail(`unknown materialization style ${style}`);
      }
      const result = materialize(recordValue, request);
      if (result.kind === 'Complete') {
        const complete = result.value;
        if (renders !== undefined) {
          const expectedRender = renders[index];
          if (expectedRender !== null && new TextDecoder().decode(complete.document().render()) !== expectedRender) {
            fail('render mismatch');
          }
        }
        if (truncationEvents !== undefined && truncationEvents > 0) {
          const events = complete.report().events().filter((event) => event.code === 'plist.materialization.fractional-date@1').length;
          if (events !== truncationEvents) {
            fail('truncation events mismatch');
          }
        }
        if (closure !== undefined && closure && complete.document().formationStatus() !== 'Complete') {
          fail('materialized document must be complete');
        }
      } else {
        if (codes !== undefined) {
          const codeValue = codes[index];
          if (codeValue === null) {
            fail('materialization must complete');
          }
          if (plistMaterializationFailureCode(result.value.failure()) !== codeValue) {
            fail('materialization failure code mismatch');
          }
        } else {
          fail('materialization must complete');
        }
      }
      continue;
    }
    // Source-document samples: normalization materializes the projected
    // record; conversion crosses the representation boundary.
    const document = parseSample(case_, sample);
    if (style === 'plist.binary-canonical@1') {
      const projection = project(document, ProjectionRequest.valueTree());
      if (projection.kind !== 'Complete') {
        fail('projection must complete');
      }
      const request = materializationRequest(style);
      if (request === null) {
        fail(`unknown materialization style ${style}`);
      }
      const result = materialize(projection.value.value(), request);
      if (result.kind === 'Failed') {
        fail(`materialization failed: ${plistMaterializationFailureCode(result.value.failure())}`);
      }
      const complete = result.value;
      if (canonicalHex !== undefined && toHex(complete.document().render()) !== canonicalHex) {
        fail('canonical_hex mismatch');
      }
      if (deduplicated !== undefined && deduplicated > 0) {
        const actual = scalarObjects(document) - scalarObjects(complete.document());
        if (actual !== deduplicated) {
          fail(`deduplicated_scalars: expected ${deduplicated}, observed ${actual}`);
        }
      }
      if (closure !== undefined && closure && complete.document().formationStatus() !== 'Complete') {
        fail('materialized document must be complete');
      }
    } else {
      const converted = convertDocument(document, 'XmlV1');
      if (converted.kind === 'Failure') {
        fail(`conversion failed: ${converted.code}`);
      }
      if (conversionRender !== undefined && new TextDecoder().decode(converted.document.render()) !== conversionRender) {
        fail('conversion_render mismatch');
      }
      if (representationChange !== undefined && representationChange && !converted.representationChanged) {
        fail('representation change not reported');
      }
      if (closure !== undefined && closure && converted.document.formationStatus() !== 'Complete') {
        fail('converted document must be complete');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-representation conversion (RFC 0013 §7)
// ---------------------------------------------------------------------------

/** One cross-representation conversion outcome (document.rs:252-289). */
type ConversionResult =
  | { readonly kind: 'Complete'; readonly document: PlistDocument; readonly representationChanged: boolean }
  | { readonly kind: 'Failure'; readonly code: string };

/** Escapes XML text content (RFC 0013 §4.9; document.rs:899-912). */
function conversionEscapeXmlText(text: string): string {
  let out = '';
  for (const character of text) {
    switch (character) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '\r':
        out += '&#13;';
        break;
      default:
        out += character;
        break;
    }
  }
  return out;
}

/** Deterministic shortest-round-trip decimal spelling of one real (document.rs:914-929). */
function conversionRenderReal(real: PlistReal): string {
  const value = real.asF64();
  if (Number.isNaN(value)) {
    return 'nan';
  }
  if (!Number.isFinite(value)) {
    return Object.is(value, -Infinity) ? '-inf' : 'inf';
  }
  return String(value);
}

/** Whether the exact bits of one real survive the XML spelling (document.rs:931-946). */
function conversionRealExpressible(real: PlistReal): boolean {
  const value = real.asF64();
  if (Number.isNaN(value)) {
    return bitsOfFloat64(value) === bitsOfFloat64(Number.NaN);
  }
  if (!Number.isFinite(value)) {
    return true;
  }
  return bitsOfFloat64(Number(conversionRenderReal(real))) === bitsOfFloat64(value);
}

/** Whether one UTF-16 sequence is well-formed (document.rs:1038-1057). */
function conversionClassifySurrogates(text: string): 'WellFormedUnicode' | 'UnpairedSurrogate' {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
      if (low >= 0xdc00 && low <= 0xdfff) {
        index += 1;
      } else {
        return 'UnpairedSurrogate';
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return 'UnpairedSurrogate';
    }
  }
  return 'WellFormedUnicode';
}

function conversionIsXmlCharCode(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/** Whether every scalar of one UTF-16 sequence is an XML 1.0 character (document.rs:1038-1057). */
function conversionIsXmlText(text: string): boolean {
  return conversionClassifySurrogates(text) === 'WellFormedUnicode' && [...text].every((c) => conversionIsXmlCharCode(c.codePointAt(0)!));
}

/** Proleptic Gregorian calendar date of `days` since the Unix epoch (document.rs:985-1000). */
function conversionCivilFromDays(days: number): { year: number; month: number; day: number } {
  const z = days + 719468;
  const era = z >= 0 ? z : z - 146096;
  const eraFloor = Math.floor(era / 146097);
  const dayOfEra = z - eraFloor * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365);
  let year = yearOfEra + eraFloor * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  year = month <= 2 ? year + 1 : year;
  return { year, month, day };
}

/** Whole-second decomposition into XML calendar fields; `null` when inexpressible (document.rs:958-983). */
function conversionWholeSecondDate(seconds: number): { year: number; month: number; day: number; hour: number; minute: number; second: number } | null {
  if (seconds % 1 !== 0) {
    return null;
  }
  const unix = seconds + PLIST_EPOCH_OFFSET_UNIX;
  if (Math.abs(unix) >= 9_007_199_254_740_992) {
    return null;
  }
  const unixInt = Math.trunc(unix);
  const days = Math.floor(unixInt / 86400);
  const secondsOfDay = unixInt % 86400;
  const civil = conversionCivilFromDays(days);
  if (Math.abs(civil.year) > 0xffffffff) {
    return null;
  }
  return {
    year: civil.year,
    month: civil.month,
    day: civil.day,
    hour: Math.floor(secondsOfDay / 3600),
    minute: Math.floor((secondsOfDay % 3600) / 60),
    second: secondsOfDay % 60,
  };
}

function conversionRenderDate(fields: { year: number; month: number; day: number; hour: number; minute: number; second: number }): string {
  const sign = fields.year < 0 ? '-' : '';
  const year = Math.abs(fields.year).toString().padStart(4, '0');
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${sign}${year}-${pad(fields.month)}-${pad(fields.day)}T${pad(fields.hour)}:${pad(fields.minute)}:${pad(fields.second)}Z`;
}

/** Unwrapped standard-alphabet base64 with exact `=` padding (document.rs:890). */
function conversionBase64(bytes: Uint8Array): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let at = 0; at < bytes.length; at += 3) {
    const first = bytes[at];
    const second = at + 1 < bytes.length ? bytes[at + 1] : 0;
    const third = at + 2 < bytes.length ? bytes[at + 2] : 0;
    out += ALPHABET[first >> 2];
    out += ALPHABET[((first & 0x03) << 4) | (second >> 4)];
    out += at + 1 < bytes.length ? ALPHABET[((second & 0x0f) << 2) | (third >> 6)] : '=';
    out += at + 2 < bytes.length ? ALPHABET[third & 0x3f] : '=';
  }
  return out;
}

/** One reachable node of the native graph with its indegree (document.rs:626-741). */
interface ConversionNode {
  readonly node: PlistValue;
  readonly indegree: number;
}

/** Reachable-graph analysis plus XML expressibility validation (document.rs:619-741). */
function analyzeConversionXml(
  native: PlistNativeDocument,
): { readonly nodes: readonly ConversionNode[] } | { readonly failure: string } {
  const nodeCount = native.nodeCount();
  const children: number[][] = [];
  for (let index = 0; index < nodeCount; index++) {
    const value = native.get(PlistValueRef.fromIndex(index));
    if (value?.kind === 'Dict') {
      children.push(value.entries.map((entry) => entry.value));
    } else if (value?.kind === 'Array') {
      children.push([...value.elements]);
    } else {
      children.push([]);
    }
  }
  const visited = new Set<number>();
  const indegree = new Map<number, number>();
  const root = native.root().index();
  visited.add(root);
  const stack: Array<[number, number]> = [[root, 0]];
  while (stack.length > 0) {
    const [node, nextChild] = stack[stack.length - 1];
    const nodeChildren = children[node];
    if (nextChild < nodeChildren.length) {
      stack[stack.length - 1] = [node, nextChild + 1];
      const child = nodeChildren[nextChild];
      indegree.set(child, (indegree.get(child) ?? 0) + 1);
      if (!visited.has(child)) {
        visited.add(child);
        stack.push([child, 0]);
      }
    } else {
      stack.pop();
    }
  }
  const nodes: ConversionNode[] = [];
  for (let index = 0; index < nodeCount; index++) {
    if (!visited.has(index)) {
      continue;
    }
    const value = native.get(PlistValueRef.fromIndex(index))!;
    if ((indegree.get(index) ?? 0) > 1) {
      return { failure: 'plist.conversion.inexpressible@1' };
    }
    if (value.kind === 'Uid') {
      return { failure: 'plist.conversion.inexpressible@1' };
    }
    if (value.kind === 'Real') {
      if (value.real.width() === 'Float32' || !conversionRealExpressible(value.real)) {
        return { failure: 'plist.conversion.inexpressible@1' };
      }
    } else if (value.kind === 'String') {
      if (value.status === 'UnpairedSurrogate' || !conversionIsXmlText(value.text)) {
        return { failure: 'plist.conversion.inexpressible@1' };
      }
    } else if (value.kind === 'Date') {
      if (conversionWholeSecondDate(value.seconds) === null) {
        return { failure: 'plist.conversion.inexpressible@1' };
      }
    } else if (value.kind === 'Dict') {
      for (const entry of value.entries) {
        if (conversionClassifySurrogates(entry.key) === 'UnpairedSurrogate' || !conversionIsXmlText(entry.key)) {
          return { failure: 'plist.conversion.inexpressible@1' };
        }
      }
    }
    nodes.push({ node: value, indegree: indegree.get(index) ?? 0 });
  }
  return { nodes };
}

/** Emits one scalar value element at the given depth (document.rs:843-890). */
function emitConversionScalar(out: { text: string }, native: PlistNativeDocument, node: PlistValue, depth: number): void {
  out.text += '    '.repeat(depth);
  switch (node.kind) {
    case 'String':
      out.text += '<string>';
      out.text += conversionEscapeXmlText(node.text);
      out.text += '</string>\n';
      break;
    case 'Integer':
      out.text += `<integer>${node.value}</integer>\n`;
      break;
    case 'Real':
      out.text += `<real>${conversionRenderReal(node.real)}</real>\n`;
      break;
    case 'Boolean':
      out.text += node.value ? '<true/>\n' : '<false/>\n';
      break;
    case 'Date': {
      const fields = conversionWholeSecondDate(node.seconds);
      if (fields === null) {
        throw new Error('internal: analyzed date');
      }
      out.text += `<date>${conversionRenderDate(fields)}</date>\n`;
      break;
    }
    case 'Data':
      out.text += '<data>';
      out.text += conversionBase64(node.bytes);
      out.text += '</data>\n';
      break;
    default:
      throw new Error('internal: container reached the scalar emitter');
  }
}

/** Emits one container value with its children (document.rs:777-841). */
function emitConversionContainer(
  out: { text: string },
  native: PlistNativeDocument,
  node: PlistValue,
  children: readonly number[],
  depth: number,
): void {
  if (node.kind === 'Dict') {
    if (children.length === 0) {
      out.text += `${'    '.repeat(depth)}<dict></dict>\n`;
      return;
    }
    out.text += `${'    '.repeat(depth)}<dict>\n`;
    for (let index = 0; index < children.length; index++) {
      const key = node.entries[index].key;
      out.text += `${'    '.repeat(depth + 1)}<key>`;
      out.text += conversionEscapeXmlText(key);
      out.text += '</key>\n';
      const child = native.get(PlistValueRef.fromIndex(children[index]));
      if (child === null) {
        throw new Error('internal: missing child');
      }
      if (child.kind === 'Dict' || child.kind === 'Array') {
        emitConversionContainer(out, native, child, conversionChildrenOf(native, child), depth + 1);
      } else {
        emitConversionScalar(out, native, child, depth + 1);
      }
    }
    out.text += `${'    '.repeat(depth)}</dict>\n`;
  } else if (node.kind === 'Array') {
    if (children.length === 0) {
      out.text += `${'    '.repeat(depth)}<array></array>\n`;
      return;
    }
    out.text += `${'    '.repeat(depth)}<array>\n`;
    for (const childIndex of children) {
      const child = native.get(PlistValueRef.fromIndex(childIndex));
      if (child === null) {
        throw new Error('internal: missing child');
      }
      if (child.kind === 'Dict' || child.kind === 'Array') {
        emitConversionContainer(out, native, child, conversionChildrenOf(native, child), depth + 1);
      } else {
        emitConversionScalar(out, native, child, depth + 1);
      }
    }
    out.text += `${'    '.repeat(depth)}</array>\n`;
  }
}

/** Direct children of one container node (document.rs:626-641). */
function conversionChildrenOf(native: PlistNativeDocument, node: PlistValue): number[] {
  if (node.kind === 'Dict') {
    return node.entries.map((entry) => entry.value);
  }
  if (node.kind === 'Array') {
    return [...node.elements];
  }
  return [];
}

/** Serializes one native value graph as a `plist.xml@1` source with the root at depth 0 (document.rs:767-890). */
function serializeConversionXml(native: PlistNativeDocument): Uint8Array {
  const out = {
    text: '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n',
  };
  const root = native.get(native.root());
  if (root === null) {
    throw new Error('internal: missing root');
  }
  if (root.kind === 'Dict' || root.kind === 'Array') {
    emitConversionContainer(out, native, root, conversionChildrenOf(native, root), 0);
  } else {
    emitConversionScalar(out, native, root, 0);
  }
  out.text += '</plist>\n';
  return new TextEncoder().encode(out.text);
}

/**
 * Converts one document to the other representation (RFC 0013 §7;
 * document.rs:252-289). XML→binary composes the value-tree projection
 * with the canonical binary materialization; binary→XML serializes the
 * native graph directly (the conversion serializer writes the root at
 * depth 0 and wraps data without line wrapping, unlike the
 * materialization style) and reparse-closes with native-model equality.
 */
function convertDocument(document: PlistDocument, target: 'XmlV1' | 'BinaryV1'): ConversionResult {
  if (document.formationStatus() !== 'Complete' || document.document() === null) {
    return { kind: 'Failure', code: 'plist.conversion.formation@1' };
  }
  if (target === 'BinaryV1') {
    const projection = project(document, ProjectionRequest.valueTree());
    if (projection.kind !== 'Complete') {
      return { kind: 'Failure', code: 'plist.conversion.inexpressible@1' };
    }
    const request = materializationRequest('plist.binary-canonical@1');
    const result = materialize(projection.value.value(), request!);
    if (result.kind === 'Failed') {
      const failure = result.value.failure();
      if (failure.kind === 'Unrepresentable') {
        return { kind: 'Failure', code: 'plist.conversion.inexpressible@1' };
      }
      if (failure.kind === 'ResourceLimit') {
        return { kind: 'Failure', code: 'plist.conversion.internal@1' };
      }
      return { kind: 'Failure', code: 'plist.conversion.reparse@1' };
    }
    return { kind: 'Complete', document: result.value.document(), representationChanged: true };
  }
  const native = document.document();
  const analysis = analyzeConversionXml(native!);
  if ('failure' in analysis) {
    return { kind: 'Failure', code: analysis.failure };
  }
  const bytes = serializeConversionXml(native!);
  const formed = parse(bytes, 'XmlV1', PROFILE_DEFAULT_ENCODING, DEFAULT_PLIST_PARSE_LIMITS);
  if (formed.formationStatus() !== 'Complete' || formed.document() === null || !formed.document()!.equals(native!)) {
    return { kind: 'Failure', code: 'plist.conversion.reparse@1' };
  }
  return { kind: 'Complete', document: formed, representationChanged: true };
}

// ---------------------------------------------------------------------------
// Edit (plist.edit@1; RFC 0013 §11)
// ---------------------------------------------------------------------------

/** One edit path from a vector operation (plist_v1.py:1847-1870). */
function editPath(operation: Record<string, unknown>): EditPath | null {
  const path = operation['path'] as unknown[] | undefined;
  if (path !== undefined) {
    const steps: EditPathStep[] = [];
    for (const element of path) {
      if (typeof element === 'string') {
        steps.push({ kind: 'DictKey', key: element, occurrence: 0 });
      } else if (typeof element === 'number') {
        steps.push({ kind: 'ArrayIndex', index: element });
      } else {
        return null;
      }
    }
    return EditPath.new(steps);
  }
  const name = (operation['dict'] as string | undefined) ?? (operation['array'] as string | undefined);
  if (name !== undefined) {
    return EditPath.new([{ kind: 'DictKey', key: name, occurrence: 0 }]);
  }
  return null;
}

/** One typed edit value from a vector descriptor (plist_v1.py:1879-1941). */
function editValue(value: Record<string, unknown> | undefined): EditValue | null {
  if (value === undefined) {
    return null;
  }
  const kind = value['kind'] as string | undefined;
  if (kind === undefined) {
    return null;
  }
  switch (kind) {
    case 'string': {
      const text = value['text'] as string | undefined;
      if (text === undefined) {
        return null;
      }
      return { kind: 'String', text };
    }
    case 'integer': {
      const payload = value['value'];
      if (typeof payload !== 'number') {
        return null;
      }
      return { kind: 'Integer', value: BigInt(payload) };
    }
    case 'real': {
      const payload = value['value'];
      if (typeof payload !== 'number') {
        return null;
      }
      return { kind: 'Real', real: PlistReal.double(payload) };
    }
    case 'boolean': {
      const payload = value['value'];
      if (typeof payload !== 'boolean') {
        return null;
      }
      return { kind: 'Boolean', value: payload };
    }
    case 'date': {
      const payload = value['seconds'];
      if (typeof payload !== 'number') {
        return null;
      }
      return { kind: 'Date', seconds: payload };
    }
    case 'data': {
      const text = value['hex'] as string | undefined;
      if (text === undefined) {
        return null;
      }
      return { kind: 'Data', bytes: hexToBytes(text) };
    }
    case 'uid': {
      const payload = value['value'];
      if (typeof payload !== 'number' || payload < 0 || payload > 0xffffffff) {
        return null;
      }
      return { kind: 'Uid', value: payload };
    }
    default:
      return null;
  }
}

/** One transaction from the vector operations (plist_v1.py:1944-2001). */
function buildTransaction(document: PlistDocument, operations: readonly Record<string, unknown>[]): EditTransaction {
  const builder = new EditTransactionBuilder(document);
  for (const operation of operations) {
    const op = operation['op'] as string | undefined;
    if (op === undefined) {
      fail('missing op');
    }
    switch (op) {
      case 'plist.edit.set-value@1': {
        const path = editPath(operation);
        const value = editValue(operation['value'] as Record<string, unknown>);
        if (path === null || value === null) {
          fail('missing path/value');
        }
        builder.setValue(path, value);
        break;
      }
      case 'plist.edit.insert-dict-entry@1': {
        const path = editPath(operation);
        const key = operation['key'] as string | undefined;
        const value = editValue(operation['value'] as Record<string, unknown>);
        if (path === null || key === undefined || value === null) {
          fail('missing path/key/value');
        }
        const placement = (operation['placement'] as string | undefined) ?? 'End';
        if (placement !== 'End') {
          fail(`unknown placement ${placement}`);
        }
        builder.insertDictEntry(path, key, value, { kind: 'End' });
        break;
      }
      case 'plist.edit.remove-dict-entry@1': {
        const path = editPath(operation);
        const key = operation['key'] as string | undefined;
        if (path === null || key === undefined) {
          fail('missing path/key');
        }
        builder.removeDictEntry(path, key, 0);
        break;
      }
      case 'plist.edit.rename-dict-key@1': {
        const path = editPath(operation);
        const from = operation['from'] as string | undefined;
        const to = operation['to'] as string | undefined;
        if (path === null || from === undefined || to === undefined) {
          fail('missing path/from/to');
        }
        builder.renameDictKey(path, from, 0, to);
        break;
      }
      case 'plist.edit.insert-array-element@1': {
        const path = editPath(operation);
        const index = operation['index'] as number | undefined;
        const value = editValue(operation['value'] as Record<string, unknown>);
        if (path === null || index === undefined || value === null) {
          fail('missing path/index/value');
        }
        builder.insertArrayElement(path, index, value);
        break;
      }
      case 'plist.edit.remove-array-element@1': {
        const path = editPath(operation);
        const index = operation['index'] as number | undefined;
        if (path === null || index === undefined) {
          fail('missing path/index');
        }
        builder.removeArrayElement(path, index);
        break;
      }
      default:
        fail(`unknown edit op ${op}`);
    }
  }
  return builder.build();
}

/** Reparses one committed document under its own profile (plist_v1.py:2004-2007). */
function reparse(document: PlistDocument): PlistDocument {
  const profile = document.profileInternal() === 'BinaryV1' ? ('BinaryV1' as const) : ('XmlV1' as const);
  return parse(document.render(), profile, PROFILE_DEFAULT_ENCODING, DEFAULT_PLIST_PARSE_LIMITS);
}

/** Patch construction bounds derived from the parse limits (edit.rs:2111-2121). */
function sourcePatchLimits(document: PlistDocument): SourcePatchLimits {
  const limits = document.parseLimits();
  return {
    source: {
      maxRawBytes: limits.common.maxSourceBytes,
      maxDecodedUtf8Bytes: limits.maxDecodedUtf8Bytes,
      maxDecodedScalars: limits.maxDecodedScalars,
    },
    maxReplacements: Math.max(limits.maxReportEvents, 1),
    maxPatchBytes: limits.common.maxSourceBytes * 2,
  };
}

/** Asserts one string sequence expectation (plist_v1.py:282-290). */
function assertStrings(actual: readonly string[], expected: readonly string[], what: string): void {
  if (actual.length !== expected.length) {
    fail(`${what} count differs`);
  }
  for (let index = 0; index < expected.length; index++) {
    if (actual[index] !== expected[index]) {
      fail(`${what} differs from expected`);
    }
  }
}

/** The native value of one root dict entry by key; `null` when absent (plist_v1.py:201-214). */
function entryByKey(committed: PlistDocument, root: PlistValue | null | undefined, name: string): PlistValue | null {
  const native = committed.document();
  if (native === null || root === null || root === undefined || root.kind !== 'Dict') {
    return null;
  }
  for (const entry of root.entries) {
    if (entry.key === name) {
      return native.get(PlistValueRef.fromIndex(entry.value));
    }
  }
  return null;
}

/** Asserts one scalar native value against its vector descriptor (plist_v1.py:263-279). */
function compareScalarValue(value: PlistValue | null | undefined, expected: string | number | boolean): void {
  if (typeof expected === 'string') {
    if (value?.kind !== 'String' || value.text !== expected) {
      fail('value mismatch');
    }
  } else if (typeof expected === 'number') {
    if (value?.kind !== 'Integer' || value.value !== BigInt(expected)) {
      fail('integer value mismatch');
    }
  } else if (typeof expected === 'boolean') {
    if (value?.kind !== 'Boolean' || value.value !== expected) {
      fail('boolean value mismatch');
    }
  }
}

/** Asserts the committed native model against the vector facts (plist_v1.py:2009-2091). */
function assertEditNative(case_: VectorCase, committed: PlistDocument): void {
  const native = committed.document();
  const root = native?.get(native.root());
  const topKind = expectedFieldOptional(case_, 'top_kind') as string | undefined;
  if (topKind !== undefined && (root === null || root === undefined || kindNameOf(root.kind) !== topKind)) {
    fail('top_kind mismatch');
  }
  const dictAKeys = expectedFieldOptional(case_, 'dict_a_keys') as string[] | undefined;
  if (dictAKeys !== undefined) {
    const dictA = entryByKey(committed, root, 'a');
    if (dictA === null || dictA.kind !== 'Dict') {
      fail('dict a missing');
    }
    assertStrings(dictA.entries.map((entry) => entry.key), dictAKeys, 'key');
  }
  const dictAValues = expectedFieldOptional(case_, 'dict_a_values') as (string | number | boolean)[] | undefined;
  if (dictAValues !== undefined) {
    const dictA = entryByKey(committed, root, 'a');
    if (dictA === null || dictA.kind !== 'Dict') {
      fail('dict a missing');
    }
    if (dictA.entries.length !== dictAValues.length) {
      fail('value count mismatch');
    }
    for (let index = 0; index < dictA.entries.length; index++) {
      compareScalarValue(native?.get(PlistValueRef.fromIndex(dictA.entries[index].value)), dictAValues[index]);
    }
  }
  const arrElements = expectedFieldOptional(case_, 'arr_elements') as (string | number | boolean)[] | undefined;
  if (arrElements !== undefined) {
    const arr = entryByKey(committed, root, 'arr');
    if (arr === null || arr.kind !== 'Array') {
      fail('arr must be an array');
    }
    if (arr.elements.length !== arrElements.length) {
      fail('array count mismatch');
    }
    for (let index = 0; index < arr.elements.length; index++) {
      compareScalarValue(native?.get(PlistValueRef.fromIndex(arr.elements[index])), arrElements[index]);
    }
  }
  const elements = expectedFieldOptional(case_, 'elements') as (string | number | boolean)[] | undefined;
  if (elements !== undefined) {
    if (root === null || root === undefined || root.kind !== 'Array') {
      fail('root must be an array');
    }
    if (root.elements.length !== elements.length) {
      fail('array count mismatch');
    }
    for (let index = 0; index < root.elements.length; index++) {
      compareScalarValue(native?.get(PlistValueRef.fromIndex(root.elements[index])), elements[index]);
    }
  }
  const elementKinds = expectedFieldOptional(case_, 'element_kinds') as string[] | undefined;
  if (elementKinds !== undefined) {
    if (root === null || root === undefined || root.kind !== 'Array') {
      fail('root must be an array');
    }
    if (root.elements.length !== elementKinds.length) {
      fail('array count mismatch');
    }
    for (let index = 0; index < root.elements.length; index++) {
      const value = native?.get(PlistValueRef.fromIndex(root.elements[index]));
      if (value === null || value === undefined || kindNameOf(value.kind) !== elementKinds[index]) {
        fail('element kind mismatch');
      }
    }
  }
}

/** plist.edit@1 */
function editCase(case_: VectorCase): void {
  const samples = caseFieldOptional(case_, 'samples') as Record<string, unknown>[] | undefined;
  if (samples !== undefined) {
    editConflicts(case_, samples);
    return;
  }
  const document = parseCase(case_);
  if (document.formationStatus() !== 'Complete') {
    fail('edit input must form completely');
  }
  const operations = caseField(case_, 'operations') as Record<string, unknown>[];
  const transaction = buildTransaction(document, operations);
  let commit: EditCommit;
  try {
    commit = commitEdits(document, transaction, document.parseLimits());
  } catch (error) {
    if (error instanceof EditFailure) {
      fail(`edit failed: ${error.code}`);
    }
    throw error;
  }
  const committed = commit.document();
  if (committed.formationStatus() !== 'Complete') {
    fail('committed document must be complete');
  }
  const reparseClosure = expectedFieldOptional(case_, 'reparse_closure') as boolean | undefined;
  if (reparseClosure !== undefined && reparseClosure) {
    const reparsed = reparse(committed);
    if (reparsed.formationStatus() !== 'Complete') {
      fail('committed document must reparse completely');
    }
  }
  const patchReplays = expectedFieldOptional(case_, 'patch_replays') as boolean | undefined;
  if (patchReplays !== undefined && patchReplays) {
    let replay: SourceSnapshot;
    try {
      replay = commit.sourcePatch().apply(document.source(), sourcePatchLimits(document));
    } catch {
      fail('patch does not replay');
    }
    if (!bytesEqual(replay.bytes(), committed.render())) {
      fail('patch does not replay');
    }
  }
  const untouchedByteProof = expectedFieldOptional(case_, 'untouched_byte_proof') as boolean | undefined;
  const untouchedObjectBytes = expectedFieldOptional(case_, 'untouched_object_bytes') as boolean | undefined;
  if (untouchedByteProof === true || untouchedObjectBytes === true) {
    try {
      commit.untouchedProof().verify(document.source(), committed.source(), commit.sourcePatch().replacements());
    } catch (error) {
      fail(`untouched proof: ${String(error)}`);
    }
  }
  if (untouchedObjectBytes === true) {
    const base = document.render();
    const target = committed.render();
    for (const region of commit.untouchedProof().regions()) {
      if (!bytesEqual(base.slice(region.oldStart(), region.oldEnd()), target.slice(region.newStart(), region.newEnd()))) {
        fail('untouched region content changed');
      }
    }
  }
  assertEditNative(case_, committed);
}

/** plist.edit@1 conflicts (plist_v1.py:2154-2194). */
function editConflicts(case_: VectorCase, samples: readonly Record<string, unknown>[]): void {
  const codes = expectedField(case_, 'codes') as string[];
  if (samples.length !== codes.length) {
    fail('code count mismatch');
  }
  const baseUnchanged = expectedFieldOptional(case_, 'base_unchanged') as boolean | undefined;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const document = parseSample(case_, sample);
    const operations = sample['operations'] as Record<string, unknown>[] | undefined;
    if (operations === undefined) {
      fail('missing operations');
    }
    const wrongSource = sample['wrong_source'] as Record<string, unknown> | undefined;
    let transaction: EditTransaction;
    if (wrongSource !== undefined) {
      const other = parseSample(case_, wrongSource);
      transaction = buildTransaction(other, operations);
    } else {
      transaction = buildTransaction(document, operations);
    }
    let failure: EditFailure | null = null;
    try {
      commitEdits(document, transaction, document.parseLimits());
    } catch (error) {
      if (error instanceof EditFailure) {
        failure = error;
      } else {
        throw error;
      }
    }
    if (failure === null) {
      fail('edit must fail');
    }
    if (failure.code !== codes[index]) {
      fail(`edit failure code: expected ${codes[index]}, observed ${failure.code}`);
    }
    if (baseUnchanged !== undefined && baseUnchanged && !bytesEqual(document.render(), document.source().bytes())) {
      fail('base document changed');
    }
  }
}

// ---------------------------------------------------------------------------
// Conversion (plist.conversion@1; RFC 0013 §7)
// ---------------------------------------------------------------------------

/** plist.conversion@1 (plist_v1.py:1779-1831). */
function conversionCase(case_: VectorCase): void {
  const document = parseCase(case_);
  if (document.formationStatus() !== 'Complete') {
    fail('conversion input must form completely');
  }
  const targetText = expectedField(case_, 'target') as string;
  const target = targetText === 'plist.binary@1' ? ('BinaryV1' as const) : targetText === 'plist.xml@1' ? ('XmlV1' as const) : null;
  if (target === null) {
    fail(`unknown target profile ${targetText}`);
  }
  const converted = convertDocument(document, target);
  const expectedCode = expectedFieldOptional(case_, 'code') as string | undefined;
  if (converted.kind === 'Failure') {
    if (expectedCode === undefined) {
      fail('conversion must complete');
    }
    if (converted.code !== expectedCode) {
      fail(`conversion failure code: expected ${expectedCode}, observed ${converted.code}`);
    }
    return;
  }
  if (expectedCode !== undefined) {
    fail('conversion must fail');
  }
  const representationChange = expectedFieldOptional(case_, 'representation_change_reported') as boolean | undefined;
  if (representationChange !== undefined && representationChange && !converted.representationChanged) {
    fail('representation change not reported');
  }
  const closure = expectedFieldOptional(case_, 'closure') as boolean | undefined;
  if (closure !== undefined && closure && converted.document.formationStatus() !== 'Complete') {
    fail('converted document must be complete');
  }
  const roundTrip = expectedFieldOptional(case_, 'round_trip') as boolean | undefined;
  if (roundTrip !== undefined && roundTrip) {
    const sourceProfile = caseField(case_, 'profile') as string;
    const backTarget = sourceProfile === 'plist.binary@1' ? ('BinaryV1' as const) : ('XmlV1' as const);
    const back = convertDocument(converted.document, backTarget);
    if (back.kind === 'Failure') {
      fail(`round-trip conversion failed: ${back.code}`);
    }
    const sourceNative = document.document();
    const backNative = back.document.document();
    if (sourceNative === null || backNative === null || !sourceNative.equals(backNative)) {
      fail('round-trip native model mismatch');
    }
  }
  const keys = expectedFieldOptional(case_, 'dict_keys') as string[] | undefined;
  if (keys !== undefined) {
    const native = converted.document.document();
    const root = native?.get(native.root());
    const actual = root?.kind === 'Dict' ? root.entries.map((entry) => entry.key) : [];
    if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
      fail(`dict_keys: expected ${JSON.stringify(keys)}, observed ${JSON.stringify(actual)}`);
    }
  }
}

export const runPlistV1: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.capability) {
      case 'plist.xml-formation@1':
      case 'plist.binary-formation@1':
        formationCase(case_);
        return;
      case 'plist.conversion@1':
        conversionCase(case_);
        return;
      case 'plist.query@1':
        queryCase(case_);
        return;
      case 'plist.projection@1':
        projectionCase(case_);
        return;
      case 'plist.materialization@1':
        materializationCase(case_);
        return;
      case 'plist.edit@1':
        editCase(case_);
        return;
      default:
        throw new SkippedCase(
          case_.capability ?? 'unknown',
          `runner does not recognize published case ${case_.id}`,
        );
    }
  },
};

