import { describe, expect, it } from 'vitest';
import {
  canonicalAvdConfig, parseAvdConfig, renderAvdConfig, validateAvdConfig, type AvdConfigContext,
} from '../src/main/android-avd-config';
import { ANDROID_DEVICES } from '../src/main/android-devices';
import { configValue, writeConfigValues } from '../src/main/android-studio';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ctx: AvdConfigContext = { avdName: 'Pixel_10_Pro_Fold', avdPath: '/home/user/.android/avd/Pixel_10_Pro_Fold.avd' };

/** A config.ini as the previous generator left it: every broken rule at once. */
const BROKEN = [
  'AvdId=Pixel 10 Pro Fold',
  'PlayStore.enabled=yes',
  'avd.ini.displayname=Pixel 10 Pro Fold',
  'disk.dataPartition.path=<build>/userdata-qemu.img',
  'disk.dataPartition.size=40G',
  'fastboot.chosenSnapshotFile=',
  'fastboot.forceColdBoot=no',
  'hw.camera=yes',
  'hw.camera.back=webcam0',
  'hw.camera.front=none',
  'hw.cpu.ncore=16',
  'hw.device.hash2=MD5:0123456789abcdef0123456789abcdef',
  'hw.device.manufacturer=Google',
  'hw.device.name=pixel_fold',
  'hw.lcd.density=420',
  'hw.lcd.height=2208',
  'hw.lcd.width=1840',
  'hw.ramSize=12288',
  'image.sysdir.1=system-images\\android-36\\google_apis\\x86_64\\',
  'imei=356938035643809',
  'octobrowser.androidId=9774d56d682e549c',
  'octobrowser.buildBrand=google',
  'octobrowser.deviceLabel=Google Pixel Fold',
  'octobrowser.mac=02:00:00:11:22:33',
  'octobrowser.phoneNumber=+15555215554',
  'runtime.network.speed=undefined',
  'skin.path=C:\\Users\\alex\\skins\\pixel',
  'snapshot.present=yes',
  'tag.id=google_apis',
  'userdata.useQcow2=yes',
  'vm.heapSize=128',
  'hw.gpu.mode=auto',
  'hw.gpu.mode=host',
].join('\n') + '\n';

