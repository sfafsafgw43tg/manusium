# InkBrowser blueprint: image check (read first)

- **image-1: CORRECT.** This is the native Chromium unpacked tree, and InkBrowser must produce this shape. The launcher sits in `Application\` (GinsBrowser's `ginsbrowser.exe` in the picture; InkBrowser's launcher is `inkbrowser-chrome.exe`), beside `chrome_proxy.exe` and the Visual Elements manifest. The runtime (DLLs, PAK resource packs, ICU data, locales) sits in a versioned folder, `Application\142.0.7444.273\`, beside the installer's `<version>.manifest`. The picture shows no Node, package, or ASAR files.
- **image-2: INCORRECT.** This is an Electron distribution. Its root holds `electron.exe`, a `resources\` folder (Electron's place for the application bundle, `*.asar`), and a `version` file. Electron embeds Node.js and runs application JavaScript, so it is a JavaScript runtime wrapper around Chromium. InkBrowser must contain none of it, in any form.
- **This round's numbering.** The same two shapes came back as image-3 and image-4. **image-4: CORRECT** is the native Chromium tree (`ginsbrowser.exe` in `Application\`, beside `chrome_proxy.exe`). **image-3: INCORRECT** is the Electron dist (`electron.exe`, a `resources\` folder, and a `version` file). The earlier image-1 and image-2 are the same two shapes, so their verdicts carry over.

The two images share Chromium runtime files (ffmpeg.dll, PAK packs, ICU data, ANGLE and Vulkan libraries), so those files do not tell them apart. The launcher and the packaging do. Electron is itself built on Chromium, so "is Chromium-based" is not the test. The test is whether the product is a native Chromium build with no JavaScript runtime. `tools/inkbrowser/verify-layout.mjs` enforces that test.

Status: this is a plan, not a build. Chromium cannot be built in this sandbox (section 13).

## 1. Scope

**In scope.** A native Windows x64 browser built from the Chromium source tree:

- `chrome/`: the browser layer (profiles, tabs, sessions, settings, branding).
- Views UI in `chrome/browser/ui/views/` (frame, tab strip, toolbar). The browser chrome is C++ Views, not a web page.
- Content API in `content/`, and Blink in `third_party/blink/` (rendering and DOM), with V8 in `v8/`.
- Mojo IPC in `mojo/` between the browser, renderer, and GPU processes.
- GN and Ninja, run from a depot_tools checkout.

**Forbidden.** Electron in any form (any version, any fork, Electron Forge or Electron Builder output); Node.js or npm at runtime; ASAR archives; `electron.exe`; NW.js; Neutralino; Tauri with a JavaScript runtime; any other wrapper that runs application JavaScript outside the browser's own renderer processes.

**Not done in this sandbox.** No Chromium build. chromium.googlesource.com is not on the sandbox allowlist, and a full checkout plus build needs far more disk and CPU time than this sandbox has. Plan for well over 100 GB of disk and hours of compute on a many-core Windows machine, and measure on the target. This document therefore ships a verifier, a layout manifest, GN arguments, and tests, not binaries.

## 2. Scope decisions for review

Each item is a choice made to finish the blueprint. Please confirm or change it.

1. **Layout.** The request's section 5 shows a flat tree. Image-1 is two-level, and the request says the output must match image-1. So the two-level layout is primary, and the flat tree is kept as the portable alternative. The verifier accepts both. The two-level shape follows from the launcher: the comments in `chrome/app/chrome_exe_main_win.cc` describe `MainDllLoader` switching to "the browser's version directory".
2. **Visual Elements manifest name.** The request says `chrome_visual_elements_manifest.xml`. That is wrong. The installer writes `chrome.VisualElementsManifest.xml`, from the constant `kVisualElementsManifest` in `chrome/installer/setup/setup_constants.cc`. The name is fixed in the installer and is not derived from the launcher name, so renaming the launcher does not rename it. v1 keeps the upstream name.
3. **Internal file names stay upstream in v1.** Only the launcher becomes `inkbrowser-chrome.exe`. `chrome.dll`, `chrome_elf.dll`, `chrome_proxy.exe`, the PAK packs, and the rest keep their names, because image-1 (the required shape) uses them. Explorer shows these names, and renaming them is a deeper multi-file change. Confirm.
4. **Chromium base version.** Each release pins one stable milestone. As of 2026-10-08, Chrome 154 is stable (154.0.8037.97 is the base of ungoogled-chromium at commit 3e46b13, dated 2026-10-03), and Chrome 155 has started its early stable release. Chromium now ships a new milestone every two weeks, so plan a rebase every two weeks, or accept a longer gap before security patches land.
5. **MV2 is not promised.** Google's timeline says MV2 extensions were disabled everywhere with Chrome 138 (July 24, 2025) and cannot be turned back on. The Chrome Web Store removed the remaining MV2 extensions on August 31, 2026. InkBrowser therefore ships MV3 extensions only, plus native content blocking (section 10). uBlock Origin (MV2) is not promised. ungoogled-chromium carries an `extensions-manifestv2.patch`. Whether that still gives working MV2 at our pinned milestone is not verified, so the plan does not rely on it.
6. **Privacy stance.** Standard hardening only: Chromium's own protections and the defaults in section 11. No per-profile identity or fingerprint spoofing, and no tooling for evading account bans or linking. This is a scope decision, not a technical limit.
7. **User-agent token.** Chromium hard-codes the `Chrome/<version>` token in `components/version_info/version_info_with_user_agent.cc`, and sites depend on it. InkBrowser keeps it and appends `InkBrowser/<X.X.X.X>`. It does not claim to be Firefox, Safari, or any other engine. The string `Chrome/` therefore remains inside the UA. Confirm that this is acceptable under the "no Chrome strings visible" rule.
8. **Google services off by default.** Empty Google API keys, reporting and remoting off, and `safe_browsing_mode = 0` (section 7). The trade-off: no Google Safe Browsing warnings. Phishing and malware protection needs its own decision (opt-in, or another provider).
9. **Widevine is off.** The request lists WidevineCdm, MEIPreload, and PrivacySandboxAttestationsPreloaded as components to remove. Widevine is one of them, so this overrides the earlier Widevine-on decision: `enable_widevine = false` in `tools/inkbrowser/gn/release.gn`. Decision 14 covers the other two. To flip Widevine back on, set `enable_widevine = true` and remove `WidevineCdm` from `excludedComponents` in `layout-manifest.json`. Confirm which reading was intended.
10. **Portable profile.** The profile lives next to the program. ungoogled-chromium gets this with `--disable-encryption` and `--disable-machine-id`, which stop cookies and passwords from being protected by the Windows key. InkBrowser keeps OS encryption on and changes only the default location (section 5). A portable profile then works only for the same Windows user on the same PC.
11. **depot_tools.** The request asks for GN and depot_tools. The ungoogled-chromium-windows README tells builders not to set up depot_tools, because its own download process avoids Google's prebuilt tools. This blueprint follows the request. Section 4, step 4, lists what the sync hooks download so each download can be audited.
12. **Trademark and credits.** No Google Chrome name or logo. The upstream BSD-3-Clause notices stay in the credits and license files. They are legal notices, not product UI text.
13. **Build-machine tooling.** The verifier is a Node.js script that runs on the build machine only. Nothing in the shipped tree depends on Node. If Node is unwanted on build machines, port the verifier to PowerShell; the manifest does not change.
14. **Excluded components.** Packaging removes WidevineCdm, MEIPreload, and PrivacySandboxAttestationsPreloaded. `layout-manifest.json` lists them under `excludedComponents`, `stage.mjs` leaves them out of the staged tree, and `verify-layout.mjs` rejects a tree that contains one. Only `enable_widevine` is set in GN. The GN names for the other two have not been verified against the pinned tag, so they are not set rather than guessed.
15. **Engine per profile.** Electron is the default for new profiles. InkBrowser is chosen per profile. A profile that uses a setting InkBrowser cannot apply (fingerprint spoofing, a protection level other than Normal or any protection override, a proxy or non-system network mode, DNS over HTTPS, a sandbox mode, Windows isolation, the kill switch, or a Firefox identity) is refused at launch, not run without the setting. Electron stays the default because the default profile uses spoofing and the Standard preset.

## 3. Architecture

```
inkbrowser-chrome.exe                  launcher stub (chrome/app, the Windows entry point)
  └─ <version>\chrome.dll       browser process: the chrome/ layer
       ├─ chrome/browser/ui/views/   native Views UI: frame, tab strip, toolbars
       ├─ content/                   Content API: WebContents, navigation, process model
       ├─ components/                privacy, DNS, settings, content-blocking hooks
       └─ mojo/                      Mojo IPC to the processes below
