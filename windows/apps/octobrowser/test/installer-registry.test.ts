import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const iss = readFileSync(resolve(process.cwd(), 'installer/octosuite.iss'), 'utf8');
const doc = readFileSync(resolve(process.cwd(), 'docs/registry-integration.md'), 'utf8');

describe('Windows optional registry integration', () => {
  it('is opt-in and remains per-user', () => {
    expect(iss).toContain('Name: "protocol"; Description: "{cm:Protocol}"; Flags: unchecked');
    expect(iss).toContain('Name: "registry"; Description: "{cm:RegistryIntegration}"; Flags: unchecked');
    expect(iss).toContain('Root: HKCU; Subkey: "Software\\Classes\\octobrowser"');
    expect(iss).toContain('Root: HKCU; Subkey: "Software\\Classes\\.octoprofile"');
    expect(iss).not.toContain('Root: HKLM; Subkey: "Software\\Classes\\octobrowser"');
  });

  it('backs up values before install and restores only unchanged app-owned values', () => {
    expect(iss).toContain('PrepareRegistryStateForInstall');
    expect(iss).toContain('BackupSelectedRegistryState');
    expect(iss).toContain('if Current <> Expected then Exit;');
    expect(iss).toContain('RestoreAllRegistryState');
    expect(iss).toContain('RegDeleteKey(HKCU');
    expect(iss).not.toContain('uninsdeletekey');
  });

  it('does not put sensitive profile data in registry state or registry values', () => {
    expect(iss.toLowerCase()).not.toMatch(/password|cookie|history|session|fingerprint/);
    expect(doc.toLowerCase()).toContain('never stores passwords');
    expect(doc.toLowerCase()).toContain("does **not** copy another browser's");
    expect(doc.toLowerCase()).toContain('security controls');
  });

  it('handles both uninstall restoration and install-time opt-out', () => {
    expect(iss).toContain('if CurUninstallStep = usUninstall then');
    expect(iss).toContain('if CurStep = ssInstall then');
    expect(iss).toContain('if FileExists(State) then DeleteFile(State);');
  });
});
