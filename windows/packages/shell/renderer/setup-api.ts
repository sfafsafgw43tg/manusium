/** packages/shell/renderer/setup-api.ts - typed access to window.octoSetup (preload-setup). */
declare global {
  interface Window { octoSetup: { invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> } }
}
export const invoke = <T = unknown>(channel: string, ...args: unknown[]): Promise<T> => window.octoSetup.invoke<T>(channel, ...args);
export const appParam = (): 'octobrowser' | 'octodetect' =>
  new URLSearchParams(location.search).get('app') === 'octodetect' ? 'octodetect' : 'octobrowser';