renderer processes             Blink (third_party/blink/) and V8 (v8/), sandboxed
GPU process                    Skia and cc/viz compositing; ANGLE (libEGL, libGLESv2) on Direct3D 11
```

The browser UI is C++ Views. There is no JavaScript runtime outside the sandboxed renderer processes. WebUI pages (settings, the speed dial) are HTML that runs in renderer processes like any web page, with no extra runtime.

## 4. Toolchain and source

1. **Windows and tools.** Windows 10 x64 or later. Visual Studio 2022 with the "Desktop development with C++" workload and a Windows 10 or 11 SDK. Python 3.11 or later, as the ungoogled-chromium-windows README requires. Check the pinned milestone's Windows build instructions for the exact Visual Studio requirement.
2. **depot_tools.** Clone `https://chromium.googlesource.com/chromium/tools/depot_tools.git` and put it on `PATH`. Set `DEPOT_TOOLS_WIN_TOOLCHAIN=0` so depot_tools uses the local Visual Studio. ungoogled-chromium-windows `build.py` sets the same variable.
3. **Source at the pinned milestone.** `fetch --nohooks inkbrowser-chrome`, check out the Chromium release tag `154.0.8037.97` in `src` (confirm that the tag exists and matches `chromium_version.txt`), then `gclient sync --with-branch-heads --with-tags`. This is the standard depot_tools sequence and was not re-run here.
4. **Prebuilt tools.** Record what `gclient runhooks` downloads (clang, Rust, and other toolchain binaries), and review each download's source before the first build.
5. **Base layer.** Apply the ungoogled-chromium base: `pruning.list`, `domain_substitution.list` with `domain_regex.list`, and its patch series, at the revision that matches the pinned milestone. The revision checked on 2026-10-08 is commit `3e46b13` (2026-10-03, base 154.0.8037.97). The base is BSD-3-Clause, so keep its LICENSE in the source tree. Pin the commit in this repository before the first build.
6. **Alternative.** Start from clean Chromium and write every privacy patch ourselves. That is slower and gives more control. Step 5 is recommended for v1, with every patch reviewed.

