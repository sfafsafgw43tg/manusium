/**
 * apps/octobrowser/src/renderer/launcher-android.ts
 *
 * The Android devices surface: a specification catalogue rendered as phone
 * cards, an eleven-tab detail page per handset, filters, a side-by-side
 * comparison of up to four phones, and one "create device" flow that targets
 * Android Studio's emulator (AVD), the only supported emulator.
 *
 * Everything shown here comes from `android-catalog.ts` over IPC; this file
 * only lays it out. No innerHTML, no remote images - the phone illustration is
 * drawn from the device's own aspect ratio.
 */
import { api, clear } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import {
  randomMac, randomImei, randomAndroidId, randomSerialNumber,
  randomPhoneNumber, randomSimProfile,
} from '@octo/core/android-identity';
import { busy, closeModal, confirmDialog, input, modal, run, select, toast, toggle } from './launcher-ui';
import { cameraPicker, type CameraSource } from './launcher-android-cameras';

export interface DeviceIdentity {
  brand: string;
  manufacturer: string;
  model: string;
  marketName?: string;
  device: string;
  product: string;
  mac?: string;
  imei?: string;
  androidId?: string;
  serialNumber?: string;
  phoneNumber?: string;
  operator?: string;
  simOperator?: string;
  simCountry?: string;
}

export interface PhoneSpec {
  id: string;
  tier: string;
  identity: {
    manufacturer: string; commercialName: string; modelName: string; modelNumber: string; regionalVariants: string[];
    releaseDate: string; launchAndroid: string; currentAndroid: string; apiLevel: number; skin: string;
    category: 'phone' | 'foldable' | 'flip' | 'tablet'; realDevice: boolean; avdProfile: string;
  };
  design: {
    heightMm: number; widthMm: number; thicknessMm: number; weightG: number; frame: string; back: string;
    frontGlass: string; colors: string[]; ipRating: string; shape: string; cameraLayout: string; cameraBump: string;
    bezels: string; frontCamera: string; fingerprint: string; buttons: string; usb: string; headphoneJack: boolean;
    simTray: string; illustration: 'phone' | 'foldable' | 'flip' | 'tablet';
  };
  display: {
    type: string; inches: number; width: number; height: number; aspectRatio: string; ppi: number; refreshHz: number;
    minRefreshHz: number; hdr: string; brightnessNits: number; touchSamplingHz: number; protection: string;
    alwaysOn: boolean; cornerRadiusDp: number; statusBarDp: number; navigationBarDp: number;
    emulatorWidth: number; emulatorHeight: number; emulatorDpi: number;
  };
  performance: {
    chipset: string; chipsetVendor: string; processNm: number; cpuCores: number; cpuLayout: string; cpuMaxGhz: number;
    gpu: string; npu: string; ramOptionsGb: number[]; storageOptionsGb: number[]; storageType: string; microSd: boolean;
    freeStorageGb: number; performanceClass: string; gamingClass: string;
  };
  battery: {
    capacityMah: number; type: string; wiredW: number; wirelessW: number; reverseWireless: boolean; saverModes: string[];
    screenOnHours: number; virtualCapacityMah: number; emulatorChargingStates: string[];
  };
  cameras: {
    rearCount: number; mainMp: number; mainSensorInch: string; mainAperture: string; ois: boolean; ultrawide: string;
    telephoto: string; periscope: string; macro: string; front: string; opticalZoom: string; digitalZoom: string;
    maxVideo: string; frameRates: string[]; slowMotion: string[]; flash: string; features: string[];
  };
  network: {
    g2: boolean; g3: boolean; lte: boolean; g5: boolean; wifi: string; bluetooth: string; nfc: boolean; gnss: string[];
    usbVersion: string; dualSim: boolean; esim: boolean; hotspot: boolean; wifiCalling: boolean; volte: boolean;
    regionNotes: string;
  };
  sensors: {
    accelerometer: boolean; gyroscope: boolean; magnetometer: boolean; proximity: boolean; ambientLight: boolean;
    barometer: boolean; fingerprint: boolean; faceUnlock: boolean; temperature: boolean; hall: boolean;
    ultraWideband: boolean; cameraSensors: boolean; simulatable: Record<string, boolean>;
  };
  sizing: {
    androidVersion: string; apiLevel: number; ramMb: number; cpus: number; storageGb: number;
    width: number; height: number; dpi: number; orientation: string; googleApps: boolean; playStore: boolean;
    downloadBytes: number; diskBytes: number; runningRamMb: number; hostRamGb: number; hostCores: number;
    needsVirtualization: boolean;
  };
  avd: {
    device: string; systemImage: string; apiLevel: number; abi: string; ramMb: number; heapMb: number; cores: number;
    dataGb: number; sdCardMb: number; width: number; height: number; dpi: number; gpuMode: string; bootMode: string;
    playStore: boolean;
  };
  storage: {
    imageDownloadBytes: number; virtualDiskBytes: number; freeInsideBytes: number; advertisedStorageGb: number;
  };
}

