/**
 * Canonical `xml.safe-canonical-document@1` materialization (RFC 0012 §10).
 *
 * authority: crates/consema-xml/src/materialization.rs
 *  - materialize :37-50, materialize_complete :52-88 (profile gate :91-107,
 *    record validation :239-304 / :306-500, writer :565-900, encode_text
 *    :143-172, parse_limits :109-140, reparse + Complete closure + semantic
 *    comparison :71-87, verify_closure :912-1014)
 *  - the canonical style: declaration spelling, double-quoted attributes,
 *    generated namespace prefixes (`ns1`, `ns2`, … first-encounter order,
 *    :510-526), first-use namespace declaration placement, empty-element
 *    spelling, reference spelling, and the requested LF/CRLF final newline
 *    (RFC 0012 §10 :355-362)
 *  - escaping: text escapes `&` and `<` (:623-634); attribute values escape
 *    `&`, `<`, and `"` (:636-648); CDATA rejects `]]>`; comments reject
 *    `--` and a trailing `-`; PI targets reject `xml` and `?>` in content
 *    (:839-885)
 *  - UTF-8/UTF-16LE/UTF-16BE output under the source rules; UTF-16 output
 *    always carries its BOM (:143-172); requested encoding/newline/limits
 *    are checked before publication (:90-107)
 *  - the input record is the `xml.element-tree@1` PortableValue exactly as
 *    projected (see projection.ts); an element content item is recognized
 *    by its `expanded-name` field (:355-365)
 *  - failure returns no target Document and no partial output bytes
 *  - vector-pinned behavior: conformance/vectors/xml-1-0-safe-v1.json
 *    (xml.materialization.canonical-round-trip, .escapes-content,
 *    .invalid-record-rejected)
 *
 * Design (TypeScript-idiomatic): a bounded writer accumulates exact output
 * bytes; the operation closes only when the output reparses as a Complete
 * document under the promised Profile and the reparsed native tree matches
 * the promised input semantics (RFC 0012 §10 :372-374). Failure returns
 * nothing that could be mistaken for a result.
 */

import {
  CompleteMaterialization,
  FailedMaterializationAttempt,
  MaterializationProvenanceEntry,
  MaterializationProvenanceMap,
  MaterializationReport,
  MaterializationRequest,
  MaterializedOrigin,
  newlineBytes,
} from '../document/materialization.ts';
import type {
  MaterializationInputLocation,
  MaterializationLimits,
  MaterializationRelation,
  MaterializationResult,
} from '../document/materialization.ts';
import { MaterializationFailure } from '../document/errors.ts';
import { AssociationLocation, ValuePath } from '../document/portable_locations.ts';
import type { ValuePathSegment } from '../document/portable_locations.ts';
import type { ParseLimits } from '../document/formation.ts';
import type { PortableValue } from '../core/value.ts';
import type { NodeRef, Span } from '../document/identity.ts';
import type { SourceEncoding } from '../document/source.ts';
import { XmlDocument, XmlElement, normalizeLineEnds, textSemantic } from './document.ts';
import { XML_NAMESPACE_URI } from './namespace.ts';
import { DEFAULT_XML_PARSE_LIMITS } from './profile.ts';
import type { XmlParseLimits } from './profile.ts';
import { parse } from './parser.ts';

// ---------------------------------------------------------------------------
// Input record
// ---------------------------------------------------------------------------

/** Validated input record mirroring `xml.element-tree@1` (materialization.rs:174-237). */
interface Record {
  readonly declaration: DeclarationRecord | null;
  readonly entities: readonly EntityRecord[];
  readonly root: ElementRecord;
}

interface DeclarationRecord {
  readonly version: string;
  readonly encoding: string | null;
  readonly standalone: boolean | null;
  readonly path: ValuePath;
}

interface EntityRecord {
  readonly name: string;
  readonly replacement: string;
  readonly path: ValuePath;
}

interface ElementRecord {
  readonly namespace: string | null;
  readonly local: string;
  readonly namespaces: readonly { readonly prefix: string | null; readonly uri: string }[];
  readonly attributes: readonly AttributeRecord[];
  readonly content: readonly ContentRecord[];
  readonly path: ValuePath;
}

interface AttributeRecord {
  readonly namespace: string | null;
  readonly local: string;
  readonly value: string;
  readonly path: ValuePath;
}

type ContentRecord =
  | { readonly kind: 'Element'; readonly data: ElementRecord }
  | { readonly kind: 'Text'; readonly fragments: readonly FragmentRecord[]; readonly path: ValuePath }
  | { readonly kind: 'Cdata'; readonly text: string; readonly path: ValuePath }
  | { readonly kind: 'Comment'; readonly text: string; readonly path: ValuePath }
  | {
      readonly kind: 'ProcessingInstruction';
      readonly target: string;
      readonly content: string | null;
      readonly path: ValuePath;
    };

type FragmentRecord =
  | { readonly kind: 'Literal'; readonly text: string }
  | { readonly kind: 'CharacterReference'; readonly resolved: string }
  | { readonly kind: 'PredefinedEntity'; readonly name: string; readonly resolved: string }
  | { readonly kind: 'GeneralEntity'; readonly name: string; readonly resolved: string };

