/**
 * Root facade: the unified format-surface registry and the common opaque
 * document union (L4 root facade, mirror of the Go root package +
 * crates/consema root; authority: crates/consema/src/lib.rs registry module
 * :42-489 and the `Document` facade :491-820; RFC 0015 §6.2 families/
 * profiles/query_domains/operations).
 *
 * The registry is strictly additive: it enumerates the frozen surface
 * (8 format families / 16 profiles / 21 query domains / 16 per-profile
 * operation registries) from the backend families' own public facts, so a
 * backend drift fails this module's tests instead of going unnoticed.
 *
 * The `Document` union wraps the eight family document types behind typed
 * adapters (as_json/as_toml/...); every returned fact is an immutable
 * snapshot fact, and render() is byte-for-byte identical to the source.
 */

import { FatalFormationFailure } from './json/errors.ts';
import { diagnostic } from './document/diagnostic.ts';
import type { Diagnostic } from './document/diagnostic.ts';
import { FormatFamilyId, ProfileId } from './document/profile.ts';
import type { FormationStatus } from './document/formation.ts';
import { DEFAULT_PARSE_LIMITS, type ParseLimits } from './document/formation.ts';
import { FormatOperationRegistry } from './document/operation.ts';
import type { SnapshotIdentity } from './document/identity.ts';
import type { SourceEncoding } from './document/source.ts';
import {
  domainHCLNativeV1,
  domainHCLLosslessSyntaxV1,
  domainININativeV1,
  domainINILosslessSyntaxV1,
  domainJavaPropertiesLosslessSyntaxV1,
  domainJavaPropertiesNativeV1,
  domainJSONLosslessSyntaxV1,
  domainJSONLosslessSyntaxV2,
  domainJSONNativeV1,
  domainJSONNativeV2,
  domainPlistBinaryStructureV1,
  domainPlistLosslessSyntaxV1,
  domainPlistNativeV1,
  domainPortableGraphV1,
  domainPortableValueV1,
  domainTOMLLosslessSyntaxV1,
  domainTOMLNativeV1,
  domainXMLLosslessSyntaxV1,
  domainXMLNativeV1,
  domainYAMLLosslessSyntaxV1,
  domainYAMLNativeV1,
} from './protocol/query.ts';
import type { QueryDomain } from './protocol/query.ts';
import type { JsonProfile } from './json/profile.ts';
import { parse as parseJson } from './json/parser.ts';
import type { JsonDocument } from './json/document.ts';
import { formatOperationRegistry as jsonFormatOperationRegistry } from './json/operation_registry.ts';
import { parseToml } from './toml/document.ts';
import type { TomlDocument } from './toml/document.ts';
import { TomlProfile } from './toml/profile.ts';
import { tomlFormatOperationRegistry } from './toml/operation_registry.ts';
import { parse as parseYaml } from './yaml/parser.ts';
import type { YamlDocument } from './yaml/document.ts';
import type { YamlProfile } from './yaml/profile.ts';
import { formatOperationRegistry as yamlFormatOperationRegistry } from './yaml/operation_registry.ts';
import { parseIniDocument } from './ini/document.ts';
import type { IniDocument } from './ini/document.ts';
import { IniProfile } from './ini/profile.ts';
import type { IniEncodingSelection, IniParseLimits } from './ini/profile.ts';
import {
  DEFAULT_INI_PARSE_LIMITS,
  profileDefaultSelection as iniProfileDefaultSelection,
} from './ini/profile.ts';
import { iniFormatOperationRegistry } from './ini/operation_registry.ts';
import { parse as parseProperties } from './properties/parser.ts';
import {
  readerSelection as propertiesReaderSelection,
  latin1Selection as propertiesLatin1Selection,
} from './properties/parser.ts';
import type { PropertiesDocument } from './properties/document.ts';
import { DEFAULT_PROPERTIES_PARSE_LIMITS } from './properties/parse_limits.ts';
import type { PropertiesEncodingSelection } from './properties/parser.ts';
import type { PropertiesParseLimits } from './properties/parse_limits.ts';
import type { PropertiesProfile } from './properties/profile.ts';
import { formatOperationRegistry as propertiesFormatOperationRegistry } from './properties/operation_registry.ts';
import { parse as parseXml } from './xml/parser.ts';
import type { XmlDocument } from './xml/document.ts';
import type { XmlEncodingSelection, XmlParseLimits, XmlProfile } from './xml/profile.ts';
import {
  DEFAULT_XML_PARSE_LIMITS,
  profileDefaultSelection as xmlProfileDefaultSelection,
} from './xml/profile.ts';
import { formatOperationRegistry as xmlFormatOperationRegistry } from './xml/operation_registry.ts';
import { parse as parsePlist } from './plist/parser.ts';
import type { PlistDocument } from './plist/document.ts';
import type {
  PlistEncodingSelection,
  PlistParseLimits,
  PlistProfile,
} from './plist/profile.ts';
import {
  DEFAULT_PLIST_PARSE_LIMITS,
  PROFILE_DEFAULT_ENCODING as plistProfileDefaultEncoding,
} from './plist/profile.ts';
import { formatOperationRegistry as plistFormatOperationRegistry } from './plist/operation_registry.ts';
import { parseHcl } from './hcl/document.ts';
import type { HclDocument, HclEncodingSelection } from './hcl/document.ts';
import { profileDefaultEncoding as hclProfileDefaultEncoding } from './hcl/document.ts';
import { HclProfile } from './hcl/profile.ts';
import { DEFAULT_HCL_PARSE_LIMITS } from './hcl/limits.ts';
import type { HclParseLimits } from './hcl/limits.ts';
import { hclFormatOperationRegistry } from './hcl/operation_registry.ts';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** One profile together with the format family that publishes it (lib.rs:51-69). */
export class FormatProfile {
  readonly #family: FormatFamilyId;
  readonly #profile: ProfileId;

