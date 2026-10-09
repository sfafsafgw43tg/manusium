/**
 * apps/octobrowser/src/preload/page-shim.ts
 *
 * Code executed in the MAIN world of every page and iframe before page scripts
 * run (contextBridge.executeInMainWorld from preload/tab.ts). `pageShim` must be
 * completely SELF-CONTAINED: it is serialised to a string, so it may not use
 * imports, module variables or helpers defined outside its body.
 *
 * Three jobs:
 *   1. antidetect fingerprint (profile.fingerprint): navigator / UA-CH / screen /
 *      WebGL vendor+renderer / canvas + WebGL + audio + client-rects + font noise /
 *      battery / speech voices / WebRTC candidate rewriting / media devices;
 *   2. the Strict preset protections (canvas read-back blocking, normalised
 *      hardware values);
 *   3. per-tab volume + output device of the audio mixer.
 *
 * Undetectability: every replaced function / getter is a Proxy around the
 * ORIGINAL native function, so name, length, the missing `prototype`, receiver
 * brand checks ("Illegal invocation") stay native, and Function.prototype.toString
 * (itself proxied) reports "function x() { [native code] }". Noise is
 * deterministic per profile seed: the same profile always produces the same
 * canvas/audio hash (like a real device), different profiles differ.
 */

export interface PageFingerprint {
  platform: string;
  brands: Array<{ brand: string; version: string }>;
  fullVersionList: Array<{ brand: string; version: string }>;
  uaFullVersion: string;
  chPlatform: string;
  platformVersion: string;
  architecture: string;
  bitness: string;
  languages: string[] | null;
  cores: number | null;
  memory: number | null;
  screen: { width: number; height: number; availWidth: number; availHeight: number } | null;
  windowSize?: { width: number; height: number } | null;
  deviceScaleFactor: number | null;
  webglVendor: string | null;
  webglRenderer: string | null;
  canvas: 'off' | 'real' | 'noise';
  webgl: 'off' | 'real' | 'noise';
  audio: 'real' | 'noise';
  speechVoices?: 'real' | 'noise';
  clientRects: 'real' | 'noise';
  fonts: 'real' | 'noise' | 'custom';
  fontList?: string[] | null;
  webgpu: 'off' | 'real' | 'webgl-based' | 'disable';
  webrtcMode: 'off' | 'real' | 'disable-udp' | 'altered' | 'manual' | 'substitute' | 'forward' | 'disable';
  webrtcIp: string;
  mediaDevices: { audioInputs: number; audioOutputs: number; videoInputs: number } | null;
  geolocation?: { mode: string; latitude: number; longitude: number } | null;
  doNotTrack: boolean;
  battery?: 'real' | 'noise';
  deviceName?: string | null;
  macAddress?: string | null;
  videoSpoofing?: boolean;
  /** Android/iOS device emulation overlays the normal desktop identity. */
  mobile: boolean;
  model: string;
  formFactor: 'Desktop' | 'Mobile';
  /** 32-bit seed derived from the profile fingerprint seed. */
  seed: number;
}

export interface PageConfig {
  canvas: 'allow' | 'block-readback';
  hw: 'allow' | 'normalize';
  hwValues: { hardwareConcurrency: number; deviceMemory: number };
  volume: number; // 0..1
  sinkId: string;
  /** Preferred host capture labels; device ids are different for every origin. */
  cameraLabel: string;
  microphoneLabel: string;
  fp: PageFingerprint | null;
}

