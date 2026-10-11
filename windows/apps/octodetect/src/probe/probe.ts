/**
 * apps/octodetect/src/probe/probe.ts
 *
 * Collects what a browser exposes to ordinary websites (ProbeData in
 * packages/core/src/audit.ts) and POSTs it to the local OctoDetect endpoint
 * (127.0.0.1, one-time token). Runs in any browser (no Electron APIs).
 *
 * Principles:
 *  - read-only measurement, nothing is sent anywhere except 127.0.0.1;
 *  - no STUN/TURN servers (WebRTC test uses local candidates only);
 *  - no extension probing (web-accessible-resource scanning is itself a
 *    fingerprinting technique and is intentionally not implemented);
 *  - permissions are only QUERIED, never requested.
 */

type PermState = 'granted' | 'denied' | 'prompt' | 'unsupported' | 'error';

const params = new URLSearchParams(location.search);
const token = params.get('token') ?? '';
const lang = params.get('lang') === 'pl' ? 'pl' : 'en';

const TEXT = {
  en: { title: 'Local privacy audit', collecting: 'Collecting what this browser exposes to websites… Nothing leaves this computer.', done: 'Done. The results are in OctoDetect.su – you can close this tab.', fail: 'The audit could not be completed' },
  pl: { title: 'Lokalny audyt prywatności', collecting: 'Zbieranie informacji, które ta przeglądarka udostępnia stronom… Nic nie opuszcza tego komputera.', done: 'Gotowe. Wyniki są w OctoDetect.su – możesz zamknąć tę kartę.', fail: 'Nie udało się ukończyć audytu' },
}[lang];

function setProgress(p: number): void {
  const el = document.getElementById('progress');
  if (el) el.style.width = `${Math.round(p * 100)}%`;
}

async function sha256(text: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Non-secure context fallback (FNV-1a 32 bit, display only).
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(fallback); });
  });
}

// ------------------------------------------------------------------ fonts

const FONT_LIST = [
  'Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Cambria', 'Cambria Math', 'Candara', 'Cascadia Code', 'Comic Sans MS', 'Consolas',
  'Constantia', 'Corbel', 'Courier New', 'Ebrima', 'Franklin Gothic Medium', 'Gabriola', 'Gadugi', 'Georgia', 'HoloLens MDL2 Assets',
  'Impact', 'Ink Free', 'Javanese Text', 'Leelawadee UI', 'Lucida Console', 'Lucida Sans Unicode', 'Malgun Gothic', 'Marlett',
  'Microsoft Himalaya', 'Microsoft JhengHei', 'Microsoft New Tai Lue', 'Microsoft PhagsPa', 'Microsoft Sans Serif', 'Microsoft Tai Le',
  'Microsoft YaHei', 'Microsoft Yi Baiti', 'MingLiU-ExtB', 'Mongolian Baiti', 'MS Gothic', 'MV Boli', 'Myanmar Text', 'Nirmala UI',
  'Palatino Linotype', 'Segoe MDL2 Assets', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'Segoe UI Emoji', 'Segoe UI Historic',
  'Segoe UI Symbol', 'SimSun', 'Sitka', 'Sylfaen', 'Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Webdings',
  'Wingdings', 'Yu Gothic', 'Adobe Garamond Pro', 'Book Antiqua', 'Century Gothic', 'Garamond', 'Helvetica', 'Helvetica Neue',
  'Lato', 'Liberation Sans', 'Menlo', 'Monaco', 'Noto Sans', 'Open Sans', 'Roboto', 'Source Sans Pro', 'Ubuntu', 'DejaVu Sans',
];

function detectFonts(): { tested: number; detected: string[] } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return { tested: FONT_LIST.length, detected: [] };
  const sample = 'mmmmmmmmmwwwwwwwiiiiiiilllll10OoQq@#ąęłżź';
  const bases = ['monospace', 'sans-serif', 'serif'];
  const baseW = bases.map((b) => { ctx.font = `72px ${b}`; return ctx.measureText(sample).width; });
  const detected: string[] = [];
  for (const f of FONT_LIST) {
    const found = bases.some((b, i) => { ctx.font = `72px "${f}", ${b}`; return ctx.measureText(sample).width !== baseW[i]; });
    if (found) detected.push(f);
  }
  return { tested: FONT_LIST.length, detected };
}

