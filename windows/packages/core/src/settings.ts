/**
 * packages/core/src/settings.ts
 *
 * Application-wide settings (config/settings.json). Contains no secrets.
 * Stored with VersionedStore => automatic backup before every change.
 */
import * as path from 'node:path';
import { VersionedStore } from './config';
import { DataLayout } from './paths';
import { DEFAULT_UPDATE_SETTINGS, UpdateSettings } from './updater';
import type { LogMode } from './logger';
import { defaultMediaPlugins, validateMediaPlugins, type MediaPluginSettingsMap } from './media-plugins';

export type DohProvider = 'quad9' | 'cloudflare' | 'mullvad' | 'custom';

/**
 * Search engine used when the address bar gets words instead of a URL.
 * These providers are offered without built-in network suggestions; provider privacy practices may differ.
 */
export const SEARCH_ENGINE_DEFINITIONS = {
  duckduckgo: { queryUrl: 'https://duckduckgo.com/?q=', latencyUrl: 'https://duckduckgo.com' },
  'duckduckgo-noai': { queryUrl: 'https://html.duckduckgo.com/html/?q=', latencyUrl: 'https://html.duckduckgo.com' },
  startpage: { queryUrl: 'https://www.startpage.com/sp/search?query=', latencyUrl: 'https://www.startpage.com' },
  brave: { queryUrl: 'https://search.brave.com/search?q=', latencyUrl: 'https://search.brave.com' },
  mojeek: { queryUrl: 'https://www.mojeek.com/search?q=', latencyUrl: 'https://www.mojeek.com' },
  searx: { queryUrl: 'https://searx.be/search?q=', latencyUrl: 'https://searx.be' },
  qwant: { queryUrl: 'https://www.qwant.com/?q=', latencyUrl: 'https://www.qwant.com' },
  ecosia: { queryUrl: 'https://www.ecosia.org/search?q=', latencyUrl: 'https://www.ecosia.org' },
  metager: { queryUrl: 'https://metager.org/meta/meta.ger3?eingabe=', latencyUrl: 'https://metager.org' },
  swisscows: { queryUrl: 'https://swisscows.com/en/web?query=', latencyUrl: 'https://swisscows.com' },
  kagi: { queryUrl: 'https://kagi.com/search?q=', latencyUrl: 'https://kagi.com' },
} as const;
export type SearchEngine = keyof typeof SEARCH_ENGINE_DEFINITIONS;
export const SEARCH_ENGINES: Record<SearchEngine, string> = Object.fromEntries(
  Object.entries(SEARCH_ENGINE_DEFINITIONS).map(([id, definition]) => [id, definition.queryUrl]),
) as Record<SearchEngine, string>;
export type CloseAction = 'ask' | 'quit' | 'background';
/** Minimal launcher colour systems. They affect the local manager UI only. */
export type LauncherTheme = 'ink' | 'obsidian' | 'slate' | 'midnight' | 'navy' | 'charcoal' | 'amethyst' | 'purple' | 'forest' | 'emerald' | 'olive' | 'rose' | 'sunset' | 'copper' | 'frutigerAero' | 'liquidGlass' | 'halloweenDay' | 'halloweenNight' | 'kush' | 'tactical' | 'winterNight' | 'winterDay' | 'springBloom' | 'summerSolstice' | 'autumnHarvest' | 'valentines';
export const LAUNCHER_THEMES: LauncherTheme[] = ['ink', 'obsidian', 'slate', 'midnight', 'navy', 'charcoal', 'amethyst', 'purple', 'forest', 'emerald', 'olive', 'rose', 'sunset', 'copper', 'frutigerAero', 'liquidGlass', 'halloweenDay', 'halloweenNight', 'kush', 'tactical', 'winterNight', 'winterDay', 'springBloom', 'summerSolstice', 'autumnHarvest', 'valentines'];
/** Pages that may appear in the launcher's user-configurable sidebar. */
export type LauncherNavItem = 'profiles' | 'proxies' | 'backup' | 'virtualbox' | 'trash' | 'security' | 'api' | 'settings' | 'logs' | 'about';
export const LAUNCHER_NAV_ITEMS: LauncherNavItem[] = ['profiles', 'proxies', 'backup', 'virtualbox', 'trash', 'security', 'api', 'settings', 'logs', 'about'];
export interface LauncherSidebarEntry { id: LauncherNavItem; visible: boolean }
/** Scope of OctoBrowser's own network activity while no profile page is involved. */
export type OfflineMode = 'online' | 'practical' | 'strict';

