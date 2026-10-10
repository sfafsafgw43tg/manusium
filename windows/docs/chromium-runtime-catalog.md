# Chromium runtime catalog and update policy

Octo uses pinned **Chrome for Testing** archives as the redistributable Chromium source. The catalog is machine-readable in `packages/shell/src/runtime-catalog.ts`; installation never resolves an unpinned `latest` URL.

## Choices

| Channel | Version | Status | Default | Notes |
|---|---:|---|---|---|
| Stable | 155.0.8059.39 | Supported | Yes | Current Stable from the Chrome for Testing last-known-good metadata at catalog update time |
| Beta | 156.0.8078.12 | Supported | No | Optional preview channel; not the default |
| Stable | 140.0.7339.207 | Retired | No | Compatibility-only migration entry; cannot be installed as a new runtime |

Each platform entry records an exact HTTPS archive URL, archive SHA-256, executable name, CDP protocol, capabilities, channel, and support status. Linux x64 and Windows x64 are the currently cataloged targets. There are no Gecko entries in this catalog.

## User flow

In the profile editor's **Browser settings** section, the user can:

1. See every catalog entry for the current platform, including channel, support status, and install status.
2. Install a supported version. The manager downloads to a temporary directory, verifies the archive checksum, rejects absolute/parent-traversal archive members, validates the expected executable, writes a versioned manifest and notice, and atomically renames the completed directory into the installed runtime store.
3. Select the exact version for that profile. New profiles default to Stable 155.0.8059.39.
4. Remove a version only when it is not selected by any profile and not running. Retired versions cannot be newly installed.

The manager resolves the selected profile version through the existing manifest contract and launches that exact executable. It does not silently choose a system browser. The historical development fallback is only used when the packaged/managed runtime is missing and remains reported as the legacy InkBrowser path.

## Profile compatibility and rollback

Chromium profile data is not silently migrated between runtime versions. Profiles store their selected runtime version. A runtime cannot be removed while selected by a profile or while running. Operators should create a profile backup before moving a profile to an older runtime. The retired 140 entry is retained only to allow a controlled compatibility migration; it is not a normal install choice or default.

The next hardening step is a version-specific data schema marker and automatic per-version profile directory migration. Until that is implemented, the application keeps the existing profile data directory and blocks runtime removal rather than attempting an unsafe downgrade.

## Maintenance policy

The release-maintenance job must, at least weekly and immediately after a Chromium security release:

1. Read Chrome for Testing last-known-good Stable/Beta metadata.
2. Update the catalog version, channel, URLs, archive checksums, and support flags in one reviewed change.
3. Run catalog validation, archive-integrity tests, the real CDP navigation/tab/crash suite, and platform packaging jobs.
4. Promote a new Stable only after the Windows installer and launch smoke test pass.
5. Mark the previous Stable retired only after the new Stable is shipped and retain it temporarily for compatibility migration.

An emergency update uses the same reviewed catalog change but may skip Beta promotion; it must never bypass checksum verification or install an unpinned URL.

## Licensing

Chrome for Testing archives include Chromium `ABOUT` and related notices. Octo preserves those files and writes `NOTICE.chromium.txt` with the exact source URL and archive checksum. The release process must preserve upstream notices and comply with Chromium third-party license terms. Product branding must not imply that Octo is Google Chrome.

## Release status

This repository-side catalog and UI implementation is not a claim that the product is release-ready yet. A Windows runner must still build and launch the installer, and the release workflow must pass the Windows packaged-runtime integration test. Linux sandbox verification cannot substitute for that platform proof.
