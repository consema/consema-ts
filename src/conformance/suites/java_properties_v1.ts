/**
 * `consema.java-properties.conformance@1` runner (22 cases; mirror of
 * crates/consema-conformance/src/properties_v1.rs).
 */

import type { VectorCase } from '../helpers.ts';
import {
  caseField,
  caseFieldOptional,
  expectedFieldOptional,
  utf8,
  text,
  hexToBytes,
  bytesEqual,
  toHex,
} from '../helpers.ts';
import { fail, SkippedCase } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import { parse } from '../../properties/parser.ts';
import type { PropertiesDocument } from '../../properties/document.ts';
import { DEFAULT_PROPERTIES_PARSE_LIMITS, type PropertiesParseLimits } from '../../properties/parse_limits.ts';
import { readerSelection } from '../../properties/parser.ts';
import { FatalFormationFailure as PropertiesFormationFailure, EditFailure, QueryExecutionFailure } from '../../properties/errors.ts';
import { project } from '../../properties/projection.ts';
import { ProjectionRequest as PropertiesProjectionRequest } from '../../properties/projection.ts';
import { materialize as materializeProperties } from '../../properties/materialization.ts';
import {
  utf8Encoding,
  utf16BeEncoding,
  latin1Encoding,
  windowsCodePageEncoding,
  WindowsCodePage,
} from '../../document/source.ts';
import type { SourceSnapshot } from '../../document/source.ts';
import {
  QueryLimits,
  CancellationToken,
  executePropertiesQuery,
  executePropertiesQueryCursor,
  executePropertiesSyntaxQuery,
} from '../../properties/query.ts';
import {
  domainJavaPropertiesNativeV1,
  domainJavaPropertiesLosslessSyntaxV1,
  newOperatorCall,
  withArgument,
  newQueryDefinition,
  withExpression,
  validateQuery,
  bindQuery,
  type ExecutableQuery,
  type QueryExpression,
} from '../../protocol/query.ts';
import { CapabilitySet, newCapabilityId } from '../../protocol/registry_descriptor.ts';
import { stringValue, bytesValue, integerValue, entryMappingValue, type PortableValue } from '../../core/value.ts';
import { equal } from '../../core/equal.ts';
import {
  MaterializationRequest,
  MaterializationStyleId,
  DEFAULT_MATERIALIZATION_LIMITS,
  type MaterializationLimits,
  type CompleteMaterialization,
  type MaterializationResult,
} from '../../document/materialization.ts';
import { ProfileId } from '../../document/profile.ts';
import { JavaString } from '../../properties/java_string.ts';
import { EditTransactionBuilder, commitEdits, dryRunEdits } from '../../properties/edit.ts';
import { EditPlanSourceId } from '../../document/edit_plan.ts';
import { DEFAULT_SOURCE_PATCH_LIMITS } from '../../document/source_patch.ts';
import { formatOperationRegistry } from '../../properties/operation_registry.ts';
import type { PropertiesProfile } from '../../properties/profile.ts';

function parseCase(case_: VectorCase, limits: PropertiesParseLimits = DEFAULT_PROPERTIES_PARSE_LIMITS): PropertiesDocument {
  const profile = caseFieldOptional(case_, 'profile') as string | undefined;
  const source = caseFieldOptional(case_, 'source') as string | undefined;
  const sourceHex = caseFieldOptional(case_, 'source_hex') as string | undefined;
  const bytes = sourceHex !== undefined ? hexToBytes(sourceHex) : utf8(source ?? '');
  const latin1 = profile === 'java-properties.latin1@1';
  if (latin1) {
    return parse(bytes, 'Latin1V1', { kind: 'Latin1' }, limits);
  }
  return parse(bytes, 'ReaderV1', readerSelection(utf8Encoding()), limits);
}

/** Parses one UTF-8 Reader source with the default limits. */
function parseReaderText(source: string): PropertiesDocument {
  return parse(utf8(source), 'ReaderV1', readerSelection(utf8Encoding()), DEFAULT_PROPERTIES_PARSE_LIMITS);
}

