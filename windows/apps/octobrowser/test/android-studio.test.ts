/** Android Studio bridge has no network dependency: verify its curated, local planning model. */
import { describe, expect, it } from 'vitest';
import {
  ANDROID_DEVICES, ANDROID_SYSTEM_IMAGES, androidDiskInfo, androidPreset, androidSpaceEstimate,
  androidSdkCandidates, androidStudioStatus, androidSystemImageInstalled, defaultAvdDirectory, looksLikeSdk,
  mediaCompanionStatus, setAndroidSdkRoot, studioAddonArchiveEntry, windowsToolCommand,
  folderWritable, defaultInstallRoot, androidInstallTarget, setAndroidInstallRoot, packageUnknown, javaMajor, javaVersionFound, brokenArchive, prependPath, meaningfulOutput, androidCliPackage, androidCliArgs, usesNewCli, androidToolLogPath, androidEmulatorLogPath, androidCameraLogPath, openCappedLog, CMDLINE_TOOLS_URLS, ensureCommandLineTools, androidPackageInstalled, clearAndroidInstallRoot, normaliseSdkRoot, rootForPackage, hostAbis, imageRunsHere, emulatorForPackage,
  parseAvdList, scanAvdFolders, writeAvdPointer, avdSearchDirectories, importAvdFolder, listAndroidAvds, parseWebcamList,
  mediaBroadcastCommand, mediaCompanionCameraReadiness, normalizeAndroidLaunchPrefs,
  normalizeCameraRotation, normalizeCameraSources, normalizeNetworkSpeed, waitForMediaCompanionCamera, mediaConfig,
  androidCameraChoices,
  automaticWebcamFallback, cameraProblemLine, clampCameraLimit, emulatorCameraValues, emulatorWebcams, emulatorWebcamsFrom, parseCameraLimit, resolveActiveCameraAssignments,
  runKeepingOutput,
} from '../src/main/android-studio';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('Android Studio local bridge', () => {
  it('uses LTE as the Android Studio network default without rewriting explicit choices', () => {
    expect(normalizeNetworkSpeed(undefined)).toBe('lte');
    expect(normalizeNetworkSpeed('not-a-speed')).toBe('lte');
    expect(normalizeNetworkSpeed('full')).toBe('full');
    expect(normalizeNetworkSpeed('gsm')).toBe('gsm');
  });

  it('does not invent cameras when an exact emulator binary or SDK root is unavailable', async () => {
    await expect(emulatorWebcamsFrom('', '')).resolves.toEqual({ webcams: [], problem: 'none', detail: '' });
  });

  it('offers many Android versions with transparent storage estimates', () => {
    const ids = new Set(ANDROID_SYSTEM_IMAGES.map((item) => item.id));
    expect(ids.size).toBe(ANDROID_SYSTEM_IMAGES.length);
    expect(ANDROID_SYSTEM_IMAGES.length).toBeGreaterThan(20);
    expect(new Set(ANDROID_SYSTEM_IMAGES.map((item) => item.api)).size).toBeGreaterThanOrEqual(8);
    expect(ANDROID_SYSTEM_IMAGES.some((item) => item.abi === 'arm64-v8a')).toBe(true);
    expect(ANDROID_SYSTEM_IMAGES.some((item) => item.abi === 'x86')).toBe(true);
    expect(ANDROID_SYSTEM_IMAGES.some((item) => item.googlePlay)).toBe(true);
    for (const image of ANDROID_SYSTEM_IMAGES) {
      expect(image.packageName).toMatch(/^system-images;android-\d+;[a-z0-9_-]+;(x86_64|arm64-v8a|x86|armeabi-v7a)$/);
      expect(image.imageBytes).toBeGreaterThan(1_000_000_000);
      expect(image.recommendedDataBytes).toBeGreaterThan(1_000_000_000);
    }
  });

  it('offers only Google devices the SDK defines, each with a usable base profile', () => {
    // Other brands were removed: they were a Pixel base with the brand overwritten, which no devices.xml profile matches.
    expect(new Set(ANDROID_DEVICES.map((item) => item.brand))).toEqual(new Set(['Google']));
    for (const device of ANDROID_DEVICES) {
      expect(device.baseDevice).toMatch(/^pixel_[a-z0-9_]+$/);
      expect(device.width).toBeGreaterThan(300);
      expect(device.height).toBeGreaterThan(device.width - 1);
      expect(device.density).toBeGreaterThan(100);
      expect(device.props.model.length).toBeGreaterThan(2);
    }
  });

  it('scales the presets and keeps the space estimate honest', () => {
    const device = ANDROID_DEVICES[0];
    const light = androidPreset('light', device);
    const ultra = androidPreset('ultra', device);
    expect(ultra.ramMb).toBeGreaterThan(light.ramMb);
    expect(ultra.dataGb).toBeGreaterThan(light.dataGb);
    // "custom" never rewrites what the user typed.
    expect(androidPreset('custom', device, light)).toEqual(light);

    const image = ANDROID_SYSTEM_IMAGES[0];
    const withImage = androidSpaceEstimate({ image, hardware: ultra, imageInstalled: false, snapshots: true });
    const installed = androidSpaceEstimate({ image, hardware: ultra, imageInstalled: true, snapshots: true });
    expect(withImage.totalBytes - installed.totalBytes).toBe(image.imageBytes);
    expect(installed.deviceBytes).toBe(installed.dataBytes + installed.sdCardBytes + installed.snapshotBytes);
    const noSnapshots = androidSpaceEstimate({ image, hardware: ultra, imageInstalled: true, snapshots: false });
    expect(noSnapshots.snapshotBytes).toBe(0);
  });

  it('reports free space for a real folder and refuses nonsense paths', () => {
    const info = androidDiskInfo(process.cwd());
    expect(info.exists).toBe(true);
    expect(info.totalBytes).toBeGreaterThan(0);
    expect(info.freeBytes).toBeGreaterThanOrEqual(0);
    // A folder that does not exist yet still reports the parent volume.
    expect(androidDiskInfo(`${process.cwd()}/.octo-missing-folder`).totalBytes).toBeGreaterThan(0);
    expect(androidDiskInfo('not/absolute').totalBytes).toBe(0);
  });

  it('checks a local package marker without querying the network', () => {
    expect(typeof androidSystemImageInstalled(ANDROID_SYSTEM_IMAGES[0].id)).toBe('boolean');
    expect(androidSystemImageInstalled('not-a-system')).toBe(false);
    expect(defaultAvdDirectory().endsWith('avd')).toBe(true);
  });

  it('selects only safe, useful vStudio payload entries and never installer paths', () => {
    expect(studioAddonArchiveEntry('lvStudio arbitrage/vStudio/app.py')).toBe('app.py');
    expect(studioAddonArchiveEntry('lvStudio arbitrage/vStudio/assets/models/korean_man.obj')).toBe('assets/models/korean_man.obj');
    expect(studioAddonArchiveEntry('lvStudio arbitrage/vStudio/INSTALUJ.BAT')).toBeNull();
    expect(studioAddonArchiveEntry('lvStudio arbitrage/vStudio/setup.ps1')).toBeNull();
    expect(studioAddonArchiveEntry('lvStudio arbitrage/vStudio/scripts/full_install.ps1')).toBeNull();
    expect(studioAddonArchiveEntry('lvStudio arbitrage/vStudio/__pycache__/app.pyc')).toBeNull();
    expect(studioAddonArchiveEntry('lvStudio arbitrage/vStudio/output/TTS.wav')).toBeNull();
    expect(studioAddonArchiveEntry('lvStudio arbitrage/vStudio/../outside.txt')).toBeNull();
    expect(studioAddonArchiveEntry('../vStudio/app.py')).toBeNull();
  });
});

