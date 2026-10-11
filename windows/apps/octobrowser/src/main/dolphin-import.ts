/**
 * Dolphin Anty profile conversion.
 *
 * Imports everything 1:1 from Dolphin Anty (remote API or local JSON export):
 * - Active open windows & tabs, start pages, homepages, session restore
 * - Cookies (embedded JSON/Netscape or fetched via cloud sync API)
 * - Bookmarks & saved favorites
 * - Full fingerprint configuration (UA, OS, WebRTC, Canvas, WebGL, WebGPU,
 *   ClientRects, Timezone, Language, Geolocation, CPU, Memory, Screen, Fonts,
 *   Audio, Media Devices, Ports, DoNotTrack)
 * - Proxy credentials, rotation URLs, and proxy types
 * - Organization (tags, folders/groups, statuses, cleaned notes)
 */
import { defaultProfile, type Bookmark, type FingerprintConfig, type FingerprintOs, type Profile, type ProxyType } from '@octo/core';

export const DOLPHIN_IMPORT_FIELDS = ['organization', 'fingerprint', 'proxy', 'startPages', 'cookies'] as const;
export type DolphinImportField = (typeof DOLPHIN_IMPORT_FIELDS)[number];
export type DolphinImportOptions = Record<DolphinImportField, boolean>;

export interface DolphinProfileSummary {
  id: string;
  name: string;
  tags: string[];
  folder: string;
  hasProxy: boolean;
}

export interface DolphinProxyInput {
  type: ProxyType;
  text: string;
  changeIpUrl: string;
  name: string;
}

export interface DolphinTab {
  url: string;
  title: string;
  pinned: boolean;
}

export interface ConvertedDolphinProfile {
  name: string;
  patch: Partial<Omit<Profile, 'id' | 'createdAt' | 'updatedAt' | 'kind'>>;
  proxy?: DolphinProxyInput;
  tabs?: DolphinTab[];
  bookmarks?: Bookmark[];
  cookies?: unknown;
}

type Obj = Record<string, unknown>;

function object(value: unknown): Obj {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
}

function text(value: unknown, max = 4096): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function recordText(value: unknown, ...keys: string[]): string {
  const source = object(value);
  for (const key of keys) {
    const valueAtKey = text(source[key]);
    if (valueAtKey) return valueAtKey;
  }
  return '';
}

function strings(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => typeof item === 'string' ? item.trim().slice(0, 32) : recordText(item, 'name', 'title')).filter(Boolean))].slice(0, max);
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], fallback: T): T {
  return values.includes(value as T) ? value as T : fallback;
}

function profileRecord(value: unknown): Obj {
  const root = object(value);
  return object(root.data).id !== undefined ? object(root.data) : root;
}

function profileFolder(profile: Obj): string {
  return recordText(profile, 'folderName', 'groupName', 'folder_name', 'group_name') || recordText(profile.folder, 'name', 'title') || recordText(profile.group, 'name', 'title');
}

function profileStatus(profile: Obj): string {
  const value = profile.status;
  return text(value, 32) || recordText(value, 'name', 'title', 'label').slice(0, 32);
}

/** Convert either a list response, an array, or a single API result to safe UI summaries. */
export function dolphinProfileSummaries(value: unknown): DolphinProfileSummary[] {
  const root = object(value);
  const candidate = Array.isArray(value) ? value : Array.isArray(root.data) ? root.data : Array.isArray(object(root.data).data) ? object(root.data).data as unknown[] : [];
  const used = new Set<string>();
  const out: DolphinProfileSummary[] = [];
  for (const item of candidate) {
    const profile = profileRecord(item);
    const id = String(profile.id ?? '').trim();
    if (!/^\d{1,20}$/.test(id) || used.has(id)) continue;
    used.add(id);
    out.push({
      id,
      name: text(profile.name, 64) || `Dolphin profile ${id}`,
      tags: strings(profile.tags),
      folder: profileFolder(profile).slice(0, 48),
      hasProxy: Object.keys(object(profile.proxy)).length > 0 || !!profile.proxyId,
    });
  }
  return out;
}

function dolphinOs(profile: Obj): FingerprintOs {
  const platform = text(profile.platform ?? profile.os).toLowerCase();
  if (platform.includes('mac') || platform.includes('darwin')) return 'macos';
  if (platform.includes('linux')) return 'linux';
  const version = text(profile.platformVersion || profile.osVersion || profile.os_version);
  return /^1[15](?:\.\d+){0,2}$/.test(version) ? 'windows11' : 'windows10';
}

function mapWebRtc(value: unknown): FingerprintConfig['webrtc']['mode'] {
  switch (value) {
    case 'off':
    case 'disabled':
      return 'off';
    case 'real':
      return 'real';
    case 'manual':
      return 'manual';
    case 'udpDisabled':
    case 'disable-udp':
      return 'disable-udp';
    case 'altered':
    default:
      return 'altered';
  }
}

