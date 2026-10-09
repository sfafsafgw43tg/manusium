/**
 * apps/octobrowser/src/renderer/browser.ts
 *
 * Trusted browser chrome UI: tab strip (horizontal or vertical), toolbar with
 * address bar and status icons, info bars (permissions, blocked redirects,
 * download confirmations, toasts), find bar, tab search and docked panels
 * (traffic, audio, privacy, add-ons, downloads, bookmarks, history, updates,
 * shortcuts, menu). Page content is rendered by native views positioned over
 * #content - we report that rectangle to the main process.
 */
import { api, bytes, clear } from '@octo/shell/renderer/bridge';
import { applyI18n, h, setDicts, setLang, t, Dicts, getLang } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { commandFor } from '../shared/shortcuts';
import { generatePassword, passwordStrength } from '../shared/password-tools';
import { shouldDetachTab, tabDragStarted, tabDropIndex } from './tab-drag';
import { placeTabMenu, tabMenuRows, type TabMenuAction } from './tab-menu';

// ------------------------------------------------------------------ types

interface TabState {
  id: number; title: string; url: string; favicon?: string; loading: boolean; audible: boolean; muted: boolean;
  volume: number; pinned: boolean; group: string; sleeping: boolean; blocked: number; canBack: boolean; canForward: boolean;
  security: 'https' | 'http' | 'internal' | 'other'; crashed: boolean; zoom: number; redirectBlocked?: string;
}
interface ProfileInfo {
  id: string; name: string; kind: string; color: string; level: 'normal' | 'standard' | 'strict' | 'tor'; encrypted: boolean;
  network: 'system' | 'direct' | 'proxy'; deleteOnClose: boolean;
  audio: { muted: boolean; volume: number; outputDeviceId: string }; addons: string[];
  theme: 'dark' | 'light'; browserShell: 'octo' | 'chrome' | 'chromium' | 'firefox' | 'safari'; baseChromeLook: boolean; appMode: boolean; smartPaste: boolean; mobile: boolean;
}
interface UpdateStatus {
  configured: boolean; current: string; latest: string | null; available: boolean; severity?: string;
  changelog?: { en: string; pl: string }; lastCheckAt?: string; error?: string;
}
interface WinState {
  tabs: TabState[]; activeId: number; splitId: number; fullscreen: boolean; closedCount: number;
  profile: ProfileInfo; protection: 'active' | 'attention'; verticalTabs: boolean; showBookmarksBar: boolean; closeCountdown: boolean; openLinksInBackground: boolean; animations: boolean; virtualBoxMode?: boolean; hideDirectoryPaths?: boolean; offline: boolean; update: UpdateStatus | null;
}
interface AddonInfo {
  id: string; name: string; description: { en: string; pl: string }; version: string; license: string;
  permissions: Array<{ en: string; pl: string }>; source: string; kind: string; status: string; integrity: { en: string; pl: string };
}
interface DownloadInfo {
  id: string; fileName: string; savePath: string; url: string;
  state: 'choosing-location' | 'downloading' | 'paused' | 'scanning' | 'completed' | 'cancelled' | 'failed';
  received: number; total: number; speedBytesPerSecond: number; etaSeconds: number | null; canResume: boolean;
  dangerous: boolean; startedAt: string; error?: string;
}
type Panel = 'traffic' | 'audio' | 'privacy' | 'addons' | 'downloads' | 'bookmarks' | 'history' | 'updates' | 'shortcuts' | 'passwords' | 'media' | 'settings';

// ------------------------------------------------------------------ state

let state: WinState | null = null;
let addons: AddonInfo[] = [];
let shortcuts: Array<[string, string]> = [];
let panel: Panel | null = null;
let panelTimer: number | null = null;
let overlay = false;
let editingAddress = false;
let chromeMenuOpen = false;
/** Tab whose right-click dropdown is showing in #chromeMenu; 0 for the browser menu. */
let chromeMenuTabId = 0;
let pageInfoOpen = false;
let translateOpen = false;
type PageInfoView = 'root' | 'security' | 'cookies' | 'settings';
let pageInfoView: PageInfoView = 'root';
let panelCoversContent = false;
let closeCountdownTimer: number | undefined;
let stopChromeMediaPreview: (() => boolean) | null = null;
const downloads = new Map<string, DownloadInfo>();
let shuttingDown = false;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const tabById = (id: number) => state?.tabs.find((x) => x.id === id);
const activeTab = () => (state ? tabById(state.activeId) : undefined);
const usesVerticalTabs = () => state?.verticalTabs === true && state.profile.mobile !== true;
const L = (o: { en: string; pl: string }) => o[getLang()] ?? o.en;
const duration = (seconds: number): string => {
  const safe = Math.max(0, Math.round(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  return safe < 3_600 ? `${minutes}m ${safe % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

// ------------------------------------------------------------------ layout reporting

function reportLayout(): void {
  const r = $('content').getBoundingClientRect();
  void api.invoke('ui:layout', { x: r.left, y: r.top, width: r.width, height: r.height }, overlay).catch(() => undefined);
}
new ResizeObserver(reportLayout).observe($('content'));
window.addEventListener('resize', reportLayout);

/** Hide native tab views while a trusted chrome modal needs to cover them. */
function setContentCovered(on: boolean): void {
  overlay = on;
  reportLayout();
}

function setOverlay(on: boolean): void {
  setContentCovered(on);
  $('overlay').classList.toggle('hidden', !on);
}

// ------------------------------------------------------------------ toolbar

/** Close every popout. `keepChromeMenu` leaves an open browser or tab dropdown in place for the caller to reuse. */
function dismissAllPopouts(keepChromeMenu = false): void {
  if (chromeMenuOpen && !keepChromeMenu) closeChromeMenu();
  if (downloadsTrayOpen) closeDownloadsTray();
  if (passwordsPopoutOpen) closePasswordsPopout();
  if (pageInfoOpen) closePageInfo();
  if (translateOpen) closeTranslateBar();
}

function initToolbar(): void {
  $('newTab').append(icon('plus', 16));
  $('back').append(icon('back'));
  $('forward').append(icon('forward'));
  $('reload').append(icon('reload'));
  $('star').append(icon('star', 16));
  $('translateBtn').append(icon('globe', 16));
  $('secIcon').onclick = (e) => { e.stopPropagation(); void togglePageInfo(); };
  $('translateBtn').onclick = (e) => { e.stopPropagation(); toggleTranslateBar(); };
  $('findPrev').append(icon('back', 14));
  $('findNext').append(icon('forward', 14));
  $('findClose').append(icon('close', 14));
  $('panelClose').append(icon('close', 14));

  $('newTab').onclick = () => {
    dismissAllPopouts();
    void api.invoke('ui:new-tab');
  };
  $('back').onclick = () => void api.invoke('ui:command', 'back');
  $('forward').onclick = () => void api.invoke('ui:command', 'forward');
  $('reload').onclick = () => void api.invoke('ui:command', activeTab()?.loading ? 'stop' : 'reload');
  $('star').onclick = () => void api.invoke('ui:command', 'bookmark');
  $('panelClose').onclick = () => openPanel(null);
  $('downloadsTrayClose').append(icon('close', 14));
  $('downloadsTrayClose').onclick = closeDownloadsTray;
  $('downloadsTrayFootIcon').append(icon('externalLink', 14));
  $('downloadsTrayFoot').onclick = () => {
    closeDownloadsTray();
    void api.invoke('ui:download-action', '', 'open-folder');
  };
  $('pwPopoutMenu').append(icon('menu', 16));
  $('pwFilterIcon').append(icon('diamond', 13));
  $('pwSearchIcon').append(icon('search', 14));
  $('pwAddNew').append(icon('plus', 16));
  $('pwPopoutClose').append(icon('close', 14));
  $('pwSortBtn').append(icon('swap', 14));
  $('pwAddNew').onclick = () => {
    isAddingPassword = true;
    isEditingPassword = false;
    const detailCol = $('pwDetailCol');
    if (detailCol) renderPasswordsDetail(detailCol);
  };
  $('pwPopoutClose').onclick = closePasswordsPopout;
  const pwSearch = $<HTMLInputElement>('pwSearchInput');
  pwSearch.oninput = () => {
    passwordSearchQuery = pwSearch.value.trim().toLowerCase();
    void renderPasswordsPopout();
  };
  $('pwTabAll').onclick = () => {
    passwordActiveTab = 'all';
    $('pwTabAll').classList.add('active');
    $('pwTabRecent').classList.remove('active');
    void renderPasswordsPopout();
  };
  $('pwTabRecent').onclick = () => {
    passwordActiveTab = 'recent';
    $('pwTabRecent').classList.add('active');
    $('pwTabAll').classList.remove('active');
    void renderPasswordsPopout();
  };
  $('profileBadge').onclick = toggleChromeMenu;
  $('profileBadge').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleChromeMenu(); } };

  const addr = $<HTMLInputElement>('address');
  addr.addEventListener('focus', () => { editingAddress = true; addr.select(); });
  addr.addEventListener('blur', () => { editingAddress = false; renderAddress(); });
  addr.addEventListener('paste', (event) => {
    if (!state?.profile.smartPaste) return;
    const raw = event.clipboardData?.getData('text/plain') ?? '';
    const cleaned = smartPasteValue(raw);
    if (!cleaned || cleaned === raw) return;
    event.preventDefault();
    const start = addr.selectionStart ?? addr.value.length;
    const end = addr.selectionEnd ?? start;
    addr.value = `${addr.value.slice(0, start)}${cleaned}${addr.value.slice(end)}`;
    addr.setSelectionRange(start + cleaned.length, start + cleaned.length);
  });
  addr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && addr.value.trim()) {
      void api.invoke('ui:navigate', addr.value.trim());
      addr.blur();
    } else if (e.key === 'Escape') {
      addr.blur();
    }
  });

  // status icons (each opens a panel)
  const status = $('status');
  const mk = (id: string, name: string, titleKey: string, onClick: () => void) => {
    const b = h('button', { id, class: 'icon-btn status', title: t(titleKey) });
    b.append(icon(name));
    b.onclick = onClick;
    status.append(b);
    return b;
  };
  mk('stProtection', 'shieldCheck', 'panel.privacy', () => openPanel('privacy'));
  mk('stNetwork', 'network', 'panel.traffic', () => openPanel('traffic'));
  mk('stEncryption', 'lock', 'ui.encryption', () => openPanel('privacy'));
  mk('stAudio', 'volume', 'panel.audio', () => openPanel('audio'));
  // One minimal camera control covers both selected video and audio inputs.
  const mediaButton = mk('stMedia', 'camera', 'media.captureInputs', () => openPanel('media'));
  const micMark = h('span', { class: 'media-mic-mark' });
  micMark.append(icon('volume', 10));
  mediaButton.append(micMark);
  mk('stDownloads', 'download', 'panel.downloads', toggleDownloadsTray);
  mk('stAddons', 'puzzle', 'panel.addons', () => openPanel('addons'));
  mk('stUpdates', 'refreshCircle', 'panel.updates', () => openPanel('updates'));
  mk('stMenu', 'menu', 'ui.menu', toggleChromeMenu);
}

function renderAddress(): void {
  const tab = activeTab();
  const addr = $<HTMLInputElement>('address');
  if (!editingAddress) addr.value = tab ? (tab.url.startsWith('octo://newtab') ? '' : tab.url) : '';
  const sec = $('secIcon');
  clear(sec);
  const s = tab?.security ?? 'internal';
  sec.className = `sec ${s}`;
  sec.append(icon(s === 'https' ? 'lock' : s === 'http' ? 'alert' : 'info', 15));
  sec.title = t(`ui.sec.${s}`);
  $<HTMLButtonElement>('back').disabled = !tab?.canBack;
  $<HTMLButtonElement>('forward').disabled = !tab?.canForward;
  const reload = $('reload');
  clear(reload);
  reload.append(icon(tab?.loading ? 'close' : 'reload'));
  const zoom = $('zoom');
  zoom.classList.toggle('hidden', !tab || tab.zoom === 100);
  zoom.textContent = tab ? `${tab.zoom}%` : '';
  zoom.onclick = () => void api.invoke('ui:command', 'zoom-reset');
  const bc = $('blockedCount');
  bc.classList.toggle('hidden', !tab || tab.blocked === 0);
  bc.textContent = tab ? String(tab.blocked) : '';
}

function renderStatus(): void {
  if (!state) return;
  const p = state.profile;
  const badge = $('profileBadge');
  clear(badge);
  badge.style.setProperty('--pc', p.color);
  badge.append(h('span', { class: 'dot' }), h('span', { class: 'name', text: p.name }), h('span', { class: 'lvl', text: t(`level.${p.level}`) }));
  badge.title = `${p.name} - ${t(`profile.kind.${p.kind}`)}`;

  const set = (id: string, cls: string, title: string, iconName?: string) => {
    const el = $(id);
    el.className = `icon-btn status ${cls}`;
    el.title = title;
    if (iconName) { clear(el); el.append(icon(iconName)); }
  };
  set('stProtection', state.protection === 'active' ? 'ok' : 'warn', t(state.protection === 'active' ? 'status.protectionActive' : 'status.attention'), state.protection === 'active' ? 'shieldCheck' : 'shieldAlert');
  set('stNetwork', state.offline ? 'warn' : p.network === 'proxy' ? 'ok' : '', state.offline ? t('status.offline') : t(`net.mode.${p.network}`), state.offline ? 'wifiOff' : 'network');
  set('stEncryption', p.encrypted ? 'ok' : 'dim', t(p.encrypted ? 'status.encrypted' : 'status.notEncrypted'), p.encrypted ? 'lock' : 'unlock');
  const audible = state.tabs.some((x) => x.audible && !x.muted);
  set('stAudio', p.audio.muted ? 'warn' : audible ? 'ok' : '', t('panel.audio'), p.audio.muted ? 'mute' : 'volume');
  const active = [...downloads.values()].some((d) => d.state === 'downloading' || d.state === 'choosing-location' || d.state === 'scanning');
  set('stDownloads', active ? 'ok pulse' : '', t('panel.downloads'));
  set('stUpdates', state.update?.available ? 'accent' : '', state.update?.available ? t('upd.available', { v: state.update.latest ?? '' }) : t('panel.updates'));
  const vertical = usesVerticalTabs();
  document.body.classList.toggle('vertical', vertical);
  $('vtabs').classList.toggle('hidden', !vertical);
}

// ------------------------------------------------------------------ tabs

type ActiveTabDrag = {
  id: number;
  pointerId: number;
  vertical: boolean;
  source: HTMLElement;
  box: HTMLElement;
  start: { x: number; y: number };
  last: { x: number; y: number };
  pointerOffset: { x: number; y: number };
  sourceRect: DOMRect;
  stripRect: DOMRect;
  started: boolean;
  ghost: HTMLElement | null;
  ghostLeft: number;
  ghostTop: number;
  raf: number;
};

let activeTabDrag: ActiveTabDrag | null = null;
let suppressTabClickUntil = 0;

function clearTabDropMarkers(): void {
  for (const node of document.querySelectorAll('.tab-drop-before, .tab-drop-after')) {
    node.classList.remove('tab-drop-before', 'tab-drop-after');
  }
}

function dragTabNodes(drag: ActiveTabDrag): HTMLElement[] {
  return [...drag.box.querySelectorAll<HTMLElement>('.tab[data-id]')];
}

function showTabDropMarker(drag: ActiveTabDrag, point: { x: number; y: number }): void {
  clearTabDropMarkers();
  const nodes = dragTabNodes(drag);
  if (!nodes.length) return;
  const index = tabDropIndex(point, nodes.map((node) => node.getBoundingClientRect()), drag.vertical);
  if (index < nodes.length) nodes[index].classList.add('tab-drop-before');
  else nodes[nodes.length - 1].classList.add('tab-drop-after');
}

function startTabGhost(drag: ActiveTabDrag): void {
  drag.started = true;
  drag.source.classList.add('tab-drag-source');
  document.body.classList.add('tab-dragging');
  const ghost = drag.source.cloneNode(true) as HTMLElement;
  ghost.classList.remove('tab-drag-source');
  ghost.classList.add('tab-drag-ghost');
  ghost.removeAttribute('id');
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: `${drag.sourceRect.width}px`,
    height: `${drag.sourceRect.height}px`,
    margin: '0',
    pointerEvents: 'none',
    zIndex: '80',
    willChange: 'transform',
    transform: `translate3d(${drag.sourceRect.left}px, ${drag.sourceRect.top}px, 0)`,
  });
  drag.ghost = ghost;
  drag.ghostLeft = drag.sourceRect.left;
  drag.ghostTop = drag.sourceRect.top;
  document.body.append(ghost);
  const tick = () => {
    if (!activeTabDrag || activeTabDrag !== drag || !drag.ghost) return;
    const detaching = shouldDetachTab(drag.last, drag.stripRect, drag.vertical);
    const targetX = drag.sourceRect.left + (drag.vertical && !detaching ? 0 : drag.last.x - drag.start.x);
    const targetY = drag.sourceRect.top + (!drag.vertical && !detaching ? 0 : drag.last.y - drag.start.y);
    const ease = tabMotionEnabled() ? 0.28 : 1;
    drag.ghostLeft += (targetX - drag.ghostLeft) * ease;
    drag.ghostTop += (targetY - drag.ghostTop) * ease;
    drag.ghost.style.transform = `translate3d(${drag.ghostLeft}px, ${drag.ghostTop}px, 0) scale(${detaching ? 0.96 : 1.02})`;
    drag.ghost.classList.toggle('detaching', detaching);
    if (detaching) clearTabDropMarkers();
    else showTabDropMarker(drag, drag.last);
    drag.raf = requestAnimationFrame(tick);
  };
  drag.raf = requestAnimationFrame(tick);
  try { drag.source.setPointerCapture(drag.pointerId); } catch { /* the global listeners still own cleanup */ }
}

function moveTabGhost(_drag: ActiveTabDrag, _point: { x: number; y: number }): void {
  /* Position is interpolated on the rAF loop started with the ghost. */
}

function removeTabDragListeners(drag: ActiveTabDrag): void {
  window.removeEventListener('pointermove', onTabPointerMove, true);
  window.removeEventListener('pointerup', onTabPointerUp, true);
  window.removeEventListener('pointercancel', cancelTabPointerDrag, true);
  window.removeEventListener('blur', cancelTabPointerDrag, true);
  window.removeEventListener('keydown', onTabDragKeyDown, true);
  document.removeEventListener('visibilitychange', onTabDragVisibility);
  drag.source.removeEventListener('lostpointercapture', cancelTabPointerDrag);
}

function finishTabPointerDrag(commit: boolean, event?: PointerEvent): void {
  const drag = activeTabDrag;
  if (!drag) return;
  activeTabDrag = null;
  if (drag.raf) cancelAnimationFrame(drag.raf);
  const wasStarted = drag.started;
  removeTabDragListeners(drag);
  try {
    if (drag.source.hasPointerCapture(drag.pointerId)) drag.source.releasePointerCapture(drag.pointerId);
  } catch { /* already released/cancelled */ }
  drag.source.classList.remove('tab-drag-source');
  drag.ghost?.remove();
  document.body.classList.remove('tab-dragging');
  clearTabDropMarkers();

  if (wasStarted) suppressTabClickUntil = Date.now() + 250;
  if (commit && wasStarted && event) {
    const point = { x: event.clientX, y: event.clientY };
    if (shouldDetachTab(point, drag.stripRect, drag.vertical)) {
      void api.invoke('ui:tab', drag.id, 'detach', {
        screenX: event.screenX,
        screenY: event.screenY,
        offsetX: drag.pointerOffset.x,
      });
    } else {
      const nodes = dragTabNodes(drag);
      const from = state?.tabs.findIndex((tab) => tab.id === drag.id) ?? -1;
      const to = tabDropIndex(point, nodes.map((node) => node.getBoundingClientRect()), drag.vertical);
      if (from >= 0 && to !== from && to !== from + 1) void api.invoke('ui:tab', drag.id, 'move', to > from ? to - 1 : to);
    }
  }
  // State pushes are intentionally not allowed to rebuild the source element
  // while it owns capture. Paint any title/load/crash changes now. A plain
  // click must keep its target connected until Chromium dispatches `click`.
  if (wasStarted) renderTabs();
}

function cancelActiveTabDrag(): void {
  finishTabPointerDrag(false);
}

function onTabPointerMove(event: PointerEvent): void {
  const drag = activeTabDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.last = { x: event.clientX, y: event.clientY };
  if (!drag.started && tabDragStarted(drag.start, drag.last)) startTabGhost(drag);
  if (!drag.started) return;
  event.preventDefault();
  moveTabGhost(drag, drag.last);
}

function onTabPointerUp(event: PointerEvent): void {
  if (!activeTabDrag || event.pointerId !== activeTabDrag.pointerId) return;
  finishTabPointerDrag(true, event);
}

function cancelTabPointerDrag(event: Event): void {
  if (event instanceof PointerEvent && activeTabDrag && event.pointerId !== activeTabDrag.pointerId) return;
  cancelActiveTabDrag();
}

function onTabDragKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    cancelActiveTabDrag();
  }
}

function onTabDragVisibility(): void {
  if (document.visibilityState !== 'visible') cancelActiveTabDrag();
}

function beginTabPointerDrag(event: PointerEvent, tab: TabState, source: HTMLElement, vertical: boolean): void {
  if (event.button !== 0 || (event.target as Element).closest('button')) return;
  cancelActiveTabDrag();
  const box = vertical ? $('vtabs') : $('tabs');
  const sourceRect = source.getBoundingClientRect();
  activeTabDrag = {
    id: tab.id,
    pointerId: event.pointerId,
    vertical,
    source,
    box,
    start: { x: event.clientX, y: event.clientY },
    last: { x: event.clientX, y: event.clientY },
    pointerOffset: { x: event.clientX - sourceRect.left, y: event.clientY - sourceRect.top },
    sourceRect,
    stripRect: box.getBoundingClientRect(),
    started: false,
    ghost: null,
    ghostLeft: sourceRect.left,
    ghostTop: sourceRect.top,
    raf: 0,
  };
  window.addEventListener('pointermove', onTabPointerMove, true);
  window.addEventListener('pointerup', onTabPointerUp, true);
  window.addEventListener('pointercancel', cancelTabPointerDrag, true);
  window.addEventListener('blur', cancelTabPointerDrag, true);
  window.addEventListener('keydown', onTabDragKeyDown, true);
  document.addEventListener('visibilitychange', onTabDragVisibility);
  source.addEventListener('lostpointercapture', cancelTabPointerDrag);
}

function tabElement(tab: TabState, vertical: boolean): HTMLElement {
  const el = h('div', {
    class: `tab${tab.id === state?.activeId ? ' active' : ''}${tab.pinned ? ' pinned' : ''}${tab.sleeping ? ' sleeping' : ''}${tab.id === state?.splitId ? ' split' : ''}`,
    role: 'tab',
    'aria-selected': String(tab.id === state?.activeId),
    title: `${tab.title}\n${tab.url}`,
  });
  el.dataset.id = String(tab.id);
  const fav = h('span', { class: 'fav' });
  if (tab.loading) fav.append(h('span', { class: 'spinner' }));
  else if (tab.favicon && /^https:|^data:image\//.test(tab.favicon)) fav.append(h('img', { src: tab.favicon, alt: '' }));
  else fav.append(icon(tab.url.startsWith('octo:') ? 'shield' : 'globe', 14));
  el.append(fav);
  if (tab.group) el.append(h('span', { class: 'group', text: tab.group }));
  if (!tab.pinned || vertical) el.append(h('span', { class: 'title', text: tab.title || t('ui.newTab') }));
  if (tab.audible || tab.muted) {
    const a = h('button', { class: 'icon-btn tiny', title: t(tab.muted ? 'ui.unmute' : 'ui.mute') });
    a.append(icon(tab.muted ? 'mute' : 'volume', 13));
    a.onclick = (e) => { e.stopPropagation(); void api.invoke('ui:tab', tab.id, 'mute'); };
    el.append(a);
  }
  if (!tab.pinned) {
    const c = h('button', { class: 'icon-btn tiny close', title: t('ui.closeTab') });
    c.append(icon('close', 12));
    // The tab itself owns pointerdown for drag/reorder. Without stopping the
    // close control's pointer sequence here, a click on one close button can
    // start a tab drag and the final pointerup is interpreted against a
    // rebuilt strip, making adjacent same-site tabs appear to close too.
    c.onpointerdown = (e) => { e.stopPropagation(); };
    c.onpointerup = (e) => { e.stopPropagation(); };
    c.onclick = (e) => { e.stopPropagation(); void api.invoke('ui:tab', tab.id, 'close'); };
    el.append(c);
  }
  el.onclick = () => {
    if (Date.now() >= suppressTabClickUntil) {
      dismissAllPopouts();
      void api.invoke('ui:tab', tab.id, 'activate');
    }
  };
  el.onauxclick = (e) => { if (e.button === 1) void api.invoke('ui:tab', tab.id, 'close'); };
  el.oncontextmenu = (e) => { e.preventDefault(); tabMenu(tab, e); };
  el.onpointerdown = (e) => beginTabPointerDrag(e, tab, el, vertical);
  // Never enter Chromium's native HTML drag loop: its unrestricted drag image
  // could remain over the address bar after cancellation or a page crash.
  el.ondragstart = (e) => e.preventDefault();
  return el;
}

const TAB_MOTION_DURATION = 220;
const TAB_MOTION_EASING = 'cubic-bezier(.22,1.15,.36,1)';
/** Opening a tab or a drawer tool eases in with the same soft curve as the Privacy drawer (no overshoot). */
const SOFT_OPEN_DURATION = 160;
const SOFT_OPEN_EASING = 'cubic-bezier(.2,.8,.2,1)';
let tabMotionPrimed = false;
let lastTabSignature = '';

type TabMotion = { node: HTMLElement; rect: DOMRect };

function tabMotionEnabled(): boolean {
  return document.documentElement.dataset.animations === 'on' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Keep a short-lived copy of a closing tab above the rebuilt strip. Native
 * page views must be detached immediately, but this lets the chrome finish a
 * small exit motion without delaying navigation or closure.
 */
function playClosingTabMotion(motion: TabMotion): void {
  if (!motion.rect.width || !motion.rect.height) return;
  const ghost = motion.node.cloneNode(true) as HTMLElement;
  ghost.classList.add('tab-motion-ghost');
  ghost.setAttribute('aria-hidden', 'true');
  Object.assign(ghost.style, {
    position: 'fixed', left: `${motion.rect.left}px`, top: `${motion.rect.top}px`,
    width: `${motion.rect.width}px`, height: `${motion.rect.height}px`, margin: '0',
    pointerEvents: 'none', zIndex: '60',
  });
  document.body.append(ghost);
  const animation = ghost.animate([
    { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
    { opacity: 0, transform: 'translate3d(-10px,0,0) scale(.9)' },
  ], { duration: TAB_MOTION_DURATION, easing: TAB_MOTION_EASING });
  animation.onfinish = () => ghost.remove();
  animation.oncancel = () => ghost.remove();
}

function renderTabs(): void {
  if (!state || activeTabDrag?.started) return;
  const vertical = usesVerticalTabs();
  const box = vertical ? $('vtabs') : $('tabs');
  const other = vertical ? $('tabs') : $('vtabs');
  const signature = `${vertical ? 'v' : 'h'}|${state.activeId}|${state.splitId}|${state.tabs.map((tab) => tab.id).join(',')}`;
  const structureChanged = signature !== lastTabSignature;
  lastTabSignature = signature;
  const nextIds = new Set(state.tabs.map((tab) => String(tab.id)));
  const previous = new Map<string, TabMotion>();
  const animate = structureChanged && tabMotionPrimed && tabMotionEnabled();
  if (animate) {
    for (const node of document.querySelectorAll<HTMLElement>('#tabs .tab[data-id], #vtabs .tab[data-id]')) {
      const id = node.dataset.id;
      if (id) previous.set(id, { node, rect: node.getBoundingClientRect() });
    }
    for (const [id, motion] of previous) if (!nextIds.has(id)) playClosingTabMotion(motion);
  }

  clear(box);
  clear(other);
  let lastGroup = '';
  for (const tab of state.tabs) {
    if (vertical && tab.group && tab.group !== lastGroup) box.append(h('div', { class: 'group-head', text: tab.group }));
    lastGroup = tab.group;
    box.append(tabElement(tab, vertical));
  }
  if (vertical) {
    const add = h('button', { class: 'btn ghost new-vtab' }, icon('plus', 14), ` ${t('ui.newTab')}`);
    add.onclick = () => {
      dismissAllPopouts();
      void api.invoke('ui:new-tab');
    };
    box.append(add);
  }

  if (animate) {
    requestAnimationFrame(() => {
      for (const node of box.querySelectorAll<HTMLElement>('.tab[data-id]')) {
        node.getAnimations().forEach((a) => a.cancel());
        const before = previous.get(node.dataset.id ?? '')?.rect;
        const after = node.getBoundingClientRect();
        if (!before) {
          node.animate([
            { opacity: 0, transform: vertical ? 'translate3d(0,-6px,0) scale(.97)' : 'translate3d(-8px,0,0) scale(.97)' },
            { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' },
          ], { duration: SOFT_OPEN_DURATION, easing: SOFT_OPEN_EASING });
          continue;
        }
        const x = before.left - after.left;
        const y = before.top - after.top;
        if (x || y) node.animate([
          { transform: `translate3d(${x}px, ${y}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ], { duration: TAB_MOTION_DURATION, easing: TAB_MOTION_EASING });
      }
    });
  }
  tabMotionPrimed = true;
  renderBars();
}

