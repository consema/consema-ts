/**
 * Cross-language normalized-result differential harness — TypeScript side
 * (design: docs/five-language-ci-design.md §3.3; Go precedent:
 * go/conformance/differential/normalized/{runner.go,source.go}; the Rust
 * example crates/consema-conformance/examples/emit_normalized_results.rs is
 * the byte authority for the golden facts).
 *
 * The compared facts are exactly the language-neutral behavior surface of
 * roadmap §11.2: parse formation, diagnostic code/order (never text), query
 * count/identity/order, projection/materialization reports, edit result
 * bytes or failure codes, and resource-limit completion semantics. The fact
 * vocabulary is defined by the Go runner and mirrored verbatim here; it
 * contains no Rust internal type names. Error texts never participate in
 * the comparison.
 *
 * Bidirectional pipeline (the Go precedent, normalized_test.go):
 *   - forward: the Rust example emits `<case-id>.txt` golden files
 *     (CONSEMA_DIFFERENTIAL_NORMALIZED_RUST_DIR); this module computes the
 *     TS facts for the same input set and compares field by field;
 *   - reverse: this module emits the TS-side evidence files into
 *     CONSEMA_DIFFERENTIAL_NORMALIZED_TS_DIR (one `<case-id>.txt` per case,
 *     the same line-oriented key=value format), and the Rust example's
 *     `--consume` mode recomputes the Rust results and compares them field
 *     by field (exit 1 on any divergence).
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PortableValue } from '../../core/value.ts';
import { nullValue, integerValue, decimalValue, stringValue, binaryFloat64Value, entryMappingValue } from '../../core/value.ts';
import { DecodeJSON } from '../../protocol/canonical.ts';
import { defaultProtocolLimits } from '../../protocol/limits.ts';
import { parseJsonNumber, valueFromInput } from '../../conformance/helpers.ts';
import {
  newQueryDomain, newQueryDefinition, newOperatorCall, withExpression, withSelection,
  withArgument, validateQuery, bindQuery, QueryFailure,
} from '../../protocol/query.ts';
import type { QueryDefinition, ExecutableQuery } from '../../protocol/query.ts';
import { newCapabilityId, CapabilitySet } from '../../protocol/registry_descriptor.ts';
import { ProfileId } from '../../document/profile.ts';
import { MaterializationRequest, MaterializationStyleId, DEFAULT_MATERIALIZATION_LIMITS } from '../../document/materialization.ts';
import type { MaterializationLimits } from '../../document/materialization.ts';
import { DEFAULT_PARSE_LIMITS } from '../../document/formation.ts';
import type { ParseLimits } from '../../document/formation.ts';
import {
  SourceSnapshot, EncodingRequest, utf8Encoding, utf16LeEncoding, utf16BeEncoding,
  latin1Encoding, binaryEncoding, windowsCodePageEncoding, WindowsCodePage,
  encodingAsStr, bomKindEncoding, DEFAULT_SOURCE_LIMITS,
} from '../../document/source.ts';
import type { SourceEncoding, BomPolicy } from '../../document/source.ts';
import { SourceReplacement, SourcePatch, DEFAULT_SOURCE_PATCH_LIMITS } from '../../document/source_patch.ts';
import { SourceError, SourcePatchError } from '../../document/errors.ts';
import type { NodeRef } from '../../document/identity.ts';
import type { AssociationPlacement } from '../../document/identity.ts';
import { parse as parseJson } from '../../json/parser.ts';
import {
  executeJsonQuery, executeJsonSyntaxQuery, QueryLimits as JsonQueryLimits,
  CancellationToken as JsonCancellationToken,
} from '../../json/query.ts';
import { ProjectionRequestBuilder, project as projectJson } from '../../json/projection.ts';
import { materialize as materializeJson } from '../../json/materialization.ts';
import { EditTransactionBuilder as JsonEditTransactionBuilder, commitEdits as commitJsonEdits } from '../../json/edit.ts';
import type { RepresentationPolicy as JsonRepresentationPolicy } from '../../json/edit.ts';
import { parseToml } from '../../toml/document.ts';
import { TomlProfile } from '../../toml/profile.ts';
import {
  executeTomlQuery, executeTomlSyntaxQuery, DEFAULT_TOML_QUERY_LIMITS, TomlCancellationToken,
} from '../../toml/query.ts';
import type { TomlQueryLimits, TomlMatch } from '../../toml/query.ts';
import { projectToml, TomlProjectionRequest } from '../../toml/projection.ts';
import { materializeToml } from '../../toml/materialization.ts';
import { TomlEditTransactionBuilder, commitTomlEdits } from '../../toml/edit.ts';
import type { TomlRepresentationPolicy } from '../../toml/edit.ts';
import { parse as parseYaml } from '../../yaml/parser.ts';
import {
  executeYamlQuery, executeYamlSyntaxQuery, QueryLimits as YamlQueryLimits,
  CancellationToken as YamlCancellationToken,
} from '../../yaml/query.ts';
import { projectValueComplete, ValueProjectionRequest } from '../../yaml/projection.ts';
import { materializeValue as materializeYaml } from '../../yaml/materialization.ts';
import { EditTransactionBuilder as YamlEditTransactionBuilder, commitEdits as commitYamlEdits } from '../../yaml/edit.ts';
import type { RepresentationPolicy as YamlRepresentationPolicy } from '../../yaml/edit.ts';
import { EditFailure as YamlEditFailure } from '../../yaml/errors.ts';
import { parseIniDocument } from '../../ini/document.ts';
import { IniProfile, profileDefaultSelection, DEFAULT_INI_PARSE_LIMITS } from '../../ini/profile.ts';
import type { IniParseLimits } from '../../ini/profile.ts';
import {
  executeIniQuery, executeIniSyntaxQuery, IniCancellationToken,
} from '../../ini/query.ts';
import type { IniMatch } from '../../ini/query.ts';
import { projectIni, IniProjectionRequest } from '../../ini/projection.ts';
import { materializeIni } from '../../ini/materialization.ts';
import { IniEditTransactionBuilder, commitIniEdits } from '../../ini/edit.ts';
import type { IniRepresentationPolicy } from '../../ini/edit.ts';
import { parse as parseProperties, parseReader as parsePropertiesReader } from '../../properties/parser.ts';
import {
  executePropertiesQuery, executePropertiesSyntaxQuery, QueryLimits as PropertiesQueryLimits,
  CancellationToken as PropertiesCancellationToken,
} from '../../properties/query.ts';
import { project as projectProperties, ProjectionRequest as PropertiesProjectionRequest } from '../../properties/projection.ts';
import { materialize as materializeProperties } from '../../properties/materialization.ts';
import { EditTransactionBuilder as PropertiesEditTransactionBuilder, commitEdits as commitPropertiesEdits } from '../../properties/edit.ts';
import { EditFailure as PropertiesEditFailure } from '../../properties/errors.ts';
import { JavaString } from '../../properties/java_string.ts';
import { DEFAULT_PROPERTIES_PARSE_LIMITS } from '../../properties/parse_limits.ts';
import type { PropertiesParseLimits } from '../../properties/parse_limits.ts';

/** The frozen manifest id of the differential input set. */
export const CASE_FILE_MANIFEST = 'consema.differential.normalized@1';

/** The task's lower bound for the input set (milestone 0.16.0 G2.4). */
export const MIN_CASE_COUNT = 104;

// ---------------------------------------------------------------------------
// Case file schema (data-driven; shared with the Go runner and the Rust
// example)
// ---------------------------------------------------------------------------

export interface FileCase {
  readonly id: string;
  readonly kind: 'document' | 'source';
  readonly format?: string;
  readonly profile?: string;
  readonly source?: string;
  readonly foreignSource?: string;
  readonly foreignSourceHex?: string;
  readonly parseLimits?: ParseLimitsDesc;
  readonly steps?: readonly StepDesc[];
  readonly input?: SourceInputDesc;
  readonly request?: EncodingRequestDesc;
  readonly positions?: readonly number[];
  readonly patch?: PatchDesc;
}

export interface ParseLimitsDesc {
  readonly maxSourceBytes?: number;
  readonly maxNestingDepth?: number;
  readonly maxTokenCount?: number;
  readonly maxNodeCount?: number;
  readonly maxDiagnostics?: number;
}

export interface StepDesc {
  readonly op: string;
  readonly domain?: string;
  readonly domainVersion?: number;
  readonly filters?: readonly FilterDesc[];
  readonly combine?: string;
  readonly selection?: string;
  readonly queryLimits?: QueryLimitsDesc;
  readonly target?: string;
  readonly duplicatePolicy?: string;
  readonly input?: string;
  readonly valueJSON?: string;
  readonly entryMapping?: EntryMappingDesc;
  readonly targetProfile?: string;
  readonly style?: string;
  readonly newline?: string;
  readonly limits?: MaterializeLimitsDesc;
  readonly operations?: readonly EditOpDesc[];
}

export interface FilterDesc {
  readonly operator: string;
  readonly argument?: unknown;
}

export interface QueryLimitsDesc {
  readonly maxResults?: number;
  readonly maxSteps?: number;
}

export interface EntryMappingDesc {
  readonly keyJSON: string;
  readonly valueJSON: string;
}

export interface MaterializeLimitsDesc {
  readonly maxOutputBytes?: number;
  readonly maxInputNodes?: number;
  readonly maxDepth?: number;
  readonly maxProvenanceEntries?: number;
}

export interface EditOpDesc {
  readonly operation: string;
  readonly target?: TargetDesc;
  readonly value?: ValueDesc;
  readonly literalHex?: string;
  readonly name?: string;
  readonly policy?: string;
  readonly placement?: PlacementDesc;
}

export interface TargetDesc {
  readonly kind: string;
  readonly ordinal?: number;
  readonly foreign?: boolean;
}

export interface ValueDesc {
  readonly null?: boolean;
  readonly boolean?: boolean;
  readonly integer?: string;
  readonly decimal?: string;
  readonly string?: string;
  readonly binary64?: string;
}

export interface PlacementDesc {
  readonly at?: string;
  readonly beforeOrdinal?: number;
  readonly afterOrdinal?: number;
}

export interface SourceInputDesc {
  readonly rawHex?: string;
  readonly source?: string;
}

export interface EncodingRequestDesc {
  readonly profileDefault: string;
  readonly declaration?: string;
  readonly callerOverride?: string;
  readonly bomPolicy?: string;
}

export interface PatchDesc {
  readonly replacements: readonly PatchReplacementDesc[];
  readonly applyTo?: string;
}

export interface PatchReplacementDesc {
  readonly oldStart: number;
  readonly oldEnd: number;
  readonly replacementHex: string;
}

// ---------------------------------------------------------------------------
// Case file loading
// ---------------------------------------------------------------------------

/** The repository root directory (resolved from this file). */
export function repoRootDir(): string {
  const here = fileURLToPath(new URL('.', import.meta.url));
  return `${here}../../../../`;
}

/** The checked-in differential case file. */
export function defaultCasesFile(): string {
  return `${repoRootDir()}conformance/differential/normalized/cases.json`;
}

/** Loads and validates the checked-in case set (manifest, count, ids). */
export function loadCaseFile(file: string): FileCase[] {
  const parsed = JSON.parse(new TextDecoder('utf-8').decode(readFileSync(file))) as {
    manifest?: unknown;
    cases?: unknown;
  };
  if (parsed.manifest !== CASE_FILE_MANIFEST) {
    throw new Error(`cases.json manifest = ${JSON.stringify(parsed.manifest)}, want ${CASE_FILE_MANIFEST}`);
  }
  if (!Array.isArray(parsed.cases)) {
    throw new Error('cases.json: cases must be a sequence');
  }
  if (parsed.cases.length < MIN_CASE_COUNT) {
    throw new Error(`cases.json has ${parsed.cases.length} cases, want >= ${MIN_CASE_COUNT}`);
  }
  const seen = new Set<string>();
  const cases: FileCase[] = [];
  for (const raw of parsed.cases) {
    const c = convertCase(raw as Record<string, unknown>);
    if (c.id === undefined || c.id === '') {
      throw new Error('case with an empty id');
    }
    if (seen.has(c.id)) {
      throw new Error(`duplicate case id ${JSON.stringify(c.id)}`);
    }
    seen.add(c.id);
    if (c.kind !== 'document' && c.kind !== 'source') {
      throw new Error(`case ${c.id}: unknown kind ${JSON.stringify(c.kind)}`);
    }
    cases.push(c);
  }
  return cases;
}

