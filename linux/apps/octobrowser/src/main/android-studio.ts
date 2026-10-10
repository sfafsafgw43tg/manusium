/**
 * Local Android Studio / Android Emulator bridge.
 *
 * A thin, explicit wrapper around an already installed Android SDK: it never
 * downloads an SDK on its own, never keeps an Octo VM inventory, and never
 * starts anything the user did not ask for. What it adds on top of the SDK is
 *
 *   * the device/system catalogue of `android-devices.ts` (many handsets, many
 *     Android versions) turned into real AVDs with accurate `config.ini`;
 *   * free-space reporting for the folder the user picked, before writing;
 *   * the bundled vStudio media companion (a virtual camera + virtual
 *     microphone), staged automatically next to the SDK and wired into one
 *     emulator camera endpoint plus `hw.audioInput`. A single DirectShow
 *     endpoint is never assigned to both Android cameras: doing that makes
 *     the emulator Camera provider fail when an app opens it.
 */
import { type ChildProcess, execFile, spawn, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import * as https from 'node:https';
import {
  ANDROID_DEVICES, ANDROID_SYSTEM_IMAGES, AndroidAbi, AndroidDeviceProfile, AndroidHardwareChoice,
  AndroidPerformancePreset, AndroidSystemImage, androidDevice, androidSpaceEstimate, androidSystemImage,
} from './android-devices';
import { PHONES, androidBuildIdentity, handsetDisplayName } from './android-catalog';
import { startSocksHttpBridge, type SocksHttpBridge } from './android-socks-bridge';
import { canonicalAvdConfig, isAppMetaKey, isIdentityKey, parseAvdConfig, renderAvdConfig } from './android-avd-config';
import { inspectAvdFolder, inspectAvdPointer, inspectHardwareCache, repairHardwareCache } from './android-avd-files';
import { quietBoot, telephonyArgsIn, telephonySupported, validTelephoneNumber, type QuietBootResult } from './android-quiet-boot';
import { parseSecondaryDisplay, writeSecondaryDisplay, type SecondaryDisplay } from './android-displays';

import {
  MEDIA_PLUGINS, assignLensCameras, friendlyNameForDevicePath, hardwareIdOf, isDevicePath,
  type MediaPluginId, type WindowsCameraName,
} from '@octo/core';
import { REQUIREMENT_FIXES, type RequirementId, unityCaptureRegistered, unityCaptureRegisteredAsync, vbCableInstalled, vbCableInstalledAsync } from './media-requirements';

export { ANDROID_DEVICES, ANDROID_CATALOG_DEVICES, ANDROID_SYSTEM_IMAGES, androidPreset, androidSpaceEstimate } from './android-devices';
export type { AndroidDeviceProfile, AndroidHardwareChoice, AndroidSystemImage, AndroidPerformancePreset, AndroidAbi } from './android-devices';

/**
 * What a camera facing is fed from.
 *
 * Only host cameras are chosen. `webcam` is a camera the emulator enumerated:
 * the built-in one, a USB webcam, a capture card or any camera a program
 * publishes on this computer. The emulator's own test pattern and 3D room are
 * not offered, and no lens is ever given one in place of a camera.
 *
 * `none` is not a choice a user makes. It is what a lens becomes when no active
 * camera is left for it: nothing is connected, or the only one is already
 * serving the other lens. Saved values from earlier builds (`none`, `emulated`,
 * `virtualscene`, the old `vstudio`) are read as `webcam`, so they are chosen
 * again automatically - see normalizeCameraSources.
 *
 * There is deliberately no "vStudio" source any more: a device takes its picture
 * straight from a camera that is live on this PC, and the vStudio companion is a
 * separate application the user starts on their own.
 */
export type CameraSource = 'none' | 'webcam';

/** The picture size the umbrella keys advertise when no lens is on. */
const DEFAULT_CAMERA_LIMIT = { width: 1920, height: 1080 };
/**
 * A host camera that was never measured advertises 640x480.
 *
 * DirectShow cameras hand the emulator 640x480 by default, and the guest HAL
 * derives its stream configuration from this number. Advertising 1280x720 (or
 * 1920x1080, as an older build did) made Android's Camera app negotiate a size
 * the emulator could not produce, and the app closed with "Camera keeps
 * stopping". 640x480 is what a webcam really delivers until a test says more.
 */
const UNMEASURED_CAMERA_LIMIT = { width: 640, height: 480 };

export interface CameraResolution { width: number; height: number }
export type GpuMode = 'auto' | 'host' | 'swiftshader_indirect' | 'off';
export type BootMode = 'quick' | 'cold';
export type NetworkSpeed = 'full' | 'lte' | 'umts' | 'edge' | 'gsm';

export function normalizeNetworkSpeed(value: unknown): NetworkSpeed {
  return value === 'full' || value === 'lte' || value === 'umts' || value === 'edge' || value === 'gsm' ? value : 'lte';
}

export interface MediaCompanionStatus {
  /** Which plugin this status describes: vStudio Mobile or vStudio Web. */
  plugin: MediaPluginId;
  /** Product name of that plugin, so the UI never has to hardcode it. */
  pluginName: string;
  /** The plugin is switched on in Settings. A disabled plugin never runs. */
  enabled: boolean;
  /** studio.zip shipped with the app (or present in the checkout). */
  bundleAvailable: boolean;
  bundleBytes: number;
  /** The companion has been staged locally and can be started. */
  installed: boolean;
  /** A newer vStudio ships with this build than the one staged on disk. */
  updateAvailable: boolean;
  path: string;
  files: number;
  /** Python 3 is what actually runs the companion. */
  pythonAvailable: boolean;
  /** OBS supplies the virtual camera device the emulator reads as webcam0. */
  virtualCameraDriver: boolean;
  /** VB-CABLE supplies the virtual microphone the emulator records from. */
  virtualMicrophoneDriver: boolean;
  running: boolean;
  /** Everything this plugin needs, with i18n keys and how to install it. */
  requirements: Array<{ id: string; key: string; ok: boolean; required: boolean; fixable: boolean; vendor: string }>;
  /** True when the plugin can be started (every REQUIRED item is met). */
  ready: boolean;
  /** True when nothing at all is missing. */
  complete: boolean;
}

export interface AndroidStudioStatus {
  /** Path of the JDK the SDK tools will use ('' when none was found). */
  javaHome?: string;
  /** Highest Java major version present on the machine (0 = none). */
  javaVersion?: number;
  available: boolean;
  sdkRoot: string;
  studioAppPath: string;
  avdManagerAvailable: boolean;
  emulatorAvailable: boolean;
  adbAvailable: boolean;
  defaultDirectory: string;
  mediaCompanion: MediaCompanionStatus;
  installedImages: string[];
  /** Folders searched for an SDK, so the UI can say where it looked. */
  searched: string[];
  /** What exactly is missing: nothing, the SDK itself, or its command-line tools. */
  missing: '' | 'sdk' | 'cmdline-tools' | 'emulator';
  /** A manually chosen SDK folder is in effect. */
  manualSdkRoot: boolean;
  /** Where system images are installed (and whether that folder is usable). */
  installTarget: AndroidInstallTarget;
}

export interface AndroidAvd {
  name: string;
  path: string;
  target: string;
  running: boolean;
  deviceLabel: string;
  resolution: string;
  ramMb: number;
  dataPartition: string;
  cameraFront: CameraSource;
  cameraBack: CameraSource;
  /** Per-facing host camera endpoints (emulator names such as webcam1). */
  cameraFrontDevice: string;
  cameraBackDevice: string;
  /** Legacy shared endpoint, kept for older AVDs and launch preferences. */
  cameraDevice: string;
  /**
   * The device exists but cannot boot: its system image is not installed
   * anywhere we can see. Left over from a creation that was interrupted.
   */
  incomplete: boolean;
  microphoneEnabled: boolean;
  networkSpeed: NetworkSpeed;
  diskBytes: number;
  identity?: DeviceIdentity;
}

export interface AndroidAvdCreateInput {
  name: string;
  deviceId: string;
  systemId: string;
  /** Absolute folder that will contain <name>.avd. */
  installDirectory: string;
  preset: AndroidPerformancePreset;
  hardware: AndroidHardwareChoice;
  gpuMode: GpuMode;
  bootMode: BootMode;
  snapshots: boolean;
  cameraFront: CameraSource;
  cameraBack: CameraSource;
  /** Active emulator camera endpoints assigned independently to each facing. */
  cameraFrontDevice?: string;
  cameraBackDevice?: string;
  /** Legacy shared endpoint for old callers. */
  cameraDevice?: string;
  /** What a tested host camera actually produced, per facing. */
  cameraLimits?: { front?: CameraResolution; back?: CameraResolution };
  microphoneEnabled: boolean;
  /** Retired: handset identity is never written. Kept so older callers still type-check; ignored. */
  spoofDeviceProps: boolean;
  keyboard: boolean;
  gps: boolean;
  /** Emulated modem speed, e.g. an LTE-looking connection. */
  networkSpeed: NetworkSpeed;
  locale: string;
  timezone: string;
}

export interface MediaCompanionResult {
  installed: boolean;
  /** A local, user-visible outcome; never includes archive contents or credentials. */
  message: string;
  path: string;
  files: number;
  bytes: number;
}

export type CameraRotation = 0 | 90 | 180 | 270;

export function normalizeCameraRotation(value: unknown): CameraRotation {
  const rotation = Number(value);
  return rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0;
}

export interface AndroidLaunchInput {
  name: string;
  cameraFront?: CameraSource;
  cameraBack?: CameraSource;
  /** Active emulator camera endpoints assigned independently to each facing. */
  cameraFrontDevice?: string;
  cameraBackDevice?: string;
  /** Legacy shared endpoint, accepted only when it is currently enumerated. */
  cameraDevice?: string;
  /** Resolution a tested host camera produced, so the HAL advertises the truth. */
  cameraLimits?: { front?: CameraResolution; back?: CameraResolution };
  /** BCP-47 language Android should boot in, e.g. "pl-PL". */
  locale?: string;
  microphoneEnabled: boolean;
  /** Host microphone label the user picked; remembered per device. */
  microphoneDevice?: string;
  networkSpeed?: NetworkSpeed;
  /** Extra display written to config.ini before the start. Omitted = leave config.ini as it is. */
  secondaryDisplay?: SecondaryDisplay;
  bootMode?: BootMode;
  gpuMode?: GpuMode;
  /** The Android Emulator only accepts unauthenticated HTTP/HTTPS proxies. */
  proxy?: { type: 'http' | 'https' | 'socks5'; host: string; port: number; username?: string; password?: string };
}

export interface DiskInfo {
  path: string;
  exists: boolean;
  writable: boolean;
  freeBytes: number;
  totalBytes: number;
}

// avdmanager itself accepts a dot in a device name, and Android Studio creates
// such AVDs ("Pixel_8.1"). Refusing them here would list a device that could
// then not be launched or deleted. Slashes stay out, so a name can never
// escape the folder it is joined to.
const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const ABSOLUTE = (value: string) => path.isAbsolute(value) && value.length <= 2048;

function executable(name: string): string {
  return process.platform === 'win32' ? `${name}.bat` : name;
}
function binary(name: string): string {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

/**
 * Where a manually chosen SDK folder is remembered. Android Studio is not
 * always installed where we guess (a second drive, a portable SDK, a custom
 * `sdk.dir`), so the user can point at it once instead of being stuck with a
 * disabled "New Android device" button.
 */
function overrideFile(): string {
  return path.join(os.homedir(), '.octobrowser', 'android-sdk.json');
}

interface AndroidOverrides {
  sdkRoot: string;
  installRoot: string;
  /** Folders outside the AVD home that received a device we created. */
  deviceDirs: string[];
}

function readOverrides(): AndroidOverrides {
  try {
    const raw = fs.readFileSync(overrideFile(), 'utf8').replace(/^\uFEFF/, '');
    const value = JSON.parse(raw) as { sdkRoot?: unknown; installRoot?: unknown; deviceDirs?: unknown };
    const sdkRoot = typeof value.sdkRoot === 'string' ? value.sdkRoot : '';
    const installRoot = typeof value.installRoot === 'string' ? value.installRoot : '';
    const deviceDirs = Array.isArray(value.deviceDirs)
      ? value.deviceDirs.filter((entry): entry is string => typeof entry === 'string' && ABSOLUTE(entry))
      : [];
    return {
      sdkRoot: ABSOLUTE(sdkRoot) && fs.existsSync(sdkRoot) ? sdkRoot : '',
      // Repair a root that was stored pointing inside the SDK layout.
      installRoot: ABSOLUTE(installRoot) ? normaliseSdkRoot(installRoot) : '',
      deviceDirs: [...new Set(deviceDirs)].slice(-32),
    };
  } catch { return { sdkRoot: '', installRoot: '', deviceDirs: [] }; }
}

function writeOverrides(patch: Partial<AndroidOverrides>): void {
  const current = readOverrides();
  const next = { ...current, ...patch };
  fs.mkdirSync(path.dirname(overrideFile()), { recursive: true });
  fs.writeFileSync(overrideFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
}

function overrideRoot(): string {
  return readOverrides().sdkRoot;
}

/**
 * Can this folder actually be written to by the current user? Program Files
 * needs elevation, and sdkmanager reacts to that by downloading a package and
 * then silently leaving the SDK untouched - which is exactly the "was not
 * written to the SDK" failure users hit.
 */
export function folderWritable(dir: string): boolean {
  if (!ABSOLUTE(dir)) return false;
  const probe = path.join(dir, `.octo-write-${process.pid}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, 'octo');
    fs.rmSync(probe, { force: true });
    return true;
  } catch { return false; }
}

/** Default writable Windows SDK location, always inside the user profile. */
export function defaultInstallRoot(): string {
  const home = os.homedir();
  return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Android', 'Sdk');
}

/**
 * Where system images and SDK packages are installed. Order:
 *   1. the folder the user picked in the UI;
 *   2. the detected SDK, but only when it is writable;
 *   3. the writable per-user SDK folder (created on demand).
 * The emulator is always pointed at this root, so a device can use images
 * installed outside a read-only Program Files SDK.
 */
export function androidInstallRoot(): string {
  const chosen = readOverrides().installRoot;
  if (chosen) return chosen;
  const detected = roots().find((root) => folderWritable(root));
  if (detected) return detected;
  return roots()[0] && folderWritable(roots()[0]) ? roots()[0] : defaultInstallRoot();
}

export interface AndroidInstallTarget {
  path: string;
  chosen: boolean;
  writable: boolean;
  exists: boolean;
  freeBytes: number;
  totalBytes: number;
  /** The detected SDK cannot be written to, so installs go to `path` instead. */
  sdkReadOnly: boolean;
  sdkRoot: string;
}

export function androidInstallTarget(): AndroidInstallTarget {
  const target = androidInstallRoot();
  const sdkRoot = roots()[0] ?? '';
  const disk = androidDiskInfo(target);
  return {
    path: target,
    chosen: !!readOverrides().installRoot,
    writable: folderWritable(target),
    exists: fs.existsSync(target),
    freeBytes: disk.freeBytes,
    totalBytes: disk.totalBytes,
    sdkReadOnly: !!sdkRoot && !folderWritable(sdkRoot),
    sdkRoot,
  };
}

/** Pick the folder system images are downloaded into. Any writable folder works. */
/**
 * `E:\\octoVM\\build-tools` is a package folder inside an SDK, not an SDK. Using
 * one as the root makes every tool look in the wrong place, so the known
 * package folder names are stripped off.
 */
export function normaliseSdkRoot(dir: string): string {
  let current = String(dir || '').trim().replace(/[\\/]+$/, '');
  const packageFolders = ['build-tools', 'platform-tools', 'system-images', 'platforms', 'cmdline-tools', 'emulator', 'sources', 'extras', 'latest', 'bin'];
  // Walk up while the last segment is part of an SDK package layout.
  for (let guard = 0; guard < 6; guard++) {
    const base = path.basename(current).toLowerCase();
    if (!packageFolders.includes(base)) break;
    const parent = path.dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return current;
}

export function setAndroidInstallRoot(dir: string): string {
  const clean = normaliseSdkRoot(dir);
  if (!ABSOLUTE(clean)) throw new Error('Choose a folder for the Android system images');
  try { fs.mkdirSync(clean, { recursive: true }); } catch { throw new Error(`The folder ${clean} could not be created`); }
  if (!folderWritable(clean)) throw new Error(`The folder ${clean} is not writable. Pick a folder inside your user profile or on another drive.`);
  writeOverrides({ installRoot: clean });
  return clean;
}

export function clearAndroidInstallRoot(): boolean {
  try { writeOverrides({ installRoot: '' }); return true; } catch { return false; }
}

/** Every place an Android SDK is looked for, in order. Shown in the UI. */
export function androidSdkCandidates(): string[] {
  const home = os.homedir();
  const programFiles = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']].filter((x): x is string => !!x);
  const list = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : '',
    path.join(home, 'AppData', 'Local', 'Android', 'Sdk'),
    ...programFiles.map((base) => path.join(base, 'Android', 'android-sdk')),
    'C:\\Android\\Sdk', 'D:\\Android\\Sdk',
  ];
  return [...new Set([overrideRoot(), process.env.ANDROID_SDK_ROOT ?? '', process.env.ANDROID_HOME ?? '', ...list].filter(Boolean))];
}

/** An SDK folder is only useful when it actually carries Android's own tools. */
export function looksLikeSdk(root: string): boolean {
  if (!ABSOLUTE(root) || !fs.existsSync(root)) return false;
  return ['cmdline-tools', 'platform-tools', 'emulator', 'tools', 'system-images', 'platforms']
    .some((folder) => fs.existsSync(path.join(root, folder)));
}

function roots(): string[] {
  return androidSdkCandidates().filter((candidate) => looksLikeSdk(candidate));
}

/**
 * Remember a folder the user picked in the launcher. It is validated first, so
 * a wrong folder fails loudly here instead of producing broken AVD commands.
 */
export function setAndroidSdkRoot(root: string): string {
  const clean = String(root || '').trim();
  if (!ABSOLUTE(clean) || !fs.existsSync(clean)) throw new Error('Choose an existing Android SDK folder');
  if (!looksLikeSdk(clean)) throw new Error('That folder does not look like an Android SDK (no cmdline-tools, platform-tools or emulator inside)');
  writeOverrides({ sdkRoot: clean });
  return clean;
}

export function clearAndroidSdkRoot(): boolean {
  try { fs.rmSync(overrideFile(), { force: true }); return true; } catch { return false; }
}

/** Where Android Studio itself is installed, when we can see it. Display only. */
function studioApp(): string {
  const candidates = [path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Android', 'Android Studio', 'bin', 'studio64.exe'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Android Studio', 'bin', 'studio64.exe') : ''];
  return candidates.filter(Boolean).find((candidate) => fs.existsSync(candidate)) ?? '';
}

function locate(sdkRoot: string, tool: 'avdmanager' | 'sdkmanager' | 'emulator' | 'adb'): string {
  const candidates = tool === 'emulator'
    ? [path.join(sdkRoot, 'emulator', binary('emulator'))]
    : tool === 'adb'
      ? [path.join(sdkRoot, 'platform-tools', binary('adb'))]
      : [
        path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin', executable(tool)),
        path.join(sdkRoot, 'cmdline-tools', 'bin', executable(tool)),
        path.join(sdkRoot, 'tools', 'bin', executable(tool)),
      ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? '';
}

function bundleCandidates(): string[] {
  return [...new Set([
    path.resolve(process.cwd(), 'studio.zip'),
    path.resolve(__dirname, '..', '..', '..', '..', 'studio.zip'),
    process.resourcesPath ? path.join(process.resourcesPath, 'studio.zip') : '',
  ].filter(Boolean))];
}

function studioBundle(): { available: boolean; bytes: number; path: string } {
  const bundle = bundleCandidates().find((candidate) => fs.existsSync(candidate));
  if (!bundle) return { available: false, bytes: 0, path: '' };
  try { return { available: true, bytes: fs.statSync(bundle).size, path: bundle }; }
  catch { return { available: false, bytes: 0, path: '' }; }
}

const STUDIO_PREFIX = 'lvStudio arbitrage/vStudio/';
const STUDIO_MAX_BYTES = 120 * 1024 * 1024;
/** A single file inside the command-line tools package stays well under this. */
const CMDLINE_MAX_ENTRY_BYTES = 200 * 1024 * 1024;
const MANIFEST = 'octo-android-studio-addon.json';
/**
 * Bumped whenever the staged companion has to be replaced - a new vStudio
 * Mobile in studio.zip is worthless if the copy on disk is never refreshed,
 * which is exactly what happened: the app kept running last month's files
 * because the manifest simply existed.
 */
const PAYLOAD_VERSION = 15;
/**
 * This keeps the current companion program and its required resources, while
 * explicitly excluding stale bytecode, test data, generated audio/log files,
 * machine-specific config, and scripts that install host drivers. The add-on
 * is copied only; no archive program is started by OctoBrowser.
 */
function includeStudioEntry(relative: string): boolean {
  if (!relative || relative.endsWith('/')) return false;
  const lower = relative.toLowerCase();
  return !lower.startsWith('__pycache__/')
    && !lower.includes('/__pycache__/')
    && !lower.startsWith('tests/')
    && !lower.startsWith('output/')
    // Bundled example photos made a fresh Library look populated. Media is
    // always user/device-owned and starts empty in both vStudio plugins.
    && !lower.startsWith('media/')
    && !lower.startsWith('scripts/')
    && !['.bat', '.cmd', '.ps1', '.sh', '.exe', '.msi'].some((extension) => lower.endsWith(extension))
    && !['config.json', 'instalacja_log.txt'].includes(lower);
}

interface ZipEntry { name: string; method: number; compressedSize: number; uncompressedSize: number; localOffset: number; encrypted: boolean }

/** Read only central-directory metadata from a normal ZIP file, with bounds checks. */
function zipEntries(archive: Buffer): ZipEntry[] {
  const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const start = Math.max(0, archive.length - 65_557);
  const end = archive.lastIndexOf(eocd);
  if (end < start || end + 22 > archive.length) throw new Error('Invalid studio.zip directory');
  const count = archive.readUInt16LE(end + 10);
  const directorySize = archive.readUInt32LE(end + 12);
  let offset = archive.readUInt32LE(end + 16);
  if (offset + directorySize > archive.length) throw new Error('Invalid studio.zip bounds');
  const result: ZipEntry[] = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid studio.zip entry');
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const next = nameStart + nameLength + extraLength + commentLength;
    if (next > archive.length) throw new Error('Invalid studio.zip filename');
    result.push({ name: archive.subarray(nameStart, nameStart + nameLength).toString('utf8'), method, compressedSize, uncompressedSize, localOffset, encrypted: (flags & 1) === 1 });
    offset = next;
  }
  return result;
}

function extractZipEntry(archive: Buffer, entry: ZipEntry, limit = STUDIO_MAX_BYTES): Buffer {
  if (entry.encrypted || ![0, 8].includes(entry.method) || entry.uncompressedSize > limit) throw new Error('Unsupported studio.zip entry');
  const local = entry.localOffset;
  if (local + 30 > archive.length || archive.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid studio.zip local entry');
  const nameLength = archive.readUInt16LE(local + 26);
  const extraLength = archive.readUInt16LE(local + 28);
  const from = local + 30 + nameLength + extraLength;
  const to = from + entry.compressedSize;
  if (to > archive.length) throw new Error('Invalid studio.zip compressed data');
  const packed = archive.subarray(from, to);
  const output = entry.method === 0 ? Buffer.from(packed) : zlib.inflateRawSync(packed, { maxOutputLength: limit });
  if (output.length !== entry.uncompressedSize) throw new Error('Corrupt studio.zip entry');
  return output;
}

/** Return a safe curated relative path, or null for entries that are not part of the add-on. */
export function studioAddonArchiveEntry(name: string): string | null {
  if (!name.startsWith(STUDIO_PREFIX)) return null;
  const relative = name.slice(STUDIO_PREFIX.length).replaceAll(String.fromCharCode(92), '/');
  if (!includeStudioEntry(relative) || path.posix.isAbsolute(relative) || relative.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return relative;
}

/**
 * Android's command line tools are Java programs. Android Studio ships its own
 * JDK (`jbr`), so a machine without JAVA_HOME still has a usable Java: without
 * this the tools die with "ERROR: JAVA_HOME is not set", which is exactly the
 * failure users see behind the red toast when installing a system image.
 */
/**
 * Major version of a JDK folder, read from its own `release` file (offline and
 * instant) and, failing that, from the folder name. sdkmanager refuses to run
 * on anything below 17 - "Java version 17 or higher is required" - so the
 * number matters, not merely the presence of a java executable.
 */
export function javaMajor(home: string): number {
  const fromText = (text: string): number => {
    const match = /(?:^|[^\d])(\d{1,2})(?:[._]\d+)*/.exec(text);
    const value = Number.parseInt(match?.[1] ?? '', 10);
    // "1.8.0_392" is Java 8; everything modern starts with the major itself.
    if (value === 1) {
      const legacy = /^1\.(\d+)/.exec(text);
      return Number.parseInt(legacy?.[1] ?? '', 10) || 0;
    }
    return Number.isFinite(value) ? value : 0;
  };
  try {
    const release = fs.readFileSync(path.join(home, 'release'), 'utf8');
    const version = /JAVA_VERSION="?([^"\s]+)"?/.exec(release)?.[1] ?? '';
    const major = fromText(version);
    if (major) return major;
  } catch { /* no release file: fall back to the folder name */ }
  return fromText(path.basename(home).replace(/^[A-Za-z_-]+/, ''));
}

const MIN_JAVA = 17;

function javaCandidates(): string[] {
  const candidates: string[] = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);
  if (process.env.STUDIO_JDK) candidates.push(process.env.STUDIO_JDK);
  const studio = studioApp();
  if (studio) {
    const base = path.dirname(path.dirname(studio));
    candidates.push(path.join(base, 'jbr'), path.join(base, 'jre'));
  }
  for (const root of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter((x): x is string => !!x)) {
    candidates.push(
      path.join(root, 'Android', 'Android Studio', 'jbr'), path.join(root, 'Android', 'Android Studio', 'jre'),
      path.join(root, 'Programs', 'Android Studio', 'jbr'),
    );
    for (const vendor of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'Amazon Corretto', 'BellSoft', 'RedHat', 'Semeru']) {
      const dir = path.join(root, vendor);
      try {
        for (const entry of fs.readdirSync(dir)) candidates.push(path.join(dir, entry));
      } catch { /* vendor folder absent */ }
    }
  }
  return [...new Set(candidates.filter(Boolean))];
}

/**
 * The JDK the SDK tools will use: a real Java 17+ if one exists anywhere on the
 * machine (Android Studio's bundled jbr counts), preferring the newest. A too
 * old JAVA_HOME is deliberately ignored instead of being passed on.
 */
function javaHome(): string {
  const usable = javaCandidates()
    .filter((candidate) => fs.existsSync(path.join(candidate, 'bin', binary('java'))))
    .map((candidate) => ({ candidate, major: javaMajorVerified(candidate) }));
  const modern = usable.filter((item) => item.major >= MIN_JAVA).sort((a, b) => b.major - a.major);
  // Nothing modern: return '' so the tools report the missing JDK instead of
  // inheriting a Java 8 that sdkmanager will reject anyway.
  return modern[0]?.candidate ?? '';
}

/**
 * Ask the JDK itself. `release` files and folder names can be wrong or absent
 * (a repackaged or renamed JDK), and sdkmanager's own wrapper only trusts
 * `java -version`, so the chosen JDK is verified the same way - once, cached.
 */
const javaMajorCache = new Map<string, number>();
export function javaMajorVerified(home: string): number {
  const cached = javaMajorCache.get(home);
  if (cached !== undefined) return cached;
  let major = javaMajor(home);
  try {
    const result = spawnSync(path.join(home, 'bin', binary('java')), ['-version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    // `java -version` writes to stderr: 'openjdk version "17.0.9" ...'
    const text = `${result.stderr ?? ''}${result.stdout ?? ''}`;
    const reported = /version "?([0-9._]+)/.exec(text)?.[1] ?? '';
    if (reported) {
      const parts = reported.split('.');
      const first = Number.parseInt(parts[0] ?? '', 10);
      major = first === 1 ? Number.parseInt(parts[1] ?? '', 10) || 0 : first || major;
    }
  } catch { /* keep the value read from the release file */ }
  javaMajorCache.set(home, major);
  return major;
}

/** Highest Java major version found, 0 when there is none. Shown in the UI. */
export function javaVersionFound(): number {
  const majors = javaCandidates()
    .filter((candidate) => fs.existsSync(path.join(candidate, 'bin', binary('java'))))
    .map((candidate) => javaMajorVerified(candidate));
  return majors.length ? Math.max(...majors) : 0;
}

/**
 * Windows stores the search path as `Path`, not `PATH`. Spreading
 * `process.env` copies that exact key, so writing `env.PATH` used to ADD a
 * second variable while `env.PATH` itself read as undefined - the child then
 * got a path containing only the JDK and lost System32, which is why
 * sdkmanager.bat died with "'findstr' is not recognized".
 */
export function prependPath(env: NodeJS.ProcessEnv, dir: string): void {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  const current = env[key] ?? '';
  env[key] = current ? `${dir}${path.delimiter}${current}` : dir;
}

function toolEnv(sdkRoot?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const home = javaHome();
  if (home) {
    // sdkmanager.bat reads JAVA_HOME first, but its own JDK check has been
    // known to misread a perfectly good JDK. We only reach this line with a
    // verified Java 17+, so the redundant check is skipped deliberately.
    env.JAVA_HOME = home;
    env.STUDIO_JDK = home;
    prependPath(env, path.join(home, 'bin'));
    env.SKIP_JDK_VERSION_CHECK = '1';
  }
  if (sdkRoot) { env.ANDROID_SDK_ROOT = sdkRoot; env.ANDROID_HOME = sdkRoot; }
  return env;
}

/** Turn a raw tool failure into something a user can act on. */
function toolError(raw: string): Error {
  const text = String(raw || '').trim();
  if (/EINVAL/i.test(text)) {
    return new Error('Windows refused to start the SDK tool (spawn EINVAL). Octo now runs it through cmd.exe - restart Octo and try again.');
  }
  if (/Java version \d+ or higher is required|UnsupportedClassVersion|class file version/i.test(text)) {
    const found = javaVersionFound();
    return new Error(`The Android SDK tools need Java ${MIN_JAVA} or newer${found ? `, but only Java ${found} was found` : ' and none was found'}. Run install.bat (it installs OpenJDK 17) or install Android Studio, then try again.`);
  }
  if (/JAVA_HOME|java(\.exe)? (was not|is not) found|no java/i.test(text)) {
    return new Error(`Java ${MIN_JAVA} or newer was not found. Run install.bat (it installs OpenJDK 17) or install Android Studio, which ships its own JDK.`);
  }
  if (/licen[cs]e/i.test(text)) {
    return new Error('The Android SDK licences were not accepted yet. Use "Accept SDK licences" and start the download again.');
  }
  if (/Warning: Failed to read or create install properties file|Access is denied|EPERM|permission denied/i.test(text)) {
    return new Error('The SDK folder is not writable. Run Octo as the same user that installed the SDK, or move the SDK somewhere writable.');
  }
  if (/Connection|UnknownHost|timed out|SocketException|proxy/i.test(text)) {
    return new Error('The download failed: the SDK server could not be reached. Check the connection or proxy and try again.');
  }
  if (/No such file|not found|ENOENT/i.test(text)) {
    return new Error('The Android SDK command line tools are missing. Install "Android SDK Command-line Tools (latest)" in Android Studio.');
  }
  const clean = meaningfulOutput(text);
  if (!clean) {
    return new Error(`The Android SDK tool stopped without an error message - only deprecation notices. Full log: ${androidToolLogPath()}`);
  }
  return new Error(clean.slice(0, 600));
}

/**
 * `sdkmanager` and `avdmanager` are .bat files on Windows. Since the fix for
 * CVE-2024-27980 Node refuses to spawn a batch file directly and fails with
 * "spawn EINVAL" - which is exactly the error the install button showed. Batch
 * tools therefore go through cmd.exe with every argument quoted by us.
 */
function isBatch(program: string): boolean {
  return process.platform === 'win32' && /\.(bat|cmd)$/i.test(program);
}

/** The exact cmd.exe argument list used for a batch tool (exported for tests). */
export function windowsToolCommand(program: string, args: string[]): string[] {
  return ['/d', '/s', '/c', `"${[program, ...args].map(quoteWindows).join(' ')}"`];
}

function quoteWindows(value: string): string {
  // Inside double quotes cmd.exe does not interpret & | < > ^ ( ), so quoting
  // is enough - as long as the value cannot close the quote itself. A quote or
  // newline in an SDK path or package name is always a mistake, so it is
  // refused instead of being escaped into something cmd may still re-parse.
  if (/["\r\n%]/.test(value)) throw new Error('Refusing to run an Android SDK tool with an unsafe argument');
  return `"${value}"`;
}

/** One place that knows how to start an SDK tool on every platform. */
function spawnTool(program: string, args: string[], sdkRoot?: string, pipeStdin = false): ChildProcess {
  const options = {
    windowsHide: true,
    env: toolEnv(sdkRoot),
    stdio: [pipeStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] as ('pipe' | 'ignore')[],
  };
  if (!isBatch(program)) return spawn(program, args, options);
  const comspec = process.env.ComSpec || 'cmd.exe';
  // windowsVerbatimArguments: we already quoted, Node must not re-quote.
  return spawn(comspec, windowsToolCommand(program, args), { ...options, windowsVerbatimArguments: true });
}

export interface AndroidProgress {
  /** Machine-readable step: download | unzip | import | install | create | configure | done. */
  stage: 'download' | 'unzip' | 'import' | 'install' | 'licence' | 'create' | 'configure' | 'done';
  /** 0-100, or -1 when the tool does not report a percentage yet. */
  percent: number;
  /** Short line describing what is happening right now. */
  text: string;
}

type ProgressFn = (p: AndroidProgress) => void;
let progressSink: ProgressFn | null = null;

/** Where progress of long Android operations is reported (manager -> launcher). */
export function setAndroidProgressSink(fn: ProgressFn | null): void {
  progressSink = fn;
}

export function reportAndroidProgress(progress: AndroidProgress): void {
  try { progressSink?.(progress); } catch { /* a broken window must not stop the install */ }
}

/**
 * sdkmanager prints lines like:
 *   "[=========                     ] 30% Downloading system-images ... .zip"
 *   "Unzipping... (23%)" / "Installing Android SDK Platform 35"
 * We turn whatever it says into a percentage plus a human line.
 */
function parseSdkProgress(chunk: string): void {
  for (const raw of chunk.split(/\r?\n|\r/)) {
    const line = raw.trim();
    if (!line) continue;
    const percentMatch = /(\d{1,3})\s?%/.exec(line);
    const percent = percentMatch ? Math.max(0, Math.min(100, Number(percentMatch[1]))) : -1;
    const text = line.replace(/^\[[=\s>.-]*\]\s*/, '').replace(/\s+/g, ' ').slice(0, 160);
    if (/unzip/i.test(line)) reportAndroidProgress({ stage: 'unzip', percent, text });
    else if (/download|fetch/i.test(line)) reportAndroidProgress({ stage: 'download', percent, text });
    else if (/licen[cs]e/i.test(line)) reportAndroidProgress({ stage: 'licence', percent, text });
    else if (/install|package/i.test(line)) reportAndroidProgress({ stage: 'install', percent, text });
    else if (percent >= 0) reportAndroidProgress({ stage: 'download', percent, text });
  }
}

/** Run a tool to completion and return its output (stdout + stderr on failure). */
/** Full transcript of every SDK tool run, so a failure can be inspected. */
export function androidToolLogPath(): string {
  return path.join(os.homedir(), '.octobrowser', 'android-tools.log');
}

/** The entry written last, so an answer that repeats is not written twice. */
let lastToolRunEntry = '';

function logToolRun(program: string, args: string[], output: string): void {
  try {
    const body = `${program} ${args.join(' ')}\n${output}`;
    // The camera picker asks the emulator for its camera list every few seconds.
    // An identical answer adds nothing new to the log.
    if (body === lastToolRunEntry) return;
    lastToolRunEntry = body;
    const file = androidToolLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry = `\n=== ${new Date().toISOString()} ===\n${body}\n`;
    // Keep the log small: only the most recent runs matter.
    let previous = '';
    try { previous = fs.readFileSync(file, 'utf8').slice(-200_000); } catch { previous = ''; }
    fs.writeFileSync(file, previous + entry, { mode: 0o600 });
  } catch { /* logging must never break an install */ }
}

function runTool(program: string, args: string[], timeout: number, sdkRoot?: string, answerPrompts = false, progress = false, keepOutputOnExit = false): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = spawnTool(program, args, sdkRoot, answerPrompts); }
    catch (error) { reject(toolError(error instanceof Error ? error.message : String(error))); return; }
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      out = (out + text).slice(-40000);
      if (progress) parseSdkProgress(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      err = (err + text).slice(-40000);
      if (progress) parseSdkProgress(text);
    });
    if (answerPrompts) {
      // sdkmanager asks interactive licence questions; with no console attached
      // it reads EOF and aborts, so we answer every prompt with "y".
      try { child.stdin?.write('y\n'.repeat(200)); child.stdin?.end(); } catch { /* tool closed stdin */ }
    }
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* already gone */ } }, timeout);
    child.once('error', (error) => { clearTimeout(timer); reject(toolError(`${error.message}\n${err || out}`)); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) { reject(new Error('The Android SDK tool did not finish in time. Check the connection and try again.')); return; }
      logToolRun(program, args, `${out}\n${err}`.trim());
      if (code === 0 || keepOutputOnExit) resolve(`${out}\n${err}`.trim());
      else reject(toolError(err || out || `${path.basename(program)} exited with code ${code}`));
    });
  });
}

function run(program: string, args: string[], timeout = 20_000, sdkRoot?: string): Promise<string> {
  return runTool(program, args, timeout, sdkRoot, false);
}

/** Like run(), but returns what the tool printed even when it exits non-zero. */
export function runKeepingOutput(program: string, args: string[], timeout: number, sdkRoot?: string): Promise<string> {
  return runTool(program, args, timeout, sdkRoot, false, false, true);
}

/** Install/licence runs of sdkmanager: prompts answered, output captured, progress reported. */
function runSdkManager(sdkmanager: string, sdkRoot: string, args: string[], timeout: number): Promise<string> {
  return runTool(sdkmanager, args, timeout, sdkRoot, true, true);
}

/** Accept the Android SDK licences non-interactively. Safe to repeat. */
export async function acceptAndroidLicenses(): Promise<boolean> {
  const tools = sdk();
  if (!tools.sdkmanager) throw new Error('Android SDK command-line tools not found');
  await runSdkManager(tools.sdkmanager, tools.root, [`--sdk_root=${tools.root}`, '--licenses'], 5 * 60_000);
  return true;
}

/** Does this failure look like "the SDK server could not be reached"? */
function isNetworkFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /unable to reach|connection|unknownhost|timed? ?out|socket|network|proxy|ssl|certificate|handshake|failed to download|no address/i.test(text);
}

/**
 * Install one SDK package. Three things go wrong in practice and each has a
 * retry here instead of a red toast:
 *   - unaccepted licences  -> accept them and try again;
 *   - TLS/proxy blocking   -> retry over plain HTTP (`--no_https`), which is
 *     the documented workaround when a company proxy breaks sdkmanager's TLS;
 *   - a system proxy       -> sdkmanager gets the host/port from the
 *     environment (HTTPS_PROXY / HTTP_PROXY) as explicit flags.
 */
/**
 * Ask the local sdkmanager which packages the repository actually offers. It is
 * the authoritative list for this SDK and platform.
 */
export async function availableSdkPackages(): Promise<string[]> {
  const tools = sdk();
  if (!tools.sdkmanager) throw new Error('Android SDK command-line tools not found');
  const sdkmanager = locate(tools.root, 'sdkmanager') || tools.sdkmanager;
  let raw = await runTool(sdkmanager, [`--sdk_root=${tools.root}`, '--list', ...proxyArgs()], 10 * 60_000, tools.root, false);
  const cli = androidCli(tools.root) || androidCli(tools.toolsRoot);
  // The deprecated stub prints a notice instead of a listing.
  if (cli && (usesNewCli(raw) || !raw.includes(';'))) {
    raw = await runTool(cli, [`--sdk=${tools.root}`, 'sdk', 'list'], 10 * 60_000, tools.root, false).catch(() => raw);
  }
  const names = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const raw = line.split('|')[0]?.trim() ?? '';
    // Both spellings are normalised to the classic semicolon form.
    const name = /^[A-Za-z0-9/._-]+$/.test(raw) && raw.includes('/') ? raw.replace(/\//g, ';') : raw;
    if (/^[A-Za-z0-9;._-]{3,120}$/.test(name) && name.includes(';')) names.add(name);
  }
  return [...names];
}

export interface SystemImageAvailability {
  /** The listing looked complete, so "not offered" may be shown to the user. */
  trusted: boolean;
  ids: string[];
  packages: number;
}

/**
 * Which of the catalogue's system images this SDK can really download. Only a
 * healthy-looking listing is trusted: a failed or truncated `sdkmanager --list`
 * must never make every image look unavailable and block the wizard.
 */
export async function availableSystemImageIds(): Promise<SystemImageAvailability> {
  const packages = await availableSdkPackages();
  const offered = new Set(packages);
  const ids = ANDROID_SYSTEM_IMAGES.filter((item) => offered.has(item.packageName)).map((item) => item.id);
  const sane = packages.length >= 20 && packages.some((name) => name.startsWith('system-images;'));
  return { trusted: sane && ids.length > 0, ids, packages: packages.length };
}

/**
 * Recent command-line tools print a block of deprecation notices ("The SDK
 * Manager CLI tool (sdkmanager) is deprecated", "Flag --verbose is no longer
 * supported", JVM flag warnings). They are noise: they must not be mistaken
 * for an error and must not be what the user is shown.
 */
export function meaningfulOutput(output: string): string {
  return String(output || '')
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/^\s*(warning:|ignoring\.|openjdk .*warning|picked up _java|note:)/i.test(line))
    .filter((line) => !/is deprecated|no longer supported|UseAllWindowsProcessorGroups|android-cli|will be ignored/i.test(line))
    // The stub's own "here is how to use the new tool" help is not an error.
    .filter((line) => !/binary can also be found|is the replacement for|learn more about|see the documentation|https?:\/\//i.test(line))
    .join('\n');
}

/** A half-written or HTML-instead-of-zip download leaves this behind. */
export function brokenArchive(output: string): boolean {
  return /unknown archive|error on zipfile|zipexception|not a zip|checksum|sha1 mismatch|corrupt/i.test(output);
}

/**
 * Throw away sdkmanager's partial downloads. It reuses whatever sits in its
 * temp folders, so a single interrupted download keeps failing with
 * "Error on ZipFile unknown archive" until those files are removed.
 */
function clearDownloadCache(root: string): void {
  for (const dir of ['.temp', '.downloadIntermediates', 'temp']) {
    try { fs.rmSync(path.join(root, dir), { recursive: true, force: true }); } catch { /* nothing cached */ }
  }
}

/**
 * Google is replacing sdkmanager with a single `android` binary whose packages
 * use slashes instead of semicolons. We keep using sdkmanager while it exists
 * (it still works, it only prints a deprecation notice) and fall back to the
 * new CLI when a command-line-tools release finally drops it.
 */
function androidCli(root: string): string {
  const names = [executable('android'), binary('android'), 'android'];
  const dirs: string[] = [path.join(os.homedir(), '.android', 'bin')];
  const cmdline = path.join(root, 'cmdline-tools');
  dirs.push(path.join(cmdline, 'latest', 'bin'), path.join(cmdline, 'bin'), path.join(root, 'bin'), cmdline, root);
  // Any other cmdline-tools revision folder (11.0, 13.0, ...) counts as well.
  try {
    for (const entry of fs.readdirSync(cmdline)) dirs.push(path.join(cmdline, entry, 'bin'));
  } catch { /* no cmdline-tools here */ }
  for (const dir of [...new Set(dirs)]) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch { /* unreadable */ }
    }
  }
  return '';
}

/** `system-images;android-36;google_apis;x86_64` -> the new CLI's slash form. */
export function androidCliPackage(packageName: string): string {
  return packageName.replace(/;/g, '/');
}

/**
 * The new CLI takes the SDK path as a global `--sdk=` option and the package
 * with slashes: `android --sdk=<root> sdk install system-images/android-36/...`.
 * It does not understand sdkmanager's `--sdk_root=` or `--install`, which is
 * why passing the old flags to it installed nothing at all.
 */
export function androidCliArgs(root: string, packageName: string): string[] {
  return [`--sdk=${root}`, 'sdk', 'install', androidCliPackage(packageName)];
}

/** sdkmanager delegating to the new CLI announces itself like this. */
export function usesNewCli(output: string): boolean {
  return /android cli will be used instead|sdkmanager\)? is deprecated/i.test(String(output || ''));
}

/**
 * Google publishes the command-line tools (sdkmanager plus the new `android`
 * CLI) as a standalone package. Newest build first; older builds are kept as
 * fallbacks because the build number changes with every release.
 */
const CMDLINE_TOOLS_PLATFORM = 'win';
const CMDLINE_TOOLS_BUILDS = [
  16111833, 14742923, 10406996, 9477386, 8512546, 7583922, 6858069, 6609375, 6514223, 6200805,
] as const;

export const CMDLINE_TOOLS_URLS: readonly string[] = CMDLINE_TOOLS_BUILDS
  .map((build) => `https://dl.google.com/android/repository/commandlinetools-${CMDLINE_TOOLS_PLATFORM}-${build}_latest.zip`);

// Derived from the URLs above so the allow-list cannot drift from them.
const CMDLINE_TOOLS_HOST = new URL(CMDLINE_TOOLS_URLS[0]).host;

/** Query Google's repository manifest to dynamically locate the newest available cmdline-tools archive. */
async function fetchLatestCmdlineToolsUrls(): Promise<string[]> {
  const dynamicUrls: string[] = [];
  const repos = [
    'https://dl.google.com/android/repository/repository2-3.xml',
    'https://dl.google.com/android/repository/repository2-2.xml',
    'https://dl.google.com/android/repository/repository2-1.xml',
  ];
  for (const repoUrl of repos) {
    try {
      const xml = await new Promise<string>((resolve, reject) => {
        const req = https.get(repoUrl, { timeout: 8_000 }, (res) => {
          if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          res.on('error', reject);
        });
        req.on('timeout', () => req.destroy());
        req.on('error', reject);
      });
      const matches = xml.match(/commandlinetools-win-[a-zA-Z0-9_.-]+\.zip/g);
      if (matches) {
        for (const m of matches) {
          const fullUrl = `https://dl.google.com/android/repository/${m}`;
          if (!dynamicUrls.includes(fullUrl)) dynamicUrls.push(fullUrl);
        }
      }
      if (dynamicUrls.length) break;
    } catch {}
  }
  return dynamicUrls;
}

/** Download a file over https, refusing any host outside the allow-list. */
function download(url: string, label: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { reject(new Error(`Invalid download address: ${url}`)); return; }
    if (parsed.protocol !== 'https:' || parsed.host !== CMDLINE_TOOLS_HOST) { reject(new Error(`Refused to download from ${parsed.host}`)); return; }
    const request = https.get(url, { timeout: 120_000 }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        download(new URL(response.headers.location, url).toString(), label).then(resolve, reject);
        return;
      }
      if (status !== 200) { response.resume(); reject(new Error(`${url} answered HTTP ${status}`)); return; }
      const total = Number.parseInt(String(response.headers['content-length'] ?? ''), 10);
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        received += chunk.length;
        const percent = Number.isFinite(total) && total > 0 ? Math.min(99, Math.round((received / total) * 100)) : -1;
        reportAndroidProgress({ stage: 'download', percent, text: label });
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('timeout', () => { request.destroy(new Error('The download timed out')); });
    request.on('error', reject);
  });
}

/**
 * Install the command-line tools into `root` when it has none. This is what
 * makes a plain Android Studio installation (which ships no `cmdline-tools`)
 * usable, and it is also how the modern `android` CLI arrives.
 */
export async function ensureCommandLineTools(root: string): Promise<string> {
  if (!ABSOLUTE(root)) throw new Error('The Android command-line tools need an absolute install folder.');
  const existing = androidCli(root) || locate(root, 'sdkmanager');
  if (existing) return existing;
  if (!folderWritable(root)) throw new Error(`The install folder ${root} is not writable, so the Android command-line tools cannot be installed there.`);
  let archive: Buffer | undefined;
  const failures: string[] = [];
  const dynamicUrls = await fetchLatestCmdlineToolsUrls();
  const allUrls = [...new Set([...dynamicUrls, ...CMDLINE_TOOLS_URLS])];
  for (const url of allUrls) {
    try { archive = await download(url, 'Downloading the Android command-line tools'); break; }
    catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  if (!archive) {
    try {
      const ptArchive = await download('https://dl.google.com/android/repository/platform-tools-latest-windows.zip', 'Downloading Android Platform Tools');
      const targetPt = path.join(root, 'platform-tools');
      fs.mkdirSync(targetPt, { recursive: true });
      for (const entry of zipEntries(ptArchive)) {
        const relative = entry.name.replace(/^platform-tools[\\/]/, '');
        if (!relative || relative.endsWith('/') || relative.includes('..')) continue;
        const destination = path.join(targetPt, relative);
        if (!destination.startsWith(targetPt)) continue;
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, extractZipEntry(ptArchive, entry, CMDLINE_MAX_ENTRY_BYTES));
      }
    } catch {}
  }
  if (!archive) {
    const existingNow = androidCli(root) || locate(root, 'sdkmanager') || locate(root, 'adb');
    if (existingNow) return existingNow;
    throw new Error(`The Android command-line tools could not be downloaded. ${failures.join(' ')}`);
  }
  reportAndroidProgress({ stage: 'unzip', percent: -1, text: 'Unpacking the Android command-line tools' });
  const target = path.join(root, 'cmdline-tools', 'latest');
  fs.mkdirSync(target, { recursive: true });
  for (const entry of zipEntries(archive)) {
    // The archive contains a single top-level `cmdline-tools/` folder.
    const relative = entry.name.replace(/^cmdline-tools[\\/]/, '');
    if (!relative || relative.endsWith('/') || relative.includes('..')) continue;
    const destination = path.join(target, relative);
    if (!destination.startsWith(target)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, extractZipEntry(archive, entry, CMDLINE_MAX_ENTRY_BYTES));
    if (/[\\/]bin[\\/][^.\\/]+$/.test(destination)) { try { fs.chmodSync(destination, 0o755); } catch { /* Windows */ } }
  }
  const installed = androidCli(root) || locate(root, 'sdkmanager') || locate(root, 'adb');
  if (!installed) throw new Error('The Android command-line tools package did not contain the expected tools.');
  reportAndroidProgress({ stage: 'install', percent: 100, text: 'Android command-line tools installed' });
  return installed;
}

/**
 * avdmanager says this when it cannot see the system image: either the tool is
 * older than the image, or the platform package for that API is missing.
 */
function imagePathRejected(message: string): boolean {
  return /package path is not valid|valid system image paths|no system images installed/i.test(message);
}

/**
 * Create an AVD, repairing the two things that make avdmanager reject a
 * perfectly good image: missing `platforms;android-<api>` and an avdmanager
 * too old to read it. Both are fixed here and the creation is retried once.
 */
/**
 * avdmanager resolves the SDK from its OWN location (the folder three levels
 * above `cmdline-tools/latest/bin`) and ignores ANDROID_SDK_ROOT. An
 * avdmanager living in `%LOCALAPPDATA%\\Android\\Sdk` therefore cannot see an
 * image installed in `E:\\...\\android version` no matter what we put in the
 * environment - which is exactly the "refuses the image, although it is
 * installed in ..." failure. The only real fix is to run the avdmanager that
 * lives inside the same SDK folder as the image, installing the command-line
 * tools there when they are missing.
 */
async function avdManagerForRoot(root: string): Promise<string> {
  const existing = locate(root, 'avdmanager');
  if (existing) return existing;
  reportAndroidProgress({ stage: 'install', percent: -1, text: 'Installing the Android command-line tools next to the system image' });
  try { await ensureCommandLineTools(root); } catch { /* the caller reports it */ }
  return locate(root, 'avdmanager');
}

async function runAvdCreate(args: string[], api: number, packageName: string): Promise<void> {
  const tools = sdk();
  const abi = packageName.split(';')[3] ?? '';
  if (abi && !imageRunsHere(abi)) {
    throw new Error(`The ${abi} image cannot run on this computer (${process.platform} ${process.arch}); the emulator only runs ${hostAbis().join(' or ')} images. Pick the ${hostAbis()[0]} variant of the same Android version.`);
  }
  const imageRoot = rootForPackage(packageName) || tools.root;
  // First choice: the avdmanager that belongs to the SDK holding the image.
  const local = await avdManagerForRoot(imageRoot);
  const attempt = async (avdmanager: string, root: string): Promise<void> => {
    if (!avdmanager) throw new Error('Android SDK AVD Manager not found');
    await run(avdmanager, args, 120_000, root);
  };
  try { await attempt(local || tools.avdmanager, imageRoot); return; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!imagePathRejected(message)) throw error;
    reportAndroidProgress({ stage: 'install', percent: -1, text: 'Adding the missing Android platform for this image' });
    // Everything the emulator needs must live in the image's own SDK folder.
    const previous = readOverrides().installRoot;
    try {
      writeOverrides({ installRoot: imageRoot });
      for (const name of [`platforms;android-${api}`, 'platform-tools', 'emulator', 'build-tools;34.0.0']) {
        if (!fs.existsSync(path.join(imageRoot, ...name.split(';')))) {
          try { await installPackage(name, 30 * 60_000); } catch { /* reported below */ }
        }
      }
    } finally { writeOverrides({ installRoot: previous }); }
    const retryTools = sdk();
    const candidates = [...new Set([await avdManagerForRoot(imageRoot), retryTools.avdmanager, tools.avdmanager].filter(Boolean))];
    const targets = [...new Set([rootForPackage(packageName), imageRoot, retryTools.root].filter(Boolean))];
    for (const avdmanager of candidates) {
      for (const root of targets) {
        try { await attempt(avdmanager, root); return; }
        catch (retryError) {
          const text = retryError instanceof Error ? retryError.message : String(retryError);
          if (!imagePathRejected(text)) throw retryError;
        }
      }
    }
    const where = rootForPackage(packageName);
    throw new Error(where
      ? `avdmanager still refuses ${packageName} in ${where}. Set the install location to ${where} and press "Install system image" once, so the command-line tools, the platform and the emulator all land in that folder. Full log: ${androidToolLogPath()}`
      : `The image ${packageName} is not installed in any known SDK folder (${knownRoots().join(', ') || 'none'}). Press "Install system image" first. Full log: ${androidToolLogPath()}`);
  }
}



/** sdkmanager prints this when its repository index does not know a package. */
export function packageUnknown(output: string): boolean {
  return /failed to find package|is not available|could not find package|unknown package/i.test(output);
}

/**
 * sdkmanager only sees the packages its own repository schema understands, so a
 * command-line-tools copy from an old Android Studio cannot install Android 15
 * or 16 at all. When that happens we install `cmdline-tools;latest` into the
 * writable root and retry with that newer sdkmanager.
 */
async function refreshCommandLineTools(root: string, sdkmanager: string): Promise<string> {
  reportAndroidProgress({ stage: 'install', percent: -1, text: 'Updating the Android SDK command-line tools' });
  try {
    await runSdkManager(sdkmanager, root, [`--sdk_root=${root}`, '--install', 'cmdline-tools;latest', ...proxyArgs()], 20 * 60_000);
  } catch { /* the retry below reports the real problem */ }
  const updated = locate(root, 'sdkmanager');
  return updated || sdkmanager;
}

/** Ask sdkmanager itself what is installed; the folder check can lag behind. */
async function packageInstalledPerSdkManager(sdkmanager: string, root: string, packageName: string): Promise<boolean> {
  try {
    const raw = await runTool(sdkmanager, [`--sdk_root=${root}`, '--list_installed'], 3 * 60_000, root, false);
    return raw.split(/\r?\n/).some((line) => (line.split('|')[0] ?? '').trim() === packageName);
  } catch { return false; }
}

/** The newest API levels the repository really offers, to suggest an alternative. */
async function newestOfferedApis(limit = 3): Promise<number[]> {
  const packages: string[] = await availableSdkPackages().catch(() => [] as string[]);
  const apis: number[] = packages
    .filter((name) => name.startsWith('system-images;'))
    .map((name) => Number.parseInt(name.split(';')[1]?.replace('android-', '') ?? '', 10))
    .filter((api) => Number.isFinite(api));
  return [...new Set(apis)].sort((a, b) => b - a).slice(0, limit);
}

/**
 * Install one SDK package. Everything that goes wrong in practice has a
 * recovery here instead of a red toast:
 *   - unaccepted licences          -> accept them and try again;
 *   - TLS/proxy blocking           -> retry over plain HTTP (`--no_https`);
 *   - a system proxy               -> pass host/port to sdkmanager explicitly;
 *   - an sdkmanager too old to know the package -> update the command-line
 *     tools into the writable root and retry with the new one.
 */
/** Install one package with the new Android CLI. Throws on failure. */
async function installWithCli(cli: string, root: string, packageName: string, timeout: number): Promise<void> {
  reportAndroidProgress({ stage: 'install', percent: -1, text: `Installing ${packageName} with the Android CLI` });
  const output = await runTool(cli, androidCliArgs(root, packageName), timeout, root, true, true);
  if (androidPackageInstalled(packageName)) {
    reportAndroidProgress({ stage: 'done', percent: 100, text: `${packageName} is installed` });
    return;
  }
  const tail = meaningfulOutput(output).split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 300);
  throw new Error(`${packageName} was not written to ${root}. ${tail ? `The Android CLI said: ${tail}` : 'The Android CLI reported nothing useful.'} Full log: ${androidToolLogPath()}`);
}

async function installPackage(packageName: string, timeout: number): Promise<void> {
  const tools = sdk();
  if (!/^[A-Za-z0-9;._-]{3,120}$/.test(packageName)) throw new Error('Invalid SDK package name');
  let cli = androidCli(tools.root) || androidCli(tools.toolsRoot);
  if (!cli) {
    // No modern CLI anywhere: fetch the command-line tools package, which is
    // also what the deprecated sdkmanager stub tells the user to do by hand.
    try { await ensureCommandLineTools(tools.root); cli = androidCli(tools.root); }
    catch (error) { if (!tools.sdkmanager) throw error; }
  }
  // The new CLI is the tool Google still maintains; sdkmanager is only used
  // when this SDK has no `android` binary yet.
  if (cli) {
    try { await installWithCli(cli, tools.root, packageName, timeout); return; }
    catch (error) {
      if (!tools.sdkmanager) throw error;
      reportAndroidProgress({ stage: 'install', percent: -1, text: 'Retrying with sdkmanager' });
    }
  }
  if (!tools.sdkmanager) throw new Error('Android SDK command-line tools not found');
  if (!folderWritable(tools.root)) {
    throw new Error(`The install folder ${tools.root} is not writable by this user. Pick another folder under "Install location", or run Octo as the user that owns that folder.`);
  }
  if (!javaHome()) {
    const found = javaVersionFound();
    throw new Error(`The Android SDK tools need Java ${MIN_JAVA} or newer${found ? `, but only Java ${found} is installed` : ', and no JDK was found'}. Run install.bat to install OpenJDK 17 (or install Android Studio) and try again.`);
  }
  const disk = androidDiskInfo(tools.root);
  const image = ANDROID_SYSTEM_IMAGES.find((item) => item.packageName === packageName);
  if (image && disk.freeBytes > 0 && disk.freeBytes < image.imageBytes + 1_000_000_000) {
    throw new Error(`${Math.round(disk.freeBytes / 1e9)} GB free in ${tools.root} is not enough for ${packageName} (about ${Math.round(image.imageBytes / 1e9)} GB plus room to unpack). Pick another install folder.`);
  }
  // A locally installed sdkmanager in the writable root is always at least as
  // new as the one shipped with the detected SDK, so prefer it.
  let sdkmanager = locate(tools.root, 'sdkmanager') || tools.sdkmanager;
  // `--verbose` was dropped by the newest command-line tools; the progress bar
  // is parsed from sdkmanager's normal output anyway.
  const args = () => [`--sdk_root=${tools.root}`, '--install', packageName, ...proxyArgs()];
  // A brand-new install folder carries no accepted licences, and sdkmanager
  // then refuses every package. Accept them once, up front, instead of making
  // the user hit a licence error first.
  if (!fs.existsSync(path.join(tools.root, 'licenses'))) {
    reportAndroidProgress({ stage: 'licence', percent: -1, text: 'Accepting the Android SDK licences' });
    try { await runSdkManager(sdkmanager, tools.root, [`--sdk_root=${tools.root}`, '--licenses', ...proxyArgs()], 5 * 60_000); }
    catch { /* the install below reports whatever is really wrong */ }
  }
  reportAndroidProgress({ stage: 'install', percent: 0, text: `Preparing ${packageName}` });

  let output = '';
  const attempt = async (extra: string[] = []): Promise<void> => {
    output = await runSdkManager(sdkmanager, tools.root, [...args(), ...extra], timeout);
  };
  try {
    await attempt();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    output = message;
    if (/licen[cs]e/i.test(message)) {
      reportAndroidProgress({ stage: 'licence', percent: -1, text: 'Accepting the Android SDK licences' });
      await runSdkManager(sdkmanager, tools.root, [`--sdk_root=${tools.root}`, '--licenses', ...proxyArgs()], 5 * 60_000);
      await attempt();
    } else if (isNetworkFailure(error)) {
      reportAndroidProgress({ stage: 'download', percent: -1, text: 'Retrying the download over plain HTTP' });
      await attempt(['--no_https']);
    } else if (!packageUnknown(message)) throw error;
  }

  // sdkmanager reports an unknown package as a warning and still exits 0, so
  // the output has to be inspected even on "success".
  // Newer command-line tools ship an sdkmanager stub that only prints
  // "Android CLI will be used instead" and ignores --sdk_root/--install, so
  // nothing is downloaded. Run the real CLI with its own syntax instead.
  if (cli && usesNewCli(output) && !androidPackageInstalled(packageName)) {
    try { await installWithCli(cli, tools.root, packageName, timeout); return; }
    catch (error) { output = error instanceof Error ? error.message : String(error); }
  }

  // A corrupt archive is retried once from scratch: the cached bytes are the
  // problem, not the package.
  if (brokenArchive(output)) {
    reportAndroidProgress({ stage: 'download', percent: -1, text: 'Removing a damaged download and starting again' });
    clearDownloadCache(tools.root);
    try { await attempt(); } catch (error) { output = error instanceof Error ? error.message : String(error); }
  }

  if (packageUnknown(output) && packageName !== 'cmdline-tools;latest') {
    sdkmanager = await refreshCommandLineTools(tools.root, sdkmanager);
    try { await attempt(); } catch (error) { output = error instanceof Error ? error.message : String(error); }
  }

  if (androidPackageInstalled(packageName)) { reportAndroidProgress({ stage: 'done', percent: 100, text: `${packageName} is installed` }); return; }
  if (await packageInstalledPerSdkManager(sdkmanager, tools.root, packageName)) {
    reportAndroidProgress({ stage: 'done', percent: 100, text: `${packageName} is installed` });
    return;
  }
  if (packageUnknown(output)) {
    const newest = await newestOfferedApis();
    const hint = newest.length ? ` The newest system images this SDK can download are API ${newest.join(', ')}.` : '';
    throw new Error(`The Android SDK repository does not offer ${packageName} to this SDK, so nothing was downloaded.${hint} Pick one of those versions, or update Android Studio's command-line tools.`);
  }
  if (brokenArchive(output)) {
    clearDownloadCache(tools.root);
    throw new Error(`The download of ${packageName} arrived damaged twice (sdkmanager: "unknown archive"). The cached files were removed - check the connection or proxy and start the download again.`);
  }
  const tail = meaningfulOutput(output).split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 300);
  throw new Error(`${packageName} was not written to ${tools.root}. ${tail ? `The tool said: ${tail}` : 'The tool reported nothing useful.'} Full log: ${androidToolLogPath()}`);
}

