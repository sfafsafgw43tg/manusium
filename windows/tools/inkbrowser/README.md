# tools/inkbrowser

Build-machine support files for InkBrowser, the native Chromium browser described in
[docs/inkbrowser/BLUEPRINT.md](../../docs/inkbrowser/BLUEPRINT.md). This folder does not
ship build tools or source with the browser. The Windows build orchestrator is
`../build-chromium-source.mjs`.

| File | Purpose |
|---|---|
| `gn/release.gn` | GN arguments for the Windows x64 release build. Each argument is sourced in the file header. `enable_widevine = false`. |
| `source/BRANDING` | Project-owned branding overlay copied into the checked-out Chromium source before compilation. |
| `layout-manifest.json` | The expected tree: the launcher name, the required runtime files, the forbidden Electron and Google-service files, and `excludedComponents` (WidevineCdm, MEIPreload, PrivacySandboxAttestationsPreloaded). |
| `verify-layout.mjs` | Checks an unpacked tree or an unzipped portable zip against the manifest. |
| `stage.mjs` | Turns a Chromium build output into the two-level layout: renames `chrome.exe` to `Application\inkbrowser-chrome.exe`, moves the runtime into `Application\<version>\`, leaves out the excluded components and build products, embeds the icon, and runs the verifier. |
| `../../branding/inkbrowser/` | The logo, the purple icon set, and `icon.ico`, which `stage.mjs` embeds. Built with `node tools/build-icons.mjs inkbrowser`. |

## Stage a build (Windows build machine)

The normal Windows package path is a **source build**, not Chrome for Testing:

```
npm run build:chromium:windows
# Optional overrides:
node tools/build-chromium-source.mjs --source C:\src\chromium\src --out resources\engines\chromium\155.0.8059.39
# exit 0 valid, 1 layout failure, 2 usage or I/O error
```

The command requires a Windows x64 build machine with Visual Studio 2022, Python,
and depot_tools (`fetch`, `gclient`, `gn`, and `autoninja`) on `PATH`. It checks out
the pinned Chromium tag, applies `source/BRANDING`, runs `gclient sync` and hooks,
generates GN files from `gn/release.gn`, builds the `chrome` target, and writes the
source-built result to `windows/resources/engines/chromium/155.0.8059.39/`.
The resulting `runtime.json` records the Chromium revision, overlay hash, GN args
hash, and `distribution: source-built`. A Chrome for Testing archive or a renamed
vendor executable is rejected by Windows discovery and verification.

The destination must be empty or new. Without `--rcedit` the stage still runs, and it
warns that the icon was not embedded.

## Check a tree

```
node tools/inkbrowser/verify-layout.mjs <dir>          # exit 0 valid, 1 invalid, 2 usage or I/O error
node tools/inkbrowser/verify-layout.mjs <dir> --json   # the same result as JSON
```

The verifier accepts the two-level layout of image-4 (`Application\` for the launcher and
`Application\<version>\` for the runtime) and the flat portable layout. It rejects
`electron.exe`, `node.dll`, `*.asar`, `package.json`, `package-lock.json`, and any of the
three excluded components.

## Tests

```
npx vitest run packages/core/test/inkbrowser-layout.test.ts packages/core/test/inkbrowser-stage.test.ts packages/core/test/inkbrowser-engine.test.ts apps/octobrowser/test/inkbrowser-main.test.ts
```

They cover the verifier, the manifest, the GN arguments, the blueprint's opening section,
the staging script on a fixture build output, the launch rules, and the app's install lookup.

## Status

The workflow and verification are implemented, but the actual Windows Chromium
checkout/build must be run on Windows. This Linux sandbox cannot produce or claim
the final Windows binary. The Electron UI build remains separate and is still
written to `apps/octobrowser/dist/`.
