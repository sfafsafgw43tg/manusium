import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hardwareCacheProblems, inspectHardwareCache, repairHardwareCache, repairHardwareCacheText } from '../src/main/android-avd-files';

const CONFIG = 'hw.camera.back=webcam0\nhw.camera.front=none\nhw.ramSize=4096\n';

describe('hardwareCacheProblems', () => {
  it('finds nothing before the first boot, when there is no cache file yet', () => {
    expect(hardwareCacheProblems(undefined, CONFIG)).toEqual([]);
  });

  it('flags a camera that differs from config.ini, and keys that must not be in the cache', () => {
    const cache = 'hw.camera.back=webcam3\nhw.camera.front=none\nhw.ramSize=4096\noctobrowser.androidId=abc\noctobrowser.deviceLabel=Test\n';
    const problems = hardwareCacheProblems(cache, CONFIG).map((item) => item.problem);
    expect(problems).toEqual([
      'value that must not be in the emulator cache: octobrowser.androidId',
      'value that must not be in the emulator cache: octobrowser.deviceLabel',
      'hw.camera.back is webcam3 but config.ini says webcam0',
    ]);
  });

  it('does not compare cameras when config.ini is missing, because nothing can be trusted to compare with', () => {
    expect(hardwareCacheProblems('hw.camera.back=webcam3\n', undefined)).toEqual([]);
  });
});

describe('repairHardwareCacheText', () => {
  it('sets cameras to config.ini values and drops foreign keys, keeping every other line as it was', () => {
    const cache = 'hw.camera.back=webcam3\nhw.camera.front=webcam9\nhw.ramSize=4096\noctobrowser.androidId=abc\nnot a pair\nhw.sensors.proximity=yes\n';
    const next = repairHardwareCacheText(cache, CONFIG);
    expect(next.text).toBe('hw.camera.back=webcam0\nhw.camera.front=none\nhw.ramSize=4096\nnot a pair\nhw.sensors.proximity=yes\n');
    expect(next.changed).toEqual(['hw.camera.back', 'hw.camera.front', 'octobrowser.androidId']);
  });

  it('removes a camera key that config.ini no longer has', () => {
    const next = repairHardwareCacheText('hw.camera.front=webcam2\nhw.ramSize=4096\n', 'hw.ramSize=4096\n');
    expect(next.text).toBe('hw.ramSize=4096\n');
    expect(next.changed).toEqual(['hw.camera.front']);
  });

  it('leaves camera keys alone when config.ini is missing', () => {
    const next = repairHardwareCacheText('hw.camera.back=webcam3\n', undefined);
    expect(next.text).toBe('hw.camera.back=webcam3\n');
    expect(next.changed).toEqual([]);
  });
});

describe('the cache file on disk', () => {
  let dir = '';
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-cache-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('is repaired in place, never deleted, and a second check finds nothing', () => {
    fs.writeFileSync(path.join(dir, 'config.ini'), CONFIG);
    fs.writeFileSync(path.join(dir, 'hardware-qemu.ini'), 'hw.camera.back=webcam3\nhw.ramSize=4096\n');
    expect(inspectHardwareCache(dir).map((item) => item.problem)).toEqual(['hw.camera.back is webcam3 but config.ini says webcam0']);
    expect(repairHardwareCache(dir)).toEqual(['hw.camera.back']);
    expect(fs.existsSync(path.join(dir, 'hardware-qemu.ini'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'hardware-qemu.ini'), 'utf8')).toBe('hw.camera.back=webcam0\nhw.ramSize=4096\n');
    expect(inspectHardwareCache(dir)).toEqual([]);
    expect(repairHardwareCache(dir)).toEqual([]);
  });

  it('does nothing when the emulator has not written a cache yet', () => {
    fs.writeFileSync(path.join(dir, 'config.ini'), CONFIG);
    expect(inspectHardwareCache(dir)).toEqual([]);
    expect(repairHardwareCache(dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'hardware-qemu.ini'))).toBe(false);
  });
});
