<#
.SYNOPSIS
  Verify Unity Capture works through an Android Studio AVD without CameraProvider crashes.

.DESCRIPTION
  This is a real Windows acceptance test. It requires the Android Emulator to list
  the selected webcamN endpoint as Unity Capture/vStudio, cold-boots the AVD, runs
  the CameraX diagnostic APK, opens the stock Camera activity, and fails on camera
  service errors, Android runtime crashes, or a missing active preview.

  It never treats config.ini or emulator startup alone as success. The Unity
  Capture producer must already be registered and publishing frames.

.EXAMPLE
  .\test-unity-capture-avd.ps1 -AvdName Google-Pixel-9 -BackCamera webcam0

.EXAMPLE
  .\test-unity-capture-avd.ps1 -AvdName Google-Pixel-9 -BackCamera webcam1 -SkipBuild -KeepEmulator
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]{1,64}$')]
  [string] $AvdName,

  [ValidatePattern('^webcam\d{1,2}$')]
  [string] $BackCamera = 'webcam0',

  [ValidatePattern('^(none|webcam\d{1,2})$')]
  [string] $FrontCamera = 'none',

  [string] $SdkRoot,
  [string] $AvdHome,
  [int] $BootTimeoutSeconds = 180,
  [switch] $SkipBuild,
  [switch] $KeepEmulator
)

$ErrorActionPreference = 'Stop'
$validator = Join-Path $PSScriptRoot 'validate-avd-camera.ps1'
if (-not (Test-Path -LiteralPath $validator)) { throw "Camera validator is missing: $validator" }

$args = @(
  '-ExecutionPolicy', 'Bypass', '-File', $validator,
  '-AvdName', $AvdName,
  '-BackCamera', $BackCamera,
  '-FrontCamera', $FrontCamera,
  '-BootTimeoutSeconds', $BootTimeoutSeconds,
  '-RequireUnityCapture',
  '-TestStockCamera'
)
if ($SdkRoot) { $args += @('-SdkRoot', $SdkRoot) }
if ($AvdHome) { $args += @('-AvdHome', $AvdHome) }
if ($SkipBuild) { $args += '-SkipBuild' }
if ($KeepEmulator) { $args += '-KeepEmulator' }

& powershell.exe @args
if ($LASTEXITCODE -ne 0) {
  throw "Unity Capture AVD acceptance test failed with exit code $LASTEXITCODE. Review android-tools.log and the emulator logs printed above."
}
Write-Host "Unity Capture AVD acceptance test passed: $AvdName / $BackCamera"
