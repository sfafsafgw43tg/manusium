import { spawn, ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { ENGINE_RUNNER_CONTRACT_VERSION, type EngineTabState } from './engine-runtime';

export type NativeEngineKind = 'chromium' | 'firefox';

export interface NativeEngineOptions {
  profileDir: string;
  url?: string;
  debugPort?: number;
  headless?: boolean;
  appMode?: boolean;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface NativeEngineProcess {
  contractVersion: typeof ENGINE_RUNNER_CONTRACT_VERSION;
  kind: NativeEngineKind;
  executable: string;
  profileDir: string;
  child: ChildProcess;
  stop: (timeoutMs?: number) => Promise<void>;
}

export interface NativePageState {
  url: string;
  title: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message?: string };
}

interface CdpTarget {
  id: string;
  type: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

function requireAbsoluteDirectory(dir: string): string {
  if (!path.isAbsolute(dir)) throw new Error('Native engine profile directory must be absolute');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir mode is ignored when the directory already exists. Re-assert the
  // owner-only boundary on every launch instead of trusting inherited modes.
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  return dir;
}

function safeExtraArgs(extraArgs: string[] | undefined): string[] {
  const blocked = /^(--remote-debugging-(address|host|port)|--remote-allow-origins)(?:=|$)/i;
  for (const arg of extraArgs ?? []) {
    if (blocked.test(arg)) throw new Error('Native engine debug endpoint flags are controlled by the launcher');
  }
  return extraArgs ?? [];
}

/** Build only documented, isolated arguments; callers may add engine-specific flags explicitly. */
export function nativeEngineArgs(kind: NativeEngineKind, options: NativeEngineOptions): string[] {
  const profileDir = requireAbsoluteDirectory(options.profileDir);
  const url = options.url ?? 'about:blank';
  const args: string[] = [];
  if (kind === 'chromium') {
    args.push(`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-sync');
    if (options.headless) args.push('--headless=new');
    if (options.appMode) args.push(`--app=${url}`);
    if (options.debugPort !== undefined) {
      if (!Number.isInteger(options.debugPort) || options.debugPort < 1 || options.debugPort > 65535) throw new Error('Invalid native engine debug port');
      args.push('--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${options.debugPort}`, `--remote-allow-origins=http://127.0.0.1:${options.debugPort}`);
    }
  } else {
    args.push('-profile', profileDir, '-no-remote');
    if (options.headless) args.push('--headless');
    if (options.appMode) args.push('--kiosk');
    if (options.debugPort !== undefined) {
      if (!Number.isInteger(options.debugPort) || options.debugPort < 1 || options.debugPort > 65535) throw new Error('Invalid native engine debug port');
      args.push('--remote-debugging-port', String(options.debugPort));
    }
  }
  return kind === 'chromium' && options.appMode
    ? [...args, ...safeExtraArgs(options.extraArgs)]
    : [...args, ...safeExtraArgs(options.extraArgs), url];
}

function waitForPort(port: number, timeoutMs: number, child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(timeout);
      child.off('exit', onExit);
      error ? reject(error) : resolve();
    };
    const probe = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); finish(); });
      socket.once('error', () => socket.destroy());
      if (Date.now() - started >= timeoutMs) finish(new Error(`Native engine did not open debug port ${port}`));
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`Native engine exited before readiness (${code ?? signal ?? 'unknown'})`));
    const timer = setInterval(probe, 50);
    const timeout = setTimeout(() => finish(new Error(`Native engine readiness timed out after ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', onExit);
    probe();
  });
}

function stopChild(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    let settled = false;
    const finish = () => { if (settled) return; settled = true; resolve(); };
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    const timer = setTimeout(() => {
      kill('SIGKILL');
      const finalTimer = setTimeout(finish, 1000);
      child.once('exit', () => { clearTimeout(finalTimer); finish(); });
    }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); finish(); });
    kill('SIGTERM');
  });
}

/** Spawn a real Chromium or Gecko process and optionally wait for its DevTools/BiDi port. */
export async function spawnNativeEngine(kind: NativeEngineKind, executable: string, options: NativeEngineOptions): Promise<NativeEngineProcess> {
  if (!path.isAbsolute(executable)) throw new Error('Native engine executable must be an absolute path');
  if (!fs.existsSync(executable)) throw new Error(`Native engine executable not found: ${executable}`);
  const profileDir = requireAbsoluteDirectory(options.profileDir);
  const child = spawn(executable, nativeEngineArgs(kind, { ...options, profileDir }), {
    detached: true,
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ...options.env },
  });
  const earlyError = new Promise<never>((_, reject) => child.once('error', reject));
  try {
    if (options.debugPort !== undefined) await Promise.race([waitForPort(options.debugPort, 15_000, child), earlyError]);
    return { contractVersion: ENGINE_RUNNER_CONTRACT_VERSION, kind, executable, profileDir, child, stop: (timeoutMs?: number) => stopChild(child, timeoutMs) };
  } catch (error) {
    await stopChild(child, 1000);
    throw error;
  }
}

function targetUrl(port: number): string { return `http://127.0.0.1:${port}/json/list`; }

async function waitForTarget(port: number, timeoutMs: number): Promise<CdpTarget> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(targetUrl(port));
      if (response.ok) {
        const targets = await response.json() as CdpTarget[];
        const target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
        if (target) return target;
      }
    } catch { /* Chromium is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Chromium did not expose a page target on DevTools port ${port}`);
}

/** A small CDP client for one Chromium page. It deliberately exposes only the vertical-slice operations. */
export class CdpPage {
  readonly targetId: string;
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: CdpMessage) => void; reject: (error: Error) => void }>();
  private readonly events = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private closed = false;

  private constructor(socket: WebSocket, targetId: string) {
    this.targetId = targetId;
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message ?? 'CDP command failed'));
        else request.resolve(message);
      } else if (message.method) {
        for (const listener of this.events.get(message.method) ?? []) listener(message.params ?? {});
      }
    });
    socket.addEventListener('close', () => this.fail(new Error('Chromium CDP connection closed')));
    socket.addEventListener('error', () => this.fail(new Error('Chromium CDP connection failed')));
  }

  static async connect(port: number, timeoutMs = 15_000): Promise<CdpPage> {
    const target = await waitForTarget(port, timeoutMs);
    return CdpPage.connectTarget(target, timeoutMs);
  }

  static async connectTarget(target: CdpTarget, timeoutMs = 15_000): Promise<CdpPage> {
    if (!target.webSocketDebuggerUrl) throw new Error('Chromium page target has no websocket URL');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Chromium CDP')), timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to Chromium CDP')); }, { once: true });
    });
    const page = new CdpPage(socket, target.id);
    await page.command('Page.enable');
    await page.command('Runtime.enable');
    return page;
  }

  private fail(error: Error): void {
    if (this.closed) return;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    const listeners = this.events.get(method) ?? new Set();
    listeners.add(listener);
    this.events.set(method, listeners);
    return () => listeners.delete(listener);
  }

  command(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    if (this.closed) return Promise.reject(new Error('CDP page is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async navigate(url: string): Promise<void> {
    if (!/^(https?|about|data):/i.test(url)) throw new Error('Native Chromium navigation requires an http(s), about, or data URL');
    await this.command('Page.navigate', { url });
  }

  async state(): Promise<NativePageState> {
    const result = await this.command('Runtime.evaluate', { expression: 'JSON.stringify({url: location.href, title: document.title})', returnByValue: true });
    const value = result.result?.result as { value?: string } | undefined;
    return JSON.parse(value?.value ?? '{"url":"","title":""}') as NativePageState;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.close(); } catch { /* already closed */ }
  }
}

