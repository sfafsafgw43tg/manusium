<#
.SYNOPSIS
  Configure host/virtual cameras for an Android Studio AVD.

.DESCRIPTION
  Uses the Android Emulator's own -webcam-list output as the source of truth.
  Writes hw.camera.back/front to the selected AVD config.ini and, when -Launch
  is supplied, cold-boots the AVD with matching command-line camera flags.

  This script does not install drivers, create kernel camera devices, or invent
  webcamN names. A virtual camera must already be published by OBS Virtual
  Camera, Unity Capture/vStudio, or another DirectShow-compatible provider.

.EXAMPLE
  .\setup-avd-cameras.ps1 -AvdName Pixel_8 -BackCamera webcam0 -Launch

.EXAMPLE
  .\setup-avd-cameras.ps1 -AvdName Pixel_8 -BackCamera webcam1 -FrontCamera webcam0
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]{1,64}$')]
  [string] $AvdName,

  [ValidatePattern('^(none|webcam\d{1,2})$')]
  [string] $BackCamera = 'webcam0',

  [ValidatePattern('^(none|webcam\d{1,2})$')]
  [string] $FrontCamera = 'none',

  [string] $SdkRoot,

  [string] $AvdHome,

  [switch] $AllowUnlisted,

  [switch] $Launch
)

$ErrorActionPreference = 'Stop'

function Find-Tool([string] $Name, [string[]] $Candidates) {
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw "Could not find $Name. Install Android Studio's Emulator component or pass -SdkRoot."
}

$roots = @()
if ($SdkRoot) { $roots += $SdkRoot }
$roots += @($env:ANDROID_HOME, $env:ANDROID_SDK_ROOT, $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }))
$roots = @($roots | Where-Object { $_ } | ForEach-Object { try { (Resolve-Path -LiteralPath $_ -ErrorAction Stop).Path } catch { $null } } | Select-Object -Unique)

$emulatorCandidates = @($roots | ForEach-Object { Join-Path $_ 'emulator\emulator.exe' })
$emulator = Find-Tool 'emulator.exe' $emulatorCandidates

$avdRoots = @()
if ($AvdHome) { $avdRoots += $AvdHome }
$avdRoots += @($env:ANDROID_AVD_HOME, $(if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.android\avd' }))
$avdRoots = @($avdRoots | Where-Object { $_ } | ForEach-Object { try { (Resolve-Path -LiteralPath $_ -ErrorAction Stop).Path } catch { $_ } } | Select-Object -Unique)

$config = $null
foreach ($root in $avdRoots) {
  $candidate = Join-Path $root "$AvdName.avd\config.ini"
  if (Test-Path -LiteralPath $candidate) {
    $config = (Resolve-Path -LiteralPath $candidate).Path
    break
  }
}
if (-not $config) {
  throw "Could not find config.ini for AVD '$AvdName'. Check -AvdHome or create the AVD first."
}

Write-Host "Emulator: $emulator"
Write-Host "AVD:      $AvdName"
Write-Host "Config:   $config"

$listOutput = (& $emulator "@$AvdName" -webcam-list 2>&1 | Out-String)
$listed = @([regex]::Matches($listOutput, '\bwebcam\d{1,2}\b', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase) | ForEach-Object { $_.Value.ToLowerInvariant() } | Select-Object -Unique)
if ($listed.Count -eq 0 -and -not $AllowUnlisted -and ($BackCamera -ne 'none' -or $FrontCamera -ne 'none')) {
  Write-Host $listOutput.Trim()
  throw 'The emulator did not enumerate a host camera. Start OBS/Unity Capture/vStudio, allow Windows camera access, then retry; use -AllowUnlisted only for a saved configuration that will be verified after boot.'
}

foreach ($camera in @($BackCamera, $FrontCamera)) {
  if ($camera -ne 'none' -and -not $AllowUnlisted -and $listed -notcontains $camera.ToLowerInvariant()) {
    throw "$camera is not listed by this emulator. Listed cameras: $($listed -join ', ')"
  }
}
if ($BackCamera -ne 'none' -and $FrontCamera -ne 'none' -and $BackCamera -ieq $FrontCamera) {
  throw 'The same host camera cannot be assigned to both lenses. Choose two webcamN endpoints or set the front camera to none.'
}

function Set-IniValue([string[]] $Lines, [string] $Key, [string] $Value) {
  $escaped = [regex]::Escape($Key)
  $found = $false
  $result = foreach ($line in $Lines) {
    if ($line -match "^\s*$escaped\s*=") {
      if (-not $found) {
        $found = $true
        "$Key=$Value"
      }
    } else {
      $line
    }
  }
  if (-not $found) { $result += "$Key=$Value" }
  return @($result)
}

$lines = @(Get-Content -LiteralPath $config)
$lines = Set-IniValue $lines 'hw.camera.back' $BackCamera
$lines = Set-IniValue $lines 'hw.camera.front' $FrontCamera
Set-Content -LiteralPath $config -Value $lines -Encoding UTF8

Write-Host "Saved hw.camera.back=$BackCamera"
Write-Host "Saved hw.camera.front=$FrontCamera"
if ($listed.Count) { Write-Host "Emulator cameras: $($listed -join ', ')" }

if ($Launch) {
  Write-Host 'Cold-booting the AVD with the saved camera endpoints...'
  $args = @('-avd', $AvdName, '-camera-back', $BackCamera, '-camera-front', $FrontCamera, '-no-snapshot-load', '-no-snapshot-save', '-netdelay', 'none', '-netspeed', 'full')
  Start-Process -FilePath $emulator -ArgumentList $args
  Write-Host 'The emulator was started. Verify the Android Camera app or app.octo.avdcamera preview before treating the camera as active.'
}
