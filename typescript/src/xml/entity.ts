/**
 * Safe internal DTD/entity boundary (RFC 0012 §3).
 *
 * authority: crates/consema-xml/src/entity.rs
 *  - PredefinedEntity :9-16, PREDEFINED_ENTITIES :18-40 (the five
 *    predefined entities with their XML meanings :115-119 in RFC 0012),
 *    predefined_value :42-49
 *  - is_xml_char :51-59 (XML 1.0 legal character ranges)
 *  - ReplacementError :61-72, validate_replacement_text :74-89 (never `<`;
 *    only legal XML characters)
 *  - ExpansionBreach :91-106, EntityExpansionLimits :108-123,
 *    EntityExpansionState :125-208 (document-wide accounting:
 *    record_declaration :155-168, enter_reference :171-197 — depth,
 *    reference, byte/scalar budgets and the amplification bound,
 *    leave_reference :199-202, amplification_bound :204-208)
 *
 * Design (TypeScript-idiomatic): the expansion state is one mutable
 * accounting object owned by the parser, so counters apply across the
 * whole document and an attack cannot split its budget across references
 * (RFC 0012 §3 :129-131).
 */

/** One predefined XML entity (entity.rs:9-16). */
export interface PredefinedEntity {
  /** Entity name without the `&` and `;`. */
  readonly name: string;
  /** Replacement character data. */
  readonly value: string;
}

/** The five predefined entities, always available with their XML meanings (entity.rs:18-40). */
export const PREDEFINED_ENTITIES: readonly PredefinedEntity[] = Object.freeze([
  { name: 'lt', value: '<' },
  { name: 'gt', value: '>' },
  { name: 'amp', value: '&' },
  { name: 'apos', value: "'" },
  { name: 'quot', value: '"' },
]);

/** Returns the replacement value of a predefined entity by exact name (entity.rs:42-49). */
export function predefinedValue(name: string): string | null {
  for (const entity of PREDEFINED_ENTITIES) {
    if (entity.name === name) {
      return entity.value;
    }
  }
  return null;
}

/** Returns whether `c` is a legal XML 1.0 character (entity.rs:51-59). */
export function isXmlChar(character: string): boolean {
  const code = character.codePointAt(0)!;
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/** Replacement-text validation failure (entity.rs:61-72). */
export type ReplacementError =
  | { readonly kind: 'ContainsMarkup' }
  | { readonly kind: 'IllegalCharacter'; readonly scalar: number };

/**
 * Validates one internal general entity value (entity.rs:74-89).
 *
 * An admitted value may contain character data, character references,
 * predefined entity references, or references to another admitted internal
 * general entity, but never `<`.
 */
export function validateReplacementText(text: string): ReplacementError | null {
  if (text.includes('<')) {
    return { kind: 'ContainsMarkup' };
  }
  for (const character of text) {
    if (!isXmlChar(character)) {
      return { kind: 'IllegalCharacter', scalar: character.codePointAt(0)! };
    }
  }
  return null;
}

/** Entity expansion breach category (entity.rs:91-106). */
export type ExpansionBreach =
  | 'DeclarationLimit'
  | 'ReferenceLimit'
  | 'DepthLimit'
  | 'ExpandedBytes'
  | 'ExpandedScalars'
  | 'Amplification';

/** Entity expansion limits derived from the parse limits (entity.rs:108-123). */
export interface EntityExpansionLimits {
  /** Maximum entity declarations. */
  readonly maxDeclarations: number;
  /** Maximum entity references. */
  readonly maxReferences: number;
  /** Maximum reference expansion depth. */
  readonly maxExpansionDepth: number;
  /** Maximum expanded bytes across the whole document. */
  readonly maxExpandedBytes: number;
  /** Maximum expanded scalars across the whole document. */
  readonly maxExpandedScalars: number;
  /** Maximum expanded/declared byte amplification ratio. */
  readonly maxAmplificationRatio: number;
}

/**
 * Document-wide entity expansion accounting (entity.rs:125-145).
 *
 * Counters apply across the whole document, not independently per
 * reference, so an attack cannot split its budget across references.
 */
export class EntityExpansionState {
  #declarations = 0;
  #references = 0;
  #declaredBytes = 0;
  #declaredScalars = 0;
  #expandedBytes = 0;
  #expandedScalars = 0;
  #expansionDepth = 0;

  /** Creates an empty accounting state (entity.rs:147-153). */
  static new(): EntityExpansionState {
    return new EntityExpansionState();
  }

  /** Records one collected declaration with its replacement text size (entity.rs:155-168). */
  recordDeclaration(
    replacementBytes: number,
    replacementScalars: number,
    limits: EntityExpansionLimits,
  ): ExpansionBreach | null {
    if (this.#declarations >= limits.maxDeclarations) {
      return 'DeclarationLimit';
    }
    this.#declarations += 1;
    this.#declaredBytes += replacementBytes;
    this.#declaredScalars += replacementScalars;
    return null;
  }

  /** Enters one reference expansion and accounts its resolved size (entity.rs:171-197). */
  enterReference(
    expandedBytes: number,
    expandedScalars: number,
    limits: EntityExpansionLimits,
  ): ExpansionBreach | null {
    if (this.#references >= limits.maxReferences) {
      return 'ReferenceLimit';
    }
    if (this.#expansionDepth >= limits.maxExpansionDepth) {
      return 'DepthLimit';
    }
    this.#references += 1;
    this.#expansionDepth += 1;
    this.#expandedBytes += expandedBytes;
    this.#expandedScalars += expandedScalars;
    if (this.#expandedBytes > limits.maxExpandedBytes) {
      return 'ExpandedBytes';
    }
    if (this.#expandedScalars > limits.maxExpandedScalars) {
      return 'ExpandedScalars';
    }
    if (this.#expandedBytes > this.#amplificationBound(limits)) {
      return 'Amplification';
    }
    return null;
  }

  /** Leaves one completed reference expansion (entity.rs:199-202). */
  leaveReference(): void {
    this.#expansionDepth = Math.max(0, this.#expansionDepth - 1);
  }

  #amplificationBound(limits: EntityExpansionLimits): number {
    const bound = this.#declaredBytes * limits.maxAmplificationRatio;
    return Number.isSafeInteger(bound) ? bound : Number.MAX_SAFE_INTEGER;
  }
}
