/**
 * packages/shell/src/ipc.ts
 *
 * Safe IPC registration. Every handler:
 *   - verifies the sender is one of OUR UI pages (file:// inside the app dist
 *     folder), never a web page loaded in a tab;
 *   - catches errors and returns { ok:false, error } instead of crashing;
 *   - never returns stack traces or secrets to the renderer.
 */
import { ipcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@octo/core';

export type IpcResult<T> = { ok: true; value: T } | { ok: false, error: string };

let trustedRoot = '';
const trustedContents = new Set<number>();

/** Set the folder that contains trusted UI files (dist/). */
export function setTrustedRoot(dir: string): void {
  trustedRoot = path.resolve(dir).toLowerCase();
}

/** Explicitly trust a UI WebContents (chrome UI, wizard, splash). */
export function trustWebContents(wc: WebContents): void {
  trustedContents.add(wc.id);
  wc.once('destroyed', () => trustedContents.delete(wc.id));
}

export function isTrustedSender(e: IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  if (!trustedContents.has(e.sender.id)) return false;
  const url = e.senderFrame?.url ?? '';
  if (!url.startsWith('file:')) return false;
  try {
    const p = path.resolve(fileURLToPath(url)).toLowerCase();
    return !!trustedRoot && p.startsWith(trustedRoot);
  } catch {
    return false;
  }
}

/** Register an invoke handler with sender validation and error wrapping. */
export function handle<A extends unknown[], R>(
  channel: string,
  logger: Logger,
  fn: (e: IpcMainInvokeEvent, ...args: A) => R | Promise<R>,
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (e, ...args): Promise<IpcResult<R>> => {
    if (!isTrustedSender(e)) {
      logger.warn('ipc.rejected', { channel });
      return { ok: false, error: 'forbidden' };
    }
    try {
      return { ok: true, value: await fn(e, ...(args as A)) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`ipc.${channel}`, { message: msg });
      return { ok: false, error: msg };
    }
  });
}
