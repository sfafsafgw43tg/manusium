import type { FingerprintConfig, MobileEmulation, Profile, ResolvedFingerprint } from '@octo/core';
import type { FingerprintAuditReport, FingerprintAuditRow, FingerprintAuditStatus } from '../shared/fingerprint-audit-types';
import type { FingerprintProbeSnapshot } from './fingerprint-probe';

const text = (value: unknown, fallback = '—'): string => {
  const s = String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim();
  return s ? s.slice(0, 1200) : fallback;
};
const exact = (a: unknown, b: unknown): boolean => String(a ?? '').trim() === String(b ?? '').trim();
const pair = (width: number | null | undefined, height: number | null | undefined): string =>
  Number.isFinite(width) && Number.isFinite(height) ? `${width} × ${height}` : '';
const list = (values: string[] | null | undefined): string => values?.length ? values.join(', ') : '';
const brands = (values: Array<{ brand: string; version: string }> | null | undefined): string =>
  values?.length ? values.map((item) => `${item.brand} ${item.version}`).join(', ') : '';
const sameBrands = (a: Array<{ brand: string; version: string }> | null | undefined,
  b: Array<{ brand: string; version: string }> | null | undefined): boolean => exact(brands(a), brands(b));

export function buildFingerprintAuditReport(input: {
  profile: Pick<Profile, 'id' | 'name' | 'fingerprint'>;
  configured: FingerprintConfig;
  applied: ResolvedFingerprint;
  mobile: MobileEmulation | null;
  observed: FingerprintProbeSnapshot;
}): FingerprintAuditReport {
  const { profile, configured, applied, mobile, observed } = input;
  if (applied.kind === 'disabled') {
    return { profileId: profile.id, profileName: profile.name, capturedAt: new Date().toISOString(), summary: 'incomplete', rows: [], limitations: ['Fingerprinting is disabled; no override values were resolved or applied.'], errors: [] };
  }
  const rows: FingerprintAuditRow[] = [];
  const add = (
    key: string,
    configuredValue: unknown,
    appliedValue: unknown,
    observedValue: unknown,
    status: FingerprintAuditStatus,
    noteKey?: string,
  ) => rows.push({
    key,
    labelKey: `fp.audit.row.${key}`,
    configured: text(configuredValue),
    applied: text(appliedValue),
    received: text(observedValue),
    status,
    ...(noteKey ? { noteKey } : {}),
  });
  const compare = (key: string, configuredValue: unknown, appliedValue: unknown, observedValue: unknown, expected?: unknown) => {
    const wanted = expected === undefined ? appliedValue : expected;
    const status: FingerprintAuditStatus = !String(wanted ?? '').trim() || wanted === 'Host/system'
      ? 'not-configured'
      : observedValue === null || observedValue === undefined || observedValue === ''
        ? 'unavailable'
        : exact(wanted, observedValue) ? 'match' : 'mismatch';
    add(key, configuredValue, appliedValue, observedValue, status);
  };

  // When overrides are disabled, the saved profile values are not the values
  // the page should receive. Mobile emulation remains active independently.
  // Only an explicitly resolved/applied runtime object can make identity rows
  // active. Normal profile runtime passes enabled:false, so legacy metadata is
  // reported as requested-only and never as applied state.
  const identityOverridesActive = applied.enabled && !applied.identityUnsupported;
  const configuredUa = mobile?.userAgent ?? configured.userAgent;
  const appliedUa = mobile?.userAgent ?? (identityOverridesActive ? applied.userAgent : 'Host/system');
  const configuredPlatform = mobile ? `${mobile.name} (${mobile.platform})` : configured.os;
  const appliedPlatform = mobile?.platform ?? (identityOverridesActive ? applied.platform : 'Host/system');
  const configuredChPlatform = mobile ? `${mobile.name} (${mobile.chPlatform})` : configured.os;
  const appliedChPlatform = mobile?.chPlatform ?? (identityOverridesActive ? applied.chPlatform : 'Host/system');
  const appliedLanguages = identityOverridesActive ? list(applied.languages) : '';
  const configuredLanguage = configured.language.mode === 'real' ? 'Host/system' : configured.language.mode === 'manual'
    ? configured.language.value || 'Not set' : `Auto (${configured.language.value || 'exit locale'})`;
  const configuredTimezone = configured.timezone.mode === 'real' ? 'Host/system' : configured.timezone.mode === 'manual'
    ? configured.timezone.value || 'Not set' : 'Auto (exit IP)';
  compare('userAgent', configuredUa, appliedUa, observed.userAgent);
  compare('platform', configuredPlatform, appliedPlatform, observed.platform);
  compare('uaPlatform', configuredChPlatform, appliedChPlatform, observed.uaDataPlatform);
  compare('language', configuredLanguage, appliedLanguages || 'Host/system', list(observed.languages) || observed.language,
    appliedLanguages || 'Host/system');
  compare('timezone', configuredTimezone, applied.timezone ?? 'Host/system', observed.timezone, applied.timezone ?? 'Host/system');

  const cpuConfigured = configured.cpu.mode === 'manual' ? `${configured.cpu.cores} cores` : 'Host/system';
  const cpuApplied = applied.cores ? `${applied.cores} cores` : 'Host/system';
  compare('cpu', cpuConfigured, cpuApplied, observed.hardwareConcurrency === null ? '' : `${observed.hardwareConcurrency} cores`, cpuApplied);
  const memoryConfigured = configured.memory.mode === 'manual' ? `${configured.memory.gb} GB` : 'Host/system';
  const memoryApplied = applied.memory ? `${applied.memory} GB` : 'Host/system';
  compare('memory', memoryConfigured, memoryApplied, observed.deviceMemory === null ? '' : `${observed.deviceMemory} GB`, memoryApplied);

  const expectedScreen = mobile
    ? { width: mobile.width, height: mobile.height }
    : applied.screen;
  const screenConfigured = mobile
    ? `${mobile.name} · ${pair(mobile.width, mobile.height)} · ${mobile.orientation}`
    : configured.screen.mode === 'manual' ? pair(configured.screen.width, configured.screen.height) : 'Host/system';
  const screenApplied = expectedScreen ? pair(expectedScreen.width, expectedScreen.height) : 'Host/system';
  const screenReceived = pair(observed.screen.width, observed.screen.height);
  compare('screen', screenConfigured, screenApplied, screenReceived, screenApplied);
  add('screenDetails', screenConfigured,
    expectedScreen ? `${screenApplied}; dpr ${mobile?.scaleFactor ?? 1}` : 'Host/system',
    `${screenReceived || 'unavailable'}; available ${pair(observed.screen.availWidth, observed.screen.availHeight)}; dpr ${observed.screen.pixelRatio ?? 'unavailable'}`,
    'observed', 'fp.audit.note.viewport');

  const glExpectedVendor = applied.webglVendor;
  const glExpectedRenderer = applied.webglRenderer;
  const webglReadBack = observed.webgl.available
    ? `standard ${observed.webgl.standardVendor || '—'} · ${observed.webgl.standardRenderer || '—'}; ${observed.webgl.debugInfo
      ? `debug ${observed.webgl.unmaskedVendor || '—'} · ${observed.webgl.unmaskedRenderer || '—'}`
      : 'unmasked values unavailable (debug extension absent)'}`
    : 'No WebGL context';
  if (applied.webgl === 'off') {
    const disabled = !observed.webgl.available;
    add('webgl', 'Off', 'WebGL context blocked', webglReadBack, disabled ? 'match' : 'mismatch');
  } else if (glExpectedVendor || glExpectedRenderer) {
    const expected = [glExpectedVendor, glExpectedRenderer].filter(Boolean).join(' · ');
    const vendorMatches = !glExpectedVendor || exact(glExpectedVendor, observed.webgl.unmaskedVendor);
    const rendererMatches = !glExpectedRenderer || exact(glExpectedRenderer, observed.webgl.unmaskedRenderer);
    const status: FingerprintAuditStatus = !observed.webgl.available ? 'unavailable'
      : !observed.webgl.debugInfo ? 'observed'
        : vendorMatches && rendererMatches ? 'match' : 'mismatch';
    add('webgl', configured.webglInfo.mode === 'manual' ? `${configured.webglInfo.vendor} · ${configured.webglInfo.renderer}` : 'Host GPU',
      expected || 'Host GPU', webglReadBack, status,
      observed.webgl.debugInfo ? undefined : 'fp.audit.note.webglMasked');
  } else {
    add('webgl', configured.webglInfo.mode === 'manual' ? `${configured.webglInfo.vendor} · ${configured.webglInfo.renderer}` : 'Host GPU',
      'Host GPU / no manual renderer configured', webglReadBack,
      observed.webgl.available ? 'observed' : 'unavailable');
  }

  const webgpuReceived = observed.webgpuAvailable ? 'Available' : applied.webgpu === 'off' ? 'Blocked' : 'Unavailable';
  const webgpuStatus: FingerprintAuditStatus = applied.webgpu === 'off'
    ? observed.webgpuAvailable ? 'mismatch' : 'match'
    : observed.webgpuAvailable ? 'observed' : 'unavailable';
  add('webgpu', configured.webgpu, applied.webgpu, webgpuReceived, webgpuStatus,
    applied.webgpu === 'real' ? 'fp.audit.note.webgpuExposed' : undefined);

  const canvasStatus: FingerprintAuditStatus = applied.canvas === 'off'
    ? observed.canvas.blankReadback ? 'match' : 'mismatch'
    : observed.canvas.hash ? 'observed' : 'unavailable';
  add('canvas', configured.canvas, applied.canvas, `${observed.canvas.hash ? `hash ${observed.canvas.hash}` : 'unavailable'}${observed.canvas.blankReadback ? ' · blank read-back' : ''}`,
    canvasStatus, configured.canvas === 'noise' ? 'fp.audit.note.canvasNoise' : undefined);
  add('audio', configured.audio, applied.audio, observed.audioHash ? `hash ${observed.audioHash}` : 'Unavailable',
    observed.audioHash ? 'observed' : 'unavailable', 'fp.audit.note.audio');
  add('clientRects', configured.clientRects, applied.clientRects, observed.rectsHash ? `probe ${observed.rectsHash}` : 'Unavailable',
    observed.rectsHash ? 'observed' : 'unavailable', 'fp.audit.note.rects');
  add('fonts', configured.fonts, applied.fonts,
    `${observed.fonts.availableCount}/${observed.fonts.testedCount} candidates detected`, 'observed', 'fp.audit.note.fonts');

  const expectedMedia = applied.mediaDevices;
  const configuredMedia = configured.mediaDevices.mode === 'manual'
    ? `${configured.mediaDevices.audioInputs} audio in / ${configured.mediaDevices.audioOutputs} audio out / ${configured.mediaDevices.videoInputs} video in`
    : 'Host/system';
  const appliedMedia = expectedMedia
    ? `${expectedMedia.audioInputs} audio in / ${expectedMedia.audioOutputs} audio out / ${expectedMedia.videoInputs} video in`
    : 'Host/system';
  const observedMedia = `${observed.mediaDevices.audioInputs} audio in / ${observed.mediaDevices.audioOutputs} audio out / ${observed.mediaDevices.videoInputs} video in`;
  const mediaStatus: FingerprintAuditStatus = expectedMedia
    ? observed.mediaDevices.audioInputs === expectedMedia.audioInputs
      && observed.mediaDevices.audioOutputs === expectedMedia.audioOutputs
      && observed.mediaDevices.videoInputs === expectedMedia.videoInputs ? 'match' : 'mismatch'
    : 'observed';
  add('mediaDevices', configuredMedia, appliedMedia, `${observedMedia}; ${observed.mediaDevices.labelsVisible} labels visible`, mediaStatus,
    configured.mediaDevices.mode === 'manual' ? 'fp.audit.note.mediaCounts' : undefined);

  const webrtcConfigured = configured.webrtc.mode;
  const webrtcApplied = `${applied.webrtcMode} · ${applied.webrtcPolicy.replaceAll('_', ' ')}`;
  const webrtcReceived = observed.webrtc.available
    ? `RTCPeerConnection available; ${observed.webrtc.hostCandidates} host / ${observed.webrtc.serverReflexiveCandidates} server-reflexive / ${observed.webrtc.relayCandidates} relay candidates; addresses redacted`
    : 'API unavailable';
  // The API may exist even when a WebRTC policy is configured. This probe has
  // no STUN/TURN server, so candidate counts are observational, not proof that
  // the network policy or public-IP routing matches.
  const webrtcStatus: FingerprintAuditStatus = observed.webrtc.available ? 'observed' : 'unavailable';
  add('webrtc', webrtcConfigured, webrtcApplied, webrtcReceived, webrtcStatus, 'fp.audit.note.webrtc');

  add('geolocation', `${configured.geolocation.mode}${configured.geolocation.mode === 'manual' ? ` · ${configured.geolocation.latitude}, ${configured.geolocation.longitude}` : ''}`,
    applied.geolocation ? `${applied.geolocation.latitude}, ${applied.geolocation.longitude} ±${applied.geolocation.accuracy}m` : applied.geoBlocked ? 'Blocked by configuration' : 'Host / permission-gated',
    `permission: ${observed.geolocationPermission}; coordinates not requested`, 'observed', 'fp.audit.note.geolocation');
  const expectedArchitecture = mobile ? 'arm' : applied.architecture;
  const expectedModel = mobile?.model ?? '';
  const configuredUaHints = mobile
    ? `${mobile.name} · ${mobile.chPlatform} ${mobile.osVersion}`
    : `${configured.os} · ${configured.platformVersion}`;
  const appliedUaHints = identityOverridesActive
    ? `${appliedChPlatform} ${applied.platformVersion} ${expectedArchitecture}; model ${expectedModel || '—'}`
    : 'Host/system';
  const receivedUaHints = `${observed.uaDataPlatform || 'unavailable'} ${observed.uaDataPlatformVersion || 'unavailable'} ${observed.uaDataArchitecture || 'unavailable'}; model ${observed.uaDataModel || '—'}`;
  const uaHintsStatus: FingerprintAuditStatus = !identityOverridesActive ? 'not-configured'
    : !observed.uaDataPlatform || !observed.uaDataPlatformVersion || !observed.uaDataArchitecture ? 'unavailable'
      : exact(appliedChPlatform, observed.uaDataPlatform)
        && exact(applied.platformVersion, observed.uaDataPlatformVersion)
        && exact(expectedArchitecture, observed.uaDataArchitecture)
        && exact(expectedModel, observed.uaDataModel) ? 'match' : 'mismatch';
  add('uaHints', configuredUaHints, appliedUaHints, receivedUaHints, uaHintsStatus);

  const browserIdentity = configured.browserIdentity ?? 'chrome';
  const identityUnsupported = applied.identityUnsupported === true || browserIdentity === 'firefox' || browserIdentity === 'firefox-esr';
  add('browserIdentity', browserIdentity, identityUnsupported ? 'unsupported' : browserIdentity,
    identityUnsupported ? 'unsupported' : browserIdentity, identityUnsupported ? 'unsupported' : 'observed',
    identityUnsupported ? 'fp.audit.note.identityUnsupported' : undefined);

  const configuredUaMajor = /Chrome\/(\d+)\./.exec(configured.userAgent)?.[1] || configured.uaFullVersion.split('.')[0];
  const uaBrandsStatus: FingerprintAuditStatus = !identityOverridesActive ? 'not-configured'
    : !observed.uaDataBrands.length ? 'unavailable'
      : sameBrands(applied.brands, observed.uaDataBrands) ? 'match' : 'mismatch';
  add('uaBrands', `Chrome ${configuredUaMajor}`, identityOverridesActive ? brands(applied.brands) : 'Host/system',
    brands(observed.uaDataBrands) || 'Unavailable', uaBrandsStatus);

  const uaFullVersionStatus: FingerprintAuditStatus = !identityOverridesActive ? 'not-configured'
    : !observed.uaDataFullVersionList.length ? 'unavailable'
      : sameBrands(applied.fullVersionList, observed.uaDataFullVersionList) ? 'match' : 'mismatch';
  add('uaFullVersionList', configured.uaFullVersion, identityOverridesActive ? brands(applied.fullVersionList) : 'Host/system',
    brands(observed.uaDataFullVersionList) || 'Unavailable', uaFullVersionStatus);

  const mismatchCount = rows.filter((row) => row.status === 'mismatch').length;
  const incomplete = rows.some((row) => row.status === 'unavailable') || observed.errors.length > 0;
  const limitations = [
    'fp.audit.limitation.pageProbe',
    'fp.audit.limitation.externalSites',
    'fp.audit.limitation.gpuFonts',
    'fp.audit.limitation.network',
    'fp.audit.limitation.noGuarantee',
    ...(mobile?.os === 'ios' ? ['fp.audit.limitation.iosChromium'] : []),
  ];
  return {
    profileId: profile.id,
    profileName: profile.name,
    capturedAt: new Date().toISOString(),
    summary: mismatchCount ? 'mismatches' : incomplete ? 'incomplete' : 'no-mismatch',
    rows,
    limitations,
    errors: observed.errors,
  };
}
