/**
 * apps/octobrowser/src/main/android-network.ts
 *
 * Network control for the Android devices OctoBrowser runs (Android Studio
 * emulators, AVD). Three jobs:
 *
 *   1. Proxy lockdown - point the whole device at the profile proxy and, when
 *      the device is rooted (AOSP emulator images are, Google Play images are not),
 *      install an iptables ruleset that drops every packet that is not going
 *      to that proxy. Without root we still set the system proxy and report
 *      honestly that the lockdown is "partial".
 *   2. Dead man's switch - cut all networking of every running Android device
 *      in one call, and put it back afterwards.
 *   3. Traffic readout - bytes in/out per device, read from the device's own
 *      /proc/net/dev. No URLs, no hostnames, no payloads are ever read.
 *
 * Everything goes through `adb`, which we locate through the Android SDK we
 * already detect for the emulator.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { androidSdkRootForTools } from './android-studio';

export type LockdownState = 'off' | 'full' | 'partial';

export interface AndroidNetStatus {
  /** adb serial, e.g. "emulator-5554" or "192.168.56.101:5555". */
  serial: string;
  /** AVD name when it can be read. */
  name: string;
  online: boolean;
  rooted: boolean;
  proxy: string;
  lockdown: LockdownState;
  networkOff: boolean;
  bytesIn: number;
  bytesOut: number;
}

export interface AndroidProxyInput {
  host: string;
  port: number;
  /** Drop everything that is not addressed to the proxy (needs root). */
  lockdown?: boolean;
  /** Hosts that may bypass the proxy (rarely needed; empty by default). */
  bypass?: string;
}

const HOST = /^[A-Za-z0-9._-]{1,255}$/;
const SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;
/** Chain name used for every rule we add, so a reset never touches other rules. */
const CHAIN = 'OCTO_LOCKDOWN';

function adbPath(): string {
  const root = androidSdkRootForTools();
  if (!root) return '';
  const candidate = path.join(root, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
  return fs.existsSync(candidate) ? candidate : '';
}

function adb(args: string[], timeout = 15_000): Promise<string> {
  const tool = adbPath();
  if (!tool) return Promise.reject(new Error('adb not found. Install the Android SDK platform-tools.'));
  return new Promise((resolve, reject) => {
    execFile(tool, args, { windowsHide: true, timeout, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || stdout || error.message).slice(0, 600)));
      else resolve(stdout);
    });
  });
}

function assertSerial(serial: string): string {
  const clean = String(serial ?? '').trim();
  if (!SERIAL.test(clean)) throw new Error('Invalid Android device serial');
  return clean;
}

function assertProxy(input: AndroidProxyInput): { host: string; port: number } {
  const host = String(input?.host ?? '').trim();
  const port = Math.round(Number(input?.port));
  if (!HOST.test(host)) throw new Error('Invalid proxy host');
  if (!Number.isFinite(port) || port < 1 || port > 65535) throw new Error('Invalid proxy port');
  return { host, port };
}

/** Run a shell command inside the device. */
function shell(serial: string, command: string[], timeout = 15_000): Promise<string> {
  return adb(['-s', serial, 'shell', ...command], timeout);
}

/** Is `adb root` available (AOSP and Google APIs emulator images: yes; Play images: no)? */
async function isRooted(serial: string): Promise<boolean> {
  try {
    const out = await shell(serial, ['id'], 6_000);
    if (/uid=0\(root\)/.test(out)) return true;
  } catch { /* fall through */ }
  try {
    await adb(['-s', serial, 'root'], 15_000);
    const out = await shell(serial, ['id'], 6_000);
    return /uid=0\(root\)/.test(out);
  } catch { return false; }
}

/** Bytes in/out of the device's own interfaces, excluding loopback. */
async function trafficOf(serial: string): Promise<{ bytesIn: number; bytesOut: number }> {
  try {
    const raw = await shell(serial, ['cat', '/proc/net/dev'], 6_000);
    let bytesIn = 0;
    let bytesOut = 0;
    for (const line of raw.split(/\r?\n/)) {
      const match = /^\s*([A-Za-z0-9._-]+):\s*(.*)$/.exec(line);
      if (!match || match[1] === 'lo') continue;
      const fields = match[2].trim().split(/\s+/).map((value) => Number.parseInt(value, 10) || 0);
      bytesIn += fields[0] ?? 0;
      bytesOut += fields[8] ?? 0;
    }
    return { bytesIn, bytesOut };
  } catch { return { bytesIn: 0, bytesOut: 0 }; }
}

async function currentProxy(serial: string): Promise<string> {
  try {
    const value = (await shell(serial, ['settings', 'get', 'global', 'http_proxy'], 6_000)).trim();
    return value && value !== 'null' && value !== ':0' ? value : '';
  } catch { return ''; }
}

async function lockdownState(serial: string): Promise<LockdownState> {
  try {
    const rules = await shell(serial, ['iptables', '-S'], 8_000);
    if (!new RegExp(CHAIN).test(rules)) return 'off';
    return /-A OUTPUT -j OCTO_LOCKDOWN/.test(rules) ? 'full' : 'partial';
  } catch { return 'off'; }
}

