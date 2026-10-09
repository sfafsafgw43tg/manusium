/** The phone catalogue is pure data: check its integrity and its storage arithmetic. */
import { describe, expect, it } from 'vitest';
import { COMPARE_LIMIT, IMAGE_VARIANTS, PHONES, PHONE_BRANDS, applyVariant, creationSummary, filterPhones, phone } from '../src/main/android-catalog';

const REQUIRED = [
  'Google Pixel 9', 'Google Pixel 9 Pro', 'Google Pixel 9 Pro XL', 'Google Pixel 9 Pro Fold',
  'Google Pixel 8', 'Google Pixel 8 Pro', 'Google Pixel 8a',
  'Samsung Galaxy S24', 'Samsung Galaxy S24+', 'Samsung Galaxy S24 Ultra', 'Samsung Galaxy S23',
  'Samsung Galaxy S23 Ultra', 'Samsung Galaxy A55', 'Samsung Galaxy Z Flip 6', 'Samsung Galaxy Z Fold 6',
  'OnePlus OnePlus 12', 'OnePlus OnePlus 12R', 'OnePlus OnePlus 11', 'OnePlus OnePlus Open',
  'Xiaomi Xiaomi 14', 'Xiaomi Xiaomi 14 Ultra', 'Xiaomi Xiaomi 13T Pro',
  'Motorola Motorola Edge 50 Pro', 'Motorola Motorola Edge 50 Ultra', 'Motorola Motorola Razr 50 Ultra',
  'Nothing Nothing Phone (2)', 'Nothing Nothing Phone (2a)',
  'Generic Generic low-end Android phone', 'Generic Generic mid-range Android phone',
  'Generic Generic high-end Android phone', 'Generic Generic compact Android phone',
  'Generic Generic foldable Android phone', 'Generic Generic Android tablet',
];

