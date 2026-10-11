/**
 * packages/core/test/mnemonic.test.ts
 * 12-word profile passphrase: generation, checksum, typo reporting, suggestions.
 */
import { describe, expect, it } from 'vitest';
import {
  MNEMONIC_WORDS, checkMnemonic, entropyToMnemonic, generateMnemonic, isValidMnemonic,
  normalizeMnemonic, suggestWords, wordlist,
} from '../src';

describe('12-word passphrase', () => {
  it('uses the official 2048-word BIP-39 English list', () => {
    const w = wordlist();
    expect(w.length).toBe(2048);
    expect(w[0]).toBe('abandon');
    expect(w[2047]).toBe('zoo');
    // unique, sorted, and unambiguous in the first four letters
    expect(new Set(w).size).toBe(2048);
    expect([...w].sort()).toEqual([...w]);
    expect(new Set(w.map((x) => x.slice(0, 4))).size).toBe(2048);
  });

  it('matches the BIP-39 reference vectors', () => {
    expect(entropyToMnemonic(Buffer.alloc(16, 0x00)))
      .toBe('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
    expect(entropyToMnemonic(Buffer.alloc(16, 0xff)))
      .toBe('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong');
    expect(entropyToMnemonic(Buffer.from('7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f', 'hex')))
      .toBe('legal winner thank year wave sausage worth useful legal winner thank yellow');
  });

  it('generates 12 different valid words every time', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const phrase = generateMnemonic();
      expect(phrase.split(' ')).toHaveLength(MNEMONIC_WORDS);
      expect(isValidMnemonic(phrase)).toBe(true);
      seen.add(phrase);
    }
    expect(seen.size).toBe(25);
  });

  it('accepts sloppy typing but rejects a wrong phrase', () => {
    const phrase = generateMnemonic();
    const messy = `  ${phrase.toUpperCase().split(' ').join('\n  ')}  `;
    expect(normalizeMnemonic(messy)).toBe(phrase);
    expect(isValidMnemonic(messy)).toBe(true);

    expect(checkMnemonic('abandon abandon')).toEqual({ ok: false, reason: 'length', count: 2 });
    expect(checkMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon octopus'))
      .toEqual({ ok: false, reason: 'unknown-word', word: 'octopus', index: 11 });
    // valid words, wrong checksum ("about" swapped for "abandon")
    expect(checkMnemonic('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'))
      .toEqual({ ok: false, reason: 'checksum' });
  });

  it('suggests words for the recovery box', () => {
    expect(suggestWords('aban')).toEqual(['abandon']);
    expect(suggestWords('ze')).toEqual(['zebra', 'zero']);
    expect(suggestWords('')).toEqual([]);
    expect(suggestWords('a', 3)).toHaveLength(3);
  });
});
