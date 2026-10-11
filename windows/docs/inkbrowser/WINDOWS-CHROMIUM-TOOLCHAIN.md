# Windows Chromium source-build prerequisites

`install.bat` prepares and verifies the missing build tools before building and staging the
source-built Chromium runtime. Firefox staging is intentionally deferred to its separate engine
flow so a Chromium installation does not download or require Gecko files.

## Automatic behavior

When the verified source-built Chromium runtime is missing, the installer:

1. Reuses Git for Windows from the current or refreshed PATH.
2. Clones the official `depot_tools` repository into `%LOCALAPPDATA%\InkBrowser\depot_tools` when `fetch.bat` is absent.
3. Adds that directory to the current process and the current user's PATH.
4. Sets `DEPOT_TOOLS_WIN_TOOLCHAIN=0`, so depot_tools uses the local Visual Studio installation.
5. Runs `gclient.bat --version` to validate the depot_tools wrapper without invoking its usage screen.
6. Verifies that Visual Studio contains MSVC x64/x86 tools and a Windows 10/11 SDK, not merely that `vswhere.exe` exists. If the workload is missing, it uses the official `winget` source to install Build Tools with the `NativeDesktop` C++ workload, MFC/ATL support, and recommended components.
7. Selects a writable fixed drive with at least 100 GB free, preferring `C:\` when it qualifies. Set `OCTO_CHROMIUM_SOURCE` to choose a specific source base directory; the build uses `<source>\chromium\src`.
8. Verifies `fetch`, `gclient`, `gn`, and `autoninja` before starting the large checkout.
9. Runs the source-build command that produces `inkbrowser-chrome.exe`.
10. Verifies the Chromium runtime manifest and executable hash before the installer can report success.

The installer stops after a fatal runtime failure. It no longer creates a shortcut or claims to have built the application after Step 6 fails.

## Requirements that cannot be hidden by the installer

A Chromium source checkout is large. The official Windows instructions require at least 100 GB of free NTFS disk space and recommend more than 16 GB of RAM. This is not an arbitrary installer limit: lowering it would let the checkout start and then fail part-way through. If the system drive is small, put the source on another fixed drive, for example `set OCTO_CHROMIUM_SOURCE=D:\InkBrowserBuild`, or let the installer select a qualifying drive automatically. The source build also requires a supported Windows version, Visual Studio's Desktop development with C++ workload, MFC/ATL support, and the Windows SDK. The build can take a long time and may require administrator approval for Visual Studio installation.

If `winget` is unavailable, the Visual Studio workload is missing, or Chromium fails verification, the installer reports the specific prerequisite and stops without substituting another browser. Firefox staging has its own separate prerequisite and verification path.

Visual Studio's `--passive` and `--wait` flags belong to the Visual Studio installer, not to winget. The installer therefore passes them as one quoted `--override` value, as required by winget's documented override behavior. WinGet's own log is written to `%LOCALAPPDATA%\InkBrowser\logs\visual-studio-winget.log`; failures include the exact command and that path. Microsoft documents that Visual Studio installation requires administrator elevation, so only this Build Tools step requests UAC when the installer is not already elevated. Node.js, Git, depot_tools, Firefox staging, and the application build remain unelevated.

## Sources

- Chromium Windows build instructions: https://chromium.googlesource.com/chromium/src/+/main/docs/windows_build_instructions.md
- Chromium depot_tools setup: https://www.chromium.org/developers/how-tos/install-depot-tools/
- Microsoft MSVC Build Tools acquisition: https://learn.microsoft.com/en-us/cpp/overview/acquire-msvc?view=msvc-170
- WinGet install and `--override`: https://learn.microsoft.com/en-us/windows/package-manager/winget/install
- Visual Studio command-line installation parameters: https://learn.microsoft.com/en-us/visualstudio/install/command-line-parameter-examples?view=visualstudio
