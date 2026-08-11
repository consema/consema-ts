/**
 * `consema.json-family.conformance@2` runner (33 cases; mirror of
 * crates/consema-conformance/src/json_family_v2.rs). Dispatch is by the
 * vector `action` field.
 */

import type { VectorCase } from '../helpers.ts';
import { caseField, caseFieldOptional, expectedFieldOptional, utf8 } from '../helpers.ts';
import { fail, skip, SkippedCase } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import { parse as parseJson } from '../../json/parser.ts';
import type { JsonDocument } from '../../json/document.ts';
import { DEFAULT_PARSE_LIMITS } from '../../document/formation.ts';
import { FatalFormationFailure as JsonFormationFailure } from '../../json/errors.ts';
import { ProjectionRequestBuilder, project } from '../../json/projection.ts';
import { materialize } from '../../json/materialization.ts';
import { MaterializationRequest, MaterializationStyleId } from '../../document/materialization.ts';
import { ProfileId } from '../../document/profile.ts';
import { convertJson } from '../../convert.ts';
import { EditTransactionBuilder, commitEdits } from '../../json/edit.ts';
import { ContractRegistry } from '../../protocol/contract.ts';
import { ErrorCodeRegistry } from '../../protocol/error_registry.ts';
import { executeJsonSyntaxQuery, executeJsonQuery, QueryLimits, CancellationToken } from '../../json/query.ts';
import { domainJSONLosslessSyntaxV2, domainJSONNativeV2 } from '../../protocol/query.ts';
import { QueryExecutionFailure } from '../../json/errors.ts';

function requireQueryFailure(): { QueryExecutionFailure: typeof QueryExecutionFailure } {
  return { QueryExecutionFailure };
}
import { validateQuery, bindQuery } from '../../protocol/query.ts';
import { newCapabilityId, CapabilitySet } from '../../protocol/registry_descriptor.ts';
import { objectValue, stringValue } from '../../core/value.ts';
import { valueFromInput } from '../helpers.ts';

