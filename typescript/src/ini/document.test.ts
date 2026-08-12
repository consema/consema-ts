/**
 * INI formation intent tests.
 *
 * These are blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3): they transcribe the language-neutral facts from
 * conformance/vectors/ini-v1.json and crates/consema-ini (parser.rs,
 * lib.rs) and run once the toolchain is ready. Golden vector case ids are
 * cited in each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_INI_PARSE_LIMITS,
  IniProfile,
  explicitSelection,
  profileDefaultSelection,
  type IniParseLimits,
} from './profile.ts';
import { IniDocument, parseIniDocument } from './document.ts';
import { IniEditFailure, IniFormationFailure } from './errors.ts';
import { WindowsCodePage, windowsCodePageEncoding } from '../document/source.ts';
import { projectIni, IniProjectionRequest } from './projection.ts';
import { IniEditTransactionBuilder, commitIniEdits } from './edit.ts';

function parseText(
  profile: IniProfile,
  text: string,
  limits: IniParseLimits = DEFAULT_INI_PARSE_LIMITS,
): IniDocument {
  return parseIniDocument(
    new TextEncoder().encode(text),
    profile,
    profileDefaultSelection(),
    limits,
  );
}

function parseBytes(profile: IniProfile, bytes: Uint8Array): IniDocument {
  return parseIniDocument(bytes, profile, profileDefaultSelection(), DEFAULT_INI_PARSE_LIMITS);
}

function utf16leBom(text: string): Uint8Array {
  const units = [];
  for (let index = 0; index < text.length; index++) {
    units.push(text.charCodeAt(index));
  }
  const bytes = new Uint8Array(2 + units.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < units.length; index++) {
    bytes[2 + index * 2] = units[index] & 0xff;
    bytes[3 + index * 2] = (units[index] >> 8) & 0xff;
  }
  return bytes;
}

function decodeHex(value: string): Uint8Array {
  assert.equal(value.length % 2, 0, 'hex length');
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function assertExactCoverage(document: IniDocument): void {
  const pieces = document.losslessStructuralIndex().pieces();
  const kinds = document.losslessSyntaxKinds();
  assert.equal(pieces.length, kinds.length);
  if (document.source().isEmpty()) {
    assert.equal(pieces.length, 0);
    return;
  }
  assert.equal(pieces[0].span().startByte(), 0);
  assert.equal(pieces[pieces.length - 1].span().endByte(), document.source().len());
  for (let index = 1; index < pieces.length; index++) {
    assert.equal(pieces[index - 1].span().endByte(), pieces[index].span().startByte());
  }
}

test('golden formation.portable-lossless: lossless facts, spans, and coverage', () => {
  // conformance/vectors/ini-v1.json:5-9 — the source, the four physical
  // lines, three logical records, section [core], entries name/empty with
  // Present/Empty states, and exact coverage.
  const document = parseText(
    IniProfile.PORTABLE_V1,
    '; heading\r\n[core]\r\nname=value\nempty=',
  );
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(new TextDecoder().decode(document.render()), '; heading\r\n[core]\r\nname=value\nempty=');
  assert.equal(document.physicalLines().length, 4);
  assert.equal(document.logicalLines().length, 3);
  assert.deepEqual(document.sections().map((section) => section.name()), ['core']);
  assert.deepEqual(document.entries().map((entry) => entry.key()), ['name', 'empty']);
  assert.deepEqual(document.entries().map((entry) => entry.value()), ['value', '']);
  assert.deepEqual(document.entries().map((entry) => entry.valueState()), ['Present', 'Empty']);
  assertExactCoverage(document);

  // Byte-exact spans: "; heading\r\n" is 11 bytes, so "[core]" occupies
  // raw bytes 11..17 and its name bytes 12..16.
  const section = document.sections()[0];
  assert.equal(section.span().startByte(), 11);
  assert.equal(section.span().endByte(), 17);
  assert.equal(section.nameSpan().startByte(), 12);
  assert.equal(section.nameSpan().endByte(), 16);
});

test('golden formation.profile-counterexample-matrix: same bytes, three profiles', () => {
  // conformance/vectors/ini-v1.json:10-18 — portable/windows/python against
  // "[s]\nkey=value\n", "[s]\nkey:value\n", "[s]\nkey=é\n".
  const samples = [
    { source: '[s]\nkey=value\n', encoding: 'default' },
    { source: '[s]\nkey:value\n', encoding: 'default' },
    { source: '[s]\nkey=é\n', encoding: 'default' },
  ];
  const expected = {
    portable: ['Complete', 'Recovered', 'Recovered'],
    windows: ['Complete', 'Recovered', 'Fatal'],
    python: ['Complete', 'Complete', 'Complete'],
  };
  for (const [profileName, profile] of [
    ['portable', IniProfile.PORTABLE_V1],
    ['windows', IniProfile.WINDOWS_V1],
    ['python', IniProfile.PYTHON_CONFIGPARSER_V1],
  ] as const) {
    const outcomes = samples.map((sample) => {
      try {
        return parseText(profile, sample.source).formationStatus();
      } catch (failure) {
        if (failure instanceof IniFormationFailure) {
          return 'Fatal';
        }
        throw failure;
      }
    });
    assert.deepEqual(outcomes, expected[profileName], profileName);
  }
  // The portable ": value" line recovers as missing-delimiter and never
  // fabricates an entry (RFC 0009 §4:145-146).
  const recovered = parseText(IniProfile.PORTABLE_V1, '[s]\nkey:value\n');
  assert.equal(recovered.entries().length, 0);
  assert.equal(recovered.errorLines().length, 1);
  assert.equal(recovered.errorLines()[0].code(), 'ini.parse.missing-delimiter@1');
});

test('golden formation.windows-utf16-case-and-quote: UTF-16LE, case groups, quotes', () => {
  // conformance/vectors/ini-v1.json:19-23 — the exact source_hex bytes,
  // section names [Main, main], comparison "main", keys [Name, NAME],
  // comparison "name", values [" value ", "two"], Double quote style,
  // case-collision diagnostic, exact coverage.
  const bytes = decodeHex(
    'fffe5b004d00610069006e005d000d000a0020004e0061006d00650020003d0022002000760061006c0075006500200022000d000a005b006d00610069006e005d000d000a004e0041004d0045003d00740077006f00',
  );
  const document = parseBytes(IniProfile.WINDOWS_V1, bytes);
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(document.source().encodingFacts().selected().kind, 'Utf16Le');
  assert.equal(document.source().encodingFacts().bom(), 'Utf16Le');
  assert.deepEqual(document.sections().map((section) => section.name()), ['Main', 'main']);
  assert.equal(document.sections()[0].comparisonName(), 'main');
  assert.deepEqual(document.entries().map((entry) => entry.key()), ['Name', 'NAME']);
  assert.equal(document.entries()[0].comparisonKey(), 'name');
  assert.deepEqual(document.entries().map((entry) => entry.value()), [' value ', 'two']);
  assert.equal(document.entries()[0].quoteStyle(), 'Double');
  assert.equal(
    document.sections()[0].duplicateGroup(),
    document.sections()[1].duplicateGroup(),
  );
  assert.equal(document.entries()[0].duplicateGroup(), document.entries()[1].duplicateGroup());
  assert.ok(
    document.diagnostics().some((item) => item.code === 'ini.formation.case-collision@1'),
  );
  assertExactCoverage(document);
});

test('golden formation.windows-explicit-code-page: cp1252 TreatAsContent', () => {
  // conformance/vectors/ini-v1.json:24-28 — bytes "[s]\r\nk=\x80" under an
  // explicit Windows code page 1252 decode to "€"; the BOM policy is
  // TreatAsContent and coverage is exact.
  const bytes = decodeHex('5b735d0d0a6b3d80');
  const page = WindowsCodePage.fromNumber(1252);
  assert.ok(page !== null, 'cp1252 published');
  const document = parseIniDocument(
    bytes,
    IniProfile.WINDOWS_V1,
    explicitSelection(windowsCodePageEncoding(page!)),
    DEFAULT_INI_PARSE_LIMITS,
  );
  assert.equal(document.entries()[0].value(), '€');
  assert.equal(
    document.source().encodingFacts().selected().kind,
    'WindowsCodePage',
  );
  assert.equal(document.source().encodingFacts().bomPolicy(), 'TreatAsContent');
  assertExactCoverage(document);
});

test('golden formation.python-default-continuation-raw: DEFAULT role, multiline joins, literal markers', () => {
  // conformance/vectors/ini-v1.json:29-33 — the default section role,
  // comparison keys [root, key, other], raw stored values including
  // interpolation-looking text, and four continuation physical lines.
  const document = parseText(
    IniProfile.PYTHON_CONFIGPARSER_V1,
    '[DEFAULT]\nRoot = raw%(x)s\n[Sec]\nKey: first\n    second\n\n    third\nOther = #literal ;literal',
  );
  assert.equal(document.formationStatus(), 'Complete');
  assert.equal(document.sections()[0].isDefault(), true);
  assert.equal(document.sections()[0].nodeRef().role(), 'IniDefaultSection');
  assert.deepEqual(
    document.entries().map((entry) => entry.comparisonKey()),
    ['root', 'key', 'other'],
  );
  assert.deepEqual(
    document.entries().map((entry) => entry.value()),
    ['raw%(x)s', 'first\nsecond\n\nthird', '#literal ;literal'],
  );
  assert.equal(
    document.logicalLine(document.entries()[1].logicalLine()).physicalLines().length,
    4,
  );
  assertExactCoverage(document);
});

test('golden formation.python-unicode16-optionxform: İ and i̇ collide', () => {
  // conformance/vectors/ini-v1.json:34-38 — U+0130 maps to "i" + U+0307
  // under the pinned Unicode 16.0 optionxform, so İ=1 and i̇=2 share a
  // comparison key and form a duplicate group with a case-collision
  // diagnostic.
  const document = parseText(IniProfile.PYTHON_CONFIGPARSER_V1, '[S]\nİ=1\ni̇=2\n');
  assert.equal(document.formationStatus(), 'Recovered');
  assert.deepEqual(
    document.entries().map((entry) => entry.comparisonKey()),
    ['i\u{0307}', 'i\u{0307}'],
  );
  assert.equal(document.entries()[0].duplicateGroup() !== null, true);
  assert.equal(
    document.entries()[0].duplicateGroup(),
    document.entries()[1].duplicateGroup(),
  );
  assert.ok(document.diagnostics().some((item) => item.code === 'ini.formation.case-collision@1'));
});

test('golden formation.recovery-never-fabricates-entry: Recovered is atomic for projection and edit', () => {
  // conformance/vectors/ini-v1.json:39-43 — "bare" recovers as
  // missing-delimiter with zero entries; projection fails with
  // ini.projection.incomplete-document@1 and commit fails with
  // core.edit.incomplete-target@1.
  const document = parseText(IniProfile.PORTABLE_V1, '[s]\nbare\n');
  assert.equal(document.formationStatus(), 'Recovered');
  assert.equal(document.entries().length, 0);
  assert.equal(document.errorLines().length, 1);
  assert.equal(document.errorLines()[0].code(), 'ini.parse.missing-delimiter@1');
  const projection = projectIni(document, IniProjectionRequest.bestExactEntryMapping());
  assert.equal(projection.kind, 'Failed');
  if (projection.kind === 'Failed') {
    assert.equal(projection.value.diagnostics()[0].code, 'ini.projection.incomplete-document@1');
  }
  const transaction = new IniEditTransactionBuilder(document).build();
  assert.throws(
    () => commitIniEdits(document, transaction),
    (failure: unknown) => {
      return (
        failure instanceof IniEditFailure &&
        failure.kind === 'RecoveredDocument' &&
        failure.code === 'core.edit.incomplete-target@1'
      );
    },
  );
});

test('duplicate semantics: portable duplicates recover, Windows duplicates stay Complete', () => {
  // RFC 0009 §5 (:173-177) and §6 (:207-212): portable duplicate sections
  // and keys make formation Recovered with both occurrences observable;
  // Windows repeated/case-equivalent headers and keys are Complete
  // ambiguity facts.
  const portable = parseText(IniProfile.PORTABLE_V1, '[s]\na=1\n[s]\nb=2\n');
  assert.equal(portable.formationStatus(), 'Recovered');
  assert.equal(portable.sections().length, 2);
  assert.equal(portable.sections()[0].duplicateGroup() !== null, true);
  assert.ok(
    portable
      .diagnostics()
      .some((item) => item.code === 'ini.formation.duplicate-section@1'),
  );

  const windows = parseText(IniProfile.WINDOWS_V1, '[Main]\r\nName=one\r\nname=two\r\n');
  assert.equal(windows.formationStatus(), 'Complete');
  assert.equal(windows.entries()[0].duplicateGroup(), windows.entries()[1].duplicateGroup());
  assert.ok(
    windows
      .diagnostics()
      .some((item) => item.code === 'ini.formation.case-collision@1'),
  );
});

test('profile encoding contracts: BOM, code pages, and ASCII-only Windows input', () => {
  // RFC 0009 §3; parser.rs:37-104. A UTF-8 BOM is a profile error for
  // portable; non-ASCII UTF-8 without a BOM is fatal for Windows without
  // an explicit code page; ASCII-only bytes form a Complete Windows
  // document; UTF-16BE is rejected.
  assert.throws(() => {
    parseBytes(IniProfile.PORTABLE_V1, new Uint8Array([0xef, 0xbb, 0xbf, 0x5b, 0x73, 0x5d, 0x0a]));
  }, IniFormationFailure);
  assert.throws(() => {
    parseText(IniProfile.WINDOWS_V1, '[s]\nk=é\n');
  }, IniFormationFailure);
  const ascii = parseText(IniProfile.WINDOWS_V1, '[s]\nk=1\n');
  assert.equal(ascii.formationStatus(), 'Complete');
  assert.throws(() => {
    parseBytes(IniProfile.WINDOWS_V1, new Uint8Array([0xfe, 0xff, 0x00, 0x5b, 0x00, 0x73, 0x00, 0x5d]));
  }, IniFormationFailure);
});

test('resource.formation-limit-matrix: every configured limit fails without a document', () => {
  // conformance/vectors/ini-v1.json:107-129 — all 17 descriptors must be
  // fatal (fatal_count 17) with no partial documents.
  const descriptors: { name: string; profile: IniProfile; source: string; value: number }[] = [
    { name: 'max_source_bytes', profile: IniProfile.PORTABLE_V1, source: '[s]\nk=1\n', value: 4 },
    { name: 'max_token_count', profile: IniProfile.PORTABLE_V1, source: '[s]\nk=1\n', value: 1 },
    { name: 'max_node_count', profile: IniProfile.PORTABLE_V1, source: '[s]\nk=1\n', value: 1 },
    { name: 'max_diagnostics', profile: IniProfile.PORTABLE_V1, source: '[s]\nbare\nbad\n', value: 0 },
    { name: 'max_decoded_utf8_bytes', profile: IniProfile.PORTABLE_V1, source: '[s]\nk=1\n', value: 1 },
    { name: 'max_decoded_scalars', profile: IniProfile.PORTABLE_V1, source: '[s]\nk=1\n', value: 1 },
    { name: 'max_physical_lines', profile: IniProfile.PORTABLE_V1, source: '[s]\nk=1\n', value: 1 },
    { name: 'max_physical_line_bytes', profile: IniProfile.PORTABLE_V1, source: '[section]\nkey=value\n', value: 3 },
    { name: 'max_physical_line_scalars', profile: IniProfile.PORTABLE_V1, source: '[section]\nkey=value\n', value: 3 },
    { name: 'max_logical_lines', profile: IniProfile.PORTABLE_V1, source: '[s]\nk=1\n', value: 1 },
    { name: 'max_logical_line_bytes', profile: IniProfile.PYTHON_CONFIGPARSER_V1, source: '[s]\nk=one\n  two\n', value: 8 },
    { name: 'max_logical_line_scalars', profile: IniProfile.PYTHON_CONFIGPARSER_V1, source: '[s]\nk=one\n  two\n', value: 4 },
    { name: 'max_continuation_lines', profile: IniProfile.PYTHON_CONFIGPARSER_V1, source: '[s]\nk=one\n  two\n', value: 0 },
    { name: 'max_sections', profile: IniProfile.PORTABLE_V1, source: '[a]\nx=1\n[b]\ny=2\n', value: 1 },
    { name: 'max_entries', profile: IniProfile.PORTABLE_V1, source: '[s]\na=1\nb=2\n', value: 1 },
    { name: 'max_duplicate_group_members', profile: IniProfile.WINDOWS_V1, source: '[s]\r\na=1\r\nA=2\r\n', value: 1 },
    { name: 'max_recovery_regions', profile: IniProfile.PORTABLE_V1, source: '[s]\nbare\nbad\n', value: 1 },
  ];
  let fatal = 0;
  for (const descriptor of descriptors) {
    const limits = withLimit(DEFAULT_INI_PARSE_LIMITS, descriptor.name, descriptor.value);
    let failed = false;
    try {
      parseText(descriptor.profile, descriptor.source, limits);
    } catch (failure) {
      if (failure instanceof IniFormationFailure) {
        failed = true;
        // Source-construction limits carry core.source.resource-limit@1
        // (consema-document lib.rs:701-705); parser limits carry
        // core.parse.resource-limit@1 (lib.rs:771-791).
        const sourceLevel = ['max_source_bytes', 'max_decoded_utf8_bytes', 'max_decoded_scalars'];
        assert.equal(
          failure.code,
          sourceLevel.includes(descriptor.name)
            ? 'core.source.resource-limit@1'
            : 'core.parse.resource-limit@1',
          descriptor.name,
        );
      } else {
        throw failure;
      }
    }
    if (failed) {
      fatal += 1;
    }
  }
  assert.equal(fatal, 17);
});

function withLimit(
  base: IniParseLimits,
  name: string,
  value: number,
): IniParseLimits {
  const common = { ...base.common };
  switch (name) {
    case 'max_source_bytes':
      common.maxSourceBytes = value;
      break;
    case 'max_token_count':
      common.maxTokenCount = value;
      break;
    case 'max_node_count':
      common.maxNodeCount = value;
      break;
    case 'max_diagnostics':
      common.maxDiagnostics = value;
      break;
    default:
      break;
  }
  switch (name) {
    case 'max_decoded_utf8_bytes':
      return { ...base, common, maxDecodedUtf8Bytes: value };
    case 'max_decoded_scalars':
      return { ...base, common, maxDecodedScalars: value };
    case 'max_physical_lines':
      return { ...base, common, maxPhysicalLines: value };
    case 'max_physical_line_bytes':
      return { ...base, common, maxPhysicalLineBytes: value };
    case 'max_physical_line_scalars':
      return { ...base, common, maxPhysicalLineScalars: value };
    case 'max_logical_lines':
      return { ...base, common, maxLogicalLines: value };
    case 'max_logical_line_bytes':
      return { ...base, common, maxLogicalLineBytes: value };
    case 'max_logical_line_scalars':
      return { ...base, common, maxLogicalLineScalars: value };
    case 'max_continuation_lines':
      return { ...base, common, maxContinuationLines: value };
    case 'max_sections':
      return { ...base, common, maxSections: value };
    case 'max_entries':
      return { ...base, common, maxEntries: value };
    case 'max_duplicate_group_members':
      return { ...base, common, maxDuplicateGroupMembers: value };
    case 'max_recovery_regions':
      return { ...base, common, maxRecoveryRegions: value };
    default:
      return { ...base, common };
  }
}

test('UTF-16LE round trip is byte-exact and logical lines map physical constituents', () => {
  const bytes = utf16leBom('[S]\r\nk=" v "\r\n');
  const document = parseBytes(IniProfile.WINDOWS_V1, bytes);
  assert.deepEqual(document.render(), bytes);
  assert.equal(document.logicalLines().length, 2);
  const entryLogical = document.logicalLine(document.entries()[0].logicalLine());
  assert.equal(entryLogical.kind(), 'Entry');
  assert.equal(entryLogical.physicalLines().length, 1);
  const physical = document.physicalLine(entryLogical.physicalLines()[0].nodeRef());
  assert.equal(physical.lineBreakSpan() !== null, true);
  assertExactCoverage(document);
});
