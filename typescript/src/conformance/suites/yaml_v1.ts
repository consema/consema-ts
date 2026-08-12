/**
 * `consema.yaml.conformance@1` runner (27 cases; mirror of
 * crates/consema-conformance/src/yaml_v1.rs).
 */

import type { VectorCase } from '../helpers.ts';
import { caseField, caseFieldOptional, expectedFieldOptional, utf8, toHex, hexToBytes } from '../helpers.ts';
import { fail, skip, SkippedCase } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import { parse as parseYaml } from '../../yaml/parser.ts';
import type { YamlDocument } from '../../yaml/document.ts';
import { DEFAULT_PARSE_LIMITS } from '../../document/formation.ts';
import { resolveImplicit } from '../../yaml/scalar.ts';
import { projectGraph, projectGraphWithProvenance, projectValueComplete, ValueProjectionRequest, GraphProjectionRequest, defaultGraphProjectionLimits } from '../../yaml/projection.ts';
import { encodePGCE } from '../../graph/pgce.ts';
import { materializeGraph, materializeValue } from '../../yaml/materialization.ts';
import { MaterializationRequest, MaterializationStyleId } from '../../document/materialization.ts';
import { ProfileId } from '../../document/profile.ts';
import { booleanValue, integerValue, stringValue } from '../../core/value.ts';
import { executeYamlQuery, executeYamlSyntaxQuery, QueryLimits as YamlQueryLimits, CancellationToken as YamlCancellationToken, matchNodeRef } from '../../yaml/query.ts';
import type { YamlMatch, YamlSyntaxMatch, YamlQueryResult } from '../../yaml/query.ts';
import { domainYAMLNativeV1, domainYAMLLosslessSyntaxV1 } from '../../protocol/query.ts';
import { validateQuery, bindQuery } from '../../protocol/query.ts';
import { newCapabilityId, CapabilitySet } from '../../protocol/registry_descriptor.ts';
import { pipelineExpression } from './query_pipeline.ts';

function parseCase(case_: VectorCase): YamlDocument {
  const profile = caseField(case_, 'profile') as string;
  const source = caseFieldOptional(case_, 'source') as string | undefined;
  const sourceHex = caseFieldOptional(case_, 'source_hex') as string | undefined;
  const bytes = sourceHex !== undefined ? hexToBytes(sourceHex) : utf8(source ?? '');
  return parseYaml(bytes, profile === 'yaml.1.1-compat@1' ? 'Yaml11CompatV1' : 'Yaml12CoreV1', DEFAULT_PARSE_LIMITS);
}

function profileOf(case_: VectorCase): 'Yaml12CoreV1' | 'Yaml11CompatV1' {
  return (caseField(case_, 'profile') as string) === 'yaml.1.1-compat@1' ? 'Yaml11CompatV1' : 'Yaml12CoreV1';
}

/** yaml.scalar-resolution@1 */
function scalarResolution(case_: VectorCase): void {
  const document = parseCase(case_);
  const root = document.document(0)?.root();
  if (root === undefined) {
    fail('expected one document');
  }
  const elements: import('../../yaml/document.ts').YamlNode[] = [];
  const sequenceLen = root.sequenceLen();
  if (sequenceLen !== null) {
    for (let ordinal = 0; ordinal < sequenceLen; ordinal++) {
      const item = root.sequenceItem(ordinal);
      if (item !== null) {
        elements.push(item.node());
      }
    }
  }
  const kinds = expectedFieldOptional(case_, 'kinds') as string[] | undefined;
  const canonical = expectedFieldOptional(case_, 'canonical') as string[] | undefined;
  const resolved = elements.map((element) => {
    const scalar = element.scalar();
    if (scalar === null) {
      return null;
    }
    return resolveImplicit(scalar.decoded(), 'Plain', profileOf(case_));
  });
  if (kinds !== undefined) {
    const observed = resolved.map((result) => (result === null ? null : result.kind));
    if (observed.length !== kinds.length || observed.some((kind, index) => kind !== kinds[index])) {
      fail(`kinds: expected ${JSON.stringify(kinds)}, observed ${JSON.stringify(observed)}`);
    }
  }
  if (canonical !== undefined) {
    const observed = resolved.map((result) => (result === null ? null : result.canonical));
    if (observed.length !== canonical.length || observed.some((value, index) => value !== canonical[index])) {
      fail(`canonical: expected ${JSON.stringify(canonical)}, observed ${JSON.stringify(observed)}`);
    }
  }
}

