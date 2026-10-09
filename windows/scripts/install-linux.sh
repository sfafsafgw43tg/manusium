#!/usr/bin/env bash
# OctoSuite Linux/Debian source installer.
# Safe defaults: installs only into this checkout and never runs as root.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "${EUID}" -eq 0 ]]; then
  echo "Do not run this script as root. Use a normal user so Electron and the browser sandbox retain user ownership." >&2
  exit 2
fi

command -v node >/dev/null || { echo "Node.js 22.12+ is required." >&2; exit 3; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 3; }
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) process.exit(1)' || {
  echo "Node.js 22.12+ is required; found $(node --version)." >&2; exit 3;
}

if [[ ! -d node_modules ]]; then
  npm ci
fi
npm run deps:check || npm run deps
npm run icons
npm run build:browser
npm run stage:chromium:linux
npm run stage:firefox:linux
npm run typecheck
npm run i18n:check
npm run test:native-packaged
npm run test:native-firefox-packaged

cat <<EOF

Linux setup completed in:
  $ROOT

Run the development browser with:
  npm run start:browser

Create the portable/AppImage/Debian packages with:
  npm run dist:linux
EOF