/** Pass an http(s) proxy from the environment to sdkmanager explicitly. */
function proxyArgs(): string[] {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
  if (!raw) return [];
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    if (!url.hostname) return [];
    return [`--proxy=${url.protocol === 'socks:' ? 'socks' : 'http'}`, `--proxy_host=${url.hostname}`, `--proxy_port=${url.port || '8080'}`];
  } catch { return []; }
}

function assertName(name: string): string {
  const clean = name.trim();
  if (!NAME.test(clean)) throw new Error('Invalid Android virtual device name');
  return clean;
}

function image(systemId: string): AndroidSystemImage {
  const found = androidSystemImage(systemId);
  if (!found) throw new Error('Unknown Android system image');
  return found;
}

function device(deviceId: string): AndroidDeviceProfile {
  const found = androidDevice(deviceId);
  if (!found) throw new Error('Unknown Android device model');
  return found;
}

/**
 * Tool paths always come from the detected SDK, but `root` is the folder that
 * packages are installed into and that the emulator is pointed at. The two are
 * different whenever the detected SDK sits in a read-only location such as
 * `C:\\Program Files (x86)\\Android\\android-sdk`.
 */
function sdk(): { root: string; toolsRoot: string; avdmanager: string; sdkmanager: string; emulator: string; adb: string } {
  const toolsRoot = roots()[0] ?? '';
  if (!toolsRoot) throw new Error('Android SDK not found');
  const root = androidInstallRoot();
  try { fs.mkdirSync(root, { recursive: true }); } catch { /* reported by the writability check */ }
  // Tools in the writable root come from the command-line tools package we
  // installed ourselves, so they understand the newest packages; the detected
  // SDK (often an old Android Studio copy) is only the fallback. Using an old
  // avdmanager against a new image is what produced
  // "Package path is not valid. Valid system image paths are: null".
  const pick = (tool: 'avdmanager' | 'sdkmanager' | 'emulator' | 'adb'): string => locate(root, tool) || locate(toolsRoot, tool);
  return { root, toolsRoot, avdmanager: pick('avdmanager'), sdkmanager: pick('sdkmanager'), emulator: pick('emulator'), adb: pick('adb') };
}