/** Honest graphics/session containment settings. These never fabricate identity values. */
export type GraphicsExposureMode = 'native' | 'block';
export type SessionPersistenceMode = 'persistent' | 'ephemeral';
export type WindowsIsolationMode = 'none' | 'sandbox-no-vgpu';
export interface PrivacyRuntimeSettings {
  graphicsExposure: GraphicsExposureMode;
  sessionPersistence: SessionPersistenceMode;
  windowsIsolation: WindowsIsolationMode;
}

/** Both offline modes block app services; strict also installs an outbound-session guard. */
export function appServicesOffline(settings: Pick<AppSettings, 'offlineMode' | 'offline'>): boolean {
  return settings.offlineMode !== 'online' || settings.offline;
}

export function strictOffline(settings: Pick<AppSettings, 'offlineMode'>): boolean {
  return settings.offlineMode === 'strict';
}

export type SearchEnginePingResult = { engine: SearchEngine; reachable: boolean; latencyMs: number | null; error?: string };

export function searchEngineQueryUrl(engine: SearchEngine, query: string): string {
  const base = SEARCH_ENGINES[engine] ?? SEARCH_ENGINES.duckduckgo;
  return `${base}${encodeURIComponent(query)}`;
}

export const DOH_TEMPLATES: Record<Exclude<DohProvider, 'custom'>, string> = {
  quad9: 'https://dns.quad9.net/dns-query',
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  mullvad: 'https://dns.mullvad.net/dns-query',
};

export interface AppSettings {
  schema: 1;
  updates: UpdateSettings;
  network: {
    /** Consent for contacting an external service to show the public IP. Default OFF. */
    publicIpLookup: boolean;
    /** Refresh the traffic panel every 60 s. */
    autoRefresh: boolean;
    /** App-wide DNS (Chromium limitation: one resolver config per process). */
    dns: { mode: 'system' | 'doh'; provider: DohProvider; customTemplate: string };
    /** Search engine for words typed into the address bar. */
    searchEngine: SearchEngine;
  };
  security: {
    /** Lock encrypted profiles and the master-password keyring after N minutes idle (0 = never). */
    autoLockMinutes: number;
    /** Small secrets are kept only in the encrypted local vault (config/secrets.bin). */
    secretStore: 'local';
  };
  logs: { mode: LogMode };
  ui: {
    verticalTabs: boolean;
    /** Colour system for the launcher UI. */
    theme: LauncherTheme;
    /** Put background tabs to sleep after N minutes (0 = never). */
    sleepTabsAfterMin: number;
    /** Legacy compatibility value; current builds open the real window directly. */
    showStartupSplash: boolean;
    /** Show a bookmark bar under the address bar. */
    showBookmarksBar: boolean;
    /** Hide local directory paths and folder names across the UI (screenshot & streaming privacy). */
    hideDirectoryPaths: boolean;

    /** Ultra-fast simplified mode for VirtualBox and virtual machines (zero animations, no heavy filters, fast rendering). */
    virtualBoxMode: boolean;

    /** Ask before a browser window closes (the session can then be saved). */
    confirmOnQuit: boolean;
    /** What the app window's X button does. Ask is the privacy-safe default. */
    closeAction: CloseAction;
    /** Let a browser-close confirmation complete automatically after three seconds. */
    closeCountdown: boolean;
    /** Open links from bookmarks / history in a background tab. */
    openLinksInBackground: boolean;
    /** Soft, quick tab/panel/menu transitions. Can be disabled for zero motion. */
    animations: boolean;
    /** Canonical sidebar configuration: one ordered array with visibility per item. */
    sidebar: LauncherSidebarEntry[];
    /** Deprecated split representation retained for old API clients and migrated on load. */
    navOrder: LauncherNavItem[];
    navHidden: LauncherNavItem[];
  };
  tor: {
    /** Path to the official Tor Browser firefox.exe (auto-detected when empty). */
    torBrowserPath: string;
  };
  firefox: { firefoxPath: string };
  /** Application-local containment policy; never a fingerprint or identity setting. */
  privacyRuntime: PrivacyRuntimeSettings;
  /** Backward-compatible boolean: true whenever an offline mode is selected. */
  offline: boolean;
  /** Online, practical app-service blocking, or strict guarded launcher sessions. */
  offlineMode: OfflineMode;
  /**
   * Local automation REST API of the profile manager (127.0.0.1 only, Bearer
   * token kept in the encrypted secret store). Off by default.
   */
  api: { enabled: boolean; port: number };
  /** On/off switches of the vStudio media plugins (Mobile = Android, Web = browser profiles). */
  plugins: MediaPluginSettingsMap;
  filtersUpdatedAt?: string;
}

