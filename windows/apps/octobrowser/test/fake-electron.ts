/**
 * apps/octobrowser/test/fake-electron.ts
 *
 * Minimal in-memory stand-in for the Electron main-process API used by
 * window.ts. It reproduces the behaviour that caused the reported crashes:
 * once a WebContents is destroyed, `WebContentsView.webContents` returns
 * `undefined` (real Electron does the same).
 */
import { EventEmitter } from 'node:events';

let nextId = 100;

export class FakeWebContents extends EventEmitter {
  readonly id = nextId++;
  destroyed = false;
  url = '';
  openHandler: ((d: { url: string; disposition: string }) => unknown) | null = null;
  sent: Array<[string, unknown]> = [];
  navigationHistory = { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} };

  isDestroyed() { return this.destroyed; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('destroyed');
  }
  close() { this.destroy(); }
  loadURL(u: string) {
    if (this.destroyed) throw new TypeError('Object has been destroyed');
    this.url = u;
    return Promise.resolve();
  }
  loadFile() { return Promise.resolve(); }
  getURL() { return this.url; }
  send(ch: string, payload: unknown) {
    if (this.destroyed) throw new TypeError('Object has been destroyed');
    this.sent.push([ch, payload]);
  }
  setWindowOpenHandler(h: (d: { url: string; disposition: string }) => unknown) { this.openHandler = h; }
  setWebRTCIPHandlingPolicy() {}
  setAudioMuted() {}
  getZoomFactor() { return 1; }
  setZoomFactor() {}
  focus() {}
  reload() {}
  insertCSS() { return Promise.resolve('k'); }
  executeJavaScript() { return Promise.resolve(); }
  stopFindInPage() {}
  findInPage() {}
}

export class WebContentsView {
  private readonly wcRef: FakeWebContents;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  visible = true;
  constructor(opts: { webContents?: FakeWebContents } = {}) {
    this.wcRef = opts.webContents ?? new FakeWebContents();
  }
  /** Real Electron: undefined after the WebContents is destroyed. */
  get webContents(): FakeWebContents | undefined {
    return this.wcRef.destroyed ? undefined : this.wcRef;
  }
  setBounds(b: typeof this.bounds) { this.bounds = b; }
  setVisible(v: boolean) { this.visible = v; }
  setBackgroundColor() {}
}

export class BaseWindow extends EventEmitter {
  destroyed = false;
  shown = false;
  focused = false;
  children = new Set<WebContentsView>();
  contentView = {
    addChildView: (v: WebContentsView) => { this.children.add(v); },
    removeChildView: (v: WebContentsView) => {
      if (this.destroyed) throw new TypeError('Object has been destroyed');
      this.children.delete(v);
    },
  };
  static all: BaseWindow[] = [];
  constructor() { super(); BaseWindow.all.push(this); }
  getContentBounds() { return { x: 0, y: 0, width: 1280, height: 800 }; }
  show() { this.shown = true; }
  isVisible() { return this.shown && !this.destroyed; }
  isDestroyed() { return this.destroyed; }
  close() {
    if (this.destroyed) return;
    let prevented = false;
    this.emit('close', { preventDefault: () => { prevented = true; } });
    if (prevented) return;
    this.destroyed = true;
    this.emit('closed');
  }
  setFullScreen() {}
  isFullScreen() { return false; }
  isMinimized() { return false; }
  restore() {}
  focus() { this.focused = true; }
}

export const Menu = { buildFromTemplate: () => ({ popup() {} }), setApplicationMenu() {} };
export const clipboard = { writeText() {} };
export const shell = { openExternal: () => Promise.resolve() };
export const app = { on() {}, getAppPath: () => '/app', isPackaged: false };
export const ipcMain = { handle() {}, removeHandler() {} };
export const nativeTheme = { shouldUseDarkColors: true, on() {} };
export class BrowserWindow extends BaseWindow {}
