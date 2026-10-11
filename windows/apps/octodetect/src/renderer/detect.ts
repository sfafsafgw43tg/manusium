/**
 * apps/octodetect/src/renderer/detect.ts
 *
 * OctoDetect UI: choose an audit target, run it, show the report (risk level,
 * estimated uniqueness, findings with "why" and "how to reduce"), manage
 * saved (encrypted) reports, export on request, updates, settings, logs.
 *
 * Wording rules: risk is low / medium / high / cannot be determined; we never
 * claim "undetectable" or "100% anonymous".
 */
import { api, clear } from '@octo/shell/renderer/bridge';
import { applyI18n, h, setDicts, setLang, t, Dicts } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { keyProtectionPanel } from '@octo/shell/renderer/keypanel';

type Target = 'baseline' | 'standard' | 'strict' | 'external';
type Risk = 'low' | 'medium' | 'high' | 'unknown';
interface Finding { id: string; category: string; value: string; status: 'exposed' | 'limited' | 'blocked' | 'unknown'; entropy: 'low' | 'medium' | 'high'; points: number; whyKey: string; fixKey?: string }
interface Report {
  id: string; target: Target; generatedAt: string; risk: Risk; score: number; findings: Finding[]; consistency: Array<{ key: string; detail: string }>;
  highEntropyExposed: number; uniqueness: 'likely-common' | 'possibly-unique' | 'likely-unique' | 'unknown'; dns: string; webrtc: string; fingerprintHash: string;
}
interface ReportMeta { id: string; target: Target; generatedAt: string; risk: Risk; score: number }
interface UpdateStatus { configured: boolean; current: string; latest: string | null; available: boolean; severity?: string; changelog?: { en: string; pl: string }; lastCheckAt?: string; error?: string; downloading?: { done: number; total: number }; readyToInstall?: string; rollbackAvailable: string[] }
interface Init {
  lang: 'en' | 'pl'; dicts: Dicts; version: string; dataDir: string; update: UpdateStatus; logMode: 'off' | 'standard' | 'diagnostic';

  settings: { network: { publicIpLookup: boolean }; offline: boolean; updates: { autoCheck: boolean; backgroundCheck: boolean }; security: { autoLockMinutes: number; secretStore: 'local' }; ui?: { hideDirectoryPaths?: boolean; virtualBoxMode?: boolean } };

  keyringMode: 'os' | 'password' | null; keyringRequiresPassword: boolean; secretBackend: 'local';
}
type View = 'audit' | 'reports' | 'updates' | 'settings' | 'logs' | 'about';

let init: Init;
let view: View = 'audit';
let target: Target = 'standard';
let current: Report | null = null;
let running = false;
let stage = '';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function toast(text: string, kind: 'ok' | 'err' | 'info' = 'info'): void {
  const el = h('div', { class: `toast ${kind}`, text });
  $('toasts').append(el);
  setTimeout(() => el.remove(), 4500);
}
async function run<T>(p: Promise<T>, okKey?: string): Promise<T | undefined> {
  try { const r = await p; if (okKey) toast(t(okKey), 'ok'); return r; } catch (err) { toast(String((err as Error).message ?? err), 'err'); return undefined; }
}
function toggle(checked: boolean, key: string, onChange: (v: boolean) => void): HTMLElement {
  const inp = h('input', { type: 'checkbox', checked });
  inp.onchange = () => onChange(inp.checked);
  return h('label', { class: 'toggle' }, inp, h('span', { class: 'sw' }), h('span', { text: t(key) }));
}
function closeModal(): void { $('modal').classList.add('hidden'); clear($('modalBox')); }
function confirmDialog(text: string, fn: () => Promise<unknown>, okKey: string): void {
  const box = $('modalBox');
  clear(box);
  const ok = h('button', { class: 'btn primary', text: t('common.confirm') });
  ok.onclick = async () => { if ((await run(fn(), okKey)) !== undefined) closeModal(); };
  const cancel = h('button', { class: 'btn', text: t('common.cancel') });
  cancel.onclick = closeModal;
  box.append(h('p', { text }), h('div', { class: 'modal-actions' }, cancel, ok));
  $('modal').classList.remove('hidden');
}

