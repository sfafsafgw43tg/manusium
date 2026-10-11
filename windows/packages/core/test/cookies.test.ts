/** packages/core/test/cookies.test.ts - cookie import parser (JSON exports + Netscape cookies.txt). */
import { describe, expect, it } from 'vitest';
import { parseCookies } from '../src/cookies';

const NOW = Date.UTC(2026, 8, 26) ; // ms
const future = Math.floor(NOW / 1000) + 86400 * 30;

describe('parseCookies', () => {
  it('empty text is fine (nothing to import)', () => {
    expect(parseCookies('  ', NOW)).toMatchObject({ ok: true, cookies: [], format: '' });
  });

  it('EditThisCookie / Dolphin JSON', () => {
    const r = parseCookies(JSON.stringify([
      { domain: '.facebook.com', hostOnly: false, httpOnly: true, name: 'xs', path: '/', sameSite: 'no_restriction', secure: true, session: false, expirationDate: future, value: '12%3Aab' },
      { domain: 'www.google.com', hostOnly: true, name: 'NID', path: '/', sameSite: 'lax', secure: false, session: true, value: 'v' },
    ]), NOW);
    expect(r.ok).toBe(true);
    expect(r.format).toBe('json');
    expect(r.cookies[0]).toEqual({ url: 'https://facebook.com/', name: 'xs', value: '12%3Aab', domain: '.facebook.com', path: '/', secure: true, httpOnly: true, expirationDate: future, sameSite: 'no_restriction' });
    expect(r.cookies[1]).toEqual({ url: 'http://www.google.com/', name: 'NID', value: 'v', path: '/', secure: false, httpOnly: false, sameSite: 'lax' });
  });

  it('Puppeteer / Playwright shapes ({cookies:[...]}, expires in s or ms, sameSite "None")', () => {
    const r = parseCookies(JSON.stringify({ cookies: [
      { name: 'a', value: '1', domain: '.x.com', path: '/', expires: future, sameSite: 'None', secure: false },
      { name: 'b', value: '2', domain: 'x.com', path: '/p', expires: future * 1000, sameSite: 'Strict' },
      { name: 'c', value: '3', domain: 'x.com', expires: -1 },
    ] }), NOW);
    expect(r.ok).toBe(true);
    expect(r.cookies.map((c) => [c.name, c.sameSite, c.secure, c.expirationDate])).toEqual([
      ['a', 'no_restriction', true, future], ['b', 'strict', false, future], ['c', 'unspecified', false, undefined],
    ]);
    expect(r.cookies[1].path).toBe('/p');
  });

  it('Netscape cookies.txt incl. #HttpOnly_ lines', () => {
    const txt = [
      '# Netscape HTTP Cookie File',
      `.example.com\tTRUE\t/\tTRUE\t${future}\tsid\tabc\tdef`,
      `#HttpOnly_shop.example.com\tFALSE\t/cart\tFALSE\t0\tcart\t42`,
      'broken line',
    ].join('\r\n');
    const r = parseCookies(txt, NOW);
    expect(r.ok).toBe(true);
    expect(r.format).toBe('netscape');
    expect(r.skipped).toBe(1);
    expect(r.cookies[0]).toMatchObject({ name: 'sid', value: 'abc\tdef', domain: '.example.com', secure: true, expirationDate: future });
    expect(r.cookies[1]).toMatchObject({ name: 'cart', httpOnly: true, path: '/cart', url: 'http://shop.example.com/cart' });
    expect(r.cookies[1].domain).toBeUndefined();
  });

  it('skips expired / invalid entries and __Secure-/__Host- get the required flags', () => {
    const r = parseCookies(JSON.stringify([
      { name: 'old', value: '1', domain: '.x.com', expirationDate: 1000 },
      { name: 'bad name', value: '1', domain: '.x.com' },
      { name: 'x', value: '1', domain: 'no spaces.com' },
      { name: '__Host-t', value: '1', domain: '.x.com', path: '/a' },
      { name: '__Secure-t', value: '1', domain: '.x.com' },
    ]), NOW);
    expect(r.skipped).toBe(3);
    expect(r.cookies[0]).toMatchObject({ name: '__Host-t', secure: true, path: '/', url: 'https://x.com/a' });
    expect(r.cookies[0].domain).toBeUndefined();
    expect(r.cookies[1]).toMatchObject({ name: '__Secure-t', secure: true, domain: '.x.com' });
  });

  it('errors are i18n keys', () => {
    expect(parseCookies('[{', NOW).error).toBe('cookies.err.json');
    expect(parseCookies('{"a":1}', NOW).error).toBe('cookies.err.format');
    expect(parseCookies('[{"name":"a","value":"b","domain":"x.com","expires":5}]', NOW).error).toBe('cookies.err.none');
  });
});
