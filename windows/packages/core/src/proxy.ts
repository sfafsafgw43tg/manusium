/**
 * packages/core/src/proxy.ts
 *
 * Proxy parsing with automatic format detection, plus the saved-proxy model.
 *
 * Accepted input (one proxy per line; the type is taken from the scheme when
 * present, otherwise from the type selected in the UI):
 *
 *   host:port
 *   host:port:user:pass
 *   user:pass@host:port
 *   user:pass:host:port            (port last and numeric, host looks like a host)
 *   host:port@user:pass
 *   scheme://host:port
 *   scheme://user:pass@host:port   scheme = http | https | socks4 | socks5 | socks5h | socks
 *   [2001:db8::1]:1080             (IPv6 in brackets)
 *   any of the above followed by  [change-ip-url]  or  " | https://change-ip-url"
 *
 * Credentials never go into Chromium proxy rules or profiles.json - they are
 * kept in the encrypted SecretStore (see profiles.ts).
 */

export const PROXY_TYPES = ['http', 'https', 'socks4', 'socks5'] as const;
export type ProxyType = (typeof PROXY_TYPES)[number];

export interface ParsedProxy {
  type: ProxyType;
  host: string;
  port: number;
  username: string;
  password: string;
  /** Optional URL that rotates the exit IP of a mobile/rotating proxy. */
  changeIpUrl: string;
}

export interface ProxyParseResult {
  ok: boolean;
  proxy?: ParsedProxy;
  /** i18n key of the problem when ok = false. */
  error?: string;
  /** Which input format was recognised (for the UI hint). */
  format?: string;
}

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isValidHost(h: string): boolean {
  if (!h || h.length > 253) return false;
  const v4 = IPV4_RE.exec(h);
  if (v4) return v4.slice(1).every((o) => Number(o) <= 255);
  if (/^\[?[0-9a-f:]+\]?$/i.test(h) && h.includes(':')) return true;
  return HOST_RE.test(h);
}

function looksLikeHost(h: string): boolean {
  return isValidHost(h) && (IPV4_RE.test(h) || h.includes('.') || h === 'localhost' || h.includes(':'));
}

function isPort(p: string): boolean {
  return /^\d{1,5}$/.test(p) && Number(p) > 0 && Number(p) < 65536;
}

function schemeType(s: string): ProxyType | null {
  switch (s.toLowerCase()) {
    case 'http': return 'http';
    case 'https': return 'https';
    case 'socks4': case 'socks4a': return 'socks4';
    case 'socks5': case 'socks5h': case 'socks': return 'socks5';
    default: return null;
  }
}

