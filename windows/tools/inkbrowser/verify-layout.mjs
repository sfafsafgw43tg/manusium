// tools/inkbrowser/verify-layout.mjs
//
// Checks an unpacked InkBrowser tree against tools/inkbrowser/layout-manifest.json
// (see docs/inkbrowser/BLUEPRINT.md, section 9). It accepts the two-level layout
// of image-1 (launcher in Application\, runtime in Application\<version>\) and
// the flat portable layout. It rejects anything that makes the tree an Electron
// application (electron.exe, node.dll, *.asar, package.json, node_modules) and
// the upstream launcher names that must be renamed.
//
// This is a build-machine check. Nothing in the shipped tree depends on it, and
// the browser itself never runs Node.js.
//
//   node tools/inkbrowser/verify-layout.mjs <dir>          exit 0 valid, 1 invalid, 2 usage or I/O error
//   node tools/inkbrowser/verify-layout.mjs <dir> --json   print the result as JSON

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'layout-manifest.json');

export function loadManifest(file = MANIFEST_PATH) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Every file and directory under `dir`, relative, with forward slashes.
 * Directories end with '/'.
 */
export function walkTree(dir) {
  const out = [];
  const visit = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.push(`${childRel}/`);
        visit(path.join(abs, entry.name), childRel);
      } else {
        out.push(childRel);
      }
    }
  };
  visit(dir, '');
  return out;
}

/** Converts a '*' glob (for example '*.asar') into a case-insensitive RegExp. */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Pure check of a list of tree entries (files, and directories ending in '/').
 * Returns { layout: 'installed' | 'flat' | null, errors: [], warnings: [] }.
 */