/** Maps the snake_case case-file keys onto the camelCase schema. */
function convertCase(raw: Record<string, unknown>): FileCase {
  const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);
  const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);
  const obj = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const arr = (value: unknown): unknown[] | undefined => (Array.isArray(value) ? value : undefined);
  const ints = (value: unknown): readonly number[] | undefined => {
    const items = arr(value);
    return items !== undefined && items.every((item) => typeof item === 'number')
      ? (items as number[])
      : undefined;
  };

  const parseLimits = (value: unknown): ParseLimitsDesc | undefined => {
    const o = obj(value);
    if (o === undefined) {
      return undefined;
    }
    return {
      maxSourceBytes: num(o.max_source_bytes),
      maxNestingDepth: num(o.max_nesting_depth),
      maxTokenCount: num(o.max_token_count),
      maxNodeCount: num(o.max_node_count),
      maxDiagnostics: num(o.max_diagnostics),
    };
  };
  const queryLimits = (value: unknown): QueryLimitsDesc | undefined => {
    const o = obj(value);
    if (o === undefined) {
      return undefined;
    }
    return { maxResults: num(o.max_results), maxSteps: num(o.max_steps) };
  };
  const entryMapping = (value: unknown): EntryMappingDesc | undefined => {
    const o = obj(value);
    if (o === undefined) {
      return undefined;
    }
    return { keyJSON: str(o.key_json) ?? '', valueJSON: str(o.value_json) ?? '' };
  };
  const matLimits = (value: unknown): MaterializeLimitsDesc | undefined => {
    const o = obj(value);
    if (o === undefined) {
      return undefined;
    }
    return {
      maxOutputBytes: num(o.max_output_bytes),
      maxInputNodes: num(o.max_input_nodes),
      maxDepth: num(o.max_depth),
      maxProvenanceEntries: num(o.max_provenance_entries),
    };
  };
  const target = (value: unknown): TargetDesc | undefined => {
    const o = obj(value);
    if (o === undefined) {
      return undefined;
    }
    return { kind: str(o.kind) ?? '', ordinal: num(o.ordinal), foreign: bool(o.foreign) };
  };
  const valueDesc = (value: unknown): ValueDesc | undefined => {
    const o = obj(value);
    if (o === undefined) {
      return undefined;
    }
    return {
      null: bool(o.null),
      boolean: bool(o.boolean),
      integer: str(o.integer),
      decimal: str(o.decimal),
      string: str(o.string),
      binary64: str(o.binary64),
    };
  };
  const placement = (value: unknown): PlacementDesc | undefined => {
    const o = obj(value);
    if (o === undefined) {
      return undefined;
    }
    return { at: str(o.at), beforeOrdinal: num(o.before_ordinal), afterOrdinal: num(o.after_ordinal) };
  };
  const editOp = (value: unknown): EditOpDesc | undefined => {
    const o = obj(value);
    if (o === undefined) {
      return undefined;
    }
    return {
      operation: str(o.operation) ?? '',
      target: target(o.target),
      value: valueDesc(o.value),
      literalHex: str(o.literal_hex),
      name: str(o.name),
      policy: str(o.policy),
      placement: placement(o.placement),
    };
  };
  const step = (value: unknown): StepDesc | undefined => {
    const o = obj(value);
    if (o === undefined) {
      return undefined;
    }
    const filters = arr(o.filters)?.map((filter) => {
      const f = obj(filter) ?? {};
      return { operator: str(f.operator) ?? '', argument: f.argument };
    });
    return {
      op: str(o.op) ?? '',
      domain: str(o.domain),
      domainVersion: num(o.domain_version),
      filters,
      combine: str(o.combine),
      selection: str(o.selection),
      queryLimits: queryLimits(o.query_limits),
      target: str(o.target),
      duplicatePolicy: str(o.duplicate_policy),
      input: str(o.input),
      valueJSON: str(o.value_json),
      entryMapping: entryMapping(o.entry_mapping),
      targetProfile: str(o.target_profile),
      style: str(o.style),
      newline: str(o.newline),
      limits: matLimits(o.limits),
      operations: arr(o.operations)?.map(editOp).filter((op): op is EditOpDesc => op !== undefined),
    };
  };
  const input = (value: unknown): SourceInputDesc | undefined => {
    const o = obj(value);
    if (o === undefined) {
      return undefined;
    }
    return { rawHex: str(o.raw_hex), source: str(o.source) };
  };
  const request = (value: unknown): EncodingRequestDesc | undefined => {
    const o = obj(value);
    if (o === undefined) {
      return undefined;
    }
    return {
      profileDefault: str(o.profile_default) ?? '',
      declaration: str(o.declaration),
      callerOverride: str(o.caller_override),
      bomPolicy: str(o.bom_policy),
    };
  };
  const patch = (value: unknown): PatchDesc | undefined => {
    const o = obj(value);
    if (o === undefined) {
      return undefined;
    }
    const replacements = arr(o.replacements)?.map((replacement) => {
      const r = obj(replacement) ?? {};
      return {
        oldStart: num(r.old_start) ?? 0,
        oldEnd: num(r.old_end) ?? 0,
        replacementHex: str(r.replacement_hex) ?? '',
      };
    });
    return { replacements: replacements ?? [], applyTo: str(o.apply_to) };
  };

  return {
    id: str(raw.id) ?? '',
    kind: raw.kind === 'source' ? 'source' : 'document',
    format: str(raw.format),
    profile: str(raw.profile),
    source: str(raw.source),
    foreignSource: str(raw.foreign_source),
    foreignSourceHex: str(raw.foreign_source_hex),
    parseLimits: parseLimits(raw.parse_limits),
    steps: arr(raw.steps)?.map(step).filter((s): s is StepDesc => s !== undefined),
    input: input(raw.input),
    request: request(raw.request),
    positions: ints(raw.positions),
    patch: patch(raw.patch),
  };
}

// ---------------------------------------------------------------------------
// Fact vocabulary
// ---------------------------------------------------------------------------

/** The ordered key=value fact set of one case (the fixed key set). */
export class Facts {
  readonly lines: string[] = [];

  set(key: string, value: string): void {
    this.lines.push(`${key}=${value}`);
  }
}

/** Renders one ordered list into the `|`-joined fact vocabulary. */
export function join(items: readonly string[]): string {
  return items.join('|');
}

/** Renders one text value: JSON string escaping with lossy UTF-8 decoding. */
export function escapeText(text: string): string {
  let output = '';
  for (const character of text) {
    output += escapeChar(character);
  }
  return output;
}

function escapeChar(character: string): string {
  switch (character) {
    case '"':
      return '\\"';
    case '\\':
      return '\\\\';
    case '\b':
      return '\\b';
    case '\f':
      return '\\f';
    case '\n':
      return '\\n';
    case '\r':
      return '\\r';
    case '\t':
      return '\\t';
    default: {
      const code = character.codePointAt(0)!;
      if (code < 0x20) {
        return `\\u${code.toString(16).padStart(4, '0')}`;
      }
      return character;
    }
  }
}

/**
 * Renders one byte buffer with the Go runner's `escape` semantics (which
 * mirrors Rust's `from_utf8_lossy` byte for byte): invalid UTF-8 runs emit
 * one U+FFFD with the standard grouping rules, then the JSON string
 * escaping applies.
 */
export function escapeBytes(bytes: Uint8Array): string {
  let output = '';
  let index = 0;
  while (index < bytes.length) {
    const decoded = decodeRune(bytes, index);
    if (decoded.cp !== 0xfffd || decoded.literal) {
      output += escapeChar(String.fromCodePoint(decoded.cp));
      index += decoded.size;
      continue;
    }
    output += '�';
    index += decoded.size;
    if (decoded.size === 1) {
      const starter = bytes[index - 1];
      if (0xc2 <= starter && starter <= 0xf4) {
        const width = starter >= 0xf0 ? 4 : starter >= 0xe0 ? 3 : 2;
        let continuations = 0;
        while (
          index + continuations < bytes.length &&
          0x80 <= bytes[index + continuations] &&
          bytes[index + continuations] <= 0xbf
        ) {
          continuations++;
        }
        if (continuations < width - 1) {
          index += continuations;
        }
      }
    }
  }
  return output;
}

interface RuneDecode {
  readonly cp: number;
  readonly size: number;
  /** True when the bytes decode to a literal U+FFFD (EF BF BD). */
  readonly literal: boolean;
}

/** Decodes one rune from `bytes` at `index` (Go utf8.DecodeRuneInString). */
function decodeRune(bytes: Uint8Array, index: number): RuneDecode {
  const remaining = bytes.length - index;
  const b = bytes[index];
  if (b < 0x80) {
    return { cp: b, size: 1, literal: false };
  }
  if (0xc2 <= b && b <= 0xdf) {
    if (remaining < 2) {
      return { cp: 0xfffd, size: remaining, literal: false };
    }
    const c1 = bytes[index + 1];
    if (c1 < 0x80 || c1 > 0xbf) {
      return { cp: 0xfffd, size: 1, literal: false };
    }
    return { cp: ((b & 0x1f) << 6) | (c1 & 0x3f), size: 2, literal: false };
  }
  if (0xe0 <= b && b <= 0xef) {
    if (remaining < 3) {
      return { cp: 0xfffd, size: remaining, literal: false };
    }
    const c1 = bytes[index + 1];
    const c2 = bytes[index + 2];
    if (c1 < 0x80 || c1 > 0xbf || c2 < 0x80 || c2 > 0xbf) {
      return { cp: 0xfffd, size: 1, literal: false };
    }
    if ((b === 0xe0 && c1 < 0xa0) || (b === 0xed && c1 > 0x9f)) {
      return { cp: 0xfffd, size: 3, literal: false };
    }
    const cp = ((b & 0x0f) << 12) | ((c1 & 0x3f) << 6) | (c2 & 0x3f);
    return { cp, size: 3, literal: cp === 0xfffd };
  }
  if (0xf0 <= b && b <= 0xf4) {
    if (remaining < 4) {
      return { cp: 0xfffd, size: remaining, literal: false };
    }
    const c1 = bytes[index + 1];
    const c2 = bytes[index + 2];
    const c3 = bytes[index + 3];
    if (c1 < 0x80 || c1 > 0xbf || c2 < 0x80 || c2 > 0xbf || c3 < 0x80 || c3 > 0xbf) {
      return { cp: 0xfffd, size: 1, literal: false };
    }
    if ((b === 0xf0 && c1 < 0x90) || (b === 0xf4 && c1 > 0x8f)) {
      return { cp: 0xfffd, size: 4, literal: false };
    }
    const cp = ((b & 0x07) << 18) | ((c1 & 0x3f) << 12) | ((c2 & 0x3f) << 6) | (c3 & 0x3f);
    return { cp, size: 4, literal: cp === 0xfffd };
  }
  return { cp: 0xfffd, size: 1, literal: false };
}

// ---------------------------------------------------------------------------
// Profiles and limits
// ---------------------------------------------------------------------------

type JsonProfileName = 'JsonStrict' | 'JsoncBounded' | 'Json5Standard';
type YamlProfileName = 'Yaml12CoreV1' | 'Yaml11CompatV1';

function jsonProfileName(profile: string | undefined): JsonProfileName {
  switch (profile) {
    case 'json.strict@1':
      return 'JsonStrict';
    case 'jsonc.bounded@1':
      return 'JsoncBounded';
    case 'json5.standard@1':
      return 'Json5Standard';
    default:
      throw new Error(`unknown JSON profile ${JSON.stringify(profile)}`);
  }
}

function yamlProfileName(profile: string | undefined): YamlProfileName {
  switch (profile) {
    case 'yaml.1.2-core@1':
      return 'Yaml12CoreV1';
    case 'yaml.1.1-compat@1':
      return 'Yaml11CompatV1';
    default:
      throw new Error(`unknown YAML profile ${JSON.stringify(profile)}`);
  }
}

function iniProfile(profile: string | undefined): IniProfile {
  switch (profile) {
    case 'ini.portable@1':
      return IniProfile.PORTABLE_V1;
    case 'ini.windows@1':
      return IniProfile.WINDOWS_V1;
    case 'ini.python-configparser@1':
      return IniProfile.PYTHON_CONFIGPARSER_V1;
    default:
      throw new Error(`unknown INI profile ${JSON.stringify(profile)}`);
  }
}

/** Applies the descriptor overrides to the frozen parse limits. */
export function applyParseLimits(limits: ParseLimits, desc: ParseLimitsDesc | undefined): ParseLimits {
  if (desc === undefined) {
    return limits;
  }
  return {
    maxSourceBytes: desc.maxSourceBytes ?? limits.maxSourceBytes,
    maxNestingDepth: desc.maxNestingDepth ?? limits.maxNestingDepth,
    maxTokenCount: desc.maxTokenCount ?? limits.maxTokenCount,
    maxNodeCount: desc.maxNodeCount ?? limits.maxNodeCount,
    maxDiagnostics: desc.maxDiagnostics ?? limits.maxDiagnostics,
  };
}

// ---------------------------------------------------------------------------
// Document face
// ---------------------------------------------------------------------------

/** One document-face execution state. */
class DocState {
  format = '';
  profileName = '';
  foreignSource = '';
  foreignSourceHex = '';
  parseLimits: ParseLimits = DEFAULT_PARSE_LIMITS;
  iniLimits: IniParseLimits = DEFAULT_INI_PARSE_LIMITS;
  propertiesLimits: PropertiesParseLimits = DEFAULT_PROPERTIES_PARSE_LIMITS;

  jsonDocument: import('../../json/document.ts').JsonDocument | null = null;
  tomlDocument: import('../../toml/document.ts').TomlDocument | null = null;
  yamlDocument: import('../../yaml/document.ts').YamlDocument | null = null;
  iniDocument: import('../../ini/document.ts').IniDocument | null = null;
  propertiesDocument: import('../../properties/document.ts').PropertiesDocument | null = null;
  foreignJSON: import('../../json/document.ts').JsonDocument | null = null;
  foreignToml: import('../../toml/document.ts').TomlDocument | null = null;
  foreignYaml: import('../../yaml/document.ts').YamlDocument | null = null;
  foreignIni: import('../../ini/document.ts').IniDocument | null = null;
  foreignProperties: import('../../properties/document.ts').PropertiesDocument | null = null;

  formation = '';
  diagnosticCodes = '';
  rootKind = '';
  native = '';

  queryNativeRun = false;
  querySyntaxRun = false;
  projectRun = false;
  materializeRun = false;
  editRun = false;

  value: PortableValue | null = null;
  projected = false;

  documentParsed(): boolean {
    return (
      this.jsonDocument !== null ||
      this.tomlDocument !== null ||
      this.yamlDocument !== null ||
      this.iniDocument !== null ||
      this.propertiesDocument !== null
    );
  }
}

