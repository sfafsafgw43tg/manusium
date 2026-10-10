import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeFingerprint,
  electronBinaryPresent,
  electronRequired,
  electronWinstallerArtifactsPresent,
  esbuildBinaryPath,
  esbuildPlatformPackage,
  existingDependencyArtifactsPresent,
  ensureDependencies,
  fingerprintInputPaths,
  fingerprintOf,
  planDependencyWork,
  STAMP_PATH,
  verifyNativePackageArtifacts,
  // @ts-expect-error - plain ESM tool without type declarations
} from '../../../tools/ensure-deps.mjs';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const scriptPath = path.join(repoRoot, 'tools', 'ensure-deps.mjs');

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'octo-deps-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, content: string) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** A small checkout shaped like the real one: a root manifest, lockfile, and two apps. */
function makeProject({ electron = true } = {}) {
  put('package.json', JSON.stringify({
    name: 'fixture',
    private: true,
    devDependencies: electron ? { electron: '39.0.0' } : {},
  }));
  put('package-lock.json', '{"lockfileVersion":3,"packages":{}}\n');
  put('apps/octobrowser/package.json', '{"name":"octobrowser"}\n');
  put('apps/octodetect/package.json', '{"name":"octodetect"}\n');
}

/** What a successful `npm ci` leaves behind: the Electron package and its binary. */
function fakeInstall({ electron = true } = {}) {
  put('node_modules/some-dependency/index.js', 'module.exports = 1;\n');
  if (electron) {
    put('node_modules/electron/install.js', '');
    put('node_modules/electron/path.txt', 'electron.exe');
    put('node_modules/electron/dist/electron.exe', '');
  }
}

type Call = { command: string; args: string[] };

function recordingRunner(handle: (call: Call) => number) {
  const calls: Call[] = [];
  const run = (command: string, args: string[]) => {
    const call = { command, args: [...args] };
    calls.push(call);
    return handle(call);
  };
  return { calls, run };
}

const isNpmCi = (call: Call) => call.command === 'npm' && call.args[0] === 'ci';
const isNpmInstall = (call: Call) => call.command === 'npm' && call.args[0] === 'install';
const isNpmDependencyInstall = (call: Call) => isNpmCi(call) || isNpmInstall(call);
const isElectronInstall = (call: Call) => call.command === process.execPath
  && call.args[0].endsWith(path.join('electron', 'install.js'));

describe('fingerprint inputs', () => {
  it('lists the root manifests and each workspace package.json, sorted, and nothing else', () => {
    makeProject();
    put('apps/octodetect/src/main.ts', 'export {};\n');
    put('packages/core/index.ts', 'export {};\n');
    expect(fingerprintInputPaths(root)).toEqual([
      'package.json',
      'package-lock.json',
      '.npmrc',
      'apps/octobrowser/package.json',
      'apps/octodetect/package.json',
    ]);
  });

  it('changes when the lockfile changes and not when source code changes', () => {
    makeProject();
    const before = computeFingerprint(root, 'linux', 'x64');
    put('apps/octobrowser/src/main.ts', 'export const changed = true;\n');
    expect(computeFingerprint(root, 'linux', 'x64')).toBe(before);
    put('package-lock.json', '{"lockfileVersion":3,"packages":{"x":{}}}\n');
    expect(computeFingerprint(root, 'linux', 'x64')).not.toBe(before);
  });

  it('changes when a workspace manifest is added', () => {
    makeProject();
    const before = computeFingerprint(root, 'linux', 'x64');
    put('packages/shell/package.json', '{"name":"shell"}\n');
    expect(computeFingerprint(root, 'linux', 'x64')).not.toBe(before);
  });

  it('distinguishes a missing file from an empty one', () => {
    expect(fingerprintOf({ '.npmrc': null })).not.toBe(fingerprintOf({ '.npmrc': '' }));
  });

  it('does not depend on the order of the inputs', () => {
    expect(fingerprintOf({ a: '1', b: '2' })).toBe(fingerprintOf({ b: '2', a: '1' }));
  });

  it('changes with the platform and the architecture', () => {
    const inputs = { 'package-lock.json': '{}' };
    const windows = fingerprintOf(inputs, 'win32', 'x64');
    expect(fingerprintOf(inputs, 'linux', 'x64')).not.toBe(windows);
    expect(fingerprintOf(inputs, 'win32', 'arm64')).not.toBe(windows);
  });

  it('hashes Buffers and strings with the same bytes alike', () => {
    expect(fingerprintOf({ a: Buffer.from('x') })).toBe(fingerprintOf({ a: 'x' }));
  });
});