export function checkLayout(entries, manifest = loadManifest()) {
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const report = (list, message) => {
    if (!seen.has(message)) {
      seen.add(message);
      list.push(message);
    }
  };

  const items = entries.map((raw) => {
    const isDir = /[\\/]$/.test(raw);
    const clean = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return { path: clean, lower: clean.toLowerCase(), isDir, segments: clean.split('/') };
  });
  const files = items.filter((item) => !item.isDir);
  const fileSet = new Set(files.map((file) => file.lower));

  // Forbidden content, checked for every entry.
  const forbiddenFiles = new Set(manifest.forbiddenFiles.map((name) => name.toLowerCase()));
  const forbiddenPatterns = manifest.forbiddenPatterns.map(globToRegExp);
  const forbiddenDirectories = new Set(manifest.forbiddenDirectories.map((name) => name.toLowerCase()));
  const upstreamLauncherNames = new Set(manifest.upstreamLauncherNames.map((name) => name.toLowerCase()));
  const googleServiceBinaries = new Set(manifest.googleServiceBinaries.map((name) => name.toLowerCase()));
  // Components that InkBrowser does not ship (WidevineCdm, MEIPreload, Privacy Sandbox
  // attestations), as folders or files. Reported once, at the top-most match.
  const excludedComponents = new Set((manifest.excludedComponents ?? []).map((name) => name.toLowerCase()));

  for (const item of items) {
    const base = item.segments[item.segments.length - 1];
    const baseLower = base.toLowerCase();
    const parents = item.isDir ? item.segments : item.segments.slice(0, -1);
    parents.forEach((segment, index) => {
      if (forbiddenDirectories.has(segment.toLowerCase())) {
        // Reported once, at the top-most forbidden folder, not for every file under it.
        report(errors, `forbidden directory: ${item.segments.slice(0, index + 1).join('/')}`);
      }
    });
    const excludedAt = item.segments.findIndex((segment) => excludedComponents.has(segment.toLowerCase()));
    if (excludedAt !== -1) {
      report(errors, `excluded component present (InkBrowser does not ship it): ${item.segments.slice(0, excludedAt + 1).join('/')}`);
    }
    if (item.isDir) continue;
    if (forbiddenFiles.has(baseLower)) report(errors, `forbidden file: ${item.path}`);
    if (forbiddenPatterns.some((pattern) => pattern.test(base))) {
      report(errors, `forbidden file type (Electron/ASAR application bundle): ${item.path}`);
    }
    if (upstreamLauncherNames.has(baseLower)) {
      report(errors, `upstream launcher name, rename to ${manifest.launcher}: ${item.path}`);
    }
    if (googleServiceBinaries.has(baseLower)) {
      report(errors, `Google service binary present (its GN feature should be off): ${item.path}`);
    }
  }

  // Layout detection. Names are compared case-insensitively, as Windows does.
  const launcher = manifest.launcher.toLowerCase();
  const { launcherDir, versionDirPattern, launcherDirOptional } = manifest.installed;
  const appDir = launcherDir.toLowerCase();
  const versionRe = new RegExp(versionDirPattern);
  const required = manifest.runtime.required;

  const versionDirs = [...new Set(
    files
      .filter((file) => file.segments.length >= 3 && file.segments[0].toLowerCase() === appDir
        && versionRe.test(file.segments[1]))
      .map((file) => file.segments[1]),
  )].sort();
  // Names come back in the manifest's own case, so messages read like the manifest.
  const missingIn = (prefix) => required.filter((name) => !fileSet.has(`${prefix}${name.toLowerCase()}`));

  const launcherInApp = fileSet.has(`${appDir}/${launcher}`);
  const launcherAtRoot = fileSet.has(launcher);
  const versionMissing = new Map(versionDirs.map((version) => {
    const lower = version.toLowerCase();
    return [version, missingIn(`${appDir}/${lower}/`)];
  }));
  const installedComplete = versionDirs.find((version) => versionMissing.get(version).length === 0);
  const flatMissing = missingIn('');

  let layout = null;
  if (launcherInApp && installedComplete) {
    layout = 'installed';
  } else if (launcherAtRoot && flatMissing.length === 0) {
    layout = 'flat';
  }

  if (layout === 'installed') {
    if (versionDirs.length > 1) {
      report(errors, `expected one version folder under ${launcherDir}\\, found ${versionDirs.length}: ${versionDirs.join(', ')}`);
    }
    const optional = new Set(launcherDirOptional.map((name) => name.toLowerCase()));
    for (const file of files) {
      if (file.segments.length === 2 && file.segments[0].toLowerCase() === appDir) {
        const name = file.segments[1].toLowerCase();
        if (name !== launcher && !optional.has(name)) {
          report(warnings, `unexpected file in ${launcherDir}\\: ${file.segments[1]}`);
        }
      }
    }
    for (const version of versionDirs.filter((v) => v !== installedComplete)) {
      report(warnings, `version folder without a complete runtime: ${launcherDir}\\${version}`);
    }
  } else if (layout === null) {
    if (!launcherInApp && !launcherAtRoot) {
      report(errors, `launcher not found: expected ${manifest.launcher} in ${launcherDir}\\ (installed layout) or at the root (flat layout)`);
    }
    if (launcherInApp && !installedComplete) {
      if (versionDirs.length === 0) {
        report(errors, `no version folder with the runtime under ${launcherDir}\\ (expected a folder named like 154.0.8037.97)`);
      } else {
        const best = [...versionMissing.entries()].sort((a, b) => a[1].length - b[1].length)[0];
        for (const name of best[1]) report(errors, `missing runtime file: ${launcherDir}\\${best[0]}\\${name}`);
      }
    }
    if (launcherAtRoot && flatMissing.length > 0) {
      for (const name of flatMissing) report(errors, `missing runtime file (flat layout): ${name}`);
    }
    if (errors.length === 0) report(errors, 'not an InkBrowser tree: neither layout matches');
  }

  return { layout, errors, warnings };
}

export function runCli(argv, out = (text) => process.stdout.write(text), err = (text) => process.stderr.write(text)) {
  const json = argv.includes('--json');
  const dir = argv.find((arg) => !arg.startsWith('--'));
  if (!dir) {
    err('usage: node tools/inkbrowser/verify-layout.mjs <dir> [--json]\n');
    return 2;
  }
  const root = path.resolve(dir);
  let isDirectory = false;
  try {
    isDirectory = statSync(root).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    err(`not a directory: ${root}\n`);
    return 2;
  }
  const result = checkLayout(walkTree(root));
  const ok = result.layout !== null && result.errors.length === 0;
  if (json) {
    out(`${JSON.stringify({ dir: root, ok, ...result }, null, 2)}\n`);
  } else {
    out(`InkBrowser tree: ${root}\n`);
    out(`layout: ${result.layout ?? 'unknown'}\n`);
    for (const warning of result.warnings) out(`warning: ${warning}\n`);
    if (ok) {
      out('PASS\n');
    } else {
      out(`FAIL: ${result.errors.length} problem(s)\n`);
      for (const error of result.errors) out(`  - ${error}\n`);
    }
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
