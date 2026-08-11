/**
 * Transferable dry-run facts for one fully validated edit transaction.
 *
 * authority:
 *  - RFC 0004 §14 (docs/rfcs/0004-materialization-conversion-and-
 *    structural-edit-v1.md:338-356): dry-run performs every deterministic
 *    validation and byte-planning step except publishing a new Document;
 *    the transferable plan carries schema, caller-stable source_id, base
 *    digest, profile, ordered operations with safe summaries, exact
 *    replacement facts, precomputed target digest, and an ordered report;
 *    a dry-run plan is not authority to write a file and is never applied
 *    without rechecking base digest and every original-byte precondition
 *  - Rust: crates/consema-document/src/edit_plan.rs —
 *    EditPlanSourceId :12-31 (non-empty, ≤ 1024 bytes), EditOperationSummary
 *    :33-70 (≤ 64 arguments; names lowercase/digit/underscore ≤ 64; values
 *    non-empty ≤ 1024; no raw edited values), EditPlan :72-197 (operation
 *    metadata keys "operation.{index}" must match the patch metadata
 *    exactly), EditPlanError :199-211, summary-name rule :221-227
 *
 * Design (TypeScript-idiomatic): immutable classes; the plan closes only
 * when its ordered operation metadata matches the exact SourcePatch
 * metadata, so a plan and its patch can never drift apart.
 */

import { EditPlanError } from './errors.ts';
import { ContentDigest } from './sha256.ts';
import { SourcePatch, SourceReplacement } from './source_patch.ts';
import { ProfileId } from './profile.ts';
import { FormatOperationId } from './operation.ts';
import type { Diagnostic } from './diagnostic.ts';

/** Caller-stable source identity used by a transferable edit plan (edit_plan.rs:12-31). */
export class EditPlanSourceId {
  readonly #value: string;

  /** Validates one non-empty bounded external source identity (edit_plan.rs:17-24). */
  constructor(value: string) {
    if (value.length === 0 || value.length > 1024) {
      throw new EditPlanError('InvalidSourceId');
    }
    this.#value = value;
  }

  /** Exact caller-stable source identity (edit_plan.rs:26-30). */
  asString(): string {
    return this.#value;
  }
}

/** One safe, content-free summary of a declared edit operation (edit_plan.rs:33-70). */
export class EditOperationSummary {
  readonly #operation: FormatOperationId;
  readonly #arguments: ReadonlyMap<string, string>;

  /** Validates a bounded summary that must not contain raw edited values (edit_plan.rs:41-57). */
  constructor(operation: FormatOperationId, arguments_: ReadonlyMap<string, string>) {
    if (
      arguments_.size > 64 ||
      [...arguments_.entries()].some(([name, value]) => {
        return !validSummaryName(name) || value.length === 0 || value.length > 1024;
      })
    ) {
      throw new EditPlanError('InvalidOperationSummary');
    }
    this.#operation = operation;
    this.#arguments = new Map(
      [...arguments_.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
  }

  /** Exact immutable operation ID/version (edit_plan.rs:59-63). */
  operation(): FormatOperationId {
    return this.#operation;
  }

  /** Stable sorted safe summary fields (edit_plan.rs:65-69). */
  arguments(): ReadonlyMap<string, string> {
    return this.#arguments;
  }
}

/**
 * Fully validated dry-run plan; possessing it does not authorize a write
 * (edit_plan.rs:72-197; RFC 0004 §14).
 */
export class EditPlan {
  readonly #sourceId: EditPlanSourceId;
  readonly #profile: ProfileId;
  readonly #operations: readonly EditOperationSummary[];
  readonly #patch: SourcePatch;
  readonly #report: readonly Diagnostic[];

  /** Closes a plan only when its ordered operation metadata matches its exact patch (edit_plan.rs:82-121). */
  constructor(
    sourceId: EditPlanSourceId,
    profile: ProfileId,
    operations: readonly EditOperationSummary[],
    patch: SourcePatch,
    report: readonly Diagnostic[],
  ) {
    for (let index = 0; index < operations.length; index++) {
      const key = `operation.${index}`;
      if (patch.metadata().get(key) !== operations[index].operation().toString()) {
        throw new EditPlanError('OperationMetadataMismatch', index);
      }
    }
    const operationKeys = [...patch.metadata().keys()].filter((key) => key.startsWith('operation.'));
    if (operationKeys.length > 0 && operationKeys.length !== operations.length) {
      throw new EditPlanError('OperationMetadataMismatch', operations.length);
    }
    this.#sourceId = sourceId;
    this.#profile = profile;
    this.#operations = Object.freeze([...operations]);
    this.#patch = patch;
    this.#report = Object.freeze([...report]);
  }

  /** Caller-stable source identity (edit_plan.rs:122-127). */
  sourceId(): EditPlanSourceId {
    return this.#sourceId;
  }

  /** Required base content identity (edit_plan.rs:129-133). */
  baseDigest(): ContentDigest {
    return this.#patch.baseDigest();
  }

  /** Exact profile under which the target was validated (edit_plan.rs:135-139). */
  profile(): ProfileId {
    return this.#profile;
  }

  /** Ordered declared operations with content-free summaries (edit_plan.rs:141-145). */
  operations(): readonly EditOperationSummary[] {
    return this.#operations;
  }

  /** Exact replacement facts, including review redaction flags (edit_plan.rs:147-151). */
  replacements(): readonly SourceReplacement[] {
    return this.#patch.replacements();
  }

  /** Precomputed exact target content identity (edit_plan.rs:153-157). */
  targetDigest(): ContentDigest {
    return this.#patch.targetDigest();
  }

  /** Complete ordered edit report (edit_plan.rs:159-163). */
  report(): readonly Diagnostic[] {
    return this.#report;
  }

  /** Underlying patch whose application rechecks digest and every original-byte precondition (edit_plan.rs:165-169). */
  sourcePatch(): SourcePatch {
    return this.#patch;
  }

  /** Redacts every original/replacement payload from review/debug presentation (edit_plan.rs:171-183). */
  withAllReplacementsRedacted(redactOriginal: boolean, redactReplacement: boolean): EditPlan {
    return new EditPlan(
      this.#sourceId,
      this.#profile,
      this.#operations,
      this.#patch.withAllReplacementsRedacted(redactOriginal, redactReplacement),
      this.#report,
    );
  }

  /** Redacts one exact replacement from review/debug presentation (edit_plan.rs:185-196). */
  withReplacementRedacted(
    index: number,
    redactOriginal: boolean,
    redactReplacement: boolean,
  ): EditPlan {
    return new EditPlan(
      this.#sourceId,
      this.#profile,
      this.#operations,
      this.#patch.withReplacementRedacted(index, redactOriginal, redactReplacement),
      this.#report,
    );
  }
}

/** Summary argument-name rule: lowercase/digit/underscore, ≤ 64 bytes (edit_plan.rs:221-227). */
function validSummaryName(name: string): boolean {
  if (name.length === 0 || name.length > 64) {
    return false;
  }
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    const isLower = code >= 0x61 && code <= 0x7a;
    const isDigit = code >= 0x30 && code <= 0x39;
    const isUnderscore = code === 0x5f;
    if (!isLower && !isDigit && !isUnderscore) {
      return false;
    }
  }
  return true;
}
