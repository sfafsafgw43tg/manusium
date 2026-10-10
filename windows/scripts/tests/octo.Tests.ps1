# scripts/tests/octo.Tests.ps1
#
# Pester 5 tests of scripts\lib\octo.ps1 (the logic behind all scripts\*.bat).
# The script under test runs in Windows PowerShell 5.1 (powershell.exe) - the
# version built into Windows 10/11 - exactly like the .bat wrappers do.
#
# Run on Windows (CI job "windows" in .github/workflows/ci.yml):
#   pwsh -NoProfile -Command "Invoke-Pester -Path scripts/tests -Output Detailed -CI"
#
# Everything happens in a throw-away folder whose path contains a space and
# Polish letters; %APPDATA% is redirected so the real bootstrap.json and
# user data are never touched.

BeforeAll {
  $script:Octo = (Resolve-Path (Join-Path $PSScriptRoot '..\lib\octo.ps1')).ProviderPath
  $script:PS51 = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $script:Root = Join-Path ([System.IO.Path]::GetTempPath()) ('Octo test zażółć ' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  $script:AppData = Join-Path $Root 'AppData Roaming'
  $script:Data = Join-Path $Root 'Moje dane\OctoSuite\OctoBrowser'
  $script:ProfileId = 'p-e2e000000001'
  $script:Utf8 = New-Object System.Text.UTF8Encoding($false)

  function script:Get-Sha256Hex([string]$text) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($text)) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
  }

  # Writes profiles.json in the app's VersionedStore envelope format.
  function script:Write-ProfilesDoc([object[]]$profiles) {
    $payload = (@{ schema = 1; profiles = @($profiles) } | ConvertTo-Json -Depth 10 -Compress)
    $envelope = @{ schema = 1; sha256 = (Get-Sha256Hex $payload); encrypted = $false; payload = $payload } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText((Join-Path $Data 'config\profiles.json'), $envelope, $Utf8)
  }

  function script:New-TestProfileEntry {
    return [ordered]@{ id = $ProfileId; name = 'Bank Łódź'; kind = 'custom'; encrypted = $false; color = '#7c3aed' }
  }

  # Runs one octo.ps1 command in Windows PowerShell 5.1 and returns @{ Code; Out }.
  function script:Invoke-Octo([string[]]$arguments) {
    $old = $env:APPDATA
    $env:APPDATA = $AppData
    $env:OCTO_NOPAUSE = '1'
    try {
      $out = & $PS51 -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Octo @arguments 2>&1 | Out-String
      return @{ Code = $LASTEXITCODE; Out = $out }
    } finally { $env:APPDATA = $old }
  }

  function script:Reset-Fixture {
    if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
    foreach ($d in @('config', 'logs', 'backups', "profiles\$ProfileId\engine\Default")) { New-Item -ItemType Directory -Path (Join-Path $Data $d) -Force | Out-Null }
    New-Item -ItemType Directory -Path (Join-Path $AppData 'Octo.su') -Force | Out-Null
    $bootstrap = @{ schema = 1; language = 'pl'; baseDir = (Split-Path -Parent $Data); dataDir = $Data; firstRunAt = '2026-01-01T00:00:00.000Z' } | ConvertTo-Json
    [System.IO.File]::WriteAllText((Join-Path $AppData 'Octo.su\bootstrap.json'), $bootstrap, $Utf8)
    [System.IO.File]::WriteAllText((Join-Path $Data "profiles\$ProfileId\engine\Default\Cookies"), 'cookie-data', $Utf8)
    [System.IO.File]::WriteAllText((Join-Path $Data "profiles\$ProfileId\history.enc"), 'enc-history', $Utf8)
    [System.IO.File]::WriteAllText((Join-Path $Data "profiles\$ProfileId\bookmarks.enc"), 'enc-bookmarks', $Utf8)
    Write-ProfilesDoc @((New-TestProfileEntry))
  }

  function script:Get-Archives { return @(Get-ChildItem -LiteralPath (Join-Path $Data 'backups\profile-archives') -Filter '*.zip' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime) }
}

AfterAll {
  if ($Root -and (Test-Path -LiteralPath $Root)) { Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue }
}