  constructor(family: FormatFamilyId, profile: ProfileId) {
    this.#family = family;
    this.#profile = profile;
  }

  /** Format family of the profile. */
  family(): FormatFamilyId {
    return this.#family;
  }

  /** The profile itself. */
  profile(): ProfileId {
    return this.#profile;
  }
}

function familyProfile(familyId: string, profile: ProfileId): FormatProfile {
  return new FormatProfile(new FormatFamilyId(familyId, 1), profile);
}

/** The eight format families (RFC 0015 §6.2 `families`), sorted by id. */
export function formatFamilies(): FormatFamilyId[] {
  const families = [
    new FormatFamilyId('hcl', 1),
    new FormatFamilyId('ini', 1),
    new FormatFamilyId('java-properties', 1),
    new FormatFamilyId('json', 1),
    new FormatFamilyId('plist', 1),
    new FormatFamilyId('toml', 1),
    new FormatFamilyId('xml', 1),
    new FormatFamilyId('yaml', 1),
  ];
  families.sort((left, right) => (left.id() < right.id() ? -1 : left.id() > right.id() ? 1 : 0));
  return families;
}

/** All sixteen profiles with their owning family (RFC 0015 §6.2 `profiles`), sorted by profile id. */
export function profiles(): FormatProfile[] {
  const list = [
    familyProfile('hcl', new ProfileId('hcl.native', 1)),
    familyProfile('hcl', new ProfileId('hcl.tfvars', 1)),
    familyProfile('ini', new ProfileId('ini.portable', 1)),
    familyProfile('ini', new ProfileId('ini.windows', 1)),
    familyProfile('ini', new ProfileId('ini.python-configparser', 1)),
    familyProfile('java-properties', new ProfileId('java-properties.reader', 1)),
    familyProfile('java-properties', new ProfileId('java-properties.latin1', 1)),
    familyProfile('json', new ProfileId('json.strict', 1)),
    familyProfile('json', new ProfileId('jsonc.bounded', 1)),
    familyProfile('json', new ProfileId('json5.standard', 1)),
    familyProfile('plist', new ProfileId('plist.xml', 1)),
    familyProfile('plist', new ProfileId('plist.binary', 1)),
    familyProfile('toml', new ProfileId('toml.1.0', 1)),
    familyProfile('xml', new ProfileId('xml.1.0-safe', 1)),
    familyProfile('yaml', new ProfileId('yaml.1.2-core', 1)),
    familyProfile('yaml', new ProfileId('yaml.1.1-compat', 1)),
  ];
  list.sort((left, right) => {
    const byId = left.profile().id().localeCompare(right.profile().id());
    if (byId !== 0) {
      return byId;
    }
    return left.profile().version() - right.profile().version();
  });
  return list;
}

