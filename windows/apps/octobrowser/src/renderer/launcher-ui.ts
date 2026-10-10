/**
 * apps/octobrowser/src/renderer/launcher-ui.ts
 *
 * Shared state, types and small UI building blocks of the launcher
 * (modal, toasts, segmented buttons, popup menus, tag input...).
 */
import { clear } from '@octo/shell/renderer/bridge';
import { h, t, getLang, Dicts } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';

// ------------------------------------------------------------------ types

export type Kind = 'antidetect' | 'phone' | 'personal' | 'work' | 'private' | 'testing' | 'temporary' | 'tor' | 'custom';
export type Level = 'normal' | 'standard' | 'strict' | 'tor';
export type FpOs = 'windows11' | 'windows10' | 'macos' | 'linux';
export type ProxyType = 'http' | 'https' | 'socks4' | 'socks5';
export type MobileDeviceId = 'none' | 'iphone-15' | 'iphone-se' | 'ipad-air' | 'pixel-8' | 'galaxy-s24';

export interface Fingerprint {
  enabled: boolean;
  browserIdentity?: string;
  os: FpOs;
  userAgent: string;
  uaFullVersion: string;
  platformVersion: string;
  osVersion?: string;
  browserVersion?: string;
  webrtc: { mode: 'off' | 'real' | 'disable-udp' | 'altered' | 'manual' | 'substitute' | 'forward' | 'disable'; publicIp: string };
  canvas: 'off' | 'real' | 'noise';
  webgl: 'off' | 'real' | 'noise';
  webglInfo: { mode: 'real' | 'manual' | 'custom'; vendor: string; renderer: string };
  webgpu: 'off' | 'real' | 'webgl-based' | 'disable';
  clientRects: 'real' | 'noise';
  timezone: { mode: 'auto' | 'manual' | 'real' | 'ip-match'; value: string };
  language: { mode: 'auto' | 'manual' | 'real' | 'ip-match' | 'lang-match'; value: string };
  geolocation: { mode: 'auto' | 'manual' | 'block' | 'ask' | 'allow' | 'disable' | 'ip-match'; latitude: number; longitude: number; accuracy: number };
  cpu: { mode: 'real' | 'manual' | 'custom'; cores: number };
  memory: { mode: 'real' | 'manual' | 'custom'; gb: number };
  screen: { mode: 'real' | 'manual' | 'custom' | 'random'; width: number; height: number };
  windowSize?: { mode: 'default' | 'custom'; width: number; height: number };
  fonts: 'real' | 'noise' | 'custom';
  fontList?: string[];
  audio: 'real' | 'noise';
  speechVoices?: 'real' | 'noise';
  mediaDevices: { mode: 'real' | 'manual' | 'custom' | 'noise'; audioInputs: number; audioOutputs: number; videoInputs: number };
  ports: { mode: 'real' | 'protect' | 'enable' | 'close'; list: string };
  doNotTrack: boolean | 'default' | 'enable' | 'close';
  battery?: 'real' | 'noise';
  deviceName?: { mode: 'real' | 'custom'; value: string };
  macAddress?: { mode: 'real' | 'custom'; value: string };
  hardwareAcceleration?: 'default' | 'enable' | 'close';
  videoSpoofing?: 'enable' | 'disable';
  seed: string; migrationWarnings?: string[];
  seedMode?: 'persistent' | 'per-run';
}
export interface ProxyCheck { ok: boolean; at: string; ip?: string; country?: string; countryCode?: string; region?: string; city?: string; timezone?: string; latitude?: number; longitude?: number; latencyMs?: number; error?: string }
export interface ProfileProxy { type: ProxyType; host: string; port: number; changeIpUrl: string; name: string; savedId: string }
export interface Profile {
  /** Browser engine: 'electron' (default when missing) or 'inkbrowser'. */
  engine?: string; chromiumRuntime?: string;
  id: string; name: string; kind: Kind; color: string; createdAt: string; updatedAt: string; trashedAt?: string;
  protection: { level: Level; overrides?: Record<string, unknown> };
  network: { mode: 'system' | 'direct' | 'proxy'; proxyRules?: string; proxyBypass?: string; hasProxyCredentials?: boolean; lockdown?: boolean; proxy?: ProfileProxy };
  dns: { mode: 'inherit' | 'system' | 'doh'; dohTemplate: string };
  sandbox: { mode: 'none' | 'restricted' | 'windows-sandbox' | 'isolated-vm'; clipboard: 'allow' | 'write-only' | 'block'; camera: boolean; microphone: boolean; externalDevices: boolean; shareDownloads: boolean };
  audio: { muted: boolean; volume: number; outputDeviceId: string };
  mediaCapture: { cameraLabel: string; microphoneLabel: string };
  mobile: { device: MobileDeviceId; orientation: 'portrait' | 'landscape'; osVersion?: '15' | '14' | '13' | '12' | '18.0' | '17.5' | '16.7' };
  addons: string[]; vstudioWebOnLaunch: boolean; encrypted: boolean; deleteOnClose: boolean; keepHistory: boolean; savePasswords: boolean; restoreSession: boolean; homePage: string; searchEngine?: string;
  theme: 'dark' | 'light'; browserShell: 'octo' | 'chrome' | 'chromium' | 'firefox' | 'safari'; baseChromeLook: boolean; ordinaryBrowser?: boolean; appMode?: boolean; smartPaste?: boolean; fingerprint: Fingerprint;
  enginePrivacy: { chromium: { webRtc: 'default' | 'disable-non-proxied-udp'; location: 'ask' | 'block' }; firefox: { webRtc: 'default' | 'disabled'; location: 'ask' | 'block'; resistFingerprinting: boolean } };
  tags: string[]; folder: string; profileDirectory?: string; sortOrder: number; status: string; notes: string; startPages: string[];
  proxyCheck?: ProxyCheck; stats: { launches: number; lastLaunchAt: string; worktimeSec: number };
  // runtime info from the manager
  running: boolean; ready: boolean; stopping: boolean; startedAt: number; sealed: boolean; hasVault: boolean; needsResealing: boolean;
  issues: Array<{ key: string; severity: string }>; hasProxyCredentials: boolean; pendingCookies?: boolean; fingerprintWarnings: string[];
}
export interface SavedProxy { id: string; name: string; type: ProxyType; host: string; port: number; hasCredentials: boolean; changeIpUrl: string; createdAt: string; usageLimitBytes: number; usageBytes: number; lastCheck?: ProxyCheck; folder: string; rotationMode: 'auto' | 'rotating' | 'sticky'; rotationIntervalSec: number; ipHistory?: Array<{ ip: string; at: string }> }
export interface AddonInfo { id: string; name: string; description: { en: string; pl: string }; version: string; license: string; permissions: Array<{ en: string; pl: string }>; source: string; kind: string; status: string; integrity: { en: string; pl: string } }
export interface UpdateStatus {
  configured: boolean; current: string; latest: string | null; available: boolean; severity?: string; changelog?: { en: string; pl: string };
  components?: string[]; requiresRestart?: boolean; lastCheckAt?: string; lastResult?: string; error?: string;
  downloading?: { done: number; total: number }; readyToInstall?: string; rollbackAvailable: string[];
}
export interface Settings {
  updates: { autoCheck: boolean; backgroundCheck: boolean; channel: 'stable' | 'beta' };
  network: { publicIpLookup: boolean; autoRefresh: boolean; searchEngine: string; dns: { mode: 'system' | 'doh'; provider: string; customTemplate: string } };
  security: { autoLockMinutes: number; secretStore: 'local' }; logs: { mode: 'off' | 'standard' | 'diagnostic' };

