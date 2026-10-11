/**
 * apps/octobrowser/src/main/android-catalog.ts
 *
 * The specification catalogue behind the Android devices section: one complete
 * record per handset, covering identity, design, display, performance,
 * battery, cameras, connectivity, sensors and - most importantly for us - the
 * *emulator* settings for Android Studio's AVD engine, the only one supported.
 *
 * Two rules this file exists to enforce:
 *
 *  1. A phone's advertised storage is NOT the virtual disk. A 512 GB Pixel is
 *     still created as a ~32 GB virtual disk, and the three storage numbers
 *     (image download / virtual disk / free space inside Android) are kept
 *     separate everywhere they are shown.
 *  2. Every number here is a published specification or an honest planning
 *     estimate - never a value invented at runtime. Estimates are derived by
 *     the shared `build()` helper below, so they stay consistent.
 *
 * Pure data + pure functions: no filesystem, no network, no Electron.
 */

import {
  randomMac, randomImei, randomAndroidId, randomSerialNumber,
  randomPhoneNumber, randomSimProfile, type AndroidHardwareIdentity,
} from '@octo/core';

export type DeviceTier = 'low' | 'mid' | 'high' | 'flagship' | 'foldable' | 'tablet' | 'compact';
export type DeviceCategory = 'phone' | 'foldable' | 'flip' | 'tablet';
export type Illustration = 'phone' | 'foldable' | 'flip' | 'tablet';

export interface PhoneIdentity {
  manufacturer: string;
  commercialName: string;
  /** Human model name (for example "Pixel 9" or "Galaxy S24"). */
  modelName: string;
  /** Retail/regulatory SKU; some vendors expose this through Build.MODEL. */
  modelNumber: string;
  regionalVariants: string[];
  releaseDate: string;
  launchAndroid: string;
  currentAndroid: string;
  apiLevel: number;
  skin: string;
  category: DeviceCategory;
  realDevice: boolean;
  avdProfile: string;
}

export interface PhoneDesign {
  heightMm: number; widthMm: number; thicknessMm: number; weightG: number;
  frame: string; back: string; frontGlass: string; colors: string[]; ipRating: string;
  shape: string; cameraLayout: string; cameraBump: string; bezels: string; frontCamera: string;
  fingerprint: string; buttons: string; usb: string; headphoneJack: boolean; simTray: string;
  illustration: Illustration;
}

export interface PhoneDisplay {
  type: string; inches: number; width: number; height: number; aspectRatio: string; ppi: number;
  refreshHz: number; minRefreshHz: number; hdr: string; brightnessNits: number; touchSamplingHz: number;
  protection: string; alwaysOn: boolean; cornerRadiusDp: number; statusBarDp: number; navigationBarDp: number;
  emulatorWidth: number; emulatorHeight: number; emulatorDpi: number;
}

export interface PhonePerformance {
  chipset: string; chipsetVendor: string; processNm: number; cpuCores: number; cpuLayout: string;
  cpuMaxGhz: number; gpu: string; npu: string; ramOptionsGb: number[]; storageOptionsGb: number[];
  storageType: string; microSd: boolean; freeStorageGb: number; performanceClass: string; gamingClass: string;
}

export interface PhoneBattery {
  capacityMah: number; type: string; wiredW: number; wirelessW: number; reverseWireless: boolean;
  saverModes: string[]; screenOnHours: number; virtualCapacityMah: number; emulatorChargingStates: string[];
}

export interface PhoneCameras {
  rearCount: number; mainMp: number; mainSensorInch: string; mainAperture: string; ois: boolean;
  ultrawide: string; telephoto: string; periscope: string; macro: string; front: string;
  opticalZoom: string; digitalZoom: string; maxVideo: string; frameRates: string[]; slowMotion: string[];
  flash: string; features: string[];
}

export interface PhoneNetwork {
  g2: boolean; g3: boolean; lte: boolean; g5: boolean; wifi: string; bluetooth: string; nfc: boolean;
  gnss: string[]; usbVersion: string; dualSim: boolean; esim: boolean; hotspot: boolean;
  wifiCalling: boolean; volte: boolean; regionNotes: string;
}

export interface PhoneSensors {
  accelerometer: boolean; gyroscope: boolean; magnetometer: boolean; proximity: boolean; ambientLight: boolean;
  barometer: boolean; fingerprint: boolean; faceUnlock: boolean; temperature: boolean; hall: boolean;
  ultraWideband: boolean; cameraSensors: boolean;
  /** Which of the above the emulator can simulate. */
  simulatable: Record<string, boolean>;
}

/** What one device costs on this PC, and the resolution it is drawn at. */
export interface DeviceSizing {
  androidVersion: string; apiLevel: number; ramMb: number; cpus: number; storageGb: number;
  width: number; height: number; dpi: number; orientation: 'portrait' | 'landscape';
  googleApps: boolean; playStore: boolean; downloadBytes: number; diskBytes: number;
  runningRamMb: number; hostRamGb: number; hostCores: number; needsVirtualization: boolean;
}

export interface AvdSetup {
  device: string; systemImage: string; apiLevel: number; abi: string; ramMb: number; heapMb: number;
  cores: number; dataGb: number; sdCardMb: number; width: number; height: number; dpi: number;
  gpuMode: string; bootMode: string; playStore: boolean;
}

export interface StorageFootprint {
  /** What the emulator has to download for the Android image. */
  imageDownloadBytes: number;
  /** The faithful preset's virtual disk (the smallest listed retail SKU). */
  virtualDiskBytes: number;
  /** What is left for apps inside Android after the system occupies the disk. */
  freeInsideBytes: number;
  /** The phone's advertised storage, kept apart on purpose. */
  advertisedStorageGb: number;
}

export interface PhoneSpec {
  id: string;
  tier: DeviceTier;
  identity: PhoneIdentity;
  design: PhoneDesign;
  display: PhoneDisplay;
  performance: PhonePerformance;
  battery: PhoneBattery;
  cameras: PhoneCameras;
  network: PhoneNetwork;
  sensors: PhoneSensors;
  sizing: DeviceSizing;
  avd: AvdSetup;
  storage: StorageFootprint;
}

const GB = 1_000_000_000;

