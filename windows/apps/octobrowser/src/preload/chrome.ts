/**
 * apps/octobrowser/src/preload/chrome.ts
 *
 * Preload of the TRUSTED browser chrome UI (address bar, tabs, panels).
 * Exposes invoke/on for the "ui:" channel namespace only. The main process
 * additionally verifies the sender (trusted WebContents + local file URL).
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// Keep this fixed allow-list in sync with browser.ts (and save-card.ts,
// which shares this preload as its own floating window). `ui:close-request` drives
// the trusted close-confirmation overlay rather than being exposed to web tabs.
const EVENTS = new Set(['ui:state', 'ui:tab', 'ui:toast', 'ui:command', 'ui:found', 'ui:focus-address', 'ui:close-request', 'ui:permission', 'ui:confirm-download', 'ui:download', 'ui:save-card', 'ui:release-media-preview']);

contextBridge.exposeInMainWorld('octo', {
  invoke: async (channel: string, ...args: unknown[]) => {
    if (!channel.startsWith('ui:')) throw new Error('channel not allowed');
    const r = (await ipcRenderer.invoke(channel, ...args)) as Result<unknown>;
    if (!r.ok) throw new Error(r.error);
    return r.value;
  },
  on: (channel: string, cb: (payload: unknown) => void) => {
    if (!EVENTS.has(channel)) throw new Error('event not allowed');
    const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
