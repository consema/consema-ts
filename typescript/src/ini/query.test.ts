/**
 * INI native and lossless-syntax query intent tests.
 *
 * These are blind-written intent documents (docs/multi-language-implementation
 * -plan.md §3): they transcribe the language-neutral facts from
 * conformance/vectors/ini-v1.json and crates/consema-ini/src/query.rs and
 * run once the toolchain is ready. Golden vector case ids are cited in
 * each test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  newQueryDefinition,
  withExpression,
  withSelection,
  newOperatorCall,
  withArgument,
  validateQuery,
  bindQuery,
  type QueryExpression,
} from '../protocol/query.ts';
import { stringValue, integerValue } from '../core/value.ts';
import {
  DEFAULT_INI_PARSE_LIMITS,
  IniProfile,
  profileDefaultSelection,
  iniNativeQueryDomain,
  iniLosslessSyntaxQueryDomain,
} from './profile.ts';
import { parseIniDocument } from './document.ts';
import {
  DEFAULT_INI_QUERY_LIMITS,
  IniCancellationToken,
  IniQueryExecutionFailure,
  executeIniQuery,
  executeIniSyntaxQuery,
  executeIniQueryCursor,
  iniQueryRequiredCapabilities,
} from './query.ts';

function parseText(profile: IniProfile, text: string) {
  return parseIniDocument(
    new TextEncoder().encode(text),
    profile,
    profileDefaultSelection(),
    DEFAULT_INI_PARSE_LIMITS,
  );
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

/** Builds, validates, and binds one native query; a validation failure fails the test. */
function executable(
  expression: QueryExpression,
  selection: 'All' | 'First' | 'Last' | 'ZeroOrOne' | 'RequireOne' = 'All',
) {
  const definition = withSelection(
    withExpression(newQueryDefinition(iniNativeQueryDomain()), expression),
    selection,
  );
  const validated = validateQuery(definition);
  assert.ok(!('failure' in validated), 'query definition validates');
  const bound = bindQuery(validated.query, iniQueryRequiredCapabilities());
  assert.ok(!('failure' in bound), 'query binds');
  return bound.query;
}

function syntaxExecutable(
  expression: QueryExpression,
  selection: 'All' | 'First' | 'Last' | 'ZeroOrOne' | 'RequireOne' = 'All',
) {
  const definition = withSelection(
    withExpression(newQueryDefinition(iniLosslessSyntaxQueryDomain()), expression),
    selection,
  );
  const validated = validateQuery(definition);
  assert.ok(!('failure' in validated), 'syntax query definition validates');
  const bound = bindQuery(validated.query, iniQueryRequiredCapabilities());
  assert.ok(!('failure' in bound), 'syntax query binds');
  return bound.query;
}

test('golden query.native-order-and-profile-equivalence: entries and groups in source order', () => {
  // conformance/vectors/ini-v1.json:44-48 — document-sections then
  // section-name-equals(name "MAIN", ProfileEquivalent) then
  // section-entries yields keys [Name, name] as IniEntry roles with a
  // duplicate group, terminal Completed.
  const document = parseText(
    IniProfile.WINDOWS_V1,
    '[Main]\r\nName=one\r\nname=two\r\n[Other]\r\nempty=\r\n',
  );
  const expression: QueryExpression = {
    kind: 'Apply',
    input: {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: { kind: 'Input' },
        operator: newOperatorCall('ini.document-sections', 1),
      },
      operator: withArgument(
        withArgument(
          newOperatorCall('ini.section-name-equals', 1),
          'name',
          stringValue('MAIN'),
        ),
        'comparison',
        stringValue('ProfileEquivalent'),
      ),
    },
    operator: newOperatorCall('ini.section-entries', 1),
  };
  const result = executeIniQuery(
    executable(expression),
    document,
    DEFAULT_INI_QUERY_LIMITS,
    new IniCancellationToken(),
  );
  assert.deepEqual(
    result.matches.map((match) => (match.kind === 'Entry' ? match.key : '')),
    ['Name', 'name'],
  );
  assert.ok(result.matches.every((match) => match.kind === 'Entry'));
  assert.ok(
    result.matches.every(
      (match) => match.kind === 'Entry' && match.duplicateGroup !== null,
    ),
  );
  const cursor = executeIniQueryCursor(
    executable(expression),
    document,
    DEFAULT_INI_QUERY_LIMITS,
    new IniCancellationToken(),
  );
  assert.equal(cursor.next() !== null, true);
  assert.equal(cursor.next() !== null, true);
  assert.equal(cursor.next(), null);
  assert.equal(cursor.terminalState(), 'Completed');
});

