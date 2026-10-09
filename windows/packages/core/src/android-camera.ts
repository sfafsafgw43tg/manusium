/**
 * packages/core/src/android-camera.ts
 *
 * Pure rules for the cameras and microphone of an Android device. Nothing here
 * touches the disk, the network or a device, so the same decisions are made
 * by the main process, the launcher UI and the unit tests.
 *
 *   - A camera is offered only when the Android Emulator lists it under its own
 *     name AND it has opened and sent a picture in a check on this computer.
 *     Nothing here numbers a camera by position or assumes a "0" / "1" pair.
 *   - A saved camera is kept while it is still available; otherwise the first
 *     available camera is used.
 *   - One camera serves one lens. A lens with no working camera is off; the
 *     emulator's own test pattern and 3D room are never used in its place.
 */

/** One camera as it is named on the list: an emulator endpoint (webcam0) or a camera ID. */
export interface ScannedCamera {
  /** Stable identifier used for the saved choice. */
  id: string;
  /** Human-readable name shown to the user. */
  name: string;
}

function normalizeName(text: string | null | undefined): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Find the browser camera that is the emulator's device. Windows reports the
 * same camera as a plain name in one place and with vendor text in another
 * ("Integrated Camera (04f2:b6d0)"), so an exact name wins, then a label that
 * contains the device name, and only then a device name that contains the label.
 */
export function pickCameraByLabel<T extends { label: string }>(cameras: readonly T[], device: string): T | undefined {
  const wanted = normalizeName(device);
  if (!wanted) return undefined;
  const named = cameras.map((camera) => ({ camera, label: normalizeName(camera.label) })).filter((item) => item.label !== '');
  const passes: Array<(label: string) => boolean> = [
    (label) => label === wanted,
    (label) => label.includes(wanted),
    (label) => wanted.includes(label),
  ];
  for (const pass of passes) {
    const hit = named.find((item) => pass(item.label));
    if (hit) return hit.camera;
  }
  return undefined;
}

/**
 * True for a Windows device-interface path, as the Android Emulator prints one:
 * \\?\usb#vid_04f2&pid_b6d0#...{guid}, or the same without the \\?\ prefix.
 */
export function isDevicePath(text: string | null | undefined): boolean {
  const value = String(text ?? '');
  return /^\\\\\?\\/.test(value) || /^(usb|swd|hid|pci|root)#/i.test(value) || /#\{[0-9a-f-]{36}\}/i.test(value);
}

/**
 * The hardware ID of a camera as "04f2:b6d0" (lower case). Windows puts it in a
 * device path (vid_04f2&pid_b6d0) and the browser puts it in brackets after the
 * name ("Integrated Camera (04f2:b6d0)"). It is empty for most virtual cameras.
 */
export function hardwareIdOf(text: string | null | undefined): string {
  const value = String(text ?? '');
  const match = /vid_([0-9a-f]{4})&pid_([0-9a-f]{4})/i.exec(value) ?? /\(([0-9a-f]{4}):([0-9a-f]{4})\)/i.exec(value);
  return match ? `${match[1]}:${match[2]}`.toLowerCase() : '';
}

/** A camera as Windows names it: its device instance ID and its friendly name. */
export interface WindowsCameraName {
  instanceId: string;
  friendlyName: string;
}

/**
 * The friendly name of the Windows camera behind a device path. A device path is
 * the instance ID with '#' in place of '\', behind a "\\?\" prefix and followed
 * by the interface GUID, so the longest instance ID the path starts with is the
 * camera. Returns '' when no camera matches: a name is never guessed.
 */
export function friendlyNameForDevicePath(devicePath: string, cameras: readonly WindowsCameraName[]): string {
  if (!isDevicePath(devicePath)) return '';
  const target = devicePath.replace(/^\\\\\?\\/, '').toUpperCase();
  let best: { key: string; name: string } | undefined;
  for (const camera of cameras) {
    const key = camera.instanceId.replace(/\\/g, '#').toUpperCase();
    const name = camera.friendlyName.trim();
    if (!key || !name || !target.startsWith(key)) continue;
    const next = target.charAt(key.length);
    if (next !== '' && next !== '#' && next !== '\\') continue;
    if (!best || key.length > best.key.length) best = { key, name };
  }
  return best?.name ?? '';
}

