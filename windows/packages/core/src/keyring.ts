/**
 * packages/core/src/keyring.ts
 *
 * Key hierarchy:
 *
 *   Data Encryption Key (DEK, random 256-bit, generated with the OS CSPRNG)
 *     ├─ encrypts: secrets.bin, bookmarks/history/session (*.enc), encrypted stores
 *     └─ is itself stored ONLY in wrapped form in config/keyring.bin, in one of
 *        two modes:
 *
 *        mode "os"       - the DEK is wrapped with Windows DPAPI (Electron
 *                          safeStorage), bound to the current Windows user
 *                          account. Unlocks automatically, nothing to type.
 *        mode "password" - the DEK is wrapped with a key derived from the user's
 *                          MASTER PASSWORD (Argon2id -> AES-256-GCM, blob format
 *                          "OCTP" from crypto.ts). Nothing about the password is
 *                          stored: only the wrapped key, the random salt and the
 *                          KDF parameters.
 *
 * The master password is optional and chosen by the user (first-run wizard or
 * Settings > Security). It is never written to disk, never logged and never
 * returned by any API - only the wrapped DEK crosses that boundary.
 *
 * Profile data that must survive a lost master password is protected separately
 * with the profile's own 12-word passphrase (see mnemonic.ts / profiles.ts).
 *
 * The DEK lives in memory only while unlocked and is wiped on lock().
 *
 * NOTE shown to users: local encryption does NOT protect against malware
 * running on an unlocked computer under the same account.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile } from './fsutil';
import {
  DecryptionError, KdfParams, DEFAULT_KDF, decryptWithPassword,
  encryptWithPassword, generateKey, isAcceptablePassword, wipe,
} from './crypto';

/** Abstraction over OS-level secret protection (DPAPI via Electron safeStorage on Windows). */
export interface OsProtector {
  readonly name: string;
  available(): boolean;
  protect(data: Buffer): Buffer;
  unprotect(data: Buffer): Buffer;
}

/** "os" = DPAPI-wrapped key (no password), "password" = master-password-wrapped key. */
export type KeyringMode = 'os' | 'password';

interface KeyringFile {
  schema: 1;
  mode: KeyringMode;
  osBlob?: string; // base64, DPAPI-wrapped DEK
  pwdBlob?: string; // base64, OCTP blob containing the DEK
  createdAt: string;
  changedAt: string;
}

const MAGIC = Buffer.from('OCKR1\n', 'ascii');
/** Context bound into the AES-GCM AAD of the password-wrapped DEK. */
const KEYRING_CONTEXT = 'octosuite-keyring-dek-v1';

export class Keyring {
  private dek: Buffer | null = null;

  constructor(
    private readonly file: string,
    private readonly os: OsProtector,
    private readonly kdf: KdfParams = DEFAULT_KDF,
  ) {}

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  isUnlocked(): boolean {
    return this.dek !== null;
  }

  private readFile(): KeyringFile {
    const raw = fs.readFileSync(this.file);
    if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Keyring file damaged (bad header)');
    const obj = JSON.parse(raw.subarray(MAGIC.length).toString('utf8')) as KeyringFile;
    if (obj.schema !== 1 || (obj.mode !== 'os' && obj.mode !== 'password')) throw new Error('Keyring file damaged');
    return obj;
  }

  private writeFile(obj: Omit<KeyringFile, 'createdAt' | 'changedAt'> & { createdAt?: string; changedAt?: string }): void {
    const prev = this.exists() ? this.readFile() : null;
    const now = new Date().toISOString();
    atomicWriteFile(this.file, Buffer.concat([MAGIC, Buffer.from(JSON.stringify({
      ...obj,
      createdAt: prev?.createdAt ?? obj.createdAt ?? now,
      changedAt: now,
    }), 'utf8')]));
  }

  mode(): KeyringMode | null {
    if (!this.exists()) return null;
    return this.readFile().mode;
  }

  /** true when the user must type the master password before the app can be used. */
  requiresPassword(): boolean {
    return this.mode() === 'password';
  }

  /**
   * Create a new keyring with a fresh DEK.
   *  - without a password: DPAPI mode (default, nothing to remember);
   *  - with a password: master-password mode (Argon2id + AES-256-GCM).
   */
  async create(opts: { password?: string } = {}): Promise<void> {
    if (this.exists()) throw new Error('Keyring already exists');
    const dek = generateKey();
    try {
      if (opts.password) {
        if (!isAcceptablePassword(opts.password)) throw new Error('Master password is too short');
        const blob = await encryptWithPassword(opts.password, dek, { kdf: this.kdf, context: KEYRING_CONTEXT });
        this.writeFile({ schema: 1, mode: 'password', pwdBlob: blob.toString('base64') });
      } else {
        if (!this.os.available()) throw new Error(`${this.os.name} is not available on this system`);
        this.writeFile({ schema: 1, mode: 'os', osBlob: this.os.protect(dek).toString('base64') });
      }
      this.dek = Buffer.from(dek);
    } finally {
      wipe(dek);
    }
  }

