// tools/check-fuses.mjs
//
// Verifies the Electron fuses of the PACKAGED apps (electron-builder applies
// them from electronFuses in apps/*/electron-builder.yml). A wrong fuse would
// silently re-open attack surface (e.g. ELECTRON_RUN_AS_NODE, --inspect), so
// CI fails when any fuse differs from the expected hardening.
//
//   node tools/check-fuses.mjs                    -> both release/<app>/win-unpacked/<App>.exe
//   node tools/check-fuses.mjs <exe> [<exe> ...]  -> specific binaries
//
// Exit code: 0 all fuses as expected, 1 mismatch / missing binary / read error.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCurrentFuseWire, FuseV1Options, FuseState } from '@electron/fuses';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Expected state of every fuse we set (must match electron-builder.yml). */
export const EXPECTED = Object.freeze({
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
});

const DEFAULT_TARGETS = [
  path.join(root, 'release', 'octobrowser', 'win-unpacked', 'Octo.su.exe'),
  path.join(root, 'release', 'octodetect', 'win-unpacked', 'OctoDetect.su.exe'),
];

/** Check one binary; returns a list of problems (empty = OK). */
export async function checkBinary(exe) {
  const problems = [];
  if (!fs.existsSync(exe)) return [`missing: ${exe}`];
  const wire = await getCurrentFuseWire(exe);
  for (const [key, want] of Object.entries(EXPECTED)) {
    const state = wire[key];
    const name = FuseV1Options[key];
    if (state === FuseState.REMOVED || state === undefined) { problems.push(`${name}: not present in this Electron build`); continue; }
    const on = state === FuseState.ENABLE;
    if (state !== FuseState.ENABLE && state !== FuseState.DISABLE) { problems.push(`${name}: unexpected state ${state}`); continue; }
    if (on !== want) problems.push(`${name}: ${on ? 'enabled' : 'disabled'}, expected ${want ? 'enabled' : 'disabled'}`);
  }
  // onlyLoadAppFromAsar only helps when there is no loose app folder next to app.asar.
  const resources = path.join(path.dirname(exe), 'resources');
  if (fs.existsSync(resources)) {
    if (!fs.existsSync(path.join(resources, 'app.asar'))) problems.push('resources/app.asar missing');
    if (fs.existsSync(path.join(resources, 'app'))) problems.push('resources/app folder present (app must be loaded from app.asar only)');
  }
  return problems;
}

async function main() {
  const targets = process.argv.slice(2).length ? process.argv.slice(2).map((p) => path.resolve(p)) : DEFAULT_TARGETS;
  let failed = false;
  for (const exe of targets) {
    const problems = await checkBinary(exe);
    if (problems.length) {
      failed = true;
      console.error(`FAIL ${exe}`);
      for (const p of problems) console.error(`  - ${p}`);
    } else {
      console.log(`OK   ${exe}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error('check-fuses:', err?.message ?? err); process.exit(1); });
}
