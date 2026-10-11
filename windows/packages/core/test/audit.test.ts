/** packages/core/test/audit.test.ts - OctoDetect scoring, leak heuristics, sandbox config. */
import { describe, expect, it } from 'vitest';
import { assessWebRtc, buildReport, buildWsbConfig, detectVpnAdapters, EnvironmentData, ProbeData, quoteWinArg } from '../src';

const baseProbe = (): ProbeData => ({
  collectedAt: '', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140', platform: 'Win32',
  uaData: { platform: 'Windows', mobile: false, brands: [] }, language: 'pl-PL', languages: ['pl-PL', 'pl'],
  timezone: 'Europe/Warsaw', timezoneOffsetMin: -120,
  screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelRatio: 1 },
  hardwareConcurrency: 4, deviceMemory: 8, maxTouchPoints: 0, fonts: { tested: 60, detected: ['Arial', 'Calibri'] },
  canvas: { supported: true, readable: false, blank: true }, webgl: { supported: false, unmasked: false },
  audio: { supported: true, readable: false }, webrtc: { supported: true, ips: [], mdnsOnly: false },
  cookies: { enabled: true }, storage: { localStorage: true, sessionStorage: true, indexedDB: true, serviceWorker: true, cacheApi: true },
  permissions: { geolocation: 'prompt', camera: 'prompt', microphone: 'prompt', notifications: 'denied' },
  mediaDevices: { supported: true, count: 0, labelsVisible: false },
  apis: { battery: false, gamepad: true, bluetooth: false, usb: false, hid: false, serial: false, webgpu: false, clipboardRead: false },
  gpc: true, doNotTrack: null, secureContext: true, protocol: 'octo-probe:', rendererSandboxed: true, extensionsDetectable: false,
  fingerprintHash: 'abc',
});
const env = (o: Partial<EnvironmentData> = {}): EnvironmentData => ({
  publicIpConsent: false, dnsServers: ['192.168.1.1'], dohActive: false, proxyActive: false, vpnAdapters: [], torActive: false,
  thirdPartyCookies: 'blocked', windowsSandbox: false, profileIsolated: true, profileName: 'Strict', ...o,
});

describe('audit report', () => {
  it('strict-like probe => low risk', () => {
    const r = buildReport(baseProbe(), env());
    expect(r.risk).toBe('low');
    expect(r.uniqueness).toBe('likely-common');
  });

  it('open fingerprint surfaces + WebRTC leak => high risk', () => {
    const p = baseProbe();
    p.canvas = { supported: true, readable: true, blank: false, hash: 'ffff' };
    p.webgl = { supported: true, vendor: 'NVIDIA', renderer: 'RTX', unmasked: true };
    p.webrtc.ips = ['192.168.1.20', '203.0.113.9'];
    p.mediaDevices.labelsVisible = true;
    const r = buildReport(p, env({ publicIp: '198.51.100.1', publicIpConsent: true, vpnAdapters: ['WireGuard Tunnel'] }));
    expect(r.webrtc).toBe('leak');
    expect(r.risk).toBe('high');
    expect(r.uniqueness).toBe('likely-unique');
  });

  it('plain Chromium scores worse than OctoBrowser Standard, and Standard worse than Strict', () => {
    // Plain Chromium: canvas + WebGL readable, real hardware, DNS + WebRTC leak.
    const plain = baseProbe();
    plain.canvas = { supported: true, readable: true, blank: false, hash: 'ffff' };
    plain.webgl = { supported: true, vendor: 'Google Inc.', renderer: 'ANGLE', unmasked: true };
    plain.webrtc.ips = ['192.168.1.20', '203.0.113.9'];
    plain.mediaDevices.labelsVisible = true;
    plain.fonts.detected = Array.from({ length: 40 }, (_, i) => `Font${i}`);
    plain.audio = { supported: true, readable: true, hash: 'aaaa' };
    plain.permissions = { geolocation: 'granted', camera: 'granted', microphone: 'prompt', notifications: 'granted' };
    const plainReport = buildReport(plain, env({ publicIp: '198.51.100.1', publicIpConsent: true, dnsServers: ['192.168.1.1'], thirdPartyCookies: 'allowed' }));

    // OctoBrowser Standard: the same fingerprint surfaces, but no leaks and
    // trackers / third-party cookies / HTTPS-only are handled.
    const standard = baseProbe();
    standard.canvas = { supported: true, readable: true, blank: false, hash: 'ffff' };
    standard.webgl = { supported: true, vendor: 'Google Inc.', renderer: 'ANGLE', unmasked: true };
    standard.mediaDevices.labelsVisible = true;
    const standardReport = buildReport(standard, env({ publicIp: '198.51.100.1', publicIpConsent: true, dnsServers: ['9.9.9.9'] }));

    // OctoBrowser Strict: canvas read-back blocked, WebGL off, hardware normalised.
    const strict = baseProbe();
    strict.hardwareConcurrency = 4;
    strict.mediaDevices = { supported: true, count: 0, labelsVisible: false };
    const strictReport = buildReport(strict, env({ dnsServers: ['9.9.9.9'] }));

    expect(plainReport.score).toBeGreaterThan(standardReport.score);
    expect(standardReport.score).toBeGreaterThan(strictReport.score);
    expect(plainReport.risk).toBe('high');
    expect(standardReport.risk).toBe('medium');
    expect(strictReport.risk).toBe('low');
    expect(plainReport.uniqueness).toBe('likely-unique');
    expect(strictReport.uniqueness).toBe('likely-common');
  });

  it('no data => cannot be determined', () => {
    expect(buildReport(null, env()).risk).toBe('unknown');
  });

  it('never uses forbidden marketing phrases', () => {
    const json = JSON.stringify(buildReport(baseProbe(), env())).toLowerCase();
    for (const bad of ['undetectable', 'niewykrywalny', '100%', 'bypass']) expect(json).not.toContain(bad);
  });
});

