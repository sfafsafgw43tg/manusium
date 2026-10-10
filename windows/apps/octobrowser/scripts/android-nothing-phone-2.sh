#!/usr/bin/env bash
set -Eeuo pipefail

# Octo.su Android Studio integration helper.
# This script never writes identity values into config.ini. Identity overrides
# are launch-time test flags and should only be used with a userdebug/eng image.
AVD_NAME="${AVD_NAME:-Nothing_Phone_2_API_35}"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}"
EMULATOR="${EMULATOR:-$SDK_ROOT/emulator/emulator}"
ADB="${ADB:-$SDK_ROOT/platform-tools/adb}"
AVD_DIR="${AVD_DIR:-$HOME/.android/avd/${AVD_NAME}.avd}"
MODE="${1:-boot}"
SERIAL_OVERRIDE="${SERIAL_OVERRIDE:-XPTMJBSA5WQ5}"
TEST_IMEI="${TEST_IMEI:-352080277009953}"
TEST_MAC="${TEST_MAC:-02:00:00:35:20:80}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
need "$EMULATOR"
need "$ADB"

create_avd() {
  local avdmanager="$SDK_ROOT/cmdline-tools/latest/bin/avdmanager"
  [[ -x "$avdmanager" ]] || avdmanager="$(command -v avdmanager || true)"
  [[ -n "$avdmanager" ]] || { echo "avdmanager was not found" >&2; exit 1; }
  printf 'no\n' | "$avdmanager" create avd -n "$AVD_NAME" \
    -k "system-images;android-35;google_apis;x86_64" -d pixel_7 --force
  python3 "$(dirname "$0")/repair-avd.py" "$AVD_DIR" --clean-config
}

apply_test_identity() {
  [[ "${ALLOW_TEST_IDENTITY:-0}" == "1" ]] || { echo "Set ALLOW_TEST_IDENTITY=1 for the userdebug identity test." >&2; exit 1; }
  "$ADB" wait-for-device
  "$ADB" root >/dev/null 2>&1 || true
  "$ADB" remount >/dev/null 2>&1 || true
  "$ADB" shell "printf '%s' '$TEST_IMEI' > /data/local/tmp/imei.txt"
  "$ADB" shell "setprop persist.sys.imei '$TEST_IMEI'"
  "$ADB" shell "ip link set wlan0 address '$TEST_MAC'" >/dev/null 2>&1 || true
  echo "Requested test identity values; verify with adb shell getprop and ip link."
}

if [[ "$MODE" != "create" && "$MODE" != "help" ]]; then
  [[ -d "$AVD_DIR" ]] || { echo "AVD directory not found: $AVD_DIR (run '$0 create' first)" >&2; exit 1; }
fi

case "$MODE" in
  create)
    create_avd
    ;;
  clean)
    python3 "$(dirname "$0")/repair-avd.py" "$AVD_DIR" --clean-config
    ;;
  boot)
    exec "$EMULATOR" "@$AVD_NAME" \
      -no-snapshot-load -no-snapshot-save \
      -prop ro.product.model="Nothing Phone (2)" \
      -prop ro.product.brand=nothing \
      -prop ro.product.manufacturer=Nothing \
      -prop ro.serialno="$SERIAL_OVERRIDE" \
      -prop ro.boot.qemu.avd_name="$AVD_NAME" \
      -multidisplay 1,1080,1920,420,0,0
    ;;
  quiet)
    "$EMULATOR" "@$AVD_NAME" -no-window -no-audio -no-boot-anim \
      -no-snapshot-save -no-snapshot-load -no-metrics \
      -prop ro.product.model="Nothing Phone (2)" -prop ro.serialno="$SERIAL_OVERRIDE" &
    emulator_pid=$!
    trap '"$ADB" emu kill >/dev/null 2>&1 || true; kill "$emulator_pid" >/dev/null 2>&1 || true' EXIT
    "$ADB" wait-for-device
    for _ in $(seq 1 120); do
      [[ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]] && break
      sleep 2
    done
    [[ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]] || { echo "Android boot did not complete" >&2; exit 1; }
    echo "Android boot completed"
    "$ADB" shell getprop ro.product.model
    "$ADB" shell getprop ro.serialno
    "$ADB" shell dumpsys display | grep -E 'DisplayDeviceInfo|mDisplayId' || true
    ;;
  verify)
    "$ADB" wait-for-device
    echo "model=$("$ADB" shell getprop ro.product.model | tr -d '\r')"
    echo "serial=$("$ADB" shell getprop ro.serialno | tr -d '\r')"
    echo "boot=$("$ADB" shell getprop sys.boot_completed | tr -d '\r')"
    "$ADB" shell dumpsys display | grep -E 'DisplayDeviceInfo|mDisplayId' || true
    ;;
  identity)
    apply_test_identity
    "$ADB" shell getprop ro.product.model
    "$ADB" shell getprop ro.serialno
    "$ADB" shell getprop persist.sys.imei
    "$ADB" shell ip link show wlan0 || true
    ;;
  repair)
    python3 "$(dirname "$0")/repair-avd.py" "$AVD_DIR"
    ;;
  *)
    echo "Usage: $0 [create|clean|boot|quiet|verify|identity|repair]" >&2
    exit 2
    ;;
esac
