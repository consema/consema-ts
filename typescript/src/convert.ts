/**
 * Audited projection-to-materialization composition (L4 root facade; mirror
 * of crates/consema/src/conversion.rs).
 *
 * Every `convert*` function composes one format-owned projection and the
 * requested target materializer, retaining the intermediate portable value
 * and the two-stage report. The composition never invents a cross-format
 * convention: the baseline formats (JSON, TOML, YAML, INI, Java Properties)
 * project plain portable values, while the record formats (XML, plist, HCL)
 * project versioned internal records (`xml.element-tree@1`,
 * `plist.value-tree@1`, `hcl.body@1`) that only their owning format
 * family's materializer consumes (RFC 0012 §9, RFC 0013 §9, RFC 0014 §8.2).
 *
 * # Record-consumption gate
 *
 * A conversion whose source is a record format projects the internal record
 * envelope; presenting that envelope as a target document would be an
 * internal record dump, not a conversion. The facade therefore fails the
 * conversion atomically whenever the record's owning family is not the
 * target profile's family. Same-family directions (for example `plist.xml`
 * to `plist.binary`, or `hcl.native` to `hcl.tfvars`) pass the gate. The
 * gate keys on the record-publishing projection, never on value shape
 * alone: a `"record"` member in baseline content stays content.
 */

import type { PortableValue } from './core/value.ts';
import type { Diagnostic } from './document/diagnostic.ts';
import { MaterializationFailure } from './document/errors.ts';
import {
  CompleteMaterialization,
  FailedMaterializationAttempt,
  MaterializationReport,
  MaterializationRequest,
} from './document/materialization.ts';
import type { MaterializationResult, MaterializationFidelity } from './document/materialization.ts';
import { ProfileId } from './document/profile.ts';
import { Document } from './registry.ts';
import type { JsonDocument } from './json/document.ts';
import { project as projectJson, ProjectionRequest as JsonProjectionRequest } from './json/projection.ts';
import type { Fidelity as JsonFidelity } from './json/projection.ts';
import { materialize as materializeJson } from './json/materialization.ts';
import type { TomlDocument } from './toml/document.ts';
import { projectToml, TomlProjectionRequest } from './toml/projection.ts';
import { materializeToml } from './toml/materialization.ts';
import type { YamlDocument } from './yaml/document.ts';
import { projectValueComplete, ValueProjectionRequest } from './yaml/projection.ts';
import type { Fidelity as YamlFidelity } from './yaml/projection.ts';
import type { ValueProjectionFailure } from './yaml/errors.ts';
import { materializeValue } from './yaml/materialization.ts';
import type { IniDocument } from './ini/document.ts';
import { projectIni, IniProjectionRequest } from './ini/projection.ts';
import type { IniProjectionFidelity } from './ini/projection.ts';
import { materializeIni } from './ini/materialization.ts';
import type { PropertiesDocument } from './properties/document.ts';
import { project, ProjectionRequest as PropertiesProjectionRequest } from './properties/projection.ts';
import type { Fidelity as PropertiesFidelity } from './properties/projection.ts';
import { materialize } from './properties/materialization.ts';
import type { XmlDocument } from './xml/document.ts';
import { project as projectXml, ProjectionRequest as XmlProjectionRequest } from './xml/projection.ts';
import type { Fidelity as XmlFidelity } from './xml/projection.ts';
import { materialize as materializeXml } from './xml/materialization.ts';
import type { PlistDocument } from './plist/document.ts';
import { project as projectPlist, ProjectionRequest as PlistProjectionRequest } from './plist/projection.ts';
import type { Fidelity as PlistFidelity } from './plist/projection.ts';
import { materialize as materializePlist } from './plist/materialization.ts';
import type { HclDocument } from './hcl/document.ts';
import { projectHcl, HclProjectionRequest } from './hcl/projection.ts';
import type { HclProjectionFidelity } from './hcl/projection.ts';
import { materializeHcl } from './hcl/materialization.ts';
import type { HclBodyRecordInput } from './hcl/materialization.ts';

// ---------------------------------------------------------------------------
// Conversion records
// ---------------------------------------------------------------------------

/** Whole-conversion semantic fidelity (conversion.rs:42-51). */
export type ConversionFidelity = 'Exact' | 'Transformed' | 'Lossy';

