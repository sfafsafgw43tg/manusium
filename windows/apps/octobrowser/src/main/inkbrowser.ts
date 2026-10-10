/**
 * apps/octobrowser/src/main/inkbrowser.ts
 *
 * Finds the installed InkBrowser base. The base is installed per user at
 * %LOCALAPPDATA%\InkBrowser\Application\inkbrowser-chrome.exe (see docs/inkbrowser/BLUEPRINT.md).
 * OctoBrowser never bundles or downloads it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { INKBROWSER_EXECUTABLE, INKBROWSER_INSTALL_DIR } from '@octo/core';

export function inkbrowserInstallPath(localAppData: string): string {
  return path.join(localAppData, INKBROWSER_INSTALL_DIR, 'Application', INKBROWSER_EXECUTABLE);
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The installed executable, or null when the base is not installed. `exists` is injectable for tests. */
export function findInkBrowser(
  localAppData: string = process.env.LOCALAPPDATA || '',
  exists: (file: string) => boolean = isFile,
): string | null {
  if (!localAppData) return null;
  const exe = inkbrowserInstallPath(localAppData);
  return exists(exe) ? exe : null;
}