// ------------------------------------------------------------------ nav

const NAV: Array<[View, string]> = [['audit', 'fingerprint'], ['reports', 'report'], ['updates', 'refreshCircle'], ['settings', 'settings'], ['logs', 'file'], ['about', 'info']];

function render(): void {
  const nav = $('nav');
  clear(nav);
  for (const [v, ic] of NAV) {
    const b = h('button', { class: `nav-item${v === view ? ' active' : ''}` }, icon(ic, 18), h('span', { text: t(`od.nav.${v}`) }));
    if (v === 'updates' && init.update.available) b.append(h('span', { class: 'dot-badge' }));
    b.onclick = () => { view = v; render(); };
    nav.append(b);
  }
  $('sideFoot').textContent = `v${init.version}`;
  const el = $('view');
  clear(el);
  switch (view) {
    case 'audit': renderAudit(el); break;
    case 'reports': void renderReports(el); break;
    case 'updates': renderUpdates(el); break;
    case 'settings': renderSettings(el); break;
    case 'logs': renderLogs(el); break;
    case 'about': renderAbout(el); break;
  }
}

// ------------------------------------------------------------------ audit

function renderAudit(v: HTMLElement): void {
  v.append(h('div', { class: 'view-head' }, h('div', {}, h('h1', { text: t('od.nav.audit') }), h('p', { class: 'muted', text: t('od.auditIntro') }))));
  const cards = h('div', { class: 'targets' });
  const TARGETS: Array<[Target, string]> = [['baseline', 'globe'], ['standard', 'shield'], ['strict', 'shieldCheck'], ['external', 'eye']];
  for (const [tg, ic] of TARGETS) {
    const c = h('button', { class: `target${tg === target ? ' on' : ''}`, disabled: running }, icon(ic, 22), h('b', { text: t(`target.${tg}`) }), h('span', { class: 'small muted', text: t(`target.${tg}.desc`) }));
    c.onclick = () => { target = tg; render(); };
    cards.append(c);
  }
  v.append(cards);
  const go = h('button', { class: 'btn primary big', disabled: running }, icon('play', 16), ` ${t(running ? 'audit.running' : 'audit.run')}`);
  go.onclick = () => void startAudit();
  const row = h('div', { class: 'row' }, go);
  if (running) {
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = () => void api.invoke('od:audit-cancel');
    row.append(cancel, h('span', { class: 'muted', text: t(`audit.stage.${stage || 'probe'}`) }), h('span', { class: 'spinner' }));
  }
  v.append(row);
  if (target === 'external') v.append(h('p', { class: 'info', text: t('target.external.howto') }));
  if (!init.settings.network.publicIpLookup) v.append(h('p', { class: 'hint', text: t('audit.ipConsentOff') }));
  if (current) renderReport(v, current);
}

async function startAudit(): Promise<void> {
  running = true;
  stage = 'probe';
  current = null;
  render();
  const r = await run(api.invoke<Report>('od:audit', target));
  running = false;
  if (r) current = r;
  render();
}

function riskClass(r: Risk): string { return r === 'low' ? 'ok' : r === 'medium' ? 'warn' : r === 'high' ? 'bad' : 'unknown'; }
function statusClass(s: string): string { return s === 'blocked' ? 'ok' : s === 'limited' ? 'warn' : s === 'exposed' ? 'bad' : 'unknown'; }
function leakClass(s: string): string { return s === 'ok' ? 'ok' : s === 'warning' ? 'warn' : s === 'leak' ? 'bad' : 'unknown'; }

