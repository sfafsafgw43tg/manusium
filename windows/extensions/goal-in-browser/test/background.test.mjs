import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeChrome, uninstallFakeChrome } from './helpers/fake-chrome.mjs';

beforeEach(() => uninstallFakeChrome());

/** Loads a fresh copy of the service worker against a fresh fake, so each test starts from a clean state. */
async function loadWorker(options = {}) {
  const fake = installFakeChrome(options);
  await import(`../dist/background.js?case=${Math.random()}`);
  return fake;
}

const OWN_PAGE = { id: 'testextensionid', url: 'chrome-extension://testextensionid/popup.html' };
const OWN_TAB = { id: 'testextensionid', url: 'chrome-extension://testextensionid/options.html', tab: { id: 4 } };
const WEB_PAGE = { id: 'testextensionid', url: 'https://evil.example/page', tab: { id: 9 } };
const OTHER_EXTENSION = { id: 'someotherextension', url: 'chrome-extension://someotherextension/x.html' };

/** Calls the message listener the way Chrome does. Resolves with the response, or 'not handled' when it returns false. */
function send(fake, message, sender) {
  return new Promise((resolve) => {
    const keepOpen = fake.listeners.message[0](message, sender, (response) => resolve(response));
    if (keepOpen !== true) resolve('not handled');
  });
}

async function waitFor(check, timeoutMs = 2000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the service worker');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('messages from web pages and from other extensions are ignored', async () => {
  const fake = await loadWorker();
  assert.equal(await send(fake, { type: 'state' }, WEB_PAGE), 'not handled');
  assert.equal(await send(fake, { type: 'state' }, OTHER_EXTENSION), 'not handled');
  assert.equal(fake.log.storageWrites.length, 0);
});

test('the popup and the options tab can both read state; the default is Standard with no site access', async () => {
  const fake = await loadWorker();
  for (const sender of [OWN_PAGE, OWN_TAB]) {
    const response = await send(fake, { type: 'state' }, sender);
    assert.equal(response.settings.protectionEnabled, true);
    assert.equal(response.settings.adList, true);
    assert.equal(response.settings.referrerPolicy, 'default');
    assert.equal(response.siteAccess, false);
  }
});

test('an update is saved, applied, and reported back', async () => {
  const fake = await loadWorker();
  const response = await send(fake, { type: 'update', patch: { protectionEnabled: false } }, OWN_PAGE);
  assert.equal(response.settings.protectionEnabled, false);
  assert.equal(fake.storage.settings.protectionEnabled, false);
  assert.equal(response.report[0].id, 'protection');
  assert.equal(response.report[0].state, 'off');
});

test('unknown requests are refused without changing anything', async () => {
  const fake = await loadWorker();
  const response = await send(fake, { type: 'set-everything', patch: { protectionEnabled: false } }, OWN_PAGE);
  assert.deepEqual(response, { error: 'Unknown request' });
  assert.equal(fake.log.storageWrites.length, 0);
});

test('the Sec-GPC header is not applied at install or startup without site access, even when the setting is on', async () => {
  const fake = await loadWorker({ storage: { settings: { globalPrivacyControl: true } }, siteAccess: false });
  fake.listeners.installed[0]();
  await waitFor(() => fake.log.dynamicCalls.length > 0);
  const added = fake.log.dynamicCalls[0].added.map((rule) => rule.action.type);
  assert.equal(added.includes('modifyHeaders'), false);
  assert.deepEqual(fake.log.permissionRequests, [], 'the worker never asks for permission');
});

test('browser start clears site data only when the user turned that on', async () => {
  const off = await loadWorker({ storage: { settings: { clearOnStart: false } } });
  off.listeners.startup[0]();
  await waitFor(() => off.log.badge !== null);
  assert.deepEqual(off.log.browsingDataCalls, []);

  const on = await loadWorker({ storage: { settings: { clearOnStart: true } } });
  on.listeners.startup[0]();
  await waitFor(() => on.log.browsingDataCalls.length > 0);
  const [call] = on.log.browsingDataCalls;
  assert.deepEqual(call.options.originTypes, { unprotectedWeb: true }, 'normal websites only, not installed web apps or extensions');
  assert.equal(call.types.cookies, true);
  for (const kind of ['history', 'passwords', 'downloads', 'formData']) {
    assert.equal(kind in call.types, false, `${kind} is never cleared`);
  }
});

test('turning protection off does not clear site data at start', async () => {
  const fake = await loadWorker({ storage: { settings: { clearOnStart: true, protectionEnabled: false } } });
  fake.listeners.startup[0]();
  await waitFor(() => fake.log.badge !== null);
  assert.deepEqual(fake.log.browsingDataCalls, []);
});
