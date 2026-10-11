// tools/hash-files.mjs
//
// Writes SHA-256 checksums of release artifacts, or verifies them.
//
//   node tools/hash-files.mjs                  -> release/SHA256SUMS.txt for release/*.exe|zip|json|sig
//   node tools/hash-files.mjs --verify         -> verify release/SHA256SUMS.txt
//   node tools/hash-files.mjs <dir> [--verify] -> other directory
//
// Format is compatible with `sha256sum -c` and with scripts/lib/octo.ps1:
//   <64 hex>  <file name>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { root } from './lib/load-core.mjs';

const args = process.argv.slice(2);
const verify = args.includes('--verify');
const dir = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(root, 'release'));
const sumsFile = path.join(dir, 'SHA256SUMS.txt');
const EXT = /\.(exe|zip|json|sig|7z|msi)$/i;

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

async function main() {
  if (!fs.existsSync(dir)) throw new Error(`Directory not found: ${dir}`);
  if (verify) {
    const lines = fs.readFileSync(sumsFile, 'utf8').split(/\r?\n/).filter(Boolean);
    let bad = 0;
    for (const line of lines) {
      const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
      if (!m) { console.error(`malformed line: ${line}`); bad++; continue; }
      const f = path.join(dir, m[2]);
      if (path.dirname(path.resolve(f)) !== dir) { console.error(`refusing path outside dir: ${m[2]}`); bad++; continue; }
      if (!fs.existsSync(f)) { console.error(`MISSING  ${m[2]}`); bad++; continue; }
      const got = await sha256File(f);
      if (got === m[1]) console.log(`OK       ${m[2]}`);
      else { console.error(`MISMATCH ${m[2]}`); bad++; }
    }
    if (bad) throw new Error(`${bad} problem(s) found`);
    console.log('All checksums match.');
    return;
  }
  const files = fs.readdirSync(dir).filter((f) => EXT.test(f) && fs.statSync(path.join(dir, f)).isFile()).sort();
  if (!files.length) throw new Error(`No release files in ${dir}`);
  const out = [];
  for (const f of files) {
    const h = await sha256File(path.join(dir, f));
    out.push(`${h}  ${f}`);
    console.log(`${h}  ${f}`);
  }
  fs.writeFileSync(sumsFile, `${out.join('\n')}\n`);
  console.log(`-> ${path.relative(root, sumsFile)}`);
}

main().catch((err) => {
  console.error('hash-files:', err?.message ?? err);
  process.exit(1);
});
