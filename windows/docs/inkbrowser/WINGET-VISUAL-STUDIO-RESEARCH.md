# WinGet and Visual Studio installer contract

- WinGet `install` documents `--override` as a string passed directly to the installer. The Visual Studio installer flags must therefore be one quoted override argument when invoked through `Start-Process`.
- Microsoft Visual Studio command-line examples document `--passive` or `--quiet` for non-interactive installation, `--wait` for the bootstrapper, and `--add`/`--includeRecommended` for workload selection. Microsoft states Visual Studio command-line installation requires administrator elevation.
- Microsoft MSVC acquisition guidance documents the stable WinGet package ID `Microsoft.VisualStudio.BuildTools` and the `NativeDesktop`/C++ workload approach, with `Microsoft.VisualStudio.Component.VC.ATLMFC` and Windows SDK components.
- Chromium's official Windows build instructions require Windows 10+, x86-64, at least 8 GB RAM (16+ recommended), at least 100 GB free NTFS disk, Visual Studio Desktop development with C++, MFC/ATL, a Windows 11 SDK, depot_tools, and Python/depot_tools-managed tools.

Sources:
- https://learn.microsoft.com/en-us/windows/package-manager/winget/install
- https://learn.microsoft.com/en-us/visualstudio/install/command-line-parameter-examples?view=visualstudio
- https://learn.microsoft.com/en-us/cpp/overview/acquire-msvc?view=msvc-170
- https://chromium.googlesource.com/chromium/src/+/main/docs/windows_build_instructions.md
