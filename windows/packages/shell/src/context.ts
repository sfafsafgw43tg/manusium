/**
 * packages/shell/src/context.ts
 *
 * Opens the application context after the first run:
 *   refuses to run elevated -> logger -> settings -> keyring
 *   (DPAPI auto-unlock, master-password window, or recovery) -> secret store.
 * Also applies app-wide DNS (DNS-over-HTTPS) and exposes translation helpers.
 */
import { app, dialog } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  AppSettings, CredManStore, DICTS, DataLayout, Keyring, KeyringMode, Lang, Logger, SecretRouter,
  SecretStoreApi, VersionedStore, appServicesOffline, credPrefixFor, credmanIndexPath, createSecretStores, createSettingsStore,
  dohTemplate, t as translate,
} from '@octo/core';
import { dpapiProtector } from './osprotector';
import { PreparedApp, hasFlag } from './prepare';
import { runFirstRun } from './firstrun';
import { runMasterPasswordUnlock } from './unlock';
import { recoverKeyring } from './keyring-recovery';
import { isElevated, relaunchUnelevated } from './winutil';

export interface AppContext {
  prep: PreparedApp;
  layout: DataLayout;
  lang: Lang;
  logger: Logger;
  settings: VersionedStore<AppSettings>;
  keyring: Keyring;
  secrets: SecretStoreApi;
  /** Where secrets are actually stored right now (Settings > Security). */
  secretBackend(): 'local' | 'credman';
  /** true when Windows Credential Manager can be used on this machine. */
  credmanAvailable(): boolean;
  t(key: string, params?: Record<string, string | number>): string;
}

/** Temporary logger used before a data folder exists (first-run wizard). */
export function firstRunLogger(prep: PreparedApp): Logger {
  return new Logger(path.join(prep.firstRunTempDir ?? os.tmpdir(), 'logs'), `${prep.info.id}-firstrun`);
}

/** Show an error box with localised text (falls back to English). */
export function fatal(lang: Lang, titleKey: string, bodyKey: string, params?: Record<string, string>): void {
  dialog.showErrorBox(translate(lang, titleKey), translate(lang, bodyKey, params));
}

/**
 * Open the keyring of an existing data folder.
 *  - mode "os": automatic DPAPI unlock, recovery dialog when it fails;
 *  - mode "password": master-password window (retry / forgot / cancel);
 *  - damaged file: same recovery as a failed DPAPI unlock.
 * @returns false when the app must quit.
 */
async function openKeyring(
  keyring: Keyring,
  layout: DataLayout,
  lang: Lang,
  logger: Logger,
  distDir: string,
  appId: 'octobrowser' | 'octodetect',
  productName: string,
): Promise<boolean> {
  let mode: KeyringMode | null = null;
  try {
    mode = keyring.mode();
  } catch (e) {
    logger.error('keyring.unreadable', { message: String((e as Error)?.message ?? e) });
  }

  if (mode === 'password') {
    const ok = await runMasterPasswordUnlock({ distDir, appId, productName, lang, layout, keyring, logger });
    if (!ok) return false;
    if (!keyring.isUnlocked()) return false; // paranoia: never continue half-open
    return true;
  }

  if (mode === 'os' || mode === null) {
    try {
      if (mode === null) throw new Error('keyring file damaged');
      await keyring.unlock();
      return true;
    } catch {
      logger.error('keyring.dpapi-failed');
      if (!dpapiProtector.available()) {
        fatal(lang, 'err.keyring.title', 'err.keyring.noDpapi');
        return false;
      }
      return recoverKeyring(keyring, layout, lang, logger, 'err.keyring.dpapiFailed');
    }
  }

  // Unknown future format: refuse to guess, offer recovery.
  logger.error('keyring.unknown-mode', { mode });
  return recoverKeyring(keyring, layout, lang, logger, 'err.keyring.damaged');
}

/**
 * Full startup sequence shared by both apps. Returns null when the app
 * should quit (user cancelled, first run requires relaunch, etc.).
 */
