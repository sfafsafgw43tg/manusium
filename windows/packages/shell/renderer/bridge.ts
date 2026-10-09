/**
 * packages/shell/renderer/bridge.ts
 * Typed access to the preload bridge (window.octo) used by all trusted app UIs.
 */
export interface OctoBridge {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on<T = unknown>(channel: string, cb: (payload: T) => void): () => void;
}

declare global {
  interface Window { octo: OctoBridge }
}

export const api: OctoBridge = window.octo;

/** Format a byte count for display. */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/** Clear all children of an element. */
export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}