// ------------------------------------------------------------------ canvas / webgl / audio

async function probeCanvas(): Promise<{ supported: boolean; readable: boolean; blank: boolean; hash?: string }> {
  try {
    const c = document.createElement('canvas');
    c.width = 240; c.height = 60;
    const ctx = c.getContext('2d');
    if (!ctx) return { supported: false, readable: false, blank: true };
    ctx.textBaseline = 'top';
    ctx.font = '16px Arial';
    ctx.fillStyle = '#f60'; ctx.fillRect(100, 1, 62, 20);
    ctx.fillStyle = '#069'; ctx.fillText('OctoDetect ✓ ąę 😀', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)'; ctx.fillText('OctoDetect ✓ ąę 😀', 4, 17);
    const data = c.toDataURL();
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonZero = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] !== 0) { nonZero++; if (nonZero > 10) break; }
    const blank = nonZero === 0;
    return { supported: true, readable: data.length > 100, blank, hash: blank ? undefined : await sha256(data) };
  } catch {
    return { supported: true, readable: false, blank: true };
  }
}

function probeWebgl(): { supported: boolean; vendor?: string; renderer?: string; unmasked: boolean; extensions?: number } {
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl') || c.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return { supported: false, unmasked: false };
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : String(gl.getParameter(gl.VENDOR));
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    return { supported: true, vendor, renderer, unmasked: !!dbg && !/^(WebKit|Mozilla)/.test(renderer), extensions: gl.getSupportedExtensions()?.length ?? 0 };
  } catch {
    return { supported: false, unmasked: false };
  }
}

async function probeAudio(): Promise<{ supported: boolean; readable: boolean; hash?: string; sampleRate?: number }> {
  const Ctx = (window as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
  if (!Ctx) return { supported: false, readable: false };
  try {
    const ctx = new Ctx(1, 44100, 44100);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 10000;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -50; comp.knee.value = 40; comp.ratio.value = 12; comp.attack.value = 0; comp.release.value = 0.25;
    osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
    const buf = await withTimeout(ctx.startRendering(), 3000, null as unknown as AudioBuffer);
    if (!buf) return { supported: true, readable: false };
    const data = buf.getChannelData(0);
    let sum = 0;
    for (let i = 4500; i < 5000; i++) sum += Math.abs(data[i]);
    const readable = sum !== 0;
    return { supported: true, readable, hash: readable ? await sha256(sum.toString()) : undefined, sampleRate: new AudioContext().sampleRate };
  } catch {
    return { supported: true, readable: false };
  }
}

// ------------------------------------------------------------------ WebRTC (local candidates only, no STUN)

function probeWebrtc(): Promise<{ supported: boolean; ips: string[]; mdnsOnly: boolean; error?: string }> {
  if (typeof RTCPeerConnection === 'undefined') return Promise.resolve({ supported: false, ips: [], mdnsOnly: false });
  return new Promise((resolve) => {
    const ips = new Set<string>();
    let mdns = false;
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
    } catch (err) {
      resolve({ supported: false, ips: [], mdnsOnly: false, error: String(err) });
      return;
    }
    const finish = () => {
      try { pc.close(); } catch { /* ignore */ }
      resolve({ supported: true, ips: [...ips], mdnsOnly: mdns && ips.size === 0 });
    };
    pc.onicecandidate = (e) => {
      if (!e.candidate) { finish(); return; }
      const parts = e.candidate.candidate.split(' ');
      const addr = parts[4];
      if (!addr) return;
      if (addr.endsWith('.local')) mdns = true;
      else ips.add(addr);
    };
    pc.createDataChannel('probe');
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((err) => resolve({ supported: true, ips: [], mdnsOnly: false, error: String(err) }));
    setTimeout(finish, 2500);
  });
}

// ------------------------------------------------------------------ permissions / storage / apis

async function perm(name: string): Promise<PermState> {
  try {
    if (!navigator.permissions) return 'unsupported';
    const r = await navigator.permissions.query({ name: name as PermissionName });
    return r.state as PermState;
  } catch {
    return 'unsupported';
  }
}

