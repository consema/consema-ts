/**
 * Envelope payload dispatch for the semantic-model v7 CLI records
 * (payload.rs:27-43): core.batch-plan@1, core.batch-result@1, core.cli-output@1.
 * The decoders live in `cli.ts`; this module registers them with the shared
 * payload dispatch so the common envelope validates them fully.
 */

import { batchPlanFromValue, batchResultFromValue, cliOutputFromValue } from './cli.ts';
import { ErrorCodeRegistry } from './error_registry.ts';
import { registerPayloadValidator } from './payload_validators.ts';

registerPayloadValidator('core.batch-plan', 1, (payload, registry) => {
  batchPlanFromValue(payload, new ErrorCodeRegistry(registry.versionOf()));
});

registerPayloadValidator('core.batch-result', 1, (payload) => {
  batchResultFromValue(payload);
});

registerPayloadValidator('core.cli-output', 1, (payload, registry) => {
  cliOutputFromValue(payload, new ErrorCodeRegistry(registry.versionOf()));
});
