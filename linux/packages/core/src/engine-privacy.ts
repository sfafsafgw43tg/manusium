export type ChromiumWebRtcMode = 'default' | 'disable-non-proxied-udp';
export type FirefoxWebRtcMode = 'default' | 'disabled';
export type LocationMode = 'ask' | 'block';

export interface EnginePrivacySettings {
  chromium: { webRtc: ChromiumWebRtcMode; location: LocationMode };
  firefox: { webRtc: FirefoxWebRtcMode; location: LocationMode; resistFingerprinting: boolean };
}

export const DEFAULT_ENGINE_PRIVACY: EnginePrivacySettings = {
  chromium: { webRtc: 'default', location: 'ask' },
  firefox: { webRtc: 'default', location: 'ask', resistFingerprinting: false },
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function sanitizeEnginePrivacy(value: unknown): EnginePrivacySettings {
  const root = object(value);
  const chromium = object(root.chromium);
  const firefox = object(root.firefox);
  return {
    chromium: { webRtc: chromium.webRtc === 'disable-non-proxied-udp' ? 'disable-non-proxied-udp' : 'default', location: chromium.location === 'block' ? 'block' : 'ask' },
    firefox: { webRtc: firefox.webRtc === 'disabled' ? 'disabled' : 'default', location: firefox.location === 'block' ? 'block' : 'ask', resistFingerprinting: firefox.resistFingerprinting === true },
  };
}
