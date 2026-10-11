/**
 * apps/octobrowser/src/internal/internal.ts
 *
 * Script of the internal pages (octo://newtab, octo://error, octo://https-only).
 * These pages run as ordinary (untrusted) web contents; they only get the tiny
 * window.octoInternal API exposed by the tab preload on the octo: protocol.
 * All text comes from the app dictionaries; DOM is built without innerHTML.
 */

interface OctoInternal {
  status(): Promise<Status | null>;
  navigate(input: string): Promise<boolean | null>;
  allowHttp(url: string): Promise<boolean | null>;
  strings(): Promise<{ lang: 'en' | 'pl'; dict: Record<string, string> } | null>;
}
interface Status {
  profile: { theme: string };
}

declare global { interface Window { octoInternal?: OctoInternal } }

let dict: Record<string, string> = {};
const t = (k: string, p?: Record<string, string | number>) => {
  const s = dict[k] ?? k;
  return p ? s.replace(/\{(\w+)\}/g, (m, x: string) => (x in p ? String(p[x]) : m)) : s;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string, ...kids: Node[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  e.append(...kids);
  return e;
}

/** A quiet start page: searching and navigating are the only actions here. */
async function newTab(api: OctoInternal, root: HTMLElement): Promise<void> {
  document.title = t('ui.newTab');
  const s = await api.status();
  if (s) document.documentElement.dataset.theme = s.profile.theme === 'light' ? 'light' : 'dark';

  const form = el('form', 'search');
  const input = el('input');
  input.type = 'text';
  input.placeholder = t('newtab.search');
  input.autofocus = true;
  input.spellcheck = false;
  form.append(input);
  form.onsubmit = (e) => {
    e.preventDefault();
    if (input.value.trim()) void api.navigate(input.value.trim());
  };

  const logo = el('div', 'logo', undefined, el('span', 'mark'), el('span', '', 'Octo'));
  root.append(logo, form, el('p', 'hint', t('newtab.searchNote')));
}

function errorPage(api: OctoInternal, root: HTMLElement): void {
  const q = new URLSearchParams(location.search);
  const code = Number(q.get('code') ?? 0);
  const url = q.get('url') ?? '';
  const desc = q.get('desc') ?? '';
  document.title = t('errpage.title');
  let key = 'errpage.generic';
  if ([-105, -137].includes(code)) key = 'errpage.dns';
  else if ([-106, -21].includes(code)) key = 'errpage.offline';
  else if ([-102, -118, -109, -100, -101].includes(code)) key = 'errpage.connection';
  else if (code <= -200 && code > -300) key = 'errpage.cert';
  else if (code === -130 || code === -111 || code === -115) key = 'errpage.proxy';
  else if (code === -20) key = 'errpage.blocked';
  const retry = el('button', 'btn primary', t('errpage.retry'));
  retry.onclick = () => { if (url) void api.navigate(url); };
  root.append(
    el('div', 'big-icon warn', '!'),
    el('h1', '', t('errpage.title')),
    el('p', '', t(key)),
    el('p', 'mono', url),
    el('p', 'hint', `${desc} (${code})`),
    el('div', 'actions', undefined, retry),
  );
  if (key === 'errpage.cert') root.append(el('p', 'note', t('errpage.certNote')));
}

function httpsOnly(api: OctoInternal, root: HTMLElement): void {
  const url = new URLSearchParams(location.search).get('url') ?? '';
  let host = '';
  try { host = new URL(url).hostname; } catch { /* invalid */ }
  document.title = t('https.title');
  const back = el('button', 'btn primary', t('https.back'));
  back.onclick = () => history.back();
  const cont = el('button', 'btn', t('https.continue', { host }));
  cont.onclick = () => void api.allowHttp(url);
  root.append(
    el('div', 'big-icon warn', '!'),
    el('h1', '', t('https.title')),
    el('p', '', t('https.desc', { host })),
    el('p', 'mono', url),
    el('p', 'note', t('https.risk')),
    el('div', 'actions', undefined, back, cont),
    el('p', 'hint', t('https.onceNote')),
  );
}

async function main(): Promise<void> {
  const api = window.octoInternal;
  const root = document.getElementById('root')!;
  if (!api) { root.textContent = 'Internal API unavailable.'; return; }
  const s = await api.strings();
  if (s) { dict = s.dict; document.documentElement.lang = s.lang; }
  switch (document.body.dataset.page) {
    case 'newtab': await newTab(api, root); break;
    case 'error': errorPage(api, root); break;
    case 'https-only': httpsOnly(api, root); break;
    default: root.textContent = 'Unknown page';
  }
}

main().catch((err) => {
  const root = document.getElementById('root');
  if (root) root.textContent = `Error: ${String((err as Error)?.message ?? err)}`;
});

export {};
