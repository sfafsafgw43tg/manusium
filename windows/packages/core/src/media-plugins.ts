/**
 * packages/core/src/media-plugins.ts
 *
 * The two vStudio media plugins. Both drive the same bundled virtual
 * camera/microphone companion, but each one is a separate plugin with its own
 * name, its own installation folder, its own configuration and its own on/off
 * switch in Settings:
 *
 *   - vStudio Mobile ("vstudio-mobile") serves Android devices only. The
 *     emulator picks the camera up as webcam0 and the microphone as
 *     hw.audioInput; no desktop or browser output is produced.
 *   - vStudio Web Octo browsers ("vstudio-web") serves every Octo browser
 *     profile. It publishes one unmistakable camera/microphone name so users
 *     do not confuse it with vStudio Mobile or a physical webcam.
 *
 * Neither plugin ever runs on its own: a disabled plugin is never prepared,
 * never configured and never started.
 */

export type MediaPluginId = 'vstudio-mobile' | 'vstudio-web';

export const MEDIA_PLUGIN_IDS: MediaPluginId[] = ['vstudio-mobile', 'vstudio-web'];

export interface MediaPluginInfo {
  id: MediaPluginId;
  /** Product name shown in the UI. Deliberately different per plugin. */
  name: string;
  /** What the plugin may attach to. A plugin never crosses into the other scope. */
  scope: 'android' | 'browser';
  /** Folder suffix so the two plugins never share an installation. */
  folder: string;
  /** Companion run mode written into its config.json. */
  mode: 'android' | 'browser';
  /** i18n key of the one-line description. */
  descriptionKey: string;
}

export const MEDIA_PLUGINS: Record<MediaPluginId, MediaPluginInfo> = {
  'vstudio-mobile': {
    id: 'vstudio-mobile',
    name: 'vStudio Mobile',
    scope: 'android',
    folder: 'OctoStudioMedia',
    mode: 'android',
    descriptionKey: 'plugins.mobile.desc',
  },
  'vstudio-web': {
    id: 'vstudio-web',
    name: 'vStudio Web Octo browsers',
    scope: 'browser',
    folder: 'OctoStudioMediaWeb',
    mode: 'browser',
    descriptionKey: 'plugins.web.desc',
  },
};

export function mediaPlugin(id: MediaPluginId): MediaPluginInfo {
  return MEDIA_PLUGINS[id];
}

/** Which plugin owns a scope. One plugin per scope, by design. */
export function mediaPluginForScope(scope: 'android' | 'browser'): MediaPluginInfo {
  return scope === 'android' ? MEDIA_PLUGINS['vstudio-mobile'] : MEDIA_PLUGINS['vstudio-web'];
}

export interface MediaPluginSettings { enabled: boolean }
export type MediaPluginSettingsMap = Record<MediaPluginId, MediaPluginSettings>;

/**
 * Both companions are opt-in. A base profile or Android section must never
 * launch a camera/microphone process until the user enables or opens it.
 */
export function defaultMediaPlugins(): MediaPluginSettingsMap {
  return {
    'vstudio-mobile': { enabled: false },
    'vstudio-web': { enabled: false },
  };
}

export function validateMediaPlugins(value: unknown): MediaPluginSettingsMap {
  const d = defaultMediaPlugins();
  const v = (value ?? {}) as Partial<Record<MediaPluginId, Partial<MediaPluginSettings>>>;
  const out = {} as MediaPluginSettingsMap;
  for (const id of MEDIA_PLUGIN_IDS) {
    const enabled = v?.[id]?.enabled;
    out[id] = { enabled: typeof enabled === 'boolean' ? enabled : d[id].enabled };
  }
  return out;
}

export function mediaPluginEnabled(plugins: MediaPluginSettingsMap | undefined, id: MediaPluginId): boolean {
  return !!plugins?.[id]?.enabled;
}
