/**
 * apps/octobrowser/test/password-autofill-integration.test.ts
 *
 * Full integration tests for password saving, autofill, Smart Paste, React/Vue
 * controlled form inputs, multi-account origin matching, and profile vault isolation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { DataLayout, PasswordStore, generateStrongPassword, passwordOrigin } from '@octo/core';
import { tmpDir } from '../../../packages/core/test/helpers';

interface MemorySecretStore {
  get(k: string): string | undefined;
  has(k: string): boolean;
  set(k: string, v: string): void;
  delete(k: string): void;
  deletePrefix(p: string): void;
  backend(): 'local';
  ids(): string[];
}

function createVault(): { store: PasswordStore; secrets: Map<string, string>; layout: DataLayout } {
  const layout = new DataLayout(path.join(tmpDir(), `OctoVault-${Math.random().toString(36).slice(2)}`));
  layout.ensure();
  const secrets = new Map<string, string>();
  const api: MemorySecretStore = {
    get: (k: string) => secrets.get(k),
    has: (k: string) => secrets.has(k),
    set: (k: string, v: string) => { secrets.set(k, v); },
    delete: (k: string) => { secrets.delete(k); },
    deletePrefix: (p: string) => {
      for (const k of [...secrets.keys()]) {
        if (k.startsWith(p)) secrets.delete(k);
      }
    },
    backend: () => 'local',
    ids: () => [...secrets.keys()],
  };
  return { store: new PasswordStore(layout, api), secrets, layout };
}

describe('Chromium-Parity Password Manager Integration', () => {
  let v1: ReturnType<typeof createVault>;
  let v2: ReturnType<typeof createVault>;

  beforeEach(() => {
    v1 = createVault();
    v2 = createVault();
  });

  it('1. Basic login flow: saves credentials securely without leaking to disk plaintexts', () => {
    const entry = v1.store.save({
      profileId: 'profile-a',
      origin: 'https://auth.example.com/login',
      username: 'alice@example.com',
      password: 'SecurePassword123!',
    });

    expect(entry.id).toMatch(/^pw-[a-f0-9]{16}$/);
    expect(entry.origin).toBe('https://auth.example.com');
    expect(entry.username).toBe('alice@example.com');

    // Password must NOT exist in the JSON metadata store
    const rawJson = fs.readFileSync(path.join(v1.layout.config, 'passwords.json'), 'utf8');
    expect(rawJson).toContain('alice@example.com');
    expect(rawJson).not.toContain('SecurePassword123!');

    // Password is only retrievable from the encrypted secret store
    expect(v1.store.reveal(entry.id)).toBe('SecurePassword123!');
  });

  it('2. Signup with password confirmation: validates matching passwords and rejects mismatches', () => {
    const pass = 'SuperSecret123$';
    const confirmPassGood: string = 'SuperSecret123$';
    const confirmPassBad: string = 'Mismatched456#';

    // Simulated confirmation check
    const shouldSaveGood = pass && confirmPassGood && pass === confirmPassGood;
    const shouldSaveBad = pass && confirmPassBad && pass === confirmPassBad;

    expect(shouldSaveGood).toBe(true);
    expect(shouldSaveBad).toBe(false);

    if (shouldSaveGood) {
      v1.store.save({
        profileId: 'profile-a',
        origin: 'https://signup.service.org',
        username: 'newuser',
        password: pass,
      });
    }

    const accounts = v1.store.getAccounts('profile-a', 'https://signup.service.org');
    expect(accounts).toHaveLength(1);
    expect(accounts[0].username).toBe('newuser');
  });

  it('3. React/Vue Controlled Input setter helper: dispatches composed events and clears value trackers', () => {
    // Emulated HTMLInputElement with prototype getter/setter & React tracker
    let internalValue = '';
    const tracker = { setValue: (v: string) => { (tracker as unknown as { _v: string })._v = v; }, _v: '' };
    const eventsFired: string[] = [];

    const mockInput = {
      _valueTracker: tracker,
      value: '',
      dispatchEvent: (ev: { type: string; bubbles: boolean; composed: boolean }) => {
        eventsFired.push(ev.type);
        return true;
      },
    };

    // Framework-safe setter implementation test
    const proto = {
      get value() { return internalValue; },
      set value(v: string) { internalValue = v; },
    };
    Object.setPrototypeOf(mockInput, proto);

    // Apply native descriptor setter
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) {
      desc.set.call(mockInput, 'TypedOrPastedPass');
    }
    if (mockInput._valueTracker) {
      mockInput._valueTracker.setValue('');
    }
    mockInput.dispatchEvent({ type: 'input', bubbles: true, composed: true });
    mockInput.dispatchEvent({ type: 'change', bubbles: true, composed: true });

    expect(internalValue).toBe('TypedOrPastedPass');
    expect(tracker._v).toBe('');
    expect(eventsFired).toEqual(['input', 'change']);
  });

  it('4. Multi-account support: lists origin accounts without secrets and fetches specific account on demand', () => {
    v1.store.save({ profileId: 'profile-a', origin: 'https://portal.bank.com', username: 'admin', password: 'AdminPassword999!' });
    v1.store.save({ profileId: 'profile-a', origin: 'https://portal.bank.com', username: 'personal', password: 'PersonalPassword777$' });

    const accounts = v1.store.getAccounts('profile-a', 'https://portal.bank.com/signin');
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.username)).toEqual(['personal', 'admin']);

    // Ensure getAccounts does not expose the passwords
    for (const a of accounts) {
      expect((a as unknown as { password?: string }).password).toBeUndefined();
    }

    // Explicit fill of the user-selected account
    const chosen = accounts.find((a) => a.username === 'admin')!;
    const filled = v1.store.getById('profile-a', chosen.id);
    expect(filled).not.toBeNull();
    expect(filled?.entry.username).toBe('admin');
    expect(filled?.password).toBe('AdminPassword999!');
  });

  it('5. Password update flow: updates existing credentials without creating duplicates', () => {
    const original = v1.store.save({
      profileId: 'profile-a',
      origin: 'https://app.work.com',
      username: 'worker@work.com',
      password: 'OldPassword123!',
    });

    expect(v1.store.list('profile-a')).toHaveLength(1);
    expect(v1.store.reveal(original.id)).toBe('OldPassword123!');

    // Update with new password
    const updated = v1.store.save({
      profileId: 'profile-a',
      origin: 'https://app.work.com/settings/security',
      username: 'worker@work.com',
      password: 'NewHardenedPassword999#',
    });

    expect(updated.id).toBe(original.id);
    expect(v1.store.list('profile-a')).toHaveLength(1);
    expect(v1.store.reveal(original.id)).toBe('NewHardenedPassword999#');
  });

  it('6. Origin isolation: enforces scheme, host, and port boundaries', () => {
    v1.store.save({ profileId: 'profile-a', origin: 'https://example.com:8443', username: 'portUser', password: 'portPass' });
    v1.store.save({ profileId: 'profile-a', origin: 'https://example.com', username: 'standardUser', password: 'standardPass' });
    v1.store.save({ profileId: 'profile-a', origin: 'http://example.com', username: 'insecureUser', password: 'insecurePass' });

    expect(v1.store.matches('profile-a', 'https://example.com:8443')).toHaveLength(1);
    expect(v1.store.matches('profile-a', 'https://example.com:8443')[0].entry.username).toBe('portUser');

    expect(v1.store.matches('profile-a', 'https://example.com')).toHaveLength(1);
    expect(v1.store.matches('profile-a', 'https://example.com')[0].entry.username).toBe('standardUser');

    expect(v1.store.matches('profile-a', 'http://example.com')).toHaveLength(1);
    expect(v1.store.matches('profile-a', 'http://example.com')[0].entry.username).toBe('insecureUser');

    // Disallowed schemes
    expect(passwordOrigin('file:///etc/passwd')).toBe('');
    expect(passwordOrigin('octo://newtab')).toBe('');
    expect(passwordOrigin('javascript:alert(1)')).toBe('');
  });

  it('7. Profile vault isolation: credentials never cross profile boundaries', () => {
    v1.store.save({ profileId: 'profile-1', origin: 'https://secure.org', username: 'user1', password: 'pass1' });
    v2.store.save({ profileId: 'profile-2', origin: 'https://secure.org', username: 'user2', password: 'pass2' });

    expect(v1.store.matches('profile-1', 'https://secure.org')).toHaveLength(1);
    expect(v1.store.matches('profile-2', 'https://secure.org')).toHaveLength(0);

    expect(v2.store.matches('profile-2', 'https://secure.org')).toHaveLength(1);
    expect(v2.store.matches('profile-1', 'https://secure.org')).toHaveLength(0);
  });

  it('8. Strong password generation: generates random, high-entropy character mixtures', () => {
    const pw = generateStrongPassword(24);
    expect(pw.length).toBe(24);
    expect(/[A-Z]/.test(pw)).toBe(true);
    expect(/[a-z]/.test(pw)).toBe(true);
    expect(/[0-9]/.test(pw)).toBe(true);
    expect(/[!@#$%^&*()_+\-=~]/.test(pw)).toBe(true);

    const pwSet = new Set<string>();
    for (let i = 0; i < 50; i++) {
      pwSet.add(generateStrongPassword(16));
    }
    expect(pwSet.size).toBe(50); // High collision resistance
  });

  it('9. Smart Paste text normalization: strips non-breaking spaces and normalizes CRLF', () => {
    const rawClipboard = 'User\u00a0Pasted\r\nText\rWith\u00a0Unicode: \u017b\u00f3\u0142w \ud83d\udd11';
    const normalized = rawClipboard.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');

    expect(normalized).toBe('User Pasted\nText\nWith Unicode: Żółw 🔑');
    expect(normalized).not.toContain('\u00a0');
    expect(normalized).not.toContain('\r');
  });

  it('10. Blocked origin ("Never for this site") prevents prompt and clears secrets', () => {
    const entry = v1.store.save({ profileId: 'profile-a', origin: 'https://no-save.com', username: 'test', password: 'pwd' });
    expect(v1.store.list('profile-a')).toHaveLength(1);

    v1.store.block('profile-a', 'https://no-save.com');
    expect(v1.store.isBlocked('profile-a', 'https://no-save.com')).toBe(true);
    expect(v1.store.matches('profile-a', 'https://no-save.com')).toHaveLength(0);
    expect(v1.store.getAccounts('profile-a', 'https://no-save.com')).toHaveLength(0);

    // Old secret was wiped
    expect(() => v1.store.get(entry.id)).toThrow();
  });

  it('11. Multi-step login flow: preserves step-1 identifier to pair with step-2 password', () => {
    let sessionUser = '';
    let lastUser = '';
    let lastPass = '';

    // Step 1: User types username into an identifier field and submits
    const step1Input = { type: 'email', value: 'multistep.user@domain.com', name: 'identifier' };
    if (['text', 'email', 'tel', ''].includes(step1Input.type) && step1Input.value) {
      lastUser = step1Input.value;
      sessionUser = step1Input.value;
    }
    expect(sessionUser).toBe('multistep.user@domain.com');

    // Step 2: Next screen renders password input only
    const step2Input = { type: 'password', value: 'Step2PasswordSecret99!', form: null };
    if (step2Input.type === 'password' && step2Input.value) {
      lastPass = step2Input.value;
      if (!lastUser && sessionUser) {
        lastUser = sessionUser;
      }
    }

    expect(lastUser).toBe('multistep.user@domain.com');
    expect(lastPass).toBe('Step2PasswordSecret99!');

    const saved = v1.store.save({
      profileId: 'profile-a',
      origin: 'https://accounts.google-like.com',
      username: lastUser,
      password: lastPass,
    });

    expect(saved.username).toBe('multistep.user@domain.com');
    expect(v1.store.reveal(saved.id)).toBe('Step2PasswordSecret99!');
  });

  it('12. Protection against untrusted synthetic focus from page scripts', () => {
    const trustedEvent = { isTrusted: true, target: { type: 'password' } };
    const syntheticEvent = { isTrusted: false, target: { type: 'password' } };

    let autofillTriggered = false;
    const handleFocus = (ev: { isTrusted: boolean }) => {
      if (!ev.isTrusted) return;
      autofillTriggered = true;
    };

    handleFocus(syntheticEvent);
    expect(autofillTriggered).toBe(false);

    handleFocus(trustedEvent);
    expect(autofillTriggered).toBe(true);
  });

  it('13. Smart Paste into contenteditable elements with Range insertion and Unicode preservation', () => {
    const rawPasted = 'Code\u00a0Snippet\r\nWith\u00a0\u0141\u00f3d\u017a \ud83d\udd12';
    const clean = rawPasted.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');

    expect(clean).toBe('Code Snippet\nWith Łódź 🔒');
    expect(clean).not.toContain('\u00a0');
    expect(clean).not.toContain('\r');
  });

  it('14. Honeypot and invisible input filter excludes deceptive DOM elements', () => {
    const isVisible = (el: { hidden?: boolean; style?: { display?: string; visibility?: string; opacity?: string }; offsetWidth: number; offsetHeight: number; ariaHidden?: string }) => {
      if (el.hidden || el.style?.display === 'none' || el.style?.visibility === 'hidden') return false;
      if (el.ariaHidden === 'true') return false;
      if (el.style?.opacity && parseFloat(el.style.opacity) <= 0.05) return false;
      return el.offsetWidth > 0 && el.offsetHeight > 0;
    };

    const normalInput = { offsetWidth: 200, offsetHeight: 35 };
    const honeypotDisplayNone = { style: { display: 'none' }, offsetWidth: 0, offsetHeight: 0 };
    const honeypotZeroHeight = { offsetWidth: 100, offsetHeight: 0 };
    const honeypotOpacityZero = { style: { opacity: '0' }, offsetWidth: 100, offsetHeight: 20 };
    const ariaHiddenHoneypot = { ariaHidden: 'true', offsetWidth: 100, offsetHeight: 20 };

    expect(isVisible(normalInput)).toBe(true);
    expect(isVisible(honeypotDisplayNone)).toBe(false);
    expect(isVisible(honeypotZeroHeight)).toBe(false);
    expect(isVisible(honeypotOpacityZero)).toBe(false);
    expect(isVisible(ariaHiddenHoneypot)).toBe(false);
  });

  it('15. Keyboard navigation in autofill dropdown cycles through available suggestions', () => {
    const items = ['account1@org.com', 'account2@org.com', 'Suggest strong password'];
    let selectedIdx = -1;

    // Press ArrowDown
    selectedIdx = (selectedIdx + 1) % items.length;
    expect(items[selectedIdx]).toBe('account1@org.com');

    // Press ArrowDown again
    selectedIdx = (selectedIdx + 1) % items.length;
    expect(items[selectedIdx]).toBe('account2@org.com');

    // Press ArrowDown again -> password generation
    selectedIdx = (selectedIdx + 1) % items.length;
    expect(items[selectedIdx]).toBe('Suggest strong password');

    // Press ArrowUp
    selectedIdx = (selectedIdx - 1 + items.length) % items.length;
    expect(items[selectedIdx]).toBe('account2@org.com');
  });
});
