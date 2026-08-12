/**
 * The transferable atomic `core.change-set@1` record.
 *
 * authority: crates/consema-protocol/src/change.rs — SourceEditMessage
 * (:12-53), NodeMappingMessage (:55-122), ChangeSetMessage (:124-378); the
 * document-domain ChangeSet comes from document/change_set.ts. The Python
 * transcription (consema/conformance/protocol_records.py) is the
 * runner-side cross-reference.
 *
 * Design (TypeScript-idiomatic): plain records with validated static
 * factories; the record self-registers its full decoder with the envelope
 * payload dispatch (payload.rs:36-39).
 */

import type { ObjectValue, PortableValue } from '../core/value.ts';
import { stringValue, integerValue, bytesValue, nullValue } from '../core/value.ts';
import {
  exactFields,
  schemaFields,
  stringOf,
  sequenceOf,
  unsigned64,
  objectValueFrom,
} from './records.ts';
import { invalid, protocolError } from './errors.ts';
import { ErrorCodeRegistry } from './error_registry.ts';
import { registerPayloadValidator } from './payload_validators.ts';
import type { Diagnostic, SourceLocation } from './diagnostic.ts';
import {
  processLocalError,
  newDiagnostic,
  diagnosticFromValue,
  diagnosticToValue,
} from './diagnostic.ts';
import type { Diagnostic as DocumentDiagnostic, DiagnosticLocation as DocumentLocation } from '../document/diagnostic.ts';
import type { ChangeSet } from '../document/change_set.ts';
import type { NodeMappingStatus } from '../document/change_set.ts';
import type { NodeRef } from '../document/identity.ts';

/** One ordered source replacement in wire coordinates (change.rs:12-25). */
export class SourceEditMessage {
  readonly oldStart: bigint;
  readonly oldEnd: bigint;
  readonly newStart: bigint;
  readonly newEnd: bigint;
  readonly replacement: Uint8Array;

  private constructor(
    oldStart: bigint,
    oldEnd: bigint,
    newStart: bigint,
    newEnd: bigint,
    replacement: Uint8Array,
  ) {
    this.oldStart = oldStart;
    this.oldEnd = oldEnd;
    this.newStart = newStart;
    this.newEnd = newEnd;
    this.replacement = Uint8Array.from(replacement);
  }

  /** Validates range order and replacement/new-range agreement (change.rs:26-52). */
  static new(
    oldStart: bigint,
    oldEnd: bigint,
    newStart: bigint,
    newEnd: bigint,
    replacement: Uint8Array,
  ): SourceEditMessage {
    const replacementLength = BigInt(replacement.length);
    if (oldStart > oldEnd || newStart > newEnd || newEnd - newStart !== replacementLength) {
      throw invalid('$.source_edit', 'invalid ranges or replacement length');
    }
    return new SourceEditMessage(oldStart, oldEnd, newStart, newEnd, replacement);
  }

  /** Encodes one source edit (change.rs:380-391). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'old_start', value: integerValue(this.oldStart) },
      { key: 'old_end', value: integerValue(this.oldEnd) },
      { key: 'new_start', value: integerValue(this.newStart) },
      { key: 'new_end', value: integerValue(this.newEnd) },
      { key: 'replacement', value: bytesValue(this.replacement) },
    ]);
  }

  /** Strictly decodes one source edit (change.rs:393-422). */
  static fromValue(value: PortableValue, path: string): SourceEditMessage {
    const fields = exactFields(
      value,
      ['old_start', 'old_end', 'new_start', 'new_end', 'replacement'],
      path,
    );
    if (fields[4].kind !== 'Bytes') {
      throw protocolError('WrongType', `${path}.replacement`, 'expected Bytes');
    }
    return SourceEditMessage.new(
      unsigned64(fields[0], `${path}.old_start`),
      unsigned64(fields[1], `${path}.old_end`),
      unsigned64(fields[2], `${path}.new_start`),
      unsigned64(fields[3], `${path}.new_end`),
      fields[4].value,
    );
  }
}

