/**
 * packages/shell/test/context-unlock.test.ts
 *
 * Smoke test of the real startup sequence (packages/shell/src/context.ts) with
 * a stubbed Electron. It proves the wiring, not the GUI:
 *
 *   DPAPI mode      -> startApp() opens without any window;
 *   password mode   -> startApp() shows the master-password window and returns
 *                      null until the CORRECT password is submitted;
 *   wrong password  -> the keyring stays locked and the app does not continue;
 *   "forgot"        -> the old key is quarantined and the app continues with a
 *                      new one (secrets become unreadable, as documented).
 *
 * electron is mocked, so this runs on Linux/macOS too (CI + local).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------- electron mock
interface Handler {
  channel: string;
  fn: (e: unknown, ...args: unknown[]) => unknown;
}
const handlers = new Map<string, Handler>();
const createdWindows: FakeWindow[] = [];
let trustedId = 0;
/** Button the mocked dialog.showMessageBoxSync "presses" (0 = recover, 2 = quit). */
export const dialogState = { answer: 2 };

class FakeWebContents {
  id = ++trustedId;
  private listeners = new Map<string, Array<() => void>>();
  on(ev: string, fn: () => void): this { this.listeners.set(ev, [...(this.listeners.get(ev) ?? []), fn]); return this; }
  once(ev: string, fn: () => void): this { return this.on(ev, fn); }
  emit(ev: string): void { for (const fn of this.listeners.get(ev) ?? []) fn(); }
  send(): void { /* nothing to send in the test */ }
  async loadFile(): Promise<void> { /* nothing to load */ }
  async executeJavaScript(): Promise<boolean> { return true; }
}
class FakeWindow {
  webContents = new FakeWebContents();
  destroyed = false;
  constructor(public opts: Record<string, unknown>) { createdWindows.push(this); }
  isDestroyed(): boolean { return this.destroyed; }
  close(): void { this.destroyed = true; this.webContents.emit('closed'); }
  once(): void { /* noop */ }
  on(): this { return this; }
  async loadFile(): Promise<void> { /* noop */ }
  show(): void { /* noop */ }
}

/** Fake DPAPI: base64 with a marker, "refuses" when the marker says so. */
const safeStorage = {
  isEncryptionAvailable: () => true,
  // A real backend name (not "basic_text") so the Linux CI run behaves like Windows DPAPI.
  getSelectedStorageBackend: () => 'octo-test-backend',
  encryptString: (s: string) => Buffer.from(`dpapi:${s}`, 'utf8'),
  decryptString: (b: Buffer) => {
    const s = b.toString('utf8');
    if (!s.startsWith('dpapi:')) throw new Error('DPAPI refused the blob');
    return s.slice('dpapi:'.length);
  },
};

vi.mock('electron', () => {
  const listeners = new Map<string, Array<() => void>>();
  return {
    app: {
      // Distinct folders per name: "exe" must NOT be a parent of the temp data
      // folders, otherwise the wizard would (correctly) refuse them.
      getPath: (name: string) => ({
        exe: path.join(path.sep, 'opt', 'octo-install', 'OctoBrowser', 'Octo.su.exe'),
        appData: path.join(os.tmpdir(), 'octo-appdata'),
        documents: os.tmpdir(),
        userData: os.tmpdir(),
        temp: os.tmpdir(),
        crashDumps: os.tmpdir(),
      }[name] ?? os.tmpdir()),
      getLocale: () => 'pl-PL',
      getVersion: () => '0.1.0',
      isPackaged: false,
      getName: () => 'Octo.su',
      setPath: () => undefined,
      setAppUserModelId: () => undefined,
      setName: () => undefined,
      enableSandbox: () => undefined,
      commandLine: { appendSwitch: () => undefined },
      configureHostResolver: () => undefined,
      whenReady: () => Promise.resolve(),
      on: (ev: string, fn: () => void) => { listeners.set(ev, [...(listeners.get(ev) ?? []), fn]); },
      exit: () => undefined,
      quit: () => undefined,
      relaunch: () => undefined,
      requestSingleInstanceLock: () => true,
    },
    dialog: {
      showErrorBox: () => undefined,
      showMessageBoxSync: () => dialogState.answer, // tests choose the button
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showSaveDialog: async () => ({ canceled: true }),
    },
    shell: { openPath: async () => '' },
    BrowserWindow: FakeWindow,
    nativeTheme: { themeSource: 'dark' },
    ipcMain: {
      handle: (channel: string, fn: Handler['fn']) => { handlers.set(channel, { channel, fn }); },
      removeHandler: (channel: string) => { handlers.delete(channel); },
    },
    safeStorage,
    powerMonitor: { on: () => undefined, getSystemIdleTime: () => 0 },
    session: { fromPartition: () => ({ fetch: async () => ({}) }) },
  };
});

