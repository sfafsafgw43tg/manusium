# tools/inkbrowser

Build-machine support files for InkBrowser, the native Chromium browser described in
[docs/inkbrowser/BLUEPRINT.md](../../docs/inkbrowser/BLUEPRINT.md). This folder does not
build Chromium, and nothing in it ships with the browser.

| File | Purpose |
|---|---|
| `gn/release.gn` | GN arguments for the Windows x64 release build. Each argument is sourced in the file header. `enable_widevine = false`. |
| `layout-manifest.json` | The expected tree: the launcher name, the required runtime files, the forbidden Electron and Google-service files, and `excludedComponents` (WidevineCdm, MEIPreload, PrivacySandboxAttestationsPreloaded). |
| `verify-layout.mjs` | Checks an unpacked tree or an unzipped portable zip against the manifest. |
| `stage.mjs` | Turns a Chromium build output into the two-level layout: renames `chrome.exe` to `Application\inkbrowser-chrome.exe`, moves the runtime into `Application\<version>\`, leaves out the excluded components and build products, embeds the icon, and runs the verifier. |
| `../../branding/inkbrowser/` | The logo, the purple icon set, and `icon.ico`, which `stage.mjs` embeds. Built with `node tools/build-icons.mjs inkbrowser`. |

## Stage a build (Windows build machine)

```
node tools/inkbrowser/stage.mjs --from <out>\Release --to <new folder> --chromium 154.0.8037.97 --product 1.0.0.0 --rcedit <rcedit-x64.exe>
# exit 0 valid, 1 layout failure, 2 usage or I/O error
```

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

The kit is complete and tested. The `inkbrowser-chrome.exe` binary is not built, because Chromium
cannot be fetched or compiled in the current environment (see BLUEPRINT.md, section 13).
OctoBrowser does not bundle or download the base. It starts an installed base from
`%LOCALAPPDATA%\InkBrowser\Application\inkbrowser-chrome.exe`.
