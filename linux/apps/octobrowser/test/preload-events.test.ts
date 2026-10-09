/**
 * The renderers subscribe to a fixed IPC event allow-list exposed by their
 * preload scripts. A mismatch used to stop the launcher at boot with
 * “Launcher error: event not allowed”, so keep both sides checked together.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const appRoot = path.resolve(__dirname, '..');

function text(...parts: string[]): string {
  return fs.readFileSync(path.join(appRoot, ...parts), 'utf8');
}

function subscribedEvents(source: string): string[] {
  // Event subscriptions are deliberately written one per line. Let the generic
  // contain nested `>` characters (for example Record<string, string>) and
  // capture the channel after the final generic close.
  // A channel may be subscribed from several places; the allow-list holds it once.
  return [...new Set([...source.matchAll(/\bapi\.on(?:<[^\n]*>)?\(['"]([^'"]+)['"]/g)].map((m) => m[1]))].sort();
}

function allowedEvents(source: string): string[] {
  const set = /const EVENTS = new Set\(\[([^\]]*)\]\)/.exec(source)?.[1] ?? '';
  return [...set.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]).sort();
}

/** Every launcher renderer module, since any of them may subscribe. */
function launcherRendererSource(): string {
  const dir = path.join(appRoot, 'src', 'renderer');
  return fs.readdirSync(dir)
    .filter((file) => file === 'launcher.ts' || file.startsWith('launcher-'))
    .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
    .join('\n');
}

/**
 * The chrome preload is shared: the browser window subscribes to most of its
 * events, and the floating save-password card subscribes to its own one. Both
 * renderers are scanned, so the allow-list stays the whole truth.
 */
function chromeRendererSource(): string {
  return ['browser.ts', 'save-card.ts']
    .map((file) => text('src', 'renderer', file))
    .join('\n');
}

describe('trusted UI IPC event allow-lists', () => {
  it('allows every launcher event that the launcher subscribes to', () => {
    expect(allowedEvents(text('src', 'preload', 'launcher.ts'))).toEqual(subscribedEvents(launcherRendererSource()));
  });

  it('allows every browser-chrome event that the chrome subscribes to', () => {
    expect(allowedEvents(text('src', 'preload', 'chrome.ts'))).toEqual(subscribedEvents(chromeRendererSource()));
  });

  it('keeps the save-password card its own event', () => {
    expect(allowedEvents(text('src', 'preload', 'chrome.ts'))).toContain('ui:save-card');
    expect(subscribedEvents(text('src', 'renderer', 'browser.ts'))).not.toContain('ui:save-card');
    expect(subscribedEvents(text('src', 'renderer', 'save-card.ts'))).toEqual(['ui:save-card']);
  });
});