describe('vStudio virtual camera and microphone', () => {
  it('describes the companion without installing or starting anything', () => {
    const media = mediaCompanionStatus();
    expect(typeof media.bundleAvailable).toBe('boolean');
    expect(typeof media.installed).toBe('boolean');
    expect(typeof media.pythonAvailable).toBe('boolean');
    expect(media.running).toBe(false);
    // The path is only published once the companion really is staged.
    expect(media.installed || media.path === '').toBe(true);
  });

  it('is part of the Android section status, with no separate archive button', () => {
    const status = androidStudioStatus();
    expect(status.mediaCompanion).toBeTruthy();
    expect(Object.keys(status)).not.toContain('studioBundle');
    expect(Object.keys(status)).not.toContain('studioSdkAddon');
    expect(Array.isArray(status.installedImages)).toBe(true);
  });
});

describe('Android SDK discovery and self-repair', () => {
  it('says where it looked and what is missing instead of only disabling the button', () => {
    const status = androidStudioStatus();
    expect(androidSdkCandidates().length).toBeGreaterThan(0);
    expect(status.searched).toEqual(androidSdkCandidates());
    expect(['', 'sdk', 'cmdline-tools', 'emulator']).toContain(status.missing);
    // No SDK on the host means "sdk" is the reported gap, never a silent empty list.
    expect(status.available || status.missing === 'sdk').toBe(true);
  });

  it('only accepts a folder that really carries Android tools', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-sdk-'));
    expect(looksLikeSdk(base)).toBe(false);
    expect(() => setAndroidSdkRoot(base)).toThrow(/does not look like an Android SDK/);
    expect(() => setAndroidSdkRoot('relative/path')).toThrow(/existing Android SDK folder/);
    fs.mkdirSync(path.join(base, 'platform-tools'));
    expect(looksLikeSdk(base)).toBe(true);
    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe('Windows batch tools (spawn EINVAL fix)', () => {
  it('runs sdkmanager.bat through cmd.exe with every argument quoted', () => {
    const argv = windowsToolCommand('C:\\Android\\Sdk\\cmdline-tools\\latest\\bin\\sdkmanager.bat', [
      '--sdk_root=C:\\Program Files\\Android\\Sdk',
      '--install',
      'system-images;android-35;google_apis_playstore;x86_64',
    ]);
    expect(argv.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    const line = argv[3];
    // Outer quotes for cmd, and each token quoted so spaces and semicolons survive.
    expect(line.startsWith('""')).toBe(true);
    expect(line.endsWith('"')).toBe(true);
    expect(line).toContain('"--sdk_root=C:\\Program Files\\Android\\Sdk"');
    expect(line).toContain('"system-images;android-35;google_apis_playstore;x86_64"');
  });

  it('refuses arguments that could break out of the cmd.exe command line', () => {
    expect(() => windowsToolCommand('C:\\tools\\sdkmanager.bat', ['--install', 'evil" & calc.exe'])).toThrow();
    expect(() => windowsToolCommand('C:\\tools\\sdkmanager.bat', ['--install', 'evil%PATH%'])).toThrow();
    // Ordinary package names and paths with spaces stay allowed.
    expect(() => windowsToolCommand('C:\\tools\\sdkmanager.bat', ['--sdk_root=C:\\Program Files\\Sdk'])).not.toThrow();
  });
});

describe('system image install location', () => {
  it('detects whether a folder can actually be written to', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-writable-'));
    expect(folderWritable(dir)).toBe(true);
    expect(folderWritable(path.join(dir, 'made', 'on', 'demand'))).toBe(true);
    expect(folderWritable('relative/path')).toBe(false);
    if (process.platform !== 'win32') {
      const locked = path.join(dir, 'locked');
      fs.mkdirSync(locked);
      fs.chmodSync(locked, 0o500);
      expect(folderWritable(locked)).toBe(process.getuid?.() === 0);
      fs.chmodSync(locked, 0o700);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to a per-user folder, never Program Files', () => {
    const fallback = defaultInstallRoot();
    expect(path.isAbsolute(fallback)).toBe(true);
    expect(/program files/i.test(fallback)).toBe(false);
    const target = androidInstallTarget();
    expect(path.isAbsolute(target.path)).toBe(true);
    expect(typeof target.writable).toBe('boolean');
    expect(typeof target.sdkReadOnly).toBe('boolean');
  });

  it('refuses an unusable install folder', () => {
    expect(() => setAndroidInstallRoot('')).toThrow();
    expect(() => setAndroidInstallRoot('not/absolute')).toThrow();
  });
});

describe('system image catalogue', () => {
  it('uses package names the SDK repository really publishes', () => {
    for (const image of ANDROID_SYSTEM_IMAGES) {
      const [prefix, api, tag, abi] = image.packageName.split(';');
      expect(prefix).toBe('system-images');
      expect(api).toBe(`android-${image.api}`);
      expect(['google_apis_playstore', 'google_apis', 'default', 'android-tv', 'android-wear', 'android-automotive', 'android-automotive-playstore']).toContain(tag);
      expect(['x86_64', 'arm64-v8a', 'x86']).toContain(abi);
      // Google Play ABIs follow what Google actually publishes.
      if (tag === 'google_apis_playstore') {
        if (abi === 'x86_64') expect(image.api).toBeGreaterThanOrEqual(29);
        if (abi === 'arm64-v8a') expect(image.api).toBeGreaterThanOrEqual(28);
        if (abi === 'x86') expect(image.api).toBeLessThanOrEqual(28);
      }
      expect(image.googlePlay).toBe(tag.includes('playstore'));
    }
  });

  it('offers a Google Play image for every modern release the wizard lists', () => {
    for (const api of [29, 30, 31, 32, 33, 34, 35, 36]) {
      const play = ANDROID_SYSTEM_IMAGES.filter((item) => item.api === api && item.googlePlay && item.family === 'phone');
      expect(play.map((item) => item.abi).sort()).toEqual(['arm64-v8a', 'x86_64']);
    }
    // Ids stay unique across the phone, TV, Wear and Automotive lines.
    const ids = ANDROID_SYSTEM_IMAGES.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const family of ['tv', 'wear', 'automotive'] as const) {
      expect(ANDROID_SYSTEM_IMAGES.some((item) => item.family === family)).toBe(true);
    }
    // Old releases are offered too, so a profile can target an ancient Android.
    expect(Math.min(...ANDROID_SYSTEM_IMAGES.map((item) => item.api))).toBeLessThanOrEqual(21);
  });
});

describe('unknown package detection', () => {
  it('recognises the warning sdkmanager prints instead of failing', () => {
    expect(packageUnknown('Warning: Failed to find package system-images;android-36;google_apis_playstore;x86_64')).toBe(true);
    expect(packageUnknown('Warning: Could not find package foo')).toBe(true);
    expect(packageUnknown('system-images;android-34;google_apis;x86_64 is not available')).toBe(true);
    expect(packageUnknown('[=====    ] 50% Downloading system image')).toBe(false);
    expect(packageUnknown('')).toBe(false);
  });
});

describe('Java detection for the SDK tools', () => {
  it('reads the major version from a JDK release file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-jdk-'));
    fs.writeFileSync(path.join(dir, 'release'), 'JAVA_VERSION="17.0.9"\nOS_ARCH="x86_64"\n');
    expect(javaMajor(dir)).toBe(17);
    fs.writeFileSync(path.join(dir, 'release'), 'JAVA_VERSION="1.8.0_392"\n');
    expect(javaMajor(dir)).toBe(8);
    fs.writeFileSync(path.join(dir, 'release'), 'JAVA_VERSION="21"\n');
    expect(javaMajor(dir)).toBe(21);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the folder name when there is no release file', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-jdkname-'));
    const jdk17 = path.join(base, 'jdk-17.0.11');
    fs.mkdirSync(jdk17);
    expect(javaMajor(jdk17)).toBe(17);
    const jdk8 = path.join(base, 'jdk1.8.0_392');
    fs.mkdirSync(jdk8);
    expect(javaMajor(jdk8)).toBe(8);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('reports the highest Java found without inventing one', () => {
    expect(javaVersionFound()).toBeGreaterThanOrEqual(0);
  });
});

