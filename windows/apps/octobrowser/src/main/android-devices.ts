/**
 * apps/octobrowser/src/main/android-devices.ts
 *
 * The catalogue behind the "New Android device" wizard: handset/tablet models,
 * Android system images and the storage arithmetic shown before anything is
 * written to disk.
 *
 * Why a local catalogue at all: `avdmanager` only knows Google's own hardware
 * profiles (pixel_*, Nexus_*, tablet...). A Xiaomi, Samsung, Realme or OnePlus
 * device is therefore created from the closest Google profile and then made
 * accurate through `config.ini`: resolution, density, RAM and the build
 * properties (brand/manufacturer/model/device) that apps read. Everything here
 * is plain data + pure functions so the wizard, the IPC layer and the tests all
 * agree on the same numbers, and nothing in this file touches the network.
 */

export type AndroidAbi = 'x86_64' | 'arm64-v8a' | 'x86' | 'armeabi-v7a';
export type AndroidImageKind = 'google-play' | 'google-apis' | 'aosp';
/** Which Android product line an image belongs to. Phones are the default. */
export type AndroidImageFamily = 'phone' | 'tv' | 'wear' | 'automotive';
export type AndroidFormFactor = 'phone' | 'tablet' | 'foldable';

export interface AndroidDeviceProfile {
  id: string;
  brand: string;
  model: string;
  /** Google hardware profile used as the creation base (`avdmanager --device`). */
  baseDevice: string;
  formFactor: AndroidFormFactor;
  width: number;
  height: number;
  /** Screen density in dpi (config.ini `hw.lcd.density`). */
  density: number;
  /** Physical screen size in inches, only shown to the user. */
  inches: number;
  /** Suggested RAM in MiB for a smooth emulator on a capable host. */
  ramMb: number;
  /** Build properties apps read: brand / manufacturer / model / device. */
  props: { brand: string; manufacturer: string; model: string; device: string; product: string };
  /** Android release the real handset shipped with; only a hint for the user. */
  shippedApi: number;
  year: number;
}

/**
 * Devices the Android SDK itself defines (`baseDevice` is a devices.xml id). A new
 * device created from one of these gets its device block from the SDK, so the
 * config matches a valid profile by construction. Handsets from other brands were
 * removed: they could only exist as this base device with the brand and model
 * overwritten, which is spoofed identity and matches no devices.xml profile.
 */
export const ANDROID_DEVICES: readonly AndroidDeviceProfile[] = [
  { id: 'pixel-8', brand: 'Google', model: 'Pixel 8', baseDevice: 'pixel_8', formFactor: 'phone', width: 1080, height: 2400, density: 420, inches: 6.2, ramMb: 4096, shippedApi: 34, year: 2023, props: { brand: 'google', manufacturer: 'Google', model: 'Pixel 8', device: 'shiba', product: 'shiba' } },
  { id: 'pixel-8-pro', brand: 'Google', model: 'Pixel 8 Pro', baseDevice: 'pixel_8_pro', formFactor: 'phone', width: 1344, height: 2992, density: 480, inches: 6.7, ramMb: 6144, shippedApi: 34, year: 2023, props: { brand: 'google', manufacturer: 'Google', model: 'Pixel 8 Pro', device: 'husky', product: 'husky' } },
  { id: 'pixel-7a', brand: 'Google', model: 'Pixel 7a', baseDevice: 'pixel_7a', formFactor: 'phone', width: 1080, height: 2400, density: 420, inches: 6.1, ramMb: 4096, shippedApi: 33, year: 2023, props: { brand: 'google', manufacturer: 'Google', model: 'Pixel 7a', device: 'lynx', product: 'lynx' } },
  { id: 'pixel-fold', brand: 'Google', model: 'Pixel Fold', baseDevice: 'pixel_fold', formFactor: 'foldable', width: 1840, height: 2208, density: 420, inches: 7.6, ramMb: 6144, shippedApi: 33, year: 2023, props: { brand: 'google', manufacturer: 'Google', model: 'Pixel Fold', device: 'felix', product: 'felix' } },
  { id: 'pixel-tablet', brand: 'Google', model: 'Pixel Tablet', baseDevice: 'pixel_tablet', formFactor: 'tablet', width: 1600, height: 2560, density: 320, inches: 10.95, ramMb: 6144, shippedApi: 33, year: 2023, props: { brand: 'google', manufacturer: 'Google', model: 'Pixel Tablet', device: 'tangorpro', product: 'tangorpro' } },
] as const;

