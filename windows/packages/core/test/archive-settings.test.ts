/**
 * packages/core/test/archive-settings.test.ts
 * Profile archive safety (zip-slip style attacks) and settings validation.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defaultSettings, dohTemplate, isCachePath, packDir, searchEngineQueryUrl, unpackTo, validateSettings } from '../src';

function evilArchive(entryPath: string): Buffer {
  const header = Buffer.from(JSON.stringify([{ p: entryPath, s: 4 }]), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(header.length, 0);
  return Buffer.concat([Buffer.from('OCTA1\n', 'ascii'), len, header, Buffer.from('evil')]);
}

describe('profile archive', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'octo-arc-'));

  it('round-trips files and skips Chromium caches', () => {
    const src = tmp();
    fs.mkdirSync(path.join(src, 'Default', 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(src, 'Default', 'Cookies'), 'c');
    fs.writeFileSync(path.join(src, 'Default', 'Cache', 'data_0'), 'x'.repeat(100));
    fs.writeFileSync(path.join(src, 'zażółć gęślą.txt'), 'pl');
    const dest = tmp();
    const n = unpackTo(packDir(src), dest);
    expect(n).toBe(2);
    expect(fs.readFileSync(path.join(dest, 'Default', 'Cookies'), 'utf8')).toBe('c');
    expect(fs.readFileSync(path.join(dest, 'zażółć gęślą.txt'), 'utf8')).toBe('pl');
    expect(fs.existsSync(path.join(dest, 'Default', 'Cache'))).toBe(false);
    expect(isCachePath(path.join('Default', 'GPUCache', 'x'))).toBe(true);
  });

  it.each(['../escape.txt', 'a/../../escape.txt', '/etc/passwd', 'C:/Windows/evil.dll', 'a\0b'])('rejects unsafe path %j', (p) => {
    const dest = tmp();
    expect(() => unpackTo(evilArchive(p), dest)).toThrow();
    expect(fs.existsSync(path.join(path.dirname(dest), 'escape.txt'))).toBe(false);
  });

  it('rejects garbage and truncated archives', () => {
    expect(() => unpackTo(Buffer.from('not an archive'), tmp())).toThrow('Invalid archive');
    const good = evilArchive('ok.txt');
    expect(() => unpackTo(good.subarray(0, good.length - 2), tmp())).toThrow();
  });
});

describe('settings validation', () => {
  it('defaults are privacy-friendly', () => {
    const d = defaultSettings();
    expect(d.network.publicIpLookup).toBe(false);
    expect(d.logs.mode).toBe('standard');
    expect(d.offline).toBe(false);
    expect(d.offlineMode).toBe('online');
    expect(d.updates.autoCheck).toBe(true);
    expect(d.ui.navOrder).toContain('profiles');
    expect(d.ui.navHidden).toEqual([]);
  });

  it('sanitises hostile or broken values', () => {
    const v = validateSettings({
      schema: 1,
      network: { publicIpLookup: 'yes', dns: { mode: 'evil', provider: 'nope', customTemplate: 'http://plain.example/dns' } },
      security: { autoLockMinutes: 1e9 },
      logs: { mode: 'verbose' },
      updates: { channel: 'nightly' },
      tor: { torBrowserPath: 42 },
    });
    expect(v.network.dns.mode).toBe('system');
    expect(v.network.dns.provider).toBe('quad9');
    expect(v.network.dns.customTemplate).toBe('');
    expect(v.security.autoLockMinutes).toBe(15);
    expect(v.logs.mode).toBe('standard');
    expect(v.updates.channel).toBe('stable');
    expect(v.tor.torBrowserPath).toBe('');
  });

  it('picks a privacy-respecting search engine and never an unknown one', () => {
    expect(defaultSettings().network.searchEngine).toBe('duckduckgo');
    expect(searchEngineQueryUrl('duckduckgo', 'kot łaciński')).toBe('https://duckduckgo.com/?q=kot%20%C5%82aci%C5%84ski');
    expect(searchEngineQueryUrl('duckduckgo-noai', 'test query')).toBe('https://html.duckduckgo.com/html/?q=test%20query');
    expect(searchEngineQueryUrl('brave', 'a b')).toBe('https://search.brave.com/search?q=a%20b');
    expect(searchEngineQueryUrl('startpage', 'x')).toBe('https://www.startpage.com/sp/search?query=x');
    expect(searchEngineQueryUrl('mojeek', 'x')).toBe('https://www.mojeek.com/search?q=x');
    expect(validateSettings({ schema: 1, network: { searchEngine: 'duckduckgo-noai' } }).network.searchEngine).toBe('duckduckgo-noai');
    expect(validateSettings({ schema: 1, network: { searchEngine: 'evil' } }).network.searchEngine).toBe('duckduckgo');
  });

  it('asks before closing by default and keeps the switches booleans', () => {
    const d = defaultSettings();
    expect(d.ui.confirmOnQuit).toBe(true);
    expect(d.ui.closeAction).toBe('ask');
    expect(d.ui.openLinksInBackground).toBe(false);
    const v = validateSettings({ schema: 1, ui: { confirmOnQuit: 'no', closeAction: 'not-a-choice', openLinksInBackground: 1 } });
    expect(v.ui.confirmOnQuit).toBe(true);
    expect(v.ui.closeAction).toBe('ask');
    expect(v.ui.openLinksInBackground).toBe(false);
    expect(validateSettings({ schema: 1, ui: { closeAction: 'background' } }).ui.closeAction).toBe('background');
    expect(validateSettings({ schema: 1, ui: { closeCountdown: false } }).ui.closeCountdown).toBe(false);
    expect(validateSettings({ schema: 1, ui: { theme: 'amethyst' } }).ui.theme).toBe('amethyst');
    expect(validateSettings({ schema: 1, ui: { theme: 'neon' } }).ui.theme).toBe('ink');
    expect(validateSettings({ schema: 1, logs: { mode: 'off' } }).logs.mode).toBe('off');
    expect(validateSettings({ schema: 1, ui: { navOrder: ['logs', 'profiles', 'logs', 'unknown'], navHidden: ['logs', 'unknown'] } }).ui).toMatchObject({
      navOrder: ['logs', 'profiles', 'proxies', 'backup', 'virtualbox', 'trash', 'security', 'api', 'settings', 'about'], navHidden: ['logs'],
    });
    expect(validateSettings({ schema: 1, ui: { navOrder: ['logs', 'profiles'], navHidden: ['logs'] } }).ui.sidebar).toEqual([
      { id: 'logs', visible: false }, { id: 'profiles', visible: true }, { id: 'proxies', visible: true }, { id: 'backup', visible: true },
      { id: 'virtualbox', visible: true }, { id: 'trash', visible: true }, { id: 'security', visible: true }, { id: 'api', visible: true },
      { id: 'settings', visible: true }, { id: 'about', visible: true },
    ]);
  });

  it('migrates the legacy offline switch and validates offline policies', () => {
    expect(validateSettings({ schema: 1, offline: true }).offlineMode).toBe('practical');
    const strict = validateSettings({ schema: 1, offlineMode: 'strict' });
    expect(strict.offline).toBe(true);
    expect(strict.offlineMode).toBe('strict');
    expect(validateSettings({ schema: 1, offlineMode: 'unknown' }).offlineMode).toBe('online');
  });

  it('keeps the bookmark bar switch a boolean', () => {
    expect(defaultSettings().ui.showBookmarksBar).toBe(false);
    expect(validateSettings({ schema: 1, ui: { showBookmarksBar: 'yes' } }).ui.showBookmarksBar).toBe(false);
    expect(validateSettings({ schema: 1, ui: { showBookmarksBar: true } }).ui.showBookmarksBar).toBe(true);
  });

  it('keeps the hideDirectoryPaths switch a boolean', () => {
    expect(defaultSettings().ui.hideDirectoryPaths).toBe(false);
    expect(validateSettings({ schema: 1, ui: { hideDirectoryPaths: 'yes' } }).ui.hideDirectoryPaths).toBe(false);
    expect(validateSettings({ schema: 1, ui: { hideDirectoryPaths: true } }).ui.hideDirectoryPaths).toBe(true);
    expect(validateSettings({ schema: 1, ui: { hidePaths: true } as any }).ui.hideDirectoryPaths).toBe(true);
  });


  it('keeps the virtualBoxMode switch a boolean', () => {
    expect(defaultSettings().ui.virtualBoxMode).toBe(false);
    expect(validateSettings({ schema: 1, ui: { virtualBoxMode: 'yes' } }).ui.virtualBoxMode).toBe(false);
    expect(validateSettings({ schema: 1, ui: { virtualBoxMode: true } }).ui.virtualBoxMode).toBe(true);
    expect(validateSettings({ schema: 1, ui: { vmMode: true } as any }).ui.virtualBoxMode).toBe(true);
  });


  it('rejects documents with a wrong schema', () => {
    expect(() => validateSettings({ schema: 2 })).toThrow();
    expect(() => validateSettings(null)).toThrow();
  });

  it('builds DoH templates only for https', () => {
    const s = defaultSettings();
    expect(dohTemplate(s)).toBeNull();
    s.network.dns = { mode: 'doh', provider: 'custom', customTemplate: 'https://dns.example/dns-query' };
    expect(dohTemplate(validateSettings(s))).toBe('https://dns.example/dns-query');
  });
});
