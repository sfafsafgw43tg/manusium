/**
 * apps/octobrowser/src/renderer/launcher-editor.ts
 *
 * Create / edit profile dialog (one dialog for both):
 *   General  - name, status, tags, folder, profile type, browser shell, start pages,
 *              proxy (No proxy / New proxy with format auto-detection + check / Saved proxy),
 *              cookies import
 *   Advanced - fingerprint: OS selector tabs (Windows, macOS, Android, iOS, Linux) + sub-versions,
 *              User Agent generator (versions dropdown + text field + randomize),
 *              Language (IP-based, Language-based, Real, Custom),
 *              Timezone & Geolocation (IP-based, Custom, Ask, Allow, Disable),
 *              Screen resolution (Custom, Real, Random) & Window size (Custom, Default),
 *              Font list (Custom, Real) with count, Randomize, Edit, and Expand modal,
 *              Fingerprint spoofing controls: WebRTC (Substitute, Forward, Real, Disable),
 *              Canvas (Noise, Real), ClientRects (Noise, Real), AudioContext (Noise, Real),
 *              WebGL Image (Noise, Real), Media Devices (Noise, Real),
 *              WebGL Metadata (Custom, Real) with randomized Provider/Renderer list,
 *              WebGPU (WebGL based, Real, Disable), SpeechVoices (Noise, Real),
 *              Hardware Concurrency (cores), Device Memory (GB), Device Name (Custom, Real),
 *              MAC Address (Custom, Real), Do Not Track (Default, Enable, Close),
 *              Battery (Noise, Real), PortScan protection (Enable, Close),
 *              Hardware acceleration (Default, Enable, Close), Launch parameters,
 *              Live Local Fingerprint Signals Card & Verification with BrowserCheck / test sites.
 *   Browser  - protection level + individual switches, advanced accordion settings:
 *              Default Startup Pages, Restore last session, Data sync, Clear local cache,
 *              Browser Settings, Multi-open mode, Remote Inspector, Bookmark settings,
 *              Website access restriction, Extension settings, Video stream spoofing / camera options.
 *   Notes    - markdown/plain notes
 * with a live SUMMARY on the right ("NEW FINGERPRINT" renews the device).
 */
import { api, clear } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { parseProxy } from '@octo/core/proxy';
import { presetFor } from '@octo/core/privacy';
import { chromiumUserAgent } from '@octo/core/user-agent';
import { browserEngineFor, NEW_PROFILE_ENGINE, type BrowserEngine } from '@octo/core/inkbrowser';
import { DEFAULT_ENGINE_PRIVACY, sanitizeEnginePrivacy, type EnginePrivacySettings } from '@octo/core/engine-privacy';
import { ANDROID_VERSIONS, IOS_VERSIONS, mobileEmulationFor, MOBILE_DEVICES } from '@octo/core/mobile';
import {
  S, Profile, Kind, Level, FpOs, Fingerprint, ProxyType, ProxyCheck, SavedProxy, animateIn, run, toast, errText, modal, closeModal, field, fieldWithInfo, input, select, toggle,
  seg, frow, frowWithInfo, tagInput, osLabel, proxyText, checkLine, L, copyText, searchablePopupMenu,
} from './launcher-ui';
import { allFolders, STATUSES } from './launcher-profiles';
import { openProfileFingerprintTest, runProfileFingerprintAudit } from './launcher-fingerprint-audit';

// ------------------------------------------------------------------ draft

type ProxyMode = 'none' | 'new' | 'saved';
interface ProxyDraft { mode: ProxyMode; type: ProxyType; text: string; changeIpUrl: string; name: string; save: boolean; savedId: string; keep: boolean; lockdown: boolean; lockdownChanged?: boolean; check?: ProxyCheck }
type Sandbox = Profile['sandbox'];
type BrowserShell = Profile['browserShell'];
interface Draft {
  name: string; kind: Kind; engine: BrowserEngine | ''; chromiumRuntime?: string; status: string; tags: string[]; folder: string; profileDirectory?: string; notes: string; startPages: string[];
  homePage: string; searchEngine?: string; theme: 'dark' | 'light'; browserShell: BrowserShell; baseChromeLook: boolean; appMode: boolean; smartPaste: boolean; keepHistory: boolean; savePasswords: boolean; restoreSession: boolean; deleteOnClose: boolean;
  protection: { level: Level; overrides: Record<string, unknown> }; dns: Profile['dns']; sandbox: Sandbox; mobile: Profile['mobile']; addons: string[]; vstudioWebOnLaunch: boolean;
  mediaCapture: Profile['mediaCapture']; enginePrivacy: EnginePrivacySettings;
  fp: Fingerprint | null; proxy: ProxyDraft;
  /** Exported cookies to import (JSON / Netscape), empty = none. */
  cookies: string;
}

const ANTI_ADDONS = ['audio-mixer'];
const GOOGLE_HOME = 'https://www.google.com/';
const savesPasswordsByDefault = (kind: Kind) => kind !== 'private' && kind !== 'temporary' && kind !== 'tor';

const CHROME_VERSIONS_LIST = [
  '155', '154', '153', '152', '151', '150', '149', '148', '147', '146', '145', '144', '143', '142', '141', '140',
  '139', '138', '137', '136', '135', '134', '133', '132', '131', '130', '129', '128', '127', '126', '125', '124',
  '123', '122', '121', '120', '119', '118', '117', '116', '115',
];

const FIREFOX_VERSIONS_LIST = [
  '140', '139', '138', '137', '136', '135', '134', '133', '132', '131', '130',
  '129', '128', '127', '126', '125', '124', '123', '122', '121', '120', '119',
  '118', '117', '116', '115',
];

const SAFARI_VERSIONS_LIST = [
  '18.5', '18.4', '18.3', '18.2', '18.1', '18.0', '17.6', '17.5', '17.4', '17.3', '17.2', '17.1', '17.0', '16.6',
];

const WIN_FONTS_CATALOG = [
  'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Cambria Math', 'Candara', 'Century Gothic',
  'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'Ebrima', 'Franklin Gothic Medium',
  'Gabriola', 'Gadugi', 'Georgia', 'Impact', 'Ink Free', 'Javanese Text', 'Leelawadee UI',
  'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic', 'Marlett', 'Microsoft Himalaya',
  'Microsoft JhengHei', 'Microsoft New Tai Lue', 'Microsoft PhagsPa', 'Microsoft Sans Serif',
  'Microsoft Tai Le', 'Microsoft YaHei', 'Microsoft Yi Baiti', 'MingLiU-ExtB', 'Mongolian Baiti',
  'MS Gothic', 'MS PGothic', 'MS UI Gothic', 'MV Boli', 'Myanmar Text', 'Nirmala UI',
  'Palatino Linotype', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Segoe UI Emoji',
  'Segoe UI Historic', 'Segoe UI Symbol', 'SimSun', 'Sitka Text', 'Sylfaen', 'Symbol',
  'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Webdings', 'Wingdings', 'Yu Gothic',
];

const MAC_FONTS_CATALOG = [
  'American Typewriter', 'Andale Mono', 'Apple Chancery', 'Apple Color Emoji', 'Apple SD Gothic Neo',
  'Arial', 'Arial Black', 'Arial Narrow', 'Arial Rounded MT Bold', 'Athelas', 'Avenir', 'Avenir Next',
  'Baskerville', 'Big Caslon', 'Bodoni 72', 'Bradley Hand', 'Brush Script MT', 'Chalkboard',
  'Chalkduster', 'Charter', 'Cochin', 'Comic Sans MS', 'Copperplate', 'Courier', 'Courier New',
  'Didot', 'DIN Alternate', 'DIN Condensed', 'Futura', 'Geneva', 'Georgia', 'Gill Sans',
  'Helvetica', 'Helvetica Neue', 'Herculanum', 'Hoefler Text', 'Impact', 'Iowan Old Style',
  'Lucida Grande', 'Luminari', 'Marion', 'Marker Felt', 'Menlo', 'Monaco', 'Noteworthy',
  'Optima', 'Palatino', 'Papyrus', 'Phosphate', 'PingFang SC', 'Plantagenet Cherokee',
  'PT Sans', 'PT Serif', 'San Francisco', 'Savoye LET', 'Seravek', 'SignPainter', 'Skia',
  'Snell Roundhand', 'Tahoma', 'Times', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Zapfino',
];

const LINUX_FONTS_CATALOG = [
  'Bitstream Vera Sans', 'Cantarell', 'DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif',
  'Droid Sans', 'FreeMono', 'FreeSans', 'FreeSerif', 'Liberation Mono', 'Liberation Sans',
  'Liberation Serif', 'Nimbus Roman No9 L', 'Nimbus Sans L', 'Noto Color Emoji', 'Noto Mono',
  'Noto Sans', 'Noto Serif', 'Open Sans', 'Roboto', 'Ubuntu', 'Ubuntu Condensed', 'Ubuntu Mono',
];

function fontsForOs(os: FpOs): string[] {
  if (os === 'macos') return MAC_FONTS_CATALOG;
  if (os === 'linux') return LINUX_FONTS_CATALOG;
  return WIN_FONTS_CATALOG;
}

function randomMacAddr(): string {
  const hex = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase();
  const first = ((Math.floor(Math.random() * 256) & 0xfe) | 0x02).toString(16).padStart(2, '0').toUpperCase();
  return `${first}:${hex()}:${hex()}:${hex()}:${hex()}:${hex()}`;
}

function randomDeviceName(os: FpOs): string {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let randStr = '';
  for (let i = 0; i < 7; i++) randStr += chars[Math.floor(Math.random() * chars.length)];
  if (os === 'macos') return `MacBook-Pro-${randStr.slice(0, 4)}`;
  if (os === 'linux') return `desktop-${randStr.toLowerCase().slice(0, 6)}`;
  return `DESKTOP-${randStr}`;
}

function kindDefaults(kind: Kind, addons: string[]): Pick<Draft, 'protection' | 'sandbox' | 'mobile' | 'keepHistory' | 'savePasswords' | 'restoreSession' | 'deleteOnClose' | 'addons'> {
  const anti = kind === 'antidetect';
  const phone = kind === 'phone';
  return {
    protection: { level: anti || phone ? 'normal' : kind === 'tor' ? 'tor' : kind === 'private' || kind === 'temporary' ? 'strict' : 'standard', overrides: {} },
    sandbox: {
      mode: kind === 'testing' || kind === 'private' ? 'restricted' : 'none',
      clipboard: kind === 'private' || kind === 'temporary' ? 'write-only' : 'allow',
      camera: anti || kind === 'personal' || kind === 'work', microphone: anti || kind === 'personal' || kind === 'work',
      externalDevices: false, shareDownloads: false,
    },
    mobile: phone ? { device: 'pixel-8', orientation: 'portrait' } : { device: 'none', orientation: 'portrait' },
    keepHistory: anti || phone || kind === 'personal' || kind === 'work',
    savePasswords: savesPasswordsByDefault(kind),
    restoreSession: anti || phone || kind === 'personal' || kind === 'work',
    deleteOnClose: kind === 'temporary',
    addons: kind === 'tor' ? [] : anti ? ANTI_ADDONS : addons,
  };
}

function newDraft(): Draft {
  const folder = S.folder && S.folder !== '__none' ? S.folder : '';
  return {
    name: '', kind: 'antidetect', engine: 'inkbrowser', chromiumRuntime: '155.0.8059.39', status: '', tags: [], folder, profileDirectory: '', notes: '', startPages: [], homePage: '', searchEngine: '', theme: 'dark', browserShell: 'chrome', baseChromeLook: true, appMode: false, smartPaste: true,
    dns: { mode: 'inherit', dohTemplate: '' },
    ...kindDefaults('antidetect', S.init.addons.filter((a) => a.kind !== 'external-app').map((a) => a.id)),
    vstudioWebOnLaunch: false,
    mediaCapture: { cameraLabel: '', microphoneLabel: '' }, enginePrivacy: structuredClone(DEFAULT_ENGINE_PRIVACY),
    fp: null,
    proxy: { mode: 'none', type: 'http', text: '', changeIpUrl: '', name: '', save: false, savedId: '', keep: false, lockdown: true },
    cookies: '',
  };
}

function draftFrom(p: Profile): Draft {
  const px = p.network.proxy;
  let proxy: ProxyDraft = { mode: 'none', type: 'http', text: '', changeIpUrl: '', name: '', save: false, savedId: '', keep: false, lockdown: p.network.lockdown !== false };
  if (p.network.mode === 'proxy') {
    if (px?.savedId && S.proxies.some((s) => s.id === px.savedId)) proxy = { ...proxy, mode: 'saved', savedId: px.savedId, keep: true, check: p.proxyCheck };
    else if (px) proxy = { ...proxy, mode: 'new', type: px.type, text: proxyText(px), changeIpUrl: px.changeIpUrl, name: px.name, keep: true, check: p.proxyCheck };
    else proxy = { ...proxy, mode: 'new', text: p.network.proxyRules ?? '', keep: true };
  }
  const c = structuredClone(p);
  return {
    name: c.name, kind: c.kind, engine: browserEngineFor(c.engine), chromiumRuntime: c.chromiumRuntime, status: c.status ?? '', tags: c.tags ?? [], folder: c.folder ?? '', profileDirectory: c.profileDirectory ?? '', notes: c.notes ?? '', startPages: c.startPages ?? [],
    homePage: c.homePage === 'octo://newtab' ? '' : c.homePage, searchEngine: c.searchEngine ?? '', theme: c.theme, browserShell: c.browserShell, baseChromeLook: c.baseChromeLook === true, appMode: c.appMode === true, smartPaste: c.smartPaste !== false, keepHistory: c.keepHistory, savePasswords: c.savePasswords === true, restoreSession: c.restoreSession, deleteOnClose: c.deleteOnClose,
    protection: { level: c.protection.level, overrides: c.protection.overrides ?? {} }, dns: c.dns, sandbox: c.sandbox, mobile: c.mobile ?? { device: 'none', orientation: 'portrait' }, addons: c.addons,
    vstudioWebOnLaunch: c.vstudioWebOnLaunch === true,
    mediaCapture: c.mediaCapture ?? { cameraLabel: '', microphoneLabel: '' }, enginePrivacy: sanitizeEnginePrivacy(c.enginePrivacy ?? DEFAULT_ENGINE_PRIVACY),
    fp: c.fingerprint?.enabled ? c.fingerprint : c.kind === 'antidetect' ? c.fingerprint : null, proxy, cookies: '',
  };
}

// ------------------------------------------------------------------ fingerprint data

interface GpuPreset { vendor: string; renderer: string }
const metaCache = new Map<FpOs, { gpus: GpuPreset[]; userAgent: string; engine: { major: number; full: string } }>();
async function meta(os: FpOs) {
  if (!metaCache.has(os)) {
    const m = await run(api.invoke<{ gpus: GpuPreset[]; userAgent: string; engine: { major: number; full: string } }>('mgr:fingerprint-meta', os));
    if (m) metaCache.set(os, m);
  }
  return metaCache.get(os);
}

const SCREENS: Record<'desktop' | 'mac', string[]> = {
  desktop: ['1920x1080', '1366x768', '1536x864', '1440x900', '1600x900', '1280x720', '1280x1024', '1680x1050', '1920x1200', '2560x1440', '2560x1080', '3440x1440', '3840x2160'],
  mac: ['1440x900', '1280x800', '1512x982', '1728x1117', '1680x1050', '1920x1080', '2560x1440', '2560x1600'],
};
const CORES = [2, 4, 6, 8, 10, 12, 16, 20, 24, 32];
const MEMORY = [1, 2, 4, 8, 16, 32];
const LANGS = ['en-US,en', 'en-GB,en', 'pl-PL,pl,en-US,en', 'de-DE,de,en-US,en', 'fr-FR,fr,en-US,en', 'es-ES,es,en-US,en', 'it-IT,it,en-US,en', 'uk-UA,uk,en-US,en', 'ru-RU,ru,en-US,en', 'pt-BR,pt,en-US,en', 'nl-NL,nl,en-US,en', 'tr-TR,tr,en-US,en', 'cs-CZ,cs,en-US,en', 'ja-JP,ja,en-US,en'];
function timezones(): string[] {
  try { return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone'); } catch { return ['UTC', 'Europe/Warsaw', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo']; }
}

// ------------------------------------------------------------------ privacy overrides

