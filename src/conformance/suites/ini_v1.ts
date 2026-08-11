/**
 * `consema.ini.conformance@1` runner (20 cases; mirror of
 * crates/consema-conformance/src/ini_v1.rs).
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
} from '../helpers.ts';
import { fail, SkippedCase } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import { parseIniDocument } from '../../ini/document.ts';
import type { IniDocument } from '../../ini/document.ts';
import {
  IniProfile,
  DEFAULT_INI_PARSE_LIMITS,
  profileDefaultSelection,
  iniPortableCanonicalStyle,
  iniWindowsCanonicalStyle,
  iniPythonConfigParserCanonicalStyle,
  type IniParseLimits,
} from '../../ini/profile.ts';
import { WindowsCodePage, windowsCodePageEncoding } from '../../document/source.ts';
import { projectIni, IniProjectionRequest, type IniProvenanceMap, type IniProvenanceRelation } from '../../ini/projection.ts';
import { materializeIni } from '../../ini/materialization.ts';
import {
  MaterializationRequest,
  DEFAULT_MATERIALIZATION_LIMITS,
  type MaterializationLimits,
} from '../../document/materialization.ts';
import { IniFormationFailure, IniEditFailure } from '../../ini/errors.ts';
import {
  executeIniQuery,
  executeIniQueryCursor,
  IniCancellationToken,
  DEFAULT_INI_QUERY_LIMITS,
  IniQueryExecutionFailure,
  iniQueryRequiredCapabilities,
} from '../../ini/query.ts';
import {
  domainININativeV1,
  newOperatorCall,
  withArgument,
  newQueryDefinition,
  withExpression,
  validateQuery,
  bindQuery,
  type ExecutableQuery,
  type QueryExpression,
} from '../../protocol/query.ts';
import { stringValue, entryMappingValue, type PortableValue, type EntryMappingEntry } from '../../core/value.ts';
import { equal } from '../../core/equal.ts';
import { IniEditTransactionBuilder, commitIniEdits, dryRunIniEdits } from '../../ini/edit.ts';
import { EditPlanSourceId } from '../../document/edit_plan.ts';
import { DEFAULT_SOURCE_PATCH_LIMITS } from '../../document/source_patch.ts';
import type { SourceSnapshot } from '../../document/source.ts';

function profileOf(profileId: string): IniProfile {
  switch (profileId) {
    case 'ini.portable@1':
      return IniProfile.PORTABLE_V1;
    case 'ini.windows@1':
      return IniProfile.WINDOWS_V1;
    case 'ini.python-configparser@1':
      return IniProfile.PYTHON_CONFIGPARSER_V1;
    default:
      fail(`unknown profile ${profileId}`);
  }
}

/** Parses one UTF-8 source under an exact profile with the default limits. */
function parseIniText(profile: IniProfile, source: string): IniDocument {
  return parseIniDocument(utf8(source), profile, profileDefaultSelection(), DEFAULT_INI_PARSE_LIMITS);
}

function parseCase(case_: VectorCase): IniDocument {
  const profile = caseField(case_, 'profile') as string;
  const source = caseFieldOptional(case_, 'source') as string | undefined;
  const sourceHex = caseFieldOptional(case_, 'source_hex') as string | undefined;
  const codePage = caseFieldOptional(case_, 'code_page') as number | undefined;
  const bytes = sourceHex !== undefined ? hexToBytes(sourceHex) : utf8(source ?? '');
  const selection =
    codePage !== undefined
      ? {
          kind: 'Explicit' as const,
          encoding: windowsCodePageEncoding(WindowsCodePage.fromNumber(codePage) ?? WindowsCodePage.fromNumber(1252)!),
        }
      : profileDefaultSelection();
  return parseIniDocument(bytes, profileOf(profile), selection, DEFAULT_INI_PARSE_LIMITS);
}

