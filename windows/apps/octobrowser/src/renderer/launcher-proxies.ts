/**
 * apps/octobrowser/src/renderer/launcher-proxies.ts
 *
 * Proxies page: saved proxies (credentials stay in the secret store), mass
 * add with per-line format detection, check (exit IP / country / latency),
 * rename / change-IP URL, delete, "used by N profiles".
 */
import { api, clear } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { parseProxyList, proxyRotation } from '@octo/core/proxy';
import { S, SavedProxy, ProxyType, ProxyCheck, run, toast, modal, closeModal, confirmDialog, field, input, select, seg, checkLine, proxyText, popupMenu, copyText } from './launcher-ui';

function usedBy(id: string): number {
  return S.profiles.filter((p) => p.network.proxy?.savedId === id).length;
}

async function checkMany(ids: string[]): Promise<void> {
  let ok = 0;
  let bad = 0;
  // A few at a time: fast, without opening dozens of connections at once.
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      document.querySelector(`[data-pid="${id}"]`)?.classList.add('checking');
      const r = await api.invoke<ProxyCheck>('mgr:proxies-check', id).catch(() => undefined);
      if (r?.ok) ok++; else bad++;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  toast(t('proxy.checkedMany', { ok, bad }), bad ? 'err' : 'ok');
}

function addDialog(): void {
  let type: ProxyType = 'http';
  modal(t('proxy.addTitle'), (box) => {
    const ta = h('textarea', { class: 'mass', rows: '9', spellcheck: 'false', placeholder: t('proxy.massPh') });
    const name = input('', { maxlength: '48', placeholder: t('proxy.namePrefix') });
    const preview = h('div', { class: 'mass-preview' });
    const ok = h('button', { class: 'btn primary upper' }, icon('plus', 15), h('span', { text: t('proxy.addN', { n: 0 }) })) as HTMLButtonElement;
    const refresh = () => {
      clear(preview);
      const list = parseProxyList(ta.value, type);
      const good = list.filter((r) => r.ok).length;
      for (const r of list.slice(0, 200)) {
        preview.append(h('div', { class: `mp ${r.ok ? 'ok' : 'bad'}` },
          icon(r.ok ? 'check' : 'alert', 13),
          h('span', { class: 'ln', text: String(r.line) }),
          h('span', { class: 'ell grow', text: r.ok && r.proxy ? `${r.proxy.type}://${r.proxy.host}:${r.proxy.port}${r.proxy.username ? ` · ${t('proxy.withLogin')}` : ''}` : r.raw }),
          h('span', { class: 'muted small', text: r.ok ? r.format ?? '' : t(r.error ?? 'proxy.err.format') })));
      }
      if (!list.length) preview.append(h('p', { class: 'hint', text: t('proxy.massHint') }));
      (ok.lastChild as HTMLElement).textContent = t('proxy.addN', { n: good });
      ok.disabled = good === 0;
    };
    ta.oninput = refresh;
    ok.onclick = async () => {
      ok.disabled = true;
      const r = await run(api.invoke<{ added: number; errors: Array<{ line: number; error: string }> }>('mgr:proxies-add', ta.value, type, name.value.trim()));
      ok.disabled = false;
      if (!r) return;
      closeModal();
      toast(t('proxy.added', { n: r.added }) + (r.errors.length ? ` · ${t('proxy.skipped', { n: r.errors.length })}` : ''), r.errors.length ? 'info' : 'ok');
    };
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    box.append(
      h('div', { class: 'field' }, h('span', { class: 'lbl', text: t('proxy.defaultType') }),
        seg<ProxyType>(type, [['http', 'HTTP'], ['https', 'HTTPS'], ['socks4', 'SOCKS4'], ['socks5', 'SOCKS5']], (v) => { type = v; refresh(); }),
        h('span', { class: 'hint', text: t('proxy.defaultTypeHint') })),
      field('proxy.list', ta),
      preview,
      field('proxy.name', name, 'proxy.namePrefixHint'),
      h('div', { class: 'modal-actions' }, cancel, ok));
    refresh();
  }, 'wide');
}

const MB = 1_000_000;
const GB = 1_000_000_000;
function dataText(value: number): string {
  if (value >= GB) return `${(value / GB).toFixed(value >= 10 * GB ? 1 : 2)} GB`;
  if (value >= MB) return `${(value / MB).toFixed(value >= 10 * MB ? 1 : 2)} MB`;
  return `${Math.max(0, Math.round(value / 1_000))} KB`;
}

function usageText(sp: SavedProxy): string {
  return sp.usageLimitBytes > 0
    ? `${dataText(sp.usageBytes)} / ${dataText(sp.usageLimitBytes)}`
    : `${dataText(sp.usageBytes)} · ${t('proxy.usageUnlimited')}`;
}