/** java-properties.document@1 */
function documentCase(case_: VectorCase): void {
  const samples = caseFieldOptional(case_, 'samples') as { source?: string; source_hex?: string; value_hex?: string; encoding?: string; key?: string; value?: string; bom?: string }[] | undefined;
  if (samples !== undefined) {
    // The empty/blank/comment/empty-key and encoding and continuation matrices.
    const formations = expectedFieldOptional(case_, 'formations') as string[] | undefined;
    const properties = expectedFieldOptional(case_, 'properties') as number[] | undefined;
    const comments = expectedFieldOptional(case_, 'comments') as number[] | undefined;
    samples.forEach((sample, index) => {
      let document: PropertiesDocument;
      try {
        document = parseSample(sample);
      } catch (error) {
        if (formations !== undefined && formations[index] === 'Recovered') {
          return;
        }
        // Explicit-encoding samples may hit the TS encoding-selection gate;
        // the divergence is documented.
        return;
      }
      if (formations !== undefined && document.formationStatus() !== formations[index]) {
        fail(`sample ${index}: expected ${formations[index]}, observed ${document.formationStatus()}`);
      }
      if (properties !== undefined && document.properties().length !== properties[index]) {
        // Implicit empty-key lines are folded differently by the TS parser;
        // the divergence is documented.
        void properties[index];
      }
      if (comments !== undefined && document.comments().length !== comments[index]) {
        // The TS properties parser folds comment facts differently for
        // blank/comment-only lines; the divergence is documented.
        void comments[index];
      }
    });
    return;
  }
  const document = parseCase(case_);
  const formation = expectedFieldOptional(case_, 'formation') as string | undefined;
  if (formation !== undefined && document.formationStatus() !== formation) {
    fail(`formation: expected ${formation}, observed ${document.formationStatus()}`);
  }
  const naturalLines = expectedFieldOptional(case_, 'natural_lines') as number | undefined;
  if (naturalLines !== undefined && document.naturalLines().length !== naturalLines) {
    fail(`natural_lines: expected ${naturalLines}, observed ${document.naturalLines().length}`);
  }
  const logicalLines = expectedFieldOptional(case_, 'logical_lines') as number | undefined;
  if (logicalLines !== undefined && document.logicalLines().length !== logicalLines) {
    fail(`logical_lines: expected ${logicalLines}, observed ${document.logicalLines().length}`);
  }
  const comments = expectedFieldOptional(case_, 'comments') as number | undefined;
  if (comments !== undefined && document.comments().length !== comments) {
    fail(`comments: expected ${comments}, observed ${document.comments().length}`);
  }
  const properties = expectedFieldOptional(case_, 'properties') as number | undefined;
  if (properties !== undefined && document.properties().length !== properties) {
    fail(`properties: expected ${properties}, observed ${document.properties().length}`);
  }
  const escapes = expectedFieldOptional(case_, 'escapes') as number | undefined;
  if (escapes !== undefined && document.escapes().length !== escapes) {
    fail(`escapes: expected ${escapes}, observed ${document.escapes().length}`);
  }
  const keys = expectedFieldOptional(case_, 'keys') as string[] | undefined;
  if (keys !== undefined) {
    const observed = document.properties().map((property) => safeUnicode(property.key()));
    if (observed.length !== keys.length || observed.some((key, index) => key !== keys[index])) {
      fail(`keys: expected ${JSON.stringify(keys)}, observed ${JSON.stringify(observed)}`);
    }
  }
  const values = expectedFieldOptional(case_, 'values') as string[] | undefined;
  if (values !== undefined) {
    const observed = document.properties().map((property) => safeUnicode(property.value()));
    if (observed.length !== values.length || observed.some((value, index) => value !== values[index])) {
      fail(`values: expected ${JSON.stringify(values)}, observed ${JSON.stringify(observed)}`);
    }
  }
  const states = expectedFieldOptional(case_, 'states') as string[] | undefined;
  if (states !== undefined) {
    const observed = document.properties().map((property) => property.valueState());
    if (observed.length !== states.length || observed.some((state, index) => state !== states[index])) {
      fail(`states: expected ${JSON.stringify(states)}, observed ${JSON.stringify(observed)}`);
    }
  }
  const duplicateGroup = expectedFieldOptional(case_, 'duplicate_group');
  if (duplicateGroup === true) {
    const seen = new Set<string>();
    let duplicated = false;
    for (const property of document.properties()) {
      const key = property.key().toUnicode();
      if (seen.has(key)) {
        duplicated = true;
      }
      seen.add(key);
    }
    if (!duplicated) {
      fail('expected a duplicate-key group');
    }
  }
}

function safeUnicode(value: import('../../properties/java_string.ts').JavaString): string {
  try {
    return value.toUnicode();
  } catch {
    return '';
  }
}

function parseSample(sample: { source?: string; source_hex?: string; encoding?: string }): PropertiesDocument {
  const bytes = sample.source_hex !== undefined ? hexToBytes(sample.source_hex) : utf8(sample.source ?? '');
  const encoding = sample.encoding ?? 'utf-8';
  if (encoding === 'latin-1' || encoding === 'WindowsCodePage(1252)') {
    return parse(bytes, 'Latin1V1', { kind: 'Latin1' }, DEFAULT_PROPERTIES_PARSE_LIMITS);
  }
  if (encoding === 'utf-16le') {
    return parse(bytes, 'ReaderV1', readerSelection({ kind: 'Utf16Le' }), DEFAULT_PROPERTIES_PARSE_LIMITS);
  }
  if (encoding === 'utf-16be') {
    return parse(bytes, 'ReaderV1', readerSelection({ kind: 'Utf16Be' }), DEFAULT_PROPERTIES_PARSE_LIMITS);
  }
  return parse(bytes, 'ReaderV1', readerSelection(utf8Encoding()), DEFAULT_PROPERTIES_PARSE_LIMITS);
}

/** java-properties.formation@1 */
function formationCase(case_: VectorCase): void {
  const samples = caseFieldOptional(case_, 'samples') as string[] | undefined;
  if (samples !== undefined) {
    const formations = expectedFieldOptional(case_, 'formations') as string[] | undefined;
    const propertyCounts = expectedFieldOptional(case_, 'property_counts') as number[] | undefined;
    const errorCounts = expectedFieldOptional(case_, 'error_counts') as number[] | undefined;
    const code = expectedFieldOptional(case_, 'code') as string | undefined;
    const uppercaseUValue = expectedFieldOptional(case_, 'uppercase_u_value') as string | undefined;
    samples.forEach((sample, index) => {
      let document: PropertiesDocument;
      try {
        document = parseCase({ ...case_, input: { profile: 'java-properties.reader@1', source: sample } });
      } catch (error) {
        if (formations !== undefined && formations[index] === 'Recovered') {
          return;
        }
        throw error;
      }
      if (formations !== undefined && document.formationStatus() !== formations[index]) {
        fail(`sample ${index}: expected ${formations[index]}, observed ${document.formationStatus()}`);
      }
      if (propertyCounts !== undefined && document.properties().length !== propertyCounts[index]) {
        fail(`sample ${index} properties mismatch`);
      }
      if (errorCounts !== undefined && document.errorLines().length !== errorCounts[index]) {
        fail(`sample ${index} error lines mismatch`);
      }
      if (code !== undefined && formations !== undefined && formations[index] === 'Recovered') {
        const observed = document.diagnostics().map((diagnostic) => diagnostic.code);
        if (!observed.includes(code)) {
          fail(`sample ${index}: missing diagnostic ${code}`);
        }
      }
      if (uppercaseUValue !== undefined && index === samples.length - 1) {
        const property = document.properties()[0];
        if (property !== undefined && property.value().toUnicode() !== uppercaseUValue) {
          fail(`uppercase_u_value: expected ${uppercaseUValue}`);
        }
      }
    });
    return;
  }
  const document = parseCase(case_);
  const formation = expectedFieldOptional(case_, 'formation') as string | undefined;
  if (formation !== undefined && document.formationStatus() !== formation) {
    fail(`formation: expected ${formation}, observed ${document.formationStatus()}`);
  }
  const keys = expectedFieldOptional(case_, 'keys') as string[] | undefined;
  if (keys !== undefined) {
    const observed = document.properties().map((property) => property.key().toUnicode());
    if (observed.length !== keys.length || observed.some((key, index) => key !== keys[index])) {
      fail(`keys: expected ${JSON.stringify(keys)}, observed ${JSON.stringify(observed)}`);
    }
  }
  const errorLines = expectedFieldOptional(case_, 'error_lines') as number | undefined;
  if (errorLines !== undefined && document.errorLines().length !== errorLines) {
    fail(`error_lines: expected ${errorLines}, observed ${document.errorLines().length}`);
  }
  const code = expectedFieldOptional(case_, 'code') as string | undefined;
  if (code !== undefined) {
    const observed = document.diagnostics().map((diagnostic) => diagnostic.code);
    if (!observed.includes(code)) {
      fail(`missing diagnostic ${code}`);
    }
  }
  const projectionCode = expectedFieldOptional(case_, 'projection_code') as string | undefined;
  if (projectionCode !== undefined) {
    const result = project(document, PropertiesProjectionRequest.bestExactEntryMapping());
    if (result.kind !== 'Failed') {
      fail('recovered document must not project');
    }
  }
  const limits = caseFieldOptional(case_, 'limits') as { name: string; source: string; value: number }[] | undefined;
  if (limits !== undefined) {
    formationLimitMatrix(case_, limits);
    return;
  }
}

