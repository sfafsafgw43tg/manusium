/**
 * apps/octobrowser/src/main/media-requirements.ts
 *
 * Installing what vStudio needs, from inside the app.
 *
 * The Plugins panel used to list what was missing and then say "install the
 * missing pieces with install.bat" - which is not an answer when the user is
 * sitting in front of the panel. Each requirement now knows how to fix
 * itself:
 *
 *   Python 3          winget (the official python.org package)
 *   virtual camera    Unity Capture, registered from its official repository
 *                     - the one engine vStudio Mobile broadcasts through
 *   virtual microphone VB-CABLE, from VB-Audio's own download
 *
 * Every download is HTTPS from the vendor's own host, size-capped, and the
 * two driver installers are launched elevated and VISIBLY: a driver that
 * installs itself silently behind the user's back is not something this app
 * should do, and Windows asks for consent anyway.
 */
import { execFile, spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

export type RequirementId = 'python' | 'camera' | 'microphone' | 'folder' | 'emulator' | 'bundle';

export interface RequirementFix {
  id: RequirementId;
  /** A fix exists and can be started from the app. */
  fixable: boolean;
  /** The plugin cannot run at all without this one. */
  required: boolean;
  /** What will happen, so the button is never a surprise. */
  vendor: string;
  homepage: string;
}

export const REQUIREMENT_FIXES: Record<RequirementId, RequirementFix> = {
  python: { id: 'python', fixable: true, required: true, vendor: 'python.org (winget)', homepage: 'https://www.python.org/downloads/' },
  camera: { id: 'camera', fixable: true, required: false, vendor: 'Unity Capture (github.com/schellingb)', homepage: 'https://github.com/schellingb/UnityCapture' },
  microphone: { id: 'microphone', fixable: true, required: false, vendor: 'VB-Audio', homepage: 'https://vb-audio.com/Cable/' },
  folder: { id: 'folder', fixable: false, required: true, vendor: '', homepage: '' },
  emulator: { id: 'emulator', fixable: false, required: false, vendor: '', homepage: '' },
  bundle: { id: 'bundle', fixable: false, required: true, vendor: '', homepage: '' },
};

const MAX_DOWNLOAD_BYTES = 80 * 1024 * 1024;
const CACHE = () => path.join(os.homedir(), '.octobrowser', 'media-drivers');

function download(url: string, allowedHost: RegExp, depth = 0): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (depth > 3) { reject(new Error('Too many redirects')); return; }
    let target: URL;
    try { target = new URL(url); } catch { reject(new Error('Invalid download address')); return; }
    if (target.protocol !== 'https:' || !allowedHost.test(target.hostname)) {
      reject(new Error(`Refusing to download from ${target.hostname}`));
      return;
    }
    https.get(target, { timeout: 120_000, headers: { 'user-agent': 'Octo' } }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        resolve(download(new URL(response.headers.location, target).toString(), allowedHost, depth + 1));
        return;
      }
      if (status !== 200) { response.resume(); reject(new Error(`The download failed (HTTP ${status})`)); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_DOWNLOAD_BYTES) { response.destroy(); reject(new Error('The download is larger than expected and was stopped')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

/** Minimal zip reader: enough for the two small vendor archives. */
export function unzipTo(archive: Buffer, destination: string, wanted?: RegExp): string[] {
  const written: string[] = [];
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('The downloaded file is not a zip archive');
  const count = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) break;
    const method = archive.readUInt16LE(offset + 10);
    const compressed = archive.readUInt32LE(offset + 20);
    const uncompressed = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const local = archive.readUInt32LE(offset + 42);
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength).replace(/\\/g, '/');
    offset += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/') || name.includes('..') || path.posix.isAbsolute(name)) continue;
    if (wanted && !wanted.test(name)) continue;
    if (uncompressed > MAX_DOWNLOAD_BYTES) continue;
    const localName = archive.readUInt16LE(local + 26);
    const localExtra = archive.readUInt16LE(local + 28);
    const start = local + 30 + localName + localExtra;
    const raw = archive.subarray(start, start + compressed);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);
    const file = path.resolve(destination, name);
    if (file !== destination && !file.startsWith(`${destination}${path.sep}`)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    written.push(file);
  }
  return written;
}

function powershell(command: string, timeout = 10 * 60_000): { ok: boolean; output: string } {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8', windowsHide: true, timeout });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 600) };
}

function commandOutput(program: string, args: string[], timeout = 10_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(program, args, { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });
}

/** Non-blocking driver probe for renderer-facing status pages. */
export async function unityCaptureRegisteredAsync(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  return (await commandOutput('reg.exe', ['query', 'HKLM\\SOFTWARE\\Classes\\CLSID\\{5C2CD55C-92AD-4999-8666-912BD3E70002}'])).ok;
}