const OVERRIDES: Array<{ key: string; type: 'bool' | 'enum'; values?: string[] }> = [
  { key: 'blockAds', type: 'bool' }, { key: 'blockTrackers', type: 'bool' }, { key: 'httpsOnly', type: 'bool' },
  { key: 'blockThirdPartyCookies', type: 'bool' }, { key: 'stripTrackingParams', type: 'bool' }, { key: 'blockBounceTracking', type: 'bool' },
  { key: 'blockAutoplay', type: 'bool' }, { key: 'clearOnExit', type: 'bool' }, { key: 'warnDangerousDownloads', type: 'bool' }, { key: 'blockPopups', type: 'bool' },
  { key: 'trimReferrer', type: 'bool' }, { key: 'globalPrivacyControl', type: 'bool' },
  { key: 'geolocation', type: 'enum', values: ['ask', 'block'] }, { key: 'notifications', type: 'enum', values: ['ask', 'block'] },
  { key: 'confirmCrossSiteRedirects', type: 'bool' },
];
/** Engine-level switches only matter for profiles without a fingerprint (the fingerprint decides them otherwise). */
const ENGINE_OVERRIDES: Array<{ key: string; type: 'enum'; values: string[] }> = [
  { key: 'webrtc', type: 'enum', values: ['default', 'default_public_interface_only', 'disable_non_proxied_udp'] },
  { key: 'canvas', type: 'enum', values: ['allow', 'block-readback'] }, { key: 'webgl', type: 'enum', values: ['allow', 'disabled'] },
  { key: 'hardwareApis', type: 'enum', values: ['allow', 'normalize'] },
];

// ------------------------------------------------------------------ dialog

type Tab = 'general' | 'advanced' | 'browser' | 'mobile' | 'notes' | 'mass';

export function openEditor(p: Profile | null): void {
  const d = p ? draftFrom(p) : newDraft();
  const creating = !p;
  let tab: Tab = 'general';
  let busy = false;
  const mass: MassDraft = { text: '', os: 'windows11', type: 'http', prefix: '' };

  modal(creating ? t('ui.createProfile') : t('profile.editTitle', { name: p!.name }), (box) => {
    const tabs = h('div', { class: 'tabs ed-tabs', role: 'tablist' });
    const main = h('div', { class: 'ed-main' });
    const side = h('aside', { class: 'ed-side' });
    const err = h('div', { class: 'err', role: 'alert' });

    const summary = () => { clear(side); side.append(summaryPanel(d, renewFp, creating)); };
    // Redrawing after a field change must stay still; only a tab switch moves.
    let drawnTab = '';
    const draw = () => {
      clear(tabs);
      const TABS: Array<[Tab, string]> = [['general', 'edit.tab.general'], ['advanced', 'ui.tab.advanced'], ['browser', 'ui.tab.browser']];
      if (d.mobile.device !== 'none' && d.kind !== 'phone') TABS.push(['mobile', 'edit.tab.mobile']);
      TABS.push(['notes', 'ui.tab.notes']);
      if (tab === 'mobile' && (d.mobile.device === 'none' || d.kind === 'phone')) tab = 'advanced';
      if (creating) TABS.push(['mass', 'mass.tab']);
      for (const [k, key] of TABS) {
        const b = h('button', { class: k === tab ? 'on' : '', role: 'tab', 'aria-selected': String(k === tab) }, k === 'mass' ? icon('import', 15) : null, h('span', { text: t(key) }));
        b.onclick = () => { tab = k; draw(); };
        tabs.append(b);
      }
      const tabChanged = drawnTab !== '' && drawnTab !== tab;
      const prevScrollTop = tabChanged ? 0 : main.scrollTop;
      clear(main);
      if (tab === 'general') general(main, d, creating, p, draw, summary);
      if (tab === 'advanced') advanced(main, d, draw, summary, p);
      if (tab === 'browser') browser(main, d, draw, summary);
      if (tab === 'mobile') mobile(main, d, summary);
      if (tab === 'notes') notes(main, d);
      if (tab === 'mass') massImport(main, mass, d, () => setSaveLabel());
      setSaveLabel();
      if (drawnTab && drawnTab !== tab) animateIn(main, 'fade');
      if (tabChanged) {
        main.scrollTop = 0;
      } else {
        main.scrollTop = prevScrollTop;
      }
      drawnTab = tab;
      summary();
    };
    const renewFp = async () => {
      const os = d.fp?.os ?? 'windows11';
      const fp = await run(api.invoke<Fingerprint>('mgr:fingerprint-new', os));
      if (!fp) return;
      const cur = d.fp;
      const mobileUa = mobileEmulationFor(d.mobile, fp.uaFullVersion)?.userAgent;
      fp.userAgent = mobileUa ?? chromiumUserAgent(fp.os, Number(fp.uaFullVersion.split('.')[0]) || 140);
      d.fp = cur ? { ...fp, timezone: cur.timezone, language: cur.language, geolocation: cur.geolocation, webrtc: cur.webrtc, ports: cur.ports, doNotTrack: cur.doNotTrack, osVersion: cur.osVersion } : fp;
      draw();
      toast(t('fp.generated'), 'ok');
    };

    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    const save = h('button', { class: 'btn primary upper' }, icon('check', 16), h('span', { text: creating ? t('ui.createProfile') : t('common.save') })) as HTMLButtonElement;
    const saveLabel = save.querySelector('span')!;
    const setSaveLabel = () => {
      const n = tab === 'mass' ? massLines(mass).filter((l) => !l.error).length : 0;
      saveLabel.textContent = tab === 'mass' ? t('mass.createN', { n }) : creating ? t('ui.createProfile') : t('common.save');
      save.disabled = busy || (tab === 'mass' && n === 0);
    };
    save.onclick = async () => {
      if (busy) return;
      err.textContent = '';
      if (tab === 'mass') {
        busy = true;
        const r = await runMassImport(mass, d, (done, total) => { saveLabel.textContent = t('mass.progress', { done, total }); });
        busy = false;
        setSaveLabel();
        if (r.created) { closeModal(); toast(t('mass.done', { n: r.created }), 'ok'); }
        if (r.errors.length) { toast(t('mass.failedN', { n: r.errors.length }), 'err'); if (!r.created) err.textContent = r.errors[0]; }
        return;
      }
      const proxy = proxyInput(d.proxy);
      if (typeof proxy === 'string') { err.textContent = proxy; tab = 'general'; draw(); return; }
      busy = true;
      save.disabled = true;
      const patch: Record<string, unknown> = {
        engine: d.engine || NEW_PROFILE_ENGINE, chromiumRuntime: d.chromiumRuntime, status: d.status, tags: d.tags, folder: d.folder.trim(), profileDirectory: d.profileDirectory?.trim() || undefined, notes: d.notes, startPages: d.startPages,
        homePage: d.homePage.trim() || 'octo://newtab', searchEngine: d.searchEngine || undefined, theme: d.theme, browserShell: d.browserShell, baseChromeLook: d.baseChromeLook, appMode: d.appMode, smartPaste: d.smartPaste, keepHistory: d.keepHistory, savePasswords: d.savePasswords, restoreSession: d.restoreSession,
        deleteOnClose: d.deleteOnClose, protection: d.protection, dns: d.dns, sandbox: d.sandbox, mobile: d.mobile, addons: d.addons,
        vstudioWebOnLaunch: d.vstudioWebOnLaunch,
        mediaCapture: d.mediaCapture, enginePrivacy: d.enginePrivacy,
      };
      if (d.fp) patch.fingerprint = d.fp;
      else if (!creating && p!.fingerprint?.enabled) patch.fingerprint = { ...p!.fingerprint, enabled: false };
      const name = d.name.trim();
      const cookies = d.cookies.trim() || undefined;
      const r = creating
        ? await run(api.invoke<Profile>('mgr:create', { name, kind: d.kind, patch, proxy, cookies }))
        : await run(api.invoke<Profile>('mgr:update', p!.id, { ...patch, name: name || p!.name, proxy, cookies }));
      busy = false;
      save.disabled = false;
      if (!r) return;
      if (creating) S.flash = r.id;
      closeModal();
      toast(t(creating ? 'toast.profileCreated' : p!.running ? 'ui.savedRestart' : 'toast.saved'), 'ok');
    };
    const foot = h('div', { class: 'ed-foot' },
      !creating && p!.running ? h('span', { class: 'hint' }, icon('info', 14), ` ${t('edit.runningNote')}`) : h('span', {}),
      h('div', { class: 'grow' }), err, cancel, save);
    box.append(tabs, h('div', { class: 'ed-body' }, main, side), foot);
    draw();
    if (creating) void api.invoke<Fingerprint>('mgr:fingerprint-new', 'windows11').then((fp) => {
      if (!d.fp && d.kind !== 'tor') { d.fp = fp; draw(); }
    }).catch(() => undefined);
  }, 'editor');
}

/** Draft proxy -> ProxyInput for the main process, or an error message. */
function proxyInput(px: ProxyDraft): unknown {
  if (px.mode === 'none') return { mode: 'none' };
  if (px.keep && !px.lockdownChanged) return { mode: 'keep' };
  if (px.mode === 'saved') return px.savedId ? { mode: 'saved', savedId: px.savedId, lockdown: px.lockdown } : t('proxy.err.pickSaved');
  if (!px.text.trim()) return t('proxy.err.empty');
  const r = parseProxy(px.text, px.type);
  if (!r.ok) return t(r.error ?? 'proxy.err.format');
  if (px.changeIpUrl && !/^https?:\/\/\S+$/i.test(px.changeIpUrl.trim())) return t('proxy.err.changeIpUrl');
  return { mode: 'new', text: px.text.trim(), type: px.type, changeIpUrl: px.changeIpUrl.trim(), name: px.name.trim(), save: px.save, lockdown: px.lockdown };
}

function section(title: string, ...children: Array<HTMLElement | null>): HTMLElement {
  return h('section', { class: 'ed-sec' }, title ? h('h3', { text: title }) : null, ...children);
}

// ------------------------------------------------------------------ General

function general(b: HTMLElement, d: Draft, creating: boolean, p: Profile | null, draw: () => void, summary: () => void): void {
  const name = input(d.name, { maxlength: '64', placeholder: creating ? t('ui.namePhAuto') : '' }, (v) => { d.name = v; summary(); });
  const status = select<string>(STATUSES.includes(d.status) ? d.status : '', STATUSES.map((s) => [s, s ? t(`status.p.${s}`) : t('ui.noStatus')] as [string, string]), (v) => { d.status = v; });
  const folders = allFolders();
  const dl = h('datalist', { id: 'ed-folders' });
  for (const f of folders) dl.append(h('option', { value: f }));
  const folder = input(d.folder, { list: 'ed-folders', maxlength: '48', placeholder: t('ui.noFolder') }, (v) => { d.folder = v; });
  const directory = input(d.profileDirectory ?? '', { maxlength: '2048', placeholder: t('ui.profileDirectoryDefault') }, (v) => { d.profileDirectory = v.trim(); });
  const chooseDirectory = h('button', { type: 'button', class: 'btn small' }, icon('folder', 14), h('span', { text: t('ui.chooseProfileDirectory') }));
  chooseDirectory.onclick = async () => {
    const picked = await run(api.invoke<string | null>('mgr:pick-folder'));
    if (picked) { d.profileDirectory = picked; directory.value = picked; }
  };
  const directoryRow = h('div', { class: 'row nowrap' }, directory, chooseDirectory);
  const allTags = [...new Set(S.profiles.flatMap((x) => x.tags ?? []))];
  b.append(section(t('ui.sec.main'),
    h('div', { class: 'grid2' }, field('profile.name', name), field('ui.status', status)),
    h('div', { class: 'grid2' }, h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('ui.tags') }), tagInput(d.tags, (v) => { d.tags = v; }, allTags)), field('ui.folder', folder)),
    field('ui.profileDirectory', directoryRow, 'ui.profileDirectoryHint'), dl));

  // Profile type
  const hiddenLegacyKinds: Kind[] = ['personal', 'work'];
  const kinds = S.init.kinds.filter((k) =>
    k !== 'custom'
    && !hiddenLegacyKinds.includes(k)
    && (k !== 'tor' || !S.profiles.some((x) => x.kind === 'tor') || d.kind === 'tor'));
  const grid = h('div', { class: 'kind-grid', role: 'radiogroup' });
  for (const k of kinds) {
    const c = h('button', { type: 'button', class: `kind-card${d.kind === k ? ' on' : ''}`, role: 'radio', 'aria-checked': String(d.kind === k), disabled: !creating && d.kind !== k },
      h('span', { class: 'kc-ic' }, icon(k === 'antidetect' ? 'fingerprint' : k === 'phone' ? 'smartphone' : k === 'tor' ? 'tor' : k === 'private' ? 'eyeOff' : k === 'temporary' ? 'trash' : k === 'work' ? 'box' : k === 'testing' ? 'activity' : 'user', 18)),
      h('span', { class: 'kc-t' }, h('b', { text: t(`profile.kind.${k}`) }), h('span', { text: t(`profile.kindTag.${k}`) })));
    c.onclick = () => {
      if (!creating || d.kind === k) return;
      d.kind = k;
      d.browserShell = k === 'tor' ? 'octo' : 'chrome';
      d.baseChromeLook = d.browserShell === 'chrome';
      Object.assign(d, kindDefaults(k, S.init.addons.filter((a) => a.kind !== 'external-app').map((a) => a.id)));
      if (k !== 'tor' && !d.fp) void api.invoke<Fingerprint>('mgr:fingerprint-new', 'windows11').then((fp) => { if (!d.fp) { d.fp = fp; draw(); } });
      if (k === 'tor') d.fp = null;
      if (k === 'tor') d.proxy = { ...d.proxy, mode: 'none', keep: false };
      draw();
    };
    grid.append(c);
  }
  b.append(section(t('profile.kind'), grid, h('p', { class: 'hint', text: t(`profile.kindDesc.${d.kind}`) }), !creating ? h('p', { class: 'hint', text: t('ui.kindFixed') }) : null));

  // Base is the real browser engine choice. The visual shell is derived from it.
  const base = d.engine === 'firefox' ? 'firefox' : d.engine === 'electron' ? 'electron' : 'chromium';
  const baseGrid = h('div', { class: 'kind-grid browser-base-grid', role: 'radiogroup' });
  for (const choice of ['chromium', 'firefox', 'electron'] as const) {
    const selected = base === choice;
    const card = h('button', { type: 'button', class: `kind-card${selected ? ' on' : ''}`, role: 'radio', 'aria-checked': String(selected) },
      h('span', { class: 'kc-ic shell-mark' }, choice === 'chromium' ? 'Cr' : choice === 'firefox' ? 'F' : 'E'),
      h('span', { class: 'kc-t' }, h('b', { text: t(`profile.base.${choice}`) }), h('span', { class: 'kc-desc', text: t(`profile.baseDesc.${choice}`) })));
    card.onclick = () => {
      d.engine = choice === 'chromium' ? 'inkbrowser' : choice;
      d.browserShell = choice === 'chromium' ? 'chrome' : choice === 'firefox' ? 'firefox' : 'octo';
      d.baseChromeLook = choice === 'chromium';
      // Keep the complete Advanced editor visible while switching bases. The
      // manager still normalizes unsupported Electron page-shim fields before
      // native launch; only enginePrivacy is applied by native runtimes.
      if (!d.fp && d.kind !== 'tor') {
        void api.invoke<Fingerprint>('mgr:fingerprint-new', 'windows11').then((fp) => {
          if (!d.fp && d.engine === (choice === 'chromium' ? 'inkbrowser' : choice)) { d.fp = fp; draw(); }
        });
      }
      draw();
    };
    baseGrid.append(card);
  }
  b.append(section(t('profile.base'), baseGrid, h('p', { class: 'hint', text: t('profile.baseHint') })));

  // Start pages
  const pages = h('div', { class: 'pages' });
  const drawPages = () => {
    clear(pages);
    d.startPages.forEach((u, i) => {
      const x = h('button', { class: 'icon-btn tiny', title: t('common.remove'), 'aria-label': t('common.remove') }, icon('close', 14));
      x.onclick = () => { d.startPages.splice(i, 1); drawPages(); };
      pages.append(h('div', { class: 'page-row' }, icon('globe', 14), h('span', { class: 'ell grow', text: u }), x));
    });
  };
  const addUrl = input('', { placeholder: 'https://example.com', maxlength: '2048' });
  const addBtn = h('button', { class: 'btn' }, icon('plus', 14), h('span', { text: t('ui.add') }));
  const add = () => {
    let u = addUrl.value.trim();
    if (!u) return;
    if (!/^[a-z]+:\/\//i.test(u)) u = `https://${u}`;
    try { new URL(u); } catch { toast(t('ui.badUrl'), 'err'); return; }
    if (d.startPages.length < 20) d.startPages.push(u);
    addUrl.value = '';
    drawPages();
  };
  addBtn.onclick = add;
  addUrl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  drawPages();
  b.append(section(t('ui.startPages'), h('div', { class: 'row nowrap' }, addUrl, addBtn), pages, h('p', { class: 'hint', text: t('ui.startPagesHint') })));

  // Proxy
  if (d.kind === 'tor') b.append(section(t('ui.col.proxy'), h('p', { class: 'info', text: t('net.torNotHere') })));
  else b.append(section(t('ui.col.proxy'), proxyEditor(d.proxy, p, summary)));

  // Cookies
  b.append(section(t('cookies.title'), cookieEditor(d, p)));
}