/** Vendor presets based on an SDK-supported Google base profile. */
export const ANDROID_VENDOR_DEVICES: readonly AndroidDeviceProfile[] = [
  { id: 'samsung-galaxy-s23', brand: 'Samsung', model: 'Galaxy S23', baseDevice: 'pixel_7', formFactor: 'phone', width: 1080, height: 2340, density: 420, inches: 6.1, ramMb: 8192, shippedApi: 33, year: 2023, props: { brand: 'samsung', manufacturer: 'Samsung', model: 'SM-S911B', device: 'dm1q', product: 'dm1q' } },
  { id: 'xiaomi-14', brand: 'Xiaomi', model: 'Xiaomi 14', baseDevice: 'pixel_8', formFactor: 'phone', width: 1200, height: 2670, density: 460, inches: 6.36, ramMb: 8192, shippedApi: 34, year: 2024, props: { brand: 'xiaomi', manufacturer: 'Xiaomi', model: '23127PN0CG', device: 'houji', product: 'houji' } },
  { id: 'oneplus-12', brand: 'OnePlus', model: 'OnePlus 12', baseDevice: 'pixel_8_pro', formFactor: 'phone', width: 1440, height: 3168, density: 510, inches: 6.82, ramMb: 12288, shippedApi: 34, year: 2024, props: { brand: 'oneplus', manufacturer: 'OnePlus', model: 'CPH2581', device: 'waffle', product: 'waffle' } },
  { id: 'pixel-10-pro-fold', brand: 'Google', model: 'Pixel 10 Pro Fold', baseDevice: 'pixel_fold', formFactor: 'foldable', width: 2076, height: 2152, density: 420, inches: 8.0, ramMb: 12288, shippedApi: 35, year: 2025, props: { brand: 'google', manufacturer: 'Google', model: 'Pixel 10 Pro Fold', device: 'comet', product: 'comet' } },
  { id: 'nothing-phone-2', brand: 'Nothing', model: 'Nothing Phone (2)', baseDevice: 'pixel_7', formFactor: 'phone', width: 1080, height: 2412, density: 420, inches: 6.7, ramMb: 8192, shippedApi: 33, year: 2023, props: { brand: 'nothing', manufacturer: 'Nothing', model: 'Nothing Phone (2)', device: 'pong', product: 'pong' } },
] as const;

export const ANDROID_CATALOG_DEVICES: readonly AndroidDeviceProfile[] = [...ANDROID_DEVICES, ...ANDROID_VENDOR_DEVICES];

export interface AndroidSystemImage {
  id: string;
  label: string;
  api: number;
  release: string;
  /** Publication month of this Android version, as YYYY-MM. */
  released: string;
  kind: AndroidImageKind;
  abi: AndroidAbi;
  /** Phone, TV, Wear or Automotive line. */
  family: AndroidImageFamily;
  /** Short label of the line ('' for phones). */
  familyLabel: string;
  packageName: string;
  /** Conservative planning estimate of the installed package (not an SDK guarantee). */
  imageBytes: number;
  /** Writable data partition that makes the device usable for real work. */
  recommendedDataBytes: number;
  googlePlay: boolean;
}

