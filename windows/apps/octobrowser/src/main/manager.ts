/**
 * apps/octobrowser/src/main/manager.ts
 *
 * Profile MANAGER (launcher) process of Octo.su:
 *   - shows the launcher window (profiles, security status, settings, updates, logs, backups);
 *   - is the only writer of profiles.json / settings.json (children request changes);
 *   - starts one browser process per profile and hands it the data key over a private pipe;
 *   - opens / seals encrypted profile vaults, wipes temporary profiles after their process exits;
 *   - launches the Tor profile in the official Tor Browser and sandboxed profiles in Windows Sandbox;
 *   - auto-locks after inactivity or when Windows locks;
 *   - checks for updates (daily first launch / every 3rd launch / manual) and updates filter lists.
 */
import { app, BrowserWindow, dialog, Menu, Notification, powerMonitor, shell, session, Session, Tray, net as electronNet } from 'electron';
import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ADDONS, APPS, BootstrapStore, DICTS, DecryptionError, Profile, ProfileData, ProfileKind, ProfileManager, SUITE_VERSION, appServicesOffline, strictOffline, buildWsbConfig,
  describeIsolation, detectVpnAdapters, dohTemplate, generateMnemonic, isValidMnemonic, wipe, fileStamp, SANDBOX_DATA_DIR, isLang, Lang,
  checkConsistency, effectiveSettings, PROFILE_KINDS, privateBrowsingPatch, privateBrowsingStamp, validateBaseDir,
  PasswordStore, ProxyRotationMode, PROXY_ROTATION_MODES, proxyRotation,
  ProxyStore, ParsedProxy, ProxyType, PROXY_TYPES, ProxyCheckResult, parseProxy, parseProxyList, parseCookies, ImportedCookie, MAX_COOKIES, checkExitIp, needsBridge,
  SEARCH_ENGINES, SearchEngine, checkAllSearchLatency,
  MEDIA_PLUGINS, MEDIA_PLUGIN_IDS, mediaPluginEnabled, type MediaPluginId,
  generateFingerprint, setEngineVersion, engineVersion, FP_OSES, FingerprintOs, FingerprintConfig, fingerprintWarnings, validateProfileFingerprintConsistency, gpuPresets, userAgentFor,
} from '@octo/core';
import { ProxyBridge } from '@octo/shell/proxy-bridge';
import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import { ApiBackend, ApiError, ApiServer } from './api-server';
import { AdblockService } from '@octo/shell/adblock';
import { type Message, type MessageChannel, channelStdio, openParentChannel } from '@octo/shell/channel';
import { FINGERPRINT_TEST_SITES, type FingerprintTestSiteId } from '../shared/fingerprint-test-sites';
import type { FingerprintAuditReport, FingerprintAuditResponse } from '../shared/fingerprint-audit-types';
import { AppContext } from '@octo/shell/context';
import { handle, trustWebContents } from '@octo/shell/ipc';
import { SAFE_WEB_PREFERENCES, assertSafeWebPreferences } from '@octo/shell/security-policy';
import { UpdateManager } from '@octo/shell/update-manager';
import { runMasterPasswordUnlock } from '@octo/shell/unlock';
import { iconPath, THEME } from '@octo/shell/windows-ui';
import { findTorBrowser, firefoxAvailability, launchFirefox, launchDetached, launchWindowsSandbox, windowsSandboxAvailable } from '@octo/shell/winutil';
import { browserEngineFor, inkbrowserBlocks, NEW_PROFILE_ENGINE } from '@octo/core';
import { findInkBrowser } from './inkbrowser';
import { bootstrapFileFor } from '@octo/shell/prepare';
import { clearVirtualBoxManagePath, installVirtualBox, setVirtualBoxManagePath, virtualBoxStatus, type VirtualBoxLaunchMode } from './virtualbox';
import {
  getStudioLinuxVmStatus, createStudioLinuxVm, startStudioLinuxVm, stopStudioLinuxVm,
  connectStudioAdbBridge, generateStudioLinuxProvisionScript, launchProfileInIsolatedVm,
  getIsolatedDropFolder, type StudioLinuxVmCreateOptions, type StudioLinuxVmStatus,
} from './virtualbox-studio-vm';
import { IMAGE_VARIANTS, PHONES, androidBuildIdentity, handsetDisplayName, applyVariant, creationSummary, registerHandsetFile, phone as catalogPhone } from './android-catalog';

import { androidNetworkStatus, clearAndroidProxy, setAllAndroidNetworkOff, setAndroidNetworkOff, setAndroidProxy } from './android-network';
import type { QuietBootResult } from './android-quiet-boot';
import { ScreenStream, execAdb, keyArgs, nextRotation, parseRotation, parseScreenAction, pngDimensions, rotationLockArgs, rotationReadArgs, rotationSetArgs, screencapArgs, tapArgs } from './android-screen';
import { parseSecondaryDisplay } from './android-displays';
 import { importAvdFolder, type CameraSource, androidCameraChoices, androidMediaCheck, repairAndroidMedia, emulatorWebcams, androidCameraChoicesCached, stopAndroidAvd, androidLaunchPrefs, rememberAndroidLaunch, ANDROID_LOCALES, adbPath, androidSerialFor, configureMediaCompanion, applyDeviceIdentity, grantAndroidMediaPermissions, reportAndroidProgress, setAndroidProgressSink, type AndroidProgress, acceptAndroidLicenses, androidPackageInstalled, createAndroidAvdFromSpec, quietBootAndroidAvd, installAndroidPackage, updateAvdSettings, type AvdSettingsInput, androidStudioStatusAsync, ANDROID_CATALOG_DEVICES, ANDROID_SYSTEM_IMAGES, androidDiskInfo, androidSdkCandidates, androidSystemImageInstalled, clearAndroidSdkRoot, installAndroidTools, setAndroidSdkRoot, createAndroidAvd, defaultAvdDirectory, deleteAndroidAvd, ensureMediaCompanionAsync, installAndroidSystemImage, launchAndroidAvd, listAndroidAvds, androidInstallRoot, androidInstallTarget, imageRunsHere, setAndroidInstallRoot, clearAndroidInstallRoot, availableSystemImageIds, androidToolLogPath, mediaCompanionStatusAsync, openAndroidAvdFolder, requestMediaCompanionBroadcast, waitForMediaCompanionCamera, startMediaCompanion, stopMediaCompanion, setMediaPluginEnabled, mediaPluginActive, startWebMediaCompanionAsync, type AndroidAvdCreateInput, type AndroidLaunchInput} from './android-studio';
import { ANDROID_STORES, androidStore, androidStoreStates, changeAndroidStoreState, installAndroidStores, readMediaFolder, pushMediaToDevice } from './android-stores';
import { addCustomImage, customCataloguePath, importSystemImageArchive, importSystemImageDirectory, inspectSystemImageDirectory, readCustomCatalogue, removeCustomImage, validCustomPackage } from './android-custom';
import { installMediaRequirement, vbCableInstalledAsync } from './media-requirements';
import { execFile } from 'node:child_process';
import { DOLPHIN_IMPORT_FIELDS, convertDolphinProfile, dolphinProfileSummaries, parseDolphinExport, type DolphinImportOptions } from './dolphin-import';
import { FirefoxBidi, NativeChromiumTabs, NativeEngineProcess, spawnNativeEngine } from '@octo/shell/native-engine';
import { discoverEngineRuntime, EngineRunnerError } from '@octo/shell/engine-runtime';
import { catalogEntry, listInstalled, installChromium, removeChromium, DEFAULT_CHROMIUM_VERSION } from '@octo/shell/runtime-catalog';
import { discoverFirefoxRuntime, geckoCatalogEntry, installFirefoxRuntime, inspectFirefoxRuntime } from '@octo/shell/gecko-runtime';
import { chromiumPrivacyArgs, prepareChromiumPrivacy, prepareFirefoxPrivacy } from '@octo/shell/engine-privacy';

let importedHandsetsLoaded = false;

const LAUNCHER_CHROME_COLORS: Record<string, { color: string; symbolColor: string }> = {
  ink: { color: '#111315', symbolColor: '#d8e2ec' }, obsidian: { color: '#090a0d', symbolColor: '#eef1f5' },
  slate: { color: '#20252b', symbolColor: '#f1f3f5' }, midnight: { color: '#10131d', symbolColor: '#edf1fa' },
  navy: { color: '#0b1728', symbolColor: '#edf6ff' }, charcoal: { color: '#171717', symbolColor: '#f0f0f0' },
  amethyst: { color: '#21152f', symbolColor: '#f5ecff' }, purple: { color: '#21152c', symbolColor: '#f6edff' },
  forest: { color: '#102219', symbolColor: '#eef8ef' }, emerald: { color: '#0c241f', symbolColor: '#eafff7' },
  olive: { color: '#202314', symbolColor: '#f5f7dc' }, rose: { color: '#2b151d', symbolColor: '#fff0f5' },
  sunset: { color: '#2c1715', symbolColor: '#fff1e8' }, copper: { color: '#241813', symbolColor: '#fff0df' },
  frutigerAero: { color: '#b9e8f6', symbolColor: '#16495a' }, liquidGlass: { color: '#d9e8f4', symbolColor: '#25445c' },
  halloweenDay: { color: '#f4b942', symbolColor: '#2a1720' }, halloweenNight: { color: '#17152d', symbolColor: '#f2d37d' },
  kush: { color: '#173d2d', symbolColor: '#d9f3a5' }, tactical: { color: '#202522', symbolColor: '#d7ddd2' },
};
function launcherChrome(theme: string): { color: string; symbolColor: string } {
  return LAUNCHER_CHROME_COLORS[theme] ?? LAUNCHER_CHROME_COLORS.ink;
}

assertSafeWebPreferences({ ...SAFE_WEB_PREFERENCES, webviewTag: false });
const importedHandsetsDir = () => path.join(os.homedir(), '.octobrowser', 'handsets');

