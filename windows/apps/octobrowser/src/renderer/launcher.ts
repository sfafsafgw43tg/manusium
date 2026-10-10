/**
 * apps/octobrowser/src/renderer/launcher.ts
 *
 * Launcher / profile manager UI. Layout (dark, like common antidetect
 * browsers): icon rail on the left, folder column (profiles view), toolbar +
 * table. Views: profiles, proxies, security, updates, settings, API, logs,
 * about. Profile list / editor / proxies / dialogs live in launcher-*.ts.
 */
import { api, clear } from '@octo/shell/renderer/bridge';
import { applyI18n, h, setDicts, setLang, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { keyProtectionPanel } from '@octo/shell/renderer/keypanel';
import { $, S, L, Init, brandLogo, Profile, SavedProxy, Settings, UpdateStatus, View, PluginEntry, CorePluginEntry, animateIn, busy, run, toast, closeModal, closePopup, confirmDialog, field, select, toggle, input, copyText, modal } from './launcher-ui';
import { renderProfiles, renderFolders } from './launcher-profiles';
import { renderProxies } from './launcher-proxies';
import { renderTrash } from './launcher-trash';
import { renderVirtualBox } from './launcher-virtualbox';
import { renderBackup } from './launcher-backup';
import { runInstall } from './launcher-android-install';
import { openDolphinImportDialog } from './launcher-dolphin';

// ------------------------------------------------------------------ layout

const NAV: Array<[View, string]> = [
  ['profiles', 'users'], ['proxies', 'proxy'], ['backup', 'box'], ['virtualbox', 'smartphone'], ['trash', 'trash'], ['security', 'shield'], ['api', 'api'], ['settings', 'settings'], ['logs', 'file'], ['about', 'info'],
];
const VALID_VIEWS: View[] = NAV.map(([view]) => view);
function initWindowControls(): void {
  const minimize = document.getElementById('windowMinimize');
  const maximize = document.getElementById('windowMaximize');
  const close = document.getElementById('windowClose');
  if (minimize) minimize.append(icon('minimize', 14));
  if (maximize) maximize.append(icon('maximize', 14));
  if (close) close.append(icon('close', 14));
  const action = (id: string, command: 'minimize' | 'toggle-maximize' | 'close') => {
    document.getElementById(id)?.addEventListener('click', () => { void api.invoke('mgr:window-action', command); });
  };
  action('windowMinimize', 'minimize');
  action('windowMaximize', 'toggle-maximize');
  action('windowClose', 'close');
}

function showFileProgress(progress: { operation: 'move' | 'delete'; completed: number; total: number; percent: number; label?: string }): void {
  let box = document.getElementById('file-operation-progress');
  if (!box) {
    box = document.createElement('div');
    box.id = 'file-operation-progress';
    box.innerHTML = '<div class="file-operation-title"></div><div class="file-operation-track"><div class="file-operation-fill"></div></div><div class="file-operation-detail"></div>';
    document.body.append(box);
  }
  const title = box.querySelector<HTMLElement>('.file-operation-title');
  const fill = box.querySelector<HTMLElement>('.file-operation-fill');
  const detail = box.querySelector<HTMLElement>('.file-operation-detail');
  const percent = progress.percent >= 0 ? `${progress.percent}%` : '…';
  if (title) title.textContent = t(progress.operation === 'move' ? 'fileOps.moving' : 'fileOps.deleting');
  if (fill) { fill.style.width = progress.percent >= 0 ? `${Math.max(2, progress.percent)}%` : '35%'; fill.classList.toggle('indeterminate', progress.percent < 0); }
  if (detail) detail.textContent = progress.total > 0 ? `${percent} · ${progress.completed}/${progress.total}${progress.label ? ` · ${progress.label}` : ''}` : percent;
  box.classList.toggle('visible', progress.percent < 100);
  if (progress.percent >= 100) window.setTimeout(() => box?.classList.remove('visible'), 500);
}
function orderedNav(): Array<[View, string]> {
  const byView = new Map(NAV.map((item) => [item[0], item]));
  const fallback = NAV.map(([id]) => ({ id, visible: true }));
  const raw = init?.settings.ui.sidebar;
  const legacy = (init?.settings.ui.navOrder ?? NAV.map(([view]) => view)).map((id) => ({ id, visible: !(init?.settings.ui.navHidden ?? []).includes(id) }));
  const sidebar = Array.isArray(raw) && raw.length ? raw : (legacy.length ? legacy : fallback);
  return sidebar.flatMap((entry) => {
    // Settings may have been written by an older renderer while the launcher
    // is open. Ignore malformed rows rather than throwing during nav paint.
    if (!entry || typeof entry !== 'object') return [];
    const view = (entry as { id?: unknown }).id as View;
    const visible = (entry as { visible?: unknown }).visible !== false;
    const item = byView.get(view);
    return item && visible ? [item] : [];
  });
}

let init: Init;
let railCollapsed = false;
/** Previous row positions used for a quick FLIP animation after sidebar reordering. */
let sidebarRowPositions: Map<string, number> | null = null;
let railItemPositions: Map<string, number> | null = null;

function captureSidebarMotion(): void {
  sidebarRowPositions = new Map([...document.querySelectorAll<HTMLElement>('.sidebar-pref-row[data-nav-view]')]
    .map((row) => [row.dataset.navView ?? '', row.getBoundingClientRect().top]));
  railItemPositions = new Map([...document.querySelectorAll<HTMLElement>('#nav .rail-item[data-nav-view]')]
    .map((item) => [item.dataset.navView ?? '', item.getBoundingClientRect().top]));
}

function playSidebarMotion(selector: string, positions: Map<string, number> | null): void {
  if (!positions?.size || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  requestAnimationFrame(() => {
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      const before = positions.get(el.dataset.navView ?? '');
      const distance = before === undefined ? 0 : before - el.getBoundingClientRect().top;
      if (!distance) continue;
      el.animate([
        { transform: `translateY(${distance}px)` },
        { transform: 'translateY(0)' },
      ], { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  });
}

/** Enlarged octopus mark in the top-left corner of the launcher. */
function renderBrand(): void {
  const head = $('railHead');
  let brand = head.querySelector('.brand');
  if (brand) return;
  brand = h('div', { class: 'brand', title: 'Octo.su' }, brandLogo(28));
  head.prepend(brand);
}

function applyRailState(): void {
  document.body.classList.toggle('rail-collapsed', railCollapsed);
  renderBrand();
  const toggle = $<HTMLButtonElement>('railToggle');
  clear(toggle);
  toggle.append(icon(railCollapsed ? 'forward' : 'back', 18));
  toggle.title = railCollapsed ? t('ui.expandNav') : t('ui.collapseNav');
  toggle.setAttribute('aria-label', toggle.title);
}

function renderNav(): void {
  const nav = $('nav');
  clear(nav);
  for (const [v, ic] of orderedNav()) {
    const b = h('button', { class: `rail-item${v === S.view ? ' active' : ''}`, 'data-nav-view': v, title: t(`launcher.nav.${v}`), 'aria-label': t(`launcher.nav.${v}`), 'aria-current': v === S.view ? 'page' : undefined }, icon(ic, 21), h('span', { class: 'rail-lbl', text: t(`launcher.nav.${v}`) }));
    b.onclick = () => {
      S.view = v;
      lastView = v;
      try { sessionStorage.setItem('octo.launcher.view', v); } catch { /* unavailable in hardened webviews */ }
      render();
    };
    nav.append(b);
  }
  playSidebarMotion('#nav .rail-item[data-nav-view]', railItemPositions);
  railItemPositions = null;
  const foot = $('sideFoot');
  clear(foot);
  const lock = h('button', { class: 'rail-item', title: t('launcher.lockNow'), 'aria-label': t('launcher.lockNow') }, icon('lock', 20), h('span', { class: 'rail-lbl', text: t('ui.lock') }));
  lock.onclick = () => void run(api.invoke('mgr:lock-all'), 'toast.saved');
  const lang = h('button', { class: 'rail-lang', title: t('settings.language'), text: init.lang.toUpperCase() });
  lang.onclick = () => { S.view = 'settings'; render(); };
  foot.append(lock, lang, h('span', { class: 'ver', text: `v${init.version}` }));
}

function renderStatus(): void {
  const s = $('statusbar');
  clear(s);
  const running = S.profiles.filter((p) => p.running).length;
  const attention = S.profiles.some((p) => p.needsResealing) || !init.update.configured;
  const apiCfg = init.settings.api;
  s.append(
    h('span', { class: `sb-item ${attention ? 'warn' : ''}` }, icon(attention ? 'shieldAlert' : 'shieldCheck', 13), h('span', { text: t(attention ? 'status.attention' : 'status.protectionActive') })),
    h('span', { class: 'sb-item' }, icon('users', 13), h('span', { text: t('ui.sb.profiles', { n: S.profiles.length, running }) })),
    h('span', { class: 'sb-item' }, icon('proxy', 13), h('span', { text: t('ui.sb.proxies', { n: S.proxies.length }) })),
    h('span', { class: `sb-item ${apiCfg.enabled ? 'on' : ''}` }, icon('api', 13), h('span', { text: apiCfg.enabled ? `API 127.0.0.1:${apiCfg.port}` : t('ui.sb.apiOff') })),
    h('span', { class: 'grow' }),
    h('span', { class: 'sb-item ell', title: init.settings.ui.hideDirectoryPaths ? t('settings.hideDirectoryPaths') : init.dataDir }, icon('folder', 13), h('span', { class: 'ell', text: init.settings.ui.hideDirectoryPaths ? (t('settings.pathHidden') || '••••••••••••••••') : init.dataDir })),
    h('span', { class: 'sb-item', text: `OctoBrowser ${init.version}` }),
  );
}

function applyVirtualBoxMode(vmMode: boolean): void {
  document.documentElement.dataset.vmMode = vmMode ? 'on' : 'off';
  document.documentElement.classList.toggle('vm-mode', vmMode);
  document.body.classList.toggle('vm-mode', vmMode);
}

function applyLauncherTheme(theme: Settings['ui']['theme']): void {
  document.documentElement.dataset.appTheme = theme;
}

/** The main process intercepts the native close event; this trusted view owns
 * the small, theme-consistent confirmation instead of opening a Windows dialog. */
function showCloseAppDialog(): void {
  let answered = false;
  const answer = (choice: 'quit' | 'cancel') => {
    if (answered) return;
    answered = true;
    void api.invoke('mgr:app-close-choice', choice);
  };
  modal(t('appBackground.title'), (box) => {
    const cancel = h('button', { class: 'btn app-close-cancel', text: t('common.cancel') });
    cancel.onclick = () => { answer('cancel'); closeModal(); };
    const quit = h('button', { class: 'btn primary app-close-quit', text: t('appBackground.quit') });
    quit.onclick = () => { answer('quit'); closeModal(); };
    box.append(h('div', { class: 'app-close-actions' }, cancel, quit));
  }, 'app-close', () => answer('cancel'));
}

function render(): void {
  try {
    // Manager push messages can arrive while a profile is starting. Never let
    // a malformed persisted view or a transient async update clear the whole
    // launcher: normalize to the last usable category before painting.
    if (!VALID_VIEWS.includes(S.view)) {
      let remembered = '';
      try { remembered = sessionStorage.getItem('octo.launcher.view') ?? ''; } catch { /* ignore */ }
      S.view = VALID_VIEWS.includes(remembered as View) ? remembered as View
        : VALID_VIEWS.includes(lastView as View) ? lastView as View : 'profiles';
    }
    renderPage();
  } catch (error) {
    // A settings write or a damaged local preference must never strand the
    // user in an empty window. Keep one local recovery route visible instead.
    console.error('Launcher render failed', error);
    try {
      renderRecovery();
    } catch (recoveryError) {
      // The recovery path is deliberately dependency-light. If an unexpected
      // renderer error still occurs, leave the selected view and a visible
      // diagnostic instead of an empty black page.
      console.error('Launcher recovery render failed', recoveryError);
      const view = document.getElementById('view');
      if (view) {
        view.textContent = 'Octo.su could not render this view. Open Logs or restart the launcher.';
        view.className = 'view-recovery';
      }
    }
  }
}

let lastView = '';
const viewScroll = new Map<string, number>();
// Profiles and proxies keep their own scrollable table body while the page
// shell itself is intentionally overflow-hidden. Keep that inner position as
// well as the generic page position when an IPC update causes a rerender.
const tableScroll = new Map<string, number>();

function restoreViewScroll(view: View, host: HTMLElement): void {
  const wanted = viewScroll.get(view) ?? 0;
  const wantedTable = tableScroll.get(view) ?? 0;
  const apply = () => {
    if (S.view !== view) return;
    host.scrollTop = wanted;
    const table = host.querySelector<HTMLElement>('.tbody');
    if (table) table.scrollTop = wantedTable;
  };
  apply();
  // Async pages can grow after their IPC result arrives. Restore once after
  // layout too, without continuously fighting a user who starts scrolling.
  requestAnimationFrame(() => requestAnimationFrame(apply));
}

function renderPage(): void {
  closePopup();
  renderNav();
  renderStatus();
  const side2 = $('side2');
  side2.classList.toggle('hidden', S.view !== 'profiles');
  if (S.view === 'profiles') renderFolders(side2);
  const v = $('view');
  if (lastView) {
    viewScroll.set(lastView, v.scrollTop);
    const table = v.querySelector<HTMLElement>('.tbody');
    if (table) tableScroll.set(lastView, table.scrollTop);
  }
  const targetView = S.view;
  clear(v);
  v.className = `view-${targetView}`;
  let pending: Promise<void> | undefined;
  switch (targetView) {
    case 'profiles': renderProfiles(v); break;
    case 'proxies': renderProxies(v); break;
    case 'backup': renderBackup(v); break;
    case 'virtualbox': pending = renderVirtualBox(v); break;
    case 'trash': pending = renderTrash(v); break;
    case 'security': renderSecurity(v); break;
    case 'settings': renderSettings(v); break;
    case 'api': pending = renderApi(v); break;
    case 'logs': pending = renderLogs(v); break;
    case 'about': renderAbout(v); break;
  }
  restoreViewScroll(targetView, v);
  // Async pages paint their structure immediately and fill in local data in
  // place. Do not cover the whole app with a loading screen for these reads.
  if (pending) void pending.then(() => restoreViewScroll(targetView, v))
    .catch((error: unknown) => toast(t('loading.failed'), 'err', String((error as Error)?.message ?? error)));
  // Only a real page switch is animated: a re-render caused by ticking a
  // checkbox or typing in the search box must not flash the whole page.
  if (lastView !== targetView) {
    animateIn(v, 'page');
    if (!side2.classList.contains('hidden')) animateIn(side2, 'fade');
    lastView = targetView;
  }
}

function renderRecovery(): void {
  closePopup();
  $('side2').classList.add('hidden');
  const nav = $('nav');
  clear(nav);
  const settings = h('button', { class: 'rail-item active', 'aria-current': 'page' }, icon('settings', 21), h('span', { class: 'rail-lbl', text: t('launcher.nav.settings') }));
  settings.onclick = () => { S.view = 'settings'; render(); };
  nav.append(settings);
  const v = $('view');
  clear(v);
  v.className = 'view-recovery';
  const restore = h('button', { class: 'btn primary', text: t('launcher.recovery.restore') });
  restore.onclick = async () => {
    const settingsAfterRestore = await saveSettings({ ui: { sidebar: NAV.map(([id]) => ({ id, visible: true })) } });
    if (settingsAfterRestore) { S.view = 'settings'; render(); }
  };
  const retry = h('button', { class: 'btn', text: t('launcher.recovery.retry') });
  retry.onclick = render;
  v.append(h('div', { class: 'panel recovery-panel' },
    h('h2', { text: t('launcher.recovery.title') }),
    h('p', { text: t('launcher.recovery.text') }),
    h('p', { class: 'hint', text: t('launcher.recovery.hint') }),
    h('div', { class: 'row' }, restore, retry)));
}
S.render = render;

function pageHead(key: string): HTMLElement {
  return h('div', { class: 'toolbar' }, h('h1', { text: t(key) }));
}

// ------------------------------------------------------------------ API

interface ApiStatus { enabled: boolean; port: number; listening: boolean; token: string; error: string; baseUrl: string }

async function renderApi(v: HTMLElement): Promise<void> {
  v.append(pageHead('launcher.nav.api'));
  const st = await run(api.invoke<ApiStatus>('mgr:api-status'));
  if (!st || S.view !== 'api') return;
  const draw = (s: ApiStatus) => {
    init.settings.api = { enabled: s.enabled, port: s.port };
    clear(panel);
    const port = input(String(s.port), { inputmode: 'numeric', maxlength: '5' });
    const savePort = h('button', { class: 'btn', text: t('common.save') });
    savePort.onclick = async () => { const r = await run(api.invoke<ApiStatus>('mgr:api-set', { port: Number(port.value) }), 'toast.saved'); if (r) draw(r); };
    let shown = false;
    const tok = h('code', { class: 'token', text: '•'.repeat(32) });
    const show = h('button', { class: 'btn small' }, icon('eye', 14), h('span', { text: t('api.show') }));
    show.onclick = () => { shown = !shown; tok.textContent = shown ? s.token : '•'.repeat(32); };
    const copy = h('button', { class: 'btn small' }, icon('copy', 14), h('span', { text: t('api.copy') }));
    copy.onclick = () => void copyText(s.token);
    const regen = h('button', { class: 'btn small danger' }, icon('refreshCircle', 14), h('span', { text: t('api.regenerate') }));
    regen.onclick = () => confirmDialog(t('api.regenerateConfirm'), async () => { const r = await api.invoke<ApiStatus>('mgr:api-token'); draw(r); return r; }, 'toast.saved');
    const state = s.enabled ? (s.listening ? h('span', { class: 'pill ok' }, icon('check', 13), ` ${t('api.listening', { url: s.baseUrl })}`) : h('span', { class: 'pill warn' }, icon('alert', 13), ` ${s.error || t('api.notListening')}`)) : h('span', { class: 'pill', text: t('state.off') });
    panel.append(
      h('h2', {}, icon('api', 17), ` ${t('api.title')}`),
      h('p', { class: 'muted', text: t('api.desc') }),
      toggle(s.enabled, 'api.enable', async (on) => { const r = await run(api.invoke<ApiStatus>('mgr:api-set', { enabled: on })); if (r) draw(r); }),
      h('div', { class: 'row' }, state),
      h('div', { class: 'grid2' },
        h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('api.port') }), h('div', { class: 'row nowrap' }, port, savePort), h('span', { class: 'hint', text: t('api.portHint') })),
        h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('api.baseUrl') }), h('code', { text: s.baseUrl }))),
      h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('api.token') }), h('div', { class: 'row' }, tok, show, copy, regen), h('span', { class: 'hint', text: t('api.tokenHint') })),
      h('p', { class: 'note', text: t('api.securityNote') }),
    );
    const ex = (title: string, code: string) => h('div', { class: 'api-ex' }, h('div', { class: 'row between' }, h('b', { text: title }), (() => { const c = h('button', { class: 'btn small' }, icon('copy', 13), h('span', { text: t('api.copy') })); c.onclick = () => void copyText(code); return c; })()), h('pre', { text: code }));
    const B = s.baseUrl;
    const H = `-H "Authorization: Bearer ${shown ? s.token : '<TOKEN>'}"`;
    clear(examples);
    examples.append(h('h2', {}, icon('file', 17), ` ${t('api.examples')}`),
      ex(t('api.ex.list'), `curl ${H} ${B}/profiles`),
      ex(t('api.ex.create'), `curl -X POST ${H} -H "Content-Type: application/json" \\\n  -d '{"name":"Shop 1","os":"windows11","proxy":{"mode":"new","text":"socks5://user:pass@1.2.3.4:1080"}}' \\\n  ${B}/profiles`),
      ex(t('api.ex.start'), `curl -X POST ${H} -H "Content-Type: application/json" -d '{"debug":true}' ${B}/profiles/<ID>/start\n# -> {"status":"started","debugPort":51234,"wsEndpoint":"ws://127.0.0.1:51234/devtools/browser/..."}`),
      ex(t('api.ex.puppeteer'), `const { wsEndpoint } = await (await fetch('${B}/profiles/<ID>/start', {\n  method: 'POST', headers: { Authorization: 'Bearer <TOKEN>', 'Content-Type': 'application/json' },\n  body: JSON.stringify({ debug: true }) })).json();\nconst browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });`),
      ex(t('api.ex.stop'), `curl -X POST ${H} ${B}/profiles/<ID>/stop`),
      ex(t('api.ex.proxy'), `curl -X POST ${H} -H "Content-Type: application/json" -d '{"text":"1.2.3.4:8080:user:pass"}' ${B}/proxies/check`));
    const eps = h('div', { class: 'endpoints' });
    for (const [m, path, key] of API_ENDPOINTS) eps.append(h('div', { class: 'ep' }, h('span', { class: `m m-${m.toLowerCase()}`, text: m }), h('code', { text: path }), h('span', { class: 'muted', text: t(key) })));
    clear(ref);
    ref.append(h('h2', {}, icon('menu', 17), ` ${t('api.reference')}`), eps);
  };
  const panel = h('div', { class: 'panel' });
  const examples = h('div', { class: 'panel' });
  const ref = h('div', { class: 'panel' });
  v.append(panel, examples, ref);
  draw(st);
}

