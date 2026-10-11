import { describe, expect, it } from 'vitest';
import {
  quietBoot, quietBootArgs, telephonyArgsIn, telephonySupported, validTelephoneNumber, type QuietBootDeps,
} from '../src/main/android-quiet-boot';

interface FakeOptions {
  name?: string;
  /** Polls of `devices` before the device is listed. Infinity = never. */
  attachAfterMs?: number;
  /** Clock time after which Android reports boot completed. Infinity = never. */
  bootAfterMs?: number;
  /** Problems returned by each call to inspect(), in order. */
  inspections?: string[][];
  /** The emulator process exits at once (crash before it attaches). */
  exitsAtStart?: boolean;
  /** inspect() throws. */
  inspectThrows?: string;
  /** The emulator ignores `emu kill` and keeps running. */
  ignoresKill?: boolean;
}

/** A fake emulator and adb. The clock only moves when the code sleeps. */
function fakeDeps(opts: FakeOptions = {}) {
  const name = opts.name ?? 'Pixel_10_Pro_Fold';
  let clock = 0;
  const events: string[] = [];
  const adbCalls: string[][] = [];
  let resolveExit: (code: number | null) => void = () => undefined;
  let exitedPromise: Promise<number | null> = new Promise<number | null>((resolve) => { resolveExit = resolve; });
  let processAlive = true;
  const finish = (code: number | null) => {
    if (processAlive) { processAlive = false; resolveExit(code); }
  };
  let inspections = 0;
  const repairs: string[][] = [];
  const progress: string[] = [];
  const deps: QuietBootDeps = {
    start(args) {
      events.push(`start ${args.join(' ')}`);
      if (opts.exitsAtStart) finish(1);
      return {
        exited: exitedPromise,
        kill() { events.push('kill'); if (!opts.ignoresKill) finish(null); },
      };
    },
    async adb(args) {
      adbCalls.push(args);
      const text = args.join(' ');
      if (text === 'wait-for-device') { events.push('wait-for-device'); return ''; }
      if (text === 'devices') {
        events.push('devices');
        return clock >= (opts.attachAfterMs ?? 0) && processAlive
          ? 'List of devices attached\nemulator-5554\tdevice\n'
          : 'List of devices attached\n';
      }
      if (text.endsWith('ro.boot.qemu.avd_name')) return `${name}\n`;
      if (text.endsWith('sys.boot_completed')) {
        events.push('boot poll');
        return clock >= (opts.bootAfterMs ?? 0) ? '1\n' : '0\n';
      }
      if (text.endsWith('emu kill')) {
        events.push('emu kill');
        if (!opts.ignoresKill) finish(0);
        return 'OK';
      }
      return '';
    },
    inspect() {
      events.push('inspect');
      if (opts.inspectThrows) throw new Error(opts.inspectThrows);
      const next = opts.inspections?.[inspections] ?? [];
      inspections += 1;
      return next;
    },
    repair(problems) { events.push('repair'); repairs.push(problems); },
    progress(text) { progress.push(text); },
    async sleep(ms) { clock += ms; },
    now: () => clock,
  };
  return { deps, events, adbCalls, repairs, progress, name, clock: () => clock, alive: () => processAlive };
}

describe('quietBootArgs', () => {
  it('boots with no window, no audio and no snapshot written on exit, then adds the extras', () => {
    const args = quietBootArgs('Pixel_10_Pro_Fold', ['-no-metrics']);
    expect(args[0]).toBe('@Pixel_10_Pro_Fold');
    expect(args).toEqual(expect.arrayContaining(['-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot-save']));
    expect(args[args.length - 1]).toBe('-no-metrics');
  });
});

describe('telephony number', () => {
  const help = '  -phone-number <number>  set the emulated phone number\n  -no-metrics\n';

  it('is passed only when this emulator lists the flag', () => {
    expect(telephonyArgsIn(help, '+15555550123')).toEqual(['-phone-number', '+15555550123']);
    expect(telephonyArgsIn('  -no-metrics\n', '+15555550123')).toEqual([]);
    expect(telephonySupported('-phone-number-extra')).toBe(false);
  });

  it('is never passed when empty, and an invalid number is refused', () => {
    expect(telephonyArgsIn(help, '')).toEqual([]);
    expect(() => telephonyArgsIn(help, 'call me')).toThrow(/digits/);
    expect(validTelephoneNumber('12')).toBe(false);
    expect(validTelephoneNumber('1234567890123456')).toBe(false);
    expect(validTelephoneNumber('+4812345678')).toBe(true);
  });
});

