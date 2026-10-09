import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_ENGINE_PRIVACY, sanitizeEnginePrivacy } from '@octo/core';
import { prepareChromiumPrivacy, prepareFirefoxPrivacy } from '../src/engine-privacy';

describe('engine-specific privacy settings', () => {
  it('sanitizes unsupported values to safe defaults without cross-engine leakage', () => {
    const settings = sanitizeEnginePrivacy({ chromium: { webRtc: 'disabled', location: 'custom' }, firefox: { webRtc: 'disable-non-proxied-udp', location: 'custom', resistFingerprinting: 'yes' } });
    expect(settings).toEqual(DEFAULT_ENGINE_PRIVACY);
  });

  it('writes Chromium-native preferences and preserves unrelated profile preferences', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-engine-privacy-chrome-'));
    fs.writeFileSync(path.join(dir, 'Preferences'), JSON.stringify({ session: { restored: true } }));
    prepareChromiumPrivacy(dir, { webRtc: 'disable-non-proxied-udp', location: 'block', webgl: 'disable' });
    const prefs = JSON.parse(fs.readFileSync(path.join(dir, 'Preferences'), 'utf8'));
    expect(prefs.session.restored).toBe(true);
    expect(prefs.profile.default_content_setting_values.geolocation).toBe(2);
    expect(prefs.webrtc.ip_handling_policy).toBe('disable_non_proxied_udp');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes Firefox-native user.js and reset values are explicit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-engine-privacy-firefox-'));
    prepareFirefoxPrivacy(dir, { webRtc: 'disabled', location: 'block', resistFingerprinting: true, webgl: 'disable' });
    let userJs = fs.readFileSync(path.join(dir, 'user.js'), 'utf8');
    expect(userJs).toContain('permissions.default.geo", 2');
    expect(userJs).toContain('media.peerconnection.enabled", false');
    expect(userJs).toContain('privacy.resistFingerprinting", true');
    expect(userJs).toContain('webgl.disabled", true');
    prepareFirefoxPrivacy(dir, DEFAULT_ENGINE_PRIVACY.firefox);
    userJs = fs.readFileSync(path.join(dir, 'user.js'), 'utf8');
    expect(userJs).toContain('permissions.default.geo", 0');
    expect(userJs).toContain('media.peerconnection.enabled", true');
    expect(userJs).toContain('privacy.resistFingerprinting", false');
    expect(userJs).toContain('webgl.disabled", false');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
