/**
 * The camera and microphone rules for an Android device. The decisions the
 * product relies on: a camera is matched to the browser camera by its real
 * name and never guessed, a saved camera is kept only while it is still
 * available, one camera serves one lens, and every failure is classified.
 */
import { describe, expect, it } from 'vitest';
import {
  MICROPHONE_CHOICES, assignLensCameras, classifyCameraFailure, friendlyNameForDevicePath, hardwareIdOf, isDevicePath,
  meterLevel, microphoneConfig, pickCameraByLabel, pickCameraForEmulator, type WindowsCameraName,
} from '@octo/core';

describe('the browser camera that is the emulator\'s camera', () => {
  const cameras = [
    { label: 'Integrated Camera (04f2:b6d0)', deviceId: 'a' },
    { label: 'USB Camera', deviceId: 'b' },
    { label: '', deviceId: 'c' },
  ];

  it('prefers the exact name', () => {
    expect(pickCameraByLabel([{ label: 'Integrated Camera (04f2:b6d0)', deviceId: 'x' }, { label: 'Integrated Camera', deviceId: 'y' }], 'Integrated Camera'))
      .toEqual({ label: 'Integrated Camera', deviceId: 'y' });
  });

  it('matches a name that carries vendor text, and ignores case and spacing', () => {
    expect(pickCameraByLabel(cameras, '  usb   camera ')?.deviceId).toBe('b');
    expect(pickCameraByLabel(cameras, 'integrated camera')?.deviceId).toBe('a');
  });

  it('also matches when the emulator name carries the extra text', () => {
    expect(pickCameraByLabel([{ label: 'USB Camera', deviceId: 'b' }], 'USB Camera (1234:5678)')?.deviceId).toBe('b');
  });

  it('never guesses: an unknown name, an empty name or unlabelled cameras match nothing', () => {
    expect(pickCameraByLabel(cameras, 'Realme 12 Pro')).toBeUndefined();
    expect(pickCameraByLabel(cameras, '')).toBeUndefined();
    expect(pickCameraByLabel([{ label: '', deviceId: 'c' }], 'USB Camera')).toBeUndefined();
  });
});