function cookieEditor(d: Draft, p: Profile | null): HTMLElement {
  const status = h('div', { class: 'ck-status', 'aria-live': 'polite' });
  const ta = h('textarea', { class: 'mono ck-text', rows: '6', spellcheck: 'false', placeholder: t('cookies.ph'), 'aria-label': t('cookies.title') });
  ta.value = d.cookies;
  let timer = 0;
  const check = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      clear(status);
      status.className = 'ck-status';
      if (!d.cookies.trim()) return;
      const r = await api.invoke<{ ok: boolean; count: number; skipped: number; format: string; error?: string }>('mgr:parse-cookies', d.cookies).catch(() => null);
      if (!r) return;
      status.classList.add(r.ok ? 'ok' : 'bad');
      status.append(icon(r.ok ? 'check' : 'alert', 14), h('span', {
        text: r.ok
          ? `${t('cookies.found', { n: r.count, format: r.format === 'json' ? 'JSON' : 'Netscape' })}${r.skipped ? ` · ${t('cookies.skipped', { n: r.skipped })}` : ''} · ${t(p?.running ? 'cookies.whenNow' : 'cookies.whenStart')}`
          : r.error ?? '',
      }));
    }, 250);
  };
  ta.oninput = () => { d.cookies = ta.value; check(); };

  if (p && !d.cookies) {
    void api.invoke<{ ok: boolean; count: number; cookies: string; format: string }>('mgr:get-profile-cookies', p.id).then((r) => {
      if (r?.ok && r.cookies && !d.cookies) {
        d.cookies = r.cookies;
        ta.value = d.cookies;
        check();
      }
    }).catch(() => { /* ignore */ });
  }

  const file = h('input', { type: 'file', accept: '.json,.txt,.cookies,application/json,text/plain', class: 'hidden' }) as HTMLInputElement;
  file.onchange = async () => {
    const f = file.files?.[0];
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) { toast(t('cookies.err.tooBig'), 'err'); return; }
    d.cookies = await f.text();
    ta.value = d.cookies;
    file.value = '';
    check();
  };
  const load = h('button', { type: 'button', class: 'btn small' }, icon('file', 14), h('span', { text: t('cookies.load') }));
  load.onclick = () => file.click();

  const fmt = h('button', { type: 'button', class: 'btn small' }, icon('script', 14), h('span', { text: t('cookies.formatJson') }));
  fmt.onclick = () => {
    try {
      const parsed = JSON.parse(d.cookies);
      d.cookies = JSON.stringify(parsed, null, 2);
      ta.value = d.cookies;
      check();
    } catch {
      toast(t('cookies.err.json'), 'err');
    }
  };

  const copy = h('button', { type: 'button', class: 'btn small' }, icon('copy', 14), h('span', { text: t('cookies.copy') }));
  copy.onclick = async () => {
    if (!d.cookies.trim()) return;
    await navigator.clipboard.writeText(d.cookies);
    toast(t('cookies.copied'), 'ok');
  };

  const clr = h('button', { type: 'button', class: 'btn small' }, icon('close', 14), h('span', { text: t('cookies.clear') }));
  clr.onclick = () => { d.cookies = ''; ta.value = ''; check(); };
  check();
  return h('div', { class: 'ck-ed' },
    ta,
    h('div', { class: 'row', style: 'gap: 8px;' }, load, fmt, copy, clr, file, h('div', { class: 'grow' }), status),
    p?.pendingCookies ? h('p', { class: 'hint' }, icon('clock', 13), ` ${t('cookies.pending')}`) : null,
    h('p', { class: 'hint', text: t('cookies.hint') }));
}

// ------------------------------------------------------------------ Mass import

interface MassDraft { text: string; os: FpOs | 'random'; type: ProxyType; prefix: string }
interface MassLine { n: number; name: string; proxy: string; error?: string }
const MASS_MAX = 500;
const MASS_OSES: FpOs[] = ['windows11', 'windows10', 'macos', 'linux'];

function massLines(m: MassDraft): MassLine[] {
  const out: MassLine[] = [];
  const lines = m.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const prefix = m.prefix.trim() || t('profile.defaultName');
  lines.slice(0, MASS_MAX).forEach((line, i) => {
    const sep = line.search(/[;\t]/);
    let name = '';
    let proxy = '';
    if (sep >= 0) { name = line.slice(0, sep).trim(); proxy = line.slice(sep + 1).trim(); }
    else if (parseProxy(line, m.type).ok) proxy = line;
    else name = line;
    const l: MassLine = { n: i + 1, name: (name || `${prefix} ${i + 1}`).slice(0, 64), proxy };
    if (proxy) { const r = parseProxy(proxy, m.type); if (!r.ok) l.error = t(r.error ?? 'proxy.err.format'); }
    out.push(l);
  });
  return out;
}

function massImport(b: HTMLElement, m: MassDraft, d: Draft, changed: () => void): void {
  const preview = h('div', { class: 'mass-prev' });
  const drawPreview = () => {
    clear(preview);
    const lines = massLines(m);
    changed();
    if (!lines.length) { preview.append(h('p', { class: 'hint', text: t('mass.empty') })); return; }
    const bad = lines.filter((l) => l.error).length;
    preview.append(h('div', { class: 'mass-sum' },
      h('span', { class: 'pill ok', text: t('mass.okN', { n: lines.length - bad }) }),
      bad ? h('span', { class: 'pill bad', text: t('mass.badN', { n: bad }) }) : null,
      m.text.split(/\n/).filter((x) => x.trim()).length > MASS_MAX ? h('span', { class: 'pill warn', text: t('mass.limit', { n: MASS_MAX }) }) : null));
    const tbl = h('div', { class: 'mass-rows', role: 'list' });
    for (const l of lines.slice(0, 200)) {
      tbl.append(h('div', { class: `mass-row${l.error ? ' bad' : ''}`, role: 'listitem' },
        h('span', { class: 'mr-n', text: String(l.n) }),
        h('span', { class: 'mr-name', text: l.name }),
        h('span', { class: 'mr-proxy mono', text: l.error ?? (l.proxy ? l.proxy.replace(/(:[^:@/]*)@/, ':•••@') : t('proxy.none')) })));
    }
    preview.append(tbl);
  };
  const ta = h('textarea', { class: 'mono mass-text', rows: '8', spellcheck: 'false', placeholder: 'Sklep 1;http://user:pass@1.2.3.4:8080\nSklep 2;socks5://5.6.7.8:1080\n9.9.9.9:3128:login:haslo', 'aria-label': t('mass.tab') });
  ta.value = m.text;
  ta.oninput = () => { m.text = ta.value; drawPreview(); };
  const file = h('input', { type: 'file', accept: '.txt,.csv,text/plain', class: 'hidden' }) as HTMLInputElement;
  file.onchange = async () => { const f = file.files?.[0]; if (!f) return; m.text = (await f.text()).slice(0, 1_000_000); ta.value = m.text; file.value = ''; drawPreview(); };
  const load = h('button', { type: 'button', class: 'btn small' }, icon('file', 14), h('span', { text: t('mass.load') }));
  load.onclick = () => file.click();
  const prefix = input(m.prefix, { maxlength: '40', placeholder: t('profile.defaultName') }, (v) => { m.prefix = v; drawPreview(); });

  b.append(
    section(t('mass.title'), h('p', { class: 'hint', text: t('mass.intro') }), ta, h('div', { class: 'row' }, load, file)),
    section(t('mass.options'),
      frow(t('fp.os'), seg<FpOs | 'random'>(m.os, [...MASS_OSES.map((o) => [o, osLabel(o), o.startsWith('windows') ? 'windows' : o === 'macos' ? 'apple' : 'linux'] as [FpOs, string, string]), ['random', t('mass.osRandom'), 'shuffle']], (v) => { m.os = v; })),
      frow(t('proxy.type'), seg<ProxyType>(m.type, [['http', 'HTTP'], ['https', 'HTTPS'], ['socks4', 'SOCKS4'], ['socks5', 'SOCKS5']], (v) => { m.type = v; drawPreview(); })),
      frow(t('mass.prefix'), prefix),
      frow(t('ui.tags'), tagInput(d.tags, (v) => { d.tags = v; }, [...new Set(S.profiles.flatMap((x) => x.tags ?? []))])),
      h('p', { class: 'hint', text: t('mass.each') })),
    section(t('mass.preview'), preview));
  drawPreview();
}

async function runMassImport(m: MassDraft, d: Draft, progress: (done: number, total: number) => void): Promise<{ created: number; errors: string[] }> {
  const lines = massLines(m).filter((l) => !l.error);
  const errors: string[] = [];
  let created = 0;
  for (const [i, l] of lines.entries()) {
    progress(i, lines.length);
    try {
      const os = m.os === 'random' ? MASS_OSES[Math.floor(Math.random() * MASS_OSES.length)] : m.os;
      const fingerprint = await api.invoke<Fingerprint>('mgr:fingerprint-new', os);
      await api.invoke<Profile>('mgr:create', {
        name: l.name, kind: 'antidetect',
        patch: { fingerprint, tags: d.tags, folder: d.folder.trim() },
        proxy: l.proxy ? { mode: 'new', text: l.proxy, type: m.type, changeIpUrl: '', name: '', save: false } : { mode: 'none' },
      });
      created++;
    } catch (e) {
      errors.push(`${l.n}: ${errText(e)}`);
    }
  }
  progress(lines.length, lines.length);
  return { created, errors };
}

function proxyEditor(px: ProxyDraft, p: Profile | null, summary: () => void): HTMLElement {
  const wrap = h('div', { class: 'proxy-ed' });
  const draw = () => {
    clear(wrap);
    wrap.append(seg<ProxyMode>(px.mode, [['none', t('proxy.none'), 'close'], ['new', t('proxy.new'), 'plus'], ['saved', t('proxy.saved'), 'bookmark']], (v) => {
      px.mode = v;
      px.keep = !!p && v === origMode(p);
      if (!px.keep) px.check = undefined; else px.check = p?.proxyCheck;
      draw();
      summary();
    }, 'big'));
    if (px.mode === 'new') wrap.append(newProxy(px, p, summary));
    if (px.mode === 'saved') wrap.append(savedProxy(px, p, summary, draw));
    if (px.mode === 'none') wrap.append(h('p', { class: 'hint', text: t('proxy.noneHint') }));
    if (px.mode !== 'none') {
      const lock = toggle(px.lockdown, 'proxy.lockdown', (v) => {
        px.lockdown = v;
        px.lockdownChanged = true;
        draw();
        summary();
      });
      wrap.append(lock, h('p', { class: px.lockdown ? 'info' : 'hint warn', text: t(px.lockdown ? 'proxy.lockdownOn' : 'proxy.lockdownOff') }));
    }
  };
  draw();
  return wrap;
}

function origMode(p: Profile): ProxyMode {
  if (p.network.mode !== 'proxy') return 'none';
  return p.network.proxy?.savedId && S.proxies.some((s) => s.id === p.network.proxy!.savedId) ? 'saved' : 'new';
}

function newProxy(px: ProxyDraft, p: Profile | null, summary: () => void): HTMLElement {
  const offline = S.init.settings.offlineMode !== 'online';
  const box = h('div', { class: 'proxy-new' });
  const types = h('div', {});
  const drawTypes = () => {
    clear(types);
    types.append(seg<ProxyType>(px.type, [['http', 'HTTP'], ['https', 'HTTPS'], ['socks4', 'SOCKS4'], ['socks5', 'SOCKS5']], (v) => { px.type = v; px.keep = false; px.check = undefined; detect(); summary(); }));
  };
  drawTypes();
  const status = h('div', { class: 'proxy-status' });
  const result = h('div', { class: 'proxy-result' });
  const inp = input(px.text, { placeholder: t('proxy.inputPh'), maxlength: '1024', spellcheck: 'false', autocomplete: 'off', 'aria-label': t('proxy.input') });
  const checkBtn = h('button', { type: 'button', class: 'in-btn', title: offline ? t('settings.offlineActionBlocked') : t('proxy.check'), 'aria-label': t('proxy.check'), disabled: offline }, icon('swap', 18)) as HTMLButtonElement;
  const info = h('span', { class: 'in-btn info-ic', title: t('proxy.formats') }, icon('info', 18));
  const detect = () => {
    clear(status);
    status.className = 'proxy-status';
    if (px.keep && p) {
      status.append(h('span', { text: p.hasProxyCredentials ? t('proxy.currentWithCreds') : t('proxy.current') }));
      return;
    }
    if (!px.text.trim()) { status.append(h('span', { class: 'muted', text: t('proxy.notChecked') })); return; }
    const r = parseProxy(px.text, px.type);
    if (!r.ok || !r.proxy) {
      status.classList.add('bad');
      status.append(icon('alert', 14), h('span', { text: t(r.error ?? 'proxy.err.format') }));
      return;
    }
    const q = r.proxy;
    status.classList.add('ok');
    status.append(icon('check', 14), h('span', { text: t('proxy.detected', { type: q.type.toUpperCase(), host: `${q.host}:${q.port}`, format: r.format ?? '' }) }),
      q.username ? h('span', { class: 'pill', text: t('proxy.withLogin') }) : '');
  };
  inp.oninput = () => {
    px.text = inp.value;
    px.keep = false;
    px.check = undefined;
    clear(result);
    const r = parseProxy(px.text, px.type);
    if (r.ok && r.proxy && r.proxy.type !== px.type && /^[a-z0-9]+:\/\//i.test(px.text.trim())) { px.type = r.proxy.type; drawTypes(); }
    if (r.ok && r.proxy?.changeIpUrl && !px.changeIpUrl) { px.changeIpUrl = r.proxy.changeIpUrl; cip.value = px.changeIpUrl; }
    detect();
    summary();
  };
  inp.onpaste = () => setTimeout(() => inp.dispatchEvent(new Event('input')), 0);
  checkBtn.onclick = async () => {
    checkBtn.disabled = true;
    checkBtn.classList.add('spinning');
    clear(result);
    result.append(h('span', { class: 'muted', text: t('proxy.checking') }));
    let r: ProxyCheck | undefined;
    if (px.keep && p) r = await run(api.invoke<ProxyCheck>('mgr:proxy-check-profile', p.id));
    else {
      const input = proxyInput(px);
      if (typeof input === 'string') { clear(result); result.append(h('span', { class: 'chk bad', text: input })); checkBtn.disabled = false; checkBtn.classList.remove('spinning'); return; }
      r = await run(api.invoke<ProxyCheck>('mgr:proxy-check', input));
    }
    checkBtn.disabled = false;
    checkBtn.classList.remove('spinning');
    px.check = r;
    clear(result);
    if (r) result.append(checkCard(r));
    summary();
  };
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); checkBtn.click(); } };
  const cip = input(px.changeIpUrl, { placeholder: t('proxy.changeIpUrl'), maxlength: '2000', spellcheck: 'false' }, (v) => { px.changeIpUrl = v; px.keep = false; });
  const cipBtn = h('button', { type: 'button', class: 'in-btn', title: offline ? t('settings.offlineActionBlocked') : t('proxy.changeIpNow'), 'aria-label': t('proxy.changeIpNow'), disabled: offline }, icon('refreshCircle', 18)) as HTMLButtonElement;
  cipBtn.onclick = async () => {
    if (!/^https?:\/\//i.test(px.changeIpUrl)) { toast(t('proxy.err.changeIpUrl'), 'err'); return; }
    cipBtn.disabled = true;
    const r = await run(api.invoke<{ ok: boolean; status: number }>('mgr:proxy-change-ip', px.changeIpUrl));
    cipBtn.disabled = false;
    if (r) toast(r.ok ? t('proxy.ipChanged') : `${t('proxy.ipChangeFailed')} (HTTP ${r.status})`, r.ok ? 'ok' : 'err');
  };
  const name = input(px.name, { placeholder: t('proxy.name'), maxlength: '64' }, (v) => { px.name = v; px.keep = false; summary(); });
  if (px.check) result.append(checkCard(px.check));
  detect();
  box.append(types,
    h('div', { class: 'in-wrap' }, inp, checkBtn, info), status, result,
    h('div', { class: 'in-wrap' }, cip, cipBtn), h('span', { class: 'hint', text: t('ui.optional') }),
    h('div', { class: 'in-wrap' }, name), h('span', { class: 'hint', text: t('ui.optional') }),
    toggle(px.save, 'proxy.saveToList', (v) => { px.save = v; px.keep = false; }),
    h('details', { class: 'formats' }, h('summary', { text: t('proxy.formats') }),
      h('code', { text: 'host:port\nhost:port:user:pass\nuser:pass@host:port\nhost:port@user:pass\nuser:pass:host:port\nsocks5://user:pass@host:port\nhttp://host:port [https://change-ip-url]' })));
  return box;
}

