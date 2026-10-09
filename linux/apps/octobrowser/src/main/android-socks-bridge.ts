/**
 * A loopback-only HTTP CONNECT adapter for Android Emulator.
 *
 * Android Emulator accepts an HTTP proxy but not SOCKS5. This bridge gives it
 * a short-lived local HTTP endpoint and opens every destination through the
 * user's SOCKS5 proxy. Credentials stay in the main process and never appear
 * in the emulator command line.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SocksClient } from 'socks';

export interface Socks5Target { host: string; port: number; username?: string; password?: string }
export interface SocksHttpBridge { url: string; close: () => void }

function destination(raw: string, fallbackPort: number): { host: string; port: number } {
  const value = raw.trim();
  const ipv6 = /^\[([^\]]+)](?::(\d+))?$/.exec(value);
  if (ipv6) return { host: ipv6[1], port: Number(ipv6[2] || fallbackPort) };
  const split = value.lastIndexOf(':');
  if (split > 0 && /^\d+$/.test(value.slice(split + 1))) return { host: value.slice(0, split), port: Number(value.slice(split + 1)) };
  return { host: value, port: fallbackPort };
}

async function through(proxy: Socks5Target, host: string, port: number) {
  const result = await SocksClient.createConnection({
    command: 'connect', timeout: 30_000,
    proxy: { host: proxy.host, port: proxy.port, type: 5, userId: proxy.username || undefined, password: proxy.password || undefined },
    destination: { host, port },
  });
  return result.socket;
}

/** Start on 127.0.0.1 with an OS-selected port; callers close it with the AVD. */
export async function startSocksHttpBridge(proxy: Socks5Target): Promise<SocksHttpBridge> {
  const sockets = new Set<{ destroy: () => void }>();
  const server = http.createServer((request, response) => {
    void (async () => {
      const hostHeader = String(request.headers.host ?? '');
      const targetUrl = new URL(request.url?.startsWith('http://') ? request.url : `http://${hostHeader}${request.url || '/'}`);
      const port = Number(targetUrl.port || 80);
      const socket = await through(proxy, targetUrl.hostname, port);
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      const headers: http.OutgoingHttpHeaders = { ...request.headers, host: targetUrl.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const outbound = http.request({
        method: request.method, path: `${targetUrl.pathname}${targetUrl.search}`,
        headers, createConnection: () => socket,
      }, (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.statusMessage, incoming.headers);
        incoming.pipe(response);
      });
      outbound.on('error', (error) => { if (!response.headersSent) response.writeHead(502); response.end(error.message); });
      request.pipe(outbound);
    })().catch((error) => { if (!response.headersSent) response.writeHead(502); response.end(error instanceof Error ? error.message : String(error)); });
  });
  server.on('connect', (request, client, head) => {
    void (async () => {
      const target = destination(request.url || '', 443);
      const remote = await through(proxy, target.host, target.port);
      sockets.add(client); sockets.add(remote);
      const clean = () => { sockets.delete(client); sockets.delete(remote); };
      client.once('close', clean); remote.once('close', clean);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) remote.write(head);
      client.pipe(remote); remote.pipe(client);
    })().catch(() => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => { for (const socket of sockets) socket.destroy(); sockets.clear(); server.close(); },
  };
}
