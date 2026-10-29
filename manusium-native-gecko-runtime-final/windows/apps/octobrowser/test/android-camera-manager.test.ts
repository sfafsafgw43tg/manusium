import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CameraTestManager } from '../src/renderer/camera-test-manager';
import { resolveAvdCameraSelection } from '@octo/core';
import { configValue, writeConfigValues, mediaConfig, normalizeCameraSources, resolveActiveCameraAssignments, emulatorCameraValues, selectedUnityCaptureWebcams } from '../src/main/android-studio';

describe('host webcam test manager', () => {
  it('defaults to Android-only without granting a host capture lease', () => {
    const manager = new CameraTestManager();
    expect(manager.enabled).toBe(false);
    expect(manager.begin()).toBeNull();
  });
  it('stops every owned stream and aborts outstanding checks when switched off', () => {
    const manager = new CameraTestManager(); manager.setEnabled(true);
    const a = manager.begin()!; const b = manager.begin()!;
    const stopA = vi.fn(); const stopB = vi.fn();
    a.track({ getTracks: () => [{ stop: stopA }] }); b.track({ getTracks: () => [{ stop: stopB }] });
    manager.setEnabled(false);
    expect(stopA).toHaveBeenCalledOnce(); expect(stopB).toHaveBeenCalledOnce();
    expect(a.signal.aborted && b.signal.aborted).toBe(true);
    a.close(); b.close(); expect(stopA).toHaveBeenCalledOnce();
  });
  it('releases a driver stream that arrives after Off, even after testing is re-enabled', async () => {
    const manager = new CameraTestManager(); manager.setEnabled(true);
    const lease = manager.begin()!;
    const oldGeneration = manager.generation;
    const stop = vi.fn();
    let deliver!: (value: { getTracks(): Array<{ stop(): void }> }) => void;
    const pendingDriver = new Promise<{ getTracks(): Array<{ stop(): void }> }>(resolve => { deliver = resolve; });
    const consume = pendingDriver.then(stream => lease.track(stream));
    manager.setEnabled(false); manager.setEnabled(true);
    deliver({ getTracks: () => [{ stop }] }); await consume;
    expect(stop).toHaveBeenCalledOnce(); expect(lease.signal.aborted).toBe(true);
    expect(manager.generation).not.toBe(oldGeneration); // old queued requests cannot restart
    const next = manager.begin()!; expect(next.signal.aborted).toBe(false); next.close();
  });
  it('releases a completed test and notifies all connected picker controls', () => {
    const manager = new CameraTestManager(); const listener = vi.fn(); const unsubscribe = manager.subscribe(listener);
    manager.setEnabled(true); const lease = manager.begin()!; const stop = vi.fn();
    lease.track({ getTracks: () => [{ stop }] }); lease.close();
    expect(stop).toHaveBeenCalledOnce(); expect(listener).toHaveBeenCalledOnce();
    unsubscribe(); manager.setEnabled(false); expect(listener).toHaveBeenCalledOnce();
  });
});

describe('explicit Android camera configuration', () => {
  it('identifies Unity Capture endpoints without treating ordinary webcams as virtual producers', () => {
    const webcams = [
      { name: 'webcam0', device: 'Integrated Camera', virtual: false },
      { name: 'webcam1', device: 'Unity Capture virtual camera', virtual: true },
      { name: 'webcam2', device: 'OBS Virtual Camera', virtual: true },
    ];
    expect(selectedUnityCaptureWebcams(webcams, ['webcam0', 'webcam1'])).toEqual([webcams[1]]);
    expect(selectedUnityCaptureWebcams(webcams, ['webcam0', 'webcam2'])).toEqual([]);
  });

  it('preserves webcam0 for both lenses even when the emulator enumerates nothing', () => {
    expect(resolveAvdCameraSelection({ front: 'webcam', back: 'webcam' }, { front: 'webcam0', back: 'webcam0' }, []))
      .toEqual({ front: 'webcam0', back: 'webcam0', shared: true, unlisted: ['webcam0'] });
  });
  it('does not reactivate Off or pass arbitrary text to the emulator', () => {
    expect(resolveAvdCameraSelection({ front: 'none', back: 'none' }, { front: 'webcam0', back: 'webcam0' }, [{ id: 'webcam0', name: 'Camera' }]))
      .toEqual({ front: '', back: '', shared: false, unlisted: [] });
    expect(emulatorCameraValues('webcam', 'webcam', 'webcam0 -shell', 'webcam0&command')).toEqual({ front: 'none', back: 'none' });
  });
  it('writes and reloads both mappings and Off through real AVD config and metadata files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-camera-config-'));
    try {
      for (const source of ['webcam', 'none'] as const) {
        writeConfigValues(dir, mediaConfig(source, source, true, 'webcam0', 'webcam0'));
        const sources = normalizeCameraSources(configValue(dir, 'octobrowser.cameraFront'), configValue(dir, 'octobrowser.cameraBack'));
        const assignment = resolveActiveCameraAssignments(sources.front, sources.back, configValue(dir, 'octobrowser.cameraFrontDevice'), configValue(dir, 'octobrowser.cameraBackDevice'), []);
        const values = emulatorCameraValues(assignment.front, assignment.back, assignment.frontDevice, assignment.backDevice);
        const expected = source === 'webcam' ? 'webcam0' : 'none';
        expect(values).toEqual({ front: expected, back: expected });
        const config = fs.readFileSync(path.join(dir, 'config.ini'), 'utf8');
        expect(config).toContain(`hw.camera.front=${expected}`); expect(config).toContain(`hw.camera.back=${expected}`);
        expect(configValue(dir, 'hw.audioInput')).toBe('yes');
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
