/**
 * Intent documents for SourcePatch, transcribing every `source.patch.*`
 * vector case (conformance/vectors/source-v1.json:120-172) plus the
 * document-level derivation path (RFC 0004 §16, source_patch.rs:143-205)
 * and redaction semantics.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SourcePatch, type SourcePatchLimits, SourceReplacement } from './source_patch.ts';
import { DEFAULT_SOURCE_PATCH_LIMITS } from './source_patch.ts';
import { EncodingRequest, latin1Encoding, SourceSnapshot, utf8Encoding } from './source.ts';
import { DEFAULT_SOURCE_LIMITS } from './source.ts';
import { ContentDigest } from './sha256.ts';
import {
  codeProtocolInvalidValue,
  codeSourceEncodingConflict,
  codeSourcePatchBaseMismatch,
  codeSourcePatchOriginalMismatch,
  codeSourcePatchTargetMismatch,
  codeSourceResourceLimit,
  SourcePatchError,
  SourcePatchRedactionError,
} from './errors.ts';
import { ChangeSet, SourceEdit } from './change_set.ts';
import { DocumentAuthority } from './identity.ts';
import { decodeHex, encodeHex } from './hex.ts';

const DEFAULT_LIMITS: SourcePatchLimits = DEFAULT_SOURCE_PATCH_LIMITS;

function utf8(bytesHex: string): SourceSnapshot {
  return SourceSnapshot.fromRaw(decodeHex(bytesHex), EncodingRequest.create(utf8Encoding()), DEFAULT_SOURCE_LIMITS);
}

/** The conformance runner's metadata ("actor" -> "conformance", source_v1.rs:384-386). */
function conformanceMetadata(): ReadonlyMap<string, string> {
  return new Map([['actor', 'conformance']]);
}

// ---------------------------------------------------------------------------
// Round trip — vector case source.patch.success (source-v1.json:120-124):
// base "name = old\n"; insert "# " at 0; replace "old" (7..10) with "new".
// ---------------------------------------------------------------------------

test('source.patch.success: create then apply reproduces the exact target bytes', () => {
  const base = utf8('6e616d65203d206f6c640a'); // "name = old\n"
  const replacements = [
    new SourceReplacement(0, 0, new Uint8Array(0), decodeHex('2320')), // "# "
    new SourceReplacement(7, 10, decodeHex('6f6c64'), decodeHex('6e6577')), // "old" -> "new"
  ];
  const patch = SourcePatch.create(base, replacements, conformanceMetadata(), DEFAULT_LIMITS);
  const target = patch.apply(base, DEFAULT_LIMITS);
  assert.equal(encodeHex(target.bytes()), '23206e616d65203d206e65770a'); // "# name = new\n"
  assert.equal(target.digest().toHex(), patch.targetDigest().toHex());
  assert.equal(patch.metadata().get('actor'), 'conformance');
  // Application is deterministic and repeatable.
  const second = patch.apply(base, DEFAULT_LIMITS);
  assert.equal(encodeHex(second.bytes()), encodeHex(target.bytes()));
});

test('source.patch.reject-stale-base: applying to a different digest fails atomically', () => {
  const base = utf8('616263'); // "abc"
  const patch = SourcePatch.create(
    base,
    [new SourceReplacement(1, 2, decodeHex('62'), decodeHex('42'))],
    conformanceMetadata(),
    DEFAULT_LIMITS,
  );
  const stale = utf8('616264'); // "abd" — vector input stale_hex
  assert.throws(
    () => patch.apply(stale, DEFAULT_LIMITS),
    (error: unknown) => {
      assert.ok(error instanceof SourcePatchError);
      assert.equal(error.kind, 'BaseMismatch');
      assert.equal(error.code, codeSourcePatchBaseMismatch);
      return true;
    },
  );
});

test('source.patch.reject-original-mismatch: an original-byte precondition that does not match fails', () => {
  const base = utf8('616263'); // "abc"
  const patch = SourcePatch.create(
    base.digest(),
    ContentDigest.of(decodeHex('614263')), // vector input target_hex "aBc"
    base.encodingFacts(),
    [new SourceReplacement(1, 2, decodeHex('78'), decodeHex('42'))], // original "x" instead of "b"
    conformanceMetadata(),
    DEFAULT_LIMITS,
  );
  assert.throws(
    () => patch.apply(base, DEFAULT_LIMITS),
    (error: unknown) => {
      assert.ok(error instanceof SourcePatchError);
      assert.equal(error.kind, 'OriginalMismatch');
      assert.equal(error.index, 0);
      assert.equal(error.code, codeSourcePatchOriginalMismatch);
      return true;
    },
  );
});

