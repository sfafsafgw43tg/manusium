/**
 * apps/octobrowser/src/renderer/launcher-android-media.ts
 *
 * The camera and the microphone of one Android device, in one dialog that saves
 * the wiring. The camera part is the shared picker (launcher-android-cameras),
 * which offers only cameras that send a picture right now. The microphone part
 * is a switch and a level meter.
 */
import { api } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { busy, closeModal, input, modal, run, select, toast, toggle } from './launcher-ui';
import { cameraPicker, type CameraSource } from './launcher-android-cameras';
import { meterLevel } from '@octo/core/android-camera';

export interface EmulatorWebcam { name: string; device: string; virtual: boolean; foreign?: boolean }
interface MediaCheckItem { key: string; ok: boolean; detail: string }
export interface MediaCheck {
  device: string; ready: boolean; items: MediaCheckItem[]; webcams: EmulatorWebcam[];
  /** The host camera this device is wired to, '' when it uses its own. */
  selected: string;
  cameraFront: CameraSource; cameraBack: CameraSource;
  cameraFrontDevice: string; cameraBackDevice: string;
  microphoneEnabled: boolean;
}

/** The switch a `toggle()` renders keeps its state in a checkbox. */
const checked = (control: HTMLElement | undefined) =>
  (control?.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked === true;

/**
 * Live level of the default recording device. The emulator records from that
 * same device, so this is what Android will hear. Returns the cleanup function.
 */
export async function startMicrophoneMeter(host: HTMLElement): Promise<() => void> {
  const bar = h('div', { class: 'mic-meter' }) as HTMLElement;
  const meter = h('div', { class: 'mic-meter-box' }, h('p', { class: 'hint', text: t('android.mic.meter') }),
    h('div', { class: 'mic-meter-track' }, bar), h('p', { class: 'hint', text: t('android.mic.honest') }));
  host.append(meter);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  context.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let frame = 0;
  const draw = () => {
    analyser.getFloatTimeDomainData(samples);
    bar.style.width = `${Math.round(meterLevel(samples) * 100)}%`;
    frame = window.requestAnimationFrame(draw);
  };
  draw();
  return () => {
    window.cancelAnimationFrame(frame);
    stream.getTracks().forEach((track) => track.stop());
    void context.close();
    meter.remove();
  };
}

/**
 * The camera and microphone panel of one device.
 *
 * Two choices: the camera (per lens, from the cameras that work right now) and
 * the microphone. A camera that does not work is not offered.
 */
export function androidMediaDialog(device: { name: string; running: boolean; handset?: string }, reload: () => Promise<void>): void {
  modal(t('android.media.deviceTitle', { name: device.name }), (box) => {
    box.classList.add('media-dashboard');
    const cameraMetric = h('b', { text: '—' });
    const microphoneMetric = h('b', { text: '—' });
    const cameraDetail = h('small', { text: t('state.loading') });
    const metric = (kind: string, title: string, value: HTMLElement, detail: HTMLElement) => h('div', { class: `media-metric ${kind}` },
      h('span', { class: 'media-metric-label', text: title }), value, detail);
    const dashboard = h('div', { class: 'media-dashboard-grid' },
      metric('camera', t('android.media.camera'), cameraMetric, cameraDetail),
      metric('microphone', t('android.media.microphone'), microphoneMetric, h('small', { text: t('android.media.hostMicrophone') })));
    const list = h('div', { class: 'media-check' });
    const pickerSlot = h('div', {});
    const microphoneSlot = h('div', {});
    const note = h('p', { class: 'hint' });
    const close = h('button', { class: 'btn', text: t('common.close') });
    close.onclick = closeModal;
    const save = h('button', { class: 'btn primary', text: t('common.save') }) as HTMLButtonElement;
    // Saving needs the device's saved cameras, which arrive with the check, so it
    // stays off until the check has loaded. Otherwise it would write empty lenses.
    save.disabled = true;
    // One click for "it says it cannot find my cameras": the device is wired to
    // a camera that works right now and gets its microphone switched on.
    const repair = h('button', { class: 'btn', text: t('android.media.repair') }) as HTMLButtonElement;
    const recheck = h('button', { class: 'btn' }, icon('refreshCircle', 14), h('span', { text: t('android.media.recheck') }));

    let check: MediaCheck | undefined;
    /** Cameras that the picker has checked and that send a picture; undefined until the first check. */
    let workingCameras: number | undefined;
    let picker: ReturnType<typeof cameraPicker> | undefined;
    let microphone: HTMLElement | undefined;

    function paintCheck(): void {
      list.replaceChildren();
      for (const item of check?.items ?? []) {
        const row = h('div', { class: `media-check-row${item.ok ? ' ok' : ''}` },
          h('span', { class: 'media-check-mark' }, icon(item.ok ? 'check' : 'alert', 15)),
          h('div', { class: 'media-check-copy' },
            h('b', { text: t(item.key) }),
            h('span', { class: 'small muted', text: item.detail || t(item.ok ? 'state.on' : 'android.media.check.missing') })));
        list.append(row);
      }
      const itemOk = (key: string) => check?.items.find((item) => item.key === key)?.ok === true;
      microphoneMetric.textContent = t(itemOk('android.media.check.audio') ? 'state.on' : 'state.off');
      microphoneMetric.parentElement?.classList.toggle('on', itemOk('android.media.check.audio'));
      paintNote();
      save.disabled = device.running || !check;
    }

    /** The camera tile counts the cameras that work right now, as the picker has checked them. */
    function paintCameras(working: Array<{ name: string; label: string }>): void {
      workingCameras = working.length;
      cameraMetric.textContent = working.length ? String(working.length) : t('state.off');
      cameraMetric.parentElement?.classList.toggle('on', working.length > 0);
      cameraDetail.textContent = working.length ? working.map((item) => item.label).join(' · ') : t('android.camera.msgNone');
      paintNote();
    }

    /** Ready only when the device is wired as it should be and a camera really sends a picture. */
    function paintNote(): void {
      const ready = !!check?.ready && (workingCameras === undefined || workingCameras > 0);
      note.classList.toggle('warn', !!check && !ready);
      note.textContent = !check ? '' : ready ? t('android.media.allGood') : t('android.media.someMissing');
    }

    function paintPicker(): void {
      if (picker) { void picker.refresh(); return; }
      picker = cameraPicker({
        initial: {
          front: check?.cameraFront ?? 'none',
          back: check?.cameraBack ?? 'none',
          frontDevice: check?.cameraFrontDevice ?? '',
          backDevice: check?.cameraBackDevice ?? '',
        },
        onWorking: paintCameras,
      });
      pickerSlot.replaceChildren(picker.element);
    }

    function paintMicrophone(): void {
      if (microphone) return;
      microphone = toggle(check?.microphoneEnabled !== false, 'android.media.microphone', () => undefined);
      const test = h('button', { type: 'button', class: 'btn small', text: t('android.mic.test') }) as HTMLButtonElement;
      const meterSlot = h('div', {});
      // Ten seconds of the level the emulator's microphone will hear.
      test.onclick = () => void busy(test, 'android.mic.testRunning', async () => {
        meterSlot.replaceChildren();
        try {
          const stopMeter = await startMicrophoneMeter(meterSlot);
          window.setTimeout(stopMeter, 10_000);
        } catch (error) {
          console.debug('[mic] microphone meter failed', error);
          meterSlot.append(h('p', { class: 'hint warn', text: t('android.mic.failed') }));
        }
      });
      microphoneSlot.replaceChildren(microphone, test, meterSlot);
    }

    async function refresh(): Promise<void> {
      check = await run(api.invoke<MediaCheck>('mgr:android-media-check', device.name));
      paintCheck();
      paintPicker();
      paintMicrophone();
    }

    save.onclick = () => void busy(save, 'android.applying', async () => {
      const camera = picker?.value() ?? { front: 'none' as const, back: 'none' as const, frontDevice: '', backDevice: '' };
      const changed = await run(api.invoke<string[]>('mgr:android-settings', device.name, {
        cameraFront: camera.front, cameraBack: camera.back,
        cameraFrontDevice: camera.frontDevice, cameraBackDevice: camera.backDevice,
        cameraDevice: camera.backDevice || camera.frontDevice,
        cameraLimits: { front: camera.frontLimit, back: camera.backLimit },
        microphoneEnabled: checked(microphone),
      }));
      if (!Array.isArray(changed)) return;
      toast(t('android.media.repaired'), 'ok');
      await refresh();
      await reload();
    });

    repair.onclick = () => void busy(repair, 'android.applying', async () => {
      const result = await run(api.invoke<{ changed: string[]; check: MediaCheck }>('mgr:android-media-repair', device.name, {}));
      if (!result) return;
      check = result.check;
      paintCheck();
      paintPicker();
      paintMicrophone();
      toast(t(check.ready ? 'android.media.repaired' : 'android.media.someMissing'), check.ready ? 'ok' : 'err');
      await reload();
    });

    recheck.onclick = () => void refresh();

    box.append(
      dashboard,
      androidMediaLibrary(device, reload),
      h('h4', { class: 'spec-title', text: t('android.media.hostCamera') }),
      pickerSlot,
      h('h4', { class: 'spec-title', text: t('android.media.microphone') }),
      microphoneSlot,
      h('h4', { class: 'spec-title', text: t('android.media.checklist') }),
      list,
      note);
    if (device.running) box.append(h('p', { class: 'hint warn', text: t('android.media.stopFirst') }));
    box.append(h('div', { class: 'modal-actions' }, recheck, repair, close, save));
    void refresh();
  }, 'wide');
}



interface MediaFolderInfo { path: string; photos: number; videos: number; bytes: number; files: string[]; problem: string }
interface MediaPushResult { copied: number; failed: number; target: string; scanned: boolean; problem: string }

/**
 * The device's photos and videos: one folder on the computer, copied into the
 * running device's own gallery, where apps inside Android pick them up like
 * any other picture.
 */
export function androidMediaLibrary(device: { name: string; running: boolean }, reload: () => Promise<void>): HTMLElement {
  const info = h('p', { class: 'hint' });
  const pathLine = h('span', { class: 'small muted ell', text: t('android.library.none') });
  let folder = '';
  const choose = h('button', { class: 'btn small' }, icon('folder', 14), h('span', { text: t('android.library.choose') }));
  const copyIn = h('button', { class: 'btn small', text: t('android.library.copy'), disabled: true }) as HTMLButtonElement;

  const show = (data: MediaFolderInfo | undefined) => {
    if (!data || data.problem) {
      info.textContent = data?.problem || t('android.library.none');
      info.classList.add('warn');
      copyIn.disabled = true;
      return;
    }
    folder = data.path;
    pathLine.textContent = data.path;
    info.classList.remove('warn');
    info.textContent = t('android.library.found', {
      photos: String(data.photos), videos: String(data.videos),
      size: data.bytes >= 1e9 ? `${(data.bytes / 1e9).toFixed(1)} GB` : `${Math.round(data.bytes / 1e6)} MB`,
    });
    copyIn.disabled = !device.running;
  };

  choose.onclick = async () => {
    const chosen = await run(api.invoke<string | null>('mgr:pick-folder'));
    if (!chosen) return;
    show(await run(api.invoke<MediaFolderInfo>('mgr:android-media-folder', chosen)));
  };
  copyIn.onclick = () => void busy(copyIn, 'android.library.copying', async () => {
    const result = await run(api.invoke<MediaPushResult>('mgr:android-media-push', device.name, folder));
    if (!result) return;
    if (result.problem) { toast(t('android.library.failed'), 'err', result.problem); return; }
    toast(t('android.library.copied', { n: String(result.copied), target: result.target }), result.failed ? 'err' : 'ok',
      result.scanned ? '' : t('android.library.notScanned'));
    await reload();
  });

  return h('details', { class: 'card-specs app-group' },
    h('summary', { text: t('android.library.title') }),
    h('p', { class: 'hint', text: t('android.library.hint') }),
    h('div', { class: 'row' }, choose, copyIn),
    pathLine,
    info,
    device.running ? h('span', {}) : h('p', { class: 'hint', text: t('android.library.needRunning') }));
}

interface StoreEntry {
  id: string; name: string; packageName: string; kind: 'store' | 'browser'; icon: string;
  source: string; homepage: string; samsungOnly: boolean; description: string;
}
interface StoreResult { id: string; ok: boolean; message: string; sha256: string; bytes: number }
interface StoreState { id: string; packageName: string; installed: boolean; enabled: boolean }

/**
 * Install an open app store into a running device. Emulator images have no
 * usable Play Store, so this is how apps get in. Nothing is downloaded until
 * a store is ticked and Install is pressed, and what cannot be fetched from
 * an official address is installed from a file the user supplies.
 */
export function androidStoresDialog(device: { name: string; running: boolean; handset?: string }, reload: () => Promise<void>): void {
  modal(t('android.stores.title', { name: device.name }), (box) => {
    const list = h('div', { class: 'media-check app-market' });
    const results = h('div', {});
    const files: Record<string, string> = {};
    const wanted = new Set<string>();
    const states = new Map<string, StoreState>();
    let catalogue: StoreEntry[] = [];
    const samsung = /samsung|galaxy/i.test(device.handset ?? device.name);
    const close = h('button', { class: 'btn', text: t('common.close') });
    close.onclick = closeModal;
    const install = h('button', { class: 'btn primary', text: t('android.stores.install'), disabled: true }) as HTMLButtonElement;
    const search = input('', { type: 'search', placeholder: t('android.stores.search'), 'aria-label': t('android.stores.search') }, () => paint());
    const selectAll = h('button', { class: 'btn small', text: t('android.stores.selectAll') });
    const selectNone = h('button', { class: 'btn small', text: t('android.stores.selectNone') });

    const refreshStates = async (): Promise<void> => {
      // The row's `running` flag is only a snapshot. A device can finish
      // booting after this dialog opens, so always ask the main process/adb.
      const current = await api.invoke<StoreState[]>('mgr:android-store-states', device.name).catch(() => []);
      states.clear();
      for (const state of current ?? []) states.set(state.id, state);
      paint();
    };

    /** Searchable app-store-like catalogue with install and lifecycle actions. */
    const paint = (): void => {
      list.replaceChildren();
      const needle = search.value.trim().toLowerCase();
      const visible = catalogue.filter((store) => !needle || `${store.name} ${store.description} ${store.packageName}`.toLowerCase().includes(needle));
      const groups: Array<['store' | 'browser', string]> = [['store', t('android.stores.groupStores')], ['browser', t('android.stores.groupBrowsers')]];
      for (const [kind, title] of groups) {
        const members = visible.filter((store) => store.kind === kind);
        if (!members.length) continue;
        const body = h('div', { class: 'app-market-grid' });
        for (const store of members) {
          const blocked = store.samsungOnly && !samsung;
          const state = states.get(store.id);
          const installed = state?.installed === true;
          const row = h('div', { class: `app-row app-market-card${wanted.has(store.id) ? ' on' : ''}${blocked ? ' off' : ''}` });
          const fileLine = h('span', { class: 'small muted ell', text: files[store.id] || (store.source === 'manual'
            ? t('android.stores.manual')
            : t('android.stores.official', { host: store.source === 'github' ? 'github.com' : 'f-droid.org' })) });
          const pickFile = h('button', { class: 'btn tiny', text: t('android.stores.chooseApk'), hidden: store.source !== 'manual' });
          pickFile.onclick = async () => {
            const chosen = await run(api.invoke<string | null>('mgr:pick-file', { extensions: ['apk'] }));
            if (!chosen) return;
            files[store.id] = chosen;
            wanted.add(store.id);
            paint();
          };
          const homepage = h('button', { class: 'btn tiny', text: t('android.stores.officialPage') });
          homepage.onclick = () => void api.invoke('mgr:android-store-homepage', store.id);
          const enabled = h('button', {
            class: 'btn tiny', hidden: !installed,
            text: t(state?.enabled ? 'android.stores.disable' : 'android.stores.enable'),
          }) as HTMLButtonElement;
          enabled.onclick = () => void busy(enabled, 'android.applying', async () => {
            await run(api.invoke('mgr:android-store-state', { name: device.name, id: store.id, action: state?.enabled ? 'disable' : 'enable' }));
            await refreshStates();
          });
          const remove = h('button', { class: 'btn tiny danger', hidden: !installed, text: t('android.stores.uninstall') }) as HTMLButtonElement;
          remove.onclick = () => void busy(remove, 'android.applying', async () => {
            await run(api.invoke('mgr:android-store-state', { name: device.name, id: store.id, action: 'uninstall' }));
            await refreshStates();
          });
          const tick = toggle(wanted.has(store.id), 'android.stores.pick', (on) => {
            if (on) wanted.add(store.id); else wanted.delete(store.id);
            paint();
          }, blocked || (store.source === 'manual' && !files[store.id]));
          row.append(
            h('div', { class: 'app-market-head' }, h('span', { class: 'app-icon' }, icon(store.icon, 18)),
              h('div', { class: 'app-copy' }, h('b', { text: store.name }), h('span', { class: 'small muted', text: store.packageName })),
              installed ? h('span', { class: `pill ${state?.enabled ? 'ok' : 'warn'}`, text: t(state?.enabled ? 'android.stores.enabled' : 'android.stores.disabled') }) : null),
            h('span', { class: 'small muted', text: blocked ? t('android.stores.samsungOnly') : store.description }),
            fileLine,
            h('div', { class: 'app-market-actions' }, homepage, pickFile, enabled, remove, tick));
          body.append(row);
        }
        const group = h('details', { class: 'card-specs app-group', open: kind === 'store' ? '' : undefined },
          h('summary', { text: `${title} · ${members.length}` }), body);
        list.append(group);
      }
      if (!visible.length) list.append(h('p', { class: 'hint', text: t('android.stores.noResults') }));
      // Do not gate this on the stale row snapshot. The IPC handler resolves
      // the live adb serial and returns a useful error if Android is stopped.
      install.disabled = wanted.size === 0;
    };

    selectAll.onclick = () => {
      for (const store of catalogue) if ((!store.samsungOnly || samsung) && (store.source !== 'manual' || files[store.id])) wanted.add(store.id);
      paint();
    };
    selectNone.onclick = () => { wanted.clear(); paint(); };

    install.onclick = () => void busy(install, 'android.stores.installing', async () => {
      const done = await run(api.invoke<StoreResult[]>('mgr:android-store-install', {
        name: device.name, stores: [...wanted], files, samsung,
      }));
      if (!done) return;
      results.replaceChildren(...done.map((item) => h('p', { class: `hint${item.ok ? '' : ' warn'}`, text: item.ok
        ? t('android.stores.done', { name: item.id, sha: item.sha256.slice(0, 16) })
        : `${item.id}: ${item.message}` })));
      toast(t(done.every((item) => item.ok) ? 'android.stores.allDone' : 'android.stores.someFailed'), done.every((item) => item.ok) ? 'ok' : 'err');
      wanted.clear();
      await refreshStates();
      await reload();
    });

    box.append(
      h('p', { class: 'hint', text: t('android.stores.hint') }),
      h('p', { class: 'hint', text: t('android.stores.liveCheck') }),
      h('div', { class: 'app-market-toolbar' }, search, selectAll, selectNone),
      list, results, h('div', { class: 'modal-actions' }, close, install));
    void api.invoke<StoreEntry[]>('mgr:android-stores').then(async (stores) => {
      catalogue = stores ?? [];
      paint();
      await refreshStates();
    }).catch(() => paint());
  }, 'xwide');
}

/**
 * Make the device report the handset it was created as.
 *
 * A device created as a Pixel 9 still tells every app and every website
 * `sdk_gphone64_x86_64` until its build.prop is rewritten, which needs a
 * running device and an image that allows root.
 */
export function androidIdentityRow(device: { name: string; running: boolean; handset?: string }, reload: () => Promise<void>): HTMLElement {
  const line = h('p', { class: 'hint', text: device.handset
    ? t('android.identity.hint', { handset: device.handset })
    : t('android.identity.none') });
  const verification = h('div', { class: 'identity-verification' });
  const identityLabelKeys: Record<string, string> = {
    brand: 'android.identity.brand', manufacturer: 'android.identity.manufacturer', model: 'android.identity.model',
    device: 'android.identity.deviceCodename', product: 'android.identity.product', marketName: 'android.identity.marketName',
    mac: 'android.identity.mac', imei: 'android.identity.imei', androidId: 'android.identity.androidId',
    serialNumber: 'android.identity.serial', phoneNumber: 'android.identity.phone', operator: 'android.identity.operator',
    simOperator: 'android.identity.simOperator', simCountry: 'android.identity.simCountry',
  };
  const apply = h('button', { class: 'btn small', text: t('android.identity.apply'), disabled: !device.running }) as HTMLButtonElement;
  apply.onclick = () => void busy(apply, 'android.applying', async () => {
    const result = await run(api.invoke<{
      ok: boolean; changed: string[]; message: string; rebooting: boolean;
      verification?: Array<{ field: string; expected: string; actual: string; ok: boolean }>;
    }>('mgr:android-identity', device.name));
    if (!result) return;
    line.textContent = result.message;
    line.classList.toggle('warn', !result.ok);
    verification.replaceChildren(...(result.verification ?? []).map((item) => {
      return h('p', {
        class: `hint identity-value${item.ok ? '' : ' warn'}`,
        text: `${t(identityLabelKeys[item.field] ?? 'android.identity.model')} · ${item.ok ? t('state.on') : t('state.off')} · ${t('android.identity.actualValue')}: ${item.actual || t('android.identity.notReported')} · ${t('android.identity.expectedValue')}: ${item.expected}`, 
      });
    }));
    toast(t(result.ok ? 'android.identity.done' : 'android.identity.failed'), result.ok ? 'ok' : 'err', result.message);
    await reload();
  });
  return h('details', { class: 'card-specs app-group' },
    h('summary', { text: t('android.identity.title') }),
    line, verification,
    device.running ? h('span', {}) : h('p', { class: 'hint', text: t('android.identity.needRunning') }),
    h('p', { class: 'hint', text: t('android.identity.limits') }),
    h('div', { class: 'row' }, apply));
}

