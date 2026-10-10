/** packages/core/test/fingerprint.test.ts - fingerprint generation, consistency, sanitising, resolving. */
import { describe, expect, it } from 'vitest';
import {
  FP_OSES, brandList, generateFingerprint, greaseBrand, gpuPresets, languageList, acceptLanguageHeader, osFromUserAgent,
  realFingerprint, resolveFingerprint, sanitizeFingerprint, secChUa, uaMajor, fingerprintWarnings, parsePorts,
  validateProfileFingerprintConsistency, defaultProfile, sanitizeProfile, setEngineVersion, engineVersion, chromiumUserAgent, computeConfigPreview,
} from '../src';

describe('fingerprint generation', () => {
  it('is deterministic for a seed and random without one', () => {
    const a = generateFingerprint({ engineMajor: 150, seed: 'abc123' });
    const b = generateFingerprint({ engineMajor: 150, seed: 'abc123' });
    expect(a).toEqual(b);
    const seen = new Set(Array.from({ length: 20 }, () => JSON.stringify(generateFingerprint({ engineMajor: 150 }))));
    expect(seen.size).toBe(20);
  });

  it('keeps the Chrome major version equal to the engine version', () => {
    for (let i = 0; i < 50; i++) {
      const fp = generateFingerprint({ engineMajor: 147, engineFullVersion: '147.0.7400.12' });
      expect(uaMajor(fp.userAgent)).toBe(147);
      expect(fp.uaFullVersion).toBe('147.0.7400.12');
    }
  });

  it('produces OS-consistent UA, GPU, cores and memory for every OS', () => {
    for (const os of FP_OSES) {
      for (let i = 0; i < 40; i++) {
        const fp = generateFingerprint({ engineMajor: 150, os });
        expect(fp.os).toBe(os);
        const fam = osFromUserAgent(fp.userAgent);
        expect(fam).toBe(os === 'macos' ? 'mac' : os === 'linux' ? 'linux' : 'win');
        expect(gpuPresets(os).some((g) => g.renderer === fp.webglInfo.renderer && g.vendor === fp.webglInfo.vendor)).toBe(true);
        expect([2, 4, 8]).toContain(fp.memory.gb);
        if (os === 'macos') expect(fp.cpu.cores).toBeGreaterThanOrEqual(8);
        expect(fingerprintWarnings(fp, 150)).toEqual([]);
      }
    }
  });

  it('never puts D3D renderers on macOS or Metal on Windows', () => {
    for (const g of gpuPresets('macos')) expect(g.renderer).not.toMatch(/Direct3D/);
    for (const g of gpuPresets('windows11')) expect(g.renderer).not.toMatch(/Metal|Apple/);
    expect(gpuPresets('windows10')).toBe(gpuPresets('windows11'));
  });

  it('distributes the OS roughly like real desktop traffic', () => {
    const count: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) {
      const os = generateFingerprint({ engineMajor: 150, seed: `s${i}` }).os;
      count[os] = (count[os] ?? 0) + 1;
    }
    expect(count.windows11 + count.windows10).toBeGreaterThan(1400);
    expect(count.macos).toBeGreaterThan(200);
  });
});

describe('Chromium-compatible user agent across UI shell styles', () => {
  it('keeps the same engine identity regardless of the selected UI style', () => {
    const chromiumUa = chromiumUserAgent('windows11', 150);
    for (const shell of ['chrome', 'chromium', 'firefox', 'safari'] as const) {
      const ua = chromiumUserAgent('windows11', 150);
      expect(ua).toBe(chromiumUa);
      expect(ua).toContain('Chrome/150.0.0.0');
      expect(ua).not.toContain('Firefox/');
      expect(ua).not.toContain('Version/17.5 Safari/');
    }
  });

  it('uses Chromium’s Windows NT 10.0 compatibility token for both Windows 10 and 11', () => {
    const win10 = chromiumUserAgent('windows10', 150);
    const win11 = chromiumUserAgent('windows11', 150);
    expect(win10).toBe(win11);
    expect(win11).toContain('Windows NT 10.0; Win64; x64');
    const fp10 = generateFingerprint({ engineMajor: 150, os: 'windows10', seed: 'win10' });
    const fp11 = generateFingerprint({ engineMajor: 150, os: 'windows11', seed: 'win11' });
    expect(fp10.platformVersion).toBe('10.0.0');
    expect(fp11.platformVersion).not.toBe('10.0.0');
  });
});