## 5. Source changes (InkBrowser patch set)

Locations marked "main" were checked in Chromium main on 2026-10-08. Re-check each one at the pinned tag.

| Area | Change | Where |
|---|---|---|
| Product name, company, copyright | Replace the BRANDING values (section 6) | `chrome/app/theme/chromium/BRANDING` (main). The `inkbrowser-chrome` folder is the default for non-branded builds (`build/config/chrome_build.gni`). |
| Product strings and About page | Replace the "Chromium" and "Chrome" product text | `chrome/app/chromium_strings.grd` (main). `IDS_PRODUCT_NAME` and `IDS_SHORT_PRODUCT_NAME` sit inside `<if expr="_is_chrome_for_testing_branded">` with an `<else>` branch, so both branches must change. Other `.grd` files hold more text; list them with a grep at the pinned tag. |
| Launcher name | `inkbrowser-chrome.exe` | `chrome/BUILD.gn` (main): `_chrome_output_name` is `initialexe/chrome` on Windows, and a later reorder step produces `chrome.exe`. The installer and the file list also name `chrome.exe`. This is a multi-file change. The ungoogled-chromium-windows patch `windows-disable-reorder-fix-linking.patch` shows the kind of edits involved. |
| Visual Elements manifest | Keep the upstream name in v1 (decision 2) | `chrome/installer/setup/setup_constants.cc` (main) |
| User-agent | Append `InkBrowser/<X.X.X.X>` | Next to the `Chrome/` token from `components/version_info/version_info_with_user_agent.cc` (main). Find the call site at the pinned tag. |
| Portable profile | Default profile folder beside the program, when a marker file exists | Both default-path functions must change together: `chrome/common/chrome_paths_win.cc` (`GetDefaultUserDataDirectory`, built from `%LOCALAPPDATA%`) and `chrome/install_static/user_data_dir.cc` (`GetDefaultUserDataDirectory`, which appends `User Data`). A `--user-data-dir` switch still overrides both; `GetUserDataDirectoryImpl` reads it. |
| Google services and telemetry | Off by default | GN arguments (section 7). Runtime patches to review from ungoogled-chromium `patches/core/ungoogled-chromium/`: `disable-gaia`, `disable-gcm`, `disable-domain-reliability`, `disable-network-time-tracker`, `disable-crash-reporter`, `disable-privacy-sandbox`, `disable-webstore-urls`, `disable-google-host-detection`, `disable-untraceable-urls`, `disable-mei-preload`, `disable-ai`, `block-requests`, `block-trk-and-subdomains`, `doh-changes`. Do not adopt `extensions-manifestv2.patch` (decision 5). |
| Speed dial new tab page | Local page with no Google-hosted content | Replace the new tab page content. ungoogled-chromium's `--custom-ntp` switch shows that the new tab page can be replaced (its `docs/flags.md`). |
| Vertical tabs | Use Chromium's feature | `chrome/browser/ui/tabs/features.h` defines `kVerticalTabs` (main). Check its default state at the pinned milestone. |
| Native content blocking | New component | A new directory under `components/`, hooked into URL loading. The hook name is to be confirmed at the pinned tag (section 13). |
| Defaults | HTTPS-only, secure DNS, third-party cookies, and the others in section 11 | Chromium preferences. Confirm the preference names at the pinned tag. |