// Elevation is decided per test, not by the machine: GitHub's Windows runners
// run as Administrator, which made every startApp() here return null.
const elevState = { elevated: false };
vi.mock('../src/winutil', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/winutil')>()),
  isElevated: async () => elevState.elevated,
}));

// Imported lazily (after the electron mock is registered) inside beforeAll,
// because top-level await is not available with "module": "commonjs".
type ContextModule = typeof import('../src/context');
type PrepareModule = typeof import('../src/prepare');
type CoreModule = typeof import('@octo/core');
type IpcModule = typeof import('../src/ipc');
let startApp: ContextModule['startApp'];
let prepareApp: PrepareModule['prepareApp'];
let Keyring: CoreModule['Keyring'];
let APPS: CoreModule['APPS'];
let setTrustedRoot: IpcModule['setTrustedRoot'];

beforeAll(async () => {
  ({ startApp } = await import('../src/context'));
  ({ prepareApp } = await import('../src/prepare'));
  ({ Keyring, APPS } = await import('@octo/core'));
  ({ setTrustedRoot } = await import('../src/ipc'));
});

const APPDATA = path.join(os.tmpdir(), 'octo-appdata');

/** Write bootstrap.json exactly like the first-run wizard does. */
function writeBootstrap(baseDir: string, dataDir: string): void {
  const dir = path.join(APPDATA, APPS.octobrowser.bootstrapDirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bootstrap.json'), JSON.stringify({
    schema: 1, language: 'pl', baseDir, dataDir, firstRunAt: new Date().toISOString(),
  }));
}

/** Build a PreparedApp for a data folder that already exists. */
function prepFor(dataDir: string, distDir: string) {
  return prepareApp('octobrowser', distDir);
}

/** Fake DPAPI protector for the core Keyring (matches the electron mock). */
function fakeProtector() {
  return {
    name: 'dpapi',
    available: () => true,
    protect: (d: Buffer) => safeStorage.encryptString(d.toString('base64')) as unknown as Buffer,
    unprotect: (b: Buffer) => Buffer.from(safeStorage.decryptString(b as Buffer), 'base64'),
  };
}

/** Fast KDF so the test does not spend seconds in Argon2id. */
const FAST_KDF = { memoryKiB: 8 * 1024, iterations: 1, parallelism: 1 };

/** Invoke a handler and return the raw {ok, value?, error?} envelope. */
async function callRaw(channel: string, ...args: unknown[]): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`no handler for ${channel}`);
  const wc = createdWindows[createdWindows.length - 1];
  const event = { sender: wc.webContents, senderFrame: { url: `file://${path.join(distDirForTest, 'shared', 'firstrun.html')}` } };
  return (await h.fn(event, ...args)) as { ok: boolean; value?: unknown; error?: string };
}

/** Invoke a handler the way a trusted renderer would and unwrap {ok,value}. */
async function call<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const h = handlers.get(channel);
  if (!h) throw new Error(`no handler for ${channel}`);
  const wc = createdWindows[createdWindows.length - 1];
  const event = { sender: wc.webContents, senderFrame: { url: `file://${path.join(distDirForTest, 'shared', 'unlock.html')}` } };
  const res = (await h.fn(event, ...args)) as { ok: boolean; value?: T; error?: string };
  if (!res.ok) throw new Error(res.error ?? 'handler failed');
  return res.value as T;
}

