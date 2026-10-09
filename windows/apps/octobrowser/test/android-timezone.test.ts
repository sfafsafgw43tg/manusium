/**
 * The timezone saved in Device Settings is the one the emulator starts with.
 * Without `-timezone` the device silently follows the computer's zone.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { timezoneArgsFor } from '../src/main/android-studio';

const root = path.resolve(__dirname, '..', '..', '..');
const studio = fs.readFileSync(path.join(root, 'apps/octobrowser/src/main/android-studio.ts'), 'utf8');

describe('timezone chosen for an Android device', () => {
  it('is passed to the emulator as -timezone', () => {
    expect(timezoneArgsFor('Europe/Warsaw')).toEqual(['-timezone', 'Europe/Warsaw']);
    expect(timezoneArgsFor('America/Argentina/Buenos_Aires')).toEqual(['-timezone', 'America/Argentina/Buenos_Aires']);
    expect(timezoneArgsFor('Etc/GMT+1')).toEqual(['-timezone', 'Etc/GMT+1']);
    expect(timezoneArgsFor('UTC')).toEqual(['-timezone', 'UTC']);
  });

  it('is never passed when it is empty or is not a zone name', () => {
    expect(timezoneArgsFor('')).toEqual([]);
    expect(timezoneArgsFor('Europe/Warsaw --help')).toEqual([]);
    expect(timezoneArgsFor('../../etc/passwd')).toEqual([]);
    expect(timezoneArgsFor('Europe Warsaw')).toEqual([]);
  });

  it('the launch reads the zone saved for this device', () => {
    expect(studio).toContain("args.push(...timezoneArgsFor(configValue(avd.path, 'octobrowser.timezone')));");
  });
});