/**
 * Right-click on a tab opens the browser's dropdown at the cursor. It reuses
 * #chromeMenu, so it floats over the page, closes on an outside click or Escape,
 * and pops in through the .chrome-menu.tab-menu animation, like the browser menu.
 */
function tabMenu(tab: TabState, at: MouseEvent): void {
  // A dropdown that is already up is swapped in place: the chrome layer stays where it is
  // (no flip, so the page cannot flash), and the pop-in plays again from the new cursor spot.
  const swap = chromeMenuOpen;
  dismissAllPopouts(true);
  const menu = $('chromeMenu');
  clear(menu);
  chromeMenuTabId = tab.id;
  const rows = tabMenuRows(tab, {
    tabs: state?.tabs ?? [],
    activeId: state?.activeId ?? 0,
    splitId: state?.splitId ?? 0,
    closedCount: state?.closedCount ?? 0,
    verticalTabs: state?.verticalTabs === true,
  });
  for (const row of rows) {
    if (row.kind === 'separator') {
      menu.append(h('div', { class: 'chrome-menu-divider', role: 'separator' }));
      continue;
    }
    const btn: HTMLButtonElement = chromeMenuItem(t(row.labelKey), () => runTabMenuAction(tab, row.action, at, btn), {
      shortcut: row.shortcut,
      disabled: row.disabled,
      keepOpen: row.action === 'group',
    });
    menu.append(btn);
  }
  menu.classList.add('tab-menu');
  menu.setAttribute('aria-label', t('tab.menu'));
  chromeMenuOpen = true;
  document.body.classList.add('menu-open');
  if (swap) {
    // Animations restart only when the animation name changes, so clear it for one frame.
    menu.style.animation = 'none';
    void menu.offsetWidth;
    menu.style.animation = '';
  }
  menu.classList.remove('hidden');
  // offsetWidth/offsetHeight ignore the pop-in transform, so the size is exact.
  const place = placeTabMenu(
    { x: at.clientX, y: at.clientY },
    { width: menu.offsetWidth, height: menu.offsetHeight },
    { width: window.innerWidth, height: window.innerHeight },
  );
  menu.style.left = `${place.left}px`;
  menu.style.top = `${place.top}px`;
  menu.style.transformOrigin = place.origin;
  syncChromeFront();
  requestAnimationFrame(reportLayout);
}

/** Runs one tab-menu row. The menu has already closed, except for "Add tab to new group". */
function runTabMenuAction(tab: TabState, action: TabMenuAction, at: MouseEvent, anchor: HTMLElement): void {
  switch (action) {
    case 'group': toggleTabGroupForm(tab, anchor); return;
    case 'detach': void api.invoke('ui:tab', tab.id, 'detach', { screenX: at.screenX, screenY: at.screenY }); return;
    case 'reopen': void api.invoke('ui:command', 'reopen-tab'); return;
    case 'vertical': void api.invoke('ui:settings-set', { verticalTabs: !state?.verticalTabs }); return;
    default: void api.invoke('ui:tab', tab.id, action);
  }
}

/** "Add tab to new group": a name field under the row. An empty name removes the group. */
function toggleTabGroupForm(tab: TabState, anchor: HTMLElement): void {
  if (anchor.nextElementSibling?.classList.contains('chrome-menu-group')) {
    anchor.nextElementSibling.remove();
    return;
  }
  const input = h('input', { type: 'text', value: tab.group, placeholder: t('tab.groupName'), maxlength: '32', 'aria-label': t('tab.groupName') });
  const submit = () => {
    closeChromeMenu();
    void api.invoke('ui:tab', tab.id, 'group', input.value.trim());
  };
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
  const ok = h('button', { class: 'btn small primary', text: t('tab.setGroup') });
  ok.onclick = submit;
  anchor.after(h('div', { class: 'chrome-menu-group' }, input, ok));
  input.focus();
}

// ------------------------------------------------------------------ bars

interface Bar {
  id: string; kind: 'info' | 'warn' | 'ask'; text: string; appearance?: 'permission';
  originLabel?: string; detail?: string; permIcon?: string;
  actions: Array<{ key: string; primary?: boolean; keepOpen?: boolean; link?: boolean; run: () => void }>; timeout?: number;
}
const bars = new Map<string, Bar>();

function permissionBarOpen(): boolean {
  return [...bars.values()].some((b) => b.appearance === 'permission');
}

/**
 * Does the trusted chrome have to be drawn ON TOP of the live page?
 *
 * Only surfaces that genuinely overlap the page area do. The password card and
 * the permission bubble live in the toolbar strip (above the page view), so
 * they are visible without raising anything - and, crucially, without turning
 * the page into a dead rectangle. Raising the chrome over the page makes every
 * click land in the chrome instead of the site, which is exactly the
 * "one site becomes unresponsive to clicking" failure.
 */
function chromeNeedsFront(): boolean {
  return !shuttingDown && (pageInfoOpen || translateOpen || chromeMenuOpen || downloadsTrayOpen || passwordsPopoutOpen);
}

let chromeFront = false;
/** Active tab seen in the last state push, used to close page-covering surfaces. */
let lastActiveTabId: number | undefined;
function syncChromeFront(): void {
  const next = chromeNeedsFront();
  if (next === chromeFront) return;
  chromeFront = next;
  void api.invoke('ui:popup', next);
}

/**
 * One reconciliation point for the layer state.
 *
 * Every surface that raises the chrome over the page (panel, menu, trays,
 * page info, translate bar) can be closed from several places - a button, a
 * keyboard shortcut, a state push, a failed load. Missing just one of those
 * paths used to leave the chrome on top forever, and the site underneath
 * stopped reacting to clicks. Watching the classes of those surfaces makes the
 * release automatic instead of depending on somebody remembering to call it.
 */
function watchChromeLayers(): void {
  const run = () => syncChromeFront();
  const observer = new MutationObserver(run);
  for (const id of ['panel', 'pageInfo', 'translateBar', 'chromeMenu', 'downloadsTray', 'passwordsPopout', 'overlay']) {
    const node = document.getElementById(id);
    if (node) observer.observe(node, { attributes: true, attributeFilter: ['class'] });
  }
  // The bars strip is rebuilt (not toggled), so watch its children too.
  const bars = $('bars');
  observer.observe(bars, { childList: true, subtree: true });
  observer.observe($('content'), { childList: true, subtree: true });
  // Window focus and resize are cheap extra chances to notice a stale layer.
  window.addEventListener('focus', run);
  window.addEventListener('resize', run);
  document.addEventListener('visibilitychange', run);
}

