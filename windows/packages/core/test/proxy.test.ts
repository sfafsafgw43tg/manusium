/** packages/core/test/proxy.test.ts - proxy format auto-detection, saved proxies, IP info normalisation. */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  DataLayout, ProxyStore, appendIpObservation, proxyRotation, chromiumRules, countryFlag, formatProxy, formatProxyFull, needsBridge, normalizeIpInfo, parseProxy, parseProxyList,
} from '../src';
import { tmpDir } from './helpers';

const ok = (input: string, def: 'http' | 'socks5' = 'http') => {
  const r = parseProxy(input, def);
  expect(r.ok, `${input} -> ${r.error}`).toBe(true);
  return r.proxy!;
};

describe('parseProxy auto-detection', () => {
  it.each([
    ['1.2.3.4:8080', { type: 'http', host: '1.2.3.4', port: 8080, username: '', password: '' }],
    ['proxy.example.com:3128:user:p@ss:word', { host: 'proxy.example.com', port: 3128, username: 'user', password: 'p@ss:word' }],
    ['user:pass@1.2.3.4:1080', { host: '1.2.3.4', port: 1080, username: 'user', password: 'pass' }],
    ['user:pass:gate.proxy.io:7777', { host: 'gate.proxy.io', port: 7777, username: 'user', password: 'pass' }],
    ['1.2.3.4:1080@user:pass', { host: '1.2.3.4', port: 1080, username: 'user', password: 'pass' }],
    ['socks5://u:p@1.2.3.4:1080', { type: 'socks5', host: '1.2.3.4', port: 1080, username: 'u', password: 'p' }],
    ['socks5h://host.example:1080', { type: 'socks5', host: 'host.example', port: 1080 }],
    ['socks4://1.2.3.4:4145', { type: 'socks4' }],
    ['https://u:p@secure.example:443/', { type: 'https', host: 'secure.example', port: 443 }],
    ['http://xv.qproxy.pro:80:46cdc4f04fe341dfb244e51046bda400-cc-PL-s-968dbc71d42b8a19-ttl-60:fcd205d4384ca206d304dc44159482b2', {
      type: 'http', host: 'xv.qproxy.pro', port: 80, username: '46cdc4f04fe341dfb244e51046bda400-cc-PL-s-968dbc71d42b8a19-ttl-60', password: 'fcd205d4384ca206d304dc44159482b2',
    }],
    ['[2001:db8::1]:1080', { host: '[2001:db8::1]', port: 1080 }],
    ['  Proxy.Example.COM:8000  ', { host: 'proxy.example.com', port: 8000 }],
  ])('%s', (input, expected) => {
    expect(ok(input)).toMatchObject(expected);
  });

  it('keeps the selected default type when there is no scheme', () => {
    expect(ok('1.2.3.4:1080', 'socks5').type).toBe('socks5');
  });

  it('extracts a change-IP URL', () => {
    expect(ok('1.2.3.4:80:u:p [https://rotate.example/change?key=1]').changeIpUrl).toBe('https://rotate.example/change?key=1');
    expect(ok('socks5://1.2.3.4:80 | https://rotate.example/x').changeIpUrl).toBe('https://rotate.example/x');
  });

  it.each([
    ['', 'proxy.err.empty'], ['justtext', 'proxy.err.format'], ['1.2.3.4:99999', 'proxy.err.port'],
    ['ftp://1.2.3.4:21', 'proxy.err.scheme'], ['999.1.1.1:80', 'proxy.err.host'], ['bad_host!:80', 'proxy.err.host'],
  ])('rejects %j', (input, err) => {
    const r = parseProxy(input);
    expect(r.ok).toBe(false);
    expect(r.error).toBe(err);
  });

  it('parses mass-import lists and reports bad lines', () => {
    const list = parseProxyList('# comment\n1.2.3.4:80\n\nnope\nsocks5://a:b@5.6.7.8:1080\n');
    expect(list.map((l) => [l.line, l.ok])).toEqual([[2, true], [4, false], [5, true]]);
  });
});

