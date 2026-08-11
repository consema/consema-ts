/**
 * `consema.hcl.conformance@1` runner (57 cases; mirror of
 * crates/consema-conformance/src/hcl_v1.rs). Dispatch is by the vector
 * `capability` field: formation (native/tfvars), limit, native-semantic and
 * lossless-syntax query, body projection with the ProjectExpression policy,
 * canonical materialization with the reparse closure, and the structural
 * edits.
 */

import type { VectorCase } from '../helpers.ts';
import { caseField, caseFieldOptional, expectedField, expectedFieldOptional, utf8, bytesEqual, text } from '../helpers.ts';
import { fail, SkippedCase } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import { parseHcl, profileDefaultEncoding, HclBlock } from '../../hcl/document.ts';
import type { HclDocument, HclBody } from '../../hcl/document.ts';
import { HclProfile, hclNativeQueryDomain, hclLosslessSyntaxQueryDomain, hclCanonicalDocumentStyle } from '../../hcl/profile.ts';
import { HclFormationFailure, HclEditFailure } from '../../hcl/errors.ts';
import { DEFAULT_HCL_PARSE_LIMITS } from '../../hcl/limits.ts';
import type { HclParseLimits } from '../../hcl/limits.ts';
import {
  executeHclNativeQuery,
  executeHclSyntaxQuery,
  HclQueryExecutionFailure,
  DEFAULT_HCL_QUERY_LIMITS,
  HclCancellationToken,
  hclQueryRequiredCapabilities,
} from '../../hcl/query.ts';
import type { HclMatch, HclSyntaxMatch } from '../../hcl/query.ts';
import { isLiteralComplete, literalValue, expressionKindOf, expressionKindNameAsStr } from '../../hcl/expression.ts';
import { projectHcl, HclProjectionRequest } from '../../hcl/projection.ts';
import { materializeHcl } from '../../hcl/materialization.ts';
import type { HclBodyRecordInput } from '../../hcl/materialization.ts';
import { commitHclEdits, dryRunHclEdits, HclEditTransactionBuilder, HclBodyPath } from '../../hcl/edit.ts';
import type { HclEditCommit, HclEditTransaction, HclEditValue, HclEditKey, HclBodyPlacement } from '../../hcl/edit.ts';
import { MaterializationRequest } from '../../document/materialization.ts';
import type { CompleteMaterialization } from '../../document/materialization.ts';
import type { MaterializationFailure } from '../../document/errors.ts';
import { DEFAULT_SOURCE_PATCH_LIMITS } from '../../document/source_patch.ts';
import type { SourceReplacement } from '../../document/source_patch.ts';
import type { SourceSnapshot } from '../../document/source.ts';
import { EditPlanSourceId } from '../../document/edit_plan.ts';
import { validateQuery, bindQuery, newQueryDefinition, newOperatorCall, withArgument, withExpression, QueryFailure } from '../../protocol/query.ts';
import type { QueryDomain, OperatorCall, QueryExpression, ExecutableQuery } from '../../protocol/query.ts';
import { stringValue } from '../../core/value.ts';
import type { PortableValue } from '../../core/value.ts';

function profileOf(profileId: string): HclProfile {
  return profileId === 'hcl.tfvars@1' ? HclProfile.TFVARS_V1 : HclProfile.NATIVE_V1;
}

function parseCase(case_: VectorCase): HclDocument {
  const profile = caseField(case_, 'profile') as string;
  const source = caseField(case_, 'source') as string;
  return parseHcl(utf8(source), profileOf(profile), profileDefaultEncoding(), DEFAULT_HCL_PARSE_LIMITS);
}

/** One sample's facts merged over the case-level input facts (sample wins). */
function mergedCase(case_: VectorCase, sample: Record<string, unknown>): VectorCase {
  return { ...case_, input: { ...(case_.input as Record<string, unknown>), ...sample } };
}