/** Is the Unity Capture DirectShow filter registered on this machine? */
export function unityCaptureRegistered(): boolean {
  if (process.platform !== 'win32') return false;
  const result = spawnSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Classes\\CLSID\\{5C2CD55C-92AD-4999-8666-912BD3E70002}'],
    { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return result.status === 0;
}

function vbCableEndpointAvailable(): boolean {
  if (process.platform !== 'win32') return false;
  const options = { encoding: 'utf8' as const, windowsHide: true, timeout: 10_000 };
  const endpoint = spawnSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio', '/s', '/f', 'CABLE Output'], options);
  return endpoint.status === 0;
}

/** Non-blocking VB-CABLE probe used while rendering Settings/Android pages. */
export async function vbCableInstalledAsync(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const legacy = await commandOutput('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\VBAudioVACWDM']);
  if (legacy.ok) return true;
  const service = await commandOutput('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services', '/s', '/f', 'VBAudio', '/k']);
  if (service.ok && /cable/i.test(service.output)) return true;
  const endpoint = await commandOutput('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio', '/s', '/f', 'CABLE Output']);
  if (endpoint.ok) return true;
  const drivers = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers');
  try { return (await fs.promises.readdir(drivers)).some((file) => /^vbaudio.*cable.*\.sys$/i.test(file)); }
  catch { return false; }
}

/** Is VB-CABLE (the virtual microphone) installed? */
export function vbCableInstalled(): boolean {
  if (process.platform !== 'win32') return false;
  const options = { encoding: 'utf8' as const, windowsHide: true, timeout: 10_000 };
  // Driver package revisions use different service names. Checking only the
  // old VBAudioVACWDM key made Octo claim that a working CABLE Output was not
  // installed, then launch the vendor installer which answered "already
  // installed". Accept any of the three independent Windows signals below.
  const legacyService = spawnSync('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\VBAudioVACWDM'], options);
  if (legacyService.status === 0) return true;
  const service = spawnSync('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services', '/s', '/f', 'VBAudio', '/k'], options);
  if (service.status === 0 && /cable/i.test(String(service.stdout ?? ''))) return true;
  if (vbCableEndpointAvailable()) return true;
  const drivers = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers');
  try {
    return fs.readdirSync(drivers).some((file) => /^vbaudio.*cable.*\.sys$/i.test(file));
  } catch { return false; }
}

function wingetPath(): string {
  const result = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['winget'], { encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? String(result.stdout || '').split(/\r?\n/)[0].trim() : '';
}

function runWinget(id: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const winget = wingetPath() || 'winget.exe';
    execFile(winget, ['install', '--id', id, '--exact', '--source', 'winget', '--silent',
      '--accept-package-agreements', '--accept-source-agreements'],
    { windowsHide: true, timeout: 30 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const output = `${stdout}\n${stderr}`;
      // winget answers "already installed / no upgrade" with an error code.
      if (!error || /already installed|no available upgrade|no newer package/i.test(output)) {
        resolve({ ok: true, message: `${id} is installed.` });
        return;
      }
      resolve({ ok: false, message: output.split(/\r?\n/).filter(Boolean).slice(-3).join(' ').slice(0, 400) || `winget could not install ${id}` });
    });
  });
}

export interface RequirementResult { ok: boolean; message: string; needsRestart?: boolean }

/** Register Unity Capture from its official repository. */
export async function installUnityCapture(onProgress?: (text: string, percent: number) => void): Promise<RequirementResult> {
  if (process.platform !== 'win32') return { ok: false, message: 'Unity Capture is a Windows DirectShow filter.' };
  if (unityCaptureRegistered()) return { ok: true, message: 'Unity Capture is already registered.' };
  onProgress?.('Downloading Unity Capture', -1);
  const archive = await download('https://github.com/schellingb/UnityCapture/archive/refs/heads/master.zip', /(^|\.)github\.com$|(^|\.)githubusercontent\.com$/);
  const root = path.join(CACHE(), 'UnityCapture');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  onProgress?.('Unpacking Unity Capture', 50);
  const files = unzipTo(archive, root, /Install\/.*\.(dll|bat)$/i);
  const filter = files.find((file) => /UnityCaptureFilter64bit\.dll$/i.test(file)) ?? files.find((file) => /UnityCaptureFilter32bit\.dll$/i.test(file));
  if (!filter) return { ok: false, message: 'The Unity Capture archive did not contain the camera filter.' };
  onProgress?.('Registering the camera filter (Windows will ask for permission)', 80);
  // regsvr32 needs elevation, so Windows shows its own consent dialog.
  const registered = powershell(`Start-Process regsvr32.exe -ArgumentList '/s','"${filter}"' -Verb RunAs -Wait`, 5 * 60_000);
  if (!registered.ok) return { ok: false, message: registered.output || 'Registering the camera filter was refused.' };
  onProgress?.('done', 100);
  return unityCaptureRegistered()
    ? { ok: true, message: `Unity Capture registered from ${filter}.` }
    : { ok: false, message: 'Windows did not confirm the registration. Run the app as administrator and try again.' };
}