function mapNoise(value: unknown, fallback: FingerprintConfig['canvas']): FingerprintConfig['canvas'] {
  return enumValue(value, ['off', 'real', 'noise'] as const, fallback);
}

function mapFp(profile: Obj, base: FingerprintConfig): FingerprintConfig {
  const useragent = object(profile.useragent);
  const webrtc = object(profile.webrtc);
  const webglInfo = object(profile.webglInfo ?? profile.webgl_info);
  const timezone = object(profile.timezone);
  const locale = object(profile.locale ?? profile.language);
  const geolocation = object(profile.geolocation);
  const cpu = object(profile.cpu);
  const memory = object(profile.memory);
  const screen = object(profile.screen);
  const mediaDevices = object(profile.mediaDevices ?? profile.media_devices);
  const ports = object(profile.ports);
  const ua = text(useragent.value ?? useragent.userAgent ?? profile.userAgent ?? profile.useragent, 512);
  const uaFullVersion = text(profile.uaFullVersion ?? profile.ua_full_version, 32);
  const platformVersion = text(profile.platformVersion ?? profile.platform_version, 32);
  const webglMode = mapNoise(object(profile.webgl).mode, base.webgl);
  const manualWebgl = webglMode !== 'off' &&
    text(webglInfo.vendor ?? webglInfo.unmaskedVendor ?? webglInfo.unmasked_vendor, 128) &&
    text(webglInfo.renderer ?? webglInfo.unmaskedRenderer ?? webglInfo.unmasked_renderer, 256);
  const resolution = text(screen.resolution).match(/^(\d{3,4})\s*[x×]\s*(\d{3,4})$/i);
  const screenWidth = resolution ? Number(resolution[1]) : number(screen.width ?? profile.screenWidth, base.screen.width);
  const screenHeight = resolution ? Number(resolution[2]) : number(screen.height ?? profile.screenHeight, base.screen.height);
  const localeValue = text(locale.value ?? locale.languages ?? profile.locale, 64).split(',')[0].replace('_', '-');
  const timezoneValue = text(timezone.value ?? timezone.name ?? profile.timezone, 64);
  const geoMode = geolocation.mode === 'manual' ? 'manual' : 'auto';

  return {
    ...base,
    enabled: true,
    os: dolphinOs(profile),
    userAgent: ua || base.userAgent,
    ...(/^\d+\.\d+\.\d+\.\d+$/.test(uaFullVersion) ? { uaFullVersion } : {}),
    ...(/^\d+\.\d+\.\d+$/.test(platformVersion) ? { platformVersion } : {}),
    ...(text(profile.osVersion || profile.os_version, 64) ? { osVersion: text(profile.osVersion || profile.os_version, 64) } : {}),
    webrtc: { mode: mapWebRtc(webrtc.mode), publicIp: text(webrtc.ipAddress ?? webrtc.publicIp ?? webrtc.ip, 45) },
    canvas: mapNoise(object(profile.canvas).mode, base.canvas),
    webgl: webglMode,
    webglInfo: manualWebgl
      ? {
        mode: 'manual',
        vendor: text(webglInfo.vendor ?? webglInfo.unmaskedVendor ?? webglInfo.unmasked_vendor, 128),
        renderer: text(webglInfo.renderer ?? webglInfo.unmaskedRenderer ?? webglInfo.unmasked_renderer, 256),
      }
      : { mode: 'real', vendor: '', renderer: '' },
    webgpu: enumValue(object(profile.webgpu).mode, ['off', 'real'] as const, base.webgpu),
    clientRects: enumValue(object(profile.clientRect ?? profile.clientRects).mode, ['real', 'noise'] as const, base.clientRects),
    timezone: timezone.mode === 'manual' && timezoneValue ? { mode: 'manual', value: timezoneValue } : { mode: 'auto', value: '' },
    language: locale.mode === 'manual' && localeValue ? { mode: 'manual', value: localeValue } : { mode: 'auto', value: '' },
    geolocation: {
      mode: geoMode,
      latitude: number(geolocation.latitude ?? geolocation.lat, 0),
      longitude: number(geolocation.longitude ?? geolocation.lng ?? geolocation.lon, 0),
      accuracy: number(geolocation.accuracy, 10),
    },
    cpu: { mode: cpu.mode === 'manual' ? 'manual' : 'real', cores: number(cpu.value ?? cpu.cores, base.cpu.cores) },
    memory: { mode: memory.mode === 'manual' ? 'manual' : 'real', gb: number(memory.value ?? memory.ram, base.memory.gb) },
    screen: { mode: screen.mode === 'manual' ? 'manual' : 'real', width: screenWidth, height: screenHeight },
    fonts: enumValue(object(profile.fonts).mode, ['real', 'noise'] as const, base.fonts),
    audio: enumValue(object(profile.audio).mode, ['real', 'noise'] as const, base.audio),
    mediaDevices: {
      mode: mediaDevices.mode === 'manual' ? 'manual' : 'real',
      audioInputs: number(mediaDevices.audioInputs ?? mediaDevices.audio_inputs, base.mediaDevices.audioInputs),
      audioOutputs: number(mediaDevices.audioOutputs ?? mediaDevices.audio_outputs, base.mediaDevices.audioOutputs),
      videoInputs: number(mediaDevices.videoInputs ?? mediaDevices.video_inputs, base.mediaDevices.videoInputs),
    },
    ports: { mode: ports.mode === 'protect' ? 'protect' : 'real', list: text(ports.blacklist ?? ports.list, 1024) || base.ports.list },
    doNotTrack: bool(profile.doNotTrack),
  };
}

