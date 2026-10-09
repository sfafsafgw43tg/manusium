# Octo.su Windows x64 source tree

This folder is the complete Windows-facing application source and packaging contract. It mirrors the shared app implementation while retaining Windows runtime names, installers, and staging commands.

Run `scripts\\install.bat`, `npm run dist:browser`, and `npm run test:native-packaged:windows` on Windows x64. Windows execution must be validated on Windows or CI; Linux results do not prove Windows visible-window behavior.
