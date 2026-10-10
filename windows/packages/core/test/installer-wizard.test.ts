/**
 * Contract tests for the graphical installer: the window (scripts/lib/octo-ui.ps1), the work
 * process it starts (octo.ps1 wizard-run) and the messages both use.
 *
 * PowerShell is not available in CI, so these checks read the sources. They pin the rules that
 * must not drift: required steps, success only after a result marker, cancellation that stops
 * the whole process tree, the options that have to change the real installation, and message
 * keys that exist in English and Polish.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '..', '..', '..');
const octo = fs.readFileSync(path.join(root, 'scripts', 'lib', 'octo.ps1'), 'utf8').replace(/^\uFEFF/, '');
const ui = fs.readFileSync(path.join(root, 'scripts', 'lib', 'octo-ui.ps1'), 'utf8').replace(/^\uFEFF/, '');

/** The keys of the English or Polish message dictionary in octo.ps1. */
function dictionaryKeys(lang: 'en' | 'pl'): string[] {
  const lines = octo.split(/\r?\n/);
  const start = lines.indexOf(`  ${lang} = @{`);
  expect(start).toBeGreaterThan(0);
  const end = lines.findIndex((line, index) => index > start && line === '  }');
  return lines
    .slice(start + 1, end)
    .map((line) => /^    ([A-Za-z0-9_]+)\s*=/.exec(line)?.[1])
    .filter((key): key is string => Boolean(key));
}

/** Every message key a script asks for with T 'key'. */
function usedKeys(text: string): string[] {
  return [...text.matchAll(/\bT '([A-Za-z0-9_]+)'/g)].map((match) => match[1]);
}

