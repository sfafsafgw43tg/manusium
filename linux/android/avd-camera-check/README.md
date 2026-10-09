# AVD camera check (native Android app)

A small CameraX app that shows which cameras an Android Studio AVD (or a phone)
exposes, lets you pick one, and reports whether its preview really streams.
It is the on-device half of the camera work described in `docs/android-avd-camera.md`.

## What it does

- Lists the cameras the system reports through **Camera2** (`CameraManager.cameraIdList`).
  IDs are taken as they come. There is no assumed back/front pair and no hardcoded `"0"`/`"1"`.
- Watches availability with `CameraManager.AvailabilityCallback`, so a camera that
  another app takes is shown as unavailable, and one that comes back is offered again.
- Binds by Camera2 ID (`CameraSelector` filter on `Camera2CameraInfo.cameraId`), and only
  after the camera permission is granted.
- Remembers the selected camera. It is restored only while the system still lists it;
  otherwise the first available camera is used.
- Shows the **switch** button only with two or more usable cameras.
- Marks a camera **active** only while its preview is streaming. "Selected, not bound yet"
  is shown otherwise.
- Explains the permission state, with a rationale, a retry button, and a settings link
  once the permission is permanently denied.
- Has a hidden diagnostics screen (three taps on the title, or `adb shell am start -n
  app.octo.avdcamera/.DiagnosticsActivity`) with the camera list, the selection, recent
  events, and a debug-logging switch.

## Build

Open this folder in Android Studio (Ladybug or newer, JDK 17) and run the `app` configuration on
an AVD or a phone. The Gradle wrapper is not committed. Create it once with a local Gradle 8.7+
install (`gradle wrapper --gradle-version 8.7`), then use the commands below:

```text
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest
```

Minimum API 24. Dependencies: CameraX 1.3.4, AppCompat, core-ktx, lifecycle-livedata.

## Status

Written without a local Android SDK. The XML resources are well-formed and the Kotlin files
pass a structural bracket check; they have **not** been compiled or run. The first
`assembleDebug` and a run on an AVD are the real test.

## Files

- `app/src/main/java/app/octo/avdcamera/MainActivity.kt`: permission flow, binding, state, switch.
- `app/src/main/java/app/octo/avdcamera/CameraCatalog.kt`: camera list, the selection rules, saved selection.
- `app/src/main/java/app/octo/avdcamera/Diagnostics.kt`: logging, the diagnostics report.
- `app/src/main/java/app/octo/avdcamera/DiagnosticsActivity.kt`: the hidden screen.
- `app/src/test/java/app/octo/avdcamera/CameraSelectionTest.kt`: unit tests for the pure rules.
- `app/src/main/res/values/strings.xml`: the five fixed messages and the other labels.
