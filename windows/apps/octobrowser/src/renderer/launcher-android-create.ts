/**
 * apps/octobrowser/src/renderer/launcher-android-create.ts
 *
 * "New Android device" - one guided creator for Android Studio's emulator (AVD).
 *
 * The creator is a five-step wizard:
 *
 *   1. Engine     - the Android SDK and emulator, whether they are installed,
 *                   and how to install or locate them.
 *   2. Handset    - the whole specification catalogue: search, filters, cards,
 *                   full specification sheets and a side-by-side comparison.
 *   3. Android    - the system image variant (Play / Google APIs / AOSP / Go /
 *                   older API) and any custom system image package.
 *   4. Setup      - name, performance preset, memory, display and the virtual
 *                   camera / microphone wiring.
 *   5. Review     - the target folder with its free space, an honest storage
 *                   breakdown, then the creation itself with live progress.
 *
 * Accessibility is part of the layout, not an afterthought: the step rail is a
 * real tablist with arrow-key navigation, every card grid is a radiogroup
 * driven by Space/Enter, every control has a bound <label>, the footer hint is
 * an aria-live region, and the progress bar reports its own percentage.
 *
 * Nothing here talks to the network. All numbers come from the local
 * catalogue over IPC; the main process performs the download and the create.
 */
import { api, clear } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import {
  randomMac, randomImei, randomAndroidId, randomSerialNumber,
  randomPhoneNumber, randomSimProfile, OPERATOR_PROFILES,
} from '@octo/core/android-identity';
import { animateIn, closeModal, input, modal, run, S, select, setModalCloseOverride, toast, toggle } from './launcher-ui';
import { type PhoneSpec, compareTable, illustration, specRow, specSheet } from './launcher-android';
import { cameraPicker, type CameraResolution, type CameraSource } from './launcher-android-cameras';
import { progressText, runInstall } from './launcher-android-install';


interface ImageVariant {
  id: 'play' | 'gapps' | 'aosp' | 'go' | 'legacy'; downloadFactor: number; diskGb: number; ramMb: number;
  cpus: number; googleApps: boolean; playStore: boolean; apiOverride: number; sdkKind: string;
}
interface Catalog { phones: PhoneSpec[]; brands: string[]; variants: ImageVariant[] }
interface CustomImage { id: string; label: string; packageName: string; api: number; released: string }
interface StoreEntry { id: string; name: string; kind: 'store' | 'browser'; icon: string; source: string; samsungOnly: boolean; description: string }
interface SdkStatus { available: boolean; avdManagerAvailable: boolean; emulatorAvailable: boolean; sdkRoot: string; defaultDirectory: string; javaVersion?: number; searched?: string[] }
interface TargetDir { path: string; exists: boolean; writable: boolean; freeBytes: number; totalBytes: number; suggested: string; custom: boolean }
interface CreationSummary {
  variant: string; image: string; profile: string; androidVersion: string; apiLevel: number;
  ramMb: number; cpus: number; storageGb: number; width: number; height: number; dpi: number; googleApps: boolean;
  playStore: boolean; root: boolean; released?: string; downloadBytes: number; diskBytes: number; freeInsideBytes: number;
  hostRamGb: number; hostCores: number; runningRamMb: number; needsVirtualization: boolean; imageInstalled: boolean;
}

export interface CreatorContext {
  catalog: Catalog | undefined;
  sdk: SdkStatus | undefined;
  reload: () => Promise<void>;
  /** Pre-selected handset, e.g. when the creator is opened from a card. */
  phoneId?: string;
}

const MB = 1_000_000;
const GB = 1_000_000_000;
const size = (value: number) => value >= GB ? `${(value / GB).toFixed(value >= 10 * GB ? 1 : 2)} GB` : `${Math.max(0, Math.round(value / MB))} MB`;
const NAME_RX = /^[A-Za-z0-9_-]{1,64}$/;
const COMPARE_LIMIT = 4;

const VARIANTS: Array<{ id: string; labelKey: string; descKey: string }> = [
  { id: 'play', labelKey: 'android.variant.play', descKey: 'android.variantDesc.play' },
  { id: 'gapps', labelKey: 'android.variant.gapps', descKey: 'android.variantDesc.gapps' },
  { id: 'aosp', labelKey: 'android.variant.aosp', descKey: 'android.variantDesc.aosp' },
  { id: 'go', labelKey: 'android.variant.go', descKey: 'android.variantDesc.go' },
  { id: 'legacy', labelKey: 'android.variant.legacy', descKey: 'android.variantDesc.legacy' },
];


/** Everything the wizard collects. One object, so every step reads the truth. */
interface Draft {
  phone?: PhoneSpec;
  variant: string;
  name: string;
  nameTouched: boolean;
  hardwareTouched: boolean;
  preset: 'light' | 'standard' | 'ultra' | 'custom';
  ramMb: number; cpus: number; diskGb: number; heapMb: number; sdCardMb: number;
  width: number; height: number; dpi: number;
  gpuMode: string; bootMode: string;
  snapshots: boolean; camera: boolean; microphone: boolean;
  cameraFront: CameraSource; cameraBack: CameraSource;
  cameraFrontDevice: string; cameraBackDevice: string;
  /** Legacy shared endpoint for older create paths. */
  cameraDevice: string;
  /** BCP-47 language Android boots in, e.g. "pl-PL". */
  locale: string;
  /** An SDK package the user added themselves, used instead of the variant. */
  customPackage: string;
  /** App stores / browsers to install the first time the device boots. */
  apps: string[];
  /** Manual APK choices for stores without a stable publisher download. */
  appFiles: Record<string, string>;
  /** Tell Windows when the device is ready, with a sound. */
  notify: boolean;
  directory: string;
  brand: string;
  manufacturer: string;
  model: string;
  device: string;
  product: string;
  mac: string;
  imei: string;
  androidId: string;
  serialNumber: string;
  phoneNumber: string;
  operator: string;
  simOperator: string;
  simCountry: string;
  /** The emulator's own telephony number. Optional, not identity. */
  telephone: string;
  identityTouched: boolean;
}

const handsetName = (phone: PhoneSpec) => phone.identity.commercialName.toLowerCase().startsWith(phone.identity.manufacturer.toLowerCase())
  ? phone.identity.commercialName : `${phone.identity.manufacturer} ${phone.identity.commercialName}`;

/** A safe default device name derived from the handset. */
function suggestName(phone: PhoneSpec): string {
  const base = `${phone.identity.manufacturer}-${phone.identity.commercialName}`;
  return base.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'Android-device';
}

function inputWithAction(control: HTMLInputElement, onAction: () => void, titleKey: string): HTMLElement {
  const btn = h('button', { type: 'button', class: 'btn small icon-only', title: t(titleKey), 'aria-label': t(titleKey) }, icon('refreshCircle', 14));
  btn.onclick = (e) => {
    e.preventDefault();
    onAction();
  };
  return h('div', { class: 'input-action-row' }, control, btn);
}

/** Small state pill: ready / missing / neutral. */
function pill(kind: 'ok' | 'warn' | 'bad', text: string): HTMLElement {
  return h('span', { class: `pill ${kind}`, text });
}

/**
 * A selectable card. Cards are the wizard's main control, so they behave like
 * radio buttons: one tab stop per group, arrow keys move, Space/Enter picks.
 */
function optionCard(opts: {
  selected: boolean; title: string; meta?: string; onPick: () => void; extra?: Node | null;
  lead?: Node | null; lines?: Array<[string, string]>; disabled?: boolean; wide?: boolean;
}): HTMLElement {
  const card = h('div', {
    class: `pick-card${opts.selected ? ' on' : ''}${opts.disabled ? ' off' : ''}${opts.wide ? ' wide' : ''}`,
    role: 'radio', 'aria-checked': String(opts.selected), tabindex: opts.selected ? '0' : '-1',
    'aria-disabled': opts.disabled ? 'true' : 'false',
  });
  const body = h('div', { class: 'pick-body' },
    h('div', { class: 'pick-title' }, h('b', { class: 'ell', text: opts.title }), opts.meta ? h('span', { class: 'muted small ell', text: opts.meta }) : null));
  if (opts.lines?.length) {
    const table = h('div', { class: 'pick-lines' });
    for (const [key, value] of opts.lines) table.append(h('span', { class: 'muted', text: key }), h('span', { text: value }));
    body.append(table);
  }
  if (opts.extra) body.append(opts.extra);
  card.append(h('div', { class: 'pick-mark' }, icon(opts.selected ? 'check' : 'box', 15)));
  if (opts.lead) card.append(opts.lead);
  card.append(body);
  const pick = () => { if (!opts.disabled) opts.onPick(); };
  card.onclick = (event) => {
    // A button inside the card (specs, compare, install) keeps its own action.
    if ((event.target as HTMLElement).closest('button')) return;
    pick();
  };
  card.onkeydown = (event) => {
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); pick(); }
  };
  return card;
}

/** Arrow-key roving focus inside one radiogroup of cards. */
function rovingFocus(group: HTMLElement): HTMLElement {
  group.onkeydown = (event) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const items = [...group.querySelectorAll<HTMLElement>('.pick-card:not(.off)')];
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? Math.max(0, index - 1)
          : Math.min(items.length - 1, index + 1);
    event.preventDefault();
    items[next]?.focus();
  };
  return group;
}

function radioGroup(cls: string, cards: HTMLElement[]): HTMLElement {
  return rovingFocus(h('div', { class: cls, role: 'radiogroup' }, ...cards));
}

