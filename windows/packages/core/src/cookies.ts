/**
 * packages/core/src/cookies.ts
 *
 * Cookie import (renderer-safe, no Node APIs). Accepts what antidetect tools
 * and extensions export:
 *   - JSON array (EditThisCookie / Cookie-Editor / Dolphin / Puppeteer /
 *     Playwright: name, value, domain, path, secure, httpOnly, sameSite,
 *     expirationDate | expires | expiry, hostOnly), also {cookies: [...]}
 *   - Netscape cookies.txt (7 tab separated fields, "#HttpOnly_" prefix)
 * and normalises them to what Electron's `session.cookies.set` expects.
 */

export interface ImportedCookie {
  url: string;
  name: string;
  value: string;
  /** Omitted for host-only cookies (Chromium then scopes them to url's host). */
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Seconds since the epoch; omitted = session cookie. */
  expirationDate?: number;
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
}

export interface CookieParseResult {
  ok: boolean;
  cookies: ImportedCookie[];
  format: 'json' | 'netscape' | '';
  /** Entries skipped (invalid / expired). */
  skipped: number;
  /** i18n key when !ok. */
  error?: string;
}

export const MAX_COOKIES = 10_000;
const MAX_TEXT = 8 * 1024 * 1024;

const DOMAIN_RE = /^\.?[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/i;
// Cookie names are RFC 6265 tokens (Chromium is lenient; reject only control chars / separators that break the header).
const NAME_RE = /^[^\s;=,\x00-\x1f\x7f]{1,256}$/;

function sameSiteOf(v: unknown): ImportedCookie['sameSite'] {
  const s = String(v ?? '').toLowerCase().replace(/[\s-]/g, '_');
  if (s === 'lax') return 'lax';
  if (s === 'strict') return 'strict';
  if (s === 'none' || s === 'no_restriction') return 'no_restriction';
  return 'unspecified';
}

function normalise(raw: {
  name: unknown; value: unknown; domain: unknown; path?: unknown; secure?: unknown; httpOnly?: unknown;
  expires?: unknown; sameSite?: unknown; hostOnly?: unknown; session?: unknown;
}, now: number): ImportedCookie | null {
  const name = String(raw.name ?? '');
  const value = String(raw.value ?? '');
  let domain = String(raw.domain ?? '').trim().toLowerCase();
  if (!NAME_RE.test(name) || value.length > 16_384 || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) return null;
  if (!domain || domain.length > 253 || !DOMAIN_RE.test(domain)) return null;
  const host = domain.replace(/^\./, '');
  if (!host.includes('.') && host !== 'localhost') return null;
  const hostOnly = raw.hostOnly === true || (raw.hostOnly === undefined && !domain.startsWith('.'));
  if (!hostOnly && !domain.startsWith('.')) domain = `.${domain}`;
  let path = String(raw.path ?? '/') || '/';
  if (!path.startsWith('/')) path = '/';
  // "__Secure-" / "__Host-" prefixes require the Secure flag (Chromium rejects them otherwise).
  const secure = raw.secure === true || raw.secure === 'TRUE' || raw.secure === 'true' || name.startsWith('__Secure-') || name.startsWith('__Host-');
  const sameSite = sameSiteOf(raw.sameSite);
  let exp = Number(raw.expires);
  if (raw.session === true || !Number.isFinite(exp) || exp <= 0) exp = NaN;
  else if (exp > 1e11) exp = Math.floor(exp / 1000); // milliseconds (Playwright/JS dates)
  if (Number.isFinite(exp) && exp < now) return null; // expired: importing would only delete it
  return {
    url: `${secure ? 'https' : 'http'}://${host}${path}`,
    name,
    value,
    ...(hostOnly || name.startsWith('__Host-') ? {} : { domain }),
    path: name.startsWith('__Host-') ? '/' : path,
    secure: secure || sameSite === 'no_restriction',
    httpOnly: raw.httpOnly === true || raw.httpOnly === 'true',
    ...(Number.isFinite(exp) ? { expirationDate: Math.min(exp, now + 400 * 86400) } : {}),
    sameSite,
  };
}

function extractCookieArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.cookies)) return obj.cookies;
  if (Array.isArray(obj.cookie)) return obj.cookie;
  if (Array.isArray(obj.cookiesData)) return obj.cookiesData;
  if (Array.isArray(obj.cookieList)) return obj.cookieList;
  if (Array.isArray(obj.items)) return obj.items;
  if (Array.isArray(obj.result)) return obj.result;
  if (obj.data) {
    if (Array.isArray(obj.data)) return obj.data;
    if (typeof obj.data === 'object') {
      const nested = extractCookieArray(obj.data);
      if (nested) return nested;
    }
  }
  if ('name' in obj || 'key' in obj) return [obj];
  return null;
}

