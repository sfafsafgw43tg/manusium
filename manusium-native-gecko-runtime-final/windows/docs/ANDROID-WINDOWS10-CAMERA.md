# Android Emulator camera on Windows 10

## Important limitation

The Octo Media Foundation virtual-camera implementation requires Windows 11 build 22000 or newer. On Windows 10, registering the native Octo camera is not sufficient for Android Emulator discovery. A Windows 10-compatible DirectShow virtual-camera provider must expose a camera device to the Windows camera graph.

The CI mock mode does not provide frames and must not be used as proof that a real camera works.

## Real Windows 10 setup

1. Install a Windows 10-compatible virtual-camera provider that exposes a DirectShow/Media Foundation camera. OBS Studio's Virtual Camera is a common choice; other providers are acceptable if Windows and the Android Emulator enumerate them.
2. Start the provider and start its virtual camera output. A running UI alone is not enough.
3. Verify Windows exposes the provider as a camera device. It must appear under Windows camera/image devices, not only as an audio or registry entry.
4. Close any application that may exclusively hold the camera.
5. Run the emulator discovery command:

   ```powershell
   $sdk = "$env:LOCALAPPDATA\Android\Sdk"
   & "$sdk\emulator\emulator.exe" @Google-Pixel-9 -webcam-list
   ```

6. Continue only if the output contains a `webcamN` endpoint. The endpoint name is assigned by the emulator and may change after devices are added or removed.
7. Run the live acceptance test with the listed endpoint:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
     .\scripts\android\test-unity-capture-avd.ps1 `
     -AvdName Google-Pixel-9 `
     -BackCamera webcam0 `
     -SdkRoot "$env:LOCALAPPDATA\Android\Sdk" `
     -AvdHome "$env:USERPROFILE\.android\avd"
   ```

The test will reject an endpoint that is not listed by the emulator or is not identified as Unity Capture/vStudio. It then cold-boots the AVD, runs the CameraX diagnostic app, opens the stock Camera activity, and scans CameraService and logcat for failures.

## CI mode

Windows CI cannot reliably provide a real desktop camera. Use:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  .\scripts\android\test-unity-capture-avd.ps1 `
  -AvdName CI-Mock -BackCamera webcam0 -MockUnityCapture
```

A successful mock run proves only that the Unity Capture endpoint identity and AVD mapping contract are preserved. Its result explicitly contains `liveFramesVerified: false`; it does not boot an emulator, load a driver, or test CameraX frame delivery.
