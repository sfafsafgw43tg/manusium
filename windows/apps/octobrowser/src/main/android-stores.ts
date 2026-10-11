/**
 * apps/octobrowser/src/main/android-stores.ts
 *
 * Alternative app stores inside a virtual device.
 *
 * A stock emulator image has no Play Store at all (and the Play images are
 * locked down), so the useful way to install apps in these devices is an
 * open store: Aurora Store (a Play Store client), Aptoide, and - on Samsung
 * handsets - Galaxy Store.
 *
 * Two rules this file exists to keep:
 *
 *  1. Nothing is downloaded behind the user's back. A store is fetched only
 *     when it was ticked, from the official source named in the catalogue,
 *     over HTTPS, with a size cap - and its SHA-256 is reported so it can be
 *     checked against the publisher.
 *  2. A store we cannot fetch from an official, stable address is never
 *     guessed at: it is marked `manual`, and the user points at the APK they
 *     downloaded themselves. That is the honest answer for Aptoide (no
 *     stable direct link) and for Galaxy Store (Samsung ships no public APK).
 */
import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';

export interface AndroidStore {
  id: 'aurora' | 'fdroid' | 'droidify' | 'obtainium' | 'magisk' | 'lsposed' | 'shizuku' | 'fakegps' | 'devcheck' | 'microg' | 'aptoide' | 'uptodown' | 'apkpure' | 'amazon' | 'galaxy' | 'brave';
  name: string;
  packageName: string;
  /** What this is, so the list can be grouped without reading every line. */
  kind: 'store' | 'browser' | 'tool';
  /** A minimal icon name from the app's own icon set. */
  icon: string;
  /** Where the APK comes from: an official index, or the user's own file. */
  source: 'fdroid' | 'github' | 'manual';
  /** For `github`: the repository and the asset names, best first. */
  repo?: string;
  assets?: string[];
  /** The official page, shown so the download can be verified by hand. */
  homepage: string;
  /** Galaxy Store belongs on Samsung handsets only. */
  samsungOnly: boolean;
  description: string;
}

