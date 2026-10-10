# OctoSuite platform source layout

The connected branch now exposes the full application source in two explicit folders:

- `linux/` — Linux x64/Debian build, staging, installer, AppImage, and `.deb` path.
- `windows/` — Windows x64 build, staging, installer, and ZIP path.

Both trees contain the same application architecture and platform-specific packaging contracts. Runtime binaries are not committed; each tree stages pinned, checksum-verified Chromium and Firefox archives through its documented command.

Future changes must update and test both platform folders. See `linux/README_LINUX_WINDOWS_AI.md` and `windows/README_LINUX_WINDOWS_AI.md`.