function fromJson(data: unknown, now: number): { list: ImportedCookie[]; skipped: number } | null {
  const arr = extractCookieArray(data);
  if (!arr) return null;
  const list: ImportedCookie[] = [];
  let skipped = 0;
  for (const c of arr) {
    if (!c || typeof c !== 'object') { skipped++; continue; }
    const o = c as Record<string, unknown>;
    const n = normalise({
      name: o.name ?? o.key,
      value: o.value ?? o.val,
      domain: o.domain ?? o.host ?? o.hostname,
      path: o.path,
      secure: o.secure,
      httpOnly: o.httpOnly ?? o.httponly ?? o.isHttpOnly ?? o.http_only,
      expires: o.expirationDate ?? o.expires ?? o.expiry ?? o.expirationTime ?? o.expires_at ?? o.expiresAt ?? o.expires_date,
      sameSite: o.sameSite ?? o.samesite ?? o.same_site,
      hostOnly: o.hostOnly ?? o.host_only ?? o.isHostOnly,
      session: o.session ?? o.isSession,
    }, now);
    if (n) list.push(n); else skipped++;
  }
  return { list, skipped };
}

function fromNetscape(text: string, now: number): { list: ImportedCookie[]; skipped: number } {
  const list: ImportedCookie[] = [];
  let skipped = 0;
  for (let line of text.split(/\r?\n/)) {
    let httpOnly = false;
    if (line.startsWith('#HttpOnly_')) { httpOnly = true; line = line.slice(10); }
    if (!line.trim() || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) { skipped++; continue; }
    const [domain, sub, path, secure, expires, name, ...rest] = f;
    const n = normalise({ name, value: rest.join('\t'), domain, path, secure: secure.toUpperCase() === 'TRUE', httpOnly, expires: Number(expires), hostOnly: sub.toUpperCase() !== 'TRUE' }, now);
    if (n) list.push(n); else skipped++;
  }
  return { list, skipped };
}

/** Parse exported cookies (JSON or Netscape). Empty text = ok with no cookies. */
export function parseCookies(text: string, nowMs = Date.now()): CookieParseResult {
  const src = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!src) return { ok: true, cookies: [], format: '', skipped: 0 };
  if (src.length > MAX_TEXT) return { ok: false, cookies: [], format: '', skipped: 0, error: 'cookies.err.tooBig' };
  const now = Math.floor(nowMs / 1000);
  let r: { list: ImportedCookie[]; skipped: number } | null = null;
  let format: CookieParseResult['format'] = '';
  if (src.startsWith('[') || src.startsWith('{')) {
    try { r = fromJson(JSON.parse(src), now); format = 'json'; } catch { return { ok: false, cookies: [], format: 'json', skipped: 0, error: 'cookies.err.json' }; }
    if (!r) return { ok: false, cookies: [], format: 'json', skipped: 0, error: 'cookies.err.format' };
  } else {
    r = fromNetscape(src, now);
    format = 'netscape';
  }
  if (r.list.length > MAX_COOKIES) return { ok: false, cookies: [], format, skipped: 0, error: 'cookies.err.tooMany' };
  if (!r.list.length) return { ok: false, cookies: [], format, skipped: r.skipped, error: 'cookies.err.none' };
  return { ok: true, cookies: r.list, format, skipped: r.skipped };
}
