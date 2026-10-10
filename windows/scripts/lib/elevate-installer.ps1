# scripts/lib/elevate-installer.ps1
#
# Elevates the complete installer once, rather than asking separately for Visual Studio,
# VB-CABLE, or other privileged prerequisites. Windows still displays its normal UAC prompt;
# this helper never bypasses consent or stores credentials.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BatchPath,
  [Parameter(Mandatory = $true)][string]$WorkingDirectory,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'elevate-installer.ps1 must be started by the unelevated installer wrapper.'
}

if (-not (Test-Path -LiteralPath $BatchPath)) { throw "Installer batch file was not found: $BatchPath" }
if (-not (Test-Path -LiteralPath $WorkingDirectory)) { throw "Installer working directory was not found: $WorkingDirectory" }

function ConvertTo-WindowsArgument([string]$value) {
  if ($null -eq $value -or $value.Length -eq 0) { return '""' }
  if ($value -notmatch '[\s"]') { return $value }
  # Quote according to the Windows command-line convention: backslashes before a quote
  # and trailing backslashes must be doubled so they cannot escape the closing quote.
  $escaped = $value -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

$childArguments = @('-Elevated') + @($Arguments | Where-Object { $_ -ne $null -and $_ -ne '__OCTO_NO_ARGS__' })
$argumentLine = (($childArguments | ForEach-Object { ConvertTo-WindowsArgument ([string]$_) }) -join ' ')
try {
  $commandLine = '/d /c call ' + (ConvertTo-WindowsArgument $BatchPath) + ' ' + $argumentLine
  $child = Start-Process -FilePath $env:ComSpec -ArgumentList $commandLine -WorkingDirectory $WorkingDirectory -Verb RunAs -Wait -PassThru
  exit $child.ExitCode
} catch {
  Write-Error ("The one-time administrator elevation was cancelled or failed: {0}" -f $_.Exception.Message)
  exit 740
}