function parseProfile(profile: string): 'JsonStrict' | 'JsoncBounded' | 'Json5Standard' {
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

function parseAction(case_: VectorCase): JsonDocument {
  const source = caseField(case_, 'source') as string;
  const profile = caseFieldOptional(case_, 'profile') as string | undefined;
  return parseJson(utf8(source), profile !== undefined ? parseProfile(profile) : 'Json5Standard', DEFAULT_PARSE_LIMITS);
}

function checkSyntaxKinds(document: JsonDocument, kinds: string[]): void {
  const observed = document.losslessSyntaxKinds();
  for (const kind of kinds) {
    if (!observed.includes(kind as never)) {
      fail(`missing syntax kind ${kind} (observed ${observed.join(', ')})`);
    }
  }
}

function checkDiagnostics(document: JsonDocument, codes: string[]): void {
  const observed = document.diagnostics().map((diagnostic) => diagnostic.code);
  for (const code of codes) {
    if (!observed.includes(code)) {
      fail(`missing diagnostic ${code} (observed ${observed.join(', ')})`);
    }
  }
}

function checkRootFacts(document: JsonDocument, case_: VectorCase): void {
  const rootKind = expectedFieldOptional(case_, 'root_kind') as string | undefined;
  const root = document.root();
  if (rootKind !== undefined) {
    const kind = root.kind();
    if (kind.kind !== 'Available' || kind.value !== rootKind) {
      fail(`root_kind: expected ${rootKind}, observed ${kind.kind === 'Available' ? kind.value : 'Unavailable'}`);
    }
  }
  const rootBits = expectedFieldOptional(case_, 'root_bits') as string | undefined;
  if (rootBits !== undefined) {
    const bits = root.asBinaryFloat64();
    if (bits.kind !== 'Available' || bits.value === null || bits.value.toString(16).padStart(16, '0') !== rootBits) {
      fail(`root_bits: expected ${rootBits}`);
    }
  }
  const rootInteger = expectedFieldOptional(case_, 'root_integer') as string | undefined;
  if (rootInteger !== undefined) {
    const integer = root.asInteger();
    if (integer.kind !== 'Available' || integer.value === null || integer.value.toString() !== rootInteger) {
      fail(`root_integer: expected ${rootInteger}`);
    }
  }
  const memberNames = expectedFieldOptional(case_, 'member_names') as string[] | undefined;
  const memberKinds = expectedFieldOptional(case_, 'member_kinds') as string[] | undefined;
  if (memberNames !== undefined || memberKinds !== undefined) {
    const members = root.objectMembers();
    if (members.kind !== 'Available' || members.value === null) {
      fail('object semantics unavailable');
    }
    if (memberNames !== undefined) {
      const names = members.value.map((member) => {
        const name = member.name();
        return name.kind === 'Available' ? name.value : null;
      });
      if (names.length !== memberNames.length || names.some((name, index) => name !== memberNames[index])) {
        fail(`member_names: expected ${JSON.stringify(memberNames)}, observed ${JSON.stringify(names)}`);
      }
    }
    if (memberKinds !== undefined) {
      const kinds = members.value.map((member) => {
        const kind = member.value().kind();
        return kind.kind === 'Available' ? kind.value : null;
      });
      if (kinds.length !== memberKinds.length || kinds.some((kind, index) => kind !== memberKinds[index])) {
        fail(`member_kinds: expected ${JSON.stringify(memberKinds)}, observed ${JSON.stringify(kinds)}`);
      }
    }
  }
  const elementKinds = expectedFieldOptional(case_, 'element_kinds') as string[] | undefined;
  const elementStrings = expectedFieldOptional(case_, 'element_strings') as string[] | undefined;
  const elementDecimals = expectedFieldOptional(case_, 'element_decimals') as [string, string][] | undefined;
  if (elementKinds !== undefined || elementStrings !== undefined || elementDecimals !== undefined) {
    const elements = root.arrayElements();
    if (elements.kind !== 'Available' || elements.value === null) {
      fail('array semantics unavailable');
    }
    if (elementKinds !== undefined) {
      const kinds = elements.value.map((element) => {
        const kind = element.value().kind();
        return kind.kind === 'Available' ? kind.value : null;
      });
      if (kinds.length !== elementKinds.length || kinds.some((kind, index) => kind !== elementKinds[index])) {
        fail(`element_kinds: expected ${JSON.stringify(elementKinds)}, observed ${JSON.stringify(kinds)}`);
      }
    }
    if (elementStrings !== undefined) {
      const strings = elements.value.map((element) => {
        const value = element.value().asString();
        return value.kind === 'Available' ? value.value : null;
      });
      if (strings.length !== elementStrings.length || strings.some((value, index) => value !== elementStrings[index])) {
        fail(`element_strings: expected ${JSON.stringify(elementStrings)}, observed ${JSON.stringify(strings)}`);
      }
    }
    if (elementDecimals !== undefined) {
      const decimals = elements.value.map((element) => {
        const value = element.value().asDecimal();
        return value.kind === 'Available' && value.value !== null
          ? [value.value.coefficient.toString(), value.value.exponent.toString()]
          : null;
      });
      if (
        decimals.length !== elementDecimals.length ||
        decimals.some((value, index) => value === null || value[0] !== elementDecimals[index][0] || value[1] !== elementDecimals[index][1])
      ) {
        fail(`element_decimals: expected ${JSON.stringify(elementDecimals)}, observed ${JSON.stringify(decimals)}`);
      }
    }
  }
}

function parseCase(case_: VectorCase): void {
  let document: JsonDocument;
  try {
    document = parseAction(case_);
  } catch (error) {
    if (error instanceof JsonFormationFailure) {
      const formation = expectedFieldOptional(case_, 'formation') as string | undefined;
      if (formation === 'FatalFormationFailure') {
        return;
      }
      const diagnosticContains = expectedFieldOptional(case_, 'diagnostic_contains') as string[] | undefined;
      if (diagnosticContains !== undefined) {
        const codes = error.diagnostics().map((diagnostic) => diagnostic.code);
        for (const code of diagnosticContains) {
          if (!codes.includes(code)) {
            fail(`missing diagnostic ${code} (observed ${codes.join(', ')})`);
          }
        }
        return;
      }
    }
    throw error;
  }
  const formation = expectedFieldOptional(case_, 'formation') as string | undefined;
  if (formation !== undefined && document.formationStatus() !== formation) {
    fail(`formation: expected ${formation}, observed ${document.formationStatus()}`);
  }
  checkRootFacts(document, case_);
  const syntaxContains = expectedFieldOptional(case_, 'syntax_contains') as string[] | undefined;
  if (syntaxContains !== undefined) {
    checkSyntaxKinds(document, syntaxContains);
  }
  const diagnosticContains = expectedFieldOptional(case_, 'diagnostic_contains') as string[] | undefined;
  if (diagnosticContains !== undefined) {
    checkDiagnostics(document, diagnosticContains);
  }
}

function queryCapabilities(): CapabilitySet {
  const set = new CapabilitySet();
  set.insert(newCapabilityId('core.query.ordered-results', 1));
  return set;
}

function syntaxQueryCase(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const document = parseJson(utf8(source), 'Json5Standard', DEFAULT_PARSE_LIMITS);
  const kind = caseField(case_, 'kind') as string;
  const definition = {
    domain: domainJSONLosslessSyntaxV2(),
    expression: {
      kind: 'Apply' as const,
      input: { kind: 'Input' as const },
      operator: { id: 'json.syntax-kind-is', version: 1, arguments: new Map([['kind', stringValue(kind)]]) },
    },
    selection: 'All' as const,
  };
  const validated = validateQuery(definition);
  if ('failure' in validated) {
    fail(`validation failed: ${validated.failure.message}`);
  }
  const bound = bindQuery(validated.query, queryCapabilities());
  if ('failure' in bound) {
    fail(`binding failed: ${bound.failure.message}`);
  }
  const result = executeJsonSyntaxQuery(bound.query, document, QueryLimits.defaults(), new CancellationToken());
  const texts = expectedFieldOptional(case_, 'texts') as string[] | undefined;
  if (texts !== undefined) {
    const observed = result.matches().map((match) =>
      new TextDecoder().decode(document.source().bytes().slice(match.span().startByte(), match.span().endByte())),
    );
    if (observed.length !== texts.length || observed.some((text, index) => text !== texts[index])) {
      fail(`texts: expected ${JSON.stringify(texts)}, observed ${JSON.stringify(observed)}`);
    }
  }
  const v1Rejected = expectedFieldOptional(case_, 'v1_rejected');
  if (v1Rejected === true) {
    const v1Definition = { ...definition, domain: domainJSONLosslessSyntaxV1Compat() };
    const v1Validated = validateQuery(v1Definition);
    if (!('failure' in v1Validated)) {
      fail('v1 must reject the v2-only operator');
    }
  }
}

function domainJSONLosslessSyntaxV1Compat(): { id: string; version: number } {
  return { id: 'json.lossless-syntax-query', version: 1 };
}

function nativeQueryCase(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const document = parseJson(utf8(source), 'Json5Standard', DEFAULT_PARSE_LIMITS);
  const definition = {
    domain: domainJSONNativeV2(),
    expression: { kind: 'Input' as const },
    selection: 'All' as const,
  };
  const validated = validateQuery(definition);
  if ('failure' in validated) {
    fail(`validation failed: ${validated.failure.message}`);
  }
  const bound = bindQuery(validated.query, queryCapabilities());
  if ('failure' in bound) {
    fail(`binding failed: ${bound.failure.message}`);
  }
  const result = executeJsonQuery(bound.query, document, QueryLimits.defaults(), new CancellationToken());
  const kind = expectedFieldOptional(case_, 'kind') as string | undefined;
  if (kind !== undefined && result.matches().length > 0) {
    const match = result.matches()[0];
    if (match.kind === 'Value' && match.valueKind !== kind) {
      fail(`kind: expected ${kind}, observed ${match.valueKind}`);
    }
  }
  const v1Rejected = expectedFieldOptional(case_, 'v1_rejected');
  if (v1Rejected === true) {
    // The v1 domain exists but the v2-only binary64 facts are rejected at
    // execution (DomainMismatch for the json5 profile under v1).
    const v1Definition = { ...definition, domain: { id: 'json.native-semantic-query', version: 1 } };
    const v1Validated = validateQuery(v1Definition);
    if ('failure' in v1Validated) {
      return;
    }
    const v1Bound = bindQuery(v1Validated.query, queryCapabilities());
    if ('failure' in v1Bound) {
      return;
    }
    try {
      executeJsonQuery(v1Bound.query, document, QueryLimits.defaults(), new CancellationToken());
    } catch (error) {
      const { QueryExecutionFailure } = requireQueryFailure();
      if (error instanceof QueryExecutionFailure && error.kind === 'DomainMismatch') {
        return;
      }
      throw error;
    }
    fail('v1 must reject the v2-only domain');
  }
}

function projectCase(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const target = caseField(case_, 'target') as string;
  const document = parseJson(utf8(source), 'Json5Standard', DEFAULT_PARSE_LIMITS);
  const request = new ProjectionRequestBuilder(
    target === 'json5-best-exact' ? 'Json5BestExactCoreV1' : 'BestExactCoreV1',
  ).build();
  const result = project(document, request);
  const complete = expectedFieldOptional(case_, 'complete') as boolean | undefined;
  const code = expectedFieldOptional(case_, 'code') as string | undefined;
  if (complete === true) {
    if (result.kind !== 'Complete') {
      fail('projection should complete');
    }
    const kind = expectedFieldOptional(case_, 'kind') as string | undefined;
    if (kind !== undefined && result.value.value().kind !== kind) {
      fail(`kind: expected ${kind}, observed ${result.value.value().kind}`);
    }
    const binaryBits = expectedFieldOptional(case_, 'binary_bits') as string[] | undefined;
    if (binaryBits !== undefined) {
      const value = result.value.value();
      if (value.kind === 'EntryMapping') {
        const bits = value.entries.map((entry) => {
          const item = entry.value;
          return item.kind === 'BinaryFloat64' ? item.bits.toString(16).padStart(16, '0') : null;
        });
        if (bits.length !== binaryBits.length || bits.some((bit, index) => bit !== binaryBits[index])) {
          fail(`binary_bits: expected ${JSON.stringify(binaryBits)}, observed ${JSON.stringify(bits)}`);
        }
      }
    }
    return;
  }
  if (code !== undefined) {
    if (result.kind !== 'Failed') {
      fail('projection should fail');
    }
    const observed = result.value.diagnostics().map((diagnostic) => diagnostic.code);
    if (!observed.includes(code)) {
      fail(`missing code ${code} (observed ${observed.join(', ')})`);
    }
    return;
  }
  if (result.kind === 'Failed') {
    fail('projection failed unexpectedly');
  }
}

function materializeCase(case_: VectorCase): void {
  const style = caseField(case_, 'style') as string;
  const values = caseField(case_, 'values') as unknown[];
  const request = new MaterializationRequest(new ProfileId('json5.standard', 1), new MaterializationStyleId(style, 1)).withNewline('None');
  const portableValues = values.map((value) => {
    if (typeof value === 'object' && value !== null && 'bits' in value) {
      return { kind: 'BinaryFloat64' as const, bits: BigInt(`0x${(value as { bits: string }).bits}`) };
    }
    return valueFromInput(value);
  });
  const result = materialize({ kind: 'Sequence', items: portableValues }, request);
  const failure = expectedFieldOptional(case_, 'failure') as string | undefined;
  if (failure !== undefined) {
    if (result.kind !== 'Failed') {
      fail(`expected materialization failure ${failure}`);
    }
    const kind = result.value.failure().kind;
    const observed = kind === 'Unrepresentable' ? 'Unrepresentable' : kind === 'UnsupportedStyle' ? 'UnsupportedStyle' : kind;
    if (observed !== failure) {
      fail(`failure: expected ${failure}, observed ${observed}`);
    }
    return;
  }
  if (result.kind === 'Failed') {
    fail(`materialization failed: ${result.value.failure().code}`);
  }
  const output = expectedFieldOptional(case_, 'output') as string | undefined;
  if (output !== undefined) {
    const rendered = new TextDecoder().decode(result.value.document().render());
    if (rendered !== output) {
      fail(`output: expected ${JSON.stringify(output)}, observed ${JSON.stringify(rendered)}`);
    }
  }
}

function convertCase(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const sourceProfile = caseField(case_, 'source_profile') as string;
  const targetProfile = caseField(case_, 'target_profile') as string;
  const style = caseField(case_, 'style') as string;
  const document = parseJson(utf8(source), parseProfile(sourceProfile), DEFAULT_PARSE_LIMITS);
  const request = new MaterializationRequest(new ProfileId(targetProfile.split('@')[0], 1), new MaterializationStyleId(style, 1)).withNewline('None');
  const projection = new ProjectionRequestBuilder(
    sourceProfile.startsWith('json5') ? 'Json5BestExactCoreV1' : 'BestExactCoreV1',
  ).build();
  const result = convertJson(document, projection, request);
  const failure = expectedFieldOptional(case_, 'failure') as string | undefined;
  if (failure !== undefined) {
    if (result.kind !== 'Failed') {
      fail(`expected conversion failure ${failure}`);
    }
    const materialization = result.value.materialization;
    if (materialization === undefined || materialization.kind !== 'Unrepresentable') {
      fail(`failure: expected Unrepresentable, observed ${result.value.code}`);
    }
    return;
  }
  if (result.kind === 'Failed') {
    fail(`conversion failed: ${result.value.code}`);
  }
  const complete = result.value;
  const output = expectedFieldOptional(case_, 'output') as string | undefined;
  if (output !== undefined) {
    const rendered = new TextDecoder().decode(complete.document().render());
    if (rendered !== output) {
      fail(`output: expected ${JSON.stringify(output)}, observed ${JSON.stringify(rendered)}`);
    }
  }
  const fidelity = expectedFieldOptional(case_, 'fidelity');
  if (fidelity !== undefined && complete.report().overallFidelity() !== fidelity) {
    fail(`fidelity: expected ${String(fidelity)}, observed ${complete.report().overallFidelity()}`);
  }
}

function moveMemberCase(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const placement = caseField(case_, 'placement') as string;
  const document = parseJson(utf8(source), 'Json5Standard', DEFAULT_PARSE_LIMITS);
  const members = document.root().objectMembers();
  if (members.kind !== 'Available' || members.value === null) {
    fail('object semantics unavailable');
  }
  const target = members.value[(caseField(case_, 'target_path') as number[])[0]];
  const builder = new EditTransactionBuilder(document);
  builder.moveMember(
    target.nodeRef(),
    placement === 'start' ? { kind: 'Start' } : { kind: 'End' },
  );
  const commit = commitEdits(document, builder.build());
  const output = expectedFieldOptional(case_, 'output') as string | undefined;
  if (output !== undefined) {
    const rendered = new TextDecoder().decode(commit.document().render());
    if (rendered !== output) {
      fail(`output: expected ${JSON.stringify(output)}, observed ${JSON.stringify(rendered)}`);
    }
  }
  const patchEqual = expectedFieldOptional(case_, 'patch_equal');
  if (patchEqual === true) {
    const patched = commit.sourcePatch().apply(document.source(), { ...requirePatchLimits() });
    if (new TextDecoder().decode(patched.bytes()) !== new TextDecoder().decode(commit.document().render())) {
      fail('patch must equal the commit target');
    }
  }
  const proofValid = expectedFieldOptional(case_, 'proof_valid');
  if (proofValid === true) {
    commit.untouchedProof().verify(
      document.source(),
      SourceSnapshot.fromRaw(
        commit.sourcePatch().apply(document.source(), { ...DEFAULT_SOURCE_PATCH_LIMITS }).bytes(),
        document.source().encodingFacts().resolutionRequest(),
        UNBOUNDED_SOURCE_LIMITS,
      ),
      commit.sourcePatch().replacements(),
    );
  }
}

function requirePatchLimits(): import('../../document/source_patch.ts').SourcePatchLimits {
  return { ...DEFAULT_SOURCE_PATCH_LIMITS };
}

import { DEFAULT_SOURCE_PATCH_LIMITS } from '../../document/source_patch.ts';
import { SourceSnapshot, EncodingRequest, utf8Encoding, UNBOUNDED_SOURCE_LIMITS } from '../../document/source.ts';

/** move-cross-object-rejected */
function moveCrossObjectRejected(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const document = parseJson(utf8(source), 'Json5Standard', DEFAULT_PARSE_LIMITS);
  const outer = document.root().objectMembers();
  if (outer.kind !== 'Available' || outer.value === null) {
    fail('object semantics unavailable');
  }
  const left = outer.value[0].value().objectMembers();
  const right = outer.value[1].value().objectMembers();
  if (left.kind !== 'Available' || left.value === null || right.kind !== 'Available' || right.value === null) {
    fail('object semantics unavailable');
  }
  const builder = new EditTransactionBuilder(document);
  builder.moveMember(left.value[0].nodeRef(), { kind: 'Before', anchor: right.value[0].nodeRef() });
  try {
    commitEdits(document, builder.build());
  } catch (error) {
    const failure = expectedFieldOptional(case_, 'failure') as string | undefined;
    if (failure === 'TargetNotFound') {
      return;
    }
    fail(`expected TargetNotFound, observed ${String(error)}`);
  }
  fail('expected a cross-object move rejection');
}

function editScalarsCase(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const replacements = caseField(case_, 'replacements') as { ordinal: number; integer?: string; decimal_coefficient?: string; decimal_exponent?: string; string?: string; bits?: string }[];
  const document = parseJson(utf8(source), 'Json5Standard', DEFAULT_PARSE_LIMITS);
  const members = document.root().objectMembers();
  if (members.kind !== 'Available' || members.value === null) {
    fail('object semantics unavailable');
  }
  const builder = new EditTransactionBuilder(document);
  for (const replacement of replacements) {
    const target = members.value[replacement.ordinal].valueNodeRef();
    if (replacement.integer !== undefined) {
      builder.semanticScalar(target, { kind: 'Integer', value: BigInt(replacement.integer) }, 'PreserveCompatible');
    } else if (replacement.decimal_coefficient !== undefined) {
      builder.semanticScalar(
        target,
        { kind: 'Decimal', coefficient: BigInt(replacement.decimal_coefficient), exponent: BigInt(replacement.decimal_exponent ?? '0') },
        'PreserveCompatible',
      );
    } else if (replacement.string !== undefined) {
      builder.semanticScalar(target, { kind: 'String', value: replacement.string }, 'PreserveCompatible');
    } else if (replacement.bits !== undefined) {
      builder.semanticScalar(target, { kind: 'BinaryFloat64', bits: BigInt(`0x${replacement.bits}`) }, 'PreserveCompatible');
    }
  }
  const commit = commitEdits(document, builder.build());
  const output = expectedFieldOptional(case_, 'output') as string | undefined;
  if (output !== undefined) {
    const rendered = new TextDecoder().decode(commit.document().render());
    if (rendered !== output) {
      fail(`output: expected ${JSON.stringify(output)}, observed ${JSON.stringify(rendered)}`);
    }
  }
}

function registryV4(case_: VectorCase): void {
  const contractCount = expectedFieldOptional(case_, 'contract_count') as number | undefined;
  const errorCodeCount = expectedFieldOptional(case_, 'error_code_count') as number | undefined;
  const v3ErrorCodeCount = expectedFieldOptional(case_, 'v3_error_code_count') as number | undefined;
  const newCode = expectedFieldOptional(case_, 'new_code') as string | undefined;
  if (contractCount !== undefined && new ContractRegistry(4).contracts().length !== contractCount) {
    fail('v4 contract count mismatch');
  }
  if (errorCodeCount !== undefined && new ErrorCodeRegistry(4).codes().length !== errorCodeCount) {
    fail('v4 error code count mismatch');
  }
  if (v3ErrorCodeCount !== undefined && new ErrorCodeRegistry(3).codes().length !== v3ErrorCodeCount) {
    fail('v3 error code count mismatch');
  }
  if (newCode !== undefined) {
    const v4 = new ErrorCodeRegistry(4);
    const v3 = new ErrorCodeRegistry(3);
    if (!v4.contains(newCode) || v3.contains(newCode)) {
      fail(`${newCode} must be new in v4`);
    }
  }
}

function parseLimitCase(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const maxDepth = caseField(case_, 'max_depth') as number;
  const limits = { ...DEFAULT_PARSE_LIMITS, maxNestingDepth: maxDepth };
  try {
    parseJson(utf8(source), 'Json5Standard', limits);
  } catch (error) {
    if (error instanceof JsonFormationFailure) {
      const fatal = expectedFieldOptional(case_, 'fatal');
      if (fatal === true) {
        return;
      }
    }
    throw error;
  }
  fail('expected a fatal depth-limit failure');
}

export const runJsonFamilyV2: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    const action = caseField(case_, 'action') as string;
    switch (action) {
      case 'parse':
        parseCase(case_);
        return;
      case 'syntax-query':
        syntaxQueryCase(case_);
        return;
      case 'native-query':
        nativeQueryCase(case_);
        return;
      case 'project':
        projectCase(case_);
        return;
      case 'materialize':
        materializeCase(case_);
        return;
      case 'convert':
        convertCase(case_);
        return;
      case 'move-member':
        if (case_.id === 'json5.edit.move-cross-object-rejected') {
          moveCrossObjectRejected(case_);
          return;
        }
        moveMemberCase(case_);
        return;
      case 'edit-scalars':
        editScalarsCase(case_);
        return;
      case 'registry-v4':
        registryV4(case_);
        return;
      case 'parse-limit':
        parseLimitCase(case_);
        return;
      default:
        throw new SkippedCase(
          case_.capability ?? 'unknown',
          `runner does not recognize published case ${case_.id}`,
        );
    }
  },
};

void objectValue;
void skip;
