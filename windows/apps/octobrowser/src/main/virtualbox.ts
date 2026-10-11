/**
 * apps/octobrowser/src/main/virtualbox.ts
 *
 * The Oracle VirtualBox bridge. VirtualBox has one job here: it is the host
 * hypervisor for the isolated Android Studio Linux VM (virtualbox-studio-vm.ts).
 * Android devices themselves run on Android Studio's AVD engine.
 *
 * All VBoxManage calls use execFile argument arrays (never a shell), and the
 * machines are registered in VirtualBox itself. OctoBrowser does not keep a
 * second VM inventory: VirtualBox remains the source of truth.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type VirtualBoxLaunchMode = 'gui' | 'headless' | 'separate';

export interface VirtualBoxOsType { id: string; description: string }

/** Which modifyvm options this VBoxManage actually advertises. */
export interface VirtualBoxCapabilities {
  /** Raw version string, e.g. "7.1.6r167084". */
  version: string;
  major: number;
  minor: number;
  /** True when `VBoxManage help modifyvm` answered; false means "assume modern". */
  probed: boolean;
  flags: string[];
}


export interface VirtualBoxStatus {
  available: boolean;
  executable: string;
  version: string;
  defaultMachineFolder: string;
  osTypes: VirtualBoxOsType[];
  hostRamMb: number;
  hostCores: number;
  /** Oracle's Extension Pack is installed (USB 2/3, webcam passthrough, VRDP). */
  extensionPack: boolean;
  /** Which `modifyvm` options this VBoxManage advertises. */
  capabilities: VirtualBoxCapabilities;
  error: string;
}

/** A machine registered in VirtualBox, as far as the Studio VM needs to know it. */
export interface VirtualBoxMachine {
  id: string;
  name: string;
  state: string;
  osType: string;
  memoryMb: number;
  cpus: number;
  vramMb: number;
  /** Nested hardware virtualization (needed for KVM-accelerated AVDs in the guest). */
  nestedVirtualization: boolean;
  folder: string;
  configFile: string;
}

const MANUAL_PATH_FILE = path.join(os.homedir(), '.octobrowser', 'virtualbox.json');


function manualPath(): string {
  try {
    const value = JSON.parse(fs.readFileSync(MANUAL_PATH_FILE, 'utf8')) as { executable?: unknown };
    const candidate = typeof value.executable === 'string' ? value.executable.trim() : '';
    return path.isAbsolute(candidate) && fs.existsSync(candidate) ? candidate : '';
  } catch { return ''; }
}

function queryWhereVBoxManage(): string {
  try {
    const out = execFileSync('where.exe', ['VBoxManage.exe'], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0 && fs.existsSync(s));
    return first || '';
  } catch { return ''; }
}

function queryWhichVBoxManage(): string {
  try {
    const out = execFileSync('which', ['VBoxManage'], { encoding: 'utf8', timeout: 3000 });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0 && fs.existsSync(s));
    return first || '';
  } catch { return ''; }
}

function queryVirtualBoxRegistry(): string {
  try {
    const out = execFileSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Oracle\\VirtualBox', '/v', 'InstallDir'], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    const match = /InstallDir\s+REG_SZ\s+(.*)/i.exec(out);
    const dir = match?.[1]?.trim();
    return dir && fs.existsSync(dir) ? dir : '';
  } catch { return ''; }
}
function candidates(): string[] {
  const result: string[] = [];
  const manual = manualPath();
  if (manual) result.push(manual);

  if (process.platform === 'win32') {
    const fromWhere = queryWhereVBoxManage();
    if (fromWhere) result.push(fromWhere);

    const regDir = queryVirtualBoxRegistry();
    if (regDir) {
      result.push(path.join(regDir, 'VBoxManage.exe'));
    }

    const envRoots = [
      process.env.VBOX_MSI_INSTALL_PATH,
      process.env.VBOX_INSTALL_PATH,
      process.env.ProgramFiles,
      process.env['ProgramFiles(x86)'],
      process.env.ProgramW6432,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : undefined,
    ].filter((item): item is string => !!item);

    for (const root of envRoots) {
      result.push(path.join(root, 'VBoxManage.exe'));
      result.push(path.join(root, 'Oracle', 'VirtualBox', 'VBoxManage.exe'));
      result.push(path.join(root, 'VirtualBox', 'VBoxManage.exe'));
    }

    for (const drive of ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'X']) {
      result.push(`${drive}:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe`);
      result.push(`${drive}:\\Program Files (x86)\\Oracle\\VirtualBox\\VBoxManage.exe`);
      result.push(`${drive}:\\Oracle\\VirtualBox\\VBoxManage.exe`);
      result.push(`${drive}:\\VirtualBox\\VBoxManage.exe`);
      result.push(`${drive}:\\Program Files\\VirtualBox\\VBoxManage.exe`);
    }
  } else if (process.platform === 'darwin') {
    const fromWhich = queryWhichVBoxManage();
    if (fromWhich) result.push(fromWhich);
    result.push(
      '/Applications/VirtualBox.app/Contents/MacOS/VBoxManage',
      '/usr/local/bin/VBoxManage',
      '/opt/homebrew/bin/VBoxManage',
    );
  } else {
    const fromWhich = queryWhichVBoxManage();
    if (fromWhich) result.push(fromWhich);
    result.push(
      '/usr/bin/VBoxManage',
      '/usr/local/bin/VBoxManage',
      '/opt/virtualbox/VBoxManage',
    );
  }
  return [...new Set(result)];
}

