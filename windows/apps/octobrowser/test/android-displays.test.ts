import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applySecondaryDisplay, parseSecondaryDisplay, writeSecondaryDisplay } from '../src/main/android-displays';

const BASE = [
  'avd.ini.encoding=UTF-8',
  'hw.lcd.width=1080',
  'hw.lcd.height=2400',
  'hw.display1.width=999',
  'hw.multi_display_window=no',
  'hw.ramSize=4096',
  '',
].join('\n');

describe('extra display choice', () => {
  it('accepts only the known presets and treats anything else as none', () => {
    expect(parseSecondaryDisplay('secondary1080')).toBe('secondary1080');
    expect(parseSecondaryDisplay('none')).toBe('none');
    expect(parseSecondaryDisplay('toString')).toBe('none');
    expect(parseSecondaryDisplay(undefined)).toBe('none');
    expect(parseSecondaryDisplay('secondary1080; rm -rf /')).toBe('none');
  });

  it('adds the preset keys and keeps every other line', () => {
    const out = applySecondaryDisplay(BASE, 'secondary1080');
    expect(out).toContain('hw.lcd.width=1080\n');
    expect(out).toContain('hw.ramSize=4096\n');
    expect(out).toContain('hw.multi_display_window=yes\n');
    expect(out).toContain('hw.display1.width=1920\n');
    expect(out).toContain('hw.display1.height=1080\n');
    expect(out).not.toContain('hw.display1.width=999');
    expect(out).not.toContain('hw.multi_display_window=no');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('is idempotent for the same choice', () => {
    const once = applySecondaryDisplay(BASE, 'secondary1080');
    expect(applySecondaryDisplay(once, 'secondary1080')).toBe(once);
  });

  it('removes display keys for none and leaves the rest alone', () => {
    const out = applySecondaryDisplay(applySecondaryDisplay(BASE, 'secondary1080'), 'none');
    expect(out).not.toMatch(/hw\.display\d+\./);
    expect(out).not.toMatch(/hw\.multi_display_window/);
    expect(out).toContain('hw.lcd.height=2400');
    expect(out).toContain('avd.ini.encoding=UTF-8');
  });

  it('does not touch keys that only look similar', () => {
    const text = 'hw.displayed=keep\nhw.display_mode=keep\nhw.lcd.density=440\n';
    const out = applySecondaryDisplay(text, 'secondary1080');
    expect(out).toContain('hw.displayed=keep');
    expect(out).toContain('hw.display_mode=keep');
    expect(out).toContain('hw.lcd.density=440');
  });

  it('writes the file only when the text changes, and never creates a missing config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-displays-'));
    try {
      const file = path.join(dir, 'config.ini');
      expect(writeSecondaryDisplay(file, 'secondary1080')).toBe(false);
      expect(fs.existsSync(file)).toBe(false);
      fs.writeFileSync(file, BASE, 'utf8');
      expect(writeSecondaryDisplay(file, 'secondary1080')).toBe(true);
      expect(writeSecondaryDisplay(file, 'secondary1080')).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toContain('hw.display1.width=1920');
      expect(writeSecondaryDisplay(file, 'none')).toBe(true);
      expect(fs.readFileSync(file, 'utf8')).not.toContain('hw.display1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