describe('canonicalAvdConfig', () => {
  const clean = (entries: Record<string, unknown>) => canonicalAvdConfig(entries, ctx);

  it('drops forbidden keys, spoofed identity and app metadata', () => {
    const out = clean(parseAvdConfig(BROKEN));
    for (const key of ['hw.camera', 'userdata.useQcow2', 'snapshot.present', 'imei', 'octobrowser.androidId',
      'octobrowser.buildBrand', 'octobrowser.deviceLabel', 'octobrowser.mac', 'octobrowser.phoneNumber']) {
      expect(out).not.toHaveProperty(key);
    }
    expect(Object.keys(out).some((key) => key.startsWith('octobrowser.'))).toBe(false);
  });

  it('keeps the device block exactly as the SDK wrote it', () => {
    const out = clean(parseAvdConfig(BROKEN));
    expect(out['hw.device.name']).toBe('pixel_fold');
    expect(out['hw.device.manufacturer']).toBe('Google');
    expect(out['hw.device.hash2']).toBe('MD5:0123456789abcdef0123456789abcdef');
    expect(out['hw.lcd.width']).toBe('1840');
    expect(out['hw.lcd.height']).toBe('2208');
    expect(out['hw.lcd.density']).toBe('420');
  });

  it('removes empty values and placeholders such as <build>', () => {
    const out = clean(parseAvdConfig(BROKEN));
    expect(out).not.toHaveProperty('fastboot.chosenSnapshotFile');
    expect(out).not.toHaveProperty('runtime.network.speed');
    expect(Object.values(out).some((value) => value === '' || /<build>|<temp>/.test(value))).toBe(false);
    expect(out['disk.dataPartition.path']).toBe('/home/user/.android/avd/Pixel_10_Pro_Fold.avd/userdata-qemu.img');
  });

  it('uses forward slashes in path keys', () => {
    const out = clean(parseAvdConfig(BROKEN));
    expect(out['image.sysdir.1']).toBe('system-images/android-36/google_apis/x86_64/');
    expect(out['skin.path']).toBe('C:/Users/alex/skins/pixel');
  });

  it('clamps RAM, cores, heap and disk to their limits', () => {
    const out = clean({ 'hw.ramSize': '12288', 'hw.cpu.ncore': '16', 'vm.heapSize': '128', 'disk.dataPartition.size': '40G' });
    expect(out['hw.ramSize']).toBe('8192');
    expect(out['hw.cpu.ncore']).toBe('8');
    expect(out['vm.heapSize']).toBe('256');
    expect(out['disk.dataPartition.size']).toBe('16G');
    const low = clean({ 'hw.ramSize': '1024', 'hw.cpu.ncore': '1', 'disk.dataPartition.size': '512M' });
    expect(low['hw.ramSize']).toBe('2048');
    expect(low['hw.cpu.ncore']).toBe('2');
    expect(low['disk.dataPartition.size']).toBe('2G');
    expect(clean({ 'hw.ramSize': '4096' })['hw.ramSize']).toBe('4096');
  });

  it('turns the Play Store on only for the Play image', () => {
    expect(clean({ 'tag.id': 'google_apis_playstore', 'PlayStore.enabled': 'no' })['PlayStore.enabled']).toBe('yes');
    expect(clean({ 'tag.id': 'google_apis', 'PlayStore.enabled': 'yes' })).not.toHaveProperty('PlayStore.enabled');
    expect(clean({ 'PlayStore.enabled': 'yes' })).not.toHaveProperty('PlayStore.enabled');
  });

  it('sets AvdId and the display name to the real folder name', () => {
    const out = clean(parseAvdConfig(BROKEN));
    expect(out.AvdId).toBe('Pixel_10_Pro_Fold');
    expect(out['avd.ini.displayname']).toBe('Pixel_10_Pro_Fold');
    expect(out['avd.ini.encoding']).toBe('UTF-8');
  });
});

describe('renderAvdConfig and validateAvdConfig', () => {
  it('renders sorted, unique key=value lines that pass every rule', () => {
    const text = renderAvdConfig(canonicalAvdConfig(parseAvdConfig(BROKEN), ctx));
    const keys = text.trimEnd().split('\n').map((line) => line.slice(0, line.indexOf('=')));
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.includes('\r')).toBe(false);
    expect(validateAvdConfig(text, ctx)).toEqual([]);
  });

  it('reports every broken rule in the old output', () => {
    const problems = validateAvdConfig(BROKEN, ctx).join(' | ');
    for (const expected of ['forbidden key: hw.camera', 'app metadata', 'spoofed identity', 'placeholder value',
      'backslash in path', 'duplicate keys', 'hw.ramSize out of range', 'hw.cpu.ncore out of range',
      'vm.heapSize below', 'disk.dataPartition.size out of range', 'AvdId does not match', 'empty value', 'PlayStore']) {
      expect(problems).toContain(expected);
    }
  });

  it('accepts a file the emulator can read after canonicalisation of any input order', () => {
    const shuffled = Object.entries(parseAvdConfig(BROKEN)).reverse();
    const text = renderAvdConfig(canonicalAvdConfig(Object.fromEntries(shuffled), ctx));
    expect(validateAvdConfig(text, ctx)).toEqual([]);
  });
});

describe('device catalogue', () => {
  it('lists only Google devices that the SDK defines', () => {
    expect(ANDROID_DEVICES.length).toBeGreaterThan(0);
    for (const device of ANDROID_DEVICES) {
      expect(device.brand).toBe('Google');
      expect(device.baseDevice).toMatch(/^pixel_/);
    }
  });
});

