/**
 * Static guards for scripts/lib/octo.ps1. PowerShell is not available in CI, so
 * these checks pin the mistakes that actually broke install.bat: escaped quotes
 * nested inside a `$( ... )` subexpression (a parse error before the script can
 * print anything) and unbalanced braces/parentheses.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const script = path.resolve(__dirname, '..', '..', '..', 'scripts', 'lib', 'octo.ps1');
const source = fs.readFileSync(script, 'utf8');
const lines = source.split(/\r?\n/);

/** Lines that are only a comment carry no code to check. */
function isComment(line: string): boolean {
  return /^\s*#/.test(line);
}

describe('octo.ps1 stays parseable', () => {
  it('never nests escaped quotes inside a subexpression', () => {
    const offenders = lines
      .map((line, index) => ({ line, n: index + 1 }))
      .filter(({ line }) => !isComment(line) && line.includes('$(') && line.includes('`"'));
    expect(offenders.map((o) => `${o.n}: ${o.line.trim()}`)).toEqual([]);
  });

  it('keeps braces and parentheses balanced', () => {
    let braces = 0;
    let parens = 0;
    // Strings and comments are stripped first so their symbols do not count.
    const code = source
      .replace(/(^|\n)\s*#[^\n]*/g, '$1')
      .replace(/'[^'\n]*'/g, "''")
      .replace(/"(?:[^"\n`]|`.)*"/g, '""');
    for (const ch of code) {
      if (ch === '{') braces++;
      else if (ch === '}') braces--;
      else if (ch === '(') parens++;
      else if (ch === ')') parens--;
      expect(braces).toBeGreaterThanOrEqual(0);
    }
    expect({ braces, parens }).toEqual({ braces: 0, parens: 0 });
  });

  it('installs SDK tools but never a system image', () => {
    const packages = /\$AndroidSdkPackages = @\(([^)]*)\)/.exec(source)?.[1] ?? '';
    expect(packages).toContain('platform-tools');
    expect(packages).toContain('cmdline-tools;latest');
    expect(packages).not.toContain('system-images');
    expect(source).not.toContain("'system-images");
  });
});

describe('install.bat covers every dependency', () => {
  it('supports a hidden complete background setup without hiding UAC requirements', () => {
    expect(source).toContain('[switch]$Background');
    expect(source).toContain("background setup requested; using default paths");
    expect(source).toContain('if ($Background)');
    const installBat = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'scripts', 'install.bat'), 'utf8');
    expect(installBat).toContain('OCTO_WANTS_BACKGROUND');
    expect(installBat).toContain('hidden.vbs');
    expect(installBat).toContain('-Background');
    expect(installBat).toContain('starts immediately without a startup elevation handoff');
    expect(installBat).not.toContain('elevate-installer.ps1');
    expect(source).toContain('Visual Studio modification requires administrator rights');
    expect(source).toContain('-Verb RunAs');
  });

  it('keeps media and Android prerequisite tables feature-scoped', () => {
    expect(source).toContain('$MediaPrereqs = @(');
    for (const id of ['Python.Python.3.12', 'OBSProject.OBSStudio', 'VB-Audio.Cable']) {
      const table = /\$MediaPrereqs = @\(([\s\S]*?)\n\)/.exec(source)?.[1] ?? '';
      expect(table).toContain(id);
    }
    const android = /\$AndroidPrereqs = @\(([\s\S]*?)\n\)/.exec(source)?.[1] ?? '';
    for (const id of ['Google.AndroidStudio', 'Microsoft.OpenJDK.17']) expect(android).toContain(id);
    // The Chromium installer does not run either optional table.
    expect(source).not.toContain("Key = 'stepMedia'");
    expect(source).not.toContain("Key = 'stepAndroid'");
    expect(source).not.toContain("Key = 'stepSdk'");
  });

  it('never installs SDK packages into a folder the user cannot write to', () => {
    expect(source).toContain('function Test-FolderWritable');
    expect(source).toContain('function Get-AndroidInstallRoot');
    expect(source).toContain('Save-AndroidInstallRoot $root');
    const installRoot = /function Get-AndroidInstallRoot \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    expect(installRoot).not.toMatch(/ProgramFiles/);
  });
});