function configPath(avdPath: string): string {
  return path.join(avdPath, 'config.ini');
}

/** App metadata (camera choice, timezone, label) lives beside config.ini, never inside it. */
const APP_META_FILE = 'octo-avd.json';

function readAppMeta(avdPath: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(avdPath, APP_META_FILE), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && isAppMetaKey(entry[0]) && !isIdentityKey(entry[0])));
  } catch { return {}; }
}

function writeAppMeta(avdPath: string, meta: Record<string, string>): void {
  const kept = Object.keys(meta).filter((key) => isAppMetaKey(key) && !isIdentityKey(key) && meta[key] !== '').sort();
  fs.mkdirSync(avdPath, { recursive: true });
  fs.writeFileSync(path.join(avdPath, APP_META_FILE), JSON.stringify(Object.fromEntries(kept.map((key) => [key, meta[key]])), null, 2) + '\n', { mode: 0o600 });
}

/**
 * The only writer for an AVD's config.ini. Keys with an undefined value are left
 * alone, an empty value removes the key, and everything written passes the rules in
 * android-avd-config.ts (no forbidden keys, no spoofed identity, clamped limits,
 * forward-slash paths, real AvdId, sorted, unique, UTF-8).
 */
export function writeConfigValues(avdPath: string, values: Record<string, string | undefined>): void {
  const file = configPath(avdPath);
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* avdmanager creates the file */ }
  const entries: Record<string, string | undefined> = { ...parseAvdConfig(text) };
  const meta = readAppMeta(avdPath);
  // App metadata that an older save left in config.ini moves to the sidecar; identity is dropped.
  for (const key of Object.keys(entries)) {
    if (!isAppMetaKey(key)) continue;
    const legacy = entries[key] ?? '';
    if (!(key in meta) && !isIdentityKey(key) && legacy !== '') meta[key] = legacy;
    delete entries[key];
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (isAppMetaKey(key)) {
      if (value === '') delete meta[key];
      else meta[key] = value;
      continue;
    }
    entries[key] = value;
  }
  const avdName = path.basename(avdPath).replace(/\.avd$/i, '');
  fs.mkdirSync(avdPath, { recursive: true });
  fs.writeFileSync(file, renderAvdConfig(canonicalAvdConfig(entries, { avdName, avdPath })), { mode: 0o600 });
  writeAppMeta(avdPath, meta);
}

/**
 * Emulator camera wiring.
 *
 * `webcam0` is NOT "the virtual camera": it is simply the first camera the
 * emulator enumerates, which on a laptop is the built-in one. Wiring every
 * device to webcam0 is why Android showed the real webcam instead of vStudio
 * Mobile. The exact `webcamN` is therefore resolved from
 * `emulator -webcam-list`, remembered per device, and used both in config.ini
 * and on the command line.
 */
function cameraValue(source: CameraSource | string, webcam = ''): string {
  // A lens is either one enumerated host endpoint or off. An unknown or stale
  // index switches the lens off; it never turns into webcam0 or into a picture
  // that is not a camera.
  return source === 'webcam' && WEBCAM.test(webcam) ? webcam : 'none';
}

/** The saved value of one lens. Every saved value means a host camera chosen automatically. */
export function normalizeCameraSource(_saved?: string): CameraSource {
  return 'webcam';
}

/**
 * The saved intent of both lenses. Missing, unknown and older values (`none`,
 * `emulated`, `virtualscene`, `vstudio`) all become `webcam`, so a device saved
 * with "no camera" is given the first active camera on its next launch, just
 * like a new device. Only the endpoint a lens holds says whether it has a camera.
 */
export function normalizeCameraSources(front?: string, back?: string): { front: CameraSource; back: CameraSource } {
  return { front: normalizeCameraSource(front), back: normalizeCameraSource(back) };
}

/**
 * The value each lens is launched with: its endpoint, or `none` when it is off.
 *
 * Two lenses never share one host endpoint. Android's CameraProvider can crash
 * when the same DirectShow endpoint is opened for both facings, so the front
 * lens gives way, the same way assignLensCameras settles it.
 */
export function emulatorCameraValues(
  front: CameraSource | string,
  back: CameraSource | string,
  frontWebcam = '',
  backWebcam = '',
): { front: string; back: string } {
  const backValue = cameraValue(back, backWebcam);
  let frontValue = cameraValue(front, frontWebcam);
  if (frontValue !== 'none' && frontValue === backValue) frontValue = 'none';
  return { front: frontValue, back: backValue };
}

const WEBCAM = /^webcam\d{1,2}$/;
/**
 * Software cameras a program on this computer can publish. OBS Virtuald Unity
 * Video Capture are the two back-ends the companion registers itself through.
 */
const VIRTUAL_CAMERA = /obs[- ]?virtual|virtual ?cam|vstudio|v-?studio|unity ?(video )?capture|screen ?capture|v-?cam/i;
/**
 * Also virtual, but another app's: phone-as-webcam bridges. They are listed
 * with their source label, so the user can see where the picture comes from,
 * and they are chosen like any other active camera.
 */
const FOREIGN_CAMERA = /iriun|droidcam|epoccam|ivcam|camo|kinoni|e2esoft|reincubate|xsplit|manycam|splitcam|snap ?camera/i;

export interface EmulatorWebcam {
  /** The name the emulator expects on the command line, e.g. "webcam1". */
  name: string;
  /** The host device the emulator connected it to. */
  device: string;
  /** This looks like a software/virtual camera (what a companion app provides). */
  virtual: boolean;
  /** Another app's phone-as-webcam or virtual camera (Iriun, DroidCam, ...). Labelled, not excluded. */
  foreign?: boolean;
  /** The Windows device path the emulator printed, when it printed one (the picker only). */
  path?: string;
  /** Vendor and product ID as "04f2:b6d0", when the camera has one (the picker only). */
  hardwareId?: string;
}

/**
 * `emulator -webcam-list` prints one line per camera. The quotes around the
 * names differ between builds and platforms - single quotes on Linux, backticks
 * in some Windows builds, typographic quotes in some translations - so every
 * one of these forms is read:
 *   List of web cameras connected to the computer:
 *    Camera 'webcam0' is connected to device '/dev/video0' on channel 0 using pixel format 'YUYV'
 *    Camera `webcam0` is connected to device `Integrated Camera` on channel 0 using pixel format `BGR4`
 */
const WEBCAM_LINE = /Camera\s+[`'"\u2018\u201C]?(webcam\d{1,2})[`'"\u2019\u201D]?\s+is\s+connected\s+to\s+device\s+[`'"\u2018\u201C]?(.+?)[`'"\u2019\u201D]?(?:\s+on\s+channel\b|\s*$)/i;
const WEBCAM_COMPACT = /^\s*(webcam\d{1,2})\s*[:=]\s*(.+?)\s*$/i;
const SURROUNDING_QUOTES = /^[`'"\u2018\u201C]+|[`'"\u2019\u201D]+$/g;

export function parseWebcamList(raw: string): EmulatorWebcam[] {
  const rows: EmulatorWebcam[] = [];
  const seenNames = new Set<string>();
  const seenDevices = new Set<string>();
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const match = WEBCAM_LINE.exec(line) ?? WEBCAM_COMPACT.exec(line);
    const name = match?.[1] ?? '';
    const device = (match?.[2] ?? '').replace(SURROUNDING_QUOTES, '').replace(/\s+/g, ' ').trim();
    if (!name || !device) continue;
    const normalizedName = name.toLocaleLowerCase();
    const normalizedDevice = device.toLocaleLowerCase();
    if (seenNames.has(normalizedName) || seenDevices.has(normalizedDevice)) continue;
    seenNames.add(normalizedName);
    seenDevices.add(normalizedDevice);
    rows.push({ name, device, virtual: VIRTUAL_CAMERA.test(device), foreign: FOREIGN_CAMERA.test(device) });
  }
  return rows;
}

/**
 * The cameras an Android device can use: exactly the ones `emulator -webcam-list`
 * prints, under the names it gives them. Nothing is numbered by position and
 * nothing is added from Windows: a camera the emulator does not list cannot be
 * opened by the device, so it is not offered. The output is read even when the
 * command exits non-zero, because some builds print the list and then fail.
 */
export async function emulatorWebcams(): Promise<EmulatorWebcam[]> {
  const tools = optionalSdk();
  if (!tools?.emulator) return [];
  try { return (await emulatorWebcamsFrom(tools.emulator, tools.root)).webcams; }
  catch { return []; }
}

/** Enumerate cameras with the exact emulator binary and SDK root for an AVD. */
export async function emulatorWebcamsFrom(
  emulator: string,
  sdkRoot: string,
  timeout = CAMERA_LAUNCH_LIMIT_MS,
): Promise<EmulatorCameraReport> {
  if (!emulator || !sdkRoot) return { webcams: [], problem: 'none', detail: '' };
  return emulatorCameraReport({ emulator, root: sdkRoot }, timeout, false);
}

/** Launches and the media check read the list with this limit. */
const CAMERA_LAUNCH_LIMIT_MS = 25_000;
/**
 * The picker waits longer. The emulator opens every camera before it prints
 * anything, so one camera that does not answer holds the whole list back.
 */
const CAMERA_PICKER_LIMIT_MS = 45_000;

/** Why the emulator's camera list is empty, when it is. */
export type CameraListProblem = '' | 'timeout' | 'reported' | 'none';

export interface EmulatorCameraReport {
  webcams: EmulatorWebcam[];
  problem: CameraListProblem;
  /** The emulator's own words for a failure, when it gave some. */
  detail: string;
}

/** One emulator run that prints the camera list. Whatever it printed is kept, even when it is stopped. */
function runCameraList(program: string, args: string[], sdkRoot: string, timeout: number): Promise<{ text: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try { child = spawnTool(program, args, sdkRoot, false); }
    catch (error) { resolve({ text: error instanceof Error ? error.message : String(error), timedOut: false }); return; }
    let out = '';
    let err = '';
    child.stdout?.on('data', (chunk: Buffer) => { out = (out + chunk.toString()).slice(-200_000); });
    child.stderr?.on('data', (chunk: Buffer) => { err = (err + chunk.toString()).slice(-50_000); });
    let timedOut = false;
    let done = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* already gone */ } }, timeout);
    const finish = (text: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      logToolRun(program, args, text);
      resolve({ text, timedOut });
    };
    child.once('error', (error) => finish(`${out}\n${err}\n${error.message}`.trim()));
    child.once('close', () => finish(`${out}\n${err}`.trim()));
  });
}

/**
 * The first line of the emulator's log that names a camera failure, in plain
 * words. Device paths are long, so they are shown as "a Windows camera".
 */
export function cameraProblemLine(text: string): string {
  const failure = /could not initiali[sz]e mediafoundation|failed to enumerate webcam|failed to get webcam info|mfenumdevicesources|mfstartup failed|coinitialize failed|media foundation could not be loaded|^error:/i;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^(INFO|ERROR|WARNING):\s*/i, '');
    if (!line || !failure.test(line)) continue;
    return line.replace(/\\\\\?\\[^\s'",]+/g, 'a Windows camera').slice(0, 240);
  }
  return '';
}

/** Cameras Windows reports as present, read once a minute. Shared by every caller while one read runs. */
const WINDOWS_NAMES_TTL_MS = 60_000;
let windowsNamesCache: { at: number; cameras: WindowsCameraName[] } | null = null;
let windowsNamesInFlight: Promise<WindowsCameraName[]> | null = null;

function windowsCameraNames(): Promise<WindowsCameraName[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  if (windowsNamesCache && Date.now() - windowsNamesCache.at < WINDOWS_NAMES_TTL_MS) return Promise.resolve(windowsNamesCache.cameras);
  if (!windowsNamesInFlight) {
    windowsNamesInFlight = readWindowsCameraNames()
      .then((cameras) => { windowsNamesCache = { at: Date.now(), cameras }; return cameras; })
      .finally(() => { windowsNamesInFlight = null; });
  }
  return windowsNamesInFlight;
}

/**
 * The USB and software cameras Windows has present, with their friendly names.
 * Resolves to an empty list when PowerShell cannot answer: a camera is then
 * shown by its hardware ID, never guessed.
 */
function readWindowsCameraNames(): Promise<WindowsCameraName[]> {
  const script = "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }; "
    + "Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue "
    + "| Where-Object { $_.InstanceId -like 'USB\\*' -or $_.InstanceId -like 'SWD\\*' } "
    + "| Select-Object InstanceId, FriendlyName | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15_000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) { resolve([]); return; }
        try {
          const parsed: unknown = JSON.parse(String(stdout || '').trim() || '[]');
          const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
          resolve(rows.flatMap((row): WindowsCameraName[] => {
            const item = row as { InstanceId?: unknown; FriendlyName?: unknown } | null;
            return typeof item?.InstanceId === 'string' && typeof item.FriendlyName === 'string'
              ? [{ instanceId: item.InstanceId, friendlyName: item.FriendlyName }]
              : [];
          }));
        } catch { resolve([]); }
      });
  });
}

/**
 * The picker's view of the emulator's cameras. A device path is replaced by the
 * Windows name of its camera; the path and the hardware ID are kept for matching.
 * A path that cannot be named has an empty name, and the picker shows its ID.
 */
function namedWebcams(webcams: EmulatorWebcam[], windows: WindowsCameraName[]): EmulatorWebcam[] {
  return webcams.map((item) => {
    if (!isDevicePath(item.device)) return { ...item, hardwareId: hardwareIdOf(item.device) };
    return {
      ...item,
      path: item.device,
      device: friendlyNameForDevicePath(item.device, windows),
      hardwareId: hardwareIdOf(item.device),
    };
  });
}

/**
 * Ask the emulator for its list and say why it is empty. The picker asks with
 * `-verbose`, so the emulator also prints why a camera was left out; the launch
 * does not need that and asks plainly.
 */
async function emulatorCameraReport(tools: { emulator: string; root: string }, timeout: number, forPicker: boolean): Promise<EmulatorCameraReport> {
  const args = [...await emulatorTelemetryArgs(tools.emulator, tools.root), ...(forPicker ? ['-webcam-list', '-verbose'] : ['-webcam-list'])];
  const run = await runCameraList(tools.emulator, args, tools.root, timeout);
  const parsed = parseWebcamList(run.text);
  if (parsed.length) {
    return { webcams: forPicker ? namedWebcams(parsed, await windowsCameraNames()) : parsed, problem: '', detail: '' };
  }
  if (run.timedOut) return { webcams: [], problem: 'timeout', detail: '' };
  const detail = cameraProblemLine(run.text);
  return { webcams: [], problem: detail ? 'reported' : 'none', detail };
}

/**
 * What the Android device pickers need: the cameras the emulator lists on this
 * computer, and why the list is empty when it is. The picker opens each one
 * before offering it, so a camera that cannot send a picture is never shown.
 */
export interface CameraChoices {
  /** Every camera `emulator -webcam-list` names, in the emulator's order. */
  webcams: EmulatorWebcam[];
  /** The Android Emulator is installed, so its camera list could be asked. */
  emulatorAvailable: boolean;
  /** Number of host cameras reported by the OS-level probe, when available. */
  hostCameraCount?: number;
  /** Exact emulator binary and SDK root used for the last probe. */
  emulatorPath?: string;
  sdkRoot?: string;
  /** Why `webcams` is empty: the list timed out, the emulator reported a failure, or it found no camera. */
  problem: CameraListProblem;
  /** The emulator's own words for the failure, when it gave some. */
  detail: string;
}

/**
 * The camera list is re-read while a picker is open (hot-plug). Each read starts
 * the emulator, so reads closer together than this share one result, and a read
 * already running is joined, not repeated.
 */
const CAMERA_SCAN_TTL_MS = 4_000;
let cameraScanCache: { at: number; value: CameraChoices } | null = null;
let cameraScanInFlight: Promise<CameraChoices> | null = null;

export function androidCameraChoicesCached(): Promise<CameraChoices> {
  if (cameraScanCache && Date.now() - cameraScanCache.at < CAMERA_SCAN_TTL_MS) return Promise.resolve(cameraScanCache.value);
  if (cameraScanInFlight) return cameraScanInFlight;
  cameraScanInFlight = androidCameraChoices()
    .then((value) => { cameraScanCache = { at: Date.now(), value }; return value; })
    .finally(() => { cameraScanInFlight = null; });
  return cameraScanInFlight;
}

export async function androidCameraChoices(): Promise<CameraChoices> {
  const tools = optionalSdk();
  const hostCameraCount = (await windowsCameraNames()).length || undefined;
  if (!tools?.emulator) return { webcams: [], emulatorAvailable: false, hostCameraCount, problem: '', detail: '' };
  const candidates = [...new Set([
    tools.emulator,
    ...knownRoots().map((root) => locate(root, 'emulator')).filter(Boolean),
  ])];
  let last: EmulatorCameraReport = { webcams: [], problem: 'none', detail: '' };
  for (const emulator of candidates) {
    const root = path.dirname(path.dirname(emulator));
    const report = await emulatorCameraReport({ emulator, root }, CAMERA_PICKER_LIMIT_MS, true);
    if (report.webcams.length) return { webcams: report.webcams, emulatorAvailable: true, hostCameraCount, emulatorPath: emulator, sdkRoot: root, problem: '', detail: '' };
    last = report;
  }
  return { webcams: [], emulatorAvailable: true, hostCameraCount, emulatorPath: candidates[0], sdkRoot: path.dirname(path.dirname(candidates[0] ?? '')), problem: last.problem, detail: last.detail };
}

