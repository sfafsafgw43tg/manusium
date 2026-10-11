<#
.SYNOPSIS
  Lists the host cameras the Android Emulator can use, and the camera settings of every AVD.

.DESCRIPTION
  Read-only. Runs `emulator -webcam-list` (the names the emulator accepts as webcam0,
  webcam1, ...), lists the Windows camera devices, and prints the hw.camera.* and
  hw.audioInput keys of each AVD's config.ini. It changes nothing.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\android\avd-host-cameras.ps1
#>
$ErrorActionPreference = 'Continue'

$sdkCandidates = @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android\Sdk')) | Where-Object { $_ }
$emulator = $null
foreach ($sdk in $sdkCandidates) {
  $candidate = Join-Path $sdk 'emulator\emulator.exe'
  if (Test-Path -LiteralPath $candidate) { $emulator = $candidate; break }
}

Write-Host '== Emulator host cameras (emulator -webcam-list) =='
if ($emulator) {
  & $emulator -webcam-list 2>&1 | ForEach-Object { Write-Host "  $_" }
} else {
  Write-Host '  emulator.exe not found. Install Android Studio and its Emulator component.'
}

Write-Host ''
Write-Host '== Windows camera devices (order is not the emulator order) =='
Get-PnpDevice -Class Camera, Image -Status OK -ErrorAction SilentlyContinue |
  ForEach-Object { Write-Host "  $($_.FriendlyName)" }

Write-Host ''
Write-Host '== AVD camera and microphone keys =='
$avdRoot = Join-Path $env:USERPROFILE '.android\avd'
$configs = Get-ChildItem -Path $avdRoot -Filter '*.avd' -Directory -ErrorAction SilentlyContinue
if (-not $configs) { Write-Host "  no AVDs under $avdRoot" }
foreach ($dir in $configs) {
  $config = Join-Path $dir.FullName 'config.ini'
  Write-Host "  [$($dir.BaseName)]"
  if (Test-Path -LiteralPath $config) {
    Get-Content -LiteralPath $config |
      Where-Object { $_ -match '^(hw\.camera\.|hw\.audioInput)' } |
      ForEach-Object { Write-Host "    $_" }
  } else {
    Write-Host '    config.ini missing'
  }
}