/** Complete ordered report for both conversion stages (conversion.rs:95-149). */
export class ConversionReport {
  readonly #projectionFidelity: ConversionFidelity;
  readonly #materializationFidelity: MaterializationFidelity;
  readonly #overallFidelity: ConversionFidelity;
  readonly #sourceProfile: ProfileId;
  readonly #targetProfile: ProfileId;
  /** Ordered projection events (family-shaped) — retained for audit. */
  readonly #projectionEvents: readonly unknown[];
  /** Ordered materialization report events. */
  readonly #materializationEvents: readonly Diagnostic[];

  constructor(options: {
    projectionFidelity: ConversionFidelity;
    materializationFidelity: MaterializationFidelity;
    overallFidelity: ConversionFidelity;
    sourceProfile: ProfileId;
    targetProfile: ProfileId;
    projectionEvents: readonly unknown[];
    materializationEvents: readonly Diagnostic[];
  }) {
    this.#projectionFidelity = options.projectionFidelity;
    this.#materializationFidelity = options.materializationFidelity;
    this.#overallFidelity = options.overallFidelity;
    this.#sourceProfile = options.sourceProfile;
    this.#targetProfile = options.targetProfile;
    this.#projectionEvents = Object.freeze([...options.projectionEvents]);
    this.#materializationEvents = Object.freeze([...options.materializationEvents]);
  }

  /** Projection-stage fidelity. */
  projectionFidelity(): ConversionFidelity {
    return this.#projectionFidelity;
  }

  /** Materialization-stage fidelity. */
  materializationFidelity(): MaterializationFidelity {
    return this.#materializationFidelity;
  }

  /** Worst fidelity across both stages. */
  overallFidelity(): ConversionFidelity {
    return this.#overallFidelity;
  }

  /** Exact source profile. */
  sourceProfile(): ProfileId {
    return this.#sourceProfile;
  }

  /** Exact target profile. */
  targetProfile(): ProfileId {
    return this.#targetProfile;
  }

  /** Ordered projection-stage events (family-specific shapes). */
  projectionEvents(): readonly unknown[] {
    return this.#projectionEvents;
  }

  /** Ordered materialization-stage events (Diagnostic records). */
  materializationEvents(): readonly Diagnostic[] {
    return this.#materializationEvents;
  }
}

/** Complete conversion result with both stages retained (conversion.rs:151-278). */
export class CompleteConversion {
  readonly #document: Document;
  readonly #projectedValue: PortableValue;
  readonly #report: ConversionReport;

  constructor(document: Document, projectedValue: PortableValue, report: ConversionReport) {
    this.#document = document;
    this.#projectedValue = projectedValue;
    this.#report = report;
  }

  /** Newly materialized target document. */
  document(): Document {
    return this.#document;
  }

  /** Exact intermediate portable value used between the two stages. */
  projectedValue(): PortableValue {
    return this.#projectedValue;
  }

  /** Complete two-stage report. */
  report(): ConversionReport {
    return this.#report;
  }
}

/** Conversion failure without a partial target document (conversion.rs:280-308). */
export class ConversionFailure extends Error {
  readonly kind: 'ProjectionFailed' | 'MaterializationFailed' | 'UnauthorizedLoss' | 'YamlProjectionFailed';
  /** Frozen registered code (conversion.rs:324-332). */
  readonly code: string;
  /** Materialization failure details when kind === MaterializationFailed. */
  readonly materialization?: MaterializationFailure;

  private constructor(
    kind: ConversionFailure['kind'],
    code: string,
    message: string,
    materialization?: MaterializationFailure,
  ) {
    super(message);
    this.name = 'ConversionFailure';
    this.kind = kind;
    this.code = code;
    if (materialization !== undefined) {
      this.materialization = materialization;
    }
  }

  static projectionFailed(diagnostics: readonly Diagnostic[]): ConversionFailure {
    return new ConversionFailure(
      'ProjectionFailed',
      'core.conversion.projection-failed@1',
      `conversion: projection failed${diagnostics.length > 0 ? `: ${diagnostics[0].code}` : ''}`,
    );
  }

  static yamlProjectionFailed(failure: ValueProjectionFailure): ConversionFailure {
    return new ConversionFailure(
      'YamlProjectionFailed',
      'core.conversion.projection-failed@1',
      `conversion: YAML projection failed: ${failure.message}`,
    );
  }

  static materializationFailed(failure: MaterializationFailure): ConversionFailure {
    return new ConversionFailure(
      'MaterializationFailed',
      'core.conversion.materialization-failed@1',
      `conversion: materialization failed: ${failure.code}`,
      failure,
    );
  }

