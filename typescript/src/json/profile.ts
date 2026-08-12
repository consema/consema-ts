/**
 * Frozen JSON language profiles.
 *
 * authority: crates/consema-json/src/lib.rs
 *  - JsonProfile :37-45 (StrictV1 | JsoncBoundedV1 | Json5StandardV1)
 *  - profile ids :140-146 ("json.strict@1", "jsonc.bounded@1",
 *    "json5.standard@1")
 *  - permits_jsonc_extensions :150-152 (JSONC and JSON5 accept bounded
 *    comments and trailing commas)
 *  - is_json5 :155-159
 *  - the profile spellings are frozen by RFC 0005 §1 (:17-20)
 *
 * Design (TypeScript-idiomatic): a closed string-literal union; the
 * compiler proves closure on any exhaustive switch. The Rust variant
 * names are the discriminant values so the mapping stays one-to-one.
 */

import { ProfileId } from '../document/profile.ts';

/** Frozen JSON language profile (lib.rs:37-45). */
export type JsonProfile = 'JsonStrict' | 'JsoncBounded' | 'Json5Standard';

/** `json.strict@1` — RFC-style strict JSON baseline (lib.rs:141-142). */
export const PROFILE_JSON_STRICT: JsonProfile = 'JsonStrict';
/** `jsonc.bounded@1` — strict JSON plus comments/trailing commas (lib.rs:143-144). */
export const PROFILE_JSONC_BOUNDED: JsonProfile = 'JsoncBounded';
/** `json5.standard@1` — Standard JSON5 1.0.0 lexical surface (lib.rs:145-146). */
export const PROFILE_JSON5_STANDARD: JsonProfile = 'Json5Standard';

/** Immutable profile identifier (lib.rs:140-146). */
export function jsonProfileId(profile: JsonProfile): ProfileId {
  switch (profile) {
    case 'JsonStrict':
      return new ProfileId('json.strict', 1);
    case 'JsoncBounded':
      return new ProfileId('jsonc.bounded', 1);
    case 'Json5Standard':
      return new ProfileId('json5.standard', 1);
  }
}

/** Whether bounded comments and trailing commas are accepted (lib.rs:150-152). */
export function permitsJsoncExtensions(profile: JsonProfile): boolean {
  return profile === 'JsoncBounded' || profile === 'Json5Standard';
}

/** Whether the Standard JSON5 lexical surface is accepted (lib.rs:155-159). */
export function isJson5(profile: JsonProfile): boolean {
  return profile === 'Json5Standard';
}