let distDirForTest = '';
const PW = 'Hasło główne 12345';

beforeEach(() => {
  handlers.clear();
  createdWindows.length = 0;
});

describe('startApp with a stubbed Electron', () => {
  it('opens a DPAPI keyring without showing any window', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-ctx-'));
    const dataDir = path.join(base, 'OctoBrowser');
    fs.mkdirSync(dataDir, { recursive: true });
    const distDir = path.join(base, 'dist');
    fs.mkdirSync(path.join(distDir, 'shared'), { recursive: true });
    distDirForTest = distDir;
    setTrustedRoot(distDir);

    writeBootstrap(base, dataDir);
    const prep = prepFor(dataDir, distDir);
    const layout = prep.layout!;
    layout.ensure(['downloads']);
    // a DPAPI keyring, like the wizard creates
    const keyring = new Keyring(path.join(layout.config, 'keyring.bin'), fakeProtector());
    await keyring.create();

    const ctx = await startApp(prep);
    expect(ctx).not.toBeNull();
    expect(ctx!.keyring.isUnlocked()).toBe(true);
    expect(ctx!.keyring.mode()).toBe('os');
    expect(ctx!.secretBackend()).toBe('local'); // Credential Manager needs Windows
    expect(createdWindows.length).toBe(0); // no unlock window was needed
    ctx!.keyring.lock();
  });

  it('elevated start: asks instead of refusing; "Quit" stops, "Continue anyway" opens', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-ctx-'));
    const dataDir = path.join(base, 'OctoBrowser');
    const distDir = path.join(base, 'dist');
    fs.mkdirSync(path.join(distDir, 'shared'), { recursive: true });
    distDirForTest = distDir;
    setTrustedRoot(distDir);
    writeBootstrap(base, dataDir);
    const prep = prepFor(dataDir, distDir);
    prep.layout!.ensure(['downloads']);
    await new Keyring(path.join(prep.layout!.config, 'keyring.bin'), fakeProtector()).create();

    elevState.elevated = true;
    try {
      dialogState.answer = 1; // "Quit"
      expect(await startApp(prep)).toBeNull();
      dialogState.answer = 0; // "Continue anyway"
      const ctx = await startApp(prep);
      expect(ctx).not.toBeNull();
      expect(ctx!.keyring.isUnlocked()).toBe(true);
      ctx!.keyring.lock();
    } finally {
      elevState.elevated = false;
      dialogState.answer = 2;
    }
  });

  it('requires the master password and refuses a wrong one', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-ctx-'));
    const dataDir = path.join(base, 'OctoBrowser');
    const distDir = path.join(base, 'dist');
    fs.mkdirSync(path.join(distDir, 'shared'), { recursive: true });
    distDirForTest = distDir;
    setTrustedRoot(distDir);

    writeBootstrap(base, dataDir);
    const prep = prepFor(dataDir, distDir);
    const layout = prep.layout!;
    layout.ensure(['downloads']);
    const keyring = new Keyring(path.join(layout.config, 'keyring.bin'), fakeProtector(), FAST_KDF);
    await keyring.create({ password: PW });

    const pending = startApp(prep);
    await vi.waitFor(() => expect(handlers.has('unlock:submit')).toBe(true));
    expect(createdWindows.length).toBe(1); // the master-password window is up

    const wrong = await call<{ ok: boolean; errorKey?: string }>('unlock:submit', 'zle-haslo-1234');
    expect(wrong.ok).toBe(false);           // the IPC call itself succeeded...
    expect(wrong.errorKey).toBe('unlock.wrong'); // ...but the unlock did not

    const right = await call<{ ok: boolean }>('unlock:submit', PW);
    expect(right.ok).toBe(true);

    const ctx = await pending;
    expect(ctx).not.toBeNull();
    expect(ctx!.keyring.isUnlocked()).toBe(true);
    ctx!.keyring.lock();
  });

  it('"I forgot the password" quarantines the key and continues (nothing deleted)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-ctx-'));
    const dataDir = path.join(base, 'OctoBrowser');
    const distDir = path.join(base, 'dist');
    fs.mkdirSync(path.join(distDir, 'shared'), { recursive: true });
    distDirForTest = distDir;
    setTrustedRoot(distDir);

    writeBootstrap(base, dataDir);
    const prep = prepFor(dataDir, distDir);
    const layout = prep.layout!;
    layout.ensure(['downloads']);
    const keyring = new Keyring(path.join(layout.config, 'keyring.bin'), fakeProtector(), FAST_KDF);
    await keyring.create({ password: PW });

    const pending = startApp(prep);
    await vi.waitFor(() => expect(handlers.has('unlock:forgot')).toBe(true));
    dialogState.answer = 0; // "Create a new key and continue"
    await call('unlock:forgot');
    const ctx = await pending;
    // The app continues with a NEW key and the old one is kept, not deleted.
    expect(ctx).not.toBeNull();
    expect(ctx!.keyring.isUnlocked()).toBe(true);
    expect(ctx!.keyring.mode()).toBe('os');
    const quarantined = fs.readdirSync(layout.backups).filter((f) => f.startsWith('unreadable-'));
    expect(quarantined.length).toBe(1);
    expect(fs.readdirSync(path.join(layout.backups, quarantined[0])).some((f) => f.startsWith('keyring.bin.unreadable-'))).toBe(true);
    ctx!.keyring.lock();
    dialogState.answer = 2;
  });

  it('the first-run wizard creates a master-password keyring (and refuses a weak one)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-ctx-'));
    const dataDir = path.join(base, 'OctoBrowser');
    const distDir = path.join(base, 'dist');
    fs.mkdirSync(path.join(distDir, 'shared'), { recursive: true });
    distDirForTest = distDir;
    setTrustedRoot(distDir);
    // no bootstrap.json => first run. The product was renamed to Octo.su and
    // the old folder is still read when it is there, so both must be gone.
    fs.rmSync(path.join(APPDATA, APPS.octobrowser.bootstrapDirName, 'bootstrap.json'), { force: true });
    fs.rmSync(path.join(APPDATA, APPS.octobrowser.legacyBootstrapDirName ?? 'x', 'bootstrap.json'), { force: true });

    const pending = startApp(prepareApp('octobrowser', distDir));
    await vi.waitFor(() => expect(handlers.has('setup:finish')).toBe(true));

    const finish = (pw?: string) => callRaw('setup:finish', {
      language: 'pl',
      baseDir: base,
      publicIpLookup: false,
      autoUpdate: false,
      keyProtection: pw ? 'password' : 'os',
      masterPassword: pw,
    });

    const weak = await finish('krotkie');
    expect(weak.ok).toBe(false); // the app refuses a weak master password
    expect(String(weak.error)).toContain('firstRun.err.weakPassword');
    expect(fs.existsSync(path.join(dataDir, 'config', 'keyring.bin'))).toBe(false); // nothing written yet

    const strong = await finish(PW);
    expect(strong.ok).toBe(true);
    await expect(pending).resolves.toBeNull(); // startApp relaunches the app

    const keyringFile = path.join(dataDir, 'config', 'keyring.bin');
    expect(fs.existsSync(keyringFile)).toBe(true);
    expect(fs.readFileSync(keyringFile, 'utf8')).not.toContain(PW); // never stored
    expect(new Keyring(keyringFile, fakeProtector()).mode()).toBe('password');

    // ...and the next start asks for exactly that password.
    const second = startApp(prepareApp('octobrowser', distDir));
    await vi.waitFor(() => expect(handlers.has('unlock:submit')).toBe(true));
    expect(createdWindows.length).toBe(2); // first-run wizard window + master-password window
    const wrong = await call<{ ok: boolean }>('unlock:submit', 'zupelnie-inne-haslo');
    expect(wrong.ok).toBe(false);
    const right = await call<{ ok: boolean }>('unlock:submit', PW);
    expect(right.ok).toBe(true);
    const ctx = await second;
    expect(ctx!.keyring.isUnlocked()).toBe(true);
    ctx!.keyring.lock();
  });
});
