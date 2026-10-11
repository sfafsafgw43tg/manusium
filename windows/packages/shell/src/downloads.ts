/** Windows download filename, collision and display-URL safety helpers. */
import * as fs from 'node:fs';
import * as path from 'node:path';

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

/** Keep a site's suggestion where Windows permits it, without accepting paths. */
export function safeDownloadFilename(input: string): string {
  let name = path.win32.basename(String(input ?? '')).normalize('NFC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .replace(/^\.+/, '_')
    .slice(0, 180)
    .trim();
  if (!name) name = 'download';
  if (WINDOWS_RESERVED_NAME.test(name)) name = `_${name}`;
  return name;
}

/** Collision-free Windows destination when the native picker is disabled. */
export function uniqueDownloadPath(dir: string, suggestedName: string): string {
  const safe = safeDownloadFilename(suggestedName);
  const ext = path.win32.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let i = 1; fs.existsSync(candidate) && i < 10_000; i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

/** Never put credentials or sensitive URL parameters in UI, notifications, or logs. */
export function safeDownloadSource(input: string): string {
  try {
    const url = new URL(input);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return `${url.protocol}//${url.host}${url.pathname}`.slice(0, 2048);
  } catch { return ''; }
}
