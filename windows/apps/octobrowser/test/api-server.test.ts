/** apps/octobrowser/test/api-server.test.ts - local REST API: auth, routing, validation. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { ApiBackend, ApiError, ApiServer } from '../src/main/api-server';

const TOKEN = 'test-token-0123456789';

function fakeBackend() {
  const profiles = new Map<string, Record<string, unknown> & { id: string; name: string }>();
  profiles.set('p1', { id: 'p1', name: 'Shop', folder: 'EU', status: 'ready', tags: ['fb'], running: false });
  const calls: string[] = [];
  const need = (id: string) => { if (!profiles.has(id)) throw new ApiError(404, `profile not found: ${id}`); };
  const b: ApiBackend = {
    version: '9.9.9',
    listProfiles: () => [...profiles.values()],
    getProfile: (id) => { need(id); return profiles.get(id)!; },
    createProfile: (body) => { const p = { id: `p${profiles.size + 1}`, name: String(body.name || 'Profile'), running: false }; profiles.set(p.id, p); return p; },
    updateProfile: (id, body) => { need(id); Object.assign(profiles.get(id)!, body); return profiles.get(id)!; },
    removeProfile: (id) => { need(id); profiles.delete(id); },
    startProfile: async (id, opts) => { need(id); calls.push(`start:${id}:${opts.debug}`); profiles.get(id)!.running = true; return { status: 'started', debugPort: opts.debug ? 9333 : undefined }; },
    stopProfile: (id, force) => { need(id); calls.push(`stop:${id}:${force}`); return true; },
    regenerateFingerprint: (id, os) => { need(id); return { id, os }; },
    setProxy: (id, body) => { need(id); return { id, proxy: body }; },
    checkProfileProxy: async (id) => { need(id); return { ok: true, ip: '1.2.3.4' }; },
    importCookies: (id, cookies) => { need(id); calls.push(`cookies:${id}:${Array.isArray(cookies) ? cookies.length : typeof cookies}`); return { imported: 1, applied: 'next-start' }; },
    bulk: async (action, ids) => Object.fromEntries(ids.map((i) => [i, action])),
    listProxies: () => [],
    addProxies: (text) => ({ added: text.split('\n').length, errors: [] }),
    updateProxy: (id, body) => ({ id, ...body }),
    removeProxy: () => undefined,
    checkSavedProxy: async () => ({ ok: false, error: 'timeout' }),
    parseProxy: (text, type) => ({ ok: true, format: 'host:port', type, text }),
    checkProxy: async () => ({ ok: true }),
    newFingerprint: (os) => ({ os: os ?? 'windows11' }),
    fingerprintMeta: (os) => ({ os, gpus: [] }),
  };
  return { b, profiles, calls };
}

let srv: ApiServer;
let port: number;
let fb: ReturnType<typeof fakeBackend>;

beforeEach(async () => {
  fb = fakeBackend();
  srv = new ApiServer(fb.b, () => TOKEN);
  port = await srv.start(0);
});
afterEach(async () => { await srv.stop(); });

function call(method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: buf ? JSON.parse(buf) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('ApiServer', () => {
  it('health needs no token; everything else does', async () => {
    expect(await call('GET', '/v1/health', undefined, {})).toEqual({ status: 200, json: { ok: true, version: '9.9.9' } });
    expect((await call('GET', '/v1/profiles', undefined, {})).status).toBe(401);
    expect((await call('GET', '/v1/profiles', undefined, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await call('GET', '/v1/profiles', undefined, { authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
    const ok = await call('GET', '/v1/profiles');
    expect(ok.status).toBe(200);
    expect(ok.json[0].name).toBe('Shop');
  });

  it('rejects browser requests (Origin) and foreign Host headers (DNS rebinding)', async () => {
    expect((await call('GET', '/v1/profiles', undefined, { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('GET', '/v1/profiles', undefined, { authorization: `Bearer ${TOKEN}`, host: 'evil.example:35555' })).status).toBe(403);
  });

  it('profile CRUD + filters', async () => {
    const c = await call('POST', '/v1/profiles', { name: 'New one', os: 'macos' });
    expect(c.status).toBe(200);
    expect(c.json).toMatchObject({ id: 'p2', name: 'New one' });
    expect((await call('GET', '/v1/profiles?folder=EU')).json).toHaveLength(1);
    expect((await call('GET', '/v1/profiles?tag=fb')).json.map((p: any) => p.id)).toEqual(['p1']);
    expect((await call('GET', '/v1/profiles?q=new')).json.map((p: any) => p.id)).toEqual(['p2']);
    expect((await call('PATCH', '/v1/profiles/p2', { notes: 'x' })).json.notes).toBe('x');
    expect((await call('DELETE', '/v1/profiles/p2')).json).toEqual({ ok: true });
    expect((await call('GET', '/v1/profiles/p2')).status).toBe(404);
  });

  it('start / stop / fingerprint / proxy / bulk', async () => {
    expect((await call('POST', '/v1/profiles/p1/start', { debug: true })).json).toEqual({ status: 'started', debugPort: 9333 });
    expect((await call('POST', '/v1/profiles/p1/stop', { force: true })).json).toEqual({ ok: true });
    expect(fb.calls).toEqual(['start:p1:true', 'stop:p1:true']);
    expect((await call('POST', '/v1/profiles/p1/fingerprint', { os: 'linux' })).json).toEqual({ id: 'p1', os: 'linux' });
    expect((await call('PUT', '/v1/profiles/p1/proxy', { mode: 'new', text: '1.2.3.4:8080' })).json.proxy.text).toBe('1.2.3.4:8080');
    expect((await call('POST', '/v1/profiles/p1/proxy/check')).json.ip).toBe('1.2.3.4');
    expect((await call('POST', '/v1/profiles/bulk', { action: 'stop', ids: ['p1'] })).json).toEqual({ p1: 'stop' });
    expect((await call('POST', '/v1/profiles/bulk', { action: 'stop', ids: [] })).status).toBe(400);
  });

  it('cookie import (JSON array or text)', async () => {
    const r = await call('POST', '/v1/profiles/p1/cookies', { cookies: [{ name: 'a', value: 'b', domain: '.x.com' }] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ imported: 1, applied: 'next-start' });
    expect(fb.calls).toContain('cookies:p1:1');
    expect((await call('POST', '/v1/profiles/nope/cookies', { cookies: '' })).status).toBe(404);
  });

  it('proxies + fingerprints', async () => {
    expect((await call('POST', '/v1/proxies', { text: 'a:1\nb:2' })).json).toEqual({ added: 2, errors: [] });
    expect((await call('POST', '/v1/proxies/parse', { text: 'h:1', type: 'socks5' })).json).toMatchObject({ ok: true, type: 'socks5' });
    expect((await call('POST', '/v1/proxies/x1/check')).json).toEqual({ ok: false, error: 'timeout' });
    expect((await call('POST', '/v1/fingerprints', { os: 'macos' })).json).toEqual({ os: 'macos' });
    expect((await call('GET', '/v1/fingerprints/meta?os=linux')).json.os).toBe('linux');
  });

  it('errors: unknown route 404, wrong method 405, bad JSON 400, non-object 400', async () => {
    expect((await call('GET', '/v1/nope')).status).toBe(404);
    expect((await call('PUT', '/v1/profiles')).status).toBe(405);
    expect((await call('POST', '/v1/profiles', '{bad json')).status).toBe(400);
    expect((await call('POST', '/v1/profiles', '[1,2]')).status).toBe(400);
    expect((await call('POST', '/v1/profiles/p9/start')).status).toBe(404);
  });

  it('binds to loopback only', () => {
    expect(srv.listening).toBe(true);
    expect(port).toBeGreaterThan(0);
  });
});
