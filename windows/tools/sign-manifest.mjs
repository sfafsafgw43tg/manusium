// tools/sign-manifest.mjs
//
// Creates and signs the update manifest for a release:
//   release/latest.json      manifest (both apps point at the same suite installer)
//   release/latest.json.sig  base64 Ed25519 signature over the exact bytes of latest.json
//
// Usage:
//   npm run sign-manifest -- --severity recommended --notes-en "Fixes…" --notes-pl "Poprawki…"
//   npm run sign-manifest -- --notes release-notes.json   ({"en": "...", "pl": "..."})
// Options:
//   --severity security|recommended|optional   (default: recommended)
//   --components app,engine,filters             (default: app)
//   --channel stable|beta                       (default: stable)
//   --file <path>                               (default: release/OctoSuite-Setup-<version>.exe)
//   --no-restart                                (requiresRestart = false)
// Environment:
//   OCTO_UPDATE_PRIVATE_KEY   path to the private key (default keys/update-private-key.pem)
//   OCTO_KEY_PASSPHRASE       passphrase when the key is encrypted
//
// Before writing, the manifest is validated and verified with the SAME code the
// apps use (packages/core/src/updater.ts) and the public key compiled into them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadCore, root, suiteVersion } from './lib/load-core.mjs';

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

async function main() {
  const version = await suiteVersion();
  const updater = await loadCore('updater');
  const { OFFICIAL_RELEASES_BASE } = await loadCore('appinfo');
  const { UPDATE_PUBLIC_KEY_PEM } = await loadCore('update-public-key');
  if (!UPDATE_PUBLIC_KEY_PEM) throw new Error('No public key compiled in. Run "npm run keygen" and rebuild first.');

  const severity = arg('severity', 'recommended');
  const channel = arg('channel', 'stable');
  const components = arg('components', 'app').split(',').map((s) => s.trim()).filter(Boolean);
  let notes = { en: arg('notes-en', ''), pl: arg('notes-pl', '') };
  const notesFile = arg('notes');
  if (notesFile) notes = JSON.parse(fs.readFileSync(path.resolve(notesFile), 'utf8'));
  if (!notes.en || !notes.pl) throw new Error('Release notes in both languages are required (--notes-en/--notes-pl or --notes file.json).');

  const file = path.resolve(arg('file', path.join(root, 'release', `OctoSuite-Setup-${version}.exe`)));
  if (!fs.existsSync(file)) throw new Error(`Installer not found: ${file} (run "npm run installer" first)`);
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  const sha256 = await sha256File(file);
  const url = `${OFFICIAL_RELEASES_BASE}/download/v${version}/${name}`;

  const release = {
    version,
    severity,
    changelog: { en: String(notes.en), pl: String(notes.pl) },
    components,
    requiresRestart: !process.argv.includes('--no-restart'),
    files: [{ platform: 'win32', arch: 'x64', name, url, sha256, size }],
  };
  const manifest = {
    schema: 1,
    channel,
    publishedAt: new Date().toISOString(),
    apps: { octobrowser: release, octodetect: release },
  };
  updater.validateManifest(manifest);

  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const keyFile = path.resolve(process.env.OCTO_UPDATE_PRIVATE_KEY || path.join(root, 'keys', 'update-private-key.pem'));
  if (!fs.existsSync(keyFile)) throw new Error(`Private key not found: ${keyFile}`);
  const privateKey = crypto.createPrivateKey({ key: fs.readFileSync(keyFile), format: 'pem', passphrase: process.env.OCTO_KEY_PASSPHRASE });
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The private key is not Ed25519.');
  const sig = crypto.sign(null, bytes, privateKey).toString('base64');

  // Verify exactly like the apps will (fails if the key pair does not match the compiled public key).
  updater.verifyAndParseManifest(bytes, sig, UPDATE_PUBLIC_KEY_PEM);

  const outDir = path.dirname(file);
  fs.writeFileSync(path.join(outDir, 'latest.json'), bytes);
  fs.writeFileSync(path.join(outDir, 'latest.json.sig'), `${sig}\n`);
  console.log(`Signed manifest for v${version} (${severity}, ${channel})`);
  console.log(`  ${name}  ${sha256}  ${size} B`);
  console.log(`  -> ${path.relative(root, path.join(outDir, 'latest.json'))} + .sig`);
  console.log(`Upload ${name}, latest.json and latest.json.sig to the GitHub release tagged v${version}.`);
}

main().catch((err) => {
  console.error('sign-manifest failed:', err?.message ?? err);
  process.exit(1);
});