function tabState(target: CdpTarget): EngineTabState {
  return { id: target.id, url: target.url ?? 'about:blank', title: target.title ?? '', loading: false, crashed: false };
}

async function chromiumTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(targetUrl(port));
  if (!response.ok) throw new Error(`Chromium tab listing failed with HTTP ${response.status}`);
  const targets = await response.json() as CdpTarget[];
  return targets.filter((target) => target.type === 'page' && Boolean(target.id));
}

async function chromiumTarget(port: number, id: string): Promise<CdpTarget> {
  const target = (await chromiumTargets(port)).find((entry) => entry.id === id);
  if (!target) throw new Error(`Chromium tab not found: ${id}`);
  return target;
}

/** Contract-backed tab control for a visible native Chromium window. */
export class NativeChromiumTabs {
  readonly contractVersion = ENGINE_RUNNER_CONTRACT_VERSION;
  private readonly pages = new Map<string, CdpPage>();
  private activeId: string | undefined;

  private constructor(private readonly port: number) {}

  static async connect(port: number): Promise<NativeChromiumTabs> {
    const controller = new NativeChromiumTabs(port);
    const first = (await chromiumTargets(port))[0];
    if (!first) throw new Error('Chromium exposed no page tab');
    controller.pages.set(first.id, await CdpPage.connectTarget(first));
    controller.activeId = first.id;
    return controller;
  }

  async tabs(): Promise<EngineTabState[]> {
    const targets = await chromiumTargets(this.port);
    const ids = new Set(targets.map((target) => target.id));
    for (const [id, page] of this.pages) if (!ids.has(id)) { await page.close(); this.pages.delete(id); }
    if (!this.activeId || !ids.has(this.activeId)) this.activeId = targets[0]?.id;
    return targets.map(tabState);
  }