/** One portable node-mapping fact using caller-defined stable locators (change.rs:55-65). */
export class NodeMappingMessage {
  readonly oldLocators: readonly string[];
  readonly newLocators: readonly string[];
  readonly status: NodeMappingStatus;
  readonly reason: string | null;

  private constructor(
    oldLocators: readonly string[],
    newLocators: readonly string[],
    status: NodeMappingStatus,
    reason: string | null,
  ) {
    this.oldLocators = Object.freeze([...oldLocators]);
    this.newLocators = Object.freeze([...newLocators]);
    this.status = status;
    this.reason = reason;
  }

  /** Validates locator topology against mapping status (change.rs:66-121). */
  static new(
    oldLocators: readonly string[],
    newLocators: readonly string[],
    status: NodeMappingStatus,
    reason: string | null,
  ): NodeMappingMessage {
    if (
      !uniqueLocators(oldLocators) ||
      !uniqueLocators(newLocators) ||
      [...oldLocators, ...newLocators].some((locator) => locator === '' || locator.length > 4096)
    ) {
      throw invalid('$.node_mapping', 'locators must be non-empty, bounded, and unique per side');
    }
    let topology = false;
    let needsReason = false;
    switch (status) {
      case 'Preserved':
        topology = oldLocators.length === 1 && newLocators.length === 1;
        break;
      case 'Replaced':
        topology = oldLocators.length === 1 && newLocators.length <= 1;
        needsReason = newLocators.length === 0;
        break;
      case 'Deleted':
        topology = oldLocators.length === 1 && newLocators.length === 0;
        needsReason = true;
        break;
      case 'Split':
        topology = oldLocators.length === 1 && newLocators.length >= 2;
        needsReason = true;
        break;
      case 'Merged':
        topology = oldLocators.length >= 2 && newLocators.length === 1;
        needsReason = true;
        break;
      case 'Unmapped':
        topology = oldLocators.length > 0 && newLocators.length === 0;
        needsReason = true;
        break;
    }
    const hasReason = reason !== null && reason !== '' && reason.length <= 1024;
    if (!topology || needsReason !== hasReason) {
      throw invalid('$.node_mapping', 'mapping topology or reason contradicts status');
    }
    return new NodeMappingMessage(oldLocators, newLocators, status, reason);
  }

  /** Encodes one node-mapping fact (change.rs:424-442). */
  toValue(): ObjectValue {
    return objectValueFrom([
      {
        key: 'old_locators',
        value: { kind: 'Sequence', items: this.oldLocators.map((locator) => stringValue(locator)) },
      },
      {
        key: 'new_locators',
        value: { kind: 'Sequence', items: this.newLocators.map((locator) => stringValue(locator)) },
      },
      { key: 'status', value: stringValue(this.status) },
      { key: 'reason', value: this.reason === null ? nullValue() : stringValue(this.reason) },
    ]);
  }

  /** Strictly decodes one node-mapping fact (change.rs:444-461). */
  static fromValue(value: PortableValue, path: string): NodeMappingMessage {
    const fields = exactFields(value, ['old_locators', 'new_locators', 'status', 'reason'], path);
    return NodeMappingMessage.new(
      parseLocators(fields[0], `${path}.old_locators`),
      parseLocators(fields[1], `${path}.new_locators`),
      parseMappingStatus(stringOf(fields[2], `${path}.status`), `${path}.status`),
      fields[3].kind === 'Null' ? null : stringOf(fields[3], `${path}.reason`),
    );
  }
}

/** The complete `core.change-set@1` record with external source and node identities (change.rs:124-132). */
export class ChangeSetMessage {
  readonly oldSourceId: string;
  readonly newSourceId: string;
  readonly sourceEdits: readonly SourceEditMessage[];
  readonly nodeMappings: readonly NodeMappingMessage[];
  readonly diagnostics: readonly Diagnostic[];

