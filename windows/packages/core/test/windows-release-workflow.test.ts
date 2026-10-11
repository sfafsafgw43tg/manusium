import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const windowsRoot = path.join(repoRoot, 'windows');
const workflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'windows-chromium-release.yml'), 'utf8');
const installerE2e = readFileSync(path.join(windowsRoot, 'tools', 'ci', 'installer-e2e.ps1'), 'utf8');

describe('Windows Chromium release pipeline', () => {
  it('uses the configured dedicated Windows Chromium runner', () => {
    expect(workflow).toContain('self-hosted, windows, x64, inkbrowser-chromium');
    expect(workflow).toContain('timeout-minutes: 600');
    expect(workflow).toContain('OCTO_CHROMIUM_SOURCE');
  });

  it('keeps the required fail-fast build and verification order', () => {
    const order = [
      'npm run build:chromium:windows',
      'npm run verify:chromium:windows',
      'npm run dist:browser',
      'npm run verify:chromium:packaged',
      'npm run installer',
    ].map((command) => workflow.indexOf(command));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(workflow).toContain('if ($LASTEXITCODE -ne 0)');
  });

  it('uploads the installer, logs, and packaged runtime evidence', () => {
    expect(workflow).toContain('actions/upload-artifact@v4');
    expect(workflow).toContain('windows/ci-logs/**');
    expect(workflow).toContain('OctoSuite-Setup-*.exe');
    expect(workflow).toContain('runtime.json');
    expect(workflow).toContain('inkbrowser-chrome.exe');
  });

  it('checks the installed runtime payload instead of only the Electron app', () => {
    expect(installerE2e).toContain("Step 'Installed source-built Chromium runtime'");
    expect(installerE2e).toContain("'chrome.dll'");
    expect(installerE2e).toContain("'locales\\en-US.pak'");
    expect(installerE2e).toContain('SHA-256 matches runtime.json');
  });
});
