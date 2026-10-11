/**
 * apps/octobrowser/src/shared/shortcuts.ts
 *
 * Keyboard shortcuts, shared by the main process (keys pressed while a web
 * page has focus, via before-input-event) and the chrome UI renderer.
 */
export type Command =
  | 'new-tab' | 'close-tab' | 'reopen-tab' | 'next-tab' | 'prev-tab' | 'focus-address' | 'reload' | 'hard-reload'
  | 'stop' | 'back' | 'forward' | 'find' | 'fullscreen' | 'mute-tab' | 'mute-profile' | 'panel-audio' | 'panel-traffic'
  | 'panel-privacy' | 'panel-downloads' | 'panel-bookmarks' | 'bookmark' | 'split' | 'pip' | 'zoom-in' | 'zoom-out'
  | 'zoom-reset' | 'devtools' | 'print' | 'switch-profile' | 'search-tabs' | 'volume-up' | 'volume-down'
  | `tab-${number}`;

export interface KeyInput {
  key: string;
  control: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

/** Map a key press to a command (null = let the page handle it). */
export function commandFor(i: KeyInput): Command | null {
  const k = i.key.length === 1 ? i.key.toLowerCase() : i.key;
  const ctrl = i.control || i.meta;
  if (ctrl && i.shift) {
    switch (k) {
      case 't': return 'reopen-tab';
      case 'm': return 'mute-profile';
      case 'a': return 'panel-audio';
      case 'n': return 'panel-traffic';
      case 'p': return 'panel-privacy';
      case 's': return 'split';
      case 'o': return 'panel-bookmarks';
      case 'u': return 'switch-profile';
      case 'Tab': return 'prev-tab';
      case 'r': return 'hard-reload';
      case 'ArrowUp': return 'volume-up';
      case 'ArrowDown': return 'volume-down';
      case 'i': return 'devtools';
      default: return null;
    }
  }
  if (ctrl && !i.alt) {
    if (/^[1-9]$/.test(k)) return `tab-${Number(k)}` as Command;
    switch (k) {
      case 't': return 'new-tab';
      case 'w': case 'F4': return 'close-tab';
      case 'Tab': return 'next-tab';
      case 'l': return 'focus-address';
      case 'r': return 'reload';
      case 'f': return 'find';
      case 'm': return 'mute-tab';
      case 'j': return 'panel-downloads';
      case 'd': return 'bookmark';
      case 'p': return 'print';
      case 'e': return 'search-tabs';
      case '=': case '+': return 'zoom-in';
      case '-': return 'zoom-out';
      case '0': return 'zoom-reset';
      default: return null;
    }
  }
  if (i.alt && !ctrl) {
    if (k === 'ArrowLeft') return 'back';
    if (k === 'ArrowRight') return 'forward';
    if (k === 'p') return 'pip';
  }
  if (!ctrl && !i.alt) {
    if (k === 'F5') return i.shift ? 'hard-reload' : 'reload';
    if (k === 'F11') return 'fullscreen';
    if (k === 'F12') return 'devtools';
  }
  return null;
}

export const SHORTCUT_HELP: Array<[string, string]> = [
  ['Ctrl+T', 'sc.newTab'], ['Ctrl+W', 'sc.closeTab'], ['Ctrl+Shift+T', 'sc.reopenTab'], ['Ctrl+Tab', 'sc.nextTab'],
  ['Ctrl+L', 'sc.address'], ['Ctrl+F', 'sc.find'], ['Ctrl+M', 'sc.muteTab'], ['Ctrl+Shift+M', 'sc.muteProfile'],
  ['Ctrl+Shift+↑/↓', 'sc.volume'], ['Ctrl+Shift+A', 'sc.audio'], ['Ctrl+Shift+N', 'sc.traffic'], ['Ctrl+Shift+P', 'sc.privacy'],
  ['Ctrl+Shift+S', 'sc.split'], ['Alt+P', 'sc.pip'], ['Ctrl+J', 'sc.downloads'], ['Ctrl+D', 'sc.bookmark'],
  ['Ctrl+E', 'sc.searchTabs'], ['Ctrl+Shift+U', 'sc.switchProfile'], ['F11', 'sc.fullscreen'], ['F12', 'sc.devtools'],
];