  static unauthorizedLoss(): ConversionFailure {
    return new ConversionFailure(
      'UnauthorizedLoss',
      'core.conversion.unauthorized-loss@1',
      'conversion: lossy projection event lacks an authorizing policy',
    );
  }
}

/** Complete or explicitly failed conversion (conversion.rs:335-342). */
export type ConversionResult =
  | { readonly kind: 'Complete'; readonly value: CompleteConversion }
  | { readonly kind: 'Failed'; readonly value: ConversionFailure };

// ---------------------------------------------------------------------------
// Record-consumption gate
// ---------------------------------------------------------------------------

/** Published record envelope ids (conversion.rs:590-595). */
const XML_ELEMENT_TREE_RECORD = 'xml.element-tree@1';
const PLIST_VALUE_TREE_RECORD = 'plist.value-tree@1';
const HCL_BODY_RECORD = 'hcl.body@1';

/** One published Consema format record envelope, identified by its exact versioned `record` member. */
function publishedRecord(value: PortableValue): string | undefined {
  if (value.kind !== 'Object') {
    return undefined;
  }
  const record = value.entries.find((entry) => entry.key === 'record');
  if (record === undefined || record.value.kind !== 'String') {
    return undefined;
  }
  return [XML_ELEMENT_TREE_RECORD, PLIST_VALUE_TREE_RECORD, HCL_BODY_RECORD].includes(record.value.value)
    ? record.value.value
    : undefined;
}

/** Owning format family of one published record id. */
function recordFamily(record: string): string | undefined {
  switch (record) {
    case XML_ELEMENT_TREE_RECORD:
      return 'xml';
    case PLIST_VALUE_TREE_RECORD:
      return 'plist';
    case HCL_BODY_RECORD:
      return 'hcl';
    default:
      return undefined;
  }
}

/** Format family of one profile id; unknown profiles return undefined. */
function formatFamily(profileId: string): string | undefined {
  switch (profileId) {
    case 'json.strict':
    case 'jsonc.bounded':
    case 'json5.standard':
      return 'json';
    case 'toml.1.0':
      return 'toml';
    case 'yaml.1.2-core':
    case 'yaml.1.1-compat':
      return 'yaml';
    case 'ini.portable':
    case 'ini.windows':
    case 'ini.python-configparser':
      return 'ini';
    case 'java-properties.reader':
    case 'java-properties.latin1':
      return 'properties';
    case 'xml.1.0-safe':
      return 'xml';
    case 'plist.xml':
    case 'plist.binary':
      return 'plist';
    case 'hcl.native':
    case 'hcl.tfvars':
      return 'hcl';
    default:
      return undefined;
  }
}

