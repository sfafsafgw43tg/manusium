# Native browser runtime migration note

## Chromium runtime catalog milestone

The application now has a catalog-backed Chromium runtime manager. Chrome for Testing Stable **155.0.8059.39** is the default supported runtime, with Beta **156.0.8078.12** as an optional supported choice. The older 140.0.7339.207 build is marked retired and compatibility-only; it cannot be installed as a new runtime.

The catalog records exact version, channel, platform, source URL, archive checksum, support state, executable name, CDP protocol, and capabilities. It is validated at startup and has regression coverage for unsupported/unpinned/corrupt entries.

The profile editor now shows the platform's catalog entries, install status, channel and support state. Install downloads to a temporary directory, verifies the pinned checksum, rejects traversal paths, validates the executable, writes the versioned manifest and notice, and atomically installs the result. Removal is refused if a version is selected by any profile or used by a running native Chromium session. The profile stores the exact selected runtime version and native launch resolves that exact version through the existing manifest/checksum contract.

## Verification status

Linux x64 was verified with the real pinned Stable Chromium runtime: navigation, tabs, crash shutdown, and cleanup passed. The Firefox Base now has a pinned Mozilla Firefox 140.0 Linux x64 installer path: it verifies the official SHA-512 archive digest, extracts safely, writes a runtime manifest and notice, and atomically installs the runtime under the user's engine directory. A Firefox launch uses that verified runtime when available, opens the configured start page, and tracks isolated profile lifecycle. The release workflow still stages Windows Chromium and runs the Windows packaged Chromium test on `windows-latest`; Windows visible launch is not proven by this Linux environment. Firefox was not directly launched before this stage because no system Firefox existed; the new packaged Gecko smoke test is the direct verification path.

## Electron boundary

Electron still owns the launcher/profile-management window, existing browser chrome and `WebContentsView` windows, address bar/tab-strip rendering for legacy Electron profiles, permissions/download/popup routing for those profiles, secure storage integration, much of window lifecycle, and the remaining Electron profile runtime. Native Chromium profiles use the external packaged CDP controller. Firefox Base profiles use an external verified Gecko desktop window with isolated data and remote-debugging readiness, but not an equivalent Chromium CDP tab-control dialog. This catalog work does not remove Electron or claim a complete native-browser migration.

## Password manager boundary

The application-owned encrypted password store, smart login-field classifier, trusted-submit save/update prompt, origin/profile matching, and autofill overlay are implemented and tested for the Electron `WebContentsView` path. Native Chromium and Firefox windows currently do not receive the Electron preload bridge or the in-app save-card overlay; their packaged smoke tests verify engine launch, navigation, tab control, privacy preferences, and shutdown, not app-owned password autofill. Native profiles must not be described as having equivalent Octo password-manager behavior until a native CDP/BiDi credential bridge and an external-window prompt path are implemented and directly tested.

## Compatibility policy

Runtime removal is blocked while selected or running. Existing profile data is not silently migrated between versions. The next hardening stage is an explicit per-version profile-data schema marker and migration/rollback snapshot flow; until then, the app preserves the existing profile directory and blocks unsafe removal rather than silently downgrading data.

See `docs/chromium-runtime-catalog.md` and `docs/engine-runtimes.md` for source, checksums, licensing, update cadence, platform support, troubleshooting, and release requirements.