const API_ENDPOINTS: Array<[string, string, string]> = [
  ['GET', '/v1/health', 'api.ep.health'],
  ['GET', '/v1/profiles', 'api.ep.list'],
  ['POST', '/v1/profiles', 'api.ep.create'],
  ['GET', '/v1/profiles/:id', 'api.ep.get'],
  ['PATCH', '/v1/profiles/:id', 'api.ep.update'],
  ['DELETE', '/v1/profiles/:id', 'api.ep.delete'],
  ['POST', '/v1/profiles/:id/start', 'api.ep.start'],
  ['POST', '/v1/profiles/:id/stop', 'api.ep.stop'],
  ['POST', '/v1/profiles/:id/fingerprint', 'api.ep.fingerprint'],
  ['PUT', '/v1/profiles/:id/proxy', 'api.ep.setProxy'],
  ['POST', '/v1/profiles/:id/proxy/check', 'api.ep.checkProfileProxy'],
  ['POST', '/v1/profiles/bulk', 'api.ep.bulk'],
  ['GET', '/v1/proxies', 'api.ep.proxies'],
  ['POST', '/v1/proxies', 'api.ep.addProxies'],
  ['PATCH', '/v1/proxies/:id', 'api.ep.updateProxy'],
  ['DELETE', '/v1/proxies/:id', 'api.ep.deleteProxy'],
  ['POST', '/v1/proxies/:id/check', 'api.ep.checkProxy'],
  ['POST', '/v1/proxies/parse', 'api.ep.parse'],
  ['POST', '/v1/proxies/check', 'api.ep.checkRaw'],
  ['POST', '/v1/fingerprints', 'api.ep.newFp'],
  ['GET', '/v1/fingerprints/meta', 'api.ep.fpMeta'],
];

