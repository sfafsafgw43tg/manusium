/**
 * The camera and microphone permissions the device's own Camera app needs.
 * Android never grants them by itself, so OctoBrowser grants them after boot,
 * reads them back from the device, and reports a refusal instead of hiding it.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cameraAppFromResolveOutput, grantRefusalIn, mediaPermissionsFor, permissionGrantedIn } from '../src/main/android-studio';

describe('which permissions the Camera app needs', () => {
  it('needs nothing when both lenses and the microphone are off', () => {
    expect(mediaPermissionsFor({ cameraFront: 'none', cameraBack: 'none', microphoneEnabled: false })).toEqual([]);
  });

  it('needs the camera when either lens has a camera', () => {
    expect(mediaPermissionsFor({ cameraFront: 'none', cameraBack: 'webcam', microphoneEnabled: false }))
      .toEqual(['android.permission.CAMERA']);
    expect(mediaPermissionsFor({ cameraFront: 'webcam', cameraBack: 'none', microphoneEnabled: false }))
      .toEqual(['android.permission.CAMERA']);
  });

  it('needs the microphone only while it is switched on', () => {
    expect(mediaPermissionsFor({ cameraFront: 'webcam', cameraBack: 'webcam', microphoneEnabled: true }))
      .toEqual(['android.permission.CAMERA', 'android.permission.RECORD_AUDIO']);
    expect(mediaPermissionsFor({ cameraFront: 'none', cameraBack: 'none', microphoneEnabled: true }))
      .toEqual(['android.permission.RECORD_AUDIO']);
  });
});

describe('which app is the device camera', () => {
  it('reads the package from the component line of resolve-activity output', () => {
    expect(cameraAppFromResolveOutput(
      'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\n'
      + 'com.google.android.GoogleCamera/com.android.camera.CameraLauncher\n',
    )).toBe('com.google.android.GoogleCamera');
  });

  it('reads the same line when the output has Windows line endings', () => {
    expect(cameraAppFromResolveOutput(
      'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\r\n'
      + 'com.android.camera2/com.android.camera.CameraLauncher\r\n',
    )).toBe('com.android.camera2');
  });

  it('gives nothing when no activity answers', () => {
    expect(cameraAppFromResolveOutput('No activity found')).toBe('');
    expect(cameraAppFromResolveOutput('')).toBe('');
  });

  it('never takes the system chooser, which is not a camera app', () => {
    expect(cameraAppFromResolveOutput(
      'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n'
      + 'android/com.android.internal.app.ResolverActivity\n',
    )).toBe('');
  });
});

describe('a refused grant is named, even when pm exits cleanly', () => {
  it('says nothing for a grant that went through', () => {
    expect(grantRefusalIn('')).toBe('');
  });

  it('keeps the reason when pm reports an exception or an unknown package', () => {
    expect(grantRefusalIn("Exception occurred while executing 'grant':\njava.lang.SecurityException: not requested")).toContain('SecurityException');
    expect(grantRefusalIn('Unknown package: app.example')).toContain('Unknown package');
  });
});

describe('a grant counts only when the device reports it', () => {
  const dump = [
    'Packages:',
    '  Package [com.google.android.GoogleCamera] (abc):',
    '    runtime permissions:',
    '      android.permission.CAMERA: granted=true, flags=[ USER_SET ]',
    '      android.permission.RECORD_AUDIO: granted=false, flags=[ ]',
    '      android.permission.CAMERA_EXTRA: granted=true, flags=[ ]',
  ].join('\n');

  it('reports a permission that is granted', () => {
    expect(permissionGrantedIn(dump, 'android.permission.CAMERA')).toBe(true);
  });

  it('does not count a refused permission, or a longer name that starts the same way', () => {
    expect(permissionGrantedIn(dump, 'android.permission.RECORD_AUDIO')).toBe(false);
    expect(permissionGrantedIn('      android.permission.CAMERA_EXTRA: granted=true', 'android.permission.CAMERA')).toBe(false);
    expect(permissionGrantedIn('', 'android.permission.CAMERA')).toBe(false);
  });
});

describe('the launch path asks for the grant and reports a refusal', () => {
  it('grants after boot and sends a toast instead of dropping the failure', () => {
    const manager = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'main', 'manager.ts'), 'utf8');
    const boot = manager.indexOf("getprop', ['sys', 'boot_completed']");
    const grant = manager.indexOf('grantAndroidMediaPermissions(name, serial)');
    expect(boot).toBeGreaterThan(0);
    expect(grant).toBeGreaterThan(boot);
    expect(manager.slice(grant, grant + 900)).toContain("key: 'android.media.permissionFailed'");
  });
});