  /**
   * Unlock.
   *  - mode "os": nothing to pass; throws DecryptionError when DPAPI refuses the blob.
   *  - mode "password": the master password is required and MUST be correct;
   *    a wrong password throws DecryptionError (never a partial unlock).
   */
  async unlock(password?: string): Promise<void> {
    const f = this.readFile();
    let dek: Buffer;
    if (f.mode === 'password') {
      if (!f.pwdBlob) throw new DecryptionError('Keyring damaged: missing wrapped key');
      if (typeof password !== 'string' || password.length === 0) {
        throw new DecryptionError('This data folder is protected with a master password');
      }
      try {
        dek = await decryptWithPassword(password, Buffer.from(f.pwdBlob, 'base64'), KEYRING_CONTEXT);
      } catch {
        throw new DecryptionError('Wrong master password');
      }
    } else {
      if (!f.osBlob) throw new DecryptionError('Keyring damaged: missing wrapped key');
      try {
        dek = this.os.unprotect(Buffer.from(f.osBlob, 'base64'));
      } catch {
        throw new DecryptionError('Windows could not unprotect the key (different user or damaged profile)');
      }
    }
    if (dek.length !== 32) {
      wipe(dek);
      throw new DecryptionError('Keyring damaged: bad key length');
    }
    this.lock();
    this.dek = dek;
  }

  /** Wipe the DEK from memory. */
  lock(): void {
    wipe(this.dek);
    this.dek = null;
  }

  /** Returns the live DEK. Callers must NOT wipe or retain it. */
  getKey(): Buffer {
    if (!this.dek) throw new Error('Keyring is locked');
    return this.dek;
  }

  /**
   * Set (or replace) the master password. The DEK is re-wrapped, so all data
   * encrypted with it stays readable - only the wrapper changes.
   * `current` is required when the keyring already uses a password.
   */
  async setPassword(current: string | null, next: string): Promise<void> {
    if (!this.isUnlocked()) throw new Error('Keyring is locked');
    if (this.requiresPassword()) {
      if (typeof current !== 'string' || !current) throw new DecryptionError('Current master password required');
      await this.unlock(current); // re-derives the DEK: wrong password throws here
    }
    if (!isAcceptablePassword(next)) throw new Error('Master password is too short');
    const dek = this.getKey();
    const blob = await encryptWithPassword(next, dek, { kdf: this.kdf, context: KEYRING_CONTEXT });
    this.writeFile({ schema: 1, mode: 'password', pwdBlob: blob.toString('base64') });
    this.lock();
    await this.unlock(next);
  }

  /**
   * Remove the master password: the DEK is re-wrapped with DPAPI, so from now on
   * the app opens without typing anything (on this Windows account).
   */
  async removePassword(current: string): Promise<void> {
    if (!this.isUnlocked()) throw new Error('Keyring is locked');
    if (!this.requiresPassword()) return; // nothing to do
    await this.unlock(current); // wrong password throws
    if (!this.os.available()) throw new Error(`${this.os.name} is not available on this system`);
    const dek = this.getKey();
    this.writeFile({ schema: 1, mode: 'os', osBlob: this.os.protect(dek).toString('base64') });
    this.lock();
    await this.unlock();
  }

  /**
   * Recovery for a keyring that cannot be opened any more (DPAPI blob from another
   * Windows account / another PC, damaged file, forgotten master password is NOT
   * recoverable this way - a wrong password simply refuses to open).
   * The old file is NOT deleted - it is moved next to the other unreadable data so
   * a backup can still be tried later - and a brand new DEK is generated.
   *
   * Everything encrypted with the previous DEK becomes unreadable; the caller is
   * responsible for telling the user that and for quarantining those files.
   *
   * Returns the path the old keyring was moved to (null when there was none).
   */
  async resetToNewKey(quarantineDir?: string, opts: { password?: string } = {}): Promise<string | null> {
    this.lock();
    let moved: string | null = null;
    if (this.exists()) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = quarantineDir ?? path.dirname(this.file);
      fs.mkdirSync(dir, { recursive: true });
      moved = path.join(dir, `${path.basename(this.file)}.unreadable-${stamp}`);
      fs.renameSync(this.file, moved);
    }
    await this.create(opts);
    return moved;
  }
}
