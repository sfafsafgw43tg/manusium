/* PrOximAl Editor background service worker. No network requests are made here. */
const api = globalThis.browser ?? globalThis.chrome;
const WORKSPACE = 'workspace.html';

function workspaceUrl(view = '') {
  return api.runtime.getURL(`${WORKSPACE}${view ? `#${view}` : ''}`);
}

async function openWorkspace(view = '') {
  await api.tabs.create({ url: workspaceUrl(view) });
}

async function activeTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function loadProfile() {
  const data = await api.storage.local.get('proximal.profile');
  return data['proximal.profile'] || null;
}

async function injectAndFill(tabId, profile) {
  // activeTab makes this a deliberate, one-tab action; no broad site access is requested.
  await api.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  return api.tabs.sendMessage(tabId, { type: 'proximal:fill', profile });
}

async function fillActiveForm() {
  const profile = await loadProfile();
  if (!profile || profile.synthetic !== true || !profile.values) {
    return { ok: false, message: 'Najpierw utwórz zestaw syntetyczny w PrOximAl.' };
  }
  const tab = await activeTab();
  if (!tab?.id || !/^https?:|^file:/.test(tab.url || '')) {
    return { ok: false, message: 'Otwórz zwykłą stronę formularza i spróbuj ponownie.' };
  }
  try {
    const result = await injectAndFill(tab.id, profile);
    return result || { ok: false, message: 'Strona nie odpowiedziała.' };
  } catch (error) {
    return {
      ok: false,
      message: 'Nie można uruchomić asystenta na tej stronie. Otwórz stronę ponownie i kliknij przycisk jeszcze raz.'
    };
  }
}

async function createMenu() {
  await api.contextMenus.removeAll();
  api.contextMenus.create({ id: 'open-workspace', title: 'Otwórz PrOximAl Editor', contexts: ['all'] });
  api.contextMenus.create({ id: 'fill-test-form', title: 'Wypełnij aktywnym zestawem testowym', contexts: ['editable'] });
}

api.runtime.onInstalled.addListener(() => { createMenu().catch(() => {}); });
api.runtime.onStartup?.addListener(() => { createMenu().catch(() => {}); });
api.contextMenus.onClicked.addListener(async ({ menuItemId }) => {
  if (menuItemId === 'open-workspace') await openWorkspace();
  if (menuItemId === 'fill-test-form') await fillActiveForm();
});
api.commands.onCommand.addListener(async (command) => {
  if (command === 'open-workspace') await openWorkspace();
  if (command === 'fill-test-form') await fillActiveForm();
});
api.runtime.onMessage.addListener((message) => {
  if (message?.type === 'proximal:open') return openWorkspace(message.view || '');
  if (message?.type === 'proximal:fill-active') return fillActiveForm();
  if (message?.type === 'proximal:profile-updated') return undefined;
  return undefined;
});
