/** Settings workflow for an explicitly user-requested Dolphin Anty migration. */
import { api } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { S, closeModal, modal, run, toast } from './launcher-ui';

interface DolphinProfileSummary {
  id: string;
  name: string;
  tags: string[];
  folder: string;
  hasProxy: boolean;
}

type ImportField = 'organization' | 'fingerprint' | 'proxy' | 'startPages' | 'cookies';
type ImportOptions = Record<ImportField, boolean>;

interface ImportResult { imported: number; failed: number; skippedProxies: number; queuedCookieProfiles: number; unavailableCookieProfiles: number; names: string[] }

const fields: Array<[ImportField, string, string]> = [
  ['organization', 'dolphin.field.organization', 'dolphin.field.organizationHint'],
  ['fingerprint', 'dolphin.field.fingerprint', 'dolphin.field.fingerprintHint'],
  ['proxy', 'dolphin.field.proxy', 'dolphin.field.proxyHint'],
  ['startPages', 'dolphin.field.startPages', 'dolphin.field.startPagesHint'],
  ['cookies', 'dolphin.field.cookies', 'dolphin.field.cookiesHint'],
];

function fieldCheck(label: string, hint: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
  const box = h('input', { type: 'checkbox', checked }) as HTMLInputElement;
  box.onchange = () => onChange(box.checked);
  return h('label', { class: 'dolphin-option' }, box, h('span', {}, h('b', { text: t(label) }), h('small', { text: t(hint) })));
}

/** `source` is either a live API token or the text of a local export file. */
function selectionStep(source: { token: string } | { file: string }, profiles: DolphinProfileSummary[]): void {
  const selected = new Set(profiles.map((profile) => profile.id));
  const options: ImportOptions = { organization: true, fingerprint: true, proxy: true, startPages: true, cookies: true };

  modal(t('dolphin.chooseTitle'), (box) => {
    const selectedCount = h('span', { class: 'muted', text: '' });
    const selectAll = h('input', { type: 'checkbox', checked: true, 'aria-label': t('dolphin.selectAll') }) as HTMLInputElement;
    const list = h('div', { class: 'dolphin-profiles', role: 'list' });
    const importButton = h('button', { class: 'btn primary' }, icon('import', 15), h('span', { text: t('dolphin.importSelected', { n: profiles.length }) })) as HTMLButtonElement;

    const update = () => {
      const count = selected.size;
      selectedCount.textContent = t('dolphin.selected', { n: count, total: profiles.length });
      selectAll.checked = count === profiles.length;
      selectAll.indeterminate = count > 0 && count < profiles.length;
      importButton.disabled = count === 0;
      const label = importButton.querySelector('span');
      if (label) label.textContent = t('dolphin.importSelected', { n: count });
    };

    selectAll.onchange = () => {
      selected.clear();
      if (selectAll.checked) for (const profile of profiles) selected.add(profile.id);
      for (const input of Array.from(list.querySelectorAll<HTMLInputElement>('input[type=checkbox]'))) input.checked = selected.has(input.value);
      update();
    };

    for (const profile of profiles) {
      const check = h('input', { type: 'checkbox', value: profile.id, checked: true, 'aria-label': profile.name }) as HTMLInputElement;
      check.onchange = () => { if (check.checked) selected.add(profile.id); else selected.delete(profile.id); update(); };
      const details = [
        profile.folder ? `${t('ui.folder')}: ${profile.folder}` : '',
        profile.tags.length ? profile.tags.join(', ') : '',
        profile.hasProxy ? t('dolphin.hasProxy') : '',
      ].filter(Boolean).join(' · ');
      list.append(h('label', { class: 'dolphin-profile', role: 'listitem' }, check,
        h('span', { class: 'dolphin-profile-copy' }, h('b', { class: 'ell', text: profile.name }), details ? h('small', { class: 'ell', text: details }) : null)));
    }

    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    importButton.onclick = async () => {
      importButton.disabled = true;
      const result = 'token' in source
        ? await run(api.invoke<ImportResult>('mgr:dolphin-import', { token: source.token, ids: [...selected], options }))
        : await run(api.invoke<ImportResult>('mgr:dolphin-import-file', { text: source.file, ids: [...selected], options }));
      if (!result) { importButton.disabled = false; return; }
      closeModal();
      const notes = [
        result.failed ? t('dolphin.importPartial', { failed: result.failed }) : '',
        result.skippedProxies ? t('dolphin.importProxySkipped', { n: result.skippedProxies }) : '',
        result.queuedCookieProfiles ? t('dolphin.importCookiesQueued', { n: result.queuedCookieProfiles }) : '',
        result.unavailableCookieProfiles ? t('dolphin.importCookiesUnavailable', { n: result.unavailableCookieProfiles }) : '',
      ].filter(Boolean);
      toast(t('dolphin.importComplete', { n: result.imported }), notes.length ? 'info' : 'ok', notes.join(' ') || t('dolphin.importCompleteDetail'));
      S.render();
    };

    const choices = h('div', { class: 'dolphin-options' });
    for (const [field, label, hint] of fields) choices.append(fieldCheck(label, hint, options[field], (value) => { options[field] = value; }));
    box.append(
      h('p', { text: t('dolphin.chooseIntro') }),
      h('div', { class: 'dolphin-select-head' }, h('label', { class: 'check' }, selectAll, h('span', { text: t('dolphin.selectAll') })), selectedCount),
      list,
      h('h3', { text: t('dolphin.importWhat') }),
      choices,
      h('p', { class: 'hint', text: t('dolphin.limits') }),
      h('div', { class: 'modal-actions' }, cancel, importButton),
    );
    update();
  }, 'wide');
}