/** A function body, from its definition up to the next top-level function. */
function functionBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = text.indexOf('\nfunction ', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

describe('window and work process share one protocol', () => {
  it('the work process writes the step, result and log markers the window reads', () => {
    expect(octo).toContain("$parts = @('@@OCTO@@')");
    for (const kind of ['step', 'result', 'log']) {
      expect(octo).toContain(`Write-WizardMarker @('${kind}'`);
      expect(ui).toContain(`'${kind}' {`);
    }
    for (const state of ['start', 'done', 'warn', 'fail', 'skip']) {
      expect(octo).toContain(`@('step', '${state}'`);
      expect(ui).toContain(`'${state}' {`);
    }
  });

  it('the window reads the same marker prefix the work process writes', () => {
    expect(ui).toContain('"@@OCTO@@`t"');
  });
});

describe('success is reported only when every required step succeeded', () => {
  it('only the fatal step stops the run; a failed required step still fails the result', () => {
    const body = functionBody(octo, 'Invoke-WizardRun');
    expect(body).toContain('if ($step.Fatal) { $fatalAt = [string]$step.Key }');
    expect(body).toContain('if ($step.Required -and -not $requiredFailed) { $requiredFailed = [string]$step.Key }');
    // The readiness check runs only when nothing required has failed.
    expect(body).toContain('if (-not $fatalAt -and -not $requiredFailed -and -not (Test-Ready))');
    expect(body).toContain("Write-WizardMarker @('result', 'failed', $requiredFailed)");
    expect(body).toContain("Write-WizardMarker @('result', 'ok', '-')");
    // Steps after the fatal one are reported as skipped, never run.
    expect(body).toContain("Write-WizardMarker @('step', 'skip', $step.Key, $index, $total)");
  });

  it('the fatal flag covers prerequisites and the native runtime build', () => {
    const block = octo.slice(octo.indexOf('function Get-SetupSteps'), octo.indexOf('function Show-InstallerWindow'));
    const fatal = [...block.matchAll(/Key = '(step[A-Za-z]+)'; Required = \$(?:true|false); Fatal = \$true/g)].map((m) => m[1]);
    expect(fatal).toEqual(['stepPrereqs', 'stepRuntimes']);
    expect([...block.matchAll(/Fatal = \$false/g)]).toHaveLength(6);
    expect(octo).toContain('stepRuntimes');
  });

  it('the console installer never reports success after a failed required step', () => {
    const setup = functionBody(octo, 'Invoke-Setup');
    expect(setup).toContain('if (-not $ok -and $step.Required) { $requiredFailed = $true }');
    expect(setup).toContain('if ($requiredFailed) { return $false }');
    // The success line comes after the check, so it is never printed for a failed setup.
    expect(setup.indexOf("Say (T 'setupDone')")).toBeGreaterThan(setup.indexOf('if ($requiredFailed) { return $false }'));
    const first = functionBody(octo, 'Invoke-FirstInstall');
    expect(first).toContain("if ($requiredFailed) { Fail (T 'wizardFailed') }");
    expect(first).toContain("if (-not (Test-Ready)) { Fail (T 'wizardNotReady') }");
    expect(first).toContain("Say (T 'firstInstallSuccess') 'Green'");
    // Every caller checks the result now; none drops it.
    expect(octo).not.toContain('[void](Invoke-Setup)');
    expect(octo).toContain("if (-not (Invoke-Setup)) { Fail (T 'wizardFailed') }");
  });

  it('the labels and the tooltip say what the options really do', () => {
    expect(octo).toContain("'Add Android SDK tools to user PATH (recommended)'");
    expect(octo).not.toContain("'Add Android SDK tools to system PATH'");
    expect(ui).toContain("$ui.VmTip.SetToolTip($ui.Vm, (T 'uiVmTip'))");
    expect(octo).toContain("'Applies only to OctoSuite launches. Does not change global VM settings.'");
    expect(octo).toContain("'Stopping installation... (Background processes may complete).'");
  });

  it('the window needs a result marker and exit code 0, and reports warnings honestly', () => {
    const body = functionBody(ui, 'Complete-WizRun');
    expect(body).toContain('$script:Wiz.ReportedOk -and $exitCode -eq 0');
    expect(body).toContain("if ($optional.Count -gt 0) { $outcome = 'warn' } else { $outcome = 'ok' }");
    // A process that ends without a result counts as failed.
    expect(body).toContain("$outcome = 'failed'");
  });

  it('a step result is its last value, so stray output cannot turn a failure into success', () => {
    expect(octo).toContain('$output = @(& $step.Action)');
    expect(octo).toContain('$ok = ($output.Count -gt 0) -and [bool]$output[-1]');
    expect(functionBody(octo, 'ConvertTo-StepResult')).toContain('[bool]$list[-1]');
  });
});

describe('cancelling stops the whole process tree', () => {
  it('kills with taskkill /T /F and falls back to a plain kill', () => {
    expect(ui).toContain('"/PID " + _process.Id + " /T /F"');
    expect(ui).toContain('_process.Kill()');
    expect(ui).toContain('Stop-WizRun');
  });

  it('the window never runs an install step itself', () => {
    expect(ui).not.toContain('& $step.Action');
    expect(ui).toContain('Octo.SetupRunner');
    expect(ui).toContain('wizard-run -Yes -NoGui -Lang ');
  });
});

describe('the options reach the real installation', () => {
  it('the window hands every option to the work process, which reads each one', () => {
    for (const name of ['OCTO_SETUP_SDK', 'OCTO_SETUP_PROXY', 'OCTO_SETUP_ENVVARS', 'OCTO_SETUP_PATH', 'OCTO_SETUP_VM', 'OCTO_SETUP_STEPS']) {
      expect(ui, name).toContain(name);
    }
    for (const name of ['SDK', 'PROXY', 'STEPS']) {
      expect(octo, name).toContain(`$env:OCTO_SETUP_${name}`);
    }
    // The flags are read through Get-SetupFlag, which adds the OCTO_SETUP_ prefix itself.
    for (const flag of ['ENVVARS', 'PATH', 'VM']) {
      expect(octo, flag).toContain(`Get-SetupFlag '${flag}'`);
    }
  });

  it('the proxy reaches npm, git and the PowerShell downloads of the installation', () => {
    expect(octo).toContain("foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'))");
    expect(octo).toContain('[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy($url)');
  });

  it('the proxy field accepts a plain host:port and refuses credentials', () => {
    expect(octo).toContain(String.raw`'^(https?://)?[A-Za-z0-9.\-]+:\d{1,5}/?$'`);
  });

  it('the Android folder chosen in the window is the SDK step target', () => {
    expect(octo).toContain('Set-AndroidUserEnvironment (Get-AndroidInstallRoot)');
    expect(functionBody(octo, 'Get-AndroidInstallRoot')).toContain('$chosen = [string]$env:OCTO_SETUP_SDK');
  });

  it('Android variables and PATH are written for the account only when chosen', () => {
    const body = functionBody(octo, 'Set-AndroidUserEnvironment');
    expect(body).toContain("Get-SetupFlag 'ENVVARS' $false");
    expect(body).toContain("'ANDROID_HOME', 'ANDROID_SDK_ROOT'");
    expect(body).toContain("[Environment]::SetEnvironmentVariable($name, $root, 'User')");
    expect(body).toContain("Get-SetupFlag 'PATH' $false");
    expect(body).toContain("[Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')");
  });

  it('the VM choice is stored where the launchers read it', () => {
    expect(octo).toContain("Join-Path (Join-Path $env:APPDATA 'OctoSuite') 'install-defaults.json'");
    expect(octo).toContain("Save-InstallDefaults (Get-SetupFlag 'VM' $false)");
    const vm = functionBody(octo, 'Test-VirtualMachine');
    expect(vm).toContain('Read-InstallDefaults');
    expect(vm).toContain('$defaults.vmCompatibility -eq $true');
  });
});

describe('steps and the console installer', () => {
  it('builds Windows Chromium from source and verifies both native executables', () => {
    const chromium = fs.readFileSync(path.join(root, 'tools', 'build-chromium-source.mjs'), 'utf8');
    const firefox = fs.readFileSync(path.join(root, 'tools', 'stage-firefox.mjs'), 'utf8');
    expect(chromium).toContain('fetching Chromium source');
    expect(chromium).toContain('autoninja');
    expect(chromium).toContain("const parentIsGclientCheckout = fs.existsSync(parentGclient);");
    expect(chromium).toContain("['rev-list', '-n', '1', tag]");
    expect(chromium).toContain("['checkout', '--detach', pinnedCommit]");
    expect(chromium).not.toContain("['checkout', '--detach', `refs/tags/${version}`]");
    expect(chromium).toContain('resuming Chromium source checkout (no history, parallel)');
    expect(chromium).toContain("'--no-history'");
    expect(chromium).toContain("'sync', '-n', '-v'");
    expect(chromium).toContain('`-j${jobs}`');
    expect(chromium).toContain("'depot-tools.allowGlobalGitConfig', 'false'");
    expect(chromium).toContain("['sync', '-n', '-v'");
    expect(chromium).toContain('using compatible gclient sync flags');
    expect(chromium).toContain("process.env.DEPOT_TOOLS_UPDATE = '0'");
    expect(chromium).toContain('Do not preserve an inherited DEPOT_TOOLS_UPDATE=1');
    expect(chromium).toContain('automatic self-update disabled');
    expect(chromium).toContain('phase: synchronizing Chromium dependencies');
    expect(chromium).toContain('fetching Chromium source (no history)');
    expect(chromium).toContain('synchronizing Chromium dependencies (no history, parallel)');
    expect(chromium).toContain('isKnownPartial');
    expect(chromium).toContain('OCTO_NO_AUTO_REPAIR');
    expect(chromium).toContain('removing the recognized incomplete Chromium checkout');
    expect(chromium).toContain('displayCommand(command, args, cwd)');
    expect(chromium).toContain('[build-chromium-source] exit:');
    expect(chromium).toContain("spawnSync('where.exe', [command]");
    expect(chromium).toContain("const launchArgs = ['/d', '/s', '/c'");
    expect(chromium).toContain('shell: false');
    expect(chromium).not.toContain('shell: process.platform === \'win32\'');
    expect(chromium).toContain("source checkout is incomplete at ${source}");
    expect(chromium).toContain('`fetch chromium` is only valid in an empty parent directory');
    expect(chromium).toContain("distribution: 'source-built'");
    expect(chromium).not.toContain('chrome-for-testing-public');
    expect(firefox).toContain("'/norestart'");
    expect(firefox).toContain('3010');
    expect(firefox).toContain('fs.copyFileSync(sourceStagedExecutable, executablePath)');
    expect(firefox).not.toContain('fs.renameSync(sourceStagedExecutable, executablePath)');
    const runtimeStep = functionBody(octo, 'Get-SetupSteps');
    expect(runtimeStep).toContain(String.raw`tools\verify-native-engines.mjs`);
    expect(runtimeStep).toContain('Native Chromium/Firefox verification failed');
    expect(runtimeStep).not.toContain("'--allow-missing-firefox'");
    expect(runtimeStep).toContain('Ensure-FirefoxStagingToolchain');
    expect(runtimeStep).toContain('stage:firefox:windows');
    expect(octo).toContain('function Test-NativeRuntimeReady');
    expect(octo).toContain("[string]$manifest.distribution -ne 'source-built'");
    expect(octo).toContain('Get-FileHash -LiteralPath $exe -Algorithm SHA256');
    expect(runtimeStep).toContain("Test-NativeRuntimeReady 'chromium' $target");
    expect(octo).toContain('function Ensure-ChromiumBuildToolchain');
    expect(runtimeStep).toContain('Ensure-ChromiumBuildToolchain');
    expect(octo).toContain("Invoke-Native $gclient @('--version') $depot");
    expect(octo).not.toContain('Invoke-Native $gclient @() $depot');
    expect(octo).toContain('chromium/tools/depot_tools.git');
    expect(octo).toContain('Microsoft.VisualStudio.BuildTools');
    expect(octo).toContain('Microsoft.VisualStudio.Component.VC.Tools.x86.x64');
    expect(octo).toContain('Microsoft.VisualStudio.Component.VC.ATLMFC');
    expect(octo).toContain('Microsoft.VisualStudio.Component.Windows11SDK.22621');
    expect(octo).toContain("@('-latest', '-products', '*', '-requires')");
    expect(octo).toContain('Microsoft.VisualStudio.Workload.NativeDesktop');
    expect(octo).toContain("$vsOverride = '--wait --passive --add Microsoft.VisualStudio.Workload.NativeDesktop");
    expect(octo).toContain("('\"{0}\"' -f $vsOverride)");
    expect(octo).toContain("'--log', $vsLog");
    expect(octo).toContain("-Verb RunAs");
    expect(octo).toContain('Visual Studio winget command: winget');
    expect(octo).toContain('Visual Studio Build Tools installation failed with exit code');
    expect(octo).toContain('$vsWhereArgs');
    expect(octo).toContain("$vsReady = $vsResult.code -eq 0");
    expect(octo).toContain('Ensure-FirefoxStagingToolchain');
    expect(octo).toContain('[System.IO.DriveInfo]::GetDrives()');
    expect(octo).toContain('$minimumChromiumFreeBytes = 100GB');
    expect(octo).toContain("$env:OCTO_CHROMIUM_SOURCE = $sourceRoot");
    expect(octo).toContain('OCTO_CHROMIUM_SOURCE');
    expect(octo).toContain("'depot-tools.allowGlobalGitConfig', 'false'");
    expect(octo).toContain("$env:DEPOT_TOOLS_UPDATE = '0'");
    expect(octo).toContain("GetEnvironmentVariable('DEPOT_TOOLS_UPDATE', 'Process')");
    const runtimeBlock = octo.slice(octo.indexOf("@{ Key = 'stepRuntimes'; Required"), octo.indexOf("@{ Key = 'stepShortcut'; Required"));
    expect(runtimeBlock.indexOf("$env:DEPOT_TOOLS_UPDATE = '0'")).toBeLessThan(runtimeBlock.indexOf('(Ensure-ChromiumBuildToolchain)'));
  });

  it('the eight steps keep their order', () => {
    const keys = [...octo.matchAll(/Key = '(step[A-Za-z]+)'/g)].map((match) => match[1]);
    expect(keys).toEqual(['stepPrereqs', 'stepMedia', 'stepAndroid', 'stepSdk', 'stepDeps', 'stepRuntimes', 'stepShortcut', 'stepBuild']);
  });

  it('the required steps include both native runtimes and the build', () => {
    const block = octo.slice(octo.indexOf('function Get-SetupSteps'), octo.indexOf('function Show-InstallerWindow'));
    const required = [...block.matchAll(/Key = '(step[A-Za-z]+)'; Required = \$true/g)].map((match) => match[1]);
    expect(required).toEqual(['stepPrereqs', 'stepDeps', 'stepRuntimes', 'stepBuild']);
  });

  it('the console installer stops after any fatal step', () => {
    expect(octo).toContain("if (-not $ok -and $step.Key -eq 'stepPrereqs') { return $false }");
    expect(octo).toContain("if (-not $ok -and $step.Fatal) { return $false }");
    expect(octo).toContain('if ($step.Fatal) { break }');
  });
});

describe('messages', () => {
  it('English and Polish have exactly the same keys', () => {
    expect(dictionaryKeys('pl').sort()).toEqual(dictionaryKeys('en').sort());
  });

  it('every message the window and the work process ask for exists in both languages', () => {
    const en = new Set(dictionaryKeys('en'));
    const pl = new Set(dictionaryKeys('pl'));
    for (const key of [...usedKeys(ui), ...usedKeys(octo)]) {
      expect(en.has(key), `en: ${key}`).toBe(true);
      expect(pl.has(key), `pl: ${key}`).toBe(true);
    }
  });

  it('no example text from the screenshots is hard-coded in the window', () => {
    for (const forbidden of ['gosij', '24.21.0', 'Step 2 of 7', 'Node.js found:', 'C:\\Users\\']) {
      expect(ui.includes(forbidden), forbidden).toBe(false);
    }
  });

  it('the version on the page comes from the project, not from the window', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
    expect(functionBody(octo, 'Get-SuiteVersion')).toContain("Join-Path $InstallRoot 'package.json'");
    expect(ui).toContain("(T 'uiVersion' $version)");
    expect(ui.includes(pkg.version)).toBe(false);
  });
});

