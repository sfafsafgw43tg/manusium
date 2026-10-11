/**
 * packages/core/test/update-install.test.ts
 * Installer command line used by the in-app updater and rollback file naming.
 */
import { describe, expect, it } from 'vitest';
import { installerArgs, versionFromInstallerName } from '../src';

describe('installerArgs', () => {
  it('runs the installer silently in the app language and relaunches the app', () => {
    const a = installerArgs({ lang: 'pl', relaunch: 'octobrowser', logFile: 'C:\\Users\\Zażółć Gęślą\\logs\\installer.log' });
    expect(a).toEqual([
      '/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS', '/LANG=pl',
      '/RELAUNCH=octobrowser', '/LOG=C:\\Users\\Zażółć Gęślą\\logs\\installer.log',
    ]);
  });

  it('never runs fully invisible (/VERYSILENT) and falls back to English', () => {
    const a = installerArgs({ lang: 'xx' as 'en' });
    expect(a).toContain('/LANG=en');
    expect(a.join(' ')).not.toContain('VERYSILENT');
  });

  it('rejects unknown app ids and log paths that could inject arguments', () => {
    expect(() => installerArgs({ lang: 'en', relaunch: 'calc' as 'octobrowser' })).toThrow();
    expect(() => installerArgs({ lang: 'en', logFile: 'C:\\x" /DIR="C:\\evil' })).toThrow();
    expect(() => installerArgs({ lang: 'en', logFile: 'C:\\x\n/DIR=C:\\evil' })).toThrow();
  });
});

describe('versionFromInstallerName', () => {
  it('accepts both rollback naming schemes', () => {
    expect(versionFromInstallerName('1.4.0.exe')).toBe('1.4.0');
    expect(versionFromInstallerName('OctoSuite-Setup-1.4.0.exe')).toBe('1.4.0');
    expect(versionFromInstallerName('OctoSuite-Setup-2.0.0-beta.1.exe')).toBe('2.0.0-beta.1');
  });

  it('ignores unrelated files instead of throwing', () => {
    for (const f of ['desktop.ini', 'notes.txt', 'setup.exe', '1.4.exe', '..\\1.0.0.exe', 'OctoSuite-Setup-1.0.0.exe.tmp']) {
      expect(versionFromInstallerName(f)).toBeNull();
    }
  });
});
