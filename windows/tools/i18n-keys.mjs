// tools/i18n-keys.mjs
//
// Lists every translation key referenced in the sources and reports keys that
// are missing from (or unused in) the English / Polish dictionaries.
//
//   node tools/i18n-keys.mjs           -> report, exit code 1 when keys are missing
//   node tools/i18n-keys.mjs --list    -> print all static keys found
//
// Static keys: t('x'), T('x'), this.t('x'), ctx.t('x'), data-i18n="x",
// data-i18n-ph/-title, key: 'x', labelKey: 'x', whyKey/fixKey: 'x', 't:x',
// SHORTCUT_HELP entries. Dynamic keys (template strings such as
// `level.${x}`) are expanded from the DYNAMIC table below.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIRS = ['packages/core/src', 'packages/shell/src', 'packages/shell/renderer', 'apps/octobrowser/src', 'apps/octodetect/src'];

/** Expansion of template-string keys used in the UI. Keep in sync with the code. */
export const DYNAMIC = {
  'android.category': ['phone', 'foldable', 'flip', 'tablet'],
  'android.progress': ['starting', 'download', 'unzip', 'install', 'licence', 'create', 'configure', 'done', 'failed'],
  'profile.kind': ['personal', 'work', 'private', 'testing', 'temporary', 'tor', 'custom'],
  'profile.kindDesc': ['personal', 'work', 'private', 'testing', 'temporary', 'tor', 'custom'],
  level: ['standard', 'strict', 'tor'],
  'level.standard': ['desc'], 'level.strict': ['desc'], 'level.tor': ['desc'],
  'net.mode': ['system', 'direct', 'proxy'],
  'iso.mode': ['none', 'restricted', 'windows-sandbox', 'wsbUnavailable'],
  'iso.clipboard': ['allow', 'write-only', 'block'],
  'ui.sec': ['https', 'http', 'internal', 'other'],
  leak: ['ok', 'warning', 'leak', 'unknown', 'limited', 'exposed'],
  webrtc: ['default', 'default_public_interface_only', 'disable_non_proxied_udp'],
  canvas: ['allow', 'block-readback'],
  webgl: ['allow', 'disabled'],
  hardware: ['allow', 'normalize'],
  ov: ['blockAds', 'blockTrackers', 'httpsOnly', 'blockThirdPartyCookies', 'stripTrackingParams', 'blockBounceTracking', 'webrtc', 'canvas', 'webgl', 'hardwareApis', 'blockAutoplay', 'clearOnExit', 'warnDangerousDownloads', 'blockPopups', 'trimReferrer', 'globalPrivacyControl', 'geolocation', 'notifications', 'confirmCrossSiteRedirects'],
  geolocation: ['ask', 'block'],
  notifications: ['ask', 'block'],
  'addons.status': ['stable', 'experimental'],
  'dl.state': ['progressing', 'completed', 'cancelled', 'interrupted', 'paused', 'awaiting-confirmation'],
  'upd.sev': ['security', 'recommended', 'optional', 'normal', 'critical'],
  perm: ['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read', 'display-capture', 'devices', 'openExternal', 'pointerLock', 'storage-access', 'other'],
  panel: ['traffic', 'audio', 'privacy', 'addons', 'downloads', 'bookmarks', 'history', 'updates', 'shortcuts'],
  'launcher.nav': ['profiles', 'security', 'updates', 'settings', 'logs', 'about'],
  'edit.tab': ['general', 'privacy', 'network', 'sandbox', 'addons'],
  'launch.status': ['started', 'focused', 'wsb-launched', 'tor-launched'],
  'backups': ['profiles', 'settings'],
  'logs': ['standard', 'diagnostic'],
  'od.nav': ['audit', 'reports', 'updates', 'settings', 'logs', 'about'],
  target: ['baseline', 'standard', 'strict', 'external'],
  'target.baseline': ['desc'], 'target.standard': ['desc'], 'target.strict': ['desc'], 'target.external': ['desc', 'howto'],
  'audit.stage': ['probe', 'environment', 'report'],
  risk: ['low', 'medium', 'high', 'unknown'],
  'risk.low': ['desc'], 'risk.medium': ['desc'], 'risk.high': ['desc'], 'risk.unknown': ['desc'],
  uniq: ['likely-common', 'possibly-unique', 'likely-unique', 'unknown'],
  fstatus: ['exposed', 'limited', 'blocked', 'unknown'],
  entropy: ['low', 'medium', 'high'],
  cat: ['identity', 'hardware', 'fingerprint', 'network', 'storage', 'permissions', 'isolation'],
  finding: ['userAgent', 'os', 'language', 'timezone', 'screen', 'hardware', 'deviceApis', 'fonts', 'canvas', 'webgl', 'audio', 'extensions', 'publicIp', 'webrtc', 'dns', 'proxy', 'https', 'cookies', 'storage', 'geolocation', 'camera', 'microphone', 'mediaDevices', 'sandbox', 'isolation'],
  'why.perm': ['granted', 'denied', 'prompt', 'unsupported', 'error'],
  'why.webrtc': ['ok', 'warning', 'leak', 'unknown'],
  'why.dns': ['ok', 'warning', 'leak', 'unknown'],
  'report.export': ['html', 'json'],
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['dist', 'node_modules', 'i18n'].includes(e.name)) walk(p, out); }
    else if (/\.(ts|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

export function collectKeys() {
  const keys = new Set();
  const RX = [
    /\b(?:t|T|this\.t|ctx\.t|this\.ctx\.t)\(\s*'([a-zA-Z][\w.-]*)'/g,
    /data-i18n(?:-ph|-title)?="([a-zA-Z][\w.-]*)"/g,
    /\b(?:key|labelKey|whyKey|fixKey|titleKey|bodyKey|okKey|phKey|hintKey):\s*'([a-zA-Z][\w.-]*\.[\w.-]+)'/g,
    /'t:([a-zA-Z][\w.-]*)'/g,
    /`t:([a-zA-Z][\w.-]*)`/g,
    /\['[^']*',\s*'(sc\.[\w.-]+)'\]/g,
    /\b(?:field|toggle|section|kv|badge|passwordInput|confirmDialog|run)\([^)]*?'([a-z][\w-]*\.[\w.-]+)'/g,
  ];
  for (const d of SRC_DIRS) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) {
      const text = fs.readFileSync(f, 'utf8');
      for (const rx of RX) for (const m of text.matchAll(rx)) keys.add(m[1]);
    }
  }
  for (const [prefix, list] of Object.entries(DYNAMIC)) for (const s of list) keys.add(`${prefix}.${s}`);
  // Second pass: any string literal inside a known namespace (catches keys passed through helpers).
  const ns = new Set([...keys].map((k) => k.split('.')[0]));
  ns.add('fix'); ns.add('err'); ns.add('conn'); ns.add('menu'); ns.add('tab'); ns.add('status'); ns.add('keyring');
  const LIT = /['"`]([a-zA-Z]+)\.([\w-]+(?:\.[\w-]+)*)['"`]/g;
  for (const d of SRC_DIRS) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(LIT)) if (ns.has(m[1]) && !/\.(js|css|html|exe|json|txt|svg|png|ico)$/.test(m[0].slice(1, -1))) keys.add(`${m[1]}.${m[2]}`);
    }
  }
  // Prefix-only matches (e.g. "level.standard" used as both key and prefix) are fine.
  // Log event names (logger.info('profile.spawned')) are not UI text.
  const logOnly = new Set();
  const LOG = /\.(?:info|warn|error|debug)\(\s*'([\w.-]+)'/g;
  for (const d of SRC_DIRS) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) for (const m of fs.readFileSync(f, 'utf8').matchAll(LOG)) logOnly.add(m[1]);
  }
  for (const k of logOnly) keys.delete(k);
  // Android platform names (permissions and intent actions) are not UI text.
  return [...keys].filter((k) => !/\.$/.test(k) && !/^(node|electron|http|whoami)\./.test(k) && !/\.(exe|js|css|html|json|bin)$/.test(k)
    && !/^android\.(permission|media\.action)\./.test(k)).sort();
}

async function loadDict(lang) {
  const file = path.join(root, 'packages/core/src/i18n', `${lang}.ts`);
  const text = fs.readFileSync(file, 'utf8');
  const keys = new Set();
  for (const m of text.matchAll(/^\s*'([^']+)':/gm)) keys.add(m[1]);
  return keys;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const keys = collectKeys();
  if (process.argv.includes('--list')) { console.log(keys.join('\n')); process.exit(0); }
  let missingTotal = 0;
  for (const lang of ['en', 'pl']) {
    const dict = await loadDict(lang);
    const missing = keys.filter((k) => !dict.has(k));
    const unused = [...dict].filter((k) => !keys.includes(k));
    missingTotal += missing.length;
    console.log(`${lang}: ${dict.size} entries, ${missing.length} missing, ${unused.length} not referenced statically`);
    if (missing.length) console.log(`  missing: ${missing.join(', ')}`);
  }
  process.exit(missingTotal ? 1 : 0);
}
