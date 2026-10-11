/**
 * apps/octobrowser/src/renderer/launcher-dialogs.ts
 *
 * Launcher dialogs: pre-launch (passphrase), private browsing, duplicate,
 * export / import, profile encryption, Tor Browser / Windows Sandbox fallbacks.
 */
import { api } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { phraseDisplay, phraseEntry } from '@octo/shell/renderer/phrase';
import { Profile, run, toast, modal, closeModal, field, toggle, tv, inkbrowserLaunchMessage } from './launcher-ui';

interface IsoItem { labelKey: string; value: string; state: 'allowed' | 'blocked' | 'limited' | 'info' }

/** What a profile can access (camera, clipboard, downloads, network...) - read-only. */
export async function isolationDialog(p: Profile): Promise<void> {
  const items = (await run(api.invoke<IsoItem[]>('mgr:isolation', p.id))) ?? [];
  modal(t('ui.whatCanAccess'), (box) => {
    const list = h('div', { class: 'iso' });
    for (const it of items) list.append(h('div', { class: `iso-row ${it.state}` }, h('span', { class: 'k', text: t(it.labelKey) }), h('span', { class: 'v', text: tv(it.value) })));
    const ok = h('button', { class: 'btn', text: t('common.close') });
    ok.onclick = closeModal;
    box.append(h('p', { class: 'hint', text: t('launch.summary') }), list, h('div', { class: 'modal-actions' }, ok));
  }, 'wide');
}

/** Private browsing: one throw-away temporary profile, started right away. */
export function privateBrowsingDialog(): void {
  modal(t('profile.privateTitle'), (box) => {
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    const start = h('button', { class: 'btn primary' }, icon('eyeOff', 15), ` ${t('profile.privateStart')}`);
    start.onclick = async () => {
      const r = await run(api.invoke<{ status: string }>('mgr:private-browse'));
      if (!r) return;
      closeModal();
      toast(t('profile.privateToast'), 'ok');
    };
    box.append(
      h('p', { text: t('profile.privateBody') }),
      h('p', { class: 'note small', text: t('profile.privateNote') }),
      h('div', { class: 'modal-actions' }, cancel, start),
    );
  });
}

export function duplicateDialog(p: Profile): void {
  modal(t('profile.duplicate'), (box) => {
    const name = h('input', { type: 'text', maxlength: '64', value: `${p.name} (2)` });
    const data = toggle(false, 'profile.duplicateWithData');
    const ok = h('button', { class: 'btn primary', text: t('profile.duplicate') });
    ok.onclick = async () => {
      const withData = (data.querySelector('input') as HTMLInputElement).checked;
      if ((await run(api.invoke('mgr:duplicate', p.id, name.value.trim(), withData), 'toast.profileCreated')) !== undefined) closeModal();
    };
    box.append(field('profile.name', name), data, h('p', { class: 'hint', text: t('profile.duplicateHint') }), h('div', { class: 'modal-actions' }, ok));
  });
}

export async function exportDialog(p: Profile): Promise<void> {
  // The file gets its own fresh phrase; the user has to confirm they wrote it down.
  const phrase = await run(api.invoke<string>('mgr:new-passphrase'));
  if (!phrase) return;
  modal(t('profile.export'), (box) => {
    const data = toggle(true, 'export.withData');
    const err = h('div', { class: 'err' });
    const ok = h('button', { class: 'btn primary', text: t('profile.export') }) as HTMLButtonElement;
    ok.disabled = true;
    const shown = phraseDisplay(phrase, (confirmed) => { ok.disabled = !confirmed; });
    ok.onclick = async () => {
      const withData = (data.querySelector('input') as HTMLInputElement).checked;
      ok.disabled = true;
      const r = await run(api.invoke<boolean>('mgr:export', p.id, phrase, withData));
      ok.disabled = false;
      if (r) { toast(t('toast.exported'), 'ok'); closeModal(); }
    };
    box.append(h('p', { class: 'info', text: t('export.info') }), shown.el, data, err, h('div', { class: 'modal-actions' }, ok));
  });
}

