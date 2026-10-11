/**
 * packages/core/src/mnemonic.ts
 *
 * 12-word recovery passphrase for encrypted profiles (BIP-0039 compatible).
 *
 *   entropy (128 bits, CSPRNG)
 *     -> 132 bits = entropy + first 4 bits of SHA-256(entropy)   (checksum)
 *     -> 12 groups of 11 bits -> 12 words from the 2048-word English list
 *
 * Why a word list instead of a password:
 *   * 128 bits of real entropy - a user-chosen password never gets close;
 *   * the checksum rejects typos and made-up phrases before any expensive
 *     key derivation runs;
 *   * it can be written on paper and typed back on another computer, which is
 *     exactly what "recover my profile" needs.
 *
 * The phrase itself is NEVER stored by the apps. It is shown once when the
 * profile is created and is asked for again only to open or recover it.
 * The encryption key is derived from the phrase with Argon2id (see crypto.ts),
 * the same KDF used everywhere else in OctoSuite.
 */
import * as crypto from 'node:crypto';
import { WORDLIST_EN } from './wordlist-en';

/** Number of words in a profile passphrase. */
export const MNEMONIC_WORDS = 12;
/** Entropy behind a 12-word phrase. */
export const MNEMONIC_ENTROPY_BITS = 128;

const WORD_INDEX: ReadonlyMap<string, number> = new Map(WORDLIST_EN.map((w, i) => [w, i]));

/** The word list used for profile passphrases (read-only). */
export function wordlist(): readonly string[] {
  return WORDLIST_EN;
}

/**
 * Normalise what the user typed: lower case, NFKD, any run of whitespace
 * (including line breaks pasted from a text file) becomes a single space.
 */
export function normalizeMnemonic(phrase: string): string {
  return String(phrase ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

function bitsToBytes(bits: string): Buffer {
  const out = Buffer.alloc(bits.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

function checksumBits(entropy: Buffer): string {
  const hash = crypto.createHash('sha256').update(entropy).digest();
  const bits = [...hash].map((b) => b.toString(2).padStart(8, '0')).join('');
  return bits.slice(0, (entropy.length * 8) / 32);
}

/** Turn 16 bytes of entropy into a 12-word phrase. Exported for tests and recovery tools. */
export function entropyToMnemonic(entropy: Buffer): string {
  if (entropy.length !== MNEMONIC_ENTROPY_BITS / 8) throw new Error('Mnemonic entropy must be 16 bytes');
  const bits = [...entropy].map((b) => b.toString(2).padStart(8, '0')).join('') + checksumBits(entropy);
  const words: string[] = [];
  for (let i = 0; i < bits.length / 11; i++) words.push(WORDLIST_EN[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]);
  return words.join(' ');
}

/** Generate a fresh 12-word passphrase from the system CSPRNG. */
export function generateMnemonic(): string {
  return entropyToMnemonic(crypto.randomBytes(MNEMONIC_ENTROPY_BITS / 8));
}

export type MnemonicProblem =
  | { ok: true; phrase: string; words: string[] }
  | { ok: false; reason: 'length'; count: number }
  | { ok: false; reason: 'unknown-word'; word: string; index: number }
  | { ok: false; reason: 'checksum' };

/**
 * Full check of a typed phrase: word count, every word on the list, checksum.
 * The result names the first offending word so the UI can point at it.
 */
export function checkMnemonic(phrase: string): MnemonicProblem {
  const normalized = normalizeMnemonic(phrase);
  const words = normalized ? normalized.split(' ') : [];
  if (words.length !== MNEMONIC_WORDS) return { ok: false, reason: 'length', count: words.length };
  const indexes: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const idx = WORD_INDEX.get(words[i]);
    if (idx === undefined) return { ok: false, reason: 'unknown-word', word: words[i], index: i };
    indexes.push(idx);
  }
  const bits = indexes.map((i) => i.toString(2).padStart(11, '0')).join('');
  const entropyBits = bits.slice(0, MNEMONIC_ENTROPY_BITS);
  const entropy = bitsToBytes(entropyBits);
  if (bits.slice(MNEMONIC_ENTROPY_BITS) !== checksumBits(entropy)) return { ok: false, reason: 'checksum' };
  return { ok: true, phrase: normalized, words };
}

/** Convenience wrapper: is this a valid 12-word passphrase? */
export function isValidMnemonic(phrase: string): boolean {
  return checkMnemonic(phrase).ok;
}

/**
 * Words from the list that start with the given prefix - used for the type-ahead
 * hints in the recovery box. Returns at most `limit` words, never more.
 */
export function suggestWords(prefix: string, limit = 5): string[] {
  const p = normalizeMnemonic(prefix);
  if (!p) return [];
  const out: string[] = [];
  for (const w of WORDLIST_EN) {
    if (w.startsWith(p)) {
      out.push(w);
      if (out.length >= limit) break;
    }
  }
  return out;
}
