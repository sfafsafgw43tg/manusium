import { describe, expect, it } from 'vitest';
import { generateFingerprint, resolveFingerprint } from '@octo/core';
import type { FingerprintConfig } from '@octo/core';
import { buildFingerprintAuditReport } from '../src/main/fingerprint-audit';
import { FINGERPRINT_PROBE_SCRIPT } from '../src/main/fingerprint-probe';
import type { FingerprintProbeSnapshot } from '../src/main/fingerprint-probe';

type ProbeOverrides = Omit<Partial<FingerprintProbeSnapshot>, 'screen' | 'webgl' | 'canvas' | 'fonts' | 'mediaDevices' | 'webrtc'> & {
  screen?: Partial<FingerprintProbeSnapshot['screen']>;
  webgl?: Partial<FingerprintProbeSnapshot['webgl']>;
  canvas?: Partial<FingerprintProbeSnapshot['canvas']>;
  fonts?: Partial<FingerprintProbeSnapshot['fonts']>;
  mediaDevices?: Partial<FingerprintProbeSnapshot['mediaDevices']>;
  webrtc?: Partial<FingerprintProbeSnapshot['webrtc']>;
};

type FixtureOptions = {
  observedUserAgent?: string;
  enabled?: boolean;
  webrtcMode?: FingerprintConfig['webrtc']['mode'];
  webgpu?: FingerprintConfig['webgpu'];
  canvas?: FingerprintConfig['canvas'];
  webgl?: FingerprintConfig['webgl'];
  observed?: ProbeOverrides;
};

function fixture(options: FixtureOptions = {}) {
  const configured = generateFingerprint({ engineMajor: 150, os: 'windows11', seed: 'audit-seed' });
  if (options.enabled !== undefined) configured.enabled = options.enabled;
  if (options.webrtcMode) configured.webrtc.mode = options.webrtcMode;
  if (options.webgpu) configured.webgpu = options.webgpu;
  if (options.canvas) configured.canvas = options.canvas;
  if (options.webgl) configured.webgl = options.webgl;
  const applied = resolveFingerprint(configured, undefined, 'en-US');
  const values = applied.kind === 'disabled'
    ? resolveFingerprint({ ...configured, enabled: true }, undefined, 'en-US')
    : applied;
  if (values.kind === 'disabled') throw new Error('fixture unexpectedly disabled');
  const media = values.mediaDevices!;
  const screen = values.screen!;
  const baseObserved: FingerprintProbeSnapshot = {
    userAgent: values.userAgent,
    platform: values.platform,
    language: values.languages?.[0] ?? 'en-US',
    languages: values.languages ?? ['en-US', 'en'],
    uaDataPlatform: values.chPlatform,
    uaDataPlatformVersion: values.platformVersion,
    uaDataArchitecture: values.architecture,
    uaDataModel: '',
    uaDataBrands: values.brands,
    uaDataFullVersionList: values.fullVersionList,
    timezone: 'Europe/Warsaw',
    hardwareConcurrency: values.cores,
    deviceMemory: values.memory,
    screen: { ...screen, colorDepth: 24, pixelRatio: 1 },
    webgl: {
      available: true, debugInfo: true, vendor: values.webglVendor!, renderer: values.webglRenderer!,
      standardVendor: 'WebKit', standardRenderer: 'WebKit WebGL',
      unmaskedVendor: values.webglVendor!, unmaskedRenderer: values.webglRenderer!,
    },
    webgpuAvailable: false,
    canvas: { hash: '4f6a12bc', blankReadback: false },
    audioHash: '7a3fc921',
    rectsHash: 'b8123aa1',
    fonts: { availableCount: 7, testedCount: 13 },
    mediaDevices: { ...media, labelsVisible: 0 },
    geolocationPermission: 'prompt',
    webrtc: { available: true, hostCandidates: 0, serverReflexiveCandidates: 0, relayCandidates: 0 },
    errors: [],
  };
  const overrides = options.observed ?? {};
  const observed: FingerprintProbeSnapshot = {
    ...baseObserved,
    ...overrides,
    userAgent: options.observedUserAgent ?? overrides.userAgent ?? baseObserved.userAgent,
    screen: { ...baseObserved.screen, ...(overrides.screen ?? {}) },
    webgl: { ...baseObserved.webgl, ...(overrides.webgl ?? {}) },
    canvas: { ...baseObserved.canvas, ...(overrides.canvas ?? {}) },
    fonts: { ...baseObserved.fonts, ...(overrides.fonts ?? {}) },
    mediaDevices: { ...baseObserved.mediaDevices, ...(overrides.mediaDevices ?? {}) },
    webrtc: { ...baseObserved.webrtc, ...(overrides.webrtc ?? {}) },
  };
  return buildFingerprintAuditReport({
    profile: { id: 'p-audit123456', name: 'Audit test', fingerprint: configured },
    configured,
    applied,
    mobile: null,
    observed,
  });
}

