import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectAvdFolder, inspectAvdPointer, pointerPath } from '../src/main/android-avd-files';
import { canonicalAvdConfig, parseAvdConfig, renderAvdConfig } from '../src/main/android-avd-config';

function tempAvd(name: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-avd-files-'));
  const avd = path.join(root, `${name}.avd`);
  fs.mkdirSync(avd, { recursive: true });
  return { root, avd, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describe('AVD pointer', () => {
  it('accepts a pointer that names this folder, in either slash style', () => {
    const avd = '/home/alex/.android/avd/Nothing-Nothing-Phone-2.avd';
    expect(inspectAvdPointer('Nothing-Nothing-Phone-2', `path=${avd}\n`, avd)).toEqual([]);
    expect(inspectAvdPointer('Nothing-Nothing-Phone-2', 'path=C:\\Users\\alex\\.android\\avd\\Nothing-Nothing-Phone-2.avd\n', 'C:/Users/alex/.android/avd/Nothing-Nothing-Phone-2.avd')).toEqual([]);
    expect(pointerPath(`path=${avd}\npath.rel=avd/x.avd\n`)).toBe(avd);
  });

  it('reports a missing pointer, a pointer with no path, and a pointer naming another folder', () => {
    const avd = '/home/alex/.android/avd/Nothing-Nothing-Phone-2.avd';
    expect(inspectAvdPointer('Nothing-Nothing-Phone-2', undefined, avd)[0].problem).toMatch(/missing/);
    expect(inspectAvdPointer('Nothing-Nothing-Phone-2', 'target=android-36\n', avd)[0].problem).toMatch(/no path=/);
    const wrong = inspectAvdPointer('Nothing-Nothing-Phone-2', 'path=/home/alex/.android/avd/Nothing.avd\n', avd);
    expect(wrong[0].problem).toMatch(/names/);
  });
});

describe('AVD folder', () => {
  it('reports a missing config.ini and never invents one', () => {
    const { avd, cleanup } = tempAvd('Pixel_10_Pro_Fold');
    try {
      expect(inspectAvdFolder('Pixel_10_Pro_Fold', avd)).toEqual([{ file: 'config.ini', problem: expect.stringMatching(/missing/) }]);
      expect(fs.existsSync(path.join(avd, 'config.ini'))).toBe(false);
    } finally { cleanup(); }
  });

  it('passes a config.ini that follows the rules and flags one that does not', () => {
    const { avd, cleanup } = tempAvd('Pixel_10_Pro_Fold');
    try {
      const ctx = { avdName: 'Pixel_10_Pro_Fold', avdPath: avd };
      fs.writeFileSync(path.join(avd, 'config.ini'), renderAvdConfig(canonicalAvdConfig({
        'hw.device.name': 'pixel_fold', 'hw.device.manufacturer': 'Google', 'hw.ramSize': '4096', 'hw.cpu.ncore': '4',
        'vm.heapSize': '512', 'disk.dataPartition.size': '8G', 'tag.id': 'google_apis', 'hw.camera': 'yes',
      }, ctx)));
      expect(inspectAvdFolder('Pixel_10_Pro_Fold', avd)).toEqual([]);
      fs.writeFileSync(path.join(avd, 'config.ini'), 'hw.ramSize=12288\nhw.camera=yes\n');
      const problems = inspectAvdFolder('Pixel_10_Pro_Fold', avd).map((item) => item.problem).join(' | ');
      expect(problems).toContain('forbidden key: hw.camera');
      expect(problems).toContain('hw.ramSize out of range');
      expect(problems).toContain('AvdId does not match');
    } finally { cleanup(); }
  });

  it('keeps the device block untouched when the rules are applied', () => {
    const parsed = parseAvdConfig('hw.device.name=pixel_fold\nhw.lcd.width=1840\n');
    const out = canonicalAvdConfig(parsed, { avdName: 'x', avdPath: '/tmp/x.avd' });
    expect(out['hw.device.name']).toBe('pixel_fold');
    expect(out['hw.lcd.width']).toBe('1840');
  });
});