/** Validates the input record structure (materialization.rs:239-304). */
function validateRecord(
  value: PortableValue,
  analyzed: ValuePath[],
): Record | MaterializationFailure {
  analyzed.push(ValuePath.root());
  if (value.kind !== 'Object') {
    return new MaterializationFailure('Unrepresentable', {
      reason: `input is not an object (${value.kind})`,
      path: ValuePath.root(),
    });
  }
  const record = stringField(value, 'record', ValuePath.root());
  if (record === null) {
    return new MaterializationFailure('InvalidRequest', { reason: 'missing record field' });
  }
  if (record !== 'xml.element-tree@1') {
    return new MaterializationFailure('InvalidRequest', {
      reason: 'input record is not xml.element-tree@1',
    });
  }
  const rootPath = ValuePath.root().child({ kind: 'ObjectValue', name: 'root' });
  const rootValue = objectField(value, 'root', rootPath);
  if (rootValue === null) {
    return new MaterializationFailure('InvalidRequest', { reason: 'missing root field' });
  }
  const declaration = validateDeclaration(value);
  if (declaration instanceof MaterializationFailure) {
    return declaration;
  }
  const entities = validateEntities(value);
  if (entities instanceof MaterializationFailure) {
    return entities;
  }
  const root = validateElement(rootValue, rootPath, analyzed);
  if (root instanceof MaterializationFailure) {
    return root;
  }
  return { declaration, entities, root };
}

function validateDeclaration(value: PortableValue): DeclarationRecord | null | MaterializationFailure {
  const field = objectField(value, 'declaration', ValuePath.root());
  if (field === null) {
    return null;
  }
  const declaration = field;
  const path = ValuePath.root().child({ kind: 'ObjectValue', name: 'declaration' });
  const version = stringField(declaration, 'version', path);
  if (version === null) {
    return new MaterializationFailure('InvalidRequest', { reason: 'missing declaration.version' });
  }
  if (version !== '1.0') {
    return new MaterializationFailure('Unrepresentable', {
      path: path.child({ kind: 'ObjectValue', name: 'version' }),
      reason: `unsupported declaration version ${version}`,
    });
  }
  const encoding = optionalStringField(declaration, 'encoding', path);
  const standalone = optionalBooleanField(declaration, 'standalone', path);
  return { version, encoding, standalone, path };
}

function validateEntities(value: PortableValue): readonly EntityRecord[] | MaterializationFailure {
  const field = sequenceField(value, 'entities', ValuePath.root());
  if (field === null) {
    return [];
  }
  const { value: entities, path } = field;
  const out: EntityRecord[] = [];
  for (let index = 0; index < entities.length; index++) {
    const entityPath = path.child({ kind: 'SequenceElement', index: BigInt(index) });
    const entity = entities[index];
    if (entity.kind !== 'Object') {
      return new MaterializationFailure('Unrepresentable', {
        path: entityPath,
        reason: 'entity entry is not an object',
      });
    }
    const name = stringField(entity, 'name', entityPath);
    const replacement = stringField(entity, 'replacement', entityPath);
    if (name === null || replacement === null) {
      return new MaterializationFailure('InvalidRequest', { reason: 'missing entity fields' });
    }
    if (replacement.includes('<')) {
      return new MaterializationFailure('Unrepresentable', {
        path: entityPath.child({ kind: 'ObjectValue', name: 'replacement' }),
        reason: 'entity replacement would create markup',
      });
    }
    out.push({ name, replacement, path: entityPath });
  }
  return out;
}