## 6. Branding

The keys were verified against Chromium main's `chrome/app/theme/chromium/BRANDING` on 2026-10-08. The values are proposals.

```
COMPANY_FULLNAME=InkBrowser Project
COMPANY_SHORTNAME=InkBrowser Project
PRODUCT_FULLNAME=InkBrowser
PRODUCT_SHORTNAME=InkBrowser
PRODUCT_INSTALLER_FULLNAME=InkBrowser Installer
PRODUCT_INSTALLER_SHORTNAME=InkBrowser Installer
COPYRIGHT=Copyright @LASTCHANGE_YEAR@ InkBrowser contributors. All rights reserved.
MAC_BUNDLE_ID=org.inkbrowser.InkBrowser
MAC_CREATOR_CODE=Ink1
MAC_TEAM_ID=
```

- Keep the `@LASTCHANGE_YEAR@` placeholder; the build fills it in.
- The `MAC_*` keys matter only for a macOS build, which v1 does not include.
- Icons and logos: replace `chrome/app/theme/chromium/product_logo*.png`, `product_logo.svg`, and `product_logo.ai` with InkBrowser artwork. Do not use Google's Chrome logo or wordmark.
- Version resources: set ProductName, FileDescription, and CompanyName to InkBrowser. Find where the version resources are set at the pinned tag. The verification checklist reads them back.
- About page: show InkBrowser, the InkBrowser version, and the Chromium base version. Keep the upstream license notices on the credits page (decision 12).
- User-agent: `InkBrowser/<X.X.X.X>`, where X.X.X.X is the InkBrowser version (section 9).

## 7. GN arguments

The file is `tools/inkbrowser/gn/release.gn`. Its header comment gives the source of each group. Summary:

| Group | Arguments | Source |
|---|---|---|
| Build type | `is_official_build = true`, `is_debug = false`, `target_cpu = "x64"`, `is_clang = true`, `is_component_build = false`, `use_sysroot = false`, `enable_rust = true`, `enable_swiftshader = false`, `symbol_level = 0` (and the blink and V8 equivalents) | ungoogled-chromium-windows `flags.windows.gn` |
| Hardening and build | `v8_drumbrake_bounds_checks = true`, `exclude_unwind_tables = true`, `treat_warnings_as_errors = false`, `chrome_pgo_phase = 0` (first builds only; official PGO needs profile downloads and comes after a working build) | ungoogled-chromium `flags.gn` |
| Branding | `is_chrome_branded = false` | Chromium `build/config/chrome_build.gni` (default `false`) |
| Media | `proprietary_codecs = true`, `ffmpeg_branding = "Chrome"`, `enable_mse_mpeg2ts_stream_parser = true`, `enable_widevine = false` (overrides upstream, decision 9) | `flags.windows.gn`; `ffmpeg_branding` also appears in `chrome/browser/chrome_for_testing/args.gni` (main) |
| Google services | Empty API keys, `use_official_google_api_keys = false`, `safe_browsing_mode = 0`, `enable_reporting = false`, `enable_remoting = false`, `enable_mdns = false`, `enable_service_discovery = false`, `enable_hangout_services_extension = false` | ungoogled-chromium `flags.gn` |

`ffmpeg_branding = "Chrome"` selects the FFmpeg codec set. It is not a visible string. Keep it, or the proprietary codecs are not built.

Deliberately not set: `branding_path_component`. It defaults to `inkbrowser-chrome`, as declared in `build/config/chrome_build.gni`, because InkBrowser edits `chrome/app/theme/chromium/BRANDING` in place.