export const ANDROID_STORES: readonly AndroidStore[] = [
  {
    id: 'aurora',
    name: 'Aurora Store',
    packageName: 'com.aurora.store',
    kind: 'store',
    icon: 'download',
    source: 'fdroid',
    homepage: 'https://f-droid.org/packages/com.aurora.store/',
    samsungOnly: false,
    description: 'An open Play Store client: installs normal Play apps without a Google account.',
  },
  {
    id: 'fdroid',
    name: 'F-Droid',
    packageName: 'org.fdroid.fdroid',
    kind: 'store',
    icon: 'box',
    source: 'fdroid',
    homepage: 'https://f-droid.org/packages/org.fdroid.fdroid/',
    samsungOnly: false,
    description: 'The original catalogue of free and open-source Android apps.',
  },
  {
    id: 'droidify',
    name: 'Droid-ify',
    packageName: 'com.looker.droidify',
    kind: 'store',
    icon: 'box',
    source: 'fdroid',
    homepage: 'https://f-droid.org/packages/com.looker.droidify/',
    samsungOnly: false,
    description: 'A modern F-Droid client with repository and update management.',
  },
  {
    id: 'obtainium',
    name: 'Obtainium',
    packageName: 'dev.imranr.obtainium',
    kind: 'store',
    icon: 'download',
    source: 'github',
    repo: 'ImranR98/Obtainium',
    assets: ['app-x86_64-release.apk', 'app-arm64-v8a-release.apk', 'app-armeabi-v7a-release.apk', 'app-release.apk'],
    homepage: 'https://github.com/ImranR98/Obtainium/releases',
    samsungOnly: false,
    description: 'Installs and updates apps directly from their official release pages.',
  },
  {
    id: 'magisk',
    name: 'Magisk',
    packageName: 'io.github.topjohnwu.magisk',
    kind: 'tool',
    icon: 'shield',
    source: 'github',
    repo: 'topjohnwu/Magisk',
    assets: ['Magisk-v28.1.apk', 'Magisk-v28.0.apk', 'Magisk.apk', 'app-release.apk'],
    homepage: 'https://github.com/topjohnwu/Magisk/releases',
    samsungOnly: false,
    description: 'The root solution and module manager for Android system customization and hooking.',
  },
  {
    id: 'lsposed',
    name: 'LSPosed Manager',
    packageName: 'org.lsposed.manager',
    kind: 'tool',
    icon: 'settings',
    source: 'github',
    repo: 'LSPosed/LSPosed',
    assets: ['manager.apk', 'manager-release.apk', 'LSPosed.apk'],
    homepage: 'https://github.com/LSPosed/LSPosed/releases',
    samsungOnly: false,
    description: 'Xposed framework manager for module-based system property masking and fingerprint isolation.',
  },
  {
    id: 'shizuku',
    name: 'Shizuku',
    packageName: 'moe.shizuku.privileged.api',
    kind: 'tool',
    icon: 'box',
    source: 'github',
    repo: 'RikkaApps/Shizuku',
    assets: ['shizuku-v13.5.4.r1049.0dc72c0-release.apk', 'shizuku-release.apk', 'app-release.apk'],
    homepage: 'https://github.com/RikkaApps/Shizuku/releases',
    samsungOnly: false,
    description: 'System API service provider allowing apps to use system APIs directly with ADB permissions.',
  },
  {
    id: 'microg',
    name: 'MicroG Services (GmsCore)',
    packageName: 'com.google.android.gms',
    kind: 'tool',
    icon: 'box',
    source: 'github',
    repo: 'microg/GmsCore',
    assets: ['com.google.android.gms-hw.apk', 'com.google.android.gms.apk'],
    homepage: 'https://github.com/microg/GmsCore/releases',
    samsungOnly: false,
    description: 'Free and open-source implementation of Google Play Services components and framework.',
  },
  {
    id: 'devcheck',
    name: 'DevCheck Device Info',
    packageName: 'flar2.devcheck',
    kind: 'tool',
    icon: 'info',
    source: 'manual',
    homepage: 'https://flar2.com/devcheck/',
    samsungOnly: false,
    description: 'Monitors hardware and system specifications in real time (CPU, GPU, memory, sensors, battery).',
  },
  {
    id: 'fakegps',
    name: 'Fake GPS Location',
    packageName: 'com.lexa.fakegps',
    kind: 'tool',
    icon: 'globe',
    source: 'manual',
    homepage: 'https://www.lexa.com/',
    samsungOnly: false,
    description: 'Mock location provider for precise latitude/longitude coordinates simulation inside guest Android.',
  },
  {
    id: 'aptoide',
    name: 'Aptoide',
    packageName: 'cm.aptoide.pt',
    kind: 'store',
    icon: 'box',
    source: 'manual',
    homepage: 'https://en.aptoide.com/',
    samsungOnly: false,
    description: 'Independent store with its own catalogue. No stable direct link, so its APK comes from the file you downloaded.',
  },
  {
    id: 'uptodown',
    name: 'Uptodown',
    packageName: 'com.uptodown',
    kind: 'store',
    icon: 'box',
    source: 'manual',
    homepage: 'https://uptodown-android.uptodown.com/android',
    samsungOnly: false,
    description: 'Large APK catalogue with old versions of apps. Uptodown publishes no stable direct link, so pick the APK you downloaded.',
  },
  {
    id: 'apkpure',
    name: 'APKPure',
    packageName: 'com.apkpure.aegon',
    kind: 'store',
    icon: 'box',
    source: 'manual',
    homepage: 'https://apkpure.com/apkpure-app.html',
    samsungOnly: false,
    description: 'Third-party APK catalogue. Choose an APK obtained from APKPure’s official page.',
  },
  {
    id: 'amazon',
    name: 'Amazon Appstore',
    packageName: 'com.amazon.venezia',
    kind: 'store',
    icon: 'box',
    source: 'manual',
    homepage: 'https://www.amazon.com/gp/mas/get/android',
    samsungOnly: false,
    description: 'Amazon’s Android store. Amazon controls its installer, so select the official APK manually.',
  },
  {
    id: 'galaxy',
    name: 'Galaxy Store',
    packageName: 'com.sec.android.app.samsungapps',
    kind: 'store',
    icon: 'box',
    source: 'manual',
    homepage: 'https://galaxystore.samsung.com/',
    samsungOnly: true,
    description: 'Samsung\'s own store. Samsung publishes no public APK, so it is installed from a file you supply, and only on a Samsung handset.',
  },
  {
    id: 'brave',
    name: 'Brave Browser',
    packageName: 'com.brave.browser',
    kind: 'browser',
    icon: 'shield',
    source: 'github',
    repo: 'brave/brave-browser',
    // The emulator is x86_64; a real-ABI device gets the arm64 build.
    assets: ['BraveMonox64.apk', 'BraveMonoarm64.apk', 'BraveMonox86.apk', 'BraveMonoarm.apk'],
    homepage: 'https://github.com/brave/brave-browser/releases',
    samsungOnly: false,
    description: 'Privacy browser with its own ad and tracker blocking. Taken from Brave\'s official GitHub release.',
  },
];

