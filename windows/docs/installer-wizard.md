# The OctoSuite setup wizard

`scripts\install.bat` and `scripts\first-install.bat` open the setup wizard in a source
checkout. The default pass installs only what the Chromium desktop app needs: Node.js and git,
project dependencies, the source-built Chromium runtime, the optional desktop shortcut, and the
application build. Android/media plugins and Firefox are separate feature flows and are skipped
when unavailable; they are not allowed to block the desktop app. The wizard is built with Windows Forms in Windows PowerShell 5.1, which Windows
10 and 11 include, so there is nothing to install first. It uses a black classic-installer
palette and keeps **Start Octo.su when finished** selected by default on a successful run.

The Inno Setup program installer (`release\OctoSuite-Setup-<version>.exe`, built from
`installer\octosuite.iss`) installs the built applications with a classic black-themed wizard
and OctoSuite artwork. On a normal interactive install, **Start Octo.su** is selected on the
final page by default; OctoDetect remains an optional unchecked launch. Silent updates do not
show or launch either app from the post-install page.

## Run it

```
scripts\install.bat                 double-click, or run from a terminal in the checkout
scripts\first-install.bat           the same setup, with its own entry point
scripts\install.bat -NoGui          the console instead of the window (CI, servers)
scripts\install.bat -Interactive    the console, asking the old yes/no questions
```

Where Windows Forms is missing (Server Core) the console path is used automatically.

## The pages

1. **Install OctoSuite** (setup options). Android SDK settings remain available for the separate
   Android feature flow (the default is `%LOCALAPPDATA%\Android\Sdk`), along with these optional settings:
   - *Proxy server*: `host:port` or `http(s)://host:port`. Used for the downloads and the
     package managers of this installation only. Credentials are refused.
   - *Use system environment variables (recommended)*: sets `ANDROID_HOME` and
     `ANDROID_SDK_ROOT` for your Windows account, to the SDK folder.
   - *Add Android SDK tools to user PATH (recommended)*: adds `platform-tools`, `emulator` and
     `cmdline-tools\latest\bin` to your user PATH.
   - *VirtualBox / VM compatibility mode*: stored in `%APPDATA%\OctoSuite\install-defaults.json`.
     OctoSuite's scripts and desktop shortcut then start the app with the software GPU fallback.
     The switch in OctoSuite's own Settings is separate and is not changed. A tooltip on the
     checkbox says that the choice applies only to OctoSuite launches and does not change the
     global VM settings.
   The environment variables and PATH are written for your account, so no administrator rights
   are needed. The console installer leaves them alone.
2. **What will be installed**: every component, whether it is required, whether it is already
   installed, and where it lives. *Refresh status* checks again.
3. **Installing**: a progress bar, the step that is running, the time left, the state of each
   step, and a detailed log.
4. **Result**: the outcome, the failed or skipped steps, the log, and *Start Octo.su when finished*.

## What the steps do

Five steps, in this order. This install pass prepares the Chromium source build only; Android/media
prerequisites and Firefox staging remain separate feature flows and are not downloaded here.

| Step | Required | If it fails | What it does |
|---|---|---|---|
| Node.js and git | yes | **Stops the run**: the later steps are skipped | Installs Node.js 22.12+ and git (winget or the vendor installer) |
| Project dependencies | yes | **Stops the run** | `npm ci` (or `npm install`), the required native package setup, and the Electron binary |
| Native Chromium source build | no | Completed with warnings | Attempts depot_tools/Visual Studio setup, checks out the pinned Chromium source, builds it, and verifies the source-built runtime manifest and executable hash; Electron remains available if this optional step fails |
| Desktop shortcut | no | Completed with warnings | Octo.su on the desktop |
| Build | yes | **Stops the run** | `npm run build` for both applications |

## When success is shown

Node.js/git, project dependencies, and the application build stop the
run when they fail. Native Chromium staging is optional: a missing toolchain, failed checkout, or
failed runtime verification is shown as a warning and the installer continues with Electron.
The steps after a fatal failure are shown as skipped. Firefox and Android are
not part of this pass, so their unavailable runtimes do not make a Chromium installation fail. A
failed required step (project dependencies or the build)
makes the result **failed**, and the page names the step. A failed optional step gives
**completed with warnings**, and the page names the step. The result is **completed** only when
every required step succeeds, the work process reports success with exit code 0, and the apps
pass the readiness check. The readiness check is not run after a required step has failed. A run
that ends without a result is a failure. The console installer (`-NoGui`) follows the same rule: a failed required step
prints the failure and exits 1, and a failed optional step only prints a warning. It never prints
the success line after a failed required step. The console command exits 0 for a completed run,
1 for a failure and 2 for a cancelled run. The window reports the same four outcomes.