/** hcl.native-formation@1 / hcl.tfvars-formation@1 */
function formationCase(case_: VectorCase): void {
  const samples = caseFieldOptional(case_, 'samples') as { source: string }[] | undefined;
  const statuses = expectedFieldOptional(case_, 'statuses') as string[] | undefined;
  const diagnostics = expectedFieldOptional(case_, 'diagnostics') as (string | null)[] | undefined;
  if (samples !== undefined) {
    samples.forEach((sample, index) => {
      let document: HclDocument;
      try {
        document = parseCase({ ...case_, input: { ...(case_.input as object), source: sample.source } });
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
          fail(`sample ${index}: missing diagnostic ${diagnostics[index]} (observed ${observed.join(', ')})`);
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
  const diagnostic = expectedFieldOptional(case_, 'diagnostic') as string | undefined;
  if (diagnostic !== undefined) {
    const observed = document.diagnostics().map((item) => item.code);
    if (!observed.includes(diagnostic)) {
      fail(`missing diagnostic ${diagnostic} (observed ${observed.join(', ')})`);
    }
  }
}

/** hcl.limit@1 */
function limitCase(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const limits = caseFieldOptional(case_, 'limits') as Record<string, number> | undefined;
  const profile = caseFieldOptional(case_, 'profile') as string | undefined;
  const hclLimits: HclParseLimits = { ...DEFAULT_HCL_PARSE_LIMITS };
  if (limits !== undefined) {
    for (const key of Object.keys(limits)) {
      (hclLimits as unknown as Record<string, unknown>)[snakeToCamel(key)] = limits[key];
    }
  }
  const expectedDiagnostic = expectedFieldOptional(case_, 'diagnostic') as string | undefined;
  const expectedStatus = expectedFieldOptional(case_, 'status') as string | undefined;
  try {
    parseHcl(
      utf8(source),
      profile !== undefined ? profileOf(profile) : HclProfile.NATIVE_V1,
      profileDefaultEncoding(),
      hclLimits,
    );
  } catch (error) {
    if (expectedStatus === 'FatalFormationFailure' && expectedDiagnostic !== undefined) {
      const diagnostics = (error as { diagnostics?: readonly { code: string }[] })?.diagnostics ?? [];
      if (diagnostics.some((item) => item.code === expectedDiagnostic)) {
        return;
      }
    }
    fail(`expected ${expectedDiagnostic}, observed ${String(error)}`);
  }
  if (expectedStatus === 'FatalFormationFailure') {
    fail('expected a fatal formation failure');
  }
}

/** snake_case vector limit names -> camelCase HclParseLimits fields. */
function snakeToCamel(name: string): string {
  const parts = name.split('_');
  return parts[0] + parts.slice(1).map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

// ---------------------------------------------------------------------------
// Query (hcl.query@1)
// ---------------------------------------------------------------------------

/** The frozen argument name of one operator (hcl_v1.rs:586-606). */
function argumentNameFor(id: string): string {
  switch (id) {
    case 'hcl.attribute-name-equals':
      return 'name';
    case 'hcl.attribute-literal-value':
      return 'accessor';
    case 'hcl.body-block-type-equals':
    case 'hcl.block-type-equals':
      return 'type';
    case 'hcl.block-label-equals':
      return 'label';
    case 'hcl.expression-kind-is':
    case 'hcl.syntax-kind-is':
      return 'kind';
    case 'hcl.syntax-text-equals':
      return 'text';
    default:
      return 'argument';
  }
}

/** Builds the frozen operator vocabulary from one vector filter list. */
function buildFilters(filters: readonly Record<string, unknown>[]): OperatorCall[] {
  const calls: OperatorCall[] = [];
  for (const filter of filters) {
    const operator = filter.operator as string;
    if (typeof operator !== 'string') {
      fail('missing filter.operator');
    }
    const at = operator.lastIndexOf('@');
    const id = operator.slice(0, at);
    const version = Number(operator.slice(at + 1));
    let call = newOperatorCall(id, version);
    const argument = filter.argument as string | undefined;
    if (argument !== undefined) {
      call = withArgument(call, argumentNameFor(id), stringValue(argument));
    }
    calls.push(call);
  }
  return calls;
}

/** Validates and binds one operator chain into an executable query. */
function bindQueryExecutable(calls: readonly OperatorCall[], domain: QueryDomain): ExecutableQuery {
  let expression: QueryExpression = { kind: 'Input' };
  for (const call of calls) {
    expression = { kind: 'Apply', input: expression, operator: call };
  }
  const definition = withExpression(newQueryDefinition(domain), expression);
  const validated = validateQuery(definition);
  if ('failure' in validated) {
    throw validated.failure;
  }
  const bound = bindQuery(validated.query, hclQueryRequiredCapabilities());
  if ('failure' in bound) {
    throw bound.failure;
  }
  return bound.query;
}

/** Stable vector spelling of one query failure (hcl_v1.rs:656-670). */
function queryFailureCode(error: unknown): string {
  if (error instanceof HclQueryExecutionFailure) {
    return error.code;
  }
  if (error instanceof QueryFailure) {
    switch (error.kind) {
      case 'DomainMismatch':
        return 'hcl.query.domain-mismatch@1';
      case 'UnknownOperator':
        return 'hcl.query.unknown-operator@1';
      case 'WrongArgumentType':
        return 'hcl.query.wrong-argument-type@1';
      case 'InvalidArgument':
        return 'hcl.query.invalid-argument@1';
      case 'InvalidOperatorComposition':
        return 'hcl.query.invalid-composition@1';
      case 'MissingCapability':
        return 'hcl.query.missing-capability@1';
    }
  }
  return 'hcl.query.invalid-argument@1';
}

/** Expression facts of one expression match: kind name, exact text, literal predicate. */
function expressionFacts(document: HclDocument, match: HclMatch): { kind: string; text: string; literal: boolean } {
  if (match.kind !== 'Expression') {
    fail('match without expression payload');
  }
  const expression = document.expression(match.node);
  return {
    kind: expressionKindNameAsStr(expressionKindOf(expression.node())),
    text: expression.text(),
    literal: isLiteralComplete(expression.node()),
  };
}

/** hcl.query@1 */
function queryCase(case_: VectorCase): void {
  const domain = caseField(case_, 'domain') as string;
  if (domain === 'hcl.native-semantic-query@1') {
    nativeQueryCase(case_);
    return;
  }
  if (domain === 'hcl.lossless-syntax-query@1') {
    syntaxQueryCase(case_);
    return;
  }
  fail(`unknown query domain ${domain}`);
}

function nativeQueryCase(case_: VectorCase): void {
  const samples = caseFieldOptional(case_, 'samples') as Record<string, unknown>[] | undefined;
  if (samples !== undefined) {
    nativeQuerySamples(case_, samples);
    return;
  }
  const document = parseCase(case_);
  // An `expected.error_regions` case queries a Recovered document: the
  // `hcl.error-regions@1` operator exposes its ordered error regions as
  // document-level facts (RFC 0014 §3, §7.1).
  const expectsErrorRegions = expectedFieldOptional(case_, 'error_regions') !== undefined;
  if (document.formationStatus() !== 'Complete' && !expectsErrorRegions) {
    fail('native-query input must form completely');
  }
  const filters = caseField(case_, 'filters') as Record<string, unknown>[];
  const calls = buildFilters(filters);
  const execution = executeHclNativeQuery(
    bindQueryExecutable(calls, hclNativeQueryDomain()),
    document,
    DEFAULT_HCL_QUERY_LIMITS,
    new HclCancellationToken(),
  );
  const terminal = expectedField(case_, 'terminal') as string;
  if (terminal !== 'Completed') {
    fail(`terminal Completed != ${terminal}`);
  }
  const expectedMatches = expectedFieldOptional(case_, 'matches') as Record<string, unknown>[] | undefined;
  if (expectedMatches !== undefined) {
    const matches = execution.matches;
    if (matches.length !== expectedMatches.length) {
      fail(`match count ${matches.length} != ${expectedMatches.length}`);
    }
    for (let index = 0; index < expectedMatches.length; index++) {
      assertExpressionMatch(document, matches[index], expectedMatches[index]);
    }
  }
  const expectedRegions = expectedFieldOptional(case_, 'error_regions') as Record<string, unknown>[] | undefined;
  if (expectedRegions !== undefined) {
    const regions: { code: string; position: number }[] = [];
    for (const match of execution.matches) {
      if (match.kind === 'ErrorRegion') {
        regions.push({ code: match.code, position: match.position });
      }
    }
    if (regions.length !== expectedRegions.length) {
      fail(`error region count ${regions.length} != ${expectedRegions.length}`);
    }
    for (let index = 0; index < expectedRegions.length; index++) {
      const expectedRegion = expectedRegions[index];
      const expectedCode = expectedRegion.code as string | undefined;
      if (expectedCode !== undefined && regions[index].code !== expectedCode) {
        fail(`error region code ${regions[index].code} != ${expectedCode}`);
      }
      const expectedPosition = expectedRegion.position as number | undefined;
      if (expectedPosition !== undefined && regions[index].position !== expectedPosition) {
        fail(`error region position ${regions[index].position} != ${expectedPosition}`);
      }
    }
  }
}

function nativeQuerySamples(case_: VectorCase, samples: readonly Record<string, unknown>[]): void {
  const terminals = expectedField(case_, 'terminals') as string[];
  if (samples.length !== terminals.length) {
    fail('terminal count mismatch');
  }
  const codes = expectedFieldOptional(case_, 'codes') as (string | null)[] | undefined;
  const integerMatches = expectedFieldOptional(case_, 'integer_matches') as Record<string, unknown>[] | undefined;
  const booleanMatches = expectedFieldOptional(case_, 'boolean_matches') as Record<string, unknown>[] | undefined;
  const labelMatches = expectedFieldOptional(case_, 'label_matches') as Record<string, unknown>[] | undefined;
  const nestedMatches = expectedFieldOptional(case_, 'nested_matches') as Record<string, unknown>[] | undefined;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const document = parseCase(mergedCase(case_, sample));
    if (document.formationStatus() !== 'Complete') {
      fail('native-query input must form completely');
    }
    const filters = sample.filters as Record<string, unknown>[] | undefined;
    if (!Array.isArray(filters)) {
      fail('missing sample filters');
    }
    const lastOperator = filters.length > 0 ? (filters[filters.length - 1].operator as string) : '';
    const calls = buildFilters(filters);
    const terminal = terminals[index];
    if (terminal === 'Completed') {
      const execution = executeHclNativeQuery(
        bindQueryExecutable(calls, hclNativeQueryDomain()),
        document,
        DEFAULT_HCL_QUERY_LIMITS,
        new HclCancellationToken(),
      );
      if (lastOperator === 'hcl.attribute-literal-value' && sampleAccessor(sample) === 'as-integer' && integerMatches !== undefined) {
        assertIntegerMatches(document, execution.matches, integerMatches);
      } else if (lastOperator === 'hcl.attribute-literal-value' && sampleAccessor(sample) === 'as-boolean-is' && booleanMatches !== undefined) {
        assertBooleanMatches(document, execution.matches, booleanMatches);
      } else if (lastOperator === 'hcl.block-label-equals' && labelMatches !== undefined) {
        assertLabelMatches(document, execution.matches, labelMatches);
      } else if (lastOperator === 'hcl.expression-text' && nestedMatches !== undefined) {
        assertNestedMatches(document, execution.matches, nestedMatches);
      }
    } else if (terminal === 'Failed') {
      let failure: unknown = null;
      try {
        executeHclNativeQuery(
          bindQueryExecutable(calls, hclNativeQueryDomain()),
          document,
          DEFAULT_HCL_QUERY_LIMITS,
          new HclCancellationToken(),
        );
      } catch (error) {
        failure = error;
      }
      if (failure === null) {
        fail('execution must fail');
      }
      if (codes === undefined) {
        fail('missing expected.codes');
      }
      const expectedCode = codes[index];
      if (typeof expectedCode !== 'string') {
        fail('expected code must be a string');
      }
      const actual = queryFailureCode(failure);
      if (actual !== expectedCode) {
        fail(`query failure ${actual} != ${expectedCode}`);
      }
    } else {
      fail(`unknown terminal ${terminal}`);
    }
  }
}

/** The `argument` of the last filter of one sample (hcl_v1.rs:904-916). */
function sampleAccessor(sample: Record<string, unknown>): string {
  const filters = sample.filters as Record<string, unknown>[] | undefined;
  if (filters === undefined || filters.length === 0) {
    return '';
  }
  const argument = filters[filters.length - 1].argument;
  return typeof argument === 'string' ? argument : '';
}

/** Compares one expression match against its `{kind, text, literal}` expectation. */
function assertExpressionMatch(document: HclDocument, match: HclMatch, expected: Record<string, unknown>): void {
  const facts = expressionFacts(document, match);
  const expectedKind = expected.kind as string | undefined;
  if (expectedKind !== undefined && facts.kind !== expectedKind) {
    fail(`kind ${facts.kind} != ${expectedKind}`);
  }
  const expectedText = expected.text as string | undefined;
  if (expectedText !== undefined && facts.text !== expectedText) {
    fail(`text ${facts.text} != ${expectedText}`);
  }
  const expectedLiteral = expected.literal as boolean | undefined;
  if (expectedLiteral !== undefined && facts.literal !== expectedLiteral) {
    fail(`literal ${facts.literal} != ${expectedLiteral}`);
  }
}

/** Asserts typed integer literal matches against `{kind, value}` facts. */
function assertIntegerMatches(document: HclDocument, matches: readonly HclMatch[], expectedMatches: readonly Record<string, unknown>[]): void {
  if (matches.length !== expectedMatches.length) {
    fail(`integer match count ${matches.length} != ${expectedMatches.length}`);
  }
  for (let index = 0; index < expectedMatches.length; index++) {
    const expected = expectedMatches[index];
    if (expected.kind !== 'integer') {
      fail('missing expected match kind');
    }
    if (matches[index].kind !== 'Expression') {
      fail('match is not an integer literal');
    }
    const literal = literalValue(document.expression(matches[index].node).node());
    if (literal === null || literal.kind !== 'Integer') {
      fail('match is not an integer literal');
    }
    if (BigInt(literal.canonical) !== BigInt(expected.value as number)) {
      fail('integer literal value mismatch');
    }
  }
}

/** Asserts typed boolean literal matches against `{kind, value}` facts. */
function assertBooleanMatches(document: HclDocument, matches: readonly HclMatch[], expectedMatches: readonly Record<string, unknown>[]): void {
  if (matches.length !== expectedMatches.length) {
    fail(`boolean match count ${matches.length} != ${expectedMatches.length}`);
  }
  for (let index = 0; index < expectedMatches.length; index++) {
    const expected = expectedMatches[index];
    if (expected.kind !== 'boolean') {
      fail('missing expected match kind');
    }
    if (matches[index].kind !== 'Expression') {
      fail('match is not a boolean literal');
    }
    const literal = literalValue(document.expression(matches[index].node).node());
    if (literal === null || literal.kind !== 'Boolean') {
      fail('match is not a boolean literal');
    }
    if (literal.value !== expected.value) {
      fail('boolean literal value mismatch');
    }
  }
}

/** Asserts block-label matches against `{text, quoted}` facts. */
function assertLabelMatches(document: HclDocument, matches: readonly HclMatch[], expectedMatches: readonly Record<string, unknown>[]): void {
  if (matches.length !== expectedMatches.length) {
    fail(`label match count ${matches.length} != ${expectedMatches.length}`);
  }
  for (let index = 0; index < expectedMatches.length; index++) {
    const match = matches[index];
    if (match.kind !== 'BlockLabel') {
      fail('match is not a block label');
    }
    const label = document.blockLabel(match.node);
    const expected = expectedMatches[index];
    const expectedText = expected.text as string | undefined;
    if (expectedText !== undefined && label.text() !== expectedText) {
      fail(`label text ${label.text()} != ${expectedText}`);
    }
    const expectedQuoted = expected.quoted as boolean | undefined;
    if (expectedQuoted !== undefined && label.quoted() !== expectedQuoted) {
      fail(`label quoted ${label.quoted()} != ${expectedQuoted}`);
    }
  }
}

/** Asserts expression matches against `{kind, text}` facts. */
function assertNestedMatches(document: HclDocument, matches: readonly HclMatch[], expectedMatches: readonly Record<string, unknown>[]): void {
  if (matches.length !== expectedMatches.length) {
    fail(`nested match count ${matches.length} != ${expectedMatches.length}`);
  }
  for (let index = 0; index < expectedMatches.length; index++) {
    const facts = expressionFacts(document, matches[index]);
    const expected = expectedMatches[index];
    const expectedKind = expected.kind as string | undefined;
    if (expectedKind !== undefined && facts.kind !== expectedKind) {
      fail(`kind ${facts.kind} != ${expectedKind}`);
    }
    const expectedText = expected.text as string | undefined;
    if (expectedText !== undefined && facts.text !== expectedText) {
      fail(`text ${facts.text} != ${expectedText}`);
    }
  }
}

function syntaxQueryCase(case_: VectorCase): void {
  const document = parseCase(case_);
  if (document.formationStatus() !== 'Complete') {
    fail('syntax-query input must form completely');
  }
  const samples = caseField(case_, 'samples') as Record<string, unknown>[];
  const terminals = expectedField(case_, 'terminals') as string[];
  if (samples.length !== terminals.length) {
    fail('terminal count mismatch');
  }
  const matchesSets = expectedField(case_, 'matches') as unknown[][];
  if (samples.length !== matchesSets.length) {
    fail('match count mismatch');
  }
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const filters = sample.filters as Record<string, unknown>[] | undefined;
    if (!Array.isArray(filters)) {
      fail('missing sample filters');
    }
    const calls = buildFilters(filters);
    const execution = executeHclSyntaxQuery(
      bindQueryExecutable(calls, hclLosslessSyntaxQueryDomain()),
      document,
      DEFAULT_HCL_QUERY_LIMITS,
      new HclCancellationToken(),
    );
    if (terminals[index] !== 'Completed') {
      fail('unexpected terminal');
    }
    const matches = execution.matches;
    const expectedMatches = matchesSets[index] as Record<string, unknown>[];
    if (matches.length !== expectedMatches.length) {
      fail(`syntax match count ${matches.length} != ${expectedMatches.length}`);
    }
    for (let matchIndex = 0; matchIndex < expectedMatches.length; matchIndex++) {
      const expectedMatch = expectedMatches[matchIndex];
      const expectedKind = expectedMatch.kind as string | undefined;
      if (expectedKind === undefined) {
        fail('missing expected match kind');
      }
      const actual: HclSyntaxMatch = matches[matchIndex];
      if (actual.kind() !== expectedKind) {
        fail(`kind ${actual.kind()} != ${expectedKind}`);
      }
      const expectedText = expectedMatch.text as string | undefined;
      if (expectedText !== undefined) {
        const span = actual.span();
        const decoded = document.source().decodedText() ?? '';
        const observed = decoded.slice(
          document.source().decodedPosition(span.startByte()).utf16CodeUnitOffset,
          document.source().decodedPosition(span.endByte()).utf16CodeUnitOffset,
        );
        if (observed !== expectedText) {
          fail(`text ${observed} != ${expectedText}`);
        }
      }
      const expectedOrdinal = expectedMatch.ordinal as number | undefined;
      if (expectedOrdinal !== undefined && actual.ordinal() !== expectedOrdinal) {
        fail(`ordinal ${actual.ordinal()} != ${expectedOrdinal}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Projection (hcl.projection@1)
// ---------------------------------------------------------------------------

function projectionRequest(case_: VectorCase): HclProjectionRequest {
  const target = (caseFieldOptional(case_, 'target') as string | undefined) ?? 'hcl.projection.body@1';
  if (target !== 'hcl.projection.body@1') {
    fail(`unknown projection target ${target}`);
  }
  const policy = caseFieldOptional(case_, 'policy') as string | undefined;
  if (policy === undefined) {
    return new HclProjectionRequest();
  }
  if (policy !== 'ProjectExpression') {
    fail(`unknown projection policy ${policy}`);
  }
  return HclProjectionRequest.bodyWithExpressionPolicy('ProjectExpression');
}

/** hcl.projection@1 */
function projectionCase(case_: VectorCase): void {
  const samples = caseFieldOptional(case_, 'samples') as Record<string, unknown>[] | undefined;
  if (samples !== undefined) {
    projectionSamples(case_, samples);
    return;
  }
  const document = parseCase(case_);
  const request = projectionRequest(case_);
  const result = projectHcl(document, request);
  const expectedFailure = expectedFieldOptional(case_, 'failure') as string | undefined;
  if (expectedFailure !== undefined) {
    if (result.kind !== 'Failed') {
      fail('projection must fail');
    }
    const diagnostics = result.value.diagnostics();
    const code = diagnostics.length > 0 ? diagnostics[0].code : '';
    if (code !== expectedFailure) {
      fail(`failure code ${code} != ${expectedFailure}`);
    }
    return;
  }
  if (result.kind !== 'Complete') {
    fail('projection must complete');
  }
  const value = result.value.value();
  const record = expectedFieldOptional(case_, 'record') as string | undefined;
  if (record !== undefined) {
    const actualRecord = recordString(value, 'record');
    if (actualRecord !== record) {
      fail(`record ${actualRecord} != ${record}`);
    }
  }
  const expectedAttributes = expectedFieldOptional(case_, 'attributes') as Record<string, unknown>[] | undefined;
  if (expectedAttributes !== undefined) {
    assertProjectedAttributes(value, expectedAttributes);
  }
  const expectedBlocks = expectedFieldOptional(case_, 'blocks') as Record<string, unknown>[] | undefined;
  if (expectedBlocks !== undefined) {
    assertProjectedBlocks(value, expectedBlocks);
  }
  const transformed = expectedFieldOptional(case_, 'transformed_events') as number | undefined;
  if (transformed !== undefined) {
    let events = 0;
    for (const event of result.value.report().events()) {
      if (event.kind() === 'ExpressionSubstituted') {
        events += 1;
      }
    }
    if (events !== transformed) {
      fail(`transformed events ${events} != ${transformed}`);
    }
  }
  const provenance = expectedFieldOptional(case_, 'event_provenance') as boolean | undefined;
  if (provenance !== undefined) {
    const nonEmpty = result.value.provenance().entries().length > 0;
    if (provenance !== nonEmpty) {
      fail('event provenance mismatch');
    }
  }
  // Order, duplicate-key, and canonical-decimal preservation are verified
  // by the attribute assertions above; a declared flag must be true.
  for (const name of ['attribute_order_preserved', 'duplicate_keys_preserved', 'canonical_decimal']) {
    const declared = expectedFieldOptional(case_, name) as boolean | undefined;
    if (declared !== undefined && !declared) {
      fail(`declared projection flag ${name} is false`);
    }
  }
}

function projectionSamples(case_: VectorCase, samples: readonly Record<string, unknown>[]): void {
  const codes = expectedFieldOptional(case_, 'codes') as (string | null)[] | undefined;
  const literals = expectedFieldOptional(case_, 'literals') as boolean[] | undefined;
  for (let index = 0; index < samples.length; index++) {
    const document = parseCase(mergedCase(case_, samples[index]));
    const request = projectionRequest(case_);
    const result = projectHcl(document, request);
    if (codes !== undefined) {
      const codeValue = codes[index];
      if (typeof codeValue === 'string') {
        if (result.kind !== 'Failed') {
          fail('projection must fail');
        }
        const diagnostics = result.value.diagnostics();
        const code = diagnostics.length > 0 ? diagnostics[0].code : '';
        if (code !== codeValue) {
          fail(`projection code ${code} != ${codeValue}`);
        }
      }
    }
    if (literals !== undefined) {
      const expectedLiteral = literals[index];
      if (typeof expectedLiteral !== 'boolean') {
        fail('expected literal must be a boolean');
      }
      const completed = result.kind === 'Complete';
      if (completed !== expectedLiteral) {
        fail(`sample ${index} projection completion ${completed} != ${expectedLiteral}`);
      }
    }
  }
}

/** One string record member of a projected record. */
function recordString(record: PortableValue, name: string): string {
  if (record.kind !== 'Object') {
    fail(`record member ${name} is not an object`);
  }
  const entry = record.entries.find((entry) => entry.key === name);
  if (entry === undefined) {
    fail(`missing record member ${name}`);
  }
  if (entry.value.kind !== 'String') {
    fail(`record member ${name} is not a string`);
  }
  return entry.value.value;
}

/** One record member of a projected record. */
function recordMember(record: PortableValue, name: string): PortableValue {
  if (record.kind !== 'Object') {
    fail(`record member ${name} is not an object`);
  }
  const entry = record.entries.find((entry) => entry.key === name);
  if (entry === undefined) {
    fail(`missing record member ${name}`);
  }
  return entry.value;
}

/** The projected `hcl.body@1` record's ordered item sequence (RFC 0014 §8.2). */
function projectedItems(projected: PortableValue): readonly PortableValue[] {
  const items = recordMember(projected, 'items');
  if (items.kind !== 'Sequence') {
    fail('missing projected items');
  }
  return items.items;
}

/** Asserts the attribute items of the projected `hcl.body@1` record. */
function assertProjectedAttributes(projected: PortableValue, expectedAttributes: readonly Record<string, unknown>[]): void {
  const items = projectedItems(projected);
  const attributes = items.filter((item) => item.kind === 'Object' && recordString(item, 'kind') === 'attribute');
  if (attributes.length !== expectedAttributes.length) {
    fail(`attribute count ${attributes.length} != ${expectedAttributes.length}`);
  }
  for (let index = 0; index < expectedAttributes.length; index++) {
    const expected = expectedAttributes[index];
    const expectedName = expected.name as string | undefined;
    if (expectedName === undefined) {
      fail('missing expected attribute name');
    }
    const actualName = recordString(attributes[index], 'name');
    if (actualName !== expectedName) {
      fail(`attribute name ${actualName} != ${expectedName}`);
    }
    assertProjectedValue(recordMember(attributes[index], 'value'), expected);
  }
}

/** Asserts the block items of the projected `hcl.body@1` record. */
function assertProjectedBlocks(projected: PortableValue, expectedBlocks: readonly Record<string, unknown>[]): void {
  const items = projectedItems(projected);
  const blocks = items.filter((item) => item.kind === 'Object' && recordString(item, 'kind') === 'block');
  if (blocks.length !== expectedBlocks.length) {
    fail(`block count ${blocks.length} != ${expectedBlocks.length}`);
  }
  for (let index = 0; index < expectedBlocks.length; index++) {
    const expected = expectedBlocks[index];
    const expectedType = expected.type as string | undefined;
    if (expectedType !== undefined) {
      const actualType = recordString(blocks[index], 'type');
      if (actualType !== expectedType) {
        fail(`block type ${actualType} != ${expectedType}`);
      }
    }
    const expectedLabels = expected.labels as unknown[] | undefined;
    if (expectedLabels !== undefined) {
      const labelsValue = recordMember(blocks[index], 'labels');
      if (labelsValue.kind !== 'Sequence') {
        fail('missing projected block labels');
      }
      if (labelsValue.items.length !== expectedLabels.length) {
        fail(`label count ${labelsValue.items.length} != ${expectedLabels.length}`);
      }
      for (let labelIndex = 0; labelIndex < expectedLabels.length; labelIndex++) {
        const expectedLabel = expectedLabels[labelIndex];
        if (typeof expectedLabel !== 'string') {
          fail('expected label must be a string');
        }
        const actual = labelsValue.items[labelIndex];
        if (actual.kind !== 'String' || actual.value !== expectedLabel) {
          fail(`label ${actual.kind === 'String' ? actual.value : String(actual.kind)} != ${expectedLabel}`);
        }
      }
    }
  }
}

/** Asserts one projected value against its `{kind, ...}` expectation. */
function assertProjectedValue(actual: PortableValue, expected: Record<string, unknown>): void {
  const kind = expected.kind as string | undefined;
  if (kind === undefined) {
    fail('missing expected value kind');
  }
  switch (kind) {
    case 'string': {
      const text = expected.text as string | undefined;
      if (text === undefined) {
        fail('missing expected text');
      }
      if (actual.kind !== 'String' || actual.value !== text) {
        fail('projected string mismatch');
      }
      break;
    }
    case 'integer': {
      const value = expected.value;
      if (typeof value !== 'number') {
        fail('missing expected integer');
      }
      if (actual.kind !== 'Integer' || actual.value !== BigInt(value)) {
        fail('projected integer mismatch');
      }
      break;
    }
    case 'real': {
      const value = expected.value;
      if (typeof value !== 'number') {
        fail('missing expected real');
      }
      const actualF64 = valueToF64(actual);
      if (actualF64 === null || !bitsEqual(actualF64, value)) {
        fail('projected real mismatch');
      }
      break;
    }
    case 'boolean': {
      const value = expected.value;
      if (typeof value !== 'boolean') {
        fail('missing expected boolean');
      }
      if (actual.kind !== 'Boolean' || actual.value !== value) {
        fail('projected boolean mismatch');
      }
      break;
    }
    case 'null': {
      if (actual.kind !== 'Null') {
        fail('projected value is not null');
      }
      break;
    }
    case 'tuple': {
      const elements = expected.elements as unknown[] | undefined;
      if (elements === undefined) {
        fail('missing expected elements');
      }
      if (actual.kind !== 'Sequence') {
        fail('projected value is not a tuple');
      }
      if (actual.items.length !== elements.length) {
        fail(`tuple count ${actual.items.length} != ${elements.length}`);
      }
      for (let index = 0; index < elements.length; index++) {
        assertProjectedElement(actual.items[index], elements[index]);
      }
      break;
    }
    case 'object': {
      const entries = expected.entries as unknown[][] | undefined;
      if (entries === undefined) {
        fail('missing expected entries');
      }
      if (actual.kind !== 'EntryMapping') {
        fail('projected value is not an object');
      }
      if (actual.entries.length !== entries.length) {
        fail(`object count ${actual.entries.length} != ${entries.length}`);
      }
      for (let index = 0; index < entries.length; index++) {
        const pair = entries[index];
        if (!Array.isArray(pair) || pair.length !== 2) {
          fail('expected object entry must be a pair');
        }
        const expectedKey = pair[0];
        if (typeof expectedKey !== 'string') {
          fail('expected object key must be a string');
        }
        const actualEntry = actual.entries[index];
        const actualKey = actualEntry.key.kind === 'String' ? actualEntry.key.value : String(actualEntry.key);
        if (actualKey !== expectedKey) {
          fail(`object key ${actualKey} != ${expectedKey}`);
        }
        assertProjectedElement(actualEntry.value, pair[1]);
      }
      break;
    }
    case 'expression': {
      // The projected value member is the `hcl.expression@1` record
      // {record, kind, text, fingerprint} (RFC 0014 §8.2).
      const expression = expected.expression as Record<string, unknown> | undefined;
      if (expression === undefined) {
        fail('missing expected expression record');
      }
      const actualRecord = recordString(actual, 'record');
      const expectedRecord = expression.record as string | undefined;
      if (expectedRecord !== undefined && actualRecord !== expectedRecord) {
        fail(`expression record ${actualRecord} != ${expectedRecord}`);
      }
      const actualKind = recordString(actual, 'kind');
      const expectedKind = expression.kind as string | undefined;
      if (expectedKind !== undefined && actualKind !== expectedKind) {
        fail(`expression kind ${actualKind} != ${expectedKind}`);
      }
      const actualText = recordString(actual, 'text');
      const expectedText = expression.text as string | undefined;
      if (expectedText !== undefined && actualText !== expectedText) {
        fail(`expression text ${actualText} != ${expectedText}`);
      }
      break;
    }
    default:
      fail(`unknown projected value kind ${kind}`);
  }
}

/** Asserts one tuple element or object value: a scalar, or a nested `{kind, ...}` descriptor. */
function assertProjectedElement(actual: PortableValue, expected: unknown): void {
  if (typeof expected === 'string') {
    if (actual.kind !== 'String' || actual.value !== expected) {
      fail('projected element string mismatch');
    }
    return;
  }
  if (typeof expected === 'number') {
    if (Number.isInteger(expected)) {
      if (actual.kind !== 'Integer' || actual.value !== BigInt(expected)) {
        fail('projected element integer mismatch');
      }
      return;
    }
    const actualF64 = valueToF64(actual);
    if (actualF64 === null || !bitsEqual(actualF64, expected)) {
      fail('projected element real mismatch');
    }
    return;
  }
  if (typeof expected === 'boolean') {
    if (actual.kind !== 'Boolean' || actual.value !== expected) {
      fail('projected element boolean mismatch');
    }
    return;
  }
  if (typeof expected === 'object' && expected !== null) {
    assertProjectedValue(actual, expected as Record<string, unknown>);
    return;
  }
  fail('unsupported expected element');
}

/** Exact double of one PortableValue, or null (valueToF64, hcl_v1.rs:167-177). */
function valueToF64(value: PortableValue): number | null {
  switch (value.kind) {
    case 'BinaryFloat64': {
      const view = new DataView(new ArrayBuffer(8));
      view.setBigUint64(0, value.bits);
      return view.getFloat64(0);
    }
    case 'BinaryFloat32': {
      const view = new DataView(new ArrayBuffer(4));
      view.setUint32(0, value.bits);
      return view.getFloat32(0);
    }
    case 'Decimal':
      return Number(`${value.coefficient}e${value.exponent}`);
    case 'Integer':
      return Number(value.value);
    default:
      return null;
  }
}

/** Exact bit equality of two doubles (hcl_v1.rs:196-198). */
function bitsEqual(left: number, right: number): boolean {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, left);
  const leftBits = view.getBigUint64(0);
  view.setFloat64(0, right);
  return leftBits === view.getBigUint64(0);
}

// ---------------------------------------------------------------------------
// Materialization (hcl.materialization@1)
// ---------------------------------------------------------------------------

function materializationRequest(style: string, profileName: string): MaterializationRequest {
  const profile = profileOf(profileName);
  if (style !== 'hcl.canonical-document@1') {
    fail(`unknown materialization style ${style}`);
  }
  return new MaterializationRequest(profile.id(), hclCanonicalDocumentStyle());
}

/** Stable vector spelling of one MaterializationFailure (hcl_v1.rs:1614-1625). */
function materializationFailureCode(failure: MaterializationFailure): string {
  switch (failure.kind) {
    case 'InvalidRequest':
      return 'invalid-record';
    case 'UnsupportedProfile':
      return 'unsupported-profile';
    case 'UnsupportedStyle':
      return 'unsupported-style';
    case 'UnsupportedEncoding':
      return 'unsupported-encoding';
    case 'UnsupportedNewline':
      return 'unsupported-newline';
    case 'Unrepresentable':
      return 'hcl.materialization.unrepresentable@1';
    case 'ResourceLimit':
      return 'hcl.materialization.resource-limit@1';
    case 'FormationFailed':
      return 'formation-failed';
  }
}

function completeMaterialization(
  record: Record<string, unknown>,
  request: MaterializationRequest,
): CompleteMaterialization<HclDocument> {
  const result = materializeHcl(record as unknown as HclBodyRecordInput, request);
  if (result.kind !== 'Complete') {
    fail(`materialization failed: ${materializationFailureCode(result.value.failure())}`);
  }
  return result.value;
}

/** hcl.materialization@1 */
function materializationCase(case_: VectorCase): void {
  const samples = caseFieldOptional(case_, 'samples') as Record<string, unknown>[] | undefined;
  if (samples !== undefined) {
    materializationSamples(case_, samples);
    return;
  }
  const style = caseField(case_, 'style') as string;
  const profileName = caseField(case_, 'profile') as string;
  const record = caseField(case_, 'record') as Record<string, unknown>;
  const request = materializationRequest(style, profileName);
  const expectedFailure = expectedFieldOptional(case_, 'failure') as string | undefined;
  if (expectedFailure !== undefined) {
    const result = materializeHcl(record as unknown as HclBodyRecordInput, request);
    if (result.kind !== 'Failed') {
      fail('materialization must fail');
    }
    const actual = materializationFailureCode(result.value.failure());
    if (actual !== expectedFailure) {
      fail(`failure ${actual} != ${expectedFailure}`);
    }
    return;
  }
  const complete = completeMaterialization(record, request);
  const render = expectedFieldOptional(case_, 'render') as string | undefined;
  if (render !== undefined && text(complete.document().render()) !== render) {
    fail(`render ${text(complete.document().render())} != ${render}`);
  }
  const closure = expectedFieldOptional(case_, 'closure') as boolean | undefined;
  if (closure === true && complete.document().formationStatus() !== 'Complete') {
    fail('materialized document must be complete');
  }
  const fingerprint = expectedFieldOptional(case_, 'fingerprint_match') as boolean | undefined;
  if (fingerprint === true) {
    assertFingerprintMatch(complete, record);
  }
}

function materializationSamples(case_: VectorCase, samples: readonly Record<string, unknown>[]): void {
  const renders = expectedFieldOptional(case_, 'renders') as (string | null)[] | undefined;
  const codes = expectedFieldOptional(case_, 'codes') as (string | null)[] | undefined;
  const closure = expectedFieldOptional(case_, 'closure') as boolean | undefined;
  if (renders === undefined && codes === undefined) {
    fail('missing expected.codes');
  }
  const expectedLength = codes !== undefined ? codes.length : (renders as (string | null)[]).length;
  if (samples.length !== expectedLength) {
    fail('render/code count mismatch');
  }
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const style = (sample.style as string | undefined) ?? (caseFieldOptional(case_, 'style') as string | undefined);
    if (style === undefined) {
      fail('missing sample style');
    }
    const profileName = (sample.profile as string | undefined) ?? (caseFieldOptional(case_, 'profile') as string | undefined);
    if (profileName === undefined) {
      fail('missing sample profile');
    }
    const request = materializationRequest(style, profileName);
    const record = sample.record as Record<string, unknown> | undefined;
    if (record === undefined) {
      fail('missing sample record');
    }
    const result = materializeHcl(record as unknown as HclBodyRecordInput, request);
    if (result.kind === 'Complete') {
      if (renders !== undefined) {
        const expectedRender = renders[index];
        if (typeof expectedRender !== 'string') {
          fail('expected render must be a string');
        }
        const actual = text(result.value.document().render());
        if (actual !== expectedRender) {
          fail(`render ${actual} != ${expectedRender}`);
        }
      } else if (codes !== undefined) {
        if (typeof codes[index] === 'string') {
          fail('materialization must fail');
        }
      }
      if (closure === true && result.value.document().formationStatus() !== 'Complete') {
        fail('materialized document must be complete');
      }
    } else {
      if (codes === undefined) {
        fail('materialization must complete');
      }
      const expectedCode = codes[index];
      if (typeof expectedCode !== 'string') {
        fail('expected code must be a string');
      }
      const actual = materializationFailureCode(result.value.failure());
      if (actual !== expectedCode) {
        fail(`materialization failure ${actual} != ${expectedCode}`);
      }
    }
  }
}

/** Asserts that every `hcl.expression@1` record of the input record is reproduced by the re-projection. */
function assertFingerprintMatch(complete: CompleteMaterialization<HclDocument>, record: Record<string, unknown>): void {
  const request = HclProjectionRequest.bodyWithExpressionPolicy('ProjectExpression');
  const result = projectHcl(complete.document(), request);
  if (result.kind !== 'Complete') {
    fail('materialized document must re-project');
  }
  const items = record.items as unknown[] | undefined;
  if (items === undefined) {
    fail('missing record items');
  }
  const projectedAttributes = projectedItems(result.value.value()).filter(
    (item) => item.kind === 'Object' && recordString(item, 'kind') === 'attribute',
  );
  for (const item of items) {
    const itemRecord = item as Record<string, unknown>;
    if (itemRecord.kind !== 'attribute') {
      continue;
    }
    const value = itemRecord.value as Record<string, unknown> | undefined;
    if (value === undefined || value.kind !== 'expression') {
      continue;
    }
    const name = itemRecord.name as string | undefined;
    if (name === undefined) {
      fail('missing attribute name');
    }
    const expectedExpression = value.expression as Record<string, unknown> | undefined;
    if (expectedExpression === undefined) {
      fail('missing expression record');
    }
    const projected = projectedAttributes.find((candidate) => recordString(candidate, 'name') === name);
    if (projected === undefined) {
      fail(`projected attribute ${name} not found`);
    }
    const projectedValue = recordMember(projected, 'value');
    for (const member of ['kind', 'text', 'record'] as const) {
      const actual = recordString(projectedValue, member);
      const expected = expectedExpression[member] as string | undefined;
      if (actual !== expected) {
        fail(`expression ${member} ${actual} != ${expected}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Edit (hcl.edit@1)
// ---------------------------------------------------------------------------

/** One typed edit value from a vector descriptor (hcl_v1.rs:1858-1934). */
function editValue(value: Record<string, unknown>): HclEditValue {
  const kind = value.kind as string | undefined;
  if (kind === undefined) {
    fail('missing value kind');
  }
  switch (kind) {
    case 'string': {
      const text = value.text as string | undefined;
      if (text === undefined) {
        fail('missing text');
      }
      return { kind: 'String', value: text };
    }
    case 'integer': {
      const payload = value.value;
      if (typeof payload !== 'number') {
        fail('missing integer value');
      }
      return { kind: 'Integer', value: BigInt(payload) };
    }
    case 'real': {
      const payload = value.value;
      if (typeof payload !== 'number') {
        fail('missing real value');
      }
      return { kind: 'Real', value: payload };
    }
    case 'boolean': {
      const payload = value.value;
      if (typeof payload !== 'boolean') {
        fail('missing boolean value');
      }
      return { kind: 'Boolean', value: payload };
    }
    case 'null':
      return { kind: 'Null' };
    case 'tuple': {
      const elements = value.elements as unknown[] | undefined;
      if (!Array.isArray(elements)) {
        fail('missing tuple elements');
      }
      return { kind: 'Tuple', elements: elements.map((element) => editValue(element as Record<string, unknown>)) };
    }
    case 'object': {
      const entries = value.entries as unknown[] | undefined;
      if (!Array.isArray(entries)) {
        fail('missing object entries');
      }
      const typed: (readonly [HclEditKey, HclEditValue])[] = [];
      for (const entry of entries) {
        if (!Array.isArray(entry) || entry.length !== 2) {
          fail('entry must be a pair');
        }
        typed.push([editKey(entry[0]), editValue(entry[1] as Record<string, unknown>)]);
      }
      return { kind: 'Object', entries: typed };
    }
    case 'expression': {
      const expression = value.expression as Record<string, unknown> | undefined;
      if (expression === undefined) {
        fail('missing expression record');
      }
      const kindName = expression.kind as string | undefined;
      const text = expression.text as string | undefined;
      if (kindName === undefined || text === undefined) {
        fail('missing expression kind/text');
      }
      return { kind: 'Expression', kindName, text };
    }
    default:
      fail(`unknown value kind ${kind}`);
  }
}

/** One edit key: an identifier, or a number when the text parses as one (hcl_v1.rs:1904-1912). */
function editKey(key: unknown): HclEditKey {
  if (typeof key === 'string') {
    if (/^-?\d+$/.test(key)) {
      return { kind: 'Number', value: BigInt(key) };
    }
    return { kind: 'Identifier', name: key };
  }
  if (typeof key === 'number') {
    return { kind: 'Number', value: BigInt(key) };
  }
  fail(`unsupported edit key ${String(key)}`);
}

/** One root body path from a vector operation; only the root exists today. */
function bodyPath(operation: Record<string, unknown>): HclBodyPath {
  const body = operation.body as string | undefined;
  if (body === undefined || body === 'root') {
    return HclBodyPath.root();
  }
  fail(`unknown body path ${body}`);
}

/** One insertion placement from a vector operation (default Last). */
function placement(operation: Record<string, unknown>): HclBodyPlacement {
  switch ((operation.placement as string | undefined) ?? 'Last') {
    case 'First':
      return { kind: 'First' };
    case 'Last':
      return { kind: 'Last' };
    default:
      fail(`unknown placement ${operation.placement}`);
  }
}

/** Builds the transaction of one vector operation list (hcl_v1.rs:1961-2057). */
function buildTransaction(document: HclDocument, operations: readonly Record<string, unknown>[]): HclEditTransaction {
  const builder = new HclEditTransactionBuilder(document);
  for (const operation of operations) {
    const op = operation.op as string | undefined;
    if (op === undefined) {
      fail('missing op');
    }
    switch (op) {
      case 'hcl.edit.set-attribute-value@1': {
        const attribute = operation.attribute as string | undefined;
        const value = operation.value as Record<string, unknown> | undefined;
        if (attribute === undefined || value === undefined) {
          fail('missing attribute/value');
        }
        builder.setAttributeValue(bodyPath(operation), attribute, editValue(value));
        break;
      }
      case 'hcl.edit.insert-attribute@1': {
        const name = operation.name as string | undefined;
        const value = operation.value as Record<string, unknown> | undefined;
        if (name === undefined || value === undefined) {
          fail('missing name/value');
        }
        builder.insertAttribute(bodyPath(operation), name, editValue(value), placement(operation));
        break;
      }
      case 'hcl.edit.remove-attribute@1': {
        const attribute = operation.attribute as string | undefined;
        if (attribute === undefined) {
          fail('missing attribute');
        }
        builder.removeAttribute(bodyPath(operation), attribute);
        break;
      }
      case 'hcl.edit.rename-attribute@1': {
        const attribute = operation.attribute as string | undefined;
        const name = operation.name as string | undefined;
        if (attribute === undefined || name === undefined) {
          fail('missing attribute/name');
        }
        builder.renameAttribute(bodyPath(operation), attribute, name);
        break;
      }
      case 'hcl.edit.insert-block@1': {
        const blockType = operation.type as string | undefined;
        const labels = operation.labels as unknown[] | undefined;
        const attributes = operation.attributes as Record<string, unknown>[] | undefined;
        if (blockType === undefined || !Array.isArray(labels) || !Array.isArray(attributes)) {
          fail('missing block facts');
        }
        const typedLabels = labels.map((label) => label as string);
        const typedAttributes: (readonly [string, HclEditValue])[] = attributes.map((attribute) => {
          const name = attribute.name as string | undefined;
          const value = attribute.value as Record<string, unknown> | undefined;
          if (name === undefined || value === undefined) {
            fail('missing block attribute');
          }
          return [name, editValue(value)];
        });
        builder.insertBlock(bodyPath(operation), blockType, typedLabels, typedAttributes, placement(operation));
        break;
      }
      case 'hcl.edit.remove-block@1': {
        const nodeRef = operation.node_ref as Record<string, unknown> | undefined;
        if (nodeRef === undefined) {
          fail('missing node_ref');
        }
        const blockType = nodeRef.type as string | undefined;
        const labels = nodeRef.labels as unknown[] | undefined;
        if (blockType === undefined || !Array.isArray(labels)) {
          fail('missing node_ref type/labels');
        }
        builder.removeBlock(HclBodyPath.root(), blockType, labels.map((label) => label as string), 0);
        break;
      }
      default:
        fail(`unknown edit op ${op}`);
    }
  }
  return builder.build();
}

/** Reparses one committed document under its own profile. */
function reparseDocument(document: HclDocument): HclDocument {
  try {
    return parseHcl(document.render(), document.selector(), profileDefaultEncoding(), DEFAULT_HCL_PARSE_LIMITS);
  } catch (error) {
    fail(`reparse: ${String(error)}`);
  }
}

/** Whether every block label of one native body tree is quoted. */
function allLabelsQuoted(body: HclBody): boolean {
  for (const item of body.items()) {
    if (item instanceof HclBlock) {
      for (const label of item.labels()) {
        if (!label.quoted()) {
          return false;
        }
      }
      if (!allLabelsQuoted(item.body())) {
        return false;
      }
    }
  }
  return true;
}

/** Whether two replacement sets carry the exact same facts. */
function replacementSetsEqual(left: readonly SourceReplacement[], right: readonly SourceReplacement[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (
      left[index].oldStart() !== right[index].oldStart() ||
      left[index].oldEnd() !== right[index].oldEnd() ||
      !bytesEqual(left[index].original(), right[index].original()) ||
      !bytesEqual(left[index].replacement(), right[index].replacement())
    ) {
      return false;
    }
  }
  return true;
}

/** hcl.edit@1 */
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
  let commit: HclEditCommit;
  try {
    commit = commitHclEdits(document, transaction);
  } catch (error) {
    if (error instanceof HclEditFailure) {
      fail(error.code);
      return;
    }
    throw error;
  }
  assertEditFacts(document, transaction, commit, case_);
}

/** Asserts the vector facts of one committed edit against its base document. */
function assertEditFacts(base: HclDocument, transaction: HclEditTransaction, commit: HclEditCommit, case_: VectorCase): void {
  const committed = commit.document();
  if (committed.formationStatus() !== 'Complete') {
    fail('committed document must be complete');
  }
  const render = expectedFieldOptional(case_, 'render') as string | undefined;
  if (render !== undefined) {
    const actual = text(committed.render());
    if (actual !== render) {
      fail(`render ${actual} != ${render}`);
    }
  }
  const reparseClosure = expectedFieldOptional(case_, 'reparse_closure') as boolean | undefined;
  if (reparseClosure === true) {
    if (reparseDocument(committed).formationStatus() !== 'Complete') {
      fail('committed document must reparse completely');
    }
  }
  const untouched = expectedFieldOptional(case_, 'untouched_byte_proof') as boolean | undefined;
  if (untouched === true) {
    try {
      commit.untouchedProof().verify(base.source(), committed.source(), commit.sourcePatch().replacements());
    } catch (error) {
      fail(`untouched proof: ${String(error)}`);
    }
  }
  const patchReplays = expectedFieldOptional(case_, 'patch_replays') as boolean | undefined;
  if (patchReplays === true) {
    let replay: SourceSnapshot;
    try {
      replay = commit.sourcePatch().apply(base.source(), DEFAULT_SOURCE_PATCH_LIMITS);
    } catch (error) {
      fail(`patch apply: ${String(error)}`);
    }
    if (!bytesEqual(replay.bytes(), committed.render())) {
      fail('patch does not replay');
    }
  }
  const labelsQuoted = expectedFieldOptional(case_, 'labels_always_quoted') as boolean | undefined;
  if (labelsQuoted === true) {
    if (!allLabelsQuoted(committed.root())) {
      fail('a block label is not quoted');
    }
  }
  const dryRun = expectedFieldOptional(case_, 'dry_run_equivalent') as boolean | undefined;
  if (dryRun === true) {
    const plan = dryRunHclEdits(base, transaction, new EditPlanSourceId('hcl-conformance'));
    if (!replacementSetsEqual(plan.replacements(), commit.sourcePatch().replacements())) {
      fail('dry-run replacement set differs from the committed replacement set');
    }
  }
}

function editConflicts(case_: VectorCase, samples: readonly Record<string, unknown>[]): void {
  const codes = expectedField(case_, 'codes') as (string | null)[];
  const baseUnchanged = expectedFieldOptional(case_, 'base_unchanged') === true;
  if (samples.length !== codes.length) {
    fail('code count mismatch');
  }
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const document = parseCase(mergedCase(case_, sample));
    const operations = sample.operations as Record<string, unknown>[] | undefined;
    if (!Array.isArray(operations)) {
      fail('missing operations');
    }
    let transaction: HclEditTransaction;
    const wrong = sample.wrong_source as Record<string, unknown> | undefined;
    if (wrong !== undefined) {
      // The transaction is bound to another document's snapshot.
      const other = parseHcl(
        utf8(wrong.source as string),
        (wrong.profile as string | undefined) !== undefined ? profileOf(wrong.profile as string) : document.selector(),
        profileDefaultEncoding(),
        DEFAULT_HCL_PARSE_LIMITS,
      );
      transaction = buildTransaction(other, operations);
    } else {
      transaction = buildTransaction(document, operations);
    }
    let failure: HclEditFailure | null = null;
    try {
      commitHclEdits(document, transaction);
    } catch (error) {
      if (error instanceof HclEditFailure) {
        failure = error;
      } else {
        throw error;
      }
    }
    if (failure === null) {
      fail('edit must fail');
    }
    const expectedCode = codes[index];
    if (typeof expectedCode !== 'string') {
      fail('expected code must be a string');
    }
    if (failure.code !== expectedCode) {
      fail(`edit failure ${failure.code} != ${expectedCode}`);
    }
    if (baseUnchanged && !bytesEqual(document.render(), document.source().bytes())) {
      fail('base document changed');
    }
  }
}

export const runHclV1: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.capability) {
      case 'hcl.native-formation@1':
      case 'hcl.tfvars-formation@1':
        formationCase(case_);
        return;
      case 'hcl.limit@1':
        limitCase(case_);
        return;
      case 'hcl.query@1':
        queryCase(case_);
        return;
      case 'hcl.projection@1':
        projectionCase(case_);
        return;
      case 'hcl.materialization@1':
        materializationCase(case_);
        return;
      case 'hcl.edit@1':
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