export async function startApp(prep: PreparedApp): Promise<AppContext | null> {
  const guessLangForErrors: Lang = prep.state?.language ?? (app.getLocale().startsWith('pl') ? 'pl' : 'en');

  // Do not run as Administrator. Typical cause: "Start OctoBrowser" on the last
  // page of an installer that ran elevated, or UAC switched off. First try to
  // restart as the normal user; if that is impossible, let the user decide
  // instead of refusing to start at all (the old hard error made the installed
  // app unusable on machines without UAC).
  if (!hasFlag('allow-elevated') && (await isElevated())) {
    if (relaunchUnelevated(prep.info.id, app.getPath('exe'), app.isPackaged)) {
      app.exit(0);
      return null;
    }
    const L = guessLangForErrors;
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: translate(L, 'err.elevated.title'),
      message: translate(L, 'err.elevated.title'),
      detail: translate(L, 'err.elevated.body'),
      buttons: [translate(L, 'err.elevated.continue'), translate(L, 'err.elevated.quit')],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (choice !== 0) return null;
  }

  if (!prep.state || !prep.layout) {
    const done = await runFirstRun(prep, firstRunLogger(prep));
    if (done) {
      // Relaunch so Chromium uses the chosen data folder from the very first byte.
      const relaunchArgs = !app.isPackaged && process.argv.length > 1
        ? { args: process.argv.slice(1) }
        : undefined;
      app.relaunch(relaunchArgs);
    }
    app.exit(0);
    return null;
  }

  const lang = prep.state.language;
  const layout = prep.layout;
  const logger = new Logger(layout.logs, prep.info.id);
  const settings = createSettingsStore(layout);
  const s = settings.load();
  logger.setMode(s.logs.mode);
  if (settings.lastLoadStatus === 'restored-from-backup' || settings.lastLoadStatus === 'reset-to-defaults') {
    logger.warn('settings.recovered', { status: settings.lastLoadStatus });
  }
  logger.info('app.start', { app: prep.info.id, version: app.getVersion(), ephemeral: prep.ephemeral, portable: prep.portable });

  // App-wide DNS: DNS-over-HTTPS when configured.
  const doh = appServicesOffline(s) ? null : dohTemplate(s);
  if (doh) {
    app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: [doh], enableBuiltInResolver: true });
    logger.info('dns.doh', { provider: s.network.dns.provider });
  }

  const keyring = new Keyring(path.join(layout.config, 'keyring.bin'), dpapiProtector);
  // --reset-keyring: deliberate fresh start (documented recovery).
  const forceReset = hasFlag('reset-keyring') && keyring.exists();
  if (!keyring.exists()) {
    // e.g. Windows Sandbox session or the user deleted the keyring: create a DPAPI keyring.
    if (!dpapiProtector.available()) {
      fatal(lang, 'err.keyring.title', 'err.keyring.noDpapi');
      return null;
    }
    await keyring.create();
  } else if (forceReset) {
    if (!(await recoverKeyring(keyring, layout, lang, logger, 'err.keyring.resetRequested'))) return null;
  } else if (!(await openKeyring(keyring, layout, lang, logger, prep.distDir, prep.info.id, prep.info.productName))) {
    return null;
  }
  if (!keyring.isUnlocked()) {
    fatal(lang, 'err.keyring.title', 'err.keyring.damaged');
    return null;
  }

  // Secret storage: encrypted local file by default, Windows Credential Manager
  // when the user selects it in Settings > Security (never both at once).
  const credman = new CredManStore({ prefix: credPrefixFor(prep.info.productName) });
  const stores = createSecretStores(
    { secretsFile: path.join(layout.config, 'secrets.bin'), credmanIndexFile: credmanIndexPath(layout.config) },
    keyring,
    credman,
  );
  const secrets = new SecretRouter(stores.local, stores.credman, () => settings.load().security.secretStore, () => credman.available());

  return {
    prep,
    layout,
    lang,
    logger,
    settings,
    keyring,
    secrets,
    secretBackend: () => secrets.backend(),
    credmanAvailable: () => credman.available(),
    t: (key, params) => translate(lang, key, params),
  };
}

/** Dictionaries for renderers. */
export function dictsFor(): typeof DICTS {
  return DICTS;
}

/** Re-export so apps do not need to know the module layout. */
export { recoverKeyring } from './keyring-recovery';