Describe 'octo.ps1 static checks' {
  It 'parses without errors in PowerShell' {
    $tokens = $null; $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($Octo, [ref]$tokens, [ref]$errors)
    $errors | Should -BeNullOrEmpty
  }

  It 'is saved as UTF-8 with BOM' {
    $bytes = [System.IO.File]::ReadAllBytes($Octo)
    ($bytes[0..2] -join ',') | Should -Be '239,187,191'
  }

  It 'implements the GitHub update and start-all commands' {
    $tokens = $null; $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($Octo, [ref]$tokens, [ref]$errors)
    $functions = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true) | ForEach-Object { $_.Name })
    foreach ($f in @('Invoke-GithubUpdate', 'Update-InstalledFromGithub', 'Update-DevCheckout', 'Invoke-StartAll', 'Get-GithubJson', 'Invoke-Npm', 'Invoke-Git')) {
      $functions | Should -Contain $f
    }
    $params = @($ast.ParamBlock.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath })
    $params | Should -Contain 'NoUpdate'
    $text = [System.IO.File]::ReadAllText($Octo)
    foreach ($c in @('github-update', 'start-all')) { $text | Should -BeLike "*'$c' {*" }
  }

  It 'only contacts the official GitHub repository' {
    $text = [System.IO.File]::ReadAllText($Octo)
    # Any GitHub literal must use the single official-repository variable.
    # Non-GitHub URLs are an explicit allowlist of prerequisite vendors.
    $vendors = @(
      'https://nodejs.org/', 'https://git-scm.com/', 'https://www.python.org/downloads/', 'https://obsproject.com/',
      'https://vb-audio.com/Cable/', 'https://developer.android.com/studio',
      'https://learn.microsoft.com/java/openjdk/download', 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip',
      'https://dl.google.com/android/repository/commandlinetools-win-16111833_latest.zip',
      'https://dl.google.com/android/repository/commandlinetools-win-14742923_latest.zip',
      'https://dl.google.com/android/repository/commandlinetools-win-10406996_latest.zip',
      'https://dl.google.com/android/repository/commandlinetools-win-9477386_latest.zip',
      'https://dl.google.com/android/repository/commandlinetools-win-8512546_latest.zip',
      'https://dl.google.com/android/repository/commandlinetools-win-7583922_latest.zip',
      'https://dl.google.com/android/repository/commandlinetools-win-6858069_latest.zip',
      'https://dl.google.com/android/repository/commandlinetools-win-6609375_latest.zip',
      'https://dl.google.com/android/repository/commandlinetools-win-6514223_latest.zip',
      'https://dl.google.com/android/repository/commandlinetools-win-6200805_latest.zip'
    )
    foreach ($m in [regex]::Matches($text, 'https://[^\s\"'')]+')) {
      $u = $m.Value
      if ($u -like 'https://github.com/*') {
        $u | Should -BeLike 'https://github.com/$OfficialRepo*' -Because "unexpected GitHub URL: $u"
      } elseif ($u -like 'https://api.github.com/*') {
        $u | Should -BeLike 'https://api.github.com/repos/$OfficialRepo*' -Because "unexpected GitHub API URL: $u"
      } else {
        $vendors | Should -Contain $u -Because "unexpected vendor URL: $u"
      }
    }
  }

  It 'rejects an unknown command with exit code 1' {
    Reset-Fixture
    $r = Invoke-Octo @('no-such-command', '-Lang', 'en')
    $r.Code | Should -Be 1
  }
}