/** The query-domain constructor inventory (RFC 0015 §6.2 `query_domains`), sorted by (id, version). */
export function queryDomains(): QueryDomain[] {
  const domains = [
    domainPortableValueV1(),
    domainPortableGraphV1(),
    domainJSONNativeV1(),
    domainJSONNativeV2(),
    domainTOMLNativeV1(),
    domainYAMLNativeV1(),
    domainININativeV1(),
    domainJavaPropertiesNativeV1(),
    domainXMLNativeV1(),
    domainJSONLosslessSyntaxV1(),
    domainJSONLosslessSyntaxV2(),
    domainTOMLLosslessSyntaxV1(),
    domainYAMLLosslessSyntaxV1(),
    domainINILosslessSyntaxV1(),
    domainJavaPropertiesLosslessSyntaxV1(),
    domainXMLLosslessSyntaxV1(),
    domainPlistNativeV1(),
    domainPlistLosslessSyntaxV1(),
    domainPlistBinaryStructureV1(),
    domainHCLNativeV1(),
    domainHCLLosslessSyntaxV1(),
  ];
  domains.sort((left, right) => {
    const byId = left.id.localeCompare(right.id);
    if (byId !== 0) {
      return byId;
    }
    return left.version - right.version;
  });
  return domains;
}

function jsonProfileFor(profileId: string): JsonProfile {
  switch (profileId) {
    case 'json.strict':
      return 'JsonStrict';
    case 'jsonc.bounded':
      return 'JsoncBounded';
    default:
      return 'Json5Standard';
  }
}

function yamlProfileFor(profileId: string): YamlProfile {
  return profileId === 'yaml.1.2-core' ? 'Yaml12CoreV1' : 'Yaml11CompatV1';
}

function propertiesProfileFor(profileId: string): PropertiesProfile {
  return profileId === 'java-properties.reader' ? 'ReaderV1' : 'Latin1V1';
}

function plistProfileFor(profileId: string): PlistProfile {
  return profileId === 'plist.xml' ? 'XmlV1' : 'BinaryV1';
}

function xmlProfileFor(_profileId: string): XmlProfile {
  return 'SafeV1';
}

function hclProfileFor(profileId: string): HclProfile {
  return profileId === 'hcl.native' ? HclProfile.NATIVE_V1 : HclProfile.TFVARS_V1;
}

function iniProfileFor(profileId: string): IniProfile {
  switch (profileId) {
    case 'ini.portable':
      return IniProfile.PORTABLE_V1;
    case 'ini.windows':
      return IniProfile.WINDOWS_V1;
    default:
      return IniProfile.PYTHON_CONFIGPARSER_V1;
  }
}

