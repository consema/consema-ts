import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = 'C:/Users/franck/Documents/consema/conformance/vectors';
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
