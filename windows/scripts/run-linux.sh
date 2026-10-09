#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if [[ ! -x node_modules/.bin/electron ]]; then
  echo "Dependencies are not installed. Run scripts/install-linux.sh first." >&2
  exit 2
fi
npm run build:browser
exec node_modules/.bin/electron apps/octobrowser "$@"
