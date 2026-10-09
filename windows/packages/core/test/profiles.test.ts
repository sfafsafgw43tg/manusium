/** packages/core/test/profiles.test.ts - profile CRUD, isolation layout, vault, encrypted export. */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DataLayout, DecryptionError, ProfileKind, ProfileManager, ProfileData, RESTORED_ENTRY_FILE,
  defaultProfile, generateKey, generateMnemonic, isProfileTheme, isValidMnemonic, sanitizeProfile, privateBrowsingPatch, privateBrowsingStamp, mobileEmulationFor,
} from '../src';
import { FAST_KDF, tmpDir } from './helpers';

const NAMES: Record<ProfileKind, string> = {
  antidetect: 'Antidetect', phone: 'Telefon', personal: 'Osobisty', work: 'Praca', private: 'Prywatny', testing: 'Testy', temporary: 'Tymczasowy', tor: 'Tor', custom: 'Własny',
};

function setup() {
  const layout = new DataLayout(path.join(tmpDir(), 'OctoBrowser'));
  layout.ensure();
  const pm = new ProfileManager(layout, undefined, FAST_KDF);
  pm.ensureDefaults(NAMES);
  return { layout, pm };
}

describe('ProfileManager', () => {
  it('creates the default set with separate data folders', () => {
    const { layout, pm } = setup();
    const kinds = pm.list().map((p) => p.kind);
    expect(kinds).toEqual(['personal', 'work', 'private', 'testing', 'temporary', 'tor']);
    const dirs = new Set(pm.list().map((p) => layout.profileEngineDir(p.id)));
    expect(dirs.size).toBe(6);
    for (const d of dirs) expect(fs.existsSync(d)).toBe(true);
    for (const profile of pm.list()) {
      const classicPromptDefault = !['private', 'temporary', 'tor'].includes(profile.kind);
      expect(profile.sandbox.camera).toBe(classicPromptDefault);
      expect(profile.sandbox.microphone).toBe(classicPromptDefault);
      const embeddedBrowser = profile.kind !== 'tor';
      expect(profile.browserShell).toBe(embeddedBrowser ? 'chrome' : 'octo');
      expect(profile.baseChromeLook).toBe(embeddedBrowser);
      expect(profile.ordinaryBrowser).toBe(true);
    }
  });

  it('applies kind-specific defaults (Tor: no add-ons, Temporary: delete on close)', () => {
    const { pm } = setup();
    const tor = pm.list().find((p) => p.kind === 'tor')!;
    expect(tor.addons).toEqual([]);
    expect(tor.protection.level).toBe('tor');
    expect(pm.list().find((p) => p.kind === 'temporary')!.deleteOnClose).toBe(true);
    // Tor profile can never get add-ons, even via update
    expect(pm.update(tor.id, { addons: ['adblock'] }).addons).toEqual([]);
  });

  it('stores a truthful browser-shell selection and maps old Chrome-look patches', () => {
    const { pm } = setup();
    const p = pm.create({ name: 'Shell', kind: 'custom', patch: { browserShell: 'chromium', searchEngine: 'duckduckgo-noai' } });
    expect(p.browserShell).toBe('chromium');
    expect(p.searchEngine).toBe('duckduckgo-noai');
    expect(p.baseChromeLook).toBe(true);
    expect(pm.update(p.id, { baseChromeLook: false }).browserShell).toBe('octo');
    expect(pm.update(p.id, { browserShell: 'safari' }).browserShell).toBe('safari');
    expect(pm.update(p.id, { searchEngine: 'startpage' }).searchEngine).toBe('startpage');
    expect(sanitizeProfile({ id: 'p-abcdef123499', kind: 'custom', name: 'Legacy', baseChromeLook: true }).browserShell).toBe('chrome');
    expect(sanitizeProfile({ id: 'p-abcdef123499', kind: 'custom', name: 'Legacy', searchEngine: 'invalid-engine' as any }).searchEngine).toBeUndefined();
  });

  it('persists engine privacy settings independently for Chromium and Firefox profiles', () => {
    const { pm } = setup();
    const chromium = pm.create({ name: 'Chromium privacy', kind: 'custom', patch: { engine: 'inkbrowser', enginePrivacy: { chromium: { webRtc: 'disable-non-proxied-udp', location: 'block', webgl: 'disable' }, firefox: { webRtc: 'default', location: 'ask', resistFingerprinting: false, webgl: 'allow' } } } });
    const firefox = pm.create({ name: 'Firefox privacy', kind: 'custom', patch: { engine: 'firefox', enginePrivacy: { chromium: { webRtc: 'default', location: 'ask', webgl: 'allow' }, firefox: { webRtc: 'disabled', location: 'block', resistFingerprinting: true, webgl: 'disable' } } } });
    expect(pm.get(chromium.id).enginePrivacy.chromium.webRtc).toBe('disable-non-proxied-udp');
    expect(pm.get(firefox.id).enginePrivacy.firefox.resistFingerprinting).toBe(true);
    expect(pm.get(chromium.id).enginePrivacy.firefox.resistFingerprinting).toBe(false);
    expect(pm.get(chromium.id).enginePrivacy.chromium.webgl).toBe('disable');
    expect(pm.get(firefox.id).enginePrivacy.firefox.webgl).toBe('disable');
  });

  it('persists a custom profile directory without affecting another profile', () => {
    const { layout, pm } = setup();
    const external = path.join(tmpDir(), 'profiles', 'custom-one');
    const first = pm.create({ name: 'External', kind: 'custom', patch: { profileDirectory: external } });
    const second = pm.create({ name: 'Default', kind: 'custom' });
    expect(layout.profileDir(first.id)).toBe(path.resolve(external));
    expect(layout.profileDir(second.id)).toBe(path.join(layout.profiles, second.id));
    const reopened = new ProfileManager(layout, undefined, FAST_KDF);
    expect(reopened.get(first.id).profileDirectory).toBe(path.resolve(external));
    expect(layout.profileEngineDir(first.id)).toBe(path.join(path.resolve(external), 'engine'));
  });

  it('persists App window and Smart paste settings independently per profile', () => {
    const { layout, pm } = setup();
    const app = pm.create({ name: 'App mode', kind: 'custom', patch: { appMode: true, smartPaste: false } });
    const normal = pm.create({ name: 'Normal mode', kind: 'custom', patch: { appMode: false, smartPaste: true } });
    expect(pm.get(app.id).appMode).toBe(true);
    expect(pm.get(app.id).smartPaste).toBe(false);
    expect(pm.get(normal.id).appMode).toBe(false);
    expect(pm.get(normal.id).smartPaste).toBe(true);
    const reopened = new ProfileManager(layout, undefined, FAST_KDF);
    expect(reopened.get(app.id).appMode).toBe(true);
    expect(reopened.get(app.id).smartPaste).toBe(false);
  });

  it('persists Ordinary browser mode independently and keeps antidetect profiles opt-in', () => {
    const { layout, pm } = setup();
    const ordinary = pm.create({ name: 'Ordinary', kind: 'custom', patch: { ordinaryBrowser: true } });
    const configured = pm.create({ name: 'Configured', kind: 'antidetect', patch: { ordinaryBrowser: false } });
    expect(ordinary.ordinaryBrowser).toBe(true);
    expect(configured.ordinaryBrowser).toBe(false);
    const reopened = new ProfileManager(layout, undefined, FAST_KDF);
    expect(reopened.get(ordinary.id).ordinaryBrowser).toBe(true);
    expect(reopened.get(configured.id).ordinaryBrowser).toBe(false);
  });

  it('persists manual profile order and moves only the requested subset', () => {
    const { layout, pm } = setup();
    const first = pm.create({ name: 'First', kind: 'custom', patch: { tags: ['keep'] } });
    const second = pm.create({ name: 'Second', kind: 'custom', patch: { tags: ['move'] } });
    const third = pm.create({ name: 'Third', kind: 'custom', patch: { tags: ['keep'] } });
    pm.reorder([third.id, first.id]);
    const reopened = new ProfileManager(layout, undefined, FAST_KDF);
    const selected = reopened.list().filter((p) => [first.id, second.id, third.id].includes(p.id)).sort((a, b) => a.sortOrder - b.sortOrder);
    expect(selected.map((p) => p.id)).toEqual([third.id, first.id, second.id]);
  });

  it('enables the encrypted login vault by default for regular browser profiles', () => {
    const { pm } = setup();
    const p = pm.create({ name: 'Credentials', kind: 'custom' });
    expect(p.savePasswords).toBe(true);
    expect(pm.update(p.id, { savePasswords: false }).savePasswords).toBe(false);
    expect(pm.list().find((profile) => profile.kind === 'personal')?.savePasswords).toBe(true);
    expect(pm.list().find((profile) => profile.kind === 'private')?.savePasswords).toBe(false);
    expect(sanitizeProfile({ id: 'p-abcdef123498', kind: 'custom', name: 'Imported', savePasswords: 'yes' as never }).savePasswords).toBe(true);
  });

  it('promotes old regular profiles once without undoing a later opt-out', () => {
    const layout = new DataLayout(path.join(tmpDir(), 'OctoBrowser'));
    layout.ensure();
    const initial = new ProfileManager(layout, undefined, FAST_KDF);
    const legacy = defaultProfile('personal', 'Legacy');
    legacy.savePasswords = false;
    initial.store.save({ schema: 1, profiles: [legacy], passwordDefaultsVersion: 0 });

    const migrated = new ProfileManager(layout, undefined, FAST_KDF);
    expect(migrated.get(legacy.id).savePasswords).toBe(true);
    expect(migrated.store.load().passwordDefaultsVersion).toBe(1);
    migrated.update(legacy.id, { savePasswords: false });
    expect(new ProfileManager(layout, undefined, FAST_KDF).get(legacy.id).savePasswords).toBe(false);
  });

  it('promotes classic media prompts once without weakening private profiles or undoing opt-out', () => {
    const layout = new DataLayout(path.join(tmpDir(), 'OctoBrowser'));
    layout.ensure();
    const initial = new ProfileManager(layout, undefined, FAST_KDF);
    const personal = defaultProfile('personal', 'Legacy personal');
    const privateProfile = defaultProfile('private', 'Legacy private');
    personal.sandbox.camera = false;
    personal.sandbox.microphone = false;
    initial.store.save({
      schema: 1,
      profiles: [personal, privateProfile],
      passwordDefaultsVersion: 1,
      mediaPermissionDefaultsVersion: 0,
    });

    const migrated = new ProfileManager(layout, undefined, FAST_KDF);
    expect(migrated.get(personal.id).sandbox.camera).toBe(true);
    expect(migrated.get(personal.id).sandbox.microphone).toBe(true);
    expect(migrated.get(privateProfile.id).sandbox.camera).toBe(false);
    expect(migrated.store.load().mediaPermissionDefaultsVersion).toBe(1);
    migrated.update(personal.id, { sandbox: { ...migrated.get(personal.id).sandbox, camera: false, microphone: false } });
    const reopened = new ProfileManager(layout, undefined, FAST_KDF);
    expect(reopened.get(personal.id).sandbox.camera).toBe(false);
    expect(reopened.get(personal.id).sandbox.microphone).toBe(false);
  });

  it('upgrades legacy profile security once and preserves later user changes', () => {
    const layout = new DataLayout(path.join(tmpDir(), 'OctoBrowser'));
    layout.ensure();
    const initial = new ProfileManager(layout, undefined, FAST_KDF);
    const legacyProxy = defaultProfile('custom', 'Legacy proxy');
    legacyProxy.network = { mode: 'proxy', proxyRules: 'socks5://127.0.0.1:1080', lockdown: false };
    const legacyPrivate = defaultProfile('private', 'Legacy private');
    legacyPrivate.protection = { level: 'normal' };
    legacyPrivate.deleteOnClose = false;
    legacyPrivate.keepHistory = true;
    legacyPrivate.restoreSession = true;
    initial.store.save({ schema: 1, profiles: [legacyProxy, legacyPrivate], passwordDefaultsVersion: 1, mediaPermissionDefaultsVersion: 1, securityDefaultsVersion: 0 });

    const migrated = new ProfileManager(layout, undefined, FAST_KDF);
    expect(migrated.get(legacyProxy.id).network.lockdown).toBe(true);
    expect(migrated.get(legacyPrivate.id).protection.level).toBe('strict');
    expect(migrated.get(legacyPrivate.id).deleteOnClose).toBe(true);
    expect(migrated.get(legacyPrivate.id).keepHistory).toBe(false);
    expect(migrated.get(legacyPrivate.id).restoreSession).toBe(false);
    expect(migrated.store.load().securityDefaultsVersion).toBe(1);

    migrated.update(legacyProxy.id, { network: { ...migrated.get(legacyProxy.id).network, lockdown: false } });
    const reopened = new ProfileManager(layout, undefined, FAST_KDF);
    expect(reopened.get(legacyProxy.id).network.lockdown).toBe(false);
  });

  it('migrates saved capture selections into enabled device classes', () => {
    const migrated = sanitizeProfile({
      id: 'p-abcdef123496', kind: 'custom', name: 'Camera profile',
      sandbox: { camera: false, microphone: false },
      mediaCapture: { cameraLabel: 'Realme 12 Pro', microphoneLabel: 'CABLE Output' },
    });
    expect(migrated.mediaCapture).toEqual({ cameraLabel: 'Realme 12 Pro', microphoneLabel: 'CABLE Output' });
    expect(migrated.sandbox.camera).toBe(true);
    expect(migrated.sandbox.microphone).toBe(true);
  });

  it('keeps download destinations profile-scoped and asks by default', () => {
    const { pm } = setup();
    const first = pm.create({ name: 'Downloads A', kind: 'custom' });
    const second = pm.create({ name: 'Downloads B', kind: 'custom' });
    expect(first.downloads).toEqual({ askWhereToSave: true, defaultDirectory: '', lastDirectory: '' });
    const changed = pm.update(first.id, { downloads: { askWhereToSave: false, defaultDirectory: 'C:\\Users\\A\\Downloads', lastDirectory: 'D:\\Last' } });
    expect(changed.downloads.askWhereToSave).toBe(false);
    expect(changed.downloads.lastDirectory).toBe('D:\\Last');
    expect(pm.get(second.id).downloads).toEqual({ askWhereToSave: true, defaultDirectory: '', lastDirectory: '' });
    const damaged = sanitizeProfile({ id: 'p-abcdef123497', kind: 'custom', name: 'Imported', downloads: {
      askWhereToSave: 'no', defaultDirectory: 'C:\\Bad\u0000Folder', lastDirectory: 42,
    } });
    expect(damaged.downloads).toEqual({ askWhereToSave: true, defaultDirectory: 'C:\\BadFolder', lastDirectory: '' });
  });

  it('create / update / duplicate / remove / reset', () => {
    const { layout, pm } = setup();
    const c = pm.create({ name: 'Klient ŻÓŁW', kind: 'custom' });
    pm.update(c.id, { protection: { level: 'strict' }, network: { mode: 'proxy', proxyRules: 'socks5://127.0.0.1:1080' } });
    expect(pm.get(c.id).network.proxyRules).toBe('socks5://127.0.0.1:1080');
    fs.writeFileSync(path.join(layout.profileEngineDir(c.id), 'Cookies'), 'cookie-db');
    const d = pm.duplicate(c.id, 'Kopia', true);
    expect(fs.readFileSync(path.join(layout.profileEngineDir(d.id), 'Cookies'), 'utf8')).toBe('cookie-db');
    pm.reset(d.id);
    expect(fs.existsSync(path.join(layout.profileEngineDir(d.id), 'Cookies'))).toBe(false);
    pm.remove(c.id);
    expect(() => pm.get(c.id)).toThrow();
    expect(fs.existsSync(layout.profileDir(c.id))).toBe(false);
  });

  it('keeps removed profiles in local Trash until they are explicitly erased', () => {
    const { layout, pm } = setup();
    const p = pm.create({ name: 'Recover me', kind: 'custom' });
    fs.writeFileSync(path.join(layout.profileEngineDir(p.id), 'Cookies'), 'kept');
    pm.trash(p.id);
    expect(pm.list().some((x) => x.id === p.id)).toBe(false);
    expect(pm.listTrash()).toMatchObject([{ id: p.id, name: 'Recover me' }]);
    expect(() => pm.get(p.id)).toThrow();
    expect(fs.readFileSync(path.join(layout.profileEngineDir(p.id), 'Cookies'), 'utf8')).toBe('kept');
    expect(pm.restore(p.id).name).toBe('Recover me');
    expect(pm.get(p.id).trashedAt).toBeUndefined();
    pm.trash(p.id);
    expect(pm.emptyTrash()).toBe(1);
    expect(fs.existsSync(layout.profileDir(p.id))).toBe(false);
  });

  it('refuses credentials inside proxy rules (they belong to the encrypted secret store)', () => {
    const { pm } = setup();
    const c = pm.create({ name: 'X', kind: 'custom' });
    expect(() => pm.update(c.id, { network: { mode: 'proxy', proxyRules: 'http://user:pass@proxy:8080' } })).toThrow();
  });

  it('cleans temporary profiles', () => {
    const { layout, pm } = setup();
    const tmp = pm.list().find((p) => p.kind === 'temporary')!;
    fs.writeFileSync(path.join(layout.profileEngineDir(tmp.id), 'Local Storage'), 'x');
    expect(pm.cleanupEphemeral()).toContain(tmp.id);
    expect(fs.readdirSync(layout.profileEngineDir(tmp.id))).toEqual([]);
  });

  it('vault: seal encrypts engine data, a wrong 12-word phrase is rejected, open restores data', async () => {
    const { layout, pm } = setup();
    const p = pm.list()[0];
    const { passphrase, key } = await pm.createVault(p.id);
    expect(isValidMnemonic(passphrase)).toBe(true);
    expect(passphrase.split(' ')).toHaveLength(12);
    fs.mkdirSync(path.join(layout.profileEngineDir(p.id), 'Local Storage'), { recursive: true });
    fs.writeFileSync(path.join(layout.profileEngineDir(p.id), 'Local Storage', 'leveldb'), 'PRIVATE-DATA');
    fs.mkdirSync(path.join(layout.profileEngineDir(p.id), 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(layout.profileEngineDir(p.id), 'Cache', 'x'), 'cache');
    pm.sealVault(p.id, key);
    expect(pm.isVaultLocked(p.id)).toBe(true);
    expect(fs.readdirSync(layout.profileEngineDir(p.id))).toEqual([]);
    expect(fs.readFileSync(layout.profileVaultFile(p.id)).toString('latin1')).not.toContain('PRIVATE-DATA');
    await expect(pm.deriveVaultKey(p.id, generateMnemonic())).rejects.toBeInstanceOf(DecryptionError);
    // Sloppy typing (case, extra spaces and line breaks) must still open it.
    const key2 = await pm.deriveVaultKey(p.id, `  ${passphrase.toUpperCase().split(' ').join('\n ')} `);
    pm.openVault(p.id, key2);
    expect(fs.readFileSync(path.join(layout.profileEngineDir(p.id), 'Local Storage', 'leveldb'), 'utf8')).toBe('PRIVATE-DATA');
    expect(fs.existsSync(path.join(layout.profileEngineDir(p.id), 'Cache'))).toBe(false); // caches discarded
  });

  it('export is always encrypted with 12 words; import recovers it as a new profile', async () => {
    const { layout, pm } = setup();
    const p = pm.list()[1];
    fs.writeFileSync(path.join(layout.profileEngineDir(p.id), 'Cookies'), 'COOKIE-SECRET');
    const out = path.join(layout.root, 'export ą.obprofile');
    const phrase = generateMnemonic();
    // Anything that is not a valid 12-word phrase is refused outright.
    await expect(pm.exportEncrypted(p.id, 'weak', out)).rejects.toThrow();
    await expect(pm.exportEncrypted(p.id, 'Eksport hasło 99!', out)).rejects.toThrow();
    await pm.exportEncrypted(p.id, phrase, out);
    expect(fs.readFileSync(out).toString('latin1')).not.toContain('COOKIE-SECRET');
    await expect(pm.importEncrypted(out, generateMnemonic())).rejects.toBeInstanceOf(DecryptionError);
    const imported = await pm.importEncrypted(out, phrase);
    expect(imported.id).not.toBe(p.id);
    expect(fs.readFileSync(path.join(layout.profileEngineDir(imported.id), 'Cookies'), 'utf8')).toBe('COOKIE-SECRET');
  });

  it('backs up several profiles into one encrypted file and imports them elsewhere', async () => {
    // The cross-computer path: one file, one phrase, every chosen profile.
    const source = setup();
    const target = setup();
    const [first, second] = source.pm.list();
    fs.writeFileSync(path.join(source.layout.profileEngineDir(first.id), 'Cookies'), 'FIRST-COOKIE');
    fs.writeFileSync(path.join(source.layout.profileEngineDir(second.id), 'Login Data'), 'SECOND-LOGIN');
    const out = path.join(source.layout.root, 'whole backup.octobackup');
    const phrase = generateMnemonic();

    await expect(source.pm.exportBundle([], phrase, out)).rejects.toThrow();
    await expect(source.pm.exportBundle([first.id, second.id], 'weak', out)).rejects.toThrow();
    const result = await source.pm.exportBundle([first.id, second.id], phrase, out, true);
    expect(result.profiles).toBe(2);
    const raw = fs.readFileSync(out).toString('latin1');
    expect(raw).not.toContain('FIRST-COOKIE');
    expect(raw).not.toContain('SECOND-LOGIN');

    // The manifest can be inspected without importing anything.
    const info = await target.pm.inspectBundle(out, phrase);
    expect(info.profiles.map((item) => item.name)).toEqual([first.name, second.name]);
    await expect(target.pm.inspectBundle(out, generateMnemonic())).rejects.toBeInstanceOf(DecryptionError);

    // Import creates NEW profiles and never touches the ones already there.
    const before = target.pm.list().length;
    const created = await target.pm.importBundle(out, phrase);
    expect(created).toHaveLength(2);
    expect(target.pm.list().length).toBe(before + 2);
    expect(fs.readFileSync(path.join(target.layout.profileEngineDir(created[0].id), 'Cookies'), 'utf8')).toBe('FIRST-COOKIE');
    expect(fs.readFileSync(path.join(target.layout.profileEngineDir(created[1].id), 'Login Data'), 'utf8')).toBe('SECOND-LOGIN');
    // The same file can be imported again without replacing the first copy.
    const again = await target.pm.importBundle(out, phrase);
    expect(again[0].id).not.toBe(created[0].id);
  });

  it('backs up profile settings without browser data when asked to', async () => {
    const source = setup();
    const target = setup();
    const p = source.pm.list()[0];
    fs.writeFileSync(path.join(source.layout.profileEngineDir(p.id), 'Cookies'), 'SKIP-ME');
    const out = path.join(source.layout.root, 'settings only.octobackup');
    const phrase = generateMnemonic();
    await source.pm.exportBundle([p.id], phrase, out, false);
    const [created] = await target.pm.importBundle(out, phrase);
    expect(created.name).toBe(p.name);
    expect(created.kind).toBe(p.kind);
    expect(fs.existsSync(path.join(target.layout.profileEngineDir(created.id), 'Cookies'))).toBe(false);
  });

  it('profile data (bookmarks/history) is encrypted per profile', () => {
    const { layout, pm } = setup();
    const key = generateKey();
    const [a, b] = pm.list();
    const da = new ProfileData(layout, a.id, () => key);
    const db = new ProfileData(layout, b.id, () => key);
    da.bookmarks.save([{ id: '1', title: 'Bank', url: 'https://bank.example/', createdAt: '' }]);
    expect(db.bookmarks.load()).toEqual([]);
    expect(fs.readFileSync(layout.profileDataFile(a.id, 'bookmarks'), 'utf8')).not.toContain('bank.example');
  });

  it('sanitizeProfile rejects bad ids (path traversal)', () => {
    expect(() => sanitizeProfile({ id: '../x', kind: 'custom', name: 'x' })).toThrow();
  });

  it('stores the chosen chrome theme and optional Chrome-style controls safely', () => {
    const { pm } = setup();
    for (const p of pm.list()) {
      expect(['dark', 'light']).toContain(p.theme);
      expect(p.baseChromeLook).toBe(p.kind !== 'tor');
    }
    const p = pm.create({ name: 'Motyw', kind: 'custom', patch: { theme: 'light', baseChromeLook: true } });
    expect(pm.get(p.id)).toMatchObject({ theme: 'light', baseChromeLook: true });
    // Unknown theme values and non-boolean imported look values fall back safely.
    const patched = pm.update(p.id, { theme: 'neon' as never, baseChromeLook: 'yes' as never });
    expect(patched.theme).toBe('dark');
    expect(patched.baseChromeLook).toBe(false);
    expect(isProfileTheme(patched.theme)).toBe(true);
  });
  it('creates a Phone profile with a virtual Android browser and supports iOS/Android handsets', () => {
    const { pm } = setup();
    const p = pm.create({ name: 'Telefon', kind: 'phone' });
    expect(p.mobile).toEqual({ device: 'pixel-8', orientation: 'portrait' });
    const edited = pm.update(p.id, { mobile: { device: 'pixel-8', orientation: 'landscape' } });
    expect(edited.mobile).toEqual({ device: 'pixel-8', orientation: 'landscape' });
    const device = mobileEmulationFor(edited.mobile, '140.0.0.0')!;
    expect(device).toMatchObject({ id: 'pixel-8', os: 'android', width: 915, height: 412, platform: 'Linux armv8l' });
    expect(device.userAgent).toContain('Android 14');
    const versioned = pm.update(p.id, { mobile: { device: 'pixel-8', orientation: 'portrait', osVersion: '15' } });
    expect(mobileEmulationFor(versioned.mobile, '140.0.0.0')?.userAgent).toContain('Android 15');
    // Edited/damaged metadata never introduces an arbitrary user agent/device.
    expect(pm.update(p.id, { mobile: { device: 'not-a-device' as never, orientation: 'sideways' as never } }).mobile).toEqual({ device: 'none', orientation: 'portrait' });
  });

  it('adopts a profile entry restored by restore-profile.bat (entry deleted from the list)', () => {
    const { layout, pm } = setup();
    const p = pm.create({ name: 'Bank – Łódź', kind: 'custom' });
    const entry = JSON.stringify(pm.get(p.id));
    // Simulate: profile deleted, then its data folder restored from an archive by the script.
    pm.remove(p.id);
    fs.mkdirSync(layout.profileEngineDir(p.id), { recursive: true });
    fs.writeFileSync(path.join(layout.profileEngineDir(p.id), 'Cookies'), 'x');
    fs.writeFileSync(path.join(layout.profileDir(p.id), RESTORED_ENTRY_FILE), `\uFEFF${entry}`);
    const r = pm.adoptRestoredEntries();
    expect(r.adopted.map((x) => x.id)).toEqual([p.id]);
    expect(r.rejected).toEqual([]);
    expect(pm.get(p.id).name).toBe('Bank – Łódź');
    expect(pm.get(p.id).encrypted).toBe(false); // no vault on disk
    expect(fs.existsSync(path.join(layout.profileDir(p.id), RESTORED_ENTRY_FILE))).toBe(false);
    // Running again changes nothing.
    expect(pm.adoptRestoredEntries().adopted).toEqual([]);
  });

  it('rejects tampered restore markers and never adopts them', () => {
    const { layout, pm } = setup();
    const before = pm.list().length;
    const bad = [
      ['p-aaaaaa000001', JSON.stringify({ id: 'p-bbbbbb000002', kind: 'custom', name: 'mismatch' })],
      ['p-aaaaaa000003', JSON.stringify({ id: 'p-aaaaaa000003', kind: 'custom', name: 'x', network: { mode: 'proxy', proxyRules: 'http://user:pass@proxy:8080' } })],
      ['p-aaaaaa000004', '{ not json'],
      ['p-aaaaaa000005', JSON.stringify({ id: 'p-aaaaaa000005', kind: 'root', name: 'x' })],
    ];
    for (const [dir, content] of bad) {
      fs.mkdirSync(layout.profileDir(dir), { recursive: true });
      fs.writeFileSync(path.join(layout.profileDir(dir), RESTORED_ENTRY_FILE), content);
    }
    const r = pm.adoptRestoredEntries();
    expect(r.adopted).toEqual([]);
    expect(r.rejected.sort()).toEqual(bad.map(([d]) => d).sort());
    expect(pm.list().length).toBe(before);
    for (const [dir] of bad) expect(fs.existsSync(path.join(layout.profileDir(dir), `${RESTORED_ENTRY_FILE}.rejected`))).toBe(true);
  });

  it('private browsing is a throw-away temporary profile that keeps nothing', () => {
    const { pm } = setup();
    const p = pm.create({ name: `Prywatne ${privateBrowsingStamp(new Date(2026, 8, 25, 14, 3))}`, kind: 'temporary', patch: privateBrowsingPatch() });
    expect(p.kind).toBe('temporary');
    expect(p.name).toBe('Prywatne 2026-09-25 14:03');
    expect(p.deleteOnClose).toBe(true);
    expect(p.keepHistory).toBe(false);
    expect(p.restoreSession).toBe(false);
    expect(p.protection.level).toBe('strict');
    expect(p.protection.overrides?.clearOnExit).toBe(true);
    expect(p.protection.overrides?.blockThirdPartyCookies).toBe(true);
    // Privacy policy is identical, but each newly created profile has its own
    // stable fingerprint so separate private sessions are not linkable.
    const q = pm.create({ name: 'Prywatne 2026-09-25 15:00', kind: 'temporary', patch: privateBrowsingPatch() });
    expect(q.fingerprint.seed).not.toBe(p.fingerprint.seed);
    expect({ ...q, fingerprint: p.fingerprint, sortOrder: 0, id: '', name: '', createdAt: '', updatedAt: '' }).toEqual({ ...p, sortOrder: 0, id: '', name: '', createdAt: '', updatedAt: '' });
  });

  it('accepts a settings patch from the create dialog', () => {
    const { pm } = setup();
    const p = pm.create({
      name: 'Z patchiem', kind: 'custom',
      patch: {
        protection: { level: 'strict', overrides: { canvas: 'block-readback' } }, keepHistory: false, deleteOnClose: true,
        mediaCapture: { cameraLabel: 'OBS Virtual Camera', microphoneLabel: 'USB Microphone' },
      },
    });
    expect(p.name).toBe('Z patchiem');
    expect(p.kind).toBe('custom');
    expect(p.protection).toEqual({ level: 'strict', overrides: { canvas: 'block-readback' } });
    expect(p.keepHistory).toBe(false);
    expect(p.deleteOnClose).toBe(true);
    expect(p.mediaCapture).toEqual({ cameraLabel: 'OBS Virtual Camera', microphoneLabel: 'USB Microphone' });
    expect(pm.get(p.id).network.mode).toBe('system'); // untouched defaults survive
  });

  it('does not duplicate a profile whose entry still exists', () => {
    const { layout, pm } = setup();
    const p = pm.list()[0];
    fs.writeFileSync(path.join(layout.profileDir(p.id), RESTORED_ENTRY_FILE), JSON.stringify({ ...p, name: 'Changed' }));
    const r = pm.adoptRestoredEntries();
    expect(r.adopted).toEqual([]);
    expect(pm.get(p.id).name).toBe(p.name); // current settings win
    expect(pm.list().filter((x) => x.id === p.id).length).toBe(1);
  });
});