describe('quietBoot', () => {
  it('boots, closes the device, then checks the files; a clean device reports no issues', async () => {
    const fake = fakeDeps({ attachAfterMs: 3_000, bootAfterMs: 9_000, inspections: [[]] });
    const result = await quietBoot(fake.deps, { name: fake.name, extraArgs: ['-no-metrics'] });
    expect(result).toEqual({ booted: true, serial: 'emulator-5554', issues: [], repaired: [] });
    expect(fake.events[0]).toMatch(/^start @Pixel_10_Pro_Fold -no-window -no-audio -no-boot-anim -no-snapshot-save -no-metrics$/);
    expect(fake.adbCalls).toContainEqual(['wait-for-device']);
    expect(fake.adbCalls).toContainEqual(['-s', 'emulator-5554', 'shell', 'getprop', 'sys.boot_completed']);
    expect(fake.adbCalls).toContainEqual(['-s', 'emulator-5554', 'emu', 'kill']);
    expect(fake.alive()).toBe(false);
    // The files are only looked at after the emulator has been closed.
    const killAt = fake.events.indexOf('emu kill');
    expect(killAt).toBeGreaterThan(-1);
    expect(fake.events.indexOf('inspect')).toBeGreaterThan(killAt);
    expect(fake.progress[fake.progress.length - 1]).toBe('Pixel_10_Pro_Fold is set up');
  });

  it('repairs the problems it finds and reports the ones that are still there', async () => {
    const fake = fakeDeps({
      inspections: [
        ['config.ini: forbidden key: hw.camera', 'hardware-qemu.ini: hw.camera.back is webcam3'],
        ['config.ini: forbidden key: hw.camera'],
      ],
    });
    const result = await quietBoot(fake.deps, { name: fake.name });
    expect(fake.repairs).toEqual([['config.ini: forbidden key: hw.camera', 'hardware-qemu.ini: hw.camera.back is webcam3']]);
    expect(result.issues).toEqual(['config.ini: forbidden key: hw.camera']);
    expect(result.repaired).toEqual(['hardware-qemu.ini: hw.camera.back is webcam3']);
    expect(result.booted).toBe(true);
  });

  it('reports a device that never attaches, still closes the process, and still checks the files', async () => {
    const fake = fakeDeps({ attachAfterMs: Number.POSITIVE_INFINITY, inspections: [[]] });
    const result = await quietBoot(fake.deps, { name: fake.name, attachMs: 10_000 });
    expect(result.booted).toBe(false);
    expect(result.serial).toBe('');
    expect(result.issues).toEqual(['The emulator did not attach to this device in time.']);
    expect(fake.adbCalls.some((call) => call.includes('kill'))).toBe(false);
    expect(fake.alive()).toBe(false);
    expect(fake.events).toContain('inspect');
  });

  it('stops waiting at once when the emulator process exits before it attaches', async () => {
    const fake = fakeDeps({ exitsAtStart: true, attachAfterMs: Number.POSITIVE_INFINITY, inspections: [[]] });
    const result = await quietBoot(fake.deps, { name: fake.name, attachMs: 180_000 });
    expect(result.issues).toEqual(['The emulator stopped before this device attached.']);
    expect(fake.clock()).toBeLessThan(180_000);
  });

  it('reports a boot that never finishes, and closes the device', async () => {
    const fake = fakeDeps({ bootAfterMs: Number.POSITIVE_INFINITY, inspections: [[]] });
    const result = await quietBoot(fake.deps, { name: fake.name, bootMs: 12_000 });
    expect(result.booted).toBe(false);
    expect(result.issues).toEqual(['Android did not finish booting in time.']);
    expect(fake.adbCalls).toContainEqual(['-s', 'emulator-5554', 'emu', 'kill']);
    expect(fake.alive()).toBe(false);
  });

  it('does not touch the files while an emulator that ignores the close is still running', async () => {
    const fake = fakeDeps({ bootAfterMs: 0, ignoresKill: true });
    const result = await quietBoot(fake.deps, { name: fake.name });
    expect(result.booted).toBe(true);
    expect(result.issues).toEqual(['The emulator did not close in time, so the device files were not checked.']);
    expect(fake.events).not.toContain('inspect');
    expect(fake.events).not.toContain('repair');
  });

  it('turns a failure while checking the files into an issue, and the emulator is still closed', async () => {
    const fake = fakeDeps({ bootAfterMs: 0, inspectThrows: 'the file could not be read' });
    const result = await quietBoot(fake.deps, { name: fake.name });
    expect(result.issues).toEqual(['the file could not be read']);
    expect(fake.adbCalls).toContainEqual(['-s', 'emulator-5554', 'emu', 'kill']);
    expect(fake.alive()).toBe(false);
  });
});