/** Remove a bar and re-check whether the chrome still has to cover the page. */
function removeBar(id: string): void {
  if (!bars.delete(id)) return;
  renderBars();
  syncChromeFront();
}

function pushBar(b: Bar): void {
  if (shuttingDown) return;
  bars.set(b.id, b);
  if (b.timeout) window.setTimeout(() => { bars.delete(b.id); renderBars(); syncChromeFront(); }, b.timeout);
  renderBars();
}

function renderBars(): void {
  const box = $('bars');
  clear(box);
  const tab = activeTab();
  const all = [...bars.values()];
  if (tab?.redirectBlocked) {
    all.unshift({
      id: `redir-${tab.id}`, kind: 'warn', text: t('bar.redirectBlocked', { url: tab.redirectBlocked.slice(0, 120) }),
      actions: [
        { key: 'bar.allowRedirect', primary: true, run: () => void api.invoke('ui:tab', tab.id, 'allow-redirect') },
        { key: 'common.dismiss', run: () => void api.invoke('ui:tab', tab.id, 'dismiss-redirect') },
      ],
    });
  }
  if (tab?.crashed) {
    all.unshift({ id: 'crash', kind: 'warn', text: t('bar.crashed'), actions: [{ key: 'ctx.reload', primary: true, run: () => void api.invoke('ui:command', 'reload') }] });
  }
  if (state?.offline) all.unshift({ id: 'offline', kind: 'info', text: t('bar.offline'), actions: [{ key: 'bar.goOnline', run: () => void api.invoke('ui:settings-set', { offline: false }) }] });
  for (const b of all) {
    if (b.appearance === 'permission') {
      const el = h('div', { class: 'bar ask permission', role: 'dialog', 'aria-label': b.text });
      const close = h('button', { class: 'perm-close', type: 'button', title: t('common.dismiss'), 'aria-label': t('common.dismiss') });
      close.append(icon('close', 14));
      close.onclick = () => {
        const deny = b.actions.find((a) => a.key === 'perm.deny');
        removeBar(b.id);
        deny?.run();
      };
      el.append(close);
      el.append(h('div', { class: 'perm-title', text: b.originLabel || b.text }));
      const row = h('div', { class: 'perm-row' }, icon(b.permIcon || 'pin', 18), h('span', { class: 'perm-detail', text: b.detail || b.text }));
      el.append(row);
      const actions = h('div', { class: 'perm-actions' });
      for (const a of b.actions) {
        const btn = h('button', { class: a.link ? 'bar-link' : `perm-btn${a.primary ? ' primary' : ''}`, text: t(a.key) });
        btn.onclick = () => { if (!a.keepOpen) removeBar(b.id); a.run(); };
        actions.append(btn);
      }
      el.append(actions);
      box.append(el);
      continue;
    }
    const el = h('div', { class: `bar ${b.kind}` }, icon(b.kind === 'warn' ? 'alert' : b.kind === 'ask' ? 'shield' : 'info', 16), h('span', { class: 'bar-text', text: b.text }));
    for (const a of b.actions) {
      const btn = h('button', { class: a.link ? 'bar-link' : `btn small${a.primary ? ' primary' : ''}`, text: t(a.key) });
      btn.onclick = () => { if (!a.keepOpen) removeBar(b.id); a.run(); };
      el.append(btn);
    }
    box.append(el);
  }
  syncChromeFront();
  requestAnimationFrame(reportLayout);
}

function toast(key: string, params?: Record<string, string | number>): void {
  if (shuttingDown) return;
  pushBar({ id: `toast-${key}`, kind: 'info', text: t(key, params), actions: [], timeout: 3500 });
}

// ------------------------------------------------------------------ find & tab search

function openFind(): void {
  $('findbar').classList.remove('hidden');
  const inp = $<HTMLInputElement>('findInput');
  inp.focus();
  inp.select();
  requestAnimationFrame(reportLayout);
}
function closeFind(): void {
  $('findbar').classList.add('hidden');
  void api.invoke('ui:find', '', {});
  $('findCount').textContent = '';
  requestAnimationFrame(reportLayout);
}
function initFind(): void {
  const inp = $<HTMLInputElement>('findInput');
  inp.oninput = () => void api.invoke('ui:find', inp.value, { forward: true, findNext: false });
  inp.onkeydown = (e) => {
    if (e.key === 'Enter') void api.invoke('ui:find', inp.value, { forward: !e.shiftKey, findNext: true });
    if (e.key === 'Escape') closeFind();
  };
  $('findNext').onclick = () => void api.invoke('ui:find', inp.value, { forward: true, findNext: true });
  $('findPrev').onclick = () => void api.invoke('ui:find', inp.value, { forward: false, findNext: true });
  $('findClose').onclick = closeFind;
}

function openTabSearch(): void {
  setOverlay(true);
  const inp = $<HTMLInputElement>('tabSearchInput');
  inp.value = '';
  renderTabSearch('');
  inp.focus();
  inp.oninput = () => renderTabSearch(inp.value);
  inp.onkeydown = (e) => {
    if (e.key === 'Escape') setOverlay(false);
    if (e.key === 'Enter') ($('tabSearchList').firstElementChild as HTMLElement | null)?.click();
  };
  $('overlay').onclick = (e) => { if (e.target === $('overlay')) setOverlay(false); };
}
function renderTabSearch(q: string): void {
  const list = $('tabSearchList');
  clear(list);
  const n = q.toLowerCase();
  for (const tab of state?.tabs ?? []) {
    if (n && !tab.title.toLowerCase().includes(n) && !tab.url.toLowerCase().includes(n)) continue;
    const row = h('button', { class: 'menu-item' }, h('b', { text: tab.title || tab.url }), h('span', { class: 'muted', text: ` ${tab.url}` }));
    row.onclick = () => { void api.invoke('ui:tab', tab.id, 'activate'); setOverlay(false); };
    list.append(row);
  }
}

// ------------------------------------------------------------------ panels

function openPanel(p: Panel | null, custom?: () => void, title?: string): void {
  if (panelTimer) { window.clearInterval(panelTimer); panelTimer = null; }
  if (p === panel && !custom) p = null; // toggle
  if (p && downloadsTrayOpen) closeDownloadsTray();
  if (p && chromeMenuOpen) closeChromeMenu();
  if (p && passwordsPopoutOpen) closePasswordsPopout();
  const panelElement = $('panel');
  const body = $('panelBody');
  if (!p) {
    stopChromeMediaPreview?.();
    panel = null;
    panelCoversContent = false;
    // Browser tools retract into the toolbar instead of turning the live page
    // into a black modal backdrop or navigating to a full settings page.
    const finish = () => {
      if (panel !== null) return;
      panelElement.classList.add('hidden');
      clear(body);
      requestAnimationFrame(reportLayout);
    };
    if (tabMotionEnabled()) {
      const motion = panelElement.animate([
        { opacity: 1, transform: 'translateX(0)' },
        { opacity: 0, transform: 'translateX(18px)' },
      ], { duration: 120, easing: 'cubic-bezier(.4,0,1,1)' });
      void motion.finished.then(finish, finish);
    } else finish();
    return;
  }
  // Switching tools while the drawer is already on screen: the drawer does not slide again,
  // so its new body eases in here. Re-rendering the same tool (a refresh) does not replay it.
  const switchingTool = panel !== null && panel !== p && !panelElement.classList.contains('hidden') && tabMotionEnabled();
  panel = p;
  panelCoversContent = false;
  panelElement.classList.remove('hidden', 'popout');
  panelElement.setAttribute('role', 'complementary');
  panelElement.removeAttribute('aria-modal');
  clear(body);
  // Panel-specific styling (Passwords/Settings) must not leak into the next panel.
  body.classList.remove('pw-panel', 'browser-settings-panel');
  delete body.dataset.shell;
  $('panelTitle').textContent = title ?? t(`panel.${p}`);
  if (custom) custom();
  else void renderPanel(p);
  if (switchingTool) {
    body.animate([
      { opacity: 0, transform: 'translateX(10px)' },
      { opacity: 1, transform: 'translateX(0)' },
    ], { duration: SOFT_OPEN_DURATION, easing: SOFT_OPEN_EASING });
  }
  requestAnimationFrame(reportLayout);
}

function section(titleKey: string, ...children: Array<Node | string | null>): HTMLElement {
  return h('section', { class: 'psec' }, h('h3', { text: t(titleKey) }), ...children);
}
function kv(labelKey: string, value: string | Node, cls = ''): HTMLElement {
  return h('div', { class: `kv ${cls}` }, h('span', { class: 'k', text: t(labelKey) }), typeof value === 'string' ? h('span', { class: 'v', text: value }) : value);
}
function badge(state_: 'ok' | 'warn' | 'bad' | 'unknown' | 'info', key: string): HTMLElement {
  return h('span', { class: `pill ${state_}`, text: t(key) });
}

async function renderPanel(p: Panel): Promise<void> {
  const body = $('panelBody');
  try {
    switch (p) {
      case 'traffic': await renderTraffic(false); panelTimer = window.setInterval(() => void renderTraffic(false), 1000); break;
      case 'audio': renderAudio(body); break;
      case 'privacy': await renderPrivacy(body); break;
      case 'addons': renderAddons(body); break;
      case 'downloads': await renderDownloads(body); break;
      case 'bookmarks': await renderBookmarks(body); break;
      case 'history': await renderHistory(body, ''); break;
      case 'updates': renderUpdates(body); break;
      case 'shortcuts': renderShortcuts(body); break;
      case 'passwords': await renderPasswords(body); break;
      case 'media': {
        const data = await api.invoke<WindowSettings>('ui:settings-get');
        if (data) body.append(await browserMediaSettings(data, true));
        break;
      }
      case 'settings': await renderSettings(body); break;
    }
  } catch (err) {
    body.append(h('p', { class: 'err', text: String((err as Error).message ?? err) }));
  }
}

interface Traffic {
  publicIp: string | null; publicIpError: string | null; publicIpConsent: boolean; vpn: string[] | null;
  proxy: { active: boolean; value: string; mode: string; lockdown?: boolean; killSwitch?: boolean; leaksBlocked?: number }; proxyQuota: { usedBytes: number; limitBytes: number } | null; tor: boolean;
  dns: { servers: string[]; doh: boolean; dohTemplate: string | null; leak: string };
  webrtc: { policy: string; status: string }; bytesIn: number; bytesOut: number; requests: number; active: number;
  domains: Array<[string, number]>; blocked: { ads: number; trackers: number; scripts: number };
  httpsUpgrades: number; paramsStripped: number; thirdPartyCookiesBlocked: number; https: string;
  cert: { host: string; subject: string; issuer: string; validFrom: number; validTo: number; fingerprint: string; verified: boolean } | null;
  filtersUpdatedAt: string | null; autoRefresh: boolean;
}
let lastTraffic: { at: number; bytesIn: number; bytesOut: number } | null = null;

async function renderTraffic(force: boolean): Promise<void> {
  if (panel !== 'traffic') return;
  const tr = await api.invoke<Traffic>('ui:traffic', force);
  const body = $('panelBody');
  const now = Date.now();
  const rate = lastTraffic ? { down: (tr.bytesIn - lastTraffic.bytesIn) / ((now - lastTraffic.at) / 1000), up: (tr.bytesOut - lastTraffic.bytesOut) / ((now - lastTraffic.at) / 1000) } : { down: 0, up: 0 };
  lastTraffic = { at: now, bytesIn: tr.bytesIn, bytesOut: tr.bytesOut };
  clear(body);
  const leakPill = (s: string) => badge(s === 'ok' ? 'ok' : s === 'warning' || s === 'limited' ? 'warn' : s === 'leak' || s === 'exposed' ? 'bad' : 'unknown', `leak.${s}`);
  const ipVal = !tr.publicIpConsent ? h('span', { class: 'v muted', text: t('net.ipConsentOff') }) : h('span', { class: 'v mono', text: tr.publicIp ?? (tr.publicIpError ? t('state.unknown') : '...') });
  body.append(
    section('net.connection',
      kv('net.publicIp', ipVal),
      kv('net.vpn', tr.vpn ? tr.vpn.join(', ') : t('iso.vpn.none')),
      kv('net.proxy', tr.proxy.active ? tr.proxy.value : t(`net.mode.${tr.proxy.mode}`)),
      ...(tr.proxyQuota ? [kv('net.proxyQuota', tr.proxyQuota.limitBytes > 0 ? `${bytes(tr.proxyQuota.usedBytes)} / ${bytes(tr.proxyQuota.limitBytes)}` : `${bytes(tr.proxyQuota.usedBytes)} · ${t('net.proxyQuotaUnlimited')}`)] : []),
      kv('net.lockdown', tr.proxy.killSwitch
        ? badge('bad', 'net.killSwitchActive')
        : tr.proxy.lockdown ? badge('ok', 'net.lockdownActive') : badge(tr.proxy.mode === 'proxy' ? 'warn' : 'info', 'net.lockdownInactive')),
      ...(tr.proxy.leaksBlocked ? [kv('net.leaksBlocked', String(tr.proxy.leaksBlocked))] : []),
      kv('net.tor', t('net.torNotHere')),
      kv('net.https', badge(tr.https === 'https' ? 'ok' : tr.https === 'http' ? 'bad' : 'info', `ui.sec.${tr.https}`)),
    ),
    section('net.leaks',
      kv('net.dns', h('span', { class: 'v' }, leakPill(tr.dns.leak), ` ${tr.dns.doh ? 'DoH' : tr.dns.servers.slice(0, 2).join(', ')}`)),
      kv('net.webrtc', h('span', { class: 'v' }, leakPill(tr.webrtc.status), ` ${t(`webrtc.${tr.webrtc.policy}`)}`)),
    ),
    section('net.traffic',
      kv('net.down', `${bytes(Math.max(0, rate.down))}/s`),
      kv('net.up', `${bytes(Math.max(0, rate.up))}/s`),
      kv('net.total', `↓ ${bytes(tr.bytesIn)} · ↑ ${bytes(tr.bytesOut)}`),
      kv('net.requests', `${tr.requests} (${t('net.active')}: ${tr.active})`),
    ),
    section('net.blocked',
      kv('net.blockedAds', String(tr.blocked.ads)),
      kv('net.blockedTrackers', String(tr.blocked.trackers)),
      kv('net.blockedScripts', String(tr.blocked.scripts)),
      kv('net.httpsUpgrades', String(tr.httpsUpgrades)),
      kv('net.paramsStripped', String(tr.paramsStripped)),
      kv('net.cookiesBlocked', String(tr.thirdPartyCookiesBlocked)),
      kv('net.filtersUpdated', tr.filtersUpdatedAt ? new Date(tr.filtersUpdatedAt).toLocaleString() : t('state.never')),
    ),
  );
  if (tr.cert) {
    body.append(section('net.cert',
      kv('net.certHost', tr.cert.host),
      kv('net.certIssuer', tr.cert.issuer),
      kv('net.certValid', `${new Date(tr.cert.validFrom * 1000).toLocaleDateString()} – ${new Date(tr.cert.validTo * 1000).toLocaleDateString()}`),
      kv('net.certStatus', badge(tr.cert.verified ? 'ok' : 'bad', tr.cert.verified ? 'net.certOk' : 'net.certBad')),
    ));
  }
  const dom = h('div', { class: 'domains' });
  for (const [d, n] of tr.domains) dom.append(h('div', { class: 'kv' }, h('span', { class: 'k mono', text: d }), h('span', { class: 'v', text: String(n) })));
  body.append(section('net.domains', h('p', { class: 'muted small', text: t('net.domainsNote') }), dom));
  const actions = h('div', { class: 'row' });
  const refresh = h('button', { class: 'btn small', text: t('net.refresh') });
  refresh.onclick = () => void renderTraffic(true);
  const auto = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: tr.autoRefresh }), ` ${t('net.autoRefresh')}`);
  (auto.firstChild as HTMLInputElement).onchange = (e) => void api.invoke('ui:settings-set', { autoRefresh: (e.target as HTMLInputElement).checked });
  const offline = h('button', { class: 'btn small', text: t(state?.offline ? 'bar.goOnline' : 'net.goOffline') });
  offline.onclick = () => void api.invoke('ui:settings-set', { offline: !state?.offline });
  actions.append(refresh, auto, offline);
  body.append(actions);
}

function renderAudio(body: HTMLElement): void {
  if (!state) return;
  const p = state.profile;
  const master = h('input', { type: 'range', min: '0', max: '100', value: String(p.audio.volume) });
  master.oninput = () => void api.invoke('ui:audio', { volume: Number(master.value) });
  const mute = h('button', { class: `btn small${p.audio.muted ? ' primary' : ''}`, text: t(p.audio.muted ? 'ui.unmute' : 'audio.muteProfile') });
  mute.onclick = () => void api.invoke('ui:audio', { muted: !p.audio.muted }).then(() => openPanel('audio', () => renderAudio($('panelBody')), t('panel.audio')));
  body.append(section('audio.profile', h('div', { class: 'row' }, icon('volume'), master, h('span', { text: `${p.audio.volume}%` })), mute));

  const out = h('select', {});
  out.append(h('option', { value: '', text: t('audio.systemDefault') }));
  navigator.mediaDevices?.enumerateDevices().then((devs) => {
    let i = 1;
    for (const d of devs.filter((x) => x.kind === 'audiooutput' && x.deviceId !== 'default')) {
      const o = h('option', { value: d.deviceId, text: d.label || `${t('audio.device')} ${i++}` });
      if (d.deviceId === p.audio.outputDeviceId) o.selected = true;
      out.append(o);
    }
  }).catch(() => undefined);
  out.onchange = () => void api.invoke('ui:audio', { outputDeviceId: out.value });
  body.append(section('audio.output', out, h('p', { class: 'muted small', text: t('audio.outputNote') })));

  const list = h('div', { class: 'mixer' });
  const tabs = state.tabs.filter((x) => x.audible || x.muted || x.volume !== 100);
  if (!tabs.length) list.append(h('p', { class: 'muted', text: t('audio.nothingPlaying') }));
  for (const tab of tabs) {
    const r = h('input', { type: 'range', min: '0', max: '100', value: String(tab.volume) });
    r.oninput = () => void api.invoke('ui:tab', tab.id, 'volume', Number(r.value));
    const m = h('button', { class: 'icon-btn small', title: t(tab.muted ? 'ui.unmute' : 'ui.mute') }, icon(tab.muted ? 'mute' : 'volume', 14));
    m.onclick = () => void api.invoke('ui:tab', tab.id, 'mute');
    const go = h('button', { class: 'linkish', text: tab.title || tab.url });
    go.onclick = () => void api.invoke('ui:tab', tab.id, 'activate');
    list.append(h('div', { class: 'mix-row' }, go, h('div', { class: 'row' }, m, r, h('span', { class: 'small', text: `${tab.volume}%` }))));
  }
  body.append(section('audio.tabs', list), h('p', { class: 'muted small', text: t('audio.noEqualizer') }));
}