// ------------------------------------------------------------------ security

/**
 * Running the whole of OctoBrowser inside a virtual machine whose only route
 * to the internet is a Whonix gateway.
 *
 * This is a guide, not a button: OctoBrowser cannot build the user's VMs for
 * them, and pretending otherwise would be worse than useless. Every step is
 * the documented Whonix/VirtualBox procedure, and the one thing that really
 * does not work in there - the Android emulator, which needs hardware
 * virtualisation the host does not hand down - is stated instead of hidden.
 */
function whonixPanel(): HTMLElement {
  const step = (n: number, key: string) =>
    h('li', { class: 'howto-step' }, h('span', { class: 'howto-num', text: String(n) }), h('span', { text: t(key) }));
  const list = h('ol', { class: 'howto' });
  const keys = ['sec.whonix.s1', 'sec.whonix.s2', 'sec.whonix.s3', 'sec.whonix.s4', 'sec.whonix.s5',
    'sec.whonix.s6', 'sec.whonix.s7', 'sec.whonix.s8', 'sec.whonix.s9'];
  keys.forEach((key, index) => list.append(step(index + 1, key)));
  const net = h('div', { class: 'howto-table' });
  const row = (a: string, b: string) => net.append(h('span', { class: 'muted', text: a }), h('span', { text: b }));
  row(t('sec.whonix.gateway'), 'Adapter 1: NAT · Adapter 2: Internal Network "Whonix"');
  row(t('sec.whonix.workstation'), 'Adapter 1: Internal Network "Whonix"');
  row(t('sec.whonix.ip'), '10.152.152.11-254 / 255.255.192.0 · gw 10.152.152.10 · DNS 10.152.152.10');
  const links = h('div', { class: 'row' });
  for (const [label, key] of [['whonix.org · download', 'whonix'],
    ['virtualbox.org', 'virtualbox'],
    ['whonix.org · other systems', 'whonix-other']] as const) {
    const link = h('button', { class: 'btn small' }, icon('globe', 14), h('span', { text: label }));
    link.onclick = () => void api.invoke('mgr:open-external', key);
    links.append(link);
  }
  return h('div', { class: 'panel' },
    h('h2', {}, icon('tor', 16), ` ${t('sec.whonix.title')}`),
    h('p', { text: t('sec.whonix.intro') }),
    h('details', { class: 'card-specs' }, h('summary', { text: t('sec.whonix.open') }),
      h('h3', { class: 'spec-title', text: t('sec.whonix.needs') }),
      h('p', { class: 'hint', text: t('sec.whonix.needsBody') }),
      h('h3', { class: 'spec-title', text: t('sec.whonix.steps') }),
      list,
      h('h3', { class: 'spec-title', text: t('sec.whonix.network') }),
      net,
      h('h3', { class: 'spec-title', text: t('sec.whonix.limits') }),
      h('p', { class: 'hint warn', text: t('sec.whonix.emulator') }),
      h('p', { class: 'hint', text: t('sec.whonix.smooth') }),
      h('p', { class: 'hint', text: t('sec.whonix.checks') }),
      links));
}

