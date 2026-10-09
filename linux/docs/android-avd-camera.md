# Cameras and microphone for Android Studio AVD

This is the reference for the camera and microphone of an Android device that
OctoBrowser runs. The only emulator OctoBrowser supports is **Android Studio's
AVD** (the Android Emulator). Physical Android devices use the same native check
app. Every statement below was checked against the code in this repository and
against Android Emulator documentation; where a behaviour depends on the
emulator version it is marked as such.

## 1. How a camera is chosen (the rules the app follows)

| Rule | Where it is enforced |
|---|---|
| The camera list comes from the system. Nothing is invented, and "0"/"1" are never assumed to be back/front. On the host, the names are the ones `emulator -webcam-list` prints; Windows device order is never used to number them. | `CameraCatalog.enumerate` (Android, Camera2); `emulatorWebcams` (main, `emulator -webcam-list`) |
| A saved camera is restored only while it is still available. Otherwise the first available camera is used. | `CameraSelection.resolve` (Android); `assignLensCameras` in `@octo/core/android-camera` (host) |
| A camera is **active** only when it is selected **and** bound (its preview is streaming). On the host, a camera is offered only after it has opened and sent a picture in a check, and the check releases it at once. | `boundId` in `MainActivity` (Android); `checkHostCamera` in `launcher-android-cameras.ts` (host) |
| The switch button appears only with two or more usable cameras. | `CameraSelection.canSwitch` |
| The camera is bound by its Camera2 ID, and only after the permission is granted. | `CameraSelector` filter on `Camera2CameraInfo.cameraId` in `MainActivity.bind` |
| Only active host cameras are offered, for both lenses: the cameras the emulator lists that also sent a picture in the check. The emulator's own test pattern (Emulated) and 3D room (Virtual Scene) are not cameras on this computer, so they are never offered, and there is no "No camera" choice. | `emulatorWebcams` and `androidCameraChoices` (main); the lens pickers in `launcher-android-cameras.ts` |
| One host camera serves one lens. The back lens is settled first, and with one camera it serves the back lens while the front lens is Off. A camera stays on the lens it is on while it is active. | `assignLensCameras` in `@octo/core/android-camera`, used by the picker and by `resolveActiveCameraAssignments` (main) |
| A lens with no active camera left is **Off**: shown as text, never as a choice. Choosing a camera that the other lens holds swaps the two lenses. | `cameraPicker` in `launcher-android-cameras.ts` |
| The host picker re-reads the emulator's list every 5 seconds while it is open, and checks only cameras it has not checked yet. Refresh re-reads and checks every camera. A check is reused for 15 seconds when the picker is opened again, so the creator does not reopen cameras on each step. | `cameraPicker` and `scan` in `launcher-android-cameras.ts`; `androidCameraChoicesCached` (main) |

The sentences the Android check app shows are fixed by the specification (English; Polish translations exist). They are that app's own strings:

- "No camera detected on this device or emulator."
- "Camera permission is required to use the camera."
- "Selected camera is currently unavailable."
- "Unable to start camera preview. Try another camera."
- "For Android Studio AVD, enable Webcam or Virtual Scene in Device Manager if no camera is available."

The OctoBrowser picker has its own empty state. With no working host camera it says that no working camera was found on this computer. When the emulator lists no camera at all, it also points to **Webcam** in Device Manager (section 2). When the Android Emulator is not installed, it says so instead, because no camera can be offered without it.

Emulator detection (`Build.HARDWARE` containing `ranchu`/`goldfish`, `Build.PRODUCT`
starting with `sdk_gphone`) is used **only** to choose the wording of the
"no camera" message and to fill the diagnostics screen. It never decides which
camera is used.

## 2. Device Manager setup (Android Studio)

