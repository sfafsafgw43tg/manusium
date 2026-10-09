// tools/lib/load-core.mjs
//
// Loads TypeScript modules from packages/core/src inside Node build tools by
// bundling them on the fly with esbuild (in memory) - so tools reuse exactly
// the same validation/crypto code as the apps instead of duplicating it.
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Bundle `packages/core/src/<name>.ts` and return its exports.
 * @param {string} name module file name without extension, e.g. "updater"
 */
export async function loadCore(name) {
  const entry = path.join(root, 'packages', 'core', 'src', `${name}.ts`);
  const out = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'silent',
    tsconfig: path.join(root, 'tsconfig.json'),
  });
  const code = out.outputFiles[0].text;
  const mod = { exports: {} };
  const req = createRequire(entry);
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', '__filename', '__dirname', code)(mod, mod.exports, req, entry, path.dirname(entry));
  return mod.exports;
}

/** Read the root package.json version (single source of truth for the suite version). */
export async function suiteVersion() {
  const fs = await import('node:fs');
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}
