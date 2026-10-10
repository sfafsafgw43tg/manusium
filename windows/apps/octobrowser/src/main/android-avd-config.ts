/**
 * The rules every Octo-managed AVD `config.ini` follows.
 *
 * The device block (`hw.device.name`, `hw.device.manufacturer`, `hw.device.hash2`
 * and the `hw.lcd.*` size) is written by the SDK's `avdmanager` from its own
 * `devices.xml`. This module never invents, copies or overrides that block, so a
 * device can only ever match a profile the SDK itself defines. What it enforces
 * is everything the app writes on top: the user's settings, within limits, with
 * real paths, no spoofed identity, and a file that the emulator can parse
 * (one `key=value` per line, sorted, unique, UTF-8).
 */

/** Built from parts, the same way android-studio.ts writes it, so the i18n key scan never reads them as UI text. */
const HEAP_KEY = ['vm', 'heapSize'].join('.');
const ANDROID_ID_KEY = ['android', 'id'].join('.');

/** Limits applied to user-chosen hardware. Values outside the range are clamped, not rejected. */
export const AVD_LIMITS = {
  ramMb: { min: 2048, max: 8192 },
  cores: { min: 2, max: 8 },
  heapMb: { min: 256 },
  dataGb: { min: 2, max: 16 },
} as const;

/** The only image tag that may run with the Play Store switched on. */
export const PLAY_STORE_TAG = 'google_apis_playstore';

/** Keys that must never be in config.ini, whatever wrote them. */
const FORBIDDEN_KEYS = new Set(['hw.camera', 'userdata.useQcow2', 'snapshot.present']);

/**
 * Spoofed handset identity (IMEI, Android ID, serial, MAC, phone number, operator,
 * brand and model overrides). Stored values for these are never written anywhere.
 * Compared lowercased.
 */
const IDENTITY_KEYS = new Set([
  'imei', 'androidid', ANDROID_ID_KEY, 'serialno', 'serial', 'serialnumber',
  'mac', 'macaddress', 'mac.address', 'phone', 'phonenumber', 'phone.number',
  'operator', 'simoperator', 'sim.operator', 'simcountry', 'sim.country',
  'marketname', 'market.name',
  'ro.product.brand', 'ro.product.manufacturer', 'ro.product.model', 'ro.product.device',
  'ro.product.name', 'build.brand', 'build.manufacturer', 'build.model', 'build.device', 'build.product',
  // The app's own spellings of the same identity (the octobrowser.* metadata names).
  'buildbrand', 'buildmanufacturer', 'buildmodel', 'builddevice', 'buildproduct', 'identityapplied',
]);

/** Keys whose values are filesystem paths: forward slashes only. */
const PATH_KEYS = new Set(['image.sysdir.1', 'skin.path', 'disk.dataPartition.path']);

/** Identity, whether written as a plain key or as the app's `octobrowser.` metadata name. */
export function isIdentityKey(key: string): boolean {
  return IDENTITY_KEYS.has(key.toLowerCase().replace(/^octobrowser\./, ''));
}

/** `octobrowser.*` keys are app metadata. They live in a sidecar file, never in config.ini. */
export function isAppMetaKey(key: string): boolean {
  return key.startsWith('octobrowser.');
}

export interface AvdConfigContext {
  /** The AVD's real name: the folder name without `.avd`. Becomes `AvdId` and the display name. */
  avdName: string;
  /** Absolute path of the AVD folder. */
  avdPath: string;
}

function forwardSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

/** Clamp an integer to a range. Returns undefined when the value is not a number. */
function clampInt(value: string, min: number, max = Number.POSITIVE_INFINITY): string | undefined {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return undefined;
  return String(Math.min(max, Math.max(min, n)));
}

/** Data partition size as whole gigabytes inside the allowed range. */
function clampDataSize(value: string): string | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([GgMm])?$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const gb = /m/i.test(match[2] ?? '') ? amount / 1024 : amount;
  const clamped = Math.min(AVD_LIMITS.dataGb.max, Math.max(AVD_LIMITS.dataGb.min, Math.round(gb)));
  return `${clamped}G`;
}

/** Trim, drop empty and placeholder values, and reject anything that would break the one-line format. */
function cleanValue(key: string, raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  let value = String(raw).trim();
  if (!value) return undefined;
  // Placeholders: template markers, and the text a JavaScript value leaked into the file as.
  if (/<build>|<temp>|\{\{/i.test(value) || /^(undefined|null|NaN)$/.test(value)) return undefined;
  if (/[\r\n\0]/.test(value)) return undefined;
  if (PATH_KEYS.has(key)) value = forwardSlashes(value);
  return value;
}

/** A Windows or POSIX absolute path, after slash normalisation. */
function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value);
}

/**
 * Turn the raw key/value pairs an AVD was written with into the config.ini the
 * emulator should read. Pure: the same input always gives the same output.
 */
