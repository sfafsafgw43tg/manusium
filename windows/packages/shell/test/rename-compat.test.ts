/**
 * The product was renamed from OctoBrowser.su to Octo.su. A machine that was
 * set up under the old name keeps its language and its data folder: the
 * bootstrap file is still read from the previous %APPDATA% folder when the
 * new one does not exist yet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { APPS } from '@octo/core';

const APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-rename-'));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'appData' ? APPDATA : path.join(APPDATA, name)),
    setName: () => {},
    setAppUserModelId: () => {},
  },
}));

const load = async () => (await import('../src/prepare')).bootstrapFileFor;

afterEach(() => {
  for (const dir of ['Octo.su', 'OctoBrowser.su']) fs.rmSync(path.join(APPDATA, dir), { recursive: true, force: true });
});

describe('renaming OctoBrowser.su to Octo.su', () => {
  it('keeps the new name as the home of the bootstrap file', async () => {
    const bootstrapFileFor = await load();
    expect(APPS.octobrowser.productName).toBe('Octo.su');
    expect(APPS.octobrowser.bootstrapDirName).toBe('Octo.su');
    expect(bootstrapFileFor(APPS.octobrowser, false)).toBe(path.join(APPDATA, 'Octo.su', 'bootstrap.json'));
  });

  it('still reads an installation made under the old name', async () => {
    const bootstrapFileFor = await load();
    const legacy = path.join(APPDATA, 'OctoBrowser.su');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'bootstrap.json'), '{"schema":1,"language":"pl"}');
    expect(bootstrapFileFor(APPS.octobrowser, false)).toBe(path.join(legacy, 'bootstrap.json'));

    // Once the new file exists it wins, so nothing keeps pointing backwards.
    const current = path.join(APPDATA, 'Octo.su');
    fs.mkdirSync(current, { recursive: true });
    fs.writeFileSync(path.join(current, 'bootstrap.json'), '{"schema":1,"language":"en"}');
    expect(bootstrapFileFor(APPS.octobrowser, false)).toBe(path.join(current, 'bootstrap.json'));
  });

  it('never changes the data folder, so no profile is left behind', () => {
    expect(APPS.octobrowser.dataSubdir).toBe('OctoBrowser');
    expect(APPS.octobrowser.appUserModelId).toBe('su.octo.browser');
  });
});