## Cancel and retry

- **Cancel** during the installation asks first. While it stops, the window shows *Stopping
  installation... (Background processes may complete).* The work process and everything it
  started (winget, npm and the installers they launch) are ended with `taskkill /T /F`. Steps
  that already finished stay installed. Nothing is reported as finished.
- **Retry** runs every step that did not finish successfully, with the same settings. Finished
  steps are not repeated.
- Closing the window during an installation asks the same question.
- A dependency install that was stopped leaves no install record, so the next start reinstalls
  the packages (see `docs/dependencies.md`).

## Logs

Every run writes to `scripts-YYYYMMDD.log` in the data folder, or in `%TEMP%` when no data
folder is configured. Tokens, passwords and user names in URLs are masked. The window shows the
same lines live, and *Open log file* opens the file.

## How it is built

- `scripts\lib\octo.ps1`: the steps (`Get-SetupSteps`), the console installer, and the work
  process `wizard-run` (`Invoke-WizardRun`). The work process applies the window's choices and
  prints one marker per step: `@@OCTO@@<TAB>step<TAB>start|done|warn|fail|skip<TAB>key...`, then
  `@@OCTO@@<TAB>result<TAB>ok|failed<TAB>key`: the key of the first required step that failed
  (or `ready` when the apps are not ready), and `-` on success.
- `scripts\lib\octo-ui.ps1`: the window. It starts the work process with the `OCTO_SETUP_*`
  variables, reads its output on a timer, and never runs an install step itself.

## Tests

| Where | What | Runs in |
|---|---|---|
| `packages/core/test/installer-wizard.test.ts` | Protocol, success rule, the fatal first step and the required steps, cancellation, options, labels and tooltip, message keys in English and Polish, no hard-coded example text | `npm test` |
| `packages/shell/test/ps-scripts.test.ts` | Window structure, console fallback, hidden console, brace balance | `npm test` |
| `scripts/tests/octo-wizard.Tests.ps1` | Helper functions: proxy address, step result, markers, flags, time left | Pester on Windows (`npm run test:scripts`) |

The runtime staging commands use official Google/Mozilla URLs and pinned checksums, with fallback to the official Google storage or Mozilla CDN mirror; Windows Firefox extraction requires Windows Installer. The launcher also includes winter, spring, summer, autumn, and Valentine seasonal themes with lightweight CSS particle/glow animation that is disabled for reduced-motion and VM mode. The PowerShell itself was checked with a syntax parser (tree-sitter PowerShell grammar) and the
message-key check; the window was not run in an environment with a desktop.

## Checks to run on Windows before a release

1. Fresh clone, no `node_modules`: run `scripts\install.bat`. The window opens, the seven steps
   run, the result says completed, and `npm run dev` starts the app.
2. Wrong folder: type a path that cannot be written. *Next* refuses it and says why.
3. Proxy: enter `user:pw@host:80`. *Next* refuses it. A valid `host:port` is used by `npm`.
4. Cancel during *Project dependencies*: the window shows *Stopping installation...*, the process
   tree ends, the result says stopped, and *Retry* completes the install.
5. Make *Node.js and git* fail (for example, disconnect the network): the run stops there, the
   steps after it are shown as skipped, the result is failed, and no success message appears.
   Reconnect and *Retry*.
6. Make a required step fail after the first one (for example, block the Electron download so
   that *Project dependencies* fails): later steps are skipped, the result is failed, the page
   names the step, and no success message appears. Reconnect and *Retry*.
7. Make the optional shortcut step fail: the result is completed with warnings, and the page
   names the skipped/failed optional step. The app remains usable from `scripts\open.bat`.
8. Tick *Use system environment variables* and *Add Android SDK tools to user PATH (recommended)*,
   run the installer, and check `ANDROID_HOME` and the user PATH in a new terminal. Untick them,
   run again, and check that nothing was added.
9. Hover over *VirtualBox / VM compatibility mode*: the tooltip says it applies only to OctoSuite
   launches. Tick it, check that `%APPDATA%\OctoSuite\install-defaults.json` has
   `"vmCompatibility": true`, and start the app from the desktop shortcut.
10. Run with `scripts\install.bat -NoGui`: the console installer runs as before.
11. Check that the window's text is in the chosen language, both `en` and `pl`.
