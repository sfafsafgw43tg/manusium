/**
 * packages/shell/test/ui-contrast.test.ts
 *
 * Guards the UI colour language of the suite. Shared screens are monochrome;
 * the launcher and browser chrome use a small semantic palette (blue accent,
 * green OK, red error, amber warning). Meaning is always also carried by an
 * icon or a label, never by a colour alone.
 *
 * Two regressions are checked here, both of which really happened:
 *   1. `color: #fff` on a `background: #fff` button - the label was invisible
 *      (white text on a white pill), so "Launch" / "New profile" looked empty;
 *   2. a stray hue outside the documented palette in one of the stylesheets.
 *
 * The test parses the real stylesheets, resolves `var(--token)` from the
 * `:root` blocks (shared.css first, the file's own tokens win) and computes the
 * WCAG contrast ratio of every rule that sets both a background and a colour.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

const CSS_FILES = [
  'packages/shell/renderer/shared.css',
  'packages/shell/renderer/firstrun.css',
  'packages/shell/renderer/unlock.css',
  'packages/shell/renderer/splash.css',
  'apps/octobrowser/src/renderer/launcher.css',
  'apps/octobrowser/src/renderer/browser.css',
  'apps/octobrowser/src/internal/internal.css',
  'apps/octodetect/src/renderer/detect.css',
].map((rel) => path.join(repoRoot, rel));

/** Minimum contrast ratio for text/graphics on their own background. */
const MIN_CONTRAST = 3;

function hex(value: string): [number, number, number] | null {
  let h = value.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6); // ignore the alpha channel
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Token values from `:root`, shared.css first so a file's own tokens win. */
function tokens(css: string, shared: Map<string, string>): Map<string, string> {
  const map = new Map(shared);
  const root = css.slice(0, css.indexOf('}'));
  for (const [, name, value] of root.matchAll(/--([a-z0-9-]+)\s*:\s*([^;}]+)/g)) {
    map.set(name, value.trim());
  }
  return map;
}

function resolve(value: string, map: Map<string, string>): string {
  const m = /^var\(--([a-z0-9-]+)\)$/.exec(value.trim());
  return m ? (map.get(m[1]) ?? '').trim() : value.trim();
}

interface Rule { file: string; selector: string; background: string; color: string }

function rules(file: string, css: string, shared: Map<string, string>): Rule[] {
  const map = tokens(css, shared);
  const out: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim().split('\n').pop()!.trim();
    const body = m[2];
    if (selector.startsWith('@') || selector.includes(':root')) continue;
    const bg = /background(?:-color)?\s*:\s*([^;}]+)/.exec(body);
    const col = /(?:^|[;{\s])color\s*:\s*([^;}]+)/.exec(body);
    if (!bg || !col) continue;
    const background = resolve(bg[1], map);
    const color = resolve(col[1], map);
    if (!background.startsWith('#') || !color.startsWith('#')) continue; // gradient / inherit / transparent
    out.push({ file, selector, background, color });
  }
  return out;
}