function checkCard(c: ProxyCheck): HTMLElement {
  if (!c.ok) return h('div', { class: 'check-card bad' }, icon('alert', 16), h('span', { text: `${t('proxy.failed')}: ${errText(c.error ?? '')}` }));
  const kv = (k: string, v?: string | number) => (v === undefined || v === '' ? null : h('div', { class: 'kv' }, h('span', { class: 'muted', text: k }), h('b', { text: String(v) })));
  return h('div', { class: 'check-card ok' },
    h('div', { class: 'cc-head' }, icon('check', 16), checkLine(c)),
    h('div', { class: 'cc-grid' }, kv(t('proxy.ip'), c.ip), kv(t('proxy.country'), c.country), kv(t('proxy.city'), [c.city, c.region].filter(Boolean).join(', ')),
      kv(t('fp.timezone'), c.timezone), kv(t('proxy.latency'), c.latencyMs ? `${c.latencyMs} ms` : undefined)),
    h('p', { class: 'hint', text: t('proxy.autoHint') }));
}

function savedProxy(px: ProxyDraft, p: Profile | null, summary: () => void, redraw: () => void): HTMLElement {
  const offline = S.init.settings.offlineMode !== 'online';
  const box = h('div', { class: 'proxy-new' });
  if (!S.proxies.length) {
    box.append(h('p', { class: 'info', text: t('proxy.noSaved') }));
    return box;
  }
  if (!px.savedId) px.savedId = S.proxies[0].id;
  const sel = select<string>(px.savedId, S.proxies.map((s) => [s.id, `${s.name || proxyText(s)}${s.name ? ` — ${proxyText(s)}` : ''}${s.lastCheck?.ok ? ` · ${s.lastCheck.ip}` : ''}`] as [string, string]), (v) => {
    px.savedId = v;
    px.keep = !!p && p.network.proxy?.savedId === v;
    px.check = S.proxies.find((s) => s.id === v)?.lastCheck;
    redraw();
    summary();
  });
  const sp = S.proxies.find((s) => s.id === px.savedId) as SavedProxy;
  if (!px.check) px.check = sp?.lastCheck;
  const chk = h('button', { class: 'btn', disabled: offline, title: offline ? t('settings.offlineActionBlocked') : '' }, icon('swap', 15), h('span', { text: t('proxy.check') })) as HTMLButtonElement;
  const res = h('div', {});
  if (px.check) res.append(checkCard(px.check));
  chk.onclick = async () => {
    chk.disabled = true;
    const r = await run(api.invoke<ProxyCheck>('mgr:proxies-check', px.savedId));
    chk.disabled = false;
    if (r) { px.check = r; clear(res); res.append(checkCard(r)); summary(); }
  };
  const copy = h('button', { class: 'btn' }, icon('copy', 15), h('span', { text: t('proxy.copy') }));
  copy.onclick = () => void copyText(proxyText(sp));
  box.append(field('proxy.pickSaved', sel),
    h('div', { class: 'saved-card' },
      h('div', { class: 'kv' }, h('span', { class: 'muted', text: t('proxy.type') }), h('b', { text: sp.type.toUpperCase() })),
      h('div', { class: 'kv' }, h('span', { class: 'muted', text: t('proxy.address') }), h('b', { text: `${sp.host}:${sp.port}` })),
      h('div', { class: 'kv' }, h('span', { class: 'muted', text: t('proxy.login') }), h('b', { text: sp.hasCredentials ? t('state.on') : t('state.off') })),
      sp.changeIpUrl ? h('div', { class: 'kv' }, h('span', { class: 'muted', text: t('proxy.changeIpUrl') }), h('span', { class: 'ell', text: sp.changeIpUrl })) : null,
      h('div', { class: 'row' }, chk, copy)), res);
  return box;
}

// ------------------------------------------------------------------ Advanced (fingerprint)

type OsFamily = 'windows' | 'macos' | 'linux' | 'android' | 'ios';
interface OsVersionChoice { id: string; label: string; family: OsFamily; os?: FpOs; platformVersion?: string; mobileVersion?: string }
const OS_VERSION_CHOICES: OsVersionChoice[] = [
  { id: 'win11-24h2', label: 'Windows 11 · 24H2', family: 'windows', os: 'windows11', platformVersion: '19.0.0' },
  { id: 'win11-23h2', label: 'Windows 11 · 23H2', family: 'windows', os: 'windows11', platformVersion: '15.0.0' },
  { id: 'win11-22h2', label: 'Windows 11 · 22H2', family: 'windows', os: 'windows11', platformVersion: '15.0.0' },
  { id: 'win10-22h2', label: 'Windows 10 · 22H2', family: 'windows', os: 'windows10', platformVersion: '10.0.0' },
  { id: 'win10-21h2', label: 'Windows 10 · 21H2', family: 'windows', os: 'windows10', platformVersion: '10.0.0' },
  { id: 'win10-20h2', label: 'Windows 10 · 20H2', family: 'windows', os: 'windows10', platformVersion: '10.0.0' },
  { id: 'mac15', label: 'macOS Sequoia · 15', family: 'macos', os: 'macos', platformVersion: '15.5.0' },
  { id: 'mac14', label: 'macOS Sonoma · 14', family: 'macos', os: 'macos', platformVersion: '14.7.0' },
  { id: 'mac13', label: 'macOS Ventura · 13', family: 'macos', os: 'macos', platformVersion: '13.6.7' },
  { id: 'mac12', label: 'macOS Monterey · 12', family: 'macos', os: 'macos', platformVersion: '12.7.0' },
  { id: 'mac11', label: 'macOS Big Sur · 11', family: 'macos', os: 'macos', platformVersion: '11.7.10' },
  { id: 'ubuntu24', label: 'Ubuntu · 24.04 LTS', family: 'linux', os: 'linux', platformVersion: '6.11.0' },
  { id: 'ubuntu22', label: 'Ubuntu · 22.04 LTS', family: 'linux', os: 'linux', platformVersion: '6.8.0' },
  { id: 'debian12', label: 'Debian · 12', family: 'linux', os: 'linux', platformVersion: '6.1.0' },
  { id: 'fedora40', label: 'Fedora · 40', family: 'linux', os: 'linux', platformVersion: '6.8.0' },
  { id: 'arch', label: 'Arch Linux · current', family: 'linux', os: 'linux', platformVersion: '6.11.0' },
  ...ANDROID_VERSIONS.map((version) => ({ id: `android-${version}`, label: `Android ${version}`, family: 'android' as const, mobileVersion: version })),
  ...IOS_VERSIONS.map((version) => ({ id: `ios-${version}`, label: `iOS ${version}`, family: 'ios' as const, mobileVersion: version })),
];

function desktopFamily(os: FpOs): OsFamily {
  return os === 'windows11' || os === 'windows10' ? 'windows' : os === 'macos' ? 'macos' : 'linux';
}

function openFontSelectionModal(d: Draft, onSave: () => void): void {
  const os = d.fp?.os ?? 'windows11';
  const allFonts = fontsForOs(os);
  const selected = new Set(d.fp?.fontList ?? allFonts);
  let search = '';

  modal(t('fp.fontList'), (box) => {
    const wrap = h('div', { class: 'font-expand-modal' });
    const countLabel = h('span', { class: 'pill', text: t('fp.fontsCount', { n: selected.size }) });
    const listContainer = h('div', { class: 'font-list-scroll' });

    const drawList = () => {
      clear(listContainer);
      countLabel.textContent = t('fp.fontsCount', { n: selected.size });
      const filtered = allFonts.filter((f) => !search || f.toLowerCase().includes(search));
      for (const fontName of filtered) {
        const isChecked = selected.has(fontName);
        const chk = h('input', { type: 'checkbox', 'aria-label': fontName }) as HTMLInputElement;
        chk.checked = isChecked;
        chk.onchange = () => {
          if (chk.checked) selected.add(fontName);
          else selected.delete(fontName);
          countLabel.textContent = t('fp.fontsCount', { n: selected.size });
        };
        const label = h('label', { class: 'font-item-chk' }, chk, h('span', { text: fontName }));
        listContainer.append(label);
      }
    };

    const searchInp = input(search, { placeholder: t('fp.fontsSearch'), maxlength: '64' }, (v) => {
      search = v.trim().toLowerCase();
      drawList();
    });

    const selAllBtn = h('button', { type: 'button', class: 'btn small' }, h('span', { text: t('fp.fontsSelectAll') }));
    selAllBtn.onclick = () => {
      for (const f of allFonts) selected.add(f);
      drawList();
    };

    const deselAllBtn = h('button', { type: 'button', class: 'btn small' }, h('span', { text: t('fp.fontsDeselectAll') }));
    deselAllBtn.onclick = () => {
      selected.clear();
      drawList();
    };

    const topRow = h('div', { class: 'font-search-wrap' }, searchInp, selAllBtn, deselAllBtn, countLabel);
    drawList();

    const doneBtn = h('button', { type: 'button', class: 'btn primary' }, icon('check', 14), h('span', { text: t('fp.fontsDone') }));
    doneBtn.onclick = () => {
      if (d.fp) {
        d.fp.fontList = Array.from(selected);
        d.fp.fonts = 'custom';
      }
      closeModal();
      onSave();
    };
    const cancelBtn = h('button', { type: 'button', class: 'btn', text: t('common.cancel') });
    cancelBtn.onclick = closeModal;

    const foot = h('div', { class: 'row between', style: 'margin-top: 12px;' }, cancelBtn, doneBtn);
    wrap.append(topRow, listContainer, foot);
    box.append(wrap);
  });
}

function phoneOperatingSystem(b: HTMLElement, d: Draft, draw: () => void, summary: () => void): void {
  const active = MOBILE_DEVICES.find((x) => x.id === d.mobile.device) ?? MOBILE_DEVICES.find((x) => x.id === 'pixel-8')!;
  const os = active.os;
  const osSeg = seg<'android' | 'ios'>(os, [
    ['android', t('mobile.android'), 'smartphone'], ['ios', t('mobile.ios'), 'smartphone'],
  ], (v) => {
    d.mobile = { device: v === 'android' ? 'pixel-8' : 'iphone-15', orientation: 'portrait', osVersion: v === 'android' ? '14' : '17.5' };
    summary();
    draw();
  }, 'big');
  const device = select<string>(d.mobile.device, MOBILE_DEVICES.filter((x) => x.os === os).map((x) => [x.id, `${x.name} · ${x.width}×${x.height}`] as [string, string]), (v) => {
    d.mobile.device = v as Draft['mobile']['device'];
    summary();
  });
  const version = select<string>(d.mobile.osVersion ?? (os === 'android' ? '14' : '17.5'), (os === 'android' ? ANDROID_VERSIONS : IOS_VERSIONS).map((v) => [v, os === 'android' ? `Android ${v}` : `iOS ${v}`] as [string, string]), (v) => {
    d.mobile.osVersion = v as Draft['mobile']['osVersion'];
    summary();
  });
  const orientation = seg<'portrait' | 'landscape'>(d.mobile.orientation, [
    ['portrait', t('mobile.portrait')], ['landscape', t('mobile.landscape')],
  ], (v) => { d.mobile.orientation = v; summary(); });
  b.append(section(t('fp.os'), osSeg, field('fp.osVersion', version),
    h('p', { class: 'hint', text: t('mobile.osHint') })),
  section(t('mobile.title'),
    field('mobile.device', device),
    h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('mobile.orientation') }), orientation),
    h('p', { class: 'hint', text: t('mobile.restartHint') })));
}

function nativeEnginePrivacySection(d: Draft, draw: () => void, summary: () => void): HTMLElement {
  const base = d.engine === 'firefox' ? 'firefox' : 'chromium';
  const reset = h('button', { class: 'btn small' }, icon('refresh', 14), h('span', { text: t('enginePrivacy.reset') }));
  const webRtc = base === 'firefox'
    ? select(d.enginePrivacy.firefox.webRtc, [['default', t('enginePrivacy.webRtc.default')], ['disabled', t('enginePrivacy.webRtc.disabled')]], (v) => { d.enginePrivacy.firefox.webRtc = v as 'default' | 'disabled'; summary(); })
    : select(d.enginePrivacy.chromium.webRtc, [['default', t('enginePrivacy.webRtc.default')], ['disable-non-proxied-udp', t('enginePrivacy.webRtc.disableUdp')]], (v) => { d.enginePrivacy.chromium.webRtc = v as 'default' | 'disable-non-proxied-udp'; summary(); });
  const location = select(base === 'firefox' ? d.enginePrivacy.firefox.location : d.enginePrivacy.chromium.location, [['ask', t('enginePrivacy.location.ask')], ['block', t('enginePrivacy.location.block')]], (v) => {
    if (base === 'firefox') d.enginePrivacy.firefox.location = v as 'ask' | 'block';
    else d.enginePrivacy.chromium.location = v as 'ask' | 'block';
    summary();
  });
  const webgl = select(base === 'firefox' ? d.enginePrivacy.firefox.webgl : d.enginePrivacy.chromium.webgl, [['allow', t('enginePrivacy.webgl.allow')], ['disable', t('enginePrivacy.webgl.disable')]], (v) => {
    if (base === 'firefox') d.enginePrivacy.firefox.webgl = v as 'allow' | 'disable';
    else d.enginePrivacy.chromium.webgl = v as 'allow' | 'disable';
    summary();
  });
  reset.onclick = () => { d.enginePrivacy = structuredClone(DEFAULT_ENGINE_PRIVACY); draw(); };
  const controls: HTMLElement[] = [field('enginePrivacy.webRtc', webRtc), field('enginePrivacy.location', location), field('enginePrivacy.webgl', webgl)];
  if (base === 'firefox') controls.push(toggle(d.enginePrivacy.firefox.resistFingerprinting, 'enginePrivacy.resistFingerprinting', (v) => { d.enginePrivacy.firefox.resistFingerprinting = v; summary(); }));
  return section(t('enginePrivacy.title'), h('p', { class: 'hint', text: t(`enginePrivacy.${base}.hint`) }), h('div', { class: 'row between' }, h('span', { class: 'pill' }, base === 'firefox' ? 'Firefox / Gecko' : 'Chromium'), reset), h('div', { class: 'frows' }, ...controls), h('p', { class: 'hint native-applied-note', text: t('enginePrivacy.nativeApplied') }), h('p', { class: 'hint', text: t('enginePrivacy.limitations') }));
}