test('source.patch.reject-overlap: overlapping old ranges are invalid patches', () => {
  const base = utf8('616263646566'); // "abcdef"
  assert.throws(
    () =>
      SourcePatch.create(
        base,
        [
          new SourceReplacement(1, 4, decodeHex('626364'), new Uint8Array(0)),
          new SourceReplacement(3, 5, decodeHex('6465'), new Uint8Array(0)),
        ],
        conformanceMetadata(),
        DEFAULT_LIMITS,
      ),
    (error: unknown) => {
      assert.ok(error instanceof SourcePatchError);
      assert.equal(error.kind, 'ReplacementOrder');
      assert.equal(error.index, 1);
      // Overlap is a protocol schema defect, not a source content fact
      // (source_patch.rs:453-457).
      assert.equal(error.code, codeProtocolInvalidValue);
      return true;
    },
  );
});

test('source.patch.reject-target-mismatch: computed bytes differing from the declared target digest fail', () => {
  const base = utf8('6162'); // "ab"
  const patch = SourcePatch.create(
    base.digest(),
    ContentDigest.of(decodeHex('64656c696265726174656c792d77726f6e672d746172676574')), // "deliberately-wrong-target"
    base.encodingFacts(),
    [new SourceReplacement(0, 2, decodeHex('6162'), decodeHex('6364'))],
    conformanceMetadata(),
    DEFAULT_LIMITS,
  );
  assert.throws(
    () => patch.apply(base, DEFAULT_LIMITS),
    (error: unknown) => {
      assert.ok(error instanceof SourcePatchError);
      assert.equal(error.kind, 'TargetMismatch');
      assert.equal(error.code, codeSourcePatchTargetMismatch);
      return true;
    },
  );
});

test('source.patch.reject-encoding-change: a patch that changes the encoding facts is rejected', () => {
  const base = SourceSnapshot.fromRaw(
    decodeHex('6162'),
    EncodingRequest.create(latin1Encoding()),
    DEFAULT_SOURCE_LIMITS,
  );
  const patch = SourcePatch.create(
    base.digest(),
    ContentDigest.of(decodeHex('fffe4100')), // vector input target_hex: a UTF-16LE BOM
    base.encodingFacts(),
    [new SourceReplacement(0, 2, decodeHex('6162'), decodeHex('fffe4100'))],
    conformanceMetadata(),
    DEFAULT_LIMITS,
  );
  assert.throws(
    () => patch.apply(base, DEFAULT_LIMITS),
    (error: unknown) => {
      assert.ok(error instanceof SourcePatchError);
      assert.equal(error.kind, 'EncodingMismatch');
      assert.equal(error.code, codeSourceEncodingConflict);
      return true;
    },
  );
});

