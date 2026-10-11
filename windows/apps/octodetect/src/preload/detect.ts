/**
 * apps/octodetect/src/preload/detect.ts
 *
 * Preload of the trusted OctoDetect main window. Exposes the "od:" channel
 * namespace only; the main process re-validates the sender.
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };
const EVENTS = new Set(['od:progress', 'od:update-status']);

contextBridge.exposeInMainWorld('octo', {
  invoke: async (channel: string, ...args: unknown[]) => {
    if (!channel.startsWith('od:')) throw new Error('channel not allowed');
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
