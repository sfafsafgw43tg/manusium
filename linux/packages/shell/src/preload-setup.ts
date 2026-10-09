/**
 * packages/shell/src/preload-setup.ts
 *
 * Preload for the small utility windows (first-run wizard, splash).
 * Exposes a minimal, fixed API through contextBridge - no ipcRenderer, no Node.
 */
import { contextBridge, ipcRenderer } from 'electron';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

const ALLOWED = new Set([
  'setup:init', 'setup:browse', 'setup:validate', 'setup:finish', 'setup:quit',
]);

contextBridge.exposeInMainWorld('octoSetup', {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!ALLOWED.has(channel)) return Promise.reject(new Error('channel not allowed'));
    return call(channel, ...args);
  },
});