function advanced(b: HTMLElement, d: Draft, draw: () => void, summary: () => void, profile: Profile | null): void {
  if (d.kind === 'tor') { b.append(h('p', { class: 'info', text: t('edit.torFixed') })); return; }
  if (d.kind === 'phone') { phoneOperatingSystem(b, d, draw, summary); return; }
  if (!d.fp) {
    if (d.engine !== 'electron') b.append(nativeEnginePrivacySection(d, draw, summary));
    return;
  }
  const fp = d.fp;
  const ch = () => summary();
  if (d.engine !== 'electron') {
    b.append(nativeEnginePrivacySection(d, draw, summary));
    b.append(h('p', { class: 'hint' }, icon('info', 14), ' ', t('enginePrivacy.limitations')));
  }
  const nativeFingerprintStart = b.childElementCount;
  if (d.kind !== 'antidetect') {
    const off = h('button', { class: 'btn small' }, icon('close', 14), h('span', { text: t('fp.disable') }));
    off.onclick = () => { d.fp = null; draw(); };
    b.append(h('div', { class: 'note row between' }, h('span', { text: t('fp.onForKind') }), off));
  }

  // 1. OS Tabs & Sub-version Selector
  const virtual = MOBILE_DEVICES.find((x) => x.id === d.mobile.device);
  const selectedFamily = virtual?.os ?? desktopFamily(fp.os);
  const currentSubChoices = OS_VERSION_CHOICES.filter((choice) => choice.family === selectedFamily);
  const currentSubId = fp.osVersion ?? currentSubChoices[0]?.id ?? 'win11-24h2';

  const subVersionSelect = select<string>(
    currentSubChoices.some((c) => c.id === currentSubId) ? currentSubId : currentSubChoices[0]?.id ?? '',
    currentSubChoices.map((c) => [c.id, c.label] as [string, string]),
    async (choiceId) => {
      const choice = OS_VERSION_CHOICES.find((c) => c.id === choiceId);
      if (!choice) return;
      if (choice.family === 'android' || choice.family === 'ios') {
        d.mobile = {
          device: choice.family === 'android' ? 'pixel-8' : 'iphone-15', orientation: 'portrait',
          osVersion: choice.mobileVersion as Draft['mobile']['osVersion'],
        };
        const identity = mobileEmulationFor(d.mobile, fp.uaFullVersion || '140.0.0.0');
        if (identity) fp.userAgent = identity.userAgent;
        draw();
        return;
      }
      d.mobile = { device: 'none', orientation: 'portrait' };
      const n = await run(api.invoke<Fingerprint>('mgr:fingerprint-new', choice.os!));
      if (!n) return;
      const major = Number(n.uaFullVersion.split('.')[0]) || 140;
      d.fp = {
        ...n, platformVersion: choice.platformVersion ?? n.platformVersion, osVersion: choice.id,
        userAgent: chromiumUserAgent(n.os, major),
        timezone: fp.timezone, language: fp.language, geolocation: fp.geolocation, webrtc: fp.webrtc, ports: fp.ports,
        doNotTrack: fp.doNotTrack, canvas: fp.canvas, webgl: fp.webgl, audio: fp.audio, clientRects: fp.clientRects, fonts: fp.fonts, fontList: fp.fontList, webgpu: fp.webgpu,
        battery: fp.battery, speechVoices: fp.speechVoices, deviceName: fp.deviceName, macAddress: fp.macAddress,
        seed: fp.seed, seedMode: fp.seedMode,
      };
      draw();
    },
  );

  const osFamilySeg = seg<OsFamily>(selectedFamily, [
    ['windows', t('fp.os.windows'), 'windows'],
    ['macos', t('fp.os.macos'), 'apple'],
    ['android', t('mobile.android'), 'smartphone'],
    ['ios', t('mobile.ios'), 'smartphone'],
    ['linux', t('fp.os.linux'), 'box'],
  ], async (family) => {
    if (family === 'android' || family === 'ios') {
      d.mobile = {
        device: family === 'android' ? 'pixel-8' : 'iphone-15', orientation: 'portrait',
        osVersion: family === 'android' ? '14' : '17.5',
      };
      const identity = mobileEmulationFor(d.mobile, fp.uaFullVersion || '140.0.0.0');
      if (identity) fp.userAgent = identity.userAgent;
      draw();
      return;
    }
    d.mobile = { device: 'none', orientation: 'portrait' };
    const targetOs: FpOs = family === 'macos' ? 'macos' : family === 'linux' ? 'linux' : 'windows11';
    const n = await run(api.invoke<Fingerprint>('mgr:fingerprint-new', targetOs));
    if (!n) return;
    const major = Number(n.uaFullVersion.split('.')[0]) || 140;
    d.fp = {
      ...n,
      userAgent: chromiumUserAgent(n.os, major),
      timezone: fp.timezone, language: fp.language, geolocation: fp.geolocation, webrtc: fp.webrtc, ports: fp.ports,
      doNotTrack: fp.doNotTrack, canvas: fp.canvas, webgl: fp.webgl, audio: fp.audio, clientRects: fp.clientRects, fonts: fp.fonts, fontList: fontsForOs(n.os), webgpu: fp.webgpu,
      seed: fp.seed, seedMode: fp.seedMode,
    };
    draw();
  });

  const osPickerWrap = h('div', { class: 'fp-os-picker-wrap' }, osFamilySeg, subVersionSelect);
  const hw = h('div', { class: 'frows' });
  hw.append(frowWithInfo(t('fp.os'), t('fp.info.os'), osPickerWrap));

  // 2. Browser / Chrome Version selector (Dedicated category row)
  const ua = h('textarea', { class: 'ua', rows: '3', maxlength: '512', spellcheck: 'false', 'aria-label': t('fp.userAgent') });
  ua.value = fp.userAgent;
  ua.oninput = () => { fp.userAgent = ua.value.trim(); ch(); };

  const uaMajorVersion = String(Number(fp.uaFullVersion.split('.')[0]) || 140);
  const isFirefox = d.browserShell === 'firefox';
  const isSafari = d.browserShell === 'safari';

  const versionChoices: Array<[string, string]> = [
    ['all', t('fp.allVersions')],
    ...(isFirefox
      ? FIREFOX_VERSIONS_LIST.map((v) => [v, `Firefox ${v}`] as [string, string])
      : isSafari
        ? SAFARI_VERSIONS_LIST.map((v) => [v.split('.')[0], `Safari ${v}`] as [string, string])
        : CHROME_VERSIONS_LIST.map((v) => [v, `Chrome ${v}`] as [string, string])),
  ];

  const currentVerKey = versionChoices.some(([k]) => k === uaMajorVersion) ? uaMajorVersion : 'all';
  const uaVersionSelect = select<string>(currentVerKey, versionChoices, (selectedVer) => {
    const major = selectedVer === 'all' ? (Number(fp.uaFullVersion.split('.')[0]) || 140) : Number(selectedVer);
    fp.browserVersion = String(major);
    fp.uaFullVersion = `${major}.0.${6800 + Math.floor(Math.random() * 900)}.${Math.floor(Math.random() * 200)}`;
    fp.userAgent = mobileEmulationFor(d.mobile, fp.uaFullVersion)?.userAgent ?? chromiumUserAgent(fp.os, major);
    ua.value = fp.userAgent;
    ch();
  });

  const uaNew = h('button', { type: 'button', class: 'in-btn', title: t('fp.newUa'), 'aria-label': t('fp.newUa') }, icon('refreshCircle', 18));
  uaNew.onclick = async () => {
    const os = fp.os;
    const currentEngine = await meta(os);
    if (!currentEngine || d.fp !== fp || fp.os !== os) return;
    const fullVersion = currentEngine.engine.full || fp.uaFullVersion;
    const major = currentEngine.engine.major || Number(fullVersion.split('.')[0]) || 140;
    fp.userAgent = mobileEmulationFor(d.mobile, fullVersion)?.userAgent ?? chromiumUserAgent(fp.os, major);
    fp.uaFullVersion = fullVersion;
    fp.browserVersion = String(major);
    ua.value = fp.userAgent;
    ch();
    toast(t('fp.uaReset'), 'ok');
  };

  const uaRow = h('div', { class: 'row nowrap', style: 'width: 100%; max-width: 560px; gap: 8px;' }, uaVersionSelect, uaNew);
  hw.append(frowWithInfo(t('fp.browserVersion'), t('fp.info.userAgent') || t('fp.uaHint'), uaRow));

  // 3. User-Agent String (Dedicated category row)
  hw.append(frowWithInfo(t('fp.userAgent'), t('fp.uaHint'), ua));

  // 4. Language & Interface Language
  const langVal = select<string>(LANGS.includes(fp.language.value) ? fp.language.value : LANGS[0], LANGS.map((l) => [l, l] as [string, string]), (v) => { fp.language.value = v; ch(); });
  langVal.classList.toggle('hidden', fp.language.mode !== 'manual' && fp.language.mode !== 'lang-match');
  hw.append(frowWithInfo(t('fp.language'), t('fp.info.language'),
    seg(fp.language.mode === 'auto' || fp.language.mode === 'ip-match' ? 'ip-match' : fp.language.mode === 'lang-match' ? 'lang-match' : fp.language.mode === 'real' ? 'real' : 'manual', [
      ['ip-match', t('fp.v.ipMatch')],
      ['lang-match', t('fp.v.langMatch')],
      ['real', t('fp.v.real')],
      ['manual', t('fp.v.custom')],
    ], (v) => {
      fp.language.mode = v as Draft['fp'] extends { language: { mode: infer M } } ? M : never;
      langVal.classList.toggle('hidden', v !== 'manual' && v !== 'lang-match');
      ch();
    }),
    langVal));

  // 4. Time Zone
  const tzs = timezones();
  const tz = select<string>(tzs.includes(fp.timezone.value) ? fp.timezone.value : (tzs[0] ?? 'UTC'), (tzs.includes(fp.timezone.value) ? tzs : [fp.timezone.value, ...tzs]).filter(Boolean).map((z) => [z, z] as [string, string]), (v) => { fp.timezone.value = v; ch(); });
  tz.classList.toggle('hidden', fp.timezone.mode !== 'manual');
  hw.append(frowWithInfo(t('fp.timezone'), t('fp.info.timezone'),
    seg(fp.timezone.mode === 'auto' || fp.timezone.mode === 'ip-match' ? 'ip-match' : fp.timezone.mode === 'real' ? 'real' : 'manual', [
      ['ip-match', t('fp.v.ipMatch')],
      ['real', t('fp.v.real')],
      ['manual', t('fp.v.custom')],
    ], (v) => {
      fp.timezone.mode = v as Draft['fp'] extends { timezone: { mode: infer M } } ? M : never;
      tz.classList.toggle('hidden', v !== 'manual');
      ch();
    }),
    tz));

  // 5. Geolocation
  const geoRow = h('div', { class: 'grid3' },
    field('fp.lat', input(String(fp.geolocation.latitude), { inputmode: 'decimal', maxlength: '12' }, (v) => { fp.geolocation.latitude = Number(v) || 0; ch(); })),
    field('fp.lon', input(String(fp.geolocation.longitude), { inputmode: 'decimal', maxlength: '12' }, (v) => { fp.geolocation.longitude = Number(v) || 0; ch(); })),
    field('fp.accuracy', input(String(fp.geolocation.accuracy), { inputmode: 'numeric', maxlength: '6' }, (v) => { fp.geolocation.accuracy = Number(v) || 10; ch(); })));
  geoRow.classList.toggle('hidden', fp.geolocation.mode !== 'manual');
  hw.append(frowWithInfo(t('fp.geolocation'), t('fp.info.geolocation'),
    seg(fp.geolocation.mode === 'auto' || fp.geolocation.mode === 'ip-match' ? 'ip-match' : fp.geolocation.mode === 'block' || fp.geolocation.mode === 'disable' ? 'disable' : fp.geolocation.mode === 'ask' ? 'ask' : 'manual', [
      ['ip-match', t('fp.v.ipMatch')],
      ['ask', t('fp.v.ask')],
      ['disable', t('fp.v.disable')],
      ['manual', t('fp.v.custom')],
    ], (v) => {
      fp.geolocation.mode = v as Draft['fp'] extends { geolocation: { mode: infer M } } ? M : never;
      geoRow.classList.toggle('hidden', v !== 'manual');
      ch();
    }),
    geoRow,
    ...(fp.migrationWarnings?.includes('fp.warn.geoPermissionMigrated') ? [h('p', { class: 'hint warning', text: t('fp.warn.geoPermissionMigrated') })] : [])));

  // 6. Screen Resolution & Window Size
  const screens = SCREENS[fp.os === 'macos' ? 'mac' : 'desktop'];
  const curScr = `${fp.screen.width}x${fp.screen.height}`;
  const scr = select<string>(curScr, (screens.includes(curScr) ? screens : [curScr, ...screens]).map((s) => [s, s.replace('x', ' × ')] as [string, string]), (v) => { const [w, hh] = v.split('x').map(Number); fp.screen.width = w; fp.screen.height = hh; ch(); });
  scr.classList.toggle('hidden', fp.screen.mode === 'real');
  hw.append(frowWithInfo(t('fp.screen'), t('fp.info.screen'),
    seg(fp.screen.mode === 'random' ? 'random' : fp.screen.mode === 'real' ? 'real' : 'custom', [
      ['custom', t('fp.v.custom')],
      ['real', t('fp.v.real')],
      ['random', t('fp.v.random')],
    ], (v) => {
      fp.screen.mode = v as Draft['fp'] extends { screen: { mode: infer M } } ? M : never;
      if (v === 'random') {
        const pool = screens;
        const picked = pool[Math.floor(Math.random() * pool.length)];
        const [w, hh] = picked.split('x').map(Number);
        fp.screen.width = w; fp.screen.height = hh;
        scr.value = picked;
      }
      scr.classList.toggle('hidden', v === 'real');
      ch();
    }),
    scr));

  const winSizeRow = h('div', { class: 'grid2' },
    field('ui.width', input(String(fp.windowSize?.width || fp.screen.width), { inputmode: 'numeric', maxlength: '5' }, (v) => {
      if (!fp.windowSize) fp.windowSize = { mode: 'custom', width: fp.screen.width, height: fp.screen.height };
      fp.windowSize.width = Math.max(640, Number(v) || 1280); ch();
    })),
    field('ui.height', input(String(fp.windowSize?.height || fp.screen.height), { inputmode: 'numeric', maxlength: '5' }, (v) => {
      if (!fp.windowSize) fp.windowSize = { mode: 'custom', width: fp.screen.width, height: fp.screen.height };
      fp.windowSize.height = Math.max(480, Number(v) || 720); ch();
    })));
  winSizeRow.classList.toggle('hidden', fp.windowSize?.mode !== 'custom');
  hw.append(frowWithInfo(t('fp.windowSize'), t('fp.info.windowSize'),
    seg(fp.windowSize?.mode === 'custom' ? 'custom' : 'default', [
      ['default', t('fp.v.default')],
      ['custom', t('fp.v.custom')],
    ], (v) => {
      if (!fp.windowSize) fp.windowSize = { mode: v, width: fp.screen.width, height: fp.screen.height };
      fp.windowSize.mode = v;
      winSizeRow.classList.toggle('hidden', v !== 'custom');
      ch();
    }),
    winSizeRow));

  // 7. Font List
  const fontCountDisplay = h('span', { class: 'pill', text: t('fp.fontsCount', { n: fp.fontList?.length ?? fontsForOs(fp.os).length }) });
  const randomizeFontsBtn = h('button', { type: 'button', class: 'btn small' }, icon('shuffle', 14), h('span', { text: t('fp.fontsRandomize') }));
  randomizeFontsBtn.onclick = () => {
    const all = fontsForOs(fp.os);
    fp.fontList = all.filter(() => Math.random() > 0.2);
    fp.fonts = 'custom';
    fontCountDisplay.textContent = t('fp.fontsCount', { n: fp.fontList.length });
    ch();
    renderSignalsCard();
    toast(t('fp.fontsCount', { n: fp.fontList.length }), 'ok');
  };
  const editFontsBtn = h('button', { type: 'button', class: 'btn small' }, icon('edit', 14), h('span', { text: t('fp.fontsEdit') }));
  editFontsBtn.onclick = () => openFontSelectionModal(d, () => {
    fontCountDisplay.textContent = t('fp.fontsCount', { n: fp.fontList?.length ?? 0 });
    ch();
    renderSignalsCard();
  });
  const expandFontsBtn = h('button', { type: 'button', class: 'btn small' }, icon('chevronDown', 14), h('span', { text: t('fp.fontsExpand') }));
  expandFontsBtn.onclick = () => openFontSelectionModal(d, () => {
    fontCountDisplay.textContent = t('fp.fontsCount', { n: fp.fontList?.length ?? 0 });
    ch();
    renderSignalsCard();
  });

  const fontControlsRow = h('div', { class: 'fp-font-row' }, fontCountDisplay, randomizeFontsBtn, editFontsBtn, expandFontsBtn);
  fontControlsRow.classList.toggle('hidden', fp.fonts === 'real');
  hw.append(frowWithInfo(t('fp.fontList'), t('fp.info.fonts'),
    seg(fp.fonts === 'real' ? 'real' : 'custom', [
      ['custom', t('fp.v.custom')],
      ['real', t('fp.v.real')],
    ], (v) => {
      fp.fonts = v;
      fontControlsRow.classList.toggle('hidden', v === 'real');
      ch();
      renderSignalsCard();
    }),
    fontControlsRow));

  // 8. WebRTC
  const rtcIp = input(fp.webrtc.publicIp, { placeholder: t('fp.webrtcIpPh'), maxlength: '45' }, (v) => { fp.webrtc.publicIp = v.trim(); ch(); });
  rtcIp.classList.toggle('hidden', fp.webrtc.mode !== 'manual');
  hw.append(frowWithInfo(t('fp.webrtc'), t('fp.info.webrtc'),
    seg(fp.webrtc.mode === 'altered' || fp.webrtc.mode === 'substitute' ? 'substitute' : fp.webrtc.mode === 'disable-udp' || fp.webrtc.mode === 'forward' ? 'forward' : fp.webrtc.mode === 'off' || fp.webrtc.mode === 'disable' ? 'disable' : 'real', [
      ['substitute', t('fp.v.substitute')],
      ['forward', t('fp.v.forward')],
      ['manual', t('fp.v.manual')],
      ['real', t('fp.v.real')],
      ['disable', t('fp.v.disable')],
    ], (v) => {
      fp.webrtc.mode = (v === 'substitute' ? 'altered' : v === 'forward' ? 'disable-udp' : v === 'disable' ? 'off' : v === 'manual' ? 'manual' : 'real');
      rtcIp.classList.toggle('hidden', v !== 'manual');
      ch();
    }),
    rtcIp));

  // 9. Canvas, ClientRects, AudioContext, WebGL Image
  hw.append(frowWithInfo(t('fp.canvas'), t('fp.info.canvas'), seg(fp.canvas === 'off' ? 'off' : fp.canvas === 'real' ? 'real' : 'noise', [['noise', t('fp.v.noise')], ['real', t('fp.v.real')], ['off', t('fp.v.off')]], (v) => { fp.canvas = v; ch(); renderSignalsCard(); })));
  hw.append(frowWithInfo(t('fp.clientRects'), t('fp.info.clientRects'), seg(fp.clientRects, [['noise', t('fp.v.noise')], ['real', t('fp.v.real')]], (v) => { fp.clientRects = v; ch(); renderSignalsCard(); })));
  hw.append(frowWithInfo(t('fp.audio'), t('fp.info.audio'), seg(fp.audio, [['noise', t('fp.v.noise')], ['real', t('fp.v.real')]], (v) => { fp.audio = v; ch(); renderSignalsCard(); })));
  hw.append(frowWithInfo(t('fp.webgl'), t('fp.info.webgl'), seg(fp.webgl === 'off' ? 'off' : fp.webgl === 'real' ? 'real' : 'noise', [['noise', t('fp.v.noise')], ['real', t('fp.v.real')], ['off', t('fp.v.off')]], (v) => { fp.webgl = v; ch(); renderSignalsCard(); })));

  // 10. WebGL Metadata
  const gpuBox = h('div', { class: 'gpu' });
  const drawGpu = async () => {
    clear(gpuBox);
    if (fp.webglInfo.mode === 'real') return;
    const m = await meta(fp.os);
    const gpus = m?.gpus ?? [];
    const vendors = [...new Set(gpus.map((g) => g.vendor))];
    if (fp.webglInfo.vendor && !vendors.includes(fp.webglInfo.vendor)) vendors.unshift(fp.webglInfo.vendor);
    const renderers = gpus.filter((g) => g.vendor === fp.webglInfo.vendor).map((g) => g.renderer);
    if (fp.webglInfo.renderer && !renderers.includes(fp.webglInfo.renderer)) renderers.unshift(fp.webglInfo.renderer);
    const vSel = select<string>(fp.webglInfo.vendor, vendors.map((v) => [v, v] as [string, string]), (v) => {
      fp.webglInfo.vendor = v;
      fp.webglInfo.renderer = gpus.find((g) => g.vendor === v)?.renderer ?? '';
      void drawGpu(); ch(); renderSignalsCard();
    });
    const rSel = select<string>(fp.webglInfo.renderer, renderers.map((r) => [r, r] as [string, string]), (v) => { fp.webglInfo.renderer = v; ch(); renderSignalsCard(); });
    const rnd = h('button', { type: 'button', class: 'btn', title: t('fp.randomGpu') }, icon('shuffle', 15), h('span', { text: t('fp.randomGpu') }));
    rnd.onclick = () => {
      if (!gpus.length) return;
      const g = gpus[Math.floor(Math.random() * gpus.length)];
      fp.webglInfo.vendor = g.vendor;
      fp.webglInfo.renderer = g.renderer;
      void drawGpu(); ch(); renderSignalsCard();
    };
    gpuBox.append(field('fp.gpuVendor', vSel), field('fp.gpuRenderer', rSel), h('div', { class: 'row' }, rnd));
  };
  void drawGpu();
  hw.append(frowWithInfo(t('fp.webglInfo'), t('fp.info.webglInfo'),
    seg(fp.webglInfo.mode === 'real' ? 'real' : 'custom', [
      ['custom', t('fp.v.custom')],
      ['real', t('fp.v.real')],
    ], (v) => {
      fp.webglInfo.mode = v;
      void drawGpu();
      ch();
      renderSignalsCard();
    }),
    gpuBox));

  // 11. WebGPU
  hw.append(frowWithInfo(t('fp.webgpu'), t('fp.info.webgpu'),
    seg(fp.webgpu === 'off' || fp.webgpu === 'disable' ? 'disable' : fp.webgpu === 'webgl-based' ? 'webgl-based' : 'real', [
      ['webgl-based', t('fp.v.webglBased')],
      ['real', t('fp.v.real')],
      ['disable', t('fp.v.disable')],
    ], (v) => {
      fp.webgpu = v;
      ch();
      renderSignalsCard();
    })));

  // 12. SpeechVoices
  hw.append(frowWithInfo(t('fp.speechVoices'), t('fp.info.speechVoices'),
    seg(fp.speechVoices ?? 'noise', [
      ['noise', t('fp.v.noise')],
      ['real', t('fp.v.real')],
    ], (v) => {
      fp.speechVoices = v;
      ch();
    })));

  // 13. Media Devices
  const num = (key: 'audioInputs' | 'audioOutputs' | 'videoInputs', label: string) => field(label, input(String(fp.mediaDevices[key]), { inputmode: 'numeric', maxlength: '1' }, (v) => { fp.mediaDevices[key] = Math.min(9, Math.max(0, Number(v) || 0)); ch(); }));
  const media = h('div', { class: 'grid3' }, num('audioInputs', 'fp.mics'), num('audioOutputs', 'fp.speakers'), num('videoInputs', 'fp.cameras'));
  media.classList.toggle('hidden', fp.mediaDevices.mode === 'real');
  hw.append(frowWithInfo(t('fp.media'), t('fp.info.media'),
    seg(fp.mediaDevices.mode === 'real' ? 'real' : 'noise', [
      ['noise', t('fp.v.noise')],
      ['real', t('fp.v.real')],
    ], (v) => {
      fp.mediaDevices.mode = v as Draft['fp'] extends { mediaDevices: { mode: infer M } } ? M : never;
      media.classList.toggle('hidden', v === 'real');
      ch();
    }),
    media));

  // 14. Hardware Concurrency & Memory
  const cpu = select<string>(String(fp.cpu.cores), CORES.map((c) => [String(c), t('fp.coresN', { n: c })] as [string, string]), (v) => { fp.cpu.cores = Number(v); ch(); });
  cpu.classList.toggle('hidden', fp.cpu.mode === 'real');
  hw.append(frowWithInfo(t('fp.cpu'), t('fp.info.cpu'),
    seg(fp.cpu.mode === 'real' ? 'real' : 'custom', [
      ['custom', t('fp.v.custom')],
      ['real', t('fp.v.real')],
    ], (v) => {
      fp.cpu.mode = v;
      cpu.classList.toggle('hidden', v === 'real');
      ch();
    }),
    cpu));

  const mem = select<string>(String(fp.memory.gb), MEMORY.map((m) => [String(m), `${m} GB`] as [string, string]), (v) => { fp.memory.gb = Number(v); ch(); });
  mem.classList.toggle('hidden', fp.memory.mode === 'real');
  hw.append(frowWithInfo(t('fp.memory'), t('fp.info.memory'),
    seg(fp.memory.mode === 'real' ? 'real' : 'custom', [
      ['custom', t('fp.v.custom')],
      ['real', t('fp.v.real')],
    ], (v) => {
      fp.memory.mode = v;
      mem.classList.toggle('hidden', v === 'real');
      ch();
    }),
    mem,
    h('p', { class: 'hint', text: t('fp.memoryHint') })));

  // 15. Device Name
  const devNameInp = input(fp.deviceName?.value || randomDeviceName(fp.os), { maxlength: '64' }, (v) => {
    if (!fp.deviceName) fp.deviceName = { mode: 'custom', value: v };
    fp.deviceName.value = v.trim(); ch();
  });
  devNameInp.classList.toggle('hidden', fp.deviceName?.mode === 'real');
  hw.append(frowWithInfo(t('fp.deviceName'), t('fp.info.deviceName'),
    seg(fp.deviceName?.mode === 'real' ? 'real' : 'custom', [
      ['custom', t('fp.v.custom')],
      ['real', t('fp.v.real')],
    ], (v) => {
      if (!fp.deviceName) fp.deviceName = { mode: v, value: randomDeviceName(fp.os) };
      fp.deviceName.mode = v;
      devNameInp.classList.toggle('hidden', v === 'real');
      ch();
    }),
    devNameInp));

  // 16. MAC Address
  const macInp = input(fp.macAddress?.value || randomMacAddr(), { maxlength: '20' }, (v) => {
    if (!fp.macAddress) fp.macAddress = { mode: 'custom', value: v };
    fp.macAddress.value = v.trim().toUpperCase(); ch();
  });
  const randMacBtn = h('button', { type: 'button', class: 'btn small' }, icon('shuffle', 14), h('span', { text: t('fp.randomMac') }));
  randMacBtn.onclick = () => {
    const nextMac = randomMacAddr();
    if (!fp.macAddress) fp.macAddress = { mode: 'custom', value: nextMac };
    fp.macAddress.value = nextMac;
    macInp.value = nextMac;
    ch();
  };
  const macRow = h('div', { class: 'row nowrap', style: 'width: 100%; max-width: 560px; gap: 8px;' }, macInp, randMacBtn);
  macRow.classList.toggle('hidden', fp.macAddress?.mode === 'real');
  hw.append(frowWithInfo(t('fp.macAddress'), t('fp.info.macAddress'),
    seg(fp.macAddress?.mode === 'real' ? 'real' : 'custom', [
      ['custom', t('fp.v.custom')],
      ['real', t('fp.v.real')],
    ], (v) => {
      if (!fp.macAddress) fp.macAddress = { mode: v, value: randomMacAddr() };
      fp.macAddress.mode = v;
      macRow.classList.toggle('hidden', v === 'real');
      ch();
    }),
    macRow));

  // 17. Do Not Track
  hw.append(frowWithInfo(t('fp.dnt'), t('fp.info.dnt'),
    seg(fp.doNotTrack === true || fp.doNotTrack === 'enable' ? 'enable' : fp.doNotTrack === 'close' ? 'close' : 'default', [
      ['default', t('fp.v.default')],
      ['enable', t('fp.v.enable')],
      ['close', t('fp.v.close')],
    ], (v) => {
      fp.doNotTrack = v === 'enable' ? true : v === 'close' ? false : 'default';
      ch();
    })));

  // 18. Battery
  hw.append(frowWithInfo(t('fp.battery'), t('fp.info.battery'),
    seg(fp.battery ?? 'noise', [
      ['noise', t('fp.v.noise')],
      ['real', t('fp.v.real')],
    ], (v) => {
      fp.battery = v;
      ch();
    })));

  // 19. PortScan Protection
  const ports = input(fp.ports.list, { maxlength: '400', placeholder: '3389,5900,5938,6039' }, (v) => { fp.ports.list = v; ch(); });
  ports.classList.toggle('hidden', fp.ports.mode === 'close' || fp.ports.mode === 'real');
  hw.append(frowWithInfo(t('fp.ports'), t('fp.info.ports'),
    seg(fp.ports.mode === 'close' || fp.ports.mode === 'real' ? 'close' : 'enable', [
      ['enable', t('fp.v.enable')],
      ['close', t('fp.v.close')],
    ], (v) => {
      fp.ports.mode = v === 'enable' ? 'protect' : 'close';
      ports.classList.toggle('hidden', v === 'close');
      ch();
    }),
    ports,
    h('p', { class: 'hint', text: t('fp.portsHint') })));

  // 20. Hardware Acceleration
  hw.append(frowWithInfo(t('fp.hwAccel'), t('fp.info.hwAccel'),
    seg(fp.hardwareAcceleration ?? 'default', [
      ['default', t('fp.v.default')],
      ['enable', t('fp.v.enable')],
      ['close', t('fp.v.close')],
    ], (v) => {
      fp.hardwareAcceleration = v;
      ch();
    })));

  // 21. Custom deterministic noise seed
  const seedInp = input(fp.seed || '', { maxlength: '64', placeholder: 'e.g. a1b2c3d4e5f60718', spellcheck: 'false', 'aria-label': t('fp.customSeed') }, (v) => {
    const clean = v.trim().toLowerCase().replace(/[^0-9a-f]/g, '');
    if (clean) fp.seed = clean;
    renderSignalsCard();
    ch();
  });
  const rndSeedBtn = h('button', { type: 'button', class: 'btn', title: t('fp.randomSeed'), 'aria-label': t('fp.randomSeed') }, icon('shuffle', 14), h('span', { text: t('fp.randomSeed') }));
  rndSeedBtn.onclick = () => {
    const chars = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
    fp.seed = s;
    seedInp.value = s;
    renderSignalsCard();
    ch();
  };
  const seedRow = h('div', { class: 'row nowrap', style: 'width: 100%; max-width: 560px; gap: 8px;' }, seedInp, rndSeedBtn);
  hw.append(frowWithInfo(t('fp.customSeed'), t('fp.info.customSeed'), seedRow, h('p', { class: 'hint', text: t('fp.customSeedHint') })));

  // Local Fingerprint Signals Card
  const computeConfigPreview = () => ({
    seedPreview: fp.seed ? fp.seed.slice(0, 16).toUpperCase() : t('fp.signals.seedNotSet'),
    canvasMode: `Applied on launch: ${t(`fp.v.${fp.canvas}`)}`,
    webglMode: `Applied on launch: ${t(`fp.v.${fp.webgl}`)}`,
    audioMode: `Applied on launch: ${t(`fp.v.${fp.audio}`)}`,
    clientRectsMode: `Applied on launch: ${t(`fp.v.${fp.clientRects}`)}`,
    webgpuPolicy: `Applied on launch: ${fp.webgpu}`,
    fontMode: t(fp.fonts === 'real' ? 'fp.v.real' : 'fp.v.custom'),
  });

  const signalsHost = h('div', { class: 'fp-signals-container' });

  const renderSignalsCard = () => {
    clear(signalsHost);
    const sigs = computeConfigPreview();

    const randomizeAllSignals = () => {
      const chars = '0123456789abcdef';
      let s = '';
      for (let i = 0; i < 16; i++) s += chars[Math.floor(Math.random() * chars.length)];
      fp.seed = s;
      seedInp.value = s;
      ch();
      renderSignalsCard();
      toast(t('fp.signals.randomize') + ': OK', 'ok');
    };

    const randomizeBtn = h('button', { type: 'button', class: 'btn small', title: t('fp.signals.randomize'), 'aria-label': t('fp.signals.randomize') },
      icon('shuffle', 14), h('span', { text: t('fp.signals.randomize') }));
    randomizeBtn.onclick = (e) => { e.preventDefault(); randomizeAllSignals(); };

    const reloadBtn = h('button', { type: 'button', class: 'btn small icon-only', title: t('fp.signals.reload'), 'aria-label': t('fp.signals.reload') },
      icon('refreshCircle', 15));
    reloadBtn.onclick = (e) => { e.preventDefault(); renderSignalsCard(); };

    const head = h('div', { class: 'fp-signals-head row between' },
      h('div', { class: 'row nowrap', style: 'align-items: center; gap: 8px;' },
        icon('fingerprint', 16),
        h('strong', { text: t('fp.signals.title') })),
      h('div', { class: 'row nowrap', style: 'gap: 6px;' }, reloadBtn, randomizeBtn));

    const item = (label: string, val: string, isMono = true, isBadge = false) =>
      h('div', { class: 'fp-signal-item' },
        h('span', { class: 'fp-signal-lbl', text: label }),
        h('span', { class: `fp-signal-val${isMono ? ' mono' : ''}${isBadge ? ' fp-badge-supported' : ''}`, text: val }));

    const grid = h('div', { class: 'fp-signals-grid' },
      item(t('fp.signals.seedPreview'), sigs.seedPreview),
      item(t('fp.signals.canvasMode'), sigs.canvasMode, false),
      item(t('fp.signals.webglMode'), sigs.webglMode, false),
      item(t('fp.signals.audioMode'), sigs.audioMode, false),
      item(t('fp.signals.clientRectsMode'), sigs.clientRectsMode, false),
      item(t('fp.signals.webgpuApi'), sigs.webgpuPolicy, false),
      item(t('fp.signals.fontMode'), sigs.fontMode, false));

    const persistenceSeg = seg<'persistent' | 'per-run'>(fp.seedMode ?? 'persistent', [
      ['persistent', t('fp.signals.staySame')],
      ['per-run', t('fp.signals.changeRun')],
    ], (v) => {
      fp.seedMode = v;
      ch();
    });

    const persistenceRow = h('div', { class: 'fp-signals-run-mode' },
      h('div', { class: 'field' },
        h('span', { class: 'lbl', text: t('fp.signals.persistence') }),
        persistenceSeg),
      h('p', { class: 'hint', text: t('fp.signals.persistenceHint') }));

    signalsHost.append(head, h('p', { class: 'hint', text: t('fp.signals.previewHint') }), grid, persistenceRow);
  };

  renderSignalsCard();

  const profileSupportsTests = !!profile && profile.kind !== 'tor' && profile.protection.level !== 'tor' && profile.sandbox.mode !== 'windows-sandbox';
  const savedFingerprint = profileSupportsTests && JSON.stringify(d.fp) === JSON.stringify(profile.fingerprint)
    && JSON.stringify(d.mobile) === JSON.stringify(profile.mobile);
  const selectedProfileAction = (action: 'audit' | 'browsercheck' | 'browserleaks' | 'creepjs' | 'pixelscan') => {
    if (!profileSupportsTests) { toast(t(profile ? 'fp.audit.unsupportedProfile' : 'fp.audit.saveBeforeTest'), 'info'); return; }
    if (!savedFingerprint) { toast(t('fp.audit.unsavedChanges'), 'info'); return; }
    if (action === 'audit') runProfileFingerprintAudit(profile);
    else openProfileFingerprintTest(profile, action);
  };
  const btnAudit = h('button', { type: 'button', class: 'btn primary', disabled: !profileSupportsTests },
    icon('fingerprint', 14), h('span', { text: t('fp.audit.run') }));
  btnAudit.onclick = () => selectedProfileAction('audit');
  const btnBrowserCheck = h('button', { type: 'button', class: 'btn', disabled: !profileSupportsTests },
    h('span', { text: t('fp.verify.browsercheck') }));
  btnBrowserCheck.onclick = () => selectedProfileAction('browsercheck');
  const btnBrowserleaks = h('button', { type: 'button', class: 'btn', disabled: !profileSupportsTests },
    h('span', { text: t('fp.verify.browserleaks') }));
  btnBrowserleaks.onclick = () => selectedProfileAction('browserleaks');
  const btnCreepjs = h('button', { type: 'button', class: 'btn', disabled: !profileSupportsTests },
    h('span', { text: t('fp.verify.creepjs') }));
  btnCreepjs.onclick = () => selectedProfileAction('creepjs');
  const btnPixelscan = h('button', { type: 'button', class: 'btn', disabled: !profileSupportsTests },
    h('span', { text: t('fp.verify.pixelscan') }));
  btnPixelscan.onclick = () => selectedProfileAction('pixelscan');

  const verifySection = section(t('fp.verify.title'),
    h('p', { class: 'hint', text: t('fp.verify.hint') }),
    h('div', { class: 'fp-verify-actions row nowrap wrap', style: 'gap: 8px; margin-top: 10px;' },
      btnAudit, btnBrowserCheck, btnBrowserleaks, btnCreepjs, btnPixelscan));

  b.append(section(t('fp.params'), hw), signalsHost, verifySection);
  if (d.engine !== 'electron') {
    const draft = h('div', { class: 'native-fingerprint-draft', role: 'note', 'aria-label': t('enginePrivacy.nativeDraft') });
    while (b.childElementCount > nativeFingerprintStart) draft.append(b.children[nativeFingerprintStart]);
    draft.prepend(h('div', { class: 'native-draft-banner' }, icon('info', 14), h('span', { text: t('enginePrivacy.nativeDraft') })));
    b.append(draft);
  }
}

