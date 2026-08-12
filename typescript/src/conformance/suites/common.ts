/**
 * Shared per-suite helpers: profile parsing through the root facade,
 * formation/diagnostic checks, and the documented-skip discipline
 * (docs/five-language-ci-design.md §2.2: an unimplemented capability is a
 * documented skip with capability + reason, never silent).
 */

import { Document, parseDocument } from '../../registry.ts';
import { ProfileId } from '../../document/profile.ts';
import {
  ConformanceFailure,
  bytesEqual,
  caseField,
  caseFieldOptional,
  expectedField,
  expectedFieldOptional,
  hexToBytes,
  text,
  utf8,
} from '../helpers.ts';

export type { ConformanceFailure };

/** One documented skip with its capability and reason. */
export class SkippedCase extends Error {
  constructor(capability: string, reason: string) {
    super(`${capability}: ${reason}`);
    this.name = 'SkippedCase';
  }
}

/** Marks a case as a documented skip (capability + reason). */
export function skip(capability: string, reason: string): never {
  throw new SkippedCase(capability, reason);
}

/** Parses bytes under a vector profile id ("json.strict@1") through the root facade. */
export function parseBytes(bytes: Uint8Array, profileId: string): Document {
  const [id] = profileId.split('@');
  return parseDocument(bytes, new ProfileId(id, 1));
}

/** Parses the case `source` (or `source_hex`) under `input.profile`. */
export function parseSourceCase(case_: CaseLike): Document {
  const profile = caseField(case_, 'profile') as string;
  const source = caseField(case_, 'source');
  const sourceHex = caseFieldOptional(case_, 'source_hex');
  const bytes = sourceHex !== undefined ? hexToBytes(sourceHex as string) : utf8(source as string);
  return parseBytes(bytes, profile);
}

export interface CaseLike {
  readonly id: string;
  readonly capability?: string;
  readonly contract?: string;
  readonly input?: unknown;
  readonly expected: Record<string, unknown>;
}

/** Asserts the document formation status, render, and render_equals_source expectations. */
export function expectFormationAndRender(document: Document, case_: CaseLike): void {
  const expectedFormation = expectedFieldOptional(case_, 'formation');
  if (expectedFormation !== undefined) {
    const observed = document.formationStatus();
    if (observed !== expectedFormation) {
      fail(`formation: expected ${String(expectedFormation)}, observed ${observed}`);
    }
  }
  const renderEquals = expectedFieldOptional(case_, 'render_equals_source');
  if (renderEquals === true) {
    const source = caseField(case_, 'source') as string;
    if (!bytesEqual(document.render(), utf8(source))) {
      fail('render must equal the source');
    }
  }
  const render = expectedFieldOptional(case_, 'render');
  if (render !== undefined) {
    const observed = text(document.render());
    if (observed !== render) {
      fail(`render: expected ${JSON.stringify(render)}, observed ${JSON.stringify(observed)}`);
    }
  }
}

/** Asserts one diagnostic code appears in the document. */
export function expectDiagnostic(document: Document, code: string): void {
  const diagnostics = document.diagnostics();
  if (!diagnostics.some((diagnostic) => diagnostic.code === code)) {
    fail(`missing diagnostic ${code} (observed ${diagnostics.map((d) => d.code).join(', ')})`);
  }
}

/** Asserts the pinned diagnostic code when the expectation has one. */
export function expectDiagnosticIfPinned(document: Document, case_: CaseLike): void {
  const diagnostic = expectedFieldOptional(case_, 'diagnostic');
  if (diagnostic !== undefined) {
    expectDiagnostic(document, diagnostic as string);
  }
}

export function fail(message: string): never {
  throw new ConformanceFailure(message);
}

/** Expects a thrown error with the exact frozen code; returns the error. */
export function expectThrowsCode(operation: () => void, code: string): Error {
  try {
    operation();
  } catch (error) {
    const observed = (error as { code?: unknown } | null)?.code;
    if (observed !== code) {
      fail(`expected code ${code}, observed ${JSON.stringify(observed)} (${String(error)})`);
    }
    return error as Error;
  }
  fail(`expected a failure with code ${code}, but the operation completed`);
}

/** Expected failure code from the vector (`expected.code` / `expected.error_code`). */
export function expectedCode(case_: CaseLike): string | undefined {
  const code = expectedFieldOptional(case_, 'code');
  if (code !== undefined) {
    return code as string;
  }
  const errorCode = expectedFieldOptional(case_, 'error_code');
  return errorCode as string | undefined;
}

/** Asserts the observed code equals the pinned expectation (either present or absent). */
export function expectObservedCode(case_: CaseLike, observedCode: string | undefined): void {
  const pinned = expectedCode(case_);
  if (pinned !== undefined && observedCode !== pinned) {
    fail(`code: expected ${pinned}, observed ${JSON.stringify(observedCode)}`);
  }
}

export { expectedField, expectedFieldOptional, caseField, caseFieldOptional };