  ui: { verticalTabs: boolean; theme: 'ink' | 'obsidian' | 'slate' | 'midnight' | 'navy' | 'charcoal' | 'amethyst' | 'purple' | 'forest' | 'emerald' | 'olive' | 'rose' | 'sunset' | 'copper' | 'frutigerAero' | 'liquidGlass' | 'halloweenDay' | 'halloweenNight' | 'kush' | 'tactical' | 'winterNight' | 'winterDay' | 'springBloom' | 'summerSolstice' | 'autumnHarvest' | 'valentines'; sleepTabsAfterMin: number; showStartupSplash: boolean; showBookmarksBar: boolean; hideDirectoryPaths: boolean; virtualBoxMode: boolean; confirmOnQuit: boolean; closeAction: 'ask' | 'quit' | 'background'; closeCountdown: boolean; openLinksInBackground: boolean; animations: boolean; sidebar: Array<{ id: View; visible: boolean }>; navOrder: View[]; navHidden: View[] };

  tor: { torBrowserPath: string }; offline: boolean; offlineMode: 'online' | 'practical' | 'strict'; api: { enabled: boolean; port: number };
  /** vStudio media plugins: Mobile is standalone on this PC, Web serves browser profiles. */
  plugins: Record<MediaPluginId, { enabled: boolean }>;
}