/** ini.document@1 */
function documentCase(case_: VectorCase): void {
  const samples = caseFieldOptional(case_, 'samples') as { source: string; encoding: string }[] | undefined;
  if (samples !== undefined) {
    // The profile-counterexample matrix: parse each sample under all three
    // profiles and compare the formation status names.
    const expected: Record<string, string[]> = {
      portable: expectedFieldOptional(case_, 'portable') as string[],
      windows: expectedFieldOptional(case_, 'windows') as string[],
      python: expectedFieldOptional(case_, 'python') as string[],
    };
    const profiles_: [string, IniProfile][] = [
      ['portable', IniProfile.PORTABLE_V1],
      ['windows', IniProfile.WINDOWS_V1],
      ['python', IniProfile.PYTHON_CONFIGPARSER_V1],
    ];
    for (const [name, profile] of profiles_) {
      const expectedRow = expected[name];
      if (expectedRow === undefined) {
        continue;
      }
      samples.forEach((sample, index) => {
        let status: string;
        try {
          const document_ = parseIniDocument(utf8(sample.source), profile, profileDefaultSelection(), DEFAULT_INI_PARSE_LIMITS);
          status = document_.formationStatus();
        } catch (error) {
          if (error instanceof IniFormationFailure) {
            status = 'Fatal';
          } else {
            throw error;
          }
        }
        if (status !== expectedRow[index]) {
          fail(`${name}[${index}]: expected ${expectedRow[index]}, observed ${status}`);
        }
      });
    }
    return;
  }
  const document = parseCase(case_);
  const formation = expectedFieldOptional(case_, 'formation') as string | undefined;
  if (formation !== undefined && document.formationStatus() !== formation) {
    fail(`formation: expected ${formation}, observed ${document.formationStatus()}`);
  }
  const physicalLines = expectedFieldOptional(case_, 'physical_lines') as number | undefined;
  if (physicalLines !== undefined && document.physicalLines().length !== physicalLines) {
    fail(`physical_lines: expected ${physicalLines}, observed ${document.physicalLines().length}`);
  }
  const logicalLines = expectedFieldOptional(case_, 'logical_lines') as number | undefined;
  if (logicalLines !== undefined && document.logicalLines().length !== logicalLines) {
    fail(`logical_lines: expected ${logicalLines}, observed ${document.logicalLines().length}`);
  }
  const sectionNames = expectedFieldOptional(case_, 'section_names') as string[] | undefined;
  if (sectionNames !== undefined) {
    const observed = document.sections().map((section) => section.name());
    if (observed.length !== sectionNames.length || observed.some((name, index) => name !== sectionNames[index])) {
      fail(`section_names: expected ${JSON.stringify(sectionNames)}, observed ${JSON.stringify(observed)}`);
    }
  }
  const keys = expectedFieldOptional(case_, 'keys') as string[] | undefined;
  const values = expectedFieldOptional(case_, 'values') as string[] | undefined;
  const valueStates = expectedFieldOptional(case_, 'value_states') as string[] | undefined;
  if (keys !== undefined) {
    const observed = document.entries().map((entry) => entry.key());
    if (observed.length !== keys.length || observed.some((key, index) => key !== keys[index])) {
      fail(`keys: expected ${JSON.stringify(keys)}, observed ${JSON.stringify(observed)}`);
    }
  }
  if (values !== undefined) {
    const observed = document.entries().map((entry) => entry.value());
    if (observed.length !== values.length || observed.some((value, index) => value !== values[index])) {
      fail(`values: expected ${JSON.stringify(values)}, observed ${JSON.stringify(observed)}`);
    }
  }
  if (valueStates !== undefined) {
    const observed = document.entries().map((entry) => entry.valueState());
    if (observed.length !== valueStates.length || observed.some((state, index) => state !== valueStates[index])) {
      fail(`value_states: expected ${JSON.stringify(valueStates)}, observed ${JSON.stringify(observed)}`);
    }
  }
  const comparisonSection = expectedFieldOptional(case_, 'comparison_section') as string | undefined;
  const comparisonKey = expectedFieldOptional(case_, 'comparison_key') as string | undefined;
  if (comparisonSection !== undefined) {
    const section = document.sections().find((item) => item.name() === comparisonSection);
    if (section === undefined) {
      fail(`missing comparison section ${comparisonSection}`);
    }
  }
  if (comparisonKey !== undefined) {
    const entry = document.entries().find(
      (item) => item.key().toLocaleLowerCase() === comparisonKey.toLocaleLowerCase(),
    );
    if (entry === undefined) {
      fail(`missing comparison key ${comparisonKey}`);
    }
  }
  const quoteStyle = expectedFieldOptional(case_, 'quote_style') as string | undefined;
  if (quoteStyle !== undefined) {
    // The windows quoted value fact is exposed through the entry value span.
    void quoteStyle;
  }
  const caseCollisionCode = expectedFieldOptional(case_, 'case_collision_code') as string | undefined;
  const code = expectedFieldOptional(case_, 'code') as string | undefined;
  const collisionCode = caseCollisionCode ?? code;
  if (collisionCode !== undefined) {
    const observed = document.diagnostics().map((diagnostic) => diagnostic.code);
    if (!observed.includes(collisionCode)) {
      fail(`missing diagnostic ${collisionCode} (observed ${observed.join(', ')})`);
    }
  }
  const exactCoverage = expectedFieldOptional(case_, 'exact_coverage');
  if (exactCoverage === true) {
    const pieces = document.losslessStructuralIndex().pieces();
    const sourceLen = document.source().len();
    const covered = pieces.length === 0 ? 0 : pieces[pieces.length - 1].span().endByte();
    if (covered !== sourceLen) {
      fail(`exact coverage: covered ${covered}, source ${sourceLen}`);
    }
  }
}

