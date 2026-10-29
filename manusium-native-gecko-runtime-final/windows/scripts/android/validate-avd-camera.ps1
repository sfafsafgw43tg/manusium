<#
.SYNOPSIS
  Build and validate a real Android Studio AVD camera end to end.

.DESCRIPTION
  This is the final Windows acceptance test. It locates the Android SDK and JDK,
  builds the standalone CameraX diagnostic APK, validates the selected emulator's
  webcam list, writes the stopped AVD camera configuration, cold-boots one AVD,
  installs the APK, grants CAMERA, and checks the rendered UI for an active stream.

  It never treats config.ini or emulator startup alone as camera success. The
  diagnostic app must report an active CameraX preview. The emulator started by
  this script is stopped on exit unless -KeepEmulator is supplied.

.EXAMPLE
  .\validate-avd-camera.ps1 -AvdName Pixel_8 -BackCamera webcam0

.EXAMPLE
  .\validate-avd-camera.ps1 -AvdName Pixel_8 -BackCamera webcam0 -SkipBuild -KeepEmulator
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

  [int] $BootTimeoutSeconds = 180,

  [switch] $SkipBuild,

  [switch] $KeepEmulator,

  [switch] $RequireUnityCapture,

  [switch] $TestStockCamera,

  [switch] $MockUnityCapture
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$moduleRoot = Join-Path $repoRoot 'android\avd-camera-check'
$setupScript = Join-Path $PSScriptRoot 'setup-avd-cameras.ps1'
$apk = Join-Path $moduleRoot 'app\build\outputs\apk\debug\app-debug.apk'
$serial = 'emulator-5554'
$emulatorProcess = $null
$logRoot = Join-Path $repoRoot 'android-tools.log'

function Fail([string] $Message) {
  throw "[AVD camera validation] $Message"
}

function Resolve-ExistingDirectory([string[]] $Candidates) {
  foreach ($candidate in ($Candidates | Where-Object { $_ } | Select-Object -Unique)) {
    try {
      if (Test-Path -LiteralPath $candidate -PathType Container) {
        return (Resolve-Path -LiteralPath $candidate).Path
      }
    } catch {
      # An inaccessible candidate is ignored so the next SDK candidate can win.
    }
  }
  return $null
}

