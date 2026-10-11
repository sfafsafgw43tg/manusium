import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { safeDownloadFilename, safeDownloadSource, uniqueDownloadPath } from '../src/downloads';

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Windows download path safety', () => {
  it('drops path traversal and sanitises invalid or reserved filenames', () => {
    expect(safeDownloadFilename('..\\..\\secret.txt')).toBe('secret.txt');
    expect(safeDownloadFilename('../../secret.txt')).toBe('secret.txt');
    expect(safeDownloadFilename('report<final>?.pdf. ')).toBe('report_final__.pdf');
    expect(safeDownloadFilename('CON')).toBe('_CON');
    expect(safeDownloadFilename('lpt1.txt')).toBe('_lpt1.txt');
    expect(safeDownloadFilename('...')).toBe('download');
  });

  it('uses deterministic numbered collisions without overwriting', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-download-'));
    created.push(dir);
    fs.writeFileSync(path.join(dir, 'report.pdf'), 'first');
    fs.writeFileSync(path.join(dir, 'report (1).pdf'), 'second');
    expect(uniqueDownloadPath(dir, 'report.pdf')).toBe(path.join(dir, 'report (2).pdf'));
    expect(fs.readFileSync(path.join(dir, 'report.pdf'), 'utf8')).toBe('first');
  });

  it('redacts credentials, query secrets, and fragments from displayed sources', () => {
    const shown = safeDownloadSource('https://alice:password@example.test/file.zip?token=secret#private');
    expect(shown).toBe('https://example.test/file.zip');
    expect(shown).not.toContain('alice');
    expect(shown).not.toContain('password');
    expect(shown).not.toContain('secret');
    expect(safeDownloadSource('not a URL')).toBe('');
  });
});
