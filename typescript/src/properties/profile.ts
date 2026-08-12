/**
 * Frozen Java Properties language profiles.
 *
 * authority: RFC 0010 (docs/rfcs/0010-java-properties-profiles-v1.md)
 *  - §1 the two profiles (:14-35): `java-properties.reader@1` and
 *    `java-properties.latin1@1`; the profile is always selected by the
 *    caller and a `.properties` extension never chooses between them
 *  - crates/consema-properties/src/lib.rs:33-50 (PropertiesProfile :
 *    34-39, profile ids :44-49)
 *  - the Reader profile corresponds to `Properties.load(Reader)`; Latin-1
 *    corresponds to `Properties.load(InputStream)` (RFC 0010 §1 :24-27)
 *
 * Design (TypeScript-idiomatic): a closed string-literal union; the
 * compiler proves closure on any exhaustive switch. The Rust variant
 * names are the discriminant values so the mapping stays one-to-one.
 */

import { ProfileId } from '../document/profile.ts';

/** Frozen Java Properties language profile (lib.rs:34-39). */
export type PropertiesProfile = 'ReaderV1' | 'Latin1V1';

/** `java-properties.reader@1` — explicitly decoded character source (lib.rs:46). */
export const PROFILE_READER_V1: PropertiesProfile = 'ReaderV1';
/** `java-properties.latin1@1` — ISO-8859-1 byte semantics (lib.rs:47). */
export const PROFILE_LATIN1_V1: PropertiesProfile = 'Latin1V1';

/** Immutable profile identifier (lib.rs:44-49; RFC 0010 §1). */
export function propertiesProfileId(profile: PropertiesProfile): ProfileId {
  switch (profile) {
    case 'ReaderV1':
      return new ProfileId('java-properties.reader', 1);
    case 'Latin1V1':
      return new ProfileId('java-properties.latin1', 1);
  }
}
