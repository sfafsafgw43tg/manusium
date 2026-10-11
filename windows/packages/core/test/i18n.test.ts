/**
 * packages/core/test/i18n.test.ts
 * English and Polish dictionaries must be complete, in parity and free of forbidden claims.
 */
import { describe, expect, it } from 'vitest';
import { DICTS, guessLang, t } from '../src';
// @ts-expect-error - plain ESM tool without type declarations
import { collectKeys } from '../../../tools/i18n-keys.mjs';

describe('i18n dictionaries', () => {
  it('en and pl have exactly the same keys', () => {
    const en = Object.keys(DICTS.en).sort();
    const pl = Object.keys(DICTS.pl).sort();
    expect(pl.filter((k) => !DICTS.en[k])).toEqual([]);
    expect(en.filter((k) => !DICTS.pl[k])).toEqual([]);
  });

  it('every key referenced in the sources exists in both languages', () => {
    const keys = collectKeys() as string[];
    expect(keys.length).toBeGreaterThan(500);
    expect(keys.filter((k) => !(k in DICTS.en))).toEqual([]);
    expect(keys.filter((k) => !(k in DICTS.pl))).toEqual([]);
  });

  it('placeholders match between languages', () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    const bad = Object.keys(DICTS.en).filter((k) => ph(DICTS.en[k]) !== ph(DICTS.pl[k] ?? ''));
    expect(bad).toEqual([]);
  });

  it('never promises absolute security or undetectability', () => {
    const forbidden = /100\s*%|undetectable|niewykrywaln|unblockable|nie do zablokowania|antyfraud|anti-?fraud bypass|fully anonymous|całkowicie anonim/i;
    for (const lang of ['en', 'pl'] as const) {
      const hits = Object.entries(DICTS[lang]).filter(([, v]) => forbidden.test(v)).map(([k]) => k);
      expect(hits, lang).toEqual([]);
    }
  });

  it('translates with parameters and falls back sensibly', () => {
    expect(t('pl', 'logs.deleted', { n: 3 })).toBe('Usunięto plików logów: 3');
    expect(t('en', 'upd.available', { v: '1.2.3' })).toBe('Version 1.2.3 is available');
    expect(t('pl', 'no.such.key')).toBe('no.such.key');
    expect(guessLang('pl-PL')).toBe('pl');
    expect(guessLang('de-DE')).toBe('en');
  });
});