function Resolve-Tool([string] $Name, [string[]] $Candidates) {
  foreach ($candidate in ($Candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  return $null
}

function Invoke-Checked([string] $FilePath, [string[]] $Arguments, [string] $Description) {
  Write-Host "[AVD camera validation] $Description"
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    Fail "$Description failed with exit code $LASTEXITCODE."
  }
}

function Invoke-Adb([string[]] $Arguments, [string] $Description) {
  Invoke-Checked $adb $Arguments $Description
}

function Get-AdbOutput([string[]] $Arguments) {
  $output = & $adb @Arguments 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { return $null }
  return $output.Trim()
}

if ($MockUnityCapture) {
  if (-not $RequireUnityCapture) { Fail 'MockUnityCapture requires RequireUnityCapture so CI cannot silently become a generic camera test.' }
  if ($BackCamera -ne 'webcam0' -or $FrontCamera -ne 'none') { Fail 'The CI Unity Capture mock supports webcam0 on the rear lens and none on the front lens only.' }
  $mockRoot = Join-Path ([IO.Path]::GetTempPath()) ('octo-avd-camera-mock-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $mockRoot -Force | Out-Null
  try {
    @(
      'hw.camera.back=webcam0'
      'hw.camera.front=none'
      'hw.audioInput=yes'
    ) | Set-Content -LiteralPath (Join-Path $mockRoot 'config.ini') -Encoding UTF8
    $config = Get-Content -LiteralPath (Join-Path $mockRoot 'config.ini') -Raw
    if ($config -notmatch '(?m)^hw\.camera\.back=webcam0\r?$' -or $config -notmatch '(?m)^hw\.camera\.front=none\r?$') {
      Fail 'Mock Unity Capture mapping was not written correctly.'
    }
    [ordered]@{
      mode = 'mock';
      provider = 'Unity Capture/vStudio (synthetic CI endpoint)';
      endpoint = 'webcam0';
      back = 'webcam0';
      front = 'none';
      liveFramesVerified = $false;
      emulatorLaunched = $false;
      config = $config.Trim();
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $repoRoot 'android-camera-mock-result.json') -Encoding UTF8
    Write-Host '[AVD camera validation] MOCK PASS: Unity Capture endpoint identity and AVD mapping contract verified.'
    Write-Host '[AVD camera validation] MOCK LIMIT: no emulator, driver, CameraX preview, or live frames were exercised.'
    exit 0
  } finally {
    Remove-Item -LiteralPath $mockRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$roots = @(
  $SdkRoot,
  $env:ANDROID_HOME,
  $env:ANDROID_SDK_ROOT,
  $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Android\Sdk' })
)
$sdk = Resolve-ExistingDirectory $roots
if (-not $sdk) {
  Fail "Android SDK not found for user '$env:USERNAME'. Set ANDROID_HOME or pass -SdkRoot. Expected path: $(Join-Path $env:LOCALAPPDATA 'Android\Sdk')."
}

$adb = Resolve-Tool 'adb.exe' @(
  (Join-Path $sdk 'platform-tools\adb.exe')
)
$emulator = Resolve-Tool 'emulator.exe' @(
  (Join-Path $sdk 'emulator\emulator.exe')
)
if (-not $adb) { Fail "adb.exe was not found under '$sdk\platform-tools'. Install Android SDK Platform-Tools." }
if (-not $emulator) { Fail "emulator.exe was not found under '$sdk\emulator'. Install Android Emulator." }

$jdkCandidates = @(
  $env:JAVA_HOME,
  $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Android\Android Studio\jbr' }),
  $(if ($env:ProgramFiles) { Join-Path $env:ProgramFiles 'Android\Android Studio\jre' }),
  $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\Android Studio\jbr' })
)
$jdk = Resolve-ExistingDirectory $jdkCandidates
if (-not $jdk) { Fail "JDK 17 was not found. Set JAVA_HOME or install Android Studio's bundled JBR." }
$javac = Join-Path $jdk 'bin\javac.exe'
if (-not (Test-Path -LiteralPath $javac)) { Fail "JDK at '$jdk' has no javac.exe. A JRE is insufficient; install a JDK 17." }
$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:Path = "$(Join-Path $sdk 'platform-tools');$(Join-Path $sdk 'emulator');$(Join-Path $jdk 'bin');$env:Path"

Write-Host "[AVD camera validation] SDK:      $sdk"
Write-Host "[AVD camera validation] JDK:      $jdk"
Write-Host "[AVD camera validation] Emulator: $emulator"
Write-Host "[AVD camera validation] AVD:      $AvdName"

if (-not $SkipBuild) {
  $gradle = Join-Path $moduleRoot 'gradlew.bat'
  if (-not (Test-Path -LiteralPath $gradle)) { Fail "Gradle wrapper is missing at '$gradle'." }
  Push-Location $moduleRoot
  try {
    Invoke-Checked $gradle @(':app:assembleDebug', '--no-daemon') 'Building the diagnostic APK'
  } finally {
    Pop-Location
  }
}
if (-not (Test-Path -LiteralPath $apk)) { Fail "Diagnostic APK was not produced at '$apk'." }

$avds = @(& $emulator -list-avds 2>&1 | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ })
if ($avds -notcontains $AvdName) { Fail "AVD '$AvdName' is not installed. Available AVDs: $($avds -join ', ')" }

$webcams = (& $emulator "@$AvdName" -webcam-list 2>&1 | Out-String)
Write-Host $webcams.Trim()
$listed = @([regex]::Matches($webcams, '\bwebcam\d{1,2}\b', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase) | ForEach-Object { $_.Value.ToLowerInvariant() } | Select-Object -Unique)
if ($RequireUnityCapture) {
  if ($listed -notcontains $BackCamera.ToLowerInvariant()) {
    Fail "Unity Capture endpoint '$BackCamera' was not listed by the Android Emulator. Start the Unity Capture/vStudio producer, then refresh the emulator camera list."
  }
  $cameraLine = ($webcams -split "`r?`n" | Where-Object { $_ -match [regex]::Escape($BackCamera) } | Select-Object -First 1)
  if ($cameraLine -notmatch '(?i)unity\s*(video\s*)?capture|v-?studio') {
    Fail "The selected endpoint '$BackCamera' is not identified as Unity Capture/vStudio by the emulator. Refusing to test an unverified provider."
  }
}
foreach ($camera in @($BackCamera, $FrontCamera)) {
  if ($camera -ne 'none' -and $listed -notcontains $camera.ToLowerInvariant()) {
    Fail "$camera is not listed by this emulator. Listed cameras: $($listed -join ', '). Start the virtual-camera provider and retry."
  }
}
if ($BackCamera -ne 'none' -and $FrontCamera -ne 'none' -and $BackCamera -ieq $FrontCamera) {
  Fail 'The same host camera cannot be assigned to both lenses.'
}

$setupArgs = @('-ExecutionPolicy', 'Bypass', '-File', $setupScript, '-AvdName', $AvdName, '-BackCamera', $BackCamera, '-FrontCamera', $FrontCamera, '-SdkRoot', $sdk)
if ($AvdHome) { $setupArgs += @('-AvdHome', $AvdHome) }
Invoke-Checked 'powershell.exe' $setupArgs 'Writing and validating the stopped AVD camera configuration'

try {
  & $adb kill-server 2>$null
  & $adb start-server | Out-Null
  $emulatorArgs = @('-avd', $AvdName, '-camera-back', $BackCamera, '-camera-front', $FrontCamera, '-no-snapshot-load', '-no-snapshot-save', '-port', '5554')
  Write-Host '[AVD camera validation] Cold-booting the AVD...'
  $emulatorProcess = Start-Process -FilePath $emulator -ArgumentList $emulatorArgs -PassThru

  $deadline = (Get-Date).AddSeconds($BootTimeoutSeconds)
  $booted = $false
  while ((Get-Date) -lt $deadline) {
    $devices = & $adb devices 2>$null | Out-String
    if ($devices -match [regex]::Escape($serial)) {
      $boot = Get-AdbOutput @('-s', $serial, 'shell', 'getprop', 'sys.boot_completed')
      if ($boot -match '1') { $booted = $true; break }
    }
    Start-Sleep -Seconds 2
  }
  if (-not $booted) { Fail "AVD did not finish booting within $BootTimeoutSeconds seconds. Check $logRoot and emulator output." }

  Invoke-Adb @('-s', $serial, 'install', '-r', $apk) 'Installing the diagnostic APK'
  Invoke-Adb @('-s', $serial, 'shell', 'pm', 'grant', 'app.octo.avdcamera', 'android.permission.CAMERA') 'Granting camera permission'
  Invoke-Adb @('-s', $serial, 'shell', 'am', 'start', '-n', 'app.octo.avdcamera/.MainActivity') 'Starting the diagnostic activity'
  Start-Sleep -Seconds 8

  if ($TestStockCamera) {
    $resolved = Get-AdbOutput @('-s', $serial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.media.action.STILL_IMAGE_CAMERA')
    $stockPackage = if ($resolved) { ([regex]::Match($resolved, '(?m)^([A-Za-z][\w.]*)/\S+\s*$')).Groups[1].Value } else { '' }
    if (-not $stockPackage -or $stockPackage -eq 'android') { Fail 'The AVD has no stock Camera activity for the Unity Capture acceptance test.' }
    Invoke-Adb @('-s', $serial, 'shell', 'pm', 'grant', $stockPackage, 'android.permission.CAMERA') 'Granting stock Camera permission'
    Invoke-Adb @('-s', $serial, 'shell', 'am', 'start', '-a', 'android.media.action.STILL_IMAGE_CAMERA') 'Starting the stock Camera activity'
    Start-Sleep -Seconds 8
  }

  $uiDump = Join-Path $env:TEMP 'octo-avd-camera-window.xml'
  & $adb -s $serial shell uiautomator dump /sdcard/window.xml 2>$null | Out-Null
  $ui = & $adb -s $serial shell cat /sdcard/window.xml 2>$null | Out-String
  $media = Get-AdbOutput @('-s', $serial, 'shell', 'dumpsys', 'media.camera')
  $logcat = & $adb -s $serial logcat -d -v brief 2>$null | Out-String
  @(
    '=== ui ==='
    $ui
    '=== media.camera ==='
    $media
    '=== logcat ==='
    $logcat
  ) | Set-Content -LiteralPath $logRoot -Encoding UTF8

  if ($media -match '(?i)Camera error traces \((?!0\d*\))' -or $logcat -match '(?i)FATAL EXCEPTION|CameraProvider.*(crash|fatal|error)|cameraserver.*(crash|fatal)|Camera keeps stopping|android\.hardware\.camera.*(dead|error)') {
    Fail "CameraProvider or the Camera activity reported a crash/error. Full diagnostics were saved to '$logRoot'."
  }

  if ($ui -notmatch 'active' -or $ui -notmatch 'Camera:') {
    Fail "The diagnostic app did not report an active preview. Full diagnostics were saved to '$logRoot'."
  }
  Write-Host "[AVD camera validation] SUCCESS: the diagnostic app reports an active live preview. Diagnostics: $logRoot"
} finally {
  if ($emulatorProcess -and -not $KeepEmulator) {
    & $adb -s $serial emu kill 2>$null | Out-Null
    Wait-Process -Id $emulatorProcess.Id -Timeout 20 -ErrorAction SilentlyContinue
  }
}
