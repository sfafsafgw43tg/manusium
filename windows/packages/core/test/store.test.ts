/** packages/core/test/store.test.ts - VersionedStore backups, corruption, encryption; bootstrap; logger. */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BootstrapStore, Logger, VersionedStore, generateKey, redact, validateBaseDir } from '../src';
import { tmpDir } from './helpers';

describe('VersionedStore', () => {
  const mk = (dir: string, key?: Buffer) =>
    new VersionedStore<{ n: number }>(path.join(dir, 'config', 's.json'), {
      backupDir: path.join(dir, 'backups'),
      defaults: () => ({ n: 0 }),
      keyProvider: key ? () => key : undefined,
    });

  it('creates defaults and backs up before every change', () => {
    const dir = tmpDir();
    const s = mk(dir);
    expect(s.load()).toEqual({ n: 0 });
    expect(s.lastLoadStatus).toBe('created');
    s.save({ n: 1 });
    s.save({ n: 2 });
    expect(s.listBackups().length).toBe(2);
  });

  it('detects corruption and restores the newest valid backup', () => {
    const dir = tmpDir();
    const s = mk(dir);
    s.load();
    s.save({ n: 1 });
    s.save({ n: 2 });
    fs.writeFileSync(s.file, '{"schema":1,"sha256":"00","encrypted":false,"payload":"{\\"n\\":999}"}');
    const fresh = mk(dir);
    expect(fresh.load()).toEqual({ n: 1 });
    expect(fresh.lastLoadStatus).toBe('restored-from-backup');
    expect(fs.readdirSync(path.dirname(s.file)).some((f) => f.includes('.damaged-'))).toBe(true);
  });

  it('restores a chosen backup', () => {
    const dir = tmpDir();
    const s = mk(dir);
    s.load();
    s.save({ n: 5 });
    s.save({ n: 6 });
    const oldest = s.listBackups().at(-1)!;
    s.restore(oldest);
    expect(s.load()).toEqual({ n: 0 });
    expect(() => s.restore('../../etc/passwd')).toThrow();
  });

  it('never loses a backup when several saves happen within the same millisecond', () => {
    const dir = tmpDir();
    const s = mk(dir);
    s.load();
    for (let i = 1; i <= 25; i++) s.save({ n: i });
    const names = s.listBackups();
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBe(Math.min(25, 20)); // default maxBackups = 20, all distinct
    // Newest first: the newest backup holds the state before the last save.
    s.restore(names[0]);
    expect(s.load()).toEqual({ n: 24 });
  });

  it('encrypts payload when a key provider is set', () => {
    const dir = tmpDir();
    const key = generateKey();
    const s = mk(dir, key);
    s.load();
    s.save({ n: 424242 });
    expect(fs.readFileSync(s.file, 'utf8')).not.toContain('424242');
    expect(mk(dir, key).load()).toEqual({ n: 424242 });
  });
});

describe('BootstrapStore (first run: language + folder, shown once)', () => {
  it('returns null until written, then persists language and folder', () => {
    const dir = tmpDir();
    const b = new BootstrapStore(path.join(dir, 'Octo.su', 'bootstrap.json'));
    expect(b.read()).toBeNull();
    const base = path.join(dir, 'Moje dane ąę');
    b.write({ schema: 1, language: 'pl', baseDir: base, dataDir: path.join(base, 'OctoBrowser'), firstRunAt: new Date().toISOString() });
    expect(b.read()?.language).toBe('pl');
    b.setLanguage('en');
    expect(b.read()?.language).toBe('en');
    expect(b.read()?.dataDir).toBe(path.join(base, 'OctoBrowser'));
  });

  it('treats a damaged bootstrap file as first run', () => {
    const dir = tmpDir();
    const f = path.join(dir, 'bootstrap.json');
    fs.writeFileSync(f, '{broken');
    expect(new BootstrapStore(f).read()).toBeNull();
  });

  it('validates the chosen data folder', () => {
    const dir = tmpDir();
    expect(validateBaseDir(path.join(dir, 'Nowy folder z żółwiem')).ok).toBe(true);
    expect(validateBaseDir('relative/path').ok).toBe(false);
    expect(validateBaseDir(path.parse(dir).root).ok).toBe(false);
    expect(validateBaseDir(path.join(dir, 'app', 'data'), path.join(dir, 'app')).errorKey).toBe('firstRun.err.insideInstall');
  });
});

describe('Logger redaction', () => {
  it('never writes secrets', () => {
    const cases = [
      'password=hunter2', 'token: abc.def.ghi', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.x.y',
      'socks5://user:pa55@10.0.0.1:1080', 'https://example.com/cb?code=SECRET123&state=1',
      'mail jan.kowalski@example.pl', 'key ' + 'a'.repeat(64), 'cookie=sessionid=XYZ',
    ];
    for (const c of cases) {
      const r = redact(c);
      expect(r).not.toMatch(/hunter2|abc\.def|eyJhbGci|pa55|SECRET123|jan\.kowalski|a{64}|XYZ/);
    }
  });

  it('writes, redacts meta, respects diagnostic mode and can clear logs', () => {
    const dir = tmpDir();
    const log = new Logger(dir, 'app');
    log.debug('hidden in standard');
    log.info('profile.start', { profile: 'Work', password: 'nope' });
    log.setMode('diagnostic');
    log.debug('visible now');
    const text = fs.readFileSync(log.logFile, 'utf8');
    expect(text).not.toContain('hidden in standard');
    expect(text).toContain('visible now');
    expect(text).not.toContain('nope');
    expect(log.clear()).toBeGreaterThan(0);
  });

  it('supports no local logging and clears stale local log files after 24 hours', () => {
    const dir = tmpDir();
    const log = new Logger(dir, 'quiet');
    log.setMode('off');
    log.info('must not reach disk');
    expect(fs.existsSync(log.logFile)).toBe(false);
    const old = path.join(dir, 'old.log');
    fs.writeFileSync(old, 'old');
    const then = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(old, then, then);
    expect(log.clearExpired()).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
  });
});
