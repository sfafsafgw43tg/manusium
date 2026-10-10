import { describe, expect, it } from 'vitest';
import { parseCookies, parseProxy } from '@octo/core';
import { convertDolphinProfile, dolphinBookmarks, dolphinCookies, dolphinProfileSummaries, dolphinStartPages, dolphinTabs, parseDolphinExport } from '../src/main/dolphin-import';

const dolphinProfile = {
  data: {
    id: 42,
    name: 'Shop EU',
    tags: ['shops', 'eu'],
    folder: { name: 'Clients' },
    status: { name: 'Ready' },
    notes: { content: '<b>Use the EU account</b>' },
    platform: 'windows',
    platformVersion: '15.0.0',
    osVersion: '11 24H2',
    useragent: { mode: 'manual', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36' },
    uaFullVersion: '140.0.0.0',
    webrtc: { mode: 'udpDisabled', ipAddress: null },
    canvas: { mode: 'noise' },
    webgl: { mode: 'noise' },
    webglInfo: { mode: 'manual', vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel UHD Graphics)' },
    clientRect: { mode: 'noise' },
    timezone: { mode: 'manual', value: 'Europe/Warsaw' },
    locale: { mode: 'manual', value: 'pl_PL' },
    geolocation: { mode: 'manual', latitude: 52.23, longitude: 21.01, accuracy: 15 },
    cpu: { mode: 'manual', value: 8 },
    memory: { mode: 'manual', value: 8 },
    screen: { mode: 'manual', resolution: '1920x1080' },
    mediaDevices: { mode: 'manual', audioInputs: 1, audioOutputs: 1, videoInputs: 0 },
    ports: { mode: 'protect', blacklist: '3389,5900' },
    doNotTrack: 1,
    proxy: { type: 'socks5', host: '127.0.0.1', port: '1080', login: 'user', password: 'pass', name: 'EU route', changeIpUrl: 'https://proxy.example/rotate' },
    homepages: [{ url: 'https://example.com/' }, { url: 'https://mail.example.com/' }],
    bookmarks: [{ title: 'Google', url: 'https://google.com', folder: 'Work' }],
    cookies: [{ name: 'session_id', value: 'abc123xyz', domain: '.example.com', path: '/', secure: true, httpOnly: true }],
  },
};

describe('Dolphin Anty configuration migration', () => {
  it('summarizes list responses without exposing any remote profile details', () => {
    expect(dolphinProfileSummaries({ data: [dolphinProfile.data] })).toEqual([{
      id: '42', name: 'Shop EU', tags: ['shops', 'eu'], folder: 'Clients', hasProxy: true,
    }]);
  });

  it('converts every compatible selected configuration group into a new local profile', () => {
    const converted = convertDolphinProfile(dolphinProfile, { organization: true, fingerprint: true, proxy: true, startPages: true, cookies: true });
    expect(converted.name).toBe('Shop EU');
    expect(converted.patch).toMatchObject({
      tags: ['shops', 'eu'], folder: 'Clients', status: 'Ready', notes: 'Use the EU account',
      homePage: 'https://example.com/', startPages: ['https://mail.example.com/'],
      fingerprint: {
        enabled: true, os: 'windows11', uaFullVersion: '140.0.0.0',
        webrtc: { mode: 'disable-udp', publicIp: '' }, canvas: 'noise', webgl: 'noise', clientRects: 'noise',
        timezone: { mode: 'manual', value: 'Europe/Warsaw' }, language: { mode: 'manual', value: 'pl-PL' },
        geolocation: { mode: 'manual', latitude: 52.23, longitude: 21.01, accuracy: 15 },
        cpu: { mode: 'manual', cores: 8 }, memory: { mode: 'manual', gb: 8 }, screen: { mode: 'manual', width: 1920, height: 1080 },
        ports: { mode: 'protect', list: '3389,5900' }, doNotTrack: true,
      },
    });
    expect(converted.proxy).toMatchObject({ type: 'socks5', name: 'EU route', changeIpUrl: 'https://proxy.example/rotate' });
    expect(parseProxy(converted.proxy!.text, converted.proxy!.type)).toMatchObject({ ok: true, proxy: { username: 'user', password: 'pass' } });
    expect(converted.tabs).toEqual([
      { url: 'https://example.com/', title: 'https://example.com/', pinned: false },
      { url: 'https://mail.example.com/', title: 'https://mail.example.com/', pinned: false },
    ]);
    expect(converted.bookmarks).toHaveLength(1);
    expect(converted.bookmarks![0]).toMatchObject({ title: 'Google', url: 'https://google.com', folder: 'Work' });
    expect(converted.cookies).toBeDefined();
    const parsedCookies = parseCookies(JSON.stringify(converted.cookies));
    expect(parsedCookies.ok).toBe(true);
    expect(parsedCookies.cookies[0].name).toBe('session_id');
  });

  it('honours the user selection rather than copying unselected groups', () => {
    const converted = convertDolphinProfile(dolphinProfile, { organization: false, fingerprint: false, proxy: false, startPages: false, cookies: false });
    expect(converted.patch).toEqual({});
    expect(converted.proxy).toBeUndefined();
  });
});

describe('Dolphin start pages, windows and tabs', () => {
  it('reads every shape Dolphin has used for start tabs, not just homepages', () => {
    expect(dolphinStartPages({ homepages: ['https://a.example'] })).toEqual(['https://a.example']);
    expect(dolphinStartPages({ tabs: [{ url: 'https://b.example/one' }, 'https://c.example'] }))
      .toEqual(['https://b.example/one', 'https://c.example']);
    expect(dolphinStartPages({ mainWebsite: 'https://d.example' })).toEqual(['https://d.example']);
    expect(dolphinStartPages({ data: { startUrls: ['https://e.example'] } })).toEqual(['https://e.example']);
    expect(dolphinTabs({ windows: [{ tabs: [{ url: 'https://win1.example', title: 'Win 1', isPinned: true }] }] }))
      .toEqual([{ url: 'https://win1.example', title: 'Win 1', pinned: true }]);
  });

  it('upgrades bare hosts to HTTPS and drops anything that is not a page', () => {
    expect(dolphinStartPages({ homepages: ['example.com/login', 'www.shop.example'] }))
      .toEqual(['https://example.com/login', 'https://www.shop.example']);
    expect(dolphinStartPages({ homepages: ['javascript:alert(1)', 'file:///etc/passwd', '', 'google'] })).toEqual([]);
  });

  it('carries the tabs into the created profile', () => {
    const converted = convertDolphinProfile({ name: 'Tabs', tabs: ['https://one.example', 'two.example'] },
      { organization: false, fingerprint: false, proxy: false, startPages: true, cookies: false });
    expect(converted.patch).toMatchObject({ homePage: 'https://one.example', startPages: ['https://two.example'] });
  });

  it('extracts bookmarks and cookies 1:1', () => {
    const bm = dolphinBookmarks({ bookmarks: [{ name: 'Test', link: 'https://test.example', group: 'G' }] });
    expect(bm).toHaveLength(1);
    expect(bm[0]).toMatchObject({ title: 'Test', url: 'https://test.example', folder: 'G' });

    const c = dolphinCookies({ cookiesData: [{ key: 'auth', val: 'secret', host: 'test.example' }] });
    expect(c).toBeDefined();
    const parsed = parseCookies(JSON.stringify(c));
    expect(parsed.ok).toBe(true);
    expect(parsed.cookies[0].name).toBe('auth');
    expect(parsed.cookies[0].value).toBe('secret');
  });
});

describe('local Dolphin export files', () => {
  it('accepts an array, a { data } wrapper and a single profile', () => {
    expect(parseDolphinExport(JSON.stringify([{ id: 7, name: 'A' }, { id: 8, name: 'B' }])).summaries.map((p) => p.name)).toEqual(['A', 'B']);
    expect(parseDolphinExport(JSON.stringify({ data: [{ id: 7, name: 'A' }] })).profiles).toHaveLength(1);
    expect(parseDolphinExport(JSON.stringify({ name: 'Solo', tabs: ['https://x.example'] })).summaries[0].name).toBe('Solo');
  });

  it('keeps profiles that have no numeric id usable by giving them a positional one', () => {
    const parsed = parseDolphinExport(JSON.stringify([{ name: 'No id' }]));
    expect(parsed.summaries).toEqual([{ id: 'local-1', name: 'No id', tags: [], folder: '', hasProxy: false }]);
  });

  it('returns nothing for a file that is not a Dolphin export', () => {
    expect(parseDolphinExport('not json')).toEqual({ profiles: [], summaries: [] });
    expect(parseDolphinExport('[]')).toEqual({ profiles: [], summaries: [] });
  });
});
