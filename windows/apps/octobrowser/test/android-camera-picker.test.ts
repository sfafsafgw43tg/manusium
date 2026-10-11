import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..', '..');
const picker = fs.readFileSync(path.join(root, 'apps/octobrowser/src/renderer/launcher-android-cameras.ts'), 'utf8');

describe('the camera picker follows the cameras by itself', () => {
  it('rescans when a camera is plugged in or removed, once the changes settle', () => {
    expect(picker).toContain("navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);");
    expect(picker).toContain('deviceSettle = setTimeout(() => void scan(false), 700);');
  });

  it('does nothing while the picker is not on screen', () => {
    expect(picker).toContain('if (!element.isConnected) return;');
  });

  it('keeps the manual Refresh button', () => {
    expect(picker).toContain('refreshButton.onclick = () => void scan(true);');
  });
});