interface PrivacyInfo {
  settings: Record<string, unknown> & { level: string };
  issues: Array<{ key: string; severity: 'info' | 'warn' }>;
  profile: ProfileInfo;
}

async function renderPrivacy(body: HTMLElement): Promise<void> {
  const info = await api.invoke<PrivacyInfo>('ui:privacy');
  const s = info.settings;
  const hasWarn = info.issues.some((i) => i.severity === 'warn');
  body.append(h('div', { class: `hero ${hasWarn ? 'warn' : 'ok'}` }, icon(hasWarn ? 'shieldAlert' : 'shieldCheck', 28), h('div', {}, h('b', { text: t(hasWarn ? 'status.attention' : 'status.protectionActive') }), h('div', { class: 'small muted', text: t('status.noGuarantee') }))));

  const lvl = h('div', { class: 'seg' });
  for (const l of ['normal', 'standard', 'strict'] as const) {
    const b = h('button', { class: s.level === l ? 'on' : '', text: t(`level.${l}`), disabled: info.profile.kind === 'tor' });
    b.onclick = () => void api.invoke('ui:set-level', l).then(() => openPanel('privacy', () => void renderPrivacy($('panelBody')), t('panel.privacy'))).catch((e: Error) => toast('err.generic', { message: e.message }));
    lvl.append(b);
  }
  body.append(section('privacy.level', lvl, h('p', { class: 'small muted', text: t(`level.${s.level}.desc`) })));

  const rows: Array<[string, boolean | string]> = [
    ['privacy.blockAds', s.blockAds as boolean], ['privacy.blockTrackers', s.blockTrackers as boolean],
    ['privacy.httpsOnly', s.httpsOnly as boolean], ['privacy.3pCookies', s.blockThirdPartyCookies as boolean],
    ['privacy.stripParams', s.stripTrackingParams as boolean], ['privacy.bounce', s.blockBounceTracking as boolean],
    ['privacy.webrtc', t(`webrtc.${s.webrtc as string}`)], ['privacy.canvas', t(`canvas.${s.canvas as string}`)],
    ['privacy.webgl', t(`webgl.${s.webgl as string}`)], ['privacy.hardware', t(`hardware.${s.hardwareApis as string}`)],
    ['privacy.autoplay', s.blockAutoplay as boolean], ['privacy.popups', s.blockPopups as boolean],
    ['privacy.referrer', s.trimReferrer as boolean], ['privacy.gpc', s.globalPrivacyControl as boolean],
    ['privacy.clearOnExit', s.clearOnExit as boolean], ['privacy.redirects', s.confirmCrossSiteRedirects as boolean],
  ];
  const list = h('div', {});
  for (const [k, v] of rows) list.append(kv(k, typeof v === 'boolean' ? badge(v ? 'ok' : 'info', v ? 'state.on' : 'state.off') : v));
  body.append(section('privacy.active', list, h('p', { class: 'small muted', text: t('privacy.consistentNote') })));

  if (info.issues.length) {
    const ul = h('ul', { class: 'issues' });
    for (const i of info.issues) ul.append(h('li', { class: i.severity, text: t(i.key) }));
    body.append(section('privacy.issues', ul));
  }
  const clearBtn = h('button', { class: 'btn small danger', text: t('privacy.clearData') });
  clearBtn.onclick = () => void api.invoke('ui:clear-data').then(() => toast('toast.dataCleared'));
  const detect = h('button', { class: 'btn small', text: t('privacy.runDetect') });
  detect.onclick = () => void api.invoke('ui:open-detect');

  const btnPrivacySexy = h('button', { class: 'btn small primary', text: t('sec.privacySexyBtn') }) as HTMLButtonElement;
  btnPrivacySexy.onclick = () => void api.invoke('ui:new-tab', 'https://privacy.sexy');
  const btnPrivacySexySearch = h('button', { class: 'btn small', text: t('sec.privacySexySearch') }) as HTMLButtonElement;
  btnPrivacySexySearch.onclick = () => void api.invoke('ui:new-tab', 'https://duckduckgo.com/?q=privacy.sexy');

  body.append(h('div', { class: 'row' }, clearBtn, detect),
    h('div', { class: 'note' },
      h('b', { text: t('sec.privacySexyTitle') }),
      h('p', { class: 'small muted', text: t('sec.privacySexyDesc') }),
      h('div', { class: 'row' }, btnPrivacySexy, btnPrivacySexySearch)),
    h('p', { class: 'note small', text: t('security.malwareNotice') }));
}

function renderAddons(body: HTMLElement): void {
  if (!state) return;
  const enabled = new Set(state.profile.addons);
  const isTor = state.profile.level === 'tor';
  body.append(h('p', { class: 'small muted', text: t('addons.intro') }));
  for (const a of addons) {
    const on = enabled.has(a.id);
    const sw = h('input', { type: 'checkbox', checked: on, disabled: isTor || a.kind === 'external-app' });
    sw.onchange = () => {
      if (sw.checked && !confirmPermissions(a)) { sw.checked = false; return; }
      void api.invoke('ui:addon', a.id, sw.checked);
    };
    const perms = h('ul', { class: 'small' });
    for (const p of a.permissions) perms.append(h('li', { text: L(p) }));
    const details = h('details', {}, h('summary', { text: t('addons.details') }),
      kv('addons.version', a.version), kv('addons.license', a.license), kv('addons.source', a.source),
      kv('addons.status', t(`addons.status.${a.status}`)), h('div', { class: 'small', text: `${t('addons.permissions')}:` }), perms,
      h('div', { class: 'small muted', text: `${t('addons.integrity')}: ${L(a.integrity)}` }));
    const openWorkspace = a.kind === 'extension'
      ? h('button', { class: 'btn small', disabled: !on, text: t('addons.openWorkspace') }) as HTMLButtonElement
      : null;
    if (openWorkspace) openWorkspace.onclick = () => void api.invoke('ui:open-addon', a.id);
    body.append(h('div', { class: 'addon' },
      h('div', { class: 'addon-head' }, h('b', { text: a.name }), h('label', { class: 'switch' }, sw, h('span', {}))),
      h('div', { class: 'small', text: L(a.description) }), openWorkspace, details));
  }
  if (isTor) body.append(h('p', { class: 'note small', text: t('addons.torNote') }));
}

function confirmPermissions(a: AddonInfo): boolean {
  // A panel-embedded confirmation keeps page content visible; window.confirm is modal and simple.
  return window.confirm(`${a.name}\n\n${t('addons.permissions')}:\n- ${a.permissions.map(L).join('\n- ')}\n\n${t('addons.confirmEnable')}`);
}

let downloadsTrayOpen = false;

function openDownloadsTray(): void {
  if (shuttingDown) return;
  if (chromeMenuOpen) closeChromeMenu();
  if (passwordsPopoutOpen) closePasswordsPopout();
  if (panel) openPanel(null);
  downloadsTrayOpen = true;
  document.body.classList.add('downloads-tray-open');
  $('downloadsTray').classList.remove('hidden');
  $('downloadsTrayTitle').textContent = t('dl.recentHistory');
  $('downloadsTrayFullHistory').textContent = t('dl.fullHistory');
  void api.invoke('ui:popup', true);
  void renderDownloadsTray();
  requestAnimationFrame(reportLayout);
}

function closeDownloadsTray(): void {
  downloadsTrayOpen = false;
  document.body.classList.remove('downloads-tray-open');
  $('downloadsTray').classList.add('hidden');
  syncChromeFront();
  requestAnimationFrame(reportLayout);
}

function toggleDownloadsTray(): void {
  if (downloadsTrayOpen) closeDownloadsTray();
  else openDownloadsTray();
}