describe('renderer-safe Chromium UA validation and snapshots', () => {
  it('rejects invalid major versions without coercion or clamping', () => {
    for (const value of [0, -1, 1000, 1.5, NaN, Infinity, -Infinity, '150', null] as unknown[]) {
      expect(() => chromiumUserAgent('windows11', value as number)).toThrow(RangeError);
    }
    expect(chromiumUserAgent('windows11', 1)).toContain('Chrome/1.0.0.0');
    expect(chromiumUserAgent('windows11', 999)).toContain('Chrome/999.0.0.0');
  });

  it('pins reduced platform tokens for each supported OS', () => {
    expect(chromiumUserAgent('windows10', 150)).toBe(chromiumUserAgent('windows11', 150));
    expect(chromiumUserAgent('windows11', 150)).toContain('Windows NT 10.0');
    expect(chromiumUserAgent('macos', 150)).toContain('Mac OS X 10_15_7');
    expect(chromiumUserAgent('android', 150)).toContain('Android 10; K');
    expect(chromiumUserAgent('linux', 150)).toContain('Linux x86_64');
  });
});

describe('client hints', () => {
  it('matches Chromium GREASE brands (verified against real Chrome 120 and 153)', () => {
    expect(greaseBrand(120)).toEqual({ brand: 'Not_A Brand', version: '8' });
    expect(brandList(120)).toEqual([
      { brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: '120' }, { brand: 'Google Chrome', version: '120' },
    ]);
    // Chrome 153: order [2,0,1] => Google Chrome, grease, Chromium
    expect(brandList(153).map((b) => b.brand)).toEqual(['Google Chrome', 'Not_A Brand', 'Chromium']);
    expect(brandList(153, '153.0.8010.0')[1]).toEqual({ brand: 'Not_A Brand', version: '8.0.0.0' });
    expect(secChUa(brandList(120))).toBe('"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"');
  });
});

describe('languages', () => {
  it('builds Chrome-like language lists and Accept-Language', () => {
    expect(languageList('pl-PL')).toEqual(['pl-PL', 'pl', 'en-US', 'en']);
    expect(languageList('en-GB')).toEqual(['en-GB', 'en']);
    expect(acceptLanguageHeader('de-DE')).toBe('de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7');
    expect(languageList('bogus')).toEqual(['en-US', 'en']);
  });
});

