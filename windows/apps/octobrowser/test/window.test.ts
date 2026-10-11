/**
 * apps/octobrowser/test/window.test.ts
 *
 * Regression tests for the reported crashes in the profile window:
 *   1) "Cannot read properties of undefined (reading 'isDestroyed') at get wc"
 *      - a tab whose WebContents died (page called window.close(), e.g. an
 *        OAuth pop-up) stayed in the tab list and crashed every state push;
 *   2) "Cannot read properties of undefined (reading 'close') at BaseWindow"
 *      - closing the window dereferenced view.webContents of dead tabs.
 * Plus: real pop-ups with window.opener on normal/standard profiles and
 * closing a profile without the confirmation overlay.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => await import('./fake-electron'));

import { defaultProfile, effectiveSettings, Profile } from '@octo/core';
import { tabContents } from '@octo/shell/hardening';
import { BaseWindow, FakeWebContents } from './fake-electron';
import { BrowserWindowController } from '../src/main/window';

const flush = () => new Promise((r) => setImmediate(r));

function makeRt(level: 'normal' | 'standard' | 'strict' = 'normal', confirmOnQuit = true) {
  const profile: Profile = { ...defaultProfile('antidetect', 'P1'), protection: { level } } as Profile;
  return {
    profile,
    fp: { languages: ['pl-PL', 'pl'] },
    distDir: '/dist',
    settings: { load: () => ({ ui: { confirmOnQuit, sleepTabsAfterMin: 0 } }) },
    controller: { privacy: effectiveSettings(profile.protection) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    onWindowClosed: vi.fn(),
    onWindowFocus: vi.fn(),
    onTabCreated: vi.fn(),
    sharedState: () => ({}),
    normalizeInput: (u: string) => u,
    recordHistory: vi.fn(),
    t: (k: string) => k,
    addBookmark: vi.fn(),
    openLauncher: vi.fn(),
    toggleProfileMute: vi.fn(),
  };
}

type TabLike = { id: number; wc: FakeWebContents | null; view: unknown };
type Ctl = Omit<BrowserWindowController, never> & { tabs: TabLike[] };

function open(rt: ReturnType<typeof makeRt>, urls = ['https://a.example/'], allowEmpty = false): Ctl {
  const w = new BrowserWindowController(rt as never, urls, allowEmpty);
  // Expose the private tab list for assertions.
  return new Proxy(w, {
    get: (target, prop) => (prop === 'tabs' ? (target as unknown as { tabs: TabLike[] }).tabs : Reflect.get(target, prop, target)),
  }) as unknown as Ctl;
}

describe('BrowserWindowController crash fixes', () => {
  beforeEach(() => { BaseWindow.all.length = 0; });

  it('shows and focuses the native browser window without waiting for a renderer event', async () => {
    const rt = makeRt();
    const w = open(rt);
    const native = BaseWindow.all[0];
    expect(native.shown).toBe(true);
    expect(native.focused).toBe(true);
    await expect(w.whenChromeReady()).resolves.toBeUndefined();
  });

  it('base Chrome look uses Google for built-in start pages and new tabs', () => {
    const rt = makeRt();
    rt.profile.baseChromeLook = true;
    const w = open(rt, []);
    expect(w.state().tabs[0]?.url).toBe('https://www.google.com/?hl=pl');
    w.command('new-tab');
    expect(w.state().tabs[1]?.url).toBe('https://www.google.com/?hl=pl');

    const existing = open(rt, ['octo://newtab', 'https://keep.example/']);
    existing.applyBaseChromeHome();
    expect(existing.state().tabs.map((t) => t.url)).toEqual(['https://www.google.com/?hl=pl', 'https://keep.example/']);
  });

  it('page calling window.close() removes the tab instead of crashing (s1)', async () => {
    const rt = makeRt();
    const w = open(rt, ['https://a.example/', 'https://b.example/']);
    expect(w.state().tabs).toHaveLength(2);
    const dead = w.tabs[1].wc!;
    dead.destroy(); // what window.close() in the page does
    expect(() => w.pushState()).not.toThrow(); // state push right after death
    await flush();
    expect(w.state().tabs).toHaveLength(1);
    expect(tabContents.has(dead.id)).toBe(false);
    expect(() => w.newTab('https://c.example/')).not.toThrow();
    expect(w.state().tabs).toHaveLength(2);
  });

  it('closes exactly one same-origin tab even when close is delivered twice', async () => {
    const rt = makeRt('normal', false);
    const w = open(rt, ['https://same.example/one', 'https://same.example/two']);
    const first = w.tabs[0];
    const second = w.tabs[1];
    w.closeTab(first.id);
    // The WebContents destroyed callback is deferred and may race the
    // explicit close request. Neither that callback nor a duplicate request
    // may remove the surviving same-origin tab.
    w.closeTab(first.id);
    await flush();
    expect(w.state().tabs.map((tab) => tab.id)).toEqual([second.id]);
    expect(w.state().tabs[0].url).toBe('https://same.example/two');
  });

  it('closing the window with dead tabs does not throw (s2)', async () => {
    const rt = makeRt('normal', false);
    const w = open(rt, ['https://a.example/', 'https://b.example/']);
    w.tabs[0].wc!.destroy();
    const win = BaseWindow.all[0];
    expect(() => win.close()).not.toThrow();
    await flush();
    expect(rt.onWindowClosed).toHaveBeenCalledTimes(1);
  });

  it('last tab closing itself closes the window cleanly', async () => {
    const rt = makeRt('normal', false);
    const w = open(rt);
    w.tabs[0].wc!.destroy();
    await flush();
    expect(BaseWindow.all[0].destroyed).toBe(true);
    expect(rt.onWindowClosed).toHaveBeenCalledTimes(1);
  });

  it('normal profile: pop-ups keep window.opener (OAuth / payments) and become tabs', () => {
    const rt = makeRt('normal');
    const w = open(rt);
    const opener = w.tabs[0].wc!;
    opener.emit('input-event', {}, { type: 'mouseDown' }); // user clicked "Sign in with..."
    const res = opener.openHandler!({ url: 'https://accounts.example/o/oauth2', disposition: 'new-window' }) as { action: string; createWindow: (o: unknown) => unknown };
    expect(res.action).toBe('allow');
    const child = new FakeWebContents();
    expect(res.createWindow({ webContents: child })).toBe(child);
    expect(tabContents.has(child.id)).toBe(true);
    const st = w.state();
    expect(st.tabs).toHaveLength(2);
    expect(st.activeId).toBe(st.tabs[1].id);
    expect(rt.onTabCreated).toHaveBeenCalledWith(child);
  });

  it('OAuth pop-up closing itself after login returns to the opener tab', async () => {
    const rt = makeRt('normal');
    const w = open(rt);
    const opener = w.tabs[0].wc!;
    opener.emit('input-event', {}, { type: 'mouseDown' });
    const res = opener.openHandler!({ url: 'https://accounts.example/', disposition: 'new-window' }) as { createWindow: (o: unknown) => unknown };
    const child = new FakeWebContents();
    res.createWindow({ webContents: child });
    child.destroy();
    await flush();
    const st = w.state();
    expect(st.tabs).toHaveLength(1);
    expect(st.activeId).toBe(st.tabs[0].id);
  });

  it('pop-ups without a user click are blocked like in Chrome', () => {
    const rt = makeRt('normal');
    const w = open(rt);
    const res = w.tabs[0].wc!.openHandler!({ url: 'https://ads.example/', disposition: 'new-window' }) as { action: string };
    expect(res.action).toBe('deny');
    expect(w.state().tabs).toHaveLength(1);
  });

  it('strict profile: pop-up opens as an unrelated tab (no opener)', () => {
    const rt = makeRt('strict');
    const w = open(rt);
    w.tabs[0].wc!.emit('input-event', {}, { type: 'mouseDown' });
    const res = w.tabs[0].wc!.openHandler!({ url: 'https://x.example/', disposition: 'foreground-tab' }) as { action: string };
    expect(res.action).toBe('deny');
    expect(w.state().tabs).toHaveLength(2);
  });

  it('requests a close confirmation before keeping the profile window open', () => {
    const rt = makeRt('normal', true);
    const w = open(rt);
    const win = BaseWindow.all[0];
    win.close();
    expect(win.destroyed).toBe(false);
    const chrome = (w as unknown as { chrome: { webContents: FakeWebContents } }).chrome.webContents;
    expect(chrome.sent).toContainEqual(['ui:close-request', { tabs: 1, restoreSession: true }]);
  });

  it('confirmClose bypasses the confirmation overlay (closing from the launcher)', () => {
    const rt = makeRt('normal', true);
    const w = open(rt);
    w.confirmClose(false);
    expect(BaseWindow.all[0].destroyed).toBe(true);
  });

  it('tab actions on dead / sleeping tabs are safe', async () => {
    const rt = makeRt('normal', false);
    const w = open(rt, ['https://a.example/', 'https://b.example/', 'https://c.example/']);
    const [t0, t1, t2] = w.tabs;
    w.tabAction(t1.id, 'sleep');
    expect(w.state().tabs.find((x: { id: number; sleeping: boolean }) => x.id === t1.id)?.sleeping).toBe(true);
    t2.wc!.destroy();
    for (const a of ['reload', 'mute', 'volume', 'duplicate', 'close']) expect(() => w.tabAction(t2.id, a, 50)).not.toThrow();
    w.activate(t1.id); // wakes the sleeping tab
    expect(w.tabs.find((x: TabLike) => x.id === t1.id)?.wc).toBeTruthy();
    expect(() => w.command('reload')).not.toThrow();
    expect(() => w.closeTab(t0.id)).not.toThrow();
    await flush();
  });

  it('detaches the same live page view without reloading and retargets its events', () => {
    const rt = makeRt('normal', false);
    const source = open(rt, ['https://a.example/', 'https://b.example/']);
    const target = open(rt, [], true);
    const moved = source.tabs[1];
    const page = moved.wc!;
    const view = moved.view;
    const sourceNative = BaseWindow.all[0];
    const targetNative = BaseWindow.all[1];

    expect(target.state().tabs).toHaveLength(0);
    expect(source.detachTabTo(moved.id, target as unknown as BrowserWindowController)).toBe(true);
    expect(source.state().tabs).toHaveLength(1);
    expect(target.state().tabs).toHaveLength(1);
    expect(target.tabs[0].wc).toBe(page);
    expect(sourceNative.children.has(view as never)).toBe(false);
    expect(targetNative.children.has(view as never)).toBe(true);

    const targetChrome = (target as unknown as { chrome: { webContents: FakeWebContents } }).chrome.webContents;
    targetChrome.sent.length = 0;
    page.emit('page-title-updated', {}, 'Still alive');
    expect(target.state().tabs[0].title).toBe('Still alive');
    expect(targetChrome.sent.some(([channel]) => channel === 'ui:tab')).toBe(true);
  });

  it('reorders in visible pinned-first order without crossing the pin boundary', () => {
    const rt = makeRt('normal', false);
    const w = open(rt, ['https://a.example/', 'https://pinned.example/', 'https://b.example/']);
    const [a, pinned, b] = w.tabs;
    w.tabAction(pinned.id, 'pin');
    expect(w.state().tabs.map((tab) => tab.id)).toEqual([pinned.id, a.id, b.id]);

    w.tabAction(b.id, 'move', 1);
    expect(w.state().tabs.map((tab) => tab.id)).toEqual([pinned.id, b.id, a.id]);
    w.tabAction(b.id, 'move', 0); // cannot enter the pinned section
    expect(w.state().tabs.map((tab) => tab.id)).toEqual([pinned.id, b.id, a.id]);
  });

  it('wakes a sleeping tab when it is detached into an active destination', () => {
    const rt = makeRt('normal', false);
    const source = open(rt, ['https://active.example/', 'https://sleeping.example/']);
    const target = open(rt, [], true);
    const sleeping = source.tabs[1];
    source.activate(source.tabs[0].id);
    source.tabAction(sleeping.id, 'sleep');
    expect(source.state().tabs.find((tab) => tab.id === sleeping.id)?.sleeping).toBe(true);

    expect(source.detachTabTo(sleeping.id, target as unknown as BrowserWindowController)).toBe(true);
    expect(target.state().tabs[0].sleeping).toBe(false);
    expect(target.tabs[0].wc).toBeTruthy();
  });

  it('closes an emptied source without destroying its detached page', () => {
    const rt = makeRt('normal', true);
    const source = open(rt);
    const target = open(rt, [], true);
    const page = source.tabs[0].wc!;

    expect(source.detachTabTo(source.tabs[0].id, target as unknown as BrowserWindowController)).toBe(true);
    expect(BaseWindow.all[0].destroyed).toBe(true);
    expect(page.destroyed).toBe(false);
    expect(target.tabs[0].wc).toBe(page);
  });

  it('layers chrome to front when a popup opens and restores tab view when it closes', () => {
    const rt = makeRt('normal', false);
    const w = open(rt, ['https://a.example/', 'https://b.example/']);
    const ctl = w as unknown as BrowserWindowController;
    expect(() => ctl.setPopup(true)).not.toThrow();
    expect(() => ctl.setPopup(false)).not.toThrow();
    expect(() => ctl.activate(w.tabs[1].id)).not.toThrow();
    expect(() => ctl.activate(w.tabs[0].id)).not.toThrow();
  });
});

describe('tab context menu actions', () => {
  beforeEach(() => { BaseWindow.all.length = 0; });

  const urls = (w: Ctl) => w.state().tabs.map((tab) => tab.url);
  const chromeOf = (w: Ctl) => (w as unknown as { chrome: { webContents: FakeWebContents } }).chrome.webContents;

  it('close-others keeps the chosen tab and pinned tabs, and selects the chosen tab before closing', () => {
    const rt = makeRt('normal', false);
    const w = open(rt, ['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://pin.example/']);
    const [a, b, c, pin] = w.tabs;
    w.tabAction(pin.id, 'pin');
    w.activate(c.id); // the active tab is one of the victims
    w.tabAction(b.id, 'close-others');
    expect(urls(w)).toEqual(['https://pin.example/', 'https://b.example/']);
    expect(w.state().activeId).toBe(b.id);
    expect(w.state().tabs.map((tab) => tab.id)).not.toContain(a.id);
  });

  it('close-others leaves the active tab alone when it is not a victim', () => {
    const rt = makeRt('normal', false);
    const w = open(rt, ['https://a.example/', 'https://b.example/', 'https://c.example/']);
    const [a, b] = w.tabs;
    w.activate(a.id);
    w.tabAction(b.id, 'close-others');
    expect(urls(w)).toEqual(['https://b.example/']);
    expect(w.state().activeId).toBe(b.id);
  });

  it('close-right follows the strip order and never closes pinned tabs', () => {
    const rt = makeRt('normal', false);
    const w = open(rt, ['https://a.example/', 'https://b.example/', 'https://p.example/']);
    const [a, b, p] = w.tabs;
    w.tabAction(p.id, 'pin'); // strip becomes [p, a, b]
    w.activate(a.id);
    w.tabAction(a.id, 'close-right');
    expect(urls(w)).toEqual(['https://p.example/', 'https://a.example/']);
    expect(w.state().tabs.map((tab) => tab.id)).not.toContain(b.id);
  });

  it('close-duplicates closes only the other unpinned copies of the same URL', () => {
    const rt = makeRt('normal', false);
    const w = open(rt, ['https://news.example/', 'https://other.example/', 'https://news.example/', 'https://news.example/']);
    w.tabAction(w.tabs[0].id, 'close-duplicates');
    expect(urls(w)).toEqual(['https://news.example/', 'https://other.example/']);
  });

  it('new-right opens a tab directly after the chosen one and activates it', () => {
    const rt = makeRt('normal', false);
    const w = open(rt, ['https://a.example/', 'https://b.example/']);
    const [a, b] = w.tabs;
    w.tabAction(a.id, 'new-right');
    const ids = w.state().tabs.map((tab) => tab.id);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(a.id);
    expect(ids[2]).toBe(b.id);
    expect(w.state().activeId).toBe(ids[1]);
  });

  it('new-right on a pinned tab puts the new tab at the start of the unpinned tabs', () => {
    const rt = makeRt('normal', false);
    const w = open(rt, ['https://a.example/', 'https://pin.example/', 'https://b.example/']);
    const [a, pin, b] = w.tabs;
    w.tabAction(pin.id, 'pin'); // strip becomes [pin, a, b] although the array is [a, pin, b]
    w.tabAction(pin.id, 'new-right');
    const ids = w.state().tabs.map((tab) => tab.id);
    expect(ids[0]).toBe(pin.id);
    expect(ids[1]).toBe(w.state().activeId);
    expect(ids.slice(2)).toEqual([a.id, b.id]);
  });

  it('bookmark-all bookmarks web pages in strip order and reports how many', () => {
    const rt = makeRt('normal', false);
    const w = open(rt, ['https://a.example/', 'octo://newtab', 'https://b.example/']);
    w.tabAction(w.tabs[0].id, 'bookmark-all');
    expect(rt.addBookmark.mock.calls.map((call) => call[0])).toEqual(['https://a.example/', 'https://b.example/']);
    expect(chromeOf(w).sent).toContainEqual(['ui:toast', { key: 'toast.bookmarkedAll', params: { count: 2 } }]);
  });
});
