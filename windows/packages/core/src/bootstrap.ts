/**
 * packages/core/src/bootstrap.ts
 *
 * First-run state. The ONLY file written outside the user-selected data folder
 * is `%APPDATA%\<App>.su\bootstrap.json`, which contains:
 *   - the chosen UI language (en | pl),
 *   - the absolute path of the chosen data folder,
 *   - the timestamp of the first run.
 * No secrets, no history, no profile data. Everything else lives in the data
 * folder chosen by the user during the first-run wizard.
 *
 * Portable mode: if a file named `portable.flag` exists next to the
 * executable, bootstrap.json is stored next to the executable instead.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { atomicWriteFile, ensureDir, readTextIfExists } from './fsutil';
import type { Lang } from './i18n';
import { isLang } from './i18n';

export interface BootstrapState {
  schema: 1;
  language: Lang;
  /** Base folder selected by the user (e.g. D:\Moje dane\OctoSuite). */
  baseDir: string;
  /** Application data folder = baseDir + app sub-folder (e.g. ...\OctoSuite\OctoBrowser). */
  dataDir: string;
  firstRunAt: string;
}

export class BootstrapStore {
  constructor(private readonly file: string) {}

  get path(): string {
    return this.file;
  }

  /** Returns the saved state or null when the first-run wizard must be shown. */
  read(): BootstrapState | null {
    const raw = readTextIfExists(this.file);
    if (raw === null) return null;
    try {
      const obj = JSON.parse(raw) as Partial<BootstrapState>;
      if (
        obj.schema === 1 &&
        isLang(obj.language) &&
        typeof obj.dataDir === 'string' && path.isAbsolute(obj.dataDir) &&
        typeof obj.baseDir === 'string' && path.isAbsolute(obj.baseDir)
      ) {
        return obj as BootstrapState;
      }
    } catch {
      /* fall through: damaged file => treat as first run, the wizard will re-create it */
    }
    return null;
  }

  write(state: BootstrapState): void {
    atomicWriteFile(this.file, JSON.stringify(state, null, 2));
  }

  /** Change only the language (Settings > Language). */
  setLanguage(lang: Lang): void {
    const cur = this.read();
    if (!cur) throw new Error('Bootstrap not initialised');
    this.write({ ...cur, language: lang });
  }
}

/** Folders the data directory may never be placed in (or equal to). */
function forbiddenRoots(): string[] {
  const out: string[] = [];
  const env = process.env;
  for (const k of ['SystemRoot', 'windir', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) {
    if (env[k]) out.push(path.resolve(env[k] as string));
  }
  return out;
}

export interface DataDirCheck {
  ok: boolean;
  /** i18n key describing the problem. */
  errorKey?: string;
}

/**
 * Validate a folder chosen in the first-run wizard.
 *  - must be absolute
 *  - must not be a drive root or a system / Program Files folder
 *  - must not be inside the installation folder (updates replace it)
 *  - must be writable (verified by writing and deleting a probe file)
 */
export function validateBaseDir(dir: string, installDir?: string): DataDirCheck {
  if (!dir || !path.isAbsolute(dir)) return { ok: false, errorKey: 'firstRun.err.notAbsolute' };
  const resolved = path.resolve(dir);
  if (path.parse(resolved).root === resolved) return { ok: false, errorKey: 'firstRun.err.driveRoot' };
  const lower = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const isInside = (child: string, parent: string) => {
    const rel = path.relative(lower(parent), lower(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  for (const root of forbiddenRoots()) {
    if (isInside(resolved, root)) return { ok: false, errorKey: 'firstRun.err.systemFolder' };
  }
  if (installDir && isInside(resolved, path.resolve(installDir))) {
    return { ok: false, errorKey: 'firstRun.err.insideInstall' };
  }
  try {
    ensureDir(resolved);
    const probe = path.join(resolved, `.octo-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
  } catch {
    return { ok: false, errorKey: 'firstRun.err.notWritable' };
  }
  return { ok: true };
}

/** Default suggestion: Documents\OctoSuite (falls back to home dir). */
export function suggestBaseDir(documentsDir?: string): string {
  return path.join(documentsDir || os.homedir(), 'OctoSuite');
}