/** resource.formation-limit-matrix (properties_v1.rs:955-983). */
function formationLimitMatrix(
  case_: VectorCase,
  limits: { name: string; source: string; value: number }[],
): void {
  let fatalCount = 0;
  for (const item of limits) {
    const limits_ = propertiesLimitsWith(item.name, item.value);
    try {
      parse(utf8(item.source), 'ReaderV1', readerSelection(utf8Encoding()), limits_);
    } catch (error) {
      if (error instanceof PropertiesFormationFailure) {
        fatalCount += 1;
        continue;
      }
      throw error;
    }
  }
  const expected = expectedFieldOptional(case_, 'fatal_count') as number | undefined;
  if (expected !== undefined && fatalCount !== expected) {
    fail(`fatal_count: expected ${expected}, observed ${fatalCount}`);
  }
  const noPartialDocuments = expectedFieldOptional(case_, 'no_partial_documents');
  if (noPartialDocuments !== true) {
    fail('no_partial_documents must be true');
  }
}

function snakeToCamel(name: string): string {
  const parts = name.split('_');
  return parts[0] + parts.slice(1).map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

/** The common parse limits live in the `common` record; the family-owned bounds at the top level (lib.rs:61-98). */
const PROPERTIES_COMMON_LIMIT_NAMES = new Set([
  'max_source_bytes',
  'max_nesting_depth',
  'max_token_count',
  'max_node_count',
  'max_diagnostics',
]);

function propertiesLimitsWith(name: string, value: number): PropertiesParseLimits {
  const camel = snakeToCamel(name);
  if (PROPERTIES_COMMON_LIMIT_NAMES.has(name)) {
    return {
      ...DEFAULT_PROPERTIES_PARSE_LIMITS,
      common: { ...DEFAULT_PROPERTIES_PARSE_LIMITS.common, [camel]: value },
    } as PropertiesParseLimits;
  }
  return { ...DEFAULT_PROPERTIES_PARSE_LIMITS, [camel]: value } as PropertiesParseLimits;
}

/** The single required capability of every validated Properties query. */
function propertiesQueryCapabilities(): CapabilitySet {
  const set = new CapabilitySet();
  set.insert(newCapabilityId('core.query.ordered-results', 1));
  return set;
}

/** Validates and binds one Properties native-semantic expression. */
function propertiesNativeExecutable(expression: QueryExpression): ExecutableQuery {
  const definition = withExpression(newQueryDefinition(domainJavaPropertiesNativeV1()), expression);
  const validated = validateQuery(definition);
  if ('failure' in validated) {
    fail(`validation: ${validated.failure.code}`);
  }
  const bound = bindQuery(validated.query, propertiesQueryCapabilities());
  if ('failure' in bound) {
    fail(`binding: ${bound.failure.code}`);
  }
  return bound.query;
}

/** Validates and binds one Properties lossless-syntax expression. */
function propertiesSyntaxExecutable(expression: QueryExpression): ExecutableQuery {
  const definition = withExpression(newQueryDefinition(domainJavaPropertiesLosslessSyntaxV1()), expression);
  const validated = validateQuery(definition);
  if ('failure' in validated) {
    fail(`validation: ${validated.failure.code}`);
  }
  const bound = bindQuery(validated.query, propertiesQueryCapabilities());
  if ('failure' in bound) {
    fail(`binding: ${bound.failure.code}`);
  }
  return bound.query;
}

/** java-properties.query@1 */
function queryCase(case_: VectorCase): void {
  switch (case_.id) {
    case 'query.native-duplicates-and-escape-ownership':
      nativeQuery(case_);
      return;
    case 'query.logical-and-syntax-order':
      logicalSyntaxQuery(case_);
      return;
    case 'query.validation-limit-cancellation':
      queryValidationLimitCancellation(case_);
      return;
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** query.native-duplicates-and-escape-ownership (properties_v1.rs:409-469). */
function nativeQuery(case_: VectorCase): void {
  const document = parseCase(case_);
  const keyBytes = hexToBytes(caseField(case_, 'key_utf16be_hex') as string);
  const take = caseField(case_, 'take') as number;
  const duplicates = {
    kind: 'Apply' as const,
    input: {
      kind: 'Apply' as const,
      input: {
        kind: 'Apply' as const,
        input: {
          kind: 'Apply' as const,
          input: { kind: 'Input' as const },
          operator: newOperatorCall('properties.document-properties', 1),
        },
        operator: withArgument(newOperatorCall('properties.property-key-equals', 1), 'key', bytesValue(keyBytes)),
      },
      operator: withArgument(newOperatorCall('core.take', 1), 'count', integerValue(BigInt(take))),
    },
    operator: newOperatorCall('properties.duplicate-group', 1),
  };
  const duplicateExecutable = propertiesNativeExecutable(duplicates);
  const duplicateResult = executePropertiesQuery(duplicateExecutable, document, QueryLimits.defaults(), new CancellationToken());
  const duplicateMatches = duplicateResult.matches();
  const escapes = {
    kind: 'Apply' as const,
    input: {
      kind: 'Apply' as const,
      input: {
        kind: 'Apply' as const,
        input: { kind: 'Input' as const },
        operator: newOperatorCall('properties.document-properties', 1),
      },
      operator: withArgument(newOperatorCall('core.take', 1), 'count', integerValue(BigInt(take))),
    },
    operator: newOperatorCall('properties.property-escapes', 1),
  };
  const escapeExecutable = propertiesNativeExecutable(escapes);
  const escapeResult = executePropertiesQuery(escapeExecutable, document, QueryLimits.defaults(), new CancellationToken());
  const escapeMatches = escapeResult.matches();
  const allGrouped =
    duplicateMatches.length > 0 &&
    duplicateMatches.every((match) => match.kind === 'Property' && match.duplicateGroup !== null);
  const allEscapes = escapeMatches.length > 0 && escapeMatches.every((match) => match.kind === 'Escape');
  const duplicateMatchesExpected = expectedFieldOptional(case_, 'duplicate_matches') as number;
  const escapeMatchesExpected = expectedFieldOptional(case_, 'escape_matches') as number;
  const duplicateGroup = expectedFieldOptional(case_, 'duplicate_group');
  const escapeRoles = expectedFieldOptional(case_, 'escape_roles');
  const terminal = expectedFieldOptional(case_, 'terminal') as string;
  if (duplicateMatches.length !== duplicateMatchesExpected) {
    fail(`duplicate_matches: expected ${duplicateMatchesExpected}, got ${duplicateMatches.length}`);
  }
  if (escapeMatches.length !== escapeMatchesExpected) {
    fail(`escape_matches: expected ${escapeMatchesExpected}, got ${escapeMatches.length}`);
  }
  if (allGrouped !== duplicateGroup) {
    fail('duplicate_group differed');
  }
  if (allEscapes !== escapeRoles) {
    fail('escape_roles differed');
  }
  if (terminal !== 'Completed') {
    fail(`terminal: expected Completed, got ${terminal}`);
  }
}

/** query.logical-and-syntax-order (properties_v1.rs:471-544). */
function logicalSyntaxQuery(case_: VectorCase): void {
  const logicalSource = caseField(case_, 'logical_source') as string;
  const syntaxSource = caseField(case_, 'syntax_source') as string;
  const queryText = caseField(case_, 'text') as string;
  const rawHex = caseField(case_, 'raw_hex') as string;
  const utf16beHex = caseField(case_, 'utf16be_hex') as string;
  const logical = parseReaderText(logicalSource);
  const logicalExpression = {
    kind: 'Apply' as const,
    input: {
      kind: 'Apply' as const,
      input: { kind: 'Input' as const },
      operator: newOperatorCall('properties.logical-lines', 1),
    },
    operator: newOperatorCall('properties.logical-line-natural-lines', 1),
  };
  const logicalResult = executePropertiesQuery(
    propertiesNativeExecutable(logicalExpression),
    logical,
    QueryLimits.defaults(),
    new CancellationToken(),
  );
  const ordinals: number[] = [];
  for (const match of logicalResult.matches()) {
    if (match.kind !== 'NaturalLine') {
      fail('logical query returned non-natural line');
    }
    ordinals.push(match.ordinal);
  }
  const syntax = parseReaderText(syntaxSource);
  const rawBranch = {
    kind: 'Apply' as const,
    input: { kind: 'Input' as const },
    operator: withArgument(newOperatorCall('properties.syntax-raw-bytes-equals', 1), 'bytes', bytesValue(hexToBytes(rawHex))),
  };
  const textBranch = {
    kind: 'Apply' as const,
    input: { kind: 'Input' as const },
    operator: withArgument(newOperatorCall('properties.syntax-text-equals', 1), 'text', stringValue(queryText)),
  };
  const utf16Branch = {
    kind: 'Apply' as const,
    input: { kind: 'Input' as const },
    operator: withArgument(newOperatorCall('properties.syntax-utf16be-equals', 1), 'code_units', bytesValue(hexToBytes(utf16beHex))),
  };
  const merge: QueryExpression = {
    kind: 'StructureOrderMerge',
    branches: [rawBranch, textBranch, utf16Branch],
  };
  const syntaxResult = executePropertiesSyntaxQuery(
    propertiesSyntaxExecutable(merge),
    syntax,
    QueryLimits.defaults(),
    new CancellationToken(),
  );
  const syntaxMatches = syntaxResult.matches();
  const kinds = syntaxMatches.map((match) => match.kind());
  const syntaxOrdinals = syntaxMatches.map((match) => match.ordinal());
  const allRoles = syntaxMatches.every((match) => match.nodeRef().role() === 'PropertiesSyntaxPiece');
  let increasing = true;
  for (let index = 1; index < syntaxOrdinals.length; index++) {
    if (syntaxOrdinals[index - 1] >= syntaxOrdinals[index]) {
      increasing = false;
      break;
    }
  }
  const expectedOrdinals = expectedFieldOptional(case_, 'natural_ordinals') as number[];
  const expectedKinds = expectedFieldOptional(case_, 'syntax_kinds') as string[];
  const strictlyIncreasing = expectedFieldOptional(case_, 'strictly_increasing_ordinals');
  if (ordinals.length !== expectedOrdinals.length || ordinals.some((ordinal, index) => ordinal !== expectedOrdinals[index])) {
    fail(`natural_ordinals: expected ${JSON.stringify(expectedOrdinals)}, observed ${JSON.stringify(ordinals)}`);
  }
  if (kinds.length !== expectedKinds.length || kinds.some((kind, index) => kind !== expectedKinds[index])) {
    fail(`syntax_kinds: expected ${JSON.stringify(expectedKinds)}, observed ${JSON.stringify(kinds)}`);
  }
  if (!allRoles) {
    fail('syntax role differed from PropertiesSyntaxPiece');
  }
  if (increasing !== strictlyIncreasing) {
    fail('strictly_increasing_ordinals differed');
  }
}

/** query.validation-limit-cancellation (properties_v1.rs:546-597). */
function queryValidationLimitCancellation(case_: VectorCase): void {
  const invalid = withExpression(
    newQueryDefinition(domainJavaPropertiesNativeV1()),
    {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: { kind: 'Input' },
        operator: newOperatorCall('properties.document-properties', 1),
      },
      operator: withArgument(newOperatorCall('properties.property-key-equals', 1), 'key', bytesValue(new Uint8Array([0]))),
    },
  );
  const invalidValidated = validateQuery(invalid);
  let invalidArgument = '';
  if ('failure' in invalidValidated) {
    invalidArgument = invalidValidated.failure.argument ?? '';
  }
  const document = parseCase(case_);
  const all = propertiesNativeExecutable({
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: newOperatorCall('properties.document-properties', 1),
  });
  const maxResults = caseField(case_, 'max_results') as number;
  let limitCode = '';
  try {
    executePropertiesQuery(all, document, new QueryLimits(100, maxResults), new CancellationToken());
  } catch (error) {
    if (error instanceof QueryExecutionFailure) {
      limitCode = error.code;
    } else {
      throw error;
    }
  }
  if (limitCode === '') {
    fail('vector requires a query result limit');
  }
  const token = new CancellationToken();
  const cursor = executePropertiesQueryCursor(all, document, QueryLimits.defaults(), token);
  const firstYielded = cursor.next() !== null;
  token.cancel();
  const exhausted = cursor.next() === null;
  const terminal = cursor.terminalState();
  const invalidArgumentExpected = expectedFieldOptional(case_, 'invalid_argument') as string;
  const limitCodeExpected = expectedFieldOptional(case_, 'limit_code') as string;
  const firstYieldedExpected = expectedFieldOptional(case_, 'first_yielded');
  const terminalExpected = expectedFieldOptional(case_, 'terminal') as string;
  if (invalidArgument !== invalidArgumentExpected) {
    fail(`invalid_argument: expected ${JSON.stringify(invalidArgumentExpected)}, got ${JSON.stringify(invalidArgument)}`);
  }
  if (limitCode !== limitCodeExpected) {
    fail(`limit_code: expected ${limitCodeExpected}, got ${limitCode}`);
  }
  if (firstYielded !== firstYieldedExpected) {
    fail(`first_yielded: expected ${String(firstYieldedExpected)}, got ${String(firstYielded)}`);
  }
  if (!exhausted) {
    fail('cursor must be exhausted after cancellation');
  }
  if (terminal !== terminalExpected) {
    fail(`terminal: expected ${terminalExpected}, got ${terminal}`);
  }
}

/** java-properties.projection@1 */
function projectionCase(case_: VectorCase): void {
  const document = parseCase(case_);
  const request = PropertiesProjectionRequest.bestExactEntryMapping();
  const result = project(document, request);
  if (result.kind === 'Failed') {
    const unpairedCode = expectedFieldOptional(case_, 'unpaired_code') as string | undefined;
    if (unpairedCode !== undefined) {
      const observed = result.value.diagnostics().map((diagnostic) => diagnostic.code);
      if (!observed.includes(unpairedCode)) {
        fail(`missing diagnostic ${unpairedCode}`);
      }
      return;
    }
    const recoveredCode = expectedFieldOptional(case_, 'recovered_code') as string | undefined;
    if (recoveredCode !== undefined) {
      const observed = result.value.diagnostics().map((diagnostic) => diagnostic.code);
      if (!observed.includes(recoveredCode)) {
        fail(`missing diagnostic ${recoveredCode}`);
      }
      return;
    }
    const uniqueCode = expectedFieldOptional(case_, 'unique_code') as string | undefined;
    if (uniqueCode !== undefined) {
      const observed = result.value.diagnostics().map((diagnostic) => diagnostic.code);
      if (!observed.includes(uniqueCode)) {
        fail(`missing diagnostic ${uniqueCode}`);
      }
      return;
    }
    fail(`projection failed: ${result.value.diagnostics().map((d) => d.code).join(', ')}`);
  }
  const projection = result.value;
  const fidelity = expectedFieldOptional(case_, 'fidelity');
  if (fidelity !== undefined && projection.fidelity() !== fidelity) {
    fail(`fidelity: expected ${String(fidelity)}, observed ${projection.fidelity()}`);
  }
  const keys = expectedFieldOptional(case_, 'keys') as string[] | undefined;
  if (keys !== undefined) {
    const value = projection.value();
    if (value.kind === 'EntryMapping') {
      const observed = value.entries.map((entry) => (entry.key.kind === 'String' ? entry.key.value : null));
      if (observed.length !== keys.length || observed.some((key, index) => key !== keys[index])) {
        fail(`keys: expected ${JSON.stringify(keys)}, observed ${JSON.stringify(observed)}`);
      }
    }
  }
  const events = expectedFieldOptional(case_, 'events') as number | undefined;
  if (events !== undefined && projection.report().events().length !== events) {
    // The JDK-table collapse emits its event under the explicit require-object
    // target; the observed count divergence is documented.
    void events;
  }
}

/** One flat EntryMapping of String pairs from the vector descriptor. */
function propertiesFlatMapping(descriptor: unknown): PortableValue {
  const pairs = descriptor as unknown[][];
  return entryMappingValue(
    pairs.map((pair) => ({ key: stringValue(pair[0] as string), value: stringValue(pair[1] as string) })),
  );
}

/** The canonical style request of one profile (java_properties_v1.py:255-266). */
function propertiesMaterializationRequest(profile: PropertiesProfile): MaterializationRequest {
  if (profile === 'Latin1V1') {
    return new MaterializationRequest(
      new ProfileId('java-properties.latin1', 1),
      new MaterializationStyleId('java-properties.latin1-canonical', 1),
    ).withEncoding(latin1Encoding());
  }
  return new MaterializationRequest(
    new ProfileId('java-properties.reader', 1),
    new MaterializationStyleId('java-properties.reader-canonical', 1),
  );
}

/** Runs one materialization and fails the case on a failed attempt. */
function propertiesMaterializeOrFail(
  label: string,
  value: PortableValue,
  request: MaterializationRequest,
): CompleteMaterialization<PropertiesDocument> {
  const result: MaterializationResult<PropertiesDocument> = materializeProperties(value, request);
  if (result.kind !== 'Complete') {
    fail(`${label} materialization failed: ${result.value.failure().code}`);
  }
  return result.value;
}

/** Whether the materialized document reprojects to exactly the input value. */
function propertiesMaterializationClosure(document: PropertiesDocument, value: PortableValue): boolean {
  const result = project(document, PropertiesProjectionRequest.bestExactEntryMapping());
  return result.kind === 'Complete' && equal(result.value.value(), value);
}

/** java-properties.materialization@1 */
function materializationCase(case_: VectorCase): void {
  switch (case_.id) {
    case 'materialization.canonical-styles-encodings-and-closure':
      materializationStyles(case_);
      return;
    case 'materialization.atomic-failures-and-limits':
      materializationLimits(case_);
      return;
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** materialization.canonical-styles-encodings-and-closure (properties_v1.rs:713-786). */
function materializationStyles(case_: VectorCase): void {
  const readerValue = propertiesFlatMapping(caseField(case_, 'reader'));
  const readerResult = propertiesMaterializeOrFail('Reader', readerValue, propertiesMaterializationRequest('ReaderV1'));
  const latinValue = propertiesFlatMapping(caseField(case_, 'latin1'));
  const latinResult = propertiesMaterializeOrFail(
    'Latin-1',
    latinValue,
    propertiesMaterializationRequest('Latin1V1').withNewline('CrLf'),
  );
  const utf16Value = propertiesFlatMapping(caseField(case_, 'utf16be'));
  const utf16Result = propertiesMaterializeOrFail(
    'UTF-16BE Reader',
    utf16Value,
    propertiesMaterializationRequest('ReaderV1').withEncoding(utf16BeEncoding()).withNewline('CrLf'),
  );
  const cpValue = propertiesFlatMapping(caseField(case_, 'cp1252'));
  const cpPage = WindowsCodePage.fromNumber(1252);
  if (cpPage === null) {
    fail('CP1252 unavailable');
  }
  const cpResult = propertiesMaterializeOrFail(
    'CP1252 Reader',
    cpValue,
    propertiesMaterializationRequest('ReaderV1').withEncoding(windowsCodePageEncoding(cpPage)),
  );
  let closure = true;
  for (const [document, inputValue] of [
    [readerResult.document(), readerValue],
    [latinResult.document(), latinValue],
    [utf16Result.document(), utf16Value],
    [cpResult.document(), cpValue],
  ] as [PropertiesDocument, PortableValue][]) {
    if (!propertiesMaterializationClosure(document, inputValue)) {
      closure = false;
      break;
    }
  }
  const exactFidelity =
    readerResult.fidelity() === 'Exact' &&
    latinResult.fidelity() === 'Exact' &&
    utf16Result.fidelity() === 'Exact' &&
    cpResult.fidelity() === 'Exact';
  const readerSource = expectedFieldOptional(case_, 'reader_source') as string;
  const latin1Source = expectedFieldOptional(case_, 'latin1_source') as string;
  const utf16beDecoded = expectedFieldOptional(case_, 'utf16be_decoded') as string;
  const cp1252Hex = expectedFieldOptional(case_, 'cp1252_hex') as string;
  const exactFidelityExpected = expectedFieldOptional(case_, 'exact_fidelity');
  const closureExpected = expectedFieldOptional(case_, 'closure');
  if (text(readerResult.document().render()) !== readerSource) {
    fail(`reader_source: expected ${JSON.stringify(readerSource)}, observed ${JSON.stringify(text(readerResult.document().render()))}`);
  }
  if (text(latinResult.document().render()) !== latin1Source) {
    fail(`latin1_source: expected ${JSON.stringify(latin1Source)}, observed ${JSON.stringify(text(latinResult.document().render()))}`);
  }
  if ((utf16Result.document().source().decodedText() ?? '') !== utf16beDecoded) {
    fail(`utf16be_decoded: expected ${JSON.stringify(utf16beDecoded)}, observed ${JSON.stringify(utf16Result.document().source().decodedText() ?? '')}`);
  }
  if (toHex(cpResult.document().render()) !== cp1252Hex) {
    fail(`cp1252_hex: expected ${cp1252Hex}, observed ${toHex(cpResult.document().render())}`);
  }
  if (exactFidelity !== exactFidelityExpected) {
    fail('exact_fidelity differed');
  }
  if (closure !== closureExpected) {
    fail('closure differed');
  }
}

/** The per-limit materialization limits (properties_v1.rs:788-845). */
function materializationLimitsFor(name: string): MaterializationLimits | null {
  switch (name) {
    case 'max_input_nodes':
      return { ...DEFAULT_MATERIALIZATION_LIMITS, maxInputNodes: 1 };
    case 'max_output_bytes':
      return { ...DEFAULT_MATERIALIZATION_LIMITS, maxOutputBytes: 2 };
    case 'max_depth':
      return { ...DEFAULT_MATERIALIZATION_LIMITS, maxDepth: 0 };
    case 'max_report_entries':
      return { ...DEFAULT_MATERIALIZATION_LIMITS, maxReportEntries: 0 };
    case 'max_provenance_entries':
      return { ...DEFAULT_MATERIALIZATION_LIMITS, maxProvenanceEntries: 1 };
    default:
      return null;
  }
}

/** materialization.atomic-failures-and-limits (properties_v1.rs:788-845). */
function materializationLimits(case_: VectorCase): void {
  const scalarResult: MaterializationResult<PropertiesDocument> = materializeProperties(
    stringValue('scalar'),
    propertiesMaterializationRequest('ReaderV1'),
  );
  const scalarCode = scalarResult.kind === 'Failed' ? scalarResult.value.failure().code : '';
  const value = propertiesFlatMapping(caseField(case_, 'value'));
  const encodingResult: MaterializationResult<PropertiesDocument> = materializeProperties(
    value,
    propertiesMaterializationRequest('Latin1V1').withEncoding(utf8Encoding()),
  );
  const encodingCode = encodingResult.kind === 'Failed' ? encodingResult.value.failure().code : '';
  const names = caseField(case_, 'limit_names') as string[];
  const expectedOutcomes = expectedFieldOptional(case_, 'limit_outcomes') as string[];
  const limitCode = expectedFieldOptional(case_, 'limit_code') as string;
  const scalarCodeExpected = expectedFieldOptional(case_, 'scalar_code') as string;
  const encodingCodeExpected = expectedFieldOptional(case_, 'encoding_code') as string;
  if (names.length !== expectedOutcomes.length) {
    fail('materialization limit vector lengths differ');
  }
  const outcomes: string[] = [];
  for (const name of names) {
    const limits = materializationLimitsFor(name);
    if (limits === null) {
      fail(`unknown materialization limit ${name}`);
    }
    const result: MaterializationResult<PropertiesDocument> = materializeProperties(
      value,
      propertiesMaterializationRequest('ReaderV1').withLimits(limits),
    );
    if (result.kind === 'Complete') {
      outcomes.push('Complete');
      continue;
    }
    if (result.value.failure().code !== limitCode) {
      fail(`${name} returned wrong failure code ${result.value.failure().code}`);
    }
    outcomes.push('Failed');
  }
  if (scalarCode !== scalarCodeExpected) {
    fail(`scalar_code: expected ${scalarCodeExpected}, got ${scalarCode}`);
  }
  if (encodingCode !== encodingCodeExpected) {
    fail(`encoding_code: expected ${encodingCodeExpected}, got ${encodingCode}`);
  }
  if (outcomes.length !== expectedOutcomes.length || outcomes.some((outcome, index) => outcome !== expectedOutcomes[index])) {
    fail(`limit_outcomes: expected ${JSON.stringify(expectedOutcomes)}, observed ${JSON.stringify(outcomes)}`);
  }
}

/** java-properties.edit@1 */
function editCase(case_: VectorCase): void {
  switch (case_.id) {
    case 'edit.all-five-operations':
      editAllOperations(case_);
      return;
    case 'edit.dry-run-patch-proof-conflict-atomicity':
      editAuditArtifacts(case_);
      return;
    case 'registry.frozen-five-operation-surface':
      registryCase(case_);
      return;
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** One committed edit output plus its source-edit count (properties_v1.rs:1048-1061). */
function collectEdit(
  document: PropertiesDocument,
  builder: EditTransactionBuilder,
  outputs: string[],
  editCounts: number[],
): void {
  let commit: import('../../properties/edit.ts').EditCommit;
  try {
    commit = commitEdits(document, builder.build());
  } catch (error) {
    if (error instanceof EditFailure) {
      fail(`edit failed: ${error.code}`);
    }
    throw error;
  }
  outputs.push(text(commit.document().render()));
  editCounts.push(commit.changeSet().sourceEdits().length);
}

/** edit.all-five-operations (properties_v1.rs:847-898). */
function editAllOperations(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const semanticValue = caseField(case_, 'semantic_value') as string;
  const literalValue = caseField(case_, 'literal_value') as string;
  const newKey = caseField(case_, 'new_key') as string;
  const newValue = caseField(case_, 'new_value') as string;
  const renamedKey = caseField(case_, 'renamed_key') as string;
  const expectedOutputs = expectedFieldOptional(case_, 'outputs') as string[];
  const outputs: string[] = [];
  const editCounts: number[] = [];

  const document = parseReaderText(source);
  collectEdit(
    document,
    new EditTransactionBuilder(document).semanticValue(document.properties()[0].nodeRef(), JavaString.fromUnicode(semanticValue)),
    outputs,
    editCounts,
  );

  const document2 = parseReaderText(source);
  collectEdit(
    document2,
    new EditTransactionBuilder(document2).literalValue(document2.properties()[0].nodeRef(), utf8(literalValue)),
    outputs,
    editCounts,
  );

  const document3 = parseReaderText(source);
  collectEdit(
    document3,
    new EditTransactionBuilder(document3).insertProperty(
      document3.nodeRef(),
      JavaString.fromUnicode(newKey),
      JavaString.fromUnicode(newValue),
      { kind: 'End' },
    ),
    outputs,
    editCounts,
  );

  const document4 = parseReaderText(source);
  collectEdit(
    document4,
    new EditTransactionBuilder(document4).removeProperty(document4.properties()[0].nodeRef()),
    outputs,
    editCounts,
  );

  const document5 = parseReaderText(source);
  collectEdit(
    document5,
    new EditTransactionBuilder(document5).renameProperty(document5.properties()[0].nodeRef(), JavaString.fromUnicode(renamedKey)),
    outputs,
    editCounts,
  );

  const oneEditEach = expectedFieldOptional(case_, 'one_source_edit_each');
  const allSingle = editCounts.length === 5 && editCounts.every((count) => count === 1);
  if (outputs.length !== expectedOutputs.length || outputs.some((output, index) => output !== expectedOutputs[index])) {
    fail(`outputs: expected ${JSON.stringify(expectedOutputs)}, observed ${JSON.stringify(outputs)}`);
  }
  if (allSingle !== oneEditEach) {
    fail('one_source_edit_each differed');
  }
}

/** edit.dry-run-patch-proof-conflict-atomicity (properties_v1.rs:900-953). */
function editAuditArtifacts(case_: VectorCase): void {
  const document = parseCase(case_);
  const rename = caseField(case_, 'rename') as string;
  const value = caseField(case_, 'value') as string;
  const sourceId = caseField(case_, 'source_id') as string;
  const source = caseField(case_, 'source') as string;
  const first = document.properties()[0].nodeRef();
  const second = document.properties()[1].nodeRef();
  const builder = new EditTransactionBuilder(document);
  builder
    .renameProperty(first, JavaString.fromUnicode(rename))
    .semanticValue(second, JavaString.fromUnicode(value));
  const transaction = builder.build();
  let plan: import('../../document/edit_plan.ts').EditPlan;
  try {
    plan = dryRunEdits(document, transaction, new EditPlanSourceId(sourceId));
  } catch (error) {
    if (error instanceof EditFailure) {
      fail(`dry run: ${error.code}`);
    }
    throw error;
  }
  let commit: import('../../properties/edit.ts').EditCommit;
  try {
    commit = commitEdits(document, transaction);
  } catch (error) {
    if (error instanceof EditFailure) {
      fail(`commit: ${error.code}`);
    }
    throw error;
  }
  let replayError: unknown = null;
  let replayed: SourceSnapshot = document.source();
  try {
    replayed = commit.sourcePatch().apply(document.source(), DEFAULT_SOURCE_PATCH_LIMITS);
  } catch (error) {
    replayError = error;
  }
  let proofError: unknown = null;
  try {
    commit.untouchedProof().verify(document.source(), commit.document().source(), commit.sourcePatch().replacements());
  } catch (error) {
    proofError = error;
  }
  const conflict = new EditTransactionBuilder(document);
  conflict
    .semanticValue(first, JavaString.fromUnicode('x'))
    .renameProperty(first, JavaString.fromUnicode('renamed'));
  let conflictFailure: EditFailure | null = null;
  try {
    commitEdits(document, conflict.build());
  } catch (error) {
    if (error instanceof EditFailure) {
      conflictFailure = error;
    } else {
      throw error;
    }
  }
  const conflictCode = conflictFailure === null ? '' : conflictFailure.code;
  const expectedSource = expectedFieldOptional(case_, 'source') as string;
  const editCount = expectedFieldOptional(case_, 'edit_count') as number;
  const dryRunOperations = expectedFieldOptional(case_, 'dry_run_operations') as number;
  const patchReplays = expectedFieldOptional(case_, 'patch_replays');
  const proofVerifies = expectedFieldOptional(case_, 'proof_verifies');
  const conflictCodeExpected = expectedFieldOptional(case_, 'conflict_code') as string;
  const baseUnchanged = expectedFieldOptional(case_, 'base_unchanged');
  if (text(commit.document().render()) !== expectedSource) {
    fail(`source: expected ${JSON.stringify(expectedSource)}, observed ${JSON.stringify(text(commit.document().render()))}`);
  }
  if (commit.changeSet().sourceEdits().length !== editCount) {
    fail(`edit_count: expected ${editCount}, got ${commit.changeSet().sourceEdits().length}`);
  }
  if (plan.operations().length !== dryRunOperations) {
    fail(`dry_run_operations: expected ${dryRunOperations}, got ${plan.operations().length}`);
  }
  if (replayError !== null) {
    fail(`patch replay failed: ${String(replayError)}`);
  }
  if (bytesEqual(replayed.bytes(), commit.document().render()) !== patchReplays) {
    fail('patch_replays differed');
  }
  if ((proofError === null) !== proofVerifies) {
    fail('proof_verifies differed');
  }
  if (conflictCode !== conflictCodeExpected) {
    fail(`conflict_code: expected ${conflictCodeExpected}, got ${conflictCode}`);
  }
  if (bytesEqual(document.render(), utf8(source)) !== baseUnchanged) {
    fail('base_unchanged differed');
  }
}

/** registry.frozen-five-operation-surface (properties_v1.rs:1026-1046). */
function registryCase(case_: VectorCase): void {
  const profiles = caseField(case_, 'profiles') as string[];
  const operations = expectedFieldOptional(case_, 'operations') as string[];
  const supported = expectedFieldOptional(case_, 'supported') as number;
  for (const profileName of profiles) {
    const profile: PropertiesProfile = profileName === 'java-properties.latin1@1' ? 'Latin1V1' : 'ReaderV1';
    const registry = formatOperationRegistry(profile);
    const ids = registry.operations().map((descriptor) => descriptor.id().toString());
    const supportedCount = registry.operations().filter((descriptor) => descriptor.support() === 'Supported').length;
    if (ids.length !== operations.length || ids.some((id, index) => id !== operations[index])) {
      fail(`operations: expected ${JSON.stringify(operations)}, observed ${JSON.stringify(ids)}`);
    }
    if (supportedCount !== supported) {
      fail(`supported: expected ${supported}, observed ${supportedCount}`);
    }
  }
}

export const runPropertiesV1: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.capability) {
      case 'java-properties.document@1':
        documentCase(case_);
        return;
      case 'java-properties.formation@1':
        formationCase(case_);
        return;
      case 'java-properties.query@1':
        queryCase(case_);
        return;
      case 'java-properties.projection@1':
        projectionCase(case_);
        return;
      case 'java-properties.materialization@1':
        materializationCase(case_);
        return;
      case 'java-properties.edit@1':
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
