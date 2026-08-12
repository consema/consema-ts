/**
 * ProtocolLimits: the resource limits shared by the canonical JSON and
 * PVCE/1 protocol transports.
 *
 * authority: crates/consema-protocol/src/limits.rs:5-31 (defaults 64 MiB
 * transport bytes, depth 256, 1,000,000 nodes, 1,000,000 container entries,
 * 64 MiB blob, 1024 integer magnitude bytes).
 */

/** Resource limits for the protocol transports (Rust ProtocolLimits). */
export interface ProtocolLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxContainerEntries: number;
  readonly maxBlobBytes: number;
  readonly maxIntegerBytes: number;
}

/** The frozen defaults (crates/consema-protocol/src/limits.rs:20-31). */
export function defaultProtocolLimits(): ProtocolLimits {
  return {
    maxBytes: 64 << 20,
    maxDepth: 256,
    maxNodes: 1_000_000,
    maxContainerEntries: 1_000_000,
    maxBlobBytes: 64 << 20,
    maxIntegerBytes: 1024,
  };
}