function renderReport(v: HTMLElement, r: Report): void {
  const pct = Math.min(100, Math.round((r.score / 14) * 100));
  const gauge = h('div', { class: `gauge ${riskClass(r.risk)}` }, h('div', { class: 'gauge-inner' }, h('b', { text: t(`risk.${r.risk}`) }), h('span', { class: 'small muted', text: `${t('report.score')}: ${r.score}` })));
  gauge.style.setProperty('--p', `${r.risk === 'unknown' ? 0 : Math.max(pct, 6)}`);
  const summary = h('div', { class: 'summary' },
    h('div', { class: 'kv' }, h('span', { text: t('report.target') }), h('b', { text: t(`target.${r.target}`) })),
    h('div', { class: 'kv' }, h('span', { text: t('report.uniqueness') }), h('span', { class: `pill ${r.uniqueness === 'likely-unique' ? 'bad' : r.uniqueness === 'possibly-unique' ? 'warn' : r.uniqueness === 'unknown' ? 'unknown' : 'ok'}`, text: t(`uniq.${r.uniqueness}`) })),
    h('div', { class: 'kv' }, h('span', { text: 'DNS' }), h('span', { class: `pill ${leakClass(r.dns)}`, text: t(`leak.${r.dns}`) })),
    h('div', { class: 'kv' }, h('span', { text: 'WebRTC' }), h('span', { class: `pill ${leakClass(r.webrtc)}`, text: t(`leak.${r.webrtc}`) })),
    h('div', { class: 'kv' }, h('span', { text: t('report.highEntropy') }), h('b', { text: String(r.highEntropyExposed) })),
    h('div', { class: 'kv' }, h('span', { text: t('report.generated') }), h('span', { text: new Date(r.generatedAt).toLocaleString() })),
  );
  const head = h('div', { class: 'report-head' }, gauge, summary);
  const exp = h('div', { class: 'row' });
  for (const fmt of ['html', 'json'] as const) {
    const b = h('button', { class: 'btn' }, icon('export', 15), ` ${t(`report.export.${fmt}`)}`);
    b.onclick = () => void run(api.invoke<boolean>('od:report-export', r.id, fmt)).then((ok) => { if (ok) toast(t('toast.exported'), 'ok'); });
    exp.append(b);
  }
  v.append(h('section', { class: 'panel' }, head, h('p', { class: 'hint', text: t(`risk.${r.risk}.desc`) }), h('p', { class: 'hint', text: t('report.disclaimer') }), exp));

  if (r.consistency.length) {
    const ul = h('ul', {});
    for (const c of r.consistency) ul.append(h('li', {}, t(c.key), ' ', h('code', { text: c.detail })));
    v.append(h('section', { class: 'panel warnbox' }, h('h2', { text: t('report.consistency') }), ul));
  }

  const groups = new Map<string, Finding[]>();
  for (const f of r.findings) { const g = groups.get(f.category) ?? []; g.push(f); groups.set(f.category, g); }
  for (const [cat, list] of groups) {
    const sec = h('section', { class: 'panel' }, h('h2', { text: t(`cat.${cat}`) }));
    for (const f of list) {
      const details = h('details', { class: 'finding' },
        h('summary', {},
          h('span', { class: 'fname', text: t(`finding.${f.id}`) }),
          h('code', { class: 'fval', text: f.value }),
          h('span', { class: `chip ent-${f.entropy}`, text: t(`entropy.${f.entropy}`) }),
          h('span', { class: `pill ${statusClass(f.status)}`, text: t(`fstatus.${f.status}`) })),
        h('div', { class: 'fbody' },
          h('p', {}, h('b', { text: `${t('report.why')}: ` }), t(f.whyKey)),
          f.fixKey ? h('p', {}, h('b', { text: `${t('report.fix')}: ` }), t(f.fixKey)) : null,
          h('p', { class: 'mono small', text: f.value })));
      sec.append(details);
    }
    v.append(sec);
  }
  v.append(h('p', { class: 'hint mono', text: `${t('report.fingerprintHash')}: ${r.fingerprintHash}` }));
}

// ------------------------------------------------------------------ reports

