/**
 * packages/core/src/passwords.ts
 *
 * Saved website logins of a profile ("Passwords" in the browser window and in
 * the profile data view of the launcher).
 *
 * WHY here: Electron has no Chromium password manager, so the promise made by
 * the profile switch "Save passwords" has to be kept by the app itself. The
 * split mirrors the one already used for proxies and cookies:
 *   - metadata (profile, origin, username, dates, use count) in
 *     config/passwords.json through VersionedStore, backed up on every change;
 *   - the password itself ONLY in the encrypted SecretStore under
 *     "pw:<entry id>", so profiles.json and every backup of it stay readable
 *     without exposing a single secret.
 *
 * Nothing in here talks to the network, and a password is only ever returned by
 * an explicit reveal()/fill() call - listing entries never carries it.
 */
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { VersionedStore } from './config';
import { DataLayout } from './paths';
import type { SecretStoreApi } from './secretstore';

export interface PasswordEntry {
  id: string;
  profileId: string;
  /** Scheme + host (+ port), e.g. "https://example.com". */
  origin: string;
  username: string;
  createdAt: string;
  updatedAt: string;
  /** How often the entry was filled into a page. Helps the user spot dead logins. */
  timesUsed: number;
  /** The user answered "never for this site": no save prompt, no stored secret. */
  blocked: boolean;
}

export interface PasswordInput {
  profileId: string;
  origin: string;
  username: string;
  password: string;
}

interface PasswordsDoc { schema: 1; entries: PasswordEntry[] }

const ID = /^pwb?-[a-f0-9]{8,64}$/;

/** Reduce any page URL to the scheme+host form used as the entry key. */
export function passwordOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.port ? `${parsed.protocol}//${parsed.hostname}:${parsed.port}` : `${parsed.protocol}//${parsed.hostname}`;
  } catch { return ''; }
}

/** Host shown in lists; keeps "http://" visible because it is a security-relevant difference. */
export function passwordLabel(origin: string): string {
  return origin.startsWith('https://') ? origin.slice('https://'.length) : origin;
}

/**
 * Generate a cryptographically strong, high-entropy password suitable for
 * modern account registration and password reset forms.
 */
export function generateStrongPassword(length = 18): string {
  const len = Math.max(12, Math.min(64, length));
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*()_+-=~';
  const all = upper + lower + digits + symbols;
  const bytes = crypto.randomBytes(len);
  const result: string[] = [
    upper[bytes[0] % upper.length],
    lower[bytes[1] % lower.length],
    digits[bytes[2] % digits.length],
    symbols[bytes[3] % symbols.length],
  ];
  for (let i = 4; i < len; i++) {
    result.push(all[bytes[i] % all.length]);
  }
  for (let i = result.length - 1; i > 0; i--) {
    const j = crypto.randomBytes(1)[0] % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result.join('');
}

function sanitize(value: unknown): PasswordEntry | null {
  const e = value as Partial<PasswordEntry>;
  if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !ID.test(e.id)) return null;
  if (typeof e.profileId !== 'string' || !e.profileId || e.profileId.length > 64) return null;
  const origin = typeof e.origin === 'string' ? passwordOrigin(e.origin) : '';
  if (!origin) return null;
  const now = new Date().toISOString();
  return {
    id: e.id,
    profileId: e.profileId,
    origin,
    username: typeof e.username === 'string' ? e.username.slice(0, 256) : '',
    createdAt: typeof e.createdAt === 'string' ? e.createdAt : now,
    updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : now,
    timesUsed: Number.isSafeInteger(e.timesUsed) && Number(e.timesUsed) >= 0 ? Number(e.timesUsed) : 0,
    blocked: e.blocked === true,
  };
}

function validate(value: unknown): PasswordsDoc {
  const d = value as Partial<PasswordsDoc>;
  if (!d || d.schema !== 1 || !Array.isArray(d.entries)) throw new Error('Invalid passwords document');
  return { schema: 1, entries: d.entries.map(sanitize).filter((x): x is PasswordEntry => !!x) };
}