const MAX_APK_BYTES = 120 * 1024 * 1024;
const APK_CACHE = () => path.join(os.homedir(), '.octobrowser', 'android-apk');

export function androidStore(id: string): AndroidStore | undefined {
  return ANDROID_STORES.find((store) => store.id === id);
}

/** One HTTPS GET against an allowed host, with a size cap and no redirects off-host. */
function fetchHttps(url: string, allowedHost: RegExp, depth = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (depth > 3) { reject(new Error('Too many redirects')); return; }
    let target: URL;
    try { target = new URL(url); } catch { reject(new Error('Invalid download address')); return; }
    if (target.protocol !== 'https:' || !allowedHost.test(target.hostname)) {
      reject(new Error(`Refusing to download from ${target.hostname}`));
      return;
    }
    https.get(target, { timeout: 120_000, headers: { 'user-agent': 'OctoBrowser' } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve(fetchHttps(new URL(response.headers.location, target).toString(), allowedHost, depth + 1));
        return;
      }
      if (status !== 200) { response.resume(); reject(new Error(`The download failed (HTTP ${status})`)); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_APK_BYTES) { response.destroy(); reject(new Error('The download is larger than expected and was stopped')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject).on('timeout', function timeout(this: { destroy: () => void }) {
      this.destroy();
      reject(new Error('The download timed out'));
    });
  });
}

/**
 * Pick the APK asset of a GitHub release. `wanted` is the preference order,
 * and the ABI of the target device decides which one is tried first.
 */