export function pageShim(c: PageConfig, eventName: string): void {
  'use strict';
  const W = window as unknown as Record<string, unknown>;
  const fp = c.fp;
  const R = Reflect;
  const gOPD = Object.getOwnPropertyDescriptor;
  const dP = Object.defineProperty;

  // ------------------------------------------------------------ masking
  const names = new WeakMap<object, string>();
  const nativeToString = Function.prototype.toString;
  const tsProxy = new Proxy(nativeToString, {
    apply(target, self, args) {
      const n = (typeof self === 'function' || typeof self === 'object') && self !== null ? names.get(self) : undefined;
      return n !== undefined ? `function ${n}() { [native code] }` : R.apply(target, self, args);
    },
  });
  names.set(tsProxy, 'toString');
  try { dP(Function.prototype, 'toString', { ...gOPD(Function.prototype, 'toString'), value: tsProxy }); } catch { /* ignore */ }

  type Fn = (...a: never[]) => unknown;
  const hook = <T extends Fn>(orig: T, impl: (target: T, self: unknown, args: unknown[]) => unknown): T => {
    const p = new Proxy(orig, { apply: (t, s, a) => impl(t, s, a as unknown[]) });
    names.set(p, orig.name);
    return p;
  };
  /** Replace a getter; `fn(self, orig)` - call orig() first to keep native brand checks. */
  const getter = (proto: object | undefined, prop: string, fn: (self: unknown, orig: () => unknown) => unknown): void => {
    if (!proto) return;
    const d = gOPD(proto, prop);
    const origGet = d?.get;
    const fallbackGet = () => d?.value;
    const baseGet = (origGet || fallbackGet) as Fn;
    try {
      dP(proto, prop, {
        configurable: true,
        enumerable: true,
        get: hook(baseGet, (t, s, a) => fn(s, () => (origGet ? R.apply(t, s, a) : d?.value))),
      });
    } catch { /* ignore */ }
  };
  /** Replace a method; `fn(self, args, orig)`. */
  const method = (proto: object | undefined, name: string, fn: (self: unknown, args: unknown[], orig: (...a: unknown[]) => unknown) => unknown): void => {
    if (!proto) return;
    const d = gOPD(proto, name);
    if (!d || typeof d.value !== 'function') return;
    try { dP(proto, name, { ...d, value: hook(d.value as Fn, (t, s, a) => fn(s, a, (...x) => R.apply(t, s, x))) }); } catch { /* ignore */ }
  };
  const proto = (name: string): object | undefined => (W[name] as { prototype?: object } | undefined)?.prototype;
  const fixed = (p: object | undefined, prop: string, value: unknown) => getter(p, prop, (_s, orig) => { orig(); return value; });

  // ------------------------------------------------------ deterministic noise
  const seed = fp ? fp.seed >>> 0 : 0;
  /** Stable pseudo-random 32-bit value for (seed, a, b). */
  const hash = (a: number, b = 0): number => {
    let h = (seed ^ Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    return (h ^ (h >>> 16)) >>> 0;
  };
  /** Flip the lowest bit of a sparse, seed-dependent subset of RGB channels. */
  const noisePixels = (data: Uint8ClampedArray | Uint8Array, w: number): void => {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue; // untouched transparent pixels stay identical
      const px = i >> 2;
      const h = hash(px % w, (px / w) | 0);
      if ((h & 15) !== 0) continue; // ~6 % of pixels
      const ch = (h >>> 4) % 3;
      data[i + ch] ^= 1;
    }
  };

  // ---- window.chrome fidelity ----
  if (typeof (W as { chrome?: unknown }).chrome !== 'object' || !(W as { chrome?: unknown }).chrome) {
    const fakeChrome = {
      app: {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getIsInstalled: () => false,
        getDetails: () => null,
        getRunningState: () => 'cannot_run',
      },
      csi: () => ({ startE: Date.now(), onloadT: Date.now(), pageT: 0, tran: 15 }),
      loadTimes: () => ({
        requestTime: Date.now() / 1000,
        startLoadTime: Date.now() / 1000,
        commitLoadTime: Date.now() / 1000,
        finishDocumentLoadTime: Date.now() / 1000,
        finishLoadTime: Date.now() / 1000,
        firstPaintTime: Date.now() / 1000,
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: false,
        wasNpnNegotiated: false,
        npnNegotiatedProtocol: 'unknown',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'http/1.1',
      }),
      runtime: {
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
      },
    };
    try { dP(window, 'chrome', { value: fakeChrome, writable: true, configurable: true, enumerable: true }); } catch { /* ignore */ }
  }

  // ---- selected physical camera / microphone & video spoofing ----
  const MD = proto('MediaDevices');
  if (c.cameraLabel || c.microphoneLabel || (fp && fp.videoSpoofing)) {
    const nativeEnumerate = MD && (gOPD(MD, 'enumerateDevices')?.value as Fn | undefined);
    const normalizedLabel = (value: string) => value.trim().toLocaleLowerCase()
      .replace(/^(default|communications|domyślne|komunikacja)\s*[-–:]\s*/i, '');
    method(MD, 'getUserMedia', (self, args, orig) => {
      const requested = (args[0] && typeof args[0] === 'object' ? { ...(args[0] as MediaStreamConstraints) } : {}) as MediaStreamConstraints;
      const choose = (devices: MediaDeviceInfo[]) => {
        const next: MediaStreamConstraints = { ...requested };
        const cameraWanted = !!requested.video && !!c.cameraLabel;
        const microphoneWanted = !!requested.audio && !!c.microphoneLabel;
        const camera = devices.find((item) => item.kind === 'videoinput' && normalizedLabel(item.label) === normalizedLabel(c.cameraLabel));
        const microphone = devices.find((item) => item.kind === 'audioinput' && normalizedLabel(item.label) === normalizedLabel(c.microphoneLabel));
        if (cameraWanted && camera) next.video = { ...(typeof requested.video === 'object' ? requested.video : {}), deviceId: { exact: camera.deviceId } };
        if (microphoneWanted && microphone) next.audio = { ...(typeof requested.audio === 'object' ? requested.audio : {}), deviceId: { exact: microphone.deviceId } };
        return { next, cameraWanted, microphoneWanted, camera, microphone, missing: (cameraWanted && !camera) || (microphoneWanted && !microphone) };
      };
      return (async () => {
        const before = nativeEnumerate ? await (R.apply(nativeEnumerate, self, []) as Promise<MediaDeviceInfo[]>) : [];
        const resolved = choose(before);
        if (!resolved.missing) {
          try {
            return await (R.apply(orig, self, [resolved.next]) as Promise<MediaStream>);
          } catch (err) {
            // If physical device open fails and video spoofing is enabled, generate synthetic virtual stream
            if (fp && fp.videoSpoofing && requested.video && typeof document !== 'undefined') {
              const canvas = document.createElement('canvas');
              canvas.width = 640; canvas.height = 480;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.fillStyle = '#1e1e24'; ctx.fillRect(0, 0, 640, 480);
                ctx.fillStyle = '#4ade80'; ctx.font = '24px sans-serif'; ctx.fillText('Virtual Video Stream', 200, 240);
              }
              const stream = (canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream?.(30);
              if (stream) return stream;
            }
            throw err;
          }
        }
        const probeConstraints: MediaStreamConstraints = { ...requested };
        if (requested.video && typeof requested.video === 'object') {
          const video = { ...requested.video }; delete video.deviceId; probeConstraints.video = video;
        }
        if (requested.audio && typeof requested.audio === 'object') {
          const audio = { ...requested.audio }; delete audio.deviceId; probeConstraints.audio = audio;
        }
        try {
          const first = await (R.apply(orig, self, [probeConstraints]) as Promise<MediaStream>);
          const after = nativeEnumerate ? await (R.apply(nativeEnumerate, self, []) as Promise<MediaDeviceInfo[]>) : [];
          const permitted = choose(after);
          if (permitted.missing) {
            first.getTracks().forEach((track) => track.stop());
            throw new DOMException('The selected camera or microphone is unavailable', 'NotFoundError');
          }
          const trackMatches = (track: MediaStreamTrack | undefined, device: MediaDeviceInfo | undefined, label: string) => {
            if (!track || !device) return false;
            const currentId = track.getSettings?.().deviceId;
            return currentId ? currentId === device.deviceId : normalizedLabel(track.label) === normalizedLabel(label);
          };
          const alreadySelected = (!permitted.cameraWanted || trackMatches(first.getVideoTracks()[0], permitted.camera, c.cameraLabel))
            && (!permitted.microphoneWanted || trackMatches(first.getAudioTracks()[0], permitted.microphone, c.microphoneLabel));
          if (alreadySelected) return first;

          first.getTracks().forEach((track) => track.stop());
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
          try {
            return await (R.apply(orig, self, [permitted.next]) as Promise<MediaStream>);
          } catch (error) {
            const name = error instanceof DOMException ? error.name : '';
            if (name !== 'NotReadableError' && name !== 'AbortError') throw error;
            await new Promise<void>((resolve) => setTimeout(resolve, 500));
            return R.apply(orig, self, [permitted.next]) as Promise<MediaStream>;
          }
        } catch (err) {
          if (fp && fp.videoSpoofing && requested.video && typeof document !== 'undefined') {
            const canvas = document.createElement('canvas');
            canvas.width = 640; canvas.height = 480;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.fillStyle = '#1e1e24'; ctx.fillRect(0, 0, 640, 480);
              ctx.fillStyle = '#4ade80'; ctx.font = '24px sans-serif'; ctx.fillText('Virtual Video Stream', 200, 240);
            }
            const stream = (canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }).captureStream?.(30);
            if (stream) return stream;
          }
          throw err;
        }
      })();
    });

    method(proto('MediaStreamTrack'), 'applyConstraints', (self, args, orig) => {
      const track = self as MediaStreamTrack;
      const wanted = track.kind === 'video' ? c.cameraLabel : track.kind === 'audio' ? c.microphoneLabel : '';
      if (!wanted || !nativeEnumerate) return orig(...args);
      return (async () => {
        const devices = await (R.apply(nativeEnumerate, navigator.mediaDevices, []) as Promise<MediaDeviceInfo[]>);
        const kind = track.kind === 'video' ? 'videoinput' : 'audioinput';
        const selected = devices.find((item) => item.kind === kind && normalizedLabel(item.label) === normalizedLabel(wanted));
        if (!selected) throw new DOMException('The selected camera or microphone is unavailable', 'NotFoundError');
        const currentId = track.getSettings?.().deviceId;
        if (currentId && currentId !== selected.deviceId) {
          throw new DOMException('The selected camera or microphone is unavailable', 'NotFoundError');
        }
        const requested = args[0] && typeof args[0] === 'object' ? { ...(args[0] as MediaTrackConstraints) } : {};
        delete requested.deviceId;
        return orig(requested) as Promise<void>;
      })();
    });
  }

  // ============================================================ FINGERPRINT
  if (fp) {
    const Nav = proto('Navigator');
    // ---- navigator ----
    fixed(Nav, 'platform', fp.platform);
    fixed(Nav, 'pdfViewerEnabled', true);
    if (fp.mobile) fixed(Nav, 'maxTouchPoints', 5);
    else fixed(Nav, 'maxTouchPoints', 0);
    if (fp.cores) fixed(Nav, 'hardwareConcurrency', fp.cores);
    if (fp.memory) fixed(Nav, 'deviceMemory', fp.memory);
    if (fp.languages && fp.languages.length) {
      const langs = Object.freeze(fp.languages.slice());
      fixed(Nav, 'languages', langs);
      fixed(Nav, 'language', langs[0]);
    }
    if (fp.doNotTrack) fixed(Nav, 'doNotTrack', '1');
    const NI = proto('NetworkInformation');
    const connObj = Object.create(NI || EventTarget.prototype);
    dP(connObj, 'downlink', { value: 10 + (hash(7, 8) & 0x7), enumerable: true });
    dP(connObj, 'effectiveType', { value: '4g', enumerable: true });
    dP(connObj, 'rtt', { value: 50, enumerable: true });
    dP(connObj, 'saveData', { value: false, enumerable: true });
    dP(connObj, 'onchange', { value: null, writable: true, enumerable: true });
    dP(connObj, 'addEventListener', { value: () => {}, enumerable: true });
    dP(connObj, 'removeEventListener', { value: () => {}, enumerable: true });
    dP(connObj, 'dispatchEvent', { value: () => true, enumerable: true });
    fixed(Nav, 'connection', connObj);

    const Perms = proto('Permissions');
    if (Perms) {
      method(Perms, 'query', (_s, args, orig) => {
        const desc = args[0] as { name?: string };
        if (desc && typeof desc === 'object') {
          if (desc.name === 'geolocation') {
            const state = fp.geolocation?.mode === 'allow' ? 'granted' : fp.geolocation?.mode === 'block' || fp.geolocation?.mode === 'disable' ? 'denied' : 'prompt';
            return Promise.resolve({ state, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });
          }
          if (desc.name === 'notifications') {
            return Promise.resolve({ state: 'prompt', onchange: null, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });
          }
        }
        return orig(...args);
      });
    }

    const WNav = proto('WorkerNavigator');
    if (WNav) {
      fixed(WNav, 'platform', fp.platform);
      if (fp.cores) fixed(WNav, 'hardwareConcurrency', fp.cores);
      if (fp.memory) fixed(WNav, 'deviceMemory', fp.memory);
      if (fp.languages && fp.languages.length) {
        const langs = Object.freeze(fp.languages.slice());
        fixed(WNav, 'languages', langs);
        fixed(WNav, 'language', langs[0]);
      }
    }

    // ---- User-Agent Client Hints (navigator.userAgentData) ----
    const UAD = proto('NavigatorUAData');
    if (UAD) {
      const freezeList = (l: Array<{ brand: string; version: string }>) => Object.freeze(l.map((b) => Object.freeze({ brand: b.brand, version: b.version })));
      const brands = freezeList(fp.brands);
      fixed(UAD, 'brands', brands);
      fixed(UAD, 'mobile', fp.mobile);
      fixed(UAD, 'platform', fp.chPlatform);
      method(UAD, 'getHighEntropyValues', (self, args, orig) => {
        const p = orig(...args) as Promise<Record<string, unknown>>;
        return p.then((real) => {
          const hints = Array.isArray(args[0]) ? (args[0] as unknown[]).map(String) : [];
          const out: Record<string, unknown> = { brands: brands.map((b) => ({ ...b })), mobile: fp.mobile, platform: fp.chPlatform };
          const all: Record<string, unknown> = {
            architecture: fp.architecture, bitness: fp.bitness, formFactors: [fp.formFactor], fullVersionList: fp.fullVersionList.map((b) => ({ ...b })),
            model: fp.model, platformVersion: fp.platformVersion, uaFullVersion: fp.uaFullVersion, wow64: false,
          };
          for (const h of hints) if (h in all) out[h] = all[h];
          void real; void self;
          const sorted: Record<string, unknown> = {};
          for (const k of Object.keys(out).sort()) sorted[k] = out[k];
          return sorted;
        });
      });
      method(UAD, 'toJSON', (_self, args, orig) => { orig(...args); return { brands: brands.map((b) => ({ ...b })), mobile: fp.mobile, platform: fp.chPlatform }; });
    }

    // ---- screen & window ----
    if (fp.screen) {
      const S = proto('Screen');
      const sc = fp.screen;
      fixed(S, 'width', sc.width);
      fixed(S, 'height', sc.height);
      fixed(S, 'availWidth', sc.availWidth);
      fixed(S, 'availHeight', sc.availHeight);
      fixed(S, 'colorDepth', 24);
      fixed(S, 'pixelDepth', 24);
      if (fp.deviceScaleFactor && Number.isFinite(fp.deviceScaleFactor)) {
        getter(window, 'devicePixelRatio', (_s, orig) => { orig(); return fp.deviceScaleFactor; });
      }
      getter(window, 'outerWidth', (_s, orig) => Math.min(Number(orig()), sc.availWidth));
      getter(window, 'outerHeight', (_s, orig) => Math.min(Number(orig()), sc.availHeight));
      getter(window, 'screenX', (_s, orig) => Math.max(0, Math.min(Number(orig()), sc.width - 100)));
      getter(window, 'screenY', (_s, orig) => Math.max(0, Math.min(Number(orig()), sc.height - 100)));
    }

    // ---- battery emulation ----
    if (fp.battery === 'noise' && Nav) {
      const bSeed = (hash(13, 37) & 0xffff) / 0xffff;
      const bLevel = 0.82 + bSeed * 0.17; // 82% to 99%
      const fakeBattery = Object.create(EventTarget.prototype);
      dP(fakeBattery, 'charging', { value: true, enumerable: true });
      dP(fakeBattery, 'chargingTime', { value: 0, enumerable: true });
      dP(fakeBattery, 'dischargingTime', { value: Infinity, enumerable: true });
      dP(fakeBattery, 'level', { value: bLevel, enumerable: true });
      dP(fakeBattery, 'onchargingchange', { value: null, writable: true, enumerable: true });
      dP(fakeBattery, 'onchargingtimechange', { value: null, writable: true, enumerable: true });
      dP(fakeBattery, 'ondischargingtimechange', { value: null, writable: true, enumerable: true });
      dP(fakeBattery, 'onlevelchange', { value: null, writable: true, enumerable: true });
      const BM = proto('BatteryManager');
      if (BM) Object.setPrototypeOf(fakeBattery, BM);
      method(Nav, 'getBattery', (_s, _a, _orig) => Promise.resolve(fakeBattery));
    }

    // ---- speech voices emulation ----
    if (fp.speechVoices === 'noise' && typeof window !== 'undefined' && (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis) {
      const SS = proto('SpeechSynthesis');
      if (SS) {
        const isMac = fp.platform.includes('Mac');
        const isWin = fp.platform.includes('Win');
        const primaryLang = fp.languages?.[0] || 'en-US';
        const synthVoice = (name: string, lang: string, isDefault = false): SpeechSynthesisVoice => ({
          name,
          lang,
          voiceURI: name,
          localService: true,
          default: isDefault,
        });
        const voices: SpeechSynthesisVoice[] = [];
        if (isWin) {
          voices.push(synthVoice('Microsoft David - English (United States)', 'en-US', true));
          voices.push(synthVoice('Microsoft Zira - English (United States)', 'en-US', false));
          voices.push(synthVoice('Microsoft Mark - English (United States)', 'en-US', false));
          if (primaryLang.startsWith('pl')) voices.push(synthVoice('Microsoft Paul - Polish (Poland)', 'pl-PL', false));
          if (primaryLang.startsWith('de')) voices.push(synthVoice('Microsoft Hedda - German (Germany)', 'de-DE', false));
          if (primaryLang.startsWith('fr')) voices.push(synthVoice('Microsoft Paul - French (France)', 'fr-FR', false));
          if (primaryLang.startsWith('es')) voices.push(synthVoice('Microsoft Helena - Spanish (Spain)', 'es-ES', false));
        } else if (isMac) {
          voices.push(synthVoice('Samantha', 'en-US', true));
          voices.push(synthVoice('Alex', 'en-US', false));
          voices.push(synthVoice('Victoria', 'en-US', false));
          voices.push(synthVoice('Fred', 'en-US', false));
          voices.push(synthVoice('Karen', 'en-AU', false));
          voices.push(synthVoice('Daniel', 'en-GB', false));
          if (primaryLang.startsWith('pl')) voices.push(synthVoice('Zosia', 'pl-PL', false));
          if (primaryLang.startsWith('de')) voices.push(synthVoice('Anna', 'de-DE', false));
          if (primaryLang.startsWith('fr')) voices.push(synthVoice('Thomas', 'fr-FR', false));
          if (primaryLang.startsWith('es')) voices.push(synthVoice('Monica', 'es-ES', false));
        } else {
          voices.push(synthVoice('English (America)', 'en-US', true));
          voices.push(synthVoice('English (Great Britain)', 'en-GB', false));
        }
        method(SS, 'getVoices', (_s, _a, _orig) => voices.slice());
      }
    }

    // ---- WebGL / WebGPU profile overlays ---------------------------------
    // Keep the native rendering implementation and all unconfigured limits,
    // while making the exposed adapter identity internally consistent.
    if (fp.webgl === 'off') {
      const blockContext = (self: unknown, args: unknown[], orig: (...a: unknown[]) => unknown): unknown => {
        const kind = String(args[0] ?? '').toLowerCase();
        if (kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl') return null;
        return orig(...args);
      };
      method(proto('HTMLCanvasElement'), 'getContext', blockContext);
      method(proto('OffscreenCanvas'), 'getContext', blockContext);
    }
    if (fp.webgl !== 'off') {
      const patchWebGL = (Ctor: unknown): void => {
        const P = (Ctor as { prototype?: object } | undefined)?.prototype;
        if (!P) return;
        method(P, 'getParameter', (self, args, orig) => {
          const p = Number(args[0]);
          if (p === 0x9245 && fp.webglVendor) return fp.webglVendor;
          if (p === 0x9246 && fp.webglRenderer) return fp.webglRenderer;
          return orig(...args);
        });
        method(P, 'getExtension', (self, args, orig) => {
          const ext = orig(...args) as Record<string, unknown> | null;
          if (args[0] === 'WEBGL_debug_renderer_info' && ext) {
            return new Proxy(ext, {
              get(target, prop) {
                if (prop === 'UNMASKED_VENDOR_WEBGL') return 0x9245;
                if (prop === 'UNMASKED_RENDERER_WEBGL') return 0x9246;
                return Reflect.get(target, prop);
              },
            });
          }
          return ext;
        });
        if (fp.webgl === 'noise') {
          method(P, 'readPixels', (_self, args, orig) => {
            const result = orig(...args);
            // WebGL readbacks are fingerprintable independently of the adapter
            // strings. Perturb a sparse, deterministic subset of the returned
            // typed-array bytes while preserving the native format and size.
            for (let i = args.length - 1; i >= 0; i--) {
              const candidate = args[i];
              if (!candidate || !ArrayBuffer.isView(candidate) || candidate instanceof DataView) continue;
              const view = candidate as unknown as { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
              const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
              for (let j = 0; j < bytes.length; j += 37) bytes[j] ^= hash(j, bytes.length) & 1;
              break;
            }
            return result;
          });
        }
      };
      patchWebGL((W as Record<string, unknown>).WebGLRenderingContext);
      patchWebGL((W as Record<string, unknown>).WebGL2RenderingContext);
    }

    const gpuProto = proto('GPUAdapterInfo');
    const gpuRenderer = fp.webglRenderer || '';
    const gpuVendor = /NVIDIA/i.test(gpuRenderer) ? 'nvidia' : /Radeon|AMD/i.test(gpuRenderer) ? 'amd' : /Apple/i.test(gpuRenderer) ? 'apple' : /Intel/i.test(gpuRenderer) ? 'intel' : 'google';
    const gpuArchitecture = /Apple\s*M\d/i.test(gpuRenderer) ? 'apple-m' : /RTX\s*30/i.test(gpuRenderer) ? 'ampere' : /RTX\s*40/i.test(gpuRenderer) ? 'ada' : /Arc/i.test(gpuRenderer) ? 'xe-hpg' : /UHD/i.test(gpuRenderer) ? 'gen12' : 'common-3';
    const gpuDescription = gpuRenderer.replace(/^ANGLE\s*\([^,]+,\s*/i, '').replace(/\s+Direct3D.*$/i, '').replace(/,\s*Unspecified Version\)?$/i, '').replace(/\)$/i, '');
    const adapterInfo = () => ({ vendor: gpuVendor, architecture: gpuArchitecture, device: gpuDescription, description: gpuDescription, isFallbackAdapter: false });
    if (fp.webgpu === 'off' || fp.webgpu === 'disable') {
      getter(proto('Navigator'), 'gpu', (_s, orig) => { orig(); return undefined; });
    } else {
      if (gpuProto) {
        for (const [name, value] of Object.entries(adapterInfo())) fixed(gpuProto, name, value);
      }
      const adapter = proto('GPUAdapter');
      if (adapter) {
        getter(adapter, 'info', (_s, orig) => { orig(); return adapterInfo(); });
        getter(adapter, 'isFallbackAdapter', (_s, orig) => { orig(); return false; });
        method(adapter, 'requestAdapterInfo', (_s, _args, _orig) => Promise.resolve(adapterInfo()));
      }
      const limits = proto('GPUSupportedLimits');
      if (limits) {
        for (const [name, value] of Object.entries({ maxTextureDimension2D: 16384, maxTextureDimension1D: 16384, maxBindGroups: 8, maxStorageBufferBindingSize: 2147483648 })) fixed(limits, name, value);
      }
      const features = proto('GPUSupportedFeatures');
      if (features) method(features, 'has', (_s, args, orig) => ['texture-compression-bc', 'depth-clip-control', 'timestamp-query'].includes(String(args[0])) || !!orig(...args));
    }

    // ---- canvas noise / blocking ----
    if (fp.canvas === 'noise') {
      const C2D = proto('CanvasRenderingContext2D');
      const OC2D = proto('OffscreenCanvasRenderingContext2D');
      const origGetImageData = C2D && (gOPD(C2D, 'getImageData')?.value as ((...a: number[]) => ImageData) | undefined);

      /** Noised copy of a canvas (DOM or Offscreen canvas). */
      const noisedCopy = (src: HTMLCanvasElement | OffscreenCanvas): HTMLCanvasElement | null => {
        const w = src.width, h = src.height;
        if (!w || !h || w * h > 16_000_000 || !origGetImageData) return null;
        try {
          const tmp = document.createElement('canvas');
          tmp.width = w;
          tmp.height = h;
          const ctx = tmp.getContext('2d', { willReadFrequently: true } as unknown as CanvasRenderingContext2DSettings);
          if (!ctx) return null;
          ctx.drawImage(src as CanvasImageSource, 0, 0);
          const img = origGetImageData.call(ctx, 0, 0, w, h);
          if (img && img.data) {
            noisePixels(img.data, w);
            ctx.putImageData(img, 0, 0);
          }
          return tmp;
        } catch {
          return null;
        }
      };

      for (const ContextProto of [C2D, OC2D]) {
        if (!ContextProto) continue;
        method(ContextProto, 'getImageData', (_self, args, orig) => {
          const img = orig(...args) as ImageData;
          if (!img || !img.data) return img;
          const sx = Number(args[0]) | 0, sy = Number(args[1]) | 0;
          const w = img.width || 1;
          const d = img.data;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] === 0) continue;
            const px = i >> 2;
            const h = hash(sx + (px % w), sy + ((px / w) | 0));
            if ((h & 15) !== 0) continue;
            d[i + ((h >>> 4) % 3)] ^= 1;
          }
          return img;
        });

        // Micro-jitter boundary path tests to prevent anti-aliasing curve fingerprinting
        method(ContextProto, 'isPointInPath', (_self, args, orig) => {
          const xIdx = typeof args[0] === 'number' ? 0 : 1;
          const yIdx = xIdx + 1;
          if (typeof args[xIdx] === 'number' && typeof args[yIdx] === 'number') {
            const x = args[xIdx] as number;
            const y = args[yIdx] as number;
            const shift = ((hash(Math.round(x * 100), Math.round(y * 100)) & 0xff) / 0xff - 0.5) * 1e-5;
            const nextArgs = [...args];
            nextArgs[xIdx] = x + shift;
            nextArgs[yIdx] = y + shift;
            return orig(...nextArgs);
          }
          return orig(...args);
        });

        method(ContextProto, 'isPointInStroke', (_self, args, orig) => {
          const xIdx = typeof args[0] === 'number' ? 0 : 1;
          const yIdx = xIdx + 1;
          if (typeof args[xIdx] === 'number' && typeof args[yIdx] === 'number') {
            const x = args[xIdx] as number;
            const y = args[yIdx] as number;
            const shift = ((hash(Math.round(x * 100), Math.round(y * 100)) & 0xff) / 0xff - 0.5) * 1e-5;
            const nextArgs = [...args];
            nextArgs[xIdx] = x + shift;
            nextArgs[yIdx] = y + shift;
            return orig(...nextArgs);
          }
          return orig(...args);
        });
      }

      const HC = proto('HTMLCanvasElement');
      if (HC) {
        const nativeToDataURL = gOPD(HC, 'toDataURL')?.value as Fn;
        const nativeToBlob = gOPD(HC, 'toBlob')?.value as Fn;
        method(HC, 'toDataURL', (self, args, orig) => {
          orig();
          const copy = noisedCopy(self as HTMLCanvasElement);
          return copy ? R.apply(nativeToDataURL, copy, args) : orig(...args);
        });
        method(HC, 'toBlob', (self, args, orig) => {
          const copy = noisedCopy(self as HTMLCanvasElement);
          return copy ? R.apply(nativeToBlob, copy, args) : orig(...args);
        });
      }

      const OC = proto('OffscreenCanvas');
      if (OC) {
        const blobDesc = gOPD(OC, 'convertToBlob');
        const nativeConvertToBlob = blobDesc && typeof blobDesc.value === 'function' ? (blobDesc.value as Fn) : undefined;
        if (nativeConvertToBlob) {
          method(OC, 'convertToBlob', (self, args, orig) => {
            const s = self as OffscreenCanvas;
            const copy = noisedCopy(s);
            if (!copy) return orig(...args);
            const off = new OffscreenCanvas(s.width, s.height);
            const offCtx = off.getContext('2d');
            if (offCtx) {
              offCtx.drawImage(copy, 0, 0);
              return R.apply(nativeConvertToBlob, off, args);
            }
            return orig(...args);
          });
        }
        const transferDesc = gOPD(OC, 'transferToImageBitmap');
        const nativeTransfer = transferDesc && typeof transferDesc.value === 'function' ? (transferDesc.value as Fn) : undefined;
        if (nativeTransfer) {
          method(OC, 'transferToImageBitmap', (self, args, orig) => {
            const s = self as OffscreenCanvas;
            const copy = noisedCopy(s);
            if (copy) {
              const off = new OffscreenCanvas(s.width, s.height);
              const offCtx = off.getContext('2d');
              if (offCtx) {
                offCtx.drawImage(copy, 0, 0);
                return R.apply(nativeTransfer, off, args);
              }
            }
            return orig(...args);
          });
        }
      }

      if (typeof (W as { createImageBitmap?: unknown }).createImageBitmap === 'function') {
        method(window as unknown as object, 'createImageBitmap', (_self, args, orig) => {
          const src = args[0];
          if (src && (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement || typeof OffscreenCanvas !== 'undefined' && src instanceof OffscreenCanvas)) {
            const copy = noisedCopy(src as HTMLCanvasElement | OffscreenCanvas);
            if (copy) {
              return (orig as (...a: unknown[]) => unknown)(copy, ...args.slice(1));
            }
          }
          return orig(...args);
        });
      }
    } else if (fp.canvas === 'off') {
      c = { ...c, canvas: 'block-readback' };
    }

    // ---- audio noise ----
    if (fp.audio === 'noise') {
      const done = new WeakSet<object>();
      method(proto('AudioBuffer'), 'getChannelData', (self, args, orig) => {
        const data = orig(...args) as Float32Array;
        if (!done.has(data)) {
          done.add(data);
          for (let i = 0; i < data.length; i += 97) {
            const h = hash(i, Number(args[0]) | 0);
            data[i] += ((h & 0xffff) / 0xffff - 0.5) * 1e-7;
          }
        }
        void self;
        return data;
      });
      method(proto('AudioBuffer'), 'copyFromChannel', (self, args, orig) => {
        const r = orig(...args);
        const destination = args[0] as Float32Array;
        if (destination && !done.has(destination)) {
          done.add(destination);
          for (let i = 0; i < destination.length; i += 97) {
            const h = hash(i, Number(args[1]) | 0);
            destination[i] += ((h & 0xffff) / 0xffff - 0.5) * 1e-7;
          }
        }
        void self;
        return r;
      });
      method(proto('AnalyserNode'), 'getFloatFrequencyData', (_self, args, orig) => {
        const r = orig(...args);
        const arr = args[0] as Float32Array;
        if (arr && arr.length) for (let i = 0; i < arr.length; i += 7) arr[i] += ((hash(i, 7) & 0xff) / 0xff - 0.5) * 1e-4;
        return r;
      });
      method(proto('AnalyserNode'), 'getByteFrequencyData', (_self, args, orig) => {
        const r = orig(...args);
        const arr = args[0] as Uint8Array;
        if (arr && arr.length) for (let i = 0; i < arr.length; i += 11) arr[i] ^= (hash(i, 11) & 1);
        return r;
      });
      const OAC = proto('OfflineAudioContext');
      if (OAC) {
        method(OAC, 'startRendering', (_self, _args, orig) => {
          const p = orig() as Promise<AudioBuffer>;
          return p.then((buf) => {
            if (buf && buf.numberOfChannels) {
              for (let c = 0; c < buf.numberOfChannels; c++) {
                const data = buf.getChannelData(c);
                if (!done.has(data)) {
                  done.add(data);
                  for (let i = 0; i < data.length; i += 97) {
                    const h = hash(i, c);
                    data[i] += ((h & 0xffff) / 0xffff - 0.5) * 1e-7;
                  }
                }
              }
            }
            return buf;
          });
        });
      }
    }

    // ---- client rects / fonts noise (sub-pixel, layout-safe) ----
    if (fp.clientRects === 'noise') {
      const shift = ((hash(1, 2) & 0xffff) / 0xffff - 0.5) * 2e-4;
      const DR = W.DOMRect as typeof DOMRect;
      const adjust = (r: DOMRect) => (DR ? new DR(r.x + shift, r.y + shift, r.width + shift, r.height + shift) : r);
      for (const P of [proto('Element'), proto('Range'), proto('SVGGraphicsElement')].filter(Boolean) as object[]) {
        method(P, 'getBoundingClientRect', (_s, args, orig) => adjust(orig(...args) as DOMRect));
        method(P, 'getClientRects', (_s, args, orig) => {
          const list = orig(...args) as DOMRectList;
          if (!list) return list;
          const arr = Array.from(list, adjust);
          return new Proxy(list, {
            get: (t, k) => (
              typeof k === 'string' && /^\d+$/.test(k) ? arr[Number(k)] :
              k === 'length' ? arr.length :
              k === 'item' ? (i: number) => arr[i] ?? null :
              k === Symbol.iterator ? arr[Symbol.iterator].bind(arr) :
              R.get(t, k, t)
            ),
          });
        });
      }
    }
    if (fp.fonts === 'noise' || fp.fonts === 'custom' || fp.canvas === 'noise') {
      const TM = proto('TextMetrics');
      const f = 1 + ((hash(3, 4) & 0xffff) / 0xffff - 0.5) * 2e-4;
      getter(TM, 'width', (_s, orig) => Number(orig()) * f);
      getter(TM, 'actualBoundingBoxLeft', (_s, orig) => Number(orig()) * f);
      getter(TM, 'actualBoundingBoxRight', (_s, orig) => Number(orig()) * f);
      getter(TM, 'actualBoundingBoxAscent', (_s, orig) => Number(orig()) * f);
      getter(TM, 'actualBoundingBoxDescent', (_s, orig) => Number(orig()) * f);
      getter(TM, 'fontBoundingBoxAscent', (_s, orig) => Number(orig()) * f);
      getter(TM, 'fontBoundingBoxDescent', (_s, orig) => Number(orig()) * f);
    }

    // ---- WebRTC ----
    if (fp.webrtcMode === 'off' || fp.webrtcMode === 'disable') {
      for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCSessionDescription', 'RTCIceCandidate']) {
        try { dP(window, k, { value: undefined, writable: true, configurable: true, enumerable: false }); } catch { /* ignore */ }
      }
    } else if ((fp.webrtcMode === 'altered' || fp.webrtcMode === 'manual' || fp.webrtcMode === 'substitute') && fp.webrtcIp) {
      const ip = fp.webrtcIp;
      const ipv4 = /\b(?!0\.0\.0\.0\b)(?!127\.)(?:\d{1,3}\.){3}\d{1,3}\b/g;
      const mdns = /\b[0-9a-f-]{36}\.local\b/gi;
      const rewrite = (s: unknown) => (typeof s === 'string' ? s.replace(ipv4, ip).replace(mdns, ip) : s);
      getter(proto('RTCIceCandidate'), 'candidate', (_s, orig) => rewrite(orig()));
      getter(proto('RTCIceCandidate'), 'address', (_s, orig) => rewrite(orig()));
      getter(proto('RTCSessionDescription'), 'sdp', (_s, orig) => rewrite(orig()));
      method(proto('RTCIceCandidate'), 'toJSON', (_s, args, orig) => {
        const j = orig(...args) as Record<string, unknown>;
        if (j && typeof j.candidate === 'string') j.candidate = rewrite(j.candidate);
        return j;
      });
      method(proto('RTCSessionDescription'), 'toJSON', (_s, args, orig) => {
        const j = orig(...args) as Record<string, unknown>;
        if (j && typeof j.sdp === 'string') j.sdp = rewrite(j.sdp);
        return j;
      });
    }

    // ---- media devices (counts; labels stay empty until permission like Chrome) ----
    if (fp.mediaDevices) {
      const want = fp.mediaDevices;
      const MDI = W.MediaDeviceInfo as { prototype: object } | undefined;
      const IDI = (W.InputDeviceInfo as { prototype: object } | undefined) ?? MDI;
      method(MD, 'enumerateDevices', (_s, args, orig) => (orig(...args) as Promise<MediaDeviceInfo[]>).then((real) => {
        const out: MediaDeviceInfo[] = [];
        const normalize = (value: string) => value.trim().toLocaleLowerCase()
          .replace(/^(default|communications|domyślne|komunikacja)\s*[-–:]\s*/i, '');
        const ordered = (kind: MediaDeviceKind, selectedLabel = '') => {
          const devices = real.filter((device) => device.kind === kind);
          if (!selectedLabel) return devices;
          const selected = devices.find((device) => normalize(device.label) === normalize(selectedLabel));
          return selected ? [selected, ...devices.filter((device) => device !== selected)] : devices;
        };
        const orderedByKind = new Map<MediaDeviceKind, MediaDeviceInfo[]>([
          ['audioinput', ordered('audioinput', c.microphoneLabel)],
          ['videoinput', ordered('videoinput', c.cameraLabel)],
          ['audiooutput', ordered('audiooutput')],
        ]);
        const make = (kind: MediaDeviceKind, i: number): MediaDeviceInfo => {
          const existing = orderedByKind.get(kind)?.[i];
          if (existing) return existing;
          const gid = hash(kind.length, i).toString(16).padStart(8, '0').repeat(8);
          const o = { deviceId: '', kind, label: '', groupId: gid, toJSON() { return { deviceId: '', kind, label: '', groupId: gid }; } };
          const p = kind === 'audiooutput' ? MDI : IDI;
          if (p) Object.setPrototypeOf(o, p.prototype);
          return o as unknown as MediaDeviceInfo;
        };
        const audioInputs = Math.max(want.audioInputs, c.microphoneLabel ? 1 : 0);
        const videoInputs = Math.max(want.videoInputs, c.cameraLabel ? 1 : 0);
        for (let i = 0; i < audioInputs; i++) out.push(make('audioinput', i));
        for (let i = 0; i < videoInputs; i++) out.push(make('videoinput', i));
        for (let i = 0; i < want.audioOutputs; i++) out.push(make('audiooutput', i));
        return out;
      }));
    }
  }

  // ======================================================= STRICT PRESET
  if (c.hw === 'normalize') {
    const Nav = proto('Navigator');
    fixed(Nav, 'hardwareConcurrency', c.hwValues.hardwareConcurrency);
    fixed(Nav, 'deviceMemory', c.hwValues.deviceMemory);
    try { delete (Nav as Record<string, unknown>).getBattery; } catch { /* ignore */ }
    method(Nav, 'getGamepads', (_s, _a, orig) => { orig(); return []; });
  }
  if (c.canvas === 'block-readback') {
    const blankLike = (src: { width: number; height: number }) => Object.assign(document.createElement('canvas'), { width: src.width, height: src.height });
    const HC = proto('HTMLCanvasElement') as { toDataURL: Fn; toBlob: Fn } | undefined;
    if (HC) {
      const nd = gOPD(HC, 'toDataURL')?.value as Fn;
      const nb = gOPD(HC, 'toBlob')?.value as Fn;
      method(HC, 'toDataURL', (self, args) => R.apply(nd, blankLike(self as HTMLCanvasElement), args));
      method(HC, 'toBlob', (self, args) => R.apply(nb, blankLike(self as HTMLCanvasElement), args));
    }
    const blankData = (_s: unknown, args: unknown[]) => new ImageData(Math.max(1, Math.abs(Math.floor(Number(args[2])))) || 1, Math.max(1, Math.abs(Math.floor(Number(args[3])))) || 1);
    method(proto('CanvasRenderingContext2D'), 'getImageData', blankData);
    method(proto('OffscreenCanvasRenderingContext2D'), 'getImageData', blankData);
    method(proto('OffscreenCanvas'), 'convertToBlob', (self, args, orig) => {
      const s = self as OffscreenCanvas;
      return R.apply(orig as Fn, new OffscreenCanvas(s.width, s.height), args);
    });
    // WebGL readback is not patched here. Graphics exposure is an engine policy.
  }

  // ======================================================= AUDIO MIXER
  const HM = proto('HTMLMediaElement');
  const desc = HM && gOPD(HM, 'volume');
  if (!HM || !desc || !desc.get || !desc.set) return;
  const nativeGet = desc.get;
  const nativeSet = desc.set;
  const pageVolume = new WeakMap<object, number>();
  let factor = Math.min(1, Math.max(0, c.volume));
  let sinkId = c.sinkId;
  const apply = (el: HTMLMediaElement) => {
    if (!pageVolume.has(el)) pageVolume.set(el, nativeGet.call(el) as number);
    nativeSet.call(el, (pageVolume.get(el) as number) * factor);
    const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };
    if (withSink.setSinkId && withSink.sinkId !== sinkId) withSink.setSinkId(sinkId).catch(() => { /* device gone */ });
  };
  {
    dP(HM, 'volume', {
      ...desc,
      get: hook(nativeGet as Fn, (t, self, a) => (pageVolume.has(self as object) ? pageVolume.get(self as object) : R.apply(t, self, a))),
      set: hook(nativeSet as Fn, (t, self, a) => {
        const n = Number(a[0]);
        if (!(n >= 0 && n <= 1)) return R.apply(t, self, a);
        pageVolume.set(self as object, n);
        return R.apply(t, self, [n * factor]);
      }),
    });
    document.addEventListener('play', (e) => { if (e.target instanceof HTMLMediaElement) apply(e.target); }, true);
  }
  document.addEventListener(eventName, (e) => {
    const d = (e as CustomEvent<{ type?: string; f?: number; s?: string }>).detail;
    if (!d || typeof d.f !== 'number') return;
    factor = Math.min(1, Math.max(0, d.f));
    sinkId = String(d.s ?? '');
    document.querySelectorAll('audio,video').forEach((el) => apply(el as HTMLMediaElement));
  });
}
