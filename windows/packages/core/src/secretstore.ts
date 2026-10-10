/**
 * packages/core/src/secretstore.ts
 *
 * Encrypted key/value store for secrets such as proxy credentials.
 * Secrets never appear in JSON/plain text files: the whole map is serialised
 * and encrypted with the keyring's DEK (AES-256-GCM) into config/secrets.bin.
 * Profiles only reference secrets by an opaque id (e.g. "proxy:<profileId>").
 *
 * Two backends implement the same interface:
 *
 *   SecretStore          - default. One encrypted file inside the data folder,
 *                          included in backups, readable only with the local key.
 *   CredManSecretStore   - optional. One generic credential per secret inside
 *                          Windows Credential Manager (Settings > Security).
 *                          Credentials are per Windows user and are NOT part of
 *                          our backups, so switching back to the local store is
 *                          always possible.
 *
 * SecretRouter picks the backend that the current settings ask for, so the rest
 * of the application never has to care where a secret lives.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteFile, readTextIfExists } from './fsutil';
import { decryptWithKey, encryptWithKey, wipe } from './crypto';
import type { Keyring } from './keyring';
import { CredManStore } from './credman';

const CONTEXT = 'octosuite-secrets-v1';

/** Common interface of every secret backend. */
export interface SecretStoreApi {
  get(id: string): string | undefined;
  has(id: string): boolean;
  set(id: string, value: string): void;
  delete(id: string): void;
  /** Remove every secret whose id starts with prefix (used when deleting a profile). */
  deletePrefix(prefix: string): void;
  /** Which backend is active right now (shown in Settings). */
  backend(): 'local' | 'credman';
  /** Non-secret list of stored ids (Settings > overview). */
  ids(): string[];
}

export class SecretStore implements SecretStoreApi {
  constructor(private readonly file: string, private readonly keyring: Pick<Keyring, 'getKey'>) {}

  backend(): 'local' {
    return 'local';
  }

  private readAll(): Record<string, string> {
    if (!fs.existsSync(this.file)) return {};
    const plain = decryptWithKey(this.keyring.getKey(), fs.readFileSync(this.file), CONTEXT);
    try {
      return JSON.parse(plain.toString('utf8')) as Record<string, string>;
    } finally {
      wipe(plain);
    }
  }

  private writeAll(map: Record<string, string>): void {
    const plain = Buffer.from(JSON.stringify(map), 'utf8');
    try {
      atomicWriteFile(this.file, encryptWithKey(this.keyring.getKey(), plain, CONTEXT));
    } finally {
      wipe(plain);
    }
  }

  get(id: string): string | undefined {
    return this.readAll()[id];
  }

  has(id: string): boolean {
    return id in this.readAll();
  }

  set(id: string, value: string): void {
    const all = this.readAll();
    all[id] = value;
    this.writeAll(all);
  }

  delete(id: string): void {
    const all = this.readAll();
    if (id in all) {
      delete all[id];
      this.writeAll(all);
    }
  }

  deletePrefix(prefix: string): void {
    const all = this.readAll();
    let changed = false;
    for (const k of Object.keys(all)) {
      if (k.startsWith(prefix)) {
        delete all[k];
        changed = true;
      }
    }
    if (changed) this.writeAll(all);
  }

  ids(): string[] {
    return Object.keys(this.readAll()).sort();
  }
}

/**
 * Windows Credential Manager backend.
 *
 * The credential itself lives in the OS vault; only the list of NAMES is kept in
 * a plain JSON index (names contain no secrets - "proxy:<profileId>"), because
 * Credential Manager cannot be enumerated by prefix through our helper.
 */
export class CredManSecretStore implements SecretStoreApi {
  private readonly indexFile: string;

  constructor(
    indexFile: string,
    private readonly credman: CredManStore,
  ) {
    this.indexFile = indexFile;
  }

  backend(): 'credman' {
    return 'credman';
  }

  private readIndex(): string[] {
    const raw = readTextIfExists(this.indexFile);
    if (raw === null) return [];
    try {
      const arr = JSON.parse(raw) as unknown;
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return []; // damaged index: names are recoverable from Credential Manager itself
    }
  }

  private writeIndex(ids: string[]): void {
    atomicWriteFile(this.indexFile, JSON.stringify([...new Set(ids)].sort(), null, 2));
  }

  get(id: string): string | undefined {
    return this.credman.read(id) ?? undefined;
  }

  has(id: string): boolean {
    return this.credman.read(id) !== null;
  }

  set(id: string, value: string): void {
    this.credman.write(id, value, 'OctoSuite secret (encrypted by Windows)');
    const ids = this.readIndex();
    if (!ids.includes(id)) this.writeIndex([...ids, id]);
  }

  delete(id: string): void {
    this.credman.delete(id);
    const ids = this.readIndex().filter((x) => x !== id);
    this.writeIndex(ids);
  }

  deletePrefix(prefix: string): void {
    const ids = this.readIndex();
    for (const id of ids.filter((x) => x.startsWith(prefix))) {
      this.credman.delete(id);
    }
    this.writeIndex(ids.filter((x) => !x.startsWith(prefix)));
  }

  ids(): string[] {
    return this.readIndex();
  }
}

/**
 * Routes secret operations to the backend selected in settings.
 * Switching backends never moves secrets automatically: the user is told that
 * credentials saved in the other place stay there until re-entered.
 */
export class SecretRouter implements SecretStoreApi {
  constructor(
    private readonly local: SecretStore,
    private readonly credman: CredManSecretStore,
    private readonly modeProvider: () => 'local' | 'credman',
    /** False on non-Windows / when the vault cannot be reached: falls back to local. */
    private readonly credmanAvailable: () => boolean = () => true,
  ) {}

  /** true when the Credential Manager backend can actually be used right now. */
  credmanUsable(): boolean {
    return this.credmanAvailable();
  }

  private active(): SecretStoreApi {
    return this.modeProvider() === 'credman' && this.credmanAvailable() ? this.credman : this.local;
  }

  backend(): 'local' | 'credman' {
    return this.modeProvider() === 'credman' && this.credmanAvailable() ? 'credman' : 'local';
  }

  get(id: string): string | undefined {
    return this.active().get(id);
  }

  has(id: string): boolean {
    return this.active().has(id);
  }

  set(id: string, value: string): void {
    this.active().set(id, value);
  }

  delete(id: string): void {
    this.active().delete(id);
  }

  deletePrefix(prefix: string): void {
    this.active().deletePrefix(prefix);
  }

  ids(): string[] {
    return this.active().ids();
  }
}

/** Build both backends for an app (the router is created by the shell). */
export function createSecretStores(
  files: { secretsFile: string; credmanIndexFile: string },
  keyring: Pick<Keyring, 'getKey'>,
  credman: CredManStore,
): { local: SecretStore; credman: CredManSecretStore } {
  return {
    local: new SecretStore(files.secretsFile, keyring),
    credman: new CredManSecretStore(files.credmanIndexFile, credman),
  };
}

/** Default location of the credential-name index inside a data folder. */
export function credmanIndexPath(configDir: string): string {
  return path.join(configDir, 'credman-index.json');
}