test('duplicate-group expansion includes every same-role occurrence', () => {
  // RFC 0009 §9:326-335 — ini.duplicate-group@1 expands each input
  // occurrence to every same-role occurrence with the same group identity.
  const document = parseText(
    IniProfile.WINDOWS_V1,
    '[Main]\r\nName=one\r\nname=two\r\n[main]\r\nOther=three\r\n',
  );
  const expression: QueryExpression = {
    kind: 'Apply',
    input: {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: { kind: 'Input' },
        operator: newOperatorCall('ini.all-entries', 1),
      },
      operator: withArgument(
        withArgument(
          newOperatorCall('ini.entry-key-equals', 1),
          'key',
          stringValue('Name'),
        ),
        'comparison',
        stringValue('OriginalExact'),
      ),
    },
    operator: newOperatorCall('ini.duplicate-group', 1),
  };
  const result = executeIniQuery(
    executable(expression),
    document,
    DEFAULT_INI_QUERY_LIMITS,
    new IniCancellationToken(),
  );
  assert.equal(result.matches.length, 2);
  assert.ok(result.matches.every((match) => match.kind === 'Entry'));
  if (result.matches[1].kind === 'Entry') {
    assert.equal(result.matches[1].key, 'name');
  }
});

test('entry-section and value-state operators resolve ownership', () => {
  // query.rs:457-469, 526-542 — entries resolve their owning section and
  // Empty values filter by state.
  const document = parseText(
    IniProfile.PORTABLE_V1,
    '[s]\na=1\nempty=\n',
  );
  const emptyExpression: QueryExpression = {
    kind: 'Apply',
    input: {
      kind: 'Apply',
      input: {
        kind: 'Apply',
        input: { kind: 'Input' },
        operator: newOperatorCall('ini.all-entries', 1),
      },
      operator: withArgument(
        newOperatorCall('ini.entry-value-state-is', 1),
        'state',
        stringValue('Empty'),
      ),
    },
    operator: newOperatorCall('ini.entry-section', 1),
  };
  const result = executeIniQuery(
    executable(emptyExpression),
    document,
    DEFAULT_INI_QUERY_LIMITS,
    new IniCancellationToken(),
  );
  assert.equal(result.matches.length, 1);
  if (result.matches[0].kind === 'Section') {
    assert.equal(result.matches[0].name, 's');
  }
});

test('golden query.syntax-decoded-structure-order: Quote kind and decoded text', () => {
  // conformance/vectors/ini-v1.json:49-53 — StructureOrderMerge of
  // syntax-text-equals("Name") and syntax-kind-is("Quote") over a UTF-16LE
  // Windows source yields [EntryKey, Quote, Quote] with strictly
  // increasing ordinals and IniSyntaxPiece roles.
  const bytes = utf16leBom('[S]\r\nName=" value "\r\n');
  const document = parseIniDocument(
    bytes,
    IniProfile.WINDOWS_V1,
    profileDefaultSelection(),
    DEFAULT_INI_PARSE_LIMITS,
  );
  const text: QueryExpression = {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: withArgument(
      newOperatorCall('ini.syntax-text-equals', 1),
      'text',
      stringValue('Name'),
    ),
  };
  const kind: QueryExpression = {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: withArgument(
      newOperatorCall('ini.syntax-kind-is', 1),
      'kind',
      stringValue('Quote'),
    ),
  };
  const result = executeIniSyntaxQuery(
    syntaxExecutable({ kind: 'StructureOrderMerge', branches: [text, kind] }),
    document,
    DEFAULT_INI_QUERY_LIMITS,
    new IniCancellationToken(),
  );
  assert.deepEqual(
    result.matches.map((match) => match.kind()),
    ['EntryKey', 'Quote', 'Quote'],
  );
  assert.ok(
    result.matches.every((match) => match.nodeRef().role() === 'IniSyntaxPiece'),
  );
  for (let index = 1; index < result.matches.length; index++) {
    assert.ok(result.matches[index - 1].ordinal() < result.matches[index].ordinal());
  }
});