export interface ActiveCameraAssignments {
  front: CameraSource;
  back: CameraSource;
  frontDevice: string;
  backDevice: string;
  warning: string;
}

/**
 * Give each lens an active host camera. The rule is the one the picker uses
 * (assignLensCameras in @octo/core): a saved endpoint is kept while the emulator
 * still enumerates it; a lens whose camera is gone takes another active camera
 * that the other lens does not hold; a lens with nothing left is off. Nothing is
 * substituted by webcam0 or by the emulator's own picture.
 *
 * The saved source of each lens is always a host camera (see
 * normalizeCameraSource), so only the endpoints decide the result.
 */
export function resolveActiveCameraAssignments(
  _front: CameraSource | string,
  _back: CameraSource | string,
  frontDevice: string,
  backDevice: string,
  webcams: EmulatorWebcam[],
  /** Kept for the callers' sake; a host camera is matched by endpoint only. */
  _preferred: string[] = [],
  legacyDevice = '',
): ActiveCameraAssignments {
  const live = webcams.filter((item) => item.name).map((item) => ({ id: item.name, name: item.device }));
  const activeIds = new Set(live.map((item) => item.id));
  // A device that recorded only its last camera in the shared key still gets it, on the rear lens.
  const rearPreferred = backDevice || (WEBCAM.test(legacyDevice) ? legacyDevice : '');
  const assigned = assignLensCameras({ front: frontDevice, back: rearPreferred }, live);
  const warnings: string[] = [];
  const explain = (lens: 'front' | 'rear', saved: string, lost: boolean, now: string, shared: boolean): void => {
    if (!lost || !saved) return;
    const reason = shared ? 'One camera cannot serve both lenses.' : `The saved ${lens} camera is no longer active.`;
    warnings.push(now
      ? `${reason} The ${lens} lens now uses ${now}.`
      : `${reason} No other camera is free for the ${lens} lens, so it is off.`);
  };
  explain('rear', rearPreferred, assigned.lost.back, assigned.back, false);
  explain('front', frontDevice, assigned.lost.front, assigned.front, activeIds.has(frontDevice));
  return {
    front: assigned.front ? 'webcam' : 'none',
    back: assigned.back ? 'webcam' : 'none',
    frontDevice: assigned.front,
    backDevice: assigned.back,
    warning: warnings.join(' '),
  };
}

/**
 * The saved camera intent of a device, as the settings read it. Only the
 * endpoint a lens holds says whether it has a camera (see normalizeCameraSource).
 */
function cameraFromConfig(value: string, intended = ''): CameraSource {
  return normalizeCameraSource(intended || value);
}

/** "1280x720" as measured from a real frame, or undefined. */
export function parseCameraLimit(value: unknown): CameraResolution | undefined {
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(String(value ?? '').trim());
  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
}

/** Even pixel counts inside what the emulator's camera HAL can describe. */
export function clampCameraLimit(limit: CameraResolution): CameraResolution {
  return {
    width: Math.max(320, Math.min(4096, Math.round(limit.width / 2) * 2)),
    height: Math.max(240, Math.min(4096, Math.round(limit.height / 2) * 2)),
  };
}

/**
 * The resolution each facing can really produce: what the caller measured just
 * now, otherwise what an earlier test measured and left in the AVD config.
 */
function cameraLimitsFor(
  avdPath: string,
  provided?: { front?: CameraResolution; back?: CameraResolution },
): { front?: CameraResolution; back?: CameraResolution } {
  return {
    front: provided?.front ?? parseCameraLimit(configValue(avdPath, 'octobrowser.cameraFrontLimit')),
    back: provided?.back ?? parseCameraLimit(configValue(avdPath, 'octobrowser.cameraBackLimit')),
  };
}

/**
 * What one lens can honestly advertise to Android.
 *
 * `hw.camera.maxHorizontalPixels` and `maxVerticalPixels` are what the guest's
 * Camera2 HAL offers to apps. Claiming Full HD for a webcam that only produces
 * 720p leaves apps requesting a stream the producer cannot fill, which is one
 * of the ways a camera "crashes" instead of showing a picture. A measured host
 * camera reports what was measured; an unmeasured one reports HD.
 */
function cameraLimitFor(value: string, measured?: CameraResolution): CameraResolution | undefined {
  if (value === 'none') return undefined;
  return clampCameraLimit(measured ?? UNMEASURED_CAMERA_LIMIT);
}

/**
 * The `config.ini` keys one device boots with, from the two lenses and the
 * microphone switch. Exported so the crash rules (no shared endpoint, no
 * resolution a lens cannot deliver) are pinned by tests.
 */
export function mediaConfig(
  front: CameraSource | string,
  back: CameraSource | string,
  microphoneEnabled: boolean,
  frontWebcam = '',
  backWebcam = '',
  limits: { front?: CameraResolution; back?: CameraResolution } = {},
): Record<string, string> {
  const values = emulatorCameraValues(front, back, frontWebcam, backWebcam);
  const cameraEnabled = values.front !== 'none' || values.back !== 'none';
  const actualFrontDevice = values.front !== 'none' ? values.front : '';
  const actualBackDevice = values.back !== 'none' ? values.back : '';
  const frontLimit = cameraLimitFor(values.front, limits.front);
  const backLimit = cameraLimitFor(values.back, limits.back);
  // One pair of keys describes the whole device, and Android offers that number
  // to every app that opens either camera. Promising more than the weakest live
  // lens can deliver is how an app requested a stream that never arrived, so the
  // smaller of the two active lenses wins; a lens that is off contributes nothing.
  const active = [frontLimit, backLimit].filter((limit): limit is CameraResolution => !!limit);
  const maxHorizontal = active.length ? Math.min(...active.map((limit) => limit.width)) : 0;
  const maxVertical = active.length ? Math.min(...active.map((limit) => limit.height)) : 0;
  return {
    'hw.camera.back': values.back,
    'hw.camera.front': values.front,
    'hw.camera.maxHorizontalPixels': String(maxHorizontal || DEFAULT_CAMERA_LIMIT.width),
    'hw.camera.maxVerticalPixels': String(maxVertical || DEFAULT_CAMERA_LIMIT.height),
    'hw.audioInput': microphoneEnabled ? 'yes' : 'no',
    'hw.audioOutput': 'yes',
    // A lens that is off is recorded as off; a lens with a camera as a host webcam.
    'octobrowser.cameraFront': values.front === 'none' ? 'none' : 'webcam',
    'octobrowser.cameraBack': values.back === 'none' ? 'none' : 'webcam',
    'octobrowser.cameraFrontDevice': actualFrontDevice,
    'octobrowser.cameraBackDevice': actualBackDevice,
    'octobrowser.cameraDevice': actualBackDevice || actualFrontDevice,
    'octobrowser.cameraFrontLimit': limits.front ? `${limits.front.width}x${limits.front.height}` : '',
    'octobrowser.cameraBackLimit': limits.back ? `${limits.back.width}x${limits.back.height}` : '',
  };
}

export function configValue(avdPath: string, key: string): string {
  if (isAppMetaKey(key)) {
    // Retired identity is never read back, from either file.
    if (isIdentityKey(key)) return '';
    const meta = readAppMeta(avdPath);
    if (key in meta) return meta[key];
    // A device saved before the sidecar kept this in config.ini; the next save moves it.
  }
  try {
    const line = fs.readFileSync(configPath(avdPath), 'utf8').split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
    return line?.slice(key.length + 1) ?? '';
  } catch { return ''; }
}

/**
 * Recursive AVD size without blocking Electron's main thread. A device can be
 * tens of gigabytes and contain thousands of snapshot files; the previous
 * readdirSync/statSync walk was enough for Windows to mark Octo "Not
 * Responding" whenever the Android page refreshed. Results are briefly cached
 * because the row is commonly repainted several times while an emulator boots.
 */
const folderSizeCache = new Map<string, { at: number; bytes: number }>();
async function folderBytes(target: string, budget = 20_000): Promise<number> {
  const cached = folderSizeCache.get(target);
  if (cached && Date.now() - cached.at < 30_000) return cached.bytes;
  let bytes = 0;
  let seen = 0;
  const pending = [target];
  while (pending.length && seen <= budget) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[] = [];
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    await Promise.all(entries.map(async (entry) => {
      if (seen++ > budget) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) { try { bytes += (await fs.promises.stat(full)).size; } catch { /* vanished */ } }
    }));
  }
  folderSizeCache.set(target, { at: Date.now(), bytes });
  return bytes;
}

/** Free/total space for the folder the wizard is about to write into. */
export function androidDiskInfo(target: string): DiskInfo {
  const clean = String(target || '').trim();
  const empty: DiskInfo = { path: clean, exists: false, writable: false, freeBytes: 0, totalBytes: 0 };
  if (!ABSOLUTE(clean)) return empty;
  // statfs needs an existing path: walk up to the nearest existing parent.
  let probe = clean;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return empty;
    probe = parent;
  }
  try {
    const stats = fs.statfsSync(probe);
    let writable = false;
    try { fs.accessSync(probe, fs.constants.W_OK); writable = true; } catch { writable = false; }
    return { path: clean, exists: fs.existsSync(clean), writable, freeBytes: stats.bavail * stats.bsize, totalBytes: stats.blocks * stats.bsize };
  } catch { return { ...empty, exists: fs.existsSync(clean) }; }
}

/** Default parent folder for new devices: Android Studio's own AVD home. */
/** SDK root for sibling modules that need `adb` (network control). */
export function androidSdkRootForTools(): string {
  return roots()[0] ?? '';
}

export function defaultAvdDirectory(): string {
  const explicit = process.env.ANDROID_AVD_HOME;
  if (explicit && ABSOLUTE(explicit)) return explicit;
  return path.join(os.homedir(), '.android', 'avd');
}

// ---------------------------------------------------------------- finding devices again

/**
 * A device the user created is only useful when we can find it back. Three
 * things used to hide a freshly created AVD:
 *
 *  1. `avdmanager list avd` indents every field ("    Name: Pixel_8"), so a
 *     `/^Name:/` parser returned an empty list and the section claimed there
 *     were no devices at all;
 *  2. a device created in a folder of the user's choice is only reachable
 *     through the `<AVD home>/<name>.ini` pointer, which we now always write;
 *  3. without command-line tools `avdmanager` cannot run at all, although the
 *     device folders are perfectly readable.
 *
 * So the folders are scanned directly and the tool output is only merged in as
 * extra detail.
 */
export interface AvdLocation { name: string; path: string; target: string }

/** Every folder that may hold a `<name>.avd`, the AVD home first. */
export function avdSearchDirectories(): string[] {
  const dirs = [defaultAvdDirectory(), ...readOverrides().deviceDirs];
  for (const root of knownRoots()) dirs.push(path.join(root, 'avd'));
  return [...new Set(dirs.filter((dir) => ABSOLUTE(dir)))];
}

/** Remember a folder we created a device in, so it is scanned next time. */
export function rememberAvdDirectory(dir: string): void {
  if (!ABSOLUTE(dir)) return;
  const clean = path.resolve(dir);
  if (clean === path.resolve(defaultAvdDirectory())) return;
  const current = readOverrides().deviceDirs;
  if (current.some((entry) => path.resolve(entry) === clean)) return;
  try { writeOverrides({ deviceDirs: [...current, clean].slice(-32) }); } catch { /* the scan still works this session */ }
}

/**
 * Write the `<AVD home>/<name>.ini` pointer. avdmanager normally does this,
 * but a device created into another folder is invisible to `emulator @name`
 * and to Android Studio when the pointer is missing or stale.
 */
export function writeAvdPointer(name: string, avdPath: string, api = 0): string {
  if (!NAME.test(name) || !ABSOLUTE(avdPath)) return '';
  const home = defaultAvdDirectory();
  const file = path.join(home, `${name}.ini`);
  try {
    fs.mkdirSync(home, { recursive: true });
    const lines = ['avd.ini.encoding=UTF-8', `path=${avdPath}`];
    // `path.rel` is only meaningful for a device that lives in the AVD home.
    if (path.resolve(path.dirname(avdPath)) === path.resolve(home)) lines.push(`path.rel=avd/${name}.avd`);
    if (api > 0) lines.push(`target=android-${api}`);
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    return file;
  } catch { return ''; }
}

/** The folder a `<name>.ini` pointer refers to, resolved and verified. */
function avdPointerTarget(file: string): string {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const raw = /^\s*path\s*=\s*(.+?)\s*$/m.exec(text)?.[1] ?? '';
    if (!raw) return '';
    const full = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(path.dirname(file)), raw);
    return fs.existsSync(path.join(full, 'config.ini')) ? full : '';
  } catch { return ''; }
}

/**
 * A device folder without its system image is a leftover from an interrupted
 * creation: it lists, it looks real, and the emulator dies the moment it is
 * launched. Detect it so the UI can offer to delete it instead.
 */
function avdIncomplete(avdPath: string): boolean {
  const sysdir = configValue(avdPath, 'image.sysdir.1');
  if (!sysdir) return true;
  const parts = sysdir.split(/[\\/]+/).filter(Boolean);
  return !knownRoots().some((root) => fs.existsSync(path.join(root, ...parts)));
}

/** A readable target line built from the AVD's own config.ini. */
function describeAvd(avdPath: string): string {
  const tag = configValue(avdPath, 'tag.display') || configValue(avdPath, 'tag.id');
  const api = configValue(avdPath, 'image.androidVersion.api');
  const abi = configValue(avdPath, 'abi.type');
  return [api ? `API ${api}` : '', tag, abi].filter(Boolean).join(' · ');
}

/**
 * `avdmanager list avd` prints indented blocks and a second, separate section
 * for devices it could not load. Parsed defensively: a block without a path,
 * or one carrying an error, is skipped instead of becoming a phantom device.
 */
export function parseAvdList(raw: string): AvdLocation[] {
  const rows: AvdLocation[] = [];
  let current: (AvdLocation & { broken: boolean }) | undefined;
  const flush = () => {
    if (current && current.name && current.path && !current.broken) {
      rows.push({ name: current.name, path: current.path, target: current.target });
    }
    current = undefined;
  };
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const name = /^\s*Name:\s*(.+?)\s*$/.exec(line)?.[1];
    if (name) { flush(); current = { name, path: '', target: '', broken: false }; continue; }
    if (!current) continue;
    const found = /^\s*Path:\s*(.+?)\s*$/.exec(line)?.[1];
    if (found) { current.path = found; continue; }
    const target = /^\s*Target:\s*(.+?)\s*$/.exec(line)?.[1];
    if (target) { current.target = target; continue; }
    if (/^\s*Error:/.test(line)) current.broken = true;
  }
  flush();
  return rows;
}

/**
 * Adopt devices that already exist in a folder the user points at. Devices
 * created before the pointer was written (or by another tool, on another
 * drive) are invisible to the emulator and to this list; scanning the folder
 * once writes the missing pointers and remembers the folder for next time.
 */
export function importAvdFolder(dir: string): { added: number; names: string[] } {
  const clean = String(dir ?? '').trim();
  if (!ABSOLUTE(clean)) throw new Error('Choose an existing folder that holds Android virtual devices');
  const isDeviceFolder = clean.toLowerCase().endsWith('.avd');
  let candidates: string[] = [];
  if (isDeviceFolder) candidates = [clean];
  else {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(clean, { withFileTypes: true }); } catch { throw new Error(`The folder ${clean} could not be read`); }
    candidates = entries.filter((entry) => entry.isDirectory() && entry.name.toLowerCase().endsWith('.avd')).map((entry) => path.join(clean, entry.name));
  }
  const names: string[] = [];
  for (const avdPath of candidates) {
    if (!fs.existsSync(path.join(avdPath, 'config.ini'))) continue;
    const name = path.basename(avdPath).slice(0, -4);
    if (!NAME.test(name)) continue;
    const api = Number.parseInt(configValue(avdPath, 'image.androidVersion.api'), 10) || 0;
    if (writeAvdPointer(name, avdPath, api)) names.push(name);
  }
  if (names.length) rememberAvdDirectory(isDeviceFolder ? path.dirname(clean) : clean);
  return { added: names.length, names };
}

/** Devices found on disk, without asking any Android tool. */
export function scanAvdFolders(): AvdLocation[] {
  const found = new Map<string, AvdLocation>();
  const add = (name: string, dir: string) => {
    if (!name || found.has(name) || !NAME.test(name)) return;
    if (!fs.existsSync(path.join(dir, 'config.ini'))) return;
    found.set(name, { name, path: dir, target: describeAvd(dir) });
  };
  for (const dir of avdSearchDirectories()) {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.toLowerCase().endsWith('.avd')) add(entry.name.slice(0, -4), path.join(dir, entry.name));
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.ini')) {
        const target = avdPointerTarget(path.join(dir, entry.name));
        if (target) add(entry.name.slice(0, -4), target);
      }
    }
  }
  return [...found.values()];
}

// ---------------------------------------------------------------- media companion (vStudio)

const COMPANION_ENTRY = 'app.py';
const MOBILE: MediaPluginId = 'vstudio-mobile';

/**
 * On/off state of each plugin, mirrored here from Settings by the manager.
 * Nothing in this module prepares, configures or starts a plugin that is off.
 */
const pluginEnabled = new Map<MediaPluginId, boolean>([['vstudio-mobile', false], ['vstudio-web', false]]);

export function setMediaPluginEnabled(plugin: MediaPluginId, enabled: boolean): void {
  pluginEnabled.set(plugin, enabled);
  if (!enabled) stopMediaCompanion(plugin);
}

export function mediaPluginActive(plugin: MediaPluginId): boolean {
  return pluginEnabled.get(plugin) === true;
}

function assertPluginEnabled(plugin: MediaPluginId): void {
  if (!mediaPluginActive(plugin)) throw new Error(`${MEDIA_PLUGINS[plugin].name} is switched off in Settings`);
}

/**
 * Where a plugin lives: inside the SDK when we have one, else in $HOME. The two
 * plugins use different folders so neither can overwrite the other's config.
 */
export function mediaCompanionRoot(plugin: MediaPluginId = MOBILE): string {
  const dir = MEDIA_PLUGINS[plugin].folder;
  // Never inside a read-only SDK: staging the plugin under
  // "C:\\Program Files (x86)\\Android\\android-sdk" fails with EPERM. An
  // existing installation there is still honoured so nothing is re-downloaded.
  for (const root of [androidInstallRoot(), ...roots()].filter(Boolean)) {
    const candidate = path.join(root, dir);
    if (fs.existsSync(path.join(candidate, MANIFEST))) return candidate;
  }
  const writable = [androidInstallRoot(), ...roots()].filter(Boolean).find((root) => folderWritable(root));
  return writable ? path.join(writable, dir) : path.join(os.homedir(), '.octobrowser', dir);
}

function which(command: string): string {
  const exts = ['.exe', '.bat', '.cmd'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const full = path.join(dir, command + ext);
      try { if (fs.existsSync(full)) return full; } catch { /* unreadable PATH entry */ }
    }
  }
  return '';
}

function pythonPath(): string {
  const found: string[] = [];
  for (const candidate of ['python', 'python3', 'py']) {
    const hit = which(candidate);
    if (hit) found.push(hit);
  }
  // A .bat/.cmd shim cannot be spawned directly on Windows, so prefer a real binary.
  return found.find((item) => !isBatch(item)) ?? found[0] ?? '';
}

/**
 * A virtual camera the companion can broadcast through. vStudio Mobile uses
 * Unity Capture, so that is checked first; an OBS installation still counts,
 * because pyvirtualcam can use either.
 */
function virtualCameraDriver(): boolean {
  if (process.platform !== 'win32') return false;
  if (unityCaptureRegistered()) return true;
  return [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]
    .filter((base): base is string => !!base)
    .some((base) => fs.existsSync(path.join(base, 'obs-studio')));
}

/**
 * The emulator has no command-line option for a microphone: it records from
 * whatever Windows calls the default input. vStudio Mobile plays into
 * VB-CABLE, so that has to be the default input - this reports what the
 * default actually is, so the UI can say "Android is still recording from the
 * laptop" instead of leaving the user guessing.
 */
export function defaultAudioInput(): string {
  if (process.platform !== 'win32') return '';
  try {
    const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_SoundDevice | Where-Object { $_.Status -eq "OK" } | Select-Object -ExpandProperty Name'],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    const lines = String(query.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return lines.find((line) => /cable|vstudio|virtual/i.test(line)) ?? lines[0] ?? '';
  } catch { return ''; }
}

/** VB-CABLE (Windows) is the virtual microphone the companion feeds. */
function virtualMicrophoneDriver(): boolean {
  return process.platform === 'win32' && vbCableInstalled();
}

const companionChildren = new Map<MediaPluginId, ReturnType<typeof spawn>>();

function runningChild(plugin: MediaPluginId): ReturnType<typeof spawn> | null {
  const child = companionChildren.get(plugin);
  if (!child || child.exitCode !== null) { companionChildren.delete(plugin); return null; }
  return child;
}

export function mediaCompanionStatus(plugin: MediaPluginId = MOBILE, detected?: { camera: boolean; microphone: boolean }): MediaCompanionStatus {
  const bundle = studioBundle();
  const root = mediaCompanionRoot(plugin);
  const staged = stagedPayload(root);
  const cameraDriver = detected?.camera ?? virtualCameraDriver();
  const microphoneDriver = detected?.microphone ?? virtualMicrophoneDriver();
  const installed = staged.installed;
  let files = 0;
  if (installed) { try { files = fs.readdirSync(root).length; } catch { files = 0; } }
  // Each plugin is checked against its own environment: vStudio Mobile needs a
  // usable Android emulator, vStudio Web needs nothing from Android at all.
  // Each requirement says what it is and whether the app can install it, so
  // the Plugins panel can offer a button instead of "run install.bat".
  const requirement = (id: RequirementId, key: string, ok: boolean) => ({
    id, key, ok,
    required: REQUIREMENT_FIXES[id].required,
    fixable: REQUIREMENT_FIXES[id].fixable && process.platform === 'win32',
    vendor: REQUIREMENT_FIXES[id].vendor,
  });
  const requirements = [
    requirement('python', 'android.media.python', !!pythonPath()),
    requirement('camera', 'android.media.camera', cameraDriver),
    requirement('microphone', 'android.media.microphone', microphoneDriver),
    requirement('folder', 'plugins.req.folder', folderWritable(path.dirname(root))),
  ];
  if (plugin === MOBILE) {
    const sdkRoot = roots()[0] ?? '';
    requirements.push(requirement('emulator', 'plugins.req.emulator', !!sdkRoot && !!locate(sdkRoot, 'emulator')));
  }
  return {
    plugin,
    pluginName: MEDIA_PLUGINS[plugin].name,
    enabled: mediaPluginActive(plugin),
    bundleAvailable: bundle.available,
    bundleBytes: bundle.bytes,
    installed,
    updateAvailable: staged.installed && staged.outdated,
    path: installed ? root : '',
    files,
    pythonAvailable: !!pythonPath(),
    virtualCameraDriver: cameraDriver,
    virtualMicrophoneDriver: microphoneDriver,
    running: !!runningChild(plugin),
    requirements,
    // Startable as soon as the essentials are there. A missing camera or
    // microphone driver is a warning, not a locked button: the companion
    // starts and reports what it cannot open.
    ready: mediaPluginActive(plugin) && bundle.available && requirements.every((item) => item.ok || !item.required),
    complete: mediaPluginActive(plugin) && bundle.available && requirements.every((item) => item.ok),
  };
}

/** Hardware probing for UI pages must never use spawnSync on Electron's main thread. */
export async function mediaCompanionStatusAsync(plugin: MediaPluginId = MOBILE): Promise<MediaCompanionStatus> {
  const [camera, microphone] = await Promise.all([
    process.platform === 'win32'
      ? unityCaptureRegisteredAsync().then((unity) => unity || [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]
        .filter((base): base is string => !!base).some((base) => fs.existsSync(path.join(base, 'obs-studio'))))
      : Promise.resolve(virtualCameraDriver()),
    process.platform === 'win32' ? vbCableInstalledAsync() : Promise.resolve(virtualMicrophoneDriver()),
  ]);
  return mediaCompanionStatus(plugin, { camera, microphone });
}

/**
 * Stage the companion locally. Called automatically whenever a device asks for
 * the virtual camera/microphone, so there is no "open studio.zip" button to
 * press: if it is already there, this is a no-op.
 */
export function ensureMediaCompanion(plugin: MediaPluginId = MOBILE, force = false): MediaCompanionResult {
  assertPluginEnabled(plugin);
  const root = mediaCompanionRoot(plugin);
  const staged = stagedPayload(root);
  if (staged.installed && !force && !staged.outdated) {
    return { installed: true, message: `${MEDIA_PLUGINS[plugin].name} is ready.`, path: root, files: 0, bytes: 0 };
  }
  stopMediaCompanion(plugin);
  // Keep the user's own settings across the refresh: config.json is theirs,
  // everything else is ours to replace.
  let config = '';
  try { config = fs.readFileSync(path.join(root, 'config.json'), 'utf8'); } catch { config = ''; }
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  const result = extractMediaCompanion(root, plugin);
  if (config) {
    try { fs.writeFileSync(path.join(result.path, 'config.json'), config, { mode: 0o600 }); } catch { /* it will be rewritten */ }
  }
  return { ...result, message: staged.installed ? `${MEDIA_PLUGINS[plugin].name} updated.` : result.message };
}

/** What is staged right now, and whether studio.zip has something newer. */
function stagedPayload(root: string): { installed: boolean; outdated: boolean; version: number } {
  const file = path.join(root, MANIFEST);
  if (!fs.existsSync(file) || !fs.existsSync(path.join(root, COMPANION_ENTRY))) return { installed: false, outdated: true, version: 0 };
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as { payloadVersion?: unknown };
    const version = Number(manifest.payloadVersion ?? 0);
    return { installed: true, outdated: version < PAYLOAD_VERSION, version };
  } catch { return { installed: true, outdated: true, version: 0 }; }
}

