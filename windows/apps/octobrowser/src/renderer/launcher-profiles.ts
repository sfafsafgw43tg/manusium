/**
 * apps/octobrowser/src/renderer/launcher-profiles.ts
 *
 * Profile list: folder column, toolbar (create / quick profile / search),
 * table with START / STOP per row, worktime, proxy + exit IP, row menu and
 * bulk actions for the selected profiles.
 */
import { api, clear } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { mobileEmulationFor } from '@octo/core/mobile';
import { chromiumUserAgent } from '@octo/core/user-agent';
import { browserEngineFor } from '@octo/core/inkbrowser';
import {
  $, S, Profile, FpOs, Fingerprint, run, toast, errText, modal, closeModal, confirmDialog, popupMenu, MenuItem, osIcon, osLabel,
  fmtDuration, worktime, proxyText, checkLine, field, input, select,
} from './launcher-ui';
import { inkbrowserLaunchMessage } from './launcher-ui';
import { openEditor } from './launcher-editor';
import { openAllProfileFingerprintTests, runProfileFingerprintAudit } from './launcher-fingerprint-audit';
import { preLaunch, duplicateDialog, exportDialog, importDialog, encryptionDialog, resealDialog, privateBrowsingDialog, torMissing, wsbUnavailable, isolationDialog } from './launcher-dialogs';

// ------------------------------------------------------------------ folders

const FOLDERS_KEY = 'octo.folders';

function storedFolders(): string[] {
  try { return (JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? '[]') as unknown[]).map(String); } catch { return []; }
}

export function allFolders(): string[] {
  const set = new Set(storedFolders());
  for (const p of S.profiles) if (p.folder) set.add(p.folder);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function saveFolders(list: string[]): void {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify([...new Set(list)]));
}

function folderDialog(rename?: string): void {
  modal(t(rename ? 'ui.folderRename' : 'ui.folderNew'), (box) => {
    const name = input(rename ?? '', { maxlength: '48', placeholder: t('ui.folderNamePh') });
    const ok = h('button', { class: 'btn primary', text: t(rename ? 'common.save' : 'common.create') });
    const go = async () => {
      const v = name.value.trim();
      if (!v) { name.focus(); return; }
      const list = storedFolders().filter((f) => f !== rename);
      saveFolders([...list, v]);
      if (rename) {
        const ids = S.profiles.filter((p) => p.folder === rename).map((p) => p.id);
        if (ids.length) await run(api.invoke('mgr:profile-bulk', 'folder', ids, v));
        if (S.folder === rename) S.folder = v;
      }
      closeModal();
      S.render();
    };
    ok.onclick = () => void go();
    name.onkeydown = (e) => { if (e.key === 'Enter') void go(); };
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    box.append(field('ui.folderName', name), h('div', { class: 'modal-actions' }, cancel, ok));
  });
}

function folderMenu(anchor: HTMLElement, f: string): void {
  popupMenu(anchor, [
    { icon: 'edit', label: t('ui.folderRename'), fn: () => folderDialog(f) },
    { icon: 'folder', label: t('ui.folderDirectory'), fn: () => void chooseFolderDirectory(f) },
    {
      icon: 'trash', label: t('ui.folderDelete'), danger: true, fn: () => confirmDialog(t('ui.folderDeleteConfirm', { name: f }), async () => {
        const ids = S.profiles.filter((p) => p.folder === f).map((p) => p.id);
        if (ids.length) await api.invoke('mgr:profile-bulk', 'folder', ids, '');
        saveFolders(storedFolders().filter((x) => x !== f));
        if (S.folder === f) S.folder = '';
        S.render();
        return true;
      }, 'toast.saved'),
    },
  ]);
}

async function chooseFolderDirectory(folder: string): Promise<void> {
  const picked = await run(api.invoke<string | null>('mgr:pick-folder'));
  if (!picked) return;
  const result = await run(api.invoke<{ moved: number; path: string }>('mgr:move-folder-directory', folder, picked));
  if (result) toast(t('ui.folderDirectoryMoved', { n: result.moved }), 'ok');
}

export function renderFolders(side: HTMLElement): void {
  clear(side);
  const search = input('', { placeholder: t('ui.searchFolder'), 'aria-label': t('ui.searchFolder') });
  const add = h('button', { class: 'icon-btn accent', title: t('ui.folderNew'), 'aria-label': t('ui.folderNew') }, icon('folderPlus', 20));
  add.onclick = () => folderDialog();
  const list = h('div', { class: 'folders', role: 'list' });
  const draw = () => {
    clear(list);
    const q = search.value.trim().toLowerCase();
    const item = (key: string, label: string, count: number, ic: string) => {
      const b = h('button', { class: `folder${S.folder === key ? ' on' : ''}`, role: 'listitem' }, icon(ic, 16), h('span', { class: 'grow ell', text: label }), h('span', { class: 'count', text: String(count) }));
      b.onclick = () => { S.folder = key; S.selected.clear(); S.render(); };
      if (key && key !== '__none') {
        const more = h('span', { class: 'folder-more', title: t('common.more'), role: 'button', tabindex: '0' }, icon('dots', 16));
        more.onclick = (e) => { e.stopPropagation(); folderMenu(more, key); };
        b.append(more);
      }
      list.append(b);
    };
    item('', t('ui.allProfiles'), S.profiles.length, 'users');
    for (const f of allFolders()) if (!q || f.toLowerCase().includes(q)) item(f, f, S.profiles.filter((p) => p.folder === f).length, 'folder');
    const none = S.profiles.filter((p) => !p.folder).length;
    if (allFolders().length && none) item('__none', t('ui.noFolder'), none, 'box');
  };
  search.oninput = draw;
  draw();
  side.append(h('div', { class: 'side2-head' }, search, add), list);
}

// ------------------------------------------------------------------ list

type BrowserCategory = 'all' | 'octo' | 'chrome' | 'chromium' | 'firefox' | 'safari' | 'mobile';
type ProfileSort = 'manual' | 'recent' | 'name' | 'browser';
const BROWSER_CATEGORY_KEY = 'octo.profileBrowserCategory';
const PROFILE_SORT_KEY = 'octo.profileSort';
const getStoredChoice = <T extends string>(key: string, choices: readonly T[], fallback: T): T => {
  try { const value = localStorage.getItem(key); return choices.includes(value as T) ? value as T : fallback; } catch { return fallback; }
};
let browserCategory = getStoredChoice<BrowserCategory>(BROWSER_CATEGORY_KEY, ['all', 'octo', 'chrome', 'chromium', 'firefox', 'safari', 'mobile'], 'all');
let profileSort = getStoredChoice<ProfileSort>(PROFILE_SORT_KEY, ['manual', 'recent', 'name', 'browser'], 'manual');

