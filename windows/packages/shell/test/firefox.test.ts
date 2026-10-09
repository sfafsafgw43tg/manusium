import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { firefoxAvailability } from '../src/winutil';
import { inspectFirefoxRuntime } from '../src/gecko-runtime';

describe('Firefox discovery', () => {
  it('does not execute or accept relative configured paths', () => {
    const result = firefoxAvailability('relative/firefox');
    expect(result.available).toBe(false);
    expect(result.path).toBeNull();
    expect(result.reason).toBe('invalid-path');
  });

  it('reports missing verified runtime state without accepting arbitrary executables', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-gecko-diagnostic-'));
    try {
      const status = inspectFirefoxRuntime(path.join(root, 'resources'), path.join(root, 'user'));
      expect(status.executable).toBeNull();
      expect(['user-missing', 'unsupported-platform']).toContain(status.reason);
      expect(status.packaged).toBe('missing');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
