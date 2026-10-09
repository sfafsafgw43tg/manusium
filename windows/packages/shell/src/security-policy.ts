/** Central Electron security policy. Profile data may never provide these values. */

const UNSAFE_SWITCHES = new Set([
  'no-sandbox', 'disable-setuid-sandbox', 'disable-web-security',
  'ignore-certificate-errors', 'ignore-certificate-errors-spki-list', 'allow-insecure-localhost', 'remote-debugging-port',
  'remote-debugging-pipe', 'inspect', 'inspect-brk', 'load-extension',
  'disable-extensions-except', 'disable-site-isolation-trials',
  'allow-running-insecure-content', 'ignore-gpu-blocklist', 'enable-unsafe-swiftshader',
  'enable-unsafe-webgpu',
]);

const UNSAFE_FEATURES = new Set(['isolateorigins', 'site-per-process']);
const SAFE_SWITCHES = new Set(['disable-gpu', 'disable-gpu-compositing', 'in-process-gpu', 'disable-software-rasterizer', 'disable-gpu-rasterization', 'enable-features', 'force-webrtc-ip-handling-policy', 'lang', 'no-pings', 'disable-domain-reliability', 'disable-background-networking', 'disable-features']);

export interface SafeWebPreferences {
  sandbox: true;
  webSecurity: true;
  contextIsolation: true;
  nodeIntegration: false;
  nodeIntegrationInSubFrames: false;
  nodeIntegrationInWorker: false;
  enableWebSQL: false;
  navigateOnDragDrop: false;
  allowRunningInsecureContent: false;
  experimentalFeatures: false;
}

export const SAFE_WEB_PREFERENCES: SafeWebPreferences = Object.freeze({
  sandbox: true,
  webSecurity: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  nodeIntegrationInWorker: false,
  enableWebSQL: false,
  navigateOnDragDrop: false,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
});

export function assertSafeWebPreferences(prefs: Readonly<Record<string, unknown>>): void {
  for (const [key, expected] of Object.entries(SAFE_WEB_PREFERENCES)) {
    if (prefs[key] !== expected) throw new Error(`unsafe webPreferences.${key}`);
  }
  if (prefs.enableRemoteModule === true || prefs.webviewTag === true) throw new Error('unsafe webPreferences feature');
}

export function toSafeChromiumSwitches(hints: readonly (readonly [string, string?])[]): Array<[string, string?]> {
  return hints.map(([name, value]) => {
    const normalized = name.replace(/^--/, '').toLowerCase();
    if (UNSAFE_SWITCHES.has(normalized)) throw new Error(`unsafe Chromium switch: ${name}`);
    if (normalized === 'disable-features' && value && value.split(',').some((feature) => UNSAFE_FEATURES.has(feature.trim().toLowerCase()))) {
      throw new Error(`unsafe Chromium switch: ${name}`);
    }
    if (!SAFE_SWITCHES.has(normalized)) throw new Error(`unapproved Chromium switch: ${name}`);
    return [normalized, value];
  });
}
