/**
 * packages/shell/src/unlock.ts
 *
 * Master-password window. Shown when the keyring of the data folder is in
 * "password" mode (the user chose a master password in the first-run wizard or
 * in Settings > Security).
 *
 * Rules implemented here:
 *  - the password is passed from the renderer over IPC, used once and dropped -
 *    it is never logged, never stored, never returned to the renderer;
 *  - a wrong password shows a realistic message and allows another attempt
 *    (the DEK simply stays locked, so nothing is half-open);
 *  - "I forgot the password" leads to the same quarantine-and-start-fresh
 *    recovery as a damaged keyring - it is explained as data loss for
 *    locally-encrypted stores, and the user must confirm it;
 *  - cancelling quits the application instead of running with a locked key.
 */
import { BrowserWindow } from 'electron';
import { AppId, DICTS, DataLayout, Keyring, Lang, Logger, SUITE_VERSION } from '@octo/core';
import { handle } from './ipc';
import { recoverKeyring } from './keyring-recovery';
import { createUtilityWindow } from './windows-ui';

export interface UnlockOptions {
  distDir: string;
  appId: AppId;
  productName: string;
  lang: Lang;
  layout: DataLayout;
  keyring: Keyring;
  logger: Logger;
}

/**
 * Show the window and resolve:
 *  - true  -> the keyring is unlocked, the app may continue;
 *  - false -> the user cancelled (or recovery was aborted): the caller must quit.
 */
export function runMasterPasswordUnlock(opts: UnlockOptions): Promise<boolean> {
  const { distDir, appId, productName, lang, layout, keyring, logger } = opts;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let attempts = 0;
    const win: BrowserWindow = createUtilityWindow(distDir, appId, 'unlock.html', { width: 520, height: 470 });

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (!win.isDestroyed()) win.close();
      resolve(ok);
    };

    handle('unlock:init', logger, () => ({
      app: appId,
      productName,
      version: SUITE_VERSION,
      lang,
      dicts: DICTS,
    }));

    handle('unlock:submit', logger, async (_e, password: unknown) => {
      const pw = typeof password === 'string' ? password : '';
      if (!pw) return { ok: false as const, errorKey: 'unlock.empty' };
      attempts += 1;
      try {
        await keyring.unlock(pw);
        logger.info('keyring.unlocked', { mode: 'password', attempts });
        finish(true);
        return { ok: true as const };
      } catch {
        logger.warn('keyring.unlock-failed', { attempts });
        // Never reveal whether the file or the password is the problem beyond
        // this message; more detail would help an attacker with the file.
        return { ok: false as const, errorKey: attempts >= 3 ? 'unlock.wrongMany' : 'unlock.wrong' };
      }
    });

    handle('unlock:forgot', logger, async () => {
      const ok = await recoverKeyring(keyring, layout, lang, logger, 'err.keyring.forgotPassword');
      finish(ok);
      return ok;
    });

    handle('unlock:cancel', logger, () => {
      logger.info('keyring.unlock-cancelled');
      finish(false);
    });

    win.on('closed', () => {
      if (!settled) {
        settled = true;
        resolve(false); // window closed by the user = cancel
      }
    });
  });
}