// ------------------------------------------------------------------ Browser settings

function privacySwitch(checked: boolean, label: string, onChange: (value: boolean) => void): HTMLElement {
  const inp = h('input', { type: 'checkbox', 'aria-label': label }) as HTMLInputElement;
  inp.checked = checked;
  const state = h('span', { class: 'sw-state', text: t(checked ? 'state.on' : 'state.off') });
  inp.onchange = () => {
    onChange(inp.checked);
    state.textContent = t(inp.checked ? 'state.on' : 'state.off');
  };
  return h('label', { class: 'toggle privacy-switch' }, inp, h('span', { class: 'sw' }), state);
}

function accordionSection(title: string, infoText: string, content: HTMLElement, defaultOpen = false): HTMLElement {
  const item = h('div', { class: 'accordion-item' });
  const body = h('div', { class: `accordion-body${defaultOpen ? '' : ' hidden'}` }, content);
  const infoBtn = h('button', {
    type: 'button', class: 'frow-info-trigger', title: t('ui.info') || 'Information', 'aria-label': `${title} info`,
  }, icon('info', 13));
  const card = h('div', { class: 'frow-info-card hidden' }, h('p', { text: infoText }));
  infoBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const wasHidden = card.classList.contains('hidden');
    card.classList.toggle('hidden', !wasHidden);
    infoBtn.classList.toggle('active', wasHidden);
  };
  const chevron = icon(defaultOpen ? 'chevronUp' : 'chevronDown', 16);
  const head = h('button', { type: 'button', class: 'accordion-head' },
    h('div', { class: 'accordion-title' }, icon('gear', 15), h('span', { text: title }), infoBtn),
    chevron);
  head.onclick = (e) => {
    if ((e.target as HTMLElement).closest('.frow-info-trigger')) return;
    const isHidden = body.classList.contains('hidden');
    body.classList.toggle('hidden', !isHidden);
    clear(chevron);
    chevron.append(icon(isHidden ? 'chevronUp' : 'chevronDown', 16));
  };
  item.append(head, card, body);
  return item;
}