async function storage(): Promise<{ localStorage: boolean; sessionStorage: boolean; indexedDB: boolean; serviceWorker: boolean; cacheApi: boolean }> {
  const test = (fn: () => void) => { try { fn(); return true; } catch { return false; } };
  const idb = await withTimeout(new Promise<boolean>((resolve) => {
    try {
      const req = indexedDB.open('octodetect-probe');
      req.onsuccess = () => { req.result.close(); indexedDB.deleteDatabase('octodetect-probe'); resolve(true); };
      req.onerror = () => resolve(false);
    } catch { resolve(false); }
  }), 1500, false);
  return {
    localStorage: test(() => { localStorage.setItem('od', '1'); localStorage.removeItem('od'); }),
    sessionStorage: test(() => { sessionStorage.setItem('od', '1'); sessionStorage.removeItem('od'); }),
    indexedDB: idb,
    serviceWorker: 'serviceWorker' in navigator,
    cacheApi: 'caches' in window,
  };
}

async function mediaDevices(): Promise<{ supported: boolean; count: number; labelsVisible: boolean }> {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return { supported: false, count: 0, labelsVisible: false };
    const d = await navigator.mediaDevices.enumerateDevices();
    return { supported: true, count: d.length, labelsVisible: d.some((x) => !!x.label) };
  } catch {
    return { supported: false, count: 0, labelsVisible: false };
  }
}

// ------------------------------------------------------------------ main

async function collect(): Promise<Record<string, unknown>> {
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string; mobile?: boolean; brands?: Array<{ brand: string; version: string }> }; globalPrivacyControl?: boolean };
  setProgress(0.1);
  const fonts = detectFonts();
  setProgress(0.25);
  const canvas = await probeCanvas();
  const webgl = probeWebgl();
  setProgress(0.4);
  const audio = await probeAudio();
  setProgress(0.55);
  const webrtc = await probeWebrtc();
  setProgress(0.75);
  const [geolocation, camera, microphone, notifications] = await Promise.all([perm('geolocation'), perm('camera'), perm('microphone'), perm('notifications')]);
  const st = await storage();
  const md = await mediaDevices();
  setProgress(0.9);
  const data = {
    collectedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    uaData: nav.userAgentData ? { platform: nav.userAgentData.platform, mobile: nav.userAgentData.mobile, brands: nav.userAgentData.brands?.map((b) => `${b.brand} ${b.version}`) } : undefined,
    language: navigator.language,
    languages: [...(navigator.languages ?? [])],
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffsetMin: new Date().getTimezoneOffset(),
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, pixelRatio: window.devicePixelRatio },
    hardwareConcurrency: typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    fonts,
    canvas,
    webgl,
    audio,
    webrtc,
    cookies: { enabled: navigator.cookieEnabled },
    storage: st,
    permissions: { geolocation, camera, microphone, notifications },
    mediaDevices: md,
    apis: {
      battery: 'getBattery' in navigator,
      gamepad: 'getGamepads' in navigator,
      bluetooth: 'bluetooth' in navigator,
      usb: 'usb' in navigator,
      hid: 'hid' in navigator,
      serial: 'serial' in navigator,
      webgpu: 'gpu' in navigator,
      clipboardRead: !!navigator.clipboard && 'readText' in navigator.clipboard,
    },
    gpc: typeof nav.globalPrivacyControl === 'boolean' ? nav.globalPrivacyControl : null,
    doNotTrack: navigator.doNotTrack ?? null,
    secureContext: window.isSecureContext,
    protocol: location.protocol,
    rendererSandboxed: null,
    extensionsDetectable: false,
    fingerprintHash: '',
  };
  data.fingerprintHash = await sha256(JSON.stringify([data.userAgent, data.languages, data.timezone, data.screen, data.hardwareConcurrency, data.deviceMemory, fonts.detected, canvas.hash, webgl.vendor, webgl.renderer, audio.hash]));
  return data;
}

async function main(): Promise<void> {
  document.documentElement.lang = lang;
  document.getElementById('title')!.textContent = TEXT.title;
  document.getElementById('msg')!.textContent = TEXT.collecting;
  const data = await collect();
  const r = await fetch(`/result?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  setProgress(1);
  document.body.classList.add('done');
  document.getElementById('msg')!.textContent = TEXT.done;
}

main().catch((err) => {
  document.getElementById('msg')!.textContent = `${TEXT.fail}: ${String((err as Error)?.message ?? err)}`;
});

export {};
