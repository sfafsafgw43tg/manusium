/**
 * A deliberately page-world read-back probe. It reports only values a page can
 * already read; device labels and raw WebRTC addresses are never returned.
 */
export interface FingerprintProbeSnapshot {
  userAgent: string;
  platform: string;
  language: string;
  languages: string[];
  uaDataPlatform: string;
  uaDataPlatformVersion: string;
  uaDataArchitecture: string;
  uaDataModel: string;
  uaDataBrands: Array<{ brand: string; version: string }>;
  uaDataFullVersionList: Array<{ brand: string; version: string }>;
  timezone: string;
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  screen: { width: number; height: number; availWidth: number; availHeight: number; colorDepth: number; pixelRatio: number };
  webgl: {
    available: boolean; debugInfo: boolean; vendor: string; renderer: string;
    standardVendor: string; standardRenderer: string; unmaskedVendor: string; unmaskedRenderer: string;
  };
  webgpuAvailable: boolean;
  canvas: { hash: string; blankReadback: boolean };
  audioHash: string;
  rectsHash: string;
  fonts: { availableCount: number; testedCount: number };
  mediaDevices: { audioInputs: number; audioOutputs: number; videoInputs: number; labelsVisible: number };
  geolocationPermission: string;
  webrtc: { available: boolean; hostCandidates: number; serverReflexiveCandidates: number; relayCandidates: number };
  errors: string[];
}

