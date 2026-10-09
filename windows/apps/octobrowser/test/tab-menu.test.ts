/** Rules behind the tab right-click dropdown: which rows exist, what they are disabled by, and where it may open. */
import { describe, expect, it } from 'vitest';
import { DICTS } from '@octo/core';
import {
  TAB_MENU_MARGIN_PX,
  placeTabMenu,
  tabMenuRows,
  type TabMenuContext,
  type TabMenuRow,
  type TabMenuTab,
} from '../src/renderer/tab-menu';

const tab = (id: number, over: Partial<TabMenuTab> = {}): TabMenuTab => ({
  id,
  url: `https://site${id}.example/`,
  pinned: false,
  sleeping: false,
  muted: false,
  ...over,
});

const ctx = (tabs: TabMenuTab[], over: Partial<TabMenuContext> = {}): TabMenuContext => ({
  tabs,
  activeId: tabs[0]?.id ?? 0,
  splitId: 0,
  closedCount: 0,
  verticalTabs: false,
  ...over,
});

function item(rows: TabMenuRow[], action: string) {
  const found = rows.find((r) => r.kind === 'item' && r.action === action);
  if (!found || found.kind !== 'item') throw new Error(`no "${action}" row`);
  return found;
}

describe('tab right-click dropdown rows', () => {
  it('groups rows like the Chromium-style menu, with a separator between groups', () => {
    const tabs = [tab(1), tab(2), tab(3)];
    const rows = tabMenuRows(tabs[1], ctx(tabs));
    const layout = rows.map((r) => (r.kind === 'separator' ? '|' : r.action)).join(' ');
    expect(layout).toBe(
      'new-right group detach split | reload duplicate sleep pin mute | '
      + 'close close-duplicates close-others close-right | reopen bookmark-all | vertical',
    );
  });

  it('does not start or end with a separator', () => {
    const tabs = [tab(1), tab(2)];
    const rows = tabMenuRows(tabs[0], ctx(tabs));
    expect(rows[0].kind).toBe('item');
    expect(rows[rows.length - 1].kind).toBe('item');
  });

  it('disables only the rows that have nothing to act on', () => {
    const tabs = [tab(1), tab(2), tab(3)];
    const rows = tabMenuRows(tabs[0], ctx(tabs)); // active tab, no duplicates, nothing closed yet
    const disabled = rows.flatMap((r) => (r.kind === 'item' && r.disabled ? [r.action] : []));
    expect(disabled).toEqual(['split', 'sleep', 'close-duplicates', 'reopen']);
  });

  it('a background tab can be split and put to sleep', () => {
    const tabs = [tab(1), tab(2)];
    const rows = tabMenuRows(tabs[1], ctx(tabs));
    expect(item(rows, 'split')).toMatchObject({ labelKey: 'tab.newSplit', disabled: false });
    expect(item(rows, 'sleep').disabled).toBe(false);
  });

  it('offers to leave the split on the split tab instead of starting a new one', () => {
    const tabs = [tab(1), tab(2)];
    const rows = tabMenuRows(tabs[1], ctx(tabs, { splitId: 2 }));
    expect(item(rows, 'split')).toMatchObject({ labelKey: 'tab.unsplit', disabled: false });
  });

  it('enables duplicate closing only when another unpinned tab shares the URL', () => {
    const same = 'https://news.example/';
    const alone = [tab(1, { url: same }), tab(2, { url: 'https://other.example/' })];
    expect(item(tabMenuRows(alone[0], ctx(alone)), 'close-duplicates').disabled).toBe(true);

    const twins = [tab(1, { url: same }), tab(2, { url: same })];
    expect(item(tabMenuRows(twins[0], ctx(twins)), 'close-duplicates').disabled).toBe(false);

    // Pinned tabs are never closed by a batch action, so a pinned twin does not count.
    const pinnedTwin = [tab(1, { url: same }), tab(2, { url: same, pinned: true })];
    expect(item(tabMenuRows(pinnedTwin[0], ctx(pinnedTwin)), 'close-duplicates').disabled).toBe(true);
  });

  it('ignores pinned tabs when deciding whether batch closes have targets', () => {
    const tabs = [tab(1, { pinned: true }), tab(2)];
    const rows = tabMenuRows(tabs[1], ctx(tabs, { activeId: 2 }));
    expect(item(rows, 'close-others').disabled).toBe(true);
    expect(item(rows, 'close-right').disabled).toBe(true);
  });

  it('close-right looks only at tabs to the right of this one', () => {
    const tabs = [tab(1), tab(2), tab(3)];
    expect(item(tabMenuRows(tabs[0], ctx(tabs)), 'close-right').disabled).toBe(false);
    expect(item(tabMenuRows(tabs[2], ctx(tabs)), 'close-right').disabled).toBe(true);
  });

  it('reopen follows the closed-tab count and bookmark-all needs a web page', () => {
    const tabs = [tab(1, { url: 'octo://newtab' })];
    expect(item(tabMenuRows(tabs[0], ctx(tabs, { closedCount: 2 })), 'reopen').disabled).toBe(false);
    expect(item(tabMenuRows(tabs[0], ctx(tabs)), 'bookmark-all').disabled).toBe(true);
    const web = [tab(1), tab(2, { url: 'octo://newtab' })];
    expect(item(tabMenuRows(web[1], ctx(web)), 'bookmark-all').disabled).toBe(false);
  });

  it('a sleeping tab has no page to reload, and an active tab cannot be put to sleep', () => {
    const tabs = [tab(1), tab(2, { sleeping: true })];
    expect(item(tabMenuRows(tabs[1], ctx(tabs)), 'reload').disabled).toBe(true);
    expect(item(tabMenuRows(tabs[0], ctx(tabs)), 'sleep').disabled).toBe(true);
  });

  it('labels follow the tab state and the tab layout', () => {
    const tabs = [tab(1), tab(2, { pinned: true, muted: true })];
    const pinnedMuted = tabMenuRows(tabs[1], ctx(tabs, { verticalTabs: true }));
    expect(item(pinnedMuted, 'pin').labelKey).toBe('tab.unpin');
    expect(item(pinnedMuted, 'mute').labelKey).toBe('ui.unmute');
    expect(item(pinnedMuted, 'vertical').labelKey).toBe('tab.useHorizontal');

    const plain = tabMenuRows(tabs[0], ctx(tabs));
    expect(item(plain, 'pin').labelKey).toBe('tab.pin');
    expect(item(plain, 'mute').labelKey).toBe('ui.mute');
    expect(item(plain, 'vertical').labelKey).toBe('tab.useVertical');
  });

  it('shows the real shortcuts only', () => {
    const tabs = [tab(1)];
    const rows = tabMenuRows(tabs[0], ctx(tabs));
    expect(item(rows, 'reload').shortcut).toBe('Ctrl+R');
    expect(item(rows, 'close').shortcut).toBe('Ctrl+W');
    expect(item(rows, 'reopen').shortcut).toBe('Ctrl+Shift+T');
    expect(item(rows, 'duplicate').shortcut).toBeUndefined();
  });

  it('every label the dropdown can show exists in both languages', () => {
    const tabs = [tab(1), tab(2, { pinned: true, muted: true, sleeping: true, url: 'octo://x' }), tab(3, { url: 'https://site1.example/' })];
    const variants = [
      ctx(tabs, { splitId: 3, closedCount: 1, verticalTabs: true }),
      ctx(tabs, { activeId: 3, closedCount: 0 }),
    ];
    for (const target of tabs) {
      for (const context of variants) {
        for (const row of tabMenuRows(target, context)) {
          if (row.kind !== 'item') continue;
          expect(DICTS.en[row.labelKey], row.labelKey).toBeTruthy();
          expect(DICTS.pl[row.labelKey], row.labelKey).toBeTruthy();
        }
      }
    }
    expect(DICTS.en['toast.bookmarkedAll']).toContain('{count}');
    expect(DICTS.pl['toast.bookmarkedAll']).toContain('{count}');
  });
});