/** Runs one document-face case and returns its ordered facts. */
function runDocumentCase(c: FileCase): string[] {
  const facts = new Facts();
  const state = new DocState();
  state.format = c.format ?? '';
  state.profileName = c.profile ?? '';
  state.foreignSource = c.foreignSource ?? '';
  state.foreignSourceHex = c.foreignSourceHex ?? '';
  state.parseLimits = applyParseLimits(DEFAULT_PARSE_LIMITS, c.parseLimits);
  state.iniLimits = { ...DEFAULT_INI_PARSE_LIMITS, common: state.parseLimits };
  state.propertiesLimits = { ...DEFAULT_PROPERTIES_PARSE_LIMITS, common: state.parseLimits };

  if (!parseIntoState(state, c)) {
    facts.set('parse.formation', 'Fatal');
    facts.set('parse.fatal_code', state.formation);
    facts.set('parse.diagnostic_codes', '');
    facts.set('parse.root_kind', '');
    facts.set('parse.native', '');
    emitStepFacts(facts, state, undefined);
    return facts.lines;
  }
  facts.set('parse.formation', state.formation);
  facts.set('parse.fatal_code', '');
  facts.set('parse.diagnostic_codes', state.diagnosticCodes);
  facts.set('parse.root_kind', state.rootKind);
  facts.set('parse.native', state.native);

  for (const step of c.steps ?? []) {
    switch (step.op) {
      case 'parse':
        break;
      case 'query-native':
      case 'query-syntax':
      case 'project':
      case 'materialize':
      case 'edit':
        emitStepFacts(facts, state, step);
        break;
      default:
        throw new Error(`case ${c.id}: unknown step op ${JSON.stringify(step.op)}`);
    }
  }
  emitStepFacts(facts, state, undefined);
  return facts.lines;
}

/** Parses the case source and fills the parse facts; false = fatal. */
function parseIntoState(state: DocState, c: FileCase): boolean {
  const source = c.source ?? '';
  try {
    switch (c.format) {
      case 'json': {
        const document = parseJson(new TextEncoder().encode(source), jsonProfileName(c.profile), state.parseLimits);
        state.jsonDocument = document;
        state.formation = document.formationStatus();
        state.diagnosticCodes = diagnosticCodes(document.diagnostics());
        state.rootKind = jsonRootKind(document);
        state.native = jsonNativeValue(document.root(), 0);
        return true;
      }
      case 'toml': {
        const document = parseToml(new TextEncoder().encode(source), TomlProfile.TOML_10_V1, state.parseLimits);
        state.tomlDocument = document;
        state.formation = document.formationStatus();
        state.diagnosticCodes = diagnosticCodes(document.diagnostics());
        state.rootKind = document.root().kind();
        state.native = tomlNativeItem(document.root(), 0);
        return true;
      }
      case 'yaml': {
        const document = parseYaml(new TextEncoder().encode(source), yamlProfileName(c.profile), state.parseLimits);
        state.yamlDocument = document;
        state.formation = document.formationStatus();
        state.diagnosticCodes = diagnosticCodes(document.diagnostics());
        state.rootKind = yamlRootKind(document);
        state.native = yamlNativeSummary(document);
        return true;
      }
      case 'ini': {
        const document = parseIniDocument(
          new TextEncoder().encode(source),
          iniProfile(c.profile),
          profileDefaultSelection(),
          state.iniLimits,
        );
        state.iniDocument = document;
        state.formation = document.formationStatus();
        state.diagnosticCodes = diagnosticCodes(document.diagnostics());
        state.rootKind = 'Document';
        state.native = `sections=${document.sections().length} entries=${document.entries().length}`;
        return true;
      }
      case 'properties': {
        const document = parsePropertiesReader(new TextEncoder().encode(source), utf8Encoding(), state.propertiesLimits);
        state.propertiesDocument = document;
        state.formation = document.formationStatus();
        state.diagnosticCodes = diagnosticCodes(document.diagnostics());
        state.rootKind = 'Document';
        state.native = `properties=${document.properties().length} comments=${document.comments().length}`;
        return true;
      }
      default:
        throw new Error(`unknown case format ${JSON.stringify(c.format)}`);
    }
  } catch (error) {
    state.formation = formationCode(error);
    return false;
  }
}

/** The stable code of a fatal formation failure (the first diagnostic). */
function formationCode(error: unknown): string {
  const fatal = error as { diagnostics?: () => readonly { code: string }[]; code?: string };
  if (typeof fatal.diagnostics === 'function') {
    const diagnostics = fatal.diagnostics();
    if (diagnostics.length > 0) {
      return diagnostics[0].code;
    }
  }
  if (typeof fatal.code === 'string') {
    return fatal.code;
  }
  return '';
}

function diagnosticCodes(diagnostics: readonly { code: string }[]): string {
  return join(diagnostics.map((diagnostic) => diagnostic.code));
}

/** Renders the document-0 root node kind fact of a YAML stream. */
function yamlRootKind(document: import('../../yaml/document.ts').YamlDocument): string {
  if (document.documentCount() === 0) {
    return 'EmptyStream';
  }
  const doc = document.document(0);
  if (doc === null) {
    return 'EmptyStream';
  }
  return doc.root().kind();
}

/** Renders the stream-level native facts: document count and alias count. */
function yamlNativeSummary(document: import('../../yaml/document.ts').YamlDocument): string {
  return `docs=${document.documentCount()} aliases=${document.aliasCount()}`;
}

function semanticName(availability: { kind: 'Available'; value: unknown } | { kind: 'Unavailable'; reason: string }): string | null {
  return availability.kind === 'Available' ? null : `Unavailable:${availability.reason}`;
}

/** Renders one JSON native value in the canonical summary vocabulary. */
function jsonNativeValue(value: import('../../json/document.ts').JsonValue, depth: number): string {
  if (depth > 64) {
    return '...';
  }
  const kind = value.kind();
  if (kind.kind === 'Unavailable') {
    return `Unavailable:${kind.reason}`;
  }
  switch (kind.value) {
    case 'Null':
      return 'null';
    case 'Boolean': {
      const boolean = value.asBoolean();
      return boolean.kind === 'Available' && boolean.value !== null ? String(boolean.value) : '?';
    }
    case 'Integer': {
      const integer = value.asInteger();
      return integer.kind === 'Available' && integer.value !== null ? integer.value.toString() : '?';
    }
    case 'Decimal': {
      const decimal = value.asDecimal();
      return decimal.kind === 'Available' && decimal.value !== null
        ? `${decimal.value.coefficient}e${decimal.value.exponent}`
        : '?';
    }
    case 'BinaryFloat64': {
      const number = value.asBinaryFloat64();
      return number.kind === 'Available' && number.value !== null
        ? `0x${number.value.toString(16).padStart(16, '0')}`
        : '?';
    }
    case 'String': {
      const text = value.asString();
      return text.kind === 'Available' && text.value !== null ? `"${escapeText(text.value)}"` : '?';
    }
    case 'Array': {
      const elements = value.arrayElements();
      if (elements.kind === 'Unavailable') {
        return `Unavailable:${elements.reason}`;
      }
      if (elements.value === null) {
        return '?';
      }
      const parts = elements.value.map((element) => jsonNativeValue(element.value(), depth + 1));
      return `[${parts.join(',')}]`;
    }
    case 'Object': {
      const members = value.objectMembers();
      if (members.kind === 'Unavailable') {
        return `Unavailable:${members.reason}`;
      }
      if (members.value === null) {
        return '?';
      }
      const parts = members.value.map((member) => {
        const name = member.name();
        const renderedName = name.kind === 'Available' ? escapeText(name.value) : '?';
        return `"${renderedName}":${jsonNativeValue(member.value(), depth + 1)}`;
      });
      return `{${parts.join(',')}}`;
    }
  }
}

/** Renders the JSON root native kind fact. */
function jsonRootKind(document: import('../../json/document.ts').JsonDocument): string {
  const kind = document.root().kind();
  if (kind.kind === 'Unavailable') {
    return `Unavailable:${kind.reason}`;
  }
  return kind.value;
}

/** Renders one TOML native item in the canonical summary vocabulary. */
function tomlNativeItem(item: import('../../toml/document.ts').TomlItem, depth: number): string {
  if (depth > 64) {
    return '...';
  }
  switch (item.kind()) {
    case 'String': {
      const text = item.asString();
      return text !== null ? `"${escapeText(text)}"` : '?';
    }
    case 'Integer': {
      const number = item.asInteger();
      return number !== null ? number.toString() : '?';
    }
    case 'Float': {
      const bits = item.asFloatBits();
      return bits !== null ? `0x${bits.toString(16).padStart(16, '0')}` : '?';
    }
    case 'Boolean': {
      const value = item.asBoolean();
      return value !== null ? String(value) : '?';
    }
    case 'OffsetDateTime':
    case 'LocalDateTime':
    case 'LocalDate':
    case 'LocalTime': {
      const dateTime = item.asDateTime();
      return dateTime !== null ? tomlDateTimeSummary(dateTime) : '?';
    }
    case 'Array':
    case 'ArrayOfTables': {
      const elements = item.arrayElements();
      if (elements === null) {
        return '?';
      }
      const parts = elements.map((element) => tomlNativeItem(element.item(), depth + 1));
      return `[${parts.join(',')}]`;
    }
    case 'InlineTable':
    case 'RootTable':
    case 'StandardTable':
    case 'ImplicitTable':
    case 'DottedTable': {
      const entries = item.tableEntries();
      if (entries === null) {
        return '?';
      }
      const parts = entries.map((entry) => `"${escapeText(entry.name())}":${tomlNativeItem(entry.item(), depth + 1)}`);
      return `{${parts.join(',')}}`;
    }
  }
}

/** Renders one TOML date/time datum canonically. */
function tomlDateTimeSummary(dateTime: import('../../toml/parser.ts').TomlDateTime): string {
  const parts: string[] = [];
  if (dateTime.date !== null) {
    parts.push(
      `date=${dateTime.date.year.toString().padStart(4, '0')}-${dateTime.date.month.toString().padStart(2, '0')}-${dateTime.date.day.toString().padStart(2, '0')}`,
    );
  }
  if (dateTime.time !== null) {
    let text = `time=${dateTime.time.hour.toString().padStart(2, '0')}:${dateTime.time.minute.toString().padStart(2, '0')}:${dateTime.time.second.toString().padStart(2, '0')}`;
    if (dateTime.time.nanosecond !== 0) {
      text += `.${dateTime.time.nanosecond.toString().padStart(9, '0')}`;
    }
    parts.push(text);
  }
  if (dateTime.offset !== null) {
    if (dateTime.offset.kind === 'Z') {
      parts.push('offset=Z');
    } else {
      let minutes = dateTime.offset.minutes;
      const sign = minutes < 0 ? '-' : '+';
      if (minutes < 0) {
        minutes = -minutes;
      }
      parts.push(`offset=${sign}${Math.floor(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}`);
    }
  }
  return `datetime(${parts.join(',')})`;
}

// ---------------------------------------------------------------------------
// Query steps
// ---------------------------------------------------------------------------

/** The known native/syntax domain table (the Rust example's gate). */
function knownDomain(domainId: string, version: number): boolean {
  switch (domainId) {
    case 'json.native-semantic-query':
    case 'json.lossless-syntax-query':
      return version === 1 || version === 2;
    case 'toml.native-semantic-query':
    case 'toml.lossless-syntax-query':
    case 'yaml.native-semantic-query':
    case 'yaml.lossless-syntax-query':
    case 'ini.native-semantic-query':
    case 'ini.lossless-syntax-query':
    case 'java-properties.native-semantic-query':
    case 'java-properties.lossless-syntax-query':
      return version === 1;
    default:
      return false;
  }
}

function domain(step: StepDesc): { id: string; version: number } {
  return { id: step.domain ?? '', version: step.domainVersion ?? 1 };
}

function emitNativeQuery(facts: Facts, state: DocState, step: StepDesc | undefined): void {
  if (state.queryNativeRun) {
    return;
  }
  const blocked = (): void => {
    facts.set('query.native.status', 'Blocked');
    facts.set('query.native.failure', '');
    facts.set('query.native.count', '');
    facts.set('query.native.matches', '');
  };
  if (step === undefined || step.op !== 'query-native' || !state.documentParsed()) {
    state.queryNativeRun = true;
    blocked();
    return;
  }
  state.queryNativeRun = true;
  const dom = domain(step);
  if (!knownDomain(dom.id, dom.version)) {
    facts.set('query.native.status', 'Failed');
    facts.set('query.native.failure', 'core.query.domain-mismatch@1');
    facts.set('query.native.count', '');
    facts.set('query.native.matches', '');
    return;
  }
  const executable = buildQueryDefinition(step, dom);
  if ('failure' in executable) {
    facts.set('query.native.status', 'Failed');
    facts.set('query.native.failure', executable.failure.code);
    facts.set('query.native.count', '');
    facts.set('query.native.matches', '');
    return;
  }
  const limits = queryLimits(step);
  try {
    const items = runNativeQuery(executable.query, state, limits);
    facts.set('query.native.status', 'Completed');
    facts.set('query.native.failure', '');
    facts.set('query.native.count', String(items.length));
    facts.set('query.native.matches', join(items));
  } catch (error) {
    facts.set('query.native.status', 'Failed');
    facts.set('query.native.failure', errorCode(error));
    facts.set('query.native.count', '');
    facts.set('query.native.matches', '');
  }
}

function emitSyntaxQuery(facts: Facts, state: DocState, step: StepDesc | undefined): void {
  if (state.querySyntaxRun) {
    return;
  }
  const blocked = (): void => {
    facts.set('query.syntax.status', 'Blocked');
    facts.set('query.syntax.failure', '');
    facts.set('query.syntax.count', '');
    facts.set('query.syntax.matches', '');
  };
  if (step === undefined || step.op !== 'query-syntax' || !state.documentParsed()) {
    state.querySyntaxRun = true;
    blocked();
    return;
  }
  state.querySyntaxRun = true;
  const dom = domain(step);
  if (!knownDomain(dom.id, dom.version)) {
    facts.set('query.syntax.status', 'Failed');
    facts.set('query.syntax.failure', 'core.query.domain-mismatch@1');
    facts.set('query.syntax.count', '');
    facts.set('query.syntax.matches', '');
    return;
  }
  const executable = buildQueryDefinition(step, dom);
  if ('failure' in executable) {
    facts.set('query.syntax.status', 'Failed');
    facts.set('query.syntax.failure', executable.failure.code);
    facts.set('query.syntax.count', '');
    facts.set('query.syntax.matches', '');
    return;
  }
  const limits = queryLimits(step);
  try {
    const items = runSyntaxQuery(executable.query, state, limits);
    facts.set('query.syntax.status', 'Completed');
    facts.set('query.syntax.failure', '');
    facts.set('query.syntax.count', String(items.length));
    facts.set('query.syntax.matches', join(items));
  } catch (error) {
    facts.set('query.syntax.status', 'Failed');
    facts.set('query.syntax.failure', errorCode(error));
    facts.set('query.syntax.count', '');
    facts.set('query.syntax.matches', '');
  }
}

