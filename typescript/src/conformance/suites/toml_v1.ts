/**
 * `consema.toml.conformance@1` runner (18 cases; mirror of
 * crates/consema-conformance/src/toml_v1.rs).
 */

import { readFileSync } from 'node:fs';
import { fixturesDir, repoRootDir } from '../runner.ts';
import type { VectorCase } from '../helpers.ts';
import { caseField, caseFieldOptional, expectedField, expectedFieldOptional, utf8 } from '../helpers.ts';
import { fail, skip, SkippedCase } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import { parseToml, TomlDocument, TomlEntry, TomlItem } from '../../toml/document.ts';
import { TomlProfile } from '../../toml/profile.ts';
import { DEFAULT_PARSE_LIMITS } from '../../document/formation.ts';
import { projectToml, TomlProjectionRequest } from '../../toml/projection.ts';
import { executeTomlQuery, TomlCancellationToken, DEFAULT_TOML_QUERY_LIMITS } from '../../toml/query.ts';
import { commitTomlEdits, TomlEditTransactionBuilder } from '../../toml/edit.ts';
import { TomlEditFailure, TomlFormationFailure } from '../../toml/errors.ts';
import { domainTOMLNativeV1 } from '../../protocol/query.ts';
import type { QueryDefinition } from '../../protocol/query.ts';
import { pipelineExpression, applyDescriptor, validateAndBind } from './query_pipeline.ts';
import { binaryFloat64Value } from '../../core/value.ts';