/** Android release names per API level, used for every "version" field. */
const RELEASES: Record<number, string> = { 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16' };
export const androidRelease = (api: number): string => RELEASES[api] ?? String(api);

/**
 * Emulator sizing per tier. This is the table that stops a 512 GB phone from
 * becoming a 512 GB virtual disk: the virtual device gets what an emulator
 * actually needs, and the advertised storage is reported separately.
 */
const TIERS: Record<DeviceTier, { ramMb: number; cpus: number; diskGb: number; hostRamGb: number; hostCores: number; runningRamMb: number }> = {
  low: { ramMb: 2048, cpus: 2, diskGb: 8, hostRamGb: 8, hostCores: 4, runningRamMb: 2600 },
  compact: { ramMb: 3072, cpus: 3, diskGb: 16, hostRamGb: 8, hostCores: 4, runningRamMb: 3600 },
  mid: { ramMb: 4096, cpus: 4, diskGb: 24, hostRamGb: 16, hostCores: 6, runningRamMb: 4800 },
  high: { ramMb: 6144, cpus: 4, diskGb: 32, hostRamGb: 16, hostCores: 8, runningRamMb: 6900 },
  flagship: { ramMb: 8192, cpus: 6, diskGb: 48, hostRamGb: 32, hostCores: 8, runningRamMb: 9000 },
  foldable: { ramMb: 8192, cpus: 6, diskGb: 48, hostRamGb: 32, hostCores: 8, runningRamMb: 9200 },
  tablet: { ramMb: 6144, cpus: 4, diskGb: 48, hostRamGb: 16, hostCores: 8, runningRamMb: 7000 },
};

/** Each Android release ships as one system image; the download scales with it. */
const IMAGE_DOWNLOAD: Record<number, number> = {
  31: 1_100_000_000, 32: 1_150_000_000, 33: 1_250_000_000, 34: 1_400_000_000, 35: 1_500_000_000, 36: 1_600_000_000,
};

interface Seed {
  id: string; brand: string; name: string; model: string; num: string; var: string[]; rel: string;
  la: number; api: number; skin: string; cat: DeviceCategory; tier: DeviceTier; avd: string; real?: boolean;
  dims: [number, number, number, number]; frame: string; back: string; glass: string; colors: string[]; ip: string;
  panel: string; inches: number; w: number; h: number; ppi: number; hz: number; minhz: number; nits: number; prot: string;
  chip: string; vendor: string; nm: number; cores: number; layout: string; ghz: number; gpu: string; npu: string;
  ram: number[]; store: number[]; stype: string; sd?: boolean;
  mah: number; wired: number; wireless: number; rev: boolean; sot: number;
  rear: number; mp: number; sensor: string; ap: string; ois: boolean; uw: string; tele: string; peri: string;
  macro: string; front: string; zoom: string; video: string;
  wifi: string; bt: string; nfc: boolean; usb: string; esim: boolean;
  fp: string; notch: string; camlayout: string; bump: string; bezels: string; jack: boolean; sim: string;
  baro: boolean; uwb: boolean; spen?: boolean; illus?: Illustration;
}

/** Greatest common divisor, for the honest aspect ratio of a panel. */
function ratio(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const factor = gcd(width, height) || 1;
  return `${Math.round(height / factor)}:${Math.round(width / factor)}`;
}

/**
 * Faithful preset: Android receives the handset panel's native pixel size and
 * density. Users may still lower these values explicitly on weak hosts, but a
 * newly selected phone no longer silently becomes a generic 1080p profile.
 */
function emulatorResolution(width: number, height: number, ppi: number): { width: number; height: number; dpi: number } {
  return { width, height, dpi: Math.max(120, Math.round(ppi)) };
}

function densityBucket(dpi: number): number {
  return Math.max(120, Math.round(dpi));
}

function build(seed: Seed): PhoneSpec {
  const tier = TIERS[seed.tier];
  const emulator = emulatorResolution(seed.w, seed.h, seed.ppi);
  const dpi = densityBucket(emulator.dpi);
  const real = seed.real !== false;
  const download = IMAGE_DOWNLOAD[seed.api] ?? 1_400_000_000;
  // Start with a real retail SKU rather than the old performance tier. The
  // lowest listed SKU is deterministic and avoids claiming RAM/storage that
  // the selected handset was never sold with. A user override remains honest:
  // Android then reports the resources actually allocated to that VM.
  const retailRamMb = seed.ram.length ? Math.min(...seed.ram) * 1024 : tier.ramMb;
  const retailStorageGb = seed.store.length ? Math.min(...seed.store) : tier.diskGb;
  const retailCores = seed.cores || tier.cpus;
  const diskBytes = retailStorageGb * GB;
  // Android itself occupies the first few GB of the virtual disk; the rest is
  // what the user actually sees as free space inside the phone.
  const systemBytes = Math.round(download * 2.2);
  const largestStorage = seed.store.length ? Math.max(...seed.store) : 0;
  const landscape = seed.cat === 'tablet';
  return {
    id: seed.id,
    tier: seed.tier,
    identity: {
      manufacturer: seed.brand,
      commercialName: seed.name,
      modelName: seed.model,
      modelNumber: seed.num,
      regionalVariants: seed.var,
      releaseDate: seed.rel,
      launchAndroid: `Android ${androidRelease(seed.la)}`,
      currentAndroid: `Android ${androidRelease(seed.api)}`,
      apiLevel: seed.api,
      skin: seed.skin,
      category: seed.cat,
      realDevice: real,
      avdProfile: seed.avd,
    },
    design: {
      heightMm: seed.dims[0], widthMm: seed.dims[1], thicknessMm: seed.dims[2], weightG: seed.dims[3],
      frame: seed.frame, back: seed.back, frontGlass: seed.glass, colors: seed.colors, ipRating: seed.ip,
      shape: seed.cat === 'flip' ? 'Clamshell foldable' : seed.cat === 'foldable' ? 'Book-style foldable' : seed.cat === 'tablet' ? 'Slate tablet' : 'Flat-edge slab',
      cameraLayout: seed.camlayout, cameraBump: seed.bump, bezels: seed.bezels, frontCamera: seed.notch,
      fingerprint: seed.fp,
      buttons: `Power${seed.fp.startsWith('Side') ? ' with fingerprint' : ''}, volume rocker${seed.spen ? ', S Pen slot' : ''}`,
      usb: seed.usb, headphoneJack: seed.jack, simTray: seed.sim,
      illustration: seed.illus ?? (seed.cat === 'tablet' ? 'tablet' : seed.cat === 'flip' ? 'flip' : seed.cat === 'foldable' ? 'foldable' : 'phone'),
    },
    display: {
      type: seed.panel, inches: seed.inches, width: seed.w, height: seed.h, aspectRatio: ratio(seed.w, seed.h),
      ppi: seed.ppi, refreshHz: seed.hz, minRefreshHz: seed.minhz,
      hdr: seed.panel.includes('OLED') ? 'HDR10+ / Dolby Vision where supported' : 'HDR10',
      brightnessNits: seed.nits, touchSamplingHz: seed.hz >= 120 ? 240 : 120, protection: seed.prot,
      alwaysOn: seed.panel.includes('OLED') || seed.panel.includes('AMOLED'),
      cornerRadiusDp: seed.cat === 'tablet' ? 12 : 28, statusBarDp: 24, navigationBarDp: 48,
      emulatorWidth: emulator.width, emulatorHeight: emulator.height, emulatorDpi: dpi,
    },
    performance: {
      chipset: seed.chip, chipsetVendor: seed.vendor, processNm: seed.nm, cpuCores: seed.cores, cpuLayout: seed.layout,
      cpuMaxGhz: seed.ghz, gpu: seed.gpu, npu: seed.npu, ramOptionsGb: seed.ram, storageOptionsGb: seed.store,
      storageType: seed.stype, microSd: seed.sd === true,
      // What is left of the phone's own storage once Android and preloads land.
      freeStorageGb: seed.store.length ? Math.max(1, Math.round(Math.min(...seed.store) * 0.88 - 12)) : 0,
      performanceClass: seed.tier === 'low' ? 'Entry level' : seed.tier === 'mid' ? 'Upper mid-range' : seed.tier === 'flagship' || seed.tier === 'foldable' ? 'Flagship' : 'High end',
      gamingClass: seed.tier === 'low' ? 'Casual titles at 30 fps' : seed.tier === 'mid' ? 'Most titles at medium settings' : 'Demanding titles at high settings',
    },
    battery: {
      capacityMah: seed.mah, type: 'Li-Po, non-removable', wiredW: seed.wired, wirelessW: seed.wireless,
      reverseWireless: seed.rev,
      saverModes: ['Battery Saver', 'Adaptive Battery', 'Extreme saver'],
      screenOnHours: seed.sot, virtualCapacityMah: seed.mah,
      emulatorChargingStates: ['Discharging', 'Charging (AC)', 'Charging (USB)', 'Full', 'Not charging'],
    },
    cameras: {
      rearCount: seed.rear, mainMp: seed.mp, mainSensorInch: seed.sensor, mainAperture: seed.ap, ois: seed.ois,
      ultrawide: seed.uw || 'Not present', telephoto: seed.tele || 'Not present', periscope: seed.peri || 'Not present',
      macro: seed.macro || 'Not present', front: seed.front, opticalZoom: seed.zoom, digitalZoom: seed.zoom,
      maxVideo: seed.video, frameRates: ['24 fps', '30 fps', '60 fps', ...(seed.tier === 'flagship' || seed.tier === 'foldable' ? ['120 fps'] : [])],
      slowMotion: seed.tier === 'low' ? ['120 fps at 720p'] : ['240 fps at 1080p', '960 fps at 720p'],
      flash: 'Dual-LED, dual tone',
      features: ['Night mode', 'Portrait mode', 'HDR', 'Panorama', 'Pro/manual mode', ...(seed.ois ? ['Optical stabilisation'] : [])],
    },
    network: {
      g2: true, g3: true, lte: true, g5: seed.tier !== 'low' || seed.api >= 34,
      wifi: seed.wifi, bluetooth: seed.bt, nfc: seed.nfc,
      gnss: ['GPS', 'GLONASS', 'Galileo', 'BeiDou', ...(seed.tier === 'flagship' ? ['QZSS'] : [])],
      usbVersion: seed.usb, dualSim: seed.sim.toLowerCase().includes('dual'), esim: seed.esim,
      hotspot: true, wifiCalling: true, volte: true,
      regionNotes: real ? 'Band support and mmWave 5G depend on the regional model variant.' : 'Generic profile: no carrier-specific bands.',
    },
    sensors: {
      accelerometer: true, gyroscope: seed.tier !== 'low', magnetometer: true, proximity: true, ambientLight: true,
      barometer: seed.baro, fingerprint: true, faceUnlock: true, temperature: false, hall: seed.cat !== 'phone',
      ultraWideband: seed.uwb, cameraSensors: true,
      // The emulator simulates position, rotation and environment values; a real
      // fingerprint reader or UWB radio has no virtual equivalent.
      simulatable: {
        accelerometer: true, gyroscope: true, magnetometer: true, proximity: true, ambientLight: true,
        barometer: true, fingerprint: false, faceUnlock: false, temperature: false, hall: false,
        ultraWideband: false, cameraSensors: true,
      },
    },
    sizing: {
      androidVersion: `Android ${androidRelease(seed.api)}`,
      apiLevel: seed.api,
      ramMb: retailRamMb, cpus: retailCores, storageGb: retailStorageGb,
      width: emulator.width, height: emulator.height, dpi,
      orientation: landscape ? 'landscape' : 'portrait',
      googleApps: true, playStore: true,
      downloadBytes: download, diskBytes, runningRamMb: tier.runningRamMb,
      hostRamGb: tier.hostRamGb, hostCores: tier.hostCores, needsVirtualization: true,
    },
    avd: {
      device: seed.avd,
      systemImage: `system-images;android-${seed.api};google_apis_playstore;x86_64`,
      apiLevel: seed.api, abi: 'x86_64', ramMb: retailRamMb, heapMb: Math.max(256, Math.round(retailRamMb / 8)),
      cores: retailCores, dataGb: retailStorageGb, sdCardMb: seed.sd ? 2048 : 512,
      width: emulator.width, height: emulator.height, dpi,
      gpuMode: 'auto', bootMode: 'quick', playStore: true,
    },
    storage: {
      imageDownloadBytes: download,
      virtualDiskBytes: diskBytes,
      freeInsideBytes: Math.max(GB, diskBytes - systemBytes),
      advertisedStorageGb: largestStorage,
    },
  };
}

const SEEDS: Seed[] = [
  { id: 'pixel-9', brand: 'Google', name: 'Pixel 9', model: 'Pixel 9', num: 'GZPF0', var: ['GUL82', 'G6GPR'], rel: '2024-08-22', la: 34, api: 35, skin: 'Pixel UI', cat: 'phone', tier: 'flagship', avd: 'pixel_9', dims: [152.8, 72.0, 8.5, 198], frame: 'Aluminium', back: 'Matte glass', glass: 'Corning Gorilla Glass Victus 2', colors: ['Obsidian', 'Porcelain', 'Wintergreen', 'Peony'], ip: 'IP68', panel: 'Actua OLED', inches: 6.3, w: 1080, h: 2424, ppi: 422, hz: 120, minhz: 60, nits: 2700, prot: 'Gorilla Glass Victus 2', chip: 'Google Tensor G4', vendor: 'Google', nm: 4, cores: 8, layout: '1x3.1 GHz Cortex-X4 + 3x2.6 GHz Cortex-A720 + 4x1.95 GHz Cortex-A520', ghz: 3.1, gpu: 'Mali-G715 MC7', npu: 'Google Tensor TPU', ram: [12], store: [128, 256], stype: 'UFS 3.1', mah: 4700, wired: 27, wireless: 15, rev: true, sot: 6.5, rear: 2, mp: 50, sensor: '1/1.31"', ap: 'f/1.68', ois: true, uw: '48 MP f/1.7 ultrawide, 123 degrees', tele: '', peri: '', macro: 'Macro Focus via ultrawide', front: '10.5 MP f/2.2', zoom: '2x optical quality (sensor crop)', video: '4K at 60 fps (8K upscale via Video Boost)', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.3', nfc: true, usb: 'USB-C 3.2 Gen 2', esim: true, fp: 'Under-display ultrasonic', notch: 'Centred punch-hole', camlayout: 'Horizontal camera bar', bump: 'Raised camera bar', bezels: 'Uniform slim', jack: false, sim: 'Left edge nano-SIM + eSIM', baro: true, uwb: false },
  { id: 'pixel-9-pro', brand: 'Google', name: 'Pixel 9 Pro', model: 'Pixel 9 Pro', num: 'GE2AE', var: ['G0DZQ', 'GWVK6'], rel: '2024-09-04', la: 34, api: 35, skin: 'Pixel UI', cat: 'phone', tier: 'flagship', avd: 'pixel_9_pro', dims: [152.8, 72.0, 8.5, 199], frame: 'Polished aluminium', back: 'Matte glass', glass: 'Corning Gorilla Glass Victus 2', colors: ['Obsidian', 'Porcelain', 'Hazel', 'Rose Quartz'], ip: 'IP68', panel: 'Super Actua LTPO OLED', inches: 6.3, w: 1280, h: 2856, ppi: 495, hz: 120, minhz: 1, nits: 3000, prot: 'Gorilla Glass Victus 2', chip: 'Google Tensor G4', vendor: 'Google', nm: 4, cores: 8, layout: '1x3.1 GHz Cortex-X4 + 3x2.6 GHz Cortex-A720 + 4x1.95 GHz Cortex-A520', ghz: 3.1, gpu: 'Mali-G715 MC7', npu: 'Google Tensor TPU', ram: [16], store: [128, 256, 512, 1024], stype: 'UFS 3.1', mah: 4700, wired: 27, wireless: 21, rev: true, sot: 6.5, rear: 3, mp: 50, sensor: '1/1.31"', ap: 'f/1.68', ois: true, uw: '48 MP f/1.7 ultrawide, 123 degrees', tele: '48 MP f/2.8 telephoto, 5x optical', peri: '48 MP periscope telephoto', macro: 'Macro Focus via ultrawide', front: '42 MP f/2.2 autofocus', zoom: '5x optical, 30x Super Res Zoom', video: '8K at 30 fps via Video Boost, 4K at 60 fps', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.3', nfc: true, usb: 'USB-C 3.2 Gen 2', esim: true, fp: 'Under-display ultrasonic', notch: 'Centred punch-hole', camlayout: 'Horizontal camera bar', bump: 'Raised camera bar', bezels: 'Uniform slim', jack: false, sim: 'Left edge nano-SIM + eSIM', baro: true, uwb: true },
  { id: 'pixel-9-pro-xl', brand: 'Google', name: 'Pixel 9 Pro XL', model: 'Pixel 9 Pro XL', num: 'GBTX9', var: ['G8TL8', 'GQ57S'], rel: '2024-08-22', la: 34, api: 35, skin: 'Pixel UI', cat: 'phone', tier: 'flagship', avd: 'pixel_9_pro_xl', dims: [162.8, 76.6, 8.5, 221], frame: 'Polished aluminium', back: 'Matte glass', glass: 'Corning Gorilla Glass Victus 2', colors: ['Obsidian', 'Porcelain', 'Hazel', 'Rose Quartz'], ip: 'IP68', panel: 'Super Actua LTPO OLED', inches: 6.8, w: 1344, h: 2992, ppi: 486, hz: 120, minhz: 1, nits: 3000, prot: 'Gorilla Glass Victus 2', chip: 'Google Tensor G4', vendor: 'Google', nm: 4, cores: 8, layout: '1x3.1 GHz Cortex-X4 + 3x2.6 GHz Cortex-A720 + 4x1.95 GHz Cortex-A520', ghz: 3.1, gpu: 'Mali-G715 MC7', npu: 'Google Tensor TPU', ram: [16], store: [128, 256, 512, 1024], stype: 'UFS 3.1', mah: 5060, wired: 37, wireless: 23, rev: true, sot: 7.0, rear: 3, mp: 50, sensor: '1/1.31"', ap: 'f/1.68', ois: true, uw: '48 MP f/1.7 ultrawide, 123 degrees', tele: '48 MP f/2.8 telephoto, 5x optical', peri: '48 MP periscope telephoto', macro: 'Macro Focus via ultrawide', front: '42 MP f/2.2 autofocus', zoom: '5x optical, 30x Super Res Zoom', video: '8K at 30 fps via Video Boost, 4K at 60 fps', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.3', nfc: true, usb: 'USB-C 3.2 Gen 2', esim: true, fp: 'Under-display ultrasonic', notch: 'Centred punch-hole', camlayout: 'Horizontal camera bar', bump: 'Raised camera bar', bezels: 'Uniform slim', jack: false, sim: 'Left edge nano-SIM + eSIM', baro: true, uwb: true },
  { id: 'pixel-9-pro-fold', brand: 'Google', name: 'Pixel 9 Pro Fold', model: 'Pixel 9 Pro Fold', num: 'GKW54', var: ['G0B96'], rel: '2024-09-04', la: 34, api: 35, skin: 'Pixel UI', cat: 'foldable', tier: 'foldable', avd: 'pixel_fold', dims: [155.2, 150.2, 5.1, 257], frame: 'Aluminium', back: 'Matte glass', glass: 'Corning Gorilla Glass Victus 2', colors: ['Obsidian', 'Porcelain'], ip: 'IPX8', panel: 'Super Actua Flex LTPO OLED (inner)', inches: 8.0, w: 2076, h: 2152, ppi: 373, hz: 120, minhz: 1, nits: 2700, prot: 'Ultra-thin glass (inner), Gorilla Glass Victus 2 (cover)', chip: 'Google Tensor G4', vendor: 'Google', nm: 4, cores: 8, layout: '1x3.1 GHz Cortex-X4 + 3x2.6 GHz Cortex-A720 + 4x1.95 GHz Cortex-A520', ghz: 3.1, gpu: 'Mali-G715 MC7', npu: 'Google Tensor TPU', ram: [16], store: [256, 512], stype: 'UFS 3.1', mah: 4650, wired: 21, wireless: 7.5, rev: false, sot: 6.0, rear: 3, mp: 48, sensor: '1/2"', ap: 'f/1.7', ois: true, uw: '10.5 MP f/2.2 ultrawide, 127 degrees', tele: '10.8 MP f/3.1, 5x optical', peri: '', macro: 'Macro Focus via ultrawide', front: '10 MP cover + 10 MP inner', zoom: '5x optical, 20x Super Res Zoom', video: '4K at 60 fps', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.3', nfc: true, usb: 'USB-C 3.2 Gen 2', esim: true, fp: 'Side-mounted capacitive', notch: 'Punch-hole on both screens', camlayout: 'Horizontal camera bar', bump: 'Raised camera bar', bezels: 'Slim with hinge', jack: false, sim: 'eSIM + nano-SIM', baro: true, uwb: true },
  { id: 'pixel-8', brand: 'Google', name: 'Pixel 8', model: 'Pixel 8', num: 'GKWS6', var: ['G9BQD', 'GPJ41'], rel: '2023-10-12', la: 34, api: 35, skin: 'Pixel UI', cat: 'phone', tier: 'high', avd: 'pixel_8', dims: [150.5, 70.8, 8.9, 187], frame: 'Aluminium', back: 'Glossy glass', glass: 'Corning Gorilla Glass Victus', colors: ['Obsidian', 'Hazel', 'Rose', 'Mint'], ip: 'IP68', panel: 'Actua OLED', inches: 6.2, w: 1080, h: 2400, ppi: 428, hz: 120, minhz: 60, nits: 2000, prot: 'Gorilla Glass Victus', chip: 'Google Tensor G3', vendor: 'Google', nm: 4, cores: 9, layout: '1x3.0 GHz Cortex-X3 + 4x2.45 GHz Cortex-A715 + 4x2.15 GHz Cortex-A510', ghz: 3.0, gpu: 'Immortalis-G715s MC10', npu: 'Google Tensor TPU', ram: [8], store: [128, 256], stype: 'UFS 3.1', mah: 4575, wired: 27, wireless: 18, rev: true, sot: 6.0, rear: 2, mp: 50, sensor: '1/1.31"', ap: 'f/1.68', ois: true, uw: '12 MP f/2.2 ultrawide, 125.8 degrees', tele: '', peri: '', macro: 'Macro Focus via ultrawide', front: '10.5 MP f/2.2', zoom: '8x Super Res Zoom', video: '4K at 60 fps', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.3', nfc: true, usb: 'USB-C 3.2 Gen 2', esim: true, fp: 'Under-display optical', notch: 'Centred punch-hole', camlayout: 'Horizontal camera bar', bump: 'Raised camera bar', bezels: 'Uniform slim', jack: false, sim: 'Left edge nano-SIM + eSIM', baro: true, uwb: false },
  { id: 'pixel-8-pro', brand: 'Google', name: 'Pixel 8 Pro', model: 'Pixel 8 Pro', num: 'GC3VE', var: ['G1MNW', 'GE9DP'], rel: '2023-10-12', la: 34, api: 35, skin: 'Pixel UI', cat: 'phone', tier: 'flagship', avd: 'pixel_8_pro', dims: [162.6, 76.5, 8.8, 213], frame: 'Polished aluminium', back: 'Matte glass', glass: 'Corning Gorilla Glass Victus 2', colors: ['Obsidian', 'Porcelain', 'Bay', 'Mint'], ip: 'IP68', panel: 'Super Actua LTPO OLED', inches: 6.7, w: 1344, h: 2992, ppi: 489, hz: 120, minhz: 1, nits: 2400, prot: 'Gorilla Glass Victus 2', chip: 'Google Tensor G3', vendor: 'Google', nm: 4, cores: 9, layout: '1x3.0 GHz Cortex-X3 + 4x2.45 GHz Cortex-A715 + 4x2.15 GHz Cortex-A510', ghz: 3.0, gpu: 'Immortalis-G715s MC10', npu: 'Google Tensor TPU', ram: [12], store: [128, 256, 512, 1024], stype: 'UFS 3.1', mah: 5050, wired: 30, wireless: 23, rev: true, sot: 6.5, rear: 3, mp: 50, sensor: '1/1.31"', ap: 'f/1.68', ois: true, uw: '48 MP f/1.95 ultrawide, 125.5 degrees', tele: '48 MP f/2.8, 5x optical', peri: '48 MP periscope telephoto', macro: 'Macro Focus via ultrawide', front: '10.5 MP f/2.2 autofocus', zoom: '5x optical, 30x Super Res Zoom', video: '4K at 60 fps', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.3', nfc: true, usb: 'USB-C 3.2 Gen 2', esim: true, fp: 'Under-display optical', notch: 'Centred punch-hole', camlayout: 'Horizontal camera bar', bump: 'Raised camera bar', bezels: 'Uniform slim', jack: false, sim: 'Left edge nano-SIM + eSIM', baro: true, uwb: true },
  { id: 'pixel-8a', brand: 'Google', name: 'Pixel 8a', model: 'Pixel 8a', num: 'G6GPR', var: ['G576D', 'G8HHN'], rel: '2024-05-14', la: 34, api: 35, skin: 'Pixel UI', cat: 'phone', tier: 'mid', avd: 'pixel_8a', dims: [152.1, 72.7, 8.9, 188], frame: 'Aluminium', back: 'Composite matte', glass: 'Corning Gorilla Glass 3', colors: ['Obsidian', 'Porcelain', 'Bay', 'Aloe'], ip: 'IP67', panel: 'Actua OLED', inches: 6.1, w: 1080, h: 2400, ppi: 430, hz: 120, minhz: 60, nits: 2000, prot: 'Gorilla Glass 3', chip: 'Google Tensor G3', vendor: 'Google', nm: 4, cores: 9, layout: '1x3.0 GHz Cortex-X3 + 4x2.45 GHz Cortex-A715 + 4x2.15 GHz Cortex-A510', ghz: 3.0, gpu: 'Immortalis-G715s MC10', npu: 'Google Tensor TPU', ram: [8], store: [128, 256], stype: 'UFS 3.1', mah: 4492, wired: 18, wireless: 7.5, rev: false, sot: 6.0, rear: 2, mp: 64, sensor: '1/1.73"', ap: 'f/1.89', ois: true, uw: '13 MP f/2.2 ultrawide, 120 degrees', tele: '', peri: '', macro: '', front: '13 MP f/2.2', zoom: '8x Super Res Zoom', video: '4K at 60 fps', wifi: 'Wi-Fi 6E', bt: '5.3', nfc: true, usb: 'USB-C 3.2 Gen 1', esim: true, fp: 'Under-display optical', notch: 'Centred punch-hole', camlayout: 'Horizontal camera bar', bump: 'Raised camera bar', bezels: 'Slim with chin', jack: false, sim: 'Left edge nano-SIM + eSIM', baro: false, uwb: false },
  { id: 'galaxy-s24', brand: 'Samsung', name: 'Galaxy S24', model: 'Galaxy S24', num: 'SM-S921B', var: ['SM-S921U', 'SM-S9210'], rel: '2024-01-31', la: 34, api: 35, skin: 'One UI 7', cat: 'phone', tier: 'flagship', avd: 'pixel_8', dims: [147.0, 70.6, 7.6, 167], frame: 'Armor Aluminum', back: 'Gorilla Glass Victus 2', glass: 'Corning Gorilla Glass Victus 2', colors: ['Onyx Black', 'Marble Gray', 'Cobalt Violet', 'Amber Yellow'], ip: 'IP68', panel: 'Dynamic AMOLED 2X LTPO', inches: 6.2, w: 1080, h: 2340, ppi: 416, hz: 120, minhz: 1, nits: 2600, prot: 'Gorilla Glass Victus 2', chip: 'Exynos 2400 / Snapdragon 8 Gen 3', vendor: 'Samsung / Qualcomm', nm: 4, cores: 10, layout: '1x3.2 GHz Cortex-X4 + 2x2.9 GHz + 3x2.6 GHz + 4x1.95 GHz', ghz: 3.2, gpu: 'Xclipse 940 / Adreno 750', npu: 'Samsung NPU', ram: [8], store: [128, 256, 512], stype: 'UFS 4.0', mah: 4000, wired: 25, wireless: 15, rev: true, sot: 6.0, rear: 3, mp: 50, sensor: '1/1.56"', ap: 'f/1.8', ois: true, uw: '12 MP f/2.2 ultrawide, 120 degrees', tele: '10 MP f/2.4, 3x optical', peri: '', macro: '', front: '12 MP f/2.2 autofocus', zoom: '3x optical, 30x Space Zoom', video: '8K at 30 fps, 4K at 60 fps', wifi: 'Wi-Fi 6E', bt: '5.3', nfc: true, usb: 'USB-C 3.2 Gen 1', esim: true, fp: 'Under-display ultrasonic', notch: 'Centred punch-hole', camlayout: 'Vertical floating lenses', bump: 'Individual lens rings', bezels: 'Uniform slim', jack: false, sim: 'Nano-SIM + eSIM', baro: true, uwb: false },
  { id: 'galaxy-s24-plus', brand: 'Samsung', name: 'Galaxy S24+', model: 'Galaxy S24 Plus', num: 'SM-S926B', var: ['SM-S926U', 'SM-S9260'], rel: '2024-01-31', la: 34, api: 35, skin: 'One UI 7', cat: 'phone', tier: 'flagship', avd: 'pixel_8_pro', dims: [158.5, 75.9, 7.7, 196], frame: 'Armor Aluminum', back: 'Gorilla Glass Victus 2', glass: 'Corning Gorilla Glass Victus 2', colors: ['Onyx Black', 'Marble Gray', 'Cobalt Violet', 'Amber Yellow'], ip: 'IP68', panel: 'Dynamic AMOLED 2X LTPO', inches: 6.7, w: 1440, h: 3120, ppi: 513, hz: 120, minhz: 1, nits: 2600, prot: 'Gorilla Glass Victus 2', chip: 'Exynos 2400 / Snapdragon 8 Gen 3', vendor: 'Samsung / Qualcomm', nm: 4, cores: 10, layout: '1x3.2 GHz Cortex-X4 + 2x2.9 GHz + 3x2.6 GHz + 4x1.95 GHz', ghz: 3.2, gpu: 'Xclipse 940 / Adreno 750', npu: 'Samsung NPU', ram: [12], store: [256, 512], stype: 'UFS 4.0', mah: 4900, wired: 45, wireless: 15, rev: true, sot: 6.5, rear: 3, mp: 50, sensor: '1/1.56"', ap: 'f/1.8', ois: true, uw: '12 MP f/2.2 ultrawide, 120 degrees', tele: '10 MP f/2.4, 3x optical', peri: '', macro: '', front: '12 MP f/2.2 autofocus', zoom: '3x optical, 30x Space Zoom', video: '8K at 30 fps, 4K at 60 fps', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.3', nfc: true, usb: 'USB-C 3.2 Gen 1', esim: true, fp: 'Under-display ultrasonic', notch: 'Centred punch-hole', camlayout: 'Vertical floating lenses', bump: 'Individual lens rings', bezels: 'Uniform slim', jack: false, sim: 'Nano-SIM + eSIM', baro: true, uwb: true },
  { id: 'galaxy-s24-ultra', brand: 'Samsung', name: 'Galaxy S24 Ultra', model: 'Galaxy S24 Ultra', num: 'SM-S928B', var: ['SM-S928U', 'SM-S9280'], rel: '2024-01-31', la: 34, api: 35, skin: 'One UI 7', cat: 'phone', tier: 'flagship', avd: 'pixel_8_pro', dims: [162.3, 79.0, 8.6, 232], frame: 'Titanium', back: 'Gorilla Armor glass', glass: 'Corning Gorilla Armor', colors: ['Titanium Black', 'Titanium Gray', 'Titanium Violet', 'Titanium Yellow'], ip: 'IP68', panel: 'Dynamic AMOLED 2X LTPO', inches: 6.8, w: 1440, h: 3120, ppi: 505, hz: 120, minhz: 1, nits: 2600, prot: 'Corning Gorilla Armor', chip: 'Snapdragon 8 Gen 3 for Galaxy', vendor: 'Qualcomm', nm: 4, cores: 8, layout: '1x3.39 GHz Cortex-X4 + 3x3.1 GHz + 2x2.9 GHz + 2x2.2 GHz', ghz: 3.39, gpu: 'Adreno 750', npu: 'Hexagon NPU', ram: [12], store: [256, 512, 1024], stype: 'UFS 4.0', mah: 5000, wired: 45, wireless: 15, rev: true, sot: 7.0, rear: 4, mp: 200, sensor: '1/1.3"', ap: 'f/1.7', ois: true, uw: '12 MP f/2.2 ultrawide, 120 degrees', tele: '10 MP f/2.4, 3x optical', peri: '50 MP f/3.4 periscope, 5x optical', macro: '', front: '12 MP f/2.2 autofocus', zoom: '5x optical, 100x Space Zoom', video: '8K at 30 fps, 4K at 120 fps', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.3', nfc: true, usb: 'USB-C 3.2 Gen 2', esim: true, fp: 'Under-display ultrasonic', notch: 'Centred punch-hole', camlayout: 'Vertical floating lenses', bump: 'Individual lens rings', bezels: 'Flat, very slim', jack: false, sim: 'Nano-SIM + eSIM', baro: true, uwb: true, spen: true },
  { id: 'galaxy-s23', brand: 'Samsung', name: 'Galaxy S23', model: 'Galaxy S23', num: 'SM-S911B', var: ['SM-S911U', 'SM-S9110'], rel: '2023-02-17', la: 33, api: 35, skin: 'One UI 7', cat: 'phone', tier: 'high', avd: 'pixel_7', dims: [146.3, 70.9, 7.6, 168], frame: 'Armor Aluminum', back: 'Gorilla Glass Victus 2', glass: 'Corning Gorilla Glass Victus 2', colors: ['Phantom Black', 'Cream', 'Green', 'Lavender'], ip: 'IP68', panel: 'Dynamic AMOLED 2X', inches: 6.1, w: 1080, h: 2340, ppi: 425, hz: 120, minhz: 48, nits: 1750, prot: 'Gorilla Glass Victus 2', chip: 'Snapdragon 8 Gen 2 for Galaxy', vendor: 'Qualcomm', nm: 4, cores: 8, layout: '1x3.36 GHz Cortex-X3 + 2x2.8 GHz + 2x2.8 GHz + 3x2.0 GHz', ghz: 3.36, gpu: 'Adreno 740', npu: 'Hexagon NPU', ram: [8], store: [128, 256, 512], stype: 'UFS 3.1 / 4.0', mah: 3900, wired: 25, wireless: 15, rev: true, sot: 6.0, rear: 3, mp: 50, sensor: '1/1.56"', ap: 'f/1.8', ois: true, uw: '12 MP f/2.2 ultrawide, 120 degrees', tele: '10 MP f/2.4, 3x optical', peri: '', macro: '', front: '12 MP f/2.2 autofocus', zoom: '3x optical, 30x Space Zoom', video: '8K at 30 fps, 4K at 60 fps', wifi: 'Wi-Fi 6E', bt: '5.3', nfc: true, usb: 'USB-C 3.2 Gen 1', esim: true, fp: 'Under-display ultrasonic', notch: 'Centred punch-hole', camlayout: 'Vertical floating lenses', bump: 'Individual lens rings', bezels: 'Uniform slim', jack: false, sim: 'Nano-SIM + eSIM', baro: true, uwb: false },
  { id: 'galaxy-s23-ultra', brand: 'Samsung', name: 'Galaxy S23 Ultra', model: 'Galaxy S23 Ultra', num: 'SM-S918B', var: ['SM-S918U', 'SM-S9180'], rel: '2023-02-17', la: 33, api: 35, skin: 'One UI 7', cat: 'phone', tier: 'flagship', avd: 'pixel_8_pro', dims: [163.4, 78.1, 8.9, 234], frame: 'Armor Aluminum', back: 'Gorilla Glass Victus 2', glass: 'Corning Gorilla Glass Victus 2', colors: ['Phantom Black', 'Cream', 'Green', 'Lavender'], ip: 'IP68', panel: 'Dynamic AMOLED 2X LTPO', inches: 6.8, w: 1440, h: 3088, ppi: 500, hz: 120, minhz: 1, nits: 1750, prot: 'Gorilla Glass Victus 2', chip: 'Snapdragon 8 Gen 2 for Galaxy', vendor: 'Qualcomm', nm: 4, cores: 8, layout: '1x3.36 GHz Cortex-X3 + 2x2.8 GHz + 2x2.8 GHz + 3x2.0 GHz', ghz: 3.36, gpu: 'Adreno 740', npu: 'Hexagon NPU', ram: [8, 12], store: [256, 512, 1024], stype: 'UFS 4.0', mah: 5000, wired: 45, wireless: 15, rev: true, sot: 7.0, rear: 4, mp: 200, sensor: '1/1.3"', ap: 'f/1.7', ois: true, uw: '12 MP f/2.2 ultrawide, 120 degrees', tele: '10 MP f/2.4, 3x optical', peri: '10 MP f/4.9 periscope, 10x optical', macro: '', front: '12 MP f/2.2 autofocus', zoom: '10x optical, 100x Space Zoom', video: '8K at 30 fps, 4K at 60 fps', wifi: 'Wi-Fi 6E', bt: '5.3', nfc: true, usb: 'USB-C 3.2 Gen 2', esim: true, fp: 'Under-display ultrasonic', notch: 'Centred punch-hole', camlayout: 'Vertical floating lenses', bump: 'Individual lens rings', bezels: 'Curved, slim', jack: false, sim: 'Nano-SIM + eSIM', baro: true, uwb: true, spen: true },
  { id: 'galaxy-a55', brand: 'Samsung', name: 'Galaxy A55', model: 'Galaxy A55 5G', num: 'SM-A556B', var: ['SM-A5560', 'SM-A556E'], rel: '2024-03-11', la: 34, api: 35, skin: 'One UI 7', cat: 'phone', tier: 'mid', avd: 'pixel_7a', dims: [161.1, 77.4, 8.2, 213], frame: 'Aluminium', back: 'Gorilla Glass Victus+', glass: 'Corning Gorilla Glass Victus+', colors: ['Awesome Iceblue', 'Awesome Lilac', 'Awesome Navy', 'Awesome Lemon'], ip: 'IP67', panel: 'Super AMOLED', inches: 6.6, w: 1080, h: 2340, ppi: 390, hz: 120, minhz: 60, nits: 1000, prot: 'Gorilla Glass Victus+', chip: 'Exynos 1480', vendor: 'Samsung', nm: 4, cores: 8, layout: '4x2.75 GHz Cortex-A78 + 4x2.0 GHz Cortex-A55', ghz: 2.75, gpu: 'Xclipse 530', npu: 'Samsung NPU', ram: [8, 12], store: [128, 256], stype: 'UFS 3.1', sd: true, mah: 5000, wired: 25, wireless: 0, rev: false, sot: 7.5, rear: 3, mp: 50, sensor: '1/1.56"', ap: 'f/1.8', ois: true, uw: '12 MP f/2.2 ultrawide, 123 degrees', tele: '', peri: '', macro: '5 MP f/2.4 macro', front: '32 MP f/2.2', zoom: '10x digital', video: '4K at 30 fps', wifi: 'Wi-Fi 6', bt: '5.3', nfc: true, usb: 'USB-C 2.0', esim: false, fp: 'Under-display optical', notch: 'Centred punch-hole', camlayout: 'Vertical floating lenses', bump: 'Individual lens rings', bezels: 'Slim with chin', jack: false, sim: 'Dual nano-SIM + microSD', baro: false, uwb: false },
  { id: 'galaxy-z-flip-6', brand: 'Samsung', name: 'Galaxy Z Flip 6', model: 'Galaxy Z Flip6', num: 'SM-F741B', var: ['SM-F741U', 'SM-F7410'], rel: '2024-07-24', la: 34, api: 35, skin: 'One UI 7', cat: 'flip', tier: 'foldable', avd: 'pixel_fold', dims: [165.1, 71.9, 6.9, 187], frame: 'Armor Aluminum', back: 'Gorilla Glass Victus 2', glass: 'Corning Gorilla Glass Victus 2', colors: ['Silver Shadow', 'Yellow', 'Blue', 'Mint'], ip: 'IP48', panel: 'Dynamic AMOLED 2X LTPO (foldable)', inches: 6.7, w: 1080, h: 2640, ppi: 425, hz: 120, minhz: 1, nits: 2600, prot: 'Ultra-thin glass (inner), Gorilla Glass Victus 2 (cover)', chip: 'Snapdragon 8 Gen 3 for Galaxy', vendor: 'Qualcomm', nm: 4, cores: 8, layout: '1x3.39 GHz Cortex-X4 + 3x3.1 GHz + 2x2.9 GHz + 2x2.2 GHz', ghz: 3.39, gpu: 'Adreno 750', npu: 'Hexagon NPU', ram: [12], store: [256, 512], stype: 'UFS 4.0', mah: 4000, wired: 25, wireless: 15, rev: true, sot: 5.5, rear: 2, mp: 50, sensor: '1/1.57"', ap: 'f/1.8', ois: true, uw: '12 MP f/2.2 ultrawide, 123 degrees', tele: '', peri: '', macro: '', front: '10 MP f/2.2', zoom: '2x optical quality', video: '4K at 60 fps', wifi: 'Wi-Fi 6E', bt: '5.3', nfc: true, usb: 'USB-C 3.2 Gen 1', esim: true, fp: 'Side-mounted capacitive', notch: 'Centred punch-hole', camlayout: 'Vertical dual on cover', bump: 'Flush dual ring', bezels: 'Slim with crease', jack: false, sim: 'Nano-SIM + eSIM', baro: true, uwb: false },
  { id: 'galaxy-z-fold-6', brand: 'Samsung', name: 'Galaxy Z Fold 6', model: 'Galaxy Z Fold6', num: 'SM-F956B', var: ['SM-F956U', 'SM-F9560'], rel: '2024-07-24', la: 34, api: 35, skin: 'One UI 7', cat: 'foldable', tier: 'foldable', avd: 'pixel_fold', dims: [153.5, 132.6, 5.6, 239], frame: 'Armor Aluminum', back: 'Gorilla Glass Victus 2', glass: 'Corning Gorilla Glass Victus 2', colors: ['Silver Shadow', 'Pink', 'Navy', 'Crafted Black'], ip: 'IP48', panel: 'Dynamic AMOLED 2X LTPO (foldable)', inches: 7.6, w: 1856, h: 2160, ppi: 374, hz: 120, minhz: 1, nits: 2600, prot: 'Ultra-thin glass (inner), Gorilla Glass Victus 2 (cover)', chip: 'Snapdragon 8 Gen 3 for Galaxy', vendor: 'Qualcomm', nm: 4, cores: 8, layout: '1x3.39 GHz Cortex-X4 + 3x3.1 GHz + 2x2.9 GHz + 2x2.2 GHz', ghz: 3.39, gpu: 'Adreno 750', npu: 'Hexagon NPU', ram: [12], store: [256, 512, 1024], stype: 'UFS 4.0', mah: 4400, wired: 25, wireless: 15, rev: true, sot: 6.0, rear: 3, mp: 50, sensor: '1/1.57"', ap: 'f/1.8', ois: true, uw: '12 MP f/2.2 ultrawide, 123 degrees', tele: '10 MP f/2.4, 3x optical', peri: '', macro: '', front: '4 MP under-display + 10 MP cover', zoom: '3x optical, 30x Space Zoom', video: '8K at 30 fps, 4K at 60 fps', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.3', nfc: true, usb: 'USB-C 3.2 Gen 1', esim: true, fp: 'Side-mounted capacitive', notch: 'Under-display (inner), punch-hole (cover)', camlayout: 'Vertical triple', bump: 'Individual lens rings', bezels: 'Slim with hinge', jack: false, sim: 'Nano-SIM + eSIM', baro: true, uwb: true, spen: true },
  { id: 'oneplus-12', brand: 'OnePlus', name: 'OnePlus 12', model: 'OnePlus 12', num: 'CPH2581', var: ['CPH2583', 'PJD110'], rel: '2024-01-23', la: 34, api: 35, skin: 'OxygenOS 15', cat: 'phone', tier: 'flagship', avd: 'pixel_8_pro', dims: [164.3, 75.8, 9.2, 220], frame: 'Aluminium', back: 'Glass', glass: 'Corning Gorilla Glass Victus 2', colors: ['Silky Black', 'Flowy Emerald', 'White'], ip: 'IP65', panel: 'LTPO AMOLED ProXDR', inches: 6.82, w: 1440, h: 3168, ppi: 510, hz: 120, minhz: 1, nits: 4500, prot: 'Gorilla Glass Victus 2', chip: 'Snapdragon 8 Gen 3', vendor: 'Qualcomm', nm: 4, cores: 8, layout: '1x3.3 GHz Cortex-X4 + 3x3.2 GHz + 2x3.0 GHz + 2x2.3 GHz', ghz: 3.3, gpu: 'Adreno 750', npu: 'Hexagon NPU', ram: [12, 16, 24], store: [256, 512, 1024], stype: 'UFS 4.0', mah: 5400, wired: 100, wireless: 50, rev: true, sot: 8.0, rear: 3, mp: 50, sensor: '1/1.4"', ap: 'f/1.6', ois: true, uw: '48 MP f/2.2 ultrawide, 114 degrees', tele: '64 MP f/2.6 periscope, 3x optical', peri: '64 MP periscope telephoto', macro: 'Ultrawide macro', front: '32 MP f/2.4', zoom: '3x optical, 120x digital', video: '8K at 24 fps, 4K at 60 fps', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.4', nfc: true, usb: 'USB-C 3.2 Gen 1', esim: false, fp: 'Under-display optical', notch: 'Centred punch-hole', camlayout: 'Circular camera island', bump: 'Large circular module', bezels: 'Curved, slim', jack: false, sim: 'Dual nano-SIM', baro: true, uwb: false },
  { id: 'oneplus-12r', brand: 'OnePlus', name: 'OnePlus 12R', model: 'OnePlus 12R', num: 'CPH2585', var: ['CPH2609'], rel: '2024-01-23', la: 34, api: 35, skin: 'OxygenOS 15', cat: 'phone', tier: 'high', avd: 'pixel_8', dims: [163.3, 75.3, 8.8, 207], frame: 'Aluminium', back: 'Glass', glass: 'Corning Gorilla Glass Victus 2', colors: ['Cool Blue', 'Iron Gray'], ip: 'IP64', panel: 'LTPO4 AMOLED', inches: 6.78, w: 1264, h: 2780, ppi: 450, hz: 120, minhz: 1, nits: 4500, prot: 'Gorilla Glass Victus 2', chip: 'Snapdragon 8 Gen 2', vendor: 'Qualcomm', nm: 4, cores: 8, layout: '1x3.2 GHz Cortex-X3 + 2x2.8 GHz + 2x2.8 GHz + 3x2.0 GHz', ghz: 3.2, gpu: 'Adreno 740', npu: 'Hexagon NPU', ram: [8, 16], store: [128, 256], stype: 'UFS 3.1 / 4.0', mah: 5500, wired: 100, wireless: 0, rev: false, sot: 8.5, rear: 3, mp: 50, sensor: '1/1.56"', ap: 'f/1.8', ois: true, uw: '8 MP f/2.2 ultrawide, 112 degrees', tele: '', peri: '', macro: '2 MP f/2.4 macro', front: '16 MP f/2.4', zoom: '2x in-sensor, 10x digital', video: '4K at 60 fps', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.3', nfc: true, usb: 'USB-C 2.0', esim: false, fp: 'Under-display optical', notch: 'Centred punch-hole', camlayout: 'Circular camera island', bump: 'Large circular module', bezels: 'Slim', jack: false, sim: 'Dual nano-SIM', baro: false, uwb: false },
  { id: 'oneplus-11', brand: 'OnePlus', name: 'OnePlus 11', model: 'OnePlus 11', num: 'CPH2449', var: ['CPH2447', 'PHB110'], rel: '2023-02-07', la: 33, api: 34, skin: 'OxygenOS 14', cat: 'phone', tier: 'high', avd: 'pixel_7_pro', dims: [163.1, 74.1, 8.5, 205], frame: 'Aluminium', back: 'Glass', glass: 'Corning Gorilla Glass Victus', colors: ['Titan Black', 'Eternal Green'], ip: 'IP64', panel: 'LTPO3 AMOLED', inches: 6.7, w: 1440, h: 3216, ppi: 525, hz: 120, minhz: 1, nits: 1300, prot: 'Gorilla Glass Victus', chip: 'Snapdragon 8 Gen 2', vendor: 'Qualcomm', nm: 4, cores: 8, layout: '1x3.2 GHz Cortex-X3 + 2x2.8 GHz + 2x2.8 GHz + 3x2.0 GHz', ghz: 3.2, gpu: 'Adreno 740', npu: 'Hexagon NPU', ram: [8, 12, 16], store: [128, 256, 512], stype: 'UFS 4.0', mah: 5000, wired: 100, wireless: 0, rev: false, sot: 7.5, rear: 3, mp: 50, sensor: '1/1.56"', ap: 'f/1.8', ois: true, uw: '48 MP f/2.2 ultrawide, 115 degrees', tele: '32 MP f/2.0, 2x optical', peri: '', macro: 'Ultrawide macro', front: '16 MP f/2.45', zoom: '2x optical, 20x digital', video: '8K at 24 fps, 4K at 60 fps', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.3', nfc: true, usb: 'USB-C 2.0', esim: false, fp: 'Under-display optical', notch: 'Centred punch-hole', camlayout: 'Circular camera island', bump: 'Large circular module', bezels: 'Curved, slim', jack: false, sim: 'Dual nano-SIM', baro: true, uwb: false },
  { id: 'oneplus-open', brand: 'OnePlus', name: 'OnePlus Open', model: 'OnePlus Open', num: 'CPH2551', var: ['CPH2499'], rel: '2023-10-26', la: 33, api: 35, skin: 'OxygenOS 15', cat: 'foldable', tier: 'foldable', avd: 'pixel_fold', dims: [153.4, 143.1, 5.8, 239], frame: 'Aluminium', back: 'Vegan leather / glass', glass: 'Ceramic Guard', colors: ['Voyager Black', 'Emerald Dusk'], ip: 'IPX4', panel: 'Flexi-fluid AMOLED (inner)', inches: 7.82, w: 2268, h: 2440, ppi: 426, hz: 120, minhz: 1, nits: 2800, prot: 'Ultra-thin glass (inner), Ceramic Guard (cover)', chip: 'Snapdragon 8 Gen 2', vendor: 'Qualcomm', nm: 4, cores: 8, layout: '1x3.2 GHz Cortex-X3 + 2x2.8 GHz + 2x2.8 GHz + 3x2.0 GHz', ghz: 3.2, gpu: 'Adreno 740', npu: 'Hexagon NPU', ram: [16], store: [512], stype: 'UFS 4.0', mah: 4805, wired: 67, wireless: 0, rev: false, sot: 6.5, rear: 3, mp: 48, sensor: '1/1.43"', ap: 'f/1.7', ois: true, uw: '48 MP f/2.2 ultrawide, 114 degrees', tele: '64 MP f/2.6 periscope, 3x optical', peri: '64 MP periscope telephoto', macro: 'Ultrawide macro', front: '20 MP inner + 32 MP cover', zoom: '3x optical, 120x digital', video: '4K at 60 fps', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.3', nfc: true, usb: 'USB-C 3.2 Gen 1', esim: false, fp: 'Side-mounted capacitive', notch: 'Punch-hole on both screens', camlayout: 'Circular camera island', bump: 'Large circular module', bezels: 'Slim with hinge', jack: false, sim: 'Dual nano-SIM', baro: true, uwb: false },
  { id: 'xiaomi-14', brand: 'Xiaomi', name: 'Xiaomi 14', model: 'Xiaomi 14', num: '23127PN0CG', var: ['2311DRK48G', '23127PN0CC'], rel: '2023-10-26', la: 34, api: 35, skin: 'HyperOS 2', cat: 'phone', tier: 'flagship', avd: 'pixel_8', dims: [152.8, 71.5, 8.2, 193], frame: 'Aluminium', back: 'Glass', glass: 'Xiaomi Shield Glass', colors: ['Black', 'White', 'Jade Green', 'Pink'], ip: 'IP68', panel: 'LTPO AMOLED', inches: 6.36, w: 1200, h: 2670, ppi: 460, hz: 120, minhz: 1, nits: 3000, prot: 'Xiaomi Shield Glass', chip: 'Snapdragon 8 Gen 3', vendor: 'Qualcomm', nm: 4, cores: 8, layout: '1x3.3 GHz Cortex-X4 + 3x3.2 GHz + 2x3.0 GHz + 2x2.3 GHz', ghz: 3.3, gpu: 'Adreno 750', npu: 'Hexagon NPU', ram: [8, 12, 16], store: [256, 512, 1024], stype: 'UFS 4.0', mah: 4610, wired: 90, wireless: 50, rev: true, sot: 7.0, rear: 3, mp: 50, sensor: '1/1.31"', ap: 'f/1.6', ois: true, uw: '50 MP f/2.2 ultrawide, 115 degrees', tele: '50 MP f/2.0 floating telephoto, 3.2x optical', peri: '', macro: '10 cm floating telephoto macro', front: '32 MP f/2.0', zoom: '3.2x optical, 60x digital', video: '8K at 24 fps, 4K at 60 fps', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.4', nfc: true, usb: 'USB-C 3.2 Gen 1', esim: false, fp: 'Under-display optical', notch: 'Centred punch-hole', camlayout: 'Square camera island', bump: 'Square module', bezels: 'Uniform very slim', jack: false, sim: 'Dual nano-SIM', baro: true, uwb: false },
  { id: 'xiaomi-14-ultra', brand: 'Xiaomi', name: 'Xiaomi 14 Ultra', model: 'Xiaomi 14 Ultra', num: '24031PN0DC', var: ['2405CPX3DG'], rel: '2024-02-25', la: 34, api: 35, skin: 'HyperOS 2', cat: 'phone', tier: 'flagship', avd: 'pixel_8_pro', dims: [161.4, 75.3, 9.2, 224], frame: 'Aluminium', back: 'Vegan leather', glass: 'Xiaomi Shield Glass', colors: ['Black', 'White', 'Blue'], ip: 'IP68', panel: 'LTPO AMOLED WQHD+', inches: 6.73, w: 1440, h: 3200, ppi: 522, hz: 120, minhz: 1, nits: 3000, prot: 'Xiaomi Shield Glass', chip: 'Snapdragon 8 Gen 3', vendor: 'Qualcomm', nm: 4, cores: 8, layout: '1x3.3 GHz Cortex-X4 + 3x3.2 GHz + 2x3.0 GHz + 2x2.3 GHz', ghz: 3.3, gpu: 'Adreno 750', npu: 'Hexagon NPU', ram: [12, 16], store: [256, 512, 1024], stype: 'UFS 4.0', mah: 5300, wired: 90, wireless: 80, rev: true, sot: 7.5, rear: 4, mp: 50, sensor: '1"', ap: 'f/1.63-f/4.0 variable', ois: true, uw: '50 MP f/1.8 ultrawide, 122 degrees', tele: '50 MP f/1.8, 3.2x optical', peri: '50 MP f/2.5 periscope, 5x optical', macro: 'Periscope macro from 10 cm', front: '32 MP f/2.0', zoom: '5x optical, 120x digital', video: '8K at 30 fps, 4K at 120 fps', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.4', nfc: true, usb: 'USB-C 3.2 Gen 2', esim: false, fp: 'Under-display ultrasonic', notch: 'Centred punch-hole', camlayout: 'Large circular camera island', bump: 'Large circular module', bezels: 'Curved, very slim', jack: false, sim: 'Dual nano-SIM', baro: true, uwb: false },
  { id: 'xiaomi-13t-pro', brand: 'Xiaomi', name: 'Xiaomi 13T Pro', model: 'Xiaomi 13T Pro', num: '23078PND5G', var: ['2306EPN60G'], rel: '2023-09-26', la: 33, api: 35, skin: 'HyperOS 2', cat: 'phone', tier: 'high', avd: 'pixel_7_pro', dims: [162.2, 75.7, 8.5, 206], frame: 'Aluminium', back: 'Glass / vegan leather', glass: 'Corning Gorilla Glass 5', colors: ['Alpine Blue', 'Meadow Green', 'Black'], ip: 'IP68', panel: 'CrystalRes AMOLED', inches: 6.67, w: 1220, h: 2712, ppi: 446, hz: 144, minhz: 30, nits: 2600, prot: 'Gorilla Glass 5', chip: 'MediaTek Dimensity 9200+', vendor: 'MediaTek', nm: 4, cores: 8, layout: '1x3.35 GHz Cortex-X3 + 3x3.0 GHz + 4x2.0 GHz', ghz: 3.35, gpu: 'Immortalis-G715 MC11', npu: 'MediaTek APU 690', ram: [12, 16], store: [256, 512, 1024], stype: 'UFS 4.0', mah: 5000, wired: 120, wireless: 0, rev: false, sot: 7.0, rear: 3, mp: 50, sensor: '1/1.28"', ap: 'f/1.9', ois: true, uw: '12 MP f/2.2 ultrawide, 120 degrees', tele: '50 MP f/1.9, 2x optical', peri: '', macro: 'Telephoto macro', front: '20 MP f/2.2', zoom: '2x optical, 10x digital', video: '8K at 24 fps, 4K at 60 fps', wifi: 'Wi-Fi 6E', bt: '5.4', nfc: true, usb: 'USB-C 2.0', esim: false, fp: 'Under-display optical', notch: 'Centred punch-hole', camlayout: 'Square camera island', bump: 'Square module', bezels: 'Uniform slim', jack: false, sim: 'Dual nano-SIM', baro: true, uwb: false },
  { id: 'moto-edge-50-pro', brand: 'Motorola', name: 'Motorola Edge 50 Pro', model: 'Edge 50 Pro', num: 'XT2403-2', var: ['XT2403-3'], rel: '2024-04-09', la: 34, api: 35, skin: 'Hello UI', cat: 'phone', tier: 'high', avd: 'pixel_8', dims: [161.2, 72.4, 8.2, 186], frame: 'Aluminium', back: 'Vegan leather', glass: 'Corning Gorilla Glass Victus', colors: ['Black Beauty', 'Luxe Lavender', 'Moonlight Pearl'], ip: 'IP68', panel: 'pOLED', inches: 6.7, w: 1220, h: 2712, ppi: 446, hz: 144, minhz: 60, nits: 2000, prot: 'Gorilla Glass Victus', chip: 'Snapdragon 7 Gen 3', vendor: 'Qualcomm', nm: 4, cores: 8, layout: '1x2.63 GHz Cortex-A715 + 3x2.4 GHz + 4x1.8 GHz', ghz: 2.63, gpu: 'Adreno 720', npu: 'Hexagon NPU', ram: [8, 12], store: [256, 512], stype: 'UFS 2.2', mah: 4500, wired: 125, wireless: 50, rev: true, sot: 6.5, rear: 3, mp: 50, sensor: '1/1.55"', ap: 'f/1.4', ois: true, uw: '13 MP f/2.2 ultrawide, 120 degrees', tele: '10 MP f/2.0, 3x optical', peri: '', macro: 'Ultrawide macro', front: '50 MP f/1.9 autofocus', zoom: '3x optical, 30x digital', video: '4K at 30 fps', wifi: 'Wi-Fi 6E', bt: '5.4', nfc: true, usb: 'USB-C 2.0', esim: true, fp: 'Under-display optical', notch: 'Centred punch-hole', camlayout: 'Vertical triple', bump: 'Small rectangular module', bezels: 'Curved, slim', jack: false, sim: 'Dual nano-SIM + eSIM', baro: false, uwb: false },
  { id: 'moto-edge-50-ultra', brand: 'Motorola', name: 'Motorola Edge 50 Ultra', model: 'Edge 50 Ultra', num: 'XT2401-1', var: ['XT2401-3'], rel: '2024-06-20', la: 34, api: 35, skin: 'Hello UI', cat: 'phone', tier: 'flagship', avd: 'pixel_8_pro', dims: [161.1, 72.4, 8.6, 197], frame: 'Aluminium', back: 'Wood / vegan leather', glass: 'Corning Gorilla Glass Victus', colors: ['Forest Grey', 'Nordic Wood', 'Peach Fuzz'], ip: 'IP68', panel: 'pOLED', inches: 6.7, w: 1220, h: 2712, ppi: 446, hz: 144, minhz: 60, nits: 2500, prot: 'Gorilla Glass Victus', chip: 'Snapdragon 8s Gen 3', vendor: 'Qualcomm', nm: 4, cores: 8, layout: '1x3.0 GHz Cortex-X4 + 4x2.8 GHz + 3x2.0 GHz', ghz: 3.0, gpu: 'Adreno 735', npu: 'Hexagon NPU', ram: [12, 16], store: [512, 1024], stype: 'UFS 4.0', mah: 4500, wired: 125, wireless: 50, rev: true, sot: 6.5, rear: 3, mp: 50, sensor: '1/1.3"', ap: 'f/1.6', ois: true, uw: '50 MP f/2.0 ultrawide, 122 degrees', tele: '64 MP f/2.4 periscope, 3x optical', peri: '64 MP periscope telephoto', macro: 'Ultrawide macro', front: '50 MP f/1.9 autofocus', zoom: '3x optical, 100x digital', video: '4K at 60 fps', wifi: 'Wi-Fi 7 (802.11be)', bt: '5.4', nfc: true, usb: 'USB-C 3.1', esim: true, fp: 'Under-display optical', notch: 'Centred punch-hole', camlayout: 'Vertical triple', bump: 'Small rectangular module', bezels: 'Curved, slim', jack: false, sim: 'Dual nano-SIM + eSIM', baro: true, uwb: false },
  { id: 'moto-razr-50-ultra', brand: 'Motorola', name: 'Motorola Razr 50 Ultra', model: 'Razr 50 Ultra', num: 'XT2451-1', var: ['XT2453-2 (Razr+ 2024)'], rel: '2024-06-25', la: 34, api: 35, skin: 'Hello UI', cat: 'flip', tier: 'foldable', avd: 'pixel_fold', dims: [171.4, 74.0, 7.1, 189], frame: 'Aluminium', back: 'Vegan leather', glass: 'Corning Gorilla Glass Victus', colors: ['Midnight Blue', 'Spring Green', 'Peach Fuzz', 'Hot Pink'], ip: 'IPX8', panel: 'LTPO pOLED (foldable)', inches: 6.9, w: 1080, h: 2640, ppi: 413, hz: 165, minhz: 1, nits: 3000, prot: 'Ultra-thin glass (inner), Gorilla Glass Victus (cover)', chip: 'Snapdragon 8s Gen 3', vendor: 'Qualcomm', nm: 4, cores: 8, layout: '1x3.0 GHz Cortex-X4 + 4x2.8 GHz + 3x2.0 GHz', ghz: 3.0, gpu: 'Adreno 735', npu: 'Hexagon NPU', ram: [12], store: [256, 512], stype: 'UFS 4.0', mah: 4000, wired: 45, wireless: 15, rev: false, sot: 5.5, rear: 2, mp: 50, sensor: '1/1.95"', ap: 'f/1.7', ois: true, uw: '', tele: '50 MP f/2.0, 2x optical', peri: '', macro: 'Telephoto macro', front: '32 MP f/2.4', zoom: '2x optical, 10x digital', video: '4K at 60 fps', wifi: 'Wi-Fi 6E', bt: '5.4', nfc: true, usb: 'USB-C 2.0', esim: true, fp: 'Side-mounted capacitive', notch: 'Centred punch-hole', camlayout: 'Horizontal dual on cover', bump: 'Flush dual ring', bezels: 'Slim with crease', jack: false, sim: 'Nano-SIM + eSIM', baro: false, uwb: false },
  { id: 'nothing-phone-2', brand: 'Nothing', name: 'Nothing Phone (2)', model: 'Phone (2)', num: 'A065', var: ['A065P'], rel: '2023-07-11', la: 33, api: 35, skin: 'Nothing OS 3', cat: 'phone', tier: 'high', avd: 'pixel_7', dims: [162.1, 76.4, 8.6, 201], frame: 'Recycled aluminium', back: 'Transparent glass with Glyph LEDs', glass: 'Corning Gorilla Glass', colors: ['White', 'Dark Grey'], ip: 'IP54', panel: 'LTPO OLED', inches: 6.7, w: 1080, h: 2412, ppi: 394, hz: 120, minhz: 1, nits: 1600, prot: 'Gorilla Glass Victus', chip: 'Snapdragon 8+ Gen 1', vendor: 'Qualcomm', nm: 4, cores: 8, layout: '1x3.2 GHz Cortex-X2 + 3x2.75 GHz + 4x1.8 GHz', ghz: 3.2, gpu: 'Adreno 730', npu: 'Hexagon NPU', ram: [8, 12], store: [128, 256, 512], stype: 'UFS 3.1', mah: 4700, wired: 45, wireless: 15, rev: true, sot: 6.5, rear: 2, mp: 50, sensor: '1/1.56"', ap: 'f/1.88', ois: true, uw: '50 MP f/2.2 ultrawide, 114 degrees', tele: '', peri: '', macro: 'Ultrawide macro from 4 cm', front: '32 MP f/2.45', zoom: '2x in-sensor, 10x digital', video: '4K at 60 fps', wifi: 'Wi-Fi 6', bt: '5.3', nfc: true, usb: 'USB-C 3.1', esim: false, fp: 'Under-display optical', notch: 'Left punch-hole', camlayout: 'Vertical dual', bump: 'Small dual module with Glyph', bezels: 'Uniform slim', jack: false, sim: 'Dual nano-SIM', baro: true, uwb: false },
  { id: 'nothing-phone-2a', brand: 'Nothing', name: 'Nothing Phone (2a)', model: 'Phone (2a)', num: 'A142', var: ['A142P'], rel: '2024-03-05', la: 34, api: 35, skin: 'Nothing OS 3', cat: 'phone', tier: 'mid', avd: 'pixel_7a', dims: [161.7, 76.3, 8.6, 190], frame: 'Plastic', back: 'Transparent plastic with Glyph LEDs', glass: 'Corning Gorilla Glass 5', colors: ['White', 'Black', 'Milk', 'Blue'], ip: 'IP54', panel: 'AMOLED', inches: 6.7, w: 1084, h: 2412, ppi: 394, hz: 120, minhz: 30, nits: 1300, prot: 'Gorilla Glass 5', chip: 'MediaTek Dimensity 7200 Pro', vendor: 'MediaTek', nm: 4, cores: 8, layout: '2x2.8 GHz Cortex-A715 + 6x2.0 GHz Cortex-A510', ghz: 2.8, gpu: 'Mali-G610 MC4', npu: 'MediaTek APU', ram: [8, 12], store: [128, 256], stype: 'UFS 3.1', mah: 5000, wired: 45, wireless: 0, rev: false, sot: 7.5, rear: 2, mp: 50, sensor: '1/1.56"', ap: 'f/1.88', ois: true, uw: '50 MP f/2.2 ultrawide, 114 degrees', tele: '', peri: '', macro: 'Ultrawide macro', front: '32 MP f/2.2', zoom: '2x in-sensor, 10x digital', video: '4K at 30 fps', wifi: 'Wi-Fi 6', bt: '5.3', nfc: true, usb: 'USB-C 2.0', esim: false, fp: 'Under-display optical', notch: 'Centred punch-hole', camlayout: 'Horizontal dual', bump: 'Centred dual module with Glyph', bezels: 'Uniform slim', jack: false, sim: 'Dual nano-SIM', baro: false, uwb: false },
  { id: 'generic-low', brand: 'Generic', name: 'Generic low-end Android phone', model: 'Generic low-end Android phone', num: 'AOSP-GENERIC', var: [], rel: '—', la: 33, api: 33, skin: 'Stock Android (AOSP)', cat: 'phone', tier: 'low', avd: 'pixel_4a', real: false, dims: [0, 0, 0, 0], frame: '—', back: '—', glass: '—', colors: ['—'], ip: '—', panel: 'Generic AMOLED/LCD', inches: 6.1, w: 720, h: 1600, ppi: 293, hz: 60, minhz: 60, nits: 600, prot: '—', chip: 'Reference entry-level SoC', vendor: 'Reference', nm: 6, cores: 8, layout: 'Reference big.LITTLE octa-core', ghz: 2.2, gpu: 'Reference GPU', npu: '—', ram: [3, 4], store: [32, 64], stype: 'UFS 2.2', sd: true, mah: 4000, wired: 18, wireless: 0, rev: false, sot: 6.0, rear: 2, mp: 48, sensor: '1/2"', ap: 'f/1.8', ois: false, uw: '8 MP ultrawide', tele: '', peri: '', macro: '', front: '8 MP f/2.0', zoom: 'Digital only', video: '1080p at 30 fps', wifi: 'Wi-Fi 5', bt: '5.0', nfc: true, usb: 'USB-C 2.0', esim: false, fp: 'Side-mounted capacitive', notch: 'Centred punch-hole', camlayout: 'Vertical dual', bump: 'Small module', bezels: 'Even', jack: true, sim: 'Dual nano-SIM', baro: false, uwb: false },
  { id: 'generic-mid', brand: 'Generic', name: 'Generic mid-range Android phone', model: 'Generic mid-range Android phone', num: 'AOSP-GENERIC', var: [], rel: '—', la: 34, api: 34, skin: 'Stock Android (AOSP)', cat: 'phone', tier: 'mid', avd: 'pixel_6a', real: false, dims: [0, 0, 0, 0], frame: '—', back: '—', glass: '—', colors: ['—'], ip: '—', panel: 'Generic AMOLED/LCD', inches: 6.5, w: 1080, h: 2400, ppi: 405, hz: 90, minhz: 60, nits: 600, prot: '—', chip: 'Reference mid-range SoC', vendor: 'Reference', nm: 6, cores: 8, layout: 'Reference big.LITTLE octa-core', ghz: 2.2, gpu: 'Reference GPU', npu: '—', ram: [6, 8], store: [128], stype: 'UFS 2.2', sd: true, mah: 5000, wired: 18, wireless: 0, rev: false, sot: 6.0, rear: 2, mp: 48, sensor: '1/2"', ap: 'f/1.8', ois: false, uw: '8 MP ultrawide', tele: '', peri: '', macro: '', front: '8 MP f/2.0', zoom: 'Digital only', video: '1080p at 30 fps', wifi: 'Wi-Fi 5', bt: '5.0', nfc: true, usb: 'USB-C 2.0', esim: false, fp: 'Side-mounted capacitive', notch: 'Centred punch-hole', camlayout: 'Vertical dual', bump: 'Small module', bezels: 'Even', jack: true, sim: 'Dual nano-SIM', baro: false, uwb: false },
  { id: 'generic-high', brand: 'Generic', name: 'Generic high-end Android phone', model: 'Generic high-end Android phone', num: 'AOSP-GENERIC', var: [], rel: '—', la: 35, api: 35, skin: 'Stock Android (AOSP)', cat: 'phone', tier: 'high', avd: 'pixel_8_pro', real: false, dims: [0, 0, 0, 0], frame: '—', back: '—', glass: '—', colors: ['—'], ip: '—', panel: 'Generic AMOLED/LCD', inches: 6.7, w: 1440, h: 3120, ppi: 513, hz: 120, minhz: 60, nits: 600, prot: '—', chip: 'Reference flagship SoC', vendor: 'Reference', nm: 6, cores: 8, layout: 'Reference big.LITTLE octa-core', ghz: 2.2, gpu: 'Reference GPU', npu: '—', ram: [8, 12], store: [256, 512], stype: 'UFS 2.2', mah: 5000, wired: 18, wireless: 0, rev: false, sot: 6.0, rear: 2, mp: 48, sensor: '1/2"', ap: 'f/1.8', ois: false, uw: '8 MP ultrawide', tele: '', peri: '', macro: '', front: '8 MP f/2.0', zoom: 'Digital only', video: '1080p at 30 fps', wifi: 'Wi-Fi 5', bt: '5.0', nfc: true, usb: 'USB-C 2.0', esim: false, fp: 'Side-mounted capacitive', notch: 'Centred punch-hole', camlayout: 'Vertical dual', bump: 'Small module', bezels: 'Even', jack: false, sim: 'Dual nano-SIM', baro: false, uwb: false },
  { id: 'generic-compact', brand: 'Generic', name: 'Generic compact Android phone', model: 'Generic compact Android phone', num: 'AOSP-GENERIC', var: [], rel: '—', la: 34, api: 34, skin: 'Stock Android (AOSP)', cat: 'phone', tier: 'compact', avd: 'pixel_4a', real: false, dims: [0, 0, 0, 0], frame: '—', back: '—', glass: '—', colors: ['—'], ip: '—', panel: 'Generic AMOLED/LCD', inches: 5.4, w: 1080, h: 2340, ppi: 476, hz: 120, minhz: 60, nits: 600, prot: '—', chip: 'Reference compact SoC', vendor: 'Reference', nm: 6, cores: 8, layout: 'Reference big.LITTLE octa-core', ghz: 2.2, gpu: 'Reference GPU', npu: '—', ram: [6, 8], store: [128, 256], stype: 'UFS 2.2', mah: 3200, wired: 18, wireless: 0, rev: false, sot: 6.0, rear: 2, mp: 48, sensor: '1/2"', ap: 'f/1.8', ois: false, uw: '8 MP ultrawide', tele: '', peri: '', macro: '', front: '8 MP f/2.0', zoom: 'Digital only', video: '1080p at 30 fps', wifi: 'Wi-Fi 5', bt: '5.0', nfc: true, usb: 'USB-C 2.0', esim: false, fp: 'Side-mounted capacitive', notch: 'Centred punch-hole', camlayout: 'Vertical dual', bump: 'Small module', bezels: 'Even', jack: false, sim: 'Dual nano-SIM', baro: false, uwb: false },
  { id: 'generic-foldable', brand: 'Generic', name: 'Generic foldable Android phone', model: 'Generic foldable Android phone', num: 'AOSP-GENERIC', var: [], rel: '—', la: 35, api: 35, skin: 'Stock Android (AOSP)', cat: 'foldable', tier: 'foldable', avd: 'pixel_fold', real: false, dims: [0, 0, 0, 0], frame: '—', back: '—', glass: '—', colors: ['—'], ip: '—', panel: 'Generic AMOLED/LCD', inches: 7.6, w: 1812, h: 2176, ppi: 374, hz: 120, minhz: 60, nits: 600, prot: '—', chip: 'Reference foldable SoC', vendor: 'Reference', nm: 6, cores: 8, layout: 'Reference big.LITTLE octa-core', ghz: 2.2, gpu: 'Reference GPU', npu: '—', ram: [8, 12], store: [256, 512], stype: 'UFS 2.2', mah: 4400, wired: 18, wireless: 0, rev: false, sot: 6.0, rear: 2, mp: 48, sensor: '1/2"', ap: 'f/1.8', ois: false, uw: '8 MP ultrawide', tele: '', peri: '', macro: '', front: '8 MP f/2.0', zoom: 'Digital only', video: '1080p at 30 fps', wifi: 'Wi-Fi 5', bt: '5.0', nfc: true, usb: 'USB-C 2.0', esim: false, fp: 'Side-mounted capacitive', notch: 'Centred punch-hole', camlayout: 'Vertical dual', bump: 'Small module', bezels: 'Even', jack: false, sim: 'Dual nano-SIM', baro: false, uwb: false, illus: 'foldable' },
  { id: 'generic-tablet', brand: 'Generic', name: 'Generic Android tablet', model: 'Generic Android tablet', num: 'AOSP-GENERIC', var: [], rel: '—', la: 34, api: 34, skin: 'Stock Android (AOSP)', cat: 'tablet', tier: 'tablet', avd: 'pixel_tablet', real: false, dims: [0, 0, 0, 0], frame: '—', back: '—', glass: '—', colors: ['—'], ip: '—', panel: 'Generic AMOLED/LCD', inches: 11.0, w: 1600, h: 2560, ppi: 274, hz: 120, minhz: 60, nits: 600, prot: '—', chip: 'Reference tablet SoC', vendor: 'Reference', nm: 6, cores: 8, layout: 'Reference big.LITTLE octa-core', ghz: 2.2, gpu: 'Reference GPU', npu: '—', ram: [6, 8], store: [128, 256], stype: 'UFS 2.2', sd: true, mah: 8000, wired: 18, wireless: 0, rev: false, sot: 6.0, rear: 2, mp: 48, sensor: '1/2"', ap: 'f/1.8', ois: false, uw: '8 MP ultrawide', tele: '', peri: '', macro: '', front: '8 MP f/2.0', zoom: 'Digital only', video: '1080p at 30 fps', wifi: 'Wi-Fi 5', bt: '5.0', nfc: true, usb: 'USB-C 2.0', esim: false, fp: 'Side-mounted capacitive', notch: 'Centred punch-hole', camlayout: 'Vertical dual', bump: 'Small module', bezels: 'Even', jack: true, sim: 'Dual nano-SIM', baro: false, uwb: false, illus: 'tablet' },
];

/** Every phone the Android section can create, in catalogue order. */
export const PHONES: PhoneSpec[] = SEEDS.map(build);
const IMPORTED_CODENAMES = new Map<string, string>();

export interface HandsetFileV1 {
  schema: 'octo-handset-v1';
  id: string;
  manufacturer: string;
  name: string;
  buildModel: string;
  codename: string;
  releaseDate: string;
  androidApi: number;
  skin?: string;
  width: number;
  height: number;
  ppi: number;
  inches: number;
  ramGb: number;
  storageGb: number;
  cpuCores: number;
  chipset: string;
  category?: 'phone' | 'foldable' | 'flip' | 'tablet';
}

/**
 * Validate the documented .octophone.json format and turn it into a complete
 * catalogue entry. Unspecified cosmetic/radio fields inherit conservative
 * generic values; identity and hardware values never do.
 */
export function registerHandsetFile(value: unknown): PhoneSpec {
  if (!value || typeof value !== 'object') throw new Error('The handset file must contain one JSON object.');
  const item = value as Partial<HandsetFileV1>;
  if (item.schema !== 'octo-handset-v1') throw new Error('Unsupported handset schema. Expected octo-handset-v1.');
  const text = (field: keyof HandsetFileV1, max = 80): string => {
    const result = String(item[field] ?? '').replace(/[\u0000-\u001f]/g, '').trim();
    if (!result || result.length > max) throw new Error(`Invalid handset field: ${field}`);
    return result;
  };
  const number = (field: keyof HandsetFileV1, min: number, max: number): number => {
    const result = Number(item[field]);
    if (!Number.isFinite(result) || result < min || result > max) throw new Error(`Invalid handset field: ${field}`);
    return result;
  };
  const id = text('id', 48).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(id)) throw new Error('Handset id may contain lowercase letters, numbers, _ and -.');
  const importedId = `file-${id}`;
  const manufacturer = text('manufacturer', 48);
  const name = text('name', 64);
  const buildModel = text('buildModel', 64);
  const codename = text('codename', 48);
  if (!/^[A-Za-z0-9_.-]{2,48}$/.test(codename)) throw new Error('Invalid handset codename.');
  const releaseDate = text('releaseDate', 10);
  if (!/^\d{4}-(0[1-9]|1[0-2])-([012]\d|3[01])$/.test(releaseDate)) throw new Error('releaseDate must use YYYY-MM-DD.');
  const api = Math.round(number('androidApi', 21, 36));
  const width = Math.round(number('width', 320, 5000));
  const height = Math.round(number('height', 320, 5000));
  const ppi = Math.round(number('ppi', 120, 1000));
  const inches = number('inches', 3, 20);
  const ramGb = number('ramGb', 1, 64);
  const storageGb = number('storageGb', 8, 2048);
  const cores = Math.round(number('cpuCores', 1, 16));
  const chipset = text('chipset', 96);
  const category = ['phone', 'foldable', 'flip', 'tablet'].includes(String(item.category))
    ? item.category as 'phone' | 'foldable' | 'flip' | 'tablet' : 'phone';
  const base = PHONES.find((phone) => phone.id === (category === 'tablet' ? 'generic-tablet' : category === 'foldable' || category === 'flip' ? 'generic-foldable' : 'generic-mid'))!;
  const spec = JSON.parse(JSON.stringify(base)) as PhoneSpec;
  spec.id = importedId;
  spec.identity = {
    ...spec.identity, manufacturer, commercialName: name, modelName: name, modelNumber: buildModel,
    regionalVariants: [], releaseDate, launchAndroid: `Android ${androidRelease(api)}`,
    currentAndroid: `Android ${androidRelease(api)}`, apiLevel: api, skin: String(item.skin ?? 'Android').slice(0, 48),
    category, realDevice: true, avdProfile: category === 'tablet' ? 'pixel_tablet' : category === 'foldable' || category === 'flip' ? 'pixel_fold' : 'pixel_8',
  };
  spec.display = {
    ...spec.display, inches, width, height, ppi, aspectRatio: ratio(width, height), emulatorWidth: width,
    emulatorHeight: height, emulatorDpi: ppi,
  };
  spec.performance = {
    ...spec.performance, chipset, cpuCores: cores, ramOptionsGb: [ramGb], storageOptionsGb: [storageGb],
  };
  const ramMb = Math.round(ramGb * 1024);
  spec.sizing = {
    ...spec.sizing, androidVersion: `Android ${androidRelease(api)}`, apiLevel: api,
    ramMb, cpus: cores, storageGb, width, height, dpi: ppi,
  };
  spec.avd = {
    ...spec.avd, device: spec.identity.avdProfile, apiLevel: api,
    systemImage: `system-images;android-${api};google_apis_playstore;x86_64`, ramMb,
    heapMb: Math.max(256, Math.round(ramMb / 8)), cores, dataGb: storageGb, width, height, dpi: ppi,
  };
  spec.storage = {
    ...spec.storage, virtualDiskBytes: storageGb * GB,
    freeInsideBytes: Math.max(GB, storageGb * GB - Math.round(spec.storage.imageDownloadBytes * 2.2)),
    advertisedStorageGb: storageGb,
  };
  IMPORTED_CODENAMES.set(importedId, codename);
  const existing = PHONES.findIndex((phone) => phone.id === importedId);
  if (existing >= 0) PHONES[existing] = spec; else PHONES.push(spec);
  return spec;
}

export function phone(id: string): PhoneSpec | undefined {
  return PHONES.find((item) => item.id === id);
}

/**
 * Values exposed by Android's Build class.
 *
 * The catalogue keeps both the public model name and retail model number
 * (GZPF0, SM-S921B, …), because vendors expose them differently. A real Pixel
 * 9 reports "Pixel 9", while a Galaxy S24 reports its SM-S921B regional code.
 * The old creator blindly copied `modelNumber` for every brand, which is why a
 * selected Pixel 9 appeared as a seemingly random code.
 *
 * Product/device codenames are exact where the catalogue has one. For models
 * whose vendor does not publish a stable codename across regions, a stable
 * catalogue id is safer than borrowing the Google AVD profile (which would
 * make a Samsung claim to be a Pixel internally).
 */
const DEVICE_CODENAMES: Readonly<Record<string, string>> = {
  'pixel-9': 'tokay',
  'pixel-9-pro': 'caiman',
  'pixel-9-pro-xl': 'komodo',
  'pixel-9-pro-fold': 'comet',
  'pixel-8': 'shiba',
  'pixel-8-pro': 'husky',
  'pixel-8a': 'akita',
  'galaxy-s24': 'e1s',
  'galaxy-s24-plus': 'e2s',
  'galaxy-s24-ultra': 'e3q',
  'galaxy-s23': 'dm1q',
  'galaxy-s23-ultra': 'dm3q',
  'galaxy-a55': 'a55x',
  'galaxy-z-flip-6': 'b6q',
  'galaxy-z-fold-6': 'q6q',
  'oneplus-12': 'waffle',
  'oneplus-12r': 'aston',
  'oneplus-11': 'salami',
  'oneplus-open': 'hedwig',
  'xiaomi-14': 'houji',
  'xiaomi-14-ultra': 'aurora',
  'xiaomi-13t-pro': 'corot',
  'moto-edge-50-pro': 'eqe',
  'moto-edge-50-ultra': 'ctwo',
  'moto-razr-50-ultra': 'arcfox',
  'nothing-phone-2': 'Pong',
  'nothing-phone-2a': 'Pacman',
};

export interface AndroidBuildIdentity {
  brand: string;
  manufacturer: string;
  /** Friendly retail model name synchronized with the chosen device name (e.g. "Google Pixel 9 Pro XL", "Samsung Galaxy S24"). */
  model: string;
  /** Friendly retail name used by Android's visible device-name surfaces. */
  marketName: string;
  device: string;
  product: string;
  mac?: string;
  imei?: string;
  androidId?: string;
  serialNumber?: string;
  phoneNumber?: string;
  operator?: string;
  simOperator?: string;
  simCountry?: string;
  buildId?: string;
  fingerprint?: string;
}

export function androidBuildIdentity(spec: PhoneSpec): AndroidBuildIdentity {
  const generic = !spec.identity.realDevice;
  const brand = generic ? 'Android' : spec.identity.manufacturer === 'Google'
    ? 'google' : spec.identity.manufacturer.toLowerCase();
  const device = DEVICE_CODENAMES[spec.id] ?? IMPORTED_CODENAMES.get(spec.id) ?? spec.id.replace(/[^A-Za-z0-9_-]/g, '_');
  const modelName = handsetDisplayName(spec);
  const operatorInfo = randomSimProfile('us');
  return {
    brand,
    manufacturer: generic ? 'Android' : spec.identity.manufacturer,
    model: modelName,
    marketName: modelName,
    device,
    product: device,
    mac: randomMac(brand),
    imei: randomImei(brand),
    androidId: randomAndroidId(),
    serialNumber: randomSerialNumber(brand),
    phoneNumber: randomPhoneNumber(operatorInfo.country),
    operator: operatorInfo.name,
    simOperator: operatorInfo.numeric,
    simCountry: operatorInfo.country,
  };
}

/** Human label without duplicated brands such as “Xiaomi Xiaomi 14 Ultra”. */
export function handsetDisplayName(spec: PhoneSpec): string {
  const maker = spec.identity.manufacturer.trim();
  const name = spec.identity.commercialName.trim();
  return name.toLowerCase().startsWith(maker.toLowerCase()) ? name : `${maker} ${name}`.trim();
}

export const PHONE_BRANDS: readonly string[] = [...new Set(PHONES.map((item) => item.identity.manufacturer))];

export interface PhoneFilter {
  brand?: string; api?: number; minRamGb?: number; minStorageGb?: number; maxScreenInches?: number;
  minScreenInches?: number; chipset?: string; foldable?: 'any' | 'foldable' | 'bar'; playStore?: boolean;
  maxDownloadBytes?: number; maxHostRamGb?: number; search?: string;
}

/** The filter bar of the phone grid. Every rule is a plain, explainable test. */
export function filterPhones(list: readonly PhoneSpec[], filter: PhoneFilter): PhoneSpec[] {
  const needle = (filter.search ?? '').trim().toLowerCase();
  return list.filter((item) => {
    if (filter.brand && item.identity.manufacturer !== filter.brand) return false;
    if (filter.api && item.identity.apiLevel !== filter.api) return false;
    if (filter.minRamGb && Math.max(...item.performance.ramOptionsGb, 0) < filter.minRamGb) return false;
    if (filter.minStorageGb && item.storage.advertisedStorageGb < filter.minStorageGb) return false;
    if (filter.minScreenInches && item.display.inches < filter.minScreenInches) return false;
    if (filter.maxScreenInches && item.display.inches > filter.maxScreenInches) return false;
    if (filter.chipset && !item.performance.chipset.toLowerCase().includes(filter.chipset.toLowerCase())) return false;
    if (filter.foldable === 'foldable' && item.identity.category !== 'foldable' && item.identity.category !== 'flip') return false;
    if (filter.foldable === 'bar' && (item.identity.category === 'foldable' || item.identity.category === 'flip')) return false;
    if (filter.playStore === true && !item.sizing.playStore) return false;
    if (filter.maxDownloadBytes && item.sizing.downloadBytes > filter.maxDownloadBytes) return false;
    if (filter.maxHostRamGb && item.sizing.hostRamGb > filter.maxHostRamGb) return false;
    if (needle) {
      const haystack = `${item.identity.manufacturer} ${item.identity.commercialName} ${item.identity.modelNumber} ${item.performance.chipset}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}


// ---------------------------------------------------------------- image variants

export type ImageVariantId = 'play' | 'gapps' | 'aosp' | 'go' | 'legacy';

export interface ImageVariant {
  id: ImageVariantId;
  /** Multiplies the catalogue download size: a stripped image really is smaller. */
  downloadFactor: number;
  /** Virtual disk in GB. Lightweight profiles deliberately stay tiny. */
  diskGb: number;
  /** Virtual RAM in MB, or 0 to keep the device's own recommendation. */
  ramMb: number;
  cpus: number;
  googleApps: boolean;
  playStore: boolean;
  /** API level override; 0 keeps the phone's own Android version. */
  apiOverride: number;
  /** What the Android SDK package is called for this handset's AVD. */
  sdkKind: 'google_apis_playstore' | 'google_apis' | 'default';
}

/**
 * Not every test needs a full Play Store image. These variants trade Google
 * services and disk for speed: "Android Go" and "Minimal AOSP" are the
 * lightweight systems - a couple of GB instead of tens of GB.
 */
export const IMAGE_VARIANTS: readonly ImageVariant[] = [
  { id: 'play', downloadFactor: 1, diskGb: 0, ramMb: 0, cpus: 0, googleApps: true, playStore: true, apiOverride: 0, sdkKind: 'google_apis_playstore' },
  { id: 'gapps', downloadFactor: 0.82, diskGb: 0, ramMb: 0, cpus: 0, googleApps: true, playStore: false, apiOverride: 0, sdkKind: 'google_apis' },
  { id: 'aosp', downloadFactor: 0.6, diskGb: 8, ramMb: 3072, cpus: 3, googleApps: false, playStore: false, apiOverride: 0, sdkKind: 'default' },
  { id: 'go', downloadFactor: 0.42, diskGb: 6, ramMb: 2048, cpus: 2, googleApps: true, playStore: true, apiOverride: 0, sdkKind: 'google_apis' },
  { id: 'legacy', downloadFactor: 0.38, diskGb: 4, ramMb: 1536, cpus: 2, googleApps: false, playStore: false, apiOverride: 30, sdkKind: 'default' },
] as const;

export function imageVariant(id: string): ImageVariant {
  return IMAGE_VARIANTS.find((item) => item.id === id) ?? IMAGE_VARIANTS[0];
}

/** The catalogue values after a variant is applied - the numbers the UI shows. */
export function applyVariant(spec: PhoneSpec, variantId: ImageVariantId | string): {
  api: number; androidVersion: string; ramMb: number; cpus: number; storageGb: number;
  downloadBytes: number; diskBytes: number; freeInsideBytes: number;
  googleApps: boolean; playStore: boolean; sdkPackage: string;
} {
  const variant = imageVariant(variantId);
  const api = variant.apiOverride || spec.identity.apiLevel;
  const ramMb = variant.ramMb || spec.sizing.ramMb;
  const storageGb = variant.diskGb || spec.sizing.storageGb;
  const cpus = variant.cpus || spec.sizing.cpus;
  const baseDownload = IMAGE_DOWNLOAD[api] ?? spec.storage.imageDownloadBytes;
  const downloadBytes = Math.round(baseDownload * variant.downloadFactor);
  const diskBytes = storageGb * GB;
  return {
    api,
    androidVersion: `Android ${androidRelease(api)}`,
    ramMb, cpus, storageGb, downloadBytes, diskBytes,
    // A lighter system also leaves more of the small disk free.
    freeInsideBytes: Math.max(GB, diskBytes - Math.round(downloadBytes * 2.2)),
    googleApps: variant.googleApps, playStore: variant.playStore,
    sdkPackage: `system-images;android-${api};${variant.sdkKind};x86_64`,
  };
}

/** Up to four phones, side by side. More than four stops being readable. */
export const COMPARE_LIMIT = 4;

export interface CreationSummary {
  variant: ImageVariantId;
  image: string; profile: string; androidVersion: string; apiLevel: number;
  ramMb: number; cpus: number; storageGb: number; width: number; height: number; dpi: number;
  googleApps: boolean; playStore: boolean; root: boolean;
  /** When that Android version was published, as YYYY-MM. */
  released: string;
  downloadBytes: number; diskBytes: number; freeInsideBytes: number;
  hostRamGb: number; hostCores: number; runningRamMb: number; needsVirtualization: boolean;
}

/**
 * When each Android version was published. Shown next to an image so the age
 * of a build is obvious: an emulator running a 2019 release fingerprints very
 * differently from one running this year's.
 */
export const ANDROID_RELEASE_DATES: Record<number, string> = {
  36: '2025-06', 35: '2024-10', 34: '2023-10', 33: '2022-08', 32: '2022-03', 31: '2021-10',
  30: '2020-09', 29: '2019-09', 28: '2018-08', 27: '2017-12', 26: '2017-08', 25: '2016-12',
  24: '2016-08', 23: '2015-10', 22: '2015-03', 21: '2014-11',
};

/** Exactly what the "Create device" button is about to do, in numbers. */
export function creationSummary(spec: PhoneSpec, variantId: ImageVariantId | string = 'play'): CreationSummary {
  const sizing = spec.sizing;
  const avd = spec.avd;
  const variant = applyVariant(spec, variantId);
  return {
    variant: imageVariant(variantId).id,
    image: variant.sdkPackage,
    profile: avd.device,
    androidVersion: variant.androidVersion,
    apiLevel: variant.api,
    ramMb: variant.ramMb,
    cpus: variant.cpus,
    storageGb: variant.storageGb,
    width: sizing.width, height: sizing.height, dpi: sizing.dpi,
    googleApps: variant.googleApps,
    playStore: variant.playStore,
    // Play Store images are production builds; the other AVD images are
    // development builds that accept `adb root`.
    root: !variant.playStore,
    released: ANDROID_RELEASE_DATES[variant.api] ?? '',
    downloadBytes: variant.downloadBytes,
    diskBytes: variant.diskBytes,
    freeInsideBytes: variant.freeInsideBytes,
    hostRamGb: sizing.hostRamGb, hostCores: sizing.hostCores, runningRamMb: sizing.runningRamMb,
    needsVirtualization: true,
  };
}