/** Parse one proxy line, auto-detecting the format. */
export function parseProxy(input: string, defaultType: ProxyType = 'http'): ProxyParseResult {
  let s = String(input ?? '').trim();
  if (!s) return { ok: false, error: 'proxy.err.empty' };
  // Optional change-IP URL: "... [https://...]" or "... | https://..." or "... https://..." at the end.
  let changeIpUrl = '';
  const cip = /^(.*?)(?:\s*\[(https?:\/\/[^\]\s]+)\]|\s*\|\s*(https?:\/\/\S+)|\s+(https?:\/\/\S+))\s*$/i.exec(s);
  if (cip) {
    s = cip[1].trim();
    changeIpUrl = cip[2] ?? cip[3] ?? cip[4] ?? '';
  }
  let type: ProxyType = defaultType;
  let format = '';
  const sch = /^([a-z0-9]+):\/\/(.*)$/i.exec(s);
  if (sch) {
    const t = schemeType(sch[1]);
    if (!t) return { ok: false, error: 'proxy.err.scheme' };
    type = t;
    s = sch[2].replace(/\/+$/, '');
    format = 'scheme://';
  }

  let host = '';
  let port = '';
  let username = '';
  let password = '';

  const splitHostPort = (hp: string): [string, string] | null => {
    const v6 = /^\[([0-9a-f:]+)\]:(\d+)$/i.exec(hp);
    if (v6) return [`[${v6[1]}]`, v6[2]];
    const i = hp.lastIndexOf(':');
    if (i <= 0) return null;
    return [hp.slice(0, i), hp.slice(i + 1)];
  };
  const splitCreds = (c: string): [string, string] => {
    const i = c.indexOf(':');
    return i < 0 ? [c, ''] : [c.slice(0, i), c.slice(i + 1)];
  };

  const colon = s.split(':');
  const at = s.lastIndexOf('@');
  if (colon.length >= 4 && looksLikeHost(colon[0]) && isPort(colon[1])) {
    // host:port:user:pass - checked first because passwords may contain '@' and ':'.
    host = colon[0]; port = colon[1]; username = colon[2]; password = colon.slice(3).join(':');
    format ||= 'host:port:user:pass';
  } else if (at > 0) {
    const left = s.slice(0, at);
    const right = s.slice(at + 1);
    const hpRight = splitHostPort(right);
    if (hpRight && looksLikeHost(hpRight[0]) && isPort(hpRight[1])) {
      [host, port] = hpRight;
      [username, password] = splitCreds(left);
      format ||= 'user:pass@host:port';
    } else {
      const hpLeft = splitHostPort(left);
      if (hpLeft && looksLikeHost(hpLeft[0]) && isPort(hpLeft[1])) {
        [host, port] = hpLeft;
        [username, password] = splitCreds(right);
        format ||= 'host:port@user:pass';
      } else {
        return { ok: false, error: 'proxy.err.format' };
      }
    }
  } else if (/^\[[0-9a-f:]+\]:\d+/i.test(s)) {
    const m = /^(\[[0-9a-f:]+\]):(\d+)(?::([^:]*):(.*))?$/i.exec(s);
    if (!m) return { ok: false, error: 'proxy.err.format' };
    host = m[1]; port = m[2]; username = m[3] ?? ''; password = m[4] ?? '';
    format ||= username ? 'host:port:user:pass' : 'host:port';
  } else {
    const parts = s.split(':');
    if (parts.length === 2) {
      [host, port] = parts;
      format ||= 'host:port';
    } else if (parts.length >= 4) {
      // host:port:user:pass (password may contain ':')  vs  user:pass:host:port
      if (looksLikeHost(parts[0]) && isPort(parts[1])) {
        host = parts[0]; port = parts[1]; username = parts[2]; password = parts.slice(3).join(':');
        format ||= 'host:port:user:pass';
      } else if (isPort(parts[parts.length - 1]) && looksLikeHost(parts[parts.length - 2])) {
        port = parts[parts.length - 1]; host = parts[parts.length - 2]; username = parts[0]; password = parts.slice(1, parts.length - 2).join(':');
        format ||= 'user:pass:host:port';
      } else {
        return { ok: false, error: 'proxy.err.format' };
      }
    } else if (parts.length === 3 && looksLikeHost(parts[0]) && isPort(parts[1])) {
      host = parts[0]; port = parts[1]; username = parts[2];
      format ||= 'host:port:user';
    } else {
      return { ok: false, error: 'proxy.err.format' };
    }
  }

  host = host.trim();
  if (!isValidHost(host)) return { ok: false, error: 'proxy.err.host' };
  if (!isPort(port)) return { ok: false, error: 'proxy.err.port' };
  if (username.length > 256 || password.length > 256) return { ok: false, error: 'proxy.err.creds' };
  return {
    ok: true,
    format,
    proxy: { type, host: host.toLowerCase(), port: Number(port), username, password, changeIpUrl },
  };
}

/** Parse many lines (mass import). Empty lines and # comments are skipped. */
export function parseProxyList(text: string, defaultType: ProxyType = 'http'): Array<ProxyParseResult & { line: number; raw: string }> {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((raw, i) => ({ raw: raw.trim(), line: i + 1 }))
    .filter((l) => l.raw && !l.raw.startsWith('#'))
    .map((l) => ({ ...parseProxy(l.raw, defaultType), line: l.line, raw: l.raw }));
}