interface QueryLimitsValue {
  maxSteps: number;
  maxResults: number;
}

function queryLimits(step: StepDesc): QueryLimitsValue {
  const limits: QueryLimitsValue = { maxSteps: 100_000, maxResults: 100_000 };
  if (step.queryLimits !== undefined) {
    if (step.queryLimits.maxResults !== undefined) {
      limits.maxResults = step.queryLimits.maxResults;
    }
    if (step.queryLimits.maxSteps !== undefined) {
      limits.maxSteps = step.queryLimits.maxSteps;
    }
  }
  return limits;
}

/** Dispatches one native query to the parsed family. */
function runNativeQuery(executable: ExecutableQuery, state: DocState, limits: QueryLimitsValue): string[] {
  if (state.jsonDocument !== null) {
    const result = executeJsonQuery(
      executable,
      state.jsonDocument,
      new JsonQueryLimits(limits.maxSteps, limits.maxResults),
      new JsonCancellationToken(),
    );
    return result.matches().map(jsonNativeMatch);
  }
  if (state.tomlDocument !== null) {
    const result = executeTomlQuery(executable, state.tomlDocument, limits, new TomlCancellationToken());
    return result.matches.map(tomlNativeMatch);
  }
  if (state.yamlDocument !== null) {
    const result = executeYamlQuery(
      executable,
      state.yamlDocument,
      new YamlQueryLimits(limits.maxSteps, limits.maxResults),
      new YamlCancellationToken(),
    );
    return result.matches().map(yamlNativeMatch);
  }
  if (state.iniDocument !== null) {
    const result = executeIniQuery(executable, state.iniDocument, limits, new IniCancellationToken());
    return result.matches.map(iniNativeMatch);
  }
  if (state.propertiesDocument !== null) {
    const result = executePropertiesQuery(
      executable,
      state.propertiesDocument,
      new PropertiesQueryLimits(limits.maxSteps, limits.maxResults),
      new PropertiesCancellationToken(),
    );
    return result.matches().map(propertiesNativeMatch);
  }
  throw new Error('no parsed document');
}

/** Dispatches one syntax query to the parsed family. */
function runSyntaxQuery(executable: ExecutableQuery, state: DocState, limits: QueryLimitsValue): string[] {
  if (state.jsonDocument !== null) {
    const result = executeJsonSyntaxQuery(
      executable,
      state.jsonDocument,
      new JsonQueryLimits(limits.maxSteps, limits.maxResults),
      new JsonCancellationToken(),
    );
    return result.matches().map((match) => `${match.kind()}@${match.ordinal()}`);
  }
  if (state.tomlDocument !== null) {
    const result = executeTomlSyntaxQuery(executable, state.tomlDocument, limits, new TomlCancellationToken());
    return result.matches.map((match) => `${match.kind()}@${match.ordinal()}`);
  }
  if (state.yamlDocument !== null) {
    const result = executeYamlSyntaxQuery(
      executable,
      state.yamlDocument,
      new YamlQueryLimits(limits.maxSteps, limits.maxResults),
      new YamlCancellationToken(),
    );
    return result.matches().map((match) => `${match.kind()}@${match.ordinal()}`);
  }
  if (state.iniDocument !== null) {
    const result = executeIniSyntaxQuery(executable, state.iniDocument, limits, new IniCancellationToken());
    return result.matches.map((match) => `${match.kind()}@${match.ordinal()}`);
  }
  if (state.propertiesDocument !== null) {
    const result = executePropertiesSyntaxQuery(
      executable,
      state.propertiesDocument,
      new PropertiesQueryLimits(limits.maxSteps, limits.maxResults),
      new PropertiesCancellationToken(),
    );
    return result.matches().map((match) => `${match.kind()}@${match.ordinal()}`);
  }
  throw new Error('no parsed document');
}

/** Renders one JSON native match identity fact. */
function jsonNativeMatch(match: import('../../json/query.ts').JsonMatch): string {
  switch (match.kind) {
    case 'Value':
      return `V:${match.valueKind ?? '?'}`;
    case 'ObjectMember':
      return `M:${match.ordinal}:${match.name !== null ? escapeText(match.name) : '?'}`;
    case 'ArrayElement':
      return `E:${match.ordinal}`;
  }
}

/** Renders one TOML native match identity fact. */
function tomlNativeMatch(match: TomlMatch): string {
  switch (match.kind) {
    case 'Item':
      return `I:${match.itemKind}`;
    case 'Entry':
      return `M:${match.ordinal}:${escapeText(match.name)}`;
    case 'ArrayElement':
      return `E:${match.ordinal}`;
  }
}

/** Renders one YAML native match identity fact. */
function yamlNativeMatch(match: import('../../yaml/query.ts').YamlMatch): string {
  switch (match.kind) {
    case 'Stream':
      return 'Stream:0';
    case 'Document':
      return `Document:${match.ordinal}`;
    case 'Node':
      return `Node:${match.nodeKind}`;
    case 'MappingEntry':
      return `MappingEntry:${match.ordinal}`;
    case 'SequenceElement':
      return `SequenceElement:${match.ordinal}`;
    case 'AnchorDefinition':
      return `AnchorDefinition:${escapeText(match.name)}`;
    case 'AliasOccurrence':
      return `AliasOccurrence:${match.ordinal}`;
  }
}

/** Renders one INI native match identity fact. */
function iniNativeMatch(match: IniMatch): string {
  return match.kind === 'Document' ? 'Document:0' : `${match.kind}:${match.ordinal}`;
}

/** Renders one Properties native match identity fact. */
function propertiesNativeMatch(match: import('../../properties/query.ts').PropertiesMatch): string {
  return match.kind === 'Document' ? 'Document:0' : `${match.kind}:${match.ordinal}`;
}

/** Builds the executable from the declarative filters. */
function buildQueryDefinition(
  step: StepDesc,
  dom: { id: string; version: number },
): { query: ExecutableQuery } | { failure: { code: string } } {
  const format = dom.id.startsWith('toml.')
    ? 'toml'
    : dom.id.startsWith('yaml.')
      ? 'yaml'
      : dom.id.startsWith('ini.')
        ? 'ini'
        : dom.id.startsWith('java-properties.')
          ? 'properties'
          : 'json';
  const calls: import('../../protocol/query.ts').OperatorCall[] = [];
  for (const filter of step.filters ?? []) {
    const argument = filter.argument;
    const operatorId = argumentOperatorId(filter.operator, format);
    const argumentName = argumentOperatorName(filter.operator);
    let call = newOperatorCall(operatorId, 1);
    if (argument !== undefined && argumentName !== null) {
      call = withArgument(call, argumentName, valueFromInput(argument));
    } else if (argument === undefined && argumentName !== null) {
      return {
        failure: new QueryFailure({
          kind: 'InvalidArgument',
          operator: filter.operator,
          argument: 'argument',
        }),
      };
    }
    calls.push(call);
  }
  let expression: import('../../protocol/query.ts').QueryExpression;
  switch (step.combine ?? 'Single') {
    case 'Single':
    case '': {
      expression = { kind: 'Input' };
      for (const call of calls) {
        expression = { kind: 'Apply', input: expression, operator: call };
      }
      break;
    }
    case 'StructureOrderMerge':
      expression = {
        kind: 'StructureOrderMerge',
        branches: calls.map((call) => ({ kind: 'Apply', input: { kind: 'Input' }, operator: call })),
      };
      break;
    case 'Concat':
      expression = {
        kind: 'Concat',
        branches: calls.map((call) => ({ kind: 'Apply', input: { kind: 'Input' }, operator: call })),
      };
      break;
    default:
      return {
        failure: new QueryFailure({
          kind: 'InvalidArgument',
          operator: 'vector',
          argument: step.combine ?? '',
        }),
      };
  }
  let selection: import('../../protocol/query.ts').QuerySelection;
  switch (step.selection ?? 'All') {
    case 'All':
    case '':
      selection = 'All';
      break;
    case 'First':
      selection = 'First';
      break;
    case 'Last':
      selection = 'Last';
      break;
    case 'ZeroOrOne':
      selection = 'ZeroOrOne';
      break;
    case 'RequireOne':
      selection = 'RequireOne';
      break;
    default:
      return {
        failure: new QueryFailure({
          kind: 'InvalidArgument',
          operator: 'vector',
          argument: step.selection ?? '',
        }),
      };
  }
  let definition: QueryDefinition = newQueryDefinition(newQueryDomain(dom.id, dom.version));
  definition = withExpression(definition, expression);
  definition = withSelection(definition, selection);
  const validated = validateQuery(definition);
  if ('failure' in validated) {
    return { failure: validated.failure };
  }
  const capabilities = new CapabilitySet();
  capabilities.insert(newCapabilityId('core.query.ordered-results', 1));
  const bound = bindQuery(validated.query, capabilities);
  if ('failure' in bound) {
    return { failure: bound.failure };
  }
  return { query: bound.query };
}

/** Maps one declarative filter operator to its registry operator id. */
function argumentOperatorId(operator: string, format: string): string {
  switch (operator) {
    case 'kind-is':
      return `${format}.syntax-kind-is`;
    case 'text-equals':
      return `${format}.syntax-text-equals`;
    case 'take':
      return 'core.take';
    default:
      return operator;
  }
}

/** The argument name of one declarative filter operator; null = no argument. */
function argumentOperatorName(operator: string): string | null {
  switch (operator) {
    case 'kind-is':
      return 'kind';
    case 'text-equals':
      return 'text';
    case 'take':
      return 'count';
    case 'json.member-name-equals':
    case 'toml.entry-name-equals':
      return 'name';
    case 'yaml.where-node-kind':
      return 'kind';
    case 'yaml.where-tag':
      return 'tag';
    case 'yaml.scalar-canonical-equals':
      return 'canonical';
    case 'ini.entry-value-state-is':
    case 'properties.property-value-state-is':
      return 'state';
    default:
      return null;
  }
}

/** Extracts the frozen registered code of any harness error. */
function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

// ---------------------------------------------------------------------------
// Projection / materialization / edit steps
// ---------------------------------------------------------------------------

/** The neutral kind vocabulary (the array kind is "Sequence" on the PVCE surface). */
function neutralKindName(kind: string): string {
  return kind === 'Array' ? 'Sequence' : kind;
}

function emitProject(facts: Facts, state: DocState, step: StepDesc | undefined): void {
  if (state.projectRun) {
    return;
  }
  const blocked = (): void => {
    facts.set('project.status', 'Blocked');
    facts.set('project.failure', '');
    facts.set('project.fidelity', '');
    facts.set('project.value_kind', '');
    facts.set('project.report', '');
    facts.set('project.provenance_entries', '');
  };
  if (step === undefined || step.op !== 'project' || !state.documentParsed()) {
    state.projectRun = true;
    blocked();
    return;
  }
  state.projectRun = true;
  if (state.jsonDocument !== null) {
    const target = projectTarget(step.target);
    let builder = new ProjectionRequestBuilder(target);
    if (step.duplicatePolicy === 'FirstWins' || step.duplicatePolicy === 'LastWins') {
      builder = builder.withGlobalDuplicatePolicy(step.duplicatePolicy);
    }
    const request = builder.build();
    const result = projectJson(state.jsonDocument, request);
    if (result.kind === 'Failed') {
      facts.set('project.status', 'Failed');
      facts.set('project.failure', result.value.diagnostics()[0].code);
      facts.set('project.fidelity', '');
      facts.set('project.value_kind', '');
      facts.set('project.report', jsonEventSummary(result.value.report()));
      facts.set('project.provenance_entries', '');
      return;
    }
    state.value = result.value.value();
    state.projected = true;
    facts.set('project.status', 'Completed');
    facts.set('project.failure', '');
    facts.set('project.fidelity', result.value.fidelity());
    facts.set('project.value_kind', neutralKindName(result.value.value().kind));
    facts.set('project.report', jsonEventSummary(result.value.report()));
    facts.set('project.provenance_entries', String(result.value.provenance().entries().length));
    return;
  }
  if (state.tomlDocument !== null) {
    const result = projectToml(state.tomlDocument, new TomlProjectionRequest('BestExactCoreV1'));
    if (result.kind === 'Failed') {
      facts.set('project.status', 'Failed');
      facts.set('project.failure', result.value.diagnostics()[0].code);
      facts.set('project.fidelity', '');
      facts.set('project.value_kind', '');
      facts.set('project.report', tomlReportSummary(result.value.report()));
      facts.set('project.provenance_entries', '');
      return;
    }
    state.value = result.value.value();
    state.projected = true;
    facts.set('project.status', 'Completed');
    facts.set('project.failure', '');
    facts.set('project.fidelity', result.value.fidelity());
    facts.set('project.value_kind', neutralKindName(result.value.value().kind));
    facts.set('project.report', tomlReportSummary(result.value.report()));
    facts.set('project.provenance_entries', String(result.value.provenance().entries().length));
    return;
  }
  if (state.yamlDocument !== null) {
    const result = projectValueComplete(state.yamlDocument, ValueProjectionRequest.bestExactV1());
    if (result.kind === 'Failed') {
      facts.set('project.status', 'Failed');
      facts.set('project.failure', result.failure.code);
      facts.set('project.fidelity', '');
      facts.set('project.value_kind', '');
      facts.set('project.report', '');
      facts.set('project.provenance_entries', '');
      return;
    }
    state.value = result.complete.value;
    state.projected = true;
    facts.set('project.status', 'Completed');
    facts.set('project.failure', '');
    facts.set('project.fidelity', result.complete.fidelity);
    facts.set('project.value_kind', neutralKindName(result.complete.value.kind));
    facts.set('project.report', yamlEventSummary(result.complete.report.events()));
    facts.set('project.provenance_entries', String(result.complete.provenance.entries().length));
    return;
  }
  if (state.iniDocument !== null) {
    const result = projectIni(state.iniDocument, IniProjectionRequest.bestExactEntryMapping());
    if (result.kind === 'Failed') {
      facts.set('project.status', 'Failed');
      facts.set('project.failure', result.value.diagnostics()[0].code);
      facts.set('project.fidelity', '');
      facts.set('project.value_kind', '');
      facts.set('project.report', iniEventSummary(result.value.report()));
      facts.set('project.provenance_entries', '');
      return;
    }
    state.value = result.value.value();
    state.projected = true;
    facts.set('project.status', 'Completed');
    facts.set('project.failure', '');
    facts.set('project.fidelity', result.value.fidelity());
    facts.set('project.value_kind', neutralKindName(result.value.value().kind));
    facts.set('project.report', iniEventSummary(result.value.report()));
    facts.set('project.provenance_entries', String(result.value.provenance().entries().length));
    return;
  }
  if (state.propertiesDocument !== null) {
    const result = projectProperties(state.propertiesDocument, PropertiesProjectionRequest.bestExactEntryMapping());
    if (result.kind === 'Failed') {
      facts.set('project.status', 'Failed');
      facts.set('project.failure', result.value.diagnostics()[0].code);
      facts.set('project.fidelity', '');
      facts.set('project.value_kind', '');
      facts.set('project.report', propertiesEventSummary(result.value.report()));
      facts.set('project.provenance_entries', '');
      return;
    }
    state.value = result.value.value();
    state.projected = true;
    facts.set('project.status', 'Completed');
    facts.set('project.failure', '');
    facts.set('project.fidelity', result.value.fidelity());
    facts.set('project.value_kind', neutralKindName(result.value.value().kind));
    facts.set('project.report', propertiesEventSummary(result.value.report()));
    facts.set('project.provenance_entries', String(result.value.provenance().entries().length));
  }
}

