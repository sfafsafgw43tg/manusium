/**
 * apps/octobrowser/src/main/api-server.ts
 *
 * Local automation REST API of the profile manager (like the local API of
 * other antidetect browsers). Listens on 127.0.0.1 only, every request needs
 * `Authorization: Bearer <token>` (token from Settings -> API). JSON in / out.
 *
 *   GET    /v1/health                          (no auth) {"ok":true,"version"}
 *   GET    /v1/profiles                        ?q=&folder=&status=&tag=&running=
 *   POST   /v1/profiles                        {name, kind?, os?, fingerprint?, proxy?, ...settings}
 *   GET    /v1/profiles/:id
 *   PATCH  /v1/profiles/:id                    {...settings, proxy?}
 *   DELETE /v1/profiles/:id
 *   POST   /v1/profiles/:id/start              {debug?: boolean}  -> {status, debugPort?, wsEndpoint?}
 *   POST   /v1/profiles/:id/stop               {force?: boolean}
 *   POST   /v1/profiles/:id/fingerprint        {os?}   new fingerprint for the profile
 *   PUT    /v1/profiles/:id/proxy              {mode:'none'|'new'|'saved', text?, type?, savedId?, changeIpUrl?, name?, save?}
 *   POST   /v1/profiles/:id/proxy/check
 *   POST   /v1/profiles/bulk                   {action:'start'|'stop'|'remove'|'folder'|'status'|'tags', ids:[], arg?}
 *   GET    /v1/proxies
 *   POST   /v1/proxies                         {text, type?, name?}  (one or many lines)
 *   PATCH  /v1/proxies/:id                     {name?, changeIpUrl?}
 *   DELETE /v1/proxies/:id
 *   POST   /v1/proxies/:id/check
 *   POST   /v1/proxies/parse                   {text, type?}  -> detected format (nothing stored)
 *   POST   /v1/proxies/check                   {text, type?}  -> check without storing
 *   POST   /v1/fingerprints                    {os?}  -> realistic random fingerprint
 *   GET    /v1/fingerprints/meta?os=windows11  -> GPU presets + UA for the OS
 */
import * as http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** What the API needs from the manager (implemented by Manager; faked in tests). */
export interface ApiBackend {
  version: string;
  listProfiles(): Array<Record<string, unknown> & { id: string; name: string }>;
  getProfile(id: string): Record<string, unknown>;
  createProfile(body: Record<string, unknown>): Record<string, unknown>;
  updateProfile(id: string, body: Record<string, unknown>): Record<string, unknown>;
  removeProfile(id: string): void;
  startProfile(id: string, opts: { debug: boolean }): Promise<Record<string, unknown>>;
  stopProfile(id: string, force: boolean): boolean;
  regenerateFingerprint(id: string, os?: string): Record<string, unknown>;
  setProxy(id: string, body: Record<string, unknown>): Record<string, unknown>;
  checkProfileProxy(id: string): Promise<Record<string, unknown>>;
  importCookies(id: string, cookies: unknown): Record<string, unknown>;
  bulk(action: string, ids: string[], arg: unknown): Promise<Record<string, unknown>>;
  listProxies(): unknown[];
  addProxies(text: string, type: string, name: string): Record<string, unknown>;
  updateProxy(id: string, body: Record<string, unknown>): Record<string, unknown>;
  removeProxy(id: string): void;
  checkSavedProxy(id: string): Promise<Record<string, unknown>>;
  parseProxy(text: string, type: string): Record<string, unknown>;
  checkProxy(text: string, type: string): Promise<Record<string, unknown>>;
  newFingerprint(os?: string): Record<string, unknown>;
  fingerprintMeta(os: string): Record<string, unknown>;
}

const MAX_BODY = 10 * 1024 * 1024; // cookie imports can be a few MB

