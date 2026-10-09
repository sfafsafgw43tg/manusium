# tools/ci/installer-e2e.ps1
#
# End-to-end test of the RELEASE ARTIFACTS on Windows (CI job "windows"):
#   1. silent per-user install of release\OctoSuite-Setup-<version>.exe
#   2. installed layout (both apps, scripts, licenses)
#   3. release verification through the installed app (--verify-manifest):
#      valid release -> 0, tampered installer -> 12, tampered manifest -> 11
#   4. packaged smoke start of both apps (fused binaries, app.asar integrity)
#      in an ephemeral data folder; they must stay alive and log "app.start"
#   5. octobrowser:// registration, then silent uninstall removes files and the handler
#
# Prerequisites: npm run dist:dir, npm run installer, sign-manifest, hashes
# (with a throw-away CI key from tools/update-keygen.mjs).
# Usage: pwsh -File tools/ci/installer-e2e.ps1

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).ProviderPath
$version = (Get-Content -Raw (Join-Path $root 'package.json') | ConvertFrom-Json).version
$release = Join-Path $root 'release'
$setup = Join-Path $release "OctoSuite-Setup-$version.exe"
$manifest = Join-Path $release 'latest.json'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\OctoSuite'
$work = Join-Path ([System.IO.Path]::GetTempPath()) ('octo installer e2e zażółć ' + [guid]::NewGuid().ToString('N').Substring(0, 6))
New-Item -ItemType Directory -Path $work -Force | Out-Null

function Step([string]$text) { Write-Host "`n=== $text" -ForegroundColor Cyan }
function Assert([bool]$cond, [string]$text) { if (-not $cond) { throw "ASSERTION FAILED: $text" }; Write-Host "  ok: $text" -ForegroundColor Green }