let executableCache: { value: string; checkedAt: number } | null = null;
const EXECUTABLE_CACHE_MS = 30_000;

/**
 * Discovery can invoke where.exe, the registry and a filesystem walk. It is
 * deliberately cached: the launcher asks for VirtualBox status whenever the
 * user changes views, and repeating those probes blocks Electron's main
 * process (especially when VirtualBox is not installed).
 */
function locateExecutable(): string {
  const now = Date.now();
  if (executableCache && now - executableCache.checkedAt < EXECUTABLE_CACHE_MS) return executableCache.value;
  let value = '';
  for (const candidate of candidates()) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) { value = candidate; break; }
  }
  executableCache = { value, checkedAt: now };
  return value;
}

function invalidateExecutableCache(): void {
  executableCache = null;
}

const exec = (program: string, args: string[], timeout = 20_000): Promise<string> => new Promise((resolve, reject) => {
  execFile(program, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`Oracle VirtualBox (${program}) was not found or is not accessible. Install Oracle VirtualBox or locate VBoxManage.exe.`));
        return;
      }
      const detail = String(stderr || error.message || '').trim().slice(-1200);
      reject(new Error(detail || 'VBoxManage command failed'));
    } else resolve(String(stdout ?? ''));
  });
});

export async function command(args: string[], timeout = 20_000): Promise<string> {
  const executable = locateExecutable();
  if (executable) {
    return await exec(executable, args, timeout);
  }
  for (const program of candidates()) {
    if (path.isAbsolute(program) && !fs.existsSync(program)) continue;
    try { return await exec(program, args, timeout); } catch { /* try next */ }
  }
  throw new Error('Oracle VirtualBox (VBoxManage.exe) was not found. Install Oracle VirtualBox or click "Locate VBoxManage" to specify its path.');
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length < 2 || text[0] !== '"' || text[text.length - 1] !== '"') return text;
  return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
}

export function machineReadableValue(output: string, key: string): string {
  const wanted = String(key ?? '');
  if (!wanted) return '';
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    // Keys arrive bare (`memory=4096`) and quoted (`"OctoBrowser/Android"="true"`).
    if (unquote(line.slice(0, at).trim()) === wanted) return unquote(line.slice(at + 1));
  }
  return '';
}

/**
 * The first key that this VirtualBox version actually prints. Machine-readable
 * keys were renamed between releases (`audio` → `audio_adapter`, `--videocap`
 * → `--recording`), and an unknown value must read as "not reported" rather
 * than as a wrong setting.
 */
export function machineReadableFirst(output: string, keys: string[]): string {
  for (const key of keys) {
    const value = machineReadableValue(output, key);
    if (value) return value;
  }
  return '';
}


/** What `VBoxManage help modifyvm` advertises, cached for the process lifetime. */
let capabilityCache: VirtualBoxCapabilities | undefined;

export function parseVirtualBoxCapabilities(version: string, help: string): VirtualBoxCapabilities {
  const numbers = /^(\d+)\.(\d+)/.exec(String(version ?? '').trim()) ?? ['', '0', '0'];
  const flags = [...new Set([...String(help ?? '').matchAll(/--([a-z0-9][a-z0-9-]*)/gi)].map((match) => `--${match[1].toLowerCase()}`))];
  return {
    version: String(version ?? '').trim(),
    major: Number(numbers[1]) || 0,
    minor: Number(numbers[2]) || 0,
    probed: flags.length > 20,
    flags,
  };
}

/**
 * Ask the installed VBoxManage which modifyvm options it knows. When it does
 * not answer (an old build without `help`), every option is assumed available
 * and the caller's first spelling is used - the same behaviour as before this
 * probe existed, so nothing regresses on a machine we cannot interrogate.
 */