describe('formatting', () => {
  const p = { type: 'socks5' as const, host: 'h.example', port: 1080, username: 'u', password: 'p w', changeIpUrl: '' };
  it('never includes the password in display strings or Chromium rules', () => {
    expect(formatProxy(p)).toBe('socks5://u@h.example:1080');
    expect(chromiumRules(p)).toBe('socks5://h.example:1080');
    expect(formatProxyFull(p)).toBe('socks5://u:p%20w@h.example:1080');
  });
  it('needs the local bridge only for authenticated SOCKS', () => {
    expect(needsBridge(p)).toBe(true);
    expect(needsBridge({ ...p, username: '', password: '' })).toBe(false);
    expect(needsBridge({ ...p, type: 'http' })).toBe(false);
  });
  it('flags', () => {
    expect(countryFlag('pl')).toBe('🇵🇱');
    expect(countryFlag('')).toBe('');
  });
});

describe('normalizeIpInfo', () => {
  it('understands ipwho.is', () => {
    const r = normalizeIpInfo({ success: true, ip: '109.243.144.229', country: 'Poland', country_code: 'PL', region: 'Mazovia', city: 'Warsaw', latitude: 52.2, longitude: 21.0, timezone: { id: 'Europe/Warsaw' } }, 120);
    expect(r).toMatchObject({ ok: true, ip: '109.243.144.229', countryCode: 'PL', city: 'Warsaw', timezone: 'Europe/Warsaw', latencyMs: 120 });
  });
  it('understands ip-api.com', () => {
    const r = normalizeIpInfo({ status: 'success', query: '1.1.1.1', country: 'Australia', countryCode: 'AU', regionName: 'Queensland', city: 'Brisbane', lat: -27.4, lon: 153, timezone: 'Australia/Brisbane' }, 5);
    expect(r).toMatchObject({ ok: true, ip: '1.1.1.1', countryCode: 'AU', region: 'Queensland', timezone: 'Australia/Brisbane', latitude: -27.4 });
  });
  it('reports failures', () => {
    expect(normalizeIpInfo({ success: false, message: 'reserved range' }, 1)).toMatchObject({ ok: false, error: 'reserved range' });
  });
});

describe('ProxyStore', () => {
  it('stores metadata in JSON and credentials only in the secret store', () => {
    const layout = new DataLayout(path.join(tmpDir(), 'OctoBrowser'));
    layout.ensure();
    const secrets = new Map<string, string>();
    const api = {
      get: (k: string) => secrets.get(k), has: (k: string) => secrets.has(k), set: (k: string, v: string) => { secrets.set(k, v); },
      delete: (k: string) => { secrets.delete(k); }, deletePrefix: () => undefined, backend: () => 'local' as const, ids: () => [...secrets.keys()],
    };
    const store = new ProxyStore(layout, api);
    const saved = store.add(parseProxy('socks5://alice:s3cret@1.2.3.4:1080').proxy!, 'PL');
    expect(saved.hasCredentials).toBe(true);
    const json = require('node:fs').readFileSync(path.join(layout.config, 'proxies.json'), 'utf8');
    expect(json).not.toContain('s3cret');
    expect(store.resolve(saved.id)).toMatchObject({ username: 'alice', password: 's3cret', host: '1.2.3.4' });
    // duplicate endpoint -> same entry
    expect(store.add(parseProxy('socks5://alice:new@1.2.3.4:1080').proxy!).id).toBe(saved.id);
    expect(store.resolve(saved.id).password).toBe('new');
    store.update(saved.id, { name: 'Renamed', usageLimitBytes: 2_000_000_000 });
    expect(store.get(saved.id)).toMatchObject({ name: 'Renamed', usageLimitBytes: 2_000_000_000, usageBytes: 0 });
    store.addUsage(saved.id, 1234);
    expect(store.get(saved.id).usageBytes).toBe(1234);
    // Optional patch fields must not reset a previously selected limit.
    store.update(saved.id, { name: 'Renamed again' });
    expect(store.get(saved.id).usageLimitBytes).toBe(2_000_000_000);
    store.remove(saved.id);
    expect(store.list()).toEqual([]);
    expect(secrets.size).toBe(0);
  });
});