describe('phone specification catalogue', () => {
  it('contains every requested handset and generic profile', () => {
    const names = PHONES.map((item) => `${item.identity.manufacturer} ${item.identity.commercialName}`);
    for (const required of REQUIRED) expect(names).toContain(required);
    expect(new Set(PHONES.map((item) => item.id)).size).toBe(PHONES.length);
    expect(PHONE_BRANDS).toEqual(expect.arrayContaining(['Google', 'Samsung', 'OnePlus', 'Xiaomi', 'Motorola', 'Nothing', 'Generic']));
  });

  it('fills every specification section for every device', () => {
    for (const item of PHONES) {
      expect(item.identity.modelNumber.length).toBeGreaterThan(2);
      expect(item.identity.apiLevel).toBeGreaterThanOrEqual(31);
      expect(item.display.inches).toBeGreaterThan(4);
      expect(item.display.aspectRatio).toMatch(/^\d+:\d+$/);
      expect(item.performance.chipset.length).toBeGreaterThan(3);
      expect(item.performance.ramOptionsGb.length).toBeGreaterThan(0);
      expect(item.battery.capacityMah).toBeGreaterThan(2000);
      expect(item.cameras.mainMp).toBeGreaterThan(0);
      expect(item.network.gnss.length).toBeGreaterThanOrEqual(4);
      expect(Object.keys(item.sensors.simulatable).length).toBe(12);
      expect(item.sizing.ramMb).toBeGreaterThan(0);
      expect(item.avd.device).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('uses the smallest sold storage SKU rather than an invented capacity', () => {
    for (const item of PHONES) {
      if (item.identity.realDevice) {
        expect(item.storage.virtualDiskBytes).toBe(Math.min(...item.performance.storageOptionsGb) * 1_000_000_000);
      }
      // Free space inside Android is always smaller than the disk it lives on.
      expect(item.storage.freeInsideBytes).toBeLessThan(item.storage.virtualDiskBytes);
      expect(item.storage.freeInsideBytes).toBeGreaterThan(0);
      expect(item.storage.imageDownloadBytes).toBeGreaterThan(500_000_000);
    }
    // A 1 TB option remains in the catalogue, while the VM starts from the
    // smallest real retail SKU instead of inventing a tiny 48 GB phone.
    const ultra = phone('galaxy-s24-ultra')!;
    expect(ultra.storage.advertisedStorageGb).toBe(1024);
    expect(ultra.sizing.storageGb).toBe(Math.min(...ultra.performance.storageOptionsGb));
  });

  it('uses the real panel resolution and density in the faithful preset', () => {
    for (const item of PHONES) {
      expect(item.display.emulatorWidth).toBe(item.display.width);
      expect(item.display.emulatorHeight).toBe(item.display.height);
      expect(item.display.emulatorDpi).toBe(Math.round(item.display.ppi));
      expect(item.sizing.width).toBe(item.display.width);
    }
    const ultra = phone('galaxy-s24-ultra')!;
    expect(ultra.display.width).toBe(1440);
    expect(ultra.display.emulatorWidth).toBe(1440);
  });

  it('starts real handsets from a genuine retail RAM, CPU and storage SKU', () => {
    for (const item of PHONES.filter((phone) => phone.identity.realDevice)) {
      expect(item.sizing.ramMb).toBe(Math.min(...item.performance.ramOptionsGb) * 1024);
      expect(item.sizing.storageGb).toBe(Math.min(...item.performance.storageOptionsGb));
      expect(item.sizing.cpus).toBe(item.performance.cpuCores);
      expect(item.avd.ramMb).toBe(item.sizing.ramMb);
      expect(item.avd.dataGb).toBe(item.sizing.storageGb);
    }
  });

  it('filters the grid the same way the UI does', () => {
    expect(filterPhones(PHONES, { brand: 'Nothing' }).every((item) => item.identity.manufacturer === 'Nothing')).toBe(true);
    expect(filterPhones(PHONES, { foldable: 'foldable' }).every((item) => ['foldable', 'flip'].includes(item.identity.category))).toBe(true);
    expect(filterPhones(PHONES, { foldable: 'bar' }).some((item) => item.identity.category === 'flip')).toBe(false);
    expect(filterPhones(PHONES, { search: 'tensor' }).every((item) => item.performance.chipset.toLowerCase().includes('tensor'))).toBe(true);
    expect(filterPhones(PHONES, { minRamGb: 16 }).every((item) => Math.max(...item.performance.ramOptionsGb) >= 16)).toBe(true);
    expect(filterPhones(PHONES, { maxHostRamGb: 8 }).every((item) => item.sizing.hostRamGb <= 8)).toBe(true);
    expect(filterPhones(PHONES, { brand: 'Nope' })).toEqual([]);
    expect(COMPARE_LIMIT).toBe(4);
  });

  it('summarises a creation for the AVD the handset maps to', () => {
    const spec = phone('pixel-8')!;
    const avd = creationSummary(spec);
    expect(avd.profile).toBe(spec.avd.device);
    expect(avd.image).toMatch(/^system-images;android-\d+;/);
    // Play Store images are production builds: the summary never promises root for them.
    expect(avd.playStore).toBe(true);
    expect(avd.root).toBe(false);
    expect(avd.downloadBytes).toBe(spec.storage.imageDownloadBytes);
    expect(avd.diskBytes).toBe(spec.storage.virtualDiskBytes);
    expect(avd.freeInsideBytes).toBe(spec.storage.freeInsideBytes);
    expect(avd.hostRamGb).toBeGreaterThanOrEqual(8);
    expect(Object.keys(avd)).not.toContain('backend');
  });
});

describe('lightweight image variants', () => {
  it('offers genuinely smaller systems, not just different labels', () => {
    const spec = phone('pixel-8')!;
    const full = applyVariant(spec, 'play');
    const go = applyVariant(spec, 'go');
    const legacy = applyVariant(spec, 'legacy');
    const aosp = applyVariant(spec, 'aosp');
    for (const light of [go, legacy, aosp]) {
      expect(light.downloadBytes).toBeLessThan(full.downloadBytes);
      expect(light.diskBytes).toBeLessThan(full.diskBytes);
      expect(light.ramMb).toBeLessThanOrEqual(full.ramMb);
      expect(light.freeInsideBytes).toBeGreaterThan(0);
      expect(light.freeInsideBytes).toBeLessThan(light.diskBytes);
    }
    // The smallest profile really is a few GB, not tens of GB.
    expect(legacy.diskBytes).toBeLessThanOrEqual(4_000_000_000);
    expect(legacy.api).toBe(30);
    expect(aosp.googleApps).toBe(false);
    expect(go.playStore).toBe(true);
    expect(IMAGE_VARIANTS.map((item) => item.id)).toEqual(['play', 'gapps', 'aosp', 'go', 'legacy']);
  });

  it('feeds the variant through to the creation summary and SDK package', () => {
    const spec = phone('galaxy-s24')!;
    const summary = creationSummary(spec, 'aosp');
    expect(summary.variant).toBe('aosp');
    expect(summary.image).toContain(';default;');
    expect(summary.playStore).toBe(false);
    expect(summary.storageGb).toBe(8);
    const playSummary = creationSummary(spec, 'play');
    expect(playSummary.image).toContain('google_apis_playstore');
    expect(playSummary.diskBytes).toBeGreaterThan(summary.diskBytes);
    // An unknown id falls back to the full profile instead of failing.
    expect(creationSummary(spec, 'nonsense').variant).toBe('play');
  });
});
