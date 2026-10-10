import type { ItemState, StatusItem } from './apply.js';
import type { PresetId } from './settings.js';

/** What each preset does, in one sentence. Shown under the preset buttons. */
export const PRESET_TEXT: Readonly<Record<PresetId, string>> = {
  standard:
    "Blocks ads, trackers, fingerprinting scripts and malware domains, upgrades to HTTPS, and turns off Chrome's ad APIs, link auditing and the error-page web service.",
  strict:
    'Standard, plus tracking-link cleanup, the Global Privacy Control header, a referrer limit, and fewer Chrome web services. Needs access to all sites.',
  ultra:
    'Strict, plus blocks third-party scripts and frames, clears site data at each browser start, and disables non-proxied WebRTC UDP. Many sites will not work.',
};

const STATE_TEXT: Readonly<Record<ItemState, string>> = {
  on: 'On',
  partial: 'Partly on',
  off: 'Off',
  skipped: 'Skipped',
  error: 'Error',
};

export function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`The page is missing #${id}`);
  return node as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong';
}

/** Renders the status report as a list. Text only, so nothing from a page or list can inject markup. */
export function renderReport(list: HTMLElement, items: readonly StatusItem[]): void {
  list.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      li.className = `item ${item.state}`;
      const top = document.createElement('div');
      top.className = 'item-top';
      const label = document.createElement('span');
      label.textContent = item.label;
      const state = document.createElement('span');
      state.className = 'state';
      state.textContent = STATE_TEXT[item.state];
      top.append(label, state);
      const detail = document.createElement('div');
      detail.className = 'detail';
      detail.textContent = item.detail;
      li.append(top, detail);
      return li;
    }),
  );
}

export function summaryText(items: readonly StatusItem[]): string {
  const on = items.filter((item) => item.state === 'on').length;
  const off = items.filter((item) => item.state === 'off').length;
  const attention = items.filter((item) => item.state === 'error' || item.state === 'skipped' || item.state === 'partial').length;
  const parts = [`${on} on`, `${off} off`];
  if (attention > 0) parts.push(`${attention} need attention`);
  return parts.join(', ');
}
