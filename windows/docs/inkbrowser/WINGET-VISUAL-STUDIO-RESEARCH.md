# WinGet and Visual Studio installer contract

- WinGet `install` documents `--override` as a string passed directly to the installer. The Visual Studio installer flags must therefore be one quoted override argument when invoked through `Start-Process`.
- Microsoft Visual Studio command-line examples document `--passive` or `--quiet` for non-interactive installation, `--wait` for the bootstrapper, and `--add`/`--includeRecommended` for workload selection. Microsoft states Visual Studio command-line installation requires administrator elevation.
- Microsoft MSVC acquisition guidance documents the stable WinGet package ID `Microsoft.VisualStudio.BuildTools` and the `NativeDesktop`/C++ workload approach, with `Microsoft.VisualStudio.Component.VC.ATLMFC` and Windows SDK components.
- Microsoft’s Visual Studio modification guidance documents using the installed `setup.exe` to modify an existing installation; it requires administrator permissions and supports adding workloads and components.
- Chromium's official Windows build instructions require Windows 10+, x86-64, at least 8 GB RAM (16+ recommended), at least 100 GB free NTFS disk, Visual Studio Desktop development with C++, MFC/ATL, a Windows 11 SDK, depot_tools, and Python/depot_tools-managed tools.

## Recovery behavior implemented in InkBrowser

- **VB-CABLE:** `VB-Audio.Cable` is not treated as a WinGet package. The installer downloads `VBCABLE_Driver_Pack45.zip` only from `download.vb-audio.com`, starts the vendor installer with administrator approval, and verifies the driver, service, or `CABLE Output` audio endpoint afterward. A successful process exit without a Windows signal is reported as a failure, not as “ready.” If automatic installation cannot be verified, manually download the package from https://vb-audio.com/Cable/, extract it, run the matching `VBCABLE_Setup_x64.exe` as administrator, choose **Install Driver**, restart Windows if the endpoint does not appear, then rerun `install.bat`.
- **npm native scripts:** the project invokes `npm ci` and its fallback with `--ignore-scripts=false`, overriding an inherited user setting that blocked lifecycle scripts. It then verifies and, only when needed, runs the declared `esbuild/install.js` and `electron-winstaller/script/select-7z-arch.js` scripts. It does not blanket-approve arbitrary package scripts. `esbuild --version` and the Squirrel 7-Zip pair are checked before the dependency stamp is written.
- **Visual Studio:** when `vswhere` finds an existing installation but the required components are absent, the installer calls the installed `Microsoft Visual Studio\\Installer\\setup.exe modify --installPath ... --add Microsoft.VisualStudio.Workload.NativeDesktop --add Microsoft.VisualStudio.Component.VC.ATLMFC --includeRecommended --passive --wait` and requests UAC only for that process. If there is no existing installation, it uses WinGet with a single quoted `--override` value. Both paths run `vswhere` component validation afterward.

Sources:
- https://learn.microsoft.com/en-us/windows/package-manager/winget/install
- https://learn.microsoft.com/en-us/visualstudio/install/command-line-parameter-examples?view=visualstudio
- https://learn.microsoft.com/en-us/cpp/overview/acquire-msvc?view=msvc-170
- https://learn.microsoft.com/en-us/visualstudio/install/modify-visual-studio?view=visualstudio
- https://chromium.googlesource.com/chromium/src/+/main/docs/windows_build_instructions.md
- https://vb-audio.com/Cable/
- https://download.vb-audio.com/