/** Display string without the password: "socks5://user@host:port". */
export function formatProxy(p: Pick<ParsedProxy, 'type' | 'host' | 'port'> & { username?: string }, withUser = true): string {
  return `${p.type}://${withUser && p.username ? `${p.username}@` : ''}${p.host}:${p.port}`;
}

/** Full string incl. password, for "copy proxy" (never logged or stored in JSON). */
export function formatProxyFull(p: ParsedProxy): string {
  const cred = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : '';
  return `${p.type}://${cred}${p.host}:${p.port}`;
}

/**
 * Chromium proxy rules for a proxy WITHOUT credentials in them.
 * Chromium cannot authenticate to SOCKS proxies, so SOCKS with credentials is
 * served through the local bridge (see shell/proxy-bridge.ts) - `needsBridge`.
 */
export function chromiumRules(p: Pick<ParsedProxy, 'type' | 'host' | 'port'>): string {
  return `${p.type}://${p.host}:${p.port}`;
}

export function needsBridge(p: Pick<ParsedProxy, 'type' | 'username' | 'password'>): boolean {
  return (p.type === 'socks5' || p.type === 'socks4') && !!(p.username || p.password);
}

/** Saved proxy (Proxies page / "Saved proxy" in the profile editor). No credentials. */
export interface SavedProxy {
  id: string;
  name: string;
  type: ProxyType;
  host: string;
  port: number;
  hasCredentials: boolean;
  changeIpUrl: string;
  createdAt: string;
  /** 0 means no local metered-transfer limit. This is metadata, never a secret. */
  usageLimitBytes: number;
  /** Cumulative browser-accounted transfer through this saved proxy. */
  usageBytes: number;
  lastCheck?: ProxyCheckResult;
  /** User folder of the Proxies page. Empty means the implicit root folder. */
  folder: string;
  /** Manual answer to "does this endpoint rotate?"; 'auto' derives it from observed exit IPs. */
  rotationMode: ProxyRotationMode;
  /** Declared rotation interval in seconds (0 = not declared). */
  rotationIntervalSec: number;
  /** Recent exit-IP observations (newest last, max 8) used to classify rotation locally. */
  ipHistory?: ProxyIpObservation[];
}

export type ProxyRotationMode = 'auto' | 'rotating' | 'sticky';
export const PROXY_ROTATION_MODES: ProxyRotationMode[] = ['auto', 'rotating', 'sticky'];

export interface ProxyIpObservation { ip: string; at: string }

export interface ProxyRotation {
  /** What the app can honestly say about this endpoint. */
  kind: 'rotating' | 'sticky' | 'unknown';
  /** Seconds between IP changes; 0 when nothing reliable is known. */
  intervalSec: number;
  /** Where the answer comes from: the user, or local observations. */
  source: 'manual' | 'observed' | 'none';
  /** How many successful checks the observation is based on. */
  samples: number;
}

/** Keep the newest `max` observations, ignoring repeats of the current IP without a new timestamp. */
export function appendIpObservation(history: ProxyIpObservation[] | undefined, result: ProxyCheckResult, max = 8): ProxyIpObservation[] {
  const list = Array.isArray(history) ? history.filter((item) => item && typeof item.ip === 'string' && typeof item.at === 'string') : [];
  if (!result.ok || !result.ip) return list.slice(-max);
  const last = list[list.length - 1];
  if (last && last.at === result.at) return list.slice(-max);
  return [...list, { ip: result.ip, at: result.at }].slice(-max);
}

/**
 * Classify a saved proxy without contacting anyone: a manual answer always
 * wins, otherwise several checks with different exit IPs mean "rotating",
 * several checks with one IP mean "sticky", and anything less is "unknown".
 * The interval is the median gap between observed IP changes, so one long
 * pause between checks cannot inflate it.
 */