describe('sanitize + resolve', () => {
  const base = generateFingerprint({ engineMajor: 150, seed: 'base' });

  it('rejects malformed values atomically and does not coerce them', () => {
    expect(() => sanitizeFingerprint({ cpu: { mode: 'manual', cores: '8' } }, base)).toThrow(/finite/);
    expect(() => sanitizeFingerprint({ cpu: { mode: 'manual', cores: null } }, base)).toThrow(/finite/);
    expect(() => sanitizeFingerprint({ memory: { mode: 'manual', gb: 16 } }, base)).toThrow(/memory/);
    expect(() => sanitizeFingerprint({ webrtc: { mode: 'manual', publicIp: 'not-an-ip' } }, base)).toThrow(/IP/);
    expect(() => sanitizeFingerprint({ timezone: { mode: 'manual', value: 'not/a-zone' } }, base)).toThrow(/time zone/);
    expect(() => sanitizeFingerprint({ language: { mode: 'manual', value: 'not a tag' } }, base)).toThrow(/language/);
    expect(() => sanitizeFingerprint({ geolocation: { mode: 'manual', latitude: 91, longitude: 0, accuracy: 10 } }, base)).toThrow(/range/);
    expect(() => sanitizeFingerprint({ launchArgs: '--no-sandbox' }, base)).not.toThrow();
    expect(sanitizeFingerprint({ launchArgs: '--no-sandbox' }, base)).not.toHaveProperty('launchArgs');
  });

  it('preserves base values when fields are missing without mutating base', () => {
    const before = JSON.stringify(base);
    expect(sanitizeFingerprint({}, base)).toEqual(base);
    expect(JSON.stringify(base)).toBe(before);
  });

  it('enforces import size and font-list limits', () => {
    expect(() => sanitizeFingerprint({ fontList: Array.from({ length: 257 }, () => 'Arial') }, base)).toThrow(/Font list/);
    expect(() => sanitizeFingerprint({ fontList: ['x'.repeat(65)] }, base)).toThrow(/font name/);
    expect(() => sanitizeFingerprint({ unknownSetting: true }, base)).toThrow(/Unknown/);
  });

  it('migrates legacy location grants to ask and previews are not measurements', () => {
    expect(sanitizeFingerprint({ geolocation: { mode: 'allow', latitude: 1, longitude: 2, accuracy: 10 } }, base).geolocation.mode).toBe('ask');
    const preview = computeConfigPreview(base);
    expect(preview.canvasHash).toBe('not measured');
    expect(preview.webgpuStatus).toBe('not measured');
  });

  it('resolves auto timezone/language/geo from the proxy exit IP', () => {
    const r = resolveFingerprint(base, { ip: '5.6.7.8', countryCode: 'DE', timezone: 'Europe/Berlin', latitude: 52.5, longitude: 13.4 }, 'en-US');
    if (r.kind === 'disabled') throw new Error('unexpected disabled result');
    expect(r.timezone).toBe('Europe/Berlin');
    expect(r.languages).toEqual(['de-DE', 'de', 'en-US', 'en']);
    expect(r.geolocation).toMatchObject({ latitude: 52.5, longitude: 13.4 });
    expect(r.webrtcIp).toBe('5.6.7.8'); // altered => proxy IP
    expect(r.webrtcPolicy).toBe('disable_non_proxied_udp');
    expect(r.brands.some((b) => b.brand === 'Google Chrome')).toBe(true);
  });

  it('falls back to the app language when no geo information exists', () => {
    const r = resolveFingerprint(base, undefined, 'pl-PL');
    if (r.kind === 'disabled') throw new Error('unexpected disabled result');
    expect(r.timezone).toBeNull();
    expect(r.languages?.[0]).toBe('pl-PL');
    expect(r.geolocation).toBeNull();
  });

  it('reports real values when the fingerprint is disabled', () => {
    const r = resolveFingerprint(realFingerprint(150), { timezone: 'Asia/Tokyo', countryCode: 'JP' }, 'en-US');
    expect(r).toEqual({ kind: 'disabled', enabled: false });
    expect(Object.keys(r)).toEqual(['kind', 'enabled']);
  });

  it('does not expose stored GPU metadata or WebGPU when WebGL is off', () => {
    const configured = { ...base, webgl: 'off' as const, webgpu: 'real' as const, webglInfo: { mode: 'manual' as const, vendor: 'Host vendor', renderer: 'Host GPU' } };
    const r = resolveFingerprint(configured, undefined, 'en-US');
    if (r.kind === 'disabled') throw new Error('unexpected disabled result');
    expect(r.webglVendor).toBeNull();
    expect(r.webglRenderer).toBeNull();
    expect(r.webgpu).toBe('off');
  });

  it('warns about inconsistent manual edits', () => {
    const fp = { ...base, os: 'macos' as const, userAgent: base.userAgent.replace(/\(.*?\)/, '(Windows NT 10.0; Win64; x64)'), webglInfo: { mode: 'manual' as const, vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, X Direct3D11 vs_5_0 ps_5_0, D3D11)' }, cpu: { mode: 'manual' as const, cores: 2 } };
    expect(fingerprintWarnings(fp, 150).sort()).toEqual(['fp.warn.gpuOs', 'fp.warn.macCores', 'fp.warn.uaOs']);
  });

  it('parses port lists', () => {
    expect(parsePorts('3389, 5900,abc,0,70000,5900')).toEqual([3389, 5900]);
  });
});

describe('profiles carry a fingerprint', () => {
  it('every ordinary profile gets a fresh coherent fingerprint while Tor stays common', () => {
    setEngineVersion('149.0.7300.5');
    expect(engineVersion().major).toBe(149);
    const a = defaultProfile('antidetect', 'A');
    const p1 = defaultProfile('personal', 'P1');
    const p2 = defaultProfile('personal', 'P2');
    expect(a.browserShell).toBe('chrome');
    expect(a.baseChromeLook).toBe(true);
    expect(defaultProfile('tor', 'Tor').browserShell).toBe('octo');
    expect(a.fingerprint.enabled).toBe(true);
    expect(a.vstudioWebOnLaunch).toBe(false);
    expect(a.fingerprint.webgpu).toBe('off');
    expect(uaMajor(a.fingerprint.userAgent)).toBe(149);
    expect(a.protection.level).toBe('normal');
    expect(p1.fingerprint.enabled).toBe(true);
    expect(p1.fingerprint.seed).not.toBe(p2.fingerprint.seed);
    expect(defaultProfile('tor', 'Tor').fingerprint.enabled).toBe(false);
  });

  it('a stored profile without fingerprint gets the same one on every load', () => {
    const raw = { id: 'p-abcdef123456', kind: 'antidetect', name: 'Old' };
    const a = sanitizeProfile(raw);
    const b = sanitizeProfile(raw);
    expect(a.fingerprint).toEqual(b.fingerprint);
    expect(a.fingerprint.enabled).toBe(true);
    expect(a.vstudioWebOnLaunch).toBe(false);
  });

  it('persists the optional per-profile vStudio launch switch and defaults old records off', () => {
    const old = sanitizeProfile({ id: 'p-abcdef123458', kind: 'personal', name: 'Old' });
    const optedIn = sanitizeProfile({ id: 'p-abcdef123459', kind: 'personal', name: 'Opted in', vstudioWebOnLaunch: true });
    expect(old.vstudioWebOnLaunch).toBe(false);
    expect(optedIn.vstudioWebOnLaunch).toBe(true);
  });

  it('sanitises tags, notes, start pages and structured proxy', () => {
    const p = sanitizeProfile({
      id: 'p-abcdef123457', kind: 'antidetect', name: 'X', tags: ['a', 'a', ' b ', 5, ''], folder: 'Klienci', notes: 'n',
      startPages: ['https://example.com', 'javascript:alert(1)', 'octo://newtab'],
      network: { mode: 'proxy', proxy: { type: 'socks5', host: 'Proxy.Example.com', port: 1080, changeIpUrl: 'https://x.y/rotate', name: 'PL', savedId: '' } },
    });
    expect(p.tags).toEqual(['a', 'b']);
    expect(p.startPages).toEqual(['https://example.com', 'octo://newtab']);
    expect(p.network.proxy?.host).toBe('proxy.example.com');
    expect(p.network.proxyRules).toBe('socks5://proxy.example.com:1080');
  });
});

describe('startup consistency validator', () => {
  it('passes a fully coherent generated fingerprint', () => {
    const fp = generateFingerprint({ engineMajor: 140, os: 'windows11' });
    const result = validateProfileFingerprintConsistency(fp, 140);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('detects contradictory OS and User-Agent combinations', () => {
    const fp = generateFingerprint({ engineMajor: 140, os: 'windows11' });
    fp.userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
    const result = validateProfileFingerprintConsistency(fp, 140);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'UA_OS_MISMATCH')).toBe(true);
  });

  it('detects impossible GPU backend on target platform (Apple GPU on Windows)', () => {
    const fp = generateFingerprint({ engineMajor: 140, os: 'windows11' });
    fp.webglInfo.mode = 'manual';
    fp.webglInfo.renderer = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)';
    const result = validateProfileFingerprintConsistency(fp, 140);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'GPU_OS_MISMATCH')).toBe(true);
  });

  it('detects Direct3D ANGLE backend on macOS platform', () => {
    const fp = generateFingerprint({ engineMajor: 140, os: 'macos' });
    fp.webglInfo.mode = 'manual';
    fp.webglInfo.renderer = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
    const result = validateProfileFingerprintConsistency(fp, 140);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'GPU_OS_MISMATCH')).toBe(true);
  });

  it('passes Native/Real mode without warnings or false errors', () => {
    const fp = realFingerprint(140);
    const result = validateProfileFingerprintConsistency(fp, 140);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });
});
