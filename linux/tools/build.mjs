// tools/build.mjs
//
// Bundles Octo.su and/or OctoDetect.su into apps/<app>/dist with esbuild.
//
//   node tools/build.mjs              -> both apps
//   node tools/build.mjs octobrowser  -> one app
//   node tools/build.mjs --dev        -> with inline source maps, no minification
//
// Output layout (apps/<app>/dist):
//   main.js                      main process (CommonJS, electron external)
//   preload-*.js                 sandboxed preloads (CommonJS, electron external)
//   renderer/*.html|css|js       trusted app UI
//   shared/*.html|css|js         first-run wizard, splash
//   internal/*                   octo:// pages (OctoBrowser)
//   probe/*                      local audit page (OctoDetect)
//   assets/                      logo.svg, icon.ico, icon-*.png, baseline-filters.txt
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dev = args.includes('--dev');
const only = args.filter((a) => !a.startsWith('--'));
const apps = only.length ? only : ['octobrowser', 'octodetect'];
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = rootPkg.version;

for (const a of apps) {
  if (!['octobrowser', 'octodetect'].includes(a)) {
    console.error(`Unknown app "${a}" (expected octobrowser or octodetect)`);
    process.exit(2);
  }
}

const common = {
  bundle: true,
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'external',
  tsconfig: path.join(root, 'tsconfig.json'),
  define: { __OCTO_VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
};

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyByExt(srcDir, destDir, exts) {
  if (!fs.existsSync(srcDir)) return;
  for (const f of fs.readdirSync(srcDir)) {
    if (exts.includes(path.extname(f))) copy(path.join(srcDir, f), path.join(destDir, f));
  }
}

/** Keep apps/<app>/package.json version in sync with the root version (app.getVersion()). */
function syncVersion(app) {
  const file = path.join(root, 'apps', app, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pkg.version !== version) {
    pkg.version = version;
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

async function node(entry, outfile) {
  await esbuild.build({ ...common, entryPoints: [entry], outfile, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'] });
}
async function preload(entry, outfile) {
  // Sandboxed preloads may only require('electron') - everything else is bundled.
  await esbuild.build({ ...common, entryPoints: [entry], outfile, platform: 'browser', format: 'cjs', target: 'chrome140', external: ['electron'] });
}
async function web(entry, outfile) {
  await esbuild.build({ ...common, entryPoints: [entry], outfile, platform: 'browser', format: 'iife', target: 'chrome140' });
}

async function buildShared(dist) {
  const src = path.join(root, 'packages', 'shell', 'renderer');
  const out = path.join(dist, 'shared');
  for (const page of ['firstrun', 'splash', 'unlock']) await web(path.join(src, `${page}.ts`), path.join(out, `${page}.js`));
  copyByExt(src, out, ['.html', '.css']);
  await preload(path.join(root, 'packages', 'shell', 'src', 'preload-setup.ts'), path.join(dist, 'preload-setup.js'));
}

function buildAssets(app, dist) {
  const b = path.join(root, 'branding', app);
  const out = path.join(dist, 'assets');
  if (!fs.existsSync(path.join(b, 'icon.ico'))) {
    throw new Error(`Missing branding/${app}/icon.ico - run "npm run icons" first.`);
  }
  copy(path.join(b, 'logo.svg'), path.join(out, 'logo.svg'));
  copy(path.join(b, 'icon.ico'), path.join(out, 'icon.ico'));
  for (const s of [16, 32, 48, 128, 256]) copy(path.join(b, 'png', `icon-${s}.png`), path.join(out, `icon-${s}.png`));
  if (app === 'octobrowser') {
    copy(path.join(b, 'png', 'profile-running-256.png'), path.join(out, 'profile-running.png'));
    copy(path.join(root, 'resources', 'filters', 'baseline-filters.txt'), path.join(out, 'baseline-filters.txt'));
  }
}

async function buildApp(app) {
  const started = Date.now();
  const appDir = path.join(root, 'apps', app);
  const src = path.join(appDir, 'src');
  const dist = path.join(appDir, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  syncVersion(app);

  await node(path.join(src, 'main', 'main.ts'), path.join(dist, 'main.js'));
  await buildShared(dist);

  if (app === 'octobrowser') {
    await preload(path.join(src, 'preload', 'chrome.ts'), path.join(dist, 'preload-chrome.js'));
    await preload(path.join(src, 'preload', 'tab.ts'), path.join(dist, 'preload-tab.js'));
    await preload(path.join(src, 'preload', 'launcher.ts'), path.join(dist, 'preload-launcher.js'));
    await web(path.join(src, 'renderer', 'browser.ts'), path.join(dist, 'renderer', 'browser.js'));
    // The floating save-login card is its own window and its own bundle.
    await web(path.join(src, 'renderer', 'save-card.ts'), path.join(dist, 'renderer', 'save-card.js'));
    await web(path.join(src, 'renderer', 'launcher.ts'), path.join(dist, 'renderer', 'launcher.js'));
    copyByExt(path.join(src, 'renderer'), path.join(dist, 'renderer'), ['.html', '.css']);
    await web(path.join(src, 'internal', 'internal.ts'), path.join(dist, 'internal', 'internal.js'));
    copyByExt(path.join(src, 'internal'), path.join(dist, 'internal'), ['.html', '.css']);
  } else {
    await preload(path.join(src, 'preload', 'detect.ts'), path.join(dist, 'preload-detect.js'));
    // Same page shim as OctoBrowser tabs, so preset audits measure the real protections.
    await preload(path.join(root, 'apps', 'octobrowser', 'src', 'preload', 'tab.ts'), path.join(dist, 'preload-shim.js'));
    await web(path.join(src, 'renderer', 'detect.ts'), path.join(dist, 'renderer', 'detect.js'));
    copyByExt(path.join(src, 'renderer'), path.join(dist, 'renderer'), ['.html', '.css']);
    await web(path.join(src, 'probe', 'probe.ts'), path.join(dist, 'probe', 'probe.js'));
    copyByExt(path.join(src, 'probe'), path.join(dist, 'probe'), ['.html', '.css']);
  }
  buildAssets(app, dist);
  console.log(`build: ${app} ${version} -> ${path.relative(root, dist)} (${Date.now() - started} ms${dev ? ', dev' : ''})`);
}

try {
  for (const app of apps) await buildApp(app);
} catch (err) {
  console.error('build failed:', err?.message ?? err);
  process.exit(1);
}