/**
 * Every system image the wizard can offer, described exactly as the Android SDK
 * repository publishes it: `system-images;android-<api>;<tag>;<abi>`.
 *
 * Coverage is deliberately wide - old releases for compatibility testing, the
 * current ones for daily work, and the TV / Wear / Automotive lines - because
 * the repository really does publish them. Whether a given entry can be
 * downloaded on this machine is confirmed at runtime against the local
 * `sdkmanager --list`; nothing here contacts the network.
 */
interface ReleaseSpec {
  api: number;
  release: string;
  name: string;
  /** When Google published this Android version, as YYYY-MM. */
  released: string;
  kinds: AndroidImageKind[];
  abis: AndroidAbi[];
  bytes: number;
  family?: AndroidImageFamily;
  /** Repository tag override for the non-phone lines (android-tv, android-wear...). */
  tag?: string;
}

const PHONE_RELEASES: ReleaseSpec[] = [
  { api: 36, released: '2025-06', release: '16', name: 'Android 16', kinds: ['google-play', 'google-apis', 'aosp'], abis: ['x86_64', 'arm64-v8a'], bytes: 5_200_000_000 },
  { api: 35, released: '2024-10', release: '15', name: 'Android 15', kinds: ['google-play', 'google-apis', 'aosp'], abis: ['x86_64', 'arm64-v8a'], bytes: 4_700_000_000 },
  { api: 34, released: '2023-10', release: '14', name: 'Android 14', kinds: ['google-play', 'google-apis', 'aosp'], abis: ['x86_64', 'arm64-v8a'], bytes: 4_300_000_000 },
  { api: 33, released: '2022-08', release: '13', name: 'Android 13', kinds: ['google-play', 'google-apis', 'aosp'], abis: ['x86_64', 'arm64-v8a'], bytes: 3_800_000_000 },
  { api: 32, released: '2022-03', release: '12L', name: 'Android 12L', kinds: ['google-play', 'google-apis', 'aosp'], abis: ['x86_64', 'arm64-v8a'], bytes: 3_500_000_000 },
  { api: 31, released: '2021-10', release: '12', name: 'Android 12', kinds: ['google-play', 'google-apis', 'aosp'], abis: ['x86_64', 'arm64-v8a'], bytes: 3_400_000_000 },
  { api: 30, released: '2020-09', release: '11', name: 'Android 11', kinds: ['google-play', 'google-apis', 'aosp'], abis: ['x86_64', 'arm64-v8a', 'x86'], bytes: 3_000_000_000 },
  { api: 29, released: '2019-09', release: '10', name: 'Android 10', kinds: ['google-play', 'google-apis', 'aosp'], abis: ['x86_64', 'arm64-v8a', 'x86'], bytes: 2_800_000_000 },
  { api: 28, released: '2018-08', release: '9', name: 'Android 9 Pie', kinds: ['google-play', 'google-apis', 'aosp'], abis: ['x86_64', 'arm64-v8a', 'x86'], bytes: 2_600_000_000 },
  { api: 27, released: '2017-12', release: '8.1', name: 'Android 8.1 Oreo', kinds: ['google-play', 'google-apis', 'aosp'], abis: ['x86_64', 'x86'], bytes: 2_400_000_000 },
  { api: 26, released: '2017-08', release: '8.0', name: 'Android 8.0 Oreo', kinds: ['google-play', 'google-apis', 'aosp'], abis: ['x86_64', 'x86'], bytes: 2_300_000_000 },
  { api: 25, released: '2016-12', release: '7.1', name: 'Android 7.1 Nougat', kinds: ['google-play', 'google-apis', 'aosp'], abis: ['x86_64', 'x86'], bytes: 2_100_000_000 },
  { api: 24, released: '2016-08', release: '7.0', name: 'Android 7.0 Nougat', kinds: ['google-play', 'google-apis', 'aosp'], abis: ['x86_64', 'x86'], bytes: 2_000_000_000 },
  { api: 23, released: '2015-10', release: '6.0', name: 'Android 6.0 Marshmallow', kinds: ['google-apis', 'aosp'], abis: ['x86_64', 'x86'], bytes: 1_900_000_000 },
  { api: 22, released: '2015-03', release: '5.1', name: 'Android 5.1 Lollipop', kinds: ['google-apis', 'aosp'], abis: ['x86_64', 'x86'], bytes: 1_800_000_000 },
  { api: 21, released: '2014-11', release: '5.0', name: 'Android 5.0 Lollipop', kinds: ['google-apis', 'aosp'], abis: ['x86_64', 'x86'], bytes: 1_700_000_000 },
];