function validateElement(
  value: PortableValue,
  path: ValuePath,
  analyzed: ValuePath[],
): ElementRecord | MaterializationFailure {
  analyzed.push(path);
  const expandedName = expandedNameField(value, path);
  if (expandedName instanceof MaterializationFailure) {
    return expandedName;
  }
  const namespaces: { prefix: string | null; uri: string }[] = [];
  const bindings = sequenceField(value, 'namespaces', path);
  if (bindings !== null) {
    const { value: bindingsValue, path: bindingsPath } = bindings;
    for (let index = 0; index < bindingsValue.length; index++) {
      const bindingPath = bindingsPath.child({ kind: 'SequenceElement', index: BigInt(index) });
      const binding = bindingsValue[index];
      if (binding.kind !== 'Object') {
        return new MaterializationFailure('Unrepresentable', {
          path: bindingPath,
          reason: 'namespace binding is not an object',
        });
      }
      const prefix = optionalStringField(binding, 'prefix', bindingPath);
      const uri = stringField(binding, 'uri', bindingPath);
      if (uri === null) {
        return new MaterializationFailure('InvalidRequest', { reason: 'missing binding.uri' });
      }
      namespaces.push({ prefix, uri });
    }
  }
  const attributes: AttributeRecord[] = [];
  const attributeSequence = sequenceField(value, 'attributes', path);
  if (attributeSequence !== null) {
    const { value: attributesValue, path: attributesPath } = attributeSequence;
    for (let index = 0; index < attributesValue.length; index++) {
      const attributePath = attributesPath.child({ kind: 'SequenceElement', index: BigInt(index) });
      const attribute = attributesValue[index];
      if (attribute.kind !== 'Object') {
        return new MaterializationFailure('Unrepresentable', {
          path: attributePath,
          reason: 'attribute is not an object',
        });
      }
      const attributeName = expandedNameField(attribute, attributePath);
      if (attributeName instanceof MaterializationFailure) {
        return attributeName;
      }
      const valueText = stringField(attribute, 'value', attributePath);
      if (valueText === null) {
        return new MaterializationFailure('InvalidRequest', { reason: 'missing attribute.value' });
      }
      attributes.push({
        namespace: attributeName.namespace,
        local: attributeName.local,
        value: valueText,
        path: attributePath,
      });
    }
  }
  const content: ContentRecord[] = [];
  const contentSequence = sequenceField(value, 'content', path);
  if (contentSequence !== null) {
    const { value: contentValue, path: contentPath } = contentSequence;
    for (let index = 0; index < contentValue.length; index++) {
      const itemPath = contentPath.child({ kind: 'SequenceElement', index: BigInt(index) });
      const item = contentValue[index];
      if (item.kind === 'Object' && item.entries.some((entry) => entry.key === 'expanded-name')) {
        const element = validateElement(item, itemPath, analyzed);
        if (element instanceof MaterializationFailure) {
          return element;
        }
        content.push({ kind: 'Element', data: element });
        continue;
      }
      if (item.kind !== 'Object') {
        return new MaterializationFailure('Unrepresentable', {
          path: itemPath,
          reason: 'content item is not an object',
        });
      }
      const kind = stringField(item, 'kind', itemPath);
      if (kind === null) {
        return new MaterializationFailure('InvalidRequest', { reason: 'missing content.kind' });
      }
      switch (kind) {
        case 'text': {
          const fragmentsPath = itemPath.child({ kind: 'ObjectValue', name: 'fragments' });
          const fragmentsField = objectField(item, 'fragments', fragmentsPath);
          if (fragmentsField === null) {
            return new MaterializationFailure('InvalidRequest', { reason: 'missing text.fragments' });
          }
          if (fragmentsField.kind !== 'Sequence') {
            return new MaterializationFailure('Unrepresentable', {
              path: fragmentsPath,
              reason: 'fragments is not a sequence',
            });
          }
          const fragments = fragmentsField.items;
          const out: FragmentRecord[] = [];
          for (let fragmentIndex = 0; fragmentIndex < fragments.length; fragmentIndex++) {
            const fragmentPath = fragmentsPath.child(
              { kind: 'SequenceElement', index: BigInt(fragmentIndex) },
            );
            const fragment = fragments[fragmentIndex];
            if (fragment.kind !== 'Object') {
              return new MaterializationFailure('Unrepresentable', {
                path: fragmentPath,
                reason: 'fragment is not an object',
              });
            }
            const fragmentKind = stringField(fragment, 'kind', fragmentPath);
            if (fragmentKind === null) {
              return new MaterializationFailure('InvalidRequest', { reason: 'missing fragment.kind' });
            }
            switch (fragmentKind) {
              case 'literal': {
                const text = stringField(fragment, 'text', fragmentPath);
                if (text === null) {
                  return new MaterializationFailure('InvalidRequest', { reason: 'missing literal.text' });
                }
                out.push({ kind: 'Literal', text });
                break;
              }
              case 'character-reference': {
                const resolved = stringField(fragment, 'resolved', fragmentPath);
                if (resolved === null || [...resolved].length !== 1) {
                  return new MaterializationFailure('Unrepresentable', {
                    path: fragmentPath,
                    reason: 'character-reference resolved must be one scalar',
                  });
                }
                out.push({ kind: 'CharacterReference', resolved });
                break;
              }
              case 'predefined-entity': {
                const name = stringField(fragment, 'name', fragmentPath);
                const resolved = stringField(fragment, 'resolved', fragmentPath);
                if (name === null || resolved === null) {
                  return new MaterializationFailure('InvalidRequest', {
                    reason: 'missing predefined-entity fields',
                  });
                }
                out.push({ kind: 'PredefinedEntity', name, resolved });
                break;
              }
              case 'general-entity': {
                const name = stringField(fragment, 'name', fragmentPath);
                const resolved = stringField(fragment, 'resolved', fragmentPath);
                if (name === null || resolved === null) {
                  return new MaterializationFailure('InvalidRequest', {
                    reason: 'missing general-entity fields',
                  });
                }
                out.push({ kind: 'GeneralEntity', name, resolved });
                break;
              }
              default:
                return new MaterializationFailure('Unrepresentable', {
                  path: fragmentPath,
                  reason: `unknown fragment kind ${fragmentKind}`,
                });
            }
          }
          content.push({ kind: 'Text', fragments: out, path: itemPath });
          break;
        }
        case 'cdata': {
          const text = stringField(item, 'text', itemPath);
          if (text === null) {
            return new MaterializationFailure('InvalidRequest', { reason: 'missing cdata.text' });
          }
          content.push({ kind: 'Cdata', text, path: itemPath });
          break;
        }
        case 'comment': {
          const text = stringField(item, 'text', itemPath);
          if (text === null) {
            return new MaterializationFailure('InvalidRequest', { reason: 'missing comment.text' });
          }
          content.push({ kind: 'Comment', text, path: itemPath });
          break;
        }
        case 'processing-instruction': {
          const target = stringField(item, 'target', itemPath);
          if (target === null) {
            return new MaterializationFailure('InvalidRequest', { reason: 'missing pi.target' });
          }
          const contentText = optionalStringField(item, 'content', itemPath);
          content.push({ kind: 'ProcessingInstruction', target, content: contentText, path: itemPath });
          break;
        }
        default:
          return new MaterializationFailure('Unrepresentable', {
            path: itemPath,
            reason: `unknown content kind ${kind}`,
          });
      }
    }
  }
  const names: { namespace: string | null; local: string }[] = [];
  for (const attribute of attributes) {
    if (names.some((existing) => existing.namespace === attribute.namespace && existing.local === attribute.local)) {
      return new MaterializationFailure('InvalidRequest', {
        reason: 'duplicate expanded attribute in input record',
      });
    }
    names.push({ namespace: attribute.namespace, local: attribute.local });
  }
  return {
    namespace: expandedName.namespace,
    local: expandedName.local,
    namespaces,
    attributes,
    content,
    path,
  };
}

// ---------------------------------------------------------------------------
// Field accessors
// ---------------------------------------------------------------------------

function objectField(value: PortableValue, key: string, path: ValuePath): PortableValue | null {
  if (value.kind !== 'Object') {
    return null;
  }
  const entry = value.entries.find((candidate) => candidate.key === key);
  return entry === undefined ? null : entry.value;
}

function stringField(value: PortableValue, key: string, path: ValuePath): string | null {
  const field = objectField(value, key, path);
  if (field === null || field.kind !== 'String') {
    return null;
  }
  return field.value;
}

