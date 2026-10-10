# Windows Chromium source-build prerequisites

`install.bat` now prepares the missing build tools before running `stage:chromium:windows`.

## Automatic behavior

When the verified source-built Chromium runtime is missing, the installer:

1. Reuses Git for Windows from the current or refreshed PATH.
2. Clones the official `depot_tools` repository into `%LOCALAPPDATA%\InkBrowser\depot_tools` when `fetch.bat` is absent.
3. Adds that directory to the current process and the current user's PATH.
4. Sets `DEPOT_TOOLS_WIN_TOOLCHAIN=0`, so depot_tools uses the local Visual Studio installation.
5. Runs `gclient.bat` once to bootstrap depot_tools' Windows helpers and Python.
6. Installs Microsoft Visual Studio Build Tools through the official `winget` source when `vswhere.exe` is not found, requesting the C++ workload, MFC/ATL support, and recommended components.
7. Runs the source-build command that produces `inkbrowser-chrome.exe`.
8. Verifies the runtime manifest and executable SHA-256 before the installer can report success.

The installer stops after a fatal runtime failure. It no longer creates a shortcut or claims to have built the application after Step 6 fails.

## Requirements that cannot be hidden by the installer

A Chromium source checkout is large. The official Windows instructions require at least 100 GB of free NTFS disk space and recommend more than 16 GB of RAM. The source build also requires a supported Windows version, Visual Studio's Desktop development with C++ workload, MFC/ATL support, and the Windows SDK. The build can take a long time and may require administrator approval for Visual Studio installation.

If `winget` is unavailable, or Visual Studio installation fails, the installer reports the missing prerequisite and stops without substituting Chrome for Testing.

## Sources

- Chromium Windows build instructions: https://chromium.googlesource.com/chromium/src/+/main/docs/windows_build_instructions.md
- Chromium depot_tools setup: https://www.chromium.org/developers/how-tos/install-depot-tools/
- Microsoft MSVC Build Tools acquisition: https://learn.microsoft.com/en-us/cpp/overview/acquire-msvc?view=msvc-170
