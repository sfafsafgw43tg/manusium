/**
 * Local Electron graphics observation. Run with OCTO_ELECTRON_BINARY pointing
 * at the built Electron executable; ordinary Vitest runs skip this because
 * they do not have an Electron application host.
 */
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const electronBinary = process.env.OCTO_ELECTRON_BINARY;
const enabled = !!electronBinary && process.env.OCTO_ELECTRON_INTEGRATION === '1';

type Observation = {
  webgl: boolean;
  webgl2: boolean;
  debugRenderer: boolean;
  gpu: 'missing' | 'adapter' | 'null' | 'error';
  workerWebgl: boolean | null;
};

const child = String.raw`
const { app, BrowserWindow } = require('electron');
const block = process.argv.includes('--block');
if (block) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-features', 'WebGPU');
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    webgl: !block, preload: undefined,
  }});
  await win.loadURL('data:text/html,<canvas id="c"></canvas>');
  const result = await win.webContents.executeJavaScript(String.raw
decodeURIComponent('${encodeURIComponent(`(async () => {
  const c = document.getElementById('c');
  const gl = c.getContext('webgl');
  const gl2 = c.getContext('webgl2');
  let gpu = 'missing';
  if (navigator.gpu) { try { gpu = await navigator.gpu.requestAdapter() ? 'adapter' : 'null'; } catch { gpu = 'error'; } }
  let workerWebgl = null;
  if (typeof Worker === 'function' && typeof OffscreenCanvas === 'function') {
    workerWebgl = await new Promise((resolve) => {
      const src = 'onmessage = () => { const c = new OffscreenCanvas(1,1); postMessage(!!(c.getContext("webgl") || c.getContext("webgl2"))); }';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = (e) => { resolve(e.data); w.terminate(); }; w.postMessage(0);
    });
  }
  return { webgl: !!gl, webgl2: !!gl2, debugRenderer: !!(gl && gl.getExtension('WEBGL_debug_renderer_info')), gpu, workerWebgl };
})()`)}')
  );
  console.log(JSON.stringify(result));
  app.exit(0);
}).catch(() => app.exit(2));
`;

function observe(mode: 'native' | 'block'): Promise<Observation> {
  if (!electronBinary) throw new Error('OCTO_ELECTRON_BINARY is required');
  return new Promise((resolve, reject) => {
    const args = ['-e', child];
    if (mode === 'block') args.push('--block');
    const p = spawn(electronBinary, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, windowsHide: true });
    let output = '';
    p.stdout.on('data', (chunk) => { output += String(chunk); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Electron exited ${code}: ${output}`));
      try { resolve(JSON.parse(output.trim().split('\n').pop() || '') as Observation); } catch (e) { reject(e); }
    });
  });
}

it('uses the profile graphics identity overlay while preserving native rendering', () => {
  // Resolved from this file's directory: the TypeScript project targets CJS,
  // where import.meta is not available.
  const source = readFileSync(path.resolve(__dirname, '..', 'src', 'preload', 'page-shim.ts'), 'utf8');
  expect(source).toMatch(/WebGLRenderingContext|WebGL2RenderingContext/);
  expect(source).toContain('GPUAdapterInfo');
  expect(source).toContain("p === 0x9245");
});

describe.skipIf(!enabled)('local Electron graphics isolation observation', () => {
  it('observes block/native/block across fresh processes without CDP attachment', async () => {
    const nativeBefore = await observe('native');
    const blocked = await observe('block');
    const nativeAfter = await observe('native');

    // Native values are host-dependent and intentionally not asserted.
    expect(nativeBefore).toBeTruthy();
    expect(nativeAfter).toBeTruthy();
    expect(blocked.webgl).toBe(false);
    expect(blocked.webgl2).toBe(false);
    expect(blocked.debugRenderer).toBe(false);
    expect(['missing', 'null']).toContain(blocked.gpu);
    if (blocked.workerWebgl !== null) expect(blocked.workerWebgl).toBe(false);
  });
});
