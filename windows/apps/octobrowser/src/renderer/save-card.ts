/**
 * apps/octobrowser/src/renderer/save-card.ts
 *
 * The "Save login?" card, drawn in its own small always-on-top window.
 *
 * Being a separate window is the whole point: the browser page keeps every
 * click, the card never sits between the pointer and a website, and losing
 * focus just dismisses it - exactly how Chrome's bubble behaves. The main
 * process creates the window; this file only draws the card and reports the
 * answer on the per-card channel it was given.
 */
import { api, clear } from '@octo/shell/renderer/bridge';
import { h, setDicts, setLang, t, Dicts } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';

/** Live inputs of the card on screen; Enter uses exactly these values. */
let current: { request: SaveCardInit; user: HTMLInputElement; pass: HTMLInputElement } | null = null;

interface SaveCardInit {
  origin: string;
  username: string;
  password: string;
  update: boolean;
  /** Trusted channel this card must answer on (per window, main validates it). */
  channel: string;
}

function hostOf(origin: string): string {
  try { return new URL(origin).hostname.replace(/^www\./i, ''); }
  catch { return origin.replace(/^https?:\/\//i, '').split('/')[0] || origin; }
}

function render(request: SaveCardInit): void {
  const root = document.getElementById('card');
  if (!root) return;
  const host = hostOf(request.origin);
  const answer = (action: 'save' | 'never' | 'later', username = request.username, password = request.password) =>
    void api.invoke(request.channel, { action, username, password });

  const close = h('button', { class: 'save-card-close', type: 'button', title: t('pw.closePrompt'), 'aria-label': t('pw.closePrompt') });
  close.append(icon('close', 15));
  close.onclick = () => answer('later');

  const header = h('div', { class: 'save-card-head' },
    h('div', { class: 'save-card-title-wrap' },
      h('span', { class: 'save-card-mark', 'aria-hidden': 'true' }, icon('key', 16)),
      h('div', {},
        h('strong', { text: t(request.update ? 'pw.updateTitle' : 'pw.saveTitle') }),
        h('span', { class: 'save-card-origin', text: host }))),
    close);

  const userInput = h('input', { class: 'save-card-input', type: 'text', value: request.username || '', placeholder: t('pw.usernamePh'), 'aria-label': t('pw.username') }) as HTMLInputElement;
  const passInput = h('input', { class: 'save-card-input', type: 'password', value: request.password || '', placeholder: t('pw.passwordPh'), 'aria-label': t('pw.password') }) as HTMLInputElement;
  const passToggle = h('button', { class: 'save-card-eye', type: 'button', title: t('pw.show'), 'aria-label': t('pw.show') });
  passToggle.append(icon('eye', 14));
  passToggle.onclick = () => {
    const shown = passInput.type === 'text';
    passInput.type = shown ? 'password' : 'text';
    clear(passToggle);
    passToggle.append(icon(shown ? 'eye' : 'eyeOff', 14));
    passToggle.title = t(shown ? 'pw.show' : 'pw.hide');
  };

  current = { request, user: userInput, pass: passInput };

  const letter = (host.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toLocaleUpperCase();
  const site = h('div', { class: 'save-card-site' },
    h('span', { class: 'save-card-letter', text: letter }),
    h('div', { class: 'save-card-fields' },
      h('div', { class: 'save-card-field' }, h('span', { text: t('pw.username') }), userInput),
      h('div', { class: 'save-card-field' }, h('span', { text: t('pw.password') }),
        h('div', { class: 'save-card-pwd' }, passInput, passToggle))));

  const notNow = h('button', { class: 'save-card-action secondary', type: 'button', text: t('pw.notNow') });
  notNow.onclick = () => answer('later');
  const save = h('button', { class: 'save-card-action primary', type: 'button', text: t(request.update ? 'pw.update' : 'pw.save') });
  save.onclick = () => answer('save', userInput.value.trim(), passInput.value);
  const never = h('button', { class: 'save-card-never', type: 'button', text: t('pw.never') });
  never.onclick = () => answer('never');

  clear(root);
  root.append(
    header,
    site,
    h('p', { class: 'save-card-vault' }, icon('lock', 13), h('span', { text: t('pw.encryptedHint') })),
    h('div', { class: 'save-card-actions' }, notNow, save),
    never);
}

async function boot(): Promise<void> {
  const init = await api.invoke<{ lang: 'en' | 'pl'; dicts: Dicts; theme: 'dark' | 'light' }>('ui:init');
  setDicts(init.dicts);
  setLang(init.lang);
  document.documentElement.dataset.theme = init.theme;
  // Enter saves, Escape dismisses - both are what the keyboard expects. The
  // handlers read the live inputs, so an edited password is never lost.
  document.addEventListener('keydown', (e) => {
    if (!current) return;
    const { request, user, pass } = current;
    if (e.key === 'Escape') void api.invoke(request.channel, { action: 'later', username: request.username, password: request.password });
    if (e.key === 'Enter') void api.invoke(request.channel, { action: 'save', username: user.value.trim(), password: pass.value });
  });
  api.on<SaveCardInit>('ui:save-card', render);
}

void boot();