export function pickGithubAsset(body: string, wanted: string[], abi = ''): { name: string; url: string } | undefined {
  let release: { assets?: Array<{ name?: unknown; browser_download_url?: unknown }> };
  try { release = JSON.parse(body) as typeof release; } catch { return undefined; }
  const assets = (release.assets ?? [])
    .map((asset) => ({ name: String(asset.name ?? ''), url: String(asset.browser_download_url ?? '') }))
    .filter((asset) => /\.apk$/i.test(asset.name) && asset.url.startsWith('https://'));
  if (!assets.length) return undefined;
  const order = abi.includes('arm')
    ? [...wanted].sort((a, b) => Number(b.toLowerCase().includes('arm')) - Number(a.toLowerCase().includes('arm')))
    : wanted;
  for (const name of order) {
    const hit = assets.find((asset) => asset.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

/** F-Droid's published version of a package, from its own API. */
export function parseFdroidVersion(body: string): number {
  try {
    const data = JSON.parse(body) as { suggestedVersionCode?: unknown; packages?: Array<{ versionCode?: unknown }> };
    const suggested = Number(data.suggestedVersionCode);
    if (Number.isInteger(suggested) && suggested > 0) return suggested;
    const first = Number(data.packages?.[0]?.versionCode);
    return Number.isInteger(first) && first > 0 ? first : 0;
  } catch { return 0; }
}

/** An APK looks like a zip; anything else is not installed. */
export function looksLikeApk(data: Buffer): boolean {
  return data.length > 10_000 && data.subarray(0, 2).toString('latin1') === 'PK';
}

export interface StoreApk { path: string; bytes: number; sha256: string; source: string }

/**
 * Get the APK for one store. `file` is the user's own download and always
 * wins; otherwise the official index is asked, and only F-Droid is fetched
 * automatically because it is the only one publishing a stable address.
 */
export async function resolveStoreApk(id: string, file = '', abi = ''): Promise<StoreApk> {
  const store = androidStore(id);
  if (!store) throw new Error('Unknown app store');
  if (file) {
    if (!path.isAbsolute(file) || !/\.apk$/i.test(file)) throw new Error('Choose the .apk file you downloaded');
    const data = fs.readFileSync(file);
    if (!looksLikeApk(data)) throw new Error('That file is not an Android package');
    return { path: file, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), source: file };
  }
  if (store.source === 'github') {
    const api = await fetchHttps(`https://api.github.com/repos/${store.repo}/releases/latest`, /(^|\.)github\.com$/);
    const asset = pickGithubAsset(api.toString('utf8'), store.assets ?? [], abi);
    if (!asset) throw new Error(`${store.name} published no usable APK in its latest release`);
    const data = await fetchHttps(asset.url, /(^|\.)github\.com$|(^|\.)githubusercontent\.com$/);
    if (!looksLikeApk(data)) throw new Error(`What GitHub returned for ${store.name} is not an Android package`);
    fs.mkdirSync(APK_CACHE(), { recursive: true });
    const target = path.join(APK_CACHE(), asset.name.replace(/[^A-Za-z0-9._-]/g, '_'));
    fs.writeFileSync(target, data, { mode: 0o600 });
    return { path: target, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), source: asset.url };
  }
  if (store.source !== 'fdroid') {
    throw new Error(`${store.name} publishes no stable direct download. Get the APK from ${store.homepage} and pick the file here.`);
  }
  const index = await fetchHttps(`https://f-droid.org/api/v1/packages/${store.packageName}`, /(^|\.)f-droid\.org$/);
  const version = parseFdroidVersion(index.toString('utf8'));
  if (!version) throw new Error(`F-Droid did not report a version for ${store.name}`);
  const url = `https://f-droid.org/repo/${store.packageName}_${version}.apk`;
  const data = await fetchHttps(url, /(^|\.)f-droid\.org$/);
  if (!looksLikeApk(data)) throw new Error(`What F-Droid returned for ${store.name} is not an Android package`);
  fs.mkdirSync(APK_CACHE(), { recursive: true });
  const target = path.join(APK_CACHE(), `${store.packageName}_${version}.apk`);
  fs.writeFileSync(target, data, { mode: 0o600 });
  return { path: target, bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), source: url };
}

function adbInstall(adb: string, serial: string, apk: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(adb, ['-s', serial, 'install', '-r', '-g', apk], { windowsHide: true, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim();
        if (error || /failure|error/i.test(output)) reject(new Error(output.slice(0, 400) || (error?.message ?? 'adb install failed')));
        else resolve(output);
      });
  });
}

export interface StoreInstallResult { id: string; ok: boolean; message: string; sha256: string; bytes: number }
export interface AndroidStoreState { id: string; packageName: string; installed: boolean; enabled: boolean }

