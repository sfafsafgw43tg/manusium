/**
 * packages/core/src/config.ts
 *
 * VersionedStore<T>: a JSON document on disk with
 *   - integrity check (SHA-256 of the payload stored in an envelope),
 *   - automatic backup of the previous version BEFORE every change,
 *   - corruption detection with automatic fallback to the newest valid backup,
 *   - listing / restoring backups (Settings > Backups, repair.bat),
 *   - optional encryption of the payload with a data key (AES-256-GCM).
 *
 * Envelope format:
 *   { "schema": 1, "sha256": "<hex of payload>", "encrypted": false, "payload": "<json or base64>" }
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile, ensureDir, fileStamp, readTextIfExists, sha256Hex } from './fsutil';
import { decryptWithKey, encryptWithKey } from './crypto';

interface Envelope {
  schema: 1;
  sha256: string;
  encrypted: boolean;
  payload: string;
}

export interface StoreOptions<T> {
  /** Folder for automatic backups. */
  backupDir: string;
  /** Default value used when nothing (valid) exists yet. */
  defaults: () => T;
  /** Returns a sanitised value or throws when the document is invalid. */
  validate?: (value: unknown) => T;
  /** How many backups to keep (oldest are deleted). */
  maxBackups?: number;
  /** Provides the data key when the store is encrypted. */
  keyProvider?: () => Buffer;
  /** Context string bound into AES-GCM AAD (prevents swapping files). */
  context?: string;
  /** Back up the previous version before each save (default true). Disabled for high-frequency data like history. */
  backupOnSave?: boolean;
}

export type LoadStatus = 'ok' | 'created' | 'restored-from-backup' | 'reset-to-defaults';

export class VersionedStore<T> {
  private cache: T | null = null;
  public lastLoadStatus: LoadStatus = 'ok';

  constructor(public readonly file: string, private readonly opts: StoreOptions<T>) {}

  private decode(raw: string): T {
    const env = JSON.parse(raw) as Envelope;
    if (env.schema !== 1 || typeof env.payload !== 'string' || typeof env.sha256 !== 'string') {
      throw new Error('Bad envelope');
    }
    let json: string;
    if (env.encrypted) {
      if (!this.opts.keyProvider) throw new Error('Encrypted store without key');
      const key = this.opts.keyProvider();
      json = decryptWithKey(key, Buffer.from(env.payload, 'base64'), this.opts.context).toString('utf8');
    } else {
      json = env.payload;
    }
    if (sha256Hex(json) !== env.sha256) throw new Error('Checksum mismatch');
    const value = JSON.parse(json) as unknown;
    return this.opts.validate ? this.opts.validate(value) : (value as T);
  }

  private encode(value: T): string {
    const json = JSON.stringify(value);
    const encrypted = !!this.opts.keyProvider;
    const payload = encrypted
      ? encryptWithKey(this.opts.keyProvider!(), Buffer.from(json, 'utf8'), this.opts.context).toString('base64')
      : json;
    const env: Envelope = { schema: 1, sha256: sha256Hex(json), encrypted, payload };
    return JSON.stringify(env, null, encrypted ? 0 : 2);
  }

  /** Load (cached). Never throws for damaged files - falls back to backup/defaults. */
  load(): T {
    if (this.cache) return this.cache;
    const raw = readTextIfExists(this.file);
    if (raw === null) {
      this.cache = this.opts.defaults();
      this.lastLoadStatus = 'created';
      this.persist(this.cache, false);
      return this.cache;
    }
    try {
      this.cache = this.decode(raw);
      this.lastLoadStatus = 'ok';
      return this.cache;
    } catch {
      // Keep the damaged file for diagnostics, then try backups (newest first).
      try { fs.copyFileSync(this.file, `${this.file}.damaged-${fileStamp()}`); } catch { /* ignore */ }
      for (const b of this.listBackups()) {
        try {
          this.cache = this.decode(fs.readFileSync(path.join(this.opts.backupDir, b), 'utf8'));
          this.lastLoadStatus = 'restored-from-backup';
          this.persist(this.cache, false);
          return this.cache;
        } catch { /* try older */ }
      }
      this.cache = this.opts.defaults();
      this.lastLoadStatus = 'reset-to-defaults';
      this.persist(this.cache, false);
      return this.cache;
    }
  }

  /** Replace the whole document (backs up the previous version first). */
  save(value: T): void {
    const v = this.opts.validate ? this.opts.validate(value) : value;
    this.persist(v, this.opts.backupOnSave !== false);
    this.cache = v;
  }

  /** Functional update helper. */
  update(fn: (draft: T) => T | void): T {
    const cur = structuredClone(this.load());
    const next = (fn(cur) ?? cur) as T;
    this.save(next);
    return next;
  }

  private persist(value: T, backupFirst: boolean): void {
    if (backupFirst) this.backup();
    atomicWriteFile(this.file, this.encode(value));
  }

  private backupPrefix(): string {
    return `${path.basename(this.file)}.`;
  }

  /** Copy the current file into the backup folder. Returns backup file name. */
  backup(): string | null {
    if (!fs.existsSync(this.file)) return null;
    ensureDir(this.opts.backupDir);
    // Timestamp + 3-digit counter: several saves within the same millisecond must
    // never overwrite each other's backup (COPYFILE_EXCL), and names stay sortable.
    const stamp = fileStamp();
    for (let i = 0; i < 1000; i++) {
      const name = `${this.backupPrefix()}${stamp}-${String(i).padStart(3, '0')}.bak`;
      try {
        fs.copyFileSync(this.file, path.join(this.opts.backupDir, name), fs.constants.COPYFILE_EXCL);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw err;
      }
      this.prune();
      return name;
    }
    throw new Error('Too many backups within one millisecond');
  }

  /** Backup names, newest first. */
  listBackups(): string[] {
    if (!fs.existsSync(this.opts.backupDir)) return [];
    return fs
      .readdirSync(this.opts.backupDir)
      .filter((f) => f.startsWith(this.backupPrefix()) && f.endsWith('.bak'))
      .sort()
      .reverse();
  }

  /** Restore a named backup (the current state is backed up first). */
  restore(name: string): T {
    if (path.basename(name) !== name || !name.startsWith(this.backupPrefix())) throw new Error('Invalid backup name');
    const raw = fs.readFileSync(path.join(this.opts.backupDir, name), 'utf8');
    const value = this.decode(raw); // throws if the backup itself is damaged
    this.persist(value, true);
    this.cache = value;
    return value;
  }

  private prune(): void {
    const max = this.opts.maxBackups ?? 20;
    for (const old of this.listBackups().slice(max)) {
      fs.rmSync(path.join(this.opts.backupDir, old), { force: true });
    }
  }

  /** Drop the in-memory cache (e.g. after the data key changed). */
  invalidate(): void {
    this.cache = null;
  }
}