  private constructor(
    oldSourceId: string,
    newSourceId: string,
    sourceEdits: readonly SourceEditMessage[],
    nodeMappings: readonly NodeMappingMessage[],
    diagnostics: readonly Diagnostic[],
  ) {
    this.oldSourceId = oldSourceId;
    this.newSourceId = newSourceId;
    this.sourceEdits = Object.freeze([...sourceEdits]);
    this.nodeMappings = Object.freeze([...nodeMappings]);
    this.diagnostics = Object.freeze([...diagnostics]);
  }

  /** Validates source identities, edit order, and global old-locator uniqueness (change.rs:134-181). */
  static new(
    oldSourceId: string,
    newSourceId: string,
    sourceEdits: readonly SourceEditMessage[],
    nodeMappings: readonly NodeMappingMessage[],
    diagnostics: readonly Diagnostic[],
  ): ChangeSetMessage {
    if (
      oldSourceId === '' ||
      newSourceId === '' ||
      oldSourceId.length > 1024 ||
      newSourceId.length > 1024
    ) {
      throw invalid('$', 'source IDs must be non-empty and bounded');
    }
    for (let index = 1; index < sourceEdits.length; index++) {
      if (
        sourceEdits[index - 1].oldEnd > sourceEdits[index].oldStart ||
        sourceEdits[index - 1].newEnd > sourceEdits[index].newStart
      ) {
        throw invalid('$.source_edits', 'edits must be ordered and non-overlapping in both snapshots');
      }
    }
    const seen = new Set<string>();
    for (const mapping of nodeMappings) {
      for (const locator of mapping.oldLocators) {
        if (seen.has(locator)) {
          throw invalid('$.node_mappings', 'an old locator may participate in only one mapping fact');
        }
        seen.add(locator);
      }
    }
    return new ChangeSetMessage(oldSourceId, newSourceId, sourceEdits, nodeMappings, diagnostics);
  }

  /** Externalizes an in-process ChangeSet through explicit source IDs and node binding (change.rs:183-198). */
  static fromDocument(
    changeSet: ChangeSet,
    oldSourceId: string,
    newSourceId: string,
    locator: (node: NodeRef) => string | null,
  ): ChangeSetMessage {
    return ChangeSetMessage.fromDocumentWithRegistry(
      changeSet,
      oldSourceId,
      newSourceId,
      locator,
      new ErrorCodeRegistry(1),
    );
  }

  /** Externalizes a ChangeSet under one explicit semantic-model registry (change.rs:200-268). */
  static fromDocumentWithRegistry(
    changeSet: ChangeSet,
    oldSourceId: string,
    newSourceId: string,
    locator: (node: NodeRef) => string | null,
    registry: ErrorCodeRegistry,
  ): ChangeSetMessage {
    const sourceEdits = changeSet.sourceEdits().map((edit) =>
      SourceEditMessage.new(
        BigInt(edit.oldSpan().startByte()),
        BigInt(edit.oldSpan().endByte()),
        BigInt(edit.newSpan().startByte()),
        BigInt(edit.newSpan().endByte()),
        edit.replacement(),
      ),
    );
    const nodeMappings = changeSet.nodeMappings().map((mapping) => {
      const old = locator(mapping.old());
      if (old === null) {
        throw processLocalError('$.node_mappings.old');
      }
      let newLocators: string[] = [];
      if (mapping.new() !== null) {
        const next = locator(mapping.new()!);
        if (next === null) {
          throw processLocalError('$.node_mappings.new');
        }
        newLocators = [next];
      }
      return NodeMappingMessage.new([old], newLocators, mapping.status(), mapping.reason());
    });
    const diagnostics = changeSet.diagnostics().map((diagnostic) =>
      fromCoreDiagnostic(diagnostic, newSourceId, registry),
    );
    return ChangeSetMessage.new(oldSourceId, newSourceId, sourceEdits, nodeMappings, diagnostics);
  }

