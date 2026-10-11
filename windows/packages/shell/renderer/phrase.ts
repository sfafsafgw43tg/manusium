/**
 * packages/shell/renderer/phrase.ts
 *
 * Shared UI for the 12-word profile passphrase (see packages/core/src/mnemonic.ts).
 *
 *   phraseDisplay() - shows a freshly generated phrase once, with a copy button
 *                     and a "I have written it down" checkbox.
 *   phraseEntry()   - twelve numbered boxes for typing or pasting a phrase back.
 *
 * The renderer deliberately does NOT contain the word list or any crypto: it only
 * counts words and reports what the user typed. The real check (word list +
 * checksum) happens in the main process, which owns the key material.
 */
import { h, t } from './i18n-client';
import { icon } from './icons';

export const PHRASE_WORDS = 12;

/** Split on any whitespace, lower case - the same normalisation the core uses. */
export function splitWords(text: string): string[] {
  return text.normalize('NFKD').toLowerCase().replace(/[\s\u00a0]+/g, ' ').trim().split(' ').filter(Boolean);
}

export interface PhraseEntry {
  /** Element to append to a dialog. */
  el: HTMLElement;
  /** What the user typed, normalised to a single spaced line. */
  value(): string;
  /** true when there are exactly 12 words (the real validation is done in main). */
  complete(): boolean;
  focus(): void;
  setError(message: string): void;
}

/**
 * Twelve numbered inputs. Pasting the whole phrase into any box fills all of
 * them, and typing a space jumps to the next box - the way people actually
 * copy a recovery phrase from a piece of paper or a password manager.
 */
export function phraseEntry(onChange?: (complete: boolean) => void): PhraseEntry {
  const boxes: HTMLInputElement[] = [];
  const grid = h('div', { class: 'phrase-grid' });
  const err = h('div', { class: 'err' });
  const count = h('div', { class: 'hint phrase-count' });

  const words = () => boxes.map((b) => b.value.trim().toLowerCase()).filter(Boolean);
  const update = () => {
    const n = words().length;
    count.textContent = t('phrase.wordCount', { n: String(n) });
    grid.classList.toggle('complete', n === PHRASE_WORDS);
    onChange?.(n === PHRASE_WORDS);
  };
  const fill = (list: string[]) => {
    for (let i = 0; i < PHRASE_WORDS; i++) boxes[i].value = list[i] ?? '';
    update();
  };

  for (let i = 0; i < PHRASE_WORDS; i++) {
    const input = h('input', {
      type: 'text', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off',
      maxlength: '16', 'aria-label': `${i + 1}`,
    }) as HTMLInputElement;
    input.oninput = () => {
      err.textContent = '';
      // Typing or pasting several words at once spreads them over the boxes.
      const parts = splitWords(input.value);
      if (parts.length > 1) {
        const rest = [...words().slice(0, i), ...parts].slice(0, PHRASE_WORDS);
        fill(rest);
        boxes[Math.min(rest.length, PHRASE_WORDS - 1)].focus();
        return;
      }
      update();
    };
    input.onpaste = (ev: ClipboardEvent) => {
      const text = ev.clipboardData?.getData('text') ?? '';
      const parts = splitWords(text);
      if (parts.length <= 1) return;
      ev.preventDefault();
      fill(parts.slice(0, PHRASE_WORDS));
      boxes[PHRASE_WORDS - 1].focus();
    };
    input.onkeydown = (ev: KeyboardEvent) => {
      if (ev.key === ' ' || ev.key === 'Enter') {
        if (input.value.trim() && i < PHRASE_WORDS - 1) { ev.preventDefault(); boxes[i + 1].focus(); }
      } else if (ev.key === 'Backspace' && !input.value && i > 0) {
        ev.preventDefault();
        boxes[i - 1].focus();
      }
    };
    boxes.push(input);
    grid.append(h('label', { class: 'phrase-cell' }, h('span', { class: 'num', text: String(i + 1) }), input));
  }

  const el = h('div', { class: 'phrase' },
    h('div', { class: 'phrase-head' }, icon('key', 16), h('b', { text: t('phrase.enter') })),
    h('p', { class: 'hint', text: t('phrase.enterHint') }),
    grid, count, err);
  update();

  return {
    el,
    value: () => words().join(' '),
    complete: () => words().length === PHRASE_WORDS,
    focus: () => boxes[0].focus(),
    setError: (message: string) => { err.textContent = message; },
  };
}

export interface PhraseDisplay {
  el: HTMLElement;
  /** true once the user ticked "I have written the words down". */
  confirmed(): boolean;
}

/**
 * Show a generated phrase exactly once. Twelve numbered words, a copy button
 * and an explicit confirmation - no way to close the dialog by accident.
 */
export function phraseDisplay(phrase: string, onConfirm?: (ok: boolean) => void): PhraseDisplay {
  const words = splitWords(phrase);
  const grid = h('div', { class: 'phrase-grid readonly' });
  words.forEach((w, i) => {
    grid.append(h('div', { class: 'phrase-cell' }, h('span', { class: 'num', text: String(i + 1) }), h('b', { text: w })));
  });

  const copied = h('span', { class: 'hint' });
  const copy = h('button', { class: 'btn' }, icon('copy', 15), ` ${t('phrase.copy')}`);
  copy.onclick = () => {
    void navigator.clipboard.writeText(words.join(' ')).then(() => { copied.textContent = t('phrase.copied'); });
  };

  const check = h('input', { type: 'checkbox' }) as HTMLInputElement;
  check.onchange = () => onConfirm?.(check.checked);

  const el = h('div', { class: 'phrase' },
    h('div', { class: 'phrase-head' }, icon('key', 16), h('b', { text: t('phrase.title') })),
    h('p', { class: 'info', text: t('phrase.intro') }),
    grid,
    h('div', { class: 'phrase-actions' }, copy, copied),
    h('p', { class: 'note', text: t('phrase.warning') }),
    h('label', { class: 'check' }, check, h('span', { text: t('phrase.confirm') })));

  return { el, confirmed: () => check.checked };
}
