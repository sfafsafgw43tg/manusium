/**
 * packages/shell/src/cli-verify.ts
 *
 * Headless verification mode for the maintenance scripts:
 *
 *   Octo.su.exe --verify-manifest=<dir>\latest.json
 *                      [--verify-installer=<dir>\OctoSuite-Setup-x.y.z.exe]
 *                      --verify-result=<file.json>
 *
 * Runs BEFORE any window, single-instance lock or data access; writes a JSON
 * result (see VerifyResult in @octo/core) and exits with its code. GUI apps on
 * Windows have no console, therefore the result goes to a file chosen by the
 * caller (scripts/lib/octo.ps1 uses a fresh file in %TEMP%).
 */
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppId, UPDATE_PUBLIC_KEY_PEM, VERIFY_CODES, verifyRelease } from '@octo/core';
import { argValue } from './prepare';

/** Returns true when verification mode was requested (the caller must then do nothing else). */
export function runCliVerifyIfRequested(appId: AppId): boolean {
  const manifest = argValue('verify-manifest');
  if (!manifest) return false;
  const resultFile = argValue('verify-result');
  const installer = argValue('verify-installer');
  let code: number = VERIFY_CODES.ioError;
  try {
    if (!resultFile || !path.isAbsolute(resultFile) || !path.isAbsolute(manifest) || (installer && !path.isAbsolute(installer))) {
      throw new Error('verify mode requires absolute paths for --verify-manifest, --verify-installer and --verify-result');
    }
    const res = verifyRelease(manifest, installer, appId, UPDATE_PUBLIC_KEY_PEM);
    code = res.code;
    fs.writeFileSync(resultFile, JSON.stringify(res, null, 2), { encoding: 'utf8', flag: 'w' });
  } catch (err) {
    try {
      if (resultFile && path.isAbsolute(resultFile)) {
        fs.writeFileSync(resultFile, JSON.stringify({ ok: false, code, error: (err as Error).message }), 'utf8');
      }
    } catch {
      /* nothing else we can do - the exit code still reports the failure */
    }
  }
  app.exit(code);
  return true;
}
