# Engine verification — 2026-10-10

## Directly verified on Linux

The pinned native runtimes were staged from official vendor archives and verified with the repository's checksum-aware staging scripts:

- Chromium 155.0.8059.39 (`inkbrowser-chrome`)
- Firefox 140.0 (`inkbrowser-firefox`)

Commands:

```bash
npm run stage:chromium:linux
npm run stage:firefox:linux:reuse
npm run test:native-engines
npm run test:native-packaged
npm run test:native-firefox-packaged
```

Results:

- Both staged executables launched successfully.
- Chromium CDP tests passed for isolated profile launch, navigation, app mode, crash handling, tab creation/switching/closing, and clean shutdown: 4/4.
- Firefox WebDriver BiDi/Juggler smoke verification passed for navigation, profile isolation, app-mode presentation, tab creation/closing, `webrtc=disabled`, `location=block`, `resistFingerprinting=true`, and clean shutdown.

## Privacy and fingerprinting scope

The application supports privacy and authorized QA controls such as WebRTC exposure reduction, location permission policy, optional WebGL disabling, Firefox's native resist-fingerprinting preference where explicitly selected, profile isolation, HTTPS-only behavior, network filtering, and reviewed per-profile extensions.

It does **not** provide a claim of undetectability, impersonation of a chosen person or device, CAPTCHA or ban evasion, or guaranteed canvas/GPU/font/device spoofing. Stock Chromium and stock Firefox do not expose a supported general-purpose API for making every fingerprint field appear as an internally consistent arbitrary identity. Controls are therefore labelled by what they actually change.

## Add-ons

- Built-in controls and network filtering are part of the signed application code.
- The bundled PrOximAl Editor is local-only, Manifest V3, profile-scoped, and disabled by default.
- Chromium uBlock Origin Lite and Firefox uBlock Origin are catalogued as official external add-ons. They are not silently sideloaded or updated by InkBrowser; installation and updates remain under the official browser stores.
- The project does not claim that an external add-on is installed or tested merely because it appears in the catalog.

## Icons

The repository includes project-owned purple-themed icon sets for `inkbrowser-chrome` and `inkbrowser-firefox` in `branding/inkbrowser-chrome` and `branding/inkbrowser-firefox`, with ICO and PNG sizes for packaging.

## Platform limitation

Linux was directly tested in this environment. Windows source typecheck and focused tests can run here, but the Windows Firefox MSI staging path intentionally requires Windows `msiexec.exe`; Windows launch behavior and Windows Firefox installation were not directly verified in this Linux environment. The Windows Chromium archive was downloaded and staged, but not executed here.
