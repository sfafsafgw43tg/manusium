import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

import {
  generateSyntheticMacAddress,
  getIsolatedDropFolder,
  generateStudioLinuxProvisionScript,
  DEFAULT_STUDIO_VM_NAME,
  STUDIO_VM_ADB_HOST_PORT,
  STUDIO_VM_VNC_HOST_PORT,
  STUDIO_VM_WEB_HOST_PORT,
  STUDIO_VM_SSH_HOST_PORT,
} from '../src/main/virtualbox-studio-vm';
import { describeIsolation, defaultProfile } from '@octo/core';

describe('virtualbox-studio-vm', () => {
  it('generates valid synthetic MAC addresses with locally administered unicast bit', () => {
    for (let i = 0; i < 10; i++) {
      const mac = generateSyntheticMacAddress();
      expect(mac).toMatch(/^[0-9A-F]{12}$/);
      const firstByte = parseInt(mac.slice(0, 2), 16);
      expect(firstByte & 0x02).toBe(0x02); // locally administered
      expect(firstByte & 0x01).toBe(0); // unicast
    }
  });

  it('provides an isolated drop folder for safe host-guest exchange', () => {
    const tmp = path.join(os.tmpdir(), `octo-test-drop-${Date.now()}`);
    const drop = getIsolatedDropFolder(tmp);
    expect(drop).toBe(tmp);
    expect(fs.existsSync(drop)).toBe(true);
    try { fs.rmdirSync(tmp); } catch { /* ignore */ }
  });

  it('generates a complete unattended bash provisioning script', () => {
    const script = generateStudioLinuxProvisionScript({ avdName: 'OctoTestDevice', targetApi: 34 });
    expect(script).toContain('#!/usr/bin/env bash');
    expect(script).toContain('openjdk-17-jdk');
    expect(script).toContain('qemu-kvm');
    expect(script).toContain('cmdline-tools');
    expect(script).toContain('sdkmanager');
    expect(script).toContain('system-images;android-34;google_apis;x86_64');
    expect(script).toContain('OctoTestDevice');
    expect(script).toContain('android-studio');
    expect(script).toContain('adb -a -P 5555 server nodaemon');
  });

  it('configures standardized host and guest ports', () => {
    expect(DEFAULT_STUDIO_VM_NAME).toBe('Octo-Android-Studio-Linux');
    expect(STUDIO_VM_ADB_HOST_PORT).toBe(15555);
    expect(STUDIO_VM_SSH_HOST_PORT).toBe(10022);
    expect(STUDIO_VM_VNC_HOST_PORT).toBe(15900);
    expect(STUDIO_VM_WEB_HOST_PORT).toBe(16080);
  });

  it('describes isolation correctly for isolated-vm profile mode', () => {
    const p = defaultProfile('antidetect', 'Untraceable Machine Profile');
    p.sandbox.mode = 'isolated-vm';
    const items = describeIsolation(p, {
      downloadsDir: '/downloads',
      windowsSandboxAvailable: false,
      vpnDetected: false,
    });
    const modeItem = items.find((x) => x.labelKey === 'iso.mode');
    expect(modeItem).toBeDefined();
    expect(modeItem?.value).toBe('t:iso.mode.isolated-vm');
    expect(modeItem?.state).toBe('limited');
  });
});
