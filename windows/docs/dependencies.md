# Dependencies

OctoSuite checks its dependencies every time an app is started, so a new
version never starts against a `node_modules` folder from an older lockfile.

## What runs, and when

`tools/ensure-deps.mjs` is the one place that decides whether packages must be
installed. It runs in these situations:

- **npm start scripts.** `start`, `start:browser`, `start:detect`, `dev`, and
  `dev:detect` have npm `pre` hooks that run it first. A failed check stops
  the command before Electron starts.
- **Windows launchers.** Opening the app from `scripts\open.bat` or the desktop
  shortcut, the setup steps, and the development update path (after its
  `git pull`, in `scripts\github-update.bat` and in the update step of
  `scripts\start-all.bat`) all call the same script through `scripts\lib\octo.ps1`.

It installs when one of these is true:

- `node_modules` is missing, or no install has been recorded yet.
- `package.json`, `package-lock.json`, `.npmrc`, or an `apps/*` or `packages/*`
  `package.json` changed since the last recorded install. This is what happens
  after an update or a `git pull` that changed dependencies.
- The Electron package or its binary is missing. Then only the Electron binary
  is downloaded again; the packages are not reinstalled.

The install runs `npm ci`, and falls back to `npm install` if `npm ci` fails.
The record lives in `node_modules/.octo-deps-stamp.json`. It holds a SHA-256
fingerprint of the inputs above, together with the platform and architecture,
so a `node_modules` copied from another machine is treated as stale.

## Commands

```
npm run deps          # check, and install or repair when needed
npm run deps:check    # report only: exit code 0 = up to date, 1 = work needed
```

## One-time reinstall after this change

Earlier versions recorded a different marker (`node_modules/.octo-lock-sha256`)
that the new check does not read. The first start after this update therefore
runs `npm ci` once, and then records the new stamp. Later starts only install
when the dependencies change.

## When something fails

- **Exit code 2 and "Installing project dependencies failed".** Read the npm
  output above it. Fix the network, proxy, or registry problem, then start the
  app again. Nothing is recorded, so the next start tries again.
- **"The Electron binary could not be installed".** The packages are already
  recorded as installed. The next start retries only the Electron download.
- **"Node.js was not found" or a version below 22.12.** Install the version
  listed under `engines` in `package.json`.