/** Copy the curated vStudio files from studio.zip into `destination` atomically. */
function extractMediaCompanion(target: string, plugin: MediaPluginId = MOBILE): MediaCompanionResult {
  const bundle = studioBundle();
  if (!bundle.available) throw new Error('studio.zip not found');
  const archive = fs.readFileSync(bundle.path);
  // If the chosen parent turns out to be protected after all, fall back to the
  // user's own folder instead of failing with EPERM.
  const destination = folderWritable(path.dirname(target)) ? target : path.join(os.homedir(), '.octobrowser', MEDIA_PLUGINS[plugin].folder);
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.octo-studio-'));
  const stagedAddon = path.join(staging, MEDIA_PLUGINS[plugin].folder);
  let files = 0;
  let bytes = 0;
  try {
    for (const entry of zipEntries(archive)) {
      const relative = studioAddonArchiveEntry(entry.name);
      if (!relative) continue;
      if (files >= 500 || bytes + entry.uncompressedSize > STUDIO_MAX_BYTES) throw new Error('Studio media companion is too large');
      const output = extractZipEntry(archive, entry);
      const file = path.resolve(stagedAddon, relative);
      if (file !== stagedAddon && !file.startsWith(`${stagedAddon}${path.sep}`)) throw new Error('Invalid studio.zip path');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, output, { mode: 0o600 });
      files++;
      bytes += output.length;
    }
    if (!files) throw new Error('studio.zip does not contain the vStudio companion');
    const manifest = {
      schema: 2,
      payloadVersion: PAYLOAD_VERSION,
      source: 'studio.zip',
      payload: MEDIA_PLUGINS[plugin].name,
      plugin,
      role: plugin === MOBILE ? 'android-virtual-camera-and-microphone' : 'browser-profile-virtual-camera-and-microphone',
      installedAt: new Date().toISOString(),
      execution: 'user-initiated',
      excluded: ['__pycache__', 'tests', 'output', 'media', 'scripts', '*.bat', 'config.json', 'INSTALACJA_LOG.txt'],
      androidEmulator: { camera: 'webcam0', microphone: 'hw.audioInput=yes' },
    };
    fs.writeFileSync(path.join(stagedAddon, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(stagedAddon, destination);
    return { installed: true, message: `Installed ${files} ${MEDIA_PLUGINS[plugin].name} files locally.`, path: destination, files, bytes };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Write the companion's own config.json so its virtual camera/microphone are
 * named after the Android device they serve and use that handset's screen
 * format. The companion reads this file at start-up.
 */
export function configureMediaCompanion(input: {
  deviceName: string; profile?: AndroidDeviceProfile;
  /** Name the Android emulator (and the apps inside it) will see for the camera. */
  cameraName?: string;
  microphoneName?: string;
  /** Physical/virtual host camera vStudio republishes to the emulator. */
  cameraDevice?: string;
  /** Rotation/mirroring applied to that raw input before phone framing. */
  inputRotation?: CameraRotation;
  inputMirror?: boolean;
  /** Physical host microphone to pass through to Android via VB-CABLE. */
  microphoneDevice?: string;
  /** Screen format of the handset, when it does not come from a device profile. */
  width?: number; height?: number;
  /** Folder of photos and videos the virtual camera should play. */
  mediaFolder?: string;
  /** Explicit user request to start/stop publishing; omitted means preserve it. */
  autoBroadcast?: boolean;
}): string {
  assertPluginEnabled(MOBILE);
  const root = mediaCompanionRoot(MOBILE);
  if (!fs.existsSync(path.join(root, MANIFEST))) throw new Error(`${MEDIA_PLUGINS[MOBILE].name} is not installed`);
  const label = (input.profile ? `${input.profile.brand} ${input.profile.model}` : input.deviceName).slice(0, 48);
  const clean = (value: string | undefined, fallback: string, max = 48) => {
    const text = String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
    return text || fallback;
  };
  const cameraName = clean(input.cameraName, label);
  const microphoneName = clean(input.microphoneName, label);
  const file = path.join(root, 'config.json');
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { current = {}; }
  const video = { ...(current.video as Record<string, unknown> | undefined ?? {}) };
  const currentMobile = { ...(current.mobile as Record<string, unknown> | undefined ?? {}) };
  const currentOctobrowser = { ...(current.octobrowser as Record<string, unknown> | undefined ?? {}) };
  const broadcastRequest = typeof input.autoBroadcast === 'boolean'
    ? mediaBroadcastCommand(input.autoBroadcast)
    : String(currentOctobrowser.broadcastRequest ?? '');
  const width = input.profile?.width ?? input.width;
  const height = input.profile?.height ?? input.height;
  if (width && height) {
    video.width = width;
    video.height = height;
    video.orientation = height >= width ? 'portrait' : 'landscape';
  }
  // vStudio Mobile reads `device_names`, `video` and - since it was reworked
  // for the emulators - a `mobile` section; everything else it ignores. So the
  // settings that matter are written where the app really looks for them, and
  // the camera/microphone carry the handset's name, which is what the emulator
  // is matched against when it picks a host camera.
  const next = {
    ...current,
    mode: 'android',
    android_only: true,
    targets: ['android-emulator'],
    outputs: { android: true, desktop: false, browser: false, obs_scene: false },
    device_names: { camera: cameraName, microphone: microphoneName },
    camera_name: cameraName,
    microphone_name: microphoneName,
    mobile: {
      ...currentMobile,
      enabled: true,
      device: input.deviceName,
      handset: label,
      camera: cameraName,
      microphone: microphoneName,
      width: width ?? Number(currentMobile.width ?? 0),
      height: height ?? Number(currentMobile.height ?? 0),
      target: 'android-emulator',
      // Omitted means preserve the existing device library; an explicit empty
      // string clears it. This matters when only the broadcast command changes.
      media_folder: input.mediaFolder === undefined
        ? String(currentMobile.media_folder ?? '')
        : input.mediaFolder && path.isAbsolute(input.mediaFolder) ? input.mediaFolder : '',
    },
    video: {
      ...video,
      orientation: (video.orientation as string | undefined) ?? 'portrait',
      input_camera_name: clean(input.cameraDevice, String(video.input_camera_name ?? ''), 160),
      input_rotation: input.inputRotation === undefined
        ? normalizeCameraRotation(video.input_rotation)
        : normalizeCameraRotation(input.inputRotation),
      input_mirror: input.inputMirror === undefined ? Boolean(video.input_mirror) : input.inputMirror === true,
    },
    audio: {
      ...(current.audio as Record<string, unknown> | undefined ?? {}), cable_only: true,
      input_device_name: input.microphoneDevice === undefined
        ? String((current.audio as Record<string, unknown> | undefined)?.input_device_name ?? '')
        : clean(input.microphoneDevice, '', 160),
      passthrough_input: input.microphoneDevice === undefined
        ? Boolean((current.audio as Record<string, unknown> | undefined)?.passthrough_input)
        : Boolean(input.microphoneDevice),
    },
    octobrowser: {
      ...currentOctobrowser,
      avd: input.deviceName,
      handset: label,
      broadcastRequest,
      updatedAt: new Date().toISOString(),
    },
  };
  writeMediaCompanionConfig(file, next);
  return file;
}

/** Keep the companion from observing a half-written command/configuration. */
function writeMediaCompanionConfig(file: string, value: Record<string, unknown>): void {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* rename already consumed it */ }
  }
}

async function writeMediaCompanionConfigAsync(file: string, value: Record<string, unknown>): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await fs.promises.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.promises.rename(temporary, file);
  } finally {
    try { await fs.promises.rm(temporary, { force: true }); } catch { /* rename already consumed it */ }
  }
}

export function mediaBroadcastCommand(start: boolean, timestamp = Date.now(), nonce: string = crypto.randomUUID()): string {
  return `${start ? 'start' : 'stop'}:${timestamp}:${nonce}`;
}

export interface MediaCompanionRuntime {
  pid?: number;
  broadcastRequest?: string;
  broadcasting?: boolean;
  cameraActive?: boolean;
  cameraDevice?: string;
  cameraError?: string;
  inputCameraRequested?: boolean;
  inputCameraActive?: boolean;
  inputCameraName?: string;
  inputCameraError?: string;
  updatedAt?: number;
}

export function mediaCompanionCameraReadiness(
  runtime: MediaCompanionRuntime | undefined,
  request: string,
): { state: 'waiting' | 'ready' | 'error'; message: string } {
  if (!request || runtime?.broadcastRequest !== request) return { state: 'waiting', message: '' };
  if (runtime?.cameraError) return { state: 'error', message: runtime.cameraError };
  // A virtual output showing a placeholder is not readiness when the user
  // explicitly selected a live camera. Wait for that exact source to return a
  // frame, or surface its concrete failure before Android starts.
  if (runtime?.inputCameraRequested === true) {
    if (runtime.inputCameraError) return { state: 'error', message: runtime.inputCameraError };
    if (runtime.inputCameraActive !== true) return { state: 'waiting', message: '' };
  }
  if (runtime?.cameraActive === true && runtime.broadcasting === true) {
    return { state: 'ready', message: runtime.cameraDevice ?? '' };
  }
  return { state: 'waiting', message: '' };
}

const mediaRuntimeFile = (plugin: MediaPluginId = MOBILE) => path.join(mediaCompanionRoot(plugin), '.octo-runtime.json');

function mediaBroadcastRequest(plugin: MediaPluginId = MOBILE): string {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(mediaCompanionRoot(plugin), 'config.json'), 'utf8')) as {
      octobrowser?: { broadcastRequest?: unknown };
    };
    return typeof config.octobrowser?.broadcastRequest === 'string' ? config.octobrowser.broadcastRequest : '';
  } catch { return ''; }
}

/** Send a one-shot publish command to an already open companion. */
export function requestMediaCompanionBroadcast(plugin: MediaPluginId, start: boolean): string {
  assertPluginEnabled(plugin);
  const root = mediaCompanionRoot(plugin);
  const file = path.join(root, 'config.json');
  if (!fs.existsSync(path.join(root, MANIFEST))) throw new Error(`${MEDIA_PLUGINS[plugin].name} is not installed`);
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { current = {}; }
  const request = mediaBroadcastCommand(start);
  const octobrowser = { ...(current.octobrowser as Record<string, unknown> | undefined ?? {}), broadcastRequest: request, updatedAt: new Date().toISOString() };
  writeMediaCompanionConfig(file, { ...current, octobrowser });
  return request;
}

function readMediaCompanionRuntime(plugin: MediaPluginId = MOBILE): MediaCompanionRuntime | undefined {
  try { return JSON.parse(fs.readFileSync(mediaRuntimeFile(plugin), 'utf8')) as MediaCompanionRuntime; }
  catch { return undefined; }
}

/**
 * Do not boot Android against a virtual filter that has no producer. The
 * companion acknowledges the exact one-shot request only after pyvirtualcam
 * has opened Unity Capture; stale status from a previous process cannot pass.
 */
export async function waitForMediaCompanionCamera(plugin: MediaPluginId, request: string, timeoutMs = 45_000): Promise<MediaCompanionRuntime> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const runtime = readMediaCompanionRuntime(plugin);
    const readiness = mediaCompanionCameraReadiness(runtime, request);
    if (readiness.state === 'ready') return runtime!;
    if (readiness.state === 'error') throw new Error(readiness.message);
    // Give Python/Tk a short startup window, then fail immediately if it died.
    if (Date.now() - started > 1_500 && !runningChild(plugin)) {
      throw new Error(`${MEDIA_PLUGINS[plugin].name} stopped before its virtual camera became ready`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${MEDIA_PLUGINS[plugin].name} did not open Unity Capture within ${Math.ceil(timeoutMs / 1000)} seconds`);
}

/** Restart after a per-device config change so no stale name/frame/source survives. */
export async function restartMediaCompanion(plugin: MediaPluginId = MOBILE): Promise<{ started: boolean; message: string }> {
  const child = runningChild(plugin);
  if (child) {
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    if (child.exitCode === null) throw new Error(`${MEDIA_PLUGINS[plugin].name} could not release the virtual camera`);
    companionChildren.delete(plugin);
  } else if (terminateOrphanedMediaCompanion(plugin)) {
    // DirectShow may retain the dead producer's handles for a short time.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }
  return startMediaCompanion(plugin);
}

/**
 * Is this device's camera and microphone really wired up?
 *
 * Only the two facts that decide whether Android can capture anything are
 * checked: the camera endpoint the device is wired to is one the emulator
 * enumerates, and the microphone is switched on. There is no companion link in
 * this chain any more - a device takes its picture straight from a live host
 * camera. Nothing is repaired here; this only reports.
 */
export interface MediaCheckItem { key: string; ok: boolean; detail: string }
export interface MediaCheck {
  device: string;
  ready: boolean;
  items: MediaCheckItem[];
  webcams: EmulatorWebcam[];
  /** The camera the device is wired to right now ('' when it uses its own). */
  selected: string;
  /** Every camera the emulator can hand to Android right now. */
  live: EmulatorWebcam[];
  /** What each lens is set to, so the panel can open on the saved state. */
  cameraFront: CameraSource;
  cameraBack: CameraSource;
  cameraFrontDevice: string;
  cameraBackDevice: string;
  microphoneEnabled: boolean;
}

export async function androidMediaCheck(name: string): Promise<MediaCheck> {
  const clean = assertName(name);
  const avd = (await listAndroidAvds()).find((item) => item.name === clean);
  if (!avd) throw new Error('Android virtual device not found');
  const webcams = await emulatorWebcams();
  const selected = avd.cameraDevice || '';
  const defaultInput = defaultAudioInput();
  // What the two lenses are set to, read the way the emulator reads it.
  const sources = normalizeCameraSources(avd.cameraFront, avd.cameraBack);
  const values = emulatorCameraValues(sources.front, sources.back, avd.cameraFrontDevice, avd.cameraBackDevice);
  const liveIds = new Set(webcams.map((item) => item.name));
  const advertised = `${configValue(avd.path, 'hw.camera.maxHorizontalPixels')}x${configValue(avd.path, 'hw.camera.maxVerticalPixels')}`;
  const wired = [values.front, values.back].filter((value) => value !== 'none');
  const items: MediaCheckItem[] = [
    {
      key: 'android.media.check.webcam',
      ok: webcams.length > 0,
      detail: webcams.map((item) => `${item.name} · ${item.device}`).join('\n'),
    },
    // Every lens that has a camera must name an endpoint the emulator really offers.
    { key: 'android.media.check.wired', ok: wired.every((value) => liveIds.has(value)), detail: wired.join(' · ') },
    { key: 'android.media.check.mic', ok: !!defaultInput || process.platform !== 'win32', detail: defaultInput },
    { key: 'android.media.check.audio', ok: avd.microphoneEnabled, detail: '' },
    // One host endpoint opened for both lenses is the crash the emulator cannot
    // recover from; the resolved pair is what will really be launched.
    {
      key: 'android.media.check.slots',
      ok: !(values.front !== 'none' && values.front === values.back),
      detail: `front=${values.front} back=${values.back}`,
    },
    // What the guest HAL advertises has to be something a lens can deliver.
    {
      key: 'android.media.check.resolution',
      ok: !/^(0x0|x|)$/.test(advertised),
      detail: advertised === 'x' ? '' : advertised,
    },
  ];
  return {
    device: clean,
    ready: items.every((item) => item.ok),
    items,
    webcams,
    selected,
    live: webcams,
    cameraFront: sources.front,
    cameraBack: sources.back,
    cameraFrontDevice: avd.cameraFrontDevice ?? '',
    cameraBackDevice: avd.cameraBackDevice ?? '',
    microphoneEnabled: avd.microphoneEnabled,
  };
}

/**
 * Repair the camera and microphone in one go: wire the device to a camera the
 * emulator really offers, make sure only one facing uses it, and switch the
 * microphone on. Returns what was changed.
 */
export async function repairAndroidMedia(name: string, input: { cameraDevice?: string; start?: boolean } = {}): Promise<{ changed: string[]; check: MediaCheck }> {
  const clean = assertName(name);
  const avd = (await listAndroidAvds()).find((item) => item.name === clean);
  if (!avd) throw new Error('Android virtual device not found');
  if (avd.running) throw new Error('Stop the Android device before repairing its camera and microphone');
  const changed: string[] = [];
  const webcams = await emulatorWebcams();
  // A camera the caller picked goes to the rear lens. Otherwise the saved
  // choices stand, and a lens without a camera takes an active one.
  const wanted = input.cameraDevice && webcams.some((item) => item.name === input.cameraDevice) ? input.cameraDevice : '';
  const selected = normalizeCameraSources(avd.cameraFront, avd.cameraBack);
  const assignments = resolveActiveCameraAssignments(
    selected.front, selected.back,
    avd.cameraFrontDevice, wanted || avd.cameraBackDevice,
    webcams, [],
    avd.cameraDevice,
  );
  writeConfigValues(avd.path, mediaConfig(assignments.front, assignments.back, true,
    assignments.frontDevice, assignments.backDevice, cameraLimitsFor(avd.path)));
  rememberAndroidLaunch(clean, {
    cameraFront: assignments.front, cameraBack: assignments.back,
    cameraFrontDevice: assignments.frontDevice, cameraBackDevice: assignments.backDevice,
    cameraDevice: assignments.backDevice || assignments.frontDevice,
    microphoneEnabled: true,
  });
  changed.push('camera', 'microphone');
  return { changed, check: await androidMediaCheck(clean) };
}

/**
 * The runtime permissions the device's own Camera app needs before it can open
 * an emulator camera or record sound. Android asks for them on first use; when
 * that prompt was dismissed or never answered, the Camera app shows "Permission
 * denied" and no picture. Only what the switched-on lenses and microphone need.
 */
export function mediaPermissionsFor(input: { cameraFront: CameraSource; cameraBack: CameraSource; microphoneEnabled: boolean }): string[] {
  const permissions: string[] = [];
  if (input.cameraFront === 'webcam' || input.cameraBack === 'webcam') permissions.push('android.permission.CAMERA');
  if (input.microphoneEnabled) permissions.push('android.permission.RECORD_AUDIO');
  return permissions;
}

/** Camera apps to try, in order, when the still-camera intent does not resolve. */
const CAMERA_APP_PACKAGES = ['com.google.android.GoogleCamera', 'com.android.camera2', 'com.android.camera'];

/**
 * The package that answers the still-camera intent, read from
 * `cmd package resolve-activity --brief`: a metadata line, then `package/Activity`.
 * "No activity found" gives ''. The system chooser (`android/...`) is refused:
 * it is not a camera app and must never receive a camera permission.
 */
export function cameraAppFromResolveOutput(output: string): string {
  const component = /^([A-Za-z][\w.]*)\/\S+\s*$/m.exec(output)?.[1] ?? '';
  return component === 'android' ? '' : component;
}

/** What `pm grant` said when it refused, or '' when it granted. pm can print an exception and still exit 0. */
export function grantRefusalIn(output: string): string {
  return /exception|error|unknown|not requested/i.test(output) ? output.trim().slice(0, 200) : '';
}

/** Does `dumpsys package` list this permission as granted? */
export function permissionGrantedIn(dump: string, permission: string): boolean {
  const name = permission.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${name}: granted=true\\b`, 'm').test(dump);
}

export interface MediaPermissionResult {
  /** The package granted, or '' when no camera app could be found. */
  app: string;
  permissions: { permission: string; granted: boolean; reason: string }[];
  ok: boolean;
}

async function cameraAppPackage(adb: string, serial: string): Promise<string> {
  const resolved = await adbRun(adb, ['-s', serial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief',
    '-a', 'android.media.action.STILL_IMAGE_CAMERA'], 30_000).catch(() => '');
  const fromIntent = cameraAppFromResolveOutput(resolved);
  if (fromIntent) return fromIntent;
  for (const pkg of CAMERA_APP_PACKAGES) {
    const installed = await adbRun(adb, ['-s', serial, 'shell', 'pm', 'path', pkg], 15_000).catch(() => '');
    if (/^package:/m.test(installed)) return pkg;
  }
  return '';
}

/**
 * Let the device's Camera app use the camera, and the microphone when it is
 * switched on, then read the grants back from the device. Nothing else is
 * granted and no secure setting is changed. Runs after boot on every launch.
 */
export async function grantAndroidMediaPermissions(name: string, serial: string): Promise<MediaPermissionResult> {
  const clean = assertName(name);
  const avd = (await listAndroidAvds()).find((item) => item.name === clean);
  if (!avd) throw new Error('Android virtual device not found');
  const needed = mediaPermissionsFor(avd);
  if (!needed.length) return { app: '', permissions: [], ok: true };
  const adb = adbPath();
  const app = await cameraAppPackage(adb, serial);
  if (!app) {
    logToolRun(adb, ['-s', serial, 'shell', 'cmd', 'package', 'resolve-activity'], 'No camera app answers the still-camera intent or is installed.');
    return {
      app: '', ok: false,
      permissions: needed.map((permission) => ({ permission, granted: false, reason: 'no camera app is installed on this device' })),
    };
  }
  const refused: Record<string, string> = {};
  for (const permission of needed) {
    const refusal = await adbRun(adb, ['-s', serial, 'shell', 'pm', 'grant', app, permission], 30_000)
      .then(grantRefusalIn, (error: unknown) => grantRefusalIn(error instanceof Error ? error.message : String(error)));
    if (refusal) refused[permission] = refusal;
  }
  // The grants are believed only when the device itself reports them.
  const dump = await adbRun(adb, ['-s', serial, 'shell', 'dumpsys', 'package', app], 60_000).catch(() => '');
  const permissions = needed.map((permission) => {
    const granted = permissionGrantedIn(dump, permission);
    const reason = granted ? ''
      : refused[permission] || (dump ? 'Android did not report it as granted' : 'could not read the permission back from the device');
    return { permission, granted, reason };
  });
  logToolRun(adb, ['-s', serial, 'shell', 'pm', 'grant', app],
    permissions.map((item) => `${item.permission} ${item.granted ? 'granted' : `refused: ${item.reason}`}`).join('\n'));
  return { app, permissions, ok: permissions.every((item) => item.granted) };
}

