// tools_dump_cases.mjs — developer tool (not part of any gate): dumps every
// conformance vector case (suite file / capability / id / input / expected)
// grouped per file, for eyeballing the shared case set.
//
// Usage: node tools_dump_cases.mjs [vectors-dir]
//   vectors-dir: the conformance/vectors directory of the consema spec
//   repository. Default: ../../consema/conformance/vectors (the sibling
//   checkout in the six-repo layout, relative to this file in typescript/);
//   override with argv[2] or the CONSEMA_VECTORS_DIR environment variable.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const defaultDir = resolve(import.meta.dirname, '../../consema/conformance/vectors');
const dir = process.env.CONSEMA_VECTORS_DIR ?? process.argv[2] ?? defaultDir;
if (!existsSync(dir)) {
  console.error(
    `vectors dir not found: ${dir} (checkout the consema spec repository beside this one, ` +
      'or pass the path as argv[2] / CONSEMA_VECTORS_DIR)',
  );
  process.exit(2);
}
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
for (const f of files) {
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  console.log(`===== ${f} (${j.cases.length}) =====`);
  for (const c of j.cases) {
    const cap = c.capability ?? c.contract ?? '-';
    const input = JSON.stringify(c.input);
    const expected = JSON.stringify(c.expected);
    console.log(`[${cap}] ${c.id}\n  in: ${input}\n  ex: ${expected}`);
  }
}