Describe 'profile backup / reset / restore' {
  BeforeEach { Reset-Fixture }

  It 'backs up a profile to a zip with a matching .sha256 sidecar' {
    $r = Invoke-Octo @('backup-profile', '-Profile', $ProfileId, '-Yes', '-Lang', 'en')
    $r.Code | Should -Be 0 -Because $r.Out
    $zip = (Get-Archives)[-1]
    $zip | Should -Not -BeNullOrEmpty
    $side = [System.IO.File]::ReadAllText("$($zip.FullName).sha256").Trim() -split '\s+'
    $side[0] | Should -Be (Get-FileHash -LiteralPath $zip.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $za = [System.IO.Compression.ZipFile]::OpenRead($zip.FullName)
    try { $names = @($za.Entries | ForEach-Object FullName) } finally { $za.Dispose() }
    $names | Should -Contain 'profile-entry.json'
    $names | Should -Contain 'profile/engine/Default/Cookies'
  }

  It 'finds the profile by its (Polish) name too' {
    $r = Invoke-Octo @('backup-profile', '-Profile', 'Bank Łódź', '-Yes', '-Lang', 'pl')
    $r.Code | Should -Be 0 -Because $r.Out
  }

  It 'resets a profile (engine, history) but keeps bookmarks and makes a backup first' {
    $r = Invoke-Octo @('reset-profile', '-Profile', $ProfileId, '-Yes', '-Lang', 'en')
    $r.Code | Should -Be 0 -Because $r.Out
    Test-Path -LiteralPath (Join-Path $Data "profiles\$ProfileId\engine\Default\Cookies") | Should -BeFalse
    Test-Path -LiteralPath (Join-Path $Data "profiles\$ProfileId\history.enc") | Should -BeFalse
    Test-Path -LiteralPath (Join-Path $Data "profiles\$ProfileId\bookmarks.enc") | Should -BeTrue
    (Get-Archives).Count | Should -Be 1
  }

  It 'restores a profile from its newest archive' {
    (Invoke-Octo @('backup-profile', '-Profile', $ProfileId, '-Yes')).Code | Should -Be 0
    Remove-Item -LiteralPath (Join-Path $Data "profiles\$ProfileId\engine") -Recurse -Force
    $r = Invoke-Octo @('restore-profile', '-Profile', $ProfileId, '-Yes', '-Lang', 'en')
    $r.Code | Should -Be 0 -Because $r.Out
    [System.IO.File]::ReadAllText((Join-Path $Data "profiles\$ProfileId\engine\Default\Cookies")) | Should -Be 'cookie-data'
    Test-Path -LiteralPath (Join-Path $Data "profiles\$ProfileId\restored-entry.json") | Should -BeFalse
  }

  It 'leaves a restore marker for the app when the profile entry was deleted' {
    (Invoke-Octo @('backup-profile', '-Profile', $ProfileId, '-Yes')).Code | Should -Be 0
    $zip = (Get-Archives)[-1].FullName
    Write-ProfilesDoc @()   # profile removed from the list
    Remove-Item -LiteralPath (Join-Path $Data "profiles\$ProfileId") -Recurse -Force
    $r = Invoke-Octo @('restore-profile', '-Archive', $zip, '-Yes', '-Lang', 'en')
    $r.Code | Should -Be 0 -Because $r.Out
    $marker = Join-Path $Data "profiles\$ProfileId\restored-entry.json"
    Test-Path -LiteralPath $marker | Should -BeTrue
    ([System.IO.File]::ReadAllText($marker) | ConvertFrom-Json).id | Should -Be $ProfileId
    # The script never edits profiles.json itself.
    $envelope = [System.IO.File]::ReadAllText((Join-Path $Data 'config\profiles.json')) | ConvertFrom-Json
    @(($envelope.payload | ConvertFrom-Json).profiles).Count | Should -Be 0
  }

  It 'refuses a tampered archive (exit code 1)' {
    (Invoke-Octo @('backup-profile', '-Profile', $ProfileId, '-Yes')).Code | Should -Be 0
    $zip = (Get-Archives)[-1].FullName
    $fs = [System.IO.File]::Open($zip, [System.IO.FileMode]::Append)
    try { $fs.WriteByte(0x41) } finally { $fs.Dispose() }
    $r = Invoke-Octo @('restore-profile', '-Archive', $zip, '-Yes', '-Lang', 'en')
    $r.Code | Should -Be 1 -Because $r.Out
    [System.IO.File]::ReadAllText((Join-Path $Data "profiles\$ProfileId\engine\Default\Cookies")) | Should -Be 'cookie-data'
  }

  It 'blocks path traversal in archives (zip slip)' {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $evilZip = Join-Path $Root 'evil archive.zip'
    $fs = [System.IO.File]::Open($evilZip, [System.IO.FileMode]::CreateNew)
    try {
      $za = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
      try {
        foreach ($pair in @(@('profile-entry.json', ((New-TestProfileEntry) | ConvertTo-Json)), @('profile/../../../../escaped.txt', 'pwned'))) {
          $w = New-Object System.IO.StreamWriter($za.CreateEntry($pair[0]).Open(), $Utf8)
          try { $w.Write($pair[1]) } finally { $w.Dispose() }
        }
      } finally { $za.Dispose() }
    } finally { $fs.Dispose() }
    $r = Invoke-Octo @('restore-profile', '-Archive', $evilZip, '-Yes', '-Lang', 'en')
    $r.Code | Should -Be 1 -Because $r.Out
    @(Get-ChildItem -LiteralPath $Root -Recurse -Filter 'escaped.txt' -File -ErrorAction SilentlyContinue).Count | Should -Be 0
    # The existing profile is untouched.
    [System.IO.File]::ReadAllText((Join-Path $Data "profiles\$ProfileId\engine\Default\Cookies")) | Should -Be 'cookie-data'
  }

  It 'rejects invalid profile ids from archives' {
    Add-Type -AssemblyName System.IO.Compression
    $badZip = Join-Path $Root 'bad id.zip'
    $fs = [System.IO.File]::Open($badZip, [System.IO.FileMode]::CreateNew)
    try {
      $za = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
      try {
        $w = New-Object System.IO.StreamWriter($za.CreateEntry('profile-entry.json').Open(), $Utf8)
        try { $w.Write((@{ id = '..\..\Windows'; name = 'x'; kind = 'custom' } | ConvertTo-Json)) } finally { $w.Dispose() }
      } finally { $za.Dispose() }
    } finally { $fs.Dispose() }
    $r = Invoke-Octo @('restore-profile', '-Archive', $badZip, '-Yes', '-Lang', 'en')
    $r.Code | Should -Be 1 -Because $r.Out
  }
}

Describe 'logging' {
  It 'writes a log into the data folder without secrets or the full user path' {
    Reset-Fixture
    (Invoke-Octo @('backup-profile', '-Profile', $ProfileId, '-Yes', '-Lang', 'en')).Code | Should -Be 0
    $log = Get-ChildItem -LiteralPath (Join-Path $Data 'logs') -Filter 'scripts-*.log' -File | Select-Object -First 1
    $log | Should -Not -BeNullOrEmpty
    $text = [System.IO.File]::ReadAllText($log.FullName)
    $text | Should -Match 'end code=0'
    if ($env:USERPROFILE) { $text | Should -Not -Match ([regex]::Escape($env:USERPROFILE)) }
  }
}
