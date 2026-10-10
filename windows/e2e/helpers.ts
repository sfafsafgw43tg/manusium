/**
 * e2e/helpers.ts - shared helpers for the Electron end-to-end tests.
 *
 * Every test run uses a fresh throw-away data folder through the app's
 * ephemeral mode (--ephemeral-data-dir, the same mode Windows Sandbox
 * sessions use): no bootstrap.json is written, the user's real data is never
 * touched and the first-run wizard is skipped. --allow-elevated is needed
 * because CI runners run as Administrator (the apps refuse that by default).
 */
import { _electron as electron, ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const ROOT = path.resolve(__dirname, '..');

export interface Launched {
  app: ElectronApplication;
  dataDir: string;
}

/** Start one app unpackaged with an ephemeral data folder (path contains a space and Polish letters). */
export async function launchApp(appId: 'octobrowser' | 'octodetect', lang: 'en' | 'pl' = 'en'): Promise<Launched> {
  const appDir = path.join(ROOT, 'apps', appId);
  if (!fs.existsSync(path.join(appDir, 'dist', 'main.js'))) throw new Error(`Build first: npm run build (${appId})`);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'Octo E2E zażółć-'));
  const app = await electron.launch({
    args: [appDir, `--ephemeral-data-dir=${dataDir}`, `--lang-choice=${lang}`, '--allow-elevated'],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
    timeout: 120_000,
  });
  // Mirror the app's own console output into the test log so CI failures are diagnosable.
  const proc = app.process();
  proc.stdout?.on('data', (d: Buffer) => process.stdout.write(`[${appId}] ${d.toString()}`));
  proc.stderr?.on('data', (d: Buffer) => process.stdout.write(`[${appId}:err] ${d.toString()}`));
  return { app, dataDir };
}

/** Wait for a window whose URL ends with the requested application page. */
export async function windowWithPage(app: ElectronApplication, page: string, timeoutMs = 90_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      if (w.url().includes(page)) {
        await w.waitForLoadState('domcontentloaded');
        return w;
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Window ${page} did not appear; open: ${app.windows().map((w) => w.url()).join(', ')}`);
}

/** Call the preload bridge (window.octo.invoke) of a trusted window. */
export function invoke<T>(page: Page, channel: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    ([c, a]) => (window as unknown as { octo: { invoke: (ch: string, ...x: unknown[]) => Promise<unknown> } }).octo.invoke(c as string, ...(a as unknown[])),
    [channel, args] as const,
  ) as Promise<T>;
}

/** Poll until fn() returns a truthy value. */
export async function waitFor<T>(fn: () => Promise<T | null | undefined | false | 0 | ''>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

/**
 * Close the app and remove its data folder (best effort - files may still be locked briefly).
 * If the app does not exit within 20 s (e.g. a child process shows a modal error box),
 * the whole process tree is terminated so one broken test cannot stall the suite.
 */
export async function closeApp(l: Launched): Promise<void> {
  const pid = l.app.process().pid;
  const closed = await Promise.race([
    l.app.close().then(() => true, () => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 20_000)),
  ]);
  if (!closed && pid) {
    process.stdout.write(`[e2e] app ${pid} did not exit within 20 s - terminating its process tree\n`);
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(l.dataDir, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
}

/** All files below a folder (relative paths). */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** Tail of every app log below the data folder - printed when a test fails. */
export function dumpLogs(dataDir: string, maxLines = 150): string {
  const out: string[] = [];
  for (const f of listFiles(dataDir).filter((x) => /[\\/]logs[\\/].*\.log$/.test(x))) {
    try {
      const lines = fs.readFileSync(path.join(dataDir, f), 'utf8').split(/\r?\n/);
      out.push(`----- ${f} -----`, ...lines.slice(-maxLines));
    } catch (err) {
      out.push(`----- ${f}: ${String(err)}`);
    }
  }
  return out.length ? out.join('\n') : '(no log files)';
}
