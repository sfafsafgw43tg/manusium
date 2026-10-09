/**
 * packages/core/src/audit.ts
 *
 * OctoDetect.su report model and scoring. Pure functions - the probe page
 * collects ProbeData in the browser, the main process adds EnvironmentData,
 * and buildReport() turns both into a list of findings with a risk level.
 *
 * Wording rules: never "undetectable", "100% anonymous" or similar. Risk is
 * "low / medium / high / cannot be determined", and uniqueness can only be
 * estimated (there is no reference population in a local tool).
 */
import { assessDns, assessWebRtc, isPrivateIp, LeakStatus } from './network';

export type PermState = 'granted' | 'denied' | 'prompt' | 'unsupported' | 'error';

export interface ProbeData {
  collectedAt: string;
  userAgent: string;
  platform: string;
  uaData?: { platform?: string; mobile?: boolean; brands?: string[] };
  language: string;
  languages: string[];
  timezone: string;
  timezoneOffsetMin: number;
  screen: { width: number; height: number; availWidth: number; availHeight: number; colorDepth: number; pixelRatio: number };
  hardwareConcurrency: number | null;
  deviceMemory: number | null;
  maxTouchPoints: number;
  fonts: { tested: number; detected: string[] };
  canvas: { supported: boolean; readable: boolean; blank: boolean; hash?: string };
  webgl: { supported: boolean; vendor?: string; renderer?: string; unmasked: boolean; extensions?: number };
  audio: { supported: boolean; readable: boolean; hash?: string; sampleRate?: number };
  webrtc: { supported: boolean; ips: string[]; mdnsOnly: boolean; error?: string };
  cookies: { enabled: boolean };
  storage: { localStorage: boolean; sessionStorage: boolean; indexedDB: boolean; serviceWorker: boolean; cacheApi: boolean };
  permissions: Record<'geolocation' | 'camera' | 'microphone' | 'notifications', PermState>;
  mediaDevices: { supported: boolean; count: number; labelsVisible: boolean };
  apis: Record<'battery' | 'gamepad' | 'bluetooth' | 'usb' | 'hid' | 'serial' | 'webgpu' | 'clipboardRead', boolean>;
  gpc: boolean | null;
  doNotTrack: string | null;
  secureContext: boolean;
  protocol: string;
  rendererSandboxed: boolean | null;
  /** Web-accessible resources probing is intentionally NOT done (it is a fingerprinting technique itself). */
  extensionsDetectable: false;
  fingerprintHash: string;
}

export interface EnvironmentData {
  publicIp?: string; // only if the user consented to the external lookup
  publicIpConsent: boolean;
  dnsServers: string[];
  dohActive: boolean;
  proxyActive: boolean;
  proxyDescription?: string;
  vpnAdapters: string[];
  torActive: boolean;
  thirdPartyCookies: 'blocked' | 'allowed' | 'unknown';
  windowsSandbox: boolean;
  /** null = cannot be determined (e.g. an external browser was audited). */
  profileIsolated: boolean | null;
  profileName: string;
  webrtcPolicy?: string;
  httpsOnly?: boolean;
}

export type FindingStatus = 'exposed' | 'limited' | 'blocked' | 'unknown';
export type Entropy = 'low' | 'medium' | 'high';
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export interface Finding {
  id: string;
  category: 'identity' | 'hardware' | 'fingerprint' | 'network' | 'storage' | 'permissions' | 'isolation';
  /** Display value (not localised - technical data). */
  value: string;
  status: FindingStatus;
  entropy: Entropy;
  /** Risk points contributed. */
  points: number;
  /** i18n keys: why is it available, what can reduce it. */
  whyKey: string;
  fixKey?: string;
}

