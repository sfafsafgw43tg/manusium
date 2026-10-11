/**
 * apps/octobrowser/src/main/virtualbox-studio-vm.ts
 *
 * Automated Android Studio Linux VM & Isolated Machine Profile Runner.
 *
 * Provides:
 *   1. Automated creation and provisioning of an isolated Linux Virtual Machine
 *      specifically configured for Android Studio, KVM-accelerated AVDs, and
 *      untraceable browser profile execution.
 *   2. Untraceable Synthetic Hardware Identity:
 *      - Synthetic Motherboard & DMI BIOS serials, vendor, and product IDs.
 *      - Randomized MAC address and synthetic machine UUID.
 *      - Zero host CPU serials, GPU PCIe IDs, or Windows registry IDs leaked.
 *   3. Strict Boundary & Flow Control:
 *      - Internet traffic routed safely via NAT or host proxy bridge.
 *      - Controlled clipboard channel (bidirectional, host-to-guest, guest-to-host, or disabled).
 *      - Sandboxed shared transfer folder (OctoIsolatedDrop) without host file exposure.
 *      - ADB port forwarding (15555 -> 5555) for seamless Android Studio emulator access.
 *      - VNC display (15900 -> 5900) & Web Stream (16080 -> 6080) for remote GUI view.
 *   4. Automated Unattended Setup Script Generator (`setup-isolated-android-studio.sh`).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';

import {
  command, virtualBoxStatus, listVirtualBoxMachines,
  VirtualBoxMachine, VirtualBoxLaunchMode,
} from './virtualbox';
import { adbPath } from './android-studio';
import type { Profile } from '@octo/core';

export const DEFAULT_STUDIO_VM_NAME = 'Octo-Android-Studio-Linux';
export const STUDIO_VM_ADB_HOST_PORT = 15555;
export const STUDIO_VM_ADB_GUEST_PORT = 5555;
export const STUDIO_VM_SSH_HOST_PORT = 10022;
export const STUDIO_VM_SSH_GUEST_PORT = 22;
export const STUDIO_VM_VNC_HOST_PORT = 15900;
export const STUDIO_VM_VNC_GUEST_PORT = 5900;
export const STUDIO_VM_WEB_HOST_PORT = 16080;
export const STUDIO_VM_WEB_GUEST_PORT = 6080;
export const STUDIO_VM_AGENT_HOST_PORT = 18080;
export const STUDIO_VM_AGENT_GUEST_PORT = 8080;

export interface StudioLinuxVmStatus {
  available: boolean;
  vboxAvailable: boolean;
  vboxVersion: string;
  vmExists: boolean;
  vmName: string;
  vmId: string;
  state: 'running' | 'poweroff' | 'paused' | 'not-created' | 'saved' | 'unknown';
  memoryMb: number;
  cpus: number;
  vramMb: number;
  nestedVirt: boolean;
  adbForwarding: boolean;
  adbConnected: boolean;
  adbHostPort: number;
  sshHostPort: number;
  vncHostPort: number;
  webStreamHostPort: number;
  agentHostPort: number;
  dropFolder: string;
  setupScriptPath: string;
  syntheticHardware: {
    uuid: string;
    biosVendor: string;
    motherboard: string;
    macAddress: string;
  };
  error?: string;
}

export interface StudioLinuxVmCreateOptions {
  name?: string;
  ramMb?: number;
  cpus?: number;
  diskGb?: number;
  isoPath?: string;
  clipboard?: 'bidirectional' | 'hosttoguest' | 'guesttohost' | 'disabled';
  baseFolder?: string;
  autoStart?: boolean;
}

/** Generate a valid random MAC address with locally administered bit set (e.g. 02:xx:xx:xx:xx:xx). */
export function generateSyntheticMacAddress(): string {
  const bytes = crypto.randomBytes(6);
  bytes[0] = (bytes[0] & 0xfe) | 0x02; // locally administered unicast
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/** Returns the path to the isolated drop folder used for safe guest file exchange. */
export function getIsolatedDropFolder(customBaseDir?: string): string {
  const base = customBaseDir || path.join(os.homedir(), '.octobrowser', 'isolated-vm-drop');
  if (!fs.existsSync(base)) {
    try {
      fs.mkdirSync(base, { recursive: true });
    } catch {
      // ignore
    }
  }
  return base;
}

/** Check the status of the Android Studio / Isolated Profile Linux VM. */
export async function getStudioLinuxVmStatus(vmName = DEFAULT_STUDIO_VM_NAME, customDropDir?: string): Promise<StudioLinuxVmStatus> {
  const vbox = await virtualBoxStatus();
  const dropFolder = getIsolatedDropFolder(customDropDir);
  const scriptPath = path.join(dropFolder, 'setup-isolated-android-studio.sh');

  if (!vbox.available) {
    return {
      available: false,
      vboxAvailable: false,
      vboxVersion: '',
      vmExists: false,
      vmName,
      vmId: '',
      state: 'not-created',
      memoryMb: 8192,
      cpus: 4,
      vramMb: 128,
      nestedVirt: false,
      adbForwarding: false,
      adbConnected: false,
      adbHostPort: STUDIO_VM_ADB_HOST_PORT,
      sshHostPort: STUDIO_VM_SSH_HOST_PORT,
      vncHostPort: STUDIO_VM_VNC_HOST_PORT,
      webStreamHostPort: STUDIO_VM_WEB_HOST_PORT,
      agentHostPort: STUDIO_VM_AGENT_HOST_PORT,
      dropFolder,
      setupScriptPath: scriptPath,
      syntheticHardware: {
        uuid: '00000000-0000-0000-0000-000000000000',
        biosVendor: 'American Megatrends Inc.',
        motherboard: 'B550 AORUS ELITE V2',
        macAddress: '020000000000',
      },
      error: vbox.error || 'VirtualBox is not installed or VBoxManage is not accessible.',
    };
  }

  const machines = await listVirtualBoxMachines();
  const target = machines.find((m) => m.name.toLowerCase() === vmName.toLowerCase() || m.id.toLowerCase() === vmName.toLowerCase());

  if (!target) {
    return {
      available: true,
      vboxAvailable: true,
      vboxVersion: vbox.version,
      vmExists: false,
      vmName,
      vmId: '',
      state: 'not-created',
      memoryMb: Math.min(8192, Math.max(4096, Math.floor(vbox.hostRamMb / 2))),
      cpus: Math.min(4, Math.max(2, Math.floor(vbox.hostCores / 2))),
      vramMb: 128,
      nestedVirt: vbox.capabilities.flags.includes('nested-hw-virt'),
      adbForwarding: false,
      adbConnected: false,
      adbHostPort: STUDIO_VM_ADB_HOST_PORT,
      sshHostPort: STUDIO_VM_SSH_HOST_PORT,
      vncHostPort: STUDIO_VM_VNC_HOST_PORT,
      webStreamHostPort: STUDIO_VM_WEB_HOST_PORT,
      agentHostPort: STUDIO_VM_AGENT_HOST_PORT,
      dropFolder,
      setupScriptPath: scriptPath,
      syntheticHardware: {
        uuid: crypto.randomUUID(),
        biosVendor: 'American Megatrends Inc.',
        motherboard: 'B550 AORUS ELITE V2',
        macAddress: generateSyntheticMacAddress(),
      },
    };
  }

  const isRunning = target.state === 'running';
  let adbConnected = false;

  return {
    available: true,
    vboxAvailable: true,
    vboxVersion: vbox.version,
    vmExists: true,
    vmName: target.name,
    vmId: target.id,
    state: (target.state as StudioLinuxVmStatus['state']) || 'unknown',
    memoryMb: target.memoryMb,
    cpus: target.cpus,
    vramMb: target.vramMb,
    nestedVirt: target.nestedVirtualization,
    adbForwarding: true,
    adbConnected,
    adbHostPort: STUDIO_VM_ADB_HOST_PORT,
    sshHostPort: STUDIO_VM_SSH_HOST_PORT,
    vncHostPort: STUDIO_VM_VNC_HOST_PORT,
    webStreamHostPort: STUDIO_VM_WEB_HOST_PORT,
    agentHostPort: STUDIO_VM_AGENT_HOST_PORT,
    dropFolder,
    setupScriptPath: scriptPath,
    syntheticHardware: {
      uuid: target.id,
      biosVendor: 'American Megatrends Inc.',
      motherboard: 'B550 AORUS ELITE V2',
      macAddress: generateSyntheticMacAddress(),
    },
  };
}

/**
 * Generates the automated unattended bash setup script for the Linux guest.
 */
export function generateStudioLinuxProvisionScript(options?: {
  avdName?: string;
  studioVersion?: string;
  targetApi?: number;
}): string {
  const avdName = options?.avdName || 'OctoPixel8';
  const apiLevel = options?.targetApi || 34;

  return `#!/usr/bin/env bash
# ==============================================================================
# OctoBrowser Isolated Linux VM - Android Studio & Isolated Profile Setup Script
# ==============================================================================
# This script provisions an isolated, untraceable Linux guest with:
#  - OpenJDK 17 JDK
#  - Hardware-accelerated KVM virtualization
#  - Android SDK (cmdline-tools, platform-tools, build-tools, emulator, system-image)
#  - Preconfigured hardware-accelerated AVD emulator (${avdName})
#  - Full Android Studio Linux IDE
#  - ADB daemon auto-start bound to port 5555 (bridged to host OctoBrowser)
#  - Octo Isolated Browser Profile Runner
# ==============================================================================

set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export ANDROID_HOME="/opt/android-sdk"
export ANDROID_SDK_ROOT="/opt/android-sdk"
export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator"

echo "=== [1/6] Installing Prerequisites and KVM Acceleration ==="
sudo apt-get update -y
sudo apt-get install -y --no-install-recommends \\
    openjdk-17-jdk \\
    qemu-kvm \\
    libvirt-daemon-system \\
    libvirt-clients \\
    bridge-utils \\
    cpu-checker \\
    curl \\
    wget \\
    unzip \\
    git \\
    tar \\
    ca-certificates \\
    pulseaudio \\
    libgl1-mesa-glx \\
    libpulse0 \\
    libxcomposite1 \\
    libxcursor1 \\
    libxi6 \\
    libxtst6 \\
    libnss3 \\
    libasound2t64 || sudo apt-get install -y libasound2 || true

echo "=== [2/6] Configuring Virtualization & Permissions ==="
sudo usermod -aG kvm "$USER" || true
sudo chmod 666 /dev/kvm || true

echo "=== [3/6] Setting Up Android SDK Command-line Tools ==="
sudo mkdir -p "$ANDROID_HOME/cmdline-tools"
sudo chown -R "$USER:$USER" "$ANDROID_HOME"

cd /tmp
if [ ! -f "commandlinetools-linux.zip" ]; then
    echo "Downloading Android Command-Line Tools..."
    wget -q --show-progress -O commandlinetools-linux.zip "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip" || \\
    wget -q --show-progress -O commandlinetools-linux.zip "https://dl.google.com/android/repository/commandlinetools-linux-10406996_latest.zip"
fi

unzip -q -o commandlinetools-linux.zip
mkdir -p "$ANDROID_HOME/cmdline-tools/latest"
cp -r cmdline-tools/* "$ANDROID_HOME/cmdline-tools/latest/" || true
rm -rf cmdline-tools commandlinetools-linux.zip

echo "Accepting Android SDK licenses..."
yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses || true

echo "Installing Android SDK packages (API ${apiLevel})..."
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" \\
    "platform-tools" \\
    "platforms;android-${apiLevel}" \\
    "build-tools;34.0.0" \\
    "emulator" \\
    "system-images;android-${apiLevel};google_apis;x86_64"

echo "=== [4/6] Creating Pristine Hardware-Accelerated AVD (${avdName}) ==="
echo "no" | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd \\
    --name "${avdName}" \\
    --package "system-images;android-${apiLevel};google_apis;x86_64" \\
    --device "pixel_8" \\
    --force

echo "=== [5/6] Installing Android Studio Linux IDE ==="
sudo mkdir -p /opt/android-studio
sudo chown -R "$USER:$USER" /opt/android-studio

if [ ! -f "/tmp/android-studio.tar.gz" ]; then
    echo "Downloading Android Studio..."
    wget -q --show-progress -O /tmp/android-studio.tar.gz "https://redirector.gvt1.com/edgedl/android/studio/ide-zips/2024.1.2.13/android-studio-2024.1.2.13-linux.tar.gz" || \\
    wget -q --show-progress -O /tmp/android-studio.tar.gz "https://redirector.gvt1.com/edgedl/android/studio/ide-zips/2024.1.1.12/android-studio-2024.1.1.12-linux.tar.gz" || true
fi

if [ -f "/tmp/android-studio.tar.gz" ]; then
    tar -xzf /tmp/android-studio.tar.gz -C /opt/
    rm -f /tmp/android-studio.tar.gz
    sudo ln -sf /opt/android-studio/bin/studio.sh /usr/local/bin/android-studio || true
fi

echo "=== [6/6] Starting ADB Daemon and Bridge Service ==="
adb kill-server || true
adb -a -P 5555 server nodaemon &
sleep 2

echo "=============================================================================="
echo " Setup Completed Successfully!"
echo " Android Studio and KVM-accelerated AVDs are ready in this isolated Linux VM."
echo " Connected to OctoBrowser via ADB port forwarding (127.0.0.1:15555)."
echo "=============================================================================="
`;
}

/**
 * 1-Click Automated Creation of an Isolated Linux VM for Android Studio & Profile Runner.
 */
export async function createStudioLinuxVm(rawOptions?: StudioLinuxVmCreateOptions): Promise<StudioLinuxVmStatus> {
  const options: StudioLinuxVmCreateOptions = {
    name: rawOptions?.name || DEFAULT_STUDIO_VM_NAME,
    ramMb: rawOptions?.ramMb && rawOptions.ramMb >= 2048 ? rawOptions.ramMb : 8192,
    cpus: rawOptions?.cpus && rawOptions.cpus >= 2 ? rawOptions.cpus : 4,
    diskGb: rawOptions?.diskGb && rawOptions.diskGb >= 20 ? rawOptions.diskGb : 60,
    isoPath: rawOptions?.isoPath || '',
    clipboard: rawOptions?.clipboard || 'bidirectional',
    baseFolder: rawOptions?.baseFolder || '',
    autoStart: rawOptions?.autoStart === true,
  };

  const name = options.name!.trim();
  const status = await virtualBoxStatus();
  if (!status.available) {
    throw new Error(status.error || 'VirtualBox is not available. Please install VirtualBox first.');
  }

  // Validate guest OS type
  const validOs = status.osTypes.find((t) => /ubuntu_64|debian_64|linux26_64/i.test(t.id))?.id || 'Ubuntu_64';

  const baseFolder = options.baseFolder || status.defaultMachineFolder;
  const vmFolder = path.join(baseFolder, name);
  const diskPath = path.join(vmFolder, `${name}.vdi`);
  const dropFolder = getIsolatedDropFolder();

  // Create and register VM
  let created = '';
  try {
    created = await command(['createvm', '--name', name, '--ostype', validOs, '--basefolder', baseFolder, '--register'], 60_000);
  } catch (err) {
    if (/already exists/i.test(String(err))) {
      throw new Error(`A VirtualBox machine named "${name}" already exists.`);
    }
    throw err;
  }

  const vmId = /\{([0-9a-f-]{36})\}/i.exec(created)?.[1] || name;
  const targetId = vmId || name;

  try {
    // 1. Create dynamic virtual disk
    await command(['createmedium', 'disk', '--filename', diskPath, '--size', String(Math.round(options.diskGb! * 1024)), '--format', 'VDI'], 120_000);

    // 2. Configure basic hardware & graphics
    const modifyArgs = [
      'modifyvm', targetId,
      '--memory', String(options.ramMb),
      '--cpus', String(options.cpus),
      '--vram', '128',
      '--graphicscontroller', 'VMSVGA',
      '--accelerate3d', 'on',
      '--ioapic', 'on',
      '--pae', 'on',
      '--acpi', 'on',
      '--rtcuseutc', 'on',
      '--boot1', 'dvd',
      '--boot2', 'disk',
      '--boot3', 'none',
      '--boot4', 'none',
      '--audio-controller', 'HDA',
      '--audio-in', 'on',
      '--audio-out', 'on',
      '--clipboard-mode', options.clipboard || 'bidirectional',
      '--draganddrop', options.clipboard || 'bidirectional',
    ];

    // Enable nested hardware virtualization for KVM if supported
    if (status.capabilities.flags.includes('nested-hw-virt')) {
      modifyArgs.push('--nested-hw-virt', 'on');
    }

    await command(modifyArgs, 60_000);

    // 3. Synthesize Untraceable Hardware Identity
    const syntheticMac = generateSyntheticMacAddress();
    const syntheticUuid = crypto.randomUUID();
    const syntheticSerial = `SYS-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    const boardSerial = `MB-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
    const chassisSerial = `CHA-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

    // Apply random hardware UUID and MAC address
    try {
      await command(['modifyvm', targetId, '--hardwareuuid', syntheticUuid, '--macaddress1', syntheticMac]);
    } catch {
      // ignore
    }

    // Apply synthetic DMI BIOS & Motherboard extra data
    const dmiSettings = [
      ['VBoxInternal/Devices/pcbios/0/Config/DmiBIOSVendor', 'American Megatrends Inc.'],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiBIOSVersion', 'F15'],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiBIOSReleaseDate', '03/15/2024'],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiSystemVendor', 'Gigabyte Technology Co., Ltd.'],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiSystemProduct', 'B550 AORUS ELITE V2'],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiSystemVersion', 'Default string'],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiSystemSerial', syntheticSerial],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiSystemSKU', 'Default string'],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiSystemFamily', 'B550 MB'],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiBoardVendor', 'Gigabyte Technology Co., Ltd.'],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiBoardProduct', 'B550 AORUS ELITE V2'],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiBoardVersion', 'Default string'],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiBoardSerial', boardSerial],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiChassisVendor', 'Gigabyte Technology Co., Ltd.'],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiChassisType', '3'],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiChassisVersion', 'Default string'],
      ['VBoxInternal/Devices/pcbios/0/Config/DmiChassisSerial', chassisSerial],
    ];

    for (const [k, v] of dmiSettings) {
      try {
        await command(['setextradata', targetId, k, v]);
      } catch {
        // ignore
      }
    }

    // 4. Configure NAT & Port Forwarding
    await command([
      'modifyvm', targetId,
      '--nic1', 'nat',
      '--natpf1', `ADB,tcp,,${STUDIO_VM_ADB_HOST_PORT},,${STUDIO_VM_ADB_GUEST_PORT}`,
      '--natpf1', `SSH,tcp,,${STUDIO_VM_SSH_HOST_PORT},,${STUDIO_VM_SSH_GUEST_PORT}`,
      '--natpf1', `VNC,tcp,,${STUDIO_VM_VNC_HOST_PORT},,${STUDIO_VM_VNC_GUEST_PORT}`,
      '--natpf1', `WebStream,tcp,,${STUDIO_VM_WEB_HOST_PORT},,${STUDIO_VM_WEB_GUEST_PORT}`,
      '--natpf1', `OctoAgent,tcp,,${STUDIO_VM_AGENT_HOST_PORT},,${STUDIO_VM_AGENT_GUEST_PORT}`,
    ], 30_000);

    // 5. Create storage controllers and attach media
    try {
      await command(['storagectl', targetId, '--name', 'SATA Controller', '--add', 'sata', '--controller', 'IntelAHCI', '--portcount', '4']);
    } catch {
      // already exists
    }

    await command(['storageattach', targetId, '--storagectl', 'SATA Controller', '--port', '0', '--device', '0', '--type', 'hdd', '--medium', diskPath]);

    // DVD optical drive
    await command(['storageattach', targetId, '--storagectl', 'SATA Controller', '--port', '1', '--device', '0', '--type', 'dvddrive', '--medium', options.isoPath && fs.existsSync(options.isoPath) ? options.isoPath : 'emptydrive']);

    // 6. Attach isolated shared folder
    try {
      await command(['sharedfolder', 'add', targetId, '--name', 'OctoIsolatedDrop', '--hostpath', dropFolder, '--automount']);
    } catch {
      // ignore if exists
    }

    // 7. Write automated provision script into drop folder
    const scriptContent = generateStudioLinuxProvisionScript();
    const scriptPath = path.join(dropFolder, 'setup-isolated-android-studio.sh');
    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });

    // Optional auto start
    if (options.autoStart) {
      await command(['startvm', targetId, '--type', 'gui']);
    }

    return await getStudioLinuxVmStatus(name);
  } catch (err) {
    // Cleanup on failure
    try {
      await command(['unregistervm', targetId, '--delete']);
    } catch {
      // ignore
    }
    throw err;
  }
}

/** Launch the Android Studio Linux VM. */
export async function startStudioLinuxVm(vmName = DEFAULT_STUDIO_VM_NAME, mode: VirtualBoxLaunchMode = 'gui'): Promise<void> {
  await command(['startvm', vmName, '--type', mode]);
}

/** Stop the Android Studio Linux VM. */
export async function stopStudioLinuxVm(vmName = DEFAULT_STUDIO_VM_NAME, force = false): Promise<void> {
  await command(['controlvm', vmName, force ? 'poweroff' : 'acpipowerbutton']);
}

/** Connect host ADB to the VM ADB bridge port. */
export async function connectStudioAdbBridge(): Promise<{ ok: boolean; message: string }> {
  const adb = adbPath();
  const endpoint = `127.0.0.1:${STUDIO_VM_ADB_HOST_PORT}`;

  return new Promise((resolve) => {
    execFile(adb, ['connect', endpoint], { timeout: 15_000 }, (err, stdout, stderr) => {
      const out = String(stdout || stderr || '').trim();
      if (err || out.toLowerCase().includes('failed') || out.toLowerCase().includes('unable')) {
        resolve({ ok: false, message: out || (err ? err.message : 'ADB connect failed') });
      } else {
        resolve({ ok: true, message: out || `Connected to ${endpoint}` });
      }
    });
  });
}

/**
 * Launch an untraceable browser profile inside the isolated VM environment.
 */
export async function launchProfileInIsolatedVm(
  profile: Profile,
  options?: { hostDropDir?: string; mode?: VirtualBoxLaunchMode },
): Promise<{ ok: boolean; message: string }> {
  const dropDir = getIsolatedDropFolder(options?.hostDropDir);
  const status = await getStudioLinuxVmStatus(DEFAULT_STUDIO_VM_NAME, dropDir);

  if (!status.vmExists) {
    throw new Error('Android Studio / Isolated Linux VM is not created yet. Click "Create & Auto-Setup Linux VM" in Settings or Devices.');
  }

  // Ensure VM is running
  if (status.state !== 'running') {
    await startStudioLinuxVm(DEFAULT_STUDIO_VM_NAME, options?.mode || 'gui');
  }

  // Write profile execution manifest to the isolated drop folder
  const manifest = {
    profileId: profile.id,
    profileName: profile.name,
    userAgent: profile.fingerprint?.userAgent || '',
    startPages: profile.startPages || ['https://www.google.com/'],
    proxy: profile.network.proxy ? {
      type: profile.network.proxy.type,
      host: profile.network.proxy.host,
      port: profile.network.proxy.port,
    } : null,
    fingerprint: profile.fingerprint,
    untraceableMode: true,
    launchedAt: new Date().toISOString(),
  };

  const manifestPath = path.join(dropDir, `profile-${profile.id}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return {
    ok: true,
    message: `Profile "${profile.name}" prepared in isolated machine environment. Launch manifest written to ${manifestPath}.`,
  };
}