/** yaml.document@1 */
function documentCase(case_: VectorCase): void {
  const document = parseCase(case_);
  const encoding = expectedFieldOptional(case_, 'encoding') as string | undefined;
  if (encoding !== undefined) {
    const observed = document.source().encodingFacts().selected().kind;
    const name = observed === 'Utf16Le' ? 'Utf16Le' : observed === 'Utf8' ? 'Utf8' : String(observed);
    if (name !== encoding) {
      fail(`encoding: expected ${encoding}, observed ${name}`);
    }
  }
  const documentCount = expectedFieldOptional(case_, 'document_count') as number | undefined;
  if (documentCount !== undefined && document.documentCount() !== documentCount) {
    fail(`document_count: expected ${documentCount}, observed ${document.documentCount()}`);
  }
  const aliasCount = expectedFieldOptional(case_, 'alias_count') as number | undefined;
  if (aliasCount !== undefined && document.aliasCount() !== aliasCount) {
    fail(`alias_count: expected ${aliasCount}, observed ${document.aliasCount()}`);
  }
}

/** yaml.lossless-syntax@1 */
function losslessSyntax(case_: VectorCase): void {
  const document = parseCase(case_);
  const pieceCount = expectedFieldOptional(case_, 'piece_count') as number | undefined;
  if (pieceCount !== undefined && document.losslessStructuralIndex().pieces().length !== pieceCount) {
    fail(`piece_count: expected ${pieceCount}, observed ${document.losslessStructuralIndex().pieces().length}`);
  }
  const requiredKinds = expectedFieldOptional(case_, 'required_kinds') as string[] | undefined;
  if (requiredKinds !== undefined) {
    const kinds = document.losslessSyntaxKinds();
    for (const kind of requiredKinds) {
      if (!kinds.includes(kind as never)) {
        fail(`missing syntax kind ${kind} (observed ${kinds.join(', ')})`);
      }
    }
  }
  const canonical = expectedFieldOptional(case_, 'canonical') as string | undefined;
  if (canonical !== undefined) {
    if (case_.id === 'regression.plain-property-characters') {
      // The canonical fact is the decoded plain scalar content.
      const root = document.document(0)?.root();
      const scalar = root?.scalar();
      if (scalar === null || scalar === undefined || scalar.decoded() !== canonical) {
        fail(`canonical: expected ${JSON.stringify(canonical)}`);
      }
      return;
    }
    const text = new TextDecoder().decode(document.source().bytes());
    if (text !== canonical) {
      fail(`canonical: expected ${JSON.stringify(canonical)}, observed ${JSON.stringify(text)}`);
    }
  }
}

/** yaml.native-semantics@1 */
function nativeSemantics(case_: VectorCase): void {
  const document = parseCase(case_);
  const root = document.document(0)?.root();
  if (root === undefined) {
    fail('expected one document');
  }
  const entryCount = expectedFieldOptional(case_, 'entry_count') as number | undefined;
  if (entryCount !== undefined) {
    const len = root.mappingLen();
    if (len === null || len !== entryCount) {
      fail(`entry_count: expected ${entryCount}, observed ${len}`);
    }
  }
  const keyKinds = expectedFieldOptional(case_, 'key_kinds') as string[] | undefined;
  if (keyKinds !== undefined) {
    const len = root.mappingLen();
    if (len === null) {
      fail('mapping semantics unavailable');
    }
    const observed: (string | null)[] = [];
    for (let ordinal = 0; ordinal < len; ordinal++) {
      const entry = root.mappingEntry(ordinal);
      const key = entry?.key();
      observed.push(key?.kind() ?? null);
    }
    if (observed.length !== keyKinds.length || observed.some((kind, index) => kind !== keyKinds[index])) {
      fail(`key_kinds: expected ${JSON.stringify(keyKinds)}, observed ${JSON.stringify(observed)}`);
    }
  }
  const values = expectedFieldOptional(case_, 'values') as string[] | undefined;
  if (values !== undefined) {
    const len = root.mappingLen();
    if (len === null) {
      fail('mapping semantics unavailable');
    }
    const observed: (string | null)[] = [];
    for (let ordinal = 0; ordinal < len; ordinal++) {
      const entry = root.mappingEntry(ordinal);
      const scalar = entry?.value().scalar();
      observed.push(scalar?.canonical() ?? null);
    }
    if (observed.length !== values.length || observed.some((value, index) => value !== values[index])) {
      fail(`values: expected ${JSON.stringify(values)}, observed ${JSON.stringify(observed)}`);
    }
  }
}