test('golden query.validation-limit-cancellation: validation, limits, and cursor cancellation', () => {
  // conformance/vectors/ini-v1.json:54-58 — an invalid composition fails
  // validation; a max_results limit fails with core.query.resource-limit@1;
  // a cursor yields first, then cancellation exhausts it with terminal
  // Cancelled.
  const invalid = validateQuery(
    withExpression(
      newQueryDefinition(iniNativeQueryDomain()),
      {
        kind: 'Apply',
        input: { kind: 'Input' },
        operator: withArgument(
          withArgument(
            newOperatorCall('ini.section-name-equals', 1),
            'name',
            stringValue('S'),
          ),
          'comparison',
          stringValue('OriginalExact'),
        ),
      },
    ),
  );
  assert.ok('failure' in invalid, 'section-name-equals on IniDocument input is invalid');
  if ('failure' in invalid) {
    assert.equal(invalid.failure.kind, 'InvalidOperatorComposition');
  }

  const document = parseText(IniProfile.PORTABLE_V1, '[s]\na=1\nb=2\n');
  const allEntries: QueryExpression = {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: newOperatorCall('ini.all-entries', 1),
  };
  assert.throws(
    () =>
      executeIniQuery(
        executable(allEntries),
        document,
        { maxSteps: 100, maxResults: 1 },
        new IniCancellationToken(),
      ),
    (failure: unknown) => {
      return (
        failure instanceof IniQueryExecutionFailure &&
        failure.kind === 'ResourceLimitExceeded' &&
        failure.code === 'core.query.resource-limit@1'
      );
    },
  );

  const cancellation = new IniCancellationToken();
  const cursor = executeIniQueryCursor(
    executable(allEntries),
    document,
    DEFAULT_INI_QUERY_LIMITS,
    cancellation,
  );
  assert.equal(cursor.next() !== null, true);
  cancellation.cancel();
  assert.equal(cursor.next(), null);
  assert.equal(cursor.terminalState(), 'Cancelled');
});

test('selection cardinality and core operators', () => {
  const document = parseText(IniProfile.PORTABLE_V1, '[s]\na=1\nb=2\n');
  const allEntries: QueryExpression = {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: newOperatorCall('ini.all-entries', 1),
  };
  const first = executeIniQuery(
    executable(allEntries, 'First'),
    document,
    DEFAULT_INI_QUERY_LIMITS,
    new IniCancellationToken(),
  );
  assert.equal(first.matches.length, 1);
  assert.throws(
    () =>
      executeIniQuery(
        executable(allEntries, 'RequireOne'),
        document,
        DEFAULT_INI_QUERY_LIMITS,
        new IniCancellationToken(),
      ),
    (failure: unknown) => {
      return (
        failure instanceof IniQueryExecutionFailure &&
        failure.kind === 'CardinalityViolation' &&
        failure.code === 'core.query.cardinality-violation@1'
      );
    },
  );

  const take: QueryExpression = {
    kind: 'Apply',
    input: { kind: 'Input' },
    operator: withArgument(newOperatorCall('core.take', 1), 'count', integerValue(1n)),
  };
  const taken = executeIniQuery(
    executable(take),
    document,
    DEFAULT_INI_QUERY_LIMITS,
    new IniCancellationToken(),
  );
  assert.equal(taken.matches.length, 1);
  assert.equal(taken.matches[0].kind, 'Document');
});