export function proxyRotation(p: Pick<SavedProxy, 'rotationMode' | 'rotationIntervalSec' | 'ipHistory' | 'changeIpUrl'>): ProxyRotation {
  const history = (p.ipHistory ?? []).filter((item) => item && item.ip);
  const declared = Math.max(0, Math.round(Number(p.rotationIntervalSec) || 0));
  if (p.rotationMode === 'rotating' || p.rotationMode === 'sticky') {
    return { kind: p.rotationMode, intervalSec: p.rotationMode === 'rotating' ? declared : 0, source: 'manual', samples: history.length };
  }
  const gaps: number[] = [];
  let changes = 0;
  let previous = history[0];
  for (const item of history.slice(1)) {
    if (item.ip !== previous.ip) {
      changes++;
      const seconds = Math.round((Date.parse(item.at) - Date.parse(previous.at)) / 1000);
      if (Number.isFinite(seconds) && seconds > 0) gaps.push(seconds);
    }
    previous = item;
  }
  if (changes > 0) {
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
    return { kind: 'rotating', intervalSec: declared || median, source: 'observed', samples: history.length };
  }
  if (history.length >= 3) return { kind: 'sticky', intervalSec: 0, source: 'observed', samples: history.length };
  return { kind: 'unknown', intervalSec: declared, source: 'none', samples: history.length };
}

export interface ProxyCheckResult {
  ok: boolean;
  at: string;
  ip?: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
  latencyMs?: number;
  error?: string;
}

/** Normalise the JSON answer of an IP-info service (ipwho.is / ip-api.com / ipapi.co) into a check result. */
export function normalizeIpInfo(json: unknown, latencyMs: number): ProxyCheckResult {
  const j = (json ?? {}) as Record<string, unknown>;
  const tzObj = j.timezone as Record<string, unknown> | string | undefined;
  const tz = typeof tzObj === 'string' ? tzObj : typeof tzObj?.id === 'string' ? tzObj.id : undefined;
  const ip = (j.ip ?? j.query) as string | undefined;
  if (!ip || typeof ip !== 'string' || j.success === false || j.status === 'fail') {
    return { ok: false, at: new Date().toISOString(), error: typeof j.message === 'string' ? j.message : 'no ip in response', latencyMs };
  }
  const lat = Number(j.latitude ?? j.lat);
  const lon = Number(j.longitude ?? j.lon);
  return {
    ok: true,
    at: new Date().toISOString(),
    ip,
    country: typeof j.country === 'string' ? j.country : typeof j.country_name === 'string' ? j.country_name : undefined,
    countryCode: String(j.country_code ?? j.countryCode ?? '').toUpperCase() || undefined,
    region: (j.region ?? j.regionName) as string | undefined,
    city: j.city as string | undefined,
    timezone: tz,
    latitude: Number.isFinite(lat) ? lat : undefined,
    longitude: Number.isFinite(lon) ? lon : undefined,
    latencyMs,
  };
}

/** Flag emoji for an ISO country code ("PL" -> 🇵🇱). */
export function countryFlag(code?: string): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...code.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** IP-info services used to check a proxy (tried in order). */
export const IP_CHECK_URLS = [
  'https://ipwho.is/',
  'http://ip-api.com/json/?fields=status,message,country,countryCode,regionName,city,lat,lon,timezone,query',
];

/** Minimal fetch signature (Electron session.fetch / net.fetch / global fetch). */
export type IpFetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Check the exit IP by asking the IP-info services THROUGH the given fetch
 * (which must be bound to the proxied session). Never throws.
 */
export async function checkExitIp(fetchFn: IpFetchLike, timeoutMs = 8000, urls = IP_CHECK_URLS): Promise<ProxyCheckResult> {
  let lastError = 'no response';
  for (const url of urls) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetchFn(url, { signal: ctl.signal });
      if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }
      const r = normalizeIpInfo(await res.json(), Date.now() - t0);
      if (r.ok) return r;
      lastError = r.error ?? 'invalid response';
    } catch (err) {
      lastError = ctl.signal.aborted ? 'timeout' : (err as Error).message || String(err);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, at: new Date().toISOString(), error: lastError };
}