test('source.resource.patch-count-limit: zero allowed replacements rejects any patch', () => {
  const base = utf8('61'); // "a"
  const limits: SourcePatchLimits = { ...DEFAULT_LIMITS, maxReplacements: 0 };
  assert.throws(
    () =>
      SourcePatch.create(
        base,
        [new SourceReplacement(1, 1, new Uint8Array(0), decodeHex('62'))],
        conformanceMetadata(),
        limits,
      ),
    (error: unknown) => {
      assert.ok(error instanceof SourcePatchError);
      assert.equal(error.kind, 'ResourceLimit');
      assert.equal(error.code, codeSourceResourceLimit);
      assert.equal(error.limitName, 'patch-replacements');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Ordering and insertion rules (RFC 0003 §10; source_patch.rs:469-512)
// ---------------------------------------------------------------------------

test('two replacements may not target the same zero-width insertion point', () => {
  const base = utf8('6162');
  assert.throws(
    () =>
      SourcePatch.create(
        base,
        [
          new SourceReplacement(1, 1, new Uint8Array(0), decodeHex('78')),
          new SourceReplacement(1, 1, new Uint8Array(0), decodeHex('79')),
        ],
        conformanceMetadata(),
        DEFAULT_LIMITS,
      ),
    (error: unknown) => {
      assert.ok(error instanceof SourcePatchError);
      assert.equal(error.kind, 'DuplicateInsertion');
      assert.equal(error.index, 1);
      return true;
    },
  );
});

test('original byte count must agree with the declared range', () => {
  const base = utf8('6162');
  assert.throws(
    () =>
      SourcePatch.create(
        base,
        [new SourceReplacement(0, 2, decodeHex('61'), decodeHex('78'))], // range 2 bytes, original 1
        conformanceMetadata(),
        DEFAULT_LIMITS,
      ),
    (error: unknown) => {
      assert.ok(error instanceof SourcePatchError);
      assert.equal(error.kind, 'InvalidReplacement');
      assert.equal(error.index, 0);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Derivation (RFC 0004 §16; source_patch.rs:143-205)
// ---------------------------------------------------------------------------

test('derive produces a patch that reapplies to the base and reproduces the target', () => {
  const base = utf8('616263'); // "abc"
  const target = utf8('61585963'); // "aXYc"
  const oldAuthority = DocumentAuthority.fresh();
  const newAuthority = DocumentAuthority.fresh();
  const changeSet = new ChangeSet(
    oldAuthority.identity(),
    newAuthority.identity(),
    [new SourceEdit(oldAuthority.span(1, 2), newAuthority.span(1, 3), decodeHex('5859'))], // "XY"
    [],
    [],
  );
  const patch = SourcePatch.derive(base, target, changeSet, new Map(), DEFAULT_LIMITS);
  assert.equal(encodeHex(patch.apply(base, DEFAULT_LIMITS).bytes()), '61585963');

  // An inconsistent change set is rejected at derive time.
  const inconsistent = new ChangeSet(
    oldAuthority.identity(),
    newAuthority.identity(),
    [new SourceEdit(oldAuthority.span(1, 2), newAuthority.span(1, 3), decodeHex('5a5a'))], // "ZZ"
    [],
    [],
  );
  assert.throws(
    () => SourcePatch.derive(base, target, inconsistent, new Map(), DEFAULT_LIMITS),
    (error: unknown) => {
      assert.ok(error instanceof SourcePatchError);
      assert.equal(error.kind, 'ChangeSetMismatch');
      assert.equal(error.index, 0);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Redaction (source_patch.rs:312-364; RFC 0003 §10 redaction flags)
// ---------------------------------------------------------------------------

test('redacted bytes remain required for application but hidden from debug presentation', () => {
  const replacement = new SourceReplacement(0, 6, decodeHex('736563726574'), decodeHex('68696464656e'))
    .withOriginalRedacted(true)
    .withReplacementRedacted(true);
  assert.equal(encodeHex(replacement.original()), '736563726574'); // "secret"
  assert.equal(encodeHex(replacement.replacement()), '68696464656e'); // "hidden"
  const rendered = replacement.debugString();
  assert.ok(!rendered.includes('secret'), rendered);
  assert.ok(!rendered.includes('hidden'), rendered);
  assert.ok(rendered.includes('<redacted>'), rendered);

  const base = utf8('736563726574'); // "secret"
  const patch = SourcePatch.create(
    base,
    [new SourceReplacement(0, 6, decodeHex('736563726574'), decodeHex('68696464656e'))],
    new Map(),
    DEFAULT_LIMITS,
  );
  const redacted = patch.withAllReplacementsRedacted(true, true);
  // Redaction does not change application facts.
  assert.equal(encodeHex(redacted.apply(base, DEFAULT_LIMITS).bytes()), '68696464656e');
});

test('redacting an unknown replacement index fails with UnknownReplacement', () => {
  const base = utf8('61');
  const patch = SourcePatch.create(base, [], new Map(), DEFAULT_LIMITS);
  assert.throws(
    () => patch.withReplacementRedacted(0, true, true),
    (error: unknown) => {
      assert.ok(error instanceof SourcePatchRedactionError);
      assert.equal(error.kind, 'UnknownReplacement');
      assert.equal(error.index, 0);
      return true;
    },
  );
});