function timeAgo(isoString: string): string {
  try {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000));
    if (elapsedSec < 15) return t('common.justNow') || 'Just now';
    if (elapsedSec < 60) return `${elapsedSec}s ago`;
    const min = Math.floor(elapsedSec / 60);
    if (min < 60) return min === 1 ? '1 minute ago' : `${min} minutes ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return hr === 1 ? '1 hour ago' : `${hr} hours ago`;
    const days = Math.floor(hr / 24);
    return days === 1 ? '1 day ago' : `${days} days ago`;
  } catch {
    return t('dl.state.completed');
  }
}

function formatDownloadMeta(d: DownloadInfo): string {
  if (d.state === 'completed') {
    const sizeStr = bytes(d.total || d.received);
    const when = d.startedAt ? timeAgo(d.startedAt) : t('dl.state.completed');
    return `${sizeStr} · ${when}`;
  }
  if (d.state === 'downloading') {
    const sizeStr = `${bytes(d.received)}${d.total ? ` / ${bytes(d.total)}` : ''}`;
    const speedStr = d.speedBytesPerSecond > 0 ? ` · ${bytes(d.speedBytesPerSecond)}/s` : '';
    const etaStr = d.etaSeconds !== null ? ` · ${t('dl.eta', { time: duration(d.etaSeconds) })}` : '';
    return `${sizeStr}${speedStr}${etaStr}`;
  }
  if (d.state === 'paused') {
    return `${bytes(d.received)}${d.total ? ` / ${bytes(d.total)}` : ''} · ${t('dl.state.paused')}`;
  }
  if (d.state === 'cancelled') {
    return `${t('dl.state.cancelled')} · ${bytes(d.received)}`;
  }
  if (d.state === 'failed') {
    return `${t('dl.state.failed')}${d.error ? `: ${d.error}` : ''}`;
  }
  return `${t(`dl.state.${d.state}`)} · ${bytes(d.received)}`;
}

async function renderDownloadsTray(): Promise<void> {
  const body = $('downloadsTrayBody');
  if (!body) return;
  const list = await api.invoke<DownloadInfo[]>('ui:downloads');
  for (const d of list) downloads.set(d.id, d);
  clear(body);
  if (!list.length) {
    body.append(h('p', { class: 'downloads-tray-empty', text: t('dl.empty') }));
    return;
  }
  for (const d of list) {
    const pct = d.total > 0 ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0;
    const card = h('div', { class: 'dl-card' });
    const main = h('div', { class: 'dl-card-main' });

    const iconCls = d.state === 'completed' ? 'ok' : (d.state === 'downloading' || d.state === 'scanning') ? 'active' : d.state === 'paused' ? 'paused' : '';
    const iconName = d.state === 'completed' ? 'file' : (d.state === 'failed' || d.state === 'cancelled') ? 'alert' : 'download';
    const iconBox = h('div', { class: `dl-card-icon ${iconCls}` }, icon(iconName, 16));

    const content = h('div', { class: 'dl-card-content' });
    const title = h('div', { class: 'dl-card-title', title: d.fileName, text: d.fileName });
    const meta = h('div', { class: 'dl-card-meta', text: formatDownloadMeta(d) });
    content.append(title, meta);

    if (d.state === 'downloading' || d.state === 'paused') {
      const prg = h('div', { class: 'dl-card-progress' }, h('progress', { max: '100', value: String(pct) }));
      content.append(prg);
    }

    main.append(iconBox, content);
    card.append(main);

    const acts = h('div', { class: 'dl-card-acts' });
    const act = (key: string, action: string) => {
      const b = h('button', { class: 'btn small', text: t(key) });
      b.onclick = (e) => {
        e.stopPropagation();
        void api.invoke('ui:download-action', d.id, action).then(() => {
          void renderDownloadsTray();
        });
      };
      acts.append(b);
    };

    if (d.state === 'downloading') { act('dl.pause', 'pause'); act('common.cancel', 'cancel'); }
    else if (d.state === 'paused') { if (d.canResume) act('dl.resume', 'resume'); act('common.cancel', 'cancel'); }
    else if (d.state === 'choosing-location' || d.state === 'scanning') { act('dl.changeLocation', 'change-location'); act('common.cancel', 'cancel'); }
    else if (d.state === 'completed') { act('dl.open', 'open'); act('dl.show', 'show'); }
    else if (d.state === 'failed' || d.state === 'cancelled') { act('dl.retry', 'retry'); }

    if (acts.children.length > 0) card.append(acts);

    card.onclick = () => {
      if (d.state === 'completed') {
        void api.invoke('ui:download-action', d.id, 'open');
      } else if (d.savePath) {
        void api.invoke('ui:download-action', d.id, 'show');
      }
    };

    body.append(card);
  }
}

async function renderDownloads(body: HTMLElement): Promise<void> {
  const list = await api.invoke<DownloadInfo[]>('ui:downloads');
  for (const d of list) downloads.set(d.id, d);
  if (!list.length) body.append(h('p', { class: 'muted', text: t('dl.empty') }));
  for (const d of list) {
    const pct = d.total > 0 ? Math.min(100, Math.round((d.received / d.total) * 100)) : 0;
    const transfer = [`${bytes(d.received)}${d.total ? ` / ${bytes(d.total)}` : ''}`];
    if ((d.state === 'downloading' || d.state === 'paused') && d.speedBytesPerSecond > 0) transfer.push(`${bytes(d.speedBytesPerSecond)}/s`);
    if (d.etaSeconds !== null) transfer.push(t('dl.eta', { time: duration(d.etaSeconds) }));
    const row = h('div', { class: 'dl' },
      h('b', { text: d.fileName }),
      h('div', { class: 'small muted', text: `${t(`dl.state.${d.state}`)} · ${transfer.join(' · ')}` }),
      ...(d.savePath ? [h('div', { class: 'small muted dl-location', title: d.savePath, text: `${t('dl.location')}: ${d.savePath}` })] : []),
      ...(d.url ? [h('div', { class: 'small muted dl-source', title: d.url, text: d.url })] : []));
    if (d.state === 'downloading' || d.state === 'paused') row.append(h('progress', { max: '100', value: String(pct) }));
    const acts = h('div', { class: 'row' });
    const act = (key: string, action: string) => {
      const b = h('button', { class: 'btn small', text: t(key) });
      b.onclick = () => void api.invoke('ui:download-action', d.id, action).then(() => {
        clear(body); void renderDownloads(body);
      });
      acts.append(b);
    };
    if (d.state === 'downloading') { act('dl.pause', 'pause'); act('common.cancel', 'cancel'); }
    if (d.state === 'paused') { if (d.canResume) act('dl.resume', 'resume'); act('common.cancel', 'cancel'); }
    if (d.state === 'choosing-location' || d.state === 'scanning') { act('dl.changeLocation', 'change-location'); act('common.cancel', 'cancel'); }
    if (d.state === 'completed') { act('dl.open', 'open'); act('dl.show', 'show'); }
    if (d.state === 'failed' || d.state === 'cancelled') act('dl.retry', 'retry');
    if (d.savePath) act('dl.openContainingFolder', 'open-folder');
    if (d.dangerous) row.append(h('div', { class: 'small warn', text: t('dl.dangerous') }));
    if (d.error) row.append(h('div', { class: 'small err', text: d.error }));
    row.append(acts);
    body.append(row);
  }
  const folder = h('button', { class: 'btn small', text: t('dl.openFolder') });
  folder.onclick = () => void api.invoke('ui:download-action', '', 'open-folder');
  body.append(folder);
}

async function renderBookmarks(body: HTMLElement): Promise<void> {
  const list = await api.invoke<Array<{ id: string; title: string; url: string; folder?: string }>>('ui:bookmarks');
  const hist = h('button', { class: 'btn small', text: t('panel.history') });
  hist.onclick = () => openPanel('history');
  body.append(hist);
  if (!list.length) body.append(h('p', { class: 'muted', text: t('bm.empty') }));
  for (const b of list) {
    const go = h('button', { class: 'linkish', text: b.title || b.url, title: b.url });
    go.onclick = () => openLink(b.url);
    const del = h('button', { class: 'icon-btn tiny', title: t('common.delete') }, icon('trash', 13));
    del.onclick = () => void api.invoke('ui:bookmark-remove', b.id).then(() => openPanel('bookmarks', () => void renderBookmarks($('panelBody')), t('panel.bookmarks')));
    body.append(h('div', { class: 'kv' }, go, del));
  }
}

async function renderHistory(body: HTMLElement, q: string): Promise<void> {
  const list = await api.invoke<Array<{ url: string; title: string; visitedAt: string }>>('ui:history', q);
  const search = h('input', { type: 'text', placeholder: t('hist.search'), value: q });
  let timer = 0;
  search.oninput = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { clear(body); void renderHistory(body, search.value); }, 250); };
  body.append(search);
  if (state && !list.length) body.append(h('p', { class: 'muted', text: t('hist.emptyOrOff') }));
  for (const e of list) {
    const go = h('button', { class: 'linkish', text: e.title || e.url, title: e.url });
    go.onclick = () => openLink(e.url);
    body.append(h('div', { class: 'kv' }, go, h('span', { class: 'small muted', text: new Date(e.visitedAt).toLocaleString() })));
  }
  const clr = h('button', { class: 'btn small danger', text: t('hist.clear') });
  clr.onclick = () => void api.invoke('ui:history-clear').then(() => { clear(body); void renderHistory(body, ''); });
  body.append(clr);
  if (q) requestAnimationFrame(() => { search.focus(); search.setSelectionRange(q.length, q.length); });
}

function renderUpdates(body: HTMLElement): void {
  const u = state?.update;
  if (!u || !u.configured) body.append(h('p', { class: 'note small', text: t('upd.notConfigured') }));
  body.append(kv('upd.current', u?.current ?? '-'), kv('upd.latest', u?.latest ?? t('state.unknown')));
  if (u?.available) {
    body.append(kv('upd.severity', t(`upd.sev.${u.severity ?? 'normal'}`)));
    if (u.changelog) body.append(section('upd.changelog', h('pre', { class: 'changelog', text: L(u.changelog) })));
  }
  if (u?.lastCheckAt) body.append(kv('upd.lastCheck', new Date(u.lastCheckAt).toLocaleString()));
  if (u?.error) body.append(h('p', { class: 'err small', text: u.error }));
  const check = h('button', { class: 'btn small', text: t('upd.checkNow') });
  check.onclick = () => void api.invoke('ui:updates-check').then(() => toast('upd.checking'));
  const manage = h('button', { class: 'btn small primary', text: t('upd.manage') });
  manage.onclick = () => void api.invoke('ui:open-launcher');
  body.append(h('div', { class: 'row' }, check, manage), h('p', { class: 'small muted', text: t('upd.policy') }));
}

function renderShortcuts(body: HTMLElement): void {
  for (const [keys, key] of shortcuts) body.append(h('div', { class: 'kv' }, h('span', { class: 'k', text: t(key) }), h('kbd', { text: keys })));
}

function isChromeLook(): boolean {
  return document.documentElement.dataset.chromeLook === 'on';
}

function closeChromeMenu(): void {
  chromeMenuOpen = false;
  chromeMenuTabId = 0;
  const menu = $('chromeMenu');
  menu.classList.add('hidden');
  // Return the shared element to the browser-menu placement for its next use.
  menu.classList.remove('tab-menu');
  menu.removeAttribute('style');
  menu.setAttribute('aria-label', 'Browser menu');
  document.body.classList.remove('menu-open');
  syncChromeFront();
  requestAnimationFrame(reportLayout);
}

/** One row of the shared dropdown: label, optional shortcut hint, and its action. */
function chromeMenuItem(label: string, run: () => void, opts: { shortcut?: string; disabled?: boolean; keepOpen?: boolean } = {}): HTMLButtonElement {
  const b = h('button', { class: 'chrome-menu-item', role: 'menuitem', disabled: opts.disabled }, h('span', { text: label }));
  if (opts.shortcut) b.append(h('kbd', { text: opts.shortcut }));
  b.onclick = () => {
    if (!opts.keepOpen) closeChromeMenu();
    run();
  };
  return b;
}

/** Compact overflow menu shared by every presentation shell. */
function renderChromeMenu(): void {
  const menu = $('chromeMenu');
  clear(menu);
  const item = (label: string, run: () => void, shortcut?: string) => menu.append(chromeMenuItem(label, run, { shortcut }));
  const divider = () => menu.append(h('div', { class: 'chrome-menu-divider', role: 'separator' }));

  item(t('ui.newTab'), () => void api.invoke('ui:new-tab'), 'Ctrl+T');
  item(t('menu.newWindow'), () => void api.invoke('ui:new-window'), 'Ctrl+N');
  item(t('menu.newPrivateWindow'), () => void api.invoke('ui:private-browse'), 'Ctrl+Shift+N');
  divider();
  item(t('panel.bookmarks'), () => openPanel('bookmarks'));
  item(t('panel.history'), () => openPanel('history'));
  item(t('panel.downloads'), () => openPanel('downloads'), 'Ctrl+J');
  item(t('panel.addons'), () => openPanel('addons'));
  item(t('ui.searchTabs'), openTabSearch, 'Ctrl+Shift+A');
  divider();

  const zoom = h('div', { class: 'chrome-menu-zoom' }, h('span', { text: t('menu.zoom') }));
  const minus = h('button', { title: t('menu.zoomOut'), text: '−' });
  const reset = h('button', { class: 'zoom-value', text: `${activeTab()?.zoom ?? 100}%` });
  const plus = h('button', { title: t('menu.zoomIn'), text: '+' });
  minus.onclick = () => { void api.invoke('ui:command', 'zoom-out'); renderChromeMenu(); };
  reset.onclick = () => { void api.invoke('ui:command', 'zoom-reset'); renderChromeMenu(); };
  plus.onclick = () => { void api.invoke('ui:command', 'zoom-in'); renderChromeMenu(); };
  zoom.append(minus, reset, plus);
  menu.append(zoom);
  divider();
  item(t('ui.find'), openFind, 'Ctrl+F');
  item(t('menu.print'), () => void api.invoke('ui:command', 'print'), 'Ctrl+P');
  item(t('menu.pip'), () => void api.invoke('ui:command', 'pip'));
  item(t('menu.split'), () => void api.invoke('ui:command', 'split'));
  item(state?.verticalTabs ? t('menu.horizontalTabs') : t('menu.verticalTabs'), () => void api.invoke('ui:settings-set', { verticalTabs: !state?.verticalTabs }));
  item(state?.showBookmarksBar ? t('menu.hideBookmarksBar') : t('menu.showBookmarksBar'), () => void api.invoke('ui:settings-set', { showBookmarksBar: !state?.showBookmarksBar }));
  divider();
  item(t('pw.title'), openPasswordsPopout);
  item(t('media.captureInputs'), () => openPanel('media'));
  item(t('panel.shortcuts'), () => openPanel('shortcuts'));
  item(t('menu.settings'), () => openPanel('settings'));
  item(t('close.confirm'), () => void api.invoke('ui:close-window'));
}

function toggleChromeMenu(): void {
  if (shuttingDown) return;
  if (chromeMenuOpen) { closeChromeMenu(); return; }
  // Pop out as a floating popup over the site without squeezing the web content
  if (downloadsTrayOpen) closeDownloadsTray();
  if (passwordsPopoutOpen) closePasswordsPopout();
  if (panel) openPanel(null);
  renderChromeMenu();
  chromeMenuOpen = true;
  document.body.classList.add('menu-open');
  $('chromeMenu').classList.remove('hidden');
  void api.invoke('ui:popup', true);
  requestAnimationFrame(reportLayout);
}

function closePageInfo(): void {
  pageInfoOpen = false;
  pageInfoView = 'root';
  $('pageInfo').classList.add('hidden');
  clear($('pageInfo'));
  syncChromeFront();
  requestAnimationFrame(reportLayout);
}

function closeTranslateBar(): void {
  translateOpen = false;
  $('translateBar').classList.add('hidden');
  syncChromeFront();
  requestAnimationFrame(reportLayout);
}

interface PageInfoData {
  url: string; origin: string; host: string; secure: boolean; cookies: number;
  permissions: Record<string, 'allow' | 'block' | 'ask'>; usageLabel: string;
}

function pageInfoRow(ic: string, label: string, extra?: string, onClick?: () => void, trailing?: 'chevron' | 'external'): HTMLElement {
  const row = h('button', { class: 'pi-row', type: 'button' });
  row.append(icon(ic, 16), h('span', { class: 'pi-row-text' }, h('b', { text: label }), extra ? h('small', { text: extra }) : ''));
  if (trailing === 'external') row.append(icon('externalLink', 14));
  else if (trailing === 'chevron') row.append(icon('forward', 14));
  if (onClick) row.onclick = onClick;
  else row.disabled = true;
  return row;
}

async function renderPageInfo(): Promise<void> {
  const root = $('pageInfo');
  clear(root);
  const info = await api.invoke<PageInfoData>('ui:page-info').catch(() => null);
  const host = info?.host || t('ui.sec.internal');
  const close = h('button', { class: 'pi-close', type: 'button', title: t('common.dismiss'), 'aria-label': t('common.dismiss') });
  close.append(icon('close', 14));
  close.onclick = () => closePageInfo();
  const back = h('button', { class: 'pi-back', type: 'button', title: t('common.back') });
  back.append(icon('back', 16));
  back.onclick = () => { pageInfoView = 'root'; void renderPageInfo(); };

  if (pageInfoView === 'root') {
    root.append(
      h('div', { class: 'pi-head' }, h('strong', { text: host }), close),
      pageInfoRow('lock', info?.secure ? t('pi.secure') : t('pi.insecure'), undefined, () => { pageInfoView = 'security'; void renderPageInfo(); }, 'chevron'),
      pageInfoRow('box', t('pi.cookies'), undefined, () => { pageInfoView = 'cookies'; void renderPageInfo(); }, 'chevron'),
      pageInfoRow('settings', t('pi.siteSettings'), undefined, () => { pageInfoView = 'settings'; void renderPageInfo(); }, 'external'),
    );
    return;
  }

  const title = pageInfoView === 'security' ? t('pi.security') : pageInfoView === 'cookies' ? t('pi.cookies') : t('pi.siteSettings');
  root.append(h('div', { class: 'pi-head nested' }, back, h('div', { class: 'pi-titles' }, h('strong', { text: title }), h('span', { text: host })), close));

  if (pageInfoView === 'security') {
    root.append(
      h('div', { class: 'pi-block' },
        icon('lock', 18),
        h('div', {},
          h('b', { text: info?.secure ? t('pi.secure') : t('pi.insecure') }),
          h('p', { class: 'pi-copy', text: info?.secure ? t('pi.secureHint') : t('pi.insecureHint') }),
        ),
      ),
      pageInfoRow('check', t('pi.certValid'), undefined, undefined, 'external'),
    );
  } else if (pageInfoView === 'cookies') {
    root.append(
      h('p', { class: 'pi-copy pad', text: t('pi.cookiesHint') }),
      pageInfoRow('box', t('pi.manageData'), t('pi.sitesAllowed', { n: String(info?.cookies ?? 0) }), () => { pageInfoView = 'settings'; void renderPageInfo(); }, 'external'),
    );
  } else {
    const usage = h('div', { class: 'pi-settings-usage' },
      h('div', {}, h('span', { class: 'muted', text: t('pi.usage') }), h('div', { text: t('pi.usageBytes', { n: info?.usageLabel ?? '0' }) })),
      h('button', { class: 'pi-outline', text: t('pi.deleteData') }),
    );
    (usage.lastElementChild as HTMLButtonElement).onclick = async () => {
      await api.invoke('ui:clear-origin-data');
      toast('pi.dataCleared');
      void renderPageInfo();
    };
    const reset = h('button', { class: 'pi-outline', text: t('pi.resetPermissions') });
    reset.onclick = async () => { await api.invoke('ui:reset-origin-permissions'); void renderPageInfo(); };
    root.append(usage, h('div', { class: 'pi-perm-head' }, h('span', { text: t('pi.permissions') }), reset));
    const kinds: Array<[string, string]> = [
      ['geolocation', 'pin'], ['camera', 'camera'], ['microphone', 'volume'],
      ['notifications', 'mail'], ['clipboard-read', 'copy'], ['devices', 'cpu'],
    ];
    for (const [kind, ic] of kinds) {
      const row = h('div', { class: 'pi-perm' }, icon(ic, 16), h('span', { text: t(`pi.perm.${kind}`) }));
      const sel = h('select', { class: 'pi-select' }) as HTMLSelectElement;
      for (const v of ['ask', 'allow', 'block'] as const) {
        const opt = h('option', { value: v, text: t(`pi.state.${v}`) }) as HTMLOptionElement;
        if ((info?.permissions[kind] ?? 'ask') === v) opt.selected = true;
        sel.append(opt);
      }
      sel.onchange = () => void api.invoke('ui:set-origin-permission', kind, sel.value);
      row.append(sel);
      root.append(row);
    }
  }
}

async function togglePageInfo(): Promise<void> {
  if (shuttingDown) return;
  if (pageInfoOpen) { closePageInfo(); return; }
  if (chromeMenuOpen) closeChromeMenu();
  if (downloadsTrayOpen) closeDownloadsTray();
  if (passwordsPopoutOpen) closePasswordsPopout();
  if (translateOpen) closeTranslateBar();
  if (panel) openPanel(null);
  pageInfoOpen = true;
  pageInfoView = 'root';
  $('pageInfo').classList.remove('hidden');
  void api.invoke('ui:popup', true);
  await renderPageInfo();
  requestAnimationFrame(reportLayout);
}

const TRANSLATE_LANGS: Array<[string, string]> = [
  ['pl', 'Polish'], ['en', 'English'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['uk', 'Ukrainian'],
];

function playLanguageSwitch(): void {
  const bar = $('translateBar');
  bar.classList.remove('tr-switching');
  void bar.offsetWidth;
  bar.classList.add('tr-switching');
  window.setTimeout(() => bar.classList.remove('tr-switching'), 420);
}

async function applyTranslate(code: string): Promise<void> {
  playLanguageSwitch();
  const r = await api.invoke<{ ok: boolean; error?: string }>('ui:translate-page', code);
  if (!r?.ok) toast('tr.failed');
}

function renderTranslateBar(): void {
  const bar = $('translateBar');
  clear(bar);
  const uiLang = getLang() === 'pl' ? 'pl' : 'en';
  let selected = uiLang;
  let moreOpen = false;
  const close = h('button', { class: 'tr-icon', type: 'button', title: t('common.dismiss') });
  close.append(icon('close', 14));
  close.onclick = () => closeTranslateBar();
  const more = h('button', { class: 'tr-icon', type: 'button', title: t('tr.more') });
  more.append(icon('dots', 14));
  const langs = h('div', { class: 'tr-langs' });
  const extraWrap = h('div', { class: 'tr-more hidden' });
  const paint = () => {
    clear(langs);
    for (const [code, label] of TRANSLATE_LANGS.slice(0, 2)) {
      const b = h('button', { class: `tr-lang${code === selected ? ' active' : ''}`, text: t(`tr.lang.${code}`) || label });
      b.onclick = () => { selected = code; moreOpen = false; extraWrap.classList.add('hidden'); paint(); void applyTranslate(code); };
      langs.append(b);
    }
  };
  paint();
  for (const [code, label] of TRANSLATE_LANGS.slice(2)) {
    const b = h('button', { class: 'tr-lang', text: label });
    b.onclick = () => { selected = code; moreOpen = false; extraWrap.classList.add('hidden'); paint(); void applyTranslate(code); };
    extraWrap.append(b);
  }
  const showOrig = h('button', { class: 'tr-lang', text: t('tr.showOriginal') });
  showOrig.onclick = () => { moreOpen = false; extraWrap.classList.add('hidden'); playLanguageSwitch(); void api.invoke('ui:translate-restore'); };
  extraWrap.append(showOrig);
  more.onclick = () => {
    moreOpen = !moreOpen;
    extraWrap.classList.toggle('hidden', !moreOpen);
  };
  bar.append(h('div', { class: 'tr-row' }, langs, more, close), h('div', { class: 'tr-caption', text: t('tr.caption') }), extraWrap);
}

function toggleTranslateBar(): void {
  if (shuttingDown) return;
  if (translateOpen) { closeTranslateBar(); return; }
  if (chromeMenuOpen) closeChromeMenu();
  if (pageInfoOpen) closePageInfo();
  translateOpen = true;
  renderTranslateBar();
  $('translateBar').classList.remove('hidden');
  void api.invoke('ui:popup', true);
  requestAnimationFrame(reportLayout);
}

// ------------------------------------------------------- passwords popout & settings

interface SavedLogin { id: string; origin: string; username: string; updatedAt: string; timesUsed: number }

let passwordsPopoutOpen = false;
let selectedPasswordId: string | null = null;
let passwordSearchQuery = '';
let passwordActiveTab: 'all' | 'recent' = 'all';
let isEditingPassword = false;
let isAddingPassword = false;

function openPasswordsPopout(): void {
  if (shuttingDown) return;
  if (chromeMenuOpen) closeChromeMenu();
  if (downloadsTrayOpen) closeDownloadsTray();
  if (panel) openPanel(null);
  passwordsPopoutOpen = true;
  isEditingPassword = false;
  isAddingPassword = false;
  $('passwordsPopout').classList.remove('hidden');
  void api.invoke('ui:popup', true);
  void renderPasswordsPopout();
  requestAnimationFrame(reportLayout);
}

function closePasswordsPopout(): void {
  passwordsPopoutOpen = false;
  isEditingPassword = false;
  isAddingPassword = false;
  $('passwordsPopout').classList.add('hidden');
  syncChromeFront();
  requestAnimationFrame(reportLayout);
}

function togglePasswordsPopout(): void {
  if (passwordsPopoutOpen) closePasswordsPopout();
  else openPasswordsPopout();
}

function passwordOriginClean(origin: string): string {
  try { return new URL(origin).hostname.replace(/^www\./i, ''); }
  catch { return origin.replace(/^https?:\/\//i, '').split('/')[0] || origin; }
}

/**
 * The site's avatar: a neutral tile with the first letter of the host, the short
 * mark of a few well-known sites, or the Apple mark. No brand colours, so the
 * list stays matte.
 */
function passwordAvatar(host: string, cls: string): HTMLElement {
  const lowerHost = host.toLowerCase();
  if (lowerHost.includes('google')) return h('span', { class: cls, text: 'G' });
  if (lowerHost.includes('github')) return h('span', { class: cls, text: 'GH' });
  if (lowerHost.includes('apple')) return h('span', { class: cls }, icon('apple', 16));
  const letter = (host.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toLocaleUpperCase();
  return h('span', { class: cls, text: letter });
}

/**
 * Counts only: how many logins there are, how many sites they cover and how many
 * were changed in the last seven days. Nothing here judges the passwords themselves.
 */
function renderPasswordsStats(all: SavedLogin[]): void {
  const strip = $('pwStats');
  if (!strip) return;
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const sites = new Set(all.map((item) => passwordOriginClean(item.origin))).size;
  const updated = all.filter((item) => new Date(item.updatedAt).getTime() >= weekAgo).length;
  const tile = (value: number, labelKey: string) =>
    h('div', { class: 'pw-stat' }, h('b', { text: String(value) }), h('span', { text: t(labelKey) }));
  clear(strip);
  strip.append(tile(all.length, 'pw.stats.items'), tile(sites, 'pw.stats.sites'), tile(updated, 'pw.stats.updatedWeek'));
}

async function renderPasswordsPopout(): Promise<void> {
  const listCol = $('pwListCol');
  const detailCol = $('pwDetailCol');
  if (!listCol || !detailCol) return;

  const allList = (await api.invoke<SavedLogin[]>('ui:passwords')) ?? [];
  const countSpan = $('pwCount');
  if (countSpan) countSpan.textContent = String(allList.length);
  renderPasswordsStats(allList);

  const query = passwordSearchQuery.toLowerCase();
  let list = allList.filter((item) => !query || item.origin.toLowerCase().includes(query) || item.username.toLowerCase().includes(query));

  if (passwordActiveTab === 'recent') {
    list = [...list].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  } else {
    list = [...list].sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
  }

  if (!isAddingPassword) {
    if (!selectedPasswordId || !list.some((item) => item.id === selectedPasswordId)) {
      selectedPasswordId = list[0]?.id ?? null;
    }
  }

  clear(listCol);
  if (!list.length && !isAddingPassword) {
    listCol.append(h('p', { class: 'pw-empty-state', text: t(allList.length ? 'pw.noMatches' : 'pw.empty') }));
  } else {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    const oneWeek = 7 * oneDay;

    const todayItems: SavedLogin[] = [];
    const weekItems: SavedLogin[] = [];
    const earlierItems: SavedLogin[] = [];

    for (const item of list) {
      const elapsed = now - new Date(item.updatedAt).getTime();
      if (elapsed < oneDay) todayItems.push(item);
      else if (elapsed < oneWeek) weekItems.push(item);
      else earlierItems.push(item);
    }

    const renderGroup = (groupTitleKey: string, items: SavedLogin[]) => {
      if (!items.length) return;
      listCol.append(h('div', { class: 'pw-group-title', text: t(groupTitleKey) }));
      for (const item of items) {
        const host = passwordOriginClean(item.origin);
        const card = h('button', { class: `pw-item-card ${item.id === selectedPasswordId && !isAddingPassword ? 'active' : ''}` });
        
        const iconContent = passwordAvatar(host, 'pw-item-icon');

        const textCol = h('div', { class: 'pw-item-text' },
          h('span', { class: 'pw-item-user', text: item.username || t('pw.noUsername') }),
          h('span', { class: 'pw-item-site', text: host })
        );

        card.append(iconContent, textCol);
        card.onclick = () => {
          selectedPasswordId = item.id;
          isAddingPassword = false;
          isEditingPassword = false;
          void renderPasswordsPopout();
        };
        listCol.append(card);
      }
    };

    if (passwordActiveTab === 'recent') {
      renderGroup('pw.todayGroup', todayItems);
      renderGroup('pw.lastWeekGroup', weekItems);
      renderGroup('pw.earlierGroup', earlierItems);
    } else {
      renderGroup('pw.allItems', list);
    }
  }

  const selectedItem = allList.find((item) => item.id === selectedPasswordId);
  renderPasswordsDetail(detailCol, selectedItem);
}

/**
 * The password field of the add and edit forms: show/hide, a generator that fills in
 * a random 20-character password, and a live strength meter. Nothing is stored here;
 * the meter only reads the text in the field.
 */
function passwordFieldBox(passInput: HTMLInputElement): HTMLElement {
  const passToggle = h('button', { class: 'pw-icon-btn small', type: 'button' });
  const setVisible = (visible: boolean) => {
    passInput.type = visible ? 'text' : 'password';
    clear(passToggle);
    passToggle.append(icon(visible ? 'eyeOff' : 'eye', 14));
    passToggle.title = t(visible ? 'pw.hide' : 'pw.show');
    passToggle.setAttribute('aria-label', passToggle.title);
  };
  setVisible(false);
  passToggle.onclick = () => setVisible(passInput.type === 'password');

  const genBtn = h('button', { class: 'pw-icon-btn small', type: 'button', title: t('pw.generate'), 'aria-label': t('pw.generate') }, icon('wand', 14));
  genBtn.onclick = () => {
    passInput.value = generatePassword({ length: 20 });
    setVisible(true); // show the new value so it can be read and copied
    refresh();
  };

  const bars = [0, 1, 2, 3].map(() => h('span', { class: 'pw-strength-bar' }));
  const label = h('span', { class: 'pw-strength-label' });
  const meter = h('div', { class: 'pw-strength' }, h('span', { class: 'pw-strength-bars' }, ...bars), label);
  const levelKeys = ['pw.strength.weak', 'pw.strength.fair', 'pw.strength.good', 'pw.strength.strong'] as const;
  const refresh = () => {
    if (!passInput.value) {
      delete meter.dataset.level;
      label.textContent = '';
      return;
    }
    const { level } = passwordStrength(passInput.value);
    meter.dataset.level = String(level);
    label.textContent = t(levelKeys[level]);
  };
  passInput.addEventListener('input', refresh);
  refresh();

  return h('div', { class: 'pw-detail-field-box' },
    h('div', { class: 'pw-field-row' },
      h('div', { class: 'pw-field-label-wrap' }, icon('key', 14), h('span', { text: t('pw.password') })),
      h('div', { class: 'pw-field-actions' }, genBtn, passToggle)
    ),
    passInput,
    meter
  );
}

function renderPasswordsDetail(detailCol: HTMLElement, item?: SavedLogin): void {
  clear(detailCol);

  if (isAddingPassword) {
    const head = h('div', { class: 'pw-detail-head' },
      h('h3', { class: 'pw-detail-title', text: t('pw.addItem') })
    );

    const siteInput = h('input', { class: 'pw-field-input', type: 'text', placeholder: t('pw.originPh'), value: activeTab()?.url && !activeTab()?.url.startsWith('octo:') ? passwordOriginClean(activeTab()!.url) : '' }) as HTMLInputElement;
    const userInput = h('input', { class: 'pw-field-input', type: 'text', placeholder: t('pw.usernamePh') }) as HTMLInputElement;
    const passInput = h('input', { class: 'pw-field-input', type: 'password', placeholder: t('pw.passwordPh') }) as HTMLInputElement;
    

    const siteBox = h('div', { class: 'pw-detail-field-box' },
      h('div', { class: 'pw-field-label-wrap' }, icon('globe', 14), h('span', { text: t('pw.websites') })),
      siteInput
    );
    const userBox = h('div', { class: 'pw-detail-field-box' },
      h('div', { class: 'pw-field-label-wrap' }, icon('mail', 14), h('span', { text: t('pw.username') })),
      userInput
    );
    const passBox = passwordFieldBox(passInput);

    const saveBtn = h('button', { class: 'btn primary small', text: t('pw.save') });
    const cancelBtn = h('button', { class: 'btn small', text: t('pw.cancel') });

    saveBtn.onclick = async () => {
      let rawSite = siteInput.value.trim();
      if (!rawSite) { toast('err.generic'); return; }
      if (!rawSite.startsWith('http://') && !rawSite.startsWith('https://')) rawSite = `https://${rawSite}`;
      const user = userInput.value.trim();
      const pass = passInput.value;
      if (!pass) { toast('err.generic'); return; }
      await api.invoke('ui:password-add', { origin: rawSite, username: user, password: pass });
      isAddingPassword = false;
      toast('toast.saved');
      void renderPasswordsPopout();
    };

    cancelBtn.onclick = () => {
      isAddingPassword = false;
      void renderPasswordsPopout();
    };

    const actRow = h('div', { class: 'pw-edit-actions' }, saveBtn, cancelBtn);
    detailCol.append(head, siteBox, userBox, passBox, actRow);
    return;
  }

  if (!item) {
    const addBtn = h('button', { class: 'btn primary small', text: t('pw.addItem') });
    addBtn.onclick = () => { isAddingPassword = true; renderPasswordsDetail(detailCol); };
    const emptyBox = h('div', { class: 'pw-empty-state' },
      icon('key', 36),
      h('b', { text: t('pw.empty') }),
      addBtn
    );
    detailCol.append(emptyBox);
    return;
  }

  const host = passwordOriginClean(item.origin);

  if (isEditingPassword) {
    const head = h('div', { class: 'pw-detail-head' },
      h('h3', { class: 'pw-detail-title', text: `${t('pw.edit')} — ${host}` })
    );

    const siteInput = h('input', { class: 'pw-field-input', type: 'text', value: item.origin }) as HTMLInputElement;
    const userInput = h('input', { class: 'pw-field-input', type: 'text', value: item.username }) as HTMLInputElement;
    const passInput = h('input', { class: 'pw-field-input', type: 'password', placeholder: t('pw.password') }) as HTMLInputElement;
    
    void api.invoke<string>('ui:password-reveal', item.id).then((pwd) => {
      if (pwd) {
        passInput.value = pwd;
        passInput.dispatchEvent(new Event('input'));
      }
    });


    const siteBox = h('div', { class: 'pw-detail-field-box' },
      h('div', { class: 'pw-field-label-wrap' }, icon('globe', 14), h('span', { text: t('pw.websites') })),
      siteInput
    );
    const userBox = h('div', { class: 'pw-detail-field-box' },
      h('div', { class: 'pw-field-label-wrap' }, icon('mail', 14), h('span', { text: t('pw.username') })),
      userInput
    );
    const passBox = passwordFieldBox(passInput);

    const saveBtn = h('button', { class: 'btn primary small', text: t('pw.saveChanges') });
    const cancelBtn = h('button', { class: 'btn small', text: t('pw.cancel') });

    saveBtn.onclick = async () => {
      let rawSite = siteInput.value.trim();
      if (!rawSite) { toast('err.generic'); return; }
      if (!rawSite.startsWith('http://') && !rawSite.startsWith('https://')) rawSite = `https://${rawSite}`;
      const user = userInput.value.trim();
      const pass = passInput.value;
      if (!pass) { toast('err.generic'); return; }
      if (rawSite !== item.origin || user !== item.username) {
        await api.invoke('ui:password-remove', item.id);
      }
      await api.invoke('ui:password-add', { origin: rawSite, username: user, password: pass });
      isEditingPassword = false;
      toast('toast.saved');
      void renderPasswordsPopout();
    };

    cancelBtn.onclick = () => {
      isEditingPassword = false;
      renderPasswordsDetail(detailCol, item);
    };

    const actRow = h('div', { class: 'pw-edit-actions' }, saveBtn, cancelBtn);
    detailCol.append(head, siteBox, userBox, passBox, actRow);
    return;
  }

  // View mode
  const head = h('div', { class: 'pw-detail-head' });
  const title = h('h3', { class: 'pw-detail-title', title: host, text: host });
  const editBtn = h('button', { class: 'btn small', text: t('pw.edit') });
  editBtn.prepend(icon('edit', 14));
  editBtn.onclick = () => {
    isEditingPassword = true;
    renderPasswordsDetail(detailCol, item);
  };

  const delBtn = h('button', { class: 'pw-icon-btn small', title: t('pw.remove'), 'aria-label': t('pw.remove') });
  delBtn.append(icon('trash', 14));
  delBtn.onclick = async () => {
    if (!window.confirm(t('pw.removeConfirm', { origin: item.origin }))) return;
    await api.invoke('ui:password-remove', item.id);
    selectedPasswordId = null;
    void renderPasswordsPopout();
  };

  const headActs = h('div', { class: 'pw-detail-acts' }, editBtn, delBtn);
  // The hero: the site's avatar, its name and the account under it, with the actions beside.
  head.append(
    passwordAvatar(host, 'pw-hero-avatar'),
    h('div', { class: 'pw-hero-text' }, title, h('span', { class: 'pw-hero-sub', text: item.username || t('pw.noUsername') })),
    headActs);

  // Email / Username Box
  const copyUser = h('button', { class: 'pw-icon-btn small', title: t('pw.copy'), 'aria-label': t('pw.copy') });
  copyUser.append(icon('copy', 14));
  copyUser.onclick = async () => {
    if (item.username) {
      await navigator.clipboard.writeText(item.username);
      toast('pw.copied');
    }
  };

  const userBox = h('div', { class: 'pw-detail-field-box' },
    h('div', { class: 'pw-field-row' },
      h('div', { class: 'pw-field-label-wrap' }, icon('mail', 14), h('span', { text: t('pw.username') })),
      copyUser
    ),
    h('span', { class: 'pw-field-value', text: item.username || t('pw.noUsername') })
  );

  // Password Box
  const passValueSpan = h('span', { class: 'pw-field-value mono', text: '••••••••••••' });
  let revealed = false;

  const revealBtn = h('button', { class: 'pw-icon-btn small', title: t('pw.show'), 'aria-label': t('pw.show') });
  revealBtn.append(icon('eye', 14));
  revealBtn.onclick = async () => {
    if (revealed) {
      passValueSpan.textContent = '••••••••••••';
      revealed = false;
      clear(revealBtn);
      revealBtn.append(icon('eye', 14));
      revealBtn.title = t('pw.show');
      return;
    }
    const secret = await api.invoke<string>('ui:password-reveal', item.id);
    if (!secret) { toast('pw.revealFailed'); return; }
    passValueSpan.textContent = secret;
    revealed = true;
    clear(revealBtn);
    revealBtn.append(icon('eyeOff', 14));
    revealBtn.title = t('pw.hide');
  };

  const copyPass = h('button', { class: 'pw-icon-btn small', title: t('pw.copy'), 'aria-label': t('pw.copy') });
  copyPass.append(icon('copy', 14));
  copyPass.onclick = async () => {
    const secret = await api.invoke<string>('ui:password-reveal', item.id);
    if (secret) {
      await navigator.clipboard.writeText(secret);
      toast('pw.copied');
    }
  };

  const shieldBadge = h('span', { class: 'pw-icon-btn small pw-protected', title: t('pw.protected') });
  shieldBadge.append(icon('shieldCheck', 14));

  const passBox = h('div', { class: 'pw-detail-field-box' },
    h('div', { class: 'pw-field-row' },
      h('div', { class: 'pw-field-label-wrap' }, icon('key', 14), h('span', { text: t('pw.password') })),
      h('div', { class: 'pw-field-acts' }, shieldBadge, revealBtn, copyPass)
    ),
    passValueSpan
  );

  // Websites Box
  const openLinkBtn = h('button', { class: 'pw-icon-btn small', title: t('ctx.openLinkNewTab'), 'aria-label': t('ctx.openLinkNewTab') });
  openLinkBtn.append(icon('externalLink', 14));
  openLinkBtn.onclick = () => {
    void api.invoke('ui:new-tab', item.origin);
    closePasswordsPopout();
  };

  const siteBox = h('div', { class: 'pw-detail-field-box' },
    h('div', { class: 'pw-field-row' },
      h('div', { class: 'pw-field-label-wrap' }, icon('globe', 14), h('span', { text: t('pw.websites') })),
      openLinkBtn
    ),
    h('span', { class: 'pw-field-value', text: item.origin })
  );

  // Meta info
  const autofillMeta = h('div', { class: 'pw-meta-box' },
    h('span', { class: 'pw-meta-icon' }, icon('wand', 14)),
    h('span', { text: `${t('pw.lastAutofill')} · ${t('pw.used', { n: item.timesUsed })}` })
  );

  const modifiedMeta = h('div', { class: 'pw-meta-box' },
    h('span', { class: 'pw-meta-icon' }, icon('edit', 14)),
    h('span', { text: `${t('pw.lastModified')} · ${new Date(item.updatedAt).toLocaleDateString()}` })
  );

  detailCol.append(head, userBox, passBox, siteBox, h('div', { class: 'pw-meta-grid' }, autofillMeta, modifiedMeta));
}

