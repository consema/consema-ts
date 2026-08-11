/**
 * Pinned Python optionxform intent tests.
 *
 * These are blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3): they transcribe the language-neutral facts from
 * crates/consema-ini/src/python_case.rs (tests :234-273) and run once the
 * toolchain is ready. The vector case formation.python-unicode16-optionxform
 * (ini-v1.json:34-38) pins the profile-level effect.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { optionxform } from './python_case.ts';

test('unicode 16 full lowercase examples are exact', () => {
  // python_case.rs:239-244.
  assert.equal(optionxform('Key'), 'key');
  assert.equal(optionxform('\u{0130}'), 'i\u{0307}');
  assert.equal(optionxform('\u{212A}\u{1E9E}'), 'k\u{00DF}');
  assert.equal(optionxform('\u{10400}'), '\u{10428}');
});

test('unicode 17 new letters remain unassigned under the frozen profile', () => {
  // python_case.rs:246-255 — the frozen Unicode 16.0 tables do not lower
  // letters added later.
  for (const code of [0xa7ce, 0xa7d2, 0xa7d4]) {
    const character = String.fromCodePoint(code);
    assert.equal(optionxform(character), character);
  }
  for (let code = 0x16ea0; code <= 0x16eb8; code++) {
    const character = String.fromCodePoint(code);
    assert.equal(optionxform(character), character);
  }
});