async function renderReports(v: HTMLElement): Promise<void> {
  v.append(h('div', { class: 'view-head' }, h('div', {}, h('h1', { text: t('od.nav.reports') }), h('p', { class: 'muted', text: t('reports.intro') }))));
  const list = (await run(api.invoke<ReportMeta[]>('od:reports'))) ?? [];
  if (!list.length) v.append(h('p', { class: 'muted', text: t('reports.none') }));
  const table = h('div', { class: 'panel' });
  for (const m of list) {
    const open = h('button', { class: 'btn small', text: t('reports.open') });
    open.onclick = async () => { const r = await run(api.invoke<Report>('od:report', m.id)); if (r) { current = r; view = 'audit'; render(); } };
    const del = h('button', { class: 'btn small danger' }, icon('trash', 13));
    del.title = t('common.delete');
    del.onclick = () => confirmDialog(t('reports.deleteConfirm'), () => api.invoke('od:report-delete', m.id).then(() => render()), 'toast.deleted');
    table.append(h('div', { class: 'kv' },
      h('span', {}, new Date(m.generatedAt).toLocaleString(), ' · ', t(`target.${m.target}`)),
      h('span', { class: 'row' }, h('span', { class: `pill ${riskClass(m.risk)}`, text: t(`risk.${m.risk}`) }), open, del)));
  }
  if (list.length) v.append(table);
  const folder = h('button', { class: 'btn' }, icon('folder', 15), ` ${t('reports.folder')}`);
  folder.onclick = () => void api.invoke('od:open-folder', 'reports');
  v.append(folder, h('p', { class: 'hint', text: t('reports.encrypted') }));
}

// ------------------------------------------------------------------ updates

function renderUpdates(v: HTMLElement): void {
  const u = init.update;
  v.append(h('div', { class: 'view-head' }, h('h1', { text: t('od.nav.updates') })));
  const p = h('section', { class: 'panel' });
  if (!u.configured) p.append(h('p', { class: 'note', text: t('upd.notConfigured') }));
  p.append(
    h('div', { class: 'kv' }, h('span', { text: t('upd.current') }), h('b', { text: u.current })),
    h('div', { class: 'kv' }, h('span', { text: t('upd.latest') }), h('b', { text: u.latest ?? t('state.unknown') })),
    h('div', { class: 'kv' }, h('span', { text: t('upd.lastCheck') }), h('span', { text: u.lastCheckAt ? new Date(u.lastCheckAt).toLocaleString() : t('state.never') })));
  if (u.error) p.append(h('p', { class: 'err', text: u.error }));
  const row = h('div', { class: 'row' });
  const check = h('button', { class: 'btn', text: t('upd.checkNow') });
  check.onclick = () => void run(api.invoke('od:update-check'));
  row.append(check);
  if (u.available) {
    p.append(h('div', { class: 'kv' }, h('span', { text: t('upd.severity') }), h('span', { class: 'pill warn', text: t(`upd.sev.${u.severity ?? 'normal'}`) })));
    if (u.changelog) p.append(h('pre', { class: 'changelog', text: u.changelog[init.lang] ?? u.changelog.en }));
    if (u.downloading) p.append(h('progress', { max: String(u.downloading.total || 1), value: String(u.downloading.done) }));
    if (u.readyToInstall) {
      const inst = h('button', { class: 'btn primary', text: t('upd.install') });
      inst.onclick = () => confirmDialog(t('upd.installConfirm'), () => api.invoke('od:update-install'), 'upd.installing');
      row.append(inst);
    } else if (!u.downloading) {
      const dl = h('button', { class: 'btn primary', text: t('upd.download') });
      dl.onclick = () => void run(api.invoke('od:update-download'));
      row.append(dl);
    }
    const later = h('button', { class: 'btn', text: t('upd.postpone') });
    later.onclick = () => void run(api.invoke('od:update-postpone'), 'toast.saved');
    row.append(later);
  }
  p.append(row);
  v.append(p);
  const s = init.settings;
  v.append(h('section', { class: 'panel' }, h('h2', { text: t('upd.settings') }),
    toggle(s.updates.autoCheck, 'upd.autoCheck', (val) => void saveSettings({ autoCheck: val })),
    h('p', { class: 'hint', text: t('upd.policy') }),
    toggle(s.updates.backgroundCheck, 'upd.background', (val) => void saveSettings({ backgroundCheck: val }))));
  if (u.rollbackAvailable.length) {
    const rb = h('section', { class: 'panel' }, h('h2', { text: t('upd.rollback') }));
    for (const ver of u.rollbackAvailable) {
      const b = h('button', { class: 'btn', text: `${t('upd.rollbackTo')} ${ver}` });
      b.onclick = () => confirmDialog(t('upd.rollbackConfirm', { v: ver }), () => api.invoke('od:update-rollback', ver), 'upd.installing');
      rb.append(b);
    }
    v.append(rb);
  }
}