describe('tab right-click dropdown placement', () => {
  const viewport = { width: 1000, height: 700 };
  const size = { width: 280, height: 300 };

  it('opens at the cursor when there is room', () => {
    expect(placeTabMenu({ x: 100, y: 50 }, size, viewport)).toEqual({ left: 100, top: 50, origin: 'top left' });
  });

  it('slides back inside near the right edge and grows from the right corner', () => {
    const p = placeTabMenu({ x: 900, y: 50 }, size, viewport);
    expect(p.left).toBe(viewport.width - size.width - TAB_MENU_MARGIN_PX);
    expect(p.origin).toBe('top right');
  });

  it('opens upwards near the bottom edge and grows from the bottom corner', () => {
    const p = placeTabMenu({ x: 100, y: 650 }, size, viewport);
    expect(p.top).toBe(viewport.height - size.height - TAB_MENU_MARGIN_PX);
    expect(p.origin).toBe('bottom left');
  });

  it('never leaves the window, even when the menu is wider than the window', () => {
    const p = placeTabMenu({ x: 0, y: 0 }, { width: 2000, height: 100 }, viewport);
    expect(p.left).toBe(TAB_MENU_MARGIN_PX);
    expect(p.top).toBe(TAB_MENU_MARGIN_PX);
  });
});