1. Open **Device Manager**, choose the virtual device's pencil icon (Edit).
2. Open **Show Advanced Settings** → **Camera**.
3. Set **Back** and **Front** to **Webcam**, one webcam per lens. OctoBrowser lists the cameras that `emulator -webcam-list` names and that send a picture on this computer, and writes the one you choose as `webcamN`. Leave a lens on **None** when it should have no camera.
   OctoBrowser never offers **Emulated** or **VirtualScene** (the emulator's own pictures). Set them here only when you use the emulator outside OctoBrowser.
4. Save, then **cold boot** the device (Device Manager → ▾ → *Cold Boot Now*). A camera change is read at boot, so a snapshot can keep the old setting.

Use one host webcam for one lens only. OctoBrowser never sets both lenses to the same `webcamN`: the front lens is Off in that case, because the emulator cannot open one endpoint twice.

## 3. Keys in `config.ini`

The AVD's settings live in `%USERPROFILE%\.android\avd\<name>.avd\config.ini`.
Edit that file (or use the Device Manager), then cold boot. The emulator
derives `hardware-qemu.ini` from `config.ini` when it starts, so **do not edit
`hardware-qemu.ini`**: a change there is expected to be overwritten on the next start
(confirm this on your emulator version before relying on any other behaviour).

| Key | Values | Written by OctoBrowser |
|---|---|---|
| `hw.camera.back` | `none`, `webcam<N>` (OctoBrowser never writes `emulated` or `virtualscene`) | yes |
| `hw.camera.front` | `none`, `webcam<N>` | yes |
| `hw.camera.maxHorizontalPixels` / `hw.camera.maxVerticalPixels` | pixels; the smaller of the two active limits | yes |
| `hw.audioInput` | `yes` / `no` | yes (microphone on/off) |
| `hw.audioOutput` | `yes` / `no` | yes |
| `hw.gpu.enabled` | `yes` / `no` (`no` when the GPU mode is `off`) | yes |
| `hw.ramSize`, `vm.heapSize`, `disk.dataPartition.size` | MB / MB / size string | yes |
| `hw.lcd.width`, `hw.lcd.height`, `hw.lcd.density` | pixels / dpi | yes |

The emulator's own help lists the exact values for the installed version:
`emulator -help-camera-back`, `emulator -help-gpu`, and `emulator -webcam-list`.

### Command-line equivalents

OctoBrowser passes the same choices as launch options:

```text
emulator -avd <name> -camera-back webcam0 -camera-front none
emulator -webcam-list
```

`-camera-back` and `-camera-front` accept the same values as the config keys.

## 4. What the app writes, and what it deliberately does not

Excluded on purpose:

- **Emulated (test pattern) and Virtual Scene (3D room) as choices**: both are pictures the emulator draws, not cameras on this computer. No picker offers them, and no saved value keeps them. A lens without a host camera is Off.
- **`ScreenResolution` and similar keys**: no key of this name was confirmed in the emulator's documentation. An unknown key does nothing, so it is not written.
- **Forcing 1280x720 as a universal fix**: the handset's real panel size is used. A fixed size makes some devices look wrong and does nothing for camera availability.
- **Generic "fingerprint" emulator detection**: detection is used only for messages and diagnostics, never for selection or for hiding anything from apps.
- **ADB commands that edit secure input-method settings or clear system camera data**: these change settings the user did not ask to change and are not needed to make a camera appear. They are not in the scripts or this document.

## 5. Microphone

The emulator has **no command-line option to choose one host microphone**. When
audio input is on, it records from the Windows default recording device. So the
app offers exactly two choices, **on** and **off**, a level meter (the same
device, measured in the launcher), and a note that says so. Do not expect a
per-device choice.

## 5a. Camera check (host)

The host picker lists the cameras that work, and nothing else:

- The list is what `emulator -webcam-list -verbose` prints. The emulator opens every camera before it prints anything, so one camera that does not answer holds the whole list back. OctoBrowser waits up to 45 seconds for the list, then says so. Launches and the media check wait 25 seconds.
- A device path the emulator prints (`\\?\usb#vid_...`) is shown by the camera's Windows name, read from Windows (`Get-PnpDevice`). Its hardware ID (`04f2:b6d0`) is used to find the same camera in the browser, and the name is used when there is no ID.
- Each listed camera is opened once in the browser engine and offered only when it sends a picture within eight seconds (a phone used as a webcam can be slow to start). The stream is released at once, so the emulator or a website can use the camera straight after.
- A camera that is busy, refused by Windows privacy settings, or silent is not offered. One short sentence under the lenses says which. Refresh checks again.
- The picker has no preview tools (no flip, snapshot or clip). It only chooses among the cameras that work.
- The microphone level meter (10 seconds, from the default recording device) stays in the media dialog.

What the check proves: the browser can open and read the camera on this computer, under the name the emulator uses. It does not prove that the emulator's own camera pipeline accepts the same format. The emulator's log and the Android check app (section 6) are the final judges.

## 6. Native check app

`android/avd-camera-check/` is a small CameraX app that answers one question:
does this AVD (or phone) expose the cameras I configured, and can I preview
them? It needs no OctoBrowser code.

Build it with Android Studio (Ladybug or newer) by opening the folder, then Run.
Command line: `gradlew :app:assembleDebug` (requires the Gradle wrapper, which
Android Studio creates on first open). The build has not been run in the
environment where this repository was prepared; treat the first build as the
test.

Diagnostics: three quick taps on the app title, or:

```text
adb shell am start -n app.octo.avdcamera/.DiagnosticsActivity
```

## 7. ADB commands

These are standard ADB commands. None of them changes a system setting. Run them
once on your own Android version to confirm the output format.

```text
adb devices
adb shell pm grant app.octo.avdcamera android.permission.CAMERA
adb shell am start -a android.settings.APPLICATION_DETAILS_SETTINGS -d package:app.octo.avdcamera
adb shell dumpsys media.camera | grep -i "device@"
adb logcat -s AvdCamera:D
adb shell getprop ro.product.model
adb shell getprop ro.hardware
```

`scripts/android/avd-camera-check.sh` runs these in order and prints a summary.

OctoBrowser runs the `pm grant` step itself after each start, once Android is up: `android.permission.CAMERA` for the device's own Camera app when a lens has a camera, and `android.permission.RECORD_AUDIO` when the microphone is on. It reads each grant back with `dumpsys package`, writes the result to `android-tools.log`, and shows a notice in OctoBrowser if Android refuses one. It grants nothing else and changes no secure setting.

## 8. Troubleshooting matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| "No camera detected on this device or emulator." (check app), or "No working camera found on this computer." (OctoBrowser) | Both lenses are `none`, the device was not cold booted after a change, or no camera is listed by the emulator. | Follow section 2 (Device Manager, then Webcam), pick a camera for a lens in OctoBrowser's device settings, press Refresh, then cold boot. |
| "Selected camera is currently unavailable." (check app), or "Some cameras are not sending a picture." (OctoBrowser) | Another application holds the webcam, or the webcam was unplugged. | Close Teams, Zoom, OBS or the browser's camera tab, then press Refresh in the picker or the check app. |
| "Camera permission is required to use the camera." (check app), or "Windows is blocking camera access." (OctoBrowser) | Permission not granted, or denied with "Don't ask again". | OctoBrowser grants the camera and microphone to the device's Camera app after each start, and shows a notice if Android refuses. You can also grant it in the prompt, use **Open app settings**, or run the `pm grant` command above. For OctoBrowser, allow desktop apps to use the camera in the Windows privacy settings, then press Refresh. |
| "Unable to start camera preview. Try another camera." | The webcam index changed after a replug, or the device has no camera service. | Refresh the camera list in OctoBrowser and pick the camera again. Check `emulator -webcam-list`, then cold boot. |
| A camera is missing from the OctoBrowser list | The emulator does not list it, or it is busy, or it sends no picture. | Run `emulator -webcam-list` in a terminal from the Android SDK emulator folder. Close other camera users, then press Refresh. A camera the emulator does not list cannot be used by the device. |
| "Windows sees N camera(s), but the Android Emulator lists none of them." (OctoBrowser) | Windows and the browser can see the cameras, but the emulator's own enumeration did not list them. | Read the next line: it is the emulator's own reason when it gave one. Close the apps that use a camera, press Refresh, then check `android-tools.log`, which holds the `-verbose` output. |
| "The Android Emulator did not finish listing the cameras in time." (OctoBrowser) | The emulator is still opening a camera that does not respond, usually a phone used as a webcam or a virtual camera. | Disconnect the phone or stop its webcam app, close the apps that use the cameras, then press Refresh. |
| "The Android Emulator said: ..." (OctoBrowser) | The emulator logged a failure while it listed the cameras (for example, Media Foundation could not start). | Send the line and the `android-tools.log` file. The line names the step that failed. |
| "Some cameras on the emulator's list could not be found by Windows." (OctoBrowser) | A camera the emulator listed is no longer present for the browser (unplugged, or its name changed). | Reconnect it, then press Refresh. |
| The front lens says Off | Only one active camera exists, and the other lens uses it. One camera cannot serve both lenses. | Plug in a second camera. OctoBrowser never fills the front lens with the emulator's own picture. |
| A lens says Off although a camera is plugged in | The camera is on the other lens, and no other camera is active. | Plug in a second camera, or press Refresh in the picker. |
| The camera is selected and listed, but the device's Camera app shows a black picture | A phone or virtual camera that the emulator cannot read (a phone webcam app, or Windows Phone Link), another program holding the webcam, Windows blocking desktop apps from the camera, or a start from Android Studio that loaded an older quick-boot snapshot. | Choose the computer's built-in camera for Back, then start the device from OctoBrowser. If it is still black, send the log files listed below. If the Camera app shows the emulator's 3D room instead, the device did not start with your webcam: start it from OctoBrowser. |
| Camera works in the native check app but not in a website | Website permission is separate from the app's permission. | Allow the camera for the site in the browser. |
| Android Studio's Device Explorer shows "Permission denied" for folders such as `/apex`, `/cache`, `/mnt/appfuse` or `/mnt/androidwritable` | Normal. The `shell` user cannot read system folders on any device that is not rooted. These rows do not cause a camera failure. | Nothing to fix for the camera. |

OctoBrowser writes these logs in the folder `%USERPROFILE%\.octobrowser\`:

- `android-emulator-<device name>.log`: the emulator's own output for the last launch. It is written while the device runs.
- `android-camera-<device name>.log`: the Android camera service messages for the last launch, written while the device runs.
- `android-tools.log`: every Android SDK tool run, including `emulator -webcam-list`.

## 9. Immediate fix, step by step

For a device that shows no camera at all:

1. Plug in a webcam, so that one is active on this computer. In Device Manager set Back to **Webcam**, then pick the camera in OctoBrowser's device settings.
2. Cold boot the device.
3. Run `scripts/android/avd-camera-check.sh <adb-serial>`.
4. If the check reports no camera, read the matching row in section 8.
