import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import { startSocksHttpBridge, type SocksHttpBridge } from '../src/main/android-socks-bridge';

const close = (server: net.Server | http.Server) => new Promise<void>((resolve) => server.close(() => resolve()));
const servers: Array<net.Server | http.Server> = [];
let bridge: SocksHttpBridge | undefined;
afterEach(async () => { bridge?.close(); bridge = undefined; await Promise.all(servers.splice(0).map(close)); });

/** Minimal no-auth SOCKS5 server used only to prove the local HTTP adapter. */
function socksServer(): Promise<net.Server> {
  return new Promise((resolve) => {
    const server = net.createServer((client) => {
      let stage = 0;
      client.on('data', (chunk) => {
        if (stage === 0) { stage = 1; client.write(Buffer.from([5, 0])); return; }
        if (stage !== 1) return;
        stage = 2;
        const atyp = chunk[3];
        let host = '';
        let offset = 4;
        if (atyp === 1) { host = [...chunk.subarray(offset, offset + 4)].join('.'); offset += 4; }
        else { const size = chunk[offset++]; host = chunk.subarray(offset, offset + size).toString(); offset += size; }
        const port = chunk.readUInt16BE(offset);
        const remote = net.connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          client.pipe(remote); remote.pipe(client);
        });
      });
    });
    server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
  });
}

describe('Android SOCKS5 adapter', () => {
  it('keeps the emulator-facing endpoint local and carries HTTP through SOCKS5', async () => {
    const target = http.createServer((_request, response) => response.end('through socks'));
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
    servers.push(target);
    const socks = await socksServer();
    bridge = await startSocksHttpBridge({ host: '127.0.0.1', port: (socks.address() as AddressInfo).port });
    expect(bridge.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const targetPort = (target.address() as AddressInfo).port;
    const proxy = new URL(bridge.url);
    const body = await new Promise<string>((resolve, reject) => {
      http.get({ hostname: proxy.hostname, port: proxy.port, path: `http://127.0.0.1:${targetPort}/hello`, headers: { host: `127.0.0.1:${targetPort}` } }, (response) => {
        let text = ''; response.on('data', (chunk) => { text += chunk; }); response.on('end', () => resolve(text));
      }).on('error', reject);
    });
    expect(body).toBe('through socks');
  });
});
