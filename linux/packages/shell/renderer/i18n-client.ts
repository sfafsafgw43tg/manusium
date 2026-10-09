/**
 * packages/shell/renderer/i18n-client.ts
 * Renderer-side translation helper (dictionaries come from the main process).
 */
export type Dict = Record<string, string>;
export type Dicts = Record<'en' | 'pl', Dict>;

let dicts: Dicts = { en: {}, pl: {} };
let lang: 'en' | 'pl' = 'en';

export function setDicts(d: Dicts): void { dicts = d; }
export function setLang(l: 'en' | 'pl'): void { lang = l; document.documentElement.lang = l; }
export function getLang(): 'en' | 'pl' { return lang; }

export function t(key: string, params?: Record<string, string | number>): string {
  const s = dicts[lang]?.[key] ?? dicts.en?.[key] ?? key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** Apply translations to [data-i18n] (textContent) and [data-i18n-ph] (placeholder) / [data-i18n-title]. */
export function applyI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n!); });
  root.querySelectorAll<HTMLInputElement>('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh!); });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle!); });
}

/** Safe element builder (never uses innerHTML with data). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined> = {},
  ...children: Array<Node | string | null | undefined | false>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}