interface ImageVariant {
  id: 'play' | 'gapps' | 'aosp' | 'go' | 'legacy'; downloadFactor: number; diskGb: number; ramMb: number;
  cpus: number; googleApps: boolean; playStore: boolean; apiOverride: number; sdkKind: string;
}
interface Catalog { phones: PhoneSpec[]; brands: string[]; variants: ImageVariant[] }
interface CreationSummary {
  variant: string; image: string; profile: string; androidVersion: string; apiLevel: number;
  ramMb: number; cpus: number; storageGb: number; width: number; height: number; dpi: number; googleApps: boolean;
  playStore: boolean; root: boolean; downloadBytes: number; diskBytes: number; freeInsideBytes: number;
  hostRamGb: number; hostCores: number; runningRamMb: number; needsVirtualization: boolean; imageInstalled: boolean;
}

const MB = 1_000_000;
const GB = 1_000_000_000;
const size = (value: number) => value >= GB ? `${(value / GB).toFixed(value >= 10 * GB ? 1 : 2)} GB` : `${Math.max(0, Math.round(value / MB))} MB`;
const yesNo = (value: boolean) => t(value ? 'state.on' : 'state.off');
const valueOf = (control: HTMLElement) => (control as unknown as { value: string }).value;
const checked = (control: HTMLElement) => (control.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked === true;

const COMPARE_LIMIT = 4;
const COMPARED = new Set<string>();

/** One label/value line of a specification table. */
export function specRow(label: string, value: string | number | boolean | string[]): HTMLElement {
  const text = Array.isArray(value) ? (value.length ? value.join(', ') : '—')
    : typeof value === 'boolean' ? yesNo(value)
      : String(value === '' || value === 0 ? '—' : value);
  return h('div', { class: 'spec-row' }, h('span', { class: 'spec-key', text: label }), h('span', { class: 'spec-val', text }));
}

const spec = specRow;

/** A drawn phone silhouette: real aspect ratio, no downloaded artwork. */
export function illustration(phone: PhoneSpec, height = 72): HTMLElement {
  const ratio = phone.display.width / phone.display.height;
  const shell = h('div', { class: `phone-shot shot-${phone.design.illustration}` });
  shell.style.height = `${height}px`;
  shell.style.width = `${Math.round(height * Math.min(1.1, Math.max(0.42, ratio)))}px`;
  shell.append(h('div', { class: 'phone-screen' }, icon(phone.design.illustration === 'tablet' ? 'box' : 'smartphone', Math.round(height / 3))));
  return shell;
}

// ------------------------------------------------------------------ detail page

export type TabId = 'overview' | 'design' | 'display' | 'performance' | 'battery' | 'cameras' | 'connectivity' | 'sensors' | 'avd' | 'storage';
export const TABS: Array<[TabId, string]> = [
  ['overview', 'android.tab.overview'], ['design', 'android.tab.design'], ['display', 'android.tab.display'],
  ['performance', 'android.tab.performance'], ['battery', 'android.tab.battery'], ['cameras', 'android.tab.cameras'],
  ['connectivity', 'android.tab.connectivity'], ['sensors', 'android.tab.sensors'],
  ['avd', 'android.tab.avd'], ['storage', 'android.tab.storage'],
];

export function tabContent(phone: PhoneSpec, tab: TabId): HTMLElement {
  const box = h('div', { class: 'spec-table' });
  const id = phone.identity;
  const add = (...rows: HTMLElement[]) => box.append(...rows);
  if (tab === 'overview') {
    add(spec(t('android.spec.manufacturer'), id.manufacturer), spec(t('android.spec.commercialName'), id.commercialName),
      spec(t('android.spec.modelName'), id.modelName), spec(t('android.spec.modelNumber'), id.modelNumber),
      spec(t('android.spec.variants'), id.regionalVariants), spec(t('android.spec.released'), id.releaseDate),
      spec(t('android.spec.launchAndroid'), id.launchAndroid), spec(t('android.spec.currentAndroid'), id.currentAndroid),
      spec(t('android.spec.api'), id.apiLevel), spec(t('android.spec.skin'), id.skin),
      spec(t('android.spec.category'), t(`android.category.${id.category}`)),
      spec(t('android.spec.realDevice'), id.realDevice ? t('android.spec.realPhone') : t('android.spec.genericProfile')),
      spec(t('android.spec.avdProfile'), id.avdProfile));
  } else if (tab === 'design') {
    const d = phone.design;
    add(spec(t('android.spec.height'), d.heightMm ? `${d.heightMm} mm` : '—'), spec(t('android.spec.width'), d.widthMm ? `${d.widthMm} mm` : '—'),
      spec(t('android.spec.thickness'), d.thicknessMm ? `${d.thicknessMm} mm` : '—'), spec(t('android.spec.weight'), d.weightG ? `${d.weightG} g` : '—'),
      spec(t('android.spec.frame'), d.frame), spec(t('android.spec.back'), d.back), spec(t('android.spec.frontGlass'), d.frontGlass),
      spec(t('android.spec.colors'), d.colors), spec(t('android.spec.ip'), d.ipRating), spec(t('android.spec.shape'), d.shape),
      spec(t('android.spec.cameraLayout'), d.cameraLayout), spec(t('android.spec.cameraBump'), d.cameraBump),
      spec(t('android.spec.bezels'), d.bezels), spec(t('android.spec.frontCameraStyle'), d.frontCamera),
      spec(t('android.spec.fingerprintLocation'), d.fingerprint), spec(t('android.spec.buttons'), d.buttons),
      spec(t('android.spec.usbPort'), d.usb), spec(t('android.spec.jack'), d.headphoneJack), spec(t('android.spec.simTray'), d.simTray));
  } else if (tab === 'display') {
    const s = phone.display;
    add(spec(t('android.spec.panel'), s.type), spec(t('android.spec.diagonal'), `${s.inches}"`),
      spec(t('android.spec.resolution'), `${s.width} x ${s.height}`), spec(t('android.spec.aspect'), s.aspectRatio),
      spec(t('android.spec.ppi'), `${s.ppi} PPI`), spec(t('android.spec.refresh'), `${s.refreshHz} Hz`),
      spec(t('android.spec.minRefresh'), `${s.minRefreshHz} Hz`), spec(t('android.spec.hdr'), s.hdr),
      spec(t('android.spec.brightness'), `${s.brightnessNits} nits`), spec(t('android.spec.touchSampling'), `${s.touchSamplingHz} Hz`),
      spec(t('android.spec.protection'), s.protection), spec(t('android.spec.alwaysOn'), s.alwaysOn),
      spec(t('android.spec.cornerRadius'), `${s.cornerRadiusDp} dp`), spec(t('android.spec.statusBar'), `${s.statusBarDp} dp`),
      spec(t('android.spec.navBar'), `${s.navigationBarDp} dp`),
      spec(t('android.spec.emulatorResolution'), `${s.emulatorWidth} x ${s.emulatorHeight}`),
      spec(t('android.spec.emulatorDpi'), `${s.emulatorDpi} dpi`));
  } else if (tab === 'performance') {
    const p = phone.performance;
    add(spec(t('android.spec.chipset'), p.chipset), spec(t('android.spec.chipVendor'), p.chipsetVendor),
      spec(t('android.spec.process'), `${p.processNm} nm`), spec(t('android.spec.cpuCores'), p.cpuCores),
      spec(t('android.spec.cpuLayout'), p.cpuLayout), spec(t('android.spec.cpuClock'), `${p.cpuMaxGhz} GHz`),
      spec(t('android.spec.gpu'), p.gpu), spec(t('android.spec.npu'), p.npu),
      spec(t('android.spec.ramOptions'), p.ramOptionsGb.map((value) => `${value} GB`)),
      spec(t('android.spec.storageOptions'), p.storageOptionsGb.map((value) => `${value} GB`)),
      spec(t('android.spec.storageType'), p.storageType), spec(t('android.spec.microSd'), p.microSd),
      spec(t('android.spec.freeOnPhone'), p.freeStorageGb ? `${p.freeStorageGb} GB` : '—'),
      spec(t('android.spec.performanceClass'), p.performanceClass), spec(t('android.spec.gamingClass'), p.gamingClass));
  } else if (tab === 'battery') {
    const b = phone.battery;
    add(spec(t('android.spec.capacity'), `${b.capacityMah} mAh`), spec(t('android.spec.batteryType'), b.type),
      spec(t('android.spec.wired'), `${b.wiredW} W`), spec(t('android.spec.wireless'), b.wirelessW ? `${b.wirelessW} W` : '—'),
      spec(t('android.spec.reverseWireless'), b.reverseWireless), spec(t('android.spec.saverModes'), b.saverModes),
      spec(t('android.spec.screenOn'), `${b.screenOnHours} h`), spec(t('android.spec.virtualCapacity'), `${b.virtualCapacityMah} mAh`),
      spec(t('android.spec.chargingStates'), b.emulatorChargingStates));
  } else if (tab === 'cameras') {
    const c = phone.cameras;
    add(spec(t('android.spec.rearCount'), c.rearCount), spec(t('android.spec.mainMp'), `${c.mainMp} MP`),
      spec(t('android.spec.mainSensor'), c.mainSensorInch), spec(t('android.spec.aperture'), c.mainAperture),
      spec(t('android.spec.ois'), c.ois), spec(t('android.spec.ultrawide'), c.ultrawide),
      spec(t('android.spec.telephoto'), c.telephoto), spec(t('android.spec.periscope'), c.periscope),
      spec(t('android.spec.macro'), c.macro), spec(t('android.spec.frontCamera'), c.front),
      spec(t('android.spec.opticalZoom'), c.opticalZoom), spec(t('android.spec.digitalZoom'), c.digitalZoom),
      spec(t('android.spec.maxVideo'), c.maxVideo), spec(t('android.spec.frameRates'), c.frameRates),
      spec(t('android.spec.slowMotion'), c.slowMotion), spec(t('android.spec.flash'), c.flash),
      spec(t('android.spec.cameraFeatures'), c.features));
  } else if (tab === 'connectivity') {
    const n = phone.network;
    add(spec('2G', n.g2), spec('3G', n.g3), spec('4G LTE', n.lte), spec('5G', n.g5),
      spec(t('android.spec.wifi'), n.wifi), spec(t('android.spec.bluetooth'), n.bluetooth), spec('NFC', n.nfc),
      spec(t('android.spec.gnss'), n.gnss), spec(t('android.spec.usbVersion'), n.usbVersion),
      spec(t('android.spec.dualSim'), n.dualSim), spec('eSIM', n.esim), spec(t('android.spec.hotspot'), n.hotspot),
      spec(t('android.spec.wifiCalling'), n.wifiCalling), spec('VoLTE', n.volte), spec(t('android.spec.regionNotes'), n.regionNotes));
  } else if (tab === 'sensors') {
    const s = phone.sensors;
    const rows: Array<[string, boolean]> = [
      [t('android.sensor.accelerometer'), s.accelerometer], [t('android.sensor.gyroscope'), s.gyroscope],
      [t('android.sensor.magnetometer'), s.magnetometer], [t('android.sensor.proximity'), s.proximity],
      [t('android.sensor.light'), s.ambientLight], [t('android.sensor.barometer'), s.barometer],
      [t('android.sensor.fingerprint'), s.fingerprint], [t('android.sensor.face'), s.faceUnlock],
      [t('android.sensor.temperature'), s.temperature], [t('android.sensor.hall'), s.hall],
      [t('android.sensor.uwb'), s.ultraWideband], [t('android.sensor.camera'), s.cameraSensors],
    ];
    const keys = ['accelerometer', 'gyroscope', 'magnetometer', 'proximity', 'ambientLight', 'barometer', 'fingerprint', 'faceUnlock', 'temperature', 'hall', 'ultraWideband', 'cameraSensors'];
    rows.forEach(([label, present], index) => {
      const simulated = s.simulatable[keys[index]] === true;
      box.append(spec(label, `${yesNo(present)} · ${t('android.sensor.simulated')}: ${yesNo(simulated)}`));
    });
  } else if (tab === 'avd') {
    const a = phone.avd;
    add(spec(t('android.spec.avdProfile'), a.device), spec(t('android.spec.image'), a.systemImage),
      spec(t('android.spec.api'), a.apiLevel), spec('ABI', a.abi), spec(t('android.spec.virtualRam'), `${a.ramMb} MB`),
      spec(t('android.spec.heap'), `${a.heapMb} MB`), spec(t('android.spec.virtualCpus'), a.cores),
      spec(t('android.spec.dataPartition'), `${a.dataGb} GB`), spec(t('android.spec.sdCard'), a.sdCardMb ? `${a.sdCardMb} MB` : '—'),
      spec(t('android.spec.resolution'), `${a.width} x ${a.height}`), spec(t('android.spec.emulatorDpi'), `${a.dpi} dpi`),
      spec(t('android.spec.gpu'), a.gpuMode), spec(t('android.spec.bootMode'), a.bootMode), spec(t('android.spec.playStore'), a.playStore));
  } else {
    const s = phone.storage;
    box.append(h('p', { class: 'hint', text: t('android.storageExplainer') }),
      spec(t('android.spec.downloadSize'), size(s.imageDownloadBytes)),
      spec(t('android.spec.virtualDisk'), size(s.virtualDiskBytes)),
      spec(t('android.spec.freeInside'), size(s.freeInsideBytes)),
      spec(t('android.spec.advertised'), s.advertisedStorageGb ? `${s.advertisedStorageGb} GB` : '—'),
      spec(t('android.spec.hostRam'), `${phone.sizing.hostRamGb} GB`),
      spec(t('android.spec.hostCores'), phone.sizing.hostCores),
      spec(t('android.spec.runningRam'), `${phone.sizing.runningRamMb} MB`));
  }
  return box;
}

// ------------------------------------------------------------------ comparison

/**
 * Side-by-side table of up to four handsets. Returned as an element (not a
 * dialog) so the creator can show it inside its own step instead of stacking
 * a second modal on top of the wizard.
 */
export function compareTable(phones: PhoneSpec[]): HTMLElement {
  const table = h('div', { class: 'compare-grid' });
  table.style.gridTemplateColumns = `minmax(160px, 1.2fr) repeat(${phones.length}, minmax(140px, 1fr))`;
  const row = (label: string, values: Array<string | number | boolean>) => {
    table.append(h('div', { class: 'compare-key', text: label }));
    for (const value of values) table.append(h('div', { class: 'compare-val', text: typeof value === 'boolean' ? yesNo(value) : String(value || '—') }));
  };
  table.append(h('div', { class: 'compare-key' }));
  for (const phone of phones) table.append(h('div', { class: 'compare-head' }, illustration(phone, 74), h('b', { class: 'ell', text: phone.identity.commercialName })));
  row(t('android.spec.manufacturer'), phones.map((p) => p.identity.manufacturer));
  row(t('android.spec.modelNumber'), phones.map((p) => p.identity.modelNumber));
  row(t('android.spec.currentAndroid'), phones.map((p) => `${p.identity.currentAndroid} (API ${p.identity.apiLevel})`));
  row(t('android.spec.skin'), phones.map((p) => p.identity.skin));
  row(t('android.spec.diagonal'), phones.map((p) => `${p.display.inches}"`));
  row(t('android.spec.resolution'), phones.map((p) => `${p.display.width} x ${p.display.height}`));
  row(t('android.spec.refresh'), phones.map((p) => `${p.display.refreshHz} Hz`));
  row(t('android.spec.chipset'), phones.map((p) => p.performance.chipset));
  row(t('android.spec.ramOptions'), phones.map((p) => p.performance.ramOptionsGb.map((v) => `${v} GB`).join(' / ')));
  row(t('android.spec.storageOptions'), phones.map((p) => p.performance.storageOptionsGb.map((v) => `${v} GB`).join(' / ')));
  row(t('android.spec.capacity'), phones.map((p) => `${p.battery.capacityMah} mAh`));
  row(t('android.spec.wired'), phones.map((p) => `${p.battery.wiredW} W`));
  row(t('android.spec.mainMp'), phones.map((p) => `${p.cameras.mainMp} MP ${p.cameras.mainAperture}`));
  row(t('android.spec.opticalZoom'), phones.map((p) => p.cameras.opticalZoom));
  row(t('android.spec.wifi'), phones.map((p) => p.network.wifi));
  row(t('android.spec.weight'), phones.map((p) => p.design.weightG ? `${p.design.weightG} g` : '—'));
  row(t('android.spec.ip'), phones.map((p) => p.design.ipRating));
  row(t('android.spec.virtualRam'), phones.map((p) => `${p.sizing.ramMb} MB`));
  row(t('android.spec.virtualCpus'), phones.map((p) => p.sizing.cpus));
  row(t('android.spec.virtualStorage'), phones.map((p) => `${p.sizing.storageGb} GB`));
  row(t('android.spec.download'), phones.map((p) => size(p.storage.imageDownloadBytes)));
  row(t('android.spec.diskUse'), phones.map((p) => size(p.storage.virtualDiskBytes)));
  row(t('android.spec.freeInside'), phones.map((p) => size(p.storage.freeInsideBytes)));
  row(t('android.spec.hostRam'), phones.map((p) => `${p.sizing.hostRamGb} GB`));
  row(t('android.spec.playStore'), phones.map((p) => p.sizing.playStore));
  return table;
}


/**
 * The eleven-tab specification sheet of one handset, as an element. The
 * creator embeds it in its own step; nothing here opens a dialog.
 */
export function specSheet(phone: PhoneSpec): HTMLElement {
  let active: TabId = 'overview';
  const body = h('div', { class: 'spec-body' });
  const strip = h('div', { class: 'spec-tabs', role: 'tablist', 'aria-label': t('android.showSpecs') });
  const render = () => { clear(body); body.append(tabContent(phone, active)); };
  for (const [id, key] of TABS) {
    const button = h('button', { type: 'button', class: `spec-tab${id === active ? ' on' : ''}`, role: 'tab', 'aria-selected': String(id === active), text: t(key) });
    button.onclick = () => {
      active = id;
      strip.querySelectorAll('.spec-tab').forEach((node) => { node.classList.toggle('on', node === button); node.setAttribute('aria-selected', String(node === button)); });
      render();
    };
    strip.append(button);
  }
  render();
  return h('div', {},
    h('div', { class: 'spec-head' }, illustration(phone, 100),
      h('div', {}, h('b', { text: phone.identity.commercialName.toLowerCase().startsWith(phone.identity.manufacturer.toLowerCase())
        ? phone.identity.commercialName : `${phone.identity.manufacturer} ${phone.identity.commercialName}` }),
        h('p', { class: 'hint', text: `${phone.identity.currentAndroid} · API ${phone.identity.apiLevel} · ${phone.display.inches}" · ${phone.performance.chipset}` }))),
    strip, body);
}


export function deviceSettingsDialog(target: {
  name: string; running: boolean;
  ramMb?: number; cores?: number; dataGb?: number; width?: number; height?: number; dpi?: number;
  cameraFront?: string; cameraBack?: string; cameraFrontDevice?: string; cameraBackDevice?: string; cameraDevice?: string; microphoneEnabled?: boolean;
  /** Handset this device imitates (name, model and the device identity). */
  handset?: string;
  identity?: DeviceIdentity;
}, reload: () => Promise<void>): void {
  modal(t('android.settingsTitle', { name: target.name }), (box) => {
    const id = target.identity;
    const initialBrand = id?.brand || 'google';
    const initialOp = randomSimProfile(id?.simCountry || 'us');

    const model = input(id?.model || target.handset || target.name, { maxlength: '64', autocomplete: 'off' });
    const brand = input(id?.brand || initialBrand, { maxlength: '32', autocomplete: 'off' });
    const manufacturer = input(id?.manufacturer || 'Google', { maxlength: '32', autocomplete: 'off' });
    const deviceCodename = input(id?.device || id?.product || 'komodo', { maxlength: '32', autocomplete: 'off' });

    const mac = input(id?.mac || randomMac(initialBrand), { maxlength: '17', autocomplete: 'off' });
    const imei = input(id?.imei || randomImei(initialBrand), { maxlength: '15', autocomplete: 'off' });
    const androidId = input(id?.androidId || randomAndroidId(), { maxlength: '16', autocomplete: 'off' });
    const serial = input(id?.serialNumber || randomSerialNumber(initialBrand), { maxlength: '32', autocomplete: 'off' });
    const phone = input(id?.phoneNumber || randomPhoneNumber(id?.simCountry || 'us'), { maxlength: '20', autocomplete: 'off' });
    const operator = input(id?.operator || initialOp.name, { maxlength: '32', autocomplete: 'off' });
    const simOperator = input(id?.simOperator || initialOp.numeric, { maxlength: '10', autocomplete: 'off' });
    const simCountry = select<string>(id?.simCountry || 'us', [
      ['us', 'US (+1)'],
      ['pl', 'Poland (+48)'],
      ['gb', 'United Kingdom (+44)'],
      ['de', 'Germany (+49)'],
    ], (v) => {
      const op = randomSimProfile(v);
      operator.value = op.name;
      simOperator.value = op.numeric;
      phone.value = randomPhoneNumber(v);
    });

    const randomizeAllBtn = h('button', { type: 'button', class: 'btn small', text: t('android.identity.randomizeAll') });
    randomizeAllBtn.onclick = (e) => {
      e.preventDefault();
      const currentBrand = brand.value.trim() || 'google';
      const currentCountry = valueOf(simCountry) || 'us';
      const op = randomSimProfile(currentCountry);
      mac.value = randomMac(currentBrand);
      imei.value = randomImei(currentBrand);
      androidId.value = randomAndroidId();
      serial.value = randomSerialNumber(currentBrand);
      phone.value = randomPhoneNumber(op.country);
      operator.value = op.name;
      simOperator.value = op.numeric;
      toast(t('android.identity.randomized'), 'ok');
    };

    const inputWithAction = (control: HTMLInputElement, onAction: () => void, titleKey: string): HTMLElement => {
      const btn = h('button', { type: 'button', class: 'btn small icon-only', title: t(titleKey), 'aria-label': t(titleKey) }, icon('refreshCircle', 14));
      btn.onclick = (e) => {
        e.preventDefault();
        onAction();
      };
      return h('div', { class: 'input-action-row' }, control, btn);
    };

    const ram = input(String(target.ramMb ?? 4096), { type: 'number', min: '1024', max: '65536' });
    const cores = input(String(target.cores ?? 4), { type: 'number', min: '1', max: '16' });
    const disk = input(String(target.dataGb ?? 16), { type: 'number', min: '4', max: '512' });
    const width = input(String(target.width ?? 1080), { type: 'number', min: '320', max: '2560' });
    const height = input(String(target.height ?? 2400), { type: 'number', min: '480', max: '3840' });
    const dpi = input(String(target.dpi ?? 420), { type: 'number', min: '120', max: '640' });
    const rememberedBackCamera = target.cameraBackDevice || target.cameraDevice || '';
    const rememberedFrontCamera = target.cameraFrontDevice || '';
    // One picker for both lenses, shared with the creator and the launch dialog.
    // It offers only the cameras that send a picture on this computer right now;
    // a lens with none is Off.
    const cameras = cameraPicker({
      initial: {
        front: (target.cameraFront ?? 'webcam') as CameraSource,
        back: (target.cameraBack ?? 'webcam') as CameraSource,
        frontDevice: rememberedFrontCamera,
        backDevice: rememberedBackCamera,
      },
    });
    const microphone = toggle(target.microphoneEnabled !== false, 'android.media.microphone');
    const gpu = select<string>('auto', [['auto', t('android.gpu.auto')], ['host', t('android.gpu.host')], ['swiftshader_indirect', t('android.gpu.software')], ['off', t('android.gpu.off')]]);
    const boot = select<string>('quick', [['quick', t('android.boot.quick')], ['cold', t('android.boot.cold')]]);
    const netSpeed = select<string>('full', [['full', t('android.net.full')], ['lte', 'LTE'], ['umts', 'UMTS (3G)'], ['edge', 'EDGE'], ['gsm', 'GSM']]);
    const save = h('button', { class: 'btn primary', text: t('common.save') });
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;

    // Saving writes the AVD config, which takes a few seconds
    // and used to look like the whole app had frozen.
    save.onclick = () => void busy(save, 'android.applying', async () => {
      let ok = false;
      const camera = cameras.value();
      const changed = await run(api.invoke<string[]>('mgr:android-settings', target.name, {
        ramMb: Number(ram.value), cores: Number(cores.value), dataGb: Number(disk.value),
        gpuMode: valueOf(gpu), bootMode: valueOf(boot), networkSpeed: valueOf(netSpeed),
        cameraFront: camera.front, cameraBack: camera.back,
        cameraFrontDevice: camera.frontDevice, cameraBackDevice: camera.backDevice,
        cameraDevice: camera.backDevice || camera.frontDevice,
        cameraLimits: { front: camera.frontLimit, back: camera.backLimit },
        microphoneEnabled: checked(microphone),
        brand: brand.value.trim(),
        manufacturer: manufacturer.value.trim(),
        model: model.value.trim(),
        marketName: model.value.trim(),
        device: deviceCodename.value.trim(),
        product: deviceCodename.value.trim(),
        mac: mac.value.trim(),
        imei: imei.value.trim(),
        androidId: androidId.value.trim(),
        serialNumber: serial.value.trim(),
        phoneNumber: phone.value.trim(),
        operator: operator.value.trim(),
        simOperator: simOperator.value.trim(),
        simCountry: valueOf(simCountry),
      }));
      ok = Array.isArray(changed);
      if (ok && target.running) {
        await api.invoke('mgr:android-identity', target.name).catch(() => null);
      }
      if (!ok) return;
      closeModal();
      toast(t('android.settingsSaved', { name: target.name }), 'ok');
      await reload();
    });

    const field = (labelKey: string, control: Node) => h('label', { class: 'field' }, h('span', { class: 'lbl', text: t(labelKey) }), control);
    const group = (titleKey: string, ...children: Array<Node | null>) => h('section', { class: 'android-group' }, h('h3', { text: t(titleKey) }), ...children);
    box.append(
      h('p', { class: 'hint', text: t(target.running ? 'android.settingsRunning' : 'android.settingsHint') }),
      group('android.group.performance',
        h('div', { class: 'grid2' }, field('android.ram', ram), field('android.cores', cores),
          field('android.dataPartition', disk), field('android.gpu', gpu), field('android.boot', boot))),
      h('section', { class: 'android-group' },
        h('div', { class: 'android-group-head' },
          h('h3', { text: t('android.group.identity') }),
          randomizeAllBtn),
        h('div', { class: 'grid2' },
          field('android.identity.model', model),
          field('android.identity.brand', brand),
          field('android.identity.manufacturer', manufacturer),
          field('android.identity.deviceCodename', deviceCodename),
          field('android.identity.mac', inputWithAction(mac, () => { mac.value = randomMac(brand.value.trim()); }, 'android.identity.randomize')),
          field('android.identity.imei', inputWithAction(imei, () => { imei.value = randomImei(brand.value.trim()); }, 'android.identity.randomize')),
          field('android.identity.androidId', inputWithAction(androidId, () => { androidId.value = randomAndroidId(); }, 'android.identity.randomize')),
          field('android.identity.serial', inputWithAction(serial, () => { serial.value = randomSerialNumber(brand.value.trim()); }, 'android.identity.randomize')),
          field('android.identity.phone', inputWithAction(phone, () => { phone.value = randomPhoneNumber(valueOf(simCountry)); }, 'android.identity.randomize')),
          field('android.identity.simCountry', simCountry),
          field('android.identity.operator', operator),
          field('android.identity.simOperator', simOperator)),
        h('p', { class: 'hint', text: t('android.identity.hintDetail') })),
      group('android.group.display',
        h('div', { class: 'grid2' }, field('android.spec.width', width), field('android.spec.height', height), field('android.spec.emulatorDpi', dpi))),
      group('android.group.media',
        cameras.element,
        microphone),
      group('android.group.simulation',
        field('android.network', netSpeed)),
      h('div', { class: 'modal-actions' }, cancel, save));
  }, 'wide');
}

interface AndroidNetDevice {
  serial: string; name: string; online: boolean; rooted: boolean; proxy: string;
  lockdown: 'off' | 'full' | 'partial'; networkOff: boolean; bytesIn: number; bytesOut: number;
}
interface AndroidNetStatus { adbAvailable: boolean; devices: AndroidNetDevice[]; killSwitch: boolean }

const TRAFFIC_KEY = 'octo.android.trafficMonitor';
let trafficTimer: number | undefined;

function lockdownText(device: AndroidNetDevice): string {
  if (!device.proxy) return t('net.lock.none');
  if (device.lockdown === 'full') return t('net.lock.full', { proxy: device.proxy });
  if (device.lockdown === 'partial') return t('net.lock.partial', { proxy: device.proxy });
  return t('net.lock.proxyOnly', { proxy: device.proxy });
}

/** Ask for a proxy and lock one Android device to it. */
function androidProxyDialog(device: AndroidNetDevice, reload: () => Promise<void>): void {
  modal(t('net.lockTitle', { name: device.name || device.serial }), (box) => {
    const host = input(device.proxy.split(':')[0] ?? '', { maxlength: '255', placeholder: '127.0.0.1', autocomplete: 'off' });
    const port = input(device.proxy.split(':')[1] ?? '8080', { type: 'number', min: '1', max: '65535' });
    const lock = toggle(true, 'net.lockdownToggle');
    const save = h('button', { class: 'btn primary', text: t('common.save') });
    const clearProxy = h('button', { class: 'btn', text: t('net.lockClear') });
    const cancel = h('button', { class: 'btn', text: t('common.cancel') });
    cancel.onclick = closeModal;
    save.onclick = async () => {
      save.disabled = true;
      const result = await run(api.invoke<AndroidNetDevice>('mgr:android-net-proxy', device.serial, {
        host: host.value.trim(), port: Number(port.value), lockdown: checked(lock),
      }));
      save.disabled = false;
      if (!result) return;
      closeModal();
      toast(result.lockdown === 'full' ? t('net.lockedFull') : t('net.lockedPartial'), result.lockdown === 'full' ? 'ok' : 'err');
      await reload();
    };
    clearProxy.onclick = async () => {
      const done = await run(api.invoke<boolean>('mgr:android-net-proxy-clear', device.serial));
      if (done) { closeModal(); toast(t('net.lockCleared'), 'ok'); await reload(); }
    };
    box.append(
      h('p', { class: 'hint', text: t('net.lockExplain') }),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('net.proxyHost') }), host),
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('net.proxyPort') }), port)),
      lock,
      h('p', { class: 'hint', text: device.rooted ? t('net.lockRooted') : t('net.lockNoRoot') }),
      h('div', { class: 'modal-actions' }, cancel, clearProxy, save));
  });
}

