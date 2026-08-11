/**
 * Namespace-aware expanded names and immutable binding scope (RFC 0012 §5).
 *
 * authority: crates/consema-xml/src/namespace.rs
 *  - XML_NAMESPACE_URI :10, XMLNS_NAMESPACE_URI :13
 *  - QName :15-39, ExpandedName :41-57, Binding :59-66
 *  - NamespaceError :68-89 (UnboundPrefix | ReservedPrefix |
 *    IllegalXmlRebinding | IllegalDefaultXmlns)
 *  - NamespaceScope :91-219 (declare :122-144 — xmlns never declared,
 *    xml only to its standard URI, xmlns URI never the default;
 *    resolve_element :147-155 — default namespace applies;
 *    resolve_attribute :158-166 — default namespace never applies;
 *    declaration_expanded_name :173-179 — { xmlns-URI, "xmlns"|prefix };
 *    resolution :181-218 — most-recent binding first, `xml` permanently
 *    bound, `xmlns` reserved)
 *
 * Design (TypeScript-idiomatic): the scope is an immutable linked chain —
 * `declare` returns a NEW scope with the binding appended, so the
 * ancestry-derived chain of a tree stays immutable exactly like the Rust
 * struct (namespace.rs:91-99). Prefix spelling is source representation;
 * expanded-name equality never consults prefixes.
 */

/** Standard URI permanently bound to the `xml` prefix (namespace.rs:10). */
export const XML_NAMESPACE_URI = 'http://www.w3.org/XML/1998/namespace';

/** URI of the reserved `xmlns` prefix (namespace.rs:13). */
export const XMLNS_NAMESPACE_URI = 'http://www.w3.org/2000/xmlns/';

/** One lexical QName with its source-derived parts (namespace.rs:15-23). */
export interface QName {
  /** Prefix spelling before the colon, when present. */
  readonly prefix: string | null;
  /** Local name after the colon, or the whole name when unprefixed. */
  readonly local: string;
}

/** Full lexical spelling `prefix:local` or `local` (namespace.rs:31-39). */
export function qnameAsStr(name: QName): string {
  return name.prefix === null ? name.local : `${name.prefix}:${name.local}`;
}

/** Resolved expanded name = `{ namespace URI or none, local name }` (namespace.rs:41-49). */
export interface ExpandedName {
  /** Namespace URI, or `None` for an unprefixed attribute or an unbound default namespace. */
  readonly namespace: string | null;
  /** Local name. */
  readonly local: string;
}

/** One in-scope namespace binding (namespace.rs:59-66). */
export interface Binding {
  /** Bound prefix; `null` is the default namespace. */
  readonly prefix: string | null;
  /** Namespace URI. */
  readonly uri: string;
}

/** Namespace resolution failure (namespace.rs:68-89). */
export type NamespaceError =
  | { readonly kind: 'UnboundPrefix'; readonly prefix: string }
  | { readonly kind: 'ReservedPrefix'; readonly prefix: string }
  | { readonly kind: 'IllegalXmlRebinding'; readonly uri: string }
  | { readonly kind: 'IllegalDefaultXmlns' };

/** Stable diagnostic code of one namespace error (parser.rs:130-137). */
export function namespaceErrorCode(error: NamespaceError): string {
  switch (error.kind) {
    case 'UnboundPrefix':
      return 'xml.namespace.unbound-prefix@1';
    case 'ReservedPrefix':
      return 'xml.namespace.reserved-prefix@1';
    case 'IllegalXmlRebinding':
      return 'xml.namespace.xml-rebinding@1';
    case 'IllegalDefaultXmlns':
      return 'xml.namespace.default-xmlns@1';
  }
}

/**
 * Immutable, ancestry-derived namespace scope (namespace.rs:91-99).
 *
 * A scope is never mutated in place. Declaring a binding appends to a new
 * child scope, so the immutable ancestry chain of a tree is preserved.
 * `bindings` holds the most-recent binding last; resolution scans in
 * reverse declaration order.
 */