function projectTarget(target: string | undefined): import('../../json/projection.ts').ProjectionTarget {
  switch (target) {
    case 'ProjectAsObject':
      return 'ProjectAsObjectV1';
    case 'ProjectAsEntryMapping':
      return 'ProjectAsEntryMappingV1';
    case 'Json5BestExactCore':
      return 'Json5BestExactCoreV1';
    default:
      return 'BestExactCoreV1';
  }
}

/** Renders the JSON projection report as ordered EventKind:count pairs. */
function jsonEventSummary(report: import('../../json/projection.ts').ProjectionReport): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const event of report.events()) {
    const name = event.kind();
    if (!counts.has(name)) {
      order.push(name);
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return join(order.map((name) => `${name}:${counts.get(name)}`));
}

/** Renders the TOML projection report as ordered diagnostic codes. */
function tomlReportSummary(report: import('../../toml/projection.ts').TomlProjectionReport): string {
  return diagnosticCodes(report.events());
}

/** Renders the YAML projection report as ordered EventKind:count pairs. */
function yamlEventSummary(events: readonly import('../../yaml/projection.ts').ProjectionEvent[]): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const event of events) {
    const name = event.kind;
    if (!counts.has(name)) {
      order.push(name);
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return join(order.map((name) => `${name}:${counts.get(name)}`));
}

/** Renders the INI projection report as ordered EventKind:count pairs. */
function iniEventSummary(report: import('../../ini/projection.ts').IniProjectionReport): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const event of report.events()) {
    const name = event.kind();
    if (!counts.has(name)) {
      order.push(name);
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return join(order.map((name) => `${name}:${counts.get(name)}`));
}

/** Renders the Properties projection report as ordered event-code:count pairs. */
function propertiesEventSummary(report: import('../../properties/projection.ts').ProjectionReport): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const event of report.events()) {
    const name = event.code();
    if (!counts.has(name)) {
      order.push(name);
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return join(order.map((name) => `${name}:${counts.get(name)}`));
}

function emitMaterialize(facts: Facts, state: DocState, step: StepDesc | undefined): void {
  if (state.materializeRun) {
    return;
  }
  const blocked = (): void => {
    facts.set('materialize.status', 'Blocked');
    facts.set('materialize.failure', '');
    facts.set('materialize.output', '');
    facts.set('materialize.fidelity', '');
  };
  if (step === undefined || step.op !== 'materialize' || !state.documentParsed()) {
    state.materializeRun = true;
    blocked();
    return;
  }
  state.materializeRun = true;
  let value: PortableValue;
  switch (step.input ?? 'project') {
    case 'project':
    case '': {
      if (!state.projected) {
        blocked();
        return;
      }
      value = state.value!;
      break;
    }
    case 'value': {
      const decoded = decodeMaterializeValue(step);
      if (decoded === null) {
        facts.set('materialize.status', 'Failed');
        facts.set('materialize.failure', 'core.protocol.invalid-value@1');
        facts.set('materialize.output', '');
        facts.set('materialize.fidelity', '');
        return;
      }
      value = decoded;
      break;
    }
    default:
      facts.set('materialize.status', 'Failed');
      facts.set('materialize.failure', 'core.protocol.invalid-value@1');
      facts.set('materialize.output', '');
      facts.set('materialize.fidelity', '');
      return;
  }
  const request = buildMaterializationRequest(step);
  if (request === null) {
    facts.set('materialize.status', 'Failed');
    facts.set('materialize.failure', 'core.materialization.invalid-request@1');
    facts.set('materialize.output', '');
    facts.set('materialize.fidelity', '');
    return;
  }
  if (state.jsonDocument !== null) {
    const result = materializeJson(value, request);
    if (result.kind === 'Complete') {
      facts.set('materialize.status', 'Completed');
      facts.set('materialize.failure', '');
      facts.set('materialize.output', escapeBytes(result.value.document().render()));
      facts.set('materialize.fidelity', result.value.fidelity());
      return;
    }
    facts.set('materialize.status', 'Failed');
    facts.set('materialize.failure', result.value.failure().code);
    facts.set('materialize.output', '');
    facts.set('materialize.fidelity', '');
    return;
  }
  if (state.tomlDocument !== null) {
    const result = materializeToml(value, request);
    if (result.kind === 'Complete') {
      facts.set('materialize.status', 'Completed');
      facts.set('materialize.failure', '');
      facts.set('materialize.output', escapeBytes(result.value.document().render()));
      facts.set('materialize.fidelity', result.value.fidelity());
      return;
    }
    facts.set('materialize.status', 'Failed');
    facts.set('materialize.failure', result.value.failure().code);
    facts.set('materialize.output', '');
    facts.set('materialize.fidelity', '');
    return;
  }
  if (state.yamlDocument !== null) {
    const result = materializeYaml(value, request);
    if (result.kind === 'Complete') {
      facts.set('materialize.status', 'Completed');
      facts.set('materialize.failure', '');
      facts.set('materialize.output', escapeBytes(result.value.document().render()));
      facts.set('materialize.fidelity', result.value.fidelity());
      return;
    }
    facts.set('materialize.status', 'Failed');
    facts.set('materialize.failure', result.value.failure().code);
    facts.set('materialize.output', '');
    facts.set('materialize.fidelity', '');
    return;
  }
  if (state.iniDocument !== null) {
    const result = materializeIni(value, request);
    if (result.kind === 'Complete') {
      facts.set('materialize.status', 'Completed');
      facts.set('materialize.failure', '');
      facts.set('materialize.output', escapeBytes(result.value.document().render()));
      facts.set('materialize.fidelity', result.value.fidelity());
      return;
    }
    facts.set('materialize.status', 'Failed');
    facts.set('materialize.failure', result.value.failure().code);
    facts.set('materialize.output', '');
    facts.set('materialize.fidelity', '');
    return;
  }
  if (state.propertiesDocument !== null) {
    const result = materializeProperties(value, request);
    if (result.kind === 'Complete') {
      facts.set('materialize.status', 'Completed');
      facts.set('materialize.failure', '');
      facts.set('materialize.output', escapeBytes(result.value.document().render()));
      facts.set('materialize.fidelity', result.value.fidelity());
      return;
    }
    facts.set('materialize.status', 'Failed');
    facts.set('materialize.failure', result.value.failure().code);
    facts.set('materialize.output', '');
    facts.set('materialize.fidelity', '');
  }
}

/** Decodes the materialize input descriptor through the canonical transport JSON decoder. */
function decodeMaterializeValue(step: StepDesc): PortableValue | null {
  if (step.entryMapping !== undefined) {
    try {
      const key = DecodeJSON(new TextEncoder().encode(step.entryMapping.keyJSON), defaultProtocolLimits());
      const value = DecodeJSON(new TextEncoder().encode(step.entryMapping.valueJSON), defaultProtocolLimits());
      return entryMappingValue([{ key, value }]);
    } catch {
      return null;
    }
  }
  try {
    return DecodeJSON(new TextEncoder().encode(step.valueJSON ?? ''), defaultProtocolLimits());
  } catch {
    return null;
  }
}

/** Builds the materialization request from the descriptor; null = invalid. */
function buildMaterializationRequest(step: StepDesc): MaterializationRequest | null {
  const targetProfile = step.targetProfile ?? '';
  const style = step.style ?? '';
  if (targetProfile === '' || style === '') {
    return null;
  }
  const targetId = targetProfile.split('@')[0];
  const styleId = style.split('@')[0];
  let request = new MaterializationRequest(new ProfileId(targetId, 1), new MaterializationStyleId(styleId, 1));
  switch (step.newline ?? 'Lf') {
    case 'None':
      request = request.withNewline('None');
      break;
    case 'CrLf':
      request = request.withNewline('CrLf');
      break;
    default:
      request = request.withNewline('Lf');
      break;
  }
  if (step.limits !== undefined) {
    const limits: MaterializationLimits = {
      maxInputNodes: step.limits.maxInputNodes ?? DEFAULT_MATERIALIZATION_LIMITS.maxInputNodes,
      maxOutputBytes: step.limits.maxOutputBytes ?? DEFAULT_MATERIALIZATION_LIMITS.maxOutputBytes,
      maxDepth: step.limits.maxDepth ?? DEFAULT_MATERIALIZATION_LIMITS.maxDepth,
      maxReportEntries: DEFAULT_MATERIALIZATION_LIMITS.maxReportEntries,
      maxProvenanceEntries: step.limits.maxProvenanceEntries ?? DEFAULT_MATERIALIZATION_LIMITS.maxProvenanceEntries,
    };
    request = request.withLimits(limits);
  }
  return request;
}

function emitEdit(facts: Facts, state: DocState, step: StepDesc | undefined): void {
  if (state.editRun) {
    return;
  }
  const blocked = (): void => {
    facts.set('edit.status', 'Blocked');
    facts.set('edit.failure', '');
    facts.set('edit.output', '');
    facts.set('edit.source_edit_count', '');
  };
  if (step === undefined || step.op !== 'edit' || !state.documentParsed()) {
    state.editRun = true;
    blocked();
    return;
  }
  state.editRun = true;
  if (state.jsonDocument !== null) {
    if (!ensureForeign(state)) {
      facts.set('edit.status', 'Failed');
      facts.set('edit.failure', 'core.source.invalid-sequence@1');
      facts.set('edit.output', '');
      facts.set('edit.source_edit_count', '');
      return;
    }
    const builder = new JsonEditTransactionBuilder(state.jsonDocument);
    if (!applyJsonEditOperations(builder, state, step)) {
      facts.set('edit.status', 'Failed');
      facts.set('edit.failure', 'core.edit.target-not-found@1');
      facts.set('edit.output', '');
      facts.set('edit.source_edit_count', '');
      return;
    }
    try {
      const commit = commitJsonEdits(state.jsonDocument, builder.build());
      facts.set('edit.status', 'Completed');
      facts.set('edit.failure', '');
      facts.set('edit.output', escapeBytes(commit.document().render()));
      facts.set('edit.source_edit_count', String(commit.changeSet().sourceEdits().length));
    } catch (error) {
      facts.set('edit.status', 'Failed');
      facts.set('edit.failure', errorCode(error));
      facts.set('edit.output', '');
      facts.set('edit.source_edit_count', '');
    }
    return;
  }
  if (state.tomlDocument !== null) {
    const builder = new TomlEditTransactionBuilder(state.tomlDocument);
    if (!applyTomlEditOperations(builder, state, step)) {
      facts.set('edit.status', 'Failed');
      facts.set('edit.failure', 'core.edit.target-not-found@1');
      facts.set('edit.output', '');
      facts.set('edit.source_edit_count', '');
      return;
    }
    try {
      const commit = commitTomlEdits(state.tomlDocument, builder.build());
      facts.set('edit.status', 'Completed');
      facts.set('edit.failure', '');
      facts.set('edit.output', escapeBytes(commit.document().render()));
      facts.set('edit.source_edit_count', String(commit.changeSet().sourceEdits().length));
    } catch (error) {
      facts.set('edit.status', 'Failed');
      facts.set('edit.failure', errorCode(error));
      facts.set('edit.output', '');
      facts.set('edit.source_edit_count', '');
    }
    return;
  }
  if (state.yamlDocument !== null) {
    const builder = new YamlEditTransactionBuilder(state.yamlDocument);
    if (!applyYamlEditOperations(builder, state, step)) {
      facts.set('edit.status', 'Failed');
      facts.set('edit.failure', 'core.edit.target-not-found@1');
      facts.set('edit.output', '');
      facts.set('edit.source_edit_count', '');
      return;
    }
    try {
      const commit = commitYamlEdits(state.yamlDocument, builder.build());
      facts.set('edit.status', 'Completed');
      facts.set('edit.failure', '');
      facts.set('edit.output', escapeBytes(commit.document().render()));
      facts.set('edit.source_edit_count', String(commit.changeSet().sourceEdits().length));
    } catch (error) {
      facts.set('edit.status', 'Failed');
      facts.set('edit.failure', errorCode(error));
      facts.set('edit.output', '');
      facts.set('edit.source_edit_count', '');
    }
    return;
  }
  if (state.iniDocument !== null) {
    const builder = new IniEditTransactionBuilder(state.iniDocument);
    if (!applyIniEditOperations(builder, state, step)) {
      facts.set('edit.status', 'Failed');
      facts.set('edit.failure', 'core.edit.target-not-found@1');
      facts.set('edit.output', '');
      facts.set('edit.source_edit_count', '');
      return;
    }
    try {
      const commit = commitIniEdits(state.iniDocument, builder.build());
      facts.set('edit.status', 'Completed');
      facts.set('edit.failure', '');
      facts.set('edit.output', escapeBytes(commit.document().render()));
      facts.set('edit.source_edit_count', String(commit.changeSet().sourceEdits().length));
    } catch (error) {
      facts.set('edit.status', 'Failed');
      facts.set('edit.failure', errorCode(error));
      facts.set('edit.output', '');
      facts.set('edit.source_edit_count', '');
    }
    return;
  }
  if (state.propertiesDocument !== null) {
    const builder = new PropertiesEditTransactionBuilder(state.propertiesDocument);
    if (!applyPropertiesEditOperations(builder, state, step)) {
      facts.set('edit.status', 'Failed');
      facts.set('edit.failure', 'core.edit.target-not-found@1');
      facts.set('edit.output', '');
      facts.set('edit.source_edit_count', '');
      return;
    }
    try {
      const commit = commitPropertiesEdits(state.propertiesDocument, builder.build());
      facts.set('edit.status', 'Completed');
      facts.set('edit.failure', '');
      facts.set('edit.output', escapeBytes(commit.document().render()));
      facts.set('edit.source_edit_count', String(commit.changeSet().sourceEdits().length));
    } catch (error) {
      facts.set('edit.status', 'Failed');
      facts.set('edit.failure', errorCode(error));
      facts.set('edit.output', '');
      facts.set('edit.source_edit_count', '');
    }
  }
}

/** Parses the foreign source when the case declares one; false = invalid. */
function ensureForeign(state: DocState): boolean {
  if (
    state.foreignJSON !== null ||
    state.foreignToml !== null ||
    state.foreignYaml !== null ||
    state.foreignIni !== null ||
    state.foreignProperties !== null ||
    (state.foreignSource === '' && state.foreignSourceHex === '')
  ) {
    return true;
  }
  let foreignBytes: Uint8Array;
  if (state.foreignSourceHex !== '') {
    const decoded = decodeHex(state.foreignSourceHex);
    if (decoded === null) {
      return false;
    }
    foreignBytes = decoded;
  } else {
    foreignBytes = new TextEncoder().encode(state.foreignSource);
  }
  try {
    switch (state.format) {
      case 'json': {
        const document = parseJson(foreignBytes, jsonProfileName(state.profileName), state.parseLimits);
        state.foreignJSON = document;
        return true;
      }
      case 'toml': {
        const document = parseToml(foreignBytes, TomlProfile.TOML_10_V1, state.parseLimits);
        state.foreignToml = document;
        return true;
      }
      case 'yaml': {
        const document = parseYaml(foreignBytes, yamlProfileName(state.profileName), state.parseLimits);
        state.foreignYaml = document;
        return true;
      }
      case 'ini': {
        const document = parseIniDocument(foreignBytes, iniProfile(state.profileName), profileDefaultSelection(), state.iniLimits);
        state.foreignIni = document;
        return true;
      }
      case 'properties': {
        const document = parsePropertiesReader(foreignBytes, utf8Encoding(), state.propertiesLimits);
        state.foreignProperties = document;
        return true;
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** Dispatches one step (or the absence of a step) and emits one key set. */
function emitStepFacts(facts: Facts, state: DocState, step: StepDesc | undefined): void {
  const op = step?.op ?? '';
  switch (op) {
    case 'query-native':
      emitNativeQuery(facts, state, step);
      break;
    case 'query-syntax':
      emitSyntaxQuery(facts, state, step);
      break;
    case 'project':
      emitProject(facts, state, step);
      break;
    case 'materialize':
      emitMaterialize(facts, state, step);
      break;
    case 'edit':
      emitEdit(facts, state, step);
      break;
    default:
      emitNativeQuery(facts, state, undefined);
      emitSyntaxQuery(facts, state, undefined);
      emitProject(facts, state, undefined);
      emitMaterialize(facts, state, undefined);
      emitEdit(facts, state, undefined);
      break;
  }
}

// ---------------------------------------------------------------------------
// Edit operations
// ---------------------------------------------------------------------------

/** Builds one PortableValue from a scalar descriptor; null = invalid. */
function valueFromDesc(op: EditOpDesc): PortableValue | null {
  const desc = op.value;
  if (desc === undefined) {
    return null;
  }
  if (desc.null !== undefined) {
    return nullValue();
  }
  if (desc.boolean !== undefined) {
    return { kind: 'Boolean', value: desc.boolean };
  }
  if (desc.integer !== undefined && desc.integer !== '') {
    try {
      return integerValue(BigInt(desc.integer));
    } catch {
      return null;
    }
  }
  if (desc.decimal !== undefined && desc.decimal !== '') {
    const parsed = parseJsonNumber(desc.decimal);
    if (parsed === null) {
      return null;
    }
    return parsed;
  }
  if (desc.string !== undefined && desc.string !== '') {
    return stringValue(desc.string);
  }
  if (desc.binary64 !== undefined && desc.binary64 !== '') {
    try {
      return binaryFloat64Value(BigInt(desc.binary64.replace(/^0x/, '')));
    } catch {
      return null;
    }
  }
  return null;
}

/** The string descriptor as text; null when absent or empty. */
function stringFromDesc(op: EditOpDesc): string | null {
  const value = op.value?.string;
  return value !== undefined && value !== '' ? value : null;
}

/** Decodes one lowercase hex field; null = invalid. */
function hexField(hex: string | undefined): Uint8Array | null {
  return decodeHex(hex ?? '');
}

function decodeHex(text: string): Uint8Array | null {
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) {
    return null;
  }
  const bytes = new Uint8Array(text.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function jsonRepresentationPolicy(policy: string | undefined): JsonRepresentationPolicy | null {
  switch (policy) {
    case 'PreserveCompatible':
      return 'PreserveCompatible';
    case 'CanonicalForProfile':
      return 'CanonicalForProfile';
    case 'PreserveElseCanonical':
      return 'PreserveElseCanonical';
    case 'ExactLiteral':
      return 'ExactLiteral';
    default:
      return null;
  }
}

function tomlRepresentationPolicy(policy: string | undefined): TomlRepresentationPolicy | null {
  switch (policy) {
    case 'PreserveCompatible':
      return 'PreserveCompatible';
    case 'CanonicalForProfile':
      return 'CanonicalForProfile';
    case 'PreserveElseCanonical':
      return 'PreserveElseCanonical';
    case 'ExactLiteral':
      return 'ExactLiteral';
    default:
      return null;
  }
}

function yamlRepresentationPolicy(policy: string | undefined): YamlRepresentationPolicy | null {
  switch (policy) {
    case 'PreserveCompatible':
      return 'PreserveCompatible';
    case 'CanonicalForProfile':
      return 'CanonicalForProfile';
    case 'PreserveElseCanonical':
      return 'PreserveElseCanonical';
    case 'ExactLiteral':
      return 'ExactLiteral';
    default:
      return null;
  }
}

function iniRepresentationPolicy(policy: string | undefined): IniRepresentationPolicy | null {
  switch (policy) {
    case 'PreserveCompatible':
      return 'PreserveCompatible';
    case 'CanonicalForProfile':
      return 'CanonicalForProfile';
    case 'PreserveElseCanonical':
      return 'PreserveElseCanonical';
    case 'ExactLiteral':
      return 'ExactLiteral';
    default:
      return null;
  }
}

/** Resolves one JSON target descriptor to a node handle. */
function resolveJsonTarget(state: DocState, target: TargetDesc | undefined): NodeRef | null {
  if (target === undefined) {
    return null;
  }
  const document = target.foreign === true ? state.foreignJSON : state.jsonDocument;
  if (document === null) {
    return null;
  }
  const root = document.root();
  const ordinal = target.ordinal ?? 0;
  switch (target.kind) {
    case 'root':
      return root.nodeRef();
    case 'member':
    case 'member-value':
    case 'member-key': {
      const members = root.objectMembers();
      if (members.kind !== 'Available' || members.value === null || ordinal >= members.value.length) {
        return null;
      }
      const member = members.value[ordinal];
      switch (target.kind) {
        case 'member':
          return member.nodeRef();
        case 'member-value':
          return member.valueNodeRef();
        default:
          return member.keyNodeRef();
      }
    }
    case 'array-element':
    case 'array-element-value': {
      const elements = root.arrayElements();
      if (elements.kind !== 'Available' || elements.value === null || ordinal >= elements.value.length) {
        return null;
      }
      const element = elements.value[ordinal];
      return target.kind === 'array-element' ? element.nodeRef() : element.valueNodeRef();
    }
    default:
      return null;
  }
}

/** Resolves one TOML target descriptor to a node handle. */
function resolveTomlTarget(state: DocState, target: TargetDesc | undefined): NodeRef | null {
  if (target === undefined) {
    return null;
  }
  const document = target.foreign === true ? state.foreignToml : state.tomlDocument;
  if (document === null) {
    return null;
  }
  const root = document.root();
  const ordinal = target.ordinal ?? 0;
  switch (target.kind) {
    case 'root':
      return root.nodeRef();
    case 'entry':
    case 'entry-item':
    case 'entry-key': {
      const entries = root.tableEntries();
      if (entries === null || ordinal >= entries.length) {
        return null;
      }
      const entry = entries[ordinal];
      switch (target.kind) {
        case 'entry':
          return entry.nodeRef();
        case 'entry-item':
          return entry.itemNodeRef();
        default:
          return entry.keyNodeRef();
      }
    }
    case 'array-element':
    case 'array-element-item': {
      const elements = root.arrayElements();
      if (elements === null || ordinal >= elements.length) {
        return null;
      }
      const element = elements[ordinal];
      return target.kind === 'array-element' ? element.nodeRef() : element.itemNodeRef();
    }
    default:
      return null;
  }
}

/** Resolves one YAML target descriptor to a node handle. */
function resolveYamlTarget(state: DocState, target: TargetDesc | undefined): NodeRef | null {
  if (target === undefined) {
    return null;
  }
  const document = target.foreign === true ? state.foreignYaml : state.yamlDocument;
  if (document === null) {
    return null;
  }
  const yamlDoc = document.document(0);
  if (yamlDoc === null) {
    return null;
  }
  const root = yamlDoc.root();
  const ordinal = target.ordinal ?? 0;
  switch (target.kind) {
    case 'document-root':
      return root.nodeRef();
    case 'mapping-entry':
      return root.mappingEntry(ordinal)?.nodeRef() ?? null;
    case 'mapping-value':
      return root.mappingEntry(ordinal)?.value().nodeRef() ?? null;
    case 'mapping-key':
      return root.mappingEntry(ordinal)?.key().nodeRef() ?? null;
    case 'sequence-element': {
      const item = root.sequenceItem(ordinal);
      if (item !== null) {
        return item.nodeRef();
      }
      const entry = root.mappingEntry(0);
      if (entry !== null) {
        const nested = entry.value().sequenceItem(ordinal);
        if (nested !== null) {
          return nested.nodeRef();
        }
      }
      return null;
    }
    case 'sequence-element-node': {
      const item = root.sequenceItem(ordinal);
      if (item !== null) {
        return item.node().nodeRef();
      }
      const entry = root.mappingEntry(0);
      if (entry !== null) {
        const nested = entry.value().sequenceItem(ordinal);
        if (nested !== null) {
          return nested.node().nodeRef();
        }
      }
      return null;
    }
    case 'anchor-value': {
      const entry = root.mappingEntry(ordinal);
      if (entry === null) {
        return null;
      }
      return entry.value().anchorNodeRef();
    }
    default:
      return null;
  }
}

/** Resolves one INI target descriptor to a node handle. */
function resolveIniTarget(state: DocState, target: TargetDesc | undefined): NodeRef | null {
  if (target === undefined) {
    return null;
  }
  const document = target.foreign === true ? state.foreignIni : state.iniDocument;
  if (document === null) {
    return null;
  }
  const ordinal = target.ordinal ?? 0;
  switch (target.kind) {
    case 'document':
      return document.nodeRef();
    case 'section': {
      const sections = document.sections();
      return ordinal < sections.length ? sections[ordinal].nodeRef() : null;
    }
    case 'entry': {
      const entries = document.entries();
      return ordinal < entries.length ? entries[ordinal].nodeRef() : null;
    }
    default:
      return null;
  }
}

/** Resolves one Properties target descriptor to a node handle. */
function resolvePropertiesTarget(state: DocState, target: TargetDesc | undefined): NodeRef | null {
  if (target === undefined) {
    return null;
  }
  const document = target.foreign === true ? state.foreignProperties : state.propertiesDocument;
  if (document === null) {
    return null;
  }
  const ordinal = target.ordinal ?? 0;
  switch (target.kind) {
    case 'document':
      return document.nodeRef();
    case 'property': {
      const properties = document.properties();
      return ordinal < properties.length ? properties[ordinal].nodeRef() : null;
    }
    default:
      return null;
  }
}

/** Resolves one JSON placement descriptor. */
function resolveJsonPlacement(state: DocState, placement: PlacementDesc | undefined): AssociationPlacement | null {
  if (placement === undefined) {
    return { kind: 'End' };
  }
  switch (placement.at) {
    case 'start':
      return { kind: 'Start' };
    case 'end':
      return { kind: 'End' };
    default:
      break;
  }
  if (placement.beforeOrdinal !== undefined) {
    const anchor = jsonOrdinalAnchor(state, placement.beforeOrdinal);
    if (anchor === null) {
      return null;
    }
    return { kind: 'Before', anchor };
  }
  if (placement.afterOrdinal !== undefined) {
    const anchor = jsonOrdinalAnchor(state, placement.afterOrdinal);
    if (anchor === null) {
      return null;
    }
    return { kind: 'After', anchor };
  }
  return { kind: 'End' };
}

/** Resolves one TOML placement descriptor. */
function resolveTomlPlacement(state: DocState, placement: PlacementDesc | undefined): AssociationPlacement | null {
  if (placement === undefined) {
    return { kind: 'End' };
  }
  switch (placement.at) {
    case 'start':
      return { kind: 'Start' };
    case 'end':
      return { kind: 'End' };
    default:
      break;
  }
  if (placement.beforeOrdinal !== undefined) {
    const anchor = tomlOrdinalAnchor(state, placement.beforeOrdinal);
    if (anchor === null) {
      return null;
    }
    return { kind: 'Before', anchor };
  }
  if (placement.afterOrdinal !== undefined) {
    const anchor = tomlOrdinalAnchor(state, placement.afterOrdinal);
    if (anchor === null) {
      return null;
    }
    return { kind: 'After', anchor };
  }
  return { kind: 'End' };
}

/** Resolves one YAML placement descriptor. */
function resolveYamlPlacement(state: DocState, placement: PlacementDesc | undefined): AssociationPlacement | null {
  if (placement === undefined) {
    return { kind: 'End' };
  }
  switch (placement.at) {
    case 'start':
      return { kind: 'Start' };
    case 'end':
      return { kind: 'End' };
    default:
      break;
  }
  if (placement.beforeOrdinal !== undefined) {
    const anchor = yamlOrdinalAnchor(state, placement.beforeOrdinal);
    if (anchor === null) {
      return null;
    }
    return { kind: 'Before', anchor };
  }
  if (placement.afterOrdinal !== undefined) {
    const anchor = yamlOrdinalAnchor(state, placement.afterOrdinal);
    if (anchor === null) {
      return null;
    }
    return { kind: 'After', anchor };
  }
  return { kind: 'End' };
}

/** Resolves one INI placement descriptor (start/end only). */
function resolveIniPlacement(placement: PlacementDesc | undefined): AssociationPlacement {
  if (placement !== undefined && placement.at === 'start') {
    return { kind: 'Start' };
  }
  return { kind: 'End' };
}

/** Resolves one Properties placement descriptor (start/end only). */
function resolvePropertiesPlacement(placement: PlacementDesc | undefined): AssociationPlacement {
  if (placement !== undefined && placement.at === 'start') {
    return { kind: 'Start' };
  }
  return { kind: 'End' };
}

/** Resolves the anchor of the current JSON container. */
function jsonOrdinalAnchor(state: DocState, ordinal: number): NodeRef | null {
  const document = state.jsonDocument;
  if (document === null) {
    return null;
  }
  const root = document.root();
  const members = root.objectMembers();
  if (members.kind === 'Available' && members.value !== null && ordinal < members.value.length) {
    return members.value[ordinal].nodeRef();
  }
  const elements = root.arrayElements();
  if (elements.kind === 'Available' && elements.value !== null && ordinal < elements.value.length) {
    return elements.value[ordinal].nodeRef();
  }
  return null;
}

/** Resolves the anchor of the current TOML container. */
function tomlOrdinalAnchor(state: DocState, ordinal: number): NodeRef | null {
  const document = state.tomlDocument;
  if (document === null) {
    return null;
  }
  const root = document.root();
  const entries = root.tableEntries();
  if (entries !== null && ordinal < entries.length) {
    return entries[ordinal].nodeRef();
  }
  const elements = root.arrayElements();
  if (elements !== null && ordinal < elements.length) {
    return elements[ordinal].nodeRef();
  }
  return null;
}

/** Resolves the anchor of the current YAML container. */
function yamlOrdinalAnchor(state: DocState, ordinal: number): NodeRef | null {
  const document = state.yamlDocument;
  if (document === null) {
    return null;
  }
  const root = document.document(0)?.root();
  if (root === undefined) {
    return null;
  }
  const entry = root.mappingEntry(ordinal);
  if (entry !== null) {
    return entry.nodeRef();
  }
  const item = root.sequenceItem(ordinal);
  if (item !== null) {
    return item.nodeRef();
  }
  return null;
}

/** Applies the declared JSON edit operations; false = descriptor error. */
function applyJsonEditOperations(
  builder: JsonEditTransactionBuilder,
  state: DocState,
  step: StepDesc,
): boolean {
  for (const op of step.operations ?? []) {
    switch (op.operation) {
      case 'semantic-scalar': {
        const value = valueFromDesc(op);
        if (value === null) {
          return false;
        }
        const target = resolveJsonTarget(state, op.target);
        if (target === null) {
          return false;
        }
        const policy = jsonRepresentationPolicy(op.policy);
        if (policy === null) {
          return false;
        }
        builder.semanticScalar(target, value, policy);
        break;
      }
      case 'literal-scalar': {
        const target = resolveJsonTarget(state, op.target);
        if (target === null) {
          return false;
        }
        const literal = hexField(op.literalHex);
        if (literal === null) {
          return false;
        }
        builder.literalScalar(target, literal);
        break;
      }
      case 'insert-member': {
        const container = resolveJsonTarget(state, op.target);
        if (container === null) {
          return false;
        }
        const value = valueFromDesc(op);
        if (value === null) {
          return false;
        }
        const placement = resolveJsonPlacement(state, op.placement);
        if (placement === null) {
          return false;
        }
        builder.insertMember(container, op.name ?? '', value, placement);
        break;
      }
      case 'remove-member': {
        const target = resolveJsonTarget(state, op.target);
        if (target === null) {
          return false;
        }
        builder.removeMember(target);
        break;
      }
      case 'rename-member': {
        const target = resolveJsonTarget(state, op.target);
        if (target === null) {
          return false;
        }
        builder.renameMember(target, op.name ?? '');
        break;
      }
      case 'insert-array-element': {
        const container = resolveJsonTarget(state, op.target);
        if (container === null) {
          return false;
        }
        const value = valueFromDesc(op);
        if (value === null) {
          return false;
        }
        const placement = resolveJsonPlacement(state, op.placement);
        if (placement === null) {
          return false;
        }
        builder.insertArrayElement(container, value, placement);
        break;
      }
      case 'remove-array-element': {
        const target = resolveJsonTarget(state, op.target);
        if (target === null) {
          return false;
        }
        builder.removeArrayElement(target);
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

/** Applies the declared TOML edit operations. */
function applyTomlEditOperations(
  builder: TomlEditTransactionBuilder,
  state: DocState,
  step: StepDesc,
): boolean {
  for (const op of step.operations ?? []) {
    switch (op.operation) {
      case 'semantic-scalar': {
        const value = valueFromDesc(op);
        if (value === null) {
          return false;
        }
        const target = resolveTomlTarget(state, op.target);
        if (target === null) {
          return false;
        }
        const policy = tomlRepresentationPolicy(op.policy);
        if (policy === null) {
          return false;
        }
        builder.semanticScalar(target, value, policy);
        break;
      }
      case 'literal-scalar': {
        const target = resolveTomlTarget(state, op.target);
        if (target === null) {
          return false;
        }
        const literal = hexField(op.literalHex);
        if (literal === null) {
          return false;
        }
        builder.literalScalar(target, literal);
        break;
      }
      case 'insert-entry': {
        const container = resolveTomlTarget(state, op.target);
        if (container === null) {
          return false;
        }
        const value = valueFromDesc(op);
        if (value === null) {
          return false;
        }
        const placement = resolveTomlPlacement(state, op.placement);
        if (placement === null) {
          return false;
        }
        builder.insertEntry(container, op.name ?? '', value, placement);
        break;
      }
      case 'remove-entry': {
        const target = resolveTomlTarget(state, op.target);
        if (target === null) {
          return false;
        }
        builder.removeEntry(target);
        break;
      }
      case 'rename-entry': {
        const target = resolveTomlTarget(state, op.target);
        if (target === null) {
          return false;
        }
        builder.renameEntry(target, op.name ?? '');
        break;
      }
      case 'insert-array-element': {
        const container = resolveTomlTarget(state, op.target);
        if (container === null) {
          return false;
        }
        const value = valueFromDesc(op);
        if (value === null) {
          return false;
        }
        const placement = resolveTomlPlacement(state, op.placement);
        if (placement === null) {
          return false;
        }
        builder.insertArrayElement(container, value, placement);
        break;
      }
      case 'remove-array-element': {
        const target = resolveTomlTarget(state, op.target);
        if (target === null) {
          return false;
        }
        builder.removeArrayElement(target);
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

/** Applies the declared YAML edit operations. */
function applyYamlEditOperations(
  builder: YamlEditTransactionBuilder,
  state: DocState,
  step: StepDesc,
): boolean {
  for (const op of step.operations ?? []) {
    switch (op.operation) {
      case 'semantic-scalar': {
        const value = valueFromDesc(op);
        if (value === null) {
          return false;
        }
        const target = resolveYamlTarget(state, op.target);
        if (target === null) {
          return false;
        }
        const policy = yamlRepresentationPolicy(op.policy);
        if (policy === null) {
          return false;
        }
        builder.semanticScalar(target, value, policy);
        break;
      }
      case 'literal-scalar': {
        const target = resolveYamlTarget(state, op.target);
        if (target === null) {
          return false;
        }
        const literal = hexField(op.literalHex);
        if (literal === null) {
          return false;
        }
        builder.literalScalar(target, literal);
        break;
      }
      case 'rename-anchor': {
        const target = resolveYamlTarget(state, op.target);
        if (target === null) {
          return false;
        }
        builder.renameAnchor(target, op.name ?? '');
        break;
      }
      case 'insert-mapping-entry': {
        const container = resolveYamlTarget(state, op.target);
        if (container === null) {
          return false;
        }
        const value = valueFromDesc(op);
        if (value === null) {
          return false;
        }
        const placement = resolveYamlPlacement(state, op.placement);
        if (placement === null) {
          return false;
        }
        builder.insertMappingEntry(container, stringValue(op.name ?? ''), value, placement);
        break;
      }
      case 'remove-mapping-entry': {
        const target = resolveYamlTarget(state, op.target);
        if (target === null) {
          return false;
        }
        builder.removeMappingEntry(target);
        break;
      }
      case 'insert-sequence-element': {
        const container = resolveYamlTarget(state, op.target);
        if (container === null) {
          return false;
        }
        const value = valueFromDesc(op);
        if (value === null) {
          return false;
        }
        const placement = resolveYamlPlacement(state, op.placement);
        if (placement === null) {
          return false;
        }
        builder.insertSequenceElement(container, value, placement);
        break;
      }
      case 'remove-sequence-element': {
        const target = resolveYamlTarget(state, op.target);
        if (target === null) {
          return false;
        }
        builder.removeSequenceElement(target);
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

/** Applies the declared INI edit operations. */
function applyIniEditOperations(
  builder: IniEditTransactionBuilder,
  state: DocState,
  step: StepDesc,
): boolean {
  for (const op of step.operations ?? []) {
    switch (op.operation) {
      case 'semantic-value': {
        const target = resolveIniTarget(state, op.target);
        if (target === null) {
          return false;
        }
        const value = stringFromDesc(op);
        if (value === null) {
          return false;
        }
        const policy = iniRepresentationPolicy(op.policy);
        if (policy === null) {
          return false;
        }
        builder.semanticValue(target, value, policy);
        break;
      }
      case 'literal-value': {
        const target = resolveIniTarget(state, op.target);
        if (target === null) {
          return false;
        }
        const literal = hexField(op.literalHex);
        if (literal === null) {
          return false;
        }
        builder.literalValue(target, literal);
        break;
      }
      case 'insert-section': {
        const container = resolveIniTarget(state, op.target);
        if (container === null) {
          return false;
        }
        const placement = resolveIniPlacement(op.placement);
        builder.insertSection(container, op.name ?? '', placement);
        break;
      }
      case 'remove-section': {
        const target = resolveIniTarget(state, op.target);
        if (target === null) {
          return false;
        }
        builder.removeSection(target);
        break;
      }
      case 'rename-section': {
        const target = resolveIniTarget(state, op.target);
        if (target === null) {
          return false;
        }
        builder.renameSection(target, op.name ?? '');
        break;
      }
      case 'insert-entry': {
        const container = resolveIniTarget(state, op.target);
        if (container === null) {
          return false;
        }
        const value = stringFromDesc(op);
        if (value === null) {
          return false;
        }
        const placement = resolveIniPlacement(op.placement);
        builder.insertEntry(container, op.name ?? '', value, placement);
        break;
      }
      case 'remove-entry': {
        const target = resolveIniTarget(state, op.target);
        if (target === null) {
          return false;
        }
        builder.removeEntry(target);
        break;
      }
      case 'rename-entry': {
        const target = resolveIniTarget(state, op.target);
        if (target === null) {
          return false;
        }
        builder.renameEntry(target, op.name ?? '');
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

/** Applies the declared Properties edit operations. */
function applyPropertiesEditOperations(
  builder: PropertiesEditTransactionBuilder,
  state: DocState,
  step: StepDesc,
): boolean {
  for (const op of step.operations ?? []) {
    switch (op.operation) {
      case 'semantic-value': {
        const target = resolvePropertiesTarget(state, op.target);
        if (target === null) {
          return false;
        }
        const value = stringFromDesc(op);
        if (value === null) {
          return false;
        }
        builder.semanticValue(target, JavaString.fromUnicode(value));
        break;
      }
      case 'literal-value': {
        const target = resolvePropertiesTarget(state, op.target);
        if (target === null) {
          return false;
        }
        const literal = hexField(op.literalHex);
        if (literal === null) {
          return false;
        }
        builder.literalValue(target, literal);
        break;
      }
      case 'insert-property': {
        const container = resolvePropertiesTarget(state, op.target);
        if (container === null) {
          return false;
        }
        const value = stringFromDesc(op);
        if (value === null) {
          return false;
        }
        const placement = resolvePropertiesPlacement(op.placement);
        builder.insertProperty(
          container,
          JavaString.fromUnicode(op.name ?? ''),
          JavaString.fromUnicode(value),
          placement,
        );
        break;
      }
      case 'remove-property': {
        const target = resolvePropertiesTarget(state, op.target);
        if (target === null) {
          return false;
        }
        builder.removeProperty(target);
        break;
      }
      case 'rename-property': {
        const target = resolvePropertiesTarget(state, op.target);
        if (target === null) {
          return false;
        }
        builder.renameProperty(target, JavaString.fromUnicode(op.name ?? ''));
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Source face
// ---------------------------------------------------------------------------

/** Runs one source-face case and returns its ordered facts. */
function runSourceCase(c: FileCase): string[] {
  const facts = new Facts();
  const input = c.input;
  if (input === undefined) {
    throw new Error('source case without input');
  }
  const raw = sourceRawBytes(input);
  const request = buildEncodingRequest(c.request);
  let snapshot: SourceSnapshot;
  try {
    snapshot = SourceSnapshot.fromRaw(raw, request, DEFAULT_SOURCE_LIMITS);
  } catch (error) {
    facts.set('source.status', 'Failed');
    facts.set('source.failure', sourceCode(error));
    facts.set('source.encoding', '');
    facts.set('source.bom', '');
    facts.set('source.declared', '');
    facts.set('source.digest', '');
    facts.set('source.len', '');
    facts.set('source.text', '');
    emitPositionFacts(facts, c.positions, raw, null);
    emitPatchFacts(facts, c, raw, null, request);
    return facts.lines;
  }
  facts.set('source.status', 'Ok');
  facts.set('source.failure', '');
  facts.set('source.encoding', encodingAsStr(snapshot.encodingFacts().selected()));
  const bom = snapshot.encodingFacts().bom();
  facts.set('source.bom', bom !== null ? encodingAsStr(bomKindEncoding(bom)) : '');
  const declaration = snapshot.encodingFacts().declaration();
  facts.set('source.declared', declaration !== null ? encodingAsStr(declaration) : '');
  facts.set('source.digest', snapshot.digest().toHex());
  facts.set('source.len', String(snapshot.len()));
  const text = snapshot.decodedText();
  facts.set('source.text', text !== null ? escapeText(text) : 'binary');
  emitPositionFacts(facts, c.positions, raw, snapshot);
  emitPatchFacts(facts, c, raw, snapshot, request);
  return facts.lines;
}

function sourceRawBytes(input: SourceInputDesc): Uint8Array {
  if (input.rawHex !== undefined && input.rawHex !== '') {
    const decoded = decodeHex(input.rawHex);
    if (decoded === null) {
      throw new Error('invalid raw_hex');
    }
    return decoded;
  }
  return new TextEncoder().encode(input.source ?? '');
}

/** Builds the encoding-resolution request. */
function buildEncodingRequest(desc: EncodingRequestDesc | undefined): EncodingRequest {
  if (desc === undefined || desc.profileDefault === '') {
    throw new Error('source case without request');
  }
  const profileDefault = encodingByName(desc.profileDefault);
  if (profileDefault === null) {
    throw new Error(`unknown profile_default ${JSON.stringify(desc.profileDefault)}`);
  }
  let request = EncodingRequest.create(profileDefault);
  if (desc.declaration !== undefined && desc.declaration !== '') {
    const declaration = encodingByName(desc.declaration);
    if (declaration === null) {
      throw new Error(`unknown declaration ${JSON.stringify(desc.declaration)}`);
    }
    request = request.withDeclaration(declaration);
  }
  if (desc.callerOverride !== undefined && desc.callerOverride !== '') {
    const override = encodingByName(desc.callerOverride);
    if (override === null) {
      throw new Error(`unknown caller_override ${JSON.stringify(desc.callerOverride)}`);
    }
    request = request.withCallerOverride(override);
  }
  switch (desc.bomPolicy ?? '') {
    case '':
    case 'DetectUnicode':
      break;
    case 'TreatAsContent':
      request = request.withBomPolicy('TreatAsContent');
      break;
    default:
      throw new Error(`unknown bom_policy ${JSON.stringify(desc.bomPolicy)}`);
  }
  return request;
}

/** Resolves one stable encoding name; null = unknown. */
function encodingByName(name: string): SourceEncoding | null {
  switch (name) {
    case 'binary':
      return binaryEncoding();
    case 'utf-8':
      return utf8Encoding();
    case 'utf-16le':
      return utf16LeEncoding();
    case 'utf-16be':
      return utf16BeEncoding();
    case 'latin-1':
      return latin1Encoding();
    case 'windows-1252': {
      const page = WindowsCodePage.fromNumber(1252);
      return page !== null ? windowsCodePageEncoding(page) : null;
    }
    default:
      return null;
  }
}

/** The stable code of a source construction error. */
function sourceCode(error: unknown): string {
  if (error instanceof SourceError) {
    return error.code;
  }
  return 'core.source.invalid-sequence@1';
}

/** The stable code of a patch construction/application error. */
function sourcePatchCode(error: unknown): string {
  if (error instanceof SourcePatchError || error instanceof SourceError) {
    return error.code;
  }
  return 'core.protocol.invalid-value@1';
}

/** Emits the byte-exact position conversions. */
function emitPositionFacts(
  facts: Facts,
  positions: readonly number[] | undefined,
  raw: Uint8Array,
  snapshot: SourceSnapshot | null,
): void {
  for (let index = 0; index < (positions ?? []).length; index++) {
    const rawByte = positions![index];
    const key = `source.position.${index}.`;
    if (snapshot === null) {
      facts.set(`${key}raw_byte`, String(rawByte));
      facts.set(`${key}decoded_utf8`, '');
      facts.set(`${key}scalars`, '');
      facts.set(`${key}utf16`, '');
      continue;
    }
    try {
      const position = snapshot.decodedPosition(rawByte);
      facts.set(`${key}raw_byte`, String(position.rawByte));
      facts.set(`${key}decoded_utf8`, String(position.decodedUtf8Byte));
      facts.set(`${key}scalars`, String(position.unicodeScalarOffset));
      facts.set(`${key}utf16`, String(position.utf16CodeUnitOffset));
    } catch {
      facts.set(`${key}raw_byte`, String(rawByte));
      facts.set(`${key}decoded_utf8`, '');
      facts.set(`${key}scalars`, '');
      facts.set(`${key}utf16`, '');
    }
  }
}

/** Emits the optional SourcePatch application facts. */
function emitPatchFacts(
  facts: Facts,
  c: FileCase,
  raw: Uint8Array,
  snapshot: SourceSnapshot | null,
  request: EncodingRequest,
): void {
  const skipped = (): void => {
    facts.set('patch.status', 'Skipped');
    facts.set('patch.failure', '');
    facts.set('patch.output', '');
    facts.set('patch.replacement_count', '');
  };
  const patchDesc = c.patch;
  if (patchDesc === undefined) {
    skipped();
    return;
  }
  if (snapshot === null) {
    skipped();
    return;
  }
  const replacements = buildSourceReplacements(snapshot, patchDesc);
  if (replacements === null) {
    facts.set('patch.status', 'Failed');
    facts.set('patch.failure', 'core.protocol.invalid-value@1');
    facts.set('patch.output', '');
    facts.set('patch.replacement_count', '');
    return;
  }
  let patch: SourcePatch;
  try {
    patch = SourcePatch.create(snapshot, replacements, new Map(), DEFAULT_SOURCE_PATCH_LIMITS);
  } catch (error) {
    facts.set('patch.status', 'Failed');
    facts.set('patch.failure', sourcePatchCode(error));
    facts.set('patch.output', '');
    facts.set('patch.replacement_count', '');
    return;
  }
  let base: SourceSnapshot = snapshot;
  if ((patchDesc.applyTo ?? 'base') === 'tampered') {
    const tampered = Uint8Array.from(raw);
    if (tampered.length > 0) {
      tampered[tampered.length - 1] ^= 0x01;
    }
    try {
      base = SourceSnapshot.fromRaw(tampered, request, DEFAULT_SOURCE_LIMITS);
    } catch (error) {
      facts.set('patch.status', 'Failed');
      facts.set('patch.failure', sourcePatchCode(error));
      facts.set('patch.output', '');
      facts.set('patch.replacement_count', '');
      return;
    }
  }
  try {
    const target = patch.apply(base, DEFAULT_SOURCE_PATCH_LIMITS);
    facts.set('patch.status', 'Applied');
    facts.set('patch.failure', '');
    facts.set('patch.output', escapeBytes(target.bytes()));
    facts.set('patch.replacement_count', String(replacements.length));
  } catch (error) {
    facts.set('patch.status', 'Failed');
    facts.set('patch.failure', sourcePatchCode(error));
    facts.set('patch.output', '');
    facts.set('patch.replacement_count', '');
  }
}

/** Builds the replacements from the descriptor; the original bytes come from the base snapshot. */
function buildSourceReplacements(
  snapshot: SourceSnapshot,
  patchDesc: PatchDesc,
): SourceReplacement[] | null {
  const base = snapshot.bytes();
  const replacements: SourceReplacement[] = [];
  for (const desc of patchDesc.replacements) {
    if (desc.oldStart < 0 || desc.oldEnd < desc.oldStart || desc.oldEnd > base.length) {
      return null;
    }
    const replacement = decodeHex(desc.replacementHex);
    if (replacement === null) {
      return null;
    }
    const original = base.slice(desc.oldStart, desc.oldEnd);
    replacements.push(new SourceReplacement(desc.oldStart, desc.oldEnd, original, replacement));
  }
  return replacements;
}

// ---------------------------------------------------------------------------
// Dispatch and comparison
// ---------------------------------------------------------------------------

/** Runs one case and returns its ordered facts. */
export function runCase(c: FileCase): string[] {
  switch (c.kind) {
    case 'document':
      return runDocumentCase(c);
    case 'source':
      return runSourceCase(c);
  }
}

/** Compares the two fact line sets field by field (the Go compareFacts). */
export function compareFacts(id: string, leftLines: readonly string[], rightLines: readonly string[]): string[] {
  const left = new Map<string, string>();
  const right = new Map<string, string>();
  for (const line of leftLines) {
    const index = line.indexOf('=');
    if (index < 0) {
      return [`case ${id}: TS side emitted malformed fact line ${JSON.stringify(line)}`];
    }
    const key = line.slice(0, index);
    if (left.has(key)) {
      return [`case ${id}: TS side emitted duplicate fact key ${JSON.stringify(key)}`];
    }
    left.set(key, line.slice(index + 1));
  }
  for (const line of rightLines) {
    const index = line.indexOf('=');
    if (index < 0) {
      return [`case ${id}: Rust side emitted malformed fact line ${JSON.stringify(line)}`];
    }
    const key = line.slice(0, index);
    if (right.has(key)) {
      return [`case ${id}: Rust side emitted duplicate fact key ${JSON.stringify(key)}`];
    }
    right.set(key, line.slice(index + 1));
  }
  const failures: string[] = [];
  for (const [key, leftValue] of left) {
    const rightValue = right.get(key);
    if (rightValue === undefined) {
      failures.push(`case ${id}: field ${key}: Rust side has no such field (TS value ${JSON.stringify(leftValue)})`);
      continue;
    }
    if (leftValue !== rightValue) {
      failures.push(`case ${id}: field ${key} differs\n  TS:   ${JSON.stringify(leftValue)}\n  Rust: ${JSON.stringify(rightValue)}`);
    }
  }
  for (const [key, rightValue] of right) {
    if (!left.has(key)) {
      failures.push(`case ${id}: field ${key}: TS side has no such field (Rust value ${JSON.stringify(rightValue)})`);
    }
  }
  return failures;
}

/** Splits one evidence file into fact lines (the shared reader of both directions). */
export function splitEvidenceLines(text: string): string[] {
  const content = text.replace(/\r?\n$/, '');
  if (content === '') {
    return [];
  }
  return content.split('\n');
}

/** Reads one Rust evidence file. */
export function readEvidenceFile(dir: string, id: string): string[] {
  const text = readFileSync(`${dir}/${id}.txt`, 'utf-8');
  return splitEvidenceLines(text);
}

/** Writes the TS-side evidence files: one `<case-id>.txt` per case. */
export function emitFactsToDir(cases: readonly FileCase[], dir: string): number {
  mkdirSync(dir, { recursive: true });
  for (const c of cases) {
    const lines = runCase(c);
    writeFileSync(`${dir}/${c.id}.txt`, `${lines.join('\n')}\n`, 'utf-8');
  }
  return cases.length;
}

export interface NormalizedResult {
  readonly passed: number;
  readonly failures: readonly string[];
}

/**
 * Forward direction: computes the TS facts for the whole input set and
 * compares them field by field against the Rust evidence files.
 */
export function runNormalizedForward(casesFile: string, rustDir: string): NormalizedResult {
  const cases = loadCaseFile(casesFile);
  const knownIDs = new Set(cases.map((c) => c.id));
  for (const entry of readdirSync(rustDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      continue;
    }
    const id = entry.name.endsWith('.txt') ? entry.name.slice(0, -'.txt'.length) : entry.name;
    if (!knownIDs.has(id)) {
      throw new Error(`rust evidence file ${JSON.stringify(entry.name)} does not correspond to any case (case file drift?)`);
    }
  }
  const failures: string[] = [];
  let passed = 0;
  for (const c of cases) {
    const tsLines = runCase(c);
    const rustLines = readEvidenceFile(rustDir, c.id);
    const fieldFailures = compareFacts(c.id, tsLines, rustLines);
    if (fieldFailures.length === 0) {
      passed++;
      continue;
    }
    failures.push(...fieldFailures);
  }
  return { passed, failures };
}

/** The reverse-direction evidence directory environment variable. */
export const TS_DIR_ENV = 'CONSEMA_DIFFERENTIAL_NORMALIZED_TS_DIR';
