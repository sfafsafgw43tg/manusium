# OctoSuite platform parity contract for future AI work

This repository must be maintained for **Windows x64 and Linux x64 together**. Linux is not a secondary mock target: it is the directly testable reference platform in the sandbox, while Windows packaging and runtime contracts must remain intact.

## Required rule for every future change

Before changing a platform-sensitive feature:

1. inspect both branches (`process.platform === 'win32'` and Linux/POSIX behavior);
2. keep paths through `node:path`, never hard-code separators or `.exe` names;
3. keep the two runtime contracts separate but equivalent: Chromium/CDP and Firefox/BiDi;
4. update both packaging targets and both installer/staging paths;
5. add or update Linux tests and Windows contract tests;
6. run Linux validation here and report Windows limitations honestly when Windows is not available;
7. update `docs/engine-runtimes.md` and this contract if support changes.

Do not claim Windows runtime execution from Linux results. Do not silently fall back from a missing selected engine to another engine.

## Supported deliverables

| Platform | Development | Native runtimes | Packaged deliverables | Directly testable here |
|---|---|---|---|---|
| Linux x64 / Debian | `scripts/install-linux.sh`, `scripts/run-linux.sh` | Chromium 155.0.8059.39, Firefox 140.0 | portable directory, AppImage, `.deb` | Yes |
| Windows x64 | `scripts/install.bat`, existing PowerShell flow | Chromium 155.0.8059.39, Firefox 140.0 | portable directory, ZIP, signed installer flow | No: requires Windows/CI |

## Linux commands

```bash
scripts/install-linux.sh
npm run start:browser
npm run dist:linux
npm test
npm run typecheck
npm run i18n:check
npm run test:native-packaged
npm run test:native-firefox-packaged
```

`npm run dist:linux` stages and checksum-verifies the pinned Linux Chromium and Firefox runtimes, builds the application, and asks electron-builder for a portable directory, AppImage, and Debian package. The resulting files are under `release/octobrowser`.

## Windows commands

```text
scripts\install.bat
npm run dist:browser
npm run test:native-packaged:windows
```

Windows staging uses the explicit Windows archives and executable contracts (`inkbrowser-chrome.exe` and `inkbrowser-firefox.exe`). Do not reuse Linux binaries in a Windows package.

## Security and parity boundaries

- Native browser control endpoints bind to loopback only.
- Profile data is isolated by profile and uses restrictive POSIX permissions where supported.
- Runtime archives are pinned and checksum-verified before staging.
- App window mode is Chromium `--app` on native Chromium, Firefox `--kiosk` on native Firefox, and reduced trusted chrome in the Electron compatibility shell.
- Smart paste operates only on explicit address-bar paste events; it does not monitor the clipboard.
- Linux AppImage/Debian packaging does not make the application anonymous or immune to host malware.
- Electron remains a compatibility/runtime responsibility where native replacement is not yet complete.
