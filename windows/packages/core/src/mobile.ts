/**
 * packages/core/src/mobile.ts - validated handset presets for profile device emulation.
 * This module is browser-safe: the launcher can use the same device list as the
 * Electron main process without bundling Node-only profile storage code.
 */

/** A real handset viewport/identity applied to every tab in the profile. */
export const MOBILE_DEVICES = [
  { id: 'iphone-15', name: 'iPhone 15', os: 'ios', width: 393, height: 852, scaleFactor: 3, model: 'iPhone' },
  { id: 'iphone-se', name: 'iPhone SE', os: 'ios', width: 375, height: 667, scaleFactor: 2, model: 'iPhone' },
  { id: 'ipad-air', name: 'iPad Air', os: 'ios', width: 820, height: 1180, scaleFactor: 2, model: 'iPad' },
  { id: 'pixel-8', name: 'Google Pixel 8', os: 'android', width: 412, height: 915, scaleFactor: 2.625, model: 'Pixel 8' },
  { id: 'galaxy-s24', name: 'Samsung Galaxy S24', os: 'android', width: 360, height: 780, scaleFactor: 3, model: 'SM-S921B' },
] as const;
export type MobileDeviceId = (typeof MOBILE_DEVICES)[number]['id'];
export type MobileOrientation = 'portrait' | 'landscape';
export const ANDROID_VERSIONS = ['15', '14', '13', '12'] as const;
export const IOS_VERSIONS = ['18.0', '17.5', '16.7'] as const;
export type AndroidVersion = (typeof ANDROID_VERSIONS)[number];
export type IosVersion = (typeof IOS_VERSIONS)[number];

export interface MobileEmulationConfig {
  /** none keeps the normal desktop browser; the other values select a handset/tablet. */
  device: 'none' | MobileDeviceId;
  orientation: MobileOrientation;
  /** Optional so profiles created before version picking retain their existing identity. */
  osVersion?: AndroidVersion | IosVersion;
}

/** Runtime-ready phone identity, including a consistent viewport and mobile UA. */
export interface MobileEmulation extends Omit<MobileEmulationConfig, 'device'> {
  id: MobileDeviceId;
  name: string;
  os: 'ios' | 'android';
  width: number;
  height: number;
  scaleFactor: number;
  model: string;
  userAgent: string;
  platform: string;
  chPlatform: string;
}

/** Resolve a stored device choice into the viewport, touch and user-agent identity used at runtime. */
export function mobileEmulationFor(config: MobileEmulationConfig | undefined, chromeVersion: string): MobileEmulation | null {
  if (!config || config.device === 'none') return null;
  const device = MOBILE_DEVICES.find((x) => x.id === config.device);
  if (!device) return null;
  const landscape = config.orientation === 'landscape';
  const width = landscape ? device.height : device.width;
  const height = landscape ? device.width : device.height;
  if (device.os === 'ios') {
    const iphone = device.model === 'iPhone';
    const version = IOS_VERSIONS.includes(config.osVersion as IosVersion) ? config.osVersion as IosVersion : '17.5';
    const uaVersion = version.replace('.', '_');
    return {
      ...device, width, height, orientation: config.orientation, osVersion: version,
      userAgent: iphone
        ? `Mozilla/5.0 (iPhone; CPU iPhone OS ${uaVersion} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Mobile/15E148 Safari/604.1`
        : `Mozilla/5.0 (iPad; CPU OS ${uaVersion} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Mobile/15E148 Safari/604.1`,
      platform: iphone ? 'iPhone' : 'iPad', chPlatform: 'iOS',
    };
  }
  const version = ANDROID_VERSIONS.includes(config.osVersion as AndroidVersion) ? config.osVersion as AndroidVersion : '14';
  return {
    ...device, width, height, orientation: config.orientation, osVersion: version,
    userAgent: `Mozilla/5.0 (Linux; Android ${version}; ${device.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Mobile Safari/537.36`,
    platform: 'Linux armv8l', chPlatform: 'Android',
  };
}
