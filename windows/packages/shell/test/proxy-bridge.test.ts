/** packages/shell/test/proxy-bridge.test.ts - local SOCKS5 bridge to authenticated upstream proxies. */
import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import { ProxyBridge, UpstreamProxy, openTunnel } from '../src/proxy-bridge';

const closers: Array<() => void> = [];
afterEach(() => { while (closers.length) closers.pop()!(); });

function listen(srv: net.Server): Promise<number> {
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => { closers.push(() => srv.close()); r((srv.address() as net.AddressInfo).port); }));
}

/** Echo server: replies "echo:<data>". Stands for the website. */
async function target(): Promise<number> {
  return listen(net.createServer((s) => s.on('data', (d) => s.write(`echo:${d}`))));
}

/** Minimal authenticated SOCKS5 upstream that records the requested host. */
async function socks5Upstream(user: string, pass: string, seen: string[]): Promise<number> {
  return listen(net.createServer((s) => {
    let stage = 0;
    s.on('data', function onData(d) {
      if (stage === 0) { stage = 1; s.write(Buffer.from([5, d.includes(2) ? 2 : 0xff])); return; }
      if (stage === 1) {
        const ul = d[1]; const u = d.subarray(2, 2 + ul).toString(); const pl = d[2 + ul]; const p = d.subarray(3 + ul, 3 + ul + pl).toString();
        if (u !== user || p !== pass) { s.end(Buffer.from([1, 1])); return; }
        stage = 2; s.write(Buffer.from([1, 0])); return;
      }
      if (stage === 2) {
        stage = 3;
        const atyp = d[3];
        let host: string; let off: number;
        if (atyp === 3) { host = d.subarray(5, 5 + d[4]).toString(); off = 5 + d[4]; } else { host = [...d.subarray(4, 8)].join('.'); off = 8; }
        const port = d.readUInt16BE(off);
        seen.push(`${host}:${port}`);
        const up = net.connect(port, '127.0.0.1', () => { s.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])); s.pipe(up); up.pipe(s); s.off('data', onData); });
      }
    });
  }));
}

async function httpUpstream(user: string, pass: string, seen: string[]): Promise<number> {
  return listen(net.createServer((s) => {
    s.once('data', (d) => {
      const head = d.toString('latin1');
      const m = /^CONNECT (\S+):(\d+) /.exec(head);
      seen.push(m ? `${m[1]}:${m[2]}` : 'bad');
      const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
      if (!head.includes(`Proxy-Authorization: ${expected}`)) { s.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
      const up = net.connect(Number(m![2]), '127.0.0.1', () => { s.write('HTTP/1.1 200 Connection established\r\n\r\n'); s.pipe(up); up.pipe(s); });
    });
  }));
}

async function socks4Upstream(seen: string[]): Promise<number> {
  return listen(net.createServer((s) => {
    s.once('data', (d) => {
      const port = d.readUInt16BE(2);
      const rest = d.subarray(8);
      const userEnd = rest.indexOf(0);
      const user = rest.subarray(0, userEnd).toString();
      const host = rest.subarray(userEnd + 1, rest.indexOf(0, userEnd + 1)).toString();
      seen.push(`${user}@${host}:${port}`);
      const up = net.connect(port, '127.0.0.1', () => { s.write(Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0])); s.pipe(up); up.pipe(s); });
    });
  }));
}

/** Act as Chromium: SOCKS5 without auth to the bridge, CONNECT by domain name. */
function socksClient(bridgePort: number, host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.connect(bridgePort, '127.0.0.1');
    let stage = 0;
    c.on('data', (d) => {
      if (stage === 0) { expect([...d]).toEqual([5, 0]); stage = 1; const h = Buffer.from(host); const p = Buffer.alloc(2); p.writeUInt16BE(port); c.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, p])); return; }
      if (stage === 1) { if (d[1] !== 0) { reject(new Error(`bridge reply ${d[1]}`)); c.destroy(); return; } stage = 2; c.write('hello'); return; }
      resolve(d.toString()); c.destroy();
    });
    c.on('error', reject);
    c.write(Buffer.from([5, 1, 0]));
  });
}

async function withBridge(up: UpstreamProxy) {
  const b = new ProxyBridge(up);
  await b.start();
  closers.push(() => void b.stop());
  expect(b.rules).toMatch(/^socks5:\/\/127\.0\.0\.1:\d+$/);
  return b;
}

describe('ProxyBridge', () => {
  it('forwards through an authenticated SOCKS5 upstream, host names unresolved (no DNS leak)', async () => {
    const t = await target(); const seen: string[] = [];
    const up = await socks5Upstream('alice', 's3cret', seen);
    const b = await withBridge({ type: 'socks5', host: '127.0.0.1', port: up, username: 'alice', password: 's3cret' });
    expect(await socksClient(b.port, 'site.example', t)).toBe('echo:hello');
    expect(seen).toEqual([`site.example:${t}`]);
    expect(b.stats.connections).toBe(1);
  });

  it('reports wrong SOCKS5 credentials as a failed CONNECT', async () => {
    const t = await target(); const seen: string[] = [];
    const up = await socks5Upstream('alice', 's3cret', seen);
    const b = await withBridge({ type: 'socks5', host: '127.0.0.1', port: up, username: 'alice', password: 'wrong' });
    await expect(socksClient(b.port, 'site.example', t)).rejects.toThrow(/bridge reply 1/);
    expect(b.stats.lastError).toMatch(/authentication failed/);
  });

  it('works with HTTP CONNECT upstreams with Basic auth', async () => {
    const t = await target(); const seen: string[] = [];
    const up = await httpUpstream('bob', 'pw:with:colons', seen);
    const b = await withBridge({ type: 'http', host: '127.0.0.1', port: up, username: 'bob', password: 'pw:with:colons' });
    expect(await socksClient(b.port, 'shop.example', t)).toBe('echo:hello');
    expect(seen).toEqual([`shop.example:${t}`]);
  });

  it('works with SOCKS4a upstreams (user id, remote DNS)', async () => {
    const t = await target(); const seen: string[] = [];
    const up = await socks4Upstream(seen);
    const b = await withBridge({ type: 'socks4', host: '127.0.0.1', port: up, username: 'uid7', password: '' });
    expect(await socksClient(b.port, 'x.example', t)).toBe('echo:hello');
    expect(seen).toEqual([`uid7@x.example:${t}`]);
  });

  it('openTunnel surfaces HTTP 407 clearly', async () => {
    const seen: string[] = [];
    const up = await httpUpstream('bob', 'pw', seen);
    await expect(openTunnel({ type: 'http', host: '127.0.0.1', port: up, username: 'bob', password: 'nope' }, 'a.example', 443)).rejects.toThrow(/407/);
  });
});