export function defaultSettings(): AppSettings {
  return {
    schema: 1,
    updates: { ...DEFAULT_UPDATE_SETTINGS },
    network: { publicIpLookup: false, autoRefresh: false, dns: { mode: 'system', provider: 'quad9', customTemplate: '' }, searchEngine: 'duckduckgo' },
    security: { autoLockMinutes: 15, secretStore: 'local' },
    logs: { mode: 'standard' },

    ui: { verticalTabs: false, theme: 'ink', sleepTabsAfterMin: 30, showStartupSplash: false, showBookmarksBar: false, hideDirectoryPaths: false, virtualBoxMode: false, confirmOnQuit: true, closeAction: 'ask', closeCountdown: true, openLinksInBackground: false, animations: true, sidebar: LAUNCHER_NAV_ITEMS.map((id) => ({ id, visible: true })), navOrder: [...LAUNCHER_NAV_ITEMS], navHidden: [] },

    tor: { torBrowserPath: '' },
    firefox: { firefoxPath: '' },
    privacyRuntime: { graphicsExposure: 'native', sessionPersistence: 'persistent', windowsIsolation: 'none' },
    offline: false,
    offlineMode: 'online',
    api: { enabled: false, port: 35555 },
    plugins: defaultMediaPlugins(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function strictInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max
    ? value : fallback;
}

function strictBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function safeText(value: unknown, max: number, fallback = ''): string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : fallback;
}

function safeAbsolutePath(value: unknown): string {
  const text = safeText(value, 2048);
  return !text || path.isAbsolute(text) ? text : '';
}

function launcherNavItems(value: unknown, includeMissing: boolean): LauncherNavItem[] {
  const selected = Array.isArray(value)
    ? value.filter((item): item is LauncherNavItem => typeof item === 'string' && LAUNCHER_NAV_ITEMS.includes(item as LauncherNavItem))
    : [];
  const unique = [...new Set(selected)];
  return includeMissing ? [...unique, ...LAUNCHER_NAV_ITEMS.filter((item) => !unique.includes(item))] : unique;
}

const VALID_SEARCH_ENGINES: ReadonlySet<string> = new Set(Object.keys(SEARCH_ENGINES));

function safeDoh(value: unknown, fallback: AppSettings['network']['dns']): AppSettings['network']['dns'] {
  const d = objectValue(value);
  const mode = d.mode === 'doh' ? 'doh' : 'system';
  const provider: DohProvider = d.provider === 'cloudflare' || d.provider === 'mullvad' || d.provider === 'custom' ? d.provider : 'quad9';
  const candidate = safeText(d.customTemplate, 2048);
  let customTemplate = '';
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password) customTemplate = candidate;
    } catch { /* invalid custom resolver */ }
  }
  return { mode, provider, customTemplate: mode === 'doh' && provider === 'custom' ? customTemplate : fallback.customTemplate };
}

