/**
 * apps/octobrowser/src/renderer/launcher-android-cameras.ts
 *
 * The camera section of an Android device: the creator, the device settings,
 * the media dialog and the VirtualBox launch dialog all use this one picker.
 *
 * It offers only cameras that work right now. The list is the one the Android
 * Emulator names (`emulator -webcam-list`), never numbers guessed from Windows.
 * Each listed camera is opened once here, and it is offered only when it sends
 * a picture; the stream is released at once, so the device or a website can use
 * the camera straight after.
 *
 * Two lenses, Back and Front. A lens is a select of the working cameras, or Off.
 * With one working camera it serves the back lens and the front lens is Off.
 * A saved camera is kept while it still works; otherwise the first working one
 * is used. Choosing the camera of the other lens swaps the two lenses.
 */
import { api } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { field, run, select, toast } from './launcher-ui';
import {
  assignLensCameras, classifyCameraFailure, pickCameraForEmulator, type CameraFailure,
} from '@octo/core/android-camera';

/** A lens is fed from a host camera (`webcam`), or it is off (`none`). */
export type CameraSource = 'none' | 'webcam';
export type CameraFacing = 'front' | 'back';
export interface CameraResolution { width: number; height: number }

/** A camera the Android Emulator lists on this computer, under the name the emulator gave it. */
export interface EmulatorCamera {
  /** The name on the emulator's command line, e.g. "webcam0". */
  name: string;
  /** The Windows name of the camera, used to find the same camera in the browser. Empty when Windows gave none. */
  device: string;
  /** Vendor and product ID as "04f2:b6d0", when the camera has one. */
  hardwareId?: string;
  virtual: boolean;
  foreign?: boolean;
}

/** Why the emulator's list is empty: it timed out, it reported a failure, or it found no camera. */
export type CameraProblem = '' | 'timeout' | 'reported' | 'none';

/** What the main process answers. These cameras are listed, not yet proven to work. */
export interface CameraChoices {
  webcams: EmulatorCamera[];
  emulatorAvailable: boolean;
  problem?: CameraProblem;
  detail?: string;
}

export interface CameraSelection {
  front: CameraSource;
  back: CameraSource;
  /** Emulator endpoint (webcam0...) of the camera on that lens; '' when the lens is off. */
  frontDevice: string;
  backDevice: string;
  /** What a check measured, so Android is not told a resolution that cannot arrive. */
  frontLimit?: CameraResolution;
  backLimit?: CameraResolution;
}

export interface CameraPickerOptions {
  /** What the device is configured with right now. */
  initial: Partial<CameraSelection>;
  /** Called after every scan, with the selection that will be saved. */
  onChange?: (value: CameraSelection) => void;
  /** Called after every scan, with the cameras that work right now. */
  onWorking?: (working: Array<{ name: string; label: string }>) => void;
}

export interface CameraPicker {
  element: HTMLElement;
  value: () => CameraSelection;
  refresh: () => Promise<void>;
}

/** The outcome of opening one camera. */
export interface CameraCheck {
  ok: boolean;
  width: number;
  height: number;
  failure?: CameraFailure;
}

/** How long a camera may take to send its first picture. A phone used as a webcam can take several seconds. */
const FIRST_PICTURE_MS = 8000;
/** The longest one whole check may take, including a driver that never answers. */
const CHECK_LIMIT_MS = 12000;
/** How often the emulator's list is re-read while the picker is on screen. */
const POLL_MS = 5000;
/**
 * A check is reused for this long when a picker opens again (the creator
 * rebuilds its panel on every step), so a camera is not opened again each time.
 * Refresh always checks again.
 */
const RECENT_CHECK_MS = 15_000;
/** The last check of each camera, shared by every picker on screen. */
const recentChecks = new Map<string, { at: number; check: CameraCheck }>();

const NO_PICTURE: CameraCheck = { ok: false, width: 0, height: 0, failure: 'failed' };

/** Checks run one at a time: two cameras opened together can starve each other. */
let checkQueue: Promise<unknown> = Promise.resolve();
function queued<T>(task: () => Promise<T>): Promise<T> {
  const next = checkQueue.then(task, task);
  checkQueue = next.catch(() => undefined);
  return next;
}

/** Null when the call failed: an unanswered list must not read as "no cameras". */
async function loadCameraChoices(): Promise<CameraChoices | null> {
  const result = await run(api.invoke<CameraChoices>('mgr:android-camera-choices'));
  return result ?? null;
}

