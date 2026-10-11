/**
 * packages/shell/src/proxy-bridge.ts
 *
 * Local proxy bridge. Chromium cannot authenticate to SOCKS proxies (neither
 * SOCKS5 username/password nor a SOCKS4 user id), which is the most common
 * format of paid residential/mobile proxies. The bridge is a tiny SOCKS5
 * server on 127.0.0.1 WITHOUT authentication that Chromium talks to; every
 * CONNECT is forwarded to the real upstream proxy with credentials:
 *
 *   Chromium --socks5 (no auth)--> 127.0.0.1:<random> --socks5 user/pass | socks4a | http CONNECT--> upstream --> site
 *
 * Host names are passed through unresolved (SOCKS5 ATYP=domain / SOCKS4a),
 * so DNS is resolved by the upstream proxy - no DNS leak. Only TCP CONNECT is
 * supported (UDP ASSOCIATE is refused; WebRTC UDP is disabled for proxied
 * antidetect profiles anyway). The listener binds 127.0.0.1 only, on a random
 * port, one bridge per profile process.
 */
import * as net from 'node:net';

export interface UpstreamProxy {
  type: 'http' | 'https' | 'socks4' | 'socks5';
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface BridgeStats { connections: number; active: number; errors: number; lastError?: string }

const TIMEOUT_MS = 20_000;

/** Buffered reader over a socket: read exactly n bytes / an HTTP head. */
class Reader {
  private buf = Buffer.alloc(0);
  private waiter: (() => void) | null = null;
  private ended: Error | null = null;

  constructor(private readonly sock: net.Socket) {
    sock.on('data', this.onData);
    sock.once('error', (e) => this.fail(e));
    sock.once('close', () => this.fail(new Error('connection closed by proxy')));
  }

  private onData = (chunk: Buffer) => {
    this.buf = Buffer.concat([this.buf, chunk]);
    const w = this.waiter;
    this.waiter = null;
    w?.();
  };

  private fail(e: Error) {
    if (!this.ended) this.ended = e;
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  private wait(): Promise<void> {
    if (this.ended) return Promise.reject(this.ended);
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (this.ended) throw this.ended;
      await this.wait();
    }
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }

  async readHttpHead(max = 16384): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf('\r\n\r\n');
      if (i >= 0) {
        const head = this.buf.subarray(0, i + 4).toString('latin1');
        this.buf = this.buf.subarray(i + 4);
        return head;
      }
      if (this.buf.length > max) throw new Error('proxy response too large');
      if (this.ended) throw this.ended;
      await this.wait();
    }
  }

  /** Stop buffering and hand back unread bytes (forwarded to the other side). */
  detach(): Buffer {
    this.sock.off('data', this.onData);
    const rest = this.buf;
    this.buf = Buffer.alloc(0);
    return rest;
  }
}

