/**
 * packages/shell/src/osprotector.ts
 *
 * OsProtector backed by Electron safeStorage. On Windows safeStorage uses
 * DPAPI (CryptProtectData) bound to the current Windows user account, which
 * is the same mechanism Windows Credential Manager uses to protect its vault.
 * We deliberately store only the DPAPI-wrapped key in our own keyring file
 * (instead of Credential Manager) so the whole application data folder can be
 * moved/backed up together.
 */
import { safeStorage } from 'electron';
import type { OsProtector } from '@octo/core';

export const dpapiProtector: OsProtector = {
  name: 'Windows DPAPI',
  available(): boolean {
    try {
      if (!safeStorage.isEncryptionAvailable()) return false;
      return true;
    } catch {
      return false;
    }
  },
  protect(data: Buffer): Buffer {
    // safeStorage.encryptString takes a string: encode the key as base64.
    return safeStorage.encryptString(data.toString('base64'));
  },
  unprotect(data: Buffer): Buffer {
    return Buffer.from(safeStorage.decryptString(data), 'base64');
  },
};
