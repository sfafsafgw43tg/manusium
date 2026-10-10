// tools/ensure-deps.mjs
//
// Keeps node_modules in step with the sources that are about to run.
//
// A new version of the app (an update, a git pull, a copied checkout) can bring
// a changed package.json or package-lock.json. Starting Electron against a stale
// node_modules fails later with "Cannot find module", so every start asks this
// script first. It installs when:
//   - node_modules is missing, or no install has been recorded yet,
//   - package.json, package-lock.json, .npmrc, or a workspace package.json
//     changed since the last successful install (fingerprint mismatch),
//   - the Electron package or its binary is missing (only the Electron step runs).
//
// Uses Node built-ins only, because it must run before any dependency exists.
//
//   node tools/ensure-deps.mjs          install or repair if needed (0 ready, 2 failed)
//   node tools/ensure-deps.mjs --check  report only (0 ready, 1 needs work, 2 error)
//   OCTO_ROOT=<dir>                     check another root (used by the tests)

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FINGERPRINT_VERSION = 1;
export const STAMP_PATH = path.join('node_modules', '.octo-deps-stamp.json');

const ROOT_INPUTS = ['package.json', 'package-lock.json', '.npmrc'];

/** Relative, forward-slash paths of every file that decides what gets installed. */
export function fingerprintInputPaths(root) {
  const workspaces = [];
  for (const group of ['apps', 'packages']) {
    const dir = path.join(root, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const rel = `${group}/${name}/package.json`;
      if (existsSync(path.join(root, rel))) workspaces.push(rel);
    }
  }
  return [...ROOT_INPUTS, ...workspaces];
}

/**
 * Pure: SHA-256 over the named inputs and the platform. `inputs` maps a relative
 * path to its contents, or to null when the file does not exist.
 */
export function fingerprintOf(inputs, platform = process.platform, arch = process.arch) {
  const hash = createHash('sha256');
  hash.update(`octo-deps-v${FINGERPRINT_VERSION}\n${platform}-${arch}\n`);
  for (const name of Object.keys(inputs).sort()) {
    const content = inputs[name];
    const digest = content === null || content === undefined
      ? 'absent'
      : createHash('sha256').update(content).digest('hex');
    hash.update(`${name}\t${digest}\n`);
  }
  return hash.digest('hex');
}

/** Reads the fingerprint inputs of a checkout from disk and fingerprints them. */
export function computeFingerprint(root, platform, arch) {
  const inputs = {};
  for (const rel of fingerprintInputPaths(root)) {
    const abs = path.join(root, rel);
    inputs[rel] = existsSync(abs) ? readFileSync(abs) : null;
  }
  return fingerprintOf(inputs, platform, arch);
}

/** Pure: true when the root manifest declares Electron. */
export function electronRequired(pkg) {
  return Boolean(pkg && ((pkg.dependencies && pkg.dependencies.electron)
    || (pkg.devDependencies && pkg.devDependencies.electron)));
}

/** True when the Electron package has been installed (its install script is there). */
export function electronPackagePresent(root) {
  return existsSync(path.join(root, 'node_modules', 'electron', 'install.js'));
}

/** True when Electron's install step left a runnable binary (path.txt -> dist/<path>). */
export function electronBinaryPresent(root) {
  const electronDir = path.join(root, 'node_modules', 'electron');
  const pathFile = path.join(electronDir, 'path.txt');
  if (!existsSync(pathFile)) return false;
  const relative = readFileSync(pathFile, 'utf8').trim();
  return relative !== '' && existsSync(path.join(electronDir, 'dist', relative));
}

/** Returns the platform-specific esbuild binary path, or null when it is absent. */
export function esbuildBinaryPath(root) {
  const dir = path.join(root, 'node_modules', 'esbuild', 'bin');
  const name = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
  return existsSync(path.join(dir, name)) ? path.join(dir, name) : null;
}