/** The per-profile operation registry of one exact profile (RFC 0015 §6.2 `operations`); undefined outside the facade surface. */
export function formatOperationRegistry(profile: ProfileId): FormatOperationRegistry | undefined {
  switch (profile.id()) {
    case 'hcl.native':
      return hclFormatOperationRegistry(hclProfileFor('hcl.native'));
    case 'hcl.tfvars':
      return hclFormatOperationRegistry(hclProfileFor('hcl.tfvars'));
    case 'ini.portable':
      return iniFormatOperationRegistry(iniProfileFor('ini.portable'));
    case 'ini.windows':
      return iniFormatOperationRegistry(iniProfileFor('ini.windows'));
    case 'ini.python-configparser':
      return iniFormatOperationRegistry(iniProfileFor('ini.python-configparser'));
    case 'java-properties.reader':
      return propertiesFormatOperationRegistry(propertiesProfileFor('java-properties.reader'));
    case 'java-properties.latin1':
      return propertiesFormatOperationRegistry(propertiesProfileFor('java-properties.latin1'));
    case 'json.strict':
      return jsonFormatOperationRegistry(jsonProfileFor('json.strict'));
    case 'jsonc.bounded':
      return jsonFormatOperationRegistry(jsonProfileFor('jsonc.bounded'));
    case 'json5.standard':
      return jsonFormatOperationRegistry(jsonProfileFor('json5.standard'));
    case 'plist.xml':
      return plistFormatOperationRegistry(plistProfileFor('plist.xml'));
    case 'plist.binary':
      return plistFormatOperationRegistry(plistProfileFor('plist.binary'));
    case 'toml.1.0':
      return tomlFormatOperationRegistry(TomlProfile.TOML_10_V1);
    case 'xml.1.0-safe':
      return xmlFormatOperationRegistry(xmlProfileFor('xml.1.0-safe'));
    case 'yaml.1.2-core':
      return yamlFormatOperationRegistry(yamlProfileFor('yaml.1.2-core'));
    case 'yaml.1.1-compat':
      return yamlFormatOperationRegistry(yamlProfileFor('yaml.1.1-compat'));
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Document union
// ---------------------------------------------------------------------------

/** Typed adapter failure on the common opaque facade (lib.rs:492-510). */
export const FormatMismatch = {
  Ini: 'Ini',
  Properties: 'Properties',
  Json: 'Json',
  Toml: 'Toml',
  Yaml: 'Yaml',
  Xml: 'Xml',
  Plist: 'Plist',
  Hcl: 'Hcl',
} as const;

export type FormatMismatch = (typeof FormatMismatch)[keyof typeof FormatMismatch];

type DocumentInner =
  | { readonly kind: 'Hcl'; readonly document: HclDocument }
  | { readonly kind: 'Ini'; readonly document: IniDocument }
  | { readonly kind: 'Json'; readonly document: JsonDocument }
  | { readonly kind: 'Plist'; readonly document: PlistDocument }
  | { readonly kind: 'Properties'; readonly document: PropertiesDocument }
  | { readonly kind: 'Toml'; readonly document: TomlDocument }
  | { readonly kind: 'Xml'; readonly document: XmlDocument }
  | { readonly kind: 'Yaml'; readonly document: YamlDocument };

/**
 * Common opaque document snapshot over the supported format documents
 * (lib.rs:512-531). The concrete representation is private; format access is
 * only possible through the typed adapters. All returned facts are immutable
 * snapshot facts.
 */
export class Document {
  readonly #inner: DocumentInner;

  private constructor(inner: DocumentInner) {
    this.#inner = inner;
  }

  /** Wraps one already-formed JSON-family document. */
  static fromJson(document: JsonDocument): Document {
    return new Document({ kind: 'Json', document });
  }

  /** Wraps one already-formed TOML document. */
  static fromToml(document: TomlDocument): Document {
    return new Document({ kind: 'Toml', document });
  }

  /** Wraps one already-formed YAML document. */
  static fromYaml(document: YamlDocument): Document {
    return new Document({ kind: 'Yaml', document });
  }

  /** Wraps one already-formed INI document. */
  static fromIni(document: IniDocument): Document {
    return new Document({ kind: 'Ini', document });
  }

  /** Wraps one already-formed Java Properties document. */
  static fromProperties(document: PropertiesDocument): Document {
    return new Document({ kind: 'Properties', document });
  }

  /** Wraps one already-formed XML document. */
  static fromXml(document: XmlDocument): Document {
    return new Document({ kind: 'Xml', document });
  }

  /** Wraps one already-formed Property List document. */
  static fromPlist(document: PlistDocument): Document {
    return new Document({ kind: 'Plist', document });
  }

  /** Wraps one already-formed HCL document. */
  static fromHcl(document: HclDocument): Document {
    return new Document({ kind: 'Hcl', document });
  }

  /** Parses one INI snapshot under an exact profile and explicit encoding selection. */
  static parseIni(
    source: Uint8Array,
    profile: IniProfile,
    encoding: IniEncodingSelection,
    limits: IniParseLimits,
  ): Document {
    return new Document({ kind: 'Ini', document: parseIniDocument(source, profile, encoding, limits) });
  }

  /** Parses one Java Properties snapshot under an exact profile and source contract. */
  static parseProperties(
    source: Uint8Array,
    profile: PropertiesProfile,
    encoding: PropertiesEncodingSelection,
    limits: PropertiesParseLimits,
  ): Document {
    return new Document({ kind: 'Properties', document: parseProperties(source, profile, encoding, limits) });
  }

  /** Parses one JSON/JSONC snapshot under an exact profile. */
  static parseJson(source: Uint8Array, profile: JsonProfile, limits: ParseLimits): Document {
    return new Document({ kind: 'Json', document: parseJson(source, profile, limits) });
  }

  /** Parses one TOML snapshot under the exact profile. */
  static parseToml(source: Uint8Array, profile: TomlProfile, limits: ParseLimits): Document {
    return new Document({ kind: 'Toml', document: parseToml(source, profile, limits) });
  }

  /** Parses one YAML stream under one exact frozen profile. */
  static parseYaml(source: Uint8Array, profile: YamlProfile, limits: ParseLimits): Document {
    return new Document({ kind: 'Yaml', document: parseYaml(source, profile, limits) });
  }

  /** Parses one XML 1.0 safe snapshot under the exact profile and explicit encoding selection. */
  static parseXml(
    source: Uint8Array,
    profile: XmlProfile,
    selection: XmlEncodingSelection,
    limits: XmlParseLimits,
  ): Document {
    return new Document({ kind: 'Xml', document: parseXml(source, profile, selection, limits) });
  }

  /** Parses one Property List snapshot under an exact profile and explicit encoding selection. */
  static parsePlist(
    source: Uint8Array,
    profile: PlistProfile,
    selection: PlistEncodingSelection,
    limits: PlistParseLimits,
  ): Document {
    return new Document({ kind: 'Plist', document: parsePlist(source, profile, selection, limits) });
  }

  /** Parses one HCL snapshot under the exact profile and explicit encoding selection. */
  static parseHcl(
    source: Uint8Array,
    profile: HclProfile,
    selection: HclEncodingSelection,
    limits: HclParseLimits,
  ): Document {
    return new Document({ kind: 'Hcl', document: parseHcl(source, profile, selection, limits) });
  }

  /** Default rendering is byte-for-byte identical to the source. */
  render(): Uint8Array {
    switch (this.#inner.kind) {
      case 'Hcl':
        return this.#inner.document.render();
      case 'Ini':
        return this.#inner.document.render();
      case 'Json':
        return this.#inner.document.render();
      case 'Plist':
        return this.#inner.document.render();
      case 'Properties':
        return this.#inner.document.render();
      case 'Toml':
        return this.#inner.document.render();
      case 'Xml':
        return this.#inner.document.render();
      case 'Yaml':
        return this.#inner.document.render();
    }
  }

  /** Formation status of the underlying snapshot. */
  formationStatus(): FormationStatus {
    switch (this.#inner.kind) {
      case 'Hcl':
        return this.#inner.document.status();
      case 'Ini':
        return this.#inner.document.formationStatus();
      case 'Json':
        return this.#inner.document.formationStatus();
      case 'Plist':
        return this.#inner.document.formationStatus();
      case 'Properties':
        return this.#inner.document.formationStatus();
      case 'Toml':
        return this.#inner.document.formationStatus();
      case 'Xml':
        return this.#inner.document.formationStatus();
      case 'Yaml':
        return this.#inner.document.formationStatus();
    }
  }

  /** Deterministically ordered document diagnostics. */
  diagnostics(): readonly Diagnostic[] {
    switch (this.#inner.kind) {
      case 'Hcl':
        return this.#inner.document.diagnostics();
      case 'Ini':
        return this.#inner.document.diagnostics();
      case 'Json':
        return this.#inner.document.diagnostics();
      case 'Plist':
        return this.#inner.document.diagnostics();
      case 'Properties':
        return this.#inner.document.diagnostics();
      case 'Toml':
        return this.#inner.document.diagnostics();
      case 'Xml':
        return this.#inner.document.diagnostics();
      case 'Yaml':
        return this.#inner.document.diagnostics();
    }
  }

  /** Snapshot identity to which every handle and span belongs. */
  snapshotIdentity(): SnapshotIdentity {
    switch (this.#inner.kind) {
      case 'Hcl':
        return this.#inner.document.snapshotIdentity();
      case 'Ini':
        return this.#inner.document.snapshotIdentity();
      case 'Json':
        return this.#inner.document.snapshotIdentity();
      case 'Plist':
        return this.#inner.document.snapshotIdentity();
      case 'Properties':
        return this.#inner.document.snapshotIdentity();
      case 'Toml':
        return this.#inner.document.snapshotIdentity();
      case 'Xml':
        return this.#inner.document.snapshotIdentity();
      case 'Yaml':
        return this.#inner.document.snapshotIdentity();
    }
  }

  /** Exact source profile of the underlying format document. */
  profile(): ProfileId {
    switch (this.#inner.kind) {
      case 'Hcl':
        return this.#inner.document.profile();
      case 'Ini':
        return this.#inner.document.profile();
      case 'Json':
        return this.#inner.document.profile();
      case 'Plist':
        return this.#inner.document.profile();
      case 'Properties':
        return this.#inner.document.profile();
      case 'Toml':
        return this.#inner.document.profile();
      case 'Xml':
        return this.#inner.document.profile();
      case 'Yaml':
        return this.#inner.document.profile();
    }
  }

  /** Typed JSON adapter; fails only when the snapshot is not JSON. */
  asJson(): JsonDocument | FormatMismatch {
    return this.#inner.kind === 'Json' ? this.#inner.document : FormatMismatch.Json;
  }

  /** Typed TOML adapter; fails only when the snapshot is not TOML. */
  asToml(): TomlDocument | FormatMismatch {
    return this.#inner.kind === 'Toml' ? this.#inner.document : FormatMismatch.Toml;
  }

  /** Typed YAML adapter; fails only when the snapshot is not YAML. */
  asYaml(): YamlDocument | FormatMismatch {
    return this.#inner.kind === 'Yaml' ? this.#inner.document : FormatMismatch.Yaml;
  }

  /** Typed INI adapter; fails only when the snapshot is not INI. */
  asIni(): IniDocument | FormatMismatch {
    return this.#inner.kind === 'Ini' ? this.#inner.document : FormatMismatch.Ini;
  }

  /** Typed Java Properties adapter; fails only when the snapshot is not Properties. */
  asProperties(): PropertiesDocument | FormatMismatch {
    return this.#inner.kind === 'Properties' ? this.#inner.document : FormatMismatch.Properties;
  }

  /** Typed XML adapter; fails only when the snapshot is not XML. */
  asXml(): XmlDocument | FormatMismatch {
    return this.#inner.kind === 'Xml' ? this.#inner.document : FormatMismatch.Xml;
  }

  /** Typed Property List adapter; fails only when the snapshot is not a plist. */
  asPlist(): PlistDocument | FormatMismatch {
    return this.#inner.kind === 'Plist' ? this.#inner.document : FormatMismatch.Plist;
  }

  /** Typed HCL adapter; fails only when the snapshot is not HCL. */
  asHcl(): HclDocument | FormatMismatch {
    return this.#inner.kind === 'Hcl' ? this.#inner.document : FormatMismatch.Hcl;
  }

  /** The union member kind discriminant. */
  kind(): 'hcl' | 'ini' | 'json' | 'plist' | 'properties' | 'toml' | 'xml' | 'yaml' {
    switch (this.#inner.kind) {
      case 'Hcl':
        return 'hcl';
      case 'Ini':
        return 'ini';
      case 'Json':
        return 'json';
      case 'Plist':
        return 'plist';
      case 'Properties':
        return 'properties';
      case 'Toml':
        return 'toml';
      case 'Xml':
        return 'xml';
      case 'Yaml':
        return 'yaml';
    }
  }
}

/** The closed union of the eight family document types. */
export type ConsemaDocument =
  | HclDocument
  | IniDocument
  | JsonDocument
  | PlistDocument
  | PropertiesDocument
  | TomlDocument
  | XmlDocument
  | YamlDocument;

/**
 * Parses one snapshot under an exact profile id through the single facade
 * parse entry (lib.rs registry::parse_document :201-308). Per-format
 * encoding selection and limits use the frozen profile defaults (the
 * properties reader profile uses an explicit UTF-8 selection because its
 * contract has no profile default). An unknown profile id returns the same
 * failure the typed adapters do: resolve ids against `profiles()` first.
 */
export function parseDocument(source: Uint8Array, profile: ProfileId): Document {
  switch (profile.id()) {
    case 'ini.portable':
      return Document.parseIni(source, iniProfileFor('ini.portable'), iniProfileDefaultSelection(), DEFAULT_INI_PARSE_LIMITS);
    case 'ini.windows':
      return Document.parseIni(source, iniProfileFor('ini.windows'), iniProfileDefaultSelection(), DEFAULT_INI_PARSE_LIMITS);
    case 'ini.python-configparser':
      return Document.parseIni(source, iniProfileFor('ini.python-configparser'), iniProfileDefaultSelection(), DEFAULT_INI_PARSE_LIMITS);
    case 'java-properties.reader':
      return Document.parseProperties(
        source,
        'ReaderV1',
        propertiesReaderSelection({ kind: 'Utf8' } as SourceEncoding),
        DEFAULT_PROPERTIES_PARSE_LIMITS,
      );
    case 'java-properties.latin1':
      return Document.parseProperties(source, 'Latin1V1', propertiesLatin1Selection(), DEFAULT_PROPERTIES_PARSE_LIMITS);
    case 'json.strict':
      return Document.parseJson(source, 'JsonStrict', DEFAULT_PARSE_LIMITS);
    case 'jsonc.bounded':
      return Document.parseJson(source, 'JsoncBounded', DEFAULT_PARSE_LIMITS);
    case 'json5.standard':
      return Document.parseJson(source, 'Json5Standard', DEFAULT_PARSE_LIMITS);
    case 'toml.1.0':
      return Document.parseToml(source, TomlProfile.TOML_10_V1, DEFAULT_PARSE_LIMITS);
    case 'yaml.1.2-core':
      return Document.parseYaml(source, 'Yaml12CoreV1', DEFAULT_PARSE_LIMITS);
    case 'yaml.1.1-compat':
      return Document.parseYaml(source, 'Yaml11CompatV1', DEFAULT_PARSE_LIMITS);
    case 'xml.1.0-safe':
      return Document.parseXml(source, 'SafeV1', xmlProfileDefaultSelection(), DEFAULT_XML_PARSE_LIMITS);
    case 'plist.xml':
      return Document.parsePlist(source, 'XmlV1', plistProfileDefaultEncoding, DEFAULT_PLIST_PARSE_LIMITS);
    case 'plist.binary':
      return Document.parsePlist(source, 'BinaryV1', plistProfileDefaultEncoding, DEFAULT_PLIST_PARSE_LIMITS);
    case 'hcl.native':
      return Document.parseHcl(source, hclProfileFor('hcl.native'), hclProfileDefaultEncoding(), DEFAULT_HCL_PARSE_LIMITS);
    case 'hcl.tfvars':
      return Document.parseHcl(source, hclProfileFor('hcl.tfvars'), hclProfileDefaultEncoding(), DEFAULT_HCL_PARSE_LIMITS);
    default:
      throw FatalFormationFailure.fromDiagnostic(
        diagnostic('core.source.encoding-conflict@1', 'Encoding', 'Error', null, 0n),
      );
  }
}