/**
 * Saved logins of this profile. The layout follows the shell the profile was
 * created with, so a Chrome-style profile gets the familiar Chrome list and a
 * Firefox-style profile the Firefox two-column look; the data is identical.
 */
async function renderPasswords(body: HTMLElement): Promise<void> {
  const shell = state?.profile.browserShell === 'firefox' ? 'firefox' : state?.profile.browserShell === 'safari' ? 'safari' : 'chrome';
  body.classList.add('pw-panel');
  body.dataset.shell = shell;
  const list = (await api.invoke<SavedLogin[]>('ui:passwords')) ?? [];
  let saving = (await api.invoke<WindowSettings>('ui:settings-get'))?.profile.savePasswords !== false;
  const info = h('p', { class: 'muted small', text: t(saving ? 'pw.hint' : 'pw.offHint') });
  const savingToggle = h('input', { type: 'checkbox' }) as HTMLInputElement;
  savingToggle.checked = saving;
  const savingState = h('span', { class: 'muted small', text: t(saving ? 'ui.on' : 'ui.off') });
  savingToggle.onchange = () => {
    saving = savingToggle.checked;
    savingState.textContent = t(saving ? 'ui.on' : 'ui.off');
    info.textContent = t(saving ? 'pw.hint' : 'pw.offHint');
    void api.invoke('ui:profile-set', { savePasswords: saving });
    toast('toast.saved');
  };
  const savingControl = h('label', { class: 'set-row password-saving-toggle' }, savingToggle, h('span', { text: t('profile.savePasswords') }), savingState);
  const search = h('input', { class: 'pw-search', type: 'search', placeholder: t('pw.search'), spellcheck: 'false' }) as HTMLInputElement;
  const rows = h('div', { class: 'pw-list' });

  const draw = () => {
    clear(rows);
    const needle = search.value.trim().toLowerCase();
    const shown = list.filter((item) => !needle || item.origin.toLowerCase().includes(needle) || item.username.toLowerCase().includes(needle));
    if (!shown.length) { rows.append(h('p', { class: 'muted', text: t(list.length ? 'pw.noMatches' : 'pw.empty') })); return; }
    for (const item of shown) {
      const value = h('input', { class: 'pw-value mono', type: 'password', value: '••••••••', readonly: 'readonly' }) as HTMLInputElement;
      const reveal = h('button', { class: 'btn small', text: t('pw.show') });
      reveal.onclick = async () => {
        if (value.type === 'text') { value.type = 'password'; value.value = '••••••••'; reveal.textContent = t('pw.show'); return; }
        const secret = await api.invoke<string>('ui:password-reveal', item.id);
        if (!secret) { toast('pw.revealFailed'); return; }
        value.type = 'text';
        value.value = secret;
        reveal.textContent = t('pw.hide');
      };
      const copy = h('button', { class: 'btn small', text: t('pw.copy') });
      copy.onclick = async () => {
        const secret = await api.invoke<string>('ui:password-reveal', item.id);
        if (secret) { await navigator.clipboard.writeText(secret); toast('pw.copied'); }
      };
      const del = h('button', { class: 'btn small danger', text: t('pw.remove') });
      del.onclick = async () => {
        if (!window.confirm(t('pw.removeConfirm', { origin: item.origin }))) return;
        await api.invoke('ui:password-remove', item.id);
        const index = list.findIndex((entry) => entry.id === item.id);
        if (index >= 0) list.splice(index, 1);
        draw();
      };
      rows.append(h('div', { class: 'pw-row' },
        h('div', { class: 'pw-site' }, h('b', { text: item.origin.replace(/^https?:\/\//, '') }), h('span', { class: 'muted small', text: item.username || t('pw.noUsername') })),
        h('div', { class: 'pw-secret' }, value, reveal, copy, del),
        h('div', { class: 'muted small', text: `${t('pw.updated')}: ${new Date(item.updatedAt).toLocaleDateString()} · ${t('pw.used', { n: item.timesUsed })}` })));
    }
  };
  search.oninput = draw;
  body.append(savingControl, info, search, rows);
  draw();
}

interface WindowSettings {
  app: {

    verticalTabs: boolean; showBookmarksBar: boolean; hideDirectoryPaths?: boolean; virtualBoxMode?: boolean; openLinksInBackground: boolean; animations: boolean; confirmOnQuit: boolean; closeCountdown: boolean;

    sleepTabsAfterMin: number; searchEngine: string; searchEngines: string[]; autoRefresh: boolean; offline: boolean;
  };
  profile: {
    name: string; theme: string; browserShell: string; homePage: string; searchEngine?: string; savePasswords: boolean;
    keepHistory: boolean; restoreSession: boolean; level: string; cameraAllowed: boolean; microphoneAllowed: boolean;
    mediaCapture: { cameraLabel: string; microphoneLabel: string };
    downloads: { askWhereToSave: boolean; defaultDirectory: string; lastDirectory: string };
    sandboxDownloadsShared: boolean;
  };
}

async function browserMediaSettings(data: WindowSettings, autoScan = false): Promise<HTMLElement> {
  const camera = h('select', { class: 'set-select', 'aria-label': t('media.activeCamera') }) as HTMLSelectElement;
  const microphone = h('select', { class: 'set-select', 'aria-label': t('media.activeMicrophone') }) as HTMLSelectElement;
  const video = h('video', { class: 'settings-camera-preview', autoplay: '', muted: '', playsinline: '' }) as HTMLVideoElement;
  video.muted = true;
  const monitor = h('audio', { autoplay: '' }) as HTMLAudioElement;
  const meter = h('progress', { class: 'media-meter', max: '100', value: '0', 'aria-label': t('media.activeMicrophone') }) as HTMLProgressElement;
  monitor.muted = true;
  let stream: MediaStream | undefined;
  let audioContext: AudioContext | undefined;
  let meterFrame = 0;
  let workingCameras = new Map<string, string>();
  let workingMicrophones = new Map<string, string>();
  let listen!: HTMLButtonElement;
  const stop = (): boolean => {
    const released = stream?.getTracks().some((track) => track.readyState === 'live') === true;
    stream?.getTracks().forEach((track) => track.stop()); stream = undefined; video.srcObject = null; video.classList.remove('previewing'); monitor.srcObject = null; monitor.muted = true;
    cancelAnimationFrame(meterFrame); meter.value = 0; void audioContext?.close(); audioContext = undefined;
    listen.disabled = true; listen.textContent = t('media.listenMicrophone');
    // Keep this release callback registered after Scan/Test calls `stop()`.
    // Previously those calls cleared the callback before opening the new
    // stream, so a website request could not release the trusted preview and
    // exclusive Windows camera drivers returned NotReadableError.
    return released;
  };
  // A page capture request must be able to release this trusted-UI preview
  // first. Many Windows phone/virtual camera drivers allow only one reader;
  // leaving this preview open was the direct cause of websites reporting
  // NotReadableError while the side panel visibly showed the same camera.
  stopChromeMediaPreview?.();
  stopChromeMediaPreview = stop;
  const initialScanKey = autoScan ? 'media.scanningActive' : 'media.pressRefresh';
  const scanStatus = h('span', { class: 'media-scan-state muted small', text: t(initialScanKey) });
  const pendingOption = (control: HTMLSelectElement, key: string) => {
    const option = new Option(t(key), '');
    option.disabled = true; option.selected = true;
    control.replaceChildren(option);
    control.disabled = true;
  };
  const fillDevices = (control: HTMLSelectElement, devices: MediaDeviceInfo[], saved: string) => {
    control.replaceChildren(new Option(t('media.systemDefault'), ''));
    for (const device of devices) control.append(new Option(device.label, device.label));
    // Preserve a disconnected/temporarily busy selection visibly instead of
    // silently replacing it with an unrelated default endpoint.
    if (saved && !devices.some((device) => device.label === saved)) {
      control.append(new Option(`${saved} — ${t('state.off')}`, saved));
    }
    control.disabled = false;
    control.value = saved;
  };
  const save = async (quiet = false): Promise<void> => {
    const mediaCapture = { cameraLabel: camera.value, microphoneLabel: microphone.value };
    if (mediaCapture.cameraLabel === data.profile.mediaCapture.cameraLabel
      && mediaCapture.microphoneLabel === data.profile.mediaCapture.microphoneLabel) return;
    const applied = await api.invoke<boolean>('ui:profile-set', { mediaCapture }).catch(() => false);
    if (!applied) { if (!quiet) toast('media.permissionFailed'); return; }
    data.profile.mediaCapture = mediaCapture;
    if (!quiet) toast('toast.saved');
  };
  camera.onchange = () => void save(); microphone.onchange = () => void save();
  pendingOption(camera, initialScanKey);
  pendingOption(microphone, initialScanKey);
  const detect = h('button', { class: 'btn small', text: t('media.detectNow') }) as HTMLButtonElement;

  /**
   * Refresh the catalogue without opening every DirectShow endpoint. The old
   * health scan acquired cameras one by one merely because Settings opened;
   * virtual/phone drivers then remained busy when the active website asked for
   * its stream. A user-initiated refresh may open one default track solely to
   * reveal protected labels, and releases it before controls are enabled.
   */
  const scanDevices = async (revealLabels = false): Promise<void> => {
    stop(); detect.disabled = true; preview.disabled = true;
    pendingOption(camera, 'media.scanningActive'); pendingOption(microphone, 'media.scanningActive');
    scanStatus.className = 'media-scan-state muted small';
    scanStatus.textContent = t('media.scanningActive');
    const permissionStreams: MediaStream[] = [];
    try {
      let listed = await navigator.mediaDevices.enumerateDevices();
      if (revealLabels) {
        for (const kind of ['videoinput', 'audioinput'] as MediaDeviceKind[]) {
          if (listed.some((device) => device.kind === kind && device.label)) continue;
          try {
            permissionStreams.push(await navigator.mediaDevices.getUserMedia(kind === 'videoinput'
              ? { video: true, audio: false } : { video: false, audio: true }));
          } catch { /* this device class remains anonymous */ }
        }
        listed = await navigator.mediaDevices.enumerateDevices();
      }
      const seen = new Set<string>();
      const devices = listed.filter((device) => {
        if (device.kind !== 'videoinput' && device.kind !== 'audioinput') return false;
        if (!device.deviceId || !device.label || device.deviceId === 'default' || device.deviceId === 'communications') return false;
        const key = `${device.kind}:${device.label.toLocaleLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const cameras = devices.filter((device) => device.kind === 'videoinput');
      const microphones = devices.filter((device) => device.kind === 'audioinput');
      workingCameras = new Map(cameras.map((device) => [device.label, device.deviceId]));
      workingMicrophones = new Map(microphones.map((device) => [device.label, device.deviceId]));
      fillDevices(camera, cameras, data.profile.mediaCapture.cameraLabel);
      fillDevices(microphone, microphones, data.profile.mediaCapture.microphoneLabel);
      scanStatus.className = 'media-scan-state small ready';
      scanStatus.textContent = t('media.devicesFound', { cameras: cameras.length, microphones: microphones.length });
    } catch { scanStatus.className = 'media-scan-state small failed'; scanStatus.textContent = t('media.permissionFailed'); }
    finally {
      for (const permission of permissionStreams) permission.getTracks().forEach((track) => track.stop());
      detect.disabled = false; preview.disabled = camera.disabled && microphone.disabled;
    }
  };
  detect.onclick = () => void scanDevices(true);
  listen = h('button', { class: 'btn small', text: t('media.listenMicrophone'), disabled: true }) as HTMLButtonElement;
  listen.onclick = () => {
    if (!stream?.getAudioTracks().length) return;
    monitor.muted = !monitor.muted;
    listen.textContent = t(monitor.muted ? 'media.listenMicrophone' : 'media.stopListening');
    if (!monitor.muted) void monitor.play();
  };
  const preview = h('button', { class: 'btn small', text: t('media.previewSelected') }) as HTMLButtonElement;
  preview.onclick = async () => {
    stop();
    try {
      const cameraId = workingCameras.get(camera.value);
      const microphoneId = workingMicrophones.get(microphone.value);
      if ((camera.value && !cameraId) || (microphone.value && !microphoneId)) throw new DOMException('Selected device is unavailable', 'NotFoundError');
      stream = await navigator.mediaDevices.getUserMedia({
        video: camera.disabled ? false : camera.value ? { deviceId: { exact: cameraId! } } : true,
        audio: microphone.disabled ? false : microphone.value ? { deviceId: { exact: microphoneId! } } : true,
      });
      video.srcObject = stream;
      video.classList.toggle('previewing', stream.getVideoTracks().length > 0);
      monitor.srcObject = stream;
      listen.disabled = !stream.getAudioTracks().length;
      if (stream.getAudioTracks().length) {
        audioContext = new AudioContext();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        audioContext.createMediaStreamSource(stream).connect(analyser);
        const levels = new Uint8Array(analyser.frequencyBinCount);
        const drawLevel = () => {
          analyser.getByteFrequencyData(levels);
          meter.value = Math.min(100, Math.round(levels.reduce((sum, value) => sum + value, 0) / Math.max(1, levels.length) / 1.6));
          meterFrame = requestAnimationFrame(drawLevel);
        };
        drawLevel();
      }
      window.setTimeout(stop, 20_000);
    } catch { toast('media.permissionFailed'); }
  };
  const root = h('div', { class: 'settings-media' },
    scanStatus,
    h('div', { class: 'set-row' }, h('span', { text: t('media.activeCamera') }), camera),
    h('div', { class: 'set-row' }, h('span', { text: t('media.activeMicrophone') }), microphone),
    h('div', { class: 'row' }, detect, preview, listen), video, meter, monitor,
    h('p', { class: 'muted small', text: t('media.browserRoutingHint') }));
  // Opening the panel performs detection immediately; Refresh remains available
  // for hot-plugged or newly released devices.
  if (autoScan) window.setTimeout(() => { if (root.isConnected) void scanDevices(); }, 0);
  return root;
}

/** Settings that belong to the window itself; the launcher keeps the rest. */
async function renderSettings(body: HTMLElement): Promise<void> {
  const data = await api.invoke<WindowSettings>('ui:settings-get');
  if (!data) { body.append(h('p', { class: 'err', text: t('settings.unavailable') })); return; }
  body.classList.add('pw-panel', 'browser-settings-panel');
  body.dataset.shell = state?.profile.browserShell ?? 'octo';

  const appSwitch = (key: string, on: boolean, patch: (value: boolean) => Record<string, unknown>) => {
    const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const status = h('span', { class: 'muted small', text: t(on ? 'ui.on' : 'ui.off') });
    input.checked = on;
    input.onchange = () => { status.textContent = t(input.checked ? 'ui.on' : 'ui.off'); void api.invoke('ui:settings-set', patch(input.checked)); toast('toast.saved'); };
    return h('label', { class: 'set-row' }, input, h('span', { text: t(key) }), status);
  };
  const profileSwitch = (key: string, on: boolean, field: string) => {
    const input = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const status = h('span', { class: 'muted small', text: t(on ? 'ui.on' : 'ui.off') });
    input.checked = on;
    input.onchange = () => { status.textContent = t(input.checked ? 'ui.on' : 'ui.off'); void api.invoke('ui:profile-set', { [field]: input.checked }); toast('toast.saved'); };
    return h('label', { class: 'set-row' }, input, h('span', { text: t(key) }), status);
  };

  const engine = h('select', { class: 'set-select' }) as HTMLSelectElement;
  for (const id of data.app.searchEngines) {
    const option = h('option', { value: id, text: t(`settings.search.${id}`) }) as HTMLOptionElement;
    option.selected = id === data.app.searchEngine;
    engine.append(option);
  }
  engine.onchange = () => { void api.invoke('ui:settings-set', { searchEngine: engine.value }); toast('toast.saved'); };

  const home = h('input', { class: 'set-input', type: 'text', value: data.profile.homePage, spellcheck: 'false' }) as HTMLInputElement;
  const homeSave = h('button', { class: 'btn small primary', text: t('common.save') });
  homeSave.onclick = () => { void api.invoke('ui:profile-set', { homePage: home.value }); toast('toast.saved'); };

  const profileEngine = h('select', { class: 'set-select' }) as HTMLSelectElement;
  profileEngine.append(h('option', { value: '', text: t('search.engineDefault') }));
  for (const id of data.app.searchEngines) {
    const opt = h('option', { value: id, text: t(`settings.search.${id}`) }) as HTMLOptionElement;
    opt.selected = id === data.profile.searchEngine;
    profileEngine.append(opt);
  }
  if (!data.profile.searchEngine) {
    (profileEngine.firstElementChild as HTMLOptionElement).selected = true;
  }
  profileEngine.onchange = () => {
    void api.invoke('ui:profile-set', { searchEngine: profileEngine.value || '' });
    toast('toast.saved');
  };

  const theme = h('button', { class: 'btn small', text: t(data.profile.theme === 'light' ? 'settings.themeLight' : 'settings.themeDark') });
  theme.onclick = () => { void api.invoke('ui:profile-set', { theme: data.profile.theme === 'light' ? 'dark' : 'light' }); toast('toast.saved'); };

  const passwords = h('button', { class: 'btn small', text: t('pw.manage') });
  passwords.onclick = () => openPanel('passwords');
  const askDownloads = h('input', { type: 'checkbox' }) as HTMLInputElement;
  askDownloads.checked = data.profile.downloads.askWhereToSave;
  const askDownloadsStatus = h('span', { class: 'muted small', text: t(askDownloads.checked ? 'ui.on' : 'ui.off') });
  askDownloads.onchange = () => {
    askDownloadsStatus.textContent = t(askDownloads.checked ? 'ui.on' : 'ui.off');
    data.profile.downloads.askWhereToSave = askDownloads.checked;
    void api.invoke('ui:profile-set', { downloads: { askWhereToSave: askDownloads.checked } });
    toast('toast.saved');
  };
  const downloadFolderValue = data.app?.hideDirectoryPaths && data.profile.downloads.defaultDirectory ? (t('settings.pathHidden') || '••••••••••••••••') : data.profile.downloads.defaultDirectory;
  const downloadFolder = h('input', {
    class: 'set-input', type: 'text', spellcheck: 'false', value: downloadFolderValue,
    placeholder: t('dl.profileFolderDefault'), 'aria-label': t('dl.defaultFolder'),
  }) as HTMLInputElement;
  const saveDownloadFolder = h('button', { class: 'btn small', text: t('common.save') });
  const chooseDownloadFolder = h('button', { class: 'btn small', text: t('dl.browseFolder') });
  const saveFolder = () => {
    if (downloadFolder.value.trim() !== (t('settings.pathHidden') || '••••••••••••••••')) {
      data.profile.downloads.defaultDirectory = downloadFolder.value.trim();
      void api.invoke('ui:profile-set', { downloads: { defaultDirectory: data.profile.downloads.defaultDirectory } });
      toast('toast.saved');
    }
  };
  saveDownloadFolder.onclick = saveFolder;
  chooseDownloadFolder.onclick = async () => {
    const selected = await api.invoke<string | null>('ui:download-folder-pick').catch(() => null);
    if (!selected) return;
    downloadFolder.value = selected;
    saveFolder();
  };
  const media = await browserMediaSettings(data);
  const shellName = t(`profile.browserShell.${data.profile.browserShell}`);
  const settingsSearch = h('input', { class: 'settings-search', type: 'search', placeholder: t('settings.searchSettings'), spellcheck: 'false' }) as HTMLInputElement;
  const studioLabel = h('input', { class: 'set-input', type: 'text', value: data.profile.name, maxlength: '64', 'aria-label': t('settings.vstudioLabel') }) as HTMLInputElement;
  const studio = h('button', { class: 'btn small primary', text: t('settings.openVstudio') });
  studio.onclick = () => { void api.invoke('ui:vstudio-web', studioLabel.value); toast('settings.vstudioStarted', { name: studioLabel.value || data.profile.name }); };

  body.append(
    settingsSearch,
    h('div', { class: 'settings-shell-head' }, h('b', { text: t('settings.shellTitle', { shell: shellName }) }), h('span', { class: 'muted small', text: t(`settings.shellHint.${data.profile.browserShell}`) })),
    section('settings.thisProfile',
      kv('profile.name', data.profile.name),
      kv('profile.protectionLevel', t(`level.${data.profile.level}`)),
      profileSwitch('profile.savePasswords', data.profile.savePasswords, 'savePasswords'),
      profileSwitch('profile.keepHistory', data.profile.keepHistory, 'keepHistory'),
      profileSwitch('profile.restoreSession', data.profile.restoreSession, 'restoreSession'),
      h('div', { class: 'set-row' }, h('span', { text: t('profile.homePage') }), home, homeSave),
      h('div', { class: 'set-row' }, h('span', { text: t('profile.searchEngine') }), profileEngine),
      h('div', { class: 'set-row' }, h('span', { text: t('profile.theme') }), theme),
      h('div', { class: 'set-row' }, h('span', { text: t('pw.title') }), passwords)),
    section('dl.settings',
      h('label', { class: 'set-row' }, askDownloads, h('span', { text: t('dl.askEveryTime') }), askDownloadsStatus),
      h('div', { class: 'set-row' }, h('span', { text: t('dl.defaultFolder') }), downloadFolder, chooseDownloadFolder, saveDownloadFolder),
      h('p', { class: 'muted small', text: t('dl.perProfileHint') }),
      ...(!data.profile.sandboxDownloadsShared ? [h('p', { class: 'hint warn', text: t('dl.sandboxFolderUnavailable') })] : [])),
    section('media.captureInputs',
      profileSwitch('settings.allowCameraPrompts', data.profile.cameraAllowed, 'cameraAllowed'),
      profileSwitch('settings.allowMicrophonePrompts', data.profile.microphoneAllowed, 'microphoneAllowed'),
      media),
    section('settings.vstudio',
      h('p', { class: 'muted small', text: t('settings.vstudioHint') }),
      h('div', { class: 'set-row' }, studioLabel, studio)),
    section('settings.window',
      appSwitch('menu.verticalTabs', data.app.verticalTabs, (value) => ({ verticalTabs: value })),
      appSwitch('menu.showBookmarksBar', data.app.showBookmarksBar, (value) => ({ showBookmarksBar: value })),

      appSwitch('settings.virtualBoxMode', data.app.virtualBoxMode ?? false, (value) => {
        document.documentElement.dataset.vmMode = value ? 'on' : 'off';
        document.documentElement.classList.toggle('vm-mode', value);
        document.body.classList.toggle('vm-mode', value);
        if (value) document.documentElement.dataset.animations = 'off';
        return { virtualBoxMode: value, ...(value ? { animations: false } : {}) };
      }),

      appSwitch('settings.hideDirectoryPaths', data.app.hideDirectoryPaths ?? false, (value) => ({ hideDirectoryPaths: value })),
      appSwitch('settings.openLinksInBackground', data.app.openLinksInBackground, (value) => ({ openLinksInBackground: value })),
      appSwitch('settings.animations', data.app.animations, (value) => ({ animations: value })),
      appSwitch('settings.confirmOnQuit', data.app.confirmOnQuit, (value) => ({ confirmOnQuit: value })),
      appSwitch('settings.closeCountdown', data.app.closeCountdown, (value) => ({ closeCountdown: value }))),
    section('settings.search',
      h('div', { class: 'set-row' }, h('span', { text: t('settings.searchEngine') }), engine),
      h('p', { class: 'muted small', text: t('settings.searchEngineHint') })),
  );
  const more = h('button', { class: 'btn small', text: t('menu.managerSettings') });
  more.onclick = () => void api.invoke('ui:open-launcher');
  body.append(h('p', { class: 'muted small', text: t('settings.moreInLauncher') }), more);
  settingsSearch.oninput = () => {
    const needle = settingsSearch.value.trim().toLocaleLowerCase();
    for (const node of body.querySelectorAll<HTMLElement>('.psec')) node.classList.toggle('hidden', !!needle && !node.innerText.toLocaleLowerCase().includes(needle));
  };
}

// ------------------------------------------------------------------ events

function handleCommand(cmd: string): void {
  switch (cmd) {
    case 'focus-address': { const a = $<HTMLInputElement>('address'); a.focus(); a.select(); break; }
    case 'find': openFind(); break;
    case 'search-tabs': openTabSearch(); break;
    case 'panel-audio': openPanel('audio'); break;
    case 'panel-traffic': openPanel('traffic'); break;
    case 'panel-privacy': openPanel('privacy'); break;
    case 'panel-downloads': openPanel('downloads'); break;
    case 'panel-bookmarks': openPanel('bookmarks'); break;
    default: break;
  }
}

/** The window style is a per-profile setting, never a global launcher preference. */
function smartPasteValue(raw: string): string {
  let value = raw.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('`') && value.endsWith('`'))) value = value.slice(1, -1).trim();
  if (/^www\./i.test(value)) value = `https://${value}`;
  return value;
}

function applyAppearance(theme: 'dark' | 'light' | undefined, browserShell: ProfileInfo['browserShell'] = 'octo', mobile = false, appMode = false): void {
  const chromeFamily = browserShell === 'chrome' || browserShell === 'chromium';
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.chromeLook = chromeFamily ? 'on' : 'off';
  document.documentElement.dataset.browserShell = browserShell;
  document.documentElement.dataset.mobileChrome = mobile ? 'on' : 'off';
  document.documentElement.dataset.appMode = appMode ? 'on' : 'off';

  // The profile identity belongs beside navigation controls in the toolbar,
  // keeping the top tab row reserved strictly for tabs, drag space and window buttons.
  const badge = $('profileBadge');
  const target = $('toolbar');
  if (badge.parentElement !== target) {
    target.insertBefore(badge, $('omnibox'));
  }
}

/** Minimal "closing" overlay shown instead of cutting the process short. */
function showCloseVeil(info: { tabs: number; restoreSession: boolean; closeCountdown?: boolean }): void {
  shuttingDown = true;
  bars.clear();
  dismissAllPopouts();
  renderBars();
  const veil = $('closeveil');
  const close = $<HTMLButtonElement>('cvClose');
  const force = $<HTMLButtonElement>('cvForce');
  const keep = $<HTMLButtonElement>('cvKeep');
  const count = $('cvCountdown');
  const countText = $('cvCountdownText');
  if (closeCountdownTimer !== undefined) window.clearInterval(closeCountdownTimer);
  closeCountdownTimer = undefined;

  $('cvTitle').textContent = t('close.title');
  $('cvBody').textContent = info.restoreSession
    ? t('close.saving', { n: info.tabs })
    : t('close.nosave', { n: info.tabs });
  close.textContent = t('close.confirm');
  force.textContent = t('close.force');
  $('cvWarn').textContent = t('close.forceWarn');
  keep.textContent = t('close.keepOpen');
  close.disabled = false;
  force.disabled = false;

  // A tab is a separate native WebContentsView that sits above this chrome
  // view. Tell the main process to hide it while this modal is open; otherwise
  // the confirmation is there but completely covered by the web page.
  setContentCovered(true);
  veil.classList.remove('hidden');

  let finished = false;
  const cancelCountdown = () => {
    if (closeCountdownTimer !== undefined) window.clearInterval(closeCountdownTimer);
    closeCountdownTimer = undefined;
  };
  const finish = (forceClose: boolean) => {
    if (finished) return;
    finished = true;
    cancelCountdown();
    close.disabled = true;
    force.disabled = true;
    void api.invoke('ui:close-ok', forceClose);
  };
  close.onclick = () => finish(false);
  force.onclick = () => finish(true);
  keep.onclick = () => {
    cancelCountdown();
    shuttingDown = false;
    veil.classList.add('hidden');
    setContentCovered(false);
    syncChromeFront();
  };

  const useCountdown = info.closeCountdown !== false;
  count.classList.toggle('hidden', !useCountdown);
  countText.classList.toggle('hidden', !useCountdown);
  if (!useCountdown) return;
  const end = Date.now() + 3_000;
  const tick = () => {
    const seconds = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    count.textContent = String(seconds);
    countText.textContent = t('close.countdown', { n: seconds });
    if (seconds === 0) finish(false);
  };
  tick();
  closeCountdownTimer = window.setInterval(tick, 125);
}

/** Open a link from bookmarks / history, in the background when the setting says so. */
function openLink(url: string): void {
  void api.invoke('ui:new-tab', url, state?.openLinksInBackground === true);
}

/** Bookmark bar under the address bar (Settings > Tabs). */
async function renderBookbar(): Promise<void> {
  const bar = $('bookbar');
  if (!state?.showBookmarksBar) { bar.classList.add('hidden'); clear(bar); return; }
  bar.classList.remove('hidden');
  const list = await api.invoke<Array<{ id: string; title: string; url: string }>>('ui:bookmarks');
  clear(bar);
  if (!list.length) {
    bar.append(h('span', { class: 'bb-empty', text: t('bm.empty') }));
    return;
  }
  for (const b of list.slice(0, 24)) {
    const btn = h('button', { class: 'bb', text: b.title || b.url, title: b.url });
    btn.onclick = () => openLink(b.url);
    bar.append(btn);
  }
  bar.append(h('button', { class: 'bb bb-more', text: '\u2026', title: t('panel.bookmarks') }));
  const more = bar.lastElementChild as HTMLButtonElement;
  more.onclick = () => openPanel('bookmarks');
}

function initEvents(): void {
  const dismissPopups = (e: Event) => {
    const target = e.target as Node | null;
    if (!target) return;
    if (chromeMenuOpen && !$('chromeMenu').contains(target) && !$('stMenu').contains(target) && !$('profileBadge').contains(target)) closeChromeMenu();
    if (downloadsTrayOpen && !$('downloadsTray').contains(target) && !$('stDownloads').contains(target)) closeDownloadsTray();
    if (passwordsPopoutOpen && !$('passwordsPopout').contains(target)) closePasswordsPopout();
    if (pageInfoOpen && !$('pageInfo').contains(target) && !$('secIcon').contains(target)) closePageInfo();
    if (translateOpen && !$('translateBar').contains(target) && !$('translateBtn').contains(target)) closeTranslateBar();
  };
  document.addEventListener('pointerdown', dismissPopups);
  document.addEventListener('mousedown', dismissPopups);
  api.on('ui:release-media-preview', (token) => {
    const released = stopChromeMediaPreview?.() === true;
    void api.invoke('ui:media-preview-released', String(token ?? ''), released).catch(() => undefined);
  });
  api.on<WinState>('ui:state', (s) => {
    // A panel, menu or tray left open on one site used to keep the trusted
    // chrome above the page on the next site too - that site then ignored
    // every click. Switching tabs closes them, the way a browser does.
    if (s.activeId !== lastActiveTabId) {
      lastActiveTabId = s.activeId;
      dismissAllPopouts();
    }
    // A tab's dropdown must not outlive the tab (for example, a page closed by its own script).
    if (chromeMenuOpen && chromeMenuTabId && !s.tabs.some((tab) => tab.id === chromeMenuTabId)) closeChromeMenu();
    const dragged = activeTabDrag && s.tabs.find((tab) => tab.id === activeTabDrag?.id);
    if (activeTabDrag && (!dragged || dragged.crashed)) cancelActiveTabDrag();
    state = s;
    const isVm = s.virtualBoxMode === true;
    document.documentElement.dataset.animations = (s.animations === false || isVm) ? 'off' : 'on';
    document.documentElement.dataset.vmMode = isVm ? 'on' : 'off';
    document.documentElement.classList.toggle('vm-mode', isVm);
    document.body.classList.toggle('vm-mode', isVm);
    applyAppearance(s.profile.theme as 'dark' | 'light' | undefined, s.profile.browserShell ?? (s.profile.baseChromeLook ? 'chrome' : 'octo'), s.profile.mobile, s.profile.appMode);
    renderTabs();
    renderAddress();
    renderStatus();
    void renderBookbar();
    if (panel === 'audio' || panel === 'addons' || panel === 'updates') openPanel(panel, () => void renderPanel(panel!), t(`panel.${panel}`));
  });
  api.on<TabState>('ui:tab', (tab) => {
    if (!state) return;
    if (activeTabDrag?.id === tab.id && tab.crashed) cancelActiveTabDrag();
    const i = state.tabs.findIndex((x) => x.id === tab.id);
    if (i >= 0) state.tabs[i] = tab;
    renderTabs();
    if (tab.id === state.activeId) renderAddress();
    renderStatus();
  });
  api.on<{ active: number; total: number }>('ui:found', (r) => { $('findCount').textContent = r.total ? `${r.active}/${r.total}` : t('find.none'); });
  api.on<{ key: string; params?: Record<string, string> }>('ui:toast', (m) => { if (!shuttingDown) toast(m.key, m.params); });
  api.on<string>('ui:command', handleCommand);
  api.on('ui:focus-address', () => handleCommand('focus-address'));
  api.on<{ tabs: number; restoreSession: boolean }>('ui:close-request', showCloseVeil);
  api.on<{ kind: string; origin: string; reqId: string }>('ui:permission', (q) => {
    if (shuttingDown) return;
    const displayOrigin = q.origin.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const permIcon = q.kind === 'geolocation' ? 'pin'
      : q.kind === 'camera' || q.kind === 'media' ? 'camera'
      : q.kind === 'microphone' ? 'volume'
      : q.kind === 'notifications' ? 'mail'
      : q.kind === 'clipboard-read' ? 'copy'
      : q.kind === 'display-capture' ? 'pip'
      : q.kind === 'canvas' ? 'fingerprint'
      : 'shield';
    const detailKey = `perm.action.${q.kind}`;
    const detail = t(detailKey);
    pushBar({
      id: q.reqId, kind: 'ask', appearance: 'permission',
      originLabel: t('perm.wantsTo', { origin: displayOrigin }),
      detail: detail === detailKey ? t(`perm.${q.kind}`) : detail,
      permIcon,
      text: q.kind === 'canvas'
        ? t('perm.canvasAsk', { origin: displayOrigin })
        : t('perm.ask', { origin: displayOrigin, what: t(`perm.${q.kind}`) }),
      actions: [
        ...(q.kind === 'canvas' ? [{ key: 'perm.learnMore', keepOpen: true, link: true, run: () => openPanel('privacy') }] : []),
        { key: 'perm.deny', run: () => void api.invoke('ui:answer', q.reqId, false) },
        { key: 'perm.allow', primary: true, run: () => void api.invoke('ui:answer', q.reqId, true) },
      ],
    });
  });
  api.on<{ fileName: string; reqId: string }>('ui:confirm-download', (q) => {
    if (shuttingDown) return;
    pushBar({
      id: q.reqId, kind: 'warn', text: t('dl.confirmDangerous', { file: q.fileName }),
      actions: [
        { key: 'dl.keep', run: () => void api.invoke('ui:answer', q.reqId, true) },
        { key: 'common.cancel', primary: true, run: () => void api.invoke('ui:answer', q.reqId, false) },
      ],
    });
  });
  api.on<DownloadInfo>('ui:download', (d) => {
    if (shuttingDown) return;
    const prev = downloads.get(d.id);
    downloads.set(d.id, d);
    if (!prev && (d.state === 'downloading' || d.state === 'choosing-location')) {
      toast('dl.started', { file: d.fileName });
      openDownloadsTray();
    }
    if (prev?.state !== 'completed' && d.state === 'completed') toast('dl.done', { file: d.fileName });
    renderStatus();
    if (downloadsTrayOpen) void renderDownloadsTray();
    if (panel === 'downloads') openPanel('downloads', () => void renderDownloads($('panelBody')), t('panel.downloads'));
  });

  // Keyboard shortcuts while the chrome UI has focus (tabs forward keys via the main process).
  window.addEventListener('keydown', (e) => {
    const inInput = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.key === 'Escape') {
      // Escape answers an open consent bubble with "deny" and clears it, the
      // way a dismissed prompt must never stay in the way of the page.
      if (permissionBarOpen()) {
        const pending = [...bars.values()].find((b) => b.appearance === 'permission');
        if (pending) {
          const deny = pending.actions.find((a) => a.key === 'perm.deny');
          removeBar(pending.id);
          deny?.run();
          return;
        }
      }
      if (chromeMenuOpen) { closeChromeMenu(); return; }
      if (pageInfoOpen) { closePageInfo(); return; }
      if (translateOpen) { closeTranslateBar(); return; }
      if (downloadsTrayOpen) { closeDownloadsTray(); return; }
      if (passwordsPopoutOpen) { closePasswordsPopout(); return; }
      if (panelCoversContent && panel) { openPanel(null); return; }
      if (overlay) { setOverlay(false); return; }
      if (!$('findbar').classList.contains('hidden')) { closeFind(); return; }
      if (panel) { openPanel(null); return; }
    }
    const cmd = commandFor({ key: e.key, control: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
    if (!cmd) return;
    if (inInput && !e.ctrlKey && !e.altKey && !/^F\d+$/.test(e.key)) return; // typing
    if (inInput && e.ctrlKey && ['c', 'v', 'x', 'a', 'z', 'y'].includes(e.key.toLowerCase()) && !e.shiftKey) return;
    e.preventDefault();
    const local = ['focus-address', 'find', 'search-tabs', 'panel-audio', 'panel-traffic', 'panel-privacy', 'panel-downloads', 'panel-bookmarks'];
    if (local.includes(cmd)) handleCommand(cmd);
    else void api.invoke('ui:command', cmd);
  });
}

// ------------------------------------------------------------------ boot

function initWindowControls(): void {
  clear($('windowMinimize'));
  clear($('windowMaximize'));
  clear($('windowClose'));
  $('windowMinimize').append(icon('minimize', 14));
  $('windowMaximize').append(icon('maximize', 14));
  $('windowClose').append(icon('close', 14));
  const action = (id: string, command: 'minimize' | 'toggle-maximize') => {
    $(id).addEventListener('click', () => { void api.invoke('ui:window-action', command); });
  };
  action('windowMinimize', 'minimize');
  action('windowMaximize', 'toggle-maximize');
  $('windowClose').addEventListener('click', () => { void api.invoke('ui:close-window'); });
}

async function boot(): Promise<void> {
  const init = await api.invoke<{ lang: 'en' | 'pl'; dicts: Dicts; version: string; shortcuts: Array<[string, string]>; addons: AddonInfo[]; theme: 'dark' | 'light'; browserShell: ProfileInfo['browserShell']; baseChromeLook: boolean; appMode: boolean; smartPaste: boolean; mobile: boolean }>('ui:init');
  setDicts(init.dicts);
  setLang(init.lang);
  addons = init.addons;
  shortcuts = init.shortcuts;
  applyAppearance(init.theme, init.browserShell ?? (init.baseChromeLook ? 'chrome' : 'octo'), init.mobile, init.appMode);
  applyI18n();
  initWindowControls();
  initToolbar();
  initFind();
  initEvents();
  watchChromeLayers();
  reportLayout();
  await api.invoke('ui:ready');
}

boot().catch((err) => {
  document.body.append(h('pre', { class: 'fatal', text: `OctoBrowser UI error: ${String((err as Error)?.message ?? err)}` }));
});