describe('a camera the emulator names by its Windows device path', () => {
  // A device path is the instance ID with '#' for '\\', behind a \\\\?\\ prefix.
  const usb = '\\\\?\\usb#vid_04f2&pid_b6d0&mi_00#6&2b7d6b1f&0&0000#{e5323777-f976-4f5b-9b55-b94699c46e44}\\global';
  const phone = '\\\\?\\SWD#VCAMDEVICE#VCAM_REALME#{6994ad04-93ef-11d0-a3cc-00a0c9223196}\\{abc}';
  const windows: WindowsCameraName[] = [
    { instanceId: 'USB\\VID_04F2&PID_B6D0&MI_00\\6&2B7D6B1F&0&0000', friendlyName: 'Integrated Camera' },
    { instanceId: 'USB\\VID_04F2&PID_B6D0&MI_02\\6&1111&0&0002', friendlyName: 'Second Camera' },
    { instanceId: 'SWD\\VCAMDEVICE\\VCAM_REALME', friendlyName: 'Realme 12 Pro' },
  ];

  it('recognises a device path and reads the hardware ID from it', () => {
    expect(isDevicePath(usb)).toBe(true);
    expect(isDevicePath('Integrated Camera')).toBe(false);
    expect(isDevicePath('/dev/video0')).toBe(false);
    // The same path without its \\\\?\\ prefix is still a path, never a name.
    expect(isDevicePath('usb#vid_04f2&pid_b6d0&mi_00#6&2b7d6b1f&0&0000#{e5323777-f976-4f5b-9b55-b94699c46e44}')).toBe(true);
    expect(hardwareIdOf(usb)).toBe('04f2:b6d0');
    expect(hardwareIdOf('Integrated Camera (04F2:B6D0)')).toBe('04f2:b6d0');
    expect(hardwareIdOf(phone)).toBe('');
    expect(hardwareIdOf('webcam0')).toBe('');
  });

  it('gives the Windows name of the camera behind the path, and never a name for an unknown one', () => {
    expect(friendlyNameForDevicePath(usb, windows)).toBe('Integrated Camera');
    expect(friendlyNameForDevicePath(phone, windows)).toBe('Realme 12 Pro');
    // A path that only starts like another one is not that camera: the next character must end the ID.
    expect(friendlyNameForDevicePath(usb.replace('0000#', '00001#'), windows)).toBe('');
    expect(friendlyNameForDevicePath('\\\\?\\usb#vid_9999&pid_9999&mi_00#1&1&0&0000#{x}\\global', windows)).toBe('');
    expect(friendlyNameForDevicePath('Integrated Camera', windows)).toBe('');
  });

  it('matches a browser camera by hardware ID, and a path that has no name never matches by name', () => {
    const browser = [
      { label: 'Integrated Camera (04f2:b6d0)', deviceId: 'a' },
      { label: 'Realme 12 Pro', deviceId: 'p' },
    ];
    expect(pickCameraForEmulator(browser, { device: 'Integrated Camera', hardwareId: '04f2:b6d0' })?.deviceId).toBe('a');
    expect(pickCameraForEmulator(browser, { device: '', hardwareId: '04f2:b6d0' })?.deviceId).toBe('a');
    // A name Windows gave the emulator's camera still matches the browser's name for it.
    expect(pickCameraForEmulator(browser, { device: 'Realme 12 Pro' })?.deviceId).toBe('p');
    // An ID that no labelled browser camera carries is a different camera, not a name clash.
    expect(pickCameraForEmulator(browser, { device: 'Realme 12 Pro', hardwareId: '1234:5678' })).toBeUndefined();
    // A raw path is matched by the hardware ID inside it, never by its text; an unnamed camera with no ID matches nothing.
    expect(pickCameraForEmulator(browser, { device: usb })?.deviceId).toBe('a');
    expect(pickCameraForEmulator(browser, { device: phone })).toBeUndefined();
    expect(pickCameraForEmulator(browser, { device: '' })).toBeUndefined();
    // Cameras with no IDs in their labels are matched by name, the only proof there is.
    expect(pickCameraForEmulator([{ label: 'USB Camera', deviceId: 'u' }], { device: 'USB Camera', hardwareId: '1234:5678' })?.deviceId).toBe('u');
  });
});

describe('a saved camera is kept only while it is still available', () => {
  const first = { id: 'webcam0', name: 'Integrated Camera' };
  const second = { id: 'webcam1', name: 'USB Camera' };

  it('restores a saved camera that is still available', () => {
    expect(assignLensCameras({ back: 'webcam1' }, [first, second]).back).toBe('webcam1');
  });

  it('falls back to the first available camera when the saved one is gone', () => {
    expect(assignLensCameras({ back: 'webcam7' }, [first, second])).toMatchObject({ back: 'webcam0', lost: { front: false, back: true } });
  });

  it('invents no camera when none is available', () => {
    expect(assignLensCameras({ front: 'webcam0', back: 'webcam1' }, [])).toEqual({ front: '', back: '', lost: { front: true, back: true } });
  });
});

describe('every camera failure has one of the required categories', () => {
  it('classifies browser and camera-service errors', () => {
    expect(classifyCameraFailure({ name: 'NotAllowedError' })).toBe('permission');
    expect(classifyCameraFailure({ name: 'NotReadableError', message: 'Could not start video source' })).toBe('in-use');
    expect(classifyCameraFailure({ name: 'NotFoundError' })).toBe('unavailable');
    expect(classifyCameraFailure({ name: 'AbortError', message: 'something odd' })).toBe('failed');
    expect(classifyCameraFailure(undefined)).toBe('failed');
  });
});