/** Open from Settings. The API token remains only in this in-memory modal flow. */
export function openDolphinImportDialog(): void {
  modal(t('dolphin.title'), (box) => {
    const token = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', maxlength: '2048', placeholder: t('dolphin.tokenPlaceholder') }) as HTMLInputElement;
    const load = h('button', { class: 'btn primary', disabled: true }, icon('download', 15), h('span', { text: t('dolphin.load') })) as HTMLButtonElement;
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    const openNative = h('button', { class: 'btn' }, icon('folder', 15), h('span', { text: t('dolphin.file') })) as HTMLButtonElement;
    const loadLocalText = async (text: string): Promise<void> => {
      const parsed = await run(api.invoke<{ count: number; profiles: DolphinProfileSummary[] }>('mgr:dolphin-parse-file', text));
      if (!parsed) return;
      if (!parsed.count) { toast(t('dolphin.err.file'), 'err', t('dolphin.fileHint')); return; }
      selectionStep({ file: text }, parsed.profiles);
    };
    openNative.onclick = async () => {
      openNative.disabled = true;
      const picked = await run(api.invoke<{ text: string; name: string } | null>('mgr:dolphin-pick-file'));
      openNative.disabled = false;
      if (picked?.text) await loadLocalText(picked.text);
    };
    token.oninput = () => { load.disabled = token.value.trim().length < 8; };
    token.onkeydown = (event) => { if (event.key === 'Enter' && !load.disabled) void loadProfiles(); };
    const loadProfiles = async () => {
      const value = token.value.trim();
      load.disabled = true;
      const profiles = await run(api.invoke<DolphinProfileSummary[]>('mgr:dolphin-list', value));
      token.value = ''; // Do not leave a credential visible in the abandoned step.
      if (!profiles) { load.disabled = false; return; }
      if (!profiles.length) { toast(t('dolphin.none'), 'info', t('dolphin.noneDetail')); load.disabled = false; return; }
      selectionStep({ token: value }, profiles);
    };
    load.onclick = () => void loadProfiles();
    // Local file import: no token, no request, everything stays on this machine.
    const file = h('input', { type: 'file', accept: '.json,.txt,application/json' }) as HTMLInputElement;
    file.onchange = async () => {
      const chosen = file.files?.[0];
      if (!chosen) return;
      if (chosen.size > 64 * 1024 * 1024) { toast(t('dolphin.err.fileTooBig'), 'err'); return; }
      const text = await chosen.text();
      const parsed = await run(api.invoke<{ count: number; profiles: DolphinProfileSummary[] }>('mgr:dolphin-parse-file', text));
      file.value = '';
      if (!parsed) return;
      if (!parsed.count) { toast(t('dolphin.err.file'), 'err', t('dolphin.fileHint')); return; }
      selectionStep({ file: text }, parsed.profiles);
    };
    box.append(
      h('p', { text: t('dolphin.intro') }),
      h('p', { class: 'hint', text: t('dolphin.privacy') }),
      h('label', { class: 'field dolphin-token' }, h('span', { class: 'lbl', text: t('dolphin.token') }), token),
      h('p', { class: 'hint', text: t('dolphin.tokenHint') }),
      h('p', { class: 'hint', text: t('dolphin.limits') }),
      h('h3', { text: t('dolphin.fileTitle') }),
      h('p', { class: 'hint', text: t('dolphin.fileHint') }),
      h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('dolphin.file') }), file),
      h('div', { class: 'modal-actions' }, openNative, cancel, load),
    );
  }, 'wide');
}
