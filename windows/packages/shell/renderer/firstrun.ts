/**
 * packages/shell/renderer/firstrun.ts - logic of the one-screen first-run setup.
 *
 * One screen: language (pre-selected from the system / sibling app), data
 * folder, automatic updates, public-IP lookup consent. The local key is
 * always protected by the Windows account (DPAPI) - no questions asked. Only
 * when DPAPI is unavailable does a (required) password field appear, because
 * the key cannot be stored otherwise.
 */
import { applyI18n, setDicts, setLang, t, Dicts } from './i18n-client';
import { appParam, invoke } from './setup-api';

interface InitData {
  app: 'octobrowser' | 'octodetect';
  productName: string;
  version: string;
  langGuess: 'en' | 'pl';
  suggestedBase: string;
  siblingConfigured: boolean;
  desktopApps: { octobrowser: boolean; octodetect: boolean };
  dataSubdir: string;
  dpapiAvailable: boolean;
  dicts: Dicts;
}
interface Validation { ok: boolean; errorKey?: string; dataDir?: string; existing: { exists: boolean } | null }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const val = (id: string) => ($(id) as HTMLInputElement).value;

let init: InitData;
let lang: 'en' | 'pl' = 'en';
let validation: Validation | null = null;
let busy = false;
let needsPassword = false;

function status(text: string, bad = false): void {
  const el = $('globalErr');
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

function render(): void {
  document.documentElement.lang = lang;
  $('title').textContent = t('firstRun.simple.title', { product: init.productName.replace(/\.su$/i, '') });
  document.querySelectorAll<HTMLButtonElement>('#langs button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.lang === lang)));
  $('pwBox').hidden = !needsPassword;
  $('shortcutsBox').hidden = !init.desktopApps.octobrowser && !init.desktopApps.octodetect;
  $('shortcutBrowserRow').hidden = !init.desktopApps.octobrowser;
  $('shortcutDetectRow').hidden = !init.desktopApps.octodetect;
  ($('next') as HTMLButtonElement).disabled = busy || !validation?.ok;
  ($('cancel') as HTMLButtonElement).disabled = busy;
}

function setLanguage(l: 'en' | 'pl'): void {
  lang = l;
  setLang(l);
  applyI18n();
  if (validation && !validation.ok) $('folderErr').textContent = t(validation.errorKey ?? 'firstRun.err.notWritable');
  render();
}

async function validateFolder(): Promise<void> {
  validation = await invoke<Validation>('setup:validate', val('baseDir').trim()).catch(() => null);
  $('folderErr').textContent = validation && !validation.ok ? t(validation.errorKey ?? 'firstRun.err.notWritable') : '';
  $('dataDir').textContent = validation?.dataDir ?? '—';
  $('existingNote').hidden = !validation?.existing?.exists;
  render();
}

function passwordProblem(): string | null {
  if (!needsPassword) return null;
  if (val('masterPw').length < 10) return t('firstRun.err.weakPassword');
  if (val('masterPw') !== val('masterPw2')) return t('firstRun.err.passwordMismatch');
  return null;
}

async function finish(): Promise<void> {
  const problem = passwordProblem();
  $('masterErr').textContent = problem ?? '';
  if (problem) { ($('masterPw') as HTMLInputElement).focus(); return; }
  busy = true;
  render();
  status(t('firstRun.saving'));
  try {
    await invoke('setup:finish', {
      language: lang,
      baseDir: val('baseDir').trim(),
      publicIpLookup: ($('ipConsent') as HTMLInputElement).checked,
      autoUpdate: ($('autoUpdate') as HTMLInputElement).checked,
      keyProtection: needsPassword ? 'password' : 'os',
      masterPassword: needsPassword ? val('masterPw') : undefined,
      desktopShortcuts: {
        octobrowser: ($('shortcutBrowser') as HTMLInputElement).checked,
        octodetect: ($('shortcutDetect') as HTMLInputElement).checked,
      },
    });
    status(t('firstRun.restarting'));
  } catch (err) {
    const msg = (err as Error).message;
    status(msg.startsWith('firstRun.') ? t(msg) : msg, true);
    busy = false;
    render();
  }
}

async function main(): Promise<void> {
  document.body.dataset.app = appParam();
  init = await invoke<InitData>('setup:init');
  setDicts(init.dicts);
  needsPassword = !init.dpapiAvailable;
  $('version').textContent = `v${init.version}`;
  ($('baseDir') as HTMLInputElement).value = init.suggestedBase;
  setLanguage(init.langGuess);

  document.querySelectorAll<HTMLButtonElement>('#langs button').forEach((b) => {
    b.addEventListener('click', () => setLanguage(b.dataset.lang === 'pl' ? 'pl' : 'en'));
  });
  $('browse').addEventListener('click', async () => {
    const dir = await invoke<string | null>('setup:browse', val('baseDir'));
    if (dir) {
      ($('baseDir') as HTMLInputElement).value = dir;
      await validateFolder();
    }
  });
  let timer = 0;
  $('baseDir').addEventListener('input', () => {
    ($('next') as HTMLButtonElement).disabled = true;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void validateFolder(), 300);
  });
  $('cancel').addEventListener('click', () => void invoke('setup:quit'));
  $('next').addEventListener('click', () => { if (!busy && validation?.ok) void finish(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLInputElement && e.target.type === 'checkbox') && !busy && validation?.ok) void finish();
  });
  await validateFolder();
  ($('next') as HTMLButtonElement).focus();
}

main().catch((err) => { document.body.textContent = String(err); });
