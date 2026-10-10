/**
 * A device created as a Pixel 9 must say it is a Pixel 9. Android reads that
 * from build.prop inside the system image, so the patch below is the only
 * thing between "sdk_gphone64_x86_64" and the real handset.
 */
import { describe, expect, it } from 'vitest';
import {
  randomMac, randomImei, randomAndroidId, randomSerialNumber,
  randomPhoneNumber, randomSimProfile, createRandomHardwareIdentity,
} from '@octo/core';
import {
  imageAllowsRoot, patchBuildProp, deviceIdentityOf, updateAvdSettings,
} from '../src/main/android-studio';
import { ANDROID_RELEASE_DATES, PHONES, androidBuildIdentity, handsetDisplayName, phone } from '../src/main/android-catalog';
import { addCustomImage, apiOf, importSystemImageArchive, inspectSystemImageDirectory, validCustomPackage } from '../src/main/android-custom';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

const studioSource = fs.readFileSync(`${__dirname}/../src/main/android-studio.ts`, 'utf8');

const IDENTITY = {
  brand: 'google', manufacturer: 'Google', model: 'Pixel 9', device: 'tokay', product: 'tokay',
  mac: '00:1A:11:22:33:44', imei: '358901123456789', androidId: '0123456789abcdef',
  serialNumber: '9A01B2C3D4E5', phoneNumber: '+12025550143', operator: 'T-Mobile',
  simOperator: '310260', simCountry: 'us',
};

describe('hardware identity generator', () => {
  it('generates well-formed MAC addresses with brand OUI prefixes', () => {
    const mac = randomMac('google');
    expect(mac).toMatch(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/);
  });

  it('generates 15-digit valid IMEIs satisfying the Luhn algorithm', () => {
    const imei = randomImei('samsung');
    expect(imei).toMatch(/^\d{15}$/);
    let sum = 0;
    for (let i = 0; i < 15; i++) {
      let digit = parseInt(imei[i], 10);
      if (i % 2 === 1) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
    }
    expect(sum % 10).toBe(0);
  });

  it('generates 16-hex character Android IDs and serial numbers', () => {
    const id = randomAndroidId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const sn = randomSerialNumber('google');
    expect(sn.length).toBeGreaterThanOrEqual(8);
  });

  it('generates phone numbers and carrier profiles for supported regions', () => {
    const usProfile = randomSimProfile('us');
    expect(usProfile.country).toBe('us');
    expect(usProfile.numeric).toMatch(/^\d{5,6}$/);
    const plPhone = randomPhoneNumber('pl');
    expect(plPhone).toMatch(/^\+48/);
  });

  it('creates complete randomized hardware identity bundle', () => {
    const bundle = createRandomHardwareIdentity('samsung', 'pl');
    expect(bundle.mac).toBeDefined();
    expect(bundle.imei).toBeDefined();
    expect(bundle.androidId).toBeDefined();
    expect(bundle.serialNumber).toBeDefined();
    expect(bundle.phoneNumber).toMatch(/^\+48/);
    expect(bundle.simCountry).toBe('pl');
  });
});

