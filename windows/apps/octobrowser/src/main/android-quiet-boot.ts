/**
 * The quiet first boot a new Android device gets, and the emulator arguments it
 * needs. The emulator, adb, the file checks and the clock are passed in, so the
 * sequence is tested without an SDK. Nothing here writes device identity values.
 *
 * Order matters: the device is started with no window, we wait for adb and for
 * Android to finish booting, the device is closed with `adb emu kill`, and only
 * then are the files it left behind checked. Files are never touched while the
 * emulator process is still running.
 */

export interface QuietBootDeps {
  /** Start the emulator. `exited` settles once the process is gone; `kill` ends it if it is still there. */
  start(args: string[]): { exited: Promise<number | null>; kill(): void };
  /** Run adb with arguments and resolve its stdout. Rejects on failure or timeout. */
  adb(args: string[], timeoutMs: number): Promise<string>;
  /** Problems the device's files have now, as messages (empty when all is well). */
  inspect(): string[];
  /** Repair what can be repaired, given the problems that were found. */
  repair(problems: string[]): void;
  /** One line for the download bar. percent is 0-100, or -1 when unknown. */
  progress(text: string, percent: number): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface QuietBootOptions {
  name: string;
  /** Extra emulator arguments (-no-metrics, -phone-number), already checked against the emulator's help. */
  extraArgs?: readonly string[];
  attachMs?: number;
  bootMs?: number;
}

export interface QuietBootResult {
  /** Android reported that it finished booting. */
  booted: boolean;
  /** The adb serial of this device, or '' when it never attached. */
  serial: string;
  /** Problems that are still there after the repair, plus anything that went wrong. */
  issues: string[];
  /** Problems that were found and fixed in place. */
  repaired: string[];
}

export const QUIET_BOOT_ATTACH_MS = 3 * 60_000;
export const QUIET_BOOT_BOOT_MS = 15 * 60_000;
const POLL_MS = 3_000;
const CLOSE_MS = 60_000;
const AVD_PROPERTY = ['ro', 'boot', 'qemu', 'avd_name'].join('.');
const BOOT_PROPERTY = 'sys.boot_completed';

/** No window, no audio, and no snapshot written on exit. */
export function quietBootArgs(name: string, extraArgs: readonly string[] = []): string[] {
  return [`@${name}`, '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot-save', ...extraArgs];
}

/** A telephony number is 3 to 15 digits, with an optional leading +. */
export function validTelephoneNumber(value: string): boolean {
  return /^\+?\d{3,15}$/.test(value.trim());
}

/** Whether this emulator build lists `-phone-number` in its help. */
export function telephonySupported(helpText: string): boolean {
  return /(^|\s)-phone-number(?![\w-])/m.test(helpText);
}

/** The telephony argument for this emulator, or nothing when the number is empty or the build cannot take it. */
export function telephonyArgsIn(helpText: string, number: string): string[] {
  const value = number.trim();
  if (!value) return [];
  if (!validTelephoneNumber(value)) throw new Error('The telephony number must be 3 to 15 digits, with an optional leading +.');
  return telephonySupported(helpText) ? ['-phone-number', value] : [];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function attachedSerial(deps: QuietBootDeps, name: string): Promise<string> {
  const listing = await deps.adb(['devices'], 10_000).catch(() => '');
  for (const line of listing.split(/\r?\n/)) {
    const match = /^(emulator-\d+)\s+device$/.exec(line.trim());
    if (!match) continue;
    const avd = (await deps.adb(['-s', match[1], 'shell', 'getprop', AVD_PROPERTY], 8_000).catch(() => '')).trim();
    if (avd === name) return match[1];
  }
  return '';
}

/**
 * Boot the device once with no window, wait for Android to finish, close it, then
 * check and repair the files it created. Never throws: a failure is returned as an
 * issue, and the emulator is always closed.
 */
export async function quietBoot(deps: QuietBootDeps, options: QuietBootOptions): Promise<QuietBootResult> {
  const { name } = options;
  const issues: string[] = [];
  const repaired: string[] = [];
  let serial = '';
  let booted = false;
  let exited = false;
  deps.progress(`Starting ${name} with no window to finish its first setup`, -1);
  let emulator: ReturnType<QuietBootDeps['start']> | null = null;
  try {
    emulator = deps.start(quietBootArgs(name, options.extraArgs ?? []));
    const started = emulator;
    started.exited.then(() => { exited = true; }, () => { exited = true; });
    const attachUntil = deps.now() + (options.attachMs ?? QUIET_BOOT_ATTACH_MS);
    while (!serial && !exited && deps.now() < attachUntil) {
      await deps.adb(['wait-for-device'], 15_000).catch(() => '');
      serial = await attachedSerial(deps, name);
      if (!serial && !exited) await deps.sleep(POLL_MS);
    }
    if (!serial) {
      issues.push(exited ? 'The emulator stopped before this device attached.' : 'The emulator did not attach to this device in time.');
    } else {
      deps.progress('Waiting for Android to finish booting', -1);
      const bootUntil = deps.now() + (options.bootMs ?? QUIET_BOOT_BOOT_MS);
      while (!booted && !exited && deps.now() < bootUntil) {
        const value = await deps.adb(['-s', serial, 'shell', 'getprop', BOOT_PROPERTY], 10_000).catch(() => '');
        booted = value.trim() === '1';
        if (!booted && !exited) await deps.sleep(POLL_MS);
      }
      if (!booted) issues.push(exited ? 'The emulator stopped before Android finished booting.' : 'Android did not finish booting in time.');
    }
  } catch (error) {
    issues.push(messageOf(error));
  } finally {
    deps.progress(`Closing ${name}`, -1);
    if (serial) await deps.adb(['-s', serial, 'emu', 'kill'], 20_000).catch(() => '');
    if (emulator) {
      if (!exited) await Promise.race([emulator.exited, deps.sleep(CLOSE_MS)]);
      if (!exited) {
        emulator.kill();
        await Promise.race([emulator.exited, deps.sleep(CLOSE_MS)]);
      }
    }
  }
  // Files are only read or written once the emulator is gone.
  const closed = !emulator || exited;
  if (!closed) {
    issues.push('The emulator did not close in time, so the device files were not checked.');
  } else {
    try {
      deps.progress('Checking the files this device created', -1);
      const found = deps.inspect();
      if (found.length) {
        deps.repair(found);
        const remaining = deps.inspect();
        issues.push(...remaining);
        repaired.push(...found.filter((problem) => !remaining.includes(problem)));
      }
    } catch (error) {
      issues.push(messageOf(error));
    }
  }
  deps.progress(issues.length
    ? `${name} is set up, with ${issues.length} file issue${issues.length === 1 ? '' : 's'} to check`
    : `${name} is set up`, 100);
  return { booted, serial, issues, repaired };
}
