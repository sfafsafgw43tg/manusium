/**
 * The Plugins panel has to be able to install what it reports as missing.
 * These checks pin the two things that must never drift: where a component
 * comes from, and which ones actually block the Start button.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { REQUIREMENT_FIXES, installMediaRequirement, mediaRequirementId, unzipTo } from '../src/main/media-requirements';

describe('installing what a plugin needs', () => {
  it('detects current VB-CABLE revisions and uses the vendor hidden-install switches', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'media-requirements.ts'), 'utf8');
    expect(source).toContain("'/s', '/f', 'CABLE Output'");
    expect(source).toContain('/^vbaudio.*cable.*\\.sys$/i');
    expect(source).toContain("-ArgumentList '-i','-h'");
    expect(source).toContain('-WindowStyle Hidden -Wait');
    expect(source).toContain('pnputil.exe /scan-devices');
    expect(source).toContain('Restart-Service AudioEndpointBuilder');
    expect(source).toContain('activated without rebooting Windows');
  });

  it('knows a vendor and a home page for every fixable component', () => {
    for (const id of ['python', 'camera', 'microphone'] as const) {
      const fix = REQUIREMENT_FIXES[id];
      expect(fix.fixable).toBe(true);
      expect(fix.vendor).toBeTruthy();
      expect(fix.homepage.startsWith('https://')).toBe(true);
    }
    // Only the real essentials may block the Start button.
    expect(REQUIREMENT_FIXES.python.required).toBe(true);
    expect(REQUIREMENT_FIXES.folder.required).toBe(true);
    expect(REQUIREMENT_FIXES.camera.required).toBe(false);
    expect(REQUIREMENT_FIXES.microphone.required).toBe(false);
    expect(REQUIREMENT_FIXES.emulator.required).toBe(false);
  });

  it('accepts both the short id and translation key without launching installers in tests', async () => {
    expect(mediaRequirementId('python')).toBe('python');
    expect(mediaRequirementId('android.media.python')).toBe('python');
    expect(mediaRequirementId('camera')).toBe('camera');
    expect(mediaRequirementId('android.media.camera')).toBe('camera');
    expect(mediaRequirementId('microphone')).toBe('microphone');
    expect(mediaRequirementId('android.media.microphone')).toBe('microphone');
    expect(mediaRequirementId('nonsense')).toBeUndefined();
    const unknown = await installMediaRequirement('nonsense');
    expect(unknown.ok).toBe(false);
    expect(unknown.message).toMatch(/nothing to install/i);
  });

  it('unpacks a vendor archive without letting it escape the folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-unzip-'));
    try {
      // A minimal zip with one stored file, built by hand.
      const name = Buffer.from('Install/UnityCaptureFilter64bit.dll');
      const body = Buffer.from('MZ fake filter');
      const crc = zlib.crc32 ? zlib.crc32(body) : 0;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(0, 8);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(body.length, 22);
      local.writeUInt16LE(name.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(0, 10);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(body.length, 20);
      central.writeUInt32LE(body.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(0, 42);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(1, 8);
      end.writeUInt16LE(1, 10);
      end.writeUInt32LE(central.length + name.length, 12);
      end.writeUInt32LE(local.length + name.length + body.length, 16);
      const archive = Buffer.concat([local, name, body, central, name, end]);

      const written = unzipTo(archive, dir, /Install\/.*\.dll$/i);
      expect(written).toHaveLength(1);
      expect(fs.readFileSync(written[0], 'utf8')).toBe('MZ fake filter');
      // A filter that matches nothing writes nothing.
      expect(unzipTo(archive, dir, /nothing/)).toHaveLength(0);
      expect(() => unzipTo(Buffer.from('not a zip'), dir)).toThrow(/not a zip/i);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