function renderSecurity(v: HTMLElement): void {
  v.append(h('div', { class: 'view-head' }, h('h1', { text: t('launcher.nav.security') })));
  const s = init.settings;
  const mins = select(String(s.security.autoLockMinutes), [['0', t('sec.never')], ['5', '5 min'], ['10', '10 min'], ['15', '15 min'], ['30', '30 min'], ['60', '60 min']], (val) => void saveSettings({ security: { autoLockMinutes: Number(val) } }));
  mins.disabled = !init.keyringRequiresPassword;
  const lockNow = h('button', { class: 'btn', text: t('sec.lockNow'), disabled: !init.keyringRequiresPassword, title: init.keyringRequiresPassword ? '' : t('sec.lockPhraseRequired') });
  lockNow.onclick = () => void run(api.invoke('mgr:lock-all')).then(() => render());

  const btnPrivacySexy = h('button', { class: 'btn primary small', text: t('sec.privacySexyBtn') }) as HTMLButtonElement;
  btnPrivacySexy.onclick = () => void api.invoke('mgr:open-external', 'privacy-sexy');
  const btnPrivacySexySearch = h('button', { class: 'btn small', text: t('sec.privacySexySearch') }) as HTMLButtonElement;
  btnPrivacySexySearch.onclick = () => void api.invoke('mgr:open-external', 'privacy-sexy-search');

  v.append(
    keyProtectionPanel(
      {
        keyringMode: init.keyringMode,
        requiresPassword: init.keyringRequiresPassword,
        secretBackend: 'local',
      },
      {
        setMasterPassword: (current, next, repeat) => api.invoke('mgr:master-password', 'set', current, next, repeat),
        removeMasterPassword: (current) => api.invoke('mgr:master-password', 'remove', current),
        confirm: (text, fn) => confirmDialog(text, fn, 'toast.saved', false),
      },
      () => { void refreshInit(); },
    ),
    h('div', { class: 'panel' }, h('h2', {}, icon('lock', 16), ` ${t('sec.autolock')}`), field('sec.autolockAfter', mins, 'sec.autolockHint'), !init.keyringRequiresPassword ? h('p', { class: 'hint', text: t('sec.lockPhraseRequired') }) : null, lockNow),
    h('div', { class: 'panel' },
      h('h2', {}, icon('shield', 16), ` ${t('sec.encryption')}`),
      h('p', { text: t('sec.encryptionDesc') }),
      h('p', { class: 'hint', text: t('enc.noRecovery') })),
    h('div', { class: 'panel' },
      h('h2', {}, icon('shieldCheck', 16), ` ${t('sec.privacySexyTitle')}`),
      h('p', { text: t('sec.privacySexyDesc') }),
      h('div', { class: 'row' }, btnPrivacySexy, btnPrivacySexySearch)),
    whonixPanel(),
  );
}

/** Re-read mgr:init so the security panel shows the current key protection state. */
async function refreshInit(): Promise<void> {
  const next = await api.invoke<Init>('mgr:init');
  if (!next) return;
  init.keyringMode = next.keyringMode;
  init.keyringRequiresPassword = next.keyringRequiresPassword;
  init.secretBackend = 'local';
  init.settings = next.settings;
  render();
}

async function saveSettings(patch: Record<string, unknown>): Promise<Settings | undefined> {
  const r = await run(api.invoke<Settings>('mgr:settings', patch), 'toast.saved');
  if (!r) return undefined;
  init.settings = r;
  applyLauncherTheme(r.ui.theme);
  return r;
}

// ------------------------------------------------------------------ updates

function renderUpdates(v: HTMLElement): void {
  const u = init.update;
  const s = init.settings;
  const offline = s.offlineMode !== 'online';
  v.append(h('div', { class: 'view-head' }, h('h1', { text: t('launcher.nav.updates') })));
  const p = h('div', { class: 'panel' });
  if (!u.configured) p.append(h('p', { class: 'note', text: t('upd.notConfigured') }));
  p.append(
    h('div', { class: 'kv' }, h('span', { text: t('upd.current') }), h('b', { text: u.current })),
    h('div', { class: 'kv' }, h('span', { text: t('upd.latest') }), h('b', { text: u.latest ?? t('state.unknown') })),
    h('div', { class: 'kv' }, h('span', { text: t('upd.lastCheck') }), h('span', { text: u.lastCheckAt ? new Date(u.lastCheckAt).toLocaleString() : t('state.never') })),
  );
  if (u.error) p.append(h('p', { class: 'err', text: u.error }));
  const row = h('div', { class: 'row' });
  const check = h('button', { class: 'btn', text: t('upd.checkNow'), disabled: offline });
  check.onclick = async () => { check.disabled = true; await run(api.invoke('mgr:update-check')); check.disabled = false; };
  row.append(check);
  if (u.available) {
    p.append(h('div', { class: 'kv' }, h('span', { text: t('upd.severity') }), h('span', { class: `pill ${u.severity === 'critical' || u.severity === 'security' ? 'bad' : 'warn'}`, text: t(`upd.sev.${u.severity ?? 'normal'}`) })));
    if (u.components?.length) p.append(h('div', { class: 'kv' }, h('span', { text: t('upd.components') }), h('span', { text: u.components.join(', ') })));
    if (u.changelog) p.append(h('h3', { text: t('upd.changelog') }), h('pre', { class: 'changelog', text: L(u.changelog) }));
    if (u.downloading) p.append(h('progress', { max: String(u.downloading.total || 1), value: String(u.downloading.done) }));
    if (u.readyToInstall) {
      const inst = h('button', { class: 'btn primary', text: t('upd.install') });
      inst.onclick = () => confirmDialog(t('upd.installConfirm'), () => api.invoke('mgr:update-install', u.readyToInstall), 'upd.installing');
      row.append(inst);
    } else if (!u.downloading) {
      const dl = h('button', { class: 'btn primary', text: t('upd.download'), disabled: offline });
      dl.onclick = () => void run(api.invoke('mgr:update-download'));
      row.append(dl);
    }
    const later = h('button', { class: 'btn', text: t('upd.postpone') });
    later.onclick = () => void run(api.invoke('mgr:update-postpone'), 'toast.saved');
    const skip = h('button', { class: 'btn', text: t('upd.skip') });
    skip.onclick = () => void run(api.invoke('mgr:update-skip', u.latest), 'toast.saved');
    row.append(later, skip);
  }
  p.append(row);
  v.append(p);

  v.append(h('div', { class: 'panel' }, h('h2', { text: t('upd.settings') }),
    toggle(s.updates.autoCheck, 'upd.autoCheck', (val) => void saveSettings({ updates: { autoCheck: val } })),
    h('p', { class: 'hint', text: t('upd.policy') }),
    toggle(s.updates.backgroundCheck, 'upd.background', (val) => void saveSettings({ updates: { backgroundCheck: val } })),
    field('upd.channel', select(s.updates.channel, [['stable', t('upd.stable')], ['beta', t('upd.beta')]], (val) => void saveSettings({ updates: { channel: val } }))),
  ));

  if (u.rollbackAvailable.length) {
    const rb = h('div', { class: 'panel' }, h('h2', { text: t('upd.rollback') }), h('p', { class: 'hint', text: t('upd.rollbackHint') }));
    for (const ver of u.rollbackAvailable) {
      const b = h('button', { class: 'btn', text: `${t('upd.rollbackTo')} ${ver}` });
      b.onclick = () => confirmDialog(t('upd.rollbackConfirm', { v: ver }), () => api.invoke('mgr:update-rollback', ver), 'upd.installing');
      rb.append(b);
    }
    v.append(rb);
  }

  const f = h('div', { class: 'panel' }, h('h2', { text: t('filters.title') }),
    h('p', { text: `${t('net.filtersUpdated')}: ${init.filtersUpdatedAt ? new Date(init.filtersUpdatedAt).toLocaleString() : t('state.never')}` }),
    h('p', { class: 'hint', text: offline ? t('settings.offlineActionBlocked') : t('filters.hint') }));
  const fu = h('button', { class: 'btn', text: t('filters.updateNow'), disabled: offline });
  fu.onclick = async () => {
    const r = await run(api.invoke<{ updated: string[]; failed: string[] } | null>('mgr:filters-update'));
    if (r) toast(t('filters.result', { ok: r.updated.length, failed: r.failed.length }), r.failed.length ? 'err' : 'ok');
  };
  f.append(fu);
  v.append(f);
}