/** Identifiers of the two media plugins, kept in step with @octo/core. */
export type MediaPluginId = 'vstudio-mobile' | 'vstudio-web';

export interface CorePluginEntry {
  id: string; nameKey: string; descriptionKey: string; scopeKey: string; ready: boolean; detail: string;
}

export interface PluginEntry {
  id: MediaPluginId;
  name: string;
  scope: 'android' | 'browser';
  descriptionKey: string;
  status: {
    enabled: boolean; installed: boolean; running: boolean; bundleAvailable: boolean; pythonAvailable: boolean; updateAvailable?: boolean;
    virtualCameraDriver: boolean; virtualMicrophoneDriver: boolean; path: string; ready: boolean; complete?: boolean;
    requirements: Array<{ id?: string; key: string; ok: boolean; required?: boolean; fixable?: boolean; vendor?: string }>;
  };
}
export interface Init {
  lang: 'en' | 'pl'; dicts: Dicts; version: string; dataDir: string; searchEngines: string[]; addons: AddonInfo[]; kinds: Kind[];
  windowsSandbox: boolean; torBrowser: boolean; firefoxAvailable: boolean; inkbrowserInstalled: boolean;
  chromiumRuntimes: Array<{ entry: { version: string; channel: string; support: string; default?: boolean }; rootDir: string; executablePath: string; installed: boolean }>;
  settings: Settings; update: UpdateStatus; logMode: 'off' | 'standard' | 'diagnostic'; filtersUpdatedAt: string | null;
  keyringMode: 'os' | 'password' | null; keyringRequiresPassword: boolean; secretBackend: 'local';
}
/** Text for an InkBrowser launch that did not start. `detail` lists the blocked settings, comma-separated. */
export function inkbrowserLaunchMessage(status: string, detail = ''): string {
  if (status === 'inkbrowser-missing') return t('launch.status.inkbrowser-missing');
  const reasons = detail.split(',').filter(Boolean).map((reason) => t(`browserEngine.block.${reason}`)).join(', ');
  return t('launch.status.inkbrowser-conflict', { reasons });
}
export type View = 'profiles' | 'proxies' | 'backup' | 'virtualbox' | 'trash' | 'security' | 'settings' | 'api' | 'logs' | 'about';

/** Mutable launcher state shared by all views. */
export const S = {
  init: undefined as unknown as Init,
  profiles: [] as Profile[],
  proxies: [] as SavedProxy[],
  view: 'profiles' as View,
  folder: '' as string,
  search: '',
  tagFilter: '',
  /** Id of a profile that was just created: its row comes in highlighted. */
  flash: '',
  selected: new Set<string>(),
  proxySelected: new Set<string>(),
  /** Selected folder of the Proxies page ('' = all proxies). */
  proxyFolder: '' as string,
  render: () => {},
};

/**
 * Replay a short entry animation on an element that is already in the DOM.
 * A CSS animation only runs when the class is added to a *new* element, so
 * the class is removed, the layout is flushed, and the class goes back on.
 * Everything here is 100-180 ms and disabled by prefers-reduced-motion.
 */
export function animateIn(el: HTMLElement, kind: 'page' | 'next' | 'prev' | 'pop' | 'fade' = 'page'): void {
  const classes = ['anim-page', 'anim-next', 'anim-prev', 'anim-pop', 'anim-fade'];
  el.classList.remove(...classes);
  void el.offsetWidth;
  el.classList.add(`anim-${kind}`);
}

/**
 * Run a button's work with a visible "doing it now" state.
 *
 * Reserved for actions that really can block for seconds - an SDK tool,
 * adb, a disk write. Everything else must stay instant and silent:
 * a spinner on a fast action only makes the app feel slower than it is.
 */