describe('microphone', () => {
  it('offers only what the emulator can honour: off and the Windows default device', () => {
    expect(MICROPHONE_CHOICES).toEqual(['off', 'default']);
    expect(microphoneConfig('default')).toEqual({ 'hw.audioInput': 'yes' });
    expect(microphoneConfig('off')).toEqual({ 'hw.audioInput': 'no' });
    expect(microphoneConfig('synthetic')).toEqual({ 'hw.audioInput': 'no' });
    expect(microphoneConfig(undefined)).toEqual({ 'hw.audioInput': 'no' });
  });

  it('turns samples into a 0-1 meter level', () => {
    expect(meterLevel([])).toBe(0);
    expect(meterLevel([0, 0, 0])).toBe(0);
    expect(meterLevel([0.25, -0.25, 0.25, -0.25])).toBeCloseTo(0.5, 6);
    expect(meterLevel([1, -1])).toBe(1);
  });
});

describe('one camera serves one lens', () => {
  const first = { id: 'webcam0', name: 'Integrated Camera' };
  const second = { id: 'webcam1', name: 'USB Camera' };

  it('gives no lens a camera when no camera is active, and invents none', () => {
    expect(assignLensCameras({ front: 'webcam0', back: 'webcam1' }, []))
      .toEqual({ front: '', back: '', lost: { front: true, back: true } });
  });

  it('serves the back lens only when a single camera is active', () => {
    expect(assignLensCameras({}, [first])).toEqual({ front: '', back: 'webcam0', lost: { front: false, back: false } });
  });

  it('moves a single camera saved only on the front lens to the back lens, without calling it lost', () => {
    expect(assignLensCameras({ front: 'webcam0', back: '' }, [first]))
      .toEqual({ front: '', back: 'webcam0', lost: { front: false, back: false } });
    expect(assignLensCameras({ front: 'webcam0', back: 'webcam9' }, [first]))
      .toEqual({ front: '', back: 'webcam0', lost: { front: false, back: true } });
  });

  it('gives two active cameras one lens each, back first', () => {
    expect(assignLensCameras({}, [first, second]))
      .toEqual({ front: 'webcam1', back: 'webcam0', lost: { front: false, back: false } });
  });

  it('keeps saved choices while their cameras are still active', () => {
    expect(assignLensCameras({ front: 'webcam0', back: 'webcam1' }, [first, second]))
      .toEqual({ front: 'webcam0', back: 'webcam1', lost: { front: false, back: false } });
  });

  it('refills a lens whose camera is gone from another active camera, or switches it off', () => {
    expect(assignLensCameras({ front: 'webcam0', back: 'webcam9' }, [first, second]))
      .toEqual({ front: 'webcam0', back: 'webcam1', lost: { front: false, back: true } });
    expect(assignLensCameras({ back: 'webcam0', front: 'webcam9' }, [first]))
      .toEqual({ front: '', back: 'webcam0', lost: { front: true, back: false } });
  });

  it('never puts one camera on both lenses; the front lens gives way', () => {
    expect(assignLensCameras({ front: 'webcam0', back: 'webcam0' }, [first, second]))
      .toEqual({ front: 'webcam1', back: 'webcam0', lost: { front: true, back: false } });
    expect(assignLensCameras({ front: 'webcam0', back: 'webcam0' }, [first]))
      .toEqual({ front: '', back: 'webcam0', lost: { front: true, back: false } });
  });

  it('treats an empty saved value as no choice, not as a lost camera', () => {
    expect(assignLensCameras({ front: '', back: '' }, [first]).lost).toEqual({ front: false, back: false });
  });

  it('only ever returns cameras the system listed', () => {
    const result = assignLensCameras({ front: 'webcam7', back: 'webcam8' }, [first, second]);
    expect([result.front, result.back].every((id) => id === '' || id === 'webcam0' || id === 'webcam1')).toBe(true);
  });
});
