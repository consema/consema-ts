/**
 * Lossless plist XML syntax kinds (RFC 0013 §8.2).
 *
 * authority: crates/consema-plist/src/parser_xml.rs:71-280
 *  - the closed kind set :77-171 and its stable protocol names :174-225
 *    (as_str) — do not guess spellings
 *  - RFC 0013 §8.2 (:561-582) freezes the vocabulary; the root open tag
 *    partitions as PlistOpen on the name, Whitespace on the separator,
 *    PlistVersionName on `version`, PlistVersionValue on `="1.0"`, and a
 *    second PlistOpen on the closing `>`
 *
 * Design (TypeScript-idiomatic): a closed string-literal union whose
 * member spellings ARE the stable protocol names (kebab-case), so the
 * name-to-kind mapping is the union itself; an exhaustive switch on a
 * kind is compiler-checked.
 */

/** One closed plist XML lossless syntax kind (parser_xml.rs:77-171). */
export type PlistSyntaxKind =
  | 'bom'
  | 'whitespace'
  | 'line-break'
  | 'declaration-open'
  | 'declaration-name'
  | 'declaration-value'
  | 'declaration-close'
  | 'doctype-open'
  | 'doctype-body'
  | 'doctype-close'
  | 'plist-open'
  | 'plist-version-name'
  | 'plist-version-value'
  | 'plist-close'
  | 'dict-open'
  | 'dict-close'
  | 'key-open'
  | 'key-close'
  | 'array-open'
  | 'array-close'
  | 'string-open'
  | 'string-close'
  | 'integer-open'
  | 'integer-close'
  | 'real-open'
  | 'real-close'
  | 'date-open'
  | 'date-close'
  | 'data-open'
  | 'data-close'
  | 'true'
  | 'false'
  | 'text'
  | 'entity-reference'
  | 'character-reference'
  | 'cdata-open'
  | 'cdata-text'
  | 'cdata-close'
  | 'comment-open'
  | 'comment-text'
  | 'comment-close'
  | 'processing-instruction-open'
  | 'processing-instruction-target'
  | 'processing-instruction-content'
  | 'processing-instruction-close'
  | 'error-region';

/** Resolves one stable kind name; `null` for unknown names (parser_xml.rs:229-279). */
export function plistSyntaxKindFromName(name: string): PlistSyntaxKind | null {
  switch (name) {
    case 'bom':
    case 'whitespace':
    case 'line-break':
    case 'declaration-open':
    case 'declaration-name':
    case 'declaration-value':
    case 'declaration-close':
    case 'doctype-open':
    case 'doctype-body':
    case 'doctype-close':
    case 'plist-open':
    case 'plist-version-name':
    case 'plist-version-value':
    case 'plist-close':
    case 'dict-open':
    case 'dict-close':
    case 'key-open':
    case 'key-close':
    case 'array-open':
    case 'array-close':
    case 'string-open':
    case 'string-close':
    case 'integer-open':
    case 'integer-close':
    case 'real-open':
    case 'real-close':
    case 'date-open':
    case 'date-close':
    case 'data-open':
    case 'data-close':
    case 'true':
    case 'false':
    case 'text':
    case 'entity-reference':
    case 'character-reference':
    case 'cdata-open':
    case 'cdata-text':
    case 'cdata-close':
    case 'comment-open':
    case 'comment-text':
    case 'comment-close':
    case 'processing-instruction-open':
    case 'processing-instruction-target':
    case 'processing-instruction-content':
    case 'processing-instruction-close':
    case 'error-region':
      return name;
    default:
      return null;
  }
}

/**
 * Open-tag kind of one value element (parser_xml.rs:534-548). `true` and
 * `false` share one kind for open, close, and self-closing spellings.
 */
export function plistOpenKind(element: PlistElementKind): PlistSyntaxKind {
  switch (element) {
    case 'Plist':
      return 'plist-open';
    case 'Dict':
      return 'dict-open';
    case 'Array':
      return 'array-open';
    case 'String':
      return 'string-open';
    case 'Key':
      return 'key-open';
    case 'Integer':
      return 'integer-open';
    case 'Real':
      return 'real-open';
    case 'True':
      return 'true';
    case 'False':
      return 'false';
    case 'Data':
      return 'data-open';
    case 'Date':
      return 'date-open';
  }
}

/** Close-tag kind of one value element (parser_xml.rs:550-564). */
export function plistCloseKind(element: PlistElementKind): PlistSyntaxKind {
  switch (element) {
    case 'Plist':
      return 'plist-close';
    case 'Dict':
      return 'dict-close';
    case 'Array':
      return 'array-close';
    case 'String':
      return 'string-close';
    case 'Key':
      return 'key-close';
    case 'Integer':
      return 'integer-close';
    case 'Real':
      return 'real-close';
    case 'True':
      return 'true';
    case 'False':
      return 'false';
    case 'Data':
      return 'data-close';
    case 'Date':
      return 'date-close';
  }
}

/** The plist element vocabulary (parser_xml.rs:503-517). */
export type PlistElementKind =
  | 'Plist'
  | 'Dict'
  | 'Array'
  | 'String'
  | 'Key'
  | 'Integer'
  | 'Real'
  | 'True'
  | 'False'
  | 'Data'
  | 'Date';

/** Classifies an unqualified element name; `null` is unknown or prefixed (parser_xml.rs:568-586). */
export function classifyPlistElement(prefix: string, local: string): PlistElementKind | null {
  if (prefix.length > 0) {
    return null;
  }
  switch (local) {
    case 'plist':
      return 'Plist';
    case 'dict':
      return 'Dict';
    case 'array':
      return 'Array';
    case 'string':
      return 'String';
    case 'key':
      return 'Key';
    case 'integer':
      return 'Integer';
    case 'real':
      return 'Real';
    case 'true':
      return 'True';
    case 'false':
      return 'False';
    case 'data':
      return 'Data';
    case 'date':
      return 'Date';
    default:
      return null;
  }
}

/** Whether the element is a scalar value element (parser_xml.rs:519-532). */
export function plistElementIsScalar(element: PlistElementKind): boolean {
  switch (element) {
    case 'String':
    case 'Key':
    case 'Integer':
    case 'Real':
    case 'True':
    case 'False':
    case 'Data':
    case 'Date':
      return true;
    default:
      return false;
  }
}