/** Install VB-CABLE, the virtual microphone, from VB-Audio's own download. */
export async function installVbCable(onProgress?: (text: string, percent: number) => void): Promise<RequirementResult> {
  if (process.platform !== 'win32') return { ok: false, message: 'VB-CABLE is a Windows audio driver.' };
  if (vbCableInstalled()) return { ok: true, message: 'VB-CABLE is already installed.' };
  onProgress?.('Downloading VB-CABLE from vb-audio.com', -1);
  const archive = await download('https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip', /(^|\.)vb-audio\.com$/);
  const root = path.join(CACHE(), 'VBCABLE');
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  onProgress?.('Unpacking VB-CABLE', 50);
  const files = unzipTo(archive, root);
  const setup = files.find((file) => /VBCABLE_Setup_x64\.exe$/i.test(file)) ?? files.find((file) => /VBCABLE_Setup\.exe$/i.test(file));
  if (!setup) return { ok: false, message: 'The VB-CABLE package did not contain its installer.' };
  const sha = crypto.createHash('sha256').update(archive).digest('hex').slice(0, 16);
  onProgress?.('Installing the VB-CABLE audio driver', 80);
  // VB-Audio documents installation as an administrator operation. -i -h runs
  // the package without its own wizard; Windows may still show the mandatory
  // UAC/driver-consent surface, which an application must not bypass.
  const escaped = setup.replace(/'/g, "''");
  const driverRoot = root.replace(/'/g, "''");
  // Install the vendor package, ask Plug and Play to enumerate it immediately,
  // then restart only the Windows audio services. This normally exposes the
  // endpoint in the current session and avoids a full machine reboot.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$p = Start-Process '${escaped}' -ArgumentList '-i','-h' -WindowStyle Hidden -Wait -PassThru`,
    'if ($p.ExitCode -notin 0,1641,3010) { exit $p.ExitCode }',
    `Get-ChildItem '${driverRoot}' -Filter '*.inf' -Recurse | ForEach-Object { & pnputil.exe /add-driver $_.FullName /install | Out-Null }`,
    '& pnputil.exe /scan-devices | Out-Null',
    'Restart-Service AudioEndpointBuilder -Force -ErrorAction SilentlyContinue',
    'Start-Service AudioEndpointBuilder -ErrorAction SilentlyContinue',
    'Start-Service Audiosrv -ErrorAction SilentlyContinue',
  ].join('\r\n');
  const activationFile = path.join(root, 'octo-activate-vbcable.ps1');
  fs.writeFileSync(activationFile, script, { mode: 0o600 });
  const activation = activationFile.replace(/'/g, "''");
  const started = powershell(`$e = Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${activation}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; if ($e.ExitCode -ne 0) { exit $e.ExitCode }`, 5 * 60_000);
  if (!started.ok) return { ok: false, message: started.output || 'The VB-CABLE driver installation was refused.' };
  onProgress?.('Activating the virtual microphone without restarting Windows', 92);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !vbCableEndpointAvailable()) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  onProgress?.('done', 100);
  const installed = vbCableInstalled();
  const active = vbCableEndpointAvailable();
  return {
    ok: active,
    needsRestart: installed && !active,
    message: active
      ? `VB-CABLE was installed and activated without rebooting Windows (package ${sha}...).`
      : installed
        ? 'VB-CABLE is installed, but Windows refused to activate its audio endpoint in this session. Windows requires a restart on this driver/host combination.'
        : 'Windows did not install the VB-CABLE driver. Check the administrator/driver-consent prompt and try again.',
  };
}

/** Install Python 3 through winget. */
export async function installPython(onProgress?: (text: string, percent: number) => void): Promise<RequirementResult> {
  if (process.platform !== 'win32') return { ok: false, message: 'Install Python 3 with your system package manager.' };
  if (!wingetPath()) return { ok: false, message: 'winget was not found. Install Python 3 from python.org and reopen this page.' };
  onProgress?.('Installing Python 3 with winget', -1);
  const result = await runWinget('Python.Python.3.12');
  onProgress?.('done', 100);
  return result;
}

/** Resolve UI translation keys without starting an installer. */
export function mediaRequirementId(id: string): 'python' | 'camera' | 'microphone' | undefined {
  if (id === 'python' || id === 'android.media.python') return 'python';
  if (id === 'camera' || id === 'android.media.camera') return 'camera';
  if (id === 'microphone' || id === 'android.media.microphone') return 'microphone';
  return undefined;
}

/** One entry point the UI calls with the id of the missing piece. */
export async function installMediaRequirement(id: string, onProgress?: (text: string, percent: number) => void): Promise<RequirementResult> {
  const requirement = mediaRequirementId(id);
  if (requirement === 'python') return installPython(onProgress);
  if (requirement === 'camera') return installUnityCapture(onProgress);
  if (requirement === 'microphone') return installVbCable(onProgress);
  return { ok: false, message: 'There is nothing to install for this item.' };
}
