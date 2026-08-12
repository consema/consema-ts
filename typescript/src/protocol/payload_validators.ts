/**
 * Full validation dispatch for registered protocol payloads.
 *
 * authority: crates/consema-protocol/src/payload.rs — the envelope validates
 * every registered payload through its record decoder (unknown-field,
 * missing-field, type, and record-invariant rejections happen here, not in
 * the envelope itself). Each record module self-registers its decoder at
 * module load; `contract.ts` invokes the dispatch after the schema
 * discriminator check.
 */

import type { PortableValue } from '../core/value.ts';
import type { ContractId } from './contract.ts';
import type { ContractRegistry } from './contract.ts';
import { protocolError } from './errors.ts';

/** One full record decoder for the payload dispatch. */
export type PayloadValidator = (payload: PortableValue, registry: ContractRegistry) => void;

const validators = new Map<string, PayloadValidator>();

/** Registers the full decoder of one exact `id@version` contract. */
export function registerPayloadValidator(
  id: string,
  version: number,
  validator: PayloadValidator,
): void {
  const key = `${id}@${version}`;
  if (validators.has(key)) {
    throw new Error(`internal: duplicate payload validator ${key}`);
  }
  validators.set(key, validator);
}

/**
 * Runs the registered full decoder of one payload contract, or rejects an
 * unregistered contract exactly like the Rust catch-all (payload.rs:177-181).
 */
export function validateRegisteredPayload(
  contract: ContractId,
  payload: PortableValue,
  registry: ContractRegistry,
): void {
  const validator = validators.get(`${contract.id}@${contract.version}`);
  if (validator === undefined) {
    throw protocolError('UnknownContract', '$.contract', `${contract.id}@${contract.version}`);
  }
  validator(payload, registry);
}