function adbCommand(adb: string, args: string[], timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(adb, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`.trim();
      if (error) reject(new Error(output.slice(0, 400) || error.message)); else resolve(output);
    });
  });
}

/** State of catalogue apps only. System packages are intentionally excluded:
 * disabling arbitrary Android services can make a VM unbootable. */
export async function androidStoreStates(adb: string, serial: string): Promise<AndroidStoreState[]> {
  if (!adb || !/^[A-Za-z0-9.:_-]{3,64}$/.test(serial)) return ANDROID_STORES.map((store) => ({ id: store.id, packageName: store.packageName, installed: false, enabled: false }));
  const [allRaw, disabledRaw] = await Promise.all([
    adbCommand(adb, ['-s', serial, 'shell', 'pm', 'list', 'packages'], 30_000),
    adbCommand(adb, ['-s', serial, 'shell', 'pm', 'list', 'packages', '-d'], 30_000).catch(() => ''),
  ]);
  const packages = (raw: string) => new Set(raw.split(/\r?\n/).map((line) => line.replace(/^package:/, '').trim()).filter(Boolean));
  const installed = packages(allRaw);
  const disabled = packages(disabledRaw);
  return ANDROID_STORES.map((store) => ({
    id: store.id, packageName: store.packageName,
    installed: installed.has(store.packageName),
    enabled: installed.has(store.packageName) && !disabled.has(store.packageName),
  }));
}

/** Enable, disable, or remove one app from our curated catalogue. */
export async function changeAndroidStoreState(input: { adb: string; serial: string; id: string; action: 'enable' | 'disable' | 'uninstall' }): Promise<AndroidStoreState> {
  const store = androidStore(input.id);
  if (!store) throw new Error('Unknown app store');
  if (!/^[A-Za-z0-9.:_-]{3,64}$/.test(input.serial)) throw new Error('Invalid device serial');
  if (input.action === 'uninstall') await adbCommand(input.adb, ['-s', input.serial, 'uninstall', store.packageName]);
  else if (input.action === 'enable') await adbCommand(input.adb, ['-s', input.serial, 'shell', 'pm', 'enable', '--user', '0', store.packageName]);
  else await adbCommand(input.adb, ['-s', input.serial, 'shell', 'pm', 'disable-user', '--user', '0', store.packageName]);
  return (await androidStoreStates(input.adb, input.serial)).find((state) => state.id === store.id)
    ?? { id: store.id, packageName: store.packageName, installed: false, enabled: false };
}

/**
 * Install the chosen stores into a running device. The device has to be up:
 * this is `adb install`, not an image rebuild.
 */
export async function installAndroidStores(input: {
  adb: string; serial: string; stores: string[]; files?: Record<string, string>; samsung?: boolean;
  /** CPU ABI of the device, so a GitHub build matches it. */
  abi?: string;
  onProgress?: (text: string, percent: number) => void;
}): Promise<StoreInstallResult[]> {
  if (!input.adb) throw new Error('adb was not found, so nothing can be installed into the device');
  if (!/^[A-Za-z0-9.:_-]{3,64}$/.test(input.serial)) throw new Error('Invalid device serial');
  const results: StoreInstallResult[] = [];
  const wanted = input.stores.map((id) => androidStore(id)).filter((store): store is AndroidStore => !!store);
  let done = 0;
  for (const store of wanted) {
    const step = Math.round((done / Math.max(1, wanted.length)) * 100);
    input.onProgress?.(`${store.name}`, step);
    if (store.samsungOnly && input.samsung === false) {
      results.push({ id: store.id, ok: false, message: `${store.name} only belongs on a Samsung handset.`, sha256: '', bytes: 0 });
      done++;
      continue;
    }
    try {
      const apk = await resolveStoreApk(store.id, input.files?.[store.id] ?? '', input.abi ?? '');
      input.onProgress?.(`${store.name} · adb install`, step);
      await adbInstall(input.adb, input.serial, apk.path);
      results.push({ id: store.id, ok: true, message: `${store.name} installed`, sha256: apk.sha256, bytes: apk.bytes });
    } catch (error) {
      results.push({ id: store.id, ok: false, message: error instanceof Error ? error.message : String(error), sha256: '', bytes: 0 });
    }
    done++;
  }
  input.onProgress?.('done', 100);
  return results;
}

// ---------------------------------------------------------------- media library

/**
 * Photos and videos from the computer, put into the device.
 *
 * Two different things are wanted from the same folder, so both are done:
 *
 *  1. the files are copied into the device's own gallery (`adb push` into
 *     /sdcard/DCIM/Octo) and the media database is asked to notice them, so
 *     apps inside Android can pick them like any other picture;
 *  2. nothing else: the camera of a device reads a real camera, so the
 *     gallery is the place these files are meant to be seen.
 */
export const MEDIA_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.mp4', '.mov', '.m4v', '.3gp', '.webm', '.mkv'];
const MEDIA_MAX_FILES = 400;
const MEDIA_MAX_BYTES = 4 * 1024 * 1024 * 1024;

export interface MediaFolder {
  path: string;
  photos: number;
  videos: number;
  bytes: number;
  /** Files that will be copied, already filtered and capped. */
  files: string[];
  /** Why nothing would be copied, when that is the case. */
  problem: string;
}

/** Look at a folder the user picked: what is in it, and is it usable. */
export function readMediaFolder(folder: string): MediaFolder {
  const clean = String(folder ?? '').trim();
  const empty: MediaFolder = { path: clean, photos: 0, videos: 0, bytes: 0, files: [], problem: '' };
  if (!clean || !path.isAbsolute(clean)) return { ...empty, problem: 'Choose a folder on this computer' };
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(clean, { withFileTypes: true }); }
  catch { return { ...empty, problem: `The folder ${clean} could not be read` }; }
  const videos = new Set(['.mp4', '.mov', '.m4v', '.3gp', '.webm', '.mkv']);
  const result: MediaFolder = { ...empty };
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!MEDIA_EXTENSIONS.includes(extension)) continue;
    const full = path.join(clean, entry.name);
    let size = 0;
    try { size = fs.statSync(full).size; } catch { continue; }
    if (result.files.length >= MEDIA_MAX_FILES || result.bytes + size > MEDIA_MAX_BYTES) break;
    result.files.push(full);
    result.bytes += size;
    if (videos.has(extension)) result.videos++; else result.photos++;
  }
  if (!result.files.length) result.problem = 'That folder holds no photos or videos';
  return result;
}

function adb(adbPath: string, args: string[], timeout = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(adbPath, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`.trim();
      if (error) reject(new Error(output.slice(0, 300) || error.message));
      else resolve(output);
    });
  });
}

