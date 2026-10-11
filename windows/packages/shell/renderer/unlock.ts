/**
 * packages/shell/renderer/unlock.ts - logic of the master-password window.
 *
 * The password is sent once to the main process and dropped from memory as soon
 * as possible; it is never stored, never logged and never echoed back.
 */
import { applyI18n, setDicts, setLang, t } from './i18n-client';
import { invoke } from './setup-api';

interface InitData {
  app: 'octobrowser' | 'octodetect';
  productName: string;
  version: string;
  lang: 'en' | 'pl';
  dicts: Record<'en' | 'pl', Record<string, string>>;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let busy = false;

function setBusy(v: boolean): void {
  busy = v;
  ($('submit') as HTMLButtonElement).disabled = v;
  ($('password') as HTMLInputElement).disabled = v;
  $('forgot').hidden = v;
}

function error(key: string): void {
  $('err').textContent = t(key);
}

async function submit(): Promise<void> {
  if (busy) return;
  const pw = ($('password') as HTMLInputElement).value;
  if (!pw) { error('unlock.empty'); return; }
  setBusy(true);
  error('');
  try {
    const r = await invoke<{ ok: boolean; errorKey?: string }>('unlock:submit', pw);
    if (!r.ok) {
      error(r.errorKey ?? 'unlock.wrong');
      ($('password') as HTMLInputElement).select();
    }
    // On success the main process closes this window.
  } catch (err) {
    error((err as Error).message);
  } finally {
    setBusy(false);
    ($('password') as HTMLInputElement).value = '';
  }
}

async function main(): Promise<void> {
  const init = await invoke<InitData>('unlock:init');
  setDicts(init.dicts);
  setLang(init.lang);
  applyI18n();
  document.title = `${t('unlock.title')} — ${init.productName}`;

  $('form').addEventListener('submit', (e) => { e.preventDefault(); void submit(); });
  $('cancel').addEventListener('click', () => void invoke('unlock:cancel'));
  $('forgot').addEventListener('click', async () => {
    if (busy) return;
    // The main process shows the confirmation box (with the consequences) and
    // only then creates a new key.
    setBusy(true);
    try { await invoke('unlock:forgot'); } catch (err) { error((err as Error).message); setBusy(false); }
  });
  ($('password') as HTMLInputElement).focus();
}

main().catch((err) => { document.body.textContent = String(err); });
