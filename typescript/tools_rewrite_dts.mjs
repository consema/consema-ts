// tools_rewrite_dts.mjs — post-build step of tsconfig.build.json (R43,
// 2026-08-15): tsc emits .d.ts files whose relative import/export
// specifiers keep the source `.ts` extension (`export * from
// './core/value.ts'`), because `rewriteRelativeImportExtensions` only
// rewrites the JS emit. The published package ships dist/ only (files =
// ["dist", "LICENSE"], no .ts sources), so a specifier pointing at
// './core/value.ts' names a file that does not exist in the tarball —
// consumers only resolve it through TS's extension-stripping fallback
// ('.ts' -> '.d.ts').
//
// This step rewrites every relative specifier ending in `.ts` to `.js`
// (the ESM convention — TS maps './x.js' to './x.d.ts' natively), so the
// shipped .d.ts files reference files that actually exist. Only relative
// specifiers (./ and ../) are touched: node: builtin imports and any
// future bare specifier are left alone (the src import-surface gate
// forbids bare specifiers anyway).
//
// Runs from the build script (package.json): `npm run build` =
// clean + tsc + this rewrite. Deterministic — a fresh checkout builds
// the same dist/ as CI. The summary goes to stderr (console.error): it
// must never pollute stdout — `npm pack --json` (CI ts-package job,
// release.yml clean-install smoke) parses stdout as pure JSON, and a
// stdout side line would break the parse (wave-4 R43 rehearsal finding,
// 2026-08-15).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = fileURLToPath(new URL('./dist', import.meta.url));

/** A quoted relative specifier ending in `.ts` (import/export/require positions). */
const RELATIVE_TS_SPECIFIER = /(['"])(\.\.?\/[^'"]+)\.ts\1/g;

function walkDts(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDts(path));
    } else if (entry.name.endsWith('.d.ts')) {
      files.push(path);
    }
  }
  return files;
}

const dtsFiles = walkDts(distDir);
let rewrittenFiles = 0;
let rewrittenSpecifiers = 0;
for (const file of dtsFiles) {
  const original = readFileSync(file, 'utf8');
  const rewritten = original.replace(RELATIVE_TS_SPECIFIER, (_all, quote, spec) => {
    rewrittenSpecifiers++;
    return `${quote}${spec}.js${quote}`;
  });
  if (rewritten !== original) {
    writeFileSync(file, rewritten, 'utf8');
    rewrittenFiles++;
  }
}
console.error(
  `rewrite-dts: ${rewrittenSpecifiers} relative .ts specifiers rewritten to .js across ${rewrittenFiles}/${dtsFiles.length} .d.ts files (dist/)`,
);