function optionalStringField(value: PortableValue, key: string, path: ValuePath): string | null {
  const field = objectField(value, key, path);
  if (field === null) {
    return null;
  }
  if (field.kind !== 'String') {
    return null;
  }
  return field.value;
}

function optionalBooleanField(value: PortableValue, key: string, path: ValuePath): boolean | null {
  const field = objectField(value, key, path);
  if (field === null) {
    return null;
  }
  if (field.kind !== 'Boolean') {
    return null;
  }
  return field.value;
}

/** One optional sequence field with its exact container path. */
function sequenceField(
  value: PortableValue,
  key: string,
  container: ValuePath,
): { value: readonly PortableValue[]; path: ValuePath } | null {
  const field = objectField(value, key, container);
  if (field === null || field.kind !== 'Sequence') {
    return null;
  }
  return {
    value: field.items,
    path: container.child({ kind: 'ObjectValue', name: key }),
  };
}

/** The `expanded-name` record of one element or attribute (materialization.rs:313). */
function expandedNameField(
  value: PortableValue,
  path: ValuePath,
): { namespace: string | null; local: string } | MaterializationFailure {
  const name = objectField(value, 'expanded-name', path);
  if (name === null || name.kind !== 'Object') {
    return new MaterializationFailure('Unrepresentable', {
      path: path.child({ kind: 'ObjectValue', name: 'expanded-name' }),
      reason: 'expanded-name is not an object',
    });
  }
  const namespace = optionalStringField(name, 'namespace', path);
  const local = stringField(name, 'local', path);
  if (local === null) {
    return new MaterializationFailure('InvalidRequest', { reason: 'missing expanded-name.local' });
  }
  return { namespace, local };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** One input location recorded during generation, paired by order with the reparsed document (materialization.rs:528-563). */
type InputItem =
  | { readonly kind: 'Declaration'; readonly path: ValuePath }
  | { readonly kind: 'Entity'; readonly path: ValuePath }
  | { readonly kind: 'Element'; readonly path: ValuePath }
  | { readonly kind: 'NamespaceBinding'; readonly path: ValuePath }
  | { readonly kind: 'Attribute'; readonly path: ValuePath }
  | { readonly kind: 'Text'; readonly path: ValuePath }
  | { readonly kind: 'Fragment'; readonly path: ValuePath }
  | { readonly kind: 'Cdata'; readonly path: ValuePath }
  | { readonly kind: 'Comment'; readonly path: ValuePath }
  | { readonly kind: 'ProcessingInstruction'; readonly path: ValuePath };

function inputItemLocation(item: InputItem): MaterializationInputLocation {
  switch (item.kind) {
    case 'NamespaceBinding':
      return {
        kind: 'Association',
        location: new AssociationLocation(item.path, 0n, 'ObjectEntry'),
      };
    default:
      return { kind: 'Value', path: item.path };
  }
}

/** Deterministic generated-prefix assignment by first-encounter order (materialization.rs:502-526). */
class PrefixTable {
  readonly #entries = new Map<string, string>();
  #next = 0;

  prefixFor(namespace: string, defaultNamespace: string | null): string {
    if (namespace === defaultNamespace) {
      return '';
    }
    if (namespace === XML_NAMESPACE_URI) {
      return 'xml';
    }
    const existing = this.#entries.get(namespace);
    if (existing !== undefined) {
      return existing;
    }
    this.#next += 1;
    const prefix = `ns${this.#next}`;
    this.#entries.set(namespace, prefix);
    return prefix;
  }
}

class Writer {
  readonly #limits: MaterializationLimits;
  #inputNodes = 0;
  #output: Uint8Array[] = [];
  #outputBytes = 0;
  readonly #prefixes = new PrefixTable();
  /** In-scope bindings as `(prefix, uri)` with `null` the default namespace. */
  #scope: { prefix: string | null; uri: string }[] = [];
  readonly #items: InputItem[] = [];

  constructor(limits: MaterializationLimits) {
    this.#limits = limits;
  }

  step(): void {
    this.#inputNodes += 1;
    if (this.#inputNodes > this.#limits.maxInputNodes) {
      throw new MaterializationFailure('ResourceLimit', { reason: '' });
    }
  }

  push(text: string | Uint8Array): void {
    const bytes = typeof text === 'string' ? utf8BytesOf(text) : text;
    this.#outputBytes += bytes.length;
    if (this.#outputBytes > this.#limits.maxOutputBytes) {
      throw new MaterializationFailure('ResourceLimit', { reason: '' });
    }
    this.#output.push(bytes);
  }

  pushEscapedText(text: string): void {
    let rest = text;
    for (;;) {
      const at = indexOfAny(rest, ['&', '<']);
      if (at < 0) {
        break;
      }
      this.push(rest.slice(0, at));
      this.push(rest[at] === '&' ? '&amp;' : '&lt;');
      rest = rest.slice(at + 1);
    }
    this.push(rest);
  }

  pushEscapedAttribute(text: string): void {
    let rest = text;
    for (;;) {
      const at = indexOfAny(rest, ['&', '<', '"']);
      if (at < 0) {
        break;
      }
      this.push(rest.slice(0, at));
      const character = rest[at];
      this.push(character === '&' ? '&amp;' : character === '<' ? '&lt;' : '&quot;');
      rest = rest.slice(at + 1);
    }
    this.push(rest);
  }

  /** Spelling prefix for one expanded namespace, using the current scope (materialization.rs:596-621). */
  spellingPrefix(uri: string | null): string | null {
    if (uri === null) {
      return '';
    }
    if (uri === XML_NAMESPACE_URI) {
      return 'xml';
    }
    for (let index = this.#scope.length - 1; index >= 0; index--) {
      if (this.#scope[index].prefix === null && this.#scope[index].uri === uri) {
        return '';
      }
    }
    for (let index = this.#scope.length - 1; index >= 0; index--) {
      if (this.#scope[index].prefix !== null && this.#scope[index].uri === uri) {
        return this.#scope[index].prefix!;
      }
    }
    return null;
  }

  emitDocument(input: Record, request: MaterializationRequest): void {
    this.step();
    if (input.declaration !== null) {
      const declaration = input.declaration;
      this.#items.push({ kind: 'Declaration', path: declaration.path });
      this.push('<?xml version="');
      this.pushEscapedAttribute(declaration.version);
      this.push('"');
      const declaredEncoding = declaration.encoding ?? (request.encoding().kind === 'Utf16Le' || request.encoding().kind === 'Utf16Be' ? 'UTF-16' : null);
      if (declaredEncoding !== null) {
        this.push(' encoding="');
        this.pushEscapedAttribute(declaredEncoding);
        this.push('"');
      }
      if (declaration.standalone !== null) {
        this.push(declaration.standalone ? ' standalone="yes"' : ' standalone="no"');
      }
      this.push('?>');
    }
    if (input.entities.length > 0) {
      this.push('<!DOCTYPE ');
      const spelling = this.spellingPrefix(input.root.namespace);
      if (spelling === null) {
        // An unbound root namespace cannot be named in the DOCTYPE without a
        // declaration; fail honestly (materialization.rs:688-699).
        throw new MaterializationFailure('Unrepresentable', {
          path: input.root.path,
          reason: 'unbound root namespace in DOCTYPE',
        });
      }
      this.push(spelling.length === 0 ? input.root.local : `${spelling}:${input.root.local}`);
      this.push(' [');
      for (const entity of input.entities) {
        this.#items.push({ kind: 'Entity', path: entity.path });
        this.push('<!ENTITY ');
        this.push(entity.name);
        this.push(' "');
        this.pushEscapedAttribute(entity.replacement);
        this.push('">');
      }
      this.push(']>');
    }
    this.emitElement(input.root, 0);
    this.push(newlineBytes(request.newline()));
  }

  emitElement(element: ElementRecord, depth: number): void {
    this.step();
    if (depth > this.#limits.maxDepth) {
      throw new MaterializationFailure('ResourceLimit', { reason: '' });
    }
    this.#items.push({ kind: 'Element', path: element.path });
    const scopeLength = this.#scope.length;
    for (const binding of element.namespaces) {
      this.#scope.push(binding);
    }
    const elementPrefix = this.spellingPrefix(element.namespace) ?? (() => {
      // Unbound URI in a hand-built record: declare a generated default
      // namespace on this element (materialization.rs:733-753).
      const uri = element.namespace ?? XML_NAMESPACE_URI;
      if (uri === XML_NAMESPACE_URI) {
        return 'xml';
      }
      this.push('<');
      this.push(element.local);
      this.push(' xmlns="');
      this.pushEscapedAttribute(uri);
      this.push('"');
      this.#scope.push({ prefix: null, uri });
      this.#items.push({ kind: 'NamespaceBinding', path: element.path });
      return '';
    })();
    this.push('<');
    this.push(elementPrefix.length === 0 ? element.local : `${elementPrefix}:${element.local}`);
    for (const binding of element.namespaces) {
      this.#items.push({ kind: 'NamespaceBinding', path: element.path });
      if (binding.prefix !== null) {
        this.push(` xmlns:${binding.prefix}="`);
        this.pushEscapedAttribute(binding.uri);
        this.push('"');
      } else {
        this.push(' xmlns="');
        this.pushEscapedAttribute(binding.uri);
        this.push('"');
      }
    }
    for (const attribute of element.attributes) {
      this.#items.push({ kind: 'Attribute', path: attribute.path });
      const attributePrefix = this.spellingPrefix(attribute.namespace) ?? (() => {
        // Unbound attribute namespace: declare a generated prefix on this
        // element (materialization.rs:780-797).
        const uri = attribute.namespace ?? XML_NAMESPACE_URI;
        const generated = this.#prefixes.prefixFor(uri, null);
        this.push(` xmlns:${generated}="`);
        this.pushEscapedAttribute(uri);
        this.push('"');
        this.#scope.push({ prefix: generated, uri });
        this.#items.push({ kind: 'NamespaceBinding', path: element.path });
        return generated;
      })();
      this.push(' ');
      this.push(attributePrefix.length === 0 ? attribute.local : `${attributePrefix}:${attribute.local}`);
      this.push('="');
      this.pushEscapedAttribute(attribute.value);
      this.push('"');
    }
    if (element.content.length === 0) {
      this.push('/>');
      this.#scope.length = scopeLength;
      return;
    }
    this.push('>');
    for (const item of element.content) {
      switch (item.kind) {
        case 'Element':
          this.emitElement(item.data, depth + 1);
          break;
        case 'Text': {
          this.#items.push({ kind: 'Text', path: item.path });
          for (const fragment of item.fragments) {
            this.#items.push({ kind: 'Fragment', path: item.path });
            switch (fragment.kind) {
              case 'Literal':
                this.pushEscapedText(fragment.text);
                break;
              case 'CharacterReference':
                this.push(`&#${fragment.resolved.codePointAt(0)!};`);
                break;
              case 'PredefinedEntity':
              case 'GeneralEntity':
                this.push(`&${fragment.name};`);
                break;
            }
          }
          break;
        }
        case 'Cdata':
          this.#items.push({ kind: 'Cdata', path: item.path });
          if (item.text.includes(']]>')) {
            throw new MaterializationFailure('Unrepresentable', {
              path: item.path,
              reason: 'CDATA text contains ]]>',
            });
          }
          this.push(`<![CDATA[${item.text}]]>`);
          break;
        case 'Comment':
          this.#items.push({ kind: 'Comment', path: item.path });
          if (item.text.includes('--') || item.text.endsWith('-')) {
            throw new MaterializationFailure('Unrepresentable', {
              path: item.path,
              reason: 'comment text contains -- or ends with -',
            });
          }
          this.push(`<!--${item.text}-->`);
          break;
        case 'ProcessingInstruction':
          this.#items.push({ kind: 'ProcessingInstruction', path: item.path });
          if (item.target.toLowerCase() === 'xml' || (item.content ?? '').includes('?>')) {
            throw new MaterializationFailure('Unrepresentable', {
              path: item.path,
              reason: 'PI target xml or ?> in content',
            });
          }
          this.push(`<?${item.target}`);
          if (item.content !== null) {
            this.push(` ${item.content}`);
          }
          this.push('?>');
          break;
      }
    }
    this.push('</');
    this.push(elementPrefix.length === 0 ? element.local : `${elementPrefix}:${element.local}`);
    this.push('>');
    this.#scope.length = scopeLength;
  }

  items(): readonly InputItem[] {
    return this.#items;
  }

  outputBytes(): Uint8Array {
    const total = this.#outputBytes;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of this.#output) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return merged;
  }
}

// ---------------------------------------------------------------------------
// Output encoding
// ---------------------------------------------------------------------------

/** Encodes canonical UTF-8 text into the requested output encoding (materialization.rs:143-172). */
function encodeText(text: Uint8Array, encoding: SourceEncoding, maxOutputBytes: number): Uint8Array | null {
  let output: Uint8Array;
  switch (encoding.kind) {
    case 'Utf8':
      output = text;
      break;
    case 'Utf16Le':
    case 'Utf16Be': {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(text);
      const units: number[] = [];
      for (let index = 0; index < decoded.length; index++) {
        units.push(decoded.charCodeAt(index));
      }
      const bom = encoding.kind === 'Utf16Le' ? [0xff, 0xfe] : [0xfe, 0xff];
      output = new Uint8Array(bom.length + units.length * 2);
      output[0] = bom[0];
      output[1] = bom[1];
      for (let index = 0; index < units.length; index++) {
        const unit = units[index];
        if (encoding.kind === 'Utf16Le') {
          output[bom.length + index * 2] = unit & 0xff;
          output[bom.length + index * 2 + 1] = (unit >> 8) & 0xff;
        } else {
          output[bom.length + index * 2] = (unit >> 8) & 0xff;
          output[bom.length + index * 2 + 1] = unit & 0xff;
        }
      }
      break;
    }
    default:
      throw new MaterializationFailure('UnsupportedEncoding');
  }
  if (output.length > maxOutputBytes) {
    throw new MaterializationFailure('ResourceLimit', { reason: '' });
  }
  return output;
}

/** Parse limits derived from one materialization request (materialization.rs:109-140). */
function parseLimitsFor(limits: MaterializationLimits): XmlParseLimits {
  return {
    ...DEFAULT_XML_PARSE_LIMITS,
    common: {
      maxSourceBytes: limits.maxOutputBytes,
      maxNestingDepth: limits.maxDepth,
      maxTokenCount: limits.maxOutputBytes,
      maxNodeCount: limits.maxInputNodes,
      maxDiagnostics: limits.maxReportEntries,
    } satisfies ParseLimits,
    maxDecodedUtf8Bytes: limits.maxOutputBytes * 3,
    maxDecodedScalars: limits.maxOutputBytes,
    maxElementCount: limits.maxInputNodes,
    maxAttributeCount: limits.maxInputNodes,
    maxNamespaceDeclarationCount: limits.maxInputNodes,
    maxMixedContentItems: limits.maxInputNodes,
    maxQNameLength: limits.maxOutputBytes,
    maxNamespaceUriLength: limits.maxOutputBytes,
    maxAttributeValueLength: limits.maxOutputBytes,
    maxCommentLength: limits.maxOutputBytes,
    maxPiLength: limits.maxOutputBytes,
    maxCdataLength: limits.maxOutputBytes,
    maxTextLength: limits.maxOutputBytes,
    maxDtdBytes: limits.maxOutputBytes,
    maxEntityDeclarations: limits.maxInputNodes,
    maxEntityReferences: limits.maxInputNodes,
    maxEntityExpansionDepth: limits.maxDepth,
    maxExpandedEntityBytes: limits.maxOutputBytes,
    maxExpandedEntityScalars: limits.maxOutputBytes,
    maxEntityAmplificationRatio: Number.MAX_SAFE_INTEGER,
    maxRecoveryRegions: limits.maxReportEntries,
  };
}

// ---------------------------------------------------------------------------
// Closure verification
// ---------------------------------------------------------------------------

/** One matched output origin in the reparsed document (materialization.rs:903-907). */
interface OutputItem {
  readonly node: NodeRef;
  readonly span: Span;
  readonly relation: MaterializationRelation;
}

/**
 * Walks the input record and the reparsed document in lockstep, compares
 * the promised semantics, and pairs every recorded input location with its
 * exact output origin (materialization.rs:912-1014).
 */
function verifyClosure(
  input: Record,
  document: XmlDocument,
  items: readonly InputItem[],
  limits: MaterializationLimits,
): MaterializationProvenanceMap | MaterializationFailure {
  const outputs: OutputItem[] = [];
  const root = document.root();
  if (root === null) {
    return new MaterializationFailure('FormationFailed', { reason: 'reparse produced no root' });
  }
  const declared = document.declaration();
  if (input.declaration !== null && declared !== null) {
    if (declared.version !== input.declaration.version) {
      return new MaterializationFailure('FormationFailed', { reason: 'declaration version mismatch' });
    }
  } else if ((input.declaration === null) !== (declared === null)) {
    return new MaterializationFailure('FormationFailed', { reason: 'declaration presence mismatch' });
  }
  const doctype = document.doctype();
  if (input.entities.length > 0) {
    if (doctype === null || doctype.entities.length !== input.entities.length) {
      return new MaterializationFailure('FormationFailed', { reason: 'entity count mismatch' });
    }
    for (let index = 0; index < input.entities.length; index++) {
      const reparsed = doctype.entities[index];
      const promised = input.entities[index];
      if (reparsed.name !== promised.name || reparsed.replacement !== promised.replacement) {
        return new MaterializationFailure('FormationFailed', { reason: 'entity facts mismatch' });
      }
    }
  } else if (doctype !== null && doctype.entities.length > 0) {
    return new MaterializationFailure('FormationFailed', { reason: 'unexpected entities' });
  }
  if (input.declaration !== null && declared !== null) {
    outputs.push({
      node: document.occurrenceNodeRef(0, 'XmlDeclaration'),
      span: declared.span,
      relation: 'Direct',
    });
  }
  if (doctype !== null) {
    for (const entity of doctype.entities) {
      outputs.push({
        node: document.occurrenceNodeRef(0, 'XmlDoctype'),
        span: entity.span,
        relation: 'Direct',
      });
    }
  }
  const context = new ClosureContext(document, outputs, limits);
  const result = context.element(input.root, root);
  if (result !== null) {
    return result;
  }
  if (outputs.length !== items.length) {
    return new MaterializationFailure('FormationFailed', { reason: 'input/output count mismatch' });
  }
  const identity = document.snapshotIdentity();
  const entries: MaterializationProvenanceEntry[] = [];
  for (let index = 0; index < items.length; index++) {
    const location = inputItemLocation(items[index]);
    const output = outputs[index];
    const origin = new MaterializedOrigin(identity, output.node, output.span, output.relation);
    const last = entries[entries.length - 1];
    if (last !== undefined && locationsEqual(last.input(), location)) {
      // Adjacent items with the same input location share one provenance
      // entry (materialization.rs:1002-1011); the entry is rebuilt with
      // both origins because the class is immutable.
      const combined = [...last.outputs(), origin];
      entries[entries.length - 1] = new MaterializationProvenanceEntry(location, combined);
      continue;
    }
    entries.push(new MaterializationProvenanceEntry(location, [origin]));
  }
  return MaterializationProvenanceMap.create(entries, identity, limits);
}

function locationsEqual(left: MaterializationInputLocation, right: MaterializationInputLocation): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'Value' && right.kind === 'Value') {
    return pathsEqual(left.path, right.path);
  }
  if (left.kind === 'Association' && right.kind === 'Association') {
    return (
      left.location.ordinal() === right.location.ordinal() &&
      left.location.role() === right.location.role() &&
      pathsEqual(left.location.container(), right.location.container())
    );
  }
  return false;
}

