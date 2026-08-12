/**
 * Frozen YAML language profiles.
 *
 * authority: crates/consema-yaml/src/lib.rs
 *  - YamlProfile :54-61 (Yaml12CoreV1 | Yaml11CompatV1)
 *  - profile ids :241-257 (id() :244-249 — "yaml.1.2-core" / "yaml.1.1-compat",
 *    both version 1; accepted_version() :251-257 — "1.2" / "1.1")
 *  - the profile spellings are frozen by RFC 0007 §1 (:18-21)
 *
 * Design (TypeScript-idiomatic): a closed string-literal union; the
 * compiler proves closure on any exhaustive switch. The Rust variant
 * names are the discriminant values so the mapping stays one-to-one.
 */

import { ProfileId } from '../document/profile.ts';

/** Frozen YAML language profile (lib.rs:54-61). */
export type YamlProfile = 'Yaml12CoreV1' | 'Yaml11CompatV1';

/** `yaml.1.2-core@1` — YAML 1.2.2 presentation + Core schema (RFC 0007 §5). */
export const PROFILE_YAML12_CORE: YamlProfile = 'Yaml12CoreV1';
/** `yaml.1.1-compat@1` — YAML 1.2-compatible presentation + frozen 1.1 scalars (RFC 0007 §6). */
export const PROFILE_YAML11_COMPAT: YamlProfile = 'Yaml11CompatV1';

/** Immutable profile identifier (lib.rs:244-249). */
export function yamlProfileId(profile: YamlProfile): ProfileId {
  switch (profile) {
    case 'Yaml12CoreV1':
      return new ProfileId('yaml.1.2-core', 1);
    case 'Yaml11CompatV1':
      return new ProfileId('yaml.1.1-compat', 1);
  }
}

/** Accepted `%YAML` directive version for the profile (lib.rs:251-257). */
export function acceptedVersion(profile: YamlProfile): string {
  switch (profile) {
    case 'Yaml12CoreV1':
      return '1.2';
    case 'Yaml11CompatV1':
      return '1.1';
  }
}
