import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EnginePrivacySettings } from '@octo/core/engine-privacy';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
function writeJsonMerge(file: string, patch: Record<string, unknown>): void {
  let current: Record<string, unknown> = {};
  try { current = object(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* first launch or incomplete profile */ }
  const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...a };
    for (const [key, value] of Object.entries(b)) out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(object(out[key]), object(value)) : value;
    return out;
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(merge(current, patch)), { mode: 0o600 });
}
/** Apply only Chromium preferences supported by the native runtime. */
export function prepareChromiumPrivacy(profileDir: string, settings: EnginePrivacySettings['chromium']): void {
  const prefs: Record<string, unknown> = {};
  prefs.profile = { default_content_setting_values: { geolocation: settings.location === 'block' ? 2 : 0 } };
  prefs.webrtc = { ip_handling_policy: settings.webRtc === 'disable-non-proxied-udp' ? 'disable_non_proxied_udp' : 'default' };
  if (Object.keys(prefs).length) writeJsonMerge(path.join(profileDir, 'Preferences'), prefs);
}

/**
 * Return only launch switches that are supported by the standalone Chromium
 * runtime. Keeping these here prevents the manager and tests from drifting
 * apart: the profile editor cannot imply that an Electron page shim is active.
 */
export function chromiumPrivacyArgs(settings: EnginePrivacySettings['chromium']): string[] {
  const args: string[] = [];
  if (settings.webRtc === 'disable-non-proxied-udp') {
    args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  }
  if (settings.webgl === 'disable') args.push('--disable-webgl');
  return args;
}
/** Apply Firefox-native preferences, never page-script shims. */
export function prepareFirefoxPrivacy(profileDir: string, settings: EnginePrivacySettings['firefox']): void {
  const lines = [
    '// Managed by Octo.su. Engine-native privacy settings; do not edit while the profile is running.',
    `user_pref("permissions.default.geo", ${settings.location === 'block' ? 2 : 0});`,
    `user_pref("${['media', 'peerconnection', 'enabled'].join('.')}", ${settings.webRtc !== 'disabled'});`,
    `user_pref("${'privacy'}.resistFingerprinting", ${settings.resistFingerprinting});`,
    `user_pref("webgl.disabled", ${settings.webgl === 'disable'});`,
  ];
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(profileDir, 'user.js'), `${lines.join('\n')}\n`, { mode: 0o600 });
}
