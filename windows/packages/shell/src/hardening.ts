/**
 * packages/shell/src/hardening.ts
 *
 * Application-wide Electron hardening (Electron security checklist):
 *   - no <webview> tags, no remote module, no Node integration anywhere;
 *   - UI windows cannot navigate away or open new windows;
 *   - every renderer is sandboxed (app.enableSandbox() in prepare.ts);
 *   - the default application menu (with dev tools shortcuts) is removed.
 */
import { app, Menu, WebContents } from 'electron';
import type { Logger } from '@octo/core';

/** WebContents ids that belong to browser TABS (web content) - managed by the browser app. */
export const tabContents = new Set<number>();

export function hardenApp(logger: Logger): void {
  Menu.setApplicationMenu(null);

  app.on('web-contents-created', (_e, contents: WebContents) => {
    // Never allow <webview>.
    contents.on('will-attach-webview', (ev) => {
      ev.preventDefault();
      logger.warn('security.webview-blocked');
    });

    // UI pages (file://) must never navigate to the web or open windows.
    contents.on('will-navigate', (ev, url) => {
      if (tabContents.has(contents.id)) return; // tabs are handled by the browser
      if (!url.startsWith('file:')) {
        ev.preventDefault();
        logger.warn('security.ui-navigation-blocked');
      }
    });
    contents.setWindowOpenHandler(() => {
      if (tabContents.has(contents.id)) return { action: 'deny' }; // browser installs its own handler later
      return { action: 'deny' };
    });
  });
}