export function importDialog(): void {
  modal(t('profile.import'), (box) => {
    const ok = h('button', { class: 'btn primary', text: t('import.choose') }) as HTMLButtonElement;
    const entry = phraseEntry((complete) => { ok.disabled = !complete; });
    ok.disabled = true;
    ok.onclick = async () => {
      const r = await run(api.invoke<Profile | null>('mgr:import', entry.value()));
      if (r) { toast(t('toast.imported', { name: r.name }), 'ok'); closeModal(); }
    };
    box.append(h('p', { class: 'hint', text: t('import.info') }), entry.el, h('div', { class: 'modal-actions' }, ok));
    entry.focus();
  });
}

export function encryptionDialog(p: Profile): void {
  modal(t(p.encrypted ? 'profile.disableEncryption' : 'profile.enableEncryption'), (box) => {
    const err = h('div', { class: 'err' });
    const ok = h('button', { class: 'btn primary', text: t('common.save') }) as HTMLButtonElement;
    box.append(
      h('p', { class: 'info', text: t(p.encrypted ? 'enc.disableInfo' : 'enc.enableInfo') }),
      h('p', { class: 'note', text: t('security.malwareNotice') }),
    );

    if (p.encrypted) {
      // Turning encryption OFF: the existing 12 words are needed once.
      const entry = phraseEntry((complete) => { ok.disabled = !complete; });
      ok.disabled = true;
      box.append(entry.el);
      ok.onclick = async () => {
        ok.disabled = true;
        ok.textContent = t('enc.working');
        const r = await run(api.invoke('mgr:set-encryption', p.id, false, entry.value()), 'toast.saved');
        ok.textContent = t('common.save');
        if (r !== undefined) closeModal();
        else { ok.disabled = false; entry.setError(t('unlock.wrong')); }
      };
    } else {
      // Turning encryption ON: the phrase is generated by the main process and
      // shown here once, before the profile is sealed.
      box.append(h('p', { class: 'hint', text: t('enc.noRecovery') }));
      ok.onclick = async () => {
        ok.disabled = true;
        ok.textContent = t('enc.working');
        const r = await run(api.invoke<{ passphrase: string }>('mgr:set-encryption', p.id, true));
        ok.textContent = t('common.save');
        if (!r) { ok.disabled = false; return; }
        closeModal();
        showPassphrase(r.passphrase);
      };
    }
    box.append(err, h('div', { class: 'modal-actions' }, ok));
  });
}

/** The one and only time a profile passphrase is displayed. */
function showPassphrase(passphrase: string): void {
  modal(t('phrase.title'), (box) => {
    const done = h('button', { class: 'btn primary', text: t('common.close') }) as HTMLButtonElement;
    done.disabled = true;
    const shown = phraseDisplay(passphrase, (confirmed) => { done.disabled = !confirmed; });
    done.onclick = () => { closeModal(); toast(t('toast.saved'), 'ok'); };
    box.append(shown.el, h('div', { class: 'modal-actions' }, done));
  });
}

export function resealDialog(p: Profile): void {
  modal(t('profile.reseal'), (box) => {
    const ok = h('button', { class: 'btn primary', text: t('profile.reseal') }) as HTMLButtonElement;
    const entry = phraseEntry((complete) => { ok.disabled = !complete; });
    ok.disabled = true;
    ok.onclick = async () => {
      const r = await run(api.invoke('mgr:reseal', p.id, entry.value()), 'toast.saved');
      if (r !== undefined) closeModal();
      else entry.setError(t('unlock.wrong'));
    };
    box.append(h('p', { class: 'hint', text: t('profile.needsResealing') }), entry.el, h('div', { class: 'modal-actions' }, ok));
    entry.focus();
  });
}

