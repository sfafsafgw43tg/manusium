/**
 * Saved website logins: metadata is readable, the password never is. These
 * tests pin the promise the UI makes - passwords.json is safe to back up, and
 * a secret only leaves the store through an explicit reveal/match call.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DataLayout, PasswordStore, parsePasswordCsv, passwordOrigin, generateStrongPassword } from '../src';
import { tmpDir } from './helpers';

function store(): { store: PasswordStore; layout: DataLayout } {
  const layout = new DataLayout(path.join(tmpDir(), 'OctoBrowser'));
  layout.ensure();
  const secrets = new Map<string, string>();
  const api = {
    get: (k: string) => secrets.get(k), has: (k: string) => secrets.has(k), set: (k: string, v: string) => { secrets.set(k, v); },
    delete: (k: string) => { secrets.delete(k); }, deletePrefix: () => undefined, backend: () => 'local' as const, ids: () => [...secrets.keys()],
  };
  return { store: new PasswordStore(layout, api), layout };
}

describe('passwordOrigin', () => {
  it('reduces a page URL to scheme + host (+ port) and rejects other schemes', () => {
    expect(passwordOrigin('https://example.com/login?next=1')).toBe('https://example.com');
    expect(passwordOrigin('http://example.com:8080/a')).toBe('http://example.com:8080');
    expect(passwordOrigin('octo://newtab')).toBe('');
    expect(passwordOrigin('not a url')).toBe('');
  });
});

describe('PasswordStore', () => {
  it('keeps the password out of passwords.json and returns it only on reveal', () => {
    const { store: s, layout } = store();
    const entry = s.save({ profileId: 'p1', origin: 'https://example.com/login', username: 'alice', password: 'hunter2' });
    const json = fs.readFileSync(path.join(layout.config, 'passwords.json'), 'utf8');
    expect(json).toContain('alice');
    expect(json).not.toContain('hunter2');
    expect(s.reveal(entry.id)).toBe('hunter2');
    expect(s.list('p1')).toHaveLength(1);
    expect(s.list('other')).toHaveLength(0);
  });

  it('updates an existing login instead of creating a duplicate', () => {
    const { store: s } = store();
    const first = s.save({ profileId: 'p1', origin: 'https://example.com', username: 'alice', password: 'one' });
    const second = s.save({ profileId: 'p1', origin: 'https://example.com/login', username: 'alice', password: 'two' });
    expect(second.id).toBe(first.id);
    expect(s.list('p1')).toHaveLength(1);
    expect(s.reveal(first.id)).toBe('two');
  });

  it('matches only the same profile and origin, and counts a use', () => {
    const { store: s } = store();
    s.save({ profileId: 'p1', origin: 'https://example.com', username: 'alice', password: 'one' });
    s.save({ profileId: 'p2', origin: 'https://example.com', username: 'bob', password: 'two' });
    const matches = s.matches('p1', 'https://example.com/deep/page');
    expect(matches.map((m) => m.entry.username)).toEqual(['alice']);
    expect(s.matches('p1', 'https://other.example/')).toHaveLength(0);
    s.markUsed(matches[0].entry.id);
    expect(s.list('p1')[0].timesUsed).toBe(1);
  });

  it('"never for this site" erases the secret and blocks further offers', () => {
    const { store: s } = store();
    const entry = s.save({ profileId: 'p1', origin: 'https://example.com', username: 'alice', password: 'one' });
    s.block('p1', 'https://example.com');
    expect(s.isBlocked('p1', 'https://example.com/login')).toBe(true);
    expect(s.matches('p1', 'https://example.com')).toHaveLength(0);
    expect(() => s.get(entry.id)).toThrow();
  });

  it('erases every login of a deleted profile', () => {
    const { store: s } = store();
    s.save({ profileId: 'p1', origin: 'https://a.example', username: '', password: 'x' });
    s.save({ profileId: 'p1', origin: 'https://b.example', username: '', password: 'y' });
    s.save({ profileId: 'p2', origin: 'https://a.example', username: '', password: 'z' });
    expect(s.removeProfile('p1')).toBe(2);
    expect(s.list('p1')).toHaveLength(0);
    expect(s.list('p2')).toHaveLength(1);
  });

  it('supports multiple accounts for the same origin and returns metadata via getAccounts', () => {
    const { store: s } = store();
    const a1 = s.save({ profileId: 'p1', origin: 'https://app.example.com', username: 'user1', password: 'pw1' });
    const a2 = s.save({ profileId: 'p1', origin: 'https://app.example.com', username: 'user2', password: 'pw2' });

    const accounts = s.getAccounts('p1', 'https://app.example.com/dashboard');
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.username)).toContain('user1');
    expect(accounts.map((a) => a.username)).toContain('user2');
    // Verifies getAccounts never returns the secret passwords
    for (const acc of accounts) {
      expect((acc as unknown as { password?: string }).password).toBeUndefined();
    }

    const byId = s.getById('p1', a1.id);
    expect(byId).not.toBeNull();
    expect(byId?.entry.username).toBe('user1');
    expect(byId?.password).toBe('pw1');

    const byUser = s.getByUsername('p1', 'https://app.example.com', 'user2');
    expect(byUser).not.toBeNull();
    expect(byUser?.entry.id).toBe(a2.id);
    expect(byUser?.password).toBe('pw2');

    // Wrong profile cannot fetch by ID or username
    expect(s.getById('p2', a1.id)).toBeNull();
    expect(s.getByUsername('p2', 'https://app.example.com', 'user1')).toBeNull();
  });
});

describe('generateStrongPassword', () => {
  it('generates high entropy passwords with mixed character classes', () => {
    const pw1 = generateStrongPassword(20);
    const pw2 = generateStrongPassword(20);
    expect(pw1.length).toBe(20);
    expect(pw2.length).toBe(20);
    expect(pw1).not.toBe(pw2);
    // Contains uppercase, lowercase, digit, and symbol
    expect(/[A-Z]/.test(pw1)).toBe(true);
    expect(/[a-z]/.test(pw1)).toBe(true);
    expect(/[0-9]/.test(pw1)).toBe(true);
    expect(/[!@#$%^&*()_+\-=~]/.test(pw1)).toBe(true);
  });
});

describe('parsePasswordCsv', () => {
  it('reads a Chrome export and counts unusable rows', () => {
    const csv = ['name,url,username,password',
      'Example,https://example.com/login,alice,"pa,ss"',
      'Broken,,bob,secret',
      'NoPass,https://c.example,carol,'].join('\n');
    const parsed = parsePasswordCsv(csv, 'p1');
    expect(parsed.entries).toEqual([{ profileId: 'p1', origin: 'https://example.com', username: 'alice', password: 'pa,ss' }]);
    expect(parsed.skipped).toBe(2);
  });

  it('reads a Firefox export header and refuses a file without a password column', () => {
    const firefox = ['"url","username","password"', '"https://f.example","dana","pw"'].join('\n');
    expect(parsePasswordCsv(firefox, 'p1').entries).toHaveLength(1);
    expect(parsePasswordCsv('a,b\n1,2', 'p1')).toEqual({ entries: [], skipped: 2 });
  });
});
