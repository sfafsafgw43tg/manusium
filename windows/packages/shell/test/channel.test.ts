/**
 * packages/shell/test/channel.test.ts - manager<->profile channel over the inherited fd-3 pipe.
 *
 * Runs the real channel.ts in a real child process (compiled with esbuild),
 * exactly the way the manager spawns profile processes: stdin is NOT used
 * (Electron on Windows replaces process.stdin with an EOF-only stream), and
 * the data key and all messages travel over Node's private IPC channel.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { buildSync } from 'esbuild';
import { JsonLineChannel, channelStdio, openParentChannel, type Message, type MessageChannel } from '../src/channel';

/** Bundle channel.ts + a tiny echo child into one CommonJS file. */
function buildChild(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-channel-'));
  const entry = path.join(dir, 'child.ts');
  const channelSrc = path.resolve(__dirname, '../src/channel.ts').replace(/\\/g, '/');
  fs.writeFileSync(
    entry,
    `import { openChildChannel } from '${channelSrc}';
     let ch;
     try { ch = openChildChannel(); } catch { process.exit(3); }
     ch.onMessage((m) => {
       if (m.t === 'init') ch.send({ t: 'ready', keyLength: Buffer.from(String(m.key), 'base64').length });
       if (m.t === 'quit') { ch.send({ t: 'bye' }); setTimeout(() => process.exit(0), 50); }
     });
     ch.send({ t: 'channel-ready' });`,
  );
  const out = path.join(dir, 'child.js');
  buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  return out;
}

function nextMessage(ch: MessageChannel, type: string, timeoutMs = 10_000): Promise<Message> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} message`)), timeoutMs);
    ch.onMessage((m) => {
      if (m.t === type) {
        clearTimeout(timer);
        resolve(m);
      }
    });
  });
}

describe('profile manager IPC channel', () => {
  it('delivers the key and messages both ways without stdin/stdout', async () => {
    const child = spawn(process.execPath, [buildChild()], { stdio: channelStdio(false) });
    const ch = openParentChannel(child);
    await nextMessage(ch, 'channel-ready');
    const ready = nextMessage(ch, 'ready');
    ch.send({ t: 'init', key: Buffer.alloc(32, 7).toString('base64') });
    expect((await ready).keyLength).toBe(32);
    const bye = nextMessage(ch, 'bye');
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    ch.send({ t: 'quit' });
    await bye;
    expect(await exited).toBe(0);
  }, 30_000);

  it('the child exits with code 3 when it was not started with a channel', async () => {
    const child = spawn(process.execPath, [buildChild()], { stdio: 'ignore' });
    const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    expect(code).toBe(3);
  }, 30_000);

  it('does not lose a message received before the first listener subscribes', async () => {
    const input = new PassThrough();
    const ch = new JsonLineChannel(input, new PassThrough());
    input.write('{"t":"init","key":"early"}\n');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const received = new Promise<Message>((resolve) => ch.onMessage(resolve));
    await expect(received).resolves.toMatchObject({ t: 'init', key: 'early' });
  });

  it('a vanished peer closes the channel instead of throwing', async () => {
    const a = new PassThrough();
    const ch = new JsonLineChannel(a, a);
    const closed = new Promise<void>((r) => ch.onClose(r));
    a.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
    await closed;
    expect(ch.isClosed).toBe(true);
    expect(() => ch.send({ t: 'x' })).not.toThrow();
  });

  it('ignores malformed and oversized lines', () => {
    const input = new PassThrough();
    const ch = new JsonLineChannel(input, new PassThrough());
    const got: Message[] = [];
    ch.onMessage((m) => got.push(m));
    input.write('not json\n{"no":"type"}\n{"t":"ok"}\n');
    input.write('x'.repeat(5 * 1024 * 1024));
    input.write('\n{"t":"after"}\n');
    return new Promise<void>((resolve) => setImmediate(() => {
      expect(got.map((m) => m.t)).toEqual(['ok', 'after']);
      resolve();
    }));
  });
});