export class NamespaceScope {
  readonly #bindings: readonly Binding[];

  /** Creates an empty scope holding only the permanent `xml` binding rule (namespace.rs:102-108). */
  constructor(bindings: readonly Binding[] = []) {
    this.#bindings = Object.freeze([...bindings]);
  }

  /** Creates an empty scope (namespace.rs:102-108). */
  static empty(): NamespaceScope {
    return new NamespaceScope();
  }

  /** All in-scope bindings in declaration order; a `null` prefix is the default namespace (namespace.rs:110-115). */
  bindings(): readonly Binding[] {
    return this.#bindings;
  }

  /**
   * Appends one namespace declaration and returns the child scope
   * (namespace.rs:122-144).
   *
   * The `xmlns` prefix can never be declared, the `xml` prefix can only be
   * declared to its standard URI, and the `xmlns` URI cannot become the
   * default namespace.
   */
  declare(prefix: string | null, uri: string): NamespaceScope | NamespaceError {
    if (uri === XMLNS_NAMESPACE_URI && prefix === null) {
      return { kind: 'IllegalDefaultXmlns' };
    }
    if (prefix !== null) {
      if (prefix === 'xmlns') {
        return { kind: 'ReservedPrefix', prefix };
      }
      if (prefix === 'xml' && uri !== XML_NAMESPACE_URI) {
        return { kind: 'IllegalXmlRebinding', uri };
      }
    }
    return new NamespaceScope([...this.#bindings, { prefix, uri }]);
  }

  /** Resolves an element name: the default namespace applies (namespace.rs:147-155). */
  resolveElement(name: QName): { kind: 'Resolved'; expanded: ExpandedName } | { kind: 'Error'; error: NamespaceError } {
    if (name.prefix === null) {
      return { kind: 'Resolved', expanded: { namespace: this.#lookupDefault(), local: name.local } };
    }
    return this.#resolvePrefixed(name, name.prefix);
  }

  /** Resolves an attribute name: the default namespace never applies (namespace.rs:158-166). */
  resolveAttribute(name: QName): { kind: 'Resolved'; expanded: ExpandedName } | { kind: 'Error'; error: NamespaceError } {
    if (name.prefix === null) {
      return { kind: 'Resolved', expanded: { namespace: null, local: name.local } };
    }
    return this.#resolvePrefixed(name, name.prefix);
  }

  /**
   * Expanded name of a namespace declaration attribute itself
   * (namespace.rs:173-179).
   *
   * `xmlns` is `{ xmlns-URI, "xmlns" }` and `xmlns:p` is
   * `{ xmlns-URI, "p" }`, used for attribute-uniqueness checks.
   */
  static declarationExpandedName(prefix: string | null): ExpandedName {
    return { namespace: XMLNS_NAMESPACE_URI, local: prefix ?? 'xmlns' };
  }

  #lookupDefault(): string | null {
    for (let index = this.#bindings.length - 1; index >= 0; index--) {
      const binding = this.#bindings[index];
      if (binding.prefix === null) {
        return binding.uri;
      }
    }
    return null;
  }

  #resolvePrefixed(
    name: QName,
    prefix: string,
  ): { kind: 'Resolved'; expanded: ExpandedName } | { kind: 'Error'; error: NamespaceError } {
    if (prefix === 'xml') {
      return { kind: 'Resolved', expanded: { namespace: XML_NAMESPACE_URI, local: name.local } };
    }
    if (prefix === 'xmlns') {
      return { kind: 'Error', error: { kind: 'ReservedPrefix', prefix } };
    }
    for (let index = this.#bindings.length - 1; index >= 0; index--) {
      const binding = this.#bindings[index];
      if (binding.prefix === prefix) {
        return { kind: 'Resolved', expanded: { namespace: binding.uri, local: name.local } };
      }
    }
    return { kind: 'Error', error: { kind: 'UnboundPrefix', prefix } };
  }
}
