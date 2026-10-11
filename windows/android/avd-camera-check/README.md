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
- Classifies Camera2 enumeration failures in the diagnostics screen. Transient Camera
  service failures and failed preview binds receive up to three bounded re-enumeration/
  rebind attempts. An empty `cameraIdList` is reported as an AVD/HAL configuration
  failure rather than being misreported as a permission problem.
- Opens a barcode scanner from the main screen. The scanner uses CameraX `ImageAnalysis`
  with `STRATEGY_KEEP_ONLY_LATEST` and ML Kit Barcode Scanning, closes every `ImageProxy`,
  and releases the analyzer, scanner, executor, and camera provider with the activity.
  A successful scan returns one `scan_result` to the caller and closes the scanner.
  Bind failures use three bounded CameraX retries; the app never kills `mediaserver` or
  camera-provider processes because that requires system privileges and is unsafe.
- Explains the permission state, with a rationale, a retry button, and a settings link
  once the permission is permanently denied.
- Has a hidden diagnostics screen opened by three taps on the title. It is app-internal
  (`android:exported="false"`) and shows the camera list, selection, recent events, and
  debug-logging switch.

## Build

Open this folder in Android Studio (Ladybug or newer, JDK 17) and run the `app` configuration on
an AVD or a phone. The Gradle wrapper is not committed. Create it once with a local Gradle 8.7+
install (`gradle wrapper --gradle-version 8.7`), then use the commands below:

```text
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest
```

Minimum API 24. Dependencies: CameraX 1.3.4, ML Kit Barcode Scanning 17.2.0, AppCompat, core-ktx, lifecycle-livedata.

## Evidence-based status

| Area | Status | Evidence |
|---|---|---|
| Camera permission declaration and runtime request | Implemented; source-verified | `AndroidManifest.xml`, `MainActivity.kt`, `ScannerActivity.kt` |
| Camera2 enumeration and ID-based selection | Implemented; source-verified | `CameraCatalog.kt`, `MainActivity.bind()` |
| Failure classification and bounded app-level retries | Implemented; source-verified | `CameraCatalog.kt`, `MainActivity.kt`, `ScannerActivity.kt` |
| CameraX preview lifecycle and cleanup | Implemented; source-verified | `MainActivity.kt`, `ScannerActivity.kt` |
| ML Kit barcode analysis and one-shot result return | Implemented; source-verified | `ScannerActivity.kt`, `MainActivity.kt` |
| XML resource validity | Verified in this sandbox | Python `xml.etree.ElementTree` parse |
| Pure camera-selection unit tests | Added; not run here | Requires the Android/Gradle test toolchain |
| Android compilation and unit tests | Not verified | No Gradle, wrapper, Android SDK, or `ANDROID_HOME` is available here |
| ADB, emulator, physical-device, Camera HAL, webcam preview, barcode scan | Not verified | Requires a Windows host with Android SDK, ADB, and a running AVD/device |
| Automatic Windows host-camera fallback | Implemented in the desktop launcher; device-side result not verified | When Windows reports cameras but `emulator -webcam-list` is empty, the launcher can configure `webcam0` for a stopped AVD and cold-boot it; Camera2 preview still decides whether it worked |
| HAL/service restart, SELinux, device properties, custom ROM/AOSP | Intentionally not applied | Out of application scope and potentially destructive/root-only |

The source is not being treated as proof that an APK builds or that an AVD camera works.
The first real build and device run are still required on Windows.

## Files

- `app/src/main/java/app/octo/avdcamera/MainActivity.kt`: permission flow, binding, state, switch.
- `app/src/main/java/app/octo/avdcamera/CameraCatalog.kt`: camera list, failure classification, selection rules, saved selection.
- `app/src/main/java/app/octo/avdcamera/Diagnostics.kt`: logging, the diagnostics report.
- `app/src/main/java/app/octo/avdcamera/DiagnosticsActivity.kt`: the hidden screen.
- `app/src/main/java/app/octo/avdcamera/ScannerActivity.kt`: CameraX preview and ML Kit analyzer.
- `app/src/test/java/app/octo/avdcamera/CameraSelectionTest.kt`: unit tests for the pure rules.
- `app/src/main/res/values/strings.xml`: the five fixed messages and the other labels.

## Windows-host verification checklist

Run these only on the Windows host with the Android SDK and a running AVD/device. Replace
`<package.name>` only when checking another APK; this module uses `app.octo.avdcamera`.

```powershell
adb devices -l
adb shell pm check-permission app.octo.avdcamera android.permission.CAMERA
adb shell pm grant app.octo.avdcamera android.permission.CAMERA
adb shell dumpsys media.camera
adb shell getprop ro.product.model
adb shell getprop ro.hardware
adb logcat -d -s AvdCamera:D CameraService:D cameraserver:D *:S
```

The explicit `pm grant` is the only state-changing command above. Do not substitute
commands that delete camera state, change SELinux/vendor properties, or kill camera
services. The diagnostics screen is intentionally internal and is opened with three
taps on the main title.

For an AVD, use **Android Studio → Device Manager → Edit → Show Advanced Settings →
Camera**, choose **Webcam** for the required lens, save, and select **Cold Boot Now**.
The non-destructive command-line equivalent is:

```powershell
emulator -list-avds
emulator -avd <AVD_NAME> -camera-back webcam0 -camera-front webcam0 -netdelay none -netspeed lte
```

Do not use `-wipe-data` unless deleting the AVD's user data is acceptable.
