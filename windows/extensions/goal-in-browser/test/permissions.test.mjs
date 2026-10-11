import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');

/** Every text file the extension ships: TypeScript sources, HTML pages, and the stylesheet. */
function shippedFiles(dir = path.join(ROOT, 'src')) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return shippedFiles(full);
    return /\.(ts|html|css)$/.test(name) && !name.endsWith('.d.ts') ? [full] : [];
  });
}

test('the manifest requests exactly the reviewed permissions', () => {
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'browsingData', 'contentSettings', 'declarativeNetRequest', 'privacy', 'storage']);
});

test('every permission is explained in the README', () => {
  for (const name of [...manifest.permissions, '<all_urls>']) {
    assert.ok(readme.includes(`\`${name}\``), `README explains ${name}`);
  }
});

test('no broad or unused permissions, and no host access at install time', () => {
  const forbidden = ['tabs', 'history', 'cookies', 'webRequest', 'webRequestBlocking', 'scripting', 'downloads', 'bookmarks', 'clipboardRead', 'declarativeNetRequestWithHostAccess', 'declarativeNetRequestFeedback', 'webNavigation'];
  for (const name of forbidden) assert.equal(manifest.permissions.includes(name), false, name);
  assert.equal('host_permissions' in manifest, false);
  assert.equal(manifest.permissions.some((entry) => entry.includes('://') || entry.includes('<all_urls>')), false);
});

test('the all-sites permission is optional only and is the sole host pattern', () => {
  assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>']);
});

test('the manifest targets Chromium 128 or later and has a short description', () => {
  assert.equal(manifest.minimum_chrome_version, '128');
  assert.ok(manifest.description.length <= 132, 'Chrome limits descriptions to 132 characters');
  assert.equal(manifest.version, '0.2.0');
});

test('no content scripts, web-accessible resources, or externally connectable pages', () => {
  for (const key of ['content_scripts', 'web_accessible_resources', 'externally_connectable', 'key']) {
    assert.equal(key in manifest, false, key);
  }
});

test('the service worker is an ES module and the CSP allows no remote or inline code', () => {
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self'; object-src 'self'");
});

test('the curated rulesets are declared and exist; the ads rulesets are added by the build', () => {
  const resources = manifest.declarative_net_request.rule_resources;
  assert.deepEqual(resources.map((r) => r.id), ['trackers', 'fingerprinting']);
  for (const resource of resources) {
    assert.equal(existsSync(path.join(ROOT, resource.path)), true, resource.path);
    assert.equal(resource.enabled, true);
  }
});

test('the bundled hosts list is not committed, and its licence is recorded', () => {
  const gitignore = readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.cache\/$/m, 'the download cache is ignored by Git');
  assert.match(gitignore, /^dist\/$/m, 'build output is ignored by Git');
  const notices = readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, /StevenBlack\/hosts/);
  assert.match(notices, /MIT/);
});

test('shipped source contains no dynamic code, no network calls, and no remote script references', () => {
  const forbidden = [
    /\beval\s*\(/,
    /new Function\s*\(/,
    /\binnerHTML\b/,
    /\bouterHTML\b/,
    /document\.write/,
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /new WebSocket/,
    /importScripts\s*\(/,
    /import\(\s*['"`]https?:/,
    /from\s+['"`]https?:/,
    /chrome\.scripting/,
    /chrome\.webRequest/,
    /chrome\.history/,
    /chrome\.cookies/,
    /chrome\.tabs\.(executeScript|insertCSS)/,
    /\bsetTimeout\(\s*['"`]/,
    /\bsendBeacon\b/,
  ];
  const files = shippedFiles();
  assert.ok(files.length >= 10, 'found the source files');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of forbidden) assert.equal(pattern.test(text), false, `${path.basename(file)} matches ${pattern}`);
    assert.equal(/['"`]https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(text), false, `${path.basename(file)} has a remote URL literal`);
  }
});

test('HTML pages load only local scripts and styles, with no inline scripts and no remote links', () => {
  for (const page of ['popup.html', 'options.html']) {
    const html = readFileSync(path.join(ROOT, 'src', page), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
    for (const tag of scripts) assert.match(tag, /src="[a-z]+\.js"/, `${page}: ${tag}`);
    assert.equal(/<script\b(?![^>]*\bsrc=)/i.test(html), false, `${page} has an inline script`);
    assert.equal(/(src|href)="https?:/i.test(html), false, `${page} references a remote resource`);
  }
});

test('the extension has a privacy-focused name and no antidetect wording', () => {
  assert.equal(manifest.name, 'GOAL in Browser');
  const all = JSON.stringify(manifest).toLowerCase();
  assert.equal(all.includes('antidetect'), false);
  assert.equal(all.includes('fingerprint spoof'), false);
});
