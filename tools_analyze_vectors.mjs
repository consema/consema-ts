import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'C:/Users/franck/Documents/consema/conformance/vectors';
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
for (const f of files) {
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  for (const c of j.cases) {
    if (!c.capability) console.log(`${f}: ${c.id} — no capability; fields=${Object.keys(c).join(',')}`);
  }
}
