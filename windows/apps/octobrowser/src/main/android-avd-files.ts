/**
 * Checks the files a created AVD leaves behind: the `<name>.ini` pointer that
 * Android Studio and `emulator @name` follow, the config.ini it points to, and the
 * emulator's own cache, hardware-qemu.ini.
 *
 * The checks are pure. The pointer and config.ini repairs are in android-studio.ts,
 * and they are deliberately narrow: a pointer that names the wrong folder is
 * rewritten, and an existing config.ini is brought back to the rules. A missing
 * config.ini is never invented, because a config with no device block cannot match
 * a devices.xml profile. The cache repair works in place and never deletes the file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isAppMetaKey, isIdentityKey, parseAvdConfig, validateAvdConfig } from './android-avd-config';

export interface AvdFileProblem {
  /** The file the problem is in, relative to where it lives. */
  file: string;
  problem: string;
}

/** Same folder once slashes are normalised (the pointer may hold either style on Windows). */
function sameFolder(a: string, b: string): boolean {
  const norm = (value: string) => path.resolve(value.replace(/\\/g, '/')).replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(a).toLowerCase() === norm(b).toLowerCase();
}

/** The `path=` the pointer names, or undefined when there is none. */
export function pointerPath(pointerText: string): string | undefined {
  const line = pointerText.split(/\r?\n/).find((entry) => entry.startsWith('path='));
  return line ? line.slice('path='.length).trim() : undefined;
}

/** Problems with a `<name>.ini` pointer: missing, unreadable, or naming another folder. */
export function inspectAvdPointer(name: string, pointerText: string | undefined, avdPath: string): AvdFileProblem[] {
  const file = `${name}.ini`;
  if (pointerText === undefined) return [{ file, problem: 'pointer is missing, so the device is invisible to the emulator and Android Studio' }];
  const named = pointerPath(pointerText);
  if (!named) return [{ file, problem: 'pointer has no path= line' }];
  if (!sameFolder(named, avdPath)) return [{ file, problem: `pointer names ${named}, but the device is in ${avdPath}` }];
  return [];
}

/** Problems with the AVD folder: config.ini must exist and follow the rules. */
export function inspectAvdFolder(name: string, avdPath: string): AvdFileProblem[] {
  const configFile = path.join(avdPath, 'config.ini');
  if (!fs.existsSync(configFile)) return [{ file: 'config.ini', problem: 'missing, so the device cannot boot' }];
  const text = fs.readFileSync(configFile, 'utf8');
  return validateAvdConfig(text, { avdName: name, avdPath }).map((problem) => ({ file: 'config.ini', problem }));
}

const HARDWARE_CACHE = 'hardware-qemu.ini';
/** Camera keys the emulator copies from config.ini into its cache. A stale copy names a camera that is gone. */
const CAMERA_CACHE_KEYS: readonly string[] = ['hw.camera.back', 'hw.camera.front'];

function readOptional(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

/** Keys the emulator cache must never carry: spoofed identity and app metadata. */
function foreignKey(key: string): boolean {
  return isIdentityKey(key) || isAppMetaKey(key);
}

/**
 * Problems in hardware-qemu.ini. Nothing is checked before the first boot, when
 * the emulator has not written the file yet. Camera keys are compared with config.ini
 * only when config.ini exists.
 */
export function hardwareCacheProblems(hardwareText: string | undefined, configText: string | undefined): AvdFileProblem[] {
  if (hardwareText === undefined) return [];
  const cache = parseAvdConfig(hardwareText);
  const problems: AvdFileProblem[] = [];
  for (const key of Object.keys(cache)) {
    if (foreignKey(key)) problems.push({ file: HARDWARE_CACHE, problem: `value that must not be in the emulator cache: ${key}` });
  }
  if (configText !== undefined) {
    const config = parseAvdConfig(configText);
    for (const key of CAMERA_CACHE_KEYS) {
      if (cache[key] !== undefined && cache[key] !== config[key]) {
        problems.push({ file: HARDWARE_CACHE, problem: `${key} is ${cache[key]} but config.ini says ${config[key] ?? 'nothing'}` });
      }
    }
  }
  return problems;
}

/**
 * The cache text with foreign keys removed and camera keys set to config.ini's
 * values. Lines that are not key=value are kept exactly as they were.
 */
export function repairHardwareCacheText(hardwareText: string, configText: string | undefined): { text: string; changed: string[] } {
  const config = configText === undefined ? undefined : parseAvdConfig(configText);
  const changed: string[] = [];
  const out: string[] = [];
  for (const line of hardwareText.split(/\r?\n/)) {
    const index = line.indexOf('=');
    if (index <= 0) { out.push(line); continue; }
    const key = line.slice(0, index);
    if (foreignKey(key)) { changed.push(key); continue; }
    if (config !== undefined && CAMERA_CACHE_KEYS.includes(key)) {
      const want = config[key];
      if (want === undefined) { changed.push(key); continue; }
      if (want !== line.slice(index + 1)) { changed.push(key); out.push(`${key}=${want}`); continue; }
    }
    out.push(line);
  }
  return { text: out.join('\n'), changed };
}

/** Problems in the emulator's cache inside an AVD folder. */
export function inspectHardwareCache(avdPath: string): AvdFileProblem[] {
  return hardwareCacheProblems(readOptional(path.join(avdPath, HARDWARE_CACHE)), readOptional(path.join(avdPath, 'config.ini')));
}

/**
 * Repair the cache in place. Only call this once the emulator has exited, because
 * it rewrites a file the emulator owns. Returns the keys that were changed.
 */
export function repairHardwareCache(avdPath: string): string[] {
  const file = path.join(avdPath, HARDWARE_CACHE);
  const current = readOptional(file);
  if (current === undefined) return [];
  const next = repairHardwareCacheText(current, readOptional(path.join(avdPath, 'config.ini')));
  if (next.changed.length) fs.writeFileSync(file, next.text, { mode: 0o600 });
  return next.changed;
}