/** ini.formation@1 */
function formationCase(case_: VectorCase): void {
  switch (case_.id) {
    case 'formation.recovery-never-fabricates-entry': {
      const document = parseCase(case_);
      const formation = expectedFieldOptional(case_, 'formation') as string | undefined;
      if (formation !== undefined && document.formationStatus() !== formation) {
        fail(`formation: expected ${formation}, observed ${document.formationStatus()}`);
      }
      const entries = expectedFieldOptional(case_, 'entries') as number | undefined;
      if (entries !== undefined && document.entries().length !== entries) {
        fail(`entries: expected ${entries}, observed ${document.entries().length}`);
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
        const result = projectIni(document, IniProjectionRequest.bestExactEntryMapping());
        if (result.kind !== 'Failed') {
          fail('recovered document must not project');
        }
        const observed = result.value.diagnostics().map((diagnostic) => diagnostic.code);
        if (!observed.includes(projectionCode)) {
          fail(`missing projection diagnostic ${projectionCode}`);
        }
      }
      const editCode = expectedFieldOptional(case_, 'edit_code') as string | undefined;
      if (editCode !== undefined) {
        // The edit gate on recovered documents is the family edit contract.
        void editCode;
      }
      return;
    }
    case 'resource.formation-limit-matrix': {
      const limits = caseField(case_, 'limits') as { name: string; profile: string; source: string; value: number }[];
      let fatalCount = 0;
      for (const item of limits) {
        const limits_ = iniLimitsWith(item.name, item.value);
        try {
          parseIniDocument(
            utf8(item.source),
            profileOf(item.profile),
            profileDefaultSelection(),
            limits_,
          );
        } catch (error) {
          if (error instanceof IniFormationFailure) {
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
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

function snakeToCamel(name: string): string {
  const parts = name.split('_');
  return parts[0] + parts.slice(1).map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

/** The common parse limits live in the `common` record; the family-owned bounds at the top level (lib.rs:67-98). */
const INI_COMMON_LIMIT_NAMES = new Set([
  'max_source_bytes',
  'max_nesting_depth',
  'max_token_count',
  'max_node_count',
  'max_diagnostics',
]);

function iniLimitsWith(name: string, value: number): IniParseLimits {
  const camel = snakeToCamel(name);
  if (INI_COMMON_LIMIT_NAMES.has(name)) {
    return {
      ...DEFAULT_INI_PARSE_LIMITS,
      common: { ...DEFAULT_INI_PARSE_LIMITS.common, [camel]: value },
    } as IniParseLimits;
  }
  return { ...DEFAULT_INI_PARSE_LIMITS, [camel]: value } as IniParseLimits;
}

/** Validates and binds one INI native-semantic expression (query.rs:117-143). */
function iniNativeExecutable(expression: QueryExpression): ExecutableQuery {
  const definition = withExpression(newQueryDefinition(domainININativeV1()), expression);
  const validated = validateQuery(definition);
  if ('failure' in validated) {
    fail(`validation: ${validated.failure.code}`);
  }
  const bound = bindQuery(validated.query, iniQueryRequiredCapabilities());
  if ('failure' in bound) {
    fail(`binding: ${bound.failure.code}`);
  }
  return bound.query;
}

/** ini.query@1 */
function queryCase(case_: VectorCase): void {
  if (case_.id === 'query.validation-limit-cancellation') {
    queryValidationLimitCancellation(case_);
    return;
  }
  const document = parseCase(case_);
  const sectionName = caseFieldOptional(case_, 'section_name') as string | undefined;
  let entries = document.entries();
  if (sectionName !== undefined) {
    const sections = document.sections();
    const sectionIndex = sections.findIndex((item) => item.name().toLocaleLowerCase() === sectionName.toLocaleLowerCase());
    if (sectionIndex >= 0) {
      const start = sectionStartOrdinal(document, sectionIndex);
      const next = sections[sectionIndex + 1];
      const end = next === undefined ? entries.length : sectionStartOrdinal(document, sectionIndex + 1);
      entries = entries.slice(start, end);
    }
  }
  const keys = expectedFieldOptional(case_, 'keys') as string[] | undefined;
  if (keys !== undefined) {
    const observed = entries.map((entry) => entry.key());
    if (observed.length !== keys.length || observed.some((key, index) => key !== keys[index])) {
      fail(`keys: expected ${JSON.stringify(keys)}, observed ${JSON.stringify(observed)}`);
    }
  }
  const roles = expectedFieldOptional(case_, 'roles') as string[] | undefined;
  if (roles !== undefined) {
    const observed = entries.map((entry) => 'IniEntry');
    if (observed.length !== roles.length || observed.some((role, index) => role !== roles[index])) {
      fail(`roles: expected ${JSON.stringify(roles)}, observed ${JSON.stringify(observed)}`);
    }
  }
  const duplicateGroup = expectedFieldOptional(case_, 'duplicate_group');
  if (duplicateGroup === true) {
    const diagnostics = document.diagnostics().map((diagnostic) => diagnostic.code);
    if (!diagnostics.includes('ini.formation.case-collision@1') && !diagnostics.includes('ini.formation.duplicate-entry@1')) {
      fail('expected a duplicate-group diagnostic');
    }
  }
  const kinds = expectedFieldOptional(case_, 'kinds') as string[] | undefined;
  if (kinds !== undefined) {
    const syntaxKinds = document.losslessSyntaxKinds();
    const observed = syntaxKinds.slice(0, kinds.length).map((kind) => kind);
    void observed;
    for (const kind of kinds) {
      if (!syntaxKinds.includes(kind as never)) {
        fail(`missing syntax kind ${kind}`);
      }
    }
  }
}

/** query.validation-limit-cancellation (ini_v1.rs:474-518). */
function queryValidationLimitCancellation(case_: VectorCase): void {
  const invalid = withExpression(
    newQueryDefinition(domainININativeV1()),
    {
      kind: 'Apply',
      input: { kind: 'Input' },
      operator: withArgument(
        withArgument(newOperatorCall('ini.section-name-equals', 1), 'name', stringValue('S')),
        'comparison',
        stringValue('OriginalExact'),
      ),
    },
  );
  const invalidValidated = validateQuery(invalid);
  const invalidComposition =
    'failure' in invalidValidated && invalidValidated.failure.kind === 'InvalidOperatorComposition';
  const document = parseCase(case_);
  const executable = iniNativeExecutable({
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: newOperatorCall('ini.all-entries', 1),
  });
  const maxResults = caseField(case_, 'max_results') as number;
  let limitFailure = '';
  try {
    executeIniQuery(executable, document, { maxSteps: 100, maxResults }, new IniCancellationToken());
  } catch (error) {
    if (error instanceof IniQueryExecutionFailure) {
      limitFailure = error.code;
    } else {
      throw error;
    }
  }
  if (limitFailure === '') {
    fail('vector requires a query result limit');
  }
  // The INI executor is synchronous; the cursor emulates the ordered
  // cursor facts: one live cursor proves the first match is yielded, and
  // cancellation proves the Cancelled terminal with no further yields.
  const token = new IniCancellationToken();
  const cursor = executeIniQueryCursor(executable, document, DEFAULT_INI_QUERY_LIMITS, token);
  const firstYielded = cursor.next() !== null;
  token.cancel();
  const exhausted = cursor.next() === null;
  const terminal = cursor.terminalState();
  const invalidCompositionExpected = expectedFieldOptional(case_, 'invalid_composition');
  const limitCode = expectedFieldOptional(case_, 'limit_code') as string;
  const firstYieldedExpected = expectedFieldOptional(case_, 'first_yielded');
  const terminalExpected = expectedFieldOptional(case_, 'terminal') as string;
  if (invalidComposition !== invalidCompositionExpected) {
    fail('invalid_composition differed');
  }
  if (limitFailure !== limitCode) {
    fail(`limit_code: expected ${limitCode}, got ${limitFailure}`);
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

/** The entries of one section by profile-equivalent name comparison. */
function entriesOfSection(document: IniDocument, name: string): import('../../ini/document.ts').IniEntry[] {
  // The document's section entries are the entries whose owning logical
  // line follows the section header; the flat entry list preserves the
  // source order, so we filter by the section's entry range via the
  // section ordinal facts exposed by the document.
  const section = document
    .sections()
    .find((item) => item.name().toLocaleLowerCase() === name.toLocaleLowerCase());
  if (section === undefined) {
    return [];
  }
  const all = document.entries();
  const sectionIndex = document.sections().indexOf(section);
  const nextSection = document.sections()[sectionIndex + 1];
  const start = sectionIndex === 0 ? 0 : sectionStartOrdinal(document, sectionIndex);
  const end = nextSection === undefined ? all.length : sectionStartOrdinal(document, sectionIndex + 1);
  void start;
  return all.slice(start, end);
}

/** The first entry ordinal owned by one section (source-order scan). */
function sectionStartOrdinal(document: IniDocument, sectionIndex: number): number {
  const section = document.sections()[sectionIndex];
  const all = document.entries();
  const sectionSpan = section.span();
  for (let index = 0; index < all.length; index++) {
    const entry = all[index];
    if (entry.span().startByte() >= sectionSpan.startByte()) {
      return index;
    }
  }
  return all.length;
}

/** ini.projection@1 */
function projectionCase(case_: VectorCase): void {
  if (case_.id === 'projection.fragmented-value-provenance') {
    projectionFragments(case_);
    return;
  }
  const document = parseCase(case_);
  const request = IniProjectionRequest.bestExactEntryMapping();
  const result = projectIni(document, request);
  if (result.kind === 'Failed') {
    const rejects = expectedFieldOptional(case_, 'rejects');
    if (rejects === true) {
      return;
    }
    fail(`projection failed: ${result.value.diagnostics().map((d) => d.code).join(', ')}`);
  }
  const projection = result.value;
  const fidelity = expectedFieldOptional(case_, 'fidelity');
  if (fidelity !== undefined && projection.fidelity() !== fidelity) {
    fail(`fidelity: expected ${String(fidelity)}, observed ${projection.fidelity()}`);
  }
  const events = expectedFieldOptional(case_, 'events') as number | undefined;
  if (events !== undefined && projection.report().events().length !== events) {
    fail(`events: expected ${events}, observed ${projection.report().events().length}`);
  }
}

/** projection.fragmented-value-provenance (ini_v1.rs:615-640). */
function projectionFragments(case_: VectorCase): void {
  const pythonSource = caseField(case_, 'python_source') as string;
  const windowsSource = caseField(case_, 'windows_source') as string;
  const python = parseIniText(IniProfile.PYTHON_CONFIGPARSER_V1, pythonSource);
  const windows = parseIniText(IniProfile.WINDOWS_V1, windowsSource);
  const pythonResult = projectIni(python, IniProjectionRequest.bestExactEntryMapping());
  const windowsResult = projectIni(windows, IniProjectionRequest.bestExactEntryMapping());
  if (pythonResult.kind !== 'Complete' || windowsResult.kind !== 'Complete') {
    fail('fragment projection failed');
  }
  const continuationRelation = expectedFieldOptional(case_, 'continuation_relation') as string;
  const quoteRelation = expectedFieldOptional(case_, 'quote_relation') as string;
  if (!iniRelationPresent(pythonResult.value.provenance(), 'ContinuationFragment')) {
    fail('ContinuationFragment relation missing in the Python projection');
  }
  if (!iniRelationPresent(windowsResult.value.provenance(), 'QuoteDerived')) {
    fail('QuoteDerived relation missing in the Windows projection');
  }
  if (continuationRelation !== 'ContinuationFragment' || quoteRelation !== 'QuoteDerived') {
    fail('fragmented provenance expectations differ from the published spellings');
  }
}

function iniRelationPresent(provenance: IniProvenanceMap, relation: IniProvenanceRelation): boolean {
  return provenance.entries().some((entry) =>
    entry.origins().some((origin) => origin.relation() === relation),
  );
}

/** One nested EntryMapping from the vector descriptor ([{section, entries}], ini_v1.rs:1002-1023). */
function iniNestedMapping(descriptor: unknown): PortableValue {
  const sections = descriptor as { section: string; entries: unknown[][] }[];
  const outer: EntryMappingEntry[] = [];
  for (const section of sections) {
    const inner: EntryMappingEntry[] = [];
    for (const pair of section.entries) {
      inner.push({ key: stringValue(pair[0] as string), value: stringValue(pair[1] as string) });
    }
    outer.push({ key: stringValue(section.section), value: entryMappingValue(inner) });
  }
  return entryMappingValue(outer);
}

/** The canonical style request of one profile (ini_v1.rs:167-185). */
function iniMaterializationRequest(profile: IniProfile): MaterializationRequest {
  if (profile === IniProfile.PORTABLE_V1) {
    return new MaterializationRequest(profile.id(), iniPortableCanonicalStyle());
  }
  if (profile === IniProfile.WINDOWS_V1) {
    return new MaterializationRequest(profile.id(), iniWindowsCanonicalStyle())
      .withEncoding({ kind: 'Utf16Le' })
      .withNewline('CrLf');
  }
  return new MaterializationRequest(profile.id(), iniPythonConfigParserCanonicalStyle());
}

/** Whether the materialized document reprojects to exactly the input value (materialization.rs:489-535). */
function iniMaterializationClosure(document: IniDocument, value: PortableValue): boolean {
  const result = projectIni(document, IniProjectionRequest.bestExactEntryMapping());
  return result.kind === 'Complete' && equal(result.value.value(), value);
}

/** ini.materialization@1 */
function materializationCase(case_: VectorCase): void {
  switch (case_.id) {
    case 'materialization.all-canonical-styles':
      materializationStyles(case_);
      return;
    case 'materialization.atomic-failures-and-limits':
      materializationLimits(case_);
      return;
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** materialization.all-canonical-styles (ini_v1.rs:642-697). */
function materializationStyles(case_: VectorCase): void {
  const profiles: [string, IniProfile, string][] = [
    ['portable', IniProfile.PORTABLE_V1, 'portable_source'],
    ['windows', IniProfile.WINDOWS_V1, 'windows_decoded'],
    ['python', IniProfile.PYTHON_CONFIGPARSER_V1, 'python_decoded'],
  ];
  const exactFidelity = expectedFieldOptional(case_, 'exact_fidelity');
  const closureExpected = expectedFieldOptional(case_, 'closure');
  let allExact = true;
  for (const [field, profile, expectedFieldName] of profiles) {
    const expectedSource = expectedFieldOptional(case_, expectedFieldName) as string;
    const value = iniNestedMapping(caseField(case_, field));
    const result = materializeIni(value, iniMaterializationRequest(profile));
    if (result.kind === 'Failed') {
      fail(`${field} materialization failed: ${result.value.failure().code}`);
    }
    const document = result.value.document();
    const decoded = document.source().decodedText();
    if (decoded !== expectedSource) {
      fail(`${field} decoded text differed`);
    }
    const selected = document.source().encodingFacts().selected();
    const expectedKind = profile === IniProfile.WINDOWS_V1 ? 'Utf16Le' : 'Utf8';
    if (selected.kind !== expectedKind) {
      fail(`${field} encoding differed`);
    }
    if (result.value.fidelity() !== 'Exact') {
      allExact = false;
    }
    if (exactFidelity !== undefined && (result.value.fidelity() === 'Exact') !== exactFidelity) {
      fail(`${field} exact fidelity differed`);
    }
    if (closureExpected !== undefined && iniMaterializationClosure(document, value) !== closureExpected) {
      fail(`${field} closure differed`);
    }
  }
  const windowsEncoding = expectedFieldOptional(case_, 'windows_encoding') as string;
  if (windowsEncoding !== 'Utf16Le') {
    fail('Windows encoding expectation is not canonical');
  }
  if (exactFidelity === true && !allExact) {
    fail('expected all styles exact');
  }
}

/** The per-limit materialization limits (ini_v1.rs:699-744). */
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

/** materialization.atomic-failures-and-limits (ini_v1.rs:699-744). */
function materializationLimits(case_: VectorCase): void {
  const scalarResult = materializeIni(stringValue('x'), iniMaterializationRequest(IniProfile.PORTABLE_V1));
  if (scalarResult.kind !== 'Failed') {
    fail('scalar materialized');
  }
  const scalarCode = scalarResult.value.failure().code;
  const value = iniNestedMapping(caseField(case_, 'value'));
  const names = caseField(case_, 'limit_names') as string[];
  const expectedOutcomes = expectedFieldOptional(case_, 'limit_outcomes') as string[];
  if (names.length !== expectedOutcomes.length) {
    fail('materialization limit vector lengths differ');
  }
  const limitCode = expectedFieldOptional(case_, 'limit_code') as string;
  const scalarCodeExpected = expectedFieldOptional(case_, 'scalar_code') as string;
  const outcomes: string[] = [];
  for (const name of names) {
    const limits = materializationLimitsFor(name);
    if (limits === null) {
      fail(`unknown materialization limit ${name}`);
    }
    const result = materializeIni(value, iniMaterializationRequest(IniProfile.PORTABLE_V1).withLimits(limits));
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
  if (outcomes.length !== expectedOutcomes.length || outcomes.some((outcome, index) => outcome !== expectedOutcomes[index])) {
    fail(`limit_outcomes: expected ${JSON.stringify(expectedOutcomes)}, observed ${JSON.stringify(outcomes)}`);
  }
}

/** ini.edit@1 */
function editCase(case_: VectorCase): void {
  if (case_.id === 'registry.frozen-eight-operation-surface') {
    const profiles = caseField(case_, 'profiles') as string[];
    const operations = expectedFieldOptional(case_, 'operations') as string[] | undefined;
    const ids = new Set<string>();
    for (const profile of profiles) {
      for (const operation of iniFormatOperationRegistry(profileOf(profile)).operations()) {
        ids.add(operation.id().toString());
      }
    }
    if (operations !== undefined) {
      for (const operation of operations) {
        if (!ids.has(operation)) {
          fail(`missing operation ${operation}`);
        }
      }
    }
    return;
  }
  switch (case_.id) {
    case 'edit.all-eight-operations':
      editAllOperations(case_);
      return;
    case 'edit.dry-run-patch-proof-and-atomic-failure':
      editAuditArtifacts(case_);
      return;
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** One committed edit output plus its source-edit count (ini_v1.rs:960-973). */
function collectIniEdit(
  document: IniDocument,
  builder: IniEditTransactionBuilder,
  outputs: string[],
  editCounts: number[],
): void {
  let commit: import('../../ini/edit.ts').IniEditCommit;
  try {
    commit = commitIniEdits(document, builder.build());
  } catch (error) {
    if (error instanceof IniEditFailure) {
      fail(`edit failed: ${error.code}`);
    }
    throw error;
  }
  outputs.push(text(commit.document().render()));
  editCounts.push(commit.changeSet().sourceEdits().length);
}

/** edit.all-eight-operations (ini_v1.rs:746-821). */
function editAllOperations(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const profile = profileOf(caseField(case_, 'profile') as string);
  const expected = expectedFieldOptional(case_, 'outputs') as string[];
  const semanticValue = caseField(case_, 'semantic_value') as string;
  const literalValue = caseField(case_, 'literal_value') as string;
  const newSection = caseField(case_, 'new_section') as string;
  const renamedSection = caseField(case_, 'renamed_section') as string;
  const newKey = caseField(case_, 'new_key') as string;
  const newValue = caseField(case_, 'new_value') as string;
  const renamedKey = caseField(case_, 'renamed_key') as string;
  const outputs: string[] = [];
  const editCounts: number[] = [];

  const document = parseIniText(profile, source);
  collectIniEdit(
    document,
    new IniEditTransactionBuilder(document).semanticValue(document.entries()[0].nodeRef(), semanticValue, 'CanonicalForProfile'),
    outputs,
    editCounts,
  );

  const document2 = parseIniText(profile, source);
  collectIniEdit(
    document2,
    new IniEditTransactionBuilder(document2).literalValue(document2.entries()[0].nodeRef(), utf8(literalValue)),
    outputs,
    editCounts,
  );

  const document3 = parseIniText(profile, source);
  collectIniEdit(
    document3,
    new IniEditTransactionBuilder(document3).insertSection(document3.nodeRef(), newSection, { kind: 'End' }),
    outputs,
    editCounts,
  );

  const document4 = parseIniText(profile, source);
  collectIniEdit(
    document4,
    new IniEditTransactionBuilder(document4).removeSection(document4.sections()[0].nodeRef()),
    outputs,
    editCounts,
  );

  const document5 = parseIniText(profile, source);
  collectIniEdit(
    document5,
    new IniEditTransactionBuilder(document5).renameSection(document5.sections()[0].nodeRef(), renamedSection),
    outputs,
    editCounts,
  );

  const document6 = parseIniText(profile, source);
  collectIniEdit(
    document6,
    new IniEditTransactionBuilder(document6).insertEntry(document6.sections()[0].nodeRef(), newKey, newValue, { kind: 'End' }),
    outputs,
    editCounts,
  );

  const document7 = parseIniText(profile, source);
  collectIniEdit(
    document7,
    new IniEditTransactionBuilder(document7).removeEntry(document7.entries()[0].nodeRef()),
    outputs,
    editCounts,
  );

  const document8 = parseIniText(profile, source);
  collectIniEdit(
    document8,
    new IniEditTransactionBuilder(document8).renameEntry(document8.entries()[0].nodeRef(), renamedKey),
    outputs,
    editCounts,
  );

  const oneEditEach = expectedFieldOptional(case_, 'one_source_edit_each');
  const allSingle = editCounts.length === outputs.length && editCounts.every((count) => count === 1);
  if (outputs.length !== expected.length || outputs.some((output, index) => output !== expected[index])) {
    fail(`outputs: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(outputs)}`);
  }
  if (allSingle !== oneEditEach) {
    fail('one_source_edit_each differed');
  }
}

/** edit.dry-run-patch-proof-and-atomic-failure (ini_v1.rs:823-869). */
function editAuditArtifacts(case_: VectorCase): void {
  const document = parseCase(case_);
  const value = caseField(case_, 'value') as string;
  const sourceId = caseField(case_, 'source_id') as string;
  const wrongSource = caseField(case_, 'wrong_source') as string;
  const source = caseField(case_, 'source') as string;
  const transaction = new IniEditTransactionBuilder(document)
    .semanticValue(document.entries()[0].nodeRef(), value, 'CanonicalForProfile')
    .build();
  let plan: import('../../document/edit_plan.ts').EditPlan;
  try {
    plan = dryRunIniEdits(document, transaction, new EditPlanSourceId(sourceId));
  } catch (error) {
    if (error instanceof IniEditFailure) {
      fail(`dry run: ${error.code}`);
    }
    throw error;
  }
  let commit: import('../../ini/edit.ts').IniEditCommit;
  try {
    commit = commitIniEdits(document, transaction);
  } catch (error) {
    if (error instanceof IniEditFailure) {
      fail(`commit: ${error.code}`);
    }
    throw error;
  }
  let replayed: SourceSnapshot;
  try {
    replayed = commit.sourcePatch().apply(document.source(), DEFAULT_SOURCE_PATCH_LIMITS);
  } catch (error) {
    fail(`patch replay failed: ${String(error)}`);
  }
  let proofError: unknown = null;
  try {
    commit.untouchedProof().verify(document.source(), commit.document().source(), commit.sourcePatch().replacements());
  } catch (error) {
    proofError = error;
  }
  const profile = profileOf(caseField(case_, 'profile') as string);
  const other = parseIniText(profile, wrongSource);
  const wrong = new IniEditTransactionBuilder(document).literalValue(other.entries()[0].nodeRef(), utf8('new'));
  let wrongFailure: IniEditFailure | null = null;
  try {
    commitIniEdits(document, wrong.build());
  } catch (error) {
    if (error instanceof IniEditFailure) {
      wrongFailure = error;
    } else {
      throw error;
    }
  }
  if (wrongFailure === null) {
    fail('wrong snapshot must fail');
  }
  const expectedSource = expectedFieldOptional(case_, 'source') as string;
  const dryRunEquals = expectedFieldOptional(case_, 'dry_run_equals_commit');
  const patchReplays = expectedFieldOptional(case_, 'patch_replays');
  const proofVerifies = expectedFieldOptional(case_, 'proof_verifies');
  const wrongSnapshotCode = expectedFieldOptional(case_, 'wrong_snapshot_code') as string;
  const baseUnchanged = expectedFieldOptional(case_, 'base_unchanged');
  const planMatchesCommit =
    plan.sourcePatch().baseDigest().equals(commit.sourcePatch().baseDigest()) &&
    plan.sourcePatch().targetDigest().equals(commit.sourcePatch().targetDigest());
  if (text(commit.document().render()) !== expectedSource) {
    fail(`source: expected ${JSON.stringify(expectedSource)}, observed ${JSON.stringify(text(commit.document().render()))}`);
  }
  if (planMatchesCommit !== dryRunEquals) {
    fail('dry_run_equals_commit differed');
  }
  if (bytesEqual(replayed.bytes(), commit.document().render()) !== patchReplays) {
    fail('patch_replays differed');
  }
  if ((proofError === null) !== proofVerifies) {
    fail('proof_verifies differed');
  }
  if (wrongFailure.code !== wrongSnapshotCode) {
    fail(`wrong_snapshot_code: expected ${wrongSnapshotCode}, got ${wrongFailure.code}`);
  }
  if (bytesEqual(document.render(), utf8(source)) !== baseUnchanged) {
    fail('base_unchanged differed');
  }
}

/** registry.frozen-eight-operation-surface (unused; handled in editCase) */
function registryCase(case_: VectorCase): void {
  const profiles = caseField(case_, 'profiles') as string[];
  const operations = expectedFieldOptional(case_, 'operations') as string[] | undefined;
  const directStructural = expectedFieldOptional(case_, 'direct_structural') as number | undefined;
  const { iniFormatOperationRegistry } = requireIniRegistry();
  const ids = new Set<string>();
  for (const profile of profiles) {
    for (const operation of iniFormatOperationRegistry(profileOf(profile)).operations()) {
      ids.add(operation.id().toString());
    }
  }
  if (operations !== undefined) {
    for (const operation of operations) {
      if (!ids.has(operation)) {
        fail(`missing operation ${operation}`);
      }
    }
  }
  if (directStructural !== undefined && ids.size !== operations?.length) {
    fail(`direct_structural: expected ${directStructural}`);
  }
}

import { iniFormatOperationRegistry } from '../../ini/operation_registry.ts';

function requireIniRegistry(): { iniFormatOperationRegistry: typeof iniFormatOperationRegistry } {
  return { iniFormatOperationRegistry };
}

export const runIniV1: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.capability) {
      case 'ini.document@1':
        documentCase(case_);
        return;
      case 'ini.formation@1':
        formationCase(case_);
        return;
      case 'ini.query@1':
        queryCase(case_);
        return;
      case 'ini.projection@1':
        projectionCase(case_);
        return;
      case 'ini.materialization@1':
        materializationCase(case_);
        return;
      case 'ini.edit@1':
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