  /** Encodes `core.change-set@1` (change.rs:301-329). */
  toValue(): ObjectValue {
    return objectValueFrom([
      { key: 'schema', value: stringValue('core.change-set@1') },
      { key: 'old_source_id', value: stringValue(this.oldSourceId) },
      { key: 'new_source_id', value: stringValue(this.newSourceId) },
      {
        key: 'source_edits',
        value: { kind: 'Sequence', items: this.sourceEdits.map((edit) => edit.toValue()) },
      },
      {
        key: 'node_mappings',
        value: { kind: 'Sequence', items: this.nodeMappings.map((mapping) => mapping.toValue()) },
      },
      {
        key: 'diagnostics',
        value: { kind: 'Sequence', items: this.diagnostics.map((diagnostic) => diagnosticToValueOf(diagnostic)) },
      },
    ]);
  }

  /** Strictly decodes `core.change-set@1` under the v1 registry (change.rs:331-334). */
  static fromValue(value: PortableValue): ChangeSetMessage {
    return ChangeSetMessage.fromValueWithRegistry(value, new ErrorCodeRegistry(1));
  }

  /** Strictly decodes diagnostics under one explicit semantic-model registry (change.rs:337-377). */
  static fromValueWithRegistry(value: PortableValue, registry: ErrorCodeRegistry): ChangeSetMessage {
    const fields = schemaFields(
      value,
      'core.change-set@1',
      ['old_source_id', 'new_source_id', 'source_edits', 'node_mappings', 'diagnostics'],
      '$',
    );
    const sourceEdits = sequenceOf(fields[2], '$.source_edits').map((item, index) =>
      SourceEditMessage.fromValue(item, `$.source_edits[${index}]`),
    );
    const nodeMappings = sequenceOf(fields[3], '$.node_mappings').map((item, index) =>
      NodeMappingMessage.fromValue(item, `$.node_mappings[${index}]`),
    );
    const diagnostics = sequenceOf(fields[4], '$.diagnostics').map((item) =>
      diagnosticFromValue(item, registry),
    );
    return ChangeSetMessage.new(
      stringOf(fields[0], '$.old_source_id'),
      stringOf(fields[1], '$.new_source_id'),
      sourceEdits,
      nodeMappings,
      diagnostics,
    );
  }
}

/** Strictly reads a locator sequence (change.rs:463-469). */
function parseLocators(value: PortableValue, path: string): string[] {
  return sequenceOf(value, path).map((item, index) => stringOf(item, `${path}[${index}]`));
}

/** Parses one node-mapping status spelling (change.rs:482-495). */
function parseMappingStatus(text: string, path: string): NodeMappingStatus {
  switch (text) {
    case 'Preserved':
    case 'Replaced':
    case 'Deleted':
    case 'Split':
    case 'Merged':
    case 'Unmapped':
      return text;
    default:
      throw invalid(path, 'unknown node mapping status');
  }
}

function uniqueLocators(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/** Externalizes one document-domain diagnostic to the wire record (diagnostic.rs:130-163). */
function fromCoreDiagnostic(
  diagnostic: DocumentDiagnostic,
  sourceId: string,
  registry: ErrorCodeRegistry,
): Diagnostic {
  const bindLocation = (location: DocumentLocation): SourceLocation => ({
    sourceId,
    startByte: location.startByte,
    endByte: location.endByte,
  });
  const primary = diagnostic.primary === null ? undefined : bindLocation(diagnostic.primary);
  const related = diagnostic.related.map((item) => ({
    role: item.role,
    location: bindLocation(item.location),
  }));
  return newDiagnostic(
    diagnostic.code,
    diagnostic.category,
    diagnostic.severity,
    primary,
    related,
    diagnostic.arguments,
    diagnostic.notes,
    [],
    diagnostic.occurrence,
    registry,
  );
}

/** Encodes one protocol diagnostic in the diagnostics sequence (diagnostic.ts:135-165). */
function diagnosticToValueOf(diagnostic: Diagnostic): PortableValue {
  return diagnosticToValue(diagnostic);
}

// Envelope payload dispatch (payload.rs:36-39): every change-set payload
// validates through the strict decoder at module load.
registerPayloadValidator('core.change-set', 1, (payload, registry) => {
  ChangeSetMessage.fromValueWithRegistry(payload, new ErrorCodeRegistry(registry.versionOf()));
});
