// tools/build-icons.mjs
//
// Renders the SVG logos in branding/ to PNG (16, 32, 48, 128, 256 px) and a
// multi-resolution Windows .ico for each app plus the suite installer.
// Uses @resvg/resvg-js (pure WASM/native renderer, no browser needed) and
// png-to-ico. Small sizes (<=32 px) use the simplified *-small.svg variant
// when present, so the icon stays legible in the taskbar.
//
// Usage: npm run icons
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 128, 256];
const SETS = [
  { dir: 'octobrowser', main: 'logo.svg', small: 'logo-small.svg', ico: 'icon.ico' },
  { dir: 'octodetect', main: 'logo.svg', small: 'logo-small.svg', ico: 'icon.ico' },
  { dir: 'suite', main: 'installer.svg', small: 'installer-small.svg', ico: 'installer.ico' },
  // Native engine marks: stage.mjs embeds the Chromium mark in inkbrowser-chrome.exe;
  // the Firefox mark is retained for the Gecko runtime and installer/UI surfaces.
  { dir: 'inkbrowser-chrome', main: 'logo.svg', small: 'logo.svg', ico: 'icon.ico' },
  { dir: 'inkbrowser-firefox', main: 'logo.svg', small: 'logo.svg', ico: 'icon.ico' },
  { dir: 'inkbrowser', main: 'logo.svg', small: 'logo.svg', ico: 'icon.ico' },
];

function render(svgFile, size) {
  const svg = fs.readFileSync(svgFile, 'utf8');
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' });
  return r.render().asPng();
}

async function main() {
  // `node tools/build-icons.mjs inkbrowser` rebuilds one set and leaves the others alone.
  const only = process.argv[2];
  for (const set of SETS) {
    if (only && set.dir !== only) continue;
    const base = path.join(root, 'branding', set.dir);
    const outDir = path.join(base, 'png');
    fs.mkdirSync(outDir, { recursive: true });
    const pngs = [];
    for (const size of SIZES) {
      const smallFile = path.join(base, set.small);
      const src = size <= 32 && fs.existsSync(smallFile) ? smallFile : path.join(base, set.main);
      const png = render(src, size);
      const out = path.join(outDir, `icon-${size}.png`);
      fs.writeFileSync(out, png);
      pngs.push(png);
    }
    const ico = await pngToIco(pngs);
    fs.writeFileSync(path.join(base, set.ico), ico);
    console.log(`icons: ${set.dir} -> ${SIZES.join('/')} px + ${set.ico}`);
  }
}

main().catch((err) => {
  console.error('build-icons failed:', err);
  process.exit(1);
});
