// tools/dev/ui-shots.mjs
//
// Developer tool: renders the launcher / browser chrome UI of Octo.su in
// a headless Chromium with a MOCKED `window.octo` bridge and saves screenshots.
// Lets the UI be reviewed and regression-checked without starting Electron.
//
//   CHROME_PATH=/path/to/chrome node tools/dev/ui-shots.mjs [outDir] [scenario...]
//
// Requires `puppeteer-core` (not a project dependency: install it ad hoc, e.g. in
// a temp folder, and set NODE_PATH) and a Chromium/Chrome binary.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { loadCore, root } from '../lib/load-core.mjs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const outDir = path.resolve(process.argv[2] ?? path.join(root, 'test-results', 'ui'));
const only = process.argv.slice(3);
fs.mkdirSync(outDir, { recursive: true });

const core = await loadCore('index');
const dist = path.join(root, 'apps', 'octobrowser', 'dist');
const { scenarios, mockSource } = await import(pathToFileURL(path.join(root, 'tools', 'dev', 'ui-mock.mjs')).href);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
  args: ['--allow-file-access-from-files', '--disable-gpu', '--font-render-hinting=none'],
});
const errors = [];
try {
  for (const sc of scenarios(core)) {
    if (only.length && !only.includes(sc.name)) continue;
    const page = await browser.newPage();
    await page.setViewport({ width: sc.width ?? 1440, height: sc.height ?? 900, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => errors.push(`${sc.name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${sc.name}: console: ${m.text()}`); });
    await page.evaluateOnNewDocument(mockSource, sc.mock);
    await page.goto(pathToFileURL(path.join(dist, sc.page.includes('/') ? sc.page : path.join('renderer', sc.page))).href + (sc.query ?? ''));
    await new Promise((r) => setTimeout(r, 400));
    for (const step of sc.steps ?? []) {
      await page.evaluate(step);
      await new Promise((r) => setTimeout(r, 250));
    }
    await page.screenshot({ path: path.join(outDir, `${sc.name}.png`) });
    if (sc.check) {
      const problems = await page.evaluate(sc.check);
      for (const p of problems ?? []) errors.push(`${sc.name}: ${p}`);
    }
    await page.close();
    console.log(`shot: ${sc.name}`);
  }
} finally {
  await browser.close();
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
}