describe('damaged downloads and the Windows search path', () => {
  it('recognises a corrupt archive report', () => {
    expect(brokenArchive('Error on ZipFile unknown archive')).toBe(true);
    expect(brokenArchive('java.util.zip.ZipException: not a zip file')).toBe(true);
    expect(brokenArchive('Checksum mismatch for package')).toBe(true);
    expect(brokenArchive('[====   ] 40% Downloading')).toBe(false);
  });

  it('extends the existing path variable whatever its case', () => {
    const windowsStyle: NodeJS.ProcessEnv = { Path: 'C:\\\\Windows\\\\System32' };
    prependPath(windowsStyle, 'C:\\\\jdk\\\\bin');
    expect(windowsStyle.Path).toBe('C:\\\\jdk\\\\bin' + path.delimiter + 'C:\\\\Windows\\\\System32');
    expect(Object.keys(windowsStyle)).toEqual(['Path']);
    const posixStyle: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    prependPath(posixStyle, '/opt/jdk/bin');
    expect(posixStyle.PATH).toBe('/opt/jdk/bin' + path.delimiter + '/usr/bin');
    const empty: NodeJS.ProcessEnv = {};
    prependPath(empty, '/opt/jdk/bin');
    expect(empty.PATH).toBe('/opt/jdk/bin');
  });
});

describe('new command-line tools', () => {
  it('treats deprecation notices as noise, not as an error', () => {
    const noisy = [
      'WARNING: The SDK Manager CLI tool (sdkmanager) is deprecated. Android CLI will be used instead.',
      'Warning: Flag --verbose is no longer supported. Ignoring.',
      'OpenJDK 64-Bit Server VM warning: The UseAllWindowsProcessorGroups flag is not supported',
      'Failed to install package: no space left on device',
    ].join('\n');
    expect(meaningfulOutput(noisy)).toBe('Failed to install package: no space left on device');
    expect(packageUnknown(meaningfulOutput(noisy))).toBe(false);
    expect(meaningfulOutput('')).toBe('');
  });

  it('converts package names to the new CLI syntax', () => {
    expect(androidCliPackage('system-images;android-36;google_apis_playstore;x86_64'))
      .toBe('system-images/android-36/google_apis_playstore/x86_64');
    expect(androidCliPackage('platform-tools')).toBe('platform-tools');
  });
});

describe('the deprecated sdkmanager stub', () => {
  it('is recognised so the real CLI can take over', () => {
    expect(usesNewCli('WARNING: The SDK Manager CLI tool (sdkmanager) is deprecated. Android CLI will be used instead.')).toBe(true);
    expect(usesNewCli('[=====  ] 40% Downloading')).toBe(false);
  });

  it('builds the CLI command the way the CLI documents it', () => {
    expect(androidCliArgs('E:\\octoVM', 'system-images;android-36;google_apis_playstore;x86_64'))
      .toEqual(['--sdk=E:\\octoVM', 'sdk', 'install', 'system-images/android-36/google_apis_playstore/x86_64']);
    // sdkmanager's own flags must never reach it: they install nothing.
    expect(androidCliArgs('/sdk', 'platform-tools').join(' ')).not.toContain('--sdk_root');
    expect(androidCliArgs('/sdk', 'platform-tools').join(' ')).not.toContain('--install');
  });
});