function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new ApiError(413, 'request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const v = JSON.parse(raw) as unknown;
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new ApiError(400, 'JSON object expected'));
        resolve(v as Record<string, unknown>);
      } catch { reject(new ApiError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

type Handler = (p: { params: string[]; body: Record<string, unknown>; query: URLSearchParams }) => unknown;

export class ApiServer {
  private server: http.Server | null = null;
  private readonly routes: Array<{ method: string; re: RegExp; fn: Handler; auth: boolean }> = [];

  constructor(private readonly backend: ApiBackend, private readonly getToken: () => string, private readonly log?: { info(e: string, d?: unknown): void; warn(e: string, d?: unknown): void }) {
    const b = backend;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    this.route('GET', '/v1/health', () => ({ ok: true, version: b.version }), false);
    this.route('GET', '/v1/profiles', ({ query }) => {
      const q = (query.get('q') ?? '').toLowerCase();
      const folder = query.get('folder');
      const status = query.get('status');
      const tag = query.get('tag');
      const running = query.get('running');
      return b.listProfiles().filter((p) =>
        (!q || p.name.toLowerCase().includes(q) || String(p.notes ?? '').toLowerCase().includes(q)) &&
        (folder === null || p.folder === folder) &&
        (status === null || p.status === status) &&
        (tag === null || (Array.isArray(p.tags) && p.tags.includes(tag))) &&
        (running === null || String(!!p.running) === running));
    });
    this.route('POST', '/v1/profiles/bulk', ({ body }) => {
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      if (!ids.length) throw new ApiError(400, 'ids required');
      return b.bulk(str(body.action), ids, body.arg);
    });
    this.route('POST', '/v1/profiles', ({ body }) => b.createProfile(body));
    this.route('GET', '/v1/profiles/([\\w-]+)', ({ params }) => b.getProfile(params[0]));
    this.route('PATCH', '/v1/profiles/([\\w-]+)', ({ params, body }) => b.updateProfile(params[0], body));
    this.route('DELETE', '/v1/profiles/([\\w-]+)', ({ params }) => { b.removeProfile(params[0]); return { ok: true }; });
    this.route('POST', '/v1/profiles/([\\w-]+)/start', ({ params, body }) => b.startProfile(params[0], { debug: body.debug === true }));
    this.route('POST', '/v1/profiles/([\\w-]+)/stop', ({ params, body }) => ({ ok: b.stopProfile(params[0], body.force === true) }));
    this.route('POST', '/v1/profiles/([\\w-]+)/fingerprint', ({ params, body }) => b.regenerateFingerprint(params[0], str(body.os) || undefined));
    this.route('PUT', '/v1/profiles/([\\w-]+)/proxy', ({ params, body }) => b.setProxy(params[0], body));
    this.route('POST', '/v1/profiles/([\\w-]+)/cookies', ({ params, body }) => b.importCookies(params[0], body.cookies));
    this.route('POST', '/v1/profiles/([\\w-]+)/proxy/check', ({ params }) => b.checkProfileProxy(params[0]));
    this.route('GET', '/v1/proxies', () => b.listProxies());
    this.route('POST', '/v1/proxies/parse', ({ body }) => b.parseProxy(str(body.text), str(body.type) || 'http'));
    this.route('POST', '/v1/proxies/check', ({ body }) => b.checkProxy(str(body.text), str(body.type) || 'http'));
    this.route('POST', '/v1/proxies', ({ body }) => b.addProxies(str(body.text), str(body.type) || 'http', str(body.name)));
    this.route('PATCH', '/v1/proxies/([\\w-]+)', ({ params, body }) => b.updateProxy(params[0], body));
    this.route('DELETE', '/v1/proxies/([\\w-]+)', ({ params }) => { b.removeProxy(params[0]); return { ok: true }; });
    this.route('POST', '/v1/proxies/([\\w-]+)/check', ({ params }) => b.checkSavedProxy(params[0]));
    this.route('POST', '/v1/fingerprints', ({ body }) => b.newFingerprint(str(body.os) || undefined));
    this.route('GET', '/v1/fingerprints/meta', ({ query }) => b.fingerprintMeta(query.get('os') ?? 'windows11'));
  }

  private route(method: string, pattern: string, fn: Handler, auth = true): void {
    this.routes.push({ method, re: new RegExp(`^${pattern}$`), fn, auth });
  }

  get port(): number {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : 0;
  }

  get listening(): boolean {
    return !!this.server?.listening;
  }

  start(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => void this.handle(req, res));
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => {
        srv.off('error', reject);
        this.server = srv;
        this.log?.info('api.started', { port: this.port });
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    const srv = this.server;
    this.server = null;
    if (!srv) return;
    srv.closeAllConnections?.();
    await new Promise<void>((r) => srv.close(() => r()));
    this.log?.info('api.stopped');
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body ?? null);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(json);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // Browsers must not be able to drive the API (DNS rebinding / CSRF from web pages).
      const host = String(req.headers.host ?? '');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) throw new ApiError(403, 'forbidden host');
      if (req.headers.origin) throw new ApiError(403, 'browser requests are not allowed');
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = (req.method ?? 'GET').toUpperCase();
      const candidates = this.routes.filter((r) => r.re.test(url.pathname));
      if (!candidates.length) throw new ApiError(404, 'not found');
      const route = candidates.find((r) => r.method === method);
      if (!route) throw new ApiError(405, 'method not allowed');
      if (route.auth) {
        const auth = String(req.headers.authorization ?? '');
        const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
        if (!tokenMatches(token, this.getToken())) throw new ApiError(401, 'invalid or missing API token');
      }
      const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req);
      const params = route.re.exec(url.pathname)!.slice(1);
      const out = await route.fn({ params, body, query: url.searchParams });
      this.send(res, 200, out);
    } catch (err) {
      const e = err as Error;
      const status = err instanceof ApiError ? err.status : /not found/i.test(e.message) ? 404 : 400;
      if (status >= 500 || !(err instanceof ApiError)) this.log?.warn('api.error', { status, message: e.message });
      this.send(res, status, { error: e.message || 'error' });
    }
  }
}
