import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DataLayout } from '../src/paths';

const roots: string[] = [];
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-paths-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('DataLayout', () => {
  it('creates the diagnostics errors folder with the application data layout', () => {
    const layout = new DataLayout(path.join(tempRoot(), 'OctoBrowser'));
    layout.ensure();
    expect(fs.statSync(layout.errors).isDirectory()).toBe(true);
  });

  it('resolves an explicitly selected profile directory without changing other profiles', () => {
    const layout = new DataLayout(path.join(tempRoot(), 'OctoBrowser'));
    const selected = path.join(tempRoot(), 'ExternalProfile');
    layout.setProfileDirectory('p-one', selected);
    expect(layout.profileDir('p-one')).toBe(path.resolve(selected));
    expect(layout.profileDir('p-two')).toBe(path.join(layout.profiles, 'p-two'));
    layout.setProfileDirectory('p-one');
    expect(layout.profileDir('p-one')).toBe(path.join(layout.profiles, 'p-one'));
  });
});
