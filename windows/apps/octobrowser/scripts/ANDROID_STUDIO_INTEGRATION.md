# Android Studio integration

Octo.su now includes a test-oriented workflow for the Nothing Phone (2) API 35 AVD shown in the supplied references.

## Clean and repair an AVD

```bash
apps/octobrowser/scripts/android-nothing-phone-2.sh create
apps/octobrowser/scripts/android-nothing-phone-2.sh clean
apps/octobrowser/scripts/android-nothing-phone-2.sh repair
```

The repair utility operates on `~/.android/avd/Nothing_Phone_2_API_35.avd` by default, removes `octobrowser.*` keys when cleaning, replaces placeholder-free hardware values, enables the 1080x1920 secondary display, and forces a cold boot. It updates `config.ini` and, when present, `hardware-qemu.ini` only. Snapshot images and userdata are not deleted.

## Launch and verify

```bash
apps/octobrowser/scripts/android-nothing-phone-2.sh boot
apps/octobrowser/scripts/android-nothing-phone-2.sh verify
apps/octobrowser/scripts/android-nothing-phone-2.sh quiet
```

Identity flags are launch-time test overrides. They are intentionally not written to `config.ini`. IMEI and MAC changes are available only through an explicit userdebug/eng test-image opt-in because they can affect device security or app integrity. Use a dedicated test image and follow local law and lab policy.

For a dedicated userdebug/eng test image only, the script also exposes an explicit opt-in path:

```bash
ALLOW_TEST_IDENTITY=1 TEST_IMEI=352080277009953 TEST_MAC=02:00:00:35:20:80 \
  apps/octobrowser/scripts/android-nothing-phone-2.sh identity
```

It attempts `adb root`, `adb remount`, the test IMEI property, and the Wi-Fi MAC, then prints the values for verification. Stock Google Play images may reject these operations; that is an emulator image limitation, not a configuration-file failure.

The quiet mode waits for `sys.boot_completed=1`, prints model/serial/display information, and shuts down the emulator through ADB. If the installed emulator does not support `-no-metrics`, remove that one flag or use the app's capability-detected Android launcher.

## Camera troubleshooting

The app resolves host cameras from the emulator's own `-webcam-list` output, keeps front and rear endpoints distinct, cold-boots when a host camera is selected, and turns off only a lens whose endpoint is unavailable. In the Android page, refresh the camera picker after plugging in a camera; do not reuse a stale `webcamN` index. Verify the host camera is visible to Android Emulator first, then grant the Android Camera permission.

## Device catalogue

The repository already has a typed device catalogue and creator. A `devices.xml` export was not supplied with the change request, so the app does not invent vendor catalogue metadata. When the XML is available, add it through the existing catalogue importer and verify Samsung, Xiaomi, OnePlus, and Pixel Fold entries in Device Manager.

## Password manager

The profile credentials dialog now uses a theme-aware summary strip (items, sites, updated this week), neutral avatars, card rows, a protected reveal action, and an import footer. It uses the existing encrypted password IPC and works with both light and dark launcher themes.