describe('Electron detection', () => {
  it('recognises a project that depends on Electron in either section', () => {
    expect(electronRequired({ devDependencies: { electron: '39.0.0' } })).toBe(true);
    expect(electronRequired({ dependencies: { electron: '39.0.0' } })).toBe(true);
    expect(electronRequired({ devDependencies: { typescript: '5.0.0' } })).toBe(false);
    expect(electronRequired(undefined)).toBe(false);
  });

  it('finds the binary only when path.txt names a file that exists', () => {
    expect(electronBinaryPresent(root)).toBe(false);
    put('node_modules/electron/path.txt', 'electron.exe');
    expect(electronBinaryPresent(root)).toBe(false);
    put('node_modules/electron/dist/electron.exe', '');
    expect(electronBinaryPresent(root)).toBe(true);
    put('node_modules/electron/path.txt', '');
    expect(electronBinaryPresent(root)).toBe(false);
  });
});

describe('native package setup', () => {
  it('recognises the required esbuild binary and optional Squirrel artifacts', () => {
    expect(esbuildBinaryPath(root)).toBe(null);
    expect(electronWinstallerArtifactsPresent(root)).toBe(true);
    put('node_modules/esbuild/bin/esbuild', '');
    expect(esbuildBinaryPath(root)).toContain(path.join('node_modules', 'esbuild', 'bin', 'esbuild'));
    put('node_modules/electron-winstaller/vendor/7z.exe', '');
    expect(electronWinstallerArtifactsPresent(root)).toBe(false);
    put('node_modules/electron-winstaller/vendor/7z.dll', '');
    expect(electronWinstallerArtifactsPresent(root)).toBe(true);
  });

  it('repairs only missing native package artifacts and verifies esbuild execution', () => {
    put('node_modules/esbuild/package.json', JSON.stringify({
      optionalDependencies: { [`@esbuild/${process.platform}-${process.arch}`]: '0.28.2' },
    }));
    put('node_modules/esbuild/install.js', '');
    put('node_modules/electron-winstaller/script/select-7z-arch.js', '');
    const runner = recordingRunner((call) => {
      if (call.command === 'npm' && call.args[0] === 'install') put(`node_modules/@esbuild/${process.platform}-${process.arch}/package.json`, '{}');
      if (call.args[0].endsWith(path.join('esbuild', 'install.js'))) put('node_modules/esbuild/bin/esbuild', '');
      if (call.args[0].endsWith(path.join('select-7z-arch.js'))) {
        put('node_modules/electron-winstaller/vendor/7z.exe', '');
        put('node_modules/electron-winstaller/vendor/7z.dll', '');
      }
      return 0;
    });
    expect(verifyNativePackageArtifacts(root, { run: runner.run, log: () => {} })).toBe(true);
    expect(runner.calls[0].args).toContain(`@esbuild/${process.platform}-${process.arch}@0.28.2`);
    expect(runner.calls[1].args[0]).toBe(path.join(root, 'node_modules', 'esbuild', 'install.js'));
    expect(runner.calls[2].args).toEqual(['--version']);
    expect(runner.calls[3].args[0]).toBe(path.join(root, 'node_modules', 'electron-winstaller', 'script', 'select-7z-arch.js'));
  });

  it('reads the pinned platform package version from esbuild rather than guessing it', () => {
    put('node_modules/esbuild/package.json', JSON.stringify({
      optionalDependencies: { [`@esbuild/${process.platform}-${process.arch}`]: '0.28.2' },
    }));
    expect(esbuildPlatformPackage(root)).toEqual({
      name: `@esbuild/${process.platform}-${process.arch}`,
      version: '0.28.2',
    });
  });
});

