/**
 * apps/octodetect/src/main/probe-server.ts
 *
 * Minimal local HTTP server used by audits. Security properties:
 *   - binds to 127.0.0.1 only, random port;
 *   - only serves the three static probe files from dist/probe;
 *   - results are accepted only with a valid ONE-TIME token (256-bit random),
 *     only from the same origin, max 256 KB, JSON only;
 *   - Host header must be 127.0.0.1:<port> (DNS-rebinding protection);
 *   - the server is stopped when OctoDetect quits.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Logger } from '@octo/core';

const STATIC: Record<string, string> = {
  '/probe.html': 'text/html; charset=utf-8',
  '/probe.js': 'text/javascript; charset=utf-8',
  '/probe.css': 'text/css; charset=utf-8',
};
const MAX_BODY = 256 * 1024;

interface Waiter { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }

export class ProbeServer {
  private server: http.Server | null = null;
  private port = 0;
  private readonly waiters = new Map<string, Waiter>();

  constructor(private readonly probeDir: string, private readonly logger: Logger) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    this.logger.info('probe-server.started');
  }

  stop(): void {
    for (const [token, w] of this.waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('stopped'));
      this.waiters.delete(token);
    }
    this.server?.close();
    this.server = null;
  }

  /** Create a one-time probe URL and a promise for its result. */
  async createProbe(lang: string, timeoutMs: number): Promise<{ url: string; result: Promise<unknown>; cancel: () => void }> {
    await this.start();
    const token = randomBytes(32).toString('hex');
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(token);
        reject(new Error('timeout'));
      }, timeoutMs);
      this.waiters.set(token, { resolve, reject, timer });
    });
    const cancel = () => {
      const w = this.waiters.get(token);
      if (w) { clearTimeout(w.timer); this.waiters.delete(token); w.reject(new Error('cancelled')); }
    };
    return { url: `http://127.0.0.1:${this.port}/probe.html?token=${token}&lang=${encodeURIComponent(lang)}`, result, cancel };
  }

  private send(res: http.ServerResponse, status: number, body: string | Buffer, type = 'text/plain; charset=utf-8'): void {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    });
    res.end(body);
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      const expectedHost = `127.0.0.1:${this.port}`;
      if (req.headers.host !== expectedHost) return this.send(res, 421, 'Misdirected');
      const url = new URL(req.url ?? '/', `http://${expectedHost}`);
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const file = path.join(this.probeDir, path.basename(url.pathname));
        return this.send(res, 200, fs.readFileSync(file), STATIC[url.pathname]);
      }
      if (req.method === 'POST' && url.pathname === '/result') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${expectedHost}`) return this.send(res, 403, 'Forbidden');
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return this.send(res, 415, 'Unsupported');
        const token = url.searchParams.get('token') ?? '';
        const waiter = this.waiters.get(token);
        if (!waiter) return this.send(res, 403, 'Invalid token');
        let size = 0;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) { req.destroy(); return; }
          chunks.push(c);
        });
        req.on('end', () => {
          if (size > MAX_BODY) return;
          this.waiters.delete(token); // one-time
          clearTimeout(waiter.timer);
          try {
            waiter.resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            this.send(res, 204, '');
          } catch (err) {
            waiter.reject(new Error('invalid JSON'));
            this.send(res, 400, 'Bad JSON');
            this.logger.warn('probe-server.bad-json', { error: String(err) });
          }
        });
        return;
      }
      this.send(res, 404, 'Not found');
    } catch (err) {
      this.logger.error('probe-server.error', err);
      this.send(res, 500, 'Error');
    }
  }
}