function editDialog(sp: SavedProxy): void {
  modal(t('proxy.editTitle'), (box) => {
    const name = input(sp.name, { maxlength: '64' });
    const cip = input(sp.changeIpUrl, { maxlength: '2000', placeholder: 'https://...' });
    let usageUnit: 'mb' | 'gb' = sp.usageLimitBytes >= GB ? 'gb' : 'mb';
    const amount = input(sp.usageLimitBytes ? String(Math.max(0, Math.round(sp.usageLimitBytes / (usageUnit === 'gb' ? GB : MB) * 100) / 100)) : '', { type: 'number', min: '0', max: '10000000', inputmode: 'decimal', placeholder: '0' });
    const unit = select<'mb' | 'gb'>(usageUnit, [['mb', 'MB'], ['gb', 'GB']], (value) => { usageUnit = value; });
    const quota = h('div', { class: 'row' }, amount, unit);
    // Rotation is observed locally from repeated checks; the user can override
    // it and state the advertised interval, which no check could discover.
    let rotationMode = sp.rotationMode;
    const rotation = seg<'auto' | 'rotating' | 'sticky'>(rotationMode, [['auto', t('proxy.rotation.auto')], ['rotating', t('proxy.rotation.rotating')], ['sticky', t('proxy.rotation.sticky')]], (value) => { rotationMode = value; });
    const interval = input(sp.rotationIntervalSec ? String(sp.rotationIntervalSec) : '', { type: 'number', min: '0', max: '86400', inputmode: 'numeric', placeholder: '0' });
    const folder = input(sp.folder, { maxlength: '48', placeholder: t('proxy.folderPh') });
    const detected = proxyRotation(sp);
    const ok = h('button', { class: 'btn primary', text: t('common.save') });
    ok.onclick = async () => {
      const numeric = Number(amount.value);
      if (!Number.isFinite(numeric) || numeric < 0) { toast(t('proxy.usageInvalid'), 'err'); return; }
      const usageLimitBytes = Math.min(10_000_000_000_000_000, Math.round(numeric * (usageUnit === 'gb' ? GB : MB)));
      const rotationIntervalSec = Math.max(0, Math.min(86_400, Math.round(Number(interval.value) || 0)));
      if ((await run(api.invoke('mgr:proxies-update', sp.id, {
        name: name.value.trim(), changeIpUrl: cip.value.trim(), usageLimitBytes,
        folder: folder.value.trim(), rotationMode, rotationIntervalSec,
      }), 'toast.saved')) !== undefined) closeModal();
    };
    box.append(h('p', { class: 'muted', text: `${proxyText(sp)}${sp.hasCredentials ? ` · ${t('proxy.withLogin')}` : ''}` }),
      field('proxy.name', name), field('proxy.changeIpUrl', cip, 'ui.optional'),
      field('proxy.usageLimit', quota, 'proxy.usageHint'), h('p', { class: 'hint', text: `${t('proxy.usageCurrent')}: ${usageText(sp)}` }),
      field('proxy.folder', folder, 'proxy.folderHintOne'),
      field('proxy.rotation', rotation, 'proxy.rotationHint'),
      field('proxy.rotationInterval', interval, 'proxy.rotationIntervalHint'),
      h('p', { class: 'hint', text: `${t('proxy.rotation.detected')}: ${t(`proxy.rotation.${detected.kind}`)}${detected.intervalSec ? ` · ${t('proxy.rotation.every', { time: intervalText(detected.intervalSec) })}` : ''} · ${t('proxy.rotation.samples', { n: detected.samples })}` }),
      h('div', { class: 'modal-actions' }, ok));
  });
}

/** Human answer to "does this endpoint rotate?", with its evidence. */
function rotationCell(sp: SavedProxy): HTMLElement {
  const r = proxyRotation(sp);
  const interval = r.intervalSec > 0 ? intervalText(r.intervalSec) : '';
  const title = r.source === 'manual'
    ? t('proxy.rotation.manualNote')
    : r.source === 'observed'
      ? t('proxy.rotation.observedNote', { n: r.samples })
      : t('proxy.rotation.unknownNote');
  return h('div', { class: 'rot', title },
    h('span', { class: `ptype rot-${r.kind}`, text: t(`proxy.rotation.${r.kind}`) }),
    h('span', { class: 'muted small', text: interval ? t('proxy.rotation.every', { time: interval }) : (r.kind === 'unknown' ? t('proxy.rotation.needsChecks') : '') }));
}

function intervalText(seconds: number): string {
  if (seconds >= 3600) return t('proxy.rotation.hours', { n: Math.round(seconds / 360) / 10 });
  if (seconds >= 60) return t('proxy.rotation.minutes', { n: Math.round(seconds / 6) / 10 });
  return t('proxy.rotation.seconds', { n: seconds });
}