describe('the handset a device reports', () => {
  it('rewrites every build.prop key that carries the model', () => {
    const before = [
      'ro.product.brand=Android',
      'ro.product.manufacturer=Google',
      'ro.product.model=sdk_gphone64_x86_64',
      'ro.product.name=sdk_gphone64_x86_64',
      'ro.product.device=emu64x',
      'ro.build.version.release=15',
    ].join('\n');
    const after = patchBuildProp(before, IDENTITY);
    expect(after.text).toContain('ro.product.model=Pixel 9');
    expect(after.text).toContain('ro.product.brand=google');
    expect(after.text).toContain('ro.product.device=tokay');
    // Untouched lines stay exactly as they were.
    expect(after.text).toContain('ro.build.version.release=15');
    expect(after.changed).toContain('ro.product.model');
    // The vendor/system variants are added when the image lacks them.
    expect(after.text).toContain('ro.product.system.model=Pixel 9');
  });

  it('changes nothing when the identity is already right', () => {
    const already = 'ro.product.model=Pixel 9\nro.product.brand=google\n';
    const result = patchBuildProp(already, { ...IDENTITY, device: '', product: '' });
    expect(result.changed).not.toContain('ro.product.model');
  });

  it('uses the chosen commercial device name as model for every vendor and populates hardware attributes', () => {
    const pixel = phone('pixel-9')!;
    expect(pixel.identity.modelNumber).toBe('GZPF0');
    const pixelIdentity = androidBuildIdentity(pixel);
    expect(pixelIdentity).toMatchObject({
      brand: 'google', manufacturer: 'Google', model: 'Google Pixel 9', marketName: 'Google Pixel 9', device: 'tokay', product: 'tokay',
    });
    expect(pixelIdentity.mac).toBeDefined();
    expect(pixelIdentity.imei).toBeDefined();
    expect(pixelIdentity.androidId).toBeDefined();
    expect(pixelIdentity.serialNumber).toBeDefined();
    expect(pixelIdentity.phoneNumber).toBeDefined();
    expect(pixelIdentity.operator).toBeDefined();
    expect(pixelIdentity.simOperator).toBeDefined();

    expect(androidBuildIdentity(phone('galaxy-s24')!).model).toBe('Samsung Galaxy S24');
    expect(androidBuildIdentity(phone('oneplus-12')!).model).toBe('OnePlus 12');
    expect(androidBuildIdentity(phone('xiaomi-14-ultra')!)).toMatchObject({
      manufacturer: 'Xiaomi', model: 'Xiaomi 14 Ultra', marketName: 'Xiaomi 14 Ultra', device: 'aurora',
    });
    expect(handsetDisplayName(phone('xiaomi-14-ultra')!)).toBe('Xiaomi 14 Ultra');
    expect(handsetDisplayName(pixel)).toBe('Google Pixel 9');
    for (const handset of PHONES.filter((item) => item.identity.realDevice)) {
      // Every real handset has a real codename; no catalogue slug leaks into
      // Build.DEVICE/PRODUCT.
      expect(androidBuildIdentity(handset).device).not.toBe(handset.id);
      expect(androidBuildIdentity(handset).model).toBe(handsetDisplayName(handset));
      expect(androidBuildIdentity(handset).model).not.toBe(handset.identity.modelNumber);
    }
  });

  it('patches every modern property source that can win Build.MODEL', () => {
    const result = patchBuildProp('ro.product.model=sdk_gphone64_x86_64\n', IDENTITY);
    for (const source of ['system', 'vendor', 'product', 'odm', 'system_ext']) {
      expect(result.text).toContain(`ro.product.${source}.model=Pixel 9`);
    }
    expect(result.text).toContain('ro.product.marketname=Pixel 9');
    expect(result.text).toContain('ro.build.product=tokay');
    expect(result.text).toContain('ro.build.characteristics=phone');
  });

  it('no longer writes a handset identity or fabricated identifiers into Android', () => {
    // The apply path is retired: the function returns before any adb call.
    const start = studioSource.indexOf('export async function applyDeviceIdentity(');
    const body = studioSource.slice(start, studioSource.indexOf('\n}\n', start));
    expect(body).toContain('does not write a handset identity or fabricated identifiers into Android');
    expect(body).not.toContain("'remount'");
    expect(body).not.toContain("'root'");
    expect(body).not.toContain("'setprop'");
    expect(studioSource).not.toContain("'-writable-system'");
  });

  it('never reads spoofed handset identity back out of config.ini', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-avd-identity-'));
    try {
      // A config.ini from before the identity was retired: the keys are still in the file.
      fs.writeFileSync(path.join(root, 'config.ini'), [
        'hw.ramSize=4096',
        'octobrowser.buildBrand=samsung',
        'octobrowser.buildModel=Samsung Galaxy S24 Ultra',
        'octobrowser.mac=00:1A:11:22:33:44',
        'octobrowser.imei=358901123456789',
        'octobrowser.androidId=0123456789abcdef',
        'octobrowser.serialNumber=9A01B2C3D4E5',
        'octobrowser.phoneNumber=+12025550143',
      ].join('\n'));
      // Retired: nothing is applied and the legacy values are not shown as a device identity.
      expect(deviceIdentityOf(root)).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });


  it('knows that a Google Play image refuses root', () => {
    expect(imageAllowsRoot({ target: 'system-images;android-35;google_apis_playstore;x86_64' })).toBe(false);
    expect(imageAllowsRoot({ target: 'system-images;android-35;google_apis;x86_64' })).toBe(true);
  });
});

