/**
 * packages/shell/src/keyring-recovery.ts
 *
 * Shared recovery path for a keyring that cannot be opened:
 *   - DPAPI blob from another Windows account / another PC,
 *   - damaged keyring.bin,
 *   - an old build's format.
 *
 * Nothing is deleted: the unreadable key and the data that depends on it are
 * moved into backups\unreadable-<timestamp> so the user can still try a backup
 * later, and a brand new key is created. Profiles keep their files; encrypted
 * profiles report damage on their own and can be reset with
 * scripts\reset-profile.bat.
 *
 * Lives in its own module so both context.ts (startup) and unlock.ts (master
 * password window) can use it without a circular import.
 */
import { dialog, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DataLayout, Keyring, Lang, Logger, t as translate } from '@octo/core';

/**
 * @returns true when the app can continue (a fresh key was created),
 *          false when the user chose to quit / open the data folder.
 */
export async function recoverKeyring(
  keyring: Keyring,
  layout: DataLayout,
  lang: Lang,
  logger: Logger,
  bodyKey: string,
): Promise<boolean> {
  const tr = (k: string, p?: Record<string, string>) => translate(lang, k, p);
  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: tr('err.keyring.title'),
    message: tr(bodyKey),
    detail: tr('err.keyring.recoverDetail'),
    buttons: [tr('err.keyring.recoverNew'), tr('err.keyring.recoverFolder'), tr('common.quit')],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (choice === 1) {
    void shell.openPath(layout.config);
    return false;
  }
  if (choice !== 0) return false;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantine = path.join(layout.backups, `unreadable-${stamp}`);
  try {
    const moved = await keyring.resetToNewKey(quarantine);
    // secrets.bin was wrapped with the old key - it is now noise; keep it next to the key.
    const secretsFile = path.join(layout.config, 'secrets.bin');
    if (fs.existsSync(secretsFile)) {
      fs.mkdirSync(quarantine, { recursive: true });
      fs.renameSync(secretsFile, path.join(quarantine, 'secrets.bin'));
    }
    logger.warn('keyring.reset', { quarantine, previous: moved ?? '' });
    dialog.showMessageBoxSync({
      type: 'info',
      title: tr('err.keyring.title'),
      message: tr('err.keyring.recoverDone'),
      detail: quarantine,
      buttons: [tr('common.close')],
      noLink: true,
    });
    return true;
  } catch (e) {
    logger.error('keyring.reset-failed', { message: String((e as Error)?.message ?? e) });
    dialog.showErrorBox(tr('err.keyring.title'), tr('err.keyring.recoverFailed', { message: String((e as Error)?.message ?? e) }));
    return false;
  }
}