describe('page-visible fingerprint audit report', () => {
  it('builds valid page probe JavaScript and recognizes ordinary ICE candidate types', () => {
    expect(() => new Function(FINGERPRINT_PROBE_SCRIPT)).not.toThrow();
    const match = FINGERPRINT_PROBE_SCRIPT.match(/const type = (\/[^;]+?\/i)\.exec\(candidate\)/);
    expect(match?.[1]).toBeTruthy();
    const candidateType = new Function(`return ${match![1]}`)() as RegExp;
    expect(candidateType.exec('candidate:1 1 UDP 2122260223 192.0.2.5 54400 typ srflx raddr 10.0.0.1 rport 54400')?.[1]).toBe('srflx');
  });

  it('compares configured, applied and observed values without claiming protection', () => {
    const report = fixture();
    expect(report.summary).toBe('no-mismatch');
    expect(report.rows.find((row) => row.key === 'userAgent')).toMatchObject({ status: 'match' });
    expect(report.rows.find((row) => row.key === 'uaHints')).toMatchObject({ status: 'match' });
    expect(report.rows.find((row) => row.key === 'uaBrands')).toMatchObject({ status: 'match' });
    expect(report.rows.find((row) => row.key === 'uaFullVersionList')).toMatchObject({ status: 'match' });
    expect(report.rows.find((row) => row.key === 'webgpu')).toMatchObject({ status: 'match', applied: 'off', received: 'Blocked' });
    expect(report.rows.find((row) => row.key === 'canvas')).toMatchObject({ status: 'observed' });
    expect(report.rows.find((row) => row.key === 'webrtc')).toMatchObject({ status: 'observed' });
    expect(report.rows.find((row) => row.key === 'fonts')?.noteKey).toBe('fp.audit.note.fonts');
    expect(report.limitations).toContain('fp.audit.limitation.noGuarantee');
    expect(report).not.toHaveProperty('protected');
  });

  it('separates standard and debug WebGL values and avoids false mismatches without the debug extension', () => {
    const mismatch = fixture({ observed: { webgl: { unmaskedRenderer: 'Different GPU' } } });
    const mismatchRow = mismatch.rows.find((row) => row.key === 'webgl');
    expect(mismatchRow?.status).toBe('mismatch');
    expect(mismatchRow?.received).toContain('standard WebKit · WebKit WebGL');
    expect(mismatchRow?.received).toContain('debug');

    const unavailable = fixture({ observed: { webgl: { debugInfo: false, unmaskedVendor: '', unmaskedRenderer: '' } } });
    expect(unavailable.rows.find((row) => row.key === 'webgl')).toMatchObject({ status: 'observed', noteKey: 'fp.audit.note.webglMasked' });
  });

  it('marks page read-back mismatches, including case and high-entropy UA hints', () => {
    const report = fixture({ observedUserAgent: 'mozilla/5.0 (windows nt 10.0; win64; x64) applewebkit/537.36 chrome/150.0.0.0 safari/537.36' });
    expect(report.summary).toBe('mismatches');
    expect(report.rows.find((row) => row.key === 'userAgent')?.status).toBe('mismatch');

    const hints = fixture({ observed: { uaDataArchitecture: 'arm' } });
    expect(hints.rows.find((row) => row.key === 'uaHints')?.status).toBe('mismatch');

    const brandsMismatch = fixture({ observed: { uaDataBrands: [{ brand: 'Chromium', version: '149' }] } });
    expect(brandsMismatch.rows.find((row) => row.key === 'uaBrands')?.status).toBe('mismatch');
  });

  it('does not call disabled overrides or available WebRTC APIs a mismatch', () => {
    const report = fixture({ enabled: false, webrtcMode: 'off', webgl: 'off', canvas: 'off' });
    expect(report.rows).toEqual([]);
    expect(report.limitations).toContain('Fingerprinting is disabled; no override values were resolved or applied.');
    expect(report.summary).toBe('incomplete');
  });

  it('treats unavailable native WebGPU as unavailable rather than a mismatch in real mode', () => {
    const report = fixture({ webgpu: 'real', observed: { webgpuAvailable: false } });
    expect(report.rows.find((row) => row.key === 'webgpu')?.status).toBe('unavailable');
  });
});
