/**
 * The two vStudio plugins must stay separate: different names, different
 * scopes, different installation folders, and an on/off switch each that is
 * actually honoured by the media layer.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  MEDIA_PLUGINS, MEDIA_PLUGIN_IDS, defaultMediaPlugins, validateMediaPlugins, mediaPluginEnabled,
  mediaPluginForScope, defaultSettings, validateSettings,
} from '@octo/core';
import {
  mediaCompanionRoot, mediaCompanionStatus, mediaPluginActive, setMediaPluginEnabled,
  ensureMediaCompanion, startMediaCompanion, configureWebMediaCompanion, folderWritable,
} from '../src/main/android-studio';
import * as path from 'node:path';

describe('vStudio plugin registry', () => {
  it('names the Android and the browser plugin differently', () => {
    expect(MEDIA_PLUGINS['vstudio-mobile'].name).toBe('vStudio Mobile');
    expect(MEDIA_PLUGINS['vstudio-web'].name).toBe('vStudio Web Octo browsers');
    expect(MEDIA_PLUGINS['vstudio-mobile'].name).not.toBe(MEDIA_PLUGINS['vstudio-web'].name);
  });

  it('binds each plugin to exactly one scope', () => {
    expect(MEDIA_PLUGINS['vstudio-mobile'].scope).toBe('android');
    expect(MEDIA_PLUGINS['vstudio-web'].scope).toBe('browser');
    expect(mediaPluginForScope('android').id).toBe('vstudio-mobile');
    expect(mediaPluginForScope('browser').id).toBe('vstudio-web');
    expect(MEDIA_PLUGINS['vstudio-mobile'].mode).toBe('android');
    expect(MEDIA_PLUGINS['vstudio-web'].mode).toBe('browser');
  });

  it('keeps the two installations apart', () => {
    const folders = MEDIA_PLUGIN_IDS.map((id) => MEDIA_PLUGINS[id].folder);
    expect(new Set(folders).size).toBe(folders.length);
    expect(mediaCompanionRoot('vstudio-mobile')).not.toBe(mediaCompanionRoot('vstudio-web'));
  });
});

describe('plugin settings', () => {
  it('ships both companions opt-in and survives a round trip', () => {
    const d = defaultMediaPlugins();
    expect(d['vstudio-mobile'].enabled).toBe(false);
    expect(d['vstudio-web'].enabled).toBe(false);
    expect(validateMediaPlugins({ 'vstudio-web': { enabled: true } })['vstudio-web'].enabled).toBe(true);
    expect(validateMediaPlugins({ 'vstudio-web': { enabled: 'yes' } })['vstudio-web'].enabled).toBe(false);
    expect(validateMediaPlugins(undefined)).toEqual(d);
    expect(mediaPluginEnabled(d, 'vstudio-mobile')).toBe(false);
    expect(mediaPluginEnabled(undefined, 'vstudio-mobile')).toBe(false);
  });

  it('is part of the application settings document', () => {
    expect(defaultSettings().plugins).toEqual(defaultMediaPlugins());
    const stored = { ...defaultSettings(), plugins: { 'vstudio-mobile': { enabled: false }, 'vstudio-web': { enabled: true } } };
    const back = validateSettings(stored);
    expect(back.plugins['vstudio-mobile'].enabled).toBe(false);
    expect(back.plugins['vstudio-web'].enabled).toBe(true);
  });
});

describe('a disabled plugin never runs', () => {
  beforeEach(() => {
    setMediaPluginEnabled('vstudio-mobile', true);
    setMediaPluginEnabled('vstudio-web', false);
  });

  it('reports its own identity and switch state', () => {
    const mobile = mediaCompanionStatus('vstudio-mobile');
    const web = mediaCompanionStatus('vstudio-web');
    expect(mobile.plugin).toBe('vstudio-mobile');
    expect(mobile.pluginName).toBe('vStudio Mobile');
    expect(mobile.enabled).toBe(true);
    expect(web.plugin).toBe('vstudio-web');
    expect(web.pluginName).toBe('vStudio Web Octo browsers');
    expect(web.enabled).toBe(false);
    expect(web.running).toBe(false);
  });

  it('refuses to prepare, configure or start while switched off', () => {
    expect(mediaPluginActive('vstudio-web')).toBe(false);
    expect(() => ensureMediaCompanion('vstudio-web')).toThrow(/vStudio Web/);
    expect(() => startMediaCompanion('vstudio-web')).toThrow(/vStudio Web/);
    expect(() => configureWebMediaCompanion({ profileName: 'Shop' })).toThrow(/vStudio Web/);
    setMediaPluginEnabled('vstudio-mobile', false);
    expect(() => ensureMediaCompanion('vstudio-mobile')).toThrow(/vStudio Mobile/);
    setMediaPluginEnabled('vstudio-mobile', true);
  });
});

describe('each plugin fits its own environment', () => {
  it('never stages itself in a folder it cannot write to', () => {
    for (const plugin of MEDIA_PLUGIN_IDS) {
      const root = mediaCompanionRoot(plugin);
      expect(path.isAbsolute(root)).toBe(true);
      expect(path.basename(root)).toBe(MEDIA_PLUGINS[plugin].folder);
      // Either the plugin is already installed there, or the parent must be
      // writable - the EPERM mkdtemp failure came from breaking this rule.
      expect(folderWritable(path.dirname(root))).toBe(true);
    }
  });

  it('asks Android for nothing when it serves browser profiles', () => {
    setMediaPluginEnabled('vstudio-web', true);
    const web = mediaCompanionStatus('vstudio-web');
    const mobile = mediaCompanionStatus('vstudio-mobile');
    const keys = (status: typeof web) => status.requirements.map((item) => item.key);
    expect(keys(web)).toContain('android.media.python');
    expect(keys(web)).toContain('plugins.req.folder');
    expect(keys(web)).not.toContain('plugins.req.emulator');
    expect(keys(mobile)).toContain('plugins.req.emulator');
    expect(typeof web.ready).toBe('boolean');
    setMediaPluginEnabled('vstudio-web', false);
  });
});
