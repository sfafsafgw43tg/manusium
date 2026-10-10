/**
 * Leak protection: a proxy profile must be fail-closed. These tests pin the
 * rules that decide when traffic is allowed at all, without booting Electron.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeProfile } from '../src/profiles';

describe('proxy lockdown defaults', () => {
  it('turns lockdown on for every proxy profile unless it was switched off', () => {
    const proxied = sanitizeProfile({ id: 'test-profile-id', name: 'p', kind: 'antidetect', network: { mode: 'proxy', proxyRules: 'socks5://1.2.3.4:1080' } } as never);
    expect(proxied.network.lockdown).toBe(true);

    const opened = sanitizeProfile({ id: 'test-profile-id', name: 'p', kind: 'antidetect', network: { mode: 'proxy', proxyRules: 'socks5://1.2.3.4:1080', lockdown: false } } as never);
    expect(opened.network.lockdown).toBe(false);
  });

  it('never claims lockdown for profiles without a proxy', () => {
    for (const mode of ['system', 'direct'] as const) {
      const profile = sanitizeProfile({ id: 'test-profile-id', name: 'p', kind: 'antidetect', network: { mode, lockdown: true } } as never);
      expect(profile.network.lockdown).toBe(false);
    }
  });
});
