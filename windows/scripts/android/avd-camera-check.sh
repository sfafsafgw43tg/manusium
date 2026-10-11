#!/usr/bin/env bash
# Checks the camera side of one Android Studio AVD (or a phone) over ADB.
# Read-only except for granting the camera permission to the check app.
#
#   scripts/android/avd-camera-check.sh [adb-serial]
#
# It never edits secure settings, never clears system camera data, and never
# changes what an emulator reports as its hardware.
set -u

PKG="app.octo.avdcamera"
ADB="${ADB:-adb}"
SERIAL="${1:-}"

if ! command -v "$ADB" >/dev/null 2>&1; then
  echo "adb not found. Install platform-tools and add it to PATH." >&2
  exit 2
fi

adb_cmd() {
  if [ -n "$SERIAL" ]; then "$ADB" -s "$SERIAL" "$@"; else "$ADB" "$@"; fi
}

state="$(adb_cmd get-state 2>/dev/null || true)"
if [ "$state" != "device" ]; then
  echo "No device in the 'device' state. Run: adb devices" >&2
  exit 3
fi

model="$(adb_cmd shell getprop ro.product.model | tr -d '\r')"
hardware="$(adb_cmd shell getprop ro.hardware | tr -d '\r')"
echo "Device: ${model:-unknown} (hardware: ${hardware:-unknown})"

# Diagnostics only: the same hint the app uses for its wording.
case "$hardware" in
  ranchu|goldfish*) echo "Looks like an emulator (wording only; cameras are never chosen by this)." ;;
  *) echo "Looks like a physical device." ;;
esac

echo
echo "Camera services (media.camera):"
adb_cmd shell dumpsys media.camera 2>/dev/null | tr -d '\r' | grep -i "device@" | head -20 || true
if ! adb_cmd shell dumpsys media.camera 2>/dev/null | grep -qi "device@"; then
  echo "  none reported. Set Back/Front to Webcam in Device Manager, plug in a webcam, then cold boot."
fi

echo
if adb_cmd shell pm list packages "$PKG" | grep -q "$PKG"; then
  adb_cmd shell pm grant "$PKG" android.permission.CAMERA && echo "Camera permission granted to $PKG."
  adb_cmd shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1 \
    && echo "Started $PKG. Watch the log below for the result of the preview."
else
  echo "$PKG is not installed. Build android/avd-camera-check and install it first."
fi

echo
echo "Recent AvdCamera log lines (Ctrl+C to stop following):"
adb_cmd logcat -d -s AvdCamera:D 2>/dev/null | tail -n 40 || true