// ------------------------------------------------------------------ settings

function renderSettings(v: HTMLElement): void {
  const s = init.settings;
  v.append(h('div', { class: 'view-head' }, h('h1', { text: t('launcher.nav.settings') })));
  const settingsSearch = input('', { type: 'search', class: 'settings-search', placeholder: t('settings.searchSettings'), 'aria-label': t('settings.searchSettings') });
  v.append(h('div', { class: 'settings-search-row' }, icon('search', 15), settingsSearch));
  settingsSearch.oninput = () => {
    const needle = settingsSearch.value.trim().toLocaleLowerCase();
    for (const panel of v.querySelectorAll<HTMLElement>('.panel')) {
      panel.classList.toggle('hidden', !!needle && !panel.innerText.toLocaleLowerCase().includes(needle));
    }
  };
  const lang = select(init.lang, [['en', 'English'], ['pl', 'Polski']], async (val) => {
    if ((await run(api.invoke('mgr:set-language', val))) !== undefined) {
      confirmDialog(t('settings.langRestart'), () => api.invoke('mgr:relaunch'), 'toast.saved');
    }
  });
  const openData = h('button', { class: 'btn' }, icon('folder', 15), ` ${t('settings.openData')}`);
  openData.onclick = () => void api.invoke('mgr:open-folder', 'data');
  const moveData = h('button', { class: 'btn' }, icon('folder', 15), ` ${t('settings.dataDirChange')}`);
  moveData.onclick = async () => {
    const picked = await run(api.invoke<string | null>('mgr:pick-folder'));
    if (!picked) return;
    const r = await run(api.invoke<{ ok: true; dataDir: string } | { ok: false; errorKey: string }>('mgr:move-data', picked, true));
    if (!r) return;
    if (!r.ok) { toast(t(r.errorKey), 'err'); return; }
    confirmDialog(t('settings.dataDirMoved', { path: s.ui.hideDirectoryPaths ? (t('settings.pathHidden') || '••••••••••••••••') : r.dataDir }), () => api.invoke('mgr:relaunch'), 'toast.saved');
  };
  const dataDirDisplay = s.ui.hideDirectoryPaths ? (t('settings.pathHidden') || '••••••••••••••••') : init.dataDir;
  v.append(h('div', { class: 'panel' }, h('h2', { text: t('settings.general') }),
    field('settings.language', lang),

    toggle(s.ui.virtualBoxMode, 'settings.virtualBoxMode', async (val) => {
      applyVirtualBoxMode(val);
      const patch: Partial<Settings['ui']> = { virtualBoxMode: val };
      if (val) patch.animations = false;
      await saveSettings({ ui: patch });
      confirmDialog(t('settings.vmModeRestart'), () => api.invoke('mgr:relaunch'), 'toast.saved');
    }),
    h('p', { class: 'hint', text: t('settings.virtualBoxModeHint') }),

    toggle(s.ui.hideDirectoryPaths, 'settings.hideDirectoryPaths', (val) => {
      void saveSettings({ ui: { hideDirectoryPaths: val } }).then(() => render());
    }),
    h('p', { class: 'hint', text: t('settings.hideDirectoryPathsHint') }),
    h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('settings.dataDir') }), h('code', { text: dataDirDisplay }), openData, moveData,
      h('span', { class: 'hint', text: t('settings.dataDirHint') }),
      h('span', { class: 'hint', text: t('settings.dataDirHint2') })),
  ));

  const archiveBody = h('div', { class: 'archive-list' }, h('p', { class: 'muted', text: t('settings.archiveLoading') }));
  v.append(h('div', { class: 'panel profile-archive-panel' }, h('h2', { text: t('settings.profileArchive') }),
    h('p', { class: 'hint', text: t('settings.profileArchiveHint') }), archiveBody));
  void run(api.invoke<Array<{ id: string; name: string; kind: string; archivedAt?: string }>>('mgr:archived')).then((archived) => {
    archiveBody.replaceChildren();
    if (!archived?.length) {
      archiveBody.append(h('p', { class: 'muted', text: t('settings.archiveEmpty') }));
      return;
    }
    for (const profile of archived) {
      const restore = h('button', { class: 'btn small', text: t('settings.archiveRestore') });
      restore.onclick = async () => {
        if ((await run(api.invoke('mgr:archive-restore', profile.id))) === undefined) return;
        restore.parentElement?.remove();
        if (!archiveBody.children.length) archiveBody.append(h('p', { class: 'muted', text: t('settings.archiveEmpty') }));
      };
      archiveBody.append(h('div', { class: 'archive-row' }, h('div', { class: 'grow' }, h('b', { text: profile.name }), h('span', { class: 'muted small', text: `${profile.kind} · ${profile.archivedAt ? new Date(profile.archivedAt).toLocaleString() : ''}` })), restore));
    }
  });

  v.append(pluginsPanel());

  const dolphinOffline = s.offlineMode !== 'online';
  const dolphinImport = h('button', { class: 'btn primary', disabled: dolphinOffline }, icon('import', 15), h('span', { text: t('dolphin.open') }));
  dolphinImport.onclick = () => openDolphinImportDialog();
  v.append(h('div', { class: 'panel dolphin-panel' }, h('h2', { text: t('dolphin.title') }),
    h('p', { text: t('dolphin.settingsIntro') }),
    h('p', { class: 'hint', text: dolphinOffline ? t('settings.offlineActionBlocked') : t('dolphin.settingsHint') }), dolphinImport));

  const themes: Array<[Settings['ui']['theme'], string, string]> = [
    ['ink', 'Ink', 'settings.theme.ink'], ['obsidian', 'Obsidian', 'settings.theme.obsidian'], ['slate', 'Slate', 'settings.theme.slate'],
    ['midnight', 'Midnight', 'settings.theme.midnight'], ['navy', 'Navy', 'settings.theme.navy'], ['charcoal', 'Charcoal', 'settings.theme.charcoal'],
    ['amethyst', 'Amethyst', 'settings.theme.amethyst'], ['purple', 'Purple', 'settings.theme.purple'], ['forest', 'Forest', 'settings.theme.forest'],
    ['emerald', 'Emerald', 'settings.theme.emerald'], ['olive', 'Olive', 'settings.theme.olive'], ['rose', 'Rose', 'settings.theme.rose'],
    ['sunset', 'Sunset', 'settings.theme.sunset'], ['copper', 'Copper', 'settings.theme.copper'],
    ['frutigerAero', 'Frutiger Aero', 'settings.theme.frutigerAero'], ['liquidGlass', 'Liquid Glass', 'settings.theme.liquidGlass'],
  ];
  const funThemes: Array<[Settings['ui']['theme'], string, string]> = [
    ['winterNight', 'Winter Night', 'settings.theme.winterNight'],
    ['winterDay', 'Winter Day', 'settings.theme.winterDay'],
    ['springBloom', 'Spring Bloom', 'settings.theme.springBloom'],
    ['summerSolstice', 'Summer Solstice', 'settings.theme.summerSolstice'],
    ['autumnHarvest', 'Autumn Harvest', 'settings.theme.autumnHarvest'],
    ['valentines', 'Valentine Glow', 'settings.theme.valentines'],
    ['halloweenDay', 'Halloween Day', 'settings.theme.halloweenDay'],
    ['halloweenNight', 'Halloween Night', 'settings.theme.halloweenNight'],
    ['kush', 'Kush Garden', 'settings.theme.kush'],
    ['tactical', 'Field Console', 'settings.theme.tactical'],
  ];
  const themeGrid = h('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': t('settings.theme') });
  const funGrid = h('div', { class: 'theme-grid fun-theme-grid', role: 'radiogroup', 'aria-label': t('settings.funThemes') });
  const preview = () => h('span', { class: 'theme-swatch', 'aria-hidden': 'true' },
    h('span', { class: 'theme-preview-bar' }, h('i'), h('i'), h('i')),
    h('span', { class: 'theme-preview-body' },
      h('span', { class: 'theme-preview-rail' }, h('i'), h('i'), h('i'), h('i')),
      h('span', { class: 'theme-preview-page' }, h('i', { class: 'wide' }), h('i'), h('i'), h('i', { class: 'short' })),
      h('span', { class: 'theme-preview-art' }, h('span', { class: 'theme-art-ring' }), h('span', { class: 'theme-art-icon' }))));
  const markTheme = (active: Settings['ui']['theme']) => {
    for (const item of v.querySelectorAll<HTMLElement>('.theme-card')) {
      const selected = item.dataset.theme === active;
      item.classList.toggle('on', selected);
      item.setAttribute('aria-checked', String(selected));
      const check = item.querySelector<HTMLElement>('.theme-check');
      if (check) check.replaceChildren(...(selected ? [icon('check', 14)] : []));
    }
  };
  const addThemeCards = (grid: HTMLElement, choices: Array<[Settings['ui']['theme'], string, string]>) => {
    for (const [id, name, desc] of choices) {
      const selected = s.ui.theme === id;
      const card = h('button', { type: 'button', class: `theme-card theme-${id}${selected ? ' on' : ''}`, 'data-theme': id, role: 'radio', 'aria-checked': String(selected) },
        h('span', { class: 'theme-check' }, selected ? icon('check', 14) : null), preview(), h('b', { text: name }), h('span', { text: t(desc) }));
    card.onclick = async () => {
      if (init.settings.ui.theme === id) return;
      const previous = init.settings.ui.theme;
      const doc = document as Document & { startViewTransition?: (callback: () => void) => { finished: Promise<void> } };
      if (doc.startViewTransition) doc.startViewTransition(() => applyLauncherTheme(id));
      else applyLauncherTheme(id);
      document.documentElement.classList.add('theme-changing');
      markTheme(id);
      const saved = await saveSettings({ ui: { theme: id } });
      if (!saved) { applyLauncherTheme(previous); markTheme(previous); }
      window.setTimeout(() => document.documentElement.classList.remove('theme-changing'), 260);
    };
      grid.append(card);
    }
  };
  addThemeCards(themeGrid, themes);
  addThemeCards(funGrid, funThemes);
  const funPanel = h('details', { class: 'fun-themes-panel' }) as HTMLDetailsElement;
  funPanel.open = funThemes.some(([id]) => s.ui.theme === id);
  funPanel.append(h('summary', { text: t('settings.funThemes') }), h('p', { class: 'hint', text: t('settings.funThemesHint') }), funGrid);
  const themePanel = h('details', { class: 'panel theme-panel theme-panel-collapsible' }) as HTMLDetailsElement;
  themePanel.open = sessionStorage.getItem('octo-themes-open') === '1';
  themePanel.addEventListener('toggle', () => sessionStorage.setItem('octo-themes-open', themePanel.open ? '1' : '0'));
  themePanel.append(
    h('summary', { class: 'theme-panel-summary' },
      h('span', { class: 'theme-summary-title' }, h('h2', { text: t('settings.theme') })),
      h('span', { class: 'theme-summary-hint', text: t('settings.themeHint') })),
    h('div', { class: 'theme-panel-content' }, h('p', { class: 'hint', text: t('settings.themeHint') }), themeGrid, funPanel),
  );
  v.append(themePanel);

  const navRows = h('div', { class: 'sidebar-prefs' });
  const currentSidebar = [...(s.ui.sidebar ?? s.ui.navOrder.map((id) => ({ id, visible: !s.ui.navHidden.includes(id) })) )];
  const updateSidebar = async (sidebar: Array<{ id: View; visible: boolean }>) => {
    const preservedView = S.view;
    captureSidebarMotion();
    await saveSettings({ ui: { sidebar } });
    // A sidebar preference is not a navigation action. Keep the page the user
    // was editing (including Settings) instead of falling back to Profiles
    // after the manager sends the updated settings snapshot.
    if (VALID_VIEWS.includes(preservedView)) {
      S.view = preservedView;
      try { sessionStorage.setItem('octo.launcher.view', preservedView); } catch { /* ignore */ }
    }
    // Always restore the controls if saving failed. This prevents a partially
    // updated sidebar from ever leaving the launcher visually empty.
    render();
  };
  for (const entry of currentSidebar) {
    const view = entry.id;
    const glyph = NAV.find(([id]) => id === view)?.[1] ?? 'info';
    const index = currentSidebar.findIndex((item) => item.id === view);
    const up = h('button', { class: 'icon-btn tiny nav-move up', title: t('settings.sidebarUp'), 'aria-label': t('settings.sidebarUp'), disabled: index <= 0 }, icon('back', 14));
    const down = h('button', { class: 'icon-btn tiny nav-move down', title: t('settings.sidebarDown'), 'aria-label': t('settings.sidebarDown'), disabled: index < 0 || index >= currentSidebar.length - 1 }, icon('back', 14));
    up.onclick = () => {
      const next = [...currentSidebar];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      void updateSidebar(next);
    };
    down.onclick = () => {
      const next = [...currentSidebar];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      void updateSidebar(next);
    };
    const visible = toggle(entry.visible, `launcher.nav.${view}`, (on) => {
      void updateSidebar(currentSidebar.map((item) => item.id === view ? { ...item, visible: on } : item));
    });
    navRows.append(h('div', { class: 'sidebar-pref-row', 'data-nav-view': view }, h('span', { class: 'sidebar-pref-icon' }, icon(glyph, 16)), visible, h('div', { class: 'sidebar-pref-actions' }, up, down)));
  }
  const restoreNav = h('button', { class: 'btn small', text: t('settings.sidebarRestore') });
  restoreNav.onclick = () => void updateSidebar(NAV.map(([id]) => ({ id, visible: true })));
  v.append(h('div', { class: 'panel sidebar-panel' }, h('h2', { text: t('settings.sidebar') }), h('p', { class: 'hint', text: t('settings.sidebarHint') }), navRows, h('div', { class: 'row' }, restoreNav), h('p', { class: 'hint', text: t('settings.sidebarShortcut') })));
  playSidebarMotion('.sidebar-pref-row[data-nav-view]', sidebarRowPositions);
  sidebarRowPositions = null;

  const factoryReset = h('button', { class: 'btn danger' }, icon('trash', 15), ` ${t('settings.resetApp')}`);
  factoryReset.onclick = () => confirmDialog(t('settings.resetAppConfirm'), () => api.invoke('mgr:factory-reset'), 'settings.resetRestarting');
  v.append(h('div', { class: 'panel danger-zone' }, h('h2', { text: t('settings.resetTitle') }),
    h('p', { text: t('settings.resetAppDesc') }),
    h('p', { class: 'hint', text: t('settings.resetAppNote') }), factoryReset));

  const offline = s.offlineMode !== 'online';
  const offlineMode = select(s.offlineMode, [
    ['online', t('settings.offlineMode.online')],
    ['practical', t('settings.offlineMode.practical')],
    ['strict', t('settings.offlineMode.strict')],
  ], async (val) => { await saveSettings({ offlineMode: val }); render(); });
  v.append(h('div', { class: `panel offline-policy ${offline ? 'active' : ''}` }, h('h2', { text: t('settings.offlineMode') }),
    field('settings.offlineMode', offlineMode),
    h('p', { text: t(`settings.offlineMode.${s.offlineMode}.desc`) }),
    h('p', { class: 'hint', text: s.offlineMode === 'strict' ? t('settings.offlineMode.strictNote') : t('settings.offlineMode.profiles') })));

  const dnsMode = select(s.network.dns.mode, [['system', t('dns.system')], ['doh', t('dns.doh')]], (val) => void saveSettings({ network: { dns: { mode: val } } }));
  const dnsProv = select(s.network.dns.provider, [['quad9', 'Quad9'], ['cloudflare', 'Cloudflare'], ['mullvad', 'Mullvad'], ['custom', t('dns.custom')]], (val) => void saveSettings({ network: { dns: { provider: val } } }));
  const custom = h('input', { type: 'text', value: s.network.dns.customTemplate, placeholder: 'https://.../dns-query', maxlength: '512' }) as HTMLInputElement;
  dnsMode.disabled = offline;
  dnsProv.disabled = offline;
  custom.disabled = offline;
  custom.onchange = () => void saveSettings({ network: { dns: { customTemplate: custom.value.trim() } } });
  v.append(h('div', { class: 'panel' }, h('h2', { text: t('settings.network') }),
    field('dns.appWide', dnsMode), field('dns.provider', dnsProv), field('dns.template', custom),
    toggle(s.network.publicIpLookup, 'settings.ipLookup', (val) => void saveSettings({ network: { publicIpLookup: val } }), offline),
    h('p', { class: 'hint', text: offline ? t('settings.offlineDohDisabled') : t('firstRun.ipLookupDesc') }),
    toggle(s.network.autoRefresh, 'net.autoRefresh', (val) => void saveSettings({ network: { autoRefresh: val } }), offline),
    field('search.engine', select(s.network.searchEngine, (init?.searchEngines ?? []).map((id) => [id, t(`settings.search.${id}`)] as [string, string]), (val) => void saveSettings({ network: { searchEngine: val } })), 'search.engineHint'),
    h('p', { class: 'muted small', text: t('settings.latencyNote') }),
    (() => { const button = h('button', { class: 'btn small', text: t('settings.checkLatency') }); const result = h('span', { class: 'muted small' }); button.disabled = offline; button.onclick = async () => { button.disabled = true; result.textContent = t('settings.latencyChecking'); try { const rows = await api.invoke<Array<{ engine: string; state: string; latencyMs: number | null }>>('settings:search:latency'); result.textContent = rows.map((r) => `${r.engine}: ${r.state}${r.latencyMs === null ? '' : ` ${r.latencyMs} ms`}`).join(' · '); } finally { button.disabled = offline; } }; return h('div', { class: 'set-row' }, button, result); })(),
  ));

  const sleep = select(String(s.ui.sleepTabsAfterMin), [['0', t('sec.never')], ['15', '15 min'], ['30', '30 min'], ['60', '60 min'], ['120', '120 min']], (val) => void saveSettings({ ui: { sleepTabsAfterMin: Number(val) } }));
  v.append(h('div', { class: 'panel' }, h('h2', { text: t('settings.tabs') }),
    toggle(s.ui.verticalTabs, 'menu.verticalTabs', (val) => void saveSettings({ ui: { verticalTabs: val } })),
    field('settings.sleepTabs', sleep, 'settings.sleepTabsHint'),
    toggle(s.ui.showBookmarksBar, 'menu.showBookmarksBar', (val) => void saveSettings({ ui: { showBookmarksBar: val } })),
    toggle(s.ui.confirmOnQuit, 'settings.confirmOnQuit', (val) => void saveSettings({ ui: { confirmOnQuit: val } }), false),
    toggle(s.ui.closeCountdown, 'settings.closeCountdown', (val) => void saveSettings({ ui: { closeCountdown: val } }), !s.ui.confirmOnQuit),
    h('p', { class: 'hint', text: t('settings.closeCountdownHint') }),
    toggle(s.ui.openLinksInBackground, 'settings.openLinksInBackground', (val) => void saveSettings({ ui: { openLinksInBackground: val } })),
  ));

  const torPick = h('button', { class: 'btn', text: t('tor.pick') });
  torPick.onclick = async () => { const r = await run(api.invoke<string | null>('mgr:pick-tor')); if (r) { init.settings.tor.torBrowserPath = r; render(); } };
  const torDl = h('button', { class: 'btn', text: t('tor.download') });
  torDl.onclick = () => void api.invoke('mgr:open-external', 'tor');
  const torPathDisplay = s.ui.hideDirectoryPaths && s.tor.torBrowserPath ? (t('settings.pathHidden') || '••••••••••••••••') : (s.tor.torBrowserPath || (init.torBrowser ? t('tor.autoDetected') : t('tor.notFound')));
  v.append(h('div', { class: 'panel' }, h('h2', { text: 'Tor Browser' }),
    h('p', { text: torPathDisplay }),
    h('p', { class: 'hint', text: t('tor.why') }), h('div', { class: 'row' }, torPick, torDl)));
}

