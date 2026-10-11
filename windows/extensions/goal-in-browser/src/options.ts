import { removeSiteAccess, requestSiteAccess } from './access.js';
import { addHost, parseDomainList, removeHost } from './hosts.js';
import { LIST_INFO } from './lists-info.js';
import { sendToBackground, type StateResponse } from './messages.js';
import {
  applyPreset,
  DEFAULT_SETTINGS,
  LIMITS,
  needsSiteAccess,
  PRESET_LABELS,
  presetOf,
  type PresetId,
  type Settings,
} from './settings.js';
import { element, errorMessage, PRESET_TEXT, renderReport, summaryText } from './ui.js';

const statusLine = element<HTMLElement>('status');
const presetButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-preset]'));
const presetText = element<HTMLElement>('preset-text');
const presetNote = element<HTMLElement>('preset-note');
const summary = element<HTMLElement>('summary');
const report = element<HTMLElement>('report');
const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-setting]'));
const accessStatus = element<HTMLElement>('access-status');
const accessRemove = element<HTMLButtonElement>('access-remove');
const allowInput = element<HTMLInputElement>('allow-input');
const allowAdd = element<HTMLButtonElement>('allow-add');
const allowList = element<HTMLUListElement>('allow-list');
const customText = element<HTMLTextAreaElement>('custom-text');
const customSave = element<HTMLButtonElement>('custom-save');
const listsBox = element<HTMLUListElement>('lists');
const reset = element<HTMLButtonElement>('reset');
const versionText = element<HTMLElement>('version');

let state: StateResponse | null = null;

function notify(message: string, isError = false): void {
  statusLine.textContent = message;
  statusLine.className = isError ? 'status error' : 'status ok';
}

function render(): void {
  if (!state) return;
  const { settings } = state;
  for (const control of controls) {
    const key = control.dataset.setting as keyof Settings;
    if (control instanceof HTMLInputElement) control.checked = settings[key] === true;
    else control.value = String(settings[key]);
  }
  const current = presetOf(settings);
  for (const button of presetButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.preset === current));
  }
  presetText.textContent = current === 'custom' ? 'Custom: the options below differ from every preset.' : PRESET_TEXT[current];
  renderAccess(settings);
  renderAllowlist(settings.allowlist);
  summary.textContent = summaryText(state.report);
  renderReport(report, state.report);
}

function renderAccess(settings: Settings): void {
  const needed = needsSiteAccess(settings);
  if (state?.siteAccess) {
    accessStatus.textContent = needed
      ? 'Granted. It is used by the options selected above.'
      : 'Granted, but no selected option uses it. You can remove it.';
  } else {
    accessStatus.textContent = needed
      ? 'Not granted. The options that need it stay off until you allow it.'
      : 'Not granted. No selected option needs it.';
  }
  accessRemove.disabled = !state?.siteAccess || needed;
}

function renderAllowlist(list: readonly string[]): void {
  const rows = list.map((host) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = host;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      if (state) void save({ allowlist: removeHost(state.settings.allowlist, host) }, `${host} removed from the allowlist.`);
    });
    li.append(name, remove);
    return li;
  });
  if (rows.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'muted';
    empty.textContent = 'No sites are allowlisted.';
    rows.push(empty);
  }
  allowList.replaceChildren(...rows);
}

/** Saves a patch and shows the result. On failure, the controls go back to the last saved state. */
async function save(patch: Partial<Settings>, message: string): Promise<boolean> {
  try {
    state = await sendToBackground({ type: 'update', patch });
    render();
    notify(message);
    return true;
  } catch (error) {
    notify(errorMessage(error), true);
    render();
    return false;
  }
}

/** Removes the all-sites permission once no selected option needs it. Protection itself does not need it. */
async function dropUnusedAccess(): Promise<void> {
  if (!state?.siteAccess || needsSiteAccess(state.settings)) return;
  try {
    await removeSiteAccess();
    state = await sendToBackground({ type: 'state' });
    render();
  } catch (error) {
    notify(errorMessage(error), true);
  }
}

async function onControlChange(control: HTMLInputElement | HTMLSelectElement): Promise<void> {
  if (!state) return;
  const key = control.dataset.setting as keyof Settings;
  const value = control instanceof HTMLInputElement ? control.checked : control.value;
  const next = { ...state.settings, [key]: value } as Settings;
  if (needsSiteAccess(next) && !state.siteAccess) {
    // Called before any await, so Chrome sees it as a click or change from the user.
    const granted = await requestSiteAccess();
    if (!granted) {
      notify('Access to all sites was not granted, so that option stays off.', true);
      render();
      return;
    }
  }
  if (await save(next, 'Saved.')) await dropUnusedAccess();
}

