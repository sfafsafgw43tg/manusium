/**
 * e2e/octodetect.spec.ts - OctoDetect.su end-to-end tests (real Electron).
 *
 * Runs real audits against the local probe server: the unprotected baseline
 * and the OctoBrowser "strict" preset, checks the report structure, that the
 * strict preset does not expose more than the baseline, and that stored
 * reports are encrypted on disk.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeApp, dumpLogs, invoke, launchApp, listFiles, Launched, windowWithPage } from './helpers';

interface Finding { id: string; status: string; points: number }
interface Report { id: string; target: string; risk: string; score: number; findings: Finding[]; uniqueness: string }

let l: Launched;

test.beforeAll(async () => {
  l = await launchApp('octodetect', 'en');
});

// On failure print the app's own (redacted) logs - the only view into the app on CI.
test.afterEach(async ({}, testInfo) => {
  if (l && testInfo.status !== testInfo.expectedStatus) console.log(`[e2e] logs after "${testInfo.title}":\n${dumpLogs(l.dataDir)}`);
});

test.afterAll(async () => {
  if (l) await closeApp(l);
});

test('main window opens directly in English', async () => {
  const win = await windowWithPage(l.app, 'detect.html');
  const init = await invoke<{ lang: string }>(win, 'od:init');
  expect(init.lang).toBe('en');
  await expect(invoke(win, 'mgr:init')).rejects.toThrow(/not allowed/);
});

test('baseline and strict audits produce consistent reports', async () => {
  const win = await windowWithPage(l.app, 'detect.html');
  const baseline = await invoke<Report>(win, 'od:audit', 'baseline');
  const strict = await invoke<Report>(win, 'od:audit', 'strict');
  for (const r of [baseline, strict]) {
    expect(['low', 'medium', 'high', 'unknown']).toContain(r.risk);
    expect(r.findings.length).toBeGreaterThan(5);
    for (const f of r.findings) expect(['exposed', 'limited', 'blocked', 'unknown']).toContain(f.status);
  }
  // The probe page really ran (otherwise the result would be "unknown").
  expect(baseline.risk).not.toBe('unknown');
  // Strict protection must never expose more than an unprotected browser.
  expect(strict.score).toBeLessThanOrEqual(baseline.score);
  const canvas = strict.findings.find((f) => f.id.includes('canvas'));
  if (canvas) expect(canvas.status).not.toBe('exposed');
});

test('reports are stored encrypted', async () => {
  const win = await windowWithPage(l.app, 'detect.html');
  const list = await invoke<Array<{ id: string }>>(win, 'od:reports');
  expect(list.length).toBeGreaterThanOrEqual(2);
  const dir = path.join(l.dataDir, 'OctoDetect', 'reports');
  const files = listFiles(dir).filter((f) => f.endsWith('.odr'));
  expect(files.length).toBeGreaterThanOrEqual(2);
  for (const f of files) {
    const raw = fs.readFileSync(path.join(dir, f));
    expect(raw.toString('utf8')).not.toContain('"findings"');
    expect(raw.toString('utf8')).not.toContain('userAgent');
  }
});

test('invalid audit target is rejected', async () => {
  const win = await windowWithPage(l.app, 'detect.html');
  await expect(invoke(win, 'od:audit', 'file:///etc/passwd')).rejects.toThrow(/invalid target/);
});