function sourceOf(device: string): CameraSource {
  return device ? 'webcam' : 'none';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function videoInputs(): Promise<MediaDeviceInfo[]> {
  return (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput');
}

/** How many cameras Windows reports to the browser. Counting needs no permission, so it works before any check. */
async function countWindowsCameras(): Promise<number> {
  try { return (await videoInputs()).length; } catch { return 0; }
}

/** The name shown for a camera: its Windows name, else its hardware ID, else a plain label. Never a device path or a number. */
function displayName(camera: EmulatorCamera): string {
  if (camera.device) return camera.device;
  return camera.hardwareId ? t('android.camera.hardwareName', { id: camera.hardwareId }) : t('android.camera.webcam');
}

/** One open camera, so that whatever happens it can be released at once. */
interface Attempt {
  stream?: MediaStream;
  video?: HTMLVideoElement;
  closed: boolean;
}

function release(attempt: Attempt): void {
  attempt.closed = true;
  attempt.stream?.getTracks().forEach((track) => track.stop());
  attempt.stream = undefined;
  if (attempt.video) {
    attempt.video.srcObject = null;
    attempt.video.remove();
    attempt.video = undefined;
  }
}

/** Resolves true once the camera has reported its picture size, or false after the wait. */
function firstPicture(video: HTMLVideoElement, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let timer = 0;
    const done = () => { window.clearTimeout(timer); resolve(video.videoWidth > 0); };
    timer = window.setTimeout(done, ms);
    if (video.videoWidth > 0) done();
    else video.addEventListener('loadedmetadata', done, { once: true });
  });
}

/**
 * Open the emulator's camera, wait for its first picture, and report what came
 * back. Browser labels stay hidden until a camera has been opened with
 * permission, so when no camera has a label yet, one short default stream
 * reveals them; that stream is closed before the real camera is opened.
 */
async function pictureOf(emulator: EmulatorCamera, attempt: Attempt): Promise<CameraCheck> {
  try {
    let cameras = await videoInputs();
    if (!pickCameraForEmulator(cameras, emulator) && cameras.every((item) => !item.label)) {
      const reveal = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      reveal.getTracks().forEach((track) => track.stop());
      // Windows drivers that allow one user need a moment before they can be opened again.
      await delay(300);
      cameras = await videoInputs();
    }
    if (attempt.closed) return NO_PICTURE;
    const match = pickCameraForEmulator(cameras, emulator);
    if (!match) return { ok: false, width: 0, height: 0, failure: 'unavailable' };
    const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: match.deviceId } }, audio: false });
    // The check may have been abandoned while the camera was being opened: release it at once.
    if (attempt.closed) {
      stream.getTracks().forEach((track) => track.stop());
      return NO_PICTURE;
    }
    attempt.stream = stream;
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    // In the page but off screen: some builds decode nothing for a detached video.
    video.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.append(video);
    attempt.video = video;
    video.srcObject = stream;
    await firstPicture(video, FIRST_PICTURE_MS);
    const track = stream.getVideoTracks()[0];
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width > 0 && height > 0 && track?.readyState === 'live') return { ok: true, width, height };
    return NO_PICTURE;
  } catch (error) {
    console.debug('[camera] check failed', error);
    return { ok: false, width: 0, height: 0, failure: classifyCameraFailure(error as { name?: unknown; message?: unknown }) };
  }
}

/**
 * Open one emulator camera, see whether it sends a picture, and release it at
 * once. Nothing is kept open: a camera that is held here is one the emulator
 * or a website cannot use.
 */
export function checkHostCamera(camera: EmulatorCamera): Promise<CameraCheck> {
  return queued(async () => {
    const attempt: Attempt = { closed: false };
    let timer = 0;
    const limit = new Promise<CameraCheck>((resolve) => {
      timer = window.setTimeout(() => resolve(NO_PICTURE), CHECK_LIMIT_MS);
    });
    try {
      return await Promise.race([pictureOf(camera, attempt), limit]);
    } finally {
      window.clearTimeout(timer);
      release(attempt);
    }
  });
}