describe('stub help text is never shown as the error', () => {
  it('drops the migration hints sdkmanager prints', () => {
    const noisy = [
      "The 'android' binary can also be found in the cmdline-tools directory, and 'android sdk' is the replacement for 'sdkmanager'.",
      'To learn more about the Android CLI and how to use it, see the documentation (https://d.android.com/tools/agents/android-cli)',
      'Warning: Flag --verbose is no longer supported. Ignoring.',
    ].join('\n');
    expect(meaningfulOutput(noisy)).toBe('');
  });

  it('writes the tool transcript inside the user folder', () => {
    expect(androidToolLogPath().endsWith(path.join('.octobrowser', 'android-tools.log'))).toBe(true);
    expect(path.isAbsolute(androidToolLogPath())).toBe(true);
  });

  it('keeps the emulator output and the camera log in one file per device, inside the user folder', () => {
    expect(androidEmulatorLogPath('Pixel_8_API_35').endsWith(path.join('.octobrowser', 'android-emulator-Pixel_8_API_35.log'))).toBe(true);
    expect(androidCameraLogPath('Pixel_8_API_35').endsWith(path.join('.octobrowser', 'android-camera-Pixel_8_API_35.log'))).toBe(true);
    // A device name that could leave the folder is refused before any file is opened.
    expect(() => androidEmulatorLogPath('../escape')).toThrow();
  });

  it('a capped log keeps its header, takes only the bytes under its limit, and never throws', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-log-'));
    const file = path.join(dir, 'device.log');
    const write = openCappedLog(file, 'HEAD\n', 10);
    write('abcdef');
    write('ghijkl');
    write('zzz');
    expect(fs.readFileSync(file, 'utf8')).toBe('HEAD\nabcdefghij');
    // A folder that cannot be created (its parent is a file) gives a writer that does nothing.
    const blocked = path.join(file, 'nested', 'device.log');
    const quiet = openCappedLog(blocked, 'x', 10);
    expect(() => quiet('more')).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('self-installing command-line tools', () => {
  it('only offers official Google download addresses', () => {
    expect(CMDLINE_TOOLS_URLS.length).toBeGreaterThan(1);
    for (const url of CMDLINE_TOOLS_URLS) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe('https:');
      expect(parsed.host).toBe('dl.google.com');
      expect(parsed.pathname).toMatch(/^\/android\/repository\/commandlinetools-win-\d+_latest\.zip$/);
    }
  });

  it('refuses a relative install folder without touching the network', async () => {
    await expect(ensureCommandLineTools('relative/sdk')).rejects.toThrow(/absolute/i);
    await expect(ensureCommandLineTools('')).rejects.toThrow();
  });

  it('never presents pure deprecation noise as an error', () => {
    expect(meaningfulOutput('WARNING: The SDK Manager CLI tool (sdkmanager) is deprecated. Android CLI will be used instead.')).toBe('');
  });
});

describe('creating a device after the image lands', () => {
  it('accepts either metadata file sdkmanager or the new CLI writes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-sdk-'));
    setAndroidInstallRoot(root);
    const pkg = 'system-images;android-36;google_apis_playstore;x86_64';
    expect(androidPackageInstalled(pkg)).toBe(false);
    const dir = path.join(root, ...pkg.split(';'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'source.properties'), 'Pkg.Revision=1\n');
    expect(androidPackageInstalled(pkg)).toBe(true);
    expect(androidSystemImageInstalled('api-36-google-play-x86_64')).toBe(true);
    fs.rmSync(path.join(dir, 'source.properties'));
    fs.writeFileSync(path.join(dir, 'package.xml'), '<x/>');
    expect(androidPackageInstalled(pkg)).toBe(true);
    clearAndroidInstallRoot();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('SDK root sanity and image lookup', () => {
  it('never accepts a package folder as the SDK root', () => {
    const base = process.platform === 'win32' ? 'E:\\octoVM' : '/srv/octoVM';
    expect(normaliseSdkRoot(path.join(base, 'build-tools'))).toBe(base);
    expect(normaliseSdkRoot(path.join(base, 'cmdline-tools', 'latest', 'bin'))).toBe(base);
    expect(normaliseSdkRoot(path.join(base, 'system-images'))).toBe(base);
    expect(normaliseSdkRoot(base)).toBe(base);
    expect(normaliseSdkRoot(`${base}/`)).toBe(base);
  });

  it('reports which SDK folder holds an image', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-root-'));
    setAndroidInstallRoot(root);
    const pkg = 'system-images;android-31;google_apis_playstore;x86_64';
    expect(rootForPackage(pkg)).toBe('');
    const dir = path.join(root, ...pkg.split(';'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.xml'), '<x/>');
    expect(rootForPackage(pkg)).toBe(root);
    expect(rootForPackage('system-images;android-99;google_apis;x86_64')).toBe('');
    clearAndroidInstallRoot();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps a stored package folder from poisoning the install root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-poison-'));
    const inside = path.join(root, 'build-tools');
    fs.mkdirSync(inside, { recursive: true });
    expect(setAndroidInstallRoot(inside)).toBe(root);
    expect(androidInstallTarget().path).toBe(root);
    clearAndroidInstallRoot();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('host architecture gating', () => {
  it('only allows images the emulator can actually run here', () => {
    const abis = hostAbis();
    expect(abis.length).toBeGreaterThan(0);
    if (process.arch === 'arm64') expect(abis).toContain('arm64-v8a');
    else {
      expect(abis).toContain('x86_64');
      // An arm64 image on a normal x64 PC is exactly what avdmanager refuses.
      expect(imageRunsHere('arm64-v8a')).toBe(false);
    }
    expect(imageRunsHere(abis[0])).toBe(true);
    expect(imageRunsHere('mips')).toBe(false);
  });

  it('every Android release keeps a variant this machine can run', () => {
    const apis = [...new Set(ANDROID_SYSTEM_IMAGES.filter((item) => item.family === 'phone').map((item) => item.api))];
    for (const api of apis) {
      const usable = ANDROID_SYSTEM_IMAGES.filter((item) => item.api === api && item.family === 'phone' && imageRunsHere(item.abi));
      expect(usable.length).toBeGreaterThan(0);
    }
  });
});

describe('tools must live beside the image', () => {
  it('finds the emulator in the SDK that holds the image', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-emu root-'));
    setAndroidInstallRoot(root);
    const pkg = 'system-images;android-36;google_apis_playstore;x86_64';
    const imageDir = path.join(root, ...pkg.split(';'));
    fs.mkdirSync(imageDir, { recursive: true });
    fs.writeFileSync(path.join(imageDir, 'package.xml'), '<x/>');
    const emulatorDir = path.join(root, 'emulator');
    fs.mkdirSync(emulatorDir, { recursive: true });
    const binary = path.join(emulatorDir, process.platform === 'win32' ? 'emulator.exe' : 'emulator');
    fs.writeFileSync(binary, '');
    fs.chmodSync(binary, 0o755);
    expect(rootForPackage(pkg)).toBe(root);
    expect(await emulatorForPackage(pkg)).toBe(binary);
    clearAndroidInstallRoot();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

/**
 * The bug this covers: a device was created, the wizard said so, and the list
 * stayed empty. Two reasons, both fixed here - the tool output is indented,
 * and a device created outside the AVD home is only reachable through its
 * `<name>.ini` pointer.
 */
describe('finding the devices that were created', () => {
  it('reads the indented blocks avdmanager really prints', () => {
    const raw = [
      'Available Android Virtual Devices:',
      '    Name: Pixel_8_API_34',
      '  Device: pixel_8 (Google)',
      '    Path: /home/u/.android/avd/Pixel_8_API_34.avd',
      '  Target: Google Play (Google Inc.)',
      '          Based on: Android 14.0 Tag/ABI: google_apis_playstore/x86_64',
      '---------',
      '    Name: Galaxy_S24',
      '    Path: /data/avd/Galaxy_S24.avd',
      '  Target: Google APIs',
      '',
      'The following Android Virtual Devices could not be loaded:',
      '    Name: Broken_One',
      '    Path: /data/avd/Broken_One.avd',
      '   Error: Google pixel_x no longer exists as a device',
    ].join('\n');
    const rows = parseAvdList(raw);
    expect(rows.map((row) => row.name)).toEqual(['Pixel_8_API_34', 'Galaxy_S24']);
    expect(rows[0].path).toBe('/home/u/.android/avd/Pixel_8_API_34.avd');
    expect(rows[0].target).toBe('Google Play (Google Inc.)');
    // A device the tool itself could not load is never invented into the list.
    expect(rows.some((row) => row.name === 'Broken_One')).toBe(false);
  });

  it('ignores junk instead of inventing devices', () => {
    expect(parseAvdList('')).toEqual([]);
    expect(parseAvdList('Available Android Virtual Devices:')).toEqual([]);
    // A block without a path cannot be used.
    expect(parseAvdList('  Name: Nameless')).toEqual([]);
  });

  it('finds a device in the AVD home and one created in another folder', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-avdhome-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-avdfar-'));
    const previous = process.env.ANDROID_AVD_HOME;
    process.env.ANDROID_AVD_HOME = home;
    try {
      const inHome = path.join(home, 'Pixel_8.avd');
      fs.mkdirSync(inHome, { recursive: true });
      fs.writeFileSync(path.join(inHome, 'config.ini'), 'image.androidVersion.api=34\ntag.display=Google Play\nabi.type=x86_64\n');
      const far = path.join(elsewhere, 'Second_Drive.avd');
      fs.mkdirSync(far, { recursive: true });
      fs.writeFileSync(path.join(far, 'config.ini'), 'image.androidVersion.api=35\n');

      // Without the pointer the far device is invisible; writing it is exactly
      // what the create flow now does.
      expect(scanAvdFolders().map((item) => item.name)).toEqual(['Pixel_8']);
      const pointer = writeAvdPointer('Second_Drive', far, 35);
      expect(pointer).toBe(path.join(home, 'Second_Drive.ini'));
      expect(fs.readFileSync(pointer, 'utf8')).toContain(`path=${far}`);

      const found = scanAvdFolders();
      expect(found.map((item) => item.name).sort()).toEqual(['Pixel_8', 'Second_Drive']);
      expect(found.find((item) => item.name === 'Pixel_8')?.target).toBe('API 34 · Google Play · x86_64');
      expect(found.find((item) => item.name === 'Second_Drive')?.path).toBe(far);
      expect(avdSearchDirectories()[0]).toBe(home);

      // A pointer to a folder that is gone must not produce a phantom row.
      fs.rmSync(far, { recursive: true, force: true });
      expect(scanAvdFolders().map((item) => item.name)).toEqual(['Pixel_8']);
    } finally {
      if (previous === undefined) delete process.env.ANDROID_AVD_HOME;
      else process.env.ANDROID_AVD_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses to write a pointer for an unusable name or a relative path', () => {
    expect(writeAvdPointer('bad name', '/tmp/x.avd')).toBe('');
    expect(writeAvdPointer('Fine_Name', 'relative/x.avd')).toBe('');
  });
});

describe('adopting devices that already exist on disk', () => {
  it('writes the missing pointer for every device folder it is shown', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-avdhome2-'));
    const store = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-avdstore-'));
    const previous = process.env.ANDROID_AVD_HOME;
    process.env.ANDROID_AVD_HOME = home;
    try {
      for (const name of ['Old_One', 'Old_Two']) {
        const dir = path.join(store, `${name}.avd`);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'config.ini'), 'image.androidVersion.api=33\n');
      }
      // A folder without config.ini is not a device and must be ignored.
      fs.mkdirSync(path.join(store, 'Not_A_Device.avd'), { recursive: true });

      const result = importAvdFolder(store);
      expect(result.added).toBe(2);
      expect(result.names.sort()).toEqual(['Old_One', 'Old_Two']);
      expect(scanAvdFolders().map((item) => item.name).sort()).toEqual(['Old_One', 'Old_Two']);
      // Pointing straight at one device folder works too.
      expect(importAvdFolder(path.join(store, 'Old_One.avd')).added).toBe(1);
      expect(() => importAvdFolder('not-absolute')).toThrow();
    } finally {
      if (previous === undefined) delete process.env.ANDROID_AVD_HOME;
      else process.env.ANDROID_AVD_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(store, { recursive: true, force: true });
    }
  });
});

/**
 * vStudio Mobile reaches Android through a host camera the emulator
 * enumerates. `webcam0` is the FIRST camera, normally the built-in one, so
 * wiring every device to webcam0 showed the laptop webcam inside Android.
 */
describe('wiring a live camera into a device', () => {
  const LIST = [
    'List of web cameras connected to the computer:',
    " Camera 'webcam0' is connected to device '/dev/video0' on channel 0 using pixel format 'YUYV'",
    " Camera 'webcam1' is connected to device 'OBS Virtual Camera' on channel 0 using pixel format 'RGB24'",
  ].join('\n');

  it('reads every saved camera choice as a host camera chosen automatically', () => {
    // The emulator's own test pattern and 3D room are not cameras on this
    // computer, so no saved value can keep them. Older values read as a host
    // camera, and the endpoint a lens holds is what says whether it has one.
    expect(normalizeCameraSources('webcam', 'webcam')).toEqual({ front: 'webcam', back: 'webcam' });
    expect(normalizeCameraSources('webcam', 'emulated')).toEqual({ front: 'webcam', back: 'webcam' });
    expect(normalizeCameraSources('emulated', 'webcam')).toEqual({ front: 'webcam', back: 'webcam' });
    expect(normalizeCameraSources('none', 'virtualscene')).toEqual({ front: 'webcam', back: 'webcam' });
    expect(normalizeCameraSources('emulated', 'emulated')).toEqual({ front: 'webcam', back: 'webcam' });
    expect(normalizeCameraSources('vstudio', 'vstudio')).toEqual({ front: 'webcam', back: 'webcam' });
    expect(normalizeCameraSources('nonsense', 'webcam99x')).toEqual({ front: 'webcam', back: 'webcam' });
    expect(normalizeCameraSources(undefined, undefined)).toEqual({ front: 'webcam', back: 'webcam' });
    // A saved "no camera" is read as a host camera, chosen automatically on the next launch.
    expect(normalizeAndroidLaunchPrefs({ cameraFront: 'webcam', cameraBack: 'webcam' })).toMatchObject({
      cameraFront: 'webcam', cameraBack: 'webcam',
    });
    expect(normalizeAndroidLaunchPrefs({ cameraFront: 'emulated', cameraBack: 'virtualscene' } as never)).toMatchObject({
      cameraFront: 'webcam', cameraBack: 'webcam',
    });
    expect(normalizeAndroidLaunchPrefs({ cameraFront: 'none', cameraBack: 'none' } as never)).toMatchObject({
      cameraFront: 'webcam', cameraBack: 'webcam',
    });
    // The companion routing keys are gone from what a launch remembers.
    const prefs = normalizeAndroidLaunchPrefs({ cameraFront: 'webcam', cameraBack: 'none' } as never);
    expect(Object.keys(prefs)).not.toContain('startMediaCompanion');
    expect(Object.keys(prefs)).not.toContain('hostCameraDevice');
    expect(Object.keys(prefs)).not.toContain('hostCameraRotation');
  });

  /**
   * The emulator rule that decides whether the guest CameraProvider lives: one
   * host endpoint cannot be opened for both facings. Breaking it crashed the
   * stock Camera app, so the front lens gives way.
   */
  it('answers with camera values the emulator accepts', () => {
    expect(emulatorCameraValues('webcam', 'webcam', '', '')).toEqual({ front: 'none', back: 'none' });
    expect(emulatorCameraValues('webcam', 'webcam', 'webcam1', '')).toEqual({ front: 'webcam1', back: 'none' });
    expect(emulatorCameraValues('webcam', 'webcam', '', 'webcam2')).toEqual({ front: 'none', back: 'webcam2' });
    expect(emulatorCameraValues('webcam', 'webcam', 'webcam1', 'webcam2')).toEqual({ front: 'webcam1', back: 'webcam2' });
    expect(emulatorCameraValues('webcam', 'webcam', 'webcam1', 'webcam1')).toEqual({ front: 'none', back: 'webcam1' });
    // Only a well-formed endpoint reaches the command line; anything else is
    // 'none' rather than a guessed webcam0. Whether the endpoint is still
    // connected is decided by resolveActiveCameraAssignments, below.
    expect(emulatorCameraValues('webcam', 'webcam', 'webcam7', '')).toEqual({ front: 'webcam7', back: 'none' });
    expect(emulatorCameraValues('webcam', 'webcam', 'not-a-webcam', '')).toEqual({ front: 'none', back: 'none' });
    // A source that is not a host camera never reaches the command line.
    expect(emulatorCameraValues('emulated', 'virtualscene', 'webcam1', 'webcam2')).toEqual({ front: 'none', back: 'none' });
  });

  it('never puts a picture that is not a camera on a lens, and says why a lens is off', () => {
    // Nothing is connected: both lenses are off, and nothing stands in for a camera.
    const none = resolveActiveCameraAssignments('webcam', 'webcam', '', '', [], []);
    expect(none).toMatchObject({ front: 'none', back: 'none', frontDevice: '', backDevice: '', warning: '' });
    // A saved camera that is gone is reported, not replaced by the emulator's own picture.
    const gone = resolveActiveCameraAssignments('webcam', 'webcam', 'webcam3', 'webcam3', [], []);
    expect(gone).toMatchObject({ front: 'none', back: 'none', frontDevice: '', backDevice: '' });
    expect(gone.warning).toContain('The saved rear camera is no longer active.');
    expect(gone.warning).toContain('The saved front camera is no longer active.');
    // One host camera serves one lens: the rear one keeps it, the front one is off.
    const duplicate = resolveActiveCameraAssignments('webcam', 'webcam', 'webcam0', 'webcam0', [
      { name: 'webcam0', device: 'Integrated Camera', virtual: false },
    ], []);
    expect(duplicate).toMatchObject({ front: 'none', back: 'webcam', frontDevice: '', backDevice: 'webcam0' });
    expect(duplicate.warning).toContain('One camera cannot serve both lenses.');
  });

  it('keeps the camera the user picked, and fills the other lens from what is active', () => {
    // Everything the emulator enumerated is selectable. The "virtual" and
    // "foreign" flags are labels only: they never overrule a camera a person chose.
    const list = [
      { name: 'webcam0', device: 'Integrated Camera', virtual: false },
      { name: 'webcam1', device: 'DroidCam Source', virtual: true, foreign: true },
    ];
    // The rear lens is settled first, so it takes the other active camera; the
    // picked camera keeps the front lens.
    const droid = resolveActiveCameraAssignments('webcam', 'webcam', 'webcam1', '', list, []);
    expect(droid).toMatchObject({ front: 'webcam', frontDevice: 'webcam1', back: 'webcam', backDevice: 'webcam0' });
    expect(droid.warning).toBe('');
    const plain = resolveActiveCameraAssignments('webcam', 'webcam', 'webcam0', '', list, []);
    expect(plain).toMatchObject({ frontDevice: 'webcam0', backDevice: 'webcam1' });
    // A device saved with the old companion source reads as the same host camera, not as a missing one.
    const legacy = resolveActiveCameraAssignments('vstudio', 'none', 'webcam1', '', list, []);
    expect(legacy).toMatchObject({ front: 'webcam', frontDevice: 'webcam1', warning: '' });
    // Nothing is picked by name: with nothing saved, the first two active cameras serve the lenses.
    const auto = resolveActiveCameraAssignments('webcam', 'webcam', '', '', list, ['DroidCam']);
    expect(auto).toMatchObject({ back: 'webcam', backDevice: 'webcam0', front: 'webcam', frontDevice: 'webcam1' });
  });

  it('uses only an endpoint the emulator enumerated, never a guessed one', () => {
    const list = [{ name: 'webcam0', device: 'Integrated Camera', virtual: false }];
    // webcam3 is not listed, so the front lens gives it up. The one listed camera
    // serves the rear lens, and the front lens is off.
    const unknown = resolveActiveCameraAssignments('webcam', 'webcam', 'webcam3', '', list, []);
    expect(unknown).toMatchObject({ front: 'none', frontDevice: '', back: 'webcam', backDevice: 'webcam0' });
    expect(unknown.warning).toContain('The saved front camera is no longer active.');
    // Nothing listed means nothing is used, not a guessed webcam0.
    expect(resolveActiveCameraAssignments('webcam', 'webcam', 'webcam0', '', [], []).front).toBe('none');
  });

  it('lists no camera when the emulator cannot be asked, and never reads Windows instead', async () => {
    // No Android SDK here, so the emulator cannot be asked. The answer is an
    // empty list, not a guess at webcam0 and not a list built from Windows.
    expect(await emulatorWebcams()).toEqual([]);
  });

  it('falls back to webcam0 only on Windows when the host has cameras but enumeration is empty', () => {
    const empty = { webcams: [], problem: 'reported' as const, detail: '' };
    expect(automaticWebcamFallback(58, empty, 'win32')).toMatchObject([{ name: 'webcam0' }]);
    expect(automaticWebcamFallback(0, empty, 'win32')).toEqual([]);
    expect(automaticWebcamFallback(58, empty, 'linux')).toEqual([]);
    expect(automaticWebcamFallback(58, { ...empty, webcams: [{ name: 'webcam1', device: 'Camera', virtual: false }] }, 'win32')).toEqual([]);
  });

  it('advertises only a resolution the chosen source can deliver', () => {
    expect(parseCameraLimit('1280x720')).toEqual({ width: 1280, height: 720 });
    expect(parseCameraLimit('1920x1080x32')).toBeUndefined();
    expect(parseCameraLimit('')).toBeUndefined();
    // Odd sizes are rounded to even pixels and kept inside what the HAL describes.
    expect(clampCameraLimit({ width: 641, height: 481 })).toEqual({ width: 642, height: 482 });
    expect(clampCameraLimit({ width: 20000, height: 10 })).toEqual({ width: 4096, height: 240 });
  });

  it('reads a device saved with the old companion source as a live host camera', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-avd-media-intent-'));
    const previous = process.env.ANDROID_AVD_HOME;
    process.env.ANDROID_AVD_HOME = home;
    try {
      const avd = path.join(home, 'Media_Intent.avd');
      fs.mkdirSync(avd, { recursive: true });
      fs.writeFileSync(path.join(avd, 'config.ini'), [
        'AvdId=Media_Intent',
        'hw.camera.front=none',
        'hw.camera.back=none',
        'octobrowser.cameraFront=vstudio',
        'octobrowser.cameraBack=none',
        'octobrowser.mediaCompanion=vstudio',
        'hw.audioInput=yes',
      ].join('\n'));
      const listed = (await listAndroidAvds()).find((item) => item.name === 'Media_Intent');
      // No partner camera, no companion flag: the device points at a host camera.
      expect(listed).toMatchObject({ cameraFront: 'webcam', cameraBack: 'webcam' });
      expect(Object.keys(listed ?? {})).not.toContain('mediaCompanion');
    } finally {
      if (previous === undefined) delete process.env.ANDROID_AVD_HOME;
      else process.env.ANDROID_AVD_HOME = previous;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('keeps the rotation helper honest for the browser plugin that still uses it', () => {
    expect([0, 90, 180, 270].map(normalizeCameraRotation)).toEqual([0, 90, 180, 270]);
    expect(normalizeCameraRotation(45)).toBe(0);
    expect(normalizeCameraRotation('270')).toBe(270);
    // An old launch file may still carry the companion keys: they are dropped
    // instead of being remembered as if Android still needed them.
    const legacy = normalizeAndroidLaunchPrefs({
      cameraFront: 'vstudio' as never, cameraBack: 'none',
      hostCameraRotation: 90, hostCameraMirror: true, startMediaCompanion: true,
    } as never);
    expect(legacy).toMatchObject({ cameraFront: 'webcam', cameraBack: 'webcam' });
    expect(Object.keys(legacy)).not.toContain('hostCameraMirror');
    expect(Object.keys(legacy)).not.toContain('startMediaCompanion');
  });

  it('writes the config Android boots with, without a companion behind it', () => {
    const host = mediaConfig('webcam', 'none', true, 'webcam0', '');
    expect(host).toMatchObject({
      'hw.camera.front': 'webcam0',
      'hw.camera.back': 'none',
      'hw.audioInput': 'yes',
    });
    // The bare umbrella key is not a key the emulator reads, so config.ini never carries it.
    expect(host).not.toHaveProperty('hw.camera');
    // A host camera that was never measured advertises what a webcam really
    // delivers. Claiming Full HD is how the Camera app ended up asking for a
    // stream the camera could not produce, and stopped.
    expect(host['hw.camera.maxHorizontalPixels']).toBe('640');
    expect(host['hw.camera.maxVerticalPixels']).toBe('480');
    // The companion is no longer wired into an Android device at all.
    expect(Object.keys(host)).not.toContain('octobrowser.mediaCompanion');
    // Measured cameras report what was measured, and the lower of the two lenses wins.
    const measured = mediaConfig('webcam', 'webcam', false, 'webcam0', 'webcam1', {
      front: { width: 1920, height: 1080 }, back: { width: 1280, height: 720 },
    });
    expect(measured['hw.camera.maxHorizontalPixels']).toBe('1280');
    expect(measured['hw.camera.maxVerticalPixels']).toBe('720');
    expect(measured['hw.audioInput']).toBe('no');
    // Android offers one number to apps for both cameras, so a 640x480 webcam on
    // one lens holds the whole device down: promising Full HD there is what made
    // the Camera app request a stream the webcam could not send.
    const mixed = mediaConfig('webcam', 'webcam', true, 'webcam0', 'webcam1', { front: { width: 1920, height: 1080 } });
    expect(mixed['hw.camera.maxHorizontalPixels']).toBe('640');
    expect(mixed['hw.camera.maxVerticalPixels']).toBe('480');
    // Both facings on one endpoint is the crash the emulator cannot recover
    // from, so the front one gives way and the rear one keeps it.
    const duplicate = mediaConfig('webcam', 'webcam', true, 'webcam0', 'webcam0');
    expect(duplicate['hw.camera.front']).toBe('none');
    expect(duplicate['hw.camera.back']).toBe('webcam0');
    // A lens with no camera is recorded as off.
    const off = mediaConfig('webcam', 'webcam', false, '', '');
    expect(off).toMatchObject({
      'hw.camera.front': 'none',
      'hw.camera.back': 'none',
      'octobrowser.cameraFront': 'none',
      'octobrowser.cameraBack': 'none',
    });
    expect(off).not.toHaveProperty('hw.camera');
  });

  it('offers only live cameras, with no emulator picture and no companion option', async () => {
    const choices = await androidCameraChoices();
    expect(Object.keys(choices)).not.toContain('companion');
    // The emulator's own test pattern and 3D room are not cameras here, so they
    // are never listed. With no emulator on this machine the list is empty, and
    // the picker says so from emulatorAvailable.
    expect(choices.webcams).toEqual([]);
    expect(choices.emulatorAvailable).toBe(false);
    expect(Object.keys(choices).sort()).toEqual(['detail', 'emulatorAvailable', 'hostCameraCount', 'problem', 'webcams']);
    expect(choices.problem).toBe('');
  });

  it('generates one-shot start/stop commands and distinguishes readiness outcomes', async () => {
    expect(mediaBroadcastCommand(true, 123, 'one')).toBe('start:123:one');
    expect(mediaBroadcastCommand(false, 456, 'two')).toBe('stop:456:two');
    const request = 'start:123:one';
    expect(mediaCompanionCameraReadiness(undefined, request).state).toBe('waiting');
    expect(mediaCompanionCameraReadiness({ broadcastRequest: 'start:old', cameraActive: true, broadcasting: true }, request).state).toBe('waiting');
    expect(mediaCompanionCameraReadiness({ broadcastRequest: request, cameraActive: true, broadcasting: true, cameraDevice: 'Unity Video Capture' }, request)).toEqual({ state: 'ready', message: 'Unity Video Capture' });
    expect(mediaCompanionCameraReadiness({ broadcastRequest: request, cameraActive: true, broadcasting: true, inputCameraRequested: true, inputCameraActive: false }, request).state).toBe('waiting');
    expect(mediaCompanionCameraReadiness({ broadcastRequest: request, cameraActive: true, broadcasting: true, inputCameraRequested: true, inputCameraActive: true, cameraDevice: 'Unity Video Capture' }, request)).toEqual({ state: 'ready', message: 'Unity Video Capture' });
    expect(mediaCompanionCameraReadiness({ broadcastRequest: request, cameraActive: true, broadcasting: true, inputCameraRequested: true, inputCameraError: 'Realme did not return a frame' }, request)).toEqual({ state: 'error', message: 'Realme did not return a frame' });
    expect(mediaCompanionCameraReadiness({ broadcastRequest: request, cameraActive: false, broadcasting: true, cameraError: 'driver busy' }, request)).toEqual({ state: 'error', message: 'driver busy' });
    await expect(waitForMediaCompanionCamera('vstudio-mobile', 'start:never', 1)).rejects.toThrow('did not open Unity Capture');
  });

  it('reads the camera list the emulator prints', () => {
    const cams = parseWebcamList(LIST);
    expect(cams.map((item) => item.name)).toEqual(['webcam0', 'webcam1']);
    expect(cams[0].device).toBe('/dev/video0');
    expect(cams[0].virtual).toBe(false);
    expect(cams[1].virtual).toBe(true);
    // Some Windows emulator builds print the compact form instead.
    expect(parseWebcamList('webcam0: Integrated Camera\nwebcam1 = vStudio Mobile').map((item) => item.device))
      .toEqual(['Integrated Camera', 'vStudio Mobile']);
    expect(parseWebcamList('')).toEqual([]);
    expect(parseWebcamList('no cameras here')).toEqual([]);
  });

  it('reads every quoting the emulator uses, so a Windows list is not dropped', () => {
    // Windows builds quote the names with backticks; some translations use typographic quotes.
    expect(parseWebcamList('Camera `webcam0` is connected to device `AndroidEmulatorVC0` on channel 0 using pixel format `BGR4`'))
      .toEqual([{ name: 'webcam0', device: 'AndroidEmulatorVC0', virtual: false, foreign: false }]);
    expect(parseWebcamList('Camera \u2018webcam1\u2019 is connected to device \u2018Integrated Camera\u2019 on channel 0 using pixel format \u2018RGB24\u2019')
      .map((item) => [item.name, item.device])).toEqual([['webcam1', 'Integrated Camera']]);
    expect(parseWebcamList('Camera "webcam0" is connected to device "USB Camera" on channel 0').map((item) => item.device))
      .toEqual(['USB Camera']);
    // A name that contains an apostrophe keeps it; only the surrounding quotes are removed.
    expect(parseWebcamList("Camera 'webcam0' is connected to device 'Lisa's Camera' on channel 0 using pixel format 'YUYV'")
      .map((item) => item.device)).toEqual(["Lisa's Camera"]);
    // Windows line endings, and a camera the list repeats is listed once.
    const windows = 'List of web cameras connected to the computer:\r\n'
      + 'Camera `webcam0` is connected to device `Cam A` on channel 0 using pixel format `BGR4`\r\n'
      + 'Camera `webcam0` is connected to device `Cam A` on channel 0 using pixel format `BGR4`\r\n';
    expect(parseWebcamList(windows).map((item) => item.name)).toEqual(['webcam0']);
  });

  it('reads a Windows device path as printed, and says in plain words why an empty list is empty', () => {
    const path = '\\\\?\\usb#vid_04f2&pid_b6d0&mi_00#6&2b7d6b1f&0&0000#{e5323777-f976-4f5b-9b55-b94699c46e44}\\global';
    const printed = `List of web cameras connected to the computer:\n Camera 'webcam0' is connected to device '${path}' on channel 0 using pixel format 'NV12'\n`;
    expect(parseWebcamList(printed).map((item) => [item.name, item.device])).toEqual([['webcam0', path]]);
    // A failure the emulator logs is shown without the long device path.
    expect(cameraProblemLine(`INFO: Failed to get webcam info for device '${path}', hr=0x80070005`))
      .toBe("Failed to get webcam info for device 'a Windows camera', hr=0x80070005");
    expect(cameraProblemLine('ERROR: Could not initialize MediaFoundation, disabling webcam.'))
      .toBe('Could not initialize MediaFoundation, disabling webcam.');
    // Normal chatter about a pixel format is not a failure, so nothing is reported for it.
    expect(cameraProblemLine('Could not find common subtype for pixel formats, falling back to RGB32.')).toBe('');
    expect(cameraProblemLine('')).toBe('');
  });

  it('keeps the list the emulator printed even when it exits with an error code', async () => {
    // Some emulator builds print the camera list and then exit non-zero. The
    // list is what matters, so it must not be thrown away with the exit code.
    const script = [
      "process.stdout.write('List of web cameras connected to the computer:\\n');",
      'process.stdout.write("Camera `webcam0` is connected to device `Integrated Camera` on channel 0 using pixel format `BGR4`\\n");',
      'process.exit(3);',
    ].join('');
    const printed = await runKeepingOutput(process.execPath, ['-e', script], 15_000);
    expect(parseWebcamList(printed)).toEqual([{ name: 'webcam0', device: 'Integrated Camera', virtual: false, foreign: false }]);
  });

});
