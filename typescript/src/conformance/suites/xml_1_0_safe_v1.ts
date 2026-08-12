/**
 * `consema.xml-1-0-safe.conformance@1` runner (34 cases; mirror of
 * crates/consema-conformance/src/xml_v1.rs). Dispatch is by the vector
 * `capability` field: formation, lossless syntax query, native semantic
 * query, element-tree projection, canonical materialization, the structural
 * edits, and formation-class limits.
 */

import type { VectorCase } from '../helpers.ts';
import {
  caseField,
  caseFieldOptional,
  expectedField,
  expectedFieldOptional,
  toHex,
  utf8,
  valueFromInput,
} from '../helpers.ts';
import { fail, SkippedCase } from './common.ts';
import type { SuiteExecutor } from '../runner.ts';
import type { PortableValue } from '../../core/value.ts';
import { stringValue } from '../../core/value.ts';
import type { NodeRef } from '../../document/identity.ts';
import { ProfileId } from '../../document/profile.ts';
import {
  MaterializationRequest,
  MaterializationStyleId,
} from '../../document/materialization.ts';
import type { SourceEncoding } from '../../document/source.ts';
import { parse } from '../../xml/parser.ts';
import type { XmlDocument } from '../../xml/document.ts';
import { DEFAULT_XML_PARSE_LIMITS, profileDefaultSelection } from '../../xml/profile.ts';
import type { XmlParseLimits } from '../../xml/profile.ts';
import {
  CancellationToken,
  QueryLimits,
  executeXmlQuery,
  executeXmlSyntaxQuery,
} from '../../xml/query.ts';
import { ProjectionRequest, project } from '../../xml/projection.ts';
import { materialize } from '../../xml/materialization.ts';
import { EditTransactionBuilder, NameFacts, commit as commitEdits } from '../../xml/edit.ts';
import type { AttributePlacement } from '../../xml/edit.ts';
import {
  bindQuery,
  domainXMLLosslessSyntaxV1,
  domainXMLNativeV1,
  newOperatorCall,
  validateQuery,
  withArgument,
} from '../../protocol/query.ts';
import type { OperatorCall, QueryDomain, QueryExpression } from '../../protocol/query.ts';
import { CapabilitySet, newCapabilityId } from '../../protocol/registry_descriptor.ts';

// ---------------------------------------------------------------------------
// Shared formation
// ---------------------------------------------------------------------------

/**
 * Parse limits from the vector limit spellings: the case-level
 * `amplification_ratio` and `max_mixed_content_items` fields, plus the
 * generic `limits`/`limit_name`/`limit_value` vocabulary
 * (xml_v1.rs parse_limits:133-149).
 */
function limitsFor(case_: VectorCase): XmlParseLimits {
  let limits: XmlParseLimits = { ...DEFAULT_XML_PARSE_LIMITS };
  const amplification = caseFieldOptional(case_, 'amplification_ratio') as number | undefined;
  if (amplification !== undefined) {
    limits = { ...limits, maxEntityAmplificationRatio: amplification };
  }
  const mixed = caseFieldOptional(case_, 'max_mixed_content_items') as number | undefined;
  if (mixed !== undefined) {
    limits = { ...limits, maxMixedContentItems: mixed };
  }
  const limitsField = caseFieldOptional(case_, 'limits') as Record<string, number> | undefined;
  if (limitsField !== undefined) {
    for (const key of Object.keys(limitsField)) {
      limits = {
        ...limits,
        [snakeToCamel(key)]: limitsField[key],
      } as XmlParseLimits;
    }
  }
  const limitName = caseFieldOptional(case_, 'limit_name') as string | undefined;
  const limitValue = caseFieldOptional(case_, 'limit_value') as number | undefined;
  if (limitName !== undefined && limitValue !== undefined) {
    limits = {
      ...limits,
      [snakeToCamel(limitName)]: limitValue,
    } as XmlParseLimits;
  }
  return limits;
}