const OTHER_RELEASES: ReleaseSpec[] = [
  { api: 34, released: '2023-10', release: '14', name: 'Android TV 14', kinds: ['google-apis'], abis: ['x86_64', 'arm64-v8a'], bytes: 3_400_000_000, family: 'tv', tag: 'android-tv' },
  { api: 33, released: '2022-08', release: '13', name: 'Android TV 13', kinds: ['google-apis'], abis: ['x86_64', 'arm64-v8a'], bytes: 3_200_000_000, family: 'tv', tag: 'android-tv' },
  { api: 31, released: '2021-10', release: '12', name: 'Android TV 12', kinds: ['google-apis'], abis: ['x86_64'], bytes: 3_000_000_000, family: 'tv', tag: 'android-tv' },
  { api: 34, released: '2023-10', release: '14', name: 'Wear OS 5', kinds: ['google-apis'], abis: ['x86_64', 'arm64-v8a'], bytes: 1_600_000_000, family: 'wear', tag: 'android-wear' },
  { api: 33, released: '2022-08', release: '13', name: 'Wear OS 4', kinds: ['google-apis'], abis: ['x86_64', 'arm64-v8a'], bytes: 1_500_000_000, family: 'wear', tag: 'android-wear' },
  { api: 30, released: '2020-09', release: '11', name: 'Wear OS 3', kinds: ['google-apis'], abis: ['x86_64'], bytes: 1_400_000_000, family: 'wear', tag: 'android-wear' },
  { api: 34, released: '2023-10', release: '14', name: 'Android Automotive 14', kinds: ['google-play'], abis: ['x86_64'], bytes: 3_600_000_000, family: 'automotive', tag: 'android-automotive-playstore' },
  { api: 33, released: '2022-08', release: '13', name: 'Android Automotive 13', kinds: ['google-apis'], abis: ['x86_64'], bytes: 3_400_000_000, family: 'automotive', tag: 'android-automotive' },
];

const RELEASES: ReleaseSpec[] = [...PHONE_RELEASES, ...OTHER_RELEASES];

const KIND_PACKAGE: Record<AndroidImageKind, string> = {
  'google-play': 'google_apis_playstore',
  'google-apis': 'google_apis',
  aosp: 'default',
};
const KIND_LABEL: Record<AndroidImageKind, string> = {
  'google-play': 'Google Play',
  'google-apis': 'Google APIs',
  aosp: 'AOSP',
};
const FAMILY_LABEL: Record<AndroidImageFamily, string> = {
  phone: '',
  tv: 'TV',
  wear: 'Wear',
  automotive: 'Automotive',
};

/** Every system image the wizard can offer, newest Android first. */
/**
 * Google Play images are published for fewer ABIs than the plain ones:
 * x86 for Android 7.0-8.1, arm64 from Android 9, x86_64 from Android 10.
 * Filtering here keeps the wizard from listing combinations that cannot exist.
 */
function playStoreAbi(api: number, abi: AndroidAbi): boolean {
  if (abi === 'x86_64') return api >= 29;
  if (abi === 'arm64-v8a') return api >= 28;
  if (abi === 'x86') return api >= 24 && api <= 28;
  return false;
}

