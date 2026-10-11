/**
 * apps/octobrowser/src/renderer/launcher-android-install.ts
 *
 * "Is it doing anything?" - the one card every long Android install uses.
 *
 * Installing the SDK command-line tools or an Android system image takes
 * minutes and gigabytes. Before this, the button
 * disabled itself and a toast said the download had started; nothing else
 * happened on screen until it was over, so a running install looked exactly
 * like a frozen one.
 *
 * This card shows the live stage and percentage the main process streams over
 * `mgr:android-progress`, counts the elapsed time, and - just as important -
 * stays on screen afterwards with a clear "installed" (or "failed") state
 * instead of disappearing.
 */
import { api } from '@octo/shell/renderer/bridge';
import { h, t } from '@octo/shell/renderer/i18n-client';
import { icon } from '@octo/shell/renderer/icons';
import { errText } from './launcher-ui';

interface Progress { stage: string; percent: number; text: string }

const seconds = (from: number) => Math.max(0, Math.round((Date.now() - from) / 1000));

/** Keep tool output readable and always express ETA in minutes. If the tool
 * only gives a percentage, derive a conservative ETA after a few seconds. */
export function progressText(progress: Progress, started: number, now = Date.now()): string {
  let text = String(progress?.text ?? '').replace(/ETA:\s*(\d+)s\b/gi, (_all, raw: string) => {
    const minutes = Math.max(1, Math.ceil(Number(raw) / 60));
    return `ETA: ${minutes} min`;
  });
  if (!/\bETA\b/i.test(text) && progress.percent > 0 && progress.percent < 100) {
    const elapsed = Math.max(0, (now - started) / 1000);
    if (elapsed >= 5) {
      const remaining = elapsed * (100 - progress.percent) / progress.percent;
      if (Number.isFinite(remaining) && remaining > 0) text += ` · ETA: ~${Math.max(1, Math.ceil(remaining / 60))} min`;
    }
  }
  return text;
}

/** "1 m 05 s", so a ten-minute download does not read as "612 s". */
function elapsedText(from: number): string {
  const total = seconds(from);
  return total < 60 ? t('android.install.elapsedSec', { s: String(total) })
    : t('android.install.elapsedMin', { m: String(Math.floor(total / 60)), s: String(total % 60).padStart(2, '0') });
}

export interface InstallResult { ok: boolean; message: string }

/**
 * Run one install with a visible progress card in `host`.
 *
 * The card replaces whatever is in `host`, so the same slot can be reused for
 * the next install. Returns whether it succeeded; the card stays behind.
 */
export async function runInstall(host: HTMLElement, options: {
  /** What is being installed, already translated. */
  title: string;
  /** Optional line under the title while it runs. */
  note?: string;
  task: () => Promise<InstallResult | undefined>;
}): Promise<boolean> {
  const started = Date.now();
  const bar = h('div', { class: 'progress-fill indeterminate' });
  bar.style.width = '100%';
  const pct = h('span', { class: 'progress-pct', text: '…' });
  const track = h('div', { class: 'progress-track', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, bar);
  const step = h('p', { class: 'hint progress-step', role: 'status', 'aria-live': 'polite', text: t('android.install.preparing') });
  const clock = h('span', { class: 'small muted', text: elapsedText(started) });
  const title = h('b', { text: t('android.install.running', { name: options.title }) });
  const mark = h('span', { class: 'install-mark spin' }, icon('refreshCircle', 16));
  const note = options.note ? h('p', { class: 'hint', text: options.note }) : undefined;
  const card = h('div', { class: 'install-card', role: 'status' },
    h('div', { class: 'install-head' }, mark, title, h('div', { class: 'grow' }), clock),
    note ?? null,
    h('div', { class: 'progress-row' }, track, pct),
    step);
  host.replaceChildren(card);

  const timer = window.setInterval(() => { clock.textContent = elapsedText(started); }, 1000);
  const stopProgress = api.on<Progress>('mgr:android-progress', (progress) => {
    if (typeof progress?.percent === 'number' && progress.percent >= 0) {
      bar.classList.remove('indeterminate');
      bar.style.width = `${Math.max(2, progress.percent)}%`;
      pct.textContent = `${progress.percent}%`;
      track.setAttribute('aria-valuenow', String(progress.percent));
    } else {
      bar.classList.add('indeterminate');
      bar.style.width = '100%';
      pct.textContent = '…';
      track.removeAttribute('aria-valuenow');
    }
    step.textContent = `${t(`android.progress.${progress.stage}`)} · ${progressText(progress, started)}`;
  });

  let result: InstallResult | undefined;
  let failure = '';
  try { result = await options.task(); }
  catch (error) { failure = errText(error); }
  window.clearInterval(timer);
  stopProgress();

  const took = elapsedText(started);
  const ok = result?.ok === true;
  // "This can take a few minutes" has nothing to say once it is over.
  note?.remove();
  card.classList.add(ok ? 'done' : 'failed');
  mark.classList.remove('spin');
  mark.replaceChildren(icon(ok ? 'check' : 'alert', 16));
  title.textContent = t(ok ? 'android.install.done' : 'android.install.failed', { name: options.title });
  clock.textContent = t('android.install.took', { time: took });
  bar.classList.remove('indeterminate');
  bar.style.width = ok ? '100%' : '0%';
  pct.textContent = ok ? '100%' : '';
  step.textContent = failure || result?.message || t(ok ? 'android.install.doneHint' : 'android.progress.failed');
  step.classList.toggle('warn', !ok);
  return ok;
}