function Invoke-Verify([string]$exe, [string]$man, [string]$inst) {
  $result = Join-Path $work ('verify-' + [guid]::NewGuid().ToString('N') + '.json')
  $argList = @("--verify-manifest=`"$man`"", "--verify-result=`"$result`"")
  if ($inst) { $argList += "--verify-installer=`"$inst`"" }
  $p = Start-Process -FilePath $exe -ArgumentList $argList -Wait -PassThru -WindowStyle Hidden
  $json = if (Test-Path -LiteralPath $result) { Get-Content -Raw -LiteralPath $result | ConvertFrom-Json } else { $null }
  return @{ Code = $p.ExitCode; Result = $json }
}

foreach ($f in @($setup, $manifest, "$manifest.sig", (Join-Path $release 'SHA256SUMS.txt'))) { Assert (Test-Path -LiteralPath $f) "release file exists: $(Split-Path -Leaf $f)" }

Step 'Silent per-user install'
$log = Join-Path $work 'setup.log'
$p = Start-Process -FilePath $setup -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', "/LOG=`"$log`"") -Wait -PassThru
if ($p.ExitCode -ne 0 -and (Test-Path -LiteralPath $log)) { Get-Content -LiteralPath $log -Tail 40 }
Assert ($p.ExitCode -eq 0) "installer exit code 0 (got $($p.ExitCode))"

Step 'Installed layout'
$obExe = Join-Path $installDir 'OctoBrowser\Octo.su.exe'
$odExe = Join-Path $installDir 'OctoDetect\OctoDetect.su.exe'
foreach ($rel in @('OctoBrowser\Octo.su.exe', 'OctoBrowser\resources\app.asar', 'OctoDetect\OctoDetect.su.exe', 'OctoDetect\resources\app.asar',
    'scripts\open.bat', 'scripts\update.bat', 'scripts\restore-profile.bat', 'scripts\lib\octo.ps1', 'licenses\THIRD-PARTY-NOTICES.txt', 'LICENSE', 'unins000.exe')) {
  Assert (Test-Path -LiteralPath (Join-Path $installDir $rel)) "installed: $rel"
}
Assert ((Get-Item -LiteralPath $obExe).VersionInfo.ProductVersion -like "$version*") "Octo.su.exe product version $version"

Step 'Release verification through the installed apps'
foreach ($exe in @($obExe, $odExe)) {
  $ok = Invoke-Verify $exe $manifest $setup
  Assert ($ok.Code -eq 0 -and $ok.Result.ok) "$(Split-Path -Leaf $exe): valid release accepted (code $($ok.Code))"
}
$badSetup = Join-Path $work "OctoSuite-Setup-$version.exe"
Copy-Item -LiteralPath $setup -Destination $badSetup
$fs = [System.IO.File]::Open($badSetup, [System.IO.FileMode]::Append); try { $fs.WriteByte(0x42) } finally { $fs.Dispose() }
$bad = Invoke-Verify $obExe $manifest $badSetup
Assert ($bad.Code -eq 12) "tampered installer rejected with 12 (got $($bad.Code))"
$badManifest = Join-Path $work 'latest.json'
Copy-Item -LiteralPath "$manifest.sig" -Destination "$badManifest.sig"
(Get-Content -Raw -LiteralPath $manifest) -replace '"severity":\s*"[a-z]+"', '"severity":"security"' | Set-Content -LiteralPath $badManifest -NoNewline -Encoding utf8NoBOM
$bad2 = Invoke-Verify $obExe $badManifest $null
Assert ($bad2.Code -eq 11) "modified manifest rejected with 11 (got $($bad2.Code))"

Step 'Packaged smoke start (fuses + asar integrity)'
foreach ($app in @(@{ Exe = $obExe; Sub = 'OctoBrowser'; Id = 'octobrowser' }, @{ Exe = $odExe; Sub = 'OctoDetect'; Id = 'octodetect' })) {
  $data = Join-Path $work "data $($app.Id)"
  $proc = Start-Process -FilePath $app.Exe -ArgumentList @("--ephemeral-data-dir=`"$data`"", '--lang-choice=pl', '--allow-elevated') -PassThru
  $deadline = (Get-Date).AddSeconds(60)
  $started = $false
  while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
    $logs = Join-Path $data "$($app.Sub)\logs"
    if (Test-Path -LiteralPath $logs) {
      $hit = Get-ChildItem -LiteralPath $logs -Filter '*.log' -File -ErrorAction SilentlyContinue | Where-Object { (Get-Content -Raw -LiteralPath $_.FullName) -match 'app\.start' }
      if ($hit) { $started = $true; break }
    }
    Start-Sleep -Milliseconds 500
  }
  $alive = -not $proc.HasExited
  Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension($app.Exe)) -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Assert $started "$($app.Id): packaged app started and logged app.start"
  Assert $alive "$($app.Id): packaged app did not crash"
}
# The ELECTRON_RUN_AS_NODE fuse is off: the exe must not act as a Node.js interpreter.
$env:ELECTRON_RUN_AS_NODE = '1'
try {
  $marker = Join-Path $work 'runasnode.txt'
  $p = Start-Process -FilePath $odExe -ArgumentList @('-e', "require('fs').writeFileSync(process.argv[1],'x')", "`"$marker`"") -PassThru
  if (-not $p.WaitForExit(20000)) { $p.Kill() }
  Get-Process -Name 'OctoDetect.su' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Assert (-not (Test-Path -LiteralPath $marker)) 'ELECTRON_RUN_AS_NODE is ignored (runAsNode fuse off)'
} finally { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }

Step 'octobrowser:// protocol registration'
$proto = 'HKCU:\Software\Classes\octobrowser\shell\open\command'
Assert (Test-Path -LiteralPath $proto) 'octobrowser:// handler registered (per user)'
Assert ((Get-ItemProperty -LiteralPath $proto).'(default)' -like "*Octo.su.exe*") 'handler points to Octo.su.exe'

Step 'Silent uninstall'
$p = Start-Process -FilePath (Join-Path $installDir 'unins000.exe') -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -Wait -PassThru
Assert ($p.ExitCode -eq 0) "uninstaller exit code 0 (got $($p.ExitCode))"
# The uninstaller copies itself to %TEMP% and finishes asynchronously.
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline -and (Test-Path -LiteralPath $obExe)) { Start-Sleep -Milliseconds 500 }
Assert (-not (Test-Path -LiteralPath $obExe)) 'program files removed'
Assert (-not (Test-Path -LiteralPath 'HKCU:\Software\Classes\octobrowser')) 'octobrowser:// handler removed'

Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "`nInstaller E2E passed." -ForegroundColor Green
