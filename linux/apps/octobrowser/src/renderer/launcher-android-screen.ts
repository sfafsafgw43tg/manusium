/**
 * apps/octobrowser/src/renderer/launcher-android-screen.ts
 *
 * The device window: a floating panel over the Android devices page that shows
 * a running emulator's screen and sends taps and toolbar presses back to it.
 *
 * The frames are pushed by the main process (adb screencap, a few a second), so
 * the picture is slower than scrcpy and shows the first display only. The
 * toolbar on the side follows the Android Studio emulator's controls: power,
 * volume, rotate, back, home, recents and screenshot. Dragging the header moves
 * the panel; it never leaves the window.
 */
import { api } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { run, toast } from './launcher-ui';

interface ScreenEvent {
  name: string;
  width?: number;
  height?: number;
  png?: string;
  error?: string;
}

type ScreenAction =
  | { kind: 'key'; key: 'power' | 'volumeUp' | 'volumeDown' | 'back' | 'home' | 'recents' }
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'rotate'; delta: 1 | -1 }
  | { kind: 'shot' };

interface ScreenPanel {
  name: string;
  root: HTMLElement;
  frame: HTMLImageElement;
  status: HTMLElement;
  size: { width: number; height: number } | null;
  stamps: number[];
}

const panels = new Map<string, ScreenPanel>();
let listening = false;

/** Largest picture width that keeps the whole panel on screen. */
function frameWidthFor(width: number, height: number): number {
  const landscape = width >= height;
  const maxHeight = Math.max(240, window.innerHeight - 170);
  return Math.round(Math.min(landscape ? 520 : 320, maxHeight * (width / height)));
}

function fit(panel: ScreenPanel, width: number, height: number): void {
  // The picture's box has the frame's own aspect ratio, so a click maps exactly.
  panel.frame.style.aspectRatio = `${width} / ${height}`;
  // Stage + 8px gap + 36px toolbar + 10px padding each side.
  panel.root.style.width = `${frameWidthFor(width, height) + 64}px`;
}

function showError(panel: ScreenPanel, message: string): void {
  panel.status.textContent = message;
  panel.status.classList.add('aos-error');
}

function listen(): void {
  if (listening) return;
  listening = true;
  api.on<ScreenEvent>('mgr:android-screen', (event) => {
    const panel = panels.get(event.name);
    if (!panel) return;
    if (event.error) {
      showError(panel, t('android.screen.error', { message: event.error }));
      return;
    }
    if (!event.png || !event.width || !event.height) return;
    panel.status.classList.remove('aos-error');
    if (!panel.size || panel.size.width !== event.width || panel.size.height !== event.height) {
      fit(panel, event.width, event.height);
    }
    panel.size = { width: event.width, height: event.height };
    panel.frame.src = `data:image/png;base64,${event.png}`;
    panel.frame.hidden = false;
    const now = performance.now();
    panel.stamps.push(now);
    if (panel.stamps.length > 6) panel.stamps.shift();
    const span = (now - panel.stamps[0]) / 1000;
    const fps = panel.stamps.length > 1 && span > 0 ? (panel.stamps.length - 1) / span : 0;
    // The rate needs two frames to mean anything; until then only the size shows.
    panel.status.textContent = fps > 0
      ? t('android.screen.status', { width: event.width, height: event.height, fps: fps.toFixed(1) })
      : t('android.screen.size', { width: event.width, height: event.height });
  });
}

async function sendInput(name: string, action: ScreenAction): Promise<void> {
  const result = await run(api.invoke<{ done: boolean; reason?: string; path?: string }>('mgr:android-screen-input', name, action));
  if (!result) return;
  if (!result.done) {
    toast(t('android.screen.notRunning'), 'info');
    return;
  }
  if (action.kind === 'shot' && result.path) toast(t('android.screen.shotSaved', { path: result.path }), 'ok');
}

/** Stops the picture stream for a device and removes its window. */
export function closeAndroidScreen(name: string): void {
  const panel = panels.get(name);
  if (!panel) return;
  panels.delete(name);
  panel.root.remove();
  void api.invoke('mgr:android-screen-stop', name).catch(() => undefined);
}