describe('window structure', () => {
  it('has the four wizard pages and the classic buttons', () => {
    expect(ui).toContain('foreach ($number in 1..4)');
    for (const key of ['uiHeading', 'uiTabComponents', 'uiPageInstalling', 'uiPageDone', 'uiPageFailed', 'uiBack', 'uiNext', 'uiInstall', 'uiCancel', 'uiRetry', 'uiFinish', 'uiClose']) {
      expect(ui, key).toContain(`(T '${key}')`);
    }
  });

  it('uses the black classic palette and starts Octo.su by default after success', () => {
    expect(ui).toContain('Surface = [System.Drawing.Color]::FromArgb(15, 15, 19)');
    expect(ui).toContain('Panel   = [System.Drawing.Color]::FromArgb(24, 24, 31)');
    expect(ui).toContain('$ui.StartApp.Checked = $true');
    expect(ui).toContain("Invoke-Open 'octobrowser'");
  });

  it('keeps the screen responsive: the output is drained on a timer, not in a loop', () => {
    expect(ui).toContain('$ui.Timer.Interval = 150');
    expect(ui).toContain('Invoke-WizTick');
    expect(ui).toContain('$runner.TryReadLine([ref]$line)');
    expect(ui).toContain('uiStillWorking');
    expect(ui).toContain('Chromium\'s source checkout can legitimately take a long time');
    expect(ui).toContain('$text = ([string]$line).Trim()');
    expect(ui).toContain('$script:Wiz.LastOutput = $text');
  });
});