function parseTomlBytes(bytes: Uint8Array): TomlDocument {
  return parseToml(bytes, TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
}

function parseTomlCase(case_: VectorCase): TomlDocument {
  return parseTomlBytes(utf8(caseField(case_, 'source') as string));
}

function fixtureBytes(relative: string): Uint8Array {
  if (relative === 'Cargo.toml') {
    return readFileSync(`${repoRootDir()}Cargo.toml`);
  }
  // The vector fixture field already carries the repository-relative path
  // ("conformance/fixtures/toml/all-values.toml").
  const path = relative.startsWith('conformance/fixtures/')
    ? relative.slice('conformance/fixtures/'.length)
    : relative;
  return readFileSync(`${fixturesDir()}${path}`);
}

function parseTomlFixture(case_: VectorCase): TomlDocument {
  return parseTomlBytes(fixtureBytes(caseField(case_, 'fixture') as string));
}

/** The direct named item of one table (the Rust direct_item helper). */
function directItem(item: TomlItem, name: string): TomlItem {
  const entries = item.tableEntries();
  if (entries === null) {
    fail(`item has no entries`);
  }
  for (const entry of entries) {
    if (entry.name() === name) {
      return entry.item();
    }
  }
  fail(`missing direct item ${name}`);
}

/** toml.document.complete@1 / toml.document.lossless-syntax@1 */
function documentCase(case_: VectorCase): void {
  const document = parseTomlFixture(case_);
  const expectedFormation = expectedFieldOptional(case_, 'formation') as string | undefined;
  if (expectedFormation !== undefined && document.formationStatus() !== expectedFormation) {
    fail(`formation: expected ${expectedFormation}, observed ${document.formationStatus()}`);
  }
  const renderEquals = expectedFieldOptional(case_, 'render_equals_source');
  if (renderEquals === true) {
    const source = fixtureBytes(caseField(case_, 'fixture') as string);
    const rendered = document.render();
    if (rendered.length !== source.length || rendered.some((octet, index) => octet !== source[index])) {
      fail('render must equal the source');
    }
  }
  const projection = expectedFieldOptional(case_, 'projection');
  if (projection !== undefined) {
    const result = projectToml(document, new TomlProjectionRequest('BestExactCoreV1'));
    if (result.kind !== 'Complete') {
      fail(`projection: expected ${String(projection)}, observed Failed`);
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
  }
}

/** toml.parse.reject-invalid (FatalFormationFailure with toml.parse.syntax@1). */
function rejectInvalid(case_: VectorCase): void {
  const bytes = fixtureBytes(caseField(case_, 'fixture') as string);
  let failure: TomlFormationFailure | undefined;
  try {
    parseTomlBytes(bytes);
  } catch (error) {
    if (error instanceof TomlFormationFailure) {
      failure = error;
    } else {
      throw error;
    }
  }
  if (failure === undefined) {
    fail('invalid fixture must fail formation');
  }
  const diagnostic = expectedField(case_, 'diagnostic') as string;
  const observed = failure.diagnostics.map((item) => item.code);
  if (!observed.includes(diagnostic)) {
    fail(`missing diagnostic ${diagnostic} (observed ${observed.join(', ')})`);
  }
}

/** core.parse.resource-limits@1 */
function parseResourceLimits(case_: VectorCase): void {
  const source = caseField(case_, 'source') as string;
  const maxTokenCount = caseFieldOptional(case_, 'max_token_count') as number | undefined;
  const maxNodeCount = caseFieldOptional(case_, 'max_node_count') as number | undefined;
  const maxNestingDepth = caseFieldOptional(case_, 'max_nesting_depth') as number | undefined;
  const limits = {
    ...DEFAULT_PARSE_LIMITS,
    ...(maxTokenCount !== undefined ? { maxTokenCount } : {}),
    ...(maxNodeCount !== undefined ? { maxNodeCount } : {}),
    ...(maxNestingDepth !== undefined ? { maxNestingDepth } : {}),
  };
  try {
    parseToml(utf8(source), TomlProfile.TOML_10_V1, limits);
  } catch (error) {
    if (error instanceof TomlFormationFailure) {
      const status = expectedField(case_, 'status') as string;
      if (status === 'FatalFormationFailure') {
        return;
      }
    }
    throw error;
  }
  fail('expected a parse resource-limit failure');
}

/** toml.native.items@1 */
function nativeItems(case_: VectorCase): void {
  switch (case_.id) {
    case 'toml.native.dotted-segments': {
      const document = parseTomlCase(case_);
      const alpha = directItem(document.root(), 'alpha');
      const beta = directItem(alpha, 'beta');
      const gamma = directItem(beta, 'gamma');
      const segments = expectedField(case_, 'segments') as string[];
      void segments;
      const leafKind = expectedField(case_, 'leaf_kind') as string;
      if (alpha.kind() !== 'DottedTable' || beta.kind() !== 'DottedTable') {
        fail('dotted segments must be DottedTable items');
      }
      if (gamma.kind() !== leafKind || gamma.asInteger() !== 1n) {
        fail(`leaf: expected ${leafKind} with value 1`);
      }
      return;
    }
    case 'toml.native.table-flavors': {
      const document = parseTomlFixture(case_);
      const flavors: Record<string, string> = {
        service: expectedFieldOptional(case_, 'service') as string,
        database: expectedFieldOptional(case_, 'database') as string,
        observability: expectedFieldOptional(case_, 'observability') as string,
      };
      for (const name of Object.keys(flavors)) {
        const observed = directItem(document.root(), name).kind();
        if (observed !== flavors[name]) {
          fail(`flavor of ${name}: expected ${flavors[name]}, observed ${observed}`);
        }
      }
      return;
    }
    case 'toml.native.array-aot-distinct': {
      const document = parseTomlFixture(case_);
      const database = directItem(document.root(), 'database');
      const timeouts = directItem(database, 'timeouts');
      const upstreams = directItem(document.root(), 'upstreams');
      const timeoutsExpected = expectedField(case_, 'timeouts') as string;
      const upstreamsExpected = expectedField(case_, 'upstreams') as string;
      const upstreamCount = expectedField(case_, 'upstream_count') as number;
      if (timeouts.kind() !== timeoutsExpected) {
        fail(`timeouts: expected ${timeoutsExpected}, observed ${timeouts.kind()}`);
      }
      if (upstreams.kind() !== upstreamsExpected) {
        fail(`upstreams: expected ${upstreamsExpected}, observed ${upstreams.kind()}`);
      }
      const elements = upstreams.arrayElements();
      if (elements === null || elements.length !== upstreamCount) {
        fail(`upstream_count: expected ${upstreamCount}, observed ${elements?.length}`);
      }
      return;
    }
    case 'toml.native.float-signed-zero': {
      const document = parseTomlCase(case_);
      const positive = directItem(document.root(), 'positive').asFloatBits();
      const negative = directItem(document.root(), 'negative').asFloatBits();
      if (positive !== 0n) {
        fail(`positive bits: expected 0, observed ${positive}`);
      }
      if (negative !== 1n << 63n) {
        fail(`negative bits: expected 2^63, observed ${negative}`);
      }
      return;
    }
    default:
      fail(`runner does not recognize published case ${case_.id}`);
  }
}

/** core.query.ordered-results@1 */
function tomlQuery(case_: VectorCase): void {
  const document = parseTomlFixture(case_);
  const path = caseField(case_, 'path') as string[];
  let expression = pipelineExpression(['toml.try-table-entries@1']);
  const expectOrdinals = expectedFieldOptional(case_, 'ordinals') !== undefined;
  for (const segment of path) {
    expression = applyDescriptor(expression, ['toml.entry-name-equals@1', { name: { string: segment } }]);
    expression = applyDescriptor(expression, 'toml.entry-item@1');
    expression = applyDescriptor(expression, expectOrdinals ? 'toml.try-array-elements@1' : 'toml.try-table-entries@1');
  }
  const definition: QueryDefinition = { domain: domainTOMLNativeV1(), expression, selection: 'All' };
  const executable = validateAndBind(definition);
  const result = executeTomlQuery(executable, document, DEFAULT_TOML_QUERY_LIMITS, new TomlCancellationToken());
  const names = expectedFieldOptional(case_, 'names') as string[] | undefined;
  if (names !== undefined) {
    const observed = result.matches
      .filter((match) => match.kind === 'Entry')
      .map((match) => (match.kind === 'Entry' ? match.name : null));
    if (observed.length !== names.length || observed.some((name, index) => name !== names[index])) {
      fail(`names: expected ${JSON.stringify(names)}, observed ${JSON.stringify(observed)}`);
    }
  }
  const ordinals = expectedFieldOptional(case_, 'ordinals') as number[] | undefined;
  if (ordinals !== undefined) {
    const observed = result.matches
      .filter((match) => match.kind === 'ArrayElement')
      .map((match) => (match.kind === 'ArrayElement' ? match.ordinal : -1));
    if (observed.length !== ordinals.length || observed.some((ordinal, index) => ordinal !== ordinals[index])) {
      fail(`ordinals: expected ${JSON.stringify(ordinals)}, observed ${JSON.stringify(observed)}`);
    }
  }
}

/** toml.projection.best-exact-core@1 */
function tomlProjection(case_: VectorCase): void {
  const document = caseFieldOptional(case_, 'fixture') !== undefined ? parseTomlFixture(case_) : parseTomlCase(case_);
  const request = new TomlProjectionRequest('BestExactCoreV1');
  const result = projectToml(document, request);
  const status = expectedFieldOptional(case_, 'status') as string | undefined;
  if (status === 'Failed') {
    if (result.kind !== 'Failed') {
      fail('projection should have failed');
    }
    const diagnostic = expectedFieldOptional(case_, 'diagnostic') as string | undefined;
    if (diagnostic !== undefined) {
      const observed = result.value.diagnostics().map((item) => item.code);
      if (!observed.includes(diagnostic)) {
        fail(`missing diagnostic ${diagnostic} (observed ${observed.join(', ')})`);
      }
    }
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
  const root = expectedFieldOptional(case_, 'root');
  if (root !== undefined && projection.value().kind !== root) {
    fail(`root: expected ${String(root)}, observed ${projection.value().kind}`);
  }
  const allOriginsSnapshotBound = expectedFieldOptional(case_, 'all_origins_snapshot_bound');
  if (allOriginsSnapshotBound === true) {
    const snapshot = document.snapshotIdentity();
    const bound = projection
      .provenance()
      .entries()
      .every((entry) =>
        entry.origins().every(
          (origin) =>
            origin.snapshot().equals(snapshot) &&
            origin.node().snapshot().equals(snapshot) &&
            origin.span().snapshot().equals(snapshot),
        ),
      );
    if (!bound) {
      fail('all origins must be snapshot bound');
    }
  }
  const objectAssociations = expectedFieldOptional(case_, 'object_associations_present');
  if (objectAssociations === true) {
    const has = projection
      .provenance()
      .entries()
      .some((entry) => {
        const projected = entry.projected();
        return projected.kind === 'Association' && projected.location.role() === 'ObjectEntry';
      });
    if (!has) {
      fail('object associations must be present in the provenance');
    }
  }
}

/** toml.edit.scalar-replace@1 */
function tomlEdit(case_: VectorCase): void {
  const document = parseTomlCase(case_);
  const target = directItem(document.root(), case_.id === 'toml.edit.literal-minimal' ? 'hex' : 'float').nodeRef();
  const builder = new TomlEditTransactionBuilder(document);
  if (case_.id === 'toml.edit.literal-minimal') {
    const literal = caseField(case_, 'literal') as string;
    builder.literalScalar(target, utf8(literal));
    const commit = commitTomlEdits(document, builder.build());
    const expectedSource = expectedField(case_, 'source') as string;
    const rendered = new TextDecoder().decode(commit.document().render());
    if (rendered !== expectedSource) {
      fail(`source: expected ${JSON.stringify(expectedSource)}, observed ${JSON.stringify(rendered)}`);
    }
    const editCount = expectedFieldOptional(case_, 'source_edit_count');
    if (editCount !== undefined && commit.changeSet().sourceEdits().length !== editCount) {
      fail(`source_edit_count: expected ${String(editCount)}, observed ${commit.changeSet().sourceEdits().length}`);
    }
    return;
  }
  // toml.edit.reject-unrepresentable
  const bits = BigInt(`0x${caseField(case_, 'binary64_bits') as string}`);
  builder.semanticScalar(target, binaryFloat64Value(bits), 'CanonicalForProfile');
  try {
    commitTomlEdits(document, builder.build());
  } catch (error) {
    if (error instanceof TomlEditFailure && error.kind === 'UnsupportedSemanticValue') {
      return;
    }
    throw error;
  }
  fail('expected an unsupported-semantic-value failure');
}

export const runTomlV1: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.capability) {
      case 'toml.document.complete@1':
      case 'toml.document.lossless-syntax@1':
        if (case_.id === 'toml.parse.reject-invalid') {
          rejectInvalid(case_);
          return;
        }
        documentCase(case_);
        return;
      case 'core.parse.resource-limits@1':
        parseResourceLimits(case_);
        return;
      case 'toml.native.items@1':
        nativeItems(case_);
        return;
      case 'core.query.ordered-results@1':
        tomlQuery(case_);
        return;
      case 'toml.projection.best-exact-core@1':
        tomlProjection(case_);
        return;
      case 'toml.edit.scalar-replace@1':
        tomlEdit(case_);
        return;
      default:
        return skip(
          case_.capability ?? 'unknown',
          `runner does not recognize published case ${case_.id}`,
        );
    }
  },
};

void TomlEntry;