/** Pre-launch summary: what the profile can access (spec §6), then launch. */
export async function preLaunch(p: Profile): Promise<void> {
  if (p.running) { await run(api.invoke('mgr:launch', p.id, {})); return; }
  const items = (await run(api.invoke<IsoItem[]>('mgr:isolation', p.id))) ?? [];
  modal(t('launch.title', { name: p.name }), (box) => {
    const list = h('div', { class: 'iso' });
    for (const it of items) {
      list.append(h('div', { class: `iso-row ${it.state}` }, h('span', { class: 'k', text: t(it.labelKey) }), h('span', { class: 'v', text: tv(it.value) })));
    }
    box.append(h('p', { class: 'hint', text: t('launch.summary') }), list);
    let entry: ReturnType<typeof phraseEntry> | null = null;
    if (p.encrypted && p.sealed) {
      entry = phraseEntry();
      box.append(h('p', { class: 'hint', text: t('launch.passphraseNeeded') }), entry.el);
    }
    const err = h('div', { class: 'err' });
    const ok = h('button', { class: 'btn primary' }, icon('play', 15), ` ${t('profile.launch')}`);
    const go = async (forceRestricted = false) => {
      ok.disabled = true;
      const r = await run(api.invoke<{ status: string; detail?: string }>('mgr:launch', p.id, { passphrase: entry?.value(), forceRestricted }));
      ok.disabled = false;
      if (!r) return;
      switch (r.status) {
        case 'started': case 'focused': case 'wsb-launched': case 'tor-launched': closeModal(); toast(t(`launch.status.${r.status}`), 'ok'); break;
        case 'need-passphrase': err.textContent = t('launch.passphraseNeeded'); entry?.focus(); break;
        case 'wrong-passphrase': err.textContent = t('unlock.wrong'); entry?.setError(t('unlock.wrong')); entry?.focus(); break;
        case 'inkbrowser-launched': closeModal(); toast(t('launch.status.inkbrowser-launched'), 'ok'); break;
        case 'firefox-launched': closeModal(); toast(t('launch.status.firefox-launched'), 'ok'); break;
        case 'firefox-engine-unavailable': err.textContent = t('launch.status.firefox-engine-unavailable'); break;
        case 'inkbrowser-missing': case 'inkbrowser-conflict': err.textContent = inkbrowserLaunchMessage(r.status, r.detail); break;
        case 'tor-missing': torMissing(); break;
        case 'wsb-unavailable': wsbUnavailable(p); break;
        default: err.textContent = r.status;
      }
    };
    ok.onclick = () => void go();
    box.append(err, h('div', { class: 'modal-actions' }, ok));
  }, 'wide');
}

export function torMissing(): void {
  modal(t('tor.missingTitle'), (box) => {
    const dl = h('button', { class: 'btn primary', text: t('tor.download') });
    dl.onclick = () => void api.invoke('mgr:open-external', 'tor');
    const pick = h('button', { class: 'btn', text: t('tor.pick') });
    pick.onclick = async () => { const r = await run(api.invoke<string | null>('mgr:pick-tor')); if (r) { toast(t('toast.saved'), 'ok'); closeModal(); } };
    box.append(h('p', { text: t('tor.missing') }), h('p', { class: 'hint', text: t('tor.why') }), h('div', { class: 'modal-actions' }, pick, dl));
  });
}

export function wsbUnavailable(p: Profile): void {
  modal(t('wsb.unavailableTitle'), (box) => {
    const docs = h('button', { class: 'btn', text: t('wsb.howToEnable') });
    docs.onclick = () => void api.invoke('mgr:open-external', 'wsb-docs');
    const fallback = h('button', { class: 'btn primary', text: t('wsb.useRestricted') });
    fallback.onclick = async () => {
      const r = await run(api.invoke<{ status: string }>('mgr:launch', p.id, { forceRestricted: true }));
      if (r?.status === 'need-passphrase') { closeModal(); void preLaunch({ ...p, sandbox: { ...p.sandbox, mode: 'restricted' } }); return; }
      if (r) closeModal();
    };
    box.append(h('p', { text: t('wsb.unavailable') }), h('p', { class: 'hint', text: t('wsb.fallbackInfo') }), h('div', { class: 'modal-actions' }, docs, fallback));
  });
}