export async function virtualBoxCapabilities(force = false): Promise<VirtualBoxCapabilities> {
  if (capabilityCache && !force) return capabilityCache;
  let help = '';
  for (const args of [['help', 'modifyvm'], ['modifyvm', '--help'], ['--help']] as const) {
    try { help = await command([...args], 20_000); if (help.includes('--memory')) break; } catch { /* try the next spelling */ }
  }
  let version = '';
  try { version = (await command(['--version'], 10_000)).trim(); } catch { /* unknown */ }
  capabilityCache = parseVirtualBoxCapabilities(version, help);
  return capabilityCache;
}

/** Test-only hook: forget the probe so a different VBoxManage can be measured. */
export function resetVirtualBoxCapabilities(): void {
  capabilityCache = undefined;
}

export function parseVirtualBoxOsTypes(output: string): VirtualBoxOsType[] {
  const result: VirtualBoxOsType[] = [];
  let current: Partial<VirtualBoxOsType> = {};
  const flush = () => {
    if (current.id && current.description) result.push({ id: current.id, description: current.description });
    current = {};
  };
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = /^\s*(ID|Description):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    if (match[1] === 'ID') {
      flush();
      current.id = match[2];
    } else current.description = match[2];
  }
  flush();
  return result;
}

function parseRegisteredVms(output: string): Array<{ id: string; name: string }> {
  const result: Array<{ id: string; name: string }> = [];
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const match = /^\s*"((?:[^"\\]|\\.)+)"\s+\{([0-9a-f-]{36})\}\s*$/i.exec(line);
    if (!match) continue;
    result.push({ name: unquote(`"${match[1]}"`), id: match[2] });
  }
  return result;
}


export const DEFAULT_VIRTUALBOX_OS_TYPES: VirtualBoxOsType[] = [
  { id: 'Linux26_64', description: 'Linux 2.6 / 3.x / 4.x / 5.x / 6.x (64-bit)' },
  { id: 'Linux_64', description: 'Linux (64-bit)' },
  { id: 'Linux26', description: 'Linux 2.6 / 3.x / 4.x (32-bit)' },
  { id: 'Linux', description: 'Linux (32-bit)' },
  { id: 'Other_64', description: 'Other/Unknown (64-bit)' },
  { id: 'Other', description: 'Other/Unknown' },
];

let statusCache: { value: VirtualBoxStatus; createdAt: number } | null = null;
let statusRequest: Promise<VirtualBoxStatus> | null = null;
const STATUS_CACHE_MS = 5_000;

export async function virtualBoxStatus(): Promise<VirtualBoxStatus> {
  const now = Date.now();
  if (statusCache && now - statusCache.createdAt < STATUS_CACHE_MS) return statusCache.value;
  if (statusRequest) return statusRequest;
  statusRequest = readVirtualBoxStatus();
  try {
    const value = await statusRequest;
    statusCache = { value, createdAt: Date.now() };
    return value;
  } finally {
    statusRequest = null;
  }
}

async function readVirtualBoxStatus(): Promise<VirtualBoxStatus> {
  const executable = locateExecutable();
  const base: VirtualBoxStatus = {
    available: false,
    executable,
    version: '',
    defaultMachineFolder: '',
    osTypes: DEFAULT_VIRTUALBOX_OS_TYPES,
    hostRamMb: Math.floor(os.totalmem() / 1_000_000),
    hostCores: os.cpus().length,
    extensionPack: false,
    capabilities: { version: '', major: 0, minor: 0, probed: false, flags: [] },
    error: '',
  };
  if (!executable) {
    return {
      ...base,
      available: false,
      error: 'Oracle VirtualBox was not found. Install it or locate VBoxManage.',
    };
  }
  try {
    const version = await command(['--version'], 10_000);
    const [properties, osTypes, extpacks, help] = await Promise.all([
      command(['list', 'systemproperties', '--machinereadable']).catch(() => ''),
      command(['list', 'ostypes']).catch(() => ''),
      command(['list', 'extpacks']).catch(() => ''),
      command(['help', 'modifyvm']).catch(() => command(['modifyvm', '--help']).catch(() => '')),
    ]);
    const parsedOsTypes = parseVirtualBoxOsTypes(osTypes);
    return {
      ...base,
      available: true,
      version: version.trim().split(/\r?\n/)[0] ?? '',
      defaultMachineFolder: machineReadableValue(properties, 'DefaultMachineFolder'),
      osTypes: parsedOsTypes.length > 0 ? parsedOsTypes : DEFAULT_VIRTUALBOX_OS_TYPES,
      // USB 2.0/3.0 controllers and webcam passthrough come from the Extension
      // Pack, which Oracle licenses separately: the UI says so instead of
      // offering a setting this installation cannot honour.
      extensionPack: /Usable:\s*true/i.test(extpacks) || /^Package no\.\s*\d+:/im.test(extpacks),
      capabilities: parseVirtualBoxCapabilities(version, help),
      error: '',
    };
  } catch (error) {
    return { ...base, available: false, error: error instanceof Error ? error.message : 'VirtualBox was not found.' };
  }
}

