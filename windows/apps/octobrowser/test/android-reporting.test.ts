/**
 * Two things Octo says out loud instead of hiding:
 *  - the emulator's usage metrics are switched off, and only when the installed
 *    emulator build lists the flag;
 *  - a handset identity that could not be written is reported after boot.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { emulatorTelemetryArgs, metricsFlagIn } from '../src/main/android-studio';

const root = path.resolve(__dirname, '..', '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');

describe('emulator usage metrics', () => {
  it('asks for -no-metrics only when the emulator lists that option', () => {
    expect(metricsFlagIn('  -no-metrics           Disable anonymous usage metrics')).toEqual(['-no-metrics']);
    expect(metricsFlagIn('  -metrics-collection   Allow anonymous usage metrics')).toEqual([]);
    expect(metricsFlagIn('  -no-metrics-collection-extra')).toEqual([]);
    expect(metricsFlagIn('')).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('probes the emulator binary it is given, and only passes the flag it lists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-metrics-'));
    const listsFlag = path.join(dir, 'emulator-listing');
    const oldBuild = path.join(dir, 'emulator-old');
    fs.writeFileSync(listsFlag, '#!/bin/sh\necho "  -no-metrics   Disable anonymous usage metrics"\n', { mode: 0o755 });
    fs.writeFileSync(oldBuild, '#!/bin/sh\necho "  -verbose   Print initialization messages"\n', { mode: 0o755 });
    try {
      expect(await emulatorTelemetryArgs(listsFlag, dir)).toEqual(['-no-metrics']);
      expect(await emulatorTelemetryArgs(oldBuild, dir)).toEqual([]);
      // A binary that cannot be run gets no flag, so the launch is never blocked by the probe.
      expect(await emulatorTelemetryArgs(path.join(dir, 'missing'), dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('every emulator start and camera-list call goes through the same check', () => {
    const studio = read('apps/octobrowser/src/main/android-studio.ts');
    expect(studio).toContain('await emulatorTelemetryArgs(emulator, emulatorRoot)');
    expect(studio).toContain('await emulatorTelemetryArgs(tools.emulator, tools.root)');
  });
});

describe('a handset identity that is not applied', () => {
  it('is reported after boot, and only a device with no stored identity stays silent', () => {
    const manager = read('apps/octobrowser/src/main/manager.ts');
    const block = manager.slice(manager.indexOf('const identity = await applyDeviceIdentity(name);'));
    const head = block.slice(0, 900);
    expect(head).toContain("key: 'android.identity.notApplied'");
    expect(head).toContain('!identity.nothingStored');
  });

  it('no longer tells the user to re-create the device on another image', () => {
    expect(read('apps/octobrowser/src/main/android-studio.ts')).not.toContain('Create the device again');
  });

  it('has the wording in both English and Polish', () => {
    expect(read('packages/core/src/i18n/en.ts')).toContain("'android.identity.notApplied'");
    expect(read('packages/core/src/i18n/pl.ts')).toContain("'android.identity.notApplied'");
  });
});
