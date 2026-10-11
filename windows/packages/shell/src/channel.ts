/**
 * packages/shell/src/channel.ts
 *
 * Private parent<->profile channel. It uses Node's inherited IPC channel,
 * rather than stdout/stdin or an ad-hoc file descriptor. Electron's main
 * process owns this channel before the app bundle loads, so the initial data
 * key message reliably survives Electron startup on supported Windows systems.
 *
 * Only the manager and its spawned profile process hold the OS pipe behind
 * this channel. Keys and messages are never written to the command line,
 * environment, file system, stdout or stderr.
 */
import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export type Message = { t: string; [k: string]: unknown };

export interface MessageChannel {
  onMessage(fn: (m: Message) => void): void;
  onClose(fn: () => void): void;
  readonly isClosed: boolean;
  send(m: Message): void;
}

const MAX_LINE = 4 * 1024 * 1024;
const MAX_PENDING_MESSAGES = 32;

type Handler = (m: Message) => void;

/** Queue startup traffic until the first subscriber is ready to receive it. */
class MessageDispatcher {
  protected handlers: Handler[] = [];
  private pending: Message[] = [];

  onMessage(fn: Handler): void {
    this.handlers.push(fn);
    // Deliver messages received while the process was still wiring the channel
    // to the first subscriber only. Later listeners observe new traffic, as
    // with a normal event emitter.
    if (this.handlers.length === 1) {
      for (const m of this.pending.splice(0)) this.call(fn, m);
    }
  }

  protected deliver(m: Message): void {
    if (this.handlers.length === 0) {
      // The channel is private, but keep an unopened channel bounded anyway.
      if (this.pending.length < MAX_PENDING_MESSAGES) this.pending.push(m);
      return;
    }
    for (const h of this.handlers) this.call(h, m);
  }

  protected call(fn: Handler, m: Message): void {
    try { fn(m); } catch { /* a consumer must not crash the channel process */ }
  }
}

/**
 * stdio configuration for spawn(): the final entry creates Node's private IPC
 * pipe. stdout/stderr stay ignored for profile children so Windows never shows
 * a command prompt behind the browser window.
 */
export function channelStdio(devOutput: boolean): ['ignore', 'inherit' | 'ignore', 'inherit' | 'ignore', 'ipc'] {
  const out = devOutput ? 'inherit' : 'ignore';
  return ['ignore', out, out, 'ipc'];
}

interface IpcPeer {
  connected?: boolean;
  send: (message: Message, callback?: (error: Error | null) => void) => boolean;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  once: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

/** Node's IPC transport used by manager and profile processes. */
export class IpcChannel extends MessageDispatcher implements MessageChannel {
  private closeHandlers: Array<() => void> = [];
  private closed = false;

  constructor(private readonly peer: IpcPeer) {
    super();
    peer.on('message', (raw: unknown) => {
      if (raw && typeof raw === 'object' && typeof (raw as Message).t === 'string') this.deliver(raw as Message);
    });
    peer.once('disconnect', () => this.markClosed());
    // ChildProcess emits an error when it cannot be spawned; process itself
    // normally does not. Listening through this minimal common interface keeps
    // both endpoints safe without exposing any output.
    peer.on('error', () => this.markClosed());
  }

  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.closeHandlers.push(fn);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers.splice(0)) {
      try { h(); } catch { /* handler errors must not escape */ }
    }
  }

  send(m: Message): void {
    if (this.closed || this.peer.connected === false) return;
    try {
      this.peer.send(m, (err) => { if (err) this.markClosed(); });
    } catch {
      this.markClosed();
    }
  }
}

/** Manager side: create the channel after spawn() with `channelStdio()`. */
export function openParentChannel(proc: ChildProcess): IpcChannel {
  if (typeof proc.send !== 'function') throw new Error('profile IPC channel missing');
  return new IpcChannel(proc as unknown as IpcPeer);
}

/** Child side: open the IPC channel inherited from the manager. */
export function openChildChannel(): IpcChannel {
  if (typeof process.send !== 'function') throw new Error('profile IPC channel missing');
  return new IpcChannel(process as unknown as IpcPeer);
}

/**
 * Newline JSON channel retained for small stream-only tools and regression
 * tests. Browser profiles use IpcChannel above because Electron owns it from
 * process creation onward.
 */
export class JsonLineChannel extends MessageDispatcher implements MessageChannel {
  private buf = '';
  private closeHandlers: Array<() => void> = [];
  private closed = false;

  constructor(private readonly input: Readable, private readonly output: Writable) {
    super();
    // A vanished peer (EPIPE/ECONNRESET) must never crash the process.
    input.on('error', () => this.markClosed());
    if (output !== (input as unknown)) output.on('error', () => this.markClosed());
    input.on('end', () => this.markClosed());
    input.on('close', () => this.markClosed());
    input.setEncoding('utf8');
    input.on('data', (chunk: string) => {
      this.buf += chunk;
      if (this.buf.length > MAX_LINE) {
        this.buf = ''; // protocol violation: drop
        return;
      }
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Message;
          if (msg && typeof msg.t === 'string') this.deliver(msg);
        } catch {
          /* ignore malformed lines */
        }
      }
    });
  }

  onClose(fn: () => void): void {
    if (this.closed) fn();
    else this.closeHandlers.push(fn);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const h of this.closeHandlers.splice(0)) {
      try { h(); } catch { /* handler errors must not escape */ }
    }
  }

  send(m: Message): void {
    if (this.closed) return;
    try {
      this.output.write(`${JSON.stringify(m)}\n`);
    } catch {
      /* peer gone */
    }
  }
}