export async function busy<T>(button: HTMLElement, labelKey: string, task: () => Promise<T>): Promise<T | undefined> {
  const control = button as HTMLButtonElement;
  const label = button.querySelector('span:not(.sw):not(.sw-state)') ?? button;
  const before = label.textContent ?? '';
  const wasDisabled = control.disabled === true;
  control.disabled = true;
  button.classList.add('is-busy');
  label.textContent = t(labelKey);
  try { return await task(); }
  finally {
    button.classList.remove('is-busy');
    label.textContent = before;
    control.disabled = wasDisabled;
  }
}

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const L = (o: { en: string; pl: string }) => o[getLang()] ?? o.en;
export const tv = (v: string) => (v.startsWith('t:') ? t(v.slice(2)) : v);

// ------------------------------------------------------------------ toasts / errors

/**
 * A compact but informative local notification. Every notification has a
 * headline, a short outcome and a timestamp instead of repeating a bare
 * “Saved”, and can be dismissed before its short timeout.
 */
export function toast(text: string, kind: 'ok' | 'err' | 'info' = 'info', detail?: string): void {
  const isGenericSave = text === t('toast.saved');
  const title = isGenericSave ? t('toast.savedTitle') : text;
  const fallbackDetail = kind === 'ok' ? t('toast.detail.ok') : kind === 'err' ? t('toast.detail.err') : t('toast.detail.info');
  const copy = h('div', { class: 'toast-copy' },
    h('b', { class: 'toast-title', text: title }),
    h('span', { class: 'toast-detail', text: detail ?? (isGenericSave ? t('toast.savedDetail') : fallbackDetail) }),
    h('span', { class: 'toast-meta', text: t('toast.justNow') }));
  const el = h('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, icon(kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : 'info', 17), copy);
  const dismiss = h('button', { type: 'button', class: 'toast-dismiss', title: t('toast.dismiss'), 'aria-label': t('toast.dismiss') }, icon('close', 14));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.add('leaving');
    window.setTimeout(() => el.remove(), 160);
  };
  dismiss.onclick = close;
  el.append(dismiss);
  $('toasts').append(el);
  window.setTimeout(close, kind === 'err' ? 7500 : 5000);
}

/** Error messages from the main process may be i18n keys (proxy.err.*). */
export function errText(err: unknown): string {
  const m = String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  return /^[a-z]+(\.[a-zA-Z0-9]+)+$/.test(m) ? t(m) : m;
}

export async function run<T>(p: Promise<T>, okKey?: string): Promise<T | undefined> {
  try {
    const r = await p;
    if (okKey) toast(t(okKey), 'ok');
    return r;
  } catch (err) {
    toast(errText(err), 'err');
    return undefined;
  }
}

// ------------------------------------------------------------------ modal

let modalOnClose: (() => void) | null = null;
let modalCloseOverride: (() => void) | null = null;

/** Temporarily turn every way of closing a modal (X, Escape, backdrop) into a
 * safer action, such as minimizing a long-running download. */
export function setModalCloseOverride(handler: (() => void) | null): void {
  modalCloseOverride = handler;
}

export function closeModal(): void {
  if (modalCloseOverride) { modalCloseOverride(); return; }
  $('modal').classList.add('hidden');
  clear($('modalBox'));
  modalCloseOverride = null;
  const f = modalOnClose;
  modalOnClose = null;
  f?.();
}

export function modal(title: string, build: (box: HTMLElement) => void, size: '' | 'wide' | 'xwide' | 'editor' | 'app-close' = '', onClose?: () => void): void {
  closePopup();
  modalCloseOverride = null;
  const box = $('modalBox');
  clear(box);
  modalOnClose = onClose ?? null;
  box.className = `modal-box${size ? ` ${size}` : ''}`;
  const close = h('button', { class: 'icon-btn', title: t('common.close'), 'aria-label': t('common.close') }, icon('close', 18));
  close.onclick = closeModal;
  box.append(h('div', { class: 'modal-head' }, h('h2', { text: title }), close));
  build(box);
  $('modal').classList.remove('hidden');
  animateIn(box, 'pop');
  (box.querySelector('input:not([type=checkbox]),select,textarea,button.primary') as HTMLElement | null)?.focus();
}