function mediaCaptureEditor(d: Draft): HTMLElement {
  const camera = h('select', { 'aria-label': t('media.activeCamera') }) as HTMLSelectElement;
  const microphone = h('select', { 'aria-label': t('media.activeMicrophone') }) as HTMLSelectElement;
  const preview = h('video', { class: 'profile-media-preview', autoplay: '', muted: '', playsinline: '' }) as HTMLVideoElement;
  preview.muted = true;
  const monitor = h('audio', { autoplay: '' }) as HTMLAudioElement;
  monitor.muted = true;
  const meter = h('span', { class: 'media-level-fill' });
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let listen!: HTMLButtonElement;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    stream?.getTracks().forEach((track) => track.stop());
    void context?.close();
    stream = undefined; context = undefined; preview.srcObject = null; monitor.srcObject = null; monitor.muted = true; meter.style.width = '0%';
    listen.disabled = true; listen.textContent = t('media.listenMicrophone');
  };
  const fill = (control: HTMLSelectElement, devices: MediaDeviceInfo[], saved: string, fallback: string) => {
    control.replaceChildren(new Option(fallback, ''));
    for (const device of devices) control.append(new Option(device.label, device.label));
    control.value = devices.some((device) => device.label === saved) ? saved : '';
  };
  fill(camera, [], d.mediaCapture.cameraLabel, t('media.systemDefault'));
  fill(microphone, [], d.mediaCapture.microphoneLabel, t('media.systemDefault'));
  camera.onchange = () => { d.mediaCapture.cameraLabel = camera.value; stop(); };
  microphone.onchange = () => { d.mediaCapture.microphoneLabel = microphone.value; stop(); };
  const detect = h('button', { class: 'btn small', text: t('media.detectNow') }) as HTMLButtonElement;
  detect.onclick = async () => {
    stop(); detect.disabled = true;
    try {
      const probes = await Promise.allSettled([
        navigator.mediaDevices.getUserMedia({ video: true, audio: false }),
        navigator.mediaDevices.getUserMedia({ video: false, audio: true }),
      ]);
      for (const probe of probes) if (probe.status === 'fulfilled') probe.value.getTracks().forEach((track) => track.stop());
      if (probes.every((probe) => probe.status === 'rejected')) throw new Error('media permission denied');
      const devices = await navigator.mediaDevices.enumerateDevices();
      fill(camera, devices.filter((item) => item.kind === 'videoinput' && item.label), d.mediaCapture.cameraLabel, t('media.systemDefault'));
      fill(microphone, devices.filter((item) => item.kind === 'audioinput' && item.label), d.mediaCapture.microphoneLabel, t('media.systemDefault'));
    } catch { toast(t('media.permissionFailed'), 'err'); }
    finally { detect.disabled = false; }
  };
  listen = h('button', { class: 'btn small', text: t('media.listenMicrophone'), disabled: true }) as HTMLButtonElement;
  listen.onclick = () => {
    if (!stream?.getAudioTracks().length) return;
    monitor.muted = !monitor.muted;
    listen.textContent = t(monitor.muted ? 'media.listenMicrophone' : 'media.stopListening');
    if (!monitor.muted) void monitor.play();
  };
  const test = h('button', { class: 'btn small', text: t('media.previewSelected') }) as HTMLButtonElement;
  test.onclick = async () => {
    stop();
    const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    const cam = devices.find((item) => item.kind === 'videoinput' && item.label === camera.value);
    const mic = devices.find((item) => item.kind === 'audioinput' && item.label === microphone.value);
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: d.sandbox.camera ? (cam ? { deviceId: { exact: cam.deviceId } } : true) : false,
        audio: d.sandbox.microphone ? (mic ? { deviceId: { exact: mic.deviceId } } : true) : false,
      });
      preview.srcObject = stream;
      monitor.srcObject = stream;
      listen.disabled = !stream.getAudioTracks().length;
      if (stream.getAudioTracks().length) {
        context = new AudioContext();
        const analyser = context.createAnalyser();
        context.createMediaStreamSource(stream).connect(analyser);
        const levels = new Uint8Array(analyser.frequencyBinCount);
        const draw = () => { if (!stream) return; analyser.getByteFrequencyData(levels); meter.style.width = `${Math.min(100, levels.reduce((a, x) => a + x, 0) / Math.max(1, levels.length) * 1.8)}%`; frame = requestAnimationFrame(draw); };
        draw();
      }
      window.setTimeout(stop, 20_000);
    } catch { toast(t('media.permissionFailed'), 'err'); }
  };
  return h('div', { class: 'profile-media-picker' },
    h('div', { class: 'grid2' }, field('media.activeCamera', camera), field('media.activeMicrophone', microphone)),
    h('div', { class: 'row' }, detect, test, listen), preview, monitor,
    h('div', { class: 'media-level', title: t('media.microphoneLevel') }, meter),
    h('p', { class: 'hint', text: t('media.routingHint') }));
}