/** Returns the exact platform package esbuild expects for this process. */
export function esbuildPlatformPackage(root) {
  const packageFile = path.join(root, 'node_modules', 'esbuild', 'package.json');
  if (!existsSync(packageFile)) return null;
  try {
    const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
    const name = `@esbuild/${process.platform}-${process.arch}`;
    const version = pkg.optionalDependencies?.[name];
    return typeof version === 'string' ? { name, version } : null;
  } catch {
    return null;
  }
}

/** The Squirrel helper is optional at runtime but needs its selected 7-Zip pair for packaging. */
export function electronWinstallerArtifactsPresent(root) {
  const dir = path.join(root, 'node_modules', 'electron-winstaller');
  if (!existsSync(dir)) return true;
  return existsSync(path.join(dir, 'vendor', '7z.exe')) && existsSync(path.join(dir, 'vendor', '7z.dll'));
}

/**
 * Allows a transient registry/network/npm failure to be skipped only when the
 * already-present dependency tree can still build and launch the app. This is
 * deliberately not a general "ignore npm" switch: a fresh or partial install
 * still fails, and every build tool declared by the root manifest is checked.
 */
export function existingDependencyArtifactsPresent(root, pkg) {
  if (electronRequired(pkg) && (!electronPackagePresent(root) || !electronBinaryPresent(root))) return false;
  if (pkg?.devDependencies?.esbuild && !esbuildBinaryPath(root)) return false;
  if (pkg?.devDependencies?.typescript && !existsSync(path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'))) return false;
  return electronWinstallerArtifactsPresent(root);
}

/**
 * Repairs only the native package scripts this project uses. It does not approve
 * arbitrary package scripts: esbuild is required by the build, while the
 * electron-winstaller selector is needed only when that packaging dependency exists.
 */
export function verifyNativePackageArtifacts(root, { run = runCommand, log = writeLine } = {}) {
  const esbuildDir = path.join(root, 'node_modules', 'esbuild');
  if (existsSync(esbuildDir)) {
    let binary = esbuildBinaryPath(root);
    if (!binary) {
      const platformPackage = esbuildPlatformPackage(root);
      if (!platformPackage) {
        log(`esbuild does not declare a platform package for ${process.platform}-${process.arch}.`);
        return false;
      }
      const packageSpec = `${platformPackage.name}@${platformPackage.version}`;
      log(`esbuild native binary is missing; installing its optional package ${packageSpec} without running unrelated scripts.`);
      if (run('npm', [
        'install', '--no-save', '--no-package-lock', '--ignore-scripts', '--include=optional', packageSpec,
      ], root) !== 0) return false;
      const install = path.join(esbuildDir, 'install.js');
      log('running the verified esbuild install.js for the restored platform package.');
      if (!existsSync(install) || run(process.execPath, [install], root) !== 0) return false;
      binary = esbuildBinaryPath(root);
    }
    if (!binary || run(binary, ['--version'], root) !== 0) {
      log('The esbuild native binary could not be executed.');
      return false;
    }
  }

  const winstallerDir = path.join(root, 'node_modules', 'electron-winstaller');
  if (existsSync(winstallerDir) && !electronWinstallerArtifactsPresent(root)) {
    const selector = path.join(winstallerDir, 'script', 'select-7z-arch.js');
    log('electron-winstaller 7-Zip artifacts are missing; running its architecture selector.');
    if (!existsSync(selector) || run(process.execPath, [selector], winstallerDir) !== 0 || !electronWinstallerArtifactsPresent(root)) {
      log('electron-winstaller could not prepare its 7-Zip artifacts.');
      return false;
    }
  }
  return true;
}

/** The stamp written after a successful install, or null when there is none. */
export function readStamp(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, STAMP_PATH), 'utf8'));
  } catch {
    return null;
  }
}

