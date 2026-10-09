import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { CdpPage, NativeChromiumTabs, NativeEngineProcess, spawnNativeEngine } from '../src/native-engine';
import { discoverEngineRuntime } from '../src/engine-runtime';
import { prepareChromiumPrivacy } from '../src/engine-privacy';

const packagedRoot = process.env.OCTO_PACKAGED_CHROMIUM_ROOT;
const packaged = packagedRoot ? discoverEngineRuntime('chromium', { resourcesPath: '/does-not-exist', env: { OCTO_CHROMIUM_RUNTIME: packagedRoot }, platform: process.platform, arch: process.arch }) : undefined;
const executable = packaged?.executablePath || process.env.OCTO_CHROMIUM_PATH || '/usr/bin/chromium';
const available = fs.existsSync(executable);
const suite = available ? describe : describe.skip;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('No ephemeral port')); return; }
      server.close(() => resolve(address.port));
    });
  });
}

suite('real Chromium CDP vertical slice', () => {
  let processUnderTest: NativeEngineProcess | undefined;
  let page: CdpPage | undefined;
  let tabs: NativeChromiumTabs | undefined;
  const roots: string[] = [];

  afterEach(async () => {
    await page?.close();
    await tabs?.close();
    await processUnderTest?.stop();
    page = undefined;
    tabs = undefined;
    processUnderTest = undefined;
    while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
  });

  it('launches an isolated real Chromium process and controls one page navigation', async () => {
    if (packaged) expect(executable.startsWith(`${packaged.rootDir}${path.sep}`)).toBe(true);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-cdp-test-'));
    roots.push(root);
    const port = await freePort();
    prepareChromiumPrivacy(path.join(root, 'profile'), { webRtc: 'disable-non-proxied-udp', location: 'block' });
    processUnderTest = await spawnNativeEngine('chromium', executable, {
      profileDir: path.join(root, 'profile'),
      debugPort: port,
      headless: true,
      url: 'about:blank',
      extraArgs: ['--no-sandbox', '--disable-gpu'],
    });
    page = await CdpPage.connect(port);
    await page.navigate('data:text/html,<title>Native%20Chromium</title><h1>native</h1>');
    let state = await page.state();
    for (let i = 0; i < 40 && state.title !== 'Native Chromium'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      state = await page.state();
    }
    expect(state.title).toBe('Native Chromium');
    expect(state.url).toContain('data:text/html');
    const probe = await page.command('Runtime.evaluate', { expression: 'JSON.stringify({webrtc: typeof RTCPeerConnection})', returnByValue: true });
    expect((probe.result?.result as { value?: string } | undefined)?.value).toContain('webrtc');
  });

  it('launches the real Chromium process in App window mode', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-cdp-app-mode-'));
    roots.push(root);
    const port = await freePort();
    processUnderTest = await spawnNativeEngine('chromium', executable, {
      profileDir: path.join(root, 'profile'), debugPort: port, headless: true, appMode: true,
      url: 'data:text/html,<title>Native%20App%20Mode</title><h1>app</h1>',
      extraArgs: ['--no-sandbox', '--disable-gpu'],
    });
    page = await CdpPage.connect(port);
    const state = await page.state();
    expect(state.title).toBe('Native App Mode');
  });

  it('surfaces a renderer/process crash as a closed native process', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-cdp-crash-'));
    roots.push(root);
    const port = await freePort();
    processUnderTest = await spawnNativeEngine('chromium', executable, {
      profileDir: path.join(root, 'profile'),
      debugPort: port,
      headless: true,
      url: 'about:blank',
      extraArgs: ['--no-sandbox', '--disable-gpu'],
    });
    page = await CdpPage.connect(port);
    const exited = new Promise<number | null>((resolve) => processUnderTest!.child.once('exit', (code) => resolve(code)));
    await processUnderTest.stop();
    expect(await exited).not.toBeNull();
    await page.close();
    await expect(page.state()).rejects.toThrow(/closed|failed|WebSocket|CDP/i);
  });

  it('opens, navigates, switches, closes a tab, and shuts down cleanly', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-cdp-tabs-'));
    roots.push(root);
    const port = await freePort();
    processUnderTest = await spawnNativeEngine('chromium', executable, {
      profileDir: path.join(root, 'profile'), debugPort: port, headless: true, url: 'about:blank',
      extraArgs: ['--no-sandbox', '--disable-gpu'],
    });
    tabs = await NativeChromiumTabs.connect(port);
    const initial = (await tabs.tabs())[0];
    expect(initial).toBeDefined();
    await tabs.navigate(initial!.id, 'data:text/html,<title>First%20Tab</title><h1>first</h1>');
    const second = await tabs.newTab('data:text/html,<title>Second%20Tab</title><h1>second</h1>');
    expect((await tabs.tabs()).length).toBe(2);
    await tabs.activateTab(initial!.id);
    expect((await tabs.state(initial!.id)).title).toBe('First Tab');
    await tabs.closeTab(second.id);
    expect((await tabs.tabs()).map((tab) => tab.id)).toEqual([initial!.id]);
    const exited = new Promise<number | null>((resolve) => processUnderTest!.child.once('exit', (code) => resolve(code)));
    await processUnderTest.stop();
    expect(await exited).not.toBeNull();
  });
});