  private async pageFor(id: string): Promise<CdpPage> {
    const existing = this.pages.get(id);
    if (existing) return existing;
    const page = await CdpPage.connectTarget(await chromiumTarget(this.port, id));
    this.pages.set(id, page);
    return page;
  }

  async newTab(url = 'about:blank', activate = true): Promise<EngineTabState> {
    if (!/^(https?|about|data):/i.test(url)) throw new Error('Native Chromium tab URLs require http(s), about, or data URLs');
    const response = await fetch(`http://127.0.0.1:${this.port}/json/new?${new URLSearchParams({ url }).toString()}`, { method: 'PUT' });
    if (!response.ok) throw new Error(`Chromium could not create a tab (HTTP ${response.status})`);
    const target = await response.json() as CdpTarget;
    if (!target.id) throw new Error('Chromium returned a tab without an id');
    this.pages.set(target.id, await CdpPage.connectTarget(target));
    if (activate) await this.activateTab(target.id);
    return tabState(target);
  }

  async activateTab(id: string): Promise<void> {
    await chromiumTarget(this.port, id);
    const response = await fetch(`http://127.0.0.1:${this.port}/json/activate/${encodeURIComponent(id)}`, { method: 'PUT' });
    if (!response.ok) throw new Error(`Chromium could not activate tab ${id} (HTTP ${response.status})`);
    this.activeId = id;
  }

  async closeTab(id: string): Promise<void> {
    await chromiumTarget(this.port, id);
    const response = await fetch(`http://127.0.0.1:${this.port}/json/close/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`Chromium could not close tab ${id} (HTTP ${response.status})`);
    const page = this.pages.get(id);
    if (page) await page.close();
    this.pages.delete(id);
    const started = Date.now();
    while (Date.now() - started < 5_000) {
      const remaining = await chromiumTargets(this.port);
      if (!remaining.some((target) => target.id === id)) {
        if (this.activeId === id) this.activeId = remaining[0]?.id;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Chromium did not close tab ${id}`);
  }

  async navigate(id: string, url: string): Promise<void> {
    if (!/^(https?|about|data):/i.test(url)) throw new Error('Native Chromium navigation requires an http(s), about, or data URL');
    await (await this.pageFor(id)).navigate(url);
  }

  async activeTab(): Promise<EngineTabState> {
    const tabs = await this.tabs();
    const active = tabs.find((tab) => tab.id === this.activeId) ?? tabs[0];
    if (!active) throw new Error('Chromium has no active tab');
    return active;
  }

  async activeState(): Promise<NativePageState> {
    const active = await this.activeTab();
    return this.state(active.id);
  }

  async state(id: string): Promise<NativePageState> { return (await this.pageFor(id)).state(); }

  async close(): Promise<void> { for (const page of this.pages.values()) await page.close(); this.pages.clear(); }
}

interface BidiMessage { id: number; type: string; result?: Record<string, unknown>; error?: string; message?: string }

/** Real Firefox tab/window control through the loopback WebDriver BiDi endpoint. */
export class FirefoxBidi {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (message: BidiMessage) => void; reject: (error: Error) => void }>();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as BidiMessage;
      if (typeof message.id !== 'number') return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      message.type === 'error' ? request.reject(new Error(message.message ?? message.error ?? 'Firefox BiDi command failed')) : request.resolve(message);
    });
  }

  static async connect(port: number, timeoutMs = 15_000): Promise<FirefoxBidi> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting to Firefox WebDriver BiDi')), timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to Firefox WebDriver BiDi')); }, { once: true });
    });
    const client = new FirefoxBidi(socket);
    await client.command('session.new', { capabilities: {} });
    return client;
  }

  command(method: string, params: Record<string, unknown>): Promise<BidiMessage> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async contexts(): Promise<string[]> {
    const result = await this.command('browsingContext.getTree', {});
    const contexts = (result.result?.contexts ?? []) as Array<{ context: string }>;
    return contexts.map((context) => context.context);
  }

  async navigate(context: string, url: string): Promise<void> {
    if (!/^(https?|about|data):/i.test(url)) throw new Error('Firefox navigation requires an http(s), about, or data URL');
    await this.command('browsingContext.navigate', { context, url, wait: 'complete' });
  }

  async newTab(url = 'about:blank'): Promise<string> {
    const result = await this.command('browsingContext.create', { type: 'tab' });
    const context = String((result.result as { context?: string } | undefined)?.context ?? '');
    if (!context) throw new Error('Firefox did not return a new browsing context');
    if (url !== 'about:blank') await this.navigate(context, url);
    return context;
  }

  async closeTab(context: string): Promise<void> { await this.command('browsingContext.close', { context }); }
  async close(): Promise<void> { try { this.socket.close(); } catch { /* already closed */ } }
}