## 8. Build steps (Windows)

Run these from a shell with the Visual Studio developer environment. The paths are examples.

```bat
:: 0. Environment
set DEPOT_TOOLS_WIN_TOOLCHAIN=0
set PATH=C:\src\depot_tools;%PATH%
cd C:\src\inkbrowser\src

:: 1. Base layer: ungoogled-chromium at commit 3e46b13 (section 4, step 5)
python ..\ungoogled\utils\prune_binaries.py . ..\ungoogled\pruning.list
python ..\ungoogled\utils\patches.py apply . ..\ungoogled\patches
python ..\ungoogled\utils\domain_substitution.py apply -r ..\ungoogled\domain_regex.list -f ..\ungoogled\domain_substitution.list -c ..\domsubcache.tar.gz .

:: 2. InkBrowser patch series, including the branding changes in section 6
python ..\ungoogled\utils\patches.py apply . ..\inkbrowser\patches

:: 3. GN arguments
mkdir out\Default
copy ..\inkbrowser\tools\inkbrowser\gn\release.gn out\Default\args.gn

:: 4. Bootstrap GN, generate, and build
python tools\gn\bootstrap\bootstrap.py -o out\Default\gn.exe
out\Default\gn.exe gen out\Default --fail-on-unused-args
third_party\ninja\ninja.exe -C out\Default chrome chromedriver mini_installer

:: 5. Stage the portable tree (section 9), then verify it
node ..\inkbrowser\tools\inkbrowser\verify-layout.mjs ..\staging\InkBrowser
```

Notes:

- The ungoogled-chromium commands come from its `docs/building.md`. The GN bootstrap, `gn gen`, and Ninja commands come from ungoogled-chromium-windows `build.py`. The Ninja target list there is `chrome`, `chromedriver`, and `mini_installer`, and it has no separate `chrome_sandbox` target for Windows.
- `chromedriver` is an automation tool. Leave it out of the release tree.
- `mini_installer` is needed only for an installer. The portable zip does not use it.
- After the rename in section 5, the `chrome` target produces `inkbrowser-chrome.exe`.
- Stage the tree and check it: `node tools\inkbrowser\stage.mjs --from <out>\Release --to <new folder> --chromium 154.0.8037.97 --product 1.0.0.0 --rcedit <rcedit-x64.exe>`. It renames `chrome.exe` to `Application\inkbrowser-chrome.exe`, moves the runtime into `Application\<version>\`, leaves out the three excluded components and the build products (`.pdb .map .lib .exp .ilk .obj`), embeds `branding\inkbrowser\icon.ico` through rcedit, and runs `verify-layout.mjs` on the result. It refuses a destination that is not empty. Exit codes: 0 valid, 1 layout failure, 2 usage or I/O error.

## 9. Output layout and packaging

### 9.1 Primary: two-level layout (image-1)

```
InkBrowser\                                 portable root (the top folder of the zip)
  Application\
    inkbrowser-chrome.exe                          launcher (upstream name chrome.exe, renamed)
    chrome_proxy.exe                        optional
    chrome.VisualElementsManifest.xml       written by the installer (decision 2)
    154.0.8037.97\                          runtime, named after the Chromium base version
      chrome.dll
      chrome_elf.dll
      chrome_child.dll
      resources.pak
      chrome_100_percent.pak
      chrome_200_percent.pak
      icudtl.dat
      v8_context_snapshot.bin
      locales\*.pak
      optional DLLs, ANGLE, and Vulkan (see layout-manifest.json). The three excluded components (decision 14) are not part of the tree
      154.0.8037.97.manifest                optional, as in image-1
```

The runtime folder is named after the Chromium base version, as in image-1 (`142.0.7444.273`). The InkBrowser version appears in the zip name and in the User-Agent token.

### 9.2 Alternative: flat layout (section 5 of the request)

```
InkBrowser\
  inkbrowser-chrome.exe
  chrome.dll ...                            (the same runtime files, with no version folder)