/**
 * Forms the case document under the frozen profile and the case-specific
 * limits, including a UTF-16LE-with-BOM source when the vector asks for one
 * (xml_v1.rs form_document:151-170).
 */
function parseCase(case_: VectorCase): XmlDocument {
  const source = caseField(case_, 'source') as string;
  let bytes: Uint8Array;
  const encoding = caseFieldOptional(case_, 'encoding') as string | undefined;
  if (encoding === 'utf16le-bom') {
    const units: number[] = [0xff, 0xfe];
    for (let index = 0; index < source.length; index++) {
      const unit = source.charCodeAt(index);
      units.push(unit & 0xff, (unit >> 8) & 0xff);
    }
    bytes = Uint8Array.from(units);
  } else {
    bytes = utf8(source);
  }
  return parse(bytes, 'SafeV1', profileDefaultSelection(), limitsFor(case_));
}

/** Asserts the formation status, render/render_hex, and pinned diagnostic (xml_v1.rs run_formation:180-220). */
function assertFormationFacts(document: XmlDocument, case_: VectorCase): void {
  const status = expectedFieldOptional(case_, 'status') as string | undefined;
  if (status !== undefined && document.formationStatus() !== status) {
    fail(`status: expected ${status}, observed ${document.formationStatus()}`);
  }
  if (status === 'Complete') {
    const render = expectedFieldOptional(case_, 'render') as string | undefined;
    if (render !== undefined && new TextDecoder().decode(document.render()) !== render) {
      fail('render mismatch');
    }
    const renderHex = expectedFieldOptional(case_, 'render_hex') as string | undefined;
    if (renderHex !== undefined) {
      const actual = toHex(document.render());
      if (actual !== renderHex) {
        fail(`render_hex: expected ${renderHex}, observed ${actual}`);
      }
    }
  }
  const diagnostic = expectedFieldOptional(case_, 'diagnostic') as string | undefined;
  if (diagnostic !== undefined) {
    const observed = document.diagnostics().map((item) => item.code);
    if (!observed.includes(diagnostic)) {
      fail(`missing diagnostic ${diagnostic} (observed ${observed.join(', ')})`);
    }
  }
}