function importHandsetPath(selected: string) {
  if (!path.isAbsolute(selected) || !selected.toLowerCase().endsWith('.octophone.json')) {
    throw new Error('Select an .octophone.json handset file.');
  }
  const stat = fs.statSync(selected);
  if (!stat.isFile() || stat.size > 128 * 1024) throw new Error('Handset files must be smaller than 128 KB.');
  const manifest = JSON.parse(fs.readFileSync(selected, 'utf8')) as unknown;
  const spec = registerHandsetFile(manifest);
  fs.mkdirSync(importedHandsetsDir(), { recursive: true });
  fs.writeFileSync(path.join(importedHandsetsDir(), `${spec.id}.octophone.json`), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return spec;
}

function importHandsetDirectory(selected: string) {
  if (!path.isAbsolute(selected) || !fs.statSync(selected).isDirectory()) throw new Error('Choose a handset manifest directory.');
  const files = fs.readdirSync(selected, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.octophone.json'))
    .map((entry) => path.join(selected, entry.name))
    .slice(0, 100);
  if (!files.length) throw new Error('That folder contains no .octophone.json handset files.');
  const imported = [];
  const errors: string[] = [];
  for (const file of files) {
    try { imported.push(importHandsetPath(file)); }
    catch (error) { errors.push(`${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (!imported.length) throw new Error(errors.slice(0, 3).join(' '));
  return { imported, errors: errors.slice(0, 10) };
}

async function ensureVirtualMicrophone(): Promise<void> {
  if (process.platform !== 'win32' || await vbCableInstalledAsync()) return;
  // Requested launch-time preparation: use VB-Audio's hidden installer mode.
  // UAC can still appear because Windows audio drivers require consent.
  await installMediaRequirement('microphone').catch(() => undefined);
}

function loadImportedHandsets(): void {
  if (importedHandsetsLoaded) return;
  importedHandsetsLoaded = true;
  try {
    for (const name of fs.readdirSync(importedHandsetsDir())) {
      if (!name.toLowerCase().endsWith('.octophone.json')) continue;
      try { registerHandsetFile(JSON.parse(fs.readFileSync(path.join(importedHandsetsDir(), name), 'utf8'))); } catch { /* one bad user file must not hide the catalogue */ }
    }
  } catch { /* no imported handset folder yet */ }
}

interface Child {
  proc: ChildProcess;
  channel: MessageChannel;
  ready: boolean;
  readyPromise: Promise<boolean>;
  resolveReady: (ready: boolean) => void;
  startedAt: number;
  stopping?: boolean;
  /** Bound startup so a broken child can never leave the launcher on Starting. */
  readyTimer?: NodeJS.Timeout;
  /** Avoid showing a second error when a timed-out/failed spawn subsequently exits. */
  startFailed?: boolean;
  /** The profile installed its message listener and may safely receive the DEK. */
  initialized?: boolean;
  killTimer?: NodeJS.Timeout;
}

interface ProfileRequestWaiter {
  profileId: string;
  responseType: 'fingerprint-audit-result' | 'fingerprint-tests-opened' | 'profile-cookies';
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const PROFILE_READY_TIMEOUT_MS = 30_000;
const DOLPHIN_API_URL = 'https://dolphin-anty-api.com';
const DOLPHIN_SYNC_API_URL = 'https://darkwing.dolphin-anty-api.com/api/v1';

/** Packaged resources plus the checked-out resources tree used by Linux dev runs. */
function engineResourceRoots(): string[] {
  return [...new Set([process.resourcesPath, path.join(process.cwd(), 'resources')])];
}

function isCrossDeviceError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as NodeJS.ErrnoException;
  return e.code === 'EXDEV' || /cross[- ]device|different volume|跨设备/i.test(String(e.message ?? ''));
}

function volumeRoot(value: string): string {
  return path.parse(path.resolve(value)).root.toLowerCase();
}

function directoryManifest(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const childRel = rel ? path.join(rel, name) : name;
      const stat = fs.lstatSync(abs);
      if (stat.isDirectory()) { out.push(`d:${childRel}`); walk(abs, childRel); }
      else if (stat.isSymbolicLink()) out.push(`l:${childRel}:${fs.readlinkSync(abs)}`);
      else out.push(`f:${childRel}:${stat.size}`);
    }
  };
  walk(root, '');
  return out;
}

/** Copy, verify, and publish a directory without ever deleting the source first. */
function copyDirectoryAtomically(source: string, destination: string): void {
  const staging = `${destination}.partial-${process.pid}-${randomBytes(6).toString('hex')}`;
  const backup = `${destination}.backup-${process.pid}-${randomBytes(6).toString('hex')}`;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.cpSync(source, staging, { recursive: true, errorOnExist: false, force: true });
    if (directoryManifest(source).join('\n') !== directoryManifest(staging).join('\n')) throw new Error('Profile copy verification failed.');
    const hadDestination = fs.existsSync(destination);
    if (hadDestination) fs.renameSync(destination, backup);
    try {
      fs.renameSync(staging, destination);
    } catch (error) {
      if (hadDestination && fs.existsSync(backup) && !fs.existsSync(destination)) fs.renameSync(backup, destination);
      throw error;
    }
    if (hadDestination) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
    throw error;
  }
}

/** Move a profile safely across drives/volumes; never surface EXDEV to the user. */
function moveDirectoryAcrossDevices(source: string, destination: string): void {
  const knownDifferentVolume = volumeRoot(source) !== volumeRoot(destination);
  if (!knownDifferentVolume) {
    try { fs.renameSync(source, destination); return; }
    catch (error) { if (!isCrossDeviceError(error)) throw error; }
  }
  copyDirectoryAtomically(source, destination);
  fs.rmSync(source, { recursive: true, force: true });
}

type FileProgress = (completed: number, total: number, label: string) => void;

async function fileList(root: string): Promise<string[]> {
  const result: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) result.push(abs);
    }
  };
  await walk(root);
  return result;
}

async function copyDirectoryWithProgress(source: string, destination: string, progress: FileProgress): Promise<void> {
  const files = await fileList(source);
  await fsp.mkdir(destination, { recursive: true });
  let completed = 0;
  for (const file of files) {
    const target = path.join(destination, path.relative(source, file));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(file, target);
    completed += 1;
    progress(completed, files.length, path.basename(file));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function deleteDirectoryWithProgress(root: string, progress: FileProgress): Promise<void> {
  if (!fs.existsSync(root)) return;
  const files = await fileList(root);
  let completed = 0;
  for (const file of files) {
    try {
      const handle = await fsp.open(file, 'r+');
      try {
        const size = (await handle.stat()).size;
        for (let offset = 0; offset < size; offset += 64 * 1024) {
          const length = Math.min(64 * 1024, size - offset);
          await handle.write(randomBytes(length), 0, length, offset);
        }
        await handle.sync();
      } finally { await handle.close(); }
    } catch { /* locked/read-only files fall back to removal, matching secureDeleteFile */ }
    await fsp.rm(file, { force: true });
    completed += 1;
    progress(completed, files.length, path.basename(file));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await fsp.rm(root, { recursive: true, force: true });
}

/** Proxy chosen in the profile editor / sent to the API. */
export type ProxyInput =
  | { mode: 'none' }
  | { mode: 'new'; text: string; type?: ProxyType; changeIpUrl?: string; name?: string; save?: boolean; lockdown?: boolean }
  | { mode: 'saved'; savedId: string; lockdown?: boolean }
  | { mode: 'keep' };

/** Payload of `mgr:create`: name + kind, optionally a settings patch from the create dialog. */
interface CreateInput {
  name: string;
  kind: ProfileKind;
  patch?: Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt' | 'kind'>>;
  proxy?: ProxyInput;
  /** Exported cookies (JSON or Netscape cookies.txt) to import into the new profile. */
  cookies?: string;
}

export class Manager {
  readonly profiles: ProfileManager;
  readonly proxies: ProxyStore;
  readonly passwords: PasswordStore;
  private readonly updates: UpdateManager;
  private readonly adblock: AdblockService;
  private launcher: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private appQuitting = false;
  private closePromptOpen = false;
  /** Sessions already given the strict launcher-offline request guard. */
  private readonly guardedSessions = new Set<Session>();
  private readonly children = new Map<string, Child>();
  private readonly profileRequestWaiters = new Map<string, ProfileRequestWaiter>();
  /** Vault keys of OPEN encrypted profiles (wiped when sealed). */
  private readonly vaultKeys = new Map<string, Buffer>();
  private idleTimer: NodeJS.Timeout | null = null;
  private api: ApiServer | null = null;
  private apiError = '';
  /** Remote-debugging ports of profiles started for automation. */
  private readonly debugPorts = new Map<string, number>();
  /** Native Chromium windows with contract-backed CDP tab control. */
  private readonly nativeChromium = new Map<string, { engine: NativeEngineProcess; tabs: NativeChromiumTabs; startedAt: number; runtimeVersion: string }>();
  /** Native Gecko processes launched for Firefox-base profiles. */
  private readonly nativeFirefox = new Map<string, { engine: NativeEngineProcess; bidi: FirefoxBidi; startedAt: number; runtimeVersion: string }>();
  private locking = false;
  /** Dead man's switch: no browser profile and no Android device may use the net. */
  private killSwitchOn = false;

  constructor(private readonly ctx: AppContext) {
    this.profiles = new ProfileManager(ctx.layout, ctx.secrets);
    this.proxies = new ProxyStore(ctx.layout, ctx.secrets);
    this.passwords = new PasswordStore(ctx.layout, ctx.secrets);
    setEngineVersion(process.versions.chrome);
    this.updates = new UpdateManager(APPS.octobrowser, ctx.layout, ctx.settings, ctx.logger, ctx.lang);
    this.adblock = new AdblockService(ctx.layout.filters, path.join(ctx.prep.distDir, 'assets', 'baseline-filters.txt'), ctx.logger);
  }

  private get t() {
    return this.ctx.t;
  }

  private servicesOffline(): boolean {
    return appServicesOffline(this.ctx.settings.load());
  }

  /**
   * Throw or release the dead man's switch. Every running browser profile is
   * told to cancel its requests and close its sockets, and every Android
   * device adb can see has its radios and packet path cut. Turning it off puts
   * the Android radios back; browsers resume immediately.
   */
  async setKillSwitch(on: boolean): Promise<{ on: boolean; devices: number; failed: string[] }> {
    this.killSwitchOn = on;
    for (const child of this.children.values()) {
      try { child.channel.send({ t: 'kill-switch', on }); } catch { /* profile is gone */ }
    }
    let devices = 0;
    let failed: string[] = [];
    try { const result = await setAllAndroidNetworkOff(on); devices = result.devices; failed = result.failed; }
    catch { failed = ['adb']; }
    this.ctx.logger.warn('net.kill-switch', { on, devices, failed: failed.length });
    this.launcher?.webContents.send('mgr:kill-switch', { on, devices, failed });
    return { on, devices, failed };
  }

  /** Reject user-initiated launcher requests that would leave the computer. */
  private requireOnline(): void {
    if (this.servicesOffline()) throw new Error(this.t('settings.offlineActionBlocked'));
  }

  /**
   * Strict mode keeps a deny-by-default guard on every session owned by the
   * launcher. It deliberately leaves profile-process sessions alone: profiles
   * are separate browser processes and their traffic is the user's browsing.
   */
  private guardLauncherSession(ses: Session): Session {
    if (this.guardedSessions.has(ses)) return ses;
    this.guardedSessions.add(ses);
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (!strictOffline(this.ctx.settings.load())) { callback({}); return; }
      try {
        const url = new URL(details.url);
        const local = (url.protocol === 'http:' || url.protocol === 'https:')
          && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]');
        if (local || ['file:', 'data:', 'blob:', 'devtools:', 'chrome-extension:', 'octo:'].includes(url.protocol)) { callback({}); return; }
      } catch { /* malformed requests are denied below */ }
      callback({ cancel: true });
    });
    return ses;
  }

  /** Start the profile manager and invoke `onLauncherReady` when its UI can be shown. */
  start(onLauncherReady?: () => void): void {
    this.guardLauncherSession(session.defaultSession);
    const names = Object.fromEntries(PROFILE_KINDS.map((k) => [k, this.t(`profile.kind.${k}`)])) as Record<ProfileKind, string>;
    // First run: one ready-to-use antidetect profile (works like a normal browser).
    this.profiles.ensureDefaults({ ...names, antidetect: `${this.t('profile.defaultName')} 1` }, ['antidetect']);
    // Profiles restored by restore-profile.bat whose entry had been deleted.
    const restored = this.profiles.adoptRestoredEntries();
    for (const p of restored.adopted) this.ctx.logger.info('profile.restored-entry-adopted', { profile: p.id });
    for (const id of restored.rejected) this.ctx.logger.warn('profile.restored-entry-rejected', { profile: id });
    // Temporary / delete-on-close profiles are wiped at start too (covers crashes).
    this.profiles.cleanupEphemeral();
    for (const p of this.profiles.list()) {
      if (this.profiles.needsResealing(p.id)) this.ctx.logger.warn('vault.unsealed-after-crash', { profile: p.id });
    }
    this.syncMediaPlugins();
    this.registerIpc();
    // Explicit quit/relaunch/reset paths must not be mistaken for a title-bar X.
    app.on('before-quit', () => {
      this.appQuitting = true;
      this.tray?.destroy();
      this.tray = null;
    });
    this.updates.onStatus((s) => {
      this.broadcast({ t: 'update-status', status: s });
      this.launcher?.webContents.send('mgr:update-status', s);
    });
    this.updates.onAppLaunch();
    void this.maybeUpdateFilters();
    this.startAutoLock();
    void this.applyApiSettings();

    const direct = this.profileFromArgv(process.argv);
    if (direct) void this.launch(direct, {});
    this.showLauncher(undefined, onLauncherReady);
    app.on('second-instance', (_e, argv) => {
      const id = this.profileFromArgv(argv);
      if (id) void this.launch(id, {});
      else this.showLauncher();
    });
  }

  /** Supports `octobrowser://open?profile=<id|name>` and `--open-profile=<id>`. */
  private profileFromArgv(argv: string[]): string | null {
    for (const a of argv) {
      let v: string | null = null;
      if (a.startsWith('--open-profile=')) v = a.slice('--open-profile='.length);
      else if (a.toLowerCase().startsWith('octobrowser://')) {
        try { v = new URL(a).searchParams.get('profile'); } catch { v = null; }
      }
      if (v) {
        const p = this.profiles.list().find((x) => x.id === v || x.name.toLowerCase() === v!.toLowerCase());
        if (p) return p.id;
      }
    }
    return null;
  }

  // ------------------------------------------------------------ launcher

  private launcherIcon(): string {
    const active = path.join(this.ctx.prep.distDir, 'assets', 'profile-running.png');
    const nativeChromium = path.join(this.ctx.prep.distDir, 'assets', 'inkbrowser-chrome.png');
    const nativeFirefox = path.join(this.ctx.prep.distDir, 'assets', 'inkbrowser-firefox.png');
    if (this.nativeChromium.size > 0 && fs.existsSync(nativeChromium)) return nativeChromium;
    if (this.nativeFirefox.size > 0 && fs.existsSync(nativeFirefox)) return nativeFirefox;
    return this.children.size > 0 && fs.existsSync(active) ? active : iconPath(this.ctx.prep.distDir);
  }

  /** Show the classic Octo mark with a profile badge while profiles run. */
  private updateLauncherIcon(): void {
    const image = this.launcherIcon();
    if (this.launcher && !this.launcher.isDestroyed()) this.launcher.setIcon(image);
    if (this.tray && !this.tray.isDestroyed()) this.tray.setImage(image);
  }

  /** Keep a hidden launcher reachable when the user chooses Background. */
  private ensureTray(): void {
    if (this.tray || process.platform !== 'win32') return;
    this.tray = new Tray(this.launcherIcon());
    this.tray.setToolTip('Octo.su');
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: this.t('appBackground.show'), click: () => this.showLauncher() },
      { type: 'separator' },
      { label: this.t('appBackground.quit'), click: () => this.beginAppQuit() },
    ]));
    this.tray.on('click', () => this.showLauncher());
  }

  private hideLauncher(): void {
    if (!this.launcher || this.launcher.isDestroyed()) return;
    this.ensureTray();
    this.launcher.hide();
  }

  private beginAppQuit(): void {
    if (this.appQuitting) return;
    this.appQuitting = true;
    this.tray?.destroy();
    this.tray = null;
    this.launcher?.hide();
    for (const child of this.children.values()) child.channel.send({ t: 'quit', reason: 'app-quit' });
    for (const firefox of this.nativeFirefox.values()) void firefox.bidi.close().finally(() => firefox.engine.stop(100));
    for (const chromium of this.nativeChromium.values()) void chromium.tabs.close().finally(() => chromium.engine.stop(100));
    if (!this.children.size && !this.nativeFirefox.size && !this.nativeChromium.size) { app.quit(); return; }
    // Profile shutdown saves session data and has its own hard deadline. This
    // deadline only prevents a broken child from leaving the manager behind.
    setTimeout(() => app.quit(), 9_000).unref();
  }

  /**
   * Ask inside the trusted launcher rather than via Windows' message box. This
   * keeps the quit decision visually consistent with the rest of OctoBrowser
   * and avoids the platform-dependent three-button dialog.
   */
  private decideLauncherClose(win: BrowserWindow): void {
    if (this.closePromptOpen || this.appQuitting) return;
    const action = this.ctx.settings.load().ui.closeAction;
    if (action === 'background') { this.hideLauncher(); return; }
    if (action === 'quit') { this.beginAppQuit(); return; }
    const runningIds = new Set([...this.children.keys(), ...this.nativeFirefox.keys(), ...this.nativeChromium.keys()]);
    // Nothing is running, so there is no session to save and no interruption
    // risk. Close immediately instead of showing a redundant confirmation.
    if (runningIds.size === 0) { this.beginAppQuit(); return; }
    this.closePromptOpen = true;
    const runningProfiles = this.profiles.list().filter((profile) => runningIds.has(profile.id));
    win.webContents.send('mgr:app-close-request', {
      count: runningIds.size,
      names: runningProfiles.map((profile) => profile.name).slice(0, 8),
    });
    // If the renderer is reloading or unavailable, release the intercepted
    // close after a short grace period rather than trapping the window.
    setTimeout(() => { this.closePromptOpen = false; }, 30_000).unref();
  }

  private answerLauncherClose(choice: 'quit' | 'cancel'): void {
    if (!this.closePromptOpen) return;
    this.closePromptOpen = false;
    if (choice === 'quit') this.beginAppQuit();
  }

  showLauncher(tab?: string, onReady?: () => void): void {
    if (this.launcher && !this.launcher.isDestroyed()) {
      if (this.launcher.isMinimized()) this.launcher.restore();
      this.launcher.show();
      this.launcher.focus();
      if (tab) this.launcher.webContents.send('mgr:show-tab', tab);
      return;
    }
    const distDir = this.ctx.prep.distDir;
    const chrome = launcherChrome(this.ctx.settings.load().ui.theme);
    this.launcher = new BrowserWindow({
      // A wider, slightly taller base window: the profile table, the proxy
      // table and the side panel all fit without a maximised window.
      width: 1440,
      height: 880,
      minWidth: 1040,
      minHeight: 660,
      show: false,
      backgroundColor: chrome.color,
      // The renderer owns the title bar. Native overlay controls would create
      // a second button set over the app content.
      titleBarStyle: 'hidden',
      titleBarOverlay: false,
      backgroundMaterial: process.platform === 'win32' ? 'mica' : 'none',
      title: 'Octo.su',
      icon: this.launcherIcon(),
      autoHideMenuBar: true,
      webPreferences: {
        ...SAFE_WEB_PREFERENCES,
        webgl: this.ctx.settings.load().privacyRuntime?.graphicsExposure !== 'block',
        preload: path.join(distDir, 'preload-launcher.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
      },
    });
    trustWebContents(this.launcher.webContents);
    // The launcher may preview a host camera, so the user can check the
    // vStudio Mobile feed without booting a device. Every other permission
    // this window could ask for is refused.
    this.launcher.webContents.session.setPermissionRequestHandler((_contents, permission, callback) => {
      callback(permission === 'media');
    });
    this.launcher.webContents.session.setPermissionCheckHandler((_contents, permission) => permission === 'media');
    this.launcher.on('close', (event) => {
      if (this.appQuitting) return;
      event.preventDefault();
      void this.decideLauncherClose(this.launcher!);
    });
    this.launcher.once('ready-to-show', () => {
      this.launcher?.show();
      onReady?.();
    });
    void this.launcher.loadFile(path.join(distDir, 'renderer', 'launcher.html'), { query: tab ? { tab } : {} });
    this.launcher.on('closed', () => {
      this.launcher = null;
      if (this.appQuitting || this.children.size === 0) app.quit();
    });
  }

  /**
   * Install the app stores/browsers that were ticked in the creator, once the
   * device answers adb. Runs in the background: a slow boot must not hold the
   * launch call, and a failure here is reported, never fatal.
   */
  private async installQueuedApps(name: string): Promise<void> {
    const launchPrefs = androidLaunchPrefs(name);
    const queued = launchPrefs.apps ?? [];
    let serial = '';
    for (let attempt = 0; attempt < 60 && !serial; attempt++) {
      await new Promise((done) => setTimeout(done, 5000));
      serial = await androidSerialFor(name).catch(() => '');
    }
    if (!serial) return;
    // Wait for Android itself, not just for adb.
    let ready = false;
    for (let attempt = 0; attempt < 24 && !ready; attempt++) {
      const booted = await new Promise<string>((resolve) => {
        execFile(adbPath(), ['-s', serial, 'shell', 'getprop', ['sys', 'boot_completed'].join('.')],
          { windowsHide: true, timeout: 10_000 }, (_error, stdout) => resolve(String(stdout ?? '').trim()));
      });
      ready = booted === '1';
      if (!ready) await new Promise((done) => setTimeout(done, 5000));
    }
    // Android never grants the Camera app its camera or microphone on its own:
    // until it does, the app shows "Permission denied". Grant them now that
    // Android is up, read them back, and say so when a grant is refused.
    try {
      if (!ready) throw new Error('Android did not finish starting in time');
      const media = await grantAndroidMediaPermissions(name, serial);
      if (!media.ok) {
        const reason = media.permissions.filter((item) => !item.granted)
          .map((item) => `${item.permission.replace('android.permission.', '')}: ${item.reason}`).join('; ');
        this.launcher?.webContents.send('mgr:toast', { key: 'android.media.permissionFailed', params: { reason }, kind: 'err' });
      }
    } catch (error) {
      this.launcher?.webContents.send('mgr:toast', { key: 'android.media.permissionFailed',
        params: { reason: error instanceof Error ? error.message : String(error) }, kind: 'err' });
    }
    // While we are here and Android is up: make it say which handset it is.
    // A refusal is said out loud, not dropped. Only a device with no stored
    // identity stays silent, because there was nothing to apply.
    try {
      const identity = await applyDeviceIdentity(name);
      if (identity.changed.length) this.launcher?.webContents.send('mgr:android-identity-applied', { name, message: identity.message });
      else if (!identity.ok && !identity.nothingStored) this.launcher?.webContents.send('mgr:toast', { key: 'android.identity.notApplied', params: { reason: identity.message }, kind: 'err' });
    } catch (error) {
      this.launcher?.webContents.send('mgr:toast', { key: 'android.identity.notApplied', params: { reason: error instanceof Error ? error.message : String(error) }, kind: 'err' });
    }
    setAndroidProgressSink((progress: AndroidProgress) => this.launcher?.webContents.send('mgr:android-progress', progress));
    try {
      if (!queued.length) return;
      const results = await installAndroidStores({
        adb: adbPath(), serial, stores: queued, files: launchPrefs.appFiles, samsung: /samsung|galaxy/i.test(name),
        onProgress: (text, percent) => reportAndroidProgress({ stage: 'install', percent, text }),
      });
      rememberAndroidLaunch(name, { apps: [], appFiles: {} });
      this.launcher?.webContents.send('mgr:android-apps-installed', { name, results });
    } catch { /* the device is up; the apps can be installed by hand */ }
    finally { setAndroidProgressSink(null); }
  }

  private pushProfiles(): void {
    this.launcher?.webContents.send('mgr:profiles', this.profileList());
  }

  private fileProgress(operation: 'move' | 'delete', completed: number, total: number, label = ''): void {
    this.launcher?.webContents.send('mgr:file-progress', {
      operation, completed, total, label,
      percent: total > 0 ? Math.min(99, Math.round((completed / total) * 100)) : -1,
    });
  }

  private profileList(trashed = false, archived = false) {
    const profiles = trashed ? this.profiles.listTrash() : archived ? this.profiles.listArchived() : this.profiles.list();
    return profiles.map((p) => ({
      ...p,
      running: !trashed && !archived && this.isRunning(p.id),
      ready: !trashed && !archived && (this.children.get(p.id)?.ready ?? (this.nativeChromium.has(p.id) || this.nativeFirefox.has(p.id))),
      stopping: !trashed && !archived && (this.children.get(p.id)?.stopping ?? false),
      startedAt: !trashed && !archived ? (this.children.get(p.id)?.startedAt ?? this.nativeChromium.get(p.id)?.startedAt ?? this.nativeFirefox.get(p.id)?.startedAt ?? 0) : 0,
      sealed: trashed || archived ? false : this.profiles.isVaultLocked(p.id),
      hasVault: trashed || archived ? false : this.profiles.hasVault(p.id),
      needsResealing: trashed || archived ? false : this.profiles.needsResealing(p.id),
      issues: trashed || archived ? [] : checkConsistency(effectiveSettings(p.protection), { extensionsCount: p.addons.length, proxyActive: p.network.mode === 'proxy' }),
      hasProxyCredentials: this.ctx.secrets.has(`proxy:${p.id}`),
      pendingCookies: this.ctx.secrets.has(`cookies:${p.id}`),
      fingerprintWarnings: trashed || archived ? [] : fingerprintWarnings(p.fingerprint, engineVersion().major),
    }));
  }

  // -------------------------------------------------------------- launch

  isolation(id: string) {
    const p = this.profiles.get(id);
    return describeIsolation(p, {
      downloadsDir: this.ctx.layout.profileDownloadsDir(id),
      windowsSandboxAvailable: windowsSandboxAvailable(),
      vpnDetected: detectVpnAdapters(os.networkInterfaces()).length > 0,
    });
  }

  /**
   * Start a profile. Returns a status the launcher UI reacts to
   * (passphrase needed, Tor Browser missing, Windows Sandbox unavailable...).
   */
  /**
   * Mirror the Settings switches into the media plugin layer. vStudio Mobile
   * serves Android devices, vStudio Web serves browser profiles; a plugin that
   * is off is stopped here and can no longer be prepared or started.
   */
  syncMediaPlugins(): void {
    const plugins = this.ctx.settings.load().plugins;
    for (const id of MEDIA_PLUGIN_IDS) setMediaPluginEnabled(id, mediaPluginEnabled(plugins, id));
  }

  /**
   * Give every Octo browser profile the clearly named vStudio Web endpoint.
   * Preparation is deliberately detached from the launch IPC response: the
   * optional 20 MB companion must never freeze the launcher or delay the
   * browser window while it is refreshed after an application update.
   */
  private startWebMedia(p: Profile, customLabel = '', force = false): void {
    if (!force && !p.vstudioWebOnLaunch) return;
    if (!mediaPluginActive('vstudio-web')) {
      this.ctx.settings.update((s) => { s.plugins['vstudio-web'].enabled = true; });
      setMediaPluginEnabled('vstudio-web', true);
    }
    // Keep one stable OS endpoint name across Chrome/Chromium/Firefox/Safari
    // shells. The profile remains available in metadata, not in a device name
    // that changes underneath website preferences on every launch.
    const endpoint = 'vStudio Web Octo browsers';
    const profileLabel = customLabel.trim().slice(0, 64) || p.name;
    void startWebMediaCompanionAsync({ profileName: profileLabel, cameraName: `${endpoint} Camera`, microphoneName: `${endpoint} Microphone` })
      .then((result) => this.ctx.logger.info('vstudio-web.started', { profile: p.id, started: result.started }))
      .catch((error: unknown) => {
        // The profile must still start: a missing Python or bundle is a plugin
        // problem, never a reason to block browsing.
        this.ctx.logger.warn('vstudio-web.failed', { profile: p.id, error: error instanceof Error ? error.message : String(error) });
      });
  }

  /** vStudio Web only exists for profiles: with none running it is stopped. */
  private stopWebMediaIfIdle(): void {
    if (this.children.size === 0) { try { stopMediaCompanion('vstudio-web'); } catch { /* already gone */ } }
  }

  /** Opens an encrypted profile's vault before its data is used. Returns the status that stops the launch, or null. */
  private async openVaultForLaunch(id: string, p: Profile, passphrase?: string): Promise<{ status: string } | null> {
    if (!p.encrypted || !this.profiles.hasVault(id) || this.vaultKeys.has(id)) return null;
    if (!passphrase) return { status: 'need-passphrase' };
    try {
      const key = await this.profiles.deriveVaultKey(id, passphrase);
      this.profiles.openVault(id, key);
      this.vaultKeys.set(id, key);
      return null;
    } catch (err) {
      if (err instanceof DecryptionError) return { status: 'wrong-passphrase' };
      throw err;
    }
  }

  async launch(id: string, opts: { passphrase?: string; forceRestricted?: boolean; debugPort?: number }): Promise<{ status: string; detail?: string }> {
    let p = this.profiles.get(id);
    const running = this.children.get(id);
    if (running) {
      running.channel.send({ t: 'focus' });
      return { status: 'focused' };
    }
    // Older profiles may still carry an Electron page-shim fingerprint after
    // being switched to a native engine. Migrate that stale flag before the
    // native compatibility gate; never refuse a profile for a setting that is
    // no longer applicable to its selected engine.
    if (browserEngineFor(p.engine) !== 'electron' && p.fingerprint?.enabled === true) {
      this.profiles.update(id, { fingerprint: { ...p.fingerprint, enabled: false } });
      p = this.profiles.get(id);
      this.ctx.logger.info('profile.native-fingerprint-migrated', { profile: id, engine: browserEngineFor(p.engine) });
      this.pushProfiles();
    }

    // InkBrowser: the standalone Chromium base, started as its own process in its own profile folder.
    // OctoBrowser cannot apply its fingerprint, proxy, page shim, kill switch or sandboxes to it,
    // so a profile that depends on any of them is refused instead of run without them.
    if (browserEngineFor(p.engine) === 'inkbrowser' && p.kind !== 'tor' && p.protection.level !== 'tor') {
      const blocks = inkbrowserBlocks({
        kind: p.kind,
        fingerprintEnabled: p.fingerprint?.enabled === true,
        protectionLevel: p.protection.level,
        protectionOverrides: (p.protection.overrides ?? {}) as Record<string, unknown>,
        networkMode: p.network.mode,
        dnsMode: p.dns.mode,
        sandboxMode: p.sandbox.mode,
        firefoxIdentity: p.fingerprint?.browserIdentity === 'firefox' || p.fingerprint?.browserIdentity === 'firefox-esr',
        windowsIsolation: this.ctx.settings.load().privacyRuntime.windowsIsolation === 'sandbox-no-vgpu',
        killSwitchOn: this.killSwitchOn,
      });
      if (blocks.length) return { status: 'inkbrowser-conflict', detail: blocks.join(',') };
      const gate = await this.openVaultForLaunch(id, p, opts.passphrase);
      if (gate) return gate;
      let exe: string | null = null;
      try {
        const env = { ...process.env, OCTO_CHROMIUM_RUNTIME: path.join(this.ctx.layout.engine, 'runtimes', 'chromium') };
        let discovered: string | null = null;
        for (const resourcesPath of engineResourceRoots()) {
          try {
            discovered = discoverEngineRuntime('chromium', { resourcesPath, env, version: p.chromiumRuntime ?? DEFAULT_CHROMIUM_VERSION }).executablePath;
            break;
          } catch { /* try the next trusted root */ }
        }
        if (!discovered) throw new EngineRunnerError('runtime-missing', 'No packaged Chromium runtime found');
        exe = discovered;
      } catch (error) {
        // Development installations may still use the historical per-user
        // InkBrowser location. Packaged builds must provide runtime.json and
        // therefore do not silently accept an arbitrary browser directory.
        if (!(error instanceof EngineRunnerError) || error.code !== 'runtime-missing') throw error;
        exe = findInkBrowser();
      }
      if (!exe) return { status: 'inkbrowser-missing' };
      const profileFolder = path.join(this.ctx.layout.profileEngineDir(p.id), 'inkbrowser-profile');
      prepareChromiumPrivacy(profileFolder, p.enginePrivacy.chromium);
      const debugPort = await this.freePort();
      let restoreUrls: string[] = [];
      let restoreActiveIndex = 0;
      if (p.restoreSession && !p.deleteOnClose) {
        try {
          const saved = new ProfileData(this.ctx.layout, p.id, () => this.ctx.keyring.getKey()).session.load();
          restoreUrls = (saved?.tabs ?? []).map((tab) => tab.url).filter((url) => /^https?:\/\//i.test(url)).slice(0, 50);
          restoreActiveIndex = Math.max(0, Math.min(saved?.activeIndex ?? 0, Math.max(0, restoreUrls.length - 1)));
        } catch (error) { this.ctx.logger.warn('native-chromium.session-restore-failed', { profile: p.id, error }); }
      }
      const engine = await spawnNativeEngine('chromium', exe, {
        profileDir: profileFolder,
        url: restoreUrls[0] ?? (/^https?:\/\//i.test(p.homePage) ? p.homePage : 'about:blank'),
        debugPort,
        headless: false,
        appMode: p.appMode,
        extraArgs: chromiumPrivacyArgs(p.enginePrivacy.chromium),
      });
      const tabs = await NativeChromiumTabs.connect(debugPort);
      const restoredTabs = [await tabs.activeTab()];
      for (const url of restoreUrls.slice(1)) restoredTabs.push(await tabs.newTab(url, false));
      if (restoredTabs[restoreActiveIndex]) await tabs.activateTab(restoredTabs[restoreActiveIndex].id);
      const native = { engine, tabs, startedAt: Date.now(), runtimeVersion: p.chromiumRuntime ?? DEFAULT_CHROMIUM_VERSION };
      this.nativeChromium.set(p.id, native);
      this.debugPorts.set(p.id, debugPort);
      engine.child.once('exit', (code, signal) => {
        if (this.nativeChromium.get(p.id) !== native) return;
        this.nativeChromium.delete(p.id);
        this.debugPorts.delete(p.id);
        void tabs.close();
        this.ctx.logger.info('profile.native-chromium-exited', { profile: p.id, code, signal });
        this.pushProfiles();
      });
      this.profiles.setLastUsed(id);
      this.pushProfiles();
      this.ctx.logger.info('profile.native-chromium-launched', { profile: p.id });
      return { status: 'inkbrowser-launched' };
    }

    // Firefox Base launches a real Gecko desktop process. Prefer the verified
    // packaged/user-installed catalog runtime, then an explicitly configured
    // system Firefox. Never fall back to Chromium or Electron.
    if (browserEngineFor(p.engine) === 'firefox' && p.kind !== 'tor' && p.protection.level !== 'tor') {
      const configured = this.ctx.settings.load().firefox.firefoxPath;
      let executable: string | null = null;
      for (const resourcesPath of engineResourceRoots()) {
        executable = discoverFirefoxRuntime(resourcesPath, path.join(this.ctx.layout.engine, 'runtimes', 'gecko'));
        if (executable) break;
      }
      // A source checkout or an incomplete installer may not have a packaged
      // Gecko tree yet. Both supported desktop platforms can repair that state
      // with the pinned, checksum-verified catalog artifact. Never substitute
      // Chromium or Electron when this repair fails.
      if (!executable && (process.platform === 'linux' || process.platform === 'win32')) {
        try {
          const entry = geckoCatalogEntry();
          executable = installFirefoxRuntime(entry, path.join(this.ctx.layout.engine, 'runtimes', 'gecko')).executablePath;
          this.ctx.logger.info('profile.firefox-runtime-installed', { version: entry.version, executable });
        } catch (error) {
          this.ctx.logger.warn('profile.firefox-runtime-install-failed', { error: error instanceof Error ? error.message : String(error), diagnostic: inspectFirefoxRuntime('', path.join(this.ctx.layout.engine, 'runtimes', 'gecko')) });
        }
      }
      if (!executable) {
        const available = firefoxAvailability(configured);
        executable = available.available ? available.path : null;
      }
      if (!executable) {
        const diagnostic = inspectFirefoxRuntime('', path.join(this.ctx.layout.engine, 'runtimes', 'gecko'));
        return { status: 'firefox-engine-unavailable', detail: diagnostic.reason };
      }
      const firefoxProfile = path.join(this.ctx.layout.profileEngineDir(p.id), 'firefox-profile');
      fs.mkdirSync(firefoxProfile, { recursive: true });
      prepareFirefoxPrivacy(firefoxProfile, p.enginePrivacy.firefox);
      const debugPort = await this.freePort();
      let engine: NativeEngineProcess | undefined;
      let bidi: FirefoxBidi | undefined;
      try {
        engine = await spawnNativeEngine('firefox', executable, {
          profileDir: firefoxProfile,
          url: /^https?:\/\//i.test(p.homePage) ? p.homePage : 'about:blank',
          debugPort,
          headless: false,
          appMode: p.appMode,
        });
        bidi = await FirefoxBidi.connect(debugPort);
      } catch (error) {
        if (engine) await engine.stop(1000).catch(() => undefined);
        this.ctx.logger.error('profile.native-firefox-launch-failed', error);
        return { status: 'firefox-launch-failed', detail: error instanceof Error ? error.message : String(error) };
      }
      if (!engine || !bidi) return { status: 'firefox-launch-failed', detail: 'Firefox control channel was not created' };
      const native = { engine, bidi, startedAt: Date.now(), runtimeVersion: path.basename(path.dirname(executable)) };
      this.nativeFirefox.set(p.id, native);
      this.debugPorts.set(p.id, debugPort);
      engine.child.once('exit', (code, signal) => {
        if (this.nativeFirefox.get(p.id) !== native) return;
        this.nativeFirefox.delete(p.id);
        this.debugPorts.delete(p.id);
        void bidi?.close();
        this.ctx.logger.info('profile.native-firefox-exited', { profile: p.id, code, signal });
        this.pushProfiles();
      });
      this.profiles.setLastUsed(id);
      this.pushProfiles();
      this.ctx.logger.info('profile.native-firefox-launched', { profile: p.id, engine: 'firefox' });
      return { status: 'firefox-launched' };
    }

    // Firefox identities are never silently run inside Chromium. The current
    // launcher has no Firefox process adapter, so fail explicitly instead of
    // claiming the requested engine was applied.
    if (p.fingerprint?.browserIdentity === 'firefox' || p.fingerprint?.browserIdentity === 'firefox-esr') {
      const available = firefoxAvailability(this.ctx.settings.load().firefox.firefoxPath);
      if (!available.available || !available.path) return { status: 'firefox-engine-unavailable', detail: available.reason ?? 'not-found' };
      const firefoxProfile = path.join(this.ctx.layout.profileEngineDir(p.id), 'firefox-profile');
      fs.mkdirSync(firefoxProfile, { recursive: true });
      launchFirefox(available.path, firefoxProfile);
      this.ctx.logger.info('profile.firefox-launched', { profile: p.id });
      return { status: 'firefox-launched' };
    }

    // Tor: only the official Tor Browser (no Tor inside Chromium, no extra add-ons).
    if (p.kind === 'tor' || p.protection.level === 'tor') {
      const tor = findTorBrowser(this.ctx.settings.load().tor.torBrowserPath);
      if (!tor) return { status: 'tor-missing' };
      launchDetached(tor, []);
      this.ctx.logger.info('profile.tor-browser-launched');
      return { status: 'tor-launched' };
    }

    const privacyRuntime = this.ctx.settings.load().privacyRuntime;
    if ((p.sandbox.mode === 'windows-sandbox' || privacyRuntime.windowsIsolation === 'sandbox-no-vgpu') && !opts.forceRestricted) {
      if (process.platform !== 'win32' || !windowsSandboxAvailable()) return { status: 'wsb-unavailable' };
      // Windows Sandbox's generated configuration contains <vGPU>Disable</vGPU>.
      return this.launchInWindowsSandbox(p, privacyRuntime.windowsIsolation === 'sandbox-no-vgpu')
        ? { status: 'wsb-launched' }
        : { status: 'wsb-unavailable' };
    }

    if (p.sandbox.mode === 'isolated-vm' && !opts.forceRestricted) {
      await launchProfileInIsolatedVm(p);
      this.ctx.logger.info('profile.isolated-vm-launched', { profile: p.id });
      return { status: 'started' };
    }

    // Encrypted profile: derive + verify key, then decrypt the vault.
    const vaultGate = await this.openVaultForLaunch(id, p, opts.passphrase);
    if (vaultGate) return vaultGate;

    this.startWebMedia(p);
    this.spawnProfile(p, opts.debugPort);
    this.profiles.setLastUsed(id);
    this.pushProfiles();
    return { status: 'started' };
  }

  private spawnProfile(p: Profile, debugPort?: number): void {
    const args = app.isPackaged ? [] : [app.getAppPath()];
    args.push(`--profile-process=${p.id}`);
    if (debugPort) {
      // Automation (API): Chrome DevTools Protocol on loopback for Puppeteer / Playwright.
      args.push(`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1');
      this.debugPorts.set(p.id, debugPort);
    } else this.debugPorts.delete(p.id);
    // Ephemeral session (Windows Sandbox / tests): there is no bootstrap.json, so the
    // child must get the same throw-away data folder and language as the manager.
    const st = this.ctx.prep.state;
    if (this.ctx.prep.ephemeral && st) args.push(`--ephemeral-data-dir=${st.baseDir}`, `--lang-choice=${st.language}`);
    if (this.ctx.settings.load().ui.virtualBoxMode || process.env.OCTO_VM_MODE === '1') {
      args.push('--disable-gpu', '--vm-mode');
    }
    // Node's inherited IPC channel is private to this manager/child pair. A browser
    // profile is a GUI child, never a console tool: stdout/stderr stay ignored so
    // source builds do not leave a Command Prompt visible on Windows.
    const proc = spawn(process.execPath, args, { stdio: channelStdio(false), windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
    const channel = openParentChannel(proc);
    let resolveReady!: (ready: boolean) => void;
    const readyPromise = new Promise<boolean>((resolve) => { resolveReady = resolve; });
    const child: Child = { proc, channel, ready: false, readyPromise, resolveReady, startedAt: Date.now() };
    try {
      const st = p.stats ?? { launches: 0, lastLaunchAt: '', worktimeSec: 0 };
      this.profiles.update(p.id, { stats: { ...st, launches: st.launches + 1, lastLaunchAt: new Date().toISOString() } });
    } catch (err) { this.ctx.logger.warn('profile.stats', err); }
    this.children.set(p.id, child);
    this.updateLauncherIcon();
    // The child first confirms that its listener is installed. This explicit
    // handshake is vital on Windows/Electron where a child can take time to
    // load its bundle: never send the one-shot key until it is listening.
    channel.onMessage((m) => void this.onChildMessage(p.id, m));
    proc.on('exit', (code) => void this.onChildExit(p.id, code, child));
    proc.on('error', (err) => this.onChildSpawnError(p.id, child, err));
    child.readyTimer = setTimeout(() => {
      if (this.children.get(p.id) !== child || child.ready || child.stopping) return;
      child.startFailed = true;
      this.ctx.logger.error('profile.ready-timeout', new Error(`Profile ${p.id} did not become ready within ${PROFILE_READY_TIMEOUT_MS}ms`));
      this.notifyProfileStartFailure('err.profileStartTimeout');
      // The child has not opened a usable profile window. Do not let it hold the
      // row in the transient Starting state forever.
      child.proc.kill();
    }, PROFILE_READY_TIMEOUT_MS);
    this.ctx.logger.info('profile.spawned', { profile: p.id });
  }

  private onChildSpawnError(id: string, child: Child, err: Error): void {
    if (this.children.get(id) !== child || child.startFailed) return;
    child.startFailed = true;
    this.ctx.logger.error('profile.spawn-failed', err);
    this.notifyProfileStartFailure('err.profileStartSpawnFailed');
    // spawn() can emit error without an exit event. Run the normal cleanup now
    // so the row is immediately startable again and an opened vault is resealed.
    void this.onChildExit(id, null, child);
  }

  private notifyProfileStartFailure(detailKey: 'err.profileStartTimeout' | 'err.profileStartSpawnFailed' | 'err.profileStartExited'): void {
    this.launcher?.webContents.send('mgr:toast', { key: 'err.profileStart', params: { message: this.t(detailKey) }, kind: 'err' });
  }

  // ------------------------------------------------------ services (IPC + REST API)

  /** Create a profile (name, kind, settings patch, optional proxy). */
  createProfile(input: CreateInput): Profile {
    if (!PROFILE_KINDS.includes(input.kind)) throw new Error('invalid kind');
    const cookies = input.cookies ? this.parseCookiesOrThrow(input.cookies) : null; // validate BEFORE creating
    const engine = input.patch?.engine ?? NEW_PROFILE_ENGINE;
    const patch = { ...input.patch } as Partial<Profile>;
    if (browserEngineFor(engine) !== 'electron' && patch.fingerprint?.enabled === true) {
      patch.fingerprint = { ...patch.fingerprint, enabled: false };
    }
    this.validateEngineProfileSettings(engine, patch.fingerprint);
    if (input.patch?.profileDirectory) this.validateProfileDirectory(input.patch.profileDirectory);
    const p = this.profiles.create({
      name: String(input.name ?? '').trim().slice(0, 64) || `${this.t('profile.defaultName')} ${this.profiles.list().length + 1}`,
      kind: input.kind,
      patch: { ...patch, engine },
    });
    if (input.proxy && input.proxy.mode !== 'keep' && input.proxy.mode !== 'none') this.setProfileProxy(p.id, input.proxy);
    if (cookies?.length) this.queueCookies(p.id, cookies);
    this.pushProfiles();
    return this.profiles.get(p.id);
  }

  private validateProfileDirectory(value: string): string {
    const target = path.resolve(String(value));
    if (!path.isAbsolute(value) || target === path.parse(target).root) throw new Error('Choose a non-root absolute profile directory.');
    if (target.toLowerCase() === this.ctx.layout.root.toLowerCase()) throw new Error('A profile directory cannot be the application data root.');
    if (fs.existsSync(target)) {
      const stat = fs.statSync(target);
      if (!stat.isDirectory() || fs.readdirSync(target).length) throw new Error('The selected profile directory must be empty or not exist.');
    }
    return target;
  }

  /** Move a closed profile's actual browser data to a user-selected directory. */
  private async moveProfileDirectory(id: string, requested: string, progress?: FileProgress): Promise<Profile> {
    if (this.isRunning(id)) throw new Error(this.t('err.closeProfileFirst'));
    const p = this.profiles.get(id);
    const target = this.validateProfileDirectory(requested);
    const current = this.ctx.layout.profileDir(id);
    if (path.resolve(current).toLowerCase() === target.toLowerCase()) return p;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      if (fs.existsSync(current)) {
        await copyDirectoryWithProgress(current, target, progress ?? (() => undefined));
        await deleteDirectoryWithProgress(current, progress ?? (() => undefined));
      } else await fsp.mkdir(target, { recursive: true });
      const updated = this.profiles.update(id, { profileDirectory: target });
      this.ctx.layout.setProfileDirectory(id, target);
      return updated;
    } catch (error) {
      if (fs.existsSync(target) && !fs.existsSync(current)) {
        try {
          moveDirectoryAcrossDevices(target, current);
        } catch { /* preserve the original error */ }
      }
      throw error;
    }
  }

  private async moveFolderDirectory(folder: string, root: string, progress?: FileProgress): Promise<{ moved: number; path: string }> {
    const base = path.resolve(String(root));
    if (!path.isAbsolute(root) || base === path.parse(base).root) throw new Error('Choose a non-root destination folder.');
    const profiles = this.profiles.list().filter((p) => p.folder === folder);
    if (profiles.some((p) => this.isRunning(p.id))) throw new Error(this.t('err.closeProfileFirst'));
    let moved = 0;
    for (const p of profiles) { await this.moveProfileDirectory(p.id, path.join(base, p.id), progress); moved++; }
    return { moved, path: base };
  }

  private parseCookiesOrThrow(text: unknown): ImportedCookie[] {
    const r = parseCookies(typeof text === 'string' ? text : JSON.stringify(text ?? ''));
    if (!r.ok) throw new Error(this.t(r.error ?? 'cookies.err.format'));
    return r.cookies;
  }

  /**
   * Import cookies into a profile. A running profile gets them immediately;
   * otherwise they wait (encrypted, in the secret store) for the next start.
   */
  importCookies(id: string, text: unknown): { imported: number; applied: 'now' | 'next-start' } {
    this.profiles.get(id); // throws if unknown
    const list = this.parseCookiesOrThrow(text);
    const child = this.children.get(id);
    if (child?.ready) {
      child.channel.send({ t: 'import-cookies', cookies: list });
      return { imported: list.length, applied: 'now' };
    }
    this.queueCookies(id, list);
    return { imported: list.length, applied: 'next-start' };
  }

  private queueCookies(id: string, list: ImportedCookie[]): void {
    const key = `cookies:${id}`;
    const activeKey = `active-cookies:${id}`;
    let pending: ImportedCookie[] = [];
    try { pending = JSON.parse(this.ctx.secrets.get(key) ?? '[]') as ImportedCookie[]; } catch { pending = []; }
    const byKey = new Map<string, ImportedCookie>();
    for (const c of [...pending, ...list]) byKey.set(`${c.name}\u0000${c.domain ?? c.url}\u0000${c.path}`, c); // later import wins
    const saved = [...byKey.values()].slice(-MAX_COOKIES);
    const json = JSON.stringify(saved);
    this.ctx.secrets.set(key, json);
    this.ctx.secrets.set(activeKey, json);
  }

  async getProfileCookies(id: string): Promise<{ ok: boolean; count: number; cookies: string; format: string }> {
    try {
      this.profiles.get(id); // throws if unknown
    } catch {
      return { ok: false, count: 0, cookies: '', format: '' };
    }
    const activeKey = `active-cookies:${id}`;
    const key = `cookies:${id}`;

    // 1. If profile is running, ask the child runtime directly
    const child = this.children.get(id);
    if (child?.ready && child.channel && !child.channel.isClosed) {
      try {
        const msg = await this.requestProfileChild(id, child, 'get-cookies', 'profile-cookies', {});
        const cookies = (msg.cookies as ImportedCookie[]) ?? [];
        if (cookies.length > 0) {
          const json = JSON.stringify(cookies, null, 2);
          this.ctx.secrets.set(activeKey, JSON.stringify(cookies));
          return { ok: true, count: cookies.length, cookies: json, format: 'json' };
        }
      } catch { /* fallback to stored secrets */ }
    }

    // 2. Read stored active-cookies or pending cookies from secret store
    const raw = this.ctx.secrets.get(activeKey) ?? this.ctx.secrets.get(key);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return { ok: true, count: parsed.length, cookies: JSON.stringify(parsed, null, 2), format: 'json' };
        }
      } catch {
        const parsed = parseCookies(raw);
        if (parsed.ok && parsed.cookies.length > 0) {
          return { ok: true, count: parsed.cookies.length, cookies: JSON.stringify(parsed.cookies, null, 2), format: parsed.format };
        }
      }
    }

    return { ok: true, count: 0, cookies: '', format: '' };
  }

  /** Number of cookies waiting for the next start of the profile. */
  pendingCookies(id: string): number {
    try { return (JSON.parse(this.ctx.secrets.get(`cookies:${id}`) ?? '[]') as unknown[]).length; } catch { return 0; }
  }

  private saveFingerprintError(profile: Profile, detail: Record<string, unknown>): string | undefined {
    try {
      this.ctx.layout.ensure(['errors']);
      const file = path.join(this.ctx.layout.errors, `fingerprint-${profile.id}-${Date.now()}-${randomBytes(3).toString('hex')}.json`);
      fs.writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), profileId: profile.id, profileName: profile.name, ...detail }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      this.ctx.logger.warn('fingerprint.audit.failure', { profile: profile.id, file: path.basename(file) });
      return file;
    } catch (error) {
      this.ctx.logger.error('fingerprint.audit.error-report-failed', { profile: profile.id, error: String(error) });
      return undefined;
    }
  }

  private diagnosticFailure(profile: Profile, status: string, message: string): FingerprintAuditResponse {
    const errorFile = this.saveFingerprintError(profile, { status, message: message.slice(0, 1000) });
    return { ok: false, status, message, profileName: profile.name, ...(errorFile ? { errorFile } : {}) };
  }

  private async ensureDiagnosticChild(profile: Profile, passphrase?: string): Promise<{ child: Child } | { failure: FingerprintAuditResponse }> {
    if (profile.kind === 'tor' || profile.protection.level === 'tor' || profile.sandbox.mode === 'windows-sandbox') {
      return { failure: this.diagnosticFailure(profile, 'unsupported-engine', 'This profile uses an external engine that OctoBrowser cannot inspect through its private profile runtime.') };
    }
    let child = this.children.get(profile.id);
    if (child?.stopping) return { failure: this.diagnosticFailure(profile, 'profile-stopping', 'The selected profile is closing. Start it again before running this check.') };
    if (!child) {
      const launched = await this.launch(profile.id, { passphrase });
      if (launched.status !== 'started' && launched.status !== 'focused') {
        return { failure: this.diagnosticFailure(profile, launched.status, launched.detail || `The selected profile could not be opened (${launched.status}).`) };
      }
      child = this.children.get(profile.id);
    }
    if (!child) return { failure: this.diagnosticFailure(profile, 'profile-not-started', 'OctoBrowser did not create a runtime for the selected profile.') };
    if (!child.ready) {
      let timer: NodeJS.Timeout | undefined;
      const ready = await Promise.race([
        child.readyPromise,
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), PROFILE_READY_TIMEOUT_MS + 1500); }),
      ]);
      if (timer) clearTimeout(timer);
      if (!ready || this.children.get(profile.id) !== child || child.stopping) {
        return { failure: this.diagnosticFailure(profile, 'profile-not-ready', 'The selected profile did not finish opening in time.') };
      }
    }
    return { child };
  }

  private requestProfileChild(
    profileId: string,
    child: Child,
    requestType: 'fingerprint-audit' | 'open-fingerprint-test-sites' | 'get-cookies',
    responseType: ProfileRequestWaiter['responseType'],
    payload: Record<string, unknown>,
  ): Promise<Message> {
    const requestId = randomBytes(12).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.profileRequestWaiters.delete(requestId);
        reject(new Error('The selected profile did not reply to the diagnostic request in time.'));
      }, 30_000);
      this.profileRequestWaiters.set(requestId, { profileId, responseType, resolve, reject, timer });
      if (child.channel.isClosed) {
        clearTimeout(timer);
        this.profileRequestWaiters.delete(requestId);
        reject(new Error('The selected profile communication channel is closed.'));
        return;
      }
      child.channel.send({ t: requestType, id: profileId, requestId, ...payload });
    });
  }

  async runFingerprintAudit(id: string, passphrase?: string): Promise<FingerprintAuditResponse> {
    const profile = this.profiles.get(id);
    let ready: Awaited<ReturnType<Manager['ensureDiagnosticChild']>>;
    try { ready = await this.ensureDiagnosticChild(profile, passphrase); }
    catch (error) { return this.diagnosticFailure(profile, 'profile-start-failed', error instanceof Error ? error.message : String(error)); }
    if ('failure' in ready) return ready.failure;
    try {
      const reply = await this.requestProfileChild(id, ready.child, 'fingerprint-audit', 'fingerprint-audit-result', {});
      if (reply.ok !== true || !reply.report || typeof reply.report !== 'object') {
        return this.diagnosticFailure(profile, 'audit-failed', String(reply.error ?? 'The profile did not return a valid read-back report.'));
      }
      const report = reply.report as FingerprintAuditReport;
      const needsReport = report.summary !== 'no-mismatch' || report.errors.length > 0;
      const errorFile = needsReport ? this.saveFingerprintError(profile, { kind: 'fingerprint-audit', report }) : undefined;
      const finalReport = { ...report, ...(errorFile ? { errorFile } : {}) };
      return { ok: true, status: report.summary, profileName: profile.name, report: finalReport, ...(errorFile ? { errorFile } : {}) };
    } catch (error) {
      return this.diagnosticFailure(profile, 'audit-failed', error instanceof Error ? error.message : String(error));
    }
  }

  async openFingerprintTests(id: string, requested: string[], passphrase?: string): Promise<FingerprintAuditResponse> {
    const profile = this.profiles.get(id);
    const sites = [...new Set((Array.isArray(requested) ? requested : []).filter((site): site is FingerprintTestSiteId =>
      typeof site === 'string' && Object.prototype.hasOwnProperty.call(FINGERPRINT_TEST_SITES, site)))];
    if (!sites.length) return this.diagnosticFailure(profile, 'no-test-sites', 'Choose at least one supported fingerprint test site.');
    if (this.ctx.settings.load().offline) return this.diagnosticFailure(profile, 'offline', 'External test sites cannot load while offline mode is enabled.');
    let ready: Awaited<ReturnType<Manager['ensureDiagnosticChild']>>;
    try { ready = await this.ensureDiagnosticChild(profile, passphrase); }
    catch (error) { return this.diagnosticFailure(profile, 'profile-start-failed', error instanceof Error ? error.message : String(error)); }
    if ('failure' in ready) return ready.failure;
    try {
      const reply = await this.requestProfileChild(id, ready.child, 'open-fingerprint-test-sites', 'fingerprint-tests-opened', { sites });
      if (reply.ok !== true) return this.diagnosticFailure(profile, 'test-sites-failed', String(reply.error ?? 'The selected profile could not open the test sites.'));
      return {
        ok: true,
        status: 'opened',
        profileName: profile.name,
        sites,
        urls: sites.map((site) => FINGERPRINT_TEST_SITES[site].url),
      };
    } catch (error) {
      return this.diagnosticFailure(profile, 'test-sites-failed', error instanceof Error ? error.message : String(error));
    }
  }

  // ------------------------------------------------------ Dolphin Anty migration

  /**
   * Make a user-requested, short-lived Dolphin API request. The token is kept
   * only in the renderer-to-main IPC call and this request header: it is never
   * persisted, sent to profiles, or written to logs.
   */
  private async dolphinRequest(token: string, endpoint: string, request: { baseUrl?: string; method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<unknown> {
    this.requireOnline();
    const cleanToken = String(token ?? '').trim().replace(/^Bearer\s+/i, '');
    if (cleanToken.length < 8 || cleanToken.length > 2048) throw new Error(this.t('dolphin.err.token'));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const body = request.body === undefined ? undefined : JSON.stringify(request.body);
      const response = await session.defaultSession.fetch(`${request.baseUrl ?? DOLPHIN_API_URL}${endpoint}`, {
        method: request.method ?? 'GET',
        headers: { Authorization: `Bearer ${cleanToken}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body } : {}),
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      } as RequestInit);
      if (!response.ok) throw new Error(`dolphin-http:${response.status}`);
      return await response.json() as unknown;
    } catch (err) {
      // Never expose a server response that could echo a credential.
      if ((err as Error)?.name === 'AbortError') throw new Error(this.t('dolphin.err.timeout'));
      const message = String((err as Error)?.message ?? '');
      if (message.startsWith('dolphin-http:')) throw new Error(this.t('dolphin.err.request', { status: message.slice('dolphin-http:'.length) }));
      throw new Error(this.t('dolphin.err.unavailable'));
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Fetch enough list pages for a selection dialog; individual details are loaded only after the user confirms. */
  private async listDolphinProfiles(token: string) {
    const all = new Map<string, ReturnType<typeof dolphinProfileSummaries>[number]>();
    for (let page = 1; page <= 20; page++) {
      const result = await this.dolphinRequest(token, `/browser_profiles?limit=50&page=${page}`);
      const batch = dolphinProfileSummaries(result);
      for (const profile of batch) all.set(profile.id, profile);
      if (batch.length < 50) break;
    }
    return [...all.values()];
  }

  /**
   * Cookies are a separate Dolphin API capability or embedded within profile payloads.
   * Keep them encrypted in the normal pending-cookie vault until the new profile starts;
   * neither values nor domains are returned to the renderer or written to logs.
   */
  private async importDolphinCookies(token: string, dolphinId: string, profileId: string): Promise<'queued' | 'empty' | 'unavailable'> {
    const attempts = [
      { baseUrl: DOLPHIN_SYNC_API_URL, endpoint: '/cookies/export', method: 'POST' as const, body: { browserProfileId: Number(dolphinId) } },
      { baseUrl: DOLPHIN_API_URL, endpoint: `/browser_profiles/${encodeURIComponent(dolphinId)}/cookies`, method: 'GET' as const },
      { baseUrl: DOLPHIN_API_URL, endpoint: `/cookies?browserProfileId=${encodeURIComponent(dolphinId)}`, method: 'GET' as const },
      { baseUrl: DOLPHIN_API_URL, endpoint: '/cookies/export', method: 'POST' as const, body: { id: Number(dolphinId) } },
    ];
    for (const req of attempts) {
      try {
        const result = await this.dolphinRequest(token, req.endpoint, req);
        const parsed = parseCookies(typeof result === 'string' ? result : JSON.stringify(result));
        if (parsed.ok && parsed.cookies.length) {
          this.queueCookies(profileId, parsed.cookies);
          return 'queued';
        }
      } catch {}
    }
    return 'unavailable';
  }

  /** Convert selected Dolphin configuration into fresh local OctoBrowser profiles 1:1. */
  private async importDolphinProfiles(token: string, ids: string[], rawOptions: Partial<DolphinImportOptions>) {
    const options = Object.fromEntries(DOLPHIN_IMPORT_FIELDS.map((field) => [field, rawOptions?.[field] !== false])) as DolphinImportOptions;
    const selected = [...new Set((Array.isArray(ids) ? ids : []).map(String).map((id) => id.trim()).filter((id) => /^\d{1,20}$/.test(id)))];
    if (!selected.length) throw new Error(this.t('dolphin.err.select'));
    let imported = 0;
    let failed = 0;
    let skippedProxies = 0;
    let queuedCookieProfiles = 0;
    let unavailableCookieProfiles = 0;
    const importedNames: string[] = [];
    for (const id of selected) {
      try {
        const detail = await this.dolphinRequest(token, `/browser_profiles/${encodeURIComponent(id)}`);
        const converted = convertDolphinProfile(detail, options);
        const profile = this.profiles.create({ name: converted.name, kind: 'antidetect', patch: converted.patch });
        
        // 1. Proxy
        if (converted.proxy) {
          try {
            this.setProfileProxy(profile.id, {
              mode: 'new', text: converted.proxy.text, type: converted.proxy.type, changeIpUrl: converted.proxy.changeIpUrl, name: converted.proxy.name, save: false,
            });
          } catch { skippedProxies++; }
        }

        // 2. Open windows and active tabs (1:1 session restore)
        if (converted.tabs?.length && this.ctx.keyring.isUnlocked()) {
          try {
            const pData = new ProfileData(this.ctx.layout, profile.id, () => this.ctx.keyring.getKey());
            pData.session.save({
              savedAt: new Date().toISOString(),
              tabs: converted.tabs.map((t) => ({ url: t.url, title: t.title || t.url, pinned: !!t.pinned })),
              activeIndex: 0,
            });
          } catch (err) {
            this.ctx.logger.warn('dolphin.session-save-failed', err);
          }
        }

        // 3. Bookmarks
        if (converted.bookmarks?.length && this.ctx.keyring.isUnlocked()) {
          try {
            const pData = new ProfileData(this.ctx.layout, profile.id, () => this.ctx.keyring.getKey());
            pData.bookmarks.save(converted.bookmarks);
          } catch (err) {
            this.ctx.logger.warn('dolphin.bookmarks-save-failed', err);
          }
        }

        // 4. Cookies (embedded or cloud sync)
        if (options.cookies) {
          let cookieState: 'queued' | 'empty' | 'unavailable' = 'empty';
          if (converted.cookies) {
            try {
              const parsed = parseCookies(typeof converted.cookies === 'string' ? converted.cookies : JSON.stringify(converted.cookies));
              if (parsed.ok && parsed.cookies.length) {
                this.queueCookies(profile.id, parsed.cookies);
                cookieState = 'queued';
              }
            } catch {}
          }
          if (cookieState !== 'queued') {
            cookieState = await this.importDolphinCookies(token, id, profile.id);
          }
          if (cookieState === 'queued') queuedCookieProfiles++;
          else if (cookieState === 'unavailable') unavailableCookieProfiles++;
        }

        imported++;
        importedNames.push(profile.name);
      } catch {
        failed++;
      }
    }
    if (!imported) throw new Error(this.t('dolphin.err.import'));
    this.pushProfiles();
    return { imported, failed, skippedProxies, queuedCookieProfiles, unavailableCookieProfiles, names: importedNames };
  }

  /**
   * Import from a local Dolphin Anty export file or JSON bundle with 1:1 tabs, bookmarks, and cookies.
   */
  private importDolphinFile(text: string, ids: string[], rawOptions: Partial<DolphinImportOptions>) {
    const options = Object.fromEntries(DOLPHIN_IMPORT_FIELDS.map((field) => [field, rawOptions?.[field] !== false])) as DolphinImportOptions;
    const parsed = parseDolphinExport(text);
    if (!parsed.profiles.length) throw new Error(this.t('dolphin.err.file'));
    const wanted = new Set(([] as string[]).concat(ids ?? []).map(String));
    const chosen = parsed.profiles.filter((_item, index) => !wanted.size || wanted.has(parsed.summaries[index].id));
    if (!chosen.length) throw new Error(this.t('dolphin.err.select'));
    let imported = 0;
    let failed = 0;
    let skippedProxies = 0;
    let queuedCookieProfiles = 0;
    let unavailableCookieProfiles = 0;
    const importedNames: string[] = [];
    for (const item of chosen) {
      try {
        const converted = convertDolphinProfile(item, options);
        const profile = this.profiles.create({ name: converted.name, kind: 'antidetect', patch: converted.patch });
        
        // 1. Proxy
        if (converted.proxy) {
          try {
            this.setProfileProxy(profile.id, { mode: 'new', text: converted.proxy.text, type: converted.proxy.type, changeIpUrl: converted.proxy.changeIpUrl, name: converted.proxy.name, save: false });
          } catch { skippedProxies++; }
        }

        // 2. Open windows and active tabs (1:1 session restore)
        if (converted.tabs?.length && this.ctx.keyring.isUnlocked()) {
          try {
            const pData = new ProfileData(this.ctx.layout, profile.id, () => this.ctx.keyring.getKey());
            pData.session.save({
              savedAt: new Date().toISOString(),
              tabs: converted.tabs.map((t) => ({ url: t.url, title: t.title || t.url, pinned: !!t.pinned })),
              activeIndex: 0,
            });
          } catch (err) {
            this.ctx.logger.warn('dolphin.session-save-failed', err);
          }
        }

        // 3. Bookmarks
        if (converted.bookmarks?.length && this.ctx.keyring.isUnlocked()) {
          try {
            const pData = new ProfileData(this.ctx.layout, profile.id, () => this.ctx.keyring.getKey());
            pData.bookmarks.save(converted.bookmarks);
          } catch (err) {
            this.ctx.logger.warn('dolphin.bookmarks-save-failed', err);
          }
        }

        // 4. Cookies
        if (options.cookies) {
          if (converted.cookies) {
            try {
              const parsed = parseCookies(typeof converted.cookies === 'string' ? converted.cookies : JSON.stringify(converted.cookies));
              if (parsed.ok && parsed.cookies.length) {
                this.queueCookies(profile.id, parsed.cookies);
                queuedCookieProfiles++;
              } else {
                unavailableCookieProfiles++;
              }
            } catch {
              unavailableCookieProfiles++;
            }
          } else {
            unavailableCookieProfiles++;
          }
        }

        imported++;
        importedNames.push(profile.name);
      } catch { failed++; }
    }
    if (!imported) throw new Error(this.t('dolphin.err.import'));
    this.pushProfiles();
    return { imported, failed, skippedProxies, queuedCookieProfiles, unavailableCookieProfiles, names: importedNames };
  }

  /** Update profile settings (+ optional proxy change). Running profiles get the change live. */
  updateProfile(id: string, patch: Partial<Profile>, proxy?: ProxyInput): Profile {
    const clean = { ...patch } as Partial<Profile> & Record<string, unknown>;
    for (const k of ['id', 'kind', 'createdAt', 'updatedAt', 'stats']) delete clean[k];
    const current = this.profiles.get(id);
    const requestedDirectory = typeof clean.profileDirectory === 'string' ? clean.profileDirectory.trim() : '';
    if (requestedDirectory && path.resolve(requestedDirectory).toLowerCase() !== path.resolve(current.profileDirectory ?? this.ctx.layout.profileDir(id)).toLowerCase()) {
      this.moveProfileDirectory(id, requestedDirectory);
    }
    const selectedEngine = browserEngineFor(clean.engine ?? current.engine);
    const fingerprint = clean.fingerprint as FingerprintConfig | undefined;
    if (selectedEngine !== 'electron' && fingerprint?.enabled === true) clean.fingerprint = { ...fingerprint, enabled: false };
    this.validateEngineProfileSettings(selectedEngine, clean.fingerprint ?? current.fingerprint);
    let updated = this.profiles.update(id, clean);
    if (proxy && proxy.mode !== 'keep') updated = this.setProfileProxy(id, proxy);
    this.children.get(id)?.channel.send({ t: 'profile-updated', profile: updated, proxyQuota: this.proxyQuota(updated) });
    this.pushProfiles();
    return updated;
  }

  /** Refuse profiles whose selected standalone engine would silently ignore settings. */
  private validateEngineProfileSettings(engineValue: unknown, fingerprint: unknown): void {
    const engine = browserEngineFor(engineValue);
    const fp = fingerprint as FingerprintConfig | undefined;
    if (engine === 'electron' && fp?.enabled === true) {
      const report = validateProfileFingerprintConsistency(fp, engineVersion().major);
      const errors = report.issues.filter((issue) => issue.severity === 'error');
      if (errors.length) throw new Error(`Fingerprint settings are inconsistent: ${errors.map((issue) => issue.message).join(' ')}`);
    }
  }

  /** Move a closed profile to the local Trash. Its data remains recoverable. */
  removeProfile(id: string): void {
    if (this.isRunning(id)) throw new Error(this.t('err.closeProfileFirst'));
    this.profiles.trash(id);
    this.pushProfiles();
  }

  /** Move a closed profile to the recoverable Settings archive. */
  private archiveProfile(id: string): void {
    if (this.isRunning(id)) throw new Error(this.t('err.closeProfileFirst'));
    this.profiles.archive(id);
    this.pushProfiles();
  }

  private restoreArchivedProfile(id: string): Profile {
    const p = this.profiles.unarchive(id);
    this.pushProfiles();
    return p;
  }

  private restoreProfile(id: string): Profile {
    const p = this.profiles.restore(id);
    this.pushProfiles();
    return p;
  }

  private async permanentlyDeleteProfile(id: string, progress?: FileProgress): Promise<void> {
    if (this.isRunning(id)) throw new Error(this.t('err.closeProfileFirst'));
    const profileDir = this.ctx.layout.profileDir(id);
    await deleteDirectoryWithProgress(profileDir, progress ?? (() => undefined));
    this.profiles.remove(id);
    this.ctx.secrets.delete(`proxy:${id}`);
    this.ctx.secrets.delete(`cookies:${id}`);
    // Saved logins are profile data: erasing the profile must erase them too.
    this.passwords.removeProfile(id);
    this.pushProfiles();
  }

  /** Return only non-sensitive quota metadata for the profile's saved proxy. */
  private proxyQuota(profile: Profile): { id: string; limitBytes: number; usedBytes: number } | undefined {
    const id = profile.network.proxy?.savedId ?? '';
    if (!id) return undefined;
    try {
      const saved = this.proxies.get(id);
      return { id: saved.id, limitBytes: saved.usageLimitBytes, usedBytes: saved.usageBytes };
    } catch { return undefined; }
  }

  /** Notify running profiles that use this saved proxy of its changed quota. */
  private broadcastProxyQuota(proxyId: string): void {
    for (const [profileId, child] of this.children) {
      try {
        const profile = this.profiles.get(profileId);
        if (profile.network.proxy?.savedId === proxyId) child.channel.send({ t: 'proxy-quota', quota: this.proxyQuota(profile) });
      } catch { /* profile was removed */ }
    }
  }

  /** Resolve a proxy input to a parsed proxy (+ saved id). Throws with an i18n message. */
  private resolveProxy(input: ProxyInput): { px: ParsedProxy; name: string; savedId: string } {
    if (input.mode === 'saved') {
      const sp = this.proxies.get(String(input.savedId));
      return { px: this.proxies.resolve(sp.id), name: sp.name, savedId: sp.id };
    }
    if (input.mode !== 'new') throw new Error('invalid proxy mode');
    const type = PROXY_TYPES.includes(input.type as ProxyType) ? (input.type as ProxyType) : 'http';
    const r = parseProxy(String(input.text ?? ''), type);
    if (!r.ok || !r.proxy) throw new Error(this.t(r.error ?? 'proxy.err.format'));
    const px = { ...r.proxy, changeIpUrl: String(input.changeIpUrl ?? '').trim() || r.proxy.changeIpUrl };
    if (px.changeIpUrl && !/^https?:\/\//i.test(px.changeIpUrl)) throw new Error(this.t('proxy.err.changeIpUrl'));
    let savedId = '';
    const name = String(input.name ?? '').trim().slice(0, 64);
    if (input.save) savedId = this.proxies.add(px, name).id;
    return { px, name, savedId };
  }

  /** Point a profile at a proxy (credentials go to the secret store only). */
  setProfileProxy(id: string, input: ProxyInput): Profile {
    const cur = this.profiles.get(id);
    if (input.mode === 'keep') return cur;
    if (input.mode === 'none') {
      this.ctx.secrets.delete(`proxy:${id}`);
      return this.profiles.update(id, { network: { ...cur.network, mode: 'system', proxy: undefined, proxyRules: '', hasProxyCredentials: false, lockdown: false }, proxyCheck: undefined });
    }
    const { px, name, savedId } = this.resolveProxy(input);
    if (px.username || px.password) this.ctx.secrets.set(`proxy:${id}`, JSON.stringify({ username: px.username, password: px.password }));
    else this.ctx.secrets.delete(`proxy:${id}`);
    const lastCheck = savedId ? this.proxies.get(savedId).lastCheck : undefined;
    return this.profiles.update(id, {
      network: {
        ...cur.network,
        mode: 'proxy',
        proxy: { type: px.type, host: px.host, port: px.port, changeIpUrl: px.changeIpUrl, name, savedId },
        hasProxyCredentials: !!(px.username || px.password),
        // Fail-closed unless the user switched the lock off on purpose.
        lockdown: (input as { lockdown?: boolean }).lockdown !== false,
      },
      proxyCheck: lastCheck,
    });
  }

  /**
   * Check a proxy from the manager: a throw-away in-memory session routed through
   * a local bridge (handles SOCKS5/SOCKS4/HTTP with credentials uniformly).
   */
  async checkProxy(px: ParsedProxy): Promise<ProxyCheckResult> {
    this.requireOnline();
    if (px.type === 'https' && (px.username || px.password)) return { ok: false, at: new Date().toISOString(), error: this.t('proxy.err.httpsAuth') };
    const ses = this.guardLauncherSession(session.fromPartition(`octo-proxycheck-${Date.now()}-${randomBytes(4).toString('hex')}`));
    const bridge = px.type === 'https' ? null : new ProxyBridge({ type: px.type, host: px.host, port: px.port, username: px.username, password: px.password });
    try {
      const rules = bridge ? (await bridge.start(), bridge.rules) : `https://${px.host}:${px.port}`;
      await ses.setProxy({ mode: 'fixed_servers', proxyRules: rules });
      const r = await checkExitIp((url, init) => ses.fetch(url, { cache: 'no-store', credentials: 'omit', signal: init?.signal } as RequestInit) as never);
      if (!r.ok && bridge?.stats.lastError) r.error = bridge.stats.lastError;
      this.ctx.logger.info('proxy.checked', { ok: r.ok, country: r.countryCode ?? '' });
      return r;
    } finally {
      await bridge?.stop().catch(() => undefined);
      void ses.clearStorageData().catch(() => undefined);
    }
  }

  /** Check the proxy of a profile and store the result (used for "auto" timezone etc.). */
  async checkProfileProxy(id: string): Promise<ProxyCheckResult> {
    const p = this.profiles.get(id);
    const px = p.network.mode === 'proxy' ? p.network.proxy : undefined;
    if (!px) throw new Error(this.t('proxy.err.noProxy'));
    let creds = { username: '', password: '' };
    try { const raw = this.ctx.secrets.get(`proxy:${id}`); if (raw) creds = { ...creds, ...(JSON.parse(raw) as typeof creds) }; } catch { /* none */ }
    const r = await this.checkProxy({ type: px.type, host: px.host, port: px.port, changeIpUrl: px.changeIpUrl, ...creds });
    this.profiles.update(id, { proxyCheck: r });
    if (px.savedId) { try { this.proxies.update(px.savedId, { lastCheck: r }); } catch { /* removed */ } }
    this.pushProfiles();
    return r;
  }

  async checkSavedProxy(id: string): Promise<ProxyCheckResult> {
    const r = await this.checkProxy(this.proxies.resolve(id));
    this.proxies.update(id, { lastCheck: r });
    this.pushProxies();
    return r;
  }

  /** Check a proxy typed in the editor (not stored yet). */
  async checkProxyInput(input: ProxyInput): Promise<ProxyCheckResult> {
    if (input.mode === 'saved') return this.checkSavedProxy(input.savedId);
    if (input.mode !== 'new') throw new Error('invalid proxy mode');
    const { px } = this.resolveProxy({ ...input, save: false });
    return this.checkProxy(px);
  }

  /** Call the "change IP" URL of a rotating proxy. */
  async changeProxyIp(url: string): Promise<{ ok: boolean; status: number }> {
    this.requireOnline();
    if (!/^https?:\/\//i.test(url)) throw new Error(this.t('proxy.err.changeIpUrl'));
    const res = await session.defaultSession.fetch(url, { cache: 'no-store', credentials: 'omit' } as RequestInit);
    return { ok: res.ok, status: res.status };
  }

  /** Add saved proxies from pasted text (one per line, any supported format). */
  addProxies(text: string, type: ProxyType = 'http', name = ''): { added: number; errors: Array<{ line: number; error: string }> } {
    const list = parseProxyList(String(text ?? ''), PROXY_TYPES.includes(type) ? type : 'http');
    let added = 0;
    const errors: Array<{ line: number; error: string }> = [];
    list.forEach((r, i) => {
      if (r.ok && r.proxy) { this.proxies.add(r.proxy, list.length === 1 ? name : name ? `${name} ${i + 1}` : ''); added++; }
      else errors.push({ line: r.line ?? i + 1, error: this.t(r.error ?? 'proxy.err.format') });
    });
    this.pushProxies();
    return { added, errors };
  }

  pushProxies(): void {
    this.launcher?.webContents.send('mgr:proxies', this.proxies.list());
  }

  /** New realistic fingerprint (optionally for a given OS). */
  newFingerprint(os?: FingerprintOs): FingerprintConfig {
    const { major, full } = engineVersion();
    return generateFingerprint({ engineMajor: major, engineFullVersion: full, os: os && FP_OSES.includes(os) ? os : undefined });
  }

  /** Profile as returned by the API / launcher list (+ runtime state, no secrets). */
  profileInfo(id: string) {
    const item = this.profileList().find((p) => p.id === id);
    if (!item) throw new Error(`Profile not found: ${id}`);
    return item;
  }

  // ------------------------------------------------------------ REST API

  private apiToken(): string {
    let tok = this.ctx.secrets.get('api:token');
    if (!tok) {
      tok = randomBytes(24).toString('base64url');
      this.ctx.secrets.set('api:token', tok);
    }
    return tok;
  }

  regenerateApiToken(): string {
    this.ctx.secrets.set('api:token', randomBytes(24).toString('base64url'));
    return this.apiToken();
  }

  apiStatus() {
    const s = this.ctx.settings.load().api;
    return { enabled: s.enabled, port: s.port, listening: !!this.api?.listening, token: this.apiToken(), error: this.apiError, baseUrl: `http://127.0.0.1:${s.port}/v1` };
  }

  /** Start / stop / move the API server to match the settings. */
  async applyApiSettings(): Promise<void> {
    const s = this.ctx.settings.load().api;
    if (this.api && (!s.enabled || this.api.port !== s.port)) { await this.api.stop(); this.api = null; }
    this.apiError = '';
    if (s.enabled && !this.api) {
      const srv = new ApiServer(this.apiBackend(), () => this.apiToken(), this.ctx.logger);
      try { await srv.start(s.port); this.api = srv; } catch (err) {
        this.apiError = (err as Error).message;
        this.ctx.logger.warn('api.start-failed', { port: s.port, err: this.apiError });
      }
    }
  }

  private freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => { const port = (srv.address() as net.AddressInfo).port; srv.close(() => resolve(port)); });
    });
  }

  private async wsEndpoint(port: number): Promise<string | undefined> {
    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) return ((await res.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    return undefined;
  }

  /** Adapter used by the REST API (same services as the launcher UI). */
  private apiBackend(): ApiBackend {
    const need = (id: string) => { if (!this.profiles.list().some((p) => p.id === id)) throw new ApiError(404, `profile not found: ${id}`); };
    const pick = (body: Record<string, unknown>) => {
      const { proxy, name, kind, os, cookies, ...rest } = body;
      void name; void kind; void cookies;
      if (typeof os === 'string' && !rest.fingerprint) rest.fingerprint = this.newFingerprint(os as FingerprintOs);
      return { patch: rest as Partial<Profile>, proxy: proxy as ProxyInput | undefined };
    };
    return {
      version: SUITE_VERSION,
      listProfiles: () => this.profileList(),
      getProfile: (id) => { need(id); return this.profileInfo(id); },
      createProfile: (body) => {
        const { patch, proxy } = pick(body);
        const kind = (typeof body.kind === 'string' ? body.kind : 'antidetect') as ProfileKind;
        if (!PROFILE_KINDS.includes(kind)) throw new ApiError(400, `invalid kind (${PROFILE_KINDS.join(', ')})`);
        const cookies = body.cookies === undefined ? undefined : typeof body.cookies === 'string' ? body.cookies : JSON.stringify(body.cookies);
        const p = this.createProfile({ name: String(body.name ?? ''), kind, patch, proxy, cookies });
        return this.profileInfo(p.id);
      },
      updateProfile: (id, body) => {
        need(id);
        const { patch, proxy } = pick(body);
        if (typeof body.name === 'string') patch.name = body.name;
        if (body.cookies !== undefined) this.importCookies(id, body.cookies);
        this.updateProfile(id, patch, proxy);
        return this.profileInfo(id);
      },
      importCookies: (id, cookies) => { need(id); return this.importCookies(id, cookies); },
      removeProfile: (id) => { need(id); this.removeProfile(id); },
      startProfile: async (id, opts) => {
        need(id);
        if (this.isRunning(id)) {
          const port = this.debugPorts.get(id);
          return { status: 'running', debugPort: port, wsEndpoint: port ? await this.wsEndpoint(port) : undefined };
        }
        const port = opts.debug ? await this.freePort() : undefined;
        const r = await this.launch(id, { debugPort: port });
        if (r.status !== 'started') return r;
        return { ...r, debugPort: port, wsEndpoint: port ? await this.wsEndpoint(port) : undefined };
      },
      stopProfile: (id, force) => { need(id); return this.stop(id, force); },
      regenerateFingerprint: (id, os) => {
        need(id);
        const cur = this.profiles.get(id).fingerprint;
        const fresh = this.newFingerprint((os as FingerprintOs) || cur.os);
        this.updateProfile(id, { fingerprint: { ...fresh, timezone: cur.timezone, language: cur.language, geolocation: cur.geolocation, webrtc: cur.webrtc } });
        return this.profileInfo(id);
      },
      setProxy: (id, body) => { need(id); const p = this.setProfileProxy(id, body as unknown as ProxyInput); this.children.get(id)?.channel.send({ t: 'profile-updated', profile: p, proxyQuota: this.proxyQuota(p) }); this.pushProfiles(); return this.profileInfo(id); },
      checkProfileProxy: async (id) => { need(id); return { ...(await this.checkProfileProxy(id)) }; },
      bulk: async (action, ids, arg) => {
        const out: Record<string, unknown> = {};
        for (const id of ids) {
          try {
            need(id);
            if (action === 'start') out[id] = await this.launch(id, {});
            else if (action === 'stop') out[id] = this.stop(id);
            else if (action === 'remove') { this.removeProfile(id); out[id] = true; }
            else if (action === 'folder') { this.updateProfile(id, { folder: String(arg ?? '') }); out[id] = true; }
            else if (action === 'status') { this.updateProfile(id, { status: String(arg ?? '') } as Partial<Profile>); out[id] = true; }
            else if (action === 'tags') { this.updateProfile(id, { tags: Array.isArray(arg) ? arg.map(String) : [] }); out[id] = true; }
            else throw new ApiError(400, 'unknown action');
          } catch (err) { out[id] = { error: (err as Error).message }; }
        }
        return out;
      },
      listProxies: () => this.proxies.list(),
      addProxies: (text, type, name) => this.addProxies(text, type as ProxyType, name),
      updateProxy: (id, body) => { const r = this.proxies.update(id, { name: typeof body.name === 'string' ? body.name : undefined, changeIpUrl: typeof body.changeIpUrl === 'string' ? body.changeIpUrl : undefined }); this.pushProxies(); return { ...r }; },
      removeProxy: (id) => { this.proxies.get(id); this.proxies.remove(id); this.pushProxies(); },
      checkSavedProxy: async (id) => ({ ...(await this.checkSavedProxy(id)) }),
      parseProxy: (text, type) => {
        const r = parseProxy(text, PROXY_TYPES.includes(type as ProxyType) ? (type as ProxyType) : 'http');
        return r.ok && r.proxy ? { ok: true, format: r.format, proxy: { ...r.proxy, password: r.proxy.password ? '***' : '' } } : { ok: false, error: this.t(r.error ?? 'proxy.err.format') };
      },
      checkProxy: async (text, type) => ({ ...(await this.checkProxyInput({ mode: 'new', text, type: type as ProxyType })) }),
      newFingerprint: (os) => ({ ...this.newFingerprint(os as FingerprintOs) }),
      fingerprintMeta: (os) => {
        const o = (FP_OSES.includes(os as FingerprintOs) ? os : 'windows11') as FingerprintOs;
        return { os: o, gpus: gpuPresets(o), userAgent: userAgentFor(o, engineVersion().major), engine: engineVersion() };
      },
    };
  }

  /**
   * Stop a running profile: ask it to quit (session is saved, no confirmation
   * overlay); if it has not exited after 10 s - or `force` is set - kill it.
   */
  private async saveNativeChromiumSession(id: string, native: { tabs: NativeChromiumTabs }): Promise<void> {
    const profile = this.profiles.get(id);
    if (!profile.restoreSession || profile.deleteOnClose) return;
    const states = await native.tabs.tabs();
    const active = await native.tabs.activeTab().catch(() => undefined);
    const tabs = states
      .filter((tab) => /^https?:\/\//i.test(tab.url))
      .slice(0, 50)
      .map((tab) => ({ url: tab.url, title: tab.title, pinned: false }));
    const activeIndex = active ? Math.max(0, tabs.findIndex((tab) => tab.url === active.url)) : 0;
    new ProfileData(this.ctx.layout, id, () => this.ctx.keyring.getKey()).session.save({
      savedAt: new Date().toISOString(), tabs, activeIndex: activeIndex < 0 ? 0 : activeIndex,
    });
  }

  stop(id: string, force = false): boolean {
    const c = this.children.get(id);
    if (!c) {
      const native = this.nativeChromium.get(id);
      const firefox = this.nativeFirefox.get(id);
      if (!native && !firefox) return false;
      if (firefox) {
        this.ctx.logger.info('profile.native-firefox-stopping', { profile: id, force });
        void firefox.bidi.close().finally(() => firefox.engine.stop(force ? 100 : 5000));
        if (force) this.nativeFirefox.delete(id);
        return true;
      }
      if (!native) return false;
      this.ctx.logger.info('profile.native-chromium-stopping', { profile: id, force });
      void (force ? Promise.resolve() : this.saveNativeChromiumSession(id, native).catch((error) => {
        this.ctx.logger.warn('native-chromium.session-save-failed', { profile: id, error });
      })).finally(() => native.tabs.close().finally(() => native.engine.stop(force ? 100 : 5000)));
      return true;
    }
    if (force) {
      this.ctx.logger.warn('profile.killed', { profile: id });
      c.proc.kill();
      return true;
    }
    if (!c.stopping) {
      c.stopping = true;
      c.channel.send({ t: 'quit', reason: 'user' });
      c.killTimer = setTimeout(() => {
        if (this.children.get(id) === c && c.proc.exitCode === null) {
          this.ctx.logger.warn('profile.stop-timeout-killed', { profile: id });
          c.proc.kill();
        }
      }, 10_000);
      this.pushProfiles();
    }
    return true;
  }

  isRunning(id: string): boolean {
    return this.children.has(id) || this.nativeChromium.has(id) || this.nativeFirefox.has(id);
  }

  private async onChildExit(id: string, code: number | null, expected?: Child): Promise<void> {
    const ended = this.children.get(id);
    // A delayed exit/error from an earlier process must never remove a profile
    // that the user has already started again.
    if (expected && ended !== expected) return;
    ended?.resolveReady(false);
    for (const [requestId, waiter] of this.profileRequestWaiters) {
      if (waiter.profileId !== id) continue;
      clearTimeout(waiter.timer);
      this.profileRequestWaiters.delete(requestId);
      waiter.reject(new Error('The selected profile closed before replying to the diagnostic request.'));
    }
    if (ended?.killTimer) clearTimeout(ended.killTimer);
    if (ended?.readyTimer) {
      clearTimeout(ended.readyTimer);
      ended.readyTimer = undefined;
    }
    const failedDuringStart = Boolean(ended && !ended.ready && !ended.stopping && !ended.startFailed);
    if (failedDuringStart) {
      ended!.startFailed = true;
      this.ctx.logger.warn('profile.exited-before-ready', { profile: id, code });
      this.notifyProfileStartFailure('err.profileStartExited');
    }
    this.debugPorts.delete(id);
    this.children.delete(id);
    this.updateLauncherIcon();
    this.stopWebMediaIfIdle();
    if (ended) {
      try {
        const cur = this.profiles.get(id);
        const st = cur.stats ?? { launches: 0, lastLaunchAt: '', worktimeSec: 0 };
        this.profiles.update(id, { stats: { ...st, worktimeSec: st.worktimeSec + Math.max(0, Math.round((Date.now() - ended.startedAt) / 1000)) } });
      } catch { /* profile deleted meanwhile */ }
    }
    this.ctx.logger.info('profile.exited', { profile: id, code });
    let p: Profile | undefined;
    try { p = this.profiles.get(id); } catch { /* deleted meanwhile */ }
    if (p) {
      if (p.deleteOnClose || p.kind === 'temporary') this.profiles.cleanupEphemeral(id);
      const key = this.vaultKeys.get(id);
      if (p.encrypted && key) {
        // Chromium may keep file handles for a moment after exit (Windows): retry sealing.
        for (let i = 0; i < 10; i++) {
          try {
            this.profiles.sealVault(id, key);
            this.ctx.logger.info('vault.sealed', { profile: id });
            break;
          } catch (err) {
            if (i === 9) this.ctx.logger.error('vault.seal-failed', err);
            await new Promise((r) => setTimeout(r, 500));
          }
        }
        wipe(key);
        this.vaultKeys.delete(id);
      }
    }
    this.pushProfiles();
    if (this.appQuitting && this.children.size === 0) { app.quit(); return; }
    if (this.children.size === 0 && !this.launcher && !this.locking) app.quit();
  }

  private startPrivateBrowsing(): Promise<unknown> {
    const p = this.profiles.create({
      name: `${this.t('profile.privateName')} ${privateBrowsingStamp()}`,
      kind: 'temporary',
      patch: privateBrowsingPatch(),
    });
    this.pushProfiles();
    this.ctx.logger.info('profile.private-started', { profile: p.id });
    return this.launch(p.id, {});
  }

  private async onChildMessage(id: string, m: { t: string; [k: string]: unknown }): Promise<void> {
    const child = this.children.get(id);
    switch (m.t) {
      case 'fingerprint-audit-result':
      case 'fingerprint-tests-opened':
      case 'profile-cookies': {
        if (m.id !== id || typeof m.requestId !== 'string') return;
        const waiter = this.profileRequestWaiters.get(m.requestId);
        if (!waiter || waiter.profileId !== id || waiter.responseType !== m.t) return;
        clearTimeout(waiter.timer);
        this.profileRequestWaiters.delete(m.requestId);
        waiter.resolve(m);
        break;
      }
      case 'channel-ready':
        // The data key travels only over this private IPC pipe - never argv/env.
        // Wait for this acknowledgement so Electron cannot consume the one-shot
        // init message while its profile bundle is still loading.
        if (child && !child.initialized) {
          child.initialized = true;
          let quota: { id: string; limitBytes: number; usedBytes: number } | undefined;
          try { quota = this.proxyQuota(this.profiles.get(id)); } catch { /* profile removed while spawning */ }
          child.channel.send({ t: 'init', key: this.ctx.keyring.getKey().toString('base64'), proxyQuota: quota });
        }
        break;
      case 'ready':
        if (child) {
          child.ready = true;
          child.resolveReady(true);
          if (child.readyTimer) {
            clearTimeout(child.readyTimer);
            child.readyTimer = undefined;
          }
          // The list is updated from manager events, not polled by the UI.
          // Without this broadcast a successfully opened profile stayed labelled
          // "Starting" until some unrelated profile update happened.
          this.pushProfiles();
        }
        child?.channel.send({ t: 'update-status', status: this.updates.getStatus() });
        break;
      case 'open-launcher':
        this.showLauncher();
        break;
      case 'start-vstudio-web': {
        if (m.id !== id) return;
        this.ctx.settings.update((s) => { s.plugins['vstudio-web'].enabled = true; });
        setMediaPluginEnabled('vstudio-web', true);
        this.startWebMedia(this.profiles.get(id), String(m.label ?? ''), true);
        break;
      }
      case 'private-browse':
        void this.startPrivateBrowsing().catch((err) => this.ctx.logger.error('profile.private-start-failed', err));
        break;
      case 'cookies-imported':
        // The profile applied the queued cookies at start: drop them from the store.
        if (m.fromQueue === true) this.ctx.secrets.delete(`cookies:${id}`);
        this.ctx.logger.info('profile.cookies-imported', { profile: id, ok: Number(m.ok ?? 0), failed: Number(m.failed ?? 0) });
        break;
      case 'update-profile': {
        if (m.id !== id) return; // a profile may only edit itself
        const patch = m.patch as Partial<Profile>;
        const allowed: Partial<Profile> = {};
        if (patch.audio) allowed.audio = patch.audio;
        if (patch.addons) allowed.addons = patch.addons;
        if (patch.sandbox) allowed.sandbox = { ...this.profiles.get(id).sandbox, ...patch.sandbox };
        if (patch.mediaCapture) allowed.mediaCapture = patch.mediaCapture;
        if (patch.downloads) allowed.downloads = patch.downloads;
        if (patch.protection && patch.protection.level !== 'tor') allowed.protection = patch.protection;
        // Switches the browser window's own Settings page offers for this
        // profile. Everything else still requires the launcher's editor.
        if (typeof patch.savePasswords === 'boolean') allowed.savePasswords = patch.savePasswords;
        if (typeof patch.keepHistory === 'boolean') allowed.keepHistory = patch.keepHistory;
        if (typeof patch.restoreSession === 'boolean') allowed.restoreSession = patch.restoreSession;
        if (typeof patch.homePage === 'string') allowed.homePage = patch.homePage.slice(0, 2048);
        if (patch.theme === 'dark' || patch.theme === 'light') allowed.theme = patch.theme;
        const updated = this.profiles.update(id, allowed);
        child?.channel.send({ t: 'profile-updated', profile: updated });
        this.pushProfiles();
        break;
      }
      case 'update-settings': {
        const patch = (m.patch ?? {}) as {
          verticalTabs?: boolean; autoRefresh?: boolean; offline?: boolean; offlineMode?: 'online' | 'practical' | 'strict';

          showBookmarksBar?: boolean; hideDirectoryPaths?: boolean; virtualBoxMode?: boolean; openLinksInBackground?: boolean; animations?: boolean; confirmOnQuit?: boolean; closeCountdown?: boolean;

          sleepTabsAfterMin?: number; searchEngine?: SearchEngine;
        };
        this.ctx.settings.update((s) => {
          if (typeof patch.verticalTabs === 'boolean') s.ui.verticalTabs = patch.verticalTabs;
          if (typeof patch.autoRefresh === 'boolean') s.network.autoRefresh = patch.autoRefresh;
          // These arrived from the browser window's menu and Settings page but
          // used to be dropped here, so the switches appeared to do nothing.
          if (typeof patch.showBookmarksBar === 'boolean') s.ui.showBookmarksBar = patch.showBookmarksBar;
          if (typeof patch.hideDirectoryPaths === 'boolean') s.ui.hideDirectoryPaths = patch.hideDirectoryPaths;

          if (typeof patch.virtualBoxMode === 'boolean') {
            s.ui.virtualBoxMode = patch.virtualBoxMode;
            if (patch.virtualBoxMode) s.ui.animations = false;
          }

          if (typeof patch.openLinksInBackground === 'boolean') s.ui.openLinksInBackground = patch.openLinksInBackground;
          if (typeof patch.animations === 'boolean') s.ui.animations = patch.animations;
          if (typeof patch.confirmOnQuit === 'boolean') s.ui.confirmOnQuit = patch.confirmOnQuit;
          if (typeof patch.closeCountdown === 'boolean') s.ui.closeCountdown = patch.closeCountdown;
          if (Number.isInteger(patch.sleepTabsAfterMin) && Number(patch.sleepTabsAfterMin) >= 0 && Number(patch.sleepTabsAfterMin) <= 1440) s.ui.sleepTabsAfterMin = Number(patch.sleepTabsAfterMin);
          if (patch.searchEngine && Object.keys(SEARCH_ENGINES).includes(patch.searchEngine)) s.network.searchEngine = patch.searchEngine;
          if (patch.offlineMode === 'online' || patch.offlineMode === 'practical' || patch.offlineMode === 'strict') s.offlineMode = patch.offlineMode;
          // Keep the existing browser-IPC boolean compatible with the policy
          // field; validation intentionally derives offline from offlineMode.
          else if (typeof patch.offline === 'boolean') s.offlineMode = patch.offline ? 'practical' : 'online';
        });
        this.broadcast({ t: 'settings-updated' });
        break;
      }
      case 'proxy-usage': {
        if (m.id !== id || typeof m.proxyId !== 'string') return;
        const bytes = Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(m.bytes) || 0)));
        if (!bytes) return;
        try {
          const profile = this.profiles.get(id);
          // A child may only charge its currently selected saved proxy. It
          // never sends URLs, credentials, domains, or payload content.
          if (profile.network.proxy?.savedId !== m.proxyId) return;
          this.proxies.addUsage(m.proxyId, bytes);
          this.broadcastProxyQuota(m.proxyId);
          this.pushProxies();
        } catch { /* proxy/profile was removed while the child was closing */ }
        break;
      }
      case 'proxy-checked': {
        const r = m.result as ProxyCheckResult | undefined;
        if (m.id !== id || !r || typeof r !== 'object') return;
        try { this.profiles.update(id, { proxyCheck: r }); } catch { /* deleted */ }
        this.pushProfiles();
        break;
      }
      case 'check-updates':
        await this.updates.check();
        break;
      case 'launch-detect':
        this.launchDetect();
        break;
      default:
        break;
    }
  }

  private broadcast(msg: { t: string; [k: string]: unknown }): void {
    for (const c of this.children.values()) c.channel.send(msg);
  }

  /** Portable copy of the app inside Windows Sandbox: app folder READ-ONLY, data discarded on close. */
  private launchInWindowsSandbox(p: Profile, graphicsIsolation = false): boolean {
    const installDir = path.dirname(app.getPath('exe'));
    const exe = path.basename(app.getPath('exe'));
    const safeProfile = { ...p, network: { ...p.network, hasProxyCredentials: false }, encrypted: false };
    const wsb = buildWsbConfig({
      appHostDir: installDir,
      exeName: exe,
      // Graphics-isolation mode maps only the read-only application directory.
      downloadsHostDir: !graphicsIsolation && p.sandbox.shareDownloads ? this.ctx.layout.profileDownloadsDir(p.id) : undefined,
      networking: true,
      clipboard: graphicsIsolation ? false : p.sandbox.clipboard !== 'block',
      audioInput: graphicsIsolation ? false : p.sandbox.microphone,
      videoInput: graphicsIsolation ? false : p.sandbox.camera,
      args: [
        `--ephemeral-data-dir=${SANDBOX_DATA_DIR}`,
        `--lang-choice=${this.ctx.lang}`,
        `--sandbox-profile=${Buffer.from(JSON.stringify(safeProfile)).toString('base64')}`,
      ],
    });
    const file = path.join(this.ctx.layout.temp, `sandbox-${p.id}-${fileStamp()}.wsb`);
    fs.writeFileSync(file, wsb, 'utf8');
    if (!launchWindowsSandbox(file)) {
      fs.rmSync(file, { force: true });
      this.ctx.logger.warn('sandbox.windows-sandbox-unavailable', { profile: p.id });
      this.launcher?.webContents.send('mgr:toast', { key: 'sandbox.unavailable' });
      return false;
    }
    this.ctx.logger.info('sandbox.windows-sandbox-launched', { profile: p.id });
    setTimeout(() => fs.rmSync(file, { force: true }), 60_000);
    return true;
  }

  private launchDetect(): void {
    const exeDir = path.dirname(app.getPath('exe'));
    const candidates = [
      path.join(exeDir, '..', 'OctoDetect', 'OctoDetect.su.exe'),
      path.join(exeDir, 'OctoDetect.su.exe'),
    ];
    const exe = candidates.find((c) => fs.existsSync(c));
    if (exe) launchDetached(exe);
    else this.launcher?.webContents.send('mgr:toast', { key: 'detect.notInstalled' });
  }

  // ------------------------------------------------------------ auto-lock

  private startAutoLock(): void {
    powerMonitor.on('lock-screen', () => void this.lockAll('autolock'));
    this.idleTimer = setInterval(() => {
      const mins = this.ctx.settings.load().security.autoLockMinutes;
      // The timed lock is deliberately bound to the 4–8 word local lock
      // phrase; without it there would be no app-secret to require on return.
      if (mins > 0 && this.ctx.keyring.requiresPassword() && powerMonitor.getSystemIdleTime() >= mins * 60) void this.lockAll('autolock');
    }, 30_000);
  }

  /**
   * Lock: close every encrypted profile. Their vaults are sealed when the
   * process exits and the cached vault keys are wiped, so opening them again
   * asks for the 12-word passphrase.
   *
   * When the data folder is protected with a MASTER PASSWORD the local key is
   * locked as well and the password is asked for again before the app can be
   * used. Cancelling that window quits the application rather than continuing
   * with a locked key.
   */
  async lockAll(reason: 'autolock' | 'manual'): Promise<void> {
    if (this.locking) return;
    const targets = [...this.children.keys()].filter((id) => this.profiles.get(id).encrypted);
    this.locking = true;
    this.ctx.logger.info('lock', { reason, profiles: targets.length });
    await Promise.all(targets.map((id) => new Promise<void>((resolve) => {
      const c = this.children.get(id);
      if (!c) return resolve();
      c.proc.once('exit', () => resolve());
      c.channel.send({ t: 'quit', reason: 'lock' });
      setTimeout(() => { if (!c.proc.killed) c.proc.kill(); resolve(); }, 8000);
    })));
    // The passphrase must be typed again after a lock.
    for (const [id, key] of this.vaultKeys) { wipe(key); this.vaultKeys.delete(id); }
    this.locking = false;
    this.pushProfiles();
    await this.lockLocalKey(reason);
  }

  /**
   * Lock the local key (only meaningful with a master password) and ask for it
   * again. With a DPAPI key there is nothing to lock, so this is a no-op.
   */
  private async lockLocalKey(reason: 'autolock' | 'manual'): Promise<void> {
    const keyring = this.ctx.keyring;
    if (!keyring.requiresPassword()) return;
    keyring.lock();
    this.ctx.logger.info('keyring.locked', { reason });
    const ok = await runMasterPasswordUnlock({
      distDir: this.ctx.prep.distDir,
      appId: 'octobrowser',
      productName: this.ctx.prep.info.productName,
      lang: this.ctx.lang,
      layout: this.ctx.layout,
      keyring,
      logger: this.ctx.logger,
    });
    if (!ok) app.quit();
  }

  // --------------------------------------------------------------- filters

  private async maybeUpdateFilters(force = false): Promise<{ updated: string[]; failed: string[] } | null> {
    const s = this.ctx.settings.load();
    // Offline is policy, not merely an automatic-update preference: forcing
    // the action from a stale renderer or API cannot bypass it.
    if (appServicesOffline(s)) {
      if (force) throw new Error(this.t('settings.offlineActionBlocked'));
      return null;
    }
    this.adblock.init();
    const last = this.adblock.updatedAt ? Date.parse(this.adblock.updatedAt) : 0;
    if (!force && Date.now() - last < 24 * 3600 * 1000) return null;
    const ses = this.guardLauncherSession(session.fromPartition('octo-filters')); // in-memory, no cookies, isolated
    const r = await this.adblock.update((url) => ses.fetch(url, { credentials: 'omit', cache: 'no-store' } as RequestInit));
    if (r.updated.length) {
      this.ctx.settings.update((st) => { st.filtersUpdatedAt = this.adblock.updatedAt; });
      this.broadcast({ t: 'filters-updated' });
    }
    return r;
  }

  // ------------------------------------------------------------------- IPC

  private registerIpc(): void {
    const L = this.ctx.logger;
    const ctx = this.ctx;
    // One picture stream per device window, keyed by device name.
    const screens = new Map<string, ScreenStream>();
    const sendScreen = (payload: Record<string, unknown>): void => {
      const win = this.launcher;
      if (win && !win.isDestroyed()) win.webContents.send('mgr:android-screen', payload);
    };
    handle('mgr:init', L, () => ({
      lang: ctx.lang,
      dicts: DICTS,
      version: SUITE_VERSION,
      dataDir: ctx.layout.root,
      keyringMode: ctx.keyring.mode(),
      keyringRequiresPassword: ctx.keyring.requiresPassword(),
      secretBackend: ctx.secretBackend(),
      credmanAvailable: ctx.credmanAvailable(),
      addons: ADDONS,
      kinds: PROFILE_KINDS,
      windowsSandbox: windowsSandboxAvailable(),
      torBrowser: !!findTorBrowser(ctx.settings.load().tor.torBrowserPath),
      firefoxAvailable: firefoxAvailability(ctx.settings.load().firefox.firefoxPath).available
        || engineResourceRoots().some((resourcesPath) => !!discoverFirefoxRuntime(resourcesPath, path.join(ctx.layout.engine, 'runtimes', 'gecko'))),
      inkbrowserInstalled: !!findInkBrowser(),
      chromiumRuntimes: listInstalled(path.join(ctx.layout.engine, 'runtimes', 'chromium')),
      settings: ctx.settings.load(),
      searchEngines: Object.keys(SEARCH_ENGINES),
      update: this.updates.getStatus(),
      logMode: ctx.logger.getMode(),
      filtersUpdatedAt: this.adblock.updatedAt ?? null,
    }));
    handle('mgr:profiles', L, () => this.profileList());
    handle('mgr:archived', L, () => this.profileList(false, true));
    handle('mgr:chromium-catalog', L, () => listInstalled(path.join(ctx.layout.engine, 'runtimes', 'chromium')));
    handle('mgr:firefox-runtime-status', L, () => {
      const userRoot = path.join(ctx.layout.engine, 'runtimes', 'gecko');
      const diagnostic = engineResourceRoots().map((resourcesPath) => inspectFirefoxRuntime(resourcesPath, userRoot)).find((item) => item.reason === 'ready');
      return diagnostic ?? inspectFirefoxRuntime('', userRoot);
    });
    handle('mgr:chromium-install', L, (_e, version: string) => installChromium(catalogEntry(String(version)), path.join(ctx.layout.engine, 'runtimes', 'chromium')));
    handle('mgr:chromium-remove', L, (_e, version: string) => {
      const entry = catalogEntry(String(version));
      const selectedByProfile = this.profiles.list().some((profile) => profile.chromiumRuntime === entry.version);
      removeChromium(entry, path.join(ctx.layout.engine, 'runtimes', 'chromium'), selectedByProfile || [...this.nativeChromium.values()].some((n) => n.runtimeVersion === entry.version));
      return true;
    });
    // Dolphin Anty migration is explicitly user-initiated from Settings. Its
    // access token is accepted only for this request and is never persisted.
    handle('mgr:dolphin-list', L, (_e, token: string) => this.listDolphinProfiles(String(token ?? '')));
    handle('mgr:dolphin-import', L, (_e, request: { token?: string; ids?: string[]; options?: Partial<DolphinImportOptions> }) =>
      this.importDolphinProfiles(String(request?.token ?? ''), request?.ids ?? [], request?.options ?? {}));
    // VirtualBox only hosts the Android Studio Linux VM. It is local-only and
    // VBoxManage's registered machine list is the source of truth; no VM
    // inventory or disk contents are uploaded.
    handle('mgr:virtualbox-status', L, () => virtualBoxStatus());
    handle('mgr:virtualbox-install', L, async () => installVirtualBox((message) => {
      this.launcher?.webContents.send('mgr:android-progress', { stage: 'install', percent: -1, text: message });
    }));
    handle('mgr:virtualbox-locate', L, async (_e, file: string) => {
      try { const executable = await setVirtualBoxManagePath(String(file ?? '')); return { ok: true, executable, message: '' }; }
      catch (error) { return { ok: false, executable: '', message: error instanceof Error ? error.message : 'VBoxManage could not be located.' }; }
    });
    handle('mgr:virtualbox-forget', L, async () => { await clearVirtualBoxManagePath(); return true; });

    // ------------------------------------------------ Android Studio Linux VM & Isolated Profiles
    handle('mgr:virtualbox-studio-vm-status', L, async () => {
      try { return await getStudioLinuxVmStatus(); }
      catch (error) { return { available: false, error: error instanceof Error ? error.message : 'Status check failed' }; }
    });
    handle('mgr:virtualbox-studio-vm-create', L, async (_e, options: StudioLinuxVmCreateOptions) => {
      try {
        const vm = await createStudioLinuxVm(options);
        return { ok: true, vm, message: '' };
      } catch (error) {
        return { ok: false, vm: null, message: error instanceof Error ? error.message : 'Isolated VM creation failed' };
      }
    });
    handle('mgr:virtualbox-studio-vm-start', L, async (_e, mode?: VirtualBoxLaunchMode) => {
      try {
        await startStudioLinuxVm(undefined, mode);
        return { ok: true, message: '' };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Could not start VM' };
      }
    });
    handle('mgr:virtualbox-studio-vm-stop', L, async (_e, force?: boolean) => {
      try {
        await stopStudioLinuxVm(undefined, force);
        return { ok: true, message: '' };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Could not stop VM' };
      }
    });
    handle('mgr:virtualbox-studio-vm-script', L, () => ({
      ok: true,
      script: generateStudioLinuxProvisionScript(),
    }));
    handle('mgr:virtualbox-studio-vm-connect-adb', L, async () => {
      return await connectStudioAdbBridge();
    });
    handle('mgr:virtualbox-studio-vm-drop-folder', L, async () => {
      try {
        const dropFolder = getIsolatedDropFolder();
        const msg = await shell.openPath(dropFolder);
        return msg ? { ok: false, message: msg } : { ok: true, message: '', folder: dropFolder };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Could not open folder' };
      }
    });
    handle('mgr:profile-launch-isolated-vm', L, async (_e, id: string) => {
      try {
        const p = this.profiles.get(String(id));
        const res = await launchProfileInIsolatedVm(p);
        return { ok: true, message: res.message };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Could not launch profile in isolated VM' };
      }
    });



    // Android Studio is a separate, local-only backend. Listing/creating an AVD
    // never sends its configuration, camera, microphone, proxy, or VM data to
    // Octo services; Android's own SDK tools remain the source of truth.
    handle('mgr:android-status', L, async () => ({
      ...await androidStudioStatusAsync(),
      devices: ANDROID_CATALOG_DEVICES,
      systems: ANDROID_SYSTEM_IMAGES.map((item) => ({ ...item, installed: androidSystemImageInstalled(item.id), runsHere: imageRunsHere(item.abi) })),
    }));
    handle('mgr:android-list', L, async () => {
      try { return { available: true, machines: await listAndroidAvds() }; }
      catch { return { available: false, machines: [] }; }
    });
    // Free/total space for the folder the wizard is about to write into.
    handle('mgr:android-disk', L, (_e, directory: string) => androidDiskInfo(String(directory ?? '') || defaultAvdDirectory()));
    // Which folder will actually receive the gigabytes, plus the free space there.
    handle('mgr:android-target-dir', L, async (_e, directory?: string) => {
      // Android Studio is the only Android engine, so its AVD folder is the target.
      const chosen = String(directory ?? '').trim();
      const fallback = defaultAvdDirectory();
      const target = chosen || fallback;
      return { ...androidDiskInfo(target), backend: 'avd', suggested: fallback, custom: Boolean(chosen) };
    });
    // ---- Android networking: proxy lockdown, traffic readout, dead man's switch ----
    handle('mgr:android-net-status', L, async () => {
      const status = await androidNetworkStatus();
      return { ...status, killSwitch: this.killSwitchOn };
    });
    handle('mgr:android-net-proxy', L, async (_e, serial: string, input: { host?: string; port?: number; lockdown?: boolean; bypass?: string }) =>
      setAndroidProxy(String(serial ?? ''), { host: String(input?.host ?? ''), port: Number(input?.port ?? 0), lockdown: input?.lockdown !== false, bypass: String(input?.bypass ?? '') }));
    handle('mgr:android-net-proxy-clear', L, async (_e, serial: string) => { await clearAndroidProxy(String(serial ?? '')); return true; });
    handle('mgr:android-net-off', L, async (_e, serial: string, off: boolean) => setAndroidNetworkOff(String(serial ?? ''), off === true));
    handle('mgr:kill-switch', L, async (_e, on: boolean) => this.setKillSwitch(on === true));
    handle('mgr:kill-switch-state', L, () => ({ on: this.killSwitchOn }));
    handle('mgr:android-accept-licenses', L, async () => { await acceptAndroidLicenses(); return true; });
    handle('mgr:android-install-system', L, async (_e, systemId: string) => {
      setAndroidProgressSink((progress: AndroidProgress) => this.launcher?.webContents.send('mgr:android-progress', progress));
      try { await installAndroidSystemImage(String(systemId ?? '')); }
      finally { setAndroidProgressSink(null); }
      return true;
    });
    handle('mgr:android-create', L, async (_e, input: AndroidAvdCreateInput) => {
      const created = await createAndroidAvd(input);
      // Anything the inspection could not repair is logged, never silently dropped.
      if (created.issues.length) this.ctx.logger.warn('android.avd.files', { name: input.name, issues: created.issues.slice(0, 10) });
      return true;
    });
    handle('mgr:android-delete', L, async (_e, name: string) => {
      await deleteAndroidAvd(String(name ?? ''));
      return true;
    });
    handle('mgr:android-launch', L, async (_e, input: Omit<AndroidLaunchInput, 'proxy'> & { proxyId?: string; cameraDevice?: string; locale?: string }) => {
      let proxy: AndroidLaunchInput['proxy'];
      const proxyId = String(input?.proxyId ?? '');
      if (proxyId) {
        const saved = this.proxies.get(proxyId);
        if (saved.usageLimitBytes > 0 && saved.usageBytes >= saved.usageLimitBytes) throw new Error('The selected proxy has reached its data limit');
        // HTTP(S) credentials would leak through the emulator command line.
        // SOCKS5 instead uses a loopback adapter in the main process, so its
        // credentials remain in the secret store and are safe to resolve here.
        if (saved.type === 'socks4' || (saved.type !== 'socks5' && saved.hasCredentials)) {
          throw new Error('Android supports HTTP/HTTPS without login, or SOCKS5 through the local adapter');
        }
        const resolved = saved.type === 'socks5' ? this.proxies.resolve(proxyId) : saved;
        proxy = { type: saved.type as 'http' | 'https' | 'socks5', host: saved.host, port: saved.port,
          username: 'username' in resolved ? resolved.username : '', password: 'password' in resolved ? resolved.password : '' };
      }
      const launched = await launchAndroidAvd({
        name: String(input?.name ?? ''), cameraFront: input?.cameraFront, cameraBack: input?.cameraBack,
        cameraFrontDevice: String(input?.cameraFrontDevice ?? ''), cameraBackDevice: String(input?.cameraBackDevice ?? ''),
        cameraDevice: String(input?.cameraDevice ?? ''), locale: String(input?.locale ?? ''),
        microphoneEnabled: input?.microphoneEnabled !== false, microphoneDevice: String(input?.microphoneDevice ?? ''),
        networkSpeed: input?.networkSpeed, secondaryDisplay: input?.secondaryDisplay, bootMode: input?.bootMode, proxy,
      });
      // Apps chosen while the device was created are installed as soon as
      // Android is actually up - adb cannot install into a device that is
      // still booting.
      void this.installQueuedApps(String(input?.name ?? ''));
      // A launch that worked is the setting the user wants next time.
      rememberAndroidLaunch(String(input?.name ?? ''), {
        proxyId, cameraFront: input?.cameraFront, cameraBack: input?.cameraBack,
        cameraFrontDevice: String(input?.cameraFrontDevice ?? ''), cameraBackDevice: String(input?.cameraBackDevice ?? ''),
        cameraDevice: String(input?.cameraDevice ?? ''), locale: String(input?.locale ?? ''),
        microphoneEnabled: input?.microphoneEnabled !== false, microphoneDevice: String(input?.microphoneDevice ?? ''),
        networkSpeed: input?.networkSpeed, secondaryDisplay: parseSecondaryDisplay(input?.secondaryDisplay), bootMode: input?.bootMode,
      });
      for (const note of launched.notes) this.ctx.logger.warn('android.launch.notApplied', { device: String(input?.name ?? ''), note });
      return { ok: true, cameraWarning: launched.cameraWarning, notes: launched.notes };
    });
    // Adopt devices that already exist somewhere on disk: the folder is
    // scanned, the missing pointers are written, and it is remembered.
    handle('mgr:android-import-folder', L, (_e, directory: string) => importAvdFolder(String(directory ?? '')));
    /**
     * A desktop notification with sound. Creating a device takes minutes, so
     * the user asked to be told when it is done even if the window is behind
     * something else. Only ever called because a checkbox said so.
     */
    handle('mgr:notify', L, (_e, input: { title?: string; body?: string; silent?: boolean }) => {
      if (!Notification.isSupported()) return false;
      const clean = (value: unknown, max: number) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
      const notification = new Notification({
        title: clean(input?.title, 120) || 'Octo.su',
        body: clean(input?.body, 300),
        silent: input?.silent === true,
      });
      notification.on('click', () => { this.launcher?.show(); this.launcher?.focus(); });
      notification.show();
      return true;
    });
    // What the user chose last time, and the languages a device can boot in.
    handle('mgr:android-launch-prefs', L, (_e, name: string) => androidLaunchPrefs(String(name ?? '')));
    handle('mgr:android-locales', L, () => ANDROID_LOCALES);
    // ---- Android versions the catalogue does not carry ----
    handle('mgr:android-custom', L, () => ({ ...readCustomCatalogue(), path: customCataloguePath() }));
    handle('mgr:android-custom-add', L, (_e, input: { label?: string; packageName?: string; released?: string }) => {
      try { return { ok: true, image: addCustomImage(input ?? {}), message: '' }; }
      catch (error) { return { ok: false, image: null, message: error instanceof Error ? error.message : 'That image could not be added.' }; }
    });
    handle('mgr:android-custom-remove', L, (_e, packageName: string) => removeCustomImage(String(packageName ?? '')));
    handle('mgr:android-custom-directory', L, async (_e, input: { path?: string }) => {
      setAndroidProgressSink((progress: AndroidProgress) => this.launcher?.webContents.send('mgr:android-progress', progress));
      try {
        const selected = String(input?.path ?? '');
        const inspected = inspectSystemImageDirectory(selected);
        if (!imageRunsHere(inspected.abi)) throw new Error(`This ${inspected.abi} image cannot run on this ${process.arch} computer. Choose an image built for the host architecture.`);
        const result = await importSystemImageDirectory(selected, androidInstallRoot(), (copied, total, file) => {
          const percent = total > 0 ? Math.min(99, Math.round((copied / total) * 100)) : -1;
          reportAndroidProgress({ stage: 'import', percent, text: `Importing ${file}` });
        });
        reportAndroidProgress({ stage: 'done', percent: 100, text: `${result.image.label} is ready` });
        return { ok: true, result, message: '' };
      } catch (error) {
        return { ok: false, result: null, message: error instanceof Error ? error.message : 'That directory could not be imported.' };
      } finally { setAndroidProgressSink(null); }
    });
    handle('mgr:android-custom-rom', L, async (_e, input: { path?: string }) => {
      setAndroidProgressSink((progress: AndroidProgress) => this.launcher?.webContents.send('mgr:android-progress', progress));
      try {
        const result = await importSystemImageArchive(String(input?.path ?? ''), androidInstallRoot(),
          (stage, copied, total, file) => {
            const percent = total > 0 ? Math.min(99, Math.round((copied / total) * 100)) : -1;
            reportAndroidProgress({ stage, percent, text: `${stage === 'unzip' ? 'Unpacking' : 'Importing'} ${file}` });
          }, imageRunsHere);
        reportAndroidProgress({ stage: 'done', percent: 100, text: `${result.image.label} is ready to create a device` });
        return { ok: true, result, message: '' };
      } catch (error) {
        return { ok: false, result: null, message: error instanceof Error ? error.message : 'That ROM ZIP could not be imported.' };
      } finally { setAndroidProgressSink(null); }
    });
    // Make the device report the handset it was created as. Needs a running
    // device and an image that allows root; both are reported honestly.
    handle('mgr:android-identity', L, (_e, name: string) => applyDeviceIdentity(String(name ?? '')));
    // ---- photos and videos: into the running device's gallery ----
    handle('mgr:android-media-folder', L, (_e, folder: string) => readMediaFolder(String(folder ?? '')));
    handle('mgr:android-media-push', L, async (_e, name: string, folder: string) => {
      const serial = await androidSerialFor(String(name ?? ''));
      if (!serial) throw new Error('Start the device first: photos and videos are copied into a running Android.');
      setAndroidProgressSink((progress: AndroidProgress) => this.launcher?.webContents.send('mgr:android-progress', progress));
      try {
        return await pushMediaToDevice({
          adb: adbPath(), serial, folder: String(folder ?? ''),
          onProgress: (text, percent) => reportAndroidProgress({ stage: 'install', percent, text }),
        });
      } finally { setAndroidProgressSink(null); }
    });
    // ---- alternative app stores, installed into a running device ----
    handle('mgr:android-stores', L, () => ANDROID_STORES);
    handle('mgr:android-store-states', L, async (_e, name: string) => {
      const serial = await androidSerialFor(String(name ?? ''));
      if (!serial) return [];
      return androidStoreStates(adbPath(), serial);
    });
    handle('mgr:android-store-state', L, async (_e, input: { name?: string; id?: string; action?: string }) => {
      const serial = await androidSerialFor(String(input?.name ?? ''));
      if (!serial) throw new Error('Start the device first: apps can only be changed in a running Android.');
      const action = String(input?.action ?? '');
      if (!['enable', 'disable', 'uninstall'].includes(action)) throw new Error('Unknown app action');
      return changeAndroidStoreState({ adb: adbPath(), serial, id: String(input?.id ?? ''), action: action as 'enable' | 'disable' | 'uninstall' });
    });
    handle('mgr:android-store-homepage', L, async (_e, id: string) => {
      const store = androidStore(String(id ?? ''));
      if (!store) return false;
      await shell.openExternal(store.homepage);
      return true;
    });
    handle('mgr:android-store-install', L, async (_e, input: { name?: string; serial?: string; stores?: string[]; files?: Record<string, string>; samsung?: boolean }) => {
      const serial = String(input?.serial ?? '') || await androidSerialFor(String(input?.name ?? ''));
      if (!serial) throw new Error('Start the device first: app stores are installed into a running Android.');
      setAndroidProgressSink((progress: AndroidProgress) => this.launcher?.webContents.send('mgr:android-progress', progress));
      try {
        return await installAndroidStores({
          adb: adbPath(), serial,
          stores: Array.isArray(input?.stores) ? input.stores.map((id) => String(id)) : [],
          files: input?.files ?? {}, samsung: input?.samsung !== false,
          onProgress: (text, percent) => reportAndroidProgress({ stage: 'install', percent, text }),
        });
      } finally { setAndroidProgressSink(null); }
    });
    // Stop a running device: politely through adb, or by ending the emulator
    // process when it stopped answering.
    handle('mgr:android-stop', L, async (_e, name: string, force: boolean) => {
      const device = String(name ?? '');
      screens.get(device)?.stop();
      screens.delete(device);
      return stopAndroidAvd(device, force === true);
    });
    // The device window. Frames are pushed to the launcher as they are captured;
    // a stream that cannot read the screen says so and stops (see ScreenStream).
    handle('mgr:android-screen-start', L, async (_e, name: string) => {
      const device = String(name ?? '');
      const serial = await androidSerialFor(device).catch(() => '');
      if (!serial) return { started: false, reason: 'notRunning' as const };
      screens.get(device)?.stop();
      const adb = adbPath();
      const stream: ScreenStream = new ScreenStream(
        {
          capture: () => execAdb(adb, screencapArgs(serial)),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => Date.now(),
        },
        (frame) => sendScreen({ name: device, ...frame }),
        (message) => {
          if (screens.get(device) === stream) screens.delete(device);
          sendScreen({ name: device, error: message });
        },
        400,
      );
      screens.set(device, stream);
      stream.start();
      return { started: true, serial };
    });
    handle('mgr:android-screen-stop', L, async (_e, name: string) => {
      const device = String(name ?? '');
      screens.get(device)?.stop();
      screens.delete(device);
      return true;
    });
    // Toolbar input. Only validated actions reach adb; the serial is looked up
    // from the running emulator, never taken from the window.
    handle('mgr:android-screen-input', L, async (_e, name: string, action: unknown) => {
      const device = String(name ?? '');
      const parsed = parseScreenAction(action);
      if (!parsed) throw new Error('Unknown device control');
      const serial = await androidSerialFor(device).catch(() => '');
      if (!serial) return { done: false, reason: 'notRunning' as const };
      const adb = adbPath();
      if (parsed.kind === 'key') {
        await execAdb(adb, keyArgs(serial, parsed.key));
        return { done: true };
      }
      if (parsed.kind === 'tap') {
        await execAdb(adb, tapArgs(serial, parsed.x, parsed.y));
        return { done: true };
      }
      if (parsed.kind === 'rotate') {
        const current = parseRotation((await execAdb(adb, rotationReadArgs(serial))).toString('utf8'));
        await execAdb(adb, rotationLockArgs(serial));
        await execAdb(adb, rotationSetArgs(serial, nextRotation(current, parsed.delta)));
        return { done: true };
      }
      const png = await execAdb(adb, screencapArgs(serial));
      if (!pngDimensions(png)) throw new Error('The screenshot was not a PNG');
      const folder = path.join(os.homedir(), 'Downloads', 'Octo Android');
      fs.mkdirSync(folder, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(folder, `${device.replace(/[^\w.-]+/g, '_') || 'device'}-${stamp}.png`);
      fs.writeFileSync(file, png, { mode: 0o600 });
      return { done: true, path: file };
    });
    handle('mgr:android-folder', L, async (_e, name: string) => {
      try { return (await shell.openPath(await openAndroidAvdFolder(String(name)))) === ''; }
      catch { return false; }
    });
    // ---- vStudio virtual camera + microphone (bundled, staged automatically) ----
    // The Android section can repair itself: point at an existing SDK, or
    // install the missing Android tools the same way installer.bat does.
    handle('mgr:android-sdk-candidates', L, () => androidSdkCandidates());
    handle('mgr:android-set-sdk', L, (_e, root: string) => {
      try { return { ok: true, path: setAndroidSdkRoot(String(root ?? '')), message: '' }; }
      catch (error) { return { ok: false, path: '', message: error instanceof Error ? error.message : 'That folder is not an Android SDK.' }; }
    });
    handle('mgr:android-clear-sdk', L, () => clearAndroidSdkRoot());
    handle('mgr:android-install-tools', L, async () => {
      // The tools download is just as long as an image download, so it feeds
      // the same progress bar.
      setAndroidProgressSink((progress: AndroidProgress) => this.launcher?.webContents.send('mgr:android-progress', progress));
      try { return await installAndroidTools(); }
      catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'The Android tools could not be installed.' }; }
      finally { setAndroidProgressSink(null); }
    });
    // ---- phone specification catalogue (Android Studio AVD) ----
    // The catalogue is static data; the UI renders the cards, the comparison
    // and the "create device" summary from exactly these records.
    handle('mgr:android-catalog', L, () => {
      loadImportedHandsets();
      return {
        phones: PHONES,
        brands: [...new Set(PHONES.map((phone) => phone.identity.manufacturer))].sort(),
        variants: IMAGE_VARIANTS,
      };
    });
    handle('mgr:android-handset-import', L, (_e, input: { path?: string }) => importHandsetPath(String(input?.path ?? '')));
    handle('mgr:android-handset-directory', L, (_e, input: { path?: string }) => importHandsetDirectory(String(input?.path ?? '')));
    handle('mgr:android-summary', L, (_e, phoneId: string, variant?: string) => {
      const spec = catalogPhone(String(phoneId ?? ''));
      if (!spec) throw new Error('Unknown device specification');
      const applied = applyVariant(spec, String(variant ?? 'play'));
      return { ...creationSummary(spec, String(variant ?? 'play')), imageInstalled: androidPackageInstalled(applied.sdkPackage) };
    });

    handle('mgr:android-settings', L, async (_e, name: string, settings: AvdSettingsInput) =>
      updateAvdSettings(String(name ?? ''), settings ?? {}));
    /**
     * One entry point for both backends: the catalogue decides the numbers,
     * the user decides the backend, the name, the folder and the media wiring.
     */
    handle('mgr:android-create-spec', L, async (_e, input: {
      phoneId?: string; name?: string; directory?: string; variant?: string;
      cameraDevice?: string; cameraFrontDevice?: string; cameraBackDevice?: string;
      locale?: string; apps?: string[]; appFiles?: Record<string, string>;
      /** An SDK package the user added themselves, used instead of the variant. */
      customPackage?: string;
      ramMb?: number; cpus?: number; diskGb?: number; cameraFront?: string; cameraBack?: string; microphoneEnabled?: boolean;
      width?: number; height?: number; dpi?: number; heapMb?: number; sdCardMb?: number;
      gpuMode?: string; bootMode?: string; snapshots?: boolean;
      brand?: string; manufacturer?: string; model?: string; marketName?: string;
      device?: string; product?: string; mac?: string; imei?: string; androidId?: string;
      serialNumber?: string; phoneNumber?: string; operator?: string; simOperator?: string; simCountry?: string;
      /** The emulated phone number (telephony), not identity. Blank for none. */
      telephone?: string;
    }) => {
      const spec = catalogPhone(String(input?.phoneId ?? ''));
      if (!spec) throw new Error('Unknown device specification');
      // Every step of the creation is streamed to the launcher window so the
      // dialog can show a percentage and what is being downloaded right now.
      setAndroidProgressSink((progress: AndroidProgress) => this.launcher?.webContents.send('mgr:android-progress', progress));
      const applied = applyVariant(spec, String(input?.variant ?? 'play'));
      // A custom image replaces the variant's package, nothing else.
      const custom = String(input?.customPackage ?? '').trim();
      if (custom && !validCustomPackage(custom)) throw new Error('That is not an Android SDK system image package.');
      const systemPackage = custom || applied.sdkPackage;
      const name = String(input?.name ?? '').trim() || handsetDisplayName(spec);
      const ramMb = Math.round(Number(input?.ramMb) || applied.ramMb);
      const cpus = Math.round(Number(input?.cpus) || applied.cpus);
      const diskGb = Math.round(Number(input?.diskGb) || applied.storageGb);
      // Synchronize device name and model name to the selected device model
      const defaultIdentity = androidBuildIdentity(spec);
      const buildIdentity = {
        brand: String(input?.brand || defaultIdentity.brand),
        manufacturer: String(input?.manufacturer || defaultIdentity.manufacturer),
        model: String(input?.model || defaultIdentity.model),
        marketName: String(input?.marketName || input?.model || defaultIdentity.marketName),
        device: String(input?.device || defaultIdentity.device),
        product: String(input?.product || input?.device || defaultIdentity.product),
        mac: String(input?.mac || defaultIdentity.mac || ''),
        imei: String(input?.imei || defaultIdentity.imei || ''),
        androidId: String(input?.androidId || defaultIdentity.androidId || ''),
        serialNumber: String(input?.serialNumber || defaultIdentity.serialNumber || ''),
        phoneNumber: String(input?.phoneNumber || defaultIdentity.phoneNumber || ''),
        operator: String(input?.operator || defaultIdentity.operator || ''),
        simOperator: String(input?.simOperator || defaultIdentity.simOperator || ''),
        simCountry: String(input?.simCountry || defaultIdentity.simCountry || ''),
      };
      try {
      if (androidPackageInstalled(systemPackage)) {
        reportAndroidProgress({ stage: 'install', percent: 100, text: `${systemPackage} is already downloaded` });
      } else {
        reportAndroidProgress({ stage: 'download', percent: 0, text: `Downloading ${systemPackage}` });
        await installAndroidPackage(systemPackage);
      }
      const cameraFront = (input?.cameraFront ?? 'webcam') as CameraSource;
      const cameraBack = (input?.cameraBack ?? 'webcam') as CameraSource;
      const avdName = name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64);
      reportAndroidProgress({ stage: 'create', percent: -1, text: `Creating the virtual device ${avdName}` });
      const createdAvd = await createAndroidAvdFromSpec({
        name: avdName,
        installDirectory: String(input?.directory ?? ''),
        systemPackage, baseDevice: spec.avd.device,
        label: handsetDisplayName(spec),
        width: Math.round(Number(input?.width) || spec.avd.width),
        height: Math.round(Number(input?.height) || spec.avd.height),
        dpi: Math.round(Number(input?.dpi) || spec.avd.dpi),
        ramMb, heapMb: Math.round(Number(input?.heapMb) || spec.avd.heapMb), cores: cpus, dataGb: diskGb,
        sdCardMb: Math.max(0, Math.round(Number(input?.sdCardMb ?? spec.avd.sdCardMb))),
        gpuMode: (['auto', 'host', 'swiftshader_indirect', 'off'].includes(String(input?.gpuMode)) ? input?.gpuMode : 'auto') as 'auto',
        bootMode: input?.bootMode === 'cold' ? 'cold' : 'quick',
        snapshots: input?.snapshots !== false,
        cameraFront, cameraBack,
        cameraFrontDevice: String(input?.cameraFrontDevice ?? ''), cameraBackDevice: String(input?.cameraBackDevice ?? ''),
        cameraDevice: String(input?.cameraDevice ?? ''),
        microphoneEnabled: input?.microphoneEnabled !== false,
        props: buildIdentity,
        telephone: String(input?.telephone ?? ''),
      });
      // The language and the apps picked in the creator belong to the device
      // from now on; the apps are installed the first time it boots.
      rememberAndroidLaunch(avdName, {
        locale: String(input?.locale ?? ''), cameraDevice: createdAvd.cameraBackDevice || createdAvd.cameraFrontDevice,
        cameraFrontDevice: createdAvd.cameraFrontDevice, cameraBackDevice: createdAvd.cameraBackDevice,
        cameraFront: createdAvd.cameraFront, cameraBack: createdAvd.cameraBack,
        microphoneEnabled: input?.microphoneEnabled !== false,
        apps: Array.isArray(input?.apps) ? input.apps.map((id) => String(id)).slice(0, 24) : [],
        appFiles: input?.appFiles ?? {},
      });
      // The first start of a newly created device happens here, with no window: it
      // finishes its setup, is closed again, and the files it left are checked. A
      // failure is logged and shown in the result; it never undoes the creation.
      let quiet: QuietBootResult | null = null;
      if (createdAvd.created) {
        quiet = await quietBootAndroidAvd(avdName).catch((error: unknown): QuietBootResult => ({
          booted: false, serial: '', repaired: [], issues: [error instanceof Error ? error.message : String(error)],
        }));
        for (const fix of quiet.repaired) this.ctx.logger.info('android.avd.repaired', { device: avdName, fix });
        for (const issue of quiet.issues) this.ctx.logger.warn('android.avd.quietboot', { device: avdName, issue });
      }
      const attention = quiet?.issues.length ?? 0;
      reportAndroidProgress({
        stage: 'done', percent: 100,
        text: attention ? `${avdName} is ready, with ${attention} thing${attention === 1 ? '' : 's'} to check` : `${avdName} is ready`,
      });
      return { created: true, backend: 'avd', name: avdName };
      } finally { setAndroidProgressSink(null); }
    });
    handle('mgr:android-open-log', L, async () => {
      // The full sdkmanager / Android CLI transcript, for when a download fails.
      const file = androidToolLogPath();
      if (!fs.existsSync(file)) return false;
      return (await shell.openPath(file)) === '';
    });
    handle('mgr:android-installed-images', L, () =>
      ANDROID_SYSTEM_IMAGES.filter((item) => androidSystemImageInstalled(item.id)).map((item) => item.id));
    handle('mgr:android-install-target', L, () => androidInstallTarget());
    handle('mgr:android-set-install-dir', L, (_e, dir: string) => setAndroidInstallRoot(String(dir ?? '')));
    handle('mgr:android-clear-install-dir', L, () => clearAndroidInstallRoot());
    handle('mgr:android-available-images', L, () => availableSystemImageIds());
    // ---- camera and microphone of one Android device ----
    // Every camera the emulator can hand to Android right now, and a one-click
    // repair that wires the device to one of them.
    handle('mgr:android-webcams', L, () => emulatorWebcams());
    handle('mgr:android-camera-choices', L, () => androidCameraChoicesCached());
    handle('mgr:android-media-check', L, (_e, name: string) => androidMediaCheck(String(name ?? '')));
    handle('mgr:android-media-repair', L, (_e, name: string, input: { cameraDevice?: string; start?: boolean }) =>
      repairAndroidMedia(String(name ?? ''), { cameraDevice: String(input?.cameraDevice ?? '') }));
    handle('mgr:plugin-update', L, async (_e, plugin: string) => {
      const id = plugin === 'vstudio-web' ? 'vstudio-web' : 'vstudio-mobile';
      try { await ensureMediaCompanionAsync(id, true); return { ok: true, message: `${MEDIA_PLUGINS[id].name} updated.` }; }
      catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'The plugin could not be updated.' }; }
    });
    // ---- vStudio media plugin (browser profiles; Android no longer uses it) ----
    handle('mgr:plugins', L, async () => Promise.all(MEDIA_PLUGIN_IDS.map(async (id) => ({
      id, name: MEDIA_PLUGINS[id].name, scope: MEDIA_PLUGINS[id].scope, descriptionKey: MEDIA_PLUGINS[id].descriptionKey,
      status: await mediaCompanionStatusAsync(id),
    }))));
    // Real built-in integrations live beside the optional vStudio processes so
    // Settings is the one inventory of everything extending Octo.su.
    handle('mgr:core-plugins', L, async () => {
      const android = await androidStudioStatusAsync();
      return [
        { id: 'privacy-guard', nameKey: 'plugins.core.privacy', descriptionKey: 'plugins.core.privacy.desc', scopeKey: 'plugins.scopeBrowser', ready: true, detail: 'Canvas · WebRTC · fingerprint' },
        { id: 'filter-engine', nameKey: 'plugins.core.filters', descriptionKey: 'plugins.core.filters.desc', scopeKey: 'plugins.scopeBrowser', ready: true, detail: this.adblock.updatedAt ?? '' },
        { id: 'proxy-bridge', nameKey: 'plugins.core.proxy', descriptionKey: 'plugins.core.proxy.desc', scopeKey: 'plugins.scopeNetwork', ready: true, detail: 'HTTP · HTTPS · SOCKS5' },
        { id: 'android-bridge', nameKey: 'plugins.core.android', descriptionKey: 'plugins.core.android.desc', scopeKey: 'plugins.scopeAndroid', ready: android.available, detail: android.sdkRoot || android.missing || '' },
        { id: 'extension-sandbox', nameKey: 'plugins.core.extensions', descriptionKey: 'plugins.core.extensions.desc', scopeKey: 'plugins.scopeBrowser', ready: true, detail: `${ADDONS.length} curated add-ons` },
      ];
    });
    /**
     * Install what a plugin is missing, from the Plugins panel. Each fix is
     * the vendor's own package (winget for Python, Unity Capture from its
     * repository, VB-CABLE from VB-Audio) and the two drivers are installed
     * visibly, with the Windows consent prompt.
     */
    handle('mgr:plugin-install-requirement', L, async (_e, requirement: string) => {
      this.requireOnline();
      setAndroidProgressSink((progress: AndroidProgress) => this.launcher?.webContents.send('mgr:android-progress', progress));
      try {
        return await installMediaRequirement(String(requirement ?? ''),
          (text, percent) => reportAndroidProgress({ stage: 'install', percent, text }));
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'That component could not be installed.' };
      } finally { setAndroidProgressSink(null); }
    });
    handle('mgr:plugin-start', L, async (_e, id: MediaPluginId) => {
      try {
        if (!MEDIA_PLUGIN_IDS.includes(id)) throw new Error('Unknown plugin');
        if (id === 'vstudio-web') return await startWebMediaCompanionAsync({ profileName: 'OctoBrowser', cameraName: 'vStudio Web Octo browsers Camera', microphoneName: 'vStudio Web Octo browsers Microphone' });
        await ensureVirtualMicrophone();
        await ensureMediaCompanionAsync(id);
        const request = requestMediaCompanionBroadcast(id, true);
        const started = startMediaCompanion(id);
        await waitForMediaCompanionCamera(id, request);
        return started;
      } catch (error) { return { started: false, message: error instanceof Error ? error.message : 'The plugin could not be started.' }; }
    });
    handle('mgr:plugin-stop', L, (_e, id: MediaPluginId) => {
      if (!MEDIA_PLUGIN_IDS.includes(id)) return false;
      try { requestMediaCompanionBroadcast(id, false); } catch { /* already stopped/unprepared */ }
      return stopMediaCompanion(id);
    });
    handle('mgr:isolation', L, (_e, id: string) => this.isolation(id));
    handle('mgr:launch', L, (_e, id: string, opts: { passphrase?: string; forceRestricted?: boolean }) => this.launch(id, opts ?? {}));
    handle('mgr:fingerprint-audit', L, (_e, id: string, passphrase?: string) => this.runFingerprintAudit(String(id ?? ''), typeof passphrase === 'string' ? passphrase : undefined));
    handle('mgr:fingerprint-test-sites', L, (_e, id: string, sites: string[], passphrase?: string) =>
      this.openFingerprintTests(String(id ?? ''), Array.isArray(sites) ? sites : [], typeof passphrase === 'string' ? passphrase : undefined));
    handle('mgr:open-errors-folder', L, async () => {
      ctx.layout.ensure(['errors']);
      const error = await shell.openPath(ctx.layout.errors);
      if (error) throw new Error(error);
      return ctx.layout.errors;
    });
    handle('mgr:create', L, (_e, a: string | CreateInput, kind?: ProfileKind) => {
      const input: CreateInput = typeof a === 'string' ? { name: a, kind: kind as ProfileKind } : a;
      return this.createProfile(input);
    });
    // ---- antidetect: proxies + fingerprints ----
    handle('mgr:import-cookies', L, (_e, id: string, text: string) => this.importCookies(String(id), String(text ?? '')));
    handle('mgr:get-profile-cookies', L, (_e, id: string) => this.getProfileCookies(String(id)));
    handle('mgr:parse-cookies', L, (_e, text: string) => { const r = parseCookies(String(text ?? '')); return { ok: r.ok, count: r.cookies.length, skipped: r.skipped, format: r.format, error: r.error ? this.t(r.error) : undefined }; });
    handle('mgr:set-proxy', L, (_e, id: string, input: ProxyInput) => { const p = this.setProfileProxy(String(id), input); this.children.get(id)?.channel.send({ t: 'profile-updated', profile: p, proxyQuota: this.proxyQuota(p) }); this.pushProfiles(); return p; });
    handle('mgr:proxy-check', L, (_e, input: ProxyInput) => this.checkProxyInput(input));
    handle('mgr:proxy-check-profile', L, (_e, id: string) => this.checkProfileProxy(String(id)));
    handle('mgr:proxy-change-ip', L, (_e, url: string) => this.changeProxyIp(String(url)));
    handle('mgr:proxies', L, () => this.proxies.list());
    handle('mgr:proxies-add', L, (_e, text: string, type: ProxyType, name?: string) => this.addProxies(text, type, name ?? ''));
    handle('mgr:proxies-update', L, (_e, id: string, patch: { name?: string; changeIpUrl?: string; usageLimitBytes?: number; folder?: string; rotationMode?: ProxyRotationMode; rotationIntervalSec?: number }) => {
      const r = this.proxies.update(String(id), {
        name: patch?.name, changeIpUrl: patch?.changeIpUrl, usageLimitBytes: patch?.usageLimitBytes, folder: patch?.folder,
        rotationMode: PROXY_ROTATION_MODES.includes(patch?.rotationMode as ProxyRotationMode) ? patch?.rotationMode : undefined,
        rotationIntervalSec: patch?.rotationIntervalSec,
      });
      this.broadcastProxyQuota(r.id);
      this.pushProxies();
      return r;
    });
    handle('mgr:proxies-remove', L, (_e, ids: string[]) => { for (const id of ([] as string[]).concat(ids)) this.proxies.remove(String(id)); this.pushProxies(); return true; });
    handle('mgr:proxies-check', L, (_e, id: string) => this.checkSavedProxy(String(id)));
    handle('mgr:proxies-folders', L, () => this.proxies.folders());
    handle('mgr:proxies-set-folder', L, (_e, ids: string[], folder: string) => {
      const moved = this.proxies.setFolder(([] as string[]).concat(ids ?? []).map(String), String(folder ?? ''));
      this.pushProxies();
      return moved;
    });
    // ---- saved website logins (profile data / browser password manager) ----
    handle('mgr:passwords', L, (_e, profileId?: string) => this.passwords.list(profileId ? String(profileId) : undefined));
    handle('mgr:password-reveal', L, (_e, id: string) => this.passwords.reveal(String(id)));
    handle('mgr:passwords-remove', L, (_e, ids: string[]) => {
      for (const id of ([] as string[]).concat(ids ?? [])) this.passwords.remove(String(id));
      return true;
    });
    handle('mgr:passwords-import', L, (_e, profileId: string, text: string) => this.passwords.import(String(text ?? ''), String(profileId)));
    // Local Dolphin Anty export file: same conversion as the API import, but
    // nothing leaves this machine and no access token is involved.
    handle('mgr:dolphin-parse-file', L, (_e, text: string) => {
      const parsed = parseDolphinExport(String(text ?? ''));
      return { count: parsed.profiles.length, profiles: parsed.summaries };
    });
    handle('mgr:dolphin-pick-file', L, async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const roots = [path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Documents'), path.join(os.homedir(), 'Desktop')];
      const defaultPath = roots.find((candidate) => fs.existsSync(candidate)) ?? os.homedir();
      const picked = await dialog.showOpenDialog(win!, {
        defaultPath,
        properties: ['openFile'],
        filters: [
          { name: 'Dolphin Anty export', extensions: ['json', 'txt'] },
          { name: 'JSON files', extensions: ['json'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      const filePath = picked.canceled ? '' : picked.filePaths[0];
      if (!filePath) return null;
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error(this.t('dolphin.err.fileTooBig'));
      return { name: path.basename(filePath), text: await fs.promises.readFile(filePath, 'utf8') };
    });
    handle('mgr:dolphin-import-file', L, (_e, request: { text?: string; ids?: string[]; options?: Partial<DolphinImportOptions> }) =>
      this.importDolphinFile(String(request?.text ?? ''), request?.ids ?? [], request?.options ?? {}));
    handle('mgr:api-status', L, () => this.apiStatus());
    handle('mgr:api-set', L, async (_e, patch: { enabled?: boolean; port?: number }) => {
      ctx.settings.update((s) => {
        if (typeof patch?.enabled === 'boolean') s.api.enabled = patch.enabled;
        if (Number.isInteger(patch?.port) && patch.port! >= 1024 && patch.port! <= 65535) s.api.port = patch.port!;
      });
      await this.applyApiSettings();
      return this.apiStatus();
    });
    handle('mgr:api-token', L, () => { this.regenerateApiToken(); return this.apiStatus(); });
    handle('mgr:fingerprint-new', L, (_e, os?: FingerprintOs) => this.newFingerprint(os));
    handle('mgr:fingerprint-meta', L, (_e, os: FingerprintOs) => ({
      gpus: gpuPresets(FP_OSES.includes(os) ? os : 'windows11'),
      userAgent: userAgentFor(FP_OSES.includes(os) ? os : 'windows11', engineVersion().major),
      engine: engineVersion(),
    }));
    handle('mgr:profile-bulk', L, async (_e, action: 'start' | 'stop' | 'remove' | 'archive' | 'folder' | 'status' | 'tags', ids: string[], arg?: unknown) => {
      const out: Record<string, unknown> = {};
      for (const id of ([] as string[]).concat(ids).map(String)) {
        try {
          if (action === 'start') out[id] = await this.launch(id, {});
          else if (action === 'stop') out[id] = this.stop(id);
          else if (action === 'remove') { this.removeProfile(id); out[id] = true; }
          else if (action === 'archive') { this.archiveProfile(id); out[id] = true; }
          else if (action === 'folder') out[id] = !!this.updateProfile(id, { folder: String(arg ?? '').slice(0, 48) });
          else if (action === 'status') out[id] = !!this.updateProfile(id, { status: String(arg ?? '').slice(0, 32) } as Partial<Profile>);
          else if (action === 'tags') out[id] = !!this.updateProfile(id, { tags: Array.isArray(arg) ? arg.map(String) : [] });
        } catch (err) { out[id] = { error: (err as Error).message }; }
      }
      this.pushProfiles();
      return out;
    });
    handle('mgr:profile-reorder', L, (_e, ids: string[]) => {
      const ordered = this.profiles.reorder(Array.isArray(ids) ? ids : []);
      this.pushProfiles();
      return ordered.map((p) => p.id);
    });
    // Private browsing: one throw-away temporary profile, started right away.
    handle('mgr:private-browse', L, () => this.startPrivateBrowsing());
    handle('mgr:update', L, async (_e, id: string, patch: Partial<Profile> & { proxyUsername?: string; proxyPassword?: string; clearProxyCredentials?: boolean }) => {
      const { proxyUsername, proxyPassword, clearProxyCredentials, ...rest } = patch ?? {};
      if (clearProxyCredentials) ctx.secrets.delete(`proxy:${id}`);
      if (proxyUsername || proxyPassword) {
        ctx.secrets.set(`proxy:${id}`, JSON.stringify({ username: proxyUsername ?? '', password: proxyPassword ?? '' }));
      }
      const { proxy, cookies, ...fields } = rest as typeof rest & { proxy?: ProxyInput; cookies?: string };
      if (cookies) this.importCookies(id, cookies);
      const updated = this.updateProfile(id, { ...fields, network: { ...(fields.network ?? this.profiles.get(id).network), hasProxyCredentials: ctx.secrets.has(`proxy:${id}`) } }, proxy);
      return updated;
    });
    handle('mgr:duplicate', L, (_e, id: string, name: string, withData: boolean) => {
      if (withData && this.isRunning(id)) throw new Error(this.t('err.closeProfileFirst'));
      const p = this.profiles.duplicate(id, String(name).slice(0, 64), !!withData);
      this.pushProfiles();
      return p;
    });
    handle('mgr:remove', L, (_e, id: string) => { this.removeProfile(String(id)); return true; });
    handle('mgr:archive', L, (_e, id: string) => { this.archiveProfile(String(id)); return true; });
    handle('mgr:archive-restore', L, (_e, id: string) => this.restoreArchivedProfile(String(id)));
    handle('mgr:trash', L, () => this.profileList(true));
    handle('mgr:trash-restore', L, (_e, id: string) => this.restoreProfile(String(id)));
    handle('mgr:trash-delete', L, async (_e, id: string) => {
      this.fileProgress('delete', 0, 0, '');
      await this.permanentlyDeleteProfile(String(id), (completed, total, label) => this.fileProgress('delete', completed, total, label));
      this.fileProgress('delete', 1, 1, '');
      return true;
    });
    handle('mgr:trash-empty', L, async () => {
      const ids = this.profiles.listTrash().map((p) => p.id);
      for (const [index, id] of ids.entries()) {
        await this.permanentlyDeleteProfile(id, (completed, total, label) => {
          const overallTotal = Math.max(ids.length, total * ids.length);
          this.fileProgress('delete', index * total + completed, overallTotal, label);
        });
      }
      this.fileProgress('delete', 1, 1, '');
      return ids.length;
    });
    handle('mgr:reset', L, (_e, id: string) => {
      if (this.isRunning(id)) throw new Error(this.t('err.closeProfileFirst'));
      this.profiles.reset(id);
      this.pushProfiles();
      return true;
    });
    handle('mgr:close-profile', L, (_e, id: string, force?: boolean) => this.stop(String(id), force === true));
    handle('mgr:native-navigate', L, async (_e, id: string, url: string) => {
      const native = this.nativeChromium.get(String(id));
      if (!native) throw new Error('Profile is not running in native Chromium');
      const raw = String(url ?? '').trim();
      const target = /^(https?:\/\/|about:blank$)/i.test(raw) ? raw : (/^localhost(?::\d+)?(?:\/.*)?$/i.test(raw) ? `http://${raw}` : `https://${raw}`);
      if (!/^https?:\/\//i.test(target) && target !== 'about:blank') throw new Error('Native Chromium accepts only web URLs');
      const active = await native.tabs.activeTab();
      await native.tabs.navigate(active.id, target);
      return native.tabs.state(active.id);
    });
    handle('mgr:native-state', L, async (_e, id: string) => {
      const native = this.nativeChromium.get(String(id));
      if (!native) return null;
      return native.tabs.activeState();
    });
    handle('mgr:native-tabs', L, async (_e, id: string) => {
      const native = this.nativeChromium.get(String(id));
      if (!native) throw new Error('Profile is not running in native Chromium');
      return native.tabs.tabs();
    });
    handle('mgr:native-tab-new', L, async (_e, id: string, url?: string) => {
      const native = this.nativeChromium.get(String(id));
      if (!native) throw new Error('Profile is not running in native Chromium');
      return native.tabs.newTab(String(url ?? 'about:blank'), true);
    });
    handle('mgr:native-tab-action', L, async (_e, id: string, tabId: string, action: 'activate' | 'close' | 'navigate', value?: string) => {
      const native = this.nativeChromium.get(String(id));
      if (!native) throw new Error('Profile is not running in native Chromium');
      if (action === 'activate') await native.tabs.activateTab(String(tabId));
      else if (action === 'close') await native.tabs.closeTab(String(tabId));
      else await native.tabs.navigate(String(tabId), String(value ?? 'about:blank'));
      return native.tabs.tabs();
    });
    handle('mgr:app-close-choice', L, (_e, choice: 'quit' | 'cancel') => { this.answerLauncherClose(choice === 'quit' ? 'quit' : 'cancel'); return true; });
    handle('mgr:window-action', L, (e, action: 'minimize' | 'toggle-maximize' | 'toggle-fullscreen' | 'close') => {
      const win = BrowserWindow.fromWebContents(e.sender);
      if (!win || win !== this.launcher || win.isDestroyed()) return false;
      if (action === 'minimize') win.minimize();
      else if (action === 'toggle-maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
      else if (action === 'toggle-fullscreen') win.setFullScreen(!win.isFullScreen());
      else win.close();
      return { maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
    });
    handle('mgr:lock-all', L, async () => { await this.lockAll('manual'); return true; });
    handle('mgr:master-password', L, async (_e, action: 'set' | 'remove', current: string, next: string, repeat: string) => {
      const keyring = ctx.keyring;
      if (action === 'set') {
        const words = typeof next === 'string' ? next.trim().split(/\s+/).filter(Boolean) : [];
        if (words.length < 4 || words.length > 8) throw new Error(this.t('sec.lockPhraseInvalid'));
        if (next !== repeat) throw new Error(this.t('firstRun.err.passwordMismatch'));
        await keyring.setPassword(keyring.requiresPassword() ? String(current ?? '') : null, next);
        L.info('keyring.password-set');
      } else {
        if (!keyring.requiresPassword()) return true;
        await keyring.removePassword(String(current ?? ''));
        L.info('keyring.password-removed');
      }
      this.pushProfiles();
      return true;
    });
    handle('mgr:set-encryption', L, async (_e, id: string, enable: boolean, passphrase?: string) => {
      if (this.isRunning(id)) throw new Error(this.t('err.closeProfileFirst'));
      if (enable) {
        // A fresh 12-word passphrase is generated here and returned ONCE, so the
        // launcher can show it. Nothing stores it - losing it means losing the data.
        const { passphrase, key } = await this.profiles.createVault(id);
        this.profiles.sealVault(id, key); // encrypt existing data right away
        wipe(key);
        this.pushProfiles();
        L.info('vault.created', { profile: id });
        return { passphrase };
      } else {
        if (this.profiles.isVaultLocked(id)) {
          if (!isValidMnemonic(passphrase ?? '')) throw new Error(this.t('enc.passphraseRequired'));
          const key = await this.profiles.deriveVaultKey(id, passphrase!).catch(() => { throw new Error(this.t('unlock.wrong')); });
          this.profiles.openVault(id, key);
          wipe(key);
        }
        this.profiles.removeVault(id);
      }
      this.pushProfiles();
      return true;
    });
    handle('mgr:reseal', L, async (_e, id: string, passphrase: string) => {
      const key = await this.profiles.deriveVaultKey(id, passphrase).catch(() => { throw new Error(this.t('unlock.wrong')); });
      this.profiles.sealVault(id, key);
      wipe(key);
      this.pushProfiles();
      return true;
    });
    // A 12-word phrase for an export (or for the user to write down); never stored.
    handle('mgr:new-passphrase', L, () => generateMnemonic());
    // ---- whole-suite backup: every chosen profile in one encrypted file ----
    // The file is what moves an installation to another computer. The flow is
    // two calls on purpose - the user sees the file name and types the phrase
    // in one dialog, and nothing is written or read until both are given.
    handle('mgr:backup-export', L, async (e, ids: string[], passphrase: string, withData: boolean) => {
      if (!isValidMnemonic(passphrase)) throw new Error(this.t('enc.passphraseRequired'));
      const list = (Array.isArray(ids) ? ids : []).map((id) => String(id)).filter(Boolean);
      if (!list.length) throw new Error(this.t('backup.needProfile'));
      if (withData && list.some((id) => this.isRunning(id))) throw new Error(this.t('err.closeProfileFirst'));
      const win = BrowserWindow.fromWebContents(e.sender)!;
      const r = await dialog.showSaveDialog(win, {
        defaultPath: path.join(ctx.layout.backups, `octo-backup-${fileStamp()}.octobackup`),
        filters: [{ name: 'Octo.su backup (encrypted)', extensions: ['octobackup'] }],
      });
      if (r.canceled || !r.filePath) return null;
      const result = await this.profiles.exportBundle(list, passphrase, r.filePath, !!withData);
      L.info('backup.exported', { profiles: result.profiles, withData: !!withData });
      return { ...result, file: r.filePath };
    });
    handle('mgr:backup-pick', L, async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)!;
      const r = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        filters: [{ name: 'Octo.su backup', extensions: ['octobackup'] }],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      return { file: r.filePaths[0], name: path.basename(r.filePaths[0]) };
    });
    handle('mgr:backup-import', L, async (_e, file: string, passphrase: string) => {
      if (!file) throw new Error(this.t('backup.needFile'));
      try {
        const created = await this.profiles.importBundle(String(file), String(passphrase ?? ''));
        this.pushProfiles();
        L.info('backup.imported', { profiles: created.length });
        return { profiles: created.map((profile) => ({ id: profile.id, name: profile.name })) };
      } catch (err) {
        if (err instanceof DecryptionError) throw new Error(this.t('unlock.wrong'));
        throw err;
      }
    });
    handle('mgr:export', L, async (e, id: string, passphrase: string, withData: boolean) => {
      if (!isValidMnemonic(passphrase)) throw new Error(this.t('enc.passphraseRequired'));
      if (withData && this.isRunning(id)) throw new Error(this.t('err.closeProfileFirst'));
      const p = this.profiles.get(id);
      const win = BrowserWindow.fromWebContents(e.sender)!;
      const r = await dialog.showSaveDialog(win, {
        defaultPath: path.join(ctx.layout.backups, `${p.name.replace(/[^\p{L}\p{N} _-]/gu, '_')}-${fileStamp()}.obprofile`),
        filters: [{ name: 'OctoBrowser profile (encrypted)', extensions: ['obprofile'] }],
      });
      if (r.canceled || !r.filePath) return false;
      await this.profiles.exportEncrypted(id, passphrase, r.filePath, !!withData);
      L.info('profile.exported', { profile: id, withData: !!withData });
      return true;
    });
    handle('mgr:import', L, async (e, passphrase: string) => {
      const win = BrowserWindow.fromWebContents(e.sender)!;
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'OctoBrowser profile', extensions: ['obprofile'] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      try {
        const p = await this.profiles.importEncrypted(r.filePaths[0], String(passphrase ?? ''));
        this.pushProfiles();
        return p;
      } catch (err) {
        if (err instanceof DecryptionError) throw new Error(this.t('unlock.wrong'));
        throw err;
      }
    });
    handle('settings:search:latency', L, async () => {
      const settings = ctx.settings.load();
      const engines = Object.keys(SEARCH_ENGINES) as SearchEngine[];
      return checkAllSearchLatency(engines, (url, init) => electronNet.fetch(url, init), appServicesOffline(settings));
    });
    handle('mgr:settings', L, (_e, patch: Record<string, unknown>) => {
      const updated = ctx.settings.update((s) => {
        deepAssign(s as unknown as Record<string, unknown>, patch);
        // Older renderer/API clients still send the boolean field. Keep that
        // path meaningful while the settings UI uses offlineMode.
        if (typeof patch.offline === 'boolean' && !('offlineMode' in patch)) s.offlineMode = patch.offline ? 'practical' : 'online';
      });
      if (patch.logs) ctx.logger.setMode(updated.logs.mode);
      if (patch.plugins) this.syncMediaPlugins();
      if (patch.ui && typeof (patch.ui as Record<string, unknown>).theme === 'string' && this.launcher && !this.launcher.isDestroyed()) {
        const chrome = launcherChrome(updated.ui.theme);
        this.launcher.setBackgroundColor(chrome.color);
        // The renderer-owned controls inherit the updated theme tokens.
      }
      // A sidebar preference is entirely local to the launcher. Apart from not
      // broadcasting it to profile windows, do not restart host resolution or
      // background-update scheduling for it. Those process-wide reconfigures
      // were unnecessary and could blank an already-rendering launcher on
      // some Windows/Electron combinations while the nav was being rebuilt.
      if (settingsAffectHostServices(patch)) {
        if (appServicesOffline(updated)) app.configureHostResolver({ secureDnsMode: 'off' });
        else {
          const doh = dohTemplate(updated);
          if (doh) app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: [doh] });
          else app.configureHostResolver({ secureDnsMode: 'off' });
        }
      }
      if ('updates' in patch) this.updates.configureBackground();
      // Sidebar ordering/visibility and launcher colour are manager-only. Do
      // not push a full state refresh into every open native browser window for
      // those changes: their chrome is unrelated and must remain untouched.
      // Browser-facing settings still refresh active profile windows below.
      if (profileRuntimeSettingsChanged(patch)) this.broadcast({ t: 'settings-updated' });
      return updated;
    });
    handle('mgr:set-language', L, (_e, lang: Lang) => {
      if (!isLang(lang)) throw new Error('invalid language');
      if (!ctx.prep.ephemeral) ctx.prep.store.setLanguage(lang);
      return true;
    });
    handle('mgr:relaunch', L, () => {
      for (const c of this.children.values()) c.channel.send({ t: 'quit', reason: 'user' });
      setTimeout(() => {
        const relaunchArgs = !app.isPackaged && process.argv.length > 1
          ? { args: process.argv.slice(1) }
          : undefined;
        app.relaunch(relaunchArgs);
        app.quit();
      }, 800);
      return true;
    });
    handle('mgr:factory-reset', L, () => {
      if (this.children.size) throw new Error(this.t('settings.resetCloseProfiles'));
      if (ctx.prep.ephemeral) throw new Error(this.t('settings.resetUnavailable'));
      // The next process removes data before Chromium opens the selected
      // user-data path, then opens the first-run screen with a clean state.
      setTimeout(() => {
        app.relaunch({ args: [...process.argv.slice(1), '--factory-reset'] });
        app.quit();
      }, 120);
      return true;
    });
    handle('mgr:open-folder', L, (_e, which: 'data' | 'logs' | 'backups' | 'downloads') => {
      const map = { data: ctx.layout.root, logs: ctx.layout.logs, backups: ctx.layout.backups, downloads: ctx.layout.profiles };
      void shell.openPath(map[which] ?? ctx.layout.root);
      return true;
    });
    handle('mgr:pick-folder', L, async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    });
    handle('mgr:move-folder-directory', L, async (_e, folder: string, root: string) => {
      this.fileProgress('move', 0, 0, '');
      const result = await this.moveFolderDirectory(String(folder ?? ''), String(root ?? ''), (completed, total, label) => this.fileProgress('move', completed, total, label));
      this.fileProgress('move', 1, 1, '');
      this.pushProfiles();
      return result;
    });
    // One file, filtered by extension. Used for an APK the user downloaded.
    handle('mgr:pick-file', L, async (e, input: { extensions?: string[] }) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const extensions = (input?.extensions ?? []).map((value) => String(value).replace(/[^a-z0-9]/gi, '').slice(0, 8)).filter(Boolean);
      const r = await dialog.showOpenDialog(win!, {
        properties: ['openFile'],
        filters: extensions.length ? [{ name: extensions.join(', ').toUpperCase(), extensions }] : [],
      });
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    });
    /**
     * Move the whole data folder to another base directory. The data is COPIED
     * first (never moved out from under a running process), the bootstrap file
     * is rewritten only after the copy succeeded, and the app relaunches so
     * Chromium starts from the new location. The old folder is left untouched.
     */
    handle('mgr:move-data', L, async (_e, baseDir: string, copyData: boolean) => {
      const check = validateBaseDir(String(baseDir ?? ''), ctx.prep.installDir);
      if (!check.ok) return { ok: false as const, errorKey: check.errorKey };
      const base = path.resolve(String(baseDir));
      const dataDir = path.join(base, ctx.prep.info.dataSubdir);
      if (path.resolve(dataDir).toLowerCase() === path.resolve(ctx.layout.root).toLowerCase()) {
        return { ok: false as const, errorKey: 'settings.dataDirSame' };
      }
      if (copyData) {
        if (!fs.existsSync(ctx.layout.root)) return { ok: false as const, errorKey: 'settings.dataDirMissing' };
        try {
          this.fileProgress('move', 0, 0, '');
          await copyDirectoryWithProgress(ctx.layout.root, dataDir, (completed, total, label) => this.fileProgress('move', completed, total, label));
          this.fileProgress('move', 1, 1, '');
          // The new directory is now complete. Remove the old data only after
          // the copy succeeded so a failed move never destroys the source.
          await deleteDirectoryWithProgress(ctx.layout.root, (completed, total, label) => this.fileProgress('delete', completed, total, label));
        } catch {
          return { ok: false as const, errorKey: 'settings.dataDirCopyFailed' };
        }
      } else {
        try {
          fs.mkdirSync(dataDir, { recursive: true });
        } catch {
          return { ok: false as const, errorKey: 'settings.dataDirCopyFailed' };
        }
      }
      const store = new BootstrapStore(bootstrapFileFor(ctx.prep.info, ctx.prep.portable));
      const cur = store.read();
      store.write({
        schema: 1,
        language: cur?.language ?? ctx.lang,
        baseDir: base,
        dataDir,
        firstRunAt: cur?.firstRunAt ?? new Date().toISOString(),
      });
      L.info('data.moved', { from: ctx.layout.root, to: dataDir, copied: !!copyData });
      return { ok: true as const, dataDir };
    });
    handle('mgr:logs-clear', L, () => L.clear());
    handle('mgr:log-mode', L, (_e, mode: 'off' | 'standard' | 'diagnostic') => {
      L.setMode(mode === 'off' || mode === 'diagnostic' ? mode : 'standard');
      ctx.settings.update((s) => { s.logs.mode = L.getMode(); });
      if (L.getMode() === 'off') L.clear();
      return L.getMode();
    });
    handle('mgr:backups', L, () => ({ settings: ctx.settings.listBackups(), profiles: this.profiles.store.listBackups() }));
    handle('mgr:backup-restore', L, (_e, which: 'settings' | 'profiles', name: string) => {
      if (which === 'settings') ctx.settings.restore(String(name));
      else this.profiles.store.restore(String(name));
      this.pushProfiles();
      return true;
    });
    handle('mgr:update-check', L, () => { this.requireOnline(); return this.updates.check(); });
    handle('mgr:update-download', L, () => { this.requireOnline(); return this.updates.download(); });
    handle('mgr:update-install', L, async (_e, file: string) => {
      const full = path.join(ctx.layout.updater, 'downloads', path.basename(String(file)));
      if (!fs.existsSync(full)) throw new Error('installer missing');
      for (const c of this.children.values()) c.channel.send({ t: 'quit', reason: 'update' });
      await this.updates.install(full);
      return true;
    });
    handle('mgr:update-postpone', L, () => { this.updates.postpone(24); return true; });
    handle('mgr:update-skip', L, (_e, v: string) => { this.updates.skipVersion(String(v)); return true; });
    handle('mgr:update-rollback', L, (_e, v: string) => this.updates.rollback(String(v)));
    handle('mgr:filters-update', L, () => this.maybeUpdateFilters(true));
    handle('mgr:launch-detect', L, () => { this.launchDetect(); return true; });
    handle('mgr:open-external', L, (_e, which: 'tor' | 'bitwarden' | 'releases' | 'wsb-docs' | 'whonix' | 'virtualbox' | 'whonix-other' | 'privacy-sexy' | 'privacy-sexy-search') => {
      this.requireOnline();
      const urls = {
        tor: 'https://www.torproject.org/download/',
        bitwarden: 'https://bitwarden.com/download/',
        releases: 'https://github.com/chargehuobey/lvocto/releases',
        'wsb-docs': 'https://learn.microsoft.com/windows/security/application-security/application-isolation/windows-sandbox/',
        // The isolation guide in Security links only to the official pages.
        whonix: 'https://www.whonix.org/wiki/Download',
        virtualbox: 'https://www.virtualbox.org/',
        'whonix-other': 'https://www.whonix.org/wiki/Other_Operating_Systems',
        'privacy-sexy': 'https://privacy.sexy',
        'privacy-sexy-search': 'https://duckduckgo.com/?q=privacy.sexy',
      };
      if (urls[which]) void shell.openExternal(urls[which]);
      return true;
    });
    handle('mgr:pick-tor', L, async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)!;
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'firefox.exe', extensions: ['exe'] }] });
      if (r.canceled || !r.filePaths[0] || path.basename(r.filePaths[0]).toLowerCase() !== 'firefox.exe') return null;
      ctx.settings.update((s) => { s.tor.torBrowserPath = r.filePaths[0]; });
      return r.filePaths[0];
    });
  }
}

/**
 * Only these manager-setting patches are reflected in a running browser chrome.
 * Launcher-only preferences (including sidebar order/visibility) deliberately
 * skip that IPC round-trip so editing the launcher cannot disturb a profile
 * window's native chrome or its page view.
 */
export function profileRuntimeSettingsChanged(patch: Record<string, unknown>): boolean {
  if ('offline' in patch || 'offlineMode' in patch || 'network' in patch) return true;
  const ui = patch.ui;
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return false;
  return ['verticalTabs', 'showBookmarksBar', 'confirmOnQuit', 'closeCountdown', 'openLinksInBackground', 'sleepTabsAfterMin'].some((key) => key in ui);
}

/** Host resolver changes are process-wide, so never run them for UI-only preferences. */
export function settingsAffectHostServices(patch: Record<string, unknown>): boolean {
  return 'offline' in patch || 'offlineMode' in patch || 'network' in patch;
}

/** Assign only keys that already exist in target (settings are validated afterwards). */
function deepAssign(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (!(k in target) || k === 'schema') continue;
    const cur = target[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object') deepAssign(cur as Record<string, unknown>, v as Record<string, unknown>);
    else if (typeof cur === typeof v) target[k] = v;
  }
}