// ------------------------------------------------------------------ logs & backups

async function renderLogs(v: HTMLElement): Promise<void> {
  v.append(h('div', { class: 'view-head' }, h('h1', { text: t('launcher.nav.logs') })));
  const enabled = init.logMode !== 'off';
  const mode = select(enabled ? init.logMode : 'standard', [['standard', t('logs.standard')], ['diagnostic', t('logs.diagnostic')]], async (val) => {
    const r = await run(api.invoke<'off' | 'standard' | 'diagnostic'>('mgr:log-mode', val), 'toast.saved');
    if (r) { init.logMode = r; render(); }
  });
  mode.disabled = !enabled;
  const logging = toggle(enabled, 'logs.enabled', async (on) => {
    const r = await run(api.invoke<'off' | 'standard' | 'diagnostic'>('mgr:log-mode', on ? 'standard' : 'off'), 'toast.saved');
    if (r) { init.logMode = r; render(); }
  });
  const del = h('button', { class: 'btn danger', disabled: !enabled }, icon('trash', 15), ` ${t('logs.delete')}`);
  del.onclick = async () => { const n = await run(api.invoke<number>('mgr:logs-clear')); if (n !== undefined) toast(t('logs.deleted', { n }), 'ok'); };
  const open = h('button', { class: 'btn', disabled: !enabled }, icon('folder', 15), ` ${t('logs.open')}`);
  open.onclick = () => void api.invoke('mgr:open-folder', 'logs');
  v.append(h('div', { class: 'panel' }, h('h2', { text: t('logs.title') }), logging, field('logs.mode', mode, 'logs.modeHint'), h('p', { class: 'hint', text: t('logs.retention') }), h('p', { class: 'hint', text: t('logs.noSecrets') }), h('div', { class: 'row' }, open, del)));

  const b = await run(api.invoke<{ settings: string[]; profiles: string[] }>('mgr:backups'));
  const panel = h('div', { class: 'panel' }, h('h2', { text: t('backups.title') }), h('p', { class: 'hint', text: t('backups.hint') }));
  for (const which of ['profiles', 'settings'] as const) {
    panel.append(h('h3', { text: t(`backups.${which}`) }));
    const list = b?.[which] ?? [];
    if (!list.length) panel.append(h('p', { class: 'muted', text: t('backups.none') }));
    for (const name of list.slice(0, 15)) {
      const r = h('button', { class: 'btn small', text: t('backups.restore') });
      r.onclick = () => confirmDialog(t('backups.restoreConfirm', { name }), () => api.invoke('mgr:backup-restore', which, name), 'toast.restored');
      panel.append(h('div', { class: 'kv' }, h('code', { text: name }), r));
    }
  }
  const openB = h('button', { class: 'btn' }, icon('folder', 15), ` ${t('backups.open')}`);
  openB.onclick = () => void api.invoke('mgr:open-folder', 'backups');
  panel.append(openB);
  v.append(panel);
}