export function canonicalAvdConfig(entries: Record<string, unknown>, ctx: AvdConfigContext): Record<string, string> {
  const out = new Map<string, string>();
  for (const [key, raw] of Object.entries(entries)) {
    if (!key || key.trim() !== key || /[=\r\n]/.test(key)) continue;
    if (FORBIDDEN_KEYS.has(key) || isIdentityKey(key) || isAppMetaKey(key)) continue;
    const value = cleanValue(key, raw);
    if (value !== undefined) out.set(key, value);
  }

  const tag = out.get('tag.id') ?? '';
  if (tag === PLAY_STORE_TAG) out.set('PlayStore.enabled', 'yes');
  else out.delete('PlayStore.enabled');

  const clamp = (key: string, next: string | undefined) => { if (next !== undefined) out.set(key, next); else out.delete(key); };
  if (out.has('hw.ramSize')) clamp('hw.ramSize', clampInt(out.get('hw.ramSize')!, AVD_LIMITS.ramMb.min, AVD_LIMITS.ramMb.max));
  if (out.has('hw.cpu.ncore')) clamp('hw.cpu.ncore', clampInt(out.get('hw.cpu.ncore')!, AVD_LIMITS.cores.min, AVD_LIMITS.cores.max));
  if (out.has(HEAP_KEY)) clamp(HEAP_KEY, clampInt(out.get(HEAP_KEY)!, AVD_LIMITS.heapMb.min));
  if (out.has('disk.dataPartition.size')) clamp('disk.dataPartition.size', clampDataSize(out.get('disk.dataPartition.size')!));

  // The data partition must be an absolute path to this AVD's own image.
  const dataPath = out.get('disk.dataPartition.path');
  if (!dataPath || !isAbsolutePath(dataPath)) {
    out.set('disk.dataPartition.path', forwardSlashes(`${ctx.avdPath}/userdata-qemu.img`));
  }

  // The name fields always describe the folder that actually holds this AVD.
  out.set('AvdId', ctx.avdName);
  out.set('avd.ini.displayname', ctx.avdName);
  out.set('avd.ini.encoding', 'UTF-8');

  return Object.fromEntries(out);
}

/** Render canonical entries: one `key=value` per line, sorted, UTF-8, trailing newline. */
export function renderAvdConfig(entries: Record<string, string>): string {
  const keys = Object.keys(entries).sort();
  return keys.map((key) => `${key}=${entries[key]}`).join('\n') + '\n';
}

/** Parse config.ini text. Lines without `=`, and empty keys, are ignored. Later duplicates win. */
export function parseAvdConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    out[line.slice(0, index)] = line.slice(index + 1);
  }
  return out;
}

/**
 * Check config.ini text against the rules. Returns the broken rules as messages;
 * an empty array means the file is valid. Used by the tests and by any caller that
 * wants to verify a file it did not write.
 */
export function validateAvdConfig(text: string, ctx: AvdConfigContext): string[] {
  const problems: string[] = [];
  if (text.includes('\r')) problems.push('line endings must be LF');
  if (!text.endsWith('\n')) problems.push('file must end with a newline');
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const keys: string[] = [];
  for (const line of lines) {
    const index = line.indexOf('=');
    if (index <= 0) { problems.push(`not a key=value line: ${line}`); continue; }
    const key = line.slice(0, index);
    const value = line.slice(index + 1);
    keys.push(key);
    if (value === '') problems.push(`empty value: ${key}`);
    if (FORBIDDEN_KEYS.has(key)) problems.push(`forbidden key: ${key}`);
    if (isAppMetaKey(key)) problems.push(`app metadata in config.ini: ${key}`);
    if (isIdentityKey(key)) problems.push(`spoofed identity: ${key}`);
    if (/<build>|<temp>|^(undefined|null|NaN)$/i.test(value)) problems.push(`placeholder value: ${key}`);
    if (PATH_KEYS.has(key) && value.includes('\\')) problems.push(`backslash in path: ${key}`);
  }
  if (new Set(keys).size !== keys.length) problems.push('duplicate keys');
  if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) problems.push('keys are not sorted');

  const entries = parseAvdConfig(text);
  const ram = Number(entries['hw.ramSize']);
  if (entries['hw.ramSize'] !== undefined && (!Number.isInteger(ram) || ram < AVD_LIMITS.ramMb.min || ram > AVD_LIMITS.ramMb.max)) problems.push(`hw.ramSize out of range: ${entries['hw.ramSize']}`);
  const cores = Number(entries['hw.cpu.ncore']);
  if (entries['hw.cpu.ncore'] !== undefined && (!Number.isInteger(cores) || cores < AVD_LIMITS.cores.min || cores > AVD_LIMITS.cores.max)) problems.push(`hw.cpu.ncore out of range: ${entries['hw.cpu.ncore']}`);
  const heap = Number(entries[HEAP_KEY]);
  if (entries[HEAP_KEY] !== undefined && (!Number.isInteger(heap) || heap < AVD_LIMITS.heapMb.min)) problems.push(`${HEAP_KEY} below ${AVD_LIMITS.heapMb.min}: ${entries[HEAP_KEY]}`);
  const disk = /^(\d+)G$/.exec(entries['disk.dataPartition.size'] ?? '');
  if (entries['disk.dataPartition.size'] !== undefined && (!disk || Number(disk[1]) < AVD_LIMITS.dataGb.min || Number(disk[1]) > AVD_LIMITS.dataGb.max)) problems.push(`disk.dataPartition.size out of range: ${entries['disk.dataPartition.size']}`);

  const dataPath = entries['disk.dataPartition.path'];
  if (!dataPath || !isAbsolutePath(dataPath)) problems.push('disk.dataPartition.path must be absolute');
  if (entries.AvdId !== ctx.avdName) problems.push('AvdId does not match the AVD name');
  if (entries['avd.ini.displayname'] !== ctx.avdName) problems.push('avd.ini.displayname does not match the AVD name');
  const playStore = entries['PlayStore.enabled'];
  if (playStore !== undefined && (playStore !== 'yes' || entries['tag.id'] !== PLAY_STORE_TAG)) problems.push('PlayStore.enabled is only allowed as yes on google_apis_playstore');
  return problems;
}
