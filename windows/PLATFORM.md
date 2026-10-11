# Octo.su Windows x64 source tree

This folder is the complete Windows-facing application source and packaging contract. It contains the shared browser, profile, password, privacy, shell, and native-engine implementation plus Windows staging and installer entry points.

Run `scripts\\install.bat`, `npm run dist:browser`, and `npm run test:native-packaged:windows` on Windows x64. Windows execution must be validated on Windows or CI; Linux results do not prove Windows visible-window behavior.