function visibleProfiles(): Profile[] {
  const q = S.search.trim().toLowerCase();
  const result = S.profiles.filter((p) =>
    (S.folder === '' || (S.folder === '__none' ? !p.folder : p.folder === S.folder)) &&
    (!S.tagFilter || p.tags?.includes(S.tagFilter)) &&
    (browserCategory === 'all' || (browserCategory === 'mobile'
      ? p.kind === 'phone' || (p.mobile?.device !== undefined && p.mobile.device !== 'none')
      : p.browserShell === browserCategory)) &&
    (!q || p.name.toLowerCase().includes(q) || (p.notes ?? '').toLowerCase().includes(q) || (p.tags ?? []).some((x) => x.toLowerCase().includes(q)) ||
      (p.network.proxy?.host ?? '').includes(q) || (p.proxyCheck?.ip ?? '').includes(q)));
  const shellRank: Record<Exclude<BrowserCategory, 'all' | 'mobile'>, number> = { octo: 0, chrome: 1, chromium: 2, firefox: 3, safari: 4 };
  return result.sort((a, b) => {
    if (profileSort === 'manual') return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
    if (profileSort === 'name') return a.name.localeCompare(b.name);
    if (profileSort === 'browser') {
      const ar = (a.mobile?.device !== undefined && a.mobile.device !== 'none') || a.kind === 'phone' ? 5 : shellRank[a.browserShell];
      const br = (b.mobile?.device !== undefined && b.mobile.device !== 'none') || b.kind === 'phone' ? 5 : shellRank[b.browserShell];
      return ar - br || a.name.localeCompare(b.name);
    }
    return String(b.updatedAt).localeCompare(String(a.updatedAt)) || a.name.localeCompare(b.name);
  });
}

/** START: launch directly; dialogs only when something is needed (passphrase, Tor Browser...). */
export async function startProfile(p: Profile): Promise<void> {
  if (p.encrypted && p.sealed) { void preLaunch(p); return; }
  const r = await run(api.invoke<{ status: string; detail?: string }>('mgr:launch', p.id, {}));
  if (!r) return;
  switch (r.status) {
    case 'started': case 'focused': case 'wsb-launched': case 'tor-launched': case 'inkbrowser-launched': case 'firefox-launched': break;
    case 'need-passphrase': case 'wrong-passphrase': void preLaunch(p); break;
    case 'tor-missing': torMissing(); break;
    case 'wsb-unavailable': wsbUnavailable(p); break;
    case 'inkbrowser-missing': case 'inkbrowser-conflict': toast(inkbrowserLaunchMessage(r.status, r.detail), 'err'); break;
    case 'firefox-engine-unavailable': toast(`${t('launch.status.firefox-engine-unavailable')} (${r.detail ?? 'runtime-unavailable'})`, 'err'); break;
    case 'firefox-launch-failed': toast(t('launch.status.firefox-launch-failed'), 'err'); break;
    default: toast(r.status, 'err');
  }
}

export async function stopProfile(p: Profile, force = false): Promise<void> {
  await run(api.invoke('mgr:close-profile', p.id, force));
}

async function quickProfile(os: FpOs): Promise<void> {
  const fp = await run(api.invoke<Fingerprint>('mgr:fingerprint-new', os));
  if (!fp) return;
  const n = S.profiles.filter((p) => p.kind === 'antidetect').length + 1;
  const p = await run(api.invoke<Profile>('mgr:create', { name: `${t('ui.quickName')} ${n}`, kind: 'antidetect', patch: { fingerprint: fp, folder: S.folder && S.folder !== '__none' ? S.folder : '' } }));
  if (!p) return;
  S.flash = p.id;
  toast(t('ui.quickCreated', { name: p.name, os: osLabel(os) }), 'ok');
  await startProfile({ ...p, running: false, sealed: false } as Profile);
}

interface SavedLogin { id: string; origin: string; username: string; updatedAt: string; timesUsed: number; blocked: boolean }

/**
 * Profile data: the website logins this profile saved. Metadata is listed
 * directly; a password is fetched from the encrypted store only when the user
 * asks for that single entry, and is never written into the DOM otherwise.
 */