/**
 * Parse a Chrome/Firefox password CSV export (url,username,password header in
 * any order). Rows that are not usable are counted, never guessed at.
 */
export function parsePasswordCsv(text: string, profileId: string): { entries: PasswordInput[]; skipped: number } {
  const lines = String(text ?? '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { entries: [], skipped: 0 };
  const cells = (line: string): string[] => {
    const out: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (ch === '"') quoted = false;
        else current += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ',') { out.push(current); current = ''; }
      else current += ch;
    }
    out.push(current);
    return out;
  };
  const header = cells(lines[0]).map((cell) => cell.trim().toLowerCase());
  const urlAt = header.findIndex((cell) => cell === 'url' || cell === 'origin' || cell === 'login_uri' || cell === 'hostname' || cell === 'web site');
  const userAt = header.findIndex((cell) => cell === 'username' || cell === 'login' || cell === 'login_username' || cell === 'user');
  const passAt = header.findIndex((cell) => cell === 'password' || cell === 'login_password');
  if (urlAt < 0 || passAt < 0) return { entries: [], skipped: lines.length };
  const entries: PasswordInput[] = [];
  let skipped = 0;
  for (const line of lines.slice(1, 5001)) {
    const row = cells(line);
    const origin = passwordOrigin(row[urlAt]?.trim() ?? '');
    const password = row[passAt] ?? '';
    if (!origin || !password) { skipped++; continue; }
    entries.push({ profileId, origin, username: (userAt >= 0 ? row[userAt] : '')?.slice(0, 256) ?? '', password: password.slice(0, 4096) });
  }
  return { entries, skipped };
}

export class PasswordStore {
  readonly store: VersionedStore<PasswordsDoc>;

  constructor(layout: DataLayout, private readonly secrets?: SecretStoreApi) {
    this.store = new VersionedStore<PasswordsDoc>(path.join(layout.config, 'passwords.json'), {
      backupDir: path.join(layout.backups, 'config'),
      defaults: () => ({ schema: 1, entries: [] }),
      validate,
      maxBackups: 10,
    });
  }