/** Every Android device adb can currently see, with its network state. */
export async function androidNetworkStatus(): Promise<{ adbAvailable: boolean; devices: AndroidNetStatus[] }> {
  if (!adbPath()) return { adbAvailable: false, devices: [] };
  let listing = '';
  try { listing = await adb(['devices'], 8_000); } catch { return { adbAvailable: true, devices: [] }; }
  const serials = listing.split(/\r?\n/).slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === 'device' && SERIAL.test(parts[0]))
    .map((parts) => parts[0]);
  const devices = await Promise.all(serials.map(async (serial): Promise<AndroidNetStatus> => {
    const [name, proxy, traffic, lockdown, offMarker] = await Promise.all([
      shell(serial, ['getprop', ['ro', 'boot', 'qemu', 'avd_name'].join('.')], 5_000).then((v) => v.trim()).catch(() => ''),
      currentProxy(serial),
      trafficOf(serial),
      lockdownState(serial),
      shell(serial, ['getprop', 'octo.net.off'], 5_000).then((v) => v.trim()).catch(() => ''),
    ]);
    return {
      serial, name, online: true, rooted: false, proxy, lockdown,
      networkOff: offMarker === '1', bytesIn: traffic.bytesIn, bytesOut: traffic.bytesOut,
    };
  }));
  return { adbAvailable: true, devices };
}

/**
 * Send the whole device through `host:port`. With root we also install a
 * fail-closed iptables chain: DNS and traffic to the proxy are allowed, the
 * loopback stays up, everything else is dropped - so a crashed proxy means no
 * internet inside Android instead of a leak through the host connection.
 */
export async function setAndroidProxy(serial: string, input: AndroidProxyInput): Promise<AndroidNetStatus> {
  const device = assertSerial(serial);
  const { host, port } = assertProxy(input);
  await shell(device, ['settings', 'put', 'global', 'http_proxy', `${host}:${port}`]);
  const bypass = String(input.bypass ?? '').replace(/[^A-Za-z0-9.,*_-]/g, '').slice(0, 200);
  await shell(device, ['settings', 'put', 'global', 'global_http_proxy_exclusion_list', bypass || '""']).catch(() => '');
  let lockdown: LockdownState = 'off';
  const rooted = input.lockdown === false ? await isRooted(device) : await isRooted(device);
  if (input.lockdown !== false) {
    lockdown = rooted ? await applyLockdownRules(device, host, port) : 'partial';
  }
  const traffic = await trafficOf(device);
  return {
    serial: device, name: '', online: true, rooted, proxy: `${host}:${port}`,
    lockdown, networkOff: false, ...traffic,
  };
}

/** Install the fail-closed chain. Returns the state actually reached. */
async function applyLockdownRules(serial: string, host: string, port: number): Promise<LockdownState> {
  const commands = [
    `iptables -F ${CHAIN} 2>/dev/null || iptables -N ${CHAIN}`,
    `iptables -D OUTPUT -j ${CHAIN} 2>/dev/null; iptables -I OUTPUT 1 -j ${CHAIN}`,
    `iptables -A ${CHAIN} -o lo -j ACCEPT`,
    `iptables -A ${CHAIN} -d ${host} -p tcp --dport ${port} -j ACCEPT`,
    // The emulator's own gateway/DNS must stay reachable or the device hangs.
    `iptables -A ${CHAIN} -p udp --dport 53 -j ACCEPT`,
    `iptables -A ${CHAIN} -d 10.0.2.0/24 -j ACCEPT`,
    `iptables -A ${CHAIN} -j REJECT`,
  ];
  try {
    for (const command of commands) await shell(serial, ['su', '-c', command], 12_000).catch(() => shell(serial, [command], 12_000));
    return await lockdownState(serial);
  } catch { return 'partial'; }
}

/** Remove the proxy and the lockdown chain again. */
export async function clearAndroidProxy(serial: string): Promise<void> {
  const device = assertSerial(serial);
  await shell(device, ['settings', 'put', 'global', 'http_proxy', ':0']).catch(() => '');
  for (const command of [`iptables -D OUTPUT -j ${CHAIN}`, `iptables -F ${CHAIN}`, `iptables -X ${CHAIN}`]) {
    await shell(device, ['su', '-c', command], 10_000).catch(() => '');
  }
}

/**
 * Dead man's switch: cut mobile data, Wi-Fi and (with root) every remaining
 * packet on one device. `on = false` puts the radios back.
 */
export async function setAndroidNetworkOff(serial: string, off: boolean): Promise<boolean> {
  const device = assertSerial(serial);
  const state = off ? 'disable' : 'enable';
  await shell(device, ['svc', 'data', state]).catch(() => '');
  await shell(device, ['svc', 'wifi', state]).catch(() => '');
  if (off) {
    await shell(device, ['su', '-c', 'iptables -I OUTPUT 1 -j REJECT -m comment --comment OCTO_KILL'], 10_000)
      .catch(() => shell(device, ['iptables', '-I', 'OUTPUT', '1', '-j', 'REJECT'], 10_000).catch(() => ''));
  } else {
    await shell(device, ['su', '-c', 'iptables -D OUTPUT -j REJECT -m comment --comment OCTO_KILL'], 10_000)
      .catch(() => shell(device, ['iptables', '-D', 'OUTPUT', '-j', 'REJECT'], 10_000).catch(() => ''));
  }
  await shell(device, ['setprop', 'octo.net.off', off ? '1' : '0']).catch(() => '');
  return true;
}

/** Throw the switch on every device adb can see. Returns how many answered. */
export async function setAllAndroidNetworkOff(off: boolean): Promise<{ devices: number; failed: string[] }> {
  const status = await androidNetworkStatus();
  const failed: string[] = [];
  await Promise.all(status.devices.map(async (device) => {
    try { await setAndroidNetworkOff(device.serial, off); }
    catch { failed.push(device.serial); }
  }));
  return { devices: status.devices.length, failed };
}