function pathsEqual(left: ValuePath, right: ValuePath): boolean {
  return left.equals(right);
}

class ClosureContext {
  readonly #document: XmlDocument;
  readonly #outputs: OutputItem[];
  readonly #limits: MaterializationLimits;

  constructor(document: XmlDocument, outputs: OutputItem[], limits: MaterializationLimits) {
    this.#document = document;
    this.#outputs = outputs;
    this.#limits = limits;
  }

  push(node: NodeRef, span: Span, relation: MaterializationRelation): void {
    if (this.#outputs.length >= this.#limits.maxProvenanceEntries) {
      throw new MaterializationFailure('ResourceLimit', { reason: '' });
    }
    this.#outputs.push({ node, span, relation });
  }

  element(input: ElementRecord, handle: XmlElement): MaterializationFailure | null {
    this.push(handle.nodeRef(), handle.span(), 'Direct');
    const expanded = handle.expanded();
    if (expanded === null) {
      return new MaterializationFailure('FormationFailed', { reason: 'unresolved element name' });
    }
    const matches =
      (input.namespace ?? '') === (expanded.namespace ?? '') && expanded.local === input.local;
    if (!matches) {
      return new MaterializationFailure('FormationFailed', { reason: 'element name mismatch' });
    }
    for (const binding of handle.namespaceBindings()) {
      this.push(
        this.#document.occurrenceNodeRef(binding.ordinal, 'XmlNamespaceBinding'),
        binding.span,
        'Generated',
      );
    }
    const attributes = handle.attributes();
    if (attributes.length !== input.attributes.length) {
      return new MaterializationFailure('FormationFailed', { reason: 'attribute count mismatch' });
    }
    for (let index = 0; index < input.attributes.length; index++) {
      const promised = input.attributes[index];
      const attribute = attributes[index];
      this.push(
        this.#document.occurrenceNodeRef(attribute.ordinal, 'XmlAttribute'),
        attribute.span,
        'Direct',
      );
      if (attribute.expanded === null) {
        return new MaterializationFailure('FormationFailed', { reason: 'unresolved attribute name' });
      }
      if (
        (promised.namespace ?? '') !== (attribute.expanded.namespace ?? '') ||
        promised.local !== attribute.expanded.local ||
        promised.value !== attribute.normalizedValue
      ) {
        return new MaterializationFailure('FormationFailed', { reason: 'attribute facts mismatch' });
      }
    }
    const children = handle.children();
    if (children.length !== input.content.length) {
      return new MaterializationFailure('FormationFailed', { reason: 'content count mismatch' });
    }
    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      const promised = input.content[index];
      const childElement = child.element();
      if (childElement !== null && promised.kind === 'Element') {
        const failure = this.element(promised.data, childElement);
        if (failure !== null) {
          return failure;
        }
        continue;
      }
      if (childElement !== null || promised.kind === 'Element') {
        return new MaterializationFailure('FormationFailed', { reason: 'content kind mismatch' });
      }
      switch (promised.kind) {
        case 'Text': {
          const text = child.text();
          if (text === null) {
            return new MaterializationFailure('FormationFailed', { reason: 'expected text' });
          }
          this.push(
            this.#document.occurrenceNodeRef(text.ordinal, 'XmlText'),
            text.span,
            'Direct',
          );
          let semantic = '';
          for (const fragment of promised.fragments) {
            switch (fragment.kind) {
              case 'Literal':
                semantic += normalizeLineEnds(fragment.text);
                break;
              case 'CharacterReference':
                semantic += fragment.resolved;
                break;
              case 'PredefinedEntity':
              case 'GeneralEntity':
                semantic += normalizeLineEnds(fragment.resolved);
                break;
            }
            this.push(
              this.#document.occurrenceNodeRef(text.ordinal, 'XmlEntityReference'),
              text.fragments[0] === undefined ? text.span : text.fragments[0].span,
              'Direct',
            );
          }
          if (textSemantic(text) !== semantic) {
            return new MaterializationFailure('FormationFailed', { reason: 'text semantics mismatch' });
          }
          break;
        }
        case 'Cdata': {
          const cdata = child.cdata();
          if (cdata === null || cdata.text !== promised.text) {
            return new MaterializationFailure('FormationFailed', { reason: 'cdata mismatch' });
          }
          this.push(
            this.#document.occurrenceNodeRef(cdata.ordinal, 'XmlCdata'),
            cdata.span,
            'Direct',
          );
          break;
        }
        case 'Comment': {
          const comment = child.comment();
          if (comment === null || comment.text !== promised.text) {
            return new MaterializationFailure('FormationFailed', { reason: 'comment mismatch' });
          }
          this.push(
            this.#document.occurrenceNodeRef(comment.ordinal, 'XmlComment'),
            comment.span,
            'Direct',
          );
          break;
        }
        case 'ProcessingInstruction': {
          const pi = child.processingInstruction();
          if (pi === null || pi.target !== promised.target) {
            return new MaterializationFailure('FormationFailed', { reason: 'pi mismatch' });
          }
          this.push(
            this.#document.occurrenceNodeRef(pi.ordinal, 'XmlProcessingInstruction'),
            pi.span,
            'Direct',
          );
          break;
        }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Materializes one `xml.element-tree@1` record into a new canonical
 * `xml.1.0-safe@1` document (materialization.rs:37-50).
 */
export function materialize(
  value: PortableValue,
  request: MaterializationRequest,
): MaterializationResult<XmlDocument> {
  const analyzed: ValuePath[] = [];
  try {
    const profile = request.targetProfile();
    if (profile.id() !== 'xml.1.0-safe' || profile.version() !== 1) {
      return failed(new MaterializationFailure('UnsupportedProfile'), request, analyzed);
    }
    const style = request.style();
    if (style.id() !== 'xml.safe-canonical-document' || style.version() !== 1) {
      return failed(new MaterializationFailure('UnsupportedStyle'), request, analyzed);
    }
    const encoding = request.encoding();
    if (encoding.kind !== 'Utf8' && encoding.kind !== 'Utf16Le' && encoding.kind !== 'Utf16Be') {
      return failed(new MaterializationFailure('UnsupportedEncoding'), request, analyzed);
    }
    const newline = request.newline();
    if (newline !== 'Lf' && newline !== 'CrLf') {
      return failed(new MaterializationFailure('UnsupportedNewline'), request, analyzed);
    }
    const input = validateRecord(value, analyzed);
    if (input instanceof MaterializationFailure) {
      return failed(input, request, analyzed);
    }
    const writer = new Writer(request.limits());
    writer.emitDocument(input, request);
    const bytes = encodeText(writer.outputBytes(), encoding, request.limits().maxOutputBytes);
    if (bytes === null) {
      return failed(
        new MaterializationFailure('FormationFailed', { reason: 'encoding failed' }),
        request,
        analyzed,
      );
    }
    let document: XmlDocument;
    try {
      document = parse(bytes, 'SafeV1', { kind: 'ProfileDefault' }, parseLimitsFor(request.limits()));
    } catch {
      return failed(
        new MaterializationFailure('FormationFailed', { reason: 'reparse failed' }),
        request,
        analyzed,
      );
    }
    if (document.formationStatus() !== 'Complete') {
      return failed(
        new MaterializationFailure('FormationFailed', { reason: 'reparse not complete' }),
        request,
        analyzed,
      );
    }
    const provenance = verifyClosure(input, document, writer.items(), request.limits());
    if (provenance instanceof MaterializationFailure) {
      return failed(provenance, request, analyzed);
    }
    return {
      kind: 'Complete',
      value: new CompleteMaterialization(
        document,
        'Exact',
        new MaterializationReport([], request.limits()),
        provenance,
      ),
    };
  } catch (error) {
    if (error instanceof MaterializationFailure) {
      return failed(error, request, analyzed);
    }
    throw error;
  }
}

function failed(
  failure: MaterializationFailure,
  request: MaterializationRequest,
  analyzed: ValuePath[],
): MaterializationResult<XmlDocument> {
  return {
    kind: 'Failed',
    value: new FailedMaterializationAttempt(
      failure,
      new MaterializationReport([], request.limits()),
      analyzed,
    ),
  };
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

function utf8BytesOf(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function indexOfAny(text: string, needles: string[]): number {
  let first = -1;
  for (const needle of needles) {
    const at = text.indexOf(needle);
    if (at >= 0 && (first < 0 || at < first)) {
      first = at;
    }
  }
  return first;
}