/** xml.formation@1 */
function formationCase(case_: VectorCase): void {
  const samples = caseFieldOptional(case_, 'samples') as { source: string }[] | undefined;
  const statuses = expectedFieldOptional(case_, 'statuses') as string[] | undefined;
  const sampleDiagnostics = expectedFieldOptional(case_, 'diagnostics') as (string | null)[] | undefined;
  if (samples !== undefined) {
    samples.forEach((sample, index) => {
      let document: XmlDocument;
      try {
        document = parse(utf8(sample.source), 'SafeV1', profileDefaultSelection(), DEFAULT_XML_PARSE_LIMITS);
      } catch {
        if (statuses !== undefined && statuses[index] === 'FatalFormationFailure') {
          return;
        }
        fail(`sample ${index}: fatal formation failure`);
      }
      if (statuses !== undefined && document.formationStatus() !== statuses[index]) {
        fail(`sample ${index}: expected ${statuses[index]}, observed ${document.formationStatus()}`);
      }
      const pinned = sampleDiagnostics !== undefined ? sampleDiagnostics[index] : null;
      if (pinned !== null && pinned !== undefined) {
        const observed = document.diagnostics().map((diagnostic) => diagnostic.code);
        if (!observed.includes(pinned)) {
          fail(`sample ${index}: missing diagnostic ${pinned}`);
        }
      }
    });
    return;
  }
  const document = parseCase(case_);
  assertFormationFacts(document, case_);
  const expectedCodes = expectedFieldOptional(case_, 'diagnostics') as string[] | undefined;
  if (expectedCodes !== undefined) {
    const observed = document.diagnostics().map((diagnostic) => diagnostic.code);
    for (const code of expectedCodes) {
      if (!observed.includes(code)) {
        fail(`missing diagnostic ${code} (observed ${observed.join(', ')})`);
      }
    }
  }
  const exactCoverage = expectedFieldOptional(case_, 'exact_coverage');
  if (exactCoverage === true) {
    const index = document.losslessStructuralIndex();
    const pieces = index === null ? [] : index.pieces();
    const sourceLen = document.source().len();
    const last = pieces[pieces.length - 1];
    const covered = last === undefined ? 0 : last.span().endByte();
    if (covered !== sourceLen) {
      fail(`exact coverage: covered ${covered}, source ${sourceLen}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/** The frozen query capability set (xml_v1.rs capabilities:222-229). */
function queryCapabilities(): CapabilitySet {
  const set = new CapabilitySet();
  set.insert(newCapabilityId('core.query.ordered-results', 1));
  return set;
}

/** Builds the operator chain from the vector filters (xml_v1.rs build_filters:231-258). */
function buildFilters(case_: VectorCase): OperatorCall[] {
  const filters = caseField(case_, 'filters') as { operator: string; argument?: string }[];
  return filters.map((filter) => {
    const operator = filter.operator;
    let call = newOperatorCall(operator, 1);
    const argument = filter.argument;
    if (argument !== undefined) {
      call =
        operator === 'xml.syntax-kind-is'
          ? withArgument(call, 'kind', stringValue(argument))
          : operator === 'xml.syntax-text-equals'
            ? withArgument(call, 'text', stringValue(argument))
            : withArgument(call, 'argument', stringValue(argument));
    }
    return call;
  });
}

/** One Input-then-operators expression over the whole filter chain (xml_v1.rs :266-269). */
function buildExpression(filters: readonly OperatorCall[]): QueryExpression {
  let expression: QueryExpression = { kind: 'Input' };
  for (const operator of filters) {
    expression = { kind: 'Apply', input: expression, operator };
  }
  return expression;
}

/** Validates and binds one query definition (xml_v1.rs :270-277). */
function bindExpression(domain: QueryDomain, expression: QueryExpression) {
  const validated = validateQuery({ domain, expression, selection: 'All' });
  if ('failure' in validated) {
    fail(`definition: ${validated.failure.message}`);
  }
  const bound = bindQuery(validated.query, queryCapabilities());
  if ('failure' in bound) {
    fail(`bind: ${bound.failure.message}`);
  }
  return bound.query;
}

/** Decodes one raw-byte span under the selected source encoding (xml_v1.rs decode_utf16:831-853). */
function decodeSourceSpan(raw: Uint8Array, encoding: SourceEncoding): string {
  if (encoding.kind === 'Utf16Le' || encoding.kind === 'Utf16Be') {
    const bom = encoding.kind === 'Utf16Le' ? [0xff, 0xfe] : [0xfe, 0xff];
    const content =
      raw.length >= 2 && raw[0] === bom[0] && raw[1] === bom[1] ? raw.slice(2) : raw;
    let out = '';
    for (let index = 0; index + 1 < content.length; index += 2) {
      const unit =
        encoding.kind === 'Utf16Le'
          ? content[index] | (content[index + 1] << 8)
          : (content[index] << 8) | content[index + 1];
      out += String.fromCharCode(unit);
    }
    return out;
  }
  return new TextDecoder('utf-8').decode(raw);
}

/** xml.syntax-query@1 */
function syntaxQueryCase(case_: VectorCase): void {
  const document = parseCase(case_);
  if (document.formationStatus() !== 'Complete') {
    fail('syntax-query input must form completely');
  }
  const expression = buildExpression(buildFilters(case_));
  const executable = bindExpression(domainXMLLosslessSyntaxV1(), expression);
  const result = executeXmlSyntaxQuery(executable, document, QueryLimits.defaults(), new CancellationToken());
  const matches = result.matches();
  const expectedMatches = expectedField(case_, 'matches') as { kind: string; text?: string }[];
  if (matches.length !== expectedMatches.length) {
    fail(`match count ${matches.length} != ${expectedMatches.length}`);
  }
  const source = document.source();
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const expected = expectedMatches[index];
    if (match.kind() !== expected.kind) {
      fail(`kind ${match.kind()} != ${expected.kind}`);
    }
    const text = expected.text;
    if (text !== undefined) {
      const span = match.span();
      const actual = decodeSourceSpan(
        source.bytes().slice(span.startByte(), span.endByte()),
        source.encodingFacts().selected(),
      );
      if (actual !== text) {
        fail(`text ${JSON.stringify(actual)} != ${JSON.stringify(text)}`);
      }
    }
  }
}

/** xml.native-query@1 */
function nativeQueryCase(case_: VectorCase): void {
  const document = parseCase(case_);
  if (document.formationStatus() !== 'Complete') {
    fail('native-query input must form completely');
  }
  const expression = buildExpression(buildFilters(case_));
  const executable = bindExpression(domainXMLNativeV1(), expression);
  const result = executeXmlQuery(executable, document, QueryLimits.defaults(), new CancellationToken());
  const matches = result.matches();
  const expectedMatches = expectedField(case_, 'matches') as { local?: string; value?: string }[];
  if (matches.length !== expectedMatches.length) {
    fail(`match count ${matches.length} != ${expectedMatches.length}`);
  }
  for (let index = 0; index < matches.length; index++) {
    const match = matches[index];
    const expected = expectedMatches[index];
    if (expected.local !== undefined) {
      const local =
        match.kind === 'Element' || match.kind === 'Attribute'
          ? match.local
          : fail('unexpected match kind');
      if (local !== expected.local) {
        fail(`local ${local} != ${expected.local}`);
      }
    }
    if (expected.value !== undefined) {
      if (match.kind !== 'Attribute') {
        fail('expected attribute match');
      }
      if (match.value !== expected.value) {
        fail(`value ${match.value} != ${expected.value}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/** One unique-key Object field of a PortableValue (xml_v1.rs object_field:116-120). */
function objectField(value: PortableValue, name: string): PortableValue | null {
  if (value.kind !== 'Object') {
    return null;
  }
  const entry = value.entries.find((candidate) => candidate.key === name);
  return entry === undefined ? null : entry.value;
}

/** One string field of a PortableValue object. */
function objectStringField(value: PortableValue, name: string): string | null {
  const field = objectField(value, name);
  if (field === null || field.kind !== 'String') {
    return null;
  }
  return field.value;
}

/** One sequence field of a PortableValue object. */
function sequenceField(value: PortableValue, name: string): readonly PortableValue[] | null {
  const field = objectField(value, name);
  if (field === null || field.kind !== 'Sequence') {
    return null;
  }
  return field.items;
}

/** xml.projection@1 */
function projectionCase(case_: VectorCase): void {
  const document = parseCase(case_);
  const result = project(document, ProjectionRequest.elementTree());
  const expectedFailure = expectedFieldOptional(case_, 'failure') as string | undefined;
  if (expectedFailure !== undefined) {
    if (result.kind !== 'Failed') {
      fail('projection must fail');
    }
    const code = result.attempt.failure().code;
    if (code !== expectedFailure) {
      fail(`failure code ${code} != ${expectedFailure}`);
    }
    return;
  }
  if (result.kind !== 'Complete') {
    fail('projection must complete');
  }
  const value = result.projection.value();
  const record = expectedFieldOptional(case_, 'record') as string | undefined;
  if (record !== undefined) {
    const actual = objectStringField(value, 'record');
    if (actual !== record) {
      fail(`record ${actual} != ${record}`);
    }
  }
  const rootValue = objectField(value, 'root');
  if (rootValue === null) {
    fail('missing root');
  }
  const rootLocal = expectedFieldOptional(case_, 'root_local') as string | undefined;
  if (rootLocal !== undefined) {
    const expanded = objectField(rootValue, 'expanded-name');
    if (expanded === null) {
      fail('missing expanded-name');
    }
    const local = objectStringField(expanded, 'local');
    if (local !== rootLocal) {
      fail(`root_local ${local} != ${rootLocal}`);
    }
  }
  const rootNamespace = expectedFieldOptional(case_, 'root_namespace') as string | undefined;
  if (rootNamespace !== undefined) {
    const expanded = objectField(rootValue, 'expanded-name');
    if (expanded === null) {
      fail('missing expanded-name');
    }
    const namespace = objectStringField(expanded, 'namespace');
    if (namespace !== rootNamespace) {
      fail(`root_namespace ${namespace} != ${rootNamespace}`);
    }
  }
  const attributeValue = expectedFieldOptional(case_, 'root_attribute_value') as string | undefined;
  if (attributeValue !== undefined) {
    const attributes = sequenceField(rootValue, 'attributes');
    if (attributes === null || attributes.length === 0) {
      fail('missing attributes sequence');
    }
    const valueText = objectStringField(attributes[0], 'value');
    if (valueText !== attributeValue) {
      fail(`attribute value ${valueText} != ${attributeValue}`);
    }
  }
  const contentKinds = expectedFieldOptional(case_, 'content_kinds') as string[] | undefined;
  if (contentKinds !== undefined) {
    const content = sequenceField(rootValue, 'content');
    if (content === null) {
      fail('missing content sequence');
    }
    if (content.length !== contentKinds.length) {
      fail(`content count ${content.length} != ${contentKinds.length}`);
    }
    for (let index = 0; index < content.length; index++) {
      const expectedKind = contentKinds[index];
      const item = content[index];
      const actualKind =
        objectField(item, 'expanded-name') !== null
          ? 'element'
          : objectStringField(item, 'kind');
      if (actualKind !== expectedKind) {
        fail(`kind ${actualKind} != ${expectedKind}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Materialization
// ---------------------------------------------------------------------------

/** The stable vector spellings of one MaterializationFailure kind (xml_v1.rs materialization_failure_code:855-871). */
const MATERIALIZATION_FAILURE_SPELLING: Readonly<Record<string, string>> = Object.freeze({
  InvalidRequest: 'invalid-record',
  UnsupportedProfile: 'unsupported-profile',
  UnsupportedStyle: 'unsupported-style',
  UnsupportedEncoding: 'unsupported-encoding',
  UnsupportedNewline: 'unsupported-newline',
  Unrepresentable: 'unrepresentable',
  ResourceLimit: 'resource-limit',
  FormationFailed: 'formation-failed',
});

/** The exact `xml.1.0-safe@1` + `xml.safe-canonical-document@1` request (xml_v1.rs :541-545). */
function materializationRequest(): MaterializationRequest {
  return new MaterializationRequest(
    new ProfileId('xml.1.0-safe', 1),
    new MaterializationStyleId('xml.safe-canonical-document', 1),
  );
}

/** xml.materialization@1 */
function materializationCase(case_: VectorCase): void {
  const record = caseField(case_, 'record');
  const request = materializationRequest();
  const result = materialize(valueFromInput(record), request);
  const expectedFailure = expectedFieldOptional(case_, 'failure') as string | undefined;
  if (expectedFailure !== undefined) {
    if (result.kind !== 'Failed') {
      fail('materialization must fail');
    }
    const kind = result.value.failure().kind;
    const actual = MATERIALIZATION_FAILURE_SPELLING[kind] ?? kind;
    if (actual !== expectedFailure) {
      fail(`failure ${actual} != ${expectedFailure}`);
    }
    if (result.value.analyzedInputPaths().length > request.limits().maxInputNodes) {
      fail('analyzed_input_paths exceeds max_input_nodes');
    }
    return;
  }
  if (result.kind !== 'Complete') {
    fail('materialization must complete');
  }
  const render = expectedField(case_, 'render') as string;
  const actual = new TextDecoder().decode(result.value.document().render());
  if (actual !== render) {
    fail(`render ${JSON.stringify(actual)} != ${JSON.stringify(render)}`);
  }
}

// ---------------------------------------------------------------------------
// Edit
// ---------------------------------------------------------------------------

/** The optional occurrence ordinal of one edit operation; absent means the first (xml_v1.rs operation_ordinal:712-714). */
function occurrenceOf(operation: Record<string, unknown>, name: string): number {
  const ordinal = operation[name] as number | undefined;
  return ordinal ?? 0;
}

/** The `ordinal`-th attribute with `name` in document order (xml_v1.rs find_attribute:737-758). */
function findAttribute(document: XmlDocument, name: string, ordinal: number): NodeRef | null {
  let occurrence = 0;
  for (const content of document.nodes()) {
    if (content.kind !== 'Element') {
      continue;
    }
    for (const attribute of content.data.attributes) {
      if (attribute.qname.local === name) {
        if (occurrence === ordinal) {
          return document.occurrenceNodeRef(attribute.ordinal, 'XmlAttribute');
        }
        occurrence += 1;
      }
    }
  }
  return null;
}

/** The `ordinal`-th element with `name` in document order (xml_v1.rs find_element:760-778). */
function findElement(document: XmlDocument, name: string, ordinal: number): NodeRef | null {
  let occurrence = 0;
  const nodes = document.nodes();
  for (let index = 0; index < nodes.length; index++) {
    const content = nodes[index];
    if (content.kind === 'Element' && content.data.qname.local === name) {
      if (occurrence === ordinal) {
        return document.occurrenceNodeRef(index, 'XmlElement');
      }
      occurrence += 1;
    }
  }
  return null;
}

/** The `ordinal`-th text occurrence in document order (xml_v1.rs find_text:780-795). */
function findText(document: XmlDocument, ordinal: number): NodeRef | null {
  let occurrence = 0;
  for (const content of document.nodes()) {
    if (content.kind === 'Text') {
      if (occurrence === ordinal) {
        return document.occurrenceNodeRef(content.data.ordinal, 'XmlText');
      }
      occurrence += 1;
    }
  }
  return null;
}

/** One attribute anchor on exactly one element (xml_v1.rs find_anchor_attribute:797-813). */
function findAnchorAttribute(document: XmlDocument, element: NodeRef, name: string): NodeRef | null {
  const index = Number(element.index());
  const nodes = document.nodes();
  if (index >= nodes.length || nodes[index].kind !== 'Element') {
    return null;
  }
  for (const attribute of nodes[index].data.attributes) {
    if (attribute.qname.local === name) {
      return document.occurrenceNodeRef(attribute.ordinal, 'XmlAttribute');
    }
  }
  return null;
}

/** xml.edit@1 */
function editCase(case_: VectorCase): void {
  const document = parseCase(case_);
  if (document.formationStatus() !== 'Complete') {
    fail('edit input must form completely');
  }
  const operations = caseField(case_, 'operations') as Record<string, unknown>[];
  const builder = new EditTransactionBuilder(document);
  for (const operation of operations) {
    const op = operation.op as string;
    switch (op) {
      case 'replace-text': {
        const value = operation.value as string;
        const target = findText(document, occurrenceOf(operation, 'text'));
        if (target === null) {
          fail('text occurrence not found');
        }
        builder.replaceText(target, value);
        break;
      }
      case 'insert-attribute': {
        const elementName = operation.element as string;
        const name = operation.name as string;
        const value = operation.value as string;
        const target = findElement(document, elementName, occurrenceOf(operation, 'ordinal'));
        if (target === null) {
          fail('element not found');
        }
        const placementName = (operation.placement as string | undefined) ?? 'End';
        let placement: AttributePlacement;
        if (placementName === 'End') {
          placement = { kind: 'End' };
        } else if (placementName === 'Before' || placementName === 'After') {
          const anchor = findAnchorAttribute(document, target, operation.anchor as string);
          if (anchor === null) {
            fail('anchor attribute not found');
          }
          placement = { kind: placementName, anchor };
        } else {
          fail(`unknown placement ${placementName}`);
        }
        builder.insertAttribute(target, new NameFacts(null, name, null), value, placement);
        break;
      }
      case 'remove-attribute': {
        const name = operation.attribute as string;
        const target = findAttribute(document, name, occurrenceOf(operation, 'ordinal'));
        if (target === null) {
          fail('attribute not found');
        }
        builder.removeAttribute(target);
        break;
      }
      case 'rename-attribute': {
        const from = operation.attribute as string;
        const to = operation.to as string;
        const target = findAttribute(document, from, occurrenceOf(operation, 'ordinal'));
        if (target === null) {
          fail('attribute not found');
        }
        builder.renameAttribute(target, new NameFacts(null, to, null));
        break;
      }
      case 'set-attribute-value': {
        const name = operation.attribute as string;
        const value = operation.value as string;
        const target = findAttribute(document, name, occurrenceOf(operation, 'ordinal'));
        if (target === null) {
          fail('attribute not found');
        }
        builder.setAttributeValue(target, value);
        break;
      }
      case 'insert-element': {
        const root = document.root();
        if (root === null) {
          fail('missing root');
        }
        const name = operation.name as string;
        const content = operation.content as string | undefined;
        builder.insertElement(
          root.nodeRef(),
          new NameFacts(null, name, null),
          content ?? null,
          { kind: 'End' },
        );
        break;
      }
      case 'remove-element': {
        const name = operation.name as string;
        const target = findElement(document, name, occurrenceOf(operation, 'ordinal'));
        if (target === null) {
          fail('element not found');
        }
        builder.removeElement(target);
        break;
      }
      case 'rename-element': {
        const from = operation.from as string;
        const to = operation.to as string;
        const target = findElement(document, from, occurrenceOf(operation, 'ordinal'));
        if (target === null) {
          fail('element not found');
        }
        builder.renameElement(target, new NameFacts(null, to, null));
        break;
      }
      default:
        fail(`unknown edit op ${op}`);
    }
  }
  const commit = commitEdits(document, builder.build());
  const render = expectedField(case_, 'render') as string;
  const actual = new TextDecoder().decode(commit.document().render());
  if (actual !== render) {
    fail(`render ${JSON.stringify(actual)} != ${JSON.stringify(render)}`);
  }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** xml.limit@1 */
function limitCase(case_: VectorCase): void {
  const status = expectedFieldOptional(case_, 'status') as string | undefined;
  if (status !== undefined) {
    // The published xml.limit vocabulary is formation-class: the case limits
    // flow into the parse and the expectations are status + diagnostic
    // (xml_v1.rs run_limit:815-829 delegates to run_formation).
    const document = parseCase(case_);
    assertFormationFacts(document, case_);
    return;
  }
  // The generic limit vocabulary: expect a thrown limit failure.
  const source = caseField(case_, 'source') as string;
  const expectedCode = expectedFieldOptional(case_, 'code') as string | undefined;
  try {
    parse(utf8(source), 'SafeV1', profileDefaultSelection(), limitsFor(case_));
  } catch (error) {
    const observed = (error as { code?: unknown })?.code;
    if (expectedCode !== undefined && observed === expectedCode) {
      return;
    }
    fail(`expected limit code ${expectedCode}, observed ${JSON.stringify(observed)}`);
  }
  fail('expected a limit failure');
}

function snakeToCamel(name: string): string {
  const parts = name.split('_');
  return parts[0] + parts.slice(1).map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

export const runXmlV1: SuiteExecutor = {
  runCase(case_: VectorCase): void {
    switch (case_.capability) {
      case 'xml.formation@1':
        formationCase(case_);
        return;
      case 'xml.syntax-query@1':
        syntaxQueryCase(case_);
        return;
      case 'xml.native-query@1':
        nativeQueryCase(case_);
        return;
      case 'xml.projection@1':
        projectionCase(case_);
        return;
      case 'xml.materialization@1':
        materializationCase(case_);
        return;
      case 'xml.edit@1':
        editCase(case_);
        return;
      case 'xml.limit@1':
        limitCase(case_);
        return;
      default:
        throw new SkippedCase(
          case_.capability ?? 'unknown',
          `runner does not recognize published case ${case_.id}`,
        );
    }
  },
};