export function confirmDialog(text: string, fn: () => Promise<unknown>, okKey: string, danger = true): void {
  modal(t('common.confirm'), (box) => {
    const ok = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, text: t('common.confirm') }) as HTMLButtonElement;
    const cancel = h('button', { class: 'btn', text: t('common.cancel') }) as HTMLButtonElement;
    ok.onclick = async () => {
      ok.disabled = true; cancel.disabled = true; ok.classList.add('is-busy');
      const before = ok.textContent; ok.textContent = t('common.loading');
      const result = await run(fn(), okKey);
      if (result !== undefined) { closeModal(); return; }
      ok.disabled = false; cancel.disabled = false; ok.classList.remove('is-busy'); ok.textContent = before;
    };

    cancel.onclick = closeModal;
    box.append(h('p', { text }), h('div', { class: 'modal-actions' }, cancel, ok));
  });
}

// ------------------------------------------------------------------ popup menu

let popupEl: HTMLElement | null = null;

export function closePopup(): void {
  popupEl?.remove();
  popupEl = null;
}

export interface MenuItem { icon: string; label: string; fn: () => void; danger?: boolean; disabled?: boolean; active?: boolean }

/** Small dropdown menu anchored to a button; stays inside the window. */
export function popupMenu(anchor: HTMLElement, items: Array<MenuItem | 'sep'>, extraClass = ''): void {
  closePopup();
  const m = h('div', { class: `popup${extraClass ? ` ${extraClass}` : ''}`, role: 'menu' });
  for (const it of items) {
    if (it === 'sep') { m.append(h('div', { class: 'popup-sep' })); continue; }
    const b = h('button', { class: `popup-item${it.danger ? ' danger' : ''}${it.active ? ' active' : ''}`, role: 'menuitem', disabled: !!it.disabled }, icon(it.active ? 'check' : it.icon, 16), h('span', { text: it.label }));
    b.onclick = (e) => { e.stopPropagation(); closePopup(); it.fn(); };
    m.append(b);
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  let left = r.left;
  let top = r.bottom + 4;
  if (left + mw > innerWidth - 8) left = Math.max(8, r.right - mw);
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
  popupEl = m;
  (m.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus();
}

/** An anchored menu with a local filter for longer option lists (such as OS releases). */
export function searchablePopupMenu(anchor: HTMLElement, items: MenuItem[], searchLabel: string, extraClass = ''): void {
  closePopup();
  const m = h('div', { class: `popup popup-search${extraClass ? ` ${extraClass}` : ''}`, role: 'menu' });
  const search = h('input', { type: 'search', class: 'popup-search-input', placeholder: searchLabel, 'aria-label': searchLabel, autocomplete: 'off' }) as HTMLInputElement;
  const list = h('div', { class: 'popup-search-list' });
  const draw = () => {
    clear(list);
    const q = search.value.trim().toLocaleLowerCase();
    for (const it of items) {
      if (q && !it.label.toLocaleLowerCase().includes(q)) continue;
      const b = h('button', { class: `popup-item${it.danger ? ' danger' : ''}${it.active ? ' active' : ''}`, role: 'menuitem', disabled: !!it.disabled }, icon(it.active ? 'check' : it.icon, 16), h('span', { text: it.label }));
      b.onclick = (e) => { e.stopPropagation(); closePopup(); it.fn(); };
      list.append(b);
    }
    if (!list.childElementCount) list.append(h('p', { class: 'popup-search-empty', text: t('ui.noOptions') }));
  };
  search.oninput = draw;
  draw();
  m.append(search, list);
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth;
  const mh = m.offsetHeight;
  let left = r.left;
  let top = r.bottom + 4;
  if (left + mw > innerWidth - 8) left = Math.max(8, r.right - mw);
  if (top + mh > innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
  popupEl = m;
  search.focus();
}

document.addEventListener('mousedown', (e) => { if (popupEl && !popupEl.contains(e.target as Node)) closePopup(); });
window.addEventListener('resize', closePopup);
document.addEventListener('scroll', closePopup, true);

// ------------------------------------------------------------------ form controls

export function field(labelKey: string, control: HTMLElement, hintKey?: string, hintRaw?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'lbl', text: t(labelKey) }), control, hintKey || hintRaw ? h('span', { class: 'hint', text: hintRaw ?? t(hintKey!) }) : null);
}

/**
 * Minimal anchored dropdown, rather than a platform-native select. The trigger
 * and option container intentionally follow the supplied reference: a single
 * clean control, an attached list, and a restrained selected/hover state.
 */
