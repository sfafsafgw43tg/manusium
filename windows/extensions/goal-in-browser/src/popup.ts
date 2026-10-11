import { addHost, isListed, removeHost, siteHost } from './hosts.js';
import { sendToBackground, type StateResponse } from './messages.js';
import { applyPreset, needsSiteAccess, PRESET_LABELS, presetOf, type PresetId, type Settings } from './settings.js';
import { element, errorMessage, PRESET_TEXT, renderReport, summaryText } from './ui.js';

const protection = element<HTMLInputElement>('protection');
const presetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-preset]'));
const presetText = element<HTMLElement>('preset-text');
const presetNote = element<HTMLElement>('preset-note');
const siteName = element<HTMLElement>('site-name');
const siteNote = element<HTMLElement>('site-note');
const siteToggle = element<HTMLButtonElement>('site-toggle');
const summary = element<HTMLElement>('summary');
const report = element<HTMLElement>('report');
const errorBox = element<HTMLElement>('error');

let state: StateResponse | null = null;
let activeHost: string | null = null;

function showError(message: string | null): void {
  errorBox.textContent = message ?? '';
  errorBox.hidden = message === null;
}

async function update(patch: Partial<Settings>): Promise<void> {
  try {
    state = await sendToBackground({ type: 'update', patch });
    showError(null);
    render();
  } catch (error) {
    showError(errorMessage(error));
  }
}

function renderSite(settings: Settings): void {
  if (!activeHost) {
    siteName.textContent = 'No web page open';
    siteNote.textContent = 'Open a web page to allow it.';
    siteToggle.disabled = true;
    return;
  }
  siteName.textContent = activeHost;
  const exact = settings.allowlist.includes(activeHost);
  const parent = exact ? undefined : settings.allowlist.find((entry) => isListed([entry], activeHost ?? ''));
  siteToggle.disabled = parent !== undefined;
  siteToggle.textContent = exact ? 'Remove from allowlist' : 'Allow this site';
  if (exact) {
    siteNote.textContent =
      'Allowlisted: blocking, the HTTPS upgrade and tracking-link cleanup are off here. Privacy headers and Chrome settings still apply.';
  } else if (parent) {
    siteNote.textContent = `Covered by the allowlist entry for ${parent}. Change that entry in Settings.`;
  } else {
    siteNote.textContent = 'Blocking, the HTTPS upgrade and tracking-link cleanup apply to this site.';
  }
}

function render(): void {
  if (!state) return;
  const { settings } = state;
  protection.checked = settings.protectionEnabled;
  const current = presetOf(settings);
  for (const button of presetButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.preset === current));
  }
  presetText.textContent = current === 'custom' ? 'Custom: some options differ from every preset.' : PRESET_TEXT[current];
  renderSite(settings);
  summary.textContent = summaryText(state.report);
  renderReport(report, state.report);
}

protection.addEventListener('change', () => {
  void update({ protectionEnabled: protection.checked });
});

for (const button of presetButtons) {
  button.addEventListener('click', () => {
    if (!state) return;
    const id = button.dataset.preset as PresetId;
    const target = applyPreset(state.settings, id);
    if (needsSiteAccess(target) && !state.siteAccess) {
      // A popup cannot ask for the all-sites permission, so the choice moves to Settings.
      presetNote.textContent = `${PRESET_LABELS[id]} has options that need access to all sites. Settings will ask for it.`;
      presetNote.hidden = false;
      void chrome.runtime.openOptionsPage();
      return;
    }
    presetNote.hidden = true;
    void update(target);
  });
}

siteToggle.addEventListener('click', () => {
  if (!state || !activeHost) return;
  const list = state.settings.allowlist.includes(activeHost)
    ? removeHost(state.settings.allowlist, activeHost)
    : addHost(state.settings.allowlist, activeHost);
  void update({ allowlist: list });
});

element<HTMLButtonElement>('open-options').addEventListener('click', () => {
  void chrome.runtime.openOptionsPage();
});

async function init(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeHost = siteHost(tab?.url);
    state = await sendToBackground({ type: 'state' });
    showError(null);
    render();
  } catch (error) {
    showError(errorMessage(error));
  }
}

void init();
