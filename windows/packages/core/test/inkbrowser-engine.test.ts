import { describe, expect, it } from 'vitest';
import { defaultProfile, sanitizeProfile, type Profile } from '../src/profiles';
import {
  browserEngineFor,
  inkbrowserBlocks,
  inkbrowserLaunchArgs,
  isWebAddress,
  NEW_PROFILE_ENGINE,
  type InkBrowserFacts,
} from '../src/inkbrowser';

function factsFor(p: Profile, extra: Partial<InkBrowserFacts> = {}): InkBrowserFacts {
  return {
    kind: p.kind,
    fingerprintEnabled: p.fingerprint?.enabled === true,
    protectionLevel: p.protection.level,
    protectionOverrides: (p.protection.overrides ?? {}) as Record<string, unknown>,
    networkMode: p.network.mode,
    dnsMode: p.dns.mode,
    sandboxMode: p.sandbox.mode,
    firefoxIdentity: false,
    windowsIsolation: false,
    killSwitchOn: false,
    ...extra,
  };
}

/** A profile InkBrowser can run: no spoofing, Normal protection, system network, no sandbox. */
function plainProfile(): Profile {
  const p = defaultProfile('custom', 'Plain');
  const fp = p.fingerprint as NonNullable<Profile['fingerprint']>;
  return { ...p, fingerprint: { ...fp, enabled: false }, protection: { level: 'normal' } };
}

describe('browser engine choice', () => {
  it('profiles without a stored engine, and unknown values, stay on Electron', () => {
    expect(browserEngineFor(undefined)).toBe('electron');
    expect(browserEngineFor('electron')).toBe('electron');
    expect(browserEngineFor('blink-anything')).toBe('electron');
    expect(browserEngineFor('inkbrowser')).toBe('inkbrowser');
    expect(browserEngineFor('firefox')).toBe('firefox');
  });

  it('new profiles use the primary native Chromium choice while Electron remains available', () => {
    expect(NEW_PROFILE_ENGINE).toBe('inkbrowser');
    expect(inkbrowserBlocks(factsFor(defaultProfile('personal', 'Default')))).toEqual(['fingerprint', 'protection']);
  });

  it('sanitizeProfile keeps a valid engine and gives older profiles electron', () => {
    const base = defaultProfile('personal', 'Engine test');
    expect(sanitizeProfile({ ...base, engine: undefined }).engine).toBe('electron');
    expect(sanitizeProfile({ ...base, engine: 'inkbrowser' }).engine).toBe('inkbrowser');
    expect(sanitizeProfile({ ...base, engine: 'firefox' }).engine).toBe('firefox');
    expect(sanitizeProfile({ ...base, engine: 'other' as unknown as 'electron' }).engine).toBe('electron');
  });
});

describe('InkBrowser launch arguments', () => {
  const dir = 'C:\\Users\\user\\AppData\\Roaming\\OctoSuite\\profiles\\p1\\engine\\inkbrowser-profile';
  const base = [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check'];

  it('uses the profile folder, skips first-run pages, and passes only web home pages', () => {
    expect(inkbrowserLaunchArgs(dir)).toEqual(base);
    expect(inkbrowserLaunchArgs(dir, 'https://example.com/start')).toEqual([...base, 'https://example.com/start']);
    expect(inkbrowserLaunchArgs(dir, 'octo://newtab')).toEqual(base);
    expect(inkbrowserLaunchArgs(dir, 'javascript:alert(1)')).toEqual(base);
    expect(inkbrowserLaunchArgs(dir, '--remote-debugging-port=9222')).toEqual(base);
  });

  it('refuses a relative profile folder', () => {
    expect(() => inkbrowserLaunchArgs('profiles/p1')).toThrow(/absolute/);
  });

  it('accepts web addresses only', () => {
    expect(isWebAddress('http://a.test')).toBe(true);
    expect(isWebAddress('https://a.test/x')).toBe(true);
    expect(isWebAddress('file:///C:/x')).toBe(false);
    expect(isWebAddress('')).toBe(false);
  });
});

describe('InkBrowser refusal rules', () => {
  it('a plain profile with spoofing off, Normal protection, and default network settings may run', () => {
    expect(inkbrowserBlocks(factsFor(plainProfile()))).toEqual([]);
  });

  it('fingerprint spoofing, a protection level other than Normal, or any protection override refuse the launch', () => {
    const p = plainProfile();
    expect(inkbrowserBlocks(factsFor(p, { fingerprintEnabled: true }))).toEqual(['fingerprint']);
    expect(inkbrowserBlocks(factsFor({ ...p, protection: { level: 'standard' } }))).toEqual(['protection']);
    expect(inkbrowserBlocks(factsFor({ ...p, protection: { level: 'normal', overrides: { blockAds: true } } }))).toEqual(['protection']);
  });

  it('the kill switch, a Firefox identity, or Windows isolation each refuse the launch', () => {
    const p = plainProfile();
    expect(inkbrowserBlocks(factsFor(p, { killSwitchOn: true }))).toEqual(['kill-switch']);
    expect(inkbrowserBlocks(factsFor(p, { firefoxIdentity: true }))).toEqual(['firefox-identity']);
    expect(inkbrowserBlocks(factsFor(p, { windowsIsolation: true }))).toEqual(['isolation']);
  });

  it('a proxy, a non-system network mode, DoH, or a sandbox refuse the launch', () => {
    const p = plainProfile();
    expect(inkbrowserBlocks(factsFor({ ...p, network: { ...p.network, mode: 'proxy' } }))).toEqual(['proxy']);
    expect(inkbrowserBlocks(factsFor({ ...p, network: { ...p.network, mode: 'direct' } }))).toEqual(['proxy']);
    expect(inkbrowserBlocks(factsFor({ ...p, dns: { ...p.dns, mode: 'doh' } }))).toEqual(['dns']);
    expect(inkbrowserBlocks(factsFor({ ...p, sandbox: { ...p.sandbox, mode: 'windows-sandbox' } }))).toEqual(['sandbox']);
  });

  it('antidetect, phone, private and temporary profiles are refused', () => {
    expect(inkbrowserBlocks(factsFor(defaultProfile('antidetect', 'x')))).toContain('fingerprint');
    expect(inkbrowserBlocks(factsFor(defaultProfile('phone', 'x')))).toContain('fingerprint');
    expect(inkbrowserBlocks(factsFor(defaultProfile('private', 'x')))).toContain('protection');
    expect(inkbrowserBlocks(factsFor(defaultProfile('temporary', 'x')))).toContain('protection');
  });
});
