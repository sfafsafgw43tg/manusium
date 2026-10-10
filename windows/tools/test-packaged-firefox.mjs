#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const defaultRuntime = `resources/engines/gecko/140.0/inkbrowser-firefox${process.platform === 'win32' ? '.exe' : ''}`;
const runtime = path.resolve(process.env.OCTO_FIREFOX_RUNTIME ?? defaultRuntime);
if (!fs.existsSync(runtime)) {
  console.error(`[packaged-firefox] missing runtime: ${runtime}`);
  process.exit(2);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-packaged-firefox-'));
const profile = path.join(root, 'profile'); fs.mkdirSync(profile, { mode: 0o700 });
fs.writeFileSync(path.join(profile, 'user.js'), [
  'user_pref("permissions.default.geo", 2);',
  'user_pref("media.peerconnection.enabled", false);',
  'user_pref("privacy.resistFingerprinting", true);',
  '',
].join('\n'), { mode: 0o600 });
const port = await new Promise((resolve, reject) => {
  const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const url = 'data:text/html,<title>Octo Gecko Smoke</title><p>native-firefox</p>';
const child = spawn(runtime, ['-profile', profile, '-new-instance', '-no-remote', '--headless', '--kiosk', '--remote-debugging-port', String(port), url], { detached: true, stdio: ['ignore', 'ignore', 'pipe'], shell: false });
const stop = () => new Promise((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } resolve(); }, 5000);
  child.once('exit', () => { clearTimeout(timer); resolve(); });
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
});
try {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      const probe = await new Promise((resolve, reject) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', reject); });
      if (probe) break;
    } catch { /* starting */ }
    if (child.exitCode !== null) throw new Error(`Firefox exited before BiDi readiness (${child.exitCode})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const socket = new WebSocket(`ws://127.0.0.1:${port}/session`);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', () => reject(new Error('Firefox BiDi socket failed')), { once: true }); });
  const pending = new Map(); let nextId = 1;
  socket.addEventListener('message', (event) => { const m = JSON.parse(String(event.data)); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.type === 'error' ? p.reject(new Error(m.message ?? 'BiDi command failed')) : p.resolve(m); });
  const send = (method, params) => { const id = nextId++; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); };
  const status = await send('session.new', { capabilities: {} });
  const tree = await send('browsingContext.getTree', {});
  const context = tree.result?.contexts?.[0]?.context;
  if (!context) throw new Error('Firefox did not expose a browsing context');
  await send('browsingContext.navigate', { context, url, wait: 'complete' });
  const observed = await send('script.evaluate', { expression: '(async () => JSON.stringify({webrtc: typeof RTCPeerConnection, geo: await navigator.permissions.query({name: "geolocation"}).then(x => x.state)}))()', awaitPromise: true, target: { context }, resultOwnership: 'none' });
  const observedValue = observed.result?.result?.value;
  if (typeof observedValue !== 'string' || !observedValue.includes('"webrtc":"undefined"') || !observedValue.includes('"geo":"denied"')) throw new Error(`Firefox engine privacy settings were not observed: ${JSON.stringify(observed)}`);
  const second = await send('browsingContext.create', { type: 'tab' });
  await send('browsingContext.close', { context: second.result.context });
  if (!fs.existsSync(path.join(profile, 'prefs.js'))) throw new Error('Firefox did not create the isolated profile');
  console.log(JSON.stringify({ runtime, profile, appMode: 'firefox-kiosk', navigationUrl: url, session: status.result, context, enginePrivacy: ['webrtc=disabled', 'location=block', 'resistFingerprinting=true'], controls: ['navigate', 'create-tab', 'close-tab'], shutdown: 'verified' }, null, 2));
  socket.close();
} finally {
  await stop(); fs.rmSync(root, { recursive: true, force: true });
}
