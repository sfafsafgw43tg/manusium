/**
 * apps/octobrowser/src/main/android-displays.ts
 *
 * An extra display for an Android virtual device. The emulator reads these from
 * config.ini (`hw.multi_display_window` and `hw.displayN.*`), so the choice is
 * written there before a start and every start rewrites it to match the choice.
 *
 * The `-multidisplay` launch argument is deliberately not used: its argument
 * format could not be confirmed from any source available here, and a guessed
 * value could stop the emulator from starting.
 *
 * The preset values are the ones a public AAOS multi-display script writes
 * (passenger display 1920x1080, density 160, flag 1993). They have not been run
 * on an emulator from this code.
 */
import * as fs from 'node:fs';

export const SECONDARY_DISPLAYS = ['none', 'secondary1080'] as const;
export type SecondaryDisplay = (typeof SECONDARY_DISPLAYS)[number];

const PRESET_LINES: Record<Exclude<SecondaryDisplay, 'none'>, string[]> = {
  secondary1080: [
    'hw.multi_display_window=yes',
    'hw.display1.width=1920',
    'hw.display1.height=1080',
    'hw.display1.density=160',
    'hw.display1.flag=1993',
    'hw.display1.xOffset=-1',
    'hw.display1.yOffset=-1',
  ],
};

const DISPLAY_KEY = /^\s*hw\.(multi_display_window|display\d+\.)/;

/** Anything not in the list is "none": a bad value must never add a display. */
export function parseSecondaryDisplay(value: unknown): SecondaryDisplay {
  const text = String(value ?? '');
  return (SECONDARY_DISPLAYS as readonly string[]).includes(text) ? (text as SecondaryDisplay) : 'none';
}

/**
 * The config.ini text with every display key removed and, for a preset, its
 * lines added at the end. Other lines keep their order. Applying the same choice
 * twice gives the same text.
 */
export function applySecondaryDisplay(configText: string, choice: SecondaryDisplay): string {
  const lines = configText.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  const kept = lines.filter((line) => !DISPLAY_KEY.test(line));
  const extra = choice === 'none' ? [] : PRESET_LINES[choice];
  return [...kept, ...extra].join('\n') + '\n';
}

/**
 * Writes the choice into an existing config.ini, only when the text changes.
 * A missing file is left alone: there is nothing to configure yet.
 */
export function writeSecondaryDisplay(configPath: string, choice: SecondaryDisplay): boolean {
  if (!fs.existsSync(configPath)) return false;
  const before = fs.readFileSync(configPath, 'utf8');
  const after = applySecondaryDisplay(before, choice);
  if (after === before) return false;
  const temp = `${configPath}.tmp`;
  fs.writeFileSync(temp, after, 'utf8');
  fs.renameSync(temp, configPath);
  return true;
}