export interface AuditReport {
  schema: 1;
  app: 'OctoDetect.su';
  generatedAt: string;
  profileName: string;
  risk: RiskLevel;
  score: number;
  findings: Finding[];
  consistency: Array<{ key: string; detail: string }>;
  highEntropyExposed: number;
  /** Estimated: 'likely-unique' when many high-entropy attributes are readable. */
  uniqueness: 'likely-common' | 'possibly-unique' | 'likely-unique' | 'unknown';
  dns: LeakStatus;
  webrtc: LeakStatus;
  fingerprintHash: string;
}

const permFinding = (id: string, state: PermState): Finding => ({
  id,
  category: 'permissions',
  value: state,
  status: state === 'granted' ? 'exposed' : state === 'denied' || state === 'unsupported' ? 'blocked' : 'limited',
  entropy: 'low',
  points: state === 'granted' ? 1 : 0,
  whyKey: `why.perm.${state}`,
  fixKey: state === 'granted' ? 'fix.revokePermission' : undefined,
});

export function buildReport(p: ProbeData | null, env: EnvironmentData, now = new Date()): AuditReport {
  const findings: Finding[] = [];
  const consistency: Array<{ key: string; detail: string }> = [];
  if (!p) {
    return {
      schema: 1, app: 'OctoDetect.su', generatedAt: now.toISOString(), profileName: env.profileName,
      risk: 'unknown', score: 0, findings, consistency, highEntropyExposed: 0, uniqueness: 'unknown',
      dns: 'unknown', webrtc: 'unknown', fingerprintHash: '',
    };
  }
  const add = (f: Finding) => findings.push(f);

  // ---- identity -------------------------------------------------------
  add({ id: 'userAgent', category: 'identity', value: p.userAgent, status: 'exposed', entropy: 'medium', points: 0, whyKey: 'why.userAgent' });
  add({ id: 'os', category: 'identity', value: p.uaData?.platform || p.platform, status: 'exposed', entropy: 'low', points: 0, whyKey: 'why.os' });
  add({ id: 'language', category: 'identity', value: p.languages.join(', ') || p.language, status: 'exposed', entropy: p.languages.length > 2 ? 'medium' : 'low', points: p.languages.length > 2 ? 1 : 0, whyKey: 'why.language', fixKey: p.languages.length > 2 ? 'fix.fewerLanguages' : undefined });
  add({ id: 'timezone', category: 'identity', value: `${p.timezone} (UTC${p.timezoneOffsetMin <= 0 ? '+' : '-'}${Math.abs(p.timezoneOffsetMin / 60)})`, status: 'exposed', entropy: 'medium', points: 0, whyKey: 'why.timezone' });
  add({ id: 'screen', category: 'hardware', value: `${p.screen.width}×${p.screen.height} @${p.screen.pixelRatio}x, ${p.screen.colorDepth}-bit`, status: 'exposed', entropy: 'medium', points: 0, whyKey: 'why.screen' });

  // ---- hardware -------------------------------------------------------
  const hwNormalized = p.hardwareConcurrency === 4 && (p.deviceMemory === 8 || p.deviceMemory === null);
  add({ id: 'hardware', category: 'hardware', value: `CPU threads: ${p.hardwareConcurrency ?? '—'}, RAM: ${p.deviceMemory ?? '—'} GB, touch: ${p.maxTouchPoints}`, status: hwNormalized ? 'limited' : 'exposed', entropy: hwNormalized ? 'low' : 'medium', points: hwNormalized ? 0 : 1, whyKey: hwNormalized ? 'why.hardwareNormalized' : 'why.hardware', fixKey: hwNormalized ? undefined : 'fix.strictPreset' });
  const devApis = (['battery', 'bluetooth', 'usb', 'hid', 'serial'] as const).filter((k) => p.apis[k]);
  add({ id: 'deviceApis', category: 'hardware', value: devApis.join(', ') || '—', status: devApis.length ? 'exposed' : 'blocked', entropy: 'low', points: p.apis.battery ? 1 : 0, whyKey: 'why.deviceApis', fixKey: devApis.length ? 'fix.blockDevices' : undefined });

  // ---- fingerprint surfaces -----------------------------------------
  add({ id: 'fonts', category: 'fingerprint', value: `${p.fonts.detected.length}/${p.fonts.tested}: ${p.fonts.detected.slice(0, 12).join(', ')}${p.fonts.detected.length > 12 ? '…' : ''}`, status: p.fonts.detected.length > 0 ? 'exposed' : 'limited', entropy: p.fonts.detected.length > 20 ? 'high' : 'medium', points: p.fonts.detected.length > 20 ? 2 : 1, whyKey: 'why.fonts', fixKey: 'fix.fonts' });
  add({ id: 'canvas', category: 'fingerprint', value: !p.canvas.supported ? 'unsupported' : p.canvas.readable && !p.canvas.blank ? `readable (${(p.canvas.hash ?? '').slice(0, 12)}…)` : 'read-back blocked', status: !p.canvas.supported ? 'blocked' : p.canvas.readable && !p.canvas.blank ? 'exposed' : 'blocked', entropy: 'high', points: p.canvas.readable && !p.canvas.blank ? 2 : 0, whyKey: 'why.canvas', fixKey: p.canvas.readable && !p.canvas.blank ? 'fix.canvas' : undefined });
  add({ id: 'webgl', category: 'fingerprint', value: !p.webgl.supported ? 'disabled' : `${p.webgl.vendor ?? '?'} / ${p.webgl.renderer ?? '?'}${p.webgl.unmasked ? ' (unmasked)' : ''}`, status: !p.webgl.supported ? 'blocked' : p.webgl.unmasked ? 'exposed' : 'limited', entropy: p.webgl.unmasked ? 'high' : 'medium', points: !p.webgl.supported ? 0 : p.webgl.unmasked ? 2 : 1, whyKey: 'why.webgl', fixKey: p.webgl.supported ? 'fix.webgl' : undefined });
  add({ id: 'audio', category: 'fingerprint', value: !p.audio.supported ? 'unsupported' : p.audio.readable ? `readable (${(p.audio.hash ?? '').slice(0, 12)}…, ${p.audio.sampleRate ?? '?'} Hz)` : 'blocked', status: !p.audio.supported || !p.audio.readable ? 'blocked' : 'exposed', entropy: 'medium', points: p.audio.readable ? 1 : 0, whyKey: 'why.audio', fixKey: p.audio.readable ? 'fix.strictPreset' : undefined });
  add({ id: 'extensions', category: 'fingerprint', value: 'not probed', status: 'unknown', entropy: 'low', points: 0, whyKey: 'why.extensions' });

  // ---- network ------------------------------------------------------
  const tunnel = env.proxyActive || env.torActive || env.vpnAdapters.length > 0;
  const webrtc = !p.webrtc.supported ? 'ok' : assessWebRtc({ rtcIps: p.webrtc.ips, httpPublicIp: env.publicIp, tunnelActive: tunnel, policy: env.webrtcPolicy });
  const dns = assessDns({ dnsServers: env.dnsServers, vpnDetected: env.vpnAdapters.length > 0, proxyActive: env.proxyActive || env.torActive, dohActive: env.dohActive });
  add({ id: 'publicIp', category: 'network', value: env.publicIp ?? (env.publicIpConsent ? 'lookup failed' : 'not checked (no consent)'), status: env.publicIp ? 'exposed' : 'unknown', entropy: 'high', points: 0, whyKey: 'why.publicIp', fixKey: 'fix.vpnOrTor' });
  add({ id: 'webrtc', category: 'network', value: !p.webrtc.supported ? 'unsupported' : p.webrtc.ips.length ? p.webrtc.ips.join(', ') : p.webrtc.mdnsOnly ? 'mDNS only (.local)' : 'no IP exposed', status: webrtc === 'leak' ? 'exposed' : webrtc === 'warning' ? 'exposed' : webrtc === 'ok' ? 'blocked' : 'unknown', entropy: p.webrtc.ips.some((ip) => !isPrivateIp(ip)) ? 'high' : 'medium', points: webrtc === 'leak' ? 5 : webrtc === 'warning' ? 2 : 0, whyKey: `why.webrtc.${webrtc}`, fixKey: webrtc === 'ok' ? undefined : 'fix.webrtc' });
  add({ id: 'dns', category: 'network', value: `${env.dohActive ? 'DNS-over-HTTPS; ' : ''}${env.dnsServers.join(', ') || '—'}`, status: dns === 'warning' || dns === 'leak' ? 'exposed' : dns === 'ok' ? 'limited' : 'unknown', entropy: 'low', points: dns === 'warning' ? 2 : dns === 'leak' ? 4 : 0, whyKey: `why.dns.${dns}`, fixKey: dns === 'ok' ? undefined : 'fix.dns' });
  add({ id: 'proxy', category: 'network', value: env.torActive ? 'Tor' : env.proxyActive ? env.proxyDescription ?? 'proxy' : env.vpnAdapters.length ? `VPN? (${env.vpnAdapters.join(', ')})` : 'direct', status: tunnel ? 'limited' : 'exposed', entropy: 'low', points: 0, whyKey: tunnel ? 'why.tunnel' : 'why.direct' });
  add({ id: 'https', category: 'network', value: `${p.protocol} secureContext=${p.secureContext}${env.httpsOnly !== undefined ? ` httpsOnly=${env.httpsOnly}` : ''}`, status: p.secureContext ? 'limited' : 'exposed', entropy: 'low', points: p.secureContext ? 0 : 1, whyKey: 'why.https', fixKey: p.secureContext ? undefined : 'fix.httpsOnly' });

  // ---- storage ------------------------------------------------------
  add({ id: 'cookies', category: 'storage', value: `first-party: ${p.cookies.enabled ? 'on' : 'off'}; third-party: ${env.thirdPartyCookies}`, status: env.thirdPartyCookies === 'allowed' ? 'exposed' : env.thirdPartyCookies === 'blocked' ? 'limited' : 'unknown', entropy: 'low', points: env.thirdPartyCookies === 'allowed' ? 2 : 0, whyKey: 'why.cookies', fixKey: env.thirdPartyCookies === 'allowed' ? 'fix.thirdPartyCookies' : undefined });
  const st = p.storage;
  add({ id: 'storage', category: 'storage', value: `localStorage=${st.localStorage} sessionStorage=${st.sessionStorage} IndexedDB=${st.indexedDB} ServiceWorker=${st.serviceWorker} CacheAPI=${st.cacheApi}`, status: 'exposed', entropy: 'low', points: 0, whyKey: 'why.storage', fixKey: 'fix.clearOnExit' });

  // ---- permissions --------------------------------------------------
  add(permFinding('geolocation', p.permissions.geolocation));
  add(permFinding('camera', p.permissions.camera));
  add(permFinding('microphone', p.permissions.microphone));
  add({ id: 'mediaDevices', category: 'permissions', value: p.mediaDevices.supported ? `${p.mediaDevices.count} devices, labels ${p.mediaDevices.labelsVisible ? 'visible' : 'hidden'}` : 'unsupported', status: p.mediaDevices.labelsVisible ? 'exposed' : 'limited', entropy: p.mediaDevices.labelsVisible ? 'high' : 'low', points: p.mediaDevices.labelsVisible ? 2 : 0, whyKey: 'why.mediaDevices', fixKey: p.mediaDevices.labelsVisible ? 'fix.revokePermission' : undefined });

  // ---- isolation ----------------------------------------------------
  add({ id: 'sandbox', category: 'isolation', value: `renderer sandbox=${p.rendererSandboxed ?? 'unknown'}; Windows Sandbox=${env.windowsSandbox}`, status: p.rendererSandboxed ? 'limited' : 'unknown', entropy: 'low', points: 0, whyKey: 'why.sandbox' });
  add({ id: 'isolation', category: 'isolation', value: env.profileIsolated === null ? 'unknown' : env.profileIsolated ? 'separate partition' : 'shared', status: env.profileIsolated === null ? 'unknown' : env.profileIsolated ? 'limited' : 'exposed', entropy: 'low', points: env.profileIsolated === false ? 2 : 0, whyKey: 'why.isolation' });

  // ---- consistency checks (misconfiguration, not "spoof hints") ------
  const uaWin = /Windows NT/.test(p.userAgent);
  if (uaWin && p.platform && !/^Win/.test(p.platform)) consistency.push({ key: 'cons.uaPlatform', detail: `${p.platform}` });
  if (p.uaData?.platform && uaWin && p.uaData.platform !== 'Windows') consistency.push({ key: 'cons.uaData', detail: p.uaData.platform });
  if (p.languages.length && p.language && p.languages[0] !== p.language) consistency.push({ key: 'cons.language', detail: `${p.language} vs ${p.languages[0]}` });
  if (p.screen.availWidth > p.screen.width || p.screen.availHeight > p.screen.height) consistency.push({ key: 'cons.screen', detail: `${p.screen.availWidth}×${p.screen.availHeight}` });
  if (tunnel && webrtc === 'leak') consistency.push({ key: 'cons.webrtcTunnel', detail: p.webrtc.ips.join(', ') });

  const score = findings.reduce((s, f) => s + f.points, 0) + consistency.length;
  const highEntropyExposed = findings.filter((f) => f.entropy === 'high' && f.status === 'exposed').length;
  // Bands are calibrated against a real, unprotected Chromium: it exposes
  // canvas + WebGL + fonts + media devices and usually leaks DNS/WebRTC, which
  // lands it in "high". The Standard level keeps canvas/WebGL readable (needed
  // for compatibility) but blocks trackers, third-party cookies and upgrades
  // HTTPS, which lands it in "medium"; Strict additionally blocks canvas
  // read-back, WebGL and normalised hardware values, which lands it in "low".
  // The points themselves are untouched - only the labels are calibrated.
  const risk: RiskLevel = score >= 14 ? 'high' : score >= 5 ? 'medium' : 'low';
  const uniqueness = highEntropyExposed >= 3 ? 'likely-unique' : highEntropyExposed >= 1 ? 'possibly-unique' : 'likely-common';

  return {
    schema: 1,
    app: 'OctoDetect.su',
    generatedAt: now.toISOString(),
    profileName: env.profileName,
    risk,
    score,
    findings,
    consistency,
    highEntropyExposed,
    uniqueness,
    dns,
    webrtc,
    fingerprintHash: p.fingerprintHash,
  };
}

/** Basic structural validation of probe data received over IPC / local HTTP. */
export function validateProbe(obj: unknown): ProbeData {
  const p = obj as ProbeData;
  const ok = p && typeof p === 'object' && typeof p.userAgent === 'string' && Array.isArray(p.languages) &&
    typeof p.screen === 'object' && typeof p.canvas === 'object' && typeof p.webrtc === 'object' && Array.isArray(p.webrtc.ips) &&
    typeof p.fonts === 'object' && Array.isArray(p.fonts.detected) && typeof p.permissions === 'object' && typeof p.apis === 'object';
  if (!ok) throw new Error('Invalid probe data');
  // Limit sizes (the local endpoint must not be abusable for memory exhaustion).
  p.userAgent = p.userAgent.slice(0, 512);
  p.languages = p.languages.slice(0, 20).map(String);
  p.webrtc.ips = p.webrtc.ips.slice(0, 20).map(String).filter((s) => s.length < 64);
  p.fonts.detected = p.fonts.detected.slice(0, 200).map(String);
  return p;
}