// ------------------------------------------------------------------ about

function renderAbout(v: HTMLElement): void {
  v.append(h('div', { class: 'view-head' }, h('h1', { text: t('launcher.nav.about') })));
  const conns = h('ul', {});
  for (const k of ['conn.updates', 'conn.filters', 'conn.ip', 'conn.doh', 'conn.search', 'conn.pages']) conns.append(h('li', { text: t(k) }));
  v.append(
    h('div', { class: 'panel' }, h('h2', { text: `Octo.su ${init.version}` }), h('p', { text: t('about.desc') }), h('p', { class: 'hint', text: t('status.noGuarantee') })),
    h('div', { class: 'panel' }, h('h2', { text: t('about.connections') }), h('p', { class: 'hint', text: t('about.telemetryOff') }), conns),
    h('div', { class: 'panel' }, h('h2', { text: t('about.licenses') }), h('p', { text: t('about.licensesDesc') })),
  );
}

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  init = await api.invoke<Init>('mgr:init');
  initWindowControls();
  S.init = init;
  init.settings.api ??= { enabled: false, port: 35555 };
  applyVirtualBoxMode(!!init.settings.ui.virtualBoxMode);
  applyLauncherTheme(init.settings.ui.theme);
  setDicts(init.dicts);
  setLang(init.lang);
  document.documentElement.lang = init.lang;
  applyI18n();
  railCollapsed = sessionStorage.getItem('octo-rail-collapsed') === '1';
  $('railToggle').onclick = () => { railCollapsed = !railCollapsed; sessionStorage.setItem('octo-rail-collapsed', railCollapsed ? '1' : '0'); applyRailState(); };
  applyRailState();
  S.profiles = await api.invoke<Profile[]>('mgr:profiles');
  S.proxies = (await api.invoke<SavedProxy[]>('mgr:proxies').catch(() => [])) ?? [];
  const q = new URLSearchParams(location.search).get('tab');
  if (q && NAV.some(([x]) => x === q)) S.view = q as View;
  else {
    try {
      const remembered = sessionStorage.getItem('octo.launcher.view');
      if (remembered && NAV.some(([x]) => x === remembered)) S.view = remembered as View;
    } catch { /* ignore unavailable session storage */ }
  }
  // Re-render lists only when no text field has focus, so typing is never interrupted.
  const soft = () => {
    const a = document.activeElement;
    if ((S.view === 'profiles' || S.view === 'proxies') && !(a instanceof HTMLInputElement && a.type !== 'checkbox' && $('view').contains(a))) render();
    else { renderStatus(); if (S.view === 'profiles') renderFolders($('side2')); }
  };
  api.on<Profile[]>('mgr:profiles', (list) => { S.profiles = list; soft(); });
  api.on<SavedProxy[]>('mgr:proxies', (list) => { S.proxies = list; soft(); });
  api.on<UpdateStatus>('mgr:update-status', (u) => { init.update = u; renderNav(); });
  api.on<{ key: string; params?: Record<string, string | number>; kind?: 'ok' | 'err' | 'info' }>('mgr:toast', (m) => toast(t(m.key, m.params), m.kind));
  api.on<string>('mgr:show-tab', (tab) => {
    if (NAV.some(([x]) => x === tab)) {
      S.view = tab as View;
      try { sessionStorage.setItem('octo.launcher.view', S.view); } catch { /* ignore */ }
      render();
    }
  });
  api.on('mgr:app-close-request', () => showCloseAppDialog());
  api.on<{ operation: 'move' | 'delete'; completed: number; total: number; percent: number; label?: string }>('mgr:file-progress', showFileProgress);
  document.addEventListener('keydown', (e) => {
    // Sidebar pages can all be hidden deliberately; retain a local escape hatch.
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      void (async () => { await saveSettings({ ui: { sidebar: NAV.map(([id]) => ({ id, visible: true })) } }); S.view = 'settings'; render(); })();
      return;
    }
    if (e.key === 'Escape') { closePopup(); if (!$('modal').classList.contains('hidden')) closeModal(); }
  });
  $('modal').addEventListener('mousedown', (e) => { if (e.target === $('modal')) closeModal(); });
  render();
}

