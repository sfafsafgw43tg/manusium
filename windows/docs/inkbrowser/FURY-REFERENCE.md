# Fury reference review for InkBrowser

## What was useful

Fury’s public repository presents a profile-first workflow: local profiles can be run without a server, profile data is kept separate, proxies are attached per profile, and the desktop shell reports runtime status instead of hiding unavailable capabilities. Its architecture separates the desktop shell, a local agent, and the Chromium core. The repository also emphasizes measuring a claim in a running browser rather than treating a successful compile as proof.

The most relevant design ideas for InkBrowser are therefore:

- a clear profile table with search, folders/tags, status, launch/stop, and per-profile network settings;
- an explicit runtime health state, including a hard error when the requested engine is unavailable;
- versioned, source-built Chromium artifacts with a manifest that records the source revision and build inputs;
- runtime verification through CDP and cross-context tests before claiming a browser capability;
- local-first operation with no required service or account for ordinary profile management.

InkBrowser already has the profile table, folders, tags, sort/reorder controls, launch/stop actions, per-profile proxy storage, Electron fallback, native Chromium CDP controls, Firefox separation, password isolation, and runtime-health errors. The current source-build work adds the source checkout, branding overlay, GN/Ninja build, and source-built runtime manifest required for the Windows Chromium path.

## What is deliberately not copied

No Fury source code, patches, assets, branding, or binaries were copied. Fury is published under AGPL-3.0-or-later, so copying implementation code into this MPL-2.0 project would create licensing and distribution obligations. The repository was used only as a public design and verification reference.

InkBrowser also does not claim to provide stealth, CAPTCHA bypass, ban evasion, identity impersonation, or an “undetectable” browser. Stock browser APIs cannot honestly guarantee that result. Any privacy or testing control must be documented, engine-specific, and verified in the actual runtime.

## Current implementation boundary

The Windows Chromium runtime is now accepted only when its `runtime.json` says `distribution: source-built` and `modified: true`, and its executable hash matches the manifest. The old Windows Chrome-for-Testing staging route is rejected. The source build still requires a real Windows x64 build machine with Visual Studio 2022, depot_tools, Python, and enough disk for a Chromium checkout and build. This Linux sandbox cannot create or verify that Windows executable.

Electron remains the application shell and compatibility engine for responsibilities that have not been replaced by a native runtime. Native Chromium tab/navigation/crash handling is directly covered by the existing integration tests against a real Linux Chromium process. Firefox remains separately discovered and launched; it is not silently substituted when unavailable.

## Sources

- [Fury repository README](https://github.com/furyteamtop/fury-antidetect-browser): public feature description, solo/team workflow, architecture, and stated platform status.
- [Fury contributing guide](https://github.com/furyteamtop/fury-antidetect-browser/blob/main/CONTRIBUTING.md): measurement-first verification guidance, cross-context consistency, and acceptable-use boundaries.
- [Fury license](https://github.com/furyteamtop/fury-antidetect-browser/blob/main/LICENSE): AGPL-3.0 license terms reviewed before deciding not to reuse code.