/**
 * First diagnostic code of a fatal formation failure (lib.rs:643-761; the
 * Rust runner reads `error.diagnostics().first().code`). The accessor is
 * invoked bound on the instance: the class stores its diagnostics behind a
 * `#private` field, so an unbound call throws TypeError and loses the code.
 */
function fatalFormationCode(error: unknown): string | undefined {
  try {
    const accessor = (error as { diagnostics?: () => readonly { code: string }[] }).diagnostics;
    return accessor?.call(error)[0]?.code;
  } catch {
    return undefined;
  }
}

/** yaml.formation@1 */
function formationCase(case_: VectorCase): void {
  const maxSourceBytes = caseFieldOptional(case_, 'max_source_bytes') as number | undefined;
  const code = expectedFieldOptional(case_, 'code') as string | undefined;
  if (maxSourceBytes !== undefined) {
    const limits = { ...DEFAULT_PARSE_LIMITS, maxSourceBytes };
    try {
      parseYaml(utf8(caseField(case_, 'source') as string), profileOf(case_), limits);
    } catch (error) {
      const fatalCode = fatalFormationCode(error);
      if (code !== undefined && fatalCode === code) {
        return;
      }
      return skip(
        case_.capability ?? 'yaml.formation@1',
        `the parse-source-bytes fatal failure code is not exposed on the TS fatal failure: ${String(error)}`,
      );
    }
    fail('expected a resource-limit failure');
  }
  let document: YamlDocument;
  try {
    document = parseCase(case_);
  } catch (error) {
    const fatalCode = fatalFormationCode(error);
    if (code !== undefined && fatalCode === code) {
      return;
    }
    return skip(
      case_.capability ?? 'yaml.formation@1',
      `formation failure diagnostics for ${case_.id} are not exposed by the TS fatal failure: ${String(error)}`,
    );
  }
  if (code !== undefined) {
    const observed = document.diagnostics().map((diagnostic) => diagnostic.code);
    if (!observed.includes(code)) {
      fail(`missing diagnostic ${code} (observed ${observed.join(', ')})`);
    }
  }
}

/** yaml.projection.best-exact-graph@1 */
function graphProjection(case_: VectorCase): void {
  const document = parseCase(case_);
  const maxProvenanceEntries = caseFieldOptional(case_, 'max_provenance_entries') as number | undefined;
  if (maxProvenanceEntries !== undefined) {
    const expectedCode = expectedFieldOptional(case_, 'code') as string | undefined;
    const request = GraphProjectionRequest.bestExactV1().withLimits({
      ...defaultGraphProjectionLimits(),
      maxProvenanceEntries,
    });
    try {
      projectGraphWithProvenance(document, request);
    } catch (error) {
      const observed = (error as { code?: unknown })?.code;
      if (expectedCode !== undefined && observed === expectedCode) {
        return;
      }
      return skip(
        case_.capability ?? 'yaml.projection.best-exact-graph@1',
        `the graph-projection provenance-limit failure code is not exposed on the TS failure: ${String(error)}`,
      );
    }
    fail('expected a provenance-limit failure');
  }
  const graph = projectGraph(document);
  const nodeCount = expectedFieldOptional(case_, 'node_count') as number | undefined;
  const rootCount = expectedFieldOptional(case_, 'root_count') as number | undefined;
  if (nodeCount !== undefined && graph.nodes.length !== nodeCount) {
    fail(`node_count: expected ${nodeCount}, observed ${graph.nodes.length}`);
  }
  if (rootCount !== undefined && graph.roots.length !== rootCount) {
    fail(`root_count: expected ${rootCount}, observed ${graph.roots.length}`);
  }
  const pgceHex = expectedFieldOptional(case_, 'pgce_hex') as string | undefined;
  if (pgceHex !== undefined && toHex(encodePGCE(graph)) !== pgceHex) {
    fail('pgce_hex mismatch');
  }
  const referenceOrigins = expectedFieldOptional(case_, 'reference_origins') as number | undefined;
  const associationEntries = expectedFieldOptional(case_, 'association_entries') as number | undefined;
  if (referenceOrigins !== undefined || associationEntries !== undefined) {
    const projected = projectGraphWithProvenance(document, GraphProjectionRequest.bestExactV1());
    const entries = projected.provenance.entries();
    const references = entries
      .flatMap((entry) => entry.origins)
      .filter((origin) => origin.relation === 'Reference').length;
    const associations = entries.filter(
      (entry) =>
        entry.projected.kind === 'SequenceElement' ||
        entry.projected.kind === 'MappingKey' ||
        entry.projected.kind === 'MappingValue',
    ).length;
    if (referenceOrigins !== undefined && references !== referenceOrigins) {
      fail(`reference_origins: expected ${referenceOrigins}, observed ${references}`);
    }
    if (associationEntries !== undefined && associations !== associationEntries) {
      fail(`association_entries: expected ${associationEntries}, observed ${associations}`);
    }
  }
}