export function cameraPicker(options: CameraPickerOptions): CameraPicker {
  const selection: CameraSelection = {
    front: sourceOf(options.initial.frontDevice ?? ''),
    back: sourceOf(options.initial.backDevice ?? ''),
    frontDevice: options.initial.frontDevice ?? '',
    backDevice: options.initial.backDevice ?? '',
    frontLimit: options.initial.frontLimit,
    backLimit: options.initial.backLimit,
  };
  // A remembered measurement is a fact about the camera, not about this window.
  const measured = new Map<string, CameraResolution>();
  if (selection.frontDevice && selection.frontLimit) measured.set(selection.frontDevice, selection.frontLimit);
  if (selection.backDevice && selection.backLimit) measured.set(selection.backDevice, selection.backLimit);

  let listed: EmulatorCamera[] = [];
  /** The last check of each listed camera, valid only while the camera keeps its name and device. */
  const checks = new Map<string, { key: string; check: CameraCheck }>();
  let loaded = false;
  let loadFailed = false;
  let noEmulator = false;
  let checking = false;
  let scanning = false;
  let attached = false;
  let problem: CameraProblem = '';
  let detail = '';
  let windowsCount = 0;

  const keyOf = (camera: EmulatorCamera): string => `${camera.name}\u0001${camera.device}`;
  const checkOf = (camera: EmulatorCamera): CameraCheck | undefined => {
    const entry = checks.get(camera.name);
    return entry?.key === keyOf(camera) ? entry.check : undefined;
  };
  /** The listed cameras that opened and sent a picture, in the emulator's order. */
  const working = (): EmulatorCamera[] => listed.filter((camera) => checkOf(camera)?.ok === true);

  const backSlot = h('div', { class: 'vbox-live-host' });
  const frontSlot = h('div', { class: 'vbox-live-host' });
  const statusSlot = h('div', { class: 'camera-scan-status', role: 'status' });
  const refreshButton = h('button', { type: 'button', class: 'btn small' },
    icon('refreshCircle', 14), h('span', { text: t('common.refresh') })) as HTMLButtonElement;
  refreshButton.onclick = () => void scan(true);
  // A camera plugged in or removed is picked up by itself: Windows reports several
  // changes per plug, so the rescan waits for them to settle and never overlaps
  // (scan() is already guarded). Nothing runs while the picker is not on screen.
  let deviceSettle: ReturnType<typeof setTimeout> | undefined;
  const onDeviceChange = (): void => {
    if (!element.isConnected) return;
    clearTimeout(deviceSettle);
    deviceSettle = setTimeout(() => void scan(false), 700);
  };
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);
  const element = h('div', { class: 'camera-picker' },
    h('div', { class: 'grid2' }, backSlot, frontSlot),
    h('div', { class: 'camera-picker-foot' }, refreshButton),
    statusSlot);

  const emit = (): void => {
    selection.frontLimit = selection.frontDevice ? measured.get(selection.frontDevice) : undefined;
    selection.backLimit = selection.backDevice ? measured.get(selection.backDevice) : undefined;
    options.onChange?.(value());
  };

  function value(): CameraSelection {
    return { ...selection };
  }

  function deviceOf(facing: CameraFacing): string {
    return facing === 'front' ? selection.frontDevice : selection.backDevice;
  }

  function setDevice(facing: CameraFacing, device: string): void {
    if (facing === 'front') { selection.front = sourceOf(device); selection.frontDevice = device; }
    else { selection.back = sourceOf(device); selection.backDevice = device; }
  }

  /**
   * Settle both lenses against the cameras that work right now. A saved camera
   * that still works keeps its lens; one that does not is replaced by another
   * working camera, or its lens is turned off when none is left.
   */
  function assign(): void {
    const result = assignLensCameras(
      { front: selection.frontDevice, back: selection.backDevice },
      working().map((camera) => ({ id: camera.name, name: camera.device })),
    );
    setDevice('front', result.front);
    setDevice('back', result.back);
    if (result.lost.front || result.lost.back) toast(t('android.camera.reassigned'), 'info');
  }

  function choose(facing: CameraFacing, id: string): void {
    // Only a camera that works right now can be chosen.
    if (!working().some((camera) => camera.name === id)) return;
    const other: CameraFacing = facing === 'front' ? 'back' : 'front';
    if (deviceOf(other) === id) {
      // One camera, one lens: the other lens takes the camera this lens had, or goes off.
      setDevice(other, deviceOf(facing));
      toast(t('android.camera.swapped'), 'info');
    }
    setDevice(facing, id);
    paintLenses();
    emit();
  }

  /** One lens: a select of the working cameras, or Off when it has none. Off is text, never an option. */
  function lensField(facing: CameraFacing): HTMLElement {
    const key = facing === 'front' ? 'android.cameraFront' : 'android.cameraBack';
    if (!loaded) return field(key, h('span', { class: 'camera-off', text: '…' }));
    const list = working();
    const current = list.find((camera) => camera.name === deviceOf(facing));
    if (!current) {
      // With one working camera it serves the back lens, so the front lens is off by design.
      const hintKey = facing === 'front' && list.length === 1 ? 'android.camera.oneCamera' : undefined;
      return field(key, h('span', { class: 'camera-off', text: t('android.camera.off') }), hintKey);
    }
    return field(key, select<string>(current.name, list.map((camera): [string, string] => [camera.name, displayName(camera)]),
      (id) => choose(facing, id)));
  }

  function paintLenses(): void {
    backSlot.replaceChildren(lensField('back'));
    frontSlot.replaceChildren(lensField('front'));
  }

  function line(warn: boolean, text: string): HTMLElement {
    return h('p', { class: warn ? 'hint warn' : 'hint', text });
  }

  /** One short status under the lenses. Nothing is shown when every listed camera works. */
  function paintStatus(): void {
    const lines: HTMLElement[] = [];
    if (loadFailed) lines.push(line(true, t('android.camera.scanFailed')));
    else if (!loaded || checking) lines.push(line(false, t('android.camera.scanning')));
    else if (noEmulator) lines.push(line(true, t('android.camera.noEmulator')));
    else {
      if (!working().length) {
        lines.push(line(true, t('android.camera.msgNone')));
        if (problem === 'timeout') lines.push(line(false, t('android.camera.timedOut')));
        else if (problem === 'reported') lines.push(line(false, t('android.camera.emulatorSaid', { detail })));
        if (!listed.length) {
          if (windowsCount > 0) lines.push(line(false, t('android.camera.windowsSees', { count: windowsCount })));
          if (problem === 'none') lines.push(line(false, t('android.camera.msgAvdHint')));
        }
      }
      const refused = listed.map((camera) => checkOf(camera)).filter((item): item is CameraCheck => item !== undefined && !item.ok);
      if (refused.some((item) => item.failure === 'permission')) lines.push(line(false, t('android.camera.blocked')));
      else if (refused.some((item) => item.failure === 'unavailable')) lines.push(line(false, t('android.camera.notFound')));
      else if (refused.length) lines.push(line(false, t('android.camera.notSending')));
    }
    statusSlot.replaceChildren(...lines);
  }

  /**
   * One pass: read the emulator's list, then open the cameras that need it. A
   * manual pass (Refresh, or opening the picker) checks every listed camera. A
   * poll checks only the cameras it has not checked yet, so a busy webcam is not
   * reopened every few seconds.
   */
  async function scan(manual: boolean): Promise<void> {
    if (scanning) return;
    scanning = true;
    refreshButton.disabled = true;
    if (element.isConnected) attached = true;
    try {
      const next = await loadCameraChoices();
      if (!next) {
        // The call failed. The picker keeps what it shows; it does not clear the lenses.
        loadFailed = true;
        return;
      }
      loadFailed = false;
      loaded = true;
      noEmulator = !next.emulatorAvailable;
      listed = next.webcams;
      problem = next.problem ?? '';
      detail = next.detail ?? '';
      windowsCount = await countWindowsCameras();
      // A camera that is gone, or renamed, loses its check.
      for (const [name, entry] of checks) {
        if (!listed.some((camera) => camera.name === name && keyOf(camera) === entry.key)) checks.delete(name);
      }
      const due = listed.filter((camera) => manual || checkOf(camera) === undefined);
      if (due.length) {
        checking = true;
        paintStatus();
        for (const camera of due) {
          // The panel this picker belongs to was replaced: stop opening cameras for it.
          if (attached && !element.isConnected) break;
          const key = keyOf(camera);
          const known = manual ? undefined : recentChecks.get(key);
          let check: CameraCheck;
          if (known && Date.now() - known.at < RECENT_CHECK_MS) {
            check = known.check;
          } else {
            check = await checkHostCamera(camera);
            recentChecks.set(key, { at: Date.now(), check });
          }
          checks.set(camera.name, { key, check });
          if (check.ok) measured.set(camera.name, { width: check.width, height: check.height });
          else measured.delete(camera.name);
        }
        checking = false;
      }
      // A replaced picker must not write its old selection back into the device it was made for.
      if (attached && !element.isConnected) return;
      assign();
      paintLenses();
      emit();
      options.onWorking?.(working().map((camera) => ({ name: camera.name, label: displayName(camera) })));
    } finally {
      scanning = false;
      checking = false;
      refreshButton.disabled = false;
      paintStatus();
    }
  }

  // Every caller places the picker on the page right after building it. Once it has
  // been seen there, taking it off again stops its camera work and its reports.
  window.setTimeout(() => { if (element.isConnected) attached = true; }, 0);

  // Hot-plug: re-read the list while the picker is on screen. Once it is gone
  // (replaced or closed), the timer stops and no more camera work is started for it.
  const poll = window.setInterval(() => {
    if (!element.isConnected) {
      window.clearInterval(poll);
      return;
    }
    attached = true;
    void scan(false);
  }, POLL_MS);

  paintLenses();
  paintStatus();
  void scan(false);
  return {
    element,
    value,
    refresh: () => scan(true),
  };
}