/** Verify a runtime PID still belongs to this exact staged companion. */
function ownsCompanionProcess(plugin: MediaPluginId, pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const root = mediaCompanionRoot(plugin).replace(/\\/g, '/').toLowerCase();
  let command = '';
  try {
    if (process.platform === 'win32') {
      const found = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine`],
      { encoding: 'utf8', windowsHide: true, timeout: 8_000 });
      command = String(found.stdout || '');
    } else {
      try { command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); }
      catch {
        command = String(spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5_000 }).stdout || '');
      }
    }
  } catch { return false; }
  const normalized = command.replace(/\\/g, '/').toLowerCase();
  return normalized.includes(root) && normalized.includes(COMPANION_ENTRY.toLowerCase());
}

/**
 * A Python child can outlive a crashed/restarted Electron manager on Windows.
 * Its runtime file gives us the PID, but PID reuse makes blind termination
 * unsafe, so kill it only after matching this plugin's exact staged command.
 */
function terminateOrphanedMediaCompanion(plugin: MediaPluginId): boolean {
  if (runningChild(plugin)) return false;
  const pid = Number(readMediaCompanionRuntime(plugin)?.pid ?? 0);
  if (!ownsCompanionProcess(plugin, pid)) return false;
  try {
    process.kill(pid, 'SIGTERM');
    try { fs.rmSync(mediaRuntimeFile(plugin), { force: true }); } catch { /* status is advisory */ }
    return true;
  } catch { return false; }
}

/** Start the companion. Explicit: it only runs when a user asked for it. */
export function startMediaCompanion(plugin: MediaPluginId = MOBILE): { started: boolean; message: string } {
  const name = MEDIA_PLUGINS[plugin].name;
  assertPluginEnabled(plugin);
  if (runningChild(plugin)) return { started: true, message: `${name} is already running.` };
  // Never run two publishers against one Unity Capture endpoint/physical input.
  terminateOrphanedMediaCompanion(plugin);
  const root = mediaCompanionRoot(plugin);
  if (!stagedPayload(root).installed) throw new Error(`${name} is not installed`);
  const python = pythonPath();
  if (!python) throw new Error(`Python 3 is required to run ${name}`);
  // A status file belongs to one concrete process/request. Removing a stale
  // predecessor prevents a fast relaunch from being mistaken for readiness.
  try { fs.rmSync(mediaRuntimeFile(plugin), { force: true }); } catch { /* status is advisory */ }
  const child = spawn(python, [path.join(root, COMPANION_ENTRY)], { cwd: root, detached: false, stdio: 'ignore', windowsHide: false });
  child.once('error', () => { if (companionChildren.get(plugin) === child) companionChildren.delete(plugin); });
  child.once('exit', () => { if (companionChildren.get(plugin) === child) companionChildren.delete(plugin); });
  companionChildren.set(plugin, child);
  return { started: true, message: `${name} virtual camera and microphone started.` };
}

export function stopMediaCompanion(plugin: MediaPluginId = MOBILE): boolean {
  const child = runningChild(plugin);
  if (!child) return terminateOrphanedMediaCompanion(plugin);
  // Keep tracking the process until its exit event. Deleting it immediately
  // permits a second publisher to start while the first still owns the driver.
  child.kill();
  return true;
}

/**
 * vStudio Web: prepare, name and start the browser-profile plugin. The
 * companion is told to serve browsers only, so the Android emulator outputs
 * stay off and the two plugins never fight over the same device names.
 */
export function startWebMediaCompanion(input: {
  profileName: string; cameraName?: string; microphoneName?: string; width?: number; height?: number;
}): { started: boolean; message: string; path: string } {
  const plugin: MediaPluginId = 'vstudio-web';
  assertPluginEnabled(plugin);
  ensureMediaCompanion(plugin);
  const file = configureWebMediaCompanion(input);
  const started = startMediaCompanion(plugin);
  return { ...started, path: file };
}

/**
 * Non-blocking variant used by profile launch.
 *
 * The bundled studio is about 20 MB. Extracting it with the synchronous plugin
 * installer from an IPC handler stalls Electron's main thread, which makes the
 * entire launcher look frozen for several seconds after an update. Keep the
 * explicit Settings installer synchronous for compatibility, but stage the
 * automatic browser companion with promise-based filesystem operations and
 * yield between archive entries.
 */
let webMediaStartQueue: Promise<{ started: boolean; message: string; path: string }> | null = null;

export function startWebMediaCompanionAsync(input: {
  profileName: string; cameraName?: string; microphoneName?: string; width?: number; height?: number;
}): Promise<{ started: boolean; message: string; path: string }> {
  const run = async (): Promise<{ started: boolean; message: string; path: string }> => {
    const plugin: MediaPluginId = 'vstudio-web';
    assertPluginEnabled(plugin);
    const active = runningChild(plugin);
    if (active) return { started: false, message: `${MEDIA_PLUGINS[plugin].name} is already running.`, path: path.join(mediaCompanionRoot(plugin), 'config.json') };
    await ensureMediaCompanionAsync(plugin);
    const file = await configureWebMediaCompanionAsync(input);
    if (runningChild(plugin)) return { started: false, message: `${MEDIA_PLUGINS[plugin].name} is already running.`, path: file };
    const python = pythonPath();
    if (!python) throw new Error(`Python 3 is required to run ${MEDIA_PLUGINS[plugin].name}`);
    const root = mediaCompanionRoot(plugin);
    const child = spawn(python, [path.join(root, COMPANION_ENTRY)], { cwd: root, detached: false, stdio: 'ignore', windowsHide: false });
    child.once('error', () => { if (companionChildren.get(plugin) === child) companionChildren.delete(plugin); });
    child.once('exit', () => { if (companionChildren.get(plugin) === child) companionChildren.delete(plugin); });
    companionChildren.set(plugin, child);
    return { started: true, message: `${MEDIA_PLUGINS[plugin].name} virtual camera and microphone started.`, path: file };
  };
  // Profile rows can be started in quick succession. Serialising preparation
  // prevents two automatic refreshes from deleting each other's staging tree.
  const queued = (webMediaStartQueue ?? Promise.resolve({ started: true, message: '', path: '' })).then(run, run);
  webMediaStartQueue = queued;
  void queued.finally(() => { if (webMediaStartQueue === queued) webMediaStartQueue = null; }).catch(() => undefined);
  return queued;
}

export async function ensureMediaCompanionAsync(plugin: MediaPluginId = MOBILE, force = false): Promise<void> {
  assertPluginEnabled(plugin);
  const root = mediaCompanionRoot(plugin);
  const staged = stagedPayload(root);
  if (staged.installed && !staged.outdated && !force) return;
  stopMediaCompanion(plugin);
  let config = '';
  try { config = await fs.promises.readFile(path.join(root, 'config.json'), 'utf8'); } catch { config = ''; }
  await fs.promises.rm(root, { recursive: true, force: true });
  const bundle = studioBundle();
  if (!bundle.available) throw new Error('studio.zip not found');
  const archive = await fs.promises.readFile(bundle.path);
  const destination = folderWritable(path.dirname(root)) ? root : path.join(os.homedir(), '.octobrowser', MEDIA_PLUGINS[plugin].folder);
  const parent = path.dirname(destination);
  await fs.promises.mkdir(parent, { recursive: true });
  const staging = await fs.promises.mkdtemp(path.join(parent, '.octo-studio-'));
  const stagedAddon = path.join(staging, MEDIA_PLUGINS[plugin].folder);
  let files = 0;
  let bytes = 0;
  try {
    for (const entry of zipEntries(archive)) {
      const relative = studioAddonArchiveEntry(entry.name);
      if (!relative) continue;
      if (files >= 500 || bytes + entry.uncompressedSize > STUDIO_MAX_BYTES) throw new Error('Studio media companion is too large');
      const output = extractZipEntry(archive, entry);
      const file = path.resolve(stagedAddon, relative);
      if (file !== stagedAddon && !file.startsWith(`${stagedAddon}${path.sep}`)) throw new Error('Invalid studio.zip path');
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, output, { mode: 0o600 });
      files++;
      bytes += output.length;
    }
    if (!files) throw new Error('studio.zip does not contain the vStudio companion');
    const manifest = {
      schema: 2, payloadVersion: PAYLOAD_VERSION, source: 'studio.zip', payload: MEDIA_PLUGINS[plugin].name,
      plugin, role: plugin === MOBILE ? 'android-virtual-camera-and-microphone' : 'browser-profile-virtual-camera-and-microphone', installedAt: new Date().toISOString(),
      execution: 'automatic-non-blocking',
      excluded: ['__pycache__', 'tests', 'output', 'media', 'scripts', '*.bat', 'config.json', 'INSTALACJA_LOG.txt'],
      androidEmulator: { camera: 'webcam0', microphone: 'hw.audioInput=yes' },
    };
    await fs.promises.writeFile(path.join(stagedAddon, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    await fs.promises.rename(stagedAddon, destination);
    if (config) await fs.promises.writeFile(path.join(destination, 'config.json'), config, { mode: 0o600 });
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
}

async function configureWebMediaCompanionAsync(input: {
  profileName: string; cameraName?: string; microphoneName?: string; width?: number; height?: number;
}): Promise<string> {
  const plugin: MediaPluginId = 'vstudio-web';
  const root = mediaCompanionRoot(plugin);
  if (!fs.existsSync(path.join(root, MANIFEST))) throw new Error(`${MEDIA_PLUGINS[plugin].name} is not installed`);
  const clean = (value: string | undefined, fallback: string) => {
    const text = String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 48);
    return text || fallback;
  };
  const label = clean(input.profileName, 'Octo profile');
  const cameraName = clean(input.cameraName, `${label} Camera`);
  const microphoneName = clean(input.microphoneName, `${label} Microphone`);
  const file = path.join(root, 'config.json');
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(await fs.promises.readFile(file, 'utf8')) as Record<string, unknown>; } catch { current = {}; }
  const video = { ...(current.video as Record<string, unknown> | undefined ?? {}) };
  if (input.width && input.height) {
    video.width = input.width;
    video.height = input.height;
    video.orientation = input.height >= input.width ? 'portrait' : 'landscape';
  }
  const request = mediaBroadcastCommand(true);
  const next = {
    ...current, mode: 'browser', android_only: false, browser_only: true, targets: ['browser-profile'],
    outputs: { android: false, desktop: false, browser: true, obs_scene: false },
    device_names: { camera: cameraName, microphone: microphoneName }, camera_name: cameraName, microphone_name: microphoneName,
    video,
    octobrowser: {
      ...(current.octobrowser as Record<string, unknown> | undefined ?? {}),
      plugin, profile: label, broadcastRequest: request, updatedAt: new Date().toISOString(),
    },
  };
  await writeMediaCompanionConfigAsync(file, next);
  return file;
}

/** Write vStudio Web's config.json: browser output only, named after the profile. */
export function configureWebMediaCompanion(input: {
  profileName: string; cameraName?: string; microphoneName?: string; width?: number; height?: number;
}): string {
  const plugin: MediaPluginId = 'vstudio-web';
  assertPluginEnabled(plugin);
  const root = mediaCompanionRoot(plugin);
  if (!fs.existsSync(path.join(root, MANIFEST))) throw new Error(`${MEDIA_PLUGINS[plugin].name} is not installed`);
  const clean = (value: string | undefined, fallback: string) => {
    const text = String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 48);
    return text || fallback;
  };
  const label = clean(input.profileName, 'Octo profile');
  const cameraName = clean(input.cameraName, `${label} Camera`);
  const microphoneName = clean(input.microphoneName, `${label} Microphone`);
  const file = path.join(root, 'config.json');
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>; } catch { current = {}; }
  const video = { ...(current.video as Record<string, unknown> | undefined ?? {}) };
  if (input.width && input.height) {
    video.width = input.width;
    video.height = input.height;
    video.orientation = input.height >= input.width ? 'portrait' : 'landscape';
  }
  const request = mediaBroadcastCommand(true);
  const next = {
    ...current,
    mode: 'browser',
    android_only: false,
    browser_only: true,
    targets: ['browser-profile'],
    outputs: { android: false, desktop: false, browser: true, obs_scene: false },
    device_names: { camera: cameraName, microphone: microphoneName },
    camera_name: cameraName,
    microphone_name: microphoneName,
    video,
    octobrowser: {
      ...(current.octobrowser as Record<string, unknown> | undefined ?? {}),
      plugin, profile: label, broadcastRequest: request, updatedAt: new Date().toISOString(),
    },
  };
  writeMediaCompanionConfig(file, next);
  return file;
}

// ---------------------------------------------------------------- SDK surface

/** Detect only local tools. No SDK package is downloaded here. */
export function androidStudioStatus(): AndroidStudioStatus {
  const root = roots()[0] ?? '';
  return {
    available: !!root,
    sdkRoot: root,
    studioAppPath: studioApp(),
    javaHome: javaHome(),
    javaVersion: javaVersionFound(),
    avdManagerAvailable: !!root && !!locate(root, 'avdmanager'),
    emulatorAvailable: !!root && !!locate(root, 'emulator'),
    adbAvailable: !!root && !!locate(root, 'adb'),
    defaultDirectory: defaultAvdDirectory(),
    mediaCompanion: mediaCompanionStatus(),
    installedImages: ANDROID_SYSTEM_IMAGES.filter((item) => androidSystemImageInstalled(item.id)).map((item) => item.id),
    searched: androidSdkCandidates(),
    missing: !root ? 'sdk' : !locate(root, 'avdmanager') ? 'cmdline-tools' : !locate(root, 'emulator') ? 'emulator' : '',
    manualSdkRoot: !!overrideRoot(),
    installTarget: androidInstallTarget(),
  };
}

/**
 * Renderer-facing status without synchronous Java/registry processes. This is
 * used for normal page rendering; full Java verification still happens when a
 * real SDK command is launched.
 */
export async function androidStudioStatusAsync(): Promise<AndroidStudioStatus> {
  const root = roots()[0] ?? '';
  const javaHomes = javaCandidates().filter((candidate) => fs.existsSync(path.join(candidate, 'bin', binary('java'))));
  const selectedJava = javaHomes.sort((a, b) => javaMajor(b) - javaMajor(a))[0] ?? '';
  return {
    available: !!root,
    sdkRoot: root,
    studioAppPath: studioApp(),
    javaHome: selectedJava,
    javaVersion: selectedJava ? javaMajor(selectedJava) : 0,
    avdManagerAvailable: !!root && !!locate(root, 'avdmanager'),
    emulatorAvailable: !!root && !!locate(root, 'emulator'),
    adbAvailable: !!root && !!locate(root, 'adb'),
    defaultDirectory: defaultAvdDirectory(),
    mediaCompanion: await mediaCompanionStatusAsync(),
    installedImages: ANDROID_SYSTEM_IMAGES.filter((item) => androidSystemImageInstalled(item.id)).map((item) => item.id),
    searched: androidSdkCandidates(),
    missing: !root ? 'sdk' : !locate(root, 'avdmanager') ? 'cmdline-tools' : !locate(root, 'emulator') ? 'emulator' : '',
    manualSdkRoot: !!overrideRoot(),
    installTarget: androidInstallTarget(),
  };
}

/** The `image.sysdir`/target of an AVD expressed as an SDK package name. */
function avdSystemPackage(avd: { target?: string; path?: string }): string {
  // config.ini keeps `image.sysdir.1=system-images/android-36/google_apis_playstore/x86_64/`.
  try {
    const text = fs.readFileSync(path.join(String(avd.path ?? ''), 'config.ini'), 'utf8');
    const dir = /^image\.sysdir\.1\s*=\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
    const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
    if (parts.length >= 4) return parts.slice(-4).join(';');
  } catch { /* fall through to the target hint */ }
  return '';
}

/** The emulator binary belonging to the SDK that holds this image. */
export async function emulatorForPackage(packageName: string): Promise<string> {
  const root = rootForPackage(packageName);
  const local = root ? locate(root, 'emulator') : '';
  if (local) return local;
  // No emulator next to the image: fall back to any SDK that has one.
  try { return sdk().emulator; } catch { return ''; }
}

export function androidSystemImageInstalled(systemId: string): boolean {
  const target = androidSystemImage(systemId);
  if (!target) return false;
  // An image counts as installed wherever it lives: the install folder the
  // user picked, or any detected SDK.
  return androidPackageInstalled(target.packageName);
}

/**
 * User-initiated local sdkmanager install of one system image, together with
 * everything the emulator needs to actually boot it: the command-line tools,
 * platform-tools (adb), the emulator, the matching platform and build-tools.
 * Anything already present is a no-op, so repeating this is cheap.
 */
export async function installAndroidSystemImage(systemId: string): Promise<void> {
  const target = image(systemId);
  const prerequisites = ['cmdline-tools;latest', 'platform-tools', 'emulator', `platforms;android-${target.api}`, 'build-tools;34.0.0'];
  const pending = prerequisites.filter((name) => !androidPackageInstalled(name));
  let step = 0;
  for (const name of pending) {
    step++;
    reportAndroidProgress({ stage: 'install', percent: -1, text: `Dependency ${step}/${pending.length}: ${name}` });
    // A missing optional dependency must not block the image itself.
    try { await installPackage(name, 30 * 60_000); } catch { /* surfaced later if the image needs it */ }
  }
  await installPackage(target.packageName, 60 * 60_000);
}

/** The SDK tools, or undefined when no SDK is installed (devices still list). */
function optionalSdk(): ReturnType<typeof sdk> | undefined {
  try { return sdk(); } catch { return undefined; }
}

/**
 * Read local AVD definitions. The folder scan is the source of truth - it also
 * sees devices created into a custom folder and works without command-line
 * tools - and `avdmanager list avd` only adds its target description on top.
 */
export async function listAndroidAvds(): Promise<AndroidAvd[]> {
  const tools = optionalSdk();
  const devices = new Map<string, AvdLocation>();
  for (const item of scanAvdFolders()) devices.set(item.name, item);
  if (tools?.avdmanager) {
    try {
      const raw = await run(tools.avdmanager, ['list', 'avd'], 20_000, tools.root);
      for (const item of parseAvdList(raw)) {
        const known = devices.get(item.name);
        if (known) { if (item.target) known.target = item.target; }
        else if (fs.existsSync(path.join(item.path, 'config.ini'))) devices.set(item.name, item);
      }
    } catch { /* the folder scan already answered; a tool failure must not empty the list */ }
  }
  const running = new Set<string>();
  if (tools?.adb) {
    try {
      const rows = (await run(tools.adb, ['devices'], 5_000)).split(/\r?\n/).filter((line) => /^emulator-\d+\s+device$/.test(line));
      await Promise.all(rows.map(async (row) => {
        const serial = row.split(/\s+/)[0];
        try {
          const avdProperty = ['ro', 'boot', 'qemu', 'avd_name'].join('.');
          const name = (await run(tools.adb, ['-s', serial, 'shell', 'getprop', avdProperty], 4_000)).trim();
          if (name) running.add(name);
        } catch { /* booting/offline emulator */ }
      }));
    } catch { /* ADB is optional */ }
  }
  const locations = [...devices.values()];
  const diskSizes = await Promise.all(locations.map((item) => folderBytes(item.path)));
  return locations.map((item, index) => {
    // Upgrade every Octo-created profile, including profiles made by older
    // releases. Merely changing RAM, disk, or the base AVD hardware profile
    // must never replace the selected handset's Android identity.
    const label = configValue(item.path, 'octobrowser.deviceLabel') || configValue(item.path, 'hw.device.name');
    const phone = PHONES.find((candidate) => handsetDisplayName(candidate) === label
      || `${candidate.identity.manufacturer} ${candidate.identity.commercialName}` === label);
    if (phone) {
      const identity = androidBuildIdentity(phone);
      const stored = deviceIdentityOf(item.path);
      if (!stored || stored.model === phone.identity.modelNumber || !stored.mac || !stored.imei) {
        writeConfigValues(item.path, {
          'octobrowser.buildBrand': stored?.brand || identity.brand,
          'octobrowser.buildManufacturer': stored?.manufacturer || identity.manufacturer,
          'octobrowser.buildModel': (stored?.model && stored.model !== phone.identity.modelNumber) ? stored.model : identity.model,
          'octobrowser.buildDevice': stored?.device || identity.device,
          'octobrowser.buildProduct': stored?.product || identity.product,
          'octobrowser.marketName': stored?.marketName || identity.marketName || identity.model,
          'octobrowser.deviceLabel': handsetDisplayName(phone),
          'octobrowser.mac': stored?.mac || identity.mac || '',
          'octobrowser.imei': stored?.imei || identity.imei || '',
          'octobrowser.androidId': stored?.androidId || identity.androidId || '',
          'octobrowser.serialNumber': stored?.serialNumber || identity.serialNumber || '',
          'octobrowser.phoneNumber': stored?.phoneNumber || identity.phoneNumber || '',
          'octobrowser.operator': stored?.operator || identity.operator || '',
          'octobrowser.simOperator': stored?.simOperator || identity.simOperator || '',
          'octobrowser.simCountry': stored?.simCountry || identity.simCountry || '',
          'octobrowser.identityApplied': '',
        });
      }
    }
    const width = configValue(item.path, 'hw.lcd.width');
    const height = configValue(item.path, 'hw.lcd.height');
    return {
      ...item,
      running: running.has(item.name),
      deviceLabel: configValue(item.path, 'octobrowser.deviceLabel') || configValue(item.path, 'hw.device.name'),
      resolution: width && height ? `${width}x${height}` : '',
      ramMb: Number.parseInt(configValue(item.path, 'hw.ramSize'), 10) || 0,
      dataPartition: configValue(item.path, 'disk.dataPartition.size'),
      cameraFront: cameraFromConfig(configValue(item.path, 'hw.camera.front'), configValue(item.path, 'octobrowser.cameraFront')),
      cameraBack: cameraFromConfig(configValue(item.path, 'hw.camera.back'), configValue(item.path, 'octobrowser.cameraBack')),
      cameraFrontDevice: [configValue(item.path, 'octobrowser.cameraFrontDevice'), configValue(item.path, 'hw.camera.front')]
        .find((value) => WEBCAM.test(value)) ?? '',
      cameraBackDevice: [configValue(item.path, 'octobrowser.cameraBackDevice'), configValue(item.path, 'hw.camera.back')]
        .find((value) => WEBCAM.test(value)) ?? '',
      cameraDevice: [configValue(item.path, 'octobrowser.cameraDevice'), configValue(item.path, 'hw.camera.back'), configValue(item.path, 'hw.camera.front')]
        .find((value) => WEBCAM.test(value)) ?? '',
      microphoneEnabled: configValue(item.path, 'hw.audioInput') !== 'no',
      networkSpeed: normalizeNetworkSpeed(configValue(item.path, 'runtime.network.speed')),
      incomplete: avdIncomplete(item.path),
      diskBytes: diskSizes[index] ?? 0,
      identity: deviceIdentityOf(item.path),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Create one local AVD in the user-selected folder. It never overwrites an existing AVD. */
/**
 * Inspect the files a creation left behind and repair what is safe to repair: a
 * pointer that names another folder is rewritten, and an existing config.ini is
 * brought back to the rules. Returns what is still wrong, so nothing is hidden.
 */
function repairAvdFiles(name: string, avdPath: string, api: number): string[] {
  const pointerFile = path.join(defaultAvdDirectory(), `${name}.ini`);
  const readPointer = (): string | undefined => { try { return fs.readFileSync(pointerFile, 'utf8'); } catch { return undefined; } };
  const first = [...inspectAvdPointer(name, readPointer(), avdPath), ...inspectAvdFolder(name, avdPath)];
  if (first.some((item) => item.file === `${name}.ini`)) writeAvdPointer(name, avdPath, api);
  if (fs.existsSync(configPath(avdPath)) && first.some((item) => item.file === 'config.ini')) writeConfigValues(avdPath, {});
  return [...inspectAvdPointer(name, readPointer(), avdPath), ...inspectAvdFolder(name, avdPath)]
    .map((item) => `${item.file}: ${item.problem}`);
}

export async function createAndroidAvd(input: AndroidAvdCreateInput): Promise<{ path: string; companion: boolean; issues: string[] }> {
  const tools = sdk();
  if (!tools.avdmanager) throw new Error('Android SDK AVD Manager not found');
  const name = assertName(input.name);
  const target = image(input.systemId);
  const profile = device(input.deviceId);
  if (!androidSystemImageInstalled(input.systemId)) throw new Error('Selected Android system image is not installed');
  const directory = input.installDirectory.trim() || defaultAvdDirectory();
  if (!ABSOLUTE(directory)) throw new Error('Choose an absolute Android virtual device folder');
  // avdmanager rejects a name that already has a pointer even when the chosen
  // folder itself is empty. Reconfigure that existing device in place instead
  // of showing the raw "already exists; use --force" failure (and never erase
  // its Android user data behind the user's back).
  const existing = (await listAndroidAvds()).find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
  const avdPath = existing?.path ?? path.join(directory, `${name}.avd`);
  const creating = !existing && !fs.existsSync(avdPath);
  if (creating) {
    // Refuse before creating anything if the disk cannot hold the device.
    const estimate = androidSpaceEstimate({ image: target, hardware: input.hardware, imageInstalled: true, snapshots: input.snapshots });
    const disk = androidDiskInfo(directory);
    if (disk.totalBytes && disk.freeBytes < estimate.deviceBytes) throw new Error('Not enough free disk space in the selected folder');
    fs.mkdirSync(directory, { recursive: true });
    await runAvdCreate(['create', 'avd', '--name', name, '--package', target.packageName,
      '--path', avdPath, '--device', profile.baseDevice, '--abi', target.abi], target.api, target.packageName);
  }
  const imageEmulator = await emulatorForPackage(target.packageName) || tools.emulator;
  const webcams = imageEmulator
    ? (await emulatorWebcamsFrom(imageEmulator, rootForPackage(target.packageName) || tools.root)).webcams
    : [];
  const resolvedCameras = resolveActiveCameraAssignments(
    input.cameraFront ?? 'webcam', input.cameraBack ?? 'webcam', input.cameraFrontDevice ?? '', input.cameraBackDevice ?? '', webcams,
    [], input.cameraDevice ?? '',
  );
  writeConfigValues(avdPath, {
    ...mediaConfig(resolvedCameras.front, resolvedCameras.back, input.microphoneEnabled,
      resolvedCameras.frontDevice, resolvedCameras.backDevice, cameraLimitsFor(avdPath, input.cameraLimits)),
    'hw.ramSize': String(input.hardware.ramMb),
    [['vm', 'heapSize'].join('.')]: String(input.hardware.heapMb),
    'hw.cpu.ncore': String(input.hardware.cores),
    'disk.dataPartition.size': `${input.hardware.dataGb}G`,
    'sdcard.size': input.hardware.sdCardMb > 0 ? `${input.hardware.sdCardMb}M` : '0',
    'hw.gpu.enabled': input.gpuMode === 'off' ? 'no' : 'yes',
    'hw.gpu.mode': input.gpuMode,
    'fastboot.forceColdBoot': input.bootMode === 'cold' ? 'yes' : 'no',
    'snapshot.present': input.snapshots ? 'yes' : 'no',
    'fastboot.chosenSnapshotFile': '',
    'hw.keyboard': input.keyboard ? 'yes' : 'no',
    'hw.gps': input.gps ? 'yes' : 'no',
    'hw.sensors.orientation': 'yes',
    'hw.sensors.proximity': 'yes',
    'hw.battery': 'yes',
    'runtime.network.speed': input.networkSpeed,
    'octobrowser.deviceLabel': `${profile.brand} ${profile.model}`,
    'octobrowser.locale': input.locale,
    'octobrowser.timezone': input.timezone,
  });
  // Make the device findable: remember the folder and (re)write the pointer
  // the emulator and avdmanager read, so it shows up in the list right away.
  rememberAvdDirectory(directory);
  writeAvdPointer(name, avdPath, target.api);
  return { path: avdPath, companion: false, issues: repairAvdFiles(name, avdPath, target.api) };
}

/**
 * Emulator usage metrics stay off. `-no-metrics` is passed only when the
 * installed emulator lists it: a build without the flag rejects unknown
 * options, and a build that asks about metrics would otherwise stop and wait.
 */
export function metricsFlagIn(helpText: string): string[] {
  return /(^|\s)-no-metrics(?![\w-])/m.test(helpText) ? ['-no-metrics'] : [];
}

const helpTextCache = new Map<string, Promise<string>>();

/** The emulator's own `-help-all` text, asked once per binary. Empty when the binary cannot answer. */
export function emulatorHelpText(emulator: string, sdkRoot: string): Promise<string> {
  let found = helpTextCache.get(emulator);
  if (!found) {
    found = new Promise<string>((resolve) => {
      execFile(emulator, ['-help-all'],
        { env: toolEnv(sdkRoot), windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 },
        (_error, stdout, stderr) => resolve(`${stdout ?? ''}${stderr ?? ''}`));
    });
    helpTextCache.set(emulator, found);
  }
  return found;
}

/** Ask this emulator binary (once per path) whether it accepts `-no-metrics`. */
export function emulatorTelemetryArgs(emulator: string, sdkRoot: string): Promise<string[]> {
  return emulatorHelpText(emulator, sdkRoot).then(metricsFlagIn);
}

/** A zoneinfo name such as Europe/Warsaw, Etc/GMT+1 or UTC: nothing else reaches the command line. */
const ZONE_NAME = /^(?:UTC|[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+-]+){1,2})$/;

/**
 * `-timezone` for the emulator. The emulator documents it as the way to run
 * the device in another zone; without it the device follows the computer's zone.
 */
export function timezoneArgsFor(zone: string): string[] {
  const clean = String(zone ?? '').trim();
  return ZONE_NAME.test(clean) ? ['-timezone', clean] : [];
}

export interface AndroidLaunchResult {
  cameraWarning: string;
  /** Things that were not applied for this launch, in plain words. */
  notes: string[];
}

/** Start the chosen AVD with the local media settings chosen by the user. */
export async function launchAndroidAvd(input: AndroidLaunchInput): Promise<AndroidLaunchResult> {
  const tools = sdk();
  const name = assertName(input.name);
  const avd = (await listAndroidAvds()).find((item) => item.name === name);
  if (!avd) throw new Error('Android virtual device not found');
  // The extra display is a config.ini setting the emulator reads at start. It is
  // written only when this launch states a choice, so other callers keep theirs.
  if (input.secondaryDisplay !== undefined) {
    writeSecondaryDisplay(path.join(avd.path, 'config.ini'), parseSecondaryDisplay(input.secondaryDisplay));
  }
  // Like avdmanager, the emulator reads the SDK it lives in, so the copy next
  // to the device's own system image is the one that can boot it.
  const emulator = await emulatorForPackage(avdSystemPackage(avd)) || tools.emulator;
  if (!emulator) throw new Error('Android Emulator not found');
  const requestedCameras = normalizeCameraSources(input.cameraFront ?? avd.cameraFront, input.cameraBack ?? avd.cameraBack);
  const front = requestedCameras.front;
  const back = requestedCameras.back;
  let cameraWarning = '';
  // Only cameras the emulator enumerates are considered. A lens whose camera is
  // no longer active is given another active one, or is off for this launch;
  // it never starts on a picture that is not a camera.
  const emulatorRoot = rootForPackage(avdSystemPackage(avd)) || tools.root;
  const webcamReport = await emulatorWebcamsFrom(emulator, emulatorRoot);
  const webcams = webcamReport.webcams;
  const assignments = resolveActiveCameraAssignments(
    front, back,
    input.cameraFrontDevice ?? avd.cameraFrontDevice ?? '',
    input.cameraBackDevice ?? avd.cameraBackDevice ?? '',
    webcams,
    [],
    input.cameraDevice ?? avd.cameraDevice ?? '',
  );
  if (assignments.warning) cameraWarning = [cameraWarning, assignments.warning].filter(Boolean).join(' ');
  if (!webcams.length && (front === 'webcam' || back === 'webcam')) {
    const reason = webcamReport.detail || webcamReport.problem === 'timeout'
      ? 'The selected Android Emulator could not enumerate a host camera. Close camera-using apps, allow desktop camera access in Windows Privacy settings, then refresh.'
      : 'The selected Android Emulator reported no usable host cameras. Set the AVD cameras to Webcam and cold boot it.';
    cameraWarning = [cameraWarning, reason].filter(Boolean).join(' ');
  }
  writeConfigValues(avd.path, mediaConfig(
    assignments.front, assignments.back, input.microphoneEnabled,
    assignments.frontDevice, assignments.backDevice,
    cameraLimitsFor(avd.path, input.cameraLimits),
  ));
  const cameraValues = emulatorCameraValues(
    assignments.front, assignments.back, assignments.frontDevice, assignments.backDevice,
  );
  const args = [`@${name}`, '-camera-back', cameraValues.back, '-camera-front', cameraValues.front];
  if (!input.microphoneEnabled) args.push('-no-audio');

  else args.push('-allow-host-audio');
  // Quick-boot snapshots preserve CameraProvider/DirectShow state from the
  // previous Windows device graph. Restoring that state after webcam numbers
  // or the Unity Capture producer changed is a reproducible stock Camera app
  // crash. Host-camera launches therefore cold-boot the volatile guest state
  // and do not save it back; userdata and installed apps remain untouched.
  const usesHostCamera = Boolean(assignments.frontDevice || assignments.backDevice);
  if (input.bootMode === 'cold' || usesHostCamera) args.push('-no-snapshot-load');
  if (usesHostCamera) args.push('-no-snapshot-save');
  if (input.networkSpeed) args.push('-netspeed', input.networkSpeed);
  const requestedGpu = input.gpuMode;
  if (process.env.OCTO_VM_MODE === '1' || requestedGpu === 'swiftshader_indirect') {
    args.push('-gpu', 'swiftshader_indirect');
  } else if (requestedGpu && requestedGpu !== 'auto') {
    args.push('-gpu', requestedGpu);
  }
  args.push(...localeArgs(String(input.locale ?? '')));
  // The zone saved in Device Settings is the one Android must report.
  args.push(...timezoneArgsFor(configValue(avd.path, 'octobrowser.timezone')));
  args.push(...await emulatorTelemetryArgs(emulator, emulatorRoot));
  // The telephony number is a plain emulator setting (not identity). It is passed only when this build lists the flag.
  const launchNotes: string[] = [];
  const telephone = configValue(avd.path, 'octobrowser.telephony');
  if (telephone) {
    const help = await emulatorHelpText(emulator, rootForPackage(avdSystemPackage(avd)) || tools.root);
    if (!telephonySupported(help)) launchNotes.push('This emulator does not list -phone-number, so the telephony number was not set.');
    else {
      try { args.push(...telephonyArgsIn(help, telephone)); }
      catch (error) { launchNotes.push(error instanceof Error ? error.message : String(error)); }
    }
  }
  // Microphone capture is read from the user's selected host input through
  // hw.audioInput. There is no safe emulator command-line value for a device
  // name, so labels and credentials are never exposed in a process command.
  let socksBridge: SocksHttpBridge | undefined;
  if (input.proxy) {
    if (input.proxy.type === 'socks5') {
      // Android has no native SOCKS support. Adapt it locally to the HTTP
      // proxy protocol the emulator accepts; upstream credentials never enter
      // process arguments or the Android guest.
      socksBridge = await startSocksHttpBridge(input.proxy);
      args.push('-http-proxy', socksBridge.url);
    } else {
      args.push('-http-proxy', `${input.proxy.type}://${input.proxy.host}:${input.proxy.port}`);
    }
  }
  // The emulator used to be started detached with its output thrown away, so
  // a device that refused to boot looked exactly like a device that started:
  // the UI said "launched" and nothing ever appeared. The first seconds are
  // watched here instead - if the emulator dies in that window, its own words
  // are what the user is told.
  await new Promise<void>((resolve, reject) => {
    let child: ChildProcess;
    // The emulator's own words, written as they arrive: a webcam error shows up
    // in the file while the device is still running, not only after it has exited.
    const emulatorLog = openCappedLog(androidEmulatorLogPath(name),
      `=== ${new Date().toISOString()} · ${name} ===\n${emulator} ${args.join(' ')}\n`, 2_000_000);
    try {
      child = spawn(emulator, args, {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
        env: toolEnv(emulatorRoot),
      });
    } catch (error) { socksBridge?.close(); reject(emulatorError(error instanceof Error ? error.message : String(error), name)); return; }
    let output = '';
    let settled = false;
    const collect = (chunk: Buffer | string) => { output = `${output}${String(chunk)}`.slice(-8000); emulatorLog(chunk); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', (error) => { socksBridge?.close(); if (!settled) { settled = true; reject(emulatorError(error.message, name)); } });
    child.once('exit', (code) => {
      socksBridge?.close();
      runningEmulators.delete(name);
      stopAndroidCameraDiagnostics(name);
      // A manually closed/crashed emulator bypasses stopAndroidAvd; release its
      // physical input and virtual output here as well.
      void releaseMediaCompanionForAvd(name);
      logToolRun(emulator, args, output);
      if (settled) return;
      settled = true;
      // A clean early exit is still a failure: the window never opened.
      reject(emulatorError(output || `The Android Emulator stopped immediately (exit code ${code ?? 0}).`, name));
    });
    child.once('spawn', () => { runningEmulators.set(name, child); });
    // Still alive after the window below means it is really booting.
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve();
    }, 6_000);
  });
  // The emulator is alive; follow guest camera/provider failures beyond the
  // short process-start window without delaying the launch UI.
  void startAndroidCameraDiagnostics(name);
  return { cameraWarning, notes: launchNotes };
}