async function saveSettings(patch: Record<string, unknown>): Promise<void> {
  const r = await run(api.invoke<Init['settings']>('od:settings', patch), 'toast.saved');
  if (r) init.settings = r;
}

// ------------------------------------------------------------------ settings / logs / about

function renderSettings(v: HTMLElement): void {
  const s = init.settings;
  v.append(h('div', { class: 'view-head' }, h('h1', { text: t('od.nav.settings') })));
  const lang = h('select', {});
  for (const [val, label] of [['en', 'English'], ['pl', 'Polski']]) {
    const o = h('option', { value: val, text: label });
    if (val === init.lang) o.selected = true;
    lang.append(o);
  }
  lang.onchange = async () => {
    if ((await run(api.invoke('od:set-language', lang.value))) !== undefined) confirmDialog(t('settings.langRestart'), () => api.invoke('od:relaunch'), 'toast.saved');
  };
  const openData = h('button', { class: 'btn' }, icon('folder', 15), ` ${t('settings.openData')}`);
  openData.onclick = () => void api.invoke('od:open-folder', 'data');
  const dataDirDisplay = s.ui?.hideDirectoryPaths ? (t('settings.pathHidden') || '••••••••••••••••') : init.dataDir;
  v.append(
    h('section', { class: 'panel' }, h('h2', { text: t('settings.general') }),
      h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('settings.language') }), lang),

      toggle(!!s.ui?.virtualBoxMode, 'settings.virtualBoxMode', (val) => {
        void saveSettings({ ui: { virtualBoxMode: val } }).then(() => {
          confirmDialog(t('settings.vmModeRestart'), () => api.invoke('od:relaunch'), 'toast.saved');
        });
      }),
      h('p', { class: 'hint', text: t('settings.virtualBoxModeHint') }),

      toggle(!!s.ui?.hideDirectoryPaths, 'settings.hideDirectoryPaths', (val) => {
        void saveSettings({ ui: { hideDirectoryPaths: val } }).then(() => render());
      }),
      h('p', { class: 'hint', text: t('settings.hideDirectoryPathsHint') }),
      h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('settings.dataDir') }), h('code', { text: dataDirDisplay }), openData)),
    h('section', { class: 'panel' }, h('h2', { text: t('settings.network') }),
      toggle(s.network.publicIpLookup, 'settings.ipLookup', (val) => void saveSettings({ publicIpLookup: val })),
      h('p', { class: 'hint', text: t('firstRun.ipLookupDesc') }),
      toggle(s.offline, 'settings.offline', (val) => void saveSettings({ offline: val }))),
    h('section', { class: 'panel' }, h('h2', {}, icon('lock', 16), ` ${t('sec.autolock')}`),
      h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('sec.autolockAfter') }), autoLockSelect()),
      h('p', { class: 'hint', text: t('sec.autolockHint') }),
      init.keyringRequiresPassword ? null : h('p', { class: 'hint', text: t('od.autolockOsMode') })),
    renderKeyProtection(),
    (() => {
      const reset = h('button', { class: 'btn danger' }, icon('trash', 15), ` ${t('settings.resetApp')}`);
      reset.onclick = () => confirmDialog(t('settings.resetAppConfirm'), () => api.invoke('od:factory-reset'), 'settings.resetRestarting');
      return h('section', { class: 'panel danger-zone' }, h('h2', { text: t('settings.resetTitle') }),
        h('p', { text: t('settings.resetAppDesc') }), h('p', { class: 'hint', text: t('settings.resetAppNote') }), reset);
    })(),
  );
}

/**
 * Key protection panel: shows how the local key that encrypts reports and
 * settings is protected (Windows DPAPI or an optional master password), lets the
 * user set / change / remove that password and choose where secrets are stored.
 */
