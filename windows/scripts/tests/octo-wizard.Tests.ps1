# scripts/tests/octo-wizard.Tests.ps1
#
# Pester 5 tests of the helpers behind the graphical installer (scripts\lib\octo-ui.ps1 and the
# wizard part of scripts\lib\octo.ps1). Only the named functions are loaded, taken from the
# script's syntax tree, so no window opens and no installation step runs.
#
# Run on Windows (CI job "windows" in .github/workflows/ci.yml):
#   pwsh -NoProfile -Command "Invoke-Pester -Path scripts/tests -Output Detailed -CI"

BeforeAll {
  function script:Import-OctoFunction([string]$file, [string]$name) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
    $definition = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true) | Select-Object -First 1
    if (-not $definition) { throw "function $name not found in $file" }
    . ([scriptblock]::Create($definition.Extent.Text))
  }
  $lib = Join-Path $PSScriptRoot '..\lib'
  $octo = (Resolve-Path (Join-Path $lib 'octo.ps1')).ProviderPath
  $ui = (Resolve-Path (Join-Path $lib 'octo-ui.ps1')).ProviderPath
  foreach ($name in @('ConvertTo-ProxyUrl', 'ConvertTo-StepResult', 'ConvertTo-MarkerText', 'Get-SetupFlag')) {
    Import-OctoFunction $octo $name
  }
  foreach ($name in @('Format-Eta', 'ConvertFrom-WizardMarker')) {
    Import-OctoFunction $ui $name
  }
}

Describe 'proxy address of the installer window' {
  It 'accepts host:port and adds http://' {
    ConvertTo-ProxyUrl 'proxy.corp:8080' | Should -Be 'http://proxy.corp:8080'
  }

  It 'keeps https and drops a trailing slash' {
    ConvertTo-ProxyUrl 'https://10.0.0.1:3128/' | Should -Be 'https://10.0.0.1:3128'
  }

  It 'treats an empty field as no proxy' {
    ConvertTo-ProxyUrl '   ' | Should -Be ''
  }

  It 'refuses credentials, a missing port and a port out of range' {
    ConvertTo-ProxyUrl 'user:secret@host:8080' | Should -BeNullOrEmpty
    ConvertTo-ProxyUrl 'host' | Should -BeNullOrEmpty
    ConvertTo-ProxyUrl 'host:70000' | Should -BeNullOrEmpty
  }
}

Describe 'result of an installation step' {
  It 'is the last value the step produced' {
    ConvertTo-StepResult @('some output', $true) | Should -BeTrue
    ConvertTo-StepResult @($true, 'later message', $false) | Should -BeFalse
  }

  It 'counts no output as a failure' {
    ConvertTo-StepResult @() | Should -BeFalse
  }
}

Describe 'marker lines' {
  It 'flattens line breaks and tabs so one marker stays one line' {
    ConvertTo-MarkerText "first`tsecond`r`nthird" | Should -Be 'first second third'
  }

  It 'splits a marker line into its tab-separated fields' {
    $fields = ConvertFrom-WizardMarker ("@@OCTO@@`tstep`tdone`tstepDeps`t5`t7")
    $fields.Count | Should -Be 6
    $fields[1] | Should -Be 'step'
    $fields[3] | Should -Be 'stepDeps'
  }

  It 'returns nothing for an ordinary output line' {
    ConvertFrom-WizardMarker 'Node.js found: 22.22.0' | Should -BeNullOrEmpty
  }
}

Describe 'setup flags from the installer window' {
  AfterEach {
    Remove-Item Env:OCTO_SETUP_PATH -ErrorAction SilentlyContinue
  }

  It 'reads 1 and 0, and uses the default when the flag is not set' {
    $env:OCTO_SETUP_PATH = '1'
    Get-SetupFlag 'PATH' $false | Should -BeTrue
    $env:OCTO_SETUP_PATH = '0'
    Get-SetupFlag 'PATH' $true | Should -BeFalse
    Remove-Item Env:OCTO_SETUP_PATH -ErrorAction SilentlyContinue
    Get-SetupFlag 'PATH' $true | Should -BeTrue
  }
}

Describe 'time left on the progress page' {
  It 'shows nothing before the first step and after the last one' {
    Format-Eta ([timespan]::FromSeconds(10)) 0 7 | Should -BeNullOrEmpty
    Format-Eta ([timespan]::FromSeconds(10)) 7 7 | Should -BeNullOrEmpty
  }

  It 'estimates from the steps finished so far' {
    Format-Eta ([timespan]::FromSeconds(30)) 1 4 | Should -Be '1m 30s'
  }
}