function browser(b: HTMLElement, d: Draft, draw: () => void, summary: () => void): void {
  if (d.kind === 'tor') {
    b.append(h('p', { class: 'info', text: t('edit.torFixed') }));
    return;
  }

  // Protection level
  const levels: Array<[Level, string]> = [['normal', t('level.normal')], ['standard', t('level.standard')], ['strict', t('level.strict')]];
  b.append(section(t('privacy.level'),
    seg<Level>(d.protection.level, levels, (v) => { d.protection = { level: v, overrides: {} }; draw(); }, 'big'),
    h('p', { class: 'hint', text: t(`level.${d.protection.level}.desc`) })));

  const grid = h('div', { class: 'ov-grid' });
  const ov = d.protection.overrides;
  const preset = presetFor(d.protection.level);
  const list = d.fp ? OVERRIDES : [...OVERRIDES, ...ENGINE_OVERRIDES];
  for (const o of list) {
    const cur = ov[o.key];
    const presetVal = preset[o.key as keyof typeof preset];
    if (o.type === 'bool') {
      const enabled = typeof cur === 'boolean' ? cur : Boolean(presetVal);
      const ctl = privacySwitch(enabled, t(`ov.${o.key}`), (v) => {
        if (v === Boolean(presetVal)) delete ov[o.key];
        else ov[o.key] = v;
        summary();
      });
      grid.append(h('span', { class: 'ov-label', text: t(`ov.${o.key}`) }), ctl);
      continue;
    }
    const ctl = select<string>(cur === undefined ? 'preset' : String(cur), [
      ['preset', `${t('edit.preset')}${presetVal ? ` (${t(`${o.key === 'hardwareApis' ? 'hardware' : o.key}.${presetVal}`)})` : ''}`],
      ...o.values!.map((x) => [x, t(`${o.key === 'hardwareApis' ? 'hardware' : o.key}.${x}`)] as [string, string]),
    ], (v) => { if (v === 'preset') delete ov[o.key]; else ov[o.key] = v; summary(); });
    grid.append(h('span', { class: 'ov-label', text: t(`ov.${o.key}`) }), ctl);
  }
  b.append(section(t('edit.overrides'), h('p', { class: 'hint', text: t('edit.overridesHint') }), grid));

  // Advanced Settings Accordion
  const acc = h('div', { class: 'ed-accordion' });

  // Accordion 1: Default Startup Pages
  const spPages = h('div', { class: 'pages' });
  const drawSpPages = () => {
    clear(spPages);
    d.startPages.forEach((u, i) => {
      const x = h('button', { class: 'icon-btn tiny', title: t('common.remove'), 'aria-label': t('common.remove') }, icon('close', 14));
      x.onclick = () => { d.startPages.splice(i, 1); drawSpPages(); };
      spPages.append(h('div', { class: 'page-row' }, icon('globe', 14), h('span', { class: 'ell grow', text: u }), x));
    });
  };
  const spAddUrl = input('', { placeholder: 'https://example.com', maxlength: '2048' });
  const spAddBtn = h('button', { class: 'btn' }, icon('plus', 14), h('span', { text: t('ui.add') }));
  const addSp = () => {
    let u = spAddUrl.value.trim();
    if (!u) return;
    if (!/^[a-z]+:\/\//i.test(u)) u = `https://${u}`;
    try { new URL(u); } catch { toast(t('ui.badUrl'), 'err'); return; }
    if (d.startPages.length < 20) d.startPages.push(u);
    spAddUrl.value = '';
    drawSpPages();
  };
  spAddBtn.onclick = addSp;
  spAddUrl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addSp(); } };
  drawSpPages();
  acc.append(accordionSection(t('fp.adv.startupPages'), t('fp.info.advStartupPages'), h('div', {}, h('div', { class: 'row nowrap' }, spAddUrl, spAddBtn), spPages)));

  // Accordion 2: Restore Last Session
  acc.append(accordionSection(t('fp.adv.restoreSession'), t('fp.info.advRestoreSession'),
    h('div', { class: 'toggles' },
      toggle(d.restoreSession, 'profile.restoreSession', (v) => { d.restoreSession = v; }))));

  // Accordion 3: Data Sync
  acc.append(accordionSection(t('fp.adv.dataSync'), t('fp.info.advDataSync'),
    h('div', { class: 'toggles' },
      toggle(true, 'fp.adv.dataSync', () => {}))));

  // Accordion 4: Clear Local Cache
  acc.append(accordionSection(t('fp.adv.clearCache'), t('fp.info.advClearCache'),
    h('div', { class: 'toggles' },
      toggle(d.deleteOnClose || d.kind === 'temporary', 'profile.deleteOnClose', (v) => { d.deleteOnClose = v; summary(); }, d.kind === 'temporary'))));

  // Accordion 5: Browser Settings (Passwords, History, Search, Theme)
  const home = input(d.homePage, { maxlength: '2048', placeholder: d.browserShell === 'chrome' ? GOOGLE_HOME : 'octo://newtab' }, (v) => { d.homePage = v; });
  const identityChoices: Array<[string, string] | [string, string, boolean]> = d.engine === 'firefox'
    ? [['firefox', t('identity.firefox')], ['firefox-esr', t('identity.firefoxEsr')]]
    : [['chrome', t('identity.chrome')], ['chromium', t('identity.chromium')], ['edge', t('identity.edge')],
      ['brave', t('identity.brave')], ['opera', t('identity.opera')], ['vivaldi', t('identity.vivaldi')],
      ['samsung-internet', t('identity.samsung'), true], ['safari', t('identity.safari'), true]];
  const identitySelect = select(d.fp?.browserIdentity ?? (d.engine === 'firefox' ? 'firefox' : 'chrome'), identityChoices,
    (value) => { if (d.fp) d.fp.browserIdentity = value; });
  const identityHint = h('p', { class: 'hint', text: t('identity.chromiumOnlyHint') });

  const searchEngineSelect = select(d.searchEngine || '', [
    ['', t('search.engineDefault')],
    ...(S.init?.searchEngines ?? []).map((id) => [id, t(`settings.search.${id}`)] as [string, string]),
  ], (v) => { d.searchEngine = v; });
  const theme = seg<'dark' | 'light'>(d.theme, [['dark', t('profile.theme.dark'), 'moon'], ['light', t('profile.theme.light'), 'star']], (v) => { d.theme = v; summary(); });
  const runtimeEntries = () => S.init.chromiumRuntimes ?? [];
  const runtimeChoices = runtimeEntries().map((r) => [r.entry.version, `${r.entry.version} · ${r.entry.channel}${r.entry.support === 'retired' ? ' · retired' : ''}${r.installed ? ' · installed' : ' · not installed'}`] as [string, string]);
  const runtimeSelect = select(d.chromiumRuntime ?? runtimeEntries().find((r) => r.entry.default && r.entry.support === 'supported')?.entry.version ?? '', runtimeChoices, (v) => { d.chromiumRuntime = v; summary(); });
  const installRuntime = h('button', { type: 'button', class: 'in-btn', text: 'Install' });
  const removeRuntime = h('button', { type: 'button', class: 'in-btn danger', text: 'Remove' });
  installRuntime.onclick = async () => {
    const version = (runtimeSelect as unknown as { value: string }).value;
    const result = await run(api.invoke<unknown>('mgr:chromium-install', version));
    if (result) { S.init.chromiumRuntimes = await api.invoke('mgr:chromium-catalog'); toast(`Chromium ${version} installed`, 'ok'); }
  };
  removeRuntime.onclick = async () => {
    const version = (runtimeSelect as unknown as { value: string }).value;
    const result = await run(api.invoke<boolean>('mgr:chromium-remove', version));
    if (result) { S.init.chromiumRuntimes = await api.invoke('mgr:chromium-catalog'); toast(`Chromium ${version} removed`, 'ok'); }
  };
  acc.append(accordionSection(t('fp.adv.browserSettings'), t('fp.info.advBrowserSettings'),
    h('div', { class: 'frows' },
      field('profile.homePage', home, 'profile.homePageHint'),
      field('profile.searchEngine', searchEngineSelect, 'profile.searchEngineHint'),
      ...(d.engine === 'inkbrowser' ? [field('browserEngine.chromiumVersion', h('div', { class: 'row nowrap', style: 'gap: 8px; flex-wrap: wrap;' }, runtimeSelect, installRuntime, removeRuntime), 'browserEngine.chromiumVersionHint')] : []),
      h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('profile.theme') }), theme),
      h('div', { class: 'toggles' },
        toggle(d.appMode, 'profile.appMode', (v) => { d.appMode = v; summary(); }),
        toggle(d.smartPaste, 'profile.smartPaste', (v) => { d.smartPaste = v; summary(); }),
        toggle(d.keepHistory, 'profile.keepHistory', (v) => { d.keepHistory = v; summary(); }),
        toggle(d.savePasswords, 'profile.savePasswords', (v) => { d.savePasswords = v; summary(); })),
      h('p', { class: 'hint', text: t('profile.appModeHint') }),
      h('p', { class: 'hint', text: t('profile.smartPasteHint') })),
    true));

  // Accordion 6: Multi-open Mode
  acc.append(accordionSection(t('fp.adv.multiOpen'), t('fp.info.advMultiOpen'),
    h('div', { class: 'toggles' },
      toggle(true, 'fp.adv.multiOpen', () => {}))));

  // Accordion 7: Remote Inspector
  acc.append(accordionSection(t('fp.adv.remoteInspector'), t('fp.info.advRemoteInspector'),
    h('div', { class: 'toggles' },
      toggle(false, 'fp.adv.remoteInspector', () => {}))));

  // Accordion 8: Bookmark Settings
  acc.append(accordionSection(t('fp.adv.bookmarks'), t('fp.info.advBookmarks'),
    h('div', { class: 'toggles' },
      toggle(true, 'fp.adv.bookmarks', () => {}))));

  // Accordion 9: Website Access Restriction
  const accessModes = seg<'allow-all' | 'block-list' | 'allow-list'>('allow-all', [
    ['allow-all', t('fp.adv.accessAllowAll')],
    ['block-list', t('fp.adv.accessBlockList')],
    ['allow-list', t('fp.adv.accessAllowList')],
  ], () => {});
  acc.append(accordionSection(t('fp.adv.websiteAccess'), t('fp.info.advWebsiteAccess'), accessModes));

  // Accordion 10: Extension Settings
  const set = new Set(d.addons);
  const addonList = h('div', { class: 'addons' });
  for (const a of S.init.addons) {
    const tg = toggle(set.has(a.id), 'addons.enabled', (v) => { if (v) set.add(a.id); else set.delete(a.id); d.addons = [...set]; }, a.kind === 'external-app');
    addonList.append(h('div', { class: 'addon' }, h('div', { class: 'row between' }, h('b', { text: a.name }), tg), h('div', { class: 'small muted', text: L(a.description) })));
  }
  acc.append(accordionSection(t('fp.adv.extensions'), t('fp.info.advExtensions'), addonList));

  // Accordion 11: Video Stream Spoofing / Camera Options
  const videoSpoofToggle = toggle(d.fp?.videoSpoofing !== 'disable', 'fp.videoSpoofing', (v) => {
    if (d.fp) d.fp.videoSpoofing = v ? 'enable' : 'disable';
    summary();
  });
  acc.append(accordionSection(t('fp.adv.videoOptions'), t('fp.info.videoSpoofing'),
    h('div', { class: 'frows' },
      videoSpoofToggle,
      mediaCaptureEditor(d))));

  b.append(section(t('fp.adv.title'), acc));

  // DNS
  const tpl = input(d.dns.dohTemplate || '', { maxlength: '512', placeholder: 'https://dns.quad9.net/dns-query' }, (v) => { d.dns.dohTemplate = v.trim(); });
  tpl.classList.toggle('hidden', d.dns.mode !== 'doh');
  b.append(section(t('dns.label'), seg(d.dns.mode, [['inherit', t('dns.inherit')], ['system', t('dns.system')], ['doh', t('dns.doh')]], (v) => { d.dns.mode = v; tpl.classList.toggle('hidden', v !== 'doh'); }), tpl, h('p', { class: 'hint', text: t('net.vpnNote') })));

  // Isolation & Sandbox
  const sb = d.sandbox;
  const isoModeHint = h('p', { class: 'hint', text: sb.mode === 'isolated-vm' ? t('iso.mode.isolatedVmDesc') : (S.init.windowsSandbox ? t('sandbox.hint') : t('sandbox.hintNoWsb')) });
  const isoModeSelect = select(sb.mode, [
    ['none', t('iso.mode.none')],
    ['restricted', t('iso.mode.restricted')],
    ['windows-sandbox', `${t('iso.mode.windows-sandbox')} (${t('sandbox.testVersion')})`],
    ['isolated-vm', t('iso.mode.isolated-vm')],
  ], (v) => {
    sb.mode = v;
    isoModeHint.textContent = v === 'isolated-vm' ? t('iso.mode.isolatedVmDesc') : (S.init.windowsSandbox ? t('sandbox.hint') : t('sandbox.hintNoWsb'));
    summary();
  });
  b.append(section(t('edit.tab.sandbox'),
    field('iso.mode', isoModeSelect),
    isoModeHint,
    field('iso.clipboard', select(sb.clipboard, [['allow', t('iso.clipboard.allow')], ['write-only', t('iso.clipboard.write-only')], ['block', t('iso.clipboard.block')]], (v) => { sb.clipboard = v; })),
    h('div', { class: 'toggles' },
      toggle(sb.camera, 'sandbox.camera', (v) => { sb.camera = v; }),
      toggle(sb.microphone, 'sandbox.microphone', (v) => { sb.microphone = v; }),
      toggle(sb.externalDevices, 'sandbox.devices', (v) => { sb.externalDevices = v; }),
      toggle(sb.shareDownloads, 'sandbox.shareDownloads', (v) => { sb.shareDownloads = v; })),
    h('p', { class: 'hint', text: t('sandbox.appContainerNote') })));
}

// ------------------------------------------------------------------ phone emulation

function mobile(b: HTMLElement, d: Draft, summary: () => void): void {
  const selected = MOBILE_DEVICES.find((x) => x.id === d.mobile.device) ?? MOBILE_DEVICES.find((x) => x.id === 'pixel-8')!;
  const os = selected.os;
  const syncIdentity = () => {
    if (!d.fp) return;
    const identity = mobileEmulationFor(d.mobile, d.fp.uaFullVersion || '140.0.0.0');
    if (identity) d.fp.userAgent = identity.userAgent;
  };
  const device = select<string>(d.mobile.device, MOBILE_DEVICES.filter((x) => x.os === os).map((x) => [x.id, `${x.name} · ${x.width}×${x.height}`] as [string, string]), (v) => {
    d.mobile.device = v as Draft['mobile']['device'];
    syncIdentity();
    summary();
    render();
  });
  const orientation = seg<'portrait' | 'landscape'>(d.mobile.orientation, [
    ['portrait', t('mobile.portrait')], ['landscape', t('mobile.landscape')],
  ], (v) => { d.mobile.orientation = v; syncIdentity(); summary(); render(); });
  const details = h('p', { class: 'hint' });
  const render = () => {
    const current = MOBILE_DEVICES.find((x) => x.id === d.mobile.device) ?? selected;
    details.textContent = t('mobile.details', { name: current.name, os: current.os === 'ios' ? 'iOS' : 'Android', width: d.mobile.orientation === 'landscape' ? current.height : current.width, height: d.mobile.orientation === 'landscape' ? current.width : current.height, scale: current.scaleFactor });
  };
  render();
  b.append(section(t('mobile.title'),
    h('p', { class: 'hint', text: t('mobile.intro') }),
    field('mobile.device', device),
    h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('mobile.orientation') }), orientation),
    details,
    h('p', { class: 'hint', text: t('mobile.restartHint') })));
}

function notes(b: HTMLElement, d: Draft): void {
  const ta = h('textarea', { class: 'notes', maxlength: '5000', placeholder: t('ui.notesPh'), 'aria-label': t('ui.tab.notes') });
  ta.value = d.notes;
  ta.oninput = () => { d.notes = ta.value; };
  b.append(section(t('ui.tab.notes'), ta, h('p', { class: 'hint', text: t('ui.notesHint') })));
}

// ------------------------------------------------------------------ summary

function summaryPanel(d: Draft, renew: () => Promise<void>, creating: boolean): HTMLElement {
  const box = h('div', { class: 'sum' });
  const row = (k: string, v: string, cls = '') => box.append(h('div', { class: `sum-kv ${cls}` }, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v, title: v })));
  const head = h('div', { class: 'sum-head' }, h('b', { text: t('ui.summary') }));
  if (d.fp || d.kind === 'antidetect') {
    const nf = h('button', { class: 'btn outline small upper' }, icon('shuffle', 14), h('span', { text: t('fp.newFingerprint') }));
    nf.onclick = () => void renew();
    head.append(nf);
  }
  box.append(head);
  row(t('profile.name'), d.name.trim() || (creating ? t('ui.namePhAuto') : ''));
  row(t('profile.kind'), t(`profile.kind.${d.kind}`));
  row(t('profile.base'), t(`profile.base.${d.engine === 'firefox' ? 'firefox' : d.engine === 'electron' ? 'electron' : 'chromium'}`));
  row(t('profile.browserShell'), t(`profile.browserShell.${d.browserShell}`));
  const phone = MOBILE_DEVICES.find((x) => x.id === d.mobile.device);
  row(t('mobile.title'), phone ? `${phone.name} · ${d.mobile.orientation === 'landscape' ? t('mobile.landscape') : t('mobile.portrait')}` : t('mobile.desktop'));
  const px = d.proxy;
  const proxyLabel = px.mode === 'none' ? t('proxy.none') : px.mode === 'saved' ? (S.proxies.find((s) => s.id === px.savedId)?.name || proxyText(S.proxies.find((s) => s.id === px.savedId) ?? { type: '', host: '—', port: 0 })) : (() => {
    const r = parseProxy(px.text, px.type);
    return r.ok && r.proxy ? `${r.proxy.type}://${r.proxy.host}:${r.proxy.port}` : px.text ? t('proxy.invalid') : '—';
  })();
  row(t('ui.col.proxy'), proxyLabel);
  if (px.check?.ok) row(t('proxy.ip'), `${px.check.ip ?? ''}${px.check.countryCode ? ` (${px.check.countryCode.toUpperCase()})` : ''}`);
  const fp = d.fp;
  if (fp) {
    const c = px.check?.ok ? px.check : undefined;
    const auto = (mode: string, value: string, fromIp?: string) => (mode === 'auto' || mode === 'ip-match' ? `${t('fp.v.autoIp')}${fromIp ? ` · ${fromIp}` : ''}` : mode === 'real' ? t('fp.v.real') : value);
    box.append(h('div', { class: 'sum-sep' }));
    row(t('fp.os'), osLabel(fp.os));
    row(t('fp.userAgent'), fp.userAgent, 'ua');
    row(t('fp.webrtc'), t(`fp.v.${fp.webrtc.mode === 'disable-udp' ? 'disableUdp' : fp.webrtc.mode}`) + (fp.webrtc.mode === 'manual' && fp.webrtc.publicIp ? ` · ${fp.webrtc.publicIp}` : ''));
    row(t('fp.canvas'), t(`fp.v.${fp.canvas}`));
    row(t('fp.webgl'), t(`fp.v.${fp.webgl}`));
    row(t('fp.webglInfo'), fp.webglInfo.mode === 'manual' || fp.webglInfo.mode === 'custom' ? fp.webglInfo.renderer.replace(/^ANGLE \(([^,]+), (.+?)( \(0x[0-9A-F]+\))? Direct3D.*$/, '$2').replace(/^ANGLE \(Apple, ANGLE Metal Renderer: (.+?),.*$/, '$1') : t('fp.v.real'));
    row(t('fp.webgpu'), t(`fp.v.${fp.webgpu}`));
    row(t('fp.clientRects'), t(`fp.v.${fp.clientRects}`));
    row(t('fp.timezone'), auto(fp.timezone.mode, fp.timezone.value, c?.timezone));
    row(t('fp.language'), auto(fp.language.mode, fp.language.value));
    row(t('fp.geolocation'), fp.geolocation.mode === 'block' || fp.geolocation.mode === 'disable' ? t('fp.v.block') : fp.geolocation.mode === 'auto' || fp.geolocation.mode === 'ip-match' ? auto('auto', '', c?.city) : `${fp.geolocation.latitude}, ${fp.geolocation.longitude}`);
    row(t('fp.cpu'), fp.cpu.mode === 'manual' || fp.cpu.mode === 'custom' ? t('fp.coresN', { n: fp.cpu.cores }) : t('fp.v.real'));
    row(t('fp.memory'), fp.memory.mode === 'manual' || fp.memory.mode === 'custom' ? `${fp.memory.gb} GB` : t('fp.v.real'));
    row(t('fp.screen'), fp.screen.mode === 'manual' || fp.screen.mode === 'custom' || fp.screen.mode === 'random' ? `${fp.screen.width} × ${fp.screen.height}` : t('fp.v.real'));
    row(t('fp.fonts'), t(`fp.v.${fp.fonts}`));
    row(t('fp.audio'), t(`fp.v.${fp.audio}`));
    row(t('fp.media'), fp.mediaDevices.mode === 'manual' || fp.mediaDevices.mode === 'custom' || fp.mediaDevices.mode === 'noise' ? `${fp.mediaDevices.audioInputs} / ${fp.mediaDevices.audioOutputs} / ${fp.mediaDevices.videoInputs}` : t('fp.v.real'));
    row(t('fp.ports'), fp.ports.mode === 'protect' || fp.ports.mode === 'enable' ? t('fp.v.protect') : t('fp.v.real'));
    row(t('fp.dnt'), t(fp.doNotTrack === true || fp.doNotTrack === 'enable' ? 'state.on' : 'state.off'));
  } else if (d.kind !== 'tor') {
    box.append(h('div', { class: 'sum-sep' }));
    row(t('ui.fingerprint'), t('fp.offShort'));
  }
  box.append(h('div', { class: 'sum-sep' }));
  row(t('privacy.level'), t(`level.${d.protection.level}`));
  row(t('iso.mode'), t(`iso.mode.${d.sandbox.mode}`));
  row(t('profile.appMode'), t(d.appMode ? 'state.on' : 'state.off'));
  row(t('profile.smartPaste'), t(d.smartPaste ? 'state.on' : 'state.off'));
  row(t('profile.keepHistory'), t(d.keepHistory ? 'state.on' : 'state.off'));
  row(t('profile.deleteOnClose'), t(d.deleteOnClose || d.kind === 'temporary' ? 'state.on' : 'state.off'));
  if (d.kind !== 'tor') row(t('vstudio.webLaunch.title'), t(d.vstudioWebOnLaunch ? 'state.on' : 'state.off'));
  box.append(h('p', { class: 'hint', text: d.kind === 'antidetect' ? t('fp.summaryHint') : t('profile.stableHint') }));
  return box;
}