export async function setVirtualBoxManagePath(file: string): Promise<string> {
  const candidate = String(file ?? '').trim();
  if (!path.isAbsolute(candidate) || !/^VBoxManage(?:\.exe)?$/i.test(path.basename(candidate))) {
    throw new Error('Select VBoxManage or VBoxManage.exe from the VirtualBox installation folder.');
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error('That VBoxManage file does not exist.');
  await exec(candidate, ['--version'], 10_000);
  fs.mkdirSync(path.dirname(MANUAL_PATH_FILE), { recursive: true });
  fs.writeFileSync(MANUAL_PATH_FILE, JSON.stringify({ executable: candidate }, null, 2), { mode: 0o600 });
  invalidateExecutableCache();
  statusCache = null;
  return candidate;
}

export async function clearVirtualBoxManagePath(): Promise<void> {
  try { await fs.promises.rm(MANUAL_PATH_FILE, { force: true }); } catch { /* already absent */ }
  invalidateExecutableCache();
  statusCache = null;
}


export async function listVirtualBoxMachines(): Promise<VirtualBoxMachine[]> {
  const registered = parseRegisteredVms(await command(['list', 'vms']));
  return Promise.all(registered.map(async (machine) => {
    try {
      const output = await command(['showvminfo', machine.id, '--machinereadable']);
      const memory = Number.parseInt(machineReadableValue(output, 'memory'), 10);
      const cpus = Number.parseInt(machineReadableValue(output, 'cpus'), 10);
      const vram = Number.parseInt(machineReadableValue(output, 'vram'), 10);
      return {
        id: machine.id,
        name: machineReadableValue(output, 'name') || machine.name,
        state: machineReadableFirst(output, ['VMState']) || 'unknown',
        osType: machineReadableValue(output, 'ostype'),
        memoryMb: Number.isFinite(memory) ? memory : 0,
        cpus: Number.isFinite(cpus) ? cpus : 0,
        vramMb: Number.isFinite(vram) ? vram : 0,
        nestedVirtualization: machineReadableValue(output, 'nested-hw-virt') === 'on',
        folder: machineReadableValue(output, 'CfgFile') ? path.dirname(machineReadableValue(output, 'CfgFile')) : '',
        configFile: machineReadableValue(output, 'CfgFile'),
      };
    } catch {
      return {
        id: machine.id, name: machine.name, state: 'unknown', osType: '', memoryMb: 0, cpus: 0, vramMb: 0,
        nestedVirtualization: false, folder: '', configFile: '',
      };
    }
  }));
}

export async function installVirtualBox(onProgress?: (message: string) => void): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== 'win32') return { ok: false, message: 'Automatic installation is supported only on Windows. Install VirtualBox from virtualbox.org, then locate VBoxManage.' };
  const winget = ['winget.exe', path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'winget.exe')]
    .find((candidate) => candidate === 'winget.exe' || fs.existsSync(candidate)) ?? 'winget.exe';
  onProgress?.('Installing Oracle VirtualBox with Windows Package Manager.');
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(winget, ['install', '--id', 'Oracle.VirtualBox', '--exact', '--source', 'winget', '--silent',
        '--accept-package-agreements', '--accept-source-agreements'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { resolve({ ok: false, message: error instanceof Error ? error.message : 'Could not start winget.' }); return; }
    const collect = (chunk: Buffer | string) => {
      const text = String(chunk);
      output = `${output}${text}`.slice(-2000);
      for (const line of text.split(/\r?\n/).filter(Boolean)) onProgress?.(line.slice(0, 240));
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* already gone */ }
      resolve({ ok: false, message: 'VirtualBox installation timed out. Check winget and try again.' });
    }, 45 * 60_000);
    child.once('error', (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ ok: false, message: error.message || 'winget could not be started.' });
    });
    child.once('close', async (code) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (code === 0) {
        const status = await virtualBoxStatus();
        resolve(status.available
          ? { ok: true, message: `Oracle VirtualBox ${status.version} is ready.` }
          : { ok: true, message: 'VirtualBox installation finished. If VBoxManage is not detected yet, reopen OctoBrowser or locate VBoxManage.exe.' });
      } else {
        resolve({ ok: false, message: output.trim().slice(-500) || `winget exited with code ${code ?? 'unknown'}.` });
      }
    });
  });
}