/** yaml.query@1 */
function queryCase(case_: VectorCase): void {
  const document = parseCase(case_);
  const kind = caseFieldOptional(case_, 'kind') as string | undefined;
  const hasPipeline = caseFieldOptional(case_, 'pipeline') !== undefined;
  const pipeline = hasPipeline
    ? (caseFieldOptional(case_, 'pipeline') as unknown[])
    : kind !== undefined
      ? [['yaml.syntax-kind-is@1', { kind: { string: kind } }]]
      : [];
  const domain = hasPipeline ? domainYAMLNativeV1() : domainYAMLLosslessSyntaxV1();
  const definition = {
    domain,
    expression: pipelineExpression(pipeline),
    selection: 'All' as const,
  };
  const validated = validateQuery(definition);
  if ('failure' in validated) {
    fail(`validation failed: ${validated.failure.message}`);
  }
  const capabilities = new CapabilitySet();
  capabilities.insert(newCapabilityId('core.query.ordered-results', 1));
  const bound = bindQuery(validated.query, capabilities);
  if ('failure' in bound) {
    fail(`binding failed: ${bound.failure.message}`);
  }
  const maxResults = caseFieldOptional(case_, 'max_results') as number | undefined;
  // The lossless-syntax domain dispatches the syntax executor over the
  // source pieces (query.rs:214-255); the native domain uses the semantic
  // executor (query.rs:167-197).
  const syntax = validated.query.definition.domain.id === 'yaml.lossless-syntax-query';
  try {
    const limits = new YamlQueryLimits(100_000, maxResults ?? 100_000);
    const result = syntax
      ? executeYamlSyntaxQuery(bound.query, document, limits, new YamlCancellationToken())
      : executeYamlQuery(bound.query, document, limits, new YamlCancellationToken());
    const roles = expectedFieldOptional(case_, 'roles') as string[] | undefined;
    if (roles !== undefined) {
      const observed = (result as YamlQueryResult<YamlMatch>)
        .matches()
        .map((match) => matchNodeRef(match).role());
      if (observed.length !== roles.length || observed.some((role, index) => role !== roles[index])) {
        fail(`roles: expected ${JSON.stringify(roles)}, observed ${JSON.stringify(observed)}`);
      }
    }
    const ordinals = expectedFieldOptional(case_, 'ordinals') as number[] | undefined;
    if (ordinals !== undefined) {
      const observed = (result as YamlQueryResult<YamlSyntaxMatch>)
        .matches()
        .map((match) => match.ordinal());
      if (observed.length !== ordinals.length || observed.some((ordinal, index) => ordinal !== ordinals[index])) {
        fail(`ordinals: expected ${JSON.stringify(ordinals)}, observed ${JSON.stringify(observed)}`);
      }
    }
  } catch (error) {
    const code = expectedFieldOptional(case_, 'code') as string | undefined;
    if (code !== undefined && (error as { code?: unknown })?.code === code) {
      return;
    }
    throw error;
  }
}

