/**
 * Shared registry types: contract stability and registry versions.
 *
 * authority: the stability spellings and version sequence of
 * crates/consema-protocol/src/contract.rs (the v1-v7 registries with
 * 16/18/25/25/30/38/41 contracts; the 0.3-0.12 semantic models).
 */

/** Compatibility status of one frozen contract. */
export type ContractStability = 'Stable' | 'Transport';

/** The closed stability spellings. */
export const CONTRACT_STABILITY = ['Stable', 'Transport'] as const;

/** Parses one canonical stability spelling. */
export function parseContractStability(name: string): ContractStability {
  switch (name) {
    case 'Stable':
      return 'Stable';
    case 'Transport':
      return 'Transport';
    default:
      throw new Error(`unknown contract stability: ${name}`);
  }
}

/** Selects one frozen semantic-model contract registry (v1..v7). */
export type ContractRegistryVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** The semantic-model version numbers in order. */
export const REGISTRY_VERSIONS: readonly ContractRegistryVersion[] = [1, 2, 3, 4, 5, 6, 7];