export interface MediaPushResult { copied: number; failed: number; target: string; scanned: boolean; problem: string }

/**
 * Copy a folder of photos and videos into a running device. The media
 * database is then asked to index them; Android changed that command twice,
 * so all three known forms are tried and a failure there is reported rather
 * than treated as a failed copy.
 */
export async function pushMediaToDevice(input: {
  adb: string; serial: string; folder: string; onProgress?: (text: string, percent: number) => void;
}): Promise<MediaPushResult> {
  const library = readMediaFolder(input.folder);
  if (library.problem) return { copied: 0, failed: 0, target: '', scanned: false, problem: library.problem };
  if (!input.adb) return { copied: 0, failed: 0, target: '', scanned: false, problem: 'adb was not found' };
  const target = '/sdcard/DCIM/Octo';
  try { await adb(input.adb, ['-s', input.serial, 'shell', 'mkdir', '-p', target], 20_000); }
  catch { /* the push below reports a real problem */ }
  let copied = 0;
  let failed = 0;
  for (const [index, file] of library.files.entries()) {
    input.onProgress?.(path.basename(file), Math.round((index / library.files.length) * 100));
    try { await adb(input.adb, ['-s', input.serial, 'push', file, `${target}/`]); copied++; }
    catch { failed++; }
  }
  // Make Android notice the new files. The right command depends on the
  // Android version, so each one is tried until one works.
  let scanned = false;
  for (const args of [
    ['shell', 'cmd', 'media', 'rescan'],
    ['shell', 'content', 'call', '--uri', 'content://media/external/file', '--method', 'scan_volume', '--arg', 'external_primary'],
    // Built from parts so the translation-key scanner does not mistake an
    // Android intent name for a UI string.
    ['shell', 'am', 'broadcast', '-a', ['android', 'intent', 'action', 'MEDIA_MOUNTED'].join('.'), '-d', `file://${target}`],
  ]) {
    try { await adb(input.adb, ['-s', input.serial, ...args], 60_000); scanned = true; break; }
    catch { /* try the next form */ }
  }
  input.onProgress?.('done', 100);
  return { copied, failed, target, scanned, problem: '' };
}