```

Both shapes pass `verify-layout.mjs`.

### 9.3 Forbidden in both (enforced)

- `electron.exe`, `node.dll`, any `*.asar` anywhere, `package.json`, `package-lock.json`, and any `node_modules` folder.
- The upstream launcher names `chrome.exe` and `inkbrowser-chrome.exe`.
- The Google-service binaries listed in `layout-manifest.json`, such as `gaia1_0.dll` and `remoting_host.exe`. These should be absent because their GN features are off.

### 9.4 Zip

- Name: `InkBrowser-<version>-<platform>-x64-portable.zip`, for example `InkBrowser-1.0.0.0-windows-x64-portable.zip`. `<version>` is the InkBrowser version, in four parts to match the User-Agent token. `<platform>` is `windows`.
- Contents: the tree in 9.1, under an `InkBrowser\` top folder. No installer files (`mini_installer.exe`, `setup.exe`). The upstream packager excludes the same files (ungoogled-chromium-windows `package.py`).
- Build the zip from a sorted file list with fixed timestamps. The upstream packager passes a timestamp to `filescfg.create_archive` for the same purpose.
- No ASAR files anywhere.
- Record the SHA-256 of the zip next to it.
- Run `verify-layout.mjs` on the unzipped tree, not only on the staging folder.

### 9.5 Portable profile

With the marker file in place (section 5), the profile goes to `InkBrowser\Data\` rather than `%LOCALAPPDATA%`. The marker sits in the portable root, the folder that contains `Application\`. Finding it from the executable location must be checked at the pinned tag (`DIR_EXE` and `DIR_MODULE` behave differently in the launcher). Decision 10 covers the encryption trade-off.

## 10. Feature plan

The feature set is inspired by Dolphin Browser and GinsBrowser. No code, assets, or branding is taken from either.

| Feature | Approach | Phase | Note |
|---|---|---|---|
| Vertical tabs | Chromium's `kVerticalTabs` feature | 1 | Check the default state at the pinned milestone (section 5). |
| Tab groups | Chromium's native tab groups | 1 | No change expected. |
| Bottom toolbar | New layout option in `chrome/browser/ui/views/frame` | 2 | Settings-driven. |
| Gestures | Mouse and touch gesture recognizer in the Views input path | 3 | Not in Chromium today; new code. |
| Speed dial new tab page | Local page with local bookmarks and most-visited data; no Google-hosted content | 2 | Replaces the new tab page (section 5). |
| Ad blocking | Native content-blocking component (section 5) using a filter engine. MV3 extensions still work through `declarativeNetRequest` | 2 | Choose the filter engine and check its license. |
| HTTPS-only | Chromium's HTTPS-only mode, on by default | 1 | Confirm the preference name. |
| DNS over HTTPS | Chromium's secure DNS settings, with a chosen default resolver | 1 | Decision: which resolver is the default. The ungoogled-chromium `doh-changes.patch` is a reference. |
| Third-party cookie control | Third-party cookies blocked by default | 1 | Upstream default (section 11). |
| Themes | Chromium's theme system: light, dark, and accent colour | 2 | |
| Reader mode | Chromium's reading mode, if present at the pinned milestone | 1 | Verify. |
| Downloads | Chromium downloads, with "ask where to save" on (the upstream-style default) | 1 | |
| Bookmarks and history | Local, Chromium native; sync off | 1 | |
| DevTools | Upstream DevTools, unchanged | 1 | Checked in section 12. |
| Picture-in-picture | Chromium video and document PiP | 1 | |

Phases: 1 is an upstream feature with its defaults set. 2 is new UI or component work. 3 is new input code.

## 11. Privacy and security baseline

Starting defaults, taken from ungoogled-chromium `docs/default_settings.md` (verified):

- Block third-party cookies: on.
- Preload pages: off.
- Search suggestions: off.
- Hyperlink auditing (`<a ping>`): off.
- Auto sign-in: off.
- Offer to save passwords, payment autofill, and payment-method checks: off.
- Continue running background apps when closed: off.
- WebRTC IP handling: do not expose non-proxied UDP (`--webrtc-ip-handling-policy`).

Network and services:

- No Google account, sync, or Google-hosted services by default (section 7 and the patch list in section 5).
- Crash reporting and metrics reporting: off by default. Confirm the metrics endpoint configuration at the pinned tag, using the network check in section 12.
- No automatic updater in v1. Updates are manual downloads. An updater that uses signed manifests is a later decision.
- Widevine: off, not shipped (decision 9). Privacy Sandbox attestations and MEI preload: not shipped (decision 14).
- Safe Browsing: off (decision 8).

Process model:

- Chromium's sandbox stays on. The Windows release target list has no `chrome_sandbox` target (section 8).

Fingerprinting: standard hardening only (decision 6).

## 12. Build verification checklist

Build

- [ ] `gn gen out\Default --fail-on-unused-args` passes, so every argument exists.
- [ ] `ninja -C out\Default chrome mini_installer` builds, and the launcher is `inkbrowser-chrome.exe`.
- [ ] `verify-layout.mjs` passes on the staging folder and on the unzipped portable zip.
- [ ] No file with a forbidden name or pattern (section 9.3).

Branding

- [ ] `inkbrowser-chrome.exe` file properties: ProductName, FileDescription, and CompanyName read InkBrowser.
- [ ] Search the built resources for "Chromium", "Chrome", and "Google". The `.pak` files hold UTF-8 and UTF-16 strings, so search both encodings. Only the credits and license text, and the `Chrome/` token in the UA, may match.
- [ ] The About page shows InkBrowser and the InkBrowser version.
- [ ] The User-Agent contains `InkBrowser/<X.X.X.X>`, with no other product token beyond the `Chrome/<version>` compatibility token.

Privacy and network

- [ ] First run with no account: capture DNS and connections for ten minutes. No Google host is contacted unless the user acts. Search the capture for `google`, `gstatic`, `googleapis`, and `gvt1`.
- [ ] The defaults in section 11 are set in a new profile.
- [ ] Third-party cookies are blocked on a test page, and HTTPS-only upgrades an `http://` test URL.
- [ ] Secure DNS shows the configured resolver.