describe('planDependencyWork', () => {
  const current = {
    modulesPresent: true,
    stamp: { fingerprint: 'f' },
    fingerprint: 'f',
    electronNeeded: true,
    electronPackageInstalled: true,
    electronBinaryInstalled: true,
  };

  it('does nothing when the recorded install matches and Electron is present', () => {
    expect(planDependencyWork(current).action).toBe('none');
  });

  it('installs when node_modules is missing', () => {
    expect(planDependencyWork({ ...current, modulesPresent: false }).action).toBe('install');
  });

  it('installs when no install has been recorded (for example after the first update)', () => {
    expect(planDependencyWork({ ...current, stamp: null }).action).toBe('install');
  });

  it('installs when the fingerprint changed, such as after a new lockfile', () => {
    expect(planDependencyWork({ ...current, fingerprint: 'g' }).action).toBe('install');
  });

  it('installs when the electron package itself is missing', () => {
    expect(planDependencyWork({ ...current, electronPackageInstalled: false }).action).toBe('install');
  });

  it('repairs only the Electron binary when it is missing', () => {
    expect(planDependencyWork({ ...current, electronBinaryInstalled: false }).action).toBe('electron');
  });

  it('ignores the Electron binary in a project that does not use Electron', () => {
    expect(planDependencyWork({
      ...current,
      electronNeeded: false,
      electronPackageInstalled: false,
      electronBinaryInstalled: false,
    }).action).toBe('none');
  });
});

describe('ensureDependencies', () => {
  it('installs a fresh checkout once, then leaves it alone', () => {
    makeProject();
    const first = recordingRunner((call) => {
      if (isNpmDependencyInstall(call)) {
        fakeInstall();
        put('node_modules/esbuild/bin/esbuild', '');
      }
      return 0;
    });
    expect(ensureDependencies(root, { run: first.run, log: () => {} }).status).toBe(0);
    expect(first.calls.filter(isNpmDependencyInstall).map((c) => c.command + ' ' + c.args[0])).toEqual(['npm install']);
    expect(first.calls.find(isNpmDependencyInstall)?.args).toContain('--ignore-scripts');
    expect(first.calls.find(isNpmDependencyInstall)?.args).toContain('--include=optional');
    expect(existsSync(path.join(root, STAMP_PATH))).toBe(true);

    const second = recordingRunner(() => 0);
    expect(ensureDependencies(root, { run: second.run, log: () => {} }).status).toBe(0);
    expect(second.calls).toEqual([]);
  });

  it('reinstalls after a new lockfile arrives with a new version', () => {
    makeProject();
    const install = recordingRunner((call) => {
      if (isNpmDependencyInstall(call)) fakeInstall();
      return 0;
    });
    ensureDependencies(root, { run: install.run, log: () => {} });

    put('package-lock.json', '{"lockfileVersion":3,"packages":{"new-dependency":{}}}\n');
    const update = recordingRunner((call) => {
      if (isNpmDependencyInstall(call)) fakeInstall();
      return 0;
    });
    expect(ensureDependencies(root, { run: update.run, log: () => {} }).status).toBe(0);
    expect(update.calls.some(isNpmDependencyInstall)).toBe(true);
  });

  it('removes the record before an install, so an interrupted install never looks complete', () => {
    makeProject();
    const first = recordingRunner((call) => {
      if (isNpmDependencyInstall(call)) fakeInstall();
      return 0;
    });
    ensureDependencies(root, { run: first.run, log: () => {} });
    expect(existsSync(path.join(root, STAMP_PATH))).toBe(true);

    put('package-lock.json', '{"lockfileVersion":3,"packages":{"changed":{}}}\n');
    // Both npm commands are interrupted: nothing is recorded any more.
    rmSync(path.join(root, 'node_modules', 'electron'), { recursive: true, force: true });
    const interrupted = recordingRunner(() => 1);
    expect(ensureDependencies(root, { run: interrupted.run, log: () => {} }).status).toBe(2);
    expect(existsSync(path.join(root, STAMP_PATH))).toBe(false);
  });

  it('falls back to clean npm ci when npm install fails', () => {
    makeProject();
    const runner = recordingRunner((call) => {
      if (isNpmInstall(call)) return 1;
      if (isNpmCi(call)) { fakeInstall(); return 0; }
      return 0;
    });
    expect(ensureDependencies(root, { run: runner.run, log: () => {} }).status).toBe(0);
    expect(runner.calls.map((c) => c.args[0])).toEqual(['install', 'ci']);
  });

  it('fails without recording an install when both npm commands fail', () => {
    makeProject();
    const runner = recordingRunner(() => 1);
    expect(ensureDependencies(root, { run: runner.run, log: () => {} }).status).toBe(2);
    expect(runner.calls.map((c) => c.args[0])).toEqual(['install', 'ci']);
    expect(existsSync(path.join(root, STAMP_PATH))).toBe(false);
  });

  it('continues with a verified existing tree when both npm commands fail', () => {
    makeProject();
    fakeInstall();
    expect(existingDependencyArtifactsPresent(root, { devDependencies: { electron: '39.0.0' } })).toBe(true);
    const messages: string[] = [];
    const runner = recordingRunner(() => 1);
    expect(ensureDependencies(root, { run: runner.run, log: (line: string) => messages.push(line) }).status).toBe(0);
    expect(messages.join('\n')).toContain('using the existing verified dependency tree');
    expect(existsSync(path.join(root, STAMP_PATH))).toBe(false);
  });

  it('repairs only the Electron binary when the packages are current', () => {
    makeProject();
    const install = recordingRunner((call) => {
      if (isNpmDependencyInstall(call)) fakeInstall();
      return 0;
    });
    ensureDependencies(root, { run: install.run, log: () => {} });

    rmSync(path.join(root, 'node_modules', 'electron', 'dist'), { recursive: true, force: true });
    const repair = recordingRunner((call) => {
      if (isElectronInstall(call)) put('node_modules/electron/dist/electron.exe', '');
      return 0;
    });
    expect(ensureDependencies(root, { run: repair.run, log: () => {} }).status).toBe(0);
    expect(repair.calls).toHaveLength(1);
    expect(isElectronInstall(repair.calls[0])).toBe(true);
  });

  it('keeps the recorded install when the Electron download fails, so only that step is retried', () => {
    makeProject();
    const install = recordingRunner((call) => {
      if (isNpmDependencyInstall(call)) fakeInstall();
      return 0;
    });
    ensureDependencies(root, { run: install.run, log: () => {} });
    rmSync(path.join(root, 'node_modules', 'electron', 'dist'), { recursive: true, force: true });

    const offline = recordingRunner((call) => (isElectronInstall(call) ? 1 : 0));
    expect(ensureDependencies(root, { run: offline.run, log: () => {} }).status).toBe(2);
    expect(offline.calls.some(isNpmCi)).toBe(false);
    expect(offline.calls.some(isNpmInstall)).toBe(false);
    expect(existsSync(path.join(root, STAMP_PATH))).toBe(true);
  });

  it('skips the Electron step for a project that does not use Electron', () => {
    makeProject({ electron: false });
    const runner = recordingRunner((call) => {
      if (isNpmDependencyInstall(call)) fakeInstall({ electron: false });
      return 0;
    });
    expect(ensureDependencies(root, { run: runner.run, log: () => {} }).status).toBe(0);
    expect(runner.calls.some(isElectronInstall)).toBe(false);
  });

  it('check mode reports the work and never runs a command', () => {
    makeProject();
    const runner = recordingRunner(() => 0);
    const result = ensureDependencies(root, { checkOnly: true, run: runner.run, log: () => {} });
    expect(result.status).toBe(1);
    expect(result.plan.action).toBe('install');
    expect(runner.calls).toEqual([]);
  });
});

