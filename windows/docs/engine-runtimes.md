# Native engine runtimes

## Chromium packaging milestone

The release build acquires **Chrome for Testing 155.0.8059.39 Stable** from the pinned Google Storage URLs below. The archive is not committed to Git. The selectable catalog also contains supported Beta 156.0.8078.12 and a retired 140.0.7339.207 compatibility entry; see `docs/chromium-runtime-catalog.md`.

| Target | URL | Archive SHA-256 | Local verification |
|---|---|---|---|
| Windows x64 | `https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.39/win64/chrome-win64.zip` | `59ab2a6e99bde9c0bc180414988394f9f5355a0d3764c704151ee8ecea235c7e` | Windows release CI |
| Linux x64 development/test | `https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.39/linux64/chrome-linux64.zip` | `55672d1f392fd3e7b7a08621b6e804e6bcb39d40cf155504abb74b3a021ea8ea` | Sandbox staged-runtime test |

The repository product currently supports Windows 10/11 x64 with both Chromium and Firefox runtime staging. Linux x64 is a development verification target only; macOS, Windows arm64, and Linux arm64 are not advertised or staged by this pipeline.

Run the reproducible staging step:

```bash
npm run stage:chromium:windows
# or for local Linux verification:
npm run stage:chromium -- --target linux-x64 --out .runtime-test/155.0.8059.39
```

The script downloads the exact pinned archive, verifies its SHA-256, extracts the complete runtime (executable, `.pak` files, locales, ICU/snapshot data, libraries, and supporting directories), renames `chrome.exe`/`chrome` to the contract name, creates `runtime.json`, and writes `NOTICE.chromium.txt`. It fails on an unsupported target, download failure, checksum mismatch, missing executable, or invalid archive layout.

The Windows distributable path is:

```text
npm run dist:browser
  -> npm run build:browser
  -> npm run stage:chromium:windows
  -> electron-builder --win --x64
```

`apps/octobrowser/package.json` maps `resources/engines` into the installed application's `resources/engines` directory. Runtime discovery validates `octo.engine-manifest.v1`, platform, executable containment/name, and the executable SHA-256 before launch. The development fallback to the legacy per-user InkBrowser path remains explicit and is used only when no packaged manifest exists.

## Packaged layout

```text
resources/engines/chromium/155.0.8059.39/
  inkbrowser-chrome.exe                 # Windows x64 package
  runtime.json
  NOTICE.chromium.txt
  chrome.dll, *.pak, locales/, resources/, icudtl.dat, snapshots, ...
```

Chromium and Gecko remain separate under `resources/engines/chromium` and `resources/engines/gecko`. The Firefox catalog pins Mozilla Firefox 140.0 for Linux x64 and Windows x64 from the official Mozilla release archive. `npm run stage:firefox:linux` verifies the official SHA-512 tarball; `npm run stage:firefox:windows` verifies the official SHA-512 MSI and extracts it with Windows Installer administrative extraction. Both paths preserve upstream files, write schema-compatible `runtime.json` and `NOTICE.firefox.txt`, and atomically stage `inkbrowser-firefox`/`inkbrowser-firefox.exe`. The Windows build includes the staged Gecko tree in `resources/engines/gecko` rather than silently relying on a system Firefox.

## Verification

```bash
npm run typecheck
npm test
npm run build:browser
npm run test:native-packaged
```

`test:native-packaged` stages the pinned current Stable Linux x64 artifact into a temporary versioned runtime, discovers it through the manifest, asserts the launched executable is inside that staged directory, then runs real-CDP navigation, tab opening, switching, closing, and clean-shutdown tests. It never counts `/usr/bin/inkbrowser-chrome` as packaged verification. `npm run stage:firefox:linux && npm run test:native-firefox-packaged` verifies a real Firefox process, isolated profile creation, configured navigation URL, loopback remote-debugging readiness, and clean shutdown. Firefox tab control is not presented as equivalent to Chromium CDP control; the app exposes a real Firefox window and clearly does not offer the Chromium tab dialog for it.

The release workflow runs `npm run dist`, which stages both Windows native runtimes before packaging, then the real Windows packaged-runtime integration test. After building, inspect the unpacked application and run `unzip -t`/the platform archive checker; confirm `resources/engines/chromium/155.0.8059.39/runtime.json`, the executable, supporting files, and `NOTICE.chromium.txt` are present.

## Licensing and notices

The source is Chrome for Testing, distributed by the Chromium/Chrome project. The staged runtime retains the archive's `ABOUT` file and writes `NOTICE.chromium.txt` with the exact source URL and checksum. Firefox is downloaded only from Mozilla's official release archive, verified against Mozilla's SHA512SUMS value, and retains its upstream license/notice files plus `NOTICE.firefox.txt`. Mozilla states that Firefox executable binaries are made available under the MPL, while trademark and other bundled-component restrictions still apply. The project does not copy Camoufox or invisible_playwright code or binaries; those projects remain references only.

## Troubleshooting

- **Checksum mismatch:** delete the cached archive under `~/.cache/octosuite` and rerun; do not bypass the check.
- **Runtime missing at launch:** inspect installed `resources/engines/chromium/<version>/runtime.json`; packaged builds must not rely on a system browser.
- **Unsupported platform:** add a separately pinned artifact, manifest platform, checksum, and real integration job before advertising it.
- **Windows local build:** run on Windows x64 or a CI runner with the required electron-builder tooling; Linux validation does not prove Windows visible-window behavior.

References: [Chrome for Testing availability](https://googlechromelabs.github.io/chrome-for-testing/), [Chromium licensing](https://www.chromium.org/chromium-projects/licensing/), [Mozilla Firefox release archive](https://ftp.mozilla.org/pub/firefox/releases/140.0/), [Mozilla MSI deployment](https://support.mozilla.org/en-US/kb/deploy-firefox-msi-installers), and [Mozilla licensing/trademarks](https://www.mozilla.org/en-US/foundation/licensing/).