/**
 * The browser camera that is the emulator's camera. A known hardware ID decides
 * when the browser labels cameras with IDs. A device path that could not be
 * named never matches by name, so a path cannot pick a camera by accident.
 */
export function pickCameraForEmulator<T extends { label: string }>(
  cameras: readonly T[],
  camera: { device: string; hardwareId?: string },
): T | undefined {
  const hardware = camera.hardwareId || hardwareIdOf(camera.device);
  if (hardware) {
    const hit = cameras.find((item) => hardwareIdOf(item.label) === hardware);
    if (hit) return hit;
    // The browser names some cameras with their IDs and this one is not among them: it is not a browser camera.
    if (cameras.some((item) => hardwareIdOf(item.label) !== '')) return undefined;
  }
  if (!camera.device || isDevicePath(camera.device)) return undefined;
  return pickCameraByLabel(cameras, camera.device);
}

/** The two lenses of one device, as camera ids. An empty string means that lens is off. */
export interface LensCameras {
  front: string;
  back: string;
}

export interface LensAssignment extends LensCameras {
  /** A saved choice that could not be kept: its camera is gone, or the other lens already holds it. */
  lost: { front: boolean; back: boolean };
}

/**
 * Give each lens its camera. One camera serves one lens, so two working lenses
 * need two cameras, and a single camera serves the back lens only.
 *
 *   - A saved camera is kept while it is still available.
 *   - A saved camera that is gone, or that the other lens already holds, is
 *     dropped and that lens is filled again.
 *   - An empty lens takes the first available camera the other lens does not use.
 *   - The back lens is settled first, so it keeps a camera both lenses saved;
 *     the front lens gives way.
 *   - A single camera always serves the back lens, the lens Android opens first.
 *     A camera saved only on the front lens moves to the back lens, and the front
 *     lens is off. That move is not a lost choice: the camera still works.
 *   - A lens with no camera left is off (''). Nothing is put in its place.
 */
export function assignLensCameras(saved: Partial<LensCameras>, available: readonly ScannedCamera[]): LensAssignment {
  const order = [...new Set(available.map((camera) => camera.id).filter(Boolean))];
  const savedFront = saved.front ?? '';
  const savedBack = saved.back ?? '';
  let back = order.includes(savedBack) ? savedBack : '';
  let front = order.includes(savedFront) && savedFront !== back ? savedFront : '';
  const lost = { front: savedFront !== '' && front !== savedFront, back: savedBack !== '' && back !== savedBack };
  if (!back && front && order.length === 1) { back = front; front = ''; }
  if (!back) back = order.find((id) => id !== front) ?? '';
  if (!front) front = order.find((id) => id !== back) ?? '';
  return { front, back, lost };
}

/** Why opening a camera failed, in terms the UI can act on. */
export type CameraFailure = 'permission' | 'in-use' | 'unavailable' | 'failed';

/**
 * Sort a getUserMedia / CameraX failure into one of the four cases. Browsers
 * report a camera that another application holds as NotReadableError (Chromium
 * also says "Could not start video source"), a refused permission as
 * NotAllowedError, and a missing device as NotFoundError.
 */
export function classifyCameraFailure(error: { name?: unknown; message?: unknown } | null | undefined): CameraFailure {
  const name = String(error?.name ?? '');
  const message = String(error?.message ?? '');
  if (name === 'NotAllowedError' || name === 'SecurityError' || /permission/i.test(message)) return 'permission';
  if (name === 'NotReadableError' || name === 'TrackStartError' || /could not start video source|in use|busy/i.test(message)) return 'in-use';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') return 'unavailable';
  return 'failed';
}

/** Microphone choices the emulator can actually honour from its command line. */
export const MICROPHONE_CHOICES = ['off', 'default'] as const;
export type MicrophoneChoice = (typeof MICROPHONE_CHOICES)[number];

/**
 * The emulator has no command-line option to pick one recording device. It
 * records from the Windows default device when audio input is on, so the only
 * honest choices are on and off. Anything else falls back to off.
 */
export function microphoneConfig(choice: string | null | undefined): { 'hw.audioInput': 'yes' | 'no' } {
  return { 'hw.audioInput': choice === 'default' ? 'yes' : 'no' };
}

/** Root-mean-square level of audio samples in [-1, 1], scaled to [0, 1] for a meter. */
export function meterLevel(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  return Math.min(1, Math.max(0, rms * 2));
}