/** Accept the many shapes Dolphin uses for a start page and normalise them. */
function pageUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : recordText(value, 'url', 'href', 'link', 'address', 'value');
  if (!raw || raw.length > 2048) return '';
  if (/^(https?:\/\/|octo:\/\/)/i.test(raw)) return raw;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?::\d{2,5})?(?:[/?#]\S*)?$/i.test(raw)) return `https://${raw}`;
  return '';
}

/**
 * Collect all active open windows, tabs, and start pages from any Dolphin version.
 * Handles arrays of URLs, tab objects with title and pinned states, and window collections.
 */
export function dolphinTabs(value: unknown): DolphinTab[] {
  const root = profileRecord(value);
  const nested = object(root.data);
  const profile = Object.keys(nested).length ? { ...nested, ...root } : root;
  const tabs: DolphinTab[] = [];
  const seen = new Set<string>();

  const addTab = (item: unknown) => {
    if (!item) return;
    if (typeof item === 'string') {
      const url = pageUrl(item);
      if (url && !seen.has(url)) {
        seen.add(url);
        tabs.push({ url, title: url, pinned: false });
      }
      return;
    }
    if (typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const url = pageUrl(obj.url ?? obj.href ?? obj.link ?? obj.address ?? obj.value);
      if (url && !seen.has(url)) {
        seen.add(url);
        const title = text(obj.title ?? obj.name ?? obj.label) || url;
        const pinned = bool(obj.pinned ?? obj.isPinned);
        tabs.push({ url, title, pinned });
      }
    }
  };

  for (const key of ['tabs', 'activeTabs', 'openTabs', 'savedTabs', 'sessions', 'session', 'homepages', 'homePages', 'startUrls', 'startPages', 'urls', 'links']) {
    const bucket = profile[key];
    if (Array.isArray(bucket)) {
      for (const sub of bucket) addTab(sub);
    } else if (bucket && typeof bucket === 'object' && Array.isArray((bucket as Record<string, unknown>).tabs)) {
      for (const sub of (bucket as Record<string, unknown>).tabs as unknown[]) addTab(sub);
    } else if (bucket) {
      addTab(bucket);
    }
  }

  if (Array.isArray(profile.windows)) {
    for (const win of profile.windows as unknown[]) {
      if (win && typeof win === 'object' && Array.isArray((win as Record<string, unknown>).tabs)) {
        for (const sub of (win as Record<string, unknown>).tabs as unknown[]) addTab(sub);
      }
    }
  }

  for (const key of ['mainWebsite', 'main_website', 'startUrl', 'startPage', 'homepage', 'url', 'currentUrl']) {
    if (profile[key]) addTab(profile[key]);
  }

  return tabs.slice(0, 50);
}

/**
 * Collect the profile's start URLs.
 */
export function dolphinStartPages(value: unknown): string[] {
  return dolphinTabs(value).map((t) => t.url);
}

/**
 * Collect bookmarks from Dolphin Anty export payloads.
 */
export function dolphinBookmarks(value: unknown): Bookmark[] {
  const root = profileRecord(value);
  const nested = object(root.data);
  const profile = Object.keys(nested).length ? { ...nested, ...root } : root;
  const bms: Bookmark[] = [];
  const buckets: unknown[] = [];
  for (const key of ['bookmarks', 'bookMarks', 'bookmark_list', 'favorites', 'savedBookmarks']) {
    const b = profile[key];
    if (Array.isArray(b)) buckets.push(...b);
  }
  let idx = 1;
  for (const item of buckets) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const url = pageUrl(obj.url ?? obj.href ?? obj.link);
    if (!url) continue;
    const title = text(obj.title ?? obj.name ?? obj.label) || url;
    const folder = text(obj.folder ?? obj.folderName ?? obj.group) || undefined;
    bms.push({
      id: `bm-dolphin-${idx++}`,
      title,
      url,
      ...(folder ? { folder } : {}),
      createdAt: new Date().toISOString(),
    });
  }
  return bms.slice(0, 500);
}

