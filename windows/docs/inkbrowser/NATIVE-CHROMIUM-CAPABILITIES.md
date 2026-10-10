# Native Chromium capability matrix

This document describes the standalone Chromium process launched for `inkbrowser` profiles. It does not describe the Electron renderer or its page shim.

## Current capability matrix

| Setting | UI control | Persistence path | Native implementation | Runtime test |
| --- | --- | --- | --- | --- |
| WebRTC non-proxied UDP protection | Advanced → Engine-native privacy → WebRTC network exposure → Disable non-proxied UDP | `Profile.enginePrivacy.chromium.webRtc`, persisted by the profile store | `Preferences.webrtc.ip_handling_policy=disable_non_proxied_udp` plus Chromium launch switch `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` | `packages/shell/test/engine-privacy.test.ts`; Windows packaged probe must verify ICE candidates do not expose a non-proxied UDP route |
| Geolocation permission blocking | Advanced → Engine-native privacy → Location permission → Block websites | `Profile.enginePrivacy.chromium.location`, persisted by the profile store | `Preferences.profile.default_content_setting_values.geolocation=2` before launch | `packages/shell/test/engine-privacy.test.ts`; Windows packaged probe must request geolocation and verify the permission is denied |
| WebGL disabling | Advanced → Engine-native privacy → WebGL exposure → Disable WebGL | `Profile.enginePrivacy.chromium.webgl`, persisted by the profile store | Chromium launch switch `--disable-webgl`; this disables WebGL and does not impersonate a GPU | `packages/shell/test/engine-privacy.test.ts`; Windows packaged probe must verify WebGL and WebGL2 contexts cannot be created |
| Canvas noise / canvas identity | Advanced fingerprint editor | `Profile.fingerprint.canvas` | **Not available in native Chromium.** Stored for profile compatibility only; no standalone Chromium code consumes it. | No native runtime test; the UI labels it unavailable |
| WebGL vendor/renderer spoofing | Advanced fingerprint editor | `Profile.fingerprint.webgl` and `webglInfo` | **Not available in native Chromium.** `--disable-webgl` is the only supported native WebGL privacy action. | No native runtime test; the UI labels it unavailable |
| Audio fingerprint changes | Advanced fingerprint editor | `Profile.fingerprint.audio` | **Not available in native Chromium.** | No native runtime test; the UI labels it unavailable |
| Font-list changes | Advanced fingerprint editor | `Profile.fingerprint.fonts` and `fontList` | **Not available in native Chromium.** | No native runtime test; the UI labels it unavailable |
| DOMRect/SVG/client-rect changes | Advanced fingerprint editor | `Profile.fingerprint.clientRects` | **Not available in native Chromium.** | No native runtime test; the UI labels it unavailable |
| User-Agent, Client Hints, screen, timezone, hardware and device identity overrides | Advanced fingerprint editor | Corresponding `Profile.fingerprint` fields | **Not available in native Chromium.** They are not silently forwarded to the standalone process. | No native runtime test; the UI labels them unavailable |
| Validated native Chromium configuration object | Profile metadata | `Profile.nativeChromium`, normalized by `sanitizeNativeChromiumConfig()` | **Validated and persisted only in this milestone.** It is not passed to stock Chromium yet, so it does not change page-visible values. | `packages/core/test/chromium-config.test.ts` |

The three supported controls are deliberately separate from the fingerprint draft editor. A saved fingerprint draft does not make native Chromium spoof those values.

## Native launch path

1. The profile editor persists `enginePrivacy.chromium` through the profile store.
2. `apps/octobrowser/src/main/manager.ts` discovers the trusted packaged runtime.
3. `prepareChromiumPrivacy()` writes the Chromium `Preferences` file before launch.
4. `chromiumPrivacyArgs()` converts supported settings into explicit Chromium switches.
5. `spawnNativeEngine('chromium', ...)` launches `inkbrowser-chrome.exe` with the isolated profile directory and loopback-only CDP endpoint.

## Windows packaged-runtime test plan

Run these commands from `windows/` on a Windows build machine after producing the source-built runtime:

```powershell
npm ci
npm run typecheck
npm test -- --run
npm run build
npm run stage:chromium:windows
npm run test:native-packaged:windows
```

The packaged test must use the runtime discovered from the versioned `runtime.json` manifest. It must not substitute `/usr/bin/chromium`, an installed Chrome, or an Electron renderer.

The Windows probe should create three fresh isolated profiles and verify:

- WebRTC protection: the page can create a peer connection, but no candidate exposes a non-proxied UDP route when the protection is enabled.
- Geolocation blocking: `navigator.geolocation.getCurrentPosition()` is denied without an allow prompt when blocking is enabled.
- WebGL disabling: `canvas.getContext('webgl')` and `canvas.getContext('webgl2')` return `null` when disabled.
- Reset behavior: default settings do not receive the protection switches.
- Isolation: changing one profile does not change another profile's `Preferences` or launch arguments.
- Lifecycle: the process launches, navigates, closes cleanly, and reports a missing or invalid manifest without falling back to another engine.

Until those commands are run on Windows with a real source-built `inkbrowser-chrome.exe`, Windows native-runtime behavior remains unverified in this environment.

## Files and storage locations

- Source-build orchestrator: `tools/build-chromium-source.mjs`
- Chromium branding overlay: `tools/inkbrowser/source/BRANDING`
- Purple Chromium icon sources: `branding/inkbrowser-chrome/logo.svg` and `branding/inkbrowser-chrome/icon.ico`
- Staged Windows runtime: `resources/engines/chromium/<version>/inkbrowser-chrome.exe`
- Runtime manifest and executable hash: `resources/engines/chromium/<version>/runtime.json`
- Per-profile native Chromium data at runtime: the app data layout's `profiles/<profile-id>/engine/inkbrowser-profile/`
- Persisted profile metadata, including `nativeChromium`: the app data layout's `config/profiles.json`

The native configuration object is intentionally not described as active fingerprint spoofing. Stock Chromium does not consume these fields without source-level enforcement, and the launcher continues to expose only the three tested native controls above.
