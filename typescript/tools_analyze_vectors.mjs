// tools_analyze_vectors.mjs — developer tool (not part of any gate): scans
// the shared conformance case set and lists every case whose capability is
// missing (an inventory hygiene check on the spec repository side).
//
// Usage: node tools_analyze_vectors.mjs [vectors-dir]
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
  for (const c of j.cases) {
    if (!c.capability) console.log(`${f}: ${c.id} — no capability; fields=${Object.keys(c).join(',')}`);
  }
}