import { checkExitIp } from '../src/proxy';
describe('checkExitIp', () => {
  const ok = (json: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) });
  it('returns the first successful service', async () => {
    const r = await checkExitIp(() => ok({ ip: '109.243.144.229', success: true, country: 'Poland', country_code: 'PL', region: 'Mazovia', city: 'Warsaw', latitude: 52.2, longitude: 21, timezone: { id: 'Europe/Warsaw' } }));
    expect(r).toMatchObject({ ok: true, ip: '109.243.144.229', countryCode: 'PL', timezone: 'Europe/Warsaw', city: 'Warsaw' });
  });
  it('falls back to the next service and reports errors', async () => {
    let n = 0;
    const r = await checkExitIp(() => (n++ === 0 ? Promise.reject(new Error('ECONNREFUSED')) : ok({ status: 'success', query: '1.2.3.4', countryCode: 'de', timezone: 'Europe/Berlin', lat: 1, lon: 2 })));
    expect(r).toMatchObject({ ok: true, ip: '1.2.3.4', countryCode: 'DE', timezone: 'Europe/Berlin' });
    const bad = await checkExitIp(() => Promise.reject(new Error('proxy auth failed')));
    expect(bad).toMatchObject({ ok: false, error: 'proxy auth failed' });
  });
  it('times out', async () => {
    const r = await checkExitIp((_u, init) => new Promise((_ok, fail) => init?.signal?.addEventListener('abort', () => fail(new Error('aborted')))), 50, ['https://x/']);
    expect(r).toMatchObject({ ok: false, error: 'timeout' });
  });
});

describe('proxy rotation and folders', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();
  const base = { rotationMode: 'auto' as const, rotationIntervalSec: 0, changeIpUrl: '' };

  it('says "unknown" until there is evidence, and never guesses an interval', () => {
    expect(proxyRotation({ ...base, ipHistory: [] })).toMatchObject({ kind: 'unknown', intervalSec: 0, source: 'none' });
    expect(proxyRotation({ ...base, ipHistory: [{ ip: '1.1.1.1', at: at(0) }] }).kind).toBe('unknown');
  });

  it('calls repeated identical exit IPs sticky and changing ones rotating', () => {
    const sticky = ['1.1.1.1', '1.1.1.1', '1.1.1.1'].map((ip, i) => ({ ip, at: at(i * 10) }));
    expect(proxyRotation({ ...base, ipHistory: sticky })).toMatchObject({ kind: 'sticky', intervalSec: 0, source: 'observed' });
    const rotating = ['1.1.1.1', '2.2.2.2', '3.3.3.3'].map((ip, i) => ({ ip, at: at(i * 5) }));
    expect(proxyRotation({ ...base, ipHistory: rotating })).toMatchObject({ kind: 'rotating', intervalSec: 300, source: 'observed' });
  });

  it('lets the user override the answer and state the advertised interval', () => {
    const observed = ['1.1.1.1', '1.1.1.1', '1.1.1.1'].map((ip, i) => ({ ip, at: at(i) }));
    expect(proxyRotation({ ...base, rotationMode: 'rotating', rotationIntervalSec: 600, ipHistory: observed }))
      .toMatchObject({ kind: 'rotating', intervalSec: 600, source: 'manual' });
    expect(proxyRotation({ ...base, rotationMode: 'sticky', ipHistory: [] })).toMatchObject({ kind: 'sticky', source: 'manual' });
  });

  it('records one observation per successful check and keeps the history short', () => {
    let history = appendIpObservation([], { ok: true, at: at(0), ip: '1.1.1.1' });
    history = appendIpObservation(history, { ok: true, at: at(0), ip: '1.1.1.1' }); // same check again
    history = appendIpObservation(history, { ok: false, at: at(1), error: 'timeout' });
    expect(history).toHaveLength(1);
    for (let i = 2; i < 20; i++) history = appendIpObservation(history, { ok: true, at: at(i), ip: `1.1.1.${i}` });
    expect(history).toHaveLength(8);
    expect(history[7].ip).toBe('1.1.1.19');
  });

  it('stores folders and check history in the proxy store', () => {
    const layout = new DataLayout(path.join(tmpDir(), 'OctoBrowser'));
    layout.ensure();
    const store = new ProxyStore(layout);
    const a = store.add(parseProxy('http://1.2.3.4:8080').proxy!, 'A');
    const b = store.add(parseProxy('http://5.6.7.8:8080').proxy!, 'B');
    expect(a.folder).toBe('');
    expect(store.setFolder([a.id, b.id], 'Residential UK')).toBe(2);
    expect(store.folders()).toEqual(['Residential UK']);
    store.update(a.id, { lastCheck: { ok: true, at: at(0), ip: '9.9.9.9' } });
    store.update(a.id, { lastCheck: { ok: true, at: at(5), ip: '8.8.8.8' } });
    expect(proxyRotation(store.get(a.id))).toMatchObject({ kind: 'rotating', intervalSec: 300 });
    expect(store.setFolder([a.id], '')).toBe(1);
    expect(store.folders()).toEqual(['Residential UK']);
  });
});