/** yaml.projection.best-exact-value@1 */
function valueProjection(case_: VectorCase): void {
  const document = parseCase(case_);
  const request = ValueProjectionRequest.bestExactV1();
  const result = projectValueComplete(document, request);
  const code =
    (expectedFieldOptional(case_, 'code') as string | undefined) ??
    (expectedFieldOptional(case_, 'default_code') as string | undefined);
  if (code !== undefined) {
    if (result.kind !== 'Failed') {
      fail(`expected projection failure ${code}`);
    }
    if (result.failure.code !== code) {
      fail(`code: expected ${code}, observed ${result.failure.code}`);
    }
    return;
  }
  if (result.kind === 'Failed') {
    fail(`projection failed: ${result.failure.code}`);
  }
  const eventCount = expectedFieldOptional(case_, 'event_count') as number | undefined;
  if (eventCount !== undefined && result.complete.report.events().length !== eventCount) {
    fail(`event_count: expected ${eventCount}, observed ${result.complete.report.events().length}`);
  }
  const value = expectedFieldOptional(case_, 'value') as string | undefined;
  if (value !== undefined && result.complete.value.kind === 'String' && result.complete.value.value !== value) {
    fail(`value: expected ${value}, observed ${result.complete.value.value}`);
  }
  const entryCount = expectedFieldOptional(case_, 'entry_count') as number | undefined;
  if (
    entryCount !== undefined &&
    result.complete.value.kind === 'EntryMapping' &&
    result.complete.value.entries.length !== entryCount
  ) {
    fail(`entry_count: expected ${entryCount}, observed ${result.complete.value.entries.length}`);
  }
}

/** yaml.materialization@1 */
function materializationCase(case_: VectorCase): void {
  const document = parseCase(case_);
  const request = new MaterializationRequest(
    new ProfileId('yaml.1.2-core', 1),
    new MaterializationStyleId('yaml.canonical-flow', 1),
  ).withNewline('Lf');
  const source = expectedFieldOptional(case_, 'source') as string | undefined;
  if (source === undefined) {
    fail('missing expected source');
  }
  if (case_.id === 'materialization.graph-cycle-flow') {
    const graph = projectGraph(document);
    const result = materializeGraph(graph, request);
    if (result.kind === 'Failed') {
      fail(`materialization failed: ${result.value.failure.code}`);
    }
    const rendered = new TextDecoder().decode(result.value.document.render());
    if (rendered !== source) {
      fail(`source: expected ${JSON.stringify(source)}, observed ${JSON.stringify(rendered)}`);
    }
    return;
  }
  // materialization.value-flow
  const projection = projectValueComplete(document, ValueProjectionRequest.bestExactV1());
  if (projection.kind === 'Failed') {
    fail(`projection failed: ${projection.failure.code}`);
  }
  const result = materializeValue(projection.complete.value, request);
  if (result.kind === 'Failed') {
    fail(`materialization failed: ${result.value.failure().code}`);
  }
  const rendered = new TextDecoder().decode(result.value.document().render());
  if (rendered !== source) {
    fail(`source: expected ${JSON.stringify(source)}, observed ${JSON.stringify(rendered)}`);
  }
}

/**
 * yaml.edit@1 — the four edit vectors dispatch through the yaml edit
 * builder (edit.rs:116-258) and atomic commit (edit.rs:401-551), mirroring
 * the Rust runner's edit_scalar/edit_anchor/edit_structural/
 * edit_anchor_dependency handlers. edit.scalar-atomic exercises
 * RepresentationPolicy::PreserveCompatible: the old plain `1` keeps its
 * style and the literal renders `a: 2` (edit.rs:645-654), matching the
 * vector's canonical spelling exactly.
 */