function renderKeyProtection(): HTMLElement {
  const panel = keyProtectionPanel(
    {
      keyringMode: init.keyringMode,
      requiresPassword: init.keyringRequiresPassword,
      secretBackend: 'local',
    },
    {
      setMasterPassword: (current, next, repeat) => api.invoke('od:master-password', 'set', current, next, repeat),
      removeMasterPassword: (current) => api.invoke('od:master-password', 'remove', current),
    },
    () => { void refreshInit(); },
  );
  return panel;
}

/** Auto-lock selector (0 = never). */
function autoLockSelect(): HTMLSelectElement {
  const sel = h('select', {});
  for (const [val, label] of [['0', t('sec.never')], ['5', '5 min'], ['10', '10 min'], ['15', '15 min'], ['30', '30 min'], ['60', '60 min']] as Array<[string, string]>) {
    const o = h('option', { value: val, text: label });
    if (Number(val) === init.settings.security.autoLockMinutes) o.selected = true;
    sel.append(o);
  }
  sel.onchange = () => void saveSettings({ autoLockMinutes: Number(sel.value) });
  return sel;
}

/** Re-read od:init so the panel reflects the new key protection state. */
async function refreshInit(): Promise<void> {
  const next = await api.invoke<Init>('od:init');
  if (next) {
    init.keyringMode = next.keyringMode;
    init.keyringRequiresPassword = next.keyringRequiresPassword;
    init.secretBackend = 'local';
    init.settings = next.settings;
    render();
  }
}

function renderLogs(v: HTMLElement): void {
  v.append(h('div', { class: 'view-head' }, h('h1', { text: t('od.nav.logs') })));
  const sel = h('select', {});
  for (const m of ['off', 'standard', 'diagnostic'] as const) {
    const o = h('option', { value: m, text: t(`logs.${m}`) });
    if (m === init.logMode) o.selected = true;
    sel.append(o);
  }
  sel.onchange = async () => { const r = await run(api.invoke<'off' | 'standard' | 'diagnostic'>('od:log-mode', sel.value), 'toast.saved'); if (r) init.logMode = r; };
  const del = h('button', { class: 'btn danger' }, icon('trash', 15), ` ${t('logs.delete')}`);
  del.onclick = async () => { const n = await run(api.invoke<number>('od:logs-clear')); if (n !== undefined) toast(t('logs.deleted', { n }), 'ok'); };
  const open = h('button', { class: 'btn' }, icon('folder', 15), ` ${t('logs.open')}`);
  open.onclick = () => void api.invoke('od:open-folder', 'logs');
  v.append(h('section', { class: 'panel' }, h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('logs.mode') }), sel), h('p', { class: 'hint', text: t('logs.modeHint') }), h('p', { class: 'hint', text: t('logs.noSecrets') }), h('div', { class: 'row' }, open, del)));
}

function renderAbout(v: HTMLElement): void {
  v.append(h('div', { class: 'view-head' }, h('h1', { text: t('od.nav.about') })));
  const conns = h('ul', {});
  for (const k of ['conn.updates', 'od.conn.ip', 'od.conn.probe', 'od.conn.none']) conns.append(h('li', { text: t(k) }));
  const ob = h('button', { class: 'btn', text: t('od.openBrowser') });
  ob.onclick = () => void api.invoke('od:open-browser');
  v.append(
    h('section', { class: 'panel' }, h('h2', { text: `OctoDetect.su ${init.version}` }), h('p', { text: t('od.about') }), h('p', { class: 'hint', text: t('report.disclaimer') }), ob),
    h('section', { class: 'panel' }, h('h2', { text: t('about.connections') }), h('p', { class: 'hint', text: t('about.telemetryOff') }), conns),
    h('section', { class: 'panel' }, h('h2', { text: t('about.licenses') }), h('p', { text: t('about.licensesDesc') })),
  );
}

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  init = await api.invoke<Init>('od:init');
  setDicts(init.dicts);
  setLang(init.lang);
  applyI18n();
  api.on<string>('od:progress', (s) => { stage = s; if (view === 'audit') render(); });
  api.on<UpdateStatus>('od:update-status', (u) => { init.update = u; render(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  render();
}

boot().catch((err) => {
  document.body.append(h('pre', { class: 'fatal', text: `OctoDetect UI error: ${String((err as Error)?.message ?? err)}` }));
});