Features

- [ ] DevTools (F12) opens and inspects a page; `chrome://inspect` works.
- [ ] Picture-in-picture works for a video.
- [ ] Vertical tabs, tab groups, and the bottom toolbar work.
- [ ] Downloads, bookmarks, and history work locally.
- [ ] Content blocking blocks a known ad test page.

Portable

- [ ] Run from a folder on removable media. The profile is created in `InkBrowser\Data\`, and nothing for that profile is written to `%LOCALAPPDATA%`.
- [ ] Extracting the zip gives the same tree, and the SHA-256 matches the recorded value.

Compatibility

- [ ] An MV2 extension fails to load (expected, decision 5). An MV3 extension loads.

## 13. Verification status

| Claim | Status | Source |
|---|---|---|
| image-1 and image-2 descriptions | Taken from the images as shown in the chat. The image files are not in the workspace, so they were not re-checked on disk. | request |
| GN arguments (section 7) | Verified against the upstream flag files at the commits in section 4 | ungoogled-chromium `flags.gn` at 3e46b13; ungoogled-chromium-windows `flags.windows.gn` at f03c33d |
| `is_chrome_branded` default and BRANDING path | Verified | Chromium main: `build/config/chrome_build.gni`; `chrome/app/theme/chromium/BRANDING` |
| BRANDING keys (section 6) | Verified (the keys; the values are proposals) | Chromium main |
| Launcher output name | Partly verified: `_chrome_output_name` exists, and a Windows reorder step exists | Chromium main `chrome/BUILD.gn`; ungoogled-chromium-windows patch `windows-disable-reorder-fix-linking.patch` |
| Two-level layout requirement | Verified from source comments | Chromium main `chrome/app/chrome_exe_main_win.cc` |
| Visual Elements manifest name | Verified (fixed constant) | Chromium main `chrome/installer/setup/setup_constants.cc` |
| Portable file list (section 9.1) | Verified for Chromium main, not for the pinned tag | Chromium main `chrome/tools/build/win/FILES.cfg` |
| User-data default paths | Verified | Chromium main `chrome/common/chrome_paths_win.cc` and `chrome/install_static/user_data_dir.cc` |
| User-agent token | Verified: `Chrome/` is hard-coded upstream | Chromium main `components/version_info/version_info_with_user_agent.cc` |
| `ffmpeg_branding = "Chrome"` | Verified as a value. Its declaration was not located. | Chromium main `chrome/browser/chrome_for_testing/args.gni` |
| `kVerticalTabs` | Verified to exist. Default state not checked. | Chromium main `chrome/browser/ui/tabs/features.h` |
| Build targets and steps (section 8) | Verified | ungoogled-chromium `docs/building.md`; ungoogled-chromium-windows `build.py` |
| Packaging exclusions (section 9.4) | Verified | ungoogled-chromium-windows `package.py` |
| Chromium base (section 2, decision 4) | Chrome 154 is stable; Chrome 155 has started early stable | Chrome Releases index, October 2026 |
| Two-week release cycle | Verified | developer.chrome.com, "Get features faster with Chrome's two-week release cycle" |
| MV2 timeline (decision 5) | Verified | Chrome for Developers, "Manifest V2 support timeline" (fetched 2026-10-08) |
| Google-service and safe-browsing flags | Verified as upstream values | ungoogled-chromium `flags.gn` |
| Default privacy settings (section 11) | Verified as upstream defaults | ungoogled-chromium `docs/default_settings.md` |
| Not verified | The pinned tag's contents (main was checked, not 154.0.8037.97); the preference names for HTTPS-only and secure DNS; the content-blocking hook name; the portable marker lookup (`DIR_EXE` or `DIR_MODULE`); reader mode availability; what `extensions-manifestv2.patch` does at this milestone; where the Windows version resources are set; the exact Visual Studio requirement | Confirm at the pinned tag before building |
| Excluded components (decision 14) | Tested: the staged tree has none of the three, and the verifier rejects one | `packages/core/test/inkbrowser-stage.test.ts`; `inkbrowser-layout.test.ts` |
| `stage.mjs` packaging (section 8) | Tested on a fixture build output (7 tests). Not run against a real Chromium build. | `packages/core/test/inkbrowser-stage.test.ts` |
| App integration (section 15) | Unit-tested: launch rules, launch arguments, install lookup, and the manager's launch order. Not run against an installed `inkbrowser-chrome.exe`. | `packages/core/test/inkbrowser-engine.test.ts`; `apps/octobrowser/test/inkbrowser-main.test.ts` |
| Icon (section 6) | Redrawn from the inline screenshot, because the original file was not on disk. Checked by eye only. The original file is needed for an exact match. | `branding/inkbrowser/logo.svg` |
| `inkbrowser-chrome.exe` binary | Not built. It needs a Windows build machine (section 8). | sandbox |
| Chromium build | Not performed. No access to chromium.googlesource.com, and no disk or CPU budget. | sandbox |

## 14. Open questions

1. Confirm decisions 3 (upstream internal file names), 7 (the `Chrome/` UA token), 8 (Safe Browsing off), 9 (Widevine off), 10 (portable profile), 11 (depot_tools), and 14 (excluded components).
2. Pick the default secure-DNS resolver.
3. Pick the content-blocking filter engine, check its license, and choose the filter lists.
4. Decide the installer timing (after the portable zip) and code signing (an Authenticode certificate is needed).
5. Decide the update channel: a manual download, or a signed manifest with a built-in updater.

## 15. Electron or InkBrowser

OctoBrowser keeps Electron as a selectable engine, and Electron stays the default for new profiles. InkBrowser is the more secure base. The engine is chosen per profile, and existing profiles keep Electron.

| | Electron (OctoBrowser) | InkBrowser |
|---|---|---|
| Code that runs | Chromium inside Electron, with Node.js and OctoBrowser's application code | Chromium only, as a separate `inkbrowser-chrome.exe` process. No Node.js and no Electron |
| Who builds the Chromium part | Electron's maintainers, shipped inside the OctoBrowser release | OctoBrowser's maintainers, built from the pinned Chromium tag (section 4) |
| Chromium security fixes | Arrive when Electron ships a Chromium update | Arrive when OctoBrowser rebuilds the base for a Chromium security release |
| Google components | Whatever the Electron build includes | Widevine, Privacy Sandbox attestations, and MEI preload are removed, Google services are off, and Safe Browsing is off (sections 7 and 14; decision 8) |
| OctoBrowser privacy features (fingerprint spoofing, proxy, page shim, protection presets, diagnostics, Windows Sandbox, VM) | Applied | Not applied. A profile that uses one of them is refused at launch (section 2, decision 15) |

Neither engine is more secure in every respect. Both run Chromium's own sandbox and site isolation. Two different things differ:

- **Attack surface.** InkBrowser has no Electron and no Node.js in the browser process, so there is less code to trust and fewer layers to patch. This is the basis for suggesting InkBrowser.
- **Privacy features.** Fingerprint spoofing, proxy routing, protection presets, and diagnostics run only in the Electron engine. InkBrowser also has Safe Browsing off, so its phishing and download warnings are not there. The engine is therefore a trade-off for each profile, not a free upgrade.

Recommendation: once the base is built and installed, use InkBrowser for profiles that do not need OctoBrowser's privacy features, and keep Electron for the rest. The default profile needs fingerprint spoofing and the Standard protection preset, so it stays on Electron. To change the default, edit `NEW_PROFILE_ENGINE` in `packages/core/src/inkbrowser.ts`.