describe('writeConfigValues on a real AVD folder', () => {
  it('reads a device saved before the sidecar, and never reads retired identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-avd-legacy-'));
    try {
      const avd = path.join(root, 'Old_Device.avd');
      fs.mkdirSync(avd, { recursive: true });
      fs.writeFileSync(path.join(avd, 'config.ini'), 'hw.ramSize=4096\noctobrowser.cameraFrontDevice=webcam0\noctobrowser.imei=358901123456789\n');
      expect(configValue(avd, 'octobrowser.cameraFrontDevice')).toBe('webcam0');
      expect(configValue(avd, 'octobrowser.imei')).toBe('');
      // The next save moves the setting into the sidecar and removes it from config.ini.
      writeConfigValues(avd, { 'hw.ramSize': '4096' });
      expect(configValue(avd, 'octobrowser.cameraFrontDevice')).toBe('webcam0');
      expect(fs.readFileSync(path.join(avd, 'config.ini'), 'utf8')).not.toMatch(/octobrowser\./);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes a rule-abiding config.ini and keeps app metadata beside it, never inside it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-avd-write-'));
    try {
      const avd = path.join(root, 'Pixel_10_Pro_Fold.avd');
      fs.mkdirSync(avd, { recursive: true });
      // The SDK wrote the device block; the app then writes its own settings on top.
      fs.writeFileSync(path.join(avd, 'config.ini'), [
        'hw.device.name=pixel_fold', 'hw.device.manufacturer=Google', 'hw.device.hash2=MD5:0123456789abcdef0123456789abcdef',
        'hw.lcd.width=1840', 'hw.lcd.height=2208', 'hw.lcd.density=420', 'tag.id=google_apis_playstore',
        'image.sysdir.1=system-images\\android-36\\google_apis_playstore\\x86_64\\',
      ].join('\n') + '\n');
      writeConfigValues(avd, {
        'hw.ramSize': '12288', 'hw.cpu.ncore': '1', 'vm.heapSize': '128', 'disk.dataPartition.size': '40G',
        'hw.camera': 'yes', 'hw.camera.back': 'webcam0', 'hw.camera.front': 'none',
        'snapshot.present': 'yes', 'fastboot.chosenSnapshotFile': '', 'runtime.network.speed': undefined,
        'octobrowser.deviceLabel': 'Pixel 10 Pro Fold', 'octobrowser.timezone': 'Europe/Warsaw',
        'octobrowser.imei': '358901123456789', 'octobrowser.androidId': '0123456789abcdef',
        'octobrowser.buildBrand': 'samsung', 'octobrowser.mac': '00:1A:11:22:33:44',
      });

      const text = fs.readFileSync(path.join(avd, 'config.ini'), 'utf8');
      const ctx = { avdName: 'Pixel_10_Pro_Fold', avdPath: avd };
      expect(validateAvdConfig(text, ctx)).toEqual([]);
      // The device block came through untouched.
      expect(text).toContain('hw.device.hash2=MD5:0123456789abcdef0123456789abcdef');
      expect(text).toContain('hw.lcd.width=1840');
      expect(text).toContain('PlayStore.enabled=yes');
      expect(text).toContain('image.sysdir.1=system-images/android-36/google_apis_playstore/x86_64/');
      expect(text).toContain('hw.ramSize=8192');
      expect(text).toContain('hw.cpu.ncore=2');
      expect(text).toContain('vm.heapSize=256');
      expect(text).toContain('disk.dataPartition.size=16G');
      expect(text).toContain('hw.camera.back=webcam0');
      expect(text).not.toMatch(/^hw\.camera=/m);
      expect(text).not.toMatch(/octobrowser\.|snapshot\.present|fastboot\.chosenSnapshotFile|undefined/);

      // App metadata: kept in the sidecar, read back through configValue, identity dropped.
      expect(configValue(avd, 'octobrowser.deviceLabel')).toBe('Pixel 10 Pro Fold');
      expect(configValue(avd, 'octobrowser.timezone')).toBe('Europe/Warsaw');
      expect(configValue(avd, 'octobrowser.imei')).toBe('');
      expect(configValue(avd, 'octobrowser.buildBrand')).toBe('');
      const meta = fs.readFileSync(path.join(avd, 'octo-avd.json'), 'utf8');
      expect(meta).not.toMatch(/imei|androidId|buildBrand|mac/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