/** Start an emulator with its output kept in the device's log; the quiet first boot uses this. */
function startQuietEmulator(emulator: string, name: string, sdkRoot: string): (args: string[]) => { exited: Promise<number | null>; kill(): void } {
  return (args) => {
    const child = spawn(emulator, args, { detached: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: toolEnv(sdkRoot) });
    const log = openCappedLog(androidEmulatorLogPath(name),
      `=== ${new Date().toISOString()} · ${name} · first boot, no window ===\n${emulator} ${args.join(' ')}\n`, 2_000_000);
    child.stdout?.on('data', log);
    child.stderr?.on('data', log);
    const exited = new Promise<number | null>((resolve) => {
      child.once('error', () => resolve(null));
      child.once('exit', (code) => resolve(code));
    });
    return { exited, kill: () => { if (child.exitCode === null && child.signalCode === null) child.kill(); } };
  };
}

function readPointerText(name: string): string | undefined {
  try { return fs.readFileSync(path.join(defaultAvdDirectory(), `${name}.ini`), 'utf8'); } catch { return undefined; }
}

/** Problems with the device's files as they are now, as `file: problem` lines. */
function inspectAvdFiles(name: string, avdPath: string): string[] {
  return [
    ...inspectAvdPointer(name, readPointerText(name), avdPath),
    ...inspectAvdFolder(name, avdPath),
    ...inspectHardwareCache(avdPath),
  ].map((item) => `${item.file}: ${item.problem}`);
}

/**
 * The same repairs creation makes, run after the device has been closed: a pointer
 * that names another folder is rewritten (keeping its API level), an existing
 * config.ini is brought back to the rules, and the emulator's cache is fixed in
 * place. A missing config.ini is never invented.
 */
function repairAvdFilesAfterBoot(name: string, avdPath: string): void {
  const pointer = readPointerText(name);
  if (inspectAvdPointer(name, pointer, avdPath).length) {
    writeAvdPointer(name, avdPath, Number(/^target=android-(\d+)/m.exec(pointer ?? '')?.[1] ?? 0));
  }
  if (fs.existsSync(configPath(avdPath)) && inspectAvdFolder(name, avdPath).some((item) => item.file === 'config.ini')) {
    writeConfigValues(avdPath, {});
  }
  if (inspectHardwareCache(avdPath).length) repairHardwareCache(avdPath);
}

/**
 * The first boot of a new device, with no window: it finishes its setup, is closed
 * with `adb emu kill`, and then the files it left are checked and repaired. Never
 * throws: whatever goes wrong comes back in `issues`.
 */
export async function quietBootAndroidAvd(name: string): Promise<QuietBootResult> {
  const fail = (message: string): QuietBootResult => ({ booted: false, serial: '', issues: [message], repaired: [] });
  let tools: ReturnType<typeof sdk>;
  try { tools = sdk(); } catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
  const avd = (await listAndroidAvds()).find((item) => item.name === name);
  if (!avd) return fail('The device was not found after it was created.');
  const system = avdSystemPackage(avd);
  const root = rootForPackage(system) || tools.root;
  const emulator = await emulatorForPackage(system) || tools.emulator;
  if (!emulator) return fail('The Android Emulator was not found, so the device was not started.');
  if (!tools.adb) return fail('adb was not found, so the device could not be checked.');
  const adb = tools.adb;
  const help = await emulatorHelpText(emulator, root);
  const extraArgs = metricsFlagIn(help);
  const notes: string[] = [];
  const telephone = configValue(avd.path, 'octobrowser.telephony');
  if (telephone) {
    if (!telephonySupported(help)) notes.push('This emulator does not list -phone-number, so the telephony number was not set.');
    else {
      try { extraArgs.push(...telephonyArgsIn(help, telephone)); }
      catch (error) { notes.push(error instanceof Error ? error.message : String(error)); }
    }
  }
  const result = await quietBoot({
    start: startQuietEmulator(emulator, name, root),
    adb: (args, timeoutMs) => adbRun(adb, args, timeoutMs),
    inspect: () => inspectAvdFiles(name, avd.path),
    repair: () => repairAvdFilesAfterBoot(name, avd.path),
    progress: (text, percent) => reportAndroidProgress({ stage: 'configure', percent, text }),
    sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
    now: () => Date.now(),
  }, { name, extraArgs });
  return { ...result, issues: [...notes, ...result.issues] };
}

/**
 * What the user chose last time they launched this device. Reopening the
 * launch dialog with everything reset was pure friction: the proxy, the
 * camera, the boot mode and the language are the same nine times out of ten.
 */
export interface AndroidLaunchPrefs {
  proxyId: string;
  cameraFront: CameraSource;
  cameraBack: CameraSource;
  cameraFrontDevice: string;
  cameraBackDevice: string;
  /** Legacy shared endpoint from older preferences. */
  cameraDevice: string;
  microphoneEnabled: boolean;
  /** Host microphone label the user picked for this device. */
  microphoneDevice: string;
  bootMode: BootMode;
  networkSpeed: NetworkSpeed;
  /** Extra display the device starts with (see android-displays.ts). */
  secondaryDisplay: SecondaryDisplay;
  /** BCP-47 tag Android boots with, e.g. "pl-PL". Empty = leave as it is. */
  locale: string;
  /** Folder of photos and videos this device shows through its camera. */
  mediaFolder: string;
  /** App stores / browsers to install the first time this device boots. */
  apps: string[];
  /** User-selected APKs for catalogue entries without a stable official URL. */
  appFiles: Record<string, string>;
}

function launchPrefsFile(): string {
  return path.join(os.homedir(), '.octobrowser', 'android-launch.json');
}

const DEFAULT_LAUNCH_PREFS: AndroidLaunchPrefs = {
  proxyId: '', cameraFront: 'webcam', cameraBack: 'webcam', cameraFrontDevice: '', cameraBackDevice: '', cameraDevice: '',
  microphoneEnabled: true, microphoneDevice: '', bootMode: 'quick', networkSpeed: 'lte', secondaryDisplay: 'none', locale: '', mediaFolder: '',
  apps: [], appFiles: {},
};

export function normalizeAndroidLaunchPrefs(value: Partial<AndroidLaunchPrefs> = {}): AndroidLaunchPrefs {
  const merged = { ...DEFAULT_LAUNCH_PREFS, ...value };
  // A launch file written by an older build can still carry the companion
  // routing keys. They are dropped, not remembered: Android reads a camera.
  for (const stale of ['hostCameraDevice', 'hostCameraRotation', 'hostCameraMirror', 'startMediaCompanion', 'mediaCameraName', 'mediaMicrophoneName']) {
    delete (merged as Record<string, unknown>)[stale];
  }
  const cameras = normalizeCameraSources(merged.cameraFront, merged.cameraBack);
  return {
    ...merged,
    cameraFront: cameras.front,
    cameraBack: cameras.back,
    cameraFrontDevice: WEBCAM.test(String(merged.cameraFrontDevice ?? '')) ? String(merged.cameraFrontDevice) : '',
    cameraBackDevice: WEBCAM.test(String(merged.cameraBackDevice ?? '')) ? String(merged.cameraBackDevice) : '',
    cameraDevice: WEBCAM.test(String(merged.cameraDevice ?? '')) ? String(merged.cameraDevice) : '',
    apps: Array.isArray(merged.apps) ? [...merged.apps] : [],
    appFiles: merged.appFiles && typeof merged.appFiles === 'object' ? { ...merged.appFiles } : {},
  };
}

function readAllLaunchPrefs(): Record<string, AndroidLaunchPrefs> {
  try {
    const raw = JSON.parse(fs.readFileSync(launchPrefsFile(), 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const out: Record<string, AndroidLaunchPrefs> = {};
    for (const [name, value] of Object.entries(raw)) {
      if (!NAME.test(name) || typeof value !== 'object' || !value) continue;
      out[name] = normalizeAndroidLaunchPrefs(value as Partial<AndroidLaunchPrefs>);
    }
    return out;
  } catch { return {}; }
}

export function androidLaunchPrefs(name: string): AndroidLaunchPrefs {
  return readAllLaunchPrefs()[String(name ?? '')] ?? { ...DEFAULT_LAUNCH_PREFS };
}

/** Remember this launch. Only the fields we know; anything else is ignored. */
export function rememberAndroidLaunch(name: string, prefs: Partial<AndroidLaunchPrefs>): AndroidLaunchPrefs {
  const clean = assertName(name);
  const all = readAllLaunchPrefs();
  const next: AndroidLaunchPrefs = {
    ...DEFAULT_LAUNCH_PREFS,
    ...all[clean],
    ...prefs,
    locale: LOCALE_TAG.test(String(prefs.locale ?? all[clean]?.locale ?? '')) ? String(prefs.locale ?? all[clean]?.locale ?? '') : '',
    cameraFrontDevice: WEBCAM.test(String(prefs.cameraFrontDevice ?? all[clean]?.cameraFrontDevice ?? ''))
      ? String(prefs.cameraFrontDevice ?? all[clean]?.cameraFrontDevice) : '',
    cameraBackDevice: WEBCAM.test(String(prefs.cameraBackDevice ?? all[clean]?.cameraBackDevice ?? ''))
      ? String(prefs.cameraBackDevice ?? all[clean]?.cameraBackDevice) : '',
    cameraDevice: WEBCAM.test(String(prefs.cameraDevice ?? all[clean]?.cameraDevice ?? ''))
      ? String(prefs.cameraDevice ?? all[clean]?.cameraDevice) : '',
    microphoneDevice: String(prefs.microphoneDevice ?? all[clean]?.microphoneDevice ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 160),
    apps: Array.isArray(prefs.apps) ? prefs.apps.map((id) => String(id)).slice(0, 24) : (all[clean]?.apps ?? []),
    appFiles: Object.fromEntries(Object.entries(prefs.appFiles ?? all[clean]?.appFiles ?? {})
      .filter(([id, file]) => /^[a-z0-9_-]{1,40}$/i.test(id) && typeof file === 'string' && path.isAbsolute(file) && /\.apk$/i.test(file))
      .slice(0, 24)),
  };
  const cameras = normalizeCameraSources(next.cameraFront, next.cameraBack);
  next.cameraFront = cameras.front;
  next.cameraBack = cameras.back;
  all[clean] = next;
  try {
    fs.mkdirSync(path.dirname(launchPrefsFile()), { recursive: true });
    fs.writeFileSync(launchPrefsFile(), JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  } catch { /* a remembered setting is a convenience, never a failure */ }
  return next;
}

/** "pl-PL", "en-US", "pt-BR" - language, optional script, optional region. */
const LOCALE_TAG = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/;

/**
 * Languages offered for a device. Android reads `persist.sys.locale` at boot,
 * so this is applied on the command line and survives a restart of the app.
 */
export const ANDROID_LOCALES: Array<{ tag: string; label: string }> = [
  { tag: '', label: 'System default' },
  { tag: 'en-US', label: 'English (United States)' },
  { tag: 'en-GB', label: 'English (United Kingdom)' },
  { tag: 'pl-PL', label: 'Polski (Polska)' },
  { tag: 'de-DE', label: 'Deutsch (Deutschland)' },
  { tag: 'fr-FR', label: 'Français (France)' },
  { tag: 'es-ES', label: 'Español (España)' },
  { tag: 'it-IT', label: 'Italiano (Italia)' },
  { tag: 'pt-BR', label: 'Português (Brasil)' },
  { tag: 'nl-NL', label: 'Nederlands (Nederland)' },
  { tag: 'cs-CZ', label: 'Čeština (Česko)' },
  { tag: 'uk-UA', label: 'Українська (Україна)' },
  { tag: 'ru-RU', label: 'Русский (Россия)' },
  { tag: 'tr-TR', label: 'Türkçe (Türkiye)' },
  { tag: 'ar-EG', label: 'العربية (مصر)' },
  { tag: 'hi-IN', label: 'हिन्दी (भारत)' },
  { tag: 'id-ID', label: 'Bahasa Indonesia' },
  { tag: 'ja-JP', label: '日本語 (日本)' },
  { tag: 'ko-KR', label: '한국어 (대한민국)' },
  { tag: 'zh-CN', label: '中文 (中国)' },
];

/** The emulator flags that boot Android in one language. */
export function localeArgs(tag: string): string[] {
  if (!LOCALE_TAG.test(String(tag ?? ''))) return [];
  const [language, ...rest] = tag.split('-');
  const region = rest.find((part) => /^[A-Z]{2}$/.test(part)) ?? '';
  const args = ['-prop', `persist.sys.locale=${tag}`, '-prop', `persist.sys.language=${language}`];
  if (region) args.push('-prop', `persist.sys.country=${region}`);
  return args;
}

/**
 * Make the device say what handset it is.
 *
 * Writing the brand and model into config.ini does nothing: Android reads
 * those from `build.prop` inside the system image, which is why a device
 * created as a Pixel 9 still reports `sdk_gphone64_x86_64` to every app and
 * every website. The only way to change it is to edit `build.prop` in the
 * running device, which needs
 *
 *   * an image that allows root - a Google Play image never does;
 *   * the emulator started with `-writable-system`;
 *   * `adb root` + `adb remount`, then a reboot to apply.
 *
 * All of that is done here, and every step that cannot be done is reported
 * instead of being papered over.
 */
export interface DeviceIdentity {
  brand: string;
  manufacturer: string;
  model: string;
  marketName?: string;
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

export interface IdentityVerification {
  field: keyof DeviceIdentity;
  property: string;
  expected: string;
  actual: string;
  ok: boolean;
}

export interface AndroidIdentityReport {
  brand: string; manufacturer: string; model: string; device: string; product: string; marketName: string;
  mac: string; imei: string; androidId: string; serialNumber: string; phoneNumber: string;
  operator: string; simOperator: string; simCountry: string;
}

export interface IdentityResult {
  ok: boolean;
  changed: string[];
  message: string;
  /** The device is rebooting to pick the new identity up. */
  rebooting: boolean;
  /** Exact values read back from Android, including any mismatch. */
  verification?: IdentityVerification[];
  /** No handset identity is stored for this device, so nothing was attempted. */
  nothingStored?: boolean;
}

/** Compare the requested identity with values read back from the running guest. */
export function verifyAndroidIdentity(identity: DeviceIdentity, actual: Partial<AndroidIdentityReport>): IdentityVerification[] {
  const rows: Array<[keyof DeviceIdentity, string, string, string]> = [
    ['brand', 'ro.product.brand', identity.brand, String(actual.brand ?? '')],
    ['manufacturer', 'ro.product.manufacturer', identity.manufacturer, String(actual.manufacturer ?? '')],
    ['model', 'ro.product.model', identity.model, String(actual.model ?? '')],
    ['device', 'ro.product.device', identity.device, String(actual.device ?? '')],
    ['product', 'ro.product.name', identity.product, String(actual.product ?? '')],
    ['marketName', 'ro.product.marketname', identity.marketName ?? '', String(actual.marketName ?? '')],
    ['serialNumber', 'ro.serialno', identity.serialNumber ?? '', String(actual.serialNumber ?? '')],
    ['androidId', 'settings:secure.android_id', identity.androidId ?? '', String(actual.androidId ?? '')],
    ['mac', 'network:wlan0.address', identity.mac ?? '', String(actual.mac ?? '')],
    ['imei', 'radio:imei', identity.imei ?? '', String(actual.imei ?? '')],
    ['phoneNumber', 'radio:line1', identity.phoneNumber ?? '', String(actual.phoneNumber ?? '')],
    ['operator', 'gsm.operator.alpha', identity.operator ?? '', String(actual.operator ?? '')],
    ['simOperator', 'gsm.sim.operator.numeric', identity.simOperator ?? '', String(actual.simOperator ?? '')],
    ['simCountry', 'gsm.sim.operator.iso-country', identity.simCountry ?? '', String(actual.simCountry ?? '')],
  ];
  const normalize = (field: keyof DeviceIdentity, value: string) => {
    if (field === 'mac') return value.toLowerCase().replace(/[^a-f0-9]/g, '');
    if (field === 'imei' || field === 'phoneNumber' || field === 'simOperator') return value.replace(/\D/g, '');
    if (field === 'simCountry') return value.trim().toLowerCase();
    return value.trim();
  };
  return rows.filter(([, , expected]) => expected.trim() !== '').map(([field, property, expected, reported]) => ({
    field, property, expected, actual: reported,
    ok: reported.trim() !== '' && normalize(field, reported) === normalize(field, expected),
  }));
}

/** The handset identity stored with a device, if any. */
export function deviceIdentityOf(avdPath: string): DeviceIdentity | undefined {
  const brand = configValue(avdPath, 'octobrowser.buildBrand');
  const model = configValue(avdPath, 'octobrowser.buildModel');
  if (!brand && !model) return undefined;
  return {
    brand,
    manufacturer: configValue(avdPath, 'octobrowser.buildManufacturer') || brand,
    model,
    marketName: configValue(avdPath, 'octobrowser.marketName') || model,
    device: configValue(avdPath, 'octobrowser.buildDevice'),
    product: configValue(avdPath, 'octobrowser.buildProduct'),
    mac: configValue(avdPath, 'octobrowser.mac'),
    imei: configValue(avdPath, 'octobrowser.imei'),
    androidId: configValue(avdPath, 'octobrowser.androidId'),
    serialNumber: configValue(avdPath, 'octobrowser.serialNumber'),
    phoneNumber: configValue(avdPath, 'octobrowser.phoneNumber'),
    operator: configValue(avdPath, 'octobrowser.operator'),
    simOperator: configValue(avdPath, 'octobrowser.simOperator'),
    simCountry: configValue(avdPath, 'octobrowser.simCountry'),
  };
}

/** A Google Play image is signed and locked: `adb root` is refused on it. */
export function imageAllowsRoot(avd: { target?: string; path?: string }): boolean {
  // Any of the three says the same thing: a Play image is signed and locked.
  const haystack = [avdSystemPackage(avd), avd.target ?? '', configValue(avd.path ?? '', 'tag.id'),
    configValue(avd.path ?? '', 'tag.display')].join(' ');
  return !/playstore|google play/i.test(haystack);
}

function adbRun(adb: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(adb, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => { out += String(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { out += String(chunk); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } reject(new Error(`${args[0]} timed out`)); }, timeout);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(out.trim().slice(0, 300) || `adb ${args.join(' ')} failed`));
    });
  });
}

/** The build.prop lines that carry the handset identity. */
export function patchBuildProp(text: string, identity: DeviceIdentity): { text: string; changed: string[] } {
  const values: Record<string, string> = {
    'ro.product.brand': identity.brand,
    'ro.product.manufacturer': identity.manufacturer,
    'ro.product.model': identity.model,
    'ro.product.name': identity.product || identity.device || identity.model,
    'ro.product.device': identity.device || identity.product || identity.model,
    'ro.product.system.brand': identity.brand,
    'ro.product.system.manufacturer': identity.manufacturer,
    'ro.product.system.model': identity.model,
    'ro.product.system.name': identity.product || identity.model,
    'ro.product.system.device': identity.device || identity.model,
    'ro.product.vendor.brand': identity.brand,
    'ro.product.vendor.manufacturer': identity.manufacturer,
    'ro.product.vendor.model': identity.model,
    'ro.product.vendor.name': identity.product || identity.model,
    'ro.product.vendor.device': identity.device || identity.model,
    // Modern Android derives Build.* using ro.product.property_source_order.
    // Patching only the unsuffixed/system keys leaves product/odm ahead of us,
    // so Build.MODEL can remain sdk_gphone even after a successful rewrite.
    'ro.product.product.brand': identity.brand,
    'ro.product.product.manufacturer': identity.manufacturer,
    'ro.product.product.model': identity.model,
    'ro.product.product.name': identity.product || identity.model,
    'ro.product.product.device': identity.device || identity.model,
    'ro.product.odm.brand': identity.brand,
    'ro.product.odm.manufacturer': identity.manufacturer,
    'ro.product.odm.model': identity.model,
    'ro.product.odm.name': identity.product || identity.model,
    'ro.product.odm.device': identity.device || identity.model,
    'ro.product.system_ext.brand': identity.brand,
    'ro.product.system_ext.manufacturer': identity.manufacturer,
    'ro.product.system_ext.model': identity.model,
    'ro.product.system_ext.name': identity.product || identity.model,
    'ro.product.system_ext.device': identity.device || identity.model,
    'ro.build.product': identity.device || identity.product || identity.model,
    'ro.serialno': identity.serialNumber || '',
    'ro.boot.serialno': identity.serialNumber || '',
    'ro.product.marketname': identity.marketName || identity.model,
    // Settings and apps use this to choose the phone UI rather than a tablet,
    // TV, or generic emulator layout. Hardware-backed emulator indicators are
    // deliberately not forged here; see the limitations shown in the UI.
    'ro.build.characteristics': 'phone',
  };
  const changed: string[] = [];
  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const match = /^([a-z0-9_.]+)=(.*)$/i.exec(line.trim());
    if (!match) return line;
    const key = match[1];
    if (!(key in values) || !values[key]) return line;
    seen.add(key);
    if (match[2] === values[key]) return line;
    changed.push(key);
    return `${key}=${values[key]}`;
  });
  // Keys the image never had are appended, so a slim AOSP build still gets them.
  for (const [key, value] of Object.entries(values)) {
    if (!value || seen.has(key)) continue;
    next.push(`${key}=${value}`);
    changed.push(key);
  }
  return { text: `${next.join('\n').replace(/\n+$/, '')}\n`, changed };
}

async function readAndroidIdentityReport(adb: string, serial: string): Promise<AndroidIdentityReport> {
  const property = async (key: string): Promise<string> =>
    (await adbRun(adb, ['-s', serial, 'shell', 'getprop', key], 15_000).catch(() => '')).trim();
  const setting = async (namespace: string, key: string): Promise<string> =>
    (await adbRun(adb, ['-s', serial, 'shell', 'settings', 'get', namespace, key], 15_000).catch(() => '')).trim();
  const [brand, manufacturer, model, device, product, marketName, serialNo, bootSerial,
    androidId, wifiMac, linkInfo, imei, simImei, persistImei, bootImei, phoneNumber, simNumber,
    operator, simOperator, simCountry] = await Promise.all([
    property('ro.product.brand'), property('ro.product.manufacturer'), property('ro.product.model'),
    property('ro.product.device'), property('ro.product.name'), property('ro.product.marketname'),
    property('ro.serialno'), property('ro.boot.serialno'), setting('secure', 'android_id'),
    adbRun(adb, ['-s', serial, 'shell', 'cat', '/sys/class/net/wlan0/address'], 15_000).catch(() => ''),
    adbRun(adb, ['-s', serial, 'shell', 'ip', 'link', 'show', 'wlan0'], 15_000).catch(() => ''),
    property('gsm.imei'), property('gsm.sim.imei'), property('persist.radio.imei'), property('ro.boot.imei'),
    property('persist.radio.line1'), property('gsm.sim.msisdn'), property('gsm.operator.alpha'),
    property('gsm.sim.operator.numeric'), property('gsm.sim.operator.iso-country'),
  ]);
  const address = /\blink\/ether\s+([0-9a-f:]{17})/i.exec(linkInfo)?.[1] ?? '';
  return {
    brand, manufacturer, model, device, product, marketName,
    serialNumber: serialNo || bootSerial, androidId: androidId === 'null' ? '' : androidId,
    mac: address || wifiMac.trim(), imei: imei || simImei || persistImei || bootImei,
    phoneNumber: phoneNumber || simNumber, operator, simOperator, simCountry,
  };
}

/**
 * Apply the stored handset identity to a running device. Returns what was
 * changed, or exactly which step refused.
 */
export async function applyDeviceIdentity(name: string): Promise<IdentityResult> {
  const clean = assertName(name);
  const avd = (await listAndroidAvds()).find((item) => item.name === clean);
  if (!avd) throw new Error('Android virtual device not found');
  let identity = deviceIdentityOf(avd.path);
  // Repair devices made by older Octo builds as well as newly created ones.
  // Those builds stored the regional SKU as every model and borrowed the base
  // Google AVD profile as DEVICE/PRODUCT. The saved handset label lets us
  // migrate only our own old values without overwriting a user's custom props.
  const catalog = PHONES.find((item) => handsetDisplayName(item) === avd.deviceLabel
    || `${item.identity.manufacturer} ${item.identity.commercialName}` === avd.deviceLabel);
  if (identity && catalog) {
    const expected = androidBuildIdentity(catalog);
    const oldCreatorIdentity = identity.model === catalog.identity.modelNumber
      || identity.device === catalog.identity.avdProfile;
    if (oldCreatorIdentity && Object.keys(expected).some((key) => identity?.[key as keyof DeviceIdentity] !== expected[key as keyof DeviceIdentity])) {
      identity = expected;
      writeConfigValues(avd.path, {
        'octobrowser.buildBrand': identity.brand,
        'octobrowser.buildManufacturer': identity.manufacturer,
        'octobrowser.buildModel': identity.model,
        'octobrowser.buildDevice': identity.device,
        'octobrowser.buildProduct': identity.product,
        'octobrowser.marketName': identity.marketName || identity.model,
      });
    }
  }
  if (!identity?.model) {
    return { ok: false, changed: [], rebooting: false, message: 'This device has no handset identity stored, so there is nothing to apply.', nothingStored: true };
  }
  // OctoSuite no longer writes a handset identity or fabricated identifiers into
  // Android: no build property, IMEI, MAC, Android ID, serial or phone number is
  // changed. The stored values are kept, unused, until they are removed.
  return {
    ok: false, changed: [], rebooting: false,
    message: `${clean}: Octo does not write a handset identity or fabricated identifiers into Android. The stored values are kept but not applied.`,
  };
}

/** Emulator processes we started, so they can be stopped again. */
const runningEmulators = new Map<string, ChildProcess>();
/** Filtered guest camera/crash logs that follow those emulator processes. */
const cameraDiagnosticChildren = new Map<string, ChildProcess>();

/** Stable per-device diagnostic path suitable for support without a logcat dump. */
export function androidCameraLogPath(name: string): string {
  return path.join(os.homedir(), '.octobrowser', `android-camera-${assertName(name)}.log`);
}

/** The emulator's own output for one device. Each launch starts a new file. */
export function androidEmulatorLogPath(name: string): string {
  return path.join(os.homedir(), '.octobrowser', `android-emulator-${assertName(name)}.log`);
}

/**
 * Start a log file with `header`, and return a writer that adds at most `limit`
 * bytes after it. A log that cannot be written never breaks the caller.
 */
export function openCappedLog(file: string, header: string, limit: number): (chunk: Buffer | string) => void {
  let bytes = 0;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, header, { mode: 0o600 });
  } catch { return () => undefined; }
  return (chunk) => {
    if (bytes >= limit) return;
    const slice = Buffer.from(String(chunk)).subarray(0, Math.max(0, limit - bytes));
    bytes += slice.length;
    try { fs.appendFileSync(file, slice); } catch { /* diagnostics are advisory */ }
  };
}

