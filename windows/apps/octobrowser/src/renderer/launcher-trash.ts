/** Local profile Trash: restore keeps profile data intact; permanent erase is explicit. */
import { api, clear } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { Profile, confirmDialog, run, toast } from './launcher-ui';

function fmt(iso?: string): string {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? new Date(n).toLocaleString() : '—';
}

export async function renderTrash(v: HTMLElement): Promise<void> {
  v.append(h('div', { class: 'toolbar' }, h('h1', { text: t('launcher.nav.trash') })));
  const list = await run(api.invoke<Profile[]>('mgr:trash'));
  if (!list) return;
  const empty = h('button', { class: 'btn danger', disabled: !list.length }, icon('trash', 15), h('span', { text: t('trash.empty') }));
  empty.onclick = () => confirmDialog(t('trash.emptyConfirm'), async () => {
    const n = await api.invoke<number>('mgr:trash-empty');
    toast(t('trash.emptied', { n }), 'ok');
    return n;
  }, 'toast.saved');
  v.firstElementChild?.append(empty);

  if (!list.length) {
    v.append(h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon('trash', 42)), h('h2', { text: t('trash.emptyTitle') }), h('p', { class: 'muted', text: t('trash.emptyDesc') })));
    return;
  }

  const table = h('div', { class: 'trash-list' });
  const draw = () => {
    clear(table);
    for (const p of list) {
      const restore = h('button', { class: 'btn small', text: t('trash.restore') });
      restore.onclick = async () => {
        const r = await run(api.invoke('mgr:trash-restore', p.id));
        if (!r) return;
        list.splice(list.indexOf(p), 1);
        toast(t('trash.restored', { name: p.name }), 'ok');
        draw();
      };
      const erase = h('button', { class: 'btn small danger', text: t('trash.erase') });
      erase.onclick = () => confirmDialog(t('trash.eraseConfirm', { name: p.name }), async () => {
        await api.invoke('mgr:trash-delete', p.id);
        list.splice(list.indexOf(p), 1);
        draw();
        return true;
      }, 'toast.saved');
      table.append(h('div', { class: 'trash-row' },
        h('div', { class: 'trash-mark' }, icon('trash', 18)),
        h('div', { class: 'grow' }, h('b', { text: p.name }), h('span', { class: 'muted small', text: `${t('trash.movedAt')}: ${fmt(p.trashedAt)}` })),
        h('div', { class: 'row' }, restore, erase)));
    }
    empty.disabled = !list.length;
  };
  v.append(h('p', { class: 'hint', text: t('trash.hint') }), table);
  draw();
}
