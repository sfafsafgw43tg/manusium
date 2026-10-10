import { describe, expect, it } from 'vitest';
import {
  TAB_DETACH_DISTANCE_PX,
  shouldDetachTab,
  tabDetachDistance,
  tabDragStarted,
  tabDropIndex,
} from '../src/renderer/tab-drag';

const strip = { left: 0, right: 600, top: 0, bottom: 38 };

describe('controlled tab drag geometry', () => {
  it('does not begin for click jitter, but begins after a clear movement', () => {
    expect(tabDragStarted({ x: 100, y: 18 }, { x: 105, y: 22 })).toBe(false);
    expect(tabDragStarted({ x: 100, y: 18 }, { x: 106, y: 18 })).toBe(true);
  });

  it('keeps ordinary vertical motion attached to a horizontal strip', () => {
    expect(tabDetachDistance({ x: 240, y: 90 }, strip, false)).toBe(52);
    expect(shouldDetachTab({ x: 240, y: 90 }, strip, false)).toBe(false);
    expect(shouldDetachTab({ x: 240, y: strip.bottom + TAB_DETACH_DISTANCE_PX }, strip, false)).toBe(true);
    // Pulling far past either horizontal end still means reorder, not tear-off.
    expect(shouldDetachTab({ x: 900, y: 20 }, strip, false)).toBe(false);
  });

  it('uses the equivalent perpendicular threshold for vertical tabs', () => {
    const vertical = { left: 0, right: 240, top: 0, bottom: 700 };
    expect(shouldDetachTab({ x: 300, y: 200 }, vertical, true)).toBe(false);
    expect(shouldDetachTab({ x: 320, y: 200 }, vertical, true)).toBe(true);
  });

  it('changes reorder slots only after tab centers are crossed', () => {
    const tabs = [
      { left: 0, right: 100, top: 0, bottom: 32 },
      { left: 102, right: 202, top: 0, bottom: 32 },
      { left: 204, right: 304, top: 0, bottom: 32 },
    ];
    expect(tabDropIndex({ x: 49, y: 16 }, tabs, false)).toBe(0);
    expect(tabDropIndex({ x: 51, y: 16 }, tabs, false)).toBe(1);
    expect(tabDropIndex({ x: 400, y: 16 }, tabs, false)).toBe(3);
  });
});