function stopAndroidCameraDiagnostics(name: string): void {
  const child = cameraDiagnosticChildren.get(name);
  if (child?.exitCode === null) child.kill();
  cameraDiagnosticChildren.delete(name);
}

/**
 * Capture only CameraProvider/cameraserver and fatal app records. This starts
 * after adb sees the AVD and stays small, but records the concrete guest stack
 * if the stock Camera app terminates after the launch window has passed.
 */
async function startAndroidCameraDiagnostics(name: string): Promise<void> {
  stopAndroidCameraDiagnostics(name);
  const tools = optionalSdk();
  if (!tools?.adb) return;
  let serial = '';
  for (let attempt = 0; attempt < 60 && runningEmulators.has(name); attempt++) {
    serial = await emulatorSerial(name);
    if (serial) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!serial || !runningEmulators.has(name)) return;
  const file = androidCameraLogPath(name);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `=== ${new Date().toISOString()} · ${name} · ${serial} ===\n`, { mode: 0o600 });
  } catch { return; }
  const child = spawn(tools.adb, [
    '-s', serial, 'logcat', '-v', 'time', '-T', '1',
    'CameraService:V', 'CameraProvider:V', 'Camera3-Device:V', 'CameraDeviceClient:V',
    'EmulatedCamera:V', 'AndroidRuntime:E', 'DEBUG:F', 'libc:F', '*:S',
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: toolEnv(tools.root) });
  cameraDiagnosticChildren.set(name, child);
  let bytes = 0;
  const append = (chunk: Buffer | string) => {
    if (bytes >= 2_000_000) return;
    const data = Buffer.from(String(chunk));
    const slice = data.subarray(0, Math.max(0, 2_000_000 - bytes));
    bytes += slice.length;
    try { fs.appendFileSync(file, slice); } catch { /* diagnostics are advisory */ }
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.once('error', (error) => append(`\nlogcat error: ${error.message}\n`));
  child.once('exit', () => {
    if (cameraDiagnosticChildren.get(name) === child) cameraDiagnosticChildren.delete(name);
  });
  child.unref();
}

/** Turn an emulator start-up failure into something the user can act on. */
function emulatorError(raw: string, name: string): Error {
  const text = meaningfulOutput(String(raw || '')) || String(raw || '').trim();
  if (/could not find|no such file|unknown avd|avd .* does not exist/i.test(text)) {
    return new Error(`The Android Emulator could not open ${name}. Its folder or its system image is missing - use "Camera and microphone" > check, or delete the device and create it again. Full log: ${androidToolLogPath()}`);
  }
  if (/system image|kernel|ramdisk|userdata|missing.*image/i.test(text)) {
    return new Error(`${name} has no usable system image, so it cannot boot. The image was probably never downloaded: create the device again, or install its Android version first. Full log: ${androidToolLogPath()}`);
  }
  if (/HAXM|WHPX|hypervisor|virtualization|KVM|vt-x|hyper-v/i.test(text)) {
    return new Error(`The Android Emulator cannot use hardware virtualisation on this computer. Enable virtualisation in the BIOS, or install the Windows Hypervisor Platform / HAXM. Details: ${text.slice(0, 240)}`);
  }
  if (/already running|lock/i.test(text)) return new Error(`${name} is already running, or a stale lock file is left in its folder.`);
  if (/x86_64|arm|abi/i.test(text) && /not supported|cannot run/i.test(text)) {
    return new Error(`${name} was built for another processor architecture and cannot run here. Create it again with an image this computer supports.`);
  }
  return new Error(`${name} did not start: ${text.slice(0, 400) || 'the emulator gave no reason'}. Full log: ${androidToolLogPath()}`);
}

/** Full path of adb, for the modules that install into a running device. */
export function adbPath(): string {
  return optionalSdk()?.adb ?? '';
}

/** The adb serial of a running device, exported for the store installer. */
export async function androidSerialFor(name: string): Promise<string> {
  return emulatorSerial(assertName(name));
}

/** The adb serial of a running device, or '' when it is not running. */
async function emulatorSerial(name: string): Promise<string> {
  const tools = optionalSdk();
  if (!tools?.adb) return '';
  try {
    const rows = (await run(tools.adb, ['devices'], 5_000)).split(/\r?\n/).filter((line) => /^emulator-\d+\s+device$/.test(line));
    for (const row of rows) {
      const serial = row.split(/\s+/)[0];
      const avdProperty = ['ro', 'boot', 'qemu', 'avd_name'].join('.');
      const running = (await run(tools.adb, ['-s', serial, 'shell', 'getprop', avdProperty], 4_000)).trim();
      if (running === name) return serial;
    }
  } catch { /* adb is optional */ }
  return '';
}

/** The single mobile publisher belongs to the AVD named in its config. */
function mediaCompanionOwner(): string {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(mediaCompanionRoot(MOBILE), 'config.json'), 'utf8')) as {
      mobile?: { device?: unknown }; octobrowser?: { avd?: unknown };
    };
    const owner = config.mobile?.device ?? config.octobrowser?.avd;
    return typeof owner === 'string' ? owner : '';
  } catch { return ''; }
}

/**
 * Stop vStudio Mobile when the AVD it serves stops. Leaving it alive retains
 * the selected physical webcam and Unity Capture output, which in turn makes a
 * later website getUserMedia call fail with NotReadableError/device-in-use.
 */
async function releaseMediaCompanionForAvd(name: string): Promise<void> {
  if (mediaCompanionOwner() !== name) return;
  const child = runningChild(MOBILE);
  if (!child) {
    terminateOrphanedMediaCompanion(MOBILE);
    return;
  }
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  stopMediaCompanion(MOBILE);
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
}

/**
 * Stop a running device. Politely first (`adb emu kill`, which lets Android
 * shut down), then by killing the emulator process we started, then - only
 * when asked to force it - by name through the operating system. The owning
 * vStudio process is always released too, including the already-stopped case.
 */
export async function stopAndroidAvd(name: string, force = false): Promise<{ stopped: boolean; how: string }> {
  const clean = assertName(name);
  const tools = optionalSdk();
  const serial = await emulatorSerial(clean);
  if (serial && tools?.adb) {
    try {
      await run(tools.adb, ['-s', serial, 'emu', 'kill'], 15_000);
      // Give Android a moment to disappear from `adb devices`.
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((done) => setTimeout(done, 500));
        if (!(await emulatorSerial(clean))) {
          runningEmulators.delete(clean);
          stopAndroidCameraDiagnostics(clean);
          await releaseMediaCompanionForAvd(clean);
          return { stopped: true, how: 'adb' };
        }
      }
    } catch { /* fall through to the harder ways */ }
  }
  const child = runningEmulators.get(clean);
  if (child && child.exitCode === null) {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
    runningEmulators.delete(clean);
    stopAndroidCameraDiagnostics(clean);
    await releaseMediaCompanionForAvd(clean);
    return { stopped: true, how: 'process' };
  }
  if (!force) {
    if (!serial) {
      stopAndroidCameraDiagnostics(clean);
      await releaseMediaCompanionForAvd(clean);
      return { stopped: true, how: 'not-running' };
    }
    throw new Error(`${clean} did not answer. Use "Force stop" to end the emulator process.`);
  }
  // Last resort: the emulator was started by someone else (or a previous run).
  const killed = await killEmulatorProcess(clean);
  if (!killed) throw new Error(`${clean} could not be stopped. Close the emulator window manually.`);
  runningEmulators.delete(clean);
  stopAndroidCameraDiagnostics(clean);
  await releaseMediaCompanionForAvd(clean);
  return { stopped: true, how: 'force' };
}

/** Kill the emulator process that serves this AVD, by its command line. */
async function killEmulatorProcess(name: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const query = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name like 'qemu-system%' or Name like 'emulator%'" | Where-Object { $_.CommandLine -like '*${name.replace(/'/g, '')}*' } | ForEach-Object { $_.ProcessId }`],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      const pids = String(query.stdout || '').split(/\r?\n/).map((line) => Number.parseInt(line.trim(), 10)).filter((pid) => pid > 0);
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
      return pids.length > 0;
    }
    const query = spawnSync('pgrep', ['-f', `qemu-system.*${name}|emulator.*@?${name}`], { encoding: 'utf8', timeout: 15_000 });
    const pids = String(query.stdout || '').split(/\n/).map((line) => Number.parseInt(line.trim(), 10)).filter((pid) => pid > 0);
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    return pids.length > 0;
  } catch { return false; }
}

/** Delete one AVD folder after an explicit confirmation in the UI. */
export async function deleteAndroidAvd(name: string): Promise<boolean> {
  const tools = optionalSdk();
  const clean = assertName(name);
  const avd = (await listAndroidAvds()).find((item) => item.name === clean);
  if (!avd) throw new Error('Android virtual device not found');
  if (avd.running) throw new Error('Stop the Android device before deleting it');
  if (tools?.avdmanager) { try { await run(tools.avdmanager, ['delete', 'avd', '--name', clean], 60_000, tools.root); } catch { /* fall back to the folder */ } }
  // Deleting a multi-gigabyte snapshot tree synchronously blocked Electron's
  // event loop and triggered Windows' "not responding" dialog. Keep yielding
  // while libuv removes it and only resolve the confirmation after it is gone.
  await fs.promises.rm(avd.path, { recursive: true, force: true });
  // The pointer in the AVD home would otherwise keep listing a ghost device.
  await fs.promises.rm(path.join(defaultAvdDirectory(), `${clean}.ini`), { force: true }).catch(() => undefined);
  folderSizeCache.delete(avd.path);
  return true;
}

export async function openAndroidAvdFolder(name: string): Promise<string> {
  const found = (await listAndroidAvds()).find((item) => item.name === assertName(name));
  if (!found || !ABSOLUTE(found.path)) throw new Error('Android virtual device not found');
  return found.path;
}

/**
 * Install the missing Android pieces the way installer.bat does: Google
 * standalone SDK command-line tools and ADB/emulator packages into the local SDK folder,
 * with Android Studio via winget as a secondary fallback.
 */
export async function installAndroidTools(): Promise<{ ok: boolean; message: string }> {
  let root = roots()[0] ?? '';
  if (!root) {
    root = androidInstallRoot();
    try { fs.mkdirSync(root, { recursive: true }); } catch {}
  }

  // 1. If sdkmanager is missing from root, first download and unpack Google's cmdline-tools
  if (!locate(root, 'sdkmanager')) {
    try {
      await ensureCommandLineTools(root);
      setAndroidSdkRoot(root);
    } catch (cmdlineErr) {
      // If direct cmdline-tools download failed and on Windows, try winget as fallback
      if (process.platform === 'win32') {
        const winget = ['winget.exe', path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'winget.exe')]
          .find((candidate) => candidate === 'winget.exe' || fs.existsSync(candidate)) ?? '';
        if (winget) {
          try {
            await run(winget, ['install', '--id', 'Google.AndroidStudio', '--exact', '--source', 'winget', '--silent',
              '--accept-package-agreements', '--accept-source-agreements'], 45 * 60_000);
            return { ok: true, message: 'Android Studio installed. Start it once so it downloads the SDK, then refresh.' };
          } catch {}
        }
      }
      return { ok: false, message: cmdlineErr instanceof Error ? cmdlineErr.message : String(cmdlineErr) };
    }
  }

  // 2. Accept licenses automatically
  try { acceptAndroidLicenses(); } catch {}

  // 3. Install core packages (cmdline-tools;latest, platform-tools [adb], emulator)
  if (locate(root, 'sdkmanager')) {
    const wanted = ['cmdline-tools;latest', 'platform-tools', 'emulator'];
    const failures: string[] = [];
    for (const name of wanted) {
      if (androidPackageInstalled(name)) continue;
      try { await installPackage(name, 30 * 60_000); }
      catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!failures.length) return { ok: true, message: `Android SDK command-line tools installed in ${root}.` };
    return { ok: false, message: meaningfulOutput(failures.join(' ')).slice(0, 400) };
  }

  return { ok: false, message: 'Could not configure Android SDK tools.' };
}

export interface SpecCreateInput {
  name: string;
  installDirectory: string;
  /** Full SDK package name of the system image, from the catalogue. */
  systemPackage: string;
  baseDevice: string;
  label: string;
  width: number; height: number; dpi: number;
  ramMb: number; heapMb: number; cores: number; dataGb: number; sdCardMb: number;
  gpuMode: GpuMode; bootMode: BootMode; snapshots: boolean;
  cameraFront: CameraSource; cameraBack: CameraSource; microphoneEnabled: boolean;
  /** Active emulator camera endpoints assigned independently to each facing. */
  cameraFrontDevice?: string; cameraBackDevice?: string;
  /** Legacy shared endpoint for older callers. */
  cameraDevice?: string;
  /** What a tested host camera actually produced, per facing. */
  cameraLimits?: { front?: CameraResolution; back?: CameraResolution };
  props: DeviceIdentity;
  /** The emulated phone number (telephony), optional. Stored beside config.ini, passed as -phone-number. */
  telephone?: string;
}

/** Is this exact SDK package already unpacked in the local SDK? */
/**
 * ABIs this computer can actually run. The emulator only executes an image
 * built for the host architecture: an arm64-v8a image on a normal Windows PC
 * is rejected by avdmanager ("Package path is not valid") and could not boot
 * even if it were accepted.
 */
export function hostAbis(): AndroidAbi[] {
  // The desktop product and Android accelerator are supported on Windows x64.
  return ['x86_64', 'x86'];
}

/** Can this machine run the image, or is it built for another architecture? */
export function imageRunsHere(abi: string): boolean {
  return hostAbis().includes(abi as AndroidAbi);
}

/** Every SDK folder we know about, the writable install root first. */
function knownRoots(): string[] {
  return [...new Set([androidInstallRoot(), ...roots()].filter(Boolean))];
}

/** The SDK folder that actually contains this package, or '' when none does. */
export function rootForPackage(packageName: string): string {
  if (!/^[A-Za-z0-9;._-]{3,120}$/.test(packageName)) return '';
  return knownRoots().find((root) => {
    const dir = path.join(root, ...packageName.split(';'));
    return ['package.xml', 'source.properties'].some((file) => fs.existsSync(path.join(dir, file)));
  }) ?? '';
}

export function androidPackageInstalled(packageName: string): boolean {
  if (!/^[A-Za-z0-9;._-]{3,120}$/.test(packageName)) return false;
  // sdkmanager writes package.xml, the new CLI may only leave
  // source.properties - either one means the package is there.
  return !!rootForPackage(packageName);
}

export async function installAndroidPackage(packageName: string): Promise<void> {
  await installPackage(packageName, 60 * 60_000);
}

/**
 * Create an AVD straight from a catalogue specification. The device gets the
 * same screen, RAM and media wiring that the catalogue describes for the handset.
 */
export async function createAndroidAvdFromSpec(input: SpecCreateInput): Promise<{
  path: string; companion: boolean; cameraFront: CameraSource; cameraBack: CameraSource;
  cameraFrontDevice: string; cameraBackDevice: string;
  /** True when this call created the device; false when it updated an existing one. */
  created: boolean;
}> {
  const tools = sdk();
  if (!tools.avdmanager) throw new Error('Android SDK AVD Manager not found');
  const name = assertName(input.name);
  const telephone = String(input.telephone ?? '').trim();
  // Checked before anything is created, so a bad number leaves no half-made device.
  if (telephone && !validTelephoneNumber(telephone)) throw new Error('The telephony number must be 3 to 15 digits, with an optional leading +.');
  if (!androidPackageInstalled(input.systemPackage)) throw new Error('Selected Android system image is not installed');
  const directory = input.installDirectory.trim() || defaultAvdDirectory();
  if (!ABSOLUTE(directory)) throw new Error('Choose an absolute Android virtual device folder');
  const intendedPath = path.join(directory, `${name}.avd`);
  // Reconcile name, folder, and a valid <name>.ini pointer before calling
  // avdmanager. Its raw "already exists; use --force" advice is destructive;
  // Octo instead updates config.ini in place and preserves userdata-qemu.img.
  const listed = await listAndroidAvds();
  const existing = listed.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    ?? (fs.existsSync(path.join(intendedPath, 'config.ini')) ? { name, path: intendedPath, target: '' } : undefined);
  const avdPath = existing?.path ?? intendedPath;
  const creating = !existing;
  if (creating && fs.existsSync(avdPath)) {
    throw new Error('That device folder already contains unrelated files. Choose a unique device name or explicitly delete the conflicting folder first. No data was changed.');
  }
  const api = Number.parseInt(input.systemPackage.split(';')[1]?.replace('android-', '') ?? '', 10) || 0;
  if (creating) {
    const disk = androidDiskInfo(directory);
    const needed = input.dataGb * 1_000_000_000 + input.sdCardMb * 1_000_000;
    if (disk.totalBytes && disk.freeBytes < needed) throw new Error('Not enough free disk space in the selected folder');
    fs.mkdirSync(directory, { recursive: true });
    await runAvdCreate(['create', 'avd', '--name', name, '--package', input.systemPackage,
      '--path', avdPath, '--device', input.baseDevice], api, input.systemPackage);
  }
  // Existing storage can grow but is never shrunk. Shrinking either image can
  // discard guest files even when avdmanager itself is not called.
  const previousDataGb = Number.parseInt(configValue(avdPath, 'disk.dataPartition.size'), 10) || 0;
  const previousSdCardMb = Number.parseInt(configValue(avdPath, 'sdcard.size'), 10) || 0;
  const safeDataGb = creating ? input.dataGb : Math.max(input.dataGb, previousDataGb);
  const safeSdCardMb = creating ? input.sdCardMb : Math.max(input.sdCardMb, previousSdCardMb);
  const webcams = await emulatorWebcams();
  const resolvedCameras = resolveActiveCameraAssignments(
    input.cameraFront, input.cameraBack, input.cameraFrontDevice ?? '', input.cameraBackDevice ?? '', webcams,
    [], input.cameraDevice ?? '',
  );
  writeConfigValues(avdPath, {
    ...mediaConfig(resolvedCameras.front, resolvedCameras.back, input.microphoneEnabled,
      resolvedCameras.frontDevice, resolvedCameras.backDevice, cameraLimitsFor(avdPath, input.cameraLimits)),
    'hw.ramSize': String(input.ramMb),
    [['vm', 'heapSize'].join('.')]: String(input.heapMb),
    'hw.cpu.ncore': String(input.cores),
    'disk.dataPartition.size': `${safeDataGb}G`,
    'sdcard.size': safeSdCardMb > 0 ? `${safeSdCardMb}M` : '0',
    'hw.gpu.enabled': input.gpuMode === 'off' ? 'no' : 'yes',
    'hw.gpu.mode': input.gpuMode,
    'fastboot.forceColdBoot': input.bootMode === 'cold' ? 'yes' : 'no',
    'snapshot.present': input.snapshots ? 'yes' : 'no',
    'hw.keyboard': 'yes',
    'hw.gps': 'yes',
    'hw.sensors.orientation': 'yes',
    'hw.sensors.proximity': 'yes',
    'hw.battery': 'yes',
    'octobrowser.deviceLabel': input.label || input.props.marketName || input.props.model,
    'octobrowser.buildBrand': input.props.brand,
    'octobrowser.buildManufacturer': input.props.manufacturer,
    'octobrowser.buildModel': input.props.model,
    'octobrowser.buildDevice': input.props.device,
    'octobrowser.buildProduct': input.props.product,
    'octobrowser.marketName': input.props.marketName || input.label || input.props.model,
    'octobrowser.mac': input.props.mac ?? '',
    'octobrowser.imei': input.props.imei ?? '',
    'octobrowser.androidId': input.props.androidId ?? '',
    'octobrowser.serialNumber': input.props.serialNumber ?? '',
    'octobrowser.phoneNumber': input.props.phoneNumber ?? '',
    'octobrowser.operator': input.props.operator ?? '',
    'octobrowser.simOperator': input.props.simOperator ?? '',
    'octobrowser.simCountry': input.props.simCountry ?? '',
    'octobrowser.identityApplied': '',
    'octobrowser.telephony': telephone,
  });
  rememberAvdDirectory(path.dirname(avdPath));
  writeAvdPointer(name, avdPath, api);
  return {
    path: avdPath, companion: false, created: creating,
    cameraFront: resolvedCameras.front, cameraBack: resolvedCameras.back,
    cameraFrontDevice: resolvedCameras.frontDevice, cameraBackDevice: resolvedCameras.backDevice,
  };
}

export interface AvdSettingsInput {
  ramMb?: number; heapMb?: number; cores?: number; dataGb?: number; sdCardMb?: number;
  gpuMode?: GpuMode; bootMode?: BootMode; snapshots?: boolean; keyboard?: boolean; gps?: boolean;
  cameraFront?: CameraSource; cameraBack?: CameraSource; microphoneEnabled?: boolean;
  cameraFrontDevice?: string; cameraBackDevice?: string;
  cameraDevice?: string;
  /** Resolution measured while testing a host camera, per facing. */
  cameraLimits?: { front?: CameraResolution; back?: CameraResolution };
  networkSpeed?: NetworkSpeed; locale?: string; timezone?: string;
  brand?: string;
  manufacturer?: string;
  model?: string;
  marketName?: string;
  device?: string;
  product?: string;
  mac?: string;
  imei?: string;
  androidId?: string;
  serialNumber?: string;
  phoneNumber?: string;
  operator?: string;
  simOperator?: string;
  simCountry?: string;
}

/**
 * Change an existing AVD. Only the keys the user actually touched are written,
 * so nothing else in config.ini is rewritten behind their back. The data
 * partition can be grown but never shrunk - shrinking it would throw away the
 * device's files.
 */
export async function updateAvdSettings(name: string, input: AvdSettingsInput): Promise<string[]> {
  const clean = assertName(name);
  const avd = (await listAndroidAvds()).find((item) => item.name === clean);
  if (!avd) throw new Error('Android virtual device not found');
  if (avd.running) throw new Error('Stop the Android device before changing its settings');
  const values: Record<string, string> = {};
  const changed: string[] = [];
  let savedMedia: {
    front: CameraSource; back: CameraSource; microphone: boolean; cameraDevice: string;
    cameraFrontDevice: string; cameraBackDevice: string;
  } | undefined;
  const set = (key: string, value: string, label: string) => { values[key] = value; changed.push(label); };
  if (input.brand) set('octobrowser.buildBrand', input.brand, 'brand');
  if (input.manufacturer) set('octobrowser.buildManufacturer', input.manufacturer, 'manufacturer');
  if (input.model) {
    set('octobrowser.buildModel', input.model, 'model');
    set('octobrowser.marketName', input.marketName || input.model, 'marketName');
    set('octobrowser.deviceLabel', input.marketName || input.model, 'deviceLabel');
  }
  if (input.device) set('octobrowser.buildDevice', input.device, 'device');
  if (input.product) set('octobrowser.buildProduct', input.product, 'product');
  if (input.mac !== undefined) set('octobrowser.mac', input.mac, 'mac');
  if (input.imei !== undefined) set('octobrowser.imei', input.imei, 'imei');
  if (input.androidId !== undefined) set('octobrowser.androidId', input.androidId, 'androidId');
  if (input.serialNumber !== undefined) set('octobrowser.serialNumber', input.serialNumber, 'serialNumber');
  if (input.phoneNumber !== undefined) set('octobrowser.phoneNumber', input.phoneNumber, 'phoneNumber');
  if (input.operator !== undefined) set('octobrowser.operator', input.operator, 'operator');
  if (input.simOperator !== undefined) set('octobrowser.simOperator', input.simOperator, 'simOperator');
  if (input.simCountry !== undefined) set('octobrowser.simCountry', input.simCountry, 'simCountry');
  if (['brand', 'manufacturer', 'model', 'marketName', 'device', 'product', 'mac', 'imei', 'androidId', 'serialNumber', 'phoneNumber', 'operator', 'simOperator', 'simCountry']
    .some((key) => input[key as keyof AvdSettingsInput] !== undefined)) {
    values['octobrowser.identityApplied'] = '';
    if (!changed.includes('identityVerification')) changed.push('identityVerification');
  }
  if (input.ramMb) {
    if (input.ramMb < 512 || input.ramMb > 65536) throw new Error('RAM must be between 512 and 65536 MB');
    set('hw.ramSize', String(Math.round(input.ramMb)), 'ram');
  }
  if (input.heapMb) set([['vm', 'heapSize'].join('.')][0], String(Math.round(input.heapMb)), 'heap');
  if (input.cores) {
    if (input.cores < 1 || input.cores > 16) throw new Error('CPU count must be between 1 and 16');
    set('hw.cpu.ncore', String(Math.round(input.cores)), 'cores');
  }
  if (input.dataGb) {
    const current = Number.parseInt(avd.dataPartition, 10) || 0;
    if (current && input.dataGb < current) throw new Error('The data partition can be enlarged but not shrunk');
    set('disk.dataPartition.size', `${Math.round(input.dataGb)}G`, 'data');
  }
  if (typeof input.sdCardMb === 'number') set('sdcard.size', input.sdCardMb > 0 ? `${Math.round(input.sdCardMb)}M` : '0', 'sdcard');
  if (input.gpuMode) {
    set('hw.gpu.enabled', input.gpuMode === 'off' ? 'no' : 'yes', 'gpu');
    values['hw.gpu.mode'] = input.gpuMode;
  }
  if (input.bootMode) set('fastboot.forceColdBoot', input.bootMode === 'cold' ? 'yes' : 'no', 'boot');
  if (typeof input.snapshots === 'boolean') set('snapshot.present', input.snapshots ? 'yes' : 'no', 'snapshots');
  if (typeof input.keyboard === 'boolean') set('hw.keyboard', input.keyboard ? 'yes' : 'no', 'keyboard');
  if (typeof input.gps === 'boolean') set('hw.gps', input.gps ? 'yes' : 'no', 'gps');
  if (input.networkSpeed) set('runtime.network.speed', input.networkSpeed, 'network');
  if (input.locale) set('octobrowser.locale', input.locale.slice(0, 32), 'locale');
  if (input.timezone) set('octobrowser.timezone', input.timezone.slice(0, 64), 'timezone');
  if (input.cameraFront || input.cameraBack || typeof input.microphoneEnabled === 'boolean' || input.cameraDevice || input.cameraFrontDevice || input.cameraBackDevice) {
    const selected = normalizeCameraSources(input.cameraFront ?? avd.cameraFront, input.cameraBack ?? avd.cameraBack);
    const microphone = input.microphoneEnabled ?? avd.microphoneEnabled;
    const webcams = await emulatorWebcams();
    const assignments = resolveActiveCameraAssignments(
      selected.front, selected.back,
      input.cameraFrontDevice ?? avd.cameraFrontDevice,
      input.cameraBackDevice ?? avd.cameraBackDevice,
      webcams,
      [],
      input.cameraDevice ?? avd.cameraDevice,
    );
    Object.assign(values, mediaConfig(assignments.front, assignments.back, microphone,
      assignments.frontDevice, assignments.backDevice, cameraLimitsFor(avd.path, input.cameraLimits)));
    savedMedia = {
      front: assignments.front, back: assignments.back, microphone,
      cameraFrontDevice: assignments.frontDevice, cameraBackDevice: assignments.backDevice,
      cameraDevice: assignments.backDevice || assignments.frontDevice,
    };
    changed.push('media');
  }
  if (!changed.length) return [];
  writeConfigValues(avd.path, values);
  if (savedMedia) {
    // Device Settings and the launch dialog share one source of truth. Without
    // this update, old launch preferences overrode a just-saved slot choice.
    rememberAndroidLaunch(clean, {
      cameraFront: savedMedia.front,
      cameraBack: savedMedia.back,
      cameraFrontDevice: savedMedia.cameraFrontDevice,
      cameraBackDevice: savedMedia.cameraBackDevice,
      cameraDevice: savedMedia.cameraDevice,
      microphoneEnabled: savedMedia.microphone,
    });
  }
  return changed;
}
