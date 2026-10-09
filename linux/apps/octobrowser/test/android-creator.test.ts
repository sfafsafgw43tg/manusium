/**
 * apps/octobrowser/test/android-creator.test.ts
 *
 * The Android section has exactly one way to create a device: the guided
 * wizard behind "New Android device". These checks read the renderer sources
 * (the repository has no DOM in tests) and pin the three things that were
 * asked for and are easy to regress:
 *
 *   * the "Browse all phones" dropdown is gone, catalogue and all;
 *   * the creator builds an Android Studio (AVD) device through the one
 *     create channel, with no other emulator engine to choose;
 *   * the wizard is keyboard- and screen-reader-navigable.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { DICTS } from '@octo/core';
import { androidBuildIdentity, registerHandsetFile } from '../src/main/android-catalog';

const root = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/** Read a vStudio source directly with Node so the test also runs on Windows,
 * where GitHub's Python launcher is `python`, not necessarily `python3`. */
const studioEntryCache = new Map<string, string>();
const studioArchive = fs.readFileSync(path.join(root, 'studio.zip'));
function studioEntryNames(): string[] {
  const eocd = studioArchive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('studio.zip has no central directory');
  const count = studioArchive.readUInt16LE(eocd + 10);
  let offset = studioArchive.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let index = 0; index < count; index++) {
    if (studioArchive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid studio.zip central entry');
    const nameLength = studioArchive.readUInt16LE(offset + 28);
    const extraLength = studioArchive.readUInt16LE(offset + 30);
    const commentLength = studioArchive.readUInt16LE(offset + 32);
    names.push(studioArchive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}
function studioEntry(name: string): string {
  const cached = studioEntryCache.get(name);
  if (cached !== undefined) return cached;
  const archive = studioArchive;
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('studio.zip has no central directory');
  const count = archive.readUInt16LE(eocd + 10);
  let offset = archive.readUInt32LE(eocd + 16);
  const wanted = `lvStudio arbitrage/vStudio/${name}`;
  for (let index = 0; index < count; index++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid studio.zip central entry');
    const method = archive.readUInt16LE(offset + 10);
    const packedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42);
    const entryName = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (entryName === wanted) {
      const localNameLength = archive.readUInt16LE(local + 26);
      const localExtraLength = archive.readUInt16LE(local + 28);
      const from = local + 30 + localNameLength + localExtraLength;
      const packed = archive.subarray(from, from + packedSize);
      const text = (method === 0 ? packed : inflateRawSync(packed)).toString('utf8');
      studioEntryCache.set(name, text);
      return text;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`Missing vStudio entry: ${name}`);
}

const page = read('apps/octobrowser/src/renderer/launcher-virtualbox.ts');
const creator = read('apps/octobrowser/src/renderer/launcher-android-create.ts');
const catalogue = read('apps/octobrowser/src/renderer/launcher-android.ts');
const css = read('apps/octobrowser/src/renderer/launcher.css');
const ui = read('apps/octobrowser/src/renderer/launcher-ui.ts');
const shell = read('apps/octobrowser/src/renderer/launcher.ts');
const profiles = read('apps/octobrowser/src/renderer/launcher-profiles.ts');
const editor = read('apps/octobrowser/src/renderer/launcher-editor.ts');
const studio = read('apps/octobrowser/src/main/android-studio.ts');
const socksBridge = read('apps/octobrowser/src/main/android-socks-bridge.ts');
const mediaUi = read('apps/octobrowser/src/renderer/launcher-android-media.ts');
const cameraUi = read('apps/octobrowser/src/renderer/launcher-android-cameras.ts');
const installUi = read('apps/octobrowser/src/renderer/launcher-android-install.ts');
const manager = read('apps/octobrowser/src/main/manager.ts');

describe('the Android page', () => {
  it('no longer carries the "Browse all phones" dropdown', () => {
    for (const source of [page, creator, catalogue]) {
      expect(source).not.toContain('browseCatalog');
      expect(source).not.toContain('catalog-toggle');
      expect(source).not.toContain('renderAndroidCatalog');
    }
    expect(css).not.toContain('.catalog-toggle');
    for (const lang of ['en', 'pl'] as const) {
      expect(DICTS[lang]['android.browseCatalog']).toBeUndefined();
      expect(DICTS[lang]['android.browseCatalogHint']).toBeUndefined();
    }
  });

  it('opens the complete creator from the "New Android device" button', () => {
    expect(page).toContain("import { androidCreateWizard } from './launcher-android-create'");
    expect(page).toContain('androidCreate.onclick = () => openCreator();');
    expect(page).toContain("api.invoke('mgr:android-catalog')");
    // The old AVD-only sheet is gone; nothing creates a device any more except
    // the wizard, through its single create channel.
    expect(page).not.toContain('mgr:android-create');
  });

  it('shows the emulator state with the action that installs a missing SDK', () => {
    expect(page).toContain("engineChip({");
    expect(page).toContain("t('android.backend.avd')");
    expect(page).toContain("api.invoke<{ ok: boolean; message: string }>('mgr:android-install-tools')");
  });

  it('lists every AVD in one list', () => {
    expect(page).toContain('for (const machine of machines) androidList.append(androidRow(machine, loadAndroid));');
  });

});

describe('the guided creator', () => {
  it('walks through five steps and creates through one channel', () => {
    for (const key of ['android.step.engine', 'android.step.device', 'android.step.system', 'android.step.setup', 'android.step.review']) {
      expect(creator).toContain(key);
      expect(DICTS.en[key]).toBeTruthy();
      expect(DICTS.pl[key]).toBeTruthy();
    }
    // One create call; the emulator is always Android Studio's AVD.
    expect(creator).toContain("'mgr:android-create-spec'");
    expect(creator).not.toContain('draft.backend');
  });

  it('refuses to move on before the step is answered', () => {
    expect(creator).toContain("problem: () => draft.phone ? '' : t('android.needDevice')");
    expect(creator).toContain("problem: () => NAME_RX.test(draft.name.trim()) ? '' : t('android.nameInvalid')");
    expect(creator).toContain('const NAME_RX = /^[A-Za-z0-9_-]{1,64}$/;');
  });

  it('keeps the whole catalogue inside the wizard: search, specifications, comparison', () => {
    expect(creator).toContain('const phones = context.catalog?.phones ?? [];');
    expect(creator).toContain('specSheet(chosen)');
    expect(creator).toContain('compareTable(chosen)');
    expect(creator).toContain("deviceView: 'list' | 'specs' | 'compare'");
    // Those views replace the list inside the step instead of stacking modals.
    expect(creator).not.toContain('detailDialog(');
    expect(creator).not.toContain('compareDialog(');
  });

  it('is navigable by keyboard and announced to assistive technology', () => {
    expect(creator).toContain("role: 'tablist'");
    expect(creator).toContain("role: 'tabpanel'");
    expect(creator).toContain("role: 'radiogroup'");
    expect(creator).toContain("'aria-checked'");
    expect(creator).toContain("'aria-live': 'polite'");
    expect(creator).toContain("role: 'progressbar'");
    expect(creator).toContain('function rovingFocus');
    expect(creator).toContain("if (event.key === ' ' || event.key === 'Enter')");
  });

  it('shows the storage plan before anything is written', () => {
    expect(creator).toContain("'mgr:android-target-dir'");
    expect(creator).toContain("t('android.spaceTight'");
    expect(creator).toContain("t('android.spec.totalOnDisk')");
    expect(creator).toContain("'mgr:android-progress'");
  });

  it('has a style for every class the wizard renders', () => {
    for (const cls of ['.wizard', '.wiz-rail', '.wiz-step', '.wiz-panel', '.wiz-actions', '.pick-card', '.pick-lines', '.engine-chip']) {
      expect(css).toContain(cls);
    }
  });
});

describe('the engine and image cards', () => {
  it('are stacked one per row so their values are never cut off', () => {
    expect(css).toContain('.pick-grid.two { grid-template-columns: 1fr;');
    // The values wrap; the ellipsis class would clip "Free, part of Android Studio".
    expect(creator).toContain("for (const [key, value] of opts.lines) table.append(h('span', { class: 'muted', text: key }), h('span', { text: value }));");
    expect(css).toContain('.pick-lines > span:nth-child(even) { min-width: 0; text-align: left; overflow-wrap: anywhere; }');
  });
});

describe('motion', () => {
  it('defines one fast, reduced-motion-aware vocabulary', () => {
    for (const name of ['octo-in-up', 'octo-in-right', 'octo-in-left', 'octo-in-pop', 'octo-in-fade', 'octo-just-in']) {
      expect(css).toContain(`@keyframes ${name}`);
    }
    for (const cls of ['.anim-page', '.anim-next', '.anim-prev', '.anim-pop', '.anim-fade']) expect(css).toContain(cls);
    expect(css).toContain('--mo-fast: .1s');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    // Fast by construction: the entry animations only use the shared tokens.
    expect(css).toContain('.anim-page { animation: octo-in-up var(--mo) var(--mo-ease) both; }');
    expect(css).toContain('.anim-fade { animation: octo-in-fade var(--mo-fast) linear both; }');
    for (const token of ['--mo-fast: .1s', '--mo: .15s']) expect(css).toContain(token);
  });

  it('moves the wizard panel in the direction the user went', () => {
    expect(creator).toContain('animateIn(panel');
    expect(creator).toContain("step > paintedStep ? 'next'");
    expect(creator).toContain("step < paintedStep ? 'prev'");
  });

  it('animates every dialog, page switch and freshly created profile', () => {
    expect(ui).toContain('export function animateIn');
    expect(ui).toContain("animateIn(box, 'pop');");
    expect(shell).toContain("if (lastView !== targetView) {");
    expect(shell).toContain("animateIn(v, 'page');");
    expect(profiles).toContain("${fresh ? ' just-in' : ''}");
    expect(profiles).toContain('S.flash = p.id;');
    expect(editor).toContain('if (creating) S.flash = r.id;');
    expect(editor).toContain("if (drawnTab && drawnTab !== tab) animateIn(main, 'fade');");
    expect(css).toContain('.tbody .tr.just-in');
  });

  it('never animates a redraw caused by typing or ticking a box', () => {
    // The profile table redraws on every keystroke: only the row a create
    // action produced carries the entry animation.
    expect(profiles).toContain('if (fresh) S.flash = \'\';');
    expect(shell).toContain('lastView = targetView;');
  });
});

describe('vStudio Mobile inside the phones', () => {
  it('never guesses a camera and never leaves a lens without a picture', () => {
    expect(studio).toContain("function cameraValue(source: CameraSource | string, webcam = '')");
    expect(page).toContain("getUserMedia({ audio: true, video: false })");
    expect(page).toContain('microphoneDevice');
    expect(studio).toContain('input.microphoneDevice === undefined');
    expect(studio).toContain("args.push('-allow-host-audio')");
    expect(studio).toContain("...(forPicker ? ['-webcam-list', '-verbose'] : ['-webcam-list'])];");
    expect(studio).toContain('runCameraList(tools.emulator, args, tools.root, timeout)');
    // Nothing is numbered from Windows: the only webcam names come from the emulator.
    expect(studio).not.toContain('webcamsFromHostNames');
    expect(studio).not.toContain('hostCameraNames');
    // An unknown or inactive camera is always disabled; never guess webcam0.
    expect(studio).toContain("return source === 'webcam' && WEBCAM.test(webcam) ? webcam : 'none';");
    expect(studio).not.toContain("webcam || 'webcam0'");
    expect(studio).toContain("'octobrowser.cameraFront': values.front === 'none' ? 'none' : 'webcam',");
    expect(studio).toContain("'octobrowser.cameraBack': values.back === 'none' ? 'none' : 'webcam',");
    expect(studio).not.toContain("'hw.camera': cameraEnabled");
    expect(studio).toContain("'hw.camera.back': values.back");
    // The guest is told the resolution its chosen cameras can actually deliver:
    // what was measured for a host camera, a plain 640x480 for a camera nobody
    // measured yet, and the default size when no lens has a camera. Advertising
    // more is what made the stock Camera app ask for a stream the webcam could
    // not produce and stop. (The crash the user reported.)
    expect(studio).toContain("if (value === 'none') return undefined;");
    expect(studio).toContain('return clampCameraLimit(measured ?? UNMEASURED_CAMERA_LIMIT);');
    expect(studio).toContain('const UNMEASURED_CAMERA_LIMIT = { width: 640, height: 480 };');
    expect(studio).toContain("'hw.camera.maxHorizontalPixels': String(maxHorizontal || DEFAULT_CAMERA_LIMIT.width)");
    expect(studio).toContain("'hw.camera.maxVerticalPixels': String(maxVertical || DEFAULT_CAMERA_LIMIT.height)");
    expect(studio).toContain("const args = [`@${name}`, '-camera-back', cameraValues.back, '-camera-front', cameraValues.front];");
    // A camera that is not there is never replaced by a picture: the lenses are
    // settled from the cameras that are active right now, and a lens with none is off.
    expect(studio).toContain("const assigned = assignLensCameras({ front: frontDevice, back: rearPreferred }, live);");
    expect(studio).toContain("front: assigned.front ? 'webcam' : 'none',");
    expect(studio).toContain("back: assigned.back ? 'webcam' : 'none',");
    // The emulator's own picture is not a camera here, so no lens is ever
    // switched to it, and no GPU mode is required for it.
    expect(studio).not.toContain('usesVirtualScene');
    expect(studio).not.toContain("'virtualscene'");
    expect(studio).not.toContain("'emulated'");
    // Both lenses on one endpoint is never launched: the front lens gives way.
    expect(studio).toContain("if (frontValue !== 'none' && frontValue === backValue) frontValue = 'none';");
    expect(studio).toContain('export async function androidCameraChoices');
    expect(manager).toContain("handle('mgr:android-camera-choices'");
    // DirectShow camera state is never restored from or saved into Quick Boot.
    expect(studio).toContain("if (input.bootMode === 'cold' || usesHostCamera) args.push('-no-snapshot-load')");
    expect(studio).toContain("if (usesHostCamera) args.push('-no-snapshot-save')");
    // Closing an AVD also releases the exact companion holding its host camera.
    expect(studio).toContain('async function releaseMediaCompanionForAvd');
    expect(studio).toContain('function terminateOrphanedMediaCompanion');
    expect(studio).toContain('ownsCompanionProcess(plugin, pid)');
    expect(studio).toContain('await releaseMediaCompanionForAvd(clean)');
    expect(studio).toContain('void releaseMediaCompanionForAvd(name)');
    expect(studio).toContain('void startAndroidCameraDiagnostics(name)');
    expect(studio).toContain("'CameraProvider:V'");
    expect(studio).toContain("'AndroidRuntime:E'");
    // A camera that fell back is still a launch, with the reason shown.
    expect(studio).toContain('return { cameraWarning, notes: launchNotes };');
    expect(page).toContain("t('android.camera.disabledForLaunch')");
  });

  it('checks and repairs the camera and microphone of one device', () => {
    expect(studio).toContain('export async function androidMediaCheck');
    expect(studio).toContain('export async function repairAndroidMedia');
    // Only what decides whether Android can capture anything is checked, and
    // every item it does check has a sentence in both languages.
    for (const key of ['mic', 'webcam', 'wired', 'audio', 'slots', 'resolution']) {
      expect(studio).toContain(`android.media.check.${key}`);
    }
    for (const key of ['mic', 'webcam', 'wired', 'audio', 'slots', 'resolution', 'missing']) {
      expect(DICTS.en[`android.media.check.${key}`]).toBeTruthy();
      expect(DICTS.pl[`android.media.check.${key}`]).toBeTruthy();
    }
    // The companion chain is gone from the Android panel for good.
    expect(studio).not.toContain('android.media.check.plugin');
    expect(studio).not.toContain('android.media.check.python');
    expect(studio).not.toContain('android.media.check.broadcast');
    expect(manager).toContain("handle('mgr:android-media-check'");
    expect(manager).toContain("handle('mgr:android-media-repair'");
    expect(manager).toContain("handle('mgr:android-webcams'");
    // Repairing wires a device to a camera it can really open.
    expect(studio).toContain('export function mediaConfig');
    expect(manager).toContain('repairAndroidMedia(String(name ?? \'\'), { cameraDevice');
  });

  it('is reachable from the device row, and offers only active host cameras in the creator', () => {
    expect(page).toContain('androidMediaDialog({ name: machine.name');
    // A lens is a select of the active host cameras, or the text Off. The
    // emulator's own picture and "no camera" are never options.
    expect(cameraUi).toContain("select<string>(current.name, list.map((camera): [string, string] => [camera.name, displayName(camera)]),");
    expect(cameraUi).toContain("(id) => choose(facing, id)));");
    expect(cameraUi).not.toMatch(/\[\s*'(none|emulated|virtualscene)'\s*,/);
    expect(cameraUi).not.toContain("'emulated'");
    expect(cameraUi).not.toContain("'virtualscene'");
    expect(cameraUi).not.toContain("'android.camera.none'");
    expect(cameraUi).not.toContain("'android.camera.emulated'");
    expect(cameraUi).not.toContain("'android.camera.virtualscene'");
    expect(cameraUi).toContain("t('android.camera.off')");
    expect(cameraUi).toContain("'android.camera.oneCamera'");
    expect(cameraUi).toContain("t('android.camera.msgNone')");
    // No tags and no "tested" wording: a camera is listed only once it has sent a picture.
    expect(cameraUi).not.toContain('android.camera.untested');
    expect(cameraUi).not.toContain('android.camera.fromWindows');
    expect(cameraUi).toContain("t('android.camera.notSending')");
    expect(cameraUi).toContain("t('android.camera.msgAvdHint')");
    expect(cameraUi).toContain("t('android.camera.noEmulator')");
    // One camera serves one lens: choosing the camera of the other lens swaps the two.
    expect(cameraUi).toContain("toast(t('android.camera.swapped'), 'info');");
    expect(cameraUi).toContain('assignLensCameras(');
    expect(cameraUi).toContain('if (!working().some((camera) => camera.name === id)) return;');
    expect(creator).toContain('cameraDevice: draft.cameraBackDevice || draft.cameraFrontDevice');
  });
});

describe('every window format', () => {
  it('has a breakpoint for narrow, small, short and very wide windows', () => {
    for (const query of ['@media (max-width: 860px)', '@media (max-width: 620px)', '@media (max-height: 620px)', '@media (min-width: 1700px)']) {
      expect(css).toContain(query);
    }
    // The pieces with a fixed width are the ones that must give way.
    expect(css).toContain('#rail { width: 62px;');
    expect(css).toContain('#side2 { display: none; }');
    expect(css).toContain('.modal-actions { flex-direction: column-reverse; align-items: stretch; }');
    expect(css).toContain('.vm-row { flex-wrap: wrap; }');
    expect(css).toContain('.modal-box.wizard-modal { height: 96vh; }');
  });
});

/**
 * Three failures reported from a real install: a leftover device appeared
 * next to the real one, launching only started the media companion (the
 * emulator died unseen), and a running device could not be stopped.
 */
describe('devices that do not start, and devices that will not stop', () => {
  it('watches the first seconds of the emulator instead of claiming success', () => {
    expect(studio).toContain("stdio: ['ignore', 'pipe', 'pipe']");
    expect(studio).toContain('function emulatorError');
    expect(studio).toContain('The Android Emulator stopped immediately');
    // The reasons that actually happen get their own sentence.
    expect(studio).toContain('has no usable system image, so it cannot boot');
    expect(studio).toContain('cannot use hardware virtualisation');
  });

  it('can stop a device politely, and force it when it stopped answering', () => {
    expect(studio).toContain('export async function stopAndroidAvd');
    expect(studio).toContain("await run(tools.adb, ['-s', serial, 'emu', 'kill']");
    expect(studio).toContain('async function killEmulatorProcess');
    expect(manager).toContain("handle('mgr:android-stop'");
    expect(page).toContain("api.invoke<{ stopped: boolean; how: string }>('mgr:android-stop', machine.name, force)");
    expect(page).toContain("{ icon: 'stop', label: t('android.stop'), fn: () => void stopDevice(false) }");
    expect(page).toContain("{ icon: 'close', label: t('android.forceStop'), danger: true, fn: () => void stopDevice(true) }");
  });

  it('marks the leftover of an interrupted creation instead of offering to launch it', () => {
    expect(studio).toContain('function avdIncomplete');
    expect(studio).toContain('incomplete: avdIncomplete(item.path),');
    expect(page).toContain("machine.incomplete ? h('span', { class: 'pill bad', text: t('android.incomplete') }) : null");
    expect(page).toContain("disabled: !machine.running && machine.incomplete,");
    for (const key of ['android.incomplete', 'android.incompleteHint', 'android.incompleteNote', 'android.forceStop', 'android.stopping', 'android.starting']) {
      expect(DICTS.en[key]).toBeTruthy();
      expect(DICTS.pl[key]).toBeTruthy();
    }
  });
});

/**
 * A long install used to be invisible: the button disabled itself, a toast
 * said it had started, and nothing moved for minutes. Every install now has
 * a card that shows the live stage, the percentage and the elapsed time, and
 * stays behind with an explicit installed / failed state.
 */
describe('showing an install while it runs and when it is done', () => {
  it('has one card that reports progress, time and the end state', () => {
    expect(installUi).toContain('export async function runInstall');
    expect(installUi).toContain("api.on<Progress>('mgr:android-progress'");
    expect(installUi).toContain("card.classList.add(ok ? 'done' : 'failed');");
    expect(installUi).toContain("t(ok ? 'android.install.done' : 'android.install.failed'");
    expect(installUi).toContain('function elapsedText');
    expect(css).toContain('.install-card');
    expect(css).toContain('.install-card.done');
    expect(css).toContain('.install-card.failed');
  });

  it('is used by every long Android install', () => {
    // Page: both engines. Creator: both engines.
    expect(page).toContain('runInstall(installHost, {');
    expect(page).toContain("task: () => api.invoke<{ ok: boolean; message: string }>('mgr:android-install-tools')");
    expect(creator).toContain('const ok = await runInstall(installHost, {');
    // No more silent "it started" toast with nothing on screen.
    expect(page).not.toContain("toast(t('android.installStarted'), 'ok');");
    expect(creator).not.toContain("toast(t('android.installStarted'), 'ok');");
  });

  it('confirms a finished creation instead of just closing the dialog', () => {
    expect(creator).toContain("t('android.createdTitle', { name: result.name })");
    expect(creator).toContain("next.textContent = t('common.close');");
    for (const key of ['android.install.running', 'android.install.done', 'android.install.failed', 'android.install.took', 'android.createdTitle', 'android.createdBody']) {
      expect(DICTS.en[key]).toBeTruthy();
      expect(DICTS.pl[key]).toBeTruthy();
    }
  });
});

/**
 * Reported from a real install: winget answered "Found an existing package
 * already installed ... No available upgrade found", the card kept saying
 * "Not installed", and Next stayed blocked - a dead end.
 */
describe('an engine that is installed but not detected', () => {
  it('re-checks instead of holding a frozen snapshot, and never dead-ends', () => {
    expect(creator).toContain('async function recheckEngines');
    expect(creator).toContain('await recheckEngines();');
    expect(creator).toContain("t('android.recheckEngines')");
    // The explicit way past a wrong "not installed".
    expect(creator).toContain("t('android.useAnyway')");
    expect(creator).toContain('anyway.onclick = () => { forced = true;');
    expect(creator).toContain("problem: () => avdReady() || forced ? '' : t('android.needEngine')");
    // The page must not lock the door either.
    expect(page).toContain('androidCreate.disabled = false;');
    for (const key of ['android.recheckEngines', 'android.useAnyway', 'android.needEngineHint']) {
      expect(DICTS.en[key]).toBeTruthy();
      expect(DICTS.pl[key]).toBeTruthy();
    }
  });
});

/**
 * The vStudio companion itself is shipped in studio.zip. It was reworked for
 * the emulators: mobile mode, the device's own camera/microphone names, and a
 * webcam-compatible frame that Android CameraProvider can open reliably.
 */
describe('vStudio Mobile, the app', () => {
  const zip = fs.readFileSync(path.join(root, 'studio.zip'));

  /** Read one file out of the bundle without unpacking all 23 MB. */
  const entry = studioEntry;

  it('ships a bundle that still looks like a zip', () => {
    expect(zip.length).toBeGreaterThan(1_000_000);
    expect(zip.subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('calls itself vStudio Mobile and knows which device it serves', () => {
    const app = entry('app.py');
    expect(app).toContain('APP_NAME = "vStudio Mobile"');
    expect(app).toContain('APP_SHORT = "vS Mobile"');
    expect(app).toContain('def mobile_camera_name');
    expect(app).toContain('def mobile_microphone_name');
    expect(app).toContain('self.title("%s  \\u2022  %s" % (APP_NAME,');
    // The bar that answers "what do I pick inside Android?".
    expect(app).toContain('def _build_mobile_bar');
    expect(app).toContain('def _mobile_match_frame');
    expect(app).toContain('def _mobile_copy_names');
    expect(app).toContain('"mobile": {');
    expect(app).toContain('VD.connect_running_android');
    expect(app).toContain('def _poll_android_connection');
    expect(app).toContain('"1180x920" if MOBILE_ON');
    const devices = entry('virtual_devices.py');
    expect(devices).toContain('def detect_running_android');
    expect(devices).toContain('"emu", "avd", "hostmicon"');
    expect(devices).toContain('"hw.camera.front"');
    // Dashboard lists only sources that produce a frame/open a stream now.
    expect(app).toContain('def _build_source_dashboard');
    expect(app).toContain('def _scan_live_sources');
    expect(app).toContain('self.video.set_live_camera');
    expect(devices).toContain('def probe_working_cameras');
    expect(devices).toContain('ok, frame = cap.read()');
    expect(devices).toContain('def probe_working_microphones');
    expect(devices).toContain('stream.start()');
    expect(devices).toContain('"cable output" in low');
    expect(devices).toContain('"octobrowser.deviceLabel"');
    // Side rails, log and every settings sector can fold away; one tab owns
    // exactly one cached scrollbar even when sound and music share it.
    expect(app).toContain('def _toggle_settings_panel');
    expect(app).toContain('def _toggle_library_panel');
    expect(app).toContain('def _toggle_log_panel');
    expect(app).toContain('_vstudio_section_header');
    expect(app).toContain('_vstudio_scroll_box');
    expect(app).toContain('self._settings_visible = False');
    expect(app).toContain('"ui": {"theme": "obsidian"');
    expect(app).toContain('THEME_IDS = ["obsidian", "midnight", "slate"');
    expect(app).toContain('def _change_theme');
    const settingsUi = entry('ui_v14.py');
    expect(settingsUi).toContain('Appearance theme');
    expect(settingsUi).toContain('main.save_config(self.CFG)');
    const audioUi = entry('ui_v13.py');
    expect(audioUi).toContain('self.var_monitor = ctk.BooleanVar(value=False)');
    expect(audioUi).toContain('a["monitor_on"] = False');
    expect(audioUi).toContain('Źródło mikrofonu: %s');
    expect(entry('audio_engine.py')).toContain('def active_input_device_name');
    expect(entry('audio_engine.py')).toContain('self.monitor.set_device(device)');
    expect(entry('config.json')).toContain('"monitor_on": false');
    expect(entry('config.example.json')).toContain('"broadcastRequest": ""');
    expect(entry('config.example.json')).toContain('"mobile": {');
    expect(entry('video_engine.py')).toContain('def set_live_camera');
  });

  it('publishes only after an explicit Octo command and reports real camera readiness', () => {
    const app = entry('app.py');
    expect(app).toContain('def _poll_octobrowser_command');
    expect(app).toContain('"broadcastRequest"');
    expect(app).toContain('def _write_runtime_status');
    expect(app).toContain('"cameraActive": bool(self.video and self.video.vcam_active)');
    expect(app).toContain('"inputCameraActive": input_active');
    expect(studio).toContain('runtime?.inputCameraRequested === true');
  });

  it('can correct a sideways live camera in both staged vStudio plugins', () => {
    const app = entry('app.py');
    const video = entry('video_engine.py');
    expect(app).toContain('def _rotate_live_input');
    expect(app).toContain('def _mirror_live_input');
    expect(app).toContain('"input_rotation": 0, "input_mirror": False');
    expect(app).toContain('self.video.input_rotation = input_rotation');
    expect(video).toContain('self.input_rotation = 0');
    expect(video).toContain('rotation = int(getattr(self, "input_rotation", 0) or 0) % 360');
    expect(video.indexOf('live = cv2.rotate(live')).toBeLessThan(video.indexOf('return self._fit(live, wW, wH)'));
    // The rotation the browser plugin applies to its own input stays; the
    // Android launch dialog no longer has a transform to set, because Android
    // reads the camera directly.
    expect(studio).toContain('input_rotation: input.inputRotation');
    expect(page).not.toContain('hostCameraRotation');
    expect(mediaUi).not.toContain('applyCameraPreviewTransform');
    expect(page).not.toContain('startMediaCompanion');
  });

  it('uses a driver-safe Android sensor frame without an implicit quarter-turn', () => {
    const app = entry('app.py');
    const video = entry('video_engine.py');
    expect(entry('phone_formats.py')).toContain('def register_custom_format');
    expect(app).toContain('def mobile_stream_resolution');
    expect(app).toContain('return (480, 640)');
    expect(app).toContain('self.video.virtual_output_size = (640, 480)');
    expect(app).toContain('self.video.virtual_output_rotation = 0');
    expect(app).not.toContain('self.video.virtual_output_rotation = 90');
    expect(video).toContain('canvas = np.zeros((ch, cw, 3)');
    expect(video).toContain('canvas[y:y + nh, x:x + nw] = fitted');
    // OpenCV frames are BGR; declare it so pyvirtualcam performs the backend's
    // required DirectShow format conversion rather than swapping channels.
    expect(video).toContain('kwargs["fmt"] = pixel_formats.BGR');
  });

  it('uses the dark media dashboard and restrained transform feedback in the launcher', () => {
    expect(mediaUi).toContain("box.classList.add('media-dashboard')");
    expect(mediaUi).toContain("class: 'media-dashboard-grid'");
    expect(css).toContain('.modal-box.media-dashboard');
    expect(css).toContain('.media-dashboard .media-check');
  });

  it('is configured by OctoBrowser through the section the app reads', () => {
    expect(studio).toContain('mobile: {');
    expect(studio).toContain('export function defaultAudioInput');
    expect(studio).toContain('const FOREIGN_CAMERA =');
    // No companion camera source is offered to Android any more, and a device
    // saved with the old one still resolves to the host camera behind it.
    expect(studio).toContain("export type CameraSource = 'none' | 'webcam';");
    expect(studio).toContain("export function normalizeCameraSource(_saved?: string): CameraSource {");
    expect(cameraUi).toContain("export type CameraSource = 'none' | 'webcam';");
    expect(cameraUi).not.toContain("'vstudio'");
    expect(mediaUi).not.toContain("'vstudio'");
    expect(page).not.toContain("'vStudio Mobile'");
    expect(creator).not.toContain("'vStudio Mobile'");
  });
});

/** The round of fixes asked for after the first real device session. */
describe('devices, languages and the freeze', () => {
  it('says "Applying" instead of freezing silently - and only where it can block', () => {
    expect(ui).toContain('export async function busy<T>(button: HTMLElement, labelKey: string');
    expect(catalogue).toContain("busy(save, 'android.applying'");
    expect(css).toContain('.btn.is-busy');
    // Fast actions stay silent: no busy state on a plain refresh or a filter.
    expect(page).not.toContain("busy(androidRefresh");
  });

  it('saving the media panel waits for the saved cameras, so it never writes empty lenses', () => {
    expect(mediaUi).toContain('save.disabled = true;');
    expect(mediaUi).toContain('save.disabled = device.running || !check;');
  });

  it('checks the camera without booting a device, and lets it go at once', () => {
    // A camera is opened for a moment, its first picture is awaited, and the stream is
    // released straight away, so the emulator or a website can use it next.
    expect(cameraUi).toContain('export function checkHostCamera');
    expect(cameraUi).toContain('navigator.mediaDevices.getUserMedia');
    expect(cameraUi).toContain('navigator.mediaDevices.enumerateDevices');
    expect(cameraUi).toContain('deviceId: { exact: match.deviceId }');
    expect(cameraUi).toContain("track?.readyState === 'live'");
    expect(cameraUi).toContain('check = await checkHostCamera(camera);');
    // A picker whose panel was replaced stops opening cameras, and an opened picker reuses a
    // check made moments ago, so re-rendering the creator does not open every camera again.
    expect(cameraUi).toContain('if (attached && !element.isConnected) break;');
    expect(cameraUi).toContain('if (attached && !element.isConnected) return;');
    expect(cameraUi).toContain('const RECENT_CHECK_MS = 15_000;');
    expect(cameraUi).toContain('release(attempt);');
    expect(cameraUi).toContain('stream.getTracks().forEach((track) => track.stop());');
    // The check replaces the old 60-second hold and its preview tools.
    expect(cameraUi).not.toContain('60_000');
    expect(mediaUi).not.toContain('probeHostCamera');
    expect(mediaUi).not.toContain('testHostCamera');
    // One picker serves all the places a device is configured.
    expect(creator).toContain('const cameras = cameraPicker({');
    expect(catalogue).toContain('const cameras = cameraPicker({');
    expect(page).toContain('const cameras = cameraPicker({');
    expect(page).toContain('androidMediaDialog({ name: machine.name');
    expect(mediaUi).toContain("cameraPicker({");
    // The launcher window may use a camera and microphone for explicit local previews.
    expect(manager).toContain('setPermissionRequestHandler');
    expect(manager).toContain("callback(permission === 'media')");
  });

  it('remembers how a device was launched, and in which language', () => {
    expect(studio).toContain('export function androidLaunchPrefs');
    expect(studio).toContain('export function rememberAndroidLaunch');
    expect(studio).toContain('export function localeArgs');
    expect(studio).toContain('persist.sys.locale');
    expect(manager).toContain("handle('mgr:android-launch-prefs'");
    expect(manager).toContain('rememberAndroidLaunch(String(input?.name');
    expect(page).toContain("api.invoke<AndroidLaunchPrefs>('mgr:android-launch-prefs'");
    expect(studio).toContain("['-prop', `persist.sys.locale=${tag}`");
  });

  it('selects saved Android proxies and can add an eligible proxy without leaving launch', () => {
    expect(page).toContain("proxy.type === 'socks5'");
    expect(page).toContain("['socks5', 'SOCKS5']");
    expect(page).toContain("['none', t('proxy.none'), 'close']");
    expect(page).toContain("'mgr:proxies-add', address");
    expect(page).toContain("api.invoke<SavedProxy[]>('mgr:proxies')");
    expect(page).toContain('proxyId = created?.id ?? proxyId');
    expect(manager).toContain("saved.type === 'socks5' ? this.proxies.resolve(proxyId) : saved");
    expect(studio).toContain('startSocksHttpBridge(input.proxy)');
    expect(socksBridge).toContain("server.listen(0, '127.0.0.1'");
    expect(socksBridge).toContain("delete headers['proxy-authorization']");
    expect(socksBridge).toContain("type: 5");
  });

  it('offers app stores for a running device', () => {
    expect(manager).toContain("handle('mgr:android-store-install'");
    expect(page).toContain("t('android.stores.action')");
    expect(mediaUi).toContain('export function androidStoresDialog');
    for (const key of ['android.applying', 'android.language', 'android.stores.title', 'android.stores.search']) {
      expect(DICTS.en[key]).toBeTruthy();
      expect(DICTS.pl[key]).toBeTruthy();
    }
  });
});

describe('vStudio Mobile: one engine, one language, one audio tab', () => {
  const entry = studioEntry;
  const app = entry('app.py');

  it('broadcasts through Unity Capture only', () => {
    expect(app).toContain('VCAM_BACKEND = "unitycapture"');
    expect(app).toContain('self.video.vcam_backend = VCAM_BACKEND');
    // Installers do not ship inside the companion payload; the signed app-side
    // requirement repair downloads the official driver only on explicit use.
    expect(studioEntryNames().some((name) => /(?:^|\/)(?:scripts|INSTALUJ\.bat)/i.test(name))).toBe(false);
    expect(read('apps/octobrowser/src/main/media-requirements.ts')).toContain('github.com/schellingb/UnityCapture/archive');
  });

  it('starts in English, can switch to Polish, and starts empty', () => {
    expect(app).toContain('"ui": {"theme": "obsidian", "language": "en"');
    expect(app).toContain('def tr(text)');
    expect(app).toContain('def _translate_ctk_widgets');
    expect(app).toContain('LANG.startswith("pl")');
    // No sample media is loaded any more; a per-device folder still is.
    expect(app).toContain('folder = str(MOBILE.get("media_folder")');
    expect(app).not.toContain('media_dir = os.path.join(APP_DIR, "media")');
    expect(studioEntryNames().some((name) => name.includes('/media/'))).toBe(false);
  });

  it('has one sound tab and no 3D face generator', () => {
    const tabs = app.slice(app.indexOf('tab_names = ['), app.indexOf('self._build_v14_ui'));
    expect(tabs).toContain('sound_tab');
    expect(tabs).not.toContain('Generator 3D Twarzy');
    expect(tabs).toContain('self._tab_music(merged)');
  });
});

describe('isolating the whole app behind Whonix', () => {
  it('is a real guide, with the network settings that do the isolating', () => {
    expect(shell).toContain('function whonixPanel');
    expect(DICTS.en['sec.whonix.s5']).toContain('internal network "Whonix"');
    expect(DICTS.en['sec.whonix.s6']).toContain('10.152.152.10');
    expect(DICTS.en['sec.whonix.s7']).toContain('Gateway first');
    // The one thing that does not work in there is said out loud.
    expect(DICTS.en['sec.whonix.emulator']).toContain('hardware virtualisation');
    for (const key of Object.keys(DICTS.en).filter((k) => k.startsWith('sec.whonix.'))) {
      expect(DICTS.pl[key], key).toBeTruthy();
    }
    expect(manager).toContain("whonix: 'https://www.whonix.org/wiki/Download'");
  });
});

describe('apps section', () => {
  it('groups stores and browsers into a dropdown with icons and toggles', () => {
    expect(mediaUi).toContain("t('android.stores.groupStores')");
    expect(mediaUi).toContain("t('android.stores.groupBrowsers')");
    expect(mediaUi).toContain("h('span', { class: 'app-icon' }, icon(store.icon, 18))");
    expect(mediaUi).toContain("'mgr:android-store-states'");
    expect(mediaUi).toContain('install.disabled = wanted.size === 0;');
    expect(mediaUi).not.toContain('install.disabled = wanted.size === 0 || !device.running');
    expect(mediaUi).toContain("action: state?.enabled ? 'disable' : 'enable'");
    expect(mediaUi).toContain("action: 'uninstall'");
    expect(css).toContain('.app-row');
    expect(css).toContain('.app-group > summary');
  });
});

describe('the media library and the new name', () => {
  it('copies one folder of photos and videos into the gallery', () => {
    expect(manager).toContain("handle('mgr:android-media-folder'");
    expect(manager).not.toContain("handle('mgr:android-media-use'");
    expect(manager).toContain("handle('mgr:android-media-push'");
    expect(studio).toContain('media_folder: input.mediaFolder');
    // The library copies photos and videos into a running device; the camera
    // itself now reads a live camera instead of playing a folder.
    expect(mediaUi).toContain("api.invoke<MediaPushResult>('mgr:android-media-push'");
    expect(mediaUi).not.toContain('mgr:android-media-use');
    expect(mediaUi).toContain('export function androidMediaLibrary');
    // The device's own library survives a restart of the app.
    expect(studio).toContain('mediaFolder: string;');
  });

  it('is called Octo.su everywhere the user can see it', () => {
    expect(DICTS.en['od.openBrowser']).toContain('Octo.su');
    expect(manager).toContain("this.tray.setToolTip('Octo.su')");
    expect(manager).toContain("title: 'Octo.su'");
    for (const dict of [DICTS.en, DICTS.pl]) {
      expect(Object.values(dict).some((value) => value.includes('OctoBrowser'))).toBe(false);
    }
  });
});

describe('the Plugins panel can fix itself', () => {
  const reqs = read('apps/octobrowser/src/main/media-requirements.ts');

  it('installs each missing piece from the vendor, in the panel', () => {
    expect(reqs).toContain('export async function installUnityCapture');
    expect(reqs).toContain('export async function installVbCable');
    expect(reqs).toContain('export async function installPython');
    expect(reqs).toContain('github.com/schellingb/UnityCapture/archive');
    expect(reqs).toContain('download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip');
    expect(reqs).toContain("runWinget('Python.Python.3.12')");
    // Drivers are installed visibly and with the Windows consent prompt.
    expect(reqs).toContain('-Verb RunAs');
    expect(manager).toContain("handle('mgr:plugin-install-requirement'");
    expect(shell).toContain("api.invoke<{ ok: boolean; message: string; needsRestart?: boolean }>('mgr:plugin-install-requirement'");
    expect(shell).toContain("t('plugins.install'");
  });

  it('detects what it installed, and lets Start work without the optional bits', () => {
    expect(reqs).toContain('export function unityCaptureRegistered');
    expect(reqs).toContain('export function vbCableInstalled');
    expect(studio).toContain('if (unityCaptureRegistered()) return true;');
    expect(studio).toContain("return process.platform === 'win32' && vbCableInstalled();");
    // Start is blocked only by the requirements marked as required.
    expect(studio).toContain('requirements.every((item) => item.ok || !item.required)');
    expect(studio).toContain('complete: mediaPluginActive(plugin)');
    for (const key of ['plugins.install', 'plugins.installFrom', 'plugins.recheck', 'plugins.partly']) {
      expect(DICTS.en[key]).toBeTruthy();
      expect(DICTS.pl[key]).toBeTruthy();
    }
  });
});

describe('the last step of the creator', () => {
  it('offers the apps to preinstall right there', () => {
    expect(creator).toContain("t('android.stores.preinstall')");
    expect(creator).toContain("api.invoke<StoreEntry[]>('mgr:android-stores')");
    expect(creator).toContain('apps: draft.apps, appFiles: draft.appFiles');
    expect(creator).toContain("extensions: ['apk']");
    expect(manager).toContain('files: launchPrefs.appFiles');
    expect(studio).toContain('appFiles: Record<string, string>;');
    // They are installed when the device first boots, not before.
    expect(manager).toContain('private async installQueuedApps');
    expect(manager).toContain("['sys', 'boot_completed'].join('.')");
    expect(studio).toContain('apps: string[];');
  });

  it('can ring Windows when the device is ready', () => {
    expect(creator).toContain("toggle(draft.notify, 'android.notifyWhenDone'");
    expect(creator).toContain("api.invoke('mgr:notify'");
    expect(manager).toContain("handle('mgr:notify'");
    expect(manager).toContain('silent: input?.silent === true');
    for (const key of ['android.notifyWhenDone', 'android.notifyHint', 'android.notifyWithApps', 'android.stores.preinstall']) {
      expect(DICTS.en[key]).toBeTruthy();
      expect(DICTS.pl[key]).toBeTruthy();
    }
  });

});

describe('minimized Android downloads', () => {
  it('keeps device creation visible and formats ETA in minutes', () => {
    expect(creator).toContain('setModalCloseOverride(minimizeCreation)');
    expect(creator).toContain('android-download-dock');
    expect(creator).toContain('progressText(p, progressStartedAt)');
    expect(installUi).toContain('ETA: ${minutes} min');
    expect(installUi).toContain('Math.ceil(remaining / 60)');
    expect(css).toContain('.android-download-dock');
    for (const key of ['title', 'minimize', 'restore', 'done', 'failed']) {
      expect(DICTS.en[`android.downloads.${key}`]).toBeTruthy();
      expect(DICTS.pl[`android.downloads.${key}`]).toBeTruthy();
    }
  });
});

describe('the staged companion is kept current', () => {
  it('re-stages when this build ships a newer vStudio', () => {
    expect(studio).toContain('const PAYLOAD_VERSION =');
    expect(studio).toContain('function stagedPayload');
    expect(studio).toContain('outdated: version < PAYLOAD_VERSION');
    // The refresh keeps the user's own config.json.
    expect(studio).toContain("config = fs.readFileSync(path.join(root, 'config.json'), 'utf8')");
    expect(studio).toContain('updateAvailable: staged.installed && staged.outdated');
    expect(studio).toContain("!lower.startsWith('media/')");
    expect(studio).toContain("'output', 'media', 'scripts'");
    expect(manager).toContain("handle('mgr:plugin-update'");
    expect(shell).toContain("api.invoke<{ ok: boolean; message: string }>('mgr:plugin-update', entry.id)");
    for (const key of ['plugins.updateAvailable', 'plugins.updateNow', 'plugins.reinstall']) {
      expect(DICTS.en[key]).toBeTruthy();
      expect(DICTS.pl[key]).toBeTruthy();
    }
  });

  it('does not block profile launch while refreshing the browser companion', () => {
    expect(studio).toContain('export function startWebMediaCompanionAsync');
    expect(studio).toContain('await fs.promises.readFile(bundle.path)');
    expect(studio).toContain('await fs.promises.writeFile(file, output');
    expect(manager).toContain('void startWebMediaCompanionAsync(');
    expect(manager).not.toContain('const result = startWebMediaCompanion({ profileName: label');
  });

  it('keeps Android listing, deletion, plugin checks and staging off the main thread', () => {
    expect(studio).toContain('async function folderBytes');
    expect(studio).toContain('await fs.promises.stat(full)');
    expect(studio).toContain('await fs.promises.rm(avd.path');
    expect(studio).toContain('export async function mediaCompanionStatusAsync');
    expect(studio).toContain('export async function ensureMediaCompanionAsync');
    expect(manager).toContain('await androidStudioStatusAsync()');
    expect(manager).toContain('status: await mediaCompanionStatusAsync(id)');
  });

  it('binds vStudio Mobile to the exact selected DirectShow camera name', () => {
    const devices = studioEntry('virtual_devices.py');
    const video = studioEntry('video_engine.py');
    expect(devices).toContain('class NamedDirectShowCapture');
    expect(devices).toContain('graph.add_video_input_device(index)');
    expect(video).toContain('VD.open_camera_exact(idx, str(name))');
  });

});

describe('portable handset files', () => {
  it('imports one handset or a validated directory safely on Windows', () => {
    expect(creator).toContain("'mgr:android-handset-directory'");
    expect(creator).toContain("t('android.handsetImportDirectory')");
    expect(manager).toContain("handle('mgr:android-handset-directory'");
    expect(manager).toContain("handle('mgr:android-custom-directory'");
    expect(manager).toContain("handle('mgr:android-custom-rom'");
    expect(creator).toContain("'mgr:android-custom-directory'");
    expect(creator).toContain("'mgr:android-custom-rom'");
    expect(creator).toContain("t('android.custom.importRom')");
    expect(creator).toContain("t('android.custom.romWarning')");
    // These shared renderer/main paths are packaged unchanged on both hosts.
    expect(creator).not.toContain("process.platform === 'win32'");
  });

  const example = {
    schema: 'octo-handset-v1', id: 'arena-example', manufacturer: 'Arena', name: 'Arena Phone Pro',
    buildModel: 'AR-2601', codename: 'arena_pro', releaseDate: '2026-09-01', androidApi: 36,
    skin: 'Arena UI', width: 1440, height: 3200, ppi: 520, inches: 6.7,
    ramGb: 12, storageGb: 256, cpuCores: 8, chipset: 'Arena SoC', category: 'phone',
  } as const;

  it('validates and normalizes identity and hardware into a complete PhoneSpec', () => {
    const phone = registerHandsetFile(example);
    expect(phone.id).toBe('file-arena-example');
    expect(phone.identity).toMatchObject({ manufacturer: 'Arena', modelNumber: 'AR-2601', apiLevel: 36, realDevice: true });
    expect(phone.display).toMatchObject({ width: 1440, height: 3200, ppi: 520 });
    expect(phone.performance.ramOptionsGb).toEqual([12]);
    expect(phone.sizing).toMatchObject({ ramMb: 12288, storageGb: 256, cpus: 8 });
    expect(androidBuildIdentity(phone)).toMatchObject({ manufacturer: 'Arena', model: 'Arena Phone Pro', device: 'arena_pro' });
  });

  it('rejects unversioned and implausible handset manifests', () => {
    expect(() => registerHandsetFile({ ...example, schema: 'other' })).toThrow(/schema/i);
    expect(() => registerHandsetFile({ ...example, ramGb: 0 })).toThrow(/ramGb/);
    expect(() => registerHandsetFile({ ...example, codename: '../escape' })).toThrow(/codename/i);
  });
});
