/**
 * apps/octobrowser/src/renderer/tab-menu.ts
 *
 * Pure model for the tab right-click dropdown: which rows it offers, how they
 * are grouped, which rows are unavailable right now, and where the dropdown may
 * sit inside the window. browser.ts draws the rows; nothing here touches the
 * DOM, so the rules can be unit-tested directly (see tab-drag.ts for the same
 * split).
 */

/** Every row the tab dropdown can offer. Each one maps to a tab action or a chrome call. */
export type TabMenuAction =
  | 'new-right' | 'group' | 'detach' | 'split'
  | 'reload' | 'duplicate' | 'sleep' | 'pin' | 'mute'
  | 'close' | 'close-duplicates' | 'close-others' | 'close-right'
  | 'reopen' | 'bookmark-all' | 'vertical';

/** The fields of a tab the menu needs. The chrome's TabState satisfies this shape. */
export interface TabMenuTab {
  id: number;
  url: string;
  pinned: boolean;
  sleeping: boolean;
  muted: boolean;
}

export interface TabMenuContext {
  /** Tabs in strip order (pinned first). */
  tabs: TabMenuTab[];
  activeId: number;
  splitId: number;
  closedCount: number;
  verticalTabs: boolean;
}

export type TabMenuRow =
  | { kind: 'separator' }
  | { kind: 'item'; action: TabMenuAction; labelKey: string; shortcut?: string; disabled: boolean };

const isWebPage = (url: string): boolean => /^https?:/.test(url);

/**
 * The rows for one right-clicked tab, grouped the way the Chromium-style menu
 * groups them. A row is disabled when it has nothing to act on, so it stays
 * visible (as "Close duplicate tabs" does with no duplicates) instead of
 * vanishing and shifting the layout under the pointer.
 */
export function tabMenuRows(tab: TabMenuTab, ctx: TabMenuContext): TabMenuRow[] {
  const index = ctx.tabs.findIndex((x) => x.id === tab.id);
  const isActive = tab.id === ctx.activeId;
  const isSplit = tab.id === ctx.splitId;
  // Pinned tabs are never closed by a batch action; see closeTabsKeeping in window.ts.
  const others = ctx.tabs.filter((x) => x.id !== tab.id && !x.pinned);
  const toRight = index < 0 ? [] : ctx.tabs.slice(index + 1).filter((x) => !x.pinned);
  const duplicates = others.filter((x) => x.url === tab.url);
  const separator: TabMenuRow = { kind: 'separator' };
  const item = (
    action: TabMenuAction,
    labelKey: string,
    options: { shortcut?: string; disabled?: boolean } = {},
  ): TabMenuRow => ({
    kind: 'item',
    action,
    labelKey,
    disabled: options.disabled === true,
    ...(options.shortcut ? { shortcut: options.shortcut } : {}),
  });

  return [
    item('new-right', 'tab.newRight'),
    item('group', 'tab.addToGroup'),
    item('detach', 'tab.moveWindow'),
    // A tab cannot be split with itself, so the active tab only offers to leave a split.
    isSplit ? item('split', 'tab.unsplit') : item('split', 'tab.newSplit', { disabled: isActive }),
    separator,
    // A sleeping tab has no page to reload; clicking it wakes it instead.
    item('reload', 'ctx.reload', { shortcut: 'Ctrl+R', disabled: tab.sleeping }),
    item('duplicate', 'tab.duplicate'),
    // Only background tabs with a live page can be put to sleep.
    item('sleep', 'tab.sleep', { disabled: tab.sleeping || isActive }),
    item('pin', tab.pinned ? 'tab.unpin' : 'tab.pin'),
    item('mute', tab.muted ? 'ui.unmute' : 'ui.mute'),
    separator,
    item('close', 'tab.close', { shortcut: 'Ctrl+W' }),
    item('close-duplicates', 'tab.closeDuplicates', { disabled: duplicates.length === 0 }),
    item('close-others', 'tab.closeOthers', { disabled: others.length === 0 }),
    item('close-right', 'tab.closeRight', { disabled: toRight.length === 0 }),
    separator,
    item('reopen', 'sc.reopenTab', { shortcut: 'Ctrl+Shift+T', disabled: ctx.closedCount === 0 }),
    item('bookmark-all', 'tab.bookmarkAll', { disabled: !ctx.tabs.some((x) => isWebPage(x.url)) }),
    separator,
    item('vertical', ctx.verticalTabs ? 'tab.useHorizontal' : 'tab.useVertical'),
  ];
}

/** Gap kept between the dropdown and the window edges, in CSS pixels. */
export const TAB_MENU_MARGIN_PX = 6;

export interface TabMenuPlacement {
  left: number;
  top: number;
  /** CSS transform-origin, so the pop-in grows out of the corner nearest the cursor. */
  origin: string;
}

/**
 * Open the dropdown at the cursor. When it would run past the right or bottom
 * edge it slides back inside the window instead, and its animation then grows
 * from the corner that touches the cursor.
 */
export function placeTabMenu(
  point: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): TabMenuPlacement {
  const m = TAB_MENU_MARGIN_PX;
  const left = Math.max(m, Math.min(point.x, viewport.width - size.width - m));
  const top = Math.max(m, Math.min(point.y, viewport.height - size.height - m));
  const vertical = top < point.y ? 'bottom' : 'top';
  const horizontal = left < point.x ? 'right' : 'left';
  return { left, top, origin: `${vertical} ${horizontal}` };
}