boot().catch((err) => {
  document.body.append(h('pre', { class: 'fatal', text: `Launcher error: ${String((err as Error)?.message ?? err)}` }));
});

/**
 * Plugins panel. The two vStudio products are separate programs with separate
 * switches: vStudio Mobile is a standalone virtual camera/microphone on this
 * computer, vStudio Web publishes one for the browser profiles. Android
 * devices read a real camera and never go through either of them. Switching
 * one off stops it immediately.
 */
function pluginsPanel(): HTMLElement {
  const panel = h('div', { class: 'panel plugins-panel' },
    h('h2', { text: t('plugins.title') }),
    h('p', { class: 'hint', text: t('plugins.intro') }));
  const list = h('div', { class: 'plugin-list' }, h('p', { class: 'small muted', text: t('state.loading') }));
  panel.append(list);
  void (async () => {
    const [entries, core] = await Promise.all([
      run(api.invoke<PluginEntry[]>('mgr:plugins')),
      run(api.invoke<CorePluginEntry[]>('mgr:core-plugins')),
    ]);
    clear(list);
    if (!entries?.length && !core?.length) { list.append(h('p', { class: 'small muted', text: t('plugins.none') })); return; }
    if (entries?.length) {
      list.append(h('h3', { class: 'plugin-group-title', text: t('plugins.optional') }));
      for (const entry of entries) list.append(pluginRow(entry));
    }
    if (core?.length) {
      list.append(h('h3', { class: 'plugin-group-title', text: t('plugins.builtIn') }));
      for (const entry of core) list.append(corePluginRow(entry));
    }
  })();
  return panel;
}

function corePluginRow(entry: CorePluginEntry): HTMLElement {
  return h('div', { class: 'plugin-row core-plugin-row' },
    h('div', { class: 'plugin-head' },
      h('b', { text: t(entry.nameKey) }),
      h('span', { class: 'pill', text: t(entry.scopeKey) }),
      h('span', { class: `pill ${entry.ready ? 'ok' : 'warn'}`, text: t(entry.ready ? 'plugins.ready' : 'plugins.needsSetup') })),
    h('p', { class: 'small', text: t(entry.descriptionKey) }),
    entry.detail ? h('p', { class: 'small muted ell', text: entry.detail }) : null,
    h('div', { class: 'row' }, h('span', { class: 'core-plugin-lock' }, icon('shieldCheck', 14), h('span', { text: t('plugins.builtInManaged') }))));
}

function pluginRow(entry: PluginEntry): HTMLElement {
  const enabled = init.settings.plugins?.[entry.id]?.enabled ?? entry.status.enabled;
  const state = h('span', { class: `pill ${entry.status.running ? 'ok' : ''}`, text: t(entry.status.running ? 'plugins.running' : enabled ? 'plugins.idle' : 'plugins.off') });
  const power = h('button', { class: 'btn small', text: t(entry.status.running ? 'plugins.stop' : 'plugins.start'), disabled: !enabled || !entry.status.bundleAvailable || (!entry.status.running && !entry.status.ready) }) as HTMLButtonElement;
  power.onclick = async () => {
    power.disabled = true;
    if (entry.status.running) await run(api.invoke<boolean>('mgr:plugin-stop', entry.id));
    else {
      const r = await run(api.invoke<{ started: boolean; message: string }>('mgr:plugin-start', entry.id));
      if (r && !r.started) toast(t('plugins.startFailed', { name: entry.name }), 'err', r.message);
    }
    render();
  };
  const switchRow = toggle(enabled, 'plugins.enabled', async (value) => {
    await saveSettings({ plugins: { [entry.id]: { enabled: value } } });
    render();
  });
  // Requirements are per plugin: vStudio Web never asks for an Android SDK.
  // A missing piece the app can install carries its own button - telling the
  // user to "run install.bat" while they are looking at this panel is not an
  // answer.
  const installHost = h('div', {});
  const requirements = h('div', { class: 'plugin-reqs' });
  for (const item of entry.status.requirements ?? []) {
    const chip = h('span', { class: `pill ${item.ok ? 'ok' : item.required === false ? 'warn' : 'bad'}`, text: `${t(item.key)}: ${t(item.ok ? 'state.on' : 'state.off')}` });
    requirements.append(chip);
    if (item.ok || !item.fixable || !item.id) continue;
    const fix = h('button', { class: 'btn small', title: item.vendor ?? '' }, icon('download', 13), h('span', { text: t('plugins.install', { name: t(item.key) }) }));
    fix.onclick = async () => {
      fix.disabled = true;
      const done = await runInstall(installHost, {
        title: t(item.key),
        note: item.vendor ? t('plugins.installFrom', { vendor: item.vendor }) : undefined,
        task: () => api.invoke<{ ok: boolean; message: string; needsRestart?: boolean }>('mgr:plugin-install-requirement', item.id ?? ''),
      });
      fix.disabled = false;
      if (done) render();
    };
    requirements.append(fix);
  }
  const recheck = h('button', { class: 'btn small' }, icon('refreshCircle', 13), h('span', { text: t('plugins.recheck') }));
  recheck.onclick = () => render();
  // A new vStudio in this build is worthless while the old copy is staged.
  const update = h('button', { class: `btn small${entry.status.updateAvailable ? ' primary' : ''}` }, icon('download', 13),
    h('span', { text: t(entry.status.updateAvailable ? 'plugins.updateNow' : 'plugins.reinstall') }));
  update.onclick = () => void busy(update, 'plugins.updating', async () => {
    const done = await run(api.invoke<{ ok: boolean; message: string }>('mgr:plugin-update', entry.id));
    if (done) toast(t(done.ok ? 'plugins.updated' : 'plugins.updateFailed'), done.ok ? 'ok' : 'err', done.message);
    render();
  });
  return h('div', { class: 'plugin-row' },
    h('div', { class: 'plugin-head' },
      h('b', { text: entry.name }),
      h('span', { class: 'pill', text: t(entry.scope === 'android' ? 'plugins.scopeAndroid' : 'plugins.scopeBrowser') }),
      state),
    h('p', { class: 'small', text: t(entry.descriptionKey) }),
    !entry.status.bundleAvailable ? h('p', { class: 'small muted', text: t('plugins.noBundle') }) : null,
    requirements,
    installHost,
    enabled && !entry.status.ready ? h('p', { class: 'small warn', text: t('plugins.notReady') }) : null,
    enabled && entry.status.ready && entry.status.complete === false ? h('p', { class: 'small warn', text: t('plugins.partly') }) : null,
    enabled && entry.status.installed ? h('p', { class: 'small muted ell', text: entry.status.path }) : null,
    entry.status.updateAvailable ? h('p', { class: 'small warn', text: t('plugins.updateAvailable') }) : null,
    h('div', { class: 'row' }, switchRow, power, recheck, update));
}