function storedZip(entries: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const [fileName, value] of Object.entries(entries)) {
    const name = Buffer.from(fileName);
    const body = Buffer.from(value);
    const crc = zlib.crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, name, body);
    centralParts.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

describe('custom Android versions', () => {
  it('only accepts something that is really an SDK package', () => {
    expect(validCustomPackage('system-images;android-35;google_apis;x86_64')).toBe(true);
    expect(validCustomPackage('android-35')).toBe(false);
    expect(validCustomPackage('system-images;android-35;google_apis')).toBe(false);
    expect(apiOf('system-images;android-33;aosp_atd;arm64-v8a')).toBe(33);
    expect(() => addCustomImage({ packageName: 'nonsense' })).toThrow(/system-images/);
    expect(() => addCustomImage({ packageName: 'system-images;android-35;google_apis;x86_64', released: 'last year' })).toThrow(/YYYY-MM/);
  });

  it('recognises a complete extracted emulator image and rejects a lone phone/GSI image', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-system-image-'));
    try {
      const image = path.join(root, 'sdk-repo', 'android-35', 'x86_64');
      fs.mkdirSync(image, { recursive: true });
      fs.writeFileSync(path.join(image, 'source.properties'), 'Pkg.Desc=Local AOSP 15\nAndroidVersion.ApiLevel=35\nSystemImage.Abi=x86_64\n');
      for (const name of ['system.img', 'ramdisk.img', 'userdata.img', 'kernel-ranchu']) fs.writeFileSync(path.join(image, name), name);
      expect(inspectSystemImageDirectory(root)).toMatchObject({ source: image, api: 35, abi: 'x86_64', label: 'Local AOSP 15', files: 5 });

      const incomplete = path.join(root, 'phone-rom');
      fs.mkdirSync(incomplete);
      fs.writeFileSync(path.join(incomplete, 'system.img'), 'not enough to boot an AVD');
      expect(() => inspectSystemImageDirectory(incomplete)).toThrow(/complete emulator image/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('creates an importable SDK image from a selected emulator ROM ZIP', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-rom-zip-'));
    const oldHome = process.env.HOME;
    const oldProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = root;
      process.env.USERPROFILE = root;
      const archive = path.join(root, 'aosp-emulator-rom.zip');
      fs.writeFileSync(archive, storedZip({
        'image/source.properties': 'Pkg.Desc=AOSP ROM ZIP\nAndroidVersion.ApiLevel=35\nSystemImage.Abi=x86_64\n',
        'image/system.img': 'system',
        'image/ramdisk.img': 'ramdisk',
        'image/userdata.img': 'userdata',
        'image/kernel-ranchu': 'kernel',
      }));
      const stages: string[] = [];
      const imported = await importSystemImageArchive(archive, path.join(root, 'sdk'),
        (stage) => stages.push(stage), () => true);
      expect(imported.image.packageName).toMatch(/^system-images;android-35;octo_local_aosp_emulator_rom_[a-f0-9]{8};x86_64$/);
      expect(fs.readFileSync(path.join(imported.destination, 'system.img'), 'utf8')).toBe('system');
      expect(stages).toContain('unzip');
      expect(stages).toContain('import');
      expect(fs.readdirSync(path.join(root, 'sdk')).some((name) => name.startsWith('.octo-rom-import-'))).toBe(false);
    } finally {
      if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
      if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('says which year and month an Android version is from', () => {
    expect(ANDROID_RELEASE_DATES[35]).toBe('2024-10');
    expect(ANDROID_RELEASE_DATES[29]).toBe('2019-09');
    for (const [api, date] of Object.entries(ANDROID_RELEASE_DATES)) {
      expect(date, api).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
    }
  });
});
