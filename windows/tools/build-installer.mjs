// tools/build-installer.mjs
//
// Builds the OctoSuite installer (both apps) with Inno Setup 6 on Windows:
//   release/OctoSuite-Setup-<version>.exe
//
// Prerequisites: `npm run dist` (produces release/octobrowser/win-unpacked and
// release/octodetect/win-unpacked) and Inno Setup 6 (https://jrsoftware.org/isinfo.php,
// official site only). ISCC.exe is looked up in the default install folders or
// taken from the ISCC environment variable.
//
// Code signing (optional): set OCTO_SIGNTOOL to a full signtool command, e.g.
//   signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /a $f
// It is passed to Inno Setup as the "octosign" sign tool.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, suiteVersion } from './lib/load-core.mjs';

function findIscc() {
  const cands = [
    process.env.ISCC,
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  ].filter(Boolean);
  return cands.find((c) => fs.existsSync(c));
}

async function main() {
  if (process.platform !== 'win32') throw new Error('The installer can only be built on Windows (Inno Setup).');
  const version = await suiteVersion();
  for (const app of ['octobrowser', 'octodetect']) {
    const dir = path.join(root, 'release', app, 'win-unpacked');
    if (!fs.existsSync(dir)) throw new Error(`Missing ${path.relative(root, dir)} - run "npm run dist" first.`);
  }
  const iscc = findIscc();
  if (!iscc) throw new Error('ISCC.exe (Inno Setup 6) not found. Install it from https://jrsoftware.org or set ISCC.');
  const script = path.join(root, 'installer', 'octosuite.iss');
  const args = [`/DAppVersion=${version}`, `/DRepoRoot=${root}`, '/Qp'];
  if (process.env.OCTO_SIGNTOOL) args.push(`/Soctosign=${process.env.OCTO_SIGNTOOL}`, '/DSign=1');
  args.push(script);
  console.log(`Building installer v${version} with ${iscc}`);
  const r = spawnSync(iscc, args, { stdio: 'inherit', windowsHide: true });
  if (r.status !== 0) throw new Error(`ISCC failed with exit code ${r.status}`);
  const out = path.join(root, 'release', `OctoSuite-Setup-${version}.exe`);
  if (!fs.existsSync(out)) throw new Error(`Expected output not found: ${out}`);
  console.log(`-> ${path.relative(root, out)}`);
}

main().catch((err) => {
  console.error('build-installer failed:', err?.message ?? err);
  process.exit(1);
});