export function select<T extends string>(value: T, options: Array<[T, string] | [T, string, boolean]>, onChange?: (v: T) => void): HTMLButtonElement {
  let current = value;
  const wrap = h('div', { class: 'select-menu' });
  const trigger = h('button', { type: 'button', class: 'select-trigger', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }) as HTMLButtonElement;
  const label = h('span', { class: 'ell', text: options.find(([v]) => v === current)?.[1] ?? String(current) });
  trigger.append(label, icon('chevronDown', 16));
  const list = h('div', { class: 'select-options hidden', role: 'listbox' });
  const close = () => { list.classList.add('hidden'); trigger.setAttribute('aria-expanded', 'false'); };
  const open = () => { if (trigger.disabled) return; list.classList.remove('hidden'); trigger.setAttribute('aria-expanded', 'true'); };
  for (const option of options) {
    const [v, text, disabled] = option;
    const item = h('button', { type: 'button', class: `select-option${v === current ? ' on' : ''}`, role: 'option', 'aria-selected': String(v === current), text, ...(disabled ? { disabled: 'true', title: text } : {}) });
    item.onclick = () => {
      current = v;
      label.textContent = text;
      list.querySelectorAll('.select-option').forEach((x) => { x.classList.toggle('on', x === item); x.setAttribute('aria-selected', String(x === item)); });
      close();
      onChange?.(v);
    };
    list.append(item);
  }
  trigger.onclick = () => list.classList.contains('hidden') ? open() : close();
  trigger.onkeydown = (e) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); (list.querySelector('.select-option.on') as HTMLButtonElement | null)?.focus(); } };
  document.addEventListener('mousedown', (e) => { if (!wrap.contains(e.target as Node)) close(); });
  wrap.append(trigger, list);
  // Preserve the former helper's ergonomic disabled property for callers while
  // returning the wrapper that owns the anchored options list.
  Object.defineProperty(wrap, 'disabled', { get: () => trigger.disabled, set: (v: boolean) => { trigger.disabled = !!v; if (v) close(); } });
  Object.defineProperty(wrap, 'value', { get: () => current });
  return wrap as unknown as HTMLButtonElement;
}

export function input(value: string, attrs: Record<string, string> = {}, onInput?: (v: string) => void): HTMLInputElement {
  const el = h('input', { type: 'text', ...attrs });
  el.value = value;
  if (onInput) el.oninput = () => onInput(el.value);
  return el;
}

export function toggle(checked: boolean, labelKey: string, onChange?: (v: boolean) => void, disabled = false): HTMLElement {
  const inp = h('input', { type: 'checkbox', checked, disabled });
  // The state is written out as text as well, so it never depends on the switch colour alone.
  const state = h('span', { class: 'sw-state', text: t(checked ? 'state.on' : 'state.off') });
  if (onChange) inp.onchange = () => { onChange(inp.checked); state.textContent = t(inp.checked ? 'state.on' : 'state.off'); };
  return h('label', { class: 'toggle' }, inp, h('span', { class: 'sw' }), h('span', { text: t(labelKey) }), state);
}

/** Segmented button group (like the "Off / Real / Noise" chips of the reference UI). */
export function seg<T extends string>(value: T, options: Array<[T, string] | [T, string, string]>, onChange: (v: T) => void, cls = ''): HTMLElement {
  const g = h('div', { class: `seg ${cls}`, role: 'radiogroup' });
  for (const o of options) {
    const [v, label, ic] = o as [T, string, string?];
    const b = h('button', { type: 'button', class: v === value ? 'on' : '', role: 'radio', 'aria-checked': String(v === value) }, ic ? icon(ic, 15) : null, h('span', { text: label }));
    b.onclick = () => {
      g.querySelectorAll('button').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-checked', 'false'); });
      b.classList.add('on');
      b.setAttribute('aria-checked', 'true');
      onChange(v);
    };
    g.append(b);
  }
  return g;
}

/** Row of the advanced fingerprint editor: label on the left, controls on the right. */
export function frow(label: string, ...controls: Array<HTMLElement | null>): HTMLElement {
  return h('div', { class: 'frow' }, h('div', { class: 'frow-l' }, h('span', { text: label })), h('div', { class: 'frow-r' }, ...controls));
}

