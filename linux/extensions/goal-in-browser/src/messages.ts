import type { StatusItem } from './apply.js';
import type { Settings } from './settings.js';

/** What the background service worker returns for every state or update request. */
export interface StateResponse {
  settings: Settings;
  report: StatusItem[];
  /** Whether the optional all-sites permission is granted right now. */
  siteAccess: boolean;
}

/** Sends a request to the background service worker. Rejects on any error. */
export function sendToBackground(message: unknown): Promise<StateResponse> {
  return new Promise<StateResponse>((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: unknown) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message ?? 'The extension did not respond'));
        return;
      }
      const body = response as (Partial<StateResponse> & { error?: string }) | undefined;
      if (!body) {
        reject(new Error('The extension did not respond'));
        return;
      }
      if (body.error) {
        reject(new Error(body.error));
        return;
      }
      resolve(body as StateResponse);
    });
  });
}