describe('tools/ensure-deps.mjs command line', () => {
  function cli(args: string[], env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [scriptPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env, OCTO_ROOT: root },
      timeout: 60_000,
    });
  }

  it('--check exits 1 for a fresh checkout and 0 once the install is recorded', () => {
    makeProject({ electron: false });
    const fresh = cli(['--check']);
    expect(fresh.status).toBe(1);
    expect(fresh.stdout).toContain('Dependencies need attention');

    fakeInstall({ electron: false });
    put(STAMP_PATH, JSON.stringify({ fingerprint: computeFingerprint(root) }));
    const current = cli(['--check']);
    expect(current.status).toBe(0);
    expect(current.stdout).toContain('Dependencies are up to date.');
  });

  it('a plain run exits 0 without touching the network when everything is current', () => {
    makeProject({ electron: false });
    fakeInstall({ electron: false });
    put(STAMP_PATH, JSON.stringify({ fingerprint: computeFingerprint(root) }));
    expect(cli([]).status).toBe(0);
  });

  it('reports a checkout it cannot read as an error (exit 2)', () => {
    const result = cli(['--check']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Dependency check failed');
  });
});

describe('npm start hooks', () => {
  it('every start and dev script runs the dependency check first', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const name of ['start', 'start:browser', 'start:detect', 'dev', 'dev:detect']) {
      expect(pkg.scripts[`pre${name}`], `pre${name}`).toBe('node tools/ensure-deps.mjs');
    }
    expect(pkg.scripts.deps).toBe('node tools/ensure-deps.mjs');
    expect(pkg.scripts['deps:check']).toBe('node tools/ensure-deps.mjs --check');
  });
});