async function choosePreset(id: PresetId): Promise<void> {
  if (!state) return;
  let target = applyPreset(state.settings, id);
  presetNote.hidden = true;
  if (needsSiteAccess(target) && !state.siteAccess) {
    // Called before any await, so Chrome sees it as a click from the user.
    const granted = await requestSiteAccess();
    if (!granted) {
      target = {
        ...target,
        globalPrivacyControl: false,
        stripTrackingParams: false,
        referrerPolicy: target.referrerPolicy === 'origin' ? 'default' : target.referrerPolicy,
      };
      presetNote.textContent = `Access to all sites was not granted, so the options that need it stay off. ${PRESET_LABELS[id]} is applied without them.`;
      presetNote.hidden = false;
    }
  }
  const message = presetNote.hidden ? `${PRESET_LABELS[id]} applied.` : `${PRESET_LABELS[id]} applied without the options that need access.`;
  if (await save(target, message)) await dropUnusedAccess();
}

for (const control of controls) {
  control.addEventListener('change', () => {
    void onControlChange(control);
  });
}

for (const button of presetButtons) {
  button.addEventListener('click', () => {
    void choosePreset(button.dataset.preset as PresetId);
  });
}

accessRemove.addEventListener('click', () => {
  void dropUnusedAccess();
});

allowAdd.addEventListener('click', () => {
  if (!state) return;
  const { valid, invalid } = parseDomainList(allowInput.value);
  if (invalid.length > 0) {
    notify(`Not a valid domain: ${invalid.join(', ')}`, true);
    return;
  }
  if (valid.length === 0) return;
  const list = valid.reduce((all, host) => addHost(all, host), state.settings.allowlist);
  if (list.length > LIMITS.allowlist) {
    notify(`The allowlist holds up to ${LIMITS.allowlist} sites.`, true);
    return;
  }
  void save({ allowlist: list }, `Added ${valid.join(', ')} to the allowlist.`).then((saved) => {
    if (saved) allowInput.value = '';
  });
});

customSave.addEventListener('click', () => {
  const { valid, invalid } = parseDomainList(customText.value);
  if (invalid.length > 0) {
    notify(`Not a valid domain: ${invalid.join(', ')}`, true);
    return;
  }
  if (valid.length > LIMITS.customBlocklist) {
    notify(`The custom list holds up to ${LIMITS.customBlocklist} domains.`, true);
    return;
  }
  void save({ customBlocklist: valid }, `Custom list saved (${valid.length} domains).`).then((saved) => {
    if (saved) customText.value = valid.join('\n');
  });
});

reset.addEventListener('click', () => {
  if (!window.confirm('Reset every option to Standard, clear the allowlist and custom list, and remove access to all sites?')) return;
  void save({ ...DEFAULT_SETTINGS, allowlist: [], customBlocklist: [] }, 'Reset to Standard.').then(async (saved) => {
    if (!saved) return;
    customText.value = '';
    await dropUnusedAccess();
  });
});

function renderLists(): void {
  const { upstream } = LIST_INFO;
  const adRulesets = LIST_INFO.adRulesets.length;
  const lines = [
    `Ads and malware: ${LIST_INFO.adDomains.toLocaleString('en-US')} domains in ${adRulesets} rulesets, from ${upstream.repo} at commit ${upstream.commit.slice(0, 7)} (${upstream.license} licence). Source: ${upstream.homepage}`,
    `Trackers: ${LIST_INFO.trackerRules} curated rules. Fingerprinting scripts: ${LIST_INFO.fingerprintRules} curated rules. Both ship with this extension.`,
    'Lists are never downloaded while the extension runs. They change only when you install a newer build. The build pins the upstream file by commit and checksum.',
  ];
  listsBox.replaceChildren(
    ...lines.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );
}

async function init(): Promise<void> {
  renderLists();
  versionText.textContent = `Version ${chrome.runtime.getManifest().version}`;
  try {
    state = await sendToBackground({ type: 'state' });
    customText.value = state.settings.customBlocklist.join('\n');
    render();
  } catch (error) {
    notify(errorMessage(error), true);
  }
}

void init();
