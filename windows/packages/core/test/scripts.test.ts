/**
 * packages/core/test/scripts.test.ts
 * Static checks of the Windows maintenance scripts (they cannot run on the CI host).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OFFICIAL_REPO, installerArgs, versionFromInstallerName } from '../src';

const root = path.resolve(__dirname, '..', '..', '..');
const scripts = path.join(root, 'scripts');
const ps1 = fs.readFileSync(path.join(scripts, 'lib', 'octo.ps1'));
const ps1Text = ps1.toString('utf8');
const BATS: Record<string, string> = {
  'open.bat': 'open', 'open-detect.bat': 'open-detect', 'install.bat': 'install', 'update.bat': 'update',
  'repair.bat': 'repair', 'uninstall.bat': 'uninstall', 'reset-profile.bat': 'reset-profile',
  'backup-profile.bat': 'backup-profile', 'restore-profile.bat': 'restore-profile',
  'github-update.bat': 'github-update', 'start-all.bat': 'start-all',
  'setup.bat': 'setup', 'run.bat': 'run', 'first-install.bat': 'first-install',
};

describe('maintenance scripts', () => {
  it('all required .bat files exist, are ASCII + CRLF and call octo.ps1 safely', () => {
    for (const [file, cmd] of Object.entries(BATS)) {
      const buf = fs.readFileSync(path.join(scripts, file));
      expect([...buf].every((b) => b < 0x80), `${file} ascii`).toBe(true);
      const text = buf.toString('ascii');
      expect(text.includes('\r\n') && !/[^\r]\n/.test(text), `${file} crlf`).toBe(true);
      expect(text).toContain('DisableDelayedExpansion');
      expect(text).toContain(`-File "%~dp0lib\\octo.ps1" ${cmd} %*`);
    }
  });

  it('octo.ps1 is UTF-8 with BOM (required by Windows PowerShell 5.1 for Polish text)', () => {
    expect([...ps1.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(ps1Text).toContain('Usunięto');
  });

  it('octo.ps1 implements every command and uses the official repository only', () => {
    for (const cmd of Object.values(BATS)) expect(ps1Text).toContain(`'${cmd}' {`);
    expect(ps1Text).toContain(`$OfficialRepo = '${OFFICIAL_REPO}'`);
    expect(ps1Text).toContain('StartsWith("$OfficialBase/")');
  });

  it('github-update talks to the official GitHub repository only and supports both modes', () => {
    // REST API host is pinned to the official repository, downloads stay on the releases URL.
    expect(ps1Text).toContain('$OfficialApi = "https://api.github.com/repos/$OfficialRepo"');
    expect(ps1Text).toContain('if (-not $url.StartsWith("$OfficialApi/")) { Fail (T \'urlNotOfficial\' $url) }');
    // Installed build: release asset -> verify -> back up -> install (silent), rollback copy kept.
    expect(ps1Text).toContain("'^OctoSuite-Setup-.+\\.exe$'");
    expect(ps1Text).toContain('Assert-ManifestResult (Invoke-ManifestVerify $manifest $installer)');
    expect(ps1Text).toContain('function Update-InstalledFromGithub');
    // Development checkout: fast-forward only, never touches local changes.
    expect(ps1Text).toContain('function Update-DevCheckout');
    expect(ps1Text).toContain("Invoke-Git @('pull', '--ff-only')");
    expect(ps1Text).toContain("Fail (T 'ghGitDirty')");
    expect(ps1Text).toContain("Invoke-Npm @('run', 'build')");
    // A pre-release is never treated as a stable update without being marked optional.
    expect(ps1Text).toContain('if ($release.prerelease) { $severity = \'optional\' }');
  });

  it('start-all launches both apps and never lets a failed update block the start', () => {
    expect(ps1Text).toContain('function Invoke-StartAll');
    expect(ps1Text).toContain("Invoke-Open 'octobrowser'");
    expect(ps1Text).toContain("Invoke-Open 'octodetect'");
    expect(ps1Text).toMatch(/catch \{\s*\r?\n\s*Warn \(T 'updateFailed'/);
    expect(ps1Text).toContain('[switch]$NoUpdate');
  });

  it('the installer ships every maintenance script and shortcuts for the new ones', () => {
    const iss = fs.readFileSync(path.join(root, 'installer', 'octosuite.iss'), 'utf8');
    expect(iss).toContain('scripts\\*.bat');
    expect(iss).toContain('scripts\\start-all.bat');
    expect(iss).toContain('scripts\\github-update.bat');
    expect(iss).toContain('WizardStyle=classic');
    expect(iss).toContain('WizardImageFile={#RepoRoot}\\branding\\suite\\installer-wizard.bmp');
    expect(iss).toContain('WizardSmallImageFile={#RepoRoot}\\branding\\suite\\installer-wizard-small.bmp');
    expect(iss).toContain('WizardForm.Color := $000A0A0C');
    expect(iss).toContain('Description: "{cm:LaunchBrowser}"; Flags: nowait postinstall skipifsilent runasoriginaluser');
    expect(iss).toContain('Description: "{cm:LaunchDetect}"; Flags: nowait postinstall skipifsilent unchecked runasoriginaluser');
    expect(fs.existsSync(path.join(root, 'branding', 'suite', 'installer-wizard.bmp'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'branding', 'suite', 'installer-wizard-small.bmp'))).toBe(true);
    for (const lang of ['en', 'pl']) {
      expect(iss).toContain(`${lang}.StartAll=`);
      expect(iss).toContain(`${lang}.GithubUpdate=`);
    }
  });

  it('install/setup can bootstrap a source checkout on its own', () => {
    // No release installer next to the scripts -> set the checkout up instead of failing.
    expect(ps1Text).toContain("if ((Test-DevCheckout) -and -not $Source) { Say (T 'installFromSources' $InstallRoot) 'Cyan'; if (-not (Invoke-Setup)) { Fail (T 'wizardFailed') }; return }");
    // A ZIP downloaded from GitHub has no .git folder - detection must not depend on it.
    const detect = ps1Text.slice(ps1Text.indexOf('function Test-DevCheckout'), ps1Text.indexOf('function Test-GitCheckout'));
    expect(detect).not.toContain("'.git'");
    expect(detect).toContain("'package.json', 'tools\\build.mjs'");
    expect(ps1Text).toContain("function Test-GitCheckout");
    expect(ps1Text).toContain('function Install-Prerequisites');
    // Prerequisites come from the official winget repository, never silently.
    expect(ps1Text).toContain("@{ Id = 'OpenJS.NodeJS.LTS'");
    expect(ps1Text).toContain("@{ Id = 'Git.Git'");
    expect(ps1Text).toContain("'--source', 'winget'");
    // Regression: the display name ("Node.js") is not the command name ("node").
    // Looking the tool up by its display name made a perfectly good Node.js look missing.
    expect(ps1Text).toContain("Cmd = 'node'");
    expect(ps1Text).toContain("Cmd = 'git'");
    expect(ps1Text).toContain('$have = Get-ToolVersion $tool.Cmd');
    expect(ps1Text).not.toContain('Get-ToolVersion $tool.Name');
    // Regression: winget says -1978335189 ("no applicable upgrade") when the package is
    // already installed - that is not a failure.
    expect(ps1Text).toContain('$WingetBenign = @(0, -1978335189, -1978335212)');
    // A console opened before the installer ran has a stale PATH: refresh it and look in
    // the standard install folders before declaring anything missing.
    expect(ps1Text).toContain('function Resolve-Tool');
    expect(ps1Text).toContain("'node' = @('nodejs\\node.exe')");
    expect(ps1Text).toMatch(/function Install-Prerequisites\([^)]*\) \{\s*\r?\n\s*Say \(T 'prereqCheck'\) 'Cyan'\s*\r?\n(\s*#[^\r\n]*\r?\n)*\s*Update-SessionPath/);
    // npm and git are then used by absolute path, so PATH order cannot break the build.
    expect(ps1Text).toContain("$npm = Resolve-Tool 'npm'");
    expect(ps1Text).toContain("$git = Resolve-Tool 'git'");
    expect(ps1Text).toContain("Confirm-Action (T 'prereqAsk')");
    // Node.js requirement stays in sync with package.json engines.
    const engines = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).engines.node as string;
    expect(ps1Text).toContain(`Min = '${engines.replace('>=', '')}'`);
    // Dependencies are checked on every open, after every update, and in setup, through
    // the one script the npm start hooks also run: tools/ensure-deps.mjs decides what to install.
    expect(ps1Text).toContain('function Invoke-EnsureDependencies');
    expect(ps1Text).toContain('ensure-deps.mjs');
    expect(ps1Text).toContain('[void](Invoke-EnsureDependencies)');
    expect(ps1Text).not.toContain('.octo-lock-sha256');
  });

  it('external programs cannot abort the script by writing to stderr', () => {
    // $ErrorActionPreference = 'Stop' turns any native stderr line (npm warn deprecated...,
    // git progress) into a terminating error - everything external goes through Invoke-Native.
    expect(ps1Text).toContain('function Invoke-Native');
    expect(ps1Text).toContain("$ErrorActionPreference = 'Continue'");
    expect(ps1Text).toContain('$r = Invoke-Native $npm $npmArgs $InstallRoot');
    expect(ps1Text).toContain("Fail (T 'ghNpmFailed' ($npmArgs -join ' ') $r.code)");
    // No raw native call is left behind (they would inherit the Stop preference).
    const rawNativeCalls = [...ps1Text.matchAll(/^\s*&\s+\$(?!exe\b)/gm)];
    expect(rawNativeCalls.map((m) => m[0].trim())).toEqual([]);
  });

  it('run.bat starts both apps with no console window and cannot loop', () => {
    const run = fs.readFileSync(path.join(scripts, 'run.bat'), 'ascii');
    expect(run).toContain('if not defined OCTO_HIDDEN');
    expect(run).toContain('lib\\hidden.vbs');
    expect(run).toContain('-WindowStyle Hidden');
    expect(run).toContain('set "OCTO_NOPAUSE=1"');
    // The hidden launcher must set the guard variable, run with window style 0 and refuse quotes.
    const vbs = fs.readFileSync(path.join(scripts, 'lib', 'hidden.vbs'), 'ascii');
    expect(vbs).toContain('environment("OCTO_HIDDEN") = "1"');
    expect(vbs).toContain('shell.Run(commandLine, 0, True)');
    expect(vbs).toContain('If InStr(argument, quote) > 0 Then WScript.Quit 1');
    // run never blocks on a question (the window is invisible).
    expect(ps1Text).toContain('function Invoke-Run');
    // A hidden window can never show a prompt: the setup runs in a visible console instead.
    expect(ps1Text).toContain('function Start-VisibleSetup');
    expect(ps1Text).toContain('function Test-Ready');
    expect(ps1Text).toContain("if (-not (Start-VisibleSetup)) { return }");
    // Electron's development launcher is a .cmd wrapper; it must not reveal a
    // command window after the hidden suite launcher has handed off to the app.
    expect(ps1Text).toMatch(/Start-Process -FilePath \$electron[^\r\n]*-WindowStyle Hidden/);
  });

  it('root forwarders exist for install.bat, run.bat, start.bat, and open.bat', () => {
    for (const [file, target] of [
      ['install.bat', 'scripts\\install.bat'],
      ['first-install.bat', 'scripts\\first-install.bat'],
      ['run.bat', 'scripts\\run.bat'],
      ['start.bat', 'run.bat'],
      ['open.bat', 'scripts\\open.bat']
    ]) {
      const buf = fs.readFileSync(path.join(root, file));
      expect([...buf].every((b) => b < 0x80), `${file} ascii`).toBe(true);
      const text = buf.toString('ascii');
      expect(text.includes('\r\n') && !/[^\r]\n/.test(text), `${file} crlf`).toBe(true);
      expect(text).toContain('DisableDelayedExpansion');
      expect(text).toContain(target);
    }
  });

  it('messages exist in both languages', () => {
    const block = (lang: string) => {
      const start = ps1Text.indexOf(`  ${lang} = @{`);
      const end = ps1Text.indexOf('\n  }', start);
      return [...ps1Text.slice(start, end).matchAll(/^\s{4}(\w+)\s*=/gm)].map((m) => m[1]).sort();
    };
    const en = block('en');
    expect(en.length).toBeGreaterThan(40);
    expect(block('pl')).toEqual(en);
    // Every T 'key' used must be defined.
    const used = new Set([...ps1Text.matchAll(/\(T '(\w+)'/g)].map((m) => m[1]));
    expect([...used].filter((k) => !en.includes(k))).toEqual([]);
  });

  it('never logs secrets and guards against zip slip', () => {
    expect(ps1Text).toContain('function Protect-LogText');
    expect(ps1Text).toMatch(/password\|passwd\|pwd\|token\|secret\|key/);
    expect(ps1Text).toContain("Fail (T 'zipSlip'");
  });
  it('script and app agree on file conventions (bootstrap, rollback installers, restore marker, installer switches)', () => {
    const prepare = fs.readFileSync(path.join(root, 'packages', 'shell', 'src', 'prepare.ts'), 'utf8');
    // portable bootstrap file name
    expect(prepare).toContain('`${info.id}.bootstrap.json`');
    expect(ps1Text).toContain("('{0}.bootstrap.json' -f $appId)");
    // rollback copies: "<version>.exe" is understood by the app
    expect(ps1Text).toContain("('{0}.exe' -f $rel.version)");
    expect(versionFromInstallerName('1.2.3.exe')).toBe('1.2.3');
    // restore marker file name
    const profiles = fs.readFileSync(path.join(root, 'packages', 'core', 'src', 'profiles.ts'), 'utf8');
    expect(profiles).toContain("RESTORED_ENTRY_FILE = 'restored-entry.json'");
    expect(ps1Text).toContain("'restored-entry.json'");
    // update.bat uses the same silent switches as the in-app updater
    for (const sw of installerArgs({ lang: 'en' }).filter((a) => !a.startsWith('/LANG='))) expect(ps1Text).toContain(`'${sw}'`);
    // the installer understands /RELAUNCH
    const iss = fs.readFileSync(path.join(root, 'installer', 'octosuite.iss'), 'utf8');
    expect(iss).toContain("{param:RELAUNCH|}");
    expect(iss).toContain("RelaunchRequested('octobrowser')");
    expect(iss).toContain("RelaunchRequested('octodetect')");
  });

  it('errors exit with 1 and user cancellation with 2', () => {
    expect(ps1Text).toMatch(/function Fail\([^)]*\) \{[^\n]*throw \[System\.Exception\]/);
    expect(ps1Text).toMatch(/function Stop-Cancelled \{[^\n]*OperationCanceledException/);
    expect(ps1Text).not.toContain("Fail (T 'cancelled')");
    expect(ps1Text).not.toContain("Say (T 'cancelled'); return");
  });
});