export const ANDROID_SYSTEM_IMAGES: readonly AndroidSystemImage[] = RELEASES.flatMap((release) =>
  release.kinds.flatMap((kind) => release.abis.filter((abi) => kind !== 'google-play' || !!release.tag || playStoreAbi(release.api, abi)).map((abi): AndroidSystemImage => {
    const family = release.family ?? 'phone';
    // Non-phone lines carry their own repository tag; phones use the kind.
    const tag = release.tag ?? KIND_PACKAGE[kind];
    const suffix = family === 'phone' ? '' : `-${family}`;
    return {
      id: `api-${release.api}${suffix}-${kind}-${abi}`,
      label: `${release.name} (API ${release.api}) · ${KIND_LABEL[kind]} · ${abi}`,
      api: release.api,
      release: release.release,
      released: release.released,
      kind,
      abi,
      family,
      familyLabel: FAMILY_LABEL[family],
      packageName: `system-images;android-${release.api};${tag};${abi}`,
      // arm64 images are a touch larger, and Google Play images carry the store.
      imageBytes: release.bytes + (abi === 'arm64-v8a' ? 300_000_000 : 0) + (kind === 'google-play' ? 400_000_000 : 0),
      recommendedDataBytes: release.api >= 34 ? 8_000_000_000 : 6_000_000_000,
      googlePlay: tag.includes('playstore'),
    };
  })));

export function androidSystemImage(id: string): AndroidSystemImage | undefined {
  return ANDROID_SYSTEM_IMAGES.find((item) => item.id === id);
}

export function androidDevice(id: string): AndroidDeviceProfile | undefined {
  return ANDROID_CATALOG_DEVICES.find((item) => item.id === id);
}

export type AndroidPerformancePreset = 'light' | 'standard' | 'ultra' | 'custom';

export interface AndroidHardwareChoice {
  ramMb: number;
  heapMb: number;
  cores: number;
  dataGb: number;
  sdCardMb: number;
}

/**
 * Presets are only starting points for the sliders; "custom" keeps whatever the
 * user typed. Values are chosen so that "standard" runs on a normal laptop and
 * "ultra" uses a capable desktop without pretending to know the host's specs.
 */
export function androidPreset(preset: AndroidPerformancePreset, device: AndroidDeviceProfile, current?: AndroidHardwareChoice): AndroidHardwareChoice {
  if (preset === 'custom' && current) return current;
  if (preset === 'light') return { ramMb: 2048, heapMb: 256, cores: 2, dataGb: 4, sdCardMb: 0 };
  if (preset === 'ultra') return { ramMb: Math.max(8192, device.ramMb), heapMb: 1024, cores: 6, dataGb: 16, sdCardMb: 2048 };
  return { ramMb: device.ramMb, heapMb: 512, cores: 4, dataGb: 8, sdCardMb: 512 };
}

export interface AndroidSpaceEstimate {
  /** System image download/installation, inside the SDK folder. */
  imageBytes: number;
  /** Data partition reserved for the device folder. */
  dataBytes: number;
  /** Optional SD card image. */
  sdCardBytes: number;
  /** Snapshots roughly cost one RAM dump per saved state. */
  snapshotBytes: number;
  /** What the device folder itself will grow to. */
  deviceBytes: number;
  /** Device folder + (when the image still has to be installed) the image. */
  totalBytes: number;
}

/** Honest arithmetic for the "space this will take" box of the wizard. */
export function androidSpaceEstimate(input: {
  image: AndroidSystemImage; hardware: AndroidHardwareChoice; imageInstalled: boolean; snapshots: boolean;
}): AndroidSpaceEstimate {
  const dataBytes = Math.round(input.hardware.dataGb * 1_000_000_000);
  const sdCardBytes = Math.round(input.hardware.sdCardMb * 1_000_000);
  const snapshotBytes = input.snapshots ? Math.round(input.hardware.ramMb * 1_000_000 * 1.2) : 0;
  const deviceBytes = dataBytes + sdCardBytes + snapshotBytes;
  return {
    imageBytes: input.image.imageBytes,
    dataBytes,
    sdCardBytes,
    snapshotBytes,
    deviceBytes,
    totalBytes: deviceBytes + (input.imageInstalled ? 0 : input.image.imageBytes),
  };
}