/** Serialized into the active profile page's main world by WebContents.executeJavaScript. */
export const FINGERPRINT_PROBE_SCRIPT = String.raw`(() => (async () => {
  const errors = [];
  const fail = (key) => { if (errors.length < 20 && !errors.includes(key)) errors.push(key); };
  const read = (key, fn, fallback) => { try { return fn(); } catch { fail(key); return fallback; } };
  const hash = (value) => {
    const text = String(value);
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  const n = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
  const brandList = (value) => Array.isArray(value)
    ? value.filter((item) => item && typeof item === 'object')
      .map((item) => ({ brand: String(item.brand || ''), version: String(item.version || '') }))
      .filter((item) => item.brand && item.version)
    : [];
  const nav = navigator;
  const uaData = nav.userAgentData;
  let high = {};
  if (uaData && typeof uaData.getHighEntropyValues === 'function') {
    try { high = await uaData.getHighEntropyValues(['architecture', 'fullVersionList', 'model', 'platformVersion']); }
    catch { fail('ua-hints'); }
  }

  const canvas = read('canvas', () => {
    const target = document.createElement('canvas');
    target.width = 96; target.height = 32;
    const ctx = target.getContext('2d');
    if (!ctx) throw new Error('unavailable');
    ctx.fillStyle = '#2677d8'; ctx.fillRect(2, 2, 54, 22);
    ctx.font = 'bold 13px sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText('Octo audit', 5, 18);
    const data = target.toDataURL();
    const blank = document.createElement('canvas'); blank.width = target.width; blank.height = target.height;
    return { hash: hash(data), blankReadback: data === blank.toDataURL() };
  }, { hash: '', blankReadback: false });

  const webgl = read('webgl', () => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return {
      available: false, debugInfo: false, vendor: '', renderer: '',
      standardVendor: '', standardRenderer: '', unmaskedVendor: '', unmaskedRenderer: '',
    };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const standardVendor = String(gl.getParameter(gl.VENDOR) || '');
    const standardRenderer = String(gl.getParameter(gl.RENDERER) || '');
    const unmaskedVendor = ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) || '') : '';
    const unmaskedRenderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
    return {
      available: true,
      debugInfo: !!ext,
      vendor: ext ? unmaskedVendor : standardVendor,
      renderer: ext ? unmaskedRenderer : standardRenderer,
      standardVendor, standardRenderer, unmaskedVendor, unmaskedRenderer,
    };
  }, {
    available: false, debugInfo: false, vendor: '', renderer: '',
    standardVendor: '', standardRenderer: '', unmaskedVendor: '', unmaskedRenderer: '',
  });

  let audioHash = '';
  try {
    const Audio = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (Audio) {
      const context = new Audio(1, 4096, 44100);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'triangle'; oscillator.frequency.value = 997;
      gain.gain.value = 0.15;
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(0);
      const buffer = await context.startRendering();
      const samples = buffer.getChannelData(0);
      let signature = '';
      for (let i = 64; i < samples.length; i += 31) signature += Math.round(samples[i] * 1e7) + ',';
      audioHash = hash(signature);
    }
  } catch { fail('audio'); }

  const rectsHash = read('rects', () => {
    const el = document.createElement('span');
    el.textContent = 'Octo';
    el.style.cssText = 'position:fixed;left:-10000px;top:-10000px;font:13px Arial;white-space:nowrap';
    (document.body || document.documentElement).appendChild(el);
    const r = el.getBoundingClientRect();
    el.remove();
    return hash([r.x, r.y, r.width, r.height].map((v) => Number(v).toFixed(4)).join(','));
  }, '');

  const fontNames = ['Arial', 'Calibri', 'Cambria', 'Comic Sans MS', 'Consolas', 'Courier New', 'Georgia', 'Helvetica', 'Impact', 'Roboto', 'Segoe UI', 'Times New Roman', 'Verdana'];
  let fontCount = 0;
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const sample = 'mmmmmmmmwwww';
      ctx.font = '72px monospace';
      const baseline = ctx.measureText(sample).width;
      for (const name of fontNames) {
        ctx.font = '72px "' + name + '", monospace';
        if (ctx.measureText(sample).width !== baseline) fontCount++;
      }
    }
  } catch { fail('fonts'); }

  let media = { audioInputs: 0, audioOutputs: 0, videoInputs: 0, labelsVisible: 0 };
  try {
    if (nav.mediaDevices && nav.mediaDevices.enumerateDevices) {
      const devices = await nav.mediaDevices.enumerateDevices();
      media = {
        audioInputs: devices.filter((d) => d.kind === 'audioinput').length,
        audioOutputs: devices.filter((d) => d.kind === 'audiooutput').length,
        videoInputs: devices.filter((d) => d.kind === 'videoinput').length,
        labelsVisible: devices.filter((d) => !!d.label).length,
      };
    }
  } catch { fail('media-devices'); }

  let geolocationPermission = 'unsupported';
  try {
    if (nav.permissions && nav.permissions.query) {
      geolocationPermission = (await nav.permissions.query({ name: 'geolocation' })).state;
    }
  } catch { geolocationPermission = 'unavailable'; fail('geolocation-permission'); }

  const webrtc = { available: typeof window.RTCPeerConnection === 'function', hostCandidates: 0, serverReflexiveCandidates: 0, relayCandidates: 0 };
  if (webrtc.available) {
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
      const gathered = new Promise((resolve) => {
        const timer = setTimeout(resolve, 900);
        pc.onicecandidate = (event) => {
          if (!event.candidate) { clearTimeout(timer); resolve(); return; }
          const candidate = String(event.candidate.candidate || '');
          const type = /\btyp\s+(host|srflx|relay)\b/i.exec(candidate)?.[1]?.toLowerCase();
          if (type === 'host') webrtc.hostCandidates++;
          else if (type === 'srflx') webrtc.serverReflexiveCandidates++;
          else if (type === 'relay') webrtc.relayCandidates++;
        };
      });
      pc.createDataChannel('octo-audit');
      await pc.setLocalDescription(await pc.createOffer());
      await gathered;
    } catch { fail('webrtc'); }
    finally { try { pc?.close(); } catch { /* already closed */ } }
  }

  return {
    userAgent: read('user-agent', () => nav.userAgent, ''),
    platform: read('platform', () => nav.platform, ''),
    language: read('language', () => nav.language, ''),
    languages: read('languages', () => Array.from(nav.languages || []), []),
    uaDataPlatform: uaData ? read('ua-platform', () => uaData.platform, '') : '',
    uaDataPlatformVersion: String(high.platformVersion || ''),
    uaDataArchitecture: String(high.architecture || ''),
    uaDataModel: String(high.model || ''),
    uaDataBrands: uaData ? read('ua-brands', () => brandList(uaData.brands), []) : [],
    uaDataFullVersionList: uaData ? read('ua-full-version-list', () => brandList(high.fullVersionList), []) : [],
    timezone: read('timezone', () => Intl.DateTimeFormat().resolvedOptions().timeZone || '', ''),
    hardwareConcurrency: read('cpu', () => n(nav.hardwareConcurrency), null),
    deviceMemory: read('memory', () => n(nav.deviceMemory), null),
    screen: {
      width: read('screen-width', () => n(screen.width), null),
      height: read('screen-height', () => n(screen.height), null),
      availWidth: read('screen-avail-width', () => n(screen.availWidth), null),
      availHeight: read('screen-avail-height', () => n(screen.availHeight), null),
      colorDepth: read('screen-depth', () => n(screen.colorDepth), null),
      pixelRatio: read('pixel-ratio', () => n(window.devicePixelRatio), null),
    },
    webgl,
    webgpuAvailable: read('webgpu', () => !!nav.gpu, false),
    canvas,
    audioHash,
    rectsHash,
    fonts: { availableCount: fontCount, testedCount: fontNames.length },
    mediaDevices: media,
    geolocationPermission,
    webrtc,
    errors,
  };
})())()`;