describe('network heuristics', () => {
  it('detects VPN adapters by name', () => {
    expect(detectVpnAdapters({ 'WireGuard Tunnel': [{ address: '10.2.0.2', family: 'IPv4', internal: false }], Ethernet: [{ address: '192.168.1.2', family: 'IPv4', internal: false }] })).toEqual(['WireGuard Tunnel']);
  });
  it('WebRTC policy with no IPs is ok', () => {
    expect(assessWebRtc({ rtcIps: [], tunnelActive: true, policy: 'disable_non_proxied_udp' })).toBe('ok');
  });
});

describe('Windows Sandbox config', () => {
  it('maps the app read-only, escapes XML and quotes paths with spaces/Polish letters', () => {
    const xml = buildWsbConfig({
      appHostDir: 'C:\\Program Files\\OctoSuite\\Żółta & <app>', exeName: 'Octo.su.exe', networking: true,
      clipboard: false, audioInput: false, videoInput: false, args: ['--lang-choice=pl', '--ephemeral-data-dir=C:\\Users\\WDAGUtilityAccount\\Octo Data'],
    });
    expect(xml).toContain('<vGPU>Disable</vGPU>');
    expect(xml).toContain('<MappedFolders>');
    expect(xml.match(/<MappedFolder>/g)?.length).toBe(1);
    expect(xml).toContain('<ReadOnly>true</ReadOnly>');
    expect(xml).toContain('<PrinterRedirection>Disable</PrinterRedirection>');
    expect(xml).toContain('<AudioInput>Disable</AudioInput>');
    expect(xml).toContain('&amp; &lt;app&gt;');
    expect(xml).toContain('<ClipboardRedirection>Disable</ClipboardRedirection>');
    expect(xml).toContain('<VideoInput>Disable</VideoInput>');
    expect(xml).toContain('&quot;--ephemeral-data-dir=C:\\Users\\WDAGUtilityAccount\\Octo Data&quot;');
  });
  it('quotes Windows arguments', () => {
    expect(quoteWinArg('simple')).toBe('simple');
    expect(quoteWinArg('with space')).toBe('"with space"');
    expect(quoteWinArg('a"b')).toBe('"a\\"b"');
  });
});