  /** Metadata only - a password never leaves the store without reveal()/fill(). */
  list(profileId?: string): PasswordEntry[] {
    const all = this.store.load().entries;
    const scoped = profileId ? all.filter((entry) => entry.profileId === profileId) : all;
    return [...scoped].sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username));
  }

  get(id: string): PasswordEntry {
    const entry = this.store.load().entries.find((item) => item.id === id);
    if (!entry) throw new Error(`Password entry not found: ${id}`);
    return entry;
  }

  /** Save a new login or update the password of an existing one. */
  save(input: PasswordInput): PasswordEntry {
    const origin = passwordOrigin(input.origin);
    if (!origin) throw new Error('Unsupported origin for a saved password');
    if (!input.password) throw new Error('Empty password');
    const username = String(input.username ?? '').slice(0, 256);
    const now = new Date().toISOString();
    let saved: PasswordEntry | undefined;
    this.store.update((doc) => {
      const found = doc.entries.find((entry) => entry.profileId === input.profileId && entry.origin === origin && entry.username === username);
      if (found) {
        found.updatedAt = now;
        found.blocked = false;
        saved = found;
        return;
      }
      const entry: PasswordEntry = {
        id: `pw-${crypto.randomBytes(8).toString('hex')}`,
        profileId: input.profileId,
        origin,
        username,
        createdAt: now,
        updatedAt: now,
        timesUsed: 0,
        blocked: false,
      };
      doc.entries.push(entry);
      saved = entry;
    });
    this.secrets?.set(`pw:${saved!.id}`, String(input.password).slice(0, 4096));
    return saved!;
  }

  /** Remember "never save for this site" without keeping any secret for it. */
  block(profileId: string, origin: string): void {
    const clean = passwordOrigin(origin);
    if (!clean) return;
    const existing = this.list(profileId).filter((entry) => entry.origin === clean);
    for (const entry of existing) this.remove(entry.id);
    const now = new Date().toISOString();
    this.store.update((doc) => {
      doc.entries.push({ id: `pwb-${crypto.randomBytes(8).toString('hex')}`, profileId, origin: clean, username: '', createdAt: now, updatedAt: now, timesUsed: 0, blocked: true });
    });
  }

  isBlocked(profileId: string, origin: string): boolean {
    const clean = passwordOrigin(origin);
    return !!clean && this.list(profileId).some((entry) => entry.origin === clean && entry.blocked);
  }

  /** The password of one entry - only for an explicit user action. */
  reveal(id: string): string {
    const entry = this.get(id);
    if (entry.blocked) return '';
    return this.secrets?.get(`pw:${entry.id}`) ?? '';
  }

  /** Logins usable on a page, newest first; counts as a use of the entry. */
  matches(profileId: string, url: string): Array<{ entry: PasswordEntry; password: string }> {
    const origin = passwordOrigin(url);
    if (!origin) return [];
    return this.list(profileId)
      .filter((entry) => entry.origin === origin && !entry.blocked)
      .map((entry) => ({ entry, password: this.secrets?.get(`pw:${entry.id}`) ?? '' }))
      .filter((item) => !!item.password)
      .sort((a, b) => b.entry.updatedAt.localeCompare(a.entry.updatedAt));
  }

  /**
   * Return metadata for all accounts matching an origin (for autofill dropdowns
   * or account selection) WITHOUT returning passwords.
   */
  getAccounts(profileId: string, url: string): Array<{ id: string; username: string; updatedAt: string; timesUsed: number }> {
    const origin = passwordOrigin(url);
    if (!origin) return [];
    return this.list(profileId)
      .filter((entry) => entry.origin === origin && !entry.blocked)
      .map((entry) => ({ id: entry.id, username: entry.username, updatedAt: entry.updatedAt, timesUsed: entry.timesUsed }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Get entry and password by ID for a specific profile. */
  getById(profileId: string, id: string): { entry: PasswordEntry; password: string } | null {
    if (!id) return null;
    try {
      const entry = this.get(id);
      if (entry.profileId !== profileId || entry.blocked) return null;
      const password = this.secrets?.get(`pw:${entry.id}`) ?? '';
      return password ? { entry, password } : null;
    } catch {
      return null;
    }
  }

  /** Get entry and password by username for a specific origin. */
  getByUsername(profileId: string, url: string, username: string): { entry: PasswordEntry; password: string } | null {
    const origin = passwordOrigin(url);
    if (!origin) return null;
    const match = this.matches(profileId, origin).find((m) => m.entry.username === username);
    return match ?? null;
  }

  markUsed(id: string): void {
    this.store.update((doc) => {
      const entry = doc.entries.find((item) => item.id === id);
      if (entry) entry.timesUsed += 1;
    });
  }

  remove(id: string): void {
    this.store.update((doc) => { doc.entries = doc.entries.filter((entry) => entry.id !== id); });
    this.secrets?.delete(`pw:${id}`);
  }

  /** Erase every login of a profile (profile deletion, "delete on close"). */
  removeProfile(profileId: string): number {
    const mine = this.list(profileId);
    for (const entry of mine) this.remove(entry.id);
    return mine.length;
  }

  /** Import a browser CSV export; existing logins are updated, not duplicated. */
  import(text: string, profileId: string): { added: number; skipped: number } {
    const parsed = parsePasswordCsv(text, profileId);
    let added = 0;
    for (const entry of parsed.entries) {
      try { this.save(entry); added++; } catch { /* unusable row, already counted below */ }
    }
    return { added, skipped: parsed.skipped + (parsed.entries.length - added) };
  }
}
