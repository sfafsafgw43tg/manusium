/**
 * packages/shell/renderer/keypanel.ts
 *
 * Shared "Key protection" panel used by Octo.su (launcher) and
 * OctoDetect.su (settings). It shows
 *   - how the local key is protected right now (Windows DPAPI or master password),
 *   - the form to set / change / remove the master password,
 *   - that small secrets are kept in the encrypted local vault,
 *   - the honest limitation notice.
 *
 * The panel never shows, logs or returns any key material: it only sends the
 * typed passwords to the main process, which drops them after wrapping the key.
 */
import { h, t } from './i18n-client';
import { icon } from './icons';

export interface KeyPanelState {
  /** Current keyring mode ('os' = DPAPI, 'password' = master password). */
  keyringMode: 'os' | 'password' | null;
  /** true when the app asks for the master password on start. */
  requiresPassword: boolean;
  /** Small secrets are stored only in the encrypted local vault. */
  secretBackend: 'local';
}

export interface KeyPanelActions {
  /** Set (or replace) the master password. */
  setMasterPassword(current: string, next: string, repeat: string): Promise<unknown>;
  /** Remove the master password (key goes back to DPAPI). */
  removeMasterPassword(current: string): Promise<unknown>;
  /** Ask for confirmation before a destructive action (optional). */
  confirm?(text: string, fn: () => Promise<unknown>): void;
}

/** Human-readable name of the current key protection. */
export function keyProtectionLabel(state: KeyPanelState): string {
  if (state.requiresPassword) return t('keyring.mode.password');
  return t('keyring.mode.os');
}

/**
 * The panel. `notify` is called after every successful action so the caller can
 * refresh its own copy of the state (the main process is the source of truth).
 */
export function keyProtectionPanel(state: KeyPanelState, actions: KeyPanelActions, notify: () => void): HTMLElement {
  const panel = h('section', { class: 'panel' },
    h('h2', {}, icon('key', 16), ` ${t('sec.keyring')}`),
    h('div', { class: 'kv' },
      h('span', { text: t('keyring.current') }),
      h('b', { text: keyProtectionLabel(state) })),
    h('p', { class: 'hint', text: t('keyring.localDesc') }));

  // ---------------------------------------------------------- master password
  const current = h('input', { type: 'password', autocomplete: 'current-password', spellcheck: 'false' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false' });
  const repeat = h('input', { type: 'password', autocomplete: 'new-password', spellcheck: 'false' });
  const err = h('div', { class: 'err' });

  const setBtn = h('button', { class: 'btn', text: t('keyring.change') });
  setBtn.onclick = async () => {
    err.textContent = '';
    try {
      await actions.setMasterPassword(state.requiresPassword ? current.value : '', next.value, repeat.value);
      current.value = ''; next.value = ''; repeat.value = '';
      notify();
    } catch (e) {
      err.textContent = String((e as Error).message ?? e);
    }
  };

  const removeBtn = h('button', { class: 'btn', text: t('keyring.remove') });
  removeBtn.onclick = () => {
    err.textContent = '';
    const doIt = async () => {
      try {
        await actions.removeMasterPassword(current.value);
        current.value = '';
        notify();
      } catch (e) {
        err.textContent = String((e as Error).message ?? e);
      }
    };
    if (actions.confirm) actions.confirm(t('keyring.removeConfirm'), () => doIt());
    else void doIt();
  };

  const pwRow = (labelKey: string, input: HTMLElement) =>
    h('label', { class: 'field' }, h('span', { class: 'lbl', text: t(labelKey) }), input);

  const masterRows: Array<Node | null> = [
    h('h3', { text: t('sec.masterPassword') }),
    // The current password is only needed when one is already set.
    state.requiresPassword ? pwRow('keyring.currentPassword', current) : null,
    pwRow('keyring.newPassword', next),
    pwRow('keyring.repeatPassword', repeat),
    h('div', { class: 'row' }, setBtn, state.requiresPassword ? removeBtn : null),
    err,
    h('p', { class: 'hint', text: t('firstRun.security.masterHint') }),
  ];
  panel.append(...masterRows.filter((x): x is Node => x !== null));

  // ------------------------------------------------------ encrypted local vault
  panel.append(
    h('h3', { text: t('sec.secretStore') }),
    h('div', { class: 'kv' }, h('span', { text: t('sec.secretStore') }), h('b', { text: t('sec.secretStore.local') })),
    h('p', { class: 'hint', text: t('sec.secretStoreHint') }),
    h('p', { class: 'hint', text: t('sec.encryptionDesc') }),
    h('p', { class: 'note', text: t('security.malwareNotice') }),
  );

  return panel;
}