function connectTcp(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: host.replace(/^\[|\]$/g, ''), port });
    s.setNoDelay(true);
    const t = setTimeout(() => { s.destroy(); reject(new Error('proxy connect timeout')); }, TIMEOUT_MS);
    s.once('connect', () => { clearTimeout(t); resolve(s); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

function socksAddress(host: string, port: number): Buffer {
  const h = host.replace(/^\[|\]$/g, '');
  let addr: Buffer;
  if (net.isIPv4(h)) addr = Buffer.from([1, ...h.split('.').map(Number)]);
  else if (net.isIPv6(h)) addr = Buffer.concat([Buffer.from([4]), ipv6Bytes(h)]);
  else {
    const d = Buffer.from(h, 'utf8');
    if (d.length > 255) throw new Error('host name too long');
    addr = Buffer.concat([Buffer.from([3, d.length]), d]);
  }
  const p = Buffer.alloc(2);
  p.writeUInt16BE(port);
  return Buffer.concat([addr, p]);
}

function ipv6Bytes(ip: string): Buffer {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return b;
}

const SOCKS5_ERRORS: Record<number, string> = {
  1: 'general failure', 2: 'connection not allowed', 3: 'network unreachable', 4: 'host unreachable',
  5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported',
};

/**
 * Open a TCP tunnel to host:port through the upstream proxy.
 * Returns the connected socket and any bytes the target already sent.
 */
export async function openTunnel(up: UpstreamProxy, host: string, port: number): Promise<{ socket: net.Socket; head: Buffer }> {
  const s = await connectTcp(up.host, up.port);
  const r = new Reader(s);
  const timer = setTimeout(() => s.destroy(new Error('proxy handshake timeout')), TIMEOUT_MS);
  try {
    if (up.type === 'socks5') {
      const auth = !!(up.username || up.password);
      s.write(Buffer.from(auth ? [5, 2, 0, 2] : [5, 1, 0]));
      const [ver, method] = await r.read(2);
      if (ver !== 5) throw new Error('upstream is not a SOCKS5 proxy');
      if (method === 2) {
        const u = Buffer.from(up.username, 'utf8');
        const p = Buffer.from(up.password, 'utf8');
        if (u.length > 255 || p.length > 255) throw new Error('credentials too long');
        s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
        const [, status] = await r.read(2);
        if (status !== 0) throw new Error('SOCKS5 authentication failed (wrong username/password)');
      } else if (method === 0xff) {
        throw new Error(auth ? 'SOCKS5 proxy rejected the credentials method' : 'SOCKS5 proxy requires authentication');
      } else if (method !== 0) {
        throw new Error('SOCKS5 proxy chose an unsupported method');
      }
      s.write(Buffer.concat([Buffer.from([5, 1, 0]), socksAddress(host, port)]));
      const [v2, rep, , atyp] = await r.read(4);
      if (v2 !== 5) throw new Error('invalid SOCKS5 reply');
      if (rep !== 0) throw new Error(`SOCKS5: ${SOCKS5_ERRORS[rep] ?? `error ${rep}`}`);
      const skip = atyp === 1 ? 4 : atyp === 4 ? 16 : (await r.read(1))[0];
      await r.read(skip + 2);
    } else if (up.type === 'socks4') {
      // SOCKS4a: IP 0.0.0.1 + host name => the proxy resolves DNS.
      const p = Buffer.alloc(2);
      p.writeUInt16BE(port);
      const isV4 = net.isIPv4(host);
      const ip = isV4 ? Buffer.from(host.split('.').map(Number)) : Buffer.from([0, 0, 0, 1]);
      const user = Buffer.from(up.username, 'utf8');
      const parts = [Buffer.from([4, 1]), p, ip, user, Buffer.from([0])];
      if (!isV4) parts.push(Buffer.from(host, 'utf8'), Buffer.from([0]));
      s.write(Buffer.concat(parts));
      const [, cd] = await r.read(8);
      if (cd !== 0x5a) throw new Error(`SOCKS4 request rejected (code ${cd})`);
    } else {
      const target = net.isIPv6(host.replace(/^\[|\]$/g, '')) ? `[${host.replace(/^\[|\]$/g, '')}]:${port}` : `${host}:${port}`;
      let req = `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Connection: keep-alive\r\n`;
      if (up.username || up.password) req += `Proxy-Authorization: Basic ${Buffer.from(`${up.username}:${up.password}`, 'utf8').toString('base64')}\r\n`;
      s.write(`${req}\r\n`);
      const head = await r.readHttpHead();
      const m = /^HTTP\/\d\.\d\s+(\d{3})/.exec(head);
      if (!m) throw new Error('invalid HTTP proxy response');
      if (m[1] === '407') throw new Error('HTTP proxy authentication failed (407)');
      if (m[1] !== '200') throw new Error(`HTTP proxy refused CONNECT (${m[1]})`);
    }
    clearTimeout(timer);
    return { socket: s, head: r.detach() };
  } catch (err) {
    clearTimeout(timer);
    s.destroy();
    throw err;
  }
}

/** Local SOCKS5 server (no auth, 127.0.0.1 only) forwarding to an authenticated upstream. */
export class ProxyBridge {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  readonly stats: BridgeStats = { connections: 0, active: 0, errors: 0 };

  constructor(private upstream: UpstreamProxy) {}

  setUpstream(up: UpstreamProxy): void {
    this.upstream = up;
  }

  get port(): number {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : 0;
  }

  /** Chromium proxy rules pointing at the bridge. */
  get rules(): string {
    return `socks5://127.0.0.1:${this.port}`;
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((c) => void this.onClient(c));
      srv.on('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        this.server = srv;
        resolve(this.port);
      });
    });
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }

  private async onClient(c: net.Socket): Promise<void> {
    const ra = c.remoteAddress ?? '';
    if (!/^(127\.|::1$|::ffff:127\.)/.test(ra)) { c.destroy(); return; }
    this.stats.connections++;
    this.stats.active++;
    this.sockets.add(c);
    c.setNoDelay(true);
    let upstream: net.Socket | null = null;
    const done = () => {
      if (this.sockets.delete(c)) this.stats.active--;
      upstream?.destroy();
      c.destroy();
    };
    c.once('close', done);
    c.once('error', done);
    const r = new Reader(c);
    try {
      const [ver, n] = await r.read(2);
      if (ver !== 5) throw new Error('client is not SOCKS5');
      const methods = await r.read(n);
      if (!methods.includes(0)) { c.end(Buffer.from([5, 0xff])); return; }
      c.write(Buffer.from([5, 0]));
      const [v, cmd, , atyp] = await r.read(4);
      if (v !== 5) throw new Error('bad request');
      let host: string;
      if (atyp === 1) host = [...(await r.read(4))].join('.');
      else if (atyp === 3) host = (await r.read((await r.read(1))[0])).toString('utf8');
      else if (atyp === 4) {
        const b = await r.read(16);
        host = Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(':');
      } else { c.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      const port = (await r.read(2)).readUInt16BE(0);
      if (cmd !== 1) { c.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      let tunnel: { socket: net.Socket; head: Buffer };
      try {
        tunnel = await openTunnel(this.upstream, host, port);
      } catch (err) {
        this.stats.errors++;
        this.stats.lastError = (err as Error).message;
        c.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      upstream = tunnel.socket;
      this.sockets.add(upstream);
      upstream.once('close', () => { this.sockets.delete(upstream!); c.destroy(); });
      upstream.once('error', () => c.destroy());
      c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      const pending = r.detach();
      if (tunnel.head.length) c.write(tunnel.head);
      if (pending.length) upstream.write(pending);
      c.pipe(upstream);
      upstream.pipe(c);
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = (err as Error).message;
      done();
    }
  }
}