describe('renderer stylesheets', () => {
  const shared = new Map<string, string>();
  for (const f of CSS_FILES) {
    expect(fs.existsSync(f), `missing stylesheet ${f}`).toBe(true);
  }
  for (const f of CSS_FILES) {
    if (f.endsWith('shared.css')) {
      const root = fs.readFileSync(f, 'utf8').slice(0, fs.readFileSync(f, 'utf8').indexOf('}'));
      for (const [, name, value] of root.matchAll(/--([a-z0-9-]+)\s*:\s*([^;}]+)/g)) shared.set(name, value.trim());
    }
  }

  const all = CSS_FILES.flatMap((f) => rules(path.relative(repoRoot, f), fs.readFileSync(f, 'utf8'), shared));

  it('reads every stylesheet and finds the rules it must check', () => {
    for (const f of CSS_FILES) {
      const rel = path.relative(repoRoot, f);
      const css = fs.readFileSync(f, 'utf8');
      expect([...css.matchAll(/[^{}]+\{[^{}]*\}/g)].length, `${rel} has no CSS rules at all`).toBeGreaterThan(0);
    }
    expect(all.length, 'no background+colour rules were parsed - the checker is broken').toBeGreaterThan(15);
  });

  it('never renders text in the same colour as its background', () => {
    const invisible = all
      .map((r) => ({ ...r, ratio: contrast(hex(r.background)!, hex(r.color)!) }))
      .filter((r) => r.ratio < MIN_CONTRAST)
      .map((r) => `${r.file} :: ${r.selector} -> ${r.background} on ${r.color} (${r.ratio.toFixed(2)}:1)`);
    expect(invisible, `invisible or unreadable labels:\n${invisible.join('\n')}`).toEqual([]);
  });

  it('keeps OctoBrowser entry surfaces in a matte grayscale palette', () => {
    const matteFiles = new Set([
      'apps/octobrowser/src/renderer/launcher.css',
      'apps/octobrowser/src/renderer/browser.css',
      'apps/octobrowser/src/internal/internal.css',
    ]);
    const colourful: string[] = [];
    for (const f of CSS_FILES) {
      const rel = path.relative(repoRoot, f).split(path.sep).join('/');
      if (!matteFiles.has(rel)) continue;
      const css = fs.readFileSync(f, 'utf8');
      css.split('\n').forEach((line, i) => {
        // Theme tokens and their small picker previews are explicitly selected
        // by the user; the default entry surface remains matte grayscale.
        if (rel.endsWith('/launcher.css') && (line.includes('[data-app-theme=') || line.includes('.theme-'))) return;
        // Firefox focus and Safari traffic-light controls are intentional shell-specific accents.
        if (rel.endsWith('/browser.css') && (line.includes('data-browser-shell="firefox"') || line.includes('data-browser-shell="safari"'))) return;
        for (const m of line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
          const rgb = hex(m[0]);
          // CSS also allows four-digit shorthand colours (#RGBA), which this
          // focused palette helper does not need to classify.
          if (rgb && Math.max(...rgb) - Math.min(...rgb) > 30) colourful.push(`${rel}:${i + 1} ${m[0]}`);
        }
      });
    }
    expect(colourful, `non-matte colour in OctoBrowser UI:\n${colourful.join('\n')}`).toEqual([]);
  });

  it('uses only the documented palette (no stray brand hues)', () => {
    // Shared startup screens retain their documented semantic hue families.
    // The OctoBrowser launcher, browser chrome and internal pages have their
    // own stricter matte-gray regression guard below. Colour is never the only
    // carrier of meaning: each state also has an icon or a label, which the
    // contrast test above keeps readable.
    const PALETTE_FILES = new Set([
      'apps/octobrowser/src/renderer/launcher.css', 'apps/octobrowser/src/renderer/browser.css',
      // start-up screens (setup, unlock, splash) share the launcher palette via shared.css
      'packages/shell/renderer/shared.css', 'packages/shell/renderer/firstrun.css', 'packages/shell/renderer/unlock.css', 'packages/shell/renderer/splash.css',
    ]);
    const FAMILIES: Array<[number, number]> = [[195, 232], [115, 150], [345, 360], [0, 12], [30, 52]];
    const ALLOWED = new Set(['#b91c1c']); // "force close (may lose data)" hint
    const hueOf = ([r, g, b]: [number, number, number]): number => {
      const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const hues: string[] = [];
    for (const f of CSS_FILES) {
      const css = fs.readFileSync(f, 'utf8');
      const rel = path.relative(repoRoot, f).split(path.sep).join('/');
      css.split('\n').forEach((line, i) => {
        if (rel.endsWith('/launcher.css') && (line.includes('[data-app-theme=') || line.includes('.theme-'))) return;
        // Firefox and Safari have documented shell-specific control accents, not stray brand hues.
        if (rel.endsWith('/browser.css') && (line.includes('data-browser-shell="firefox"') || line.includes('data-browser-shell="safari"'))) return;
        for (const m of line.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
          const c = hex(m[0])!;
          if (Math.max(...c) - Math.min(...c) <= 30 || ALLOWED.has(m[0].toLowerCase())) continue;
          const hue = hueOf(c);
          if (PALETTE_FILES.has(rel) && FAMILIES.some(([a, b]) => hue >= a && hue <= b)) continue;
          hues.push(`${rel}:${i + 1} ${m[0]} (hue ${Math.round(hue)})  ${line.trim().slice(0, 70)}`);
        }
      });
    }
    expect(hues, `colour outside the documented palette:\n${hues.join('\n')}`).toEqual([]);
  });
});
