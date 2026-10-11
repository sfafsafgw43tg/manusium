import { describe, expect, it } from 'vitest';
import {
  ANDROID_KEY_CODES, MAX_SCREEN_FAILURES, ScreenStream, keyArgs, nextRotation, parseRotation,
  parseScreenAction, pngDimensions, rotationSetArgs, screencapArgs, tapArgs,
} from '../src/main/android-screen';

/** A PNG header is enough for the size check: signature, IHDR length, "IHDR", width, height. */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe('screen actions', () => {
  it('accepts the toolbar keys, taps, rotation and screenshots', () => {
    expect(parseScreenAction({ kind: 'key', key: 'power' })).toEqual({ kind: 'key', key: 'power' });
    expect(parseScreenAction({ kind: 'key', key: 'recents' })).toEqual({ kind: 'key', key: 'recents' });
    expect(parseScreenAction({ kind: 'tap', x: 0, y: 1079 })).toEqual({ kind: 'tap', x: 0, y: 1079 });
    expect(parseScreenAction({ kind: 'rotate', delta: -1 })).toEqual({ kind: 'rotate', delta: -1 });
    expect(parseScreenAction({ kind: 'shot' })).toEqual({ kind: 'shot' });
  });

  it('refuses unknown keys, prototype names, bad coordinates and other shapes', () => {
    expect(parseScreenAction({ kind: 'key', key: 'constructor' })).toBeNull();
    expect(parseScreenAction({ kind: 'key', key: 'nonsense' })).toBeNull();
    expect(parseScreenAction({ kind: 'tap', x: -1, y: 0 })).toBeNull();
    expect(parseScreenAction({ kind: 'tap', x: 1.5, y: 0 })).toBeNull();
    expect(parseScreenAction({ kind: 'tap', x: 10000, y: 0 })).toBeNull();
    expect(parseScreenAction({ kind: 'tap', x: Number.NaN, y: 0 })).toBeNull();
    expect(parseScreenAction({ kind: 'rotate', delta: 2 })).toBeNull();
    expect(parseScreenAction({ kind: 'shell', cmd: 'rm -rf /' })).toBeNull();
    expect(parseScreenAction(null)).toBeNull();
    expect(parseScreenAction('tap')).toBeNull();
  });

  it('maps keys to the Android key codes the toolbar means', () => {
    expect(ANDROID_KEY_CODES).toMatchObject({ home: 3, back: 4, volumeUp: 24, volumeDown: 25, power: 26, recents: 187 });
  });
});

describe('adb arguments', () => {
  it('builds fixed argument lists with the serial first', () => {
    expect(screencapArgs('emulator-5554')).toEqual(['-s', 'emulator-5554', 'exec-out', 'screencap', '-p']);
    expect(keyArgs('emulator-5554', 'home')).toEqual(['-s', 'emulator-5554', 'shell', 'input', 'keyevent', '3']);
    expect(tapArgs('emulator-5554', 12, 34)).toEqual(['-s', 'emulator-5554', 'shell', 'input', 'tap', '12', '34']);
    expect(rotationSetArgs('emulator-5554', 3)).toEqual(['-s', 'emulator-5554', 'shell', 'settings', 'put', 'system', 'user_rotation', '3']);
  });

  it('reads the rotation quarter, treating "null" and junk as 0', () => {
    expect(parseRotation('2\n')).toBe(2);
    expect(parseRotation('null\n')).toBe(0);
    expect(parseRotation('')).toBe(0);
    expect(parseRotation('7')).toBe(0);
    expect(nextRotation(3, 1)).toBe(0);
    expect(nextRotation(0, -1)).toBe(3);
    expect(nextRotation(1, 1)).toBe(2);
  });
});

describe('PNG size', () => {
  it('reads width and height from the IHDR chunk', () => {
    expect(pngDimensions(pngHeader(1080, 2400))).toEqual({ width: 1080, height: 2400 });
  });

  it('returns null for anything that is not a PNG', () => {
    expect(pngDimensions(Buffer.from('not a png at all, just text'))).toBeNull();
    expect(pngDimensions(pngHeader(0, 10))).toBeNull();
    expect(pngDimensions(Buffer.alloc(10))).toBeNull();
    const notIhdr = pngHeader(5, 5);
    notIhdr.write('JUNK', 12, 'ascii');
    expect(pngDimensions(notIhdr)).toBeNull();
  });
});

/** Fake clock and capture: sleeps resolve at once, so the loop runs as fast as the test wants. */
function fakeDeps(capture: () => Promise<Buffer>) {
  let clock = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    deps: {
      capture,
      sleep: async (ms: number) => { sleeps.push(ms); clock += ms; },
      now: () => clock,
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ScreenStream', () => {
  it('emits a frame per capture and stops when asked', async () => {
    const frames: Array<{ width: number; height: number; png: string }> = [];
    const { deps } = fakeDeps(async () => pngHeader(4, 8));
    const stream = new ScreenStream(deps, (frame) => {
      frames.push(frame);
      if (frames.length === 3) stream.stop();
    }, () => undefined, 0);
    stream.start();
    await flush();
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({ width: 4, height: 8 });
    expect(Buffer.from(frames[0].png, 'base64').subarray(0, 8)).toEqual(pngHeader(4, 8).subarray(0, 8));
    expect(stream.running).toBe(false);
    await flush();
    expect(frames).toHaveLength(3);
  });

  it('waits out the rest of the interval after a slow capture', async () => {
    let calls = 0;
    const { deps, sleeps } = fakeDeps(async () => { calls += 1; return pngHeader(1, 1); });
    const stream = new ScreenStream(deps, () => { if (calls >= 2) stream.stop(); }, () => undefined, 400);
    stream.start();
    await flush();
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((ms) => ms >= 0 && ms <= 400)).toBe(true);
  });

  it('reports a stop after consecutive failures and does not keep trying', async () => {
    let attempts = 0;
    const errors: string[] = [];
    const { deps } = fakeDeps(async () => { attempts += 1; throw new Error('device offline'); });
    const stream = new ScreenStream(deps, () => undefined, (message) => errors.push(message), 0);
    stream.start();
    await flush();
    expect(attempts).toBe(MAX_SCREEN_FAILURES);
    expect(errors).toEqual(['device offline']);
    expect(stream.running).toBe(false);
  });

  it('counts a non-PNG capture as a failure', async () => {
    const errors: string[] = [];
    const { deps } = fakeDeps(async () => Buffer.from('garbage'));
    const stream = new ScreenStream(deps, () => undefined, (message) => errors.push(message), 0);
    stream.start();
    await flush();
    expect(errors[0]).toMatch(/not a PNG/);
  });

  it('never runs two loops at once and ignores a restart while running', async () => {
    let inFlight = 0;
    let peak = 0;
    const { deps } = fakeDeps(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await flush();
      inFlight -= 1;
      return pngHeader(2, 2);
    });
    let count = 0;
    const stream = new ScreenStream(deps, () => { count += 1; if (count === 4) stream.stop(); }, () => undefined, 0);
    stream.start();
    stream.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(peak).toBe(1);
    expect(count).toBe(4);
  });
});
