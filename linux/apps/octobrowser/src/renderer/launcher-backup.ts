/**
 * apps/octobrowser/src/renderer/launcher-backup.ts
 *
 * The Backup category: move whole profiles from one Octo.su to another.
 *
 * Deliberately small. One encrypted file goes out, the same file comes in on
 * the other computer, and this view explains those steps in place instead of
 * hiding them behind a wizard. Export always produces a fresh 12-word phrase
 * that is shown exactly once; import asks for that phrase and adds every
 * profile in the file as a NEW profile - nothing on this computer is replaced,
 * and the file can be imported again later without losing the first copy.
 */
import { api } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { phraseDisplay, phraseEntry } from '@octo/shell/renderer/phrase';
import { Profile, S, closeModal, errText, modal, run, toast, toggle } from './launcher-ui';

/** One line of "how this works", with the step number in its own column. */
function step(number: number, titleKey: string, bodyKey: string): HTMLElement {
  return h('div', { class: 'backup-step' },
    h('span', { class: 'backup-step-n', text: String(number) }),
    h('div', {},
      h('strong', { text: t(titleKey) }),
      h('p', { class: 'hint', text: t(bodyKey) })));
}

/** The checkbox state lives in the row, exactly like every other launcher dialog. */
function checked(row: HTMLElement): boolean {
  return (row.querySelector('input') as HTMLInputElement | null)?.checked !== false;
}

export function renderBackup(root: HTMLElement): void {
  root.append(h('div', { class: 'view-head' }, h('h1', { text: t('launcher.nav.backup') })));

  const card = h('div', { class: 'panel backup-card' },
    h('h2', {}, icon('box', 18), h('span', { text: t('backup.title') })),
    h('p', { class: 'hint', text: t('backup.subtitle') }),
    step(1, 'backup.step1Title', 'backup.step1Body'),
    step(2, 'backup.step2Title', 'backup.step2Body'),
    step(3, 'backup.step3Title', 'backup.step3Body'));

  const exportBtn = h('button', { class: 'btn primary' }, icon('export', 15), h('span', { text: t('backup.export') })) as HTMLButtonElement;
  const importBtn = h('button', { class: 'btn' }, icon('import', 15), h('span', { text: t('backup.import') })) as HTMLButtonElement;
  exportBtn.onclick = () => void exportFlow();
  importBtn.onclick = () => void importFlow();
  card.append(
    h('div', { class: 'row backup-actions' }, exportBtn, importBtn),
    h('p', { class: 'hint small', text: t('backup.note') }));
  root.append(card);
}

/** Export: every stopped profile, a fresh phrase shown once, one file. */
async function exportFlow(): Promise<void> {
  // The rail can be clicked before the first profile list arrives; ask once so
  // "Export" never says there is nothing to back up while profiles exist.
  if (!S.profiles.length) S.profiles = (await run(api.invoke<Profile[]>('mgr:profiles'))) ?? S.profiles;
  const running = S.profiles.filter((profile) => profile.running);
  const chosen = S.profiles.filter((profile) => !profile.running);
  if (!chosen.length) { toast(t('backup.needProfile'), 'err'); return; }

  const phrase = await run(api.invoke<string>('mgr:new-passphrase'));
  if (!phrase) return;

  modal(t('backup.exportTitle'), (box) => {
    const data = toggle(true, 'backup.withData');
    const ok = h('button', { class: 'btn primary', text: t('backup.export') }) as HTMLButtonElement;
    ok.disabled = true;
    const shown = phraseDisplay(phrase, (confirmed) => { ok.disabled = !confirmed; });
    ok.onclick = async () => {
      ok.disabled = true;
      const r = await run(api.invoke<{ profiles: number } | null>('mgr:backup-export', chosen.map((p) => p.id), phrase, checked(data)));
      ok.disabled = false;
      if (r) { closeModal(); toast(t('backup.exported', { n: r.profiles }), 'ok'); }
    };
    const parts: Array<Node | string> = [h('p', { class: 'hint', text: t('backup.exportHint', { n: chosen.length }) })];
    if (running.length) parts.push(h('p', { class: 'hint warn', text: t('backup.skipped', { names: running.map((p) => p.name).join(', ') }) }));
    parts.push(shown.el, data, h('p', { class: 'note small', text: t('backup.exportDataNote') }), h('div', { class: 'modal-actions' }, ok));
    box.append(...parts);
  });
}

/** Import: pick the file, type its 12 words, get the profiles as new entries. */
async function importFlow(): Promise<void> {
  const picked = await run(api.invoke<{ file: string; name: string } | null>('mgr:backup-pick'));
  if (!picked) return;

  modal(t('backup.importTitle'), (box) => {
    const err = h('div', { class: 'err' });
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    const ok = h('button', { class: 'btn primary', text: t('backup.import') }) as HTMLButtonElement;
    const entry = phraseEntry((complete) => { ok.disabled = !complete; });
    ok.disabled = true;
    ok.onclick = async () => {
      ok.disabled = true;
      err.textContent = '';
      try {
        const done = await api.invoke<{ profiles: Array<{ id: string; name: string }> }>('mgr:backup-import', picked.file, entry.value());
        closeModal();
        toast(t('backup.imported', { n: done.profiles.length }), 'ok');
      } catch (error) {
        err.textContent = errText(error);
        ok.disabled = false;
      }
    };
    box.append(
      h('p', { class: 'hint', text: t('backup.importHint', { file: picked.name }) }),
      entry.el,
      err,
      h('div', { class: 'modal-actions' }, cancel, ok));
    entry.focus();
  });
}
