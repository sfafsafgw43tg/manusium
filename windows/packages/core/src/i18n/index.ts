/**
 * packages/core/src/i18n/index.ts
 *
 * Tiny i18n layer (English / Polski). The language is chosen ONCE in the
 * first-run wizard, stored in bootstrap.json and can later be changed in
 * Settings. Dictionaries are plain objects so they can be sent to renderers.
 */
import { en } from './en';
import { pl } from './pl';

export type Lang = 'en' | 'pl';
export const LANGS: readonly Lang[] = ['en', 'pl'];
export type Dict = Readonly<Record<string, string>>;

export const DICTS: Readonly<Record<Lang, Dict>> = { en, pl };

export function isLang(x: unknown): x is Lang {
  return x === 'en' || x === 'pl';
}

/** Translate `key`, replacing {placeholders}. Falls back to English, then the key. */
export function t(lang: Lang, key: string, params?: Record<string, string | number>): string {
  const s = DICTS[lang][key] ?? DICTS.en[key] ?? key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** Pre-select a language in the wizard from the OS locale (user still confirms). */
export function guessLang(locale: string | undefined): Lang {
  return (locale ?? '').toLowerCase().startsWith('pl') ? 'pl' : 'en';
}
