/**
 * Intent documents for UntouchedByteProof (RFC 0004 §15), mirroring the
 * Rust module tests (crates/consema-document/src/untouched_proof.rs:319-402):
 * every successful edit commit includes a proof that old regions exactly
 * cover every non-replaced old byte once, new regions exactly cover every
 * non-inserted new byte once, each mapped region has equal length and
 * equal bytes, and region order is monotonic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UntouchedByteProof, UntouchedByteRegion } from './untouched_proof.ts';
import { SourceReplacement } from './source_patch.ts';
import { EncodingRequest, latin1Encoding, SourceSnapshot, utf8Encoding } from './source.ts';
import { DEFAULT_SOURCE_LIMITS } from './source.ts';
import { ContentDigest } from './sha256.ts';
import { UntouchedByteProofError } from './errors.ts';
import { decodeHex } from './hex.ts';

function utf8(text: string): SourceSnapshot {
  return SourceSnapshot.fromRaw(
    new TextEncoder().encode(text),
    EncodingRequest.create(utf8Encoding()),
    DEFAULT_SOURCE_LIMITS,
  );
}

function replacements(): SourceReplacement[] {
  return [
    new SourceReplacement(0, 0, new Uint8Array(0), new TextEncoder().encode('>')),
    new SourceReplacement(2, 4, new TextEncoder().encode('XX'), new TextEncoder().encode('YYY')),
    new SourceReplacement(6, 7, new TextEncoder().encode('!'), new Uint8Array(0)),
  ];
}

test('proof covers every and only untouched byte', () => {
  const base = utf8('abXXcd!');
  const target = utf8('>abYYYcd');
  const proof = UntouchedByteProof.create(base, target, replacements());
  const regions = proof.regions();
  assert.equal(regions.length, 2);
  assert.deepEqual(
    regions.map((region) => [region.oldStart(), region.oldEnd(), region.newStart(), region.newEnd()]),
    [
      [0, 2, 1, 3],
      [4, 6, 6, 8],
    ],
  );
  proof.verify(base, target, replacements());
});

test('proof detects region, digest, and target tampering', () => {
  const base = utf8('abXXcd!');
  const target = utf8('>abYYYcd');
  // Transferred facts with a tampered first region: verification must fail.
  const proof = UntouchedByteProof.fromFacts(
    base.digest(),
    target.digest(),
    [
      new UntouchedByteRegion(0, 2, 0, 2),
      new UntouchedByteRegion(4, 6, 6, 8),
    ],
  );
  assert.throws(
    () => proof.verify(base, target, replacements()),
    (error: unknown) => error instanceof UntouchedByteProofError && error.kind === 'ProofMismatch',
  );
  // A different target snapshot fails the digest check.
  assert.throws(
    () => proof.verify(base, utf8('>abYYYcD'), replacements()),
    (error: unknown) => error instanceof UntouchedByteProofError && error.kind === 'DigestMismatch',
  );
  // Creating a proof against a tampered target fails at create time.
  assert.throws(
    () => UntouchedByteProof.create(base, utf8('>aBYYYcd'), replacements()),
    (error: unknown) => error instanceof UntouchedByteProofError && error.kind === 'TargetMismatch',
  );
});

test('no replacements prove the complete snapshot', () => {
  const source = utf8('same');
  const proof = UntouchedByteProof.create(source, source, []);
  const regions = proof.regions();
  assert.equal(regions.length, 1);
  assert.deepEqual(
    [regions[0].oldStart(), regions[0].oldEnd(), regions[0].newStart(), regions[0].newEnd()],
    [0, 4, 0, 4],
  );
  proof.verify(source, source, []);
});

test('transferred proof rejects non-canonical regions', () => {
  const digest = ContentDigest.of(decodeHex('616263'));
  assert.throws(
    () =>
      UntouchedByteProof.fromFacts(
        digest,
        digest,
        [
          new UntouchedByteRegion(0, 1, 0, 1),
          new UntouchedByteRegion(1, 3, 1, 3),
        ],
      ),
    (error: unknown) => {
      assert.ok(error instanceof UntouchedByteProofError);
      assert.equal(error.kind, 'InvalidRegion');
      assert.equal(error.index, 1);
      return true;
    },
  );
});

test('proof rejects encoding drift between base and target', () => {
  const base = utf8('ab');
  const latin1Target = SourceSnapshot.fromRaw(
    decodeHex('6162'),
    EncodingRequest.create(latin1Encoding()),
    DEFAULT_SOURCE_LIMITS,
  );
  assert.throws(
    () => UntouchedByteProof.create(base, latin1Target, []),
    (error: unknown) => error instanceof UntouchedByteProofError && error.kind === 'EncodingMismatch',
  );
});
