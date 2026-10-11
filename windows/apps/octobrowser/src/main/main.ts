/**
 * apps/octobrowser/src/main/main.ts - entry point of Octo.su.
 *
 * The same executable runs in two roles:
 *   (no flag)                 -> profile MANAGER / launcher (single instance)
 *   --profile-process=<id>    -> browser process of one profile (spawned by the manager)
 */
import { app, dialog, protocol } from 'electron';
import { Logger, ProfileManager, effectiveSettings, createSettingsStore, sanitizeProfile, newProfileId } from '@octo/core';
import { argValue, hasFlag, prepareApp, relaunchArgsWithout, resetPreparedApp } from '@octo/shell/prepare';
import { hardenApp } from '@octo/shell/hardening';
import { setTrustedRoot } from '@octo/shell/ipc';
import { startApp } from '@octo/shell/context';
import { Manager } from './manager';
import { runProfileProcess } from './runtime';
import { runCliVerifyIfRequested } from '@octo/shell/cli-verify';

const distDir = __dirname;
setTrustedRoot(distDir);
const profileId = argValue('profile-process');
const factoryReset = hasFlag('factory-reset');

if (runCliVerifyIfRequested('octobrowser')) {
  // ------------------------------------------ headless release verification (scripts)
  // Nothing else runs: no window, no single-instance lock, no user data access.
} else if (process.platform !== 'win32' || process.arch !== 'x64') {
  app.whenReady().then(() => {
    dialog.showErrorBox('Unsupported system', 'Octo.su requires Windows 10 or 11 on an x86-64 computer.');
    app.exit(2);
  });
} else if (factoryReset) {
  // A reset is performed in a fresh process, before Chromium creates any files
  // in the selected data folder. It then relaunches into the first-run wizard.
  const prep = prepareApp('octobrowser', distDir);
  try { resetPreparedApp(prep); } catch (err) { console.error('OctoBrowser factory reset failed:', err); }
  app.whenReady().then(() => { app.relaunch({ args: relaunchArgsWithout('factory-reset') }); app.exit(0); });
} else if (profileId && /^[a-z0-9-]{3,64}$/.test(profileId)) {
  // ---------------------------------------------------- profile process role
  const prep = prepareApp('octobrowser', distDir, {
    engineDirFor: (layout) => layout.profileEngineDir(profileId),
    extraSwitches: (layout) => {
      try {
        const p = new ProfileManager(layout).get(profileId);
        const s = effectiveSettings(p.protection);
        const appSettings = createSettingsStore(layout).load();
        const switches: Array<[string, string?]> = [['force-webrtc-ip-handling-policy', s.webrtc]];
        if (appSettings.privacyRuntime.graphicsExposure === 'block') {
          // Honest containment: disable GPU-backed web graphics; never replace it
          // with a fabricated renderer or an unsafe software GPU.
          switches.push(['disable-gpu'], ['disable-gpu-compositing']);
        }
        return switches;
      } catch {
        return [];
      }
    },
  });
  if (!prep.state) {
    app.exit(3); // not configured - must be started by the manager
  } else {
    const layout = prep.layout!;
    app.whenReady().then(() => hardenApp(new Logger(layout.logs, 'octobrowser-profiles'))).catch(() => undefined);
    runProfileProcess(distDir, prep.state.dataDir, prep.state.language, profileId);
  }
} else {
  // ---------------------------------------------------------- manager role
  protocol.registerSchemesAsPrivileged([{ scheme: 'octo', privileges: { standard: true, secure: true } }]);
  const prep = prepareApp('octobrowser', distDir);
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
  } else {
    app.whenReady().then(async () => {
      const ctx = await startApp(prep);
      if (!ctx) { app.quit(); return; }
      hardenApp(ctx.logger);
      // Windows Sandbox session: create the profile passed by the host and open it directly.
      const sandboxProfile = argValue('sandbox-profile');
      const manager = new Manager(ctx);
      if (prep.ephemeral && sandboxProfile) {
        try {
          const src = sanitizeProfile({ ...JSON.parse(Buffer.from(sandboxProfile, 'base64').toString('utf8')), id: newProfileId() });
          const created = manager.profiles.create({ name: src.name, kind: src.kind, patch: { ...src, sandbox: { ...src.sandbox, mode: 'restricted' } } });
          process.argv.push(`--open-profile=${created.id}`);
        } catch (err) {
          ctx.logger.error('sandbox.profile-invalid', err);
        }
      }
      // Open the real launcher directly. A separate splash only added another
      // window transition without making initialization finish any sooner.
      manager.start();
    }).catch((err) => {
      const message = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
      console.error(message);
      // Windows desktop launchers normally hide stderr, so always surface the
      // diagnostic location instead of briefly flashing and disappearing.
      try { dialog.showErrorBox('Octo.su could not start', `${message}\n\nDiagnostic logs are in %LOCALAPPDATA%\\OctoSuite\\logs.`); } catch { /* no display */ }
      app.exit(1);
    });
    app.on('window-all-closed', () => { /* manager decides when to quit (profiles may still run) */ });
  }
}