function dataDialog(p: Profile): void {
  modal(t('pw.profileDataTitle', { name: p.name }), (box) => {
    const list = h('div', { class: 'pw-rows' });
    const summary = h('div', { class: 'pw-summary', text: t('common.loading') });
    const load = async () => {
      const entries = (await run(api.invoke<SavedLogin[]>('mgr:passwords', p.id))) ?? [];
      const logins = entries.filter((entry) => !entry.blocked);
      const updated = logins.filter((entry) => Date.parse(entry.updatedAt) >= Date.now() - 7 * 24 * 60 * 60 * 1000).length;
      clear(summary);
      summary.append(
        h('span', { class: 'pw-summary-stat' }, h('b', { text: String(logins.length) }), h('small', { text: 'items' })),
        h('span', { class: 'pw-summary-stat' }, h('b', { text: String(new Set(logins.map((entry) => entry.origin)).size) }), h('small', { text: 'sites' })),
        h('span', { class: 'pw-summary-stat' }, h('b', { text: String(updated) }), h('small', { text: 'updated this week' })),
        h('span', { class: 'pw-summary-state', text: t(p.savePasswords ? 'pw.savingOn' : 'pw.savingOff') }),
      );
      clear(list);
      if (!logins.length) { list.append(h('p', { class: 'hint', text: t('pw.empty') })); return; }
      for (const entry of logins) {
        const value = h('span', { class: 'mono', text: '••••••••' });
        const show = h('button', { class: 'btn small', text: t('pw.show') });
        show.onclick = async () => {
          if (value.textContent !== '••••••••') { value.textContent = '••••••••'; show.textContent = t('pw.show'); return; }
          const secret = await run(api.invoke<string>('mgr:password-reveal', entry.id));
          if (!secret) { toast(t('pw.revealFailed'), 'err'); return; }
          value.textContent = secret;
          show.textContent = t('pw.hide');
        };
        const del = h('button', { class: 'btn small danger', text: t('pw.remove') });
        del.onclick = () => confirmDialog(t('pw.removeConfirm', { origin: entry.origin }), async () => {
          await api.invoke('mgr:passwords-remove', [entry.id]);
          await load();
          return true;
        }, 'toast.saved');
        const avatar = h('span', { class: 'pw-avatar', text: (entry.origin.replace(/^https?:\/\//, '')[0] || '?').toUpperCase() });
        list.append(h('article', { class: 'pw-row pw-card' }, avatar,
          h('div', { class: 'grow' }, h('b', { text: entry.origin.replace(/^https?:\/\//, '') }), h('span', { class: 'muted small', text: ` ${entry.username || t('pw.noUsername')}` })),
          h('div', { class: 'pw-card-secret' }, value, show), del,
          h('span', { class: 'muted small pw-card-meta', text: `${new Date(entry.updatedAt).toLocaleDateString()} · ${t('pw.used', { n: entry.timesUsed })}` })));
      }
    };
    const closeBtn = h('button', { class: 'btn primary', text: t('common.close') });
    closeBtn.onclick = closeModal;
    const csv = h('textarea', { class: 'mass', rows: '4', spellcheck: 'false', placeholder: t('pw.importPh') }) as HTMLTextAreaElement;
    const importBtn = h('button', { class: 'btn', text: t('pw.import') });
    importBtn.onclick = async () => {
      const r = await run(api.invoke<{ added: number; skipped: number }>('mgr:passwords-import', p.id, csv.value));
      if (!r) return;
      csv.value = '';
      toast(t('pw.imported', { n: r.added, skipped: r.skipped }), r.added ? 'ok' : 'info');
      await load();
    };
    box.append(h('div', { class: 'pw-hero' }, h('p', { class: 'hint', text: 'Saved website credentials' }), summary), list,
      h('p', { class: 'hint', text: t('pw.importHint') }), csv,
      h('div', { class: 'modal-actions' }, importBtn, closeBtn));
    void load();
  }, 'wide');
}

function rowMenu(anchor: HTMLElement, p: Profile): void {
  const items: Array<MenuItem | 'sep'> = [
    p.running ? { icon: 'eye', label: t('profile.focus'), fn: () => void run(api.invoke('mgr:launch', p.id, {})) } : { icon: 'play', label: t('profile.launch'), fn: () => void startProfile(p) },
    { icon: 'edit', label: t('common.edit'), fn: () => openEditor(p) },
    { icon: 'swap', label: t('proxy.check'), disabled: p.network.mode !== 'proxy', fn: () => void checkRowProxy(p) },
    { icon: 'fingerprint', label: t('fp.audit.run'), disabled: p.kind === 'tor' || p.protection.level === 'tor' || p.sandbox.mode === 'windows-sandbox', fn: () => runProfileFingerprintAudit(p) },
    { icon: 'globe', label: t('fp.verify.openAll'), disabled: p.kind === 'tor' || p.protection.level === 'tor' || p.sandbox.mode === 'windows-sandbox', fn: () => openAllProfileFingerprintTests(p) },
    { icon: 'shuffle', label: t('fp.newFingerprint'), disabled: p.kind !== 'antidetect' && !p.fingerprint?.enabled, fn: () => void renewFingerprint(p) },
    { icon: 'shield', label: t('ui.whatCanAccess'), fn: () => void isolationDialog(p) },
    { icon: 'key', label: t('pw.profileData'), fn: () => dataDialog(p) },
    'sep',
    { icon: 'copy', label: t('profile.duplicate'), fn: () => duplicateDialog(p) },
    { icon: 'folder', label: t('ui.moveToFolder'), fn: () => moveDialog([p.id]) },
    { icon: 'export', label: t('profile.export'), fn: () => void exportDialog(p) },
    { icon: p.encrypted ? 'unlock' : 'lock', label: t(p.encrypted ? 'profile.disableEncryption' : 'profile.enableEncryption'), fn: () => encryptionDialog(p) },
  ];
  if (p.running && browserEngineFor(p.engine) === 'inkbrowser') {
    items.splice(1, 0, { icon: 'globe', label: 'Native Chromium tabs', fn: () => nativeTabsDialog(p) });
  }
  if (p.needsResealing) items.push({ icon: 'lock', label: t('profile.reseal'), fn: () => resealDialog(p) });
  if (p.running) items.push({ icon: 'stop', label: t('ui.forceStop'), danger: true, fn: () => void stopProfile(p, true) });
  items.push('sep',
    { icon: 'refreshCircle', label: t('profile.reset'), danger: true, fn: () => confirmDialog(t('profile.resetConfirm', { name: p.name }), () => api.invoke('mgr:reset', p.id), 'toast.profileReset') },
    { icon: 'trash', label: t('profile.moveToTrash'), danger: true, fn: () => confirmDialog(t('profile.deleteConfirm', { name: p.name }), () => api.invoke('mgr:remove', p.id), 'toast.profileDeleted') });
  popupMenu(anchor, items);
}

async function checkRowProxy(p: Profile): Promise<void> {
  toast(t('proxy.checking'), 'info');
  const r = await run(api.invoke<{ ok: boolean; ip?: string; error?: string }>('mgr:proxy-check-profile', p.id));
  if (r) toast(r.ok ? t('proxy.okIp', { ip: r.ip ?? '' }) : `${t('proxy.failed')}: ${errText(r.error ?? '')}`, r.ok ? 'ok' : 'err');
}

interface NativeTabItem { id: string; url: string; title: string; loading: boolean; crashed: boolean }

function nativeTabsDialog(p: Profile): void {
  modal(`Native Chromium tabs · ${p.name}`, (box) => {
    const list = h('div', { class: 'list-stack' });
    const url = input('about:blank', { placeholder: 'https://example.com', 'aria-label': 'New tab URL' });
    const add = h('button', { class: 'btn primary', text: t('ui.newTab') });
    const refresh = async (): Promise<void> => {
      const tabs = await run(api.invoke<NativeTabItem[]>('mgr:native-tabs', p.id));
      clear(list);
      for (const tab of tabs ?? []) {
        const activate = h('button', { class: 'btn small', text: t('profile.focus') });
        activate.onclick = async () => { await run(api.invoke('mgr:native-tab-action', p.id, tab.id, 'activate')); await refresh(); };
        const close = h('button', { class: 'btn small danger', text: t('common.close') });
        close.onclick = async () => { await run(api.invoke('mgr:native-tab-action', p.id, tab.id, 'close')); await refresh(); };
        list.append(h('div', { class: 'row native-tab-row' },
          h('div', { class: 'grow' }, h('b', { class: 'ell', text: tab.title || t('ui.newTab') }), h('small', { class: 'ell muted', text: tab.url })), activate, close));
      }
    };
    add.onclick = async () => { await run(api.invoke('mgr:native-tab-new', p.id, url.value.trim() || 'about:blank')); await refresh(); };
    box.append(h('p', { class: 'hint', text: 'These tabs are controlled in the separate native Chromium window through the versioned CDP runtime contract.' }), list,
      h('div', { class: 'row' }, url, add));
    void refresh();
  }, 'wide');
}

async function renewFingerprint(p: Profile): Promise<void> {
  const fp = await run(api.invoke<Fingerprint>('mgr:fingerprint-new', p.fingerprint?.os));
  if (!fp) return;
  const cur = p.fingerprint;
  const mobileUa = mobileEmulationFor(p.mobile, fp.uaFullVersion)?.userAgent;
  fp.userAgent = mobileUa ?? chromiumUserAgent(fp.os, Number(fp.uaFullVersion.split('.')[0]) || 140);
  // Keep what the user chose for the network side and the release picker; renew the device.
  const next = cur ? { ...fp, timezone: cur.timezone, language: cur.language, geolocation: cur.geolocation, webrtc: cur.webrtc, ports: cur.ports, doNotTrack: cur.doNotTrack, osVersion: cur.osVersion } : fp;
  if ((await run(api.invoke('mgr:update', p.id, { fingerprint: next }))) !== undefined) toast(t(p.running ? 'fp.renewedRestart' : 'fp.renewed'), 'ok');
}

function moveDialog(ids: string[]): void {
  modal(t('ui.moveToFolder'), (box) => {
    const folders = allFolders();
    const dl = h('datalist', { id: 'move-folders' });
    for (const f of folders) dl.append(h('option', { value: f }));
    const cur = ids.length === 1 ? S.profiles.find((p) => p.id === ids[0])?.folder ?? '' : '';
    const name = input(cur, { list: 'move-folders', maxlength: '48', placeholder: t('ui.noFolder') });
    const ok = h('button', { class: 'btn primary', text: t('common.save') });
    ok.onclick = async () => {
      const v = name.value.trim();
      if (v) saveFolders([...storedFolders(), v]);
      if ((await run(api.invoke('mgr:profile-bulk', 'folder', ids, v))) !== undefined) { closeModal(); toast(t('toast.saved'), 'ok'); }
    };
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    box.append(field('ui.folderName', name, 'ui.moveHint'), dl, h('div', { class: 'modal-actions' }, cancel, ok));
  });
}

function addExistingToFolderDialog(folder: string): void {
  const candidates = S.profiles.filter((profile) => profile.folder !== folder);
  const selected = new Set<string>();
  modal(t('folder.empty.addTitle'), (box) => {
    const list = h('div', { class: 'folder-profile-picker', role: 'list' });
    const save = h('button', { class: 'btn primary', disabled: true, text: t('folder.empty.addSelected', { n: 0 }) }) as HTMLButtonElement;
    const update = () => { save.disabled = selected.size === 0; save.textContent = t('folder.empty.addSelected', { n: selected.size }); };
    for (const profile of candidates) {
      const check = h('input', { type: 'checkbox', value: profile.id, 'aria-label': profile.name }) as HTMLInputElement;
      check.onchange = () => { if (check.checked) selected.add(profile.id); else selected.delete(profile.id); update(); };
      const details = [profile.folder ? `${t('ui.folder')}: ${profile.folder}` : t('ui.noFolder'), ...(profile.tags ?? []).slice(0, 3)].join(' · ');
      list.append(h('label', { class: 'folder-profile-option', role: 'listitem' }, check,
        h('span', { class: 'grow' }, h('b', { class: 'ell', text: profile.name }), h('small', { class: 'ell muted', text: details }))));
    }
    save.onclick = async () => {
      const result = await run(api.invoke('mgr:profile-bulk', 'folder', [...selected], folder));
      if (result === undefined) return;
      closeModal();
      toast(t('folder.empty.added', { n: selected.size, name: folder }), 'ok');
    };
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    box.append(h('p', { class: 'hint', text: candidates.length ? t('folder.empty.addHint') : t('folder.empty.addNone') }));
    if (candidates.length) box.append(list);
    box.append(h('div', { class: 'modal-actions' }, cancel, save));
  });
}

function statusDialog(ids: string[]): void {
  modal(t('ui.setStatus'), (box) => {
    let v = '';
    const sel = select<string>('', STATUSES.map((s) => [s, s ? t(`status.p.${s}`) : t('ui.noStatus')] as [string, string]), (x) => { v = x; });
    const ok = h('button', { class: 'btn primary', text: t('common.save') });
    ok.onclick = async () => { if ((await run(api.invoke('mgr:profile-bulk', 'status', ids, v))) !== undefined) closeModal(); };
    box.append(field('ui.status', sel), h('div', { class: 'modal-actions' }, ok));
  });
}

export const STATUSES = ['', 'new', 'ready', 'inwork', 'paused', 'blocked', 'done'];

function statusChip(s: string): HTMLElement | null {
  if (!s) return null;
  return h('span', { class: `st st-${STATUSES.includes(s) ? s : 'custom'}`, text: STATUSES.includes(s) ? t(`status.p.${s}`) : s });
}

export type ProfileColumnKey =
  | 'folder'
  | 'tags'
  | 'proxy'
  | 'notes'
  | 'worktime'
  | 'timer'
  | 'status'
  | 'created'
  | 'lastEdited'
  | 'launched'
  | 'profileId';

export const ALL_PROFILE_COLUMNS: Array<{ key: ProfileColumnKey; labelKey: string; defaultLabel: string; width: string }> = [
  { key: 'folder', labelKey: 'ui.col.folders', defaultLabel: 'Folders', width: 'minmax(110px, 0.9fr)' },
  { key: 'tags', labelKey: 'ui.col.tags', defaultLabel: 'Tags', width: 'minmax(120px, 1fr)' },
  { key: 'proxy', labelKey: 'ui.col.proxy', defaultLabel: 'Proxy', width: 'minmax(200px, 1.5fr)' },
  { key: 'notes', labelKey: 'ui.col.notes', defaultLabel: 'Notes', width: 'minmax(130px, 1.1fr)' },
  { key: 'worktime', labelKey: 'ui.col.worktime', defaultLabel: 'Worktime', width: '110px' },
  { key: 'timer', labelKey: 'ui.col.timer', defaultLabel: 'Timer', width: '100px' },
  { key: 'status', labelKey: 'ui.col.status', defaultLabel: 'Status', width: '110px' },
  { key: 'created', labelKey: 'ui.col.created', defaultLabel: 'Created', width: '140px' },
  { key: 'lastEdited', labelKey: 'ui.col.lastEdited', defaultLabel: 'Last edited', width: '140px' },
  { key: 'launched', labelKey: 'ui.col.launched', defaultLabel: 'Launched', width: '140px' },
  { key: 'profileId', labelKey: 'ui.col.profileId', defaultLabel: 'Profile ID', width: '110px' },
];

const PROFILE_COLUMNS_KEY = 'octo.profileColumns';
const DEFAULT_PROFILE_COLUMNS: ProfileColumnKey[] = ['worktime', 'proxy', 'launched'];

export function getSelectedProfileColumns(): ProfileColumnKey[] {
  try {
    const raw = localStorage.getItem(PROFILE_COLUMNS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const validKeys = ALL_PROFILE_COLUMNS.map((c) => c.key);
        const filtered = parsed.filter((k) => validKeys.includes(k as ProfileColumnKey)) as ProfileColumnKey[];
        if (filtered.length > 0) return filtered;
      }
    }
  } catch {}
  return [...DEFAULT_PROFILE_COLUMNS];
}

export function saveSelectedProfileColumns(cols: ProfileColumnKey[]): void {
  localStorage.setItem(PROFILE_COLUMNS_KEY, JSON.stringify(cols));
}

export function getGridTemplateColumns(activeCols: ProfileColumnKey[]): string {
  const cols = ['48px', '90px', 'minmax(180px, 1.6fr)', '132px'];
  for (const c of activeCols) {
    const def = ALL_PROFILE_COLUMNS.find((x) => x.key === c);
    cols.push(def?.width || 'minmax(120px, 1fr)');
  }
  cols.push('38px');
  return cols.join(' ');
}

export function formatRelativeDateTime(ts: number | string | undefined): string {
  if (!ts) return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts));
  if (isNaN(d.getTime())) return '—';
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d >= today) {
    return `${t('time.today')}, ${timeStr}`;
  }
  if (d >= yesterday) {
    return `${t('time.yesterday')}, ${timeStr}`;
  }
  if (d.getFullYear() === now.getFullYear()) {
    const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    return `${dateStr}, ${timeStr}`;
  }
  const dateStr = d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  return `${dateStr}, ${timeStr}`;
}

export function columnsDialog(onChanged: () => void): void {
  modal(t('ui.customizeColumns'), (box) => {
    let active = [...getSelectedProfileColumns()];
    let searchQuery = '';

    const container = h('div', { class: 'col-config-container' });

    // Left Panel
    const leftPanel = h('div', { class: 'col-config-panel col-config-left' });
    const searchIn = h('input', {
      type: 'search',
      class: 'col-search-input',
      placeholder: t('ui.searchPh'),
      'aria-label': t('ui.searchPh'),
    }) as HTMLInputElement;

    const leftList = h('div', { class: 'col-cb-list' });

    // Right Panel
    const rightPanel = h('div', { class: 'col-config-panel col-config-right' });
    const rightHead = h('div', { class: 'col-selected-head' },
      h('span', { class: 'col-selected-label', text: t('ui.columnsSelectedShort') }),
      h('span', { class: 'col-selected-count' })
    );
    const rightList = h('div', { class: 'col-chip-list' });

    const updateRight = () => {
      clear(rightList);
      const countEl = rightHead.querySelector('.col-selected-count');
      if (countEl) countEl.textContent = String(active.length);

      active.forEach((colKey, index) => {
        const def = ALL_PROFILE_COLUMNS.find((c) => c.key === colKey);
        const title = def ? t(def.labelKey) : colKey;

        const chip = h('div', { class: 'col-chip-row', draggable: 'true' });

        const dragHandle = h('span', { class: 'col-drag-handle', title: t('ui.dragToReorder') }, icon('dots', 14));
        const chipTitle = h('span', { class: 'col-chip-title ell', text: title });
        const removeBtn = h('button', {
          class: 'col-chip-remove',
          title: t('common.remove'),
          'aria-label': t('common.remove'),
        }, icon('close', 12));

        removeBtn.onclick = (e) => {
          e.stopPropagation();
          active.splice(index, 1);
          saveSelectedProfileColumns(active);
          updateAll();
          onChanged();
        };

        // Drag and drop event handlers
        chip.ondragstart = (e) => {
          chip.classList.add('dragging');
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', String(index));
          }
        };
        chip.ondragend = () => {
          chip.classList.remove('dragging');
          updateRight();
        };
        chip.ondragover = (e) => {
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
          chip.classList.add('drag-over');
        };
        chip.ondragleave = () => {
          chip.classList.remove('drag-over');
        };
        chip.ondrop = (e) => {
          e.preventDefault();
          chip.classList.remove('drag-over');
          const fromIndexStr = e.dataTransfer?.getData('text/plain');
          const fromIndex = fromIndexStr !== undefined ? Number(fromIndexStr) : NaN;
          if (!isNaN(fromIndex) && fromIndex !== index && fromIndex >= 0 && fromIndex < active.length) {
            const item = active.splice(fromIndex, 1)[0];
            active.splice(index, 0, item);
            saveSelectedProfileColumns(active);
            updateAll();
            onChanged();
          }
        };

        chip.append(dragHandle, chipTitle, removeBtn);
        rightList.append(chip);
      });
    };

    const updateLeft = () => {
      clear(leftList);
      const query = searchQuery.trim().toLowerCase();

      // Master checkbox "All"
      const allSelected = ALL_PROFILE_COLUMNS.every((c) => active.includes(c.key));
      const someSelected = ALL_PROFILE_COLUMNS.some((c) => active.includes(c.key));

      const masterCb = h('input', { type: 'checkbox', class: 'col-master-cb', 'aria-label': t('ui.col.all') }) as HTMLInputElement;
      masterCb.checked = allSelected;
      masterCb.indeterminate = !allSelected && someSelected;

      masterCb.onchange = () => {
        if (masterCb.checked) {
          active = ALL_PROFILE_COLUMNS.map((c) => c.key);
        } else {
          active = [];
        }
        saveSelectedProfileColumns(active);
        updateAll();
        onChanged();
      };

      const masterLabel = h('label', { class: 'col-cb-row col-cb-master' },
        masterCb,
        h('span', { class: 'col-cb-text', text: t('ui.col.all') })
      );
      leftList.append(masterLabel, h('div', { class: 'col-cb-divider' }));

      // Individual checkboxes
      const filteredColumns = ALL_PROFILE_COLUMNS.filter((c) => {
        if (!query) return true;
        const name = (t(c.labelKey) || c.defaultLabel).toLowerCase();
        return name.includes(query);
      });

      if (!filteredColumns.length) {
        leftList.append(h('div', { class: 'col-empty-hint', text: t('ui.noOptions') }));
      } else {
        for (const col of filteredColumns) {
          const isChecked = active.includes(col.key);
          const cb = h('input', { type: 'checkbox', class: 'col-cb', 'aria-label': t(col.labelKey) }) as HTMLInputElement;
          cb.checked = isChecked;

          cb.onchange = () => {
            if (cb.checked) {
              if (!active.includes(col.key)) active.push(col.key);
            } else {
              active = active.filter((k) => k !== col.key);
            }
            saveSelectedProfileColumns(active);
            updateAll();
            onChanged();
          };

          const labelText = t(col.labelKey);
          const rowLabel = h('label', { class: 'col-cb-row' },
            cb,
            h('span', { class: 'col-cb-text', text: labelText })
          );
          leftList.append(rowLabel);
        }
      }
    };

    const updateAll = () => {
      updateLeft();
      updateRight();
    };

    searchIn.oninput = () => {
      searchQuery = searchIn.value;
      updateLeft();
    };

    const searchWrap = h('div', { class: 'col-search-wrap' }, icon('search', 15), searchIn);
    leftPanel.append(searchWrap, leftList);
    rightPanel.append(rightHead, rightList);
    container.append(leftPanel, rightPanel);

    // Footer actions
    const resetBtn = h('button', { class: 'btn outline', text: t('ui.resetDefault') });
    resetBtn.onclick = () => {
      active = [...DEFAULT_PROFILE_COLUMNS];
      saveSelectedProfileColumns(active);
      updateAll();
      onChanged();
    };

    const doneBtn = h('button', { class: 'btn primary', text: t('ui.done') });
    doneBtn.onclick = closeModal;

    const foot = h('div', { class: 'modal-actions col-config-actions' }, resetBtn, h('div', { class: 'grow' }), doneBtn);

    box.append(container, foot);
    updateAll();
  }, 'wide');
}

function startButton(p: Profile): HTMLElement {
  if (p.stopping) {
    const b = h('button', { class: 'run-btn busy', disabled: true }, h('span', { class: 'spin' }), h('span', { text: t('ui.stopping') }));
    return b;
  }
  if (p.running && !p.ready) {
    const b = h('button', { class: 'run-btn stop' }, h('span', { class: 'spin' }), h('span', { text: t('ui.starting') }));
    b.title = t('ui.clickToStop');
    b.onclick = () => void stopProfile(p, true);
    return b;
  }
  if (p.running) {
    const b = h('button', { class: 'run-btn stop' }, icon('stop', 13), h('span', { text: t('ui.stop') }));
    b.title = t('ui.stopHint');
    b.onclick = () => void stopProfile(p);
    return b;
  }
  const b = h('button', { class: 'run-btn start' }, icon('play', 13), h('span', { text: t('ui.start') }));
  b.onclick = async () => { (b as HTMLButtonElement).disabled = true; await startProfile(p); (b as HTMLButtonElement).disabled = false; };
  return b;
}

function proxyCell(p: Profile): HTMLElement {
  const cell = h('div', { class: 'proxy-cell' });
  if (p.kind === 'tor') { cell.append(h('span', { class: 'muted', text: 'Tor' })); return cell; }
  if (p.network.mode !== 'proxy') { cell.append(h('span', { class: 'muted', text: p.network.mode === 'direct' ? t('net.mode.direct') : '—' })); return cell; }
  const px = p.network.proxy;
  const c = p.proxyCheck;
  const state = !c ? 'none' : c.ok ? 'ok' : 'bad';
  const line = h('div', { class: 'proxy-line' }, h('span', { class: `swap ${state}` }, icon('swap', 14)),
    h('span', { class: 'ell', text: px ? (px.name ? `${px.name} · ${proxyText(px)}` : proxyText(px)) : (p.network.proxyRules ?? '') }));
  const offline = S.init.settings.offlineMode !== 'online';
  const chk = h('button', { class: 'icon-btn tiny', title: offline ? t('settings.offlineActionBlocked') : t('proxy.check'), 'aria-label': t('proxy.check'), disabled: offline }, icon('refreshCircle', 14));
  chk.onclick = async () => { chk.classList.add('spinning'); await checkRowProxy(p); chk.classList.remove('spinning'); };
  line.append(chk);
  cell.append(line, h('div', { class: 'proxy-sub' }, checkLine(c)));
  return cell;
}

function folderCell(p: Profile): HTMLElement {
  const folderName = p.folder && p.folder !== '__none' ? p.folder : '';
  if (!folderName) return h('div', { class: 'td c-folder' }, h('span', { class: 'muted', text: '—' }));
  return h('div', { class: 'td c-folder' },
    h('span', { class: 'col-folder-badge', title: folderName }, icon('folder', 13), h('span', { class: 'ell', text: folderName }))
  );
}

function tagsCell(p: Profile): HTMLElement {
  const tags = p.tags ?? [];
  if (!tags.length) return h('div', { class: 'td c-tags' }, h('span', { class: 'muted', text: '—' }));
  return h('div', { class: 'td c-tags' },
    h('div', { class: 'col-tags-wrap' }, ...tags.map((tg) => h('span', { class: 'tg', text: tg })))
  );
}

function proxyCellTd(p: Profile): HTMLElement {
  return h('div', { class: 'td c-proxy' }, proxyCell(p));
}

function notesCell(p: Profile): HTMLElement {
  if (!p.notes) return h('div', { class: 'td c-notes' }, h('span', { class: 'muted', text: '—' }));
  return h('div', { class: 'td c-notes' },
    h('span', { class: 'col-notes-text ell', text: p.notes, title: p.notes })
  );
}

function worktimeCell(p: Profile): HTMLElement {
  return h('div', { class: 'td c-worktime' },
    h('span', { class: 'wt', 'data-id': p.id, text: p.stats?.worktimeSec || p.running ? fmtDuration(worktime(p)) : '—' })
  );
}

function timerCell(p: Profile): HTMLElement {
  const text = p.running && p.startedAt ? fmtDuration(Math.max(0, Math.floor((Date.now() - p.startedAt) / 1000))) : '—';
  return h('div', { class: 'td c-timer' },
    h('span', { class: 'timer-wt', 'data-id': p.id, text })
  );
}

function statusCell(p: Profile): HTMLElement {
  const chip = statusChip(p.status);
  return h('div', { class: 'td c-status' }, chip || h('span', { class: 'muted', text: '—' }));
}

function createdCell(p: Profile): HTMLElement {
  const text = p.createdAt ? formatRelativeDateTime(p.createdAt) : '—';
  const title = p.createdAt ? new Date(p.createdAt).toLocaleString() : '';
  return h('div', { class: 'td c-created' },
    h('span', { class: 'date-text', text, title })
  );
}

function lastEditedCell(p: Profile): HTMLElement {
  const text = p.updatedAt ? formatRelativeDateTime(p.updatedAt) : '—';
  const title = p.updatedAt ? new Date(p.updatedAt).toLocaleString() : '';
  return h('div', { class: 'td c-lastedited' },
    h('span', { class: 'date-text', text, title })
  );
}

function launchedCell(p: Profile): HTMLElement {
  const text = p.stats?.lastLaunchAt ? formatRelativeDateTime(p.stats.lastLaunchAt) : '—';
  const title = p.stats?.lastLaunchAt ? new Date(p.stats.lastLaunchAt).toLocaleString() : '';
  return h('div', { class: 'td c-launched' },
    h('span', { class: 'date-text', text, title })
  );
}

function profileIdCell(p: Profile): HTMLElement {
  const shortId = p.id.slice(0, 8);
  const span = h('span', { class: 'col-id-text', text: shortId, title: `${p.id} (${t('ui.copied')})` });
  span.onclick = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(p.id);
    toast(t('ui.copied'));
  };
  return h('div', { class: 'td c-profileid' }, span);
}

function renderProfileCell(p: Profile, colKey: ProfileColumnKey): HTMLElement {
  switch (colKey) {
    case 'folder': return folderCell(p);
    case 'tags': return tagsCell(p);
    case 'proxy': return proxyCellTd(p);
    case 'notes': return notesCell(p);
    case 'worktime': return worktimeCell(p);
    case 'timer': return timerCell(p);
    case 'status': return statusCell(p);
    case 'created': return createdCell(p);
    case 'lastEdited': return lastEditedCell(p);
    case 'launched': return launchedCell(p);
    case 'profileId': return profileIdCell(p);
    default: return h('div', { class: 'td' }, h('span', { class: 'muted', text: '—' }));
  }
}

async function reorderVisible(fromId: string, toId: string): Promise<void> {
  if (fromId === toId) return;
  const visible = visibleProfiles();
  const from = visible.findIndex((p) => p.id === fromId);
  const to = visible.findIndex((p) => p.id === toId);
  if (from < 0 || to < 0) return;
  const nextVisible = visible.map((p) => p.id);
  const [moved] = nextVisible.splice(from, 1);
  nextVisible.splice(to, 0, moved);
  await run(api.invoke('mgr:profile-reorder', nextVisible), 'toast.saved');
}

function row(p: Profile, activeCols: ProfileColumnKey[], trGridCols: string): HTMLElement {
  // A profile that was just created announces itself once, then the flag is
  // dropped so redrawing the table (search, selection) stays still.
  const fresh = S.flash === p.id;
  if (fresh) S.flash = '';
  const tr = h('div', { class: `tr${p.running ? ' running' : ''}${S.selected.has(p.id) ? ' sel' : ''}${fresh ? ' just-in' : ''}${profileSort === 'manual' ? ' reorderable' : ''}`, role: 'row', draggable: profileSort === 'manual' });
  tr.style.gridTemplateColumns = trGridCols;
  if (profileSort === 'manual') {
    tr.ondragstart = (event) => {
      tr.classList.add('dragging');
      event.dataTransfer?.setData('text/profile-id', p.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    };
    tr.ondragend = () => tr.classList.remove('dragging');
    tr.ondragover = (event) => { event.preventDefault(); tr.classList.add('drag-over'); };
    tr.ondragleave = () => tr.classList.remove('drag-over');
    tr.ondrop = (event) => {
      event.preventDefault();
      tr.classList.remove('drag-over');
      const fromId = event.dataTransfer?.getData('text/profile-id');
      if (fromId) void reorderVisible(fromId, p.id);
    };
  }
  const cb = h('input', { type: 'checkbox', 'aria-label': t('ui.select'), checked: S.selected.has(p.id) });
  cb.onchange = () => { if (cb.checked) S.selected.add(p.id); else S.selected.delete(p.id); S.render(); };
  const more = h('button', { class: 'icon-btn', title: t('common.more'), 'aria-label': t('common.more') }, icon('dots', 18));
  more.onclick = (e) => { e.stopPropagation(); rowMenu(more, p); };
  const fp = p.fingerprint;
  const icons = h('div', { class: 'row-icons' },
    fp?.enabled ? osIcon(fp.os, 17) : h('span', { class: 'kind-ic', title: t(`profile.kind.${p.kind}`) }, icon(p.kind === 'phone' ? 'smartphone' : p.kind === 'tor' ? 'tor' : 'shield', 16)),
    p.encrypted ? h('span', { class: 'mini', title: t(p.sealed ? 'profile.sealed' : 'profile.unsealed') }, icon('lock', 14)) : null);
  if (fp?.enabled) icons.firstElementChild?.setAttribute('title', `${osLabel(fp.os)} · ${t('profile.kind.antidetect')}`);
  const name = h('button', { class: 'name-btn', title: t('common.edit') }, h('b', { class: 'ell', text: p.name }));
  name.onclick = () => openEditor(p);
  const warn = [...(p.fingerprintWarnings ?? []), ...p.issues.filter((i) => i.severity === 'warn').map((i) => i.key)];
  const meta = h('div', { class: 'name-meta' },
    h('span', { class: 'kind shell-name', text: t(`profile.browserShell.${p.browserShell}`) }),
    p.kind !== 'antidetect' ? h('span', { class: 'kind', text: t(`profile.kind.${p.kind}`) }) : null,
    statusChip(p.status),
    ...(p.tags ?? []).slice(0, 4).map((x) => h('span', { class: 'tg', text: x })),
    p.needsResealing ? h('span', { class: 'warn-ic', title: t('profile.needsResealing') }, icon('alert', 13)) : null,
    warn.length ? h('span', { class: 'warn-ic', title: warn.map((k) => t(k)).join('\n') }, icon('alert', 13)) : null);

  tr.append(
    h('div', { class: 'td c-check' }, cb),
    h('div', { class: 'td c-icons' }, icons, more),
    h('div', { class: 'td c-name' }, name, meta),
    h('div', { class: 'td c-start' }, startButton(p)),
  );

  for (const colKey of activeCols) {
    tr.append(renderProfileCell(p, colKey));
  }

  tr.append(h('div', { class: 'td c-col-settings' }));
  return tr;
}

let ticker: number | undefined;

function managerOverview(onCreate: () => void): HTMLElement {
  const running = S.profiles.filter((p) => p.running).length;
  const folders = new Set(S.profiles.map((p) => p.folder).filter(Boolean)).size;
  const native = S.profiles.filter((p) => browserEngineFor(p.engine) !== 'electron').length;
  const metric = (value: string, label: string, ic: string) => h('div', { class: 'orbit-metric' }, h('span', { class: 'orbit-metric-icon' }, icon(ic, 17)), h('div', {}, h('strong', { text: value }), h('small', { text: label })));
  const engineCard = (engine: 'chromium' | 'firefox' | 'electron', available: boolean, title: string, note: string) => h('article', { class: `orbit-engine orbit-engine-${engine}${available ? ' ready' : ' unavailable'}` },
    h('div', { class: 'orbit-engine-head' }, h('span', { class: 'orbit-engine-icon' }, icon(engine === 'firefox' ? 'globe' : engine === 'electron' ? 'octopus' : 'browser', 19)), h('span', { class: 'orbit-engine-badge' }, icon(available ? 'check' : 'alert', 12), h('span', { text: available ? t('ui.manager.ready') : t('ui.manager.needsSetup') }))),
    h('b', { text: title }), h('p', { text: note }));
  const health = h('button', { class: 'btn small outline orbit-health' }, icon('shieldCheck', 14), h('span', { text: t('ui.manager.runtimeHealth') }));
  health.onclick = async () => {
    const status = await run(api.invoke<{ reason: string; version: string; platform: string; packaged: string; user: string; executable: string | null }>('mgr:firefox-runtime-status'));
    if (!status) return;
    modal(t('ui.manager.runtimeHealth'), (box) => {
      const line = (label: string, value: string) => h('div', { class: 'orbit-diagnostic-line' }, h('b', { text: label }), h('span', { class: 'mono', text: value }));
      const close = h('button', { class: 'btn primary', text: t('common.close') }); close.onclick = closeModal;
      box.append(
        h('p', { class: 'hint', text: t('ui.manager.runtimeHealthHint') }),
        h('div', { class: 'orbit-diagnostic' },
          line(t('ui.manager.runtimeVersion'), status.version),
          line(t('ui.manager.runtimePlatform'), status.platform),
          line(t('ui.manager.packagedRuntime'), status.packaged),
          line(t('ui.manager.userRuntime'), status.user),
          line(t('ui.manager.runtimeResult'), status.reason),
          line(t('ui.manager.runtimeExecutable'), status.executable ?? t('ui.manager.notAvailable'))),
        h('div', { class: 'modal-actions' }, close),
      );
    }, 'wide');
  };
  const create = h('button', { class: 'btn primary orbit-create' }, icon('plus', 15), h('span', { text: t('ui.createProfile') })); create.onclick = onCreate;
  return h('section', { class: 'orbit-overview' },
    h('div', { class: 'orbit-welcome' }, h('div', { class: 'orbit-welcome-copy' }, h('span', { class: 'orbit-kicker', text: t('ui.manager.kicker') }), h('h2', { text: t('ui.manager.title') }), h('p', { text: t('ui.manager.subtitle') })), h('div', { class: 'orbit-welcome-actions' }, health, create)),
    h('div', { class: 'orbit-metrics' }, metric(String(S.profiles.length), t('ui.manager.totalProfiles'), 'users'), metric(String(running), t('ui.manager.runningNow'), 'play'), metric(String(folders), t('ui.manager.folders'), 'folder'), metric(String(native), t('ui.manager.nativeProfiles'), 'globe')),
    h('div', { class: 'orbit-engines' }, engineCard('chromium', Boolean(S.init.inkbrowserInstalled), t('browserEngine.chromiumCore'), t('ui.manager.chromiumCapability')), engineCard('firefox', Boolean(S.init.firefoxAvailable), t('browserEngine.firefoxCore'), t('ui.manager.firefoxCapability')), engineCard('electron', true, t('browserEngine.electron'), t('ui.manager.electronCapability'))));
}

export function renderProfiles(v: HTMLElement): void {
  const list = visibleProfiles();
  // ---- toolbar
  const title = S.folder === '' ? t('ui.allProfiles') : S.folder === '__none' ? t('ui.noFolder') : S.folder;
  const create = h('button', { class: 'btn primary upper' }, icon('plus', 16), h('span', { text: t('ui.createProfile') }));
  create.onclick = () => openEditor(null);
  const quick = h('button', { class: 'btn outline upper' }, osIcon('windows11', 15), h('span', { text: t('ui.quickProfile') }));
  quick.title = t('ui.quickHint');
  quick.onclick = () => void quickProfile('windows11');
  const quickOs = h('button', { class: 'btn outline caret', title: t('fp.os'), 'aria-label': t('fp.os') }, icon('chevronDown', 16));
  quickOs.onclick = () => popupMenu(quickOs, (['windows11', 'windows10', 'macos', 'linux'] as FpOs[]).map((os) => ({ icon: os === 'macos' ? 'apple' : os === 'linux' ? 'linux' : 'windows', label: osLabel(os), fn: () => void quickProfile(os) })));
  const more = h('button', { class: 'icon-btn', title: t('common.more'), 'aria-label': t('common.more') }, icon('dots', 20));
  more.onclick = () => popupMenu(more, [
    { icon: 'eyeOff', label: t('profile.privateBrowsing'), fn: privateBrowsingDialog },
    { icon: 'import', label: t('profile.import'), fn: importDialog },
    { icon: 'fingerprint', label: t('privacy.runDetect'), fn: () => void run(api.invoke('mgr:launch-detect')) },
  ]);
  const category = select<BrowserCategory>(browserCategory, [
    ['all', t('profiles.browser.all')], ['octo', t('profile.browserShell.octo')], ['chrome', t('profile.browserShell.chrome')],
    ['chromium', t('profile.browserShell.chromium')], ['firefox', t('profile.browserShell.firefox')], ['safari', t('profile.browserShell.safari')], ['mobile', t('profiles.browser.mobile')],
  ], (value) => { browserCategory = value; localStorage.setItem(BROWSER_CATEGORY_KEY, value); S.render(); });
  category.title = t('profiles.browser.category');
  const sorting = select<ProfileSort>(profileSort, [
    ['manual', t('profiles.sort.manual')], ['recent', t('profiles.sort.recent')], ['name', t('profiles.sort.name')], ['browser', t('profiles.sort.browser')],
  ], (value) => { profileSort = value; localStorage.setItem(PROFILE_SORT_KEY, value); S.render(); });
  sorting.title = t('profiles.sort.label');
  const organization = h('div', { class: 'profile-organization' }, category, sorting);
  const search = input(S.search, { type: 'search', placeholder: t('ui.searchPh'), 'aria-label': t('ui.searchPh'), id: 'profileSearch' });
  search.oninput = () => { S.search = search.value; drawTable(); };
  const searchBox = h('div', { class: 'search' }, icon('search', 16), search);
  v.append(h('div', { class: 'toolbar' },
    h('h1', { class: 'ell', text: title }),
    h('div', { class: 'grow' }),
    create, h('div', { class: 'split' }, quick, quickOs), more, organization, searchBox));

  // ---- bulk bar
  const sel = [...S.selected].filter((id) => S.profiles.some((p) => p.id === id));
  if (sel.length) {
    const bulk = (action: string, arg?: unknown) => run(api.invoke('mgr:profile-bulk', action, sel, arg));
    const b = (ic: string, key: string, fn: () => void, cls = '') => { const x = h('button', { class: `btn small ${cls}` }, icon(ic, 14), h('span', { text: t(key) })); x.onclick = fn; return x; };
    const clearSel = h('button', { class: 'icon-btn', title: t('ui.clearSelection') }, icon('close', 16));
    clearSel.onclick = () => { S.selected.clear(); S.render(); };
    v.append(h('div', { class: 'bulkbar' },
      h('b', { text: t('ui.selected', { n: sel.length }) }),
      b('play', 'ui.start', () => void bulk('start'), 'ok'),
      b('stop', 'ui.stop', () => void bulk('stop')),
      b('folder', 'ui.moveToFolder', () => moveDialog(sel)),
      b('tag', 'ui.setStatus', () => statusDialog(sel)),
      b('trash', 'profile.moveToTrash', () => confirmDialog(t('ui.deleteMany', { n: sel.length }), async () => { await bulk('remove'); S.selected.clear(); return true; }, 'toast.profileDeleted'), 'danger'),
      h('div', { class: 'grow' }), clearSel));
  }

  // ---- table
  const activeCols = getSelectedProfileColumns();
  const trGridCols = getGridTemplateColumns(activeCols);

  const table = h('div', { class: 'table profile-table', role: 'table' });
  const allCb = h('input', { type: 'checkbox', 'aria-label': t('ui.selectAll') });
  allCb.checked = list.length > 0 && list.every((p) => S.selected.has(p.id));
  allCb.indeterminate = !allCb.checked && list.some((p) => S.selected.has(p.id));
  allCb.onchange = () => { for (const p of list) { if (allCb.checked) S.selected.add(p.id); else S.selected.delete(p.id); } S.render(); };

  const colSettingsBtn = h('button', {
    class: 'icon-btn tiny col-settings-btn',
    title: t('ui.customizeColumns'),
    'aria-label': t('ui.customizeColumns'),
  }, icon('gear', 14));
  colSettingsBtn.onclick = (e) => {
    e.stopPropagation();
    columnsDialog(() => {
      S.render();
    });
  };

  const headCells: HTMLElement[] = [
    h('div', { class: 'td c-check' }, allCb),
    h('div', { class: 'td c-icons' }),
    h('div', { class: 'td c-name', text: t('ui.col.name') }),
    h('div', { class: 'td c-start' }),
  ];

  for (const colKey of activeCols) {
    const def = ALL_PROFILE_COLUMNS.find((c) => c.key === colKey);
    const label = def ? t(def.labelKey) : colKey;
    headCells.push(h('div', { class: `td c-${colKey.toLowerCase()}`, text: label }));
  }

  headCells.push(h('div', { class: 'td c-col-settings' }, colSettingsBtn));

  const head = h('div', { class: 'tr th', role: 'row' }, ...headCells);
  head.style.gridTemplateColumns = trGridCols;

  const body = h('div', { class: 'tbody' });
  const drawTable = () => {
    clear(body);
    const rows = visibleProfiles();
    if (!rows.length) {
      const c = h('button', { class: 'btn primary upper' }, icon('plus', 16), h('span', { text: t('ui.createProfile') }));
      c.onclick = () => openEditor(null);
      const folderIsEmpty = !!S.folder && S.folder !== '__none' && !S.profiles.some((profile) => profile.folder === S.folder);
      if (folderIsEmpty) {
        const add = h('button', { class: 'btn', disabled: S.profiles.length === 0 }, icon('folder', 15), h('span', { text: t('folder.empty.addExisting') }));
        add.onclick = () => addExistingToFolderDialog(S.folder);
        body.append(h('div', { class: 'empty folder-empty' }, h('div', { class: 'empty-icon' }, icon('folder', 44)),
          h('h2', { text: t('folder.empty.title') }), h('p', { class: 'muted', text: t('folder.empty.text') }),
          h('div', { class: 'empty-actions' }, add, c)));
      } else {
        body.append(h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('users', 44)),
          h('h2', { text: S.profiles.length ? t('ui.noMatch') : t('profiles.empty.title') }),
          h('p', { class: 'muted', text: S.profiles.length ? t('ui.noMatchHint') : t('profiles.empty.text') }), c));
      }
    }
    for (const p of rows) body.append(row(p, activeCols, trGridCols));
    footCount.textContent = t('ui.countOf', { n: rows.length, total: S.profiles.length, running: S.profiles.filter((p) => p.running).length });
  };
  table.append(head, body);
  v.append(table);

  // ---- footer: tag filter + counts
  const tags = [...new Set(S.profiles.flatMap((p) => p.tags ?? []))].sort();
  const tagBar = h('div', { class: 'tagbar' });
  if (!tags.length) tagBar.append(h('span', { class: 'tg muted', text: t('ui.noTags') }));
  for (const tg of tags) {
    const b = h('button', { class: `tg${S.tagFilter === tg ? ' on' : ''}`, text: tg });
    b.onclick = () => { S.tagFilter = S.tagFilter === tg ? '' : tg; S.render(); };
    tagBar.append(b);
  }
  if (S.tagFilter) {
    const selectFiltered = h('button', { class: 'btn small outline', text: t('ui.selectFiltered') });
    selectFiltered.onclick = () => { for (const p of list) S.selected.add(p.id); S.render(); };
    tagBar.append(selectFiltered);
  }
  const footCount = h('span', { class: 'muted' });
  v.append(h('div', { class: 'tfoot' }, tagBar, h('div', { class: 'grow' }), footCount));
  drawTable();

  // Live worktime of running profiles.
  if (ticker) clearInterval(ticker);
  ticker = window.setInterval(() => {
    if (S.view !== 'profiles') { clearInterval(ticker); ticker = undefined; return; }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.wt'))) {
      const p = S.profiles.find((x) => x.id === el.dataset.id);
      if (p?.running) el.textContent = fmtDuration(worktime(p));
    }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('.timer-wt'))) {
      const p = S.profiles.find((x) => x.id === el.dataset.id);
      if (p?.running && p.startedAt) {
        el.textContent = fmtDuration(Math.max(0, Math.floor((Date.now() - p.startedAt) / 1000)));
      } else {
        el.textContent = '—';
      }
    }
  }, 1000);
}

/** "/" focuses the search, like in the reference UI. */
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && S.view === 'profiles' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) && $('modal').classList.contains('hidden')) {
    e.preventDefault();
    $('profileSearch')?.focus();
  }
});
