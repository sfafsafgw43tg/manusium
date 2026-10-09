import { applyAll, type ApplyResult, type StatusItem } from './apply.js';
import { siteAccessGranted } from './access.js';
import { invoke } from './chrome-call.js';
import type { StateResponse } from './messages.js';
import { isPrivacyKey, type PrivacyKey } from './privacy.js';
import { sanitizeSettings, type Settings } from './settings.js';

/** Storage keys. Everything lives in chrome.storage.local, on this device only. */
const KEYS = { settings: 'settings', managed: 'managed', report: 'report' } as const;

/** Site data removed at browser start when "clear site data" is on. History, passwords and downloads are not included. */
const CLEAR_TYPES = {
  cache: true,
  cacheStorage: true,
  cookies: true,
  fileSystems: true,
  indexedDB: true,
  localStorage: true,
  serviceWorkers: true,
} as const;

interface Stored {
  settings: Settings;
  managed: PrivacyKey[];
  report: StatusItem[];
}

/** The only requests accepted, and only from this extension's own pages. */
type Request = { type: 'state' } | { type: 'update'; patch: unknown };

function parseRequest(message: unknown): Request | null {
  if (!message || typeof message !== 'object') return null;
  const type = (message as { type?: unknown }).type;
  if (type === 'state') return { type: 'state' };
  if (type === 'update') return { type: 'update', patch: (message as { patch?: unknown }).patch };
  return null;
}

async function readStored(): Promise<Stored> {
  const data = await invoke<Record<string, unknown>>((done) =>
    chrome.storage.local.get([KEYS.settings, KEYS.managed, KEYS.report], done),
  );
  const rawManaged = data[KEYS.managed];
  const rawReport = data[KEYS.report];
  return {
    settings: sanitizeSettings(data[KEYS.settings]),
    managed: Array.isArray(rawManaged) ? rawManaged.filter(isPrivacyKey) : [],
    report: Array.isArray(rawReport) ? (rawReport as StatusItem[]) : [],
  };
}

async function writeStored(values: Record<string, unknown>): Promise<void> {
  await invoke<void>((done) => chrome.storage.local.set(values, () => done()));
}

async function applyStored(settings: Settings, managed: PrivacyKey[]): Promise<ApplyResult> {
  const result = await applyAll(settings, managed, await siteAccessGranted());
  await writeStored({ [KEYS.managed]: result.managed, [KEYS.report]: result.report });
  return result;
}

/** Serializes every read-modify-write, so two messages can never interleave. */
let queue: Promise<unknown> = Promise.resolve();

function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function state(): Promise<StateResponse> {
  const stored = await readStored();
  return { settings: stored.settings, report: stored.report, siteAccess: await siteAccessGranted() };
}

async function update(patch: unknown): Promise<StateResponse> {
  const stored = await readStored();
  const incoming = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {};
  const settings = sanitizeSettings({ ...stored.settings, ...incoming });
  await writeStored({ [KEYS.settings]: settings });
  const result = await applyStored(settings, stored.managed);
  return { settings, report: result.report, siteAccess: await siteAccessGranted() };
}

/** Re-applies the stored settings. Runs on install, on browser start, and when site access changes. */
async function refresh(): Promise<void> {
  const stored = await readStored();
  await writeStored({ [KEYS.settings]: stored.settings });
  await applyStored(stored.settings, stored.managed);
}

/**
 * Removes cookies and site data for normal websites. Only ever called at browser start, and only when the user chose it.
 * Installed web apps (protectedWeb) and extensions are left alone: Chrome marks both "be careful" in its reference.
 */
function clearSiteData(): Promise<void> {
  return invoke<void>((done) =>
    chrome.browsingData.remove({ since: 0, originTypes: { unprotectedWeb: true } }, CLEAR_TYPES, () => done()),
  );
}

function logError(error: unknown): void {
  // Errors only. Nothing about pages, URLs or browsing is logged.
  console.error('GOAL in Browser:', error instanceof Error ? error.message : String(error));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed';
}

chrome.runtime.onInstalled.addListener(() => {
  void serial(refresh).catch(logError);
});

chrome.runtime.onStartup.addListener(() => {
  void serial(async () => {
    await refresh();
    const stored = await readStored();
    if (stored.settings.protectionEnabled && stored.settings.clearOnStart) await clearSiteData();
  }).catch(logError);
});

chrome.permissions.onAdded.addListener(() => {
  void serial(refresh).catch(logError);
});

chrome.permissions.onRemoved.addListener(() => {
  void serial(refresh).catch(logError);
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Only this extension's own pages (popup and options) may send requests. Web pages cannot reach this listener.
  const ownPage = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));
  if (!ownPage) return false;
  const request = parseRequest(message);
  if (!request) {
    sendResponse({ error: 'Unknown request' });
    return false;
  }
  void serial(() => (request.type === 'state' ? state() : update(request.patch))).then(
    (response) => sendResponse(response),
    (error: unknown) => sendResponse({ error: errorText(error) }),
  );
  return true;
});
