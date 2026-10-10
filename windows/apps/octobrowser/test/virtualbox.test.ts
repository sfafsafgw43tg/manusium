/**
 * VirtualBox parsing for the Android Studio Linux VM. The Android-x86 VM engine
 * was removed with the rest of the non-AVD emulators, so only the readers that
 * the Studio VM still uses are covered here.
 */
import { afterAll, describe, expect, it } from 'vitest';
import {
  machineReadableFirst,
  machineReadableValue,
  parseVirtualBoxCapabilities,
  parseVirtualBoxOsTypes,
  resetVirtualBoxCapabilities,
  virtualBoxCapabilities,
} from '../src/main/virtualbox';

afterAll(() => resetVirtualBoxCapabilities());

describe('machine-readable VBoxManage output', () => {
  it('parses values with escaped quotes and Windows paths', () => {
    expect(machineReadableValue('name="Android \\\"Lab\\\""\nCfgFile="C:\\\\VMs\\\\android\\\\android.vbox"', 'name'))
      .toBe('Android "Lab"');
    expect(machineReadableValue('CfgFile="C:\\\\VMs\\\\android\\\\android.vbox"', 'CfgFile'))
      .toBe('C:\\VMs\\android\\android.vbox');
  });

  it('reads the first key that is present and ignores the rest', () => {
    expect(machineReadableFirst('VMState="running"\nSessionState="unlocked"', ['VMState'])).toBe('running');
    expect(machineReadableFirst('SessionState="unlocked"', ['VMState', 'SessionState'])).toBe('unlocked');
    expect(machineReadableFirst('name="x"', ['VMState'])).toBe('');
  });

  it('reads the nested-virtualization and video-memory keys the Studio VM relies on', () => {
    const output = 'vram=128\nnested-hw-virt="on"\nmemory=8192';
    expect(machineReadableValue(output, 'vram')).toBe('128');
    expect(machineReadableValue(output, 'nested-hw-virt')).toBe('on');
  });
});

describe('guest OS types', () => {
  it('lists the supported guest OS types and drops entries without a description', () => {
    expect(parseVirtualBoxOsTypes('ID: Linux_64\nDescription: Linux (64-bit)\n\nID: Windows11_64\nDescription: Windows 11 (64-bit)\n\nID: Orphan'))
      .toEqual([{ id: 'Linux_64', description: 'Linux (64-bit)' }, { id: 'Windows11_64', description: 'Windows 11 (64-bit)' }]);
  });
});

// Two releases' worth of `VBoxManage help modifyvm`, reduced to their options.
// 6 spells options as one word; 7 spells most of them with dashes.
const HELP_7 = [
  '--memory', '--cpus', '--vram', '--graphicscontroller', '--audio-enabled', '--audio-controller', '--audio-driver',
  '--audio-in', '--audio-out', '--firmware', '--pae', '--accelerate3d', '--nested-hw-virt', '--hwvirtex', '--ioapic',
  '--rtcuseutc', '--chipset', '--paravirtprovider', '--monitor-count', '--mouse', '--keyboard', '--cpuexecutioncap',
  '--bios-boot-menu', '--clipboard-mode', '--drag-and-drop', '--usb', '--usb-ehci', '--usb-xhci', '--usb-card-reader',
  '--nic1', '--nic-type1', '--bridge-adapter1', '--host-only-adapter1', '--intnet1', '--nat-pf1', '--recording',
  '--recording-file', '--recording-max-size', '--vrde', '--vrde-port',
].join(' ');
const HELP_6 = [
  '--memory', '--cpus', '--vram', '--graphicscontroller', '--audioenabled', '--audiocontroller', '--audiodriver',
  '--firmware', '--pae', '--accelerate3d', '--nestedhwvirt', '--hwvirtex', '--ioapic', '--rtcuseutc', '--chipset',
  '--paravirtprovider', '--monitorcount', '--mouse', '--keyboard', '--cpuexecutioncap', '--biosbootmenu',
  '--clipboard', '--draganddrop', '--usb', '--usbehci', '--usbxhci', '--usbcardreader', '--nic1', '--nictype1',
  '--bridgeadapter1', '--hostonlyadapter1', '--intnet1', '--natpf1', '--videocap', '--videocapfile',
  '--videocapmaxsize', '--vrde', '--vrdeport',
].join(' ');

describe('what the installed VBoxManage knows', () => {
  it('reads the release and the option list out of its own help', () => {
    const caps7 = parseVirtualBoxCapabilities('7.1.4_Ubuntu', HELP_7);
    expect(caps7).toMatchObject({ version: '7.1.4_Ubuntu', major: 7, minor: 1, probed: true });
    expect(caps7.flags).toContain('--clipboard-mode');
    // The Studio VM turns nested virtualization on only when this flag exists.
    expect(caps7.flags).toContain('--nested-hw-virt');
    const caps6 = parseVirtualBoxCapabilities('6.1.50', HELP_6);
    expect(caps6).toMatchObject({ major: 6, minor: 1, probed: true });
    expect(caps6.flags).not.toContain('--nested-hw-virt');
    expect(caps7.flags).toEqual([...new Set(caps7.flags)]);
  });

  it('claims nothing from an answer that is not help', () => {
    const nothing = parseVirtualBoxCapabilities('', 'VBoxManage: unknown command');
    expect(nothing).toMatchObject({ version: '', major: 0, minor: 0, probed: false });
    expect(nothing.flags).toEqual([]);
  });

  it('assumes everything is available when VBoxManage does not answer at all', async () => {
    const caps = await virtualBoxCapabilities(true);
    if (caps.probed) {
      expect(caps.major).toBeGreaterThan(0);
      expect(caps.flags).toContain('--memory');
    } else {
      // No VirtualBox here: nothing claimed, so no option is assumed to exist.
      expect(caps.flags.length).toBeLessThanOrEqual(20);
    }
    resetVirtualBoxCapabilities();
  });
});