describe('Java 17 is enforced by the installer', () => {
  it('checks the version instead of any java.exe', () => {
    expect(source).toContain('$MinJavaMajor = 17');
    expect(source).toContain('function Get-JavaMajor');
    const test = /function Test-JavaPresent \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    expect(test).toContain('Get-ModernJavaHome');
    // The old "any java on PATH is fine" shortcut must not come back.
    expect(test).not.toContain("Get-Command 'java'");
    expect(source).toContain("SKIP_JDK_VERSION_CHECK");
    expect(source).toContain("Microsoft.OpenJDK.17");
  });
});

describe('installer recovers from missing vendor packages', () => {
  it('installs VB-CABLE from the vendor when winget has no package', () => {
    expect(source).toContain('function Install-VbCable');
    expect(source).toContain('VBCABLE_Driver_Pack45.zip');
    const media = /\$MediaPrereqs = @\(([\s\S]*?)\n\)/.exec(source)?.[1] ?? '';
    expect(media).toContain('Fallback = { Install-VbCable }');
  });

  it('downloads the command-line tools when the SDK has none', () => {
    expect(source).toContain('function Install-CommandLineTools');
    expect(source).toMatch(/commandlinetools-win-\d+_latest\.zip/);
    expect(source).toContain('[void](Install-CommandLineTools $root)');
  });

  it('downloads and installs prerequisites directly when winget is missing', () => {
    expect(source).toContain('function Install-PrerequisiteDirect');
    expect(source).toContain('https://nodejs.org/dist/v22.12.0/node-v22.12.0-x64.msi');
    expect(source).toContain('https://github.com/git-for-windows/git/releases/download/v2.47.1.windows.1/Git-2.47.1-64-bit.exe');
  });

  it('does not elevate the whole installer for ordinary prerequisites', () => {
    const vbCable = source.slice(source.indexOf('function Install-VbCable'), source.indexOf('$CmdlineToolsUrls'));
    expect(vbCable).toContain("-Verb RunAs");
    const ordinaryInstall = source.slice(source.indexOf('function Install-Prerequisite($tool)'), source.indexOf('# Returns $true when every prerequisite'));
    expect(ordinaryInstall).not.toContain('-Verb RunAs');
    expect(source).toContain('required MSVC/Windows SDK workload');
  });

  it('supports launching electron.exe directly in dev mode', () => {
    expect(source).toContain("node_modules\\electron\\dist\\electron.exe");
  });

  it('only ever downloads from the allowed vendor hosts', () => {
    const hosts = /\$VendorHosts = @\(([^)]*)\)/.exec(source)?.[1] ?? '';
    expect(hosts).toContain('dl.google.com');
    expect(hosts).toContain('vb-audio.com');
    expect(source).toContain('if ($VendorHosts -notcontains $host_)');
    for (const url of source.match(/https:\/\/[^'"\s)]+/g) ?? []) {
      const host = new URL(url).host;
      const allowed = ['dl.google.com', 'download.vb-audio.com', 'vb-audio.com', 'developer.android.com', 'chromium.googlesource.com',
        'nodejs.org', 'git-scm.com', 'www.python.org', 'obsproject.com', 'github.com',
        'learn.microsoft.com', 'www.npmjs.com'];
      expect(allowed.some((item) => host === item || host.endsWith(`.${item}`))).toBe(true);
    }
  });
});

const uiScript = path.resolve(__dirname, '..', '..', '..', 'scripts', 'lib', 'octo-ui.ps1');
const uiSource = fs.readFileSync(uiScript, 'utf8');

describe('the graphical installer', () => {
  it('parses: balanced braces and no nested escaped quotes', () => {
    const code = uiSource
      .replace(/(^|\n)\s*#[^\n]*/g, '$1')
      .replace(/'[^'\n]*'/g, "''")
      .replace(/"(?:[^"\n`]|`.)*"/g, '""');
    let braces = 0;
    let parens = 0;
    for (const ch of code) {
      if (ch === '{') braces++;
      else if (ch === '}') braces--;
      else if (ch === '(') parens++;
      else if (ch === ')') parens--;
      expect(braces).toBeGreaterThanOrEqual(0);
    }
    expect({ braces, parens }).toEqual({ braces: 0, parens: 0 });
    expect(uiSource.split(/\r?\n/).filter((line) => !/^\s*#/.test(line) && line.includes('$(') && line.includes('`"'))).toEqual([]);
  });

  it('shows progress, the current step and an ETA', () => {
    expect(uiSource).toContain('System.Windows.Forms.ProgressBar');
    expect(uiSource).toContain('function Format-Eta');
    expect(uiSource).toContain("$script:Wiz.CurrentStep = (T 'stepOf'");
    expect(uiSource).toContain("$script:Ui.StepNow.Text = (T 'uiStillWorking'");
    expect(uiSource).toContain('$ui.Eta.Text');
    // The bar counts the steps that really finished in the work process; nothing is animated.
    expect(uiSource).toContain('$ui.Bar.Value = [Math]::Max(0, [Math]::Min(100, $percent))');
    expect(uiSource).toContain("@($steps | Where-Object { $_.Status -eq 'done' -or $_.Status -eq 'warn' }).Count");
  });

  it('coalesces repetitive Git progress while retaining a live heartbeat', () => {
    expect(uiSource).toContain('$isGitProgress = $text -match');
    expect(uiSource).toContain('$script:Wiz.LastProgressLogAt');
    expect(source).toContain('$lastGitProgressAt = [datetime]::MinValue');
    expect(source).toContain('$isGitProgress = $displayLine -match');
    expect(source).toContain('TotalSeconds -ge 15');
  });

  it('offers an install folder and checks it before anything runs', () => {
    expect(uiSource).toContain('FolderBrowserDialog');
    expect(uiSource).toContain('Test-FolderWritable $sdk');
    // The folder reaches the SDK step of the work process, where it is the first candidate.
    expect(uiSource).toContain('OCTO_SETUP_SDK = [string]$script:Wiz.Sdk');
    expect(source).toContain('$chosen = [string]$env:OCTO_SETUP_SDK');
    expect(source).toContain('if ($chosen -and (Test-FolderWritable $chosen)) { return $chosen }');
  });

  it('runs the steps in a separate process and reads its markers', () => {
    expect(uiSource).not.toContain('& $step.Action');
    expect(uiSource).toContain('Octo.SetupRunner');
    expect(uiSource).toContain('wizard-run -Yes -NoGui -Lang ');
    expect(uiSource).toContain('"@@OCTO@@`t"');
    expect(source).toContain("$parts = @('@@OCTO@@')");
    // Success needs the result marker and exit code 0; anything else is a failure.
    expect(uiSource).toContain('$script:Wiz.ReportedOk -and $exitCode -eq 0');
  });

  it('runs exactly the steps the console runs', () => {
    expect(uiSource).toContain('Get-SetupSteps');
    const keys = [...source.matchAll(/Key = '(step[A-Za-z]+)'/g)].map((m) => m[1]);
    expect(keys).toEqual(['stepPrereqs', 'stepDeps', 'stepRuntimes', 'stepShortcut', 'stepBuild']);
    for (const key of keys) {
      // Every step needs a label in both dictionaries.
      expect(source).toContain(`    ${key.padEnd(17)} = '`);
    }
  });
});

describe('the steps are required or optional', () => {
  it('stops for prerequisites, dependencies, and the app build, but not optional native staging', () => {
    const block = source.slice(source.indexOf('function Get-SetupSteps'), source.indexOf('function Show-InstallerWindow'));
    const required = [...block.matchAll(/Key = '(step[A-Za-z]+)'; Required = \$true/g)].map((m) => m[1]);
    const optional = [...block.matchAll(/Key = '(step[A-Za-z]+)'; Required = \$false/g)].map((m) => m[1]);
    expect(required).toEqual(['stepPrereqs', 'stepDeps', 'stepBuild']);
    expect(optional).toEqual(['stepRuntimes', 'stepShortcut']);
  });
});

describe('install.bat is unattended', () => {
  it('asks nothing unless -Interactive is given', () => {
    expect(source).toContain('[switch]$Interactive');
    expect(source).toContain('if (-not $Interactive) { $script:Yes = $true }');
    const confirm = /function Confirm-Action\(\[string\]\$question\) \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    expect(confirm).toContain('if ($script:Yes) { Say $question; return $true }');
    const word = /function Confirm-Word\(\[string\]\$question, \[string\[\]\]\$words\) \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    expect(word).toContain('if ($script:Yes) { Say $question; return $true }');
  });

  it('falls back to the console when no window can be shown', () => {
    expect(source).toContain('function Show-InstallerWindow');
    expect(source).toContain('[switch]$NoGui');
    // The window opens only for a source checkout, and only when the console was not asked for.
    expect(source).toContain('if (-not $NoGui -and -not $Interactive -and (Test-DevCheckout) -and -not $Source) { $outcome = Show-InstallerWindow }');
    expect(source).toContain('if ($null -ne $outcome) { Resolve-WizardOutcome $outcome } else { Invoke-Install }');
    // No window means no outcome, so the console installer takes over.
    expect(uiSource).toContain("if (-not ('System.Windows.Forms.Form' -as [type])) { return $null }");
    // A failure while the window starts is logged; it never aborts the install.
    expect(source).toContain('installer window unavailable: $($_.Exception.Message)');
  });
});

describe('classic visible installer launch', () => {
  const installBat = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'scripts', 'install.bat'), 'utf8');

  it('keeps a normal launch visible and hides only explicit background setup', () => {
    expect(installBat).toContain('lib\\hidden.vbs');
    expect(installBat).toContain('OCTO_HIDDEN');
    expect(installBat).toContain('Only an explicit');
    expect(installBat).toContain('if defined OCTO_WANTS_BACKGROUND if not defined OCTO_WANTS_CONSOLE');
    // There is exactly one hidden relaunch, and it is guarded by the explicit
    // background condition above; the default path reaches PowerShell directly.
    expect((installBat.match(/start "" \/b/g) ?? []).length).toBe(1);
    expect(installBat).toMatch(/find \/i "-nogui"/);
    expect(installBat).toMatch(/find \/i "-interactive"/);
    expect(installBat).toContain('if not defined OCTO_NOPAUSE pause');
  });

  it('hides any console the window is attached to, and restores it', () => {
    expect(uiSource).toContain('GetConsoleWindow');
    expect(uiSource).toContain('function Set-ConsoleVisible');
    expect(uiSource).toContain('Set-ConsoleVisible $false');
    expect(uiSource).toContain('Set-ConsoleVisible $true');
  });
});

describe('desktop shortcut', () => {
  it('is created as its own setup step', () => {
    expect(source).toContain('function New-DesktopShortcut');
    expect(source).toContain("@{ Key = 'stepShortcut'");
    // The step list order: the shortcut is made before the build finishes the run.
    const keys = [...source.matchAll(/Key = '(step[A-Za-z]+)'/g)].map((m) => m[1]);
    expect(keys).toContain('stepShortcut');
  });

  it('points at Octo.su and starts it without a console', () => {
    const fn = /function New-DesktopShortcut \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '';
    expect(fn).toContain("'Octo.su.lnk'");
    expect(fn).toContain("Join-Path $ScriptsDir 'open.bat'");
    expect(fn).toContain('hidden.vbs');
    expect(fn).toContain("branding\\octobrowser\\icon.ico");
    expect(fn).toContain('$cut.WorkingDirectory = $InstallRoot');
    // A failure must never stop the installation.
    expect(fn).toContain("Warn (T 'shortcutFailed'");
  });
});