/** Row of the advanced fingerprint editor with an information button revealing a description. */
export function frowWithInfo(label: string, infoText: string, ...controls: Array<HTMLElement | null>): HTMLElement {
  const card = h('div', { class: 'frow-info-card hidden' }, h('p', { text: infoText }));
  const infoBtn = h('button', {
    type: 'button',
    class: 'frow-info-trigger',
    title: t('ui.info') || 'Information',
    'aria-label': `${label} info`,
  }, icon('info', 13));
  infoBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const wasHidden = card.classList.contains('hidden');
    card.classList.toggle('hidden', !wasHidden);
    infoBtn.classList.toggle('active', wasHidden);
  };
  const labelWrap = h('div', { class: 'frow-l' }, h('span', { text: label }), infoBtn);
  const rightWrap = h('div', { class: 'frow-r' }, ...controls, card);
  return h('div', { class: 'frow' }, labelWrap, rightWrap);
}

export function fieldWithInfo(labelKey: string, infoText: string, control: HTMLElement, hintKey?: string, hintRaw?: string): HTMLElement {
  const card = h('div', { class: 'frow-info-card hidden' }, h('p', { text: infoText }));
  const infoBtn = h('button', {
    type: 'button',
    class: 'frow-info-trigger',
    title: t('ui.info') || 'Information',
    'aria-label': `${t(labelKey)} info`,
  }, icon('info', 13));
  infoBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const wasHidden = card.classList.contains('hidden');
    card.classList.toggle('hidden', !wasHidden);
    infoBtn.classList.toggle('active', wasHidden);
  };
  const labelWrap = h('span', { class: 'lbl lbl-with-info' }, h('span', { text: t(labelKey) }), infoBtn);
  return h('label', { class: 'field' }, labelWrap, control, card, hintKey || hintRaw ? h('span', { class: 'hint', text: hintRaw ?? t(hintKey!) }) : null);
}

/** Tag input: type + Enter/comma adds a chip; click x removes it. */
export function tagInput(tags: string[], onChange: (tags: string[]) => void, suggestions: string[] = []): HTMLElement {
  const wrap = h('div', { class: 'tag-input' });
  const list = [...tags];
  const dl = `tags-${Math.random().toString(36).slice(2)}`;
  const inp = h('input', { type: 'text', placeholder: t('ui.tagsPh'), list: dl, maxlength: '32' });
  const data = h('datalist', { id: dl });
  for (const s of suggestions) data.append(h('option', { value: s }));
  const draw = () => {
    wrap.querySelectorAll('.tag').forEach((x) => x.remove());
    for (const tg of list) {
      const x = h('button', { type: 'button', class: 'tag-x', 'aria-label': t('common.remove') }, icon('close', 12));
      x.onclick = () => { list.splice(list.indexOf(tg), 1); onChange([...list]); draw(); };
      wrap.insertBefore(h('span', { class: 'tag' }, h('span', { text: tg }), x), inp);
    }
  };
  const add = () => {
    for (const part of inp.value.split(',')) {
      const v = part.trim();
      if (v && !list.includes(v) && list.length < 20) list.push(v);
    }
    inp.value = '';
    onChange([...list]);
    draw();
  };
  inp.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
    if (e.key === 'Backspace' && !inp.value && list.length) { list.pop(); onChange([...list]); draw(); }
  };
  inp.onblur = () => { if (inp.value.trim()) add(); };
  wrap.append(inp, data);
  wrap.onclick = (e) => { if (e.target === wrap) inp.focus(); };
  draw();
  return wrap;
}

// ------------------------------------------------------------------ formatting

/**
 * Octo.su octopus mark, built with DOM SVG calls (the strict CSP of the
 * launcher forbids innerHTML). The paths are the branding/octobrowser
 * logo-small.svg artwork, so the window, the taskbar icon and the installer
 * all show the same mark.
 */
