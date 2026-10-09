/**
 * apps/octobrowser/src/main/android-screen.ts
 *
 * The back end of the device window: a picture of a running emulator's screen
 * and the input its toolbar sends (keys, taps, rotation, screenshots).
 *
 * The picture comes from `adb exec-out screencap -p`, one full PNG per frame,
 * a few times a second. That is much slower than scrcpy and shows the first
 * display only. Every adb call is a fixed argument list; nothing goes through a
 * shell, and the device serial is always the one the emulator reports.
 */
import { execFile } from 'node:child_process';

/** Android key codes the toolbar sends with `input keyevent`. */
export const ANDROID_KEY_CODES = {
  home: 3,
  back: 4,
  volumeUp: 24,
  volumeDown: 25,
  power: 26,
  recents: 187,
} as const;

export type AndroidKey = keyof typeof ANDROID_KEY_CODES;

export type AndroidScreenAction =
  | { kind: 'key'; key: AndroidKey }
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'rotate'; delta: 1 | -1 }
  | { kind: 'shot' };

const MAX_COORDINATE = 10000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_COORDINATE;
}

/** Validates an action sent by the window. Anything unexpected is refused (null). */
export function parseScreenAction(value: unknown): AndroidScreenAction | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.kind === 'key' && typeof v.key === 'string' && Object.prototype.hasOwnProperty.call(ANDROID_KEY_CODES, v.key)) {
    return { kind: 'key', key: v.key as AndroidKey };
  }
  if (v.kind === 'tap' && isCoordinate(v.x) && isCoordinate(v.y)) return { kind: 'tap', x: v.x, y: v.y };
  if (v.kind === 'rotate' && (v.delta === 1 || v.delta === -1)) return { kind: 'rotate', delta: v.delta };
  if (v.kind === 'shot') return { kind: 'shot' };
  return null;
}

/** Width and height from the IHDR chunk of a PNG, or null when the bytes are not one. */
export function pngDimensions(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (png.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

export const screencapArgs = (serial: string): string[] => ['-s', serial, 'exec-out', 'screencap', '-p'];

export const keyArgs = (serial: string, key: AndroidKey): string[] =>
  ['-s', serial, 'shell', 'input', 'keyevent', String(ANDROID_KEY_CODES[key])];

export const tapArgs = (serial: string, x: number, y: number): string[] =>
  ['-s', serial, 'shell', 'input', 'tap', String(x), String(y)];

export const rotationReadArgs = (serial: string): string[] =>
  ['-s', serial, 'shell', 'settings', 'get', 'system', 'user_rotation'];

/** Turns off automatic rotation so the chosen orientation is kept. */
export const rotationLockArgs = (serial: string): string[] =>
  ['-s', serial, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'];

export const rotationSetArgs = (serial: string, quarter: number): string[] =>
  ['-s', serial, 'shell', 'settings', 'put', 'system', 'user_rotation', String(quarter)];

/** `settings get` prints 0-3 (quarter turns) or "null" when unset. Anything else is 0. */
export function parseRotation(text: string): number {
  const value = text.trim();
  return /^[0-3]$/.test(value) ? Number(value) : 0;
}

/** The next quarter turn in the given direction, wrapping at four. */
export function nextRotation(current: number, delta: 1 | -1): number {
  return (((current + delta) % 4) + 4) % 4;
}

/**
 * Runs adb with a fixed argument list and returns stdout as bytes. The error
 * message is the first useful line of adb's stderr, trimmed.
 */
export function execAdb(adb: string, args: string[], timeoutMs = 15000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!adb) {
      reject(new Error('adb not found in the Android SDK'));
      return;
    }
    execFile(adb, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const text = String(stderr ?? '').trim() || error.message;
        reject(new Error(text.split(/\r?\n/).find((line) => line.trim()) ?? 'adb failed'));
        return;
      }
      resolve(stdout as Buffer);
    });
  });
}

export interface ScreenFrame {
  width: number;
  height: number;
  /** The PNG, base64 encoded, as the window shows it. */
  png: string;
}

export interface ScreenStreamDeps {
  capture(): Promise<Buffer>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Consecutive failed captures before the stream gives up and says why. */
export const MAX_SCREEN_FAILURES = 5;

/**
 * Captures frames one after another, never two at once. A frame that cannot be
 * read counts as a failure; after MAX_SCREEN_FAILURES in a row the stream stops
 * and reports the last error. stop() ends the loop after the capture in flight.
 */
export class ScreenStream {
  private active = false;
  private generation = 0;
  private failures = 0;

  constructor(
    private readonly deps: ScreenStreamDeps,
    private readonly onFrame: (frame: ScreenFrame) => void,
    private readonly onError: (message: string) => void,
    private readonly intervalMs = 400,
  ) {}

  get running(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.failures = 0;
    const generation = ++this.generation;
    void this.loop(generation);
  }

  stop(): void {
    this.active = false;
    this.generation += 1;
  }

  private current(generation: number): boolean {
    return this.active && generation === this.generation;
  }

  private async loop(generation: number): Promise<void> {
    while (this.current(generation)) {
      const started = this.deps.now();
      try {
        const png = await this.deps.capture();
        const size = pngDimensions(png);
        if (!size) throw new Error('the screen capture was not a PNG');
        this.failures = 0;
        if (this.current(generation)) this.onFrame({ ...size, png: png.toString('base64') });
      } catch (error) {
        if (!this.current(generation)) break;
        this.failures += 1;
        if (this.failures >= MAX_SCREEN_FAILURES) {
          this.active = false;
          this.onError(error instanceof Error ? error.message : String(error));
          break;
        }
      }
      if (!this.current(generation)) break;
      await this.deps.sleep(Math.max(0, this.intervalMs - (this.deps.now() - started)));
    }
  }
}