/**
 * Extract embedded cookies from Dolphin Anty profile payloads.
 */
export function dolphinCookies(value: unknown): unknown {
  const root = profileRecord(value);
  const nested = object(root.data);
  const profile = Object.keys(nested).length ? { ...nested, ...root } : root;
  for (const key of ['cookies', 'cookie', 'cookiesData', 'cookie_data', 'cookieList', 'cookies_list']) {
    if (profile[key] !== undefined && profile[key] !== null) return profile[key];
  }
  return undefined;
}

function mapProxy(profile: Obj): DolphinProxyInput | undefined {
  const proxy = object(profile.proxy);
  const host = text(proxy.host ?? proxy.server ?? proxy.ip, 255);
  const port = Math.round(number(proxy.port, 0));
  const type = enumValue(proxy.type, ['http', 'https', 'socks4', 'socks5'] as const, 'http');
  if (!host || port < 1 || port > 65535) return undefined;
  const login = text(proxy.login ?? proxy.username ?? proxy.user, 256);
  const password = text(proxy.password ?? proxy.pass, 512);
  const address = login || password ? `${host}:${port}:${login}:${password}` : `${host}:${port}`;
  return {
    type,
    text: `${type}://${address}`,
    changeIpUrl: text(proxy.changeIpUrl ?? proxy.ipChangeUrl ?? proxy.change_ip_url, 2000),
    name: text(proxy.name ?? proxy.title, 64),
  };
}

/**
 * Map one full Dolphin API profile to an Octo profile creation request. The
 * caller decides which independently useful groups to carry across.
 */
export function convertDolphinProfile(value: unknown, options: DolphinImportOptions): ConvertedDolphinProfile {
  const profile = profileRecord(value);
  const name = text(profile.name, 64) || 'Dolphin profile';
  const base = defaultProfile('antidetect', name);
  const patch: ConvertedDolphinProfile['patch'] = {};

  if (options.organization) {
    const notes = recordText(profile.notes, 'content').replace(/<[^>]*>/g, '').slice(0, 4000) ||
      text(profile.notes ?? profile.note ?? profile.comment ?? profile.description, 4000).replace(/<[^>]*>/g, '');
    patch.tags = strings(profile.tags);
    patch.folder = profileFolder(profile).slice(0, 48);
    patch.status = profileStatus(profile);
    patch.notes = notes;
  }
  if (options.fingerprint) patch.fingerprint = mapFp(profile, base.fingerprint);
  
  const tabs = dolphinTabs(profile);
  if (options.startPages) {
    if (tabs.length) {
      patch.homePage = tabs[0].url;
      patch.startPages = tabs.slice(1).map((t) => t.url);
      patch.restoreSession = true;
    }
  }

  const bookmarks = dolphinBookmarks(profile);
  const cookies = dolphinCookies(profile);
  const proxy = options.proxy ? mapProxy(profile) : undefined;
  
  return {
    name,
    patch,
    ...(proxy ? { proxy } : {}),
    ...(tabs.length ? { tabs } : {}),
    ...(bookmarks.length ? { bookmarks } : {}),
    ...(cookies !== undefined ? { cookies } : {}),
  };
}

/**
 * Read a locally exported Dolphin Anty file (Export profiles -> JSON) without
 * touching its API. The export is either an array, `{ data: [...] }`, or a
 * single profile object; anything else yields an empty, honest result.
 */
export function parseDolphinExport(text: string): { profiles: unknown[]; summaries: DolphinProfileSummary[] } {
  let parsed: unknown;
  try { parsed = JSON.parse(String(text ?? '')); } catch { return { profiles: [], summaries: [] }; }
  const root = object(parsed);
  const list: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(root.data) ? root.data
      : Array.isArray(object(root.data).data) ? object(root.data).data as unknown[]
        : Array.isArray(root.profiles) ? root.profiles as unknown[]
          : Object.keys(root).length ? [parsed] : [];
  const profiles = list.filter((item) => Object.keys(profileRecord(item)).length > 0).slice(0, 2000);
  const summaries = dolphinProfileSummaries(profiles);
  const byIndex = profiles.map((item, index) => {
    const record = profileRecord(item);
    const id = String(record.id ?? '').trim();
    return summaries.find((summary) => summary.id === id) ?? {
      id: `local-${index + 1}`,
      name: text_(record.name) || `Dolphin profile ${index + 1}`,
      tags: strings(record.tags),
      folder: profileFolder(record).slice(0, 48),
      hasProxy: Object.keys(object(record.proxy)).length > 0,
    };
  });
  return { profiles, summaries: byIndex };
}

function text_(value: unknown): string {
  return text(value, 64);
}