export function brandLogo(size = 22): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('brand-mark');
  const body = document.createElementNS(NS, 'g');
  body.setAttribute('fill', 'currentColor');
  const paths = [
    'M16 3.5c-4.4 0-7.1 3.4-7.1 7.8 0 2.4.8 4.2 2.6 5.3h9c1.8-1.1 2.6-2.9 2.6-5.3 0-4.4-2.7-7.8-7.1-7.8Z',
    'M9.5 13.5c-3.2 1-4.8-2-6.2-1.2-1 .5-1.3 1.5-1.7 2.6 1.3-1.5 2.7-1.4 4.1-.5 1.7 1.1 3.2 1 5.1.1Z',
    'M10.8 16c-3 .8-5.2-.2-6.8 1.9-.6.9-.5 2-.2 3.1.5-2 2-2.9 3.8-2.5 2.1.5 3.6-.3 5-1.8Z',
    'M13.2 16.5c-1.7 2.5-4.4 3.1-4.3 5.7 0 1.1.7 1.9 1.5 2.6-.3-2 1.1-3.3 2.7-4.2 1.4-.8 2-2.3 2.2-4.2Z',
    'M18.8 16.5c1.7 2.5 4.4 3.1 4.3 5.7 0 1.1-.7 1.9-1.5 2.6.3-2-1.1-3.3-2.7-4.2-1.4-.8-2-2.3-2.2-4.2Z',
    'M21.2 16c3 .8 5.2-.2 6.8 1.9.6.9.5 2 .2 3.1-.5-2-2-2.9-3.8-2.5-2.1.5-3.6-.3-5-1.8Z',
    'M22.5 13.5c3.2 1 4.8-2 6.2-1.2 1 .5 1.3 1.5 1.7 2.6-1.3-1.5-2.7-1.4-4.1-.5-1.7 1.1-3.2 1-5.1.1Z',
    'M9.8 12.5c0 2.8 2.2 4.6 6.2 4.6s6.2-1.8 6.2-4.6c0-1.7-1.1-3.1-2.8-3.5h-6.8c-1.7.4-2.8 1.8-2.8 3.5Z',
  ];
  for (const d of paths) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    body.append(path);
  }
  const eyes = document.createElementNS(NS, 'g');
  eyes.setAttribute('fill', 'var(--bg, #101013)');
  for (const [cx, cy] of [[12.9, 13.1], [19.1, 13.1]] as const) {
    const circle = document.createElementNS(NS, 'circle');
    circle.setAttribute('cx', String(cx));
    circle.setAttribute('cy', String(cy));
    circle.setAttribute('r', '2.5');
    eyes.append(circle);
  }
  svg.append(body, eyes);
  return svg;
}

export function osIcon(os: FpOs | undefined, size = 16): SVGSVGElement {
  return icon(os === 'macos' ? 'apple' : os === 'linux' ? 'linux' : 'windows', size, `os-ic os-${os ?? 'windows11'}`);
}

export function osLabel(os: FpOs): string {
  return t(`fp.os.${os}`);
}

/** Emoji flag from an ISO country code (renders as letters where the font has no flags). */
export function flag(code?: string): string {
  if (!code || !/^[a-z]{2}$/i.test(code)) return '';
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function fmtDuration(sec: number): string {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const hh = String(Math.floor((sec % 86400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${d ? `${d}d ` : ''}${hh}:${mm}:${ss}`;
}

export function worktime(p: Profile): number {
  const base = p.stats?.worktimeSec ?? 0;
  return p.running && p.startedAt ? base + (Date.now() - p.startedAt) / 1000 : base;
}

export function proxyText(px: { type: string; host: string; port: number }): string {
  return `${px.type}://${px.host}:${px.port}`;
}

export function checkLine(c: ProxyCheck | undefined): HTMLElement {
  if (!c) return h('span', { class: 'chk none', text: t('proxy.notChecked') });
  if (!c.ok) return h('span', { class: 'chk bad', title: c.error ?? '' }, icon('alert', 13), h('span', { text: `${t('proxy.failed')}${c.error ? `: ${errText(c.error)}` : ''}` }));
  const where = [c.city, c.countryCode?.toUpperCase()].filter(Boolean).join(', ');
  return h('span', { class: 'chk ok', title: [c.country, c.region, c.city, c.timezone].filter(Boolean).join(' · ') },
    c.countryCode ? h('span', { class: 'cc', text: c.countryCode.toUpperCase() }) : null, h('span', { text: `${c.ip ?? ''}${where ? ` · ${where}` : ''}${c.latencyMs ? ` · ${c.latencyMs} ms` : ''}` }));
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', {});
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(t('ui.copied'), 'ok');
}