function numberField(labelKey: string, value: number, attrs: Record<string, string>, onChange: (value: number) => void, suffix = ''): HTMLElement {
  const control = input(String(value), { type: 'number', inputmode: 'numeric', ...attrs }, (raw) => onChange(Number(raw)));
  return h('label', { class: 'field' },
    h('span', { class: 'lbl', text: suffix ? `${t(labelKey)} (${suffix})` : t(labelKey) }), control);
}

/** The whole wizard. */
export function androidCreateWizard(context: CreatorContext): void {
  const phones = context.catalog?.phones ?? [];
  const brands = context.catalog?.brands ?? [];
  // Live, not frozen: an engine installed or located while the wizard is open
  // must stop being reported as missing.
  let sdkStatus = context.sdk;
  /** The user insisted on an engine we could not detect. */
  let forced = false;
  const avdReady = () => sdkStatus?.available === true && sdkStatus?.avdManagerAvailable === true;

  async function recheckEngines(): Promise<void> {
    const android = await api.invoke<SdkStatus>('mgr:android-status').catch(() => undefined);
    if (android) sdkStatus = android;
    if (avdReady()) forced = false;
  }

  const first = phones.find((item) => item.id === context.phoneId) ?? phones[0];
  const firstBrand = first ? (first.identity.manufacturer === 'Google' ? 'google' : first.identity.manufacturer.toLowerCase()) : 'google';
  const firstOp = randomSimProfile('us');
  const draft: Draft = {
    phone: first,
    variant: 'play',
    name: first ? suggestName(first) : '',
    nameTouched: false,
    hardwareTouched: false,
    preset: 'standard',
    ramMb: first?.sizing.ramMb ?? 4096,
    cpus: first?.sizing.cpus ?? 4,
    diskGb: first?.sizing.storageGb ?? 16,
    heapMb: first?.avd.heapMb ?? 512,
    sdCardMb: first?.avd.sdCardMb ?? 0,
    width: first?.sizing.width ?? 1080,
    height: first?.sizing.height ?? 2400,
    dpi: first?.sizing.dpi ?? 420,
    gpuMode: 'auto', bootMode: 'quick',
    snapshots: true, camera: false, microphone: true,
    cameraFront: 'webcam', cameraBack: 'webcam', cameraFrontDevice: '', cameraBackDevice: '',
    cameraDevice: '',
    locale: '',
    customPackage: '',
    apps: [], appFiles: {},
    notify: true,
    directory: '',
    brand: firstBrand,
    manufacturer: first?.identity.manufacturer ?? 'Google',
    model: first ? handsetName(first) : 'Google Pixel 9 Pro XL',
    device: first ? first.id.replace(/[^A-Za-z0-9_-]/g, '_') : 'komodo',
    product: first ? first.id.replace(/[^A-Za-z0-9_-]/g, '_') : 'komodo',
    mac: randomMac(firstBrand),
    imei: randomImei(firstBrand),
    androidId: randomAndroidId(),
    serialNumber: randomSerialNumber(firstBrand),
    phoneNumber: randomPhoneNumber(firstOp.country),
    operator: firstOp.name,
    simOperator: firstOp.numeric,
    simCountry: firstOp.country,
    telephone: '',
    identityTouched: false,
  };

  const compared = new Set<string>();
  const summaries = new Map<string, CreationSummary>();
  /** What a camera test measured, so the AVD is not told a size it cannot deliver. */
  let cameraLimits: { front?: CameraResolution; back?: CameraResolution } = {};
  let storeCatalogue: StoreEntry[] | undefined;
  let customImages: CustomImage[] | undefined;
  let customPath = '';
  let locales: Array<{ tag: string; label: string }> | undefined;
  let target: TargetDir | undefined;
  let step = 0;
  let creating = false;

  const STEPS: Array<{ id: string; titleKey: string; descKey: string; render: (host: HTMLElement) => void; problem: () => string }> = [
    { id: 'engine', titleKey: 'android.step.engine', descKey: 'android.step.engineDesc', render: renderEngine, problem: () => avdReady() || forced ? '' : t('android.needEngine') },
    { id: 'device', titleKey: 'android.step.device', descKey: 'android.step.deviceDesc', render: renderDevice, problem: () => draft.phone ? '' : t('android.needDevice') },
    { id: 'system', titleKey: 'android.step.system', descKey: 'android.step.systemDesc', render: renderSystem, problem: () => '' },
    { id: 'setup', titleKey: 'android.step.setup', descKey: 'android.step.setupDesc', render: renderSetup, problem: () => NAME_RX.test(draft.name.trim()) ? '' : t('android.nameInvalid') },
    { id: 'review', titleKey: 'android.step.review', descKey: 'android.step.reviewDesc', render: renderReview, problem: () => '' },
  ];

  // ---------------------------------------------------------------- chrome

  const rail = h('div', { class: 'wiz-rail', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': t('android.wizardSteps') });
  const panel = h('div', { class: 'wiz-panel', role: 'tabpanel', tabindex: '0' });
  const panelTitle = h('h3', { class: 'wiz-title', id: 'androidWizTitle' });
  const panelDesc = h('p', { class: 'hint' });
  const hint = h('span', { class: 'wiz-hint', role: 'status', 'aria-live': 'polite' });
  const back = h('button', { class: 'btn', text: t('common.back') }) as HTMLButtonElement;
  const next = h('button', { class: 'btn primary', text: t('common.next') }) as HTMLButtonElement;
  const cancel = h('button', { class: 'btn', text: t('common.cancel') }) as HTMLButtonElement;

  function paintRail(): void {
    clear(rail);
    STEPS.forEach((item, index) => {
      const done = index < step;
      const button = h('button', {
        type: 'button', role: 'tab', class: `wiz-step${index === step ? ' on' : ''}${done ? ' done' : ''}`,
        'aria-selected': String(index === step), tabindex: index === step ? '0' : '-1',
      },
      h('span', { class: 'wiz-num' }, done ? icon('check', 13) : h('span', { text: String(index + 1) })),
      h('span', { class: 'wiz-step-copy' },
        h('b', { text: t(item.titleKey) }),
        h('span', { class: 'muted small ell', text: stepValue(index) })));
      button.onclick = () => { if (!creating) goto(index); };
      button.onkeydown = (event) => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const target2 = event.key === 'ArrowDown' ? Math.min(STEPS.length - 1, index + 1) : Math.max(0, index - 1);
        (rail.children[target2] as HTMLElement | undefined)?.focus();
      };
      rail.append(button);
    });
  }

  /** The one-line answer each step already holds, shown in the rail. */
  function stepValue(index: number): string {
    if (index === 0) return t('android.backend.avd');
    if (index === 1) return draft.phone ? handsetName(draft.phone) : t('android.needDevice');
    if (index === 2) return t(VARIANTS.find((item) => item.id === draft.variant)?.labelKey ?? 'android.variant.play');
    if (index === 3) return draft.name || t('android.name');
    return summaryFor()?.image ?? '';
  }

  function goto(index: number): void {
    const clean = Math.max(0, Math.min(STEPS.length - 1, index));
    // Moving forward is only allowed once the steps behind are answered.
    if (clean > step) {
      for (let i = step; i < clean; i++) {
        const problem = STEPS[i].problem();
        if (problem) { step = i; paint(); hint.textContent = problem; return; }
      }
    }
    step = clean;
    paint();
  }

  // Which way the panel should move: forward through the steps, back, into a
  // specification sheet, or just a quick fade for a change inside one step.
  let paintedStep = -1;
  let paintedView = '';

  function paint(): void {
    const current = STEPS[step];
    // Leaving the handset step always returns it to the list, so coming back
    // never lands on a specification sheet the user already left behind.
    if (current.id !== 'device') deviceView = 'list';
    paintRail();
    panelTitle.textContent = `${t('android.stepOf', { n: String(step + 1), total: String(STEPS.length) })} · ${t(current.titleKey)}`;
    panelDesc.textContent = t(current.descKey);
    const keepScroll = paintedStep === step && paintedView === deviceView;
    const previousScroll = panel.scrollTop;
    clear(panel);
    current.render(panel);
    panel.scrollTop = keepScroll ? previousScroll : 0;
    if (keepScroll) requestAnimationFrame(() => { panel.scrollTop = previousScroll; });
    animateIn(panel, paintedStep < 0 ? 'fade'
      : step > paintedStep ? 'next'
        : step < paintedStep ? 'prev'
          : deviceView !== paintedView ? (deviceView === 'list' ? 'prev' : 'next')
            : 'fade');
    paintedStep = step;
    paintedView = deviceView;
    back.disabled = step === 0 || creating;
    next.textContent = step === STEPS.length - 1 ? t('android.createNow') : t('common.next');
    next.classList.toggle('primary', true);
    next.disabled = creating;
    hint.textContent = current.problem() || '';
  }

  back.onclick = () => goto(step - 1);
  cancel.onclick = closeModal;
  next.onclick = () => {
    const problem = STEPS[step].problem();
    if (problem) { hint.textContent = problem; return; }
    if (step < STEPS.length - 1) goto(step + 1);
    else void create();
  };

  /** A failure the user can act on, with the raw tool output kept underneath. */
  function errorPanel(title: string, detail: string): HTMLElement {
    return h('div', { class: 'error-panel', role: 'alert' },
      h('div', { class: 'error-head' }, icon('alert', 16), h('b', { text: title })),
      detail ? h('p', { class: 'error-detail', text: detail }) : null);
  }

  // ---------------------------------------------------------------- data

  const summaryKey = () => `${draft.phone?.id ?? ''}|${draft.variant}`;
  const summaryFor = () => summaries.get(summaryKey());
  const customFor = () => (customImages ?? []).find((image) => image.packageName === draft.customPackage);

  /** Ask the main process for the numbers of the current phone/variant pair. */
  async function loadSummary(variant = draft.variant): Promise<CreationSummary | undefined> {
    const phone = draft.phone;
    if (!phone) return undefined;
    const key = `${phone.id}|${variant}`;
    const cached = summaries.get(key);
    if (cached) return cached;
    const value = await api.invoke<CreationSummary>('mgr:android-summary', phone.id, variant).catch(() => undefined);
    if (value) summaries.set(key, value);
    return value;
  }

  /** Follow the catalogue unless the user has taken the wheel. */
  async function applyProfileDefaults(): Promise<void> {
    const phone = draft.phone;
    if (!phone) return;
    const summary = await loadSummary();
    if (!draft.hardwareTouched) {
      draft.ramMb = summary?.ramMb ?? phone.sizing.ramMb;
      draft.cpus = summary?.cpus ?? phone.sizing.cpus;
      draft.diskGb = summary?.storageGb ?? phone.sizing.storageGb;
      draft.heapMb = phone.avd.heapMb;
      draft.sdCardMb = phone.avd.sdCardMb;
      draft.width = phone.avd.width;
      draft.height = phone.avd.height;
      draft.dpi = phone.avd.dpi;
    }
    const model = handsetName(phone);
    const brand = phone.identity.manufacturer === 'Google' ? 'google' : phone.identity.manufacturer.toLowerCase();
    draft.brand = brand;
    draft.manufacturer = phone.identity.manufacturer;
    draft.model = model;
    draft.device = phone.id.replace(/[^A-Za-z0-9_-]/g, '_');
    draft.product = draft.device;
    if (!draft.identityTouched) {
      const op = randomSimProfile(draft.simCountry || 'us');
      draft.mac = randomMac(brand);
      draft.imei = randomImei(brand);
      draft.androidId = randomAndroidId();
      draft.serialNumber = randomSerialNumber(brand);
      draft.phoneNumber = randomPhoneNumber(op.country);
      draft.operator = op.name;
      draft.simOperator = op.numeric;
      draft.simCountry = op.country;
    }
    if (!draft.nameTouched) draft.name = suggestName(phone);
  }

  async function refreshTarget(): Promise<void> {
    target = await api.invoke<TargetDir>('mgr:android-target-dir', draft.directory.trim()).catch(() => undefined);
  }

  // ---------------------------------------------------------------- step 1: engine

  function renderEngine(host: HTMLElement): void {
    const installHost = h('div', {});
    /** Install, then look again: the card must stop saying "Not installed". */
    const installSdk = avdReady() ? null : h('button', { class: 'btn small', text: t('android.installTools') }) as HTMLButtonElement;
    if (installSdk) {
      installSdk.onclick = async () => {
        installSdk.disabled = true;
        const ok = await runInstall(installHost, {
          title: t('android.backend.avd'), note: t('android.install.wait'),
          task: () => api.invoke<{ ok: boolean; message: string }>('mgr:android-install-tools'),
        });
        installSdk.disabled = false;
        toast(t(ok ? 'android.installDone' : 'android.installFailed'), ok ? 'ok' : 'err');
        const card = installHost.firstElementChild;
        await recheckEngines();
        paint();
        // Keep the outcome of the install visible across the repaint.
        if (card) panel.querySelector('.engine-actions')?.after(card);
      };
    }

    // Detection can only guess where the SDK lives; this button is the way out
    // of "it is installed but OctoBrowser cannot see it".
    const locateSdk = avdReady() ? null : h('button', { class: 'btn small' }, icon('folder', 14), h('span', { text: t('android.chooseSdk') }));
    if (locateSdk) {
      locateSdk.onclick = async () => {
        const chosen = await run(api.invoke<string | null>('mgr:pick-folder'));
        if (!chosen) return;
        const result = await run(api.invoke<{ ok: boolean; path: string; message: string }>('mgr:android-set-sdk', chosen));
        if (result?.ok) toast(t('android.sdkSet', { path: result.path }), 'ok');
        else toast(t('android.sdkRejected'), 'err', result?.message);
        await recheckEngines();
        paint();
      };
    }

    const recheck = h('button', { class: 'btn small' }, icon('refreshCircle', 14), h('span', { text: t('android.recheckEngines') }));
    recheck.onclick = async () => {
      recheck.classList.add('spinning');
      await recheckEngines();
      recheck.classList.remove('spinning');
      paint();
      toast(t(avdReady() ? 'android.engineReady' : 'android.engineMissing'), avdReady() ? 'ok' : 'err');
    };

    const avdCard = optionCard({
      selected: true,
      title: t('android.backend.avd'),
      meta: sdkStatus?.sdkRoot || t('android.engineAvdMeta'),
      lead: h('div', { class: 'pick-icon' }, icon('smartphone', 22)),
      lines: [
        [t('android.cmp.cost'), t('android.cmp.costAvd')],
        [t('android.cmp.speed'), t('android.cmp.speedAvd')],
        [t('android.cmp.images'), t('android.cmp.imagesAvd')],
        [t('android.cmp.media'), t('android.cmp.mediaAvd')],
      ],
      extra: h('div', { class: 'pick-foot' },
        pill(avdReady() ? 'ok' : 'bad', t(avdReady() ? 'android.engineReady' : 'android.engineMissing')),
        installSdk, locateSdk),
      onPick: () => { void applyProfileDefaults().then(paint); },
      wide: true,
    });
    host.append(radioGroup('pick-grid two', [avdCard]));
    host.append(h('div', { class: 'row engine-actions' }, recheck));

    // Never a dead end: if we are wrong about the engine, the user can say so
    // and carry on - with the consequence spelled out.
    if (!avdReady()) {
      const anyway = h('button', { class: 'btn small', text: t('android.useAnyway') });
      anyway.onclick = () => { forced = true; paint(); hint.textContent = t('android.useAnywayNote'); };
      const searched = sdkStatus?.searched ?? [];
      const where = h('details', { class: 'card-specs' }, h('summary', { text: t('android.searched') }));
      for (const item of searched.slice(0, 12)) where.append(h('div', { class: 'small muted ell', text: item }));
      host.append(h('div', { class: 'error-panel', role: 'note' },
        h('div', { class: 'error-head' }, icon('alert', 16), h('b', { text: t('android.needEngine') })),
        h('p', { class: 'error-detail', text: t('android.needEngineHint') }),
        searched.length ? where : null,
        h('div', { class: 'row' }, anyway)));
    } else if (forced) {
      forced = false;
    }
    host.append(installHost);
    if ((sdkStatus?.javaVersion ?? 0) < 17) {
      host.append(h('p', { class: 'hint warn', text: t('android.javaTooOld', { found: String(sdkStatus?.javaVersion || 0) }) }));
    }
  }

  // ---------------------------------------------------------------- step 2: handset

  /** The handset step has three views, all inside the same panel. */
  let deviceView: 'list' | 'specs' | 'compare' = 'list';
  let specsPhone: PhoneSpec | undefined;

  function renderDevice(host: HTMLElement): void {
    if (deviceView === 'specs' && specsPhone) {
      const chosen = specsPhone;
      const backToList = h('button', { class: 'btn small' }, icon('back', 14), h('span', { text: t('android.backToList') }));
      backToList.onclick = () => { deviceView = 'list'; paint(); };
      const choose = h('button', { class: 'btn small primary', text: t('android.useThisPhone') });
      choose.onclick = () => { deviceView = 'list'; pickPhone(chosen); };
      host.append(h('div', { class: 'row' }, backToList, choose), specSheet(chosen));
      return;
    }
    if (deviceView === 'compare') {
      const chosen = phones.filter((item) => compared.has(item.id));
      const backToList = h('button', { class: 'btn small' }, icon('back', 14), h('span', { text: t('android.backToList') }));
      backToList.onclick = () => { deviceView = 'list'; paint(); };
      const clearAll = h('button', { class: 'btn small', text: t('android.compareClear') });
      clearAll.onclick = () => { compared.clear(); deviceView = 'list'; paint(); };
      host.append(h('div', { class: 'row' }, backToList, clearAll), compareTable(chosen));
      return;
    }
    const grid = rovingFocus(h('div', { class: 'pick-grid phones', role: 'radiogroup', 'aria-label': t('android.step.device') }));
    const count = h('p', { class: 'hint' });
    const chosenLine = h('span', { class: 'hint' });
    const search = input('', { maxlength: '64', placeholder: t('android.searchPlaceholder'), autocomplete: 'off', 'aria-label': t('android.searchPlaceholder') }, () => apply());
    const brand = select<string>('', [['', t('android.allBrands')], ...brands.map((item): [string, string] => [item, item])], () => apply());
    const form = select<string>('any', [['any', t('android.anyForm')], ['bar', t('android.formBar')], ['foldable', t('android.formFoldable')], ['tablet', t('android.category.tablet')]], () => apply());
    const screen = select<string>('', [['', t('android.anyScreen')], ['small', t('android.screenSmall')], ['medium', t('android.screenMedium')], ['large', t('android.screenLarge')]], () => apply());
    const play = select<string>('', [['', t('android.anyPlay')], ['yes', t('android.withPlay')]], () => apply());
    const compareButton = h('button', { class: 'btn small', text: t('android.compareOpen'), disabled: true }) as HTMLButtonElement;
    const importButton = h('button', { class: 'btn small', text: t('android.handsetImport') }) as HTMLButtonElement;
    const importDirectoryButton = h('button', { class: 'btn small', text: t('android.handsetImportDirectory') }) as HTMLButtonElement;
    const registerImported = (imported: PhoneSpec[]): void => {
      for (const spec of imported) {
        const old = phones.findIndex((phone) => phone.id === spec.id);
        if (old >= 0) phones[old] = spec; else phones.push(spec);
        if (!brands.includes(spec.identity.manufacturer)) {
          brands.push(spec.identity.manufacturer);
          brand.append(h('option', { value: spec.identity.manufacturer, text: spec.identity.manufacturer }));
        }
      }
      const selected = imported[imported.length - 1];
      if (selected) {
        search.value = '';
        (brand as unknown as { value: string }).value = '';
        pickPhone(selected);
      }
    };
    importButton.onclick = async () => {
      try {
        const chosen = await run(api.invoke<string | null>('mgr:pick-file', { extensions: ['json'] }));
        if (!chosen) return;
        const imported = await run(api.invoke<PhoneSpec>('mgr:android-handset-import', { path: chosen }));
        if (!imported) return;
        registerImported([imported]);
        toast(t('android.handsetImported', { name: handsetName(imported) }), 'ok');
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'err');
      }
    };
    importDirectoryButton.onclick = async () => {
      try {
        const chosen = await run(api.invoke<string | null>('mgr:pick-folder'));
        if (!chosen) return;
        const result = await run(api.invoke<{ imported: PhoneSpec[]; errors: string[] }>('mgr:android-handset-directory', { path: chosen }));
        if (!result?.imported.length) return;
        registerImported(result.imported);
        toast(t('android.handsetDirectoryImported', { n: String(result.imported.length), skipped: String(result.errors.length) }), result.errors.length ? 'info' : 'ok');
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), 'err');
      }
    };
    compareButton.onclick = () => {
      if (compared.size < 2) { toast(t('android.compareNeedTwo'), 'err'); return; }
      deviceView = 'compare';
      paint();
    };
    const valueOf = (control: HTMLElement) => (control as unknown as { value: string }).value;

    function matches(phone: PhoneSpec): boolean {
      const needle = search.value.trim().toLowerCase();
      if (needle && !`${handsetName(phone)} ${phone.identity.modelNumber} ${phone.performance.chipset}`.toLowerCase().includes(needle)) return false;
      if (valueOf(brand) && phone.identity.manufacturer !== valueOf(brand)) return false;
      const foldable = phone.identity.category === 'foldable' || phone.identity.category === 'flip';
      const shape = valueOf(form);
      if (shape === 'foldable' && !foldable) return false;
      if (shape === 'tablet' && phone.identity.category !== 'tablet') return false;
      if (shape === 'bar' && (foldable || phone.identity.category === 'tablet')) return false;
      const inches = phone.display.inches;
      const wanted = valueOf(screen);
      if (wanted === 'small' && inches > 6.2) return false;
      if (wanted === 'medium' && (inches <= 6.2 || inches > 6.8)) return false;
      if (wanted === 'large' && inches <= 6.8) return false;
      if (valueOf(play) === 'yes' && !phone.sizing.playStore) return false;
      return true;
    }

    function apply(): void {
      const visible = phones.filter(matches);
      clear(grid);
      for (const phone of visible) grid.append(phoneCard(phone));
      if (!visible.length) grid.append(h('div', { class: 'empty compact' }, h('h2', { text: t('android.noMatches') })));
      count.textContent = t('android.showing', { shown: String(visible.length), total: String(phones.length), selected: String(compared.size) });
      compareButton.disabled = compared.size < 2;
    }

    function phoneCard(phone: PhoneSpec): HTMLElement {
      const specs = h('button', { class: 'btn small', text: t('android.details') });
      // The full sheet replaces the list inside this step: no second modal on
      // top of the wizard, so nothing the user typed is thrown away.
      specs.onclick = () => { specsPhone = phone; deviceView = 'specs'; paint(); };
      const compare = h('button', { class: `btn small${compared.has(phone.id) ? ' primary' : ''}`, text: t(compared.has(phone.id) ? 'android.comparing' : 'android.compare') });
      compare.onclick = () => {
        if (compared.has(phone.id)) compared.delete(phone.id);
        else if (compared.size >= COMPARE_LIMIT) { toast(t('android.compareLimit', { n: String(COMPARE_LIMIT) }), 'err'); return; }
        else compared.add(phone.id);
        apply();
      };
      const card = optionCard({
        selected: draft.phone?.id === phone.id,
        title: phone.identity.commercialName,
        meta: `${phone.identity.manufacturer} · ${phone.identity.currentAndroid} · API ${phone.identity.apiLevel}`,
        lead: illustration(phone, 62),
        lines: [
          [t('android.spec.diagonal'), `${phone.display.inches}" ${phone.display.width}x${phone.display.height}`],
          [t('android.spec.chipset'), phone.performance.chipset],
          [t('android.spec.virtualRam'), `${phone.sizing.ramMb} MB · ${phone.sizing.cpus} CPU`],
          [t('android.spec.downloadSize'), size(phone.storage.imageDownloadBytes)],
        ],
        extra: h('div', { class: 'pick-foot' }, specs, compare),
        onPick: () => pickPhone(phone, markSelection),
      });
      card.dataset.phone = phone.id;
      return card;
    }

    /** Move the selected state between cards without rebuilding the grid. */
    function markSelection(): void {
      for (const card of grid.querySelectorAll<HTMLElement>('.pick-card')) {
        const on = card.dataset.phone === draft.phone?.id;
        card.classList.toggle('on', on);
        card.setAttribute('aria-checked', String(on));
        card.tabIndex = on ? 0 : -1;
        const mark = card.querySelector('.pick-mark');
        if (mark) { clear(mark); mark.append(icon(on ? 'check' : 'box', 15)); }
      }
      chosenLine.textContent = draft.phone ? t('android.chosenDevice', { name: handsetName(draft.phone) }) : t('android.needDevice');
    }

    host.append(
      h('div', { class: 'wiz-filters' }, search, brand, form, screen, play, compareButton),
      h('div', { class: 'handset-import' },
        h('div', {}, h('b', { text: t('android.handsetImportTitle') }), h('p', { class: 'hint', text: t('android.handsetImportHint') })),
        h('div', { class: 'row' }, importButton, importDirectoryButton)),
      h('div', { class: 'row between' }, count, chosenLine),
      grid);
    apply();
    markSelection();
  }

  /**
   * Choose a handset. `after` lets the handset step update just the cards it
   * already drew - repainting the whole step would throw away the search text
   * and the filters the user set to find that phone in the first place.
   */
  function pickPhone(phone: PhoneSpec, after?: () => void): void {
    draft.phone = phone;
    summaries.clear();
    void applyProfileDefaults().then(() => {
      paintRail();
      if (after) { after(); hint.textContent = ''; } else paint();
    });
  }

  // ---------------------------------------------------------------- step 3: Android image

  function renderSystem(host: HTMLElement): void {
    const phone = draft.phone;
    if (!phone) return;
    const grid = rovingFocus(h('div', { class: 'pick-grid two', role: 'radiogroup', 'aria-label': t('android.imageProfile') }));
    const cards = new Map<string, HTMLElement>();
    for (const variant of VARIANTS) {
      const card = optionCard({
        selected: draft.variant === variant.id,
        title: t(variant.labelKey),
        meta: t(variant.descKey),
        onPick: () => {
          draft.variant = variant.id;
          void applyProfileDefaults().then(paint);
        },
        lines: [[t('android.spec.downloadSize'), '…'], [t('android.spec.diskUse'), '…'], [t('android.spec.freeInside'), '…']],
        wide: true,
      });
      cards.set(variant.id, card);
      grid.append(card);
    }
    host.append(grid);

    // Fill in the real numbers per variant as soon as the catalogue answers.
    void Promise.all(VARIANTS.map(async (variant) => {
      const summary = await loadSummary(variant.id);
      const card = cards.get(variant.id);
      if (!summary || !card) return;
      const lines = card.querySelector('.pick-lines');
      if (!lines) return;
      clear(lines);
      const row = (key: string, value: string) => lines.append(h('span', { class: 'muted', text: key }), h('span', { text: value }));
      row(t('android.spec.androidVersion'), `${summary.androidVersion} (API ${summary.apiLevel})${summary.released ? ` · ${summary.released}` : ''}`);
      row(t('android.spec.downloadSize'), summary.imageInstalled ? t('android.alreadyDownloaded') : size(summary.downloadBytes));
      row(t('android.spec.diskUse'), size(summary.diskBytes));
      row(t('android.spec.playStore'), t(summary.playStore ? 'state.on' : 'state.off'));
    }));

    host.append(h('p', { class: 'hint', text: t('android.imageAutoDownload') }), customImagesBlock());
  }

  /**
   * Android versions the catalogue does not carry. The user names the SDK
   * package; it is validated, remembered and offered here like any other.
   */
  function customImagesBlock(): HTMLElement {
    const body = h('div', {});
    const draw = (): void => {
      body.replaceChildren();
      const list = customImages ?? [];
      const cards = list.map((image) => optionCard({
        selected: draft.customPackage === image.packageName,
        title: image.label,
        meta: `${image.packageName}${image.released ? ` · ${image.released}` : ''}`,
        lines: [[t('android.spec.api'), String(image.api)], [t('android.custom.package'), image.packageName]],
        onPick: () => { draft.customPackage = draft.customPackage === image.packageName ? '' : image.packageName; paint(); },
        wide: true,
      }));
      if (cards.length) body.append(radioGroup('pick-grid two', cards));
      if (draft.customPackage) body.append(h('p', { class: 'hint', text: t('android.custom.inUse', { pkg: draft.customPackage }) }));

      const pkg = input('', { maxlength: '120', autocomplete: 'off', placeholder: 'system-images;android-35;google_apis;x86_64' });
      const label = input('', { maxlength: '80', autocomplete: 'off', placeholder: t('android.custom.labelPlaceholder') });
      const released = input('', { maxlength: '7', autocomplete: 'off', placeholder: '2024-10' });
      const add = h('button', { class: 'btn small primary', text: t('android.custom.add') });
      add.onclick = () => void busyAdd();
      const importDirectory = h('button', { class: 'btn small', text: t('android.custom.importDirectory') });
      const importRom = h('button', { class: 'btn small primary', text: t('android.custom.importRom') });
      const importHost = h('div', { class: 'install-slot' });
      type ImageImport = { image: CustomImage; destination: string; bytes: number; files: number };
      const importChosen = async (chosen: string, channel: 'mgr:android-custom-directory' | 'mgr:android-custom-rom', note: string): Promise<void> => {
        const outcome: { result: ImageImport | null } = { result: null };
        const ok = await runInstall(importHost, {
          title: t('android.custom.importing'), note,
          task: async () => {
            const response = await api.invoke<{ ok: boolean; result: ImageImport | null; message: string }>(channel, { path: chosen });
            outcome.result = response?.result ?? null;
            return { ok: response?.ok === true, message: response?.message ?? '' };
          },
        });
        const imported = outcome.result;
        if (!ok || !imported) return;
        customImages = [imported.image, ...(customImages ?? []).filter((item) => item.packageName !== imported.image.packageName)];
        // Selecting the imported ROM here means Finish creates the AVD from it
        // rather than silently falling back to the catalogue image.
        draft.customPackage = imported.image.packageName;
        toast(t('android.custom.imported', { name: imported.image.label }), 'ok');
        window.setTimeout(() => paint(), 800);
      };
      importDirectory.onclick = async () => {
        const chosen = await run(api.invoke<string | null>('mgr:pick-folder'));
        if (chosen) await importChosen(chosen, 'mgr:android-custom-directory', t('android.custom.importNote'));
      };
      importRom.onclick = async () => {
        const chosen = await run(api.invoke<string | null>('mgr:pick-file', { extensions: ['zip'] }));
        if (chosen) await importChosen(chosen, 'mgr:android-custom-rom', t('android.custom.romImportNote'));
      };
      const busyAdd = async () => {
        const result = await run(api.invoke<{ ok: boolean; image: CustomImage | null; message: string }>('mgr:android-custom-add', {
          packageName: pkg.value.trim(), label: label.value.trim(), released: released.value.trim(),
        }));
        if (!result) return;
        if (!result.ok) { toast(t('android.custom.failed'), 'err', result.message); return; }
        customImages = [result.image as CustomImage, ...(customImages ?? []).filter((item) => item.packageName !== result.image?.packageName)];
        draft.customPackage = result.image?.packageName ?? '';
        toast(t('android.custom.added'), 'ok');
        paint();
      };
      body.append(
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.custom.package') }), pkg),
          h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.custom.label') }), label),
          h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.custom.released') }), released)),
        h('div', { class: 'row' }, add, importRom, importDirectory),
        h('p', { class: 'hint', text: t('android.custom.how') }),
        h('p', { class: 'hint', text: t('android.custom.directoryHow') }),
        h('p', { class: 'hint warn', text: t('android.custom.romWarning') }),
        importHost,
        customPath ? h('p', { class: 'small muted ell', text: t('android.custom.file', { path: S.init?.settings?.ui?.hideDirectoryPaths ? (t('settings.pathHidden') || '••••••••••••••••') : customPath }) }) : h('span', {}));
    };
    draw();
    if (!customImages) {
      void api.invoke<{ images: CustomImage[]; path: string }>('mgr:android-custom')
        .then((value) => { customImages = value?.images ?? []; customPath = value?.path ?? ''; if (STEPS[step].id === 'system') draw(); })
        .catch(() => { customImages = []; });
    }
    // Keep ROM selection visible: it is a first-class way to choose the image
    // used for this machine, not an advanced action hidden behind a fold.
    return h('details', { class: 'card-specs app-group', open: true }, h('summary', { text: t('android.custom.title') }), body);
  }

  // ---------------------------------------------------------------- step 4: setup

  function renderSetup(host: HTMLElement): void {
    const phone = draft.phone;
    if (!phone) return;

    const name = input(draft.name, { maxlength: '64', autocomplete: 'off', placeholder: t('android.namePlaceholder'), 'aria-describedby': 'androidNameHint' }, (value) => {
      draft.name = value;
      draft.nameTouched = true;
      nameHint.textContent = NAME_RX.test(value.trim()) ? t('android.nameOk') : t('android.nameInvalid');
      nameHint.classList.toggle('warn', !NAME_RX.test(value.trim()));
      hint.textContent = STEPS[step].problem();
    });
    const nameHint = h('p', { class: 'hint', id: 'androidNameHint', text: t('android.nameOk') });

    const touched = () => { draft.hardwareTouched = true; draft.preset = 'custom'; };
    const presets: Array<[Draft['preset'], string]> = [['light', t('android.preset.light')], ['standard', t('android.preset.standard')], ['ultra', t('android.preset.ultra')], ['custom', t('android.preset.custom')]];
    const presetSelect = select<Draft['preset']>(draft.preset, presets, (value) => {
      draft.preset = value;
      if (value === 'custom') return;
      const summary = summaryFor();
      const baseRam = summary?.ramMb ?? phone.sizing.ramMb;
      const baseDisk = summary?.storageGb ?? phone.sizing.storageGb;
      if (value === 'light') { draft.ramMb = Math.max(1536, Math.round(baseRam / 2)); draft.cpus = 2; draft.diskGb = Math.max(8, Math.round(baseDisk / 2)); draft.heapMb = 256; }
      if (value === 'standard') { draft.ramMb = baseRam; draft.cpus = summary?.cpus ?? phone.sizing.cpus; draft.diskGb = baseDisk; draft.heapMb = phone.avd.heapMb; }
      if (value === 'ultra') { draft.ramMb = Math.max(8192, baseRam); draft.cpus = Math.max(6, summary?.cpus ?? 4); draft.diskGb = Math.max(32, baseDisk); draft.heapMb = 1024; }
      draft.hardwareTouched = true;
      paint();
    });

    // The camera section is the picker shared with the device settings and the
    // launch dialog. It offers only the cameras that send a picture on this
    // computer right now; a lens with none is Off. Its check also records the
    // resolution Android is told about.
    const cameras = cameraPicker({
      initial: {
        front: draft.cameraFront, back: draft.cameraBack,
        frontDevice: draft.cameraFrontDevice, backDevice: draft.cameraBackDevice,
        frontLimit: cameraLimits.front, backLimit: cameraLimits.back,
      },
      onChange: (value) => {
        draft.cameraFront = value.front;
        draft.cameraBack = value.back;
        draft.cameraFrontDevice = value.frontDevice;
        draft.cameraBackDevice = value.backDevice;
        draft.cameraDevice = value.backDevice || value.frontDevice;
        draft.camera = value.front !== 'none' || value.back !== 'none';
        cameraLimits = { front: value.frontLimit, back: value.backLimit };
      },
    });

    // The language Android boots in, applied as a system property.
    const languageSlot = h('div', {});
    const paintLanguages = (): void => {
      languageSlot.replaceChildren();
      const list = locales ?? [{ tag: '', label: t('android.language.system') }];
      languageSlot.append(
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.language') }),
          select<string>(draft.locale, list.map((item): [string, string] => [item.tag, item.tag ? item.label : t('android.language.system')]), (value) => { draft.locale = value; })),
        h('p', { class: 'hint', text: t('android.languageHint') }));
    };
    paintLanguages();
    if (!locales) {
      void api.invoke<Array<{ tag: string; label: string }>>('mgr:android-locales')
        .then((list) => { locales = list ?? []; if (STEPS[step].id === 'setup') paintLanguages(); })
        .catch(() => undefined);
    }

    const group = (titleKey: string, ...children: Array<Node | null>) =>
      h('section', { class: 'android-group' }, h('h3', { text: t(titleKey) }), ...children);

    const randomizeAllBtn = h('button', { type: 'button', class: 'btn small', text: t('android.identity.randomizeAll') });
    randomizeAllBtn.onclick = (e) => {
      e.preventDefault();
      const op = randomSimProfile(draft.simCountry || 'us');
      draft.mac = randomMac(draft.brand);
      draft.imei = randomImei(draft.brand);
      draft.androidId = randomAndroidId();
      draft.serialNumber = randomSerialNumber(draft.brand);
      draft.phoneNumber = randomPhoneNumber(op.country);
      draft.operator = op.name;
      draft.simOperator = op.numeric;
      draft.simCountry = op.country;
      draft.identityTouched = true;
      toast(t('android.identity.randomized'), 'ok');
      paint();
    };

    const modelInput = input(draft.model, { maxlength: '64', autocomplete: 'off' }, (value) => { draft.model = value; draft.identityTouched = true; });
    const brandInput = input(draft.brand, { maxlength: '32', autocomplete: 'off' }, (value) => { draft.brand = value; draft.identityTouched = true; });
    const manufacturerInput = input(draft.manufacturer, { maxlength: '32', autocomplete: 'off' }, (value) => { draft.manufacturer = value; draft.identityTouched = true; });
    const deviceInput = input(draft.device, { maxlength: '32', autocomplete: 'off' }, (value) => { draft.device = value; draft.product = value; draft.identityTouched = true; });

    const macInput = input(draft.mac, { maxlength: '17', autocomplete: 'off' }, (value) => { draft.mac = value; draft.identityTouched = true; });
    const imeiInput = input(draft.imei, { maxlength: '15', autocomplete: 'off' }, (value) => { draft.imei = value; draft.identityTouched = true; });
    const androidIdInput = input(draft.androidId, { maxlength: '16', autocomplete: 'off' }, (value) => { draft.androidId = value; draft.identityTouched = true; });
    const serialInput = input(draft.serialNumber, { maxlength: '32', autocomplete: 'off' }, (value) => { draft.serialNumber = value; draft.identityTouched = true; });
    const telephoneInput = input(draft.telephone, { maxlength: '16', autocomplete: 'off', placeholder: '+15555550123', 'aria-describedby': 'androidTelephoneHint' }, (value) => { draft.telephone = value; });
    const phoneInput = input(draft.phoneNumber, { maxlength: '20', autocomplete: 'off' }, (value) => { draft.phoneNumber = value; draft.identityTouched = true; });
    const operatorInput = input(draft.operator, { maxlength: '32', autocomplete: 'off' }, (value) => { draft.operator = value; draft.identityTouched = true; });
    const simOperatorInput = input(draft.simOperator, { maxlength: '10', autocomplete: 'off' }, (value) => { draft.simOperator = value; draft.identityTouched = true; });
    const simCountrySelect = select<string>(draft.simCountry || 'us', [
      ['us', 'US (+1)'],
      ['pl', 'Poland (+48)'],
      ['gb', 'United Kingdom (+44)'],
      ['de', 'Germany (+49)'],
    ], (value) => {
      draft.simCountry = value;
      const op = randomSimProfile(value);
      draft.operator = op.name;
      draft.simOperator = op.numeric;
      draft.phoneNumber = randomPhoneNumber(value);
      draft.identityTouched = true;
      paint();
    });

    const identityGroup = h('section', { class: 'android-group' },
      h('div', { class: 'android-group-head' },
        h('h3', { text: t('android.group.identity') }),
        randomizeAllBtn),
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.identity.model') }), modelInput),
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.identity.brand') }), brandInput),
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.identity.manufacturer') }), manufacturerInput),
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.identity.deviceCodename') }), deviceInput),
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.identity.mac') }),
          inputWithAction(macInput, () => { draft.mac = randomMac(draft.brand); macInput.value = draft.mac; draft.identityTouched = true; }, 'android.identity.randomize')),
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.identity.imei') }),
          inputWithAction(imeiInput, () => { draft.imei = randomImei(draft.brand); imeiInput.value = draft.imei; draft.identityTouched = true; }, 'android.identity.randomize')),
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.identity.androidId') }),
          inputWithAction(androidIdInput, () => { draft.androidId = randomAndroidId(); androidIdInput.value = draft.androidId; draft.identityTouched = true; }, 'android.identity.randomize')),
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.identity.serial') }),
          inputWithAction(serialInput, () => { draft.serialNumber = randomSerialNumber(draft.brand); serialInput.value = draft.serialNumber; draft.identityTouched = true; }, 'android.identity.randomize')),
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.identity.phone') }),
          inputWithAction(phoneInput, () => { draft.phoneNumber = randomPhoneNumber(draft.simCountry); phoneInput.value = draft.phoneNumber; draft.identityTouched = true; }, 'android.identity.randomize')),
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.identity.simCountry') }), simCountrySelect),
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.identity.operator') }), operatorInput),
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.identity.simOperator') }), simOperatorInput)),
      h('p', { class: 'hint', text: t('android.identity.hintDetail') }));

    host.append(
      group('android.group.model',
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.name') }), name),
        nameHint,
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.telephony.label') }), telephoneInput),
        h('p', { class: 'hint', id: 'androidTelephoneHint', text: t('android.telephony.hint') }),
        languageSlot,
        h('p', { class: 'hint', text: `${handsetName(phone)} · ${phone.identity.currentAndroid} · ${phone.display.inches}" · ${phone.performance.chipset}` })),
      identityGroup,
      group('android.group.performance',
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.preset') }), presetSelect),
        h('div', { class: 'grid2' },
          numberField('android.ram', draft.ramMb, { min: '1024', max: '65536', step: '512' }, (value) => { draft.ramMb = value; touched(); }, 'MB'),
          numberField('android.cores', draft.cpus, { min: '1', max: '16' }, (value) => { draft.cpus = value; touched(); }),
          numberField('android.virtualStorageGb', draft.diskGb, { min: '4', max: '512' }, (value) => { draft.diskGb = value; touched(); }),
          numberField('android.heapMb', draft.heapMb, { min: '128', max: '4096' }, (value) => { draft.heapMb = value; touched(); }, 'MB'),
          numberField('android.sdCardMb', draft.sdCardMb, { min: '0', max: '65536' }, (value) => { draft.sdCardMb = value; touched(); }, 'MB')),
        h('p', { class: 'hint', text: t('android.presetHint') })),
      group('android.group.display',
        h('div', { class: 'grid2' },
          numberField('android.width', draft.width, { min: '320', max: '4096' }, (value) => { draft.width = value; touched(); }),
          numberField('android.height', draft.height, { min: '480', max: '4096' }, (value) => { draft.height = value; touched(); }),
          numberField('android.dpi', draft.dpi, { min: '120', max: '640' }, (value) => { draft.dpi = value; touched(); }))),
      group('android.group.media',
        cameras.element,
        toggle(draft.microphone, 'android.media.microphone', (value) => { draft.microphone = value; }),
        h('p', { class: 'hint', text: t('android.mic.honest') })),
      h('details', { class: 'card-specs' }, h('summary', { text: t('android.advanced') }),
        h('div', { class: 'grid2' },
          h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.gpuMode') }),
            select<string>(draft.gpuMode, [['auto', t('android.gpu.auto')], ['host', t('android.gpu.host')], ['swiftshader_indirect', t('android.gpu.software')], ['off', t('android.gpu.off')]], (value) => { draft.gpuMode = value; })),
          h('label', { class: 'field' }, h('span', { class: 'lbl', text: t('android.bootMode') }),
            select<string>(draft.bootMode, [['quick', t('android.boot.quick')], ['cold', t('android.boot.cold')]], (value) => { draft.bootMode = value; }))),
        toggle(draft.snapshots, 'android.snapshots', (value) => { draft.snapshots = value; })));
  }

  // ---------------------------------------------------------------- step 5: review

  const minimizeButton = h('button', { class: 'btn small wizard-minimize', type: 'button', text: t('android.downloads.minimize') }) as HTMLButtonElement;
  minimizeButton.hidden = true;
  minimizeButton.onclick = minimizeCreation;
  const progressBar = h('div', { class: 'progress-fill' });
  const progressPct = h('span', { class: 'progress-pct', text: '0%' });
  const progressStep = h('p', { class: 'hint progress-step', role: 'status', 'aria-live': 'polite' });
  const failureBox = h('div', {});
  failureBox.hidden = true;
  const progressBox = h('div', { class: 'android-progress' },
    h('div', { class: 'progress-row' },
      h('div', { class: 'progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, progressBar), progressPct),
    progressStep);
  progressBox.hidden = true;
  let downloadDock: HTMLElement | undefined;
  let progressStartedAt = 0;

  /** A minimized creation stays visible as a download in the launcher. The
   * wizard DOM remains mounted, so restoring it loses neither choices nor
   * progress and the background IPC operation continues normally. */
  function ensureDownloadDock(): HTMLElement {
    if (downloadDock?.isConnected) return downloadDock;
    const dockBar = h('div', { class: 'progress-fill indeterminate' });
    dockBar.style.width = '100%';
    const dockPct = h('span', { class: 'progress-pct', text: '…' });
    const dockText = h('p', { class: 'hint progress-step', text: t('android.progress.starting') });
    downloadDock = h('button', { class: 'android-download-dock', type: 'button', 'aria-label': t('android.downloads.restore') },
      h('div', { class: 'android-download-dock-head' }, icon('download', 16), h('b', { text: t('android.downloads.title') }), h('span', { class: 'grow' }), dockPct),
      h('div', { class: 'progress-track' }, dockBar), dockText);
    downloadDock.dataset.progressBar = 'child';
    downloadDock.onclick = () => {
      document.getElementById('modal')?.classList.remove('hidden');
      downloadDock?.classList.add('hidden');
    };
    document.body.append(downloadDock);
    return downloadDock;
  }

  function minimizeCreation(): void {
    if (!creating) return;
    document.getElementById('modal')?.classList.add('hidden');
    ensureDownloadDock().classList.remove('hidden');
  }

  function updateDownloadDock(progress: { stage: string; percent: number; text: string }): void {
    if (!downloadDock) return;
    const bar = downloadDock.querySelector<HTMLElement>('.progress-fill');
    const pct = downloadDock.querySelector<HTMLElement>('.progress-pct');
    const text = downloadDock.querySelector<HTMLElement>('.progress-step');
    if (!bar || !pct || !text) return;
    if (progress.percent >= 0) {
      bar.classList.remove('indeterminate');
      bar.style.width = `${Math.max(2, progress.percent)}%`;
      pct.textContent = `${progress.percent}%`;
    } else {
      bar.classList.add('indeterminate');
      bar.style.width = '100%';
      pct.textContent = '…';
    }
    text.textContent = `${t(`android.progress.${progress.stage}`)} · ${progressText(progress, progressStartedAt)}`;
  }

  function renderReview(host: HTMLElement): void {
    const phone = draft.phone;
    if (!phone) return;
    const summaryBox = h('div', { class: 'spec-table' });
    const storageNote = h('p', { class: 'hint' });
    const directory = input(draft.directory, { maxlength: '2048', placeholder: t('android.directoryPlaceholder'), autocomplete: 'off', 'aria-label': t('android.downloadDirectory') }, (value) => {
      draft.directory = value;
      void refreshTarget().then(drawStorage);
    });
    const choose = h('button', { class: 'btn small' }, icon('folder', 14), h('span', { text: t('android.chooseDirectory') }));
    choose.onclick = async () => {
      const chosen = await run(api.invoke<string | null>('mgr:pick-folder'));
      if (!chosen) return;
      draft.directory = chosen;
      directory.value = chosen;
      await refreshTarget();
      drawStorage();
    };
    const useDefault = h('button', { class: 'btn small', text: t('android.useDefaultFolder') });
    useDefault.onclick = async () => {
      draft.directory = target?.suggested ?? '';
      directory.value = draft.directory;
      await refreshTarget();
      drawStorage();
    };
    const folderInfo = h('p', { class: 'hint' });

    function projected(): { diskBytes: number; sdBytes: number; total: number; freeInside: number } {
      const summary = summaryFor();
      const download = summary?.downloadBytes ?? phone!.storage.imageDownloadBytes;
      const diskBytes = Math.max(1, draft.diskGb) * GB;
      const sdBytes = Math.max(0, draft.sdCardMb) * MB;
      const installed = summary?.imageInstalled === true;
      return { diskBytes, sdBytes, freeInside: Math.max(GB, diskBytes - download * 2.2), total: (installed ? 0 : download) + diskBytes + sdBytes };
    }

    function drawStorage(): void {
      const p = projected();
      const targetDisplayPath = target ? (S.init?.settings?.ui?.hideDirectoryPaths ? (t('settings.pathHidden') || '••••••••••••••••') : target.path) : '';
      folderInfo.textContent = target
        ? (target.totalBytes > 0
          ? `${t('android.downloadFolder', { path: targetDisplayPath })} · ${t('android.folderSpace', { free: size(target.freeBytes), total: size(target.totalBytes) })}`
          : `${t('android.downloadFolder', { path: targetDisplayPath })} · ${t('android.folderMissing')}`)
        : t('android.spaceUnknown', { need: size(p.total) });
      if (target && target.totalBytes > 0) {
        const ok = target.freeBytes >= p.total * 1.1;
        storageNote.textContent = ok
          ? t('android.spaceOk', { need: size(p.total), free: size(target.freeBytes), path: targetDisplayPath })
          : t('android.spaceTight', { need: size(p.total), free: size(target.freeBytes), path: targetDisplayPath });
        storageNote.classList.toggle('warn', !ok);
      } else {
        storageNote.textContent = t('android.spaceUnknown', { need: size(p.total) });
        storageNote.classList.remove('warn');
      }
    }

    function drawSummary(): void {
      const summary = summaryFor();
      const custom = customFor();
      const customKind = custom?.packageName.split(';')[2] ?? '';
      const androidLine = custom
        ? `Android API ${custom.api}${custom.released ? ` · ${t('android.custom.publishedIn', { date: custom.released })}` : ''}`
        : summary ? `${summary.androidVersion} (API ${summary.apiLevel})${summary.released ? ` · ${t('android.custom.publishedIn', { date: summary.released })}` : ''}` : '—';
      const p = projected();
      clear(summaryBox);
      summaryBox.append(
        specRow(t('android.backend'), t('android.backend.avd')),
        specRow(t('android.name'), draft.name),
        specRow(t('android.spec.commercialName'), handsetName(phone!)),
        specRow(t('android.spec.image'), draft.customPackage || summary?.image || '—'),
        specRow(t('android.spec.androidVersion'), androidLine),
        specRow(t('android.spec.avdProfile'), phone!.avd.device),
        specRow(t('android.spec.virtualRam'), `${draft.ramMb} MB`),
        specRow(t('android.spec.virtualCpus'), String(draft.cpus)),
        specRow(t('android.spec.virtualStorage'), `${draft.diskGb} GB`),
        specRow(t('android.spec.resolution'), `${draft.width} x ${draft.height} · ${draft.dpi} dpi`),
        specRow(t('android.spec.googleApps'), t(custom ? (customKind.includes('google')) ? 'state.on' : 'state.off' : summary?.googleApps ? 'state.on' : 'state.off')),
        specRow(t('android.spec.playStore'), t(custom ? (customKind.includes('playstore')) ? 'state.on' : 'state.off' : summary?.playStore ? 'state.on' : 'state.off')),
        specRow(t('android.cameraBack'), draft.cameraBackDevice ? `${t('android.camera.webcam')} · ${draft.cameraBackDevice}` : t('android.camera.off')),
        specRow(t('android.cameraFront'), draft.cameraFrontDevice ? `${t('android.camera.webcam')} · ${draft.cameraFrontDevice}` : t('android.camera.off')),
        specRow(t('android.media.microphone'), t(draft.microphone ? 'state.on' : 'state.off')),
        specRow(t('android.language'), locales?.find((item) => item.tag === draft.locale)?.label ?? t('android.language.system')),
        specRow(t('android.spec.downloadSize'), summary?.imageInstalled ? t('android.alreadyDownloaded') : size(summary?.downloadBytes ?? 0)),
        specRow(t('android.spec.diskUse'), size(p.diskBytes)),
        specRow(t('android.spec.freeInside'), size(p.freeInside)),
        specRow(t('android.spec.totalOnDisk'), size(p.total)),
        specRow(t('android.spec.hostRequirements'), t('android.hostRequirements', {
          ram: `${summary?.hostRamGb ?? phone!.sizing.hostRamGb} GB`,
          cores: String(summary?.hostCores ?? phone!.sizing.hostCores),
          running: `${summary?.runningRamMb ?? phone!.sizing.runningRamMb} MB`,
        })));
    }

    // Apps to put on the device, ticked here and installed the first time it
    // boots (adb cannot install into a device that is not running yet).
    const appsHost = h('div', {});
    const paintApps = (): void => {
      appsHost.replaceChildren();
      const catalogue = storeCatalogue ?? [];
      if (!catalogue.length) { appsHost.append(h('p', { class: 'hint', text: t('common.loading') })); return; }
      const samsung = /samsung|galaxy/i.test(handsetName(phone));
      const body = h('div', { class: 'app-list' });
      for (const store of catalogue) {
        const blocked = store.samsungOnly && !samsung;
        const row = h('div', { class: `app-row${draft.apps.includes(store.id) ? ' on' : ''}${blocked ? ' off' : ''}` });
        const source = h('span', { class: 'small muted ell', text: draft.appFiles[store.id]
          || (store.source === 'manual' ? t('android.stores.manualRequired') : t('android.stores.autoDownload')) });
        const pick = h('button', { class: 'btn tiny', text: t('android.stores.chooseApk'), hidden: store.source !== 'manual' });
        pick.onclick = async () => {
          const chosen = await run(api.invoke<string | null>('mgr:pick-file', { extensions: ['apk'] }));
          if (!chosen) return;
          draft.appFiles[store.id] = chosen;
          source.textContent = chosen;
          if (!draft.apps.includes(store.id)) draft.apps.push(store.id);
          paintApps();
        };
        row.append(
          h('span', { class: 'app-icon' }, icon(store.icon, 16)),
          h('div', { class: 'app-copy' },
            h('b', { text: store.name }),
            h('span', { class: 'small muted', text: blocked ? t('android.stores.samsungOnly') : store.description }), source),
          h('div', { class: 'app-actions' }, pick, toggle(draft.apps.includes(store.id), 'android.stores.pick', (on) => {
            draft.apps = on ? [...new Set([...draft.apps, store.id])] : draft.apps.filter((id) => id !== store.id);
            if (!on) delete draft.appFiles[store.id];
            paintApps();
          }, blocked || (store.source === 'manual' && !draft.appFiles[store.id]))));
        body.append(row);
      }
      const available = catalogue.filter((store) => !store.samsungOnly || samsung);
      const all = h('button', { class: 'btn tiny', text: t('android.stores.selectAll') });
      all.onclick = () => { draft.apps = available.filter((store) => store.source !== 'manual' || draft.appFiles[store.id]).map((store) => store.id); paintApps(); };
      const none = h('button', { class: 'btn tiny', text: t('android.stores.selectNone') });
      none.onclick = () => { draft.apps = []; draft.appFiles = {}; paintApps(); };
      appsHost.append(
        h('details', { class: 'card-specs app-group' }, h('summary', { text: `${t('android.stores.preinstall')} · ${draft.apps.length}` }),
          h('p', { class: 'hint', text: t('android.stores.preinstallHint') }), h('div', { class: 'row' }, all, none), body));
    };
    paintApps();
    if (!storeCatalogue) {
      void api.invoke<StoreEntry[]>('mgr:android-stores')
        .then((list) => { storeCatalogue = list ?? []; if (STEPS[step].id === 'review') paintApps(); })
        .catch(() => undefined);
    }

    host.append(
      h('div', { class: 'spec-head' }, illustration(phone, 92),
        h('div', {}, h('b', { text: handsetName(phone) }),
          h('p', { class: 'hint', text: t('android.reviewHint') }))),
      h('h4', { class: 'spec-title', text: t('android.downloadDirectory') }),
      h('div', { class: 'row' }, directory, choose, useDefault),
      folderInfo,
      h('p', { class: 'hint', text: t('android.directoryAdvice') }),
      h('h4', { class: 'spec-title', text: t('android.setupSummary') }),
      summaryBox,
      storageNote,
      h('p', { class: 'hint', text: t('android.storageExplainer') }),
      h('h4', { class: 'spec-title', text: t('android.stores.preinstall') }),
      appsHost,
      toggle(draft.notify, 'android.notifyWhenDone', (value) => { draft.notify = value; }),
      h('p', { class: 'hint', text: t('android.notifyHint') }),
      progressBox,
      failureBox);

    drawSummary();
    drawStorage();
    void (async () => {
      await loadSummary();
      await refreshTarget();
      if (STEPS[step].id !== 'review') return;
      drawSummary();
      drawStorage();
    })();
  }

  // ---------------------------------------------------------------- create

  let stopProgress: (() => void) | undefined;

  function trackProgress(): void {
    clear(failureBox);
    failureBox.hidden = true;
    progressBox.hidden = false;
    progressBar.style.width = '2%';
    progressPct.textContent = '0%';
    progressStep.textContent = t('android.progress.starting');
    stopProgress?.();
    stopProgress = api.on<{ stage: string; percent: number; text: string }>('mgr:android-progress', (p) => {
      const track = progressBox.querySelector('.progress-track');
      if (typeof p?.percent === 'number' && p.percent >= 0) {
        progressBar.classList.remove('indeterminate');
        progressBar.style.width = `${Math.max(2, p.percent)}%`;
        progressPct.textContent = `${p.percent}%`;
        track?.setAttribute('aria-valuenow', String(p.percent));
      } else {
        progressBar.classList.add('indeterminate');
        progressBar.style.width = '100%';
        progressPct.textContent = '…';
        track?.removeAttribute('aria-valuenow');
      }
      progressStep.textContent = `${t(`android.progress.${p.stage}`)} · ${progressText(p, progressStartedAt)}`;
      updateDownloadDock(p);
    });
  }

  async function create(): Promise<void> {
    const phone = draft.phone;
    if (!phone) return;
    // Resolve name collisions before starting a download. Existing AVDs are
    // reconfigured in place only after explicit consent; choosing a copy gets
    // a deterministic unique name. Neither path deletes Android user data.
    const requested = draft.name.trim().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 64);
    const names = (await api.invoke<{ machines: Array<{ name: string }> }>('mgr:android-list').catch(() => ({ machines: [] }))).machines.map((item) => item.name);
    if (names.some((name) => name.toLocaleLowerCase() === requested.toLocaleLowerCase())) {
      if (window.confirm(t('android.existingAvdChoice', { name: requested }))) {
        draft.name = requested;
      } else {
        let index = 2;
        const uniqueBase = requested.slice(0, 56);
        let unique = `${uniqueBase}-${index}`;
        while (names.some((name) => name.toLocaleLowerCase() === unique.toLocaleLowerCase())) unique = `${uniqueBase}-${++index}`;
        draft.name = unique.slice(0, 64);
        toast(t('android.uniqueNameChosen', { name: draft.name }), 'ok');
      }
    }
    const startedAt = Date.now();
    progressStartedAt = startedAt;
    creating = true;
    minimizeButton.hidden = false;
    setModalCloseOverride(minimizeCreation);
    next.disabled = true;
    back.disabled = true;
    cancel.disabled = true;
    hint.textContent = t('android.creating');
    trackProgress();
    let failure = '';
    const result = await api.invoke<{ created: boolean; name: string }>('mgr:android-create-spec', {
      phoneId: phone.id, variant: draft.variant, name: draft.name.trim(),
      directory: draft.directory.trim(),
      ramMb: draft.ramMb, cpus: draft.cpus, diskGb: draft.diskGb, heapMb: draft.heapMb, sdCardMb: draft.sdCardMb,
      width: draft.width, height: draft.height, dpi: draft.dpi,
      gpuMode: draft.gpuMode, bootMode: draft.bootMode,
      snapshots: draft.snapshots,
      cameraFront: draft.cameraFront,
      cameraBack: draft.cameraBack,
      cameraFrontDevice: draft.cameraFrontDevice,
      cameraBackDevice: draft.cameraBackDevice,
      microphoneEnabled: draft.microphone,
      cameraDevice: draft.cameraBackDevice || draft.cameraFrontDevice,
      cameraLimits,
      locale: draft.locale, apps: draft.apps, appFiles: draft.appFiles,
      customPackage: draft.customPackage,
      telephone: draft.telephone.trim(),
      brand: draft.brand,
      manufacturer: draft.manufacturer,
      model: draft.model,
      marketName: draft.model,
      device: draft.device,
      product: draft.product || draft.device,
      mac: draft.mac,
      imei: draft.imei,
      androidId: draft.androidId,
      serialNumber: draft.serialNumber,
      phoneNumber: draft.phoneNumber,
      operator: draft.operator,
      simOperator: draft.simOperator,
      simCountry: draft.simCountry,
    }).catch((error: unknown) => {
      failure = error instanceof Error ? error.message : String(error);
      return null;
    });
    stopProgress?.();
    stopProgress = undefined;
    creating = false;
    minimizeButton.hidden = true;
    setModalCloseOverride(null);
    next.disabled = false;
    back.disabled = false;
    cancel.disabled = false;
    if (!result?.created) {
      progressBar.classList.remove('indeterminate');
      progressBar.style.width = '0%';
      progressPct.textContent = '';
      progressStep.textContent = '';
      clear(failureBox);
      failureBox.hidden = false;
      const panel = errorPanel(t('android.createFailed'), failure || t('android.progress.failed'));
      failureBox.append(panel);
      failureBox.scrollIntoView?.({ block: 'nearest' });
      hint.textContent = t('android.progress.failed');
      if (downloadDock) {
        downloadDock.classList.add('failed');
        downloadDock.querySelector<HTMLElement>('.progress-fill')!.style.width = '0%';
        downloadDock.querySelector<HTMLElement>('.progress-pct')!.textContent = t('android.downloads.failed');
        downloadDock.querySelector<HTMLElement>('.progress-step')!.textContent = failure || t('android.progress.failed');
      }
      if (failure) toast(t('android.createFailed'), 'err', failure);
      return;
    }
    // Say it out loud, and leave it on screen: the dialog used to disappear
    // the instant the device was written, which read as "nothing happened".
    progressBar.classList.remove('indeterminate');
    progressBar.style.width = '100%';
    progressPct.textContent = '100%';
    progressStep.textContent = t('android.progress.done');
    if (downloadDock) {
      downloadDock.classList.add('done');
      downloadDock.querySelector<HTMLElement>('.progress-fill')!.style.width = '100%';
      downloadDock.querySelector<HTMLElement>('.progress-pct')!.textContent = '100%';
      downloadDock.querySelector<HTMLElement>('.progress-step')!.textContent = t('android.downloads.done', { name: result.name });
    }
    const took = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    clear(failureBox);
    failureBox.hidden = false;
    failureBox.append(h('div', { class: 'install-card done', role: 'status' },
      h('div', { class: 'install-head' }, h('span', { class: 'install-mark' }, icon('check', 16)),
        h('b', { text: t('android.createdTitle', { name: result.name }) }),
        h('div', { class: 'grow' }),
        h('span', { class: 'small muted', text: t('android.install.took', { time: t('android.install.elapsedSec', { s: String(took) }) }) })),
      h('p', { class: 'hint', text: t('android.createdBody') })));
    failureBox.scrollIntoView?.({ block: 'nearest' });
    hint.textContent = t('android.created', { name: result.name });
    if (draft.notify) {
      void api.invoke('mgr:notify', {
        title: t('android.createdTitle', { name: result.name }),
        body: draft.apps.length ? t('android.notifyWithApps', { n: String(draft.apps.length) }) : t('android.createdBody'),
      });
    }
    next.textContent = t('common.close');
    next.onclick = () => { closeModal(); void context.reload(); };
    next.focus();
    toast(t('android.created', { name: result.name }), 'ok');
    await context.reload();
  }

  // ---------------------------------------------------------------- mount

  modal(t('android.create'), (box) => {
    // The wizard scrolls inside its panel, never as a whole dialog.
    box.classList.add('wizard-modal');
    box.querySelector('.modal-head')?.insertBefore(minimizeButton, box.querySelector('.modal-head .icon-btn'));
    box.append(
      h('div', { class: 'wizard' }, rail,
        h('div', { class: 'wiz-main' }, h('div', { class: 'wiz-head' }, panelTitle, panelDesc), panel)),
      h('div', { class: 'modal-actions wiz-actions' }, hint, cancel, back, next));
    paint();
    // modal() focuses the first primary button, which is "Next" in the footer.
    // The step the user is looking at is the better starting point.
    window.setTimeout(() => (panel.querySelector('.pick-card.on') as HTMLElement | null)?.focus(), 0);
    void (async () => {
      await applyProfileDefaults();
      await refreshTarget();
      paint();
    })();
  }, 'xwide', () => {
    stopProgress?.();
    stopProgress = undefined;
    downloadDock?.remove();
    downloadDock = undefined;
    setModalCloseOverride(null);
  });
}