export function validateSettings(value: unknown): AppSettings {
  const d = defaultSettings();
  if (!isRecord(value)) throw new Error('Settings must be a plain object');
  if (value.schema !== 1) throw new Error('Invalid settings schema');
  const updates = objectValue(value.updates);
  const network = objectValue(value.network);
  const security = objectValue(value.security);
  const ui = objectValue(value.ui);
  const tor = objectValue(value.tor);
  const firefox = objectValue(value.firefox);
  const privacyRuntime = objectValue(value.privacyRuntime);
  const api = objectValue(value.api);
  const dns = safeDoh(network.dns, d.network.dns);
  const selectedEngine = network.searchEngine === 'searxng' ? 'searx' : network.searchEngine;
  const searchEngine: SearchEngine = typeof selectedEngine === 'string' && VALID_SEARCH_ENGINES.has(selectedEngine)
    ? selectedEngine as SearchEngine : d.network.searchEngine;
  const offlineMode: OfflineMode = value.offlineMode === 'strict' || value.offlineMode === 'practical'
    ? value.offlineMode : value.offline === true ? 'practical' : 'online';
  const torPath = safeAbsolutePath(tor.torBrowserPath);
  const firefoxPath = safeAbsolutePath(firefox.firefoxPath);
  const legacyOrder = launcherNavItems(ui.navOrder, true);
  const legacyHidden = new Set(launcherNavItems(ui.navHidden, false));
  const rawSidebar = Array.isArray(ui.sidebar) ? ui.sidebar : legacyOrder.map((id) => ({ id, visible: !legacyHidden.has(id) }));
  const sidebar = [...new Map(rawSidebar.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !LAUNCHER_NAV_ITEMS.includes(entry.id as LauncherNavItem)) return [];
    return [[entry.id, { id: entry.id as LauncherNavItem, visible: strictBool(entry.visible, true) }] as const];
  })).values(), ...LAUNCHER_NAV_ITEMS.filter((id) => !rawSidebar.some((entry) => isRecord(entry) && entry.id === id)).map((id) => ({ id, visible: true }))];
  return {
    schema: 1,
    updates: {
      autoCheck: strictBool(updates.autoCheck, d.updates.autoCheck),
      backgroundCheck: strictBool(updates.backgroundCheck, d.updates.backgroundCheck),
      channel: updates.channel === 'beta' ? 'beta' : 'stable',
    },
    network: {
      publicIpLookup: strictBool(network.publicIpLookup, d.network.publicIpLookup),
      autoRefresh: strictBool(network.autoRefresh, d.network.autoRefresh),
      dns,
      searchEngine,
    },
    security: { autoLockMinutes: strictInt(security.autoLockMinutes, 0, 24 * 60, d.security.autoLockMinutes), secretStore: 'local' },
    logs: { mode: (() => { const mode = objectValue(value.logs).mode; return mode === 'off' || mode === 'diagnostic' ? mode : 'standard'; })() },
    ui: {
      verticalTabs: strictBool(ui.verticalTabs, d.ui.verticalTabs),
      theme: typeof ui.theme === 'string' && LAUNCHER_THEMES.includes(ui.theme as LauncherTheme) ? ui.theme as LauncherTheme : d.ui.theme,
      sleepTabsAfterMin: strictInt(ui.sleepTabsAfterMin, 0, 24 * 60, d.ui.sleepTabsAfterMin),
      showStartupSplash: strictBool(ui.showStartupSplash, d.ui.showStartupSplash),
      showBookmarksBar: strictBool(ui.showBookmarksBar, d.ui.showBookmarksBar),
      hideDirectoryPaths: strictBool(ui.hideDirectoryPaths, strictBool(ui.hidePaths, d.ui.hideDirectoryPaths)),
      virtualBoxMode: strictBool(ui.virtualBoxMode, strictBool(ui.vmMode, strictBool(ui.vmFriendlyMode, d.ui.virtualBoxMode))),
      confirmOnQuit: strictBool(ui.confirmOnQuit, d.ui.confirmOnQuit),
      closeAction: ui.closeAction === 'quit' || ui.closeAction === 'background' ? ui.closeAction : d.ui.closeAction,
      closeCountdown: strictBool(ui.closeCountdown, d.ui.closeCountdown),
      openLinksInBackground: strictBool(ui.openLinksInBackground, d.ui.openLinksInBackground),
      animations: strictBool(ui.animations, d.ui.animations),
      sidebar,
      navOrder: sidebar.map((entry) => entry.id), navHidden: sidebar.filter((entry) => !entry.visible).map((entry) => entry.id),
    },
    tor: { torBrowserPath: torPath },
    firefox: { firefoxPath },
    privacyRuntime: {
      graphicsExposure: privacyRuntime.graphicsExposure === 'block' ? 'block' : 'native',
      sessionPersistence: privacyRuntime.sessionPersistence === 'ephemeral' ? 'ephemeral' : 'persistent',
      windowsIsolation: privacyRuntime.windowsIsolation === 'sandbox-no-vgpu' ? 'sandbox-no-vgpu' : 'none',
    },
    offline: offlineMode !== 'online', offlineMode,
    api: { enabled: strictBool(api.enabled, d.api.enabled), port: strictInt(api.port, 1024, 65535, d.api.port) },
    plugins: validateMediaPlugins(value.plugins),
    filtersUpdatedAt: typeof value.filtersUpdatedAt === 'string' ? value.filtersUpdatedAt : undefined,
  };
}

export function dohTemplate(s: AppSettings): string | null {
  if (s.network.dns.mode !== 'doh') return null;
  if (s.network.dns.provider === 'custom') return s.network.dns.customTemplate || null;
  return DOH_TEMPLATES[s.network.dns.provider];
}

export function createSettingsStore(layout: DataLayout): VersionedStore<AppSettings> {
  return new VersionedStore<AppSettings>(path.join(layout.config, 'settings.json'), {
    backupDir: path.join(layout.backups, 'config'),
    defaults: defaultSettings,
    validate: validateSettings,
    maxBackups: 30,
  });
}