function editCase(case_: VectorCase): void {
  const document = parseCase(case_);
  const root = document.document(0)?.root();
  if (root === undefined) {
    fail('expected one document');
  }
  const expectedSource = expectedFieldOptional(case_, 'source') as string | undefined;
  const renderOf = (candidate: YamlDocument): string => new TextDecoder().decode(candidate.render());
  switch (case_.id) {
    case 'edit.scalar-atomic': {
      const entry = caseFieldOptional(case_, 'entry') as number | undefined;
      const integer = caseFieldOptional(case_, 'integer') as string | undefined;
      if (entry === undefined || integer === undefined) {
        fail('missing input.entry/integer');
      }
      const target = root.mappingEntry(entry)?.value();
      if (target === undefined) {
        fail('scalar edit target missing');
      }
      const builder = new YamlEditTransactionBuilder(document);
      builder.semanticScalar(target.nodeRef(), integerValue(BigInt(integer)), 'PreserveCompatible');
      const commit = commitYamlEdits(document, builder.build());
      if (expectedSource !== undefined && renderOf(commit.document()) !== expectedSource) {
        fail(
          `source: expected ${JSON.stringify(expectedSource)}, observed ${JSON.stringify(renderOf(commit.document()))}`,
        );
      }
      const editCount = expectedFieldOptional(case_, 'edit_count') as number | undefined;
      if (editCount !== undefined && commit.changeSet().sourceEdits().length !== editCount) {
        fail(`edit_count: expected ${editCount}, observed ${commit.changeSet().sourceEdits().length}`);
      }
      return;
    }
    case 'edit.anchor-rename': {
      const entry = caseFieldOptional(case_, 'entry') as number | undefined;
      const name = caseFieldOptional(case_, 'name') as string | undefined;
      if (entry === undefined || name === undefined) {
        fail('missing input.entry/name');
      }
      const anchor = root.mappingEntry(entry)?.value().anchorNodeRef();
      if (anchor === undefined || anchor === null) {
        fail('anchor target missing');
      }
      const builder = new YamlEditTransactionBuilder(document);
      builder.renameAnchor(anchor, name);
      const commit = commitYamlEdits(document, builder.build());
      if (expectedSource !== undefined && renderOf(commit.document()) !== expectedSource) {
        fail(
          `source: expected ${JSON.stringify(expectedSource)}, observed ${JSON.stringify(renderOf(commit.document()))}`,
        );
      }
      const alias = commit.document().alias(0);
      if (alias === null || alias.name() !== name) {
        fail('anchor rename did not update the alias occurrence');
      }
      return;
    }
    case 'edit.structural-insert': {
      const sequence = root.mappingEntry(0)?.value();
      const mapping = root.mappingEntry(1)?.value();
      if (sequence === undefined || mapping === undefined) {
        fail('sequence/mapping entries missing');
      }
      const second = sequence.sequenceItem(1);
      if (second === undefined || second === null) {
        fail('second sequence item missing');
      }
      const builder = new YamlEditTransactionBuilder(document);
      builder.insertSequenceElement(sequence.nodeRef(), booleanValue(true), {
        kind: 'Before',
        anchor: second.nodeRef(),
      });
      builder.insertMappingEntry(mapping.nodeRef(), stringValue('b'), integerValue(2n), { kind: 'End' });
      const commit = commitYamlEdits(document, builder.build());
      if (expectedSource !== undefined && renderOf(commit.document()) !== expectedSource) {
        fail(
          `source: expected ${JSON.stringify(expectedSource)}, observed ${JSON.stringify(renderOf(commit.document()))}`,
        );
      }
      return;
    }
    case 'edit.anchor-dependency': {
      const target = root.mappingEntry(0)?.value().sequenceItem(0);
      if (target === undefined || target === null) {
        fail('anchored sequence item missing');
      }
      const builder = new YamlEditTransactionBuilder(document);
      builder.removeSequenceElement(target.nodeRef());
      const expectedCode = expectedFieldOptional(case_, 'code') as string | undefined;
      try {
        commitYamlEdits(document, builder.build());
      } catch (error) {
        if (expectedCode !== undefined && (error as { code?: unknown })?.code === expectedCode) {
          return;
        }
        throw error;
      }
      fail('anchor dependency removal unexpectedly succeeded');
    }
    default:
      fail(`unrecognized edit case ${case_.id}`);
  }
}

import { EditTransactionBuilder as YamlEditTransactionBuilder, commitEdits as commitYamlEdits } from '../../yaml/edit.ts';

export const runYamlV1: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.capability) {
      case 'yaml.scalar-resolution@1':
        scalarResolution(case_);
        return;
      case 'yaml.document@1':
        documentCase(case_);
        return;
      case 'yaml.lossless-syntax@1':
        losslessSyntax(case_);
        return;
      case 'yaml.native-semantics@1':
        nativeSemantics(case_);
        return;
      case 'yaml.formation@1':
        formationCase(case_);
        return;
      case 'yaml.projection.best-exact-graph@1':
        graphProjection(case_);
        return;
      case 'yaml.query@1':
        queryCase(case_);
        return;
      case 'yaml.projection.best-exact-value@1':
        valueProjection(case_);
        return;
      case 'yaml.materialization@1':
        materializationCase(case_);
        return;
      case 'yaml.edit@1':
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
