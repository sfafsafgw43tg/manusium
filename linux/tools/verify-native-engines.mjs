#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const allowMissingFirefox = process.argv.includes('--allow-missing-firefox');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-native-verify-'));
const packagedChromium = path.resolve('resources/engines/chromium/155.0.8059.39/inkbrowser-chrome');
const packagedFirefox = path.resolve('resources/engines/gecko/140.0/inkbrowser-firefox');
const candidates = {
  chromium: process.env.OCTO_CHROMIUM_PATH || (fs.existsSync(packagedChromium) ? packagedChromium : (process.platform === 'linux' ? '/usr/bin/chromium' : '')),
  firefox: process.env.OCTO_FIREFOX_PATH || (fs.existsSync(packagedFirefox) ? packagedFirefox : (process.platform === 'linux' ? '/usr/bin/firefox' : '')),
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
function waitForPort(port, child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`debug port ${port} did not open`)), 15000);
    const poll = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { clearTimeout(timeout); socket.destroy(); resolve(); });
      socket.once('error', () => { socket.destroy(); if (child.exitCode === null) setTimeout(poll, 50); });
    };
    child.once('exit', (code, signal) => reject(new Error(`process exited before readiness (${code ?? signal ?? 'unknown'})`)));
    poll();
  });
}
function stopChild(child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    let settled = false;
    const finish = () => { if (settled) return; settled = true; resolve(); };
    const kill = (signal) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { try { child.kill(signal); } catch { /* already gone */ } }
    };
    const timer = setTimeout(() => { kill('SIGKILL'); setTimeout(finish, 1000); }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); finish(); });
    kill('SIGTERM');
  });
}
async function verify(kind, executable) {
  if (!executable || !fs.existsSync(executable)) return { kind, status: 'missing', executable: executable || null };
  const port = await freePort();
  const profile = path.join(root, kind);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  const args = kind === 'chromium'
    ? [`--user-data-dir=${profile}`, '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`, '--remote-allow-origins=*', 'about:blank']
    : ['-profile', profile, '-no-remote', '--headless', '--remote-debugging-port', String(port), 'about:blank'];
  const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], shell: false, detached: true });
  try {
    await waitForPort(port, child);
    await stopChild(child);
    return { kind, status: 'verified', executable, debugPort: port };
  } catch (error) {
    await stopChild(child, 1000);
    throw new Error(`${kind}: ${error.message}`);
  }
}
try {
  const chromium = await verify('chromium', candidates.chromium);
  const firefox = await verify('firefox', candidates.firefox);
  console.log(JSON.stringify({ chromium, firefox }, null, 2));
  if (chromium.status !== 'verified') process.exitCode = 2;
  if (firefox.status === 'missing' && !allowMissingFirefox) process.exitCode = 2;
  if (firefox.status === 'missing') console.error('Firefox/Camoufox was not found; Gecko verification remains blocked on this machine.');
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