/** Record-consumption gate of the composition (module docs; conversion.rs:657-689). */
function validateRecordConsumption(
  sourceProfile: ProfileId,
  value: PortableValue,
  request: MaterializationRequest,
): ConversionFailure | undefined {
  const sourceFamily = formatFamily(sourceProfile.id());
  if (sourceFamily !== 'xml' && sourceFamily !== 'plist' && sourceFamily !== 'hcl') {
    return undefined;
  }
  const record = publishedRecord(value);
  if (record === undefined) {
    return undefined;
  }
  if (recordFamily(record) === formatFamily(request.targetProfile().id())) {
    return undefined;
  }
  return ConversionFailure.materializationFailed(
    new MaterializationFailure('InvalidRequest', {
      reason: `the projected value is the ${record} internal record; only its owning format family materializer consumes it`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** Worst-fidelity comparison across the two stages. */
function maxFidelity(left: ConversionFidelity, right: ConversionFidelity): ConversionFidelity {
  const order: Record<ConversionFidelity, number> = { Exact: 0, Transformed: 1, Lossy: 2 };
  return order[left] >= order[right] ? left : right;
}

/** Materializes one portable value under the target request (conversion.rs:740-901). */
function materializeTarget(value: PortableValue, request: MaterializationRequest): { document: Document; fidelity: MaterializationFidelity; report: MaterializationReport } | ConversionFailure {
  const profileId = request.targetProfile().id();
  let result: MaterializationResult<unknown>;
  switch (profileId) {
    case 'ini.portable':
    case 'ini.windows':
    case 'ini.python-configparser':
      result = materializeIni(value, request);
      break;
    case 'java-properties.reader':
    case 'java-properties.latin1':
      result = materialize(value, request);
      break;
    case 'json.strict':
    case 'jsonc.bounded':
    case 'json5.standard':
      result = materializeJson(value, request);
      break;
    case 'toml.1.0':
      result = materializeToml(value, request);
      break;
    case 'yaml.1.2-core':
    case 'yaml.1.1-compat':
      result = materializeValue(value, request);
      break;
    case 'hcl.native':
    case 'hcl.tfvars':
      result = materializeHcl(portableToHclRecord(value) as HclBodyRecordInput, request);
      break;
    case 'xml.1.0-safe':
      result = materializeXml(value, request);
      break;
    case 'plist.xml':
    case 'plist.binary':
      result = materializePlist(value, request);
      break;
    default:
      return ConversionFailure.materializationFailed(new MaterializationFailure('UnsupportedProfile'));
  }
  if (result.kind === 'Failed') {
    const attempt = result.value as FailedMaterializationAttempt;
    return ConversionFailure.materializationFailed(attempt.failure());
  }
  const complete = result.value as CompleteMaterialization<unknown>;
  return {
    document: wrapDocument(profileId, complete.document()),
    fidelity: complete.fidelity(),
    report: complete.report(),
  };
}

/** Wraps one family document into the common facade union. */
function wrapDocument(profileId: string, document: unknown): Document {
  switch (profileId) {
    case 'ini.portable':
    case 'ini.windows':
    case 'ini.python-configparser':
      return newDocumentIni(document as IniDocument);
    case 'java-properties.reader':
    case 'java-properties.latin1':
      return newDocumentProperties(document as PropertiesDocument);
    case 'json.strict':
    case 'jsonc.bounded':
    case 'json5.standard':
      return newDocumentJson(document as JsonDocument);
    case 'toml.1.0':
      return newDocumentToml(document as TomlDocument);
    case 'yaml.1.2-core':
    case 'yaml.1.1-compat':
      return newDocumentYaml(document as YamlDocument);
    case 'hcl.native':
    case 'hcl.tfvars':
      return newDocumentHcl(document as HclDocument);
    case 'xml.1.0-safe':
      return newDocumentXml(document as XmlDocument);
    case 'plist.xml':
    case 'plist.binary':
      return newDocumentPlist(document as PlistDocument);
    default:
      throw new Error(`internal: unknown target profile ${profileId}`);
  }
}

function newDocumentJson(document: JsonDocument): Document {
  return Document.fromJson(document);
}

function newDocumentToml(document: TomlDocument): Document {
  return Document.fromToml(document);
}

function newDocumentYaml(document: YamlDocument): Document {
  return Document.fromYaml(document);
}

function newDocumentIni(document: IniDocument): Document {
  return Document.fromIni(document);
}

function newDocumentProperties(document: PropertiesDocument): Document {
  return Document.fromProperties(document);
}

function newDocumentXml(document: XmlDocument): Document {
  return Document.fromXml(document);
}

function newDocumentPlist(document: PlistDocument): Document {
  return Document.fromPlist(document);
}

function newDocumentHcl(document: HclDocument): Document {
  return Document.fromHcl(document);
}

interface ProjectionFacts {
  value: PortableValue;
  fidelity: ConversionFidelity;
  events: readonly unknown[];
}

/** Composes one projection and the target materializer (conversion.rs:691-731). */
function completeConversion(
  sourceProfile: ProfileId,
  projected: ProjectionFacts,
  request: MaterializationRequest,
): ConversionResult {
  const gate = validateRecordConsumption(sourceProfile, projected.value, request);
  if (gate !== undefined) {
    return { kind: 'Failed', value: gate };
  }
  const materialized = materializeTarget(projected.value, request);
  if (materialized instanceof ConversionFailure) {
    return { kind: 'Failed', value: materialized };
  }
  const materializationFidelity = materialized.fidelity;
  const materializationOverall: ConversionFidelity =
    materializationFidelity === 'Exact' ? 'Exact' : 'Transformed';
  const report = new ConversionReport({
    projectionFidelity: projected.fidelity,
    materializationFidelity,
    overallFidelity: maxFidelity(projected.fidelity, materializationOverall),
    sourceProfile,
    targetProfile: request.targetProfile(),
    projectionEvents: projected.events,
    materializationEvents: materialized.report.events(),
  });
  return {
    kind: 'Complete',
    value: new CompleteConversion(materialized.document, projected.value, report),
  };
}

function jsonFidelity(fidelity: JsonFidelity): ConversionFidelity {
  switch (fidelity) {
    case 'Exact':
      return 'Exact';
    case 'Transformed':
      return 'Transformed';
    case 'Lossy':
      return 'Lossy';
  }
}

function tomlFidelity(fidelity: 'Exact' | 'Transformed' | 'Lossy'): ConversionFidelity {
  switch (fidelity) {
    case 'Exact':
      return 'Exact';
    case 'Transformed':
      return 'Transformed';
    case 'Lossy':
      return 'Lossy';
  }
}

function yamlFidelity(fidelity: YamlFidelity): ConversionFidelity {
  switch (fidelity) {
    case 'Exact':
      return 'Exact';
    case 'Transformed':
      return 'Transformed';
    case 'Lossy':
      return 'Lossy';
  }
}

function iniFidelity(fidelity: IniProjectionFidelity): ConversionFidelity {
  switch (fidelity) {
    case 'Exact':
      return 'Exact';
    case 'Transformed':
      return 'Transformed';
    case 'Lossy':
      return 'Lossy';
  }
}

function propertiesFidelity(fidelity: PropertiesFidelity): ConversionFidelity {
  switch (fidelity) {
    case 'Exact':
      return 'Exact';
    case 'Transformed':
      return 'Transformed';
    case 'Lossy':
      return 'Lossy';
  }
}

function xmlFidelity(fidelity: XmlFidelity): ConversionFidelity {
  switch (fidelity) {
    case 'Exact':
      return 'Exact';
    case 'Transformed':
      return 'Transformed';
    case 'Lossy':
      return 'Lossy';
  }
}

function plistFidelity(fidelity: PlistFidelity): ConversionFidelity {
  switch (fidelity) {
    case 'Exact':
      return 'Exact';
    case 'Transformed':
      return 'Transformed';
    case 'Lossy':
      return 'Lossy';
  }
}

/**
 * Converts one projected PortableValue record into the pinned plain-JS
 * `hcl.body@1` record spelling consumed by the HCL materializer (RFC 0014
 * §9 typed-member form). The HCL projection emits exactly the typed record
 * members (kind-tagged objects, tuple arrays, entry-mapping pairs), so a
 * structural PortableValue → plain-JS mapping lands on the pinned spelling.
 */
function portableToHclRecord(value: PortableValue): unknown {
  switch (value.kind) {
    case 'Null':
      return null;
    case 'Boolean':
      return value.value;
    case 'Integer':
      return value.value;
    case 'Decimal':
      return Number(value.coefficient) * 10 ** Number(value.exponent);
    case 'String':
      return value.value;
    case 'Sequence':
      return value.items.map((item) => portableToHclRecord(item));
    case 'Object': {
      const record: Record<string, unknown> = {};
      for (const entry of value.entries) {
        record[entry.key] = portableToHclRecord(entry.value);
      }
      return record;
    }
    case 'EntryMapping':
      return value.entries.map((entry) => [
        portableToHclRecord(entry.key),
        portableToHclRecord(entry.value),
      ]);
    case 'Bytes':
      throw new Error('internal: hcl record cannot carry bytes');
    case 'BinaryFloat32':
    case 'BinaryFloat64':
    case 'Date':
    case 'Time':
    case 'LocalDateTime':
    case 'OffsetDateTime':
      throw new Error(`internal: hcl record cannot carry ${value.kind}`);
  }
}

function hclFidelity(fidelity: HclProjectionFidelity): ConversionFidelity {
  switch (fidelity) {
    case 'Exact':
      return 'Exact';
    case 'Transformed':
      return 'Transformed';
    case 'Lossy':
      return 'Lossy';
  }
}

// ---------------------------------------------------------------------------
// Per-family conversion entry points (conversion.rs:344-588)
// ---------------------------------------------------------------------------

/** Converts one JSON document by composing its published projection and a target materializer. */
export function convertJson(
  source: JsonDocument,
  projectionRequest: JsonProjectionRequest,
  materializationRequest: MaterializationRequest,
): ConversionResult {
  const result = projectJson(source, projectionRequest);
  if (result.kind === 'Failed') {
    return { kind: 'Failed', value: ConversionFailure.projectionFailed(result.value.diagnostics()) };
  }
  const projection = result.value;
  if (
    projection.fidelity() === 'Lossy' &&
    projection
      .report()
      .events()
      .some((event) => event.loss() === 'Lossy' && event.policy() === null)
  ) {
    return { kind: 'Failed', value: ConversionFailure.unauthorizedLoss() };
  }
  return completeConversion(source.profile(), {
    value: projection.value(),
    fidelity: jsonFidelity(projection.fidelity()),
    events: projection.report().events(),
  }, materializationRequest);
}

/** Converts one TOML document by composing its published projection and a target materializer. */
export function convertToml(
  source: TomlDocument,
  projectionRequest: TomlProjectionRequest,
  materializationRequest: MaterializationRequest,
): ConversionResult {
  const result = projectToml(source, projectionRequest);
  if (result.kind === 'Failed') {
    return { kind: 'Failed', value: ConversionFailure.projectionFailed([]) };
  }
  const projection = result.value;
  return completeConversion(source.profile(), {
    value: projection.value(),
    fidelity: tomlFidelity(projection.fidelity()),
    events: projection.report().events(),
  }, materializationRequest);
}

/** Converts one YAML stream through its explicit PortableValue projection. */
export function convertYaml(
  source: YamlDocument,
  projectionRequest: ValueProjectionRequest,
  materializationRequest: MaterializationRequest,
): ConversionResult {
  const result = projectValueComplete(source, projectionRequest);
  if (result.kind === 'Failed') {
    return { kind: 'Failed', value: ConversionFailure.yamlProjectionFailed(result.failure) };
  }
  const projection = result.complete;
  return completeConversion(source.profile(), {
    value: projection.value,
    fidelity: yamlFidelity(projection.fidelity),
    events: projection.report.events(),
  }, materializationRequest);
}

/** Converts one INI document by composing its explicit projection and a target materializer. */
export function convertIni(
  source: IniDocument,
  projectionRequest: IniProjectionRequest,
  materializationRequest: MaterializationRequest,
): ConversionResult {
  const result = projectIni(source, projectionRequest);
  if (result.kind === 'Failed') {
    return { kind: 'Failed', value: ConversionFailure.projectionFailed([]) };
  }
  const projection = result.value;
  return completeConversion(source.profile(), {
    value: projection.value(),
    fidelity: iniFidelity(projection.fidelity()),
    events: projection.report().events(),
  }, materializationRequest);
}

/** Converts one Java Properties document through an explicit duplicate policy. */
export function convertProperties(
  source: PropertiesDocument,
  projectionRequest: PropertiesProjectionRequest,
  materializationRequest: MaterializationRequest,
): ConversionResult {
  const result = project(source, projectionRequest);
  if (result.kind === 'Failed') {
    return { kind: 'Failed', value: ConversionFailure.projectionFailed([]) };
  }
  const projection = result.value;
  return completeConversion(source.profile(), {
    value: projection.value(),
    fidelity: propertiesFidelity(projection.fidelity()),
    events: projection.report().events(),
  }, materializationRequest);
}

/** Converts one XML document by composing its element-tree projection and a target materializer. */
export function convertXml(
  source: XmlDocument,
  projectionRequest: XmlProjectionRequest,
  materializationRequest: MaterializationRequest,
): ConversionResult {
  const result = projectXml(source, projectionRequest);
  if (result.kind === 'Failed') {
    return { kind: 'Failed', value: ConversionFailure.projectionFailed([]) };
  }
  const projection = result.projection;
  return completeConversion(source.profile(), {
    value: projection.value(),
    fidelity: xmlFidelity(projection.fidelity()),
    events: projection.report().events(),
  }, materializationRequest);
}

/** Converts one Property List document by composing its value-tree projection and a target materializer. */
export function convertPlist(
  source: PlistDocument,
  projectionRequest: PlistProjectionRequest,
  materializationRequest: MaterializationRequest,
): ConversionResult {
  const result = projectPlist(source, projectionRequest);
  if (result.kind === 'Failed') {
    return { kind: 'Failed', value: ConversionFailure.projectionFailed([]) };
  }
  const projection = result.value;
  return completeConversion(source.profile(), {
    value: projection.value(),
    fidelity: plistFidelity(projection.fidelity()),
    events: projection.report().events(),
  }, materializationRequest);
}

/** Converts one HCL document by composing its body projection and a target materializer. */
export function convertHcl(
  source: HclDocument,
  projectionRequest: HclProjectionRequest,
  materializationRequest: MaterializationRequest,
): ConversionResult {
  const result = projectHcl(source, projectionRequest);
  if (result.kind === 'Failed') {
    return { kind: 'Failed', value: ConversionFailure.projectionFailed([]) };
  }
  const projection = result.value;
  return completeConversion(source.profile(), {
    value: projection.value(),
    fidelity: hclFidelity(projection.fidelity()),
    events: projection.report().events(),
  }, materializationRequest);
}
