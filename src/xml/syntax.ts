/**
 * Closed XML v1 lossless syntax-piece classification.
 *
 * authority: crates/consema-xml/src/document.rs
 *  - XmlSyntaxKind :17-94 (the forty-one kinds)
 *  - stable query and protocol names :801-889 (as_str :804-844,
 *    from_name :848-889)
 *
 * Design (TypeScript-idiomatic): a closed string-literal union whose
 * spellings ARE the stable protocol names (RFC 0016 §8 F15: the lossless
 * syntax-query match roles reproduce the Rust spellings byte-for-byte).
 * The vector arguments to `xml.syntax-kind-is` use these exact spellings
 * (conformance/vectors/xml-1-0-safe-v1.json: "local-name" :183,
 * "entity-reference" :213, "attribute-value" :235) and the query
 * definition validator pins the same vocabulary
 * (typescript/src/protocol/query.ts:1192-1235).
 */

/** Closed XML v1 lossless syntax-piece classification (document.rs:17-94). */
export type XmlSyntaxKind =
  /** Unicode byte-order mark. */
  | 'bom'
  /** Horizontal whitespace. */
  | 'whitespace'
  /** Line break. */
  | 'line-break'
  /** `<?xml` declaration opening. */
  | 'declaration-open'
  /** Declaration pseudo-attribute name. */
  | 'declaration-name'
  /** Declaration pseudo-attribute value. */
  | 'declaration-value'
  /** `?>` declaration closing. */
  | 'declaration-close'
  /** `<!DOCTYPE` opening. */
  | 'doctype-open'
  /** DOCTYPE name. */
  | 'doctype-name'
  /** Admitted internal DTD subset markup. */
  | 'dtd-markup'
  /** `>` DOCTYPE closing. */
  | 'doctype-close'
  /** `<` or `</` tag opening. */
  | 'tag-open'
  /** `>` tag closing. */
  | 'tag-close'
  /** `/>` empty-element closing. */
  | 'empty-element-close'
  /** `</` end-tag opening. */
  | 'end-tag-open'
  /** QName prefix spelling. */
  | 'prefix'
  /** QName local-name spelling. */
  | 'local-name'
  /** QName colon. */
  | 'colon'
  /** Attribute name. */
  | 'attribute-name'
  /** `=` assignment. */
  | 'equals'
  /** Attribute value quote. */
  | 'quote'
  /** Attribute value content. */
  | 'attribute-value'
  /** `xmlns` or `xmlns:p` declaration. */
  | 'namespace-declaration'
  /** Character data without markup. */
  | 'text'
  /** General or predefined entity reference. */
  | 'entity-reference'
  /** Decimal or hexadecimal character reference. */
  | 'character-reference'
  /** `<![CDATA[` opening. */
  | 'cdata-open'
  /** CDATA content. */
  | 'cdata-text'
  /** `]]>` CDATA closing. */
  | 'cdata-close'
  /** `<!--` comment opening. */
  | 'comment-open'
  /** Comment content. */
  | 'comment-text'
  /** `-->` comment closing. */
  | 'comment-close'
  /** `<?` PI opening. */
  | 'processing-instruction-open'
  /** PI target. */
  | 'processing-instruction-target'
  /** PI content. */
  | 'processing-instruction-content'
  /** `?>` PI closing. */
  | 'processing-instruction-close'
  /** Recovered error region. */
  | 'error-region';

/** Resolves one exact stable kind name (document.rs:848-889). */
export function xmlSyntaxKindFromName(name: string): XmlSyntaxKind | null {
  switch (name) {
    case 'bom':
    case 'whitespace':
    case 'line-break':
    case 'declaration-open':
    case 'declaration-name':
    case 'declaration-value':
    case 'declaration-close':
    case 'doctype-open':
    case 'doctype-name':
    case 'dtd-markup':
    case 'doctype-close':
    case 'tag-open':
    case 'tag-close':
    case 'empty-element-close':
    case 'end-tag-open':
    case 'prefix':
    case 'local-name':
    case 'colon':
    case 'attribute-name':
    case 'equals':
    case 'quote':
    case 'attribute-value':
    case 'namespace-declaration':
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
