/**
 * packages/core/src/release-verify.ts
 *
 * Offline verification of a downloaded release, used by the maintenance
 * scripts (install.bat / update.bat / repair.bat) through the apps' CLI mode
 * `--verify-manifest=<latest.json> [--verify-installer=<exe>] --verify-result=<json>`
 * (see packages/shell/src/cli-verify.ts).
 *
 * Windows PowerShell 5.1 (.NET Framework) cannot verify Ed25519 signatures, so the
 * scripts delegate this step to the already installed, trusted application, which
 * carries the update public key compiled in. The same code path as the in-app
 * updater is used (verifyAndParseManifest), so there is exactly one implementation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { AppId } from './appinfo';
import { verifyAndParseManifest } from './updater';

export type VerifyCode = 0 | 10 | 11 | 12 | 13 | 14;

/** Exit codes shared with scripts/lib/octo.ps1 - keep in sync. */
export const VERIFY_CODES = Object.freeze({
  ok: 0 as VerifyCode,
  notConfigured: 10 as VerifyCode,
  badSignature: 11 as VerifyCode,
  hashMismatch: 12 as VerifyCode,
  ioError: 13 as VerifyCode,
  notInManifest: 14 as VerifyCode,
});

export interface VerifyResult {
  ok: boolean;
  code: VerifyCode;
  /** Version of `app` in the manifest (when the signature is valid). */
  version?: string;
  severity?: string;
  installer?: { name: string; sha256: string; expected?: string; match: boolean };
  error?: string;
}

function sha256FileSync(file: string): string {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * Verify `latest.json` + `latest.json.sig` (same folder) with `publicKeyPem` and,
 * optionally, that `installerPath` matches the signed SHA-256 for `app`.
 * Never throws - problems are reported through `code`/`error`.
 */
export function verifyRelease(manifestPath: string, installerPath: string | undefined, app: AppId, publicKeyPem: string): VerifyResult {
  if (!publicKeyPem) return { ok: false, code: VERIFY_CODES.notConfigured, error: 'Update signing key not configured in this build' };
  let bytes: Buffer;
  let sig: string;
  try {
    bytes = fs.readFileSync(manifestPath);
    sig = fs.readFileSync(`${manifestPath}.sig`, 'utf8');
  } catch (err) {
    return { ok: false, code: VERIFY_CODES.ioError, error: `Cannot read manifest or signature: ${(err as Error).message}` };
  }
  let manifest;
  try {
    manifest = verifyAndParseManifest(bytes, sig, publicKeyPem);
  } catch (err) {
    return { ok: false, code: VERIFY_CODES.badSignature, error: (err as Error).message };
  }
  const rel = manifest.apps[app];
  if (!rel) return { ok: false, code: VERIFY_CODES.notInManifest, error: `No release for ${app} in manifest` };
  const base: VerifyResult = { ok: true, code: VERIFY_CODES.ok, version: rel.version, severity: rel.severity };
  if (!installerPath) return base;

  const name = path.basename(installerPath);
  let actual: string;
  try {
    actual = sha256FileSync(installerPath);
  } catch (err) {
    return { ...base, ok: false, code: VERIFY_CODES.ioError, error: `Cannot read installer: ${(err as Error).message}` };
  }
  const entry = rel.files.find((f) => f.name.toLowerCase() === name.toLowerCase());
  if (!entry) {
    return { ...base, ok: false, code: VERIFY_CODES.notInManifest, installer: { name, sha256: actual, match: false }, error: `${name} is not listed in the signed manifest` };
  }
  const match = entry.sha256 === actual;
  return {
    ...base,
    ok: match,
    code: match ? VERIFY_CODES.ok : VERIFY_CODES.hashMismatch,
    installer: { name, sha256: actual, expected: entry.sha256, match },
    error: match ? undefined : 'SHA-256 of the installer does not match the signed manifest',
  };
}
