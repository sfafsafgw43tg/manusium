# InkBrowser status audit — 2026-10-10

This report is based on the current branch and current source, not on a previous summary.

## Verified launch contract

`apps/octobrowser/src/main/manager.ts` selects the `inkbrowser` engine, discovers a versioned runtime with `discoverEngineRuntime('chromium', ...)`, prepares the isolated profile directory, writes supported Chromium Preferences, allocates a loopback CDP port, launches with `spawnNativeEngine('chromium', ...)`, connects `NativeChromiumTabs`, restores up to 50 HTTP(S) session URLs, and saves tab state during normal stop. Process exit removes the native profile entry and closes the tab controller. The app remains Electron-based for the manager UI and orchestration.

## Runtime validation findings

- `packages/shell/src/engine-runtime.ts` now requires a manifest and executable inside the version directory.
- Executable names are `inkbrowser-chrome.exe` on Windows and `inkbrowser-chrome` on Linux.
- Executable SHA-256 is now mandatory and is compared before launch.
- Windows Chromium now requires `distribution: "source-built"` and `modified: true`.
- A missing or invalid runtime returns an error; it does not fall back to Chrome, Firefox, or Electron.
- Linux remains allowed to use the existing catalog/archive staging path. That path is still Chrome for Testing-derived and is not a source-built Chromium runtime.

## Native controls actually applied

| Setting | Standalone Chromium status |
|---|---|
| WebRTC non-proxied UDP protection | Applied through Preferences and `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` |
| Geolocation blocking | Applied through `Preferences.profile.default_content_setting_values.geolocation=2` |
| WebGL disabling | Applied through `--disable-webgl` |
| Canvas, WebGL vendor/renderer, Audio, Fonts, DOMRect, navigator identity, screen identity, timezone, hardware identity, device identity | Not applied to standalone Chromium |

The Electron page shim is not counted as native Chromium enforcement.

## New configuration milestone

`packages/core/src/chromium-config.ts` defines and validates `NativeChromiumConfig`, containing:

- User-Agent;
- UA-CH brands, versions, platform, architecture, model, and mobile flag;
- platform;
- languages;
- timezone;
- device metrics and scale factor;
- hardware concurrency;
- touch capability.

It is persisted as `Profile.nativeChromium` and normalized on profile load. This milestone is a safe data contract only. It is **not** passed to Chromium yet, because doing so without source-level enforcement could create contradictory page-visible values.

## Branding and icon locations

- `branding/inkbrowser-chrome/logo.svg`
- `branding/inkbrowser-chrome/icon.ico`
- `branding/inkbrowser-chrome/png/icon-*.png`
- `tools/inkbrowser/source/BRANDING`
- `tools/build-icons.mjs`
- `tools/build-chromium-source.mjs`

The source-build stage now copies `inkbrowser-chrome.ico` beside the executable and can embed it plus the `InkBrowser` product name when invoked with a Windows `rcedit` executable via `--rcedit <path>`. The Chromium source overlay identifies the product as InkBrowser.

## Runtime storage locations

In a packaged build:

```text
resources/engines/chromium/<version>/inkbrowser-chrome.exe
resources/engines/chromium/<version>/runtime.json
```

Per profile, the native Chromium data is under the app data layout's:

```text
profiles/<profile-id>/engine/inkbrowser-profile/
```

Profile metadata, including the validated configuration object, is stored in:

```text
config/profiles.json
```

## Runtime availability in this sandbox

`windows/resources/engines/` contains only its README; no Chromium or Gecko runtime binary is staged here. The Windows source-build workflow has not been run because this is a Linux sandbox and the workflow intentionally refuses non-Windows execution.

The real Chromium integration test in the suite launches a real local Chromium process for CDP coverage, but it is not proof of the packaged source-built Windows runtime.

## Validation run

From `windows/`:

```text
npm run typecheck
# passed

npx vitest run packages/core/test/chromium-config.test.ts packages/shell/test/engine-runtime.test.ts packages/shell/test/engine-privacy.test.ts
# 3 files, 13 tests passed

npm test -- --run
# 89 files, 895 tests passed, 1 skipped

npm run build
# octobrowser and octodetect builds passed
```

Not verified here:

- Windows Chromium source checkout/build;
- Windows executable launch;
- Windows packaged tab/session/privacy probes;
- embedded PE icon rendering;
- native enforcement of the new identity/metrics configuration.