/** Move the selected proxies into a new or existing folder. */
function folderDialog(ids: string[]): void {
  modal(t('proxy.folderTitle'), (box) => {
    const existing = [...new Set(S.proxies.map((p) => p.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const name = input(S.proxies.find((p) => p.id === ids[0])?.folder ?? '', { maxlength: '48', placeholder: t('proxy.folderPh') });
    const quick = h('div', { class: 'row wrap' });
    for (const folder of existing) {
      const b = h('button', { class: 'btn small' }, icon('folder', 14), h('span', { text: folder }));
      b.onclick = () => { name.value = folder; };
      quick.append(b);
    }
    const ok = h('button', { class: 'btn primary', text: t('common.save') });
    ok.onclick = async () => {
      if ((await run(api.invoke('mgr:proxies-set-folder', ids, name.value.trim()), 'toast.saved')) !== undefined) closeModal();
    };
    const root = h('button', { class: 'btn', text: t('proxy.folderRoot') });
    root.onclick = async () => {
      if ((await run(api.invoke('mgr:proxies-set-folder', ids, ''), 'toast.saved')) !== undefined) closeModal();
    };
    box.append(h('p', { class: 'muted', text: t('proxy.folderHint', { n: ids.length }) }),
      field('proxy.folder', name), existing.length ? quick : h('p', { class: 'hint', text: t('proxy.folderNone') }),
      h('div', { class: 'modal-actions' }, root, ok));
  });
}

/** Folder chips above the table; they only filter the local list. */
function folderBar(): HTMLElement {
  const bar = h('div', { class: 'row wrap folderbar' });
  const folders = [...new Set(S.proxies.map((p) => p.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const chip = (value: string, label: string, count: number) => {
    const b = h('button', { class: `btn small${S.proxyFolder === value ? ' primary' : ''}` }, icon(value ? 'folder' : 'proxy', 14), h('span', { text: `${label} (${count})` }));
    b.onclick = () => { S.proxyFolder = value; S.render(); };
    return b;
  };
  bar.append(chip('', t('proxy.folderAll'), S.proxies.length));
  const rootCount = S.proxies.filter((p) => !p.folder).length;
  if (rootCount && folders.length) bar.append(chip('\u0000', t('proxy.folderUnfiled'), rootCount));
  for (const folder of folders) bar.append(chip(folder, folder, S.proxies.filter((p) => p.folder === folder).length));
  return bar;
}

export function renderProxies(v: HTMLElement): void {
  const offline = S.init.settings.offlineMode !== 'online';
  const add = h('button', { class: 'btn primary upper' },  icon('plus', 16), h('span', { text: t('proxy.addProxies') }));
  add.onclick = addDialog;
  const sel = [...S.proxySelected].filter((id) => S.proxies.some((p) => p.id === id));
  const checkSel = h('button', { class: 'btn outline upper', disabled: offline || !S.proxies.length, title: offline ? t('settings.offlineActionBlocked') : '' }, icon('swap', 15), h('span', { text: sel.length ? t('proxy.checkSelected', { n: sel.length }) : t('proxy.checkAll') }));
  checkSel.onclick = async () => { (checkSel as HTMLButtonElement).disabled = true; await checkMany(sel.length ? sel : S.proxies.map((p) => p.id)); };
  const move = h('button', { class: 'btn outline', disabled: !sel.length }, icon('folder', 15), h('span', { text: t('proxy.moveToFolder') }));
  move.onclick = () => folderDialog(sel);
  const del = h('button', { class: 'btn danger', disabled: !sel.length }, icon('trash', 15), h('span', { text: t('profile.delete') }));
  del.onclick = () => confirmDialog(t('proxy.deleteMany', { n: sel.length }), async () => { await api.invoke('mgr:proxies-remove', sel); S.proxySelected.clear(); return true; }, 'toast.saved');
  v.append(h('div', { class: 'toolbar' }, h('h1', { text: t('launcher.nav.proxies') }), h('div', { class: 'grow' }), del, move, checkSel, add));

  if (!S.proxies.length) {
    const c = h('button', { class: 'btn primary upper' }, icon('plus', 16), h('span', { text: t('proxy.addProxies') }));
    c.onclick = addDialog;
    v.append(h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('proxy', 44)), h('h2', { text: t('proxy.emptyTitle') }), h('p', { class: 'muted', text: t('proxy.emptyText') }), c));
    return;
  }
  v.append(folderBar());
  const shown = S.proxies.filter((p) => (S.proxyFolder === '' ? true : S.proxyFolder === '\u0000' ? !p.folder : p.folder === S.proxyFolder));
  const table = h('div', { class: 'table ptable', role: 'table' });
  const allCb = h('input', { type: 'checkbox', 'aria-label': t('ui.selectAll') });
  allCb.checked = shown.length > 0 && shown.every((p) => S.proxySelected.has(p.id));
  allCb.onchange = () => { for (const p of shown) { if (allCb.checked) S.proxySelected.add(p.id); else S.proxySelected.delete(p.id); } S.render(); };
  table.append(h('div', { class: 'tr th', role: 'row' },
    h('div', { class: 'td c-check' }, allCb), h('div', { class: 'td c-pname', text: t('proxy.name') }), h('div', { class: 'td c-ptype', text: t('proxy.type') }),
    h('div', { class: 'td c-paddr', text: t('proxy.address') }), h('div', { class: 'td c-pchk', text: t('proxy.status') }), h('div', { class: 'td c-prot', text: t('proxy.rotation') }), h('div', { class: 'td c-pusage', text: t('proxy.usage') }), h('div', { class: 'td c-pused', text: t('proxy.usedBy') }), h('div', { class: 'td c-pact' })));
  const body = h('div', { class: 'tbody' });
  for (const sp of shown) {
    const cb = h('input', { type: 'checkbox', 'aria-label': t('ui.select'), checked: S.proxySelected.has(sp.id) });
    cb.onchange = () => { if (cb.checked) S.proxySelected.add(sp.id); else S.proxySelected.delete(sp.id); S.render(); };
    const chk = h('button', { class: 'icon-btn', title: offline ? t('settings.offlineActionBlocked') : t('proxy.check'), 'aria-label': t('proxy.check'), disabled: offline }, icon('swap', 17));
    chk.onclick = async () => { chk.classList.add('spinning'); await run(api.invoke('mgr:proxies-check', sp.id)); chk.classList.remove('spinning'); };
    const more = h('button', { class: 'icon-btn', title: t('common.more'), 'aria-label': t('common.more') }, icon('dots', 17));
    more.onclick = () => popupMenu(more, [
      { icon: 'edit', label: t('common.edit'), fn: () => editDialog(sp) },
      { icon: 'copy', label: t('proxy.copy'), fn: () => void copyText(proxyText(sp)) },
      { icon: 'folder', label: t('proxy.moveToFolder'), fn: () => folderDialog([sp.id]) },
      ...(!offline && sp.changeIpUrl ? [{ icon: 'refreshCircle', label: t('proxy.changeIpNow'), fn: async () => { const r = await run(api.invoke<{ ok: boolean; status: number }>('mgr:proxy-change-ip', sp.changeIpUrl)); if (r) toast(r.ok ? t('proxy.ipChanged') : `${t('proxy.ipChangeFailed')} (HTTP ${r.status})`, r.ok ? 'ok' : 'err'); } }] : []),
      'sep',
      { icon: 'trash', label: t('profile.delete'), danger: true, fn: () => confirmDialog(t('proxy.deleteOne', { name: sp.name || proxyText(sp) }), () => api.invoke('mgr:proxies-remove', [sp.id]), 'toast.saved') },
    ]);
    const n = usedBy(sp.id);
    body.append(h('div', { class: `tr${S.proxySelected.has(sp.id) ? ' sel' : ''}`, role: 'row', 'data-pid': sp.id },
      h('div', { class: 'td c-check' }, cb),
      h('div', { class: 'td c-pname' }, h('b', { class: 'ell', text: sp.name || '—' })),
      h('div', { class: 'td c-ptype' }, h('span', { class: 'ptype', text: sp.type.toUpperCase() })),
      h('div', { class: 'td c-paddr' }, h('span', { class: 'ell mono', text: `${sp.host}:${sp.port}` }), sp.hasCredentials ? h('span', { class: 'mini', title: t('proxy.withLogin') }, icon('key', 13)) : null),
      h('div', { class: 'td c-pchk' }, checkLine(sp.lastCheck)),
      h('div', { class: 'td c-prot' }, rotationCell(sp)),
      h('div', { class: `td c-pusage${sp.usageLimitBytes > 0 && sp.usageBytes >= sp.usageLimitBytes ? ' warn' : ''}`, title: t('proxy.usageHint') }, h('span', { class: 'small', text: usageText(sp) })),
      h('div', { class: 'td c-pused' }, h('span', { class: n ? '' : 'muted', text: String(n) })),
      h('div', { class: 'td c-pact' }, chk, more)));
  }
  table.append(body);
  v.append(table, h('div', { class: 'tfoot' }, h('span', { class: 'muted', text: t('proxy.count', { n: shown.length }) }), h('div', { class: 'grow' }), h('span', { class: 'hint', text: t('proxy.secretsNote') })));
}