export function writeStamp(root, fingerprint) {
  mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  const record = {
    version: FINGERPRINT_VERSION,
    fingerprint,
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    installedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(root, STAMP_PATH), `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Pure: decides the work to do.
 *   'install'  run npm ci (npm install as the fallback), then repair Electron
 *   'electron' the dependencies match, only the Electron binary is missing
 *   'none'     nothing to do
 */
export function planDependencyWork({
  modulesPresent,
  stamp,
  fingerprint,
  electronNeeded,
  electronPackageInstalled,
  electronBinaryInstalled,
}) {
  if (!modulesPresent) {
    return { action: 'install', reason: 'node_modules is missing' };
  }
  if (!stamp || stamp.fingerprint !== fingerprint) {
    return {
      action: 'install',
      reason: 'package.json or package-lock.json changed since the last install, or no install is recorded yet',
    };
  }
  if (electronNeeded && !electronPackageInstalled) {
    return { action: 'install', reason: 'the electron package is missing from node_modules' };
  }
  if (electronNeeded && !electronBinaryInstalled) {
    return { action: 'electron', reason: 'the Electron binary is missing' };
  }
  return { action: 'none', reason: 'dependencies match the sources' };
}

/** Runs a command and returns its exit status. Output goes to this console. */
export function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    // npm is npm.cmd on Windows, which only starts through the shell.
    shell: process.platform === 'win32' && command === 'npm',
  });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

const writeLine = (line) => process.stdout.write(`${line}\n`);

/**
 * Makes the checkout at `root` ready to run. Returns { status, plan }:
 * 0 ready, 1 needs work (check mode only), 2 failed.
 */
export function ensureDependencies(root, { checkOnly = false, run = runCommand, log = writeLine } = {}) {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const electronNeeded = electronRequired(pkg);
  const plan = planDependencyWork({
    modulesPresent: existsSync(path.join(root, 'node_modules')),
    stamp: readStamp(root),
    fingerprint: computeFingerprint(root),
    electronNeeded,
    electronPackageInstalled: electronPackagePresent(root),
    electronBinaryInstalled: electronBinaryPresent(root),
  });

  if (plan.action === 'none') {
    log('Dependencies are up to date.');
    return { status: 0, plan };
  }
  if (checkOnly) {
    log(`Dependencies need attention: ${plan.reason}.`);
    return { status: 1, plan };
  }

  if (plan.action === 'install') {
    log(`Installing dependencies: ${plan.reason}.`);
    // The record goes first: an install that is interrupted (closed window, Ctrl+C, a
    // dropped network) must never look complete to the next start.
    rmSync(path.join(root, STAMP_PATH), { force: true });
    const ciStatus = run('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts', '--include=optional'], root);
    if (ciStatus !== 0) {
      log(`npm ci failed with exit code ${ciStatus}. Retrying with npm install.`);
      const installStatus = run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--include=optional'], root);
      if (installStatus !== 0) {
        if (existingDependencyArtifactsPresent(root, pkg)) {
          log(`npm install also failed with exit code ${installStatus}; using the existing verified dependency tree and continuing.`);
          return { status: 0, plan };
        }
        log(`Dependency installation failed: npm ci=${ciStatus}, npm install=${installStatus}. A complete usable dependency tree was not found.`);
        return { status: 2, plan };
      }
    }
  } else {
    log(`Repairing dependencies: ${plan.reason}.`);
  }

  if (!verifyNativePackageArtifacts(root, { run, log })) {
    log('Required native package setup did not complete. Check the npm output and run the installer again.');
    return { status: 2, plan };
  }

  if (plan.action === 'install') {
    // Record only after native package setup succeeds. A failed Electron download
    // below is retried on its own; it does not reinstall every package on each start.
    // Fingerprint after install because npm install may rewrite the lockfile.
    writeStamp(root, computeFingerprint(root));
  }

  if (electronNeeded && !electronBinaryPresent(root)) {
    log('Installing the Electron binary.');
    const installScript = path.join('node_modules', 'electron', 'install.js');
    if (run(process.execPath, [installScript], root) !== 0 || !electronBinaryPresent(root)) {
      log('The Electron binary could not be installed. Check the network, then start again.');
      return { status: 2, plan };
    }
  }

  log('Dependencies are ready.');
  return { status: 0, plan };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = path.resolve(env.OCTO_ROOT || defaultRoot);
  try {
    return ensureDependencies(root, { checkOnly: argv.includes('--check') }).status;
  } catch (error) {
    process.stderr.write(`Dependency check failed: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
