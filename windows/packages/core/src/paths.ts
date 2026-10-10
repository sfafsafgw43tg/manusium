/**
 * packages/core/src/paths.ts
 *
 * Layout of an application data folder (inside the folder chosen by the user
 * on first run). Both applications use the same helper but different roots,
 * so their data never mixes:
 *
 *   <base>\OctoBrowser\            <base>\OctoDetect\
 *     config\   settings, keyring      config\
 *     profiles\ one folder / profile   profiles\
 *     engine\   Chromium internal data engine\
 *     downloads\                       reports\
 *     backups\  config + profile       backups\
 *     updater\  downloaded updates     updater\
 *     logs\                            logs\
 *     temp\     wiped on exit          temp\
 */
import * as path from 'node:path';
import { ensureDir } from './fsutil';

export class DataLayout {
  private readonly profileDirectories = new Map<string, string>();
  constructor(public readonly root: string) {}

  get config(): string { return path.join(this.root, 'config'); }
  get profiles(): string { return path.join(this.root, 'profiles'); }
  get engine(): string { return path.join(this.root, 'engine'); }
  get downloads(): string { return path.join(this.root, 'downloads'); }
  get backups(): string { return path.join(this.root, 'backups'); }
  get updater(): string { return path.join(this.root, 'updater'); }
  get logs(): string { return path.join(this.root, 'logs'); }
  get temp(): string { return path.join(this.root, 'temp'); }
  get reports(): string { return path.join(this.root, 'reports'); }
  get errors(): string { return path.join(this.root, 'errors'); }
  get filters(): string { return path.join(this.root, 'filters'); }

  profileDir(id: string): string {
    if (!/^[a-z0-9-]{3,64}$/.test(id)) throw new Error('Invalid profile id');
    return this.profileDirectories.get(id) ?? path.join(this.profiles, id);
  }
  /** Bind one profile's actual directory after its metadata has been loaded. */
  setProfileDirectory(id: string, directory?: string): void {
    if (!/^[a-z0-9-]{3,64}$/.test(id)) throw new Error('Invalid profile id');
    if (!directory) this.profileDirectories.delete(id);
    else if (path.isAbsolute(directory)) this.profileDirectories.set(id, path.resolve(directory));
    else throw new Error('Profile directory must be absolute');
  }
  /** Chromium partition (cookies, cache, localStorage, IndexedDB...) of one profile. */
  profileEngineDir(id: string): string { return path.join(this.profileDir(id), 'engine'); }
  profileDownloadsDir(id: string): string { return path.join(this.profileDir(id), 'downloads'); }
  profileVaultFile(id: string): string { return path.join(this.profileDir(id), 'engine.vault'); }
  profileDataFile(id: string, name: 'bookmarks' | 'history' | 'session'): string {
    return path.join(this.profileDir(id), `${name}.enc`);
  }

  /** Create all top-level folders. */
  ensure(extra: Array<keyof DataLayout> = []): void {
    for (const d of [this.config, this.profiles, this.engine, this.backups, this.updater, this.logs, this.temp, this.filters, this.errors]) {
      ensureDir(d);
    }
    for (const k of extra) {
      const v = this[k];
      if (typeof v === 'string') ensureDir(v);
    }
  }
}