/** Opens the device window for a running device, or brings the open one forward. */
export function openAndroidScreen(machine: { name: string; handset?: string }): void {
  const open = panels.get(machine.name);
  if (open) {
    open.root.classList.remove('aos-bump');
    void open.root.offsetWidth;
    open.root.classList.add('aos-bump');
    return;
  }
  listen();

  const frame = h('img', { class: 'aos-frame', alt: '', draggable: 'false' });
  frame.hidden = true;
  const status = h('span', { class: 'aos-status small muted', text: t('android.screen.connecting') });
  const close = h('button', { class: 'icon-btn tiny', type: 'button', title: t('android.screen.close'), 'aria-label': t('android.screen.close') }, icon('close', 16));
  const grip = h('span', { class: 'aos-grip', title: t('android.screen.drag'), 'aria-hidden': 'true' }, icon('grip', 16));
  const head = h('div', { class: 'aos-head' },
    grip,
    h('div', { class: 'aos-title grow' }, h('b', { class: 'aos-name', text: machine.handset || machine.name }), status),
    close);
  const stage = h('div', { class: 'aos-stage' }, frame);

  const tool = (label: string, glyph: string, action: ScreenAction): HTMLElement => {
    const button = h('button', { class: 'aos-tool', type: 'button', title: label, 'aria-label': label }, icon(glyph, 18));
    button.onclick = () => void sendInput(machine.name, action);
    return button;
  };
  const toolbar = h('div', { class: 'aos-toolbar', role: 'toolbar', 'aria-label': t('android.screen.toolbar') },
    tool(t('android.screen.power'), 'power', { kind: 'key', key: 'power' }),
    tool(t('android.screen.volumeUp'), 'volumeUp', { kind: 'key', key: 'volumeUp' }),
    tool(t('android.screen.volumeDown'), 'volumeDown', { kind: 'key', key: 'volumeDown' }),
    h('span', { class: 'aos-sep', 'aria-hidden': 'true' }),
    tool(t('android.screen.rotateLeft'), 'rotateLeft', { kind: 'rotate', delta: -1 }),
    tool(t('android.screen.rotateRight'), 'rotateRight', { kind: 'rotate', delta: 1 }),
    h('span', { class: 'aos-sep', 'aria-hidden': 'true' }),
    tool(t('android.screen.back'), 'back', { kind: 'key', key: 'back' }),
    tool(t('android.screen.home'), 'home', { kind: 'key', key: 'home' }),
    tool(t('android.screen.recents'), 'layers', { kind: 'key', key: 'recents' }),
    h('span', { class: 'aos-sep', 'aria-hidden': 'true' }),
    tool(t('android.screen.screenshot'), 'camera', { kind: 'shot' }));

  const root = h('section', { class: 'aos-panel', role: 'dialog', 'aria-label': machine.handset || machine.name },
    head,
    h('div', { class: 'aos-body' }, stage, toolbar));
  const panel: ScreenPanel = { name: machine.name, root, frame, status, size: null, stamps: [] };
  panels.set(machine.name, panel);
  document.body.append(root);

  // A click on the picture is a tap at the matching point of the device screen.
  frame.addEventListener('click', (event) => {
    const size = panel.size;
    const box = frame.getBoundingClientRect();
    if (!size || box.width <= 0 || box.height <= 0) return;
    const x = Math.min(size.width - 1, Math.max(0, Math.round(((event.clientX - box.left) / box.width) * size.width)));
    const y = Math.min(size.height - 1, Math.max(0, Math.round(((event.clientY - box.top) / box.height) * size.height)));
    void sendInput(machine.name, { kind: 'tap', x, y });
  });

  close.onclick = () => closeAndroidScreen(machine.name);

  // Drag by the header only; the panel stays inside the window.
  let drag: { dx: number; dy: number } | null = null;
  head.addEventListener('pointerdown', (event) => {
    if ((event.target as HTMLElement).closest('button')) return;
    const box = root.getBoundingClientRect();
    drag = { dx: event.clientX - box.left, dy: event.clientY - box.top };
    head.setPointerCapture(event.pointerId);
  });
  head.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const x = Math.min(Math.max(0, event.clientX - drag.dx), Math.max(0, window.innerWidth - root.offsetWidth));
    const y = Math.min(Math.max(0, event.clientY - drag.dy), Math.max(0, window.innerHeight - 40));
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
    root.style.right = 'auto';
  });
  const endDrag = () => { drag = null; };
  head.addEventListener('pointerup', endDrag);
  head.addEventListener('pointercancel', endDrag);

  void (async () => {
    const started = await run(api.invoke<{ started: boolean; reason?: string }>('mgr:android-screen-start', machine.name));
    if (!started) {
      showError(panel, t('android.screen.failed'));
    } else if (!started.started) {
      showError(panel, started.reason === 'notRunning' ? t('android.screen.notRunning') : t('android.screen.failed'));
    }
  })();
}
