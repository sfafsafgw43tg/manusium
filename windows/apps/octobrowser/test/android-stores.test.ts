/**
 * App stores inside a device. Nothing may be downloaded from an address we
 * only guessed at, and nothing that is not an Android package may reach adb.
 */
import { describe, expect, it } from 'vitest';
import { ANDROID_STORES, MEDIA_EXTENSIONS, androidStore, androidStoreStates, looksLikeApk, parseFdroidVersion, pickGithubAsset, readMediaFolder, resolveStoreApk } from '../src/main/android-stores';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('alternative app stores', () => {
  it('names an official source for every store, and marks the Samsung one', () => {
    expect(ANDROID_STORES.map((store) => store.id).sort()).toEqual([
      'amazon', 'apkpure', 'aptoide', 'aurora', 'brave', 'devcheck', 'droidify', 'fakegps', 'fdroid', 'galaxy', 'lsposed', 'magisk', 'microg', 'obtainium', 'shizuku', 'uptodown',
    ].sort());
    for (const store of ANDROID_STORES) {
      expect(store.homepage.startsWith('https://')).toBe(true);
      expect(store.packageName).toMatch(/^[a-z][a-z0-9_.]+$/);
      expect(['fdroid', 'github', 'manual']).toContain(store.source);
    }
    expect(androidStore('galaxy')?.samsungOnly).toBe(true);
    expect(androidStore('aurora')?.source).toBe('fdroid');
    expect(androidStore('fdroid')?.source).toBe('fdroid');
    expect(androidStore('droidify')?.source).toBe('fdroid');
    expect(androidStore('obtainium')?.repo).toBe('ImranR98/Obtainium');
    expect(androidStore('magisk')?.repo).toBe('topjohnwu/Magisk');
    expect(androidStore('lsposed')?.repo).toBe('LSPosed/LSPosed');
    expect(androidStore('shizuku')?.repo).toBe('RikkaApps/Shizuku');
    // Aptoide and Galaxy Store publish no stable direct link, so they are
    // never fetched automatically.
    expect(androidStore('aptoide')?.source).toBe('manual');
    expect(androidStore('nope')).toBeUndefined();
  });

  it('does not invoke adb for an invalid device serial', async () => {
    const states = await androidStoreStates('/definitely/not/adb', 'bad serial; rm -rf');
    expect(states).toHaveLength(ANDROID_STORES.length);
    expect(states.every((state) => !state.installed && !state.enabled)).toBe(true);
  });

  it('reads the version F-Droid publishes, and refuses anything else', () => {
    expect(parseFdroidVersion('{"suggestedVersionCode":54,"packages":[{"versionCode":54}]}')).toBe(54);
    expect(parseFdroidVersion('{"packages":[{"versionCode":41}]}')).toBe(41);
    expect(parseFdroidVersion('not json')).toBe(0);
    expect(parseFdroidVersion('{}')).toBe(0);
  });

  it('only accepts something that is actually an APK', () => {
    expect(looksLikeApk(Buffer.alloc(20_000, 0))).toBe(false);
    expect(looksLikeApk(Buffer.concat([Buffer.from('PK'), Buffer.alloc(20_000)]))).toBe(true);
    expect(looksLikeApk(Buffer.from('PK'))).toBe(false);
  });

  it('asks for the file when there is no official download', async () => {
    await expect(resolveStoreApk('aptoide')).rejects.toThrow(/no stable direct download/i);
    await expect(resolveStoreApk('galaxy')).rejects.toThrow(/no stable direct download/i);
    await expect(resolveStoreApk('aurora', 'relative/path.apk')).rejects.toThrow(/\.apk file/i);
    await expect(resolveStoreApk('unknown')).rejects.toThrow(/Unknown app store/i);
  });
});

describe('Brave and the browser group', () => {
  const release = JSON.stringify({
    assets: [
      { name: 'BraveMonoarm64.apk', browser_download_url: 'https://github.com/brave/brave-browser/releases/download/v1/BraveMonoarm64.apk' },
      { name: 'BraveMonox64.apk', browser_download_url: 'https://github.com/brave/brave-browser/releases/download/v1/BraveMonox64.apk' },
      { name: 'notes.txt', browser_download_url: 'https://github.com/brave/brave-browser/releases/download/v1/notes.txt' },
    ],
  });

  it('is a browser, from Brave\'s own release', () => {
    const brave = androidStore('brave');
    expect(brave?.kind).toBe('browser');
    expect(brave?.source).toBe('github');
    expect(brave?.repo).toBe('brave/brave-browser');
    expect(androidStore('uptodown')?.kind).toBe('store');
    for (const store of ANDROID_STORES) expect(store.icon).toBeTruthy();
  });

  it('picks the build that matches the device architecture', () => {
    const wanted = androidStore('brave')!.assets!;
    expect(pickGithubAsset(release, wanted, 'x86_64')?.name).toBe('BraveMonox64.apk');
    expect(pickGithubAsset(release, wanted, 'arm64-v8a')?.name).toBe('BraveMonoarm64.apk');
    // Nothing usable, or nonsense, yields nothing - never a random file.
    expect(pickGithubAsset('{"assets":[]}', wanted)).toBeUndefined();
    expect(pickGithubAsset('not json', wanted)).toBeUndefined();
    expect(pickGithubAsset(JSON.stringify({ assets: [{ name: 'x.txt', browser_download_url: 'https://x/y.txt' }] }), wanted)).toBeUndefined();
  });

  it('still refuses the stores that publish no direct link', async () => {
    await expect(resolveStoreApk('uptodown')).rejects.toThrow(/no stable direct download/i);
  });
});

describe('photos and videos for a device', () => {
  it('counts what is in the folder and ignores everything else', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-media-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.jpg'), Buffer.alloc(2048));
      fs.writeFileSync(path.join(dir, 'b.PNG'), Buffer.alloc(1024));
      fs.writeFileSync(path.join(dir, 'c.mp4'), Buffer.alloc(4096));
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'nope');
      fs.mkdirSync(path.join(dir, 'sub'));
      const library = readMediaFolder(dir);
      expect(library.photos).toBe(2);
      expect(library.videos).toBe(1);
      expect(library.bytes).toBe(7168);
      expect(library.files.every((file) => MEDIA_EXTENSIONS.includes(path.extname(file).toLowerCase()))).toBe(true);
      expect(library.problem).toBe('');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('says why a folder is unusable instead of copying nothing in silence', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-media-empty-'));
    try {
      expect(readMediaFolder(empty).problem).toMatch(/no photos or videos/i);
      expect(readMediaFolder('relative/path').problem).toMatch(/folder on this computer/i);
      expect(readMediaFolder(path.join(empty, 'missing')).problem).toMatch(/could not be read/i);
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  });
});