/**
 * The Android network bar: dead man's switch, a small live traffic readout
 * (switchable off) and the proxy-lockdown state of every running device.
 */
export function androidNetworkBar(reload: () => Promise<void>): HTMLElement {
  const kill = h('button', { class: 'btn small danger', text: t('net.killSwitch') }) as HTMLButtonElement;
  const monitor = toggle(localStorage.getItem(TRAFFIC_KEY) !== 'off', 'net.trafficMonitor');
  const state = h('span', { class: 'hint' });
  const rows = h('div', { class: 'net-rows' });
  const bar = h('div', { class: 'android-net' },
    h('div', { class: 'row' }, kill, monitor, state), rows);

  let on = false;
  const paint = (status: AndroidNetStatus | undefined) => {
    on = status?.killSwitch === true;
    kill.textContent = on ? t('net.killSwitchOff') : t('net.killSwitch');
    kill.classList.toggle('primary', on);
    const show = checked(monitor);
    rows.hidden = !show;
    state.textContent = !status?.adbAvailable ? t('net.adbMissing')
      : on ? t('net.killSwitchOn')
        : status.devices.length ? t('net.devicesWatched', { n: String(status.devices.length) })
          : t('net.noDevices');
    if (!show) return;
    clear(rows);
    for (const device of status?.devices ?? []) {
      const lockPill = h('span', { class: `pill ${device.lockdown === 'full' ? 'ok' : device.proxy ? 'warn' : 'bad'}`, text: lockdownText(device) });
      const edit = h('button', { class: 'btn small', text: t('net.lockButton') });
      edit.onclick = () => androidProxyDialog(device, reload);
      const cut = h('button', { class: 'btn small', text: t(device.networkOff ? 'net.deviceNetOn' : 'net.deviceNetOff') });
      cut.onclick = async () => {
        await run(api.invoke<boolean>('mgr:android-net-off', device.serial, !device.networkOff));
        await refresh();
      };
      rows.append(h('div', { class: 'net-row' },
        h('b', { class: 'ell', text: device.name || device.serial }),
        h('span', { class: 'small muted', text: t('net.deviceTraffic', { in: size(device.bytesIn), out: size(device.bytesOut) }) }),
        lockPill, edit, cut));
    }
  };

  async function refresh(): Promise<void> {
    if (!checked(monitor)) { rows.hidden = true; }
    const status = await api.invoke<AndroidNetStatus>('mgr:android-net-status').catch(() => undefined);
    paint(status ?? undefined);
  }

  monitor.addEventListener('change', () => {
    localStorage.setItem(TRAFFIC_KEY, checked(monitor) ? 'on' : 'off');
    void refresh();
  });
  kill.onclick = async () => {
    kill.disabled = true;
    const result = await run(api.invoke<{ on: boolean; devices: number; failed: string[] }>('mgr:kill-switch', !on));
    kill.disabled = false;
    if (!result) return;
    toast(result.on ? t('net.killSwitchThrown', { n: String(result.devices) }) : t('net.killSwitchReleased'), result.on ? 'err' : 'ok');
    await refresh();
    await reload();
  };

  // A light poll: only while the bar is on screen and the monitor is enabled.
  if (trafficTimer) window.clearInterval(trafficTimer);
  trafficTimer = window.setInterval(() => { if (document.body.contains(bar) && checked(monitor)) void refresh(); }, 5000);
  void refresh();
  return bar;
}






